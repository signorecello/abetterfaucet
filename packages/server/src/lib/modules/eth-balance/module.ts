import type { ProofModule, PublicInputs, ValidationResult } from "../types";
import type { StateRootOracle } from "../../state-root-oracle";
import { verifyProof } from "./verifier";
import { EPOCH_DURATION_SECONDS } from "./constants";

export class EthBalanceModule implements ProofModule {
  readonly id = "eth-balance";
  readonly name = "ETH Balance Proof";
  readonly description =
    "Proves ownership of sufficient ETH on the origin chain without revealing the address";
  readonly epochDurationSeconds: number;

  private readonly oracle: StateRootOracle;
  private readonly minBalance: bigint;

  constructor(oracle: StateRootOracle, options: { epochDuration?: number; minBalance: bigint }) {
    this.oracle = oracle;
    this.epochDurationSeconds = options?.epochDuration ?? EPOCH_DURATION_SECONDS;
    this.minBalance = options.minBalance;
  }

  currentEpoch(): number {
    return Math.floor(Date.now() / 1000 / this.epochDurationSeconds);
  }

  async validatePublicInputs(inputs: PublicInputs): Promise<ValidationResult> {
    // Verify the epoch matches the current epoch
    const currentEpoch = this.currentEpoch();
    if (inputs.epoch !== currentEpoch) {
      return {
        valid: false,
        error: `Epoch mismatch: expected ${currentEpoch}, got ${inputs.epoch}`,
      };
    }

    // Verify the minimum balance matches the required amount
    const claimedMin = BigInt(inputs.minBalance);
    if (claimedMin < this.minBalance) {
      return {
        valid: false,
        error: `Minimum balance too low: requires ${this.minBalance}, got ${claimedMin}`,
      };
    }

    // Verify the state root is recent and valid
    const isValid = await this.oracle.isValidStateRoot(inputs.stateRoot);
    if (!isValid) {
      return {
        valid: false,
        error: "State root is not recognized or too old (> 256 blocks)",
      };
    }

    // Verify nullifier is non-empty
    if (!inputs.nullifier || inputs.nullifier === "0x") {
      return { valid: false, error: "Nullifier must be non-empty" };
    }

    return { valid: true };
  }

  async verifyProof(proof: Uint8Array, publicInputs: PublicInputs): Promise<boolean> {
    return verifyProof(proof, publicInputs);
  }
}
