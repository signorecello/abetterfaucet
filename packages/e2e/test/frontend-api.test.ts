import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { ModuleRegistry } from "../../server/src/lib/modules/registry";
import { EthBalanceModule } from "../../server/src/lib/modules/eth-balance/module";
import { NullifierStore } from "../../server/src/lib/nullifier-store";
import { createClaimRouter, claimRecords } from "../../server/src/routes/claim";
import { createStatusRouter } from "../../server/src/routes/status";
import {
  createModulesRouter,
  createNetworksRouter,
  createHealthRouter,
} from "../../server/src/routes/circuits";
import { AppError } from "../../server/src/util/errors";
import {
  getValidStateRoot,
  getValidProof,
  TEST_RECIPIENT,
  TEST_NETWORK,
  MODULE_ID,
  MIN_BALANCE_WEI,
  claimBody,
  uniqueNullifier,
} from "./helpers/fixtures";

process.env.NODE_ENV = "test";

// --- Mocks (same pattern as setup.ts) ---

class MockStateRootOracle {
  private validRoots: Set<string>;
  constructor(validRoots: string[] = [getValidStateRoot()]) {
    this.validRoots = new Set(validRoots);
  }
  async start() {}
  stop() {}
  async getLatestStateRoot() {
    return { blockNumber: 1000n, stateRoot: getValidStateRoot() };
  }
  async isValidStateRoot(stateRoot: string): Promise<boolean> {
    return this.validRoots.has(stateRoot);
  }
}

let claimCounter = 0;

class MockFundDispatcher {
  async dispatch(networkId: string, _recipient: `0x${string}`) {
    claimCounter++;
    const claimId = "0x" + claimCounter.toString(16).padStart(32, "0");
    const txHash = "0x" + "ab".repeat(32);
    return { txHash, claimId };
  }

  getNetwork(networkId: string) {
    if (networkId === "sepolia") {
      return {
        id: "sepolia",
        name: "Sepolia",
        chainId: 11155111,
        rpcUrl: "https://rpc.sepolia.org",
        explorerUrl: "https://sepolia.etherscan.io",
        enabled: true,
        dispensationWei: "100000000000000000",
      };
    }
    return undefined;
  }

  getNetworks() {
    return [this.getNetwork("sepolia")!];
  }

  async getBalance() {
    return 1000000000000000000n;
  }
}

const noop = () => {};
const noopLogger = {
  info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
  child: () => noopLogger, level: "silent",
} as any;

// --- Test server with ALL routes (including frontend-facing ones) ---

interface FullTestServer {
  baseUrl: string;
  currentEpoch: number;
  close: () => void;
}

function startFullTestServer(): FullTestServer {
  const oracle = new MockStateRootOracle();
  const registry = new ModuleRegistry();
  const module = new EthBalanceModule(oracle as any, {
    epochDuration: 604_800,
    minBalance: 10_000_000_000_000_000n,
  });
  // Mock verifyProof at module level (no real Barretenberg in frontend API tests)
  (module as any).verifyProof = async (proof: Uint8Array, _inputs: any) => {
    return proof.length > 0;
  };
  registry.register(module);

  const nullifierStore = new NullifierStore(":memory:");
  const dispatcher = new MockFundDispatcher();
  const startTime = Date.now();

  const app = new Hono();

  // Error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as any);
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500,
    );
  });

  // Mount API routes
  app.route("/claim", createClaimRouter({
    registry, nullifierStore, dispatcher: dispatcher as any, logger: noopLogger,
  }));
  app.route("/status", createStatusRouter());
  app.route("/modules", createModulesRouter({ registry, dispatcher: dispatcher as any, startTime }));
  app.route("/networks", createNetworksRouter({ registry, dispatcher: dispatcher as any, startTime }));
  app.route("/health", createHealthRouter({ registry, dispatcher: dispatcher as any, startTime }));

  // Serve frontend static files (same as server/src/index.ts)
  const frontendDir = new URL("../../frontend/public", import.meta.url).pathname;

  app.use("/public/*", serveStatic({
    root: frontendDir,
    rewriteRequestPath: (path) => path.replace(/^\/public/, ""),
  }));

  app.get("/", async (c) => {
    const file = Bun.file(`${frontendDir}/index.html`);
    const html = await file.text();
    return c.html(html);
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://localhost:${server.port}`;
  const currentEpoch = module.currentEpoch();

  return {
    baseUrl,
    currentEpoch,
    close: () => {
      server.stop(true);
      nullifierStore.close();
      claimRecords.clear();
    },
  };
}

// ============================================================
// Tests
// ============================================================

describe("Frontend API integration tests", () => {
  let server: FullTestServer;

  beforeAll(() => {
    server = startFullTestServer();
  });

  afterAll(() => {
    server.close();
  });

  // ----------------------------------------------------------
  // 1. Frontend static file serving
  // ----------------------------------------------------------

  describe("GET / (frontend index)", () => {
    test("returns HTML content", async () => {
      const res = await fetch(server.baseUrl);
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!DOCTYPE html");
    });
  });

  describe("GET /public/styles.css", () => {
    test("returns CSS content", async () => {
      const res = await fetch(`${server.baseUrl}/public/styles.css`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // CSS files should contain style rules
      expect(body.length).toBeGreaterThan(0);
      // A CSS file will typically contain { or : characters
      expect(body).toMatch(/[{:]/);
    });
  });

  describe("GET /public/bundle.js", () => {
    test("returns JavaScript content", async () => {
      const res = await fetch(`${server.baseUrl}/public/bundle.js`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("Static file edge cases", () => {
    test("requesting non-existent static file returns 404", async () => {
      const res = await fetch(`${server.baseUrl}/public/nonexistent.xyz`);
      expect(res.status).toBe(404);
    });

    test("path traversal attempt /public/../../../etc/passwd returns 404", async () => {
      const res = await fetch(`${server.baseUrl}/public/../../../etc/passwd`);
      // Should NOT return 200 or leak file contents
      expect(res.status).not.toBe(200);
    });

    test("path traversal attempt with encoded slashes returns 404", async () => {
      const res = await fetch(
        `${server.baseUrl}/public/..%2F..%2F..%2Fetc%2Fpasswd`,
      );
      expect(res.status).not.toBe(200);
    });

    test("double-dot path traversal does not leak files outside public dir", async () => {
      // /public/../package.json should NOT serve the server's package.json
      const res = await fetch(`${server.baseUrl}/public/../package.json`);
      // Either 404 or the response should not contain server package data
      if (res.status === 200) {
        const text = await res.text();
        expect(text).not.toContain('"name": "server"');
      }
    });
  });

  // ----------------------------------------------------------
  // 2. API contract: GET /networks
  // ----------------------------------------------------------

  describe("GET /networks", () => {
    test("returns valid JSON with networks array", async () => {
      const res = await fetch(`${server.baseUrl}/networks`);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json).toHaveProperty("networks");
      expect(Array.isArray(json.networks)).toBe(true);
      expect(json.networks.length).toBeGreaterThan(0);
    });

    test("each network has required fields", async () => {
      const res = await fetch(`${server.baseUrl}/networks`);
      const json = (await res.json()) as any;

      for (const net of json.networks) {
        expect(net).toHaveProperty("id");
        expect(net).toHaveProperty("name");
        expect(net).toHaveProperty("chainId");
        expect(net).toHaveProperty("explorerUrl");
        expect(net).toHaveProperty("enabled");
        expect(net).toHaveProperty("dispensationWei");
        expect(typeof net.id).toBe("string");
        expect(typeof net.name).toBe("string");
        expect(typeof net.chainId).toBe("number");
        expect(typeof net.enabled).toBe("boolean");
        expect(typeof net.dispensationWei).toBe("string");
      }
    });
  });

  // ----------------------------------------------------------
  // 3. API contract: GET /modules
  // ----------------------------------------------------------

  describe("GET /modules", () => {
    test("returns valid JSON with modules array", async () => {
      const res = await fetch(`${server.baseUrl}/modules`);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json).toHaveProperty("modules");
      expect(Array.isArray(json.modules)).toBe(true);
      expect(json.modules.length).toBeGreaterThan(0);
    });

    test("each module has expected structure", async () => {
      const res = await fetch(`${server.baseUrl}/modules`);
      const json = (await res.json()) as any;

      for (const mod of json.modules) {
        expect(mod).toHaveProperty("id");
        expect(mod).toHaveProperty("name");
        expect(mod).toHaveProperty("description");
        expect(mod).toHaveProperty("currentEpoch");
        expect(mod).toHaveProperty("epochDurationSeconds");
        expect(typeof mod.id).toBe("string");
        expect(typeof mod.name).toBe("string");
        expect(typeof mod.description).toBe("string");
        expect(typeof mod.currentEpoch).toBe("number");
        expect(typeof mod.epochDurationSeconds).toBe("number");
        expect(mod.currentEpoch).toBeGreaterThan(0);
        expect(mod.epochDurationSeconds).toBeGreaterThan(0);
      }
    });

    test("eth-balance module is listed", async () => {
      const res = await fetch(`${server.baseUrl}/modules`);
      const json = (await res.json()) as any;
      const ethModule = json.modules.find((m: any) => m.id === "eth-balance");
      expect(ethModule).toBeDefined();
      expect(ethModule.name).toBe("ETH Balance Proof");
    });
  });

  // ----------------------------------------------------------
  // 4. API contract: GET /health
  // ----------------------------------------------------------

  describe("GET /health", () => {
    test("returns { status, uptime, version }", async () => {
      const res = await fetch(`${server.baseUrl}/health`);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json).toHaveProperty("status");
      expect(json).toHaveProperty("uptime");
      expect(json).toHaveProperty("version");
      expect(json.status).toBe("ok");
      expect(typeof json.uptime).toBe("number");
      expect(json.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof json.version).toBe("string");
    });
  });

  // ----------------------------------------------------------
  // 5. API contract: POST /claim response shape
  // ----------------------------------------------------------

  describe("POST /claim (full frontend flow)", () => {
    test("successful claim returns { claimId, txHash, network, amount }", async () => {
      const body = claimBody(server.currentEpoch);
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;

      expect(json).toHaveProperty("claimId");
      expect(json).toHaveProperty("txHash");
      expect(json).toHaveProperty("network");
      expect(json).toHaveProperty("amount");

      expect(json.claimId).toMatch(/^0x[0-9a-f]+$/);
      expect(json.txHash).toMatch(/^0x[0-9a-f]+$/);
      expect(json.network).toBe("sepolia");
      expect(json.amount).toBe("100000000000000000");
    });
  });

  // ----------------------------------------------------------
  // 6. API contract: GET /status/:claimId response shape
  // ----------------------------------------------------------

  describe("GET /status/:claimId", () => {
    test("returns { claimId, status, txHash, network } for a confirmed claim", async () => {
      const body = claimBody(server.currentEpoch);
      const claimRes = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(claimRes.status).toBe(200);
      const claimJson = (await claimRes.json()) as any;

      const statusRes = await fetch(`${server.baseUrl}/status/${claimJson.claimId}`);
      expect(statusRes.status).toBe(200);

      const json = (await statusRes.json()) as any;
      expect(json).toHaveProperty("claimId");
      expect(json).toHaveProperty("status");
      expect(json).toHaveProperty("txHash");
      expect(json).toHaveProperty("network");
      expect(json.claimId).toBe(claimJson.claimId);
      expect(json.status).toBe("confirmed");
      expect(json.txHash).toMatch(/^0x[0-9a-f]+$/);
      expect(json.network).toBe("sepolia");
    });

    test("returns 404 with NOT_FOUND for unknown claimId", async () => {
      const res = await fetch(`${server.baseUrl}/status/0xdeadbeef`);
      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("NOT_FOUND");
      expect(typeof json.error.message).toBe("string");
      expect(json.error.message.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------
  // 7. Error message quality
  // ----------------------------------------------------------

  describe("Error message quality", () => {
    test("INVALID_MODULE error has descriptive message", async () => {
      const body = claimBody(server.currentEpoch, { moduleId: "nonexistent-module" });
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);

      const json = (await res.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("INVALID_MODULE");
      expect(json.error.message).toContain("nonexistent-module");
      expect(json.error.message.length).toBeGreaterThan(5);
    });

    test("INVALID_PUBLIC_INPUTS error has descriptive message", async () => {
      // Send request with missing required fields
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleId: "eth-balance" }),
      });
      expect(res.status).toBe(400);

      const json = (await res.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("INVALID_PUBLIC_INPUTS");
      expect(typeof json.error.message).toBe("string");
      expect(json.error.message.length).toBeGreaterThan(5);
    });

    test("INVALID_PROOF error has descriptive message", async () => {
      const body = claimBody(server.currentEpoch, { proof: "0x" });
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);

      const json = (await res.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("INVALID_PROOF");
      expect(typeof json.error.message).toBe("string");
      expect(json.error.message.length).toBeGreaterThan(5);
    });

    test("ALREADY_CLAIMED error has descriptive message", async () => {
      const nullifier = uniqueNullifier();
      const body1 = claimBody(server.currentEpoch, { nullifier });
      const res1 = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body1),
      });
      expect(res1.status).toBe(200);

      // Second claim with same nullifier
      const body2 = claimBody(server.currentEpoch, { nullifier });
      const res2 = await fetch(`${server.baseUrl}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body2),
      });
      expect(res2.status).toBe(409);

      const json = (await res2.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("ALREADY_CLAIMED");
      expect(typeof json.error.message).toBe("string");
      expect(json.error.message.length).toBeGreaterThan(5);
    });

    test("NOT_FOUND error has descriptive message", async () => {
      const res = await fetch(`${server.baseUrl}/status/0xnonexistent`);
      expect(res.status).toBe(404);

      const json = (await res.json()) as any;
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("NOT_FOUND");
      expect(json.error.message).toContain("not found");
    });

    test("all error responses follow { error: { code, message } } shape", async () => {
      // Test multiple error scenarios and verify consistent shape
      const errorCases = [
        // Unknown module
        fetch(`${server.baseUrl}/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(claimBody(server.currentEpoch, { moduleId: "bad" })),
        }),
        // Missing fields
        fetch(`${server.baseUrl}/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        // Unknown status
        fetch(`${server.baseUrl}/status/0xbad`),
      ];

      const results = await Promise.all(errorCases);
      for (const res of results) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        const json = (await res.json()) as any;
        expect(json).toHaveProperty("error");
        expect(json.error).toHaveProperty("code");
        expect(json.error).toHaveProperty("message");
        expect(typeof json.error.code).toBe("string");
        expect(typeof json.error.message).toBe("string");
        // Error code should be a known code format (UPPER_SNAKE_CASE)
        expect(json.error.code).toMatch(/^[A-Z_]+$/);
        // Message should be descriptive (not just "error")
        expect(json.error.message.length).toBeGreaterThan(5);
      }
    });
  });

  // ----------------------------------------------------------
  // 8. Unsupported HTTP methods
  // ----------------------------------------------------------

  describe("HTTP method handling", () => {
    test("GET /claim returns 404 or 405 (not POST)", async () => {
      const res = await fetch(`${server.baseUrl}/claim`);
      // Hono returns 404 for unmatched routes
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("PUT /claim is not supported", async () => {
      const res = await fetch(`${server.baseUrl}/claim`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(claimBody(server.currentEpoch)),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("DELETE /claim is not supported", async () => {
      const res = await fetch(`${server.baseUrl}/claim`, { method: "DELETE" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST /networks is not supported", async () => {
      const res = await fetch(`${server.baseUrl}/networks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST /health is not supported", async () => {
      const res = await fetch(`${server.baseUrl}/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ----------------------------------------------------------
  // 9. Content-Type headers
  // ----------------------------------------------------------

  describe("Response Content-Type headers", () => {
    test("/networks returns application/json", async () => {
      const res = await fetch(`${server.baseUrl}/networks`);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("application/json");
    });

    test("/modules returns application/json", async () => {
      const res = await fetch(`${server.baseUrl}/modules`);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("application/json");
    });

    test("/health returns application/json", async () => {
      const res = await fetch(`${server.baseUrl}/health`);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("application/json");
    });

    test("/ returns text/html", async () => {
      const res = await fetch(server.baseUrl);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("text/html");
    });
  });
});
