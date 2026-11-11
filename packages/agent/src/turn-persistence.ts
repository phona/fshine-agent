/**
 * 回合持久化与历史回填：Conversation Log 事件落账、历史转录回填。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（runtime 要用这里的落账函数，引回来就成环，
 * 由 packages/agent/architecture-shape.test.ts 的环断言守着）。因此这里不出现
 * `TaxAgentRuntimeDeps`——依赖收窄成下面这个模块内自定义的窄接口 `TurnPersistenceDeps`
 * （与 plan-binding.ts 的 `PlanDisambiguationRepos` 同族），只声明真正用到的仓库方法与
 * 驱动能力；runtime 把自己的整个 deps 直接传进来即可（形状是真子集）。
 *
 * 每 runtime 实例的状态（`initializedContextSessions`）**不在这里**——它们是实例状态
 * 不是持久化逻辑，住在 createTaxAgentRuntime 里。
 *
 * 分层纪律同前批：**落账/降级副作用进模块，控制流留 runtime.ts**。存储抛错一律只记日志
 * 不阻塞回合（降级形状一字不动）；日志留在函数内（它们本来就是这些函数的职责，返回事件
 * 让调用方打日志只会把降级判断拆成两处）。
 *
 * 2026-11 相位 1：短期会话状态（Context State 的归约 / 语义抽取 / 落账）与长期记忆
 * （投影 / 归并 / 候选抽取）整体删除——两条都是"从会话历史学习并影响后续执行"的路径，
 * T2 判据见 apps/server/no-learning-path-wiring.test.ts。这里只留会话历史本身的落账
 * 与一次性回填。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import type { ConversationEventRecord, ConversationLogRepo, TrustedContext, TurnInputContext } from '@fshine/contracts';
import { clarificationIssuedRecord, clarificationResolvedRecord, type ClarificationBinding } from './clarification-events';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './turn-contract';
import { extractCurrentMessageBody, hostContextMetadataOf, normalizeMessageReference } from './message-reference';

/**
 * 本模块需要的依赖（TaxAgentRuntimeDeps 的真子集）。不引 runtime 的类型——引回来就成环。
 * runtime 直接把整个 deps 传进来即可，无需适配。
 */
export interface TurnPersistenceDeps {
  /** Durable, append-only raw conversation log; separate from compactable Pi transcript. */
  conversationLog?: Pick<ConversationLogRepo, 'append' | 'list'>;
}

/**
 * 澄清事件落账（任务 1 来源 B）：宿主发出/绑定澄清时写 Conversation Log。
 * 失败只记日志——绑定机制因此降级（下一回合绑不上），不该让回合失败。
 */
export async function appendClarificationIssued(
  deps: TurnPersistenceDeps,
  ctx: TrustedContext,
  clarification: { code: string; query: string; candidates: readonly string[] },
): Promise<void> {
  if (!deps.conversationLog) return;
  try {
    await deps.conversationLog.append(clarificationIssuedRecord(ctx, clarification));
  } catch (error) {
    console.error(JSON.stringify({ event: 'clarification_event_append_failed', sessionId: ctx.sessionId, status: 'issued', error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
}

export async function appendClarificationResolved(
  deps: TurnPersistenceDeps,
  ctx: TrustedContext,
  binding: ClarificationBinding,
): Promise<void> {
  if (!deps.conversationLog) return;
  try {
    await deps.conversationLog.append(clarificationResolvedRecord(ctx, binding));
  } catch (error) {
    console.error(JSON.stringify({ event: 'clarification_event_append_failed', sessionId: ctx.sessionId, status: 'resolved', error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
}

export async function appendUserEvent(
  deps: TurnPersistenceDeps,
  ctx: TrustedContext,
  userMessage: string,
  inputContext?: TurnInputContext,
): Promise<void> {
  if (!deps.conversationLog) return;
  try {
    const reference = normalizeMessageReference(inputContext?.messageReference);
    const messageReference = reference ? {
      ...reference,
      ...(reference.text !== undefined ? { text: redactSensitiveText(reference.text) } : {}),
    } : undefined;
    await deps.conversationLog.append({
      eventId: `${ctx.requestId}:user`, principalId: ctx.principalId, sessionId: ctx.sessionId,
      kind: 'user_message', content: redactSensitiveText(userMessage), createdAt: new Date().toISOString(), requestId: ctx.requestId,
      ...(messageReference ? { messageReference } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'conversation_user_append_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
}

export async function persistAssistantAndContext(
  deps: TurnPersistenceDeps,
  ctx: TrustedContext,
  assistantMessage: string,
  toolResults: ConversationEventRecord[] = [],
): Promise<void> {
  if (!deps.conversationLog) return;
  try {
    const assistantEvent = {
      eventId: `${ctx.requestId}:assistant`, principalId: ctx.principalId, sessionId: ctx.sessionId,
      kind: 'assistant_message' as const, content: redactSensitiveText(assistantMessage), createdAt: new Date().toISOString(), requestId: ctx.requestId,
    };
    for (const event of toolResults) await deps.conversationLog.append(event);
    await deps.conversationLog.append(assistantEvent);
  } catch (error) {
    console.error(JSON.stringify({ event: 'conversation_log_update_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
}

/**
 * 委派工具结果的事件提取（C3 改名：原名带执行层实例名的函数已退役，实例名出通用层）。
 *
 * taskToolName 由调用方注入（= runner 的 tool.name，随 profile.toolName 声明走）：
 * 提取器不认死任何工具名——通用层认"runner 自己发布的名字"，实例名不进本文件。
 */
export function extractDelegationToolResultEvents(
  messages: readonly AgentMessage[],
  ctx: TrustedContext,
  taskToolName: string,
): { events: ConversationEventRecord[]; taskResults: Array<{ taskId: string; resultText: string }> } {
  const events: ConversationEventRecord[] = [];
  // D-065：同一次委派在 Conversation Log 里的 tool_result 文本，回写任务条目做宿主持久
  // 底账（recordTaskResult）。taskId 取自工具结果的原始 JSON（写进内容前），
  // 只用于存储侧串联，不进任何模型可见文本。
  const taskResults: Array<{ taskId: string; resultText: string }> = [];
  for (const [index, message] of messages.entries()) {
    const item = message as { role?: string; toolName?: string; toolCallId?: unknown; content?: unknown; timestamp?: unknown };
    if (item.role !== 'toolResult') continue;
    if (item.toolName !== taskToolName && item.toolName !== ROUTE_CURRENT_TURN_TOOL_NAME) continue;
    let content = messageText(item.content);
    // The tool result is usually a JSON envelope. Keep only its user-facing text field.
    let taskId: string | undefined;
    try {
      const parsed = JSON.parse(content) as { text?: unknown; recorded?: unknown; taskId?: unknown };
      if (typeof parsed?.text === 'string') content = parsed.text;
      // A plain conversation declaration carries no result worth recalling later.
      else if (parsed?.recorded === 'conversation') continue;
      if (typeof parsed?.taskId === 'string' && parsed.taskId) taskId = parsed.taskId;
    } catch { /* A plain natural-language result is already safe to reduce below. */ }
    content = redactInternalIds(redactSensitiveText(content)).slice(0, 20_000);
    if (!content.trim()) continue;
    const timestamp = typeof item.timestamp === 'number' ? item.timestamp : Date.now() + index;
    events.push({
      eventId: `${ctx.requestId}:tool:${typeof item.toolCallId === 'string' ? item.toolCallId : index}`,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      kind: 'tool_result',
      content,
      createdAt: new Date(timestamp).toISOString(),
      requestId: ctx.requestId,
    });
    if (taskId) taskResults.push({ taskId, resultText: content });
  }
  return { events, taskResults };
}

/** 内部 id（task_/plan_）不外泄：用户与日志都不需要它们，Conversation Log 里换成占位符。 */
export function redactInternalIds(text: string): string {
  return text
    .replace(/\btask_[\w-]+\b/g, '[TASK_ID]')
    .replace(/\bplan_[\w-]+\b/g, '[PLAN_ID]');
}

/**
 * Import pre-ConversationLog Pi transcript exactly once before the first new event.
 *
 * 回填的是**会话历史本身**（转录 → Conversation Log，Redact 后落账）：它是宿主持有的
 * 存档与指代检索来源，不再派生任何"短期会话状态"（那一路已删除）。
 */
export async function ensureHistoryBackfill(
  deps: TurnPersistenceDeps,
  ctx: TrustedContext,
  transcript: AgentMessage[],
): Promise<boolean> {
  if (!deps.conversationLog) return true;
  try {
    let events = await deps.conversationLog.list({ principalId: ctx.principalId, sessionId: ctx.sessionId, limit: 500 });
    if (!events.length) {
      const imported = transcriptEvents(transcript, ctx);
      for (const event of imported) await deps.conversationLog.append(event);
      events = imported.length
        ? await deps.conversationLog.list({ principalId: ctx.principalId, sessionId: ctx.sessionId, limit: 500 })
        : [];
    }
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'conversation_history_backfill_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
    return false;
  }
}

function transcriptEvents(messages: AgentMessage[], ctx: TrustedContext) {
  const events: ConversationEventRecord[] = [];
  for (const message of messages) {
    const item = message as { role?: string; content?: unknown; timestamp?: unknown; toolCallId?: unknown };
    const kind = item.role === 'user' ? 'user_message'
      : item.role === 'assistant' ? 'assistant_message'
        : item.role === 'toolResult' ? 'tool_result' : undefined;
    if (!kind) continue;
    const hostContext = hostContextMetadataOf(message);
    const renderedContent = messageText(item.content);
    const content = kind === 'user_message'
      ? extractCurrentMessageBody(renderedContent, hostContext?.messageReference !== undefined)
      : renderedContent;
    if (!content.trim()) continue;
    const timestamp = typeof item.timestamp === 'number' ? item.timestamp : Date.parse(String(item.timestamp ?? ''));
    const reference = kind === 'user_message' ? hostContext?.messageReference : undefined;
    const safeReference = reference ? {
      ...reference,
      ...(reference.text !== undefined ? { text: redactSensitiveText(reference.text) } : {}),
    } : undefined;
    const eventSource = JSON.stringify([item.role, String(item.timestamp ?? ''), content, safeReference ?? null]);
    const digest = createHash('sha256').update(eventSource).digest('hex').slice(0, 24);
    events.push({
      eventId: `migrate:${ctx.sessionId}:${digest}`,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      kind,
      content: redactSensitiveText(content),
      createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString(),
      ...(safeReference ? { messageReference: safeReference } : {}),
    });
  }
  return events;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const candidate = part as { type?: string; text?: unknown };
      if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)["']?\s*[:=]\s*)(["']?)([^\s,;"'}\]]+)(["']?)/gi,
      (_match, prefix: string, quote: string, _value: string, closingQuote: string) => `${prefix}${quote}[REDACTED]${quote && closingQuote === quote ? quote : ''}`);
}
