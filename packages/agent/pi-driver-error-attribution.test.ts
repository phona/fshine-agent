/**
 * T7 (a) 主驱动错误归因——确定性半，与窗口无关的生产隐患。
 *
 * 实测败状（2026-11-11 长窗臂 C1）：供应商 error / 只输出 thinking / 空 content 三种
 * 模型响应形状，主驱动原先一律交回空字符串、不打任何事件，宿主兜底成一句零数字的
 * 「查询失败」。修复后三类形状必须各有可归因的结构化事件（pi_driver_model_error /
 * pi_driver_failed_assistant / pi_driver_empty_reply / pi_driver_final_text_nudge[_empty]），并且：
 *   · thinking-only 的 stop 回复先催一次最终文本——催出来就交回正文；
 *   · 任何形状最终仍无正文时，交回的空文本必须伴随"这轮为什么空"的日志证据，绝不静默。
 *
 * 迁移（1.5.2）：假模型接缝从 pi-ai `Models` 工厂（vi.mock）换成公开 `ModelRuntime` 的
 * 脚本化 provider；被测控制流与断言不变，零网络、零真实平台。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

function assistant(content: unknown[], stopReason = 'stop', errorMessage?: string): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

async function driverFor(responses: AgentMessage[]) {
  const scripted = await createScriptedModelRuntime({
    contextWindow: 40_000,
    script: (index) => responses[index],
  });
  return {
    driver: createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime }),
    calls: scripted.calls,
  };
}

function input(messages: AgentMessage[]) {
  return {
    systemPrompt: '你是助手。',
    tools: [],
    messages,
    onStep: () => {},
    exec: async () => undefined,
    deadline: Date.now() + 60_000,
  };
}

interface LogEvent { event?: string; [key: string]: unknown }

/** 结构化日志事件收集器：console.error/warn/info 的 JSON 行都算（生产里事件就是从这里看的）。 */
function captureLogEvents() {
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
  const events = (): LogEvent[] => spies.flatMap((spy) => spy.mock.calls.flatMap((call) => {
    const line = String(call[0]);
    try {
      const parsed = JSON.parse(line) as LogEvent;
      return typeof parsed === 'object' && parsed !== null ? [parsed] : [];
    } catch {
      return [];
    }
  }));
  return { events, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

describe('T7 主驱动错误归因（三种模型响应形状不许吞成空字符串）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 供应商 error：上报 pi_driver_model_error + pi_driver_failed_assistant，供应商话术进日志', async () => {
    const { driver, calls } = await driverFor([
      // 不可瞬时重试的供应商错误（quota/billing 类，pi-ai 判据归非瞬时）：主驱动必须把
      // 这条错误如实上报，而不是吞成空字符串让宿主兜底成零数字的「查询失败」。
      assistant([], 'error', 'insufficient_quota: out of budget'),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: 'check beta collection W2 record value', timestamp: 1 } as unknown as AgentMessage,
      ]));

      // 交回的确实是空文本（驱动不编造正文），但必须可归因：
      expect(result.text).toBe('');
      const events = log.events();
      const modelError = events.filter((event) => event.event === 'pi_driver_model_error');
      expect(modelError.length, '供应商 error 必须上报 pi_driver_model_error').toBeGreaterThan(0);
      expect(
        modelError.some((event) => String(event.errorMessage ?? '').includes('insufficient_quota')),
        '事件里必须带供应商原话（可归因），不能只剩"出错了"',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_failed_assistant' && event.stopReason === 'error'),
        'stopReason=error 的 assistant 必须上报 pi_driver_failed_assistant',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_empty_reply'),
        '吞掉错误 assistant 后仍无正文：空回复也必须上报（双层归因，不许静默）',
      ).toBe(true);
      expect(calls(), '非瞬时供应商错误不重试（重试是另一条有界路径）').toBe(1);
    } finally {
      log.restore();
    }
  });

  it('①b 带部分流式正文但无 errorMessage 的 error assistant：pi_driver_failed_assistant 上报，不许当成功回合交回', async () => {
    const { driver, calls } = await driverFor([
      // stopReason=error 但 errorMessage 为空（流层截断的形状）：错误 assistant 留在转录里，
      // 必须被 pi_driver_failed_assistant 点名——它可能含半截流式正文，绝不能当成功回复。
      assistant([{ type: 'text', text: '部分流式正文……' }], 'error'),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: 'check beta collection W2 record value', timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('');
      const events = log.events();
      expect(
        events.some((event) => event.event === 'pi_driver_failed_assistant' && event.stopReason === 'error'),
        'stopReason=error 的 assistant 必须上报 pi_driver_failed_assistant',
      ).toBe(true);
      expect(calls()).toBe(1);
    } finally {
      log.restore();
    }
  });

  it('② 只输出 thinking 块：先上报 pi_driver_empty_reply，催问一次后交回正文', async () => {
    const { driver, calls } = await driverFor([
      assistant([{ type: 'thinking', thinking: '我在想怎么组织这份回复……' }]),
      assistant([{ type: 'text', text: 'beta W2 该期间无数据。' }]),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: 'beta W2 有数据吗？', timestamp: 1 } as unknown as AgentMessage,
      ]));

      // 空形状先归因上报（不是静默吞），再催一次拿正文——宿主拿到的是真回复：
      expect(result.text).toBe('beta W2 该期间无数据。');
      const events = log.events();
      const emptyReply = events.filter((event) => event.event === 'pi_driver_empty_reply');
      expect(emptyReply.length, 'thinking-only 空形状必须上报 pi_driver_empty_reply').toBeGreaterThan(0);
      expect(
        emptyReply.some((event) => Array.isArray(event.contentBlocks) && event.contentBlocks.includes('thinking')),
        '事件里必须标明这轮只有 thinking 块（形状可归因）',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_final_text_nudge'),
        '必须对只思考没正文追加一次收尾催问',
      ).toBe(true);
      expect(calls(), '催问必须真实发生第二次模型调用').toBe(2);
      const roles = result.messages.map((message) => (message as { role?: string }).role);
      expect(roles.slice(-2), '催问以 user 消息进转录，正文是最后一条 assistant').toEqual(['user', 'assistant']);
    } finally {
      log.restore();
    }
  });

  it('②b thinking 块且催问后仍只 thinking：pi_driver_final_text_nudge_empty 归因，空文本不许静默', async () => {
    const { driver, calls } = await driverFor([
      assistant([{ type: 'thinking', thinking: '再想想……' }]),
      assistant([{ type: 'thinking', thinking: '还是只想到思考……' }]),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: 'check beta collection W2 record value', timestamp: 1 } as unknown as AgentMessage,
      ]));

      // 催问也救不回来：交回空文本，但每一层都有日志证据——排障不再靠猜。
      expect(result.text).toBe('');
      const events = log.events();
      expect(
        events.some((event) => event.event === 'pi_driver_empty_reply'),
        '空回复必须上报 pi_driver_empty_reply',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_final_text_nudge'),
        '先催过一次收尾',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_final_text_nudge_empty'),
        '催问仍空必须上报 pi_driver_final_text_nudge_empty',
      ).toBe(true);
      expect(calls(), '只催一轮，不循环烧调用').toBe(2);
    } finally {
      log.restore();
    }
  });

  it('③ 空 content：上报 pi_driver_empty_reply（contentBlocks 为空数组），催问仍空则二次归因', async () => {
    const { driver, calls } = await driverFor([
      assistant([]),
      assistant([]),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: 'check beta collection W2 record value', timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('');
      const events = log.events();
      const emptyReply = events.filter((event) => event.event === 'pi_driver_empty_reply');
      expect(emptyReply.length, '空 content 必须上报 pi_driver_empty_reply，不许吞成空字符串').toBeGreaterThan(0);
      expect(
        emptyReply.some((event) => Array.isArray(event.contentBlocks) && (event.contentBlocks as unknown[]).length === 0),
        '事件里必须标明 content 为空数组（形状可归因）',
      ).toBe(true);
      expect(
        events.some((event) => event.event === 'pi_driver_final_text_nudge_empty'),
        '催问仍空必须二次归因',
      ).toBe(true);
      expect(calls()).toBe(2);
    } finally {
      log.restore();
    }
  });
});
