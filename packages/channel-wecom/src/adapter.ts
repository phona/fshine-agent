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
import { formatFileReceipt } from '@fshine/contracts';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateReply } from './text';

const ACK_TEXT = '收到,正在处理…';
const FALLBACK_REPLY = '处理失败,请稍后再试';
const IMAGE_FAIL_REPLY = '图片发送失败,请稍后再试';
const START_TIMEOUT_MS = 30_000;
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

/** 终帧拒收降级的上下文：会话地址 + 本次回复的防重 latch（一次派发最多降级一条）。 */
interface ReplyDegrade {
  chatId: string;
  once: { used: boolean };
}

/**
 * 挂起的文件收据：一个会话在一个并窗里到达的所有附件-only 消息，共用一条收据。
 *
 * 为什么需要并窗（2026-10-19）：企微的流式回复按入站消息的 `req_id` 走——一条用户
 * 消息就是一个气泡，N 个文件必然是 N 条"已收到 X"，和随后指令回合的帧在会话里互相
 * 穿插。修法是**不为文件起气泡**：附件-only 消息连秒回 ack 都不发（"收到,正在处理…"
 * 对一条只暂存不处理的消息是假承诺，而且没有终帧来改写它），收据改由两处承载——
 * ① 带指令的回合首帧（宿主的规则二披露，与这里同一句措辞 formatFileReceipt）；
 * ② 只发文件、迟迟没有指令时，本类在窗口到点后补一条，否则用户对着静默的会话
 *    不知道文件到底收没收到。
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

export class WecomBotChannel implements ChannelAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory: () => SdkClientLike;
  private readonly attachmentDir: string;
  private readonly platformRoot: string;
  private started = false;
  private handler: ReplyHandler | null = null;
  private client: SdkClientLike | null = null;
  /** 按会话（conversationId）记挂起的文件收据；stop() 时整体清掉。 */
  private readonly pendingReceipts = new Map<string, PendingReceipt>();

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
    // 挂起的收据一并撤：窗口到点时要往企微发帧，停机后不该还有定时器挂着（会把测试
    // 收尾/进程退出拖住），也不该再往一个已断开的连接发东西。没收过的文件仍在暂存池里，
    // 下一条指令进来时由宿主的披露帧告知用户，信息不会丢。
    for (const key of [...this.pendingReceipts.keys()]) this.dropPendingReceipt(key);
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
    // 降级通道的会话地址（sendMessage 语义：单聊填 userid，群聊填 chatid——与
    // conversationId 同一取法）。提出来一处计算，消息对象与降级分支共认。
    const conversationId = chatid ?? userid;

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
      ...(attachments.saved.length > 0 ? { attachments: attachments.saved } : {}),
      // 附件-only：本条没有用户正文（file 消息，或 mixed 里取不到任何文字项）。
      // 宿主据此只暂存附件、不启 Agent 回合——否则"先发文件再发指令"会变成 N 次 LLM 调用，
      // 并且串行堵住会话队列，把真正带指令的那条挡在后面。
      ...(typeof content !== 'string' || content.trim() === '' ? { attachmentOnly: true } : {}),
      receivedAt: new Date().toISOString(),
    };

    const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : randomUUID();
    const streamId = randomUUID();
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

    // 秒回 ack:用户即时可见;最终答案以同 streamId 的 finish=true 帧整体替换。
    //
    // 附件-only 消息**不发 ack**（2026-10-19）：它不启回合，"正在处理"是假承诺，且正常
    // 路径下没有终帧来改写这句话——用户会看到一条永远转圈、永不收尾的"正在处理"。
    // 文件收据改由并窗承担（见 PendingReceipt / queuePendingReceipt）。起不起流由本层
    // 决定，与宿主返回什么无关：不起流就没有 spinner，也就不需要"必须非空才收尾"。
    if (!message.attachmentOnly) {
      // 带正文的消息到达即取消本会话挂起的收据：那条回合的首帧会带上同样的收据
      // （宿主的规则二披露），两条都说同一件事才是冗余。
      this.dropPendingReceipt(conversationId);
      void this.reply(frame, reqId, streamId, ACK_TEXT, false);
    }

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
      // 不是给中间帧的，否则每次拒收都是一条新消息）。
      void this.reply(frame, reqId, streamId, bounded.text, true, { chatId: conversationId, once: degradeOnce });
    } else if (message.attachmentOnly && message.attachments && message.attachments.length > 0) {
      // 宿主对这条附件-only 消息无话可说（正常路径）：文件名并进本会话的收据窗，到点合成
      // 一条。例外路径（暂存超限、指令跑完后才到的文件）宿主会返回文本，走上面的终帧分支，
      // 当即告知——那两条是用户必须知道的事，不能等窗口。
      this.queuePendingReceipt(conversationId, frame, streamId, message.attachments);
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
          void this.reply(frame, reqId, streamId, IMAGE_FAIL_REPLY, true, { chatId: conversationId, once: degradeOnce });
        }
      }
    }
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
      formatFileReceipt(pending.filenames),
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
          try {
            await client.sendMessage(degrade.chatId, { msgtype: 'markdown', markdown: { content } });
            console.info(JSON.stringify({
              event: 'wecom_reply_degraded',
              req_id: reqId,
              channel: 'send_message',
              bytes: Buffer.byteLength(content, 'utf8'),
              originError: error instanceof Error ? error.message.slice(0, 200) : String(error),
            }));
          } catch (degradeError: unknown) {
            console.error(JSON.stringify({
              event: 'wecom_reply_degrade_fail',
              req_id: reqId,
              error: degradeError instanceof Error ? degradeError.message : String(degradeError),
              content,
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
