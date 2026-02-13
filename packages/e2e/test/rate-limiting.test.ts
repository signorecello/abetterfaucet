import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { ModuleRegistry } from "../../server/src/lib/modules/registry";
import { EthBalanceModule } from "../../server/src/lib/modules/eth-balance/module";
import { NullifierStore } from "../../server/src/lib/nullifier-store";
import { createClaimRouter, claimRecords } from "../../server/src/routes/claim";
import { AppError } from "../../server/src/util/errors";
import { claimBody, uniqueNullifier, getValidStateRoot } from "./helpers/fixtures";

process.env.NODE_ENV = "test";

class MockStateRootOracle {
  async start() {}
  stop() {}
  async getLatestStateRoot() {
    return { blockNumber: 1000n, stateRoot: getValidStateRoot() };
  }
  async isValidStateRoot(stateRoot: string): Promise<boolean> {
    return stateRoot === getValidStateRoot();
  }
}

let claimCounter = 0;
class MockFundDispatcher {
  async dispatch(networkId: string, _recipient: `0x${string}`) {
    claimCounter++;
    return {
      txHash: "0x" + "ab".repeat(32),
      claimId: "0x" + claimCounter.toString(16).padStart(32, "0"),
    };
  }
  getNetwork(networkId: string) {
    if (networkId === "sepolia") {
      return {
        id: "sepolia", name: "Sepolia", chainId: 11155111,
        rpcUrl: "https://rpc.sepolia.org", explorerUrl: "https://sepolia.etherscan.io",
        enabled: true, dispensationWei: "100000000000000000",
      };
    }
    return undefined;
  }
  getNetworks() { return [this.getNetwork("sepolia")!]; }
  async getBalance() { return 1000000000000000000n; }
}

const noop = () => {};
const noopLogger = {
  info: noop, warn: noop, error: noop, debug: noop,
  trace: noop, fatal: noop, child: () => noopLogger, level: "silent",
} as any;

const RATE_LIMIT_MAX = 5;

interface RateLimitEntry { count: number; resetAt: number; }

function buildRateLimitedServer() {
  const oracle = new MockStateRootOracle();
  const registry = new ModuleRegistry();
  const module = new EthBalanceModule(oracle as any, {
    epochDuration: 604_800,
    minBalance: 10_000_000_000_000_000n,
  });
  // Mock verifyProof at module level (no real Barretenberg in rate limit tests)
  (module as any).verifyProof = async (proof: Uint8Array, _inputs: any) => {
    return proof.length > 0;
  };
  registry.register(module);

  const nullifierStore = new NullifierStore(":memory:");
  const dispatcher = new MockFundDispatcher();
  const rateLimitMap = new Map<string, RateLimitEntry>();

  const app = new Hono();

  // Rate limiting middleware (matches production)
  app.use("*", async (c, next) => {
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    const now = Date.now();
    let entry = rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      rateLimitMap.set(key, entry);
    }
    entry.count++;

    c.header("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    c.header("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - entry.count)));

    if (entry.count > RATE_LIMIT_MAX) {
      throw AppError.rateLimited();
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as any);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  });

  app.route("/claim", createClaimRouter({
    registry, nullifierStore, dispatcher: dispatcher as any, logger: noopLogger,
  }));

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://localhost:${server.port}`;

  return {
    baseUrl,
    currentEpoch: module.currentEpoch(),
    close: () => { server.stop(true); nullifierStore.close(); claimRecords.clear(); },
  };
}

describe("Rate limiting", () => {
  let server: ReturnType<typeof buildRateLimitedServer>;

  beforeAll(() => {
    server = buildRateLimitedServer();
  });

  afterAll(() => {
    server.close();
  });

  test(`requests beyond ${RATE_LIMIT_MAX} limit return 429 RATE_LIMITED`, async () => {
    const results: number[] = [];

    // Send RATE_LIMIT_MAX + 2 requests to exceed the limit
    for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) {
      const body = claimBody(server.currentEpoch, { nullifier: uniqueNullifier() });
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      results.push(res.status);
    }

    // First RATE_LIMIT_MAX should succeed (200)
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(results[i]).toBe(200);
    }

    // Requests beyond limit should be rate-limited (429)
    for (let i = RATE_LIMIT_MAX; i < results.length; i++) {
      expect(results[i]).toBe(429);
    }
  });

  test("rate limit response includes correct error code", async () => {
    // Use a different "IP" via x-forwarded-for to get a fresh rate limit window
    const results: Response[] = [];

    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      const body = claimBody(server.currentEpoch, { nullifier: uniqueNullifier() });
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.99",
        },
        body: JSON.stringify(body),
      });
      results.push(res);
    }

    const lastRes = results[results.length - 1];
    expect(lastRes.status).toBe(429);
    const json = (await lastRes.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("RATE_LIMITED");
  });

  test("different IPs have independent rate limits", async () => {
    const server2 = buildRateLimitedServer();

    try {
      // IP "A" sends RATE_LIMIT_MAX requests
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        const body = claimBody(server2.currentEpoch, { nullifier: uniqueNullifier() });
        await fetch(`${server2.baseUrl}/claim`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "1.1.1.1",
          },
          body: JSON.stringify(body),
        });
      }

      // IP "B" should still be able to claim
      const body = claimBody(server2.currentEpoch, { nullifier: uniqueNullifier() });
      const res = await fetch(`${server2.baseUrl}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "2.2.2.2",
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    } finally {
      server2.close();
    }
  });
});
