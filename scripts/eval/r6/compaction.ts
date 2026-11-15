/**
 * R6 测试基建 · 压缩生命周期判据（Pi 原生生命周期行为判据；确定性、零模型）。
 *
 * 关键纪律（owner ③.1）：CMP1–CMP9 与 H6 **不得**绑定 fshine 私有事件/函数/重试常量
 * （`context_compacted` / `splitForCompaction` / `MAIN_MODEL_RETRY_DELAYS_MS` /
 * `MAX_SUMMARY_CHUNKS` 等——这些随 Pi 迁移将删除）。本模块改为面向 **Pi 原生 Session/Harness
 * 生命周期**的可观测行为：
 *   · 「压缩尝试（compaction attempt）」= Pi Session 生命周期暴露的一次上下文缩减动作，
 *     带 `before/after` token 与触发类别（`threshold` / `overflow` / `post_turn`）；
 *   · 「有界性」= **观测到的计数**相对**预注册上限**（不是私有常数）；
 *   · 触发原因不可归类 → `evidence_gap`（登记，不冒充判负）。
 *
 * 本模块是**纯函数面**：不 import 产品运行时、不读阈值、不改触发/门控。它只对已观测事实做算术。
 */

/** Pi 原生生命周期里的一次压缩尝试（由会话生命周期面提供；测试用假会话供给）。 */
export interface CompactionAttempt {
  readonly turn: number;
  /** 触发类别；`unknown` = 该次尝试的原因无法机械归类（证据缺口，不判负）。 */
  readonly kind: 'threshold' | 'overflow' | 'post_turn' | 'unknown';
  readonly before: number;
  readonly after: number;
  /** Pi Session 生命周期是否暴露了本次摘要分片数（原生未暴露则 undefined）。 */
  readonly summaryChunks?: number;
}

/** 逐回合观测（转录体量 + 模型调用计数；Pi 原生会话面可提供）。 */
export interface TurnObservation {
  readonly turn: number;
  readonly transcriptTokens: number;
  readonly transcriptMessages: number;
  /** 本回合发生的真实模型调用数（完整计量；含摘要调用在内，能分离则单列）。 */
  readonly modelCalls: number;
  /** 本回合是否产出面向用户的最终回复（用于 CMP6「当前回合保留」）。 */
  readonly producedReply: boolean;
}

export interface CompactionAnalysis {
  /** 观测到的全部压缩尝试（顺序保留）。 */
  readonly attempts: readonly CompactionAttempt[];
  /** 有效压缩 = `after < before` 的次数（CMP3 分子）。 */
  readonly effectiveCount: number;
  /** 零收益尝试 = `after >= before`。 */
  readonly zeroYieldCount: number;
  /** 同回合内**连续**零收益尝试的最长连串（CMP8 / H6.a 判据基数）。 */
  readonly maxZeroYieldRun: number;
  /** overflow 类缩减次数（CMP7；只计数，不读阈值）。 */
  readonly overflowCount: number;
  /** 触发原因未知的尝试数（CMP1；>0 = 证据缺口，登记）。 */
  readonly unclassifiedCount: number;
  /** 单回合最大模型调用数（CMP4/CMP9 计量基数）。 */
  readonly maxModelCallsPerTurn: number;
  /** 观测到的最大单次摘要分片数（undefined = 原生未暴露）。 */
  readonly maxSummaryChunks: number | null;
  /** CMP6：是否存在某回合产出最终回复即视为当前回合被保留（false = 有回合零回复）。 */
  readonly allTurnsProducedReply: boolean;
}

/** 预注册上限（**数字进预注册冻结块，不写进模块常量**；本模块全参数化）。 */
export interface CompactionBounds {
  /** H6.a：同回合连续零收益尝试的判负阈值（达到即判负）。 */
  readonly zeroYieldRunLimit: number;
  /** H6.b：单回合模型调用上限（超过即判负；含重试与摘要调用）。 */
  readonly modelCallsPerTurnLimit: number;
  /** H6.b（可选）：单次摘要分片上限；仅当会话面暴露 summaryChunks 时生效。 */
  readonly summaryChunksLimit?: number;
  /** 会话有效性门槛：每会话最少有效压缩次数（未达 → 样本覆盖不足，非判负）。 */
  readonly minEffectiveCompactions: number;
}

export const R6_COMPACTION_BOUNDS: CompactionBounds = {
  // 与预注册冻结块同步：有界 = ≤2 连零收益；单回合模型调用 ≤4（含重试/摘要）；
  // 摘要分片 ≤16（仅原生暴露时生效）；每会话 ≥3 次有效压缩。
  zeroYieldRunLimit: 3,
  modelCallsPerTurnLimit: 4,
  summaryChunksLimit: 16,
  minEffectiveCompactions: 3,
};

export function analyzeCompaction(
  attempts: readonly CompactionAttempt[],
  turns: readonly TurnObservation[],
): CompactionAnalysis {
  let effective = 0;
  let zeroYield = 0;
  let maxRun = 0;
  let run = 0;
  let overflow = 0;
  let unclassified = 0;
  let maxSummary = 0;
  let sawSummary = false;
  for (const a of attempts) {
    if (a.kind === 'unknown') unclassified += 1;
    if (a.kind === 'overflow') overflow += 1;
    if (a.summaryChunks !== undefined) { sawSummary = true; maxSummary = Math.max(maxSummary, a.summaryChunks); }
    if (a.after < a.before) { effective += 1; run = 0; }
    else { zeroYield += 1; run += 1; maxRun = Math.max(maxRun, run); }
  }
  const maxModelCallsPerTurn = turns.reduce((m, t) => Math.max(m, t.modelCalls), 0);
  const allTurnsProducedReply = turns.every((t) => t.producedReply);
  return {
    attempts, effectiveCount: effective, zeroYieldCount: zeroYield, maxZeroYieldRun: maxRun,
    overflowCount: overflow, unclassifiedCount: unclassified, maxModelCallsPerTurn,
    maxSummaryChunks: sawSummary ? maxSummary : null, allTurnsProducedReply,
  };
}

export interface CompactionVerdict {
  /** 硬零（H6）是否命中；命中 → 该批 FAIL。 */
  readonly hardZeroHits: readonly string[];
  /** 会话有效性：有效压缩次数是否达标（不达标 = 覆盖不足，**非**产品失败）。 */
  readonly coverageSufficient: boolean;
  /** 证据缺口（触发原因不可归类），登记用。 */
  readonly evidenceGaps: readonly string[];
  /** CMP 事实读数（只陈述事实，便于逐条复核）。 */
  readonly facts: Readonly<Record<string, number | boolean | null>>;
}

/**
 * 判定压缩生命周期：把机械事实对照预注册上限。**只做算术，不改触发/门控。**
 *   · H6.a：连续零收益尝试 run ≥ zeroYieldRunLimit → 硬零命中；
 *   · H6.b：单回合模型调用 > modelCallsPerTurnLimit，或（原生暴露且）摘要分片 > 上限 → 硬零命中；
 *   · 触发原因不可归类 → evidenceGap（登记，不判负）；
 *   · 有效压缩 < 门槛 → coverageSufficient=false（样本覆盖不足，非产品失败）。
 */
export function judgeCompactionLifecycle(analysis: CompactionAnalysis, bounds: CompactionBounds = R6_COMPACTION_BOUNDS): CompactionVerdict {
  const hardZeroHits: string[] = [];
  const evidenceGaps: string[] = [];
  if (analysis.maxZeroYieldRun >= bounds.zeroYieldRunLimit) hardZeroHits.push('H6.a');
  if (analysis.maxModelCallsPerTurn > bounds.modelCallsPerTurnLimit) hardZeroHits.push('H6.b');
  if (bounds.summaryChunksLimit !== undefined && analysis.maxSummaryChunks !== null && analysis.maxSummaryChunks > bounds.summaryChunksLimit) {
    hardZeroHits.push('H6.b-summaryChunks');
  }
  if (analysis.unclassifiedCount > 0) evidenceGaps.push('CMP1.trigger_unclassified');
  if (analysis.maxSummaryChunks === null) evidenceGaps.push('CMP4.summary_chunks_unexposed');
  const coverageSufficient = analysis.effectiveCount >= bounds.minEffectiveCompactions;
  return {
    hardZeroHits, coverageSufficient, evidenceGaps,
    facts: {
      effectiveCompactions: analysis.effectiveCount,
      zeroYieldAttempts: analysis.zeroYieldCount,
      maxZeroYieldRun: analysis.maxZeroYieldRun,
      overflowReductions: analysis.overflowCount,
      maxModelCallsPerTurn: analysis.maxModelCallsPerTurn,
      maxSummaryChunks: analysis.maxSummaryChunks,
      allTurnsProducedReply: analysis.allTurnsProducedReply,
    },
  };
}
