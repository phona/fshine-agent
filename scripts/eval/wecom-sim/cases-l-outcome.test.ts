/**
 * L 组·答复五态用户可见行为（B4）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 判据（用户可见结果；执行层真实、模型响应脚本化）：
 *   L-1  用户要一件目录里没有的事 → 零执行、outcome=unsupported、Main 说「办不了」并列出
 *        能办的、文本不含任何重试诱导词（再试/重试/retry）；
 *   L-2  目录里有但本次不允许（只读允许集）→ 零执行、outcome=blocked、Main 说「缺什么」
 *        （本次允许范围），不说成「办不了」。
 *
 * 两条都走真装配（真 server + 仓内 dummy + 假企微 SDK）；outcome 是宿主按底账机械分类的
 * 结构化事实（[outcome=...]），假模型按该事实选措辞——不是硬编台词混过断言。
 * taskRunWaitMs:0 让任务直接走后台失败唤醒出口（不被同回合 relayed 抑制）。
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_FACT_PREFIX,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  lastToolResultOf,
} from './harness';

/** 唤醒回合喂给 Main 的失败事实（从脚本记录的 messages 里取，证明是宿主机械注入的）。 */
function wakeFactOf(sim: ReturnType<typeof startWecomSim> extends Promise<infer F> ? F : never): string {
  for (const [, messages] of sim.book.requestMessages) {
    for (const message of messages as ReadonlyArray<{ role?: unknown; content?: unknown }>) {
      if (message.role !== 'user') continue;
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part: { text?: unknown }) => (part as { text?: unknown }).text ?? '').join('')
          : '';
      if (typeof text === 'string' && text.includes(FAILURE_FACT_PREFIX)) return text;
    }
  }
  return '';
}

describe('L 组·答复五态用户可见行为（B4，自动）', () => {
  it('L-1 目录里没有的事：零执行、说办不了并列出能办的、不含重试诱导词', async () => {
    const sim = await startWecomSim({ label: 'l1', taskDispatch: 'async', taskRunWaitMs: 0 });
    try {
      const request = '帮我把隔壁星球的天气改一下';
      // Main 交办；Worker **一个办理动作都不发**（没有这个能力 → 零执行）。
      sim.book.mainTurn(request, [toolCallAssistant('task_run', { task: request }), textAssistant('我这就看看。')]);
      sim.book.workerTask(request, [textAssistant('我看了下，这事我这边没有任何可以执行的动作。')]);
      const messageId = sim.sendText(request);
      await sim.waitFor('L-1 交办回合结束', () => sim.doneOf(messageId) !== undefined, 15_000);
      // 零执行事实（没有办理动作发生）。
      expect(sim.doneOf(messageId)!.executions).toHaveLength(0);

      // 后台失败 → 唤醒事实带 [outcome=unsupported]；假模型据此说「办不了」（主动投递）。
      await sim.waitFor('L-1 办不了答复', () => sim.sdk.proactiveTexts.length >= 1, 20_000);
      // 宿主机械事实确实带结构化 outcome（不是假模型硬编）。
      const fact = wakeFactOf(sim);
      expect(fact).toContain('[outcome=unsupported]');
      const reply = sim.sdk.proactiveTexts.at(-1)!.content;
      expect(reply).toContain('办不了');
      expect(reply).toContain('记录办理');
      // G4：不含任何重试诱导词。
      for (const word of ['再试一次', '重试', 'retry']) expect(reply).not.toContain(word);
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('L-2 目录里有但本次不允许：零执行、说清缺什么，不说成办不了', async () => {
    const sim = await startWecomSim({ label: 'l2', taskDispatch: 'async', taskRunWaitMs: 0 });
    try {
      const request = '给 alpha 集合 W1 追加 1 条记录';
      sim.book.mainTurn(request, [toolCallAssistant('task_run', { task: request }), textAssistant('我这就办。')]);
      sim.book.workerTask(request, [
        // 写操作不在只读允许集 → 发起前确定性拒绝、零执行（hostRefusedOperations 记权限）。
        toolCallAssistant('op_dummy_prepare', { collection: 'alpha', window: 'W1', '--count': 1 }),
        (call) => {
          const result = lastToolResultOf(call.messages);
          expect(result?.isError === true && result.text.includes('当前权限不支持')).toBe(true);
          return textAssistant('写操作没有开放，这次没有执行。');
        },
      ]);
      // 只读装配：无 allowWriteOperations（写不在允许集）。
      const messageId = sim.sendText(request);
      await sim.waitFor('L-2 交办回合结束', () => sim.doneOf(messageId) !== undefined, 15_000);
      expect(sim.doneOf(messageId)!.executions).toHaveLength(0);

      // 失败唤醒事实带 [outcome=blocked][缺=本次允许范围]。
      await sim.waitFor('L-2 缺条件答复', () => sim.sdk.proactiveTexts.length >= 1, 20_000);
      // 宿主机械事实带 blocked + 非空缺失条件（B2/G4）。
      const fact = wakeFactOf(sim);
      expect(fact).toContain('[outcome=blocked]');
      expect(fact).toMatch(/\[缺=\S[^\]]*\]/);
      const reply = sim.sdk.proactiveTexts.at(-1)!.content;
      expect(reply).toContain('缺的是');
      expect(reply).toContain('本次允许范围');
      expect(reply).not.toContain('办不了');
    } finally {
      await sim.close();
    }
  }, 90_000);
});
