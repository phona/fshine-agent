/**
 * 零状态 liveness 守卫（owner 2026-11-23）：活/结束由事实现推，不读任何终态列。
 *
 * 现推口径：
 *   · 排队：started_at 空 + 无汇报 + 无提问；
 *   · 在跑：started_at 有 + 无汇报 + 无提问 + **本进程有活 worker**；
 *   · 等用户：pendingQuestion 有；
 *   · 结束：已启动且无活 worker（进程没了 = 全不活）——有汇报=正常结束，无汇报=结果未知；
 *   · 已有终止事件（追加事件账）= 已结束，不翻案。
 *
 * 本测试同时是「liveness 不落列」的行为判据：不构造任何 diedAt/cancelledAt 字段，只看事实。
 */
import { describe, expect, it } from 'vitest';
import {
  createTaskRegistry,
  stillProgressingOf,
  taskEndedOf,
  taskLivenessOf,
  taskProgressEndedOf,
  taskStartedOf,
} from './src/task-registry';
import type { TaskTermination } from '@fshine/core';

const STARTED = { runningSince: '2026-11-23T00:00:00.000Z' } as const;
const ENDED: TaskTermination = { kind: 'cancelled', at: '2026-11-23T00:01:00.000Z' };

describe('taskLivenessOf：事实现推', () => {
  it('排队（未启动、无汇报、无提问）→ 无 liveness', () => {
    expect(taskLivenessOf({})).toBeUndefined();
    expect(taskLivenessOf({ leaseUntil: '2999-01-01T00:00:00.000Z' })).toBe('running');
  });

  it('已启动 + 无汇报 + 无提问：有活 worker → running；无活 worker → died（结果未知）', () => {
    expect(taskLivenessOf(STARTED, { liveWorker: true })).toBe('running');
    expect(taskLivenessOf(STARTED, { liveWorker: false })).toBe('died');
  });

  it('等待形状优先于「无活 worker」：持久等待可被下一进程接续 → waiting_user', () => {
    expect(taskLivenessOf({ ...STARTED, pendingQuestion: { missing: ['窗口'] } }, { liveWorker: false }))
      .toBe('waiting_user');
  });

  it('有汇报 = 正常结束（无论有没有活 worker）', () => {
    expect(taskLivenessOf({ ...STARTED, resultText: '办完了。' }, { liveWorker: true })).toBeUndefined();
    expect(taskLivenessOf({ ...STARTED, replyText: '办完了。' }, { liveWorker: false })).toBeUndefined();
  });

  it('已有终止事件 = 已结束，不翻案（等待形状/租约残留都不改写）', () => {
    expect(taskLivenessOf({ ...STARTED, termination: ENDED }, { liveWorker: true })).toBeUndefined();
    expect(taskLivenessOf({
      ...STARTED,
      pendingQuestion: { missing: ['窗口'] },
      termination: { kind: 'timed_out', at: '2026-11-23T00:02:00.000Z' },
    }, { liveWorker: false })).toBeUndefined();
  });
});

describe('唯一谓词：不依赖终态列', () => {
  it('已启动且无汇报/提问/终止事件 = 仍在推进', () => {
    expect(stillProgressingOf(STARTED)).toBe(true);
    expect(stillProgressingOf({ leaseUntil: '2999-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('终止事件 / 汇报 / 等待 = 不在推进', () => {
    expect(stillProgressingOf({ ...STARTED, termination: ENDED })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, resultText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, replyText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...STARTED, pendingQuestion: { missing: ['窗口'] } })).toBe(false);
  });

  it('taskEndedOf = 终止事件在场；taskProgressEndedOf = 终止事件或汇报', () => {
    expect(taskEndedOf({})).toBe(false);
    expect(taskEndedOf({ termination: ENDED })).toBe(true);
    expect(taskProgressEndedOf({ termination: ENDED })).toBe(true);
    expect(taskProgressEndedOf({ resultText: '办完了。' })).toBe(true);
    expect(taskProgressEndedOf({})).toBe(false);
  });

  it('taskStartedOf 仍认启动事实：running_since / 租约 / accepted 在途', () => {
    expect(taskStartedOf({})).toBe(false);
    expect(taskStartedOf(STARTED)).toBe(true);
    expect(taskStartedOf({ leaseUntil: '2999-01-01T00:00:00.000Z' })).toBe(true);
    expect(taskStartedOf({ executions: [{ status: 'accepted' }] })).toBe(true);
  });
});

describe('内存 registry：liveness 与终止事件一致', () => {
  it('终止后 liveness = undefined；事件仍在（不可变）', () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't1', principalId: 'p', sessionId: 's', request: '任务' });
    expect(registry.get('t1').termination).toBeUndefined();
    const cancelled = registry.markCancelled('t1');
    expect(cancelled.termination?.kind).toBe('cancelled');
    expect(taskLivenessOf(registry.get('t1'), { liveWorker: true })).toBeUndefined();
    // 不翻案：再落别的终止不覆盖第一条。
    expect(registry.markTimedOut('t1', 'execution').termination?.kind).toBe('cancelled');
  });
});
