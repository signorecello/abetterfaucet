import { parseEther, type Hex, type Address, isAddress } from "viem";
import { getCurrentEpoch, getEpochBounds } from "./epoch";
import { signDomainMessage, fetchStorageProof, getBalance, deriveAddress } from "./wallet";
import { loadCircuitArtifact, generateProof } from "./prove";
import type {
  ClaimRequest,
  ClaimResponse,
  StatusResponse,
  NetworkInfo,
  ModuleInfo,
  ProofInputs,
} from "./types";

const MIN_BALANCE = parseEther("0.01");
const DEFAULT_MODULE = "eth-balance";

function env(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val) {
    console.error(`Error: Missing required env var or argument: ${name}`);
    process.exit(1);
  }
  return val;
}

function printUsage(): void {
  console.log(`
zk_faucet client CLI

Usage:
  bun src/cli.ts <command> [options]

Commands:
  claim       Generate a ZK proof and claim testnet ETH
  status      Check the status of a claim
  networks    List available testnet networks
  modules     List available proof modules

Environment variables:
  PRIVATE_KEY        Your mainnet private key (0x-prefixed)
  FAUCET_URL         Faucet server URL (default: http://localhost:3000)
  ORIGIN_RPC_URL        Ethereum mainnet RPC URL
  RECIPIENT_ADDRESS  Testnet address to receive ETH
  TARGET_NETWORK     Target testnet network ID

Examples:
  bun src/cli.ts claim
  bun src/cli.ts status <claimId>
  bun src/cli.ts networks
  bun src/cli.ts modules
`);
}

async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

async function httpPost<T>(url: string, data: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${url} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

async function cmdClaim(): Promise<void> {
  const privateKey = env("PRIVATE_KEY") as Hex;
  const faucetUrl = env("FAUCET_URL", "http://localhost:3000");
  const rpcUrl = env("ORIGIN_RPC_URL");
  const recipient = env("RECIPIENT_ADDRESS") as Address;
  const targetNetwork = env("TARGET_NETWORK");
  const moduleId = env("MODULE_ID", DEFAULT_MODULE);

  if (!privateKey.startsWith("0x")) {
    console.error("Error: PRIVATE_KEY must start with 0x");
    process.exit(1);
  }

  if (!isAddress(recipient)) {
    console.error("Error: RECIPIENT_ADDRESS is not a valid Ethereum address");
    process.exit(1);
  }

  // Step 1: Derive mainnet address
  const address = deriveAddress(privateKey);
  console.log(`Mainnet address: ${address}`);

  // Step 2: Check balance
  console.log("Checking mainnet balance...");
  const balance = await getBalance(rpcUrl, address);
  console.log(`Balance: ${balance} wei`);

  if (balance < MIN_BALANCE) {
    console.error(
      `Error: Insufficient balance. Need at least 0.01 ETH, have ${balance} wei`,
    );
    process.exit(1);
  }

  // Step 3: Get current epoch
  const epoch = getCurrentEpoch();
  const bounds = getEpochBounds(epoch);
  console.log(
    `Current epoch: ${epoch} (${new Date(bounds.start * 1000).toISOString()} - ${new Date(bounds.end * 1000).toISOString()})`,
  );

  // Step 4: Sign domain message
  console.log("Signing domain message...");
  const sig = await signDomainMessage(privateKey, epoch);
  console.log("Signature obtained.");

  // Step 5: Fetch storage proof
  console.log("Fetching storage proof (eth_getProof)...");
  const storageProof = await fetchStorageProof(rpcUrl, address);
  console.log(
    `Storage proof fetched at block ${storageProof.blockNumber}, state root: ${storageProof.stateRoot}`,
  );

  // Step 6: Load circuit artifact
  console.log("Loading circuit artifact...");
  const artifact = await loadCircuitArtifact(faucetUrl, moduleId);
  console.log("Circuit artifact loaded.");

  // Step 7: Prepare inputs and generate ZK proof
  console.log("Generating ZK proof (this may take a while)...");
  const proofInputs: ProofInputs = {
    address: hexToUint8Array(address),
    signature: {
      r: hexToUint8Array(sig.r),
      s: hexToUint8Array(sig.s),
      v: sig.v,
    },
    accountProofNodes: storageProof.accountProof.map((node) =>
      hexToUint8Array(node as `0x${string}`),
    ),
    balance: storageProof.balance,
    nonce: storageProof.nonce,
    codeHash: hexToUint8Array(storageProof.codeHash as `0x${string}`),
    storageRoot: hexToUint8Array(storageProof.storageHash as `0x${string}`),
    stateRoot: hexToUint8Array(storageProof.stateRoot as `0x${string}`),
    epoch,
    minBalance: MIN_BALANCE,
  };

  const { proof, publicInputs } = await generateProof(artifact, proofInputs);
  console.log("ZK proof generated.");

  // Step 8: Submit claim to faucet server
  console.log("Submitting claim...");
  const claimRequest: ClaimRequest = {
    moduleId,
    proof: toHexString(proof),
    publicInputs: {
      stateRoot: storageProof.stateRoot,
      epoch,
      minBalance: MIN_BALANCE.toString(),
      nullifier: publicInputs[3]!, // nullifier is the 4th public input
    },
    recipient,
    targetNetwork,
  };

  const result = await httpPost<ClaimResponse>(
    `${faucetUrl}/claim`,
    claimRequest,
  );

  // Step 9: Print result
  console.log("\nClaim submitted successfully!");
  console.log(`  Claim ID: ${result.claimId}`);
  console.log(`  TX Hash:  ${result.txHash}`);
  console.log(`  Network:  ${result.network}`);
  console.log(`  Amount:   ${result.amount}`);
}

async function cmdStatus(claimId: string): Promise<void> {
  const faucetUrl = env("FAUCET_URL", "http://localhost:3000");

  if (!claimId) {
    console.error("Error: Please provide a claim ID");
    console.error("Usage: bun src/cli.ts status <claimId>");
    process.exit(1);
  }

  const result = await httpGet<StatusResponse>(
    `${faucetUrl}/status/${claimId}`,
  );

  console.log(`Claim ${result.claimId}:`);
  console.log(`  Status:  ${result.status}`);
  if (result.txHash) console.log(`  TX Hash: ${result.txHash}`);
  if (result.network) console.log(`  Network: ${result.network}`);
}

async function cmdNetworks(): Promise<void> {
  const faucetUrl = env("FAUCET_URL", "http://localhost:3000");

  const networks = await httpGet<NetworkInfo[]>(`${faucetUrl}/networks`);

  console.log("Available networks:\n");
  console.log(
    "  ID              Name                Chain ID    Enabled    Dispensation",
  );
  console.log("  " + "-".repeat(78));

  for (const net of networks) {
    const enabled = net.enabled ? "yes" : "no";
    console.log(
      `  ${net.id.padEnd(16)}${net.name.padEnd(20)}${String(net.chainId).padEnd(12)}${enabled.padEnd(11)}${net.dispensationWei} wei`,
    );
  }
}

async function cmdModules(): Promise<void> {
  const faucetUrl = env("FAUCET_URL", "http://localhost:3000");

  const modules = await httpGet<ModuleInfo[]>(`${faucetUrl}/modules`);

  console.log("Available proof modules:\n");
  for (const mod of modules) {
    const epochBounds = getEpochBounds(mod.currentEpoch);
    console.log(`  ${mod.name} (${mod.id})`);
    console.log(`    ${mod.description}`);
    console.log(`    Current epoch: ${mod.currentEpoch}`);
    console.log(
      `    Epoch window: ${new Date(epochBounds.start * 1000).toISOString()} - ${new Date(epochBounds.end * 1000).toISOString()}`,
    );
    console.log(
      `    Epoch duration: ${mod.epochDurationSeconds}s (${mod.epochDurationSeconds / 3600}h)`,
    );
    console.log();
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHexString(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "claim":
      await cmdClaim();
      break;
    case "status":
      if (!args[1]) {
        console.error("Usage: zk-faucet status <claimId>");
        process.exit(1);
      }
      await cmdStatus(args[1]);
      break;
    case "networks":
      await cmdNetworks();
      break;
    case "modules":
      await cmdModules();
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}\n`);
      }
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
