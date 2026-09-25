import { createHash } from 'node:crypto';
import type { ConversationEventRecord } from '@fshine/contracts';
import type { MemoryRecordType } from '@fshine/core';
import type { CandidateExtractor } from './memory-consolidator';
import type { LongMemoryCandidate } from './long-memory';

export interface MemoryCandidateModelRequest {
  systemPrompt: string;
  userPrompt: string;
}

/** Adapter around the configured model provider. The return value may be structured JSON or JSON text. */
export interface MemoryCandidateModel {
  generateStructured(request: MemoryCandidateModelRequest): Promise<unknown> | unknown;
}

const SYSTEM_PROMPT = `你负责从用户原始消息中提取适合长期保存的稳定信息。只返回 JSON 对象 {"candidates":[...]}，每条包含 key、type(preference|fact)、content、sourceEventIds、action(assert|correct|delete)，纠正或删除还要提供 supersedesMemoryIds。

只记录用户明确表达且未来对话会持续有用的偏好或稳定事实。每条都必须引用输入中真实的 user_message eventId。不要把助手推测、工具结果、临时任务、一次性数据、报表数字或本次查询结果存入长期记忆。对于“改正/以后改用/不再记得/删除”等明确表达，分别输出 correct 或 delete，并提供被替代/删除记录 ID；不得把更正或删除改写成普通 assert。证据不足时返回空 candidates。不得从输入以外的记忆投影补充事实。`;

const PERIOD_RE = /(?:(?<!\d)20\d{2}(?:0[1-9]|1[0-2])(?!\d)|20\d{2}\s*(?:年\s*(?:0?[1-9]|1[0-2])\s*月|[-/.]\s*(?:0?[1-9]|1[0-2])\b|年?[-/.]?\s*[Qq][1-4])|[一二三四1-4]季度)/u;
const ACCOUNT_SET_RE = /(?:账套(?:名称|编号)?\s*[:：]?\s*[\p{L}\p{N}_-]+|account\s*set\s*[:#-]?\s*[\w-]+)/iu;
const BALANCE_RE = /(?:余额|期末数|科目余额|账面余额)/u;
const CURRENCY_AMOUNT_RE = /(?:[¥￥$]\s*\d|\b(?:CNY|RMB|USD)\s*\d|\d[\d,.]*\s*(?:元|万元|亿元))/iu;
const FINANCIAL_RESULT_RE = /(?:收入|支出|利润|资产|负债|现金流|应收|应付)/u;

/** Build a production candidate extractor while keeping provider calls injectable and testable. */
export function createLongMemoryCandidateExtractor(model: MemoryCandidateModel): CandidateExtractor {
  return async (sourceEvents, currentRecords = []) => {
    const userEvents = validateAndFilterSourceEvents(sourceEvents);
    if (!userEvents.length) return [];
    const principalId = userEvents[0]!.principalId;
    const eventText = userEvents.map(({ eventId, content, createdAt }) => ({ eventId, createdAt, content }));
    const response = await model.generateStructured({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: 'extract_stable_long_term_memory',
        sourceEvents: eventText,
        currentMemoryRecords: currentRecords.filter((record) => record.principalId === principalId).map(({ memoryId, key, type, content, status }) => ({ memoryId, key, type, content, status })),
        memoryRecordRule: 'currentMemoryRecords 只能用于识别用户明确更正或删除的 target memoryId，不是事实证据；sourceEventIds 仍必须引用本批 user_message。',
      }),
    });
    const rawCandidates = parseCandidates(response);
    const allowedEvents = new Map(userEvents.map((event) => [event.eventId, event]));
    const candidates: LongMemoryCandidate[] = [];
    const seenIds = new Map<string, string>();

    for (const raw of rawCandidates) {
      const candidate = validateModelCandidate(raw, principalId, allowedEvents);
      if (isEphemeralFinance(candidate)) continue;
      const candidateId = stableCandidateId(candidate);
      const normalized: LongMemoryCandidate = { ...candidate, candidateId };
      const serialized = JSON.stringify(normalized);
      const previous = seenIds.get(candidateId);
      if (previous !== undefined) {
        if (previous !== serialized) throw new Error(`model returned conflicting duplicate candidate ${candidateId}`);
        continue;
      }
      seenIds.set(candidateId, serialized);
      candidates.push(normalized);
    }
    return candidates;
  };
}

function validateAndFilterSourceEvents(events: readonly ConversationEventRecord[]): ConversationEventRecord[] {
  const users = events.filter((event) => event.kind === 'user_message');
  const principalIds = new Set(users.map((event) => event.principalId));
  if (principalIds.size > 1) throw new Error('candidate extraction must be scoped to one principal');
  const seen = new Map<string, string>();
  for (const event of users) {
    if (!event.eventId.trim() || !event.principalId.trim() || !event.content?.trim()) throw new Error('source user event requires eventId, principalId, and content');
    const serialized = JSON.stringify(event);
    const previous = seen.get(event.eventId);
    if (previous !== undefined && previous !== serialized) throw new Error(`source event id ${event.eventId} has conflicting data`);
    seen.set(event.eventId, serialized);
  }
  return users.filter((event, index) => users.findIndex((candidate) => candidate.eventId === event.eventId) === index);
}

function parseCandidates(response: unknown): unknown[] {
  let parsed = response;
  if (typeof parsed === 'string') {
    const content = parsed.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { parsed = JSON.parse(content) as unknown; }
    catch { throw new Error('candidate model returned invalid JSON'); }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length > 40) throw new Error('candidate model returned too many candidates');
    return parsed;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) throw new Error('candidate model response must contain a candidates array');
  if (parsed.candidates.length > 40) throw new Error('candidate model returned too many candidates');
  return parsed.candidates;
}

function validateModelCandidate(raw: unknown, principalId: string, events: Map<string, ConversationEventRecord>): Omit<LongMemoryCandidate, 'candidateId'> {
  if (!isRecord(raw)) throw new Error('candidate must be a JSON object');
  const key = requiredText(raw.key, 'candidate key', 100);
  const content = requiredText(raw.content, 'candidate content', 500);
  if (raw.type !== 'preference' && raw.type !== 'fact') throw new Error('candidate type must be preference or fact');
  const action = raw.action === undefined ? 'assert' : raw.action;
  if (action !== 'assert' && action !== 'correct' && action !== 'delete') throw new Error('candidate action must be assert, correct, or delete');
  if (!Array.isArray(raw.sourceEventIds) || !raw.sourceEventIds.length || raw.sourceEventIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('candidate sourceEventIds must cite at least one source event');
  }
  const sourceEventIds = [...new Set(raw.sourceEventIds as string[])];
  for (const eventId of sourceEventIds) {
    const event = events.get(eventId);
    if (!event) throw new Error(`candidate cites unknown source event ${eventId}`);
    if (event.principalId !== principalId || event.kind !== 'user_message') throw new Error(`candidate source event ${eventId} is outside user scope`);
  }
  let supersedesMemoryIds: string[] | undefined;
  if (raw.supersedesMemoryIds !== undefined) {
    if (!Array.isArray(raw.supersedesMemoryIds) || raw.supersedesMemoryIds.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('supersedesMemoryIds must contain memory IDs');
    supersedesMemoryIds = [...new Set(raw.supersedesMemoryIds as string[])];
  }
  if ((action === 'correct' || action === 'delete') && !supersedesMemoryIds?.length) throw new Error(`${action} candidates require supersedesMemoryIds`);
  return { principalId, key, type: raw.type, content, sourceEventIds, action, ...(supersedesMemoryIds ? { supersedesMemoryIds } : {}) };
}

function isEphemeralFinance(candidate: Omit<LongMemoryCandidate, 'candidateId'>): boolean {
  // Deletion is a tombstone operation. It must remain possible to remove an
  // old financial record that entered memory before these guards existed.
  if (candidate.action === 'delete') return false;
  const text = `${candidate.key} ${candidate.content}`;
  if (PERIOD_RE.test(text) || ACCOUNT_SET_RE.test(text)) return true;
  if (candidate.type === 'fact' && (BALANCE_RE.test(text) || CURRENCY_AMOUNT_RE.test(text) || FINANCIAL_RESULT_RE.test(text))) return true;
  return false;
}

function stableCandidateId(candidate: Omit<LongMemoryCandidate, 'candidateId'>): string {
  const canonical = JSON.stringify({
    principalId: candidate.principalId,
    key: candidate.key.trim().toLocaleLowerCase(),
    type: candidate.type,
    content: candidate.content.trim(),
    sourceEventIds: [...candidate.sourceEventIds].sort(),
    action: candidate.action,
    supersedesMemoryIds: [...(candidate.supersedesMemoryIds ?? [])].sort(),
  });
  return `mem_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label} must be 1 to ${maxLength} characters`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
