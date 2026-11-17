/**
 * R6 测试基建 · 确定性自证：全量调用记账（主 / Pi 摘要 / 重试 / 溢出恢复）+ 单实验硬停（先验拒绝）。
 *
 * 断言（假会话，零真实模型）：
 *   · 记账覆盖三类（主/摘要/重试）——分类别计数齐全；**反向绊线**：漏记任一类 → 红；
 *   · 硬停是**先验拒绝**：达上限（150/3M/2h 冻结值的测试用小值）即停，且**不发起**超限请求
 *     （脚本用尽即抛 = 证明未多发）；判定顺序 ms → calls → tokens；
 *   · 会话/回合关联 + 逐次明细落盘（model-calls.jsonl）齐备。
 * 这是**测试基建自证**，不是产品质量/稳定性结论（质量结论只由真实模型产生）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHarnessSession } from './harness';
import { FakeHarnessSession, noTasks, type FakeScenario } from './fake-session';
import { type TrackPlan } from './load-generator';
import { collectEvidence } from './evidence';
import {
  accountCalls, missingCallKinds, resolveLimits, R6_HARD_LIMITS, CALL_KINDS,
  type ModelCallRecord, type CallKind,
} from './accounting';

function rec(seq: number, kind: CallKind, input = 0, output = 0): ModelCallRecord {
  return { seq, kind, sessionId: 's', turn: 1, tokens: { input, output, total: input + output }, tokensObserved: true, durationMs: 5 };
}

describe('记账 · 分类别求和', () => {
  it('三类（主/摘要/重试）+ 溢出恢复分类别计数正确', () => {
    const usage = accountCalls([
      rec(1, 'main', 100, 50), rec(2, 'summary', 20, 10), rec(3, 'retry', 100, 40), rec(4, 'overflow_recovery', 30, 5),
    ]);
    expect(usage.calls).toBe(4);
    expect(usage.tokens).toBe(355);
    expect(usage.byKind.main).toMatchObject({ calls: 1, tokens: 150 });
    expect(usage.byKind.summary).toMatchObject({ calls: 1, tokens: 30 });
    expect(usage.byKind.retry).toMatchObject({ calls: 1, tokens: 140 });
    expect(usage.byKind.overflow_recovery).toMatchObject({ calls: 1, tokens: 35 });
    expect(usage.tokensObserved).toBe(true);
    expect(missingCallKinds(usage)).toEqual([]);
  });

  it('反向绊线：漏记摘要 → missingCallKinds 报 summary', () => {
    const usage = accountCalls([rec(1, 'main', 100, 50), rec(2, 'retry', 100, 40)]);
    expect(missingCallKinds(usage)).toEqual(['summary']);
  });

  it('反向绊线：漏记重试 → missingCallKinds 报 retry', () => {
    const usage = accountCalls([rec(1, 'main', 100, 50), rec(2, 'summary', 20, 10)]);
    expect(missingCallKinds(usage)).toEqual(['retry']);
  });

  it('反向绊线：漏记主模型 → missingCallKinds 报 main', () => {
    const usage = accountCalls([rec(1, 'summary', 20, 10), rec(2, 'retry', 100, 40)]);
    expect(missingCallKinds(usage)).toEqual(['main']);
  });

  it('任一记录未观测 usage → tokensObserved=false', () => {
    const usage = accountCalls([rec(1, 'main', 100, 50), { ...rec(2, 'summary'), tokensObserved: false }]);
    expect(usage.tokensObserved).toBe(false);
  });
});

describe('硬停上限口径（冻结值）', () => {
  it('R6_HARD_LIMITS = 150 calls / 3,000,000 tokens / 2h（预注册 §十三.D）', () => {
    expect(R6_HARD_LIMITS).toMatchObject({ maxModelCalls: 150, maxTokens: 3_000_000, wallMs: 2 * 60 * 60 * 1000 });
  });
  it('resolveLimits 缺省取冻结值，可被测试覆写', () => {
    expect(resolveLimits({})).toEqual(R6_HARD_LIMITS);
    expect(resolveLimits({ maxModelCalls: 2 })).toMatchObject({ maxModelCalls: 2, maxTokens: 3_000_000 });
  });
  it('四类均为记账类别（CALL_KINDS 稳定）', () => {
    expect(CALL_KINDS).toEqual(['main', 'summary', 'retry', 'overflow_recovery']);
  });
});

/** 长度为 n 的最小计划（仅注入文本，不做事实断言）。 */
function planN(n: number): TrackPlan {
  return { track: 'LS1', turns: Array.from({ length: n }, (_, i) => ({ index: i + 1, text: `turn-${i + 1}`, kind: 'interaction' as const })) };
}

/** 跑 harness（假会话）的便捷封装；planLen 可长于脚本以验证「超限拒发」（脚本用尽即抛）。 */
function run(scenario: FakeScenario, limits: Record<string, number>, now?: () => number, planLen = scenario.turns.length) {
  const plan = planN(planLen);
  const session = new FakeHarnessSession(scenario);
  return runHarnessSession({
    session, plan, wave: 'Wave1', track: plan.track, sessionId: 'sess-acct', principalId: 'principal-A',
    model: 'step-3.7-flash', contextWindow: 128000, limits,
    ...(now ? { now } : {}),
  });
}

/** 生成 n 轮、每轮 1 次主模型调用的最小假脚本（不含事实断言，避免噪声）。 */
function plainScenario(n: number): FakeScenario {
  return { turns: Array.from({ length: n }, () => ({ reply: 'ok', tasks: noTasks(), tokens: 100, messages: 2, modelCalls: 1 })) };
}

describe('harness · 全量记账 + 先验硬停', () => {
  it('三类调用均被逐次记账，且与会话/回合关联', async () => {
    const scenario: FakeScenario = {
      turns: [
        { reply: 'a', tasks: noTasks(), tokens: 100, messages: 2, calls: [{ kind: 'main', input: 100, output: 50, durationMs: 7 }] },
        { reply: 'b', tasks: noTasks(), tokens: 200, messages: 4, calls: [{ kind: 'summary', input: 30, output: 10, durationMs: 3 }] },
        { reply: 'c', tasks: noTasks(), tokens: 300, messages: 6, calls: [{ kind: 'main', input: 80, output: 20 }, { kind: 'retry', input: 80, output: 20 }] },
      ],
    };
    const r = await run(scenario, {});
    expect(missingCallKinds(r.evidence.callAccounting)).toEqual([]);
    expect(r.evidence.callAccounting.byKind.main.calls).toBe(2);
    expect(r.evidence.callAccounting.byKind.summary.calls).toBe(1);
    expect(r.evidence.callAccounting.byKind.retry.calls).toBe(1);
    // 逐次明细：seq 连续、sessionId 回填、回合号递增
    expect(r.evidence.modelCalls.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(r.evidence.modelCalls.every((c) => c.sessionId === 'sess-acct')).toBe(true);
    expect(r.evidence.modelCalls.map((c) => c.turn)).toEqual([1, 2, 3, 3]);
    // 摘要在内全量 token
    expect(r.evidence.callAccounting.tokens).toBe(100 + 50 + 30 + 10 + 80 + 20 + 80 + 20);
  });

  it('主模型硬停（先验拒绝）：达 maxModelCalls 即停，不发起下一请求', async () => {
    // 假脚本只有 2 轮；计划 11 轮。若 harness 多发第 3 次，假会话抛「脚本用尽」→ 测试红。
    const r = await run(plainScenario(2), { maxModelCalls: 2 }, undefined, 5);
    expect(r.evidence.turns).toHaveLength(2);
    expect(r.evidence.modelCalls).toHaveLength(2);
    expect(r.evidence.budgetStopped).toMatchObject({ reason: 'calls', limit: 2, used: 2 });
  });

  it('token 硬停（先验拒绝）：累计 token 达上限即停（含摘要调用在内）', async () => {
    const scenario: FakeScenario = {
      turns: [
        { reply: 'a', tasks: noTasks(), tokens: 100, messages: 2, calls: [{ kind: 'summary', input: 60, output: 60 }] },
        { reply: 'b', tasks: noTasks(), tokens: 200, messages: 4, calls: [{ kind: 'main', input: 10, output: 10 }] },
      ],
    };
    const r = await run(scenario, { maxTokens: 100 }, undefined, 5);
    expect(r.evidence.turns).toHaveLength(1);
    expect(r.evidence.budgetStopped).toMatchObject({ reason: 'tokens', limit: 100, used: 120 });
  });

  it('墙钟硬停（先验拒绝）：注入时钟，超 wallMs 即停', async () => {
    let t = 0;
    const now = () => t;
    const scenario: FakeScenario = {
      turns: [
        { reply: 'a', tasks: noTasks(), tokens: 100, messages: 2, modelCalls: 1 },
        { reply: 'b', tasks: noTasks(), tokens: 200, messages: 4, modelCalls: 1 },
      ],
    };
    // 第 1 轮前 t=0；轮后把时钟推到 1000ms；第 2 轮前检查 1000>=1000 → ms 硬停。
    const session = new FakeHarnessSession(scenario);
    const plan = planN(2);
    const origSend = session.send.bind(session);
    (session as unknown as { send: typeof session.send }).send = async (text: string) => {
      const out = await origSend(text);
      t = 1000;
      return out;
    };
    const r = await runHarnessSession({
      session, plan, wave: 'Wave1', track: plan.track, sessionId: 's', principalId: 'p',
      model: 'm', contextWindow: 128000, limits: { wallMs: 1000 }, now,
    });
    expect(r.evidence.turns).toHaveLength(1);
    expect(r.evidence.budgetStopped).toMatchObject({ reason: 'ms', limit: 1000, used: 1000 });
  });

  it('判定顺序固定 ms → calls → tokens：同时越限时报 ms', async () => {
    let t = 0;
    const now = () => t;
    const session = new FakeHarnessSession(plainScenario(1));
    const plan = planN(2);
    const origSend = session.send.bind(session);
    (session as unknown as { send: typeof session.send }).send = async (text: string) => {
      const out = await origSend(text);
      t = 5000;
      return out;
    };
    const r = await runHarnessSession({
      session, plan, wave: 'Wave1', track: plan.track, sessionId: 's', principalId: 'p',
      model: 'm', contextWindow: 128000, limits: { maxModelCalls: 1, wallMs: 1000 }, now,
    });
    expect(r.evidence.budgetStopped).toMatchObject({ reason: 'ms' });
  });

  it('未超限时不硬停（budgetStopped=null），且调用照常完成', async () => {
    const r = await run(plainScenario(3), {});
    expect(r.evidence.budgetStopped).toBeNull();
    expect(r.evidence.turns).toHaveLength(3);
    expect(missingCallKinds(r.evidence.callAccounting)).toEqual(['summary', 'retry']);
  });
});

describe('证据落盘 · 逐次调用账本', () => {
  it('model-calls.jsonl 落盘且含 kind/tokens/duration/session/turn', async () => {
    const scenario: FakeScenario = {
      turns: [{ reply: 'a', tasks: noTasks(), tokens: 100, messages: 2, calls: [{ kind: 'summary', input: 10, output: 5, durationMs: 9 }] }],
    };
    const r = await run(scenario, {});
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'r6-acct-'));
    try {
      const { dir } = collectEvidence(tmp, r.evidence, r.judgement);
      const rows = readFileSync(path.join(dir, 'model-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'summary', sessionId: 'sess-acct', turn: 1, durationMs: 9, tokens: { input: 10, output: 5, total: 15 } });
      const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
      expect(evidence.callAccounting.byKind.summary.calls).toBe(1);
      expect(evidence.modelCallsByKind).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
