/**
 * 计划绑定（跨回合续跑）与多任务回溯消歧：**纯判定 + 渲染**。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（runtime 要用这里的判定与文案，引回来就成环，
 * 由 packages/agent/architecture-shape.test.ts 的环断言守着）。住在这里的只有
 * 「这一步绑到哪个计划」的机械判定（C31 五条优先级）与消歧问题的渲染；
 * 抛异常、写 turn、打日志、I/O（loadOpenPlans / planIdForTask 的调用与降级）全部留在
 * runtime.ts 的调用点——判定与副作用分开，判定的每一支才能用纯数据直接验证（R3）。
 *
 * 为什么值得单独成模块：C31 的优先级（同回合已定 > continueTaskId 反查 > 用户消歧选定
 * > 形状判定 > 多候选出题）原先只能靠 driver harness 间接验证；抽成纯函数后，
 * 「谁绑定到哪个计划」可以用纯数据 + 内存假 repo 直测。
 */
import type { ConversationLogRepo, TaskPlanRepo, TaskPlanSummary, TrustedContext } from '@fshine/contracts';
import type { PlanStepLabel } from './plan-steps';

/**
 * 多任务消歧问题的固定前缀（多任务回溯）：宿主下一回合按它识别"上一条 assistant 回复
 * 是消歧问题"，纯编号回复才有绑定含义——编号只有紧跟问题才算数，中间插过任何回合即失效。
 */
export const PLAN_DISAMBIGUATION_PREFIX = '【任务消歧】';

/** 形状判定：总步数一致且申报步号接得上已留存步号，才可能是同一个拆解的续跑。 */
export function fitsPlanShape(plan: TaskPlanSummary, step: PlanStepLabel): boolean {
  return plan.totalSteps === step.totalSteps && step.stepIndex > plan.maxRecordedStep;
}

/**
 * 计划绑定的判定入参。候选与反查能力都由调用方注入——本函数不碰任何存储、不读 deps，
 * 因此也不知道"存储不可用"这回事（那种降级在调用方，见 runtime.ts 的 loadOpenPlans）。
 */
export interface PlanBindingInput {
  /** 候选未完成计划（调用方已加载：openPlans 的召回与降级在 runtime.ts）。 */
  openPlans: readonly TaskPlanSummary[];
  /**
   * 用户消歧选定（优先级 ③）：消歧回合用户从多个未完成任务里选定的那一个，宿主强制。
   *
   * 优先级 ①（同回合已定）不在这里：它是调用方对本回合早前决策的记忆（`turn.planId`），
   * 在调用 resolvePlanBinding 之前就短路返回了——晚一步进来会让形状不一致的后续步骤
   * 被重新判成"新开计划"，那不是现状行为。
   */
  preferredPlanId?: string | null;
  /** 模型显式续跑某个子任务（优先级 ② 的 intent.continueTaskId）。 */
  taskId?: string | null;
  /** ② 的反查入口：taskId → planId。I/O 与容错由调用方提供，约定**不抛**（失败返回 null）。 */
  planIdForTask: (taskId: string) => Promise<string | null>;
  /** 本回合请求 id：新开计划的 planId 是 `plan_${requestId}`（同一拆解的所有步共享）。 */
  requestId: string;
}

/**
 * 判定结果：要么绑到一个计划，要么"候选多于一个且无其他依据，出题让用户选"。
 * `resumed` 只供调用方写日志（task_plan_resumed / task_plan_started），不参与判定。
 */
export type PlanBinding =
  | { planId: string; resumed: boolean }
  | { disambiguate: readonly TaskPlanSummary[] };

/**
 * C31 的计划绑定判定（优先级 ②③④ + 出题条件）。**纯函数**：不抛异常、不打日志、
 * 不写 turn、不直接碰存储——唯一的外部交互是调用方注入的 `planIdForTask`。
 *
 * ② continueTaskId 反查（任务记在步事实上，比"最近开放"更真）> ③ 用户消歧选定 >
 * ④ 形状判定（总步数一致且步号接得上的候选恰一个）。多候选且无其他依据时不猜，
 * 把候选原样交回调用方出题。
 */
export async function resolvePlanBinding(input: PlanBindingInput, step: PlanStepLabel): Promise<PlanBinding> {
  const open = input.openPlans;
  let resumed: TaskPlanSummary | undefined;
  if (input.taskId) {
    // 模型显式续跑某个子任务：计划归属按 taskId 反查事实，不按"最近开放"猜——
    // 否则最近的是别的计划时，这一步会被记到错误的计划上，投影裂开。
    const byTask = await input.planIdForTask(input.taskId);
    resumed = byTask ? open.find((plan) => plan.planId === byTask) : undefined;
    // 反查不到（任务没有计划事实，如纯单步任务续跑）：这一步新开计划，
    // 绝不落回形状猜测绑到无关的旧计划上。
  } else if (input.preferredPlanId) {
    // 消歧回合：用户已选定任务。声明形状与该计划一致才绑定；不一致就新开——
    // 绝不静默改绑其他未完成任务，那不是用户选的。
    const preferred = open.find((plan) => plan.planId === input.preferredPlanId);
    if (preferred && fitsPlanShape(preferred, step)) resumed = preferred;
  } else {
    const fitting = open.filter((plan) => fitsPlanShape(plan, step));
    if (fitting.length === 1) resumed = fitting[0];
    if (fitting.length > 1) return { disambiguate: fitting };
  }
  return { planId: resumed ? resumed.planId : `plan_${input.requestId}`, resumed: resumed !== undefined };
}

/**
 * matchPlanDisambiguationReply 需要的两个只读入口。不引 runtime 的 TaxAgentRuntimeDeps
 * （引回来就成环）；形状是它的真子集，runtime 直接把整个 deps 传进来即可。
 */
export interface PlanDisambiguationRepos {
  taskPlans?: Pick<TaskPlanRepo, 'openPlans'>;
  conversationLog?: Pick<ConversationLogRepo, 'list'>;
}

/**
 * 多任务消歧的编号回复匹配：上一条 assistant 事件是宿主的消歧问题、且本条消息是纯编号，
 * 才视为用户选定了要继续的任务。编号越界、中间插过任何回合、存储不可用——一律返回 null，
 * 消息按普通回合进模型。纯机械判定：不需要也不允许语义猜测。
 *
 * 与 matchClarificationBinding（澄清选择的宿主机械绑定）**并列不合并**：那个解"用户选了
 * 哪个候选"，这个解"继续哪个任务"。
 */
export async function matchPlanDisambiguationReply(
  deps: PlanDisambiguationRepos,
  ctx: TrustedContext,
  userMessage: string,
): Promise<{ planId: string; label: string } | null> {
  if (!deps.taskPlans || !deps.conversationLog) return null;
  const trimmed = userMessage.trim();
  if (!/^[1-9]\d?$/.test(trimmed)) return null;
  try {
    const events = await deps.conversationLog.list({ principalId: ctx.principalId, sessionId: ctx.sessionId, limit: 20 });
    const lastAssistant = [...events].reverse().find((event) => event.kind === 'assistant_message');
    if (!lastAssistant?.content?.startsWith(PLAN_DISAMBIGUATION_PREFIX)) return null;
    const candidates = await deps.taskPlans.openPlans(ctx.principalId, ctx.sessionId);
    const index = Number(trimmed) - 1;
    const chosen = Number.isInteger(index) && index >= 0 && index < candidates.length ? candidates[index] : undefined;
    return chosen ? { planId: chosen.planId, label: planChoiceLabel(chosen) } : null;
  } catch (error) {
    // 匹配失败不影响回合：退回"无绑定"，消息按普通回合进模型（与消歧匹配同族降级）。
    console.error(JSON.stringify({ event: 'plan_disambiguation_match_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
    return null;
  }
}

/** 消歧选项的可读标签：拆解第一步的加工后请求 + 进度。全部来自计划事实，宿主不猜业务。 */
export function planChoiceLabel(summary: TaskPlanSummary): string {
  const first = summary.firstRequest.length > 60 ? `${summary.firstRequest.slice(0, 59)}…` : summary.firstRequest;
  return `${first}（${summary.done}/${summary.totalSteps} 步已完成）`;
}

/** 消歧问题正文：固定前缀 + 编号选项（标签由计划事实机械生成）+ 收尾提示。 */
export function renderDisambiguationQuestion(candidates: readonly TaskPlanSummary[]): string {
  return [
    `${PLAN_DISAMBIGUATION_PREFIX}当前有多个未完成任务，请回复编号继续对应的那一个：`,
    ...candidates.map((candidate, index) => `${index + 1}. ${planChoiceLabel(candidate)}`),
    '回复其他内容将按新请求处理。',
  ].join('\n');
}
