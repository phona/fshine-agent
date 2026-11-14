/**
 * P1 底账演化：版本化迁移（P1-T01）与数字编号原子分配（P1-T02）/只读哈希不变（P1-T05）。
 *
 * 覆盖（r4-acceptance.md P1-T01/T02/T05）：
 *   · 旧版 schema 库（含历史任务与执行记录）首次以新版本打开 → 一次版本化迁移：
 *     加列 task_no/name/reply_text；历史行按 (created_at, task_id) 升序回填 task_no（唯一、
 *     连续）；reply_text/name 保持 NULL（历史无存档，不伪造）；旧字段逐字节不变；
 *     迁移前自动备份副本 <db>.backup-v2（内容=迁移前字节）；user_version 记录 schema 版本；
 *   · 迁移幂等：第二次打开零差异、不新增备份、不重写历史；
 *   · 新库：直接建 v2 schema，无备份，首行编号从 1 起；
 *   · 分配：同进程多连接交错插入 → 编号唯一、连续、按分配序；失败（重复 taskId）不占号；
 *     编号一经分配不回退（complete/fail/回复存档后不变）；迁移历史库后新任务从历史最大值接续；
 *   · 向前兼容：旧版库只读打开可读、不迁移、不建备份、主库哈希不变；新列读出为缺省（不崩溃）。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from './src/task-store';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-p1-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 迁移前的旧版 schema（P1 之前的 task-store.ts SCHEMA 原文，测试内固定为历史基线）。 */
const PRIOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  result_text TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks (principal_id, session_id);
CREATE TABLE IF NOT EXISTS executions (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions (task_id);
`;

/** 造旧版库：3 条历史任务（含同一 created_at 的并列项，钉住 task_id 升序稳定回填）+ 1 条执行记录。 */
function seedPriorSchemaDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(PRIOR_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, status, result_text, failure_reason, created_at, updated_at)
    VALUES (@taskId, @principalId, @sessionId, @request, @status, @resultText, @failureReason, @createdAt, @updatedAt)
  `);
  const rows = [
    { taskId: 'task_c', request: '历史任务 C：查 beta 汇总', status: 'completed', resultText: '历史汇报 C。', failureReason: null, createdAt: '2026-11-13T16:00:00.000Z' },
    { taskId: 'task_a', request: '历史任务 A：查 alpha 明细', status: 'completed', resultText: '历史汇报 A。', failureReason: null, createdAt: '2026-11-13T16:00:00.000Z' },
    { taskId: 'task_b', request: '历史任务 B：查 gamma 口径', status: 'failed', resultText: '历史汇报 B。', failureReason: '执行层未成功：dummy.query 返回 failed。', createdAt: '2026-11-13T17:00:00.000Z' },
  ] as const;
  for (const row of rows) {
    insert.run({
      taskId: row.taskId,
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-prior',
      request: row.request,
      status: row.status,
      resultText: row.resultText,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
  }
  db.prepare('INSERT INTO executions (request_id, task_id, operation, status, error_json) VALUES (?, ?, ?, ?, ?)')
    .run('req_prior_a', 'task_a', 'dummy.query', 'completed', null);
  db.prepare('INSERT INTO executions (request_id, task_id, operation, status, error_json) VALUES (?, ?, ?, ?, ?)')
    .run('req_prior_c', 'task_c', 'dummy.query', 'completed', null);
  db.close();
}

/** 只读快照：全部旧字段（迁移不得改写）+ 执行记录（迁移不得改写）。 */
function priorSchemaSnapshot(dbPath: string): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      tasks: db.prepare(`
        SELECT task_id, principal_id, session_id, request, status, result_text, failure_reason, created_at, updated_at
        FROM tasks ORDER BY task_id
      `).all(),
      executions: db.prepare(`
        SELECT request_id, task_id, operation, status, error_json
        FROM executions ORDER BY request_id
      `).all(),
    };
  } finally {
    db.close();
  }
}

function rawTaskColumns(dbPath: string): Array<{ task_no: unknown; name: unknown; reply_text: unknown }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT task_no, name, reply_text FROM tasks ORDER BY created_at, task_id').all() as Array<{
      task_no: unknown; name: unknown; reply_text: unknown;
    }>;
  } finally {
    db.close();
  }
}

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.backup-'));
}

function row(overrides: { taskId: string; createdAt: string }) {
  return {
    taskId: overrides.taskId,
    principalId: 'wecom:fixture-user',
    sessionId: 'ask-p1',
    request: `查 ${overrides.taskId}`,
    status: 'running',
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  } as const;
}

describe('P1-T01 迁移幂等与回填', () => {
  it('旧库首次打开：加列/按 (created_at, task_id) 回填编号/历史回复保持 NULL/旧字段零改动/备份+版本登记', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedPriorSchemaDb(dbPath);
    const preMigrationSha = sha256(dbPath);
    const before = priorSchemaSnapshot(dbPath);

    const store = openTaskStore(dbPath);
    const tasks = store.listTasks();
    // 回填顺序：created_at 升序，同刻按 task_id 升序（a < c），编号 1..n 连续唯一。
    expect(tasks.map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([['task_a', 1], ['task_c', 2], ['task_b', 3]]);
    // 历史行没有最终回复/名称为 NULL（不伪造、不用执行层汇报冒充）。
    expect(tasks.map((stored) => stored.task.replyText)).toEqual([undefined, undefined, undefined]);
    expect(tasks.map((stored) => stored.task.name)).toEqual([undefined, undefined, undefined]);
    // 执行记录与旧字段逐字节不变。
    expect(priorSchemaSnapshot(dbPath)).toEqual(before);

    // 列已存在；user_version 记迁移版本。
    expect(columnNames(dbPath)).toEqual(expect.arrayContaining(['task_no', 'name', 'reply_text']));
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);

    // 迁移前自动备份副本：内容=迁移前字节；不覆盖、不删除。
    const backupPath = `${dbPath}.backup-v2`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);
    store.close();

    // 幂等：第二次打开零差异、不新增备份、不重复回填。
    const second = openTaskStore(dbPath);
    expect(second.listTasks().map((stored) => stored.task.taskNo)).toEqual([1, 2, 3]);
    expect(priorSchemaSnapshot(dbPath)).toEqual(before);
    expect(rawTaskColumns(dbPath)).toEqual([
      { task_no: 1, name: null, reply_text: null },
      { task_no: 2, name: null, reply_text: null },
      { task_no: 3, name: null, reply_text: null },
    ]);
    second.close();
    expect(backupFiles(dir)).toEqual(['state.db.backup-v2']);
    expect(sha256(`${dbPath}.backup-v2`)).toBe(preMigrationSha);
  });

  it('新库：直接建新 schema（无备份），首行编号从 1 起；user_version 记录版本', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'fresh.db');
    const store = openTaskStore(dbPath);
    const first = store.insertTask({ ...row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:00.000Z' }), name: '查 task_1' });
    const second = store.insertTask(row({ taskId: 'task_2', createdAt: '2026-11-14T09:01:00.000Z' }));
    expect(first.taskNo).toBe(1);
    expect(second.taskNo).toBe(2);
    store.close();

    expect(existsSync(`${dbPath}.backup-v2`)).toBe(false);
    expect(backupFiles(dir)).toEqual([]);
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(columnNames(dbPath)).toEqual(expect.arrayContaining(['task_no', 'name', 'reply_text']));
  });
});

describe('P1-T02 并发分配与不复用', () => {
  it('同进程多连接交错插入：编号唯一、连续、按分配序', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const first = openTaskStore(dbPath);
    const second = openTaskStore(dbPath);
    const t1 = first.insertTask(row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:00.000Z' }));
    const t2 = second.insertTask(row({ taskId: 'task_2', createdAt: '2026-11-14T09:00:01.000Z' }));
    const t3 = first.insertTask(row({ taskId: 'task_3', createdAt: '2026-11-14T09:00:02.000Z' }));
    expect([t1.taskNo, t2.taskNo, t3.taskNo]).toEqual([1, 2, 3]);
    first.close();
    second.close();
  });

  it('失败不占号：重复 taskId 插入失败后，下一编号接续（不跳号、不回退）', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const store = openTaskStore(dbPath);
    expect(store.insertTask(row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:00.000Z' })).taskNo).toBe(1);
    expect(() => store.insertTask(row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:01.000Z' }))).toThrow();
    expect(store.insertTask(row({ taskId: 'task_2', createdAt: '2026-11-14T09:00:02.000Z' })).taskNo).toBe(2);
    store.close();
  });

  it('编号不回退：complete/fail/回复存档后 task_no 不变；后续插入继续递增', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const store = openTaskStore(dbPath);
    store.insertTask(row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:00.000Z' }));
    store.insertTask(row({ taskId: 'task_2', createdAt: '2026-11-14T09:00:01.000Z' }));
    store.setTaskOutcome('task_1', { status: 'completed', resultText: '汇报。', updatedAt: '2026-11-14T09:00:02.000Z' });
    store.setTaskOutcome('task_2', { status: 'failed', failureReason: '故障。', updatedAt: '2026-11-14T09:00:03.000Z' });
    store.setReplyForTasks(['task_1', 'task_2'], '本回合最终回复。', '2026-11-14T09:00:04.000Z');

    expect(store.getTask('task_1')!.task.taskNo).toBe(1);
    expect(store.getTask('task_2')!.task.taskNo).toBe(2);
    expect(store.getTask('task_1')!.task.replyText).toBe('本回合最终回复。');
    expect(store.getTask('task_2')!.task.replyText).toBe('本回合最终回复。');
    expect(store.insertTask(row({ taskId: 'task_3', createdAt: '2026-11-14T09:00:05.000Z' })).taskNo).toBe(3);
    store.close();
  });

  it('迁移历史库后新任务接续历史最大编号（不重号、不从 1 重启）', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedPriorSchemaDb(dbPath);
    const store = openTaskStore(dbPath);
    expect(store.insertTask(row({ taskId: 'task_new_1', createdAt: '2026-11-14T10:00:00.000Z' })).taskNo).toBe(4);
    expect(store.insertTask(row({ taskId: 'task_new_2', createdAt: '2026-11-14T10:00:01.000Z' })).taskNo).toBe(5);
    store.close();
  });

  it('编号不复用（模拟删除后重分配）：删除编号行后新任务继续递增、存量编号不重排', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const store = openTaskStore(dbPath);
    store.insertTask(row({ taskId: 'task_1', createdAt: '2026-11-14T09:00:00.000Z' }));
    store.insertTask(row({ taskId: 'task_2', createdAt: '2026-11-14T09:00:01.000Z' }));
    store.insertTask(row({ taskId: 'task_3', createdAt: '2026-11-14T09:00:02.000Z' }));

    // 产品无删除路径；直接删库内行以钉住「不复用/不重排」语义
    // （模拟运维清理/数据修剪后重分配：编号不得回收、存量编号不得改写）。
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM tasks WHERE task_id = ?').run('task_3');
    raw.prepare('DELETE FROM tasks WHERE task_id = ?').run('task_1');
    raw.close();

    // 存量行编号保持原值（不重排）。
    expect(store.listTasks().map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([['task_2', 2]]);
    // 新任务不回收已用编号（3 已分配过 → 下一条是 4）。
    expect(store.insertTask(row({ taskId: 'task_4', createdAt: '2026-11-14T09:00:04.000Z' })).taskNo).toBe(4);
    store.close();

    // 计数器跨重启保持（重开库后继续 5）。
    const reopened = openTaskStore(dbPath);
    expect(reopened.insertTask(row({ taskId: 'task_5', createdAt: '2026-11-14T09:00:05.000Z' })).taskNo).toBe(5);
    reopened.close();
  });

  it('跨进程并发：4 个进程各写 10 条 → 编号唯一且连续 1..40（含跨进程写入）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    // 先建库（首写者完成建表迁移），再让 4 个进程并发写入同一库。
    openTaskStore(dbPath).close();

    const child = (index: number) => spawn(
      process.execPath,
      ['--import', 'tsx', path.join(REPO_ROOT, 'tests', 'p1-concurrent-writer.ts'), dbPath, '10', `w${index}`],
      { cwd: REPO_ROOT, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const results = await Promise.all([1, 2, 3, 4].map((index) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const process_ = child(index);
      let stderr = '';
      process_.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      process_.on('exit', (code) => resolve({ code, stderr }));
    })));
    for (const result of results) expect(result.code, result.stderr).toBe(0);

    const store = openTaskStore(dbPath, { readOnly: true });
    const numbers = store.listTasks().map((stored) => stored.task.taskNo).sort((left, right) => (left ?? 0) - (right ?? 0));
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    store.close();
  }, 30_000);
});

describe('P1-T05 只读路径哈希不变（向前兼容）', () => {
  it('旧库只读打开：可读、不迁移、不建备份、主库哈希不变；新列读出为缺省', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedPriorSchemaDb(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    const stored = store.getTask('task_a')!;
    expect(stored.task.request).toBe('历史任务 A：查 alpha 明细');
    expect(stored.task.taskNo).toBeUndefined();
    expect(stored.task.name).toBeUndefined();
    expect(stored.task.replyText).toBeUndefined();
    expect(stored.executions).toHaveLength(1);
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath)).not.toContain('task_no');
    expect(existsSync(`${dbPath}.backup-v2`)).toBe(false);
  });

  it('迁移后只读打开：新字段可读、主库哈希不变', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedPriorSchemaDb(dbPath);
    openTaskStore(dbPath).close();
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    const stored = store.getTask('task_a')!;
    expect(stored.task.taskNo).toBe(1);
    expect(stored.task.replyText).toBeUndefined();
    store.close();

    expect(sha256(dbPath)).toBe(before);
  });
});
