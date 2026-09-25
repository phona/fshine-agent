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
    // 铁律必须写在材料里：证据只用于指代消解，不扩大本轮范围
    expect(evidence!.text).toContain('不得把材料里其他的实体擅自纳入本轮范围');
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
    expect(looksLikeReferenceCue('查一下幻辰财税的应收账款')).toBe(false);

    expect(keywordsFrom('这个账套 202608 呢？')).toEqual(['账套', '202608']);
    expect(keywordsFrom('刚才我让你查的那三个期间，哪个余额最高？')).toEqual(['我让你查的那三个期间', '哪个余额最高']);
    // 上限 3 个关键词
    expect(keywordsFrom('那个账套 期间 科目 客户 摘要 金额')).toHaveLength(3);
  });
});
