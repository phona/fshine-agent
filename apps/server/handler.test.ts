import { describe, expect, it, vi } from 'vitest';
import type { AgentReply, AgentRuntime, AuditStore, TrustedContext } from '@fshine/contracts';
import { createMessageHandler } from './handler';

const USER = 'user_a';

/** 最小化 AuditStore 替身:只记录调用 */
function fakeStore(): AuditStore {
  return {
    principalScopes: {
      get: async (userId: string) =>
        userId === USER ? { wecomUserId: USER, accountSetIds: ['as_001'], enabled: true } : null,
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

describe('createMessageHandler', () => {
  it('计划确认后携带原 taskId 续跑并返回执行结果', async () => {
    const seen: TrustedContext[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => { seen.push(ctx); return { text: '计划执行完成。' }; },
    };
    const handler = createMessageHandler({
      store: fakeStore(),
      runtime,
      planConfirmation: {
        handle: async () => ({ status: 'activated', planId: 'plan_1', version: 2, taskId: 'task_1' }),
      },
    });
    const reply = await handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm1', text: '确认继续', receivedAt: '2026-09-24T00:00:00.000Z' });

    expect(reply).toBe('计划执行完成。');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resumeTaskId).toBe('task_1');
  });

  it('记录已送达的执行计划通知到可检索历史', async () => {
    const events: Array<{ eventId: string; kind: string; content?: string }> = [];
    const store = {
      ...fakeStore(),
      conversationLog: { append: async (event: typeof events[number]) => { events.push(event); }, list: async () => [], search: async () => [] },
    } as unknown as AuditStore;
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => {
        await ctx.onNotice?.('账套「幻辰」；期间2026年01月至2026年09月；预计约2分钟。');
        return { text: '查询完成。' };
      },
    };
    const handler = createMessageHandler({ store, runtime });
    await handler({ wecomUserId: USER, conversationId: 'c', messageId: 'm_plan_notice', text: '查本期应收', receivedAt: '2026-09-24T00:00:00.000Z' }, undefined, async () => {});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'plan_event', content: expect.stringContaining('2026年01月至2026年09月') });
    expect(events[0]?.eventId).toContain('plan_notice');
  });

  it('未授权用户:拒绝并提示(带其 principalId)', async () => {
    const store = fakeStore();
    const handler = createMessageHandler({
      store,
      runtime: fakeRuntime([], 0),
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
