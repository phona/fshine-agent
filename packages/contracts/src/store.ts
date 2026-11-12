/**
 * 最小持久记录与仓库接口(架构 §7)。
 * 实现选 SQLite,但逻辑记录形状不变;迁移生产库不是架构变更。
 */

/**
 * 请求结局。
 *
 * `attachment_received`（2026-10-07 新增）：用户只发了附件、没有正文。这类消息不启 Agent
 * 回合（否则"先发文件再发指令"会变成 N 次 LLM 调用并串行堵住队列），只暂存附件等后续指令，
 * 但仍要落审计——"这一轮用户给了什么"正是排查时最缺的证据。它与 replied 的区别是**没有产生
 * 任何回答**，统计与排查时不能混为一谈。
 */
export type RequestOutcome = 'replied' | 'denied' | 'failed' | 'attachment_received';

import type { AccountSetScope, PrincipalCapability } from './config';
import type { ChannelRoute, IncomingMessageReference } from './channel';
import type { TurnInputContext } from './runtime';

export interface PrincipalScopeRecord {
  wecomUserId: string;
  accountSetIds: string[];
  /** 旧持久化记录缺省按 allowlist 解释。 */
  accountSetScope?: AccountSetScope;
  enabled: boolean;
  /** Effective capabilities. Legacy records are treated as read-only. */
  capabilities?: PrincipalCapability[];
}

export interface AgentRequestRecord {
  requestId: string;
  wecomMessageId: string;
  principalId: string;
  /** 用户原始输入 */
  input: string;
  /** ISO 8601 */
  createdAt: string;
  outcome: RequestOutcome;
}

export interface ToolCallRecord {
  requestId: string;
  traceId?: string;
  toolName: string;
  /** 脱敏后的入参快照(无凭据、无文件路径) */
  safeArguments: Record<string, unknown>;
  /** 来自 meta.source */
  source?: string;
  /** ISO 8601 */
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'ok' | 'error';
  errorCode?: string;
  artifactId?: string;
}

export interface ConversationSessionRecord {
  sessionId: string;
  principalId: string;
  /** 渠道会话标识(wecomUserId + conversationId 推导) */
  channelConversationId: string;
  /** ISO 8601 */
  updatedAt: string;
  /** Main Agent transcript, serialized as JSON; runtime applies session TTL. */
  state?: unknown;
}

export interface PrincipalScopeRepo {
  get(wecomUserId: string): Promise<PrincipalScopeRecord | null>;
  list(): Promise<PrincipalScopeRecord[]>;
  upsert(record: PrincipalScopeRecord): Promise<void>;
}

export interface AgentRequestRepo {
  insert(record: AgentRequestRecord): Promise<void>;
  get(requestId: string): Promise<AgentRequestRecord | null>;
  findByWecomMessageId(wecomMessageId: string): Promise<AgentRequestRecord | null>;
  setOutcome(requestId: string, outcome: RequestOutcome): Promise<void>;
  /**
   * 本 principal 最近登记的附件接收记录（outcome='attachment_received'）。
   *
   * 为什么需要：附件关联若只在进程内存里，服务一重启就失记——用户早先上传的文件还在盘上，
   * 但 worker 拿到的请求里一个路径都没有，于是它如实回"没有数据"而用户无法理解。落库的
   * 登记因此不只是审计，也是重启后的恢复源。取 input 由调用方解析（附件信封）。
   *
   * 可选：旧库/测试替身没有它时，恢复静默退化为"只用内存"。
   */
  listRecentAttachments?(principalId: string, sinceIso: string): Promise<Array<Pick<AgentRequestRecord, 'input'>>>;
}

export interface ToolCallRepo {
  insert(record: ToolCallRecord): Promise<void>;
  finish(requestId: string, patch: Partial<Omit<ToolCallRecord, 'requestId' | 'toolName' | 'safeArguments' | 'startedAt'>>): Promise<void>;
  listByRequest(requestId: string): Promise<ToolCallRecord[]>;
}

export interface ConversationSessionRepo {
  get(sessionId: string): Promise<ConversationSessionRecord | null>;
  upsert(record: ConversationSessionRecord): Promise<void>;
}

export type ConversationEventKind = 'user_message' | 'assistant_message' | 'tool_result' | 'plan_event' | 'clarification_event' | 'task_event';

/**
 * Append-only message/tool/plan event. Keep only safe, searchable text or an artifact reference.
 *
 * `clarification_event`（选择类澄清的状态留痕，宿主机械绑定用）：内容是结构化 JSON——
 * `{status:'issued', code, query, candidates, requestId}`（宿主发出澄清时）与
 * `{status:'resolved', selected, requestId}`（用户的裸编号/候选名答复被宿主绑定到时）。
 * 绑定判据只认这两个状态与候选名本身（数据），不解析任何用户自然语言。
 */
export interface ConversationEventRecord {
  eventId: string;
  principalId: string;
  sessionId: string;
  kind: ConversationEventKind;
  content?: string;
  /** Structured inbound quote; content continues to contain only the current message body. */
  messageReference?: IncomingMessageReference;
  artifactRef?: string;
  createdAt: string;
  requestId?: string;
  taskId?: string;
  runId?: string;
}

/** State of one Worker invocation; a task can have several runs over its lifetime. */
export type TaskRunState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_input'
  | 'waiting_confirmation'
  | 'interrupted';

/** Durable background Worker invocation metadata. Runtime-only callbacks and credentials stay out of storage. */
export interface TaskRunRecord {
  runId: string;
  taskId: string;
  /** Host-generated idempotency key for the source dispatch event/tool call. */
  dispatchKey: string;
  principalId: string;
  sessionId: string;
  originRequestId: string;
  originUserEventId: string;
  /** Prepared request passed to the execution layer. */
  request: string;
  /** Original message/request snapshot used to anchor future continuation. */
  originMessage: string;
  createdAt: string;
  updatedAt: string;
  state: TaskRunState;
  startedAt?: string;
  endedAt?: string;
  deadline?: string;
  planId?: string;
  stepIndex?: number;
  totalSteps?: number;
  lastProgress?: string;
  resultText?: string;
  result?: unknown;
  error?: string;
  resultEventId?: string;
  inputContext?: TurnInputContext;
  deliveryRoute?: ChannelRoute;
  /**
   * Host-owned result-handling state machine state ('processing' | 'handled' | 'failed').
   * Persisted as an explicit column so storage-level queries (GC pins, crash-recovery
   * sweeps) never sniff it out of `metadata`. Absent = the result was never claimed.
   * `metadata.resultHandling` keeps the machine's other details (eventId/requestId/
   * replyText/artifactRefs/error) and its `state` field is mirrored, not authoritative.
   */
  resultHandlingState?: 'processing' | 'handled' | 'failed';
  /**
   * Host-owned input/output snapshot details; opaque to generic storage. The
   * resultHandling.state written here by apps/server is a mirror only — storage
   * queries read the `resultHandlingState` field above instead.
   */
  metadata?: Record<string, unknown>;
  deliveryState?: 'pending' | 'sent' | 'failed' | 'unknown' | 'not_required';
  /** Opaque delivery item states / receipts. */
  delivery?: unknown;
  /** Repository-owned CAS token. Older/non-SQLite repositories may omit it. */
  revision?: number;
}

/** Stable completion event emitted from a persisted run. */
export interface BackgroundTaskEvent {
  eventId: string;
  run: TaskRunRecord;
  result?: unknown;
  error?: string;
}

export interface TaskRunRepo {
  /**
   * Unique dispatchKey: repeated submissions return the original run without replacing it.
   * 失败形态（D-125）：同 taskId 已存在活跃 run（每任务单活跃部分唯一索引）时抛
   * TaskRunActiveConflictError——调用方可据此回复"已有 Worker 在跑"，而不是接住
   * 未分类的底层约束错误。
   */
  createOrGetByDispatchKey(record: TaskRunRecord): Promise<TaskRunRecord>;
  get(runId: string): Promise<TaskRunRecord | null>;
  getByDispatchKey(dispatchKey: string): Promise<TaskRunRecord | null>;
  /** Oldest registration first; timestamps and delivery updates do not determine run order. */
  listBySession(principalId: string, sessionId: string): Promise<TaskRunRecord[]>;
  /** Compare-and-set state update; false means the current state did not match. */
  transition(runId: string, expectedStates: readonly TaskRunState[], patch: Partial<TaskRunRecord>, expectedRevision?: number): Promise<boolean>;
  /** Global task workspaces protected from GC by active/waiting work or unhandled delivery results. */
  listPinnedTaskIds(): Promise<string[]>;
  /**
   * Terminal runs whose delivery never settled (deliveryState 'pending', or the result
   * handling state machine still 'processing'). These are crash-recovery leftovers: the
   * completion event lived only on an in-memory promise chain that died with the process.
   * Optional: older test stores/deployments without it simply find nothing to sweep.
   */
  listTerminalUnsettledDeliveries?(): Promise<TaskRunRecord[]>;
  /** Mark only runs left queued/running/cancelling by a previous process as interrupted. */
  interruptActive(now: string): Promise<number>;
}

export interface ConversationLogQuery {
  principalId: string;
  sessionId?: string;
  query?: string;
  /** Return events after this append-order cursor (used by state rebuild/catch-up). */
  afterEventId?: string;
  before?: string;
  limit: number;
}

export interface ConversationLogRepo {
  /** Repeating an identical eventId/content is a no-op; reusing an id for different data is an error. */
  append(record: ConversationEventRecord): Promise<void>;
  list(query: ConversationLogQuery): Promise<ConversationEventRecord[]>;
  search(query: ConversationLogQuery & { query: string }): Promise<ConversationEventRecord[]>;
}

export interface ContextStateRecord {
  principalId: string;
  sessionId: string;
  updatedAt: string;
  throughEventId: string;
  reducerVersion: number;
  state: unknown;
}

export interface ContextStateRepo {
  get(principalId: string, sessionId: string): Promise<ContextStateRecord | null>;
  upsert(record: ContextStateRecord): Promise<void>;
}

/** 任务计划的一步事实（append-only）。一次长任务拆解的所有 step 共享 planId。 */
export interface TaskPlanStepFact {
  factId: string;              // append-order 唯一 id
  principalId: string;
  sessionId: string;
  planId: string;              // 一次拆解的标识（宿主持有；跨回合续跑同一拆解时不变）
  stepIndex: number;           // 1-based
  totalSteps: number;          // N；来自 request 的「第N/M步」标记，未知为 0
  taskId?: string;             // 该步委派的执行层子任务（宿主回填）
  request: string;             // 该步加工后的请求原文
  status: 'started' | 'done' | 'failed' | 'needs';
  summary?: string;            // 结果摘要（宿主截断，≤500 字）
  createdAt: string;           // ISO
}

export interface TaskPlanProjection {
  planId: string;
  sessionId: string;
  totalSteps: number;
  started: number;
  done: number;
  failed: number;
  needs: number;
  steps: Array<{ stepIndex: number; status: TaskPlanStepFact['status']; taskId?: string; summary?: string }>;
  updatedAt: string;
}

/** 未完成计划的可读摘要（按最近活跃在前），供跨回合续跑召回与多任务消歧。 */
export interface TaskPlanSummary {
  planId: string;
  totalSteps: number;
  /** 已记录的最大步号（判"续跑步号接得上"用）。 */
  maxRecordedStep: number;
  started: number;
  done: number;
  failed: number;
  needs: number;
  /** 拆解第一步的加工后请求（截断），用于生成用户可读的选项标签。 */
  firstRequest: string;
  /** 该计划最后一条事实的时间（ISO）。 */
  updatedAt: string;
}

export interface TaskPlanRepo {
  append(fact: TaskPlanStepFact): Promise<void>;
  /** 由 facts 重建投影（同 Context State 的可重建投影语义）；没有事实返回 null。 */
  project(principalId: string, sessionId: string, planId: string): Promise<TaskPlanProjection | null>;
  /**
   * 全部未完成（已记录步号 < totalSteps）的计划，最近活跃在前；没有返回空数组。
   * 跨回合续跑的召回器：恰一个候选可机械续跑，多个候选由宿主把歧义抛给用户。
   */
  openPlans(principalId: string, sessionId: string): Promise<TaskPlanSummary[]>;
  /** 最近一个未完成计划的 planId；openPlans()[0] 的便捷形式，没有返回 null。 */
  latestOpenPlan(principalId: string, sessionId: string): Promise<string | null>;
  /** 某执行层子任务所属的计划（taskId 记录在步骤终态事实上）；没有返回 null。 */
  planIdForTask(principalId: string, sessionId: string, taskId: string): Promise<string | null>;
}

export type MemoryRecordType = 'preference' | 'fact';
export type MemoryRecordStatus = 'active' | 'conflicted' | 'superseded' | 'deleted';

/** Durable long-memory fact with immutable source-event references and optimistic versioning. */
export interface MemoryRecordRecord {
  memoryId: string;
  principalId: string;
  key: string;
  type: MemoryRecordType;
  content: string;
  status: MemoryRecordStatus;
  sourceEventIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecordRepo {
  listByPrincipal(principalId: string): Promise<MemoryRecordRecord[]>;
  /** Last successfully consolidated user source event; null means not started. */
  getCursor(principalId: string): Promise<string | null>;
  /**
   * Atomically compare the principal cursor and record versions, write the full principal snapshot,
   * then move the cursor. Returns false without writes on stale cursor/version data.
   */
  commit(principalId: string, expectedCursor: string | null, nextCursor: string | null, records: readonly MemoryRecordRecord[]): Promise<boolean>;
}

/**
 * 一次计划调用（宿主从 worker 提交的计划命令机械解析出来的形状，**不是**从 worker
 * 文本解析）：operation 是平台注册名，args 是命令行原样参数数组。
 */
export interface PlatformTaskCall {
  operation: string;
  args: unknown[];
}

export interface PlatformTaskRecord {
  taskId: string;
  parentSessionId: string;
  principalId: string;
  /** Pi AgentMessage[]; kept opaque at the contracts boundary. */
  workerMessages: unknown[];
  createdAt: string;
  updatedAt: string;
  // ── P2 结构化执行事实（D-065）───────────────────────────────────────────
  // 全部由委派时的**确定性信息**回填：plan calls 是宿主自己解析的（worker 提交的计划
  // 命令），取值按执行层声明面的声明名逐位查表机械提取——绝不从 worker 文本解析，通用
  // 契约也不焊任何执行层的参数名。字段缺失（旧任务 / 无计划的委派）时消费方降级，
  // 不猜、不补。
  /** 执行层声明的范围取值（对象 / 窗口等，按声明序）——宿主只存与渲染，不解释其语义。 */
  scopeValues?: string[];
  /** 本任务迄今提交过的计划调用（宿主解析，机械事实）。 */
  calls?: PlatformTaskCall[];
  /** 首个 operation 的中文标签（平台清单第 5 列，写入时解析一次）。 */
  label?: string;
  /** 委派结局：done=有平台执行 / needs=缺信息可续 / failed=失败。 */
  outcome?: 'done' | 'needs' | 'failed';
  /** 用户可见的结果原文（与 Conversation Log 的 tool_result 同文，召回渲染的兜底源）。 */
  resultText?: string;
}

export interface PlatformTaskRepo {
  get(taskId: string): Promise<PlatformTaskRecord | null>;
  upsert(record: PlatformTaskRecord): Promise<void>;
  /**
   * 按 principal/会话列举平台任务（时间正序）。
   *
   * 消费者 = `packages/agent/src/execution-facts.ts` 的召回事实台账（D-065）：召回轮
   * 要回答"本会话迄今执行过哪些/结果是什么"，需要按会话列举 + 结构化字段。语义是
   * "存在即记录"（任务记录没有终态字段，与已删除的 listOpenBySession 同）——失败/缺
   * 信息的任务同样在册，结局由 record.outcome 表达。
   */
  listBySession(principalId: string, sessionId: string): Promise<PlatformTaskRecord[]>;
}

/**
 * 变更意图（两步确认写开放的持久化状态机）。
 *
 * **方案 1 · C 波后宿主持有的只有一张取物单**：提案 payload 由执行层自己的提案状态库
 * 持有（不透明、宿主不读不解析），本记录因此零业务字段、零 payload——只有确认状态机
 * 必需的四样东西：谁发的（principalId / sessionId）、确认码哈希、有效期与结局，加上
 * 指向平台提案的引用 proposalId（唯一判别：带 → 平台提案落账；不带 → 迁移前的旧行业，
 * 一律按过期处理，不 commit）。
 *
 * 迁移前的五列历史列（业务字段 + 冻结载荷）已从契约删除；它们仍留在 SQLite 表里做历史，
 * 但不再被读、也不再被写（列名与兼容值见 packages/core/src/store.ts 的前向迁移）。
 * 影子期还在跑的旧文本路径（它自己的私有记录形状，曾住在 context.ts 内）已随 C 波整体
 * 删除，不回到本契约。
 */
export interface ChangeIntentRecord {
  intentId: string;
  principalId: string;
  /** 主会话 id（wecom:<user>:<conversation>），确认码绑定于此 */
  sessionId: string;
  /** 发起本次提案的平台子任务（关联执行事实与结局回填用）。 */
  taskId?: string;
  /**
   * 执行层提案引用（取物单）。缺省 = 迁移前的旧行业，或宿主不再持有载荷的记录——
   * 上层据此判过期（W5：不 commit）。
   */
  proposalId?: string;
  /** 确认码哈希存储，明文只出现在发给用户的预览消息里。 */
  confirmCodeHash: string;
  status: 'pending' | 'committed' | 'expired' | 'cancelled' | 'superseded' | 'failed';
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  /** commit 结果（读回校验输出摘要） */
  result?: unknown;
}

export interface ChangeIntentRepo {
  create(record: ChangeIntentRecord): Promise<void>;
  get(intentId: string): Promise<ChangeIntentRecord | null>;
  /** 命中确认码的未过期意图；过期意图就地标记 expired 后返回 null */
  findPendingByConfirm(principalId: string, sessionId: string, codeHash: string, now: Date): Promise<ChangeIntentRecord | null>;
  /** 该会话当前的 pending 意图（新提案创建前将其置 superseded） */
  findPendingBySession(principalId: string, sessionId: string, taskId?: string): Promise<ChangeIntentRecord | null>;
  /** 按确认码哈希查最新意图（任意状态）——过期/已完成/作废的确定性答复用 */
  findByCodeHash(principalId: string, sessionId: string, codeHash: string): Promise<ChangeIntentRecord | null>;
  updateStatus(intentId: string, status: ChangeIntentRecord['status'], result?: unknown): Promise<void>;
}

/** Repository aggregate used by the application and Agent adapters. */
/**
 * 会话级产物记录（W2 产物库，2026-10-20）。
 *
 * 为什么需要：交付曾经是"回合末把字节流进渠道消息"的一次性副作用——不停留、不登记，
 * 系统里再没有任何结构知道"这个会话交付过什么"。用户说"把那个表再发一次"时，Main
 * Agent 只能凭对话散文里提到的路径复述，而复述会损坏（2026-10-20 实证：委派文本里
 * 出现编造的 `/tmp/task_<uuid>` 路径，worker 拿着它 ls 失败后满目录 hunt）。
 *
 * 库只存"ref ↔ 交付回合 ↔ 产生任务"的映射；溯源细节（读了哪些输入、何时委派、
 * worker 摘要）从 platform_tasks.worker_messages 投影，不建平行登记表。
 */
export interface SessionArtifactRecord {
  /** 会话内单调 ref（'1'、'2'…）：用户可见清单与宿主解析的内部句柄。 */
  ref: string;
  sessionId: string;
  filename: string;
  sha256: string;
  size: number;
  /** 产生该产物的平台任务（溯源投影键，可缺失：非委派回合的交付）。 */
  sourceTaskId?: string;
  /** 具体运行的溯源键；一个续跑 taskId 可对应多个 Worker run。 */
  sourceRunId?: string;
  /** 交付回合的请求 ID。 */
  requestId?: string;
  /** ISO 8601（UTC），入库（=交付）时刻。 */
  createdAt: string;
  /** available = 可重发；evicted = 已淘汰（清单仍展示，重发答"已过期需重算"）。 */
  status: 'available' | 'evicted';
  /** 库内字节的绝对路径：scratch 被 GC 后产物仍可寻址。 */
  path: string;
}

/** Session artifact ref conflict（D-123）：同会话同 ref 重复 insert，fail-loud 不覆盖。 */
export class SessionArtifactRefConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionArtifactRefConflictError';
  }
}

/** 同 taskId 已有活跃 run（每任务单活跃不变量，D-125）：建单被拒的可识别失败形态。 */
export class TaskRunActiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskRunActiveConflictError';
  }
}

export interface SessionArtifactRepo {
  /**
   * Fail-loud（D-123）：同会话同 ref 已存在时抛 SessionArtifactRefConflictError，
   * 不做覆盖 upsert——覆盖会让并发分到重叠 ref 的后写吃掉前写的登记（字节留孤儿、
   * ref 指向新文件）。ref 分配与 insert 须在调用方的会话串行段内完成。
   */
  insert(record: SessionArtifactRecord): Promise<void>;
  /** 按入库时间正序（清单与 ref 单调性同源）。 */
  listBySession(sessionId: string): Promise<SessionArtifactRecord[]>;
  get(sessionId: string, ref: string): Promise<SessionArtifactRecord | null>;
  setStatus(sessionId: string, ref: string, status: SessionArtifactRecord['status']): Promise<void>;
}

export interface AuditStore {
  principalScopes: PrincipalScopeRepo;
  requests: AgentRequestRepo;
  toolCalls: ToolCallRepo;
  sessions: ConversationSessionRepo;
  conversationLog: ConversationLogRepo;
  contextStates: ContextStateRepo;
  /** 任务计划状态：append-only 步骤事实 + 可重建投影（长任务拆解）。 */
  taskPlans: TaskPlanRepo;
  /** Optional for older test stores and deployments. */
  memoryRecords?: MemoryRecordRepo;
  /** Optional for backwards-compatible test stores and deployments. */
  platformTasks?: PlatformTaskRepo;
  /** Optional：缺省时写流程整体禁用（提案按普通回答处理）。 */
  changeIntents?: ChangeIntentRepo;
  /** Optional：会话级产物库（W2）。缺省时交付不入库、不注入清单（旧替身/旧部署退化）。 */
  sessionArtifacts?: SessionArtifactRepo;
  /** Optional on legacy test stores; the SQLite implementation always provides background run storage. */
  taskRuns?: TaskRunRepo;
}
