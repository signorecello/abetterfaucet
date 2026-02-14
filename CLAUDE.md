# zk_faucet

Privacy-preserving testnet faucet using ZK storage proofs. Users prove they hold >= 0.01 ETH on Ethereum mainnet via a Noir ZK circuit, then receive testnet funds at a different address with no link between identities.

## Quick Reference

```bash
bun install                # install deps
bun run dev                # build frontend + start server (watch mode)
bun run test               # run all tests (181 total)
```

## Project Structure

Bun workspaces monorepo with 6 packages:

```
packages/
  circuits/    # Noir ZK circuits + ethereum MPT library
  contracts/   # NullifierRegistry.sol (Hardhat + OpenZeppelin v5)
  server/      # Hono API server (Bun runtime)
  client/      # CLI tool for wallet + proof generation
  frontend/    # Vanilla TS/CSS SPA with MetaMask
  e2e/         # End-to-end integration tests
```

## Stack

- **Runtime**: Bun (package manager, test runner, bundler)
- **Server**: Hono + pino + valibot
- **ZK**: Noir circuits, Barretenberg WASM verifier (UltraHonk), bb.js
- **Blockchain**: viem, Hardhat, OpenZeppelin v5
- **Storage**: SQLite (bun:sqlite) for nullifiers

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
- **Private**: sig_r, sig_s, pubkey_x, pubkey_y, address, proof_key, proof_value, proof_nodes, proof_leaf, proof_depth
- **Public**: state_root (32 bytes), epoch, min_balance, nullifier

### Circuit Constants (from lib/ethereum)
```
MAX_NODE_LEN = 532
MAX_ACCOUNT_LEAF_LEN = 148
MAX_ACCOUNT_STATE_LEN = 110
MAX_ACCOUNT_DEPTH = 10
MAX_PREFIXED_KEY_LEN = 66
```

### Circuit Commands (run from packages/circuits/)
```bash
bun run eth_balance:generate   # fetch eth_getProof, generate Prover.toml
bun run eth_balance:execute    # compile + execute witness (fast check)
bun run eth_balance:prove      # generate + verify full ZK proof (~85s)
nargo test                     # run circuit unit tests (5 tests)
```

### Ethereum Library (packages/circuits/lib/ethereum/)
Custom Noir library (no external deps beyond keccak256) providing:
- `mpt.nr` - Full Merkle-Patricia Trie proof verification
- `account.nr` - Account balance extraction via `verify_account_balance()`
- `rlp.nr` - RLP decoding
- `bytes.nr`, `fragment.nr`, `arrays.nr` - Utilities

### Test Circuit
`packages/circuits/test/ethereum_test/` - Standalone MPT proof test circuit.
```bash
bun run storage_proof_test:generate  # generate MPT test inputs
bun run storage_proof_test:execute   # execute test circuit
```

## Server: packages/server/

Hono API with modular proof verification.

### Key Concepts
- **ProofModule** interface (`src/lib/modules/types.ts`): pluggable proof verification
- **ModuleRegistry**: registers proof modules, looked up by `moduleId`
- **NullifierStore** (`bun:sqlite`): race-safe with `INSERT OR IGNORE`
- **FundDispatcher**: sends testnet ETH via viem wallet clients
- **StateRootOracle**: validates state roots against recent L1 blocks

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
cd packages/server && bun test     # 61 tests
cd packages/contracts && npx hardhat test  # 11 tests
cd packages/client && bun test     # 35 tests
cd packages/e2e && bun test        # 38 tests
```

## Design Decisions

- **Nullifier**: `poseidon2(pubkey_x, pubkey_y, epoch)` using recovered public key (deterministic, avoids PLUME dependency)
- **Noir comments**: ASCII only (no unicode arrows/dashes)
- **MPT proof**: Custom Noir implementation (not vlayer -- vlayer not ported to nargo 1.0.0)
- **TOML arrays**: `generate_prover_toml.ts` outputs hex byte arrays (`[0x05, 0x8b, ...]`); 2D arrays for `proof_nodes`
- **Epoch padding**: Epoch is zero-padded to 10 digits in domain message for fixed-length in-circuit computation
- **In-circuit message hash**: `message_hash` is computed in-circuit from epoch (prevents signature replay attacks)
- **Proof generation**: ~85s with UltraHonk WASM, 35 public inputs (32 state_root bytes + epoch + min_balance + nullifier)
- **Server verification**: Real UltraHonk verification via `@aztec/bb.js` (no mock verifier)

## Environment Variables

Required: `ETH_RPC_URL`, `FAUCET_PRIVATE_KEY` (also `PRIVATE_KEY` for circuit scripts).
See `.env.example` for all options.
