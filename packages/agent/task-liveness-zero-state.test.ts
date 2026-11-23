/**
 * 事实谓词守卫（owner 2026-11-23）：活/结束由事实现推，不读任何终态列，也不返回状态词。
 *
 * 现推口径（布尔事实）：
 *   · 排队：started_at 空 + 无汇报 + 无提问；
 *   · 仍在推进：started_at 有 + 无结束事实 + 无汇报 + 无提问；
 *   · 可能还在跑（跨进程读者）：仍在推进 + 租约未过期或 accepted 在途；
 *   · 等用户：pendingQuestion 有；
 *   · 结束：已有结束事实（task_ends，只有时刻、没有种类）或汇报存档；
 *     已启动、无汇报、无结束事实、无租约/无在途 = 结果未知（消费方按事实现推）。
 *
 * 本测试是「不落状态列/不返回状态词」的行为判据：不构造任何 diedAt/cancelledAt 字段，
 * 也不断言 running/died/waiting_user 这类枚举。
 */
import { describe, expect, it } from 'vitest';
import {
  createTaskRegistry,
  stillProgressingOf,
  taskEndedOf,
  taskMayBeRunningOf,
  taskProgressEndedOf,
  taskStartedOf,
  taskWaitingOf,
} from './src/task-registry';

const STARTED = { runningSince: '2026-11-23T00:00:00.000Z' } as const;
const ENDED = { at: '2026-11-23T00:01:00.000Z' } as const;
const FUTURE = '2999-01-01T00:00:00.000Z';

describe('事实谓词：跨进程「可能还在跑」', () => {
  it('排队（未启动、无汇报、无提问）→ 不可能在跑', () => {
    expect(taskMayBeRunningOf({})).toBe(false);
  });

  it('已启动 + 无汇报 + 无提问 + 有效租约 → 可能还在跑；租约过期 → 不', () => {
    expect(taskMayBeRunningOf({ ...STARTED, leaseUntil: FUTURE })).toBe(true);
    expect(taskMayBeRunningOf({
      ...STARTED,
      leaseUntil: '2026-11-23T00:30:00.000Z',
    }, '2026-11-23T01:00:00.000Z')).toBe(false);
  });

  it('accepted 在途（无租约）→ 可能还在跑；末条 accepted 但有汇报 → 不', () => {
    expect(taskMayBeRunningOf({ executions: [{ status: 'accepted' }] })).toBe(true);
    expect(taskMayBeRunningOf({ executions: [{ status: 'accepted' }], resultText: '办完了。' })).toBe(false);
  });

  it('等待形状 → 可能还在跑为假（等待可接续，但不是活 worker）', () => {
    expect(taskWaitingOf({ pendingQuestion: { missing: ['窗口'] } })).toBe(true);
    expect(taskMayBeRunningOf({ ...STARTED, pendingQuestion: { missing: ['窗口'] } })).toBe(false);
  });

  it('有汇报 / 有结束事实 → 不可能在跑（即使租约残留）', () => {
    expect(taskMayBeRunningOf({ ...STARTED, leaseUntil: FUTURE, resultText: '办完了。' })).toBe(false);
    expect(taskMayBeRunningOf({ ...STARTED, leaseUntil: FUTURE, replyText: '办完了。' })).toBe(false);
    expect(taskMayBeRunningOf({ ...STARTED, leaseUntil: FUTURE, endedAt: ENDED.at })).toBe(false);
  });
});

describe('唯一谓词：不依赖终态列', () => {
  it('已启动且无汇报/提问/结束事实 = 仍在推进', () => {
    expect(stillProgressingOf(STARTED)).toBe(true);
    expect(stillProgressingOf({ leaseUntil: FUTURE })).toBe(true);
  });

  it('结束事实 / 汇报 / 等待 = 不在推进', () => {
    expect(stillProgressingOf({ ...STARTED, endedAt: ENDED.at })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, resultText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, replyText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, pendingQuestion: { missing: ['窗口'] } })).toBe(false);
  });

  it('taskEndedOf = 结束事实在场；taskProgressEndedOf = 结束事实或汇报', () => {
    expect(taskEndedOf({})).toBe(false);
    expect(taskEndedOf({ endedAt: ENDED.at })).toBe(true);
    expect(taskProgressEndedOf({ endedAt: ENDED.at })).toBe(true);
    expect(taskProgressEndedOf({ resultText: '办完了。' })).toBe(true);
    expect(taskProgressEndedOf({})).toBe(false);
  });

  it('taskStartedOf 仍认启动事实：running_since / 租约 / accepted 在途', () => {
    expect(taskStartedOf({})).toBe(false);
    expect(taskStartedOf(STARTED)).toBe(true);
    expect(taskStartedOf({ leaseUntil: FUTURE })).toBe(true);
    expect(taskStartedOf({ executions: [{ status: 'accepted' }] })).toBe(true);
  });
});

describe('内存 registry：结束事实只留时刻，不写种类', () => {
  it('停法写入 endedAt；后到的停法不覆盖（不可变）', () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't1', principalId: 'p', sessionId: 's', request: '任务' });
    expect(registry.get('t1').endedAt).toBeUndefined();
    const stopped = registry.markCancelled('t1');
    expect(stopped.endedAt).toBeTruthy();
    expect(taskMayBeRunningOf(registry.get('t1'))).toBe(false);
    const first = stopped.endedAt;
    expect(registry.markTimedOut('t1', 'execution').endedAt).toBe(first);
    expect(Object.keys(stopped)).not.toContain('termination');
  });
});
