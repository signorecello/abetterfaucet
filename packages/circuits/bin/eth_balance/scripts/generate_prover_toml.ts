#!/usr/bin/env bun
/**
 * Generates a valid Prover.toml for the eth_balance circuit.
 *
 * Fetches a real Ethereum account proof via eth_getProof and produces all
 * inputs needed for the circuit including MPT proof data.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ORIGIN_RPC_URL=https://... bun run scripts/generate_prover_toml.ts
 *
 * Or load from project .env:
 *   bun --env-file=../../.env run scripts/generate_prover_toml.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  toRlp,
  hexToBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as secp256k1 from "@noble/secp256k1";
import { BarretenbergSync, Fr } from "@aztec/bb.js";

// --- Config ---
const EPOCH_DURATION = 604_800; // 1 week in seconds
if (!process.env.MIN_BALANCE_WEI) {
  throw new Error("Missing MIN_BALANCE_WEI env var");
}
const MIN_BALANCE_WEI = BigInt(process.env.MIN_BALANCE_WEI);

// Circuit constants (must match lib/ethereum)
const MAX_NODE_LEN = 532;
const MAX_ACCOUNT_LEAF_LEN = 148;
const MAX_ACCOUNT_STATE_LEN = 110;
const MAX_ACCOUNT_DEPTH = 10;
const MAX_PREFIXED_KEY_LEN = 66;

// --- Helpers ---
function bytesToTomlArray(bytes: Uint8Array): string {
  return `[${Array.from(bytes).map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ")}]`;
}

function fieldToDecimalString(f: bigint): string {
  return `"${f.toString()}"`;
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.padStart(64, "0");
  return Uint8Array.from(Buffer.from(padded, "hex"));
}

/** Convert a bigint to its minimal big-endian byte representation (0 => empty). */
function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([]);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? "0" + hex : hex;
  return hexToBytes(`0x${padded}` as Hex);
}

/** Right-pad a byte array with zeros to targetLen. */
function padRight(data: Uint8Array, targetLen: number): Uint8Array {
  const result = new Uint8Array(targetLen);
  result.set(data.slice(0, Math.min(data.length, targetLen)));
  return result;
}

/** Left-pad a byte array with zeros to targetLen. */
function padLeft(data: Uint8Array, targetLen: number): Uint8Array {
  if (data.length >= targetLen) return data.slice(0, targetLen);
  const result = new Uint8Array(targetLen);
  result.set(data, targetLen - data.length);
  return result;
}

// --- Main ---
async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.ORIGIN_RPC_URL;

  if (!privateKey) throw new Error("PRIVATE_KEY env var required");
  if (!rpcUrl) throw new Error("ORIGIN_RPC_URL env var required");

  console.error("Generating Prover.toml...\n");

  // 1. Derive account from private key
  const account = privateKeyToAccount(privateKey as Hex);
  console.error(`Address: ${account.address}`);

  // 2. Derive raw public key from private key
  const privKeyBytes = hexToBytes32(privateKey);
  const pubKeyUncompressed = secp256k1.getPublicKey(privKeyBytes, false);
  // pubKeyUncompressed is 65 bytes: 0x04 || x (32) || y (32)
  const pubkey_x = pubKeyUncompressed.slice(1, 33);
  const pubkey_y = pubKeyUncompressed.slice(33, 65);
  console.error(`PubKey X: 0x${Buffer.from(pubkey_x).toString("hex")}`);
  console.error(`PubKey Y: 0x${Buffer.from(pubkey_y).toString("hex")}`);

  // Verify: keccak256(pubkey_x || pubkey_y)[12..32] == address
  const pubkeyConcat = new Uint8Array(64);
  pubkeyConcat.set(pubkey_x, 0);
  pubkeyConcat.set(pubkey_y, 32);
  const addrHash = keccak256(pubkeyConcat);
  const derivedAddr = `0x${addrHash.slice(26)}`;
  console.error(`Derived address: ${derivedAddr}`);
  if (derivedAddr.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Address mismatch: derived=${derivedAddr} vs account=${account.address}`);
  }

  // 3. Compute epoch
  const epoch = BigInt(Math.floor(Date.now() / 1000 / EPOCH_DURATION));
  console.error(`Epoch: ${epoch}`);

  // 4. Sign domain message (epoch zero-padded to 10 digits for fixed-length format)
  const epochStr = epoch.toString().padStart(10, "0");
  const domainMsg = `zk_faucet_v1:eth-balance:nullifier_seed:${epochStr}`;
  console.error(`Domain message: "${domainMsg}" (${domainMsg.length} bytes)`);

  // personal_sign: sign the raw string (viem handles EIP-191 prefix)
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const signature = await walletClient.signMessage({ message: domainMsg });
  console.error(`Signature: ${signature}`);

  // Parse r, s, v from signature
  const sigBytes = toBytes(signature);
  const sig_r = sigBytes.slice(0, 32);
  const sig_s = sigBytes.slice(32, 64);
  const v = sigBytes[64];
  console.error(`v: ${v}`);

  // 5. Fetch account proof via eth_getProof
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  const block = await publicClient.getBlock({ blockTag: "latest" });
  console.error(`Block: ${block.number}`);
  console.error(`State root: ${block.stateRoot}`);

  const ethProof = await publicClient.getProof({
    address: account.address,
    storageKeys: [],
    blockNumber: block.number,
  });

  const balance = ethProof.balance;
  console.error(`Balance: ${balance} wei (${Number(balance) / 1e18} ETH)`);
  console.error(`Nonce: ${ethProof.nonce}`);
  console.error(`Account proof nodes: ${ethProof.accountProof.length}`);

  if (balance < MIN_BALANCE_WEI) {
    console.error(`WARNING: Balance ${balance} < min_balance ${MIN_BALANCE_WEI}`);
  }

  // 7. RLP-encode the account state: rlp([nonce, balance, storageRoot, codeHash])
  const nonceBytes = bigintToMinimalBytes(BigInt(ethProof.nonce));
  const balanceBytes = bigintToMinimalBytes(balance);
  const storageHashBytes = hexToBytes(ethProof.storageHash as Hex);
  const codeHashBytes = hexToBytes(ethProof.codeHash as Hex);

  const accountRlpHex = toRlp([nonceBytes, balanceBytes, storageHashBytes, codeHashBytes]);
  const accountRlpBytes = hexToBytes(accountRlpHex as Hex);
  console.error(`Account RLP length: ${accountRlpBytes.length} bytes`);

  if (accountRlpBytes.length > MAX_ACCOUNT_STATE_LEN) {
    throw new Error(`Account RLP (${accountRlpBytes.length}) exceeds MAX_ACCOUNT_STATE_LEN (${MAX_ACCOUNT_STATE_LEN})`);
  }

  // 8. Process proof nodes: separate internal nodes from leaf
  const proofNodes = ethProof.accountProof.map((h) => hexToBytes(h as Hex));
  const numNodes = proofNodes.length;

  if (numNodes < 1) throw new Error("Account proof must have at least 1 node");
  if (numNodes > MAX_ACCOUNT_DEPTH + 1) {
    throw new Error(`Proof has ${numNodes} nodes, exceeds MAX_ACCOUNT_DEPTH+1 (${MAX_ACCOUNT_DEPTH + 1})`);
  }

  const internalNodes = proofNodes.slice(0, -1);
  const leafNode = proofNodes[numNodes - 1];

  console.error(`Internal nodes: ${internalNodes.length}`);
  for (let i = 0; i < internalNodes.length; i++) {
    console.error(`  Node ${i}: ${internalNodes[i].length} bytes`);
    if (internalNodes[i].length > MAX_NODE_LEN) {
      throw new Error(`Internal node ${i} (${internalNodes[i].length} bytes) exceeds MAX_NODE_LEN (${MAX_NODE_LEN})`);
    }
  }
  console.error(`Leaf: ${leafNode.length} bytes`);
  if (leafNode.length > MAX_ACCOUNT_LEAF_LEN) {
    throw new Error(`Leaf node (${leafNode.length} bytes) exceeds MAX_ACCOUNT_LEAF_LEN (${MAX_ACCOUNT_LEAF_LEN})`);
  }

  // 9. Build padded arrays for circuit inputs
  const addressBytes = toBytes(account.address);
  const addressHash = hexToBytes(keccak256(addressBytes) as Hex);
  const stateRootBytes = hexToBytes(block.stateRoot as Hex);
  const depth = numNodes;

  // Key: left-pad keccak256(address) to MAX_PREFIXED_KEY_LEN bytes
  const proofKey = padLeft(addressHash, MAX_PREFIXED_KEY_LEN);

  // Value: left-pad RLP to MAX_ACCOUNT_STATE_LEN bytes
  const proofValue = padLeft(accountRlpBytes, MAX_ACCOUNT_STATE_LEN);

  // Nodes: pad each to MAX_NODE_LEN, fill remaining slots with zeros
  const paddedNodes: Uint8Array[] = [];
  for (let i = 0; i < MAX_ACCOUNT_DEPTH; i++) {
    if (i < internalNodes.length) {
      paddedNodes.push(padRight(internalNodes[i], MAX_NODE_LEN));
    } else {
      paddedNodes.push(new Uint8Array(MAX_NODE_LEN));
    }
  }

  // Leaf: pad to MAX_ACCOUNT_LEAF_LEN
  const paddedLeaf = padRight(leafNode, MAX_ACCOUNT_LEAF_LEN);

  // Verify: keccak256(first proof node) should match state_root
  const firstNodeHash = keccak256(proofNodes[0]);
  if (firstNodeHash.toLowerCase() !== block.stateRoot.toLowerCase()) {
    console.error(`WARNING: keccak256(accountProof[0]) != stateRoot`);
    console.error(`  hash:       ${firstNodeHash}`);
    console.error(`  stateRoot:  ${block.stateRoot}`);
  } else {
    console.error(`Verified: keccak256(accountProof[0]) == stateRoot`);
  }

  // 10. Compute Poseidon2 nullifier using bb.js
  console.error("\nInitializing Barretenberg for Poseidon2...");
  const bb = await BarretenbergSync.initSingleton();

  // Convert pubkey coordinates to Field elements (big-endian, reduced mod BN254 p)
  const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const pubkey_x_bigint = BigInt(`0x${Buffer.from(pubkey_x).toString("hex")}`) % BN254_MODULUS;
  const pubkey_y_bigint = BigInt(`0x${Buffer.from(pubkey_y).toString("hex")}`) % BN254_MODULUS;
  console.error(`PubKey X (field): ${pubkey_x_bigint}`);
  console.error(`PubKey Y (field): ${pubkey_y_bigint}`);

  const nullifier_fr = bb.poseidon2Hash([
    new Fr(pubkey_x_bigint),
    new Fr(pubkey_y_bigint),
    new Fr(epoch),
  ]);
  const nullifier_hex = nullifier_fr.toString();
  const nullifier_bigint = BigInt(nullifier_hex);
  console.error(`Nullifier: ${nullifier_bigint}`);

  // 11. Write Prover.toml
  const tomlLines: string[] = [];
  tomlLines.push(`# Generated by generate_prover_toml.ts`);
  tomlLines.push(`# Address: ${account.address}`);
  tomlLines.push(`# Block: ${block.number}`);
  tomlLines.push(`# Epoch: ${epoch}`);
  tomlLines.push(`# Balance: ${balance} wei`);
  tomlLines.push(``);
  tomlLines.push(`# Private inputs`);
  tomlLines.push(`sig_r = ${bytesToTomlArray(sig_r)}`);
  tomlLines.push(`sig_s = ${bytesToTomlArray(sig_s)}`);
  tomlLines.push(`pubkey_x = ${bytesToTomlArray(pubkey_x)}`);
  tomlLines.push(`pubkey_y = ${bytesToTomlArray(pubkey_y)}`);
  tomlLines.push(`address = ${bytesToTomlArray(addressBytes)}`);
  tomlLines.push(``);
  tomlLines.push(`# Account fields (private, verified against MPT proof by eth-proofs)`);
  tomlLines.push(`account_nonce = "${ethProof.nonce}"`);
  tomlLines.push(`account_balance = ${fieldToDecimalString(balance)}`);
  tomlLines.push(`account_storage_root = ${bytesToTomlArray(storageHashBytes)}`);
  tomlLines.push(`account_code_hash = ${bytesToTomlArray(codeHashBytes)}`);
  tomlLines.push(``);
  tomlLines.push(`# MPT proof data (private)`);
  tomlLines.push(`proof_key = ${bytesToTomlArray(proofKey)}`);
  tomlLines.push(`proof_value = ${bytesToTomlArray(proofValue)}`);
  tomlLines.push(`proof_leaf = ${bytesToTomlArray(paddedLeaf)}`);
  tomlLines.push(`proof_depth = "${depth}"`);

  // 2D array for proof_nodes
  const nodesLines = paddedNodes.map((n) => `  ${bytesToTomlArray(n)}`);
  tomlLines.push(`proof_nodes = [\n${nodesLines.join(",\n")}\n]`);

  tomlLines.push(``);
  tomlLines.push(`# Public inputs`);
  tomlLines.push(`state_root = ${bytesToTomlArray(stateRootBytes)}`);
  tomlLines.push(`epoch = ${fieldToDecimalString(epoch)}`);
  tomlLines.push(`min_balance = ${fieldToDecimalString(MIN_BALANCE_WEI)}`);
  tomlLines.push(`nullifier = ${fieldToDecimalString(nullifier_bigint)}`);

  const toml = tomlLines.join("\n") + "\n";

  // Write to stdout (redirect to Prover.toml)
  console.log(toml);
  console.error("\nDone! Pipe stdout to Prover.toml:");
  console.error("  bun run scripts/generate_prover_toml.ts > Prover.toml");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
