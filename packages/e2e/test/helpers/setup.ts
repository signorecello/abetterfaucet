/**
 * Test harness that builds a fully functional faucet server in-process.
 *
 * Instead of importing the server's index.ts (which has side effects and
 * requires real env vars / RPC connections), we assemble the Hono app from
 * the same building blocks:
 *   - ModuleRegistry + EthBalanceModule
 *   - NullifierStore (in-memory SQLite)
 *   - A mock StateRootOracle that returns our test state root
 *   - A mock FundDispatcher that returns fake tx hashes
 *
 * When a real proof fixture exists (from `bun run eth_balance:prove`),
 * the verifier uses real Barretenberg verification. Otherwise, the
 * module's verifyProof is mocked to accept any non-empty proof so the
 * HTTP flow can still be tested.
 */

import { Hono } from "hono";
import { ModuleRegistry } from "../../../server/src/lib/modules/registry";
import { EthBalanceModule } from "../../../server/src/lib/modules/eth-balance/module";
import { NullifierStore } from "../../../server/src/lib/nullifier-store";
import { createClaimRouter, claimRecords } from "../../../server/src/routes/claim";
import { createStatusRouter } from "../../../server/src/routes/status";
import { AppError } from "../../../server/src/util/errors";
import { getValidStateRoot, HAS_REAL_FIXTURE } from "./fixtures";

process.env.NODE_ENV = "test";

// ---- Mock StateRootOracle ----

/**
 * A minimal oracle that accepts only our seeded test state root.
 * This avoids any real Ethereum RPC calls.
 */
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

// ---- Mock FundDispatcher ----

let claimCounter = 0;

class MockFundDispatcher {
  async dispatch(
    networkId: string,
    _recipient: `0x${string}`,
  ) {
    claimCounter++;
    const claimId =
      "0x" + claimCounter.toString(16).padStart(32, "0");
    const txHash =
      "0x" + "ab".repeat(32);
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

// ---- Mock Logger ----

const noop = () => {};
const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => noopLogger,
  level: "silent",
} as any;

// ---- Test Server ----

export interface TestServer {
  /** The base URL of the running test server (e.g. http://localhost:54321) */
  baseUrl: string;
  /** The current epoch as computed by the EthBalanceModule */
  currentEpoch: number;
  /** Whether real proof verification is enabled */
  hasRealVerification: boolean;
  /** Stop the server and clean up */
  close: () => void;
}

/**
 * Start a test server on a random available port. Returns a handle
 * with the base URL and a cleanup function.
 */
export function startTestServer(): TestServer {
  // Build components
  const oracle = new MockStateRootOracle();
  const registry = new ModuleRegistry();
  const module = new EthBalanceModule(oracle as any, {
    epochDuration: 604_800,
    minBalance: 10_000_000_000_000_000n,
  });

  // If no real proof fixture, mock verifyProof at the module level
  // so E2E HTTP flow tests still work without Barretenberg.
  if (!HAS_REAL_FIXTURE) {
    (module as any).verifyProof = async (proof: Uint8Array, _inputs: any) => {
      return proof.length > 0;
    };
  }

  registry.register(module);

  const nullifierStore = new NullifierStore(":memory:");
  const dispatcher = new MockFundDispatcher();

  // Build Hono app
  const app = new Hono();

  // Error handler matching the server's pattern
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as any);
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      500,
    );
  });

  // Mount routes
  app.route(
    "/claim",
    createClaimRouter({
      registry,
      nullifierStore,
      dispatcher: dispatcher as any,
      logger: noopLogger,
    }),
  );
  app.route("/status", createStatusRouter());

  // Start on port 0 to get a random available port
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  });

  const baseUrl = `http://localhost:${server.port}`;
  const currentEpoch = module.currentEpoch();

  return {
    baseUrl,
    currentEpoch,
    hasRealVerification: HAS_REAL_FIXTURE,
    close: () => {
      server.stop(true);
      nullifierStore.close();
      claimRecords.clear();
    },
  };
}

/**
 * Helper to POST JSON to a path on the test server.
 */
export async function postClaim(
  baseUrl: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
