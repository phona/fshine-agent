/**
 * 两维失败归因自测（确定性假件；零真实模型、零联网）。
 *
 * 三个样例对应任务书要求的口径：
 *   ① 没读技能但交付正确 → 技能链路停在「读取」，业务链路全真，`pass` 不变（true）；
 *   ② 读了技能、方法也体现了，但交付错误 → 技能链路可全真，`pass` 仍由 Oracle 判 false；
 *   ③ 读失败但交付正确 → 读取/方法/有效为假，业务交付仍真，`pass` 不变（true）。
 *
 * 同时证明：同一 trial 允许多项为假；未声明判据/未运行 Oracle 记「未观测」而非「假」；
 * 按臂计数表逐条核对 `pass` 未变，并把三条口径写进渲染输出。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SimCase } from './case';
import { createFactOracle, type SimExecutionFact } from './oracle';
import { finishCompletion, ScriptedSimulator } from './fakes';
import { runSimTrial, type SimSystemTurn, type SimSystemUnderTest, type SimTrialResult } from './run';
import type { SimSkillDiscovery, SimSkillRead } from './skill-telemetry';
import {
  ATTRIBUTION_RULES, attributeTrial, buildArmAttributionTable, renderArmAttributionTable,
  type SimAttributionExpectations,
} from './attribution';

const TMP_DIRS: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-attr-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：确定性系统面（技能发现 + 读取遥测 + 回复 + 执行事实）
// ─────────────────────────────────────────────────────────────────────────────

function discovery(names: readonly string[] = ['record-digest']): SimSkillDiscovery {
  return {
    available: true,
    mainSkillsDir: '/repo/.agents/skills',
    names,
    discoveryOrder: names,
    sortedOrder: [...names],
    sortedStable: true,
    repeatStable: true,
    catalogBytes: 120,
    promptBlockBytes: 122,
    readSkillRegistered: names.length > 0,
  };
}

function readOk(turn = 1): SimSkillRead {
  return {
    toolCallId: `call-ok-${turn}`,
    turn,
    name: 'record-digest',
    ok: true,
    bytes: 300,
    tokens: 90,
    sha256: 'a'.repeat(64),
    verifiedInRoots: true,
    isolationViolation: false,
  };
}

function readFailed(turn = 1): SimSkillRead {
  return {
    toolCallId: `call-failed-${turn}`,
    turn,
    name: 'record-digest',
    ok: false,
    bytes: 0,
    tokens: 0,
    sha256: '',
    failure: '未找到技能：record-digest',
    rejection: { kind: 'not_found', detail: '未找到技能：record-digest' },
    verifiedInRoots: false,
    isolationViolation: false,
  };
}

const COMPLETED_QUERY: SimExecutionFact = { operation: 'dummy.query', status: 'completed', turn: 1 };

interface FakeInput {
  readonly discovery: SimSkillDiscovery;
  readonly reads?: readonly SimSkillRead[];
  readonly reply: string;
  readonly executions?: readonly SimExecutionFact[];
}

/** 只产出一条系统回复的假系统；`skillReads` 只在第一次 send 上报。 */
class AttributionSystem implements SimSystemUnderTest {
  constructor(private readonly input: FakeInput) {}

  async send(): Promise<SimSystemTurn> {
    return {
      visibleReply: this.input.reply,
      toolCalls: this.input.executions?.length ?? 0,
      executions: this.input.executions ?? [],
      ...(this.input.reads === undefined ? {} : { skillReads: this.input.reads }),
    };
  }

  skillDiscovery(): SimSkillDiscovery {
    return this.input.discovery;
  }
}

function makeCase(): SimCase {
  return {
    id: 'ATTR-CASE',
    goal: '核对 alpha 这批的合计',
    persona: '做对账的业务同事，只要结果',
    knowledge: ['alpha 是我要核对的集合'],
    initialMessage: '帮我看下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['INC-7788'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
    fixtureId: 'dummy-platform:default',
    oracleId: 'fact:alpha:sum',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
  };
}

/** 真值 Oracle：alpha 合计必须是 2000（正确性只归 Oracle，归因不重复判真值）。 */
const ALPHA_SUM_ORACLE = createFactOracle({
  id: 'fact:alpha:sum',
  expectation: { kind: 'exact', collection: 'alpha', sum: 2000 },
  truthPatterns: [],
});

async function runTrial(system: SimSystemUnderTest): Promise<SimTrialResult> {
  return runSimTrial(makeCase(), 1, {
    outRoot: tmpRoot(),
    createSystem: () => system,
    simulator: new ScriptedSimulator([finishCompletion('satisfied', '结果拿到了')]),
    oracle: ALPHA_SUM_ORACLE,
  });
}

const EXPECTATIONS: SimAttributionExpectations = {
  expectedOperations: ['dummy.query'],
  requiresData: true,
  requiresComputation: true,
  methodMarkers: ['逐条', '合计'],
};

// ─────────────────────────────────────────────────────────────────────────────
// 三个样例
// ─────────────────────────────────────────────────────────────────────────────

describe('样例①：没读技能但交付正确', () => {
  it('技能链路停在「读取」，业务链路全真，pass 保持 true（没读 ≠ 业务失败）', async () => {
    const trial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));
    expect(trial.pass).toBe(true);
    const attribution = attributeTrial(trial, EXPECTATIONS);

    // 口径 1：没读技能不是业务失败——业务五项全部可判为真。
    expect(attribution.skill.catalogDiscovered).toBe(true);
    expect(attribution.skill.read).toBe(false);
    expect(attribution.skill.readSucceeded).toBe(false);
    expect(attribution.skill.methodReflected).toBe(false);
    expect(attribution.skill.effective).toBe(false);
    expect(attribution.business).toMatchObject({
      intentUnderstood: true,
      delegationFidelity: true,
      dataAcquired: true,
      businessComputed: true,
      finalDelivery: true,
    });
    // 口径 3：归因原样透传 Oracle 判定，不改 pass。
    expect(attribution.pass).toBe(trial.pass);
    expect(attribution.pass).toBe(true);
  });
});

describe('样例②：读了技能、方法也体现了，但交付错误', () => {
  it('技能链路可全真，pass 仍由 Oracle 判 false（调用/方法体现 ≠ 交付正确）', async () => {
    const trial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reads: [readOk(1)],
      reply: 'alpha 逐条列示：1200、800，合计 3000。',
      executions: [COMPLETED_QUERY],
    }));
    expect(trial.pass).toBe(false);
    const attribution = attributeTrial(trial, EXPECTATIONS);

    expect(attribution.skill.read).toBe(true);
    expect(attribution.skill.readSucceeded).toBe(true);
    expect(attribution.skill.methodReflected).toBe(true);
    expect(attribution.skill.effective).toBe(true);
    expect(attribution.business.businessComputed).toBe(true);
    // 主判据只看最终交付：方法体现得再全，交付错就是 false，且 pass 不变。
    expect(attribution.business).toMatchObject({
      intentUnderstood: true,
      delegationFidelity: true,
      dataAcquired: true,
      businessComputed: true,
      finalDelivery: false,
    });
    expect(attribution.pass).toBe(trial.pass);
    expect(attribution.pass).toBe(false);
  });
});

describe('样例③：读失败但交付正确', () => {
  it('读取/方法/有效为假（同一 trial 多项为假），业务交付仍真，pass 保持 true', async () => {
    const trial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reads: [readFailed(1)],
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));
    expect(trial.pass).toBe(true);
    const attribution = attributeTrial(trial, EXPECTATIONS);

    // 口径 2：调用了 read_skill 不等于技能有效；读取失败 → 读取/方法/有效均为假。
    expect(attribution.skill.read).toBe(true);
    expect(attribution.skill.readSucceeded).toBe(false);
    expect(attribution.skill.methodReflected).toBe(false);
    expect(attribution.skill.effective).toBe(false);
    const skillFalses = [
      attribution.skill.readSucceeded, attribution.skill.methodReflected, attribution.skill.effective,
    ];
    expect(skillFalses.filter((value) => value === false)).toHaveLength(3);

    // 口径 1：技能失败没有波及业务链路——业务五项全部可判为真。
    expect(attribution.business).toMatchObject({
      intentUnderstood: true,
      delegationFidelity: true,
      dataAcquired: true,
      businessComputed: true,
      finalDelivery: true,
    });
    expect(attribution.pass).toBe(trial.pass);
    expect(attribution.pass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 三态与按臂计数表
// ─────────────────────────────────────────────────────────────────────────────

describe('未观测 ≠ 假', () => {
  it('未声明 methodMarkers / expectedOperations 记 null，不冒充失败', async () => {
    const trial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));
    const attribution = attributeTrial(trial);
    expect(attribution.skill.methodReflected).toBeNull();
    expect(attribution.skill.effective).toBeNull();
    expect(attribution.business.delegationFidelity).toBeNull();
    // 不可观测必须带明确原因（不是留空）。
    expect(attribution.unobservable.skill.methodReflected).toMatch(/methodMarkers/);
    expect(attribution.unobservable.skill.effective).toMatch(/methodReflected/);
    expect(attribution.unobservable.business.delegationFidelity).toMatch(/expectedOperations/);
  });

  it('gave_up（Oracle 未运行）时最终交付记 null，不冒充失败', async () => {
    const trial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reply: '我再看看。',
      executions: [],
    }));
    // 这里 Oracle 会运行（satisfied）；直接构造一个未判定的 trial 投影。
    const unjudged: SimTrialResult = { ...trial, terminal: 'gave_up', pass: false, oracle: null };
    const attribution = attributeTrial(unjudged);
    expect(attribution.business.finalDelivery).toBeNull();
    expect(attribution.unobservable.business.finalDelivery).toMatch(/Oracle 未运行/);
    expect(attribution.pass).toBe(false);
  });
});

describe('按臂两维计数表', () => {
  it('逐臂统计真/假/未观测，逐条核对 pass 未变，并写死三条口径', async () => {
    const noRead = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));
    const readWrong = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reads: [readOk(1)],
      reply: 'alpha 逐条列示：1200、800，合计 3000。',
      executions: [COMPLETED_QUERY],
    }));
    const readFailedTrial = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reads: [readFailed(1)],
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));

    const table = buildArmAttributionTable(
      [
        { arm: 'A', trials: [noRead, readFailedTrial] },
        { arm: 'B', trials: [readWrong] },
      ],
      new Map([['ATTR-CASE', EXPECTATIONS]]),
    );

    expect(table.passUnchanged).toBe(true);
    expect(table.arms.map((arm) => arm.arm)).toEqual(['A', 'B']);
    const a = table.arms[0]!;
    const b = table.arms[1]!;
    expect(a.passed).toBe(2);
    expect(b.passed).toBe(0);
    expect(a.skill.catalogDiscovered).toEqual({ true: 2, false: 0, unobserved: 0 });
    expect(a.skill.read).toEqual({ true: 1, false: 1, unobserved: 0 });
    expect(a.skill.readSucceeded).toEqual({ true: 0, false: 2, unobserved: 0 });
    expect(a.skill.effective).toEqual({ true: 0, false: 2, unobserved: 0 });
    expect(a.business.finalDelivery).toEqual({ true: 2, false: 0, unobserved: 0 });
    expect(b.skill.effective).toEqual({ true: 1, false: 0, unobserved: 0 });
    expect(b.business.finalDelivery).toEqual({ true: 0, false: 1, unobserved: 0 });

    // 三条口径写死并随表输出。
    expect(ATTRIBUTION_RULES.map((rule) => rule.id)).toEqual([
      'no-read-skill-is-not-business-failure',
      'read-skill-is-not-skill-effective',
      'final-business-delivery-is-primary',
    ]);
    const markdown = renderArmAttributionTable(table);
    expect(markdown).toContain('pass 未变：true');
    expect(markdown).toContain('没调用 read_skill ≠ 业务失败');
    expect(markdown).toContain('调用了 read_skill ≠ 技能有效');
    expect(markdown).toContain('最终业务交付正确（Oracle 判定）是主判据');
    expect(markdown).toContain('| 技能链路 | Catalog 发现 | 2/0/0 | 1/0/0 |');
    expect(markdown).toContain('最终交付（主判据）');
    // 表尾如实列出每臂 pass 计数。
    expect(markdown).toContain('| A | 2 | 2 |');
    expect(markdown).toContain('| B | 1 | 0 |');
    // 未观测项在表内显式给原因（不是留空）。
    expect(markdown).toContain('未观测项原因');
  });

  it('无期望声明时，不可判项计入「未观测」而不是「假」', async () => {
    const noRead = await runTrial(new AttributionSystem({
      discovery: discovery(),
      reply: 'alpha 逐条 2 条，合计 2000。',
      executions: [COMPLETED_QUERY],
    }));
    const table = buildArmAttributionTable([{ arm: 'A', trials: [noRead] }]);
    const a = table.arms[0]!;
    expect(a.business.delegationFidelity).toEqual({ true: 0, false: 0, unobserved: 1 });
    expect(a.skill.methodReflected).toEqual({ true: 0, false: 0, unobserved: 1 });
    // 缺省 requiresComputation 由 oracleId 的 `fact:` 前缀推断 → 业务计算可判。
    expect(a.business.businessComputed).toEqual({ true: 1, false: 0, unobserved: 0 });
    // 原因随计数表落盘：可区分「缺声明字段」与「本就不可判」。
    expect(Object.keys(a.unobservable.business.delegationFidelity)).toEqual([
      '用例未声明 expectedOperations（无机械真值来源）：拆解与委派保真不可观测',
    ]);
    expect(Object.keys(a.unobservable.skill.methodReflected).join('')).toMatch(/methodMarkers/);
  });
});
