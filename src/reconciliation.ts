import type { AbortReason, LedgerStatus } from "./index.js";

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
  txHash?: `0x${string}`;
  intent?: string;
};

export type VenueObservation = {
  positionFound?: boolean;
  orderFound?: boolean;
  balanceUpdated?: boolean;
};

export type ReconciliationDecision = {
  status: LedgerStatus;
  reasonCodes: AbortReason[];
  terminal: boolean;
};

export function reconcileWalletRequest(
  observation: WalletRequestObservation,
): ReconciliationDecision {
  switch (observation.state) {
    case "PENDING":
      return pending("REQUEST_PENDING");
    case "AWAITING_MFA":
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
      return terminal("REVERTED");
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
): ReconciliationDecision {
  if (!actionType.startsWith("perps_")) return terminal("CONFIRMED");

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

