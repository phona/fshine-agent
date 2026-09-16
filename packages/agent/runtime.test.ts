import { describe, expect, it } from 'vitest';
import type { EnvelopeMeta, TrustedContext } from '@fshine/contracts';
import type { TurnDriverInput } from './src/driver';
import { ScriptedTurnDriver, type ScriptedTurnStep } from './src/driver';
import {
  createTaxAgentRuntime,
  FALLBACK_FAILURE,
  FALLBACK_TIMEOUT,
  type AgentSessionState,
} from './src';
import { FakeSessionRepo, FakeToolClient, fakeErr, fakeMeta, fakeOk } from './test-helpers';

const TWO = [
  { id: 'as_001', name: '幻晟' },
  { id: 'as_002', name: '幻晟二店' },
];

const VOUCHER_PAGE = {
  total: 45,
  docs: [
    { id: 'd1', type: '记', number: '001', journalDate: '2026-07-01', haveAnnex: 0, entryDtoList: [] },
    { id: 'd2', type: '记', number: '002', journalDate: '2026-07-02', haveAnnex: 1, entryDtoList: [] },
  ],
  nextCursor: 'eyJwYWdlTm8iOjF9',
};

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_test',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001', 'as_002'],
    sessionId: 'sess_1',
    ...overrides,
  };
}

/** 记录每次 driver.run 收到的模型上下文,便于断言历史重放与开场消息 */
function recordingDriver(script: ScriptedTurnStep[]) {
  const base = ScriptedTurnDriver(script);
  const inputs: TurnDriverInput[] = [];
  return {
    driver: {
      run: async (input: TurnDriverInput) => {
        inputs.push(input);
        return base.run(input);
      },
    } as import('./src/driver').TurnDriver,
    inputs,
  };
}

function fakeOkData(data: unknown, meta: Partial<EnvelopeMeta> = {}) {
  return fakeOk(data, fakeMeta(meta));
}

describe('createTaxAgentRuntime', () => {
  it('search → period → list_vouchers → reply,工具调用按序执行,最终文本带数据要素', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: [{ id: 'as_001', name: '幻晟' }] }),
      get_current_accounting_period: () =>
        fakeOk({ period: '202607' }, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
      list_vouchers: () =>
        fakeOk(
          { total: 45, docs: VOUCHER_PAGE.docs, nextCursor: 'eyJwYWdlTm8iOjF9' },
          fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' }),
        ),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }] },
      { toolCalls: [{ tool: 'get_current_accounting_period', args: { accountSetId: 'as_001' } }] },
      { toolCalls: [{ tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202607' } }] },
      { text: '账套「幻晟」202607 共 45 张凭证。来源:api_cache,取回时间:2026-09-15T10:00:00+08:00' },
    ];
    const { driver, inputs } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查一下幻晟本期的凭证', client);

    expect(reply.text).toContain('幻晟');
    expect(reply.text).toContain('202607');
    expect(reply.text).toContain('api_cache');
    expect(client.calls.map((call) => call.tool)).toEqual([
      'search_account_sets',
      'get_current_accounting_period',
      'list_vouchers',
    ]);
    // 开场消息只有当前用户问题;最终文本入库
    expect(inputs[0]!.messages).toHaveLength(1);
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.lastVoucherQuery?.accountSetId).toBe('as_001');
  });

  it('search 命中多个候选:回复编号列表,候选/过期时间/原始请求入库', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: TWO }),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }] },
      { text: '找到多个账套,请回复编号选择:1. 幻晟 2. 幻晟二店' },
    ];
    const { driver } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查幻晟的凭证', client);

    expect(reply.text).toContain('1. 幻晟');
    expect(reply.text).toContain('2. 幻晟二店');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toEqual(TWO);
    expect(state.expiresAt).toBeDefined();
    expect(Date.parse(state.expiresAt!)).toBeGreaterThan(Date.now());
    expect(state.pendingRequest).toBe('查幻晟的凭证');
  });

  it('第二轮回复"1":还原原始请求,查期间并拉取凭证,清理澄清状态', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      pendingCandidates: TWO,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pendingRequest: '查幻晟本期的凭证',
    });
    const client = new FakeToolClient({
      get_current_accounting_period: () =>
        fakeOk({ period: '202608' }, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
      list_vouchers: () =>
        fakeOk({ total: 3, docs: VOUCHER_PAGE.docs.slice(0, 2), nextCursor: undefined }),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'get_current_accounting_period', args: { accountSetId: 'as_001' } }] },
      { toolCalls: [{ tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202608' } }] },
      { text: '幻晟 202608 共 3 张凭证。' },
    ];
    const { driver, inputs } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '1', client);

    expect(reply.text).toContain('202608');
    expect(client.calls.map((call) => call.tool)).toEqual([
      'get_current_accounting_period',
      'list_vouchers',
    ]);
    // 合成开场消息携带用户原始请求,模型据此知道"1"是要继续查凭证
    expect(inputs[0]!.messages[0]!.content).toContain('查幻晟本期的凭证');
    expect(inputs[0]!.messages[0]!.content).toContain('as_001');

    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toBeUndefined();
    expect(state.expiresAt).toBeUndefined();
    expect(state.pendingRequest).toBeUndefined();
  });

  it('候选已过期:不复活,重新搜索并再次澄清', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      pendingCandidates: TWO,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      pendingRequest: '查幻晟的凭证',
    });
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: TWO }),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }] },
      { text: '找到多个账套,请选择' },
    ];
    const { driver } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '1', client);

    expect(reply.text).toContain('多个账套');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toEqual(TWO); // 重新搜索后再次入库
  });

  it('下一页:用会话里的游标续查并更新游标', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      lastVoucherQuery: {
        accountSetId: 'as_001',
        accountSetName: '幻晟',
        period: '202607',
        nextCursor: 'cur_1',
      },
    });
    const client = new FakeToolClient({
      list_vouchers: () =>
        fakeOk({ total: 45, docs: VOUCHER_PAGE.docs, nextCursor: 'cur_2' }),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202607', cursor: 'cur_1' } }] },
      { text: '第 2 页已取回' },
    ];
    const { driver, inputs } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '下一页', client);

    expect(reply.text).toContain('第 2 页');
    expect(client.calls[0]!.args).toMatchObject({ cursor: 'cur_1' });
    // 开场消息携带游标上下文
    expect(inputs[0]!.messages[0]!.content).toContain('cur_1');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.lastVoucherQuery?.nextCursor).toBe('cur_2');
  });

  it('ACCOUNT_SET_FORBIDDEN:确定性安全话术,不透出其他账套名与原始错误', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeErr('ACCOUNT_SET_FORBIDDEN', 'raw internal error'),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'search_account_sets', args: { query: ' forbidden ' } }] },
    ];
    const { driver } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查 forbidden 的凭证', client);

    expect(reply.text).toBe('没有该账套的访问权限');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toBeUndefined();
  });

  it('NEEDS_LOGIN:回复登录处理话术', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      get_login_status: () => fakeErr('NEEDS_LOGIN', 'raw'),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'get_login_status', args: {} }] },
    ];
    const { driver } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '看看登录状态', client);

    expect(reply.text).toContain('登录');
  });

  it('工具清单为空(host 连接未就绪):以失败话术收场,不进驱动', async () => {
    const sessions = new FakeSessionRepo();
    const driverCalls: TurnDriverInput[] = [];
    const driver = {
      run: async (input: TurnDriverInput) => {
        driverCalls.push(input);
        return { text: '不该被触达' };
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions });
    const emptyClient = {
      tools: () => [],
      call: async () => {
        throw new Error('不应被调用');
      },
    };

    const reply = await runtime.handleTurn(makeCtx(), '查一下', emptyClient);

    expect(reply.text).toBe(FALLBACK_FAILURE);
    expect(driverCalls).toHaveLength(0);
  });

  it('有界历史重放:第二轮请求携带上一轮的用户消息与最终回复', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: [{ id: 'as_001', name: '幻晟' }] }),
    });
    const script: ScriptedTurnStep[] = [
      { toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }] },
      { text: '幻晟(as_001)的当前期间是 202607。' },
      { text: '上一轮查询的是幻晟 202607' },
    ];
    const { driver, inputs } = recordingDriver(script);
    const runtime = createTaxAgentRuntime({ driver, sessions });

    await runtime.handleTurn(makeCtx(), '查一下幻晟本期的凭证', client);
    await runtime.handleTurn(makeCtx(), '刚才查的是哪个账套?', client);

    // 第二轮:历史(user + assistant)在前,当前任务在最后
    const second = inputs[1]!;
    const contents = second.messages.map((message) => message.content);
    expect(contents.some((content) => content.includes('查一下幻晟本期的凭证'))).toBe(true);
    expect(contents.some((content) => content.includes('202607'))).toBe(true);
    expect(second.messages[second.messages.length - 1]!.content).toContain('刚才查的是哪个账套?');

    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.history).toHaveLength(4); // 2 轮 × (user + assistant)
  });
});

// ---- 测试夹具 ----

async function seedState(sessions: FakeSessionRepo, state: AgentSessionState): Promise<void> {
  const { saveSessionState } = await import('./src/session');
  await saveSessionState(sessions, 'sess_1', 'wecom:user_a', state, null);
}
