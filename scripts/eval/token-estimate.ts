/**
 * 转录 token 估算（实验脚本共用；只用 Pi 公开导出，不改读数口径）。
 *
 * pi-agent-core 1.5.2 不再导出 `estimateContextTokens`；这里按同一口径复现：
 * 最近一条带 usage 的 assistant 之前用 provider 报的 usage（`calculateContextTokens`），
 * 其后的尾段用 Pi 的字符估算器（`estimateTokens`）；没有 usage 时全部按估算累加。
 */
import { calculateContextTokens, estimateTokens } from '@earendil-works/pi-coding-agent';

interface UsageBearingMessage {
  role?: string;
  usage?: unknown;
}

export function estimateContextTokens(messages: readonly unknown[]): { tokens: number } {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as UsageBearingMessage;
    if (message?.role === 'assistant' && message.usage !== undefined) {
      lastUsageIndex = i;
      usageTokens = calculateContextTokens(message.usage as never);
      break;
    }
  }
  let trailing = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i += 1) {
    trailing += estimateTokens(messages[i] as never);
  }
  if (lastUsageIndex >= 0) return { tokens: usageTokens + trailing };
  let total = 0;
  for (const message of messages) total += estimateTokens(message as never);
  return { tokens: total };
}
