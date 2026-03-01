import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { Hono } from "hono";
import { createClaimRouter, type ClaimDeps } from "../../src/routes/claim";
import { ModuleRegistry } from "../../src/lib/modules/registry";
import { NullifierStore } from "../../src/lib/nullifier-store";
import { ClaimStore } from "../../src/lib/claim-store";
import { AppError } from "../../src/util/errors";
import type { ProofModule, PublicInputs, ValidationResult } from "../../src/lib/modules/types";
import pino from "pino";

function createMockModule(overrides: Partial<ProofModule> = {}): ProofModule {
  return {
    id: "eth-balance:1",
    nullifierGroup: "eth-balance",
    name: "ETH Balance Proof",
    description: "Test module",
    epochDurationSeconds: 604800,
    currentEpoch: mock(() => 100),
    validatePublicInputs: mock((_inputs: PublicInputs) =>
      Promise.resolve({ valid: true } as ValidationResult),
    ),
    verifyProof: mock((_proof: Uint8Array, _inputs: PublicInputs) =>
      Promise.resolve(true),
    ),
    ...overrides,
  };
}

function createMockDispatcher() {
  return {
    dispatch: mock(() =>
      Promise.resolve({ txHash: "0xtxhash", claimId: "0xclaim123" }),
    ),
    getNetwork: mock(() => ({
      id: "sepolia",
      name: "Sepolia",
      chainId: 11155111,
      rpcUrl: "https://rpc.sepolia.org",
      explorerUrl: "https://sepolia.etherscan.io",
      enabled: true,
      dispensationWei: "100000000000000000",
    })),
    getNetworks: mock(() => []),
    getBalance: mock(() => Promise.resolve(0n)),
  };
}

const logger = pino({ level: "silent" });

function validClaimBody() {
  return {
    moduleId: "eth-balance:1",
    proof: "0xdeadbeef",
    publicInputs: {
      stateRoot: "0x" + "ab".repeat(32),
      epoch: 100,
      minBalance: "10000000000000000",
      nullifier: "0x" + "cd".repeat(32),
      blockNumber: "1000",
    },
    recipient: "0x" + "11".repeat(20),
    targetNetwork: "sepolia",
  };
}

describe("POST /claim", () => {
  let app: Hono;
  let deps: ClaimDeps;
  let nullifierStore: NullifierStore;
  let claimStore: ClaimStore;

  beforeEach(() => {
    nullifierStore = new NullifierStore(":memory:");
    claimStore = new ClaimStore(nullifierStore.database);
    const registry = new ModuleRegistry();
    registry.register(createMockModule());

    deps = {
      registry,
      nullifierStore,
      claimStore,
      dispatcher: createMockDispatcher() as any,
      logger,
    };

    app = new Hono();
    app.route("/claim", createClaimRouter(deps));

    // Error handler
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });
  });

  afterEach(() => {
    nullifierStore.close();
  });

  test("valid claim returns 200 with txHash", async () => {
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.txHash).toBe("0xtxhash");
    expect(body.claimId).toBe("0xclaim123");
    expect(body.network).toBe("sepolia");
  });

  test("valid claim is persisted in ClaimStore", async () => {
    await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    const record = claimStore.get("0xclaim123");
    expect(record).not.toBeNull();
    expect(record!.status).toBe("confirmed");
    expect(record!.txHash).toBe("0xtxhash");
    expect(record!.network).toBe("sepolia");
    expect(record!.recipient).toBe("0x" + "11".repeat(20));
  });

  test("invalid module returns 400", async () => {
    const registry = new ModuleRegistry();
    // Register nothing - module lookup will fail
    deps.registry = registry;
    app = new Hono();
    app.route("/claim", createClaimRouter(deps));
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });

    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_MODULE");
  });

  test("invalid proof returns 400", async () => {
    const registry = new ModuleRegistry();
    registry.register(
      createMockModule({
        verifyProof: mock(() => Promise.resolve(false)),
      }),
    );
    deps.registry = registry;
    app = new Hono();
    app.route("/claim", createClaimRouter(deps));
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });

    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_PROOF");
  });

  test("already claimed returns 409", async () => {
    // First claim succeeds
    await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    // Second claim with same nullifier should fail (isSpent check before dispatch)
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ALREADY_CLAIMED");
  });

  test("missing fields returns 400", async () => {
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleId: "eth-balance" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_PUBLIC_INPUTS");
  });

  // --- Security edge cases ---

  test("empty proof hex (0x only) returns 400 INVALID_PROOF", async () => {
    const body = validClaimBody();
    body.proof = "0x";
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_PROOF");
  });

  test("dispatch failure returns 500 DISPATCH_FAILED and does not burn nullifier", async () => {
    const failingDispatcher = createMockDispatcher();
    failingDispatcher.dispatch = mock(() => Promise.reject(new Error("insufficient funds")));

    const registry = new ModuleRegistry();
    registry.register(createMockModule());

    const localNullifierStore = new NullifierStore(":memory:");
    const localClaimStore = new ClaimStore(localNullifierStore.database);

    const failApp = new Hono();
    failApp.route("/claim", createClaimRouter({
      registry,
      nullifierStore: localNullifierStore,
      claimStore: localClaimStore,
      dispatcher: failingDispatcher as any,
      logger,
    }));
    failApp.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });

    const res = await failApp.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("DISPATCH_FAILED");

    // C1: nullifier should NOT be spent when dispatch fails (rolled back)
    const isSpent = localNullifierStore.isSpent("eth-balance", "0x" + "cd".repeat(32));
    expect(isSpent).toBe(false);

    // C1: user can retry after dispatch failure
    const retryDispatcher = createMockDispatcher();
    const retryApp = new Hono();
    retryApp.route("/claim", createClaimRouter({
      registry,
      nullifierStore: localNullifierStore,
      claimStore: localClaimStore,
      dispatcher: retryDispatcher as any,
      logger,
    }));
    retryApp.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });

    const retryRes = await retryApp.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(retryRes.status).toBe(200);

    localNullifierStore.close();
  });

  test("zero address recipient returns 400", async () => {
    const body = validClaimBody();
    body.recipient = "0x" + "00".repeat(20);
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_PUBLIC_INPUTS");
  });

  test("recipient with wrong length returns 400", async () => {
    const body = validClaimBody();
    body.recipient = "0x" + "11".repeat(19); // 38 hex chars, not 40
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_PUBLIC_INPUTS");
  });

  test("recipient with non-hex chars returns 400", async () => {
    const body = validClaimBody();
    body.recipient = "0x" + "gg".repeat(20);
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("negative epoch returns 400", async () => {
    const body = validClaimBody();
    body.publicInputs.epoch = -1;
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("non-integer epoch returns 400", async () => {
    const body = validClaimBody();
    (body.publicInputs as any).epoch = 100.5;
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("nullifier without 0x prefix returns 400", async () => {
    const body = validClaimBody();
    body.publicInputs.nullifier = "cd".repeat(32);
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_PUBLIC_INPUTS");
  });

  test("stateRoot without 0x prefix returns 400", async () => {
    const body = validClaimBody();
    body.publicInputs.stateRoot = "ab".repeat(32);
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("extra fields in request body are ignored (no crash)", async () => {
    const body = {
      ...validClaimBody(),
      extraField: "should-be-ignored",
      __proto__: { polluted: true },
    };
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Should still succeed (extra fields are ignored by valibot)
    expect(res.status).toBe(200);
  });

  test("empty moduleId returns 400", async () => {
    const body = validClaimBody();
    body.moduleId = "";
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("empty targetNetwork returns 400", async () => {
    const body = validClaimBody();
    body.targetNetwork = "";
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  test("validation failure returns 400 INVALID_PUBLIC_INPUTS", async () => {
    const registry = new ModuleRegistry();
    registry.register(
      createMockModule({
        validatePublicInputs: mock(() =>
          Promise.resolve({ valid: false, error: "State root is not recognized or too old" }),
        ),
      }),
    );
    deps.registry = registry;

    const valApp = new Hono();
    valApp.route("/claim", createClaimRouter(deps));
    valApp.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500);
    });

    const res = await valApp.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validClaimBody()),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_PUBLIC_INPUTS");
  });

  test("proof with odd-length hex (non-byte-aligned) still works", async () => {
    const body = validClaimBody();
    body.proof = "0xabc"; // 3 hex chars = 1.5 bytes
    body.publicInputs.nullifier = "0x" + "ee".repeat(32);
    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // The regex /.{1,2}/g handles odd-length hex gracefully
    expect(res.status).toBe(200);
  });
});
