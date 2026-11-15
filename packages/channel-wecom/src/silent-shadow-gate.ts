/**
 * Silent Shadow 出站闸门（B2）。
 *
 * 目标：**默认静默**——缺省抑制**所有用户可见投递**；开启真实投递须**显式开关**；
 * 每次被抑制的发送**留可观测证据**；对真实平台**零用户可见投递**。
 *
 * 机械保障：真实出站传输只有一条——官方 SDK 的 `SdkClientLike`。适配器里**所有**用户可见
 * 发送路径（同步回帧 / 进度帧 / 终态帧 / 异常兜底 / 宿主拒绝 / 主动消息 / 终帧降级 / 文件
 * 与图片回传）最终都落到这个客户端的方法上。因此把客户端**整体**包一层闸门，就从机械上
 * 覆盖了全部路径——不是逐条堵，而是收在唯一出口。
 *
 * 闸门只拦**出站投递**，不拦入站与连接：
 *   - 拦：replyStream / sendMessage / sendMediaMessage / replyMedia（用户可见投递）
 *         uploadMedia（上传后必然接一条回传，一并断掉；返回合成 media_id 让下游流程走通）
 *   - 放行：on / connect / disconnect（长连接是收消息的前提）
 *           downloadFile（入站附件下载，不是投递）
 *
 * 缺省静默：`resolveDeliveryMode` 只有在显式选项或显式环境开关下才放行真实投递；
 * 未设、设成其它值一律静默——**不引入向真实平台的隐式回退**。
 */

/** 出站投递模式：silent = 抑制（缺省）；live = 真实投递（须显式开启）。 */
export type DeliveryMode = 'silent' | 'live';

/** 显式开启真实投递的环境开关：值必须逐字等于 `live`，其余（含未设）一律静默。 */
export const WECOM_DELIVERY_ENV = 'FSHINE_WECOM_DELIVERY';
export const WECOM_DELIVERY_LIVE = 'live';

/** 闸门放行 / 抑制的底层传输方法（诚实登记是否用户可见）。 */
export type ShadowSendKind =
  | 'reply_stream'
  | 'send_message'
  | 'send_media'
  | 'reply_media'
  | 'upload_media';

/** 一次被抑制的发送留下的可核证据（不含正文，避免把用户内容写进日志）。 */
export interface SuppressedSend {
  at: string;
  kind: ShadowSendKind;
  /** 是否为用户可见投递（upload_media 为 false：它是投递的前置，本身不可见）。 */
  userVisible: boolean;
  /** 字节数（仅当调用方给了文本）；用于关联"被闸掉了多少内容"。 */
  bytes?: number;
}

export interface SilentShadowGateOptions {
  mode: DeliveryMode;
  /** 可注入的观测出口；缺省写一行结构化 JSON 到 console.warn。 */
  logger?: (line: Record<string, unknown>) => void;
}

/**
 * 出站闸门：持模式与证据，`wrap(client)` 返回一层同形客户端。
 * 静默模式下所有出站投递在此被拦下并登记；放行方法原样透传。
 */
export class SilentShadowGate {
  readonly mode: DeliveryMode;
  private readonly logger: (line: Record<string, unknown>) => void;
  private readonly events: SuppressedSend[] = [];
  private suppressedCount = 0;
  private mediaCounter = 0;

  constructor(options: SilentShadowGateOptions) {
    this.mode = options.mode;
    this.logger = options.logger ?? ((line) => console.warn(JSON.stringify(line)));
  }

  /** 被抑制的发送总数（用户可见 + 上传）。 */
  get suppressedTotal(): number {
    return this.suppressedCount;
  }

  /** 被抑制的**用户可见**发送数——判据"实际用户可见投递 = 0"直接读它。 */
  get suppressedUserVisible(): number {
    return this.events.filter((event) => event.userVisible).length;
  }

  /** 证据快照（拷贝，外部改不动内部状态）。 */
  snapshot(): SuppressedSend[] {
    return this.events.map((event) => ({ ...event }));
  }

  /**
   * 用闸门包住真实客户端。live 模式直接原样返回（显式开启＝不拦）；
   * silent 模式返回一层同形替身：出站投递被拦并登记，连接/入站透传。
   */
  wrap(client: SilentShadowTransport): SilentShadowTransport {
    if (this.mode === 'live') return client;
    const gate = this;
    return {
      on: (event, listener) => client.on(event, listener),
      connect: () => client.connect(),
      disconnect: () => client.disconnect(),
      downloadFile: (url, aesKey) => client.downloadFile(url, aesKey),
      replyStream: (_frame, _streamId, content, _finish) => {
        gate.record({ kind: 'reply_stream', userVisible: true, bytes: byteLen(content) });
        return Promise.resolve({});
      },
      sendMessage: (_chatid, body) => {
        gate.record({ kind: 'send_message', userVisible: true, bytes: byteLen(body.markdown.content) });
        return Promise.resolve({});
      },
      sendMediaMessage: (_chatid, _mediaType, _mediaId) => {
        gate.record({ kind: 'send_media', userVisible: true });
        return Promise.resolve({});
      },
      replyMedia: (_frame, _mediaType, _mediaId) => {
        gate.record({ kind: 'reply_media', userVisible: true });
        return Promise.resolve({});
      },
      uploadMedia: (_data, options) => {
        gate.record({ kind: 'upload_media', userVisible: false });
        gate.mediaCounter += 1;
        return Promise.resolve({ media_id: `silent-shadow-${gate.mediaCounter}-${options.filename}` });
      },
    };
  }

  private record(event: Omit<SuppressedSend, 'at'>): void {
    const entry: SuppressedSend = { at: new Date().toISOString(), ...event };
    this.events.push(entry);
    this.suppressedCount += 1;
    this.logger({
      event: 'wecom_silent_shadow_suppressed',
      mode: 'silent',
      kind: entry.kind,
      userVisible: entry.userVisible,
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    });
  }
}

/**
 * 闸门需要的最小传输面。结构与适配器的 `SdkClientLike` 一致；单独声明是为了避免
 * 本模块反向依赖适配器文件（适配器依赖本模块，类型面在此自持）。
 */
export interface SilentShadowTransport {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  replyStream(frame: { headers?: { req_id?: string }; body?: Record<string, unknown> }, streamId: string, content: string, finish: boolean): Promise<unknown>;
  uploadMedia(data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }>;
  replyMedia(frame: { headers?: { req_id?: string }; body?: Record<string, unknown> }, mediaType: 'image' | 'file', mediaId: string): Promise<unknown>;
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown>;
  sendMediaMessage?(chatid: string, mediaType: 'file', mediaId: string): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

/**
 * 解析生效投递模式：显式选项 > 显式环境开关 > 缺省静默。
 * 环境开关必须逐字 `live` 才放行——任何拼写偏差、未设、空串都落到 silent。
 */
export function resolveDeliveryMode(
  explicit: DeliveryMode | undefined,
  env: Record<string, string | undefined>,
): DeliveryMode {
  if (explicit !== undefined) return explicit;
  return (env[WECOM_DELIVERY_ENV] ?? '').trim() === WECOM_DELIVERY_LIVE ? 'live' : 'silent';
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
