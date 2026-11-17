/**
 * 公式级 Eval 的确定性守卫：before/after 两臂读数符合准入五条第 5 项的判据。
 *
 * 真实 soffice 读数由 `node --import tsx scripts/eval/recalc/formula-level.ts` 产出并落证据；
 * 本测试用同口径断言两臂的可复现判定面（引擎来源可真可假，判据相同）：
 *   · 增加前（数据级）：陈旧缓存被当作真值 → pass / 投递；
 *   · 增加后（公式级）：重算读回 → 缓存≠计算值 → fail / 不投递。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runFormulaLevelEval,
  type FormulaLevelReading,
} from './formula-level';

describe('recalc 公式级 Eval：增加前/增加后读数', () => {
  it('两臂读数：before 静默通过（陈旧缓存不可见）；after 检出 valueDiffs 并不投递', async () => {
    const { readings, pass } = await runFormulaLevelEval();
    const before = readings.find((r) => r.arm === 'before_data_level');
    const after = readings.find((r) => r.arm === 'after_formula_level');
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(before!.delivered).toBe(true); // 增加前：陈旧 999 被当真值，pass
    expect(before!.cached).toBe(999);
    expect(after!.delivered).toBe(false); // 增加后：检出差异，fail，不投递
    expect(after!.computed).toBe(5); // 真实计算值
    expect(pass).toBe(true);
  });

  it('两臂的 delivered/reason 都真走闸门（Codex P2-6）：before disabled、after enabled，非硬编码', async () => {
    const src = readFileSync(path.join(__dirname, 'formula-level.ts'), 'utf8');
    // 两臂都必须调用闸门应用函数；delivered 从闸门结果（outgoing/gated）取，不得硬编码布尔。
    expect(src).toContain('applyRecalcDeliveryGate');
    expect(src).toMatch(/before[\s\S]{0,400}enabled:\s*false/);   // before 走 disabled 闸（allow-all = 机制前）
    expect(src).toMatch(/after[\s\S]{0,600}enabled:\s*true/);     // after 走 enabled 闸
    // 不允许把 delivered 写成硬编码 true/false。
    expect(src).not.toMatch(/delivered:\s*true\s*,/);
    expect(src).not.toMatch(/delivered:\s*result\.status/);

    // 行为面：reason 必须是闸门给出的判定理由。
    const { readings, pass } = await runFormulaLevelEval();
    const before = readings.find((r) => r.arm === 'before_data_level')!;
    const after = readings.find((r) => r.arm === 'after_formula_level')!;
    expect(before.delivered).toBe(true);   // disabled 闸：放行
    expect(after.delivered).toBe(false);   // enabled 闸 + fail 报告：拦下
    expect(after.reason).toBe('report_fail'); // 闸门判定理由，非 executor status
    expect(pass).toBe(true);
  });
});
