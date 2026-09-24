/** Ensures a plan notice delivery barrier reaches and blocks Main runtime work. */
import { describe, expect, it } from 'vitest';
import type { AgentReply, AgentRuntime, AuditStore, IncomingChannelMessage, ProgressFn, ReplyHandler, TrustedContext } from '@fshine/contracts';
import { createMessageHandler } from './handler';

const USER = 'notice_user';
const MESSAGE: IncomingChannelMessage = {
  wecomUserId: USER,
  conversationId: 'notice-conversation',
  messageId: 'notice-message',
  text: '查本期应收',
  receivedAt: '2026-09-24T00:00:00.000Z',
};

interface NoticeContext extends TrustedContext {
  onNotice?: (text: string) => Promise<void>;
}
type NoticeReplyHandler = (
  message: IncomingChannelMessage,
  progress?: ProgressFn,
  notice?: (text: string) => Promise<void>,
) => Promise<string>;

function fakeStore(outcomes: string[]): AuditStore {
  return {
    principalScopes: {
      get: async (userId: string) => userId === USER
        ? { wecomUserId: USER, accountSetIds: ['as_notice'], enabled: true }
        : null,
      list: async () => [],
      upsert: async () => {},
    },
    requests: {
      insert: async (record: { outcome: string }) => { outcomes.push(record.outcome); },
      get: async () => null,
      findByWecomMessageId: async () => null,
      setOutcome: async (_requestId: string, outcome: string) => { outcomes.push(outcome); },
    },
    toolCalls: { insert: async () => {}, finish: async () => {}, listByRequest: async () => [] },
    sessions: { get: async () => null, upsert: async () => {} },
  } as unknown as AuditStore;
}

function withNotice(handler: ReplyHandler): NoticeReplyHandler {
  return handler as unknown as NoticeReplyHandler;
}

describe('Main 通知送达屏障', () => {
  it('createMessageHandler 把可等待 notice 放进 TrustedContext，送达前不启动后续平台执行', async () => {
    const outcomes: string[] = [];
    let downstreamExecuted = false;
    let noticeStarted = false;
    let runtimeReachedNotice!: () => void;
    const reachedNotice = new Promise<void>((resolve) => { runtimeReachedNotice = resolve; });
    const runtime: AgentRuntime = {
      handleTurn: async (rawCtx: TrustedContext): Promise<AgentReply> => {
        const ctx = rawCtx as NoticeContext;
        runtimeReachedNotice();
        expect(ctx.onNotice).toBeTypeOf('function');
        await ctx.onNotice!('查询范围扩大到 202601–202609，预计约 2 分钟。');
        downstreamExecuted = true;
        return { text: '跨月查询完成' };
      },
    };
    const handler = withNotice(createMessageHandler({ store: fakeStore(outcomes), runtime }));

    let deliver!: () => void;
    const delivery = new Promise<void>((resolve) => { deliver = resolve; });
    const order: string[] = [];
    const reply = handler(MESSAGE, undefined, async (text) => {
      noticeStarted = true;
      order.push(`notice:${text}`);
      runtimeReachedNotice();
      await delivery;
      order.push('notice:delivered');
    });

    await reachedNotice;
    expect(downstreamExecuted).toBe(false);
    expect(noticeStarted).toBe(true);
    expect(order.join('\n')).toContain('查询范围扩大到 202601–202609');
    deliver();
    await expect(reply).resolves.toBe('跨月查询完成');
    expect(downstreamExecuted).toBe(true);
    expect(order[1]).toBe('notice:delivered');
    expect(outcomes).toEqual(['replied']);
  });

  it('notice 投递失败时拒绝后续执行，并把请求 outcome 记为 failed', async () => {
    const outcomes: string[] = [];
    let downstreamExecuted = false;
    let noticeInvoked = false;
    const runtime: AgentRuntime = {
      handleTurn: async (rawCtx: TrustedContext): Promise<AgentReply> => {
        const ctx = rawCtx as NoticeContext;
        expect(ctx.onNotice).toBeTypeOf('function');
        await ctx.onNotice!('查询范围扩大到 202601–202609。');
        downstreamExecuted = true;
        return { text: '跨月查询完成' };
      },
    };
    const handler = withNotice(createMessageHandler({ store: fakeStore(outcomes), runtime }));
    const reply = await handler(MESSAGE, undefined, async () => {
      noticeInvoked = true;
      throw new Error('WeCom notice delivery failed');
    });

    expect(reply).toBe('处理失败,请稍后再试。');
    expect(noticeInvoked).toBe(true);
    expect(downstreamExecuted).toBe(false);
    expect(outcomes).toEqual(['replied', 'failed']);
  });
});
