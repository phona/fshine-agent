import { describe, expect, it, vi } from 'vitest';
import { evaluateAndActivatePlan, planDecisionRank, type PlanCliRunner } from './plan-runtime';

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

describe('decision fail-closed：未知档位两道防线各有钉子', () => {
  it('planDecisionRank 直测：四档有严度序，未知档位抛错（rankOf 改回 ?? 0 时本条变红）', () => {
    expect(planDecisionRank('execute')).toBe(0);
    expect(planDecisionRank('notify')).toBe(1);
    expect(planDecisionRank('confirm')).toBe(2);
    expect(planDecisionRank('stop')).toBe(3);
    expect(() => planDecisionRank('bogus')).toThrow(/非法 decision/);
    expect(() => planDecisionRank('')).toThrow(/非法 decision/);
  });

  it('exit 0 返回未知 decision → 抛错且文案带 exit 0 预验标记，不激活（删预验时本条凭文案变红）', async () => {
    const evaluation = base({ decision: 'bogus', estimate: { calls: 1, seconds: 10, weight: 2 } });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation),
    })).rejects.toThrow(/exit 0 预验/);
  });

  it('exit 0 返回未知 decision 时 weight 合法也不激活（不是 weight fail-closed 的误报）', async () => {
    const evaluation = base({ decision: 'maybe', estimate: { calls: 1, seconds: 10, weight: 2 } });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli: runCliFor(evaluation),
    })).rejects.toThrow(/非法 decision/);
  });

  it('非零 exit 带未知 decision JSON → tryParse 不认，仍抛 CLI 失败，不激活', async () => {
    const runCli: PlanCliRunner = async (request) => {
      if (request.args[1] === 'evaluate') {
        return { code: 3, stdout: JSON.stringify(base({ decision: 'bogus' })), stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ planId: 'p', version: 1, status: 'active' }), stderr: '' };
    };
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 't1', calls: CALLS, runCli,
    })).rejects.toThrow(/17dz plan CLI 失败/);
  });

  it('两道防线同时拆掉时未知档位不再被拦——本条是变异对照的书面说明，非可跑用例', () => {
    // 若同时把 exit 0 预验删掉且把 planDecisionRank 改回 ?? 0，未知档位会
    // 落进 active 返回（旧缺陷）。单拆任一道时另一道仍抛错，故单道变异
    // 只能凭直测/文案分别钉住，不能凭“公开路径仍抛错”证明单道无用。
    expect(planDecisionRank('execute')).toBe(0);
  });
});
