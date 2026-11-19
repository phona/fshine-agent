/**
 * U3 底账 v4 迁移（v3 → v4）：operations 表 + executions.dispatch_key。
 *
 * 迁移纪律（与 P1/P2a 同款，只做前向加法）：
 *   · 可写打开 v3 库 → 一次迁移：建 operations（IF NOT EXISTS）+ ADD COLUMN executions.dispatch_key，
 *     迁移前自动备份 <db>.backup-v4（内容 = 迁移前字节）；user_version 推进到 4；
 *   · 既有数据安全：tasks/executions 的历史列与行逐字节不变；历史执行行 dispatch_key = NULL
 *     （读出缺省，不伪造）；
 *   · 幂等：二次打开零差异、不新增备份；
 *   · 只读打开 v3 库：不建表、不加列、不改哈希，operations 读出缺省；
 *   · 唯一约束只表达身份：dispatch_key 主键 + UNIQUE(scope_key, op_seq)，没有内容唯一约束。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from './src/task-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-v4-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function seedV3Db(dbPath: string): void {
  const db = new Database(dbPath);
  // 与既有迁移测试同款：先固定 WAL，迁移前哈希才等于「迁移前字节」。
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE tasks (
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
      reply_text TEXT,
      reason TEXT,
      pending_question TEXT,
      waiting_since TEXT,
      lease_owner TEXT,
      lease_until TEXT
    );
    CREATE INDEX idx_tasks_scope ON tasks (principal_id, session_id);
    CREATE UNIQUE INDEX idx_tasks_no ON tasks (task_no) WHERE task_no IS NOT NULL;
    CREATE TABLE task_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE executions (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT
    );
    CREATE INDEX idx_executions_task ON executions (task_id);
  `);
  db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, status, result_text, failure_reason,
      created_at, updated_at, task_no, name, reply_text, reason, pending_question, waiting_since, lease_owner, lease_until)
    VALUES ('task_old', 'wecom:u', 'sess_old', '历史任务', 'completed', '历史结果', NULL,
      '2026-11-15T10:00:00.000Z', '2026-11-15T10:01:00.000Z', 1, '历史任务', '历史回复', NULL, NULL, NULL, NULL, NULL)
  `).run();
  db.prepare(`
    INSERT INTO executions (request_id, task_id, operation, status, error_json)
    VALUES ('req_old', 'task_old', 'dummy.query', 'completed', NULL)
  `).run();
  db.prepare("INSERT INTO task_sequences (name, value) VALUES ('task_no', 1)").run();
  db.pragma('user_version = 3');
  db.close();
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
  db.close();
  return columns;
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const version = db.pragma('user_version', { simple: true }) as number;
  db.close();
  return version;
}

function taskRows(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  // 只快照 V3 时代的旧列：预期契约切片只做**前向加法**（新列追加、历史值不改写），
  // 旧列数据必须逐字节不变（新列为 NULL 由 longRunningColumnsOf 单独断言）。
  const rows = db.prepare(`
    SELECT task_id, principal_id, session_id, request, status, result_text, failure_reason,
      created_at, updated_at, task_no, name, reply_text, reason, pending_question, waiting_since,
      lease_owner, lease_until
    FROM tasks ORDER BY task_id
  `).all();
  db.close();
  return rows;
}

/** 预期契约新增列的历史行取值（迁移后历史行必须为 NULL，不伪造）。 */
function longRunningColumnsOf(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    'SELECT long_running_notified_at, long_running_stuck_notified_at, running_since, wait_contact_lost_notified_at FROM tasks ORDER BY task_id',
  ).all();
  db.close();
  return rows;
}

function executionRows(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  // 只快照旧列：v4 只加 dispatch_key（新列为 NULL，不改写旧值）。
  const rows = db.prepare('SELECT request_id, task_id, operation, status, error_json FROM executions ORDER BY request_id').all();
  db.close();
  return rows;
}

describe('U3 v4 迁移（v3 → v4）', () => {
  it('建 operations / 加 dispatch_key / user_version=4 / 历史零改动 / 备份 .backup-v4；二次打开幂等', () => {
    const dbPath = tempDb();
    seedV3Db(dbPath);
    const preMigrationSha = sha256(dbPath);
    const beforeTasks = taskRows(dbPath);
    const beforeExecutions = executionRows(dbPath);
    const beforeTaskColumns = tableColumns(dbPath, 'tasks');

    const store = openTaskStore(dbPath);

    expect(tableColumns(dbPath, 'operations')).toEqual(expect.arrayContaining([
      'dispatch_key', 'scope_key', 'task_id', 'op_seq', 'operation', 'status', 'reason',
      'outcome_json', 'attempt', 'claimed_at', 'settled_at', 'delivered_at', 'replay_of',
    ]));
    expect(tableColumns(dbPath, 'executions')).toContain('dispatch_key');
    expect(userVersion(dbPath)).toBe(4);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(4);

    // 既有数据安全：历史列与行逐字节不变；历史执行行 dispatch_key 读出缺省（不伪造）。
    // 预期契约（2026-11-18）：两列只做前向加法（追加在末尾），历史列顺序不变。
    const afterTaskColumns = tableColumns(dbPath, 'tasks');
    expect(afterTaskColumns.slice(0, beforeTaskColumns.length)).toEqual(beforeTaskColumns);
    expect(afterTaskColumns.slice(beforeTaskColumns.length)).toEqual([
      'long_running_notified_at',
      'long_running_stuck_notified_at',
      // 2026-11-19：本轮开始运行时刻（长任务受理后清租约，提醒扫描需要独立起点）。
      'running_since',
      // 2026-11-19：长任务等待「断联系」档的已告知时刻（同一「每档至多一次」口径）。
      'wait_contact_lost_notified_at',
    ]);
    expect(taskRows(dbPath)).toEqual(beforeTasks);
    expect(longRunningColumnsOf(dbPath)).toEqual([
      // 历史行不伪造：四列都是 NULL（running_since 与「断联系」档也一样）。
      {
        long_running_notified_at: null,
        long_running_stuck_notified_at: null,
        running_since: null,
        wait_contact_lost_notified_at: null,
      },
    ]);
    const stored = store.getTask('task_old')!;
    expect(stored.task.request).toBe('历史任务');
    expect(stored.executions).toHaveLength(1);
    expect(stored.executions[0]!.dispatchKey).toBeUndefined();

    const backupPath = `${dbPath}.backup-v4`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);

    // 新账可写：铸造两笔同名操作 = 两行两 key（无内容唯一约束）。
    const first = store.mintOperation({ scopeKey: 'task:task_old', operation: 'dummy.commit', attempt: 1, now: '2026-11-16T00:00:00.000Z' });
    const second = store.mintOperation({ scopeKey: 'task:task_old', operation: 'dummy.commit', attempt: 1, now: '2026-11-16T00:00:00.000Z' });
    expect(first.dispatchKey).not.toBe(second.dispatchKey);
    expect([first.opSeq, second.opSeq]).toEqual([1, 2]);
    store.close();

    // 幂等：第二次打开零差异、不新增备份、历史行不变。
    const second_open = openTaskStore(dbPath);
    expect(taskRows(dbPath)).toEqual(beforeTasks);
    expect(executionRows(dbPath)).toEqual(beforeExecutions);
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);
    expect(userVersion(dbPath)).toBe(4);
    second_open.close();
  });

  it('唯一约束只表达身份：同 (scope_key, op_seq) 第二行被拒；无 args/内容列', () => {
    const dbPath = tempDb();
    seedV3Db(dbPath);
    const store = openTaskStore(dbPath);
    const row = store.mintOperation({ scopeKey: 'task:task_old', operation: 'dummy.commit', attempt: 1, now: '2026-11-16T00:00:00.000Z' });
    store.close();

    const db = new Database(dbPath);
    const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get() as { sql: string }).sql;
    db.close();
    expect(schema).toMatch(/UNIQUE \(scope_key, op_seq\)/);
    expect(schema).not.toMatch(/\bargs\b/);

    const raw = new Database(dbPath);
    expect(() => raw.prepare(`
      INSERT INTO operations (dispatch_key, scope_key, task_id, op_seq, operation, status, reason, outcome_json,
        attempt, claimed_at, settled_at, delivered_at, replay_of)
      VALUES ('dk_duplicate', @scopeKey, NULL, @opSeq, 'dummy.commit', 'claimed', NULL, NULL, 1,
        '2026-11-16T00:00:00.000Z', NULL, NULL, NULL)
    `).run({ scopeKey: row.scopeKey, opSeq: row.opSeq })).toThrow(/UNIQUE/);
    raw.close();
  });

  it('只读打开 v3 库：不迁移、不建 operations、哈希不变；账读出缺省', () => {
    const dbPath = tempDb();
    seedV3Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getOperation('dk_task:task_old:1')).toBeUndefined();
    expect(store.getTask('task_old')!.task.request).toBe('历史任务');
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(existsSync(`${dbPath}.backup-v4`)).toBe(false);
    const db = new Database(dbPath, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((entry) => entry.name);
    db.close();
    expect(tables).not.toContain('operations');
    expect(tableColumns(dbPath, 'executions')).not.toContain('dispatch_key');
  });
});
