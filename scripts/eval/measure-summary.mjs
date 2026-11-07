#!/usr/bin/env node
/**
 * eval harness 测量汇总：把 generic-model-eval.py 的探针 JSON 汇成可读矩阵。
 *
 * 用法：
 *   node scripts/eval/measure-summary.mjs <stability.json...> [-- strong.json weak.json]
 *
 * 稳定性输入可给多个文件（本地逐轮跑 N 个单轮 JSON，或 CI 里单个 --rounds N 的
 * JSON），脚本按用例合并通过轮数。`--` 之后是区分度的强/弱两个文件。
 *
 * 三个输入分别回答三个问题（判据预先写死，让数字决定）：
 *   稳定性 stability.json  —— 同模型 N 轮：每用例通过率。<80% 的用例不能做 per-push
 *                             required 门（要么多数决，要么拿证据改判据）。
 *   区分度 strong/weak     —— 双档 judge 均分对比。弱模型 ≥ 强模型的用例过半 =
 *                             harness 没区分度，该改的是 eval 不是模型。
 *   失败形态               —— 从 results 里提取每轮的 calls / mechanical_pass / final，
 *                             供人工归因（机制违 vs 结果错）。
 *
 * 输出 markdown 到 stdout（CI 里重定向进 $GITHUB_STEP_SUMMARY）。不打印 transcript
 * 全文——只取 final 前 80 字符做形态提示。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STABILITY_THRESHOLD = 0.8;
const DISCRIMINATION_MIN_GAP = 0.5; // 强模型均分 - 弱模型均分（四维合计，单维 0-2 分）

function load(p) {
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.log(`_(无法解析 ${path.basename(p)}: ${err.message})_`);
    return null;
  }
}

function judgeSum(mean) {
  if (!mean || typeof mean !== 'object') return null;
  const vals = Object.values(mean).filter((v) => typeof v === 'number');
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`;
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const stabPaths = sep === -1 ? argv : argv.slice(0, sep);
const [strongPath, weakPath] = sep === -1 ? [] : argv.slice(sep + 1);
const stabFiles = stabPaths.map(load).filter(Boolean);
const strong = load(strongPath);
const weak = load(weakPath);

// 多轮文件合并：按用例累计通过轮数与总轮数
const stab = stabFiles.length > 0 ? {
  summary: Object.fromEntries(stabFiles.flatMap((f) => Object.entries(f.summary ?? {})).reduce((m, [id, s]) => {
    const cur = m.get(id) ?? { mechanical_pass_count: 0, rounds: 0 };
    cur.mechanical_pass_count += s.mechanical_pass_count ?? 0;
    cur.rounds += s.rounds ?? 0;
    m.set(id, cur);
    return m;
  }, new Map())),
  results: stabFiles.flatMap((f) => f.results ?? []),
} : null;
const lines = [];

lines.push('## Eval harness 测量汇总', '');

// ── 稳定性 ──
if (stab) {
  lines.push('### 1. 稳定性（同模型 N 轮）', '');
  lines.push('| 用例 | 通过轮数 | 通过率 | 判定 |', '| --- | --- | --- | --- |');
  const flaky = [];
  for (const [id, s] of Object.entries(stab.summary ?? {})) {
    const rate = s.rounds > 0 ? s.mechanical_pass_count / s.rounds : 0;
    const ok = rate >= STABILITY_THRESHOLD;
    if (!ok) flaky.push(id);
    lines.push(`| ${id} | ${s.mechanical_pass_count}/${s.rounds} | ${pct(s.mechanical_pass_count, s.rounds)} | ${ok ? '可做 required' : '**不可做 required**'} |`);
  }
  lines.push('');
  lines.push(flaky.length > 0
    ? `> **判定**：${flaky.join('、')} 通过率低于 ${Math.round(STABILITY_THRESHOLD * 100)}%——这些用例不能按 per-push required 门设计（多数决或判据修订需另拿证据）。`
    : `> **判定**：全部用例通过率 ≥ ${Math.round(STABILITY_THRESHOLD * 100)}%，可评估 per-push required 化。`);
  lines.push('');

  // 失败形态（人工归因用）
  const fails = (stab.results ?? []).filter((r) => r.mechanical_pass === false);
  if (fails.length > 0) {
    lines.push('<details><summary>失败形态（机制违 vs 结果错，人工归因用）</summary>', '');
    for (const r of fails) {
      const final = String(r.final_text ?? '').replace(/\s+/g, ' ').slice(0, 80);
      lines.push(`- round ${r.round} ${r.id}: calls=${r.calls} 末轮=\`${final}\``);
    }
    lines.push('', '</details>', '');
  }
}

// ── 区分度 ──
if (strong && weak) {
  lines.push('### 2. 区分度（强模型 vs 弱模型，judge 均分）', '');
  lines.push('| 用例 | 强模型 judge 合计 | 弱模型 judge 合计 | 差 | 强机械 | 弱机械 | 区分度判定 |', '| --- | --- | --- | --- | --- | --- | --- |');
  let noGap = 0;
  let total = 0;
  for (const [id, s] of Object.entries(strong.summary ?? {})) {
    const w = weak.summary?.[id];
    if (!w) continue;
    total += 1;
    const ss = judgeSum(s.judge_mean);
    const ws = judgeSum(w.judge_mean);
    if (ss === null || ws === null) {
      lines.push(`| ${id} | n/a | n/a | n/a | ${pct(s.mechanical_pass_count, s.rounds)} | ${pct(w.mechanical_pass_count, w.rounds)} | judge 数据缺失 |`);
      continue;
    }
    const gap = ss - ws;
    if (gap < DISCRIMINATION_MIN_GAP) noGap += 1;
    lines.push(`| ${id} | ${ss} | ${ws} | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} | ${pct(s.mechanical_pass_count, s.rounds)} | ${pct(w.mechanical_pass_count, w.rounds)} | ${gap >= DISCRIMINATION_MIN_GAP ? '可分' : '**不可分**'} |`);
  }
  lines.push('');
  lines.push(total > 0 && noGap > total / 2
    ? `> **判定**：${noGap}/${total} 用例区分度不足——harness 分不出强弱模型，该改的是 eval 不是模型。`
    : `> **判定**：区分度充分（${total - noGap}/${total} 用例强模型明显更优）。`);
  lines.push('');
}

if (!stab && !strong) {
  lines.push('_（无输入）_', '');
}

console.log(lines.join('\n'));
