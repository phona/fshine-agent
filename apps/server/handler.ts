/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ Context Worker → 回复。
 * 被 apps/server/main.ts 与 tests/e2e 共用,保证测的就是跑的。
 */
import type {
  AgentRuntime,
  AuditStore,
  ChannelReply,
  IncomingChannelMessage,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { newId } from '@fshine/core';

export interface HandlerDeps {
  store: AuditStore;
  runtime: AgentRuntime;
}

export function createMessageHandler(deps: HandlerDeps): ReplyHandler {
  const { store, runtime } = deps;
  // 同一会话的消息串行处理(pi 的 steering/followUp 队列哲学):
  // 并发回合会竞态会话状态(候选/游标/历史互相覆盖),必须排队
  const sessionQueues = new Map<string, Promise<unknown>>();

  return async (message: IncomingChannelMessage, progress?: ProgressFn): Promise<ChannelReply> => {
    const queueKey = `${message.wecomUserId}:${message.conversationId}`;
    const prev = sessionQueues.get(queueKey) ?? Promise.resolve();
    const task = prev.then(() => processMessage(message, progress));
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
      const reply = await runtime.handleTurn(
        {
          requestId,
          principalId,
          allowedAccountSetIds: scope.accountSetIds,
          sessionId: `wecom:${message.wecomUserId}:${message.conversationId}`,
          onStep: progress,
        },
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
