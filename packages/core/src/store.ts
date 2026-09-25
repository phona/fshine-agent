/**
 * SQLite 审计存储:contracts/store.ts 仓库的 better-sqlite3 实现。
 * better-sqlite3 为同步 API,按契约包成 async 签名;数组/对象字段以 JSON TEXT 存储,时间为 ISO 8601 TEXT。
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  AgentRequestRecord,
  AgentRequestRepo,
  AuditStore,
  ConversationSessionRecord,
  ConversationSessionRepo,
  ConversationEventRecord,
  ConversationLogRepo,
  ContextStateRecord,
  ContextStateRepo,
  PrincipalScopeRecord,
  PrincipalScopeRepo,
  RequestOutcome,
  ToolCallRecord,
  ToolCallRepo,
  PlatformTaskRecord,
  PlatformTaskRepo,
  ChangeIntentRecord,
  ChangeIntentRepo,
  MemoryRecordRecord,
  MemoryRecordRepo,
  TaskPlanProjection,
  TaskPlanRepo,
  TaskPlanStepFact,
} from '@fshine/contracts';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principal_scopes (
  wecom_user_id TEXT PRIMARY KEY,
  account_set_ids TEXT NOT NULL,
  account_set_scope TEXT NOT NULL DEFAULT 'allowlist',
  mcp_profile TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '["read"]'
);

CREATE TABLE IF NOT EXISTS agent_requests (
  request_id TEXT PRIMARY KEY,
  wecom_message_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  input TEXT NOT NULL,
  created_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_requests_wecom_message_id
  ON agent_requests (wecom_message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  trace_id TEXT,
  tool_name TEXT NOT NULL,
  safe_arguments TEXT NOT NULL,
  source TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  artifact_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_request_id
  ON tool_calls (request_id);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  channel_conversation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_channel_conversation_id
  ON conversation_sessions (channel_conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_principal_id
  ON conversation_sessions (principal_id);

CREATE TABLE IF NOT EXISTS conversation_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_scope_time
  ON conversation_events (principal_id, session_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_conversation_events_principal_time
  ON conversation_events (principal_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS conversation_context_states (
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  through_event_id TEXT NOT NULL,
  reducer_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (principal_id, session_id)
);

CREATE TABLE IF NOT EXISTS task_plan_steps (
  fact_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  total_steps INTEGER NOT NULL,
  task_id TEXT,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_plan_steps_scope_time
  ON task_plan_steps (principal_id, session_id, plan_id, created_at, fact_id);
CREATE INDEX IF NOT EXISTS idx_task_plan_steps_session_time
  ON task_plan_steps (principal_id, session_id, created_at, fact_id);

CREATE TABLE IF NOT EXISTS long_memory_records (
  memory_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  source_event_ids TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_long_memory_principal_key
  ON long_memory_records (principal_id, memory_key, memory_id);

CREATE TABLE IF NOT EXISTS long_memory_cursors (
  principal_id TEXT PRIMARY KEY,
  cursor_event_id TEXT
);

CREATE TABLE IF NOT EXISTS platform_tasks (
  task_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  worker_messages TEXT NOT NULL,
  current_step TEXT,
  pending_questions TEXT,
  last_result TEXT,
  evidence TEXT,
  skill_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_tasks_parent_session_id
  ON platform_tasks (parent_session_id);

CREATE TABLE IF NOT EXISTS change_intents (
  intent_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_set TEXT NOT NULL,
  period TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  confirm_code_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_intents_session_status
  ON change_intents (principal_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_change_intents_confirm
  ON change_intents (principal_id, session_id, confirm_code_hash, status);
`;

interface PrincipalScopeRow {
  wecom_user_id: string;
  account_set_ids: string;
  account_set_scope: string | null;
  mcp_profile: string;
  enabled: number;
  capabilities: string | null;
}

interface AgentRequestRow {
  request_id: string;
  wecom_message_id: string;
  principal_id: string;
  input: string;
  created_at: string;
  outcome: string;
}

interface ToolCallRow {
  id: number;
  request_id: string;
  trace_id: string | null;
  tool_name: string;
  safe_arguments: string;
  source: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_code: string | null;
  artifact_id: string | null;
}

interface SessionRow {
  session_id: string;
  principal_id: string;
  channel_conversation_id: string;
  updated_at: string;
  state: string | null;
}

interface ConversationEventRow {
  event_id: string;
  principal_id: string;
  session_id: string;
  kind: ConversationEventRecord['kind'];
  content: string | null;
  artifact_ref: string | null;
  created_at: string;
  request_id: string | null;
}

interface ContextStateRow {
  principal_id: string;
  session_id: string;
  updated_at: string;
  through_event_id: string;
  reducer_version: number;
  state: string;
}

interface TaskPlanStepRow {
  fact_id: string;
  principal_id: string;
  session_id: string;
  plan_id: string;
  step_index: number;
  total_steps: number;
  task_id: string | null;
  request: string;
  status: string;
  summary: string | null;
  created_at: string;
}

interface MemoryRecordRow {
  memory_id: string;
  principal_id: string;
  memory_key: string;
  memory_type: string;
  content: string;
  status: string;
  source_event_ids: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface PlatformTaskRow {
  task_id: string;
  parent_session_id: string;
  principal_id: string;
  worker_messages: string;
  created_at: string;
  updated_at: string;
}

interface ChangeIntentRow {
  intent_id: string;
  principal_id: string;
  session_id: string;
  kind: string;
  account_set: string;
  period: string;
  payload: string;
  summary: string;
  confirm_code_hash: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  result: string | null;
}

function rowToChangeIntent(row: ChangeIntentRow): ChangeIntentRecord {
  return {
    intentId: row.intent_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    kind: row.kind as ChangeIntentRecord['kind'],
    accountSet: row.account_set,
    period: row.period,
    payload: JSON.parse(row.payload),
    summary: JSON.parse(row.summary),
    confirmCodeHash: row.confirm_code_hash,
    status: row.status as ChangeIntentRecord['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.result ? { result: JSON.parse(row.result) } : {}),
  };
}

function rowToPrincipalScope(row: PrincipalScopeRow): PrincipalScopeRecord {
  return {
    wecomUserId: row.wecom_user_id,
    accountSetIds: JSON.parse(row.account_set_ids) as string[],
    ...(row.account_set_scope === 'all' ? { accountSetScope: 'all' as const } : {}),
    enabled: row.enabled === 1,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) as PrincipalScopeRecord['capabilities'] : ['read'],
  };
}

function rowToAgentRequest(row: AgentRequestRow): AgentRequestRecord {
  return {
    requestId: row.request_id,
    wecomMessageId: row.wecom_message_id,
    principalId: row.principal_id,
    input: row.input,
    createdAt: row.created_at,
    outcome: row.outcome as RequestOutcome,
  };
}

function rowToToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    requestId: row.request_id,
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
    toolName: row.tool_name,
    safeArguments: JSON.parse(row.safe_arguments) as Record<string, unknown>,
    ...(row.source === null ? {} : { source: row.source }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    status: row.status as ToolCallRecord['status'],
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
  };
}

function rowToSession(row: SessionRow): ConversationSessionRecord {
  return {
    sessionId: row.session_id,
    principalId: row.principal_id,
    channelConversationId: row.channel_conversation_id,
    updatedAt: row.updated_at,
    ...(row.state === null ? {} : { state: JSON.parse(row.state) as unknown }),
  };
}

function rowToConversationEvent(row: ConversationEventRow): ConversationEventRecord {
  return {
    eventId: row.event_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    kind: row.kind,
    ...(row.content === null ? {} : { content: row.content }),
    ...(row.artifact_ref === null ? {} : { artifactRef: row.artifact_ref }),
    createdAt: row.created_at,
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
  };
}

function rowToContextState(row: ContextStateRow): ContextStateRecord {
  return {
    principalId: row.principal_id,
    sessionId: row.session_id,
    updatedAt: row.updated_at,
    throughEventId: row.through_event_id,
    reducerVersion: row.reducer_version,
    state: JSON.parse(row.state) as unknown,
  };
}

function rowToTaskPlanStepFact(row: TaskPlanStepRow): TaskPlanStepFact {
  return {
    factId: row.fact_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    planId: row.plan_id,
    stepIndex: row.step_index,
    totalSteps: row.total_steps,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    request: row.request,
    status: row.status as TaskPlanStepFact['status'],
    ...(row.summary === null ? {} : { summary: row.summary }),
    createdAt: row.created_at,
  };
}

function sameTaskPlanStepFact(a: TaskPlanStepFact, b: TaskPlanStepFact): boolean {
  return a.factId === b.factId
    && a.principalId === b.principalId
    && a.sessionId === b.sessionId
    && a.planId === b.planId
    && a.stepIndex === b.stepIndex
    && a.totalSteps === b.totalSteps
    && a.taskId === b.taskId
    && a.request === b.request
    && a.status === b.status
    && a.summary === b.summary
    && a.createdAt === b.createdAt;
}

function rowToMemoryRecord(row: MemoryRecordRow): MemoryRecordRecord {
  return {
    memoryId: row.memory_id,
    principalId: row.principal_id,
    key: row.memory_key,
    type: row.memory_type as MemoryRecordRecord['type'],
    content: row.content,
    status: row.status as MemoryRecordRecord['status'],
    sourceEventIds: JSON.parse(row.source_event_ids) as string[],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameMemoryRecord(a: MemoryRecordRecord, b: MemoryRecordRecord): boolean {
  return a.memoryId === b.memoryId && a.principalId === b.principalId && a.key === b.key
    && a.type === b.type && a.content === b.content && a.status === b.status
    && JSON.stringify(a.sourceEventIds) === JSON.stringify(b.sourceEventIds)
    && a.version === b.version && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}

function sameConversationEvent(a: ConversationEventRecord, b: ConversationEventRecord): boolean {
  return a.eventId === b.eventId
    && a.principalId === b.principalId
    && a.sessionId === b.sessionId
    && a.kind === b.kind
    && a.content === b.content
    && a.artifactRef === b.artifactRef
    && a.createdAt === b.createdAt
    && a.requestId === b.requestId;
}

function rowToPlatformTask(row: PlatformTaskRow): PlatformTaskRecord {
  return {
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    principalId: row.principal_id,
    workerMessages: JSON.parse(row.worker_messages) as unknown[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type FinishPatch = Partial<Omit<ToolCallRecord, 'requestId' | 'toolName' | 'safeArguments' | 'startedAt'>>;

const FINISH_FIELDS: ReadonlyArray<{ key: keyof FinishPatch; column: string }> = [
  { key: 'traceId', column: 'trace_id' },
  { key: 'source', column: 'source' },
  { key: 'finishedAt', column: 'finished_at' },
  { key: 'status', column: 'status' },
  { key: 'errorCode', column: 'error_code' },
  { key: 'artifactId', column: 'artifact_id' },
];

const handles = new WeakMap<AuditStore, Database.Database>();

export function createSqliteStore(dbPath: string): AuditStore {
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(SCHEMA);

  // Forward-compatible migration for databases created before V1 capabilities.
  const principalColumns = db.prepare('PRAGMA table_info(principal_scopes)').all() as Array<{ name: string }>;
  if (!principalColumns.some((column) => column.name === 'capabilities')) {
    db.exec(`ALTER TABLE principal_scopes ADD COLUMN capabilities TEXT NOT NULL DEFAULT '["read"]'`);
  }
  if (!principalColumns.some((column) => column.name === 'account_set_scope')) {
    db.exec(`ALTER TABLE principal_scopes ADD COLUMN account_set_scope TEXT NOT NULL DEFAULT 'allowlist'`);
  }

  const principalScopes: PrincipalScopeRepo = {
    async get(wecomUserId) {
      const row = db
        .prepare('SELECT wecom_user_id, account_set_ids, account_set_scope, mcp_profile, enabled, capabilities FROM principal_scopes WHERE wecom_user_id = ?')
        .get(wecomUserId) as PrincipalScopeRow | undefined;
      return row ? rowToPrincipalScope(row) : null;
    },
    async list() {
      const rows = db
        .prepare('SELECT wecom_user_id, account_set_ids, account_set_scope, mcp_profile, enabled, capabilities FROM principal_scopes ORDER BY rowid')
        .all() as PrincipalScopeRow[];
      return rows.map(rowToPrincipalScope);
    },
    async upsert(record) {
      db.prepare(
        // mcp_profile is a legacy NOT NULL column. Keep writing an empty
        // compatibility value while it remains in old SQLite databases.
        'INSERT INTO principal_scopes (wecom_user_id, account_set_ids, account_set_scope, mcp_profile, enabled, capabilities) VALUES (?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT (wecom_user_id) DO UPDATE SET account_set_ids = excluded.account_set_ids, account_set_scope = excluded.account_set_scope, enabled = excluded.enabled, capabilities = excluded.capabilities',
      ).run(record.wecomUserId, JSON.stringify(record.accountSetIds), record.accountSetScope ?? 'allowlist', '', record.enabled ? 1 : 0, JSON.stringify(record.capabilities ?? ['read']));
    },
  };

  const requests: AgentRequestRepo = {
    async insert(record) {
      db.prepare(
        'INSERT INTO agent_requests (request_id, wecom_message_id, principal_id, input, created_at, outcome) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(record.requestId, record.wecomMessageId, record.principalId, record.input, record.createdAt, record.outcome);
    },
    async get(requestId) {
      const row = db
        .prepare('SELECT request_id, wecom_message_id, principal_id, input, created_at, outcome FROM agent_requests WHERE request_id = ?')
        .get(requestId) as AgentRequestRow | undefined;
      return row ? rowToAgentRequest(row) : null;
    },
    async findByWecomMessageId(wecomMessageId) {
      const row = db
        .prepare('SELECT request_id, wecom_message_id, principal_id, input, created_at, outcome FROM agent_requests WHERE wecom_message_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(wecomMessageId) as AgentRequestRow | undefined;
      return row ? rowToAgentRequest(row) : null;
    },
    async setOutcome(requestId, outcome) {
      db.prepare('UPDATE agent_requests SET outcome = ? WHERE request_id = ?').run(outcome, requestId);
    },
  };

  const toolCalls: ToolCallRepo = {
    async insert(record) {
      db.prepare(
        'INSERT INTO tool_calls (request_id, trace_id, tool_name, safe_arguments, source, started_at, finished_at, status, error_code, artifact_id) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.requestId,
        record.traceId ?? null,
        record.toolName,
        JSON.stringify(record.safeArguments),
        record.source ?? null,
        record.startedAt,
        record.finishedAt ?? null,
        record.status,
        record.errorCode ?? null,
        record.artifactId ?? null,
      );
    },
    async finish(requestId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const field of FINISH_FIELDS) {
        if (field.key in patch) {
          const value = patch[field.key];
          sets.push(`${field.column} = ?`);
          values.push(value === undefined ? null : value);
        }
      }
      if (sets.length === 0) {
        return;
      }
      values.push(requestId);
      db.prepare(
        `UPDATE tool_calls SET ${sets.join(', ')} `
        + `WHERE id = (SELECT id FROM tool_calls WHERE request_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1)`,
      ).run(...values);
    },
    async listByRequest(requestId) {
      const rows = db
        .prepare(
          'SELECT id, request_id, trace_id, tool_name, safe_arguments, source, started_at, finished_at, status, error_code, artifact_id '
          + 'FROM tool_calls WHERE request_id = ? ORDER BY id',
        )
        .all(requestId) as ToolCallRow[];
      return rows.map(rowToToolCall);
    },
  };

  const sessions: ConversationSessionRepo = {
    async get(sessionId) {
      const row = db
        .prepare('SELECT session_id, principal_id, channel_conversation_id, updated_at, state FROM conversation_sessions WHERE session_id = ?')
        .get(sessionId) as SessionRow | undefined;
      return row ? rowToSession(row) : null;
    },
    async upsert(record) {
      db.prepare(
        'INSERT INTO conversation_sessions (session_id, principal_id, channel_conversation_id, updated_at, state) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT (session_id) DO UPDATE SET principal_id = excluded.principal_id, channel_conversation_id = excluded.channel_conversation_id, updated_at = excluded.updated_at, state = excluded.state',
      ).run(
        record.sessionId,
        record.principalId,
        record.channelConversationId,
        record.updatedAt,
        record.state === undefined ? null : JSON.stringify(record.state),
      );
    },
  };

  const conversationLog: ConversationLogRepo = {
    async append(record) {
      const existing = db.prepare('SELECT * FROM conversation_events WHERE event_id = ?')
        .get(record.eventId) as ConversationEventRow | undefined;
      if (existing) {
        const saved = rowToConversationEvent(existing);
        if (!sameConversationEvent(saved, record)) throw new Error(`eventId collision: ${record.eventId}`);
        return;
      }
      db.prepare(
        'INSERT INTO conversation_events (event_id, principal_id, session_id, kind, content, artifact_ref, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(record.eventId, record.principalId, record.sessionId, record.kind, record.content ?? null, record.artifactRef ?? null, record.createdAt, record.requestId ?? null);
    },
    async list(query) {
      const where = ['principal_id = ?'];
      const values: Array<string | number> = [query.principalId];
      if (query.sessionId !== undefined) { where.push('session_id = ?'); values.push(query.sessionId); }
      if (query.before !== undefined) { where.push('created_at < ?'); values.push(query.before); }
      if (query.afterEventId !== undefined) {
        const cursor = query.sessionId === undefined
          ? db.prepare('SELECT event_seq FROM conversation_events WHERE event_id = ? AND principal_id = ?').get(query.afterEventId, query.principalId)
          : db.prepare('SELECT event_seq FROM conversation_events WHERE event_id = ? AND principal_id = ? AND session_id = ?').get(query.afterEventId, query.principalId, query.sessionId);
        if (!cursor) return [];
        const cursorRow = cursor as { event_seq: number };
        where.push('event_seq > ?'); values.push(cursorRow.event_seq);
      }
      values.push(Math.max(1, Math.min(500, Math.floor(query.limit))));
      const order = query.afterEventId === undefined ? 'DESC' : 'ASC';
      const rows = db.prepare(
        `SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY event_seq ${order} LIMIT ?`,
      ).all(...values) as ConversationEventRow[];
      return (query.afterEventId === undefined ? rows.reverse() : rows).map(rowToConversationEvent);
    },
    async search(query) {
      const where = ['principal_id = ?', 'instr(lower(coalesce(content, artifact_ref, \u0027\u0027)), lower(?)) > 0'];
      const values: Array<string | number> = [query.principalId, query.query];
      if (query.sessionId !== undefined) { where.push('session_id = ?'); values.push(query.sessionId); }
      if (query.before !== undefined) { where.push('created_at < ?'); values.push(query.before); }
      values.push(Math.max(1, Math.min(100, Math.floor(query.limit))));
      const rows = db.prepare(
        `SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY event_seq DESC LIMIT ?`,
      ).all(...values) as ConversationEventRow[];
      return rows.reverse().map(rowToConversationEvent);
    },
  };

  const contextStates: ContextStateRepo = {
    async get(principalId, sessionId) {
      const row = db.prepare(
        'SELECT * FROM conversation_context_states WHERE principal_id = ? AND session_id = ?',
      ).get(principalId, sessionId) as ContextStateRow | undefined;
      return row ? rowToContextState(row) : null;
    },
    async upsert(record) {
      db.prepare(
        'INSERT INTO conversation_context_states (principal_id, session_id, updated_at, through_event_id, reducer_version, state) VALUES (?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT (principal_id, session_id) DO UPDATE SET updated_at = excluded.updated_at, through_event_id = excluded.through_event_id, reducer_version = excluded.reducer_version, state = excluded.state',
      ).run(record.principalId, record.sessionId, record.updatedAt, record.throughEventId, record.reducerVersion, JSON.stringify(record.state));
    },
  };

  const taskPlans: TaskPlanRepo = {
    async append(fact) {
      const existing = db.prepare('SELECT * FROM task_plan_steps WHERE fact_id = ?')
        .get(fact.factId) as TaskPlanStepRow | undefined;
      if (existing) {
        if (!sameTaskPlanStepFact(rowToTaskPlanStepFact(existing), fact)) throw new Error(`factId collision: ${fact.factId}`);
        return;
      }
      db.prepare(
        'INSERT INTO task_plan_steps (fact_id, principal_id, session_id, plan_id, step_index, total_steps, task_id, request, status, summary, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        fact.factId,
        fact.principalId,
        fact.sessionId,
        fact.planId,
        fact.stepIndex,
        fact.totalSteps,
        fact.taskId ?? null,
        fact.request,
        fact.status,
        fact.summary ?? null,
        fact.createdAt,
      );
    },
    async project(principalId, sessionId, planId) {
      // 全量重建：不裁剪、不分页（与 Context State 重建同语义）。单 plan 步数有界。
      const rows = db.prepare(
        'SELECT fact_id, principal_id, session_id, plan_id, step_index, total_steps, task_id, request, status, summary, created_at '
        + 'FROM task_plan_steps WHERE principal_id = ? AND session_id = ? AND plan_id = ? ORDER BY fact_seq',
      ).all(principalId, sessionId, planId) as TaskPlanStepRow[];
      if (!rows.length) return null;

      let totalSteps = 0;
      let updatedAt = '';
      const counts: Record<TaskPlanStepFact['status'], number> = { started: 0, done: 0, failed: 0, needs: 0 };
      // 正序遍历，后写覆盖先写 —— 每个 stepIndex 只保留最后一条事实（重试会追加新事实）。
      const lastByStep = new Map<number, TaskPlanStepFact>();
      for (const row of rows) {
        const fact = rowToTaskPlanStepFact(row);
        totalSteps = Math.max(totalSteps, fact.totalSteps);
        counts[fact.status] += 1;
        lastByStep.set(fact.stepIndex, fact);
        updatedAt = fact.createdAt;
      }

      const steps: TaskPlanProjection['steps'] = [...lastByStep.values()]
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((fact) => ({
          stepIndex: fact.stepIndex,
          status: fact.status,
          ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
          ...(fact.summary === undefined ? {} : { summary: fact.summary }),
        }));
      return {
        planId,
        sessionId,
        totalSteps,
        started: counts.started,
        done: counts.done,
        failed: counts.failed,
        needs: counts.needs,
        steps,
        updatedAt,
      };
    },
    async latestOpenPlan(principalId, sessionId) {
      // 按 append 顺序倒序扫本会话事实；Map 插入序即"最近 plan 优先"。
      const rows = db.prepare(
        'SELECT plan_id, step_index, status, total_steps FROM task_plan_steps WHERE principal_id = ? AND session_id = ? ORDER BY fact_seq DESC',
      ).all(principalId, sessionId) as Array<Pick<TaskPlanStepRow, 'plan_id' | 'step_index' | 'status' | 'total_steps'>>;
      const plans = new Map<string, { maxStep: number; totalSteps: number }>();
      for (const row of rows) {
        let entry = plans.get(row.plan_id);
        if (!entry) {
          entry = { maxStep: 0, totalSteps: 0 };
          plans.set(row.plan_id, entry);
        }
        entry.maxStep = Math.max(entry.maxStep, row.step_index);
        entry.totalSteps = Math.max(entry.totalSteps, row.total_steps);
      }
      for (const [planId, entry] of plans) {
        // 未完成 = 已记录的步号还没接满总步数（拆解被中断在步间）。悬挂步（started 无终态）
        // 是它的子集——步 2 停在确认门时 maxStep=2 < totalSteps，同样判未完成。
        // 全部步都有终态且步号接满 → 已完成，不再续跑（确认门步骤不写终态也不会让计划
        // 永远开着：maxStep 接满即关闭，投影里它恒为 started 只是显示问题）。
        if (entry.maxStep < entry.totalSteps) return planId;
      }
      return null;
    },
  };

  const memoryRecords: MemoryRecordRepo = {
    async listByPrincipal(principalId) {
      const rows = db.prepare(
        'SELECT * FROM long_memory_records WHERE principal_id = ? ORDER BY memory_key, memory_id',
      ).all(principalId) as MemoryRecordRow[];
      return rows.map(rowToMemoryRecord);
    },
    async getCursor(principalId) {
      const row = db.prepare('SELECT cursor_event_id FROM long_memory_cursors WHERE principal_id = ?')
        .get(principalId) as { cursor_event_id: string | null } | undefined;
      return row?.cursor_event_id ?? null;
    },
    async commit(principalId, expectedCursor, nextCursor, records) {
      if (!principalId.trim()) throw new Error('principalId is required');
      const ids = new Set<string>();
      for (const record of records) {
        if (record.principalId !== principalId) throw new Error('memory record principal does not match commit principal');
        if (!record.memoryId.trim() || !record.key.trim() || !record.content.trim()) throw new Error('memory record id, key, and content are required');
        if (!['preference', 'fact'].includes(record.type) || !['active', 'conflicted', 'superseded', 'deleted'].includes(record.status)) throw new Error(`memory record ${record.memoryId} has an invalid type or status`);
        if (!Number.isInteger(record.version) || record.version < 1 || !record.sourceEventIds.length || record.sourceEventIds.some((id) => !id.trim())) throw new Error(`memory record ${record.memoryId} has invalid version or source event ids`);
        if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error(`memory record ${record.memoryId} has invalid timestamps`);
        if (ids.has(record.memoryId)) throw new Error(`duplicate memory id ${record.memoryId}`);
        ids.add(record.memoryId);
      }

      const transaction = db.transaction(() => {
        const cursorRow = db.prepare('SELECT cursor_event_id FROM long_memory_cursors WHERE principal_id = ?')
          .get(principalId) as { cursor_event_id: string | null } | undefined;
        const currentCursor = cursorRow?.cursor_event_id ?? null;
        if (currentCursor !== expectedCursor) return false;

        const existingRows = db.prepare('SELECT * FROM long_memory_records WHERE principal_id = ?').all(principalId) as MemoryRecordRow[];
        const existingById = new Map(existingRows.map((row) => [row.memory_id, rowToMemoryRecord(row)]));
        // Keep all old rows: deletions and corrections are represented by tombstones/status changes.
        if ([...existingById.keys()].some((memoryId) => !ids.has(memoryId))) return false;
        for (const record of records) {
          const existing = existingById.get(record.memoryId);
          if (!existing) {
            const owner = db.prepare('SELECT principal_id FROM long_memory_records WHERE memory_id = ?').get(record.memoryId) as { principal_id: string } | undefined;
            if (owner) throw new Error(`memory id ${record.memoryId} belongs to another principal`);
            if (record.version !== 1) return false;
          } else if (record.version < existing.version || (record.version === existing.version && !sameMemoryRecord(record, existing))) {
            return false;
          }
        }

        const upsert = db.prepare(
          'INSERT INTO long_memory_records (memory_id, principal_id, memory_key, memory_type, content, status, source_event_ids, version, created_at, updated_at) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT (memory_id) DO UPDATE SET memory_key = excluded.memory_key, memory_type = excluded.memory_type, content = excluded.content, status = excluded.status, source_event_ids = excluded.source_event_ids, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at '
          + 'WHERE long_memory_records.principal_id = excluded.principal_id AND excluded.version > long_memory_records.version',
        );
        for (const record of records) {
          upsert.run(record.memoryId, record.principalId, record.key, record.type, record.content, record.status, JSON.stringify(record.sourceEventIds), record.version, record.createdAt, record.updatedAt);
        }
        db.prepare(
          'INSERT INTO long_memory_cursors (principal_id, cursor_event_id) VALUES (?, ?) '
          + 'ON CONFLICT (principal_id) DO UPDATE SET cursor_event_id = excluded.cursor_event_id',
        ).run(principalId, nextCursor);
        return true;
      });
      return transaction();
    },
  };

  const platformTasks: PlatformTaskRepo = {
    async get(taskId) {
      const row = db.prepare(
        'SELECT task_id, parent_session_id, principal_id, worker_messages, created_at, updated_at FROM platform_tasks WHERE task_id = ?',
      ).get(taskId) as PlatformTaskRow | undefined;
      return row ? rowToPlatformTask(row) : null;
    },
    async upsert(record) {
      db.prepare(
        // The columns after worker_messages are retained for compatibility
        // with databases created before the subagent task model. They are no
        // longer part of PlatformTaskRecord and are deliberately ignored on
        // reads and updates.
        'INSERT INTO platform_tasks (task_id, plugin_id, parent_session_id, principal_id, status, worker_messages, current_step, pending_questions, last_result, evidence, skill_version, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT (task_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, principal_id = excluded.principal_id, worker_messages = excluded.worker_messages, updated_at = excluded.updated_at',
      ).run(
        record.taskId,
        '',
        record.parentSessionId,
        record.principalId,
        'active',
        JSON.stringify(record.workerMessages),
        null,
        null,
        null,
        null,
        null,
        record.createdAt,
        record.updatedAt,
      );
    },
  };

  const changeIntents: ChangeIntentRepo = {
    async create(record) {
      db.prepare(
        'INSERT INTO change_intents (intent_id, principal_id, session_id, kind, account_set, period, payload, summary, confirm_code_hash, status, created_at, expires_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.intentId,
        record.principalId,
        record.sessionId,
        record.kind,
        record.accountSet,
        record.period,
        JSON.stringify(record.payload),
        JSON.stringify(record.summary),
        record.confirmCodeHash,
        record.status,
        record.createdAt,
        record.expiresAt,
      );
    },
    async get(intentId) {
      const row = db.prepare('SELECT * FROM change_intents WHERE intent_id = ?').get(intentId) as ChangeIntentRow | undefined;
      return row ? rowToChangeIntent(row) : null;
    },
    async findPendingByConfirm(principalId, sessionId, codeHash, now) {
      const row = db.prepare(
        'SELECT * FROM change_intents WHERE principal_id = ? AND session_id = ? AND confirm_code_hash = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ).get(principalId, sessionId, codeHash, 'pending') as ChangeIntentRow | undefined;
      if (!row) return null;
      const record = rowToChangeIntent(row);
      if (new Date(record.expiresAt).getTime() <= now.getTime()) {
        db.prepare('UPDATE change_intents SET status = ?, decided_at = ? WHERE intent_id = ? AND status = ?')
          .run('expired', now.toISOString(), record.intentId, 'pending');
        record.status = 'expired';
        return null;
      }
      return record;
    },
    async findPendingBySession(principalId, sessionId) {
      const row = db.prepare(
        'SELECT * FROM change_intents WHERE principal_id = ? AND session_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ).get(principalId, sessionId, 'pending') as ChangeIntentRow | undefined;
      return row ? rowToChangeIntent(row) : null;
    },
    async findByCodeHash(principalId, sessionId, codeHash) {
      const row = db.prepare(
        'SELECT * FROM change_intents WHERE principal_id = ? AND session_id = ? AND confirm_code_hash = ? ORDER BY created_at DESC LIMIT 1',
      ).get(principalId, sessionId, codeHash) as ChangeIntentRow | undefined;
      return row ? rowToChangeIntent(row) : null;
    },
    async updateStatus(intentId, status, result) {
      db.prepare('UPDATE change_intents SET status = ?, decided_at = ?, result = ? WHERE intent_id = ?')
        .run(status, new Date().toISOString(), result === undefined ? null : JSON.stringify(result), intentId);
    },
  };

  const store: AuditStore = { principalScopes, requests, toolCalls, sessions, conversationLog, contextStates, taskPlans, memoryRecords, platformTasks, changeIntents };
  handles.set(store, db);
  return store;
}

/** 释放底层 better-sqlite3 句柄(测试收尾/进程退出前调用)。 */
export function closeStore(store: AuditStore): void {
  const db = handles.get(store);
  if (db) {
    handles.delete(store);
    db.close();
  }
}
