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
