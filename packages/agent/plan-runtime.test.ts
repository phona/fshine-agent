import { describe, expect, it, vi } from 'vitest';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, formatPlanMessage, loadCurrentActivePlan, parsePlanCallsCommand, planCallFacts, planWriteClosed, type PlanCliRunner } from './src/plan-runtime';
import { parseOperationArgSpecs, parseOperationSemantics, type OperationArgsSpecs } from './src/operation-labels';

const approved = {
  planId: 'plan_123', version: 2, decision: 'notify',
  estimate: { calls: 9, seconds: 540, weight: 2 },
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
    expect(() => parsePlanCallsCommand('bin/example-gateway plan evaluate --task-id forged --stdin', 'bin/example-gateway')).toThrow('PLAN_SUBCOMMAND_RESERVED');
    expect(() => parsePlanCallsCommand('bin/example-gateway plan activate --plan-id forged --evidence notification-delivered --token forged', 'bin/example-gateway')).toThrow('PLAN_SUBCOMMAND_RESERVED');
    expect(parsePlanCallsCommand('bin/example-gateway plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}', 'bin/example-gateway')).toEqual({
      kind: 'inline',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
    });
    expect(() => parsePlanCallsCommand('bin/example-gateway plan {"calls":[{"operation":"voucher.query-saved","args":{"account":"A"}}]}', 'bin/example-gateway')).toThrow('PLAN_CALL_ARGS_NOT_ARRAY');
    expect(() => parsePlanCallsCommand('/home/fictional-user/fictional-projects/fictional-execution-layer/bin/example-gateway plan activate --stdin', 'bin/example-gateway')).toThrow('PLAN_SUBCOMMAND_RESERVED');
  });

  it('围栏/外层引号包装不再被容忍：抛结构错误，宿主不 absorbing 格式波动', () => {
    const bare = 'bin/example-gateway plan {"calls":[{"operation":"voucher.query-saved","args":["A","202606"]}]}';
    const expected = [{ operation: 'voucher.query-saved', args: ['A', '202606'] }];
    // 对照：同样的内容去掉包装就是合法命令（围栏/引号是唯一差别）
    expect(parsePlanCallsCommand(bare, 'bin/example-gateway')).toEqual({ kind: 'inline', calls: expected });
    // markdown 围栏（带语言标签、单行）
    expect(() => parsePlanCallsCommand(`\`\`\`json\n${bare}\n\`\`\``, 'bin/example-gateway')).toThrow('PLAN_SHAPE_PREFIX');
    // 围栏无标签 + 多行美化（JSON 本体跨行）
    expect(() => parsePlanCallsCommand('```\nbin/example-gateway plan {\n  "calls": [\n    { "operation": "voucher.query-saved", "args": ["A", "202606"] }\n  ]\n}\n```', 'bin/example-gateway')).toThrow('PLAN_SHAPE_PREFIX');
    // 外层成对引号（双引号/单引号）
    expect(() => parsePlanCallsCommand(`"${bare}"`, 'bin/example-gateway')).toThrow('PLAN_SHAPE_PREFIX');
    expect(() => parsePlanCallsCommand(`'${bare}'`, 'bin/example-gateway')).toThrow('PLAN_SHAPE_PREFIX');
    // 报错必须说清"前面多了什么"并给出正确形状——这是模型下一轮自愈的唯一依据
    // （三要素：期望/实际/正确形态；实际即多出来的内容，逐字点出）
    expect(() => parsePlanCallsCommand(`\`\`\`json\n${bare}\n\`\`\``, 'bin/example-gateway'))
      .toThrow('实际 ```json；正确形态');
    // 围栏里不是计划命令（没有 bin/example-gateway plan 头）：仍返回 null，与裸命令语义一致
    expect(parsePlanCallsCommand('```json\n{"calls":[{"operation":"x","args":[]}]}\n```', 'bin/example-gateway')).toBeNull();
  });

  it('plan 之后没有 JSON 方案：抛形状错误', () => {
    expect(() => parsePlanCallsCommand('bin/example-gateway plan', 'bin/example-gateway')).toThrow('PLAN_SHAPE_PAYLOAD');
    expect(() => parsePlanCallsCommand('bash /abs/path/bin/example-gateway plan   ', 'bin/example-gateway')).toThrow('PLAN_SHAPE_PAYLOAD');
  });

  it('bash/sh 与任意路径前缀照常放行，user_confirmed 只作审计', () => {
    const calls = [{ operation: 'voucher.query-saved', args: ['A', '202606'] }];
    const json = JSON.stringify({ calls });
    for (const prefix of ['', 'bash ', 'sh ', 'bash /abs/path/', 'sh /abs/path/', '/abs/path/']) {
      expect(parsePlanCallsCommand(`${prefix}bin/example-gateway plan ${json}`, 'bin/example-gateway')).toEqual({ kind: 'inline', calls });
    }
    expect(parsePlanCallsCommand('bin/example-gateway plan {"user_confirmed":true,"calls":[{"operation":"voucher.query-saved","args":[]}]}', 'bin/example-gateway')).toEqual({
      kind: 'inline',
      calls: [{ operation: 'voucher.query-saved', args: [] }],
      userConfirmed: true,
    });
  });

  it('没有 plan 令牌：返回 null（真不是计划命令，交 serve-gate 常规检查）', () => {
    expect(parsePlanCallsCommand('bin/example-gateway query --saved-vouchers --account-set A --period 202606', 'bin/example-gateway')).toBeNull();
    expect(parsePlanCallsCommand('ls -la', 'bin/example-gateway')).toBeNull();
    expect(parsePlanCallsCommand('', 'bin/example-gateway')).toBeNull();
  });

  it('JSON 残缺：抛带 JSON.parse 真实原因的错误', () => {
    expect(() => parsePlanCallsCommand('bin/example-gateway plan {"calls":[', 'bin/example-gateway')).toThrow('PLAN_JSON_PARSE');
    expect(() => parsePlanCallsCommand('bin/example-gateway plan {"calls":[', 'bin/example-gateway')).toThrow(/实际 Unexpected end of JSON input/);
  });

  it('前后有多余内容：抛结构错误并点出前面多出的 token', () => {
    // 前后加了别的内容（"请提交这个计划：…谢谢"）——不是合法前缀，报期望/实际
    expect(() => parsePlanCallsCommand('请提交这个计划：bin/example-gateway plan {"calls":[{"operation":"voucher.query-saved","args":["A","202606"]}]} 谢谢', 'bin/example-gateway'))
      .toThrow('实际 请提交这个计划：；正确形态');
    // 多 token 的前缀同样逐字点出
    expect(() => parsePlanCallsCommand('echo hi && bin/example-gateway plan {"calls":[]}', 'bin/example-gateway'))
      .toThrow('实际 echo hi &&；正确形态');
    // 对照：形状正确不抛
    expect(() => parsePlanCallsCommand('bin/example-gateway plan {"calls":[{"operation":"finance.query-receivables","args":["--query","x"]}]}', 'bin/example-gateway')).not.toThrow();
    // 直接调子命令：宿主专属语义（保留关键词），码与正确形状都在表里
    expect(() => parsePlanCallsCommand('bin/example-gateway plan evaluate --task-id forged --stdin', 'bin/example-gateway')).toThrow('PLAN_SUBCOMMAND_RESERVED');
  });

  it('passes an active plan only to the worker subprocess and strips the host activation secret', () => {
    expect(createPlanScopedWorkerEnv({ EXECUTION_PLAN_ACTIVATION_SECRET: 'secret', EXECUTION_PLAN_ID: 'forged', OTHER: 'ok' }, 'plan_host'))
      .toEqual({ EXECUTION_REQUIRE_PLAN: '1', EXECUTION_PLAN_ID: 'plan_host', OTHER: 'ok' });
    expect(createPlanScopedWorkerEnv({ EXECUTION_PLAN_ACTIVATION_SECRET: 'secret' }, null))
      .toEqual({ EXECUTION_REQUIRE_PLAN: '1' });
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
    expect(requests[1]!.env?.EXECUTION_PLAN_ACTIVATION_SECRET).toBe('test-host-secret');
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

  // ── evaluate 退出码双语义（平台 src/cli/index.js：stop 裁决 exit 3 + stdout 合法 JSON；
  //    写关闭拒绝也 exit 3 但 stdout 为空、stderr PLAN_REFUSE）────────────────────

  const stopped = {
    planId: 'plan_stop', version: 3, decision: 'stop',
    estimate: { calls: 60, seconds: 3600, weight: 2 }, delta: { addedCalls: 60, addedSeconds: 3600 },
    cumulative: { calls: 120, seconds: 7200 }, reasonCode: 'HARD_LIMIT', status: 'stopped',
    noticeText: '累计查询已达本任务硬上限。',
  } as const;

  it('真实 CLI 形态 stop 裁决（exit 3 + decision JSON）走结构化 stop 分支，不是抛错', async () => {
    // 平台对 decision === 'stop' 返回 exit 3、stdout 仍是合法 PlanEvaluation JSON（cli/index.js）。
    // 裸 runJson 对非零 exit 一律抛错时，这个 stop 分支是死代码——真实 CLI 下不可达。
    const runCli: PlanCliRunner = async () => ({
      code: 3, stdout: `${JSON.stringify(stopped)}\n`, stderr: '',
    });
    const result = await evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      runCli,
    });
    expect(result.status).toBe('stop');
    if (result.status !== 'stop') throw new Error('expected a structured stop result');
    // 消息是 formatPlanMessage 的结构化输出（计划通知前缀 + 平台安全摘要），不是泛化 exit 3 串
    expect(result.message).toBe(formatPlanMessage(stopped));
    expect(result.message).toContain('计划通知：');
    expect(result.message).toContain('累计查询已达本任务硬上限');
    expect(result.message).not.toContain('exit 3');
    expect(result.evaluation).toEqual(stopped);
  });

  it('写关闭拒绝（exit 3 + stdout 为空 + stderr PLAN_REFUSE）维持既有抛错，供驱动映射写关闭话术', async () => {
    // 平台 canonicalCall 对含写操作的 evaluate 拒绝：stderr PLAN_REFUSE，stdout 为空（cli/index.js）。
    // 判据是 stdout 拿不出带 decision 的结构化裁决 → 维持今天的行为：抛错串里含平台确定性
    // 错误码，pi-coding-driver catch 分支据此定位失败，再按平台语义表分流该说哪句话
    // （要用户确认 → WRITE_NOT_ENABLED；不需要计划 → PLAN_NOT_PLANNABLE）。
    const runCli: PlanCliRunner = async () => ({
      code: 3, stdout: '', stderr: 'PLAN_REFUSE PLAN_OPERATION_NOT_READ_ONLY:voucher.commit\n',
    });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.commit', args: ['A', '202609'] }],
      runCli,
    })).rejects.toThrow('plan CLI 失败（plan evaluate）');
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.commit', args: ['A', '202609'] }],
      runCli,
    })).rejects.toThrow('PLAN_OPERATION_NOT_READ_ONLY');
  });

  it('exit 非零且 stdout 无 decision 字段（合法 JSON 但非裁决）不当作结构化结果', async () => {
    // stdout 能解析但不是裁决形状（如未来的错误详情 JSON）：拒绝被静默吞成 stop/执行。
    const runCli: PlanCliRunner = async () => ({
      code: 3, stdout: JSON.stringify({ error: 'PLAN_OPERATION_NOT_READ_ONLY' }), stderr: '',
    });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.commit', args: ['A', '202609'] }],
      runCli,
    })).rejects.toThrow('plan CLI 失败（plan evaluate）');
  });

  it('exit 非零且 stdout 残缺 JSON / 崩溃（exit 1）：维持既有抛错形态', async () => {
    const partial: PlanCliRunner = async () => ({ code: 3, stdout: '{"planId":"plan_x","decisi', stderr: '' });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      runCli: partial,
    })).rejects.toThrow('plan CLI 失败（plan evaluate）');
    const crashed: PlanCliRunner = async () => ({ code: 1, stdout: '', stderr: '' });
    await expect(evaluateAndActivatePlan({
      platformRoot: '/platform', taskId: 'task_1',
      calls: [{ operation: 'voucher.query-saved', args: ['A', '202609'] }],
      runCli: crashed,
    })).rejects.toThrow('exit 1');
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

// ── 写关闭判据（D-075：calls × 平台语义表 × 平台写开放声明，三个输入都非 worker 文本）──

/** 与平台 `operation list --json` 同形的预置语义表（三列由平台声明，宿主只读消费）。 */
const SEMANTICS = parseOperationSemantics(JSON.stringify({
  operations: [
    { name: 'finance.query-receivables', command: 'query-receivables', access: 'read' },
    { name: 'voucher.query-saved', command: 'query-saved', access: 'read' },
    { name: 'voucher.precheck', command: 'precheck', access: 'scratch' },
    { name: 'voucher.prepare', command: 'prepare', access: 'write' },
    { name: 'voucher.commit', command: 'commit', access: 'write' },
  ],
  accessSemantics: {
    read: { plan: true, confirm: false, mock: true },
    scratch: { plan: false, confirm: false, mock: false },
    write: { plan: true, confirm: true, mock: true },
  },
}));

describe('planWriteClosed（写关闭的机械判据）', () => {
  it('计划含要用户确认的 operation（confirm=true）且平台声明写未开放 →  true', () => {
    expect(planWriteClosed([{ operation: 'voucher.prepare', args: ['A', '202609'] }], SEMANTICS, false)).toBe(true);
    expect(planWriteClosed([{ operation: 'voucher.commit', args: ['A', '202609'] }], SEMANTICS, false)).toBe(true);
    // 混在只读调用里同样命中：准备流程中的写步骤让整份计划注定跑不完
    expect(planWriteClosed([
      { operation: 'voucher.query-saved', args: ['A', '202609'] },
      { operation: 'voucher.prepare', args: ['A', '202609'] },
    ], SEMANTICS, false)).toBe(true);
  });

  it('平台声明写开放 → 不触发布防（写开放部署照常走平台计划门）', () => {
    expect(planWriteClosed([{ operation: 'voucher.prepare', args: ['A'] }], SEMANTICS, true)).toBe(false);
  });

  it('纯只读 / scratch（本地处理）计划 → 不触发（两者都不要用户确认）', () => {
    expect(planWriteClosed([
      { operation: 'voucher.query-saved', args: ['A', '202609'] },
      { operation: 'voucher.precheck', args: [] },
    ], SEMANTICS, false)).toBe(false);
  });

  it('缺语义表 / operation 查不到语义 → 不触发（宁缺勿猜）', () => {
    // CLI 派生失败或平台还没下发 accessSemantics（空表）：前置判定整体不生效，
    // 平台计划门与提案路径照旧兜底——fail-closed 到什么都不算写
    expect(planWriteClosed([{ operation: 'voucher.prepare', args: ['A'] }], undefined, false)).toBe(false);
    expect(planWriteClosed([{ operation: 'voucher.prepare', args: ['A'] }], new Map(), false)).toBe(false);
    // 未登记的 operation：平台会以 UNKNOWN_OPERATION 拒绝，不猜它的访问语义
    expect(planWriteClosed([{ operation: 'voucher.batch', args: ['A'] }], SEMANTICS, false)).toBe(false);
    // writeEnabled 缺省（false）视为只读（与契约层同语义）：要用户确认的 operation 仍然触发
    expect(planWriteClosed([{ operation: 'voucher.prepare', args: ['A'] }], SEMANTICS, false)).toBe(true);
  });

  it('command 裸名写法同样命中（命令里两种写法都合法，键双收）', () => {
    expect(planWriteClosed([{ operation: 'prepare', args: ['A'] }], SEMANTICS, false)).toBe(true);
  });
});
