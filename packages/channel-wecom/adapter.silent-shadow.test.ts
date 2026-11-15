/**
 * Silent Shadow 闸门直测（B2）：**默认静默**的机械出站闸，覆盖**所有用户可见发送路径**。
 *
 * 判据（逐路径）：① 发送被抑制；② 尝试可观测（闸门留可核证据）；③ 实际用户可见投递 = 0。
 *
 * 反向绊线：显式 `live` 时同一条路径**落到**底层客户端——证明"零投递"是闸门造成的，不是
 * 替身无声吞掉；且缺省（不传 deliveryMode / 环境开关非 live）必须静默——若有人把缺省翻成
 * live 或把工厂出口的包裹摘掉，本文件的缺省用例即红。
 *
 * 零真实平台：底层是记录调用的替身；闸门在静默模式下根本不会调用它。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelRoute,
  IncomingChannelMessage,
  ReplyHandler,
} from '@fshine/contracts';
import {
  SilentShadowGate,
  WecomBotChannel,
  resolveDeliveryMode,
  WECOM_DELIVERY_ENV,
} from './src/index';
import type { SdkClientLike } from './src/index';

const ENV = { WECOM_BOT_ID: 'bot-shadow', WECOM_BOT_SECRET: 'shadow-secret' };

/**
 * 底层真实传输替身：把每一次出站调用**逐条记下**。静默模式下它应当**全零**——
 * 这就是"实际用户可见投递 = 0"的直接读数。
 */
class DeliveryRecorder implements SdkClientLike {
  readonly replyStreams: Array<{ content: string; finish: boolean }> = [];
  readonly sentMessages: Array<{ chatid: string; content: string }> = [];
  readonly activeMedia: Array<{ chatid: string; mediaId: string }> = [];
  readonly mediaReplies: Array<{ mediaType: string; mediaId: string }> = [];
  readonly uploads: Array<{ filename: string }> = [];
  connected = 0;
  disconnected = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private uploadSeq = 0;

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect(): unknown { this.connected += 1; return this; }
  disconnect(): void { this.disconnected += 1; }

  replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.replyStreams.push({ content, finish });
    return Promise.resolve({});
  }
  uploadMedia(_data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }> {
    this.uploads.push({ filename: options.filename });
    this.uploadSeq += 1;
    return Promise.resolve({ media_id: `rec-${this.uploadSeq}` });
  }
  replyMedia(_frame: unknown, mediaType: 'image' | 'file', mediaId: string): Promise<unknown> {
    this.mediaReplies.push({ mediaType, mediaId });
    return Promise.resolve({});
  }
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.sentMessages.push({ chatid, content: body.markdown.content });
    return Promise.resolve({});
  }
  sendMediaMessage(chatid: string, _mediaType: 'file', mediaId: string): Promise<unknown> {
    this.activeMedia.push({ chatid, mediaId });
    return Promise.resolve({});
  }
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> {
    return { buffer: Buffer.from('PK'), filename: 'f.xlsx' };
  }

  /** 用户可见投递调用总数（upload 不算投递本身，但静默下也应全零）。 */
  get userVisibleCalls(): number {
    return this.replyStreams.length + this.sentMessages.length + this.activeMedia.length + this.mediaReplies.length;
  }
  get allCalls(): number {
    return this.userVisibleCalls + this.uploads.length;
  }
}

interface Started {
  channel: WecomBotChannel;
  sdk: DeliveryRecorder;
}

async function start(mode: 'silent' | 'live' | undefined, handler: ReplyHandler, root: string): Promise<Started> {
  const sdk = new DeliveryRecorder();
  const channel = new WecomBotChannel({
    env: ENV,
    clientFactory: () => sdk,
    platformRoot: root,
    attachmentDir: path.join(root, 'tmp', 'attachments'),
    ...(mode === undefined ? {} : { deliveryMode: mode }),
  });
  const starting = channel.start(handler);
  sdk.emit('authenticated');
  await starting;
  return { channel, sdk };
}

function textFrame(reqId: string, content = '你好', overrides: Record<string, unknown> = {}) {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${reqId}`,
      aibotid: 'bot-shadow',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'text',
      text: { content },
      ...overrides,
    },
  };
}

/** 等一次宏任务 + 微任务，让 fire-and-forget 的 reply 记录落定。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Silent Shadow 闸门：逐路径抑制 + 尝试可观测 + 投递=0', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'wecom-shadow-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('① 同步回帧 + 终态：ack 与终帧都被抑制，底层零投递，证据可见两条', async () => {
    const { channel, sdk } = await start('silent', async () => '好的,已收到', root);
    sdk.emit('message.text', textFrame('cb-1'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    const evidence = channel.shadowEvidence();
    expect(evidence.mode).toBe('silent');
    expect(evidence.userVisibleSuppressed).toBe(2); // ack + 终帧
    expect(evidence.events.every((event) => event.kind === 'reply_stream')).toBe(true);
    await channel.stop();
  });

  it('② 进度帧：progress 走 replyStream 也被抑制，证据含进度的尝试', async () => {
    const handler: ReplyHandler = async (_msg, progress) => {
      progress?.('步骤一:正在定位账套');
      return '完成';
    };
    const { channel, sdk } = await start('silent', handler, root);
    sdk.emit('message.text', textFrame('cb-prog'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    // ack + 进度 + 终帧 = 3 条被抑制的流式帧
    expect(channel.shadowEvidence().userVisibleSuppressed).toBe(3);
    await channel.stop();
  });

  it('③ 终态（多文件回传）：文字终帧 + 上传 + replyMedia 全被抑制', async () => {
    const handler: ReplyHandler = async () => ({
      text: '工资表已生成',
      files: [
        { data: Buffer.from('a'), filename: '工资表.xlsx' },
        { data: Buffer.from('b'), filename: '个税表.xlsx' },
      ],
    });
    const { channel, sdk } = await start('silent', handler, root);
    sdk.emit('message.text', textFrame('cb-files'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    expect(sdk.uploads).toHaveLength(0);
    const evidence = channel.shadowEvidence();
    // ack + 终帧(2 userVisible stream) + 2×upload(non-visible) + 2×reply_media(userVisible)
    expect(evidence.events.filter((event) => event.kind === 'reply_stream')).toHaveLength(2);
    expect(evidence.events.filter((event) => event.kind === 'upload_media')).toHaveLength(2);
    expect(evidence.events.filter((event) => event.kind === 'reply_media')).toHaveLength(2);
    await channel.stop();
  });

  it('④ 异常兜底：handler 抛错→FALLBACK 终帧被抑制，底层零投递', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { channel, sdk } = await start('silent', async () => { throw new Error('boom'); }, root);
    sdk.emit('message.text', textFrame('cb-err'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    expect(channel.shadowEvidence().userVisibleSuppressed).toBe(2); // ack + fallback
    errorSpy.mockRestore();
    await channel.stop();
  });

  it('⑤ 拒绝（宿主文案经终帧）：未开通文案的发送被抑制，底层零投递', async () => {
    // server.ts:222 未开通 principal 返回该文案；经适配器终帧发出——此处同形复现该字符串。
    const refusal = '该账号（wecom:stranger）未开通使用权限，请联系管理员开通。';
    const { channel, sdk } = await start('silent', async () => refusal, root);
    sdk.emit('message.text', textFrame('cb-refuse'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    expect(channel.shadowEvidence().userVisibleSuppressed).toBe(2); // ack + 拒绝终帧
    await channel.stop();
  });

  it('⑥ 主动消息：sendToConversation 的文字+文件全部被抑制，回执仍成形但底层零投递', async () => {
    const { channel, sdk } = await start('silent', async () => 'ok', root);
    const route: ChannelRoute = { channel: 'wecom', conversationId: 'wr_group_9' };
    const receipt = await (channel as unknown as {
      sendToConversation(r: ChannelRoute, reply: unknown): Promise<{ parts: unknown[] }>;
    }).sendToConversation(route, {
      text: '后台任务完成',
      files: [
        { data: Buffer.from('a'), filename: 'a.xlsx' },
        { data: Buffer.from('b'), filename: 'b.csv' },
      ],
    });

    expect(sdk.sentMessages).toHaveLength(0);
    expect(sdk.uploads).toHaveLength(0);
    expect(sdk.activeMedia).toHaveLength(0);
    // 回执仍成形（静默影子继续跑通下游），但**实际投递 = 0**。
    expect(receipt.parts).toHaveLength(3);
    const evidence = channel.shadowEvidence();
    expect(evidence.events.filter((event) => event.kind === 'send_message')).toHaveLength(1);
    expect(evidence.events.filter((event) => event.kind === 'upload_media')).toHaveLength(2);
    expect(evidence.events.filter((event) => event.kind === 'send_media')).toHaveLength(2);
    await channel.stop();
  });

  it('补充：计划通知（notice）经 replyStream 也被抑制', async () => {
    const handler: ReplyHandler = async (_msg, _progress, notice) => {
      await notice?.('计划通知：本期口径已变更');
      return '完成';
    };
    const { channel, sdk } = await start('silent', handler, root);
    sdk.emit('message.text', textFrame('cb-notice'));
    await settle();

    expect(sdk.userVisibleCalls).toBe(0);
    // ack + notice + 终帧 = 3
    expect(channel.shadowEvidence().userVisibleSuppressed).toBe(3);
    await channel.stop();
  });
});

describe('Silent Shadow 反向绊线：缺省静默 / 显式开启 / 绕过即红', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'wecom-shadow-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('缺省（不传 deliveryMode）= 静默：投递=0 且证据可见（若缺省被翻成 live / 闸门被摘，本用例必红）', async () => {
    const { channel, sdk } = await start(undefined, async () => '完成', root);
    expect(channel.deliveryMode).toBe('silent');
    sdk.emit('message.text', textFrame('cb-default'));
    await settle();

    // 绊线①：底层真实传输零调用（若闸门被绕过，sdk 会记录到 ack+终帧）
    expect(sdk.userVisibleCalls).toBe(0);
    // 绊线②：缺省必须是 silent（若把默认翻成 live，上面一条同样红）
    expect(channel.shadowEvidence().userVisibleSuppressed).toBeGreaterThanOrEqual(1);
    await channel.stop();
  });

  it('显式 live 不拦：同一条路径真实落到客户端（证明"零投递"来自闸门，而非替身吞掉）', async () => {
    const { channel, sdk } = await start('live', async () => '完成', root);
    expect(channel.deliveryMode).toBe('live');
    sdk.emit('message.text', textFrame('cb-live'));
    await vi.waitFor(() => expect(sdk.replyStreams.some((reply) => reply.finish)).toBe(true));

    expect(sdk.userVisibleCalls).toBeGreaterThanOrEqual(2); // ack + 终帧真切到达替身
    expect(channel.shadowEvidence().suppressed).toBe(0);
    await channel.stop();
  });

  it('环境开关：仅逐字 live 放行，其它取值（含大写/空串/未设）一律静默', () => {
    expect(resolveDeliveryMode(undefined, {})).toBe('silent');
    expect(resolveDeliveryMode(undefined, { [WECOM_DELIVERY_ENV]: '' })).toBe('silent');
    expect(resolveDeliveryMode(undefined, { [WECOM_DELIVERY_ENV]: '1' })).toBe('silent');
    expect(resolveDeliveryMode(undefined, { [WECOM_DELIVERY_ENV]: 'LIVE' })).toBe('silent');
    expect(resolveDeliveryMode(undefined, { [WECOM_DELIVERY_ENV]: ' live ' })).toBe('live');
    expect(resolveDeliveryMode('live', {})).toBe('live');
    expect(resolveDeliveryMode('silent', { [WECOM_DELIVERY_ENV]: 'live' })).toBe('silent'); // 显式选项优先
  });

  it('环境开关=live 时适配器放行真实投递（构造期读 env 生效）', async () => {
    const sdk = new DeliveryRecorder();
    const channel = new WecomBotChannel({
      env: { ...ENV, [WECOM_DELIVERY_ENV]: 'live' },
      clientFactory: () => sdk,
      platformRoot: root,
      attachmentDir: path.join(root, 'tmp', 'attachments'),
    });
    expect(channel.deliveryMode).toBe('live');
    const starting = channel.start(async () => '完成');
    sdk.emit('authenticated');
    await starting;
    sdk.emit('message.text', textFrame('cb-env-live'));
    await vi.waitFor(() => expect(sdk.replyStreams.some((reply) => reply.finish)).toBe(true));
    await channel.stop();
  });
});

describe('SilentShadowGate 单元：wrap 语义', () => {
  it('silent：返回不同实例，出站方法被拦并登记，连接/入站透传', async () => {
    const sdk = new DeliveryRecorder();
    const gate = new SilentShadowGate({ mode: 'silent', logger: () => {} });
    const wrapped = gate.wrap(sdk);
    expect(wrapped).not.toBe(sdk);

    await wrapped.replyStream({}, 's1', '你好', false);
    await wrapped.sendMessage('c1', { msgtype: 'markdown', markdown: { content: 'hi' } });
    await wrapped.uploadMedia(Buffer.from('x'), { type: 'file', filename: 'a.xlsx' });
    await wrapped.sendMediaMessage?.('c1', 'file', 'm1');
    await wrapped.replyMedia({}, 'file', 'm1');

    expect(sdk.allCalls).toBe(0); // 底层零调用
    expect(gate.suppressedUserVisible).toBe(4); // reply_stream/send_message/send_media/reply_media
    expect(gate.suppressedTotal).toBe(5);       // 加上 upload_media（非用户可见）
    wrapped.connect();
    expect(sdk.connected).toBe(1); // 连接透传
    await wrapped.downloadFile('u');
    // 入站下载透传（替身返回固定值）
    expect(gate.snapshot().map((event) => event.kind)).toEqual([
      'reply_stream', 'send_message', 'upload_media', 'send_media', 'reply_media',
    ]);
  });

  it('live：wrap 原样返回同一实例（不拦）', () => {
    const sdk = new DeliveryRecorder();
    const gate = new SilentShadowGate({ mode: 'live', logger: () => {} });
    expect(gate.wrap(sdk)).toBe(sdk);
  });
});
