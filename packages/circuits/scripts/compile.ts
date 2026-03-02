#!/usr/bin/env bun
/**
 * Circuit compilation script
 *
 * Compiles the eth_balance Noir circuit using nargo and exports
 * the artifact JSON for use by the client and server.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";

const CIRCUIT_DIR = join(import.meta.dir, "..", "eth_balance");
const OUTPUT_DIR = join(CIRCUIT_DIR, "target");

async function checkNargo(): Promise<boolean> {
  try {
    const result = await $`nargo --version`.quiet();
    console.log(`Found nargo: ${result.text().trim()}`);
    return true;
  } catch {
    return false;
  }
}

async function compile() {
  console.log("=== A Better Faucet circuit compiler ===\n");

  const hasNargo = await checkNargo();
  if (!hasNargo) {
    console.error("Error: nargo is not installed or not in PATH.\n");
    console.error("Install Noir/nargo:");
    console.error("  curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash");
    console.error("  noirup\n");
    console.error("Or visit: https://noir-lang.org/docs/getting_started/installation");
    process.exit(1);
  }

  console.log(`Compiling circuit in: ${CIRCUIT_DIR}`);

  try {
    await $`cd ${CIRCUIT_DIR} && nargo compile`;
    console.log("\nCompilation successful!");

    const artifactPath = join(OUTPUT_DIR, "eth_balance.json");
    if (existsSync(artifactPath)) {
      console.log(`\nArtifact written to: ${artifactPath}`);

      // Copy artifact to a well-known location for the server to serve
      const serveDir = join(import.meta.dir, "..", "..", "server", "public", "circuits", "eth-balance");
      await $`mkdir -p ${serveDir}`;
      await $`cp ${artifactPath} ${join(serveDir, "artifact.json")}`;
      console.log(`Artifact copied to: ${join(serveDir, "artifact.json")}`);
    }
  } catch (err) {
    console.error("\nCompilation failed:", err);
    process.exit(1);
  }

  // Also run tests
  console.log("\nRunning circuit tests...");
  try {
    await $`cd ${CIRCUIT_DIR} && nargo test`;
    console.log("All circuit tests passed!");
  } catch (err) {
    console.error("Circuit tests failed:", err);
    process.exit(1);
  }
}

compile();
