/**
 * 存活/状态词投影（纯函数）反向绊线：长任务「已受理、等回执」不是 failed。
 *
 * S1 事实模型：task 没有 status；长任务受理后租约被释放，底账只剩 running_since + 末条执行行
 * （status=accepted）。2026-11-22 Grok 复审：旧投影只看租约 → accepted 长任务被读成
 * 「已启动但无汇报收尾」的 failed，生产 task_run 短等待窗口把「failed」交给模型（诱导重交办）。
 * 修复：末条执行 = accepted（无终局、无汇报）→ running（旧 status='running' 语义）。
 */
import { describe, expect, it } from 'vitest';
import { taskLivenessOf, taskStateWordOf } from './src/task-registry';

const ACCEPTED = [{ status: 'accepted' }] as const;

describe('存活/状态词投影：长任务 accepted（受理中）', () => {
  it('taskLivenessOf：末条执行 accepted、无租约 → running（不是 undefined）', () => {
    expect(taskLivenessOf({ executions: ACCEPTED })).toBe('running');
  });

  it('taskStateWordOf：accepted、running_since 在场、无汇报 → running（不是 failed）', () => {
    expect(taskStateWordOf({ runningSince: '2026-11-22T00:00:00.000Z', executions: ACCEPTED })).toBe('running');
  });

  it('已存档汇报的长任务（末条 completed + 汇报）→ reported（不被 accepted 分支误判）', () => {
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
