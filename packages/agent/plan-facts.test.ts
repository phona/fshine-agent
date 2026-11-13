import { describe, expect, it, vi } from 'vitest';
import type { TaskPlanProjection, TaskPlanRepo, TaskPlanStepFact, TaskPlanSummary, TrustedContext } from '@fshine/contracts';
import type { SubagentTaskResult } from './src/context';
import type { PlanStepLabel } from './src/plan-steps';
import {
  createPlanFactWriter,
  planStepSummary,
  renderPlanCircuitBreak,
  renderPlanStepOutcomeLines,
  renderPlanStepsRelayFallback,
} from './src/plan-facts';

/**
 * plan-facts 模块的 golden（R1：搬移前钉住当前输出）。
 *
 * 这些函数是"事实进 → 文本/记录出"的确定性渲染：替身输入 → 断言完整输出字符串，
 * 不碰 driver harness（R3）。搬移进 src/plan-facts.ts 后，本文件只改 import 路径，
 * 断言一条不改。
 */

function step(overrides: Partial<PlanStepLabel> = {}): PlanStepLabel {
  return { stepIndex: 1, totalSteps: 3, label: '第 1/3 步', request: '查一下这个月的范围', ...overrides };
}

function result(overrides: Partial<SubagentTaskResult> = {}): SubagentTaskResult {
  return { taskId: 'task_1', text: '平台查完了。', ...overrides };
}

/** 内存版任务计划存储：只实现 append 语义，其余方法不参与本模块的断言。 */
class FakeTaskPlanRepo implements TaskPlanRepo {
  readonly facts: TaskPlanStepFact[] = [];
  failAppend = false;

  async append(fact: TaskPlanStepFact): Promise<void> {
    if (this.failAppend) throw new Error('append boom');
    this.facts.push(structuredClone(fact));
  }

  async project(): Promise<TaskPlanProjection | null> { return null; }
  async openPlans(): Promise<TaskPlanSummary[]> { return []; }
  async latestOpenPlan(): Promise<string | null> { return null; }
  async planIdForTask(): Promise<string | null> { return null; }
}

/**
 * 最小 ctx 替身（照 runtime.test.ts 的 makeCtx 写法）：写入器只从 ctx 取
 * principalId / sessionId / requestId 三个记账字段，不碰授权与回合钩子。
 */
function ctx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_plan',
    principalId: 'wecom:user_a',
    sessionId: 'sess_plan',
    ...overrides,
  };
}

describe('planStepSummary', () => {
  it('缺信息：列缺什么 + 确定性原因', () => {
    expect(planStepSummary(result({
      needs: { missing: ['查询范围'], reason: '平台要求必须指定范围' },
    }))).toBe('缺：查询范围；平台要求必须指定范围');
  });

  it('缺信息但 missing 为空：记（未指明）', () => {
    expect(planStepSummary(result({ needs: { missing: [], reason: '缺少必要信息' } })))
      .toBe('缺：（未指明）；缺少必要信息');
  });

  it('选择类澄清：只记码与候选数（候选名是数据，事实里不抄）', () => {
    expect(planStepSummary(result({
      clarification: { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰科技'], render: 'candidates' },
    }))).toBe('平台澄清：ACCOUNT_SET_AMBIGUOUS（候选 2 个）');
  });

  it('有执行痕迹：只记调用次数', () => {
    expect(planStepSummary(result({ execution: { planId: 'plan_req_plan', version: 1, calls: 2 } })))
      .toBe('已执行 2 次平台调用');
  });

  it('零执行：记未产生平台执行', () => {
    expect(planStepSummary(result())).toBe('未产生平台执行');
  });

  it('优先级：needs 高于 clarification / execution', () => {
    expect(planStepSummary(result({
      needs: { missing: ['查询范围'], reason: '平台要求必须指定范围' },
      clarification: { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰科技'], render: 'candidates' },
      execution: { planId: 'plan_req_plan', version: 1, calls: 2 },
    }))).toBe('缺：查询范围；平台要求必须指定范围');
    expect(planStepSummary(result({
      clarification: { code: 'ACCOUNT_SET_AMBIGUOUS', query: '幻辰', candidates: ['幻辰财税', '幻辰科技'], render: 'candidates' },
      execution: { planId: 'plan_req_plan', version: 1, calls: 2 },
    }))).toBe('平台澄清：ACCOUNT_SET_AMBIGUOUS（候选 2 个）');
  });
});

describe('renderPlanStepOutcomeLines', () => {
  it('没有任何步骤：明说没有执行成功的步骤', () => {
    expect(renderPlanStepOutcomeLines([])).toEqual(['本次拆解没有执行成功的步骤。']);
  });

  it('三类结局各有措辞，且按 done → needs → failed 定序', () => {
    expect(renderPlanStepOutcomeLines([
      { label: '第 3/3 步', outcome: 'failed' },
      { label: '第 1/3 步', outcome: 'done' },
      { label: '第 2/3 步', outcome: 'needs' },
    ])).toEqual([
      '已执行成功的步骤：第 1/3 步。',
      '缺信息未执行的步骤：第 2/3 步。',
      '没有产生平台执行的步骤：第 3/3 步。',
    ]);
  });

  it('同类多步用顿号相接', () => {
    expect(renderPlanStepOutcomeLines([
      { label: '第 1/3 步', outcome: 'done' },
      { label: '第 2/3 步', outcome: 'done' },
    ])).toEqual(['已执行成功的步骤：第 1/3 步、第 2/3 步。']);
  });

  it('只有失败步：仍先说没有执行成功的步骤', () => {
    expect(renderPlanStepOutcomeLines([
      { label: '第 1/2 步', outcome: 'failed' },
      { label: '第 2/2 步', outcome: 'failed' },
    ])).toEqual([
      '本次拆解没有执行成功的步骤。',
      '没有产生平台执行的步骤：第 1/2 步、第 2/2 步。',
    ]);
  });
});

describe('renderPlanCircuitBreak', () => {
  it('熔断汇总：连续失败的第一步 + 步骤事实 + 下一步', () => {
    expect(renderPlanCircuitBreak([
      { label: '第 1/3 步', outcome: 'done' },
      { label: '第 2/3 步', outcome: 'failed' },
      { label: '第 3/3 步', outcome: 'failed' },
    ], 2, 3)).toBe([
      '计划执行已停止：自「第 2/3 步」起连续 2 步没有产生任何平台执行（本次共 3 步），后续步骤不再派发。',
      '已执行成功的步骤：第 1/3 步。',
      '没有产生平台执行的步骤：第 2/3 步、第 3/3 步。',
      '可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。',
    ].join('\n'));
  });

  it('连续数超出已记录步数（索引越界）：首句退化成「上一步」', () => {
    expect(renderPlanCircuitBreak([{ label: '第 1/2 步', outcome: 'failed' }], 2, 2)).toBe([
      '计划执行已停止：自「上一步」起连续 2 步没有产生任何平台执行（本次共 2 步），后续步骤不再派发。',
      '本次拆解没有执行成功的步骤。',
      '没有产生平台执行的步骤：第 1/2 步。',
      '可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。',
    ].join('\n'));
  });
});

describe('renderPlanStepsRelayFallback', () => {
  it('复读兜底：只说进度，不说“已停止”（没有停止派发这个事实）', () => {
    expect(renderPlanStepsRelayFallback([
      { label: '第 1/2 步', outcome: 'done' },
      { label: '第 2/2 步', outcome: 'needs' },
    ])).toBe([
      '本轮拆解的进度如下：',
      '已执行成功的步骤：第 1/2 步。',
      '缺信息未执行的步骤：第 2/2 步。',
      '可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。',
    ].join('\n'));
  });
});

describe('createPlanFactWriter', () => {
  it('factId 组成 = planId:步号:状态:序号；字段透传，createdAt 是 ISO', async () => {
    const repo = new FakeTaskPlanRepo();
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });

    await appendPlanFact(ctx(), step(), 'plan_req_plan', 'started');

    expect(repo.facts).toHaveLength(1);
    const fact = repo.facts[0]!;
    expect(fact.factId).toBe('plan_req_plan:1:started:1');
    expect(fact.principalId).toBe('wecom:user_a');
    expect(fact.sessionId).toBe('sess_plan');
    expect(fact.planId).toBe('plan_req_plan');
    expect(fact.stepIndex).toBe(1);
    expect(fact.totalSteps).toBe(3);
    expect(fact.request).toBe('查一下这个月的范围');
    expect(fact.status).toBe('started');
    expect(fact.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // 没有 extra 时不挂 taskId / summary（不是空串占位）
    expect(fact.taskId).toBeUndefined();
    expect(fact.summary).toBeUndefined();
  });

  it('序号在同一个 writer 内唯一递增；新 writer 从零重新起算', async () => {
    const repo = new FakeTaskPlanRepo();
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });

    await appendPlanFact(ctx(), step(), 'plan_req_plan', 'started');
    await appendPlanFact(ctx(), step({ stepIndex: 2, label: '第 2/3 步' }), 'plan_req_plan', 'done', { taskId: 'task_2', summary: '已执行 1 次平台调用' });
    await appendPlanFact(ctx(), step({ stepIndex: 3, label: '第 3/3 步' }), 'plan_req_plan', 'failed');

    // factId 前缀（planId:步号:状态）逐条对应；序号段严格递增（不钉绝对值——
    // 计数器作用域是 writer 实例，跨 writer 不断言具体数）。
    expect(repo.facts.map((fact) => fact.factId.split(':').slice(0, -1).join(':'))).toEqual([
      'plan_req_plan:1:started',
      'plan_req_plan:2:done',
      'plan_req_plan:3:failed',
    ]);
    const seqOf = (factId: string): number => Number(factId.slice(factId.lastIndexOf(':') + 1));
    const seqs = repo.facts.map((fact) => seqOf(fact.factId));
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]!).toBeGreaterThan(seqs[1]!);
    expect(repo.facts[1]!.taskId).toBe('task_2');
    expect(repo.facts[1]!.summary).toBe('已执行 1 次平台调用');

    // 新 writer（= 新 runtime 实例）从零重新起算：首条序号与上一个 writer 的首条同代，
    // 不接龙——否则同一 writer 跨回合/跨计划的序号会无限增大，而旧行仍按旧序号寻址。
    const other = new FakeTaskPlanRepo();
    const restart = createPlanFactWriter({ taskPlans: other });
    await restart(ctx(), step(), 'plan_other', 'started');
    expect(seqOf(other.facts[0]!.factId)).toBe(seqs[0]);
  });

  it('principalId / sessionId / requestId 每次调用从 ctx 现取（不随 writer 绑定）', async () => {
    const repo = new FakeTaskPlanRepo();
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });

    await appendPlanFact(ctx(), step(), 'plan_req_plan', 'started');
    await appendPlanFact(ctx({ principalId: 'wecom:user_b', sessionId: 'sess_2', requestId: 'req_2' }), step({ stepIndex: 2, label: '第 2/3 步' }), 'plan_req_plan', 'done');

    expect(repo.facts.map((fact) => [fact.principalId, fact.sessionId])).toEqual([
      ['wecom:user_a', 'sess_plan'],
      ['wecom:user_b', 'sess_2'],
    ]);
  });

  it('extra 里的空串不落字段', async () => {
    const repo = new FakeTaskPlanRepo();
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });

    await appendPlanFact(ctx(), step(), 'plan_req_plan', 'failed', { taskId: '', summary: '' });

    expect(repo.facts[0]!.taskId).toBeUndefined();
    expect(repo.facts[0]!.summary).toBeUndefined();
  });

  it('request 截到 500、summary 截到 300；未超长的原样通过', async () => {
    const repo = new FakeTaskPlanRepo();
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });

    await appendPlanFact(ctx(), step({ request: 'x'.repeat(900) }), 'plan_req_plan', 'done', { summary: 'y'.repeat(1000) });
    await appendPlanFact(ctx(), step({ stepIndex: 2, request: '短请求' }), 'plan_req_plan', 'done', { summary: '短摘要' });

    expect(repo.facts[0]!.request).toHaveLength(500);
    expect(repo.facts[0]!.summary).toHaveLength(300);
    expect(repo.facts[1]!.request).toBe('短请求');
    expect(repo.facts[1]!.summary).toBe('短摘要');
  });

  it('存储未注入：安静跳过，不写任何东西', async () => {
    const appendPlanFact = createPlanFactWriter({ taskPlans: undefined });
    await expect(appendPlanFact(ctx(), step(), 'plan_req_plan', 'started')).resolves.toBeUndefined();
  });

  it('append 抛错不阻塞回合：只记日志，调用方照常拿到 resolve', async () => {
    const repo = new FakeTaskPlanRepo();
    repo.failAppend = true;
    const appendPlanFact = createPlanFactWriter({ taskPlans: repo });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(appendPlanFact(ctx(), step(), 'plan_req_plan', 'failed', { summary: '委派未完成' })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(logged.mock.calls[0]![0])) as Record<string, unknown>;
    expect(entry.event).toBe('task_plan_append_failed');
    expect(entry.requestId).toBe('req_plan');
    expect(entry.planId).toBe('plan_req_plan');
    expect(entry.stepIndex).toBe(1);
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('append boom');
    logged.mockRestore();
  });
});
