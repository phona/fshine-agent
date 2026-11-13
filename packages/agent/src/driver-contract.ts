/**
 * 最小回合驱动契约（Minimal Reset 抽出的共享小件）。
 *
 * 来源：旧 `driver.ts`（已随旧 hub 删除）里被最小路径真正消费的类型与错误类。
 * 旧 driver.ts 的其余内容——计划确认（plan-runtime）、提案创建（proposal-runtime）、
 * 申报/实体来源（turn-contract）、认证失败与澄清（platform-contract）、用量遥测与
 * ScriptedTurnDriver 等——都不属于最小读链，未随迁。
 *
 * 消费者（改引本模块的 kept 侧）：
 *   · `pi-driver.ts`            —— TurnDriver 的生产实现（pi 原生循环）；
 *   · `minimal/execution-runtime.ts` —— 按 TurnDriver 抽象驱动 Main/Worker；
 *   · `proposal-review.ts`      —— generic-mock 隔离复核门用它跑无工具回合；
 *   · `pi-driver.test.ts` / `tool-user-error.test.ts` —— 直测驱动接线与错误类契约。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';

/** 转录消息 = pi 原生 AgentMessage（JSON 可序列化，含工具调用与结果）。 */
export type DriverMessage = AgentMessage;

export interface TurnDriverInput {
  systemPrompt: string;
  /** host tools/list 发现的工具（含 inputSchema），driver 据此构造原生工具定义。 */
  tools: readonly DiscoveredTool[];
  /** 完整转录：历史全部消息（不含本条新用户消息，由调用方在调用前 push）。 */
  messages: DriverMessage[];
  /** 阶段进度回调（埋点事实渲染 + 模型意图短语）。 */
  onStep: (text: string) => void;
  /** 执行工具：返回 data（原样进入转录）；失败时抛出面向用户的安全话术。 */
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** 回合绝对截止时间（Date.now() 基准），超时 driver 应中止并返回空文本。 */
  deadline: number;
  /** 父级取消信号（隔离复核这类嵌套回合）。 */
  signal?: AbortSignal;
}

export interface TurnDriverResult {
  /** 最终给用户的回复文本；空字符串表示本次模型调用未产出可用回复。 */
  text: string;
  /** 更新后的完整转录（含本回合全部消息），由调用方持久化。 */
  messages: DriverMessage[];
}

export interface TurnDriver {
  run(input: TurnDriverInput): Promise<TurnDriverResult>;
  /** 上下文压缩（Pi 原生 compact 的宿主侧收敛）。超阈值时替换旧消息为摘要 + 保留最近尾巴。 */
  compact?(messages: DriverMessage[], opts?: { force?: boolean }): Promise<DriverMessage[]>;
  /**
   * 服务端确定性回复合成原生 assistant 消息：必须带完整内部形状
   * （api/provider/model/usage/stopReason），否则该转录进入下一模型回合时结算会报错。
   */
  synthesizeAssistant?(text: string): DriverMessage;
}

/**
 * 工具失败的确定性终结错误：message 是面向用户的安全话术，直接作为最终回复
 * （driver 不得再喂给模型）。code 供码级判据读取（挂码修复的存活字段）。
 */
export class ToolUserError extends Error {
  code?: string;

  constructor(message: string, options?: {
    code?: string;
  }) {
    super(message);
    this.name = 'ToolUserError';
    this.code = options?.code;
  }
}
