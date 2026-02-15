# zk_faucet

A privacy-preserving testnet faucet that uses zero-knowledge storage proofs to verify Ethereum mainnet balances without revealing user identity.

Users prove they hold at least 0.01 ETH on Ethereum mainnet by generating a ZK proof over their account's Merkle-Patricia Trie (MPT) inclusion in the state trie. The faucet server verifies the proof and sends testnet ETH to a completely separate recipient address. At no point does the server learn which mainnet address generated the proof.

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [ZK Circuit](#zk-circuit)
- [Security Model](#security-model)
- [Getting Started](#getting-started)
- [Running the Project](#running-the-project)
- [Testing](#testing)
- [API Reference](#api-reference)
- [Circuit Details](#circuit-details)
- [Design Decisions](#design-decisions)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [Stack](#stack)
- [License](#license)

## How It Works

1. The user connects their mainnet wallet and signs an epoch-specific domain message.
2. A ZK proof is generated client-side proving:
   - The user controls an Ethereum private key (via ECDSA signature verification).
   - The corresponding address holds at least 0.01 ETH (via MPT storage proof against a recent state root).
   - A deterministic nullifier derived from the public key and current epoch.
3. The proof is submitted to the faucet server along with the desired testnet recipient address.
4. The server verifies the proof cryptographically (UltraHonk via Barretenberg WASM), checks the nullifier has not been spent in this epoch, validates the state root is recent (within 256 blocks), and dispatches testnet ETH.
5. The nullifier prevents the same key from claiming more than once per epoch (1 week), but the server never learns which mainnet address was used.

**Privacy guarantees:** The address, public key, signature, account balance, and MPT proof data are all private circuit inputs. Only the nullifier, epoch, minimum balance threshold, and state root are public. The nullifier is a Poseidon2 hash of the public key coordinates and epoch -- it cannot be reversed to recover the address.

## Architecture

```
                          +------------------+
                          |    Frontend      |
                          |  (Vanilla TS)    |
                          |  MetaMask wallet |
                          +--------+---------+
                                   |
                          signs domain message,
                          submits proof + recipient
                                   |
                                   v
+----------------+        +------------------+        +------------------+
|   Client CLI   | -----> |   Hono Server    | -----> | Testnet RPC      |
| (alternative)  |        |                  |        | (Sepolia, etc.)  |
+----------------+        |  - Proof verify  |        +------------------+
                          |  - Nullifier DB  |
                          |  - State root    |
                          |    oracle        |
                          +--------+---------+
                                   |
                          validates state root
                          against recent L1 blocks
                                   |
                                   v
                          +------------------+
                          |  Ethereum L1 RPC |
                          |  (state roots)   |
                          +------------------+


ZK Proof Generation (client-side):

  Private Key --> Sign epoch message --> ECDSA sig (r, s)
       |
       +--> Derive pubkey (x, y) --> keccak256 --> address
       |
       +--> eth_getProof(address) --> MPT account proof
       |
       +--> Poseidon2(pubkey_x, pubkey_y, epoch) --> nullifier

  All above fed into Noir circuit --> UltraHonk proof (~85s)

  Public outputs: [state_root (32 bytes), epoch, min_balance, nullifier]
```

### Package Structure

| Package | Description |
|---------|-------------|
| `packages/circuits` | Noir ZK circuit (`eth_balance`) with custom Ethereum MPT verification library |
| `packages/contracts` | `NullifierRegistry.sol` -- on-chain nullifier audit trail (Ownable, OpenZeppelin v5) |
| `packages/server` | Hono API server with real Barretenberg proof verification (Bun runtime) |
| `packages/client` | CLI tool for wallet interaction, epoch queries, and proof generation |
| `packages/frontend` | Vanilla TypeScript/CSS single-page app with MetaMask integration |
| `packages/e2e` | End-to-end integration tests with in-process test server |

### Claim Flow (Server-Side)

1. Parse and validate the request body with valibot schemas.
2. Look up the proof module by `moduleId` in the `ModuleRegistry`.
3. Validate public inputs: epoch matches current epoch, minimum balance meets threshold, state root is recent (within 256 L1 blocks).
4. Decode the hex proof and verify it with the Barretenberg UltraHonk WASM backend.
5. Attempt to record the nullifier via atomic `INSERT OR IGNORE` in SQLite (race-safe).
6. Dispatch testnet ETH via the `FundDispatcher` (viem wallet client).
7. Record the claim status and return the transaction hash.

## ZK Circuit

The core circuit is at `packages/circuits/bin/eth_balance/src/main.nr`. It enforces six constraints:

### Constraint 1: In-Circuit Message Hash Derivation

The circuit computes the EIP-191 message hash from the public `epoch` input, preventing signature replay attacks. The domain message format is fixed-length (50 bytes):

```
Domain message:  "zk_faucet_v1:eth-balance:nullifier_seed:" + epoch_padded_10_digits
EIP-191 wrapped: "\x19Ethereum Signed Message:\n50" + domain_message  (78 bytes total)
Hash:            keccak256(eip191_message)
```

The epoch is zero-padded to 10 digits (e.g., epoch 2928 becomes `"0000002928"`) so the message is always exactly 50 bytes, enabling fixed-length in-circuit computation.

### Constraint 2: ECDSA Signature Verification

Verifies the secp256k1 signature `(sig_r, sig_s)` against the provided public key `(pubkey_x, pubkey_y)` and the in-circuit computed message hash.

### Constraint 3: Address Derivation

Asserts that `keccak256(pubkey_x || pubkey_y)[12..32] == address`, ensuring the public key corresponds to the claimed Ethereum address.

### Constraint 4: MPT Account Proof Verification

Verifies a Merkle-Patricia Trie inclusion proof against the public `state_root`, walking branch and extension nodes to the leaf, then extracts the account's RLP-encoded balance. This uses a custom Ethereum library written in Noir (`packages/circuits/lib/ethereum/`).

### Constraint 5: Balance Check

Asserts `verified_balance >= min_balance` where `min_balance` is a public input (set to 0.01 ETH = 10^16 wei).

### Constraint 6: Nullifier Derivation

Computes `nullifier = Poseidon2(pubkey_x_field, pubkey_y_field, epoch)` and asserts it matches the public nullifier input. The nullifier is derived from the **public key** (not the signature) to ensure determinism regardless of ECDSA nonce randomness.

### Circuit Inputs

| Input | Visibility | Type | Description |
|-------|-----------|------|-------------|
| `sig_r`, `sig_s` | Private | `[u8; 32]` each | ECDSA signature components |
| `pubkey_x`, `pubkey_y` | Private | `[u8; 32]` each | secp256k1 public key coordinates |
| `address` | Private | `[u8; 20]` | Ethereum address |
| `proof_key` | Private | `[u8; 66]` | Left-padded keccak256(address) |
| `proof_value` | Private | `[u8; 110]` | Left-padded RLP-encoded account state |
| `proof_nodes` | Private | `[[u8; 532]; 10]` | MPT internal nodes (padded) |
| `proof_leaf` | Private | `[u8; 148]` | MPT leaf node (padded) |
| `proof_depth` | Private | `u32` | Number of proof nodes |
| `state_root` | **Public** | `[u8; 32]` | Ethereum state trie root |
| `epoch` | **Public** | `Field` | Current epoch number |
| `min_balance` | **Public** | `Field` | Minimum required balance (wei) |
| `nullifier` | **Public** | `Field` | Poseidon2 nullifier hash |

## Security Model

### What the ZK Proof Proves

- The prover controls a private key that derives to a valid Ethereum address.
- That address has an account balance at least `min_balance` in the Ethereum state trie at `state_root`.
- The prover signed an epoch-specific domain message with that key.
- The nullifier is correctly derived from the public key and epoch.

### What is Trusted

- **State root freshness:** The server validates that the submitted state root appears in the last 256 L1 blocks via its `StateRootOracle`, which polls the L1 RPC every 12 seconds.
- **Epoch correctness:** The server validates the epoch matches the current server epoch.
- **L1 RPC:** The server trusts its configured Ethereum RPC to return honest block headers.
- **Barretenberg verifier:** Proof verification relies on the `@aztec/bb.js` WASM UltraHonk backend.

### What is Private

| Data | Visibility |
|------|-----------|
| Mainnet address | Hidden (private circuit input) |
| Exact ETH balance | Hidden (only proves >= threshold) |
| Public key coordinates | Hidden (private circuit input) |
| ECDSA signature | Hidden (private circuit input) |
| MPT proof data | Hidden (private circuit input) |
| Link between mainnet and testnet identities | Hidden (never revealed) |

### Addressed Vulnerabilities

- **Unconstrained message hash (CRITICAL, Fixed):** The `message_hash` was previously a private input, allowing any existing ECDSA signature to be repurposed. Now computed in-circuit from the epoch.
- **Verifier stub in production (CRITICAL, Fixed):** The server previously had a stub verifier. Now uses real UltraHonk verification via `@aztec/bb.js`.
- **Public input field count mismatch (HIGH, Fixed):** `encodePublicInputs` now correctly produces 35 fields (32 state_root bytes + epoch + minBalance + nullifier).

See `SECURITY.md` for the full audit findings, including accepted risks and their rationale.

## Getting Started

### Prerequisites

- **[Bun](https://bun.sh/)** >= 1.1 -- package manager, runtime, test runner, bundler
- **[Nargo](https://noir-lang.org/docs/getting_started/installation/)** >= 1.0.0-beta -- Noir compiler (for circuit compilation)
- **Node.js** >= 18 -- required by Hardhat for contract compilation/testing
- **An Ethereum L1 RPC URL** -- Alchemy, Infura, or any mainnet endpoint

### Installation

```bash
git clone https://github.com/your-org/zk_faucet.git
cd zk_faucet
bun install
```

### Environment Setup

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ORIGIN_RPC_URL` | **Yes** | -- | Ethereum mainnet RPC URL (used for balance proofs and state root verification) |
| `FAUCET_PRIVATE_KEY` | **Yes** | -- | 0x-prefixed private key of the wallet holding testnet funds |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | No | `info` | Pino log level: debug, info, warn, error |
| `RATE_LIMIT_MAX` | No | `10` | Max requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in ms |
| `DISPENSATION_AMOUNT` | No | `0.1` | Testnet ETH to send per claim (in ETH) |
| `EPOCH_DURATION` | No | `604800` | Epoch length in seconds (default: 1 week) |
| `MIN_BALANCE_WEI` | No | `10000000000000000` | Minimum mainnet balance (0.01 ETH in wei) |
| `DB_PATH` | No | `./data/nullifiers.db` | SQLite database path for nullifiers |

#### Per-Network RPC Overrides

Target network RPC URLs (from `networks.json`) can be overridden via env vars. Use this when the default public RPCs are unreliable.

Pattern: `<NETWORK_ID>_RPC_URL` (uppercase, hyphens replaced with underscores).

| Variable | Description |
|----------|-------------|
| `SEPOLIA_RPC_URL` | Override Sepolia RPC (e.g. Alchemy, Infura) |
| `HOLESKY_RPC_URL` | Override Holesky RPC |

#### Testing / Debugging

| Variable | Description |
|----------|-------------|
| `TEST_ALLOW_BELOW_BALANCE` | Skip the CLI's early balance check. Proof generation proceeds but the circuit still enforces the minimum, so the proof will fail at the ZK level. |

For circuit scripts, you also need:

| Variable | Context | Description |
|----------|---------|-------------|
| `PRIVATE_KEY` | Circuit scripts | 0x-prefixed mainnet private key (the address to prove balance for) |
| `ORIGIN_RPC_URL` | Circuit scripts | Ethereum mainnet RPC URL (used by `generate_prover_toml.ts`) |

For contract deployment (optional):

| Variable | Description |
|----------|-------------|
| `DEPLOYER_PRIVATE_KEY` | Deployer wallet private key |

### Compile the Circuit

```bash
cd packages/circuits/bin/eth_balance
nargo compile
```

This produces `target/eth_balance.json`, required by both the server (for proof verification) and the client (for proof generation).

### Compile Contracts

```bash
cd packages/contracts
npx hardhat compile
```

## Running the Project

### Quick Start

```bash
bun install
cp .env.example .env
# Edit .env with your ORIGIN_RPC_URL and FAUCET_PRIVATE_KEY
bun run dev
# Open http://localhost:3000
```

Or use the guided setup script:

```bash
bash scripts/setup.sh
bun run dev
```

### Development Mode

Build the frontend and start the server with file watching:

```bash
bun run dev
```

This runs `bun run build:frontend` followed by the server in watch mode. The server serves the frontend SPA from `packages/frontend/public/` on `/` and `/public/*`.

### Production

```bash
cd packages/server
bun --env-file=../../.env src/index.ts
```

### Individual Packages

```bash
# Frontend build (one-time)
cd packages/frontend && bun run build

# Frontend build (watch mode)
cd packages/frontend && bun run dev

# Server only (watch mode)
cd packages/server && bun --env-file=../../.env --watch src/index.ts

# CLI client
cd packages/client
PRIVATE_KEY=0x... \
FAUCET_URL=http://localhost:3000 \
ORIGIN_RPC_URL=https://... \
RECIPIENT_ADDRESS=0x... \
TARGET_NETWORK=sepolia \
bun src/cli.ts claim
```

### CLI Commands

The client CLI (`packages/client/src/cli.ts`) supports:

```bash
bun src/cli.ts claim         # Generate proof and claim testnet ETH
bun src/cli.ts status <id>   # Check claim status
bun src/cli.ts networks      # List available testnet networks
bun src/cli.ts modules       # List available proof modules and epoch info
bun src/cli.ts help           # Show usage
```

The `claim` command performs the full flow: derive address, check balance, sign domain message, fetch `eth_getProof`, download circuit artifact from server, generate ZK proof, and submit the claim.

## Testing

184 tests total across all packages.

### Run All Tests

```bash
bun run test
```

### Run Tests by Package

```bash
# Server unit tests (66 tests)
cd packages/server && bun test

# Client unit tests (38 tests)
cd packages/client && bun test

# Contract tests via Hardhat (11 tests)
cd packages/contracts && npx hardhat test

# Circuit tests via Nargo (14 tests across 2 crates)
cd packages/circuits/bin/eth_balance && nargo test
cd packages/circuits/lib/ethereum && nargo test

# End-to-end tests (69 tests)
cd packages/e2e && bun test
```

### Convenience Scripts

```bash
bun run test:unit          # Server + client tests
bun run test:contracts     # Hardhat contract tests
bun run test:e2e           # End-to-end tests
```

### E2E Test Architecture

The E2E tests (`packages/e2e/`) build a fully functional faucet server in-process using mock components:

- **MockStateRootOracle** -- accepts a seeded test state root, no real L1 RPC calls.
- **MockFundDispatcher** -- returns fake transaction hashes.
- **In-memory SQLite** -- clean nullifier store per test run.
- Binds to port 0 for automatic port allocation (no conflicts).

When a real proof fixture exists (generated by `bun run eth_balance:prove`), the E2E tests use real Barretenberg verification. Otherwise, `verifyProof` is mocked at the module level so the HTTP flow can be tested without proof generation.

E2E test files cover:

| Test File | What it Tests |
|-----------|---------------|
| `full-claim-flow.test.ts` | Complete claim lifecycle |
| `double-claim-rejection.test.ts` | Nullifier uniqueness enforcement |
| `stale-state-root.test.ts` | State root freshness validation |
| `invalid-proof-rejection.test.ts` | Proof verification failure handling |
| `concurrent-claims.test.ts` | Race-safe nullifier deduplication |
| `malformed-payloads.test.ts` | Input validation and error responses |
| `cross-module-isolation.test.ts` | Module registry separation |
| `rate-limiting.test.ts` | Per-IP rate limiting |
| `frontend-api.test.ts` | Frontend API contract verification |

### Generating Proof Fixtures

To enable real proof verification in E2E tests:

```bash
cd packages/circuits

# Step 1: Generate Prover.toml from a real Ethereum account
bun run eth_balance:generate

# Step 2: Generate and verify a ZK proof (~85s, writes target/test-fixture.json)
bun run eth_balance:prove
```

The `prove.ts` script generates `target/test-fixture.json` containing the proof, public inputs, state root, epoch, and nullifier. E2E tests automatically detect and use this fixture when present.

## API Reference

All endpoints return JSON. Errors use the format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

### POST /claim

Submit a ZK proof to claim testnet funds.

**Request body:**

```json
{
  "moduleId": "eth-balance",
  "proof": "0xdeadbeef...",
  "publicInputs": {
    "stateRoot": "0xabc123...",
    "epoch": 2928,
    "minBalance": "10000000000000000",
    "nullifier": "0xdef456..."
  },
  "recipient": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "targetNetwork": "sepolia"
}
```

All hex fields must be 0x-prefixed. `recipient` must be a valid 40-character Ethereum address. `epoch` must be a non-negative integer. `minBalance` is a decimal string (wei).

**Response (200):**

```json
{
  "claimId": "0x1a2b3c...",
  "txHash": "0xabcdef...",
  "network": "sepolia",
  "amount": "100000000000000000"
}
```

**Error codes:**

| Code | HTTP Status | Cause |
|------|------------|-------|
| `INVALID_PUBLIC_INPUTS` | 400 | Schema validation failed, epoch mismatch, stale state root, or min balance too low |
| `INVALID_MODULE` | 400 | Unknown `moduleId` |
| `INVALID_PROOF` | 400 | Proof is empty or Barretenberg verification failed |
| `ALREADY_CLAIMED` | 409 | Nullifier already spent in this epoch |
| `DISPATCH_FAILED` | 500 | Failed to send testnet transaction |
| `RATE_LIMITED` | 429 | Too many requests from this IP |

### GET /status/:claimId

Check the status of a previous claim.

**Response (200):**

```json
{
  "claimId": "0x1a2b3c...",
  "status": "confirmed",
  "txHash": "0xabcdef...",
  "network": "sepolia"
}
```

Status values: `pending`, `confirmed`, `failed`.

**Error:** Returns 404 (`NOT_FOUND`) if the `claimId` does not exist.

### GET /modules

List available proof modules and the current epoch.

**Response (200):**

```json
{
  "modules": [
    {
      "id": "eth-balance",
      "name": "ETH Balance Proof",
      "description": "Proves ownership of >= 0.01 ETH on Ethereum mainnet without revealing the address",
      "currentEpoch": 2928,
      "epochDurationSeconds": 604800
    }
  ]
}
```

### GET /networks

List available testnet networks and their dispensation amounts.

**Response (200):**

```json
{
  "networks": [
    {
      "id": "sepolia",
      "name": "Sepolia",
      "chainId": 11155111,
      "explorerUrl": "https://sepolia.etherscan.io",
      "enabled": true,
      "dispensationWei": "100000000000000000"
    }
  ]
}
```

### GET /circuits/:moduleId/artifact.json

Download the compiled Noir circuit artifact for client-side proof generation. Returns the full JSON artifact produced by `nargo compile`.

**Error:** Returns 404 if the module or artifact does not exist. Run `nargo compile` to generate the artifact.

### GET /health

Health check endpoint.

**Response (200):**

```json
{
  "status": "ok",
  "uptime": 123456,
  "version": "0.1.0"
}
```

## Circuit Details

### Ethereum Library

The circuit uses a custom Noir library at `packages/circuits/lib/ethereum/src/` that implements full Ethereum state trie verification:

| Module | Purpose |
|--------|---------|
| `mpt.nr` | Full Merkle-Patricia Trie proof verification (branch, extension, and leaf nodes) |
| `account.nr` | Account proof verification and balance extraction from RLP-encoded account state |
| `rlp.nr` | RLP decoding (single bytes, short/long strings, short/long lists) |
| `bytes.nr` | Byte manipulation utilities (nibble conversion, left/right padding) |
| `fragment.nr` | Zero-copy byte array slicing with bounds checking |
| `arrays.nr` | Array comparison utilities |

This library has no external dependencies beyond `keccak256`. It was written from scratch because vlayer (the primary Noir MPT library) was not ported to nargo 1.0.0 at the time of development.

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_NODE_LEN` | 532 bytes | Maximum size of an RLP-encoded MPT internal node |
| `MAX_ACCOUNT_LEAF_LEN` | 148 bytes | Maximum size of an RLP-encoded MPT leaf node |
| `MAX_ACCOUNT_STATE_LEN` | 110 bytes | Maximum size of an RLP-encoded account state |
| `MAX_ACCOUNT_DEPTH` | 10 | Maximum MPT proof depth (internal nodes only) |
| `MAX_PREFIXED_KEY_LEN` | 66 bytes | Left-padded keccak256(address) key buffer |
| `MIN_BALANCE_WEI` | 10^16 (0.01 ETH) | Default minimum balance threshold |
| `EPOCH_DURATION_SECONDS` | 604,800 (1 week) | Default epoch length |
| `MAX_STATE_ROOT_AGE_BLOCKS` | 256 | Maximum age of accepted state roots |
| `EPOCH_PAD_LENGTH` | 10 | Digits used for zero-padded epoch in domain message |

### Proof Generation Benchmarks

| Metric | Value |
|--------|-------|
| Proof generation time | ~85 seconds (UltraHonk WASM, multi-threaded) |
| Proof size | ~16 KB |
| Public inputs | 35 fields (32 state_root bytes + epoch + min_balance + nullifier) |
| Backend | UltraHonk via `@aztec/bb.js` |
| Circuit tests | 14 nargo tests (7 eth_balance + 7 ethereum lib) |

### Circuit Commands

All commands run from the `packages/circuits/` directory:

```bash
# Generate Prover.toml from a real Ethereum account proof
# Requires PRIVATE_KEY and ORIGIN_RPC_URL in .env
bun run eth_balance:generate

# Compile and execute the circuit (fast witness check, no proof generation)
bun run eth_balance:execute

# Generate and verify a full ZK proof (~85 seconds)
# Also writes target/test-fixture.json for E2E tests
bun run eth_balance:prove

# Run circuit unit tests
nargo test
```

There is also a standalone MPT proof test circuit at `packages/circuits/test/ethereum_test/`:

```bash
bun run storage_proof_test:generate    # Generate MPT test inputs
bun run storage_proof_test:execute     # Execute test circuit
```

## Design Decisions

### Why Noir over Circom

Noir provides a higher-level language with native support for complex data structures, generics, and bounded loops. The MPT verification logic requires manipulating variable-length RLP data, recursive node traversal, and conditional branch/extension/leaf handling -- all of which are more naturally expressed in Noir than in Circom's R1CS constraint language.

### Why a Custom MPT Library

The existing Noir MPT implementations (primarily vlayer) were not ported to nargo 1.0.0 at the time of development. The custom library in `packages/circuits/lib/ethereum/src/` provides full MPT proof verification with branch, extension, and leaf node support, RLP decoding, and account balance extraction -- all with no external dependencies beyond `keccak256`.

### Why Poseidon2 for Nullifiers

Poseidon2 is a ZK-friendly hash function that is efficient inside arithmetic circuits (far cheaper than keccak256 in constraint count). The nullifier is `Poseidon2(pubkey_x, pubkey_y, epoch)`, using the **public key** as input rather than the signature. This ensures the nullifier is deterministic for a given key and epoch, regardless of ECDSA nonce randomness. This approach avoids the need for the PLUME protocol (verifiably deterministic signatures), which is not widely supported.

### Why In-Circuit Message Hash

The message hash was originally a private input, which meant any ECDSA signature ever produced by any Ethereum address could be used to forge a valid proof. The fix computes `keccak256(EIP-191 prefix || domain_message || epoch_padded)` inside the circuit from the public epoch input. This adds one keccak256 call on 78 bytes but eliminates signature replay attacks entirely.

### Epoch Padding Rationale

The epoch is zero-padded to 10 digits in the domain message (e.g., `"0000002928"`). This produces a fixed-length 50-byte domain message, which enables the circuit to compute the message hash with a single fixed-size keccak256 call rather than requiring variable-length input handling inside the circuit.

### Real Server Verification

The server uses real UltraHonk verification via `@aztec/bb.js`, not a mock verifier. The compiled circuit artifact (`eth_balance.json`) is loaded lazily and cached as a singleton `UltraHonkBackend` instance. No mock verifier escape hatch exists in production code.

### Pluggable Proof Modules

The server implements a `ProofModule` interface that decouples proof verification from the HTTP layer:

```typescript
interface ProofModule {
  id: string;
  name: string;
  description: string;
  validatePublicInputs(inputs: PublicInputs): Promise<ValidationResult>;
  verifyProof(proof: Uint8Array, publicInputs: PublicInputs): Promise<boolean>;
  currentEpoch(): number;
  epochDurationSeconds: number;
}
```

Modules are registered with the `ModuleRegistry` and looked up by `moduleId` at claim time. New proof types (e.g., ERC-20 balance, NFT ownership) can be added by implementing this interface.

### Nullifier Design

The nullifier is `poseidon2(pubkey_x, pubkey_y, epoch)` using the **recovered public key** -- not the signature components `(r, s, v)` directly. ECDSA signatures are non-deterministic: the same key and message can produce different `(r, s)` values depending on the nonce. The recovered public key is always the same for a given signer, making the nullifier deterministic per identity per epoch.

### Race-Safe Nullifier Store

The `NullifierStore` uses SQLite with `INSERT OR IGNORE` for atomic nullifier recording. Concurrent claims with the same nullifier result in exactly one success -- the first insertion wins, and subsequent attempts return `changes === 0`. The database uses WAL journaling mode and a 5-second busy timeout.

## Known Limitations

These findings are documented in detail in `SECURITY.md`.

### u64 Balance Truncation

The balance comparison casts to `u64`, which overflows for balances above ~18.4 ETH. This causes false negatives (valid proofs rejected) for very large balances, but is not a security risk since it never allows unauthorized claims. A future version should use a wider integer type.

### Flash Loan Balance Inflation

An attacker could use a flash loan to temporarily inflate their balance during proof generation. This is economically irrational for a testnet faucet -- the gas cost of the flash loan exceeds the value of free testnet tokens.

### ETH Recycling Across Addresses

A user could transfer 0.01 ETH between addresses to generate multiple proofs. Rate limiting by epoch (one claim per public key per week) bounds the attack rate, and the economic incentive is negligible.

### Timing Correlation

An observer could correlate proof submission times with on-chain activity to deanonymize users. Users seeking strong anonymity should use Tor or submit during high-traffic periods.

### Epoch Boundary Double-Claim

At the epoch boundary, a user could claim in the last seconds of epoch N and the first seconds of epoch N+1 using different nullifiers. This is by design -- epochs represent weekly windows, and the boundary edge case allows at most 2 claims in quick succession.

### X-Forwarded-For Spoofing

The IP-based rate limiter uses `X-Forwarded-For`, which can be spoofed if the server is not behind a trusted reverse proxy. In production, deploy behind nginx or Cloudflare.

### MPT Depth Cap

The circuit limits MPT proof depth to 10 nodes. The current Ethereum state trie depth is typically 7-8 for account proofs, so this provides sufficient headroom. The constant can be increased in a future circuit version if needed.

### BN254 Field Truncation

Converting 32-byte public key coordinates to BN254 field elements causes reduction modulo the BN254 prime. The probability of a collision is astronomically low (~2^{-2}) and negligible for a testnet faucet.

### Nullifier Store Growth

The SQLite nullifier store grows indefinitely. Old nullifiers from past epochs can be safely pruned as a future operational improvement.

### Cross-Faucet Nullifier Reuse

The same public key produces the same nullifier for the same epoch across different faucet deployments. If multiple faucets are deployed, they should use different domain message prefixes.

## Contributing

### Adding a New Proof Module

1. Create a new directory under `packages/server/src/lib/modules/<module-name>/`.
2. Implement the `ProofModule` interface in a `module.ts` file (see `eth-balance/module.ts` for reference).
3. Implement proof verification in a `verifier.ts` file.
4. Define constants in a `constants.ts` file.
5. Register the module in `packages/server/src/index.ts`:
   ```typescript
   registry.register(new YourNewModule(oracle, options));
   ```
6. Write the corresponding Noir circuit under `packages/circuits/bin/<circuit-name>/`.
7. Add unit tests to `packages/server/test/` and E2E tests to `packages/e2e/test/`.

### Modifying the Circuit

1. Edit the circuit source at `packages/circuits/bin/eth_balance/src/main.nr`.
2. Run circuit tests: `cd packages/circuits && nargo test`.
3. Recompile: `cd packages/circuits/bin/eth_balance && nargo compile`.
4. Regenerate the Prover.toml if inputs changed: `cd packages/circuits && bun run eth_balance:generate`.
5. Test witness execution: `cd packages/circuits && bun run eth_balance:execute`.
6. Generate a full proof to verify end-to-end: `cd packages/circuits && bun run eth_balance:prove`.
7. Update `encodePublicInputs` in `packages/server/src/lib/modules/eth-balance/verifier.ts` if public inputs changed.
8. Regenerate E2E test fixtures by re-running `bun run eth_balance:prove` (writes `target/test-fixture.json`).

**Important:** Noir comments must use ASCII only -- no unicode arrows, dashes, or special characters, or the Noir compiler will reject the file.

### Adding a New Testnet Network

Edit `networks.json` at the project root:

```json
{
  "networks": [
    {
      "id": "your-network",
      "name": "Your Network",
      "chainId": 12345,
      "rpcUrl": "https://rpc.your-network.io",
      "explorerUrl": "https://explorer.your-network.io",
      "enabled": true,
      "dispensationWei": "100000000000000000"
    }
  ]
}
```

The server reads this file at startup. Ensure the faucet wallet (`FAUCET_PRIVATE_KEY`) holds funds on the new network.

## Stack

| Technology | Usage |
|-----------|-------|
| [Bun](https://bun.sh) | Runtime, package manager, test runner, bundler |
| [Hono](https://hono.dev) | HTTP framework (server) |
| [Noir](https://noir-lang.org) | ZK circuit language |
| [Barretenberg / bb.js](https://github.com/AztecProtocol/aztec-packages) | UltraHonk ZK proof backend (WASM) |
| [viem](https://viem.sh) | Ethereum client library (RPC, signing, transactions) |
| [Hardhat](https://hardhat.org) | Solidity development framework |
| [OpenZeppelin v5](https://docs.openzeppelin.com/contracts/5.x/) | Smart contract libraries (Ownable) |
| [SQLite (bun:sqlite)](https://bun.sh/docs/api/sqlite) | Nullifier persistence |
| [pino](https://getpino.io) | Structured JSON logging |
| [valibot](https://valibot.dev) | Schema validation for API inputs |

## License

MIT
