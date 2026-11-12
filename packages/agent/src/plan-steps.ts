/**
 * 计划模式协议（roadmap Phase 6，架构 §3 规划者/执行者分工）。
 *
 * **机械、领域无关**：宿主只认委派 request 的「第N/M步：」前缀，不匹配任何业务内容。
 *
 * ```text
 * 无前缀的调用 = 单步模式：结果 terminate 成本轮回复
 * 有前缀的调用 = 计划模式：该步结果不 terminate，作为工具结果交还 Main Agent，
 *                       由它继续派下一步或直接输出汇总
 * ```
 *
 * 前缀非法（N/M 不是正整数、N>M、只有前缀没有正文）一律按单步处理：协议解析失败不该
 * 让回合失败，退化成的单步委派仍是合法行为——fail-open 在协议层，fail-closed 在出口校验层。
 */
import type { SubagentNeeds } from './driver';

/** 协议前缀：`第N/M步：`（半角/全角冒号都认，数字与斜杠周围允许空白）。 */
export const PLAN_STEP_PREFIX_PATTERN = /^第\s*(\d+)\s*\/\s*(\d+)\s*步\s*[:：]\s*/u;

export interface PlanStepLabel {
  /** 第几步（1 起）。 */
  stepIndex: number;
  /** 共几步。 */
  totalSteps: number;
  /** 用户可见的步骤标签，如「第 1/3 步」。 */
  label: string;
  /** 去掉协议前缀后的真实请求——透传给子 Agent 的就是它，worker 看不到协议字样。 */
  request: string;
}

/**
 * 解析计划模式前缀。返回 null = 单步模式（含"前缀非法"这种退化情形）。
 *
 * 例：`第2/3步：查某对象 202609 的数据` → `{ stepIndex: 2, totalSteps: 3, label: '第 2/3 步', request: '查某对象 202609 的数据' }`
 */
export function parsePlanStep(request: string): PlanStepLabel | null {
  const text = request.trim();
  const match = PLAN_STEP_PREFIX_PATTERN.exec(text);
  if (!match) return null;
  const stepIndex = Number(match[1]);
  const totalSteps = Number(match[2]);
  if (!Number.isInteger(stepIndex) || !Number.isInteger(totalSteps)) return null;
  // 非法序号按单步：第 0 步、共 0 步、第 4/3 步都不是协议能表达的计划
  if (stepIndex < 1 || totalSteps < 1 || stepIndex > totalSteps) return null;
  const body = text.slice(match[0].length).trim();
  // 只有前缀没有正文：当成普通请求文本（宿主不猜模型想干什么）
  if (!body) return null;
  return { stepIndex, totalSteps, label: `第 ${stepIndex}/${totalSteps} 步`, request: body };
}

/**
 * 交还给 Main Agent 的计划模式步骤工具结果（内部协议材料，不得原样转述给用户）。
 * 与 Phase 5 纠错环同一形状：宿主把结果作为 toolResult 交还，模型自己继续本回合。
 */
export interface PlanStepToolResult {
  recorded: 'delegate';
  /** 「第 N/M 步」。 */
  step: string;
  stepIndex: number;
  totalSteps: number;
  /** 该步的子任务编号（续跑后续步骤时填进 taskId）。 */
  taskId: string;
  /** 本步是否真的产生了平台执行（出口校验与汇总的事实依据）。 */
  executed: boolean;
  /** 本步的子 Agent 结果文本（已剥离执行面注脚）。 */
  text: string;
  /** 本步结局：ok / needs / no_execution / pending_confirmation。 */
  outcome: 'ok' | 'needs' | 'no_execution' | 'pending_confirmation';
  /** needs 出现时的结构化线索（缺什么 / 为什么 / 建议用户提供什么）。 */
  needs?: SubagentNeeds;
  /** 下一步怎么派：宿主机械给出，模型不需要自己推协议。 */
  next: string;
}

/** 计划模式步骤交还模型时的"下一步"指引（纯协议，零业务词）。 */
export function planStepNextHint(step: PlanStepLabel, taskId: string): string {
  if (step.stepIndex < step.totalSteps) {
    return `继续调用本工具派下一步：request 以「第${step.stepIndex + 1}/${step.totalSteps}步：」开头，taskId 填 ${taskId}（不要转述给用户）。任一步失败都不阻塞后续步骤。`;
  }
  return `全部 ${step.totalSteps} 步已派发完毕：直接输出汇总。汇总必须覆盖每一步的结果；失败或缺信息的步骤如实报告，不要掩盖，也不要用估计值填充。`;
}
