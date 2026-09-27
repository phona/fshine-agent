/**
 * 离线全链 e2e：召回事实注入（支柱 C 第一刀）。共享替身见 ./harness.ts。
 *
 * 覆盖 T3r 翻车形状的回归：真实平台多轮实测里，用户问"刚才查出来是多少钱"，模型从原始
 * 转录自由回忆，把两个不同对象/时间范围的查询混成"刚才两次查询"——归因串轮。修法是让
 * 召回轮次的答案来自宿主持有的执行台账（Conversation Log 的 tool_result 底账，真 SQLite），
 * 而不是转录里偶然提到的文本。
 *
 * 三个形状：
 *   ① 一次真实委派后召回：回复里的对象/时间范围/结果与任务事实一致，且不含本轮之外的对象；
 *   ② 两个任务（一个成功、一个没查到）后问"刚才哪些查到了"：回复正确区分成败；
 *   ③ 会话里没有任何平台执行：宿主不注入台账（静默降级），召回归因只能说没有记录。
 *
 * 这里的 Main Agent 替身按生产模型应有的方式作答：conversation 申报的文本从宿主注入的
 * 台账里生成。台账不在场时它只能答"没有可依据的执行记录"——因此把关掉注入的变异直接
 * 变成红（不是"换个说法还能过"）。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, gatedWorker, totalActualCalls } from './harness';

const FACTS_MARKER = '【宿主执行事实：';

/** 从宿主注入材料里取执行台账文本（召回归因的唯一依据）。 */
function injectedFacts(messages: unknown[]): string | null {
  for (const message of messages) {
    const content = (message as { role?: string; content?: unknown }).content;
    if (typeof content === 'string' && content.startsWith(FACTS_MARKER)) return content;
  }
  return null;
}

/** 台账条目行（①②…开头的那几行）。 */
function factEntries(text: string): string[] {
  return text.split('\n').filter((line) => /^[①-⑩]/.test(line));
}

/** 条目首句：模型复述台账时的正常摘法，也顺带避开内部编号字样。 */
function firstSentence(entry: string): string {
  const head = entry.split('。')[0] ?? entry;
  return `${head}。`;
}

/**
 * 召回归因替身：按脚本申报；conversation 申报且脚本没给文本时，回复由 `answer` 从宿主
 * 注入的执行台账生成。delegate 申报走 terminate 语义（ToolUserError），用户看到的是
 * 子 Agent 的文本——与 harness 的 mainDriver 同一套生产语义。
 */
function recallDriver(
  declarations: Array<Record<string, unknown>>,
  answer: (facts: string) => string,
  observe?: (messages: unknown[]) => void,
) {
  let cursor = 0;
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      observe?.(input.messages);
      // 宿主续跑路径不带工具：Main Agent 只整理已完成的执行结果，不再申报
      if (input.tools.length === 0) {
        return { text: '已按你确认的范围整理完成。', messages: input.messages };
      }
      const transcript: unknown[] = [...input.messages];
      for (;;) {
        const entry = declarations[Math.min(cursor, declarations.length - 1)]!;
        const exhausted = cursor >= declarations.length;
        cursor += 1;
        const callId = `call_${cursor}`;
        transcript.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: entry }],
          timestamp: Date.now(),
        } as never);
        try {
          const outcome = await input.exec('route_current_turn', entry);
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: JSON.stringify(outcome) }],
            timestamp: Date.now(),
          } as never);
        } catch (error) {
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: (error as Error).message }],
            timestamp: Date.now(),
          } as never);
          return { text: (error as Error).message, messages: transcript };
        }
        if (entry['kind'] === 'conversation') {
          // 脚本给了文本就照念（纠错环转达等）；否则从宿主台账生成召回答案
          if (typeof entry['text'] === 'string') return { text: entry['text'], messages: transcript };
          const facts = injectedFacts(input.messages);
          const text = facts ? answer(facts) : '没有可依据的执行记录，我不能凭印象编。';
          transcript.push({ role: 'assistant', content: text, timestamp: Date.now() } as never);
          return { text, messages: transcript };
        }
        if (typeof entry['text'] === 'string') return { text: entry['text'], messages: transcript };
        if (exhausted) return { text: '主 Agent 自由文本：不应外发', messages: transcript };
      }
    },
  };
}

/** 召回复用：逐条摘述台账条目（不排名、不比较、不补充条目之外的对象）。 */
function recallFromFacts(facts: string): string {
  const lines = factEntries(facts).map(firstSentence);
  return lines.length > 0 ? `刚才的执行记录如下：\n${lines.join('\n')}` : '没有可依据的执行记录，我不能凭印象编。';
}

describe('离线全链 e2e：召回事实注入（执行台账）', () => {
  it('10.1 一次真实委派后召回：答案来自宿主台账，不串轮不混列', async () => {
    const before = totalActualCalls();
    const worker = gatedWorker([
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
    ]);
    const observed: string[] = [];
    const { send, assembly } = await boot({
      main: recallDriver(
        [
          { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
          { kind: 'conversation' },
        ],
        recallFromFacts,
        (messages) => observed.push(JSON.stringify(messages)),
      ),
      worker,
    });

    const first = await send('查一下幻辰财税 202606 的应收账款余额');
    expect(first).toContain('61000 元');
    expect(first).not.toContain('不应外发');

    // 召回轮：宿主注入执行台账，答案逐条来自它
    const recalled = await send('刚才查出来是多少钱？');
    expect(observed[1]).toContain(FACTS_MARKER);
    // 对象、时间范围、结果数值与任务事实一致（台账条目带平台记录原文，按上限截断）
    expect(recalled).toContain('61000');
    expect(recalled).toContain('幻辰财税');
    expect(recalled).toContain('202606');
    // 不含第一回合之外的对象（串轮/混列的形状）
    expect(recalled).not.toContain('新兴五金');
    expect(recalled).not.toContain('没有可依据的执行记录');
    // 召回轮零新增平台调用：答案来自底账，不是重新查
    expect(totalActualCalls()).toBe(before + 1);
    await assembly.close();
  });

  it('10.2 两个任务（一个成功、一个没查到）后问"刚才哪些查到了"，回复正确区分', async () => {
    const worker = gatedWorker([
      // 任务 A：真实执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 任务 B：worker 执行不了，回报缺什么（纠错环）——本轮没有平台执行
      { need: { missing: ['查询对象'], reason: '用户没有给出要查的对象', suggestion: '请告诉我要查哪个对象' } },
    ]);
    const { send, assembly } = await boot({
      main: recallDriver(
        [
          { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
          { kind: 'delegate', request: '查一下账套的应收' },
          { kind: 'conversation', text: '请告诉我要查哪个对象，我再去查。' },
          { kind: 'conversation' },
        ],
        recallFromFacts,
      ),
      worker,
    });

    await send('查一下幻辰财税 202606 的应收账款余额');
    const second = await send('那把另一个也查一下');
    expect(second).toContain('请告诉我要查哪个对象');

    // 召回轮：台账里 A 有结果、B 没有执行——回复必须把两者分开说
    const third = await send('刚才哪些查到了？');
    const lines = third.split('\n');
    const entryA = lines.find((line) => line.startsWith('①')) ?? '';
    const entryB = lines.find((line) => line.startsWith('②')) ?? '';
    expect(entryA).toContain('61000');
    expect(entryA).toContain('幻辰财税');
    expect(entryB).toContain('没有执行平台查询');
    // B 没有执行，就没有它的结果：不能把 A 的数字安到 B 头上（T3r 串轮形状）
    expect(entryB).not.toContain('61000');
    expect(third).not.toContain('不应外发');
    await assembly.close();
  });

  it('10.3 会话里没有平台执行时不注入台账：召回归因只能说没有记录', async () => {
    const observed: string[] = [];
    const { send, sdk, assembly } = await boot({
      main: recallDriver([{ kind: 'conversation' }], recallFromFacts, (messages) => observed.push(JSON.stringify(messages))),
      worker: gatedWorker([{ text: '不应执行' }]),
    });

    const reply = await send('刚才查出来是多少钱？');

    expect(observed[0]).not.toContain(FACTS_MARKER);
    expect(reply).toContain('没有可依据的执行记录');
    // 没有台账就没有任何数字结论可复述
    expect(reply).not.toMatch(/\d+\s*[元万亿]/);
    expect(sdk.noticeTexts()).toHaveLength(0);
    await assembly.close();
  });
});
