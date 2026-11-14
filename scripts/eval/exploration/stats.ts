#!/usr/bin/env node
/**
 * stats.ts —— R3 Batch 2 统计工具（Wilson 95% CI / 双臂对照 / 失败分布 / 质量与覆盖报告）。
 *
 * 纯函数面（供单测与复用）：wilson95 / classify / classifyCIs / newcombe95 / classifyDifference /
 * classifyV2 / parseBound / failureHistogram / readRun / kOverN。
 * CLI（只读 run-dir 证据，不跑模型、不触网；退出码 0=成功，2=参数/证据问题）：
 *   node --import tsx scripts/eval/exploration/stats.ts compare --a <dirA> --b <dirB> [--bound <δ>] [--out <file>]
 *   node --import tsx scripts/eval/exploration/stats.ts report --run <dir> [--out <file>]
 *
 * 口径纪律（与批次预注册一致）：
 *   · k/N 一律附 Wilson 95% CI（z=1.96 标准 Wilson score 区间），不得解读为稳定概率（9/9 亦然）；
 *   · v1 三态（缺省，无等效界）：任一臂 N<9 → INSUFFICIENT_SAMPLES；B 的 CI 下界 > A 的 CI 上界 → IMPROVED；
 *     否则 NO_MEANINGFUL_CHANGE（附 Δ=pB−pA）——NO_MEANINGFUL_CHANGE 不等于「已证明无改善」；
 *   · v2 四态（显式提供预注册等效界 δ 时，compare --bound <δ>）：差异区间用 newcombe95（Newcombe 1998
 *     方法 10）——区间整体 > δ → IMPROVED；整体 < −δ → REGRESSED；整体严格落在 (−δ, δ) 内 →
 *     NO_SUBSTANTIAL_CHANGE_VERIFIED；其余（任一臂 N<9、触界、跨界、方向未定）→ INSUFFICIENT_EVIDENCE。
 *     δ 为显式输入、无默认值、不得编造：缺界时任何路径不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED；
 *     非法 δ（≤0 / ≥1 / NaN / ∞ / 非数）与非法差异区间 fail-closed 抛错；
 *   · 两种口径各自在输出中带「口径版本」标注；历史报告不改写；
 *   · 失败分布从 judgment.deterministic.failureCodes 逐码计数；缺失 judgment 的 trial 记 NO_JUDGMENT（不伪造码）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Interval {
  lower: number;
  upper: number;
}

export interface Arm {
  k: number;
  n: number;
}

export type CompareState = 'INSUFFICIENT_SAMPLES' | 'IMPROVED' | 'NO_MEANINGFUL_CHANGE';

export interface CompareResult {
  state: CompareState;
  delta: number;
  aCI: Interval;
  bCI: Interval;
}

/** v2 四态：NO_SUBSTANTIAL_CHANGE_VERIFIED 仅在显式提供预注册等效界 δ 时可达。 */
export type CompareStateV2 =
  | 'IMPROVED'
  | 'REGRESSED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NO_SUBSTANTIAL_CHANGE_VERIFIED';

export interface CompareResultV2 {
  state: CompareStateV2;
  delta: number;
  aCI: Interval;
  bCI: Interval;
  /** Δ=pB−pA 的 95% 差异区间（Newcombe 方法 10；无界时不用于 NO_SUBSTANTIAL_CHANGE_VERIFIED）。 */
  deltaCI: Interval;
  /** 预注册等效界 δ；null = 未提供（此时不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED）。 */
  bound: number | null;
}

/** 预注册的最小样本量：任一臂低于此值一律 INSUFFICIENT_SAMPLES（v2 口径为 INSUFFICIENT_EVIDENCE）。 */
export const MIN_SAMPLES = 9;
const Z95 = 1.96;

/** 标准 Wilson score 区间（z 默认 1.96）。N=0 约定为最大不确定 [0,1]（不产生虚假区间）。 */
export function wilson95(k: number, n: number, z: number = Z95): Interval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) {
    throw new Error(`wilson95 参数不合法：k=${k}, n=${n}（需满足 0≤k≤n 的整数）`);
  }
  if (n === 0) return { lower: 0, upper: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** 严格边界：B 的 CI 下界 **严格大于** A 的 CI 上界才算 IMPROVED（相等不算）。 */
export function classifyCIs(aCI: Interval, bCI: Interval): 'IMPROVED' | 'NO_MEANINGFUL_CHANGE' {
  return bCI.lower > aCI.upper ? 'IMPROVED' : 'NO_MEANINGFUL_CHANGE';
}

/** 三态分类（v1 口径）：任一臂 N<MIN_SAMPLES → INSUFFICIENT_SAMPLES；否则按 CI 分离判定（Δ=pB−pA）。 */
export function classify(a: Arm, b: Arm): CompareResult {
  const aCI = wilson95(a.k, a.n);
  const bCI = wilson95(b.k, b.n);
  const delta = (b.n === 0 ? 0 : b.k / b.n) - (a.n === 0 ? 0 : a.k / a.n);
  if (a.n < MIN_SAMPLES || b.n < MIN_SAMPLES) {
    return { state: 'INSUFFICIENT_SAMPLES', delta, aCI, bCI };
  }
  return { state: classifyCIs(aCI, bCI), delta, aCI, bCI };
}

/** 校验预注册等效界 δ：必须显式给出且为 0<δ<1 的有限数；非法一律抛错（fail-closed，不编造默认值）。 */
function validateBound(bound: number | undefined): void {
  if (bound === undefined) return;
  if (typeof bound !== 'number' || !Number.isFinite(bound) || bound <= 0 || bound >= 1) {
    throw new Error(`等效界 δ 不合法：${String(bound)}（须显式给出 0<δ<1 的有限数；δ 无默认值）`);
  }
}

/** 校验差异区间：两端须为有限数且 lower≤upper；非法一律抛错（fail-closed）。 */
function validateInterval(interval: Interval): void {
  if (
    !Number.isFinite(interval.lower) ||
    !Number.isFinite(interval.upper) ||
    interval.lower > interval.upper
  ) {
    throw new Error(`区间不合法：[${String(interval.lower)}, ${String(interval.upper)}]（须为有限数且 lower≤upper）`);
  }
}

/**
 * Newcombe (1998) 方法 10（square-and-add）两独立比例差的 95% 区间，本仓口径 Δ = pB − pA。
 * 纯确定性标准法（无连续性校正）：以两臂各自的 Wilson 95% 区间 [lA,uA]、[lB,uB] 为原料，
 *   lower = Δ − sqrt((pB − lB)² + (uA − pA)²)
 *   upper = Δ + sqrt((uB − pB)² + (pA − lA)²)
 * 结果裁剪到 [−1, 1]。不跑模型、不触网、不依赖随机数。
 * 来源：Newcombe R.G. (1998) "Interval estimation for the difference between independent proportions:
 * comparison of eleven methods", Statist. Med. 17:873–890, method 10。
 * 锚点例（Table II 例 1）：48/80 vs 56/70 → [0.0524, 0.3339]（四位小数）。
 */
export function newcombe95(a: Arm, b: Arm): Interval {
  const aCI = wilson95(a.k, a.n);
  const bCI = wilson95(b.k, b.n);
  const pA = a.n === 0 ? 0 : a.k / a.n;
  const pB = b.n === 0 ? 0 : b.k / b.n;
  const delta = pB - pA;
  const lower = delta - Math.sqrt((pB - bCI.lower) ** 2 + (aCI.upper - pA) ** 2);
  const upper = delta + Math.sqrt((bCI.upper - pB) ** 2 + (pA - aCI.lower) ** 2);
  return { lower: Math.max(-1, lower), upper: Math.min(1, upper) };
}

/**
 * 差异区间 → 四态（v2 核心决策；边界一律严格，触界/跨界 fail-closed 到 INSUFFICIENT_EVIDENCE）。
 * 无界（bound 未提供）：区间整体 >0 → IMPROVED；整体 <0 → REGRESSED；否则 INSUFFICIENT_EVIDENCE；
 *   此路径结构上不可能产出 NO_SUBSTANTIAL_CHANGE_VERIFIED（无预注册界就不得宣称「经验证无实质变化」）。
 * 有界（0<δ<1）：整体 >δ → IMPROVED；整体 <−δ → REGRESSED；整体严格落在 (−δ, δ) 内 →
 *   NO_SUBSTANTIAL_CHANGE_VERIFIED；其余 → INSUFFICIENT_EVIDENCE。
 */
export function classifyDifference(deltaCI: Interval, bound?: number): CompareStateV2 {
  validateInterval(deltaCI);
  validateBound(bound);
  if (bound === undefined) {
    if (deltaCI.lower > 0) return 'IMPROVED';
    if (deltaCI.upper < 0) return 'REGRESSED';
    return 'INSUFFICIENT_EVIDENCE';
  }
  if (deltaCI.lower > bound) return 'IMPROVED';
  if (deltaCI.upper < -bound) return 'REGRESSED';
  if (deltaCI.lower > -bound && deltaCI.upper < bound) return 'NO_SUBSTANTIAL_CHANGE_VERIFIED';
  return 'INSUFFICIENT_EVIDENCE';
}

/**
 * 四态分类（v2 口径）：任一臂 N<MIN_SAMPLES → INSUFFICIENT_EVIDENCE；
 * 否则按 newcombe95 差异区间与显式等效界 δ 判定（δ 无默认值）。
 */
export function classifyV2(a: Arm, b: Arm, bound?: number): CompareResultV2 {
  validateBound(bound);
  const aCI = wilson95(a.k, a.n);
  const bCI = wilson95(b.k, b.n);
  const delta = (b.n === 0 ? 0 : b.k / b.n) - (a.n === 0 ? 0 : a.k / a.n);
  const deltaCI = newcombe95(a, b);
  const boundValue = bound === undefined ? null : bound;
  if (a.n < MIN_SAMPLES || b.n < MIN_SAMPLES) {
    return { state: 'INSUFFICIENT_EVIDENCE', delta, aCI, bCI, deltaCI, bound: boundValue };
  }
  return { state: classifyDifference(deltaCI, bound), delta, aCI, bCI, deltaCI, bound: boundValue };
}

/** CLI --bound 解析：Number(raw) 后复用同一校验；空串/非数/0/负/≥1/NaN/∞ 一律抛错（fail-closed）。 */
export function parseBound(raw: string): number {
  const value = Number(raw);
  validateBound(value);
  return value;
}

/** 失败分布：对多份 judgment 的 failureCodes 列表逐码计数。 */
export function failureHistogram(failureCodeLists: ReadonlyArray<readonly string[]>): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const list of failureCodeLists) {
    for (const code of list) {
      histogram[code] = (histogram[code] ?? 0) + 1;
    }
  }
  return histogram;
}

export interface TrialSummary {
  caseId: string;
  trial: number;
  verdict: string;
  failureCodes: string[];
  weakNotices: string[];
  assistedAvailable: boolean | null;
  /** 证据目录（绝对路径，仅供报告人核对；写入跟踪文件需自行去敏）。 */
  dir: string;
  /** 相对 runDir 的证据路径（报告展示用）。 */
  relDir: string;
}

export interface RunSummary {
  runDir: string;
  manifest: Record<string, unknown> | null;
  trials: TrialSummary[];
}

/** 只读 run-dir：manifest.json（可选）+ runs/<case>/trial-<n>/judgment.json（逐 trial）。 */
export function readRun(runDir: string): RunSummary {
  const runsRoot = path.join(runDir, 'runs');
  if (!existsSync(runsRoot)) throw new Error(`run 目录缺少 runs/：${runDir}`);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
    : null;
  const trials: TrialSummary[] = [];
  for (const caseId of readdirSync(runsRoot).sort()) {
    const caseDir = path.join(runsRoot, caseId);
    if (!statSync(caseDir).isDirectory()) continue;
    for (const trialName of readdirSync(caseDir).sort()) {
      const match = /^trial-(\d+)$/.exec(trialName);
      if (!match) continue;
      const dir = path.join(caseDir, trialName);
      const relDir = path.relative(runDir, dir);
      const judgmentPath = path.join(dir, 'judgment.json');
      if (!existsSync(judgmentPath)) {
        trials.push({
          caseId, trial: Number(match[1]), verdict: 'NO_JUDGMENT',
          failureCodes: [], weakNotices: [], assistedAvailable: null, dir, relDir,
        });
        continue;
      }
      const judgment = JSON.parse(readFileSync(judgmentPath, 'utf8')) as {
        deterministic?: { verdict?: unknown; failureCodes?: unknown };
        weakNotices?: unknown;
        assisted?: { available?: unknown };
      };
      const det = judgment.deterministic ?? {};
      const verdict = typeof det.verdict === 'string' ? det.verdict : 'NO_JUDGMENT';
      const failureCodes = Array.isArray(det.failureCodes) ? det.failureCodes.filter((code): code is string => typeof code === 'string') : [];
      const weakNotices = Array.isArray(judgment.weakNotices) ? judgment.weakNotices.filter((notice): notice is string => typeof notice === 'string') : [];
      const assistedAvailable = typeof judgment.assisted?.available === 'boolean' ? judgment.assisted.available : null;
      trials.push({ caseId, trial: Number(match[1]), verdict, failureCodes, weakNotices, assistedAvailable, dir, relDir });
    }
  }
  return { runDir, manifest, trials };
}

/** 观测成功率分子分母：PASS 计 k，全部有 judgment 的 trial 计 N（NO_JUDGMENT 不计入 N，单独展示）。 */
export function kOverN(trials: readonly TrialSummary[]): Arm {
  const judged = trials.filter((trial) => trial.verdict !== 'NO_JUDGMENT');
  return { k: judged.filter((trial) => trial.verdict === 'PASS').length, n: judged.length };
}

function fmtInterval(ci: Interval): string {
  return `[${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}]`;
}

function fmtArm(arm: Arm, ci: Interval): string {
  return `${arm.k}/${arm.n}（CI ${fmtInterval(ci)}）`;
}

function caseIdsOf(...runs: readonly RunSummary[]): string[] {
  return [...new Set(runs.flatMap((run) => run.trials.map((trial) => trial.caseId)))].sort();
}

export interface CompareOptions {
  /** 预注册等效界 δ（0<δ<1，显式提供）；不提供 = v1 三态口径（不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED）。 */
  bound?: number;
}

/**
 * compare 输出（Markdown 文本）。
 * 缺省：v1 三态（A/B 双臂逐单元 k/N + 双 Wilson CI + Δ + 口径版本标注）；
 * 提供 bound：v2 四态（附差异区间 Δ 95% CI（Newcombe）与 δ 标注）。
 */
export function renderCompare(a: RunSummary, b: RunSummary, options: CompareOptions = {}): string {
  const bound = options.bound;
  validateBound(bound);
  const lines: string[] = [
    '# compare（双臂对照；k/N 一律附 Wilson 95% CI，不得解读为稳定概率）',
    '',
    `- A：${a.runDir}`,
    `- B：${b.runDir}`,
  ];
  const caseIds = caseIdsOf(a, b);
  if (bound === undefined) {
    lines.push(
      '- 口径版本：v1（三态：INSUFFICIENT_SAMPLES / IMPROVED / NO_MEANINGFUL_CHANGE；未提供预注册等效界）',
      `- 三态口径：任一臂 N<${MIN_SAMPLES} → INSUFFICIENT_SAMPLES；B 的 CI 下界 > A 的 CI 上界 → IMPROVED；否则 NO_MEANINGFUL_CHANGE（附 Δ=pB−pA）；NO_MEANINGFUL_CHANGE 不代表已证明无改善——给出「无实质变化」结论需显式 --bound <δ>（v2 四态）`,
      '',
      '| 用例 | A k/N（Wilson 95% CI） | B k/N（Wilson 95% CI） | Δ（pp） | 三态 |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const caseId of caseIds) {
      const armA = kOverN(a.trials.filter((trial) => trial.caseId === caseId));
      const armB = kOverN(b.trials.filter((trial) => trial.caseId === caseId));
      const result = classify(armA, armB);
      const deltaPp = `${(result.delta * 100).toFixed(1)}`;
      lines.push(`| ${caseId} | ${fmtArm(armA, result.aCI)} | ${fmtArm(armB, result.bCI)} | ${result.delta >= 0 ? '+' : ''}${deltaPp} | ${result.state} |`);
    }
    if (caseIds.length === 0) lines.push('| （无样本） | - | - | - | - |');
    return lines.join('\n') + '\n';
  }
  lines.push(
    `- 口径版本：v2（四态：IMPROVED / REGRESSED / INSUFFICIENT_EVIDENCE / NO_SUBSTANTIAL_CHANGE_VERIFIED；预注册等效界 δ=${bound}（${(bound * 100).toFixed(1)}pp））`,
    `- 四态口径：差异区间 = Newcombe 1998 方法 10（square-and-add）95% 区间，Δ=pB−pA；整体 >δ → IMPROVED；整体 <−δ → REGRESSED；整体严格落在 (−δ, δ) 内 → NO_SUBSTANTIAL_CHANGE_VERIFIED；其余（任一臂 N<${MIN_SAMPLES}、触界、跨界）→ INSUFFICIENT_EVIDENCE；边界严格`,
    '',
    '| 用例 | A k/N（Wilson 95% CI） | B k/N（Wilson 95% CI） | Δ（pp） | Δ 95% CI（Newcombe） | 四态 |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const caseId of caseIds) {
    const armA = kOverN(a.trials.filter((trial) => trial.caseId === caseId));
    const armB = kOverN(b.trials.filter((trial) => trial.caseId === caseId));
    const result = classifyV2(armA, armB, bound);
    const deltaPp = `${(result.delta * 100).toFixed(1)}`;
    lines.push(`| ${caseId} | ${fmtArm(armA, result.aCI)} | ${fmtArm(armB, result.bCI)} | ${result.delta >= 0 ? '+' : ''}${deltaPp} | ${fmtInterval(result.deltaCI)} | ${result.state} |`);
  }
  if (caseIds.length === 0) lines.push('| （无样本） | - | - | - | - | - |');
  return lines.join('\n') + '\n';
}

/** report 输出（Markdown 文本；版本段 + 单元段 + 安全段）。 */
export function renderReport(run: RunSummary): string {
  const manifest = run.manifest ?? {};
  const git = (manifest.git ?? {}) as Record<string, unknown>;
  const model = (manifest.model ?? {}) as Record<string, unknown>;
  const judge = (manifest.judge ?? {}) as Record<string, unknown>;
  const suite = (manifest.suite ?? null) as Record<string, unknown> | null;
  const lines: string[] = [
    '# 质量与覆盖报告（R3 Batch 2 · 用户级 eval；全样本，不筛绿）',
    '',
    `- run 目录：${run.runDir}`,
    `- runId：${String(manifest.runId ?? '（未记录）')}`,
    '',
    '## 版本段',
    `- 模型：${String(model.id ?? '（未记录）')}（baseUrlHost=${String(model.baseUrlHost ?? '')}，thinkingLevel=${String(model.thinkingLevel ?? '')}，keyPresent=${String(model.keyPresent ?? '')}）`,
    `- 代码：head=${String(git.head ?? '')} branch=${String(git.branch ?? '')} dirty=${String(git.dirty ?? '')}`,
    `- 判据：criteriaVersion=${String(manifest.criteriaVersion ?? '')} judgeVersion=${String(judge.version ?? '')}；criteriaSha256=${String(manifest.criteriaSha256 ?? '')}`,
    `- casesSha256=${String(manifest.casesSha256 ?? '')}`,
  ];

  // suite lock 校验读数（安全段复用）。
  let safetyLock = 'N/A（未记录 suite lock）';
  if (suite !== null && typeof suite.lockPath === 'string') {
    const lockPath = suite.lockPath;
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      const match = lock.criteriaSha256 === manifest.criteriaSha256 && lock.casesSha256 === manifest.casesSha256;
      lines.push(`- suite lock：${lockPath}（与 manifest ${match ? '一致' : '不一致'}）`);
      safetyLock = match ? 'PASS（criteriaSha256/casesSha256 两聚合值与 lock 一致）' : 'FAIL（哈希不一致——冻结面漂移）';
    } else {
      lines.push(`- suite lock：${lockPath}（缺失）`);
      safetyLock = 'FAIL（锁缺失）';
    }
  } else {
    lines.push('- suite lock：未记录（R1 默认路径或旧 manifest）');
  }

  lines.push('', '## 单元段（逐单元 k/N + Wilson 95% CI + 失败分布 + 证据路径）', '');
  const caseIds = caseIdsOf(run);
  for (const caseId of caseIds) {
    const trials = run.trials.filter((trial) => trial.caseId === caseId).sort((x, y) => x.trial - y.trial);
    const arm = kOverN(trials);
    const ci = wilson95(arm.k, arm.n);
    const histogram = failureHistogram(trials.map((trial) => trial.failureCodes));
    const histogramEntries = Object.entries(histogram).sort(([x], [y]) => x.localeCompare(y));
    lines.push(`### ${caseId} — ${arm.k}/${arm.n} PASS（Wilson 95% CI ${fmtInterval(ci)}）`);
    lines.push(`- 失败分布：${histogramEntries.length > 0 ? histogramEntries.map(([code, count]) => `${code}×${count}`).join('、') : '（无 FAIL 码）'}`);
    const noJudgment = trials.filter((trial) => trial.verdict === 'NO_JUDGMENT').length;
    if (noJudgment > 0) lines.push(`- 无 judgment 的 trial：${noJudgment}（不计入 N，证据待补）`);
    for (const trial of trials) {
      const codes = trial.failureCodes.length > 0 ? `（${trial.failureCodes.join(', ')}）` : '';
      lines.push(`- trial-${trial.trial}：${trial.verdict}${codes}；证据：${trial.relDir}`);
    }
    lines.push('');
  }
  if (caseIds.length === 0) lines.push('（无样本）');

  const isolation = (manifest.isolation ?? null) as Record<string, unknown> | null;
  const assistedStates = run.trials.map((trial) => trial.assistedAvailable);
  const assistedLine = assistedStates.length === 0
    ? '（无样本）'
    : assistedStates.every((value) => value === false)
      ? '全部 judgment 的 assisted.available=false（LLM judge 不参与裁决）'
      : assistedStates.map(String).join('、');
  lines.push('## 安全段（确定性门清单与读数；零违规观测 ≠ 绝对安全）', '');
  lines.push(`- 评测隔离门（assessEvalIsolation）：${isolation !== null ? String(isolation.safetyGate ?? '未记录') : '未记录'}`);
  lines.push(`- 冻结锁校验：${safetyLock}`);
  lines.push(`- 判定器不变量：judgeVersion=${String(judge.version ?? '')}；assisted=${assistedLine}`);
  lines.push('- 口径声明：本报告只呈现读到的读数；安全不变量（E09/E10/E11 等）以确定性门与回归否决为准，不以本段推断安全性；k/N 一律附 Wilson 95% CI，不得解读为稳定概率。');
  return lines.join('\n') + '\n';
}

const USAGE = [
  '用法：node --import tsx scripts/eval/exploration/stats.ts <command> [args]',
  '  compare --a <dirA> --b <dirB> [--bound <δ>] [--out <file>]   双臂逐单元 k/N + Wilson 95% CI + Δ；缺省三态（v1），--bound 时四态（v2，Newcombe 差异区间）',
  '  report  --run <dir> [--out <file>]                             质量与覆盖报告（版本/单元/安全三段）',
].join('\n');

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) throw new Error(`不能识别的参数：${arg}`);
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
    flags[arg.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function emit(output: string, out: string | undefined): void {
  if (out === undefined) {
    process.stdout.write(output);
    return;
  }
  const target = path.resolve(out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, output);
  console.log(`[stats] 已写入 ${out}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'compare') {
    const flags = parseFlags(rest);
    if (flags['a'] === undefined || flags['b'] === undefined) throw new Error('compare 需要 --a <dirA> --b <dirB> [--bound <δ>] [--out <file>]');
    const rawBound = flags['bound'];
    const options: CompareOptions = rawBound === undefined ? {} : { bound: parseBound(rawBound) };
    emit(renderCompare(readRun(path.resolve(flags['a'])), readRun(path.resolve(flags['b'])), options), flags['out']);
    return;
  }
  if (command === 'report') {
    const flags = parseFlags(rest);
    if (flags['run'] === undefined) throw new Error('report 需要 --run <dir> [--out <file>]');
    emit(renderReport(readRun(path.resolve(flags['run']))), flags['out']);
    return;
  }
  console.error(`${USAGE}\n未知命令：${String(command ?? '（缺省）')}`);
  process.exitCode = 2;
}

const isEntry = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntry) {
  await main().catch((error: unknown) => {
    console.error('stats 运行失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
