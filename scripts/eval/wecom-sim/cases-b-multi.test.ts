/**
 * B 组·多轮与指代（W-05～W-07）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 机械判据（用户可见结果）：
 *   W-05  接 W-02：「那 W202610 呢？」→ 沿用 documents 只换窗口（真实查 W202610），
 *         不重新问集合；
 *   W-06  「alpha 和 beta 的 W1 各有多少条、分别是什么？」→ 两个集合都真实查了
 *         （alpha 2 条 1200/800，beta 3 条 500/300/200），不漏一个；
 *   W-07  接 W-06：「算了，只看 beta」→ 只讲 beta 的 3 条（从本会话真实执行事实里取），
 *         不把 alpha 的数混进来，且不再发起执行。
 *
 * 说明：「沿用/只看」的**决定**由脚本做出（模型行为归 eval:user/live 人工面）；
 * 数字与「不串台」断言针对的是真实执行事实与本会话转录——alpha/beta 的值对不上
 * 任何一环都会红。W-07 的回复取自本会话 task_run 的真实摘要（不是另编的文本）。
 */
import { describe, expect, it } from 'vitest';
import {
  mainRelayResponses,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  workerQueryResponses,
  type SimScriptCall,
} from './harness';

/** 收集本会话转录里全部 task_run 摘要（按发生顺序；来自真实执行链）。 */
function taskSummariesOf(messages: readonly unknown[]): string[] {
  const summaries: string[] = [];
  for (const message of messages) {
    const record = message as { role?: unknown; toolName?: unknown; content?: unknown };
    if (record.role !== 'toolResult' || record.toolName !== 'task_run') continue;
    const text = Array.isArray(record.content)
      ? record.content.map((part) => String((part as { text?: unknown }).text ?? '')).join('')
      : String(record.content ?? '');
    try {
      const parsed = JSON.parse(text) as { summary?: unknown };
      if (typeof parsed.summary === 'string' && parsed.summary !== '') summaries.push(parsed.summary);
    } catch {
      // 非 JSON 形态直接忽略（形状漂移会让下面的断言失败，不静默通过）。
    }
  }
  return summaries;
}

describe('B 组·多轮与指代（W-05～W-07）', () => {
  it('W-05 接 W-02：「那 W202610 呢？」沿用 documents 只换窗口，不重新问集合', async () => {
    const sim = await startWecomSim({ label: 'w05' });
    try {
      // 上一回合：documents W202611（真实执行）。
      sim.book.mainTurn('帮我查一下 documents 集合 W202611 的数据', mainRelayResponses('查询 documents 集合 W202611 的记录'));
      sim.book.workerTask('查询 documents 集合 W202611 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      sim.sendText('帮我查一下 documents 集合 W202611 的数据');
      await sim.waitFor('第一回合终帧', () => sim.finalBubbles().length === 1);

      // 本回合：沿用对象、只换窗口（委派文本不再复述「哪个集合的澄清问题」）。
      sim.book.mainTurn('那 W202610 呢？', mainRelayResponses('查询 documents 集合 W202610 的记录'));
      sim.book.workerTask('查询 documents 集合 W202610 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202610' }));
      const messageId = sim.sendText('那 W202610 呢？');
      await sim.waitFor('第二回合终帧', () => sim.finalBubbles().length === 2);

      const reply = sim.finalBubbles()[1]!.content;
      // 沿用 documents、查了新窗口：真实返回的 window 字段在回复里。
      expect(reply).toContain('documents W202610');
      expect(reply).toContain('1200');
      // 不重新问集合 = 直接给数据（有数字）。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(1);
      expect(done!.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('W-06 alpha 和 beta 各有多少条：两个集合都查了，数字对得上', async () => {
    const sim = await startWecomSim({ label: 'w06' });
    try {
      sim.book.mainTurn('alpha 和 beta 的 W1 各有多少条、分别是什么？', [
        toolCallAssistant('task_run', { task: '查询 alpha 集合 W1 的条数与记录' }),
        (call: SimScriptCall) => {
          // 第一笔真实执行完成后，再发起第二笔（同一回合内两次委派）。
          const summaries = taskSummariesOf(call.messages);
          if (summaries.length === 0) throw new Error('第一次 task_run 还没有真实返回。');
          return toolCallAssistant('task_run', { task: '查询 beta 集合 W1 的条数与记录' });
        },
        (call: SimScriptCall) => {
          const summaries = taskSummariesOf(call.messages);
          if (summaries.length < 2) throw new Error('两次 task_run 的真实摘要不齐。');
          return textAssistant(summaries.join('\n'));
        },
      ]);
      sim.book.workerTask('查询 alpha 集合 W1 的条数与记录', workerQueryResponses('dummy.query', { '--collection': 'alpha', '--window': 'W1' }));
      sim.book.workerTask('查询 beta 集合 W1 的条数与记录', workerQueryResponses('dummy.query', { '--collection': 'beta', '--window': 'W1' }));
      const messageId = sim.sendText('alpha 和 beta 的 W1 各有多少条、分别是什么？');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // 两个集合都在：alpha 2 条（1200/800）、beta 3 条（500/300/200）——来自真实执行返回。
      expect(reply).toContain('alpha W1 共 2 条');
      expect(reply).toContain('1200');
      expect(reply).toContain('800');
      expect(reply).toContain('beta W1 共 3 条');
      expect(reply).toContain('500');
      expect(reply).toContain('300');
      expect(reply).toContain('200');
      // 执行事实：两条 query 都 completed（不漏一个集合）。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(2);
      for (const execution of done!.executions) {
        expect(execution).toMatchObject({ operation: 'dummy.query', status: 'completed' });
      }
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('W-07 接 W-06：「算了，只看 beta」只讲 beta，不混 alpha 的数、不再执行', async () => {
    const sim = await startWecomSim({ label: 'w07' });
    try {
      // 上一回合：W-06 的两笔真实执行。
      sim.book.mainTurn('alpha 和 beta 的 W1 各有多少条、分别是什么？', [
        toolCallAssistant('task_run', { task: '查询 alpha 集合 W1 的条数与记录' }),
        () => toolCallAssistant('task_run', { task: '查询 beta 集合 W1 的条数与记录' }),
        (call: SimScriptCall) => textAssistant(taskSummariesOf(call.messages).join('\n')),
      ]);
      sim.book.workerTask('查询 alpha 集合 W1 的条数与记录', workerQueryResponses('dummy.query', { '--collection': 'alpha', '--window': 'W1' }));
      sim.book.workerTask('查询 beta 集合 W1 的条数与记录', workerQueryResponses('dummy.query', { '--collection': 'beta', '--window': 'W1' }));
      sim.sendText('alpha 和 beta 的 W1 各有多少条、分别是什么？');
      await sim.waitFor('第一回合终帧', () => sim.finalBubbles().length === 1);

      // 本回合：改口径只看 beta——回复取本会话转录里 beta 的**真实摘要**。
      sim.book.mainTurn('算了，只看 beta', [
        (call: SimScriptCall) => {
          const summaries = taskSummariesOf(call.messages);
          const beta = summaries.find((summary) => summary.includes('beta'));
          if (beta === undefined) throw new Error('本会话转录里没有 beta 的真实执行摘要。');
          return textAssistant(`好，那只看 beta 的：${beta}`);
        },
      ]);
      const messageId = sim.sendText('算了，只看 beta');
      await sim.waitFor('第二回合终帧', () => sim.finalBubbles().length === 2);

      const reply = sim.finalBubbles()[1]!.content;
      expect(reply).toContain('beta W1 共 3 条');
      expect(reply).toContain('500');
      // 不串台：alpha 的数（1200/800）不出现。
      expect(reply).not.toContain('1200');
      expect(reply).not.toContain('800');
      // 不再发起执行（改口径复用上文）。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(0);
    } finally {
      await sim.close();
    }
  }, 90_000);
});
