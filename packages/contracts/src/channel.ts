/**
 * 渠道适配接口(架构 §2:WeCom adapter)。
 * V0:回调验签 + 快速 ack + 主动推送;同步语义的 75s 预算由 host 侧预算控制,不在本层。
 */

/**
 * 渠道传来的附件（已由渠道层落盘）。
 *
 * 为什么契约里只放**路径**不放 Buffer：宿主与 worker 跨进程，附件要进 worker 的决策
 * 上下文只能以路径形式出现在请求文本里（worker 再把它作为 operation 的位置参数传给
 * 执行层）。Buffer 进不了上下文，也没有第二个消费者。
 *
 * **adapter 的义务（2026-10-20 显式化）**：把渠道上的文件**落到宿主可见的本地位置**，
 * 契约里只出现本地绝对路径——不是 URL、不是对象存储 key、不是临时素材 id。企微的素材
 * 要用 aeskey 解密下载，web/小程序客户端大概会把文件放在对象存储里：那时也是 adapter
 * 先下载到同一个附件目录，契约一个字不用改。反过来，谁若让 worker 直接读签名 URL，
 * 裂开的是这条契约（宿主的实体门按"路径在本轮请求文本里"执法，URL 不在那个面上），
 * 而且文件会在签名过期后静默失效。locality 由 e2e AT-1 钉住。
 */
export interface IncomingAttachment {
  /** 落盘后的文件名（已 basename 化，不含路径分隔符） */
  filename: string;
  /** 落盘后的绝对路径；宿主与 worker 按这个路径引用同一份文件 */
  path: string;
  /** 字节数；超限附件不会出现在这里（渠道层直接拒收） */
  bytes: number;
}

/**
 * 文件收据里最多列几个文件名（再多用"等"收尾）。
 *
 * 为什么截断：一条企微 file 消息带 8 个文件是常见形状（暂存上限就是 8），全列会把
 * 收据撑成一屏；而收据的作用是"我知道你发了什么、发对了没有"，前 3 个名 + 总数
 * 足以让用户判断，真要全量可以回会话里翻。
 */
export const FILE_RECEIPT_NAME_LIMIT = 3;

/**
 * 文件收据文案：**宿主回合首帧与渠道孤儿收据共用同一句**，所以住在这里而不是各写一份。
 *
 * 为什么必须一个权威位置：同一句"你发了哪些文件"会在两个地方出现——① 带指令的回合
 * 首帧（handler 的规则二披露，告诉用户"这轮我用这些文件"，假设错时用户几秒内能纠正）；
 * ② 只发文件、迟迟没有指令时渠道补的那条（告诉用户"文件我收下了，在等你的指令"）。
 * 两处各写一份措辞，迟早漂移成一桩"同一个事实两种说法"的交互债。
 *
 * 去重按文件名：同名文件（不同路径）在清单里出现两行没有信息量。计数按去重后的个数，
 * 与暂存池的"保留最新 N 个"无关——这里只说用户看见了什么。
 */
export function formatFileReceipt(filenames: readonly string[]): string {
  const unique = [...new Set(filenames)];
  const listed = unique.slice(0, FILE_RECEIPT_NAME_LIMIT);
  const rest = unique.length - listed.length;
  return `已收到 ${unique.length} 个文件：${listed.join('、')}${rest > 0 ? ' 等' : ''}`;
}

export interface IncomingChannelMessage {
  /**
   * 渠道原生用户标识（当前唯一接入的渠道是企微，故字段名带 wecom）。
   *
   * 字段名**故意不改**（2026-10-20）：改它要动 65 处零行为变化的调用点，而 PoC 阶段只有
   * 一个渠道，那是纯 churn。真正进持久化的是下面的 `channel` + 这个 id 拼出的 principalId，
   * 那条缝已经留好——接入第二个客户端时同批改字段名，别提前付这笔钱。
   */
  wecomUserId: string;
  /**
   * 渠道身份（缺省 `wecom`）：principalId / sessionId 的前缀段。
   *
   * 为什么参数化：`wecom:` 前缀会进审计表、conversation log 与 principal_scopes 的键——
   * 等 web/小程序客户端接入再统一，就是数据迁移或永久双读。所以前缀从消息上取，宿主不认
   * 渠道名只认这个字段；适配器报"我是哪个渠道 + 这个渠道里的谁"，身份归属仍是宿主的事
   * （AGENTS.md：身份与授权归 fshine）。
   */
  channel?: string;
  /** 渠道会话标识;单聊可用 userid 推导 */
  conversationId: string;
  /** 渠道消息 id,用于幂等与审计关联 */
  messageId: string;
  /** 单聊 / 群聊(群聊时 text 已剥离 @机器人 前缀) */
  chatType?: 'single' | 'group';
  text: string;
  /**
   * 本条消息携带的附件（企微 file 消息）。
   *
   * 2026-10-07 之前没有这个字段，渠道层只放行 `msgtype === 'text'`，用户发的 Excel
   * 连下载都没有——"帮我做工资表"这类请求永远拿不到上游数据，而下游执行层（17dz
   * 薪酬域）恰恰要求先吸收多份 Excel 才能产出 PayrollContract。
   */
  attachments?: readonly IncomingAttachment[];
  /**
   * 本条消息**只有附件、没有用户正文**（企微 file 消息）。
   *
   * 为什么宿主需要这个标志：用户的自然用法是"先发文件，再发指令"。若每条文件消息都启一个
   * Agent 回合，N 个文件就是 N 次 LLM 调用，而且它们会串行堵住会话队列——真正带指令的那条
   * 排在后面出不来（2026-10-07 实测：发 3 个文件 + 1 条指令，只见 4 个 ack、0 个最终回复，
   * 第一条文件回合卡在 LLM 上 10 分钟预算内不返回）。
   * 所以附件-only 消息只暂存、不启回合；等带正文的那条到达，再把暂存的附件一起交给它。
   */
  attachmentOnly?: boolean;
  /** ISO 8601 */
  receivedAt: string;
}

/** 图片回复:原始数据经临时素材上传(WS 分片通道)换 media_id 后回传 */
export interface OutgoingImageReply {
  /** PNG / JPG 原始数据 */
  data: Buffer;
  filename?: string;
}

/** 文件回复:原始字节 + 文件名（企微临时素材上传换 media_id 后回传） */
export interface OutgoingFileReply {
  data: Buffer;
  filename: string;
}

/**
 * 渠道回复:纯文本,或文本 + 图片/文件组合。
 *
 * `file` 是 2026-10-08 补的最后一环：worker 在平台 tmp/ 下产出 xlsx（如工资表），
 * 此前渠道只会把它说成一段 markdown——12 人的工资表被塞进 20KB 文本上限里截断，
 * 用户既拿不到文件也看不完。SDK 的 uploadMedia/replyMedia 本就支持 file 类型。
 */
export interface RichChannelReply {
  text?: string;
  image?: OutgoingImageReply;
  file?: OutgoingFileReply;
}

export type ChannelReply = string | RichChannelReply;

/** 进度回调:adapter 提供(节流 + finish=false 流帧),handler/runtime 在阶段节点调用 */
export type ProgressFn = (text: string) => void;

/** 重要计划通知：发送完成后调用方才可继续执行；失败必须向调用方抛出。 */
export type NoticeFn = (text: string) => Promise<void>;

/** 处理消息并返回回复;adapter 负责上传图片、文本截断与推送 */
export type ReplyHandler = (
  message: IncomingChannelMessage,
  progress?: ProgressFn,
  notice?: NoticeFn,
) => Promise<ChannelReply>;

export interface ChannelAdapter {
  start(handler: ReplyHandler): Promise<void>;
  stop(): Promise<void>;
}
