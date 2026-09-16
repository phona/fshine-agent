/**
 * host ↔ agent runtime 的接口(架构 §2/§4)。
 * runtime 在 adapter 后面,Pi 可被替换而不影响 host 与 17dz 契约。
 */
import type { EnvelopeMeta } from './envelope';
import type { McpError } from './envelope';
import type { ReadToolName } from './tools';

/** 请求级可信执行上下文。字段一律由 host 从配置与渠道事实生成,LLM 永不参与。 */
export interface TrustedContext {
  requestId: string;
  /** wecom:<userid> */
  principalId: string;
  /** 调用者被授权的账套稳定 id;host 在每次工具调用前据此预检 */
  allowedAccountSetIds: readonly string[];
  sessionId: string;
  /** 阶段进度回调(埋点事实渲染,非模型自由文本);渠道侧节流并转成进度帧 */
  onStep?: (text: string) => void;
}

/** tools/list 发现的单个工具(inputSchema 为完整、自包含的 JSON Schema)。 */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolOutcome =
  | { ok: true; data: unknown; meta: EnvelopeMeta }
  | { ok: false; error: McpError; meta?: EnvelopeMeta };

/**
 * host 提供给 runtime 的唯一工具入口。
 * scope 预检(accountSetId ∈ ctx 允许集)、信封解析、结果裁剪、审计记录全部由 host 在此内部强制;
 * runtime 拿到的是裁剪后的结果,拿不到原始 MCP JSON。
 */
export interface HostToolClient {
  tools(): readonly DiscoveredTool[];
  call(tool: ReadToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
}

/** V0 回复纯文本;渠道侧负责长度截断。 */
export interface AgentReply {
  text: string;
}

export interface AgentRuntime {
  handleTurn(
    ctx: TrustedContext,
    userMessage: string,
    tools: HostToolClient,
  ): Promise<AgentReply>;
}
