import type { AbortReason } from "./index.js";
import { sanitizeEvidencePacket } from "./evidence.js";

const REASON_DESCRIPTIONS: Record<string, string> = {
  "DUPLICATE_INTENT": "DM-F1 (Duplicate Intent) detected. Identical intent already in flight or recently finalized.",
  "LEDGER_LOCK_CONFLICT": "DM-F2 (Ledger Lock Conflict) detected. Concurrent operation on the same lock scope.",
  "REVERSE_SWAP_LOOP": "DM-F3 (Reverse Swap Loop) detected. Potential circular trading detected for this wallet.",
  "CUMULATIVE_LOSS_LIMIT": "DM-F4 (Cumulative Loss Limit) exceeded. Post-simulation NAV loss exceeds absolute USD threshold.",
  "NAV_DELTA_LIMIT": "DM-F5 (NAV Delta Limit) exceeded. Post-simulation NAV loss exceeds percentage threshold.",
  "SIGNED_OPERATION_ASSERTION_REQUIRED": "DM-F6 (PII Security Breach) risk. Post-sign assertion must be enabled to prevent PII leaks.",
  "SIGNED_OPERATION_INTENT_MISMATCH": "DM-F7 (Post-Sign Intent Mismatch) detected. Signed transaction payload does not match canonical intent.",
  "BROADCASTING_TIMEOUT": "DM-S1 (Broadcasting Timeout). Transaction submitted but not landed within expected window.",
  "BROADCAST_TRACKING_EXPIRED": "DM-S2 (Broadcast Tracking Expired). Unable to verify finality of submitted transaction.",
  "STALE_RECONCILIATION": "DM-S3 (Stale Reconciliation). On-chain state observation is older than max age policy.",
  "ORACLE_PRICE_STALE": "DM-S4 (Oracle Price Stale). Venue price feed age exceeds safety threshold.",
  "SIMULATION_FAILED": "Simulation failed on-chain. Transaction would revert.",
  "LOCK_LEASE_EXPIRED": "Atomic lock lease expired before signing completion.",
  "ACCOUNT_HEALTH_LIMIT": "Account margin ratio or exposure limits reached.",
  "SETTLEMENT_CONFIRMATION_DEPTH_REQUIRED": "Insufficient block confirmations for settlement receipt finality.",
  "REORG_GHOST_STATE": "Landed transaction not found in current chain tip (potential orphan or re-org).",
  "PARTIAL_LOCK_RELEASE_REQUIRED": "Incomplete fill detected; partial lock release and continued monitoring required.",
  "STALE_WATCHER_DETECTED": "Settlement watcher heartbeat is overdue; process may be stale or crashed.",
  "EXPLICIT_STUCK_ALARM": "Maximum lock extension cap reached; manual intervention or escalation required.",
};

export interface TraceContext {
  evidence?: unknown;
  expected?: unknown;
  actual?: unknown;
}

/**
 * DM-F10: Hot Path Trace Overhead
 * This function should ONLY be called in catch blocks or abort pathways.
 */
export function formatDebugTrace(
  reasonCode: AbortReason | string,
  context?: TraceContext
): string {
  const description = REASON_DESCRIPTIONS[reasonCode] || `Unknown Reason: ${reasonCode}`;
  let trace = `FIREWALL_BLOCKED: ${description}`;

  if (context) {
    const details: string[] = [];
    
    if (context.expected !== undefined || context.actual !== undefined) {
      details.push(`Expected: ${JSON.stringify(sanitizeEvidencePacket(context.expected))}`);
      details.push(`Actual: ${JSON.stringify(sanitizeEvidencePacket(context.actual))}`);
    }

    if (context.evidence) {
      details.push(`Evidence: ${JSON.stringify(sanitizeEvidencePacket(context.evidence))}`);
    }

    if (details.length > 0) {
      trace += ` ${details.join(". ")}.`;
    }
  }

  if (reasonCode === "SIGNED_OPERATION_INTENT_MISMATCH") {
    trace += " Triggering post-sign cleanup.";
  }

  return trace;
}

export function logOperatorTrace(
  reasonCode: AbortReason | string,
  context?: TraceContext
): void {
  console.log(formatDebugTrace(reasonCode, context));
}
