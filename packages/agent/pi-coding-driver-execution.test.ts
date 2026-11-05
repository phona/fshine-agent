/**
 * 执行足迹回归（2026-09-26 真实平台战斗测试 A3/A4/B3）。
 *
 * 实测形态：审计里有 search-account-sets / query-receivables exit 0（真实执行成功），
 * 最终回复却是 NO_EXECUTION_CLARIFICATION（"本轮没有产生任何平台查询"）。根因是 driver 的
 * execution() 旧形态 `plan && gateCalls > 0`：要求**结果计算时**计划仍激活着，而 worker 常常
 * 在真实调用之后继续重提方案（beforeToolCall 里 activePlan 置空再 evaluateAndActivatePlan，
 * 后续提交 scope 识别失败/被拒，最终 activePlan 停在上一次提交后的 null）——gateCalls > 0 但
 * plan 为 null → 足迹 undefined → runtime 的 C25 守卫误发兜底文案，用户被告知什么都没发生。
 *
 * 关键不变量：G1 门对 bash 的放行**要求 planActive() 为真**（serve-gate.ts 的 block 分支），
 * 所以每一个被放行的 bash 调用都意味着当时有活跃计划——gateCalls > 0 本身就足以证明执行发生过，
 * 结果时刻的计划状态是无关变量。修复把 execution() 改成 `gateCalls > 0` 即返回足迹，身份用第一个
 * 放行调用时 latch 下来的计划。
 *
 * 这里守四件事：
 *   1. 回归：真实执行后计划被重置（scope 失败把 activePlan 置空），足迹仍在且 planId/version/calls 正确；
 *   2. 两次真实调用：calls 如实报 2（A4 的 query-receivables ×2 形态）；
 *   3. needs 不派生：真执行过的回合（哪怕计划随后被重置）不再派生"缺什么"线索；
 *   4. P1 互斥：真实执行过的回合带 execution 不带 activatedPlan（互斥关系仍成立）；
 * 外加从未放行（gateCalls=0）→ 足迹仍为 undefined 的既有边界不被破坏。
 *
 * 最后一条是 C26 次生伤害的投影测试：用**真实 driver** 经 createContextTaskRunner 接入 runtime，
 * 断言计划模式步骤事实是 done 而非 failed（修好足迹前它会被记成 failed）。
 *
 * 只替身 SDK 的 AgentSession：模型回合由脚本化的假 agent 回放（每轮发起哪些 bash），其余全是
 * 生产代码——G1 工具门、计划 CLI 替身、gateCalls 计数、execution/activatedPlan/needs 的合成都走
 * createPiCodingTurnDriver 里的真路径。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TaskPlanRepo, TaskPlanStepFact, TrustedContext } from '@fshine/contracts';
import { createPiCodingTurnDriver } from './src/pi-coding-driver';
import { createContextTaskRunner } from './src/context';
import { createTaxAgentRuntime } from './src/runtime';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './src/turn-contract';
import { ToolUserError, type DriverMessage, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';
import { FakeSessionRepo } from './test-helpers';

/** 假 agent 的单个模型回合：要发起哪些 bash、收尾文本、出错与挂起（超时用）。 */
type FakeTurn = { bash?: string[]; text?: string; errorMessage?: string; hangMs?: number; throws?: string };

/** 放行的平台调用回给 worker 的应答：合法的 RESULT 信封，不带任何"输入不足"错误码。 */
const OK_ENVELOPE = 'RESULT {"v":1,"op":"probe.query","status":"completed","data":{"ok":true},"error":null}';

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; rounds: number; messages: unknown[]; aborts: number; continues: number };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [], aborts: 0, continues: 0 };
      records.push(record);
      const state: { errorMessage?: string; messages: unknown[] } = {
        errorMessage: undefined,
        // driver 会整块替换 messages（恢复宿主转录）：代理到同一个数组，两边看到同一份
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      };
      const agent = {
        state,
        beforeToolCall: undefined as unknown,
        abort: () => { record.aborts += 1; },
        continue: async () => {
          record.continues += 1;
          const turn = record.turns[Math.min(record.rounds, record.turns.length - 1)];
          record.rounds += 1;
          if (!turn) return;
          let index = 0;
          for (const command of turn.bash ?? []) {
            index += 1;
            const callId = `call_${record.rounds}_${index}`;
            const ctx = {
              assistantMessage: {},
              toolCall: { id: callId, type: 'toolCall', name: 'bash', arguments: { command } },
              args: { command },
              context: {},
            };
            // 走生产接线：G1 计划门 + serve gate（放行/拦截都留痕，放行才计 gateCalls）
            const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
            record.messages.push({
              role: 'toolResult',
              toolCallId: callId,
              toolName: 'bash',
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : OK_ENVELOPE }],
              isError: Boolean(verdict?.block),
              timestamp: Date.now(),
            });
          }
          if (turn.text) {
            record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
          }
          if (turn.errorMessage) state.errorMessage = turn.errorMessage;
          if (turn.throws) throw new Error(turn.throws);
          // 挂起放在工具调用之后：模拟"计划已激活，然后这一轮卡住不动"
          if (turn.hangMs) await new Promise((resolve) => setTimeout(resolve, turn.hangMs));
        },
      };
      return { session: { agent, dispose: () => {} } };
    },
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createAgentSession: async () => fake.makeSession() };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// 首条 bash：提交 JSON calls 方案，实体"对象甲/202609"都在 currentMessage 里 → 宿主放行并激活。
const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","对象甲","--period","202609"]}]}';
// 真实平台查询：计划已激活 → G1 放行（gateCalls++，latch 计划身份）。
const QUERY_COMMAND = 'bin/17dz query query-receivables.js --query 对象甲 --period 202609';
// 第二次真实查询（A4 的 query-receivables ×2 形态）。
const QUERY_COMMAND_2 = 'bin/17dz query query-receivables.js --query 对象甲 --period 202610';
// 真实调用之后 worker 重提方案：实体"对象乙"不在任何来源里 → scope 识别失败 → activePlan 置空。
const DECLINED_PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","对象乙","--period","202609"]}]}';

/** 宿主注入的实体来源：含"对象甲/202609"，不含"对象乙"（决定哪条方案会被 scope 拒绝）。 */
const ENTITY_SOURCES = { currentMessage: '核对对象甲 202609 的应收余额' };

/** 计划 CLI 替身：本任务没有既有计划，提交即激活（execute 档，无需通知/确认）。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_execution', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_activated', version: 7, decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 2 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

async function makeDriver(planCliRunner: PlanCliRunner = activatingPlanRunner): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-exec-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      gateway: 'bin/17dz',
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      // label 表直接注入：单测里绝不 spawn 平台 CLI 派生能力清单
      operationLabels: new Map(),
      planCliRunner,
    }),
  };
}

function runInput(cwd: string, options: { deadline?: number } = {}): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '把本期要查的对象查一遍', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_execution',
    requestId: 'req_execution',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: options.deadline ?? Date.now() + 10_000,
    onNotice: async () => {},
    entitySources: ENTITY_SOURCES,
  };
}

describe('执行足迹：真实调用发生过就不误判空（A3/A4 回归）', () => {
  it('回归：真实查询后方案被 scope 拒绝使 activePlan 置空，足迹仍在（planId/version/calls 正确）', async () => {
    const { driver, cwd } = await makeDriver();
    // 单回合内：激活方案 → 放行一次真实查询 → 重提方案被 scope 拒绝（activePlan 置空）→ 收尾文本。
    // 收尾时 currentPlan() 为 null，但调用真发生过——足迹必须如实带回。
    fake.setScript([
      { bash: [PLAN_COMMAND, QUERY_COMMAND, DECLINED_PLAN_COMMAND], text: '对象甲 202609 应收已查到。' },
    ]);

    const result = await driver.run(runInput(cwd));

    // 足迹在：planId/version 来自第一个放行调用时 latch 的计划，calls 是真实放行数（1）。
    expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 1 });
    // P1 互斥：真执行过的回合不带 activatedPlan（"批准了没执行"这个事实不出现）。
    expect(result.activatedPlan).toBeUndefined();
    // needs 不派生：真执行过的回合不缺信息（scope 拒绝虽推了 needsClue，但执行面跑过就压制它）。
    expect(result.needs).toBeUndefined();
    // 注脚如实：1 次 bin/17dz 调用。
    expect(result.footprint).toBe('1 次 bin/17dz 调用');
  });

  it('两次真实调用：calls 如实报 2（A4 的 query-receivables ×2 形态）', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [PLAN_COMMAND, QUERY_COMMAND, QUERY_COMMAND_2, DECLINED_PLAN_COMMAND], text: '对象甲 202609/202610 应收已查到。' },
    ]);

    const result = await driver.run(runInput(cwd));

    expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 2 });
    expect(result.activatedPlan).toBeUndefined();
    expect(result.needs).toBeUndefined();
    expect(result.footprint).toBe('2 次 bin/17dz 调用');
  });

  it('P1 互斥：真实执行过后方案被重置的回合，结果带 execution 不带 activatedPlan', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [PLAN_COMMAND, QUERY_COMMAND, DECLINED_PLAN_COMMAND], text: '对象甲已查到。' },
    ]);

    const result = await driver.run(runInput(cwd));

    // execution 与 activatedPlan 互斥：有 execution 就说明真执行过，绝不是"批准了没执行"。
    expect(result.execution).toBeDefined();
    expect(result.activatedPlan).toBeUndefined();
  });

  it('不破坏既有：从未放行过 bash（gateCalls=0）→ 足迹仍为 undefined', async () => {
    const { driver, cwd } = await makeDriver();
    // 只产出文本，不发任何 bash：零调用、零计划 → 足迹 undefined（C25 的 R2/R3 边界不变）。
    fake.setScript([{ text: '这一轮没有提交任何方案，也没执行。' }]);

    const result = await driver.run(runInput(cwd));

    expect(result.execution).toBeUndefined();
    expect(result.activatedPlan).toBeUndefined();
    expect(result.needs).toBeUndefined();
  });
});

// ── C26 次生伤害投影：真实 driver → context → runtime，步骤事实是 done 而非 failed ──

/** 内存版任务计划存储：语义与 packages/core 的 SQLite 实现一致（后写覆盖、悬挂步=未完结）。 */
class FakeTaskPlanRepo implements TaskPlanRepo {
  readonly facts: TaskPlanStepFact[] = [];
  async append(fact: TaskPlanStepFact): Promise<void> { this.facts.push(structuredClone(fact)); }
  async project(): Promise<null> { return null; }
  async openPlans(): Promise<never[]> { return []; }
  async latestOpenPlan(): Promise<null> { return null; }
  async planIdForTask(): Promise<null> { return null; }
}

/** 内存版平台任务存储（ContextTaskRunner 的 tasks 依赖）。 */
class FakePlatformTaskRepo implements PlatformTaskRepo {
  private readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string): Promise<PlatformTaskRecord | null> { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord): Promise<void> { this.records.set(record.taskId, structuredClone(record)); }
  async listBySession(principalId: string, sessionId: string): Promise<PlatformTaskRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * 多声明对话驱动（与 plan-mode 测试同构）：申报被宿主接受且没有 terminate 时，模型继续同一回合
 * 并消费下一条声明——计划模式的每一步都走这条路。
 */
function planDriver(declarations: Array<Record<string, unknown> & { text?: string }>): TurnDriver {
  return {
    run: async (input: TurnDriverInput): Promise<TurnDriverResult> => {
      const messages = [...input.messages] as unknown[];
      for (const [index, { text, ...declaration }] of declarations.entries()) {
        const callId = `call_${index + 1}`;
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: ROUTE_CURRENT_TURN_TOOL_NAME, arguments: declaration }], timestamp: index } as never);
        try {
          const outcome = await input.exec(ROUTE_CURRENT_TURN_TOOL_NAME, declaration);
          messages.push({ role: 'toolResult', toolName: ROUTE_CURRENT_TURN_TOOL_NAME, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(outcome) }], timestamp: index } as never);
        } catch (error) {
          if (!(error instanceof ToolUserError)) throw error;
          return { text: error.message, messages: messages as never };
        }
        if (text !== undefined) {
          messages.push({ role: 'assistant', content: text, timestamp: index } as never);
          return { text, messages: messages as never };
        }
      }
      return { text: '主 Agent 停嘴：没有给出回复文本', messages: messages as never };
    },
  } as TurnDriver;
}

function makeCtx(requestId: string): TrustedContext {
  return { requestId, principalId: 'wecom:user_a', sessionId: 'sess_execution' };
}

describe('C26 投影：真实执行过的步骤记 done，不被足迹误判污染成 failed', () => {
  it('真实 driver 执行后方案被重置：计划模式步骤事实终态是 done', async () => {
    const { driver, cwd } = await makeDriver();
    const taskPlans = new FakeTaskPlanRepo();
    const profiles: Record<string, ContextProfileConfig> = { '17dz': { root: cwd, skillRoots: [] } };
    // 真实 driver 经 ContextTaskRunner 接入 runtime——足迹误判的完整链条在此复现。
    const platformTask = createContextTaskRunner({ profiles, tasks: new FakePlatformTaskRepo(), workerDriver: driver });
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/2步：查对象甲' },
        { kind: 'conversation', text: '汇总：对象甲 202609 应收已查到。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask,
      taskPlans,
    });
    // 同一形态：真实查询后方案被 scope 拒绝（activePlan 置空），但调用真发生过。
    fake.setScript([
      { bash: [PLAN_COMMAND, QUERY_COMMAND, DECLINED_PLAN_COMMAND], text: '对象甲 202609 应收已查到。' },
    ]);

    const reply = await runtime.handleTurn(makeCtx('req_c26'), '核对对象甲 202609 的应收余额');

    // 汇总正常外发（有执行痕迹，C25 不放兜底）。
    expect(reply.text).toBe('汇总：对象甲 202609 应收已查到。');
    // 步骤事实：started → done（修复前足迹误判空会被记成 failed）。
    const stepFacts = taskPlans.facts.filter((fact) => fact.stepIndex === 1 && fact.planId === 'plan_req_c26');
    expect(stepFacts.map((fact) => fact.status)).toEqual(['started', 'done']);
    expect(stepFacts.at(-1)?.status).toBe('done');
    expect(stepFacts.at(-1)?.status).not.toBe('failed');
  });
});
