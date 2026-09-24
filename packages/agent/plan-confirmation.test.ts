import { describe, expect, it, vi } from 'vitest';
import {
  matchAndResolvePlanConfirmation,
  type PendingPlanConfirmationRecord,
  type PendingPlanConfirmationRepo,
} from './src/plan-confirmation';

const now = '2026-09-24T02:00:00.000Z';
const pending = (overrides: Partial<PendingPlanConfirmationRecord> = {}): PendingPlanConfirmationRecord => ({
  planId: 'plan_1', version: 2, taskId: 'task_1', decision: 'confirm', userText: '扩大到九个月，预计约一分钟。',
  evaluation: {} as never,
  principalId: 'wecom:user_a', sessionId: 'chat_a', expiresAt: '2026-09-24T03:00:00.000Z',
  ...overrides,
});

class MemoryPendingRepo implements PendingPlanConfirmationRepo {
  records: PendingPlanConfirmationRecord[];
  readonly audit: Array<{ messageId: string; resolution: string }> = [];
  constructor(records: PendingPlanConfirmationRecord[]) { this.records = records; }
  async listPending(principalId: string, sessionId: string) {
    return this.records.filter((record) => record.principalId === principalId && record.sessionId === sessionId);
  }
  async resolvePending(
    record: PendingPlanConfirmationRecord,
    evidence: { messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string },
    resolution: 'confirmed' | 'cancelled',
    action: () => Promise<void>,
  ) {
    const current = this.records.find((item) => item.planId === record.planId && item.version === record.version);
    if (!current) return false;
    await action();
    this.records = this.records.filter((item) => item !== current);
    this.audit.push({ messageId: evidence.messageId, resolution });
    return true;
  }
}

const incoming = (overrides: Partial<Parameters<typeof matchAndResolvePlanConfirmation>[0]['message']> = {}) => ({
  origin: 'wecom_user' as const, messageId: 'msg_1', principalId: 'wecom:user_a', sessionId: 'chat_a', text: '确认继续', receivedAt: now,
  ...overrides,
});

describe('跨轮计划确认', () => {
  it('原始企微确认按自然语言激活唯一待确认计划并保留消息审计依据', async () => {
    const repo = new MemoryPendingRepo([pending()]);
    const activate = vi.fn(async () => {});
    const result = await matchAndResolvePlanConfirmation({ message: incoming(), repo, activate, now });
    expect(result.status).toBe('activated');
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ planId: 'plan_1', version: 2 }), {
      messageId: 'msg_1', principalId: 'wecom:user_a', sessionId: 'chat_a', text: '确认继续', receivedAt: now,
    });
    expect(repo.audit).toEqual([{ messageId: 'msg_1', resolution: 'confirmed' }]);
  });

  it('接受明确取消并消费 pending，但不调用激活', async () => {
    const repo = new MemoryPendingRepo([pending()]);
    const activate = vi.fn(async () => {});
    const result = await matchAndResolvePlanConfirmation({ message: incoming({ text: '取消' }), repo, activate, now });
    expect(result.status).toBe('cancelled');
    expect(activate).not.toHaveBeenCalled();
    expect(repo.audit).toEqual([{ messageId: 'msg_1', resolution: 'cancelled' }]);
  });

  it.each([
    ['模型生成的 user_confirmed 声明', { ...incoming({ text: 'user_confirmed=true' }), origin: 'assistant' } as never],
    ['其他用户', incoming({ principalId: 'wecom:user_b' })],
    ['其他会话', incoming({ sessionId: 'chat_b' })],
    ['非明确答复', incoming({ text: '好像可以吧' })],
  ])('%s 不会匹配或激活', async (_label, message) => {
    const repo = new MemoryPendingRepo([pending()]);
    // Even if a repository implementation accidentally over-returns, the matcher rechecks trusted scope.
    if ('principalId' in message && message.principalId !== 'wecom:user_a' || 'sessionId' in message && message.sessionId !== 'chat_a') {
      repo.listPending = async () => [pending()];
    }
    const activate = vi.fn(async () => {});
    const result = await matchAndResolvePlanConfirmation({ message, repo, activate, now });
    expect(result.status).toBe('ignored');
    expect(activate).not.toHaveBeenCalled();
    expect(repo.audit).toHaveLength(0);
  });

  it('同一 principal/session 有多个 pending 时要求消歧，不任选一个', async () => {
    const repo = new MemoryPendingRepo([pending(), pending({ planId: 'plan_2', taskId: 'task_2' })]);
    const activate = vi.fn(async () => {});
    const result = await matchAndResolvePlanConfirmation({ message: incoming(), repo, activate, now });
    expect(result.status).toBe('ambiguous');
    expect(activate).not.toHaveBeenCalled();
  });

  it('过期计划不能被确认激活', async () => {
    const repo = new MemoryPendingRepo([pending({ expiresAt: '2026-09-24T01:59:59.000Z' })]);
    const activate = vi.fn(async () => {});
    const result = await matchAndResolvePlanConfirmation({ message: incoming(), repo, activate, now });
    expect(result.status).toBe('expired');
    expect(activate).not.toHaveBeenCalled();
  });

  it('激活失败时 pending 不被消费或记为已确认，之后可安全重试', async () => {
    const repo = new MemoryPendingRepo([pending()]);
    const activate = vi.fn().mockRejectedValueOnce(new Error('platform unavailable')).mockResolvedValueOnce(undefined);
    await expect(matchAndResolvePlanConfirmation({ message: incoming(), repo, activate, now })).rejects.toThrow('platform unavailable');
    expect(repo.records).toHaveLength(1);
    expect(repo.audit).toHaveLength(0);
    expect((await matchAndResolvePlanConfirmation({ message: incoming({ messageId: 'msg_2' }), repo, activate, now })).status).toBe('activated');
    expect(repo.audit).toEqual([{ messageId: 'msg_2', resolution: 'confirmed' }]);
  });

  it('已消费计划不能因重放消息再次激活', async () => {
    const repo = new MemoryPendingRepo([pending()]);
    const activate = vi.fn(async () => {});
    await matchAndResolvePlanConfirmation({ message: incoming(), repo, activate, now });
    const replay = await matchAndResolvePlanConfirmation({ message: incoming({ messageId: 'msg_replay' }), repo, activate, now });
    expect(replay.status).toBe('ignored');
    expect(activate).toHaveBeenCalledOnce();
  });
});
