import { describe, expect, it } from 'vitest';
import { messageTextFor } from './src/error-codes';
import {
  decideTurnExit,
  type TurnExitDecision,
  type TurnExitInput,
} from './src/turn-exit';
// 两个判据是 runtime 私有尺（turn-exit.ts 以参数注入它们，避免 runtime ← turn-exit 循环
// import）。这里用**真实实现**——导入判据不等于起 driver harness（R3 禁的是
// createTaxAgentRuntime 那一套替身），而入口校验的每一支都必须按真尺子钉形状。
import { hasFinancialFigure, usefulWorkerNote } from './src/runtime';

/**
 * turn-exit 模块的判定（方案 2 · 分批 3a，步 5；R3：不起 driver harness）。
 *
 * 出口校验是 handleTurn 尾部两段互相独立的门，今天只能靠 runtime.test.ts 的 F4.1–F4.4 与
 * e2e 间接覆盖（要构造整个 driver harness 才碰得到一次出口）。这里用纯数据直接钉住每一支
 * 的条件组合，尤其是"有执行但协议复读"这种第二段门的形状。
 */

const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');
const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');
const NEEDS = { missing: ['查询对象'], reason: '用户没有给出要查的对象', suggestion: '请告诉我要查哪个对象' };
const NEEDS_USER_TEXT = '还缺少：查询对象。\n原因：用户没有给出要查的对象\n建议提供：请告诉我要查哪个对象';
const STEP_OUTCOMES = [
  { label: '第 1/2 步', outcome: 'failed' as const },
  { label: '第 2/2 步', outcome: 'failed' as const },
];
const STEP_FALLBACK = [
  '本轮拆解的进度如下：',
  '本次拆解没有执行成功的步骤。',
  '没有产生平台执行的步骤：第 1/2 步、第 2/2 步。',
  '可以回复“继续”重跑未完成的步骤，或直接告诉我要调整的范围。',
].join('\n');
const PROTOCOL_REPLAY = '{"recorded":"delegate","step":"第 1/2 步","stepIndex":1,"totalSteps":2,"taskId":"task_1","executed":false,"text":"…","outcome":"no_execution","next":"继续申报下一步（不要转述给用户）"}';

/** 最小可用入参：单步 delegate、零执行、没有停在确认门、模型没说话。 */
function input(overrides: Partial<TurnExitInput> = {}): TurnExitInput {
  return {
    delegationFailed: false,
    execution: false,
    pendingPlan: false,
    resultPendingPlan: false,
    intentKind: 'delegate',
    backgroundStarted: false,
    backgroundTaskId: null,
    backgroundRunId: null,
    backgroundTaskState: null,
    backgroundReceiptText: null,
    needsLoop: false,
    planModeTurn: false,
    needsRounds: 0,
    planSteps: 0,
    planStepOutcomes: [],
    lastNeeds: null,
    activatedPlan: null,
    protocolReplay: false,
    sessionTaskCount: 0,
    taskControlUsed: false,
    resultText: '',
    hasFinancialFigure,
    usefulWorkerNote,
    ...overrides,
  };
}

it('background acceptance ends the turn without requiring or fabricating execution evidence', () => {
  const decision = decideTurnExit(input({
    backgroundStarted: true,
    backgroundTaskId: 'task_accepted',
    backgroundRunId: 'run_accepted',
    backgroundTaskState: 'queued',
    backgroundReceiptText: '任务已排队。',
    protocolReplay: true,
    resultText: '{"recorded":"delegate","taskId":"task_accepted"}',
  }));
  expect(decision).toEqual({
    kind: 'direct',
    text: '任务已排队。',
    outcome: 'background_task_accepted',
    events: [{
      level: 'info',
      event: 'background_task_accepted',
      detail: { taskId: 'task_accepted', runId: 'run_accepted', state: 'queued' },
    }],
  });
  expect(input({ backgroundStarted: true }).execution).toBe(false);
});

/** 事件断言的小工具：名字 + 级别 + 字段一起比。 */
function expectEvent(decision: TurnExitDecision, index: number, level: 'info' | 'warn', event: string, detail: Record<string, unknown>): void {
  expect(decision.kind === 'relay' || decision.kind === 'direct' ? decision.events[index] : undefined).toEqual({ level, event, detail });
}

describe('decideTurnExit：① 执行痕迹门（零执行 + 无 needs/计划模式可转达）', () => {
  it('delegate + 零执行 + 无 needs + 无 pending：不外发模型文本，NO_EXECUTION_CLARIFICATION 顶上', () => {
    const decision = decideTurnExit(input());
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
    // outcome 走 turn_span 的 delegate_without_execution
    expect(decision.outcome).toBe('delegate_without_execution');
    expect(decision.events).toHaveLength(1);
    expectEvent(decision, 0, 'warn', 'delegate_without_execution', {});
  });

  it('模型给出干净的能力边界说明：原句 + 来源附注顶上（不带数字、不是协议复读）', () => {
    const explained = '平台要求必须显式给出查询范围。';
    const decision = decideTurnExit(input({ resultText: `  ${explained}  ` }));
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(`${explained}\n\n（以上是子 Agent 的说明；本轮没有真正查到平台数据。）`);
    expect(decision.outcome).toBe('delegate_without_execution');
    expectEvent(decision, 0, 'warn', 'delegate_without_execution', {});
  });

  it('模型文本带数字结论：附注支也不放行，仍走 NO_EXECUTION_CLARIFICATION', () => {
    const decision = decideTurnExit(input({ resultText: '本次查到的余额是 1000 元。' }));
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
    expect(decision.events).toHaveLength(1);
  });

  it('零执行但模型复读了协议材料：附注支同样不放行（protocolReplay 是附注的排除项）', () => {
    const decision = decideTurnExit(input({ protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
  });

  it('delegate_without_execution 的事件字段按 needsLoop / planModeTurn 分流', () => {
    // needsLoop 成立但模型文本带数字结论：① 的转达支不放行（数字结论仍必须本轮有执行）
    const byNeeds = decideTurnExit(input({ needsLoop: true, needsRounds: 2, lastNeeds: NEEDS, resultText: '本次查到的余额是 1000 元。' }));
    if (byNeeds.kind !== 'direct') throw new Error('expected direct');
    expectEvent(byNeeds, 0, 'warn', 'delegate_without_execution', { needsRounds: 2 });
    const byPlan = decideTurnExit(input({ intentKind: 'conversation', planModeTurn: true, planSteps: 3, planStepOutcomes: STEP_OUTCOMES, resultText: '查到的金额合计见明细。' }));
    if (byPlan.kind !== 'direct') throw new Error('expected direct');
    expectEvent(byPlan, 0, 'warn', 'delegate_without_execution', { planSteps: 3 });
    // 两者都不成立（delegate 单步零执行）：detail 为空
    expectEvent(decideTurnExit(input()), 0, 'warn', 'delegate_without_execution', {});
  });
});

describe('decideTurnExit：① 执行痕迹门的 needs / 计划模式转达支', () => {
  it('needsLoop 转达：模型自己的诚实文本可用时照常外发，记 needs_loop_relayed', () => {
    const decision = decideTurnExit(input({ needsLoop: true, needsRounds: 1, lastNeeds: NEEDS, resultText: '请问要查哪个对象？' }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe('请问要查哪个对象？');
    expectEvent(decision, 0, 'info', 'needs_loop_relayed', { needsRounds: 1 });
  });

  it('needsLoop + 复读：模型文本不可用，needs 线索顶上，记 plan_steps_relayed_fallback', () => {
    const decision = decideTurnExit(input({ needsLoop: true, needsRounds: 2, lastNeeds: NEEDS, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NEEDS_USER_TEXT);
    expectEvent(decision, 0, 'info', 'plan_steps_relayed_fallback', { needsRounds: 2, reason: 'serialized_tool_result', dispatchedSteps: 0 });
  });

  it('planModeTurn 全部步骤零执行的如实汇总：模型文本照常外发，记 plan_steps_relayed', () => {
    const decision = decideTurnExit(input({ intentKind: 'conversation', planModeTurn: true, planSteps: 2, planStepOutcomes: STEP_OUTCOMES, resultText: '两步都没能执行，请补充查询范围后我重跑。' }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe('两步都没能执行，请补充查询范围后我重跑。');
    expectEvent(decision, 0, 'info', 'plan_steps_relayed', { planSteps: 2 });
  });

  it('planModeTurn + 复读 + 无 needs：宿主持有的步骤事实汇总顶上', () => {
    const decision = decideTurnExit(input({ intentKind: 'conversation', planModeTurn: true, planSteps: 2, planStepOutcomes: STEP_OUTCOMES, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(STEP_FALLBACK);
    expectEvent(decision, 0, 'info', 'plan_steps_relayed_fallback', { planSteps: 2, reason: 'serialized_tool_result', dispatchedSteps: 2 });
  });

  it('planModeTurn + 复读 + 有 needs：needs 线索优先于步骤事实汇总', () => {
    const decision = decideTurnExit(input({ intentKind: 'conversation', planModeTurn: true, planSteps: 2, planStepOutcomes: STEP_OUTCOMES, needsLoop: true, needsRounds: 1, lastNeeds: NEEDS, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NEEDS_USER_TEXT);
    expectEvent(decision, 0, 'info', 'plan_steps_relayed_fallback', { needsRounds: 1, reason: 'serialized_tool_result', dispatchedSteps: 2 });
  });

  it('边界：① 转达出的文本是空串时 ② 照样截住——两段门各自打点（今天同一个 !needsRelay 判据）', () => {
    // needs 的 missing/reason/suggestion 全空 → renderNeedsUserText 产出空串；又停了在复读上
    const decision = decideTurnExit(input({ needsLoop: true, needsRounds: 1, lastNeeds: { missing: [], reason: '  ' }, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
    expect(decision.events).toHaveLength(2);
    // ① 记的是"复读被兜底截住"（usedFallback 判据下即使走的是 needsLoop 也用这个事件名）
    expectEvent(decision, 0, 'info', 'plan_steps_relayed_fallback', { needsRounds: 1, reason: 'serialized_tool_result', dispatchedSteps: 0 });
    expectEvent(decision, 1, 'warn', 'execution_language_leak', { reason: 'protocol_material_replay', executed: false });
  });
});

describe('decideTurnExit：① 的 activatedPlan 分支（P1 收尾兜底）', () => {
  const ACTIVATED = { planId: 'plan_active', version: 2 };

  it('没有有价值的 worker 说明：只发确定性话术，事件不带 withWorkerNote', () => {
    const decision = decideTurnExit(input({ activatedPlan: ACTIVATED }));
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(ACTIVATED_PLAN_NOT_EXECUTED);
    expect(decision.outcome).toBe('activated_plan_not_executed');
    // 先记 delegate_without_execution，再记 activated_plan_not_executed（顺序即现状）
    expect(decision.events).toHaveLength(2);
    expectEvent(decision, 0, 'warn', 'delegate_without_execution', {});
    expectEvent(decision, 1, 'warn', 'activated_plan_not_executed', { planId: 'plan_active', version: 2 });
  });

  it('worker 留了干净说明（无数字、非协议材料、非通用兜底）：附在状态文案后面', () => {
    const decision = decideTurnExit(input({ activatedPlan: ACTIVATED, resultText: '平台要求必须显式给出查询范围。' }));
    expect(decision.kind).toBe('direct');
    if (decision.kind !== 'direct') return;
    expect(decision.text).toBe(`${ACTIVATED_PLAN_NOT_EXECUTED}\n\n平台要求必须显式给出查询范围。`);
    expectEvent(decision, 1, 'warn', 'activated_plan_not_executed', { planId: 'plan_active', version: 2, withWorkerNote: true });
  });

  it('worker 说明带数字结论 / 带执行语言指纹 / 就是通用兜底：一律不算有价值', () => {
    for (const text of ['本次查到的余额是 1000 元。', '详见 src/voucher/scripts/fill.js 的说明。', ACTIVATED_PLAN_NOT_EXECUTED]) {
      const decision = decideTurnExit(input({ activatedPlan: ACTIVATED, resultText: text }));
      if (decision.kind !== 'direct') throw new Error('expected direct');
      expect(decision.text).toBe(ACTIVATED_PLAN_NOT_EXECUTED);
      expectEvent(decision, 1, 'warn', 'activated_plan_not_executed', { planId: 'plan_active', version: 2 });
    }
  });

  it('activatedPlan 分支先于"干净说明附注"与 NO_EXECUTION_CLARIFICATION', () => {
    const decision = decideTurnExit(input({ activatedPlan: ACTIVATED, resultText: '平台要求必须显式给出查询范围。' }));
    if (decision.kind !== 'direct') throw new Error('expected direct');
    expect(decision.text).toContain(ACTIVATED_PLAN_NOT_EXECUTED);
    expect(decision.text).not.toContain('以上是子 Agent 的说明');
  });
});

describe('decideTurnExit：② 协议复读门（D-020 / F4：有执行也拦）', () => {
  it('有计划模式执行痕迹 + 模型复读步骤工具结果：不外发，步骤事实汇总顶上', () => {
    const decision = decideTurnExit(input({ execution: true, planModeTurn: true, planSteps: 2, planStepOutcomes: [{ label: '第 1/2 步', outcome: 'done' }, { label: '第 2/2 步', outcome: 'failed' }], protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    // ① 以 !execution 为闸门整体跳过，② 顶上来的文本与 ① 同一家族
    expect(decision.text).toContain('本轮拆解的进度如下：');
    expect(decision.text).toContain('已执行成功的步骤：第 1/2 步。');
    expect(decision.text).not.toContain('recorded');
    expectEvent(decision, 0, 'warn', 'execution_language_leak', { reason: 'protocol_material_replay', executed: true, planSteps: 2 });
  });

  it('有执行但非计划模式、无 needs 线索：NO_EXECUTION_CLARIFICATION 顶上，executed 记 true', () => {
    const decision = decideTurnExit(input({ execution: true, protocolReplay: true, resultText: '{"recorded":"conversation"}' }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
    expectEvent(decision, 0, 'warn', 'execution_language_leak', { reason: 'protocol_material_replay', executed: true });
  });

  it('有执行 + 有 needs 线索：needs 转达优先，事件带 withNeeds', () => {
    const decision = decideTurnExit(input({ execution: true, needsLoop: true, needsRounds: 1, lastNeeds: NEEDS, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NEEDS_USER_TEXT);
    expectEvent(decision, 0, 'warn', 'execution_language_leak', { reason: 'protocol_material_replay', executed: true, withNeeds: true });
  });

  it('conversation 申报 + 复读申报回执：② 仍然截住（F4.4 的形状）', () => {
    const decision = decideTurnExit(input({ intentKind: 'conversation', protocolReplay: true, resultText: '{"recorded":"conversation"}' }));
    expect(decision.kind).toBe('relay');
    if (decision.kind !== 'relay') return;
    expect(decision.text).toBe(NO_EXECUTION_CLARIFICATION);
    expectEvent(decision, 0, 'warn', 'execution_language_leak', { reason: 'protocol_material_replay', executed: false });
  });
});

describe('decideTurnExit：两段门都不动作的形状', () => {
  it('delegationFailed（消歧问题/熔断汇总/写关闭/队列已满等前置拦截）：两段门都放行', () => {
    for (const overrides of [
      { resultText: PROTOCOL_REPLAY, protocolReplay: true },
      { needsLoop: true, needsRounds: 2, lastNeeds: NEEDS },
      { planModeTurn: true, planSteps: 2, planStepOutcomes: STEP_OUTCOMES },
      { activatedPlan: { planId: 'plan_active', version: 1 } },
    ]) {
      expect(decideTurnExit(input({ delegationFailed: true, ...overrides }))).toEqual({ kind: 'ok' });
    }
  });

  it('停在用户确认门（本回合或模型结果任一侧）：两段门都放行', () => {
    expect(decideTurnExit(input({ pendingPlan: true, resultText: PROTOCOL_REPLAY, protocolReplay: true }))).toEqual({ kind: 'ok' });
    expect(decideTurnExit(input({ resultPendingPlan: true, resultText: PROTOCOL_REPLAY, protocolReplay: true }))).toEqual({ kind: 'ok' });
  });

  it('有执行痕迹且没有复读：正常放行', () => {
    expect(decideTurnExit(input({ execution: true, resultText: '幻辰财税 202609 应收余额为 51 元。' }))).toEqual({ kind: 'ok' });
  });

  it('conversation 申报 + 干净文本：① 不动作（没有 delegate/needs/计划模式），② 也不动作', () => {
    expect(decideTurnExit(input({ intentKind: 'conversation', resultText: '你好，我在。' }))).toEqual({ kind: 'ok' });
  });

  it('没有申报（intentKind = null）：① 不动作', () => {
    expect(decideTurnExit(input({ intentKind: null, resultText: '你好，我在。' }))).toEqual({ kind: 'ok' });
  });
});

describe('decideTurnExit：①b 重复提问门（RR1，历史答复不得冒充实时）', () => {
  const REPEAT_TEXT = messageTextFor('REPEAT_WITHOUT_EXECUTION');

  it('有在册任务 + 零委派零执行 + 数字结论：确定性话术顶上，事件带任务数', () => {
    const decision = decideTurnExit(input({
      intentKind: null,
      sessionTaskCount: 2,
      resultText: '上次查到的应收余额是 61000 元。',
    }));
    expect(decision).toEqual({
      kind: 'direct',
      text: REPEAT_TEXT,
      outcome: 'repeat_without_execution',
      events: [{ level: 'warn', event: 'repeat_without_execution', detail: { tasksInSession: 2 } }],
    });
  });

  it('三要素缺一不拦：无任务 / 无数字 / 本轮真执行 / task_control 状态查询 / 协议复读走 ②', () => {
    const figure = '上次查到的应收余额是 61000 元。';
    expect(decideTurnExit(input({ intentKind: null, sessionTaskCount: 0, resultText: figure }))).toEqual({ kind: 'ok' });
    expect(decideTurnExit(input({ intentKind: null, sessionTaskCount: 2, resultText: '任务已完成，我也整理过。' }))).toEqual({ kind: 'ok' });
    expect(decideTurnExit(input({ intentKind: null, sessionTaskCount: 2, execution: true, resultText: figure }))).toEqual({ kind: 'ok' });
    expect(decideTurnExit(input({ intentKind: null, sessionTaskCount: 2, taskControlUsed: true, resultText: figure }))).toEqual({ kind: 'ok' });
    // 协议复读仍归 ②：替换文本是协议材料的宿主转述，而不是重复提问话术。
    const replay = decideTurnExit(input({ intentKind: null, sessionTaskCount: 2, protocolReplay: true, resultText: PROTOCOL_REPLAY }));
    expect(replay.kind).toBe('relay');
  });

  it('有委派事实（intentKind = delegate）时走 ① 而不是 ①b：两条门的收尾文本各归其位', () => {
    const decision = decideTurnExit(input({ intentKind: 'delegate', sessionTaskCount: 2, resultText: '幻辰 202609 应收余额为 51 元。' }));
    expect(decision.kind).toBe('direct');
    expect(decision.kind === 'direct' ? decision.outcome : '').toBe('delegate_without_execution');
  });
});
