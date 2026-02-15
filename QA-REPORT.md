# QA Report: zk_faucet

**Date:** 2026-02-14
**Auditor:** QA Engineer (automated analysis)
**Scope:** All 6 packages in the zk_faucet monorepo
**Test Results:** 181 tests, 0 failures, 0 skips

---

## 1. Test Inventory

### 1.1 Package Breakdown

| Package | Tests | Files Tested | Key Areas |
|---------|-------|-------------|-----------|
| **client** | 35 | epoch.ts, prove.ts, wallet.ts | Epoch math, input formatting, wallet signing, artifact loading |
| **server** | 66 | nullifier-store.ts, claim route, eth-balance module, fund-dispatcher.ts | Nullifier dedup, claim API, proof verification, public input validation, fund dispatch |
| **contracts** | 11 | NullifierRegistry.sol | On-chain nullifier recording, access control, events |
| **e2e** | 69 | 8 test files | Full claim flow, double-claim, stale roots, invalid proofs, concurrency, malformed payloads, cross-module isolation, rate limiting, frontend API, static files |
| **circuits** | 7 (Noir) | main.nr, account.nr, rlp.nr | u32-to-decimal, message hash, bytes32-to-field, balance check, nullifier determinism, key-to-nibbles, extract-balance, RLP decode |
| **frontend** | 0 | (none) | No tests exist |

**Total: 181 TypeScript/Solidity tests + 7 Noir circuit tests = 188 total test functions**

### 1.2 Files With Test Coverage

| Source File | Test Coverage | Notes |
|-------------|--------------|-------|
| `server/src/lib/nullifier-store.ts` | Strong | 19 tests including SQL injection, concurrency, edge cases |
| `server/src/routes/claim.ts` | Strong | 20 tests covering validation, errors, edge cases |
| `server/src/lib/modules/eth-balance/module.ts` | Strong | 19 tests on validatePublicInputs + encodePublicInputs |
| `server/src/lib/modules/eth-balance/verifier.ts` | Partial | encodePublicInputs tested; verifyProof only with optional fixture |
| `server/src/lib/fund-dispatcher.ts` | Weak | 6 tests; only checks config lookup and unknown/disabled network errors |
| `server/src/routes/status.ts` | Via E2E | No dedicated unit tests; covered by E2E flows |
| `server/src/routes/circuits.ts` | Via E2E | Frontend API E2E covers /modules, /networks, /health; no unit tests for /circuits/:moduleId/artifact.json |
| `server/src/util/schemas.ts` | Indirect | Exercised through claim route tests; no dedicated schema tests |
| `server/src/util/errors.ts` | Indirect | AppError factory methods exercised through route tests |
| `server/src/util/env.ts` | None | loadConfig() and requireEnv() have zero test coverage |
| `server/src/util/logger.ts` | None | No tests |
| `server/src/lib/state-root-oracle.ts` | None | Always mocked; no unit tests for real oracle behavior |
| `server/src/lib/modules/registry.ts` | Indirect | Used in claim tests; no dedicated tests for register/get/list |
| `server/src/index.ts` | None | Server bootstrap, rate limiting middleware - only tested via E2E approximation |
| `client/src/epoch.ts` | Strong | 11 tests covering all exported functions |
| `client/src/wallet.ts` | Moderate | 7 tests for deriveAddress, signDomainMessage; fetchStorageProof only checked for existence |
| `client/src/prove.ts` | Moderate | 14 tests for formatInputsForCircuit, loadCircuitArtifact; generateProof only tests the "not implemented" throw |
| `client/src/cli.ts` | None | CLI entrypoint has zero test coverage |
| `client/src/types.ts` | N/A | Type definitions only |
| `frontend/src/api.ts` | None | ApiClient class untested |
| `frontend/src/wallet.ts` | None | MetaMask interaction, formatBalance, hasMinBalance, generateMockNullifier untested |
| `frontend/src/ui.ts` | None | All DOM helpers, escapeHtml, isValidAddress, formatWei untested |
| `frontend/src/main.ts` | None | Full application logic untested |
| `contracts/NullifierRegistry.sol` | Strong | All public functions tested with edge cases |
| `circuits/bin/eth_balance/src/main.nr` | Moderate | Helper functions tested; main() entry point only tested via full proof generation (not in test suite) |
| `circuits/lib/ethereum/src/mpt.nr` | Weak | Only tested via ethereum_test circuit with real proof data; no unit tests for individual functions |
| `circuits/lib/ethereum/src/rlp.nr` | Moderate | 5 Noir tests for decode functions |
| `circuits/lib/ethereum/src/account.nr` | Moderate | 2 Noir tests for key_to_nibbles and extract_balance |
| `circuits/lib/ethereum/src/bytes.nr` | None | byte_to_nibbles, bytes_to_nibbles, right_pad have no dedicated tests |
| `circuits/lib/ethereum/src/fragment.nr` | None | Fragment struct has no dedicated tests |
| `circuits/lib/ethereum/src/arrays.nr` | None | memcpy_up_to_length, sub_array_equals_up_to_length untested |

---

## 2. Coverage Gaps

### 2.1 Server Package

#### StateRootOracle (`server/src/lib/state-root-oracle.ts`) -- NO TESTS

This is a **security-critical** component that determines whether a state root is fresh enough to accept. It is always mocked in all tests.

**Untested scenarios:**
- `start()` initializing the refresh interval and making the first RPC call
- `stop()` clearing the interval correctly
- `refresh()` handling a block with no `stateRoot` field (the `warn` path)
- `refresh()` deduplication logic (not adding the same block twice)
- Cache pruning: entries older than `maxAge` blocks are removed
- `getLatestStateRoot()` when cache is empty (triggers refresh)
- `getLatestStateRoot()` when cache remains empty after refresh (throws "No state roots available")
- `isValidStateRoot()` when cache is empty (triggers refresh)
- `isValidStateRoot()` returning false for expired roots
- Refresh error handling (the `.catch` in the interval callback)
- Multiple rapid refreshes with the same block number
- Cache ordering: `getLatestStateRoot()` returns the most recent entry

#### ModuleRegistry (`server/src/lib/modules/registry.ts`) -- NO DEDICATED TESTS

**Untested scenarios:**
- `register()` throwing when a module with the same ID is already registered (the `"Module already registered"` error path)
- `get()` with undefined/empty string
- `list()` returning modules in registration order
- Registering multiple modules and verifying all are retrievable

#### FundDispatcher (`server/src/lib/fund-dispatcher.ts`) -- WEAK COVERAGE

**Untested scenarios:**
- `dispatch()` with a custom `amountWei` parameter (line 118: the override branch)
- `dispatch()` successful transaction: verifying the returned `txHash` and `claimId` structure
- `getBalance()` for a valid network
- `getBalance()` for an unknown network (should throw)
- Wallet client caching: calling `dispatch()` twice for the same network reuses the client
- Public client caching in `getPublicClient()`
- `generateClaimId()` producing correctly formatted 32-character hex strings
- `getNetworks()` returning the correct count and order

#### Server Config (`server/src/util/env.ts`) -- NO TESTS

**Untested scenarios:**
- `loadConfig()` with all required env vars set correctly
- `requireEnv()` throwing when a required var is missing (`ETH_RPC_URL`, `FAUCET_PRIVATE_KEY`)
- `FAUCET_PRIVATE_KEY` not starting with `0x` (the explicit check on line 29-31)
- `optionalEnv()` falling back to default values
- `PORT` parsing with non-numeric string
- `MIN_BALANCE_WEI` parsing via BigInt from env var
- Integer overflow for `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`

#### Schema Validation (`server/src/util/schemas.ts`) -- NO DEDICATED TESTS

While schemas are exercised through claim route tests, there are no unit tests specifically for:
- `HexSchema` accepting/rejecting various hex formats (uppercase, mixed case, empty `0x`)
- `AddressSchema` with exactly 40 hex chars vs 39 or 41
- `PublicInputsSchema` with epoch = 0 (valid), epoch = -1 (invalid), epoch as float
- `ClaimRequestSchema` composition: ensuring all nested validation propagates

#### Circuits Route (`server/src/routes/circuits.ts`) -- NO UNIT TESTS

**Untested scenarios:**
- `GET /circuits/:moduleId/artifact.json` for existing module with existing artifact file
- `GET /circuits/:moduleId/artifact.json` for non-eth-balance module (the `moduleId !== "eth-balance"` branch on line 41)
- `GET /circuits/:moduleId/artifact.json` when artifact file does not exist (the `existsSync` check)
- `GET /circuits/:moduleId/artifact.json` for unknown module
- `CIRCUIT_ARTIFACT_PATH` env var override

#### Status Route (`server/src/routes/status.ts`) -- NO UNIT TESTS

Only tested through E2E. No unit tests for:
- Edge cases in claimId parameter (special characters, empty string, extremely long IDs)
- Claim records with different statuses ("pending", "failed")

#### Claim Route -- Missing Edge Cases

**Untested scenarios:**
- Request body that is valid JSON but with wrong content-type header
- `c.req.json()` throwing when body is not valid JSON (the Hono-level error)
- Dispatch succeeding but `getNetwork()` returning undefined for the `targetNetwork` (line 109: `network?.dispensationWei ?? "0"`)
- Claim record structure verification after successful claim (checking `createdAt`, `moduleId`, `recipient`)
- Race condition: nullifier spend succeeds but dispatch fails -- is the nullifier "burned"? (This is a design issue, not just a test gap. The nullifier is recorded before dispatch, so if dispatch fails, the user cannot retry.)

### 2.2 Client Package

#### CLI (`client/src/cli.ts`) -- NO TESTS

The CLI has 298 lines of code with zero test coverage.

**Untested scenarios:**
- `main()` routing: each command string (`claim`, `status`, `networks`, `modules`, `help`, unknown)
- `env()` function behavior when env var is missing (process.exit)
- `cmdClaim()` flow: address derivation, balance check (insufficient balance path), proof generation
- `cmdStatus()` with empty claimId
- `cmdNetworks()` and `cmdModules()` output formatting
- `httpGet()` and `httpPost()` error handling (non-ok responses)
- `hexToUint8Array()` with odd-length hex strings
- `hexToUint8Array()` with empty string
- `toHexString()` with empty Uint8Array

#### Wallet (`client/src/wallet.ts`) -- PARTIAL

**Untested scenarios:**
- `fetchStorageProof()` actual RPC behavior (only tests function exists and has correct arity)
- `fetchStorageProof()` with explicit `blockNumber` parameter
- `getBalance()` function (no tests at all)
- `signDomainMessage()` with epoch 0 (boundary)
- `signDomainMessage()` with very large epoch values (>10 digits, would overflow the zero-padding)

#### Prove (`client/src/prove.ts`) -- PARTIAL

**Untested scenarios:**
- `formatInputsForCircuit()` with empty `accountProofNodes` array
- `formatInputsForCircuit()` with single-element `accountProofNodes`
- `formatInputsForCircuit()` with zero balance (0n)
- `formatInputsForCircuit()` with zero nonce (0n)
- `formatInputsForCircuit()` with epoch 0
- `formatInputsForCircuit()` with max uint256 balance values
- `loadCircuitArtifact()` with malformed JSON response (non-JSON body on 200)
- `loadCircuitArtifact()` with network timeout

### 2.3 Frontend Package -- NO TESTS AT ALL

The entire frontend package (4 source files, ~790 lines of code) has zero test coverage. This is the largest coverage gap in the project.

#### `frontend/src/api.ts`

**Untested scenarios:**
- `ApiClient.request()` handling non-JSON error responses
- `ApiClient.request()` handling network failures
- `ApiRequestError` construction and properties
- `getNetworks()`, `getModules()`, `submitClaim()`, `getStatus()`, `getHealth()` response parsing
- `encodeURIComponent` in `getStatus()` for special characters in claimId

#### `frontend/src/wallet.ts`

**Untested scenarios:**
- `connectWallet()` when MetaMask is not installed
- `connectWallet()` when accounts array is empty
- `disconnectWallet()` cleanup
- `handleAccountsChanged()` with empty accounts (disconnects)
- `formatBalance()` with various values (0, very large, very small)
- `hasMinBalance()` boundary: exactly at threshold, below, above
- `generateMockNullifier()` determinism and uniqueness
- `stringToHex()` with special characters, empty string, unicode
- `onWalletChange()` callback mechanism

#### `frontend/src/ui.ts`

**Untested scenarios:**
- `escapeHtml()` with XSS payloads (`<script>`, `onclick`, `"`, `'`, `&`)
- `isValidAddress()` with various invalid formats
- `truncateAddress()` with addresses shorter than expected
- `formatWei()` with zero, very large values
- `formatEpochCountdown()` when epoch has ended (negative remaining)
- `getFriendlyError()` mapping for all error codes
- `getFriendlyError()` fallback for unknown error codes
- `statusBadgeHtml()` with unknown status values
- `getExplorerTxUrl()` URL construction

### 2.4 Contracts Package

The NullifierRegistry tests are relatively thorough, but some gaps remain.

**Untested scenarios:**
- Gas cost verification for `recordNullifier()` (important for production cost estimates)
- Re-entrancy attack surface (not applicable for this simple contract, but worth documenting)
- Ownership transfer via `transferOwnership()` (inherited from Ownable) and subsequent `recordNullifier()` access
- `renounceOwnership()` and verifying no one can record nullifiers afterward
- Batch operations: recording many nullifiers in a single block
- Event indexing: verifying the `nullifier` is properly indexed in `NullifierSpent` event

### 2.5 Circuits Package

#### Main Circuit (`circuits/bin/eth_balance/src/main.nr`)

The `main()` function (the actual ZK circuit entrypoint) is **never directly unit-tested** in the Noir test suite. It is only tested by running the full proof generation flow (85s, requires real RPC data).

**Untested scenarios:**
- `verify_signature()` with invalid signature (should fail assert)
- `verify_address_from_pubkey()` with mismatched address (should fail assert)
- `compute_message_hash()` with epoch 0 (boundary)
- `compute_message_hash()` result matching the off-chain EIP-191 computation (cross-verification)
- Balance check: `balance == min_balance` (exact equality boundary)
- Balance check: `balance < min_balance` (should fail assert)
- Nullifier mismatch (should fail assert)
- Integration between all 6 constraints working together with valid data

#### Ethereum Library

**Untested in `mpt.nr`:**
- `verify_merkle_proof()` with invalid node hash (should fail assert)
- `extract_hash()` with invalid node type (neither 17 nor 2 fields)
- `extract_hash_from_branch_node()` where the child hash field length is not 32
- `extract_hash_from_extension_node()` with key mismatch
- `verify_leaf()` with key mismatch, value mismatch
- `verify_node_hash()` with hash mismatch
- `parity()` with prefix >= 4 (should fail assert)

**Untested in `bytes.nr`:**
- `byte_to_nibbles()` for all edge values (0x00, 0xFF)
- `bytes_to_nibbles()` with empty fragment
- `right_pad()` with all-zero array (returns length 0)
- `right_pad()` with no leading zeros

**Untested in `fragment.nr`:**
- `Fragment::at()` with out-of-bounds index (should fail assert)
- `Fragment::pop_front()` from empty fragment (should fail assert)
- `Fragment::subfragment()` overflow check
- `Fragment::focus()` with smaller target size than length (should fail assert)
- `Fragment::eq_fragment()` with different lengths

**Untested in `arrays.nr`:**
- `memcpy_up_to_length()` with length > dest size (should fail assert)
- `sub_array_equals_up_to_length()` when arrays differ

### 2.6 Circuit Scripts (No Tests)

`generate_prover_toml.ts` and `prove.ts` are complex scripts (300 and 183 lines respectively) with zero test coverage.

**Untested scenarios in `generate_prover_toml.ts`:**
- `bytesToTomlArray()` with empty array
- `bigintToMinimalBytes()` with 0n, 1n, large values
- `padRight()` and `padLeft()` with data exceeding target length
- TOML output format correctness

**Untested scenarios in `prove.ts`:**
- `parseProverToml()` with various TOML formats (1D arrays, 2D arrays, quoted strings)
- `countBracketDepth()` edge cases
- `parseHexArray()` with malformed input
- `extractInnerArrays()` with nested arrays

---

## 3. Security-Critical Analysis

### 3.1 Nullifier Spend-Before-Dispatch (CRITICAL DESIGN CONCERN)

In `server/src/routes/claim.ts` (lines 79-96), the nullifier is recorded in the database **before** fund dispatch. If dispatch fails (network error, insufficient faucet balance, etc.), the nullifier is permanently "burned" -- the user cannot retry with the same nullifier because it is already marked as spent. However, the nullifier is derived from the public key and epoch, so the user would need to wait for the next epoch to claim again.

**This is not tested at all.** There is a test for dispatch failure returning 500, but it does not verify whether the nullifier was consumed.

### 3.2 Balance Check Overflow in Circuit

In `main.nr` line 205:
```
assert(balance as u64 >= min_balance as u64, "Balance below minimum threshold");
```

The balance is cast to `u64`, which supports values up to ~18.4 ETH. For accounts with more than 18.4 ETH, this would overflow silently in Noir, potentially causing the balance check to pass or fail incorrectly. The comment acknowledges this limitation but there are no tests for values near the `u64` boundary.

### 3.3 Zero Address Recipient

The E2E malformed payloads test verifies that `0x0000000000000000000000000000000000000000` is accepted as a valid recipient. Sending funds to the zero address would permanently burn them. The server has no policy check to reject zero-address recipients.

### 3.4 Proof Replay Across Epochs

The nullifier is epoch-bound (`poseidon2(pubkey_x, pubkey_y, epoch)`), which prevents replay within the same epoch. Cross-epoch replay is prevented because the epoch is validated server-side. However, there is no test verifying that a valid proof from epoch N is rejected when submitted during epoch N+1 with the proof's original epoch value (the server should reject it due to epoch mismatch).

### 3.5 Rate Limit Bypass via Header Spoofing

The rate limiter uses `x-forwarded-for` to identify clients (line 77 in `rate-limiting.test.ts`). An attacker can trivially bypass rate limiting by varying the `X-Forwarded-For` header. While this is tested (the "different IPs" test demonstrates it), there is no test verifying that rate limiting works when no proxy headers are present (falling back to "unknown").

### 3.6 Domain Message Mismatch Between Client and Circuit

The client wallet module uses `DOMAIN_MESSAGE = "zk_faucet_v1:eth-balance:nullifier_seed"` and the circuit hardcodes the same string byte-by-byte. However, there is **no cross-verification test** ensuring these strings match. If they ever diverge, proofs would silently fail.

---

## 4. Recommendations

### Critical Priority

| # | Test Scenario | Target File | Rationale |
|---|--------------|-------------|-----------|
| C1 | **Nullifier burned on dispatch failure**: After a dispatch failure (500), verify the nullifier IS spent in the store and a subsequent claim with the same nullifier returns 409 | `server/test/routes/claim.test.ts` | Security: users lose their once-per-epoch claim opportunity if dispatch fails |
| C2 | **StateRootOracle unit tests**: Test cache lifecycle (add, prune, dedup), empty cache fallback, refresh error handling | New file: `server/test/state-root-oracle.test.ts` | The oracle determines which state roots are accepted -- mocking it in every test means the real implementation is untested |
| C3 | **Cross-verification: domain message match between client and circuit**: Compute the EIP-191 hash of the domain message in TypeScript and compare it against a known expected value that the circuit also produces | `client/test/wallet.test.ts` or new cross-package test | A mismatch would make all proofs fail silently |
| C4 | **Circuit balance overflow test**: Test the circuit with balance values near u64 max (18.4 ETH) to document behavior | Circuit Noir test in `main.nr` | Silent overflow could lead to incorrect proof acceptance |

### High Priority

| # | Test Scenario | Target File | Rationale |
|---|--------------|-------------|-----------|
| H1 | **ModuleRegistry: duplicate registration** throws error | New file: `server/test/modules/registry.test.ts` | Prevents silent module overwrite in production |
| H2 | **FundDispatcher: successful dispatch** with mocked wallet client verifying txHash/claimId format | `server/test/fund-dispatcher.test.ts` | Current test only covers error paths |
| H3 | **Server config validation**: missing required env vars, invalid private key format, non-numeric port | New file: `server/test/util/env.test.ts` | Config errors at startup should be caught early |
| H4 | **Frontend `escapeHtml()`**: XSS payloads including `<script>`, event handlers, nested HTML | New file: `frontend/test/ui.test.ts` (jsdom or happy-dom) | Frontend renders user-provided data (addresses, error messages) |
| H5 | **Zero-address recipient rejection**: Server should reject `0x0000...0000` as recipient, or test documents the intentional acceptance | `e2e/test/malformed-payloads.test.ts` | Burning testnet ETH to zero address wastes faucet funds |
| H6 | **Status route unit tests**: claim records with pending/failed status, special chars in claimId | New file: `server/test/routes/status.test.ts` | Currently only tested via E2E happy path |
| H7 | **Circuits artifact route**: serving artifact for valid module, rejecting non-eth-balance, handling missing file | New file: `server/test/routes/circuits.test.ts` | Route has 3 distinct error branches, none unit-tested |

### Medium Priority

| # | Test Scenario | Target File | Rationale |
|---|--------------|-------------|-----------|
| M1 | **Frontend API client**: mock fetch to test getNetworks, submitClaim, error handling, non-JSON responses | New file: `frontend/test/api.test.ts` | API client handles error parsing and has untested edge cases |
| M2 | **Frontend wallet**: formatBalance, hasMinBalance boundary, generateMockNullifier determinism | New file: `frontend/test/wallet.test.ts` | Pure functions that can be tested without DOM |
| M3 | **Client CLI**: at minimum, test command routing and env var validation via process mock | New file: `client/test/cli.test.ts` | 298 lines of untested code |
| M4 | **Schema validation unit tests**: dedicated tests for HexSchema, AddressSchema edge cases | New file: `server/test/util/schemas.test.ts` | Schemas are the first line of defense against malformed input |
| M5 | **Frontend UI pure functions**: isValidAddress, formatWei, truncateAddress, formatEpochCountdown | `frontend/test/ui.test.ts` | Pure functions easily testable without DOM |
| M6 | **Circuit prove.ts parseProverToml**: test TOML parser with various input formats | New file: `circuits/bin/eth_balance/scripts/test/prove.test.ts` | Parser handles complex 2D arrays and is fragile |
| M7 | **Rate limiter with no proxy headers**: verify fallback to "unknown" key works correctly | `e2e/test/rate-limiting.test.ts` | All rate limit tests use x-forwarded-for; "unknown" path untested |
| M8 | **Noir bytes.nr and fragment.nr unit tests**: byte_to_nibbles, right_pad, Fragment methods | Add `#[test]` functions in respective `.nr` files | Library functions used throughout the MPT verification |

### Low Priority

| # | Test Scenario | Target File | Rationale |
|---|--------------|-------------|-----------|
| L1 | **Logger creation**: verify pino configuration for production vs development | `server/test/util/logger.test.ts` | Low risk, but untested branch on NODE_ENV |
| L2 | **Contract ownership transfer**: transferOwnership + recordNullifier with new owner | `contracts/test/NullifierRegistry.test.ts` | Inherited from OpenZeppelin, low risk |
| L3 | **Contract renounceOwnership**: verify no one can record after renounce | `contracts/test/NullifierRegistry.test.ts` | Edge case of Ownable |
| L4 | **Client fetchStorageProof with mocked RPC**: verify correct RPC call parameters | `client/test/wallet.test.ts` | Currently only tests function arity |
| L5 | **generate_prover_toml.ts helper functions**: bytesToTomlArray, padLeft, padRight with edge cases | New test file | Utility functions, low risk |
| L6 | **Frontend main.ts integration**: test init flow with mocked DOM (jsdom) | `frontend/test/main.test.ts` | Complex DOM manipulation, harder to test |

---

## 5. Test Quality Observations

### 5.1 Strengths

1. **Nullifier store tests are excellent**: 19 tests covering SQL injection (3 vectors), unicode, empty strings, concurrent writes, cross-module isolation, and numeric edge cases.

2. **Claim route tests have good adversarial coverage**: Tests for empty proof, odd-length hex, prototype pollution, negative epoch, non-integer epoch, missing 0x prefix, and wrong-length recipient.

3. **E2E test suite is comprehensive**: 69 tests covering concurrency (10 parallel claims), rate limiting, path traversal attacks, HTTP method enforcement, and content-type verification.

4. **Circuit tests cover determinism**: Both Noir and TypeScript tests verify that the nullifier derivation is deterministic for the same inputs and different for different inputs.

5. **Test isolation is well-designed**: Each test file creates its own in-memory SQLite database and test server, avoiding cross-test contamination.

### 5.2 Weaknesses

1. **Mocked verification everywhere**: The E2E tests mock `verifyProof` to accept any non-empty proof (`proof.length > 0`). This means the entire E2E suite never exercises real ZK verification. While this is understandable (real verification takes 10-15 seconds), it means the proof-to-verification path is only tested in the optional fixture-based unit test.

2. **Weak assertion in fund-dispatcher test**: The test on line 84-92 of `fund-dispatcher.test.ts` uses a try/catch that accepts both success and failure as valid outcomes. This means the test can never fail:
   ```typescript
   try {
     await localDispatcher.dispatch("local", "0x...");
     // If we reach here, the test should still pass
   } catch (err) {
     expect(err).toBeDefined(); // Always true for any error
   }
   ```

3. **No negative circuit tests**: The Noir test suite only tests happy paths. There are no tests that verify the circuit correctly rejects invalid inputs (wrong signature, mismatched address, insufficient balance, wrong nullifier). These would require `#[test(should_fail)]` annotations.

4. **E2E tests depend on test helpers duplicating production code**: The `MockStateRootOracle`, `MockFundDispatcher`, and rate-limit middleware in E2E tests are hand-written duplicates of production logic. If the production implementation changes, the mocks may not be updated, leading to false-positive tests.

5. **Frontend has zero tests**: 790 lines of client-side code including security-relevant functions (`escapeHtml`, `isValidAddress`, `generateMockNullifier`) are completely untested.

6. **No integration test between client and server**: There is no test verifying that the client's `formatInputsForCircuit()` output is compatible with the server's `encodePublicInputs()` expectations.

---

## 6. Summary

The zk_faucet project has a solid test foundation with 181 passing tests. The server's claim flow, nullifier dedup, and E2E security scenarios are well-covered. However, there are significant gaps:

- **StateRootOracle** (security-critical) has zero unit tests
- **Frontend** (790 LOC) has zero tests
- **CLI** (298 LOC) has zero tests
- **Server config/env** has zero tests
- **Circuit negative tests** (invalid inputs) are missing entirely
- **Nullifier-burned-on-dispatch-failure** is an untested and potentially problematic design pattern
- **Cross-package consistency** (domain message match, input format compatibility) is not verified

The highest-impact improvements would be: (C1) testing the nullifier burn behavior, (C2) adding StateRootOracle unit tests, (C3) adding cross-verification between client and circuit domain messages, and (H4) adding frontend security function tests.
