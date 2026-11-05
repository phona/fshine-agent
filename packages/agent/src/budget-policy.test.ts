import { describe, expect, it } from 'vitest';
import { decideBudgetTier, stricterTier, weightOfOperation } from './budget-policy';

describe('通用预算档位策略（与 17dz plan.js policy 缺省同口径）', () => {
  it('小计划放行', () => {
    expect(decideBudgetTier({ calls: 1, seconds: 30, weight: 2 })).toEqual({ tier: 'execute', reasonCode: 'WITHIN_AUTO_THRESHOLD' });
  });
  it('calls 超 auto 线 → notify（INITIAL_SCOPE_THRESHOLD）', () => {
    expect(decideBudgetTier({ calls: 3, seconds: 30, weight: 2 })).toEqual({ tier: 'notify', reasonCode: 'INITIAL_SCOPE_THRESHOLD' });
  });
  it('有历史计划时 auto 以上 → SCOPE_EXPANSION', () => {
    expect(decideBudgetTier({ calls: 3, seconds: 30, weight: 2, previous: true })).toEqual({ tier: 'notify', reasonCode: 'SCOPE_EXPANSION' });
  });
  it('weight 达 budget 线 → confirm（BUDGET_WEIGHT），即使 calls 线只是 notify', () => {
    expect(decideBudgetTier({ calls: 11, seconds: 100, weight: 60 })).toEqual({ tier: 'confirm', reasonCode: 'BUDGET_WEIGHT' });
  });
  it('weight 超 hard 线 → stop（HARD_WEIGHT）', () => {
    expect(decideBudgetTier({ calls: 1, seconds: 30, weight: 181 })).toEqual({ tier: 'stop', reasonCode: 'HARD_WEIGHT' });
  });
  it('calls 超 hard 线 → stop（HARD_LIMIT）', () => {
    expect(decideBudgetTier({ calls: 51, seconds: 30, weight: 2 })).toEqual({ tier: 'stop', reasonCode: 'HARD_LIMIT' });
  });
  it('同档时 calls 线优先（tie-break 与 17dz 一致）', () => {
    expect(decideBudgetTier({ calls: 11, seconds: 100, weight: 19 })).toEqual({ tier: 'notify', reasonCode: 'NOTIFY_THRESHOLD' });
  });
  it('grantLevel 扩容：同一容量边缘只停一次', () => {
    expect(decideBudgetTier({ calls: 21, seconds: 100, weight: 61, grantLevel: 1 }).tier).toBe('notify');
  });
  it('stricterTier 取更严一档', () => {
    expect(stricterTier('notify', 'confirm')).toBe('confirm');
    expect(stricterTier('stop', 'confirm')).toBe('stop');
    expect(stricterTier('execute', 'execute')).toBe('execute');
  });
  it('weightOfOperation 缺省换算', () => {
    expect(weightOfOperation({ weight: 5 })).toBe(5);
    expect(weightOfOperation({ est_seconds: 55 })).toBe(6);
    expect(weightOfOperation({})).toBe(1);
  });
});
