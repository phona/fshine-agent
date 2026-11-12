import { describe, expect, it, vi } from 'vitest';
import type { TaskPlanProjection, TaskPlanRepo, TaskPlanStepFact, TaskPlanSummary, TrustedContext } from '@fshine/contracts';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
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

  async openPlans(_principalId: string, _sessionId: string): Promise<TaskPlanSummary[]> {
    // 与 SQLite 实现同语义：未完成 = 已记录步号未接满总步数；按"最后一条事实"倒序（最近活跃在前）。
    const plans = new Map<string, {
      maxStep: number; totalSteps: number; firstRequest: string; updatedAt: string;
      counts: Record<TaskPlanStepFact['status'], number>;
    }>();
    for (const fact of [...this.facts].reverse()) {
      let entry = plans.get(fact.planId);
      if (!entry) {
        entry = { maxStep: 0, totalSteps: 0, firstRequest: '', updatedAt: fact.createdAt, counts: { started: 0, done: 0, failed: 0, needs: 0 } };
        plans.set(fact.planId, entry);
      }
      entry.maxStep = Math.max(entry.maxStep, fact.stepIndex);
      entry.totalSteps = Math.max(entry.totalSteps, fact.totalSteps);
      entry.counts[fact.status] += 1;
      entry.firstRequest = fact.request;
      if (fact.createdAt > entry.updatedAt) entry.updatedAt = fact.createdAt;
    }
    const summaries: TaskPlanSummary[] = [];
    for (const [planId, entry] of plans) {
      if (entry.maxStep >= entry.totalSteps) continue;
      summaries.push({
        planId,
        totalSteps: entry.totalSteps,
        maxRecordedStep: entry.maxStep,
        started: entry.counts.started,
        done: entry.counts.done,
        failed: entry.counts.failed,
        needs: entry.counts.needs,
        firstRequest: entry.firstRequest,
        updatedAt: entry.updatedAt,
      });
    }
    return summaries;
  }

  async latestOpenPlan(_principalId: string, _sessionId: string): Promise<string | null> {
    return (await this.openPlans(_principalId, _sessionId))[0]?.planId ?? null;
  }

  async planIdForTask(_principalId: string, _sessionId: string, taskId: string): Promise<string | null> {
    const hit = [...this.facts].reverse().find((fact) => fact.taskId === taskId);
    return hit?.planId ?? null;
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
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    calls,
    run: async (args) => {
      calls.push({ request: args.request, ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.stepLabel ? { stepLabel: args.stepLabel } : {}) });
      const handler = script[Math.min(calls.length - 1, script.length - 1)]!;
      return handler({ request: args.request, ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.stepLabel ? { stepLabel: args.stepLabel } : {}) });
    },
  };
}

const DONE = (taskId: string, text: string): SubagentTaskResult => ({ taskId, text, execution: { planId: 'plan_platform', version: 1, calls: 1 } });

/** 侦测宿主计划模式熔断事件（console.info 上是 JSON 行，写法同 tests/e2e 的 capturePlanLog）。 */
function capturePlanLog() {
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['event'] === 'plan_steps_circuit_break') events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
}

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

  // P6.10（业务 skill 每回合进系统提示词）随业务 skill 注入链整条删除退役（Track D）：
  // 静态编排知识不再注入提示词，取而代之的是 agent.md 常驻角色 + 技能按需读取
  // （read_skill 工具桥）。新形态的装配验收住 system-prompt.test.ts 与
  // apps/server/main-profile-wiring.test.ts。

  it('P6.11 两个未完成计划形状撞车：宿主不猜，发编号消歧问题且不委派', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([() => DONE('task_a', '甲第一步成功。'), () => DONE('task_b', '丁第一步成功。')]);
    // 第一回合：计划 A 的第 1 步（1/3，done，计划保持打开）
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象甲', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p611_a' }), '逐个核对甲乙丙');
    // 第二回合：计划 B 的第 1 步（同样 1/3）
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象丁', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p611_b' }), '再核对丁戊己');

    // 第三回合：第 2/3 步与两个计划都接得上 → 消歧问题，不委派
    const task2 = subagent([() => DONE('task_x', '不应被调用。')]);
    const reply = await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：继续核对' }]),
      sessions: new FakeSessionRepo(), platformTask: task2, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p611_ask' }), '继续');

    expect(reply.text).toContain('【任务消歧】');
    expect(reply.text).toContain('1. 查对象丁（1/3 步已完成）');
    expect(reply.text).toContain('2. 查对象甲（1/3 步已完成）');
    expect(reply.text).toContain('回复其他内容将按新请求处理');
    // 消歧回合零委派、零新事实（两个计划都保持各自的 1/3）
    expect(task2.calls).toHaveLength(0);
    expect(taskPlans.facts).toHaveLength(4);
  });

  it('P6.12 紧跟消歧问题的编号回复绑定所选计划，事实记在正确的 planId 上', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([() => DONE('task_a', '甲第一步成功。'), () => DONE('task_b', '丁第一步成功。')]);
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象甲', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p612_a' }), '逐个核对甲乙丙');
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象丁', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p612_b' }), '再核对丁戊己');

    // 消歧问题（同 P6.11），然后用户回复「2」（= 较旧的对象甲计划）
    const asked = await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：继续核对' }]),
      sessions: new FakeSessionRepo(), platformTask: subagent([() => DONE('task_x', '不应被调用。')]), taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p612_ask' }), '继续');
    expect(asked.text).toContain('【任务消歧】');

    const task3 = subagent([() => DONE('task_a2', '对象甲第二步成功。')]);
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：查对象甲' }]),
      sessions: new FakeSessionRepo(), platformTask: task3, taskPlans,
      conversationLog: fakeConversationLog([
        { kind: 'assistant_message', content: asked.text },
        { kind: 'user_message', content: '2' },
      ]),
    }).handleTurn(makeCtx({ requestId: 'req_p612_pick' }), '2');

    // 编号 2 = 对象甲的计划：第 2 步事实记在 plan_req_p612_a 下，对象丁的计划原封不动
    expect(task3.calls).toHaveLength(1);
    const started = taskPlans.facts.filter((fact) => fact.status === 'started' && fact.stepIndex === 2);
    expect(started).toHaveLength(1);
    expect(started[0]?.planId).toBe('plan_req_p612_a');
    expect(started[0]?.request).toBe('查对象甲');
    expect(taskPlans.facts.filter((fact) => fact.planId === 'plan_req_p612_b')).toHaveLength(2);
  });

  it('P6.13 消歧问题后插入别的回合，编号回复失效：不绑定，多候选仍重新出题', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([() => DONE('task_a', '甲第一步成功。'), () => DONE('task_b', '丁第一步成功。')]);
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象甲', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p613_a' }), '逐个核对甲乙丙');
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象丁', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p613_b' }), '再核对丁戊己');

    // 上一条 assistant 不是消歧问题（中间插过回合/问题已过期）：编号"1"不产生绑定
    const task2 = subagent([() => DONE('task_x', '不应被调用。')]);
    const stale = await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：继续核对' }]),
      sessions: new FakeSessionRepo(), platformTask: task2, taskPlans,
      conversationLog: fakeConversationLog([
        { kind: 'assistant_message', content: '别的回复文本。' },
        { kind: 'user_message', content: '1' },
      ]),
    }).handleTurn(makeCtx({ requestId: 'req_p613_stale' }), '1');

    // 无依据时宿主不猜：再次出题，仍然零委派、零新事实
    expect(stale.text).toContain('【任务消歧】');
    expect(task2.calls).toHaveLength(0);
    expect(taskPlans.facts).toHaveLength(4);
  });

  it('P6.14 显式 continueTaskId 反查计划：续跑旧任务绑旧计划，不被最近的计划抢走', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([() => DONE('task_a', '甲第一步成功。'), () => DONE('task_b', '丁第一步成功。')]);
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象甲', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p614_a' }), '逐个核对甲乙丙');
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象丁', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p614_b' }), '再核对丁戊己');

    // 模型显式续跑对象甲的子任务：计划归属按 taskId 反查（对象甲），即便对象丁的计划更"近"
    const task2 = subagent([() => DONE('task_a', '甲第二步成功。')]);
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：查对象乙', continueTaskId: 'task_a' }]),
      sessions: new FakeSessionRepo(), platformTask: task2, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p614_pick' }), '继续核对甲乙丙');

    const started = taskPlans.facts.filter((fact) => fact.status === 'started' && fact.stepIndex === 2);
    expect(started).toHaveLength(1);
    expect(started[0]?.planId).toBe('plan_req_p614_a');
  });

  it('P6.15 多个未完成计划但形状唯一接得上：照旧自动续跑，不出题', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const task = subagent([
      () => DONE('task_a', '甲第一步成功。'),
      () => DONE('task_b', '两步任务第一步成功。'),
      () => DONE('task_a2', '甲第二步成功。'),
    ]);
    // 计划 A：3 步只完成 1 步；计划 B：2 步只完成 1 步（更近）
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/3步：查对象甲', text: '第 1 步完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p615_a' }), '逐个核对甲乙丙');
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第1/2步：查对象丁', text: '完成。' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p615_b' }), '核对丁戊');

    // 第 2/3 步只与计划 A 接得上（B 总步数不同）→ 自动续跑 A，不打扰用户
    await createTaxAgentRuntime({
      driver: planDriver([{ kind: 'delegate', request: '第2/3步：查对象乙' }]),
      sessions: new FakeSessionRepo(), platformTask: task, taskPlans,
    }).handleTurn(makeCtx({ requestId: 'req_p615_pick' }), '继续核对甲乙丙');

    const started = taskPlans.facts.filter((fact) => fact.status === 'started' && fact.stepIndex === 2);
    expect(started).toHaveLength(1);
    expect(started[0]?.planId).toBe('plan_req_p615_a');
  });

  it('P6.16 连续 3 步零执行熔断：第 3 步后停止派发，回复只陈述计划事实', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const log = capturePlanLog();
    try {
      // 4 步拆解，替身每步都零执行（既无 execution 也无 needs——worker 空转的形状）
      const task = subagent([() => ({ taskId: 'task_break', text: '这一步没有产生任何平台执行。' })]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/4步：查对象甲' },
          { kind: 'delegate', request: '第2/4步：查对象乙', continueTaskId: 'task_break' },
          { kind: 'delegate', request: '第3/4步：查对象丙', continueTaskId: 'task_break' },
          { kind: 'delegate', request: '第4/4步：查对象丁', continueTaskId: 'task_break' },
          { kind: 'conversation', text: '主 Agent 汇总：不应外发。' },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
        taskPlans,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_break' }), '逐个核对甲乙丙丁');

      // 第 3 步后熔断：第 4 步没有再派，模型的汇总文本被宿主的熔断汇总顶上
      expect(task.calls).toHaveLength(3);
      expect(reply.text).toContain('第 1/4 步');
      expect(reply.text).toContain('连续 3 步');
      expect(reply.text).toContain('没有产生任何平台执行');
      expect(reply.text).toContain('没有执行成功的步骤');
      expect(reply.text).not.toContain('不应外发');
      // 计划事实照旧落库：3 个 started + 3 个 failed（熔断不篡改投影）
      expect(taskPlans.facts.filter((fact) => fact.status === 'started')).toHaveLength(3);
      expect(taskPlans.facts.filter((fact) => fact.status === 'failed')).toHaveLength(3);
      // 熔断事件：requestId/planId/连续失败数/已完成数
      expect(log.events).toHaveLength(1);
      expect(log.events[0]).toMatchObject({
        event: 'plan_steps_circuit_break',
        requestId: 'req_break',
        planId: 'plan_req_break',
        consecutiveZeroExecSteps: 3,
        completedSteps: 0,
        totalSteps: 4,
        stoppedAt: '3/4',
      });
    } finally {
      log.restore();
    }
  });

  it('P6.17 中间有成功步骤时熔断汇总说清哪些步成了、从哪步起停', async () => {
    const log = capturePlanLog();
    try {
      const task = subagent([
        () => DONE('task_part', '第一步真执行了。'),
        () => ({ taskId: 'task_part', text: '这一步没有产生任何平台执行。' }),
      ]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/4步：查对象甲' },
          { kind: 'delegate', request: '第2/4步：查对象乙', continueTaskId: 'task_part' },
          { kind: 'delegate', request: '第3/4步：查对象丙', continueTaskId: 'task_part' },
          { kind: 'delegate', request: '第4/4步：查对象丁', continueTaskId: 'task_part' },
          { kind: 'conversation', text: '主 Agent 汇总：不应外发。' },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_part' }), '逐个核对甲乙丙丁');

      expect(task.calls).toHaveLength(4);
      expect(reply.text).toContain('已执行成功的步骤：第 1/4 步');
      expect(reply.text).toContain('第 2/4 步」起连续 3 步');
      expect(log.events[0]).toMatchObject({ completedSteps: 1, consecutiveZeroExecSteps: 3 });
    } finally {
      log.restore();
    }
  });

  it('P6.18 中间一步有执行就重置计数：不熔断，汇总由模型产出', async () => {
    const log = capturePlanLog();
    try {
      const task = subagent([
        () => ({ taskId: 'task_reset', text: '第一步空转。' }),
        () => DONE('task_reset', '第二步真执行了。'),
        () => ({ taskId: 'task_reset', text: '第三步空转。' }),
        () => ({ taskId: 'task_reset', text: '第四步空转。' }),
      ]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/4步：查对象甲' },
          { kind: 'delegate', request: '第2/4步：查对象乙', continueTaskId: 'task_reset' },
          { kind: 'delegate', request: '第3/4步：查对象丙', continueTaskId: 'task_reset' },
          { kind: 'delegate', request: '第4/4步：查对象丁', continueTaskId: 'task_reset' },
          { kind: 'conversation', text: '汇总：第二步查到了，其余步骤未执行。' },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_reset' }), '逐个核对甲乙丙丁');

      // 第 2 步的执行把连续计数清零：后面的两步零执行只到 2，够不到阈值
      expect(task.calls).toHaveLength(4);
      expect(reply.text).toBe('汇总：第二步查到了，其余步骤未执行。');
      expect(log.events).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  it('P6.19 needs 交还也重置计数：缺信息步骤不算空转，不熔断', async () => {
    const taskPlans = new FakeTaskPlanRepo();
    const log = capturePlanLog();
    try {
      const task = subagent([
        () => ({ taskId: 'task_needs', text: '第一步空转。' }),
        () => ({ taskId: 'task_needs', text: '平台要求必须显式给出范围。', needs: { missing: ['范围'], reason: '平台要求必须显式给出范围' } }),
        () => ({ taskId: 'task_needs', text: '第三步空转。' }),
        () => ({ taskId: 'task_needs', text: '第四步空转。' }),
      ]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/4步：查对象甲' },
          { kind: 'delegate', request: '第2/4步：查对象乙', continueTaskId: 'task_needs' },
          { kind: 'delegate', request: '第3/4步：查对象丙', continueTaskId: 'task_needs' },
          { kind: 'delegate', request: '第4/4步：查对象丁', continueTaskId: 'task_needs' },
          { kind: 'conversation', text: '汇总：第二步缺范围，其余步骤未执行。' },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
        taskPlans,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_needs_reset' }), '逐个核对甲乙丙丁');

      expect(task.calls).toHaveLength(4);
      expect(reply.text).toBe('汇总：第二步缺范围，其余步骤未执行。');
      expect(log.events).toHaveLength(0);
      // needs 步骤的事实终态仍是 needs（熔断记账不改投影语义）
      expect(taskPlans.facts.filter((fact) => fact.stepIndex === 2).map((fact) => fact.status)).toEqual(['started', 'needs']);
    } finally {
      log.restore();
    }
  });
});

/** 侦测任意宿主事件（console.info 上是 JSON 行）。 */
function captureHostEvents(names: readonly string[]) {
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed['event'] === 'string' && names.includes(parsed['event'])) events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
}

/**
 * 复读形状（F4，2026-09 真实平台实测）：两步计划、两步都零执行无 needs，worker 把方案
 * 当文本打印；模型最后把上一步的工具结果原样当回复。那段 JSON 是宿主与模型之间的内部
 * 协议材料（任务编号、「不要转述给用户」的 next 提示），绝不能外发。
 */
const SERIALIZED_STEP_TOOL_RESULT = '{"recorded":"delegate","step":"第 1/2 步","stepIndex":1,"totalSteps":2,"taskId":"task_replay","executed":false,"text":"这一步没有发起任何平台调用。","outcome":"no_execution","next":"继续申报下一步：request 以「第2/2步：」开头，continueTaskId 填 task_replay（不要转述给用户）。任一步失败都不阻塞后续步骤。"}';

describe('计划模式：模型复读工具结果时的外发兜底', () => {
  it('P6.20 复读协议 JSON 不外发：宿主用步骤事实汇总顶上，并记守夜事件', async () => {
    const log = captureHostEvents(['plan_steps_relayed_fallback', 'plan_steps_relayed']);
    try {
      const task = subagent([() => ({ taskId: 'task_replay', text: '这一步没有发起任何平台调用。' })]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/2步：查对象甲' },
          { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_replay' },
          // 模型停在工具结果上没再说话：把协议 JSON 原样当回复
          { kind: 'conversation', text: SERIALIZED_STEP_TOOL_RESULT },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_replay' }), '核对甲乙');

      // 两步都派了，也都零执行
      expect(task.calls).toHaveLength(2);
      // 回复只说步骤事实与下一步：协议材料一个字都不外发
      expect(reply.text).toContain('本轮拆解的进度如下');
      expect(reply.text).toContain('本次拆解没有执行成功的步骤');
      expect(reply.text).toContain('没有产生平台执行的步骤：第 1/2 步、第 2/2 步');
      expect(reply.text).toContain('可以回复“继续”重跑未完成的步骤');
      expect(reply.text).not.toContain('recorded');
      expect(reply.text).not.toContain('task_replay');
      expect(reply.text).not.toContain('continueTaskId');
      expect(reply.text).not.toContain('不要转述给用户');
      expect(reply.text).not.toContain('"step"');
      // 守夜事件：复读被兜底截住（不是普通的计划汇总放行）
      expect(log.events).toHaveLength(1);
      expect(log.events[0]).toMatchObject({
        event: 'plan_steps_relayed_fallback',
        requestId: 'req_replay',
        reason: 'serialized_tool_result',
        planSteps: 2,
        dispatchedSteps: 2,
      });
    } finally {
      log.restore();
    }
  });

  it('P6.21 复读但有 needs 可转达时优先转达"缺什么"，仍不外发协议 JSON', async () => {
    const log = captureHostEvents(['plan_steps_relayed_fallback']);
    try {
      const task = subagent([
        () => ({ taskId: 'task_replay_needs', text: '平台要求必须显式给出范围。', needs: { missing: ['范围'], reason: '平台要求必须显式给出范围', suggestion: '请告诉我要查的范围' } }),
      ]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/2步：查对象甲' },
          { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_replay_needs' },
          { kind: 'conversation', text: SERIALIZED_STEP_TOOL_RESULT },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_replay_needs' }), '核对甲乙');

      expect(reply.text).toContain('还缺少：范围');
      expect(reply.text).toContain('建议提供：请告诉我要查的范围');
      expect(reply.text).not.toContain('recorded');
      expect(reply.text).not.toContain('task_replay_needs');
      expect(log.events).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  it('P6.22 模型自己产出诚实汇总时仍走原路：不被兜底改写', async () => {
    const log = captureHostEvents(['plan_steps_relayed_fallback']);
    try {
      const task = subagent([() => ({ taskId: 'task_honest', text: '这一步没有发起任何平台调用。' })]);
      const runtime = createTaxAgentRuntime({
        driver: planDriver([
          { kind: 'delegate', request: '第1/2步：查对象甲' },
          { kind: 'delegate', request: '第2/2步：查对象乙', continueTaskId: 'task_honest' },
          { kind: 'conversation', text: '两步都没能执行，请补充查询范围后我重跑。' },
        ]),
        sessions: new FakeSessionRepo(),
        platformTask: task,
      });

      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_honest' }), '核对甲乙');

      expect(reply.text).toBe('两步都没能执行，请补充查询范围后我重跑。');
      // 没有复读就没有兜底事件
      expect(log.events).toHaveLength(0);
    } finally {
      log.restore();
    }
  });
});

/** 内存版 Conversation Log：只支撑消歧匹配需要的 list 语义（升序返回）。 */
function fakeConversationLog(events: Array<{ kind: 'user_message' | 'assistant_message'; content: string }>): Pick<import('@fshine/contracts').ConversationLogRepo, 'append' | 'list' | 'search'> {
  return {
    append: async () => {},
    list: async () => events.map((event, index) => ({
      eventId: `e_${index}`,
      principalId: 'wecom:user_a',
      sessionId: 'sess_plan',
      kind: event.kind,
      content: event.content,
      createdAt: new Date(Date.UTC(2026, 8, 26, index)).toISOString(),
    })),
    search: async () => [],
  };
}

/** 记录驱动输入，便于断言系统提示词等宿主侧注入。 */
function recordingDriver(script: ScriptedTurnStep[]) {
  const base = ScriptedTurnDriver(script);
  return {
    driver: {
      run: async (input: TurnDriverInput): Promise<TurnDriverResult> => base.run(input),
    } as TurnDriver,
  };
}
