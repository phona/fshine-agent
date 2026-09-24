/** Verifies the production server wrapper does not drop channel callbacks. */
import { describe, expect, it, vi } from 'vitest';
import type { IncomingChannelMessage, ProgressFn, ReplyHandler } from '@fshine/contracts';
import { createServerReplyHandler } from './reply';

const message = (text: string): IncomingChannelMessage => ({
  wecomUserId: 'user-1',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  text,
  receivedAt: '2026-09-24T00:00:00.000Z',
});

describe('production channel handler wiring', () => {
  it('普通消息把 message、progress 和 notice 原样交给 sharedHandler', async () => {
    const progress = vi.fn() as ProgressFn;
    const notice = vi.fn(async () => {}) as (text: string) => Promise<void>;
    const shared = vi.fn(async () => '查询结果');
    const handler = createServerReplyHandler(shared as unknown as ReplyHandler);
    const input = message('查应收');

    await expect(handler(input, progress, notice)).resolves.toBe('查询结果');
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared.mock.calls[0]).toEqual([input, progress, notice]);
  });

  it('演示图片消息仍返回图片回复且不委派给 sharedHandler', async () => {
    const shared = vi.fn(async () => '不应调用');
    const handler = createServerReplyHandler(shared as unknown as ReplyHandler);

    const reply = await handler(message('测试图片'));
    expect(shared).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ text: expect.stringContaining('图片通道演示') });
    expect(typeof reply).toBe('object');
    if (typeof reply !== 'string') {
      expect(reply.image?.data).toBeInstanceOf(Buffer);
      expect(reply.image?.filename).toBe('voucher-202607.png');
    }
  });
});
