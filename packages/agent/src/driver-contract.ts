/**
 * 回合驱动契约（重建时抽出的共享小件）。
 *
 * 来源：旧 `driver.ts`（已随旧 hub 删除）里被最小路径真正消费的类型与错误类。
 * 旧 driver.ts 的其余内容——计划确认（plan-runtime）、提案创建（proposal-runtime）、
 * 申报/实体来源（turn-contract）、认证失败与澄清（platform-contract）、用量遥测与
 * ScriptedTurnDriver 等——都不属于最小读链，未随迁。
 *
 * 消费者（改引本模块的 kept 侧）：
 *   · `pi-driver.ts`            —— TurnDriver 的生产实现（pi 原生循环）；
 *   · `execution-runtime.ts`   —— 按 TurnDriver 抽象驱动 Main/Worker；
 *   · `pi-driver.test.ts` / `tool-user-error.test.ts` —— 直测驱动接线与错误类契约。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';

/** 转录消息 = pi 原生 AgentMessage（JSON 可序列化，含工具调用与结果）。 */
export type DriverMessage = AgentMessage;

/**
 * 运行时回合事实（U3 重放窗口判定的唯一事实来源；不含模型文本与参数）：
 *   · assistant_end —— 一条正常结束（stopReason 非 error/aborted）的 assistant 响应边界：
 *     它之后的工具调用属于这次响应（宿主据此推进回合号）；
 *   · recovery —— 运行时宣布「上一次尝试被丢弃、正在重试」。三个原生事件都归到这里：
 *     `compaction_end.willRetry`（溢出/阈值压缩后重试）、`auto_retry_start`（瞬时错误自动
 *     重试）、assistant `message_end` 且 `stopReason='error'`（失败尝试结束）。重试响应
 *     可能重发上一次响应里的 toolCall，宿主据此开重放窗口；中止（aborted）不是重试，不转述。
 */
export type RuntimeTurnEvent =
  | { kind: 'assistant_end' }
  | { kind: 'recovery'; reason: 'compaction' | 'auto_retry' };

export interface TurnDriverInput {
  systemPrompt: string;
  /** host tools/list 发现的工具（含 inputSchema），driver 据此构造原生工具定义。 */
  tools: readonly DiscoveredTool[];
  /**
   * 本回合输入快照：最后一条 user 消息 = 本轮输入；其余消息只是**种子历史**——
   * 仅在驱动尚无 Pi 会话（首回合 / 每回合一次性会话）时导入，会话已存在时**不进入**转录
   * （转录归 Pi 的 AgentSession 独占）。
   */
  messages: DriverMessage[];
  /**
   * 宿主确定性事实（R5 B 通道）：以 Pi 原生 custom message 注入下一请求（按 user 角色投影），
   * 不触发单独模型回合。缺省 = 无注入。
   */
  injections?: readonly string[];
  /** 阶段进度回调（埋点事实渲染 + 模型意图短语）。 */
  onStep: (text: string) => void;
  /** 执行工具：返回 data（原样进入转录）；失败时抛出面向用户的安全话术。 */
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** 回合绝对截止时间（Date.now() 基准），超时 driver 应中止并返回空文本。 */
  deadline: number;
  /** 父级取消信号（隔离复核这类嵌套回合）。 */
  signal?: AbortSignal;
  /**
   * 运行时回合事实出口（U3）：只转述驱动已订阅的原生事件，不新建订阅体系。
   * 缺省 = 不判定重放窗口（每笔调用都按新操作处理）。
   */
  onRuntimeEvent?: (event: RuntimeTurnEvent) => void;
}

export interface TurnDriverResult {
  /** 最终给用户的回复文本；空字符串表示本次模型调用未产出可用回复。 */
  text: string;
  /**
   * 本回合结束后的转录**只读投影快照**（Pi 原生会话 → 宿主可读形状）。
   * 宿主不得据此累积可变历史；需要当前转录时用 `TurnDriver.transcript()`。
   */
  messages: DriverMessage[];
}

export interface PiSessionInspection {
  /** Pi 实际对模型使用的系统提示（受控 ResourceLoader + Pi 原生渲染）。 */
  systemPrompt: string;
  /** Pi 当前激活的工具名（白名单内；内置 read/bash/edit/write 不应出现）。 */
  activeToolNames: readonly string[];
  /** 会话落盘文件（仅显式 sessionDir 时存在）。 */
  sessionFile: string | undefined;
}

export interface TurnDriver {
  run(input: TurnDriverInput): Promise<TurnDriverResult>;
  /**
   * 只读派生：驱动持有的 Pi 会话当前转录投影（宿主 `Session.transcript()` 直接委托它）。
   * 无此方法的测试替身由调用方回落到上一回合结果快照。
   */
  transcript?(): readonly DriverMessage[];
  /** 释放驱动持有的 Pi 会话（实例级会话的进程正常退出路径）。 */
  close?(): void;
  /**
   * 只读审计面：当前 Pi 会话的系统提示、激活工具名与落盘文件（不做任何行为）。
   * 会话尚未创建（或回合级会话已释放）时返回 undefined。
   */
  sessionInfo?(): PiSessionInspection | undefined;
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
