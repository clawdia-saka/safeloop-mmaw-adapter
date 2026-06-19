# Death Metrics

This document lists failure scenarios Safeloop should make hard to reach.

## DM-1: State Amnesia

Scenario:

```text
agent creates intent
process crashes before or after signing
agent restarts with empty memory
agent retries the same goal
duplicate transaction or multi-position opens
```

Required guard:

- Idempotency keys must be written to durable storage before signing.
- The write must be atomic.
- A wallet or venue lock must cover the reconciliation window.
- In-memory caches are not acceptable for production execution.

Implementation hook:

- `Ledger.capabilities.durable`
- `Ledger.capabilities.atomicLocks`
- `lockScope`
- `DURABLE_LEDGER_REQUIRED`
- `INTENT_LOCK_REQUIRED`

## DM-2: Non-EVM Perps Simulation Gap

Scenario:

```text
agent opens HIP-3 perps position
EVM simulation passes because no EVM transaction is unsafe
Hyperliquid margin state is unsafe
position is liquidated or over-allocated
```

Required guard:

- Hyperliquid perps must use a venue-aware risk model or a venue/testnet API simulation.
- Anvil/Tenderly alone is insufficient for HIP-3 perps.

Implementation hook:

- `simulateHyperliquidPerpsRisk`
- `NON_EVM_SIMULATION_REQUIRED`
- `MARGIN_RATIO_LIMIT`
- `LIQUIDATION_PRICE_TOO_CLOSE`

## DM-3: Reconciliation Latency Window

Scenario:

```text
agent submits order
wallet request is still broadcasting
venue state has not updated yet
agent checks stale state
agent submits another order
over-allocation or duplicate exposure
```

Required guard:

- Ledger row must stay locked until wallet and venue states reconcile.
- `BROADCASTING`, pending MFA, and missing venue position checks are not success.
- Reconciliation observations must have freshness limits.

Implementation hook:

- `REQUEST_WATCH_REQUIRED`
- `BROADCASTING`
- `VENUE_RECONCILED`
- `STALE_RECONCILIATION`
- `OVER_ALLOCATION_RISK`

## DM-4: Quote Is Mistaken For Execution

Scenario:

```text
agent receives a quote
agent records task as done
no transaction lands
later agent assumes funds are available
perps deposit/open fails or retries
```

Required guard:

- A quote ID is not a completed transaction.
- The task can only complete after tx history and venue state agree.

Implementation hook:

- `QUOTE_ONLY_NOT_EXECUTED`
- `POSITION_NOT_RECONCILED`

