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

/**
 * 指代/回溯线索词：命中才检索，避免无谓注入。
 *
 * 为什么收"总结/汇总/回顾/梳理"这一类（D-071）：2026-09-28 长会话实测里，探针 C1 第 20 轮
 * （20 轮跨三个不同对象）与真实平台 X8（一个回合里做了 6 件事）的总结都塌缩成最后一个
 * 对象/时间窗——总结词不在线索表里，召回轮拿不到宿主持有的执行底账，模型只能从转录自由
 * 回忆，而转录里"最近"的恰恰是最后那一件事。总结轮是召回轮的一种：用户要的是"本会话迄今
 * 发生过什么"的机械清单，不是最后一条的放大镜。
 *
 * 两个消费者共用这把尺，加词对两者同时生效——**这是想要的**：总结轮既该有执行台账
 * （execution-facts，管"真实发生过哪些执行"的归因），也该有指代证据（本文件，管"这个/
 * 刚才指的是哪个实体"的消解）。两者都只机械陈述、都不扩大本轮范围（见各自文件头的铁律），
 * 注入面随词表扩大而变的是"哪些轮次拿到底账"，不是底账的内容口径。
 *
 * 防误扩的边界：词表只收"用户在要一份历史清单"的形状，不收"用户在新查询里顺带提到
 * 这些字"——真出现了，多注入的也只是本会话真实执行过的机械条目（断言见
 * execution-facts.test.ts：注入内容只有结构化条目与结果原文，没有解释与排名）。
 */
const REFERENCE_CUE_RE = /这个|那个|它|刚才|上次|之前(?:说|讲|提)过|同上|前述|总结|汇总|回顾|梳理/u;
/** replace 专用副本：非全局正则只替换第一个命中，会把"刚才/那个"漏成半个。 */
const REFERENCE_CUE_RE_GLOBAL = new RegExp(REFERENCE_CUE_RE.source, 'gu');

/**
 * 第二把尺：中文同义改写 + 英文线索（2026-11-11 语言盲区修复）。
 *
 * 原尺只有中文直陈形态，实测全语料中文开门 4 轮、补英文后 34 轮——九个零中文线索的
 * 用例正好全是长会话用例，台账/指代证据在那些轮次根本没机会注入。这里单独加一把
 * OR 尺而不是改原正则：原尺与它的 replace 副本保持逐字不变（关闭臂先验最简单），
 * 新词只扩大开门面；真命中的注入内容仍由两个消费者各自的上限与铁律约束，不扩大
 * 本轮实体范围。
 *
 * 英文只收"在要一份历史清单/做指代消解"的形状：what about / how about / that one /
 * previous / earlier / last time / the same / recap / summarize / review / remind me /
 * what did we 等。不收裸 it/this/that/"before"——它们在普通新查询里太常见，会把开门面
 * 摊到几乎每轮。英文词用 `\b` 边界，大小写不敏感。
 */
const REFERENCE_CUE_EXTRA_RE = /刚刚|上回|那次|那一次|先前|早先|上述|前文|前面(?:说|提|讲|那)|之前(?:说|讲|提|查|问|看|做)过|\bwhat about\b|\bhow about\b|\bthat one\b|\bthis one\b|\bthe one\b|\b(?:from|as|said|mentioned|noted) before\b|\blast (?:time|query|result|one|batch)\b|\bprevious(?:ly)?\b|\bearlier\b|\baforementioned\b|\babove-mentioned\b|\bthe above\b|\brecap\b|\bsummari[sz](?:e|ed|ing)\b|\bsummary\b|\bgo over\b|\breview\b|\bremind me\b|\bthe same\b|\bjust now\b|\bwhat (?:did|have) we\b|\bback to the\b|\brefer(?:red)? to\b|\bmentioned (?:earlier|before|above)\b/iu;

/**
 * 否定式提及不是召回线索：「不是刚才那个」在否定一个对象，不是在要历史清单。
 * 先把"否定词 + 线索词"整段剥掉再判——不剥的话"刚才"/"那个"照样命中原尺。
 * 只剥紧邻的否定（不是/不要/并非… + 线索词），不碰"我刚才不是说过吗"这类
 * 否定词在线索词之后的真回溯（反问仍然开门）。
 */
const NEGATED_REFERENCE_CUE_RE = /(?<!难道)(?<!岂)(?:不是|不要(?:用|再)?|不用|别用|并非|而不是)\s*(?:(?:刚才|刚刚|上次|上回)(?:那个|那次)?|那个|它|之前(?:说|讲|提|查|问|看|做)过|前述|上述)|\b(?:not|isn't|wasn't)\s+(?:the\s+)?(?:one\s+)?(?:from\s+)?(?:before|earlier)\b|\bnot (?:that|this) one\b/giu;

/**
 * 英文关键词停用词：英文轮次开门后 keywordsFrom 会把整句按空白切开，what/about/this
 * 这类词检索价值为零，只会挤占三个关键词位。只过滤英文功能词，中文片段不受影响。
 */
const KEYWORD_STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'before',
  'did', 'for', 'from', 'had', 'has', 'have', 'how', 'into', 'its', 'just', 'last',
  'mention', 'mentioned', 'more', 'not', 'now', 'one', 'over', 'previous', 'recap',
  'review', 'same', 'she', 'should', 'summary', 'summarize', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'time', 'was', 'we',
  'were', 'what', 'when', 'which', 'who', 'why', 'with', 'you',
]);

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

/** 当前消息是否在使用指代/回溯/总结，需要宿主主动检索证据。 */
export function looksLikeReferenceCue(userMessage: string): boolean {
  // 否定式提及先剥再判：剥完一条线索都不剩 = 用户只是否掉一个对象，不开门；
  // 剥完还剩下别的真线索（「不是刚才那个，上回汇总的呢」）= 照常开门。
  const withoutNegatedCues = userMessage.replace(NEGATED_REFERENCE_CUE_RE, ' ');
  if (withoutNegatedCues !== userMessage
    && !REFERENCE_CUE_RE.test(withoutNegatedCues)
    && !REFERENCE_CUE_EXTRA_RE.test(withoutNegatedCues)) return false;
  // 第二把尺（同义改写 / 英文）先判；未命中再走原尺（原表达式一行未动）。
  if (REFERENCE_CUE_EXTRA_RE.test(withoutNegatedCues)) return true;
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
    if (KEYWORD_STOPWORDS.has(word.toLowerCase())) continue;
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
