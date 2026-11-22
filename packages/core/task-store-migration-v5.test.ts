/**
 * S1 底账 v5 迁移（旧结论列 → 机械事实形状）。
 *
 * 口径（task-store.ts 头注 / docs/design/task-redefinition.md）：
 *   · 触发 = 可写打开且 tasks 仍带旧结论列（status）——v5 重建 tasks 表：删
 *     status/reason/failure_reason 三列，加四个一次性机械时刻列（died/cancelled/
 *     timed_out/resource_limited_at，NULL 起步）；
 *   · 迁移前自动备份 <db>.backup-v5（内容 = 迁移前字节；不覆盖、不自动删除）；
 *   · 历史事实搬运：result_text/reply_text/name/task_no 原样保留；旧 status='cancelled'
 *     /'timed_out' 行按 updated_at 机械回填对应时刻列；曾离开过 queued 的行回填
 *     running_since=updated_at（避免迁移后被当作未启动重新认领），queued 行保持 NULL；
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
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from './src/task-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-v5-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** v4-shape schema（P2a 时代：带结论列 + fact 列，无四个机械时刻列）。 */
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

const SEED_ROWS: readonly SeedRow[] = [
  { taskId: 'task_done', status: 'completed', resultText: '历史汇报 A。', updatedAt: '2026-11-14T08:00:00.000Z', taskNo: 1, name: '历史 A', replyText: '历史最终回复 A。', reason: null },
  { taskId: 'task_cancel', status: 'cancelled', resultText: null, updatedAt: '2026-11-14T08:30:00.000Z', taskNo: 2, name: '历史 B', replyText: null, reason: null },
  { taskId: 'task_timeout', status: 'timed_out', resultText: null, updatedAt: '2026-11-14T08:45:00.000Z', taskNo: 3, name: '历史 C', replyText: null, reason: null },
  { taskId: 'task_queued', status: 'queued', resultText: null, updatedAt: '2026-11-14T09:00:00.000Z', taskNo: 4, name: '历史 D', replyText: null, reason: null },
  // 结果未知（旧 failed + reason=result_unknown）→ 必须回填 died_at（否则退化成「无汇报」）。
  { taskId: 'task_unknown', status: 'failed', resultText: null, updatedAt: '2026-11-14T09:15:00.000Z', taskNo: 5, name: '历史 E', replyText: null, reason: 'result_unknown' },
  // 取消孤儿（旧 cancelling：用户说了停、没确认）→ 必须回填 cancel_requested_at（请求不丢）。
  { taskId: 'task_cancelling', status: 'cancelling', resultText: null, updatedAt: '2026-11-14T09:30:00.000Z', taskNo: 6, name: '历史 F', replyText: null, reason: null },
  // 资源拒绝（旧 failed + reason=resource_limited）→ 必须回填 resource_limited_at（否则事实丢失）。
  { taskId: 'task_resource', status: 'failed', resultText: null, updatedAt: '2026-11-14T09:45:00.000Z', taskNo: 7, name: '历史 G', replyText: null, reason: 'resource_limited' },
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
  for (const row of SEED_ROWS) {
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

function rawTask(dbPath: string, taskId: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

const V5_FACT_COLUMNS = ['died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at'] as const;

describe('S1 v5 迁移（旧结论列 → 机械事实形状）', () => {
  it('删结论列/加四个时刻列；历史事实搬运；旧 cancelled/timed_out 回填时刻；备份 .backup-v5；幂等', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedV4Db(dbPath);
    const preMigrationSha = sha256(dbPath);

    const store = openTaskStore(dbPath);

    // 版本推进 + 备份（内容 = 迁移前字节）。
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(5);
    const backupPath = `${dbPath}.backup-v5`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(preMigrationSha);

    // 结论列已删、四个机械时刻列已加。
    const columns = columnNames(dbPath);
    expect(columns).toEqual(expect.arrayContaining([
      ...V5_FACT_COLUMNS, 'pending_question', 'waiting_since', 'lease_owner', 'lease_until', 'running_since',
      // 存活扫描用的一次性收尾事实（前向加法列/v5 重建带出）：回合失败落定不再被当「还在跑」。
      'round_failed_at',
    ]));
    expect(columns).not.toContain('status');
    expect(columns).not.toContain('reason');
    expect(columns).not.toContain('failure_reason');

    // 历史事实搬运：请求/汇报/回复/编号原样；执行行仍在（dispatch_key 缺省不伪造）。
    const storedDone = store.getTask('task_done')!;
    expect(storedDone.task.request).toBe('历史请求 task_done');
    expect(storedDone.task.resultText).toBe('历史汇报 A。');
    expect(storedDone.task.replyText).toBe('历史最终回复 A。');
    expect(storedDone.task.taskNo).toBe(1);
    expect(storedDone.executions).toHaveLength(1);
    expect(storedDone.executions[0]!.dispatchKey).toBeUndefined();

    // 旧 status 机械回填：cancelled/timed_out 行拿到对应时刻（= updated_at）；queued 行 running_since 保持 NULL。
    expect(rawTask(dbPath, 'task_cancel')['cancelled_at']).toBe('2026-11-14T08:30:00.000Z');
    expect(rawTask(dbPath, 'task_timeout')['timed_out_at']).toBe('2026-11-14T08:45:00.000Z');
    expect(rawTask(dbPath, 'task_queued')['running_since']).toBeNull();
    // 曾离开 queued 的行回填 running_since（避免被当作未启动重新认领）。
    expect(rawTask(dbPath, 'task_done')['running_since']).toBe('2026-11-14T08:00:00.000Z');
    // Grok 复审 2026-11-22：结果未知（旧 failed + reason=result_unknown）回填 died_at（不退化
    // 成「无汇报」）；取消孤儿（旧 cancelling）回填 cancel_requested_at（请求不丢）。
    expect(rawTask(dbPath, 'task_unknown')['died_at']).toBe('2026-11-14T09:15:00.000Z');
    expect(rawTask(dbPath, 'task_unknown')['running_since']).toBe('2026-11-14T09:15:00.000Z');
    expect(rawTask(dbPath, 'task_cancelling')['cancel_requested_at']).toBe('2026-11-14T09:30:00.000Z');
    expect(rawTask(dbPath, 'task_cancelling')['running_since']).toBe('2026-11-14T09:30:00.000Z');
    // 资源拒绝（旧 failed + reason=resource_limited）回填 resource_limited_at（事实不丢）。
    expect(rawTask(dbPath, 'task_resource')['resource_limited_at']).toBe('2026-11-14T09:45:00.000Z');
    expect(rawTask(dbPath, 'task_resource')['running_since']).toBe('2026-11-14T09:45:00.000Z');
    // 读出侧也带上了取消请求事实。
    expect(store.getTask('task_cancelling')!.task.cancelRequestedAt).toBe('2026-11-14T09:30:00.000Z');
    expect(store.getTask('task_unknown')!.task.diedAt).toBe('2026-11-14T09:15:00.000Z');
    expect(store.getTask('task_resource')!.task.resourceLimitedAt).toBe('2026-11-14T09:45:00.000Z');

    // 新任务编号从历史最大值接续（不重号）。
    const inserted = store.insertTask({
      taskId: 'task_new',
      principalId: 'wecom:fixture-user',
      sessionId: 'ask-v5',
      request: '新任务',
      createdAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
    });
    expect(inserted.taskNo).toBe(8);
    store.close();

    // 幂等：第二次打开零差异、不新增备份。
    const second = openTaskStore(dbPath);
    expect(second.listTasks().map((stored) => [stored.task.taskId, stored.task.taskNo]))
      .toEqual([
        ['task_done', 1], ['task_cancel', 2], ['task_timeout', 3], ['task_queued', 4],
        ['task_unknown', 5], ['task_cancelling', 6], ['task_resource', 7], ['task_new', 8],
      ]);
    second.close();
    expect(columnNames(dbPath)).not.toContain('status');
    expect(backupFiles(dir)).toEqual(['state.db.backup-v5']);
    expect(sha256(backupPath)).toBe(preMigrationSha);
  });
});

describe('S1 只读打开不迁移（向前兼容）', () => {
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
    expect(columnNames(dbPath)).toContain('status');
    expect(existsSync(`${dbPath}.backup-v5`)).toBe(false);
  });
});
