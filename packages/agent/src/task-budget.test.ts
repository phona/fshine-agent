/**
 * T6 任务级预算账本 + 确认门时间顺序判据（2026-11-11）。
 *
 * 为什么需要任务级账本：宿主叠加档此前只看**当前这一张**计划的 estimate——任务被切成
 * 多张都在确认线以下的小计划逐张提交时，确认门一次也到不了（今天 D2 两臂的败状：
 * 3 call / 6 call 两张计划各自都只到 notify，任务总重量 18 call 却一路放行）。
 *
 * 判据两条，都可机判：
 *   ① 账本按**已激活计划**累计 estimate，同一 planId 重复激活不重复计数；
 *   ② 确认门时间顺序：进了 confirm 档之后，确认记录之前零执行（确认后才放行）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_THRESHOLDS } from './budget-policy';
import {
  confirmGateOrdering,
  emptyTaskBudgetLedger,
  ledgerUsage,
  taskBudgetDecision,
  withActivatedPlan,
} from './task-budget';

const plan = (calls: number, seconds: number, weight: number) => ({ calls, seconds, weight });

describe('T6 任务级预算账本', () => {
  it('按已激活计划累计；同一 planId 重复激活不重复计数', () => {
    let ledger = emptyTaskBudgetLedger();
    expect(ledgerUsage(ledger)).toEqual({ calls: 0, seconds: 0, weight: 0 });
    ledger = withActivatedPlan(ledger, 'plan_a', plan(8, 80, 22));
    ledger = withActivatedPlan(ledger, 'plan_b', plan(8, 80, 22));
    // 同一张计划再激活一次（重放 / resume）：账本不变。
    ledger = withActivatedPlan(ledger, 'plan_b', plan(8, 80, 22));
    expect(ledgerUsage(ledger)).toEqual({ calls: 16, seconds: 160, weight: 44 });
  });

  it('切片的计划单张在确认线以下，累计后进 confirm 档（今天 D2 的败状形状）', () => {
    // 单张：8 call / 80s / weigh 22 → 单张档位 notify（8 > notifyCalls 10？否；calls 8 > auto 2 → notify）。
    const single = taskBudgetDecision(plan(8, 80, 22));
    expect(single.tier).toBe('notify');
    let ledger = emptyTaskBudgetLedger();
    ledger = withActivatedPlan(ledger, 'plan_1', plan(8, 80, 22));
    ledger = withActivatedPlan(ledger, 'plan_2', plan(8, 80, 22));
    // 两张之后：16 call / 44 weight —— 仍在确认线下（notify）。
    expect(taskBudgetDecision(ledgerUsage(ledger)).tier).toBe('notify');
    ledger = withActivatedPlan(ledger, 'plan_3', plan(8, 80, 22));
    // 三张之后：24 call / 66 weight —— 越过宿主确认线（calls 24 > 20 且 weight 66 ≥ 60）。
    const cumulative = taskBudgetDecision(ledgerUsage(ledger));
    expect(cumulative.tier).toBe('confirm');
    expect(cumulative.reasonCode).toBe('CONFIRM_THRESHOLD');
    expect(DEFAULT_BUDGET_THRESHOLDS.confirmCalls).toBe(20);
  });

  it('累计进 stop 档同样不低于 confirm 档（硬上限不被切片绕过）', () => {
    let ledger = emptyTaskBudgetLedger();
    ledger = withActivatedPlan(ledger, 'plan_1', plan(30, 300, 0));
    ledger = withActivatedPlan(ledger, 'plan_2', plan(30, 300, 0));
    expect(taskBudgetDecision(ledgerUsage(ledger)).tier).toBe('stop');
  });
});

describe('T6 确认门时间顺序判据（审计 + 确认记录）', () => {
  const hold = '2026-11-11T10:00:10.000Z';
  const confirmation = '2026-11-11T10:00:20.000Z';

  it('进 confirm 档后、确认记录前零执行 → held', () => {
    expect(confirmGateOrdering({
      holdAt: hold,
      confirmations: [],
      executions: [{ ts: '2026-11-11T10:00:00.000Z' }, { ts: '2026-11-11T10:00:05.000Z' }],
    })).toBe('held');
  });

  it('确认之后才出现的执行 → released（确认后才放行）', () => {
    expect(confirmGateOrdering({
      holdAt: hold,
      confirmations: [{ at: confirmation, planId: 'plan_3' }],
      executions: [{ ts: '2026-11-11T10:00:00.000Z' }, { ts: '2026-11-11T10:00:30.000Z' }],
    })).toBe('released');
  });

  it('确认记录之前有执行 → executed_before_confirmation（越门先行）', () => {
    expect(confirmGateOrdering({
      holdAt: hold,
      confirmations: [{ at: confirmation, planId: 'plan_3' }],
      executions: [{ ts: '2026-11-11T10:00:15.000Z' }, { ts: '2026-11-11T10:00:30.000Z' }],
    })).toBe('executed_before_confirmation');
  });

  it('确认后又有执行、但确认记录缺席（拿不到确认证据）→ 不当作 release', () => {
    expect(confirmGateOrdering({
      holdAt: hold,
      confirmations: [],
      executions: [{ ts: '2026-11-11T10:00:15.000Z' }],
    })).toBe('executed_before_confirmation');
  });

  it('没有 hold 记录 / 执行行缺 ts → INCONCLUSIVE（拿不到证据不当成零执行）', () => {
    expect(confirmGateOrdering({
      confirmations: [{ at: confirmation }],
      executions: [{ ts: '2026-11-11T10:00:30.000Z' }],
    })).toBe('inconclusive');
    expect(confirmGateOrdering({
      holdAt: hold,
      confirmations: [{ at: confirmation }],
      executions: [{ ts: '2026-11-11T10:00:30.000Z' }, {}],
    })).toBe('inconclusive');
  });
});
