/** Trusted channel context and the narrow Main Agent runtime contract. */
import type { ChannelRoute, IncomingAttachment, IncomingMessageReference, NoticeFn } from './channel';
import type { BackgroundTaskEvent } from './store';

/** Host-normalized context for the current message, separate from trusted identity and body text. */
export interface TurnInputContext {
  messageReference?: IncomingMessageReference;
}

/** Request-level facts supplied by the application, never by either model. */
export interface TrustedContext {
  /** Host-selected immutable input set for this task; never re-read a later session pool. */
  inputFiles?: readonly IncomingAttachment[];
  /** Host-created background invocation identity; not a model-supplied task selector. */
  backgroundRunId?: string;
  requestId: string;
  /** wecom:<userid> */
  principalId: string;
  sessionId: string;
  /**
   * Effective capabilities of the principal（缺省视为只读）。**遗留数据位，无执法消费者**：
   * 2026-11-08 架构裁定后"写能不能真落地"完全归执行层——编排层不判这个部署允不允许写，
   * 也就不再读任何主体/部署侧的能力布尔。字段保留只为既有存储与配置形状的兼容
   * （config/agent.yaml 的 principals[].capabilities 仍是合法配置键），新代码不得给它
   * 新的消费者；执行层的放行/拒绝/warning 由执行层自己的门给出并如实转述。
   */
  capabilities?: readonly string[];
  onStep?: (text: string) => void;
  /** 可等待的用户通知；计划需告知用户时必须等待送达再继续执行。 */
  onNotice?: NoticeFn;
  /** Proactive background notification sender, independent of any inbound message frame. */
  onBackgroundNotice?: NoticeFn;
  /** Host-validated delivery route; never supplied by a model. */
  deliveryRoute?: ChannelRoute;
  /** Host persistence hook for a platform plan awaiting real user confirmation. */
  onPlanPending?: (pending: PendingPlanConfirmationContext) => Promise<void>;
  /** Host-set continuation handle after a durable plan confirmation matched. */
  resumeTaskId?: string;
}

export interface PendingPlanConfirmationContext {
  planId: string;
  version: number;
  taskId: string;
  principalId: string;
  sessionId: string;
  requestId: string;
  userText: string;
}

/** Model-visible tool definition. */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentReply {
  text: string;
  /**
   * 宿主要求随回复附发的会话产物 ref 列表（W4 重发路由）。
   *
   * runtime 的 resend 分支只做路由（不委派、不判断产物存在性）；handler 依会话
   * 产物库把这些 ref 解析成文件字节挂到回复上，并合成确定性文本（存在/淘汰/
   * 字节丢失各有确定回答，不编）。为空/缺省 = 纯文本回复。
   */
  artifactRefs?: readonly string[];
}

export interface AgentRuntime {
  handleTurn(ctx: TrustedContext, userMessage: string, inputContext?: TurnInputContext): Promise<AgentReply>;
  /** Internal entry for a completed background Worker event, never a synthetic user message. */
  handleTaskEvent?(ctx: TrustedContext, event: BackgroundTaskEvent): Promise<AgentReply | null>;
}
