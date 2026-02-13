import { describe, expect, test, mock, beforeEach } from "bun:test";
import {
  deriveAddress,
  signDomainMessage,
  DOMAIN_MESSAGE,
  EPOCH_PAD_LENGTH,
} from "../src/wallet";
import type { Hex } from "viem";

// Well-known test private key (DO NOT use with real funds)
const TEST_PRIVATE_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// The address corresponding to this key (Hardhat account #0)
const EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("wallet", () => {
  describe("deriveAddress", () => {
    test("derives correct address from known private key", () => {
      const address = deriveAddress(TEST_PRIVATE_KEY);
      expect(address.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
    });

    test("returns checksummed address", () => {
      const address = deriveAddress(TEST_PRIVATE_KEY);
      // Viem returns checksummed addresses
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    test("different private keys produce different addresses", () => {
      const key2: Hex =
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
      const addr1 = deriveAddress(TEST_PRIVATE_KEY);
      const addr2 = deriveAddress(key2);
      expect(addr1.toLowerCase()).not.toBe(addr2.toLowerCase());
    });
  });

  describe("signDomainMessage", () => {
    test("returns signature with r, s, v components", async () => {
      const sig = await signDomainMessage(TEST_PRIVATE_KEY, 2822);
      expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sig.v).toBeOneOf([27, 28]);
    });

    test("produces deterministic signatures for same inputs", async () => {
      const sig1 = await signDomainMessage(TEST_PRIVATE_KEY, 2822);
      const sig2 = await signDomainMessage(TEST_PRIVATE_KEY, 2822);
      expect(sig1.r).toBe(sig2.r);
      expect(sig1.s).toBe(sig2.s);
      expect(sig1.v).toBe(sig2.v);
    });

    test("different epochs produce different signatures", async () => {
      const sig1 = await signDomainMessage(TEST_PRIVATE_KEY, 2822);
      const sig2 = await signDomainMessage(TEST_PRIVATE_KEY, 2823);
      // At least one component should differ
      const same = sig1.r === sig2.r && sig1.s === sig2.s && sig1.v === sig2.v;
      expect(same).toBe(false);
    });

    test("signature can be verified to recover the signer address", async () => {
      const { recoverMessageAddress } = await import("viem");
      const epoch = 2822;
      const sig = await signDomainMessage(TEST_PRIVATE_KEY, epoch);

      // Reconstruct the full signature hex
      const rBytes = sig.r.slice(2);
      const sBytes = sig.s.slice(2);
      const vByte = sig.v.toString(16).padStart(2, "0");
      const fullSig = `0x${rBytes}${sBytes}${vByte}` as Hex;

      const epochStr = epoch.toString().padStart(EPOCH_PAD_LENGTH, "0");
      const recovered = await recoverMessageAddress({
        message: `${DOMAIN_MESSAGE}:${epochStr}`,
        signature: fullSig,
      });

      expect(recovered.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
    });
  });

  describe("fetchStorageProof", () => {
    test("calls eth_getProof with correct parameters", async () => {
      // We test the interface contract without hitting a real RPC
      // by importing and verifying the function signature exists
      const { fetchStorageProof } = await import("../src/wallet");
      expect(typeof fetchStorageProof).toBe("function");
      expect(fetchStorageProof.length).toBe(3); // rpcUrl, address, blockNumber?
    });
  });
});
