/**
 * 事实账迁移（v4/v5/v6 → 只存事实 + 无种类结束事实账）。
 *
 * 口径（task-store.ts 头注）：
 *   · 触发 = 可写打开且 tasks 仍是旧形状（带 status 结论列或六个终态列，v5 及更早）→ 重建
 *     为只存事实的形状；
 *   · v6 = tasks 表重建：删 status/reason/failure_reason + died/cancelled/timed_out/
 *     resource_limited/round_failed/cancel_requested 六列；**只留事实列**；
 *   · v7 = 旧 task_events（带终止种类 kind）→ task_ends：**只保留「停下时刻」，种类丢弃**；
 *   · 只把**升级前已停下**的旧行当已结束：running_since 按 updated_at 回填（不再被认领），
 *     已停行写一条无种类结束事实（at = 旧终态列原时刻 / 旧 status 非在跑 / 已有汇报，
 *     否则回退 updated_at）；仍在等待或旧 status=running/cancelling 的行不写结束事实；
 *   · 迁移前自动备份 <db>.backup-v<目标版本>（内容 = 迁移前字节；不覆盖、不自动删除）；
 *   · 回填 task_no / 计数器单调不减 / 幂等（二次打开零差异、不新增备份）；
 *   · 只读打开永不迁移：旧列仍在、不建备份、主库哈希不变。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore, storedTaskProgressOf } from './src/task-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-migration-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** v4-shape schema（P2a 时代：带结论列 + fact 列，无终态时刻列）。 */
const V4_SCHEMA = `
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
`;

/** v5-shape schema（S1 事实模型：带六个终态/取消请求列）。 */
const V5_SCHEMA = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  result_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_no INTEGER,
  name TEXT,
  reply_text TEXT,
  pending_question TEXT,
  waiting_since TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  died_at TEXT,
  cancelled_at TEXT,
  timed_out_at TEXT,
  resource_limited_at TEXT,
  cancel_requested_at TEXT,
  long_running_notified_at TEXT,
  running_since TEXT,
  round_failed_at TEXT,
  wait_contact_lost_notified_at TEXT
);
CREATE INDEX idx_tasks_scope ON tasks (principal_id, session_id);
CREATE UNIQUE INDEX idx_tasks_no ON tasks (task_no) WHERE task_no IS NOT NULL;
CREATE TABLE task_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE executions (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT,
  dispatch_key TEXT
);
CREATE INDEX idx_executions_task ON executions (task_id);
`;

/** v6-shape 结束事实账（带终止种类 kind —— v7 必须丢掉）。 */
const V6_TASK_EVENTS_SCHEMA = `
CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  state_version TEXT NOT NULL,
  UNIQUE (task_id, kind, state_version)
);
CREATE INDEX idx_task_events_task ON task_events (task_id, seq);
`;

interface SeedRow {
  taskId: string;
  status: string;
  resultText: string | null;
  updatedAt: string;
  taskNo: number;
  name: string;
  replyText: string | null;
  /** 旧机械原因（result_unknown 等；缺省 null）。 */
  reason: string | null;
  /** waiting_user 的提问（迁移后必须保留，用户还能接续）。 */
  pendingQuestion?: string;
  waitingSince?: string;
}

const V4_SEED: readonly SeedRow[] = [
  { taskId: 'task_done', status: 'completed', resultText: '历史汇报 A。', updatedAt: '2026-11-14T08:00:00.000Z', taskNo: 1, name: '历史 A', replyText: '历史最终回复 A。', reason: null },
  { taskId: 'task_cancel', status: 'cancelled', resultText: null, updatedAt: '2026-11-14T08:30:00.000Z', taskNo: 2, name: '历史 B', replyText: null, reason: null },
  { taskId: 'task_timeout', status: 'timed_out', resultText: null, updatedAt: '2026-11-14T08:45:00.000Z', taskNo: 3, name: '历史 C', replyText: null, reason: null },
  { taskId: 'task_queued', status: 'queued', resultText: null, updatedAt: '2026-11-14T09:00:00.000Z', taskNo: 4, name: '历史 D', replyText: null, reason: null },
  { taskId: 'task_unknown', status: 'failed', resultText: null, updatedAt: '2026-11-14T09:15:00.000Z', taskNo: 5, name: '历史 E', replyText: null, reason: 'result_unknown' },
  { taskId: 'task_cancelling', status: 'cancelling', resultText: null, updatedAt: '2026-11-14T09:30:00.000Z', taskNo: 6, name: '历史 F', replyText: null, reason: null },
  { taskId: 'task_resource', status: 'failed', resultText: null, updatedAt: '2026-11-14T09:45:00.000Z', taskNo: 7, name: '历史 G', replyText: null, reason: 'resource_limited' },
  { taskId: 'task_failed_confirmed', status: 'failed', resultText: null, updatedAt: '2026-11-14T10:00:00.000Z', taskNo: 8, name: '历史 H', replyText: null, reason: 'failed_confirmed' },
  { taskId: 'task_unexecuted', status: 'unexecuted', resultText: null, updatedAt: '2026-11-14T10:15:00.000Z', taskNo: 9, name: '历史 I', replyText: null, reason: null },
  { taskId: 'task_live', status: 'running', resultText: null, updatedAt: '2026-11-14T10:30:00.000Z', taskNo: 10, name: '历史 J', replyText: null, reason: null },
  { taskId: 'task_unexecuted_reported', status: 'unexecuted', resultText: '零执行，但有说明。', updatedAt: '2026-11-14T10:45:00.000Z', taskNo: 11, name: '历史 K', replyText: null, reason: null },
  { taskId: 'task_waiting', status: 'waiting_user', resultText: null, updatedAt: '2026-11-14T11:00:00.000Z', taskNo: 12, name: '历史 L', replyText: null, reason: null, pendingQuestion: '{"missing":["window"]}', waitingSince: '2026-11-14T11:00:00.000Z' },
];

function seedV4Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V4_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, status, result_text, failure_reason,
      created_at, updated_at, task_no, name, reply_text, reason, pending_question, waiting_since)
    VALUES (@taskId, 'wecom:fixture-user', 'ask-v4', @request, @status, @resultText, NULL,
      @updatedAt, @updatedAt, @taskNo, @name, @replyText, @reason, @pendingQuestion, @waitingSince)
  `);
  for (const row of V4_SEED) {
    insert.run({
      taskId: row.taskId,
      request: `历史请求 ${row.taskId}`,
      status: row.status,
      resultText: row.resultText,
      updatedAt: row.updatedAt,
      taskNo: row.taskNo,
      name: row.name,
      replyText: row.replyText,
      reason: row.reason,
      pendingQuestion: row.pendingQuestion ?? null,
      waitingSince: row.waitingSince ?? null,
    });
  }
  db.prepare("INSERT INTO executions (request_id, task_id, operation, status, error_json) VALUES (?, ?, ?, ?, ?)")
    .run('req_v4_a', 'task_done', 'dummy.query', 'completed', null);
  db.prepare("INSERT INTO task_sequences (name, value) VALUES ('task_no', 7)").run();
  db.pragma('user_version = 4');
  db.close();
}

interface V5SeedRow {
  taskId: string;
  taskNo: number;
  resultText: string | null;
  replyText: string | null;
  runningSince: string;
  /** 旧终态列（只用来验「时刻搬运」；种类不迁移）。 */
  terminal?: { column: 'cancelled_at' | 'died_at'; at: string };
  /** 仍在等待的行（迁移后提问保留、不写结束事实）。 */
  pendingQuestion?: string;
  waitingSince?: string;
}

const V5_SEED: readonly V5SeedRow[] = [
  { taskId: 'task_v5_done', taskNo: 11, resultText: 'v5 汇报。', replyText: null, runningSince: '2026-11-20T08:00:00.000Z' },
  { taskId: 'task_v5_cancelled', taskNo: 12, resultText: null, replyText: null, runningSince: '2026-11-20T08:10:00.000Z', terminal: { column: 'cancelled_at', at: '2026-11-20T08:11:00.000Z' } },
  { taskId: 'task_v5_died', taskNo: 13, resultText: null, replyText: null, runningSince: '2026-11-20T08:20:00.000Z', terminal: { column: 'died_at', at: '2026-11-20T08:21:00.000Z' } },
  { taskId: 'task_v5_running', taskNo: 14, resultText: null, replyText: null, runningSince: '2026-11-20T08:30:00.000Z' },
  { taskId: 'task_v5_waiting', taskNo: 15, resultText: null, replyText: null, runningSince: '2026-11-20T08:40:00.000Z', pendingQuestion: '{"missing":["window"]}', waitingSince: '2026-11-20T08:41:00.000Z' },
];

function seedV5Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V5_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, result_text, created_at, updated_at,
      task_no, name, reply_text, running_since, cancelled_at, died_at, pending_question, waiting_since)
    VALUES (@taskId, 'wecom:fixture-user', 'ask-v5', @request, @resultText, @updatedAt, @updatedAt,
      @taskNo, @name, @replyText, @runningSince, @cancelledAt, @diedAt, @pendingQuestion, @waitingSince)
  `);
  for (const row of V5_SEED) {
    insert.run({
      taskId: row.taskId,
      request: `v5 请求 ${row.taskId}`,
      resultText: row.resultText,
      updatedAt: '2026-11-20T09:00:00.000Z',
      taskNo: row.taskNo,
      name: `v5 ${row.taskId}`,
      replyText: row.replyText,
      runningSince: row.runningSince,
      cancelledAt: row.terminal?.column === 'cancelled_at' ? row.terminal.at : null,
      diedAt: row.terminal?.column === 'died_at' ? row.terminal.at : null,
      pendingQuestion: row.pendingQuestion ?? null,
      waitingSince: row.waitingSince ?? null,
    });
  }
  db.prepare("INSERT INTO task_sequences (name, value) VALUES ('task_no', 11)").run();
  db.pragma('user_version = 5');
  db.close();
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
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

function rawTask(dbPath: string, taskId: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function rawEnds(dbPath: string, taskId: string): Array<{ task_id: string; at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT task_id, at FROM task_ends WHERE task_id = ?').all(taskId) as Array<{ task_id: string; at: string }>;
  } finally {
    db.close();
  }
}

const FORBIDDEN_TERMINAL_COLUMNS = [
  'status', 'reason', 'failure_reason',
  'died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at', 'round_failed_at', 'cancel_requested_at',
] as const;

describe('事实账迁移 v4 → 只存事实 + 无种类结束事实', () => {
  it('删结论列/终态列；已停旧行写结束事实、仍在跑的行保持未停（running_since 回填）；备份；幂等', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV4Db(dbPath);
    const preMigrationSha = sha256(dbPath);

    const store = openTaskStore(dbPath);

    // 版本推进 + 备份（内容 = 迁移前字节）。
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(7);
    const backupPath = `${dbPath}.backup-v7`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);

    // 结论/终态列已删；事实列在；task_ends 表已建（只有 task_id + at，**没有 kind**）。
    const columns = columnNames(dbPath, 'tasks');
    for (const forbidden of FORBIDDEN_TERMINAL_COLUMNS) expect(columns).not.toContain(forbidden);
    expect(columns).toEqual(expect.arrayContaining([
      'pending_question', 'waiting_since', 'lease_owner', 'lease_until', 'running_since',
      'reply_text', 'result_text', 'created_at', 'updated_at',
    ]));
    expect(columnNames(dbPath, 'task_ends')).toEqual(expect.arrayContaining(['task_id', 'at']));
    expect(columnNames(dbPath, 'task_ends')).not.toContain('kind');
    expect(columnNames(dbPath, 'task_events')).toEqual([]);

    // 历史事实搬运：请求/汇报/回复/编号原样；执行行仍在（dispatch_key 缺省不伪造）。
    const storedDone = store.getTask('task_done')!;
    expect(storedDone.task.request).toBe('历史请求 task_done');
    expect(storedDone.task.resultText).toBe('历史汇报 A。');
    expect(storedDone.task.replyText).toBe('历史最终回复 A。');
    expect(storedDone.task.taskNo).toBe(1);
    expect(storedDone.executions).toHaveLength(1);
    expect(storedDone.executions[0]!.dispatchKey).toBeUndefined();

    // running_since：仍在推进的行回填 updated_at（不再被当未启动认领）；升级前已停的行
    // 保持原值（v4 没有该列 → NULL，CLI 据此显示「未启动即已停」，不冒充跑过）。
    const liveStatuses = new Set(['waiting_user', 'running', 'cancelling']);
    for (const row of V4_SEED) {
      expect(rawTask(dbPath, row.taskId)['running_since'], row.taskId).toBe(
        liveStatuses.has(row.status) ? row.updatedAt : null,
      );
    }

    // 升级前已停的行各一条「停下时刻」（v4 没有独立终态时刻 → 回退 updated_at）；没有种类。
    // 未停的行（waiting_user / running / cancelling）不写结束事实：
    // 等待行保留提问，在跑/取消行交给启动恢复。
    const stoppedStatuses = new Set([
      'completed', 'failed', 'cancelled', 'canceled', 'timed_out', 'resource_limited',
      'died', 'round_failed', 'unexecuted', 'failed_confirmed', 'queued',
    ]);
    for (const row of V4_SEED) {
      expect(rawEnds(dbPath, row.taskId), row.taskId).toEqual(
        stoppedStatuses.has(row.status) ? [{ task_id: row.taskId, at: row.updatedAt }] : [],
      );
    }
    // 等待行：提问保留（确认/补问还能接续），不是「已停」。
    const waitingRow = store.getTask('task_waiting')!;
    expect(waitingRow.ends).toEqual([]);
    expect(waitingRow.task.pendingQuestion).toBeDefined();
    expect(waitingRow.task.waitingSince).toBe('2026-11-14T11:00:00.000Z');

    // 读出侧：结束事实原样可读（无种类）。
    expect(storedDone.ends).toEqual([{ taskId: 'task_done', at: '2026-11-14T08:00:00.000Z' }]);
    expect(store.getTask('task_unknown')!.ends[0]!.at).toBe('2026-11-14T09:15:00.000Z');
    expect(store.getTask('task_resource')!.ends[0]!.at).toBe('2026-11-14T09:45:00.000Z');

    // 在跑扫描：只有升级前在跑/取消中的行进入（排队行零执行，不当成在跑）；等待行不进。
    expect(store.listRunningTasks().map((row) => row.taskId)).toEqual(['task_cancelling', 'task_live']);
    // 在跑/取消行给一条已过期的迁移租约：启动恢复走「租约过期 → 结束事实（结果未知）」并通知。
    // 排队行（task_queued）零执行：**不給**合成租约——它已被写成「未启动即已停」，
    // 不能再被唤醒成「结果未知」（假话）。
    expect(rawTask(dbPath, 'task_live')['lease_owner']).toBe('migration');
    expect(rawTask(dbPath, 'task_live')['lease_until']).toBe('2026-11-14T10:30:00.000Z');
    expect(rawTask(dbPath, 'task_queued')['lease_owner']).toBeNull();
    expect(store.listRunningExpiredLeases('2026-11-15T00:00:00.000Z').map((row) => row.taskId))
      .toEqual(['task_cancelling', 'task_live']);
    expect(store.listWaitingRows().map((row) => row.task.taskId)).toEqual(['task_waiting']);
    expect(store.claimNextUnstarted({
      owner: 'test', leaseUntil: '2999-01-01T00:00:00.000Z', updatedAt: '2026-11-14T11:00:00.000Z',
    })).toBeUndefined();

    // 新任务编号从历史最大值接续（不重号）。
    const inserted = store.insertTask({
      taskId: 'task_new',
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-v6',
      request: '新任务',
      createdAt: '2026-11-14T11:00:00.000Z',
      updatedAt: '2026-11-14T11:00:00.000Z',
    });
    expect(inserted.taskNo).toBe(13);
    store.close();

    // 幂等：第二次打开零差异、不新增备份。
    const second = openTaskStore(dbPath);
    expect(second.listTasks().map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([
        ['task_done', 1], ['task_cancel', 2], ['task_timeout', 3], ['task_queued', 4],
        ['task_unknown', 5], ['task_cancelling', 6], ['task_resource', 7],
        ['task_failed_confirmed', 8], ['task_unexecuted', 9], ['task_live', 10],
        ['task_unexecuted_reported', 11], ['task_new', 13], ['task_waiting', 12],
      ]);
    second.close();
    expect(backupFiles(dir)).toEqual(['state.db.backup-v7']);
    expect(sha256(backupPath)).toBe(preMigrationSha);
  });
});

describe('事实账迁移 v5 六个终态列 → 无种类结束事实', () => {
  it('v5 库可写打开：终态列的时刻转成结束事实、种类不迁移；仍在等待/在跑的行保持未停', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);

    const store = openTaskStore(dbPath);
    const columns = columnNames(dbPath, 'tasks');
    for (const forbidden of FORBIDDEN_TERMINAL_COLUMNS) expect(columns).not.toContain(forbidden);
    // 结束时刻 = 匹配到的旧终态列原时刻（cancelled_at 08:11 / died_at 08:21），不是 updated_at；
    // 每种旧结局都只成为「停下时刻」，**没有 kind**。
    expect(store.getTask('task_v5_cancelled')!.ends).toEqual([{ taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' }]);
    expect(store.getTask('task_v5_died')!.ends).toEqual([{ taskId: 'task_v5_died', at: '2026-11-20T08:21:00.000Z' }]);
    // 没有旧终态列可读、但有汇报的行回退 updated_at。
    expect(store.getTask('task_v5_done')!.ends).toEqual([{ taskId: 'task_v5_done', at: '2026-11-20T09:00:00.000Z' }]);
    // 仍在跑的行不写结束事实（在跑行不得被静默写成已停）。
    expect(store.getTask('task_v5_running')!.ends).toEqual([]);
    // 仍在等待的行不写结束事实，提问/waiting_since 保留（还能接续）。
    const waiting = store.getTask('task_v5_waiting')!;
    expect(waiting.ends).toEqual([]);
    expect(waiting.task.pendingQuestion).toBeDefined();
    expect(waiting.task.waitingSince).toBe('2026-11-20T08:41:00.000Z');
    for (const row of V5_SEED) {
      expect(rawTask(dbPath, row.taskId)['running_since'], row.taskId).toBe(row.runningSince);
    }
    expect(store.listRunningTasks().map((row) => row.taskId)).toEqual(['task_v5_running']);
    expect(store.listWaitingRows().map((row) => row.task.taskId)).toEqual(['task_v5_waiting']);
    // 在跑行被给了一条已过期的迁移租约：启动恢复按「租约过期 → 结束事实（结果未知）」收尾并通知。
    expect(rawTask(dbPath, 'task_v5_running')['lease_owner']).toBe('migration');
    expect(rawTask(dbPath, 'task_v5_running')['lease_until']).toBe('2026-11-20T09:00:00.000Z');
    expect(store.listRunningExpiredLeases('2026-11-21T00:00:00.000Z').map((row) => row.taskId))
      .toEqual(['task_v5_running']);
    store.close();

    const reopened = openTaskStore(dbPath);
    expect(reopened.getTask('task_v5_cancelled')!.ends).toEqual([{ taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' }]);
    reopened.close();
  });
});

describe('事实账迁移 v6 → v7（task_events 去种类）', () => {
  it('v6 的既有终止事件只留下时刻：kind 列丢弃、task_events 表删除、同任务保留最早时刻', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    // 先做 v6/v7 迁移，再人为造回 v6 形状（带 kind 的 task_events + 任务行仍在）。
    const store = openTaskStore(dbPath);
    store.close();
    {
      const db = new Database(dbPath);
      db.exec(V6_TASK_EVENTS_SCHEMA);
      db.prepare("INSERT INTO task_events (task_id, kind, at, state_version) VALUES (?, ?, ?, 'end')")
        .run('task_v5_cancelled', 'cancelled', '2026-11-20T08:11:00.000Z');
      db.prepare("INSERT INTO task_events (task_id, kind, at, state_version) VALUES (?, ?, ?, 'end2')")
        .run('task_v5_cancelled', 'died', '2026-11-20T08:12:00.000Z');
      db.prepare('DROP TABLE task_ends').run();
      db.pragma('user_version = 6');
      db.close();
    }

    const reopened = openTaskStore(dbPath);
    expect(userVersion(dbPath)).toBe(7);
    // kind 列丢弃；同任务只留最早一条时刻（不分类）。
    expect(columnNames(dbPath, 'task_events')).toEqual([]);
    expect(rawEnds(dbPath, 'task_v5_cancelled')).toEqual([
      { task_id: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(reopened.getTask('task_v5_cancelled')!.ends).toEqual([
      { taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    reopened.close();
  });
});

describe('只读打开不迁移（向前兼容）', () => {
  it('v4 库只读：不加列（status 仍在）、不建备份、哈希不变', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV4Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_done')!.task.request).toBe('历史请求 task_done');
    expect(store.getTask('task_done')!.task.resultText).toBe('历史汇报 A。');
    // v4 没有终态时刻列：从旧 status 合成「停下时刻」（只取停了没，不还原种类）。
    expect(store.getTask('task_cancel')!.ends).toEqual([{ taskId: 'task_cancel', at: '2026-11-14T08:30:00.000Z' }]);
    expect(store.getTask('task_timeout')!.ends).toHaveLength(1);
    expect(store.getTask('task_live')!.ends).toEqual([]);
    // 等待行保留提问（只读投影也不把它当已停）。
    expect(store.getTask('task_waiting')!.task.pendingQuestion).toBeDefined();
    expect(store.getTask('task_waiting')!.ends).toEqual([]);
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath, 'tasks')).toContain('status');
    expect(existsSync(`${dbPath}.backup-v7`)).toBe(false);
  });

  it('v5 库只读：旧终态列还原成「停下时刻」（无种类），不写库、不建事实账', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_v5_cancelled')!.task.request).toBe('v5 请求 task_v5_cancelled');
    expect(store.listRunningTasks()).toEqual([]);
    expect(store.listWaitingRows()).toEqual([]);
    // 只读投影把仍在的旧终态列还原成时刻（旧列原时刻，不是 updated_at）；种类不还原。
    expect(store.getTask('task_v5_cancelled')!.ends).toEqual([
      { taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.getTask('task_v5_died')!.ends).toEqual([
      { taskId: 'task_v5_died', at: '2026-11-20T08:21:00.000Z' },
    ]);
    // 没有旧终态列的行不伪造结束事实（只读不按汇报/旧 status 推结论）。
    expect(store.getTask('task_v5_done')!.ends).toEqual([]);
    expect(store.getTask('task_v5_running')!.ends).toEqual([]);
    // listEndFacts 同源（不是只修 storedTask 一条路）。
    expect(store.listEndFacts('task_v5_cancelled')).toEqual([
      { taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.listEndFacts('task_v5_running')).toEqual([]);
    // 推进判定输入：cancelled 行已有结束事实 → endedAt 在场（不再是「已启动无汇报」）。
    expect(storedTaskProgressOf(store.getTask('task_v5_cancelled')!).endedAt).toBe('2026-11-20T08:11:00.000Z');
    store.close();

    // 不写库：哈希不变、旧列仍在、事实账仍未建。
    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath, 'tasks')).toContain('cancelled_at');
    expect(columnNames(dbPath, 'task_ends')).toEqual([]);
  });

  it('迁移后的库只读打开：结束事实仍从 task_ends 读（不是旧列合成）', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    // 可写打开完成迁移（旧列已删、事实账已建）。
    openTaskStore(dbPath).close();

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_v5_cancelled')!.ends).toEqual([
      { taskId: 'task_v5_cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.getTask('task_v5_died')!.ends).toEqual([
      { taskId: 'task_v5_died', at: '2026-11-20T08:21:00.000Z' },
    ]);
    store.close();
  });
});

describe('重建事务原子性（2026-11-23 review blocking 延续）', () => {
  it('重建中途失败整体回滚：旧 tasks 数据仍在、版本不升、旧结论列/终态列没被 DROP', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    // 制造冲突：残留 tasks_v6 让重建第一步 CREATE 必失败（模拟迁移中途失败）。
    {
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE tasks_v6 (junk TEXT)');
      raw.close();
    }
    // 可写打开 → 迁移失败 → 抛错（不静默吞掉、不把半迁移当成功）。
    expect(() => openTaskStore(dbPath)).toThrow();
    // 事务回滚：旧 tasks 形状与数据原封不动，版本仍 5，终态列还在（没被 DROP）。
    const columns = columnNames(dbPath, 'tasks');
    for (const column of ['died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at', 'round_failed_at', 'cancel_requested_at']) {
      expect(columns).toContain(column);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      expect(rows.n).toBe(V5_SEED.length);
    } finally {
      db.close();
    }
    expect(userVersion(dbPath)).toBe(5);
  });
});
