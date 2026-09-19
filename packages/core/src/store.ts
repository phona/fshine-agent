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
  PrincipalScopeRecord,
  PrincipalScopeRepo,
  RequestOutcome,
  ToolCallRecord,
  ToolCallRepo,
  PlatformTaskRecord,
  PlatformTaskRepo,
  ChangeIntentRecord,
  ChangeIntentRepo,
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
    async updateStatus(intentId, status, result) {
      db.prepare('UPDATE change_intents SET status = ?, decided_at = ?, result = ? WHERE intent_id = ?')
        .run(status, new Date().toISOString(), result === undefined ? null : JSON.stringify(result), intentId);
    },
  };

  const store: AuditStore = { principalScopes, requests, toolCalls, sessions, platformTasks, changeIntents };
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
