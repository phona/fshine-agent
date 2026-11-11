/**
 * T6：任务级预算账本 + 确认门时间顺序判据（2026-11-11）。
 *
 * 为什么需要任务级账本（今天 D2 两臂的败状）：宿主叠加档（plan-runtime 的
 * `decideBudgetTier` 叠加）此前只看**当前这一张**计划的 estimate——任务被切成多张
 * 都在确认线以下的小计划逐张提交时，每张都只裁到 notify（通知送达后继续执行），
 * 任务总重量早已越过确认线，用户却一次也没看到「请你确认」。本模块把"这个任务已经
 * 被授权花掉多少"记成账本，由宿主自己累计（平台的逐张裁决只作防线，不作唯一依据）。
 *
 * 判据两条，都可机判：
 *   ① 账本按**已激活计划**的 estimate 累计，同一 planId 重复激活不重复计数；
 *   ② 顺序判据（`confirmGateOrdering`）：进了 confirm 档之后、确认记录之前零执行；
 *      执行痕迹只能出现在确认记录之后（"确认前零执行，确认后才放行"）。
 *
 * 纯函数：不读时钟、不读网络、不打日志；缺证据（无 hold 记录 / 执行行缺 ts）按
 * INCONCLUSIVE 处置，绝不把"没有证据"当成"零执行"。
 */
import { DEFAULT_BUDGET_THRESHOLDS, decideBudgetTier, type BudgetDecision, type BudgetThresholds, type BudgetTier } from './budget-policy';

export interface TaskBudgetUsage {
  calls: number;
  seconds: number;
  weight: number;
}

export const ZERO_TASK_BUDGET: TaskBudgetUsage = { calls: 0, seconds: 0, weight: 0 };

export interface TaskBudgetLedger {
  /** planId → 该计划被授权花掉的 estimate（同一张计划只记一次）。 */
  readonly plans: ReadonlyMap<string, TaskBudgetUsage>;
}

export function emptyTaskBudgetLedger(): TaskBudgetLedger {
  return { plans: new Map() };
}

/** 非有限数 / 负数按 0 计：账本只许低估不许高估（高估会把没花的钱算成花掉的）。 */
function usageOf(value: TaskBudgetUsage): TaskBudgetUsage {
  const safe = (raw: number): number => (Number.isFinite(raw) && raw > 0 ? raw : 0);
  return { calls: safe(value.calls), seconds: safe(value.seconds), weight: safe(value.weight) };
}

export function withActivatedPlan(ledger: TaskBudgetLedger, planId: string, estimate: TaskBudgetUsage): TaskBudgetLedger {
  if (ledger.plans.has(planId)) return ledger;
  const plans = new Map(ledger.plans);
  plans.set(planId, usageOf(estimate));
  return { plans };
}

export function ledgerUsage(ledger: TaskBudgetLedger): TaskBudgetUsage {
  let calls = 0;
  let seconds = 0;
  let weight = 0;
  for (const usage of ledger.plans.values()) {
    calls += usage.calls;
    seconds += usage.seconds;
    weight += usage.weight;
  }
  return { calls, seconds, weight };
}

/**
 * 任务级累计档位（通用预算协议的宿主侧缺省档位线，与单张叠加档同一份
 * `decideBudgetTier` 实现、同一组数字）。`previous: true`：账本非空即"已有历史计划"，
 * auto 档以上措辞按扩容走。
 */
export function taskBudgetDecision(usage: TaskBudgetUsage, options: { thresholds?: BudgetThresholds } = {}): BudgetDecision {
  const safe = usageOf(usage);
  return decideBudgetTier(
    { calls: safe.calls, seconds: safe.seconds, weight: safe.weight, previous: true },
    options.thresholds ?? DEFAULT_BUDGET_THRESHOLDS,
  );
}

/** 确认门兜底只在 confirm / stop 两档生效（notify 的通知面语义不动，见驱动接线处）。 */
export function isConfirmGateTier(tier: BudgetTier): boolean {
  return tier === 'confirm' || tier === 'stop';
}

export type ConfirmGateOrdering = 'held' | 'released' | 'executed_before_confirmation' | 'inconclusive';

/**
 * 确认门时间顺序判据（机械判据的字面实现）：给执行痕迹（审计里被放行的调用）与
 * 用户确认记录（宿主持有），回答"确认前是否零执行"。
 *
 *   · `held`——进档（holdAt）之后没有任何执行痕迹：停住了；
 *   · `released`——进档之后的执行痕迹全部在一条确认记录之后：确认后才放行；
 *   · `executed_before_confirmation`——进档之后、确认记录之前有执行（含"根本没有确认
 *     记录却有执行"）：越门先行，判红；
 *   · `inconclusive`——拿不到判据（没有 hold 记录；或某条执行行缺时间戳）：如实记
 *     INCONCLUSIVE，不当成零执行。
 */
export function confirmGateOrdering(input: {
  /** 宿主裁到 confirm/stop 档的时刻（没有它无法谈"确认前"）。 */
  holdAt?: string;
  confirmations: readonly { at: string; planId?: string }[];
  /** 执行痕迹（审计里被放行的调用），按时间戳判位置；缺 ts = 判不了。 */
  executions: readonly { ts?: string; planId?: string }[];
}): ConfirmGateOrdering {
  const { holdAt } = input;
  if (!holdAt) return 'inconclusive';
  if (input.executions.some((row) => !row.ts)) return 'inconclusive';
  const afterHold = input.executions.filter((row) => row.ts! >= holdAt);
  if (afterHold.length === 0) return 'held';
  const release = [...input.confirmations]
    .filter((row) => row.at >= holdAt)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!release) return 'executed_before_confirmation';
  return afterHold.every((row) => row.ts! >= release.at) ? 'released' : 'executed_before_confirmation';
}
