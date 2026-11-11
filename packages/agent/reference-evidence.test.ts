import { describe, expect, it } from 'vitest';
import type { ConversationEventRecord, ConversationLogRepo } from '@fshine/contracts';
import {
  collectReferenceEvidence,
  keywordsFrom,
  looksLikeReferenceCue,
  MAX_KEYWORD_EVIDENCE,
  MAX_TOOL_RESULT_EVIDENCE,
} from './src/reference-evidence';

function event(eventId: string, kind: ConversationEventRecord['kind'], content: string, createdAt = '2026-09-20T10:00:00.000Z'): ConversationEventRecord {
  return { eventId, principalId: 'p1', sessionId: 's1', kind, content, createdAt };
}

/** 与 sqlite store 同语义：list 返回时间正序的最近 N 条；search 按子串命中返回正序。 */
function fakeLog(events: ConversationEventRecord[]): ConversationLogRepo {
  return {
    async append() {},
    async list({ limit }) { return events.slice(-Math.max(1, limit)); },
    async search({ query, limit }) {
      return events.filter((item) => (item.content ?? '').includes(query)).slice(-Math.max(1, limit));
    },
  };
}

const SCOPE = { principalId: 'p1', sessionId: 's1' } as const;

describe('主动回溯：宿主申报前注入指代证据', () => {
  it('命中指代线索时注入最近的 tool_result，内容带 eventId 与消解边界', async () => {
    const log = fakeLog([
      event('evt_1', 'tool_result', '执行 finance.query-receivables: 新兴五金 202609 应收余额 51 元'),
      event('evt_2', 'tool_result', '执行 finance.query-receivables: 新兴建材 202607 应收余额 20 元'),
    ]);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '这个账套 202608 呢？' });

    expect(evidence).not.toBeNull();
    expect(evidence!.count).toBe(2);
    expect(evidence!.truncated).toBe(false);
    expect(evidence!.text).toContain('eventId=evt_1');
    expect(evidence!.text).toContain('eventId=evt_2');
    expect(evidence!.text).toContain('新兴五金');
    // 铁律必须写在材料里：证据只用于指代消解（加工 request 时把指代词对应到实体），
    // 不扩大本轮范围。契约瘦身后材料不再教任何旧契约字段名（"填 XX 字段"那套口径），
    // 只留边界关键词——用"不得出现带引号的驼峰字段名"断言旧字段教学已清除。
    expect(evidence!.text).toContain('实体');
    expect(evidence!.text).toContain('范围');
    expect(evidence!.text).not.toMatch(/"[a-z][A-Za-z]+":/u);
  });

  it('没有指代线索时不检索、不注入', async () => {
    const log = fakeLog([event('evt_1', 'tool_result', '新兴五金 202609 应收余额 51 元')]);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '查一下幻辰财税的应收账款' });
    expect(evidence).toBeNull();
  });

  it('tool_result 超过上限时只保留最近 5 条并标记截断', async () => {
    const events = Array.from({ length: 7 }, (_, i) => event(`evt_${i}`, 'tool_result', `第 ${i} 次查询结果`));
    const log = fakeLog(events);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '刚才那几次查询，哪个余额最高？' });

    expect(evidence!.count).toBe(MAX_TOOL_RESULT_EVIDENCE);
    expect(evidence!.truncated).toBe(true);
    expect(evidence!.text).toContain('eventId=evt_6');
    expect(evidence!.text).toContain('eventId=evt_2');
    expect(evidence!.text).not.toContain('eventId=evt_1');
    expect(evidence!.text).not.toContain('eventId=evt_0');
    expect(evidence!.text).toContain('已按上限截断');
  });

  it('关键词命中最多补 3 条，与 tool_result 去重，超出部分标记截断', async () => {
    const events = [
      ...Array.from({ length: 2 }, (_, i) => event(`res_${i}`, 'tool_result', `应收查询结果 ${i}`)),
      ...['应收A', '应收B', '余额A', '余额B', '凭证A', '凭证B'].map((content, i) => event(`msg_${i}`, 'user_message', content)),
    ];
    const log = fakeLog(events);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '刚才那个应收 余额 凭证' });

    // 2 条 tool_result + 最多 3 条关键词命中（6 个候选被截到 3）
    expect(evidence!.count).toBe(2 + MAX_KEYWORD_EVIDENCE);
    expect(evidence!.truncated).toBe(true);
    // 去重：tool_result 也含"应收"，但不重复计入关键词命中
    expect(evidence!.text.match(/eventId=res_/g)).toHaveLength(2);
    expect(evidence!.text.match(/eventId=msg_/g)).toHaveLength(MAX_KEYWORD_EVIDENCE);
  });

  it('关键词命中的事件若已在 tool_result 证据里则去重，不重复注入', async () => {
    const log = fakeLog([event('res_0', 'tool_result', '应收查询结果')]);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '刚才那个应收' });
    expect(evidence!.count).toBe(1);
    expect(evidence!.text.match(/eventId=res_0/g)).toHaveLength(1);
    expect(evidence!.truncated).toBe(false);
  });

  it('检索不到任何事件时返回 null', async () => {
    const log = fakeLog([]);
    const evidence = await collectReferenceEvidence({ conversationLog: log, ...SCOPE, userMessage: '这个账套呢？' });
    expect(evidence).toBeNull();
  });

  it('线索词识别与关键词提取', () => {
    expect(looksLikeReferenceCue('这个账套 202608 呢？')).toBe(true);
    expect(looksLikeReferenceCue('它 202609 呢？')).toBe(true);
    expect(looksLikeReferenceCue('刚才查的是哪个账套？')).toBe(true);
    // 总结/汇总/回顾/梳理类也是召回线索（D-071）：总结轮要的是"本会话迄今发生过什么"的
    // 机械清单，不是最后一条的放大镜——不收这些词，召回轮就拿不到执行底账。
    expect(looksLikeReferenceCue('总结一下我们今天查了些什么')).toBe(true);
    expect(looksLikeReferenceCue('汇总一下今天查了什么')).toBe(true);
    expect(looksLikeReferenceCue('回顾下之前的查询')).toBe(true);
    expect(looksLikeReferenceCue('梳理一下这次查了哪些')).toBe(true);
    // 反例：新查询（哪怕带着历史会话里出现过的词）不是召回线索
    expect(looksLikeReferenceCue('查一下幻辰财税的应收账款')).toBe(false);
    expect(looksLikeReferenceCue('帮我查一下猫一杯的应收账款还有多少')).toBe(false);

    expect(keywordsFrom('这个账套 202608 呢？')).toEqual(['账套', '202608']);
    expect(keywordsFrom('刚才我让你查的那三个期间，哪个余额最高？')).toEqual(['我让你查的那三个期间', '哪个余额最高']);
    // 上限 3 个关键词
    expect(keywordsFrom('那个账套 期间 科目 客户 摘要 金额')).toHaveLength(3);
    // 线索词被剥掉后不占关键词位：总结轮的检索词是消息里剩下的实词
    expect(keywordsFrom('总结一下我们今天查了些什么')).toEqual(['一下我们今天查了些什么']);
  });

  it('英文线索开门：what about / previous / earlier / same as before 等（语言盲区修复）', () => {
    // 验收原句：英文长会话里最常见的指代形态，修复前一律不开门。
    expect(looksLikeReferenceCue('what about this collection W2?')).toBe(true);
    expect(looksLikeReferenceCue('How about the previous batch?')).toBe(true);
    expect(looksLikeReferenceCue('same as before')).toBe(true);
    expect(looksLikeReferenceCue('summarize what we did earlier')).toBe(true);
    expect(looksLikeReferenceCue('remind me of the last query')).toBe(true);
    expect(looksLikeReferenceCue('review the earlier result')).toBe(true);
    expect(looksLikeReferenceCue('back to the shelf we discussed')).toBe(true);
    // 反例：全新查询不因为含英文就开门（不把 this/that/before 这类裸词当线索）。
    expect(looksLikeReferenceCue('check collection W3')).toBe(false);
    expect(looksLikeReferenceCue('query shelf north in batch B1')).toBe(false);
  });

  it('中文同义改写开门：刚刚 / 上回 / 那次 / 前面提到 / 之前查过 等', () => {
    expect(looksLikeReferenceCue('上回查的那个批次呢？')).toBe(true);
    expect(looksLikeReferenceCue('刚刚查的 W2 还有多少？')).toBe(true);
    expect(looksLikeReferenceCue('那次查询的结果呢？')).toBe(true);
    expect(looksLikeReferenceCue('前面提到的那个货架')).toBe(true);
    expect(looksLikeReferenceCue('之前查过的货架再给我看看')).toBe(true);
    expect(looksLikeReferenceCue('上述查询里哪个批次最大？')).toBe(true);
    expect(looksLikeReferenceCue('前文说的那一条')).toBe(true);
  });

  it('否定句不开门：只否掉一个对象不是要历史清单', () => {
    expect(looksLikeReferenceCue('不是刚才那个')).toBe(false);
    expect(looksLikeReferenceCue('不要用刚才那个，重新查 W2')).toBe(false);
    expect(looksLikeReferenceCue('不是那个，是新的')).toBe(false);
    // 否定只剥紧邻的那一段：同句里另有真线索（上回/汇总）仍然开门。
    expect(looksLikeReferenceCue('不是刚才那个，那上回汇总的呢？')).toBe(true);
  });

  it('反问句仍开门：反问是在确认历史指代，不是否定', () => {
    expect(looksLikeReferenceCue('我刚才不是已经说过了吗？')).toBe(true);
    expect(looksLikeReferenceCue('这难道不是刚才那个吗？')).toBe(true);
  });

  it('中英混排：中文线索 + 英文实体 / 英文线索 + 中文实体都开门', () => {
    expect(looksLikeReferenceCue('刚才那个 collection W2 呢？')).toBe(true);
    expect(looksLikeReferenceCue('what about 刚才那个批次？')).toBe(true);
    expect(looksLikeReferenceCue('the previous 货架 还有多少？')).toBe(true);
    // 英文句子剥掉线索与功能词后，检索关键词只留实体。
    expect(keywordsFrom('what about this collection W2?')).toEqual(['collection', 'W2']);
    expect(keywordsFrom('刚才那个 collection W2 呢？')).toEqual(['collection', 'W2']);
  });
});
