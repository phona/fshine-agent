/**
 * 存活/状态词投影（纯函数）反向绊线：长任务「已受理、等回执」不是 failed。
 *
 * S1 事实模型：task 没有 status；长任务受理后租约被释放，底账只剩 running_since + 末条执行行
 * （status=accepted）。2026-11-22 Grok 复审：旧投影只看租约 → accepted 长任务被读成
 * 「已启动但无汇报收尾」的 failed，生产 task_run 短等待窗口把「failed」交给模型（诱导重交办）。
 * 修复：末条执行 = accepted（无终局、无汇报）→ running（旧 status='running' 语义）。
 */
import { describe, expect, it } from 'vitest';
import { createTaskRegistry, taskLivenessOf, taskStateWordOf } from './src/task-registry';

const ACCEPTED = [{ status: 'accepted' }] as const;

describe('存活/状态词投影：长任务 accepted（受理中）', () => {
  it('taskLivenessOf：末条执行 accepted、无租约 → running（不是 undefined）', () => {
    expect(taskLivenessOf({ executions: ACCEPTED })).toBe('running');
  });

  it('taskStateWordOf：accepted、running_since 在场、无汇报 → running（不是 failed）', () => {
    expect(taskStateWordOf({ runningSince: '2026-11-22T00:00:00.000Z', executions: ACCEPTED })).toBe('running');
  });

  it('已存档汇报的长任务（末条仍 accepted + resultText）→ reported，不是 running/failed', () => {
    // 真实形状：长任务完成后汇报走 archiveReply，续跑成功不追加执行行——末条仍是 accepted。
    // 旧 acceptedInFlightOf 只看末条 status，把已完成任务投影成 running（tasks --redo 随之误拒）。
    const reported = {
      runningSince: '2026-11-22T00:00:00.000Z',
      resultText: '导出完成。',
      executions: ACCEPTED,
    } as const;
    expect(taskStateWordOf(reported)).toBe('reported');
    expect(taskLivenessOf(reported)).toBeUndefined();
  });

  it('已存档汇报的长任务（末条仍 accepted + replyText 存档面）→ 同样 reported', () => {
    const reported = {
      runningSince: '2026-11-22T00:00:00.000Z',
      replyText: 'Main 回复：导出完成。',
      executions: ACCEPTED,
    } as const;
    expect(taskStateWordOf(reported)).toBe('reported');
    expect(taskLivenessOf(reported)).toBeUndefined();
  });

  it('已存档汇报的短任务（末条 completed + 汇报）→ reported（不被 accepted 分支误判）', () => {
    expect(taskStateWordOf({
      runningSince: '2026-11-22T00:00:00.000Z',
      resultText: '导出完成。',
      executions: [{ status: 'completed' }],
    })).toBe('reported');
  });

  it('无终局、无租约、无 accepted、无汇报的已启动行仍是 failed（不误伤）', () => {
    expect(taskStateWordOf({
      runningSince: '2026-11-22T00:00:00.000Z',
      executions: [{ status: 'failed' }],
    })).toBe('failed');
  });

  it('有结束事实（died）时 accepted 不翻案 → died', () => {
    expect(taskStateWordOf({
      runningSince: '2026-11-22T00:00:00.000Z',
      diedAt: '2026-11-22T00:01:00.000Z',
      executions: ACCEPTED,
    })).toBe('died');
  });
});

describe('createTaskRegistry().listRunning（内存实现与 SQLite 同口径）', () => {
  it('汇报存档（resultText/replyText）或 round_failed_at 的行不再被算作「在跑」', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'p', sessionId: 's' };
    for (const taskId of ['live', 'done_result', 'done_reply', 'no_report']) {
      registry.begin({ taskId, ...scope, request: `任务 ${taskId}` });
    }
    registry.setResultText('done_result', '完成汇报。');
    registry.archiveReply(['done_reply'], 'Main 回复存档。');
    registry.noteRoundFailed('no_report');
    expect(registry.listRunning().map((task) => task.taskId)).toEqual(['live']);
  });
});
