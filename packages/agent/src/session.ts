/**
 * 会话瞬态状态(澄清候选 + 翻页游标),JSON 序列化存 conversation_session.state。
 * TTL 语义:候选过期后不复活,重新走搜索(实施决策 §5)。
 */
import type { ConversationSessionRecord, ConversationSessionRepo } from '@fshine/contracts';

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
  lastVoucherQuery?: LastVoucherQuery;
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
  const last = parseLastVoucherQuery(obj.lastVoucherQuery);
  if (last) state.lastVoucherQuery = last;
  return state;
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
