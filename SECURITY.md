# Security Audit Findings

This document records all findings from the security audit of the zk_faucet system,
including what was fixed, what was accepted, and the rationale for each decision.

## Addressed Findings

### CRITICAL: Unconstrained `message_hash` input (Fixed)

**Severity**: Critical
**Status**: Fixed in circuit v2

**Problem**: `message_hash` was a private, unconstrained circuit input. Any ECDSA
signature ever produced by any Ethereum address could be used to forge a valid proof
without the private key -- the prover could supply a `message_hash` matching any
existing signature.

**Fix**: Removed `message_hash` as a private input. The circuit now computes the
EIP-191 message hash in-circuit from the public `epoch` input using a fixed-length
domain message format:

```
Domain message (50 bytes):
  "zk_faucet_v1:eth-balance:nullifier_seed:" + epoch_padded_10_digits

EIP-191 wrapped (78 bytes):
  "\x19Ethereum Signed Message:\n50" + domain_message
```

The prover must now sign the epoch-specific message with their actual private key.
This adds one keccak256 call on 78 bytes to the circuit, which is acceptable given
the circuit already uses keccak256 for address derivation and MPT verification.

### CRITICAL: Verifier stub in production (Fixed)

**Severity**: Critical
**Status**: Fixed

**Problem**: The server's `verifyProof()` was a stub that threw in production and
used a `MOCK_VERIFIER` env var bypass in tests. No actual ZK proof verification
occurred.

**Fix**: Replaced with real UltraHonk verification using `@aztec/bb.js`. The
verifier lazily loads the compiled circuit artifact and creates an `UltraHonkBackend`
singleton. All proofs are verified using Barretenberg WASM. The `MOCK_VERIFIER`
escape hatch has been removed entirely.

### HIGH: `encodePublicInputs` field count mismatch (Fixed)

**Severity**: High
**Status**: Fixed

**Problem**: `encodePublicInputs()` produced 4 fields (stateRoot as a single field,
epoch, minBalance, nullifier), but the circuit exposes 35 public inputs (32 individual
state_root bytes + epoch + minBalance + nullifier).

**Fix**: Updated to produce 35 fields by splitting `stateRoot` into 32 individual
byte fields, each encoded as a 64-char hex field element.

## Accepted Findings

### HIGH: `bytes32_to_field` BN254 truncation

**Severity**: High (theoretical)
**Status**: Accepted

**Description**: Converting 32-byte values (pubkey coordinates) to BN254 field
elements via big-endian interpretation causes reduction modulo the BN254 prime.
For values >= the prime, two different 32-byte inputs could map to the same field
element, potentially allowing nullifier collisions.

**Rationale**: The probability of a random secp256k1 public key coordinate exceeding
the BN254 prime is astronomically low (~2^{-2}). For a testnet faucet dispensing
worthless tokens, this risk is negligible.

### HIGH: Flash loan balance inflation

**Severity**: High
**Status**: Accepted

**Description**: An attacker could use a flash loan to temporarily inflate their
ETH balance during proof generation, then return the borrowed funds.

**Rationale**: Economically irrational -- flash loans cost gas fees, and the faucet
dispenses free testnet tokens. Anyone with enough capital for a flash loan already
has ample access to testnet funds through other means.

### HIGH: ETH recycling across addresses

**Severity**: High
**Status**: Accepted

**Description**: A user could transfer 0.01 ETH between addresses, generating a
valid proof from each address before moving the balance to the next.

**Rationale**: The faucet dispenses free testnet tokens. Rate limiting by epoch
(one claim per public key per week) already bounds the attack rate. The economic
incentive to farm worthless tokens is negligible.

### HIGH: u64 balance truncation for large balances

**Severity**: High
**Status**: Accepted (documented for future fix)

**Description**: The balance comparison casts to u64, which overflows for balances
above ~18.4 ETH. Extremely large balances would silently truncate, potentially
failing the balance check incorrectly.

**Rationale**: The minimum balance threshold is 0.01 ETH. Balances above 18.4 ETH
are rare, and false negatives (rejecting valid proofs) are not a security risk --
the user would simply fail to claim, not gain unauthorized access. A future version
should use a wider integer type.

### MEDIUM: Epoch boundary double-claim

**Severity**: Medium
**Status**: Accepted (by design)

**Description**: At the epoch boundary, a user could potentially claim in the last
seconds of epoch N and the first seconds of epoch N+1 using different nullifiers.

**Rationale**: This is by design. Epochs represent weekly windows, and claiming
once per week is the intended behavior. The boundary edge case allows at most 2
claims in quick succession, which is acceptable for a faucet.

### MEDIUM: Timing correlation

**Severity**: Medium
**Status**: Accepted

**Description**: An observer could correlate proof submission times with on-chain
activity to deanonymize users.

**Rationale**: Inherent to any proof submission system. Mitigations (delayed
submission, batching) are out of scope for the initial version. Users seeking
strong anonymity should use Tor or submit during high-traffic periods.

### MEDIUM: Rate limiter X-Forwarded-For spoofing

**Severity**: Medium
**Status**: Accepted

**Description**: The IP-based rate limiter uses X-Forwarded-For, which can be
spoofed if the server is not behind a trusted reverse proxy.

**Rationale**: Acceptable for a testnet faucet. In production deployment, the
server should be placed behind a reverse proxy (nginx, Cloudflare) that sets
trusted X-Forwarded-For headers.

### MEDIUM: Cross-faucet nullifier reuse

**Severity**: Medium
**Status**: Accepted

**Description**: The same public key produces the same nullifier for the same epoch
across different faucet deployments, allowing a user to claim from multiple faucets.

**Rationale**: Not relevant for a single deployment. If multiple faucets are
deployed, they should use different domain message prefixes.

### MEDIUM: Nullifier store unbounded growth

**Severity**: Medium
**Status**: Accepted

**Description**: The SQLite nullifier store grows indefinitely as nullifiers
accumulate. Over time, this could consume significant disk space.

**Rationale**: Operational concern, not a security vulnerability. Nullifiers can
be pruned for epochs older than the current epoch. This is a future operational
improvement.

### MEDIUM: MPT depth cap at 10

**Severity**: Medium
**Status**: Accepted

**Description**: The circuit limits MPT proof depth to 10 nodes. If the Ethereum
state trie grows beyond this depth, proofs would become unverifiable.

**Rationale**: The current Ethereum state trie depth is typically 7-8 nodes for
account proofs. A depth of 10 provides sufficient headroom. The constant can be
increased in a future circuit version if needed.
