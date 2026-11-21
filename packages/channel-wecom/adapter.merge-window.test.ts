/**
 * 附件-指令合并窗口（2026-11-17）：先发文件、后发指令在 IM 里是一个回合。
 *
 * 企微把文件与文字拆成 N+1 条独立消息，用户的实际形态是"几个文件 + 一条指令"。此前
 * 适配器收到纯附件消息就立刻交给 handler（附件-only 暂存），文字再到时是第二个回合；
 * 这条窗口把"最后一个文件 → 指令"的间隔吸收掉：窗口内的文字与全部待合并附件合成
 * **一次** handler 调用。窗口到期仍无文字则按纯附件回合交付（与既有行为一致，不卡消息）。
 *
 * 本文件只钉窗口本身（时间用假时钟推进，不真等 3 秒）；既有"文字先到、等 8 秒在途附件"
 * 的路径由 adapter.test.ts 原用例守着，不走本窗口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingChannelMessage, ReplyHandler } from '@fshine/contracts';
import {
  ATTACHMENT_MERGE_MAX_BYTES,
  ATTACHMENT_MERGE_MAX_FILES,
  ATTACHMENT_MERGE_WINDOW_MAX_MS,
  ATTACHMENT_MERGE_WINDOW_MS,
  WecomBotChannel,
} from './src/index';

const ENV = { WECOM_BOT_ID: 'bot-001', WECOM_BOT_SECRET: 'secret-abc' };

interface ReplyCall {
  reqId?: string;
  streamId: string;
  content: string;
  finish: boolean;
}

/** 官方 SDK WSClient 的测试替身：只记出站调用、按注入内容返回下载结果。 */
class FakeSdkClient {
  readonly replies: ReplyCall[] = [];
  readonly sentMessages: Array<{ chatid: string; content: string }> = [];
  readonly downloads: Array<{ url: string; aesKey?: string }> = [];
  downloadResult: { buffer: Buffer; filename?: string } | Error = { buffer: Buffer.from('x'), filename: 'f.bin' };
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  connect(): unknown { return this; }
  disconnect(): void { /* no-op */ }

  replyStream(
    frame: { headers?: { req_id?: string } },
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<unknown> {
    this.replies.push({ reqId: frame.headers?.req_id, streamId, content, finish });
    return Promise.resolve({});
  }

  uploadMedia(): Promise<{ media_id: string }> { return Promise.resolve({ media_id: 'media-1' }); }
  replyMedia(): Promise<unknown> { return Promise.resolve({}); }
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.sentMessages.push({ chatid, content: body.markdown.content });
    return Promise.resolve({});
  }

  async downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.downloads.push({ url, ...(aesKey === undefined ? {} : { aesKey }) });
    if (this.downloadResult instanceof Error) throw this.downloadResult;
    return this.downloadResult;
  }
}

const roots: string[] = [];
const channels: WecomBotChannel[] = [];

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wecom-merge-'));
  roots.push(root);
  return root;
}

async function start(
  handler: ReplyHandler,
  overrides: { mergeWindowMs?: number; mergeWindowMaxMs?: number } = {},
): Promise<{ channel: WecomBotChannel; fake: FakeSdkClient; root: string }> {
  const root = freshRoot();
  const fake = new FakeSdkClient();
  const channel = new WecomBotChannel({
    env: ENV,
    clientFactory: () => fake,
    platformRoot: root,
    attachmentDir: path.join(root, 'tmp', 'attachments'),
    deliveryMode: 'live',
    ...overrides,
  });
  const starting = channel.start(handler);
  fake.emit('authenticated');
  await starting;
  channels.push(channel);
  return { channel, fake, root };
}

function fileFrame(reqId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${reqId}`,
      aibotid: 'bot-001',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'file',
      file: { url: `https://example.invalid/${reqId}.xlsx`, aeskey: 'AESKEY' },
      ...overrides,
    },
  };
}

function textFrame(reqId: string, content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${reqId}`,
      aibotid: 'bot-001',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'text',
      text: { content },
      ...overrides,
    },
  };
}

/** 冲掉 dispatch 尾部的微任务（含下载完成、入窗）与 0ms 计时器；不推进逻辑时间。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

function messageOf(call: unknown[]): IncomingChannelMessage {
  return call[0] as IncomingChannelMessage;
}

function quiet(): ReplyHandler {
  return async () => '';
}

describe('附件-指令合并窗口', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    for (const channel of channels.splice(0)) await channel.stop();
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('缺省窗口：续期 3 秒、总上限 5 秒、有界 5 个/25MB', () => {
    expect(ATTACHMENT_MERGE_WINDOW_MS).toBe(3_000);
    expect(ATTACHMENT_MERGE_WINDOW_MAX_MS).toBe(5_000);
    expect(ATTACHMENT_MERGE_MAX_FILES).toBe(5);
    expect(ATTACHMENT_MERGE_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('① 文件 → 窗口内来文字：handler 只调用一次，载荷含文本与全部附件', async () => {
    const handler = vi.fn(async () => '好的');
    const { fake } = await start(handler);
    fake.downloadResult = { buffer: Buffer.from('xlsx'), filename: '工资.xlsx' };

    fake.emit('message.file', fileFrame('m1-file'));
    await settle();
    expect(handler).not.toHaveBeenCalled();                    // 窗口内不交给 handler
    expect(fake.replies).toEqual([]);                          // 窗口内不发任何气泡

    fake.emit('message.text', textFrame('m2-text', '帮我做工资表'));
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    const message = messageOf(handler.mock.calls[0]!);
    // 与既有附件消息同一文本形态：用户正文在前，附件占位说明按到达序随后。
    expect(message.text).toBe('帮我做工资表\n[附件:工资.xlsx]');
    expect(message.messageId).toBe('msg-m2-text');             // 回合归属指令消息
    expect(message.attachments?.map((file) => file.filename)).toEqual(['工资.xlsx']);
    expect(message.attachmentOnly).toBeUndefined();

    // 窗口已被文字吸收：再推进多久也不会有第二个 handler / 第二条收据。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fake.replies.some((reply) => reply.content.startsWith('已收到'))).toBe(false);
  });

  it('② 文件 → 窗口到期：handler 一次、纯附件回合（不卡消息）', async () => {
    const handler = vi.fn(quiet());
    const { fake } = await start(handler);
    fake.downloadResult = { buffer: Buffer.from('xlsx'), filename: '工资.xlsx' };

    fake.emit('message.file', fileFrame('m-file'));
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(fake.replies).toEqual([]);

    await vi.advanceTimersByTimeAsync(ATTACHMENT_MERGE_WINDOW_MS - 1);
    expect(handler).not.toHaveBeenCalled();                    // 3 秒前不提前交付

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const message = messageOf(handler.mock.calls[0]!);
    expect(message.attachmentOnly).toBe(true);
    expect(message.attachments?.map((file) => file.filename)).toEqual(['工资.xlsx']);
    expect(message.text).toBe('[附件:工资.xlsx]');

    // 与现行为一致：纯附件所有者无话可说时，由既有收据窗补一条（窗口本身零帧）。
    expect(fake.replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.replies.map((reply) => reply.content)).toEqual(['已收到 1 个文件']);
  });

  it('③ 三个文件 + 一句文字：handler 一次、附件 3 个（保持到达序）', async () => {
    const handler = vi.fn(async () => '好的');
    const { fake } = await start(handler);

    for (const [index, filename] of ['一月.xlsx', '二月.xlsx', '三月.xlsx'].entries()) {
      fake.downloadResult = { buffer: Buffer.from(`x${index}`), filename };
      fake.emit('message.file', fileFrame(`m-file-${index}`));
      await settle();
    }
    expect(handler).not.toHaveBeenCalled();
    expect(fake.replies).toEqual([]);

    fake.emit('message.text', textFrame('m-text', '按这三个月的工资做汇总'));
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    const message = messageOf(handler.mock.calls[0]!);
    expect(message.text).toBe('按这三个月的工资做汇总\n[附件:一月.xlsx]\n[附件:二月.xlsx]\n[附件:三月.xlsx]');
    expect(message.attachments?.map((file) => file.filename)).toEqual(['一月.xlsx', '二月.xlsx', '三月.xlsx']);
  });

  it('④ 超过 5 个文件：立即 flush，不等窗口', async () => {
    const handler = vi.fn(quiet());
    const { fake } = await start(handler);

    for (let index = 1; index <= ATTACHMENT_MERGE_MAX_FILES; index += 1) {
      fake.downloadResult = { buffer: Buffer.from(`x${index}`), filename: `f${index}.xlsx` };
      fake.emit('message.file', fileFrame(`m-file-${index}`));
      await settle();
    }
    expect(handler).not.toHaveBeenCalled();                    // 未超界：仍在窗口内

    fake.downloadResult = { buffer: Buffer.from('x6'), filename: 'f6.xlsx' };
    fake.emit('message.file', fileFrame('m-file-6'));
    await settle();                                            // 没有推进任何窗口时间

    expect(handler).toHaveBeenCalledTimes(1);
    const message = messageOf(handler.mock.calls[0]!);
    expect(message.attachmentOnly).toBe(true);
    expect(message.attachments).toHaveLength(ATTACHMENT_MERGE_MAX_FILES + 1);
  });

  it('④b 合计超过 25MB：立即 flush，不等窗口', async () => {
    const handler = vi.fn(quiet());
    const { fake } = await start(handler);
    fake.downloadResult = { buffer: Buffer.alloc(ATTACHMENT_MERGE_MAX_BYTES + 1), filename: 'big.xlsx' };

    fake.emit('message.file', fileFrame('m-big'));
    await settle();                                            // 未推进窗口时间

    expect(handler).toHaveBeenCalledTimes(1);
    expect(messageOf(handler.mock.calls[0]!).attachments?.[0]?.filename).toBe('big.xlsx');
  });

  it('⑥ 窗口内又来一个文件：续期一次，但不超过 5 秒总上限', async () => {
    const handler = vi.fn(quiet());
    const { fake } = await start(handler);

    const emitFile = async (name: string): Promise<void> => {
      fake.downloadResult = { buffer: Buffer.from(name), filename: name };
      fake.emit('message.file', fileFrame(`m-${name}`));
      await settle();
    };

    await emitFile('a.xlsx');                                  // t=0：3 秒窗
    await vi.advanceTimersByTimeAsync(2_000);
    await emitFile('b.xlsx');                                  // t=2s：续到 5 秒
    await vi.advanceTimersByTimeAsync(1_000);                  // t=3s：原窗口到点
    expect(handler).not.toHaveBeenCalled();                    // 续期生效

    await emitFile('c.xlsx');                                  // t=3s：再续，但不得越过 5 秒
    await vi.advanceTimersByTimeAsync(1_999);                  // t=4.999s
    expect(handler).not.toHaveBeenCalled();                    // 未被续到 6 秒
    await vi.advanceTimersByTimeAsync(1);                      // t=5s
    expect(handler).toHaveBeenCalledTimes(1);
    expect(messageOf(handler.mock.calls[0]!).attachments).toHaveLength(3);
  });

  it('构造参数可收紧窗口（测试/特殊部署用）', async () => {
    const handler = vi.fn(quiet());
    const { fake } = await start(handler, { mergeWindowMs: 100, mergeWindowMaxMs: 200 });
    fake.downloadResult = { buffer: Buffer.from('x'), filename: 'a.xlsx' };
    fake.emit('message.file', fileFrame('m-tight'));
    await settle();

    await vi.advanceTimersByTimeAsync(99);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('⑦ stop() 时窗口内消息不再投递：定时器撤掉、旧连接零帧', async () => {
    const handler = vi.fn(quiet());
    const { channel, fake } = await start(handler);
    fake.downloadResult = { buffer: Buffer.from('x'), filename: 'a.xlsx' };
    fake.emit('message.file', fileFrame('m-stop'));
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);                        // 窗口定时器

    await channel.stop();
    expect(vi.getTimerCount()).toBe(0);                        // 停机即撤

    await vi.advanceTimersByTimeAsync(ATTACHMENT_MERGE_WINDOW_MAX_MS + 10_000);
    expect(handler).not.toHaveBeenCalled();
    expect(fake.replies).toEqual([]);
  });
});
