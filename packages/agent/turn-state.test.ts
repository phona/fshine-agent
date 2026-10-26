import { describe, expect, it } from 'vitest';
import type { SubagentTaskResult } from './src/context';
import type { PlanStepLabel } from './src/plan-steps';
import type { SelectionClarification } from './src/platform-contract';
import {
  accumulateDelegation,
  createTurnState,
  MAX_NEEDS_ROUNDS,
  MAX_PLAN_ZERO_EXEC_STEPS,
  noteNeedsRound,
  notePlanStepOutcome,
  noteZeroExecStep,
  stepOutcomeOf,
} from './src/turn-state';

/**
 * turn-state 模块的计数器/累积规则测试（方案 2 分批 2a，R3 + R5）。
 *
 * 这些规则原先散在 handleTurn 的闭包里，只能靠 runtime.test.ts 的整个 driver harness
 * 间接验证；抽成纯函数后用纯数据直接钉语义。本文件**不起 driver harness**——只 import
 * 被测模块 + 纯数据（R3：出现 createTaxAgentRuntime 即没抽干净）。
 *
 * 变异验证（R5）：MAX_NEEDS_ROUNDS 的"按步/全局"语义改错、MAX_PLAN_ZERO_EXEC_STEPS 的
 * +1/归零或豁免改错 → 本文件对应断言红。
 */

function step(overrides: Partial<PlanStepLabel> = {}): PlanStepLabel {
  return { stepIndex: 1, totalSteps: 3, label: '第 1/3 步', request: '查一下这个月的范围', ...overrides };
}

function delegated(overrides: Partial<SubagentTaskResult> = {}): SubagentTaskResult {
  return { taskId: 'task_1', text: '平台查完了。', ...overrides };
}

const EXECUTION = { planId: 'plan_req', version: 1, calls: 2 };
const AMBIGUOUS: SelectionClarification = {
  code: 'ACCOUNT_SET_AMBIGUOUS',
  query: '幻辰',
  candidates: ['幻辰财税', '幻辰科技'],
};

describe('createTurnState', () => {
  it('初值：所有计数器归零、所有事实为 null、preferredPlanId 由消歧选定给出', () => {
    const state = createTurnState({ planId: 'plan_chosen' });
    expect(state).toEqual({
      declared: false,
      intent: null,
      execution: null,
      pendingPlan: null,
      activatedPlan: null,
      delegationFailed: false,
      resourceExhausted: false,
      needsRounds: 0,
      lastNeeds: null,
      planSteps: 0,
      planId: null,
      needsStepIndex: null,
      planZeroExecSteps: 0,
      planStepOutcomes: [],
      clarification: null,
      clarificationReply: null,
      preferredPlanId: 'plan_chosen',
      backgroundStarted: false,
      backgroundTaskId: null,
      backgroundRunId: null,
      backgroundTaskState: null,
      backgroundReceiptText: null,
      resendRefs: [],
    });
  });

  it('非消歧回合（不传/传 null）：preferredPlanId 为 null', () => {
    expect(createTurnState().preferredPlanId).toBeNull();
    expect(createTurnState(null).preferredPlanId).toBeNull();
  });
});

describe('noteNeedsRound', () => {
  it('单步模式（stepIndex = null）按全局计：每一轮 +1，不记步号', () => {
    const state = createTurnState();

    expect(noteNeedsRound(state, null)).toBe(false);
    expect(state.needsRounds).toBe(1);
    expect(noteNeedsRound(state, null)).toBe(false);
    expect(state.needsRounds).toBe(2);
    // 第 3 轮达到上限
    expect(noteNeedsRound(state, null)).toBe(true);
    expect(state.needsRounds).toBe(MAX_NEEDS_ROUNDS);
    // 单步模式从不写 needsStepIndex（没有"步"可按）
    expect(state.needsStepIndex).toBeNull();
  });

  it('计划模式按步计：同一步反复缺信息才累加', () => {
    const state = createTurnState();

    expect(noteNeedsRound(state, 1)).toBe(false);
    expect(noteNeedsRound(state, 1)).toBe(false);
    expect(state).toMatchObject({ needsRounds: 2, needsStepIndex: 1 });
    expect(noteNeedsRound(state, 1)).toBe(true);
    expect(state.needsRounds).toBe(MAX_NEEDS_ROUNDS);
  });

  it('计划模式换步即重新计数（第 2 步的第 1 轮不是第 3 轮）', () => {
    const state = createTurnState();

    noteNeedsRound(state, 1);
    noteNeedsRound(state, 1);
    expect(noteNeedsRound(state, 1)).toBe(true);
    // 换到第 2 步：步号改写、计数从 1 重新起算，不再触顶
    expect(noteNeedsRound(state, 2)).toBe(false);
    expect(state).toMatchObject({ needsRounds: 1, needsStepIndex: 2 });
    noteNeedsRound(state, 2);
    expect(noteNeedsRound(state, 2)).toBe(true);
  });

  it('单步与计划模式不共享计数：单步累过的轮次不拖累计划第一步', () => {
    const state = createTurnState();

    noteNeedsRound(state, null);
    noteNeedsRound(state, null);
    expect(state.needsRounds).toBe(2);
    // 第一步第一次缺信息：计数重置为 1（不是 3）
    expect(noteNeedsRound(state, 1)).toBe(false);
    expect(state).toMatchObject({ needsRounds: 1, needsStepIndex: 1 });
  });

  it('未达上限时返回 false（调用方继续重派）', () => {
    const state = createTurnState();
    for (let round = 1; round < MAX_NEEDS_ROUNDS; round += 1) {
      expect(noteNeedsRound(state, null)).toBe(false);
    }
  });
});

describe('noteZeroExecStep', () => {
  it('零执行步 +1，合法一步（有执行或交还）归零', () => {
    const state = createTurnState();

    expect(noteZeroExecStep(state, { failed: true })).toBe(false);
    expect(state.planZeroExecSteps).toBe(1);
    expect(noteZeroExecStep(state, { failed: true })).toBe(false);
    expect(state.planZeroExecSteps).toBe(2);
    // 合法一步：重置连续计数
    expect(noteZeroExecStep(state, { failed: false })).toBe(false);
    expect(state.planZeroExecSteps).toBe(0);
  });

  it('连续零执行达到阈值 → 返回 true（调用方熔断、停止派发后续步骤）', () => {
    const state = createTurnState();

    for (let index = 1; index < MAX_PLAN_ZERO_EXEC_STEPS; index += 1) {
      expect(noteZeroExecStep(state, { failed: true })).toBe(false);
    }
    expect(noteZeroExecStep(state, { failed: true })).toBe(true);
    expect(state.planZeroExecSteps).toBe(MAX_PLAN_ZERO_EXEC_STEPS);
  });

  it('写关闭步骤不计入熔断：计数照记，但不返回 true', () => {
    const state = createTurnState();
    noteZeroExecStep(state, { failed: true });
    noteZeroExecStep(state, { failed: true });

    // 第 3 步是写关闭：那句话必须由宿主说给用户，不能被熔断汇总顶上
    expect(noteZeroExecStep(state, { failed: true, writeClosed: true })).toBe(false);
    expect(state.planZeroExecSteps).toBe(3);
    // 连续计数已满：下一步真失败时立刻熔断
    expect(noteZeroExecStep(state, { failed: true })).toBe(true);
  });

  it('停在用户确认门的步骤（pendingPlan）不计数也不熔断', () => {
    const state = createTurnState();
    noteZeroExecStep(state, { failed: true });
    noteZeroExecStep(state, { failed: true });

    expect(noteZeroExecStep(state, { failed: true, pendingPlan: true })).toBe(false);
    expect(state.planZeroExecSteps).toBe(2);
  });
});

describe('notePlanStepOutcome', () => {
  it('按 (label, outcome) 追加，保持派的顺序', () => {
    const state = createTurnState();

    notePlanStepOutcome(state, '第 1/3 步', 'done');
    notePlanStepOutcome(state, '第 2/3 步', 'needs');
    notePlanStepOutcome(state, '第 3/3 步', 'failed');

    expect(state.planStepOutcomes).toEqual([
      { label: '第 1/3 步', outcome: 'done' },
      { label: '第 2/3 步', outcome: 'needs' },
      { label: '第 3/3 步', outcome: 'failed' },
    ]);
  });
});

describe('stepOutcomeOf', () => {
  it('needs 交还 → needs', () => {
    expect(stepOutcomeOf(delegated({ needs: { missing: ['查询范围'], reason: '平台要求必须指定范围' } }))).toBe('needs');
  });

  it('选择类澄清 → needs（缺的是"选哪个"，与缺参数同族，不是失败）', () => {
    expect(stepOutcomeOf(delegated({ clarification: AMBIGUOUS }))).toBe('needs');
  });

  it('有执行痕迹 → done', () => {
    expect(stepOutcomeOf(delegated({ execution: EXECUTION }))).toBe('done');
  });

  it('两者皆无 → failed（worker 空转）', () => {
    expect(stepOutcomeOf(delegated())).toBe('failed');
  });

  it('优先级：needs / clarification 高于 execution', () => {
    expect(stepOutcomeOf(delegated({
      needs: { missing: ['查询范围'], reason: '平台要求必须指定范围' },
      execution: EXECUTION,
    }))).toBe('needs');
    expect(stepOutcomeOf(delegated({ clarification: AMBIGUOUS, execution: EXECUTION }))).toBe('needs');
  });
});

describe('accumulateDelegation', () => {
  it('计划模式 OR 累积：任一步的执行痕迹/激活计划/澄清都跨步保留', () => {
    const state = createTurnState();

    accumulateDelegation(state, step({ stepIndex: 1 }), delegated({ execution: EXECUTION }));
    expect(state).toMatchObject({ planSteps: 1, execution: EXECUTION });

    // 第二步零执行：第一步的执行痕迹仍在（汇总因此放行）
    accumulateDelegation(state, step({ stepIndex: 2 }), delegated());
    expect(state).toMatchObject({ planSteps: 2, execution: EXECUTION });

    // 第三步撞上歧义：本回合以澄清收口
    accumulateDelegation(state, step({ stepIndex: 3 }), delegated({ clarification: AMBIGUOUS }));
    expect(state).toMatchObject({ planSteps: 3, clarification: AMBIGUOUS });
  });

  it('计划模式：激活计划按"事实持续"累积，不因后续零执行步重置', () => {
    const state = createTurnState();
    const activated = { planId: 'plan_active', version: 2 };

    accumulateDelegation(state, step({ stepIndex: 1 }), delegated({ activatedPlan: activated }));
    accumulateDelegation(state, step({ stepIndex: 2 }), delegated());

    expect(state.activatedPlan).toEqual(activated);
  });

  it('单步模式覆盖：这一轮的结论只由这一次委派证明', () => {
    const state = createTurnState();

    accumulateDelegation(state, null, delegated({ execution: EXECUTION }));
    expect(state).toMatchObject({ planSteps: 0, execution: EXECUTION, clarification: null, activatedPlan: null });

    // 同回合第二次单步委派零执行：执行痕迹不继承上一次
    accumulateDelegation(state, null, delegated());
    expect(state).toMatchObject({ planSteps: 0, execution: null });
  });

  it('pendingPlan 随本轮结果，不跨步累积', () => {
    const state = createTurnState();
    const pending = { planId: 'plan_p', version: 1, taskId: 'task_1', decision: 'confirm', userText: '确认吗', evaluation: {} } as SubagentTaskResult['pendingPlan'];

    accumulateDelegation(state, step({ stepIndex: 1 }), delegated({ pendingPlan: pending }));
    expect(state.pendingPlan).toBe(pending);

    accumulateDelegation(state, step({ stepIndex: 2 }), delegated());
    expect(state.pendingPlan).toBeNull();
  });

  it('计划模式不因单步结果丢失已累积事实（与 OR 累积同一规则的两个方向）', () => {
    const state = createTurnState();

    accumulateDelegation(state, step({ stepIndex: 1 }), delegated({ execution: EXECUTION }));
    accumulateDelegation(state, step({ stepIndex: 2 }), delegated({ execution: { planId: 'plan_req', version: 1, calls: 5 } }));

    // 后一步的执行痕迹覆盖前一步（都是"本回合真跑过"的同一族事实）
    expect(state.execution).toEqual({ planId: 'plan_req', version: 1, calls: 5 });
  });
});
