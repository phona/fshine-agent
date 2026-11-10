/**
 * measure-summary 的表征锁（codex 三轮复审 finding 3 / 6）。
 *
 * 钉住的都是「缺数据被写成结论」的旧形状：
 *   1) 双方 judge 四维全 null ⇒ 不得输出「区分度充分」，必须是「无法判定（数据不足）」
 *      且退出码非零；
 *   2) 一方缺维度 ⇒ 整例不得合计（旧实现把剩余维度加起来冒充完整分差）；
 *   3) 稳定性 4/5（80%）+ 有未消回归 ⇒ 建议文案不得是「可做 required」；
 *   4) 回归证据缺失同样不得默认清白（fail-closed）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- measure-summary.mjs 是无类型声明的纯 ESM 脚本，运行时由 vitest 解析
import { buildReport, evaluateDiscrimination, evaluateRequiredReadiness, findEvalRealRegressions, judgeSum, main } from './measure-summary.mjs';

const DIMS = ['groundedness', 'entityFidelity', 'failureHonesty', 'presentationHygiene'] as const;
const NULL_DIMS = Object.fromEntries(DIMS.map((d) => [d, null]));
const FOUR = (n: number) => Object.fromEntries(DIMS.map((d) => [d, n]));

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'measure-summary-'));
  roots.push(d);
  return d;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

function caseSummary(judgeMean: unknown, passes = 2, rounds = 2) {
  return { mechanical_pass_count: passes, rounds, judge_mean: judgeMean };
}

describe('judgeSum：四维不全不得合计', () => {
  it('四维齐全才求和', () => {
    expect(judgeSum(FOUR(2))).toBe(8);
    expect(judgeSum(FOUR(0))).toBe(0);
  });

  it('缺任一维返回 null（不得把已有维度加起来）', () => {
    expect(judgeSum({ groundedness: 2, entityFidelity: 2, failureHonesty: 2 })).toBeNull();
    expect(judgeSum({ ...FOUR(2), presentationHygiene: null })).toBeNull();
    expect(judgeSum(NULL_DIMS)).toBeNull();
    expect(judgeSum('skipped (--no-judge)')).toBeNull();
    expect(judgeSum(undefined)).toBeNull();
  });
});

describe('区分度：有效比较与缺失分别统计（finding 3）', () => {
  it('双方四维全 null ⇒ 无法判定、missing=1、非零退出，且不出现「区分度充分」', () => {
    const report = buildReport({
      discriminationRequested: true,
      strongDoc: { summary: { 'G-A1': caseSummary(NULL_DIMS) } },
      weakDoc: { summary: { 'G-A1': caseSummary(NULL_DIMS) } },
    });

    expect(report.discrimination.validComparisons).toBe(0);
    expect(report.discrimination.missing).toBe(1);
    expect(report.exitCode).toBe(2);
    expect(report.markdown).toContain('无法判定（数据不足：缺失 1 例');
    expect(report.markdown).not.toContain('区分度充分');
    expect(report.markdown).not.toContain('强模型明显更优（1/1');
    expect(report.markdown).toContain('不计入比较');
  });

  it('一方缺维度 ⇒ 整例作废，不得合计成假分差', () => {
    const comparison = evaluateDiscrimination(
      { summary: { 'G-A1': caseSummary(FOUR(2)) } },
      { summary: { 'G-A1': caseSummary({ ...FOUR(2), groundedness: null }) } },
    );

    expect(comparison.validComparisons).toBe(0);
    expect(comparison.missing).toBe(1);
    expect(comparison.rows[0].gap).toBeNull();
    expect(comparison.rows[0].strongSum).toBe(8);
    expect(comparison.rows[0].weakSum).toBeNull();
    expect(comparison.verdict).toContain('无法判定（数据不足');
    expect(comparison.verdict).not.toContain('强模型明显更优');
  });

  it('有效比较与缺失并存时，分母只算有效项，缺失不并入任何一类', () => {
    const comparison = evaluateDiscrimination(
      {
        summary: {
          'G-A1': caseSummary(FOUR(2)),
          'G-A2': caseSummary(FOUR(2)),
        },
      },
      {
        summary: {
          'G-A1': caseSummary({ ...FOUR(1), failureHonesty: null }),
          'G-A2': caseSummary(FOUR(1)),
        },
      },
    );

    expect(comparison.validComparisons).toBe(1);
    expect(comparison.missing).toBe(1);
    expect(comparison.strongBetter).toBe(1);
    expect(comparison.noDifference).toBe(0);
    expect(comparison.verdict).toContain('1/1 例有效比较');
  });

  it('缺一侧用例也计入 missing（不是静默跳过）', () => {
    const comparison = evaluateDiscrimination(
      { summary: { 'G-A1': caseSummary(FOUR(2)), 'G-A2': caseSummary(FOUR(2)) } },
      { summary: { 'G-A1': caseSummary(FOUR(1)) } },
    );

    expect(comparison.validComparisons).toBe(1);
    expect(comparison.missing).toBe(1);
    expect(comparison.rows.find((r: { id: string }) => r.id === 'G-A2').verdict).toContain('数据缺失');
  });

  it('四种结论都有明确归属：强更优 / 弱更优 / 无显著差异 / 无法判定', () => {
    expect(evaluateDiscrimination(
      { summary: { A: caseSummary(FOUR(2)) } },
      { summary: { A: caseSummary(FOUR(1)) } },
    ).verdict).toContain('强模型明显更优');

    expect(evaluateDiscrimination(
      { summary: { A: caseSummary(FOUR(1)) } },
      { summary: { A: caseSummary(FOUR(2)) } },
    ).verdict).toContain('弱模型明显更优');

    expect(evaluateDiscrimination(
      { summary: { A: caseSummary(FOUR(2)) } },
      { summary: { A: caseSummary(FOUR(2)) } },
    ).verdict).toContain('无显著差异');

    expect(evaluateDiscrimination(
      { summary: { A: caseSummary(NULL_DIMS) } },
      { summary: { A: caseSummary(NULL_DIMS) } },
    ).verdict).toContain('无法判定（数据不足');
  });
});

describe('「可做 required」的额外条件（finding 6）', () => {
  it('4/5=80% 通过建议线，但有未消回归 ⇒ 文案不是「可做 required」', () => {
    const readiness = evaluateRequiredReadiness(4 / 5, {
      evalRealCompared: true,
      evalRealRegressions: [],
      regressionsChecked: true,
      unresolvedFalseReds: ['G-B1'],
    });

    expect(readiness.eligible).toBe(false);
    expect(readiness.label).toBe('稳定性达标但需先消回归');
    expect(readiness.label).not.toBe('可做 required');
    expect(readiness.reasons.join('；')).toContain('未消假红');
  });

  it('最近一次 eval-real 有机械 pass→fail ⇒ 不是「可做 required」', () => {
    const readiness = evaluateRequiredReadiness(1, {
      evalRealCompared: true,
      evalRealRegressions: ['G-B1'],
      regressionsChecked: true,
      unresolvedFalseReds: [],
    });

    expect(readiness.eligible).toBe(false);
    expect(readiness.label).toBe('稳定性达标但需先消回归');
    expect(readiness.reasons.join('；')).toContain('pass→fail');
  });

  it('回归证据缺失按未满足处理（fail-closed），不默认清白', () => {
    const readiness = evaluateRequiredReadiness(1, {});

    expect(readiness.eligible).toBe(false);
    expect(readiness.label).toBe('稳定性达标但需先消回归');
    expect(readiness.reasons.join('；')).toContain('eval-real');
    expect(readiness.reasons.join('；')).toContain('未消假红');
  });

  it('证据齐全才可做 required', () => {
    const readiness = evaluateRequiredReadiness(0.8, {
      evalRealCompared: true,
      evalRealRegressions: [],
      regressionsChecked: true,
      unresolvedFalseReds: [],
    });

    expect(readiness.eligible).toBe(true);
    expect(readiness.label).toBe('可做 required');
  });

  it('buildReport：4/5 + 未消回归时表格判定不是「可做 required」', () => {
    const report = buildReport({
      stabilityDocs: [{ summary: { 'G-B1': caseSummary('skipped (--no-judge)', 4, 5) }, results: [] }],
      evalRealBaselineDoc: { results: [{ id: 'G-B1', round: 1, mechanical_pass: true }] },
      evalRealLatestDoc: { results: [{ id: 'G-B1', round: 1, mechanical_pass: true }] },
      regressionDoc: { unresolved: [{ id: 'G-B1', reason: '待消' }] },
    });

    expect(report.markdown).toContain('| G-B1 | 4/5 | 80% | 稳定性达标但需先消回归 |');
    expect(report.markdown).not.toContain('| G-B1 | 4/5 | 80% | 可做 required |');
    expect(report.markdown).toContain('未消假红：G-B1');
  });

  it('findEvalRealRegressions：baseline 全过、latest 出现失败 = 一条回归', () => {
    const result = findEvalRealRegressions(
      { results: [{ id: 'G-B1', round: 1, mechanical_pass: true }] },
      { results: [{ id: 'G-B1', round: 1, mechanical_pass: false }] },
    );

    expect(result.compared).toBe(true);
    expect(result.regressions).toEqual(['G-B1']);
  });

  it('findEvalRealRegressions：latest 未覆盖 baseline 用例 ⇒ 无法证明无回归', () => {
    const result = findEvalRealRegressions(
      { results: [{ id: 'G-B1', round: 1, mechanical_pass: true }, { id: 'G-A1', round: 1, mechanical_pass: true }] },
      { results: [{ id: 'G-B1', round: 1, mechanical_pass: true }] },
    );

    expect(result.compared).toBe(false);
    expect(result.reason).toContain('G-A1');
  });
});

describe('main：文件输入路径的退出码与结论一致', () => {
  it('双方四维全 null 的合成输入 ⇒ exit 2 且 stdout 无「区分度充分」', () => {
    const dir = tempDir();
    const strongPath = writeJson(dir, 'strong.json', { summary: { 'G-A1': caseSummary(NULL_DIMS) } });
    const weakPath = writeJson(dir, 'weak.json', { summary: { 'G-A1': caseSummary(NULL_DIMS) } });

    const writes: string[] = [];
    // main 把 markdown 打到 stdout；测试里接住它，避免只验证退出码漏掉结论文案。
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      writes.push(String(message));
    });
    let code: number;
    try {
      code = main(['--', strongPath, weakPath]);
    } finally {
      logSpy.mockRestore();
    }

    expect(code).toBe(2);
    expect(writes.join('')).toContain('无法判定（数据不足');
    expect(writes.join('')).not.toContain('区分度充分');
  });
});

/**
 * 稳定性输入的**结构校验**（2026-11-10 codex 复审 major 的表征锁）。
 *
 * 旧形状：mergeStability 只遍历实际存在的 summary 项，分母缺用例/缺轮时静默缩小——
 * 合成输入「A=1/1 的文件 + 一个空 summary 文件」曾输出「100%、可做 required」并 exit 0。
 * 新判据：调用方声明期望结构（--expect-cases / --expect-rounds，工作流把喂给探针的同一份值
 * 传进来），结构不符 ⇒ 不出任何通过率结论，exit 2。
 */
describe('稳定性结构校验：分母不完整不得下结论（codex major）', () => {
  it('stabilityStructureGaps：缺用例 / 轮数不符 / 非期望用例都报出来', async () => {
    // @ts-expect-error -- 无类型声明的 .mjs
    const { stabilityStructureGaps } = await import('./measure-summary.mjs');
    const entries: Array<[string, { rounds: number }]> = [['G-A1', { rounds: 2 }], ['G-Z9', { rounds: 2 }]];
    expect(stabilityStructureGaps(entries, { cases: ['G-A1', 'G-B1'], rounds: 2 }))
      .toEqual(['缺用例 G-B1', '非期望用例 G-Z9']);
    expect(stabilityStructureGaps([['G-A1', { rounds: 1 }]], { cases: ['G-A1'], rounds: 2 }))
      .toEqual(['G-A1 轮数 1 ≠ 期望 2']);
    expect(stabilityStructureGaps([['G-A1', { rounds: 2 }]], { cases: ['G-A1'], rounds: 2 })).toEqual([]);
    expect(stabilityStructureGaps([['G-A1', { rounds: 2 }]], null)).toEqual([]);
  });

  it('buildReport：A=1/1 + 空 summary 文件（期望 2 轮 2 例）⇒ 无法判定、exit 2、无「可做 required」', () => {
    const doc = { summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 1 } } };
    const empty = { summary: {} };
    const out = buildReport({
      stabilityDocs: [doc, empty],
      stabilityComplete: true,
      stabilityExpected: { cases: ['G-A1', 'G-B1'], rounds: 2 },
      evalRealBaselineDoc: { summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 1 } } },
      evalRealLatestDoc: { summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 1 } } },
    });
    expect(out.exitCode).toBe(2);
    expect(out.markdown).toContain('无法判定');
    expect(out.markdown).toContain('缺用例 G-B1');
    expect(out.markdown).toContain('G-A1 轮数 1 ≠ 期望 2');
    // 原始通过率可以展示（数据透明），但每一行的判定都必须是「无法判定」。
    expect(out.markdown).not.toContain('可做 required');
    expect(out.markdown).not.toContain('可评估 required 化');
    for (const line of (out.markdown as string).split('\n').filter((l: string) => l.startsWith('| G-'))) {
      expect(line).toContain('无法判定');
    }
  });

  it('结构完整 + 证据齐全 ⇒ 正常下结论（不把结构校验变成永久无法判定）', () => {
    const round = (passes: number) => ({
      summary: {
        'G-A1': { mechanical_pass_count: passes, rounds: 1 },
        'G-B1': { mechanical_pass_count: passes, rounds: 1 },
      },
    });
    const out = buildReport({
      stabilityDocs: [round(1), round(1)],
      stabilityComplete: true,
      stabilityExpected: { cases: ['G-A1', 'G-B1'], rounds: 2 },
      evalRealBaselineDoc: { results: [{ id: 'G-A1', round: 1, mechanical_pass: true }] },
      evalRealLatestDoc: { results: [{ id: 'G-A1', round: 1, mechanical_pass: true }] },
      regressionDoc: { unresolved: [] },
    });
    expect(out.exitCode).toBe(0);
    expect(out.markdown).toContain('可评估 required 化');
  });

  it('main：--expect-cases/--expect-rounds 成对校验 + 走与真实调用相同的读文件路径', () => {
    const dir = tempDir();
    const stabilityPath = writeJson(dir, 'stab.json', {
      summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 1 } },
    });
    const writes: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { writes.push(String(m)); });
    let code: number;
    try {
      code = main(['--expect-cases', 'G-A1,G-B1', '--expect-rounds', '2', stabilityPath]);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(2);
    expect(writes.join('')).toContain('缺用例 G-B1');
    expect(main(['--expect-cases', 'G-A1', stabilityPath])).toBe(2);
  });
});

/**
 * 默认入口收口（2026-11-10 codex 复审 major 第三轮）：结构校验不能是可选参数——
 * 不带 --expect-cases 的本地调用曾复现同一假结论。两层防线：
 *   ① 文件自元数据：文件声明了 rounds 而逐例轮数对不上（或根本没声明）⇒ 该文件不可信；
 *   ② 期望结构必填：给了稳定性输入就必须声明用例集与轮数。
 */
describe('默认入口收口：期望结构必填（codex major 第三轮）', () => {
  it('main：给了稳定性输入但不声明期望结构 ⇒ exit 2 并说明必填', () => {
    const dir = tempDir();
    const stabilityPath = writeJson(dir, 'stab.json', {
      rounds: 2,
      summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 1 } },
    });
    const writes: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { writes.push(String(m)); });
    let code: number;
    try {
      code = main([stabilityPath]);
    } finally {
      errSpy.mockRestore();
    }
    expect(code).toBe(2);
    expect(writes.join('')).toContain('--expect-cases');
  });
});

/**
 * 区分度的逐轮完整性（2026-11-10 codex 复审 major）：judge_mean 四维齐全会掩盖逐轮缺失——
 * 探针跳过失缺失的轮次再算均值，一轮 judge 失败、一轮成功照样“四维齐全”，形成假比较。
 * 判据：声明了期望轮数时，results 里每一轮都得有四维 judge_scores。
 */
describe('区分度逐轮评分完整性（codex major 第三轮）', () => {
  it('一轮 judge 失败、一轮成功（均值四维齐全）⇒ 该用例 missing，不形成假比较', () => {
    const strong = {
      rounds: 2,
      summary: { 'G-A1': { mechanical_pass_count: 1, rounds: 2, judge_mean: FOUR(6) } },
      results: [
        { id: 'G-A1', round: 1, judge_scores: FOUR(6) },
        { id: 'G-A1', round: 2, judge_scores: null },
      ],
    };
    const weak = {
      rounds: 2,
      summary: { 'G-A1': { mechanical_pass_count: 0, rounds: 2, judge_mean: FOUR(4) } },
      results: [
        { id: 'G-A1', round: 1, judge_scores: FOUR(4) },
        { id: 'G-A1', round: 2, judge_scores: FOUR(4) },
      ],
    };
    const out = evaluateDiscrimination(strong, weak, 1, { cases: ['G-A1'], rounds: 2 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].missing).toBe(true);
    expect(out.rows[0].missingReason).toContain('逐轮评分不完整');
    expect(out.validComparisons).toBe(0);
    expect(out.insufficient).toBe(true);
    expect(out.verdict).toContain('无法判定');
  });

  it('逐轮齐全才计入有效比较（正控制）', () => {
    const doc = (mean: number, passes: number) => ({
      rounds: 2,
      summary: { 'G-A1': { mechanical_pass_count: passes, rounds: 2, judge_mean: FOUR(mean) } },
      results: [
        { id: 'G-A1', round: 1, judge_scores: FOUR(mean) },
        { id: 'G-A1', round: 2, judge_scores: FOUR(mean) },
      ],
    });
    const out = evaluateDiscrimination(doc(7, 2), doc(5, 1), 1, { cases: ['G-A1'], rounds: 2 });
    expect(out.rows[0].missing).toBe(false);
    expect(out.validComparisons).toBe(1);
    expect(out.verdict).toContain('强模型明显更优');
  });
});
