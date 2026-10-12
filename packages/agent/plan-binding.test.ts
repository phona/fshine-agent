import { describe, expect, it } from 'vitest';
import type { ConversationEventRecord, ConversationLogRepo, TaskPlanRepo, TaskPlanSummary, TrustedContext } from '@fshine/contracts';
import {
  PLAN_DISAMBIGUATION_PREFIX,
  fitsPlanShape,
  matchPlanDisambiguationReply,
  planChoiceLabel,
  renderDisambiguationQuestion,
  resolvePlanBinding,
  type PlanDisambiguationRepos,
} from './src/plan-binding';
import type { PlanStepLabel } from './src/plan-steps';

/**
 * plan-binding 模块的单测（方案 2 分批 2b · 步 4，见 docs/change-safety.md §3）。
 *
 * R3：**不起 driver harness**——只 import 被测模块 + 纯数据 + 内存假 repo，不出现
 * createTaxAgentRuntime。这些用例对应原先只能靠 runtime.test.ts P6.11–P6.15 与
 * e2e turn-loop-disambiguation 9.1/9.2 间接覆盖的行为（要构造整个 driver harness
 * 才碰得到一次计划绑定）；抽出来后直测。
 *
 * C31 的五条优先级：① 同回合已定（调用点短路，见下方 bindLikeRuntime 的说明）>
 * ② continueTaskId 按 taskId 反查 > ③ 用户消歧选定 > ④ 形状判定（总步数一致且步号
 * 接得上的候选恰一个）> 多候选无依据 → 出编号消歧问题。
 */

function step(overrides: Partial<PlanStepLabel> = {}): PlanStepLabel {
  return { stepIndex: 2, totalSteps: 3, label: '第 2/3 步', request: '查对象乙', ...overrides };
}

function plan(overrides: Partial<TaskPlanSummary> = {}): TaskPlanSummary {
  return {
    planId: 'plan_a',
    totalSteps: 3,
    maxRecordedStep: 1,
    started: 1,
    done: 1,
    failed: 0,
    needs: 0,
    firstRequest: '查对象甲',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

function ctx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_pb',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001'],
    sessionId: 'sess_pb',
    ...overrides,
  };
}

/** 反查替身：记录被问过的 taskId，返回调用方给定的答案（约定不抛）。 */
function planIdForTask(answer: string | null) {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (taskId: string): Promise<string | null> => {
      asked.push(taskId);
      return answer;
    },
  };
}

/** 内存假 repo：只实现本模块用到的两个只读入口。 */
class FakePlanRepos implements PlanDisambiguationRepos {
  constructor(
    private readonly open: readonly TaskPlanSummary[],
    private readonly events: readonly ConversationEventRecord[] = [],
  ) {}

  taskPlans: Pick<TaskPlanRepo, 'openPlans'> = {
    openPlans: async () => [...this.open],
  };

  conversationLog: Pick<ConversationLogRepo, 'list'> = {
    list: async () => [...this.events],
  };
}

function assistantEvent(content: string, index = 0): ConversationEventRecord {
  return {
    eventId: `e_${index}`,
    principalId: 'wecom:user_a',
    sessionId: 'sess_pb',
    kind: 'assistant_message',
    content,
    createdAt: new Date(Date.UTC(2026, 9, 12, index)).toISOString(),
  };
}

/**
 * runtime.ts 调用点的最小镜像（① 短路 + resolvePlanBinding + 出题映射）。
 *
 * 它**不是**第二份实现：判定全在 resolvePlanBinding 里，这里只重复调用点那三行
 * （先看同回合是否已定、再判定、消歧结果映射成"要出题"）。存在的唯一理由是 R3 不许
 * 起 driver harness——① 的完整行为（同回合多步共享一个 planId、归属日志只记一次）
 * 仍由 plan-mode.test.ts P6.1 / P6.12 与 e2e turn-loop-disambiguation 9.1 覆盖。
 */
async function bindLikeRuntime(
  state: { decidedPlanId: string | null; preferredPlanId: string | null },
  intent: { continueTaskId?: string },
  open: readonly TaskPlanSummary[],
  requestId = 'req_pb',
): Promise<{ planId: string } | { ask: readonly TaskPlanSummary[] }> {
  if (state.decidedPlanId) return { planId: state.decidedPlanId };
  const binding = await resolvePlanBinding({
    openPlans: open,
    preferredPlanId: state.preferredPlanId,
    ...(intent.continueTaskId ? { taskId: intent.continueTaskId } : {}),
    planIdForTask: async () => null,
    requestId,
  }, step());
  return 'disambiguate' in binding ? { ask: binding.disambiguate } : { planId: binding.planId };
}

describe('fitsPlanShape：形状判定（总步数一致且步号接得上）', () => {
  it('总步数一致且申报步号大于已留存步号 → 接得上', () => {
    expect(fitsPlanShape(plan({ totalSteps: 3, maxRecordedStep: 1 }), step({ stepIndex: 2, totalSteps: 3 }))).toBe(true);
  });

  it('总步数不同 → 不是同一个拆解', () => {
    expect(fitsPlanShape(plan({ totalSteps: 2, maxRecordedStep: 1 }), step({ stepIndex: 2, totalSteps: 3 }))).toBe(false);
  });

  it('申报步号没有越过已留存步号 → 接不上（回头步/重复步）', () => {
    expect(fitsPlanShape(plan({ totalSteps: 3, maxRecordedStep: 2 }), step({ stepIndex: 2, totalSteps: 3 }))).toBe(false);
    expect(fitsPlanShape(plan({ totalSteps: 3, maxRecordedStep: 2 }), step({ stepIndex: 1, totalSteps: 3 }))).toBe(false);
  });
});

describe('resolvePlanBinding：C31 优先级', () => {
  it('① 同回合已定：本回合早前绑定的计划直接复用，不再判定也不出题', async () => {
    // 两个候选都接得上（否则会出题），但同回合已定 → 不看不判
    const open = [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })];
    await expect(bindLikeRuntime({ decidedPlanId: 'plan_a', preferredPlanId: null }, {}, open))
      .resolves.toEqual({ planId: 'plan_a' });
  });

  it('② continueTaskId 反查优先于形状与消歧选定：绑反查到的计划', async () => {
    const byTask = planIdForTask('plan_old');
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_old', maxRecordedStep: 1 }), plan({ planId: 'plan_new' })],
      preferredPlanId: 'plan_new',
      taskId: 'task_1',
      planIdForTask: byTask.lookup,
      requestId: 'req_pb',
    }, step());
    expect(byTask.asked).toEqual(['task_1']);
    expect(binding).toEqual({ planId: 'plan_old', resumed: true });
  });

  it('② 反查不到（任务没有计划事实）：新开计划，不落回形状猜测', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a' })],
      taskId: 'task_orphan',
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_req_pb', resumed: false });
  });

  it('② 反查到的计划已不在候选里（已关闭）：同样新开，不绑一个打不开的计划', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a' })],
      taskId: 'task_1',
      planIdForTask: async () => 'plan_gone',
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_req_pb', resumed: false });
  });

  it('③ 用户消歧选定：形状一致才绑定，且优先于形状判定', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })],
      preferredPlanId: 'plan_b',
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_b', resumed: true });
  });

  it('③ 消歧选定与申报形状不一致：新开计划，绝不静默改绑其他未完成任务', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })],
      preferredPlanId: 'plan_b',
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step({ totalSteps: 4 }));
    expect(binding).toEqual({ planId: 'plan_req_pb', resumed: false });
  });

  it('③ 选定的计划已不在候选里：新开计划', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a' })],
      preferredPlanId: 'plan_missing',
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_req_pb', resumed: false });
  });

  it('④ 形状判定：恰一个候选接得上 → 自动续跑，不出题', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [plan({ planId: 'plan_a', totalSteps: 3, maxRecordedStep: 1 }), plan({ planId: 'plan_b', totalSteps: 2, maxRecordedStep: 1 })],
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step({ stepIndex: 2, totalSteps: 3 }));
    expect(binding).toEqual({ planId: 'plan_a', resumed: true });
  });

  it('④ 无候选：新开计划', async () => {
    const binding = await resolvePlanBinding({
      openPlans: [],
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_req_pb', resumed: false });
  });

  it('多候选且无其他依据：不出猜，交回消歧出题', async () => {
    const open = [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })];
    const binding = await resolvePlanBinding({
      openPlans: open,
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ disambiguate: open });
  });

  it('多候选但 continueTaskId 有依据：不出题（② 优先于出题条件）', async () => {
    const open = [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })];
    const binding = await resolvePlanBinding({
      openPlans: open,
      taskId: 'task_1',
      planIdForTask: async () => 'plan_b',
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_b', resumed: true });
  });

  it('多候选但消歧已选定：不出题（③ 优先于出题条件）', async () => {
    const open = [plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })];
    const binding = await resolvePlanBinding({
      openPlans: open,
      preferredPlanId: 'plan_a',
      planIdForTask: async () => null,
      requestId: 'req_pb',
    }, step());
    expect(binding).toEqual({ planId: 'plan_a', resumed: true });
  });

  it('反查能力从不被调用时（无 continueTaskId）不去问存储', async () => {
    const byTask = planIdForTask('plan_a');
    await resolvePlanBinding({
      openPlans: [plan()],
      planIdForTask: byTask.lookup,
      requestId: 'req_pb',
    }, step());
    expect(byTask.asked).toEqual([]);
  });
});

describe('renderDisambiguationQuestion / planChoiceLabel：选项文本机械生成', () => {
  it('固定前缀 + 编号选项 + 收尾提示', () => {
    const text = renderDisambiguationQuestion([
      plan({ planId: 'plan_a', firstRequest: '查对象甲', done: 1, totalSteps: 3 }),
      plan({ planId: 'plan_b', firstRequest: '查对象丁', done: 0, totalSteps: 3 }),
    ]);
    expect(text).toBe([
      '【任务消歧】当前有多个未完成任务，请回复编号继续对应的那一个：',
      '1. 查对象甲（1/3 步已完成）',
      '2. 查对象丁（0/3 步已完成）',
      '回复其他内容将按新请求处理。',
    ].join('\n'));
  });

  it('标签超过 60 字截断（截断哨兵是省略号）', () => {
    const long = '甲'.repeat(80);
    expect(planChoiceLabel(plan({ firstRequest: long, done: 2, totalSteps: 5 })))
      .toBe(`${'甲'.repeat(59)}…（2/5 步已完成）`);
  });

  it('前缀常量就是问题首行（下一回合靠它认出"上一条是消歧问题"）', () => {
    expect(renderDisambiguationQuestion([plan()]).startsWith(PLAN_DISAMBIGUATION_PREFIX)).toBe(true);
  });
});

describe('matchPlanDisambiguationReply：编号只有紧跟问题才算数', () => {
  const question = renderDisambiguationQuestion([plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })]);

  it('紧跟消歧问题的纯编号回复：绑定所选计划', async () => {
    const repos = new FakePlanRepos([plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })], [
      assistantEvent(question, 0),
      { ...assistantEvent('', 1), kind: 'user_message', content: '2' },
    ]);
    await expect(matchPlanDisambiguationReply(repos, ctx(), '2')).resolves.toEqual({
      planId: 'plan_b',
      label: planChoiceLabel(plan({ planId: 'plan_b' })),
    });
  });

  it('中间插过任何回合即失效：上一条 assistant 不是消歧问题 → 不绑定', async () => {
    const repos = new FakePlanRepos([plan({ planId: 'plan_a' }), plan({ planId: 'plan_b' })], [
      assistantEvent(question, 0),
      assistantEvent('别的回复文本。', 1),
      { ...assistantEvent('', 2), kind: 'user_message', content: '2' },
    ]);
    await expect(matchPlanDisambiguationReply(repos, ctx(), '2')).resolves.toBeNull();
  });

  it('非纯编号回复（带说明文字）不绑定', async () => {
    const repos = new FakePlanRepos([plan({ planId: 'plan_a' })], [assistantEvent(question, 0)]);
    await expect(matchPlanDisambiguationReply(repos, ctx(), '选第 1 个')).resolves.toBeNull();
  });

  it('编号越界不绑定', async () => {
    const repos = new FakePlanRepos([plan({ planId: 'plan_a' })], [assistantEvent(question, 0)]);
    await expect(matchPlanDisambiguationReply(repos, ctx(), '9')).resolves.toBeNull();
  });

  it('候选已变化（越界的那一个没了）也不绑定', async () => {
    const repos = new FakePlanRepos([plan({ planId: 'plan_a' })], [assistantEvent(question, 0)]);
    await expect(matchPlanDisambiguationReply(repos, ctx(), '2')).resolves.toBeNull();
  });

  it('存储未注入 / 读不到：一律 null，消息按普通回合进模型', async () => {
    await expect(matchPlanDisambiguationReply({}, ctx(), '1')).resolves.toBeNull();
    await expect(matchPlanDisambiguationReply({ taskPlans: { openPlans: async () => [plan()] } }, ctx(), '1')).resolves.toBeNull();
    await expect(matchPlanDisambiguationReply({ conversationLog: { list: async () => [assistantEvent(question)] } }, ctx(), '1')).resolves.toBeNull();
  });

  it('存储抛错不失败回合：降级成"无绑定"', async () => {
    const repos: PlanDisambiguationRepos = {
      taskPlans: { openPlans: async () => { throw new Error('store down'); } },
      conversationLog: { list: async () => [assistantEvent(question)] },
    };
    await expect(matchPlanDisambiguationReply(repos, ctx(), '1')).resolves.toBeNull();
  });
});
