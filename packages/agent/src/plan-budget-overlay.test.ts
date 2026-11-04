import { describe, expect, it, vi } from 'vitest';
import { evaluateAndActivatePlan, type PlanCliRunner } from './plan-runtime';

/**
 * 接口文档 §4：预算接入。
 * 平台 decision 与宿主档（decideBudgetTier）取更严一档；
 * estimate.weight 缺失/非法时 fail-closed，不激活。
 * 阈值缺省：weight 6/18/60/180（auto/notify/budget/hard）。
 */
function runCliFor(evaluation: Record<string, unknown>): PlanCliRunner {
  return async (request) => {
    if (request.args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify(evaluation), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ planId: 'p', version: 1, status: 'active' }), stderr: '' };
  };
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: 'plan_x', version: 1, decision: 'execute',
    estimate: { calls: 1, seconds: 10, weight: 2 },
    delta: {}, cumulative: {}, reasonCode: 'WITHIN_AUTO_THRESHOLD', status: 'active',
    ...overrides,
  };
}

const CALLS = [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }];

describe('预算接入：宿主档与平台档更严为准', () => {
  it('weight 缺失时 fail-closed，不激活', async () => {
    const evaluation = base({ estimate: { calls: 1, seconds: 10 } });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation),
    })).rejects.toThrow(/weight/);
  });

  it('weight 非法（NaN/负数）时 fail-closed', async () => {
    for (const weight of [Number.NaN, -1]) {
      const evaluation = base({ estimate: { calls: 1, seconds: 10, weight } });
      await expect(evaluateAndActivatePlan({
        platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation),
      })).rejects.toThrow(/weight/);
    }
  });

  it('平台 execute + 宿主 confirm（weight 70 ≥ budget 60）→ confirm，不激活', async () => {
    const onNotice = vi.fn(async () => {});
    const evaluation = base({ decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 70 } });
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation), onNotice,
    });
    expect(result.status).toBe('confirm');
    if (result.status !== 'confirm') throw new Error('expected confirm');
    expect(result.pending.evaluation.decision).toBe('confirm');
    expect(result.pending.evaluation.reasonCode).toBe('BUDGET_WEIGHT');
  });

  it('平台 execute + 宿主 stop（weight 200 > hard 180）→ stop', async () => {
    const evaluation = base({ decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 200 } });
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation),
    });
    expect(result.status).toBe('stop');
    if (result.status !== 'stop') throw new Error('expected stop');
    expect(result.evaluation.reasonCode).toBe('HARD_WEIGHT');
  });

  it('平台 confirm + 宿主 execute（weight 2）→ 仍为 confirm，不被宿主放宽', async () => {
    const onNotice = vi.fn(async () => {});
    const evaluation = base({ decision: 'confirm', estimate: { calls: 1, seconds: 10, weight: 2 } });
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation), onNotice,
    });
    expect(result.status).toBe('confirm');
  });

  it('平台 execute + 宿主 execute（weight 2）→ active，不变', async () => {
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(base()),
    });
    expect(result.status).toBe('active');
  });
});
