/**
 * 底账事实读数的行为绊线（2026-11-24 grok minor 的修复守卫）。
 *
 * 缺陷形态：`waiting` 只看 `pendingQuestion` 在场、不看结束事实。结束事实**故意不清**
 * pending_question（提案的句柄/摘要/写入参数只在它上面），于是「已取消 / 租约过期但还留着
 * 提案」的行被算成等待 → `resultUnknown` 被压成 false、`taskFailureFactOf` 返回 undefined。
 * 而 `ended`（租约过期）不在 NOTIFICATION_KINDS 里、没有通知面兜它——那一支**没有任何人
 * 告诉用户「结果未知」」（取消/超时/容量拒绝各有通知种类，不受影响）。
 *
 * 判据单一来源：`waiting` 必须走 `@fshine/core` 的 `taskWaitingOf`（提问在场且本轮未停）。
 */
import { describe, expect, it } from 'vitest';
import { taskFactReadingOf, type TaskFactRecord } from './task-fact-reading';

/** 一条待确认提案（等待形状的最小载荷：句柄 + 摘要 + 写入参数）。 */
const PROPOSAL = { confirmation: { handle: 'cfm_1', summary: '写一条', args: { collection: 'documents' } } };

const record = (over: TaskFactRecord): TaskFactRecord => ({ runningSince: '2026-11-24T00:00:00.000Z', ...over });

describe('底账事实读数（taskFactReadingOf）', () => {
  it('结束事实在场 + 仍留着提案 → 不算等待，结果未知可得', () => {
    // 租约过期（`ended` 事件、无通知种类）+ 提案留作历史：这一支必须能说出「结果未知」。
    const ended = record({ pendingQuestion: PROPOSAL, endedAt: '2026-11-24T01:00:00.000Z' });
    expect(taskFactReadingOf(ended, false)).toMatchObject({ started: true, waiting: false, resultUnknown: true });
    // 取消（user_stop）同形：通知面会兜它，但读数本身也不该把它算成等待。
    const cancelled = record({ pendingQuestion: PROPOSAL, endedAt: '2026-11-24T01:00:00.000Z' });
    expect(taskFactReadingOf(cancelled, false).waiting).toBe(false);
  });

  it('真的在等待（提问在场、没停）→ 仍是等待，不算结果未知', () => {
    const waiting = record({ pendingQuestion: PROPOSAL });
    expect(taskFactReadingOf(waiting, false)).toMatchObject({ started: true, waiting: true, resultUnknown: false });
  });

  it('末条执行是确定事实 → 不报结果未知（按执行事实归类）', () => {
    for (const status of ['completed', 'failed', 'refused'] as const) {
      const withExecution = record({ endedAt: '2026-11-24T01:00:00.000Z', executions: [{ status }] });
      expect(taskFactReadingOf(withExecution, false).resultUnknown, status).toBe(false);
    }
  });

  it('有汇报 / 有活 worker → 都不算结果未知', () => {
    expect(taskFactReadingOf(record({ endedAt: '2026-11-24T01:00:00.000Z', resultText: '办完了。' }), false).resultUnknown).toBe(false);
    expect(taskFactReadingOf(record({ endedAt: '2026-11-24T01:00:00.000Z' }), true).resultUnknown).toBe(false);
  });
});
