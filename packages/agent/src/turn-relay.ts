/**
 * 交还材料的渲染层：宿主与 Main Agent 之间、宿主与用户之间的确定性文本组装。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（那会成环：runtime 要用这里的渲染器）。
 * 因此住在这里的函数只能依赖纯渲染原语与下层模块；需要 runtime 私有判据的组合逻辑
 * （worker 干净说明的准入尺、澄清回复组装）住 runtime.ts，两个使用方共用的文本原语
 * （stripFootprint）住 text-hygiene.ts。
 */
import { messageTextFor, terminalFailureTextFor } from './error-codes';
import type { SubagentNeeds } from './driver';
import type { SubagentTaskResult } from './context';
import { planStepNextHint, type PlanStepLabel, type PlanStepToolResult } from './plan-steps';
import { renderPlanStepOutcomeLines } from './plan-facts';
import type { SelectionClarification, TerminalFastPathFailure } from './platform-contract';
import { stripFootprint } from './text-hygiene';

/**
 * 选择类澄清交给 Main Agent 的工具结果（内部协议材料，不是用户可见文本）：平台请用户
 * "选一个"，宿主已直接把澄清问题发给用户。因此本轮不要再委派、也不要自己复述——
 * 自己复述正是要消灭的"模型翻译执行语言"（Stage 3 事故的 1201 字符技术报告）。
 */
export function renderClarificationToolResult(clarification: SelectionClarification, taskId: string): string {
  return [
    `平台返回选择类状态 ${clarification.code}（候选 ${clarification.candidates.length} 个），宿主已把澄清问题直接发给用户。`,
    `继续该子任务时使用这个编号：${taskId}（不要转述给用户）。用户回答后重新申报 delegate，把该编号填进 continueTaskId，request 写用户选定的对象。`,
    '本轮不要再委派、不要自己复述澄清问题。',
  ].join('\n');
}

/**
 * 纠错环（架构 §3）交给 Main Agent 的工具结果：缺什么 / 为什么 / 建议用户提供什么 /
 * 任务编号 + 重派提示。这是给模型的内部协议材料，不是用户可见文本——外泄由提示词
 * "不许描述内部机制"一条与 C16 注脚剥离兜底，所以任务编号后面紧跟"不要转述给用户"。
 */
export function renderNeedsToolResult(needs: SubagentNeeds, taskId: string, workerText: string): string {
  return [
    `子 Agent 本轮没有执行平台查询，还缺少信息：${needs.missing.join('、') || '（未指明）'}。`,
    `原因：${needs.reason}`,
    ...(needs.suggestion ? [`建议用户提供：${needs.suggestion}`] : []),
    `继续该子任务时使用这个编号：${taskId}（不要转述给用户）。用户补充信息后，重新申报 delegate，把该编号填进 continueTaskId，request 写补充后的完整请求。`,
    '能自己补齐就直接补齐后重派（实体只能从当前消息、宿主注入的检索证据或本轮平台响应里取），补不齐再申报 conversation 把问题转达给用户。',
    ...(workerText ? [`子 Agent 的说明：${workerText}`] : []),
  ].join('\n');
}

/** 纠错环转达给用户的文本：缺什么 / 为什么 / 建议提供什么。零内部机制字样。 */
export function renderNeedsUserText(needs: SubagentNeeds, workerText: string): string {
  const lines: string[] = [];
  if (needs.missing.length) lines.push(`还缺少：${needs.missing.join('、')}。`);
  if (needs.reason.trim()) lines.push(`原因：${needs.reason.trim()}`);
  if (needs.suggestion?.trim()) lines.push(`建议提供：${needs.suggestion.trim()}`);
  return [workerText.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

/**
 * 计划模式（Phase 6）一步的交还材料：这一步的结果不 terminate 整轮，作为工具结果
 * 交还 Main Agent，由它继续下一步或输出汇总。与 Phase 5 的 needs 交还同一机制，
 * 区别只在这里交还的是"一步的正常/失败结果"，不是"缺什么"的纠错线索。
 */
export function renderPlanStepToolResult(step: PlanStepLabel, result: SubagentTaskResult): PlanStepToolResult {
  const outcome = result.needs || result.clarification ? 'needs'
    : result.execution ? 'ok'
      : result.pendingPlan ? 'pending_confirmation'
        : 'no_execution';
  return {
    recorded: 'delegate',
    step: step.label,
    stepIndex: step.stepIndex,
    totalSteps: step.totalSteps,
    taskId: result.taskId,
    executed: Boolean(result.execution),
    text: stripFootprint(result.text),
    outcome,
    ...(result.needs ? { needs: result.needs } : {}),
    next: planStepNextHint(step, result.taskId),
  };
}

/**
 * 错误态快路径的终局话术渲染出口（v2，2026-10-16 重做）：平台确定性终局码的信封事实
 * → 宿主模板话术。渲染只有这一份，两个消费方共用——
 *   · 驱动侧（皮带）：pi-coding-driver 早停时把渲染好的话术填进 result.text——第一版
 *     死因正是早停后 result.text 是空串，而宿主的空文本检查先于一切分支执行，用户拿到
 *     "未返回可用结果"的兜底话术。皮带保证无论宿主侧哪个分支失手，用户都不会看到空结果。
 *   · 宿主侧（背带）：context.ts 的终局分支用同一函数渲染 ToolUserError——若皮带失手
 *     （text 意外为空），宿主豁免 + 这条分支仍然把话说全。
 * 两处调用同一函数 = 话术只有一份来源，不存在"驱动版/宿主版"两个措辞分叉。
 */
export function renderTerminalFailureReply(failure: TerminalFastPathFailure): string {
  return terminalFailureTextFor(failure.code, {
    query: failure.query,
    ...(failure.period ? { period: failure.period } : {}),
    ...(failure.availablePeriods ? { availablePeriods: failure.availablePeriods } : {}),
  });
}

/**
 * 写关闭终稿（D-075）：宿主原句终结该轮，多步计划附步骤事实汇总。
 *
 * 单步：原句即终稿，一字不差（e2e turn-loop-write-closure 钉住）——与 D-075 主体
 * 修复的行为完全一致，不因多步支持而漂移。
 *
 * 多步计划：写关闭往往只是拆解中的一步（写请求的前置步都是读）。原句必须出现且不被
 * 转述稀释，所以它整体在前、其余一字不来自模型；前序步骤的真实发生由宿主持有的步骤
 * 事实汇总兜底——与熔断汇总/复读兜底同一份事实源（renderPlanStepOutcomeLines），只
 * 陈述步号与结局、不含业务数据，因此也不含财务数字（出口校验的零执行数字拦截不会
 * 误伤它）。写关闭一步自身按机械事实记 'failed'（确实零平台执行），一并列出。
 *
 * 不附"可以回复继续重跑未完成的步骤"（熔断/复读兜底的那句）：写关闭是部署级终局
 * 事实，写类步骤永远不会被放行，那句提示在写计划下是假承诺——宿主不陈无根据的下一步。
 */
export function renderWriteClosureReply(
  step: PlanStepLabel | null,
  delegated: SubagentTaskResult,
  outcomes: readonly { label: string; outcome: 'done' | 'needs' | 'failed' }[],
): string {
  const sentence = stripFootprint(delegated.text) || messageTextFor('WRITE_NOT_ENABLED');
  if (!step) return sentence;
  return [sentence, '', '本轮拆解的进度如下：', ...renderPlanStepOutcomeLines(outcomes)].join('\n');
}
