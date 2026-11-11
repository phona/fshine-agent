/**
 * T7 主驱动收尾控制流（注入假模型运行时，零真实请求）。
 *
 * 今天实测的空回复日志：`stopReason=stop`、content 只有 thinking 块。驱动原先取不到
 * 正文就交回空字符串，宿主兜底成零数字的「查询失败」。本文件直测驱动控制流：
 *   · thinking-only 收尾 → 追加一次收尾催问 → 第二次模型调用给出正文 → 交回正文；
 *   · 正常有正文 → 只调用一次模型（催问绝不污染正常回复）。
 *
 * 判据能量化：模型调用次数、最终 text、转录里催问消息的位置、结构化日志事件。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import { createPiTurnDriver, type PiModelRuntime } from './src/pi-driver';

function assistant(content: unknown[], stopReason = 'stop', errorMessage?: string): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'llm',
    model: 'step-3.7-flash',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** pi-ai 的流式返回面：async iterable + result()。 */
function streamOf(message: AgentMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'done', reason: (message as { stopReason?: string }).stopReason, message };
    },
    result: async () => message,
  };
}

function fakeRuntime(responses: AgentMessage[]): { runtime: PiModelRuntime; calls: () => number } {
  let calls = 0;
  const runtime: PiModelRuntime = {
    model: {
      id: 'step-3.7-flash',
      name: 'step-3.7-flash',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 40_000,
      maxTokens: 32_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      streamSimple: async () => {
        calls += 1;
        const response = responses.shift();
        if (!response) throw new Error('假模型运行时没有更多响应');
        return streamOf(response);
      },
      // 压缩摘要用（溢出恢复路径会先压缩再重发）。
      completeSimple: async () => assistant([{ type: 'text', text: '【夹具摘要】此前对话已折叠。' }]),
    } as unknown as MutableModels,
  };
  return { runtime, calls: () => calls };
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

describe('T7 主驱动收尾控制流', () => {
  it('thinking-only 收尾：催一次最终文本，交回正文', async () => {
    const { runtime, calls } = fakeRuntime([
      assistant([{ type: 'thinking', thinking: '我在想怎么回答……' }]),
      assistant([{ type: 'text', text: '最终回复：beta W2 无数据，可用窗口是 W1。' }]),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime });
      const result = await driver.run(input([{ role: 'user', content: 'W2 有数据吗？', timestamp: 1 } as unknown as AgentMessage]));

      expect(result.text).toBe('最终回复：beta W2 无数据，可用窗口是 W1。');
      expect(calls(), 'thinking-only 之后必须再调用一次模型拿正文').toBe(2);
      const roles = result.messages.map((message) => (message as { role?: string }).role);
      expect(roles.slice(-2), '催问必须以 user 消息进入转录，正文是最后一条 assistant').toEqual(['user', 'assistant']);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_final_text_nudge'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('上下文超限错误：先压缩再重发，交回恢复后的正文', async () => {
    const { runtime, calls } = fakeRuntime([
      assistant([], 'error', 'maximum context length exceeded: 48430 + 13107 > 40000'),
      assistant([{ type: 'text', text: '压缩后恢复的正文。' }]),
    ]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime });
      const result = await driver.run(input([
        { role: 'user', content: 'x'.repeat(60_000), timestamp: 1 } as unknown as AgentMessage,
      ]));

      expect(result.text).toBe('压缩后恢复的正文。');
      expect(calls(), '超限错误后必须重发一次（不是把空文本交回宿主）').toBe(2);
      expect(info.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_context_overflow_recovered'))).toBe(true);
      expect(error.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_model_error'))).toBe(true);
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  it('正常有正文：只调用一次模型，不触发催问', async () => {
    const { runtime, calls } = fakeRuntime([
      assistant([{ type: 'text', text: 'beta W2 无数据。' }]),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime });
      const result = await driver.run(input([{ role: 'user', content: 'W2 有数据吗？', timestamp: 1 } as unknown as AgentMessage]));

      expect(result.text).toBe('beta W2 无数据。');
      expect(calls()).toBe(1);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_final_text_nudge'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
