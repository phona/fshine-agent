/**
 * 最小持久记录与仓库接口(架构 §7)。
 * 实现选 SQLite,但逻辑记录形状不变;迁移生产库不是架构变更。
 */

export type RequestOutcome = 'replied' | 'denied' | 'failed';

import type { PrincipalCapability } from './config';

export interface PrincipalScopeRecord {
  wecomUserId: string;
  accountSetIds: string[];
  mcpProfile: string;
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
  /** 瞬态会话状态(如澄清候选账套列表),JSON 序列化;过期由 host 按 sessionTtlMs 判定 */
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

/** 仓库聚合;host/runtime 只依赖此接口,不接触 SQL。 */
export interface AuditStore {
  principalScopes: PrincipalScopeRepo;
  requests: AgentRequestRepo;
  toolCalls: ToolCallRepo;
  sessions: ConversationSessionRepo;
}
