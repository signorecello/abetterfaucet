#!/usr/bin/env bun
/**
 * Generates Prover.toml and prover_inputs.json for the ethereum_test circuit.
 *
 * Calls eth_getProof on a real network to obtain MPT account proof data.
 *
 * Usage:
 *   bun --env-file=../../.env run scripts/generate_prover_toml.ts
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import {
  createPublicClient,
  http,
  keccak256,
  toRlp,
  hexToBytes,
  numberToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// -- Constants matching the circuit --
const MAX_NODE_LEN = 532;
const MAX_ACCOUNT_LEAF_LEN = 148;
const MAX_ACCOUNT_STATE_LEN = 110;
const MAX_ACCOUNT_DEPTH = 10;
const MAX_PREFIXED_KEY_LEN = 66;

const testBinDir = resolve(import.meta.dir, "../../ethereum_test");

// -- Helpers --

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

/** Format a byte array as a TOML array: ["0x00", "0x01", ...] */
function bytesToTomlArray(bytes: Uint8Array): string {
  return (
    "[" +
    Array.from(bytes)
      .map((b) => `"0x${b.toString(16).padStart(2, "0")}"`)
      .join(", ") +
    "]"
  );
}

/** Convert a byte array to an array of decimal strings for noir_js. */
function bytesToDecimalStrings(bytes: Uint8Array): string[] {
  return Array.from(bytes).map((b) => b.toString());
}

// -- Main --

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.ORIGIN_RPC_URL;

  if (!privateKey) throw new Error("PRIVATE_KEY env var required");
  if (!rpcUrl) throw new Error("ORIGIN_RPC_URL env var required");

  console.error("Generating ethereum_test Prover.toml...\n");

  // 1. Derive address
  const account = privateKeyToAccount(privateKey as Hex);
  const address = account.address;
  console.error(`Address: ${address}`);

  // 2. Create client
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  // 3. Get latest block for state root
  const block = await client.getBlock({ blockTag: "latest" });
  const stateRoot = block.stateRoot;
  console.error(`Block: ${block.number}`);
  console.error(`State root: ${stateRoot}`);

  // 4. Get account proof
  const proof = await client.getProof({
    address,
    storageKeys: [],
    blockNumber: block.number,
  });

  console.error(`Balance: ${proof.balance} wei (${Number(proof.balance) / 1e18} ETH)`);
  console.error(`Nonce: ${proof.nonce}`);
  console.error(`Storage hash: ${proof.storageHash}`);
  console.error(`Code hash: ${proof.codeHash}`);
  console.error(`Account proof nodes: ${proof.accountProof.length}`);

  // 5. RLP-encode the account state: rlp([nonce, balance, storageRoot, codeHash])
  const nonceBytes = bigintToMinimalBytes(BigInt(proof.nonce));
  const balanceBytes = bigintToMinimalBytes(proof.balance);
  const storageHashBytes = hexToBytes(proof.storageHash as Hex);
  const codeHashBytes = hexToBytes(proof.codeHash as Hex);

  const accountRlpHex = toRlp([
    nonceBytes,
    balanceBytes,
    storageHashBytes,
    codeHashBytes,
  ]);
  const accountRlpBytes = hexToBytes(accountRlpHex as Hex);
  console.error(`Account RLP length: ${accountRlpBytes.length} bytes`);

  if (accountRlpBytes.length > MAX_ACCOUNT_STATE_LEN) {
    throw new Error(
      `Account RLP (${accountRlpBytes.length}) exceeds MAX_ACCOUNT_STATE_LEN (${MAX_ACCOUNT_STATE_LEN})`
    );
  }

  // 6. Process proof nodes
  const proofNodes = proof.accountProof.map((h) => hexToBytes(h as Hex));
  const numNodes = proofNodes.length;

  if (numNodes < 1) {
    throw new Error("Account proof must have at least 1 node");
  }
  if (numNodes > MAX_ACCOUNT_DEPTH + 1) {
    throw new Error(
      `Proof has ${numNodes} nodes, exceeds MAX_ACCOUNT_DEPTH+1 (${MAX_ACCOUNT_DEPTH + 1})`
    );
  }

  // Separate internal nodes and leaf
  const internalNodes = proofNodes.slice(0, -1);
  const leafNode = proofNodes[numNodes - 1];

  console.error(`Internal nodes: ${internalNodes.length}`);
  for (let i = 0; i < internalNodes.length; i++) {
    console.error(`  Node ${i}: ${internalNodes[i].length} bytes`);
    if (internalNodes[i].length > MAX_NODE_LEN) {
      throw new Error(
        `Internal node ${i} (${internalNodes[i].length} bytes) exceeds MAX_NODE_LEN (${MAX_NODE_LEN})`
      );
    }
  }
  console.error(`Leaf: ${leafNode.length} bytes`);
  if (leafNode.length > MAX_ACCOUNT_LEAF_LEN) {
    throw new Error(
      `Leaf node (${leafNode.length} bytes) exceeds MAX_ACCOUNT_LEAF_LEN (${MAX_ACCOUNT_LEAF_LEN})`
    );
  }

  // 7. Compute keccak256(address) for the key
  const addressBytes = hexToBytes(address as Hex);
  const addressHash = hexToBytes(keccak256(addressBytes) as Hex);
  console.error(`keccak256(address): 0x${Buffer.from(addressHash).toString("hex")}`);

  // 8. Build padded arrays
  const depth = numNodes;

  // Key: left-pad to 66 bytes (last 32 bytes = address hash)
  const proofKey = padLeft(addressHash, MAX_PREFIXED_KEY_LEN);

  // Value: left-pad RLP to 110 bytes
  const proofValue = padLeft(accountRlpBytes, MAX_ACCOUNT_STATE_LEN);

  // Nodes: pad each to 532 bytes, fill remaining slots with zeros
  const paddedNodes: Uint8Array[] = [];
  for (let i = 0; i < MAX_ACCOUNT_DEPTH; i++) {
    if (i < internalNodes.length) {
      paddedNodes.push(padRight(internalNodes[i], MAX_NODE_LEN));
    } else {
      paddedNodes.push(new Uint8Array(MAX_NODE_LEN));
    }
  }

  // Leaf: pad to 148 bytes
  const paddedLeaf = padRight(leafNode, MAX_ACCOUNT_LEAF_LEN);

  // State root bytes
  const stateRootBytes = hexToBytes(stateRoot as Hex);

  // 9. Verify: keccak256 of the first proof node should match state_root
  const firstNodeHash = keccak256(proofNodes[0]);
  if (firstNodeHash.toLowerCase() !== stateRoot.toLowerCase()) {
    console.error(`WARNING: keccak256(accountProof[0]) != stateRoot`);
    console.error(`  hash:       ${firstNodeHash}`);
    console.error(`  stateRoot:  ${stateRoot}`);
  } else {
    console.error(`Verified: keccak256(accountProof[0]) == stateRoot`);
  }

  // 10. Generate Prover.toml
  const tomlLines: string[] = [];
  tomlLines.push(`# Generated by generate_prover_toml.ts`);
  tomlLines.push(`# Address: ${address}`);
  tomlLines.push(`# Block: ${block.number}`);
  tomlLines.push(`# Balance: ${proof.balance} wei`);
  tomlLines.push(``);
  tomlLines.push(`address = ${bytesToTomlArray(addressBytes)}`);
  tomlLines.push(`state_root = ${bytesToTomlArray(stateRootBytes)}`);
  tomlLines.push(`proof_key = ${bytesToTomlArray(proofKey)}`);
  tomlLines.push(`proof_value = ${bytesToTomlArray(proofValue)}`);
  tomlLines.push(`proof_leaf = ${bytesToTomlArray(paddedLeaf)}`);
  tomlLines.push(`proof_depth = "${depth}"`);
  tomlLines.push(`expected_balance = "${proof.balance}"`);

  // 2D array for proof_nodes: each inner array on its own line
  const nodesLines = paddedNodes.map((n) => `  ${bytesToTomlArray(n)}`);
  tomlLines.push(`proof_nodes = [\n${nodesLines.join(",\n")}\n]`);

  const toml = tomlLines.join("\n") + "\n";

  // Write Prover.toml
  const proverTomlPath = resolve(testBinDir, "Prover.toml");
  writeFileSync(proverTomlPath, toml);
  console.error(`\nWrote ${proverTomlPath} (${toml.length} bytes)`);

  // 11. Generate prover_inputs.json (for noir_js prove.ts)
  const inputs: Record<string, any> = {
    address: bytesToDecimalStrings(addressBytes),
    state_root: bytesToDecimalStrings(stateRootBytes),
    proof_key: bytesToDecimalStrings(proofKey),
    proof_value: bytesToDecimalStrings(proofValue),
    proof_nodes: paddedNodes.map((n) => bytesToDecimalStrings(n)),
    proof_leaf: bytesToDecimalStrings(paddedLeaf),
    proof_depth: depth.toString(),
    expected_balance: proof.balance.toString(),
  };

  const jsonPath = resolve(testBinDir, "prover_inputs.json");
  writeFileSync(jsonPath, JSON.stringify(inputs, null, 2));
  console.error(`Wrote ${jsonPath}`);

  console.error("\nDone!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
