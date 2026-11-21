/**
 * SimCase 薄机制 · 记账（simulator / judge 与被测系统分开统计）。
 *
 * 口径：
 *   · `simulator`        —— 模拟用户模型的每次调用（只喂 goal/persona/knowledge/可见回复）；
 *   · `judge`            —— 判官模型调用（独立 Oracle 用它时计；确定性 Oracle 不产生）；
 *   · `main|summary|retry|overflow_recovery` —— 被测系统的四类调用（复用 R6 `accountCalls` 的
 *     分类求和语义；由系统适配器逐次上报，不上报则标注不可得，**不编造**）。
 *
 * 总数与 token 都要有：`accountSimCalls` 返回总计 + 分类别（含 input/output/total 与耗时）。
 */

import { accountCalls, CALL_KINDS, type CallKind, type CallTokens, type KindAccounting, type ModelCallRecord } from '../long-session/accounting';

/** 记账类别：模拟用户 / 判官 / 被测系统四类。 */
export type SimCallKind = 'simulator' | 'judge' | CallKind;

/** 全部类别（顺序稳定；`SIM_CALL_KINDS` 供遍历/绊线）。 */
export const SIM_CALL_KINDS: readonly SimCallKind[] = ['simulator', 'judge', ...CALL_KINDS];

/** 逐次调用记录（trial 内单调 seq）。 */
export interface SimCallRecord {
  readonly seq: number;
  readonly kind: SimCallKind;
  /** 关联回合号（用户消息序号）。 */
  readonly turn: number;
  readonly tokens: CallTokens;
  /** 是否观测到真实 usage（false = 该次用量未知，只计调用数）。 */
  readonly tokensObserved: boolean;
  readonly durationMs: number;
}

export interface SimAccounting {
  readonly calls: number;
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** 仅当全部记录都观测到 usage 才为 true（token 总计可信的前提）。 */
  readonly tokensObserved: boolean;
  readonly byKind: Readonly<Record<SimCallKind, KindAccounting>>;
  /** 一次记录都没有的类别（诚实标注不可得；不补零伪造）。 */
  readonly unobservedKinds: readonly SimCallKind[];
}

function zeroKind(): KindAccounting {
  return { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

export function emptySimAccounting(): SimAccounting {
  const byKind = Object.fromEntries(SIM_CALL_KINDS.map((kind) => [kind, zeroKind()])) as Record<SimCallKind, KindAccounting>;
  return {
    calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0,
    tokensObserved: false, byKind, unobservedKinds: [...SIM_CALL_KINDS],
  };
}

function isSystemKind(kind: SimCallKind): kind is CallKind {
  return (CALL_KINDS as readonly string[]).includes(kind);
}

function aggregate(records: readonly SimCallRecord[], kind: SimCallKind): KindAccounting {
  let acc = zeroKind();
  for (const record of records) {
    if (record.kind !== kind) continue;
    acc = {
      calls: acc.calls + 1,
      tokens: acc.tokens + record.tokens.total,
      inputTokens: acc.inputTokens + record.tokens.input,
      outputTokens: acc.outputTokens + record.tokens.output,
      durationMs: acc.durationMs + record.durationMs,
    };
  }
  return acc;
}

/** 全量记账：系统四类走 R6 `accountCalls`（同一分类求和语义），simulator/judge 单列。 */
export function accountSimCalls(records: readonly SimCallRecord[]): SimAccounting {
  const systemRecords: ModelCallRecord[] = records
    .filter((record) => isSystemKind(record.kind))
    .map((record) => ({
      seq: record.seq,
      kind: record.kind as CallKind,
      sessionId: 'sim',
      turn: record.turn,
      tokens: record.tokens,
      tokensObserved: record.tokensObserved,
      durationMs: record.durationMs,
    }));
  const system = accountCalls(systemRecords);
  const simulator = aggregate(records, 'simulator');
  const judge = aggregate(records, 'judge');
  const byKind: Record<SimCallKind, KindAccounting> = {
    simulator,
    judge,
    main: system.byKind.main,
    summary: system.byKind.summary,
    retry: system.byKind.retry,
    overflow_recovery: system.byKind.overflow_recovery,
  };
  const totals = Object.values(byKind).reduce(
    (acc, part) => ({
      calls: acc.calls + part.calls,
      tokens: acc.tokens + part.tokens,
      inputTokens: acc.inputTokens + part.inputTokens,
      outputTokens: acc.outputTokens + part.outputTokens,
      durationMs: acc.durationMs + part.durationMs,
    }),
    { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
  );
  return {
    ...totals,
    tokensObserved: records.length > 0 && records.every((record) => record.tokensObserved),
    byKind,
    unobservedKinds: SIM_CALL_KINDS.filter((kind) => byKind[kind].calls === 0),
  };
}

/**
 * 反向绊线：任一必需类别缺失即返回其名（空数组 = 记账覆盖完整）。
 * 缺省要求 simulator 与 main（判官只在模型 Oracle 时才产生，不计入必需）。
 */
export function missingSimKinds(
  usage: SimAccounting,
  required: readonly SimCallKind[] = ['simulator', 'main'],
): readonly SimCallKind[] {
  return required.filter((kind) => usage.byKind[kind].calls === 0);
}
