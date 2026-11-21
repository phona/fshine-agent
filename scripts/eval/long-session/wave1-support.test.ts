/**
 * R6 Wave1 移植层的最小确定性用例（零模型）。
 *
 * 钉住三件事：
 *   1. 参数解析（--track/--concurrency/--smoke/--model）；
 *   2. 主线 harness 没有 nextTurn 时，`withPumpedTurns` 的「活计划追加」真的会被
 *      `runHarnessSession` 消费（且不会在初始建立轮中间插入推进轮）；
 *   3. 主线结构泄漏读数能进入批汇总（`structureLeakBatch`）——去掉聚合即红。
 */
import { describe, expect, it } from 'vitest';
import { runHarnessSession, type HarnessSession } from './harness';
import { FakeHarnessSession, asAttempt, noTasks, type FakeScenario, type FakeTurnScript } from './fake-session';
import { scanStructureLeak } from './structure-leak';
import {
  createWave1PumpDecider, parseWave1Args, scriptFor, sessionMarker, structureLeakBatch, withPumpedTurns,
} from './wave1-support';

const TASK_ID = 'task_e6296844-5e6a-4ed2-95c4-d0b24efc00c0';
const REQ_ID = 'req_c6c800b7-17fe-4760-80c5-b98460164d25';

const LEAKY_REPLY = `{"taskId":"${TASK_ID}","taskNo":16,"requestIds":["${REQ_ID}"]}`;
const CLEAN_REPLY = 'alpha 集合 W1 共 2 条，总金额 2000 元。';

function scripted(turns: readonly (Partial<FakeTurnScript> & { reply: string })[]): FakeScenario {
  return {
    turns: turns.map((turn) => ({
      tasks: noTasks(), tokens: 1000, messages: 2, ...turn,
    })),
  };
}

describe('Wave1 参数解析', () => {
  it('缺省：六轨 / 并发 1（step 安全缺省）/ 非冒烟 / 128k / step 模型', () => {
    const args = parseWave1Args([]);
    expect(args.tracks).toEqual(['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6']);
    expect(args.concurrency).toBe(1);
    expect(args.smoke).toBe(false);
    expect(args.smokeWindow).toBe(128000);
    expect(args.model).toBe('step-3.7-flash');
  });

  it('--track=LS6 可单独选中（与其它轨同形）', () => {
    expect(parseWave1Args(['--track=LS6']).tracks).toEqual(['LS6']);
  });

  it('解析冒烟形状与模型覆盖', () => {
    const args = parseWave1Args(['--smoke', '--smoke-window=40000', '--concurrency=1', '--track=ls4', '--model=other-model']);
    expect(args.smoke).toBe(true);
    expect(args.smokeWindow).toBe(40000);
    expect(args.concurrency).toBe(1);
    expect(args.tracks).toEqual(['LS4']);
    expect(args.model).toBe('other-model');
  });

  it('无效轨道 / 空模型值直接拒绝', () => {
    expect(() => parseWave1Args(['--track=XX'])).toThrow(/--track 无效/);
    expect(() => parseWave1Args(['--model='])).toThrow(/--model 需要值/);
    expect(() => parseWave1Args(['--concurrency=0'])).toThrow(/--concurrency 需要正整数/);
    expect(() => parseWave1Args(['--smoke-window=abc'])).toThrow(/--smoke-window 需要正整数/);
  });
});

describe('LS6 脚本装配（时间线轨，不是「建立轮 + 压缩后探针」）', () => {
  const LABELS = ['N1-A', 'N1-B', 'N1-C', 'N2-A', 'N2-B', 'N3-A', 'N3-B', 'N4', 'N5-A', 'N5-B', 'N6-Q1', 'N6-Q2', 'N6-C'];

  it('plan 是完整 13 轮时间线：首轮带会话标记、全部期望字段随轮保留', () => {
    const script = scriptFor('LS6', 'sess-ls6');
    expect(script.plan.turns).toHaveLength(13);
    expect(script.plan.turns.map((t) => t.label)).toEqual(LABELS);
    expect(script.plan.turns[0]!.text.startsWith(sessionMarker('sess-ls6'))).toBe(true);
    expect(script.plan.turns.filter((t) => t.fact !== undefined)).toHaveLength(3);
    expect(script.plan.turns.find((t) => t.label === 'N3-B')?.gapMs).toBe(1500);
    expect(script.plan.turns.find((t) => t.label === 'N2-A')?.expectExecutionObjects).toEqual(['beta']);
  });

  it('压缩后复查轮取 N2-B / N4 / N5-B（index 由推进器重排，期望不变）', () => {
    const script = scriptFor('LS6', 'sess-ls6');
    expect(script.probeTurns.map((t) => t.label)).toEqual(['N2-B', 'N4', 'N5-B']);
    expect(script.probeTurns.every((t) => t.index === 0)).toBe(true);
    // LS6 是交互轨：压缩覆盖不在这里判，推进轮保持 0。
    expect(script.steadyPumps).toBe(0);
  });
});

describe('主线 harness 适配 · 活计划追加', () => {
  it('初始计划跑完后按决策追加推进轮，且追加项被 harness 消费', async () => {
    const session = new FakeHarnessSession(scripted([
      { reply: '建立 1' },
      { reply: '建立 2' },
      { reply: '推进 1', newAttempts: [asAttempt(3, 'threshold', 39000, 20000)] },
      { reply: '推进 2', newAttempts: [asAttempt(4, 'threshold', 39000, 20000)] },
    ]));
    const progress: { completedTurns: number; effectiveCompactions: number }[] = [];
    const pumped = withPumpedTurns(session, {
      track: 'LS4',
      turns: [
        { index: 1, text: '建立 1', kind: 'establish' },
        { index: 2, text: '建立 2', kind: 'establish' },
      ],
      nextTurn: (p) => {
        progress.push(p);
        if (p.completedTurns >= 4) return null;
        return { index: p.completedTurns + 1, text: `推进 ${p.completedTurns - 1}`, kind: 'pump' };
      },
    });

    const result = await runHarnessSession({
      session: pumped.session,
      plan: pumped.plan,
      wave: 'Wave1',
      track: 'LS4',
      sessionId: 's-pumped',
      principalId: 'principal-A',
      model: 'step-3.7-flash',
      contextWindow: 40000,
      limits: { maxModelCalls: 150 },
    });

    // 回调只在初始计划（2 轮）跑完后才开始；追加的 2 轮被主线 harness 实际 send。
    expect(progress.map((p) => p.completedTurns)).toEqual([2, 3, 4]);
    expect(result.evidence.turns.map((t) => t.text)).toEqual(['建立 1', '建立 2', '推进 1', '推进 2']);
    expect(result.judgement.compactionVerdict.facts['effectiveCompactions']).toBe(2);
  });
});

describe('Wave1 推进决策', () => {
  const probe = { index: 0, text: '压缩后复查', kind: 'probe' as const };

  it('压缩不足 → 先推进到上限；达标 → 发复查轮；然后结束', () => {
    const decide = createWave1PumpDecider({ probeTurns: [probe], steadyPumps: 0, pumpCap: 2, smoke: false });
    const first = decide({ completedTurns: 3, effectiveCompactions: 0 });
    expect(first).toMatchObject({ index: 4, kind: 'pump' });
    expect(first?.text).toContain('bulk-a');
    const second = decide({ completedTurns: 4, effectiveCompactions: 0 });
    expect(second).toMatchObject({ index: 5, kind: 'pump' });
    // 推进轮交替：奇数次开新任务查询，偶数次取回完整结果。
    expect(second?.text).toContain('前 20 条');
    const afterCap = decide({ completedTurns: 5, effectiveCompactions: 0 });
    expect(afterCap).toMatchObject({ index: 6, kind: 'probe', text: '压缩后复查' });
    expect(decide({ completedTurns: 6, effectiveCompactions: 0 })).toBeNull();
  });

  it('已达标（≥3 有效压缩）→ 跳过推进轮直接复查', () => {
    const decide = createWave1PumpDecider({ probeTurns: [probe], steadyPumps: 0, pumpCap: 24, smoke: false });
    expect(decide({ completedTurns: 3, effectiveCompactions: 3 })).toMatchObject({ kind: 'probe' });
  });

  it('冒烟不跑复查轮（LS4 steadyPumps=0）：推进到上限即结束', () => {
    const decide = createWave1PumpDecider({ probeTurns: [probe], steadyPumps: 0, pumpCap: 1, smoke: true });
    expect(decide({ completedTurns: 3, effectiveCompactions: 0 })).toMatchObject({ kind: 'pump' });
    expect(decide({ completedTurns: 4, effectiveCompactions: 0 })).toBeNull();
  });
});

describe('主线 harness 适配 · 单回合调用计量', () => {
  /** 6 次真实调用（主会话只有 1 次，其余是 Worker/摘要等不计入被测回合的调用）。 */
  const sixCalls = Array.from({ length: 6 }, () => ({ kind: 'main' as const }));

  it('提供 mainModelCallsLastTurn 时 H6.b 只计主会话调用（不把 Worker 算进回合）', async () => {
    const base = new FakeHarnessSession(scripted([{ reply: '完成', calls: sixCalls }]));
    const session: HarnessSession = Object.assign(base, { mainModelCallsLastTurn: () => 1 });
    const result = await runHarnessSession({
      session,
      plan: { track: 'LS4', turns: [{ index: 1, text: '建立', kind: 'establish' }] },
      wave: 'Wave1',
      track: 'LS4',
      sessionId: 's-main-calls',
      principalId: 'principal-A',
      model: 'step-3.7-flash',
      contextWindow: 40000,
      limits: { maxModelCalls: 150 },
    });

    expect(result.evidence.tokenCurve[0]?.modelCalls).toBe(1);
    expect(result.judgement.compactionVerdict.facts['maxModelCallsPerTurn']).toBe(1);
    expect(result.judgement.compactionVerdict.hardZeroHits).not.toContain('H6.b');
  });

  it('未提供时回落 budget 差分（缺省行为不变；6 > 4 命中 H6.b）', async () => {
    const session = new FakeHarnessSession(scripted([{ reply: '完成', calls: sixCalls }]));
    const result = await runHarnessSession({
      session,
      plan: { track: 'LS4', turns: [{ index: 1, text: '建立', kind: 'establish' }] },
      wave: 'Wave1',
      track: 'LS4',
      sessionId: 's-all-calls',
      principalId: 'principal-A',
      model: 'step-3.7-flash',
      contextWindow: 40000,
      limits: { maxModelCalls: 150 },
    });

    expect(result.evidence.tokenCurve[0]?.modelCalls).toBe(6);
    expect(result.judgement.compactionVerdict.hardZeroHits).toContain('H6.b');
  });
});

describe('结构泄漏批汇总（主线判据）', () => {
  it('逐会话读数相加；总命中等于各会话之和', () => {
    const leaky = scanStructureLeak({ replies: [{ index: 1, text: LEAKY_REPLY }] });
    const clean = scanStructureLeak({ replies: [{ index: 1, text: CLEAN_REPLY }] });
    const batch = structureLeakBatch([
      { sessionId: 's-leaky', structureLeak: leaky },
      { sessionId: 's-clean', structureLeak: clean },
    ]);

    expect(batch.criterion).toBe('structure_leak');
    expect(batch.affectsDisposition).toBe(false);
    expect(batch.sessions).toBe(2);
    expect(batch.totalHits).toBe(leaky.totalHits + clean.totalHits);
    expect(batch.totalHits).toBeGreaterThan(0);
    expect(batch.byCode.bare_task_envelope).toBeGreaterThan(0);
    expect(batch.byCode.internal_task_id).toBeGreaterThan(0);
    expect(batch.perSession.find((s) => s.sessionId === 's-leaky')?.totalHits).toBe(leaky.totalHits);
    expect(batch.perSession.find((s) => s.sessionId === 's-clean')?.totalHits).toBe(0);
  });

  it('harness 返回值里的读数能进入批汇总', async () => {
    const session = new FakeHarnessSession(scripted([{ reply: LEAKY_REPLY }]));
    const result = await runHarnessSession({
      session,
      plan: { track: 'LS4', turns: [{ index: 1, text: '建立', kind: 'establish' }] },
      wave: 'Wave1',
      track: 'LS4',
      sessionId: 's-harness-leak',
      principalId: 'principal-A',
      model: 'step-3.7-flash',
      contextWindow: 40000,
      limits: { maxModelCalls: 150 },
    });

    expect(result.structureLeak.totalHits).toBeGreaterThan(0);
    const batch = structureLeakBatch([{ sessionId: 's-harness-leak', structureLeak: result.structureLeak }]);
    expect(batch.totalHits).toBe(result.structureLeak.totalHits);
    expect(batch.perSession[0]?.sessionId).toBe('s-harness-leak');
  });
});

describe('推进决策的压缩地板（2026-11-18）', () => {
  it('地板=0（交互轨）：不补推进轮，直接走复查', () => {
    const probe = { index: 0, kind: 'probe' as const, text: '压缩后复查' };
    const decide = createWave1PumpDecider({ probeTurns: [probe], steadyPumps: 0, pumpCap: 24, smoke: false, minEffectiveCompactions: 0 });
    const next = decide({ completedTurns: 13, effectiveCompactions: 0 });
    expect(next?.kind).toBe('probe');
  });

  it('地板=3（缺省）：仍未达标 → 继续补推进轮', () => {
    const decide = createWave1PumpDecider({ probeTurns: [], steadyPumps: 0, pumpCap: 24, smoke: false });
    const next = decide({ completedTurns: 13, effectiveCompactions: 0 });
    expect(next?.kind).toBe('pump');
  });
});
