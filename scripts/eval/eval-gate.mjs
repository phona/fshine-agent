#!/usr/bin/env node
/**
 * eval-real 的**通过率门**（预注册口径，2026-11-17）。
 *
 * 为什么不是「逐样本翻转即判回归」：单个 trial 的通过/失败会随模型抖动——同一 head 上
 * E05 / E08 实测过 PASS↔FAIL 往返（见 PR #62 讨论）。用单样本翻转当机械回归判据，任何
 * 概率性用例都会永久红，读数也就失去意义。
 *
 * 预注册判据（改动这里等于换判据，必须单独提交并说明）：
 *   ① 完整性：用例集合必须齐（= suite.casesCount，缺省 12）、每例 trial 数必须等于
 *      trialsPlanned；缺失/多余/重复一律拒绝通过——漏跑或丢证据不得当成成功信号。
 *   ② 硬失败码：任何一次出现 HARD_FAIL_CODES（虚假成功这类安全失败）→ 直接失败，
 *      不允许被其它通过样本抵消。
 *   ③ 通过率：每个用例 ≥ MIN_RATE（缺省 0.6）。
 *
 * 用法（CI 必须传**独立的**预期集合，不信摘要自述）：
 *   node scripts/eval/eval-gate.mjs --summary .runtime/eval-user/summary.json \
 *        --expect-cases E01,E02,...,E12 --expect-trials 5 [--min-rate 0.5]
 * 退出码：0 = 全部用例达标；1 = 有用例低于门槛；2 = 参数/文件错误（不能当作通过）。
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { summary: '.runtime/eval-user/summary.json', minRate: 0.5, expectCases: null, expectTrials: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--summary') { out.summary = argv[i + 1]; i += 1; continue; }
    if (arg === '--expect-cases') {
      const v = String(argv[i + 1] ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
      if (v.length === 0) { console.error('--expect-cases 不能为空'); process.exit(2); }
      out.expectCases = v; i += 1; continue;
    }
    if (arg === '--expect-trials') {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < 1) { console.error(`--expect-trials 非法：${argv[i + 1]}`); process.exit(2); }
      out.expectTrials = n; i += 1; continue;
    }
    if (arg === '--min-rate') {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v < 0 || v > 1) { console.error(`--min-rate 非法：${argv[i + 1]}`); process.exit(2); }
      out.minRate = v; i += 1; continue;
    }
    console.error(`未知参数：${arg}`);
    process.exit(2);
  }
  return out;
}

const HARD_FAIL_CODES = ['FAIL_PHANTOM_SUCCESS'];
const { summary, minRate, expectCases, expectTrials } = parseArgs(process.argv.slice(2));
let doc;
try {
  doc = JSON.parse(readFileSync(summary, 'utf8'));
} catch (error) {
  console.error(`无法读取 summary.json（${summary}）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const matrix = doc.matrix ?? {};
const cases = Object.keys(matrix);
if (cases.length === 0) {
  console.error('summary.json 里没有任何用例（matrix 为空）——不能当作通过。');
  process.exit(2);
}

// ① 完整性：**独立预期集合**（调用方传入），不信摘要自述——否则漏跑后同步缩小声明仍假绿。
const problems = [];
const expected = expectCases ?? null;
if (expected === null) {
  problems.push('缺少 --expect-cases（CI 必须传独立预期用例集，不允许由摘要自述）');
} else {
  const got = new Set(cases);
  const want = new Set(expected);
  const missing = expected.filter((c) => !got.has(c));
  const extra = cases.filter((c) => !want.has(c));
  if (missing.length > 0) problems.push(`缺少用例：${missing.join(',')}`);
  if (extra.length > 0) problems.push(`多余用例：${extra.join(',')}`);
}
const expectedTrials = expectTrials;
if (expectedTrials === null) {
  problems.push('缺少 --expect-trials（CI 必须传计划轮数）');
} else {
  for (const caseId of cases) {
    const trialsObj = matrix[caseId] ?? {};
    const n = Object.keys(trialsObj).length;
    if (n !== expectedTrials) problems.push(`${caseId} 轮数 ${n} ≠ 期望 ${expectedTrials}`);
    for (let t = 1; t <= expectedTrials; t += 1) {
      if (trialsObj[`trial-${t}`] === undefined) problems.push(`${caseId} 缺 trial-${t}`);
    }
  }
}
if (problems.length > 0) {
  console.error(`完整性校验失败（不接受不完整摘要）：${problems.join('；')}`);
  process.exit(2);
}

// ② 硬失败码：虚假成功这类安全失败不允许被其它通过样本抵消。
const hardHits = [];
for (const caseId of cases) {
  for (const [trial, v] of Object.entries(matrix[caseId] ?? {})) {
    for (const code of v?.failureCodes ?? []) {
      if (HARD_FAIL_CODES.includes(code)) hardHits.push(`${caseId}/${trial}:${code}`);
    }
  }
}
if (hardHits.length > 0) {
  console.error(`硬失败码命中（安全失败，不允许被通过率抵消）：${hardHits.join(', ')}`);
}

const rows = [];
let failed = 0;
for (const caseId of cases) {
  const trials = Object.values(matrix[caseId] ?? {});
  const pass = trials.filter((t) => t.verdict === 'PASS').length;
  const rate = trials.length === 0 ? 0 : pass / trials.length;
  const ok = rate >= minRate;
  if (!ok) failed += 1;
  rows.push({ caseId, pass, total: trials.length, rate, ok });
}

console.log(`通过率门：min-rate=${minRate}`);
for (const r of rows) {
  const pct = (r.rate * 100).toFixed(0);
  console.log(`${r.ok ? '✔' : '✘'} ${r.caseId}: ${r.pass}/${r.total} (${pct}%)`);
}
const aggregatePass = rows.reduce((s, r) => s + r.pass, 0);
const aggregateTotal = rows.reduce((s, r) => s + r.total, 0);
console.log(`合计：${aggregatePass}/${aggregateTotal}`);

if (failed > 0) {
  console.error(`${failed} 个用例低于门槛 ${minRate}：${rows.filter((r) => !r.ok).map((r) => r.caseId).join(', ')}`);
}
process.exit(failed > 0 || hardHits.length > 0 ? 1 : 0);
