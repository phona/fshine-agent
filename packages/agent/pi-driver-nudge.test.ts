/**
 * T7 主驱动收尾控制流（脚本化 ModelRuntime，零真实请求）。
 *
 * 今天实测的空回复日志：`stopReason=stop`、content 只有 thinking 块。驱动原先取不到
 * 正文就交回空字符串，宿主兜底成零数字的「查询失败」。本文件直测驱动控制流：
 *   · thinking-only 收尾 → 追加一次收尾催问 → 第二次模型调用给出正文 → 交回正文；
 *   · 正常有正文 → 只调用一次模型（催问绝不污染正常回复）；
 *   · 上下文超限 → Pi 原生溢出恢复（压缩一次 + 重发一次）后交回正文，有界不循环。
 *
 * 迁移说明（1.5.2）：模型接缝从 pi-ai `Models` 换成公开 `ModelRuntime`（脚本化 provider）；
 * 溢出恢复后总调用数 = 3（超限 1 + 摘要 1 + 重发 1），旧夹具为 2——断言仍钉「有界」。
 */
import { describe, expect, it, vi } from 'vitest';
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

async function driverFor(responses: AgentMessage[], contextWindow = 40_000) {
  const scripted = await createScriptedModelRuntime({
    contextWindow,
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

describe('T7 主驱动收尾控制流', () => {
  it('thinking-only 收尾：催一次最终文本，交回正文', async () => {
    const { driver, calls } = await driverFor([
      assistant([{ type: 'thinking', thinking: '我在想怎么回答……' }]),
      assistant([{ type: 'text', text: '最终回复：beta W2 无数据，可用窗口是 W1。' }]),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
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

  it('上下文超限错误：Pi 原生溢出恢复有界（压缩 + 重发）后交回正文', async () => {
    // 小窗口（8192 → Pi 配置适配缩放 keepRecent=2457）保证 Pi 有可压缩的尾段切点。
    // 摘要请求按 Pi 的提示形状区分（split turn 会分别总结历史与回合前缀），主请求按序取回复。
    const summary = assistant([{ type: 'text', text: '【夹具摘要】此前对话已折叠。' }]);
    const overflow = assistant([], 'error', 'maximum context length exceeded: 48430 + 13107 > 8192');
    const recovery = assistant([{ type: 'text', text: '压缩后恢复的正文。' }]);
    const { driver, calls } = await (async () => {
      const scripted = await createScriptedModelRuntime({
        contextWindow: 8_192,
        script: (index, context) => {
          const body = JSON.stringify(context.messages);
          const isSummary = body.includes('<conversation>') || body.includes('# Conversation');
          if (isSummary) return summary;
          return index === 0 ? overflow : recovery;
        },
      });
      return {
        driver: createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime }),
        calls: scripted.calls,
      };
    })();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const u = (text: string, ts: number) => ({ role: 'user', content: text, timestamp: ts } as unknown as AgentMessage);
      const result = await driver.run(input([
        u('第一轮问题', 1),
        assistant([{ type: 'text', text: '第一轮答复' }]),
        u('第二轮问题', 2),
        u('x'.repeat(20_000), 3),
      ]));

      expect(result.text, 'Pi 原生溢出恢复后交回正文').toBe('压缩后恢复的正文。');
      // 1 次主请求（超限）+ 2 次摘要（历史 + 回合前缀，Pi 的 split-turn 路径）+ 1 次重发 = 4；
      // 判据是「有界且最终收束」，不无限重试。
      expect(calls(), '溢出恢复有界（≤4 次调用），不无限重试').toBeLessThanOrEqual(4);
      expect(calls()).toBeGreaterThan(1);
    } finally {
      error.mockRestore();
    }
  });

  it('正常有正文：只调用一次模型，不触发催问', async () => {
    const { driver, calls } = await driverFor([
      assistant([{ type: 'text', text: 'beta W2 无数据。' }]),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await driver.run(input([{ role: 'user', content: 'W2 有数据吗？', timestamp: 1 } as unknown as AgentMessage]));

      expect(result.text).toBe('beta W2 无数据。');
      expect(calls()).toBe(1);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_final_text_nudge'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
