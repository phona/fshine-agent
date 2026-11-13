/**
 * 最小任务底账的 SQLite 持久化与重启连续性（B 类：任务归属跨进程仍成立）。
 *
 * 覆盖：
 *   ① 写入任务 + 执行记录 → 关库重开 → 任务与执行记录仍在（底账不随进程消失）；
 *   ② 归属校验跨重启仍生效：换 principal 或换 session 取任务一律 TaskOwnershipError，
 *      与不存在同一拒绝形态（不泄漏存在性）；
 *   ③ list 按 scope 隔离，不跨会话泄漏；
 *   ④ 失败任务保留 failureReason（最小 result 面）。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskOwnershipError } from './src/minimal/task-registry';
import { createSqliteTaskRegistry } from './src/minimal/task-registry-sqlite';

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'minimal-registry-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('最小任务底账（SQLite，B 类）', () => {
  it('写入 → 关库重开 → 任务与执行记录仍在；归属校验（换 principal/session）仍拒', () => {
    const dbPath = tempDbPath();
    const first = createSqliteTaskRegistry(dbPath);
    first.begin({ taskId: 'task_1', principalId: 'wecom:u1', sessionId: 'wecom:c1', request: '查一下' });
    first.noteExecution('task_1', { requestId: 'req_1', operation: 'dummy.query', status: 'completed' });
    first.complete('task_1', '查到 2 条。');
    first.close();

    const second = createSqliteTaskRegistry(dbPath);
    const task = second.get('task_1', { principalId: 'wecom:u1', sessionId: 'wecom:c1' });
    expect(task.status).toBe('completed');
    expect(task.resultText).toBe('查到 2 条。');
    expect(task.createdAt).not.toBe('');
    expect(task.executions).toHaveLength(1);
    expect(task.executions[0]).toMatchObject({
      requestId: 'req_1',
      operation: 'dummy.query',
      status: 'completed',
    });

    // 越权与不存在同一拒绝形态（不泄漏存在性）。
    expect(() => second.get('task_1', { principalId: 'wecom:u2', sessionId: 'wecom:c1' })).toThrow(TaskOwnershipError);
    expect(() => second.get('task_1', { principalId: 'wecom:u1', sessionId: 'wecom:c2' })).toThrow(TaskOwnershipError);
    expect(() => second.get('task_absent', { principalId: 'wecom:u1', sessionId: 'wecom:c1' })).toThrow(TaskOwnershipError);
    second.close();
  });

  it('list 按 scope 隔离；失败任务保留 failureReason；执行失败记录保留 error', () => {
    const dbPath = tempDbPath();
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 'task_a', principalId: 'wecom:u1', sessionId: 'wecom:c1', request: '任务 A' });
    registry.noteExecution('task_a', {
      requestId: 'req_fail',
      operation: 'dummy.query',
      status: 'failed',
      error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' },
    });
    registry.fail('task_a', '执行层调用超时。');
    registry.begin({ taskId: 'task_b', principalId: 'wecom:u1', sessionId: 'wecom:c2', request: '任务 B' });

    const scoped = registry.list({ principalId: 'wecom:u1', sessionId: 'wecom:c1' });
    expect(scoped.map((task) => task.taskId)).toEqual(['task_a']);
    expect(scoped[0]!.failureReason).toBe('执行层调用超时。');
    expect(scoped[0]!.executions[0]!.error).toMatchObject({ code: 'EXECUTION_TIMEOUT' });

    const other = registry.list({ principalId: 'wecom:u1', sessionId: 'wecom:c2' });
    expect(other.map((task) => task.taskId)).toEqual(['task_b']);
    expect(registry.list()).toHaveLength(2);
    registry.close();
  });

  it('noteExecution / complete / fail 对不存在的任务抛 TaskOwnershipError', () => {
    const registry = createSqliteTaskRegistry(tempDbPath());
    expect(() => registry.noteExecution('task_x', { requestId: 'req_x', operation: 'dummy.query', status: 'completed' }))
      .toThrow(TaskOwnershipError);
    expect(() => registry.complete('task_x', '结果')).toThrow(TaskOwnershipError);
    expect(() => registry.fail('task_x', '原因')).toThrow(TaskOwnershipError);
    registry.close();
  });
});
