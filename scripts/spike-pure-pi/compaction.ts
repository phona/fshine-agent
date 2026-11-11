/**
 * 长上下文压缩：直接调 pi-agent-core 的原生压缩函数
 * （shouldCompact / generateSummary / estimateContextTokens / estimateTokens）。
 *
 * 与 fshine 的差别只在"谁持有会话状态"：这里没有宿主转录持久化、没有
 * compaction-context sidecar；压缩发生在每个用户回合开始前，结果直接写回
 * Agent.state.messages（摘要消息 + 保留的最近尾巴）。失败只记日志，不阻塞回合。
 */
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import {
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  shouldCompact,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { Api, Model, Models } from '@earendil-works/pi-ai';

const SUMMARY_PREFIX = '【此前会话摘要】';

const SUMMARY_INSTRUCTIONS =
  '这是助手会话的压缩摘要。保留：1) 用户点名过的账套与期间；2) 已经查到的真实数字及其账套/期间归属；' +
  '3) 用户当前的意图、未完成的查询和待确认事项；4) 用户对结果的纠正或否认。' +
  '平台返回的错误码、JSON 和命令原文不是结论，不要写进摘要。';

export interface CompactionEvent {
  at: string;
  ok: boolean;
  skipped?: boolean;
  tokensBefore: number;
  tokensAfter?: number;
  summarizedMessages?: number;
  keptMessages?: number;
  summaryChars?: number;
  error?: string;
}

export class NativeCompactor {
  readonly events: CompactionEvent[] = [];

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    private readonly settings: CompactionSettings,
  ) {}

  async maybeCompact(agent: Agent): Promise<CompactionEvent | null> {
    const messages = agent.state.messages;
    if (messages.length === 0) return null;
    const estimate = estimateContextTokens(messages);
    if (!shouldCompact(estimate.tokens, this.model.contextWindow, this.settings)) return null;

    const previousSummary = firstSummaryText(messages);
    const summary = await generateSummary(
      messages,
      this.models,
      this.model,
      this.settings.reserveTokens,
      SUMMARY_INSTRUCTIONS,
      previousSummary,
      undefined,
      undefined,
      undefined,
      BACKGROUND_CONTEXT,
    );
    if (!summary.ok) {
      const event: CompactionEvent = {
        at: new Date().toISOString(),
        ok: false,
        tokensBefore: estimate.tokens,
        error: String(summary.error).slice(0, 300),
      };
      this.events.push(event);
      return event;
    }

    // 最近尾巴：从后往前累计到 keepRecentTokens，再退到该段之前的用户消息边界，
    // 避免把 assistant(toolCall) 与 toolResult 拆散。
    let keptFrom = messages.length;
    let keptTokens = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      keptFrom = i;
      keptTokens += estimateTokens(messages[i]!);
      if (keptTokens >= this.settings.keepRecentTokens) break;
    }
    while (keptFrom > 0 && messages[keptFrom]!.role !== 'user') keptFrom -= 1;

    if (keptFrom <= 0) {
      const event: CompactionEvent = {
        at: new Date().toISOString(),
        ok: true,
        skipped: true,
        tokensBefore: estimate.tokens,
        error: 'keepRecentTokens 覆盖了全部消息，压缩不会减少上下文',
      };
      this.events.push(event);
      return event;
    }

    const tail = messages.slice(keptFrom).map(dropStaleUsage);
    const summaryMessage = {
      role: 'user',
      content: `${SUMMARY_PREFIX}\n${summary.value}\n（以上是较早对话的压缩摘要；具体数字以重新查询平台的结果为准）`,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    agent.state.messages = [summaryMessage, ...tail];

    const event: CompactionEvent = {
      at: new Date().toISOString(),
      ok: true,
      tokensBefore: estimate.tokens,
      tokensAfter: estimateContextTokens(agent.state.messages).tokens,
      summarizedMessages: keptFrom,
      keptMessages: tail.length,
      summaryChars: summary.value.length,
    };
    this.events.push(event);
    return event;
  }
}

/**
 * pi 的 estimateContextTokens 优先信助手消息上的 provider usage。
 * 压缩后留下的尾巴仍带着压缩前那次调用的 usage，于是 shouldCompact 会每一轮都判真、
 * 把同一段历史反复摘要。usage 不进模型正文，丢掉它之后下一轮按字符估算缩短后的转录。
 */
function dropStaleUsage(message: AgentMessage): AgentMessage {
  if (message.role !== 'assistant' || !('usage' in message)) return message;
  const copy = { ...message } as AgentMessage & { usage?: unknown };
  delete copy.usage;
  return copy;
}

function firstSummaryText(messages: AgentMessage[]): string | undefined {
  const first = messages[0];
  if (!first || first.role !== 'user') return undefined;
  const content = first.content;
  if (typeof content === 'string' && content.startsWith(SUMMARY_PREFIX)) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');
    if (text.startsWith(SUMMARY_PREFIX)) return text;
  }
  return undefined;
}

export function compactionSettingsFromEnv(env: NodeJS.ProcessEnv): CompactionSettings {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    enabled: true,
    reserveTokens: num('PURE_PI_COMPACT_RESERVE_TOKENS', 8000),
    keepRecentTokens: num('PURE_PI_COMPACT_KEEP_RECENT_TOKENS', 8000),
  };
}
