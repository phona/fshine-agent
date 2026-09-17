import { describe, expect, it } from 'vitest';
import type { TurnDriverInput } from './src/driver';
import type { DiscoveredTool, HostToolClient, ToolOutcome, TrustedContext } from '@fshine/contracts';
import { ScriptedTurnDriver, type ScriptedTurnStep } from './src/driver';
import { ACCOUNT_SET_SEARCH_MISS, createTaxAgentRuntime, FALLBACK_FAILURE, FALLBACK_TIMEOUT } from './src';
import { FakeSessionRepo, FakeToolClient, fakeErr, fakeOk } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_test',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001'],
    sessionId: 'sess_1',
    ...overrides,
  };
}

/** 记录每次 driver.run 收到的模型上下文,便于断言转录跨回合传递 */
function recordingDriver(script: ScriptedTurnStep[]) {
  const base = ScriptedTurnDriver(script);
  const inputs: TurnDriverInput[] = [];
  return {
    driver: {
      run: async (input: TurnDriverInput) => {
        inputs.push(input);
        return base.run(input);
      },
      compact: undefined,
    } as import('./src/driver').TurnDriver,
    inputs,
  };
}

const READ_TOOLS: DiscoveredTool[] = [
  { name: 'search_account_sets', description: '搜账套', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_vouchers', description: '查凭证', inputSchema: { type: 'object', properties: {} } },
];

function fullClient(): HostToolClient {
  return { tools: () => READ_TOOLS, call: async () => fakeOk({}) };
}

type TestHandler = (args: Record<string, unknown>) => ToolOutcome;

function client(handlers: Partial<Record<string, TestHandler>> = {}): HostToolClient {
  const table = new Map(Object.entries(handlers));
  return {
    tools: () => READ_TOOLS,
    call: async (tool: Parameters<HostToolClient['call']>[0], args: Record<string, unknown>) => {
      const handler = table.get(tool as string);
      return handler ? handler(args) : fakeOk({});
    },
  };
}

describe('createTaxAgentRuntime(转录即状态)', () => {
  it('回合结束后转录持久化:含用户消息与最终回复', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '好的,已查询。' }]),
      sessions,
    });
    await runtime.handleTurn(makeCtx(), '你好', client());

    const state = sessions.peek('sess_1')!.state as Array<{ role: string; content: string }>;
    expect(Array.isArray(state)).toBe(true);
    expect(state).toHaveLength(2);
    expect(state[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(state[1]!.role).toBe('assistant');
  });

  it('跨回合:第二轮模型上下文包含第一轮的完整对话', async () => {
    const sessions = new FakeSessionRepo();
    const { driver, inputs } = recordingDriver([{ text: '第一轮回复' }, { text: '第二轮回复' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions });
    await runtime.handleTurn(makeCtx(), '第一句话', client());
    await runtime.handleTurn(makeCtx(), '第二句话', client());

    const secondTurnContext = inputs[1]!.messages as Array<{ role: string; content: string }>;
    expect(secondTurnContext.some((m) => m.role === 'user' && m.content === '第一句话')).toBe(true);
    expect(secondTurnContext.some((m) => m.role === 'assistant' && m.content === '第一轮回复')).toBe(true);
    expect(secondTurnContext[secondTurnContext.length - 1]!.content).toBe('第二句话');
  });

  it('工具结果留在回合内:第二轮上下文不包含上一轮的 list_vouchers 原始结果', async () => {
    const sessions = new FakeSessionRepo();
    const client_ = client({ list_vouchers: () => fakeOk({ total: 15, docs: [{ secret: 'page-data' }] }) });
    const { driver, inputs } = recordingDriver([
      { toolCalls: [{ tool: 'list_vouchers', args: {} }], text: '第一页结果' },
      { text: '收到' },
    ]);
    const runtime = createTaxAgentRuntime({ driver, sessions });
    await runtime.handleTurn(makeCtx(), '查凭证', client_);
    await runtime.handleTurn(makeCtx(), '收到没', client_);

    const secondTurn = JSON.stringify(inputs[1]!.messages);
    expect(secondTurn).not.toContain('page-data');
  });

  it('TTL 过期 → 旧转录经 compact 强制压成种子续用(软着陆,不失忆)', async () => {
    const sessions = new FakeSessionRepo();
    const base = ScriptedTurnDriver([{ text: '第一轮' }, { text: '过期后' }]);
    const inputs: TurnDriverInput[] = [];
    const forcedCompacts: number[] = [];
    const SEED = '【此前会话摘要】用户此前在查幻晟 as_001 202608 的凭证';
    const driver: import('./src/driver').TurnDriver = {
      run: async (input) => {
        inputs.push(input);
        return base.run(input);
      },
      compact: async (_messages, opts) => {
        if (opts?.force) forcedCompacts.push(1);
        return [{ role: 'user', content: SEED, timestamp: Date.now() } as unknown as import('./src/driver').DriverMessage];
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions, sessionTtlMs: 300_000 });
    await runtime.handleTurn(makeCtx(), '第一句话', client());
    // 把 updatedAt 拨回 10 分钟前 → 超过 5 分钟 TTL
    const record = sessions.peek('sess_1')!;
    sessions.upsert({ ...record, updatedAt: new Date(Date.now() - 600_000).toISOString() });

    await runtime.handleTurn(makeCtx(), '继续看', client());
    expect(forcedCompacts).toHaveLength(1); // 只有过期那回合强制压缩
    const secondTurnContext = inputs[1]!.messages as Array<{ role: string; content: string }>;
    expect(secondTurnContext.some((m) => m.content === SEED)).toBe(true);
    expect(secondTurnContext[secondTurnContext.length - 1]!.content).toBe('继续看');
  });

  it('TTL 过期 + driver 无 compact 能力 → 旧转录原样续用(宁可带旧上下文,不做静默清零)', async () => {
    const sessions = new FakeSessionRepo();
    const { driver, inputs } = recordingDriver([{ text: '第一轮' }, { text: '过期后' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions, sessionTtlMs: 300_000 });
    await runtime.handleTurn(makeCtx(), '第一句话', client());
    const record = sessions.peek('sess_1')!;
    sessions.upsert({ ...record, updatedAt: new Date(Date.now() - 600_000).toISOString() });

    await runtime.handleTurn(makeCtx(), '还在吗', client());
    const secondTurnContext = inputs[1]!.messages as Array<{ role: string; content: string }>;
    expect(secondTurnContext.some((m) => m.content === '第一句话')).toBe(true);
  });

  it('NEEDS_LOGIN 工具错误 → 确定性话术终结', async () => {
    const sessions = new FakeSessionRepo();
    const client_ = client({ get_login_status: () => fakeErr('NEEDS_LOGIN', '登录失效') });
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: 'get_login_status', args: {} }], text: '占位' }]),
      sessions,
    });
    const reply = await runtime.handleTurn(makeCtx(), '查一下', client_);
    expect(reply.text).toContain('登录');
  });

  it('空文本 → FALLBACK_FAILURE,转录仍保存', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }] }]),
      sessions,
    });
    const reply = await runtime.handleTurn(makeCtx(), '查一下幻晟', client({ search_account_sets: () => fakeOk({ accountSets: [] }) }));
    expect(reply.text).toBe(FALLBACK_FAILURE);
    const state = sessions.peek('sess_1')!.state as Array<{ role: string }>;
    expect(state.length).toBeGreaterThan(0);
  });

  it('本轮账套搜索无结果时,阻止沿用历史账套 ID 查询', async () => {
    const sessions = new FakeSessionRepo();
    let voucherCalls = 0;
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [
        { tool: 'search_account_sets', args: { query: '幻辰' } },
        { tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202608' } },
      ], text: '不应到达' }]),
      sessions,
    });
    const reply = await runtime.handleTurn(makeCtx(), '查幻辰的应收', client({
      search_account_sets: () => fakeOk({ accountSets: [] }),
      list_vouchers: () => { voucherCalls += 1; return fakeOk({}); },
    }));

    expect(voucherCalls).toBe(0);
    expect(reply.text).toBe(ACCOUNT_SET_SEARCH_MISS);
  });

  it('本轮账套搜索无结果时,覆盖模型基于历史上下文编造的最终回复', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [
        { tool: 'search_account_sets', args: { query: '幻辰' } },
        // The model may stop after the miss and answer from stale transcript.
      ], text: '幻晟账套中没有幻辰，应收为 0 元。' }]),
      sessions,
    });
    const reply = await runtime.handleTurn(makeCtx(), '查幻辰的应收', client({
      search_account_sets: () => fakeOk({ accountSets: [] }),
    }));

    expect(reply.text).toBe(ACCOUNT_SET_SEARCH_MISS);
  });

  it('无可用工具 → 直接兜底', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '不应到达' }]),
      sessions,
    });
    const noTools: HostToolClient = { tools: () => [], call: async () => fakeOk({}) };
    const reply = await runtime.handleTurn(makeCtx(), '查一下', noTools);
    expect(reply.text).toBe(FALLBACK_FAILURE);
  });

  it('超时(空文本+过期deadline) → FALLBACK_TIMEOUT', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: { run: async () => ({ text: '', messages: [] }), compact: undefined },
      sessions,
      turnBudgetMs: -1, // deadline 已过
    });
    const reply = await runtime.handleTurn(makeCtx(), '查一下', fullClient());
    expect(reply.text).toBe(FALLBACK_TIMEOUT);
  });
});
