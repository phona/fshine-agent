/**
 * 消息处理主链路:授权 → 审计 → Agent(runtime + LLM)→ MCP host(scope 预检)→ 回复。
 * 被 apps/server/main.ts 与 scripts/e2e-turn.ts 共用,保证测的就是跑的。
 */
import type {
  AgentRuntime,
  AuditStore,
  ChannelReply,
  IncomingChannelMessage,
  PrincipalCapability,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { newId } from '@fshine/core';
import type { McpCallHooks, McpHost, McpToolCategory } from '@fshine/mcp-host';

export interface HandlerDeps {
  store: AuditStore;
  runtime: AgentRuntime;
  hostFor(mcpProfile: string, capabilities: readonly PrincipalCapability[]): McpHost;
}

export function createMessageHandler(deps: HandlerDeps): ReplyHandler {
  const { store, runtime, hostFor } = deps;
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
      const capabilities = scope.capabilities ?? ['read'];
      const host = hostFor(scope.mcpProfile, capabilities);
      // tools() 同步读取连接的 tools/list 结果;连接预热是异步的,必须先确保就绪,
      // 否则首个工具回合的 knownTools 为空,模型所有合法调用都会被判协议违规
      await host.ensureReady().catch(() => {});
      const hooks: McpCallHooks = {
        onRetry: (info) =>
          progress?.(`系统繁忙,自动重试中(${info.attempt}/${info.maxAttempts})…`),
      };
      const client = host.clientFor(requestId, scope.accountSetIds, hooks, categoriesFor(capabilities));
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
  }
}

function categoriesFor(capabilities: readonly PrincipalCapability[]): McpToolCategory[] {
  const categories: McpToolCategory[] = ['read'];
  if (capabilities.includes('validate')) categories.push('validate');
  if (capabilities.includes('write')) categories.push('write', 'status');
  return categories;
}
