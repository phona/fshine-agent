/**
 * SimCase 跑批选样（纯函数，零 I/O）：`SIM_CASES_ONLY` 用例选择 + 样本硬停核对。
 *
 * 边界：只回答「本批跑哪几个用例、够不够预算」，**不碰任何 Oracle / 污染 / 严重失败判据**；
 * 选样不是筛绿——没选中的用例必须在预注册里逐条登记原因。
 */

import type { SimCase } from './case';

/** 预注册冻结的样本硬停（选中用例 trials 之和不得超过）。 */
export const SAMPLE_HARD_CAP = 12;

/**
 * 按 `SIM_CASES_ONLY`（逗号分隔 id）从可用用例中选样；空串/未设 = 全部可用用例。
 * 未知 id 或非读切片用例一律报错（宁可拒绝发请求，不静默少跑）。
 */
export function selectSimCases(cases: readonly SimCase[], raw: string | undefined): readonly SimCase[] {
  const spec = (raw ?? '').trim();
  if (spec === '') return cases;
  const wanted = spec.split(',').map((id) => id.trim()).filter((id) => id !== '');
  if (wanted.length === 0) throw new Error('SIM_CASES_ONLY 为空（未设 = 全部用例；不要用空串假装全跑）');
  const byId = new Map(cases.map((caseDef) => [caseDef.id, caseDef]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`SIM_CASES_ONLY 含未知/非读切片用例：${unknown.join(',')}（可选：${[...byId.keys()].join(',')}）`);
  }
  return wanted.map((id) => byId.get(id)!);
}

/** 返回计划样本数；超过硬停直接抛错（调用方据此在发请求前停下）。 */
export function assertSampleCap(cases: readonly SimCase[], cap: number = SAMPLE_HARD_CAP): number {
  const planned = cases.reduce((sum, caseDef) => sum + caseDef.limits.trials, 0);
  if (planned > cap) {
    throw new Error(`样本数 ${planned} 超过预注册硬停 ${cap}（用例 ${cases.map((caseDef) => caseDef.id).join('、')}）；拒绝发请求`);
  }
  return planned;
}
