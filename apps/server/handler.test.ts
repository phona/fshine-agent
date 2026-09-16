import { describe, expect, it, vi } from 'vitest';
import type { AgentReply, AgentRuntime, AuditStore, TrustedContext } from '@fshine/contracts';
import { createMessageHandler } from './handler';

const USER = 'user_a';

/** 最小化 AuditStore 替身:只记录调用 */
function fakeStore(): AuditStore {
  return {
    principalScopes: {
      get: async (userId: string) =>
        userId === USER ? { wecomUserId: USER, accountSetIds: ['as_001'], mcpProfile: 'p', enabled: true } : null,
      list: async () => [],
      upsert: async () => {},
    },
    requests: {
      insert: async () => {},
      get: async () => null,
      findByWecomMessageId: async () => null,
      setOutcome: async () => {},
    },
    toolCalls: {
      insert: async () => {},
      finish: async () => {},
      listByRequest: async () => [],
    },
    sessions: {
      get: async () => null,
      upsert: async () => {},
    },
  } as unknown as AuditStore;
}

function fakeRuntime(order: string[], delayMs: number): AgentRuntime {
  return {
    handleTurn: async (ctx: TrustedContext): Promise<AgentReply> => {
      order.push(`start:${ctx.sessionId}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end:${ctx.sessionId}`);
      return { text: 'ok' };
    },
  };
}

const hostFor = () => {
  throw new Error('不应被调用(测试回复不经工具)');
};

describe('createMessageHandler', () => {
  it('未授权用户:拒绝并提示(带其 principalId)', async () => {
    const store = fakeStore();
    const handler = createMessageHandler({
      store,
      runtime: fakeRuntime([], 0),
      hostFor: () => {
        throw new Error('不应被调用');
      },
    });
    const reply = await handler(
      { wecomUserId: 'stranger', conversationId: 'c', messageId: 'm1', text: 'hi', receivedAt: '' },
    );
    expect(reply).toContain('未开通查询权限');
    expect(reply).toContain('wecom:stranger');
  });

  it('同一会话并发消息:串行处理(第二回合在第一回合结束后才开始)', async () => {
    const order: string[] = [];
    const store = fakeStore();
    const handler = createMessageHandler({
      store,
      runtime: fakeRuntime(order, 30),
      hostFor: () => {
        throw new Error('不应被调用');
      },
    });

    const first = handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm1', text: '第一条', receivedAt: '' });
    const second = handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm2', text: '第二条', receivedAt: '' });
    await Promise.all([first, second]);

    const starts = order.filter((entry) => entry.startsWith('start:')).length;
    expect(starts).toBe(2);
    expect(order.indexOf('start:wecom:user_a:c')).toBeLessThan(order.indexOf('end:wecom:user_a:c'));
    expect(order.indexOf('end:wecom:user_a:c')).toBeLessThan(order.lastIndexOf('start:wecom:user_a:c'));
  });
});
