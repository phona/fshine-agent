/**
 * `pi_driver_model_error.attempt` 语义：本回合**失败周期内实际发生的模型尝试序号**（1 起）。
 *
 * 背景：重试不在驱动自建的循环里，而由 Pi 原生 `AgentSession` 按
 * `MAIN_MODEL_RETRY_SETTINGS`（`pi-driver.ts:38`，`maxRetries: 2`）执行；驱动只订阅
 * `auto_retry_start` / assistant `message_end`。旧实现把 `attempt` 硬编码为 1
 * （`pi-driver.ts:641`），于是「事件说 1、实际重试 2 次」，`docs/decisions/index.md`（R6 预注册 §七十八 行）
 * 的 H6.b（`attempt > 3`）无从核对。
 *
 * 判据：
 *   ① 失败 1 次、重试 1 次后最终失败 → attempt=2；
 *   ② 单次不可重试失败 → attempt=1；
 *   ③ 重试 2 次后最终失败 → attempt=3，绝不出现「事件说 1、实际重试 2 次」。
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

/** pi-ai 判据认作瞬时（可重试）的供应商话术。 */
const TRANSIENT_ERROR = '503 service unavailable: overloaded';
/** pi-ai 判据认作非瞬时（不可重试）的供应商话术。 */
const TERMINAL_ERROR = 'insufficient_quota: out of budget';

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

function modelErrors(events: LogEvent[]): LogEvent[] {
  return events.filter((event) => event.event === 'pi_driver_model_error');
}

describe('pi_driver_model_error.attempt = 实际模型尝试序号（不是硬编码 1）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 重试一次后最终失败：attempt=2（首次 + 1 次重试）', async () => {
    const { driver, calls } = await driverFor([
      assistant([], 'error', TRANSIENT_ERROR),
      assistant([], 'error', TERMINAL_ERROR),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: '查一下 beta 账套 W2 的往来余额', timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('');
      expect(calls(), '首次尝试 + 1 次重试 = 2 次真实模型调用').toBe(2);
      const errors = modelErrors(log.events());
      expect(errors).toHaveLength(1);
      expect(errors[0]?.attempt, '最终失败发生在第 2 次模型尝试').toBe(2);
      expect(errors[0]?.retryScheduled, '实际只重试了 1 次').toBe(1);
    } finally {
      log.restore();
    }
  });

  it('② 单次不可重试失败：attempt=1（不重试也不虚报）', async () => {
    const { driver, calls } = await driverFor([
      assistant([], 'error', TERMINAL_ERROR),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: '查一下 beta 账套 W2 的往来余额', timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('');
      expect(calls(), '不可重试错误只发生 1 次模型调用').toBe(1);
      const errors = modelErrors(log.events());
      expect(errors).toHaveLength(1);
      expect(errors[0]?.attempt, '首次尝试即最终失败：attempt=1').toBe(1);
      expect(errors[0]?.retryScheduled).toBe(0);
    } finally {
      log.restore();
    }
  });

  it('③ 重试两次后最终失败：attempt=3，绝不出现「事件说 1、实际重试 2 次」', async () => {
    const { driver, calls } = await driverFor([
      assistant([], 'error', TRANSIENT_ERROR),
      assistant([], 'error', TRANSIENT_ERROR),
      assistant([], 'error', TRANSIENT_ERROR),
    ]);
    const log = captureLogEvents();
    try {
      const result = await driver.run(input([
        { role: 'user', content: '查一下 beta 账套 W2 的往来余额', timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('');
      expect(calls(), '首次尝试 + 2 次重试 = 3 次真实模型调用').toBe(3);
      const events = log.events();
      const retryEvents = events.filter((event) => event.event === 'pi_driver_retry_scheduled');
      expect(retryEvents.map((event) => event.attempt), 'Pi 原生重试序号 1、2 各一次').toEqual([1, 2]);
      const errors = modelErrors(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.retryScheduled, '实际重试了 2 次').toBe(2);
      expect(
        errors[0]?.attempt,
        '两次重试后最终失败是第 3 次尝试——事件说 1 就是假话',
      ).toBe(3);
      expect(errors[0]?.attempt).not.toBe(1);
    } finally {
      log.restore();
    }
  });
});
