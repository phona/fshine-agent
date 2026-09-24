import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/** Structural copy of the agent contract keeps the core package independent of agent runtime code. */
export interface StoredPendingPlanConfirmation {
  planId: string;
  version: number;
  taskId: string;
  principalId: string;
  sessionId: string;
  decision: 'confirm';
  userText: string;
  expiresAt: string;
  evaluation: unknown;
  requestId?: string;
}

export interface StoredPlanConfirmationEvidence {
  messageId: string;
  principalId: string;
  sessionId: string;
  text: string;
  receivedAt: string;
}

export interface PlanConfirmationResolution extends StoredPlanConfirmationEvidence {
  planId: string;
  version: number;
  resolution: 'confirmed' | 'cancelled';
  resolvedAt: string;
}

export interface SqlitePendingPlanConfirmationRepo {
  savePending(record: StoredPendingPlanConfirmation): Promise<void>;
  listPending(principalId: string, sessionId: string): Promise<StoredPendingPlanConfirmation[]>;
  resolvePending(
    pending: StoredPendingPlanConfirmation,
    evidence: StoredPlanConfirmationEvidence,
    resolution: 'confirmed' | 'cancelled',
    action: () => Promise<void>,
  ): Promise<boolean>;
  /** Explicit claim primitive supports crash/lease diagnostics and deterministic recovery tests. */
  claimPending(pending: StoredPendingPlanConfirmation, evidence: StoredPlanConfirmationEvidence): Promise<boolean>;
  getResolution(messageId: string): Promise<PlanConfirmationResolution | null>;
  close(): void;
}

export interface SqlitePendingPlanConfirmationOptions {
  now?: () => Date;
  leaseMs?: number;
  /** Fault-injection seam for testing a failed local commit after platform activation. */
  beforeFinalize?: () => void;
}

interface PendingRow { plan_id: string; version: number; payload: string; status: string; lease_until: number | null; }
interface ResolutionRow {
  plan_id: string; version: number; message_id: string; principal_id: string; session_id: string;
  text: string; received_at: string; resolution: string; resolved_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_plan_confirmations (
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'confirmed', 'cancelled', 'superseded')),
  lease_token TEXT,
  lease_until INTEGER,
  lease_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, version)
);
CREATE INDEX IF NOT EXISTS idx_pending_plan_confirmations_scope_status
  ON pending_plan_confirmations (principal_id, session_id, status, expires_at);
CREATE TABLE IF NOT EXISTS plan_confirmation_resolutions (
  message_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('confirmed', 'cancelled')),
  resolved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_confirmation_resolutions_plan
  ON plan_confirmation_resolutions (plan_id, version);
`;

export function createSqlitePendingPlanConfirmationRepo(
  dbPath: string,
  options: SqlitePendingPlanConfirmationOptions = {},
): SqlitePendingPlanConfirmationRepo {
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const now = options.now ?? (() => new Date());
  const leaseMs = Math.max(100, options.leaseMs ?? 30_000);

  const savePending = db.transaction((record: StoredPendingPlanConfirmation) => {
    validatePending(record);
    const existing = db.prepare('SELECT payload, status FROM pending_plan_confirmations WHERE plan_id = ? AND version = ?')
      .get(record.planId, record.version) as { payload: string; status: string } | undefined;
    const payload = JSON.stringify(record);
    if (existing) {
      if (existing.payload !== payload) throw new Error('pending plan id/version already exists with different content');
      return;
    }
    const latest = db.prepare('SELECT MAX(version) AS version FROM pending_plan_confirmations WHERE plan_id = ?')
      .get(record.planId) as { version: number | null };
    if (latest.version !== null && record.version <= latest.version) throw new Error('pending plan version must increase monotonically');
    const busy = db.prepare('SELECT 1 AS found FROM pending_plan_confirmations WHERE plan_id = ? AND status = ? AND lease_until > ? LIMIT 1')
      .get(record.planId, 'processing', now().getTime());
    if (busy) throw new Error('cannot replace a pending plan while confirmation activation is in progress');
    db.prepare("UPDATE pending_plan_confirmations SET status = 'superseded', lease_token = NULL, lease_until = NULL, lease_message_id = NULL, updated_at = ? WHERE plan_id = ? AND status IN ('pending', 'processing')")
      .run(now().toISOString(), record.planId);
    db.prepare(`INSERT INTO pending_plan_confirmations
      (plan_id, version, task_id, principal_id, session_id, payload, expires_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(record.planId, record.version, record.taskId, record.principalId, record.sessionId, payload, record.expiresAt, now().toISOString());
  });

  const claim = db.transaction((pending: StoredPendingPlanConfirmation, evidence: StoredPlanConfirmationEvidence, token: string) => {
    validateEvidence(pending, evidence);
    const currentTime = now().getTime();
    const resolved = db.prepare('SELECT 1 AS found FROM plan_confirmation_resolutions WHERE message_id = ?').get(evidence.messageId);
    if (resolved) return false;
    const row = db.prepare('SELECT status, lease_until, expires_at, principal_id, session_id FROM pending_plan_confirmations WHERE plan_id = ? AND version = ?')
      .get(pending.planId, pending.version) as { status: string; lease_until: number | null; expires_at: string; principal_id: string; session_id: string } | undefined;
    if (!row || row.principal_id !== evidence.principalId || row.session_id !== evidence.sessionId || Date.parse(row.expires_at) <= currentTime) return false;
    const available = row.status === 'pending' || (row.status === 'processing' && (row.lease_until ?? 0) <= currentTime);
    if (!available) return false;
    const claimed = db.prepare(`UPDATE pending_plan_confirmations
      SET status = 'processing', lease_token = ?, lease_until = ?, lease_message_id = ?, updated_at = ?
      WHERE plan_id = ? AND version = ? AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))`)
      .run(token, currentTime + leaseMs, evidence.messageId, now().toISOString(), pending.planId, pending.version, currentTime);
    return claimed.changes === 1;
  });

  const release = (planId: string, version: number, token: string) => {
    db.prepare(`UPDATE pending_plan_confirmations SET status = 'pending', lease_token = NULL, lease_until = NULL,
      lease_message_id = NULL, updated_at = ? WHERE plan_id = ? AND version = ? AND status = 'processing' AND lease_token = ?`)
      .run(now().toISOString(), planId, version, token);
  };

  const finalize = db.transaction((pending: StoredPendingPlanConfirmation, evidence: StoredPlanConfirmationEvidence, resolution: 'confirmed' | 'cancelled', token: string) => {
    const owner = db.prepare(`SELECT principal_id, session_id FROM pending_plan_confirmations
      WHERE plan_id = ? AND version = ? AND status = 'processing' AND lease_token = ? AND lease_message_id = ?`)
      .get(pending.planId, pending.version, token, evidence.messageId) as { principal_id: string; session_id: string } | undefined;
    if (!owner || owner.principal_id !== evidence.principalId || owner.session_id !== evidence.sessionId) return false;
    const resolvedAt = now().toISOString();
    db.prepare(`INSERT INTO plan_confirmation_resolutions
      (message_id, plan_id, version, principal_id, session_id, text, received_at, resolution, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidence.messageId, pending.planId, pending.version, evidence.principalId, evidence.sessionId, evidence.text, evidence.receivedAt, resolution, resolvedAt);
    const updated = db.prepare(`UPDATE pending_plan_confirmations SET status = ?, lease_token = NULL, lease_until = NULL,
      lease_message_id = NULL, updated_at = ? WHERE plan_id = ? AND version = ? AND status = 'processing' AND lease_token = ?`)
      .run(resolution, resolvedAt, pending.planId, pending.version, token);
    return updated.changes === 1;
  });

  return {
    async savePending(record) { savePending(record); },
    async listPending(principalId, sessionId) {
      const rows = db.prepare(`SELECT plan_id, version, payload, status, lease_until FROM pending_plan_confirmations
        WHERE principal_id = ? AND session_id = ? AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
        ORDER BY updated_at, plan_id, version`)
        .all(principalId, sessionId, now().getTime()) as PendingRow[];
      return rows.map((row) => JSON.parse(row.payload) as StoredPendingPlanConfirmation);
    },
    async claimPending(pending, evidence) {
      return claim(pending, evidence, randomUUID());
    },
    async resolvePending(pending, evidence, resolution, action) {
      const token = randomUUID();
      if (!claim(pending, evidence, token)) return false;
      try {
        await action();
        options.beforeFinalize?.();
        const committed = finalize(pending, evidence, resolution, token);
        if (!committed) throw new Error('pending plan changed while confirmation was being activated');
        return true;
      } catch (error) {
        release(pending.planId, pending.version, token);
        throw error;
      }
    },
    async getResolution(messageId) {
      const row = db.prepare('SELECT * FROM plan_confirmation_resolutions WHERE message_id = ?').get(messageId) as ResolutionRow | undefined;
      return row ? {
        messageId: row.message_id, planId: row.plan_id, version: row.version, principalId: row.principal_id,
        sessionId: row.session_id, text: row.text, receivedAt: row.received_at,
        resolution: row.resolution as PlanConfirmationResolution['resolution'], resolvedAt: row.resolved_at,
      } : null;
    },
    close() { db.close(); },
  };
}

function validatePending(record: StoredPendingPlanConfirmation): void {
  if (!record.planId.trim() || !Number.isInteger(record.version) || record.version < 1 || !record.taskId.trim()
      || !record.principalId.trim() || !record.sessionId.trim() || record.decision !== 'confirm'
      || !record.userText.trim() || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new Error('invalid pending plan confirmation');
  }
}

function validateEvidence(pending: StoredPendingPlanConfirmation, evidence: StoredPlanConfirmationEvidence): void {
  if (!evidence.messageId.trim() || !evidence.text.trim() || !Number.isFinite(Date.parse(evidence.receivedAt))
      || pending.principalId !== evidence.principalId || pending.sessionId !== evidence.sessionId) {
    throw new Error('confirmation evidence is outside pending plan scope or invalid');
  }
}
