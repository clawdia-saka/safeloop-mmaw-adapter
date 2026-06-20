import type { AbortReason, LedgerStatus } from "./index.js";

const MFA_TIMEOUT_MS = 90000;
const SETTLEMENT_WATCHER_HEARTBEAT_MS = 30000;
const MIN_CONFIRMATION_DEPTH = 3;
const MAX_LOCK_EXTENSIONS = 5;

export type WalletRequestState =
  | "PENDING"
  | "AWAITING_MFA"
  | "BROADCASTING"
  | "BROADCAST_TRACKING_EXPIRED"
  | "SUBMITTED"
  | "LANDED"
  | "CONFIRMED"
  | "REVERTED"
  | "FAILED"
  | "TIMED_OUT"
  | "UNKNOWN";

export type WalletRequestObservation = {
  pollingId?: string;
  state: WalletRequestState;
  txHash?: `0x${string}`;
  intent?: string;
  gasBurnedUsd?: string;
  confirmationDepth?: number;
  watcherHeartbeatAt?: string;
  lockExtensionCount?: number;
  rpcQuorumTrusted?: boolean;
};

export type VenueObservation = {
  positionFound?: boolean;
  fillStatus?: "none" | "partial" | "filled";
  expectedFillSize?: string;
  filledSize?: string;
  expectedPositionSize?: string;
  observedPositionSize?: string;
  positionSizeTolerance?: string;
  orderFound?: boolean;
  balanceUpdated?: boolean;
};

export type ReconciliationDecision = {
  status: LedgerStatus;
  reasonCodes: AbortReason[];
  terminal: boolean;
};

/**
 * DM-F2: MFA Lease Extension
 */
function extendLockLease(requestId: string, ms: number) {
  // Emit signal to lock manager (simulated via log)
  console.log(`EXTENDING_LOCK_LEASE:${requestId}:${ms}`);
}

/**
 * DM-S4: Silent Watcher Crash - Heartbeat verification
 */
function isWatcherStale(heartbeatAt?: string): boolean {
  if (!heartbeatAt) return false;
  const elapsed = Date.now() - Date.parse(heartbeatAt);
  return elapsed > SETTLEMENT_WATCHER_HEARTBEAT_MS;
}

export function reconcileWalletRequest(
  observation: WalletRequestObservation,
  context?: { requestId: string; updatedAt?: string },
): ReconciliationDecision {
  // DM-S4: Silent Watcher Crash
  if (isWatcherStale(observation.watcherHeartbeatAt)) {
    return pending("REQUEST_WATCH_REQUIRED", ["STALE_RECONCILIATION", "LOCK_FENCING_REQUIRED", "STALE_WATCHER_DETECTED"]);
  }

  // Max extension cap
  if ((observation.lockExtensionCount ?? 0) >= MAX_LOCK_EXTENSIONS) {
    return terminal("ABORTED", ["EXPLICIT_STUCK_ALARM"]);
  }

  switch (observation.state) {
    case "PENDING":
      return pending("REQUEST_PENDING");
    case "AWAITING_MFA":
      // DM-F2: MFA Lease Extension
      if (context?.requestId) {
        extendLockLease(context.requestId, 90_000);
      }
      // DM-F2: Timeout Cancellation
      if (context?.updatedAt) {
        const elapsed = Date.now() - Date.parse(context.updatedAt);
        if (elapsed > MFA_TIMEOUT_MS) {
          console.error("CANCELLATION_PROOF_EMITTED", context.requestId);
          return terminal("TIMED_OUT", ["LOCK_LEASE_EXPIRED"]);
        }
      }
      return pending("AWAITING_HUMAN_APPROVAL", ["HUMAN_APPROVAL_REQUIRED"]);
    case "BROADCASTING":
      return pending("BROADCASTING", ["BROADCASTING_TIMEOUT"]);
    case "BROADCAST_TRACKING_EXPIRED":
      return terminal("TIMED_OUT", ["BROADCAST_TRACKING_EXPIRED"]);
    case "SUBMITTED":
      return pending("SUBMITTED");
    case "LANDED":
      // DM-S1: Re-org Ghost State
      const depth = observation.confirmationDepth ?? 0;
      if (depth >= MIN_CONFIRMATION_DEPTH || (depth > 0 && observation.rpcQuorumTrusted)) {
        return terminal("CONFIRMED");
      }
      if (depth === 0 && !observation.rpcQuorumTrusted) {
        return pending("LANDED", ["REORG_GHOST_STATE"]);
      }
      return pending("LANDED", ["SETTLEMENT_CONFIRMATION_DEPTH_REQUIRED"]);
    case "CONFIRMED":
      return terminal("CONFIRMED");
    case "REVERTED":
      // DM-S3: Gas Drain Blind Spot
      return terminal(
        "REVERTED",
        observation.gasBurnedUsd === undefined
          ? ["REVERT_GAS_BURN_UNACCOUNTED"]
          : [],
      );
    case "FAILED":
      return terminal("ABORTED", ["UNKNOWN_STATE"]);
    case "TIMED_OUT":
      return terminal("TIMED_OUT");
    case "UNKNOWN":
      return pending("REQUEST_WATCH_REQUIRED", ["UNKNOWN_STATE"]);
  }
}

export function reconcileVenueState(
  actionType: string,
  observation: VenueObservation,
  context?: { expectedAmount?: string; minOutputAmount?: string },
): ReconciliationDecision {
  if (!actionType.startsWith("perps_")) {
    // DM-F4: Non-Perp Balance / Slippage Guard
    if (actionType === "transfer") {
      if (observation.balanceUpdated === false) {
        return pending("REQUEST_WATCH_REQUIRED", ["UNKNOWN_STATE"]);
      }
      if (observation.observedPositionSize && context?.expectedAmount) {
        if (parseDecimal(observation.observedPositionSize)! < parseDecimal(context.expectedAmount)!) {
          // DM-S2: Partial Fill Lock Leak
          return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING", "PARTIAL_LOCK_RELEASE_REQUIRED"]);
        }
      }
      return terminal("CONFIRMED");
    }

    if (actionType === "swap") {
      if (observation.balanceUpdated === false) {
        return pending("REQUEST_WATCH_REQUIRED", ["UNKNOWN_STATE"]);
      }
      if (observation.observedPositionSize && context?.minOutputAmount) {
        if (parseDecimal(observation.observedPositionSize)! < parseDecimal(context.minOutputAmount)!) {
          // DM-S2: Partial Fill Lock Leak
          return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING", "PARTIAL_LOCK_RELEASE_REQUIRED"]);
        }
      }
      return terminal("CONFIRMED");
    }

    console.warn(`UNGUARDED_NON_PERP_ACTION:${actionType}`);
    return terminal("CONFIRMED");
  }

  // DM-S2: Partial Fill Lock Leak
  if (observation.fillStatus === "partial") {
    return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING", "PARTIAL_LOCK_RELEASE_REQUIRED"]);
  }

  if (hasUnfilledExpectedSize(observation)) {
    return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING", "PARTIAL_LOCK_RELEASE_REQUIRED"]);
  }

  if (requiresPositionDelta(actionType, observation)) {
    if (matchesExpectedPositionSize(observation)) {
      return terminal("VENUE_RECONCILED");
    }
    return pending("REQUEST_WATCH_REQUIRED", ["POSITION_DELTA_MISMATCH"]);
  }

  if (actionType === "perps_open" && observation.positionFound) {
    return terminal("VENUE_RECONCILED");
  }

  if (actionType === "perps_close" && observation.positionFound === false) {
    return terminal("VENUE_RECONCILED");
  }

  if (actionType === "perps_cancel" && observation.orderFound === false) {
    return terminal("VENUE_RECONCILED");
  }

  if (actionType === "perps_deposit" && observation.balanceUpdated) {
    return terminal("VENUE_RECONCILED");
  }

  return pending("REQUEST_WATCH_REQUIRED", ["POSITION_NOT_RECONCILED"]);
}

/**
 * Pure helper for settlement receipt reconciliation
 */
export function reconcileSettlementReceipt(
  observation: WalletRequestObservation
): ReconciliationDecision {
  return reconcileWalletRequest(observation);
}

/**
 * Pure helper for partial fill release reconciliation
 */
export function reconcilePartialFillRelease(
  actionType: string,
  observation: VenueObservation,
  context?: { expectedAmount?: string; minOutputAmount?: string }
): ReconciliationDecision {
  return reconcileVenueState(actionType, observation, context);
}

/**
 * Pure helper for watcher heartbeat reconciliation
 */
export function reconcileWatcherHeartbeat(
  observation: WalletRequestObservation
): ReconciliationDecision {
  if (isWatcherStale(observation.watcherHeartbeatAt)) {
    return pending("REQUEST_WATCH_REQUIRED", ["STALE_WATCHER_DETECTED"]);
  }
  return pending("REQUEST_PENDING");
}

function hasUnfilledExpectedSize(observation: VenueObservation): boolean {
  if (
    observation.expectedFillSize === undefined ||
    observation.filledSize === undefined
  ) {
    return false;
  }

  const expected = parseDecimal(observation.expectedFillSize);
  const filled = parseDecimal(observation.filledSize);
  if (expected === undefined || filled === undefined) return true;
  return filled < expected;
}

function requiresPositionDelta(
  actionType: string,
  observation: VenueObservation,
): boolean {
  return (
    ["perps_open", "perps_close", "perps_modify"].includes(actionType) &&
    observation.expectedPositionSize !== undefined
  );
}

function matchesExpectedPositionSize(observation: VenueObservation): boolean {
  if (observation.observedPositionSize === undefined) return false;

  const expected = parseDecimal(observation.expectedPositionSize);
  const observed = parseDecimal(observation.observedPositionSize);
  const tolerance = parseDecimal(observation.positionSizeTolerance ?? "0");
  if (expected === undefined || observed === undefined || tolerance === undefined) {
    return false;
  }

  return Math.abs(expected - observed) <= tolerance;
}

function parseDecimal(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pending(
  status: LedgerStatus,
  reasonCodes: AbortReason[] = [],
): ReconciliationDecision {
  return { status, reasonCodes, terminal: false };
}

function terminal(
  status: LedgerStatus,
  reasonCodes: AbortReason[] = [],
): ReconciliationDecision {
  return { status, reasonCodes, terminal: true };
}
