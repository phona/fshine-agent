/**
 * 任务底账的只读打开（P1 任务查看切片）。
 *
 * 为什么需要：查看命令只能在既有底账上读——不得写入、不得加锁、不得在库不存在时
 * 顺手建库。这里把只读打开的四条保证钉住（TDD：先红后绿）：
 *   ① 读回普通路径写入的任务与执行记录，scope 过滤与越权拒绝不变；
 *   ② 写路径被 SQLite 拒绝（SQLITE_READONLY），且主库文件哈希前后不变；
 *   ③ 库文件不存在：只读打开必须失败，且不创建文件 / 父目录；
 *   ④ 不锁写：只读连接打开期间普通注册表仍可提交，只读侧随后可见。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskOwnershipError } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-registry-readonly-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scope = { principalId: 'wecom:fixture-user', sessionId: 'ask-2026-11-14' };

describe('任务底账只读打开（P1 任务查看）', () => {
  it('① 只读读回普通写入的任务与执行记录；scope 过滤与越权拒绝不变', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const writer = createSqliteTaskRegistry(dbPath);
    writer.begin({ taskId: 'task_a', ...scope, request: '查 beta' });
    writer.noteExecution('task_a', { requestId: 'req_1', operation: 'dummy.query', status: 'completed' });
    writer.complete('task_a', '已查询 beta：3 条。');
    writer.begin({ taskId: 'task_b', principalId: 'wecom:other', sessionId: 'ask-x', request: '查 alpha' });
    writer.close();

    const reader = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(reader.list().map((task) => task.taskId)).toEqual(['task_a', 'task_b']);

    const task = reader.get('task_a', scope);
    expect(task.status).toBe('completed');
    expect(task.resultText).toBe('已查询 beta：3 条。');
    expect(task.executions).toHaveLength(1);
    expect(task.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });

    expect(reader.list(scope).map((task) => task.taskId)).toEqual(['task_a']);
    expect(() => reader.get('task_a', { principalId: 'wecom:other', sessionId: 'ask-x' })).toThrow(TaskOwnershipError);
    reader.close();
  });

  it('② 写路径被 SQLite 拒绝；主库文件哈希前后不变', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const writer = createSqliteTaskRegistry(dbPath);
    writer.begin({ taskId: 'task_a', ...scope, request: '查 beta' });
    writer.noteExecution('task_a', { requestId: 'req_1', operation: 'dummy.query', status: 'completed' });
    // P2a 状态机起效后终态不可再写（非法转换在存储前确定性拒绝），故这里保留 running
    // 让 complete/fail 走合法边、由 SQLite 只读连接拒绝——本用例的判据仍是「写路径被拒 + 哈希不变」。
    writer.close();

    const before = sha256(dbPath);
    const reader = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(() => reader.begin({ taskId: 'task_x', ...scope, request: '写' })).toThrow(/readonly/i);
    expect(() => reader.noteExecution('task_a', {
      requestId: 'req_x', operation: 'dummy.query', status: 'completed',
    })).toThrow(/readonly/i);
    expect(() => reader.complete('task_a', '改')).toThrow(/readonly/i);
    expect(() => reader.fail('task_a', '改')).toThrow(/readonly/i);
    reader.close();

    expect(sha256(dbPath)).toBe(before);
  });

  it('③ 库文件不存在：只读打开失败，且不创建文件 / 父目录', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'nested', 'state.db');
    expect(() => createSqliteTaskRegistry(missing, { readOnly: true })).toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(path.dirname(missing))).toBe(false);
  });

  it('④ 不锁写：只读连接打开期间普通注册表仍可提交，且只读侧随后可见', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const setup = createSqliteTaskRegistry(dbPath);
    setup.begin({ taskId: 'task_a', ...scope, request: '查 beta' });
    setup.complete('task_a', '已查询。');
    setup.close();

    const reader = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(reader.list()).toHaveLength(1);

    const writer = createSqliteTaskRegistry(dbPath);
    writer.begin({ taskId: 'task_b', ...scope, request: '查 alpha' });
    writer.complete('task_b', '已查询。');
    writer.close();

    expect(reader.list().map((task) => task.taskId)).toEqual(['task_a', 'task_b']);
    reader.close();
  });
});
