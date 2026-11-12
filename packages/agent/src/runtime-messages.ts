import { messageTextFor } from './error-codes';

export const FALLBACK_TIMEOUT = messageTextFor('FALLBACK_TIMEOUT');
export const FALLBACK_FAILURE = messageTextFor('FALLBACK_FAILURE');
export const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');
export const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');
export const RESUMED_PLAN_NOT_EXECUTED = messageTextFor('RESUMED_PLAN_NOT_EXECUTED');

/**
 * T10 段2：计划因任务假死被冻结后，同一回合内的后续委派一律不派发。
 * 措辞是协议材料（交还 Main Agent 的内部文本）：说清冻结事实与唯一出路（下一回合
 * 显式续跑），不出现执行层细节，也不假装任务已经失败（它可续）。
 */
export const PLAN_FROZEN_REFUSAL =
  '计划已冻结：本任务刚被判定为一段时间没有可核实的结果进展，本回合不再派发后续步骤。'
  + '不要重试或另起新任务；本轮到此为止，回复“继续”可从断点续跑。';

/**
 * 重发与委派的同回合互斥（2026-11-12 用户裁定 4）：本回合已经发生过委派（模型调用过
 * 委派工具）时，resend_artifact 被拒，返回可恢复工具错误交还模型。
 *
 * 为什么互斥：重发回合的语义是"零委派、零平台调用"——它的终止文本与 artifactRefs 由
 * handler 合成一条纯重发回执。两者同回合发生时，委派真实发生了（副作用已产生、审计
 * 已留痕），却会被这条回执报告成"只重发了文件"。互相排斥保持两段事实各自完整：
 * 先发生的那个动作赢，后发生的被拒。
 */
export const RESEND_DELEGATION_EXCLUSIVE =
  '本轮已经调用过委派工具：重发与委派不能在同一回合里进行（避免把已经发生的执行报告成纯重发）。'
  + '请先完成本轮的答复；要重发文件，请用户在下一轮单独说一次。';
