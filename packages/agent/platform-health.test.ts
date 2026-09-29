/**
 * 平台健康信号（Lane 2「治标补法」）测试：连续 AUTH 类平台失败的会话级记账 + 冷却 +
 * 宿主合成终稿。共享生产代码：platform-health.ts（记账与冷却）、platform-contract.ts
 * （信封码级判据）、error-codes.ts（PLATFORM_UNAVAILABLE 措辞）、runtime.ts（接线）。
 *
 * 钉住四件事：
 *   ① 计数推进：1 次失败不冷却 / 2 次连续失败进冷却 / 冷却后探测成功清零 / 探测失败再冷却；
 *   ② 冷却期宿主前置拦截：零平台委派（不是"委派了再失败"），终稿是宿主合成消息；
 *   ③ 判据机械：只认平台错误信封的码（AUTH_* / NEEDS_LOGIN）与委派层挂码，不嗅探文本；
 *   ④ 措辞纪律：合成消息零内部控制词、零业务词、零执行语言指纹（生产指纹尺）。
 *
 * 时钟注入（deps.clock）让"冷却中 / 已到期"可确定性地推，不需要真等 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import {
  DEFAULT_PLATFORM_AUTH_FAILURE_THRESHOLD,
  DEFAULT_PLATFORM_COOLDOWN_MS,
  createPlatformHealthTracker,
  isAuthDelegationFailure,
  type PlatformHealthClock,
} from './src/platform-health';
import {
  PLATFORM_AUTH_ERROR_CODES,
  parseEnvelope,
  platformAuthFailureFromResponses,
  platformAuthFailureOf,
} from './src/platform-contract';
import { platformUnavailableTextFor } from './src/error-codes';
import { toolUserErrorFor } from './src/error-codes';
import { RUN_17DZ_TASK_DESCRIPTION, RUN_17DZ_TASK_SCHEMA, RUN_17DZ_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ScriptedTurnDriver, type ScriptedTurnStep, type TurnDriver } from './src/driver';
import { createTaxAgentRuntime, executionLanguageFingerprints } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_health',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001'],
    sessionId: 'sess_health',
    ...overrides,
  };
}

/** 可推的时钟：冷却判定只认 now()，测试推进它即可越过冷却窗口。 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock: PlatformHealthClock = { now: () => now };
  return { clock, advance: (ms: number) => { now += ms; }, at: () => now };
}

/** 一条 tool_result 消息（原生形状的最小构造：role + content 分段）。 */
function toolResult(text: string): { role: string; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'toolResult', content: [{ type: 'text', text }] };
}

/** 平台登录/凭据类失败信封：与真实网关 stdout 末行同形（status failed + 登录族错误码 → exit 1）。 */
function authEnvelope(code: string): string {
  return `RESULT ${JSON.stringify({
    v: 1, op: 'finance.query-receivables', status: 'failed', data: null,
    error: { code, message: `${code}: 平台登录态校验未通过` },
  })}`;
}

describe('平台健康记账器（连续 AUTH 类失败 → 冷却）', () => {
  it('默认阈值 2 次、默认冷却 10 分钟（部署侧经 FSHINE_PLATFORM_COOLDOWN_MS 覆盖）', () => {
    expect(DEFAULT_PLATFORM_AUTH_FAILURE_THRESHOLD).toBe(2);
    expect(DEFAULT_PLATFORM_COOLDOWN_MS).toBe(600_000);
  });

  it('1 次失败不冷却；第 2 次连续失败进冷却（窗口从第二次失败起算）', () => {
    const { clock, advance } = fakeClock();
    const health = createPlatformHealthTracker({ clock });

    const first = health.recordAuthFailure('sess');
    expect(first.consecutiveAuthFailures).toBe(1);
    expect(first.coolingDown).toBe(false);
    expect(health.isCoolingDown('sess')).toBe(false);

    advance(60_000);
    const second = health.recordAuthFailure('sess');
    expect(second.consecutiveAuthFailures).toBe(2);
    expect(second.coolingDown).toBe(true);
    // 窗口从这次失败起算，不是从第一次的残尾起算
    expect(second.cooldownRemainingMs).toBe(600_000);
    expect(health.isCoolingDown('sess')).toBe(true);
  });

  it('冷却期内 isCoolingDown 为真、剩余毫秒递减；到期后探测放行', () => {
    const { clock, advance } = fakeClock();
    const health = createPlatformHealthTracker({ clock, cooldownMs: 600_000 });
    health.recordAuthFailure('sess');
    health.recordAuthFailure('sess');

    advance(599_000);
    expect(health.isCoolingDown('sess')).toBe(true);
    expect(health.cooldownRemainingMs('sess')).toBe(1_000);
    expect(health.cooldownReply('sess')).toContain('约 1 分钟');

    advance(1_000);
    expect(health.isCoolingDown('sess')).toBe(false);
    expect(health.cooldownRemainingMs('sess')).toBe(0);
  });

  it('冷却后探测成功（recordResolved）：计数清零、冷却解除、条目删除', () => {
    const { clock, advance } = fakeClock();
    const health = createPlatformHealthTracker({ clock });
    health.recordAuthFailure('sess');
    health.recordAuthFailure('sess');
    advance(600_001);

    health.recordResolved('sess');

    expect(health.consecutiveAuthFailures('sess')).toBe(0);
    expect(health.isCoolingDown('sess')).toBe(false);
    // 恢复后地图不留条目：读路径不建条目（没失败过的会话不占地图）
    expect(health.cooldownRemainingMs('sess')).toBe(0);
  });

  it('冷却后探测失败：再进一轮等长冷却（有界——每轮都要用户先发一句话）', () => {
    const { clock, advance } = fakeClock();
    const health = createPlatformHealthTracker({ clock, cooldownMs: 600_000 });
    health.recordAuthFailure('sess');
    health.recordAuthFailure('sess');
    advance(600_001);
    expect(health.isCoolingDown('sess')).toBe(false);

    const probe = health.recordAuthFailure('sess');
    expect(probe.consecutiveAuthFailures).toBe(3);
    expect(probe.coolingDown).toBe(true);
    expect(probe.cooldownRemainingMs).toBe(600_000);
  });

  it('按会话隔离：一个会话的连续失败不污染另一个会话', () => {
    const { clock } = fakeClock();
    const health = createPlatformHealthTracker({ clock });
    health.recordAuthFailure('sess_a');
    health.recordAuthFailure('sess_a');
    expect(health.isCoolingDown('sess_a')).toBe(true);
    expect(health.isCoolingDown('sess_b')).toBe(false);
    expect(health.consecutiveAuthFailures('sess_b')).toBe(0);
  });

  it('阈值可配置（依赖注入）：阈值 3 时第 2 次失败仍不冷却', () => {
    const { clock } = fakeClock();
    const health = createPlatformHealthTracker({ clock, threshold: 3 });
    health.recordAuthFailure('sess');
    health.recordAuthFailure('sess');
    expect(health.isCoolingDown('sess')).toBe(false);
    expect(health.recordAuthFailure('sess').coolingDown).toBe(true);
  });
});

describe('AUTH 类失败的机械判据（码级，不嗅探文本）', () => {
  it('isAuthDelegationFailure：只认委派层挂码 DELEGATION_AUTH_FAILURE', () => {
    expect(isAuthDelegationFailure(toolUserErrorFor('DELEGATION_AUTH_FAILURE'))).toBe(true);
    expect(isAuthDelegationFailure(toolUserErrorFor('DELEGATION_TIMEOUT_FAILURE'))).toBe(false);
    expect(isAuthDelegationFailure(toolUserErrorFor('TASK_NOT_FOUND'))).toBe(false);
    expect(isAuthDelegationFailure(new Error('平台登录已过期，请重新登录'))).toBe(false);
    expect(isAuthDelegationFailure(null)).toBe(false);
  });

  it('信封判据 = 平台错误码 ∈ 登录/凭据族集合（AUTH_* 四档 + NEEDS_LOGIN 归一码 + D-076 登录流程两码）', () => {
    expect([...PLATFORM_AUTH_ERROR_CODES].sort()).toEqual([
      'AUTH_EXPIRED', 'AUTH_REDIRECTED_TO_LOGIN', 'AUTH_REJECTED', 'AUTH_UNKNOWN', 'AUTH_WORKBENCH_NOT_READY', 'LOGIN_PAGE_CHANGED', 'NEEDS_LOGIN',
    ]);
    for (const code of PLATFORM_AUTH_ERROR_CODES) {
      expect(platformAuthFailureOf(parseEnvelope(authEnvelope(code)))).toEqual({ code });
    }
  });

  it('platformAuthFailureFromResponses：只看收尾那一条信封（恢复即不算失败）', () => {
    // 收尾是登录族失败信封 → 记失败
    expect(platformAuthFailureFromResponses([toolResult(authEnvelope('NEEDS_LOGIN'))])).toEqual({ code: 'NEEDS_LOGIN' });
    // 早先登录抖动之后重查成功（completed）：平台健康已恢复，旧信封不得劫持本回合
    expect(platformAuthFailureFromResponses([
      toolResult(authEnvelope('AUTH_EXPIRED')),
      toolResult('RESULT {"v":1,"op":"finance.query-receivables","status":"completed","data":{"balance":42},"error":null}'),
    ])).toBeUndefined();
    // 收尾是其他错误码 / 没有信封 / 空转录 → 不记
    expect(platformAuthFailureFromResponses([
      toolResult('RESULT {"v":1,"op":"x","status":"failed","data":null,"error":{"code":"INVALID_PERIOD","message":"…"}}'),
    ])).toBeUndefined();
    expect(platformAuthFailureFromResponses([toolResult('子 Agent：平台说登录态可能有问题')])).toBeUndefined();
    expect(platformAuthFailureFromResponses([])).toBeUndefined();
  });
});

// ── runtime 接线：回合级计数推进与冷却拦截 ─────────────────────────────────
//
// 计数推进的五条路径全部走真实 createTaxAgentRuntime + ScriptedTurnDriver：
// 委派替身返回驱动派生的 authFailure（信封路径）或抛出挂码 ToolUserError（委派层路径）。

const DELEGATE_REQUEST = '查询幻辰财税账套的应收账款余额';

function delegateScript(): ScriptedTurnStep[] {
  return [{ toolCalls: [{ tool: 'route_current_turn', args: { kind: 'delegate', request: DELEGATE_REQUEST } }] }];
}

/** 可切换结局的平台委派替身：auth = 登录族失败信封路径；ok = 正常执行路径。 */
function platformStub(initial: 'auth' | 'ok' = 'auth') {
  let calls = 0;
  let mode: 'auth' | 'ok' = initial;
  const runner: ContextTaskRunner = {
    tool: { name: RUN_17DZ_TASK_TOOL, description: RUN_17DZ_TASK_DESCRIPTION, inputSchema: RUN_17DZ_TASK_SCHEMA },
    run: async (): Promise<SubagentTaskResult> => {
      calls += 1;
      if (mode === 'auth') {
        // 与真实驱动同形：失败的那次网关调用真发生过（execution 为真），authFailure 由
        // 平台错误信封派生（NEEDS_LOGIN，脚本层对 AuthExpiredError 的归一码）。
        return {
          taskId: `task_${calls}`,
          text: '平台登录态校验未通过，本轮没有取到任何数据。',
          execution: { planId: 'plan_x', version: 1, calls: 1 },
          authFailure: { code: 'NEEDS_LOGIN' },
        };
      }
      return {
        taskId: `task_${calls}`,
        text: '本轮实时查询：幻辰财税 202609 应收余额为 51 元。',
        execution: { planId: 'plan_x', version: 1, calls: 1 },
      };
    },
  };
  return { runner, calls: () => calls, setMode: (next: 'auth' | 'ok') => { mode = next; } };
}

/** 委派即抛挂码 ToolUserError 的替身（context.ts 失败分类路径，恢复路径用）。 */
function throwingAuthStub() {
  let calls = 0;
  const runner: ContextTaskRunner = {
    tool: { name: RUN_17DZ_TASK_TOOL, description: RUN_17DZ_TASK_DESCRIPTION, inputSchema: RUN_17DZ_TASK_SCHEMA },
    run: async (): Promise<SubagentTaskResult> => {
      calls += 1;
      throw toolUserErrorFor('DELEGATION_AUTH_FAILURE');
    },
  };
  return { runner, calls: () => calls };
}

const COOLDOWN_MS = 600_000;

function runtimeWith(deps: {
  platformTask: ContextTaskRunner;
  clock: PlatformHealthClock;
  driver?: TurnDriver;
  sessions?: FakeSessionRepo;
}) {
  return createTaxAgentRuntime({
    driver: deps.driver ?? ScriptedTurnDriver(delegateScript()),
    sessions: deps.sessions ?? new FakeSessionRepo(),
    platformTask: deps.platformTask,
    clock: deps.clock,
    platformCooldownMs: COOLDOWN_MS,
  });
}

describe('runtime 平台健康接线：计数推进', () => {
  it('1 次 AUTH 失败不进冷却：下一回合照常委派（平台调用真发生）', async () => {
    const { clock } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    const first = await runtime.handleTurn(makeCtx({ requestId: 'req_h1' }), '查一下幻辰财税的应收账款');
    expect(first.text).toBe('平台登录态校验未通过，本轮没有取到任何数据。');
    expect(platform.calls()).toBe(1);

    const second = await runtime.handleTurn(makeCtx({ requestId: 'req_h2' }), '再查一次');
    // 阈值 2：单次失败不拦截，用户重问仍然真调一次平台
    expect(platform.calls()).toBe(2);
    expect(second.text).toBe('平台登录态校验未通过，本轮没有取到任何数据。');
  });

  it('2 次连续 AUTH 失败进冷却：第三回合零平台委派，终稿是宿主合成消息', async () => {
    const { clock } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h3' }), '查一下');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h4' }), '再查');
    expect(platform.calls()).toBe(2);

    const third = await runtime.handleTurn(makeCtx({ requestId: 'req_h5' }), '还是查一下');

    // 冷却期内宿主前置拦截：零平台委派（不是"委派了再失败"）
    expect(platform.calls()).toBe(2);
    // 终稿 = 宿主合成消息（error-codes.ts 唯一措辞来源 + 剩余分钟数）
    expect(third.text).toBe(platformUnavailableTextFor(10));
    // 措辞纪律：零执行语言指纹（内部控制词/错误码/协议形状一个都不带）
    expect(executionLanguageFingerprints(third.text)).toEqual([]);
    expect(third.text).not.toContain('NEEDS_LOGIN');
  });

  it('非 AUTH 成功回合清零：失败 → 成功 → 失败 不累积到阈值', async () => {
    const { clock } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h6' }), '查一下');
    expect(platform.calls()).toBe(1);
    platform.setMode('ok');
    const ok = await runtime.handleTurn(makeCtx({ requestId: 'req_h7' }), '再查');
    expect(ok.text).toBe('本轮实时查询：幻辰财税 202609 应收余额为 51 元。');
    expect(platform.calls()).toBe(2);

    platform.setMode('auth');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h8' }), '又查');
    expect(platform.calls()).toBe(3);
    // 计数已被成功回合清零：这一次失败只是第 1 次，下一回合仍放行
    await runtime.handleTurn(makeCtx({ requestId: 'req_h9' }), '再查一次');
    expect(platform.calls()).toBe(4);
  });

  it('冷却到期后探测成功：计数清零，后续失败重新从 1 计', async () => {
    const { clock, advance } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h10' }), '查一下');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h11' }), '再查');
    expect(platform.calls()).toBe(2);

    advance(COOLDOWN_MS + 1);
    platform.setMode('ok');
    const probe = await runtime.handleTurn(makeCtx({ requestId: 'req_h12' }), '还查吗');
    expect(probe.text).toBe('本轮实时查询：幻辰财税 202609 应收余额为 51 元。');
    expect(platform.calls()).toBe(3);

    platform.setMode('auth');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h13' }), '再查');
    expect(platform.calls()).toBe(4);
    // 清零后这一次失败只是第 1 次：不进冷却
    await runtime.handleTurn(makeCtx({ requestId: 'req_h14' }), '再查一次');
    expect(platform.calls()).toBe(5);
  });

  it('冷却到期后探测失败：再进一轮等长冷却，下一回合又被拦截', async () => {
    const { clock, advance } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h15' }), '查一下');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h16' }), '再查');
    expect(platform.calls()).toBe(2);

    advance(COOLDOWN_MS + 1);
    // 冷却已到期：这一回合允许一次探测性调用（真调平台）
    const probe = await runtime.handleTurn(makeCtx({ requestId: 'req_h17' }), '还查');
    expect(platform.calls()).toBe(3);
    expect(probe.text).toBe('平台登录态校验未通过，本轮没有取到任何数据。');

    // 探测失败 → 再进一轮冷却：下一回合零委派
    const blocked = await runtime.handleTurn(makeCtx({ requestId: 'req_h18' }), '再试');
    expect(platform.calls()).toBe(3);
    expect(blocked.text).toBe(platformUnavailableTextFor(10));
  });

  it('恢复路径（resumeTaskId）：auth 类 ToolUserError 同样计数，达阈值即冷却拦截', async () => {
    const { clock } = fakeClock();
    const platform = throwingAuthStub();
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    const first = await runtime.handleTurn(makeCtx({ requestId: 'req_h19', resumeTaskId: 'task_resumed' }), '确认继续');
    expect(first.text).toBe('平台登录态过期，需要重新登录后才能继续查询。');
    expect(platform.calls()).toBe(1);

    await runtime.handleTurn(makeCtx({ requestId: 'req_h20', resumeTaskId: 'task_resumed' }), '继续');
    expect(platform.calls()).toBe(2);

    // 第三回合：冷却期内不发起平台调用（恢复路径同样是真实委派）
    const blocked = await runtime.handleTurn(makeCtx({ requestId: 'req_h21', resumeTaskId: 'task_resumed' }), '继续');
    expect(platform.calls()).toBe(2);
    expect(blocked.text).toBe(platformUnavailableTextFor(10));
  });

  it('冷却消息的分钟数随剩余时间递减（宿主时钟数据，不是写死的 10）', async () => {
    const { clock, advance } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h22' }), '查一下');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h23' }), '再查');

    advance(4 * 60_000);
    const blocked = await runtime.handleTurn(makeCtx({ requestId: 'req_h24' }), '还查');
    expect(platform.calls()).toBe(2);
    expect(blocked.text).toBe(platformUnavailableTextFor(6));
    expect(blocked.text).toContain('约 6 分钟后自动恢复尝试');
  });

  it('会话隔离：另一会话的连续失败不把本会话拖进冷却', async () => {
    const { clock } = fakeClock();
    const platform = platformStub('auth');
    const runtime = runtimeWith({ platformTask: platform.runner, clock });

    await runtime.handleTurn(makeCtx({ requestId: 'req_h25', sessionId: 'sess_other' }), '查一下');
    await runtime.handleTurn(makeCtx({ requestId: 'req_h26', sessionId: 'sess_other' }), '再查');
    // 另一个会话已进冷却；本会话第一次失败照样放行
    const mine = await runtime.handleTurn(makeCtx({ requestId: 'req_h27' }), '查一下');
    expect(mine.text).toBe('平台登录态校验未通过，本轮没有取到任何数据。');
    expect(platform.calls()).toBe(3);
  });
});
