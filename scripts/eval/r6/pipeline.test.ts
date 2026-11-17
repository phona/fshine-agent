/**
 * R6 测试基建 · 端到端确定性自证（假会话，零模型）。
 *
 * 把负载计划跑过假会话 → Oracle → 证据 → 三态处置，断言：
 *   · 事实全对 → 会话事实通过；数字漂移被判负（T1 可确定性部分）；
 *   · 任务硬零（H3）→ product_fault 且保留（不作废）；
 *   · 有效压缩不足 → insufficient_coverage；环境信号 → environment_interrupted；
 *   · 压缩生命周期机械事实（≥3 有效压缩 → 覆盖充分，无硬零）。
 * 这是**测试基建自证**，不是产品质量结论（质量结论只由真实模型产生）。
 */
import { describe, it, expect } from 'vitest';
import { runHarnessSession } from './harness';
import { buildTrackPlan, type TrackPlan } from './load-generator';
import { FakeHarnessSession, noTasks, asAttempt, type FakeScenario } from './fake-session';

const LS1 = buildTrackPlan('LS1');

/** LS1 假脚本：事实全对 + 3 次有效压缩（在后段）。 */
function ls1Script(overrides: Partial<Record<number, string>> = {}): FakeScenario {
  const replies: Record<number, string> = {
    1: '', 2: '', 3: '',
    4: 'alpha 集合 W1 共 2 条，总金额 2000 元。',
    5: 'beta 集合 W1 共 3 条，总金额 1000 元；alpha 比 beta 多 1000。',
    6: 'documents W202610 第二条金额是 800 元。',
    7: '按查询结果：alpha 总额是 2000 元。',
    8: '那个结论已经作废，我不会再继续按旧结论回答。',
    9: '那个汇总任务还未完成。',
    10: '记住了：金额不四舍五入。alpha 总额 2000 元。',
    11: 'W9999 窗口没有查询过，无法确认总额。',
    ...overrides,
  };
  const attempts: Record<number, ReturnType<typeof asAttempt>[]> = {
    9: [asAttempt(9, 'threshold', 111000, 20000)],
    10: [asAttempt(10, 'threshold', 110000, 19000)],
    11: [asAttempt(11, 'threshold', 112000, 21000, 4)],
  };
  return {
    summaryCalls: 3,
    turns: Array.from({ length: 11 }, (_, i) => {
      const turn = i + 1;
      return { reply: replies[turn]!, tasks: noTasks(), tokens: 1000 * turn, messages: turn * 2, modelCalls: 1, ...(attempts[turn] ? { newAttempts: attempts[turn] } : {}) };
    }),
  };
}

function run(plan: TrackPlan, scenario: FakeScenario, extra: { infraSignals?: string[] } = {}) {
  const session = new FakeHarnessSession(scenario);
  return runHarnessSession({
    session, plan, wave: 'Wave1', track: plan.track, sessionId: 's1', principalId: 'principal-A',
    model: 'step-3.7-flash', contextWindow: 128000, limits: { maxModelCalls: 150 },
    ...(extra.infraSignals ? { infraSignals: extra.infraSignals } : {}),
  });
}

describe('端到端管线（假会话）', () => {
  it('事实全对 + 3 次有效压缩 → valid，无硬零，覆盖充分', async () => {
    const r = await run(LS1, ls1Script());
    expect(r.judgement.sessionFactsPass).toBe(true);
    expect(r.judgement.compactionVerdict.coverageSufficient).toBe(true);
    expect(r.judgement.taskVerdict.hardZeroHits).toEqual([]);
    expect(r.judgement.compactionVerdict.hardZeroHits).toEqual([]);
    expect(r.disposition).toBe('valid');
    expect(r.summary['effectiveCompactions']).toBe(3);
  });

  it('事实数字漂移 → 会话事实不通过（T1 可确定性部分）', async () => {
    const r = await run(LS1, ls1Script({ 5: 'beta 集合 W1 共 2 条，总金额 800 元。' }));
    expect(r.judgement.sessionFactsPass).toBe(false);
    expect(r.judgement.factFailures).toContain('E-A');
  });

  it('任务硬零 H3 → product_fault 且保留（不作废）', async () => {
    const plan: TrackPlan = { track: 'LS2', turns: [{ index: 1, text: '开任务', kind: 'task' }, { index: 2, text: '再查', kind: 'task' }] };
    const t1 = [{ taskId: 't1', taskNo: 1, request: 'x', status: 'running', requestIds: ['req-A'] }];
    const t2 = [{ taskId: 't2', taskNo: 2, request: 'y', status: 'running', requestIds: ['req-A'] }];
    const scenario: FakeScenario = {
      turns: [
        { reply: '已开任务。', tasks: t1, tokens: 1000, messages: 2, newAttempts: [asAttempt(1, 'threshold', 110000, 20000)] },
        { reply: '又派发了一次（同 requestId）。', tasks: t2, tokens: 2000, messages: 4, newAttempts: [asAttempt(2, 'threshold', 110000, 20000)] },
      ],
    };
    const r = await run(plan, scenario);
    expect(r.judgement.taskVerdict.hardZeroHits).toContain('H3');
    expect(r.disposition).toBe('product_fault');
    // 产品故障样本必须保留：证据仍然完整落盘（turns/replies 非空）
    expect(r.evidence.turns).toHaveLength(2);
  });

  it('有效压缩不足 → insufficient_coverage', async () => {
    const scenario = ls1Script();
    scenario.turns.forEach((t) => { delete (t as { newAttempts?: unknown }).newAttempts; });
    const r = await run(LS1, scenario);
    expect(r.judgement.compactionVerdict.coverageSufficient).toBe(false);
    expect(r.disposition).toBe('insufficient_coverage');
  });

  it('环境信号 → environment_interrupted（不判产品负）', async () => {
    const r = await run(LS1, ls1Script(), { infraSignals: ['ECONNRESET'] });
    expect(r.disposition).toBe('environment_interrupted');
    expect(r.judgement.taskVerdict.hardZeroHits).toEqual([]);
  });

  it('结构泄漏读数：命中只增读数，不改 disposition', async () => {
    const taskId = 'task_e6296844-5e6a-4ed2-95c4-d0b24efc00c0';
    const reqId = 'req_c6c800b7-17fe-4760-80c5-b98460164d25';
    const clean = await run(LS1, ls1Script());
    const leaky = await run(LS1, ls1Script({ 1: `{"taskId":"${taskId}","status":"completed","requestIds":["${reqId}"]}` }));

    // 同一计划/同一 Oracle 面：disposition 与硬零不受该读数影响。
    expect(clean.disposition).toBe('valid');
    expect(leaky.disposition).toBe(clean.disposition);
    expect(leaky.judgement.taskVerdict.hardZeroHits).toEqual(clean.judgement.taskVerdict.hardZeroHits);

    const cleanField = clean.summary['structureLeak'] as Record<string, unknown>;
    const leakyField = leaky.summary['structureLeak'] as Record<string, unknown>;
    expect(cleanField['totalHits']).toBe(0);
    expect(Number(leakyField['totalHits'])).toBeGreaterThan(0);
    expect(leakyField['affectsDisposition']).toBe(false);
    expect(leaky.structureLeak.hitTurns).toBe(1);
  });
});
