import type { AbortReason, LedgerStatus } from "./index.js";

const MFA_TIMEOUT_MS = 90000;

export type WalletRequestState =
  | "PENDING"
  | "AWAITING_MFA"
  | "BROADCASTING"
  | "BROADCAST_TRACKING_EXPIRED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "REVERTED"
  | "FAILED"
  | "TIMED_OUT"
  | "UNKNOWN";

export type WalletRequestObservation = {
  pollingId?: string;
  state: WalletRequestState;
  txHash?: \`0x\${string}\`;
  intent?: string;
  gasBurnedUsd?: string;
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
  console.log(\`EXTENDING_LOCK_LEASE:\${requestId}:\${ms}\`);
}

export function reconcileWalletRequest(
  observation: WalletRequestObservation,
  context?: { requestId: string; updatedAt?: string },
): ReconciliationDecision {
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
    case "CONFIRMED":
      return terminal("LANDED");
    case "REVERTED":
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
          // Map to BALANCE_NOT_CONFIRMED (using closest existing AbortReason)
          return terminal("ABORTED", ["PARTIAL_FILL_PENDING"]);
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
          // Map to SLIPPAGE_EXCEEDED (using closest existing AbortReason)
          return terminal("ABORTED", ["NAV_DELTA_LIMIT"]);
        }
      }
      return terminal("CONFIRMED");
    }

    console.warn(\`UNGUARDED_NON_PERP_ACTION:\${actionType}\`);
    return terminal("CONFIRMED");
  }

  if (observation.fillStatus === "partial") {
    return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING"]);
  }

  if (hasUnfilledExpectedSize(observation)) {
    return pending("REQUEST_WATCH_REQUIRED", ["PARTIAL_FILL_PENDING"]);
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
