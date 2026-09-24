import { describe, expect, it, vi } from 'vitest';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, formatPlanMessage, loadCurrentActivePlan, parsePlanCallsCommand, type PlanCliRunner } from './src/plan-runtime';

const approved = {
  planId: 'plan_123', version: 2, decision: 'notify',
  estimate: { calls: 9, seconds: 540 },
  delta: { addedCalls: 9, addedSeconds: 540, calls: [] },
  cumulative: { calls: 9, seconds: 540 }, reasonCode: 'scope_expanded', status: 'pending_notice',
  noticeText: '账套「A」；期间2026年09月；新增9次查询，预计耗时约9分钟。',
} as const;

function fakeCli(outputs: unknown[], calls: Array<{ args: string[]; input?: string }> = []): PlanCliRunner {
  let cursor = 0;
  return async (request) => {
    calls.push({ args: request.args, input: request.input });
    return { code: 0, stdout: JSON.stringify(outputs[cursor++]), stderr: '' };
  };
}

describe('platform-backed execution plan runtime', () => {
  it('only accepts the virtual JSON plan submission and rejects direct evaluate/activate CLI calls', () => {
    expect(() => parsePlanCallsCommand('bin/17dz plan evaluate --task-id forged --stdin')).toThrow('不得直接调用 evaluate/activate');
    expect(() => parsePlanCallsCommand('bin/17dz plan activate --plan-id forged --evidence notification-delivered --token forged')).toThrow('不得直接调用 evaluate/activate');
    expect(parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}')?.calls).toEqual([
      { operation: 'voucher.query-saved', args: ['A', '202609'] },
    ]);
    expect(() => parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":{"account":"A"}}]}')).toThrow('args 必须是数组');
    expect(() => parsePlanCallsCommand('/home/fictional-user/fictional-projects/fictional-execution-layer/bin/17dz plan activate --stdin')).toThrow('不得直接调用 evaluate/activate');
  });

  it('passes an active plan only to the worker subprocess and strips the host activation secret', () => {
    expect(createPlanScopedWorkerEnv({ DZ_PLAN_ACTIVATION_SECRET: 'secret', DZ_PLAN_ID: 'forged', OTHER: 'ok' }, 'plan_host'))
      .toEqual({ DZ_REQUIRE_PLAN: '1', DZ_PLAN_ID: 'plan_host', OTHER: 'ok' });
    expect(createPlanScopedWorkerEnv({ DZ_PLAN_ACTIVATION_SECRET: 'secret' }, null))
      .toEqual({ DZ_REQUIRE_PLAN: '1' });
  });

  it('restores only the host-selected active plan when resuming a task', async () => {
    const requests: string[][] = [];
    const active = await loadCurrentActivePlan({
      platformRoot: '/platform', taskId: 'trusted_task_7',
      runCli: async ({ args }) => { requests.push(args); return { code: 0, stdout: JSON.stringify({ taskId: 'trusted_task_7', planId: 'plan_saved', version: 4, status: 'active' }), stderr: '' }; },
    });
    expect(active).toBe('plan_saved');
    expect(requests).toEqual([['plan', 'current', '--task-id', 'trusted_task_7']]);
  });

  it('returns no worker plan for missing, pending, or stopped tasks', async () => {
    const result = await loadCurrentActivePlan({
      platformRoot: '/platform', taskId: 'trusted_task_7',
      runCli: async () => ({ code: 0, stdout: JSON.stringify({ taskId: 'trusted_task_7', planId: null, version: null, status: 'none' }), stderr: '' }),
    });
    expect(result).toBeNull();
  });

  it('user notices contain a safe plain-language summary, never internal identifiers or raw call payloads', () => {
    const message = formatPlanMessage({ ...approved, reasonCode: 'scope_expanded', delta: { addedCalls: 9, addedSeconds: 540, calls: [{ operation: 'voucher.query-saved', args: ['SECRET_ACCOUNT', '202609'] }] } });
    expect(message).toContain('新增9次查询');
    expect(message).toContain('9分钟');
    expect(message).toContain('账套「A」');
    expect(message).toContain('2026年09月');
    expect(message).not.toContain('plan_123');
    expect(message).not.toContain('SECRET_ACCOUNT');
    expect(message).not.toContain('scope_expanded');
  });

  it('awaits a user notice before activating a notify decision', async () => {
    const order: string[] = [];
    const requests: Array<{ args: string[]; input?: string; env?: NodeJS.ProcessEnv }> = [];
    const cli = fakeCli([approved, { status: 'active', planId: 'plan_123', version: 2 }], []);
    const runCli: PlanCliRunner = async (request) => {
      requests.push(request);
      if (request.args[1] === 'evaluate') order.push('evaluate');
      if (request.args[1] === 'activate') order.push('activate');
      return cli(request);
    };
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      requestId: 'request_9',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      onNotice: async (message) => { expect(message).toContain('新增9次查询'); order.push('notice'); },
      runCli,
      activationSecret: 'test-host-secret',
    });
    expect(order).toEqual(['evaluate', 'notice', 'activate']);
    expect(result.status).toBe('active');
    expect(JSON.parse(requests[0]!.input!)).toEqual({ requestId: 'request_9', calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }] });
    expect(requests[1]!.args).toEqual(['plan', 'activate', '--stdin']);
    expect(requests[1]!.input).toMatch(/"evidence":"notification-delivered"/);
    expect(requests[1]!.env?.DZ_PLAN_ACTIVATION_SECRET).toBe('test-host-secret');
    expect(requests[1]!.args.join(' ')).not.toContain('test-host-secret');
  });

  it('does not activate when notice delivery fails', async () => {
    const calls: string[] = [];
    const runCli: PlanCliRunner = async ({ args }) => {
      calls.push(args[1]!);
      return { code: 0, stdout: JSON.stringify(approved), stderr: '' };
    };
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      onNotice: async () => { throw new Error('delivery failed'); }, runCli,
    })).rejects.toThrow('delivery failed');
    expect(calls).toEqual(['evaluate']);
  });

  it('returns confirm pending without activating, regardless of model-supplied confirmation fields', async () => {
    const confirm = { ...approved, decision: 'confirm', status: 'awaiting_user' };
    const calls: string[] = [];
    const runCli = fakeCli([confirm], []);
    const wrapped: PlanCliRunner = async (request) => {
      calls.push(request.args[1]!);
      return runCli(request);
    };
    const onNotice = vi.fn(async () => {});
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      userConfirmed: true, onNotice, runCli: wrapped,
    });
    expect(result.status).toBe('confirm');
    expect(calls).toEqual(['evaluate']);
    expect(onNotice).toHaveBeenCalledOnce();
  });

  it('cannot leave a confirm decision pending without notifying the user', async () => {
    const confirm = { ...approved, decision: 'confirm', status: 'awaiting_user' };
    const runCli = fakeCli([confirm], []);
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      runCli,
    })).rejects.toThrow('onNotice');
  });
});
