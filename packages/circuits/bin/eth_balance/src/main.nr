// zk_faucet: ETH Balance Proof Circuit
//
// Proves that a user controls an Ethereum address with >= min_balance ETH
// on Ethereum (verified via Merkle-Patricia Trie storage proof against a
// state_root), and derives a deterministic nullifier from the public key + epoch.
//
// Privacy guarantees:
//   - The address, signature, MPT proof data, and balance are private
//   - Only the nullifier, epoch, min_balance, and state_root are public
//   - The nullifier is derived from the public key (not the signature),
//     ensuring determinism regardless of ECDSA nonce randomness
//
// Security: message_hash is computed IN-CIRCUIT from the public epoch input
// using a fixed-length domain message format, preventing signature replay attacks.
//
// Circuit constraints:
//   1. Message hash derivation from epoch (EIP-191 domain message)
//   2. ECDSA signature verification (secp256k1)
//   3. Address derivation: keccak256(pubkey)[12..32] == address
//   4. MPT account proof verification against state_root -> extracts verified balance
//   5. Balance check: verified_balance >= min_balance
//   6. Nullifier: poseidon2(pubkey_x, pubkey_y, epoch)

use std::ecdsa_secp256k1;
use keccak256::keccak256;
use poseidon::poseidon2::Poseidon2;
use ethereum::account::{Account, MAX_PREFIXED_KEY_NIBBLE_LEN, MAX_ACCOUNT_DEPTH_NO_LEAF_M, MAX_ACCOUNT_STATE_LEN, MAX_ACCOUNT_LEAF_LEN};
use ethereum::verifiers::account::verify_account;
use ethereum::merkle_patricia_proofs::proof::{Proof, ProofInput, MAX_NODE_LEN};
use ethereum::misc::types::Address;

// Convert a 32-byte array to a Field element (big-endian)
fn bytes32_to_field(bytes: [u8; 32]) -> Field {
    let mut result: Field = 0;
    for i in 0..32 {
        result = result * 256 + bytes[i] as Field;
    }
    result
}

// Convert a u32 value to 10 zero-padded ASCII decimal digits.
// Example: 2928 -> [0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x39, 0x32, 0x38]
//          which is "0000002928"
fn u32_to_decimal_10(val: u32) -> [u8; 10] {
    let mut digits: [u8; 10] = [0x30; 10]; // fill with ASCII '0'
    let mut remaining = val;
    for i in 0..10 {
        let idx = 9 - i;
        digits[idx] = (remaining % 10) as u8 + 0x30;
        remaining = remaining / 10;
    }
    digits
}

// Compute the EIP-191 message hash for the domain message tied to an epoch.
//
// The domain message format (50 bytes, fixed-length):
//   "zk_faucet_v1:eth-balance:nullifier_seed:" + epoch_padded_10_digits
//
// EIP-191 wrapping (78 bytes total):
//   "\x19Ethereum Signed Message:\n50" (28 bytes) + domain_message (50 bytes)
//
// Returns keccak256 of the full 78-byte EIP-191 message.
fn compute_message_hash(epoch: Field) -> [u8; 32] {
    let epoch_digits = u32_to_decimal_10(epoch as u32);

    // Build the full 78-byte EIP-191 message in a single array.
    // Byte layout:
    //   [0..28)   = EIP-191 prefix: \x19 + "Ethereum Signed Message:\n50"
    //   [28..68)  = domain string:  "zk_faucet_v1:eth-balance:nullifier_seed:"
    //   [68..78)  = epoch digits (10 bytes, zero-padded)
    let mut msg: [u8; 78] = [0; 78];

    // -- EIP-191 prefix (28 bytes) --
    // \x19
    msg[0] = 0x19;
    // "Ethereum Signed Message:\n50"
    // E t h e r e u m   S i g n e d   M e s s a g e : \n 5 0
    msg[1] = 0x45; msg[2] = 0x74; msg[3] = 0x68; msg[4] = 0x65;
    msg[5] = 0x72; msg[6] = 0x65; msg[7] = 0x75; msg[8] = 0x6d;
    msg[9] = 0x20;
    msg[10] = 0x53; msg[11] = 0x69; msg[12] = 0x67; msg[13] = 0x6e;
    msg[14] = 0x65; msg[15] = 0x64; msg[16] = 0x20;
    msg[17] = 0x4d; msg[18] = 0x65; msg[19] = 0x73; msg[20] = 0x73;
    msg[21] = 0x61; msg[22] = 0x67; msg[23] = 0x65; msg[24] = 0x3a;
    msg[25] = 0x0a;
    msg[26] = 0x35; msg[27] = 0x30;

    // -- Domain string (40 bytes): "zk_faucet_v1:eth-balance:nullifier_seed:" --
    // z  k  _  f  a  u  c  e  t  _
    msg[28] = 0x7a; msg[29] = 0x6b; msg[30] = 0x5f; msg[31] = 0x66;
    msg[32] = 0x61; msg[33] = 0x75; msg[34] = 0x63; msg[35] = 0x65;
    msg[36] = 0x74; msg[37] = 0x5f;
    // v  1  :
    msg[38] = 0x76; msg[39] = 0x31; msg[40] = 0x3a;
    // e  t  h  -  b  a  l  a  n  c  e  :
    msg[41] = 0x65; msg[42] = 0x74; msg[43] = 0x68; msg[44] = 0x2d;
    msg[45] = 0x62; msg[46] = 0x61; msg[47] = 0x6c; msg[48] = 0x61;
    msg[49] = 0x6e; msg[50] = 0x63; msg[51] = 0x65; msg[52] = 0x3a;
    // n  u  l  l  i  f  i  e  r  _
    msg[53] = 0x6e; msg[54] = 0x75; msg[55] = 0x6c; msg[56] = 0x6c;
    msg[57] = 0x69; msg[58] = 0x66; msg[59] = 0x69; msg[60] = 0x65;
    msg[61] = 0x72; msg[62] = 0x5f;
    // s  e  e  d  :
    msg[63] = 0x73; msg[64] = 0x65; msg[65] = 0x65; msg[66] = 0x64;
    msg[67] = 0x3a;

    // -- Epoch digits (10 bytes) --
    for i in 0..10 {
        msg[68 + i] = epoch_digits[i];
    }

    keccak256(msg, 78)
}

// Verify an ECDSA secp256k1 signature against the provided public key.
//
// The signature is over the in-circuit computed message hash (EIP-191
// personal_sign of the domain message with zero-padded epoch).
fn verify_signature(
    message_hash: [u8; 32],
    sig_r: [u8; 32],
    sig_s: [u8; 32],
    pubkey_x: [u8; 32],
    pubkey_y: [u8; 32],
) {
    let mut signature: [u8; 64] = [0; 64];
    for i in 0..32 {
        signature[i] = sig_r[i];
        signature[i + 32] = sig_s[i];
    }
    let valid = ecdsa_secp256k1::verify_signature(pubkey_x, pubkey_y, signature, message_hash);
    assert(valid, "ECDSA signature verification failed");
}

// Verify that the given public key hashes to the expected Ethereum address:
//   address = keccak256(pubkey_x || pubkey_y)[12..32]
fn verify_address_from_pubkey(
    pubkey_x: [u8; 32],
    pubkey_y: [u8; 32],
    address: [u8; 20],
) {
    let mut pubkey_bytes: [u8; 64] = [0; 64];
    for i in 0..32 {
        pubkey_bytes[i] = pubkey_x[i];
        pubkey_bytes[i + 32] = pubkey_y[i];
    }
    let hash: [u8; 32] = keccak256(pubkey_bytes, 64);
    for i in 0..20 {
        assert(hash[i + 12] == address[i], "Address does not match public key");
    }
}

// Main circuit entrypoint
//
// Proves:
//   1. The prover controls an Ethereum address (via ECDSA signature over epoch)
//   2. The address has a verified balance on Ethereum (via MPT proof against state_root)
//   3. That verified balance >= min_balance
//   4. A deterministic nullifier derived from the public key + epoch
fn main(
    // === Private inputs ===
    sig_r: [u8; 32],
    sig_s: [u8; 32],
    pubkey_x: [u8; 32],
    pubkey_y: [u8; 32],
    // Ethereum address (derived from pubkey, verified in-circuit)
    address: Address,
    // Account fields (verified against MPT proof by eth-proofs)
    account_nonce: u64,
    account_balance: Field,
    account_storage_root: [u8; 32],
    account_code_hash: [u8; 32],
    // MPT account proof data
    proof_key: [u8; MAX_PREFIXED_KEY_NIBBLE_LEN],
    proof_value: [u8; MAX_ACCOUNT_STATE_LEN],
    proof_nodes: [[u8; MAX_NODE_LEN]; MAX_ACCOUNT_DEPTH_NO_LEAF_M],
    proof_leaf: [u8; MAX_ACCOUNT_LEAF_LEN],
    proof_depth: u64,
    // === Public inputs ===
    // State root from a recent L1 block (server verifies recency)
    state_root: pub [u8; 32],
    epoch: pub Field,
    min_balance: pub Field,
    nullifier: pub Field,
) {
    // 1. Compute message hash in-circuit from epoch (prevents signature replay)
    let message_hash = compute_message_hash(epoch);

    // 2. ECDSA signature verification
    verify_signature(message_hash, sig_r, sig_s, pubkey_x, pubkey_y);

    // 3. Address derivation from public key
    verify_address_from_pubkey(pubkey_x, pubkey_y, address);

    // 4. MPT account proof verification via eth-proofs
    let account = Account {
        nonce: account_nonce,
        balance: account_balance,
        storage_root: account_storage_root,
        code_hash: account_code_hash,
    };
    let proof = Proof {
        nodes: proof_nodes,
        leaf: proof_leaf,
        depth: proof_depth,
    };
    let proof_input = ProofInput {
        key: proof_key,
        value: proof_value,
        proof,
    };
    verify_account(address, account, proof_input, state_root);

    // 5. Balance check (cast to u64 -- sufficient for ETH amounts up to ~18.4 ETH)
    assert(account.balance as u64 >= min_balance as u64, "Balance below minimum threshold");

    // 6. Nullifier derivation from PUBLIC KEY (deterministic regardless of ECDSA nonce)
    let pubkey_x_field = bytes32_to_field(pubkey_x);
    let pubkey_y_field = bytes32_to_field(pubkey_y);
    let computed_nullifier = Poseidon2::hash([pubkey_x_field, pubkey_y_field, epoch], 3);
    assert(nullifier == computed_nullifier, "Nullifier mismatch");
}

// ================================================================
// Tests
// ================================================================

#[test]
fn test_u32_to_decimal_10() {
    // 0 -> "0000000000"
    let digits0 = u32_to_decimal_10(0);
    for i in 0..10 {
        assert(digits0[i] == 0x30, "Zero should produce all ASCII '0'");
    }

    // 2928 -> "0000002928"
    let digits = u32_to_decimal_10(2928);
    assert(digits[0] == 0x30); // '0'
    assert(digits[1] == 0x30); // '0'
    assert(digits[2] == 0x30); // '0'
    assert(digits[3] == 0x30); // '0'
    assert(digits[4] == 0x30); // '0'
    assert(digits[5] == 0x30); // '0'
    assert(digits[6] == 0x32); // '2'
    assert(digits[7] == 0x39); // '9'
    assert(digits[8] == 0x32); // '2'
    assert(digits[9] == 0x38); // '8'

    // 1234567890 -> "1234567890"
    let big = u32_to_decimal_10(1234567890);
    assert(big[0] == 0x31); // '1'
    assert(big[1] == 0x32); // '2'
    assert(big[2] == 0x33); // '3'
    assert(big[3] == 0x34); // '4'
    assert(big[4] == 0x35); // '5'
    assert(big[5] == 0x36); // '6'
    assert(big[6] == 0x37); // '7'
    assert(big[7] == 0x38); // '8'
    assert(big[8] == 0x39); // '9'
    assert(big[9] == 0x30); // '0'
}

#[test]
fn test_compute_message_hash_deterministic() {
    // Same epoch must produce the same hash
    let hash1 = compute_message_hash(2928);
    let hash2 = compute_message_hash(2928);
    for i in 0..32 {
        assert(hash1[i] == hash2[i], "Hash must be deterministic");
    }

    // Different epochs must produce different hashes
    let hash3 = compute_message_hash(2929);
    let mut differs = false;
    for i in 0..32 {
        if hash1[i] != hash3[i] {
            differs = true;
        }
    }
    assert(differs, "Different epochs must produce different hashes");
}

#[test]
fn test_bytes32_to_field() {
    let mut bytes: [u8; 32] = [0; 32];
    bytes[31] = 1;
    assert(bytes32_to_field(bytes) == 1);

    let mut bytes2: [u8; 32] = [0; 32];
    bytes2[31] = 255;
    assert(bytes32_to_field(bytes2) == 255);

    let mut bytes3: [u8; 32] = [0; 32];
    bytes3[30] = 1;
    assert(bytes32_to_field(bytes3) == 256);
}

#[test]
fn test_balance_check_passes() {
    let balance: Field = 100;
    let min_balance: Field = 10;
    assert(balance as u64 >= min_balance as u64);
}

#[test]
fn test_nullifier_is_deterministic() {
    let mut pubkey_x: [u8; 32] = [0; 32];
    pubkey_x[31] = 42;
    let mut pubkey_y: [u8; 32] = [0; 32];
    pubkey_y[31] = 99;
    let epoch: Field = 5;

    let pubkey_x_field = bytes32_to_field(pubkey_x);
    let pubkey_y_field = bytes32_to_field(pubkey_y);

    let nullifier1 = Poseidon2::hash([pubkey_x_field, pubkey_y_field, epoch], 3);
    let nullifier2 = Poseidon2::hash([pubkey_x_field, pubkey_y_field, epoch], 3);
    assert(nullifier1 == nullifier2, "Nullifier should be deterministic");
}

#[test]
fn test_different_epochs_produce_different_nullifiers() {
    let mut pubkey_x: [u8; 32] = [0; 32];
    pubkey_x[31] = 42;
    let mut pubkey_y: [u8; 32] = [0; 32];
    pubkey_y[31] = 99;

    let pubkey_x_field = bytes32_to_field(pubkey_x);
    let pubkey_y_field = bytes32_to_field(pubkey_y);

    let nullifier_epoch5 = Poseidon2::hash([pubkey_x_field, pubkey_y_field, 5], 3);
    let nullifier_epoch6 = Poseidon2::hash([pubkey_x_field, pubkey_y_field, 6], 3);
    assert(nullifier_epoch5 != nullifier_epoch6, "Different epochs should produce different nullifiers");
}

#[test]
fn test_different_pubkeys_produce_different_nullifiers() {
    let epoch: Field = 5;

    let mut pubkey_x_a: [u8; 32] = [0; 32];
    pubkey_x_a[31] = 1;
    let mut pubkey_y_a: [u8; 32] = [0; 32];
    pubkey_y_a[31] = 2;

    let mut pubkey_x_b: [u8; 32] = [0; 32];
    pubkey_x_b[31] = 3;
    let mut pubkey_y_b: [u8; 32] = [0; 32];
    pubkey_y_b[31] = 4;

    let null_a = Poseidon2::hash(
        [bytes32_to_field(pubkey_x_a), bytes32_to_field(pubkey_y_a), epoch],
        3,
    );
    let null_b = Poseidon2::hash(
        [bytes32_to_field(pubkey_x_b), bytes32_to_field(pubkey_y_b), epoch],
        3,
    );
    assert(null_a != null_b, "Different pubkeys should produce different nullifiers");
}
