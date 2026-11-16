/**
 * SimCase 薄机制 · 独立 Oracle（真值判定；模拟用户看不到本模块）。
 *
 * 复用 R6 的 Oracle 思路与实现：事实真值来自夹具种子快照（`../r6/oracle.ts` 的
 * `FACT_TRUTH`），机械比对走 `judgeFactAnswer`（数值/澄清/不可答三类）；本模块只做
 * id → 判定器的注册与投影，不新增真值来源、不读模型自述。
 *
 * 边界：
 *   · Oracle 只拿**系统用户可见回复** + 机械执行事实，不读工具内部字段之外的私货；
 *   · `truthPatterns` 只供 Harness 的污染检测使用，**不得**进模拟用户 prompt；
 *   · 确定性 Oracle 不产生模型调用；需要判官的 Oracle 通过 `SimJudgeTools.complete`
 *     发起，由 Harness 记 `kind: judge`（记账见 `./accounting`）。
 */

import { FACT_TRUTH, judgeFactAnswer, type FactExpectation } from '../r6/oracle';
import type { SimModelCompletion } from './simulator';

/** 执行事实投影（系统适配器给出；只保留可机械核对的最小字段）。 */
export interface SimExecutionFact {
  readonly operation: string;
  readonly status: string;
  readonly object?: string;
  /** 触发该执行的用户消息序号（1 起，含 initialMessage）；由 Harness 按回合机械标注。 */
  readonly turn?: number;
}

export interface SimOracleContext {
  /** 最后一次系统回复（用户可见）。 */
  readonly finalReply: string;
  /** 全部系统回复（用户可见，按轮序）。 */
  readonly replies: readonly string[];
  /** 全部用户消息（含 initialMessage）。 */
  readonly userMessages: readonly string[];
  /** 机械执行事实（跨回合汇总）。 */
  readonly executions: readonly SimExecutionFact[];
}

export interface SimOracleVerdict {
  readonly pass: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Oracle 可用的模型工具（只有模型判定器会调用；调用被 Harness 记为 judge）。 */
export interface SimJudgeTools {
  complete(prompt: string): Promise<SimModelCompletion>;
}

export interface SimOracle {
  readonly id: string;
  /** 真值模式（污染检测用）；不得进模拟用户 prompt。 */
  readonly truthPatterns: readonly string[];
  judge(ctx: SimOracleContext, tools: SimJudgeTools): SimOracleVerdict | Promise<SimOracleVerdict>;
}

/** 事实 Oracle：把 R6 的 `FactExpectation` 机械判定套到最终可见回复上。 */
export function createFactOracle(input: {
  id: string;
  expectation: FactExpectation;
  truthPatterns: readonly string[];
}): SimOracle {
  return {
    id: input.id,
    truthPatterns: input.truthPatterns,
    judge(ctx) {
      const verdict = judgeFactAnswer(input.expectation, ctx.finalReply);
      return {
        pass: verdict.pass,
        detail: {
          source: 'r6.judgeFactAnswer',
          expectation: JSON.stringify(input.expectation),
          code: verdict.code,
          ...verdict.evidence,
        },
      };
    },
  };
}

/** 回复包含式 Oracle（确定性；用于不涉及数值真值的任务，例如「是否如实说明做不到」）。 */
export function createReplyOracle(input: {
  id: string;
  /** 全部必须出现（任一缺失即判负）。 */
  required: readonly string[];
  /** 出现任一即判负（例如虚假完成话术）。 */
  forbidden?: readonly string[];
  truthPatterns?: readonly string[];
}): SimOracle {
  return {
    id: input.id,
    truthPatterns: input.truthPatterns ?? [],
    judge(ctx) {
      const text = ctx.finalReply.replace(/\s+/g, '');
      const missing = input.required.filter((item) => !text.includes(item.replace(/\s+/g, '')));
      const hits = (input.forbidden ?? []).filter((item) => text.includes(item.replace(/\s+/g, '')));
      return {
        pass: missing.length === 0 && hits.length === 0,
        detail: { source: 'reply-contains', missing, forbiddenHits: hits },
      };
    },
  };
}

/** 从夹具种子快照派生真值模式（只取可区分的长数字：总和/条目金额）。 */
function truthPatternsOf(sum: number, items?: readonly { readonly value: number }[]): readonly string[] {
  const values = new Set<string>([String(sum)]);
  for (const item of items ?? []) values.add(String(item.value));
  return [...values];
}

/** 内建事实 Oracle 注册表：`fact:<collection>:count` / `fact:<collection>:sum`。 */
export const FACT_ORACLES: Readonly<Record<string, SimOracle>> = Object.freeze(
  Object.fromEntries(
    Object.entries(FACT_TRUTH).flatMap(([name, truth]) => {
      const patterns = truthPatternsOf(truth.sum, truth.items);
      return [
        [`fact:${name}:count`, createFactOracle({ id: `fact:${name}:count`, expectation: { kind: 'exact', collection: name, count: truth.count }, truthPatterns: patterns })],
        [`fact:${name}:sum`, createFactOracle({ id: `fact:${name}:sum`, expectation: { kind: 'exact', collection: name, sum: truth.sum }, truthPatterns: patterns })],
      ];
    }),
  ) as Record<string, SimOracle>,
);

/** 解析 oracleId（内建 + 套件局部注册）；未知 id 直接拒绝，不回落任何缺省。 */
export function resolveOracle(id: string, extra: readonly SimOracle[] = []): SimOracle {
  const local = extra.find((oracle) => oracle.id === id);
  const oracle = local ?? FACT_ORACLES[id];
  if (oracle === undefined) throw new Error(`未知 oracleId：${id}（不得回落到缺省判定器）`);
  return oracle;
}
