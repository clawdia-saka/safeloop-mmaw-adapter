import type {
  Ledger,
  MmawSigner,
  SafeloopPolicy,
  Simulator,
} from "./index.js";

export type LiveStateCReadinessReason =
  | "INVALID_INPUT"
  | "LEDGER_REQUIRED"
  | "LEDGER_CAPABILITIES_INCOMPLETE"
  | "SIGNER_REQUIRED"
  | "SIGNER_INTENT_BINDING_REQUIRED"
  | "NON_BROADCASTING_SIGNER_REQUIRED"
  | "EXPIRING_SIGNATURES_REQUIRED"
  | "ABORTABLE_SIGNER_REQUIRED"
  | "POST_SIGN_ASSERTION_REQUIRED"
  | "SIMULATOR_REQUIRED"
  | "SIMULATOR_CAPABILITIES_INCOMPLETE"
  | "SUPPORTED_CHAIN_POLICY_REQUIRED"
  | "RPC_PROBE_REQUIRED"
  | "RPC_PROBE_STALE"
  | "RPC_CHAIN_MISMATCH"
  | "DURABLE_TIME_CALIBRATION_REQUIRED"
  | "TIME_CALIBRATION_STALE"
  | "TIME_CALIBRATION_UNSAFE"
  | "INVALID_CLOCK"
  | "STATE_C_POLICY_INCOMPLETE"
  | "MULTI_CHAIN_PROBES_REQUIRED";

export type LiveStateCRpcProbe = {
  ok: boolean;
  chainId: number;
  checkedAt: string;
};

export type DurableTimeCalibration = {
  source: "durable" | "local" | "unknown";
  syncedAt: string;
  roundTripMs: number;
  clockSkewMs: number;
};

type ReadinessSimulator = Simulator<unknown> & {
  capabilities?: {
    nonBroadcasting?: boolean;
    chainIdentityEnforced?: boolean;
    boundedRpc?: boolean;
    durableRiskEvidenceRequired?: boolean;
    supportedChainIds?: number[];
  };
};

export type LiveStateCReadinessInput = {
  ledger?: Ledger;
  signer?: MmawSigner<unknown, unknown>;
  simulator?: ReadinessSimulator;
  policy?: Partial<SafeloopPolicy>;
  rpcProbe?: LiveStateCRpcProbe;
  timeCalibration?: DurableTimeCalibration;
  maxRpcProbeAgeMs?: number;
  now?: Date;
};

export type LiveStateCReadiness = {
  ready: boolean;
  state: "STATE_C_READY" | "STATE_C_BLOCKED";
  checkedAt: string;
  reasonCodes: LiveStateCReadinessReason[];
};

/**
 * Pure, non-mutating readiness assessment. It never probes an RPC, signs, or
 * broadcasts; callers must supply the latest independently collected evidence.
 */
export function assessLiveStateCReadiness(
  input: LiveStateCReadinessInput,
): LiveStateCReadiness {
  try {
    return assessTrustedRuntimeInput(input);
  } catch {
    return {
      ready: false,
      state: "STATE_C_BLOCKED",
      checkedAt: new Date(0).toISOString(),
      reasonCodes: ["INVALID_INPUT"],
    };
  }
}

function assessTrustedRuntimeInput(
  input: LiveStateCReadinessInput,
): LiveStateCReadiness {
  const reasons = new Set<LiveStateCReadinessReason>();
  const runtimeInput = isRecord(input)
    ? (input as LiveStateCReadinessInput)
    : {};
  if (!isRecord(input)) reasons.add("INVALID_INPUT");
  const requestedNow = runtimeInput.now ?? new Date();
  const requestedNowMs = safeDateMs(requestedNow);
  const now = Number.isFinite(requestedNowMs)
    ? new Date(requestedNowMs)
    : new Date(0);
  if (!Number.isFinite(requestedNowMs)) reasons.add("INVALID_CLOCK");
  const policy = isRecord(runtimeInput.policy)
    ? runtimeInput.policy
    : undefined;
  if (runtimeInput.policy !== undefined && !policy) reasons.add("INVALID_INPUT");

  if (!runtimeInput.ledger) {
    reasons.add("LEDGER_REQUIRED");
  } else {
    const capability = runtimeInput.ledger.capabilities;
    if (
      capability?.durable !== true ||
      capability.atomicLocks !== true ||
      capability.lockLeases !== true ||
      capability.ownedLocks !== true ||
      capability.lockLeaseRenewal !== true ||
      capability.lockFencing !== true ||
      capability.ownerBoundStatusWrites !== true ||
      capability.inFlightGasAccounting !== true ||
      capability.priorityLocks !== true ||
      capability.preemptionCancellation !== true ||
      (policy?.requireAccountWideLock !== false &&
        capability.accountScopedLocks !== true) ||
      (policy?.requireGlobalCollateralLock !== false &&
        capability.globalCollateralLocks !== true) ||
      typeof runtimeInput.ledger.verifyLock !== "function" ||
      typeof runtimeInput.ledger.syncAction !== "function" ||
      typeof runtimeInput.ledger.renewLock !== "function" ||
      typeof runtimeInput.ledger.markStatusOwned !== "function" ||
      typeof runtimeInput.ledger.releaseOwnedLocks !== "function" ||
      typeof runtimeInput.ledger.cleanupPostSignFailure !== "function"
    ) {
      reasons.add("LEDGER_CAPABILITIES_INCOMPLETE");
    }
  }

  if (!runtimeInput.signer) {
    reasons.add("SIGNER_REQUIRED");
  } else {
    if (runtimeInput.signer.capabilities?.intentBoundSignatures !== true) {
      reasons.add("SIGNER_INTENT_BINDING_REQUIRED");
    }
    if (runtimeInput.signer.capabilities?.nonBroadcastingSignatures !== true) {
      reasons.add("NON_BROADCASTING_SIGNER_REQUIRED");
    }
    if (runtimeInput.signer.capabilities?.expiringSignatures !== true) {
      reasons.add("EXPIRING_SIGNATURES_REQUIRED");
    }
    if (runtimeInput.signer.capabilities?.abortableSignatures !== true) {
      reasons.add("ABORTABLE_SIGNER_REQUIRED");
    }
    if (
      typeof runtimeInput.signer.assertSignedOperationMatchesIntent !==
      "function"
    ) {
      reasons.add("POST_SIGN_ASSERTION_REQUIRED");
    }
  }

  if (!runtimeInput.simulator) {
    reasons.add("SIMULATOR_REQUIRED");
  } else if (
    runtimeInput.simulator.capabilities?.nonBroadcasting !== true ||
    runtimeInput.simulator.capabilities.chainIdentityEnforced !== true ||
    runtimeInput.simulator.capabilities.boundedRpc !== true ||
    runtimeInput.simulator.capabilities.durableRiskEvidenceRequired !== true ||
    !isPositiveSafeIntegerArray(
      runtimeInput.simulator.capabilities.supportedChainIds,
    )
  ) {
    reasons.add("SIMULATOR_CAPABILITIES_INCOMPLETE");
  }

  const supportedChainIds = policy?.supportedChainIds;
  if (
    !Array.isArray(supportedChainIds) ||
    supportedChainIds.length === 0 ||
    supportedChainIds.some(
      (chainId) => !Number.isSafeInteger(chainId) || chainId <= 0,
    ) ||
    policy?.requireDurableLedger !== true ||
    policy.requireDurableTimeCalibration !== true ||
    policy.requireExpiringSignatures !== true ||
    policy.requireSignerIntentBinding !== true ||
    policy.requirePostSignIntentAssertion !== true
  ) {
    reasons.add("SUPPORTED_CHAIN_POLICY_REQUIRED");
  }
  if (Array.isArray(supportedChainIds) && supportedChainIds.length !== 1) {
    reasons.add("MULTI_CHAIN_PROBES_REQUIRED");
  }
  if (!hasFullStateCPolicy(policy)) {
    reasons.add("STATE_C_POLICY_INCOMPLETE");
  }

  const maxRpcProbeAgeMs = runtimeInput.maxRpcProbeAgeMs ?? 30_000;
  const validProbeWindow =
    Number.isSafeInteger(maxRpcProbeAgeMs) &&
    maxRpcProbeAgeMs > 0 &&
    maxRpcProbeAgeMs <= 300_000;
  const rpcProbe = runtimeInput.rpcProbe;
  if (rpcProbe?.ok !== true) {
    reasons.add("RPC_PROBE_REQUIRED");
  } else {
    const checkedAt = parseIsoTimestamp(rpcProbe.checkedAt);
    if (
      !validProbeWindow ||
      !Number.isFinite(checkedAt) ||
      checkedAt > now.getTime() ||
      now.getTime() - checkedAt > maxRpcProbeAgeMs
    ) {
      reasons.add("RPC_PROBE_STALE");
    }
    if (
      !Number.isSafeInteger(rpcProbe.chainId) ||
      rpcProbe.chainId <= 0 ||
      !supportedChainIds?.includes(rpcProbe.chainId) ||
      !runtimeInput.simulator?.capabilities?.supportedChainIds?.includes(
        rpcProbe.chainId,
      )
    ) {
      reasons.add("RPC_CHAIN_MISMATCH");
    }
  }

  const calibration = runtimeInput.timeCalibration;
  if (!calibration || calibration.source !== "durable") {
    reasons.add("DURABLE_TIME_CALIBRATION_REQUIRED");
  } else {
    const syncedAt = parseIsoTimestamp(calibration.syncedAt);
    const maxAge = policy?.maxTimeCalibrationAgeMs;
    if (
      !Number.isFinite(syncedAt) ||
      syncedAt > now.getTime() ||
      !Number.isFinite(maxAge) ||
      (maxAge ?? -1) <= 0 ||
      now.getTime() - syncedAt > (maxAge ?? -1)
    ) {
      reasons.add("TIME_CALIBRATION_STALE");
    }
    if (
      !Number.isFinite(calibration.clockSkewMs) ||
      !Number.isFinite(calibration.roundTripMs) ||
      calibration.roundTripMs < 0 ||
      !Number.isFinite(policy?.maxClockSkewMs) ||
      !Number.isFinite(policy?.maxTimeCalibrationRoundTripMs) ||
      Math.abs(calibration.clockSkewMs) > (policy?.maxClockSkewMs ?? -1) ||
      calibration.roundTripMs >
        (policy?.maxTimeCalibrationRoundTripMs ?? -1)
    ) {
      reasons.add("TIME_CALIBRATION_UNSAFE");
    }
  }

  const reasonCodes = [...reasons];
  return {
    ready: reasonCodes.length === 0,
    state: reasonCodes.length === 0 ? "STATE_C_READY" : "STATE_C_BLOCKED",
    checkedAt: now.toISOString(),
    reasonCodes,
  };
}

function hasFullStateCPolicy(
  policy: Partial<SafeloopPolicy> | undefined,
): boolean {
  if (!isRecord(policy)) return false;
  const requiredTrue: Array<keyof SafeloopPolicy> = [
    "requireDurableLedger",
    "requireDurableTimeCalibration",
    "requireExpiringSignatures",
    "requireSignerIntentBinding",
    "requirePostSignIntentAssertion",
    "requirePreemptionCancellation",
    "requireNonceBoundCancellation",
    "requireOrderedCancellationProof",
    "requireLockFencing",
    "requireAccountWideLock",
    "requireGlobalCollateralLock",
    "requireExplicitCollateralPool",
  ];
  if (requiredTrue.some((key) => policy[key] !== true)) return false;

  const boundedIntegers: Partial<Record<keyof SafeloopPolicy, number>> = {
    lockLeaseMs: 900_000,
    minPreemptionAgeMs: 900_000,
    nonPreemptableSigningMs: 900_000,
    preemptionWindowMs: 3_600_000,
    maxPreemptionsPerWindow: 1_000,
    maxPreemptionCancelProofWaitMs: 30_000,
    maxPreemptionCancelAcceptanceAgeMs: 300_000,
    minPreemptionCancelRpcQuorum: 100,
    maxSignatureTtlMs: 300_000,
    maxClockSkewMs: 5_000,
    maxTimeCalibrationAgeMs: 600_000,
    maxTimeCalibrationRoundTripMs: 30_000,
  };
  const bounded = Object.entries(boundedIntegers).every(([key, maximum]) => {
    const value = policy[key as keyof SafeloopPolicy];
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= maximum
    );
  });
  if (!bounded) return false;
  const boundedPolicy = policy as SafeloopPolicy;

  return (
    boundedPolicy.minPreemptionAgeMs <= boundedPolicy.lockLeaseMs &&
    boundedPolicy.nonPreemptableSigningMs <= boundedPolicy.lockLeaseMs &&
    boundedPolicy.maxSignatureTtlMs <= boundedPolicy.lockLeaseMs &&
    boundedPolicy.maxClockSkewMs < boundedPolicy.maxSignatureTtlMs &&
    boundedPolicy.maxPreemptionCancelProofWaitMs <=
      boundedPolicy.maxPreemptionCancelAcceptanceAgeMs &&
    boundedPolicy.maxTimeCalibrationRoundTripMs <=
      boundedPolicy.maxTimeCalibrationAgeMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeIntegerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => Number.isSafeInteger(entry) && entry > 0)
  );
}

function parseIsoTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function safeDateMs(value: unknown): number {
  if (!(value instanceof Date)) return Number.NaN;
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return Number.NaN;
  }
}
