import { readFileSync } from "fs";
import { resolve } from "path";
import { UltraHonkBackend } from "@aztec/bb.js";
import type { PublicInputs } from "../types";

/**
 * Path to the compiled circuit artifact (eth_balance.json).
 * Configurable via CIRCUIT_ARTIFACT_PATH env var; defaults to the
 * monorepo-relative path from project root.
 */
const CIRCUIT_ARTIFACT_PATH =
  process.env.CIRCUIT_ARTIFACT_PATH ??
  resolve(
    process.cwd(),
    "packages/circuits/bin/eth_balance/target/eth_balance.json",
  );

/** Cached backend singleton -- initialized lazily on first verification. */
let backendInstance: UltraHonkBackend | null = null;

async function getBackend(): Promise<UltraHonkBackend> {
  if (backendInstance) return backendInstance;

  const circuitJson = JSON.parse(readFileSync(CIRCUIT_ARTIFACT_PATH, "utf-8"));
  backendInstance = new UltraHonkBackend(circuitJson.bytecode);
  return backendInstance;
}

/**
 * Verifies a ZK proof using the Barretenberg UltraHonk WASM backend.
 *
 * The proof attests that the prover holds >= minBalance ETH at the given
 * state root, and derives a deterministic nullifier for double-claim prevention.
 */
export async function verifyProof(
  proof: Uint8Array,
  publicInputs: PublicInputs,
): Promise<boolean> {
  const publicInputFields = encodePublicInputs(publicInputs);
  const backend = await getBackend();
  return backend.verifyProof({ proof, publicInputs: publicInputFields });
}

/**
 * Encodes structured public inputs into an ordered array of 35 hex-encoded
 * field elements matching the circuit's public input layout:
 *   [0..31]  = state_root bytes (32 individual byte fields)
 *   [32]     = epoch
 *   [33]     = min_balance
 *   [34]     = nullifier
 */
export function encodePublicInputs(inputs: PublicInputs): string[] {
  const fields: string[] = [];

  // Split stateRoot into 32 individual byte fields
  const stateRootHex = inputs.stateRoot.startsWith("0x")
    ? inputs.stateRoot.slice(2)
    : inputs.stateRoot;
  for (let i = 0; i < 32; i++) {
    const byteHex = stateRootHex.slice(i * 2, i * 2 + 2);
    const byteVal = parseInt(byteHex, 16);
    fields.push("0x" + byteVal.toString(16).padStart(64, "0"));
  }

  // epoch as field
  fields.push("0x" + inputs.epoch.toString(16).padStart(64, "0"));

  // minBalance as field
  fields.push("0x" + BigInt(inputs.minBalance).toString(16).padStart(64, "0"));

  // nullifier as field
  const nullifierHex = inputs.nullifier.startsWith("0x")
    ? inputs.nullifier.slice(2)
    : inputs.nullifier;
  fields.push("0x" + nullifierHex.padStart(64, "0"));

  return fields; // 35 fields total
}

/**
 * Reset the cached backend (for testing).
 */
export function resetBackend(): void {
  backendInstance = null;
}
