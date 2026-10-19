import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingChannelMessage, ReplyHandler } from '@fshine/contracts';
import { WecomBotChannel, type WecomBotChannelOptions } from './src/index';
import { MAX_REPLY_BYTES, REPLY_TRUNCATED_MARK } from './src/index';

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

  /** 主动消息通道（终帧拒收降级用）：默认成功并记录；测试可用 failNextSend 注入失败。 */
  readonly sentMessages: Array<{ chatid: string; content: string }> = [];
  private sendFailNext = false;
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.sentMessages.push({ chatid, content: body.markdown.content });
    if (this.sendFailNext) return Promise.reject(new Error('send boom'));
    return Promise.resolve({});
  }

  failNextSend(): void {
    this.sendFailNext = true;
  }

  /** 附件下载替身：默认把调用记下来并按注入内容返回 */
  downloadCalls: Array<{ url: string; aesKey?: string }> = [];
  downloadResult: { buffer: Buffer; filename?: string } | Error = { buffer: Buffer.from('x'), filename: 'f.bin' };
  async downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    this.downloadCalls.push({ url, ...(aesKey === undefined ? {} : { aesKey }) });
    if (this.downloadResult instanceof Error) throw this.downloadResult;
    return this.downloadResult;
  }
}

/**
 * 启动渠道。root 同时充当平台工作区，附件目录按生产布局落在 root/tmp/attachments——
 * 附件必须在平台工作区内，否则 worker 的路径守卫会把每个附件判成"工作区外"
 * （2026-10-07 实测的 bug）。顺带让启动自检在这批用例里也生效。
 */
async function startChannel(handler: ReplyHandler, root?: string) {
  const fake = new FakeSdkClient();
  const platformRoot = root ?? mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
  const options: WecomBotChannelOptions = {
    env: ENV,
    clientFactory: () => fake,
    platformRoot,
    attachmentDir: path.join(platformRoot, 'tmp', 'attachments'),
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

function fileFrame(reqId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${Math.random().toString(36).slice(2, 8)}`,
      aibotid: 'bot-001',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'file',
      file: { url: 'https://example.invalid/a.xlsx', aeskey: 'AESKEY' },
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

  it('启动认证失败:清理客户端并允许重试', async () => {
    const clients: FakeSdkClient[] = [];
    const channel = new WecomBotChannel({
      env: ENV,
      clientFactory: () => {
        const client = new FakeSdkClient();
        clients.push(client);
        return client;
      },
    });

    const firstStart = channel.start(async () => 'ok');
    clients[0]!.emit('error', new Error('bad credentials'));
    await expect(firstStart).rejects.toThrow('企微连接错误:bad credentials');
    expect(clients[0]!.disconnected).toBe(1);

    const secondStart = channel.start(async () => 'ok');
    clients[1]!.emit('authenticated');
    await expect(secondStart).resolves.toBeUndefined();
    expect(clients).toHaveLength(2);
    await channel.stop();
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

  // 受理帧豁免（首帧提速，2026-10-16）：本流第一帧 progress 是宿主在回合真正开跑时发的
  // 确定性回执（apps/server/handler.ts 的 TURN_ACCEPTED_TEXT，措辞归宿主管）——恰好一帧、
  // 永不重复（不构成 churn），因此不占 4 帧进度硬顶；真实进度帧的预算保持 4 帧不缩水。
  // 豁免按"第一帧"判定而不是按文案：宿主文案不是本层的契约，按内容嗅探会把两层耦死。
  it('受理帧豁免:本流第一帧 progress 不占 4 帧硬顶,第 6 帧才被丢', async () => {
    let clock = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const handler: ReplyHandler = async (_message, progress) => {
      for (let i = 1; i <= 6; i += 1) {
        progress?.(`进度帧${i}`);
        clock += 3_100; // 每帧间隔都超过 3 秒最小间隔：只有硬顶在起作用
      }
      return '完成';
    };
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-accept-1', { msgid: 'msg-accept' }));
    // handler 是同步的，一个真实宏任务之后所有帧都已记录（Date.now 被冻结不影响真定时器）
    await new Promise((resolve) => setTimeout(resolve, 50));
    nowSpy.mockRestore();

    expect(fake.replies.filter((reply) => reply.finish)).toHaveLength(1);
    const progressTexts = fake.replies
      .filter((reply) => !reply.finish && reply.content !== '收到,正在处理…')
      .map((reply) => reply.content);
    // 第 1 帧豁免 + 4 帧预算 = 5 帧；第 6 帧被硬顶丢（老行为：第 1 帧占预算，只送出 4 帧）
    expect(progressTexts).toEqual(['进度帧1', '进度帧2', '进度帧3', '进度帧4', '进度帧5']);
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

  it('超长回复截到上限内、不截半、且带截断标记', async () => {
    const handler = vi.fn(async () => '查'.repeat(30000));
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-long-1', { msgid: 'msg-long', text: { content: '你好' } }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    const final = fake.replies.find((reply) => reply.finish)!;
    expect(Buffer.byteLength(final.content, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(final.content).not.toContain('\uFFFD');
    expect(final.content.endsWith(REPLY_TRUNCATED_MARK)).toBe(true);
  });

  it('正常长度回复原样发送,不加截断标记', async () => {
    const handler = vi.fn(async () => '查'.repeat(1000));
    const { fake } = await startChannel(handler);

    fake.emit('message.text', textFrame('cb-long-2', { msgid: 'msg-long-2', text: { content: '你好' } }));
    await vi.waitFor(() => {
      const finals = fake.replies.filter((reply) => reply.finish);
      expect(finals).toHaveLength(1);
    });

    const final = fake.replies.find((reply) => reply.finish)!;
    expect(final.content).toBe('查'.repeat(1000));
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

// ── 附件链路（2026-10-07）───────────────────────────────────────────────────────
// 背景：此前只监听 message.text，`body['msgtype'] !== 'text'` 直接 return——用户发的
// Excel 连下载都没有。而 17dz 薪酬域要求先吸收多份 Excel 才能产出 PayrollContract，
// "帮我做工资表"因此永远无输入。这里锁住 file/mixed 三条路径 + 三条纪律。
describe('WecomBotChannel 附件(file 消息)', () => {
  it('file 消息:下载落盘,路径与文件名进上下文,正文给占位说明', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const dir = path.join(root, 'tmp', 'attachments');
    const handler = vi.fn(async () => 'ok');
    const { fake } = await startChannel(handler, root);
    fake.downloadResult = { buffer: Buffer.from('PK\u0003fake-xlsx'), filename: '2026年8月工资（幻骥达）.xlsx' };
    fake.emit('message.file', fileFrame('req-file-1'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const msg = firstCall(handler);
    expect(fake.downloadCalls).toEqual([{ url: 'https://example.invalid/a.xlsx', aesKey: 'AESKEY' }]);
    expect(msg.attachments).toHaveLength(1);
    const att = msg.attachments![0]!;
    expect(att.filename).toBe('2026年8月工资（幻骥达）.xlsx');
    expect(att.bytes).toBe(Buffer.from('PK\u0003fake-xlsx').length);
    expect(att.path.startsWith(dir)).toBe(true);
    expect(path.dirname(att.path)).toBe(dir);
    expect(existsSync(att.path)).toBe(true);
    expect(msg.text).toContain('[附件:2026年8月工资（幻骥达）.xlsx]');
    rmSync(root, { recursive: true, force: true });
  });

  it('纪律①:filename 做 basename 化,拒绝路径穿越写出目录', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const dir = path.join(root, 'tmp', 'attachments');
    const handler = vi.fn(async () => 'ok');
    const { fake } = await startChannel(handler, root);
    for (const evil of ['../../../../etc/passwd', '/etc/passwd', '..']) {
      handler.mockClear();
      fake.downloadResult = { buffer: Buffer.from('x'), filename: evil };
      fake.emit('message.file', fileFrame('req-evil'));
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());
      const att = firstCall(handler).attachments![0]!;
      expect(path.dirname(att.path)).toBe(dir);
      expect(att.path.includes('..')).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('纪律②:超限附件不落盘,降级为文字说明而不是静默丢弃', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const dir = path.join(root, 'tmp', 'attachments');
    const handler = vi.fn(async () => 'ok');
    const { fake } = await startChannel(handler, root);
    fake.downloadResult = { buffer: Buffer.alloc(33 * 1024 * 1024), filename: 'big.xlsx' };
    fake.emit('message.file', fileFrame('req-big'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    const msg = firstCall(handler);
    expect(msg.attachments).toBeUndefined();
    expect(msg.text).toContain('附件下载失败');
    expect(msg.text).toContain('big.xlsx');
    rmSync(root, { recursive: true, force: true });
  });

  it('纪律③:下载抛错不吞掉整条消息,正文照常送达', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const dir = path.join(root, 'tmp', 'attachments');
    const handler = vi.fn(async () => 'ok');
    const { fake } = await startChannel(handler, root);
    fake.downloadResult = new Error('url expired');
    fake.emit('message.file', fileFrame('req-err'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    const msg = firstCall(handler);
    expect(msg.text).toContain('附件下载失败');
    expect(msg.text).toContain('url expired');
    rmSync(root, { recursive: true, force: true });
  });

  it('mixed 消息:文字部分进正文,图片项忽略但不丢字', async () => {
    const handler = vi.fn(async () => 'ok');
    await startChannel(handler);
    handler.mockClear();
    // mixed 不走 dispatchMessage 的 file 分支，直接用 fake 的 text 通道模拟 mixed 帧
    const frame = {
      headers: { req_id: 'req-mixed' },
      body: {
        msgid: 'msg-mixed', aibotid: 'bot-001', chattype: 'single',
        from: { userid: 'zhangsan' }, msgtype: 'mixed',
        mixed: { msg_item: [
          { msgtype: 'text', text: { content: '这是8月工资' } },
          { msgtype: 'image', image: { url: 'https://example.invalid/p.png' } },
          { msgtype: 'text', text: { content: '第二段' } },
        ] },
      },
    };
    const { fake } = await startChannel(handler);
    handler.mockClear();
    fake.emit('message.mixed', frame);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(firstCall(handler).text).toBe('这是8月工资\n第二段');
  });

  // 默认落点必须在平台工作区内（root/tmp/attachments）。这是生产实际走的那条路径——
  // 上面所有用例都显式传了 attachmentDir，若不测默认值，"改回宿主 data/ 目录"这种回归
  // 会静默通过（变异验证实测抓到过）。
  it('不配 attachmentDir 时,默认落在平台工作区的 tmp/attachments', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const fake = new FakeSdkClient();
    const handler = vi.fn(async () => 'ok');
    // 必须裸构造且**不传** attachmentDir——经 startChannel 就走不到默认值那条路
    // （变异验证实测：传了目录，把默认改回宿主 data/ 也静默通过）。
    const channel = new WecomBotChannel({ env: ENV, clientFactory: () => fake, platformRoot: root });
    const started = channel.start(handler);
    fake.emit('authenticated');
    await started;
    fake.downloadResult = { buffer: Buffer.from('PK-data'), filename: 'a.xlsx' };
    fake.emit('message.file', fileFrame('req-default-dir'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    const att = firstCall(handler).attachments![0]!;
    expect(path.dirname(att.path)).toBe(path.join(root, 'tmp', 'attachments'));
    expect(att.path.startsWith(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  // 2026-10-07 实测 bug 的守卫：附件目录若配到平台工作区外，每个附件都会被 worker 的
  // 路径守卫判"工作区外"，症状是指代不清的"读不到附件"——那要等用户真发文件才暴露。
  // 所以启动即断言，把配置错误前移到部署时。
  it('附件目录在平台工作区外:启动即拒(不等用户发文件才发现)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wecom-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'wecom-outside-'));
    const handler = vi.fn(async () => 'ok');
    const channel = new WecomBotChannel({
      env: ENV, clientFactory: () => new FakeSdkClient(),
      platformRoot: root, attachmentDir: outside,
    });
    await expect(channel.start(handler)).rejects.toThrow(/必须在平台工作区内/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
