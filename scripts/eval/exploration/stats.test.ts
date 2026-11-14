/**
 * stats.ts 单元测试（TDD：先红后绿）。
 *
 * 期望值为按标准 Wilson score 区间公式（z=1.96）**独立计算后写死**的参考值
 * （不调用 wilson95 自己生成期望，避免自证）。
 * 运行：npx vitest run --project unit scripts/eval/exploration/stats.test.ts
 *
 * 反向绊线（文档化，实施时逐个演示）：把 Z95 改成 1.0、把严格 > 改成 >=、
 * 把 IMPROVED/NO_MEANINGFUL_CHANGE 判定反转——本文件必须转红。
 * S4 追加绊线（四态）：给 δ 编造默认值（无界也进等效判定）→「无界不变量」转红；
 * 界边界判定放宽（< → <=）→ 触界用例转红；IMPROVED/REGRESSED 方向反转 → 方向用例转红。
 *
 * S4（四态口径）期望值来源：Newcombe 1998 方法 10 公式独立计算后写死
 * （计算脚本不进仓库，证据落在本工作树 .runtime/s4/newcombe-reference.mjs）；
 * 锚点 48/80 vs 56/70 = Newcombe(1998) Table II 例 1，方法 10 四位小数界限 0.0524/0.3339。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classify,
  classifyCIs,
  classifyDifference,
  classifyV2,
  failureHistogram,
  newcombe95,
  parseBound,
  renderCompare,
  wilson95,
  type RunSummary,
  type TrialSummary,
} from './stats';

describe('wilson95（z=1.96 标准 Wilson score 区间；期望值为公式独立计算后写死）', () => {
  const references: ReadonlyArray<{ k: number; n: number; lower: number; upper: number }> = [
    { k: 0, n: 9, lower: 0, upper: 0.299152754 },
    { k: 1, n: 9, lower: 0.019890371, upper: 0.435006215 },
    { k: 3, n: 9, lower: 0.120581599, upper: 0.645802653 },
    { k: 5, n: 9, lower: 0.266647346, upper: 0.811224571 },
    { k: 8, n: 9, lower: 0.564993785, upper: 0.980109629 },
    { k: 9, n: 9, lower: 0.700847246, upper: 1 },
    { k: 0, n: 15, lower: 0, upper: 0.203889266 },
    { k: 15, n: 15, lower: 0.796110734, upper: 1 },
  ];

  for (const reference of references) {
    it(`${reference.k}/${reference.n} → [${reference.lower}, ${reference.upper}]`, () => {
      const interval = wilson95(reference.k, reference.n);
      expect(interval.lower).toBeCloseTo(reference.lower, 8);
      expect(interval.upper).toBeCloseTo(reference.upper, 8);
      expect(interval.lower).toBeLessThanOrEqual(interval.upper);
      expect(interval.lower).toBeGreaterThanOrEqual(0);
      expect(interval.upper).toBeLessThanOrEqual(1);
    });
  }

  it('N=0 约定为最大不确定 [0,1]（无样本不产生虚假区间）', () => {
    expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it('非法参数 fail-closed 抛错', () => {
    expect(() => wilson95(10, 9)).toThrow();
    expect(() => wilson95(-1, 9)).toThrow();
    expect(() => wilson95(1, 0.5)).toThrow();
  });
});

describe('classify（三态：INSUFFICIENT_SAMPLES / IMPROVED / NO_MEANINGFUL_CHANGE）', () => {
  it('任一臂 N<9 → INSUFFICIENT_SAMPLES（含空臂 N=0）', () => {
    expect(classify({ k: 1, n: 1 }, { k: 8, n: 9 }).state).toBe('INSUFFICIENT_SAMPLES');
    expect(classify({ k: 0, n: 9 }, { k: 0, n: 0 }).state).toBe('INSUFFICIENT_SAMPLES');
    expect(classify({ k: 3, n: 8 }, { k: 3, n: 8 }).state).toBe('INSUFFICIENT_SAMPLES');
  });

  it('B 的 CI 下界 > A 的 CI 上界 → IMPROVED（参考：1/9 vs 8/9）', () => {
    const result = classify({ k: 1, n: 9 }, { k: 8, n: 9 });
    expect(result.state).toBe('IMPROVED');
    expect(result.bCI.lower).toBeGreaterThan(result.aCI.upper);
  });

  it('CI 重叠 → NO_MEANINGFUL_CHANGE（附 Δ = pB − pA；参考：7/9 vs 8/9）', () => {
    const result = classify({ k: 7, n: 9 }, { k: 8, n: 9 });
    expect(result.state).toBe('NO_MEANINGFUL_CHANGE');
    expect(result.delta).toBeCloseTo(1 / 9, 10);
  });

  it('严格边界：下界 == 上界不算改善（严格 > 而非 >=；反向绊线参考）', () => {
    expect(classifyCIs({ lower: 0, upper: 0.3 }, { lower: 0.3, upper: 1 })).toBe('NO_MEANINGFUL_CHANGE');
    expect(classifyCIs({ lower: 0, upper: 0.3 }, { lower: 0.3000001, upper: 1 })).toBe('IMPROVED');
  });
});

describe('failureHistogram（读 judgment failureCodes 的失败分布）', () => {
  it('逐码计数；空输入得空表', () => {
    expect(
      failureHistogram([['FAIL_WRONG_OBJECT'], ['FAIL_WRONG_OBJECT', 'FAIL_ZERO_EXECUTION'], []]),
    ).toEqual({ FAIL_WRONG_OBJECT: 2, FAIL_ZERO_EXECUTION: 1 });
    expect(failureHistogram([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// S4：统计四态（v2 口径）+ 预注册等效界（δ 为显式输入、无默认值、不得编造）
// ---------------------------------------------------------------------------

const BOUND = 0.1;

describe('newcombe95（Newcombe 1998 方法 10：Wilson 95% + square-and-add；Δ=pB−pA）', () => {
  it('锚点：48/80 vs 56/70（Table II 例 1；四位小数 0.0524/0.3339）', () => {
    const interval = newcombe95({ k: 48, n: 80 }, { k: 56, n: 70 });
    expect(interval.lower).toBeCloseTo(0.052428713, 8);
    expect(interval.upper).toBeCloseTo(0.333874935, 8);
    expect(interval.lower).toBeCloseTo(0.0524, 4);
    expect(interval.upper).toBeCloseTo(0.3339, 4);
  });

  it('交换臂：差异区间镜像取负（Δ 变号）', () => {
    const ab = newcombe95({ k: 48, n: 80 }, { k: 56, n: 70 });
    const ba = newcombe95({ k: 56, n: 70 }, { k: 48, n: 80 });
    expect(ba.lower).toBeCloseTo(-ab.upper, 10);
    expect(ba.upper).toBeCloseTo(-ab.lower, 10);
  });

  it('参考向量（公式独立计算后写死）', () => {
    const vectors: ReadonlyArray<{
      a: { k: number; n: number };
      b: { k: number; n: number };
      lower: number;
      upper: number;
    }> = [
      { a: { k: 7, n: 9 }, b: { k: 8, n: 9 }, lower: -0.249705391, upper: 0.44885753 },
      { a: { k: 1, n: 9 }, b: { k: 8, n: 9 }, lower: 0.319720929, upper: 0.906783385 },
      { a: { k: 90, n: 100 }, b: { k: 91, n: 100 }, lower: -0.075009015, upper: 0.09537244 },
      { a: { k: 50, n: 100 }, b: { k: 80, n: 100 }, lower: 0.169081546, upper: 0.416999154 },
    ];
    for (const vector of vectors) {
      const interval = newcombe95(vector.a, vector.b);
      expect(interval.lower).toBeCloseTo(vector.lower, 8);
      expect(interval.upper).toBeCloseTo(vector.upper, 8);
    }
  });
});

describe('classifyDifference（差异区间 → 四态；边界严格；缺界不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED）', () => {
  it('无界：区间整体 >0 → IMPROVED；整体 <0 → REGRESSED；跨/触 0 → INSUFFICIENT_EVIDENCE', () => {
    expect(classifyDifference({ lower: 0.000000001, upper: 0.05 })).toBe('IMPROVED');
    expect(classifyDifference({ lower: 0.05, upper: 0.3 })).toBe('IMPROVED');
    expect(classifyDifference({ lower: -0.3, upper: -0.05 })).toBe('REGRESSED');
    expect(classifyDifference({ lower: -0.05, upper: -0.000000001 })).toBe('REGRESSED');
    expect(classifyDifference({ lower: 0, upper: 0.05 })).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.05, upper: 0 })).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.05, upper: 0.05 })).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('有界：区间整体严格落在 (−δ, δ) 内 → NO_SUBSTANTIAL_CHANGE_VERIFIED', () => {
    expect(classifyDifference({ lower: -0.09, upper: 0.09 }, BOUND)).toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
    expect(classifyDifference({ lower: 0, upper: 0.05 }, BOUND)).toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
    expect(classifyDifference({ lower: -0.05, upper: 0 }, BOUND)).toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
  });

  it('有界：触界（lower==−δ 或 upper==δ）→ INSUFFICIENT_EVIDENCE（边界严格、fail-closed）', () => {
    expect(classifyDifference({ lower: -0.1, upper: 0.09 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.09, upper: 0.1 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.1, upper: 0.1 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('有界：跨界 → INSUFFICIENT_EVIDENCE（上侧/下侧都算）', () => {
    expect(classifyDifference({ lower: -0.05, upper: 0.15 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.15, upper: 0.05 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('有界：方向同样以 δ 为准（lower>δ → IMPROVED；upper<−δ → REGRESSED；触界不算）', () => {
    expect(classifyDifference({ lower: 0.1, upper: 0.3 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: 0.100000001, upper: 0.3 }, BOUND)).toBe('IMPROVED');
    expect(classifyDifference({ lower: -0.3, upper: -0.1 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyDifference({ lower: -0.3, upper: -0.100000001 }, BOUND)).toBe('REGRESSED');
    // 方向明确但幅度不足以越过界：不得据此宣称「实质改善」，也不得宣称「无实质变化」
    expect(classifyDifference({ lower: 0.05, upper: 0.3 }, BOUND)).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('非法界（≤0 / ≥1 / NaN / ±∞ / 非数）fail-closed 抛错', () => {
    for (const bad of [0, -0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => classifyDifference({ lower: -0.05, upper: 0.05 }, bad)).toThrow();
    }
    expect(() => classifyDifference({ lower: -0.05, upper: 0.05 }, '0.1' as unknown as number)).toThrow();
  });

  it('非法区间（lower>upper / 非有限数）fail-closed 抛错', () => {
    expect(() => classifyDifference({ lower: 0.2, upper: 0.1 })).toThrow();
    expect(() => classifyDifference({ lower: Number.NaN, upper: 0.1 })).toThrow();
  });
});

describe('classifyV2（四态：IMPROVED / REGRESSED / INSUFFICIENT_EVIDENCE / NO_SUBSTANTIAL_CHANGE_VERIFIED）', () => {
  it('无界：方向明确 → IMPROVED/REGRESSED；重叠 → INSUFFICIENT_EVIDENCE（附 Δ 与差异区间）', () => {
    const improved = classifyV2({ k: 1, n: 9 }, { k: 8, n: 9 });
    expect(improved.state).toBe('IMPROVED');
    expect(improved.bound).toBeNull();
    expect(improved.delta).toBeCloseTo(7 / 9, 10);
    expect(improved.deltaCI.lower).toBeCloseTo(0.319720929, 8);
    expect(improved.deltaCI.upper).toBeCloseTo(0.906783385, 8);

    expect(classifyV2({ k: 8, n: 9 }, { k: 1, n: 9 }).state).toBe('REGRESSED');

    const overlap = classifyV2({ k: 7, n: 9 }, { k: 8, n: 9 });
    expect(overlap.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(overlap.deltaCI.lower).toBeLessThan(0);
    expect(overlap.deltaCI.upper).toBeGreaterThan(0);
  });

  it('有界且差异区间整体落在界内 → NO_SUBSTANTIAL_CHANGE_VERIFIED（同臂无界时为 INSUFFICIENT_EVIDENCE）', () => {
    const bounded = classifyV2({ k: 90, n: 100 }, { k: 91, n: 100 }, BOUND);
    expect(bounded.state).toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
    expect(bounded.bound).toBe(BOUND);
    expect(bounded.deltaCI.lower).toBeGreaterThan(-BOUND);
    expect(bounded.deltaCI.upper).toBeLessThan(BOUND);
    expect(classifyV2({ k: 90, n: 100 }, { k: 91, n: 100 }).state).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('有界：跨界 → INSUFFICIENT_EVIDENCE（48/80 vs 56/70，δ=0.2；上界被跨）', () => {
    const result = classifyV2({ k: 48, n: 80 }, { k: 56, n: 70 }, 0.2);
    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.deltaCI.lower).toBeGreaterThan(-0.2);
    expect(result.deltaCI.upper).toBeGreaterThan(0.2);
  });

  it('有界：界足够宽时可验证「无实质变化」（48/80 vs 56/70，δ=0.5）', () => {
    expect(classifyV2({ k: 48, n: 80 }, { k: 56, n: 70 }, 0.5).state).toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
  });

  it('有界：方向越过界 → IMPROVED/REGRESSED（50/100 vs 80/100，δ=0.1）', () => {
    expect(classifyV2({ k: 50, n: 100 }, { k: 80, n: 100 }, BOUND).state).toBe('IMPROVED');
    expect(classifyV2({ k: 80, n: 100 }, { k: 50, n: 100 }, BOUND).state).toBe('REGRESSED');
  });

  it('样本不足（任一臂 N<9，含 N=0）→ INSUFFICIENT_EVIDENCE（有界亦然）', () => {
    expect(classifyV2({ k: 1, n: 8 }, { k: 8, n: 8 }, 0.5).state).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyV2({ k: 8, n: 8 }, { k: 1, n: 8 }, 0.5).state).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyV2({ k: 0, n: 0 }, { k: 9, n: 9 }, 0.5).state).toBe('INSUFFICIENT_EVIDENCE');
    expect(classifyV2({ k: 3, n: 8 }, { k: 3, n: 8 }).state).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('非法界 fail-closed 抛错（classifyV2 面）', () => {
    for (const bad of [0, -0.1, 1, 1.2, Number.NaN]) {
      expect(() => classifyV2({ k: 1, n: 9 }, { k: 8, n: 9 }, bad)).toThrow();
    }
  });

  it('不变量扫描：无界时任何臂组合都不得产出 NO_SUBSTANTIAL_CHANGE_VERIFIED，且状态与区间自洽', () => {
    const arms: Array<{ k: number; n: number }> = [];
    for (const n of [0, 5, 9, 12, 15]) for (let k = 0; k <= n; k += 1) arms.push({ k, n });
    for (const a of arms) {
      for (const b of arms) {
        const result = classifyV2(a, b);
        expect(result.state).not.toBe('NO_SUBSTANTIAL_CHANGE_VERIFIED');
        expect(result.bound).toBeNull();
        if (a.n < 9 || b.n < 9) {
          expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
        } else if (result.state === 'IMPROVED') {
          expect(result.deltaCI.lower).toBeGreaterThan(0);
        } else if (result.state === 'REGRESSED') {
          expect(result.deltaCI.upper).toBeLessThan(0);
        } else {
          expect(result.deltaCI.lower).toBeLessThanOrEqual(0);
          expect(result.deltaCI.upper).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('v1 面保持（既有三态不因 S4 改变；v1↔v2 口径差异登记）', () => {
  it('同臂数据：v1 得 NO_MEANINGFUL_CHANGE，v2 无界得 INSUFFICIENT_EVIDENCE（不是「已证明无改善」）', () => {
    expect(classify({ k: 7, n: 9 }, { k: 8, n: 9 }).state).toBe('NO_MEANINGFUL_CHANGE');
    expect(classifyV2({ k: 7, n: 9 }, { k: 8, n: 9 }).state).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('v1 函数与状态字符串不变', () => {
    expect(classifyCIs({ lower: 0, upper: 0.3 }, { lower: 0.3000001, upper: 1 })).toBe('IMPROVED');
    expect(classify({ k: 1, n: 1 }, { k: 8, n: 9 }).state).toBe('INSUFFICIENT_SAMPLES');
    expect(classify({ k: 0, n: 0 }, { k: 0, n: 0 }).state).toBe('INSUFFICIENT_SAMPLES');
  });
});

describe('parseBound（CLI --bound 解析：0<δ<1，其余 fail-closed）', () => {
  it('合法输入解析为数字', () => {
    expect(parseBound('0.1')).toBe(0.1);
    expect(parseBound('0.05')).toBe(0.05);
    expect(parseBound(' 0.2 ')).toBe(0.2);
  });

  it('非法输入（空/非数/0/负/≥1/NaN/∞）抛错', () => {
    for (const bad of ['', ' ', 'abc', '0', '-0.1', '1', '1.5', 'NaN', 'Infinity', '0.1x']) {
      expect(() => parseBound(bad)).toThrow();
    }
  });
});

function makeRun(runDir: string, cases: ReadonlyArray<{ caseId: string; pass: number; total: number }>): RunSummary {
  const trials: TrialSummary[] = [];
  for (const row of cases) {
    for (let index = 1; index <= row.total; index += 1) {
      const passed = index <= row.pass;
      trials.push({
        caseId: row.caseId,
        trial: index,
        verdict: passed ? 'PASS' : 'FAIL',
        failureCodes: passed ? [] : ['FAIL_DUMMY'],
        weakNotices: [],
        assistedAvailable: false,
        dir: `${runDir}/runs/${row.caseId}/trial-${index}`,
        relDir: `runs/${row.caseId}/trial-${index}`,
      });
    }
  }
  return { runDir, manifest: null, trials };
}

function rowOf(text: string, caseId: string): string {
  const row = text.split('\n').find((line) => line.startsWith(`| ${caseId} `));
  if (row === undefined) throw new Error(`未找到用例行：${caseId}`);
  return row;
}

describe('renderCompare：口径版本标注（缺省 v1 三态；提供 --bound 时 v2 四态）', () => {
  const runA = makeRun('run-a', [
    { caseId: 'c-overlap', pass: 7, total: 9 },
    { caseId: 'c-improved', pass: 1, total: 9 },
    { caseId: 'c-small', pass: 3, total: 8 },
  ]);
  const runB = makeRun('run-b', [
    { caseId: 'c-overlap', pass: 8, total: 9 },
    { caseId: 'c-improved', pass: 8, total: 9 },
    { caseId: 'c-small', pass: 3, total: 8 },
  ]);

  it('缺省（未提供界）：v1 三态输出 + 口径版本标注；不出现四态结论', () => {
    const text = renderCompare(runA, runB);
    expect(text).toContain('口径版本：v1');
    expect(text).toContain('| 用例 | A k/N（Wilson 95% CI） | B k/N（Wilson 95% CI） | Δ（pp） | 三态 |');
    expect(rowOf(text, 'c-overlap')).toContain('NO_MEANINGFUL_CHANGE');
    expect(rowOf(text, 'c-improved')).toContain('IMPROVED');
    expect(rowOf(text, 'c-small')).toContain('INSUFFICIENT_SAMPLES');
    expect(text).toContain('NO_MEANINGFUL_CHANGE');
    expect(text).not.toContain('NO_SUBSTANTIAL_CHANGE_VERIFIED');
  });

  it('提供界：v2 四态输出 + δ 与差异区间方法标注；不出现 v1 状态字符串', () => {
    const text = renderCompare(runA, runB, { bound: BOUND });
    expect(text).toContain('口径版本：v2');
    expect(text).toContain('δ=0.1');
    expect(text).toContain('Newcombe');
    expect(rowOf(text, 'c-overlap')).toContain('INSUFFICIENT_EVIDENCE');
    expect(rowOf(text, 'c-improved')).toContain('IMPROVED');
    expect(rowOf(text, 'c-improved')).not.toContain('REGRESSED');
    expect(rowOf(text, 'c-small')).toContain('INSUFFICIENT_EVIDENCE');
    expect(text).not.toContain('NO_MEANINGFUL_CHANGE');
    expect(text).not.toContain('INSUFFICIENT_SAMPLES');
  });

  it('提供界且区间落在界内：输出 NO_SUBSTANTIAL_CHANGE_VERIFIED（90/100 vs 91/100）', () => {
    const runC = makeRun('run-c', [{ caseId: 'c-equiv', pass: 90, total: 100 }]);
    const runD = makeRun('run-d', [{ caseId: 'c-equiv', pass: 91, total: 100 }]);
    const text = renderCompare(runC, runD, { bound: BOUND });
    expect(rowOf(text, 'c-equiv')).toContain('NO_SUBSTANTIAL_CHANGE_VERIFIED');
  });

  it('非法界 fail-closed：renderCompare 抛错（无样本亦然）', () => {
    expect(() => renderCompare(runA, runB, { bound: 1 })).toThrow();
    expect(() => renderCompare(runA, runB, { bound: Number.NaN })).toThrow();
    const empty = makeRun('run-empty', []);
    expect(() => renderCompare(empty, empty, { bound: 0 })).toThrow();
  });
});

describe('CLI compare --bound 端到端（缺省 v1 / 有界 v2 / 非法界退出码 2）', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const script = path.join(repoRoot, 'scripts/eval/exploration/stats.ts');

  function writeCliRun(dir: string, caseId: string, pass: number, total: number): void {
    for (let index = 1; index <= total; index += 1) {
      const trialDir = path.join(dir, 'runs', caseId, `trial-${index}`);
      mkdirSync(trialDir, { recursive: true });
      const passed = index <= pass;
      writeFileSync(
        path.join(trialDir, 'judgment.json'),
        JSON.stringify({ deterministic: { verdict: passed ? 'PASS' : 'FAIL', failureCodes: passed ? [] : ['FAIL_DUMMY'] } }),
      );
    }
  }

  it('--bound 0.5（9/9 vs 9/9）：v2 口径 + NO_SUBSTANTIAL_CHANGE_VERIFIED', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stats-s4-cli-'));
    try {
      const dirA = path.join(root, 'a');
      const dirB = path.join(root, 'b');
      writeCliRun(dirA, 'cli-case', 9, 9);
      writeCliRun(dirB, 'cli-case', 9, 9);
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', script, 'compare', '--a', dirA, '--b', dirB, '--bound', '0.5'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(stdout).toContain('口径版本：v2');
      expect(stdout).toContain('δ=0.5');
      expect(stdout).toContain('NO_SUBSTANTIAL_CHANGE_VERIFIED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺省无 --bound：v1 口径 + NO_MEANINGFUL_CHANGE（不出现四态结论）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stats-s4-cli-'));
    try {
      const dirA = path.join(root, 'a');
      const dirB = path.join(root, 'b');
      writeCliRun(dirA, 'cli-case', 9, 9);
      writeCliRun(dirB, 'cli-case', 9, 9);
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', script, 'compare', '--a', dirA, '--b', dirB],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(stdout).toContain('口径版本：v1');
      expect(stdout).toContain('NO_MEANINGFUL_CHANGE');
      expect(stdout).not.toContain('NO_SUBSTANTIAL_CHANGE_VERIFIED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法 --bound（1）：fail-closed，退出码 2、无对比正文输出', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stats-s4-cli-'));
    try {
      const dirA = path.join(root, 'a');
      const dirB = path.join(root, 'b');
      writeCliRun(dirA, 'cli-case', 9, 9);
      writeCliRun(dirB, 'cli-case', 9, 9);
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', script, 'compare', '--a', dirA, '--b', dirB, '--bound', '1'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('stats 运行失败');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
