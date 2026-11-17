/**
 * SimCase · 两维失败归因（技能链路 × 业务链路）。
 *
 * 定位：**只解释，不改判**。`trial.pass` 仍只由 `./oracle` 决定；本模块只从 trial 已有
 * 的机械证据派生两维检查值，供「按臂计数表」与人工复核使用。
 *
 * 写死口径（三条，不随实现调整）：
 *   1. **没调用 `read_skill` ≠ 业务失败**：业务链路五项独立归因，归因函数**不读**技能链路
 *      字段；没读技能只让技能链路停在「读取」一项，不得把业务项记假。
 *   2. **调用了 `read_skill` ≠ 技能有效**：只有「读取成功后业务方法在回复里可核对地体现」
 *      才记技能有效（`effective`）；读取动作本身、读取成功本身都不构成有效。
 *   3. **最终业务交付正确是主判据**：`finalDelivery` 原样取 Oracle 结论（`pass` 的唯一
 *      来源）；归因输出不得改写任何 trial 的 `pass`。
 *
 * 检查值三态：`true` / `false` / `null`。`null` = 不可观测或不适用（未声明判据、Oracle
 * 未运行、Harness 缺陷…），**不计入「假」**——不把「没观测到」冒充成失败。
 * 同一 trial **允许多项为假**（例如「读取失败」与「方法未体现」同时为假）。
 *
 * 各检查项都是**机械代理**，不是新的真值来源；代理的具体口径见每个函数注释。
 */
import type { SimTerminal } from './case';
import type { SimExecutionFact } from './oracle';
import type { SimTrialResult } from './run';
import type { SimSkillRead } from './skill-telemetry';
import { hasRepeatedUserIntent } from './simulator';

// ─────────────────────────────────────────────────────────────────────────────
// 三条口径（写死；进报告与证据）
// ─────────────────────────────────────────────────────────────────────────────

export type SimAttributionRuleId =
  | 'no-read-skill-is-not-business-failure'
  | 'read-skill-is-not-skill-effective'
  | 'final-business-delivery-is-primary';

export interface SimAttributionRule {
  readonly id: SimAttributionRuleId;
  readonly statement: string;
}

/** 三条口径原文；报告原样引用，测试逐条断言。 */
export const ATTRIBUTION_RULES: readonly SimAttributionRule[] = Object.freeze([
  {
    id: 'no-read-skill-is-not-business-failure',
    statement: '没调用 read_skill ≠ 业务失败：业务链路独立归因，不因未读技能把任何业务项记为假。',
  },
  {
    id: 'read-skill-is-not-skill-effective',
    statement: '调用了 read_skill ≠ 技能有效：只有读取成功后业务方法在回复里可核对地体现，才记技能有效。',
  },
  {
    id: 'final-business-delivery-is-primary',
    statement: '最终业务交付正确（Oracle 判定）是主判据；归因只解释，不改 pass。',
  },
] as const);

/** 主判据检查项（固定为业务链路第五项）。 */
export const ATTRIBUTION_PRIMARY_CHECK = 'finalDelivery' as const;

// ─────────────────────────────────────────────────────────────────────────────
// 检查值 / 检查项
// ─────────────────────────────────────────────────────────────────────────────

/** `null` = 不可观测或不适用，不计入「假」。 */
export type SimCheckValue = boolean | null;

export type SimSkillCheckId =
  | 'catalogDiscovered'
  | 'read'
  | 'readSucceeded'
  | 'methodReflected'
  | 'effective';

export type SimBusinessCheckId =
  | 'intentUnderstood'
  | 'delegationFidelity'
  | 'dataAcquired'
  | 'businessComputed'
  | 'finalDelivery';

/** 技能链路四项（`effective` 是派生读数，不属于四项本体）。 */
export const SKILL_CHECK_ORDER: readonly SimSkillCheckId[] = Object.freeze([
  'catalogDiscovered', 'read', 'readSucceeded', 'methodReflected', 'effective',
]);

/** 业务链路五项（顺序即「意图理解 → 拆解与委派 → 取数 → 计算 → 交付」）。 */
export const BUSINESS_CHECK_ORDER: readonly SimBusinessCheckId[] = Object.freeze([
  'intentUnderstood', 'delegationFidelity', 'dataAcquired', 'businessComputed', 'finalDelivery',
]);

export const SKILL_CHECK_LABELS: Readonly<Record<SimSkillCheckId, string>> = Object.freeze({
  catalogDiscovered: 'Catalog 发现',
  read: '调用 read_skill',
  readSucceeded: '读取成功',
  methodReflected: '读取后体现业务方法',
  effective: '技能有效（派生：仅方法体现才算）',
});

export const BUSINESS_CHECK_LABELS: Readonly<Record<SimBusinessCheckId, string>> = Object.freeze({
  intentUnderstood: '意图理解',
  delegationFidelity: '拆解与委派保真',
  dataAcquired: '数据获取',
  businessComputed: '业务计算',
  finalDelivery: '最终交付（主判据）',
});

/** 归因判据声明：缺省项 = 不评判（`null`），不得由归因模块凭猜补判。 */
export interface SimAttributionExpectations {
  /** 期望执行的 operation 名（业务拆解口径）；缺省 = 不评判委派保真。 */
  readonly expectedOperations?: readonly string[];
  /** 该 trial 是否必须取数；缺省 = 有执行事实才判，否则不可判。 */
  readonly requiresData?: boolean;
  /** 该 trial 是否需要业务计算；缺省 = Oracle id 以 `fact:` 开头才算需要。 */
  readonly requiresComputation?: boolean;
  /** 技能读取后应体现的业务方法标记（全部出现才算体现）；缺省 = 不评判。 */
  readonly methodMarkers?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 单 trial 归因
// ─────────────────────────────────────────────────────────────────────────────

/** 检查项的不可观测原因（只对 `null` 项出现；明确标注，不静默留空）。 */
export type SimUnobservableReasons<Id extends string> = Readonly<Partial<Record<Id, string>>>;

export interface SimSkillAttribution {
  readonly catalogDiscovered: SimCheckValue;
  readonly read: SimCheckValue;
  readonly readSucceeded: SimCheckValue;
  readonly methodReflected: SimCheckValue;
  /** 派生：`methodReflected === true` 才为 true；read/readSucceeded 不单独构成有效。 */
  readonly effective: SimCheckValue;
  /** 每个 `null` 项的原因（证据里可直接读，不用从 notes 里猜）。 */
  readonly unobservable: SimUnobservableReasons<SimSkillCheckId>;
  readonly reads: readonly SimSkillRead[];
  readonly notes: readonly string[];
}

export interface SimBusinessAttribution {
  readonly intentUnderstood: SimCheckValue;
  readonly delegationFidelity: SimCheckValue;
  readonly dataAcquired: SimCheckValue;
  readonly businessComputed: SimCheckValue;
  readonly finalDelivery: SimCheckValue;
  /** 每个 `null` 项的原因（证据里可直接读，不用从 notes 里猜）。 */
  readonly unobservable: SimUnobservableReasons<SimBusinessCheckId>;
  readonly notes: readonly string[];
}

export interface SimTrialAttribution {
  readonly caseId: string;
  readonly trial: number;
  readonly terminal: SimTerminal | null;
  /** 原样来自 trial.pass（Oracle 决定）；归因不改它。 */
  readonly pass: boolean;
  readonly skill: SimSkillAttribution;
  readonly business: SimBusinessAttribution;
  /** 两条链路不可观测项的原因（便于按臂汇总；不是判定）。 */
  readonly unobservable: {
    readonly skill: SimUnobservableReasons<SimSkillCheckId>;
    readonly business: SimUnobservableReasons<SimBusinessCheckId>;
  };
  /** 三条口径原文（随归因一起输出，避免解释与口径脱节）。 */
  readonly rules: readonly SimAttributionRule[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 技能链路归因（四项本体 + 派生「技能有效」）。只读 `trial.skills`。 */
function attributeSkill(
  trial: SimTrialResult,
  expectations: SimAttributionExpectations,
): SimSkillAttribution {
  const notes: string[] = [];
  const unobservable: Partial<Record<SimSkillCheckId, string>> = {};
  const discovery = trial.skills.discovery;

  // ① Catalog 是否发现：available=false（未观测）→ null；发现了但清单为空 → false。
  const catalogDiscovered: SimCheckValue = discovery.available ? discovery.names.length > 0 : null;
  if (!discovery.available) {
    const reason = '未观测到技能面（discovery.available=false）：Catalog 发现不可判';
    unobservable.catalogDiscovered = reason;
    notes.push(reason);
  }

  // ② 是否读取：有调用即 true（含失败）。
  const read: SimCheckValue = trial.skills.read;
  const successful = trial.skills.reads.filter((entry) => entry.ok);
  // ③ 读取是否成功：没读 → false（读取环节未发生，谈不上成功）。
  const readSucceeded: SimCheckValue = successful.length > 0;
  if (!read && readSucceeded === false) notes.push('未调用 read_skill：技能链路停在「读取」一项（不等于业务失败）');
  for (const failed of trial.skills.reads.filter((entry) => !entry.ok)) {
    notes.push(`读取失败：name=${failed.name} reason=${failed.rejection?.kind ?? 'failed'} ${failed.failure ?? ''}`.trim());
  }

  // ④ 读取后是否体现业务方法：需要「成功读取」+「声明的业务方法标记」。
  let methodReflected: SimCheckValue;
  const markers = expectations.methodMarkers;
  if (markers === undefined || markers.length === 0) {
    methodReflected = null;
    const reason = '用例未声明 methodMarkers：读取正文只能证明「读了哪份」，不能证明业务方法被用上——该项不可观测';
    unobservable.methodReflected = reason;
    notes.push(reason);
  } else if (successful.length === 0) {
    methodReflected = false;
    notes.push('没有成功的技能读取：方法体现记为假');
  } else {
    const firstTurn = Math.min(...successful.map((entry) => entry.turn));
    const afterRead = trial.replies.slice(Math.max(0, firstTurn - 1)).join('\n');
    const missing = markers.filter((marker) => !normalize(afterRead).includes(normalize(marker)));
    methodReflected = missing.length === 0;
    if (missing.length > 0) notes.push(`读取后回复缺少业务方法标记：${missing.join('、')}`);
  }

  // 派生「技能有效」：口径 2 —— 只有方法体现才算有效；读取动作/读取成功都不算。
  const effective: SimCheckValue = methodReflected === null ? null : methodReflected === true;
  if (effective === null) {
    unobservable.effective = '派生自 methodReflected（不可观测），因此「技能有效」同样不可观测';
  }

  return {
    catalogDiscovered,
    read,
    readSucceeded,
    methodReflected,
    effective,
    unobservable,
    reads: trial.skills.reads,
    notes,
  };
}

/**
 * 业务链路归因。**不读取 `trial.skills`**（口径 1 的结构性保证：没读技能不会让业务项变假）。
 */
function attributeBusiness(
  trial: SimTrialResult,
  expectations: SimAttributionExpectations,
): SimBusinessAttribution {
  const notes: string[] = [];
  const unobservable: Partial<Record<SimBusinessCheckId, string>> = {};
  const harnessBroken = trial.terminal === null;

  // ① 意图理解：系统给首条消息非空回复，且用户没有被同一意图反复追问（重复守卫口径）。
  let intentUnderstood: SimCheckValue;
  if (harnessBroken) {
    intentUnderstood = null;
    const reason = 'Harness/协议缺陷（terminal=null）：意图理解不可判';
    unobservable.intentUnderstood = reason;
    notes.push(reason);
  } else if (trial.replies.length === 0) {
    intentUnderstood = null;
    const reason = '没有任何系统回复：意图理解不可判';
    unobservable.intentUnderstood = reason;
    notes.push(reason);
  } else {
    const firstReply = trial.replies[0] ?? '';
    const said = trial.messages.filter((message) => message.action === 'say').map((message) => message.text ?? '');
    const repeated = hasRepeatedUserIntent(said);
    intentUnderstood = firstReply.trim() !== '' && !repeated;
    if (firstReply.trim() === '') notes.push('首条系统回复为空');
    if (repeated) notes.push('用户被迫反复表达同一意图（重复守卫命中）');
  }

  // ② 拆解与委派保真：只有用例声明 expectedOperations 才可判（覆盖全部期望 operation 即真）。
  let delegationFidelity: SimCheckValue;
  const expected = expectations.expectedOperations;
  if (harnessBroken) {
    delegationFidelity = null;
    unobservable.delegationFidelity = 'Harness/协议缺陷（terminal=null）：拆解与委派保真不可判';
  } else if (expected === undefined || expected.length === 0) {
    delegationFidelity = null;
    const reason = '用例未声明 expectedOperations（无机械真值来源）：拆解与委派保真不可观测';
    unobservable.delegationFidelity = reason;
    notes.push(reason);
  } else {
    const executed = new Set(trial.executions.map((execution: SimExecutionFact) => execution.operation));
    const missing = expected.filter((operation) => !executed.has(operation));
    delegationFidelity = missing.length === 0;
    if (missing.length > 0) notes.push(`期望执行未发生：${missing.join('、')}`);
  }

  // ③ 数据获取：有执行事实时看是否有 status=completed；无执行时按声明判。
  let dataAcquired: SimCheckValue;
  const requiresData = expectations.requiresData;
  const completed = trial.executions.filter((execution) => execution.status === 'completed');
  if (harnessBroken || requiresData === false) {
    dataAcquired = null;
    if (requiresData === false) {
      unobservable.dataAcquired = '用例声明为不需要取数：数据获取不适用（不是失败）';
      notes.push(unobservable.dataAcquired);
    } else {
      unobservable.dataAcquired = 'Harness/协议缺陷（terminal=null）：数据获取不可判';
    }
  } else if (trial.executions.length > 0) {
    dataAcquired = completed.length > 0;
    if (completed.length === 0) notes.push('有执行事实但没有一次 completed');
  } else if (requiresData === true) {
    dataAcquired = false;
    notes.push('声明为必须取数，但没有任何执行事实');
  } else {
    dataAcquired = null;
    const reason = '无执行事实且用例未声明 requiresData：取数失败与「无需取数」不可区分——该项不可观测';
    unobservable.dataAcquired = reason;
    notes.push(reason);
  }

  // ④ 业务计算：交付里是否出现可核对的数值（正确性归最终交付，不在此重复判真值）。
  let businessComputed: SimCheckValue;
  const oracleId = trial.oracle?.id ?? '';
  const requiresComputation = expectations.requiresComputation ?? oracleId.startsWith('fact:');
  if (harnessBroken || requiresComputation === false) {
    businessComputed = null;
    unobservable.businessComputed = harnessBroken
      ? 'Harness/协议缺陷（terminal=null）：业务计算不可判'
      : '用例声明为不需要业务计算：该项不适用（不是失败）';
  } else {
    const finalReply = trial.replies[trial.replies.length - 1] ?? '';
    if (finalReply.trim() === '') {
      businessComputed = false;
      notes.push('最终回复为空：没有可核对的业务计算结果');
    } else {
      businessComputed = /[0-9]/.test(finalReply);
      if (businessComputed === false) notes.push('最终回复没有任何数值：业务计算未体现');
    }
  }

  // ⑤ 最终交付（主判据）：原样取 Oracle 结论；Oracle 未运行 → 不可判（不是假）。
  const judged = !harnessBroken && trial.oracle !== null;
  const finalDelivery: SimCheckValue = judged
    ? (trial.oracle as NonNullable<SimTrialResult['oracle']>).verdict.pass === true
    : null;
  if (!judged) {
    const reason = 'Oracle 未运行：最终交付未被判定（不冒充失败）';
    unobservable.finalDelivery = reason;
    notes.push(reason);
  }

  return {
    intentUnderstood,
    delegationFidelity,
    dataAcquired,
    businessComputed,
    finalDelivery,
    unobservable,
    notes,
  };
}

/**
 * 归因一个 trial。纯函数：只读 `trial`，不写回、不改 `pass`。
 * 三个样例（没读但交付正确 / 读了但交付错误 / 读失败）的预期行为见 `attribution.test.ts`。
 */
export function attributeTrial(
  trial: SimTrialResult,
  expectations: SimAttributionExpectations = {},
): SimTrialAttribution {
  const skill = attributeSkill(trial, expectations);
  const business = attributeBusiness(trial, expectations);
  return {
    caseId: trial.caseId,
    trial: trial.trial,
    terminal: trial.terminal,
    // 口径 3：pass 原样透传，归因不参与判定。
    pass: trial.pass,
    skill,
    business,
    unobservable: { skill: skill.unobservable, business: business.unobservable },
    rules: ATTRIBUTION_RULES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 按臂两维计数表
// ─────────────────────────────────────────────────────────────────────────────

export interface SimCheckCounts {
  readonly true: number;
  readonly false: number;
  /** 不可观测或不适用（不计入「假」）。 */
  readonly unobserved: number;
}

export interface SimArmAttributionSummary {
  readonly arm: string;
  readonly trials: number;
  readonly passed: number;
  readonly skill: Readonly<Record<SimSkillCheckId, SimCheckCounts>>;
  readonly business: Readonly<Record<SimBusinessCheckId, SimCheckCounts>>;
  /** 未观测项的原因 → 次数（明确标注，不留空）。 */
  readonly unobservable: {
    readonly skill: Readonly<Record<SimSkillCheckId, Readonly<Record<string, number>>>>;
    readonly business: Readonly<Record<SimBusinessCheckId, Readonly<Record<string, number>>>>;
  };
}

export interface SimAttributedTrial extends SimTrialAttribution {
  readonly arm: string;
}

export interface SimArmAttributionTable {
  readonly arms: readonly SimArmAttributionSummary[];
  /** 全部 trial 的逐条归因（臂标签已并入）。 */
  readonly trials: readonly SimAttributedTrial[];
  /** 机械核对：归因输出的 pass 与输入 trial.pass 逐条一致（必须恒为 true）。 */
  readonly passUnchanged: boolean;
  readonly rules: readonly SimAttributionRule[];
}

function emptyCounts(): { true: number; false: number; unobserved: number } {
  return { true: 0, false: 0, unobserved: 0 };
}

function addCheck(counts: SimCheckCounts, value: SimCheckValue): void {
  const target = counts as { true: number; false: number; unobserved: number };
  if (value === null) target.unobserved += 1;
  else if (value) target.true += 1;
  else target.false += 1;
}

export interface SimArmTrials {
  readonly arm: string;
  readonly trials: readonly SimTrialResult[];
}

/**
 * 构造按臂两维计数表。同一 trial 多项为假时逐项各计一次（不是单选归因）。
 *
 * `expectations` 按 caseId 提供；缺省 = 各用例只判可机械观测的项（其余记未观测）。
 */
export function buildArmAttributionTable(
  arms: readonly SimArmTrials[],
  expectations?: ReadonlyMap<string, SimAttributionExpectations>,
): SimArmAttributionTable {
  const attributed: SimAttributedTrial[] = [];
  const summaries: SimArmAttributionSummary[] = [];
  let passUnchanged = true;

  for (const arm of arms) {
    const skill = Object.fromEntries(SKILL_CHECK_ORDER.map((id) => [id, emptyCounts()])) as Record<SimSkillCheckId, SimCheckCounts>;
    const business = Object.fromEntries(BUSINESS_CHECK_ORDER.map((id) => [id, emptyCounts()])) as Record<SimBusinessCheckId, SimCheckCounts>;
    const reasons = {
      skill: Object.fromEntries(SKILL_CHECK_ORDER.map((id) => [id, {} as Record<string, number>])) as Record<SimSkillCheckId, Record<string, number>>,
      business: Object.fromEntries(BUSINESS_CHECK_ORDER.map((id) => [id, {} as Record<string, number>])) as Record<SimBusinessCheckId, Record<string, number>>,
    };
    for (const trial of arm.trials) {
      const attribution = attributeTrial(trial, expectations?.get(trial.caseId));
      // 归因是只读投影：pass 必须原样等于输入。不等即机制缺陷（报告如实记 false）。
      if (attribution.pass !== trial.pass) passUnchanged = false;
      for (const id of SKILL_CHECK_ORDER) addCheck(skill[id], attribution.skill[id]);
      for (const id of BUSINESS_CHECK_ORDER) addCheck(business[id], attribution.business[id]);
      // 每个 null 项必须带原因（明确标注不可观测，而不是留空）。
      for (const id of SKILL_CHECK_ORDER) {
        const reason = attribution.skill.unobservable[id];
        if (attribution.skill[id] === null && reason === undefined) {
          throw new Error(`归因缺陷：${arm.arm}/${trial.caseId} 的技能项 ${id} 为 null 但没有不可观测原因`);
        }
        if (reason !== undefined) reasons.skill[id][reason] = (reasons.skill[id][reason] ?? 0) + 1;
      }
      for (const id of BUSINESS_CHECK_ORDER) {
        const reason = attribution.business.unobservable[id];
        if (attribution.business[id] === null && reason === undefined) {
          throw new Error(`归因缺陷：${arm.arm}/${trial.caseId} 的业务项 ${id} 为 null 但没有不可观测原因`);
        }
        if (reason !== undefined) reasons.business[id][reason] = (reasons.business[id][reason] ?? 0) + 1;
      }
      attributed.push({ ...attribution, arm: arm.arm });
    }
    summaries.push({
      arm: arm.arm,
      trials: arm.trials.length,
      passed: arm.trials.filter((trial) => trial.pass).length,
      skill,
      business,
      unobservable: reasons,
    });
  }

  return { arms: summaries, trials: attributed, passUnchanged, rules: ATTRIBUTION_RULES };
}

function countsCell(counts: SimCheckCounts | undefined): string {
  if (counts === undefined) return '—';
  return `${counts.true}/${counts.false}/${counts.unobserved}`;
}

/**
 * 渲染 Markdown 两维计数表（每臂三列：真/假/未观测）。
 * 只解释：表头显式写出 pass 未变与三条口径。
 */
export function renderArmAttributionTable(table: SimArmAttributionTable): string {
  const lines: string[] = [];
  lines.push('两维失败归因（**只解释，不改 pass**）：');
  lines.push('');
  lines.push(`- pass 未变：${table.passUnchanged ? 'true' : 'false'}（逐 trial 核对归因 pass 与 Oracle 判定一致）`);
  for (const rule of table.rules) lines.push(`- 口径 \`${rule.id}\`：${rule.statement}`);
  lines.push('- 单元格 = `真/假/未观测`；未观测 = 不可观测或不适用，**不计入假**；同一 trial 允许多项为假。');
  lines.push('');
  const armIds = table.arms.map((arm) => arm.arm);
  lines.push(`| 维度 | 检查项 | ${armIds.map((arm) => `${arm} 真/假/未观测`).join(' | ')} |`);
  lines.push(`| --- | --- | ${armIds.map(() => '---').join(' | ')} |`);
  for (const id of SKILL_CHECK_ORDER) {
    const cells = table.arms.map((arm) => countsCell(arm.skill[id])).join(' | ');
    lines.push(`| 技能链路 | ${SKILL_CHECK_LABELS[id]} | ${cells} |`);
  }
  for (const id of BUSINESS_CHECK_ORDER) {
    const cells = table.arms.map((arm) => countsCell(arm.business[id])).join(' | ');
    const suffix = id === ATTRIBUTION_PRIMARY_CHECK ? ' **（主判据）**' : '';
    lines.push(`| 业务链路 | ${BUSINESS_CHECK_LABELS[id]}${suffix} | ${cells} |`);
  }
  lines.push('');
  // 未观测不是留空：逐项给出原因与次数（复核时能直接判断「缺字段」还是「本就不可判」）。
  lines.push('未观测项原因（**明确标注，非留空**）：');
  lines.push('');
  lines.push('| 臂 | 维度 | 检查项 | 原因 | 次数 |');
  lines.push('| --- | --- | --- | --- | --- |');
  let anyReason = false;
  for (const arm of table.arms) {
    for (const id of SKILL_CHECK_ORDER) {
      for (const [reason, count] of Object.entries(arm.unobservable.skill[id])) {
        anyReason = true;
        lines.push(`| ${arm.arm} | 技能链路 | ${SKILL_CHECK_LABELS[id]} | ${reason} | ${count} |`);
      }
    }
    for (const id of BUSINESS_CHECK_ORDER) {
      for (const [reason, count] of Object.entries(arm.unobservable.business[id])) {
        anyReason = true;
        lines.push(`| ${arm.arm} | 业务链路 | ${BUSINESS_CHECK_LABELS[id]} | ${reason} | ${count} |`);
      }
    }
  }
  if (!anyReason) lines.push('| — | — | — | 无（所有检查项均可观测） | 0 |');
  lines.push('');
  lines.push(`| 臂 | 样本 | pass（Oracle） |`);
  lines.push('| --- | --- | --- |');
  for (const arm of table.arms) lines.push(`| ${arm.arm} | ${arm.trials} | ${arm.passed} |`);
  return lines.join('\n');
}
