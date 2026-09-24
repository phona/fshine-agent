/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ Context Worker → 回复。
 * 被 apps/server/main.ts 与 tests/e2e 共用,保证测的就是跑的。
 */
import type {
  AgentRuntime,
  AuditStore,
  ChannelReply,
  IncomingChannelMessage,
  NoticeFn,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { newId } from '@fshine/core';

export interface HandlerDeps {
  store: AuditStore;
  runtime: AgentRuntime;
  planConfirmation?: {
    handle(message: { origin: 'wecom_user'; messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }): Promise<{ status: string; planId?: string; version?: number; taskId?: string }>;
    savePending?: (pending: { planId: string; version: number; taskId: string; principalId: string; sessionId: string; requestId: string; userText: string }) => Promise<void>;
  };
}

export function createMessageHandler(deps: HandlerDeps): ReplyHandler {
  const { store, runtime } = deps;
  // 同一会话的消息串行处理(pi 的 steering/followUp 队列哲学):
  // 并发回合会竞态会话状态(候选/游标/历史互相覆盖),必须排队
  const sessionQueues = new Map<string, Promise<unknown>>();

  return async (message: IncomingChannelMessage, progress?: ProgressFn, notice?: NoticeFn): Promise<ChannelReply> => {
    const queueKey = `${message.wecomUserId}:${message.conversationId}`;
    const prev = sessionQueues.get(queueKey) ?? Promise.resolve();
    const task = prev.then(() => processMessage(message, progress, notice));
    // Keep a rejection-safe promise in the map so the next turn can always
    // start, while retaining the exact identity for cleanup below.
    const queued = task.catch(() => undefined);
    sessionQueues.set(queueKey, queued);
    void task.catch(() => undefined).finally(() => {
      if (sessionQueues.get(queueKey) === queued) sessionQueues.delete(queueKey);
    });
    return task;
  };

  async function processMessage(
    message: IncomingChannelMessage,
    progress?: ProgressFn,
    notice?: NoticeFn,
  ): Promise<ChannelReply> {
    const principalId = `wecom:${message.wecomUserId}`;
    const requestId = newId('req');
    const createdAt = new Date().toISOString();
    const base = { requestId, wecomMessageId: message.messageId, principalId, input: message.text, createdAt };

    const scope = await store.principalScopes.get(message.wecomUserId);
    if (!scope || !scope.enabled) {
      await store.requests.insert({ ...base, outcome: 'denied' });
      return `该账号(${principalId})未开通查询权限,请联系管理员开通。`;
    }
    await store.requests.insert({ ...base, outcome: 'replied' });

    try {
      let noticeSequence = 0;
      const onNotice: NoticeFn | undefined = notice ? async (text) => {
        await notice(text);
        try {
          await store.conversationLog?.append({
            eventId: `${requestId}:plan_notice:${++noticeSequence}`,
            principalId,
            sessionId: `wecom:${message.wecomUserId}:${message.conversationId}`,
            kind: 'plan_event',
            content: redactNotice(text),
            createdAt: new Date().toISOString(),
            requestId,
          });
        } catch (error) {
          console.warn(JSON.stringify({ event: 'plan_notice_log_failed', requestId, error: error instanceof Error ? error.message : String(error) }));
        }
      } : undefined;
      const trusted = {
        requestId,
        principalId,
        allowedAccountSetIds: scope.accountSetIds,
        capabilities: scope.capabilities,
        sessionId: `wecom:${message.wecomUserId}:${message.conversationId}`,
        onStep: progress,
        ...(onNotice ? { onNotice } : {}),
        ...(deps.planConfirmation?.savePending ? { onPlanPending: deps.planConfirmation.savePending } : {}),
      };
      if (deps.planConfirmation) {
        const confirmation = await deps.planConfirmation.handle({
          origin: 'wecom_user', messageId: message.messageId, principalId, sessionId: `wecom:${message.wecomUserId}:${message.conversationId}`,
          text: message.text, receivedAt: message.receivedAt,
        });
        if (confirmation.status === 'activated') {
          if (!confirmation.taskId) throw new Error('已确认的计划缺少原任务标识。');
          const resumed = await runtime.handleTurn({ ...trusted, resumeTaskId: confirmation.taskId }, message.text);
          return resumed.text;
        }
        if (confirmation.status === 'superseded') return '这项扩大查询已经被更新的计划取代，之前的确认不再有效。请重新发起查询，我会按新的范围再问你一次。';
        if (confirmation.status === 'cancelled') return '已取消本次扩大查询。';
        if (confirmation.status === 'ambiguous') return '当前有多个待确认查询，请先说明要继续哪一个。';
        if (confirmation.status === 'expired') return '这项查询确认已过期，请重新发起查询。';
      }
      const reply = await runtime.handleTurn(
        trusted,
        message.text,
      );
      return reply.text;
    } catch (error) {
      await store.requests.setOutcome(requestId, 'failed');
      console.error(JSON.stringify({
        event: 'turn_failed',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return '处理失败,请稍后再试。';
    }
  }
}

function redactNotice(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
