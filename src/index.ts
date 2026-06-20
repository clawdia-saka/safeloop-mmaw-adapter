import { createHash, randomUUID } from "node:crypto";

import { canonicalizePerpsFields } from "./hip3.js";

export * from "./metamask.js";
export * from "./hip3.js";
export * from "./reconciliation.js";
export * from "./hyperliquid.js";
export * from "./evidence.js";

export type ActionType =
  | "swap"
  | "transfer"
  | "approve"
  | "lend"
  | "borrow"
  | "bridge"
  | "perps_open"
  | "perps_close"
  | "perps_modify"
  | "perps_cancel"
  | "perps_deposit"
  | "perps_withdraw";

export type LedgerStatus =
  | "PLANNED"
  | "LOCKED"
  | "SIMULATED"
  | "APPROVED_FOR_SIGNING"
  | "SIGNING"
  | "SIGNED"
  | "REQUEST_PENDING"
  | "REQUEST_WATCH_REQUIRED"
  | "AWAITING_HUMAN_APPROVAL"
  | "SUBMITTED"
  | "BROADCASTING"
  | "LANDED"
  | "VENUE_RECONCILED"
  | "CONFIRMED"
  | "ABORTED"
  | "SIGN_FAILED"
  | "REVERTED"
  | "TIMED_OUT";

export type AbortReason =
  | "DUPLICATE_INTENT"
  | "LEDGER_LOCK_CONFLICT"
  | "REVERSE_SWAP_LOOP"
  | "CUMULATIVE_LOSS_LIMIT"
  | "NAV_DELTA_LIMIT"
  | "UNBOUNDED_APPROVAL"
  | "MISSING_DOWNSTREAM_INTENT"
  | "RETRY_STORM"
  | "SIMULATION_FAILED"
  | "SIMULATION_UNAVAILABLE"
  | "TOKEN_CONTRACT_REQUIRED"
  | "TOKEN_SYMBOL_AMBIGUOUS"
  | "HIP3_SYMBOL_AMBIGUOUS"
  | "TESTNET_USDC_MISMATCH"
  | "UNSUPPORTED_CHAIN"
  | "QUOTE_ONLY_NOT_EXECUTED"
  | "POSITION_NOT_RECONCILED"
  | "POSITION_DELTA_MISMATCH"
  | "GAS_EXCEEDS_TRADE_VALUE"
  | "BROADCASTING_TIMEOUT"
  | "BROADCAST_TRACKING_EXPIRED"
  | "HUMAN_APPROVAL_REQUIRED"
  | "DURABLE_LEDGER_REQUIRED"
  | "ATOMIC_LOCK_REQUIRED"
  | "LOCK_LEASE_REQUIRED"
  | "LOCK_LEASE_EXPIRED"
  | "LOCK_OWNERSHIP_REQUIRED"
  | "LOCK_OWNERSHIP_LOST"
  | "ACCOUNT_LOCK_REQUIRED"
  | "GLOBAL_COLLATERAL_LOCK_REQUIRED"
  | "GLOBAL_COLLATERAL_LOCK_CONTENTION"
  | "CROSS_VENUE_RECONCILIATION_DEADLOCK"
  | "PRIORITY_LOCK_REQUIRED"
  | "COLLATERAL_POOL_REQUIRED"
  | "POOL_LEAKAGE_RISK"
  | "SIGNATURE_RECONCILIATION_REQUIRED"
  | "SIGNATURE_EXPIRY_REQUIRED"
  | "SIGNATURE_EXPIRED"
  | "SIGNER_INTENT_BINDING_REQUIRED"
  | "SIGNED_OPERATION_ASSERTION_REQUIRED"
  | "SIGNED_OPERATION_INTENT_MISMATCH"
  | "POST_SIGN_CLEANUP_REQUIRED"
  | "INTENT_LOCK_REQUIRED"
  | "STALE_RECONCILIATION"
  | "CLOCK_DRIFT_LIMIT"
  | "ORACLE_MONOTONIC_AGE_REQUIRED"
  | "TIME_CALIBRATION_REQUIRED"
  | "TIME_CALIBRATION_STALE"
  | "TIME_CALIBRATION_UNSAFE"
  | "ORACLE_PRICE_STALE"
  | "NON_EVM_SIMULATION_REQUIRED"
  | "MARGIN_RATIO_LIMIT"
  | "LIQUIDATION_PRICE_TOO_CLOSE"
  | "ACCOUNT_HEALTH_LIMIT"
  | "GAS_RUNWAY_LOW"
  | "GAS_BURN_RATE_LIMIT"
  | "IN_FLIGHT_GAS_RESERVED"
  | "REVERT_GAS_BURN_UNACCOUNTED"
  | "PARTIAL_FILL_PENDING"
  | "OVER_ALLOCATION_RISK"
  | "LOCK_LEASE_EXTENSION_REQUIRED"
  | "NON_PREEMPTABLE_SIGNING_LOCK"
  | "PREEMPTION_LIVELOCK_RISK"
  | "PREEMPTION_CANCEL_REQUIRED"
  | "PREEMPTION_CANCEL_QUORUM_REQUIRED"
  | "CANCELLATION_PROOF_INDEXING_LAG"
  | "MEMPOOL_QUORUM_ILLUSION"
  | "RPC_QUORUM_PARTITION"
  | "CANCELLATION_PROOF_STALE"
  | "CANCEL_PROOF_FALSE_POSITIVE_RISK"
  | "NONCE_DOMAIN_REQUIRED"
  | "NONCE_DOMAIN_COLLISION"
  | "PREEMPTED_TX_STILL_LIVE"
  | "EMERGENCY_CLOSE_STARVATION"
  | "LOCK_FENCING_REQUIRED"
  | "LOCK_RELEASE_SPLIT_BRAIN"
  | "GAS_RESERVATION_DRIFT"
  | "TIME_CALIBRATION_OVERFIT"
  | "PARTIAL_RECONCILIATION_LOOP"
  | "GUARD_COMPOSITION_FAILURE"
  | "UNKNOWN_STATE";

export type AgentIntent = {
  userGoalId: string;
  wallet: `0x${string}`;
  chainId: number;
  actionType: ActionType;
  assetIn?: string;
  assetOut?: string;
  amountIn?: string;
  amountOutMin?: string;
  estimatedTradeValueUsd?: string;
  targetContract?: `0x${string}`;
  calldata?: `0x${string}`;
  route?: string[];
  expectedUtility?: string;
  quoteId?: string;
  pollingId?: string;
  txHash?: `0x${string}`;
  nonceDomain?: string;
  nonce?: number;
  tokenContract?: `0x${string}`;
  tokenSymbol?: string;
  isTestnetUsdc?: boolean;
  requiresDex?: boolean;
  venue?: "hyperliquid";
  network?: "mainnet" | "testnet";
  accountId?: string;
  collateralPoolId?: string;
  priority?: "emergency" | "high" | "normal" | "low";
  dex?: string;
  symbol?: string;
  side?: "long" | "short";
  size?: string;
  leverage?: string;
  orderType?: "market" | "limit";
  limitPx?: string;
  takeProfitPx?: string;
  stopLossPx?: string;
  maxSlippageBps?: string;
  orderId?: string;
  closeAll?: boolean;
  reduceOnly?: boolean;
};

export type CanonicalIntent = Omit<AgentIntent, "calldata" | "route"> & {
  calldataHash?: string;
  routeHash?: string;
  roundedAmountBucket?: string;
  timeBucket: string;
};

export type ActionLedgerRow = CanonicalIntent & {
  intentId: string;
  idempotencyKey: string;
  status: LedgerStatus;
  reasonCodes: AbortReason[];
  quoteId?: string;
  pollingId?: string;
  txHash?: `0x${string}`;
  lockScope?: string;
  accountLockScope?: string;
  globalCollateralLockScope?: string;
  lockOwnerId?: string;
  lockEpoch?: number;
  lockedUntil?: string;
  signatureExpiresAt?: string;
  preemptionCount?: number;
  lastPreemptedAt?: string;
  preemptionCancelStatus?:
    | "not_required"
    | "required"
    | "submitted"
    | "broadcast_accepted"
    | "ordered"
    | "confirmed";
  preemptionCancelTxHash?: `0x${string}`;
  preemptionCancelNonce?: number;
  preemptionCancelReplacesTxHash?: `0x${string}`;
  preemptionCancelSubmittedAt?: string;
  preemptionCancelObservedAt?: string;
  preemptionCancelOrderedAt?: string;
  preemptionCancelOrderSource?: "builder" | "sequencer" | "chain";
  preemptionCancelRpcQuorum?: number;
  preemptionCancelQuorumFailure?: "rate_limited" | "timeout" | "partitioned";
  gasReservationStatus?: "none" | "reserved" | "released" | "consumed";
  gasReservedUsd?: string;
  gasReservationUpdatedAt?: string;
  partialFillCount?: number;
  lastPartialFillAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SimulationResult = {
  status: "passed" | "failed" | "unavailable";
  preNavUsd: string;
  postNavUsd: string;
  gasUsd: string;
  slippageUsd: string;
  maxLossUsd: string;
  tradeValueUsd?: string;
  quoteExecuted?: boolean;
  positionReconciled?: boolean;
  broadcastStatus?: "broadcasting" | "expired" | "landed" | "unknown";
  requiresHumanApproval?: boolean;
  reconciledAt?: string;
  oracleObservedAt?: string;
  oracleMonotonicAgeMs?: number;
  oracleSource?: string;
  clockSkewMs?: number;
  timeCalibrationSource?: "durable" | "local" | "unknown";
  timeCalibrationSyncedAt?: string;
  timeCalibrationRoundTripMs?: number;
  timeCalibrationMaxVolatilityBps?: number;
  volatilityBps?: number;
  signatureExpiresAt?: string;
  filledSize?: string;
  expectedFillSize?: string;
  fillStatus?: "none" | "partial" | "filled";
  validUntilBlock?: number;
  venueSimulation?: "evm" | "hyperliquid-margin-model" | "hyperliquid-api" | "unknown";
  marginRatioBps?: number;
  liquidationBufferBps?: number;
  accountMarginRatioBps?: number;
  accountLiquidationBufferBps?: number;
  accountExposureUsd?: string;
  nativeBalanceUsd?: string;
  estimatedMaxGasUsd?: string;
  inFlightGasUsd?: string;
  revertedGasUsd?: string;
  gasSpentLookbackUsd?: string;
  gasRunwayTransactions?: number;
  venueReasonCodes?: AbortReason[];
  reason?: string;
};

export type SafetyEnvelope<TUnsignedOperation = unknown> = {
  intentId: string;
  idempotencyKey: string;
  canonicalIntent: CanonicalIntent;
  unsignedOperation: TUnsignedOperation;
  simulation: SimulationResult;
  decision: {
    allow: boolean;
    reasonCodes: AbortReason[];
  };
};

export type Ledger = {
  capabilities?: {
    durable: boolean;
    atomicLocks: boolean;
    lockLeases?: boolean;
    ownedLocks?: boolean;
    accountScopedLocks?: boolean;
    globalCollateralLocks?: boolean;
    lockLeaseRenewal?: boolean;
    inFlightGasAccounting?: boolean;
    priorityLocks?: boolean;
    preemptionCancellation?: boolean;
    lockFencing?: boolean;
  };
  tryLock(row: ActionLedgerRow): Promise<boolean>;
  verifyLock?(row: ActionLedgerRow): Promise<boolean>;
  markStatus(
    intentId: string,
    status: LedgerStatus,
    reasonCodes?: AbortReason[],
  ): Promise<void>;
  cleanupPostSignFailure?(params: {
    row: ActionLedgerRow;
    reasonCodes: AbortReason[];
    signedOperation: unknown;
  }): Promise<{ ok: boolean; reasonCodes?: AbortReason[] } | void>;
  recentForWallet(params: {
    wallet: string;
    chainId?: number;
    lookbackMinutes: number;
  }): Promise<ActionLedgerRow[]>;
};

export type MmawSigner<TUnsignedOperation, TSignedOperation> = {
  capabilities?: {
    intentBoundSignatures?: boolean;
  };
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
  assertSignedOperationMatchesIntent?(params: {
    intent: CanonicalIntent;
    unsignedOperation: TUnsignedOperation;
    signedOperation: TSignedOperation;
  }): Promise<boolean> | boolean;
};

export type Simulator<TUnsignedOperation> = {
  simulate(
    operation: TUnsignedOperation,
    intent: CanonicalIntent,
  ): Promise<SimulationResult>;
};

export type SafeloopPolicy = {
  idempotencyWindowMinutes: number;
  trajectoryLookbackMinutes: number;
  retryLookbackMinutes: number;
  maxAttemptsPerGoal: number;
  maxLossUsd: string;
  maxLossBps: number;
  maxFeeToTradeValueBps: number;
  nativeTokenSymbols: string[];
  supportedChainIds: number[];
  hip3SymbolsRequireDex: string[];
  requireDurableLedger: boolean;
  maxReconciliationAgeMs: number;
  lockLeaseMs: number;
  maxOracleAgeMs: number;
  highVolatilityOracleAgeMs: number;
  oracleVolatilityThresholdBps: number;
  requireMonotonicOracleAge: boolean;
  requireDurableTimeCalibration: boolean;
  maxClockSkewMs: number;
  maxTimeCalibrationAgeMs: number;
  maxTimeCalibrationRoundTripMs: number;
  requireExpiringSignatures: boolean;
  requireSignerIntentBinding: boolean;
  requirePostSignIntentAssertion: boolean;
  maxSignatureTtlMs: number;
  maxHumanApprovalMs: number;
  maxGlobalCollateralContentionMs: number;
  minPreemptionAgeMs: number;
  nonPreemptableSigningMs: number;
  preemptionWindowMs: number;
  maxPreemptionsPerWindow: number;
  requirePreemptionCancellation: boolean;
  maxPreemptionCancelProofWaitMs: number;
  maxPreemptionCancelAcceptanceAgeMs: number;
  minPreemptionCancelRpcQuorum: number;
  requireNonceBoundCancellation: boolean;
  requireOrderedCancellationProof: boolean;
  allowReduceOnlyEmergencyDuringQuorumPartition: boolean;
  requireLockFencing: boolean;
  maxLowPriorityQueueAheadOfEmergency: number;
  maxStaleGasReservationUsd: string;
  maxPartialReconciliationAttempts: number;
  maxCalibrationVolatilityMultiplier: number;
  minMarginRatioBps: number;
  minLiquidationBufferBps: number;
  requireAccountWideLock: boolean;
  requireGlobalCollateralLock: boolean;
  requireExplicitCollateralPool: boolean;
  minAccountMarginRatioBps: number;
  minAccountLiquidationBufferBps: number;
  maxAccountExposureUsd: string;
  minGasRunwayTransactions: number;
  maxGasSpendLookbackUsd: string;
};

export const defaultPolicy: SafeloopPolicy = {
  idempotencyWindowMinutes: 15,
  trajectoryLookbackMinutes: 30,
  retryLookbackMinutes: 15,
  maxAttemptsPerGoal: 3,
  maxLossUsd: "25",
  maxLossBps: 50,
  maxFeeToTradeValueBps: 1_000,
  nativeTokenSymbols: ["ETH", "MATIC", "BNB", "AVAX"],
  supportedChainIds: [],
  hip3SymbolsRequireDex: ["SPCX"],
  requireDurableLedger: true,
  maxReconciliationAgeMs: 30_000,
  lockLeaseMs: 120_000,
  maxOracleAgeMs: 5_000,
  highVolatilityOracleAgeMs: 500,
  oracleVolatilityThresholdBps: 250,
  requireMonotonicOracleAge: true,
  requireDurableTimeCalibration: true,
  maxClockSkewMs: 250,
  maxTimeCalibrationAgeMs: 60_000,
  maxTimeCalibrationRoundTripMs: 250,
  requireExpiringSignatures: true,
  requireSignerIntentBinding: true,
  requirePostSignIntentAssertion: true,
  maxSignatureTtlMs: 15_000,
  maxHumanApprovalMs: 300_000,
  maxGlobalCollateralContentionMs: 120_000,
  minPreemptionAgeMs: 2_000,
  nonPreemptableSigningMs: 5_000,
  preemptionWindowMs: 30_000,
  maxPreemptionsPerWindow: 1,
  requirePreemptionCancellation: true,
  maxPreemptionCancelProofWaitMs: 1_500,
  maxPreemptionCancelAcceptanceAgeMs: 5_000,
  minPreemptionCancelRpcQuorum: 2,
  requireNonceBoundCancellation: true,
  requireOrderedCancellationProof: true,
  allowReduceOnlyEmergencyDuringQuorumPartition: true,
  requireLockFencing: true,
  maxLowPriorityQueueAheadOfEmergency: 3,
  maxStaleGasReservationUsd: "0",
  maxPartialReconciliationAttempts: 3,
  maxCalibrationVolatilityMultiplier: 2,
  minMarginRatioBps: 12_500,
  minLiquidationBufferBps: 500,
  requireAccountWideLock: true,
  requireGlobalCollateralLock: true,
  requireExplicitCollateralPool: true,
  minAccountMarginRatioBps: 12_500,
  minAccountLiquidationBufferBps: 500,
  maxAccountExposureUsd: "10000",
  minGasRunwayTransactions: 10,
  maxGasSpendLookbackUsd: "100",
};

export class SafeloopAbort extends Error {
  constructor(
    public readonly reasonCodes: AbortReason[],
    message = "SAFELOOP_ABORT_PRE_SIGN",
  ) {
    super(message);
    this.name = "SafeloopAbort";
  }
}

export function canonicalizeIntent(
  intent: AgentIntent,
  now = new Date(),
): CanonicalIntent {
  const timeBucket = bucketIso(now, 15);

  return {
    userGoalId: intent.userGoalId,
    wallet: lowerAddress(intent.wallet),
    chainId: intent.chainId,
    actionType: intent.actionType,
    assetIn: intent.assetIn?.toLowerCase(),
    assetOut: intent.assetOut?.toLowerCase(),
    amountIn: normalizeDecimal(intent.amountIn),
    amountOutMin: normalizeDecimal(intent.amountOutMin),
    estimatedTradeValueUsd: normalizeDecimal(intent.estimatedTradeValueUsd),
    targetContract: intent.targetContract
      ? lowerAddress(intent.targetContract)
      : undefined,
    calldataHash: intent.calldata
      ? sha256(intent.calldata.toLowerCase())
      : undefined,
    routeHash: intent.route
      ? sha256(JSON.stringify(intent.route.map((entry) => entry.toLowerCase())))
      : undefined,
    expectedUtility: intent.expectedUtility,
    quoteId: intent.quoteId,
    pollingId: intent.pollingId,
    txHash: intent.txHash ? lowerAddress(intent.txHash) : undefined,
    nonceDomain: intent.nonceDomain?.toLowerCase(),
    nonce: intent.nonce,
    tokenContract: intent.tokenContract ? lowerAddress(intent.tokenContract) : undefined,
    tokenSymbol: intent.tokenSymbol?.toUpperCase(),
    isTestnetUsdc: intent.isTestnetUsdc,
    requiresDex: intent.requiresDex,
    accountId: intent.accountId?.toLowerCase(),
    collateralPoolId: intent.collateralPoolId?.toLowerCase(),
    priority: intent.priority ?? inferPriority(intent),
    ...canonicalizePerpsFields(intent),
    roundedAmountBucket: roundAmountBucket(intent.amountIn ?? intent.size),
    timeBucket,
  };
}

export function makeIdempotencyKey(intent: CanonicalIntent): string {
  return sha256(
    stableJson({
      actionType: intent.actionType,
      amountBucket: intent.roundedAmountBucket,
      assetIn: intent.assetIn,
      assetOut: intent.assetOut,
      calldataHash: intent.calldataHash,
      chainId: intent.chainId,
      routeHash: intent.routeHash,
      quoteId: intent.quoteId,
      tokenContract: intent.tokenContract,
      tokenSymbol: intent.tokenSymbol,
      dex: intent.dex,
      accountId: intent.accountId,
      collateralPoolId: intent.collateralPoolId,
      priority: intent.priority,
      network: intent.network,
      orderId: intent.orderId,
      orderType: intent.orderType,
      closeAll: intent.closeAll,
      leverage: intent.leverage,
      limitPx: intent.limitPx,
      maxSlippageBps: intent.maxSlippageBps,
      side: intent.side,
      size: intent.size,
      symbol: intent.symbol,
      takeProfitPx: intent.takeProfitPx,
      stopLossPx: intent.stopLossPx,
      targetContract: intent.targetContract,
      timeBucket: intent.timeBucket,
      userGoalId: intent.userGoalId,
      wallet: intent.wallet,
    }),
  );
}

export function makeLockScope(intent: CanonicalIntent): string {
  const market = intent.symbol ?? intent.assetOut ?? intent.assetIn ?? "wallet";
  return [
    intent.wallet,
    intent.chainId,
    intent.venue ?? "evm",
    intent.dex ?? "main",
    market,
  ]
    .join(":")
    .toLowerCase();
}

export function makeAccountLockScope(
  intent: CanonicalIntent,
): string | undefined {
  if (!intent.actionType.startsWith("perps_")) return undefined;
  return [
    intent.wallet,
    intent.chainId,
    intent.venue ?? "hyperliquid",
    intent.accountId ?? "default",
    "account",
  ]
    .join(":")
    .toLowerCase();
}

export function makeGlobalCollateralLockScope(
  intent: CanonicalIntent,
): string | undefined {
  if (!usesSharedCollateral(intent)) return undefined;
  if (!intent.collateralPoolId) return undefined;
  return [
    intent.wallet,
    intent.collateralPoolId,
    "global-collateral",
  ]
    .join(":")
    .toLowerCase();
}

export async function failClosedSign<TUnsignedOperation, TSignedOperation>(
  params: {
    intent: AgentIntent;
    ledger: Ledger;
    mmaw: MmawSigner<TUnsignedOperation, TSignedOperation>;
    simulator: Simulator<TUnsignedOperation>;
    policy?: Partial<SafeloopPolicy>;
  },
): Promise<TSignedOperation> {
  const policy = { ...defaultPolicy, ...params.policy };
  const canonicalIntent = canonicalizeIntent(params.intent);
  const intentId = sha256(stableJson(canonicalIntent));
  const idempotencyKey = makeIdempotencyKey(canonicalIntent);
  const lockScope = makeLockScope(canonicalIntent);
  const accountLockScope = makeAccountLockScope(canonicalIntent);
  const globalCollateralLockScope =
    makeGlobalCollateralLockScope(canonicalIntent);
  const now = new Date().toISOString();

  const preflightReasons: AbortReason[] = [];
  if (!isSupportedChain(canonicalIntent.chainId, policy)) {
    preflightReasons.push("UNSUPPORTED_CHAIN");
  }
  if (
    policy.requirePostSignIntentAssertion &&
    !params.mmaw.assertSignedOperationMatchesIntent
  ) {
    preflightReasons.push("SIGNED_OPERATION_ASSERTION_REQUIRED");
  }

  if (policy.requireDurableLedger) {
    if (!params.ledger.capabilities?.durable) {
      preflightReasons.push("DURABLE_LEDGER_REQUIRED");
    }
    if (!params.ledger.capabilities?.atomicLocks) {
      preflightReasons.push("ATOMIC_LOCK_REQUIRED");
    }
    if (!params.ledger.capabilities?.lockLeases) {
      preflightReasons.push("LOCK_LEASE_REQUIRED");
    }
    if (!params.ledger.capabilities?.ownedLocks || !params.ledger.verifyLock) {
      preflightReasons.push("LOCK_OWNERSHIP_REQUIRED");
    }
    if (!params.ledger.capabilities?.lockLeaseRenewal) {
      preflightReasons.push("LOCK_LEASE_EXTENSION_REQUIRED");
    }
    if (!params.ledger.capabilities?.inFlightGasAccounting) {
      preflightReasons.push("IN_FLIGHT_GAS_RESERVED");
    }
    if (!params.ledger.capabilities?.priorityLocks) {
      preflightReasons.push("PRIORITY_LOCK_REQUIRED");
    }
    if (
      policy.requirePreemptionCancellation &&
      !params.ledger.capabilities?.preemptionCancellation
    ) {
      preflightReasons.push("PREEMPTION_CANCEL_REQUIRED");
    }
    if (policy.requireLockFencing && !params.ledger.capabilities?.lockFencing) {
      preflightReasons.push("LOCK_FENCING_REQUIRED");
    }
    if (
      policy.requireAccountWideLock &&
      canonicalIntent.actionType.startsWith("perps_") &&
      !params.ledger.capabilities?.accountScopedLocks
    ) {
      preflightReasons.push("ACCOUNT_LOCK_REQUIRED");
    }
    if (
      policy.requireGlobalCollateralLock &&
      usesSharedCollateral(canonicalIntent) &&
      !params.ledger.capabilities?.globalCollateralLocks
    ) {
      preflightReasons.push("GLOBAL_COLLATERAL_LOCK_REQUIRED");
    }
    if (
      policy.requireExplicitCollateralPool &&
      usesSharedCollateral(canonicalIntent) &&
      !canonicalIntent.collateralPoolId
    ) {
      preflightReasons.push("COLLATERAL_POOL_REQUIRED");
    }
    if (
      policy.requireSignerIntentBinding &&
      !params.mmaw.capabilities?.intentBoundSignatures
    ) {
      preflightReasons.push("SIGNER_INTENT_BINDING_REQUIRED");
    }
  }
  if (preflightReasons.length > 0) throw new SafeloopAbort(preflightReasons);

  const row: ActionLedgerRow = {
    ...canonicalIntent,
    intentId,
    idempotencyKey,
    lockScope,
    status: "LOCKED",
    reasonCodes: [],
    quoteId: canonicalIntent.quoteId,
    pollingId: canonicalIntent.pollingId,
    txHash: canonicalIntent.txHash,
    accountLockScope,
    globalCollateralLockScope,
    lockOwnerId: randomUUID(),
    lockedUntil: new Date(Date.now() + policy.lockLeaseMs).toISOString(),
    createdAt: now,
    updatedAt: now,
  };

  const locked = await params.ledger.tryLock(row);
  if (!locked) {
    await params.ledger.markStatus(intentId, "ABORTED", [
      "LEDGER_LOCK_CONFLICT",
      "INTENT_LOCK_REQUIRED",
    ]);
    throw new SafeloopAbort(["LEDGER_LOCK_CONFLICT", "INTENT_LOCK_REQUIRED"]);
  }

  let unsignedOperation: TUnsignedOperation;
  let simulation: SimulationResult;
  try {
    unsignedOperation = await params.mmaw.buildUnsignedOperation(canonicalIntent);
    simulation = await params.simulator.simulate(
      unsignedOperation,
      canonicalIntent,
    );
  } catch (error) {
    await params.ledger.markStatus(intentId, "ABORTED", [
      "SIMULATION_UNAVAILABLE",
    ]);
    throw error;
  }
  row.signatureExpiresAt = simulation.signatureExpiresAt;

  await params.ledger.markStatus(intentId, "SIMULATED");

  const history = await params.ledger.recentForWallet({
    wallet: canonicalIntent.wallet,
    chainId: canonicalIntent.chainId,
    lookbackMinutes: policy.trajectoryLookbackMinutes,
  });

  const reasonCodes = checkTrajectoryInvariants({
    current: row,
    history,
    simulation,
    policy,
  });

  const envelope: SafetyEnvelope<TUnsignedOperation> = {
    intentId,
    idempotencyKey,
    canonicalIntent,
    unsignedOperation,
    simulation,
    decision: {
      allow: reasonCodes.length === 0,
      reasonCodes,
    },
  };

  if (!envelope.decision.allow) {
    await params.ledger.markStatus(intentId, "ABORTED", reasonCodes);
    throw new SafeloopAbort(reasonCodes);
  }

  await params.ledger.markStatus(intentId, "APPROVED_FOR_SIGNING");
  await verifyActiveLockOwnership(params.ledger, row);
  await params.ledger.markStatus(intentId, "SIGNING");
  await verifyActiveLockOwnership(params.ledger, row);

  try {
    const signed = await params.mmaw.sign(unsignedOperation);
    if (policy.requirePostSignIntentAssertion) {
      const matchesIntent =
        await params.mmaw.assertSignedOperationMatchesIntent?.({
          intent: canonicalIntent,
          unsignedOperation,
          signedOperation: signed,
        });
      if (!matchesIntent) {
        const reasonCodes = await cleanupAfterPostSignMismatch({
          ledger: params.ledger,
          row,
          signedOperation: signed,
        });
        throw new SafeloopAbort(reasonCodes);
      }
    }
    await params.ledger.markStatus(intentId, "SIGNED");
    return signed;
  } catch (error) {
    if (
      error instanceof SafeloopAbort &&
      error.reasonCodes.includes("SIGNED_OPERATION_INTENT_MISMATCH")
    ) {
      throw error;
    }
    await params.ledger.markStatus(intentId, "SIGN_FAILED", ["UNKNOWN_STATE"]);
    throw error;
  }
}

async function cleanupAfterPostSignMismatch(params: {
  ledger: Ledger;
  row: ActionLedgerRow;
  signedOperation: unknown;
}): Promise<AbortReason[]> {
  const reasonCodes: AbortReason[] = ["SIGNED_OPERATION_INTENT_MISMATCH"];

  try {
    const cleanupResult = await params.ledger.cleanupPostSignFailure?.({
      row: params.row,
      signedOperation: params.signedOperation,
      reasonCodes,
    });
    if (cleanupResult && !cleanupResult.ok) {
      reasonCodes.push("POST_SIGN_CLEANUP_REQUIRED");
      for (const reason of cleanupResult.reasonCodes ?? []) {
        reasonCodes.push(reason);
      }
    }
  } catch {
    reasonCodes.push("POST_SIGN_CLEANUP_REQUIRED");
  }

  await params.ledger.markStatus(params.row.intentId, "SIGN_FAILED", reasonCodes);
  return [...new Set(reasonCodes)];
}

async function verifyActiveLockOwnership(ledger: Ledger, row: ActionLedgerRow) {
  const ownsLock = await ledger.verifyLock?.(row);
  if (!ownsLock) {
    await ledger.markStatus(row.intentId, "ABORTED", ["LOCK_OWNERSHIP_LOST"]);
    throw new SafeloopAbort(["LOCK_OWNERSHIP_LOST"]);
  }
}

export function checkTrajectoryInvariants(params: {
  current: ActionLedgerRow;
  history: ActionLedgerRow[];
  simulation: SimulationResult;
  policy: SafeloopPolicy;
}): AbortReason[] {
  const reasons = new Set<AbortReason>();
  const { current, history, simulation, policy } = params;

  if (simulation.status === "failed") reasons.add("SIMULATION_FAILED");
  if (simulation.status === "unavailable") reasons.add("SIMULATION_UNAVAILABLE");
  if (simulation.status === "failed" && simulation.revertedGasUsd === undefined) {
    reasons.add("REVERT_GAS_BURN_UNACCOUNTED");
  }
  if (simulation.quoteExecuted === false) reasons.add("QUOTE_ONLY_NOT_EXECUTED");
  if (simulation.positionReconciled === false) {
    reasons.add("POSITION_NOT_RECONCILED");
  }
  if (
    simulation.fillStatus === "partial" ||
    hasUnfilledExpectedSize(simulation)
  ) {
    reasons.add("PARTIAL_FILL_PENDING");
  }
  if (hasPartialReconciliationLoop(current, history, policy)) {
    reasons.add("PARTIAL_RECONCILIATION_LOOP");
  }
  if (simulation.broadcastStatus === "expired") {
    reasons.add("BROADCAST_TRACKING_EXPIRED");
  }
  if (simulation.broadcastStatus === "broadcasting") {
    reasons.add("BROADCASTING_TIMEOUT");
  }
  if (simulation.requiresHumanApproval) {
    reasons.add("HUMAN_APPROVAL_REQUIRED");
  }
  if (simulation.reconciledAt && isStaleObservation(simulation.reconciledAt, policy)) {
    reasons.add("STALE_RECONCILIATION");
  }
  if (current.lockedUntil && isExpired(current.lockedUntil)) {
    reasons.add("LOCK_LEASE_EXPIRED");
  }
  if (policy.requireLockFencing && hasLockFencingGap(current, history)) {
    reasons.add("LOCK_FENCING_REQUIRED");
    reasons.add("LOCK_RELEASE_SPLIT_BRAIN");
  }
  if (
    policy.requireExplicitCollateralPool &&
    usesSharedCollateral(current) &&
    !current.collateralPoolId
  ) {
    reasons.add("COLLATERAL_POOL_REQUIRED");
    reasons.add("POOL_LEAKAGE_RISK");
  }
  if (policy.requireExpiringSignatures) {
    if (!simulation.signatureExpiresAt && simulation.validUntilBlock === undefined) {
      reasons.add("SIGNATURE_EXPIRY_REQUIRED");
    }
    if (
      simulation.signatureExpiresAt &&
      isSignatureExpiryUnsafe(simulation.signatureExpiresAt, policy)
    ) {
      reasons.add("SIGNATURE_EXPIRY_REQUIRED");
    }
    if (simulation.signatureExpiresAt && isExpired(simulation.signatureExpiresAt)) {
      reasons.add("SIGNATURE_EXPIRED");
    }
  }
  if (current.actionType.startsWith("perps_")) {
    if (
      !simulation.venueSimulation ||
      simulation.venueSimulation === "evm" ||
      simulation.venueSimulation === "unknown"
    ) {
      reasons.add("NON_EVM_SIMULATION_REQUIRED");
    }
    if (
      simulation.marginRatioBps !== undefined &&
      simulation.marginRatioBps < policy.minMarginRatioBps
    ) {
      reasons.add("MARGIN_RATIO_LIMIT");
    }
    if (
      simulation.liquidationBufferBps !== undefined &&
      simulation.liquidationBufferBps < policy.minLiquidationBufferBps
    ) {
      reasons.add("LIQUIDATION_PRICE_TOO_CLOSE");
    }
    if (
      simulation.accountMarginRatioBps !== undefined &&
      simulation.accountMarginRatioBps < policy.minAccountMarginRatioBps
    ) {
      reasons.add("ACCOUNT_HEALTH_LIMIT");
    }
    if (
      simulation.accountLiquidationBufferBps !== undefined &&
      simulation.accountLiquidationBufferBps <
        policy.minAccountLiquidationBufferBps
    ) {
      reasons.add("ACCOUNT_HEALTH_LIMIT");
    }
    if (
      parseMoney(simulation.accountExposureUsd ?? "0") >
      parseMoney(policy.maxAccountExposureUsd)
    ) {
      reasons.add("ACCOUNT_HEALTH_LIMIT");
    }
    if (
      !simulation.oracleObservedAt ||
      isOraclePriceStale(simulation.oracleObservedAt, simulation, policy)
    ) {
      reasons.add("ORACLE_PRICE_STALE");
    }
    if (
      policy.requireMonotonicOracleAge &&
      simulation.oracleMonotonicAgeMs === undefined
    ) {
      reasons.add("ORACLE_MONOTONIC_AGE_REQUIRED");
    }
    if (
      simulation.clockSkewMs !== undefined &&
      Math.abs(simulation.clockSkewMs) > policy.maxClockSkewMs
    ) {
      reasons.add("CLOCK_DRIFT_LIMIT");
    }
    if (policy.requireDurableTimeCalibration) {
      if (
        simulation.timeCalibrationSource !== "durable" ||
        !simulation.timeCalibrationSyncedAt
      ) {
        reasons.add("TIME_CALIBRATION_REQUIRED");
      }
      if (
        simulation.timeCalibrationSyncedAt &&
        isOlderThanMs(
          simulation.timeCalibrationSyncedAt,
          policy.maxTimeCalibrationAgeMs,
        )
      ) {
        reasons.add("TIME_CALIBRATION_STALE");
      }
      if (
        simulation.timeCalibrationRoundTripMs !== undefined &&
        simulation.timeCalibrationRoundTripMs >
          policy.maxTimeCalibrationRoundTripMs
      ) {
        reasons.add("TIME_CALIBRATION_UNSAFE");
      }
      if (isCalibrationOverfit(simulation, policy)) {
        reasons.add("TIME_CALIBRATION_OVERFIT");
      }
    }
    for (const reason of simulation.venueReasonCodes ?? []) {
      reasons.add(reason);
    }
  }

  const activeDuplicate = history.some(
    (row) =>
      row.idempotencyKey === current.idempotencyKey &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status),
  );
  if (activeDuplicate) reasons.add("DUPLICATE_INTENT");

  const reverseSwap =
    current.actionType === "swap" &&
    history.some(
      (row) =>
        row.actionType === "swap" &&
        row.wallet === current.wallet &&
        row.chainId === current.chainId &&
        row.assetIn === current.assetOut &&
        row.assetOut === current.assetIn &&
        isMeaningfulPriorAction(row.status),
    );
  if (reverseSwap) reasons.add("REVERSE_SWAP_LOOP");

  const activeSameScope = history.some(
    (row) =>
      current.lockScope !== undefined &&
      row.lockScope !== undefined &&
      row.lockScope === current.lockScope &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status) &&
      isBlockingLock(row, policy),
  );
  if (activeSameScope) reasons.add("OVER_ALLOCATION_RISK");

  const activeSameAccountScope = history.some(
    (row) =>
      current.accountLockScope !== undefined &&
      row.accountLockScope === current.accountLockScope &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status) &&
      isBlockingLock(row, policy),
  );
  if (activeSameAccountScope) {
    reasons.add("ACCOUNT_LOCK_REQUIRED");
    reasons.add("OVER_ALLOCATION_RISK");
  }

  const activeSameGlobalCollateralScope = history.some(
    (row) =>
      current.globalCollateralLockScope !== undefined &&
      row.globalCollateralLockScope === current.globalCollateralLockScope &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status) &&
      isBlockingLock(row, policy) &&
      !canEmergencyPreempt(current, row, policy),
  );
  if (activeSameGlobalCollateralScope) {
    reasons.add("GLOBAL_COLLATERAL_LOCK_CONTENTION");
    reasons.add("GLOBAL_COLLATERAL_LOCK_REQUIRED");
    reasons.add("OVER_ALLOCATION_RISK");
  }

  if (hasNonceDomainCollision(current, history)) {
    reasons.add("NONCE_DOMAIN_COLLISION");
  }

  if (isEmergencyGasAction(current)) {
    if (requiresNonceDomainForEmergency(current, history)) {
      reasons.add("NONCE_DOMAIN_REQUIRED");
    }
    if (lowPriorityQueueDepth(current, history) > policy.maxLowPriorityQueueAheadOfEmergency) {
      reasons.add("EMERGENCY_CLOSE_STARVATION");
    }
  }

  for (const row of history) {
    if (
      current.globalCollateralLockScope !== undefined &&
      row.globalCollateralLockScope === current.globalCollateralLockScope &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status) &&
      isBlockingLock(row, policy)
    ) {
      for (const reason of preemptionBlockReasons(current, row, policy)) {
        reasons.add(reason);
      }
    }
  }

  const staleGlobalCollateralContention = history.some(
    (row) =>
      current.globalCollateralLockScope !== undefined &&
      row.globalCollateralLockScope === current.globalCollateralLockScope &&
      row.intentId !== current.intentId &&
      isHumanOrBroadcastWait(row.status) &&
      isStaleLedgerRow(row, policy.maxGlobalCollateralContentionMs),
  );
  if (staleGlobalCollateralContention) {
    reasons.add("CROSS_VENUE_RECONCILIATION_DEADLOCK");
  }

  const expiredHumanWaitLease = history.some(
    (row) =>
      sharesAnyLockScope(row, current) &&
      isHumanApprovalWait(row.status) &&
      row.lockedUntil !== undefined &&
      isExpired(row.lockedUntil),
  );
  if (expiredHumanWaitLease) {
    reasons.add("LOCK_LEASE_EXTENSION_REQUIRED");
    reasons.add("OVER_ALLOCATION_RISK");
  }

  const unresolvedSignatureTransition = history.some(
    (row) =>
      row.intentId !== current.intentId &&
      sameSigningBoundary(row, current) &&
      isUnresolvedSignatureTransition(row.status),
  );
  if (unresolvedSignatureTransition) {
    reasons.add("SIGNATURE_RECONCILIATION_REQUIRED");
  }

  const attemptsForGoal = history.filter(
    (row) =>
      row.userGoalId === current.userGoalId &&
      ["ABORTED", "REVERTED", "TIMED_OUT", "SIGN_FAILED"].includes(row.status),
  ).length;
  if (attemptsForGoal >= policy.maxAttemptsPerGoal) reasons.add("RETRY_STORM");

  if (requiresTokenContract(current, policy)) {
    reasons.add("TOKEN_CONTRACT_REQUIRED");
  }

  if (usesAmbiguousTokenSymbol(current, policy)) {
    reasons.add("TOKEN_SYMBOL_AMBIGUOUS");
  }

  if (requiresHip3Dex(current, policy)) {
    reasons.add("HIP3_SYMBOL_AMBIGUOUS");
  }

  if (current.network === "testnet" && current.isTestnetUsdc === false) {
    reasons.add("TESTNET_USDC_MISMATCH");
  }

  const navLossUsd =
    parseMoney(simulation.preNavUsd) -
    parseMoney(simulation.postNavUsd) +
    parseMoney(simulation.gasUsd) +
    parseMoney(simulation.slippageUsd);

  if (navLossUsd > parseMoney(policy.maxLossUsd)) {
    reasons.add("CUMULATIVE_LOSS_LIMIT");
  }

  const preNav = parseMoney(simulation.preNavUsd);
  if (preNav > 0) {
    const lossBps = (navLossUsd / preNav) * 10_000;
    if (lossBps > policy.maxLossBps) reasons.add("NAV_DELTA_LIMIT");
  }

  const tradeValue = parseMoney(
    simulation.tradeValueUsd ?? current.estimatedTradeValueUsd ?? "0",
  );
  if (tradeValue > 0) {
    const feeUsd = parseMoney(simulation.gasUsd) + parseMoney(simulation.slippageUsd);
    const feeBps = (feeUsd / tradeValue) * 10_000;
    if (feeBps > policy.maxFeeToTradeValueBps) {
      reasons.add("GAS_EXCEEDS_TRADE_VALUE");
    }
  }

  if (!isEmergencyGasAction(current)) {
    if (
      simulation.gasRunwayTransactions !== undefined &&
      simulation.gasRunwayTransactions < policy.minGasRunwayTransactions
    ) {
      reasons.add("GAS_RUNWAY_LOW");
    }

    const nativeBalanceUsd = parseMoney(simulation.nativeBalanceUsd ?? "0");
    const estimatedMaxGasUsd = parseMoney(simulation.estimatedMaxGasUsd ?? "0");
    const inFlightGasUsd = parseMoney(simulation.inFlightGasUsd ?? "0");
    const revertedGasUsd = parseMoney(simulation.revertedGasUsd ?? "0");
    const reservedGasUsd =
      estimatedMaxGasUsd * policy.minGasRunwayTransactions +
      inFlightGasUsd +
      revertedGasUsd;
    if (
      nativeBalanceUsd > 0 &&
      estimatedMaxGasUsd > 0 &&
      nativeBalanceUsd < reservedGasUsd
    ) {
      reasons.add("GAS_RUNWAY_LOW");
      if (inFlightGasUsd > 0) reasons.add("IN_FLIGHT_GAS_RESERVED");
    }

    if (
      parseMoney(simulation.gasSpentLookbackUsd ?? "0") >
      parseMoney(policy.maxGasSpendLookbackUsd)
    ) {
      reasons.add("GAS_BURN_RATE_LIMIT");
    }
  }

  if (hasGasReservationDrift(history, policy)) {
    reasons.add("GAS_RESERVATION_DRIFT");
  }

  if (hasGuardCompositionFailure(current, reasons)) {
    reasons.add("GUARD_COMPOSITION_FAILURE");
  }

  return [...reasons];
}

function requiresTokenContract(
  intent: CanonicalIntent,
  policy: SafeloopPolicy,
): boolean {
  if (intent.actionType !== "transfer") return false;
  const token = intent.assetOut ?? intent.tokenSymbol;
  if (!token) return false;
  if (isHexAddress(token)) return false;
  if (policy.nativeTokenSymbols.includes(token.toUpperCase())) return false;
  return !intent.tokenContract;
}

function isSupportedChain(chainId: number, policy: SafeloopPolicy): boolean {
  return policy.supportedChainIds.includes(chainId);
}

function usesAmbiguousTokenSymbol(
  intent: CanonicalIntent,
  policy: SafeloopPolicy,
): boolean {
  const token = intent.assetOut ?? intent.assetIn ?? intent.tokenSymbol;
  if (!token) return false;
  if (isHexAddress(token)) return false;
  if (policy.nativeTokenSymbols.includes(token.toUpperCase())) return false;
  return intent.actionType === "transfer" && !intent.tokenContract;
}

function usesSharedCollateral(intent: CanonicalIntent): boolean {
  return (
    intent.actionType.startsWith("perps_") ||
    intent.actionType === "bridge"
  );
}

function inferPriority(intent: AgentIntent): "emergency" | "normal" {
  return isEmergencyGasAction(intent) ? "emergency" : "normal";
}

function hasUnfilledExpectedSize(simulation: SimulationResult): boolean {
  if (
    simulation.expectedFillSize === undefined ||
    simulation.filledSize === undefined
  ) {
    return false;
  }

  return parseMoney(simulation.filledSize) < parseMoney(simulation.expectedFillSize);
}

function hasPartialReconciliationLoop(
  current: ActionLedgerRow,
  history: ActionLedgerRow[],
  policy: SafeloopPolicy,
): boolean {
  const priorPartialAttempts = history.filter(
    (row) =>
      sameSigningBoundary(row, current) &&
      row.reasonCodes.includes("PARTIAL_FILL_PENDING"),
  ).length;
  return (
    (current.partialFillCount ?? 0) >= policy.maxPartialReconciliationAttempts ||
    priorPartialAttempts >= policy.maxPartialReconciliationAttempts
  );
}

function isCalibrationOverfit(
  simulation: SimulationResult,
  policy: SafeloopPolicy,
): boolean {
  if (
    simulation.volatilityBps === undefined ||
    simulation.timeCalibrationMaxVolatilityBps === undefined
  ) {
    return false;
  }
  return (
    simulation.volatilityBps >
    simulation.timeCalibrationMaxVolatilityBps *
      policy.maxCalibrationVolatilityMultiplier
  );
}

function isEmergencyGasAction(intent: {
  actionType: ActionType;
  priority?: "emergency" | "high" | "normal" | "low";
}): boolean {
  return (
    intent.priority === "emergency" ||
    intent.actionType === "perps_close" ||
    intent.actionType === "perps_cancel" ||
    intent.actionType === "perps_withdraw"
  );
}

function canEmergencyPreempt(
  current: ActionLedgerRow,
  prior: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  return preemptionBlockReasons(current, prior, policy).length === 0;
}

function preemptionBlockReasons(
  current: ActionLedgerRow,
  prior: ActionLedgerRow,
  policy: SafeloopPolicy,
): AbortReason[] {
  if (!isEmergencyGasAction(current) || isEmergencyGasAction(prior)) {
    return ["GLOBAL_COLLATERAL_LOCK_CONTENTION"];
  }

  const reasons = new Set<AbortReason>();

  if (
    prior.status === "SIGNING" &&
    !isOlderThanMs(prior.updatedAt, policy.nonPreemptableSigningMs)
  ) {
    reasons.add("NON_PREEMPTABLE_SIGNING_LOCK");
    reasons.add("PREEMPTION_LIVELOCK_RISK");
  }

  const priorAgeAnchor = prior.createdAt ?? prior.updatedAt;
  if (
    priorAgeAnchor &&
    !isOlderThanMs(priorAgeAnchor, policy.minPreemptionAgeMs)
  ) {
    reasons.add("PREEMPTION_LIVELOCK_RISK");
  }

  if (
    (prior.preemptionCount ?? 0) >= policy.maxPreemptionsPerWindow &&
    prior.lastPreemptedAt !== undefined &&
    !isOlderThanMs(prior.lastPreemptedAt, policy.preemptionWindowMs)
  ) {
    reasons.add("PREEMPTION_LIVELOCK_RISK");
  }

  if (
    policy.requirePreemptionCancellation &&
    isLiveBroadcastRisk(prior.status) &&
    !hasUsablePreemptionCancel(prior, policy) &&
    !canUsePartitionEmergencyBypass(current, prior, policy)
  ) {
    reasons.add("PREEMPTION_CANCEL_REQUIRED");
    reasons.add("PREEMPTED_TX_STILL_LIVE");
    if (hasTimedOutCancelProofWait(prior, policy)) {
      reasons.add("CANCELLATION_PROOF_INDEXING_LAG");
    }
    if (isCancellationProofStale(prior, policy)) {
      reasons.add("CANCELLATION_PROOF_STALE");
    }
    if (hasFalsePositiveCancelRisk(prior, policy)) {
      reasons.add("CANCEL_PROOF_FALSE_POSITIVE_RISK");
    }
    if (hasMempoolQuorumIllusion(prior, policy)) {
      reasons.add("MEMPOOL_QUORUM_ILLUSION");
    }
    if (hasRpcQuorumPartition(prior)) {
      reasons.add("RPC_QUORUM_PARTITION");
    }
    if (
      prior.preemptionCancelStatus === "broadcast_accepted" &&
      (prior.preemptionCancelRpcQuorum ?? 0) <
        policy.minPreemptionCancelRpcQuorum
    ) {
      reasons.add("PREEMPTION_CANCEL_QUORUM_REQUIRED");
    }
  }

  return [...reasons];
}

function isLiveBroadcastRisk(status: LedgerStatus): boolean {
  return [
    "SIGNING",
    "SIGNED",
    "REQUEST_PENDING",
    "REQUEST_WATCH_REQUIRED",
    "AWAITING_HUMAN_APPROVAL",
    "SUBMITTED",
    "BROADCASTING",
    "LANDED",
  ].includes(status);
}

function hasUsablePreemptionCancel(
  row: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  if (row.preemptionCancelStatus === "confirmed") return true;
  if (row.preemptionCancelStatus === "ordered") {
    return !(
      policy.requireNonceBoundCancellation && !hasNonceBoundCancelProof(row)
    );
  }
  if (row.preemptionCancelStatus !== "broadcast_accepted") return false;
  if (policy.requireOrderedCancellationProof) return false;
  if ((row.preemptionCancelRpcQuorum ?? 0) < policy.minPreemptionCancelRpcQuorum) {
    return false;
  }
  if (!row.preemptionCancelObservedAt) return false;
  if (policy.requireNonceBoundCancellation && !hasNonceBoundCancelProof(row)) {
    return false;
  }
  return !isOlderThanMs(
    row.preemptionCancelObservedAt,
    policy.maxPreemptionCancelAcceptanceAgeMs,
  );
}

function canUsePartitionEmergencyBypass(
  current: ActionLedgerRow,
  prior: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  return (
    policy.allowReduceOnlyEmergencyDuringQuorumPartition &&
    hasRpcQuorumPartition(prior) &&
    isExposureReducingEmergency(current)
  );
}

function isExposureReducingEmergency(row: ActionLedgerRow): boolean {
  return (
    row.actionType === "perps_close" &&
    (row.reduceOnly === true || row.closeAll === true)
  );
}

function hasTimedOutCancelProofWait(
  row: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  if (
    row.preemptionCancelStatus !== "submitted" &&
    row.preemptionCancelStatus !== "broadcast_accepted"
  ) {
    return false;
  }
  if (!row.preemptionCancelSubmittedAt) return false;
  return isOlderThanMs(
    row.preemptionCancelSubmittedAt,
    policy.maxPreemptionCancelProofWaitMs,
  );
}

function hasNonceBoundCancelProof(row: ActionLedgerRow): boolean {
  return Boolean(
    row.nonceDomain &&
      row.preemptionCancelNonce !== undefined &&
      (row.preemptionCancelReplacesTxHash || row.txHash),
  );
}

function hasMempoolQuorumIllusion(
  row: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  return Boolean(
    policy.requireOrderedCancellationProof &&
      row.preemptionCancelStatus === "broadcast_accepted" &&
      (row.preemptionCancelRpcQuorum ?? 0) >=
        policy.minPreemptionCancelRpcQuorum &&
      !row.preemptionCancelOrderedAt,
  );
}

function hasRpcQuorumPartition(row: ActionLedgerRow): boolean {
  return Boolean(row.preemptionCancelQuorumFailure);
}

function isCancellationProofStale(
  row: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  return Boolean(
    row.preemptionCancelStatus === "broadcast_accepted" &&
      row.preemptionCancelObservedAt &&
      isOlderThanMs(
        row.preemptionCancelObservedAt,
        policy.maxPreemptionCancelAcceptanceAgeMs,
      ),
  );
}

function hasFalsePositiveCancelRisk(
  row: ActionLedgerRow,
  policy: SafeloopPolicy,
): boolean {
  return Boolean(
    row.preemptionCancelStatus === "broadcast_accepted" &&
      policy.requireNonceBoundCancellation &&
      !hasNonceBoundCancelProof(row),
  );
}

function hasNonceDomainCollision(
  current: ActionLedgerRow,
  history: ActionLedgerRow[],
): boolean {
  if (!current.nonceDomain) return false;
  return history.some(
    (row) =>
      row.intentId !== current.intentId &&
      row.nonceDomain === current.nonceDomain &&
      isLiveBroadcastRisk(row.status) &&
      (row.lockOwnerId === undefined ||
        current.lockOwnerId === undefined ||
        row.lockOwnerId !== current.lockOwnerId),
  );
}

function requiresNonceDomainForEmergency(
  current: ActionLedgerRow,
  history: ActionLedgerRow[],
): boolean {
  if (current.nonceDomain) return false;
  return history.some(
    (row) =>
      current.globalCollateralLockScope !== undefined &&
      row.globalCollateralLockScope === current.globalCollateralLockScope &&
      row.intentId !== current.intentId &&
      isLiveBroadcastRisk(row.status),
  );
}

function lowPriorityQueueDepth(
  current: ActionLedgerRow,
  history: ActionLedgerRow[],
): number {
  return history.filter(
    (row) =>
      row.wallet === current.wallet &&
      row.chainId === current.chainId &&
      row.intentId !== current.intentId &&
      row.priority === "low" &&
      isActiveOrFinalDuplicate(row.status),
  ).length;
}

function hasLockFencingGap(
  current: ActionLedgerRow,
  history: ActionLedgerRow[],
): boolean {
  return history.some((row) => {
    if (
      row.intentId === current.intentId ||
      !sharesAnyLockScope(row, current) ||
      !isActiveOrFinalDuplicate(row.status)
    ) {
      return false;
    }
    if (current.lockEpoch === undefined || row.lockEpoch === undefined) {
      return true;
    }
    return current.lockEpoch <= row.lockEpoch;
  });
}

function hasGasReservationDrift(
  history: ActionLedgerRow[],
  policy: SafeloopPolicy,
): boolean {
  const staleReservedGasUsd = history
    .filter(
      (row) =>
        ["ABORTED", "SIGN_FAILED", "TIMED_OUT"].includes(row.status) &&
        row.gasReservationStatus === "reserved",
    )
    .reduce((sum, row) => sum + parseMoney(row.gasReservedUsd ?? "0"), 0);
  return staleReservedGasUsd > parseMoney(policy.maxStaleGasReservationUsd);
}

function hasGuardCompositionFailure(
  current: ActionLedgerRow,
  reasons: Set<AbortReason>,
): boolean {
  if (!isEmergencyGasAction(current)) return false;
  const hasLivenessGuard =
    reasons.has("GLOBAL_COLLATERAL_LOCK_CONTENTION") ||
    reasons.has("PREEMPTION_LIVELOCK_RISK") ||
    reasons.has("CANCELLATION_PROOF_INDEXING_LAG") ||
    reasons.has("EMERGENCY_CLOSE_STARVATION");
  const hasSafetyGuard =
    reasons.has("TIME_CALIBRATION_REQUIRED") ||
    reasons.has("TIME_CALIBRATION_STALE") ||
    reasons.has("TIME_CALIBRATION_UNSAFE") ||
    reasons.has("TIME_CALIBRATION_OVERFIT") ||
    reasons.has("ORACLE_PRICE_STALE") ||
    reasons.has("LOCK_RELEASE_SPLIT_BRAIN");
  return hasLivenessGuard && hasSafetyGuard;
}

function requiresHip3Dex(
  intent: CanonicalIntent,
  policy: SafeloopPolicy,
): boolean {
  if (!intent.actionType.startsWith("perps_")) return false;
  if (intent.dex) return false;
  if (intent.requiresDex) return true;
  if (!intent.symbol) return false;
  const symbol = intent.symbol.includes(":")
    ? intent.symbol.split(":").at(-1) ?? intent.symbol
    : intent.symbol;
  return policy.hip3SymbolsRequireDex.includes(symbol.toUpperCase());
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isStaleObservation(observedAt: string, policy: SafeloopPolicy): boolean {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return Date.now() - observedMs > policy.maxReconciliationAgeMs;
}

function isOraclePriceStale(
  observedAt: string,
  simulation: SimulationResult,
  policy: SafeloopPolicy,
): boolean {
  const maxAgeMs =
    simulation.volatilityBps !== undefined &&
    simulation.volatilityBps >= policy.oracleVolatilityThresholdBps
      ? policy.highVolatilityOracleAgeMs
      : policy.maxOracleAgeMs;
  if (simulation.oracleMonotonicAgeMs !== undefined) {
    return simulation.oracleMonotonicAgeMs > maxAgeMs;
  }

  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return Date.now() - observedMs > maxAgeMs;
}

function isSignatureExpiryUnsafe(
  expiresAt: string,
  policy: SafeloopPolicy,
): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  const ttlMs = expiresMs - Date.now();
  return ttlMs > policy.maxSignatureTtlMs;
}

function isExpired(iso: string): boolean {
  const expiresMs = Date.parse(iso);
  if (!Number.isFinite(expiresMs)) return true;
  return Date.now() > expiresMs;
}

function isLockLeaseActive(row: ActionLedgerRow): boolean {
  if (!row.lockedUntil) return true;
  return !isExpired(row.lockedUntil);
}

function isBlockingLock(row: ActionLedgerRow, policy: SafeloopPolicy): boolean {
  if (isLockLeaseActive(row)) return true;
  return (
    isHumanOrBroadcastWait(row.status) &&
    !isStaleLedgerRow(row, policy.maxHumanApprovalMs)
  );
}

function isHumanOrBroadcastWait(status: LedgerStatus): boolean {
  return [
    "REQUEST_PENDING",
    "REQUEST_WATCH_REQUIRED",
    "AWAITING_HUMAN_APPROVAL",
    "BROADCASTING",
    "SUBMITTED",
  ].includes(status);
}

function isHumanApprovalWait(status: LedgerStatus): boolean {
  return ["REQUEST_PENDING", "AWAITING_HUMAN_APPROVAL"].includes(status);
}

function isStaleLedgerRow(row: ActionLedgerRow, maxAgeMs: number): boolean {
  const updatedMs = Date.parse(row.updatedAt);
  if (!Number.isFinite(updatedMs)) return true;
  return Date.now() - updatedMs > maxAgeMs;
}

function isOlderThanMs(iso: string, maxAgeMs: number): boolean {
  const observedMs = Date.parse(iso);
  if (!Number.isFinite(observedMs)) return true;
  return Date.now() - observedMs > maxAgeMs;
}

function sharesAnyLockScope(
  left: ActionLedgerRow,
  right: ActionLedgerRow,
): boolean {
  return Boolean(
    (left.lockScope && left.lockScope === right.lockScope) ||
      (left.accountLockScope &&
        left.accountLockScope === right.accountLockScope) ||
      (left.globalCollateralLockScope &&
        left.globalCollateralLockScope === right.globalCollateralLockScope),
  );
}

function isActiveOrFinalDuplicate(status: LedgerStatus): boolean {
  return [
    "LOCKED",
    "SIMULATED",
    "APPROVED_FOR_SIGNING",
    "SIGNING",
    "SIGNED",
    "REQUEST_PENDING",
    "REQUEST_WATCH_REQUIRED",
    "AWAITING_HUMAN_APPROVAL",
    "SUBMITTED",
    "BROADCASTING",
    "LANDED",
    "VENUE_RECONCILED",
    "CONFIRMED",
  ].includes(status);
}

function isUnresolvedSignatureTransition(status: LedgerStatus): boolean {
  return [
    "APPROVED_FOR_SIGNING",
    "SIGNING",
    "SIGNED",
    "REQUEST_PENDING",
    "REQUEST_WATCH_REQUIRED",
    "AWAITING_HUMAN_APPROVAL",
    "SUBMITTED",
    "BROADCASTING",
    "LANDED",
  ].includes(status);
}

function sameSigningBoundary(
  left: ActionLedgerRow,
  right: ActionLedgerRow,
): boolean {
  return Boolean(
    (left.lockScope && left.lockScope === right.lockScope) ||
      (left.accountLockScope &&
        left.accountLockScope === right.accountLockScope) ||
      (left.globalCollateralLockScope &&
        left.globalCollateralLockScope === right.globalCollateralLockScope) ||
      left.userGoalId === right.userGoalId,
  );
}

function isMeaningfulPriorAction(status: LedgerStatus): boolean {
  return [
    "SIGNING",
    "SIGNED",
    "REQUEST_PENDING",
    "SUBMITTED",
    "BROADCASTING",
    "LANDED",
    "VENUE_RECONCILED",
    "CONFIRMED",
  ].includes(status);
}

function bucketIso(date: Date, minutes: number): string {
  const bucketMs = minutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

function lowerAddress<T extends string>(address: T): Lowercase<T> {
  return address.toLowerCase() as Lowercase<T>;
}

function normalizeDecimal(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("INVALID_DECIMAL");
  return value.replace(/^0+(?=\d)/, "");
}

function roundAmountBucket(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed === 0) return "0";
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(parsed)));
  return String(Math.round(parsed / magnitude) * magnitude);
}

function parseMoney(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
