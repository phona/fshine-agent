/**
 * TurnDriver:一次回合的模型驱动抽象。
 * 生产实现走 pi-agent-core + pi-ai(pi-driver.ts);测试用 ScriptedTurnDriver(本文件)。
 * 上下文模型:转录即状态——messages 是包含工具调用与结果的完整转录,回合结束时
 * driver 返回更新后的转录,由 runtime 持久化。不做任何投影或裁剪。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import type { PendingPlanConfirmation } from './plan-runtime';
import type { PlanEntitySources, TurnDeclaration } from './turn-contract';

/** 转录消息 = pi 原生 AgentMessage(JSON 可序列化,含工具调用与结果) */
export type DriverMessage = AgentMessage;

export interface TurnDriverInput {
  systemPrompt: string;
  /** host tools/list 发现的工具(含 inputSchema),driver 据此构造原生工具定义 */
  tools: readonly DiscoveredTool[];
  /** 完整转录:历史全部消息(不含本条新用户消息,由 runtime 在调用前 push) */
  messages: DriverMessage[];
  /** 阶段进度回调(埋点事实渲染 + 模型意图短语) */
  onStep: (text: string) => void;
  /** 执行工具:返回 data(原样进入转录);失败时抛出面向用户的安全话术 */
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** 回合绝对截止时间(Date.now() 基准),超时 driver 应中止并返回空文本 */
  deadline: number;
  /** Optional trusted cwd for a higher-level coding-agent driver. */
  cwd?: string;
  /** Optional skill roots mounted by the trusted context profile. */
  skillRoots?: readonly string[];
  /** Stable worker/session id used by a resumable driver. */
  sessionId?: string;
  /** 请求级关联 id（审计串查 fshine ↔ 平台门控记录用）。 */
  requestId?: string;
  /** Parent cancellation propagated into a delegated agent turn. */
  signal?: AbortSignal;
  /** Host-validated semantic scope for directly routed platform tasks. */
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>;
  /**
   * 领域无关的实体来源集合（架构 §2 第 9 条）：宿主注入，供驱动在校验提交的计划时
   * 做逐字包含判定。缺省表示宿主没有可注入的来源（如未经宿主演派的任务），
   * 驱动不做实体来源校验。
   */
  entitySources?: PlanEntitySources;
  /** 平台仓知识面规则（worker read/ls 白名单；缺省用 G1 内置）。 */
  knowledgePaths?: readonly string[];
  /** 平台仓敏感路径规则（worker 禁读；缺省用 G1 内置）。 */
  sensitivePaths?: readonly string[];
  /** Trusted host notice callback, awaited before any notify-required plan activates. */
  onNotice?: (text: string) => Promise<void>;
}

/**
 * 子 Agent 执行不了时的结构化线索（架构 §3 纠错环，roadmap Phase 5）。
 *
 * 两个来源，都必须是确定性的：
 *   1. 脚本化替身（离线 e2e）直接产出；
 *   2. 真实 worker 由驱动从「平台确定性拒绝原因」派生——RESULT 信封里的错误码、
 *      宿主计划拦截的原因原文。**禁止对 worker 自由文本做模糊匹配**：那是猜，不是事实。
 *
 * 宿主拿到它时不 terminate 整轮，而是把线索交还 Main Agent：能自己补的补（从 Log /
 * 检索证据 / 本轮平台响应取实体），不能补的转告用户，然后用 continueTaskId 重派原任务。
 */
export interface SubagentNeeds {
  /** 缺什么（领域无关的条目：来自平台错误码的主体词，或宿主拦截原因所指的对象）。 */
  missing: string[];
  /** 为什么做不了（确定性原因原文，不是自由文本猜测）。 */
  reason: string;
  /** 建议用户提供什么（可选）。 */
  suggestion?: string;
}

export interface TurnDriverResult {
  /** 最终给用户的回复文本;空字符串表示本次模型调用未产出可用回复 */
  text: string;
  /** 更新后的完整转录(含本回合全部消息),由 runtime 持久化 */
  messages: DriverMessage[];
  /** 执行面回执（worker 驱动专有）：本轮网关调用数/预算，供上层委派方感知重量 */
  footprint?: string;
  /** Platform plan pending for a host-side user confirmation flow. */
  pendingPlan?: PendingPlanConfirmation;
  /**
   * 子 Agent 执行不了时的结构化线索。有它表示这一轮缺信息、任务可续，
   * 宿主应把线索交还规划者而不是以失败收尾。
   */
  needs?: SubagentNeeds;
  /**
   * Host-verified proof that this turn really reached the platform: an activated plan plus at
   * least one executed call. Absent this, the host must not let the turn's text reach the user.
   */
  execution?: { planId: string; version: number; calls: number };
}

export interface TurnDriver {
  run(input: TurnDriverInput): Promise<TurnDriverResult>;
  /** 上下文压缩(SDK compact)。超阈值时替换旧消息为摘要+保留最近尾巴;未超限原样返回。
   *  force:true 跳过阈值判断强制压缩(会话过期软着陆用);失败时实现方应原样返回,不阻塞回合。 */
  compact?(messages: DriverMessage[], opts?: { force?: boolean }): Promise<DriverMessage[]>;
  /**
   * 服务端确定性回复(确认码直执等)合成原生 assistant 消息:必须带完整内部形状
   * (api/provider/model/usage/stopReason),否则该转录进入下一模型回合时
   * pi-ai 结算会内部报错(stopReason='error' 被静默吞掉,2026-09-20 实测)。
   * 未实现时 runtime 回退为简化形状(仅测试驱动可接受)。
   */
  synthesizeAssistant?(text: string): DriverMessage;
}

/** 工具失败的确定性终结错误:message 是面向用户的安全话术,直接作为最终回复(driver 不得再喂给模型) */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolUserError';
  }
}

export interface ScriptedTurnStep {
  /** 本次模型调用回放的原生工具调用(依次真实执行 exec) */
  toolCalls?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** 本次调用的回复文本(不回放工具调用时即最终答案) */
  text?: string;
}

/**
 * 脚本化驱动:消耗步骤直到某一步给出 text——中间步骤的 toolCalls 依次真实执行
 * (对齐生产中"模型连续调用工具"的行为);步骤耗尽仍未给出 text → 返回空。
 * exec 抛 ToolUserError 时,按生产语义将其 message 作为最终回复返回。
 */
export function ScriptedTurnDriver(steps: ScriptedTurnStep[]): TurnDriver {
  if (steps.length === 0) {
    throw new Error('ScriptedTurnDriver:步骤不能为空');
  }
  let cursor = 0;
  return {
    async run(input) {
      for (let guard = 0; guard <= steps.length; guard += 1) {
        const step = steps[Math.min(cursor, steps.length - 1)]!;
        cursor += 1;
        try {
          for (const call of step.toolCalls ?? []) {
            await input.exec(call.tool, call.args);
          }
        } catch (error) {
          if (error instanceof ToolUserError) {
            // 测试驱动产出的 assistant 消息为简化形状,转录由 runtime 原样透传,不做解释
            return {
              text: error.message,
              messages: [...input.messages, { role: 'assistant', content: error.message, timestamp: Date.now() } as unknown as DriverMessage],
            };
          }
          throw error;
        }
        if (step.text !== undefined) {
          return {
            text: step.text,
            messages: [...input.messages, { role: 'assistant', content: step.text, timestamp: Date.now() } as unknown as DriverMessage],
          };
        }
      }
      return { text: '', messages: [...input.messages] };
    },
  };
}
