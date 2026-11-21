/**
 * R6 测试基建 · 确定性自证：负载生成器（语料规划 + 上下文推进器）。
 */
import { describe, it, expect } from 'vitest';
import { buildTrackPlan, buildPumpTurns, factTurns, type Track, type TurnSpec } from './load-generator';

/** 一轮是否带**任何**机械期望（含事实 / 任务 / 执行 / 文本 / 空档）。 */
function hasExpectation(turn: TurnSpec): boolean {
  return turn.fact !== undefined
    || turn.expectNoNewTask === true
    || turn.expectNewTask === true
    || turn.expectNoExecution === true
    || (turn.expectExecutionObjects?.length ?? 0) > 0
    || turn.expectPrevTasksUnchanged === true
    || turn.expectTaskStatusIn !== undefined
    || (turn.replyExcludes?.length ?? 0) > 0
    || turn.expectCancelHonest === true
    || turn.expectInflightCancel === true;
}

describe('负载生成器', () => {
  it('六轨均可构建且索引连续从 1 起', () => {
    for (const track of ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6'] as Track[]) {
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

  it('LS3 覆盖 NL1–NL10 标签，且 NL2/NL3/NL4/NL5/NL7/NL9/NL10 有机械期望、NL8 不得新建任务', () => {
    const turns = buildTrackPlan('LS3').turns.filter((t) => t.kind === 'interaction');
    const labels = turns.map((t) => t.label);
    for (let i = 1; i <= 10; i += 1) expect(labels).toContain(`NL${i}`);
    const byLabel = new Map(turns.map((t) => [t.label, t]));
    for (const label of ['NL2', 'NL3', 'NL4', 'NL5', 'NL7', 'NL9', 'NL10']) {
      expect(byLabel.get(label)?.fact ?? byLabel.get(label)?.expectTaskStatusIn).toBeDefined();
    }
    expect(byLabel.get('NL8')?.expectNoNewTask).toBe(true);
    // 事实期望的取值来自 FACT_TRUTH（alpha 2/2000、beta 3/1000、documents 第二条 800）。
    expect(byLabel.get('NL2')?.fact).toMatchObject({ kind: 'exact', collection: 'beta', count: 3, sum: 1000 });
    expect(byLabel.get('NL3')?.fact).toMatchObject({ kind: 'exact', collection: 'alpha', sum: 2000 });
    expect(byLabel.get('NL7')?.fact).toMatchObject({ kind: 'exact', collection: 'documents', value: 800 });
  });

  it('LS6 形状：13 轮 / N1–N6 场景齐备 / 每轮都有机械期望', () => {
    const plan = buildTrackPlan('LS6');
    expect(plan.turns).toHaveLength(13);
    const labels = plan.turns.map((t) => t.label ?? '');
    expect(labels).toEqual(['N1-A', 'N1-B', 'N1-C', 'N2-A', 'N2-B', 'N3-A', 'N3-B', 'N4', 'N5-A', 'N5-B', 'N6-Q1', 'N6-Q2', 'N6-C']);
    // 首轮是 establish（会话标记注入点），其余是自然交互轮。
    expect(plan.turns[0]!.kind).toBe('establish');
    expect(plan.turns.slice(1).every((t) => t.kind === 'interaction')).toBe(true);
    for (const turn of plan.turns) {
      expect(hasExpectation(turn), `第 ${turn.index} 轮（${turn.label}）缺机械期望`).toBe(true);
    }
  });

  it('LS6 关键判据落在对应场景轮上', () => {
    const byLabel = new Map(buildTrackPlan('LS6').turns.map((t) => [t.label, t]));
    // N1 真交错：两轮各建一个任务；回头问 A 时不得新建任务且 A 已完成、事实为 alpha。
    expect(byLabel.get('N1-A')?.expectNewTask).toBe(true);
    expect(byLabel.get('N1-B')?.expectNewTask).toBe(true);
    expect(byLabel.get('N1-C')?.expectNoNewTask).toBe(true);
    expect(byLabel.get('N1-C')?.expectTaskStatusIn).toEqual({ which: 'oldest', values: ['completed'] });
    expect(byLabel.get('N1-C')?.fact).toMatchObject({ collection: 'alpha', count: 2, sum: 2000 });
    // N2 改口径：落到 beta 执行行；回头只报 beta、不再报 alpha 数值。
    expect(byLabel.get('N2-A')?.expectExecutionObjects).toEqual(['beta']);
    expect(byLabel.get('N2-B')?.expectNoExecution).toBe(true);
    // 2026-11-18：N2-B 不再用裸数字排除（会把正确归属的 alpha 2000 判负）；beta 合计由 fact 判据保证。
    expect(byLabel.get('N2-B')?.replyExcludes).toBeUndefined();
    expect(byLabel.get('N5-B')?.replyExcludesScope).toBe('alpha');
    // N3 真间隔：1500ms 空档 + 状态保持 + 不重复执行。
    expect(byLabel.get('N3-B')?.gapMs).toBe(1500);
    expect(byLabel.get('N3-B')?.expectPrevTasksUnchanged).toBe(true);
    expect(byLabel.get('N3-B')?.expectNoExecution).toBe(true);
    // N4 反悔重做：新建任务且旧任务不被改写。
    expect(byLabel.get('N4')?.expectNewTask).toBe(true);
    expect(byLabel.get('N4')?.expectPrevTasksUnchanged).toBe(true);
    // N5 自我更正：2 条 / 2000，且不得沿用 3 条。
    expect(byLabel.get('N5-B')?.fact).toMatchObject({ count: 2, sum: 2000 });
    expect(byLabel.get('N5-B')?.replyExcludes).toEqual(expect.arrayContaining(['3条', '三条']));
    // N6 三档：在飞取消必须真落到 cancelled；已完成任务拒绝取消（状态不变）。
    expect(byLabel.get('N6-Q2')?.expectInflightCancel).toBe(true);
    expect(byLabel.get('N6-C')?.expectPrevTasksUnchanged).toBe(true);
    expect(byLabel.get('N6-C')?.expectTaskStatusIn).toEqual({ which: 'oldest', values: ['completed'] });
    // 取消诚实性必须查「最早那个」任务，不能被最新任务（另一个已 cancelled）空过。
    expect(byLabel.get('N6-C')?.expectCancelHonest).toBe(true);
    expect(byLabel.get('N6-C')?.cancelTarget).toBe('oldest');
  });

  it('gapMs 只出现在 LS6 的 N3-B 一轮', () => {
    const gapped = ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6']
      .flatMap((track) => buildTrackPlan(track as Track).turns.map((turn) => ({ track, turn })))
      .filter((entry) => entry.turn.gapMs !== undefined);
    expect(gapped.map((entry) => [entry.track, entry.turn.label, entry.turn.gapMs])).toEqual([['LS6', 'N3-B', 1500]]);
  });

  it('deferIdle 只落在 LS6 的真交错/在飞取消轮；settleBeforeJudge 只随 N6-Q2', () => {
    const deferred = ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6']
      .flatMap((track) => buildTrackPlan(track as Track).turns.map((turn) => ({ track, turn })))
      .filter((entry) => entry.turn.deferIdle === true);
    expect(deferred.map((entry) => [entry.track, entry.turn.label])).toEqual([
      ['LS6', 'N1-A'], ['LS6', 'N1-B'], ['LS6', 'N6-Q1'], ['LS6', 'N6-Q2'],
    ]);
    const settling = deferred.filter((entry) => entry.turn.settleBeforeJudge === true);
    expect(settling.map((entry) => entry.turn.label)).toEqual(['N6-Q2']);
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
