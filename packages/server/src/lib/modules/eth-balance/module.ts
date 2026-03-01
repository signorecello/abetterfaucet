import type { ProofModule, PublicInputs, ValidationResult } from "../types";
import type { StateRootOracle } from "../../state-root-oracle";
import { verifyProof } from "./verifier";

interface EthBalanceModuleOptions {
  epochDuration?: number;
  minBalance: bigint;
  chainId: number;
  chainName: string;
}

export class EthBalanceModule implements ProofModule {
  readonly id: string;
  readonly nullifierGroup = "eth-balance";
  readonly name: string;
  readonly description: string;
  readonly epochDurationSeconds: number;
  readonly originChainId: number;
  readonly originChainName: string;
  readonly minBalanceWei: bigint;

  private readonly oracle: StateRootOracle;

  constructor(oracle: StateRootOracle, options: EthBalanceModuleOptions) {
    this.oracle = oracle;
    this.id = `eth-balance:${options.chainId}`;
    this.name = `ETH Balance Proof (${options.chainName})`;
    this.description = `Proves ownership of sufficient ETH on ${options.chainName} without revealing the address`;
    this.epochDurationSeconds = options.epochDuration ?? 604_800;
    this.originChainId = options.chainId;
    this.originChainName = options.chainName;
    this.minBalanceWei = options.minBalance;
  }

  currentEpoch(): number {
    return Math.floor(Date.now() / 1000 / this.epochDurationSeconds);
  }

  async validatePublicInputs(inputs: PublicInputs): Promise<ValidationResult> {
    // Verify the epoch is current or immediately previous (tolerance for boundary submissions)
    const currentEpoch = this.currentEpoch();
    if (inputs.epoch > currentEpoch || inputs.epoch < currentEpoch - 1) {
      return {
        valid: false,
        error: `Epoch mismatch: expected ${currentEpoch} (±1), got ${inputs.epoch}`,
      };
    }

    // Verify the minimum balance matches the required amount
    const claimedMin = BigInt(inputs.minBalance);
    if (claimedMin < this.minBalanceWei) {
      return {
        valid: false,
        error: `Minimum balance too low: requires ${this.minBalanceWei}, got ${claimedMin}`,
      };
    }

    // Verify the state root matches the given block and is recent
    const isValid = await this.oracle.isValidStateRoot(inputs.stateRoot, BigInt(inputs.blockNumber));
    if (!isValid) {
      return {
        valid: false,
        error: "State root does not match the given block or block is too old (> 30 minutes)",
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
