/**
 * 最小任务底账的 SQLite 引擎（B 类：任务归属持久化，最小形状）。
 *
 * 只建两张表，字段按最小切片清单收口：
 *   · tasks：task_id / principal_id / session_id / request / status /
 *     result_text / failure_reason / created_at / updated_at
 *     +（P1 底账演化）task_no / name / reply_text
 *     +（P2a 契约核心）reason / pending_question / waiting_since / lease_owner / lease_until；
 *   · executions：request_id / task_id / operation / status / error_json。
 *
 * 为什么加 P1 三列（2026-11-14）：数字 ID 稳定简短（任务书 §3，不得回退面向业务的
 * UUID）；业务名称 v1 机械回落（决策问题 #4 v1，零模型、不改 run_task 工具 schema）；
 * Main 最终回复存档（S1，决策问题 #12：同回合各任务行同值，不建 turns 表）。
 *
 * 为什么加 P2a 五列（2026-11-14，docs/product/r4-joint-interfaces.md §1）：
 *   · reason：机械终止原因（cancelled_by_user/timeout/failed_confirmed/result_unknown/
 *     resource_limited）——与 failure_reason（人读文本）分工，result_unknown ≠ failed ≠ success；
 *   · pending_question / waiting_since：waiting_user 形状（JSON：missing[]/candidates?/raw? + ISO 时刻）；
 *   · lease_owner / lease_until：后台认领租约（仅 running 持有；过期 → result_unknown，不自动重放）。
 *
 * 迁移口径（版本化迁移；登记：本注 + docs/decision-log.md R4 登记节）：
 *   · 触发 = 可写打开且 tasks 表缺列（旧库）；只读打开永不迁移——旧库只读时新列读出
 *     缺省（不崩溃）、主库哈希不变；
 *   · 迁移前自动备份：wal_checkpoint(FULL) 后整文件复制为 <dbPath>.backup-v<N>
 *     （N = 迁移目标 schema 版本，当前 3；不覆盖、不自动删除；:memory: 与库文件不存在不生成）；
 *   · 回填 task_no（仅缺该列时）：按 (created_at, task_id) 升序、单条 SQL（ROW_NUMBER）
 *     连续分配，只填 NULL 行（幂等：二次打开零差异）；历史行 name/reply_text/reason 等
 *     保持 NULL（无存档不伪造，显示层标注「该任务无最终回复存档」）；
 *   · PRAGMA user_version 记录版本（新库直接建 v3）；向前兼容：加列不破坏旧代码 SELECT。
 *
 * 数字编号（P1）：
 *   · 分配 = 计数器行（task_sequences.name='task_no'）在**同一事务**内
 *     `UPDATE task_sequences SET value = value + 1 … RETURNING value` + INSERT：
 *     并发安全（SQLite 写事务串行化；多进程并发实测唯一连续）；失败随事务回滚
 *     （失败不占号）；计数器单调不减（每次打开按 MAX(现值, 历史最大编号) 校正）
 *     → 删除/修剪后也不复用、存量编号不重排；
 *   · 同回合各任务行写同一最终回复（setReplyForTasks，单事务，同值）。
 *
 * 状态写入（P2a 唯一写路径）：
 *   · applyTaskState **单条语句**写 status/reason/result_text/failure_reason/pending_question/
 *     waiting_since/lease_owner/lease_until + updated_at，WHERE task_id AND
 *     status=@expectedStatus（乐观并发；不匹配不写）；
 *   · claimQueued 在 BEGIN IMMEDIATE 写事务内先取最老 queued 行，再经同一语句置
 *     running + 租约（进程内/跨进程并发认领不重号）；
 *   · 其他模块禁止直接 UPDATE tasks.status（源码级守卫见
 *     packages/agent/task-registry-write-path.test.ts）。
 *
 * 为什么不恢复旧 store.ts（2026-11-13 删除）而是新写最小引擎：旧 store 承载
 * TaskPlan / ChangeIntent / TaskRun / PlatformTask 等多套旧 hub 对象与状态机，
 * 本切片不迁它们的计划字段（planId / stepIndex / totalSteps / lastProgress /
 * deadline / originMessage 一概不出现），也不复制多套状态机——表就是上面两张。
 *
 * better-sqlite3 是同步 API：本层不加 async 包装；调用方（task-registry-sqlite）
 * 本来就同步。读出的 status/error 是存储原值，由 registry 侧按领域类型收口。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 当前 schema 版本（PRAGMA user_version）。2 = P1（数字编号/名称/回复存档）；3 = P2a 契约核心。 */
export const TASK_STORE_SCHEMA_VERSION = 3;

/** 一条最小任务底账行（存储形状；领域收口在 task-registry-sqlite）。 */
export interface TaskRow {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /** 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'timed_out' | 'unexecuted'（registry 侧取值）。 */
  status: string;
  resultText?: string;
  failureReason?: string;
  /** P2a：机械终止原因（TaskReason；与 failure_reason 分工）。 */
  reason?: string;
  /** P2a：waiting_user 的问题形状（PendingQuestion，JSON 存读；缺省=非等待）。 */
  pendingQuestion?: unknown;
  /** P2a：进入等待的时刻（ISO）。 */
  waitingSince?: string;
  /** P2a：后台认领租约（仅 running 持有）。 */
  leaseOwner?: string;
  leaseUntil?: string;
  /** P1：数字任务编号（SQLite 原子分配，唯一、不复用；旧库只读读出为缺省）。 */
  taskNo?: number;
  /** P1：业务名称（v1=机械回落；历史行为缺省，显示层同规则回落）。 */
  name?: string;
  /** P1：本回合 Main 最终回复全文（同回合各任务行同值；缺省=无存档）。 */
  replyText?: string;
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

/** P2a 单语句状态写入（TaskRegistry 唯一写路径；expectedStatus = 乐观并发期望值）。 */
export interface TaskStateWrite {
  /** 期望的当前状态：不匹配（并发已变化）则不写、返回 false。 */
  expectedStatus: string;
  status: string;
  reason?: string | null;
  resultText?: string | null;
  failureReason?: string | null;
  /** PendingQuestion（本层 JSON 编码）；undefined/null = NULL（无等待形状）。 */
  pendingQuestion?: unknown;
  waitingSince?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
  updatedAt: string;
}

export interface TaskStore {
  /** 插入任务并返回落库行（P1：task_no 由本语句原子分配；失败抛出，不消耗编号）。 */
  insertTask(row: TaskRow): TaskRow;
  /** 触碰 updatedAt；任务不存在返回 false（调用方按拒绝路径处理）。 */
  touchTask(taskId: string, updatedAt: string): boolean;
  /**
   * P2a 唯一状态写入（单语句）：任务不存在/期望状态不符返回 false（零写入）。
   */
  applyTaskState(taskId: string, state: TaskStateWrite): boolean;
  /**
   * P2a 原子认领最老 queued（created_at, task_id 升序）：同一写事务内置 running + 租约；
   * 无 queued 返回 undefined。
   */
  claimQueued(input: { owner: string; leaseUntil: string; updatedAt: string }): TaskRow | undefined;
  /** P2a：running 且租约已过期（lease_until 非空且 <= now）的任务行。 */
  listRunningExpiredLeases(now: string): TaskRow[];
  /**
   * P1：把同一回合的最终回复写入各任务行（同值、单事务）。
   * 不存在的 taskId 不写（调用方保证 id 来自本回合 begin）。
   */
  setReplyForTasks(taskIds: readonly string[], replyText: string, updatedAt: string): void;
  /** 追加一条执行记录；任务不存在返回 false（不写孤儿行）。 */
  insertExecution(row: ExecutionRow): boolean;
  getTask(taskId: string): StoredTask | undefined;
  /** scope 缺省 = 全部任务；给出时按 principal + session 过滤。 */
  listTasks(scope?: { principalId: string; sessionId: string }): StoredTask[];
  close(): void;
}

/** 当前版本的表与索引（新建库直接落 v3；旧库先建这里缺的、再加列回填）。 */
const SCHEMA_BASE = `
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
  reply_text TEXT,
  reason TEXT,
  pending_question TEXT,
  waiting_since TEXT,
  lease_owner TEXT,
  lease_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks (principal_id, session_id);
CREATE TABLE IF NOT EXISTS task_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions (task_id);
`;

/** 数字编号唯一索引：部分索引允许历史/缺省行多个 NULL，但已分配编号必须唯一。 */
const SCHEMA_TASK_NO_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_no ON tasks (task_no) WHERE task_no IS NOT NULL';

/** 版本化新增列（名 → SQLite 列类型）：P1 三列 + P2a 五列，按版本正序。 */
const TASK_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['task_no', 'INTEGER'],
  ['name', 'TEXT'],
  ['reply_text', 'TEXT'],
  ['reason', 'TEXT'],
  ['pending_question', 'TEXT'],
  ['waiting_since', 'TEXT'],
  ['lease_owner', 'TEXT'],
  ['lease_until', 'TEXT'],
];

interface TaskDbRow {
  task_id: string;
  principal_id: string;
  session_id: string;
  request: string;
  status: string;
  result_text: string | null;
  failure_reason: string | null;
  task_no?: number | null;
  name?: string | null;
  reply_text?: string | null;
  reason?: string | null;
  pending_question?: string | null;
  waiting_since?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
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

/** 打开选项（P1 任务查看）：readOnly 只读打开既有库，不写任何字节、不做任何迁移。 */
export interface OpenTaskStoreOptions {
  /**
   * true = 只读视图：不建目录、不设 pragma、不执行建表/迁移；库文件必须已存在
   * （fileMustExist）。写方法仍在但由 SQLite 拒绝（SQLITE_READONLY）。
   */
  readOnly?: boolean;
}

/** 旧库迁移标记的读取：表不存在 = 全新库（直接建 v3）。 */
function taskTableColumns(db: Database.Database): Set<string> {
  const info = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  return new Set(info.map((column) => column.name));
}

/**
 * 迁移前自动备份（只做一次，不覆盖）：先 checkpoint 把 WAL 合入主文件，再整文件复制。
 * 命名 = <dbPath>.backup-v<迁移目标版本>（当前 v3）；`:memory:` 与库文件不存在不生成；
 * 已有同名备份时保留最早副本。
 */
function backupBeforeMigration(db: Database.Database, dbPath: string): void {
  if (dbPath === ':memory:') return;
  const backupPath = `${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`;
  if (existsSync(backupPath)) return;
  db.pragma('wal_checkpoint(FULL)');
  copyFileSync(dbPath, backupPath);
}

export function openTaskStore(dbPath: string, options: OpenTaskStoreOptions = {}): TaskStore {
  const readOnly = options.readOnly === true;
  const db = readOnly
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : (() => {
        if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
        const writable = new Database(dbPath);
        writable.pragma('journal_mode = WAL');
        writable.pragma('foreign_keys = ON');

        const columns = taskTableColumns(writable);
        const tableExists = columns.size > 0;
        const missing = tableExists ? TASK_COLUMNS.filter(([name]) => !columns.has(name)) : [];
        if (missing.length > 0) {
          // 旧库迁移：先备份（目标版本命名），再加列，再（仅缺 task_no 时）回填编号，
          // 最后建唯一索引与版本号。
          backupBeforeMigration(writable, dbPath);
          for (const [name, type] of missing) writable.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
        }
        writable.exec(SCHEMA_BASE);
        if (missing.some(([name]) => name === 'task_no')) {
          // 单条 SQL 回填：历史行按 (created_at, task_id) 升序从当前最大值之后连续分配。
          writable.prepare(`
            UPDATE tasks SET task_no = @base + (
              SELECT rn FROM (
                SELECT task_id, ROW_NUMBER() OVER (ORDER BY created_at, task_id) AS rn
                FROM tasks WHERE task_no IS NULL
              ) AS ordered WHERE ordered.task_id = tasks.task_id
            ) WHERE task_no IS NULL
          `).run({ base: (writable.prepare('SELECT COALESCE(MAX(task_no), 0) AS base FROM tasks').get() as { base: number }).base });
        }
        // 编号计数器：单调不减（MAX(现值, 历史最大编号)）——迁移/重开都不会回收编号。
        writable.prepare(`
          INSERT INTO task_sequences (name, value)
          VALUES ('task_no', (SELECT COALESCE(MAX(task_no), 0) FROM tasks))
          ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)
        `).run();
        writable.exec(SCHEMA_TASK_NO_INDEX);
        const currentVersion = writable.pragma('user_version', { simple: true }) as number;
        if (currentVersion < TASK_STORE_SCHEMA_VERSION) {
          writable.pragma(`user_version = ${TASK_STORE_SCHEMA_VERSION}`);
        }
        return writable;
      })();

  // 语句面：旧库只读（未迁移）时缺列/缺表，含新列的语句不 prepare
  // （否则 PRAGMA 阶段即报 no such column/table）；对应写方法给确定性拒绝。
  const columns = taskTableColumns(db);
  const hasTaskNoColumn = columns.has('task_no');
  const hasReplyColumn = columns.has('reply_text');
  const hasLifecycleColumns = columns.has('reason')
    && columns.has('pending_question')
    && columns.has('waiting_since')
    && columns.has('lease_owner')
    && columns.has('lease_until');
  const allocateTaskNo = hasTaskNoColumn
    ? db.prepare("UPDATE task_sequences SET value = value + 1 WHERE name = 'task_no' RETURNING value")
    : undefined;
  const insertTaskStmt = hasTaskNoColumn
    ? db.prepare(`
        INSERT INTO tasks (
          task_id, principal_id, session_id, request, status, result_text, failure_reason, created_at, updated_at,
          task_no, name, reply_text
        )
        VALUES (
          @taskId, @principalId, @sessionId, @request, @status, @resultText, @failureReason, @createdAt, @updatedAt,
          @taskNo, @name, @replyText
        )
      `)
    : undefined;
  /** 分配 + 插入同一事务：失败（如 taskId 冲突）回滚计数器（失败不占号）。 */
  const insertTaskTx = (() => {
    if (allocateTaskNo === undefined || insertTaskStmt === undefined) return undefined;
    const allocate = allocateTaskNo;
    const insert = insertTaskStmt;
    return db.transaction((bound: {
      taskId: string;
      principalId: string;
      sessionId: string;
      request: string;
      status: string;
      resultText: string | null;
      failureReason: string | null;
      createdAt: string;
      updatedAt: string;
      name: string | null;
      replyText: string | null;
    }) => {
      const allocated = allocate.get() as { value: number };
      insert.run({ ...bound, taskNo: allocated.value });
    });
  })();
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?');
  const touch = db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?');
  /** P2a 唯一状态写入语句（单条；源码级守卫按此判据守住「单写路径」）。 */
  const applyState = hasLifecycleColumns
    ? db.prepare(`
        UPDATE tasks
        SET status = @status,
            reason = @reason,
            result_text = @resultText,
            failure_reason = @failureReason,
            pending_question = @pendingQuestionJson,
            waiting_since = @waitingSince,
            lease_owner = @leaseOwner,
            lease_until = @leaseUntil,
            updated_at = @updatedAt
        WHERE task_id = @taskId AND status = @expectedStatus
      `)
    : undefined;
  const selectOldestQueued = hasLifecycleColumns
    ? db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at, task_id LIMIT 1")
    : undefined;
  const selectExpiredLeases = hasLifecycleColumns
    ? db.prepare("SELECT * FROM tasks WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY created_at, task_id")
    : undefined;
  const setReply = hasReplyColumn
    ? db.prepare(`
        UPDATE tasks SET reply_text = @replyText, updated_at = @updatedAt WHERE task_id = @taskId
      `)
    : undefined;
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

  /**
   * 认领事务：BEGIN IMMEDIATE 先拿写锁再取行（跨进程并发下读到最新已提交数据）；
   * 再经唯一状态语句置 running；期望状态不符（被抢）返回 undefined。
   */
  const claimTx = applyState !== undefined && selectOldestQueued !== undefined
    ? db.transaction((input: { owner: string; leaseUntil: string; updatedAt: string }) => {
        const row = selectOldestQueued.get() as TaskDbRow | undefined;
        if (row === undefined) return undefined;
        const changed = applyState.run({
          taskId: row.task_id,
          expectedStatus: row.status,
          status: 'running',
          reason: null,
          resultText: row.result_text,
          failureReason: row.failure_reason,
          pendingQuestionJson: row.pending_question,
          waitingSince: row.waiting_since ?? null,
          leaseOwner: input.owner,
          leaseUntil: input.leaseUntil,
          updatedAt: input.updatedAt,
        }).changes > 0;
        if (!changed) return undefined;
        return selectTask.get(row.task_id) as TaskDbRow;
      })
    : undefined;

  const toTask = (row: TaskDbRow): TaskRow => ({
    taskId: row.task_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    request: row.request,
    status: row.status,
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    // P2a 列（旧库只读未迁移时为 undefined：读出缺省，不崩溃）。
    ...(row.reason === null || row.reason === undefined ? {} : { reason: row.reason }),
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.pending_question === null || row.pending_question === undefined
      ? {}
      : { pendingQuestion: JSON.parse(row.pending_question) as unknown }),
    ...(row.waiting_since === null || row.waiting_since === undefined ? {} : { waitingSince: row.waiting_since }),
    ...(row.lease_owner === null || row.lease_owner === undefined ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_until === null || row.lease_until === undefined ? {} : { leaseUntil: row.lease_until }),
    // P1：旧库只读（未迁移）时列不存在 → row.task_no 为 undefined：读出缺省，不崩溃。
    ...(row.task_no === null || row.task_no === undefined ? {} : { taskNo: row.task_no }),
    ...(row.name === null || row.name === undefined ? {} : { name: row.name }),
    ...(row.reply_text === null || row.reply_text === undefined ? {} : { replyText: row.reply_text }),
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

  const missingLifecycleError =
    '任务底账是旧版 schema（缺 P2a 生命周期列）且以只读打开：不能写任务状态（请先用可写入口完成迁移）。';

  return {
    insertTask(row) {
      if (insertTaskTx === undefined) {
        throw new Error('任务底账是旧版 schema（缺 task_no/编号计数器）且以只读打开：不能插入任务（请先用可写入口完成迁移）。');
      }
      insertTaskTx({
        taskId: row.taskId,
        principalId: row.principalId,
        sessionId: row.sessionId,
        request: row.request,
        status: row.status,
        resultText: row.resultText ?? null,
        failureReason: row.failureReason ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        name: row.name ?? null,
        replyText: row.replyText ?? null,
      });
      return toTask(selectTask.get(row.taskId) as TaskDbRow);
    },
    touchTask(taskId, updatedAt) {
      return touch.run(updatedAt, taskId).changes > 0;
    },
    applyTaskState(taskId, state) {
      if (applyState === undefined) throw new Error(missingLifecycleError);
      return applyState.run({
        taskId,
        expectedStatus: state.expectedStatus,
        status: state.status,
        reason: state.reason ?? null,
        resultText: state.resultText ?? null,
        failureReason: state.failureReason ?? null,
        pendingQuestionJson: state.pendingQuestion === undefined || state.pendingQuestion === null
          ? null
          : JSON.stringify(state.pendingQuestion),
        waitingSince: state.waitingSince ?? null,
        leaseOwner: state.leaseOwner ?? null,
        leaseUntil: state.leaseUntil ?? null,
        updatedAt: state.updatedAt,
      }).changes > 0;
    },
    claimQueued(input) {
      if (claimTx === undefined) throw new Error(missingLifecycleError);
      const row = claimTx.immediate(input);
      return row === undefined ? undefined : toTask(row);
    },
    listRunningExpiredLeases(now) {
      if (selectExpiredLeases === undefined) throw new Error(missingLifecycleError);
      return (selectExpiredLeases.all(now) as TaskDbRow[]).map(toTask);
    },
    setReplyForTasks(taskIds, replyText, updatedAt) {
      if (setReply === undefined) {
        throw new Error('任务底账是旧版 schema（缺 reply_text 列）且以只读打开：不能写回复存档（请先用可写入口完成迁移）。');
      }
      const apply = db.transaction((ids: readonly string[]) => {
        for (const taskId of ids) setReply.run({ taskId, replyText, updatedAt });
      });
      apply(taskIds);
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
