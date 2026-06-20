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

## DM-17: Cross-Venue Reconciliation Deadlock

Severity: High

Scenario:

```text
venue B enters MFA or broadcasting
global collateral lock covers all venues using that pool
other collateral moves block behind the stuck request
workers either freeze forever or try to bypass the parent lock
```

Required guard:

- Global collateral contention must be explicit.
- Stale MFA/broadcast contention must surface as a deadlock reason.
- Operators can reconcile or cancel the stuck request instead of silently
  creating a competing intent.

Implementation hook:

- `GLOBAL_COLLATERAL_LOCK_CONTENTION`
- `CROSS_VENUE_RECONCILIATION_DEADLOCK`
- `SafeloopPolicy.maxGlobalCollateralContentionMs`

## DM-18: Partial Fill Reconciliation Divergence

Severity: Medium

Scenario:

```text
order partially fills
adapter marks success because an order or position exists
unfilled exposure remains unhedged
agent memory drifts from venue state
```

Required guard:

- Partial fills stay pending until expected and filled size reconcile.
- Venue observations must carry fill status or expected-vs-filled size.

Implementation hook:

- `SimulationResult.fillStatus`
- `SimulationResult.expectedFillSize`
- `SimulationResult.filledSize`
- `PARTIAL_FILL_PENDING`

## DM-19: Signer-Enforced Rollback Replay

Severity: Critical

Scenario:

```text
signature is created
ledger commit rolls back or is lost
worker restarts
same intent signs again because storage forgot the first signature
```

Required guard:

- The signer must bind signatures to the intent or equivalent idempotency
  material.
- A storage ledger alone is insufficient for production signing.

Implementation hook:

- `MmawSigner.capabilities.intentBoundSignatures`
- `SIGNER_INTENT_BINDING_REQUIRED`

## DM-20: Gas Runway Arbitrage via MFA/Broadcast Latency

Severity: High

Scenario:

```text
many signed requests sit in MFA or broadcasting
confirmed gas still looks low
pending queue later lands and burns gas
emergency close fails because native balance is gone
```

Required guard:

- Gas runway must subtract in-flight gas reservations before confirmation.
- New opens fail closed when pending signatures would consume emergency gas.

Implementation hook:

- `SimulationResult.inFlightGasUsd`
- `IN_FLIGHT_GAS_RESERVED`
- `GAS_RUNWAY_LOW`

## DM-21: Lock Lease Shadowing During MFA Wait

Severity: High

Scenario:

```text
worker enters MFA wait
two-minute lock lease expires
another worker reacquires the same scope
human approval later completes the first request
two conflicting intents now exist
```

Required guard:

- Human approval windows need lease renewal support.
- An expired MFA wait lock is still a shadow lock until reconciled or stale by
  policy.

Implementation hook:

- `Ledger.capabilities.lockLeaseRenewal`
- `LOCK_LEASE_EXTENSION_REQUIRED`

## DM-22: Reconciliation Gap on Revert-with-Value

Severity: Medium

Scenario:

```text
transaction reverts
agent only records failure
gas burn is not added to runway accounting
retry loop drains native token silently
```

Required guard:

- Reverted transactions must carry gas burn data into reconciliation.
- Missing gas burn on a reverted request remains unreconciled.

Implementation hook:

- `WalletRequestObservation.gasBurnedUsd`
- `SimulationResult.revertedGasUsd`
- `REVERT_GAS_BURN_UNACCOUNTED`

## DM-23: Time-Drift Oracle Brick

Severity: High

Scenario:

```text
host clock drifts by milliseconds or seconds
oracle freshness compares against local wall time
fresh oracle data looks stale forever, or stale data looks fresh
trading either bricks or signs on unsafe pricing
```

Required guard:

- Oracle freshness should use monotonic age from the simulator when available.
- Local clock skew above policy fails closed.
- Wall-clock timestamps are fallback metadata, not the sole source of truth.

Implementation hook:

- `SimulationResult.oracleMonotonicAgeMs`
- `SimulationResult.clockSkewMs`
- `SafeloopPolicy.requireMonotonicOracleAge`
- `CLOCK_DRIFT_LIMIT`
- `ORACLE_MONOTONIC_AGE_REQUIRED`

## DM-24: Priority Inversion on Global Lock

Severity: Critical

Scenario:

```text
low-priority open holds the global collateral lock
market moves against an existing position
emergency close waits behind the lower-priority task
account is liquidated before the close can sign
```

Required guard:

- Emergency exits must be priority-aware.
- Lower-priority global collateral locks cannot block emergency close, cancel,
  or withdraw paths.
- Production ledgers must support priority-aware lock behavior.

Implementation hook:

- `AgentIntent.priority`
- `Ledger.capabilities.priorityLocks`
- `PRIORITY_LOCK_REQUIRED`

## DM-25: Pool Leakage

Severity: High

Scenario:

```text
shared collateral action omits the collateral pool id
system falls back to a default pool label
unrelated pools are merged, or one real pool is split across labels
risk limits and global locks become unreliable
```

Required guard:

- Shared-collateral actions must carry an explicit `collateralPoolId`.
- No implicit default collateral pool should be used for production locking.

Implementation hook:

- `AgentIntent.collateralPoolId`
- `makeGlobalCollateralLockScope(...)`
- `COLLATERAL_POOL_REQUIRED`
- `POOL_LEAKAGE_RISK`

## DM-26: Monotonic Drift Desync in Stateless Workers

Severity: High

Scenario:

```text
serverless worker cold-starts
process-local monotonic timer starts at zero
calibration state is missing or slow to load
old oracle input looks safe during the first few actions
stale pricing reaches signing
```

Required guard:

- Perps simulations must include durable time calibration metadata.
- Calibration must be recent and fast enough to trust.
- Local process timers are not enough in stateless worker environments.

Implementation hook:

- `SimulationResult.timeCalibrationSource`
- `SimulationResult.timeCalibrationSyncedAt`
- `SimulationResult.timeCalibrationRoundTripMs`
- `TIME_CALIBRATION_REQUIRED`
- `TIME_CALIBRATION_STALE`
- `TIME_CALIBRATION_UNSAFE`

## DM-27: Preemption Cascade and Livelock Thrashing

Severity: High

Scenario:

```text
market drops quickly
several emergency tasks appear in milliseconds
each higher-priority task preempts the previous one
signing keeps aborting before any close or cancel reaches the venue
account stays exposed until liquidation
```

Required guard:

- A lock in `SIGNING` needs a short non-preemptable window.
- Repeated preemptions in the same policy window must fail closed.
- Very new locks should not be preempted immediately after creation.

Implementation hook:

- `SafeloopPolicy.nonPreemptableSigningMs`
- `SafeloopPolicy.minPreemptionAgeMs`
- `SafeloopPolicy.preemptionWindowMs`
- `SafeloopPolicy.maxPreemptionsPerWindow`
- `NON_PREEMPTABLE_SIGNING_LOCK`
- `PREEMPTION_LIVELOCK_RISK`

## DM-28: Phantom Broadcast of Preempted Low-Priority Tx

Severity: Critical

Scenario:

```text
low-priority action starts signing or broadcasting
emergency action preempts the database lock
the first physical transaction is already in a queue
emergency simulation assumes the first action is dead
both transactions later land
exposure doubles or a close is followed by a reopen
```

Required guard:

- A preempted signed, submitted, MFA-waiting, or broadcasting action remains
  live until cancellation or reconciliation proves otherwise.
- Emergency preemption must require cancellation proof when the prior action may
  already have escaped storage control.
- Production integrations should use nonce replacement, venue-native cancel,
  short time-in-force, or equivalent proof before proceeding.

Implementation hook:

- `ActionLedgerRow.preemptionCancelStatus`
- `ActionLedgerRow.preemptionCancelTxHash`
- `Ledger.capabilities.preemptionCancellation`
- `PREEMPTION_CANCEL_REQUIRED`
- `PREEMPTED_TX_STILL_LIVE`

## DM-29: RPC Indexing Lag Deadlock on Cancellation Proof

Severity: High

Scenario:

```text
emergency action preempts a live lower-priority action
replacement cancel transaction is broadcast
RPC indexer lags behind the chain or mempool
cancel proof query returns pending or not found
emergency close waits for confirmation
position reaches liquidation before the proof appears
```

Required guard:

- Cancellation proof cannot depend on one RPC indexer becoming consistent.
- Multi-RPC broadcast acceptance can show propagation, but it is not final
  cancellation proof.
- The emergency gate requires ordered or confirmed cancellation proof by
  default.
- If RPC quorum partitions during a liquidation-risk event, only a reduce-only
  or close-all emergency close may proceed without treating cancellation as
  proven.
- Stale, under-quorum, or mempool-only acceptance still fails closed for
  non-reducing work.

Implementation hook:

- `ActionLedgerRow.preemptionCancelStatus`
- `ActionLedgerRow.preemptionCancelSubmittedAt`
- `ActionLedgerRow.preemptionCancelObservedAt`
- `ActionLedgerRow.preemptionCancelOrderedAt`
- `ActionLedgerRow.preemptionCancelOrderSource`
- `ActionLedgerRow.preemptionCancelRpcQuorum`
- `ActionLedgerRow.preemptionCancelQuorumFailure`
- `SafeloopPolicy.maxPreemptionCancelProofWaitMs`
- `SafeloopPolicy.maxPreemptionCancelAcceptanceAgeMs`
- `SafeloopPolicy.minPreemptionCancelRpcQuorum`
- `SafeloopPolicy.requireOrderedCancellationProof`
- `SafeloopPolicy.allowReduceOnlyEmergencyDuringQuorumPartition`
- `PREEMPTION_CANCEL_QUORUM_REQUIRED`
- `CANCELLATION_PROOF_INDEXING_LAG`

## DM-30: Cancellation Proof Staleness

Severity: High

Scenario:

```text
cancellation telemetry was observed earlier
RPC or mempool state moves on
emergency flow reuses old acceptance
preempted transaction may still be live
```

Required guard:

- Broadcast acceptance telemetry must have a freshness budget.
- Stale acceptance fails closed even when quorum was once reached.

Implementation hook:

- `ActionLedgerRow.preemptionCancelObservedAt`
- `SafeloopPolicy.maxPreemptionCancelAcceptanceAgeMs`
- `CANCELLATION_PROOF_STALE`

## DM-31: Shared Nonce Domain Collision

Severity: Critical

Scenario:

```text
multiple workers share one nonce domain
one worker broadcasts a cancel
another worker signs an emergency transaction in the same nonce domain
the cancel replaces the emergency transaction
```

Required guard:

- Emergency preemption must know its nonce domain.
- Concurrent live actions in the same nonce domain are treated as collisions.

Implementation hook:

- `AgentIntent.nonceDomain`
- `ActionLedgerRow.nonceDomain`
- `NONCE_DOMAIN_REQUIRED`
- `NONCE_DOMAIN_COLLISION`

## DM-32: Proof-of-Cancel False Positive

Severity: High

Scenario:

```text
mempool appears to replace a transaction
replacement observation is not bound to the nonce or original tx
another propagation path later lands the original transaction
system assumes cancel success too early
```

Required guard:

- Cancellation evidence must be nonce-bound.
- Ordered or confirmed proof must identify the nonce and the transaction it
  replaces.

Implementation hook:

- `ActionLedgerRow.preemptionCancelNonce`
- `ActionLedgerRow.preemptionCancelReplacesTxHash`
- `SafeloopPolicy.requireNonceBoundCancellation`
- `CANCEL_PROOF_FALSE_POSITIVE_RISK`

## DM-33: Emergency Close Starvation

Severity: Critical

Scenario:

```text
low-priority queue grows quickly
emergency close gets a lock
surrounding checks and queue pressure keep it from signing
position remains exposed until liquidation
```

Required guard:

- Emergency flows must fail closed when low-priority queue pressure exceeds
  policy.
- Operators need a distinct starvation reason instead of a generic lock abort.

Implementation hook:

- `SafeloopPolicy.maxLowPriorityQueueAheadOfEmergency`
- `EMERGENCY_CLOSE_STARVATION`

## DM-34: Lock Release Split Brain

Severity: High

Scenario:

```text
worker restarts around lease expiry
one worker treats the old lease as dead
another worker still believes it owns the lock
both continue from different state assumptions
```

Required guard:

- Locks need fencing tokens or equivalent monotonic ownership epochs.
- Missing or non-increasing epochs are split-brain risk.

Implementation hook:

- `ActionLedgerRow.lockEpoch`
- `Ledger.capabilities.lockFencing`
- `LOCK_FENCING_REQUIRED`
- `LOCK_RELEASE_SPLIT_BRAIN`

## DM-35: Gas Reservation Drift

Severity: Medium

Scenario:

```text
preemption reserves gas
preemption aborts
reservation is never released
runway appears exhausted even though gas was not spent
```

Required guard:

- Aborted, failed, or timed-out actions must release unused gas reservations.
- Stale reserved gas above policy is treated as drift.

Implementation hook:

- `ActionLedgerRow.gasReservationStatus`
- `ActionLedgerRow.gasReservedUsd`
- `GAS_RESERVATION_DRIFT`

## DM-36: Calibration Overfit

Severity: Medium

Scenario:

```text
time calibration is learned during quiet markets
market volatility regime changes
stale oracle data slips through because thresholds are too relaxed
```

Required guard:

- Calibration metadata must include the volatility regime it covered.
- Current volatility above the calibrated regime fails closed.

Implementation hook:

- `SimulationResult.timeCalibrationMaxVolatilityBps`
- `SafeloopPolicy.maxCalibrationVolatilityMultiplier`
- `TIME_CALIBRATION_OVERFIT`

## DM-37: Partial Reconciliation Loop

Severity: High

Scenario:

```text
order partially fills
system marks neither success nor failure
reconciliation retries keep oscillating
agent never moves to cancel, fill, or new intent
```

Required guard:

- Partial reconciliation attempts must have a cap.
- Repeated partial-fill pending states become a distinct loop abort.

Implementation hook:

- `ActionLedgerRow.partialFillCount`
- `SafeloopPolicy.maxPartialReconciliationAttempts`
- `PARTIAL_RECONCILIATION_LOOP`

## DM-38: Guard Composition Failure

Severity: Critical

Scenario:

```text
individual guards are each correct
their combination breaks the emergency path
one guard aborts before another guard can preserve liveness
emergency transaction never signs
```

Required guard:

- Emergency flows must surface liveness-vs-safety guard conflicts explicitly.
- Operators should see composition failure instead of a generic abort set.

Implementation hook:

- `GUARD_COMPOSITION_FAILURE`

## DM-39: Mempool Quorum Illusion

Severity: Critical

Scenario:

```text
low-priority transaction is already propagating
emergency flow broadcasts a same-nonce cancel
multiple RPCs accept the cancel into their mempools
builder, sequencer, or validator ordering still lands the original transaction
system assumes cancellation and sends the emergency transaction
both effects execute or a closed position reopens
```

Required guard:

- Mempool quorum is not cancellation proof.
- Broadcast acceptance is telemetry only unless policy explicitly disables
  ordered proof requirements.
- Default policy requires ordered or confirmed cancellation proof before a
  non-partition emergency proceeds.
- Mempool-only quorum produces a distinct `MEMPOOL_QUORUM_ILLUSION` abort.

Implementation hook:

- `ActionLedgerRow.preemptionCancelStatus = "ordered"`
- `ActionLedgerRow.preemptionCancelOrderedAt`
- `ActionLedgerRow.preemptionCancelOrderSource`
- `SafeloopPolicy.requireOrderedCancellationProof`
- `MEMPOOL_QUORUM_ILLUSION`

## DM-40: RPC Quorum Partition Lock

Severity: High

Scenario:

```text
market volatility spikes
emergency close starts cancellation
RPCs return 429, timeout, or inconsistent partitioned results
quorum cannot form inside the emergency window
fail-closed cancellation gate blocks the close
account reaches liquidation before the guard clears
```

Required guard:

- RPC quorum failure is tracked separately from failed cancellation proof.
- Non-reduce-only emergency work still fails closed during partition.
- Reduce-only or close-all emergency closes can proceed through a narrow
  partition escape without marking the prior transaction canceled.
- The escape must remain exposure-reducing and nonce-domain aware.

Implementation hook:

- `ActionLedgerRow.preemptionCancelQuorumFailure`
- `AgentIntent.reduceOnly`
- `SafeloopPolicy.allowReduceOnlyEmergencyDuringQuorumPartition`
- `RPC_QUORUM_PARTITION`

## DM-F5: Chain Allowlist Gap

Severity: High

Scenario:

```text
agent provides a chainId dynamically
operation type is valid
chain is unsupported or untested
signer still builds or signs the operation
unsupported network behavior bypasses trajectory checks
```

Required guard:

- Policy must explicitly list supported chain IDs.
- Missing or empty allowlists block all chains.
- Unsupported chain IDs abort before ledger lock and signing.

Implementation hook:

- `SafeloopPolicy.supportedChainIds`
- `UNSUPPORTED_CHAIN`

## DM-F6: Public Credential Leak via Evidence Packets

Severity: Critical

Scenario:

```text
operator shares a demo, issue, or debug trace
evidence packet contains wallet address, RPC URL, nonce, tx hash, or token
public artifact becomes an intelligence leak
```

Required guard:

- Evidence packets must be sanitized before operator logging or sharing.
- Sanitization is default-on for addresses, RPC URLs, nonce fields, tx hashes,
  authorization headers, API keys, and token-like strings.
- Public docs and tests must not contain live credentials or operator logs.

Implementation hook:

- `sanitizeEvidencePacket`

## DM-F7: Signed Operation Intent Mismatch

Severity: Critical

Scenario:

```text
canonical intent passes simulation and trajectory checks
signer returns a signed operation with different chain, target, route, or amount
system accepts signed payload without comparing it to the approved intent
post-sign mismatch leaves nonce, gas, and lock reservations behind
```

Required guard:

- Signers must provide post-sign assertion against the canonical intent.
- Missing assertion support fails closed before signing.
- Mismatched signed operations fail closed after signing and must run cleanup.
- Cleanup releases or invalidates nonce, gas reservation, lock lease, and
  fencing resources.
- Cleanup failure records a distinct reason.

Implementation hook:

- `MmawSigner.assertSignedOperationMatchesIntent`
- `SafeloopPolicy.requirePostSignIntentAssertion`
- `SIGNED_OPERATION_ASSERTION_REQUIRED`
- `SIGNED_OPERATION_INTENT_MISMATCH`
- `POST_SIGN_CLEANUP_REQUIRED`
