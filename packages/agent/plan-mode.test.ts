import { describe, expect, it } from 'vitest';
import type { TaskPlanProjection, TaskPlanRepo, TaskPlanStepFact, TrustedContext } from '@fshine/contracts';
import { RUN_17DZ_TASK_DESCRIPTION, RUN_17DZ_TASK_SCHEMA, RUN_17DZ_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ToolUserError, type ScriptedTurnStep, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './src/driver';
import { ScriptedTurnDriver } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './src/turn-contract';
import { FakeSessionRepo } from './test-helpers';

/**
 * 长任务拆解（roadmap Phase 6，架构 §3 规划者/执行者）。
 *
 * 覆盖：计划模式协议解析落点、步骤事实写入、planId 跨步一致与 latestOpenPlan 续跑、
 * 通知标签透传、业务 skill 注入、汇总回合的出口校验。
 */

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_plan',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001'],
    sessionId: 'sess_plan',
    ...overrides,
  };
}

/** 内存版任务计划存储：语义与 packages/core 的 SQLite 实现一致（后写覆盖、悬挂步=未完结）。 */
class FakeTaskPlanRepo implements TaskPlanRepo {
  readonly facts: TaskPlanStepFact[] = [];

  async append(fact: TaskPlanStepFact): Promise<void> {
    const existing = this.facts.find((candidate) => candidate.factId === fact.factId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error(`factId collision: ${fact.factId}`);
      return;
    }
    this.facts.push(structuredClone(fact));
  }

  async project(_principalId: string, _sessionId: string, planId: string): Promise<TaskPlanProjection | null> {
    const rows = this.facts.filter((fact) => fact.planId === planId);
    if (!rows.length) return null;
    const counts = { started: 0, done: 0, failed: 0, needs: 0 } as Record<TaskPlanStepFact['status'], number>;
    const lastByStep = new Map<number, TaskPlanStepFact>();
    let totalSteps = 0;
    let updatedAt = '';
    for (const fact of rows) {
      counts[fact.status] += 1;
      lastByStep.set(fact.stepIndex, fact);
      totalSteps = Math.max(totalSteps, fact.totalSteps);
      updatedAt = fact.createdAt;
    }
    return {
      planId,
      sessionId: _sessionId,
      totalSteps,
      started: counts.started,
      done: counts.done,
      failed: counts.failed,
      needs: counts.needs,
      steps: [...lastByStep.values()]
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((fact) => ({ stepIndex: fact.stepIndex, status: fact.status, ...(fact.taskId ? { taskId: fact.taskId } : {}), ...(fact.summary ? { summary: fact.summary } : {}) })),
      updatedAt,
    };
  }

  async latestOpenPlan(_principalId: string, _sessionId: string): Promise<string | null> {
    const plans = new Map<string, { started: Set<number>; closed: Set<number> }>();
    for (const fact of [...this.facts].reverse()) {
      let entry = plans.get(fact.planId);
      if (!entry) { entry = { started: new Set(), closed: new Set() }; plans.set(fact.planId, entry); }
      if (fact.status === 'started') entry.started.add(fact.stepIndex);
      else entry.closed.add(fact.stepIndex);
    }
    for (const [planId, entry] of plans) {
      if ([...entry.started].some((stepIndex) => !entry.closed.has(stepIndex))) return planId;
    }
    return null;
  }
}

/**
 * 多声明对话驱动（与 e2e 的 mainDriver 同构）：申报被宿主接受且没有 terminate 时，
 * 模型继续同一回合并消费下一条声明——计划模式的每一步都走这条路。
 */
function planDriver(declarations: Array<Record<string, unknown> & { text?: string }>, observed: unknown[] = []) {
  return {
    run: async (input: TurnDriverInput): Promise<TurnDriverResult> => {
      const messages = [...input.messages] as unknown[];
      for (const [index, { text, ...declaration }] of declarations.entries()) {
        const callId = `call_${index + 1}`;
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: ROUTE_CURRENT_TURN_TOOL_NAME, arguments: declaration }], timestamp: index } as never);
        try {
          const outcome = await input.exec(ROUTE_CURRENT_TURN_TOOL_NAME, declaration);
          observed.push(outcome);
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

function subagent(script: Array<(args: { request: string; taskId?: string; stepLabel?: string }) => SubagentTaskResult>): ContextTaskRunner & { calls: Array<{ request: string; taskId?: string; stepLabel?: string }> } {
  const calls: Array<{ request: string; taskId?: string; stepLabel?: string }> = [];
  return {
    tool: { name: RUN_17DZ_TASK_TOOL, description: RUN_17DZ_TASK_DESCRIPTION, inputSchema: RUN_17DZ_TASK_SCHEMA },
    calls,
    run: async (args) => {
      calls.push({ request: args.request, ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.stepLabel ? { stepLabel: args.stepLabel } : {}) });
      const handler = script[Math.min(calls.length - 1, script.length - 1)]!;
      return handler({ request: args.request, ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.stepLabel ? { stepLabel: args.stepLabel } : {}) });
    },
  };
}

const DONE = (taskId: string, text: string): SubagentTaskResult => ({ taskId, text, execution: { planId: 'plan_platform', version: 1, calls: 1 } });

describe('长任务拆解：计划模式与任务计划状态', () => {
  it('P6.1 三步拆解全链：每步单独委派、后两步续跑同一子任务、汇总由 conversation 产出', async () => {
    const toolResults: unknown[] = [];
    const task = subagent([
      (args) => DONE('task_multi', '第一步结果：对象甲 202609 数值 11。'),
      (args) => DONE('task_multi', `第二步结果（续跑 ${args.taskId}）。`),
      () => DONE('task_multi', '第三步结果：对象丙 202609 数值 33。'),
    ]);
    const { driver } = { driver: planDriver([
      { kind: 'delegate', request: '第1/3步：查对象甲 202609' },
      { kind: 'delegate', request: '第2/3步：查对象乙 202609', continueTaskId: 'task_multi' },
      { kind: 'delegate', request: '第3/3步：查对象丙 202609', continueTaskId: 'task_multi' },
      { kind: 'conversation', text: '汇总：对象甲 11，对象乙 22，对象丙 33。' },
    ], toolResults) };
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: task });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_multi' }), '逐个核对甲乙丙三个对象 202609');

    // 三次委派都发生了，且第 2/3 步起续跑同一个子任务（平台累计账本因此跨步累积）
    expect(task.calls).toHaveLength(3);
    expect(task.calls[1]?.taskId).toBe('task_multi');
    expect(task.calls[2]?.taskId).toBe('task_multi');
    // 协议前缀不透传给子 Agent：worker 只看到加工后的请求
    expect(task.calls[0]?.request).toBe('查对象甲 202609');
    expect(task.calls[1]?.request).toBe('查对象乙 202609');
    // 每一步的结果作为工具结果交还模型（不 terminate），最后才是汇总文本
    expect(JSON.stringify(toolResults[0])).toContain('第 1/3 步');
    expect(JSON.stringify(toolResults[1])).toContain('第 2/3 步');
    expect(JSON.stringify(toolResults[2])).toContain('第 3/3 步');
    expect(JSON.stringify(toolResults[2])).toContain('conversation');
    expect(reply.text).toBe('汇总：对象甲 11，对象乙 22，对象丙 33。');
  });

  it('P6.2 无前缀 delegate 仍是单步：结果直接作为本轮回复，不落任何计划状态', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([() => DONE('task_single', '单步结果：对象甲 202609 数值 11。')]);
    const { driver } = recordingDriver([{ toolCalls: [{ tool: ROUTE_CURRENT_TURN_TOOL_NAME, args: { kind: 'delegate', request: '查对象甲 202609' } }] }, { text: '不应外发' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: task, taskPlans });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_single' }), '查对象甲 202609');

    expect(reply.text).toBe('单步结果：对象甲 202609 数值 11。');
    expect(task.calls).toHaveLength(1);
    // 单步模式不写任务计划事实（没有拆解就没有计划）
    expect(taskPlans.facts).toHaveLength(0);
  });

  it('P6.3 非法前缀按单步：协议解析失败不退化成失败，只是这一轮按单步收尾', async () => {
    const task = subagent([() => DONE('task_bad', '单步结果：对象甲 202609 数值 11。')]);
    const { driver } = recordingDriver([{ toolCalls: [{ tool: ROUTE_CURRENT_TURN_TOOL_NAME, args: { kind: 'delegate', request: '第4/3步：查对象甲 202609' } }] }, { text: '不应外发' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: task });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_bad_prefix' }), '查对象甲 202609');

    expect(reply.text).toBe('单步结果：对象甲 202609 数值 11。');
    expect(task.calls).toHaveLength(1);
    expect(task.calls[0]?.stepLabel).toBeUndefined();
  });

  it('P6.4 步骤事实：委派前 started，结束后 done/failed/needs，taskId 落在该步最后一条事实上', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([
      () => DONE('task_facts', '第一步成功。'),
      () => ({ taskId: 'task_facts', text: '平台要求必须显式给出期间。', needs: { missing: ['期间'], reason: '平台要求必须显式给出期间' } }),
      () => ({ taskId: 'task_facts', text: '这一步没有产生任何平台执行。' }),
    ]);
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/3步：查对象甲' },
        { kind: 'delegate', request: '第2/3步：查对象乙', continueTaskId: 'task_facts' },
        { kind: 'delegate', request: '第3/3步：查对象丙', continueTaskId: 'task_facts' },
        { kind: 'conversation', text: '汇总：对象甲查到了，对象乙缺期间，对象丙没有执行。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: task,
      taskPlans,
    });

    await runtime.handleTurn(makeCtx({ requestId: 'req_facts' }), '逐个核对甲乙丙');

    const byStep = (index: number) => taskPlans.facts.filter((fact) => fact.stepIndex === index);
    expect(byStep(1).map((fact) => fact.status)).toEqual(['started', 'done']);
    expect(byStep(2).map((fact) => fact.status)).toEqual(['started', 'needs']);
    expect(byStep(3).map((fact) => fact.status)).toEqual(['started', 'failed']);
    // started 不带 taskId（当时还不知道），taskId 由终态事实回填
    expect(byStep(1)[0]?.taskId).toBeUndefined();
    expect(byStep(1)[1]?.taskId).toBe('task_facts');
    expect(byStep(2)[1]?.summary).toContain('期间');
    expect(byStep(3)[1]?.summary).toBe('未产生平台执行');
    // request 存的是剥掉协议前缀的加工后请求
    expect(byStep(2)[0]?.request).toBe('查对象乙');
    // 投影按"每个步号保留最后一条事实"重建
    const projection = await taskPlans.project('wecom:user_a', 'sess_plan', 'plan_req_facts');
    expect(projection?.steps.map((step) => step.status)).toEqual(['done', 'needs', 'failed']);
  });

  it('P6.5 planId 跨步一致，且任一步失败不阻塞后续步骤', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([
      () => DONE('task_same', '第一步成功。'),
      () => ({ taskId: 'task_same', text: '平台要求必须显式给出期间。', needs: { missing: ['期间'], reason: '平台要求必须显式给出期间' } }),
      () => DONE('task_same', '第三步成功。'),
    ]);
    const toolResults: unknown[] = [];
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/3步：查对象甲' },
        { kind: 'delegate', request: '第2/3步：查对象乙', continueTaskId: 'task_same' },
        { kind: 'delegate', request: '第3/3步：查对象丙', continueTaskId: 'task_same' },
        { kind: 'conversation', text: '汇总：甲查到了，乙缺期间没查，丙查到了。' },
      ], toolResults),
      sessions: new FakeSessionRepo(),
      platformTask: task,
      taskPlans,
    });

    const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_same' }), '逐个核对甲乙丙');

    const planIds = new Set(taskPlans.facts.map((fact) => fact.planId));
    expect([...planIds]).toEqual(['plan_req_same']);
    // 第二步回报"缺什么"也没有把回合掐掉：第三步照样派了
    expect(task.calls).toHaveLength(3);
    expect(JSON.stringify(toolResults[1])).toContain('needs');
    expect(reply.text).toContain('乙缺期间没查');
  });

  it('P6.6 跨回合续跑：新回合的第一步经 latestOpenPlan 找回同一个计划', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([
      () => DONE('task_resume', '第一步成功。'),
      // 第二步停在用户确认门：该步只有 started 事实，计划保持"打开"
      () => ({ taskId: 'task_resume', text: '这一步需要你确认后再执行。', pendingPlan: { planId: 'plan_pending', version: 1, taskId: 'task_resume', decision: 'confirm', userText: '需要确认', evaluation: {} as never } }),
      () => DONE('task_resume', '第三步成功。'),
    ]);
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/3步：查对象甲' },
        { kind: 'delegate', request: '第2/3步：查对象乙', continueTaskId: 'task_resume' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: task,
      taskPlans,
    });

    const first = await runtime.handleTurn(makeCtx({ requestId: 'req_resume_a' }), '逐个核对甲乙丙');
    expect(first.text).toContain('确认');
    expect(await taskPlans.latestOpenPlan('wecom:user_a', 'sess_plan')).toBe('plan_req_resume_a');

    // 下一回合继续拆解：第 3 步接得上同一个计划（总步数一致、步号递增）
    const second = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第3/3步：查对象丙', continueTaskId: 'task_resume' },
        { kind: 'conversation', text: '汇总：三步都处理完了。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent([() => DONE('task_resume', '第三步成功。')]),
      taskPlans,
    });
    const reply = await second.handleTurn(makeCtx({ requestId: 'req_resume_b' }), '继续');

    expect(reply.text).toBe('汇总：三步都处理完了。');
    expect(new Set(taskPlans.facts.map((fact) => fact.planId)).size).toBe(1);
  });

  it('P6.7 新拆解不并入旧计划：同样是 3 步但步号从头开始就新开 planId', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/3步：查对象甲' },
        { kind: 'delegate', request: '第2/3步：查对象乙', continueTaskId: 'task_x' },
        { kind: 'conversation', text: '第一批汇总。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent([() => DONE('task_x', '成功。')]),
      taskPlans,
    });
    await runtime.handleTurn(makeCtx({ requestId: 'req_first_batch' }), '逐个核对甲乙丙');

    const second = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/3步：查对象丁' },
        { kind: 'conversation', text: '第二批汇总。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent([() => DONE('task_y', '成功。')]),
      taskPlans,
    });
    await second.handleTurn(makeCtx({ requestId: 'req_second_batch' }), '再逐个核对丁戊己');

    // 第一批第 2 步停在确认门之外但已终态 → 不是"打开的计划"；新拆解拿新 planId
    expect(new Set(taskPlans.facts.map((fact) => fact.planId))).toEqual(new Set(['plan_req_first_batch', 'plan_req_second_batch']));
  });

  it('P6.8 步骤标签透传给委派参数，单步模式不带标签', async () => {
    const task = subagent([
      () => DONE('task_label', '第一步成功。'),
      () => DONE('task_label', '第二步成功。'),
      () => DONE('task_label', '单步成功。'),
    ]);
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/2步：查对象甲' },
        { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_label' },
        { kind: 'conversation', text: '汇总。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: task,
    });
    await runtime.handleTurn(makeCtx({ requestId: 'req_label' }), '核对甲乙');
    expect(task.calls[0]?.stepLabel).toBe('第 1/2 步');
    expect(task.calls[1]?.stepLabel).toBe('第 2/2 步');

    const single = subagent([() => DONE('task_s', '单步成功。')]);
    const singleRuntime = createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '查对象甲' }]),
      sessions: new FakeSessionRepo(),
      platformTask: single,
    });
    await singleRuntime.handleTurn(makeCtx({ requestId: 'req_label_single' }), '查对象甲');
    expect(single.calls[0]?.stepLabel).toBeUndefined();
  });

  it('P6.9 汇总出口：全部步骤零执行时数字结论仍被挡下，如实汇总放行', async () => {
    const runtime = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/2步：查对象甲' },
        { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_zero' },
        { kind: 'conversation', text: '汇总：对象甲 42 元，对象乙 43 元。' },
      ]),
      sessions: new FakeSessionRepo(),
      // 两步都没有任何平台执行，汇总却抛出数字结论
      platformTask: subagent([() => ({ taskId: 'task_zero', text: '对象甲大概是 42 元。' })]),
    });
    const blocked = await runtime.handleTurn(makeCtx({ requestId: 'req_zero_figure' }), '核对甲乙');
    expect(blocked.text).not.toContain('42 元');
    expect(blocked.text).toContain('没有产生任何平台查询');

    const honest = createTaxAgentRuntime({
      driver: planDriver([
        { kind: 'delegate', request: '第1/2步：查对象甲' },
        { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_zero2' },
        { kind: 'conversation', text: '汇总：两步都没能执行，我需要你补充查询范围。' },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent([() => ({ taskId: 'task_zero2', text: '执行不了。' })]),
    });
    const relayed = await honest.handleTurn(makeCtx({ requestId: 'req_zero_honest' }), '核对甲乙');
    expect(relayed.text).toBe('汇总：两步都没能执行，我需要你补充查询范围。');
    expect(relayed.text).not.toContain('没有产生任何平台查询');
  });

  it('P6.10 业务 skill 每回合进系统提示词，与日期行同性质', async () => {
    const capture = (): { seen: () => string; driver: TurnDriver } => {
      const state = { seen: '' };
      const base = ScriptedTurnDriver([{ toolCalls: [{ tool: ROUTE_CURRENT_TURN_TOOL_NAME, args: { kind: 'conversation' } }] }, { text: '你好。' }]);
      return {
        seen: () => state.seen,
        driver: { run: async (input) => { state.seen = input.systemPrompt; return base.run(input); } },
      };
    };
    const withSkill = capture();
    const runtime = createTaxAgentRuntime({
      driver: withSkill.driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent([() => DONE('task_skill', 'x')]),
      businessSkill: '跨账套核对：按账套拆 N 步，互不影响，最后汇总。',
    });

    await runtime.handleTurn(makeCtx({ requestId: 'req_skill' }), '你好');

    expect(withSkill.seen()).toContain('业务编排知识');
    expect(withSkill.seen()).toContain('跨账套核对：按账套拆 N 步，互不影响，最后汇总。');

    // 没有业务 skill 时提示词里不出现该段
    const withoutSkill = capture();
    const plain = createTaxAgentRuntime({ driver: withoutSkill.driver, sessions: new FakeSessionRepo(), platformTask: subagent([() => DONE('t', 'x')]) });
    await plain.handleTurn(makeCtx({ requestId: 'req_skill_none' }), '你好');
    expect(withoutSkill.seen()).not.toContain('业务编排知识');
  });
});

/** 记录驱动输入，便于断言系统提示词等宿主侧注入。 */
function recordingDriver(script: ScriptedTurnStep[]) {
  const base = ScriptedTurnDriver(script);
  return {
    driver: {
      run: async (input: TurnDriverInput): Promise<TurnDriverResult> => base.run(input),
    } as TurnDriver,
  };
}
