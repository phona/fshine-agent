/**
 * parsePlanCallsCommand 形状模糊测试（表驱动 corpus，纯单测，不依赖平台 CLI）。
 *
 * 覆盖：嵌套/合法 JSON、payload 里藏保留子命令（evaluate/activate/current/status）、
 * 非 bash 前缀（python/围栏/外层引号）、user_confirmed 只审计不授权、缺失 calls、
 * call 缺 operation/args、args 非数组、多余字段（宿主侧容忍，平台 schema 另判）、
 * 空串与纯垃圾（三态分辨返回 null）。
 *
 * 纪律：每条断言认结构化错误码（error.code），不认消息措辞——措辞在 error-codes.ts
 * 表里自由演化，码不变。
 */
import { describe, expect, it } from 'vitest';
import { evaluateAndActivatePlan, parsePlanCallsCommand, type PlanCliRunner } from './plan-runtime';

const VALID = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税","--period","202609"]}]}';

/** 抛错形状断言：只认 error.code（errorFor 把码挂回错误对象）。 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: unknown }).code, `期望错误码 ${code}，实际消息: ${(error as Error).message}`).toBe(code);
    expect((error as Error).message).toContain(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，实际没有抛`);
}

/** 合法形状：原样返回 calls，且不带 userConfirmed 键。 */
describe('plan-shape-fuzz：合法形状原样通过', () => {
  const okCases: Array<{ name: string; command: string; calls: unknown[] }> = [
    {
      name: '最小合法计划',
      command: VALID,
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202609'] }],
    },
    {
      name: '嵌套 JSON：args 里的对象值原样透传（per-call 深校验在平台侧，宿主只验形状）',
      command: 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":[{"nested":{"period":"202609"}}]}]}',
      calls: [{ operation: 'finance.query-receivables', args: [{ nested: { period: '202609' } }] }],
    },
    {
      name: '声明过的可选元数据（goal/requestId）不拦',
      command: 'bin/17dz plan {"goal":"查余额","requestId":"req_1","calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税"]}]}',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
    },
    {
      name: '未声明的顶层多余字段：宿主解析容忍（平台 schema 以 PLAN_UNKNOWN_FIELD 另判，不静默混层级）',
      command: 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税"]}],"mystery":1}',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
    },
    {
      name: 'call 内多余字段：宿主只取 operation/args',
      command: 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税"],"note":"x"}]}',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
    },
    {
      name: 'bash 前缀合法',
      command: `bash ${VALID}`,
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202609'] }],
    },
    {
      name: '路径前缀合法（绝对路径调用网关）',
      command: '/tmp/17dz-platform/bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税"]}]}',
      calls: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
    },
  ];

  for (const { name, command, calls } of okCases) {
    it(name, () => {
      const parsed = parsePlanCallsCommand(command);
      expect(parsed).not.toBeNull();
      expect(parsed!['userConfirmed']).toBeUndefined();
      expect(parsed!['calls']).toEqual(calls);
    });
  }

  it('user_confirmed:true 原样记录为审计字段（不是授权输入）', () => {
    const parsed = parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":[]}],"user_confirmed":true}');
    expect(parsed).toEqual({
      calls: [{ operation: 'finance.query-receivables', args: [] }],
      userConfirmed: true,
    });
  });

  it('user_confirmed 缺省 / false / 非布尔：都不产出 userConfirmed 键', () => {
    const payload = '{"calls":[{"operation":"finance.query-receivables","args":[]}],"user_confirmed":%s}';
    for (const raw of ['false', '"yes"', '1', 'null']) {
      const parsed = parsePlanCallsCommand(`bin/17dz plan ${payload.replace('%s', raw)}`);
      expect(parsed).toEqual({ calls: [{ operation: 'finance.query-receivables', args: [] }] });
    }
  });
});

/** 三态分辨之①：没有 plan 令牌 → 真不是计划命令，返回 null 走常规 CLI 检查。 */
describe('plan-shape-fuzz：非计划命令返回 null（不响亮报错）', () => {
  const nullCases: Array<{ name: string; command: string }> = [
    { name: '空串', command: '' },
    { name: '纯垃圾', command: '今天天气怎么样' },
    { name: '网关 query 无 plan 令牌', command: 'bin/17dz query query-receivables.js --query 幻辰财税' },
    { name: 'plan 令牌残缺（plann 不是 plan）', command: 'bin/17dz plann {"calls":[]}' },
    { name: '别的路径里的 plan 字样', command: 'cat plan.txt' },
  ];

  for (const { name, command } of nullCases) {
    it(name, () => {
      expect(parsePlanCallsCommand(command)).toBeNull();
    });
  }
});

/** 三态分辨之②：有 plan 令牌但形状不符 → 响亮抛结构化错误码。 */
describe('plan-shape-fuzz：形状错误抛结构化错误码', () => {
  const throwCases: Array<{ name: string; command: string; code: string }> = [
    // ── 前缀类 ──
    { name: '非 bash 前缀（python -c）', command: `python -c 'import json' ${VALID}`, code: 'PLAN_SHAPE_PREFIX' },
    { name: 'markdown 围栏前缀', command: '```bash\nbin/17dz plan {"calls":[{"operation":"x","args":[]}]}\n```', code: 'PLAN_SHAPE_PREFIX' },
    { name: '外层引号前缀', command: '"bin/17dz plan {"calls":[{"operation":"x","args":[]}]}', code: 'PLAN_SHAPE_PREFIX' },
    { name: '客套话前缀', command: `请帮我提交这个计划：${VALID}`, code: 'PLAN_SHAPE_PREFIX' },
    // ── payload 类 ──
    { name: 'plan 之后无 payload', command: 'bin/17dz plan', code: 'PLAN_SHAPE_PAYLOAD' },
    { name: 'plan 之后只有空白', command: 'bin/17dz plan   ', code: 'PLAN_SHAPE_PAYLOAD' },
    { name: 'payload 藏保留子命令 evaluate', command: 'bin/17dz plan evaluate {"calls":[{"operation":"x","args":[]}]}', code: 'PLAN_SUBCOMMAND_RESERVED' },
    { name: 'payload 藏保留子命令 activate', command: 'bin/17dz plan activate {"calls":[{"operation":"x","args":[]}]}', code: 'PLAN_SUBCOMMAND_RESERVED' },
    { name: 'payload 藏保留子命令 current', command: 'bin/17dz plan current {"calls":[{"operation":"x","args":[]}]}', code: 'PLAN_SUBCOMMAND_RESERVED' },
    { name: 'payload 藏保留子命令 status', command: 'bin/17dz plan status {"calls":[{"operation":"x","args":[]}]}', code: 'PLAN_SUBCOMMAND_RESERVED' },
    { name: 'JSON 语法坏（未引号键）', command: 'bin/17dz plan {calls:1}', code: 'PLAN_JSON_PARSE' },
    { name: 'JSON 语法坏（裸词）', command: 'bin/17dz plan not-json', code: 'PLAN_JSON_PARSE' },
    { name: '顶层是数组', command: 'bin/17dz plan [1,2]', code: 'PLAN_JSON_NOT_OBJECT' },
    { name: '顶层是 null', command: 'bin/17dz plan null', code: 'PLAN_JSON_NOT_OBJECT' },
    { name: '顶层是数字', command: 'bin/17dz plan 42', code: 'PLAN_JSON_NOT_OBJECT' },
    // ── calls 类 ──
    { name: '缺失 calls', command: 'bin/17dz plan {"goal":"x"}', code: 'PLAN_CALLS_NOT_ARRAY' },
    { name: 'calls 是 null', command: 'bin/17dz plan {"calls":null}', code: 'PLAN_CALLS_NOT_ARRAY' },
    { name: 'calls 是字符串', command: 'bin/17dz plan {"calls":"x"}', code: 'PLAN_CALLS_NOT_ARRAY' },
    { name: 'calls 为空数组', command: 'bin/17dz plan {"calls":[]}', code: 'PLAN_CALLS_EMPTY' },
    { name: 'call 项是字符串', command: 'bin/17dz plan {"calls":["x"]}', code: 'PLAN_CALL_NOT_OBJECT' },
    { name: 'call 项是 null', command: 'bin/17dz plan {"calls":[null]}', code: 'PLAN_CALL_NOT_OBJECT' },
    { name: 'call 项是数组', command: 'bin/17dz plan {"calls":[[1]]}', code: 'PLAN_CALL_NOT_OBJECT' },
    { name: 'call 缺 operation', command: 'bin/17dz plan {"calls":[{"args":[]}]}', code: 'PLAN_CALL_FIELDS' },
    { name: 'call 缺 args', command: 'bin/17dz plan {"calls":[{"operation":"x"}]}', code: 'PLAN_CALL_FIELDS' },
    { name: 'call 空对象', command: 'bin/17dz plan {"calls":[{}]}', code: 'PLAN_CALL_FIELDS' },
    { name: 'operation 非字符串', command: 'bin/17dz plan {"calls":[{"operation":1,"args":[]}]}', code: 'PLAN_CALL_FIELDS' },
    { name: 'operation 空串', command: 'bin/17dz plan {"calls":[{"operation":"","args":[]}]}', code: 'PLAN_CALL_OPERATION_EMPTY' },
    { name: 'operation 纯空白', command: 'bin/17dz plan {"calls":[{"operation":"  ","args":[]}]}', code: 'PLAN_CALL_OPERATION_EMPTY' },
    { name: 'args 是字符串', command: 'bin/17dz plan {"calls":[{"operation":"x","args":"--query"}]}', code: 'PLAN_CALL_ARGS_NOT_ARRAY' },
    { name: 'args 是对象', command: 'bin/17dz plan {"calls":[{"operation":"x","args":{}}]}', code: 'PLAN_CALL_ARGS_NOT_ARRAY' },
    { name: '第二个 call 的 args 非数组（带下标）', command: 'bin/17dz plan {"calls":[{"operation":"x","args":[]},{"operation":"y","args":"z"}]}', code: 'PLAN_CALL_ARGS_NOT_ARRAY' },
  ];

  for (const { name, command, code } of throwCases) {
    it(`${name} → ${code}`, () => {
      expectCode(() => parsePlanCallsCommand(command), code);
    });
  }
});

/**
 * user_confirmed 的授权语义：模型自报确认只进审计，runtime 绝不当授权用。
 * 钉三件事：① confirm 档裁决不因 user_confirmed:true 放行；② 宿主发给平台 evaluate 的
 * payload 里根本没有这个字段（模型声明不进跨仓协议）；③ 有没有该字段，行为逐字一致。
 */
describe('plan-shape-fuzz：user_confirmed 只审计不授权', () => {
  const confirmEvaluation = {
    planId: 'plan_c1', version: 1, decision: 'confirm',
    estimate: { calls: 3, seconds: 45 }, delta: { addedCalls: 3 },
    cumulative: { calls: 0, seconds: 0 }, reasonCode: 'CONFIRM_THRESHOLD', status: 'pending',
  };

  function fakeRunner(captured: { stdin: string[] }): PlanCliRunner {
    return async ({ input }) => {
      captured.stdin.push(String(input ?? ''));
      return { code: 0, stdout: JSON.stringify(confirmEvaluation), stderr: '' };
    };
  }

  it('user_confirmed:true 撞上 confirm 档：照样停在确认门，不激活不执行', async () => {
    const captured = { stdin: [] as string[] };
    const notices: string[] = [];
    const result = await evaluateAndActivatePlan({
      platformRoot: '/unused', taskId: 'task_fuzz', calls: [{ operation: 'x', args: [] }],
      userConfirmed: true,
      onNotice: async (text) => { notices.push(text); },
      runCli: fakeRunner(captured),
      activationSecret: 'fuzz-secret',
    });

    expect(result.status).toBe('confirm');
    // 通知送达是激活授权的一部分：模型声明不能替代它
    expect(notices).toHaveLength(1);
    // 宿主发给平台的 evaluate payload 只有 calls/requestId——模型的 user_confirmed 不进协议
    const sent = JSON.parse(captured.stdin[0]!) as Record<string, unknown>;
    expect(sent).toEqual({ calls: [{ operation: 'x', args: [] }] });
    expect('user_confirmed' in sent).toBe(false);
  });

  it('userConfirmed 缺省与 true 的行为差异为零（同一份裁决、同一条通知）', async () => {
    const run = (userConfirmed?: boolean) => {
      const captured = { stdin: [] as string[] };
      const notices: string[] = [];
      return evaluateAndActivatePlan({
        platformRoot: '/unused', taskId: 'task_fuzz', calls: [{ operation: 'x', args: [] }],
        ...(userConfirmed === undefined ? {} : { userConfirmed }),
        onNotice: async (text) => { notices.push(text); },
        runCli: fakeRunner(captured),
        activationSecret: 'fuzz-secret',
      }).then((result) => ({ result, notices, sent: captured.stdin }));
    };
    const without = await run();
    const withClaim = await run(true);
    expect(without.result.status).toBe(withClaim.result.status);
    expect(without.sent).toEqual(withClaim.sent);
    expect(without.notices).toEqual(withClaim.notices);
  });
});
