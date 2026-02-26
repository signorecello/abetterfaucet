import { describe, test, expect, beforeEach, mock, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { EthBalanceModule } from "../../src/lib/modules/eth-balance/module";
import { encodePublicInputs, resetBackend } from "../../src/lib/modules/eth-balance/verifier";
import type { StateRootOracle } from "../../src/lib/state-root-oracle";
import type { PublicInputs } from "../../src/lib/modules/types";
const MIN_BALANCE_WEI = 10_000_000_000_000_000n;
const DEFAULT_EPOCH_DURATION = 604_800;

const FIXTURE_PATH = resolve(
  import.meta.dir,
  "../../../circuits/bin/eth_balance/target/test-fixture.json",
);
const HAS_FIXTURE = existsSync(FIXTURE_PATH);

function loadFixture() {
  if (!HAS_FIXTURE) throw new Error("Test fixture not found");
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
}

function createMockOracle(opts: { validStateRoots?: string[] } = {}): StateRootOracle {
  const validRoots = new Set(opts.validStateRoots ?? ["0xvalidroot"]);
  return {
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
    getLatestStateRoot: mock(() =>
      Promise.resolve({ blockNumber: 1000n, stateRoot: "0xvalidroot" }),
    ),
    isValidStateRoot: mock((root: string) => Promise.resolve(validRoots.has(root))),
  } as unknown as StateRootOracle;
}

afterAll(() => {
  resetBackend();
});

describe("EthBalanceModule", () => {
  let module: EthBalanceModule;
  let oracle: StateRootOracle;

  beforeEach(() => {
    oracle = createMockOracle();
    module = new EthBalanceModule(oracle, { minBalance: MIN_BALANCE_WEI });
  });

  test("id is eth-balance", () => {
    expect(module.id).toBe("eth-balance");
  });

  test("currentEpoch returns correct value", () => {
    const expected = Math.floor(Date.now() / 1000 / DEFAULT_EPOCH_DURATION);
    expect(module.currentEpoch()).toBe(expected);
  });

  test("epochDurationSeconds defaults to 604800 (1 week)", () => {
    expect(module.epochDurationSeconds).toBe(DEFAULT_EPOCH_DURATION);
  });

  test("currentEpoch respects custom epoch duration", () => {
    const customModule = new EthBalanceModule(oracle, { epochDuration: 3600, minBalance: MIN_BALANCE_WEI });
    const expected = Math.floor(Date.now() / 1000 / 3600);
    expect(customModule.currentEpoch()).toBe(expected);
  });

  describe("validatePublicInputs", () => {
    function validInputs(): PublicInputs {
      return {
        stateRoot: "0xvalidroot",
        epoch: module.currentEpoch(),
        minBalance: MIN_BALANCE_WEI.toString(),
        nullifier: "0xnullifier123",
      };
    }

    test("accepts valid inputs", async () => {
      const result = await module.validatePublicInputs(validInputs());
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test("rejects wrong epoch", async () => {
      const inputs = validInputs();
      inputs.epoch = 0;
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Epoch mismatch");
    });

    test("rejects stale state root", async () => {
      const inputs = validInputs();
      inputs.stateRoot = "0xstaleroot";
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not recognized or too old");
    });

    test("rejects min balance below threshold", async () => {
      const inputs = validInputs();
      inputs.minBalance = "1000"; // way below 0.01 ETH
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Minimum balance too low");
    });

    test("rejects empty nullifier", async () => {
      const inputs = validInputs();
      inputs.nullifier = "0x";
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("non-empty");
    });

    test("rejects empty string nullifier", async () => {
      const inputs = validInputs();
      inputs.nullifier = "";
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("non-empty");
    });

    test("accepts min balance exactly at threshold", async () => {
      const inputs = validInputs();
      inputs.minBalance = MIN_BALANCE_WEI.toString();
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(true);
    });

    test("accepts min balance above threshold", async () => {
      const inputs = validInputs();
      inputs.minBalance = (MIN_BALANCE_WEI * 2n).toString();
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(true);
    });

    test("rejects min balance one wei below threshold", async () => {
      const inputs = validInputs();
      inputs.minBalance = (MIN_BALANCE_WEI - 1n).toString();
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Minimum balance too low");
    });

    test("rejects epoch one ahead of current", async () => {
      const inputs = validInputs();
      inputs.epoch = module.currentEpoch() + 1;
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Epoch mismatch");
    });

    test("accepts epoch one behind current (skew tolerance)", async () => {
      const inputs = validInputs();
      inputs.epoch = module.currentEpoch() - 1;
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(true);
    });

    test("rejects epoch two behind current", async () => {
      const inputs = validInputs();
      inputs.epoch = module.currentEpoch() - 2;
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Epoch mismatch");
    });

    test("rejects zero min balance", async () => {
      const inputs = validInputs();
      inputs.minBalance = "0";
      const result = await module.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Minimum balance too low");
    });

    test("rejects negative min balance (as string)", async () => {
      const inputs = validInputs();
      inputs.minBalance = "-1";
      // BigInt("-1") is negative, which is less than minBalance
      await expect(module.validatePublicInputs(inputs)).resolves.toMatchObject({
        valid: false,
      });
    });

    test("oracle returning false for any state root rejects all claims", async () => {
      const strictOracle = createMockOracle({ validStateRoots: [] });
      const strictModule = new EthBalanceModule(strictOracle, { minBalance: MIN_BALANCE_WEI });
      const inputs: PublicInputs = {
        stateRoot: "0xvalidroot",
        epoch: strictModule.currentEpoch(),
        minBalance: MIN_BALANCE_WEI.toString(),
        nullifier: "0xnullifier123",
      };
      const result = await strictModule.validatePublicInputs(inputs);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not recognized");
    });
  });

  describe("encodePublicInputs", () => {
    test("produces 35 fields", () => {
      const inputs: PublicInputs = {
        stateRoot: "0x" + "ab".repeat(32),
        epoch: 2928,
        minBalance: "10000000000000000",
        nullifier: "0x" + "cd".repeat(32),
      };
      const fields = encodePublicInputs(inputs);
      expect(fields.length).toBe(35);
    });

    test("first 32 fields are individual state root bytes", () => {
      const stateRoot = "0x01020304050607080910111213141516171819202122232425262728293031ff";
      const inputs: PublicInputs = {
        stateRoot,
        epoch: 1,
        minBalance: "1",
        nullifier: "0x01",
      };
      const fields = encodePublicInputs(inputs);
      // First byte is 0x01
      expect(fields[0]).toBe("0x" + "0".repeat(63) + "1");
      // Second byte is 0x02
      expect(fields[1]).toBe("0x" + "0".repeat(63) + "2");
      // Last state root byte (index 31) is 0xff
      expect(fields[31]).toBe("0x" + "0".repeat(62) + "ff");
    });

    test("epoch, minBalance, nullifier are fields 32-34", () => {
      const inputs: PublicInputs = {
        stateRoot: "0x" + "00".repeat(32),
        epoch: 2928,
        minBalance: "10000000000000000",
        nullifier: "0x" + "ab".repeat(32),
      };
      const fields = encodePublicInputs(inputs);
      // epoch (field 32): 2928 = 0xb70
      expect(fields[32]).toBe("0x" + "0".repeat(61) + "b70");
      // minBalance (field 33): 10000000000000000 = 0x2386f26fc10000
      expect(fields[33]).toBe("0x" + "0".repeat(50) + "2386f26fc10000");
      // nullifier (field 34)
      expect(fields[34]).toBe("0x" + "ab".repeat(32));
    });
  });

  describe("verifyProof (real Barretenberg)", () => {
    const describeIfFixture = HAS_FIXTURE ? describe : describe.skip;

    // WASM backend init + verification takes ~10-15s on first call
    describeIfFixture("with test fixture", () => {
      test(
        "verifies a valid proof",
        async () => {
          const fixture = loadFixture();
          const proofHex: string = fixture.proof;
          const proofBytes = new Uint8Array(
            proofHex
              .slice(2)
              .match(/.{1,2}/g)!
              .map((b: string) => parseInt(b, 16)),
          );

          const fixtureOracle = createMockOracle({
            validStateRoots: [fixture.stateRoot],
          });
          const fixtureModule = new EthBalanceModule(fixtureOracle, { minBalance: MIN_BALANCE_WEI });

          const result = await fixtureModule.verifyProof(proofBytes, {
            stateRoot: fixture.stateRoot,
            epoch: fixture.epoch,
            minBalance: fixture.minBalance,
            nullifier: fixture.nullifier,
          });
          expect(result).toBe(true);
        },
        60_000,
      );

      test(
        "rejects a tampered proof",
        async () => {
          const fixture = loadFixture();
          const proofHex: string = fixture.proof;
          const proofBytes = new Uint8Array(
            proofHex
              .slice(2)
              .match(/.{1,2}/g)!
              .map((b: string) => parseInt(b, 16)),
          );

          // Tamper with a byte in the middle of the proof
          proofBytes[Math.floor(proofBytes.length / 2)] ^= 0xff;

          const fixtureOracle = createMockOracle({
            validStateRoots: [fixture.stateRoot],
          });
          const fixtureModule = new EthBalanceModule(fixtureOracle, { minBalance: MIN_BALANCE_WEI });

          const result = await fixtureModule.verifyProof(proofBytes, {
            stateRoot: fixture.stateRoot,
            epoch: fixture.epoch,
            minBalance: fixture.minBalance,
            nullifier: fixture.nullifier,
          });
          expect(result).toBe(false);
        },
        30_000,
      );

      test(
        "rejects with tampered public input",
        async () => {
          const fixture = loadFixture();
          const proofHex: string = fixture.proof;
          const proofBytes = new Uint8Array(
            proofHex
              .slice(2)
              .match(/.{1,2}/g)!
              .map((b: string) => parseInt(b, 16)),
          );

          const fixtureOracle = createMockOracle({
            validStateRoots: [fixture.stateRoot],
          });
          const fixtureModule = new EthBalanceModule(fixtureOracle, { minBalance: MIN_BALANCE_WEI });

          // Tamper with epoch (change to epoch + 1)
          const result = await fixtureModule.verifyProof(proofBytes, {
            stateRoot: fixture.stateRoot,
            epoch: fixture.epoch + 1,
            minBalance: fixture.minBalance,
            nullifier: fixture.nullifier,
          });
          expect(result).toBe(false);
        },
        30_000,
      );
    });
  });
});
