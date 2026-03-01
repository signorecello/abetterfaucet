import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { ModuleRegistry } from "../../server/src/lib/modules/registry";
import { NullifierStore } from "../../server/src/lib/nullifier-store";
import { createClaimRouter } from "../../server/src/routes/claim";
import { ClaimStore } from "../../server/src/lib/claim-store";
import { AppError } from "../../server/src/util/errors";
import type { ProofModule, PublicInputs, ValidationResult } from "../../server/src/lib/modules/types";
import { getValidStateRoot, getValidProof, TEST_RECIPIENT, TEST_NETWORK, MIN_BALANCE_WEI, uniqueNullifier } from "./helpers/fixtures";

process.env.NODE_ENV = "test";

function createMockModule(id: string, epochDuration: number = 604_800): ProofModule {
  return {
    id,
    nullifierGroup: id,
    name: `Mock ${id}`,
    description: `Test module ${id}`,
    epochDurationSeconds: epochDuration,
    currentEpoch: () => Math.floor(Date.now() / 1000 / epochDuration),
    validatePublicInputs: async (_inputs: PublicInputs): Promise<ValidationResult> => {
      return { valid: true };
    },
    verifyProof: async (_proof: Uint8Array, _inputs: PublicInputs): Promise<boolean> => {
      return true;
    },
  };
}

let claimCounter = 0;
class MockFundDispatcher {
  async dispatch(_networkId: string, _recipient: `0x${string}`) {
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

describe("Cross-module nullifier isolation", () => {
  let baseUrl: string;
  let bunServer: ReturnType<typeof Bun.serve>;
  let nullifierStore: NullifierStore;
  let currentEpoch: number;

  beforeAll(() => {
    const registry = new ModuleRegistry();
    const moduleA = createMockModule("module-a");
    const moduleB = createMockModule("module-b");
    registry.register(moduleA);
    registry.register(moduleB);

    nullifierStore = new NullifierStore(":memory:");
    const claimStore = new ClaimStore(nullifierStore.database);
    const dispatcher = new MockFundDispatcher();

    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    });
    app.route("/claim", createClaimRouter({
      registry, nullifierStore, claimStore, dispatcher: dispatcher as any, logger: noopLogger,
    }));

    bunServer = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${bunServer.port}`;
    currentEpoch = moduleA.currentEpoch();
  });

  afterAll(() => {
    bunServer.stop(true);
    nullifierStore.close();
  });

  function makeClaimBody(moduleId: string, nullifier: string) {
    return {
      moduleId,
      proof: getValidProof(),
      publicInputs: {
        stateRoot: getValidStateRoot(),
        epoch: currentEpoch,
        minBalance: MIN_BALANCE_WEI,
        nullifier,
        blockNumber: "1000",
      },
      recipient: TEST_RECIPIENT,
      targetNetwork: TEST_NETWORK,
    };
  }

  test("same nullifier in different modules: both succeed", async () => {
    const sharedNullifier = uniqueNullifier();

    const resA = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-a", sharedNullifier)),
    });
    expect(resA.status).toBe(200);

    const resB = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-b", sharedNullifier)),
    });
    expect(resB.status).toBe(200);
  });

  test("same nullifier in same module: second is rejected", async () => {
    const nullifier = uniqueNullifier();

    const res1 = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-a", nullifier)),
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-a", nullifier)),
    });
    expect(res2.status).toBe(409);
  });

  test("spending nullifier in module-a does not affect module-b", async () => {
    const nullifier = uniqueNullifier();

    // Spend in module-a
    await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-a", nullifier)),
    });

    // module-b with same nullifier should still succeed
    const res = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-b", nullifier)),
    });
    expect(res.status).toBe(200);

    // module-a with same nullifier should fail
    const res2 = await fetch(`${baseUrl}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeClaimBody("module-a", nullifier)),
    });
    expect(res2.status).toBe(409);
  });
});
