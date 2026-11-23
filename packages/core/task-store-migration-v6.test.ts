/**
 * 零状态 v6 迁移（可变状态列 → 只存事实 + 终止事件账）。
 *
 * 口径（task-store.ts 头注）：
 *   · 触发 = 可写打开且 tasks 仍是旧形状（带 status 结论列或六个终态列，v5 及更早）；
 *   · v6 重建 tasks 表：删 status/reason/failure_reason + died/cancelled/timed_out/
 *     resource_limited/round_failed/cancel_requested 六列；**只留事实列**；
 *   · 旧任务**全部当已结束**：running_since 按 updated_at 回填（不再被认领），旧结论列的机械
 *     信息转成**一条终止事件**（task_events；cancelled/timed_out/resource_limited/died/
 *     round_failed/completed），历史汇报/执行事实原样保留；
 *   · 迁移前自动备份 <db>.backup-v6（内容 = 迁移前字节；不覆盖、不自动删除）；
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-v6-'));
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
  // 旧 unexecuted 但**有汇报存档**：按正常结束（completed），不是无结果收尾。
  { taskId: 'task_unexecuted_reported', status: 'unexecuted', resultText: '零执行，但有说明。', updatedAt: '2026-11-14T10:45:00.000Z', taskNo: 11, name: '历史 K', replyText: null, reason: null },
];

function seedV4Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V4_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, status, result_text, failure_reason,
      created_at, updated_at, task_no, name, reply_text, reason)
    VALUES (@taskId, 'wecom:fixture-user', 'ask-v4', @request, @status, @resultText, NULL,
      @updatedAt, @updatedAt, @taskNo, @name, @replyText, @reason)
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
  cancellation?: { kind: string; at: string };
}

const V5_SEED: readonly V5SeedRow[] = [
  { taskId: 'task_v5_done', taskNo: 11, resultText: 'v5 汇报。', replyText: null, runningSince: '2026-11-20T08:00:00.000Z' },
  { taskId: 'task_v5_cancelled', taskNo: 12, resultText: null, replyText: null, runningSince: '2026-11-20T08:10:00.000Z', cancellation: { kind: 'cancelled', at: '2026-11-20T08:11:00.000Z' } },
  { taskId: 'task_v5_died', taskNo: 13, resultText: null, replyText: null, runningSince: '2026-11-20T08:20:00.000Z', cancellation: { kind: 'died', at: '2026-11-20T08:21:00.000Z' } },
  { taskId: 'task_v5_running', taskNo: 14, resultText: null, replyText: null, runningSince: '2026-11-20T08:30:00.000Z' },
];

function seedV5Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(V5_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, result_text, created_at, updated_at,
      task_no, name, reply_text, running_since, cancelled_at, died_at)
    VALUES (@taskId, 'wecom:fixture-user', 'ask-v5', @request, @resultText, @updatedAt, @updatedAt,
      @taskNo, @name, @replyText, @runningSince, @cancelledAt, @diedAt)
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
      cancelledAt: row.cancellation?.kind === 'cancelled' ? row.cancellation.at : null,
      diedAt: row.cancellation?.kind === 'died' ? row.cancellation.at : null,
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

function rawEvents(dbPath: string, taskId: string): Array<{ kind: string; at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT kind, at FROM task_events WHERE task_id = ? ORDER BY seq').all(taskId) as Array<{ kind: string; at: string }>;
  } finally {
    db.close();
  }
}

const FORBIDDEN_TERMINAL_COLUMNS = [
  'status', 'reason', 'failure_reason',
  'died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at', 'round_failed_at', 'cancel_requested_at',
] as const;

describe('零状态 v6 迁移（v4 → 只存事实 + 终止事件账）', () => {
  it('删结论列/终态列；旧任务全部当已结束（running_since 回填 + 一条终止事件）；备份 .backup-v6；幂等', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV4Db(dbPath);
    const preMigrationSha = sha256(dbPath);

    const store = openTaskStore(dbPath);

    // 版本推进 + 备份（内容 = 迁移前字节）。
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(6);
    const backupPath = `${dbPath}.backup-v6`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);

    // 结论/终态列已删；事实列在；task_events 表已建。
    const columns = columnNames(dbPath, 'tasks');
    for (const forbidden of FORBIDDEN_TERMINAL_COLUMNS) expect(columns).not.toContain(forbidden);
    expect(columns).toEqual(expect.arrayContaining([
      'pending_question', 'waiting_since', 'lease_owner', 'lease_until', 'running_since',
      'reply_text', 'result_text', 'created_at', 'updated_at',
    ]));
    expect(columnNames(dbPath, 'task_events')).toEqual(
      expect.arrayContaining(['task_id', 'kind', 'at']),
    );

    // 历史事实搬运：请求/汇报/回复/编号原样；执行行仍在（dispatch_key 缺省不伪造）。
    const storedDone = store.getTask('task_done')!;
    expect(storedDone.task.request).toBe('历史请求 task_done');
    expect(storedDone.task.resultText).toBe('历史汇报 A。');
    expect(storedDone.task.replyText).toBe('历史最终回复 A。');
    expect(storedDone.task.taskNo).toBe(1);
    expect(storedDone.executions).toHaveLength(1);
    expect(storedDone.executions[0]!.dispatchKey).toBeUndefined();

    // 旧任务全部当已结束：running_since = updated_at（连旧 queued 行也不再被认领）。
    for (const row of V4_SEED) {
      expect(rawTask(dbPath, row.taskId)['running_since'], row.taskId).toBe(row.updatedAt);
    }
    expect(rawTask(dbPath, 'task_queued')['running_since']).toBe('2026-11-14T09:00:00.000Z');

    // 旧结论 → 终止事件（每个旧任务恰好一条；updated_at = 那次事实的时刻）。
    expect(rawEvents(dbPath, 'task_done')).toEqual([{ kind: 'completed', at: '2026-11-14T08:00:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_cancel')).toEqual([{ kind: 'cancelled', at: '2026-11-14T08:30:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_timeout')).toEqual([{ kind: 'timed_out', at: '2026-11-14T08:45:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_queued')).toEqual([{ kind: 'round_failed', at: '2026-11-14T09:00:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_unknown')).toEqual([{ kind: 'died', at: '2026-11-14T09:15:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_cancelling')).toEqual([{ kind: 'round_failed', at: '2026-11-14T09:30:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_resource')).toEqual([{ kind: 'resource_limited', at: '2026-11-14T09:45:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_failed_confirmed')).toEqual([{ kind: 'round_failed', at: '2026-11-14T10:00:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_unexecuted')).toEqual([{ kind: 'round_failed', at: '2026-11-14T10:15:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_live')).toEqual([{ kind: 'round_failed', at: '2026-11-14T10:30:00.000Z' }]);
    expect(rawEvents(dbPath, 'task_unexecuted_reported')).toEqual([{ kind: 'completed', at: '2026-11-14T10:45:00.000Z' }]);

    // 读出侧：终止事件原样可读。
    expect(storedDone.terminations).toEqual([{ taskId: 'task_done', kind: 'completed', at: '2026-11-14T08:00:00.000Z' }]);
    expect(store.getTask('task_unknown')!.terminations[0]!.kind).toBe('died');
    expect(store.getTask('task_resource')!.terminations[0]!.kind).toBe('resource_limited');

    // 在跑扫描：旧任务全部已结束，没有「在跑」候选；未启动认领也不捞旧行。
    expect(store.listRunningTasks()).toEqual([]);
    expect(store.listWaitingRows()).toEqual([]);
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
    expect(inserted.taskNo).toBe(12);
    store.close();

    // 幂等：第二次打开零差异、不新增备份。
    const second = openTaskStore(dbPath);
    expect(second.listTasks().map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([
        ['task_done', 1], ['task_cancel', 2], ['task_timeout', 3], ['task_queued', 4],
        ['task_unknown', 5], ['task_cancelling', 6], ['task_resource', 7],
        ['task_failed_confirmed', 8], ['task_unexecuted', 9], ['task_live', 10],
        ['task_unexecuted_reported', 11], ['task_new', 12],
      ]);
    second.close();
    expect(backupFiles(dir)).toEqual(['state.db.backup-v6']);
    expect(sha256(backupPath)).toBe(preMigrationSha);
  });
});

describe('零状态 v6 迁移（v5 六个终态列 → 追加事件）', () => {
  it('v5 库可写打开：终态列转成事件、旧行全部当已结束、事件重启后仍在', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);

    const store = openTaskStore(dbPath);
    const columns = columnNames(dbPath, 'tasks');
    for (const forbidden of FORBIDDEN_TERMINAL_COLUMNS) expect(columns).not.toContain(forbidden);
    // 有汇报的旧行 = completed；已有终态列的按原 kind；无可读结论的旧行 = round_failed。
    expect(store.getTask('task_v5_done')!.terminations.map((row) => row.kind)).toEqual(['completed']);
    expect(store.getTask('task_v5_cancelled')!.terminations.map((row) => row.kind)).toEqual(['cancelled']);
    expect(store.getTask('task_v5_died')!.terminations.map((row) => row.kind)).toEqual(['died']);
    expect(store.getTask('task_v5_running')!.terminations.map((row) => row.kind)).toEqual(['round_failed']);
    // 终止事件的时刻 = 匹配到的旧终态列原时刻（cancelled_at 08:11 / died_at 08:21），
    // 不是 updated_at（两行都是 09:00）。反向绊线：at 改回固定 updated_at → 本断言红。
    expect(store.getTask('task_v5_cancelled')!.terminations[0]!.at).toBe('2026-11-20T08:11:00.000Z');
    expect(store.getTask('task_v5_died')!.terminations[0]!.at).toBe('2026-11-20T08:21:00.000Z');
    expect(store.getTask('task_v5_cancelled')!.terminations[0]!.at).not.toBe('2026-11-20T09:00:00.000Z');
    expect(store.getTask('task_v5_died')!.terminations[0]!.at).not.toBe('2026-11-20T09:00:00.000Z');
    // 没有旧终态列可读的行才回退 updated_at。
    expect(store.getTask('task_v5_running')!.terminations[0]!.at).toBe('2026-11-20T09:00:00.000Z');
    for (const row of V5_SEED) {
      expect(rawTask(dbPath, row.taskId)['running_since'], row.taskId).toBe(row.runningSince);
    }
    expect(store.listRunningTasks()).toEqual([]);
    store.close();

    const reopened = openTaskStore(dbPath);
    expect(reopened.getTask('task_v5_cancelled')!.terminations.map((row) => row.kind)).toEqual(['cancelled']);
    reopened.close();
  });
});

describe('零状态只读打开不迁移（向前兼容）', () => {
  it('v4 库只读：不加列（status 仍在）、不建备份、哈希不变', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV4Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_done')!.task.request).toBe('历史请求 task_done');
    expect(store.getTask('task_done')!.task.resultText).toBe('历史汇报 A。');
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath, 'tasks')).toContain('status');
    expect(existsSync(`${dbPath}.backup-v6`)).toBe(false);
  });

  it('v5 库只读：旧终态列还原成终止事实（kind + 原时刻），不写库、不建事件账', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_v5_cancelled')!.task.request).toBe('v5 请求 task_v5_cancelled');
    expect(store.listRunningTasks()).toEqual([]);
    expect(store.listWaitingRows()).toEqual([]);
    // 只读投影把仍在的旧终态列还原成终止事实：kind + 旧列原时刻（不是 updated_at）。
    // 反向绊线：只读投影忽略旧列 → cancelled 读成「已启动无汇报」= died（结果未知），本断言红。
    expect(store.getTask('task_v5_cancelled')!.terminations).toEqual([
      { taskId: 'task_v5_cancelled', kind: 'cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.getTask('task_v5_died')!.terminations).toEqual([
      { taskId: 'task_v5_died', kind: 'died', at: '2026-11-20T08:21:00.000Z' },
    ]);
    // 没有旧终态列的行不伪造终止事实（只读不按汇报/旧 status 推结论）。
    expect(store.getTask('task_v5_done')!.terminations).toEqual([]);
    expect(store.getTask('task_v5_running')!.terminations).toEqual([]);
    // listTerminations 同源（不是只修 storedTask 一条路）。
    expect(store.listTerminations('task_v5_cancelled')).toEqual([
      { taskId: 'task_v5_cancelled', kind: 'cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.listTerminations('task_v5_running')).toEqual([]);
    // 存活推导输入（唯一谓词）：cancelled 行已有终止事实，不再按「已启动无汇报」判 died。
    expect(storedTaskProgressOf(store.getTask('task_v5_cancelled')!).termination).toEqual({
      kind: 'cancelled',
      at: '2026-11-20T08:11:00.000Z',
    });
    store.close();

    // 不写库：哈希不变、旧列仍在、事件账仍未建。
    expect(sha256(dbPath)).toBe(before);
    expect(columnNames(dbPath, 'tasks')).toContain('cancelled_at');
    expect(columnNames(dbPath, 'task_events')).toEqual([]);
  });

  it('迁移后的 v6 库只读打开：终止事实仍从 task_events 读（不是旧列合成）', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV5Db(dbPath);
    // 可写打开完成迁移（旧列已删、事件账已建）。
    openTaskStore(dbPath).close();

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getTask('task_v5_cancelled')!.terminations).toEqual([
      { taskId: 'task_v5_cancelled', kind: 'cancelled', at: '2026-11-20T08:11:00.000Z' },
    ]);
    expect(store.getTask('task_v5_died')!.terminations).toEqual([
      { taskId: 'task_v5_died', kind: 'died', at: '2026-11-20T08:21:00.000Z' },
    ]);
    store.close();
  });
});

describe('零状态 v6 重建事务原子性（2026-11-23 review blocking 延续）', () => {
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
