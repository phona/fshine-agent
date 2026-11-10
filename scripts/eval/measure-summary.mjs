#!/usr/bin/env node
/**
 * eval harness 测量汇总：把 generic-model-eval.py 的探针 JSON 汇成可读矩阵。
 *
 * 用法：
 *   node scripts/eval/measure-summary.mjs <stability.json...>
 *     [--eval-real-baseline <probe.json>] [--eval-real-latest <probe.json>]
 *     [--regressions <unresolved.json>] [--min-valid <N>]
 *     [-- strong.json weak.json]
 *
 * 稳定性输入可给多个文件（本地逐轮跑 N 个单轮 JSON，或 CI 里单个 --rounds N 的
 * JSON），脚本按用例合并通过轮数。`--` 之后是区分度的强/弱两个文件。
 *
 * 三个输入分别回答三个问题（判据预先写死，让数字决定）：
 *   稳定性 stability.json  —— 同模型 N 轮：每用例通过率。<80% 的用例不能做 per-push
 *                             required 门（要么多数决，要么拿证据改判据）。**80% 只是
 *                             建议线，不是充分条件**：通过率达标后还必须确认最近一次
 *                             eval-real 无机械 pass→fail、且没有未消假红，才可能
 *                             「可做 required」；缺证据按 fail-closed 处理为
 *                             「稳定性达标但需先消回归」。
 *   区分度 strong/weak     —— 双档 judge 均分对比。只有**双方该用例四维都有数值**才
 *                             计入有效比较；任一侧缺维度即整例作废（不得把已出现的
 *                             维度合计成假分差）。有效比较数为 0 或低于 --min-valid
 *                             （默认 1）时结论只能是「无法判定（数据不足）」，退出码
 *                             非零。缺失项不计入「强模型更优 / 弱模型更优 / 无显著
 *                             差异」任何一类。
 *   失败形态               —— 从 results 里提取每轮的 calls / mechanical_pass / final，
 *                             供人工归因（机制违 vs 结果错）。
 *
 * 退出码（诚实反映结论，不是门禁）：
 *   0 = 所有被请求的测量都有可用数据，结论已给出
 *   2 = 数据不足/输入不完整（结论只能是「无法判定」），或命令行用法错误
 * 工作流不得把 2 当成工作流故障——被测失败率与数据不足都是测量结果。
 *
 * 输出 markdown 到 stdout（CI 里重定向进 $GITHUB_STEP_SUMMARY）。不打印 transcript
 * 全文——只取 final 前 80 字符做形态提示。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIMENSIONS = Object.freeze([
  'groundedness',
  'entityFidelity',
  'failureHonesty',
  'presentationHygiene',
]);
export const STABILITY_THRESHOLD = 0.8; // 建议线，不是充分条件（见 evaluateRequiredReadiness）
export const DISCRIMINATION_MIN_GAP = 0.5; // 强模型均分 - 弱模型均分（四维合计，单维 0-2 分）
export const DEFAULT_MIN_VALID_COMPARISONS = 1;

export class UsageError extends Error {}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 四维合计。**只有声明维度全部是有限数值时才返回和**；部分维度缺失返回 null，
 * 让调用方把整例记为缺失，而不是把已有维度加起来冒充完整分。
 */
export function judgeSum(mean) {
  if (!mean || typeof mean !== 'object') return null;
  let sum = 0;
  for (const dim of DIMENSIONS) {
    const v = mean[dim];
    if (!isFiniteNumber(v)) return null;
    sum += v;
  }
  return sum;
}

/** 稳定性 summary 的一条是否可用：轮次为正、通过数在 [0, rounds] 内。 */
export function mechanicalRate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { rounds, mechanical_pass_count: passes } = entry;
  if (!isFiniteNumber(rounds) || rounds <= 0) return null;
  if (!isFiniteNumber(passes) || passes < 0 || passes > rounds) return null;
  return { rounds, passes, rate: passes / rounds };
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`;
}

/**
 * 稳定性输入的**结构校验**（2026-11-10 codex 复审 major）：期望结构（用例集 + 轮数）由调用方
 * 显式声明（CLI --expect-cases / --expect-rounds，工作流把喂给探针的同一份值传进来）。
 * 缺用例、缺轮、冒出非期望用例，都会让合并后的分母**静默缩小**——分母不完整时，任何通过率
 * 都只对“实际拿到的部分”成立，不能写成对期望用例集的结论（与此前“缺失 judge 评分算成强模型
 * 赢”同族：把不完整的证据写成结论）。返回空数组 = 结构完整。
 */
export function stabilityStructureGaps(entries, expected) {
  if (!expected || !Array.isArray(expected.cases) || expected.cases.length === 0) return [];
  const rounds = expected.rounds;
  const gaps = [];
  const actual = new Map(entries);
  for (const id of expected.cases) {
    if (!actual.has(id)) {
      gaps.push(`缺用例 ${id}`);
      continue;
    }
    if (Number.isInteger(rounds) && rounds > 0) {
      const got = actual.get(id)?.rounds;
      if (got !== rounds) gaps.push(`${id} 轮数 ${got ?? '缺失'} ≠ 期望 ${rounds}`);
    }
  }
  for (const [id] of entries) {
    if (!expected.cases.includes(id)) gaps.push(`非期望用例 ${id}`);
  }
  return gaps;
}

/** 多轮文件合并：按用例累计通过轮数与总轮数（null/不可解析的文件由调用方剔除）。 */
export function mergeStability(docs) {
  const usable = (docs ?? []).filter((d) => d && typeof d === 'object');
  if (usable.length === 0) return null;
  const map = new Map();
  for (const f of usable) {
    for (const [id, s] of Object.entries(f.summary ?? {})) {
      if (!s || typeof s !== 'object') continue;
      const cur = map.get(id) ?? { mechanical_pass_count: 0, rounds: 0 };
      if (isFiniteNumber(s.mechanical_pass_count)) cur.mechanical_pass_count += s.mechanical_pass_count;
      if (isFiniteNumber(s.rounds)) cur.rounds += s.rounds;
      map.set(id, cur);
    }
  }
  return {
    summary: Object.fromEntries(map),
    results: usable.flatMap((f) => (Array.isArray(f.results) ? f.results : [])),
  };
}

/** 从探针 JSON 取每用例的机械通过统计；results 优先，summary 兜底。 */
export function probeStats(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const map = new Map();
  if (Array.isArray(doc.results)) {
    for (const r of doc.results) {
      if (!r || typeof r.id !== 'string' || typeof r.mechanical_pass !== 'boolean') continue;
      const cur = map.get(r.id) ?? { rounds: 0, passes: 0 };
      cur.rounds += 1;
      if (r.mechanical_pass) cur.passes += 1;
      map.set(r.id, cur);
    }
  }
  if (map.size === 0) {
    for (const [id, s] of Object.entries(doc.summary ?? {})) {
      const m = mechanicalRate(s);
      if (m) map.set(id, { rounds: m.rounds, passes: m.passes });
    }
  }
  return map.size > 0 ? map : null;
}

/**
 * 「最近一次 eval-real 无机械 pass→fail」的判据：baseline 全通过的用例在 latest
 * 出现失败即一条回归。任一侧无数据、或 latest 没覆盖 baseline 的某个用例，都无法
 * 证明「无 pass→fail」——返回 compared=false，由调用方按条件未满足处理。
 */
export function findEvalRealRegressions(baselineDoc, latestDoc) {
  const base = probeStats(baselineDoc);
  const latest = probeStats(latestDoc);
  if (!base || !latest) {
    return { compared: false, reason: '缺 eval-real baseline 或 latest 的机械结果', regressions: [], unverified: [] };
  }
  const regressions = [];
  const unverified = [];
  for (const [id, b] of base) {
    const l = latest.get(id);
    if (!l) {
      unverified.push(id);
      continue;
    }
    const baselinePassedAll = b.rounds > 0 && b.passes === b.rounds;
    const latestFailed = l.rounds > l.passes;
    if (baselinePassedAll && latestFailed) regressions.push(id);
  }
  if (unverified.length > 0) {
    return {
      compared: false,
      reason: `latest eval-real 未覆盖 baseline 用例：${unverified.join('、')}`,
      regressions,
      unverified,
    };
  }
  return { compared: true, reason: '', regressions, unverified: [] };
}

/** 未消假红清单：接受 string[] / {unresolved:[...]} / {items:[...]}；空数组合法。 */
export function normalizeRegressionList(doc) {
  if (doc == null) return null;
  const list = Array.isArray(doc)
    ? doc
    : Array.isArray(doc.unresolved)
      ? doc.unresolved
      : Array.isArray(doc.items)
        ? doc.items
        : null;
  if (!list) return null;
  return list.map((x) => {
    if (typeof x === 'string') return x;
    if (x && typeof x.id === 'string') return x.id;
    return JSON.stringify(x);
  });
}

/**
 * 「可做 required」的额外条件。通过率达标只是必要项：
 *   1) 最近一次 eval-real 无机械 pass→fail（需要 baseline + latest 且用例集合覆盖）；
 *   2) 无未消假红（需要 --regressions 清单，空数组才算清白）。
 * 证据缺失不得当成清白——一律返回「稳定性达标但需先消回归」。
 */
export function evaluateRequiredReadiness(rate, evidence = {}) {
  if (!isFiniteNumber(rate) || rate < STABILITY_THRESHOLD) {
    return {
      eligible: false,
      label: '**不可做 required**',
      reasons: [`通过率 ${isFiniteNumber(rate) ? pct(rate, 1) : 'n/a'} 低于建议线 ${Math.round(STABILITY_THRESHOLD * 100)}%`],
    };
  }
  const reasons = [];
  if (!evidence.evalRealCompared) {
    reasons.push(evidence.evalRealReason || '缺最近一次 eval-real 机械对照（--eval-real-baseline + --eval-real-latest）');
  } else if ((evidence.evalRealRegressions ?? []).length > 0) {
    reasons.push(`eval-real 机械 pass→fail：${(evidence.evalRealRegressions ?? []).join('、')}`);
  }
  if (!evidence.regressionsChecked) {
    reasons.push('缺未消假红清单（--regressions）');
  } else if ((evidence.unresolvedFalseReds ?? []).length > 0) {
    reasons.push(`未消假红：${(evidence.unresolvedFalseReds ?? []).join('、')}`);
  }
  if (reasons.length > 0) {
    return { eligible: false, label: '稳定性达标但需先消回归', reasons };
  }
  return { eligible: true, label: '可做 required', reasons: [] };
}

/**
 * 区分度比较：有效比较与缺失项分开统计。
 * - 只有双方该用例四维齐全（judgeSum 非 null）才计入 validComparisons；
 * - 缺一侧用例、缺维度、judge_mean 为 null/跳过，全部计入 missing；
 * - **逐轮评分完整性**（2026-11-10 codex 复审 major）：judge_mean 四维齐全会掩盖逐轮缺失——
 *   探针跳过失缺失的轮次再算均值，一轮 judge 失败、一轮成功照样“四维齐全”。因此声明了期望
 *   轮数时，还要求该用例的 results 里**每一轮**都有四维 judge_scores（按声明结构核，不按均值反推）；
 * - validComparisons < minValidComparisons 时 verdict 固定为「无法判定（数据不足）」。
 */
export function evaluateDiscrimination(strongDoc, weakDoc, minValidComparisons = DEFAULT_MIN_VALID_COMPARISONS, expected = null) {
  const strongSummary = strongDoc && typeof strongDoc === 'object' ? (strongDoc.summary ?? {}) : {};
  const weakSummary = weakDoc && typeof weakDoc === 'object' ? (weakDoc.summary ?? {}) : {};
  const declaredIds = expected && Array.isArray(expected.cases) && expected.cases.length > 0 ? expected.cases : null;
  const ids = declaredIds ?? [...new Set([...Object.keys(strongSummary), ...Object.keys(weakSummary)])];
  const expectedRounds = expected && Number.isInteger(expected.rounds) && expected.rounds > 0 ? expected.rounds : null;
  const rows = [];
  let validComparisons = 0;
  let missing = 0;

  /** 该文档里这个用例的逐轮 judge 评分缺口（声明了轮数时才核；没声明不核，宁少报不多猜）。 */
  const roundGaps = (doc, id) => {
    if (!expectedRounds || !doc || typeof doc !== 'object') return [];
    const results = Array.isArray(doc.results) ? doc.results.filter((r) => r && r.id === id) : [];
    const gaps = [];
    if (results.length < expectedRounds) gaps.push(`轮次 ${results.length}/${expectedRounds}`);
    const incompleteRounds = results.filter((r) => !judgeSum(r.judge_scores)).length;
    if (incompleteRounds > 0) gaps.push(`${incompleteRounds} 轮缺四维评分`);
    return gaps;
  };

  for (const id of ids) {
    const s = strongSummary[id];
    const w = weakSummary[id];
    const strongSum = s ? judgeSum(s.judge_mean) : null;
    const weakSum = w ? judgeSum(w.judge_mean) : null;
    const strongMech = mechanicalRate(s);
    const weakMech = mechanicalRate(w);
    const strongRoundGaps = roundGaps(strongDoc, id);
    const weakRoundGaps = roundGaps(weakDoc, id);

    if (strongSum === null || weakSum === null || strongRoundGaps.length > 0 || weakRoundGaps.length > 0) {
      let reason;
      if (!s) reason = '强模型缺该用例';
      else if (!w) reason = '弱模型缺该用例';
      else if (strongSum === null && weakSum === null) reason = '双方 judge 四维不全或全缺';
      else if (strongSum === null) reason = '强模型 judge 四维不全';
      else if (weakSum === null) reason = '弱模型 judge 四维不全';
      else reason = `逐轮评分不完整（强：${strongRoundGaps.join('、') || '齐全'}；弱：${weakRoundGaps.join('、') || '齐全'}）`;
      missing += 1;
      rows.push({ id, strongSum, weakSum, strongMech, weakMech, gap: null, verdict: `数据缺失（${reason}；不计入比较）`, missing: true, missingReason: reason });
      continue;
    }

    validComparisons += 1;
    const gap = strongSum - weakSum;
    const verdict = gap >= DISCRIMINATION_MIN_GAP
      ? '强模型明显更优'
      : gap <= -DISCRIMINATION_MIN_GAP
        ? '弱模型明显更优'
        : '无显著差异';
    rows.push({ id, strongSum, weakSum, strongMech, weakMech, gap, verdict, missing: false, missingReason: '' });
  }

  let verdict;
  let strongBetter = 0;
  let weakBetter = 0;
  let noDifference = 0;
  if (validComparisons < minValidComparisons) {
    verdict = `无法判定（数据不足：缺失 ${missing} 例${validComparisons === 0 ? '，无有效比较' : `，有效比较仅 ${validComparisons}/${minValidComparisons}`}）`;
  } else {
    strongBetter = rows.filter((r) => !r.missing && r.gap >= DISCRIMINATION_MIN_GAP).length;
    weakBetter = rows.filter((r) => !r.missing && r.gap <= -DISCRIMINATION_MIN_GAP).length;
    noDifference = validComparisons - strongBetter - weakBetter;
    if (strongBetter > validComparisons / 2) {
      verdict = `强模型明显更优（${strongBetter}/${validComparisons} 例有效比较）`;
    } else if (weakBetter > validComparisons / 2) {
      verdict = `弱模型明显更优（${weakBetter}/${validComparisons} 例有效比较）——方向与预期相反，该改的是 eval 不是模型`;
    } else {
      verdict = `无显著差异（${strongBetter} 例强模型更优 / ${weakBetter} 例弱模型更优 / ${noDifference} 例无显著差异，共 ${validComparisons} 例有效比较）——区分度不足，该改的是 eval 不是模型`;
    }
  }

  return {
    rows,
    validComparisons,
    missing,
    strongBetter,
    weakBetter,
    noDifference,
    verdict,
    insufficient: validComparisons < minValidComparisons,
  };
}

function markdownTableRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

/**
 * 纯函数：输入已解析 JSON，输出 { markdown, exitCode, ... }。
 * 测试直接调用它，CLI 只负责读文件与打印。
 */
export function buildReport({
  stabilityDocs = [],
  stabilityComplete = true,
  stabilityExpected = null,
  discriminationExpected = null,
  stabilityRequested = stabilityDocs.length > 0,
  strongDoc = null,
  weakDoc = null,
  discriminationRequested = false,
  minValidComparisons = DEFAULT_MIN_VALID_COMPARISONS,
  evalRealBaselineDoc = null,
  evalRealLatestDoc = null,
  regressionDoc = null,
  evidenceErrors = [],
} = {}) {
  const lines = [];
  let exitCode = 0;

  lines.push('## Eval harness 测量汇总', '');
  if (evidenceErrors.length > 0) {
    lines.push(`> **输入错误**：${evidenceErrors.join('；')}——相关证据按缺失处理，不得写成清白。`, '');
    exitCode = 2;
  }

  const evalReal = findEvalRealRegressions(evalRealBaselineDoc, evalRealLatestDoc);
  const unresolvedFalseReds = normalizeRegressionList(regressionDoc);
  const evidence = {
    evalRealCompared: evalReal.compared,
    evalRealReason: evalReal.reason,
    evalRealRegressions: evalReal.regressions,
    regressionsChecked: unresolvedFalseReds !== null,
    unresolvedFalseReds: unresolvedFalseReds ?? [],
  };

  // ── 稳定性 ──
  let stabilityResult = null;
  if (stabilityRequested) {
    lines.push('### 1. 稳定性（同模型 N 轮）', '');
    const merged = mergeStability(stabilityDocs);
    const entries = merged ? Object.entries(merged.summary) : [];
    // 结构校验：分母不完整（缺用例/缺轮/非期望用例）时，本节不出任何通过率结论。
    // 期望结构由调用方声明（CLI --expect-cases / --expect-rounds 必填，见 main）——汇总
    // 工具无法从输入自身知道“期望跑哪些用例”，声明值就是分母的唯一权威来源。
    const structuralGaps = stabilityStructureGaps(entries, stabilityExpected);
    const effectiveComplete = stabilityComplete && structuralGaps.length === 0;
    const incompleteReason = structuralGaps.length > 0
      ? `输入结构与声明不符：${structuralGaps.join('；')}`
      : '部分稳定性文件无法解析，合并后的轮次分母不完整';
    const usable = [];
    const missingIds = [];
    for (const [id, s] of entries) {
      const m = mechanicalRate(s);
      if (m) usable.push([id, m]);
      else missingIds.push(id);
    }

    lines.push(markdownTableRow(['用例', '通过轮数', '通过率', '判定']));
    lines.push(markdownTableRow(['---', '---', '---', '---']));
    const blockedReasons = new Set();
    let stableCount = 0;
    let eligibleCount = 0;
    const flaky = [];
    for (const [id, m] of usable) {
      if (!effectiveComplete) {
        lines.push(markdownTableRow([id, `${m.passes}/${m.rounds}`, pct(m.passes, m.rounds), '无法判定（输入不完整）']));
        continue;
      }
      const readiness = evaluateRequiredReadiness(m.rate, evidence);
      if (m.rate >= STABILITY_THRESHOLD) {
        stableCount += 1;
        if (readiness.eligible) eligibleCount += 1;
        for (const reason of readiness.reasons) blockedReasons.add(reason);
      } else {
        flaky.push(id);
      }
      lines.push(markdownTableRow([id, `${m.passes}/${m.rounds}`, pct(m.passes, m.rounds), readiness.label]));
    }
    for (const id of missingIds) {
      lines.push(markdownTableRow([id, 'n/a', 'n/a', '无法判定（无有效轮次）']));
    }
    lines.push('');

    if (!effectiveComplete) {
      lines.push(`> **判定**：无法判定（${incompleteReason}）。`, '');
      exitCode = Math.max(exitCode, 2);
      stabilityResult = { usable: usable.length, missing: missingIds.length + structuralGaps.filter((g) => g.startsWith('缺用例')).length, flaky, verdict: `无法判定（${incompleteReason}）` };
    } else if (usable.length === 0) {
      lines.push(`> **判定**：无法判定（数据不足：无可用稳定性数据${missingIds.length > 0 ? `，缺失 ${missingIds.length} 例` : ''}）。`, '');
      exitCode = Math.max(exitCode, 2);
      stabilityResult = { usable: 0, missing: missingIds.length, flaky: [], verdict: '无法判定（数据不足）' };
    } else if (missingIds.length > 0) {
      // 用例集不完整时，已有用例的通过率只对它们自己成立，不能拿来给整个用例集下结论。
      lines.push(`> **判定**：无法判定（数据不足：${missingIds.join('、')} 无有效轮次；已有 ${usable.length} 例数据只按单例解读，不写成整体结论）。`, '');
      exitCode = Math.max(exitCode, 2);
      stabilityResult = { usable: usable.length, missing: missingIds.length, flaky: [], verdict: '无法判定（数据不足）' };
    } else {
      const parts = [];
      if (flaky.length > 0) {
        parts.push(`${flaky.join('、')} 通过率低于 ${Math.round(STABILITY_THRESHOLD * 100)}%——这些用例不能按 per-push required 门设计（多数决或判据修订需另拿证据）。`);
      }
      if (stableCount > 0) {
        parts.push(eligibleCount === stableCount
          ? `其余 ${stableCount} 例通过率 ≥ ${Math.round(STABILITY_THRESHOLD * 100)}%，且最近 eval-real 无机械 pass→fail、无未消假红，可评估 required 化。`
          : `其余 ${stableCount} 例通过率 ≥ ${Math.round(STABILITY_THRESHOLD * 100)}%，但 ${stableCount - eligibleCount} 例尚未满足 required 的回归条件（最近一次 eval-real 无机械 pass→fail + 无未消假红）——「稳定性达标但需先消回归」。`);
      }
      // 通过率只是建议线：稳定但证据不足时原因要写出来，别让读者以为 80% 就够。
      if (blockedReasons.size > 0) {
        parts.push(`required 条件未满足：${[...blockedReasons].join('；')}。`);
      }
      const verdict = parts.join('');
      lines.push(`> **判定**：${verdict}`, '');
      stabilityResult = { usable: usable.length, missing: missingIds.length, flaky, verdict };
    }

    // 失败形态（人工归因用）
    const fails = (merged?.results ?? []).filter((r) => r && r.mechanical_pass === false);
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
  let discriminationResult = null;
  if (discriminationRequested) {
    lines.push('### 2. 区分度（强模型 vs 弱模型，judge 均分）', '');
    // 区分度阶段的期望结构**独立声明**（codex 复审 blocking：工作流稳定性 5 轮、强弱档固定
    // 2 轮，把稳定性的轮数原样传给区分度会把完整产物全判成缺轮）。cases 沿用同一份，
    // 轮数用区分度阶段的声明；没给 discriminationExpected 时退化为不核轮数（宁少报不多猜）。
    const discExpected = discriminationExpected
      ?? (stabilityExpected ? { cases: stabilityExpected.cases, rounds: null } : null);
    const comparison = evaluateDiscrimination(strongDoc, weakDoc, minValidComparisons, discExpected);
    discriminationResult = comparison;
    lines.push(markdownTableRow(['用例', '强模型 judge 合计', '弱模型 judge 合计', '差', '强机械', '弱机械', '区分度判定']));
    lines.push(markdownTableRow(['---', '---', '---', '---', '---', '---', '---']));
    for (const r of comparison.rows) {
      lines.push(markdownTableRow([
        r.id,
        r.strongSum === null ? 'n/a' : String(r.strongSum),
        r.weakSum === null ? 'n/a' : String(r.weakSum),
        r.gap === null ? 'n/a' : `${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(1)}`,
        r.strongMech ? pct(r.strongMech.passes, r.strongMech.rounds) : 'n/a',
        r.weakMech ? pct(r.weakMech.passes, r.weakMech.rounds) : 'n/a',
        r.verdict,
      ]));
    }
    lines.push('');
    lines.push(`> 有效比较：${comparison.validComparisons} 例；缺失：${comparison.missing} 例。缺失项不计入「强模型更优 / 弱模型更优 / 无显著差异」任何一类，也不能当作区分度证据。`, '');
    lines.push(`> **判定**：${comparison.verdict}`, '');
    if (comparison.insufficient) exitCode = Math.max(exitCode, 2);
  }

  if (!stabilityRequested && !discriminationRequested) {
    lines.push('_（无输入）_', '');
  }

  return {
    markdown: lines.join('\n'),
    exitCode,
    stability: stabilityResult,
    discrimination: discriminationResult,
    requiredEvidence: evidence,
  };
}

const FLAG_TO_KEY = new Map([
  ['--eval-real-baseline', 'evalRealBaselinePath'],
  ['--eval-real-latest', 'evalRealLatestPath'],
  ['--regressions', 'regressionsPath'],
  ['--min-valid', 'minValidComparisons'],
  ['--expect-cases', 'expectCases'],
  ['--expect-rounds', 'expectRounds'],
  ['--expect-disc-rounds', 'expectDiscRounds'],
]);

const USAGE = 'usage: node scripts/eval/measure-summary.mjs <stability.json...> '
  + '[--eval-real-baseline <probe.json>] [--eval-real-latest <probe.json>] '
  + '[--regressions <unresolved.json>] [--min-valid <N>] [-- strong.json weak.json]';

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);
  if (tail.length > 2) throw new UsageError('`--` 之后只能给强/弱两个 JSON 文件');
  const out = {
    stabilityPaths: [],
    evalRealBaselinePath: null,
    evalRealLatestPath: null,
    regressionsPath: null,
    minValidComparisons: DEFAULT_MIN_VALID_COMPARISONS,
    strongPath: tail[0] ?? null,
    weakPath: tail[1] ?? null,
  };
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (!arg.startsWith('--')) {
      out.stabilityPaths.push(arg);
      continue;
    }
    const key = FLAG_TO_KEY.get(arg);
    if (!key) throw new UsageError(`未知参数 ${arg}`);
    const value = head[i + 1];
    if (value === undefined) throw new UsageError(`${arg} 缺少值`);
    i += 1;
    out[key] = value;
  }
  const minValid = Number(out.minValidComparisons);
  if (!Number.isInteger(minValid) || minValid < 1) throw new UsageError('--min-valid 必须是正整数');
  out.minValidComparisons = minValid;
  // 期望结构（--expect-cases / --expect-rounds）：必须成对出现，且格式合法——它是分母的
  // 声明值，喂错就等于把结构校验关掉（codex 复审 major 的修法）。
  const hasCases = out.expectCases !== undefined;
  const hasRounds = out.expectRounds !== undefined;
  if (hasCases !== hasRounds) {
    throw new UsageError('--expect-cases 与 --expect-rounds 必须成对给出');
  }
  if (hasCases) {
    const cases = String(out.expectCases).split(',').map((s) => s.trim()).filter(Boolean);
    if (cases.length === 0 || !cases.every((id) => /^[A-Za-z0-9-]+$/.test(id))) {
      throw new UsageError('--expect-cases 必须是逗号分隔的用例 id（^[A-Za-z0-9,-]+$，且无空段）')
    }
    const rounds = Number(out.expectRounds);
    if (!Number.isInteger(rounds) || rounds < 1) throw new UsageError('--expect-rounds 必须是正整数');
    out.stabilityExpected = { cases, rounds };
    // 区分度阶段的轮数独立声明（工作流强弱档固定 2 轮，与稳定性轮数不同）——给了区分度
    // 输入就必须声明，不声明不核轮数（discriminationExpected 缺轮数字段 = 不核）。
    const hasDisc = out.expectDiscRounds !== undefined;
    if (hasDisc !== Boolean(out.strongPath || out.weakPath)) {
      throw new UsageError('--expect-disc-rounds 与区分度输入（强/弱 JSON）必须成对出现');
    }
    if (hasDisc) {
      const discRounds = Number(out.expectDiscRounds);
      if (!Number.isInteger(discRounds) || discRounds < 1) throw new UsageError('--expect-disc-rounds 必须是正整数');
      out.discriminationExpected = { cases, rounds: discRounds };
    }
  }
  return out;
}

function readJson(filePath) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: `${path.basename(filePath)}: ${err.message}` };
  }
}

/** CLI 入口；返回退出码。导出让测试可以走与真实调用相同的读文件路径。 */
export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }

  const stabilityLoads = opts.stabilityPaths.map(readJson);
  const strongLoad = opts.strongPath ? readJson(opts.strongPath) : null;
  const weakLoad = opts.weakPath ? readJson(opts.weakPath) : null;
  const baselineLoad = opts.evalRealBaselinePath ? readJson(opts.evalRealBaselinePath) : null;
  const latestLoad = opts.evalRealLatestPath ? readJson(opts.evalRealLatestPath) : null;
  const regressionLoad = opts.regressionsPath ? readJson(opts.regressionsPath) : null;

  // 期望结构必填（codex 复审 major：默认本地入口曾绕过结构校验）：给了稳定性输入就必须声明
  // 用例集与轮数——汇总工具无法从输入自身知道“期望跑哪些用例”，不声明就不许合并下结论。
  if (opts.stabilityPaths.length > 0 && !opts.stabilityExpected) {
    console.error('给了稳定性输入就必须用 --expect-cases <id,...> --expect-rounds <N> 声明期望结构'
      + '（分母的声明值；工作流把喂给探针的同一份值传进来）。\n' + USAGE);
    return 2;
  }

  const evidenceErrors = [];
  const noteLoad = (load, role) => {
    if (load && !load.ok) evidenceErrors.push(`${role} 无法解析（${load.error}）`);
  };
  noteLoad(baselineLoad, 'eval-real baseline');
  noteLoad(latestLoad, 'eval-real latest');
  noteLoad(regressionLoad, '未消假红清单');

  const report = buildReport({
    stabilityDocs: stabilityLoads.map((l) => (l.ok ? l.data : null)),
    stabilityComplete: stabilityLoads.every((l) => l.ok),
    stabilityExpected: opts.stabilityExpected ?? null,
    discriminationExpected: opts.discriminationExpected ?? null,
    stabilityRequested: stabilityLoads.length > 0,
    strongDoc: strongLoad?.ok ? strongLoad.data : null,
    weakDoc: weakLoad?.ok ? weakLoad.data : null,
    discriminationRequested: Boolean(opts.strongPath || opts.weakPath),
    minValidComparisons: opts.minValidComparisons,
    evalRealBaselineDoc: baselineLoad?.ok ? baselineLoad.data : null,
    evalRealLatestDoc: latestLoad?.ok ? latestLoad.data : null,
    regressionDoc: regressionLoad?.ok ? regressionLoad.data : null,
    evidenceErrors,
  });

  console.log(report.markdown);
  return report.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
