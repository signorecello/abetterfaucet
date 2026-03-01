import { describe, test, expect, mock } from "bun:test";
import { StateRootOracle } from "../src/lib/state-root-oracle";
import pino from "pino";

const logger = pino({ level: "silent" });

function makeBlock(number: bigint, stateRoot: string, timestampSec?: number) {
  return {
    number,
    stateRoot,
    hash: `0x${"00".repeat(32)}`,
    parentHash: `0x${"00".repeat(32)}`,
    nonce: "0x0",
    sha3Uncles: "0x0",
    logsBloom: "0x0",
    transactionsRoot: "0x0",
    receiptsRoot: "0x0",
    miner: "0x0",
    difficulty: 0n,
    totalDifficulty: 0n,
    extraData: "0x",
    size: 0n,
    gasLimit: 0n,
    gasUsed: 0n,
    timestamp: BigInt(timestampSec ?? Math.floor(Date.now() / 1000)),
    transactions: [],
    uncles: [],
  };
}

function createMockClient(handler: (opts: any) => any) {
  return {
    getBlock: mock(async (opts: any) => handler(opts)),
  } as any;
}

describe("StateRootOracle", () => {
  describe("getLatestStateRoot", () => {
    test("returns latest block's state root", async () => {
      const client = createMockClient((opts) => {
        if (opts.blockTag === "latest") return makeBlock(100n, "0xaaa");
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      const result = await oracle.getLatestStateRoot();
      expect(result.stateRoot).toBe("0xaaa");
      expect(result.blockNumber).toBe(100n);
    });

    test("throws when latest block has no stateRoot", async () => {
      const block = makeBlock(100n, "0xaaa");
      (block as any).stateRoot = undefined;
      const client = createMockClient(() => block);
      const oracle = new StateRootOracle(client, logger);

      await expect(oracle.getLatestStateRoot()).rejects.toThrow("missing stateRoot");
    });

    test("throws when RPC fails", async () => {
      const client = createMockClient(() => { throw new Error("RPC error"); });
      const oracle = new StateRootOracle(client, logger);

      await expect(oracle.getLatestStateRoot()).rejects.toThrow("RPC error");
    });
  });

  describe("isValidStateRoot", () => {
    test("accepts matching state root for recent block", async () => {
      const client = createMockClient((opts) => {
        if (opts.blockNumber === 100n) return makeBlock(100n, "0xabc");
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xabc", 100n)).toBe(true);
    });

    test("case-insensitive state root comparison", async () => {
      const client = createMockClient((opts) => {
        if (opts.blockNumber === 10n) return makeBlock(10n, "0xAbCdEf");
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xABCDEF", 10n)).toBe(true);
      expect(await oracle.isValidStateRoot("0xabcdef", 10n)).toBe(true);
    });

    test("rejects mismatched state root", async () => {
      const client = createMockClient((opts) => {
        if (opts.blockNumber === 100n) return makeBlock(100n, "0xabc");
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xwrong", 100n)).toBe(false);
    });

    test("rejects block older than 30 minutes", async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 31 * 60; // 31 minutes ago
      const client = createMockClient((opts) => {
        if (opts.blockNumber === 100n) return makeBlock(100n, "0xabc", oldTimestamp);
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xabc", 100n)).toBe(false);
    });

    test("accepts block just under 30 minutes old", async () => {
      const recentTimestamp = Math.floor(Date.now() / 1000) - 29 * 60; // 29 minutes ago
      const client = createMockClient((opts) => {
        if (opts.blockNumber === 100n) return makeBlock(100n, "0xabc", recentTimestamp);
        throw new Error("unexpected");
      });
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xabc", 100n)).toBe(true);
    });

    test("rejects block with missing stateRoot", async () => {
      const block = makeBlock(100n, "0xabc");
      (block as any).stateRoot = undefined;
      const client = createMockClient(() => block);
      const oracle = new StateRootOracle(client, logger);

      expect(await oracle.isValidStateRoot("0xabc", 100n)).toBe(false);
    });

    test("propagates RPC errors", async () => {
      const client = createMockClient(() => { throw new Error("RPC timeout"); });
      const oracle = new StateRootOracle(client, logger);

      await expect(oracle.isValidStateRoot("0xabc", 100n)).rejects.toThrow("RPC timeout");
    });
  });
});
