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
PLANNED -> LOCKED -> SIMULATED -> APPROVED_FOR_SIGNING -> SIGNED -> SUBMITTED -> CONFIRMED
                                      |                  |             |
                                      v                  v             v
                                   ABORTED           SIGN_FAILED    REVERTED/TIMED_OUT
```

Rules:

- `ABORTED` means Safeloop stopped the action before signing.
- `SIGN_FAILED` means signing was attempted but failed.
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

This keeps the core adapter portable across Notion, Supabase, local SQLite, Anvil, Tenderly, and different MetaMask Agent Wallet wiring.

