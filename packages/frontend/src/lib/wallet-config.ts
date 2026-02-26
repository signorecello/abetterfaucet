// Wagmi config + Reown AppKit setup for React hooks
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createAppKit } from '@reown/appkit/react';
import { mainnet, sepolia, holesky } from '@reown/appkit/networks';
import type { AppKitNetwork } from '@reown/appkit/networks';

/** Map chain IDs to AppKit network objects */
const NETWORK_MAP: Record<number, AppKitNetwork> = {
  1: mainnet,
  11155111: sepolia,
  17000: holesky,
};

/** Origin chain ID from build-time env var */
const originChainId = Number(import.meta.env.VITE_ORIGIN_CHAINID);
if (!originChainId || !NETWORK_MAP[originChainId]) {
  throw new Error(
    `VITE_ORIGIN_CHAINID must be set to a supported chain ID (${Object.keys(NETWORK_MAP).join(', ')}). Got: ${import.meta.env.VITE_ORIGIN_CHAINID}`,
  );
}

export const originNetwork = NETWORK_MAP[originChainId];

/** Re-export as originChain for backward compat with hooks that use viem Chain type */
export const originChain = originNetwork;

/** Minimum balance in wei from build-time env var */
const minBalanceRaw = import.meta.env.VITE_MIN_BALANCE_WEI;
if (!minBalanceRaw) {
  throw new Error('VITE_MIN_BALANCE_WEI must be set (e.g. 10000000000000000 for 0.01 ETH).');
}
export const MIN_BALANCE_WEI = BigInt(minBalanceRaw);

console.log(
  `[zk_faucet] config: VITE_ORIGIN_CHAINID=${originChainId} (${originNetwork.name}), VITE_MIN_BALANCE_WEI=${minBalanceRaw}`,
);

/** Domain message prefix -- must match circuit and server exactly */
const DOMAIN_MESSAGE_PREFIX = 'zk_faucet_v1:eth-balance:nullifier_seed:';
const EPOCH_PAD_LENGTH = 10;

/** Epoch duration in seconds from build-time env var (default: 1 week) */
export const EPOCH_DURATION_SECONDS = Number(import.meta.env.VITE_EPOCH_DURATION || '604800');

/** Build the domain message for a given epoch */
export function buildDomainMessage(epoch: number): string {
  const epochStr = epoch.toString().padStart(EPOCH_PAD_LENGTH, '0');
  return `${DOMAIN_MESSAGE_PREFIX}${epochStr}`;
}

/** Get current epoch number */
export function getCurrentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_DURATION_SECONDS);
}

// --- Reown AppKit setup ---

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID;

const networks: [AppKitNetwork, ...AppKitNetwork[]] = [originNetwork];

const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks,
});

createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks,
  metadata: {
    name: 'zk_faucet',
    description: 'Privacy-preserving testnet faucet',
    url: globalThis.location?.origin ?? 'https://zkfaucet.xyz',
    icons: [],
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#00ff88',
    '--w3m-color-mix': '#0a0a0a',
    '--w3m-color-mix-strength': 40,
    '--w3m-font-family': "'JetBrains Mono', monospace",
    '--w3m-border-radius-master': '2px',
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
