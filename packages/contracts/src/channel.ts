/**
 * 渠道适配接口(架构 §2:WeCom adapter)。
 * V0:回调验签 + 快速 ack + 主动推送;同步语义的 75s 预算由 host 侧预算控制,不在本层。
 */

export interface IncomingChannelMessage {
  /** 不可变的企微成员 UserID */
  wecomUserId: string;
  /** 渠道会话标识;单聊可用 userid 推导 */
  conversationId: string;
  /** 渠道消息 id,用于幂等与审计关联 */
  messageId: string;
  /** 单聊 / 群聊(群聊时 text 已剥离 @机器人 前缀) */
  chatType?: 'single' | 'group';
  text: string;
  /** ISO 8601 */
  receivedAt: string;
}

/** 图片回复:原始数据经临时素材上传(WS 分片通道)换 media_id 后回传 */
export interface OutgoingImageReply {
  /** PNG / JPG 原始数据 */
  data: Buffer;
  filename?: string;
}

/** 渠道回复:纯文本,或文本 + 图片组合 */
export interface RichChannelReply {
  text?: string;
  image?: OutgoingImageReply;
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
