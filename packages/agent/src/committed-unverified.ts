/**
 * Committed-but-unverified terminal state (Phase 2).
 *
 * When a proposal commit has already posted (the platform marks the
 * proposal 'committed' so it cannot be committed a second time) but the
 * post-commit readback is short or missing, the host must never report
 * "completed". The distinct terminal state is committed_unverified:
 * posted, not verified, needs a human to reconcile. The text below is the
 * single source for that report; callers must not rephrase it into a
 * success line, and must not reuse the generic failure line either, because
 * "failed" would imply nothing was posted, which is false here.
 */
export interface ReadBackCounts {
  before?: unknown;
  after?: unknown;
  delta?: unknown;
  required?: unknown;
}

export const COMMITTED_UNVERIFIED_LINE =
  '已落账、读回不足、需人工核对：平台侧提案已标记为已提交（不可重复提交），但落账后读回的数量未达到提案要求，实际落账数与提案数之间的差额尚未核实。';
export const COMMITTED_UNVERIFIED_RECONCILIATION_LINE =
  '人工核对入口：请核对平台实际落账数与提案要求数，确认差额与缺失项后再处理；不要重复确认或重新发起同一提案，以免重复落账。';

export function renderCommittedUnverifiedReply(readBack?: ReadBackCounts): string {
  const lines = [COMMITTED_UNVERIFIED_LINE, COMMITTED_UNVERIFIED_RECONCILIATION_LINE];
  if (readBack) {
    const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '未知');
    lines.push(`读回计数：提交前 ${num(readBack.before)}，提交后 ${num(readBack.after)}，增加 ${num(readBack.delta)}，提案要求 ${num(readBack.required)}。`);
  }
  return lines.join('\n');
}

/**
 * Mechanical classifier. Inputs are envelope fields only, never worker
 * text and never a business summary. A commit is committed_unverified
 * when the platform says the readback check failed (code
 * PROPOSAL_VERIFY_SHORT) or the readback delta is below the required
 * count. Everything else is not this state.
 */
export function isCommittedUnverified(input: {
  ok: boolean;
  verified: boolean;
  errorCode?: string;
  readBack?: ReadBackCounts;
}): boolean {
  if (input.ok) return false;
  if (input.errorCode === 'PROPOSAL_VERIFY_SHORT') return true;
  const delta = input.readBack?.delta;
  const required = input.readBack?.required;
  return typeof delta === 'number' && typeof required === 'number' && delta < required;
}
