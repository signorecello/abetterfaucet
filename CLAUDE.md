# A Better Faucet

Privacy-preserving testnet faucet using ZK storage proofs. Users prove they hold sufficient ETH on a configurable origin chain via a Noir ZK circuit, then receive testnet funds at a different address with no link between identities.

## Quick Reference

```bash
bun install                # install deps
bun run build              # compile circuits + build frontend
bun run dev                # start server (watch mode)
bun run test               # run all tests (130 pass + 3 skip + 4 require frontend build)
```

## Project Structure

Bun workspaces monorepo with 4 packages:

```
packages/
  circuits/    # Noir ZK circuits (uses noir-lang/eth-proofs for MPT verification)
  server/      # Hono API server (Bun runtime)
  frontend/    # React SPA (Vite + Reown AppKit for wallet, bb.js for in-browser proving)
  e2e/         # End-to-end integration tests
```

## Stack

- **Runtime**: Bun (package manager, test runner, bundler)
- **Server**: Hono + pino + valibot
- **Frontend**: React 19 + Vite, Reown AppKit + wagmi for wallet, bb.js for in-browser proving
- **ZK**: Noir circuits, Barretenberg WASM verifier (UltraHonk), bb.js
- **Blockchain**: viem
- **Storage**: SQLite (bun:sqlite) for nullifiers and claim records

## Circuit: packages/circuits/

The core ZK circuit is at `packages/circuits/bin/eth_balance/src/main.nr`.

### Circuit Constraints (6 total)
1. Message hash derivation from epoch (EIP-191 domain message, computed in-circuit)
2. ECDSA secp256k1 signature verification
3. Address derivation: `keccak256(pubkey_x || pubkey_y)[12..32] == address`
4. MPT account proof verification against `state_root` -> extracts verified balance
5. Balance check: `verified_balance >= min_balance`
6. Nullifier: `poseidon2(pubkey_x, pubkey_y, epoch)`

### Domain Message Format
The circuit computes the message hash in-circuit from the public epoch input:
- Domain message (50 bytes): `"zk_faucet_v1:eth-balance:nullifier_seed:" + epoch_padded_10_digits`
- EIP-191 wrapped (78 bytes): `"\x19Ethereum Signed Message:\n50" + domain_message`
- Hash: `keccak256(eip191_message)`

### Circuit Inputs
- **Private**: sig_r, sig_s, pubkey_x, pubkey_y, address, account_nonce, account_balance, account_storage_root, account_code_hash, proof_key, proof_value, proof_nodes, proof_leaf, proof_depth
- **Public**: state_root (32 bytes), epoch, min_balance, nullifier

### Circuit Constants (from eth-proofs)
```
MAX_NODE_LEN = 532
MAX_ACCOUNT_LEAF_LEN = 148
MAX_ACCOUNT_STATE_LEN = 110
MAX_ACCOUNT_DEPTH_NO_LEAF_M = 10
MAX_PREFIXED_KEY_NIBBLE_LEN = 66
```

### Circuit Commands (run from packages/circuits/)
```bash
bun run eth_balance:generate   # fetch eth_getProof, generate Prover.toml
bun run eth_balance:execute    # compile + execute witness (fast check)
bun run eth_balance:prove      # generate + verify full ZK proof (~85s)
```

Circuit unit tests must be run from individual crate directories (no workspace-level Nargo.toml):
```bash
cd packages/circuits/bin/eth_balance && nargo test   # 7 tests (circuit logic)
```

### Ethereum Library (vendored eth-proofs)
Uses `noir-lang/eth-proofs` (vendored at `packages/circuits/vendor/eth-proofs/`) with visibility patches (`pub(crate)` -> `pub`) for:
- `verifiers` and `merkle_patricia_proofs` modules in `lib.nr`
- `Account` struct fields in `account_with_storage.nr`
- `Proof`/`ProofInput` struct fields and constants in `merkle_patricia_proofs/proof.nr`
- Constants in `account.nr`

API: `verify_account(address, account, proof_input, state_root)` verifies the Account struct matches the MPT proof.

### Test Circuit
`packages/circuits/test/ethereum_test/` - Standalone MPT proof test circuit.
```bash
bun run storage_proof_test:generate  # generate MPT test inputs
bun run storage_proof_test:execute   # execute test circuit
```

## Server: packages/server/

Hono API with modular proof verification.

### Key Concepts
- **ProofModule** interface (`src/lib/modules/types.ts`): pluggable proof verification with `nullifierGroup` for cross-chain dedup
- **ModuleRegistry**: registers proof modules, looked up by `moduleId` (e.g. `eth-balance:1`, `eth-balance:8453`)
- **NullifierStore** (`bun:sqlite`): race-safe with `INSERT OR IGNORE`, `unspend()` for rollback; uses `nullifierGroup` (not moduleId) for dedup
- **ClaimStore** (`bun:sqlite`): persistent claim records (shares DB with NullifierStore)
- **FundDispatcher**: sends testnet ETH via viem wallet clients
- **StateRootOracle**: validates state roots against recent blocks (one per origin chain, parameterized block time)
- **Origin chains** (`src/lib/origin-chains.ts`): `loadOriginChains()` returns supported origin chains (Ethereum, Base) with RPC URLs

### API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/claim` | POST | Submit ZK proof, receive testnet funds |
| `/status/:claimId` | GET | Check claim status + tx hash |
| `/networks` | GET | List enabled testnets |
| `/modules` | GET | List proof modules + current epoch |
| `/circuits/:moduleId/artifact.json` | GET | Download circuit artifact |
| `/health` | GET | Health check |

### Tests
```bash
cd packages/server && bun test     # 68 tests (65 pass + 3 skip)
cd packages/e2e && bun test        # 69 tests (65 pass + 4 require frontend build)
```

## Frontend: packages/frontend/

React 19 SPA built with Vite. Wallet integration via Reown AppKit + wagmi v3.

### Architecture
- **React 19** + **wagmi v3** (React hooks) + **@tanstack/react-query**
- **Reown AppKit** (`@reown/appkit` + `@reown/appkit-adapter-wagmi`) for wallet modal (MetaMask, WalletConnect, Coinbase, etc.)
- **Hooks**: `useClaim`, `useProver`, `useStorageProof`, `useEpoch`, `useNetworks`
- **Steps**: `StepContainer` (collapsible), `StepList` (orchestrator), `ConnectStep`, `ProveStep`, `ClaimStep`
- **2-step UI**: Connect Wallet -> Generate Proof & Claim (linear step flow)
- **Lib layer**: `api.ts`, `prove.ts`, `wallet-config.ts`

### Key Design
- **Multi-origin-chain**: Users can prove balance on any supported mainnet (Ethereum, Base). Origin chains come from `/modules` at runtime.
- **No server RPC leak**: Origin chain RPC URLs are server-only; never exposed to the browser
- **Wallet provider for RPC**: Balance queries use `http()` transport (chain's public RPC); `getStorageProof()` uses AppKit's `walletProvider` via `useAppKitProvider('eip155')` for `eth_getProof`
- **Origin chain dropdown**: ClaimStep shows origin chain selector with balances. Chain switch prompts wallet.
- **Min balance from env**: `VITE_MIN_BALANCE_WEI` is the single source of truth for the balance threshold (modules also expose it via `/modules`)
- **AppKit setup**: `wallet-config.ts` creates `WagmiAdapter` + `createAppKit` with all origin chains configured

### Vite Config
- `envDir: '../..'` — loads `.env` from the monorepo root (not `packages/frontend/`)
- `VITE_*` env vars are inlined at build time via `import.meta.env`

## Design Decisions

- **Nullifier**: `poseidon2(pubkey_x, pubkey_y, epoch)` using recovered public key (deterministic, avoids PLUME dependency)
- **Noir comments**: ASCII only (no unicode arrows/dashes)
- **MPT proof**: Uses `noir-lang/eth-proofs` library (vendored with visibility patches)
- **TOML arrays**: `generate_prover_toml.ts` outputs hex byte arrays (`[0x05, 0x8b, ...]`); 2D arrays for `proof_nodes`
- **Epoch padding**: Epoch is zero-padded to 10 digits in domain message for fixed-length in-circuit computation
- **In-circuit message hash**: `message_hash` is computed in-circuit from epoch (prevents signature replay attacks)
- **Proof generation**: ~85s with UltraHonk WASM, 35 public inputs (32 state_root bytes + epoch + min_balance + nullifier)
- **Server verification**: Real UltraHonk verification via `@aztec/bb.js` (no mock verifier)
- **No /config endpoint**: Frontend does not fetch config from server; all config via VITE_* build-time env vars
- **Multi-origin nullifier**: All `eth-balance:*` modules share `nullifierGroup = "eth-balance"` so one user can't claim via different origin chains in the same epoch
- **Origin chains**: Hardcoded list in `origin-chains.ts` (Ethereum, Base) with env var RPC overrides. Frontend discovers available chains from `/modules` response.

## Environment Variables

All config lives in a single root `.env`. The server loads it via `--env-file=../../.env` in package.json. Vite reads it via `envDir: '../..'` — only `VITE_*` vars reach the browser. Shared vars use the `VITE_` prefix so both server and frontend can read them directly (no aliases needed).

### Root `.env` — all config (server + frontend)
| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_MIN_BALANCE_WEI` | **Yes** | Minimum balance threshold in wei |
| `VITE_EPOCH_DURATION` | No | Epoch duration in seconds (default: 604800 = 1 week) |
| `VITE_ORIGIN_CHAINID` | No | Default origin chain for wallet connection (default: 1) |
| `VITE_REOWN_PROJECT_ID` | No | Reown project ID for WalletConnect (get from cloud.reown.com) |
| `FAUCET_PRIVATE_KEY` | **Yes** | 0x-prefixed private key holding testnet funds |
| `PORT` | No | Server port (default: 3000) |
| `HOST` | No | Server host (default: 0.0.0.0) |
| `LOG_LEVEL` | No | Pino log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: `*`) |
| `DB_PATH` | No | SQLite database path (default: `./data/nullifiers.db`) |
| `ETHEREUM_RPC_URL` | No | Ethereum mainnet RPC URL (falls back to public RPC) |
| `BASE_RPC_URL` | No | Base mainnet RPC URL (falls back to public RPC) |
| `ARBITRUM_RPC_URL` | No | Arbitrum mainnet RPC URL (falls back to public RPC) |
| `SEPOLIA_RPC_URL` | No | Sepolia RPC URL (falls back to public RPC) |
| `BASE_SEPOLIA_RPC_URL` | No | Base Sepolia RPC URL (falls back to public RPC) |
| `ARBITRUM_SEPOLIA_RPC_URL` | No | Arbitrum Sepolia RPC URL (falls back to public RPC) |

### `packages/circuits/.env` — self-contained (independent chain target)
| Variable | Required | Description |
|----------|----------|-------------|
| `ORIGIN_CHAINID` | **Yes** | Chain ID for proof generation (can differ from server) |
| `MIN_BALANCE_WEI` | **Yes** | Minimum balance threshold in wei |
| `ORIGIN_RPC_URL` | **Yes** | RPC URL for the target chain |
| `PRIVATE_KEY` | **Yes** | Private key of account to prove balance for |
