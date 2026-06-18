import { createHash } from "node:crypto";

export * from "./metamask.js";

export type ActionType =
  | "swap"
  | "transfer"
  | "approve"
  | "lend"
  | "borrow"
  | "bridge";

export type LedgerStatus =
  | "PLANNED"
  | "LOCKED"
  | "SIMULATED"
  | "APPROVED_FOR_SIGNING"
  | "SIGNED"
  | "SUBMITTED"
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
  targetContract?: `0x${string}`;
  calldata?: `0x${string}`;
  route?: string[];
  expectedUtility?: string;
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
};

export const defaultPolicy: SafeloopPolicy = {
  idempotencyWindowMinutes: 15,
  trajectoryLookbackMinutes: 30,
  retryLookbackMinutes: 15,
  maxAttemptsPerGoal: 3,
  maxLossUsd: "25",
  maxLossBps: 50,
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
    roundedAmountBucket: roundAmountBucket(intent.amountIn),
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
      targetContract: intent.targetContract,
      timeBucket: intent.timeBucket,
      userGoalId: intent.userGoalId,
      wallet: intent.wallet,
    }),
  );
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
  const now = new Date().toISOString();

  const row: ActionLedgerRow = {
    ...canonicalIntent,
    intentId,
    idempotencyKey,
    status: "LOCKED",
    reasonCodes: [],
    createdAt: now,
    updatedAt: now,
  };

  const locked = await params.ledger.tryLock(row);
  if (!locked) {
    await params.ledger.markStatus(intentId, "ABORTED", [
      "LEDGER_LOCK_CONFLICT",
    ]);
    throw new SafeloopAbort(["LEDGER_LOCK_CONFLICT"]);
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

  const attemptsForGoal = history.filter(
    (row) =>
      row.userGoalId === current.userGoalId &&
      ["ABORTED", "REVERTED", "TIMED_OUT", "SIGN_FAILED"].includes(row.status),
  ).length;
  if (attemptsForGoal >= policy.maxAttemptsPerGoal) reasons.add("RETRY_STORM");

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

  return [...reasons];
}

function isActiveOrFinalDuplicate(status: LedgerStatus): boolean {
  return [
    "LOCKED",
    "SIMULATED",
    "APPROVED_FOR_SIGNING",
    "SIGNED",
    "SUBMITTED",
    "CONFIRMED",
  ].includes(status);
}

function isMeaningfulPriorAction(status: LedgerStatus): boolean {
  return ["SIGNED", "SUBMITTED", "CONFIRMED"].includes(status);
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
