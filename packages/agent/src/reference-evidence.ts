/**
 * 主动回溯（roadmap Phase 2）：宿主在申报之前从 Conversation Log 检索指代证据，
 * 注入上下文头部——把"按需回溯"从模型发起（申报错了才补救的 route_reference_hint）
 * 改成宿主发起，模型第一次申报就有料可用。
 *
 * 铁律（违反了会让计划层的实体来源校验失去意义）：
 * 检索证据只允许支撑**指代消解**，不允许**扩大实体范围**。本轮请求里的实体只能是
 * 「当前消息写明的 + 指代词唯一对应到的那一个 + 平台自己返回的候选」；证据的作用是
 * 把消息里的指代词对应到哪个实体，不是"计划里可以出现历史上出现过的实体"。
 * 申报的 request 本身不再由宿主逐字校验（申报证据校验已随契约瘦身删除），范围守卫
 * 完全后移到计划层的实体来源校验（`validatePlanEntities`，架构 §2 第 9 条）。
 */
import type { ConversationEventRecord, ConversationLogRepo } from '@fshine/contracts';

/** 指代/回溯线索词：命中才检索，避免无谓注入。 */
const REFERENCE_CUE_RE = /这个|那个|它|刚才|上次|之前(?:说|讲|提)过|同上|前述/u;
/** replace 专用副本：非全局正则只替换第一个命中，会把"刚才/那个"漏成半个。 */
const REFERENCE_CUE_RE_GLOBAL = new RegExp(REFERENCE_CUE_RE.source, 'gu');

/** 最近 tool_result 证据条数上限。 */
export const MAX_TOOL_RESULT_EVIDENCE = 5;
/** 关键词命中证据条数上限。 */
export const MAX_KEYWORD_EVIDENCE = 3;
/** 单条证据内容截断长度（字符）。 */
const EVIDENCE_CONTENT_LIMIT = 300;

export interface ReferenceEvidence {
  /** 注入给模型的文本，每条证据带来源 eventId。 */
  text: string;
  /** 实际注入的证据条数（tool_result + 关键词命中，去重后）。 */
  count: number;
  /** 是否因上限截断（丢弃了候选证据）。 */
  truncated: boolean;
}

/** 当前消息是否在使用指代/回溯，需要宿主主动检索证据。 */
export function looksLikeReferenceCue(userMessage: string): boolean {
  return REFERENCE_CUE_RE.test(userMessage);
}

/**
 * 从当前消息提取检索关键词：剥掉线索词后按标点/空白切分，取 ≥2 字的片段。
 * 只取消息里真实出现的词——检索证据不得引入消息之外的实体。
 */
export function keywordsFrom(message: string): string[] {
  const stripped = message.replace(REFERENCE_CUE_RE_GLOBAL, ' ');
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of stripped.split(/[\s,，。？?！!、；;：:"'"'"''()（）]+/u)) {
    const word = token.trim();
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
  }
  return keywords.slice(0, 3);
}

function renderEvent(event: ConversationEventRecord): string {
  const content = (event.content ?? event.artifactRef ?? '').replace(/\s+/g, ' ').trim();
  const body = content.length > EVIDENCE_CONTENT_LIMIT ? `${content.slice(0, EVIDENCE_CONTENT_LIMIT)}…` : content;
  return `- [eventId=${event.eventId}] ${event.kind} ${event.createdAt}: ${body}`;
}

function renderEvidence(events: ConversationEventRecord[], truncated: boolean): string {
  const lines = events.map(renderEvent).join('\n');
  const tail = truncated ? '\n（证据过多已按上限截断；更早的历史不在本材料内。）' : '';
  return [
    '【宿主主动回溯：指代消解证据。用法：把当前消息里的指代词（这个/那个/它/刚才/上次）对应到实体，',
    '再把实体写进申报的 request（例：「查询<对应到的实体> <用户给的范围>」）；',
    '不得把材料里其他的实体擅自纳入本轮范围。无法唯一对应时选 conversation 问用户，不要猜。】',
    lines,
    tail,
  ].filter(Boolean).join('\n');
}

/**
 * 检索指代证据。返回 null 的三种情况：没有线索词、检索不到任何事件、日志不可用
 * （由调用方前置判断）。超上限时截断并标记。
 */
export async function collectReferenceEvidence(options: {
  conversationLog: ConversationLogRepo;
  principalId: string;
  sessionId: string;
  userMessage: string;
}): Promise<ReferenceEvidence | null> {
  const { conversationLog, principalId, sessionId, userMessage } = options;
  if (!looksLikeReferenceCue(userMessage)) return null;

  const scope = { principalId, sessionId };
  // 1) 最近的 tool_result：执行痕迹里就有上一轮查过的实体（list 返回时间正序）。
  const recent = await conversationLog.list({ ...scope, limit: MAX_TOOL_RESULT_EVIDENCE * 4 });
  const toolResults = recent.filter((event) => event.kind === 'tool_result' && (event.content ?? '').trim());
  const chosen: ConversationEventRecord[] = toolResults.slice(-MAX_TOOL_RESULT_EVIDENCE).reverse();
  const chosenIds = new Set(chosen.map((event) => event.eventId));

  // 2) 关键词命中：补上更早的相关轮次。每个关键词取最近两条，总共 ≤3 条。
  const candidates: ConversationEventRecord[] = [];
  for (const keyword of keywordsFrom(userMessage)) {
    const found = await conversationLog.search({ ...scope, query: keyword, limit: 2 });
    for (const event of found) {
      if (chosenIds.has(event.eventId) || candidates.some((hit) => hit.eventId === event.eventId)) continue;
      candidates.push(event);
    }
  }
  const hits = candidates.slice(0, MAX_KEYWORD_EVIDENCE);
  const droppedToolResults = Math.max(0, toolResults.length - MAX_TOOL_RESULT_EVIDENCE);
  const droppedKeywordHits = candidates.length - hits.length;
  const truncated = droppedToolResults > 0 || droppedKeywordHits > 0;
  const evidence = [...chosen, ...hits];
  if (evidence.length === 0) return null;
  return { text: renderEvidence(evidence, truncated), count: evidence.length, truncated };
}
