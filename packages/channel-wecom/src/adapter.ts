import { createHash, randomUUID } from 'node:crypto';
import type { ChannelAdapter, ChannelReply, IncomingChannelMessage, ProgressFn, ReplyHandler, RichChannelReply } from '@fshine/contracts';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateUtf8 } from './text';

const DEFAULT_WS_BASE_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_INTERVAL_MS = 30_000;
const PENDING_TIMEOUT_MS = 10_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const CLOSE_NORMAL = 1000;
const FALLBACK_REPLY = '处理失败,请稍后再试';
const IMAGE_FAIL_REPLY = '图片发送失败,请稍后再试';
const PROGRESS_MIN_INTERVAL_MS = 3_000;
const MAX_PROGRESS_FRAMES = 4;

interface WsMessageEvent {
  data: unknown;
}

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: WsMessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

type WsCtor = new (url: string) => WsLike;

interface WsFrame {
  cmd?: unknown;
  headers?: { req_id?: unknown } | undefined;
  body?: unknown;
}

interface PendingRequest {
  onResponse: (body: Record<string, unknown>) => void;
  onFail: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WecomBotChannelOptions {
  env?: Record<string, string | undefined>;
  wsBaseUrl?: string;
  WebSocketImpl?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** errcode 兼容两种位置:官方真机在响应顶层,W1-C 测试夹具在 body 内。 */
function toErrcode(frame: Record<string, unknown>): number {
  if (typeof frame['errcode'] === 'number') return frame['errcode'];
  const body = asRecord(frame['body']);
  return body && typeof body['errcode'] === 'number' ? body['errcode'] : -1;
}

function toErrmsg(frame: Record<string, unknown>): string {
  if (typeof frame['errmsg'] === 'string') return frame['errmsg'];
  const body = asRecord(frame['body']);
  return body && typeof body['errmsg'] === 'string' ? body['errmsg'] : '';
}

/** 回执字段兼容顶层与 body 两种位置(与 toErrcode/toErrmsg 同理)。 */
function pickValue(frame: Record<string, unknown>, key: string): unknown {
  if (frame[key] !== undefined) return frame[key];
  const body = asRecord(frame['body']);
  return body?.[key];
}

function logError(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}

function tryClose(ws: WsLike, code: number = CLOSE_NORMAL): void {
  try {
    ws.close(code);
  } catch {
    // 忽略关闭异常
  }
}

export class WecomBotChannel implements ChannelAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly wsBaseUrl: string;
  private readonly webSocketImpl: unknown;

  private handler: ReplyHandler | null = null;
  private ws: WsLike | undefined;
  private wsCtor: WsCtor | undefined;
  private botId = '';
  private botSecret = '';
  private started = false;
  private stopped = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest[]>();

  constructor(options: WecomBotChannelOptions = {}) {
    this.env = options.env ?? process.env;
    this.wsBaseUrl = options.wsBaseUrl ?? DEFAULT_WS_BASE_URL;
    this.webSocketImpl = options.WebSocketImpl;
  }

  async start(handler: ReplyHandler): Promise<void> {
    if (this.started) throw new Error('WecomBotChannel 已启动,不要重复调用 start()');
    const missing = ['WECOM_BOT_ID', 'WECOM_BOT_SECRET'].filter(
      (name) => !(this.env[name] ?? '').trim(),
    );
    if (missing.length > 0) {
      throw new Error(`缺少环境变量 ${missing.join('、')},无法启动机器人长连接`);
    }
    const impl = (this.webSocketImpl ?? globalThis.WebSocket) as WsCtor | undefined;
    if (typeof impl !== 'function') {
      throw new Error('当前运行环境没有可用的 WebSocket 客户端,需要 Node.js >= 24 的全局 WebSocket');
    }
    this.botId = (this.env['WECOM_BOT_ID'] ?? '').trim();
    this.botSecret = (this.env['WECOM_BOT_SECRET'] ?? '').trim();
    this.wsCtor = impl;
    this.handler = handler;
    this.started = true;
    this.stopped = false;
    try {
      await this.connectAndSubscribe();
    } catch (error) {
      this.started = false;
      this.clearReconnectTimer();
      this.stopHeartbeat();
      this.failAllPending(new Error('启动失败,放弃等待响应'));
      const ws = this.ws;
      this.ws = undefined;
      if (ws) tryClose(ws);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.handler = null;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.failAllPending(new Error('渠道已停止'));
    const ws = this.ws;
    this.ws = undefined;
    if (ws) tryClose(ws);
  }

  private connectAndSubscribe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ctor = this.wsCtor;
      if (!ctor) {
        reject(new Error('WebSocket 实现不可用'));
        return;
      }
      let settled = false;
      const settleOk = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleErr = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const ws = new ctor(this.wsBaseUrl);
      this.ws = ws;
      ws.onopen = () => {
        const reqId = randomUUID();
        this.safeSend(
          ws,
          {
            cmd: 'aibot_subscribe',
            headers: { req_id: reqId },
            body: { bot_id: this.botId, secret: this.botSecret },
          },
          (frame) => {
            const errcode = toErrcode(frame);
            if (errcode === 0) {
              this.backoffMs = INITIAL_BACKOFF_MS;
              this.startHeartbeat();
              settleOk();
              return;
            }
            settleErr(new Error(`企业微信智能机器人订阅失败: errcode=${errcode}, errmsg=${toErrmsg(frame)}`));
            tryClose(ws);
            this.scheduleReconnect();
          },
          (error) => {
            settleErr(error);
            tryClose(ws);
          },
        );
      };
      ws.onmessage = (event) => {
        this.handleFrame(event.data, ws);
      };
      ws.onclose = () => {
        this.handleConnectionLost(ws);
        settleErr(new Error('连接在订阅完成前关闭'));
      };
      ws.onerror = (event?: unknown) => {
        const detail = event instanceof Error ? event.message : undefined;
        logError({ event: 'wecom_socket_error', ...(detail ? { detail } : {}) });
        this.handleConnectionLost(ws);
        settleErr(new Error('连接发生错误'));
      };
    });
  }

  private handleFrame(raw: unknown, ws: WsLike): void {
    if (this.ws !== ws || typeof raw !== 'string') return;
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw) as WsFrame;
    } catch {
      logError({ event: 'wecom_frame_unparsable' });
      return;
    }
    if (asRecord(frame) === undefined) return;
    if (frame.cmd === 'aibot_msg_callback') {
      void this.handleMessageCallback(frame);
      return;
    }
    if (frame.cmd === 'aibot_event_callback') {
      this.handleEventCallback(frame);
      return;
    }
    const reqId = frame.headers?.req_id;
    if (typeof reqId !== 'string') return;
    // 回执按发送顺序到达:req_id 队列的队首即当前等待的帧(同一 req_id 可有多帧,如 ack+最终回复)
    const queue = this.pending.get(reqId);
    const entry = queue?.shift();
    if (!entry) return;
    if (queue && queue.length === 0) this.pending.delete(reqId);
    clearTimeout(entry.timer);
    entry.onResponse(asRecord(frame) ?? {});
  }

  private async handleMessageCallback(frame: WsFrame): Promise<void> {
    const body = asRecord(frame.body);
    if (!body || body['msgtype'] !== 'text') return;
    const textObj = asRecord(body['text']);
    const content = textObj?.['content'];
    if (!textObj || typeof content !== 'string') return;
    const from = asRecord(body['from']);
    const userid = typeof from?.['userid'] === 'string' ? from['userid'] : undefined;
    if (!userid) return;
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
    const handler = this.handler;
    if (!handler) return;
    const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : randomUUID();
    const ws = this.ws;
    if (!ws) {
      logError({ event: 'wecom_respond_skip', reason: '连接不可用,回复丢弃' });
      return;
    }
    // stream 协议的标准用法:先推 finish=false 的中间帧(用户即时可见),答案就绪后以同
    // streamId 的 finish=true 帧整体替换。ack 不等待回执、不阻塞处理(LLM/工具可能耗时数十秒)。
    const streamId = randomUUID();
    this.sendStreamFrame(ws, reqId, streamId, false, '收到,正在处理…').catch((error) => {
      logError({ event: 'wecom_ack_fail', req_id: reqId, error: asError(error).message });
    });

    // 阶段进度:runtime/host 的 onStep/onRetry 事件 → 节流后的 finish=false 帧
    // (与 ack/最终帧同 streamId,最终帧整体替换全部过程内容)。限频 30 条/分钟 → 节流必须。
    let lastProgressAt = 0;
    let progressCount = 0;
    const progress: ProgressFn = (text) => {
      if (progressCount >= MAX_PROGRESS_FRAMES) return;
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
      lastProgressAt = now;
      progressCount += 1;
      const wsNow = this.ws;
      if (!wsNow) return;
      this.sendStreamFrame(wsNow, reqId, streamId, false, text).catch((error) => {
        logError({ event: 'wecom_progress_fail', req_id: reqId, error: asError(error).message });
      });
    };

    const raw = await handler(message, progress).catch((error) => {
      logError({
        event: 'wecom_handler_error',
        messageId: message.messageId,
        error: asError(error).message,
      });
      return FALLBACK_REPLY;
    });
    const reply: RichChannelReply = typeof raw === 'string' ? { text: raw } : raw;

    const finalWs = this.ws;
    if (!finalWs) {
      logError({ event: 'wecom_respond_skip', reason: '回复就绪时连接已断开,丢弃' });
      return;
    }
    const text = reply.text ?? '';
    let textSent = false;
    if (text !== '') {
      textSent = true;
      await this.sendStreamFrame(finalWs, reqId, streamId, true, truncateUtf8(text, MAX_REPLY_BYTES)).catch((error) => {
        logError({ event: 'wecom_respond_fail', req_id: reqId, error: asError(error).message });
      });
    }
    if (reply.image) {
      const filename = reply.image.filename ?? 'image.png';
      try {
        const mediaId = await this.uploadMedia(finalWs, 'image', filename, reply.image.data);
        await this.sendAwait(finalWs, {
          cmd: 'aibot_respond_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'image', image: { media_id: mediaId } },
        });
      } catch (error) {
        logError({ event: 'wecom_image_fail', req_id: reqId, error: asError(error).message });
        if (!textSent) {
          await this.sendStreamFrame(finalWs, reqId, streamId, true, IMAGE_FAIL_REPLY).catch((sendError) => {
            logError({ event: 'wecom_respond_fail', req_id: reqId, error: asError(sendError).message });
          });
        }
      }
    }
  }

  /**
   * 经 WS 通道上传临时素材(init → 512KB base64 分片 → finish),返回 media_id。
   * 协议与官方 aibot-node-sdk uploadMedia 一致。
   */
  private async uploadMedia(
    ws: WsLike,
    type: 'image' | 'voice' | 'video' | 'file',
    filename: string,
    data: Buffer,
  ): Promise<string> {
    const CHUNK_SIZE = 512 * 1024;
    const totalChunks = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
    if (totalChunks > 100) throw new Error(`素材过大:${data.length} 字节超过分片上限`);
    const md5 = createHash('md5').update(data).digest('hex');

    const init = await this.sendAwait(ws, {
      cmd: 'aibot_upload_media_init',
      headers: { req_id: randomUUID() },
      body: { type, filename, total_size: data.length, total_chunks: totalChunks, md5 },
    });
    const uploadId = pickValue(init, 'upload_id');
    if (typeof uploadId !== 'string' || uploadId === '') {
      throw new Error(`素材上传初始化失败:未返回 upload_id`);
    }

    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = data.subarray(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, data.length));
      await this.sendAwait(ws, {
        cmd: 'aibot_upload_media_chunk',
        headers: { req_id: randomUUID() },
        body: { upload_id: uploadId, chunk_index: index, base64_data: chunk.toString('base64') },
      });
    }

    const finish = await this.sendAwait(ws, {
      cmd: 'aibot_upload_media_finish',
      headers: { req_id: randomUUID() },
      body: { upload_id: uploadId },
    });
    const mediaId = pickValue(finish, 'media_id');
    if (typeof mediaId !== 'string' || mediaId === '') {
      throw new Error('素材上传完成但未返回 media_id');
    }
    return mediaId;
  }

  /** 发送一帧并等待回执;回执 errcode 非 0 时 reject。 */
  private sendAwait(
    ws: WsLike,
    frame: { cmd: string; headers: { req_id: string }; body?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.safeSend(ws, frame, resolve, reject);
    });
  }

  /** 发送一帧 stream 回复并等待回执;errcode 非 0 时 reject。同一 req_id 的帧须串行发送。 */
  private sendStreamFrame(
    ws: WsLike,
    reqId: string,
    streamId: string,
    finish: boolean,
    content: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 注意:timer 必须在创建后回填进 entry(对象字面量会按值拷贝,提前放会永远是 undefined,
      // 导致超时定时器无法被清除、到点误杀连接——2026-09-16 +10s 断连事故的根因)
      const entry: PendingRequest = {
        onResponse: (frame) => {
          const errcode = toErrcode(frame);
          if (errcode !== 0) {
            reject(new Error(`errcode=${errcode}, errmsg=${toErrmsg(frame)}`));
            return;
          }
          resolve();
        },
        onFail: (error) => reject(error),
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      entry.timer = setTimeout(() => {
        this.dequeue(reqId, entry);
        reject(new Error(`等待回执超时(${PENDING_TIMEOUT_MS}ms)`));
      }, PENDING_TIMEOUT_MS);
      this.enqueue(reqId, entry);
      try {
        ws.send(JSON.stringify({
          cmd: 'aibot_respond_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'stream', stream: { id: streamId, finish, content } },
        }));
      } catch (error) {
        this.dequeue(reqId, entry);
        clearTimeout(entry.timer);
        reject(asError(error));
      }
    });
  }

  private handleEventCallback(frame: WsFrame): void {
    const eventType = asRecord(frame.body)?.['eventtype'];
    logError({ event: 'wecom_event_ignored', eventtype: typeof eventType === 'string' ? eventType : 'unknown' });
    if (eventType === 'disconnected_event') {
      const ws = this.ws;
      if (ws) this.handleConnectionLost(ws);
    }
  }

  private safeSend(
    ws: WsLike,
    frame: { cmd: string; headers: { req_id: string }; body?: Record<string, unknown> },
    onResponse: (body: Record<string, unknown>) => void,
    onFail: (error: Error) => void,
  ): void {
    const reqId = frame.headers.req_id;
    // timer 创建后回填进 entry(见 sendStreamFrame 内注释的事故根因)
    const entry: PendingRequest = {
      onResponse,
      onFail,
      timer: null as unknown as ReturnType<typeof setTimeout>,
    };
    entry.timer = setTimeout(() => {
      this.dequeue(reqId, entry);
      onFail(new Error(`等待 ${frame.cmd} 响应超时(${PENDING_TIMEOUT_MS}ms)`));
    }, PENDING_TIMEOUT_MS);
    this.enqueue(reqId, entry);
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      this.dequeue(reqId, entry);
      clearTimeout(entry.timer);
      onFail(asError(error));
    }
  }

  private enqueue(reqId: string, entry: PendingRequest): void {
    const queue = this.pending.get(reqId);
    if (queue) queue.push(entry);
    else this.pending.set(reqId, [entry]);
  }

  private dequeue(reqId: string, entry: PendingRequest): void {
    const queue = this.pending.get(reqId);
    if (!queue) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(reqId);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      this.safeSend(ws, { cmd: 'ping', headers: { req_id: randomUUID() } }, () => {}, () => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleConnectionLost(ws: WsLike): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.stopHeartbeat();
    this.failAllPending(new Error('连接已断开,未等到响应'));
    if (this.started && !this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.started) return;
    if (this.reconnectTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    logError({ event: 'wecom_reconnect_scheduled', delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAndSubscribe().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private failAllPending(error: Error): void {
    for (const [reqId, queue] of this.pending) {
      this.pending.delete(reqId);
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.onFail(error);
      }
    }
  }
}
