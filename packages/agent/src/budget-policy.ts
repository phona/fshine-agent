/**
 * 通用预算档位策略（宿主侧，业务无关）。
 *
 * 归属口径（协议缺省单一源在宿主）：
 * · 本模块是通用预算协议的缺省档位策略：输入只有调用数、估时秒、权重、
 *   档位阈值、扩容档（grantLevel）、是否有历史计划——不含任何业务实体、
 *   业务 operation 名、业务默认参数。换一个执行层后仍成立：执行层只需经
 *   声明面（operation 清单）声明每条 operation 的 est_seconds / 权重 /
 *   副作用，宿主按本模块裁档。
 * · 12 个阈值缺省（calls 2/10/20/50，seconds 60/180/600/1800，weight
 *   6/18/60/180）是通用预算协议的缺省档位线，单一真相源在本文件；数字级
 *   出处与对齐史见 debt-ledger「W1 provenance 移入」条目。执行层可声明
 *   更严的硬上限，并由执行端门在实际调用处复核。
 * · 双门并行期（平台计划门原样保留至迁移完成）：执行端门（evaluate 裁档
 *   与调用处硬上限复核）与宿主叠加档并存、不删任何一处——删宿主这处，
 *   `stricterTier` 叠加档无档可叠；删执行端门，执行端复核消失。宿主档只
 *   收紧不放宽：执行层调高/调低自己的阈值线时，宿主侧仍以更严一档为准
 *   （见 `stricterTier`）。两侧判据必须一致——改任一侧的这 12 个数字必须
 *   同批对齐另一侧，漂移由机械校验兜底（校验脚本、CI 边界与归属迁移的
 *   关账口径见 debt-ledger D-150/D-151；迁移期该校验不进宿主 CI）。
 *   执行层 policy 另有 4 个平台门专属项（grindGap 30、maxNotify 3、
 *   maxReplans 8、maxVariants 3），宿主叠加档不实现磨大守卫与变体预算，
 *   故有意不镜像——它们不是漂移项。
 * · 本模块已接入计划评估主路径（第 1 包收尾）：plan-runtime 的
 *   evaluateAndActivatePlan 在执行层 decision 之上叠加本模块的宿主档，
 *   更严为准；执行层 decision 仍保留作防线。weight 由执行层 evaluate
 *   响应的 estimate.weight 下发（本接口只是立约，不改档位语义、不改执行
 *   端门）；weight 缺失时宿主 fail-closed。
 */
export type BudgetTier = 'execute' | 'notify' | 'confirm' | 'stop';

export interface BudgetThresholds {
  autoCalls: number;
  notifyCalls: number;
  confirmCalls: number;
  hardCalls: number;
  autoSeconds: number;
  notifySeconds: number;
  confirmSeconds: number;
  hardSeconds: number;
  autoWeight: number;
  notifyWeight: number;
  budgetWeight: number;
  hardWeight: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  autoCalls: 2,
  notifyCalls: 10,
  confirmCalls: 20,
  hardCalls: 50,
  autoSeconds: 60,
  notifySeconds: 180,
  confirmSeconds: 600,
  hardSeconds: 1800,
  autoWeight: 6,
  notifyWeight: 18,
  budgetWeight: 60,
  hardWeight: 180,
};

export interface BudgetInput {
  calls: number;
  seconds: number;
  weight: number;
  /** 用户确认容量边缘计划后授予的扩容档，缺省 0；阈值 ×(1+grantLevel)。 */
  grantLevel?: number;
  /** 是否已有历史计划（影响 auto 以上档的 reasonCode 措辞，不影响档位）。 */
  previous?: boolean;
}

export interface BudgetDecision {
  tier: BudgetTier;
  reasonCode: string;
}

const RANK: Record<BudgetTier, number> = { execute: 0, notify: 1, confirm: 2, stop: 3 };

/** 更严一档；同档时取第一个（调用方把宿主档放前面时宿主优先）。 */
export function stricterTier(a: BudgetTier, b: BudgetTier): BudgetTier {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * 通用档位裁决：calls/seconds 线与 weight 线各自出档、取更严一档；
 * reason 取决定最终档的那条线（同档时 calls/seconds 线优先——与
 * 平台 decision() 的 tie-break 一致，旧调用方认的词汇不因权重线改口）。
 */
export function decideBudgetTier(input: BudgetInput, thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS): BudgetDecision {
  const scale = 1 + (input.grantLevel ?? 0);
  const previous = input.previous ?? false;
  let tier: BudgetTier;
  let reason: string;
  if (input.calls > thresholds.hardCalls * scale || input.seconds > thresholds.hardSeconds * scale) [tier, reason] = ['stop', 'HARD_LIMIT'];
  else if (input.calls > thresholds.confirmCalls * scale || input.seconds > thresholds.confirmSeconds * scale) [tier, reason] = ['confirm', 'CONFIRM_THRESHOLD'];
  else if (input.calls > thresholds.notifyCalls * scale || input.seconds > thresholds.notifySeconds * scale) [tier, reason] = ['notify', 'NOTIFY_THRESHOLD'];
  else if (input.calls > thresholds.autoCalls * scale || input.seconds > thresholds.autoSeconds * scale) [tier, reason] = ['notify', previous ? 'SCOPE_EXPANSION' : 'INITIAL_SCOPE_THRESHOLD'];
  else [tier, reason] = ['execute', 'WITHIN_AUTO_THRESHOLD'];
  let weightTier: BudgetTier;
  let weightReason: string;
  if (input.weight > thresholds.hardWeight * scale) [weightTier, weightReason] = ['stop', 'HARD_WEIGHT'];
  else if (input.weight >= thresholds.budgetWeight * scale) [weightTier, weightReason] = ['confirm', 'BUDGET_WEIGHT'];
  else if (input.weight > thresholds.notifyWeight * scale) [weightTier, weightReason] = ['notify', 'NOTIFY_THRESHOLD'];
  else if (input.weight > thresholds.autoWeight * scale) [weightTier, weightReason] = ['notify', previous ? 'SCOPE_EXPANSION' : 'INITIAL_SCOPE_THRESHOLD'];
  else [weightTier, weightReason] = ['execute', 'WITHIN_AUTO_THRESHOLD'];
  return RANK[weightTier] > RANK[tier] ? { tier: weightTier, reasonCode: weightReason } : { tier, reasonCode: reason };
}

/**
 * operation 权重缺省换算（通用协议缺省换算语义，业务无关）：
 * 有正权重用权重；否则按 est_seconds/10 四舍五入、下限 1；都没有则 1。
 * 执行层已声明权重时宿主不做换算——本函数只用于缺省补位。
 */
export function weightOfOperation(op: { weight?: unknown; est_seconds?: unknown }): number {
  const w = op.weight;
  if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w;
  const est = op.est_seconds;
  if (typeof est === 'number' && Number.isFinite(est) && est > 0) return Math.max(1, Math.round(est / 10));
  return 1;
}
