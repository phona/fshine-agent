/**
 * Silent Shadow 出站闸门（B2）。
 *
 * 目标：**显式声明才放行**——真实投递必须显式声明 `deliveryMode='live'`（或环境开关逐字
 * `live`）；显式 `silent`/`shadow`、以及**缺失或非法**的声明一律抑制**所有用户可见投递**
 * （fail-safe：默认缺失或非法 → 退化为 silent，绝不隐式回退到真实平台）；
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
 * opt-in 语义：`resolveDeliveryMode` 只在显式选项或显式环境开关下才放行真实投递；
 * 未设、设成非法值一律静默——**不引入向真实平台的隐式回退**。
 */

/**
 * 声明的出站投递模式：`live` = 真实投递（须显式声明）；`silent` / `shadow` = 抑制。
 * `shadow` 是「影子/观察」语义的显式抑制声明，与 `silent` 等效（都退化为 silent）。
 * **缺失或非法**的声明不在本类型内——由 `resolveDeliveryMode` 按 fail-safe 处理。
 */
export type DeliveryMode = 'live' | 'silent' | 'shadow';

/** 闸门实际采用的有效模式：只有两种——`live` 真实投递，`silent` 抑制。 */
export type EffectiveDeliveryMode = 'live' | 'silent';

/** 显式开启真实投递的环境开关：值必须逐字等于 `live`，其余（含未设）一律静默。 */
export const WECOM_DELIVERY_ENV = 'FSHINE_WECOM_DELIVERY';
export const WECOM_DELIVERY_LIVE = 'live';

/** 合法声明集合（供 resolveDeliveryMode / isDeliveryModeDeclared 复用）。 */
const DECLARED_MODES: readonly string[] = ['live', 'silent', 'shadow'];

/**
 * 解析生效投递模式（opt-in）：显式 `live` → live；显式 `silent`/`shadow` → silent；
 * **缺失或非法 → silent（fail-safe）**。
 *
 * 优先级：显式选项 ∈ {live, silent, shadow} 时以它为准（覆盖环境开关）；
 * 显式选项是非法值时**直接 fail-safe 到 silent**（不因环境开关而放行——非法声明优先）；
 * 显式选项缺失（undefined）时才回落到环境开关，且环境值必须逐字 `live` 才放行。
 */
export function resolveDeliveryMode(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): EffectiveDeliveryMode {
  if (explicit === 'live') return 'live';
  if (explicit === 'silent' || explicit === 'shadow') return 'silent';
  if (explicit !== undefined) return 'silent';
  return (env[WECOM_DELIVERY_ENV] ?? '').trim() === WECOM_DELIVERY_LIVE ? 'live' : 'silent';
}

/**
 * 是否**显式声明**了合法的投递模式（真实渠道据此判断「未声明 → 拒绝真实出站并留日志」）。
 *
 * 已声明：显式选项 ∈ {live, silent, shadow}，或显式选项缺失且环境开关逐字 `live`。
 * 未声明：两者都缺（默认配置缺失）；或显式选项为**非法值**（配置非法）。
 * 注意：显式选项为非法值时，即使环境开关为 `live` 也不计为已声明——非法声明优先 fail-safe。
 */
export function isDeliveryModeDeclared(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (explicit !== undefined) return DECLARED_MODES.includes(explicit);
  return (env[WECOM_DELIVERY_ENV] ?? '').trim() === WECOM_DELIVERY_LIVE;
}

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
  mode: EffectiveDeliveryMode;
  /** 可注入的观测出口；缺省写一行结构化 JSON 到 console.warn。 */
  logger?: (line: Record<string, unknown>) => void;
}

/**
 * 出站闸门：持模式与证据，`wrap(client)` 返回一层同形客户端。
 * 静默模式下所有出站投递在此被拦下并登记；放行方法原样透传。
 */
export class SilentShadowGate {
  readonly mode: EffectiveDeliveryMode;
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

/** 文本的 UTF-8 字节数（证据里记录"被闸掉了多少内容"）。 */
function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
