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

## DM-5: Deadlock Orphaning

Scenario:

```text
worker acquires a market lock
worker crashes during simulation or broadcast
the unlock code never runs
all future intents for that market are blocked
```

Required guard:

- Locks must have a TTL lease.
- Terminal statuses must release the lock.
- Expired locks must be ignored or cleaned before a new lock attempt.

Implementation hook:

- `ActionLedgerRow.lockedUntil`
- `Ledger.capabilities.lockLeases`
- `LOCK_LEASE_REQUIRED`
- `LOCK_LEASE_EXPIRED`
- `safeloop_action_locks`

## DM-6: Split-Brain Lock Race

Scenario:

```text
two serverless workers receive the same market intent
both SELECT the ledger before either writes
both think the scope is free
both sign before reconciliation completes
```

Required guard:

- Lock acquisition must be atomic at the storage layer.
- Do not implement production locking as `SELECT` then `INSERT`.
- Use a database constraint, transaction, advisory lock, or equivalent Redis
  lock primitive.

Implementation hook:

- `Ledger.capabilities.atomicLocks`
- `ATOMIC_LOCK_REQUIRED`
- `safeloop_try_lock_action(...)`

## DM-7: Oracle Latency Desync

Scenario:

```text
agent simulates a perps order
mark price input is old
volatility moves the liquidation range
the stale simulation says safe
the live market liquidates the position
```

Required guard:

- Perps simulations must include price observation timestamps.
- Stale or missing oracle timestamps must fail closed.
- The policy must define `maxOracleAgeMs`.

Implementation hook:

- `SimulationResult.oracleObservedAt`
- `SafeloopPolicy.maxOracleAgeMs`
- `ORACLE_PRICE_STALE`

## DM-8: Race-to-Sign Replay Gap

Scenario:

```text
ledger moves to APPROVED_FOR_SIGNING
signer creates a signature
worker crashes before ledger reaches SIGNED
retry starts without wallet request or tx history reconciliation
the same goal signs again
```

Required guard:

- A signing transition must be treated as unresolved until reconciled.
- Retries must check prior `APPROVED_FOR_SIGNING`, `SIGNING`, `SIGNED`,
  submitted, and broadcasting states.
- The signer must still own the active lock immediately before signing.

Implementation hook:

- `SIGNING`
- `SIGNATURE_RECONCILIATION_REQUIRED`
- `Ledger.verifyLock(...)`
- `LOCK_OWNERSHIP_LOST`

## DM-9: Ghost Position Risk

Scenario:

```text
account has a 2 ETH long perp
agent tries to partially close 1 ETH
position still exists after the close
Boolean positionFound remains true
agent retries and flips the position
```

Required guard:

- Venue reconciliation must compare expected and observed position size.
- Partial close and modify flows cannot rely on `positionFound` alone.
- A mismatch stays pending instead of becoming success.

Implementation hook:

- `VenueObservation.expectedPositionSize`
- `VenueObservation.observedPositionSize`
- `POSITION_DELTA_MISMATCH`

## DM-10: Cross-Margin Contagion

Scenario:

```text
BTC trade looks safe in isolation
ETH and alt positions share the same Hyperliquid account margin
account health is already near liquidation
the BTC signature triggers account-wide liquidation
```

Required guard:

- Hyperliquid perps simulation must include account-wide health.
- Policy must check account margin ratio, account liquidation buffer, and max
  account exposure.

Implementation hook:

- `SimulationResult.accountMarginRatioBps`
- `SimulationResult.accountLiquidationBufferBps`
- `SimulationResult.accountExposureUsd`
- `ACCOUNT_HEALTH_LIMIT`

## DM-11: Scope Shadowing Across Builder DEXs

Scenario:

```text
dex-a:BTC lock succeeds
dex-b:ETH lock also succeeds
both workers evaluate old account NAV
combined exposure breaches account risk budget
```

Required guard:

- Perps flows need both market-level and account-level lock scopes.
- Builder DEX identity should not bypass account-wide exposure controls.

Implementation hook:

- `makeAccountLockScope(...)`
- `ActionLedgerRow.accountLockScope`
- `Ledger.capabilities.accountScopedLocks`
- `ACCOUNT_LOCK_REQUIRED`

## DM-12: Lock Ownership Stealing

Scenario:

```text
worker A acquires a leased lock
simulation takes longer than the lease
worker B acquires the expired lock
worker A resumes and signs without noticing ownership was lost
```

Required guard:

- Locks need an owner ID, not only a scope and expiry.
- The owner must be verified after simulation and immediately before signing.
- Lost ownership fails closed.

Implementation hook:

- `ActionLedgerRow.lockOwnerId`
- `Ledger.capabilities.ownedLocks`
- `safeloop_verify_action_lock(...)`
- `LOCK_OWNERSHIP_REQUIRED`
- `LOCK_OWNERSHIP_LOST`

## DM-13: Oracle Frontrunning and Latency Arbitrage

Scenario:

```text
oracle price is 4.9 seconds old
market moves sharply during that window
simulation still passes on the old price
signed order executes at the new price
account liquidates immediately
```

Required guard:

- Oracle freshness cannot be a static time window only.
- High-volatility observations must use a much shorter freshness window.
- Missing volatility metadata should be treated conservatively by production
  simulators.

Implementation hook:

- `SimulationResult.volatilityBps`
- `SafeloopPolicy.highVolatilityOracleAgeMs`
- `SafeloopPolicy.oracleVolatilityThresholdBps`
- `ORACLE_PRICE_STALE`

## DM-14: Cryptographic Ghost Transaction

Scenario:

```text
transaction is signed
RPC returns timeout or HTTP 500
agent believes the transaction was not sent
retry signs a second transaction
the first signed payload later lands from a queue or mempool
```

Required guard:

- Every signed payload must have a short cryptographic lifetime.
- No-expiry signatures are unsafe for autonomous retry loops.
- Retries must reconcile wallet requests and transaction history before signing.

Implementation hook:

- `SimulationResult.signatureExpiresAt`
- `SimulationResult.validUntilBlock`
- `SIGNATURE_EXPIRY_REQUIRED`
- `SIGNATURE_EXPIRED`

## DM-15: Cross-Venue Margin Blindspot

Scenario:

```text
Backpack lane and Hyperliquid lane run at the same time
each venue-specific check sees enough collateral
both sign large positions
combined portfolio leverage exceeds the real funding pool
```

Required guard:

- Shared collateral must have a parent lock above venue-specific locks.
- Parallel venues that depend on the same funding pool must serialize.

Implementation hook:

- `makeGlobalCollateralLockScope(...)`
- `ActionLedgerRow.globalCollateralLockScope`
- `Ledger.capabilities.globalCollateralLocks`
- `GLOBAL_COLLATERAL_LOCK_REQUIRED`

## DM-16: Silent Gas Suffocation

Scenario:

```text
micro-adjustment loop burns native gas
each trade passes margin checks
native balance falls below emergency close runway
market crashes
close transaction fails for insufficient gas
```

Required guard:

- New opens must stop when gas runway is too low.
- Recent gas burn rate must have a policy cap.
- Emergency close/cancel/withdraw actions can use reserved runway.

Implementation hook:

- `SimulationResult.nativeBalanceUsd`
- `SimulationResult.estimatedMaxGasUsd`
- `SimulationResult.gasRunwayTransactions`
- `SimulationResult.gasSpentLookbackUsd`
- `GAS_RUNWAY_LOW`
- `GAS_BURN_RATE_LIMIT`
