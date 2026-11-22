/**
 * outcomeFromTask 机械对比（S1 事实模型）反向绊线。
 *
 * 只测纯函数：宿主 classifyOutcome 已随 S1 删除，判定器改读底账 executions 逐条 status +
 * 机械状态词投影（TaskRecordJson.status）。三条不变量：
 *   · accepted（长任务受理中）不是完成 → 'blocked'（2026-11-22 Grok 复审）；
 *   · 终态失败覆盖：status=failed/timed_out/died 即便末条执行 completed → 'failed'；
 *   · 末条 completed 且无终态 → 'completed'（不误伤）。
 */
import { describe, expect, it } from 'vitest';
import { outcomeFromTask } from './judge';
import type { ExecutionRecordJson, TaskRecordJson } from './evidence';

function exec(status: string): ExecutionRecordJson {
  return { requestId: 'req_test_1', operation: 'dummy.query', status };
}

function task(status: string, executions: ExecutionRecordJson[]): TaskRecordJson {
  return {
    taskId: 'task_test_1',
    principalId: 'wecom:test',
    sessionId: 'test-session',
    request: '（测试）',
    status,
    executions,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
  };
}

describe('outcomeFromTask（机械对比）', () => {
  it('accepted（受理中）不判 completed，投影为 blocked', () => {
    expect(outcomeFromTask(task('running', [exec('accepted')]))).toBe('blocked');
  });

  it('终态 failed/timed_out/died 覆盖回 failed（末条 completed 也翻）', () => {
    expect(outcomeFromTask(task('timed_out', [exec('completed')]))).toBe('failed');
    expect(outcomeFromTask(task('failed', [exec('completed')]))).toBe('failed');
    expect(outcomeFromTask(task('died', [exec('completed')]))).toBe('failed');
  });

  it('末条 completed 且无终态 = completed（不误伤正常完成）', () => {
    expect(outcomeFromTask(task('completed', [exec('completed')]))).toBe('completed');
  });

  it('零执行 = unsupported（不受状态词影响）', () => {
    expect(outcomeFromTask(task('completed', []))).toBe('unsupported');
    expect(outcomeFromTask(task('queued', []))).toBe('unsupported');
  });
});
