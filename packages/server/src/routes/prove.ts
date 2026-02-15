import { Hono } from "hono";
import * as v from "valibot";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import {
  keccak256,
  toRlp,
  hexToBytes,
  type Hex,
} from "viem";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, BarretenbergSync, Fr } from "@aztec/bb.js";
import { AppError } from "../util/errors";
import type { Logger } from "../util/logger";

// Circuit constants (must match lib/ethereum)
const MAX_NODE_LEN = 532;
const MAX_ACCOUNT_LEAF_LEN = 148;
const MAX_ACCOUNT_STATE_LEN = 110;
const MAX_ACCOUNT_DEPTH = 10;
const MAX_PREFIXED_KEY_LEN = 66;
const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Validation schema for the prove request
const ProveRequestSchema = v.object({
  // Signature components (hex-encoded, from personal_sign)
  signature: v.pipe(
    v.string(),
    v.regex(/^0x[0-9a-fA-F]+$/, "Must be a hex string"),
  ),
  // User's Ethereum address
  address: v.pipe(
    v.string(),
    v.regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid Ethereum address"),
  ),
  // Storage proof data from eth_getProof
  storageProof: v.object({
    balance: v.string(), // decimal string
    nonce: v.string(), // decimal string
    codeHash: v.pipe(v.string(), v.regex(/^0x[0-9a-fA-F]+$/)),
    storageHash: v.pipe(v.string(), v.regex(/^0x[0-9a-fA-F]+$/)),
    accountProof: v.array(v.pipe(v.string(), v.regex(/^0x[0-9a-fA-F]+$/))),
    stateRoot: v.pipe(v.string(), v.regex(/^0x[0-9a-fA-F]+$/)),
  }),
  // Current epoch
  epoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export interface ProveDeps {
  logger: Logger;
}

/** Cached circuit artifact */
let circuitJson: any = null;

function getCircuitArtifact(): any {
  if (circuitJson) return circuitJson;
  const artifactPath =
    process.env.CIRCUIT_ARTIFACT_PATH ??
    resolve(
      import.meta.dir,
      "../../../circuits/bin/eth_balance/target/eth_balance.json",
    );
  if (!existsSync(artifactPath)) {
    throw AppError.notFound(
      `Circuit artifact not found. Run 'nargo compile' to generate it.`,
    );
  }
  circuitJson = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return circuitJson;
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

/** Convert a bigint to its minimal big-endian byte representation. */
function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([]);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? "0" + hex : hex;
  return hexToBytes(`0x${padded}` as Hex);
}

/** Convert bytes to array of decimal strings (for noir_js input format). */
function bytesToInputArray(bytes: Uint8Array): string[] {
  return Array.from(bytes).map((b) => b.toString());
}

export function createProveRouter(deps: ProveDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parseResult = v.safeParse(ProveRequestSchema, body);
    if (!parseResult.success) {
      const issues = parseResult.issues.map((i) => i.message).join("; ");
      throw AppError.invalidPublicInputs(issues);
    }

    const { signature, address, storageProof, epoch } = parseResult.output;

    deps.logger.info({ address, epoch }, "Delegated proof generation requested");

    // Parse signature: r (32) + s (32) + v (1) = 65 bytes
    const sigBytes = hexToBytes(signature as Hex);
    if (sigBytes.length !== 65) {
      throw AppError.invalidPublicInputs(`Signature must be 65 bytes, got ${sigBytes.length}`);
    }
    const sig_r = sigBytes.slice(0, 32);
    const sig_s = sigBytes.slice(32, 64);

    // Parse address
    const addressBytes = hexToBytes(address as Hex);

    // Compute address hash for MPT key
    const addressHash = hexToBytes(keccak256(addressBytes) as Hex);

    // Parse state root
    const stateRootBytes = hexToBytes(storageProof.stateRoot as Hex);

    // RLP-encode the account state: rlp([nonce, balance, storageRoot, codeHash])
    const nonceBytes = bigintToMinimalBytes(BigInt(storageProof.nonce));
    const balanceBytes = bigintToMinimalBytes(BigInt(storageProof.balance));
    const storageHashBytes = hexToBytes(storageProof.storageHash as Hex);
    const codeHashBytes = hexToBytes(storageProof.codeHash as Hex);

    const accountRlpHex = toRlp([
      nonceBytes,
      balanceBytes,
      storageHashBytes,
      codeHashBytes,
    ]);
    const accountRlpBytes = hexToBytes(accountRlpHex as Hex);

    if (accountRlpBytes.length > MAX_ACCOUNT_STATE_LEN) {
      throw AppError.invalidPublicInputs(
        `Account RLP (${accountRlpBytes.length}) exceeds max (${MAX_ACCOUNT_STATE_LEN})`,
      );
    }

    // Process proof nodes
    const proofNodes = storageProof.accountProof.map((h: string) =>
      hexToBytes(h as Hex),
    );
    const numNodes = proofNodes.length;

    if (numNodes < 1) {
      throw AppError.invalidPublicInputs("Account proof must have at least 1 node");
    }
    if (numNodes > MAX_ACCOUNT_DEPTH + 1) {
      throw AppError.invalidPublicInputs(
        `Proof has ${numNodes} nodes, exceeds max ${MAX_ACCOUNT_DEPTH + 1}`,
      );
    }

    const internalNodes = proofNodes.slice(0, -1);
    const leafNode = proofNodes[numNodes - 1];

    for (let i = 0; i < internalNodes.length; i++) {
      if (internalNodes[i].length > MAX_NODE_LEN) {
        throw AppError.invalidPublicInputs(
          `Internal node ${i} (${internalNodes[i].length} bytes) exceeds max (${MAX_NODE_LEN})`,
        );
      }
    }

    if (leafNode.length > MAX_ACCOUNT_LEAF_LEN) {
      throw AppError.invalidPublicInputs(
        `Leaf node (${leafNode.length} bytes) exceeds max (${MAX_ACCOUNT_LEAF_LEN})`,
      );
    }

    // Build padded arrays for circuit inputs
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

    // Recover public key from signature using ecrecover
    // We need pubkey_x and pubkey_y. Since the frontend sends the signature
    // and address, we need to recover the public key.
    // We'll use @noble/secp256k1 for recovery.
    const { recoverPublicKey } = await import("@noble/secp256k1");

    // Compute the EIP-191 message hash (same as the circuit does)
    const epochStr = epoch.toString().padStart(10, "0");
    const domainMsg = `zk_faucet_v1:eth-balance:nullifier_seed:${epochStr}`;
    const eip191Prefix = `\x19Ethereum Signed Message:\n${domainMsg.length}`;
    const fullMessage = eip191Prefix + domainMsg;
    const msgBytes = new TextEncoder().encode(fullMessage);
    const messageHash = hexToBytes(keccak256(msgBytes) as Hex);

    // Recovery: v is 27 or 28 for EIP-191, or 0/1 directly
    const v = sigBytes[64];
    const recoveryBit = v >= 27 ? v - 27 : v;

    const sigCompact = new Uint8Array(64);
    sigCompact.set(sig_r, 0);
    sigCompact.set(sig_s, 32);

    let pubKeyUncompressed: Uint8Array;
    try {
      pubKeyUncompressed = recoverPublicKey(messageHash, sigCompact, recoveryBit, false);
    } catch (err) {
      throw AppError.invalidPublicInputs("Failed to recover public key from signature");
    }

    // pubKeyUncompressed is 65 bytes: 0x04 || x (32) || y (32)
    const pubkey_x = pubKeyUncompressed.slice(1, 33);
    const pubkey_y = pubKeyUncompressed.slice(33, 65);

    // Verify recovered address matches
    const pubkeyConcat = new Uint8Array(64);
    pubkeyConcat.set(pubkey_x, 0);
    pubkeyConcat.set(pubkey_y, 32);
    const recoveredAddrHash = keccak256(pubkeyConcat);
    const recoveredAddr = `0x${recoveredAddrHash.slice(26)}`;
    if (recoveredAddr.toLowerCase() !== address.toLowerCase()) {
      throw AppError.invalidPublicInputs(
        `Recovered address ${recoveredAddr} does not match ${address}`,
      );
    }

    // Compute Poseidon2 nullifier
    const bb = await BarretenbergSync.initSingleton();
    const pubkey_x_bigint = BigInt(`0x${Buffer.from(pubkey_x).toString("hex")}`) % BN254_MODULUS;
    const pubkey_y_bigint = BigInt(`0x${Buffer.from(pubkey_y).toString("hex")}`) % BN254_MODULUS;
    const nullifier_fr = bb.poseidon2Hash([
      new Fr(pubkey_x_bigint),
      new Fr(pubkey_y_bigint),
      new Fr(BigInt(epoch)),
    ]);
    const nullifier_bigint = BigInt(nullifier_fr.toString());

    // Build the inputs for the Noir circuit
    const MIN_BALANCE_WEI = BigInt(process.env.VITE_MIN_BALANCE_WEI || "0");
    const inputs: Record<string, any> = {
      sig_r: bytesToInputArray(sig_r),
      sig_s: bytesToInputArray(sig_s),
      pubkey_x: bytesToInputArray(pubkey_x),
      pubkey_y: bytesToInputArray(pubkey_y),
      address: bytesToInputArray(addressBytes),
      proof_key: bytesToInputArray(proofKey),
      proof_value: bytesToInputArray(proofValue),
      proof_nodes: paddedNodes.map(bytesToInputArray),
      proof_leaf: bytesToInputArray(paddedLeaf),
      proof_depth: depth.toString(),
      state_root: bytesToInputArray(stateRootBytes),
      epoch: epoch.toString(),
      min_balance: MIN_BALANCE_WEI.toString(),
      nullifier: nullifier_bigint.toString(),
    };

    deps.logger.info("Generating witness...");

    const circuit = getCircuitArtifact();
    const noir = new Noir(circuit);

    let witness: Uint8Array;
    try {
      const result = await noir.execute(inputs);
      witness = result.witness;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err }, "Witness generation failed");
      throw AppError.invalidPublicInputs(`Witness generation failed: ${msg}`);
    }

    deps.logger.info("Generating proof...");

    const { cpus } = await import("os");
    const backend = new UltraHonkBackend(circuit.bytecode, { threads: cpus().length });

    let proof: { proof: Uint8Array; publicInputs: string[] };
    try {
      const startTime = Date.now();
      proof = await backend.generateProof(witness);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      deps.logger.info({ elapsed, proofSize: proof.proof.length }, "Proof generated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err }, "Proof generation failed");
      throw new AppError(`Proof generation failed: ${msg}`, "PROOF_GENERATION_FAILED", 500);
    }

    // Build stateRoot hex string from the input bytes
    const stateRootHex =
      "0x" +
      Array.from(stateRootBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return c.json({
      proof: "0x" + Buffer.from(proof.proof).toString("hex"),
      publicInputs: {
        stateRoot: stateRootHex,
        epoch,
        minBalance: MIN_BALANCE_WEI.toString(),
        nullifier: nullifier_bigint.toString(),
      },
    });
  });

  return app;
}
