import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

import type {
  AbortReason,
  ActionLedgerRow,
  Ledger,
  LedgerStatus,
} from "./index.js";

const DEFAULT_LEASE_MS = 120_000;
const MAX_LEASE_MS = 15 * 60_000;
const MAX_ROW_BYTES = 256_000;
const MAX_SCOPE_LENGTH = 512;
const MAX_HISTORY_ROWS = 1_000;

export type SqliteLedgerOptions = {
  path: string;
  leaseMs?: number;
  now?: () => Date;
  /**
   * Deployment-owned verifier for emergency preemption. The callback must
   * validate durable cancellation, nonce-domain, quorum, freshness, rate
   * limits, and signing-window policy. Preemption is disabled without it.
   */
  authorizePreemption?: (params: {
    contender: Readonly<ActionLedgerRow>;
    prior: Readonly<ActionLedgerRow>;
    observedAt: string;
  }) => boolean;
};

export type SqliteLedger = Ledger & {
  close(): void;
  renewLock(row: ActionLedgerRow): Promise<boolean>;
};

type StoredAction = {
  row_json: string;
  status: string;
  reason_codes_json: string;
  updated_at: string;
};

type StoredLock = {
  owner_id: string;
  intent_id: string;
  fencing_epoch: number;
  locked_until: string;
};

/**
 * File-backed Action Ledger using Node's built-in SQLite binding.
 *
 * Every lock scope and the action row are written under one BEGIN IMMEDIATE
 * transaction. A monotonic database sequence is used as the fencing token.
 */
export function createSqliteLedger(
  options: SqliteLedgerOptions,
): SqliteLedger {
  if (!options.path || options.path === ":memory:") {
    throw new Error("SQLITE_LEDGER_DURABLE_PATH_REQUIRED");
  }
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    leaseMs > MAX_LEASE_MS
  ) {
    throw new Error("SQLITE_LEDGER_INVALID_LEASE");
  }

  const now = options.now ?? (() => new Date());
  const db = new DatabaseSync(options.path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  chmodSync(options.path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2500;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS safeloop_actions (
      intent_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      wallet TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      row_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS safeloop_actions_wallet_time
      ON safeloop_actions(wallet, chain_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS safeloop_fencing_epochs (
      epoch INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS safeloop_action_locks (
      lock_scope TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      fencing_epoch INTEGER NOT NULL,
      locked_until TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(intent_id) REFERENCES safeloop_actions(intent_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS safeloop_locks_intent
      ON safeloop_action_locks(intent_id);

    CREATE TABLE IF NOT EXISTS safeloop_status_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(intent_id) REFERENCES safeloop_actions(intent_id)
    ) STRICT;
  `);

  function begin(): void {
    db.exec("BEGIN IMMEDIATE");
  }

  function rollback(): void {
    if (db.isTransaction) db.exec("ROLLBACK");
  }

  function currentIso(): string {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("SQLITE_LEDGER_INVALID_CLOCK");
    }
    return value.toISOString();
  }

  function writeActionJson(row: ActionLedgerRow): string {
    const serialized = JSON.stringify(row);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ROW_BYTES) {
      throw new Error("SQLITE_LEDGER_ROW_TOO_LARGE");
    }
    return serialized;
  }

  function hydrateStored(stored: StoredAction): ActionLedgerRow {
    const row = JSON.parse(stored.row_json) as ActionLedgerRow;
    row.status = stored.status as LedgerStatus;
    row.reasonCodes = JSON.parse(stored.reason_codes_json) as AbortReason[];
    row.updatedAt = stored.updated_at;
    return row;
  }

  function loadAction(intentId: string): ActionLedgerRow | undefined {
    const stored = db
      .prepare(
        "SELECT row_json, status, reason_codes_json, updated_at FROM safeloop_actions WHERE intent_id = ?",
      )
      .get(intentId) as StoredAction | undefined;
    return stored ? hydrateStored(stored) : undefined;
  }

  function scopesFor(row: ActionLedgerRow): string[] {
    const scopes = [
      row.lockScope,
      row.accountLockScope,
      row.globalCollateralLockScope,
    ].filter((scope): scope is string => typeof scope === "string");
    const unique = [...new Set(scopes)];
    if (
      unique.length === 0 ||
      unique.some(
        (scope) => scope.length === 0 || scope.length > MAX_SCOPE_LENGTH,
      )
    ) {
      throw new Error("SQLITE_LEDGER_INVALID_LOCK_SCOPE");
    }
    return unique.sort();
  }

  function isBusy(error: unknown): boolean {
    return (
      error instanceof Error &&
      /SQLITE_BUSY|database is locked/i.test(error.message)
    );
  }

  async function tryLock(row: ActionLedgerRow): Promise<boolean> {
    const scopes = scopesFor(row);
    if (!row.lockOwnerId || row.lockOwnerId.length > 256) {
      throw new Error("SQLITE_LEDGER_LOCK_OWNER_REQUIRED");
    }
    if (!row.intentId || !row.idempotencyKey) {
      throw new Error("SQLITE_LEDGER_ACTION_ID_REQUIRED");
    }

    const observedAt = currentIso();
    const lockedUntil = new Date(
      new Date(observedAt).getTime() + leaseMs,
    ).toISOString();
    try {
      begin();
      const duplicate = db
        .prepare(
          "SELECT 1 AS present FROM safeloop_actions WHERE intent_id = ? OR idempotency_key = ? LIMIT 1",
        )
        .get(row.intentId, row.idempotencyKey);
      if (duplicate) {
        rollback();
        return false;
      }

      const readLock = db.prepare(
        "SELECT owner_id, intent_id, fencing_epoch, locked_until FROM safeloop_action_locks WHERE lock_scope = ?",
      );
      const preemptedIntentIds = new Set<string>();
      for (const scope of scopes) {
        const existing = readLock.get(scope) as StoredLock | undefined;
        if (existing) {
          const priorStored = db
            .prepare(
              "SELECT row_json, status, reason_codes_json, updated_at FROM safeloop_actions WHERE intent_id = ?",
            )
            .get(existing.intent_id) as StoredAction | undefined;
          const prior = priorStored ? hydrateStored(priorStored) : undefined;
          const leaseActive = existing.locked_until > observedAt;
          const shadowedLiveState =
            prior !== undefined && isLiveSigningState(prior.status);
          if (
            (leaseActive || shadowedLiveState) &&
            (!prior ||
              !canPriorityPreempt(row, prior) ||
              options.authorizePreemption?.({
                contender: row,
                prior,
                observedAt,
              }) !== true)
          ) {
            rollback();
            return false;
          }
          if (leaseActive || shadowedLiveState) {
            preemptedIntentIds.add(existing.intent_id);
          }
        }
      }

      for (const preemptedIntentId of preemptedIntentIds) {
        const priorStored = db
          .prepare(
            "SELECT row_json, status, reason_codes_json, updated_at FROM safeloop_actions WHERE intent_id = ?",
          )
          .get(preemptedIntentId) as StoredAction;
        const prior = hydrateStored(priorStored);
        prior.status = "ABORTED";
        prior.reasonCodes = ["LOCK_OWNERSHIP_LOST"];
        prior.gasReservationStatus =
          prior.gasReservationStatus === "reserved"
            ? "released"
            : prior.gasReservationStatus;
        prior.gasReservationUpdatedAt = observedAt;
        prior.updatedAt = observedAt;
        db.prepare(
          `UPDATE safeloop_actions
           SET status = ?, reason_codes_json = ?, row_json = ?, updated_at = ?
           WHERE intent_id = ?`,
        ).run(
          prior.status,
          JSON.stringify(prior.reasonCodes),
          writeActionJson(prior),
          observedAt,
          preemptedIntentId,
        );
        db.prepare(
          "INSERT INTO safeloop_status_history(intent_id, status, reason_codes_json, recorded_at) VALUES (?, ?, ?, ?)",
        ).run(
          preemptedIntentId,
          prior.status,
          JSON.stringify(prior.reasonCodes),
          observedAt,
        );
        db.prepare(
          "DELETE FROM safeloop_action_locks WHERE intent_id = ?",
        ).run(preemptedIntentId);
      }

      const epochResult = db
        .prepare("INSERT INTO safeloop_fencing_epochs(created_at) VALUES (?)")
        .run(observedAt);
      const fencingEpoch = Number(epochResult.lastInsertRowid);
      if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch <= 0) {
        throw new Error("SQLITE_LEDGER_INVALID_FENCING_EPOCH");
      }
      row.lockEpoch = fencingEpoch;
      row.lockedUntil = lockedUntil;
      row.status = "LOCKED";
      row.updatedAt = observedAt;
      const rowJson = writeActionJson(row);

      db.prepare(
        `INSERT INTO safeloop_actions(
          intent_id, idempotency_key, wallet, chain_id, status,
          reason_codes_json, row_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.intentId,
        row.idempotencyKey,
        row.wallet.toLowerCase(),
        row.chainId,
        row.status,
        JSON.stringify(row.reasonCodes),
        rowJson,
        row.createdAt,
        observedAt,
      );

      const upsertLock = db.prepare(`
        INSERT INTO safeloop_action_locks(
          lock_scope, intent_id, owner_id, fencing_epoch,
          locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lock_scope) DO UPDATE SET
          intent_id = excluded.intent_id,
          owner_id = excluded.owner_id,
          fencing_epoch = excluded.fencing_epoch,
          locked_until = excluded.locked_until,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
      for (const scope of scopes) {
        upsertLock.run(
          scope,
          row.intentId,
          row.lockOwnerId,
          fencingEpoch,
          lockedUntil,
          observedAt,
          observedAt,
        );
      }
      db.prepare(
        "INSERT INTO safeloop_status_history(intent_id, status, reason_codes_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(row.intentId, row.status, "[]", observedAt);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      rollback();
      if (isBusy(error)) return false;
      if (
        error instanceof Error &&
        /UNIQUE constraint failed/i.test(error.message)
      ) {
        return false;
      }
      if (
        error instanceof Error &&
        error.message.startsWith("SQLITE_LEDGER_")
      ) {
        throw error;
      }
      throw new Error("SQLITE_LEDGER_WRITE_FAILED");
    }
  }

  async function renewLock(row: ActionLedgerRow): Promise<boolean> {
    if (!row.lockOwnerId || !row.lockEpoch) return false;
    const observedAt = currentIso();
    const lockedUntil = new Date(
      new Date(observedAt).getTime() + leaseMs,
    ).toISOString();
    try {
      begin();
      const storedRow = loadAction(row.intentId);
      if (
        !storedRow ||
        storedRow.lockOwnerId !== row.lockOwnerId ||
        storedRow.lockEpoch !== row.lockEpoch
      ) {
        rollback();
        return false;
      }
      const scopes = scopesFor(storedRow);
      const readLock = db.prepare(
        "SELECT owner_id, intent_id, fencing_epoch, locked_until FROM safeloop_action_locks WHERE lock_scope = ?",
      );
      for (const scope of scopes) {
        const existing = readLock.get(scope) as StoredLock | undefined;
        if (
          !existing ||
          existing.intent_id !== row.intentId ||
          existing.owner_id !== row.lockOwnerId ||
          existing.fencing_epoch !== row.lockEpoch ||
          existing.locked_until <= observedAt
        ) {
          rollback();
          return false;
        }
      }
      const update = db.prepare(
        `UPDATE safeloop_action_locks
         SET locked_until = ?, updated_at = ?
         WHERE lock_scope = ? AND intent_id = ? AND owner_id = ?
           AND fencing_epoch = ? AND locked_until > ?`,
      );
      for (const scope of scopes) {
        const result = update.run(
          lockedUntil,
          observedAt,
          scope,
          row.intentId,
          row.lockOwnerId,
          row.lockEpoch,
          observedAt,
        );
        if (result.changes !== 1) {
          throw new Error("SQLITE_LEDGER_LOCK_RENEWAL_RACE");
        }
      }
      storedRow.lockedUntil = lockedUntil;
      storedRow.updatedAt = observedAt;
      db.prepare(
        "UPDATE safeloop_actions SET row_json = ?, updated_at = ? WHERE intent_id = ?",
      ).run(writeActionJson(storedRow), observedAt, row.intentId);
      db.exec("COMMIT");
      row.lockedUntil = lockedUntil;
      row.updatedAt = observedAt;
      return true;
    } catch (error) {
      rollback();
      if (isBusy(error)) return false;
      if (
        error instanceof Error &&
        error.message.startsWith("SQLITE_LEDGER_")
      ) {
        throw error;
      }
      throw new Error("SQLITE_LEDGER_RENEW_FAILED");
    }
  }

  async function verifyLock(row: ActionLedgerRow): Promise<boolean> {
    if (!row.lockOwnerId || !row.lockEpoch) return false;
    const observedAt = currentIso();
    const storedRow = loadAction(row.intentId);
    if (
      !storedRow ||
      storedRow.lockOwnerId !== row.lockOwnerId ||
      storedRow.lockEpoch !== row.lockEpoch
    ) return false;
    const scopes = scopesFor(storedRow);
    const readLock = db.prepare(
      "SELECT owner_id, intent_id, fencing_epoch, locked_until FROM safeloop_action_locks WHERE lock_scope = ?",
    );
    return scopes.every((scope) => {
      const existing = readLock.get(scope) as StoredLock | undefined;
      return (
        existing?.intent_id === row.intentId &&
        existing.owner_id === row.lockOwnerId &&
        existing.fencing_epoch === row.lockEpoch &&
        existing.locked_until > observedAt
      );
    });
  }

  async function syncAction(row: ActionLedgerRow): Promise<boolean> {
    if (!row.lockOwnerId || !row.lockEpoch) return false;
    const observedAt = currentIso();
    try {
      begin();
      const storedRow = loadAction(row.intentId);
      if (
        !storedRow ||
        storedRow.lockOwnerId !== row.lockOwnerId ||
        storedRow.lockEpoch !== row.lockEpoch
      ) {
        rollback();
        return false;
      }
      const scopes = scopesFor(storedRow);
      const readLock = db.prepare(
        "SELECT owner_id, intent_id, fencing_epoch, locked_until FROM safeloop_action_locks WHERE lock_scope = ?",
      );
      for (const scope of scopes) {
        const existing = readLock.get(scope) as StoredLock | undefined;
        if (
          existing?.intent_id !== row.intentId ||
          existing.owner_id !== row.lockOwnerId ||
          existing.fencing_epoch !== row.lockEpoch ||
          existing.locked_until <= observedAt
        ) {
          rollback();
          return false;
        }
      }
      storedRow.signatureExpiresAt = row.signatureExpiresAt;
      storedRow.updatedAt = observedAt;
      const result = db.prepare(
        `UPDATE safeloop_actions
         SET row_json = ?, updated_at = ?
         WHERE intent_id = ? AND (
           SELECT COUNT(*) FROM safeloop_action_locks
           WHERE intent_id = ? AND owner_id = ? AND fencing_epoch = ?
             AND locked_until > ?
         ) = ?`,
      ).run(
        writeActionJson(storedRow),
        observedAt,
        row.intentId,
        row.intentId,
        row.lockOwnerId,
        row.lockEpoch,
        observedAt,
        scopes.length,
      );
      if (result.changes !== 1) {
        rollback();
        return false;
      }
      db.exec("COMMIT");
      row.updatedAt = observedAt;
      return true;
    } catch (error) {
      rollback();
      if (isBusy(error)) return false;
      if (
        error instanceof Error &&
        error.message.startsWith("SQLITE_LEDGER_")
      ) {
        throw error;
      }
      throw new Error("SQLITE_LEDGER_SYNC_FAILED");
    }
  }

  async function markStatus(
    intentId: string,
    status: LedgerStatus,
    reasonCodes: AbortReason[] = [],
  ): Promise<void> {
    const observedAt = currentIso();
    try {
      begin();
      const stored = db
        .prepare(
          "SELECT row_json, status, reason_codes_json, updated_at FROM safeloop_actions WHERE intent_id = ?",
        )
        .get(intentId) as StoredAction | undefined;
      if (!stored) {
        rollback();
        return;
      }
      const row = JSON.parse(stored.row_json) as ActionLedgerRow;
      if (
        row.status === "ABORTED" &&
        row.reasonCodes.includes("LOCK_OWNERSHIP_LOST") &&
        status !== "ABORTED"
      ) {
        throw new Error("SQLITE_LEDGER_PREEMPTED_ACTION_IMMUTABLE");
      }
      if (row.lockOwnerId && row.lockEpoch) {
        throw new Error("SQLITE_LEDGER_OWNER_REQUIRED");
      }
      row.status = status;
      row.reasonCodes = [...new Set(reasonCodes)];
      row.updatedAt = observedAt;
      const reasonsJson = JSON.stringify(row.reasonCodes);
      db.prepare(
        `UPDATE safeloop_actions
         SET status = ?, reason_codes_json = ?, row_json = ?, updated_at = ?
         WHERE intent_id = ?`,
      ).run(status, reasonsJson, writeActionJson(row), observedAt, intentId);
      db.prepare(
        "INSERT INTO safeloop_status_history(intent_id, status, reason_codes_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(intentId, status, reasonsJson, observedAt);
      db.exec("COMMIT");
    } catch (error) {
      rollback();
      if (
        error instanceof Error &&
        error.message.startsWith("SQLITE_LEDGER_")
      ) {
        throw error;
      }
      throw new Error("SQLITE_LEDGER_STATUS_WRITE_FAILED");
    }
  }

  async function markStatusOwned(
    owner: ActionLedgerRow,
    status: LedgerStatus,
    reasonCodes: AbortReason[] = [],
  ): Promise<boolean> {
    if (!owner.lockOwnerId || !owner.lockEpoch) return false;
    const observedAt = currentIso();
    try {
      begin();
      const storedRow = loadAction(owner.intentId);
      if (
        !storedRow ||
        storedRow.lockOwnerId !== owner.lockOwnerId ||
        storedRow.lockEpoch !== owner.lockEpoch
      ) {
        rollback();
        return false;
      }
      const scopes = scopesFor(storedRow);
      const owned = db.prepare(
        `SELECT COUNT(*) AS count
         FROM safeloop_action_locks
         WHERE intent_id = ? AND owner_id = ? AND fencing_epoch = ?
           AND locked_until > ?`,
      ).get(
        owner.intentId,
        owner.lockOwnerId,
        owner.lockEpoch,
        observedAt,
      ) as { count: number };
      if (owned.count !== scopes.length) {
        rollback();
        return false;
      }
      storedRow.status = status;
      storedRow.reasonCodes = [...new Set(reasonCodes)];
      storedRow.updatedAt = observedAt;
      const reasonsJson = JSON.stringify(storedRow.reasonCodes);
      const result = db.prepare(
        `UPDATE safeloop_actions
         SET status = ?, reason_codes_json = ?, row_json = ?, updated_at = ?
         WHERE intent_id = ? AND status != 'ABORTED'`,
      ).run(
        status,
        reasonsJson,
        writeActionJson(storedRow),
        observedAt,
        owner.intentId,
      );
      if (result.changes !== 1) {
        rollback();
        return false;
      }
      db.prepare(
        "INSERT INTO safeloop_status_history(intent_id, status, reason_codes_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(owner.intentId, status, reasonsJson, observedAt);
      db.exec("COMMIT");
      owner.status = status;
      owner.reasonCodes = [...storedRow.reasonCodes];
      owner.updatedAt = observedAt;
      return true;
    } catch (error) {
      rollback();
      if (isBusy(error)) return false;
      if (
        error instanceof Error &&
        error.message.startsWith("SQLITE_LEDGER_")
      ) {
        throw error;
      }
      throw new Error("SQLITE_LEDGER_STATUS_WRITE_FAILED");
    }
  }

  async function recentForWallet(params: {
    wallet: string;
    chainId?: number;
    lookbackMinutes: number;
  }): Promise<ActionLedgerRow[]> {
    if (
      !Number.isFinite(params.lookbackMinutes) ||
      params.lookbackMinutes <= 0 ||
      params.lookbackMinutes > 525_600
    ) {
      throw new Error("SQLITE_LEDGER_INVALID_LOOKBACK");
    }
    const since = new Date(
      now().getTime() - params.lookbackMinutes * 60_000,
    ).toISOString();
    const rows = params.chainId === undefined
      ? db
          .prepare(
            `SELECT row_json, status, reason_codes_json, updated_at
             FROM safeloop_actions
             WHERE wallet = ? AND created_at >= ?
             ORDER BY created_at DESC
             LIMIT ${MAX_HISTORY_ROWS + 1}`,
          )
          .all(params.wallet.toLowerCase(), since)
      : db
          .prepare(
            `SELECT row_json, status, reason_codes_json, updated_at
             FROM safeloop_actions
             WHERE wallet = ? AND chain_id = ? AND created_at >= ?
             ORDER BY created_at DESC
             LIMIT ${MAX_HISTORY_ROWS + 1}`,
          )
          .all(params.wallet.toLowerCase(), params.chainId, since);
    if (rows.length > MAX_HISTORY_ROWS) {
      throw new Error("SQLITE_LEDGER_HISTORY_LIMIT_EXCEEDED");
    }
    return (rows as StoredAction[]).map((stored) => {
      const row = JSON.parse(stored.row_json) as ActionLedgerRow;
      row.status = stored.status as LedgerStatus;
      row.reasonCodes = JSON.parse(stored.reason_codes_json) as AbortReason[];
      row.updatedAt = stored.updated_at;
      return row;
    });
  }

  async function cleanupPostSignFailure(params: {
    row: ActionLedgerRow;
    reasonCodes: AbortReason[];
    signedOperation: unknown;
  }): Promise<{
    ok: boolean;
    statusPersisted?: boolean;
    reasonCodes?: AbortReason[];
  }> {
    void params.signedOperation;
    const row = params.row;
    if (!row.lockOwnerId || !row.lockEpoch) {
      return { ok: false, reasonCodes: ["LOCK_OWNERSHIP_LOST"] };
    }
    try {
      begin();
      const storedRow = loadAction(row.intentId);
      if (
        !storedRow ||
        storedRow.lockOwnerId !== row.lockOwnerId ||
        storedRow.lockEpoch !== row.lockEpoch
      ) {
        rollback();
        return { ok: false, reasonCodes: ["LOCK_OWNERSHIP_LOST"] };
      }
      const scopes = scopesFor(storedRow);
      const observedAt = currentIso();
      const owned = db.prepare(
        `SELECT COUNT(*) AS count
         FROM safeloop_action_locks
         WHERE intent_id = ? AND owner_id = ? AND fencing_epoch = ?
           AND locked_until > ?`,
      ).get(row.intentId, row.lockOwnerId, row.lockEpoch, observedAt) as {
        count: number;
      };
      if (owned.count !== scopes.length) {
        rollback();
        return { ok: false, reasonCodes: ["LOCK_OWNERSHIP_LOST"] };
      }
      db.prepare(
        `DELETE FROM safeloop_action_locks
         WHERE intent_id = ? AND owner_id = ? AND fencing_epoch = ?`,
      ).run(row.intentId, row.lockOwnerId, row.lockEpoch);
      const reasonCodes = [...new Set(params.reasonCodes)];
      storedRow.status = "SIGN_FAILED";
      storedRow.reasonCodes = reasonCodes;
      storedRow.gasReservationStatus = "released";
      storedRow.gasReservationUpdatedAt = observedAt;
      storedRow.updatedAt = observedAt;
      db.prepare(
        `UPDATE safeloop_actions
         SET status = ?, reason_codes_json = ?, row_json = ?, updated_at = ?
         WHERE intent_id = ?`,
      ).run(
        "SIGN_FAILED",
        JSON.stringify(reasonCodes),
        writeActionJson(storedRow),
        observedAt,
        row.intentId,
      );
      db.prepare(
        "INSERT INTO safeloop_status_history(intent_id, status, reason_codes_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(row.intentId, "SIGN_FAILED", JSON.stringify(reasonCodes), observedAt);
      db.exec("COMMIT");
      row.status = "SIGN_FAILED";
      row.reasonCodes = reasonCodes;
      row.gasReservationStatus = "released";
      row.gasReservationUpdatedAt = observedAt;
      row.updatedAt = observedAt;
      return { ok: true, statusPersisted: true };
    } catch {
      rollback();
      return { ok: false, reasonCodes: ["POST_SIGN_CLEANUP_REQUIRED"] };
    }
  }

  async function releaseOwnedLocks(row: ActionLedgerRow): Promise<boolean> {
    if (!row.lockOwnerId || !row.lockEpoch) return false;
    try {
      begin();
      const storedRow = loadAction(row.intentId);
      if (
        !storedRow ||
        storedRow.lockOwnerId !== row.lockOwnerId ||
        storedRow.lockEpoch !== row.lockEpoch
      ) {
        rollback();
        return false;
      }
      const result = db.prepare(
        `DELETE FROM safeloop_action_locks
         WHERE intent_id = ? AND owner_id = ? AND fencing_epoch = ?`,
      ).run(row.intentId, row.lockOwnerId, row.lockEpoch);
      if (result.changes !== scopesFor(storedRow).length) {
        rollback();
        return false;
      }
      db.exec("COMMIT");
      return true;
    } catch {
      rollback();
      return false;
    }
  }

  return {
    capabilities: {
      durable: true,
      atomicLocks: true,
      lockLeases: true,
      ownedLocks: true,
      accountScopedLocks: true,
      globalCollateralLocks: true,
      lockLeaseRenewal: true,
      lockFencing: true,
      ownerBoundStatusWrites: true,
      inFlightGasAccounting: false,
      // The optional callback can authorize a local lock transition, but this
      // adapter cannot prove the deployment-level liveness/rate-limit policy
      // required to advertise production preemption guarantees.
      priorityLocks: false,
      preemptionCancellation: false,
    },
    tryLock,
    verifyLock,
    syncAction,
    renewLock,
    markStatus,
    markStatusOwned,
    releaseOwnedLocks,
    recentForWallet,
    cleanupPostSignFailure,
    close: () => db.close(),
  };
}

function canPriorityPreempt(
  contender: ActionLedgerRow,
  prior: ActionLedgerRow,
): boolean {
  if (priorityRank(contender.priority) <= priorityRank(prior.priority)) {
    return false;
  }
  if (contender.priority !== "emergency") return false;
  if (["LOCKED", "SIMULATED", "APPROVED_FOR_SIGNING"].includes(prior.status)) {
    return true;
  }
  // A signer may already hold or have produced an externally usable payload.
  // A boolean callback cannot atomically revoke that payload, so these states
  // remain non-preemptable even when deployment authorization is configured.
  if (prior.status === "SIGNING" || prior.status === "SIGNED") return false;
  if (
    [
      "REQUEST_PENDING",
      "REQUEST_WATCH_REQUIRED",
      "AWAITING_HUMAN_APPROVAL",
      "SUBMITTED",
      "BROADCASTING",
    ].includes(prior.status)
  ) {
    return hasDurableCancellationProof(prior);
  }
  return false;
}

function isLiveSigningState(status: LedgerStatus): boolean {
  return [
    "SIGNING",
    "SIGNED",
    "REQUEST_PENDING",
    "REQUEST_WATCH_REQUIRED",
    "AWAITING_HUMAN_APPROVAL",
    "SUBMITTED",
    "BROADCASTING",
  ].includes(status);
}

function hasDurableCancellationProof(row: ActionLedgerRow): boolean {
  if (row.preemptionCancelStatus === "confirmed") return true;
  return (
    row.preemptionCancelStatus === "ordered" &&
    row.preemptionCancelOrderSource !== undefined &&
    Number.isSafeInteger(row.preemptionCancelNonce) &&
    row.preemptionCancelReplacesTxHash !== undefined &&
    row.preemptionCancelReplacesTxHash === row.txHash
  );
}

function priorityRank(
  priority: ActionLedgerRow["priority"],
): number {
  switch (priority) {
    case "emergency":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
    default:
      return 2;
  }
}
