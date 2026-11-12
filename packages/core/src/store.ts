/**
 * SQLite 审计存储:contracts/store.ts 仓库的 better-sqlite3 实现。
 * better-sqlite3 为同步 API,按契约包成 async 签名;数组/对象字段以 JSON TEXT 存储,时间为 ISO 8601 TEXT。
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SessionArtifactRefConflictError, TaskRunActiveConflictError } from '@fshine/contracts';
import type {
  AgentRequestRecord,
  AgentRequestRepo,
  AuditStore,
  ConversationSessionRecord,
  ConversationSessionRepo,
  ConversationEventRecord,
  ConversationLogRepo,
  PrincipalScopeRecord,
  PrincipalScopeRepo,
  RequestOutcome,
  SessionArtifactRecord,
  SessionArtifactRepo,
  ToolCallRecord,
  ToolCallRepo,
  PlatformTaskRecord,
  PlatformTaskRepo,
  ChangeIntentRecord,
  ChangeIntentRepo,
  TaskPlanProjection,
  TaskPlanRepo,
  TaskPlanStepFact,
  TaskPlanSummary,
  TaskRunRecord,
  TaskRunRepo,
  TaskRunState,
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
  message_reference TEXT,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  request_id TEXT,
  task_id TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_scope_time
  ON conversation_events (principal_id, session_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_conversation_events_principal_time
  ON conversation_events (principal_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS session_artifacts (
  ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  source_task_id TEXT,
  source_run_id TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (session_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_session_artifacts_session_time
  ON session_artifacts (session_id, created_at);

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
  updated_at TEXT NOT NULL,
  -- P2 结构化执行事实（D-065）：委派时的确定性信息回填，不从 worker 文本解析。
  -- 形状是通用的：范围取值（JSON 数组）按执行层声明逐位查表得到——本表不焊任何
  -- 执行层的参数名（谁的对象/窗口由执行层声明面定，见 platform-contract）。
  scope_values TEXT,
  calls TEXT,
  label TEXT,
  outcome TEXT,
  result_text TEXT,
  -- 恢复路径与重复请求门（2026-11-12，G3/RR1）的确定性事实：委派时冻结的实体来源
  -- 快照（JSON）与该次请求的身份键。缺失（旧条目）= 恢复拒绝 / 身份不命中，不猜不补。
  entity_sources TEXT,
  request_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_tasks_parent_session_id
  ON platform_tasks (parent_session_id);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  dispatch_key TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin_request_id TEXT NOT NULL,
  origin_user_event_id TEXT NOT NULL,
  request TEXT NOT NULL,
  origin_message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  deadline TEXT,
  plan_id TEXT,
  step_index INTEGER,
  total_steps INTEGER,
  last_progress TEXT,
  result_text TEXT,
  result_json TEXT,
  error TEXT,
  result_event_id TEXT,
  input_context_json TEXT,
  delivery_route_json TEXT,
  metadata_json TEXT,
  result_handling_state TEXT,
  delivery_state TEXT,
  delivery_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_runs_scope_created
  ON task_runs (principal_id, session_id, created_at, run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_one_active_per_task
  ON task_runs (task_id) WHERE state IN ('queued', 'running', 'cancelling');

CREATE TABLE IF NOT EXISTS change_intents (
  intent_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- 方案 1 · B 波新增的两列（缺列即补的前向迁移，见 createSqliteStore）：平台提案引用
  -- 与发起提案的子任务。旧行没有它们 → 读回时不带这两个字段（上层据此判过期）。
  proposal_id TEXT,
  task_id TEXT,
  confirm_code_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  result TEXT,
  -- ── 以下五列是迁移前的历史列（kind/account_set/period/payload/summary）──────────
  -- B 波起契约零业务字段、零 payload（提案载荷归执行层提案状态库，宿主持有取物单
  -- proposalId），因此这五列**不再被读、也不再被写**——列留着做历史，不删表。
  -- 旧库里它们是 NOT NULL 且无缺省，故插入时补空串兼容值（与 principal_scopes 的
  -- mcp_profile 同一手法）；新库在此声明 DEFAULT '' 让形状自明。
  kind TEXT NOT NULL DEFAULT '',
  account_set TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT ''
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

interface SessionArtifactRow {
  ref: string;
  session_id: string;
  filename: string;
  sha256: string;
  size: number;
  source_task_id: string | null;
  source_run_id: string | null;
  request_id: string | null;
  created_at: string;
  status: string;
  path: string;
}

interface ConversationEventRow {
  event_id: string;
  principal_id: string;
  session_id: string;
  kind: ConversationEventRecord['kind'];
  content: string | null;
  message_reference: string | null;
  artifact_ref: string | null;
  created_at: string;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
}

interface TaskRunRow {
  run_id: string;
  task_id: string;
  dispatch_key: string;
  principal_id: string;
  session_id: string;
  origin_request_id: string;
  origin_user_event_id: string;
  request: string;
  origin_message: string;
  created_at: string;
  updated_at: string;
  state: TaskRunState;
  started_at: string | null;
  ended_at: string | null;
  deadline: string | null;
  plan_id: string | null;
  step_index: number | null;
  total_steps: number | null;
  last_progress: string | null;
  result_text: string | null;
  result_json: string | null;
  error: string | null;
  result_event_id: string | null;
  input_context_json: string | null;
  delivery_route_json: string | null;
  metadata_json: string | null;
  result_handling_state: TaskRunRecord['resultHandlingState'] | null;
  delivery_state: TaskRunRecord['deliveryState'] | null;
  delivery_json: string | null;
  revision: number;
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

interface PlatformTaskRow {
  task_id: string;
  parent_session_id: string;
  principal_id: string;
  worker_messages: string;
  created_at: string;
  updated_at: string;
  scope_values: string | null;
  calls: string | null;
  label: string | null;
  outcome: string | null;
  result_text: string | null;
  entity_sources: string | null;
  request_key: string | null;
}

/**
 * change_intents 的行形状：**只声明新字段**。
 *
 * 旧列（kind/account_set/period/payload/summary）不出现在这里——B 波起不再读它们，
 * 声明了就等于给"读业务字段"留了一个类型合法的入口。SELECT * 仍会把它们带回来，
 * 但没有任何映射会碰它们（列留着做历史）。
 */
interface ChangeIntentRow {
  intent_id: string;
  principal_id: string;
  session_id: string;
  proposal_id: string | null;
  task_id: string | null;
  confirm_code_hash: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  result: string | null;
}

/**
 * 历史列（不再读/不再写，只为旧库的 NOT NULL 约束补空串兼容值）。
 * 与 principal_scopes.mcp_profile 同一手法：旧库里没有 DEFAULT，插入必须给值。
 */
const CHANGE_INTENT_LEGACY_COLUMNS: readonly string[] = ['kind', 'account_set', 'period', 'payload', 'summary'];

function rowToChangeIntent(row: ChangeIntentRow): ChangeIntentRecord {
  return {
    intentId: row.intent_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    // 新列缺列即补：旧行/缺列时这两个字段不出现在记录里（消费方据此降级，不猜不补）。
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
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

function rowToSessionArtifact(row: SessionArtifactRow): SessionArtifactRecord {
  return {
    ref: row.ref,
    sessionId: row.session_id,
    filename: row.filename,
    sha256: row.sha256,
    size: row.size,
    ...(row.source_task_id === null ? {} : { sourceTaskId: row.source_task_id }),
    ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    createdAt: row.created_at,
    status: row.status === 'evicted' ? 'evicted' : 'available',
    path: row.path,
  };
}

function rowToConversationEvent(row: ConversationEventRow): ConversationEventRecord {
  return {
    eventId: row.event_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    kind: row.kind,
    ...(row.content === null ? {} : { content: row.content }),
    ...(row.message_reference === null ? {} : { messageReference: JSON.parse(row.message_reference) as ConversationEventRecord['messageReference'] }),
    ...(row.artifact_ref === null ? {} : { artifactRef: row.artifact_ref }),
    createdAt: row.created_at,
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  };
}

function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    dispatchKey: row.dispatch_key,
    principalId: row.principal_id,
    sessionId: row.session_id,
    originRequestId: row.origin_request_id,
    originUserEventId: row.origin_user_event_id,
    request: row.request,
    originMessage: row.origin_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.deadline === null ? {} : { deadline: row.deadline }),
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_index === null ? {} : { stepIndex: row.step_index }),
    ...(row.total_steps === null ? {} : { totalSteps: row.total_steps }),
    ...(row.last_progress === null ? {} : { lastProgress: row.last_progress }),
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id }),
    ...(row.input_context_json === null ? {} : { inputContext: JSON.parse(row.input_context_json) as TaskRunRecord['inputContext'] }),
    ...(row.delivery_route_json === null ? {} : { deliveryRoute: JSON.parse(row.delivery_route_json) as TaskRunRecord['deliveryRoute'] }),
    ...(row.metadata_json === null ? {} : { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }),
    ...(row.result_handling_state === null ? {} : { resultHandlingState: row.result_handling_state }),
    ...(row.delivery_state === null ? {} : { deliveryState: row.delivery_state }),
    ...(row.delivery_json === null ? {} : { delivery: JSON.parse(row.delivery_json) as unknown }),
    revision: row.revision,
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

function normalizedMessageReference(reference: ConversationEventRecord['messageReference']): string | null {
  if (reference == null) return null;
  // Fixed field order makes idempotency independent of the caller's object property order.
  return JSON.stringify([
    reference.kind,
    reference.text ?? null,
    reference.truncated ?? false,
    reference.sourceMessageId ?? null,
  ]);
}

function serializeMessageReference(reference: ConversationEventRecord['messageReference']): string | null {
  if (reference == null) return null;
  // Persist only the public normalized contract; never carry through adapter callback extras.
  return JSON.stringify({
    kind: reference.kind,
    ...(reference.text === undefined ? {} : { text: reference.text }),
    ...(reference.truncated === undefined ? {} : { truncated: reference.truncated }),
    ...(reference.sourceMessageId === undefined ? {} : { sourceMessageId: reference.sourceMessageId }),
  });
}

function sameConversationEvent(a: ConversationEventRecord, b: ConversationEventRecord): boolean {
  return a.eventId === b.eventId
    && a.principalId === b.principalId
    && a.sessionId === b.sessionId
    && a.kind === b.kind
    && a.content === b.content
    && normalizedMessageReference(a.messageReference) === normalizedMessageReference(b.messageReference)
    && a.artifactRef === b.artifactRef
    && a.createdAt === b.createdAt
    && a.requestId === b.requestId
    && a.taskId === b.taskId
    && a.runId === b.runId;
}

function rowToPlatformTask(row: PlatformTaskRow): PlatformTaskRecord {
  return {
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    principalId: row.principal_id,
    workerMessages: JSON.parse(row.worker_messages) as unknown[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 结构化字段：旧库/缺列时一律不出现在记录里（消费方据此降级，不猜不补）。
    ...(row.scope_values ? { scopeValues: JSON.parse(row.scope_values) as string[] } : {}),
    ...(row.calls ? { calls: JSON.parse(row.calls) as PlatformTaskRecord['calls'] } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.outcome === 'done' || row.outcome === 'needs' || row.outcome === 'failed' ? { outcome: row.outcome } : {}),
    ...(row.result_text ? { resultText: row.result_text } : {}),
    // 恢复来源快照与请求身份（G3/RR1）：缺失即不在记录里——恢复拒绝 / 身份不命中。
    ...(row.entity_sources ? { entitySources: JSON.parse(row.entity_sources) as unknown } : {}),
    ...(row.request_key ? { requestKey: row.request_key } : {}),
  };
}

/** 结构化事实列 ↔ 记录字段（upsert 的写入面与 get/list 的读回面共用同一份映射）。 */
const PLATFORM_TASK_FACT_COLUMNS: ReadonlyArray<{ field: keyof PlatformTaskRecord; column: string }> = [
  { field: 'scopeValues', column: 'scope_values' },
  { field: 'calls', column: 'calls' },
  { field: 'label', column: 'label' },
  { field: 'outcome', column: 'outcome' },
  { field: 'resultText', column: 'result_text' },
  { field: 'entitySources', column: 'entity_sources' },
  { field: 'requestKey', column: 'request_key' },
];

/** 以 JSON 文本落库的结构化事实字段（数组/对象形状；其余按字符串落）。 */
const PLATFORM_TASK_JSON_FIELDS: ReadonlySet<keyof PlatformTaskRecord> = new Set(['calls', 'scopeValues', 'entitySources']);

/** 结构化事实的 SQL 值（JSON 字段序列化；undefined → NULL，即"这个任务没有这个事实"）。 */
function platformTaskFactValue(field: keyof PlatformTaskRecord, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (PLATFORM_TASK_JSON_FIELDS.has(field)) return JSON.stringify(value);
  return String(value);
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

  // Forward-compatible migration for databases created before the P2 structured
  // execution facts (D-065): platform_tasks gained scope_values/calls/label/
  // outcome/result_text — and later entity_sources/request_key (G3/RR1, 2026-11-12).
  // Older rows simply read back as records without those fields (consumers degrade:
  // 恢复拒绝 / 身份不命中，而不是猜)。首版 D-065 的
  // 两个执行层专属列只作为历史留在旧库里：不再读、不再写（范围取值改由通用列
  // scope_values 承载；迁移不复制旧值——消费方降级，不猜不补）。
  const taskColumns = db.prepare('PRAGMA table_info(platform_tasks)').all() as Array<{ name: string }>;
  for (const column of ['scope_values', 'calls', 'label', 'outcome', 'result_text', 'entity_sources', 'request_key']) {
    if (!taskColumns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE platform_tasks ADD COLUMN ${column} TEXT`);
    }
  }

  // Forward-compatible migration for databases created before the proposal-reference
  // intent record (方案 1 · B 波): change_intents gained proposal_id/task_id. Older rows
  // simply read back as records without those fields (consumers treat them as expired),
  // and the legacy business columns stay in place as history — never read, never written.
  const intentColumns = db.prepare('PRAGMA table_info(change_intents)').all() as Array<{ name: string }>;
  for (const column of ['proposal_id', 'task_id']) {
    if (!intentColumns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE change_intents ADD COLUMN ${column} TEXT`);
    }
  }

  // Conversation quote metadata and background task linkage are additive nullable
  // fields. Existing event content remains the current message body; NULL means no quote.
  const conversationEventColumns = db.prepare('PRAGMA table_info(conversation_events)').all() as Array<{ name: string }>;
  for (const column of ['message_reference', 'task_id', 'run_id']) {
    if (!conversationEventColumns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE conversation_events ADD COLUMN ${column} TEXT`);
    }
  }

  const taskRunColumns = db.prepare('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>;
  if (!taskRunColumns.some((column) => column.name === 'revision')) {
    db.exec('ALTER TABLE task_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }

  // Forward-compatible migration for the result-handling state machine column: the state
  // used to live only inside metadata_json (sniffed via json_extract), which silently broke
  // GC pinning whenever the writer renamed fields. Old rows are backfilled once from valid
  // metadata JSON; rows without a resultHandling (or with invalid JSON) stay NULL, and the
  // guarded WHERE keeps a second reopen a no-op (idempotent backfill).
  if (!taskRunColumns.some((column) => column.name === 'result_handling_state')) {
    db.exec('ALTER TABLE task_runs ADD COLUMN result_handling_state TEXT');
    db.prepare(
      'UPDATE task_runs SET result_handling_state = json_extract(metadata_json, \'$.resultHandling.state\') '
      + 'WHERE result_handling_state IS NULL AND json_valid(metadata_json) '
      + 'AND json_extract(metadata_json, \'$.resultHandling.state\') IN (\'processing\', \'handled\', \'failed\')',
    ).run();
  }

  // Preserve task and per-run provenance for artifacts created before background execution.
  const artifactColumns = db.prepare('PRAGMA table_info(session_artifacts)').all() as Array<{ name: string }>;
  if (!artifactColumns.some((column) => column.name === 'source_run_id')) {
    db.exec('ALTER TABLE session_artifacts ADD COLUMN source_run_id TEXT');
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
    // 附件恢复：只认"只发附件、没有指令"的登记行（见契约注释）。按时间倒序取最近若干条，
    // 由调用方解析 input 里的附件信封。索引已覆盖 principal 维度则足够。
    async listRecentAttachments(principalId, sinceIso) {
      return db
        .prepare('SELECT input FROM agent_requests WHERE principal_id = ? AND outcome = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 32')
        .all(principalId, 'attachment_received', sinceIso) as Array<{ input: string }>;
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

  const sessionArtifacts: SessionArtifactRepo = {
    async insert(record) {
      // D-123 fail-loud：覆盖 upsert 会让并发重叠 ref 的后写吃掉前写（字节留孤儿）。
      // 唯一键冲突转可识别错误；其余约束错误（NOT NULL 等）原样上抛。
      try {
        db.prepare(
          'INSERT INTO session_artifacts (ref, session_id, filename, sha256, size, source_task_id, source_run_id, request_id, created_at, status, path) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          record.ref,
          record.sessionId,
          record.filename,
          record.sha256,
          record.size,
          record.sourceTaskId ?? null,
          record.sourceRunId ?? null,
          record.requestId ?? null,
          record.createdAt,
          record.status,
          record.path,
        );
      } catch (error) {
        // 该表 (session_id, ref) 是 PRIMARY KEY（code 为 PRIMARYKEY；唯一索引形态才是
        // UNIQUE），两种都按 ref 冲突处理；NOT NULL 等其他约束原样上抛。
        const code = (error as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new SessionArtifactRefConflictError(
            `会话 '${record.sessionId}' 的产物 ref '${record.ref}' 已存在：insert 不做覆盖（fail-loud），ref 分配须在会话串行段内完成。`,
          );
        }
        throw error;
      }
    },
    async listBySession(sessionId) {
      // ref 是 TEXT 列，纯 TEXT 序在跨 10 位数（'10' < '2'）时不稳定（D-123）；
      // ref 由 nextArtifactRef 生成（数字字符串），CAST 后数值序与单调性同源，
      // 末位再按 TEXT 兜底非数字形态的并列。
      const rows = db.prepare(
        'SELECT ref, session_id, filename, sha256, size, source_task_id, source_run_id, request_id, created_at, status, path '
        + 'FROM session_artifacts WHERE session_id = ? ORDER BY created_at, CAST(ref AS INTEGER), ref',
      ).all(sessionId) as SessionArtifactRow[];
      return rows.map(rowToSessionArtifact);
    },
    async get(sessionId, ref) {
      const row = db.prepare(
        'SELECT ref, session_id, filename, sha256, size, source_task_id, source_run_id, request_id, created_at, status, path '
        + 'FROM session_artifacts WHERE session_id = ? AND ref = ?',
      ).get(sessionId, ref) as SessionArtifactRow | undefined;
      return row ? rowToSessionArtifact(row) : null;
    },
    async setStatus(sessionId, ref, status) {
      db.prepare('UPDATE session_artifacts SET status = ? WHERE session_id = ? AND ref = ?').run(status, sessionId, ref);
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
        'INSERT INTO conversation_events (event_id, principal_id, session_id, kind, content, message_reference, artifact_ref, created_at, request_id, task_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.eventId,
        record.principalId,
        record.sessionId,
        record.kind,
        record.content ?? null,
        serializeMessageReference(record.messageReference),
        record.artifactRef ?? null,
        record.createdAt,
        record.requestId ?? null,
        record.taskId ?? null,
        record.runId ?? null,
      );
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
      const where = [
        'principal_id = ?',
        '(instr(lower(coalesce(content, artifact_ref, \'\')), lower(?)) > 0 '
          + 'OR instr(lower(coalesce(json_extract(message_reference, \'$.text\'), \'\')), lower(?)) > 0)',
      ];
      const values: Array<string | number> = [query.principalId, query.query, query.query];
      if (query.sessionId !== undefined) { where.push('session_id = ?'); values.push(query.sessionId); }
      if (query.before !== undefined) { where.push('created_at < ?'); values.push(query.before); }
      values.push(Math.max(1, Math.min(100, Math.floor(query.limit))));
      const rows = db.prepare(
        `SELECT * FROM conversation_events WHERE ${where.join(' AND ')} ORDER BY event_seq DESC LIMIT ?`,
      ).all(...values) as ConversationEventRow[];
      return rows.reverse().map(rowToConversationEvent);
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
      // 全量重建：不裁剪、不分页。单 plan 步数有界。
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
    async openPlans(principalId, sessionId) {
      // 按 append 顺序倒序扫本会话事实；Map 插入序即"最近活跃的 plan 在前"。
      const rows = db.prepare(
        'SELECT plan_id, step_index, status, total_steps, task_id, request, created_at FROM task_plan_steps '
        + 'WHERE principal_id = ? AND session_id = ? ORDER BY fact_seq DESC',
      ).all(principalId, sessionId) as Array<Pick<TaskPlanStepRow, 'plan_id' | 'step_index' | 'status' | 'total_steps' | 'task_id' | 'request' | 'created_at'>>;
      const plans = new Map<string, {
        maxStep: number; totalSteps: number; firstRequest: string; updatedAt: string;
        counts: Record<TaskPlanStepFact['status'], number>;
      }>();
      for (const row of rows) {
        let entry = plans.get(row.plan_id);
        if (!entry) {
          entry = {
            maxStep: 0, totalSteps: 0, firstRequest: '', updatedAt: row.created_at,
            counts: { started: 0, done: 0, failed: 0, needs: 0 },
          };
          plans.set(row.plan_id, entry);
        }
        entry.maxStep = Math.max(entry.maxStep, row.step_index);
        entry.totalSteps = Math.max(entry.totalSteps, row.total_steps);
        entry.counts[row.status as TaskPlanStepFact['status']] += 1;
        // 倒序扫描：最后写进 entry 的 request 就是最低步号那条的（firstRequest）。
        entry.firstRequest = row.request;
        if (row.created_at > entry.updatedAt) entry.updatedAt = row.created_at;
      }
      const summaries: TaskPlanSummary[] = [];
      for (const [planId, entry] of plans) {
        // 未完成 = 已记录的步号还没接满总步数（拆解被中断在步间）。与 latestOpenPlan 同语义。
        if (entry.maxStep >= entry.totalSteps) continue;
        summaries.push({
          planId,
          totalSteps: entry.totalSteps,
          maxRecordedStep: entry.maxStep,
          started: entry.counts.started,
          done: entry.counts.done,
          failed: entry.counts.failed,
          needs: entry.counts.needs,
          firstRequest: entry.firstRequest,
          updatedAt: entry.updatedAt,
        });
      }
      return summaries;
    },
    async latestOpenPlan(principalId, sessionId) {
      const open = await this.openPlans(principalId, sessionId);
      return open[0]?.planId ?? null;
    },
    async planIdForTask(principalId, sessionId, taskId) {
      const row = db.prepare(
        'SELECT plan_id FROM task_plan_steps WHERE principal_id = ? AND session_id = ? AND task_id = ? ORDER BY fact_seq DESC LIMIT 1',
      ).get(principalId, sessionId, taskId) as { plan_id: string } | undefined;
      return row?.plan_id ?? null;
    },
  };

  const TASK_FACT_SELECT = PLATFORM_TASK_FACT_COLUMNS.map(({ column }) => column).join(', ');
  const platformTasks: PlatformTaskRepo = {
    async get(taskId) {
      const row = db.prepare(
        `SELECT task_id, parent_session_id, principal_id, worker_messages, created_at, updated_at, ${TASK_FACT_SELECT} FROM platform_tasks WHERE task_id = ?`,
      ).get(taskId) as PlatformTaskRow | undefined;
      return row ? rowToPlatformTask(row) : null;
    },
    async upsert(record) {
      const factColumns = PLATFORM_TASK_FACT_COLUMNS.map(({ column }) => column).join(', ');
      const factValues = PLATFORM_TASK_FACT_COLUMNS.map(({ field }) => platformTaskFactValue(field, record[field]));
      const factAssignments = PLATFORM_TASK_FACT_COLUMNS.map(({ column }) => `${column} = excluded.${column}`).join(', ');
      db.prepare(
        // The columns after worker_messages (current_step…skill_version) are retained for
        // compatibility with databases created before the subagent task model. They are no
        // longer part of PlatformTaskRecord and are deliberately ignored on reads and updates.
        // The trailing columns are the P2 structured facts (D-065): absent fields write NULL
        // (this task has no such fact) rather than keeping a stale value.
        `INSERT INTO platform_tasks (task_id, plugin_id, parent_session_id, principal_id, status, worker_messages, current_step, pending_questions, last_result, evidence, skill_version, created_at, updated_at, ${factColumns}) `
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' + ', ?'.repeat(factValues.length) + ') '
        + `ON CONFLICT (task_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, principal_id = excluded.principal_id, worker_messages = excluded.worker_messages, updated_at = excluded.updated_at, ${factAssignments}`,
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
        ...factValues,
      );
    },
    async listBySession(principalId, sessionId) {
      // 时间正序（召回台账按"迄今执行过哪些"的正序呈现）；同一任务多次委派只有一行
      // （upsert 语义），行的 structured facts 是最近一次委派的快照。
      const rows = db.prepare(
        `SELECT task_id, parent_session_id, principal_id, worker_messages, created_at, updated_at, ${TASK_FACT_SELECT} FROM platform_tasks WHERE principal_id = ? AND parent_session_id = ? ORDER BY created_at ASC, task_id ASC`,
      ).all(principalId, sessionId) as PlatformTaskRow[];
      return rows.map(rowToPlatformTask);
    },
  };

  const taskRuns: TaskRunRepo = {
    async createOrGetByDispatchKey(record) {
      const transaction = db.transaction(() => {
        try {
          db.prepare(
            'INSERT INTO task_runs ('
            + 'run_id, task_id, dispatch_key, principal_id, session_id, origin_request_id, origin_user_event_id, request, origin_message, '
            + 'created_at, updated_at, state, started_at, ended_at, deadline, plan_id, step_index, total_steps, last_progress, result_text, '
            + 'result_json, error, result_event_id, input_context_json, delivery_route_json, metadata_json, result_handling_state, delivery_state, delivery_json) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
            + 'ON CONFLICT (dispatch_key) DO NOTHING',
          ).run(
            record.runId,
            record.taskId,
            record.dispatchKey,
            record.principalId,
            record.sessionId,
            record.originRequestId,
            record.originUserEventId,
            record.request,
            record.originMessage,
            record.createdAt,
            record.updatedAt,
            record.state,
            record.startedAt ?? null,
            record.endedAt ?? null,
            record.deadline ?? null,
            record.planId ?? null,
            record.stepIndex ?? null,
            record.totalSteps ?? null,
            record.lastProgress ?? null,
            record.resultText ?? null,
            record.result === undefined ? null : JSON.stringify(record.result),
            record.error ?? null,
            record.resultEventId ?? null,
            record.inputContext === undefined ? null : JSON.stringify(record.inputContext),
            record.deliveryRoute === undefined ? null : JSON.stringify(record.deliveryRoute),
            record.metadata === undefined ? null : JSON.stringify(record.metadata),
            record.resultHandlingState ?? null,
            record.deliveryState ?? null,
            record.delivery === undefined ? null : JSON.stringify(record.delivery),
          );
        } catch (error) {
          // dispatch_key 冲突已被 DO NOTHING 吞掉；能抛到这里的唯一键冲突只剩
          // run_id 主键（新 id 撞车，原样上抛）与每任务单活跃部分索引（D-125：
          // 跨进程/重启竞态下调用方拿到的是未分类 SqliteError）——后者转可识别
          // 错误，判定依据 message 里的列名而不是索引名（SQLite 不报索引名）。
          if (
            (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
            && String((error as Error).message).includes('task_runs.task_id')
          ) {
            throw new TaskRunActiveConflictError(
              `任务 ${record.taskId} 已有活跃 run（每任务单活跃）：dispatchKey=${record.dispatchKey} 的建单被拒。`,
            );
          }
          throw error;
        }
        const row = db.prepare('SELECT * FROM task_runs WHERE dispatch_key = ?').get(record.dispatchKey) as TaskRunRow | undefined;
        if (!row) throw new Error(`task run dispatch was not recorded: ${record.dispatchKey}`);
        return rowToTaskRun(row);
      });
      return transaction();
    },
    async get(runId) {
      const row = db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get(runId) as TaskRunRow | undefined;
      return row ? rowToTaskRun(row) : null;
    },
    async getByDispatchKey(dispatchKey) {
      const row = db.prepare('SELECT * FROM task_runs WHERE dispatch_key = ?').get(dispatchKey) as TaskRunRow | undefined;
      return row ? rowToTaskRun(row) : null;
    },
    async listBySession(principalId, sessionId) {
      const rows = db.prepare(
        'SELECT * FROM task_runs WHERE principal_id = ? AND session_id = ? ORDER BY rowid ASC',
      ).all(principalId, sessionId) as TaskRunRow[];
      return rows.map(rowToTaskRun);
    },
    async listPinnedTaskIds() {
      const rows = db.prepare(
        "SELECT DISTINCT run.task_id FROM task_runs AS run "
        + "WHERE run.state IN ('queued', 'running', 'cancelling') "
        + "OR (run.state IN ('waiting_input', 'waiting_confirmation') AND NOT EXISTS ("
        + 'SELECT 1 FROM task_runs AS newer WHERE newer.task_id = run.task_id AND newer.rowid > run.rowid)) '
        + "OR (run.state IN ('completed', 'failed', 'cancelled', 'interrupted') AND ("
        + "run.delivery_state IS NULL OR run.delivery_state IN ('pending', 'failed', 'unknown') "
        // Pin judgment reads the explicit result_handling_state column, never a JSON path:
        // a writer renaming metadata fields must fail loudly at the contract, not silently
        // pin every terminal run forever.
        + "OR COALESCE(run.result_handling_state, '') <> 'handled')) "
        + 'ORDER BY run.task_id',
      ).all() as Array<{ task_id: string }>;
      return rows.map((row) => row.task_id);
    },
    async listTerminalUnsettledDeliveries() {
      // Crash-recovery leftovers: the run reached a terminal state but delivery never
      // settled (prepared-but-never-sent, or the handling claim 'processing' was never
      // resolved because the in-memory event chain died with the process).
      const rows = db.prepare(
        "SELECT * FROM task_runs "
        + "WHERE state IN ('completed', 'failed', 'cancelled', 'interrupted') "
        + "AND (delivery_state = 'pending' OR result_handling_state = 'processing') "
        + 'ORDER BY rowid',
      ).all() as TaskRunRow[];
      return rows.map(rowToTaskRun);
    },
    async transition(runId, expectedStates, patch, expectedRevision) {
      const immutableFields = new Set([
        'runId', 'taskId', 'dispatchKey', 'principalId', 'sessionId', 'originRequestId', 'originUserEventId',
        'request', 'originMessage', 'createdAt', 'revision', 'planId', 'stepIndex', 'totalSteps',
        'inputContext', 'deliveryRoute',
      ]);
      for (const field of Object.keys(patch)) {
        if (immutableFields.has(field)) throw new Error(`task run field is immutable: ${field}`);
      }
      // patchColumns deliberately omits planId/stepIndex/totalSteps/inputContext/deliveryRoute:
      // they sit in immutableFields above, so listing them here was dead guidance — any patch
      // carrying them throws before the column lookup.
      const patchColumns: Record<string, string> = {
        updatedAt: 'updated_at', state: 'state', startedAt: 'started_at', endedAt: 'ended_at', deadline: 'deadline',
        lastProgress: 'last_progress', resultText: 'result_text', result: 'result_json', error: 'error',
        resultEventId: 'result_event_id', metadata: 'metadata_json', resultHandlingState: 'result_handling_state',
        deliveryState: 'delivery_state', delivery: 'delivery_json',
      };
      const jsonFields = new Set(['result', 'inputContext', 'deliveryRoute', 'metadata', 'delivery']);
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      for (const [field, value] of Object.entries(patch)) {
        const column = patchColumns[field];
        if (!column) throw new Error(`unsupported task run patch field: ${field}`);
        assignments.push(`${column} = ?`);
        values.push(value === undefined ? null : jsonFields.has(field) ? JSON.stringify(value) : value as string | number);
      }
      if (assignments.length === 0) assignments.push('state = state');
      if (expectedStates.length === 0) return false;
      assignments.push('revision = revision + 1');
      values.push(runId, ...expectedStates);
      const placeholders = expectedStates.map(() => '?').join(', ');
      const revisionPredicate = expectedRevision === undefined ? '' : ' AND revision = ?';
      if (expectedRevision !== undefined) values.push(expectedRevision);
      const result = db.prepare(
        `UPDATE task_runs SET ${assignments.join(', ')} WHERE run_id = ? AND state IN (${placeholders})${revisionPredicate}`,
      ).run(...values);
      return result.changes === 1;
    },
    async interruptActive(now) {
      const transaction = db.transaction(() => db.prepare(
        "UPDATE task_runs SET state = 'interrupted', updated_at = ?, ended_at = COALESCE(ended_at, ?), revision = revision + 1 WHERE state IN ('queued', 'running', 'cancelling')",
      ).run(now, now).changes);
      return transaction();
    },
  };

  const changeIntents: ChangeIntentRepo = {
    async create(record) {
      const columns = ['intent_id', 'principal_id', 'session_id', 'proposal_id', 'task_id', 'confirm_code_hash', 'status', 'created_at', 'expires_at'];
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO change_intents (${columns.join(', ')}, ${CHANGE_INTENT_LEGACY_COLUMNS.join(', ')}) `
        + `VALUES (${placeholders}${', ?'.repeat(CHANGE_INTENT_LEGACY_COLUMNS.length)})`,
      ).run(
        record.intentId,
        record.principalId,
        record.sessionId,
        record.proposalId ?? null,
        record.taskId ?? null,
        record.confirmCodeHash,
        record.status,
        record.createdAt,
        record.expiresAt,
        // 历史列只补空串兼容值（旧库 NOT NULL 无缺省）；业务数据一行都不再进宿主库。
        ...CHANGE_INTENT_LEGACY_COLUMNS.map(() => ''),
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
    async findPendingBySession(principalId, sessionId, taskId) {
      const row = db.prepare(
        `SELECT * FROM change_intents WHERE principal_id = ? AND session_id = ? AND status = ?${taskId === undefined ? '' : ' AND task_id = ?'} ORDER BY created_at DESC LIMIT 1`,
      ).get(principalId, sessionId, 'pending', ...(taskId === undefined ? [] : [taskId])) as ChangeIntentRow | undefined;
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

  const store: AuditStore = { principalScopes, requests, toolCalls, sessions, conversationLog, taskPlans, platformTasks, changeIntents, sessionArtifacts, taskRuns };
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
