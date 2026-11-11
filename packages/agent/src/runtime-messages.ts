import { messageTextFor } from './error-codes';

export const FALLBACK_TIMEOUT = messageTextFor('FALLBACK_TIMEOUT');
export const FALLBACK_FAILURE = messageTextFor('FALLBACK_FAILURE');
export const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');
export const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');
export const RESUMED_PLAN_NOT_EXECUTED = messageTextFor('RESUMED_PLAN_NOT_EXECUTED');
export const RESUMED_DECLARATION_FALLBACK = messageTextFor('RESUMED_DECLARATION_FALLBACK');

/**
 * T10 段2：计划因任务假死被冻结后，同一回合内的后续委派一律不派发。
 * 措辞是协议材料（交还 Main Agent 的内部文本）：说清冻结事实与唯一出路（下一回合
 * 显式续跑），不出现执行层细节，也不假装任务已经失败（它可续）。
 */
export const PLAN_FROZEN_REFUSAL =
  '计划已冻结：本任务刚被判定为一段时间没有可核实的结果进展，本回合不再派发后续步骤。'
  + '不要重试或另起新任务；本轮到此为止，回复“继续”可从断点续跑。';
