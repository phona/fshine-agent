/**
 * SimCase · 真实模型调用（模拟用户用；OpenAI 兼容 `/chat/completions`）。
 *
 * 只做一件事：一次请求 → 一次补全 + usage。不重试、不掩盖限流（429 原样抛出，
 * 由 trial 记录为 error，样本照常保留）。被测系统不经过这里（走生产同源装配）。
 */
import type { CallTokens } from '../r6/accounting';
import type { ModelPrompt, SimModel, SimModelCompletion } from './simulator';

export interface ChatModelInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly label: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
}

/**
 * 缺省输出额度。**不能是 1024**：sim6 批次（2026-11-16T07-25-05-145Z）实测 50 次模拟用户调用中
 * 有 4 次 `completion_tokens` 恰好 1024 且 `content` 为空——reasoning 模型把额度全用在思考上，
 * 动作 JSON 一个字都没吐出来，导致首答 + 2 次修复全空、trial 被记 `protocol_error`（夹具缺陷，
 * 不是产品读数）。4096 给动作 JSON 留出足够余量；仍不足以掩盖任何协议错误。
 */
const DEFAULT_MAX_TOKENS = 4096;

interface ChatCompletionBody {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }>;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createChatModel(input: ChatModelInput): SimModel {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async complete(prompt: ModelPrompt): Promise<SimModelCompletion> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: false,
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        // 429 不自动重试：原样抛出，报告里能看到状态码与响应片段。
        throw new Error(`${input.label} 模型调用失败：HTTP ${response.status} ${raw.slice(0, 300)}`);
      }
      let body: ChatCompletionBody;
      try {
        body = JSON.parse(raw) as ChatCompletionBody;
      } catch {
        throw new Error(`${input.label} 模型响应不是 JSON：${raw.slice(0, 200)}`);
      }
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      const usage = body.usage;
      const tokens: CallTokens | undefined = usage === undefined
        ? undefined
        : {
            input: numberOrZero(usage.prompt_tokens),
            output: numberOrZero(usage.completion_tokens),
            total: numberOrZero(usage.total_tokens),
          };
      return {
        text,
        ...(tokens === undefined ? { tokensObserved: false } : { tokens, tokensObserved: true }),
      };
    },
  };
}
