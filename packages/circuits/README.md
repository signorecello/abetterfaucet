# @abetterfaucet/circuits

Noir ZK circuits for A Better Faucet.

## Structure

```
circuits/
├── eth_balance/              # Main circuit: ETH balance proof
│   ├── Nargo.toml            # Noir package config + dependencies
│   ├── src/main.nr           # Circuit source (ECDSA + keccak + poseidon2)
│   ├── Prover.toml           # Generated witness inputs (gitignored)
│   ├── scripts/
│   │   ├── generate_prover_toml.ts  # Generates Prover.toml from private key
│   │   └── prove.ts                 # Generates + verifies UltraHonk proof
│   └── target/               # Compiled artifacts (gitignored)
│       ├── eth_balance.json  # Compiled circuit (ACIR bytecode)
│       ├── eth_balance.gz    # Serialized witness
│       └── proof.bin         # Generated proof
├── ethereum/                 # Ethereum proof library (Noir)
│   ├── Nargo.toml
│   └── src/
│       ├── lib.nr            # Module declarations
│       ├── types.nr           # Address, Bytes32, Hash type aliases
│       ├── fragment.nr        # Fragment<N> -- array view with offset/length
│       ├── arrays.nr          # memcpy, sub_array_equals utilities
│       ├── bytes.nr           # byte/nibble conversion, right_pad
│       ├── rlp.nr             # RLP decoding (headers, lists, strings)
│       ├── mpt.nr             # Merkle-Patricia Trie proof verification
│       └── account.nr         # Account verification + balance extraction
├── scripts/
│   └── compile.ts            # Compilation + artifact export script
├── package.json              # Bun package (JS deps for proving scripts)
└── README.md
```

## Prerequisites

- [nargo](https://noir-lang.org/) 1.0.0-beta.18+
- [bb](https://github.com/AztecProtocol/barretenberg) 3.0.0+ (for gate count / VK only; proving uses WASM)
- [Bun](https://bun.sh/) 1.0+

## Circuit: eth_balance

Proves that a user controls an Ethereum address with >= `min_balance` ETH and derives a deterministic nullifier.

### Constraints

1. **ECDSA secp256k1 signature verification** -- proves control of the private key
2. **Address derivation** -- `keccak256(pubkey_x || pubkey_y)[12..32] == address`
3. **Balance check** -- `balance >= min_balance`
4. **Nullifier** -- `poseidon2(pubkey_x_field, pubkey_y_field, epoch)` -- deterministic per-key-per-epoch

### Inputs

| Input | Type | Visibility | Description |
|-------|------|------------|-------------|
| sig_r | [u8; 32] | private | ECDSA signature R component |
| sig_s | [u8; 32] | private | ECDSA signature S component |
| pubkey_x | [u8; 32] | private | Public key X coordinate |
| pubkey_y | [u8; 32] | private | Public key Y coordinate |
| message_hash | [u8; 32] | private | EIP-191 prefixed message hash |
| address | [u8; 20] | private | Ethereum address |
| balance | Field | private | Balance in wei |
| epoch | Field | **public** | Current epoch (week number) |
| min_balance | Field | **public** | Minimum required balance (wei) |
| nullifier | Field | **public** | Poseidon2 nullifier |

### Dependencies

- `keccak256` (noir-lang/keccak256 v0.1.0) -- Ethereum-compatible hashing
- `poseidon` (noir-lang/poseidon v0.1.1) -- ZK-friendly nullifier hashing

### Privacy Guarantees

- Address, signature, balance, and public key are **private** (never revealed)
- Only the nullifier, epoch, and min_balance are **public**
- The nullifier is derived from the public key (not the signature), ensuring determinism regardless of ECDSA nonce randomness
- Same key + same epoch = same nullifier (prevents double-claiming)
- Different epochs = different nullifiers (cross-epoch unlinkability)

## Usage

### Compile

```bash
cd eth_balance && nargo compile
# Or from project root:
bun run --filter '@abetterfaucet/circuits' compile
```

### Test

```bash
cd eth_balance && nargo test
# Or:
bun run --filter '@abetterfaucet/circuits' test
```

### Generate Witness Inputs

Requires `PRIVATE_KEY` and `ORIGIN_RPC_URL` in `.env`:

```bash
cd eth_balance
bun --env-file=../../../.env run scripts/generate_prover_toml.ts > Prover.toml
```

### Prove + Verify

```bash
cd eth_balance
nargo compile              # compile circuit
nargo execute              # solve witness
bun run scripts/prove.ts   # generate + verify UltraHonk proof (~6s)
```

### Gate Count

```bash
bb gates -b eth_balance/target/eth_balance.json
# ~59,827 gates
```

## Library: ethereum

Custom Noir library for Ethereum state proof verification, built as a nargo 1.0.0-compatible replacement for the vlayer noir-ethereum-history-api.

### Modules

| Module | Description |
|--------|-------------|
| `types` | Type aliases: `Address`, `Bytes32`, `Hash` |
| `fragment` | `Fragment<N>` -- a view into a `[u8; N]` with offset/length tracking |
| `arrays` | `memcpy_up_to_length`, `sub_array_equals_up_to_length` |
| `bytes` | `byte_to_nibbles`, `bytes_to_nibbles`, `right_pad` |
| `rlp` | RLP decoding: `decode_to_rlp_header`, `decode_list`, `decode_list_of_small_strings` |
| `mpt` | MPT proof verification: `verify_merkle_proof`, node hash checks, branch/extension/leaf handling |
| `account` | `verify_account_balance` -- verifies account proof and extracts balance |

### Key Types

```noir
// MPT proof structure
struct Proof<let MAX_DEPTH: u32, let MAX_LEAF_LEN: u32> {
    nodes: [[u8; 532]; MAX_DEPTH],  // internal nodes (branch/extension)
    leaf: [u8; MAX_LEAF_LEN],       // leaf node
    depth: u32,                      // actual proof depth
}

// Full proof input for account verification
type AccountProofInput = ProofInput<66, 110, 10, 148>;
```

### Public API

```noir
use ethereum::account::verify_account_balance;

// Verifies MPT proof and returns the balance as a Field.
let balance = verify_account_balance(address, state_root, proof_input);
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_NODE_LEN` | 532 | Max RLP-encoded MPT node size |
| `MAX_ACCOUNT_LEAF_LEN` | 148 | Max leaf node size for accounts |
| `MAX_ACCOUNT_STATE_LEN` | 110 | Max RLP-encoded account state |
| `MAX_ACCOUNT_DEPTH` | 10 | Max internal nodes in proof |

### Test

```bash
cd ethereum && nargo test
# 7 tests (RLP decoding, nibble conversion, balance extraction)
```

## Known Issues

- **bb CLI prove fails** with a bignum assertion error (even on trivial circuits). This is a known issue with bb 3.0.0-nightly.20260102. Use the JS/WASM path (`@noir-lang/noir_js` + `@aztec/bb.js`) instead.
- **vlayer MPT library incompatible** with nargo 1.0.0 (`unsafe` became a reserved keyword, `dep::std` import paths changed). Replaced by the custom `ethereum/` library above.
