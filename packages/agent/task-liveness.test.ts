/**
 * 存活（liveness）反向绊线：长任务「已受理、等回执」不是已收尾。
 *
 * S1 事实模型：task 没有 status；长任务受理后租约被释放，底账只剩 running_since + 末条执行行
 * （status=accepted）。2026-11-22 Grok 复审：旧投影只看租约 → accepted 长任务被读成
 * 「已启动但无汇报收尾」的 failed，生产 task_run 短等待窗口把「failed」交给模型（诱导重交办）。
 * 修复：末条执行 = accepted（无终局、无汇报）→ liveness running。
 * 「做没做成」不再投影成状态词：测试只读 liveness 三值与账本事实（执行行 / 汇报存档）。
 */
import { describe, expect, it } from 'vitest';
import { createTaskRegistry, stillProgressingOf, taskLivenessOf } from './src/task-registry';
import { archivedReportOf, lastExecutionOf } from './testing/task-facts';

const ACCEPTED = [{ status: 'accepted' }] as const;

describe('仍在推进的唯一谓词（stillProgressingOf）', () => {
  const started = { runningSince: '2026-11-22T00:00:00.000Z' } as const;

  it('已启动 + 无结束/回合失败/汇报/等待 = 仍在推进（租约本身也是已启动信号）', () => {
    expect(stillProgressingOf(started)).toBe(true);
    expect(stillProgressingOf({ leaseUntil: '2999-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('四个结束时刻任一在场 = 不在推进', () => {
    for (const fact of ['diedAt', 'cancelledAt', 'timedOutAt', 'resourceLimitedAt'] as const) {
      expect(stillProgressingOf({ ...started, [fact]: '2026-11-22T00:01:00.000Z' }), fact).toBe(false);
    }
  });

  it('round_failed（本轮已停）/ 汇报存档（resultText 或 replyText）/ 等待形状 = 不在推进', () => {
    expect(stillProgressingOf({ ...started, roundFailedAt: '2026-11-22T00:01:00.000Z' })).toBe(false);
    expect(stillProgressingOf({ ...started, resultText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...started, replyText: '办完了。' })).toBe(false);
    // 两侧都空 = 无汇报存档（不是「任一侧有值才算」，也不是「前者空就整体算空」）。
    expect(stillProgressingOf({ ...started, resultText: '', replyText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ ...started, resultText: '', replyText: '' })).toBe(true);
    expect(stillProgressingOf({ ...started, pendingQuestion: { missing: ['窗口'] } })).toBe(false);
  });

  it('未启动（running_since 缺省）不算在跑；accepted 在途按既有 liveness 口径算在跑', () => {
    expect(stillProgressingOf({})).toBe(false);
    expect(stillProgressingOf({ executions: ACCEPTED })).toBe(true);
    expect(stillProgressingOf({ executions: ACCEPTED, resultText: '办完了。' })).toBe(false);
    expect(stillProgressingOf({ executions: ACCEPTED, roundFailedAt: '2026-11-22T00:01:00.000Z' })).toBe(false);
  });
});

describe('存活（liveness）：长任务 accepted（受理中）', () => {
  it('末条执行 accepted、无租约 → running（不是 undefined）', () => {
    expect(taskLivenessOf({ executions: ACCEPTED })).toBe('running');
  });

  it('已存档汇报的长任务（末条仍 accepted + resultText）→ 不是存活（已收尾），汇报原文在', () => {
    // 真实形状：长任务完成后汇报走 archiveReply，续跑成功不追加执行行——末条仍是 accepted。
    // 旧 acceptedInFlightOf 只看末条 status，把已完成任务投影成 running（tasks --redo 随之误拒）。
    const reported = {
      resultText: '导出完成。',
      executions: ACCEPTED,
    } as const;
    expect(archivedReportOf(reported)).toBeDefined();
    expect(taskLivenessOf(reported)).toBeUndefined();
  });

  it('已存档汇报的长任务（末条仍 accepted + replyText 存档面）→ 同样不是存活', () => {
    const reported = {
      replyText: 'Main 回复：导出完成。',
      executions: ACCEPTED,
    } as const;
    expect(archivedReportOf(reported)).toBeDefined();
    expect(taskLivenessOf(reported)).toBeUndefined();
  });

  it('已存档汇报的短任务（末条 completed + 汇报）→ 汇报原文在（不被 accepted 分支误判）', () => {
    expect(archivedReportOf({ resultText: '导出完成。' })).toBeDefined();
  });

  it('无终局、无租约、无 accepted、无汇报的已启动行仍可读到末条 failed 执行事实（不误伤）', () => {
    expect(lastExecutionOf({
      runningSince: '2026-11-22T00:00:00.000Z',
      executions: [{ status: 'failed' }],
    } as never)?.status).toBe('failed');
  });

  it('有结束事实（died）时 accepted 不翻案 → died', () => {
    expect(taskLivenessOf({
      diedAt: '2026-11-22T00:01:00.000Z',
      executions: ACCEPTED,
    })).toBe('died');
  });

  it('本轮已停（round_failed_at / 汇报存档）时即使租约未过期也不算 running', () => {
    const running = { runningSince: '2026-11-22T00:00:00.000Z', leaseUntil: '2999-01-01T00:00:00.000Z' } as const;
    expect(taskLivenessOf(running)).toBe('running');
    expect(taskLivenessOf({ ...running, roundFailedAt: '2026-11-22T00:01:00.000Z' })).toBeUndefined();
    expect(taskLivenessOf({ ...running, resultText: '办完了。' })).toBeUndefined();
    expect(taskLivenessOf({ ...running, replyText: '办完了。' })).toBeUndefined();
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
