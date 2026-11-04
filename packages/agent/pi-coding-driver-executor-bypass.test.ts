/**
 * A1 任务二：绕开平台执行器必须可观测。
 *
 * 实测形态（同一个任务两个样本）：平台把"算工资表"拆成两半——worker 吸收脏输入洗出契约
 * （该它做），再交给平台执行器渲染（该平台做）。第二个样本里 worker 自己包了一个 wrapper
 * 跑平台脚本：整轮只有本地执行，平台审计里 validate/transform 一次没经网关，而执行足迹
 * 只写着"1 次网关调用"——一次看起来成功的委派。用户的顾虑是"副作用无法评估"。
 *
 * 为什么旧信号不够：`execution.calls` 数的是**所有**被放行的 bash，local 与元数据查询
 * 一并计数，于是"整轮只在本地跑脚本"与"真调过平台执行器"在足迹里完全同形。本文件因此
 * 守四件事：
 *   ① 形态族来自门自己按命令词法做的分类（gateInvocationKind），不是宿主另立一份名单；
 *   ② 三条件同时成立才告警：有本地执行 + 零计划门放行的平台执行 + 落盘了产物；
 *   ③ 告警只是披露，**不改回合结果**（execution / footprint / text 一字不变）；
 *   ④ 有平台执行调用的回合不告警（正常路径零噪音）。
 *
 * 用真 driver + 脚本化假 AgentSession 驱动：G1 门、形态族计数、产物清单、披露判定全走
 * 生产路径（与 pi-coding-driver-execution.test.ts 同一替身模式）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import { createPiCodingTurnDriver, platformExecutorBypassed, WORKER_WIND_DOWN_NUDGE, type PlatformExecutorBypassedEvent } from './src/pi-coding-driver';
import type { DriverMessage, TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';

/** 假 agent 的单个模型回合：要发起哪些 bash / write。 */
type FakeTurn = { bash?: string[]; write?: Array<{ path: string; content?: string }>; text?: string };

/** 放行的平台调用回给 worker 的应答：合法的 RESULT 信封。 */
const OK_ENVELOPE = 'RESULT {"v":1,"op":"probe.query","status":"completed","data":{"ok":true},"error":null}';

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; rounds: number; messages: unknown[]; steers: string[] };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [], steers: [] };
      records.push(record);
      const state: { errorMessage?: string; messages: unknown[] } = {
        errorMessage: undefined,
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      };
      const agent = {
        state,
        beforeToolCall: undefined as unknown,
        abort: () => {},
        // 步数帽 wind-down 经 session.agent.steer 投递：假会话只记录收到的
        // 内容，不驱动新的模型轮次——断言只认"送过一次、内容是生产那条 nudge"。
        steer: (message: unknown) => {
          const content = (message as { content?: unknown } | null)?.content;
          record.steers.push(typeof content === 'string' ? content : String(message));
        },
        continue: async () => {
          const turn = record.turns[Math.min(record.rounds, record.turns.length - 1)];
          record.rounds += 1;
          if (!turn) return;
          let index = 0;
          const emit = async (name: string, args: Record<string, unknown>): Promise<void> => {
            index += 1;
            const ctx = {
              assistantMessage: {},
              toolCall: { id: `call_${record.rounds}_${index}`, type: 'toolCall', name, arguments: args },
              args,
              context: {},
            };
            const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
            record.messages.push({
              role: 'toolResult',
              toolCallId: ctx.toolCall.id,
              toolCallName: name,
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : OK_ENVELOPE }],
              isError: Boolean(verdict?.block),
              timestamp: Date.now(),
            });
          };
          for (const command of turn.bash ?? []) await emit('bash', { command });
          for (const file of turn.write ?? []) await emit('write', { path: file.path, content: file.content ?? 'x' });
          if (turn.text) {
            record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
          }
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

/** 计划 CLI 替身：提交即激活（execute 档），于是计划门分支可以放行平台执行调用。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_bypass', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_bypassed', version: 3, decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 2 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

async function makeDriver(planCliRunner: PlanCliRunner = activatingPlanRunner): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-bypass-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner,
    }),
  };
}

function runInput(cwd: string): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '把这一期的表算出来', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_bypass',
    requestId: 'req_bypass',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: Date.now() + 20_000,
    onNotice: async () => {},
    entitySources: { currentMessage: '把这一期的表算出来' },
  };
}

/** A1 实测形状：worker 自己包 wrapper 跑平台脚本（整轮只有 local，没有 query/prepare/commit）。 */
const WRAPPER_BASH = 'bin/17dz local tmp/req_bypass/run_transform.py';
const WRAPPER_WRITE = { path: 'tmp/req_bypass/run_transform.py', content: 'subprocess.run([".venv/bin/python","src/payroll/scripts/transform.py"])' };
/** 经计划门放行的平台执行调用（prepare 模式：渲染入口）。 */
const PREPARE_BASH = 'bin/17dz prepare src/payroll/scripts/transform.py';
const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"payroll.transform","args":[]}]}';

describe('绕开平台执行器的披露判据（纯函数：三条件同时成立）', () => {
  it('有本地执行 + 零平台执行 + 有产物 → 告警', () => {
    expect(platformExecutorBypassed({ localCalls: 2, executorCalls: 0, producedFiles: ['tmp/req_x/run.py'] })).toBe(true);
  });

  it('零本地执行不告警（没跑自己的代码，谈不上绕开）', () => {
    expect(platformExecutorBypassed({ localCalls: 0, executorCalls: 0, producedFiles: ['tmp/req_x/a.txt'] })).toBe(false);
  });

  it('有平台执行调用不告警（正常路径：校验/渲染经了网关）', () => {
    expect(platformExecutorBypassed({ localCalls: 1, executorCalls: 1, producedFiles: ['tmp/req_x/a.txt'] })).toBe(false);
  });

  it('没有产物不告警（只写草稿脚本没产出文件：合法的上游吸收，D-083）', () => {
    expect(platformExecutorBypassed({ localCalls: 3, executorCalls: 0, producedFiles: [] })).toBe(false);
  });

  it('只有元数据查询仍算"零平台执行"（元数据不执行任何东西）', () => {
    // 元数据查询由门另行分类，不进 executorCalls——发现能力面不等于调过执行器
    expect(platformExecutorBypassed({ localCalls: 1, executorCalls: 0, producedFiles: ['tmp/req_x/a.txt'] })).toBe(true);
  });
});

describe('绕开平台执行器：告警事件出现/不出现（真 driver）', () => {
  it('A1 实测形状：整轮只有 local 却产出文件 → 告警事件出现，字段齐全', async () => {
    const { cwd } = await makeDriver();
    const alerts: PlatformExecutorBypassedEvent[] = [];
    const driver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
      onExecutorBypassed: (event) => alerts.push(event),
    });
    fake.setScript([
      { bash: [WRAPPER_BASH, WRAPPER_BASH], write: [WRAPPER_WRITE], text: '表已经算好了。' },
    ]);

    const result = await driver.run(runInput(cwd));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      requestId: 'req_bypass',
      taskId: 'task_bypass',
      localCalls: 2,
      planGateCalls: 0,
      auxiliaryCalls: 0,
      producedFiles: ['tmp/req_bypass/run_transform.py'],
    });
    // 告警只是披露：回合结果一字不变（local 调用照旧构成执行痕迹）。
    // 2026-10-18 起 execution.calls = 全部被放行执行的 bash 数（2026-10-18 run6：纯本地
    // 任务的诚实报告曾被"零网关调用 = 零执行"的旧判据顶掉，本地执行也是执行痕迹）
    expect(result.execution).toEqual({ planId: '', version: 0, calls: 2 });
    expect(result.footprint).toBe('2 次 bin/17dz 调用');
    expect(result.text).toBe('表已经算好了。');
  });

  it('有 prepare 调用 → 不告警（渲染经了平台执行器）', async () => {
    const { cwd } = await makeDriver();
    const alerts: PlatformExecutorBypassedEvent[] = [];
    const driver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
      onExecutorBypassed: (event) => alerts.push(event),
    });
    fake.setScript([
      { bash: [PLAN_COMMAND, WRAPPER_BASH, PREPARE_BASH], write: [WRAPPER_WRITE], text: '表已经算好了。' },
    ]);

    await driver.run(runInput(cwd));

    expect(alerts).toEqual([]);
  });

  it('只有 local、没有落盘产物 → 不告警（草稿迭代是合法形态）', async () => {
    const { cwd } = await makeDriver();
    const alerts: PlatformExecutorBypassedEvent[] = [];
    const driver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
      onExecutorBypassed: (event) => alerts.push(event),
    });
    fake.setScript([{ bash: [WRAPPER_BASH], text: '解析完成。' }]);

    await driver.run(runInput(cwd));

    expect(alerts).toEqual([]);
  });

  it('元数据查询 + local + 产物 → 仍告警，且元数据单独计数（不等于调过执行器）', async () => {
    const { cwd } = await makeDriver();
    const alerts: PlatformExecutorBypassedEvent[] = [];
    const driver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
      onExecutorBypassed: (event) => alerts.push(event),
    });
    fake.setScript([
      { bash: ['bin/17dz operation list --json', WRAPPER_BASH], write: [WRAPPER_WRITE], text: '表已经算好了。' },
    ]);

    await driver.run(runInput(cwd));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ localCalls: 1, planGateCalls: 0, auxiliaryCalls: 1 });
  });
});

describe('步数帽接线（真 driver）：stepCap=2 时第 3 次放行即 wind-down', () => {
  /**
   * 钉住 91bf841 修的那条接线，不是它的复写：gate-call-counts.test.ts 只把
   * recordAllowedBashCall + createStepCapWindDown 两个生产函数按顺序调一遍，
   * 组合行是测试自己写的——把 driver 的 onAllowedBash 改回缺陷形状（wind-down
   * 那一次不计分项 / executor 双计进 auxiliary），那套用例照样全绿。本块用真
   * driver + 脚本化假会话走生产接线：stepCap=2，第 3 次放行恰好是 wind-down
   * 点；断言同时认三件事——steer 只送一次且是生产那条 nudge、wind-down 那次
   * local 照旧计入披露、回合结果（execution / footprint / text）一字不变。
   */
  const METADATA_BASH = 'bin/17dz operation list --json';

  async function runWithStepCap(script: FakeTurn[]): Promise<{
    alerts: PlatformExecutorBypassedEvent[];
    steers: string[];
    result: TurnDriverResult;
  }> {
    const { cwd } = await makeDriver();
    const alerts: PlatformExecutorBypassedEvent[] = [];
    const driver = createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
      onExecutorBypassed: (event) => alerts.push(event),
      stepCap: 2,
    });
    fake.setScript(script);
    const before = fake.records.length;
    const result = await driver.run(runInput(cwd));
    return { alerts, steers: fake.records[before]?.steers ?? [], result };
  }

  it('第 3 次放行是本轮唯一 local：wind-down 只送一次，且该 local 照旧披露', async () => {
    const { alerts, steers, result } = await runWithStepCap([
      { bash: [METADATA_BASH, METADATA_BASH, WRAPPER_BASH], write: [WRAPPER_WRITE], text: '表已经算好了。' },
    ]);

    expect(steers).toEqual([WORKER_WIND_DOWN_NUDGE]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      requestId: 'req_bypass',
      taskId: 'task_bypass',
      localCalls: 1,
      planGateCalls: 0,
      auxiliaryCalls: 2,
      producedFiles: ['tmp/req_bypass/run_transform.py'],
    });
    // 披露只是披露：回合结果一字不变。
    expect(result.execution).toEqual({ planId: '', version: 0, calls: 3 });
    expect(result.footprint).toBe('3 次 bin/17dz 调用');
    expect(result.text).toBe('表已经算好了。');
  });

  it('wind-down 之后计数继续、steer 不重复：第 4 次 local 照旧计入', async () => {
    const { alerts, steers, result } = await runWithStepCap([
      { bash: [METADATA_BASH, METADATA_BASH, WRAPPER_BASH, WRAPPER_BASH], write: [WRAPPER_WRITE], text: '表已经算好了。' },
    ]);

    expect(steers).toEqual([WORKER_WIND_DOWN_NUDGE]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ localCalls: 2, planGateCalls: 0, auxiliaryCalls: 2 });
    expect(result.execution).toEqual({ planId: '', version: 0, calls: 4 });
    expect(result.text).toBe('表已经算好了。');
  });
});
