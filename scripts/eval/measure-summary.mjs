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
 *                             eval-real 无机械通过率下降（含基线全通过后的 pass→fail，
 *                             以及基线未全通过后的继续下降）、两份对照覆盖声明用例集、
 *                             且没有未消假红，才可能「可做 required」；缺证据按
 *                             fail-closed 处理为「稳定性达标但需先消回归」。
 *   区分度 strong/weak     —— 双档 judge 均分对比。只有**双方该用例四维都有数值**才
 *                             计入有效比较；任一侧缺维度即整例作废（不得把已出现的
 *                             维度合计成假分差）。有效比较数为 0 或低于 --min-valid
 *                             （默认 1）时结论只能是「无法判定（数据不足）」，退出码
 *                             非零。缺失项不计入「强模型更优 / 弱模型更优 / 无显著
 *                             差异」任何一类。声明用例集是集合（与探针 --only 一致）：
 *                             重复 id 直接拒绝，不得在逐项比较里给同一份证据加权。
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

/**
 * 声明用例集里的重复 id（保序、每个重复 id 只报一次）。
 * 探针 `--only` 是集合，每例每轮只跑一次；声明数组里的重复不构成第二份证据。
 */
export function duplicateCaseIds(ids) {
  const seen = new Set();
  const dups = [];
  for (const id of ids ?? []) {
    if (seen.has(id)) {
      if (!dups.includes(id)) dups.push(id);
    } else {
      seen.add(id);
    }
  }
  return dups;
}

/** 声明用例集按集合去重（保序）。覆盖检查用集合语义；加权与轮数计数不走这里悄悄改分母。 */
export function uniqueCaseIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 阶段完成轮数（workflow 汇总步骤与本地同一口径，2026-11-11）。
 * 探针 `--only` 把用例当集合，结果条数 = 去重后的用例数 × 轮数。声明里的重复 id
 * 不增加结果条数：用未去重的个数当除数会把完成轮数算小（声明 A,A,B、实际 2 例 × 5 轮
 * = 10 条，÷3 得 3，误报「仅 3/5 轮」）。与 parseCases / 区分度逐项比较同一口径：
 * 重复 id 直接拒绝，不静默改分母，也不把同一份证据加权。
 * caseIds 接受逗号分隔字符串或 id 数组。
 */
export function stageProgress(caseIds, resultsLength, expectedRounds) {
  const ids = (Array.isArray(caseIds) ? caseIds : String(caseIds ?? '').split(','))
    .map((id) => String(id).trim())
    .filter(Boolean);
  const dups = duplicateCaseIds(ids);
  if (dups.length > 0) {
    return {
      ok: false,
      reason: `声明用例集有重复 id：${dups.join('、')}（探针 --only 是集合，重复 id 不能当额外用例或额外轮次）`,
      done: null,
      expected: expectedRounds,
      caseCount: null,
    };
  }
  const caseCount = ids.length;
  const length = isFiniteNumber(resultsLength) ? resultsLength : Number(resultsLength);
  const done = Math.floor((Number.isFinite(length) ? length : 0) / Math.max(caseCount, 1));
  return { ok: true, reason: '', done, expected: expectedRounds, caseCount };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 四维合计。**只有声明维度全部是有限数值时才返回和**；部分维度缺失返回 null，
 * 让调用方把整例记为缺失，而不是把已有维度加起来冒充完整分。
 * 注意：合法全零分的合计是 **0**（falsy）——调用方判“有没有分”必须用 `=== null`，
 * 不能用 `!judgeSum(...)`（2026-11-10 codex 复审 blocking：弱模型四维全 0 是合法数据，
 * 被 `!0` 误判成缺评分丢弃）。
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

/**
 * **完整且合法的四维评分**（2026-11-10 codex 复审 blocking 收口）：四维齐全、每维都是
 * 0-2 的整数（评委量程）。这是“这一轮有没有有效 judge 数据”的**唯一谓词**——均值面与
 * 逐轮面都用它，不再有第二份判据。合法全零分返回 true（0 是有效分数，不是缺失）。
 */
export function completeJudgeScores(scores) {
  if (!scores || typeof scores !== 'object') return false;
  return DIMENSIONS.every((dim) => {
    const v = scores[dim];
    return Number.isInteger(v) && v >= 0 && v <= 2;
  });
}

/** 稳定性 summary 的一条是否可用：轮次为正、通过数在 [0, rounds] 内。 */
export function mechanicalRate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { rounds, mechanical_pass_count: passes } = entry;
  if (!isFiniteNumber(rounds) || rounds <= 0) return null;
  if (!isFiniteNumber(passes) || passes < 0 || passes > rounds) return null;
  return { rounds, passes, rate: passes / rounds };
}

/**
 * 同一用例的机械通过率是否严格下降（2026-11-11）。
 * 交叉相乘：`latest.passes * baseline.rounds < baseline.passes * latest.rounds`，不经浮点。
 * 覆盖两种形态，不只盯全通过基线：
 *   1) 基线全通过（rate=1）且 latest 出现失败（rate<1）——即原来的 pass→fail；
 *   2) 基线未全通过但继续下降（如 4/5 → 3/5，或通过数上升但通过率下降的 1/2 → 2/5）。
 * 持平（含轮数不同但比率相同的 4/5 → 8/10）与上升都不是下降。
 */
export function mechanicalRateDeclined(baseline, latest) {
  if (!baseline || !latest) return false;
  if (!isFiniteNumber(baseline.rounds) || !isFiniteNumber(latest.rounds)) return false;
  if (!isFiniteNumber(baseline.passes) || !isFiniteNumber(latest.passes)) return false;
  if (baseline.rounds <= 0 || latest.rounds <= 0) return false;
  return latest.passes * baseline.rounds < baseline.passes * latest.rounds;
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
  // 重复 id 与「缺用例」同级：声明数组不是证据权重。先报重复，再按集合核覆盖，
  // 避免同一个缺号被重复声明报两次。
  const dups = duplicateCaseIds(expected.cases);
  if (dups.length > 0) gaps.push(`声明用例集有重复 id：${dups.join('、')}`);
  const declared = uniqueCaseIds(expected.cases);
  const actual = new Map(entries);
  for (const id of declared) {
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
    if (!declared.includes(id)) gaps.push(`非期望用例 ${id}`);
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
 * 「最近一次 eval-real 无机械回归」的判据（2026-11-11 收口两条把未证实写成清白的洞）。
 *
 * 机械回归 = 同一用例 latest 的机械通过率严格低于 baseline（见 mechanicalRateDeclined）。
 * 不只登记「基线全通过且 latest 出现失败」：基线 4/5、latest 3/5 同样是回归。
 *
 * 覆盖（任一即 compared=false，reason 列明缺失，不得满足 required）：
 *   - 任一侧无机械结果；
 *   - latest 没覆盖 baseline 的某个用例；
 *   - 传入了声明用例集时，声明集里有用例不在 baseline 或 latest 中。
 *     只遍历 baseline 会把「声明了 B、两份对照都只有 A」写成 compared=true、无回归，
 *     下游再把它当成 A、B 两例的共同证据。
 */
export function findEvalRealRegressions(baselineDoc, latestDoc, expectedCases = null) {
  const base = probeStats(baselineDoc);
  const latest = probeStats(latestDoc);
  if (!base || !latest) {
    return { compared: false, reason: '缺 eval-real baseline 或 latest 的机械结果', regressions: [], unverified: [] };
  }
  const expected = Array.isArray(expectedCases) && expectedCases.length > 0
    ? uniqueCaseIds(expectedCases)
    : null;
  const declaredMissing = [];
  if (expected) {
    for (const id of expected) {
      const holes = [];
      if (!base.has(id)) holes.push('baseline');
      if (!latest.has(id)) holes.push('latest');
      if (holes.length > 0) declaredMissing.push({ id, holes });
    }
  }
  const regressions = [];
  const unverified = [];
  for (const [id, b] of base) {
    const l = latest.get(id);
    if (!l) {
      unverified.push(id);
      continue;
    }
    if (mechanicalRateDeclined(b, l)) regressions.push(id);
  }
  const reasonParts = [];
  if (declaredMissing.length > 0) {
    reasonParts.push(`声明用例未被 eval-real 对照覆盖：${declaredMissing.map((m) => `${m.id}（${m.holes.join('、')}缺）`).join('、')}`);
  }
  const declaredMissingIds = new Set(declaredMissing.map((m) => m.id));
  const unverifiedExtra = unverified.filter((id) => !declaredMissingIds.has(id));
  if (unverifiedExtra.length > 0) {
    reasonParts.push(`latest eval-real 未覆盖 baseline 用例：${unverifiedExtra.join('、')}`);
  }
  if (reasonParts.length > 0) {
    return { compared: false, reason: reasonParts.join('；'), regressions, unverified };
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
 *   1) 最近一次 eval-real 无机械通过率下降（含 pass→fail 与未全通过基线的继续下降），
 *      且 baseline + latest 覆盖声明用例集（缺号 = 未对照，不是无回归）；
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
    reasons.push(`eval-real 机械通过率下降（含 pass→fail）：${(evidence.evalRealRegressions ?? []).join('、')}`);
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
  // 重复 id 会把同一份证据加权：声明 A,B 可以是「无显著差异」，声明 A,A,B 变成
  // 「强模型明显更优（2/3）」。拒绝整段比较，不静默去重后照样下结论。
  if (declaredIds) {
    const dups = duplicateCaseIds(declaredIds);
    if (dups.length > 0) {
      const verdict = `无法判定（声明用例集有重复 id：${dups.join('、')}；重复 id 不构成额外证据，已拒绝加权）`;
      return {
        rows: [],
        validComparisons: 0,
        missing: 0,
        strongBetter: 0,
        weakBetter: 0,
        noDifference: 0,
        verdict,
        insufficient: true,
      };
    }
  }
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
    const incompleteRounds = results.filter((r) => !completeJudgeScores(r.judge_scores)).length;
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

  // 声明用例集（稳定性优先，否则区分度）是 eval-real 对照必须盖住的分母。
  // 不传入时维持「只核对 baseline 与 latest 互覆盖」——没有声明就没有可核对的期望集。
  const declaredCases = (stabilityExpected && Array.isArray(stabilityExpected.cases) && stabilityExpected.cases.length > 0)
    ? stabilityExpected.cases
    : (discriminationExpected && Array.isArray(discriminationExpected.cases) && discriminationExpected.cases.length > 0)
      ? discriminationExpected.cases
      : null;
  const evalReal = findEvalRealRegressions(evalRealBaselineDoc, evalRealLatestDoc, declaredCases);
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
          ? `其余 ${stableCount} 例通过率 ≥ ${Math.round(STABILITY_THRESHOLD * 100)}%，且最近 eval-real 无机械通过率下降（含 pass→fail）、声明用例均被对照覆盖、无未消假红，可评估 required 化。`
          : `其余 ${stableCount} 例通过率 ≥ ${Math.round(STABILITY_THRESHOLD * 100)}%，但 ${stableCount - eligibleCount} 例尚未满足 required 的回归条件（最近一次 eval-real 无机械通过率下降（含 pass→fail）、声明用例均被对照覆盖 + 无未消假红）——「稳定性达标但需先消回归」。`);
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
  // 期望结构（各阶段独立声明，2026-11-10 codex 复审 major 收口）：一条规则——
  // **任何被测量的输入，都必须带它所属阶段的声明**。汇总工具无法从输入自身知道“期望跑哪些
  // 用例、跑几轮”，不声明就不许合并下结论（否则缺轮/缺用例/缺逐轮评分都会静默缩小证据面）。
  //   · --expect-cases        公共用例集（任一阶段有输入即必填）；
  //   · --expect-rounds       稳定性阶段轮数（有稳定性输入即必填）；
  //   · --expect-disc-rounds  区分度阶段轮数（有强/弱输入即必填——该阶段固定 2 轮，
  //                           与稳定性轮数不同，历史上曾把稳定性轮数串给它导致完整产物全判缺失）。
  const hasStabilityInput = out.stabilityPaths.length > 0;
  const hasDiscriminationInput = Boolean(out.strongPath || out.weakPath);
  const parseCases = (raw) => {
    const cases = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
    if (cases.length === 0 || !cases.every((id) => /^[A-Za-z0-9-]+$/.test(id))) {
      throw new UsageError('--expect-cases 必须是逗号分隔的用例 id（^[A-Za-z0-9,-]+$，且无空段）');
    }
    // 与探针 --only 的集合语义、区分度逐项比较、workflow 阶段轮数同一口径：
    // 重复 id 直接拒绝。静默去重会把用户声明的分母悄悄缩小；留着则会给同一份证据加权。
    const dups = duplicateCaseIds(cases);
    if (dups.length > 0) {
      throw new UsageError(`--expect-cases 含重复用例 id：${dups.join('、')}（声明集是集合，与探针 --only 一致；重复 id 会给同一份证据加权，已拒绝）`);
    }
    return cases;
  };
  const parseRounds = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} 必须是正整数`);
    return n;
  };
  if (out.expectCases !== undefined) out.expectCases = parseCases(out.expectCases);
  if (out.expectRounds !== undefined) out.expectRounds = parseRounds(out.expectRounds, '--expect-rounds');
  if (out.expectDiscRounds !== undefined) out.expectDiscRounds = parseRounds(out.expectDiscRounds, '--expect-disc-rounds');
  if ((hasStabilityInput || hasDiscriminationInput) && out.expectCases === undefined) {
    throw new UsageError('给了测量输入就必须用 --expect-cases 声明期望用例集（分母的声明值）');
  }
  if (hasStabilityInput !== (out.expectRounds !== undefined)) {
    throw new UsageError('--expect-rounds 与稳定性输入必须成对出现');
  }
  if (hasDiscriminationInput !== (out.expectDiscRounds !== undefined)) {
    throw new UsageError('--expect-disc-rounds 与区分度输入（强/弱 JSON）必须成对出现');
  }
  if (out.expectCases !== undefined) {
    out.stabilityExpected = out.expectRounds !== undefined
      ? { cases: out.expectCases, rounds: out.expectRounds }
      : null;
    out.discriminationExpected = out.expectDiscRounds !== undefined
      ? { cases: out.expectCases, rounds: out.expectDiscRounds }
      : null;
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
