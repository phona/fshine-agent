/**
 * 渠道装配档位（offline / shadow / live）· 确定性验证（假 SDK 客户端 + 假模型驱动；零网络）。
 *
 * 判据：
 *   · offline —— **不调用 channel.start**（不建立 WS 连接），出站视为 silent；
 *   · shadow  —— 建立连接（入站照收/回合照跑），但出站全部抑制：六类用户可见路径
 *                底层零投递、每次尝试可观测（suppressed 计数精确）；
 *   · live    —— 与改动前硬编码 `deliveryMode:'live'` 的装配**逐字节同序**：同一输入
 *                产生同一 SDK 调用序列、同一 file_delivery 事件事实。
 *
 * 反向绊线：
 *   · offline 若偷偷 start → 下面的 clientFactory/connected/start 断言必红；
 *   · shadow 若放行出站（deliveryMode 被翻成 live / 闸门被摘）→ 底层 recorder 收到投递、
 *     suppressed 计数为 0，本文件必红；
 *   · live 若被降级成 silent → 底层零投递、file_delivery 从 sent 变 suppressed，必红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHANNEL_MODE,
  type AppConfig,
  type ChannelMode,
  type ChannelReply,
  type ChannelRoute,
  type IncomingChannelMessage,
  type ReplyHandler,
} from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { WecomBotChannel, type DeliveryMode, type SdkClientLike } from '@fshine/channel-wecom';
import {
  channelModeOf,
  createChannelForMode,
  deliveryModeFor,
  serverStartedEvent,
  startChannelForMode,
} from './channel-mode';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const ENV = { WECOM_BOT_ID: 'bot-mode', WECOM_BOT_SECRET: 'mode-secret' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-channel-mode-'));
  tempDirs.push(dir);
  return dir;
}

interface RecordedCall {
  method: string;
  detail: string;
}

/**
 * 底层真实传输替身：把每一次出站调用**按序**记下。
 * 静默模式（offline/shadow）下它应当全零——"实际用户可见投递 = 0"的直接读数；
 * live 模式下序列用于与改动前的装配逐字对比。
 */
class RecordingSdk implements SdkClientLike {
  readonly calls: RecordedCall[] = [];
  readonly uploads: string[] = [];
  readonly activeMedia: string[] = [];
  readonly replyStreams: Array<{ content: string; finish: boolean }> = [];
  connected = 0;
  disconnected = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private uploadSeq = 0;

  on(event: string, listener: (...args: any[]) => void): unknown {
    this.calls.push({ method: 'on', detail: event });
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect(): unknown {
    this.calls.push({ method: 'connect', detail: '' });
    this.connected += 1;
    return this;
  }
  disconnect(): void {
    this.disconnected += 1;
  }
  replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.calls.push({ method: 'replyStream', detail: `${content}:${finish}` });
    this.replyStreams.push({ content, finish });
    return Promise.resolve({});
  }
  uploadMedia(_data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }> {
    this.calls.push({ method: 'upload', detail: options.filename });
    this.uploads.push(options.filename);
    this.uploadSeq += 1;
    return Promise.resolve({ media_id: `rec-${this.uploadSeq}` });
  }
  replyMedia(_frame: unknown, mediaType: 'image' | 'file', mediaId: string): Promise<unknown> {
    this.calls.push({ method: 'replyMedia', detail: `${mediaType}:${mediaId}` });
    return Promise.resolve({});
  }
  sendMessage(_chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.calls.push({ method: 'sendMessage', detail: body.markdown.content });
    return Promise.resolve({});
  }
  sendMediaMessage(_chatid: string, mediaType: 'file', mediaId: string): Promise<unknown> {
    this.calls.push({ method: 'sendMediaMessage', detail: `${mediaType}:${mediaId}` });
    this.activeMedia.push(mediaId);
    return Promise.resolve({});
  }
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> {
    return { buffer: Buffer.from('PK'), filename: 'f.xlsx' };
  }

  /** 用户可见投递调用总数（upload 不算投递本身，但静默下也应全零）。 */
  get userVisibleCalls(): number {
    return this.replyStreams.length + this.activeMedia.length
      + this.calls.filter((call) => call.method === 'sendMessage' || call.method === 'replyMedia').length;
  }
  get allCalls(): number {
    return this.calls.filter((call) => call.method !== 'on' && call.method !== 'connect').length;
  }
}

function textFrame(reqId: string, content: string) {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: `msg-${reqId}`,
      aibotid: 'bot-mode',
      chattype: 'single',
      from: { userid: 'user-a' },
      msgtype: 'text',
      text: { content },
    },
  };
}

function makeChannel(
  mode: ChannelMode,
  sdk: RecordingSdk,
  root: string,
  onClientFactory?: () => void,
): WecomBotChannel {
  return createChannelForMode(mode, (deliveryMode: 'live' | 'silent') => new WecomBotChannel({
    env: ENV,
    clientFactory: () => {
      onClientFactory?.();
      return sdk;
    },
    platformRoot: root,
    attachmentDir: path.join(root, 'tmp', 'attachments'),
    deliveryMode,
  }));
}

describe('channelModeOf：缺省 offline（单一缺省源），yaml 三档透传', () => {
  function baseConfig(): AppConfig {
    return {
      principals: {},
      contextProfiles: {},
      channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
      sessionTtlMs: 86_400_000,
    };
  }

  it('缺省 = offline；显式三档原样返回', () => {
    expect(DEFAULT_CHANNEL_MODE).toBe('offline');
    expect(channelModeOf(baseConfig())).toBe('offline');
    for (const mode of ['offline', 'shadow', 'live'] as const) {
      const config = baseConfig();
      config.channel.mode = mode;
      expect(channelModeOf(config)).toBe(mode);
    }
  });

  it('档位 → 出站模式：只有 live 放行；启动日志事件带 channelMode', () => {
    expect(deliveryModeFor('offline')).toBe('silent');
    expect(deliveryModeFor('shadow')).toBe('silent');
    expect(deliveryModeFor('live')).toBe('live');

    const event = serverStartedEvent({
      configPath: '/srv/agent.yaml',
      profileId: 'demo',
      dbPath: '/srv/state.db',
      channelMode: 'shadow',
      deliveryMode: deliveryModeFor('shadow'),
    });
    expect(event).toEqual({
      event: 'server_started',
      configPath: '/srv/agent.yaml',
      profileId: 'demo',
      dbPath: '/srv/state.db',
      channelMode: 'shadow',
      deliveryMode: 'silent',
    });
  });
});

describe('offline：不调用 channel.start（零 WS 连接），出站视为 silent', () => {
  it('start 未被调用、clientFactory 零调用、connected=0、deliveryMode=silent', async () => {
    const root = tempDir();
    const sdk = new RecordingSdk();
    let clientFactoryCalls = 0;
    const channel = makeChannel('offline', sdk, root, () => { clientFactoryCalls += 1; });
    let startCalls = 0;
    const handler: ReplyHandler = async () => {
      startCalls += 1;
      return 'ok';
    };

    const outcome = await startChannelForMode('offline', channel, handler);

    expect(outcome.started).toBe(false);
    expect(channel.deliveryMode).toBe('silent');
    expect(clientFactoryCalls).toBe(0); // start 没跑 = 没有任何真实连接尝试
    expect(sdk.connected).toBe(0);
    expect(sdk.allCalls).toBe(0);
    expect(startCalls).toBe(0); // handler 从未被交付
  });

  it('纯装配细件：startChannelForMode(offline) 不调用传入渠道的 start', async () => {
    let calls = 0;
    const fake = {
      deliveryMode: 'silent' as const,
      async start(): Promise<void> { calls += 1; },
    };
    const outcome = await startChannelForMode('offline', fake, async () => 'ok');
    expect(outcome.started).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('shadow：建立连接，六类出站路径全抑制、底层零投递、证据计数精确', () => {
  it('环境开关不能覆盖档位：shadow 显式 silent 优先于 FSHINE_WECOM_DELIVERY=live', async () => {
    const root = tempDir();
    const sdk = new RecordingSdk();
    const channel = createChannelForMode('shadow', (deliveryMode) => new WecomBotChannel({
      // 即使运行环境残留了旧的出站开关，档位装配的显式 silent 也不得被放行。
      env: { ...ENV, FSHINE_WECOM_DELIVERY: 'live' },
      clientFactory: () => sdk,
      platformRoot: root,
      attachmentDir: path.join(root, 'tmp', 'attachments'),
      deliveryMode,
    }));
    expect(channel.deliveryMode).toBe('silent'); // 档位优先，env 覆盖不生效
    const starting = startChannelForMode('shadow', channel, async () => '完成');
    sdk.emit('authenticated');
    await starting;
    sdk.emit('message.text', textFrame('cb-env', '你好'));
    await vi.waitFor(() => expect(channel.shadowEvidence().userVisibleSuppressed).toBe(2)); // ack+终帧
    expect(sdk.userVisibleCalls).toBe(0);
    await channel.stop();
  });

  it('ACK/进度/终态/异常兜底/拒绝/主动消息 = 17 次抑制、0 次真实投递', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = tempDir();
    const sdk = new RecordingSdk();
    const channel = makeChannel('shadow', sdk, root);
    const handler: ReplyHandler = async (message, progress, notice) => {
      if (message.text === 'throw') throw new Error('（测试）handler 故意抛错');
      if (message.text === 'refuse') return '该账号（wecom:stranger）未开通使用权限，请联系管理员开通。';
      progress?.('步骤一:正在定位账套');
      await notice?.('计划通知：本期口径已变更');
      return {
        text: '完成',
        files: [{ data: Buffer.from('a'), filename: '工资表.xlsx' }],
        image: { data: Buffer.from('PNG'), filename: '图.png' },
      };
    };

    const starting = startChannelForMode('shadow', channel, handler);
    sdk.emit('authenticated'); // 连接建立（shadow 必须真连，入站照收）
    const outcome = await starting;
    expect(outcome.started).toBe(true);
    expect(channel.deliveryMode).toBe('silent'); // shadow = 出站全抑制

    // ① ACK ② 进度 ③ 终态（文字 + 文件 + 图片）⑥ 主动消息同一条通道
    sdk.emit('message.text', textFrame('cb-main', '你好'));
    await vi.waitFor(() => expect(channel.shadowEvidence().suppressed).toBe(8));
    sdk.emit('message.text', textFrame('cb-throw', 'throw')); // ④ 异常兜底
    await vi.waitFor(() => expect(channel.shadowEvidence().suppressed).toBe(10));
    sdk.emit('message.text', textFrame('cb-refuse', 'refuse')); // ⑤ 宿主拒绝文案
    await vi.waitFor(() => expect(channel.shadowEvidence().suppressed).toBe(12));

    const route: ChannelRoute = { channel: 'wecom', conversationId: 'g-mode' };
    const receipt = await channel.sendToConversation(route, {
      text: '后台任务完成',
      files: [
        { data: Buffer.from('x'), filename: 'a.xlsx' },
        { data: Buffer.from('y'), filename: 'b.csv' },
      ],
    });

    // 闸门证据：六类路径逐一计数，总数精确（多/少一条都会红）。
    await vi.waitFor(() => expect(channel.shadowEvidence().suppressed).toBe(17));
    const evidence = channel.shadowEvidence();
    expect(evidence.mode).toBe('silent');
    expect(evidence.userVisibleSuppressed).toBe(13);
    expect(evidence.events.filter((event) => event.kind === 'reply_stream')).toHaveLength(8);
    expect(evidence.events.filter((event) => event.kind === 'send_message')).toHaveLength(1);
    expect(evidence.events.filter((event) => event.kind === 'upload_media')).toHaveLength(4);
    expect(evidence.events.filter((event) => event.kind === 'send_media')).toHaveLength(2);
    expect(evidence.events.filter((event) => event.kind === 'reply_media')).toHaveLength(2);

    // 实际用户可见投递 = 0：底层真实传输连 upload 都没触达。
    expect(sdk.userVisibleCalls).toBe(0);
    expect(sdk.uploads).toHaveLength(0);
    expect(sdk.allCalls).toBe(0);
    expect(sdk.connected).toBe(1); // 连接确实建立（不是 offline）
    // 被抑制的主动消息回执仍成形（影子干跑照常跑通下游）。
    expect(receipt.parts).toHaveLength(3);

    errorSpy.mockRestore();
    await channel.stop();
  });
});

// ── server 文件投递事件（file_delivery）跨档位 ──────────────────────────────

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

const workerNeverCalled = {
  async run(): Promise<never> {
    throw new Error('（测试）worker 不应被调用');
  },
};

/** 片 2：交付物只从 Worker 出 —— Main 交办，Worker 的 run_js 写 out/汇总.txt。 */
const TASK_RUN_CALL = { tool: 'task_run', args: { task: '帮我汇总成一份文件' } };
const WORKER_RUN_JS_CALL = {
  tool: 'run_js',
  args: { code: "require('node:fs').writeFileSync('out/汇总.txt', 'summary-bytes');" },
};

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 有推送面 = 后台派发（async）；0 窗口让受理即返回，文件投递走后台完成回调。
    runtime: { taskRunWaitMs: 0 },
  };
}

function incoming(messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text: '帮我汇总',
    receivedAt: new Date().toISOString(),
  };
}

interface FileTurnRun {
  logs: Array<Record<string, unknown>>;
  sdk: RecordingSdk;
  clientFactoryCalls: number;
  reply: ChannelReply;
}

/**
 * 同一输入（一条消息 → Main 交办 → Worker run_js 产出 out/汇总.txt → 回合末主动投递）
 * 跑一遍 server。片 2 起 Main 自己不产交付物。
 * previousAssembly=true 复现"改动前"的装配：直接 `new WecomBotChannel({deliveryMode:'live'})`
 * + 直接 `channel.start(...)`，不经档位装配；用于 live 的逐字对比。
 */
async function runFileTurn(options: { mode: ChannelMode; previousAssembly?: boolean }): Promise<FileTurnRun> {
  const root = tempDir();
  const sdk = new RecordingSdk();
  let clientFactoryCalls = 0;
  const channel = options.previousAssembly === true
    ? new WecomBotChannel({
        env: ENV,
        clientFactory: () => { clientFactoryCalls += 1; return sdk; },
        platformRoot: root,
        attachmentDir: path.join(root, 'tmp', 'attachments'),
        deliveryMode: 'live' as DeliveryMode,
      })
    : makeChannel(options.mode, sdk, root, () => { clientFactoryCalls += 1; });

  const logs: Array<Record<string, unknown>> = [];
  const mainDriver = {
    async run(input: { exec: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) {
      await input.exec(TASK_RUN_CALL.tool, TASK_RUN_CALL.args);
      return { text: '汇总完成。', messages: [] };
    },
  };
  const workerDriver = {
    async run(input: { exec: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) {
      await input.exec(WORKER_RUN_JS_CALL.tool, WORKER_RUN_JS_CALL.args);
      return { text: '汇总完成。', messages: [] };
    },
  };
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath: path.join(root, 'state.db'),
    createDrivers: () => ({ mainDriver, workerDriver }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    fileDelivery: {
      deliveryMode: channel.deliveryMode,
      sendToConversation: (route, files) => channel.sendToConversation(route, { files }),
    },
    logger: (line) => logs.push(line),
  });
  try {
    // 与 main.ts 同形：createServer 之后才把 server.handler 交给渠道/档位。
    const starting = options.previousAssembly === true
      ? channel.start(server.handler)
      : startChannelForMode(options.mode, channel, server.handler);
    sdk.emit('authenticated'); // offline 下无监听者（start 未调用），no-op
    await starting;
    const reply = await server.handler(incoming(options.previousAssembly === true ? 'm-beforeChange' : `m-${options.mode}`));
    // 有推送面 = async：文件投递发生在后台完成回调里；关服务器前必须等它落账
    // （否则 close 会先关库，后台收尾变成未处理异常）。
    await vi.waitFor(() => {
      expect(logs.some((line) => line['event'] === 'file_delivery')).toBe(true);
    }, { timeout: 15_000 });
    return { logs, sdk, clientFactoryCalls, reply };
  } finally {
    await channel.stop();
    await server.close();
  }
}

describe('shadow / offline 的 file_delivery 事件：sent 数 = 0、suppressed 计数正确', () => {
  for (const mode of ['shadow', 'offline'] as const) {
    it(`${mode}：文件回合记 suppressed（sent=0、files=1、deliveryMode=silent）`, async () => {
      const run = await runFileTurn({ mode });
      await vi.waitFor(() => {
        expect(run.logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      const deliveryLogs = run.logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]).toMatchObject({
        event: 'file_delivery',
        principalId: 'wecom:user-a',
        sessionId: 'wecom:conv-a',
        files: 1,
        status: 'suppressed',
        deliveryMode: 'silent',
      });
      expect(run.logs.filter((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toHaveLength(0);
      // 用户收到的正文不被「未送达」污染（静默部署本就无真实收件人）。
      expect(run.reply).toBe('汇总完成。');
      if (mode === 'offline') {
        expect(run.clientFactoryCalls).toBe(0); // 全程没有建立 WS 连接
        expect(run.sdk.connected).toBe(0);
      } else {
        expect(run.clientFactoryCalls).toBe(1); // shadow 真连（入站照收）
        expect(run.sdk.connected).toBe(1);
      }
      expect(run.sdk.userVisibleCalls).toBe(0); // 没有任何真实出站
    });
  }
});

describe('live：与改动前逐字节同序（同一输入同一事件序列）', () => {
  it('同一入站场景：装配后的 live 与改动前硬编码 live 的 SDK 调用序列完全一致', async () => {
    async function runWithFactory(
      factory: (sdk: RecordingSdk) => { channel: WecomBotChannel; sdk: RecordingSdk },
    ): Promise<RecordedCall[]> {
      const built = factory(new RecordingSdk());
      const handler: ReplyHandler = async (_message, progress, notice) => {
        progress?.('步骤一:正在定位账套');
        await notice?.('计划通知：本期口径已变更');
        return {
          text: '完成',
          files: [{ data: Buffer.from('a'), filename: '工资表.xlsx' }],
          image: { data: Buffer.from('PNG'), filename: '图.png' },
        };
      };
      const starting = built.channel.start(handler);
      built.sdk.emit('authenticated');
      await starting;
      built.sdk.emit('message.text', textFrame('cb-live', '你好'));
      await vi.waitFor(() => {
        expect(built.sdk.calls.filter((call) => call.method === 'replyMedia')).toHaveLength(2);
      });
      await built.channel.sendToConversation(
        { channel: 'wecom', conversationId: 'g-live' },
        { text: '后台完成', files: [{ data: Buffer.from('x'), filename: 'a.xlsx' }] },
      );
      await vi.waitFor(() => {
        expect(built.sdk.calls.filter((call) => call.method === 'sendMediaMessage')).toHaveLength(1);
      });
      await built.channel.stop();
      return built.sdk.calls;
    }

    const assembled = await runWithFactory((sdk) => {
      const root = tempDir();
      const channel = createChannelForMode('live', (deliveryMode) => new WecomBotChannel({
        env: ENV,
        clientFactory: () => sdk,
        platformRoot: root,
        attachmentDir: path.join(root, 'tmp', 'attachments'),
        deliveryMode,
      }));
      return { channel, sdk };
    });
    const beforeChange = await runWithFactory((sdk) => {
      const root = tempDir();
      const channel = new WecomBotChannel({
        env: ENV,
        clientFactory: () => sdk,
        platformRoot: root,
        attachmentDir: path.join(root, 'tmp', 'attachments'),
        deliveryMode: 'live',
      });
      return { channel, sdk };
    });

    // 核心判据：改动前硬编码 live 与档位装配 live 的同一输入 → 完全相同的调用序列。
    expect(assembled).toEqual(beforeChange);
    // 再钉死"同序"的具体内容（不是两个坏实现碰巧一致）。
    expect(assembled).toEqual([
      { method: 'on', detail: 'authenticated' },
      { method: 'on', detail: 'error' },
      { method: 'on', detail: 'message.text' },
      { method: 'on', detail: 'message.file' },
      { method: 'on', detail: 'message.mixed' },
      { method: 'connect', detail: '' },
      { method: 'replyStream', detail: '收到,正在处理…:false' },
      { method: 'replyStream', detail: '步骤一:正在定位账套:false' },
      { method: 'replyStream', detail: '计划通知：本期口径已变更:false' },
      { method: 'replyStream', detail: '完成:true' },
      { method: 'upload', detail: '工资表.xlsx' },
      { method: 'replyMedia', detail: 'file:rec-1' },
      { method: 'upload', detail: '图.png' },
      { method: 'replyMedia', detail: 'image:rec-2' },
      { method: 'sendMessage', detail: '后台完成' },
      { method: 'upload', detail: 'a.xlsx' },
      { method: 'sendMediaMessage', detail: 'file:rec-3' },
    ]);
  });

  it('server 侧同一输入：装配后的 live 与改动前硬编码 live 的 file_delivery 事实逐字相同', async () => {
    const assembled = await runFileTurn({ mode: 'live' });
    const beforeChange = await runFileTurn({ mode: 'live', previousAssembly: true });

    // 有推送面 = 后台派发（async）：文件投递在后台完成回调里落账（message_done 是受理回合，
    // 不再承载 turn 级 fileDelivery——投递事实以 file_delivery/task_result_delivery_* 为准）。
    await vi.waitFor(() => {
      expect(assembled.logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      expect(beforeChange.logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
    });
    // 逐字比较时去掉每次任务不同的 taskId（投递事实的稳定字段逐字相同）。
    const deliveryFacts = (run: FileTurnRun) => run.logs
      .filter((line) => line['event'] === 'file_delivery')
      .map((line) => ({
        event: line['event'],
        principalId: line['principalId'],
        sessionId: line['sessionId'],
        files: line['files'],
        status: line['status'],
        ...(line['parts'] === undefined ? {} : { parts: line['parts'] }),
      }));
    expect(deliveryFacts(assembled)).toEqual(deliveryFacts(beforeChange));
    expect(deliveryFacts(assembled)).toEqual([{
      event: 'file_delivery',
      principalId: 'wecom:user-a',
      sessionId: 'wecom:conv-a',
      files: 1,
      status: 'sent',
      parts: 1,
    }]);
    // live 的真实出站确实落到替身（证明 sent 来自闸门放行，而不是端口感官）。
    expect(assembled.sdk.uploads).toEqual(['汇总.txt']);
    expect(assembled.sdk.activeMedia).toHaveLength(1);
    expect(assembled.logs.some((line) => line['status'] === 'suppressed')).toBe(false);
  });
});
