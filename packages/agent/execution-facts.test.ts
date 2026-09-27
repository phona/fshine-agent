import { describe, expect, it } from 'vitest';
import type { ConversationEventRecord, ConversationLogRepo } from '@fshine/contracts';
import { collectExecutionFacts, EXECUTION_FACTS_MARKER, MAX_EXECUTION_FACTS } from './src/execution-facts';

function record(eventId: string, kind: ConversationEventRecord['kind'], content: string, createdAt = '2026-09-26T10:31:00.000Z'): ConversationEventRecord {
  return { eventId, principalId: 'p1', sessionId: 's1', kind, content, createdAt };
}

/** 与 sqlite store 同语义：list 返回时间正序的最近 N 条。 */
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
const RECALL = '刚才查出来是多少钱？';

/** 台账正文（去掉纪律头后的条目行）。 */
function entries(text: string): string[] {
  return text.split('\n').filter((line) => /^[①-⑩]/.test(line));
}

describe('召回事实注入：执行台账', () => {
  it('命中召回线索时按时间正序渲染执行台账，一条目一次委派', async () => {
    const log = fakeLog([
      record('u1', 'user_message', '查一下幻辰财税 202606 的应收账款余额'),
      record('r1', 'tool_result', '幻辰财税 202606 应收账款余额为 61000 元。', '2026-09-26T10:31:00.000Z'),
      record('a1', 'assistant_message', '幻辰财税 202606 应收账款余额为 61000 元。'),
      record('r2', 'tool_result', '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。', '2026-09-26T10:35:00.000Z'),
    ]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL });

    expect(facts).not.toBeNull();
    expect(facts!.count).toBe(2);
    expect(facts!.truncated).toBe(false);
    // 只收执行底账：user/assistant 事件不进台账
    expect(entries(facts!.text)).toHaveLength(2);
    expect(entries(facts!.text)[0]).toContain('61000 元');
    expect(entries(facts!.text)[0]).toContain('2026-09-26 10:31');
    expect(entries(facts!.text)[1]).toContain('新兴五金');
    // 序号即条目身份：模型据此逐条归因，不会把两条混成一次查询
    expect(facts!.text).toContain('①');
    expect(facts!.text).toContain('②');
    // 纪律必须写在材料里：只能依据条目、不得混列、没有的结论不得填充
    expect(facts!.text).toContain('只能依据这些条目陈述');
    expect(facts!.text).toContain('不得把不同条目混称为一次查询');
    expect(facts!.text.startsWith(EXECUTION_FACTS_MARKER)).toBe(true);
  });

  it('混合终态按记录原文渲染：不发明状态词，也不把"没有执行"洗成结果', async () => {
    const log = fakeLog([
      record('r1', 'tool_result', '幻辰财税 202606 应收账款余额为 61000 元。', '2026-09-26T10:31:00.000Z'),
      record('r2', 'tool_result', '子 Agent 本轮没有执行平台查询，还缺少信息：查询对象。原因：用户没有给出要查的对象。', '2026-09-26T10:36:00.000Z'),
    ]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL });

    const lines = entries(facts!.text);
    expect(lines[0]).toContain('61000 元');
    // 失败/缺信息的条目原样在册：召回轮因此能区分"查到了"和"没查到"
    expect(lines[1]).toContain('没有执行平台查询');
    expect(lines[1]).toContain('还缺少信息');
  });

  it('渲染模板零业务词：纪律头里不出现任何领域词（条目内容里的业务词是数据）', async () => {
    const log = fakeLog([record('r1', 'tool_result', '某对象某时间范围的查询结果')]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL });
    const header = facts!.text.split('\n').slice(0, 4).join('\n');
    expect(header).not.toMatch(/应收|凭证|科目|账套|期间|目录/u);
  });

  it('没有召回线索时不检索、不注入（即使有执行记录）', async () => {
    const log = fakeLog([record('r1', 'tool_result', '幻辰财税 202606 应收账款余额为 61000 元。')]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: '查一下幻辰财税的应收账款' });
    expect(facts).toBeNull();
  });

  it('检索不到任何执行记录时返回 null（只有对话事件/空日志）', async () => {
    const log = fakeLog([
      record('u1', 'user_message', '你好'),
      record('a1', 'assistant_message', '你好，告诉我查什么'),
    ]);
    expect(await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL })).toBeNull();
    expect(await collectExecutionFacts({ conversationLog: fakeLog([]), ...SCOPE, userMessage: RECALL })).toBeNull();
  });

  it('内容为空的 tool_result 事件不计入台账', async () => {
    const log = fakeLog([record('r1', 'tool_result', '   '), record('r2', 'tool_result', '有效结果')]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL });
    expect(facts!.count).toBe(1);
  });

  it('执行记录超过上限时只保留最近 5 条并标记截断', async () => {
    const events = Array.from({ length: 7 }, (_, i) =>
      record(`r${i}`, 'tool_result', `第 ${i} 次查询结果`, `2026-09-26T10:0${i}:00.000Z`));
    const log = fakeLog(events);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: '刚才那几次查询，哪个结果最高？' });

    expect(facts!.count).toBe(MAX_EXECUTION_FACTS);
    expect(facts!.truncated).toBe(true);
    expect(entries(facts!.text)).toHaveLength(MAX_EXECUTION_FACTS);
    expect(facts!.text).toContain('第 6 次查询结果');
    expect(facts!.text).toContain('第 2 次查询结果');
    expect(facts!.text).not.toContain('第 1 次查询结果');
    expect(facts!.text).not.toContain('第 0 次查询结果');
    expect(facts!.text).toContain('更早的执行不在本材料内');
  });

  it('单条记录超长时截断并留省略号（全文仍在 Log 里可检索）', async () => {
    const log = fakeLog([record('r1', 'tool_result', '长'.repeat(500))]);
    const facts = await collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL });
    const line = entries(facts!.text)[0]!;
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThan(400);
  });

  it('存储不可用时抛错，由调用方兜底（不失败回合）', async () => {
    const log: ConversationLogRepo = {
      async append() {},
      async list() { throw new Error('disk unavailable'); },
      async search() { return []; },
    };
    await expect(collectExecutionFacts({ conversationLog: log, ...SCOPE, userMessage: RECALL })).rejects.toThrow('disk unavailable');
  });
});
