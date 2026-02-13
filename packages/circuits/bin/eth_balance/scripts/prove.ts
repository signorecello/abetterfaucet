#!/usr/bin/env bun
/**
 * Generates and verifies a ZK proof using noir_js + bb.js (WASM).
 *
 * Prerequisites:
 *   1. nargo compile (produces target/eth_balance.json)
 *   2. generate_prover_toml.ts (produces Prover.toml)
 *
 * Usage:
 *   bun run scripts/prove.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { cpus } from "os";

const circuitPath = resolve(process.cwd(), "target/eth_balance.json");
const proverTomlPath = resolve(process.cwd(), "Prover.toml");

// Parse Prover.toml into input map.
// Handles scalars, 1D arrays, and 2D arrays (e.g. proof_nodes = [\n  [...],\n  [...]\n]).
function parseProverToml(toml: string): Record<string, any> {
  const inputs: Record<string, any> = {};
  const lines = toml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    i++;

    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const rawValue = trimmed.slice(eqIdx + 1).trim();

    if (rawValue.startsWith("[")) {
      // Check if this is a complete 1D array on one line
      if (rawValue.endsWith("]") && !rawValue.includes("[", 1)) {
        // Simple 1D array: [0x05, 0x8b, ...]
        inputs[key] = parseHexArray(rawValue);
      } else {
        // Could be a multi-line 1D array or a 2D array
        // Collect all lines until we find the matching close bracket
        let fullValue = rawValue;
        let depth = countBracketDepth(rawValue);
        while (depth > 0 && i < lines.length) {
          fullValue += "\n" + lines[i];
          depth += countBracketDepth(lines[i]);
          i++;
        }

        // Determine if 2D (contains nested arrays) or 1D
        const inner = fullValue.slice(1, -1).trim(); // strip outer [ ]
        if (inner.startsWith("[")) {
          // 2D array: parse each inner array
          const innerArrays = extractInnerArrays(fullValue);
          inputs[key] = innerArrays.map(parseHexArray);
        } else {
          // 1D array spread across lines
          inputs[key] = parseHexArray(fullValue);
        }
      }
    } else if (rawValue.startsWith('"')) {
      // String-quoted field value
      inputs[key] = rawValue.replace(/"/g, "");
    } else {
      inputs[key] = rawValue;
    }
  }
  return inputs;
}

function countBracketDepth(s: string): number {
  let depth = 0;
  for (const c of s) {
    if (c === "[") depth++;
    if (c === "]") depth--;
  }
  return depth;
}

function parseHexArray(arrayStr: string): string[] {
  return arrayStr
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => parseInt(v, 16).toString());
}

// Extract inner [...] arrays from a 2D array string like "[\n  [...],\n  [...]\n]"
function extractInnerArrays(fullStr: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;

  for (let j = 0; j < fullStr.length; j++) {
    if (fullStr[j] === "[") {
      depth++;
      if (depth === 2) start = j; // start of inner array
    }
    if (fullStr[j] === "]") {
      if (depth === 2 && start !== -1) {
        results.push(fullStr.slice(start, j + 1));
        start = -1;
      }
      depth--;
    }
  }
  return results;
}

async function main() {
  console.log("Loading circuit...");
  const circuitJson = JSON.parse(readFileSync(circuitPath, "utf-8"));

  console.log("Parsing Prover.toml...");
  const toml = readFileSync(proverTomlPath, "utf-8");
  const inputs = parseProverToml(toml);
  console.log("Input keys:", Object.keys(inputs));

  console.log("\nInitializing Noir + UltraHonk backend...");
  const backend = new UltraHonkBackend(circuitJson.bytecode, { threads: cpus().length });
  const noir = new Noir(circuitJson);

  console.log("Generating witness...");
  const { witness } = await noir.execute(inputs);
  console.log("Witness generated successfully.");

  console.log("\nGenerating proof (this may take a while)...");
  const startTime = Date.now();
  const proof = await backend.generateProof(witness);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Proof generated in ${elapsed}s`);
  console.log(`Proof size: ${proof.proof.length} bytes`);
  console.log(`Public inputs: ${proof.publicInputs.length}`);

  // Save proof
  const proofPath = resolve(process.cwd(), "target/proof.bin");
  writeFileSync(proofPath, Buffer.from(proof.proof));
  console.log(`Proof saved to ${proofPath}`);

  // Verify proof
  console.log("\nVerifying proof...");
  const verified = await backend.verifyProof(proof);
  console.log(`Proof verified: ${verified}`);

  if (!verified) {
    console.error("PROOF VERIFICATION FAILED");
    process.exit(1);
  }

  console.log("\nSuccess! Proof generated and verified.");

  // Generate test fixture for server integration tests
  const fixturePath = resolve(process.cwd(), "target/test-fixture.json");
  const stateRootArr: string[] = inputs.state_root;
  const stateRootHex =
    "0x" +
    stateRootArr.map((b: string) => parseInt(b).toString(16).padStart(2, "0")).join("");
  const fixture = {
    proof: "0x" + Buffer.from(proof.proof).toString("hex"),
    publicInputs: proof.publicInputs,
    stateRoot: stateRootHex,
    epoch: parseInt(inputs.epoch, 10),
    minBalance: inputs.min_balance,
    nullifier: inputs.nullifier,
  };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log(`Test fixture saved to ${fixturePath}`);

  process.exit(0)
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
