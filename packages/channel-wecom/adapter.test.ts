import { describe, expect, it, vi } from 'vitest';
import type { IncomingChannelMessage, ReplyHandler } from '@fshine/contracts';
import { WecomBotChannel, type WecomBotChannelOptions } from './src/index';

const ENV = { WECOM_BOT_ID: 'bot-001', WECOM_BOT_SECRET: 'secret-abc' };

interface ReplyCall {
  reqId?: string;
  streamId: string;
  content: string;
  finish: boolean;
}

interface UploadCall {
  data: Buffer;
  filename: string;
}

interface MediaCall {
  mediaId: string;
}

/** 官方 SDK WSClient 的测试替身:记录调用、允许测试手动派发事件 */
class FakeSdkClient {
  readonly replies: ReplyCall[] = [];
  readonly uploads: UploadCall[] = [];
  readonly mediaCalls: MediaCall[] = [];
  connected = 0;
  disconnected = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private uploadFailNext = false;

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  connect(): unknown {
    this.connected += 1;
    return this;
  }

  disconnect(): void {
    this.disconnected += 1;
  }

  replyStream(
    frame: { headers?: { req_id?: string } },
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<unknown> {
    this.replies.push({ reqId: frame.headers?.req_id, streamId, content, finish });
    return Promise.resolve({});
  }

  uploadMedia(data: Buffer, options: { type: 'image'; filename: string }): Promise<{ media_id: string }> {
    this.uploads.push({ data, filename: options.filename });
    if (this.uploadFailNext) return Promise.reject(new Error('upload boom'));
    return Promise.resolve({ media_id: `media-${this.uploads.length}` });
  }

  failNextUpload(): void {
    this.uploadFailNext = true;
  }

  replyMedia(_frame: unknown, _mediaType: 'image', mediaId: string): Promise<unknown> {
    this.mediaCalls.push({ mediaId });
    return Promise.resolve({});
  }
}

async function startChannel(handler: ReplyHandler) {
  const fake = new FakeSdkClient();
  const options: WecomBotChannelOptions = {
    env: ENV,
    clientFactory: () => fake,
  };
  const channel = new WecomBotChannel(options);
  const started = channel.start(handler);
  fake.emit('authenticated');
  await started;
  return { channel, fake };
}

function textFrame(reqId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${Math.random().toString(36).slice(2, 8)}`,
      aibotid: 'bot-001',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'text',
      text: { content: '你好' },
      ...overrides,
    },
  };
}

function firstCall(handler: ReturnType<typeof vi.fn>): IncomingChannelMessage {
  return handler.mock.calls[0]![0] as IncomingChannelMessage;
}

describe('WecomBotChannel(官方 SDK 封装)', () => {
  it('env 缺失:start 拒绝并点名缺失变量', async () => {
    const channel = new WecomBotChannel({ env: { WECOM_BOT_ID: 'bot-001' } });
    await expect(channel.start(async () => 'x')).rejects.toThrow('WECOM_BOT_SECRET');
  });

  it('启动:认证后 start 完成,connect 恰好一次', async () => {
    const { fake } = await startChannel(async () => 'ok');
    expect(fake.connected).toBe(1);
    await fake.disconnect ?? undefined;
  });

  it('单聊消息:ack 先行,handler 字段正确,最终帧 finish=true 且 req_id 透传', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage, _progress?: unknown) => '好的,已收到');
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-1', { msgid: 'msg-1', text: { content: '查一下6月账套' } }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const message = firstCall(handler);
    expect(message.wecomUserId).toBe('zhangsan');
    expect(message.messageId).toMatch(/^msg-1$/);
    expect(message.chatType).toBe('single');
    expect(message.text).toBe('查一下6月账套');

    expect(fake.replies).toHaveLength(2);
    expect(fake.replies[0]).toMatchObject({ reqId: 'cb-1', content: '收到,正在处理…', finish: false });
    expect(fake.replies[1]).toMatchObject({ reqId: 'cb-1', content: '好的,已收到', finish: true });
    // ack 与最终帧共用同一 streamId(最终整体替换过程)
    expect(fake.replies[0]!.streamId).toBe(fake.replies[1]!.streamId);
  });

  it('群聊:剥离 @机器人 前缀,conversationId 取 chatid', async () => {
    const handler = vi.fn(async () => 'ok');
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-grp-1', {
      msgid: 'msg-grp-1',
      chattype: 'group',
      chatid: 'wr_group_9',
      from: { userid: 'lisi' },
      text: { content: '@财报助手 帮我查7月流水' },
    }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const message = firstCall(handler);
    expect(message.chatType).toBe('group');
    expect(message.conversationId).toBe('wr_group_9');
    expect(message.text).toBe('帮我查7月流水');
  });

  it('进度回调:finish=false 帧,节流(3 秒内第二帧被跳过)', async () => {
    const handler: ReplyHandler = async (_message, progress) => {
      progress?.('步骤一:正在定位账套');
      progress?.('步骤二:距上一帧不足 3 秒,应被节流');
      return '完成';
    };
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-prog-1', { msgid: 'msg-prog' }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    const progressTexts = fake.replies
      .filter((reply) => !reply.finish)
      .map((reply) => reply.content);
    expect(progressTexts).toEqual(['收到,正在处理…', '步骤一:正在定位账套']);
  });

  it('handler 抛错:记单行日志并回复兜底文案', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom-secret');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-err-1', { msgid: 'msg-err' }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    expect(fake.replies.some((reply) => reply.content === '处理失败,请稍后再试')).toBe(true);
    const logged = errorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('wecom_handler_error');
    expect(logged).toContain('msg-err');
    expect(logged).not.toContain('secret-abc');
    errorSpy.mockRestore();
  });

  it('图片回复:uploadMedia 换 media_id 后 replyMedia 回传,文字帧先行', async () => {
    const handler = vi.fn(async () => ({
      text: '图表来了',
      image: { data: Buffer.from('fake-png-bytes'), filename: 'chart.png' },
    }));
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-img-1', { msgid: 'msg-img-1', text: { content: '发图' } }));
    await vi.waitFor(() => expect(fake.mediaCalls).toHaveLength(1));

    expect(fake.uploads[0]).toMatchObject({ filename: 'chart.png' });
    const textFrameSent = fake.replies.find((reply) => reply.finish && reply.content === '图表来了');
    expect(textFrameSent).toBeTruthy();
    expect(fake.mediaCalls[0]!.mediaId).toBe('media-1');
  });

  it('图片上传失败且无文字:回退兜底文案', async () => {
    const handler = vi.fn(async () => ({ image: { data: Buffer.from('x'), filename: 'x.png' } }));
    const { fake } = await startChannel(handler);
    fake.failNextUpload();

    fake.emit('message.text', textFrame('cb-img-2', { msgid: 'msg-img-2', text: { content: '发图' } }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    expect(fake.replies.find((reply) => reply.finish)!.content).toBe('图片发送失败,请稍后再试');
  });

  it('超长回复按 UTF-8 截断到 2048 字节内且不截半', async () => {
    const handler = vi.fn(async () => '查'.repeat(1000));
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-long-1', { msgid: 'msg-long', text: { content: '你好' } }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    const final = fake.replies.find((reply) => reply.finish)!;
    expect(Buffer.byteLength(final.content, 'utf8')).toBeLessThanOrEqual(2048);
    expect(final.content).not.toContain('\uFFFD');
  });

  it('stop:断开连接且后续消息不再处理', async () => {
    const handler = vi.fn(async () => 'ok');
    const { channel, fake } = await startChannel(handler);

    await channel.stop();
    fake.emit('message.text', textFrame('cb-after-stop', { msgid: 'msg-after' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.disconnected).toBeGreaterThanOrEqual(1);
    expect(handler).not.toHaveBeenCalled();
  });
});
