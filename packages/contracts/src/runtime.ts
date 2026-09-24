/** Trusted channel context and the narrow Main Agent runtime contract. */
import type { NoticeFn } from './channel';

/** Request-level facts supplied by the application, never by either model. */
export interface TrustedContext {
  requestId: string;
  /** wecom:<userid> */
  principalId: string;
  /** Retained for domain authorization; models must not change this scope. */
  allowedAccountSetIds: readonly string[];
  sessionId: string;
  /** Effective capabilities of the principal（写开放按此裁决；缺省视为只读）。 */
  capabilities?: readonly string[];
  onStep?: (text: string) => void;
  /** 可等待的用户通知；计划需告知用户时必须等待送达再继续执行。 */
  onNotice?: NoticeFn;
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
}

export interface AgentRuntime {
  handleTurn(ctx: TrustedContext, userMessage: string): Promise<AgentReply>;
}
