import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createPublicClient, http } from "viem";
import { mainnet, sepolia, holesky } from "viem/chains";
import { loadConfig } from "./util/env";
import { createLogger } from "./util/logger";
import { AppError } from "./util/errors";
import { ModuleRegistry } from "./lib/modules/registry";
import { EthBalanceModule } from "./lib/modules/eth-balance/module";
import { NullifierStore } from "./lib/nullifier-store";
import { FundDispatcher, type NetworkConfig } from "./lib/fund-dispatcher";
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
import networksJson from "../../../networks.json";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const startTime = Date.now();

// --- Rate limiter middleware (in-memory, per-IP) ---
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function getRateLimitKey(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

// --- Initialize infrastructure ---

// Resolve origin chain from ORIGIN_CHAINID
const originChainMap = { 1: mainnet, 11155111: sepolia, 17000: holesky } as const;
const originChain = originChainMap[config.originChainId as keyof typeof originChainMap];

// Origin chain public client for state root verification
const l1Client = createPublicClient({
  chain: originChain,
  transport: http(config.ethRpcUrl),
});
logger.info({ chainId: config.originChainId, chainName: originChain.name }, "Origin chain configured");

// State root oracle
const oracle = new StateRootOracle(l1Client, logger);

// Module registry
const registry = new ModuleRegistry();
registry.register(
  new EthBalanceModule(oracle, {
    epochDuration: config.epochDuration,
    minBalance: config.minBalanceWei,
  }),
);

// Nullifier store (SQLite)
// Resolve relative DB path from project root (two levels up from server package)
import { resolve } from "path";
const dbPath = config.dbPath.startsWith("/")
  ? config.dbPath
  : resolve(import.meta.dir, "../../..", config.dbPath);
const nullifierStore = new NullifierStore(dbPath);

// Fund dispatcher
const networks: NetworkConfig[] = (networksJson as { networks: NetworkConfig[] }).networks;
const dispatcher = new FundDispatcher(networks, config.faucetPrivateKey, logger);

// --- Build Hono app ---
const app = new Hono();

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
app.route("/claim", createClaimRouter({ registry, nullifierStore, dispatcher, logger }));
app.route("/status", createStatusRouter());
app.route("/modules", createModulesRouter({ registry, dispatcher, startTime }));
app.route("/circuits", createCircuitsRouter({ registry, dispatcher, startTime }));
app.route("/networks", createNetworksRouter({ registry, dispatcher, startTime }));
app.route("/health", createHealthRouter({ registry, dispatcher, startTime }));

// --- Serve frontend static files ---
const frontendDir = new URL("../../frontend/dist", import.meta.url).pathname;

app.use("/assets/*", serveStatic({ root: frontendDir }));

app.get("/", async (c) => {
  const file = Bun.file(`${frontendDir}/index.html`);
  const html = await file.text();
  return c.html(html);
});

// Verify ORIGIN_RPC_URL matches ORIGIN_CHAINID before starting
l1Client.getChainId().then((rpcChainId) => {
  if (rpcChainId !== config.originChainId) {
    logger.error(
      { expected: config.originChainId, actual: rpcChainId },
      "ORIGIN_RPC_URL chain ID does not match ORIGIN_CHAINID! Fix your .env",
    );
    process.exit(1);
  }
  logger.info({ chainId: rpcChainId }, "RPC chain ID verified");
}).catch((err) => {
  logger.error({ err }, "Failed to verify RPC chain ID");
});

// Start the oracle and server
oracle.start().then(() => {
  logger.info("State root oracle started");
}).catch((err) => {
  logger.warn({ err }, "State root oracle failed to start (will retry on next interval)");
});

logger.info(
  { port: config.port, host: config.host, originChainId: config.originChainId, minBalanceWei: config.minBalanceWei.toString() },
  "Starting zk_faucet server",
);

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
