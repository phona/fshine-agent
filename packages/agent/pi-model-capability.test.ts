/**
 * T4 · 模型能力读取（架构调整相位 1）。
 *
 * 断言：pi-driver 的 contextWindow 从模型能力读，未提供时缺省值不变（128_000）。
 *
 * 为什么必须能读：压缩阈值 = contextWindow − reserveTokens（pi 原生规则）。硬编码
 * 128_000 时，一个真实窗口只有 40k 的部署要到 112k token 才压缩——窗口早就爆了；
 * 反过来，能力声明正确时阈值才落在真实窗口内。
 *
 * 机械判据：
 *   · 不给能力 → 模型的 contextWindow 是缺省 128_000（缺省行为一字不变）；
 *   · 给能力 → 模型声明该能力；
 *   · 阈值确实跟着能力走：40k 能力下 30k token 的转录会触发一次压缩尝试（生产代码
 *     走到摘要那一步，端点不可达所以失败——失败日志就是"尝试发生了"的机械证据），
 *     缺省 128k 下同样的转录原样返回、零日志。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiModelRuntime, createPiTurnDriver } from './src/pi-driver';

const ENV = { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'model-capability-key', LLM_MODEL: 'step-3.7-flash' };
/** 今天的硬编码值：未提供能力时必须还是它。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** ~30k token 的转录（4 字符 ≈ 1 token）：越过 40k 能力的阈值，不越 128k 的阈值。 */
function longTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 133; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${index} 段资料：${'x'.repeat(900)}` }],
      stopReason: 'stop',
      timestamp: index,
    } as unknown as AgentMessage);
  }
  return messages;
}

describe('T4 压缩阈值读模型能力', () => {
  it('不给能力：contextWindow 缺省不变（128_000）', () => {
    expect(createPiModelRuntime(ENV, 'step-3.7-flash').model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('给能力：模型的 contextWindow 从能力读', () => {
    expect(createPiModelRuntime(ENV, 'step-3.7-flash', { contextWindow: 40_000 }).model.contextWindow).toBe(40_000);
  });

  it('阈值跟着能力走：40k 能力触发压缩尝试，缺省 128k 原样返回', async () => {
    const messages = longTranscript();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
    try {
      const defaultDriver = createPiTurnDriver({ env: ENV });
      const defaultOut = await defaultDriver.compact!(messages);
      expect(defaultOut, '缺省 128k：阈值未到，必须原样返回').toBe(messages);
      expect(warns, '缺省 128k 不应触发任何压缩尝试').toEqual([]);

      const cappedDriver = createPiTurnDriver({ env: ENV, contextWindow: 40_000 });
      await cappedDriver.compact!(messages);
      expect(
        warns.some((line) => line.includes('context_compact_failed')),
        '40k 能力没有生效：仍按 128k 判阈值，压缩尝试没发生（能力没被读到）',
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
