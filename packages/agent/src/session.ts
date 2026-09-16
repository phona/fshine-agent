/**
 * 会话瞬态状态(澄清候选 + 翻页游标),JSON 序列化存 conversation_session.state。
 * TTL 语义:候选过期后不复活,重新走搜索(实施决策 §5)。
 */
import type { ConversationSessionRecord, ConversationSessionRepo } from '@fshine/contracts';
import { createHash, randomUUID } from 'node:crypto';

export type SessionStore = Pick<ConversationSessionRepo, 'get' | 'upsert'>;

export interface PendingCandidate {
  id: string;
  name: string;
}

export interface LastVoucherQuery {
  accountSetId: string;
  accountSetName: string;
  period: string;
  nextCursor?: string;
}

export interface AgentSessionState {
  pendingCandidates?: PendingCandidate[];
  /** pendingCandidates 的过期时间,ISO 8601 */
  expiresAt?: string;
  /** 触发澄清时的用户原始请求(选中候选后还原意图用) */
  pendingRequest?: string;
  lastVoucherQuery?: LastVoucherQuery;
  /** 待用户确认的写入意图;仅 V1 写入流程使用,默认不设置。 */
  pendingWriteIntent?: PendingWriteIntent;
  /** 有界对话历史(仅用户消息与最终回复),供追问/指代参考 */
  history?: TurnHistoryEntry[];
}

/**
 * 写入确认绑定的不可变摘要。payload 本身不持久化,避免在会话状态中留下财务数据。
 * 调用方必须在提交前重新提供完全相同的 payload 并通过 confirmWriteIntent 校验。
 */
export interface PendingWriteIntent {
  toolName: string;
  payloadHash: string;
  accountSetId: string;
  principalId: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface CreateWriteIntentInput {
  toolName: string;
  payload: unknown;
  accountSetId: string;
  principalId: string;
  ttlMs: number;
  idempotencyKey?: string;
}

export interface ConfirmWriteIntentInput {
  toolName: string;
  payload: unknown;
  accountSetId: string;
  principalId: string;
}

export type ConfirmWriteIntentResult =
  | { ok: true; intent: PendingWriteIntent }
  | { ok: false; reason: 'missing' | 'expired' | 'principal_mismatch' | 'account_set_mismatch' | 'tool_mismatch' | 'payload_mismatch' };

/** Stable JSON encoding for hashing request payloads (object key order independent). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

export function writePayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/** Create/replace a pending intent. Call this only after a successful validation step. */
export function createWriteIntent(state: AgentSessionState, input: CreateWriteIntentInput, now = Date.now()): PendingWriteIntent {
  if (!input.toolName || !input.accountSetId || !input.principalId || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error('invalid write intent');
  }
  const intent: PendingWriteIntent = {
    toolName: input.toolName,
    payloadHash: writePayloadHash(input.payload),
    accountSetId: input.accountSetId,
    principalId: input.principalId,
    expiresAt: new Date(now + input.ttlMs).toISOString(),
    idempotencyKey: input.idempotencyKey ?? `wi_${randomUUID()}`,
  };
  state.pendingWriteIntent = intent;
  return intent;
}

/** Validate and consume a pending intent. Successful confirmation is single-use. */
export function confirmWriteIntent(state: AgentSessionState, input: ConfirmWriteIntentInput, now = Date.now()): ConfirmWriteIntentResult {
  const intent = state.pendingWriteIntent;
  if (!intent) return { ok: false, reason: 'missing' };
  const expiresAt = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    state.pendingWriteIntent = undefined;
    return { ok: false, reason: 'expired' };
  }
  if (intent.principalId !== input.principalId) return { ok: false, reason: 'principal_mismatch' };
  if (intent.accountSetId !== input.accountSetId) return { ok: false, reason: 'account_set_mismatch' };
  if (intent.toolName !== input.toolName) return { ok: false, reason: 'tool_mismatch' };
  if (intent.payloadHash !== writePayloadHash(input.payload)) return { ok: false, reason: 'payload_mismatch' };
  state.pendingWriteIntent = undefined;
  return { ok: true, intent };
}

export function freshPendingWriteIntent(state: AgentSessionState, now = Date.now()): PendingWriteIntent | null {
  const intent = state.pendingWriteIntent;
  if (!intent) return null;
  const expiresAt = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    state.pendingWriteIntent = undefined;
    return null;
  }
  return intent;
}

export interface TurnHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  /** ISO 8601 */
  at: string;
}

export const HISTORY_MAX_ENTRIES = 10;
export const HISTORY_MAX_CHARS = 12_000;
/** 单条回复入库上限:与渠道 2048 字节截断同量级,防止单条历史膨胀 */
const HISTORY_ENTRY_MAX_CHARS = 2_000;

/** 追加一轮回合并做有界裁剪:最多保留最近 HISTORY_MAX_ENTRIES 条,总量超限从最旧丢起 */
export function appendTurnHistory(
  existing: TurnHistoryEntry[] | undefined,
  userText: string,
  assistantText: string,
  now = new Date(),
): TurnHistoryEntry[] {
  const at = now.toISOString();
  const clip = (text: string) => (text.length > HISTORY_ENTRY_MAX_CHARS ? text.slice(0, HISTORY_ENTRY_MAX_CHARS) : text);
  const next: TurnHistoryEntry[] = [
    ...(existing ?? []),
    { role: 'user', content: clip(userText), at },
    { role: 'assistant', content: clip(assistantText), at },
  ];
  let kept = next.slice(-HISTORY_MAX_ENTRIES);
  const totalChars = () => kept.reduce((sum, entry) => sum + entry.content.length, 0);
  while (kept.length > 2 && totalChars() > HISTORY_MAX_CHARS) kept = kept.slice(2);
  return kept;
}

function parseHistory(raw: unknown): TurnHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TurnHistoryEntry[] = [];
  for (const item of raw) {
    const record = item as { role?: unknown; content?: unknown; at?: unknown };
    if ((record.role === 'user' || record.role === 'assistant') && typeof record.content === 'string') {
      out.push({
        role: record.role,
        content: record.content,
        at: typeof record.at === 'string' ? record.at : '',
      });
    }
  }
  return out;
}

export interface LoadedSession {
  state: AgentSessionState;
  record: ConversationSessionRecord | null;
}

export async function loadSessionState(store: SessionStore, sessionId: string): Promise<LoadedSession> {
  let record: ConversationSessionRecord | null = null;
  try {
    record = await store.get(sessionId);
  } catch (error) {
    // 不阻塞回复,但必须可见:静默退化成无状态最难排查
    console.error(JSON.stringify({ event: 'session_load_failed', sessionId, error: error instanceof Error ? error.message : String(error) }));
    record = null;
  }
  return { state: parseState(record?.state), record };
}

/** 存储失败不阻塞本轮回复:回复优先,审计由 host 负责。 */
export async function saveSessionState(
  store: SessionStore,
  sessionId: string,
  principalId: string,
  state: AgentSessionState,
  previous: ConversationSessionRecord | null,
): Promise<void> {
  const record: ConversationSessionRecord = {
    sessionId,
    principalId: previous?.principalId ?? principalId,
    channelConversationId: previous?.channelConversationId ?? sessionId,
    updatedAt: new Date().toISOString(),
    state,
  };
  try {
    await store.upsert(record);
  } catch (error) {
    // 忽略:会话状态属瞬态优化,不使本轮回复失败;但留痕
    console.error(JSON.stringify({ event: 'session_save_failed', sessionId, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** 容错解析:core 存 SQLite 可能回传 JSON 字符串,host 内存实现回传对象。 */
export function parseState(raw: unknown): AgentSessionState {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const state: AgentSessionState = {};
  if (Array.isArray(obj.pendingCandidates)) {
    const candidates = obj.pendingCandidates
      .map(parseCandidate)
      .filter((item): item is PendingCandidate => item !== null);
    if (candidates.length > 0) state.pendingCandidates = candidates;
  }
  if (typeof obj.expiresAt === 'string' && obj.expiresAt) state.expiresAt = obj.expiresAt;
  if (typeof obj.pendingRequest === 'string' && obj.pendingRequest) state.pendingRequest = obj.pendingRequest;
  const history = parseHistory(obj.history);
  if (history.length > 0) state.history = history;
  const last = parseLastVoucherQuery(obj.lastVoucherQuery);
  if (last) state.lastVoucherQuery = last;
  const writeIntent = parsePendingWriteIntent(obj.pendingWriteIntent);
  if (writeIntent) state.pendingWriteIntent = writeIntent;
  return state;
}

function parsePendingWriteIntent(raw: unknown): PendingWriteIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.toolName !== 'string' || !item.toolName) return null;
  if (typeof item.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.payloadHash)) return null;
  if (typeof item.accountSetId !== 'string' || !item.accountSetId) return null;
  if (typeof item.principalId !== 'string' || !item.principalId) return null;
  if (typeof item.expiresAt !== 'string' || !item.expiresAt || !Number.isFinite(Date.parse(item.expiresAt))) return null;
  if (typeof item.idempotencyKey !== 'string' || !item.idempotencyKey) return null;
  return {
    toolName: item.toolName,
    payloadHash: item.payloadHash,
    accountSetId: item.accountSetId,
    principalId: item.principalId,
    expiresAt: item.expiresAt,
    idempotencyKey: item.idempotencyKey,
  };
}

function parseCandidate(raw: unknown): PendingCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { id?: unknown }).id;
  const name = (raw as { name?: unknown }).name;
  if (typeof id === 'string' && id && typeof name === 'string') return { id, name };
  return null;
}

function parseLastVoucherQuery(raw: unknown): LastVoucherQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const accountSetId = (raw as { accountSetId?: unknown }).accountSetId;
  const accountSetName = (raw as { accountSetName?: unknown }).accountSetName;
  const period = (raw as { period?: unknown }).period;
  if (typeof accountSetId !== 'string' || !accountSetId) return null;
  if (typeof accountSetName !== 'string' || typeof period !== 'string') return null;
  const nextCursor = (raw as { nextCursor?: unknown }).nextCursor;
  return {
    accountSetId,
    accountSetName,
    period,
    ...(typeof nextCursor === 'string' && nextCursor ? { nextCursor } : {}),
  };
}

/** 未过期的澄清候选;过期或缺失返回空数组。 */
export function freshPendingCandidates(state: AgentSessionState, now = Date.now()): PendingCandidate[] {
  if (!state.pendingCandidates?.length || !state.expiresAt) return [];
  const expiresAt = Date.parse(state.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return [];
  return state.pendingCandidates;
}

/**
 * 候选匹配:纯序号(1/2/3、第1个、1。)按位选择;否则按候选名称包含匹配(取最长命中)。
 * 序号越界视为未命中,交回正常流程。
 */
export function matchPendingCandidate(userMessage: string, candidates: PendingCandidate[]): PendingCandidate | null {
  const stripped = userMessage
    .trim()
    .replace(/[。,,.、;;!!??~~\s"'"'「」『』《》()()【】]/g, '');
  const numbered = /^第?([0-9]+)(?:个|项|条|号)?$/.exec(stripped);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < candidates.length) return candidates[index]!;
    return null;
  }
  let best: PendingCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.name && userMessage.includes(candidate.name)) {
      if (!best || candidate.name.length > best.name.length) best = candidate;
    }
  }
  return best;
}

/** 从数组中容错解析账套列表(details.candidates 等场景)。 */
export function parseAccountSetArray(raw: unknown): PendingCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingCandidate[] = [];
  for (const item of raw) {
    const candidate = parseCandidate(item);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** 从工具结果的 data 中容错提取账套列表(search_account_sets)。 */
export function extractAccountSetList(data: unknown): PendingCandidate[] {
  if (!data || typeof data !== 'object') return [];
  return parseAccountSetArray((data as { accountSets?: unknown }).accountSets);
}

/** 从工具结果的 data 中容错提取 nextCursor(list_vouchers)。 */
export function extractNextCursor(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
  return typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined;
}
