/**
 * 企微智能机器人渠道适配:官方 @wecom/aibot-node-sdk 的薄封装。
 * 连接/订阅/心跳/指数退避重连由官方 SDK 管理;本层只做:
 * env 校验、消息归一化(剥离 @机器人)、进度与最终回复的 stream 帧、2048 字节截断、图片上传回传。
 */
import { randomUUID } from 'node:crypto';
import { WSClient } from '@wecom/aibot-node-sdk';
import type {
  ChannelAdapter,
  ChannelReply,
  IncomingChannelMessage,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateUtf8 } from './text';

const ACK_TEXT = '收到,正在处理…';
const FALLBACK_REPLY = '处理失败,请稍后再试';
const IMAGE_FAIL_REPLY = '图片发送失败,请稍后再试';
const START_TIMEOUT_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 3_000;
const MAX_PROGRESS_FRAMES = 4;

interface SdkFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

/** 本适配用到的官方 SDK WSClient 能力面(便于测试注入替身) */
export interface SdkClientLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  replyStream(frame: SdkFrame, streamId: string, content: string, finish: boolean): Promise<unknown>;
  uploadMedia(data: Buffer, options: { type: 'image'; filename: string }): Promise<{ media_id: string }>;
  replyMedia(frame: SdkFrame, mediaType: 'image', mediaId: string): Promise<unknown>;
}

export interface WecomBotChannelOptions {
  env?: Record<string, string | undefined>;
  /** 注入官方 SDK 客户端的工厂(测试用);缺省创建真实 WSClient */
  clientFactory?: () => SdkClientLike;
}

export class WecomBotChannel implements ChannelAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory: () => SdkClientLike;
  private started = false;
  private handler: ReplyHandler | null = null;
  private client: SdkClientLike | null = null;

  constructor(options: WecomBotChannelOptions = {}) {
    this.env = options.env ?? process.env;
    this.clientFactory = options.clientFactory ?? defaultClientFactory(this.env);
  }

  async start(handler: ReplyHandler): Promise<void> {
    if (this.started) throw new Error('WecomBotChannel 已启动,不要重复调用 start()');
    const missing = ['WECOM_BOT_ID', 'WECOM_BOT_SECRET'].filter((name) => !(this.env[name] ?? '').trim());
    if (missing.length > 0) {
      throw new Error(`缺少环境变量 ${missing.join('、')},无法启动机器人长连接`);
    }
    this.handler = handler;
    this.started = true;

    const client = this.clientFactory();
    this.client = client;

    try {
      await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('连接企微超时(30 秒)')), START_TIMEOUT_MS);
      const ok = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };
      client.on('authenticated', () => ok());
      client.on('error', (error: Error) => fail(new Error(`企微连接错误:${error.message}`)));
      client.on('message.text', (frame: SdkFrame) => {
        void this.dispatchMessage(frame).catch((error: unknown) => {
          console.error(JSON.stringify({
            event: 'wecom_dispatch_fail',
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      });
      client.connect();
      });
    } catch (error) {
      // A failed startup must leave the adapter retryable and release the
      // failed SDK client. Only clean up our own client in case a future
      // start has already installed another one.
      if (this.client === client) {
        this.started = false;
        this.handler = null;
        this.client = null;
      }
      client.disconnect();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.handler = null;
    this.client?.disconnect();
    this.client = null;
  }

  private async dispatchMessage(frame: SdkFrame): Promise<void> {
    const handler = this.handler;
    const client = this.client;
    const body = frame.body;
    if (!handler || !client || !body || body['msgtype'] !== 'text') return;
    const textObj = body['text'];
    const content = (textObj as { content?: unknown } | undefined)?.content;
    if (typeof content !== 'string') return;
    const from = body['from'];
    const userid = (from as { userid?: unknown } | undefined)?.userid;
    if (typeof userid !== 'string' || userid === '') return;
    const msgid = typeof body['msgid'] === 'string' ? body['msgid'] : '';
    if (!msgid) return;
    const chatType = body['chattype'] === 'group' ? 'group' : 'single';
    const chatid = typeof body['chatid'] === 'string' && body['chatid'] !== '' ? body['chatid'] : undefined;

    const message: IncomingChannelMessage = {
      wecomUserId: userid,
      conversationId: chatid ?? userid,
      messageId: msgid,
      chatType,
      text: chatType === 'group' ? stripMentionPrefix(content) : content,
      receivedAt: new Date().toISOString(),
    };

    const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : randomUUID();
    const streamId = randomUUID();
    let lastProgressAt = 0;
    let progressCount = 0;
    const progress: ProgressFn = (text) => {
      if (progressCount >= MAX_PROGRESS_FRAMES) return;
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
      lastProgressAt = now;
      progressCount += 1;
      void this.reply(frame, reqId, streamId, text, false);
    };

    // 秒回 ack:用户即时可见;最终答案以同 streamId 的 finish=true 帧整体替换
    void this.reply(frame, reqId, streamId, ACK_TEXT, false);

    let reply: ChannelReply;
    try {
      reply = await handler(message, progress);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'wecom_handler_error',
        messageId: msgid,
        error: error instanceof Error ? error.message : String(error),
      }));
      reply = FALLBACK_REPLY;
    }
    const rich = typeof reply === 'string' ? { text: reply } : reply;

    let textSent = false;
    if (rich.text !== undefined && rich.text !== '') {
      textSent = true;
      void this.reply(frame, reqId, streamId, truncateUtf8(rich.text, MAX_REPLY_BYTES), true);
    }
    if (rich.image) {
      try {
        const uploaded = await client.uploadMedia(rich.image.data, {
          type: 'image',
          filename: rich.image.filename ?? 'image.png',
        });
        void this.replyMedia(client, frame, reqId, uploaded.media_id);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'wecom_image_fail',
          messageId: msgid,
          error: error instanceof Error ? error.message : String(error),
        }));
        if (!textSent) {
          void this.reply(frame, reqId, streamId, IMAGE_FAIL_REPLY, true);
        }
      }
    }
  }

  private reply(
    frame: SdkFrame,
    reqId: string,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    return client
      .replyStream(frame, streamId, content, finish)
      .then(async () => undefined)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: 'wecom_reply_fail',
          req_id: reqId,
          finish,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }

  private replyMedia(
    client: SdkClientLike,
    frame: SdkFrame,
    reqId: string,
    mediaId: string,
  ): Promise<void> {
    return client
      .replyMedia(frame, 'image', mediaId)
      .then(async () => undefined)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: 'wecom_media_fail',
          req_id: reqId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }
}

function defaultClientFactory(env: Record<string, string | undefined>): () => SdkClientLike {
  return () => {
    // 长连接由官方 SDK 管理:认证、心跳、指数退避重连(不限次数,服务型进程要求常连)
    return new WSClient({
      botId: (env['WECOM_BOT_ID'] ?? '').trim(),
      secret: (env['WECOM_BOT_SECRET'] ?? '').trim(),
      maxReconnectAttempts: -1,
    }) as unknown as SdkClientLike;
  };
}
