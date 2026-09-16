/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ MCP host(scope 预检)→ 回复。
 * 被 apps/server/main.ts 与 scripts/e2e-turn.ts 共用,保证测的就是跑的。
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
import type { McpCallHooks, McpHost } from '@fshine/mcp-host';

export interface HandlerDeps {
  store: AuditStore;
  runtime: AgentRuntime;
  hostFor(mcpProfile: string): McpHost;
}

export function createMessageHandler(deps: HandlerDeps): ReplyHandler {
  const { store, runtime, hostFor } = deps;

  return async (message: IncomingChannelMessage, progress?: ProgressFn): Promise<ChannelReply> => {
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
      const hooks: McpCallHooks = {
        onRetry: (info) =>
          progress?.(`系统繁忙,自动重试中(${info.attempt}/${info.maxAttempts})…`),
      };
      const client = hostFor(scope.mcpProfile).clientFor(requestId, scope.accountSetIds, hooks);
      const reply = await runtime.handleTurn(
        {
          requestId,
          principalId,
          allowedAccountSetIds: scope.accountSetIds,
          sessionId: `${message.wecomUserId}:${message.conversationId}`,
          onStep: progress,
        },
        message.text,
        client,
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
  };
}
