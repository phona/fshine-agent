/**
 * SimCase 薄机制 · trial 执行/终态/预算/注入/记账/并发隔离的机制单测（确定性假件，零模型）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertTrialIsolation, ensureTrialPaths, runSimSuite, runSimTrial, simTrialPaths,
  writeSimTrialEvidence,
  type SimSystemTurn, type SimSystemUnderTest, type SimTrialResult,
} from './run';
import type { SimCase } from './case';
import { createReplyOracle, resolveOracle, type SimOracle } from './oracle';
import type { SimModel, SimModelCompletion, SimulatorPrompt } from './simulator';
import type { SimSystemCall } from './run';
import {
  EndlessSimulator, ScriptedSystem as FakesScriptedSystem, sayCompletion,
} from './fakes';

const TMP_DIRS: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-run-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MAIN_CALL: SimSystemCall = { kind: 'main', tokens: { input: 10, output: 5, total: 15 }, tokensObserved: true };

/** 确定性假系统：固定回复 + 每回合 N 次执行调用；可按锚点真实应用注入。 */
class FakeSystem implements SimSystemUnderTest {
  readonly sends: string[] = [];
  private toolCallsSoFar = 0;
  private eventsSoFar = 0;
  private readonly options: {
    reply: string;
    honorInjection?: boolean;
    toolCallsPerTurn?: number;
    calls?: readonly SimSystemCall[];
  };

  constructor(options: { reply: string; honorInjection?: boolean; toolCallsPerTurn?: number; calls?: readonly SimSystemCall[] }) {
    this.options = options;
  }

  async send(text: string, ctx: { injection: { anchor: 'systemTurn' | 'toolCall' | 'event'; at: number; kind: string } | null }): Promise<SimSystemTurn> {
    this.sends.push(text);
    const index = this.sends.length;
    const perTurn = this.options.toolCallsPerTurn ?? 1;
    this.toolCallsSoFar += perTurn;
    const injection = ctx.injection;
    const applied = this.options.honorInjection === true && injection !== null && (
      (injection.anchor === 'toolCall' && this.toolCallsSoFar >= injection.at) ||
      (injection.anchor === 'event' && this.eventsSoFar >= injection.at) ||
      (injection.anchor === 'systemTurn' && injection.at === index)
    );
    return {
      visibleReply: this.options.reply,
      toolCalls: perTurn,
      events: 0,
      calls: this.options.calls ?? [MAIN_CALL],
      injectionApplied: applied,
      injectionReason: applied ? 'applied' : 'fake 未触发',
    };
  }
}

/** 脚本化模拟用户模型：按序吐出预设动作。 */
class ScriptedSimulator implements SimModel {
  readonly prompts: SimulatorPrompt[] = [];
  private index = 0;

  constructor(private readonly outputs: readonly SimModelCompletion[]) {}

  async complete(prompt: SimulatorPrompt): Promise<SimModelCompletion> {
    this.prompts.push(prompt);
    const output = this.outputs[this.index];
    if (output === undefined) throw new Error(`模拟用户脚本用尽：index=${this.index}`);
    this.index += 1;
    return output;
  }
}

const SAY = (text: string): SimModelCompletion => ({
  text: JSON.stringify({ action: 'say', text }),
  tokens: { input: 100, output: 20, total: 120 },
  tokensObserved: true,
});
const WAIT = (reason: string): SimModelCompletion => ({
  text: JSON.stringify({ action: 'wait', reason }),
  tokens: { input: 100, output: 20, total: 120 },
  tokensObserved: true,
});
const FINISH = (finishKind: 'satisfied' | 'gave_up', reason: string): SimModelCompletion => ({
  text: JSON.stringify({ action: 'finish', finishKind, reason }),
  tokens: { input: 100, output: 20, total: 120 },
  tokensObserved: true,
});

function makeCase(overrides: Partial<SimCase> = {}): SimCase {
  return {
    id: 'C-01',
    goal: '核对 alpha 集合的合计',
    persona: '谨慎的业务员',
    knowledge: ['alpha 集合我有权限'],
    initialMessage: '帮我看一下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['内部工单号 INC-7788'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
    fixtureId: 'dummy-fixture-alpha',
    oracleId: 'reply:ok',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    ...overrides,
  };
}

const OK_ORACLE: SimOracle = createReplyOracle({ id: 'reply:ok', required: ['合计'], truthPatterns: ['2000'] });
const FAIL_ORACLE: SimOracle = createReplyOracle({ id: 'reply:ok', required: ['不会出现的字段'], truthPatterns: ['2000'] });

function trialDeps(input: {
  outRoot: string;
  system: SimSystemUnderTest;
  simulator: SimModel;
  oracle: SimOracle;
  judge?: SimModel;
  now?: () => number;
  maxProtocolRepairs?: number;
}) {
  return {
    outRoot: input.outRoot,
    createSystem: () => input.system,
    simulator: input.simulator,
    oracle: input.oracle,
    ...(input.judge === undefined ? {} : { judge: input.judge }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxProtocolRepairs === undefined ? {} : { maxProtocolRepairs: input.maxProtocolRepairs }),
  };
}

function trialWithPaths(paths: SimTrialResult['paths']): SimTrialResult {
  return {
    caseId: paths.root, trial: 1, terminal: 'satisfied', pass: true, exhaustedBy: null,
    messages: [], replies: [], executions: [], contamination: null, injection: null, oracle: null,
    calls: [], accounting: {
      calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, tokensObserved: false,
      byKind: {
        simulator: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        judge: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        main: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        summary: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        retry: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        overflow_recovery: { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      },
      unobservedKinds: [],
    },
    systemAccountingAvailable: true,
    paths,
  };
}

describe('终态：satisfied 只有 Oracle 判真才通过', () => {
  it('satisfied + Oracle 通过 → pass=true，四类终态分开记', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条。' });
    const simulator = new ScriptedSimulator([SAY('麻烦再核对一下'), FINISH('satisfied', '拿到合计了')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    expect(result.oracle?.verdict.pass).toBe(true);
    expect(result.contamination).toBeNull();
    expect(result.exhaustedBy).toBeNull();
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计', '麻烦再核对一下']);
    expect(result.replies).toHaveLength(2);
    expect(result.messages.map((m) => m.action)).toEqual(['say', 'say', 'finish']);
  });

  it('satisfied 但 Oracle 判真失败 → pass=false（终态仍是 satisfied）', async () => {
    const system = new FakeSystem({ reply: '我不知道。' });
    const simulator = new ScriptedSimulator([FINISH('satisfied', '以为完成了')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: FAIL_ORACLE }));
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(false);
    expect(result.oracle?.verdict.pass).toBe(false);
  });

  it('gave_up 永不算通过（即使 Oracle 会判真）', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([FINISH('gave_up', '反复答非所问')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));
    expect(result.terminal).toBe('gave_up');
    expect(result.pass).toBe(false);
    expect(result.oracle).toBeNull();
  });
});

describe('污染检测：用户消息命中真值/禁知 → 该 trial 作废', () => {
  it('initialMessage 命中真值 → contaminated，且消息不发给系统', async () => {
    const system = new FakeSystem({ reply: 'x' });
    const simulator = new ScriptedSimulator([]);
    const result = await runSimTrial(
      makeCase({ initialMessage: '合计是不是 2,000？' }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBe('contaminated');
    expect(result.pass).toBe(false);
    expect(system.sends).toEqual([]);
    expect(result.contamination?.hits).toEqual([{ source: 'truth', pattern: '2000' }]);
    expect(result.contamination?.original).toBe('合计是不是 2,000？');
    expect(simulator.prompts).toHaveLength(0);
  });

  it('中途 say 命中禁知 → contaminated；原文与命中项留证', async () => {
    const system = new FakeSystem({ reply: '请问具体是哪一项？' });
    const simulator = new ScriptedSimulator([SAY('我这边工单是 inc-7788')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));
    expect(result.terminal).toBe('contaminated');
    expect(result.pass).toBe(false);
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计']);
    expect(result.contamination?.hits).toEqual([{ source: 'forbiddenKnowledge', pattern: '内部工单号 INC-7788' }]);
    const polluted = result.messages.find((m) => m.action === 'say' && m.text === '我这边工单是 inc-7788');
    expect(polluted?.contamination?.original).toBe('我这边工单是 inc-7788');
  });
});

describe('预算：wait 与用户回合都有上限', () => {
  it('wait 超过 maxWaitTurns → budget_exhausted(wait_turns)，不无限等待', async () => {
    const system = new FakeSystem({ reply: '还在处理中' });
    const simulator = new ScriptedSimulator([WAIT('等一等'), WAIT('再等等')]);
    const result = await runSimTrial(
      makeCase({ limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBe('budget_exhausted');
    expect(result.exhaustedBy).toBe('wait_turns');
    expect(result.pass).toBe(false);
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计']);
    expect(result.accounting.byKind.simulator.calls).toBe(2);
  });

  it('用户回合用尽 → budget_exhausted(user_turns)，不允许无限追问', async () => {
    const system = new FakeSystem({ reply: '请再说明一下' });
    const simulator = new ScriptedSimulator([SAY('第一次补充'), SAY('第二次补充')]);
    const result = await runSimTrial(
      makeCase({ limits: { maxUserTurns: 2, maxWaitTurns: 2, maxWallMs: 60_000, trials: 1 } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBe('budget_exhausted');
    expect(result.exhaustedBy).toBe('user_turns');
    // 首条 + 1 条补充已用满返问预算，第 2 条脚本不应被消费。
    expect(system.sends).toHaveLength(2);
    expect(simulator.prompts).toHaveLength(1);
  });

  it('墙钟上限只用于预算 → budget_exhausted(wall_ms)', async () => {
    let clock = 0;
    const slowSystem: SimSystemUnderTest = {
      async send(): Promise<SimSystemTurn> {
        clock += 1500;
        return { visibleReply: '回复', toolCalls: 1, calls: [MAIN_CALL] };
      },
    };
    const simulator = new ScriptedSimulator([FINISH('satisfied', 'x')]);
    const result = await runSimTrial(
      makeCase({ limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 1000, trials: 1 } }), 1,
      trialDeps({ outRoot: tmpRoot(), system: slowSystem, simulator, oracle: OK_ORACLE, now: () => clock }),
    );
    expect(result.terminal).toBe('budget_exhausted');
    expect(result.exhaustedBy).toBe('wall_ms');
    expect(simulator.prompts).toHaveLength(0);
  });
});

describe('注入锚点：确定性位置 + planned/applied 证据', () => {
  it('systemTurn@2：第 2 个系统回合之前注入，证据记 appliedTurn', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000', honorInjection: true });
    const simulator = new ScriptedSimulator([SAY('再核对一次'), FINISH('satisfied', '完成')]);
    const result = await runSimTrial(
      makeCase({ injection: { anchor: 'systemTurn', at: 2, kind: 'pre_turn_fault' } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBe('satisfied');
    expect(result.injection).toMatchObject({
      anchor: 'systemTurn', at: 2, kind: 'pre_turn_fault', planned: true, applied: true, appliedTurn: 2, reason: 'applied',
    });
  });

  it('适配器不实现注入时必须如实记 applied=false（不伪造命中）', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([SAY('再核对一次'), FINISH('satisfied', '完成')]);
    const result = await runSimTrial(
      makeCase({ injection: { anchor: 'systemTurn', at: 2, kind: 'pre_turn_fault' } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.injection).toMatchObject({ planned: true, applied: false, reason: 'fake 未触发' });
  });

  it('toolCall@3：第 3 个执行调用处触发（按计数，不挂墙钟）', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000', honorInjection: true, toolCallsPerTurn: 1 });
    const simulator = new ScriptedSimulator([SAY('补一句'), SAY('再补一句'), FINISH('satisfied', '完成')]);
    const result = await runSimTrial(
      makeCase({ injection: { anchor: 'toolCall', at: 3, kind: 'exec_call_failure' } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBe('satisfied');
    expect(result.injection).toMatchObject({ anchor: 'toolCall', at: 3, applied: true, appliedTurn: 3 });
  });

  it('锚点未到达 → planned=false reason=anchor_not_reached', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([FINISH('satisfied', '完成')]);
    const result = await runSimTrial(
      makeCase({ injection: { anchor: 'systemTurn', at: 9, kind: 'never' } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.injection).toMatchObject({ planned: false, applied: false, reason: 'anchor_not_reached' });
  });
});

describe('记账：simulator / judge / 被测系统分开统计', () => {
  it('分类别计数与 token 总计都有，且互不混算', async () => {
    const system = new FakeSystem({
      reply: 'alpha 合计 2000',
      calls: [MAIN_CALL, { kind: 'summary', tokens: { input: 40, output: 10, total: 50 }, tokensObserved: true }],
    });
    const simulator = new ScriptedSimulator([SAY('再核对'), FINISH('satisfied', '完成')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    const usage = result.accounting;
    expect(usage.byKind.simulator.calls).toBe(2);
    expect(usage.byKind.simulator.tokens).toBe(240);
    expect(usage.byKind.main.calls).toBe(2);
    expect(usage.byKind.summary.calls).toBe(2);
    expect(usage.byKind.judge.calls).toBe(0);
    expect(usage.byKind.simulator.tokens + usage.byKind.main.tokens + usage.byKind.summary.tokens).toBe(usage.tokens);
    expect(usage.tokens).toBe(240 + 30 + 100);
    expect(usage.tokensObserved).toBe(true);
    expect(usage.unobservedKinds).toEqual(['judge', 'retry', 'overflow_recovery']);
  });

  it('模型 Oracle 的判官调用单独记 kind=judge', async () => {
    const judgeOracle: SimOracle = {
      id: 'model-judge',
      truthPatterns: [],
      async judge(_ctx, tools) {
        const output = await tools.complete('请核对回复');
        return { pass: output.text.includes('通过'), detail: {} };
      },
    };
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([FINISH('satisfied', '完成')]);
    const judge = new ScriptedSimulator([{ text: '通过', tokens: { input: 7, output: 3, total: 10 }, tokensObserved: true }]);
    const result = await runSimTrial(
      makeCase({ oracleId: 'model-judge' }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: judgeOracle, judge }),
    );
    expect(result.pass).toBe(true);
    expect(result.accounting.byKind.judge.calls).toBe(1);
    expect(result.accounting.byKind.judge.tokens).toBe(10);
    expect(result.accounting.byKind.simulator.calls).toBe(1);
  });

  it('系统面不暴露逐次调用 → 不编造，标注不可得', async () => {
    const noCallsSystem: SimSystemUnderTest = {
      async send(): Promise<SimSystemTurn> {
        return { visibleReply: 'alpha 合计 2000', toolCalls: 1 };
      },
    };
    const simulator = new ScriptedSimulator([FINISH('satisfied', '完成')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system: noCallsSystem, simulator, oracle: OK_ORACLE }));
    expect(result.systemAccountingAvailable).toBe(false);
    expect(result.accounting.byKind.main.calls).toBe(0);
    expect(result.accounting.byKind.simulator.calls).toBe(1);
  });
});

describe('独立 Oracle：复用 R6 事实真值（模拟用户自述不参与判定）', () => {
  const factorial = resolveOracle('fact:alpha:sum');

  it('合计 2000 → pass；合计 1000 → fail（机械比对同 R6 judgeFactAnswer）', async () => {
    const good = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条。' });
    const goodResult = await runSimTrial(
      makeCase({ oracleId: 'fact:alpha:sum' }), 1,
      trialDeps({ outRoot: tmpRoot(), system: good, simulator: new ScriptedSimulator([FINISH('satisfied', '完成')]), oracle: factorial }),
    );
    expect(goodResult.terminal).toBe('satisfied');
    expect(goodResult.pass).toBe(true);

    const bad = new FakeSystem({ reply: 'alpha 合计 1000。' });
    const badResult = await runSimTrial(
      makeCase({ oracleId: 'fact:alpha:sum' }), 1,
      trialDeps({ outRoot: tmpRoot(), system: bad, simulator: new ScriptedSimulator([FINISH('satisfied', '完成')]), oracle: factorial }),
    );
    expect(badResult.terminal).toBe('satisfied');
    expect(badResult.pass).toBe(false);
  });

  it('未知 oracleId → 拒绝（不回落缺省判定器）', () => {
    expect(() => resolveOracle('fact:nope:sum')).toThrow(/未知 oracleId/);
  });
});

describe('协议缺陷与用例卫生：不冒充终态', () => {
  it('始终输出垃圾 → 2 次修复重问后落 protocol_error / pass=false（不洗成 gave_up 或 satisfied）', async () => {
    const system = new FakeSystem({ reply: 'x' });
    const simulator = new ScriptedSimulator([
      { text: '我觉得可以结束了', tokensObserved: false },
      { text: '', tokensObserved: false },
      { text: '还是没有 JSON 对象', tokensObserved: false },
    ]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('protocol_error');
    expect(result.pass).toBe(false);
    expect(result.oracle).toBeNull();
    expect(result.terminal).not.toBe('gave_up');
    expect(result.terminal).not.toBe('satisfied');
    // 首答 + 2 次修复重问，全部计入 simulator 账。
    expect(result.accounting.byKind.simulator.calls).toBe(3);
    expect(simulator.prompts).toHaveLength(3);
    // 每次原始输出（含空输出）逐条留证。
    expect(result.protocol?.repairs).toBe(2);
    expect(result.protocol?.rawOutputs).toEqual(['我觉得可以结束了', '', '还是没有 JSON 对象']);
    expect(result.protocol?.errors).toHaveLength(3);
    // 只有首条 initialMessage 到达系统：垃圾动作从未被当作 say 发出去。
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计']);
    // 修复重问 prompt 明确要求「只输出一个 JSON 动作」，且未把原始输出回灌。
    const repairPrompt = simulator.prompts[1]?.user ?? '';
    expect(repairPrompt).toContain('协议修复');
    expect(repairPrompt).toContain('只输出一个 JSON 动作');
    expect(repairPrompt).not.toContain('我觉得可以结束了');
  });

  it('先输出垃圾、再输出合法动作 → 修复后恢复并正常往下走（不落 protocol_error）', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条' });
    const simulator = new ScriptedSimulator([
      { text: '嗯，我先想想要不要追问。', tokensObserved: false },
      SAY('麻烦再核对一下'),
      FINISH('satisfied', '拿到合计了'),
    ]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    // 首答 1 次 + 修复重问 1 次 + 下一轮正常决策 1 次。
    expect(result.accounting.byKind.simulator.calls).toBe(3);
    expect(result.protocol?.repairs).toBe(1);
    expect(result.protocol?.rawOutputs).toEqual(['嗯，我先想想要不要追问。', JSON.stringify({ action: 'say', text: '麻烦再核对一下' })]);
    // 恢复后的 say 正常到达系统。
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计', '麻烦再核对一下']);
  });

  it('反向绊线：关闭修复重问 → 同一「先垃圾后合法」脚本必须落 protocol_error', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条' });
    const simulator = new ScriptedSimulator([
      { text: '嗯，我先想想要不要追问。', tokensObserved: false },
      SAY('麻烦再核对一下'),
      FINISH('satisfied', '拿到合计了'),
    ]);
    const result = await runSimTrial(
      makeCase(), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE, maxProtocolRepairs: 0 }),
    );

    expect(result.terminal).toBe('protocol_error');
    expect(result.pass).toBe(false);
    expect(result.protocol?.repairs).toBe(0);
    expect(result.accounting.byKind.simulator.calls).toBe(1);
    // 绊线证据：修复重问确实是救回该 trial 的唯一原因（关闭后第二个合法动作根本没被调用）。
    expect(simulator.prompts).toHaveLength(1);
  });

  it('summary 单列 protocol_error，并给出有效样本数 = 总数 − protocol_error', async () => {
    const outRoot = tmpRoot();
    const result = await runSimSuite({
      cases: [
        makeCase({ id: 'C-OK', oracleId: 'reply:ok', limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 } }),
        makeCase({
          id: 'C-BAD',
          goal: 'C-BAD 专项：核对 alpha 集合的合计',
          oracleId: 'reply:ok',
          limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
        }),
      ],
      outRoot,
      concurrency: 2,
      createSystem: () => new FakeSystem({ reply: 'alpha 合计 2000' }),
      simulator: {
        async complete(prompt): Promise<SimModelCompletion> {
          // 只按 prompt 内容区分两条 trial（不依赖调用顺序/共享状态）。
          if (prompt.user.includes('C-BAD 专项')) return { text: '没有动作', tokensObserved: false };
          return FINISH('satisfied', '完成');
        },
      },
      oracles: [OK_ORACLE],
    });

    expect(result.summary.n).toBe(2);
    expect(result.summary.protocolErrors).toBe(1);
    expect(result.summary.effectiveSamples).toBe(1);
    expect(result.summary.byTerminal.protocol_error).toBe(1);
    expect(result.summary.byTerminal.gave_up).toBe(0);
    expect(result.summary.byTerminal.satisfied).toBe(1);
    expect(result.summary.passed).toBe(1);
    const bad = result.trials.find((trial) => trial.caseId === 'C-BAD');
    expect(bad?.terminal).toBe('protocol_error');
    expect(bad?.pass).toBe(false);
  });

  it('真值出现在 knowledge → 先验拒绝，不烧模型', async () => {
    const system = new FakeSystem({ reply: 'x' });
    const simulator = new ScriptedSimulator([]);
    const result = await runSimTrial(
      makeCase({ knowledge: ['alpha 合计是 2000'] }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );
    expect(result.terminal).toBeNull();
    expect(result.error).toContain('用例卫生失败');
    expect(system.sends).toHaveLength(0);
    expect(simulator.prompts).toHaveLength(0);
  });

  it('runSimSuite 预检失败即拒绝跑批（未跑任何样本）', async () => {
    const outRoot = tmpRoot();
    await expect(runSimSuite({
      cases: [makeCase({ id: 'C-BAD', knowledge: ['alpha 合计是 2000'] })],
      outRoot,
      createSystem: () => new FakeSystem({ reply: 'x' }),
      simulator: new ScriptedSimulator([]),
      oracles: [OK_ORACLE],
    })).rejects.toThrow(/预检失败/);
  });
});

describe('并发池：目录隔离 + 四终态汇总', () => {
  /** 无状态模拟用户：所有 trial 共享同一实例也安全（真实模型本就无状态）。 */
  const finishOnce: SimModel = {
    async complete(): Promise<SimModelCompletion> {
      return FINISH('satisfied', '完成');
    },
  };

  it('并发 2、两用例各 2 trial：目录互不共享且逐 trial 证据齐全', async () => {
    const outRoot = tmpRoot();
    const markers: string[] = [];
    const result = await runSimSuite({
      cases: [
        makeCase({ id: 'C-A', oracleId: 'reply:ok', limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 2 } }),
        makeCase({ id: 'C-B', oracleId: 'reply:ok', limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 2 } }),
      ],
      outRoot,
      concurrency: 2,
      createSystem: (paths) => {
        // 每 trial 在自己的 sessionDir 落标记，证明目录不共享。
        writeFileSync(path.join(paths.sessionDir, 'marker.txt'), paths.root, 'utf8');
        markers.push(paths.root);
        return new FakeSystem({ reply: 'alpha 合计 2000' });
      },
      simulator: finishOnce,
      oracles: [OK_ORACLE],
    });

    expect(result.trials).toHaveLength(4);
    expect(result.batch.policy.concurrency).toBe(2);
    expect(result.summary.byTerminal.satisfied).toBe(4);
    expect(result.summary.passed).toBe(4);
    expect(result.summary.isolation).toMatchObject({
      concurrency: 2, trials: 4, uniqueSessionDirs: true, uniqueStateDbPaths: true, uniqueEvidenceDirs: true, dirsCreated: true, shared: [],
    });

    const roots = result.trials.map((trial) => trial.paths.root);
    expect(new Set(roots).size).toBe(4);
    for (const trial of result.trials) {
      const marker = readFileSync(path.join(trial.paths.sessionDir, 'marker.txt'), 'utf8');
      expect(marker).toBe(trial.paths.root);
      expect(existsSync(path.join(trial.paths.evidenceDir, 'manifest.json'))).toBe(true);
    }
  });

  it('并发 5 是缺省值（预注册），硬上限登记仍由 batch.ts 熔断', async () => {
    const outRoot = tmpRoot();
    const result = await runSimSuite({
      cases: [makeCase({ id: 'C-1', limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 } })],
      outRoot,
      createSystem: () => new FakeSystem({ reply: 'alpha 合计 2000' }),
      simulator: finishOnce,
      oracles: [OK_ORACLE],
    });
    expect(result.batch.policy.concurrency).toBe(5);
    expect(result.batch.policy.hardLimitMax).toBe(8);
  });

  it('assertTrialIsolation 对重复目录 fail-closed', () => {
    const shared = simTrialPaths(tmpRoot(), 'C-X', 1);
    ensureTrialPaths(shared);
    expect(() => assertTrialIsolation([trialWithPaths(shared), trialWithPaths(shared)], 2)).toThrow(/目录共享/);
  });
});

describe('证据落盘', () => {
  it('trial.json / manifest.json 齐全，manifest 逐文件 sha256', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([FINISH('satisfied', '完成')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));
    const dir = writeSimTrialEvidence(result);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      terminal: string; pass: boolean; files: { name: string; sha256: string }[];
    };
    expect(manifest.terminal).toBe('satisfied');
    expect(manifest.pass).toBe(true);
    expect(manifest.files.map((file) => file.name)).toEqual([
      'trial.json', 'messages.jsonl', 'replies.jsonl', 'accounting.json', 'injection.json', 'oracle.json',
    ]);
    for (const file of manifest.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(dir, 'trial.json'))).toBe(true);
  });
});

describe('机制自检：模拟用户说出真值必须作废（不是通过）', () => {
  it('模拟用户中途说出真值 2000 → contaminated / pass=false，且该条不发给系统', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000' });
    const simulator = new ScriptedSimulator([sayCompletion('我记得合计是 2000 吧？')]);
    const result = await runSimTrial(makeCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('contaminated');
    expect(result.pass).toBe(false);
    // 作废的 trial 不走 Oracle：即便系统回复本身会判真，也不给判决。
    expect(result.oracle).toBeNull();
    expect(result.contamination?.hits).toEqual([{ source: 'truth', pattern: '2000' }]);
    expect(result.contamination?.original).toBe('我记得合计是 2000 吧？');
    // 只有首条 initialMessage 到达系统；说真值的那条被拦下。
    expect(system.sends).toEqual(['帮我看一下 alpha 的合计']);
  });
});

describe('机制自检：无限追问也必须被预算停住', () => {
  it('永不收尾的模拟用户 → 到 maxUserTurns 停，记 budget_exhausted(user_turns)', async () => {
    const system = new FakeSystem({ reply: '请再说明一下' });
    const simulator = new EndlessSimulator();
    const result = await runSimTrial(
      makeCase({ limits: { maxUserTurns: 3, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 } }), 1,
      trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }),
    );

    expect(result.terminal).toBe('budget_exhausted');
    expect(result.exhaustedBy).toBe('user_turns');
    expect(result.pass).toBe(false);
    expect(result.oracle).toBeNull();
    // 预算口径：3 条用户消息（含首条）后不再询问模拟用户。
    expect(system.sends).toHaveLength(3);
    expect(simulator.prompts).toHaveLength(2);
    // 不是「脚本刚好用完」：脚本本来就是无限的，停下的是预算。
    expect(simulator.prompts).toHaveLength(3 - 1);
  });
});

describe('机制自检：重复意图守卫只终止循环，不参与 pass', () => {
  /** 3 条重复消息之前必须先有 1 条「首次」同文案消息，窗口 3 条才全部是重复。 */
  const repeatedScript = (): SimModelCompletion[] => [
    SAY('刚才那个第二条多少钱？'),
    SAY('刚才那个第二条多少钱？'),
    SAY('刚才那个第二条多少钱？'),
    SAY('刚才那个第二条多少钱？'),
  ];

  const guardCase = () => makeCase({
    limits: { maxUserTurns: 8, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
  });

  it('系统答对 + 用户重复 → finish(satisfied) 且 Oracle 判 pass（reason=repeat_guard）', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条。' });
    const simulator = new ScriptedSimulator(repeatedScript());
    const result = await runSimTrial(guardCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    expect(result.exhaustedBy).toBeNull();
    expect(result.oracle?.verdict.pass).toBe(true);
    const finish = result.messages.find((message) => message.action === 'finish');
    expect(finish?.finishKind).toBe('satisfied');
    expect(finish?.reason).toBe('repeat_guard');
    // 守卫在询问模拟用户之前触发：4 条重复脚本只消费到能形成 3 条重复窗口为止。
    expect(simulator.prompts).toHaveLength(4);
    expect(system.sends).toHaveLength(5);
    // prompt 层的第一层修复：明确「不要为了确认而重复同一句话」「目标达成就 finish」。
    expect(simulator.prompts[0]?.system).toContain('不要为了确认而重复同一句话');
    expect(simulator.prompts[0]?.system).toContain('目标达成就立即 finish(satisfied)');
  });

  it('系统答错 + 用户重复 → 仍 finish(satisfied)，但 Oracle 判 fail（守卫不刷绿）', async () => {
    const system = new FakeSystem({ reply: '我不知道。' });
    const simulator = new ScriptedSimulator(repeatedScript());
    const result = await runSimTrial(guardCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: FAIL_ORACLE }));

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(false);
    expect(result.oracle?.verdict.pass).toBe(false);
    const finish = result.messages.find((message) => message.action === 'finish');
    expect(finish?.reason).toBe('repeat_guard');
  });

  it('用户消息各不相同 → 守卫不触发，收尾原因保留模型自己的 reason', async () => {
    const system = new FakeSystem({ reply: 'alpha 合计 2000，共 2 条。' });
    const simulator = new ScriptedSimulator([
      SAY('请把 alpha 的明细再列一下。'),
      SAY('第二条的金额再确认一下。'),
      SAY('好的，麻烦把最终结果贴出来。'),
      FINISH('satisfied', '已经拿到完整结果'),
    ]);
    const result = await runSimTrial(guardCase(), 1, trialDeps({ outRoot: tmpRoot(), system, simulator, oracle: OK_ORACLE }));

    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    const finish = result.messages.find((message) => message.action === 'finish');
    expect(finish?.reason).toBe('已经拿到完整结果');
    expect(finish?.reason).not.toBe('repeat_guard');
  });
});

describe('机制自检：并发 5 · 5 条假会话的目录/DB 不共享', () => {
  /** 无状态模拟用户：所有 trial 共享同一实例也安全（真实模型本就无状态）。 */
  const finishOnce: SimModel = {
    async complete(): Promise<SimModelCompletion> {
      return FINISH('satisfied', '完成');
    },
  };

  it('concurrency=5 真实交叠；5 个 trial 的 session/state.db/evidence 全独立', async () => {
    const outRoot = tmpRoot();
    const systems: string[] = [];
    const cases = Array.from({ length: 5 }, (_, index) => makeCase({
      id: `C-ISO-${index + 1}`,
      limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    }));

    const result = await runSimSuite({
      cases,
      outRoot,
      concurrency: 5,
      createSystem: async (paths) => {
        // 每 trial 在自己的 sessionDir 与 state.db 落归属标记，证明互不共享。
        writeFileSync(path.join(paths.sessionDir, 'marker.txt'), paths.root, 'utf8');
        writeFileSync(paths.stateDbPath, paths.root, 'utf8');
        systems.push(paths.root);
        // 让出事件循环：保证 5 条会话真的同时在飞（不是串行刷出来的假并发）。
        await new Promise<void>((resolve) => setImmediate(resolve));
        const turn = { visibleReply: 'alpha 共 2 条，合计 2000', calls: [MAIN_CALL] };
        return new FakesScriptedSystem([turn], { fallback: turn });
      },
      simulator: finishOnce,
      oracles: [OK_ORACLE],
    });

    expect(result.trials).toHaveLength(5);
    expect(result.batch.policy.concurrency).toBe(5);
    expect(result.batch.observedMaxConcurrency).toBe(5);
    expect(result.summary.isolation).toMatchObject({
      concurrency: 5, trials: 5, uniqueSessionDirs: true, uniqueStateDbPaths: true,
      uniqueEvidenceDirs: true, dirsCreated: true, shared: [],
    });

    const roots = result.trials.map((trial) => trial.paths.root);
    expect(new Set(roots).size).toBe(5);
    expect(new Set(systems).size).toBe(5);
    for (const trial of result.trials) {
      expect(readFileSync(path.join(trial.paths.sessionDir, 'marker.txt'), 'utf8')).toBe(trial.paths.root);
      expect(readFileSync(trial.paths.stateDbPath, 'utf8')).toBe(trial.paths.root);
      expect(existsSync(path.join(trial.paths.evidenceDir, 'manifest.json'))).toBe(true);
    }
    // 计数分开：5 条假会话 = 5 次 simulator 调用 + 5 次被测系统 main 调用。
    expect(result.summary.accounting.byKind.simulator.calls).toBe(5);
    expect(result.summary.accounting.byKind.main.calls).toBe(5);
  });
});
