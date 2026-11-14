/**
 * P2a 底账 v3 版本化迁移（reason / pending_question / waiting_since / lease_owner / lease_until）。
 *
 * 覆盖（r4-joint-interfaces.md §1 v3 迁移列 + 既有 P1 迁移纪律）：
 *   · v2 库（P1 schema）首次可写打开 → 一次版本化迁移：补 5 列、user_version=3、
 *     历史行与旧字段零改动、迁移前自动备份 <db>.backup-v3（内容=迁移前字节）；
 *   · v1 库（更早 schema）→ 一次打开直接补 8 列（P1+P2），task_no 仍按
 *     (created_at, task_id) 升序连续回填，name/reply_text 保持 NULL（不伪造）；
 *   · 迁移幂等：二次打开零差异、不新增备份、不重写历史；
 *   · 只读打开永不迁移：不加列、不建备份、主库哈希不变；新列读出缺省（不崩溃）；
 *   · 新库直接建 v3（无备份、user_version=3）；
 *   · applyTaskState 单语句写状态/原因/pending_question JSON/等待时间/租约；
 *     expectedStatus 不匹配拒绝写入（乐观并发）。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from './src/task-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-v3-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** v2（P1）schema 原文：迁移前的目标基线。 */
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  result_text TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_no INTEGER,
  name TEXT,
  reply_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks (principal_id, session_id);
CREATE TABLE IF NOT EXISTS task_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_no ON tasks (task_no) WHERE task_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS executions (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions (task_id);
`;

/** v1（P1 之前）schema 原文（历史基线，自 P1 迁移测试原样复制）。 */
const V1_SCHEMA = `
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

function seedV2Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V2_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (
      task_id, principal_id, session_id, request, status, result_text, failure_reason,
      created_at, updated_at, task_no, name, reply_text
    ) VALUES (
      @taskId, @principalId, @sessionId, @request, @status, @resultText, @failureReason,
      @createdAt, @updatedAt, @taskNo, @name, @replyText
    )
  `);
  const rows = [
    {
      taskId: 'task_a', status: 'completed', resultText: '历史回复 A。', failureReason: null,
      createdAt: '2026-11-14T08:00:00.000Z', taskNo: 1, name: '历史任务 A', replyText: '历史最终回复 A。',
    },
    {
      taskId: 'task_b', status: 'failed', resultText: '历史回复 B。', failureReason: '执行层未成功。',
      createdAt: '2026-11-14T09:00:00.000Z', taskNo: 2, name: '历史任务 B', replyText: null,
    },
  ] as const;
  for (const row of rows) {
    insert.run({
      taskId: row.taskId,
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-v2',
      request: `历史请求 ${row.taskId}`,
      status: row.status,
      resultText: row.resultText,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      taskNo: row.taskNo,
      name: row.name,
      replyText: row.replyText,
    });
  }
  db.prepare("INSERT INTO executions (request_id, task_id, operation, status, error_json) VALUES (?, ?, ?, ?, ?)")
    .run('req_v2_a', 'task_a', 'dummy.query', 'completed', null);
  db.prepare("INSERT INTO task_sequences (name, value) VALUES ('task_no', 2)").run();
  db.pragma('user_version = 2');
  db.close();
}

function seedV1Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V1_SCHEMA);
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
      sessionId: 'ask-v1',
      request: row.request,
      status: row.status,
      resultText: row.resultText,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
  }
  db.prepare('INSERT INTO executions (request_id, task_id, operation, status, error_json) VALUES (?, ?, ?, ?, ?)')
    .run('req_a', 'task_a', 'dummy.query', 'completed', null);
  db.close();
}

/**
 * 旧字段快照（迁移不得改写旧列与执行记录；user_version 除外——迁移正是要推进它）。
 * taskIds 给出时只快照这些行的旧列（用于新增任务后对历史行逐一核账）。
 */
function priorColumnsSnapshot(dbPath: string, columns: readonly string[], taskIds?: readonly string[]): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    const filter = taskIds === undefined ? '' : `WHERE task_id IN (${taskIds.map(() => '?').join(', ')})`;
    return {
      tasks: db.prepare(`SELECT ${columns.join(', ')} FROM tasks ${filter} ORDER BY task_id`).all(...(taskIds ?? [])),
      executions: db.prepare('SELECT request_id, task_id, operation, status, error_json FROM executions ORDER BY request_id').all(),
    };
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

const V2_SCHEMA_COLUMNS = [
  'task_id', 'principal_id', 'session_id', 'request', 'status', 'result_text', 'failure_reason',
  'created_at', 'updated_at', 'task_no', 'name', 'reply_text',
] as const;

const V1_SCHEMA_COLUMNS = [
  'task_id', 'principal_id', 'session_id', 'request', 'status', 'result_text', 'failure_reason',
  'created_at', 'updated_at',
] as const;

const V3_COLUMNS = ['reason', 'pending_question', 'waiting_since', 'lease_owner', 'lease_until'] as const;

describe('P2a v3 迁移（v2 → v3）', () => {
  it('补 5 列、user_version=3、历史零改动、备份 .backup-v3；二次打开幂等', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV2Db(dbPath);
    const preMigrationSha = sha256(dbPath);
    const before = priorColumnsSnapshot(dbPath, V2_SCHEMA_COLUMNS);

    const store = openTaskStore(dbPath);
    expect(columnNames(dbPath)).toEqual(expect.arrayContaining([...V3_COLUMNS]));
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(3);
    // 历史行（含 task_no/name/reply_text 与执行记录）逐字节不变。
    expect(priorColumnsSnapshot(dbPath, V2_SCHEMA_COLUMNS)).toEqual(before);
    // 迁移前自动备份：内容 = 迁移前字节；命名跟随迁移目标版本。
    const backupPath = `${dbPath}.backup-v3`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);

    // 新任务编号从历史最大值接续（不重号）。
    const inserted = store.insertTask({
      taskId: 'task_new',
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-v3',
      request: '新任务',
      status: 'running',
      createdAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
    });
    expect(inserted.taskNo).toBe(3);
    store.close();

    // 幂等：第二次打开零差异、不新增备份、不重复迁移（新任务行合法新增，历史行逐列不变）。
    const second = openTaskStore(dbPath);
    expect(second.listTasks().map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([['task_a', 1], ['task_b', 2], ['task_new', 3]]);
    second.close();
    expect(priorColumnsSnapshot(dbPath, V2_SCHEMA_COLUMNS, ['task_a', 'task_b'])).toEqual(before);
    expect(backupFiles(dir)).toEqual(['state.db.backup-v3']);
    expect(sha256(backupPath)).toBe(preMigrationSha);
  });

  it('迁移后 v3 列缺省读出为 undefined（不伪造）', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV2Db(dbPath);
    const store = openTaskStore(dbPath);
    const stored = store.getTask('task_a')!;
    expect(stored.task.reason).toBeUndefined();
    expect(stored.task.pendingQuestion).toBeUndefined();
    expect(stored.task.waitingSince).toBeUndefined();
    expect(stored.task.leaseOwner).toBeUndefined();
    expect(stored.task.leaseUntil).toBeUndefined();
    store.close();
  });
});

describe('P2a v3 迁移（v1 → v3 一次补齐）', () => {
  it('8 列一次补齐；task_no 回填规则保持；旧字段零改动；单备份 .backup-v3', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV1Db(dbPath);
    const preMigrationSha = sha256(dbPath);
    const before = priorColumnsSnapshot(dbPath, V1_SCHEMA_COLUMNS);

    const store = openTaskStore(dbPath);
    expect(columnNames(dbPath)).toEqual(expect.arrayContaining([...V3_COLUMNS, 'task_no', 'name', 'reply_text']));
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    const tasks = store.listTasks();
    // 回填顺序：created_at 升序，同刻按 task_id 升序（a < c），编号 1..n 连续唯一。
    expect(tasks.map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([['task_a', 1], ['task_c', 2], ['task_b', 3]]);
    expect(tasks.map((stored) => stored.task.replyText)).toEqual([undefined, undefined, undefined]);
    expect(tasks.map((stored) => stored.task.name)).toEqual([undefined, undefined, undefined]);
    expect(tasks.map((stored) => stored.task.reason)).toEqual([undefined, undefined, undefined]);

    expect(priorColumnsSnapshot(dbPath, V1_SCHEMA_COLUMNS)).toEqual(before);
    expect(backupFiles(dir)).toEqual(['state.db.backup-v3']);
    expect(sha256(`${dbPath}.backup-v3`)).toBe(preMigrationSha);
    store.close();
  });
});

describe('P2a 只读打开不迁移（向前兼容）', () => {
  it('v2 库只读：不加列、不建备份、哈希不变；新列读出缺省', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV2Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    const stored = store.getTask('task_a')!;
    expect(stored.task.request).toBe('历史请求 task_a');
    expect(stored.task.taskNo).toBe(1);
    expect(stored.task.replyText).toBe('历史最终回复 A。');
    expect(stored.task.reason).toBeUndefined();
    expect(stored.task.pendingQuestion).toBeUndefined();
    expect(stored.executions).toHaveLength(1);
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath)).not.toContain('reason');
    expect(existsSync(`${dbPath}.backup-v3`)).toBe(false);
  });

  it('v1 库只读：不加列、不建备份、哈希不变；新旧列读出缺省', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV1Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    const stored = store.getTask('task_a')!;
    expect(stored.task.taskNo).toBeUndefined();
    expect(stored.task.reason).toBeUndefined();
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath)).not.toContain('reason');
    expect(existsSync(`${dbPath}.backup-v3`)).toBe(false);
  });
});

describe('P2a 新库与单语句状态写入', () => {
  it('新库直接建 v3：列齐、无备份、user_version=3', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'fresh.db');
    const store = openTaskStore(dbPath);
    expect(columnNames(dbPath)).toEqual(expect.arrayContaining([...V3_COLUMNS]));
    store.close();
    expect(userVersion(dbPath)).toBe(3);
    expect(backupFiles(dir)).toEqual([]);
  });

  it('applyTaskState：单语句写入 reason/pending_question JSON/waiting_since/lease；expectedStatus 不匹配拒绝', () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const store = openTaskStore(dbPath);
    store.insertTask({
      taskId: 'task_state',
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-v3',
      request: '状态写入',
      status: 'running',
      createdAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
    });

    const applied = store.applyTaskState('task_state', {
      expectedStatus: 'running',
      status: 'waiting_user',
      reason: null,
      resultText: null,
      failureReason: null,
      pendingQuestion: { missing: ['时间范围'], candidates: ['本月'] },
      waitingSince: '2026-11-14T10:01:00.000Z',
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: '2026-11-14T10:01:00.000Z',
    });
    expect(applied).toBe(true);
    const waiting = store.getTask('task_state')!.task;
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.pendingQuestion).toEqual({ missing: ['时间范围'], candidates: ['本月'] });
    expect(waiting.waitingSince).toBe('2026-11-14T10:01:00.000Z');

    // 乐观并发：期望状态已不匹配 → 拒绝写入（零变化）。
    expect(store.applyTaskState('task_state', {
      expectedStatus: 'running',
      status: 'cancelled',
      updatedAt: '2026-11-14T10:02:00.000Z',
    })).toBe(false);
    expect(store.getTask('task_state')!.task.status).toBe('waiting_user');

    // 恢复续跑：清空等待形状（NULL），写机械原因。
    expect(store.applyTaskState('task_state', {
      expectedStatus: 'waiting_user',
      status: 'failed',
      reason: 'result_unknown',
      resultText: null,
      failureReason: '重启后无法确认结果。',
      pendingQuestion: null,
      waitingSince: null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: '2026-11-14T10:03:00.000Z',
    })).toBe(true);
    const failed = store.getTask('task_state')!.task;
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('result_unknown');
    expect(failed.failureReason).toBe('重启后无法确认结果。');
    expect(failed.pendingQuestion).toBeUndefined();
    expect(failed.waitingSince).toBeUndefined();
    store.close();
  });
});
