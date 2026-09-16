/**
 * TurnDriver:一次回合的模型驱动抽象。
 * 生产实现走 pi-agent-core + pi-ai(pi-driver.ts);测试用 ScriptedTurnDriver(本文件)。
 * 这层缝的存在使"换模型/换 Agent 框架"不波及 runtime 的业务状态机与测试。
 */
import type { DiscoveredTool, ReadToolName } from '@fshine/contracts';

/** 模型上下文消息(仅 user/assistant 文本;工具结果由 agent 框架管理) */
export interface DriverMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnDriverInput {
  systemPrompt: string;
  /** host tools/list 发现的工具(含 inputSchema),driver 据此构造原生工具定义 */
  tools: readonly DiscoveredTool[];
  /** 完整模型上下文:历史重放 + 当前用户消息(最后一条) */
  messages: DriverMessage[];
  /** 阶段进度回调(埋点事实渲染 + 模型意图短语) */
  onStep: (text: string) => void;
  /** 执行工具:返回裁剪后的 data;失败时抛出面向用户的安全话术 */
  exec: (tool: ReadToolName, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** 回合绝对截止时间(Date.now() 基准),超时 driver 应中止并返回空文本 */
  deadline: number;
}

export interface TurnDriverResult {
  /** 最终给用户的回复文本;空字符串表示本次模型调用未产出可用回复 */
  text: string;
}

export interface TurnDriver {
  run(input: TurnDriverInput): Promise<TurnDriverResult>;
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
  toolCalls?: Array<{ tool: ReadToolName; args: Record<string, unknown> }>;
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
          if (error instanceof ToolUserError) return { text: error.message };
          throw error;
        }
        if (step.text !== undefined) return { text: step.text };
      }
      return { text: '' };
    },
  };
}
