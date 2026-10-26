/**
 * 墙钟收尾信号（"失败必达"路径 1 前半段）的直测。两块：
 *
 *   ① 纯函数：90% 延迟的数学与边界（0/负值、极小预算）。
 *   ② SDK steer 契约（本实现的关键假设，独立验证）：pi-agent-core 的 Agent 在回合进行中
 *      收到 `steer(user 消息)` 时，会把该消息注入转录并在下一次模型调用前送达——这是
 *      pi-coding-driver run() 里 windDownTimer 依赖的投递语义。streamFn 用内存替身
 *      （AssistantMessageEventStream 直接 end），零网络零模型。
 *
 * ②钉的是"信号真的会到达 worker 并触发一次新的模型调用"；发信号的时机与一次性 latch
 * 在 pi-coding-driver.ts 的 run() 内联（Timer 语义由运行时保证，不在此重复驱动 SDK）。
 */
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai/compat';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { describe, expect, it } from 'vitest';
import { WIND_DOWN_FRACTION, WORKER_WIND_DOWN_NUDGE, windDownDelayMs } from './src/pi-coding-driver';

describe('windDownDelayMs（预算 90% 处发信号）', () => {
  it('常规预算：延迟 = 剩余 × 0.9（10s 剩余 → 9s 发信号，留 1s 收尾窗）', () => {
    expect(windDownDelayMs(10_000)).toBe(9_000);
    expect(WIND_DOWN_FRACTION).toBe(0.9);
  });

  it('小数向下取整；极小预算至少 1ms（信号仍会发出，随即可被 abort 兜底）', () => {
    expect(windDownDelayMs(251)).toBe(225);
    expect(windDownDelayMs(11)).toBe(9);
    expect(windDownDelayMs(1)).toBe(1);
    expect(windDownDelayMs(0)).toBe(1);
    expect(windDownDelayMs(-5)).toBe(1);
  });
});

/** 手工 Model 声明（streamFn 替身不真调它，只满足 Agent 初始化的类型面）。 */
const fakeModel: Model<'openai-completions'> = {
  id: 'winddown-test',
  name: 'winddown-test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://127.0.0.1:9',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
};

/** 一次性 stream 替身：直接 end 成给定的 assistant 终文（循环零事件走 result() 回退）。 */
function endedStream(text: string): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.end({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: fakeModel.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as never);
  return stream;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

describe('Agent.steer（收尾信号的投递契约）', () => {
  it('回合进行中 steer 的 user 消息被注入转录，并触发一次新的模型调用（worker 看得到收尾指令）', async () => {
    const modelCalls: number[] = [];
    // 闸门：第一跳的模型调用挂起，直到测试 steer 完再放行——把"回合进行中"固定成
    // 确定时序（生产里 windDownTimer 在 90% 处 steer，此处与之同形：入队时刻一定在
    // 下一次 getSteeringMessages 轮询之前）。
    let releaseFirst: () => void = () => {};
    const firstCallGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const agent = new Agent({
      initialState: {
        systemPrompt: 'winddown-test',
        model: fakeModel,
        tools: [],
        messages: [userMessage('做幻骥达工资表')],
      },
      streamFn: async (_model, context) => {
        modelCalls.push(context.messages.length);
        if (modelCalls.length === 1) await firstCallGate;
        return endedStream(modelCalls.length === 1 ? '继续干活…' : '已交付：tmp/x/工资表.xlsx；未完成：明细核对。');
      },
    });
    const run = agent.continue();
    // 等第一跳真实开跑（streamFn 已被调用、挂在闸门上），再发收尾信号。
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (modelCalls.length >= 1) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    agent.steer(userMessage(WORKER_WIND_DOWN_NUDGE));
    releaseFirst();
    await run;

    // 收尾指令进了转录（worker 会看得到），且模型被再次调用（它必须回应收尾指令）。
    const steered = agent.state.messages.find((message) => (message as { content?: unknown }).content === WORKER_WIND_DOWN_NUDGE);
    expect(steered).toBeDefined();
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    // 第二跳的模型输入里带着收尾指令（注入发生在下一次模型调用之前）。
    expect(modelCalls[1]).toBeGreaterThan(modelCalls[0]!);
    // 最终文本是收尾交付（模型对收尾指令的回应），不是第一跳的中间文本。
    const last = agent.state.messages.at(-1) as { role?: string; stopReason?: string };
    expect(last.role).toBe('assistant');
    expect(last.stopReason).toBe('stop');
  });

  it('收尾指令文案三要素：停止新工作 / 交付已完成部分（不写路径）/ 说明剩余未完成', () => {
    expect(WORKER_WIND_DOWN_NUDGE).toContain('停止');
    expect(WORKER_WIND_DOWN_NUDGE).toContain('交付已完成的部分');
    expect(WORKER_WIND_DOWN_NUDGE).toContain('未完成');
    expect(WORKER_WIND_DOWN_NUDGE).toContain('收尾');
    // W4：不再要求 worker 交还文件路径——产物由宿主按工作区扫描回收，路径对用户
    // 没有可行动性（2026-10-20 事故里"委派路径不存在"的叙述就是这么上屏的）。
    expect(WORKER_WIND_DOWN_NUDGE).toContain('不要在回复里写文件路径');
  });
});
