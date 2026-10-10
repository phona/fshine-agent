/**
 * 企微智能机器人渠道适配:官方 @wecom/aibot-node-sdk 的薄封装。
 * 连接/订阅/心跳/指数退避重连由官方 SDK 管理;本层只做:
 * env 校验、消息归一化(剥离 @机器人)、进度/通知/最终回复的 stream 帧、回复字节上限
 * 截断（MAX_REPLY_BYTES = 20480，见 text.ts——历史事故:W1 曾把它写成 2048，改值前先核
 * SDK README）、图片上传回传、**file 消息下载落盘**。
 *
 * 附件链路（2026-10-07 补）：此前只监听 `message.text`，`adapter.ts` 里
 * `body['msgtype'] !== 'text'` 直接 return——用户发的 Excel 连下载都没有，而下游执行层
 * （17dz 薪酬域）要求先吸收多份 Excel 才能产出契约，"帮我做工资表"因此永远无输入。
 * 现在监听 `message.file` / `message.mixed`，经 SDK 的 `downloadFile(url, aeskey)` 解密
 * 取 Buffer 后落到受信目录，只把**路径**交给上层。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WSClient } from '@wecom/aibot-node-sdk';
import type {
  ChannelAdapter,
  ChannelReply,
  IncomingAttachment,
  IncomingChannelMessage,
  NoticeFn,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateReply } from './text';

const ACK_TEXT = '收到,正在处理…';
const FALLBACK_REPLY = '处理失败,请稍后再试';
const IMAGE_FAIL_REPLY = '图片发送失败,请稍后再试';
const START_TIMEOUT_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 3_000;
const MAX_PROGRESS_FRAMES = 4;
/** 附件大小上限：企微 file 消息的合理体量。超限直接拒收，不落盘、不进上下文 */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** 单个附件名长度上限：防超长名把落盘路径撑爆（也防日志刷屏） */
const MAX_FILENAME_CHARS = 128;

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
  uploadMedia(data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }>;
  replyMedia(frame: SdkFrame, mediaType: 'image' | 'file', mediaId: string): Promise<unknown>;
  /** 下载企微素材（file/image）：url 五分钟内有效且已加密，需配 aeskey 解密 */
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface WecomBotChannelOptions {
  env?: Record<string, string | undefined>;
  /** 注入官方 SDK 客户端的工厂(测试用);缺省创建真实 WSClient */
  clientFactory?: () => SdkClientLike;
  /**
   * 附件落盘目录（**必须位于平台工作区内**）。
   *
   * 2026-10-07 修的 bug：最初落在宿主自己的 `data/attachments/`，而 worker 的 cwd 是平台
   * 工作区根——`workspaceRelPath` 按"在不在平台根内"裁决，于是每个附件都被判"工作区外"，
   * worker 连读都读不了，只能如实回复"路径在工作区外"。它那句诊断完全正确，错的是落点。
   * 现在缺省 `<platformRoot>/tmp/attachments/`：在平台根内（网关脚本按 cwd 就能打开它），
   * 又在 tmp/ 下（草稿区，可被 scratch 清理按年龄回收，不污染受版本控制的目录）。
   */
  attachmentDir?: string;
  /** 平台工作区根；用来把附件目录兜在场内。缺省用 cwd。 */
  platformRoot?: string;
}

export class WecomBotChannel implements ChannelAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory: () => SdkClientLike;
  private readonly attachmentDir: string;
  private readonly platformRoot: string;
  private started = false;
  private handler: ReplyHandler | null = null;
  private client: SdkClientLike | null = null;

  constructor(options: WecomBotChannelOptions = {}) {
    this.env = options.env ?? process.env;
    this.clientFactory = options.clientFactory ?? defaultClientFactory(this.env);
    const platformRoot = path.resolve(options.platformRoot ?? process.cwd());
    const fallback = path.join(platformRoot, 'tmp', 'attachments');
    const configured = (options.attachmentDir ?? (this.env['FSHINE_ATTACHMENT_DIR'] ?? '').trim()).trim();
    this.attachmentDir = path.resolve(configured || fallback);
    this.platformRoot = platformRoot;
  }

  async start(handler: ReplyHandler): Promise<void> {
    if (this.started) throw new Error('WecomBotChannel 已启动,不要重复调用 start()');
    const missing = ['WECOM_BOT_ID', 'WECOM_BOT_SECRET'].filter((name) => !(this.env[name] ?? '').trim());
    if (missing.length > 0) {
      throw new Error(`缺少环境变量 ${missing.join('、')},无法启动机器人长连接`);
    }
    this.handler = handler;
    this.started = true;

    // 落点自检：附件目录必须在平台工作区内。落在场外意味着每个附件都会被 worker 的
    // 路径守卫拒掉——那种失败要等到用户真发文件才暴露，且症状是"读不到附件"这种
    // 指代不清的报错。启动即断言，把配置错误前移到部署时。
    if (!this.attachmentDir.startsWith(this.platformRoot + path.sep) && this.attachmentDir !== this.platformRoot) {
      throw new Error(`附件目录必须在平台工作区内：${this.attachmentDir} 不在 ${this.platformRoot} 下`);
    }

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
      for (const event of ['message.text', 'message.file', 'message.mixed']) {
        client.on(event, (frame: SdkFrame) => {
          void this.dispatchMessage(frame).catch((error: unknown) => {
            console.error(JSON.stringify({
              event: 'wecom_dispatch_fail',
              error: error instanceof Error ? error.message : String(error),
            }));
          });
        });
      }
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

  /**
   * 从消息体取文本正文。text 取 text.content；mixed 把 msg_item 里的 text 项按序拼起来
   * （图片项忽略——没有下游执行层消费图片，但**不能因此把用户打的字一起丢掉**）；
   * file 消息本身没有正文，返回 undefined。
   */
  private textOf(body: Record<string, unknown>): string | undefined {
    const msgtype = String(body['msgtype']);
    if (msgtype === 'text') {
      const content = (body['text'] as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : undefined;
    }
    if (msgtype === 'mixed') {
      const items = (body['mixed'] as { msg_item?: unknown } | undefined)?.msg_item;
      if (!Array.isArray(items)) return undefined;
      return items
        .map((item) => {
          const type = (item as { msgtype?: unknown } | null)?.msgtype;
          const content = (item as { text?: { content?: unknown } } | null)?.text?.content;
          return type === 'text' && typeof content === 'string' ? content : '';
        })
        .filter((text) => text !== '')
        .join('\n');
    }
    return undefined;
  }

  /**
   * 下载并落盘本条消息的附件。
   *
   * 落盘而不是把 Buffer 往上传：宿主与 worker 跨进程，worker 只能引用路径（再作为
   * operation 的位置参数传给执行层）。三条纪律：
   *   ① **basename 化**——filename 来自企微用户，含 `../` 或绝对路径就能写出目录；
   *   ② **大小上限**——超限不落盘，进 failed 让用户知道；
   *   ③ **失败不抛**——单条附件失败只进 failed，其余附件与正文照常送达。
   */
  private async saveAttachments(
    body: Record<string, unknown>,
    client: SdkClientLike,
  ): Promise<{ saved: IncomingAttachment[]; failed: string[] }> {
    const saved: IncomingAttachment[] = [];
    const failed: string[] = [];
    if (String(body['msgtype']) !== 'file') return { saved, failed };
    const file = body['file'] as { url?: unknown; aeskey?: unknown } | undefined;
    const url = file?.url;
    if (typeof url !== 'string' || url === '') return { saved, failed: ['（无下载地址）'] };

    const hint = '附件';
    try {
      const downloaded = await client.downloadFile(url, typeof file?.aeskey === 'string' ? file.aeskey : undefined);
      const filename = this.safeFilename(downloaded.filename) ?? `attachment-${Date.now()}`;
      if (downloaded.buffer.length > MAX_ATTACHMENT_BYTES) {
        failed.push(`${filename}（超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB）`);
        return { saved, failed };
      }
      mkdirSync(this.attachmentDir, { recursive: true });
      // 加消息级前缀，避免不同用户/不同消息的同名文件互相覆盖
      const target = path.join(this.attachmentDir, `${randomUUID()}-${filename}`);
      writeFileSync(target, downloaded.buffer);
      saved.push({ filename, path: target, bytes: downloaded.buffer.length });
    } catch (error) {
      failed.push(`${hint}（${error instanceof Error ? error.message : String(error)}）`);
    }
    return { saved, failed };
  }

  /** 文件名安全化：只留 basename，剥控制字符与路径分隔符，截断长度 */
  private safeFilename(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const base = path.basename(raw.replace(/[\u0000-\u001f\u007f]/g, '').trim());
    const cleaned = base.replace(/[/\\]/g, '_').trim();
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? undefined : cleaned.slice(0, MAX_FILENAME_CHARS);
  }

  private async dispatchMessage(frame: SdkFrame): Promise<void> {
    const handler = this.handler;
    const client = this.client;
    const body = frame.body;
    const msgtype = body?.['msgtype'];
    // 只处理三类：text（正文）、file（附件）、mixed（图文混排里的文字部分）。
    // 其余（image/voice/video/event）本层不消费——没有下游执行层要吃图片或语音。
    if (!handler || !client || !body || !['text', 'file', 'mixed'].includes(String(msgtype))) return;

    const from = body['from'];
    const userid = (from as { userid?: unknown } | undefined)?.userid;
    if (typeof userid !== 'string' || userid === '') return;
    const msgid = typeof body['msgid'] === 'string' ? body['msgid'] : '';
    if (!msgid) return;
    const chatType = body['chattype'] === 'group' ? 'group' : 'single';
    const chatid = typeof body['chatid'] === 'string' && body['chatid'] !== '' ? body['chatid'] : undefined;

    const content = this.textOf(body);
    if (msgtype !== 'file' && typeof content !== 'string') return;

    const attachments = await this.saveAttachments(body, client);
    // 附件下载失败不能让整条消息消失：降级成"附件没拿到"的文字说明，用户至少知道
    // 该补什么，而不是等一个永远不来的回复。
    const parts: string[] = [];
    if (typeof content === 'string' && content.trim() !== '') parts.push(content);
    for (const failed of attachments.failed) parts.push(`[附件下载失败:${failed}]`);
    for (const ok of attachments.saved) parts.push(`[附件:${ok.filename}]`);
    if (parts.length === 0) return;

    const message: IncomingChannelMessage = {
      wecomUserId: userid,
      conversationId: chatid ?? userid,
      messageId: msgid,
      chatType,
      text: chatType === 'group' ? stripMentionPrefix(parts.join('\n')) : parts.join('\n'),
      ...(attachments.saved.length > 0 ? { attachments: attachments.saved } : {}),
      // 附件-only：本条没有用户正文（file 消息，或 mixed 里取不到任何文字项）。
      // 宿主据此只暂存附件、不启 Agent 回合——否则"先发文件再发指令"会变成 N 次 LLM 调用，
      // 并且串行堵住会话队列，把真正带指令的那条挡在后面。
      ...(typeof content !== 'string' || content.trim() === '' ? { attachmentOnly: true } : {}),
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
    const notice: NoticeFn = async (text) => {
      try {
        // 计划通知是三个出口里最可能超长的一个：平台 noticeText 由账套/期间/客户/科目
        // 多个集合 join 而成、无条数上限（17dz plan.js 的 scope 摘要）。与最终回复同一
        // 纪律——超限时**看得见地**截断（带标记）+ 记守夜事件（D-021：cef97c9 只改了
        // final 一条路，notice 还在用无声硬切，用户拿到半句话而不自知）。
        const bounded = truncateReply(text);
        if (bounded.truncated) {
          console.warn(JSON.stringify({
            event: 'wecom_reply_truncated',
            req_id: reqId,
            frame: 'notice',
            bytes: Buffer.byteLength(text, 'utf8'),
            limit: MAX_REPLY_BYTES,
          }));
        }
        await client.replyStream(frame, streamId, bounded.text, false);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'wecom_notice_fail',
          req_id: reqId,
          error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    };

    // 秒回 ack:用户即时可见;最终答案以同 streamId 的 finish=true 帧整体替换
    void this.reply(frame, reqId, streamId, ACK_TEXT, false);

    let reply: ChannelReply;
    try {
      reply = await handler(message, progress, notice);
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
      // 用户可见的最终回复：超上限时截断并带标记（守夜事件 wecom_reply_truncated 记录被截过）。
      const bounded = truncateReply(rich.text);
      if (bounded.truncated) {
        console.warn(JSON.stringify({
          event: 'wecom_reply_truncated',
          req_id: reqId,
          frame: 'final',
          bytes: Buffer.byteLength(rich.text, 'utf8'),
          limit: MAX_REPLY_BYTES,
        }));
      }
      void this.reply(frame, reqId, streamId, bounded.text, true);
    }
    // 文件回传（2026-10-08）：worker 在平台 tmp/ 下产出的 xlsx 等，经临时素材上传回传。
    // 失败只记事件不外抛——文本已经发出去了，不该因为附件上传失败把整轮回复搞成失败。
    if (rich.file) {
      try {
        const uploaded = await client.uploadMedia(rich.file.data, { type: 'file', filename: rich.file.filename });
        await client.replyMedia(frame, 'file', uploaded.media_id);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'wecom_file_fail',
          req_id: reqId,
          filename: rich.file.filename,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
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
