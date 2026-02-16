use ethereum::account::Account;
use ethereum::verifiers::account::verify_account;
use ethereum::merkle_patricia_proofs::proof::{Proof, ProofInput};
use ethereum::misc::types::Address;

// Test circuit for verifying Ethereum account balance via MPT proof.
//
// Inputs match the constants from the eth-proofs library:
//   MAX_PREFIXED_KEY_NIBBLE_LEN = 66
//   MAX_ACCOUNT_STATE_LEN = 110
//   MAX_ACCOUNT_DEPTH_NO_LEAF_M = 10
//   MAX_NODE_LEN = 532
//   MAX_ACCOUNT_LEAF_LEN = 148
fn main(
    // -- private inputs --
    address: Address,
    state_root: [u8; 32],
    // Account fields
    account_nonce: u64,
    account_balance: Field,
    account_storage_root: [u8; 32],
    account_code_hash: [u8; 32],
    // MPT proof data
    proof_key: [u8; 66],
    proof_value: [u8; 110],
    proof_nodes: [[u8; 532]; 10],
    proof_leaf: [u8; 148],
    proof_depth: u64,
    // -- public inputs --
    expected_balance: pub Field,
) {
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
    assert(account.balance == expected_balance, "Balance mismatch");
}
