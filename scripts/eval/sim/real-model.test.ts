/**
 * 真实模型调用（模拟用户侧）的确定性自检：只验证请求体与响应投影，不触网。
 *
 * 回归背景（sim6 批次 SIM-05#1，2026-11-16T07-25-05-145Z）：`max_tokens` 缺省 1024 对
 * reasoning 模型太小——本次跑批 50 次模拟用户调用里有 4 次 output 恰好 1024 且 content 为空，
 * 首答 + 2 次修复全部空输出，trial 被记成 `protocol_error`。这是**夹具缺陷**，不是产品读数。
 * 这里锁死：缺省额度必须给足（≥4096），且调用方显式覆盖时照办。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatModel } from './real-model';

const base = {
  baseUrl: 'https://example.invalid/v1/',
  apiKey: 'test-key',
  model: 'test-model',
  label: 'simulator',
};

function stubFetch(status: number, body: unknown): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createChatModel（模拟用户侧真实调用）', () => {
  it('缺省 max_tokens 足够 reasoning 模型输出动作（≥4096），不是 1024', async () => {
    const { calls } = stubFetch(200, { choices: [{ message: { content: '{"action":"say","text":"x"}' } }] });
    const model = createChatModel(base);
    const completion = await model.complete({ system: 's', user: 'u' });
    expect(completion.text).toBe('{"action":"say","text":"x"}');
    const body = JSON.parse(String(calls[0]!.body)) as { max_tokens?: number; model?: string; stream?: boolean };
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
  });

  it('显式 maxTokens 覆盖缺省值', async () => {
    const { calls } = stubFetch(200, { choices: [{ message: { content: '{}' } }] });
    await createChatModel({ ...base, maxTokens: 777 }).complete({ system: 's', user: 'u' });
    const body = JSON.parse(String(calls[0]!.body)) as { max_tokens?: number };
    expect(body.max_tokens).toBe(777);
  });

  it('usage 投影为 input/output/total；缺 usage 时标注不可得', async () => {
    stubFetch(200, {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const withUsage = await createChatModel(base).complete({ system: 's', user: 'u' });
    expect(withUsage.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(withUsage.tokensObserved).toBe(true);

    stubFetch(200, { choices: [{ message: { content: 'ok' } }] });
    const noUsage = await createChatModel(base).complete({ system: 's', user: 'u' });
    expect(noUsage.tokensObserved).toBe(false);
  });

  it('429/HTTP 错误原样抛出，不重试（不掩盖限流）', async () => {
    const { calls } = stubFetch(429, { error: 'rate limited' });
    await expect(createChatModel(base).complete({ system: 's', user: 'u' })).rejects.toThrow(/HTTP 429/);
    expect(calls).toHaveLength(1);
  });

  it('空 content → text 为空串（交给协议修复，不在此编造动作）', async () => {
    stubFetch(200, { choices: [{ message: { content: null } }] });
    const completion = await createChatModel(base).complete({ system: 's', user: 'u' });
    expect(completion.text).toBe('');
  });
});
