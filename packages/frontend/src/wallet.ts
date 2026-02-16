// Wallet integration using @wagmi/core (framework-agnostic)
// Connects to the origin chain set by VITE_ORIGIN_CHAINID and queries balance there.
// No server RPC URL needed — ORIGIN_RPC_URL is never exposed to the browser.

import {
  createConfig,
  connect,
  disconnect as wagmiDisconnect,
  getBalance as wagmiGetBalance,
  signMessage as wagmiSignMessage,
  switchChain as wagmiSwitchChain,
  watchAccount,
  http,
  type Config,
} from "@wagmi/core";
import { injected } from "@wagmi/connectors";
import { mainnet, sepolia, holesky } from "viem/chains";
import { createPublicClient, custom, type Chain } from "viem";
import type { StorageProofResponse } from "./api";

export interface WalletState {
  connected: boolean;
  address: string | null;
  balance: string | null; // wei as decimal string
  signature: string | null; // full 65-byte signature as 0x hex
}

/** Domain message prefix -- must match circuit and server exactly */
const DOMAIN_MESSAGE_PREFIX = "zk_faucet_v1:eth-balance:nullifier_seed:";

/** Epoch is zero-padded to this many digits for fixed-length domain message */
const EPOCH_PAD_LENGTH = 10;

/** Epoch duration in seconds: 1 week */
const EPOCH_DURATION_SECONDS = 604_800;

let state: WalletState = {
  connected: false,
  address: null,
  balance: null,
  signature: null,
};

let onChangeCallback: ((state: WalletState) => void) | null = null;
let wagmiConfig: Config | null = null;

/** Map chain IDs to viem chain objects */
const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  11155111: sepolia,
  17000: holesky,
};

/** Origin chain ID from build-time env var — VITE_ORIGIN_CHAINID is required */
const originChainId = Number(import.meta.env.VITE_ORIGIN_CHAINID);
if (!originChainId || !CHAIN_MAP[originChainId]) {
  throw new Error(
    `VITE_ORIGIN_CHAINID must be set to a supported chain ID (${Object.keys(CHAIN_MAP).join(", ")}). Got: ${import.meta.env.VITE_ORIGIN_CHAINID}`,
  );
}
const originChain = CHAIN_MAP[originChainId];

/** Minimum balance in wei from build-time env var — VITE_MIN_BALANCE_WEI is required */
const minBalanceRaw = import.meta.env.VITE_MIN_BALANCE_WEI;
if (!minBalanceRaw) {
  throw new Error("VITE_MIN_BALANCE_WEI must be set (e.g. 10000000000000000 for 0.01 ETH).");
}
export const MIN_BALANCE_WEI = BigInt(minBalanceRaw);

console.log(
  `[zk_faucet] config: VITE_ORIGIN_CHAINID=${originChainId} (${originChain.name}), VITE_MIN_BALANCE_WEI=${minBalanceRaw}`,
);

/**
 * Initialize the wallet module.
 * Must be called before connectWallet().
 * Uses http() transport which always targets the origin chain regardless of
 * which chain the wallet is currently on.
 */
export function initWallet(): void {
  wagmiConfig = createConfig({
    chains: [originChain],
    transports: {
      [originChain.id]: http(),
    },
    connectors: [injected()],
  });

  // Watch for account changes (e.g. user switches account in wallet)
  watchAccount(wagmiConfig, {
    onChange: handleAccountChanged,
  });
}

function getConfig(): Config {
  if (!wagmiConfig) {
    throw new Error("Wallet not initialized. Call initWallet() first.");
  }
  return wagmiConfig;
}

export function getWalletState(): WalletState {
  return { ...state };
}

export function onWalletChange(cb: (state: WalletState) => void) {
  onChangeCallback = cb;
}

function notify() {
  if (onChangeCallback) onChangeCallback({ ...state });
}

export function isMetaMaskAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

/**
 * Build the domain message for a given epoch.
 * Format: "zk_faucet_v1:eth-balance:nullifier_seed:" + epoch_padded_10_digits
 * Total: 50 bytes
 */
export function buildDomainMessage(epoch: number): string {
  const epochStr = epoch.toString().padStart(EPOCH_PAD_LENGTH, "0");
  return `${DOMAIN_MESSAGE_PREFIX}${epochStr}`;
}

/**
 * Get current epoch number.
 */
export function getCurrentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_DURATION_SECONDS);
}

/**
 * Connect wallet: request accounts via wagmi injected connector.
 * Switches the wallet to the origin chain, then queries balance.
 */
export async function connectWallet(): Promise<WalletState> {
  const config = getConfig();

  if (!isMetaMaskAvailable()) {
    throw new Error("MetaMask is not installed. Please install MetaMask to continue.");
  }

  // Connect via injected connector
  const result = await connect(config, {
    connector: injected(),
  });

  if (!result.accounts || result.accounts.length === 0) {
    throw new Error("No accounts returned. Please unlock your wallet.");
  }

  state.address = result.accounts[0];
  state.connected = true;

  // Switch wallet to the origin chain
  try {
    await wagmiSwitchChain(config, { chainId: originChain.id });
  } catch (err) {
    console.warn("Failed to switch chain (user may have rejected):", err);
  }

  // Fetch balance on the origin chain
  await fetchBalance(state.address);

  notify();
  return { ...state };
}

/**
 * Sign the domain message for a given epoch via wagmi signMessage.
 * Returns the full 65-byte signature as a 0x hex string.
 */
export async function signDomainMessage(epoch: number): Promise<string> {
  const config = getConfig();

  if (!state.address) {
    throw new Error("Wallet not connected");
  }

  const message = buildDomainMessage(epoch);

  const signature = await wagmiSignMessage(config, {
    message,
  });

  state.signature = signature;
  notify();

  return signature;
}

export function disconnectWallet() {
  const config = getConfig();

  try {
    wagmiDisconnect(config);
  } catch {
    // Ignore disconnect errors (wallet may already be disconnected)
  }

  state = { connected: false, address: null, balance: null, signature: null };
  notify();
}

/**
 * Fetch the ETH balance for a given address on the origin chain.
 * Uses the http() transport configured for the origin chain (public RPC).
 */
async function fetchBalance(address: string): Promise<void> {
  const config = getConfig();

  try {
    const balance = await wagmiGetBalance(config, {
      address: address as `0x${string}`,
      chainId: originChain.id,
    });
    state.balance = balance.value.toString();
  } catch (err) {
    console.error("Failed to fetch balance:", err);
    state.balance = null;
  }
}

/**
 * Handle account changes detected by wagmi's watchAccount.
 */
async function handleAccountChanged(account: { address?: string; isConnected: boolean; status: string }) {
  if (!account.isConnected || !account.address) {
    // User disconnected from the wallet
    state = { connected: false, address: null, balance: null, signature: null };
    notify();
    return;
  }

  // Account changed: update address, clear stale data, re-fetch balance
  const addressChanged = state.address?.toLowerCase() !== account.address.toLowerCase();
  state.address = account.address;
  state.connected = true;

  if (addressChanged) {
    state.balance = null;
    state.signature = null;
    notify();

    await fetchBalance(account.address);
    notify();
  }
}

/**
 * Fetch storage proof for an address via the wallet's RPC provider.
 * Creates a viem public client using window.ethereum (which should be on the
 * origin chain after switchChain in connectWallet). This routes through the
 * wallet's built-in RPC (e.g. Infura) which supports eth_getProof.
 */
export async function getStorageProof(address: string): Promise<StorageProofResponse> {
  if (!window.ethereum) {
    throw new Error("No wallet provider available.");
  }

  // Use the wallet's own provider for getProof (public RPCs often don't support it)
  const client = createPublicClient({
    chain: originChain,
    transport: custom(window.ethereum),
  });

  // Get latest block for stateRoot
  const block = await client.getBlock({ blockTag: "latest" });

  // Fetch account proof
  const proof = await client.getProof({
    address: address as `0x${string}`,
    storageKeys: [],
    blockNumber: block.number,
  });

  return {
    balance: proof.balance.toString(),
    nonce: proof.nonce.toString(),
    codeHash: proof.codeHash,
    storageHash: proof.storageHash,
    accountProof: proof.accountProof,
    stateRoot: block.stateRoot,
    blockNumber: block.number.toString(),
  };
}

export function formatBalance(weiStr: string): string {
  const wei = BigInt(weiStr);
  const eth = Number(wei) / 1e18;
  return eth.toFixed(4);
}

export function hasMinBalance(weiStr: string): boolean {
  return BigInt(weiStr) >= MIN_BALANCE_WEI;
}
