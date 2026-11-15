/**
 * R6 测试基建 · 确定性自证：负载生成器（语料规划 + 上下文推进器）。
 */
import { describe, it, expect } from 'vitest';
import { buildTrackPlan, buildPumpTurns, factTurns, type Track } from './load-generator';

describe('负载生成器', () => {
  it('五轨均可构建且索引连续从 1 起', () => {
    for (const track of ['LS1', 'LS2', 'LS3', 'LS4', 'LS5'] as Track[]) {
      const plan = buildTrackPlan(track);
      expect(plan.track).toBe(track);
      expect(plan.turns.length).toBeGreaterThan(0);
      plan.turns.forEach((t, i) => expect(t.index).toBe(i + 1));
    }
  });

  it('LS1 含 8 个事实轮（F1–F8 覆盖）', () => {
    expect(factTurns(buildTrackPlan('LS1'))).toHaveLength(8);
  });

  it('LS2 的任务轮携带期望状态', () => {
    const taskTurns = buildTrackPlan('LS2').turns.filter((t) => t.kind === 'task');
    expect(taskTurns.length).toBeGreaterThanOrEqual(6);
    expect(taskTurns.some((t) => t.expectTaskStatus === 'failed')).toBe(true);
  });

  it('LS3 覆盖 NL1–NL10 标签', () => {
    const labels = buildTrackPlan('LS3').turns.filter((t) => t.kind === 'interaction').map((t) => t.label);
    for (let i = 1; i <= 10; i += 1) expect(labels).toContain(`NL${i}`);
  });

  it('上下文推进器确定性且只追加新内容轮', () => {
    const a = buildPumpTurns(100, 4);
    const b = buildPumpTurns(100, 4);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    expect(a.every((t) => t.kind === 'pump')).toBe(true);
    expect(a[0]!.index).toBe(100);
    // 不读阈值、不做压缩判断：结构里没有任何阈值字段
    expect(Object.keys(a[0]!)).toEqual(expect.arrayContaining(['index', 'kind', 'text']));
  });
});
