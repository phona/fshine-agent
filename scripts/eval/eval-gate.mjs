#!/usr/bin/env node
/**
 * eval-real 的**通过率门**（预注册口径，2026-11-17）。
 *
 * 为什么不是「逐样本翻转即判回归」：单个 trial 的通过/失败会随模型抖动——同一 head 上
 * E05 / E08 实测过 PASS↔FAIL 往返（见 PR #62 讨论）。用单样本翻转当机械回归判据，任何
 * 概率性用例都会永久红，读数也就失去意义。
 *
 * 预注册判据（改动这一行等于换判据，必须单独提交并说明）：
 *   每个用例的通过率 ≥ MIN_RATE（缺省 0.6，即 PR 跑 5 轮时 ≥3/5）。
 *
 * 用法：
 *   node scripts/eval/eval-gate.mjs --summary .runtime/eval-user/summary.json [--min-rate 0.6]
 * 退出码：0 = 全部用例达标；1 = 有用例低于门槛；2 = 参数/文件错误（不能当作通过）。
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { summary: '.runtime/eval-user/summary.json', minRate: 0.6 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--summary') { out.summary = argv[i + 1]; i += 1; continue; }
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

const { summary, minRate } = parseArgs(process.argv.slice(2));
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
  process.exit(1);
}
process.exit(0);
