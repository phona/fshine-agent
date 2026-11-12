/**
 * 直连委派（移除 route_current_turn 申报层的实现轨）：Main 的真实委派工具 =
 * 宿主已有的执行层工具 `deps.platformTask.tool`（缺省 run_task，schema 只有
 * request / taskId），普通回合直接文本回复。
 *
 * 本文件的用例是**红先证**：在旧实现（工具面只有 route_current_turn）上整组红，
 * 直连落地后整组绿。每条钉一个不变量：
 *   D1 工具面单入口：run_task 在场、route_current_turn 不在场（不以换名并存）；
 *   D2 委派参数与宿主注入面：entitySources 必给（缺省会让实体门静默关闭）、
 *      taskId 透传、宿主内部 turnDeclaration 管道保持（冻结附件与委派块的现有载体）；
 *   D3 计划模式：带「第N/M步：」前缀的直连调用写计划事实并把结果交还模型；
 *   D4 普通回合：不调用任何工具时，模型文本即本轮回复（不再强制申报、不再重试）；
 *   D5 出口执行痕迹门：直连委派零执行时数据结论仍不外发；
 *   D6 background 部署：直连委派走后台派发（受理回执），不 inline 执行。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskPlanStepFact, TrustedContext } from '@fshine/contracts';
import type { ContextTaskRunner, SubagentTaskResult } from './src/context';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL } from './src/context';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import type { PlanEntitySources } from './src/turn-contract';
import { FakeSessionRepo } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'req_direct', principalId: 'wecom:user_a', sessionId: 'sess_1', ...overrides };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: run ?? (async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
  };
}

/** 模型直接调用 run_task；驱动按生产语义把 ToolUserError 的 message 当最终回复。 */
async function runTaskAndTerminate(
  input: TurnDriverInput,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TurnDriverResult | null> {
  try {
    await input.exec('run_task', args, signal);
  } catch (error) {
    if (error instanceof ToolUserError) return { text: error.message, messages: input.messages };
    throw error;
  }
  return null;
}

function recordingDriver(script: Parameters<typeof ScriptedTurnDriver>[0]) {
  const base = ScriptedTurnDriver(script);
  const inputs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    run: async (input) => {
      inputs.push(input);
      return base.run(input);
    },
  };
  return { driver, inputs };
}

describe('直连委派：Main 直接调用 run_task', () => {
  it('D1 工具面单入口：暴露 run_task，不再暴露 route_current_turn', async () => {
    let exposed: string[] = [];
    const driver: TurnDriver = {
      run: async (input) => {
        exposed = input.tools.map((tool) => tool.name);
        return (await runTaskAndTerminate(input, { request: '查询幻东的应收账款余额' }))
          ?? { text: '这条文本不应外发', messages: input.messages };
      },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async () => ({ taskId: 'task_1', text: '幻东 202609 应收余额为 51 元。', execution: { planId: 'plan_1', version: 1, calls: 1 } })),
    });

    const reply = await runtime.handleTurn(makeCtx(), '查询幻东余额');

    expect(exposed).toContain('run_task');
    expect(exposed).not.toContain('route_current_turn');
    expect(reply.text).toBe('幻东 202609 应收余额为 51 元。');
  });

  it('D2 直连调用带上实体来源、taskId 与宿主内部委派管道', async () => {
    const calls: Array<{ request: string; taskId?: string; entitySources?: PlanEntitySources; turnDeclaration?: unknown }> = [];
    const driver: TurnDriver = {
      run: async (input) => (await runTaskAndTerminate(input, { request: '查询幻东的应收账款余额', taskId: 'task_prev' }))
        ?? { text: '这条文本不应外发', messages: input.messages },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async (args) => {
        calls.push(args);
        return { taskId: 'task_prev', text: '幻东 202609 应收余额为 51 元。', execution: { planId: 'plan_1', version: 1, calls: 1 } };
      }),
    });

    await runtime.handleTurn(makeCtx(), '查询幻东余额');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ request: '查询幻东的应收账款余额', taskId: 'task_prev' });
    // 实体来源必给：缺省会让实体范围校验整支静默关闭（pi-coding-driver 以 entitySources 为门）。
    expect(calls[0]?.entitySources).toEqual({ currentMessage: '查询幻东余额' });
    // 宿主内部管道（不进模型 schema）：冻结附件与逐任务委派块的现有载体，直连后不得断档。
    expect(calls[0]?.turnDeclaration).toMatchObject({ kind: 'delegate', request: '查询幻东的应收账款余额' });
  });

  it('D3 计划模式：「第N/M步：」前缀的直连调用写计划事实并把结果交还模型', async () => {
    const facts: TaskPlanStepFact[] = [];
    const taskPlans = {
      append: async (fact: TaskPlanStepFact) => { facts.push(fact); },
      openPlans: async () => [],
      latestOpenPlan: async () => null,
      planIdForTask: async () => null,
      project: async () => null,
    };
    const { driver } = recordingDriver([
      { toolCalls: [{ tool: 'run_task', args: { request: '第1/2步：查询幻辰的应收账款' } }] },
      { text: '第 1/2 步完成：幻辰 202609 应收余额为 51 元。' },
    ]);
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async () => ({ taskId: 'task_step', text: '幻辰 202609 应收余额为 51 元。', execution: { planId: 'plan_step', version: 1, calls: 1 } })),
      taskPlans: taskPlans as never,
    });

    const reply = await runtime.handleTurn(makeCtx(), '查幻辰和新兴五金的应收账款');

    expect(facts.some((fact) => fact.stepIndex === 1 && fact.totalSteps === 2 && fact.status === 'started')).toBe(true);
    expect(reply.text).toBe('第 1/2 步完成：幻辰 202609 应收余额为 51 元。');
  });

  it('D4 普通回合直接回复：不调用任何工具时文本即回复（不再强制申报）', async () => {
    const { driver, inputs } = recordingDriver([{ text: '你好！我可以帮你整理平台数据。' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: subagent() });

    const reply = await runtime.handleTurn(makeCtx(), '你好');

    expect(reply.text).toBe('你好！我可以帮你整理平台数据。');
    // 旧实现的第一轮弃权会触发一次"重试催申报"，这里不再有第二段模型调用。
    expect(inputs).toHaveLength(1);
  });

  it('D5 直连委派零执行：委派留审计事实，出口执行痕迹门仍拦数据结论', async () => {
    const delegated: Array<{ request: string }> = [];
    const audit: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const line = args[0];
      if (typeof line !== 'string') return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed['event'] === 'turn_delegation') audit.push(parsed);
      } catch { /* 非 JSON 行忽略 */ }
    });
    try {
      const { driver } = recordingDriver([
        { toolCalls: [{ tool: 'run_task', args: { request: '查询幻辰财税账套里猫一杯的应收账款余额' } }] },
        { text: '不应到达' },
      ]);
      const runtime = createTaxAgentRuntime({
        driver,
        sessions: new FakeSessionRepo(),
        platformTask: subagent(async (args) => {
          delegated.push({ request: args.request });
          return { taskId: 'task_fake', text: '幻辰 202609 应收余额大概是 42 元。' };
        }),
      });

      const reply = await runtime.handleTurn(makeCtx(), '查幻辰财税账套里猫一杯的应收账款');

      // 委派必须真的发生且留下宿主持有的调用审计事实（B 类；旧直连分支既无审计也无守卫）。
      expect(delegated).toHaveLength(1);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ requestId: 'req_direct', requestLength: '查询幻辰财税账套里猫一杯的应收账款余额'.length });
      expect(reply.text).not.toContain('42 元');
      expect(reply.text).toContain('没有产生任何平台查询');
    } finally {
      spy.mockRestore();
    }
  });

  it('D6 background 部署：直连委派走后台派发受理，不 inline 执行', async () => {
    const submitted: unknown[] = [];
    const taskManager = {
      submit: vi.fn(async (input: unknown) => {
        submitted.push(input);
        return { taskId: 'task_bg', runId: 'run_bg', state: 'running' };
      }),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      cancel: vi.fn(async () => null),
    };
    const inlineRun = vi.fn(async (): Promise<SubagentTaskResult> => ({
      taskId: 'task_inline_should_not_run', text: '不应 inline', execution: { planId: 'plan_inline', version: 1, calls: 1 },
    }));
    const { driver } = recordingDriver([
      { toolCalls: [{ tool: 'run_task', args: { request: '第1/2步：查询幻辰的应收账款' } }] },
      { text: '不应到达' },
    ]);
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(inlineRun),
      backgroundTasks: taskManager,
      workerDispatchMode: 'background',
    } as never);

    const reply = await runtime.handleTurn(makeCtx(), '查幻辰和新兴五金的应收账款');

    expect(taskManager.submit).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toMatchObject({
      originMessage: '查幻辰和新兴五金的应收账款',
      args: { request: '查询幻辰的应收账款' },
    });
    expect(inlineRun).not.toHaveBeenCalled();
    expect(reply.text).toMatch(/受理|排队/);
  });
});
