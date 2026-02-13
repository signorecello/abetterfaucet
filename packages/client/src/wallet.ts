import {
  createPublicClient,
  http,
  type Hex,
  type Address,
  hexToBytes,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type { StorageProofData } from "./types";
import { EPOCH_DURATION_SECONDS } from "./epoch";

/** Domain message template used for nullifier derivation */
export const DOMAIN_MESSAGE = "zk_faucet_v1:eth-balance:nullifier_seed";

/** Epoch is zero-padded to this many digits for fixed-length domain message. */
export const EPOCH_PAD_LENGTH = 10;

/**
 * Signs the domain message concatenated with zero-padded epoch using the private key.
 * The signature is used to recover the public key for nullifier derivation:
 *   nullifier = poseidon2(pubkey_x, pubkey_y, epoch)
 *
 * The epoch is zero-padded to EPOCH_PAD_LENGTH digits to produce a fixed-length
 * message that the circuit can verify in-circuit via keccak256.
 */
export async function signDomainMessage(
  privateKey: Hex,
  epoch: number,
): Promise<{ r: Hex; s: Hex; v: number }> {
  const account = privateKeyToAccount(privateKey);
  const epochStr = epoch.toString().padStart(EPOCH_PAD_LENGTH, "0");
  const message = `${DOMAIN_MESSAGE}:${epochStr}`;
  const signature = await account.signMessage({ message });

  // Parse the 65-byte signature: r (32) + s (32) + v (1)
  const sigBytes = hexToBytes(signature);
  const r = toHex(sigBytes.slice(0, 32));
  const s = toHex(sigBytes.slice(32, 64));
  const v = sigBytes[64];

  return { r, s, v };
}

/**
 * Fetches an eth_getProof response from the given RPC for the specified address.
 * Returns parsed storage proof data including the state root from the block.
 */
export async function fetchStorageProof(
  rpcUrl: string,
  address: Address,
  blockNumber?: bigint,
): Promise<StorageProofData> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const block = blockNumber
    ? await client.getBlock({ blockNumber })
    : await client.getBlock({ blockTag: "latest" });

  const proof = await client.getProof({
    address,
    storageKeys: [],
    blockNumber: block.number,
  });

  return {
    address,
    balance: proof.balance,
    nonce: proof.nonce,
    codeHash: proof.codeHash,
    storageHash: proof.storageHash,
    accountProof: proof.accountProof,
    blockNumber: block.number,
    stateRoot: block.stateRoot,
  };
}

/**
 * Gets the ETH balance for an address at the latest block.
 */
export async function getBalance(
  rpcUrl: string,
  address: Address,
): Promise<bigint> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  return client.getBalance({ address });
}

/**
 * Derives an Ethereum address from a private key.
 */
export function deriveAddress(privateKey: Hex): Address {
  const account = privateKeyToAccount(privateKey);
  return account.address;
}
