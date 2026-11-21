/**
 * 企微智能机器人渠道适配:官方 @wecom/aibot-node-sdk 的薄封装。
 * 连接/订阅/心跳/指数退避重连由官方 SDK 管理;本层只做:
 * env 校验、消息归一化(剥离 @机器人)、进度/通知/最终回复的 stream 帧、回复字节上限
 * 截断（MAX_REPLY_BYTES = 20480，见 text.ts——历史事故:W1 曾把它写成 2048，改值前先核
 * SDK README）、图片上传回传、**file 消息下载落盘**。
 *
 * 附件链路（2026-10-07 补）：此前只监听 `message.text`，`adapter.ts` 里
 * `body['msgtype'] !== 'text'` 直接 return——用户发的 Excel 连下载都没有，而下游执行层
 * （平台薪酬域）要求先吸收多份 Excel 才能产出契约，"帮我做工资表"因此永远无输入。
 * 现在监听 `message.file` / `message.mixed`，经 SDK 的 `downloadFile(url, aeskey)` 解密
 * 取 Buffer 后落到受信目录，只把**路径**交给上层。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WSClient } from '@wecom/aibot-node-sdk';
import type {
  ChannelDeliveryError as ChannelDeliveryErrorShape,
  ChannelAdapter,
  ChannelReply,
  ChannelRoute,
  DeliveryPartReceipt,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  NoticeFn,
  ProgressFn,
  ReplyHandler,
} from '@fshine/contracts';
import { formatFileAck } from '@fshine/contracts';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateReply } from './text';
import { extractMessageReference } from './quote';
import {
  isDeliveryModeDeclared,
  resolveDeliveryMode,
  SilentShadowGate,
  WECOM_DELIVERY_ENV,
  WECOM_DELIVERY_LIVE,
  type DeliveryMode,
  type EffectiveDeliveryMode,
  type SuppressedSend,
} from './silent-shadow-gate';

const FALLBACK_REPLY = '处理失败,请稍后再试';
const IMAGE_FAIL_REPLY = '图片发送失败,请稍后再试';
const START_TIMEOUT_MS = 30_000;
/**
 * 正文最多等待同会话已在途的附件下载；超时则拒绝本轮，避免缺附件进入 worker。
 * 与 handler 的 D-108 burst 稳定器一致：4 × 2s = 8s。
 */
export const ATTACHMENT_WAIT_TIMEOUT_MS = 8_000;
const ATTACHMENT_WAIT_TIMEOUT_REPLY = '附件尚未准备好,请稍后重试';
const PROGRESS_MIN_INTERVAL_MS = 3_000;
const MAX_PROGRESS_FRAMES = 4;
/**
 * 文件收据的并窗（毫秒）：附件-only 消息的文件名在这个窗口里累积，到点合成**一条**收据。
 *
 * 为什么是 2s：用户的自然形态是"几个文件 + 一条指令"在同一秒里发出（企微的模型里文件
 * 无法与文字同条，只能是 N+1 条独立消息）。窗口要盖住"最后一个文件 → 指令"的间隔；
 * 带正文的消息一到达就取消并窗（那时收据由回合首帧承载），所以这个窗口**不是**防抖窗
 * 的复制品——它只回答"还要不要替这批文件补一句"，与宿主的入站防抖各管一件事。
 *
 * 上界顾虑：窗口内不起流，到点才发这一条的**首帧**，所以窗口必须短于企微对被动回复的
 * 接受时限（SDK 只对欢迎语/模板卡片明确写了 5s；流式首帧同样有窗口，846608 是更新超时）。
 * 2s 留了一倍余量。改大先核这条。
 */
/** 文件收据的并窗（毫秒）。导出是为了让这个调参值有测试守着——改大先核上面的上界理由。 */
export const RECEIPT_COALESCE_MS = 2_000;

/**
 * 附件-指令合并窗口（毫秒）：纯附件消息不立刻交给 handler，先在这个窗口里等同会话文字。
 *
 * 为什么需要（2026-11-17）：企微把文件与文字拆成 N+1 条独立入站消息。用户的自然形态是
 * "几个文件 + 一条指令"，而适配器此前收到第一条文件就交付附件-only 回合、文字到达后再起
 * 第二个回合——同一件事被拆成两次 handler 调用。窗口把"最后一个文件 → 指令"的间隔吸收掉：
 * 窗口内到达的文字与全部待合并附件合成**一次** handler 调用（宿主仍只看到一条完整消息，
 * 窗口只是渠道适配层的入站整形，不是宿主机制）。
 *
 * 取值：3 秒盖住人打完一句指令的时间；窗口内每来一个新附件就续期，但总上限 5 秒——
 * 否则持续发文件会让指令永远等不到交付（"再等最后一个"没有终点）。
 */
export const ATTACHMENT_MERGE_WINDOW_MS = 3_000;
/** 合并窗口的总上限（毫秒）：续期不得越过起点 + 该值。 */
export const ATTACHMENT_MERGE_WINDOW_MAX_MS = 5_000;
/** 待合并附件个数上限：超过立即 flush，不再等窗口。 */
export const ATTACHMENT_MERGE_MAX_FILES = 5;
/** 待合并附件合计字节上限：超过立即 flush，不再等窗口。 */
export const ATTACHMENT_MERGE_MAX_BYTES = 25 * 1024 * 1024;

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
  /**
   * 主动发送一条全新消息（SDK 的 aibot_send_msg 通道，不经流式更新）。降级通道：
   * 流式终帧被企微拒收（如 errcode 846608"stream message update expired"）时，
   * 用它把终稿作为新消息送达——见 reply() 的降级分支。
   */
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown>;
  /** 主动发送媒体消息，不依赖入站回调 frame。 */
  sendMediaMessage?(chatid: string, mediaType: 'file', mediaId: string): Promise<unknown>;
  /** 下载企微素材（file/image）：url 五分钟内有效且已加密，需配 aeskey 解密 */
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

/** Transport failure with the ACKs that were received before the failed part. */
export class WecomChannelDeliveryError extends Error implements ChannelDeliveryErrorShape {
  readonly code = 'CHANNEL_TRANSPORT_FAILED' as const;
  readonly route: ChannelRoute;
  readonly failedPart: ChannelDeliveryErrorShape['failedPart'];
  readonly receipt: DeliveryReceipt;
  readonly cause: unknown;

  constructor(
    route: ChannelRoute,
    failedPart: ChannelDeliveryErrorShape['failedPart'],
    receipt: DeliveryReceipt,
    cause: unknown,
  ) {
    // detail 可读化（2026-11-21 live P1）：真实 SDK 的拒收原因是普通对象（{errcode,errmsg}），
    // String() 会变成「[object Object]」——平台说了什么、哪个 chatid 被拒全被吞掉（live 实测
    // 告警推送 93006 的日志只有这一句）。对象一律 JSON 化，普通值照原样。
    const detail = cause instanceof Error
      ? cause.message
      : (cause !== undefined && cause !== null && typeof cause === 'object' ? JSON.stringify(cause) : String(cause));
    super(`企微主动交付失败（${failedPart.kind}[${failedPart.index}] ${failedPart.stage}）: ${detail}`);
    this.name = 'WecomChannelDeliveryError';
    this.route = { ...route };
    this.failedPart = { ...failedPart };
    this.receipt = { route: { ...receipt.route }, parts: [...receipt.parts] };
    this.cause = cause;
  }
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
  /**
   * 出站投递模式（Silent Shadow 闸门，opt-in）：**缺失或非法 → 抑制**（fail-safe）。
   * 真实投递必须**显式**声明（本选项 = `'live'`，或环境变量 `FSHINE_WECOM_DELIVERY=live`）；
   * 显式 `'silent'`/`'shadow'` 与任何非法值一律抑制。未声明的真实渠道在构造期拒绝真实出站
   * 并留 `wecom_delivery_mode_undeclared` 日志。
   */
  deliveryMode?: DeliveryMode;
  /**
   * 附件-指令合并窗口（毫秒）。缺省 {@link ATTACHMENT_MERGE_WINDOW_MS}（3 秒）；
   * 传 0 = 立即 flush（退化为逐条交付），测试与特殊部署可收紧。
   */
  mergeWindowMs?: number;
  /** 合并窗口总上限（毫秒）。缺省 {@link ATTACHMENT_MERGE_WINDOW_MAX_MS}（5 秒）。 */
  mergeWindowMaxMs?: number;
}

/** 终帧拒收降级的上下文：会话地址 + 本次回复的防重 latch（一次派发最多降级一条）。 */
interface ReplyDegrade {
  chatId: string;
  once: { used: boolean };
  /**
   * 缺陷 B（2026-11-21 live）：本回合要回的**原用户消息**文本（入站 frame 的 message
   * 文本）。只在降级路径用——回复上下文过期后终稿经 sendMessage 作为**新消息**发出，
   * 客户端把它排到最新消息下面，读起来像答非所问；正文前加一行原话引用（前 40 字）
   * 让这条推送自含话题。原话取不到（纯附件消息的收据等）= 缺省不加引用，不编造。
   */
  quoteText?: string;
}

/** 降级推送的原话引用片段上限（字符）：取原话前 40 字（live 实测口径）。 */
export const DEGRADE_QUOTE_MAX_CHARS = 40;

/**
 * 缺陷 B：降级推送（sendMessage 全新消息）的正文加一行原话引用——
 *   `回复「<原话片段>」：` + 空行 + 正文
 * 原话片段 = 原文压成单行后取前 {@link DEGRADE_QUOTE_MAX_CHARS} 字。机械事实，不编造：
 * 原话为空/全空白 = 原样返回正文（不加引用）。组合后仍过同一字节上限
 * （truncateReply：恰顶格的终稿被看见地截掉尾巴，不无声超限）。
 */
export function withReplyQuote(originalText: string, content: string): string {
  const fragment = originalText.replace(/\s+/gu, ' ').trim().slice(0, DEGRADE_QUOTE_MAX_CHARS);
  if (fragment === '') return content;
  return truncateReply(`回复「${fragment}」：\n\n${content}`).text;
}

/**
 * 挂起的文件收据：一个会话在一个并窗里到达的所有附件-only 消息，共用一条收据。
 *
 * 为什么需要并窗（2026-10-19）：企微的流式回复按入站消息的 `req_id` 走——一条用户
 * 消息就是一个气泡，N 个文件必然是 N 条"已收到 X"，和随后指令回合的帧在会话里互相
 * 穿插。修法是**不为文件起气泡**：附件-only 消息连秒回 ack 都不发（"收到,正在处理…"
 * 对一条只暂存不处理的消息是假承诺，而且没有终帧来改写它；2026-11-19 起**正文回合也不再
 * 发受理帧**，见 dispatchMessage），收据改由两处承载——
 * ① 带指令的回合首帧（宿主的规则二披露，`formatFileReceipt`，带文件名）；
 * ② 只发文件、迟迟没有指令时，本类在窗口到点后补一条，否则用户对着静默的会话
 *    不知道文件到底收没收到。这一条只说"收了几份"（`formatFileAck`，不带文件名）：
 *    文件名由随后的主动追问列，回执再列一遍就是两条几乎一样的清单（2026-11-17）。
 *
 * 通道挂在**最后到达**的那条附件消息上：时间上最接近用户所见，且窗内每条早到的消息
 * 都没有起过流——没有流就不会有转圈的 spinner。
 */
interface PendingReceipt {
  filenames: string[];
  frame: SdkFrame;
  streamId: string;
  chatId: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 合并窗口里的一条纯附件消息：已下载落盘的附件 + 它自己的投递面（frame/streamId）。
 *
 * 为什么每条都留着 frame：窗口到期按纯附件回合交付时，收据/终帧仍挂在**最后到达**的
 * 那条文件消息上（与既有并窗纪律一致：时间上最接近用户所见）。
 */
interface PendingMergeFile {
  conversationId: string;
  frame: SdkFrame;
  streamId: string;
  msgid: string;
  userid: string;
  chatType: 'single' | 'group';
  saved: IncomingAttachment[];
  failed: string[];
  bytes: number;
}

interface PendingMerge {
  files: PendingMergeFile[];
  totalBytes: number;
  /** 起点 + ATTACHMENT_MERGE_WINDOW_MAX_MS：续期不得越过它。 */
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class WecomBotChannel implements ChannelAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory: () => SdkClientLike;
  private readonly attachmentDir: string;
  private readonly platformRoot: string;
  /** Silent Shadow 闸门：opt-in 抑制，包住真实出站传输的唯一出口。 */
  private readonly gate: SilentShadowGate;
  /** 生效投递模式（live 须显式声明；缺失/非法/显式 silent|shadow = silent）——部署与测试可读。 */
  readonly deliveryMode: EffectiveDeliveryMode;
  /** 合并窗口长度 / 总上限（构造参数可覆盖，缺省见 ATTACHMENT_MERGE_WINDOW_*）。 */
  private readonly mergeWindowMs: number;
  private readonly mergeWindowMaxMs: number;
  private started = false;
  private handler: ReplyHandler | null = null;
  private client: SdkClientLike | null = null;
  /** 按会话（conversationId）记挂起的文件收据；stop() 时整体清掉。 */
  private readonly pendingReceipts = new Map<string, PendingReceipt>();
  /** 按会话记待合并的纯附件消息；窗口内来文字时整体吸收，stop() 时整体撤。 */
  private readonly pendingMerges = new Map<string, PendingMerge>();
  /** 按会话记正在等待在途附件的正文回合数：>0 时纯附件走旧的逐条交付（文字先到语义）。 */
  private readonly attachmentWaiters = new Map<string, number>();
  /**
   * 按会话记仍在处理的附件。企微把文件与正文拆成两条事件，正文必须等文件完成下载并
   * 交给 handler 暂存后再继续，否则会话回合会拿不到本应属于同一批输入的附件。
   */
  private readonly pendingAttachmentProcessing = new Map<string, Set<Promise<void>>>();
  /** stop() 用它唤醒等待中的正文 dispatch，避免停机后留下悬挂 Promise。 */
  private attachmentWaitInterrupt!: Promise<void>;
  private resolveAttachmentWaitInterrupt!: () => void;

  constructor(options: WecomBotChannelOptions = {}) {
    this.env = options.env ?? process.env;
    const baseFactory = options.clientFactory ?? defaultClientFactory(this.env);
    // opt-in：真实投递必须显式声明（options.deliveryMode='live' 或 env 开关逐字 live）；
    // 缺失/非法 → fail-safe 退化为 silent。闸门包在工厂出口上，于是首次 start() 建出的
    // 客户端就已是被闸的替身——适配器里所有用户可见发送路径都经 this.client，机械上全覆盖。
    this.deliveryMode = resolveDeliveryMode(options.deliveryMode, this.env);
    // 真实渠道必须先显式声明模式：未声明（配置缺失）或非法（配置错误）时，拒绝真实出站
    // 并留可观测日志——缺省绝不静默地连到真实平台，也不隐式放行。
    if (!isDeliveryModeDeclared(options.deliveryMode, this.env)) {
      console.warn(JSON.stringify({
        event: 'wecom_delivery_mode_undeclared',
        resolvedMode: this.deliveryMode,
        reason: options.deliveryMode === undefined ? 'missing' : 'invalid',
        hint: `真实出站已拒绝（fail-safe）。显式声明 deliveryMode='${WECOM_DELIVERY_LIVE}'`
          + ` 或设置 ${WECOM_DELIVERY_ENV}=${WECOM_DELIVERY_LIVE} 才会真实投递。`,
      }));
    }
    this.gate = new SilentShadowGate({ mode: this.deliveryMode });
    this.clientFactory = () => this.gate.wrap(baseFactory());
    this.mergeWindowMs = normalizeWindowMs(options.mergeWindowMs, ATTACHMENT_MERGE_WINDOW_MS);
    this.mergeWindowMaxMs = normalizeWindowMs(options.mergeWindowMaxMs, ATTACHMENT_MERGE_WINDOW_MAX_MS);
    const platformRoot = path.resolve(options.platformRoot ?? process.cwd());
    const fallback = path.join(platformRoot, 'tmp', 'attachments');
    const configured = (options.attachmentDir ?? (this.env['FSHINE_ATTACHMENT_DIR'] ?? '').trim()).trim();
    this.attachmentDir = path.resolve(configured || fallback);
    this.platformRoot = platformRoot;
    this.resetAttachmentWaitInterrupt();
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
    // 挂起的收据一并撤：窗口到点时要往企微发帧，停机后不该还有定时器挂着（会把测试
    // 收尾/进程退出拖住），也不该再往一个已断开的连接发东西。没收过的文件仍在暂存池里，
    // 下一条指令进来时由宿主的披露帧告知用户，信息不会丢。
    for (const key of [...this.pendingReceipts.keys()]) this.dropPendingReceipt(key);
    for (const key of [...this.pendingMerges.keys()]) this.dropPendingMerge(key);
    this.pendingAttachmentProcessing.clear();
    this.attachmentWaiters.clear();
    this.resolveAttachmentWaitInterrupt();
    this.resetAttachmentWaitInterrupt();
  }

  /**
   * Silent Shadow 可观测证据：被闸抑制的发送快照（拷贝）+ 计数。
   * 判据"出站尝试可观测 / 实际用户可见投递 = 0"直接读这里。
   */
  shadowEvidence(): { mode: EffectiveDeliveryMode; suppressed: number; userVisibleSuppressed: number; events: SuppressedSend[] } {
    return {
      mode: this.deliveryMode,
      suppressed: this.gate.suppressedTotal,
      userVisibleSuppressed: this.gate.suppressedUserVisible,
      events: this.gate.snapshot(),
    };
  }

  /**
   * Send new messages to a host-validated WeCom route, independent of any inbound
   * frame. Text is sent first, then each file is uploaded and sent as its own item.
   */
  async sendToConversation(route: ChannelRoute, reply: ChannelReply): Promise<DeliveryReceipt> {
    if (route.channel !== 'wecom') {
      throw new Error(`WecomBotChannel 不支持渠道 ${route.channel}`);
    }
    if (typeof route.conversationId !== 'string' || route.conversationId.trim() === '') {
      throw new Error('企微主动交付缺少 conversationId');
    }
    const client = this.client;
    if (!client) throw new Error('WecomBotChannel 尚未启动,无法主动交付');

    const rich = typeof reply === 'string' ? { text: reply } : reply;
    if (rich.image) {
      throw new Error('企微独立主动交付当前只支持文字与文件');
    }

    const parts: DeliveryPartReceipt[] = [];
    const receipt = (): DeliveryReceipt => ({ route: { ...route }, parts: [...parts] });
    if ((rich.files?.length ?? 0) > 0 && typeof client.sendMediaMessage !== 'function') {
      throw new WecomChannelDeliveryError(
        route,
        { kind: 'file', index: 0, stage: 'send' },
        receipt(),
        new Error('SDK 客户端未提供 sendMediaMessage'),
      );
    }
    const text = rich.text;
    if (typeof text === 'string' && text !== '') {
      const bounded = truncateReply(text);
      if (bounded.truncated) {
        console.warn(JSON.stringify({
          event: 'wecom_reply_truncated',
          frame: 'proactive',
          bytes: Buffer.byteLength(text, 'utf8'),
          limit: MAX_REPLY_BYTES,
        }));
      }
      try {
        await client.sendMessage(route.conversationId, {
          msgtype: 'markdown',
          markdown: { content: bounded.text },
        });
      } catch (error) {
        throw new WecomChannelDeliveryError(
          route,
          { kind: 'text', index: 0, stage: 'send' },
          receipt(),
          error,
        );
      }
      parts.push({ kind: 'text', index: 0, status: 'sent' });
    }

    for (const [index, file] of (rich.files ?? []).entries()) {
      let mediaId: string;
      try {
        const uploaded = await client.uploadMedia(file.data, { type: 'file', filename: file.filename });
        mediaId = uploaded.media_id;
      } catch (error) {
        throw new WecomChannelDeliveryError(
          route,
          { kind: 'file', index, stage: 'upload' },
          receipt(),
          error,
        );
      }
      try {
        if (!client.sendMediaMessage) throw new Error('SDK 客户端未提供 sendMediaMessage');
        await client.sendMediaMessage(route.conversationId, 'file', mediaId);
      } catch (error) {
        throw new WecomChannelDeliveryError(
          route,
          { kind: 'file', index, stage: 'send' },
          receipt(),
          error,
        );
      }
      parts.push({ kind: 'file', index, status: 'sent' });
    }

    return receipt();
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

    // 单聊 conversationId 就是 userid，群聊则是 chatid；它也是宿主附件池使用的会话键。
    const conversationId = chatid ?? userid;
    const attachmentOnly = typeof content !== 'string' || content.trim() === '';
    const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : randomUUID();
    const streamId = randomUUID();
    // 不先发「收到,正在处理…」受理帧（owner 2026-11-19：这张卡片没用——用户要么马上拿到
    // 结果，要么稍后由终帧/回执说话）。流从终帧开始；终帧被拒仍走 reply() 的降级
    // （sendMessage 全新消息），所以「首帧即终帧」不会变成静默。附件-only 仍不起流，
    // 收据由并窗承载。
    let attachments: { saved: IncomingAttachment[]; failed: string[] };
    let finishAttachmentProcessing: (() => void) | undefined;
    if (msgtype === 'file') {
      // 先登记再 await：正文事件可能在本次 downloadFile 尚未完成时同步到达。pending 要
      // 持续到下面的 handler 已经暂存附件并排好收据，不能只覆盖 bytes 下载阶段。
      const download = this.saveAttachments(body, client);
      let resolveProcessing!: () => void;
      const pending = new Promise<void>((resolve) => { resolveProcessing = resolve; });
      let finished = false;
      finishAttachmentProcessing = () => {
        if (finished) return;
        finished = true;
        this.untrackAttachmentProcessing(conversationId, pending);
        resolveProcessing();
      };
      this.trackAttachmentProcessing(conversationId, pending);
      try {
        attachments = await download;
      } catch (error) {
        finishAttachmentProcessing();
        throw error;
      }
      // stop() 或重启期间完成的旧事件不能再入窗、更不能交给旧 handler。
      if (!this.started || this.handler !== handler || this.client !== client) {
        finishAttachmentProcessing();
        return;
      }
      // 文字先到（同会话已有正文在等这批在途附件）时保持旧路径：附件逐条交给 handler，
      // 正文的 8 秒等待与它看到的消息顺序不变（ATTACHMENT_WAIT_TIMEOUT_MS 语义）。
      // 否则先入合并窗口——窗口内来的文字会与本条附件合成同一个回合。
      const textWaiting = (this.attachmentWaiters.get(conversationId) ?? 0) > 0;
      if (!textWaiting || this.pendingMerges.has(conversationId)) {
        const flushNow = this.bufferMergeFile({
          conversationId,
          frame,
          streamId,
          msgid,
          userid,
          chatType,
          saved: attachments.saved,
          failed: attachments.failed,
          bytes: attachments.saved.reduce((sum, file) => sum + file.bytes, 0),
        });
        finishAttachmentProcessing();
        if (flushNow) void this.flushMergeWindow(conversationId);
        return;
      }
    } else {
      const waitResult = await this.waitForAttachmentProcessing(conversationId);
      if (waitResult !== 'ready') {
        // 停机期间不再向旧客户端发送任何帧；下载超时也不能把缺附件的正文交给 worker。
        if (waitResult === 'stopped' || !this.started || this.handler !== handler || this.client !== client) return;
        const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : randomUUID();
        await this.reply(
          frame,
          reqId,
          streamId,
          ATTACHMENT_WAIT_TIMEOUT_REPLY,
          true,
          // 缺陷 B：这条的降级推送同样带原话引用（要回的就是本条消息）。
          { chatId: conversationId, once: { used: false }, quoteText: content },
        );
        return;
      }
      attachments = await this.saveAttachments(body, client);
    }
    // stop() 或重启期间完成的旧事件不能再交给旧 handler。
    if (!this.started || this.handler !== handler || this.client !== client) {
      finishAttachmentProcessing?.();
      return;
    }
    // 窗口内来的文字把待合并附件一并吸收进本回合：一次 handler 调用，载荷 = 文字 + 全部
    // 附件。附件-only（mixed 无文字）不吸收——没有指令，窗口继续按自己的时钟走。
    if (msgtype !== 'file' && !attachmentOnly) {
      const merge = this.takePendingMerge(conversationId);
      if (merge !== undefined) {
        for (const file of merge.files) {
          attachments.saved.push(...file.saved);
          attachments.failed.push(...file.failed);
        }
      }
    }
    // 等待在途附件完成后再撤收据；否则文件 dispatch 可能随后才把收据排进并窗，造成重复。
    if (!attachmentOnly) this.dropPendingReceipt(conversationId);
    // 附件下载失败不能让整条消息消失：降级成"附件没拿到"的文字说明，用户至少知道
    // 该补什么，而不是等一个永远不来的回复。
    const parts: string[] = [];
    if (typeof content === 'string' && content.trim() !== '') parts.push(content);
    for (const failed of attachments.failed) parts.push(`[附件下载失败:${failed}]`);
    for (const ok of attachments.saved) parts.push(`[附件:${ok.filename}]`);
    if (parts.length === 0) {
      finishAttachmentProcessing?.();
      return;
    }
    const messageReference = extractMessageReference(body['quote']);
    const message: IncomingChannelMessage = {
      wecomUserId: userid,
      // 渠道身份在源头显式给出：宿主据此拼 principalId/sessionId 的前缀（见契约的 channel
      // 字段）。缺省也是 'wecom'，但写在来源处比让宿主猜更诚实——接入第二个客户端时，
      // 每个适配器各自报自己的名字，前缀从此不挤在同一套审计行里。
      channel: 'wecom',
      conversationId,
      messageId: msgid,
      chatType,
      text: chatType === 'group' ? stripMentionPrefix(parts.join('\n')) : parts.join('\n'),
      ...(messageReference ? { messageReference } : {}),
      ...(attachments.saved.length > 0 ? { attachments: attachments.saved } : {}),
      // 附件-only：本条没有用户正文（file 消息，或 mixed 里取不到任何文字项）。
      // 宿主据此只暂存附件、不启 Agent 回合——否则"先发文件再发指令"会变成 N 次 LLM 调用，
      // 并且串行堵住会话队列，把真正带指令的那条挡在后面。
      ...(attachmentOnly ? { attachmentOnly: true } : {}),
      receivedAt: new Date().toISOString(),
    };

    await this.runTurn({
      frame,
      reqId,
      streamId,
      conversationId,
      message,
      handler,
      client,
      // 让正文等待到附件已经进入宿主暂存池/收据队列，再撤掉挂起收据并进入自己的 handler。
      // 回调点与旧路径一致：收据排队之后、回复文件/图片上传之前。
      afterHandler: finishAttachmentProcessing,
    });
  }

  /**
   * 跑一个回合：调用 handler，按结果发终帧/文件/图片；附件-only 无话可说时排收据。
   *
   * 正常消息路径与合并窗口 flush 共用同一份出站纪律（截断、降级 latch、进度预算、
   * 收据并窗），避免两条入口各自漂移。
   */
  private async runTurn(turn: {
    frame: SdkFrame;
    reqId: string;
    streamId: string;
    conversationId: string;
    message: IncomingChannelMessage;
    handler: ReplyHandler;
    client: SdkClientLike;
    /** 回复已定型（终帧/收据已排队）时回调：供正文等待在途附件的旧路径撤 pending。 */
    afterHandler?: () => void;
  }): Promise<void> {
    const { frame, reqId, streamId, conversationId, message, handler, client } = turn;
    const msgid = message.messageId;
    // 降级防重（"失败必达"路径 2）：同一次回复最多降级一次——终帧被拒后改走
    // sendMessage 全新消息通道。latch 按消息派发（每条用户消息一次），同一终稿不会
    // 因多次失败被重复轰炸。
    const degradeOnce = { used: false };
    let lastProgressAt = 0;
    let progressCount = 0;
    // 受理帧豁免（首帧提速，2026-10-16）：本流的**第一帧** progress 是宿主在回合真正
    // 开跑时发的「开始处理你的请求」——确定性回执、恰好一帧、永不重复（不构成 churn），
    // 因此不占 4 帧进度硬顶，真实进度帧的预算保持 4 帧不缩水。豁免按"第一帧"判定而
    // 不是按文案：宿主文案不是本层的契约，按内容嗅探会把两层耦死。宿主若哪天不发受理
    // 帧，代价只是第一帧真实进度多占一个免费名额——有界、无害。
    let firstProgressFrame = true;
    const progress: ProgressFn = (text) => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
      lastProgressAt = now;
      const acceptance = firstProgressFrame;
      firstProgressFrame = false;
      if (!acceptance) {
        if (progressCount >= MAX_PROGRESS_FRAMES) return;
        progressCount += 1;
      }
      void this.reply(frame, reqId, streamId, text, false);
    };
    const notice: NoticeFn = async (text) => {
      try {
        // 计划通知是三个出口里最可能超长的一个：平台 noticeText 由账套/期间/客户/科目
        // 多个集合 join 而成、无条数上限（平台 plan.js 的 scope 摘要）。与最终回复同一
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
      // 终帧失败可降级（degrade 参数）：流式更新被企微拒收（历史事故 errcode 846608——
      // 流式回复超过 10 分钟更新窗口，终帧被拒后用户端永远停在旧进度帧，整轮静默）时，
      // 改用 sendMessage 全新消息通道把终稿送达。中间进度帧不降级（降级是给"答案"的，
      // 不是给中间帧的，否则每次拒收都是一条新消息）。降级推送带原话引用（缺陷 B：
      // 新消息丢话题归属——quoteText = 本回合用户原话，只在降级路径用）。
      void this.reply(frame, reqId, streamId, bounded.text, true, { chatId: conversationId, once: degradeOnce, quoteText: message.text });
    } else if (message.attachmentOnly && message.attachments && message.attachments.length > 0) {
      // 宿主对这条附件-only 消息无话可说（正常路径）：文件名并进本会话的收据窗，到点合成
      // 一条。例外路径（暂存超限、指令跑完后才到的文件）宿主会返回文本，走上面的终帧分支，
      // 当即告知——那两条是用户必须知道的事，不能等窗口。
      this.queuePendingReceipt(conversationId, frame, streamId, message.attachments);
    }
    // 旧路径的时机锚点：收据已排队、回复内容已定型；文件/图片回传不阻塞正文等待。
    turn.afterHandler?.();
    // 文件回传（2026-10-08 单数 → 2026-10-20 W3 数组）：worker 在平台 tmp/ 下产出的
    // xlsx 等，经临时素材上传回传。一次任务多个交付物是常态（如工资表 + 个税申报表），
    // 逐条发送、每条独立消息。单个文件失败只记事件不外抛——文本已经发出去了，不该因为
    // 一个附件上传失败把整轮回复搞成失败，也不该挡住同轮其余文件。
    for (const file of rich.files ?? []) {
      try {
        const uploaded = await client.uploadMedia(file.data, { type: 'file', filename: file.filename });
        await client.replyMedia(frame, 'file', uploaded.media_id);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'wecom_file_fail',
          req_id: reqId,
          filename: file.filename,
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
          void this.reply(frame, reqId, streamId, IMAGE_FAIL_REPLY, true, { chatId: conversationId, once: degradeOnce, quoteText: message.text });
        }
      }
    }
  }

  private trackAttachmentProcessing(conversationId: string, pending: Promise<void>): void {
    const downloads = this.pendingAttachmentProcessing.get(conversationId) ?? new Set<Promise<void>>();
    downloads.add(pending);
    this.pendingAttachmentProcessing.set(conversationId, downloads);
  }

  private untrackAttachmentProcessing(conversationId: string, pending: Promise<void>): void {
    const downloads = this.pendingAttachmentProcessing.get(conversationId);
    if (!downloads) return;
    downloads.delete(pending);
    if (downloads.size === 0) this.pendingAttachmentProcessing.delete(conversationId);
  }

  private async waitForAttachmentProcessing(conversationId: string): Promise<'ready' | 'timeout' | 'stopped'> {
    // 记在途等待者：纯附件消息据此判断"文字先到"还是"文件先到"——文字先到时沿用旧的
    // 逐条交付（8 秒等待语义不变），否则才进合并窗口。
    this.attachmentWaiters.set(conversationId, (this.attachmentWaiters.get(conversationId) ?? 0) + 1);
    try {
      // 总上界从正文首次等待开始计算；新文件在上一批将结束时登记，也不能续钟。
      const deadline = Date.now() + ATTACHMENT_WAIT_TIMEOUT_MS;
      while (true) {
        const downloads = this.pendingAttachmentProcessing.get(conversationId);
        if (!downloads || downloads.size === 0) return 'ready';
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 'timeout';
        const interrupt = this.attachmentWaitInterrupt;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        });
        const result = await Promise.race([
          Promise.all([...downloads]).then(() => 'ready' as const),
          timeout,
          interrupt.then(() => 'stopped' as const),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (result !== 'ready') return result;
      }
    } finally {
      const remaining = (this.attachmentWaiters.get(conversationId) ?? 1) - 1;
      if (remaining > 0) this.attachmentWaiters.set(conversationId, remaining);
      else this.attachmentWaiters.delete(conversationId);
    }
  }

  private resetAttachmentWaitInterrupt(): void {
    this.attachmentWaitInterrupt = new Promise<void>((resolve) => {
      this.resolveAttachmentWaitInterrupt = resolve;
    });
  }

  /**
   * 把一条已下载完的纯附件消息放进本会话的合并窗口；返回是否**立即** flush
   * （到界/零窗口，不再等定时器）。
   *
   * 续期纪律：每来一个新附件就把定时器重排到 min(now + 窗口, 起点 + 总上限)——窗口
   * 跟着"最后一个文件"走，但不会无限后移。返回 true 时由调用方立刻 flush，此时窗口状态
   * 仍在本表里（take 时会撤掉旧定时器）。
   */
  private bufferMergeFile(file: PendingMergeFile): boolean {
    const now = Date.now();
    const conversationId = file.conversationId;
    let merge = this.pendingMerges.get(conversationId);
    if (merge === undefined) {
      merge = {
        files: [],
        totalBytes: 0,
        deadline: now + this.mergeWindowMaxMs,
        timer: undefined,
      };
      this.pendingMerges.set(conversationId, merge);
    }
    merge.files.push(file);
    merge.totalBytes += file.bytes;
    const bounded = merge.files.length > ATTACHMENT_MERGE_MAX_FILES
      || merge.totalBytes > ATTACHMENT_MERGE_MAX_BYTES;
    const due = Math.min(now + this.mergeWindowMs, merge.deadline);
    if (bounded || due <= now) return true;
    if (merge.timer !== undefined) clearTimeout(merge.timer);
    merge.timer = setTimeout(() => { void this.flushMergeWindow(conversationId); }, due - now);
    return false;
  }

  /** 取走并撤掉本会话的合并窗口（定时器一并清掉）。 */
  private takePendingMerge(conversationId: string): PendingMerge | undefined {
    const merge = this.pendingMerges.get(conversationId);
    if (merge === undefined) return undefined;
    this.pendingMerges.delete(conversationId);
    if (merge.timer !== undefined) clearTimeout(merge.timer);
    return merge;
  }

  /** 撤掉合并窗口（停机）：不发帧、只清状态与定时器。 */
  private dropPendingMerge(conversationId: string): void {
    this.takePendingMerge(conversationId);
  }

  /**
   * 窗口到点仍无文字：把窗口里累积的附件按**一次**纯附件回合交付（与逐条交付的既有
   * 形态一致：宿主只暂存、不启模型回合；无话可说时由收据并窗补一条）。
   *
   * 通道挂在最后到达的文件消息上：时间上最接近用户所见，且这些消息都没起过流。
   */
  private async flushMergeWindow(conversationId: string): Promise<void> {
    const merge = this.takePendingMerge(conversationId);
    if (merge === undefined) return;
    const handler = this.handler;
    const client = this.client;
    if (!this.started || handler === null || client === null) return;
    const last = merge.files[merge.files.length - 1];
    if (last === undefined) return;

    const saved: IncomingAttachment[] = [];
    const failed: string[] = [];
    for (const file of merge.files) {
      saved.push(...file.saved);
      failed.push(...file.failed);
    }
    const parts: string[] = [];
    for (const name of failed) parts.push(`[附件下载失败:${name}]`);
    for (const file of saved) parts.push(`[附件:${file.filename}]`);
    if (parts.length === 0) return;

    const message: IncomingChannelMessage = {
      wecomUserId: last.userid,
      channel: 'wecom',
      conversationId,
      messageId: last.msgid,
      chatType: last.chatType,
      text: last.chatType === 'group' ? stripMentionPrefix(parts.join('\n')) : parts.join('\n'),
      ...(saved.length > 0 ? { attachments: saved } : {}),
      // 窗口里没有用户正文（有文字就已被文字回合吸收了）：与逐条附件消息同一语义。
      attachmentOnly: true,
      receivedAt: new Date().toISOString(),
    };

    await this.runTurn({
      frame: last.frame,
      reqId: typeof last.frame.headers?.req_id === 'string' ? last.frame.headers.req_id : '',
      streamId: last.streamId,
      conversationId,
      message,
      handler,
      client,
    });
  }

  /**
   * 把一条附件-only 消息的文件名并进本会话的收据窗（窗已在跑则只追加 + 换通道）。
   *
   * 通道为什么换成最新那条：收据要挂在"最后到达的文件"之后，用户读起来才连贯；窗内早到
   * 的消息都没有起过流，不存在"旧消息被改写"的问题。只换 frame/streamId，req_id 从
   * frame 上取（reply() 内部就是这么用的），不另存一份——同一事实两个落点迟早漂移。
   */
  private queuePendingReceipt(
    conversationId: string,
    frame: SdkFrame,
    streamId: string,
    attachments: readonly IncomingAttachment[],
  ): void {
    const filenames = attachments.map((file) => file.filename);
    const existing = this.pendingReceipts.get(conversationId);
    if (existing) {
      existing.filenames.push(...filenames);
      existing.frame = frame;
      existing.streamId = streamId;
      return;
    }
    this.pendingReceipts.set(conversationId, {
      filenames,
      frame,
      streamId,
      chatId: conversationId,
      timer: setTimeout(() => { void this.flushPendingReceipt(conversationId); }, RECEIPT_COALESCE_MS),
    });
  }

  /** 撤掉挂起的收据（带正文的消息到达 / 停机）：不发送，只清状态与定时器。 */
  private dropPendingReceipt(conversationId: string): void {
    const pending = this.pendingReceipts.get(conversationId);
    if (!pending) return;
    this.pendingReceipts.delete(conversationId);
    clearTimeout(pending.timer);
  }

  /**
   * 并窗到点：把累积的文件名合成一条收据，以 finish=true 收尾。
   *
   * 走 degrade：这一帧是它所在流的首帧，发不出去的话那条流会永远开着——客户端表现是
   * 文件消息底下一个转不停的 spinner（与"没有流"是两回事，这里流是我们自己开的）。
   */
  private async flushPendingReceipt(conversationId: string): Promise<void> {
    const pending = this.pendingReceipts.get(conversationId);
    if (!pending) return;
    this.pendingReceipts.delete(conversationId);
    clearTimeout(pending.timer);
    await this.reply(
      pending.frame,
      pending.frame.headers?.req_id ?? '',
      pending.streamId,
      formatFileAck(pending.filenames),
      true,
      { chatId: pending.chatId, once: { used: false } },
    );
  }

  private reply(
    frame: SdkFrame,
    reqId: string,
    streamId: string,
    content: string,
    finish: boolean,
    degrade?: ReplyDegrade,
  ): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    return client
      .replyStream(frame, streamId, content, finish)
      .then(async () => undefined)
      .catch(async (error: unknown) => {
        console.error(JSON.stringify({
          event: 'wecom_reply_fail',
          req_id: reqId,
          finish,
          error: error instanceof Error ? error.message : String(error),
        }));
        // "失败必达"路径 2：终帧（finish=true）被企微拒收时，流式更新通道对这条回复已经
        // 死了（历史事故 errcode 846608：流式回复超 10 分钟更新窗口，终帧被拒，用户端
        // 永远停在旧进度帧）。降级为 sendMessage 发一条**全新消息**（aibot_send_msg 主动
        // 推送通道，不走流式更新），把终稿送达。防重：同一次回复只降级一次——中间帧
        // 失败不降级（调用点不传 degrade）、终帧重复失败也不重复发（once latch）。
        // 降级再失败只记事件：两条通道都不可达时已无第三条路，日志是唯一的守夜人。
        if (finish && degrade && !degrade.once.used) {
          degrade.once.used = true;
          // 缺陷 B（2026-11-21 live）：只在降级路径（新消息推送）加原话引用行——回复上下文
          // 过期后这条会被客户端排到最新消息下面，读起来像答非所问；引用行让它自含话题。
          // 正常 reply 路径（replyStream）逐字节不变。原话取不到 = 不加引用（不编造）。
          const degradeContent = degrade.quoteText === undefined
            ? content
            : withReplyQuote(degrade.quoteText, content);
          try {
            await client.sendMessage(degrade.chatId, { msgtype: 'markdown', markdown: { content: degradeContent } });
            console.info(JSON.stringify({
              event: 'wecom_reply_degraded',
              req_id: reqId,
              channel: 'send_message',
              bytes: Buffer.byteLength(degradeContent, 'utf8'),
              quoted: degrade.quoteText !== undefined,
              originError: error instanceof Error ? error.message.slice(0, 200) : String(error),
            }));
          } catch (degradeError: unknown) {
            console.error(JSON.stringify({
              event: 'wecom_reply_degrade_fail',
              req_id: reqId,
              error: degradeError instanceof Error ? degradeError.message : String(degradeError),
              content: degradeContent,
            }));
          }
        }
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

/** 窗口参数归一：合法非负数原样用（0 = 立即 flush），非法/缺失回落缺省。 */
function normalizeWindowMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function defaultClientFactory(env: Record<string, string | undefined>): () => SdkClientLike {
  return () => {
    // 长连接由官方 SDK 管理:认证、心跳、指数退避重连(不限次数,服务型进程要求常连)
    // 心跳从默认 30s 缩到 15s:企微约 90s 无心跳即断开;官方社区对「连接看似正常仍偶发丢消息」的缓解手段就是把 30s 缩到 15s
    return new WSClient({
      botId: (env['WECOM_BOT_ID'] ?? '').trim(),
      secret: (env['WECOM_BOT_SECRET'] ?? '').trim(),
      maxReconnectAttempts: -1,
      heartbeatInterval: 15000,
    }) as unknown as SdkClientLike;
  };
}
