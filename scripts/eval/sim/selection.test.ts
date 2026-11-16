import { describe, expect, it } from 'vitest';
import { SIM_READ_CASES } from './cases';
import { assertSampleCap, SAMPLE_HARD_CAP, selectSimCases } from './selection';
import type { SimCase } from './case';

function withTrials(caseDef: SimCase, trials: number): SimCase {
  return { ...caseDef, limits: { ...caseDef.limits, trials } };
}

describe('跑批选样（SIM_CASES_ONLY + 样本硬停）', () => {
  it('未设/空串 = 全部读用例（不是空集）', () => {
    expect(selectSimCases(SIM_READ_CASES, undefined).map((c) => c.id)).toEqual(SIM_READ_CASES.map((c) => c.id));
    expect(selectSimCases(SIM_READ_CASES, '   ').map((c) => c.id)).toEqual(SIM_READ_CASES.map((c) => c.id));
  });

  it('按给定顺序选子集，去空白', () => {
    expect(selectSimCases(SIM_READ_CASES, 'SIM-08, SIM-01').map((c) => c.id)).toEqual(['SIM-08', 'SIM-01']);
  });

  it('未知 id / 写场景 id 一律拒绝（不静默少跑）', () => {
    expect(() => selectSimCases(SIM_READ_CASES, 'SIM-01,NOPE')).toThrow(/NOPE/);
    expect(() => selectSimCases(SIM_READ_CASES, 'SIM-09')).toThrow(/SIM-09/);
    expect(() => selectSimCases(SIM_READ_CASES, ',')).toThrow(/为空/);
  });

  it('样本数 = Σ trials；超过硬停抛错，等于硬停放行', () => {
    const four = ['SIM-05', 'SIM-01', 'SIM-02', 'SIM-08'].map((id) => SIM_READ_CASES.find((c) => c.id === id)!);
    expect(assertSampleCap(four)).toBe(12);
    const over = [withTrials(four[0]!, 4), ...four.slice(1)];
    expect(() => assertSampleCap(over)).toThrow(/硬停 12/);
    // 自定义上限只用来验证算术：上限 11 < 12 必须拒绝，不放行。
    expect(() => assertSampleCap(four, 11)).toThrow(/硬停 11/);
  });

  it('硬停常数为预注册冻结值 12', () => {
    expect(SAMPLE_HARD_CAP).toBe(12);
  });
});
