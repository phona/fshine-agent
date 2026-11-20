/**
 * 答复五态（outcome）：completed / partial / unsupported / blocked / failed。
 *
 * 判据档：docs/architecture/capability-boundary.md §3。本模块是**宿主侧的机械分类器**：
 * 输入 = 任务底账的机械事实（执行清单、逐条结果、终态、零执行原因、拒绝原因码），
 * 输出 = 五值之一。纯函数、表驱动、零模型、零文案（措辞由 Main 按值选）。
 *
 * 边界（写进单测，禁止回归）：
 *   · 零执行 + 权限拒绝 → blocked（不是 unsupported）：拒绝意味着「这件事目录里有，
 *     但本次不允许/缺条件」，与「根本没有这件事」是两回事。
 *   · 零执行 + 等用户补信息（没答） → blocked。
 *   · 先失败后成功（末条 completed） → completed：末次决定性结果说了算。
 *
 * 本模块不判断模型是否「说得对」——那归黑盒 Eval；这里只把机械事实归成五值。
 */

/** 一条执行事实（与底账 ExecutionRecord / 执行 outcome 的最小交集）。 */
export interface OutcomeExecution {
  /** 执行层 / 运行时的终态。 */
  status: 'completed' | 'failed' | 'refused' | 'needs_input' | 'needs_confirmation' | 'accepted' | 'result_unknown';
  /** 失败/拒绝的原因码（机械，来自执行层或宿主允许集合）。 */
  code?: string;
  error?: { code?: string };
  /** completed 携带的逐条结果（批量写）；含 failed/unknown = 部分完成。 */
  items?: readonly { status: 'ok' | 'failed' | 'unknown' }[];
}

/**
 * 宿主在**发起执行前**记录的零执行原因（底账机械事实，不是话术）。
 *   · 'permission_denied' = 允许集合/权限拒绝（本次不允许）；
 *   · 'awaiting_user'     = 等用户补信息（用户没答 / needs_input）。
 */
export type ZeroExecutionReason = 'permission_denied' | 'awaiting_user';

/** 分类器输入 = 任务底账的机械事实（不含任何自由文本话术）。 */
export interface OutcomeLedger {
  /** 已发起的执行调用（零执行 = 空数组）。 */
  executions: readonly OutcomeExecution[];
  /** 任务终态（底账 status）。 */
  terminal: 'completed' | 'failed' | 'timed_out' | 'unexecuted' | 'running' | 'waiting_user';
  /** 零执行原因（仅 executions 为空时有意义）。 */
  zeroReason?: ZeroExecutionReason;
  /** 终态失败的原因码（如 result_unknown / failed_confirmed）；权限拒绝只走 zeroReason。 */
  reasonCode?: string;
  /**
   * B3 结构化原因码（宿主/执行层传下来的码，不是文案）：`unsupported` / `not_permitted`。
   * 只用于零执行分支的可辨分类；缺省 = 不提供（退化为按 zeroReason/reasonCode 判定）。
   */
  outcomeReasonCode?: string;
}

/** 答复五值（互斥）。 */
export type TaskOutcome = 'completed' | 'partial' | 'unsupported' | 'blocked' | 'failed';

/**
 * 拒绝原因码集合（执行层策略拒绝 = 本次不允许，不是「没这个能力」）。
 * 与 user-facing-failure 的 deny 码表同源语义；这里只做机械归类，不解析文案。
 */
const PERMISSION_REJECT_CODES: ReadonlySet<string> = new Set([
  'GATE_REFUSE', 'FORBIDDEN', 'DENIED', 'OPERATION_NOT_PERMITTED', 'NOT_ALLOWED',
]);

function isPermissionReject(execution: OutcomeExecution): boolean {
  if (execution.error?.code !== undefined && PERMISSION_REJECT_CODES.has(execution.error.code)) return true;
  return execution.code !== undefined && PERMISSION_REJECT_CODES.has(execution.code);
}

/**
 * 机械分类器：任务底账事实 → 五值之一。表驱动、无副作用、无话术。
 */
export function classifyOutcome(ledger: OutcomeLedger): TaskOutcome {
  const { executions, terminal } = ledger;

  // ——零执行：先判「有能力但缺条件」，再判「根本没有这件事」——
  if (executions.length === 0) {
    // B3 结构化原因码优先：宿主/执行层传下来的码，不看任何文案（如「权限」字样）。
    if (ledger.outcomeReasonCode === OUTCOME_REASON_NOT_PERMITTED) return 'blocked';
    if (ledger.outcomeReasonCode === OUTCOME_REASON_UNSUPPORTED) return 'unsupported';
    // 权限拒绝（本次不允许）或等用户补信息（用户没答）→ blocked，绝不是 unsupported。
    if (ledger.zeroReason === 'permission_denied' || ledger.zeroReason === 'awaiting_user') return 'blocked';
    if (terminal === 'waiting_user') return 'blocked';
    if ((terminal === 'failed' || terminal === 'timed_out')
      && ledger.reasonCode !== undefined && PERMISSION_REJECT_CODES.has(ledger.reasonCode)) return 'blocked';
    // 零执行且不是权限拒绝/等待 → 目录里根本没有这件事（没有办理动作发生）。
    return 'unsupported';
  }

  // ——有执行：终态失败优先（执行发生过且终态失败 → failed）——
  // 末条执行 = 决定性结果（先失败后成功 → completed；末条 completed 不被前序失败翻转）。
  const decisive = executions[executions.length - 1]!;
  if (terminal === 'failed' || terminal === 'timed_out') return 'failed';
  if (decisive.status === 'failed' || decisive.status === 'refused' || decisive.status === 'result_unknown') {
    return 'failed';
  }

  // 等用户补信息（有执行，卡在 needs_input / needs_confirmation / waiting_user） → blocked。
  if (decisive.status === 'needs_input' || decisive.status === 'needs_confirmation' || terminal === 'waiting_user') {
    return 'blocked';
  }

  // partial：completed 且 items 里有失败/未知项（无 items = 正常完成）。
  if (terminal === 'completed') {
    const completedItems = executions
      .filter((execution) => execution.status === 'completed')
      .flatMap((execution) => execution.items ?? []);
    if (completedItems.some((item) => item.status === 'failed' || item.status === 'unknown')) return 'partial';
  }

  return 'completed';
}

/**
 * B3：把「没有这个能力」与「这次不允许」拆成两个**可辨的事实 + 原因码**。
 *
 * 旧 `OPERATION_NOT_PERMITTED_MESSAGE` 同时用于两种情形，用户被混为一谈：
 *   · `unsupported`    = 目录里根本没有这件事（没有能力），零执行、非权限拒绝；
 *   · `not_permitted`  = 能力存在但本次不允许（权限/允许集合拒绝）。
 * 两个 reason code 是结构化事实，两个 message 是各自可辨的机械原因（不是对用户的话术，
 * 用户话术由 Main 按 outcome 值选）。既有工具调用拒绝话术保持原样（锚点不放宽）。
 */
export const OUTCOME_REASON_NOT_PERMITTED = 'not_permitted';
export const OUTCOME_REASON_UNSUPPORTED = 'unsupported';

/** 两种情形各自可辨的机械原因（只进事实/日志，不直接对用户说）。 */
export const OUTCOME_DETAIL_UNSUPPORTED = '没有对应能力：这件事不在可办范围内。';
export const OUTCOME_DETAIL_NOT_PERMITTED = '本次不允许：这件事需要的能力当前没有开放给你。';

/**
 * B2：把 outcome 值结构化带给 Main 的机械事实行（不是话术）。
 *
 * 形如 `[outcome=unsupported]`；blocked 额外带非空缺失条件 `[缺=<条件>]`，供 Main 说「缺什么」。
 *   · unsupported 的整条事实**不含**任何重试诱导词（G4 机械守卫）。
 *   · blocked 必须有非空 missing；缺失条件缺省时给中性占位，绝不留空。
 */
export function renderOutcomeFact(
  outcome: TaskOutcome,
  options: { missing?: string } = {},
): string {
  if (outcome === 'blocked') {
    const missing = options.missing !== undefined && options.missing.trim() !== ''
      ? options.missing.trim()
      : '本次允许范围或需要补充的信息';
    return `[outcome=blocked][缺=${missing}]`;
  }
  return `[outcome=${outcome}]`;
}

/** G4：unsupported 事实文本禁止出现的重试诱导词。 */
export const UNSUPPORTED_FACT_FORBIDDEN_WORDS: readonly string[] = ['再试一次', '重试', 'retry'];
