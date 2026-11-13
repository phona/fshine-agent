/**
 * stats.ts 单元测试（TDD：先红后绿）。
 *
 * 期望值为按标准 Wilson score 区间公式（z=1.96）**独立计算后写死**的参考值
 * （不调用 wilson95 自己生成期望，避免自证）。
 * 运行：npx vitest run --project unit scripts/eval/exploration/stats.test.ts
 *
 * 反向绊线（文档化，实施时逐个演示）：把 Z95 改成 1.0、把严格 > 改成 >=、
 * 把 IMPROVED/NO_MEANINGFUL_CHANGE 判定反转——本文件必须转红。
 */
import { describe, expect, it } from 'vitest';
import { classify, classifyCIs, failureHistogram, wilson95 } from './stats';

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
