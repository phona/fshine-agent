import { describe, expect, it, vi } from 'vitest';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, formatPlanMessage, loadCurrentActivePlan, parsePlanCallsCommand, planCallFacts, type PlanCliRunner } from './src/plan-runtime';
import { parseOperationArgSpecs, type OperationArgsSpecs } from './src/operation-labels';

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
    // 措辞收口在 error-codes.ts 表（三要素：码 + 期望/实际/正确形态）
    expect(() => parsePlanCallsCommand('bin/17dz plan evaluate --task-id forged --stdin')).toThrow('PLAN_SUBCOMMAND_RESERVED');
    expect(() => parsePlanCallsCommand('bin/17dz plan activate --plan-id forged --evidence notification-delivered --token forged')).toThrow('PLAN_SUBCOMMAND_RESERVED');
    expect(parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}')?.calls).toEqual([
      { operation: 'voucher.query-saved', args: ['A', '202609'] },
    ]);
    expect(() => parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":{"account":"A"}}]}')).toThrow('PLAN_CALL_ARGS_NOT_ARRAY');
    expect(() => parsePlanCallsCommand('/home/fictional-user/fictional-projects/fictional-execution-layer/bin/17dz plan activate --stdin')).toThrow('PLAN_SUBCOMMAND_RESERVED');
  });

  it('围栏/外层引号包装不再被容忍：抛结构错误，宿主不 absorbing 格式波动', () => {
    const bare = 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202606"]}]}';
    const expected = [{ operation: 'voucher.query-saved', args: ['A', '202606'] }];
    // 对照：同样的内容去掉包装就是合法命令（围栏/引号是唯一差别）
    expect(parsePlanCallsCommand(bare)?.calls).toEqual(expected);
    // markdown 围栏（带语言标签、单行）
    expect(() => parsePlanCallsCommand(`\`\`\`json\n${bare}\n\`\`\``)).toThrow('PLAN_SHAPE_PREFIX');
    // 围栏无标签 + 多行美化（JSON 本体跨行）
    expect(() => parsePlanCallsCommand('```\nbin/17dz plan {\n  "calls": [\n    { "operation": "voucher.query-saved", "args": ["A", "202606"] }\n  ]\n}\n```')).toThrow('PLAN_SHAPE_PREFIX');
    // 外层成对引号（双引号/单引号）
    expect(() => parsePlanCallsCommand(`"${bare}"`)).toThrow('PLAN_SHAPE_PREFIX');
    expect(() => parsePlanCallsCommand(`'${bare}'`)).toThrow('PLAN_SHAPE_PREFIX');
    // 报错必须说清"前面多了什么"并给出正确形状——这是模型下一轮自愈的唯一依据
    // （三要素：期望/实际/正确形态；实际即多出来的内容，逐字点出）
    expect(() => parsePlanCallsCommand(`\`\`\`json\n${bare}\n\`\`\``))
      .toThrow('实际 ```json；正确形态');
    // 围栏里不是计划命令（没有 bin/17dz plan 头）：仍返回 null，与裸命令语义一致
    expect(parsePlanCallsCommand('```json\n{"calls":[{"operation":"x","args":[]}]}\n```')).toBeNull();
  });

  it('plan 之后没有 JSON 方案：抛形状错误', () => {
    expect(() => parsePlanCallsCommand('bin/17dz plan')).toThrow('PLAN_SHAPE_PAYLOAD');
    expect(() => parsePlanCallsCommand('bash /abs/path/bin/17dz plan   ')).toThrow('PLAN_SHAPE_PAYLOAD');
  });

  it('bash/sh 与任意路径前缀照常放行，user_confirmed 只作审计', () => {
    const calls = [{ operation: 'voucher.query-saved', args: ['A', '202606'] }];
    const json = JSON.stringify({ calls });
    for (const prefix of ['', 'bash ', 'sh ', 'bash /abs/path/', 'sh /abs/path/', '/abs/path/']) {
      expect(parsePlanCallsCommand(`${prefix}bin/17dz plan ${json}`)?.calls).toEqual(calls);
    }
    expect(parsePlanCallsCommand('bin/17dz plan {"user_confirmed":true,"calls":[{"operation":"voucher.query-saved","args":[]}]}')).toEqual({
      calls: [{ operation: 'voucher.query-saved', args: [] }],
      userConfirmed: true,
    });
  });

  it('没有 plan 令牌：返回 null（真不是计划命令，交 serve-gate 常规检查）', () => {
    expect(parsePlanCallsCommand('bin/17dz query --saved-vouchers --account-set A --period 202606')).toBeNull();
    expect(parsePlanCallsCommand('ls -la')).toBeNull();
    expect(parsePlanCallsCommand('')).toBeNull();
  });

  it('JSON 残缺：抛带 JSON.parse 真实原因的错误', () => {
    expect(() => parsePlanCallsCommand('bin/17dz plan {"calls":[')).toThrow('PLAN_JSON_PARSE');
    expect(() => parsePlanCallsCommand('bin/17dz plan {"calls":[')).toThrow(/实际 Unexpected end of JSON input/);
  });

  it('前后有多余内容：抛结构错误并点出前面多出的 token', () => {
    // 前后加了别的内容（"请提交这个计划：…谢谢"）——不是合法前缀，报期望/实际
    expect(() => parsePlanCallsCommand('请提交这个计划：bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202606"]}]} 谢谢'))
      .toThrow('实际 请提交这个计划：；正确形态');
    // 多 token 的前缀同样逐字点出
    expect(() => parsePlanCallsCommand('echo hi && bin/17dz plan {"calls":[]}'))
      .toThrow('实际 echo hi &&；正确形态');
    // 对照：形状正确不抛
    expect(() => parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","x"]}]}')).not.toThrow();
    // 直接调子命令：宿主专属语义（保留关键词），码与正确形状都在表里
    expect(() => parsePlanCallsCommand('bin/17dz plan evaluate --task-id forged --stdin')).toThrow('PLAN_SUBCOMMAND_RESERVED');
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
    expect(active).toEqual({ planId: 'plan_saved', version: 4 });
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

// ── 结构化事实提取（D-065：宿主机械解析，绝不从 worker 文本解析）────────────────

/** 与平台 `operation list --json` 同形的预置规格（节选）。 */
const SPECS: OperationArgsSpecs = parseOperationArgSpecs(JSON.stringify([
  {
    name: 'finance.query-receivables', command: 'query-receivables',
    args: {
      positional: [],
      flags: [
        { flag: '--query', required: true, style: 'name' },
        { flag: '--customer', required: false, style: 'name' },
        { flag: '--subject-code', required: false, style: 'code' },
        { flag: '--period', required: false, style: 'code' },
      ],
    },
  },
  {
    name: 'voucher.query-saved', command: 'query-saved',
    args: {
      positional: [
        { name: 'accountSet', required: true, style: 'name' },
        { name: 'period', required: true, style: 'code' },
      ],
      flags: [],
    },
  },
]));

// 与 parseOperationLabels 的入表口径一致：script 裸名与注册名两种键都收
const LABELS = new Map([
  ['query-receivables', '查应收账款余额'],
  ['finance.query-receivables', '查应收账款余额'],
  ['query-saved', '查凭证列表'],
  ['voucher.query-saved', '查凭证列表'],
]);

describe('planCallFacts（平台 args 规格声明名机械提取）', () => {
  it('位置参数按声明名取：voucher.query-saved 的 accountSet/period', () => {
    expect(planCallFacts(
      [{ operation: 'voucher.query-saved', args: ['幻州市幻晟财务代理有限公司', '202609'] }],
      SPECS, LABELS,
    )).toEqual({
      accountSet: '幻州市幻晟财务代理有限公司',
      period: '202609',
      label: '查凭证列表',
    });
  });

  it('flag 按平台 kebab→camel 声明名取：--period 取得到，--query 不当作 accountSet', () => {
    const facts = planCallFacts(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻晟', '--period', '202609', '--subject-code', '1122'] }],
      SPECS, LABELS,
    );
    // 宁缺勿猜：--query 是检索关键词（平台规范名先搜出来），不等于已解析的账套名
    expect(facts).toEqual({ period: '202609', label: '查应收账款余额' });
  });

  it('多个调用时取首个命中的声明名取值（不合并、不猜）', () => {
    const facts = planCallFacts([
      { operation: 'finance.query-receivables', args: ['--query', '甲', '--period', '202601'] },
      { operation: 'voucher.query-saved', args: ['乙', '202602'] },
    ], SPECS, LABELS);
    expect(facts).toMatchObject({ accountSet: '乙', period: '202601', label: '查应收账款余额' });
  });

  it('规格缺失 / 声明名对不上 → 该字段不出现（不猜位置语义）', () => {
    expect(planCallFacts([{ operation: 'voucher.query-saved', args: ['A', '202609'] }], undefined, LABELS))
      .toEqual({ label: '查凭证列表' });
    expect(planCallFacts([{ operation: 'unknown.operation', args: ['A', '202609'] }], SPECS, LABELS))
      .toEqual({});
  });

  it('空 calls → 空事实（没提过计划的委派不挂结构化字段）', () => {
    expect(planCallFacts([], SPECS, LABELS)).toEqual({});
  });
});
