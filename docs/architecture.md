# Architecture

## Objective

Prevent autonomous wallet agents from signing logically unsafe transactions.

The adapter is focused on pre-sign safety. It does not replace MetaMask Agent Wallet. It adds a runtime layer before signing.

## Responsibility Split

MetaMask Agent Wallet owns:

- wallet access
- policy-bounded permissions
- transaction construction
- signing
- submission

Safeloop owns:

- canonical intent creation
- idempotency locking
- action history checks
- dry-run simulation gating
- fail-closed signing decisions
- reconciliation between chain state and agent memory
- HIP-3 market identity tracking for perps flows
- wallet request status interpretation for server-wallet and Guard/MFA flows
- venue reconciliation for Hyperliquid positions, orders, and balances
- durable idempotency and lock-scope enforcement before signing
- non-EVM risk simulation for Hyperliquid perps
- TTL-based lock leases to recover from crashed workers
- lock-owner verification before signing
- account-wide lock scopes for cross-margin perps accounts
- global collateral lock scopes across venues
- dynamic oracle freshness checks for perps margin inputs
- short signature expiry enforcement
- native gas runway protection

## Runtime Flow

```text
Agent proposes intent
  -> Safeloop canonicalizes intent
  -> Safeloop creates idempotency key
  -> Safeloop locks Action Ledger row
  -> MMAW builds unsigned transaction/UserOperation
  -> Safeloop simulates the unsigned operation
  -> Safeloop checks recent action trajectory
  -> Safeloop checks ledger state
  -> Safeloop signs only if all checks pass
  -> MMAW submits
  -> Safeloop reconciles chain result with agent memory
```

## Ledger State Machine

```text
PLANNED -> LOCKED -> SIMULATED -> APPROVED_FOR_SIGNING -> SIGNING -> SIGNED -> REQUEST_PENDING
                                                             |          |            |
                                                             v          v            v
                                                        ABORTED   SIGN_FAILED   AWAITING_HUMAN_APPROVAL
                                                                          |
                                                                          v
                                                                      SUBMITTED
                                                                          |
                                                                          v
                                                                     BROADCASTING
                                                                     /         \
                                                                    v           v
                                                                 LANDED      TIMED_OUT
                                                                    |
                                                                    v
                                                           VENUE_RECONCILED
                                                                    |
                                                                    v
                                                                CONFIRMED

ABORTED and REVERTED are terminal failure states.
```

Rules:

- `ABORTED` means Safeloop stopped the action before signing.
- `SIGNING` means the lock owner was verified and signing is in progress.
- `SIGN_FAILED` means signing was attempted but failed.
- `AWAITING_HUMAN_APPROVAL` means Guard/MFA approval is still required.
- `BROADCASTING` means the operation is not yet final and must not be counted as success.
- `LANDED` means an on-chain transaction exists, but venue state may still need checking.
- `VENUE_RECONCILED` means the venue state agrees with the intended action.
- `REVERTED` means the operation reached chain execution and failed.
- `TIMED_OUT` means submission did not settle within the policy window.
- Agent memory must be updated from the ledger, not from the agent's assumption.

## Idempotency Key

Safeloop creates a deterministic key from the normalized action.

```text
sha256(
  wallet |
  chainId |
  actionType |
  userGoalId |
  targetContract |
  canonicalArgs |
  roundedAmountBucket |
  timeBucket
)
```

If the same key is already active or complete, Safeloop aborts before signing.

## Durable Ledger Requirement

Production execution must use durable storage with atomic uniqueness constraints.

In-memory idempotency caches are acceptable only for local demos because a process crash can erase the cache and allow a duplicate transaction after restart.

Required properties:

- unique `idempotencyKey`
- atomic distributed lock acquisition for each active `lockScope`
- atomic distributed lock acquisition for account-level perps scopes
- atomic distributed lock acquisition for global collateral scopes
- TTL-based lock leases so crashed workers cannot brick a market forever
- lock ownership checks immediately before signing
- transactionally written before signing
- retained across process restarts

The Supabase/Postgres baseline is in `sql/supabase.sql`.

The baseline uses a separate `safeloop_action_locks` table with `lock_scope` as
the primary key. `safeloop_try_lock_action(...)` deletes expired locks and then
inserts the ledger row and lock row in one transaction. Concurrent workers race
against the database constraint, not against application-side `SELECT` logic.

Supabase is an optional storage example, not a shared service operated by this
repo. Each deployer must use their own project and keep database credentials out
of public clients and source control.

## Default Invariants

### Duplicate Intent

Reject if the same idempotency key already exists in an active or completed state.

### Reverse Swap Loop

Reject if a recent swap goes in the opposite direction:

```text
previous.assetIn == current.assetOut
previous.assetOut == current.assetIn
```

Example:

```text
ETH -> USDC
USDC -> ETH
```

### Retry Storm

Reject if the same user goal has already failed too many times in a short window.

### HIP-3 Market Mismatch

Reject or require review when a perps action references an unqualified builder DEX market. For example, an agent should not confuse `spcx` on the main market with `xyz:spcx` on a HIP-3 builder DEX.

### Token Contract Required

Reject ERC-20 transfers when the user or agent provides only a token symbol and the downstream CLI requires a token contract address.

### Quote Only

Reject success claims when a route was quoted but never executed.

### Broadcast Tracking

Treat `BROADCASTING`, `BROADCAST_TRACKING_EXPIRED`, and timeouts as unresolved or failed states. Do not mark the agent task complete from these statuses.

### Signing Reconciliation

Reject a retry when a prior action is already in `APPROVED_FOR_SIGNING`,
`SIGNING`, `SIGNED`, or a submitted/broadcasting wallet state. The next worker
must reconcile wallet request status or tx history before creating another
signature.

Signed operations must also have a short cryptographic lifetime. If the
operation has no expiry metadata, or the expiry exceeds policy, Safeloop treats
the result as replayable and refuses to sign.

### Position Reconciliation

For perps actions, require a post-action position, order, or balance check before marking the action successful.

For partial close and modify flows, a Boolean "position exists" check is not
enough. Safeloop must compare expected and observed position size within a
defined tolerance before marking venue reconciliation complete.

### Fee To Trade Value

Reject actions where estimated gas and slippage exceed the configured share of the trade value.

### Non-EVM Perps Simulation

Reject HIP-3/perps actions when the only simulation result is EVM-based. Hyperliquid perps need either a venue API simulation or a local margin/liquidation risk model.

### Account-Wide Perps Health

Reject perps actions when the account-level margin ratio, account-level
liquidation buffer, or account exposure breaches policy. This blocks a
single-market trade from ignoring cross-margin losses elsewhere in the same
Hyperliquid subaccount.

### Global Collateral Lock

Reject parallel intents that share the same collateral pool even when they target
different venues. The global collateral lock is a parent lock above market,
builder DEX, and venue-specific account locks.

### Oracle Freshness

Reject perps simulations when mark price or index price input is missing a
fresh timestamp. A margin calculation based on stale pricing is treated as
unknown and therefore unsafe.

During high volatility, the allowed oracle age is reduced from
`maxOracleAgeMs` to `highVolatilityOracleAgeMs`.

### Gas Runway

Reject new opens when native gas balance, estimated max gas cost, or recent gas
burn rate leaves fewer than the configured number of emergency transactions.
Close, cancel, and withdraw actions are allowed to use the reserved gas runway.

### NAV Guard

Reject if simulated net asset value loss exceeds the configured basis-point limit.

### Cumulative Loss Guard

Reject if recent gas, slippage, and simulated losses exceed the configured dollar limit.

### Approval Expansion Guard

Reject unbounded approvals unless there is a matching downstream intent.

## Decision Matrix

| Ledger | Simulation | Invariants | Decision |
| --- | --- | --- | --- |
| pass | pass | pass | sign |
| fail | any | any | abort |
| any | fail | any | abort |
| any | any | fail | abort |
| unknown | any | any | abort |
| any | unknown | any | abort |
| any | any | unknown | abort |

## Adapter Interfaces

Safeloop does not hard-code storage or simulation.

Required integrations:

- `Ledger`: lock, update, and query recent wallet actions.
- `Simulator`: dry-run unsigned operations.
- `MmawSigner`: build unsigned operations and sign approved operations.
- `Reconciliation`: map wallet request, tx history, and venue observations back into ledger states.

This keeps the core adapter portable across Notion, Supabase, local SQLite, Anvil, Tenderly, and different MetaMask Agent Wallet wiring.
