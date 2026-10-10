/** End-to-end adapter contract for awaited, priority plan notices. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingChannelMessage, ProgressFn, ReplyHandler } from '@fshine/contracts';
import { WecomBotChannel, type SdkClientLike } from './src/index';
import { MAX_REPLY_BYTES, REPLY_TRUNCATED_MARK } from './src/text';

const ENV = { WECOM_BOT_ID: 'bot-test', WECOM_BOT_SECRET: 'secret-test' };
afterEach(() => vi.restoreAllMocks());

class NoticeSdkClient implements SdkClientLike {
  readonly frames: Array<{ content: string; finish: boolean }> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private failText: string | null = null;
  private releaseNotice: (() => void) | null = null;

  on(event: string, listener: (...args: any[]) => void): unknown {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
    return this;
  }
  connect(): unknown { return this; }
  disconnect(): void {}
  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  failReplyFor(text: string): void { this.failText = text; }
  unblockNotice(): void { this.releaseNotice?.(); }
  async replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.frames.push({ content, finish });
    if (content.startsWith('计划通知：')) {
      if (this.failText === content) throw new Error('notice delivery failed');
      await new Promise<void>((resolve) => { this.releaseNotice = resolve; });
    }
    return {};
  }
  async uploadMedia(): Promise<{ media_id: string }> { return { media_id: 'unused' }; }
  async replyMedia(): Promise<unknown> { return {}; }
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> { return { buffer: Buffer.from('x') }; }
}

async function start(handler: ReplyHandler) {
  const sdk = new NoticeSdkClient();
  const channel = new WecomBotChannel({ env: ENV, clientFactory: () => sdk });
  const starting = channel.start(handler);
  sdk.emit('authenticated');
  await starting;
  return { channel, sdk };
}

function messageFrame() {
  return {
    headers: { req_id: 'notice-req' },
    body: {
      msgid: 'notice-msg', msgtype: 'text', chattype: 'single',
      from: { userid: 'user-1' }, text: { content: '查本期应收' },
    },
  };
}

describe('企微计划通知交付屏障', () => {
  it('计划通知不受普通进度 3 秒/4 帧节流，且 handler 等到投递完成才继续', async () => {
    let continued = false;
    const handler = (async (
      _message: IncomingChannelMessage,
      progress?: ProgressFn,
      notice?: (text: string) => Promise<void>,
    ) => {
      for (let i = 1; i <= 5; i += 1) {
        progress?.(`普通进度${i}`);
        now += 3_000;
      }
      const delivery = notice?.('计划通知：查询范围扩大到 202601–202609，预计约 3 分钟。');
      expect(delivery).toBeInstanceOf(Promise);
      await Promise.resolve();
      expect(continued).toBe(false);
      await delivery;
      continued = true;
      return '跨月查询完成';
    }) as unknown as ReplyHandler;
    const { sdk } = await start(handler);

    let now = 1_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    sdk.emit('message.text', messageFrame());
    await vi.waitFor(() => {
      const noticeFrame = sdk.frames.find((frame) => frame.content.startsWith('计划通知：'));
      if (noticeFrame) return;
      // Current adapter falls back after the handler discovers there is no notice callback.
      expect(sdk.frames.some((frame) => frame.finish)).toBe(false);
    });
    expect(sdk.frames.filter((frame) => !frame.finish && frame.content.startsWith('普通进度'))).toHaveLength(4);
    expect(sdk.frames.some((frame) => frame.content.startsWith('计划通知：') && !frame.finish)).toBe(true);
    expect(continued).toBe(false);
    dateNow.mockRestore();

    sdk.unblockNotice();
    await vi.waitFor(() => expect(continued).toBe(true));
    expect(sdk.frames.some((frame) => frame.finish && frame.content === '跨月查询完成')).toBe(true);
  });

  it('计划通知 replyStream 失败时 reject 给 handler，后续跨月执行不得发生', async () => {
    const noticeText = '计划通知：查询范围扩大到 202601–202609。';
    let crossMonthExecuted = false;
    const handler = (async (
      _message: IncomingChannelMessage,
      _progress?: ProgressFn,
      notice?: (text: string) => Promise<void>,
    ) => {
      await notice?.(noticeText);
      crossMonthExecuted = true;
      return '已执行跨月查询';
    }) as unknown as ReplyHandler;
    const { sdk } = await start(handler);
    sdk.failReplyFor(noticeText);
    sdk.emit('message.text', messageFrame());

    await vi.waitFor(() => expect(sdk.frames.some((frame) => frame.finish)).toBe(true));
    expect(crossMonthExecuted).toBe(false);
    expect(sdk.frames.some((frame) => frame.finish && frame.content === '处理失败,请稍后再试')).toBe(true);
  });

  it('D-021 通知超长时看得见地截断（带标记）并记守夜事件，不是无声硬切', async () => {
    // 平台 noticeText 由账套/期间/客户多个集合 join 而成、无条数上限——最可能超长的出口
    const hugeNotice = `计划通知：查询范围扩大到 ${'幻辰财税、'.repeat(4000)}预计约 3 分钟。`;
    const handler = (async (
      _message: IncomingChannelMessage,
      _progress?: ProgressFn,
      notice?: (text: string) => Promise<void>,
    ) => {
      await notice?.(hugeNotice);
      return '跨月查询完成';
    }) as unknown as ReplyHandler;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sdk } = await start(handler);
    sdk.emit('message.text', messageFrame());
    // 替身的 replyStream 对通知帧故意挂住（复现"送达才算数"的屏障），放行后才继续
    await vi.waitFor(() => expect(sdk.frames.some((frame) => frame.content.startsWith('计划通知：'))).toBe(true));
    sdk.unblockNotice();

    await vi.waitFor(() => expect(sdk.frames.some((frame) => frame.finish)).toBe(true));
    const noticeFrame = sdk.frames.find((frame) => frame.content.startsWith('计划通知：'));
    expect(noticeFrame).toBeDefined();
    // 截断是看得见的：带标记，且不超字节上限（无声硬切会两者都不满足）
    expect(noticeFrame!.content).toContain(REPLY_TRUNCATED_MARK);
    expect(Buffer.byteLength(noticeFrame!.content, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(noticeFrame!.content.length).toBeLessThan(hugeNotice.length);
    // 守夜事件：被截过这件事必须留痕（与最终回复同一条事件线，frame 字段区分出口）
    const logged = warn.mock.calls.map((call) => String(call[0])).find((line) => line.includes('wecom_reply_truncated'));
    expect(logged, 'notice 超长必须记 wecom_reply_truncated 守夜事件').toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ event: 'wecom_reply_truncated', frame: 'notice', req_id: 'notice-req' });
  });
});
