import { createHash } from "node:crypto";

import { canonicalizePerpsFields } from "./hip3.js";

export * from "./metamask.js";
export * from "./hip3.js";
export * from "./reconciliation.js";
export * from "./hyperliquid.js";

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
  | "QUOTE_ONLY_NOT_EXECUTED"
  | "POSITION_NOT_RECONCILED"
  | "GAS_EXCEEDS_TRADE_VALUE"
  | "BROADCASTING_TIMEOUT"
  | "BROADCAST_TRACKING_EXPIRED"
  | "HUMAN_APPROVAL_REQUIRED"
  | "DURABLE_LEDGER_REQUIRED"
  | "INTENT_LOCK_REQUIRED"
  | "STALE_RECONCILIATION"
  | "NON_EVM_SIMULATION_REQUIRED"
  | "MARGIN_RATIO_LIMIT"
  | "LIQUIDATION_PRICE_TOO_CLOSE"
  | "OVER_ALLOCATION_RISK"
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
  tokenContract?: `0x${string}`;
  tokenSymbol?: string;
  isTestnetUsdc?: boolean;
  requiresDex?: boolean;
  venue?: "hyperliquid";
  network?: "mainnet" | "testnet";
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
  venueSimulation?: "evm" | "hyperliquid-margin-model" | "hyperliquid-api" | "unknown";
  marginRatioBps?: number;
  liquidationBufferBps?: number;
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
  };
  tryLock(row: ActionLedgerRow): Promise<boolean>;
  markStatus(
    intentId: string,
    status: LedgerStatus,
    reasonCodes?: AbortReason[],
  ): Promise<void>;
  recentForWallet(params: {
    wallet: string;
    chainId?: number;
    lookbackMinutes: number;
  }): Promise<ActionLedgerRow[]>;
};

export type MmawSigner<TUnsignedOperation, TSignedOperation> = {
  buildUnsignedOperation(intent: CanonicalIntent): Promise<TUnsignedOperation>;
  sign(operation: TUnsignedOperation): Promise<TSignedOperation>;
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
  hip3SymbolsRequireDex: string[];
  requireDurableLedger: boolean;
  maxReconciliationAgeMs: number;
  minMarginRatioBps: number;
  minLiquidationBufferBps: number;
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
  hip3SymbolsRequireDex: ["SPCX"],
  requireDurableLedger: true,
  maxReconciliationAgeMs: 30_000,
  minMarginRatioBps: 12_500,
  minLiquidationBufferBps: 500,
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
    tokenContract: intent.tokenContract ? lowerAddress(intent.tokenContract) : undefined,
    tokenSymbol: intent.tokenSymbol?.toUpperCase(),
    isTestnetUsdc: intent.isTestnetUsdc,
    requiresDex: intent.requiresDex,
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
  const now = new Date().toISOString();

  if (
    policy.requireDurableLedger &&
    (!params.ledger.capabilities?.durable ||
      !params.ledger.capabilities?.atomicLocks)
  ) {
    throw new SafeloopAbort(["DURABLE_LEDGER_REQUIRED"]);
  }

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

  const unsignedOperation =
    await params.mmaw.buildUnsignedOperation(canonicalIntent);

  const simulation = await params.simulator.simulate(
    unsignedOperation,
    canonicalIntent,
  );

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

  try {
    const signed = await params.mmaw.sign(unsignedOperation);
    await params.ledger.markStatus(intentId, "SIGNED");
    return signed;
  } catch (error) {
    await params.ledger.markStatus(intentId, "SIGN_FAILED", ["UNKNOWN_STATE"]);
    throw error;
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
  if (simulation.quoteExecuted === false) reasons.add("QUOTE_ONLY_NOT_EXECUTED");
  if (simulation.positionReconciled === false) {
    reasons.add("POSITION_NOT_RECONCILED");
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
      row.lockScope === current.lockScope &&
      row.intentId !== current.intentId &&
      isActiveOrFinalDuplicate(row.status),
  );
  if (activeSameScope) reasons.add("OVER_ALLOCATION_RISK");

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

function isActiveOrFinalDuplicate(status: LedgerStatus): boolean {
  return [
    "LOCKED",
    "SIMULATED",
    "APPROVED_FOR_SIGNING",
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

function isMeaningfulPriorAction(status: LedgerStatus): boolean {
  return [
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
