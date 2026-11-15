/**
 * P3 执行器侧预算硬停的确定性测试（构造超限样本，断言被强停；零真实模型）。
 *
 * 钉住的判据（与 enforce.ts 的机械语义一一对应）：
 *   · maxModelCalls 耗尽 → 下一次 run 前（零调用）抛 P3BudgetHardStopError(reason='calls')；
 *   · maxTokens 只按观测到的 usage 计，耗尽 → 硬停 reason='tokens'；无 usage 不强制；
 *   · wallMs 耗尽 → 回合前硬停 reason='ms'；回合内到点 → abort 在途请求并留 wall_abort 证；
 *   · deadline 被收紧为 min(原 deadline, 硬停墙)；
 *   · main/worker 共享同一 ledger（同一对象，不放大：一次调用只计一次）；
 *   · 未触发硬停时透传：text/messages 原样返回，compact/synthesizeAssistant 原样透传。
 */
import { describe, expect, it } from 'vitest';
import type { DriverMessage, TurnDriver, TurnDriverInput, TurnDriverResult } from '../../../packages/agent/src/driver-contract';
import {
  P3BudgetHardStopError,
  createBudgetLedger,
  createEnforcingDriver,
} from './enforce';

function assistantMessage(text: string, totalTokens?: number): DriverMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(totalTokens !== undefined
      ? { usage: { input: 10, output: totalTokens - 10, cacheRead: 0, totalTokens } }
      : {}),
  } as unknown as DriverMessage;
}

function baseInput(overrides: Partial<TurnDriverInput> = {}): TurnDriverInput {
  return {
    systemPrompt: 'sys',
    tools: [],
    messages: [],
    onStep: () => {},
    exec: async () => ({ ok: true }),
    deadline: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function fakeDriver(result: (input: TurnDriverInput) => TurnDriverResult | Promise<TurnDriverResult>): {
  driver: TurnDriver;
  runs: TurnDriverInput[];
} {
  const runs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    async run(input) {
      runs.push(input);
      return result(input);
    },
    compact: async (messages) => messages,
  };
  return { driver, runs };
}

describe('P3 预算硬停（执行器侧机械强制）', () => {
  it('maxModelCalls 耗尽：下一次 run 前零调用硬停，留证 reason=calls', async () => {
    const { driver, runs } = fakeDriver(() => ({ text: 'ok', messages: [assistantMessage('a', 50)] }));
    const ledger = createBudgetLedger({ maxModelCalls: 2 });
    const enforced = createEnforcingDriver(driver, 'main', ledger, { now: () => 0 });
    await enforced.run(baseInput());
    await enforced.run(baseInput());
    expect(runs.length).toBe(2);
    await expect(enforced.run(baseInput())).rejects.toBeInstanceOf(P3BudgetHardStopError);
    expect(runs.length).toBe(2); // 内层未被第三次调用（零调用强停，不依赖 Agent 自觉）
    const stopEvent = ledger.events.find((event) => event.event === 'p3_budget_hard_stop');
    expect(stopEvent).toMatchObject({ reason: 'calls', limit: 2, used: 2, agent: 'main' });
    expect(ledger.stopped).toMatchObject({ reason: 'calls' });
    // 已停之后任何 run 直接拒绝（同事实，不重开）。
    await expect(enforced.run(baseInput())).rejects.toMatchObject({ name: 'P3BudgetHardStopError' });
  });

  it('maxTokens 按观测 usage 累计：耗尽硬停 reason=tokens；无 usage 不强制', async () => {
    const withUsage = fakeDriver(() => ({ text: 'ok', messages: [assistantMessage('a', 100)] }));
    const ledger = createBudgetLedger({ maxTokens: 150 });
    const enforced = createEnforcingDriver(withUsage.driver, 'worker', ledger, { now: () => 0 });
    await enforced.run(baseInput()); // 100 < 150 继续
    await enforced.run(baseInput()); // 100 + 100 = 200 ≥ 150
    await expect(enforced.run(baseInput())).rejects.toMatchObject({ stop: { reason: 'tokens', limit: 150, used: 200 } });

    const noUsage = fakeDriver(() => ({ text: 'ok', messages: [assistantMessage('a')] }));
    const ledger2 = createBudgetLedger({ maxTokens: 1 });
    const enforced2 = createEnforcingDriver(noUsage.driver, 'main', ledger2, { now: () => 0 });
    for (let index = 0; index < 5; index += 1) await enforced2.run(baseInput());
    expect(ledger2.stopped).toBeNull(); // 未观测到 usage → 不伪造硬上限（unavailable 纪律）
  });

  it('wallMs 耗尽：回合前硬停 reason=ms；未耗尽时 deadline 收紧到硬停墙', async () => {
    let clock = 1_000;
    const { driver, runs } = fakeDriver(() => ({ text: 'ok', messages: [] }));
    const ledger = createBudgetLedger({ wallMs: 5_000 });
    const enforced = createEnforcingDriver(driver, 'main', ledger, { now: () => clock });
    await enforced.run(baseInput({ deadline: 1_000_000 }));
    expect(runs[0]!.deadline).toBe(6_000); // min(1_000_000, 1_000 + 5_000)
    clock = 6_001; // 墙钟越过硬停墙
    await expect(enforced.run(baseInput())).rejects.toMatchObject({ stop: { reason: 'ms', limit: 5_000 } });
  });

  it('回合内墙钟到点：abort 在途请求并留 wall_abort 证（不依赖 Agent 自觉）', async () => {
    const timers: Array<() => void> = [];
    const setTimer = (callback: () => void): (() => void) => {
      const fire = () => callback();
      timers.push(fire);
      return () => {};
    };
    let observedSignal: AbortSignal | undefined;
    const { driver } = fakeDriver(async (input) => {
      observedSignal = input.signal;
      await new Promise<unknown>((resolve, reject) => {
        input.signal!.addEventListener('abort', () => reject(new Error('aborted-by-hard-wall')));
        setTimeout(resolve, 5); // 未被 abort 时的自然结束（本用例应先被 abort 打断）
      });
      return { text: 'unreachable', messages: [] };
    });
    const ledger = createBudgetLedger({ wallMs: 10_000 });
    const enforced = createEnforcingDriver(driver, 'main', ledger, { now: () => 0, setTimer });
    const pending = enforced.run(baseInput());
    expect(timers.length).toBe(1);
    timers[0]!(); // 注入时钟到点
    await expect(pending).rejects.toThrow('aborted-by-hard-wall');
    expect(observedSignal?.aborted).toBe(true);
    expect(ledger.events.some((event) => event.event === 'p3_budget_wall_abort')).toBe(true);
    expect(ledger.used.calls).toBe(0); // 被中断的调用不计成功调用
  });

  it('main/worker 共享同一 ledger：一次调用只计一次', async () => {
    const ledger = createBudgetLedger({ maxModelCalls: 2 });
    const main = fakeDriver(() => ({ text: 'm', messages: [] }));
    const worker = fakeDriver(() => ({ text: 'w', messages: [] }));
    const enforcedMain = createEnforcingDriver(main.driver, 'main', ledger, { now: () => 0 });
    const enforcedWorker = createEnforcingDriver(worker.driver, 'worker', ledger, { now: () => 0 });
    await enforcedMain.run(baseInput());
    await enforcedWorker.run(baseInput());
    expect(ledger.used.calls).toBe(2);
    await expect(enforcedMain.run(baseInput())).rejects.toMatchObject({ stop: { reason: 'calls', used: 2 } });
    await expect(enforcedWorker.run(baseInput())).rejects.toBeInstanceOf(P3BudgetHardStopError);
  });

  it('未触发硬停时透传：text/messages 原样，compact/synthesizeAssistant 透传', async () => {
    const messages = [assistantMessage('kept', 5)];
    const { driver } = fakeDriver(() => ({ text: 'reply', messages }));
    const ledger = createBudgetLedger({ maxModelCalls: 10 });
    const enforced = createEnforcingDriver(driver, 'main', ledger, { now: () => 0 });
    const result = await enforced.run(baseInput({ messages: [] }));
    expect(result.text).toBe('reply');
    expect(result.messages).toBe(messages);
    await expect(enforced.compact!(messages)).resolves.toBe(messages);
    expect(ledger.stopped).toBeNull();
  });
});
