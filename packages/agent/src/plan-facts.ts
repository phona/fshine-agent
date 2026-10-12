import type { TaskPlanRepo, TaskPlanStepFact, TrustedContext } from '@fshine/contracts';
import type { SubagentTaskResult } from './context';
import type { PlanStepLabel } from './plan-steps';

/** 任务计划事实里 request 的截断长度（原文全文在 Conversation Log / 转录里）。 */
const PLAN_FACT_REQUEST_LIMIT = 500;
/** 任务计划事实里 summary 的截断长度。 */
const PLAN_FACT_SUMMARY_LIMIT = 300;

/**
 * 计划步骤事实的写入器（工厂）：序号计数器随写入器实例走，同一进程内唯一
 * （planId + 步号 + 状态 + 序号）。工厂只在 createTaxAgentRuntime 里建一次，
 * 因此计数器的实际作用域是**每个 runtime 实例**——跨回合不重置，保证同一计划同一步
 * 同一状态在不同回合各追加一次时 factId 不撞库（每回合重置会撞存储 UNIQUE，而 append
 * 失败只记日志不阻塞回合，步骤事实会静默丢失）。
 *
 * 只收稳定依赖（taskPlans）；principalId / sessionId / requestId 每回合都不同，从调用点
 * 传入的 ctx 现取——提前绑定会把"每 runtime 实例"悄悄降级成"每回合"。
 */
export function createPlanFactWriter(opts: {
  taskPlans: TaskPlanRepo | undefined; // 即 deps.taskPlans
}): (ctx: TrustedContext, step: PlanStepLabel, planId: string, status: TaskPlanStepFact['status'], extra?: { taskId?: string; summary?: string }) => Promise<void> {
  const { taskPlans } = opts;
  // 任务计划事实的序号：同一进程内唯一（planId + 步号 + 状态 + 序号）。
  let planFactSeq = 0;
  return async function appendPlanFact(
    ctx: TrustedContext,
    step: PlanStepLabel,
    planId: string,
    status: TaskPlanStepFact['status'],
    extra?: { taskId?: string; summary?: string },
  ): Promise<void> {
    if (!taskPlans) return;
    planFactSeq += 1;
    const fact: TaskPlanStepFact = {
      factId: `${planId}:${step.stepIndex}:${status}:${planFactSeq}`,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      planId,
      stepIndex: step.stepIndex,
      totalSteps: step.totalSteps,
      request: step.request.slice(0, PLAN_FACT_REQUEST_LIMIT),
      status,
      ...(extra?.taskId ? { taskId: extra.taskId } : {}),
      ...(extra?.summary ? { summary: extra.summary.slice(0, PLAN_FACT_SUMMARY_LIMIT) } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      await taskPlans.append(fact);
    } catch (error) {
      // 记账失败不阻塞回合：计划状态是进度投影，不是执行授权。
      console.error(JSON.stringify({ event: 'task_plan_append_failed', requestId: ctx.requestId, planId, stepIndex: step.stepIndex, status, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
    }
  };
}

/** 计划模式步骤事实的 summary：只写宿主持机械可验证的结局，不猜业务成败。 */
export function planStepSummary(result: SubagentTaskResult): string {
  if (result.needs) return `缺：${result.needs.missing.join('、') || '（未指明）'}；${result.needs.reason}`;
  // 选择类澄清：平台给了候选、等用户选。summary 只记码与候选数（候选名是数据，事实里不抄）。
  if (result.clarification) return `平台澄清：${result.clarification.code}（候选 ${result.clarification.candidates.length} 个）`;
  if (result.execution) return `已执行 ${result.execution.calls} 次平台调用`;
  return '未产生平台执行';
}

/**
 * 计划步骤结局的用户可读行（熔断汇总与复读兜底共用的事实源）：只陈述步号与结局，
 * 不猜业务语义，因此不含财务数字——出口校验的"零执行轮次数字结论"拦截不会覆盖它。
 *
 * 与 turn.planStepOutcomes 同源，而后者与刚写入任务计划存储的事实同源：哪些步
 * done / needs / failed 是宿主持有的机械事实，不是模型的叙述。
 */
export function renderPlanStepOutcomeLines(
  outcomes: readonly { label: string; outcome: 'done' | 'needs' | 'failed' }[],
): string[] {
  const pick = (kind: 'done' | 'needs' | 'failed'): string[] =>
    outcomes.filter((entry) => entry.outcome === kind).map((entry) => entry.label);
  const done = pick('done');
  const needs = pick('needs');
  const failed = pick('failed');
  const lines = [done.length > 0 ? `已执行成功的步骤：${done.join('、')}。` : '本次拆解没有执行成功的步骤。'];
  if (needs.length > 0) lines.push(`缺信息未执行的步骤：${needs.join('、')}。`);
  if (failed.length > 0) lines.push(`没有产生平台执行的步骤：${failed.join('、')}。`);
  return lines;
}

/**
 * 计划模式熔断汇总：只陈述计划事实（哪些步成了、从哪一步起连续失败已停），不猜业务语义。
 *
 * 开头那句"后续步骤不再派发"是熔断独有的确定性事实（宿主确实停止了派发），因此
 * 与复读兜底不共用开头——后者没有这个事实可陈，不能借来声称宿主停止过什么。
 */
export function renderPlanCircuitBreak(
  outcomes: readonly { label: string; outcome: 'done' | 'needs' | 'failed' }[],
  consecutive: number,
  totalSteps: number,
): string {
  const firstFailed = outcomes[outcomes.length - consecutive];
  const lines = [
    `计划执行已停止：自「${firstFailed?.label ?? '上一步'}」起连续 ${consecutive} 步没有产生任何平台执行（本次共 ${totalSteps} 步），后续步骤不再派发。`,
    ...renderPlanStepOutcomeLines(outcomes),
  ];
  lines.push('可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。');
  return lines.join('\n');
}

/**
 * 计划模式复读兜底（F4）：模型把步骤工具结果原样当回复时（停在工具结果上没再说话），
 * 那段 JSON 是内部协议材料——任务编号、「不要转述给用户」的 next 提示——绝不能外发。
 * 宿主持有的步骤事实机械汇总顶上：只说步骤事实与下一步，不含任何协议字段。
 *
 * 与 renderPlanCircuitBreak 共用 renderPlanStepOutcomeLines 这一份事实源；差别只在
 * 复读没有"连续零执行已停派"这个事实，所以不说"已停止"，只说进度。
 */
export function renderPlanStepsRelayFallback(
  outcomes: readonly { label: string; outcome: 'done' | 'needs' | 'failed' }[],
): string {
  return [
    '本轮拆解的进度如下：',
    ...renderPlanStepOutcomeLines(outcomes),
    '可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。',
  ].join('\n');
}
