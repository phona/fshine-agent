import type { PendingPlanConfirmation } from './plan-runtime';

/** Persistent scope/evidence attached by the trusted host when a confirm decision is emitted. */
export interface PendingPlanConfirmationRecord extends PendingPlanConfirmation {
  principalId: string;
  sessionId: string;
  expiresAt: string;
}

export interface PlanConfirmationEvidence {
  messageId: string;
  principalId: string;
  sessionId: string;
  text: string;
  receivedAt: string;
}

export interface PendingPlanConfirmationRepo {
  /** Return unresolved records for exactly this trusted scope. Caller still rechecks scope. */
  listPending(principalId: string, sessionId: string): Promise<PendingPlanConfirmationRecord[]>;
  /**
   * Atomically serialize resolution for a pending plan and persist evidence only after action
   * resolves. On action failure it must leave the record pending and propagate the error.
   * Implementations must deduplicate messageId and CAS on planId + version. The activation
   * operation itself must be idempotent on planId + version to cover a process crash after
   * activation but before the repository commit.
   */
  resolvePending(
    pending: PendingPlanConfirmationRecord,
    evidence: PlanConfirmationEvidence,
    resolution: 'confirmed' | 'cancelled',
    action: () => Promise<void>,
  ): Promise<boolean>;
}

export interface WecomUserConfirmationMessage extends PlanConfirmationEvidence {
  /** This discriminator is added by the trusted channel adapter, never copied from model output. */
  origin: 'wecom_user';
}

export type ConfirmationMatchResult =
  | { status: 'activated'; planId: string; version: number; taskId: string; messageId: string }
  | { status: 'cancelled'; planId: string; version: number; taskId: string; messageId: string }
  | { status: 'ignored' }
  | { status: 'ambiguous' }
  | { status: 'expired'; planId: string; version: number };

export async function matchAndResolvePlanConfirmation(input: {
  message: WecomUserConfirmationMessage;
  repo: PendingPlanConfirmationRepo;
  activate: (pending: PendingPlanConfirmationRecord, evidence: PlanConfirmationEvidence) => Promise<void>;
  now?: string;
}): Promise<ConfirmationMatchResult> {
  const { message } = input;
  if (message.origin !== 'wecom_user' || !message.messageId.trim() || !message.principalId.trim() || !message.sessionId.trim()) {
    return { status: 'ignored' };
  }

  const resolution = classifyAnswer(message.text);
  if (!resolution) return { status: 'ignored' };

  const now = Date.parse(input.now ?? new Date().toISOString());
  const rows = await input.repo.listPending(message.principalId, message.sessionId);
  // Do not rely only on repository filtering: principal/session are security boundaries.
  const scoped = rows.filter((row) => row.principalId === message.principalId && row.sessionId === message.sessionId && row.decision === 'confirm');
  if (scoped.length === 0) return { status: 'ignored' };

  const active = scoped.filter((row) => Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > now);
  if (active.length === 0) {
    const expired = scoped[0]!;
    return { status: 'expired', planId: expired.planId, version: expired.version };
  }
  // Never guess if two live plans could be what the user meant.
  if (active.length !== 1) return { status: 'ambiguous' };

  const pending = active[0]!;
  const evidence: PlanConfirmationEvidence = {
    messageId: message.messageId,
    principalId: message.principalId,
    sessionId: message.sessionId,
    text: message.text,
    receivedAt: message.receivedAt,
  };
  const activated = await input.repo.resolvePending(pending, evidence, resolution, async () => {
    if (resolution === 'confirmed') await input.activate(pending, evidence);
  });
  if (!activated) return { status: 'ignored' };
  return {
    status: resolution === 'confirmed' ? 'activated' : 'cancelled',
    planId: pending.planId,
    version: pending.version,
    taskId: pending.taskId,
    messageId: message.messageId,
  };
}

function classifyAnswer(text: string): 'confirmed' | 'cancelled' | undefined {
  // Exact short replies only. Ignore explanatory or hedged text instead of asking a model to infer consent.
  const normalized = text.normalize('NFKC').trim().replace(/[\s，。！？、,.!?；;：:「」『』“”‘’]/g, '');
  if (['确认继续', '确认', '同意', '继续', '可以继续', '按这个方案'].includes(normalized)) return 'confirmed';
  if (['取消', '不继续', '停止', '先不做'].includes(normalized)) return 'cancelled';
  return undefined;
}
