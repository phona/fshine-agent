/**
 * 最小任务底账的 SQLite 引擎（B 类：任务归属持久化，最小形状）。
 *
 * 只建两张表，字段按最小切片清单收口：
 *   · tasks：task_id / principal_id / session_id / request / status /
 *     result_text / failure_reason / created_at / updated_at；
 *   · executions：request_id / task_id / operation / status / error_json。
 *
 * 为什么不恢复旧 store.ts（2026-11-13 删除）而是新写最小引擎：旧 store 承载
 * TaskPlan / ChangeIntent / TaskRun / PlatformTask 等多套旧 hub 对象与状态机，
 * 本切片不迁它们的计划字段（planId / stepIndex / totalSteps / lastProgress /
 * deadline / originMessage 一概不出现），也不复制多套状态机——表就是上面两张。
 *
 * better-sqlite3 是同步 API：本层不加 async 包装；调用方（task-registry-sqlite）
 * 本来就同步。读出的 status/error 是存储原值，由 registry 侧按领域类型收口。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 一条最小任务底账行（存储形状；领域收口在 task-registry-sqlite）。 */
export interface TaskRow {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /** 'running' | 'completed' | 'failed'（registry 侧取值）。 */
  status: string;
  resultText?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** 一条执行记录行（存储形状）。 */
export interface ExecutionRow {
  requestId: string;
  taskId: string;
  operation: string;
  /** ExecutionStatus（registry 侧取值）。 */
  status: string;
  /** ExecutionFailure，JSON 存读；未知形状原样返回给 registry。 */
  error?: unknown;
}

/** 任务 + 其执行记录（读取单位）。 */
export interface StoredTask {
  task: TaskRow;
  executions: ExecutionRow[];
}

export interface TaskStore {
  insertTask(row: TaskRow): void;
  /** 触碰 updatedAt；任务不存在返回 false（调用方按拒绝路径处理）。 */
  touchTask(taskId: string, updatedAt: string): boolean;
  /** 写入终态结果；任务不存在返回 false。 */
  setTaskOutcome(
    taskId: string,
    outcome: { status: string; resultText?: string; failureReason?: string; updatedAt: string },
  ): boolean;
  /** 追加一条执行记录；任务不存在返回 false（不写孤儿行）。 */
  insertExecution(row: ExecutionRow): boolean;
  getTask(taskId: string): StoredTask | undefined;
  /** scope 缺省 = 全部任务；给出时按 principal + session 过滤。 */
  listTasks(scope?: { principalId: string; sessionId: string }): StoredTask[];
  close(): void;
}

const SCHEMA = `
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

interface TaskDbRow {
  task_id: string;
  principal_id: string;
  session_id: string;
  request: string;
  status: string;
  result_text: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionDbRow {
  request_id: string;
  task_id: string;
  operation: string;
  status: string;
  error_json: string | null;
}

export function openTaskStore(dbPath: string): TaskStore {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insertTask = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, status, result_text, failure_reason, created_at, updated_at)
    VALUES (@taskId, @principalId, @sessionId, @request, @status, @resultText, @failureReason, @createdAt, @updatedAt)
  `);
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?');
  const touch = db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?');
  const setOutcome = db.prepare(`
    UPDATE tasks
    SET status = @status, result_text = @resultText, failure_reason = @failureReason, updated_at = @updatedAt
    WHERE task_id = @taskId
  `);
  const insertExecution = db.prepare(`
    INSERT INTO executions (request_id, task_id, operation, status, error_json)
    VALUES (@requestId, @taskId, @operation, @status, @errorJson)
  `);
  const selectTask = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  const selectExecutions = db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY rowid');
  const selectTasks = db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id');
  const selectTasksScoped = db.prepare(
    'SELECT * FROM tasks WHERE principal_id = ? AND session_id = ? ORDER BY created_at, task_id',
  );

  const toTask = (row: TaskDbRow): TaskRow => ({
    taskId: row.task_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    request: row.request,
    status: row.status,
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const toExecution = (row: ExecutionDbRow): ExecutionRow => ({
    requestId: row.request_id,
    taskId: row.task_id,
    operation: row.operation,
    status: row.status,
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) as unknown }),
  });

  const storedTask = (row: TaskDbRow): StoredTask => ({
    task: toTask(row),
    executions: (selectExecutions.all(row.task_id) as ExecutionDbRow[]).map(toExecution),
  });

  return {
    insertTask(row) {
      insertTask.run({
        taskId: row.taskId,
        principalId: row.principalId,
        sessionId: row.sessionId,
        request: row.request,
        status: row.status,
        resultText: row.resultText ?? null,
        failureReason: row.failureReason ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },
    touchTask(taskId, updatedAt) {
      return touch.run(updatedAt, taskId).changes > 0;
    },
    setTaskOutcome(taskId, outcome) {
      return setOutcome.run({
        taskId,
        status: outcome.status,
        resultText: outcome.resultText ?? null,
        failureReason: outcome.failureReason ?? null,
        updatedAt: outcome.updatedAt,
      }).changes > 0;
    },
    insertExecution(row) {
      if (taskExists.get(row.taskId) === undefined) return false;
      insertExecution.run({
        requestId: row.requestId,
        taskId: row.taskId,
        operation: row.operation,
        status: row.status,
        errorJson: row.error === undefined ? null : JSON.stringify(row.error),
      });
      return true;
    },
    getTask(taskId) {
      const row = selectTask.get(taskId) as TaskDbRow | undefined;
      return row === undefined ? undefined : storedTask(row);
    },
    listTasks(scope) {
      const rows = (scope === undefined
        ? selectTasks.all()
        : selectTasksScoped.all(scope.principalId, scope.sessionId)) as TaskDbRow[];
      return rows.map(storedTask);
    },
    close() {
      db.close();
    },
  };
}
