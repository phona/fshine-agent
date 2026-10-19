/**
 * 回合状态（handleTurn 的 `turn` 对象）与它的记账规则：needs 回路上限、计划模式零执行
 * 熔断、步骤结局、一步委派返回后的跨步累积。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（runtime 要用这里的 TurnState 与记账
 * 函数，引回来就成环）。住在这里的只有"状态形状 + 纯记账规则"——控制流（何时记账、
 * 记账之后抛什么/还什么/返回什么）留在 runtime.ts，判定条件一字不动。
 *
 * 为什么值得单独成模块：这些计数器规则今天散在 handleTurn 的闭包里，只能靠 2000 行的
 * runtime.test.ts 间接验证（要构造整个 driver harness 才能碰到一次记账）；抽成纯函数后
 * 可用纯数据直接钉住语义（R3：新测试不起 driver harness）。
 */
import type { SubagentNeeds, TurnDriverResult } from './driver';
import type { SubagentTaskResult } from './context';
import type { PendingPlanConfirmation } from './plan-runtime';
import type { PlanStepLabel } from './plan-steps';
import type { SelectionClarification } from './platform-contract';
import type { TurnDeclaration } from './turn-contract';

type TurnExecution = NonNullable<TurnDriverResult['execution']>;

/**
 * 回合契约状态：Main Agent 必须显式申报本轮动作，宿主留存并校验证据。
 * 用对象承载，避免闭包赋值被控制流分析窄化成 never。
 */
export interface TurnState {
  declared: boolean;
  intent: TurnDeclaration | null;
  execution: TurnExecution | null;
  pendingPlan: PendingPlanConfirmation | null;
  /** 方案已获批准但本次零执行（P1 收尾兜底）：真实状态是"批准了没执行"。 */
  activatedPlan: { planId: string; version: number } | null;
  /** 委派是否已失败并给出安全话术——那种回复不该被出口校验覆盖。 */
  delegationFailed: boolean;
  /**
   * 本回合以资源耗尽（RESOURCE_EXHAUSTED，协议失败分类）收尾：委派层超时分类的失败。
   * 终稿由宿主从执行事实合成（resource-exhausted.ts），turn_span 按它记 resource_exhausted
   * 供审计与续跑识别——delegation_span 的 failed/timeout 分类由 context.ts 原样落，不互斥。
   */
  resourceExhausted: boolean;
  /** 纠错环（架构 §3）：本回合已发生几轮"子 Agent 回报缺信息"。0 = 没有回路。 */
  needsRounds: number;
  /** 最近一条结构化线索（回路兜底转达用户时用）。 */
  lastNeeds: SubagentNeeds | null;
  /** 计划模式（Phase 6）：本回合已发生的拆解步数。0 = 没有计划模式。 */
  planSteps: number;
  /** 计划模式：本拆解的计划 id（同一拆解的所有步共享，跨回合经 openPlans 找回）。 */
  planId: string | null;
  /** 计划模式：上一次回报缺信息的步号——回路上限按步计，换步即重新计数。 */
  needsStepIndex: number | null;
  /** 计划模式熔断：连续零执行（既无 execution 也无 needs 交还）的步数；合法一步即重置。 */
  planZeroExecSteps: number;
  /** 计划模式熔断汇总：本回合已派步骤的结局（与刚写的计划事实同源，只机械陈述）。 */
  planStepOutcomes: Array<{ label: string; outcome: 'done' | 'needs' | 'failed' }>;
  /** 结构化歧义/未找到（Stage 3 根治包）：本回合的选择类澄清事实，宿主机械组装用。 */
  clarification: SelectionClarification | null;
  /** 澄清问题的最终措辞（模板+信封数据+干净说明一次组装；终止与兜底共用同一份）。 */
  clarificationReply: string | null;
  /** 消歧回合：用户从多个未完成任务中选定的计划。绑定由宿主强制，模型不可改绑。 */
  preferredPlanId: string | null;
}

/**
 * 建一个回合状态对象。planChoice = 消歧回合用户从多个未完成任务中选定的那一个
 * （宿主强制绑定，模型不可改绑）；非消歧回合不传。
 */
export function createTurnState(planChoice?: { planId: string } | null): TurnState {
  return {
    declared: false,
    intent: null,
    execution: null,
    pendingPlan: null,
    activatedPlan: null,
    delegationFailed: false,
    resourceExhausted: false,
    needsRounds: 0,
    lastNeeds: null,
    planSteps: 0,
    planId: null,
    needsStepIndex: null,
    planZeroExecSteps: 0,
    planStepOutcomes: [],
    clarification: null,
    clarificationReply: null,
    preferredPlanId: planChoice?.planId ?? null,
  };
}

/**
 * 纠错环单回合上限（架构 §3）：子 Agent 连续回报"缺什么"这么多轮就不再要它重派，
 * 直接把线索转达给用户。防的是模型在同一回合里反复空转——每一轮都是一次完整委派。
 */
export const MAX_NEEDS_ROUNDS = 3;

/**
 * 计划模式熔断阈值：连续这么多拆解步"既无执行痕迹也无 needs 交还"就停止后续步骤。
 *
 * 真实平台 12 步计划实测的形状：每一步都是 worker 启动+读 skill+提计划被拒+把方案
 * 当文本打印，步步零执行（每步约 11s 空转），全部步骤 failed。合法步骤不可能零执行
 * ——真跑过必然有 execution，执行不了必然有 needs 交还——所以只熔"连续零执行"不会
 * 误伤合法拆解；中间任何一步有执行或交还就重置计数（见 noteZeroExecStep）。
 */
export const MAX_PLAN_ZERO_EXEC_STEPS = 3;

/**
 * needs 回路记账：发生了一轮"子 Agent 回报缺信息"。
 *
 * 单步模式（stepIndex = null）按全局计——这一轮的结论只由这一次委派证明；计划模式
 * 按步计——换成下一步就重新计数，任一步失败不阻塞其他步（架构 §3：不能用单步回路
 * 的上限把整轮拆解掐掉）。
 *
 * 返回 true = 已达上限，调用方停止重派（计划模式：跳过这一步继续后续；单步模式：
 * 把线索转达给用户）。
 */
export function noteNeedsRound(state: TurnState, stepIndex: number | null): boolean {
  if (stepIndex !== null) {
    if (state.needsStepIndex === stepIndex) state.needsRounds += 1;
    else { state.needsStepIndex = stepIndex; state.needsRounds = 1; }
  } else {
    state.needsRounds += 1;
  }
  return state.needsRounds >= MAX_NEEDS_ROUNDS;
}

/**
 * 计划模式熔断记账：一步的结局进 planStepOutcomes，并维护"连续零执行步数"。
 *
 * 零执行 = 既无 execution 也无 needs 交还（worker 空转的形状：提计划被拒/把方案当文本
 * 打印）。有执行或交还即重置——合法步骤必然两者之一，所以只熔"连续"零执行。
 *
 * 两类步骤不计入熔断：
 *   · 停在用户确认门的步骤（pendingPlan）：回合在此暂停，没有"后续步骤"可省；
 *   · 写关闭步骤（writeClosed）：它的零执行是"部署没开放写"的终局事实，不是 worker
 *     空转——那句话必须由宿主说给用户（见 runtime 的 writeClosed 分支），而被熔断汇总
 *     顶上就永远说不出来了；且熔断汇总结尾的"可以回复继续重跑未完成的步骤"在写计划下
 *     是假承诺（写类步骤永远不会被放行）；
 *   · 提案已登记步骤（proposalCreated，B 波 B3）：同族——它的零执行是"提案在平台侧建好、
 *     等用户确认"的终局事实，用户要的是确认码；被熔断汇总顶上，确认码就永远到不了用户。
 *
 * 返回 true = 已达熔断阈值且不属豁免，调用方停止派发后续步骤、用计划事实机械汇总收尾。
 */
export function noteZeroExecStep(state: TurnState, outcome: {
  failed: boolean;
  writeClosed?: boolean;
  proposalCreated?: boolean;
  pendingPlan?: boolean;
}): boolean {
  if (outcome.pendingPlan) return false;
  state.planZeroExecSteps = outcome.failed ? state.planZeroExecSteps + 1 : 0;
  return state.planZeroExecSteps >= MAX_PLAN_ZERO_EXEC_STEPS && !outcome.writeClosed && !outcome.proposalCreated;
}

/** 步骤结局追加进熔断/复读兜底共用的事实源（与刚写的计划事实同源，只机械陈述）。 */
export function notePlanStepOutcome(state: TurnState, label: string, outcome: 'done' | 'needs' | 'failed'): void {
  state.planStepOutcomes.push({ label, outcome });
}

/**
 * 一步的结局判定（与计划事实的 status 同一族）：needs 交还或选择类澄清 → needs
 * （缺的是"用户选哪个"，与缺参数同族，都不是失败）；有 execution → done；两者皆无
 * → failed。
 */
export function stepOutcomeOf(delegated: SubagentTaskResult): 'needs' | 'done' | 'failed' {
  return delegated.needs || delegated.clarification ? 'needs' : delegated.execution ? 'done' : 'failed';
}

/**
 * 一步委派返回后的回合状态累积（计划模式 OR 累积 / 单步覆盖）与计划步计数。
 *
 *   · planSteps：计划模式这一步计入"本回合已发生的拆解步数"（单步模式不记，planSteps
 *     > 0 就是计划模式的判据）；
 *   · execution：计划模式跨步累积（任一步真跑过，本回合就有执行痕迹，汇总因此放行），
 *     单步模式保持旧语义——这一轮的结论只由这一次委派证明；
 *   · pendingPlan：随本轮结果（停在用户确认门的事实不跨步累积）；
 *   · activatedPlan：按"事实持续"累积而不是每轮重置——计划在平台侧仍然激活着，本回合
 *     任一步报过这个事实，它就一直成立（P1 收尾兜底）；
 *   · clarification：与 execution 同模式积累——计划模式跨步累积（任一步撞上歧义，本回合
 *     就以澄清收口），单步模式随本轮结果（没有就没有）。
 */
export function accumulateDelegation(state: TurnState, step: PlanStepLabel | null, delegated: SubagentTaskResult): void {
  if (step) state.planSteps += 1;
  state.execution = step ? (delegated.execution ?? state.execution) : (delegated.execution ?? null);
  state.pendingPlan = delegated.pendingPlan ?? null;
  state.activatedPlan = delegated.activatedPlan ?? state.activatedPlan;
  state.clarification = step ? (delegated.clarification ?? state.clarification) : (delegated.clarification ?? null);
}
