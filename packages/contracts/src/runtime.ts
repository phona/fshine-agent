/** Trusted channel context and the narrow Main Agent runtime contract. */

/** Request-level facts supplied by the application, never by either model. */
export interface TrustedContext {
  requestId: string;
  /** wecom:<userid> */
  principalId: string;
  /** Retained for domain authorization; models must not change this scope. */
  allowedAccountSetIds: readonly string[];
  sessionId: string;
  onStep?: (text: string) => void;
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
