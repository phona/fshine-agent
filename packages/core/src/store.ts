/**
 * SQLite 审计存储:contracts/store.ts 四个仓库的 better-sqlite3 实现。
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
} from '@fshine/contracts';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principal_scopes (
  wecom_user_id TEXT PRIMARY KEY,
  account_set_ids TEXT NOT NULL,
  mcp_profile TEXT NOT NULL,
  enabled INTEGER NOT NULL
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
`;

interface PrincipalScopeRow {
  wecom_user_id: string;
  account_set_ids: string;
  mcp_profile: string;
  enabled: number;
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

function rowToPrincipalScope(row: PrincipalScopeRow): PrincipalScopeRecord {
  return {
    wecomUserId: row.wecom_user_id,
    accountSetIds: JSON.parse(row.account_set_ids) as string[],
    mcpProfile: row.mcp_profile,
    enabled: row.enabled === 1,
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

  const principalScopes: PrincipalScopeRepo = {
    async get(wecomUserId) {
      const row = db
        .prepare('SELECT wecom_user_id, account_set_ids, mcp_profile, enabled FROM principal_scopes WHERE wecom_user_id = ?')
        .get(wecomUserId) as PrincipalScopeRow | undefined;
      return row ? rowToPrincipalScope(row) : null;
    },
    async list() {
      const rows = db
        .prepare('SELECT wecom_user_id, account_set_ids, mcp_profile, enabled FROM principal_scopes ORDER BY rowid')
        .all() as PrincipalScopeRow[];
      return rows.map(rowToPrincipalScope);
    },
    async upsert(record) {
      db.prepare(
        'INSERT INTO principal_scopes (wecom_user_id, account_set_ids, mcp_profile, enabled) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT (wecom_user_id) DO UPDATE SET account_set_ids = excluded.account_set_ids, mcp_profile = excluded.mcp_profile, enabled = excluded.enabled',
      ).run(record.wecomUserId, JSON.stringify(record.accountSetIds), record.mcpProfile, record.enabled ? 1 : 0);
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

  const store: AuditStore = { principalScopes, requests, toolCalls, sessions };
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
