import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { IncomingChannelMessage, ReplyHandler } from '@fshine/contracts';
import { WecomBotChannel } from './src/index';

const ENV = { WECOM_BOT_ID: 'bot-001', WECOM_BOT_SECRET: 'secret-abc' };
const WS_URL = 'wss://openws.work.weixin.qq.com';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closedWith: Array<number | undefined> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith.push(code);
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitFrame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  emitClose(): void {
    this.onclose?.();
  }

  emitError(): void {
    this.onerror?.();
  }

  lastSent(): Record<string, unknown> {
    const frame = this.sent.at(-1);
    if (!frame) throw new Error('没有已发送的帧');
    return frame;
  }

  respondFrames(): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame['cmd'] === 'aibot_respond_msg');
  }

  /** ack 帧(finish=false,提示处理中) */
  ackRespondFrames(): Array<Record<string, unknown>> {
    return this.respondFrames().filter((frame) => {
      const body = frame['body'] as { stream?: { finish?: boolean } };
      return body?.stream?.finish === false;
    });
  }

  /** 最终答案帧(finish=true) */
  finalRespondFrames(): Array<Record<string, unknown>> {
    return this.respondFrames().filter((frame) => {
      const body = frame['body'] as { stream?: { finish?: boolean } };
      return body?.stream?.finish === true;
    });
  }
}

function msgCallbackFrame(reqId: string, body: Record<string, unknown>): Record<string, unknown> {
  return { cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body };
}

function textMsgBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msgid: `msg-${Math.random().toString(36).slice(2, 8)}`,
    aibotid: 'bot-001',
    chattype: 'single',
    from: { userid: 'zhangsan' },
    msgtype: 'text',
    text: { content: '你好' },
    ...overrides,
  };
}

function subscribeAck(inst: FakeWebSocket, errcode: number, errmsg: string): void {
  const sub = [...inst.sent].reverse().find((frame) => frame['cmd'] === 'aibot_subscribe');
  if (!sub) throw new Error('未找到订阅帧');
  inst.emitFrame({ cmd: 'aibot_subscribe', headers: sub['headers'], body: { errcode, errmsg } });
}

const activeChannels: WecomBotChannel[] = [];

async function startChannel(
  handler: ReplyHandler = async () => 'ok',
  env: Record<string, string | undefined> = ENV,
): Promise<{ channel: WecomBotChannel; inst: FakeWebSocket }> {
  const channel = new WecomBotChannel({ env, WebSocketImpl: FakeWebSocket });
  const started = channel.start(handler);
  const inst = FakeWebSocket.instances.at(-1);
  if (!inst) throw new Error('start 没有创建连接');
  inst.emitOpen();
  subscribeAck(inst, 0, 'ok');
  await started;
  activeChannels.push(channel);
  return { channel, inst };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function firstCallMessage(handler: Mock): IncomingChannelMessage {
  const call = handler.mock.calls[0];
  if (!call) throw new Error('handler 未被调用');
  return call[0] as IncomingChannelMessage;
}

describe('WecomBotChannel', () => {
  let errorSpy: Mock;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as Mock;
  });

  afterEach(async () => {
    await Promise.all(activeChannels.map((channel) => channel.stop()));
    activeChannels.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('start 成功:连接后发出订阅帧,errcode=0 时 start resolve', async () => {
    const channel = new WecomBotChannel({ env: ENV, WebSocketImpl: FakeWebSocket });
    const started = channel.start(async () => 'ok');
    activeChannels.push(channel);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe(WS_URL);
    ws.emitOpen();

    const sub = ws.lastSent();
    expect(sub['cmd']).toBe('aibot_subscribe');
    expect(sub['body']).toEqual({ bot_id: 'bot-001', secret: 'secret-abc' });
    const headers = sub['headers'] as { req_id: unknown };
    expect(typeof headers.req_id).toBe('string');

    subscribeAck(ws, 0, 'ok');
    await expect(started).resolves.toBeUndefined();
  });

  it('订阅 errcode!=0 → start reject,错误消息含 errmsg', async () => {
    const channel = new WecomBotChannel({ env: ENV, WebSocketImpl: FakeWebSocket });
    const started = channel.start(async () => 'ok');
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    subscribeAck(ws, 40014, 'invalid secret');

    await expect(started).rejects.toThrow(/invalid secret/);
    expect(ws.closedWith.length).toBeGreaterThan(0);
  });

  it('env 缺失 → start reject 且错误消息点名缺失变量,且不建连', async () => {
    const onlyIdMissing = new WecomBotChannel({
      env: { WECOM_BOT_ID: '', WECOM_BOT_SECRET: 's' },
      WebSocketImpl: FakeWebSocket,
    });
    await expect(onlyIdMissing.start(async () => 'ok')).rejects.toThrow(/WECOM_BOT_ID/);

    const bothMissing = new WecomBotChannel({ env: {}, WebSocketImpl: FakeWebSocket });
    await expect(bothMissing.start(async () => 'ok')).rejects.toThrow(
      /WECOM_BOT_ID.*WECOM_BOT_SECRET|WECOM_BOT_SECRET.*WECOM_BOT_ID/s,
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('单聊消息:handler 收到正确字段,respond 帧 req_id 透传且 content 为回复', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => '好的,已收到');
    const { inst } = await startChannel(handler);

    inst.emitFrame(
      msgCallbackFrame('cb-req-1', textMsgBody({ msgid: 'msg-1001', text: { content: '查一下6月账套' } })),
    );

    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(1));

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = firstCallMessage(handler);
    expect(msg.wecomUserId).toBe('zhangsan');
    expect(msg.conversationId).toBe('zhangsan');
    expect(msg.messageId).toBe('msg-1001');
    expect(msg.chatType).toBe('single');
    expect(msg.text).toBe('查一下6月账套');
    expect(() => new Date(msg.receivedAt).toISOString()).not.toThrow();

    const ack = inst.ackRespondFrames()[0]!;
    expect(ack['headers']).toEqual({ req_id: 'cb-req-1' });
    expect(ack['body']).toMatchObject({ msgtype: 'stream', stream: { finish: false } });

    const respond = inst.finalRespondFrames()[0]!;
    expect(respond['cmd']).toBe('aibot_respond_msg');
    expect(respond['headers']).toEqual({ req_id: 'cb-req-1' });
    expect(respond['body']).toMatchObject({
      msgtype: 'stream',
      stream: { finish: true, content: '好的,已收到' },
    });
    const streamId = (respond['body'] as { stream: { id: string } }).stream.id;
    expect(streamId).toBeTruthy();
    // ack 与最终帧共用同一 streamId(finish=false → true 整体替换)
    const ackStreamId = (ack['body'] as { stream: { id: string } }).stream.id;
    expect(ackStreamId).toBe(streamId);
  });

  it('群聊:剥离 @机器人 前缀后才进 handler,conversationId 取 chatid', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => 'ok');
    const { inst } = await startChannel(handler);

    inst.emitFrame(
      msgCallbackFrame(
        'cb-grp-1',
        textMsgBody({
          chattype: 'group',
          chatid: 'wr_group_9',
          from: { userid: 'lisi' },
          text: { content: '@财报助手 帮我查7月流水' },
        }),
      ),
    );
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(1));

    const msg = firstCallMessage(handler);
    expect(msg.chatType).toBe('group');
    expect(msg.conversationId).toBe('wr_group_9');
    expect(msg.wecomUserId).toBe('lisi');
    expect(msg.text).toBe('帮我查7月流水');

    inst.emitFrame(
      msgCallbackFrame(
        'cb-grp-2',
        textMsgBody({
          msgid: 'msg-grp-2',
          chattype: 'group',
          chatid: 'wr_group_9',
          from: { userid: 'lisi' },
          text: { content: '@财报助手　全角空格也要剥离' },
        }),
      ),
    );
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(2));
    const msg2 = (handler.mock.calls[1]![0] as unknown) as IncomingChannelMessage;
    expect(msg2.text).toBe('全角空格也要剥离');
  });

  it('非 text 消息或无 text 字段的帧被忽略,handler 不被调用', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => 'ok');
    const { inst } = await startChannel(handler);

    inst.emitFrame(
      msgCallbackFrame('cb-img-1', {
        msgid: 'msg-img',
        chattype: 'single',
        from: { userid: 'zhangsan' },
        msgtype: 'image',
        image: { url: 'https://example.com/a.png' },
      }),
    );
    inst.emitFrame(msgCallbackFrame('cb-empty-1', textMsgBody({ msgid: 'msg-empty', text: undefined })));
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(inst.respondFrames()).toHaveLength(0);
    expect(inst.ackRespondFrames()).toHaveLength(0);
  });

  it('handler 抛错:记单行日志并回复兜底文案', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => {
      throw new Error('boom');
    });
    const { inst } = await startChannel(handler);

    inst.emitFrame(msgCallbackFrame('cb-err-1', textMsgBody({ msgid: 'msg-err' })));
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(1));

    const respond = inst.finalRespondFrames()[0]!;
    expect(respond['headers']).toEqual({ req_id: 'cb-err-1' });
    expect(respond['body']).toMatchObject({
      msgtype: 'stream',
      stream: { finish: true, content: '处理失败,请稍后再试' },
    });

    const logged = errorSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(logged).toContain('wecom_handler_error');
    expect(logged).toContain('msg-err');
    expect(logged).not.toContain('secret-abc');
  });

  it('respond 回执 errcode!=0:ack 失败只记日志,不阻塞处理,后续消息仍可处理', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => '第一次回复');
    const { channel, inst } = await startChannel(handler);

    inst.emitFrame(msgCallbackFrame('cb-resp-1', textMsgBody({ msgid: 'msg-r1' })));
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(1));
    // 注入 ack 帧的失败回执(队列队首是 ack 帧)
    inst.emitFrame({
      cmd: 'aibot_respond_msg',
      headers: { req_id: 'cb-resp-1' },
      body: { errcode: 400, errmsg: 'respond failed' },
    });
    await flush();

    expect(errorSpy.mock.calls.some((args: unknown[]) => args.join(' ').includes('wecom_ack_fail'))).toBe(true);
    expect(errorSpy.mock.calls.some((args: unknown[]) => args.join(' ').includes('errcode=400'))).toBe(true);

    handler.mockResolvedValueOnce('第二次回复');
    inst.emitFrame(msgCallbackFrame('cb-resp-2', textMsgBody({ msgid: 'msg-r2' })));
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(2));
    expect(inst.finalRespondFrames()[1]!['body']).toMatchObject({
      msgtype: 'stream',
      stream: { finish: true, content: '第二次回复' },
    });
    await channel.stop();
  });

  it('心跳:每 30 秒发出一帧 ping', async () => {
    vi.useFakeTimers();
    const { inst } = await startChannel();

    await vi.advanceTimersByTimeAsync(30_000);
    const pings = inst.sent.filter((frame) => frame['cmd'] === 'ping');
    expect(pings).toHaveLength(1);
    expect(typeof (pings[0]!['headers'] as { req_id: unknown }).req_id).toBe('string');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inst.sent.filter((frame) => frame['cmd'] === 'ping')).toHaveLength(2);
  });

  it('断线重连:退避序列 1s/2s/4s/…/30s 封顶,订阅成功后退避重置', async () => {
    vi.useFakeTimers();
    const { inst: first } = await startChannel();

    const closeAndAssertDelay = async (delayMs: number, countBefore: number) => {
      FakeWebSocket.instances.at(-1)!.emitClose();
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(FakeWebSocket.instances).toHaveLength(countBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(countBefore + 1);
    };

    first.emitClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    let count = 2;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      await closeAndAssertDelay(delay, count);
      count += 1;
    }

    // 注入订阅成功后,退避重置回 1s
    const recovered = FakeWebSocket.instances.at(-1)!;
    recovered.emitOpen();
    subscribeAck(recovered, 0, 'ok');
    await vi.advanceTimersByTimeAsync(0);
    await closeAndAssertDelay(1000, count);
  });

  it('断线重连后重新发出订阅帧', async () => {
    vi.useFakeTimers();
    const { inst: first } = await startChannel();
    first.emitClose();
    await vi.advanceTimersByTimeAsync(1000);

    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.emitOpen();
    const sub = second.lastSent();
    expect(sub['cmd']).toBe('aibot_subscribe');
    expect(sub['body']).toEqual({ bot_id: 'bot-001', secret: 'secret-abc' });
  });

  it('disconnected_event 触发重连;其他事件只记日志不重连', async () => {
    vi.useFakeTimers();
    const { inst } = await startChannel();

    inst.emitFrame({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-1' },
      body: { eventtype: 'disconnected_event' },
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances.at(-1)!.emitOpen();
    expect(FakeWebSocket.instances.at(-1)!.lastSent()['cmd']).toBe('aibot_subscribe');

    const second = FakeWebSocket.instances.at(-1)!;
    second.emitFrame({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'ev-2' },
      body: { eventtype: 'enter_chat' },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('超长回复在 respond 前按 UTF-8 截断到 2048 字节内且不截半', async () => {
    const handler = vi.fn(async (_message: IncomingChannelMessage) => '查'.repeat(1000));
    const { inst } = await startChannel(handler);

    inst.emitFrame(msgCallbackFrame('cb-long-1', textMsgBody({ msgid: 'msg-long' })));
    await vi.waitFor(() => expect(inst.finalRespondFrames()).toHaveLength(1));

    const body = inst.finalRespondFrames()[0]!['body'] as { msgtype: string; stream: { content: string } };
    expect(body.msgtype).toBe('stream');
    expect(Buffer.byteLength(body.stream.content, 'utf8')).toBeLessThanOrEqual(2048);
    expect(body.stream.content).not.toContain('\uFFFD');
  });

  it('stop 后不再重连,连接以 1000 正常关闭', async () => {
    vi.useFakeTimers();
    const { channel, inst } = await startChannel();
    await channel.stop();

    expect(inst.closedWith).toContain(1000);
    inst.emitClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('连接 error 事件也触发重连', async () => {
    vi.useFakeTimers();
    const { inst } = await startChannel();
    inst.emitError();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
