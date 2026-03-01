export interface ProofModule {
  id: string;
  nullifierGroup: string;
  name: string;
  description: string;
  originChainId?: number;
  originChainName?: string;
  minBalanceWei?: bigint;
  validatePublicInputs(inputs: PublicInputs): Promise<ValidationResult>;
  verifyProof(proof: Uint8Array, publicInputs: PublicInputs): Promise<boolean>;
  currentEpoch(): number;
  epochDurationSeconds: number;
}

export interface PublicInputs {
  stateRoot: string;
  epoch: number;
  minBalance: string;
  nullifier: string;
  blockNumber: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}
