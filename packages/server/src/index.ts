import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createPublicClient, http } from "viem";
import { loadConfig } from "./util/env";
import { createLogger } from "./util/logger";
import { AppError } from "./util/errors";
import { ModuleRegistry } from "./lib/modules/registry";
import { EthBalanceModule } from "./lib/modules/eth-balance/module";
import { initBackend } from "./lib/modules/eth-balance/verifier";
import { NullifierStore } from "./lib/nullifier-store";
import { ClaimStore } from "./lib/claim-store";
import { FundDispatcher } from "./lib/fund-dispatcher";
import { StateRootOracle } from "./lib/state-root-oracle";
import { createClaimRouter } from "./routes/claim";
import { createStatusRouter } from "./routes/status";
import {
  createModulesRouter,
  createCircuitsRouter,
  createNetworksRouter,
  createHealthRouter,
} from "./routes/circuits";

// Load networks configuration
import { loadNetworks } from "./lib/networks";
import { loadOriginChains } from "./lib/origin-chains";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const startTime = Date.now();

// --- Rate limiter middleware (in-memory, per-IP) ---
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// C4: Periodically evict expired rate limit entries to prevent unbounded growth
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 60_000);
rateLimitCleanupInterval.unref();

function getRateLimitKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // Rightmost entry is added by our trusted proxy (Caddy), not the client
    return parts[parts.length - 1] ?? "unknown";
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

// --- Initialize infrastructure ---

// Origin chains + state root oracles
const originChains = loadOriginChains();
const registry = new ModuleRegistry();

for (const oc of originChains) {
  const client = createPublicClient({ chain: oc.chain, transport: http(oc.rpcUrl) });
  const oracle = new StateRootOracle(client, logger);

  registry.register(
    new EthBalanceModule(oracle, {
      chainId: oc.chainId,
      chainName: oc.name,
      epochDuration: config.epochDuration,
      minBalance: config.minBalanceWei,
    }),
  );

  logger.info({ chainId: oc.chainId, chainName: oc.name }, "Origin chain configured");
}

// Nullifier store (SQLite)
// Resolve relative DB path from project root (two levels up from server package)
import { resolve } from "path";
const dbPath = config.dbPath.startsWith("/")
  ? config.dbPath
  : resolve(import.meta.dir, "../../..", config.dbPath);
const nullifierStore = new NullifierStore(dbPath);
const claimStore = new ClaimStore(nullifierStore.database);

// Fund dispatcher
const networks = loadNetworks();
const dispatcher = new FundDispatcher(networks, config.faucetPrivateKey, logger);

// --- Build Hono app ---
const app = new Hono();

// CORS middleware
app.use("*", cors({
  origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
}));

// COOP/COEP headers for multi-threaded WASM (required by @aztec/bb.js SharedArrayBuffer)
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
});

// Rate limiting middleware (only applies to /claim)
app.use("/claim", async (c, next) => {
  const key = getRateLimitKey(c);
  const now = Date.now();

  let entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + config.rateLimitWindowMs };
    rateLimitMap.set(key, entry);
  }

  entry.count++;

  c.header("X-RateLimit-Limit", String(config.rateLimitMax));
  c.header("X-RateLimit-Remaining", String(Math.max(0, config.rateLimitMax - entry.count)));
  c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > config.rateLimitMax) {
    throw AppError.rateLimited();
  }

  await next();
});

// Error handling middleware
app.onError((err, c) => {
  if (err instanceof AppError) {
    logger.warn({ code: err.code, message: err.message }, "Application error");
    return c.json(err.toJSON(), err.statusCode as any);
  }

  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    500,
  );
});

// Mount routes
app.route("/claim", createClaimRouter({ registry, nullifierStore, claimStore, dispatcher, logger }));
app.route("/status", createStatusRouter({ claimStore }));
app.route("/modules", createModulesRouter({ registry, dispatcher, startTime }));
app.route("/circuits", createCircuitsRouter({ registry, dispatcher, startTime }));
app.route("/networks", createNetworksRouter({ registry, dispatcher, startTime }));
app.route("/health", createHealthRouter({ registry, dispatcher, startTime }));

// --- Serve frontend static files ---
const frontendDir = new URL("../../frontend/dist", import.meta.url).pathname;

app.use("/assets/*", serveStatic({ root: frontendDir }));

app.get("*", async (c) => {
  const file = Bun.file(`${frontendDir}/index.html`);
  if (await file.exists()) {
    const html = await file.text();
    return c.html(html);
  }
  return c.notFound();
});

// Initialize verification key before starting server (blocks startup to prevent
// claims arriving before the VK is ready — first run takes ~80s without cache)
const vkStart = performance.now();
try {
  await initBackend();
  logger.info({ durationMs: Math.round(performance.now() - vkStart) }, "Verification key ready");
} catch (err) {
  logger.error({ err }, "Failed to initialize verification key — proof verification will fail");
}

// H3: Hourly nullifier pruning for old epochs
const currentEpoch = () => Math.floor(Date.now() / 1000 / config.epochDuration);
const nullifierPruneInterval = setInterval(() => {
  const pruned = nullifierStore.prune(currentEpoch() - 2);
  if (pruned > 0) {
    logger.info({ pruned, beforeEpoch: currentEpoch() - 2 }, "Pruned old nullifiers");
  }
}, 3_600_000); // 1 hour
nullifierPruneInterval.unref();

logger.info(
  { port: config.port, host: config.host, originChains: originChains.map((c) => c.name), minBalanceWei: config.minBalanceWei.toString() },
  "Starting zk_faucet server",
);

// H7: Graceful shutdown
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
});

const shutdown = () => {
  logger.info("Shutting down...");
  clearInterval(rateLimitCleanupInterval);
  clearInterval(nullifierPruneInterval);
  nullifierStore.close();
  server.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
