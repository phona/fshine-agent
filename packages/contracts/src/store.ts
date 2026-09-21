/**
 * 最小持久记录与仓库接口(架构 §7)。
 * 实现选 SQLite,但逻辑记录形状不变;迁移生产库不是架构变更。
 */

export type RequestOutcome = 'replied' | 'denied' | 'failed';

import type { AccountSetScope, PrincipalCapability } from './config';

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

export interface PlatformTaskRecord {
  taskId: string;
  parentSessionId: string;
  principalId: string;
  /** Pi AgentMessage[]; kept opaque at the contracts boundary. */
  workerMessages: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface PlatformTaskRepo {
  get(taskId: string): Promise<PlatformTaskRecord | null>;
  upsert(record: PlatformTaskRecord): Promise<void>;
}

/**
 * 变更意图（两步确认写开放的持久化状态机）。
 * 模型只准备（提案 payload 冻结于此），用户凭确认码签名，服务端代码执行——
 * 确认码哈希存储，明文只出现在发给用户的预览消息里。
 */
export interface ChangeIntentRecord {
  intentId: string;
  principalId: string;
  /** 主会话 id（wecom:<user>:<conversation>），确认码绑定于此 */
  sessionId: string;
  kind: 'voucher.batch';
  accountSet: string;
  period: string;
  /** 冻结提案：{type, domain, accountSet, period, contracts, summary} */
  payload: unknown;
  summary: { count: number; debit: number; credit: number };
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
  findPendingBySession(principalId: string, sessionId: string): Promise<ChangeIntentRecord | null>;
  /** 按确认码哈希查最新意图（任意状态）——过期/已完成/作废的确定性答复用 */
  findByCodeHash(principalId: string, sessionId: string, codeHash: string): Promise<ChangeIntentRecord | null>;
  updateStatus(intentId: string, status: ChangeIntentRecord['status'], result?: unknown): Promise<void>;
}

/** Repository aggregate used by the application and Agent adapters. */
export interface AuditStore {
  principalScopes: PrincipalScopeRepo;
  requests: AgentRequestRepo;
  toolCalls: ToolCallRepo;
  sessions: ConversationSessionRepo;
  /** Optional for backwards-compatible test stores and deployments. */
  platformTasks?: PlatformTaskRepo;
  /** Optional：缺省时写流程整体禁用（提案按普通回答处理）。 */
  changeIntents?: ChangeIntentRepo;
}
