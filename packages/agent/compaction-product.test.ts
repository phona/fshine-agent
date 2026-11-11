/**
 * T3 压缩产物不含声明块（架构调整相位 1）。
 *
 * 断言：压缩后的上下文（compact 的返回值）里不含 sidecar 标记串——产物只有
 * "pi 原生摘要 + 保留尾段"两种东西。宿主自己塞进去的第三块（自定义 custom 消息、
 * 引用出处索引、请求键记账）不算"上下文"，它是宿主影子状态：它会随压缩不断复利、
 * 并要求模型去调用已删掉的历史检索工具读"更早引用"。
 *
 * 机械判据（直调生产压缩实现，假模型运行时离线返回夹具摘要）：
 *   · 产物序列化后不含 `compacted_request_context` / `宿主压缩引用索引` / `request-v1:`；
 *   · 产物里每条消息都是原生 pi 形状（user/assistant/toolResult）；
 *   · 首条是原生摘要（说明压缩确实发生了，不是原样返回——否则"不含标记"是假绿）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import { compactTranscriptWithPi, type PiModelRuntime } from './src/pi-driver';

const SUMMARY_TEXT = '【夹具摘要】用户在核对应收余额，最近一次工具结果里的分页游标是 page_7。';

/** 假模型运行时：摘要由夹具返回，不发任何网络请求（压缩路径的其余部分全是生产代码）。 */
function fakeRuntime(contextWindow: number): PiModelRuntime {
  return {
    model: {
      id: 'step-3.7-flash',
      name: 'step-3.7-flash',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 32_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      completeSimple: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: SUMMARY_TEXT }],
        stopReason: 'stop',
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 20 },
        timestamp: Date.now(),
      }),
    } as unknown as MutableModels,
  };
}

/** 长转录：前缀里有一条带引用的用户消息（今天 sidecar 的引用出处来源）。 */
function longTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [
    {
      role: 'user',
      content: '这段引用是什么意思？',
      timestamp: 0,
      hostContext: { messageReference: { kind: 'text', text: '历史引用片段' } },
    } as unknown as AgentMessage,
  ];
  // 120 回合 × 800 字符 ≈ 24k token，越过 keepRecentTokens(20000)：前缀真的会被摘要掉。
  for (let index = 0; index < 120; index += 1) {
    messages.push({ role: 'user', content: `第 ${index} 轮：查一下应收余额`, timestamp: index * 2 + 1 } as unknown as AgentMessage);
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${index} 轮答复：${'x'.repeat(800)}` }],
      stopReason: 'stop',
      timestamp: index * 2 + 2,
    } as unknown as AgentMessage);
  }
  return messages;
}

describe('T3 压缩产物只有原生摘要与保留尾段', () => {
  it('压缩产物不含 sidecar 标记串，且不含宿主自定义消息', async () => {
    const transcript = longTranscript();
    // 窗口必须装得下一次「摘要输出 + 模板余量」；1000 token 的声明在物理上无法压缩，
    // T7 起按失败降解处理（不是本用例要测的产物形状）。60k 足够容纳默认保留尾段与摘要。
    const compacted = await compactTranscriptWithPi(transcript, { force: true }, fakeRuntime(60_000));

    const serialized = JSON.stringify(compacted);
    expect(serialized, '压缩产物里仍有 sidecar 声明块：宿主影子状态随压缩复利').not.toContain('compacted_request_context');
    expect(serialized, '压缩产物里仍有 sidecar 提示串：模型被指引去读引用出处索引').not.toContain('宿主压缩引用索引');
    expect(serialized, '压缩产物里仍有宿主请求键记账：影子状态仍在').not.toContain('request-v1:');

    // 反向半边：压缩确实发生了（原样返回时上面三条"不含"都是假绿）。
    expect(JSON.stringify(compacted[0]), '压缩没有发生：首条不是原生摘要').toContain('【此前会话摘要】');
    expect(compacted.length, '压缩没有发生：消息数不比原转录少').toBeLessThan(transcript.length);
    for (const message of compacted) {
      expect(['user', 'assistant', 'toolResult'], `压缩产物里出现宿主自定义消息：${JSON.stringify(message).slice(0, 120)}`)
        .toContain((message as { role?: string }).role);
    }
  });
});
