// In-browser ZK proof generation using noir_js + bb.js (WASM)
// Privacy-critical: private inputs never leave the browser.

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, BarretenbergSync, Fr } from '@aztec/bb.js';
import {
  keccak256,
  toRlp,
  hexToBytes,
  hashMessage,
  recoverPublicKey as viemRecoverPublicKey,
  type Hex,
} from 'viem';
import type { StorageProofResponse } from './api';

// Circuit constants (must match lib/ethereum)
const MAX_NODE_LEN = 532;
const MAX_ACCOUNT_LEAF_LEN = 148;
const MAX_ACCOUNT_STATE_LEN = 110;
const MAX_ACCOUNT_DEPTH = 10;
const MAX_PREFIXED_KEY_LEN = 66;
const BN254_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface ProofResult {
  proof: string; // 0x-prefixed hex
  publicInputs: {
    stateRoot: string; // 0x-prefixed hex
    epoch: number;
    minBalance: string; // decimal string
    nullifier: string; // decimal string
    blockNumber: string; // decimal string
  };
}

export type ProgressCallback = (step: string, detail?: string) => void;

export function padRight(data: Uint8Array, targetLen: number): Uint8Array {
  const result = new Uint8Array(targetLen);
  result.set(data.subarray(0, Math.min(data.length, targetLen)));
  return result;
}

export function padLeft(data: Uint8Array, targetLen: number): Uint8Array {
  if (data.length >= targetLen) return data.subarray(0, targetLen);
  const result = new Uint8Array(targetLen);
  result.set(data, targetLen - data.length);
  return result;
}

export function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([]);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? '0' + hex : hex;
  return hexToBytes(`0x${padded}` as Hex);
}

export function bytesToInputArray(bytes: Uint8Array): string[] {
  return Array.from(bytes).map((b) => b.toString());
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateProofInBrowser(
  circuitArtifact: any,
  storageProof: StorageProofResponse,
  signature: string,
  address: string,
  epoch: number,
  minBalance: bigint,
  onProgress?: ProgressCallback,
): Promise<ProofResult> {
  const progress = onProgress ?? (() => {});

  progress('Preparing inputs...', 'Parsing signature and storage proof');

  const sigBytes = hexToBytes(signature as Hex);
  if (sigBytes.length !== 65) {
    throw new Error(`Signature must be 65 bytes, got ${sigBytes.length}`);
  }
  const sig_r = sigBytes.slice(0, 32);
  const sig_s = sigBytes.slice(32, 64);

  const addressBytes = hexToBytes(address as Hex);
  const addressHash = hexToBytes(keccak256(addressBytes) as Hex);
  const stateRootBytes = hexToBytes(storageProof.stateRoot as Hex);

  const nonceBytes = bigintToMinimalBytes(BigInt(storageProof.nonce));
  const balanceBytes = bigintToMinimalBytes(BigInt(storageProof.balance));
  const storageHashBytes = hexToBytes(storageProof.storageHash as Hex);
  const codeHashBytes = hexToBytes(storageProof.codeHash as Hex);

  const accountRlpHex = toRlp([nonceBytes, balanceBytes, storageHashBytes, codeHashBytes]);
  const accountRlpBytes = hexToBytes(accountRlpHex as Hex);

  if (accountRlpBytes.length > MAX_ACCOUNT_STATE_LEN) {
    throw new Error(
      `Account RLP (${accountRlpBytes.length}) exceeds max (${MAX_ACCOUNT_STATE_LEN})`,
    );
  }

  const proofNodes = storageProof.accountProof.map((h: string) => hexToBytes(h as Hex));
  const numNodes = proofNodes.length;

  if (numNodes < 1) {
    throw new Error('Account proof must have at least 1 node');
  }
  if (numNodes > MAX_ACCOUNT_DEPTH + 1) {
    throw new Error(`Proof has ${numNodes} nodes, exceeds max ${MAX_ACCOUNT_DEPTH + 1}`);
  }

  const internalNodes = proofNodes.slice(0, -1);
  const leafNode = proofNodes[numNodes - 1];

  for (let i = 0; i < internalNodes.length; i++) {
    if (internalNodes[i].length > MAX_NODE_LEN) {
      throw new Error(
        `Internal node ${i} (${internalNodes[i].length} bytes) exceeds max (${MAX_NODE_LEN})`,
      );
    }
  }

  if (leafNode.length > MAX_ACCOUNT_LEAF_LEN) {
    throw new Error(
      `Leaf node (${leafNode.length} bytes) exceeds max (${MAX_ACCOUNT_LEAF_LEN})`,
    );
  }

  const proofKey = padLeft(addressHash, MAX_PREFIXED_KEY_LEN);
  const proofValue = padLeft(accountRlpBytes, MAX_ACCOUNT_STATE_LEN);
  const depth = numNodes;

  const paddedNodes: Uint8Array[] = [];
  for (let i = 0; i < MAX_ACCOUNT_DEPTH; i++) {
    if (i < internalNodes.length) {
      paddedNodes.push(padRight(internalNodes[i], MAX_NODE_LEN));
    } else {
      paddedNodes.push(new Uint8Array(MAX_NODE_LEN));
    }
  }
  const paddedLeaf = padRight(leafNode, MAX_ACCOUNT_LEAF_LEN);

  progress('Recovering public key...', 'Verifying signature matches address');

  const epochStr = epoch.toString().padStart(10, '0');
  const domainMsg = `zk_faucet_v1:eth-balance:nullifier_seed:${epochStr}`;
  const messageHash = hashMessage(domainMsg);

  let pubKeyHex: Hex;
  try {
    pubKeyHex = await viemRecoverPublicKey({
      hash: messageHash,
      signature: signature as Hex,
    });
  } catch (_err) {
    throw new Error('Failed to recover public key from signature');
  }

  const pubKeyBytes = hexToBytes(pubKeyHex as Hex);
  const pubkey_x = pubKeyBytes.slice(1, 33);
  const pubkey_y = pubKeyBytes.slice(33, 65);

  const pubkeyConcat = new Uint8Array(64);
  pubkeyConcat.set(pubkey_x, 0);
  pubkeyConcat.set(pubkey_y, 32);
  const recoveredAddrHash = keccak256(pubkeyConcat);
  const recoveredAddr = `0x${recoveredAddrHash.slice(26)}`;
  if (recoveredAddr.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Recovered address ${recoveredAddr} does not match ${address}`);
  }

  progress('Computing nullifier...', 'Initializing Barretenberg WASM');

  const bb = await BarretenbergSync.initSingleton();
  const pubkey_x_bigint = BigInt(`0x${bytesToHex(pubkey_x)}`) % BN254_MODULUS;
  const pubkey_y_bigint = BigInt(`0x${bytesToHex(pubkey_y)}`) % BN254_MODULUS;
  const nullifier_fr = bb.poseidon2Hash([
    new Fr(pubkey_x_bigint),
    new Fr(pubkey_y_bigint),
    new Fr(BigInt(epoch)),
  ]);
  const nullifier_bigint = BigInt(nullifier_fr.toString());

  const inputs: Record<string, any> = {
    sig_r: bytesToInputArray(sig_r),
    sig_s: bytesToInputArray(sig_s),
    pubkey_x: bytesToInputArray(pubkey_x),
    pubkey_y: bytesToInputArray(pubkey_y),
    address: bytesToInputArray(addressBytes),
    account_nonce: storageProof.nonce.toString(),
    account_balance: BigInt(storageProof.balance).toString(),
    account_storage_root: bytesToInputArray(storageHashBytes),
    account_code_hash: bytesToInputArray(codeHashBytes),
    proof_key: bytesToInputArray(proofKey),
    proof_value: bytesToInputArray(proofValue),
    proof_nodes: paddedNodes.map(bytesToInputArray),
    proof_leaf: bytesToInputArray(paddedLeaf),
    proof_depth: depth.toString(),
    state_root: bytesToInputArray(stateRootBytes),
    epoch: epoch.toString(),
    min_balance: minBalance.toString(),
    nullifier: nullifier_bigint.toString(),
  };

  progress('Generating witness...', 'Executing circuit logic');

  const noir = new Noir(circuitArtifact);

  let witness: Uint8Array;
  try {
    const result = await noir.execute(inputs);
    witness = result.witness;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Witness generation failed: ${msg}`);
  }

  progress('Computing ZK proof...', 'This may take 60-90 seconds. Please keep this tab open.');

  const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1;
  const backend = new UltraHonkBackend(circuitArtifact.bytecode, { threads });

  let proof: { proof: Uint8Array; publicInputs: string[] };
  try {
    const startTime = Date.now();
    proof = await backend.generateProof(witness);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[zk_faucet] Proof generated in ${elapsed}s, size: ${proof.proof.length} bytes`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Proof generation failed: ${msg}`);
  }

  const stateRootHex = '0x' + bytesToHex(stateRootBytes);
  const proofHex =
    '0x' +
    Array.from(proof.proof)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  return {
    proof: proofHex,
    publicInputs: {
      stateRoot: stateRootHex,
      epoch,
      minBalance: minBalance.toString(),
      nullifier: '0x' + nullifier_bigint.toString(16),
      blockNumber: storageProof.blockNumber,
    },
  };
}
