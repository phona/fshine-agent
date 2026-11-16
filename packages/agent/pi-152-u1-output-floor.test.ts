import { describe, expect, it } from 'vitest';
import { buildBaseOptions, clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import type { Api, Model } from '@earendil-works/pi-ai';

/**
 * U1 补丁守卫（随 `patches/@earendil-works+pi-ai+1.5.2.patch` 一起删除）。
 *
 * 缺陷：`clampMaxTokensToContext` 在 room 不足时返回 `max(1, room)`，接近窗口的请求被压成
 * `max_completion_tokens=1`；thinking 模型把 1 token 用在 thinking 块，正文为空。
 * 修复：仅当调用方「没有显式要求输出上限」（走 `model.maxTokens`）时，给 room 推导值加下限
 * 1024（同文件 `MIN_ANSWER_TOKENS` 的取值）；显式 `options.maxTokens` 仍只受 room 约束。
 *
 * 无补丁时前两组用例必红（1024 期望落空），第三组（显式保留）是防止下限过宽的绊线。
 */

const API = 'openai-completions' as Api;
const CHARS_PER_TOKEN = 3.5;

function modelWith(maxTokens: number, contextWindow = 16_384): Model<Api> {
  return {
    id: 'u1-test-model',
    name: 'u1-test-model',
    provider: 'llm',
    api: API,
    baseUrl: 'https://example.invalid',
    contextWindow,
    maxTokens,
  } as unknown as Model<Api>;
}

/** 构造估算为 `tokens` 的上下文：估算口径 ceil(chars / 3.5)（pi-ai/utils/estimate.js）。 */
function contextWith(tokens: number): { systemPrompt: string; messages: unknown[] } {
  const chars = Math.ceil(tokens * CHARS_PER_TOKEN);
  return {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }],
  };
}

const ctxOf = (t: number) => contextWith(t) as never;

/**
 * 补丁给 `clampMaxTokensToContext` 加了尾部可选参数，但上游 `.d.ts` 不在补丁范围（只改执行文件），
 * 所以这里按运行时实际签名收窄一次；无补丁时第 4 个实参被运行时忽略，断言即红。
 */
const clampWith = clampMaxTokensToContext as unknown as (
  model: Model<Api>,
  context: never,
  maxTokens: number,
  derivedFloor: number,
) => number;

describe('pi-ai 1.5.2 U1：room 推导的 clamp 下限', () => {
  // 窗口 16384 / margin 4096：input=12288 → room=0；input=14000 → room<0；input=11788 → room=500
  it('room=0 时不再落到 1 token', () => {
    const model = modelWith(2048);
    expect(clampWith(model, ctxOf(12288), 2048, 1024)).toBe(1024);
    expect(clampMaxTokensToContext(model, ctxOf(12288), 2048)).toBe(1);
  });

  it('room<0（输入已越窗口）时仍给出可用下限，而不是 1', () => {
    const model = modelWith(2048);
    expect(clampWith(model, ctxOf(14000), 2048, 1024)).toBe(1024);
  });

  it('room 落在 (1,1024) 区间时抬到下限；room≥1024 时不被放大', () => {
    const model = modelWith(32000);
    expect(clampWith(model, ctxOf(11788), 32000, 1024)).toBe(1024);
    expect(clampWith(model, ctxOf(9288), 32000, 1024)).toBe(3000);
    expect(clampWith(model, ctxOf(9288), 32000, 1024)).toBe(clampMaxTokensToContext(model, ctxOf(9288), 32000));
  });

  it('buildBaseOptions：未显式请求时走下限，且不超过 model.maxTokens', () => {
    const model = modelWith(2048);
    const base = buildBaseOptions(model, ctxOf(14000), undefined, 'k');
    expect(base.maxTokens).toBe(1024);
    const small = buildBaseOptions(modelWith(512), ctxOf(14000), undefined, 'k');
    expect(small.maxTokens).toBe(512);
  });

  it('buildBaseOptions：显式少量 maxTokens 原样保留（下限不生效，仍受 room 约束）', () => {
    const model = modelWith(2048);
    expect(buildBaseOptions(model, ctxOf(14000), { maxTokens: 1 }, 'k').maxTokens).toBe(1);
    expect(buildBaseOptions(model, ctxOf(11788), { maxTokens: 300 }, 'k').maxTokens).toBe(300);
    // 显式大值仍被 room 约束为 500，而不是被下限抬到 1024
    expect(buildBaseOptions(model, ctxOf(11788), { maxTokens: 2048 }, 'k').maxTokens).toBe(500);
  });
});
