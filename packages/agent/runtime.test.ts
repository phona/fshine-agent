import { describe, expect, it } from 'vitest';
import type { EnvelopeMeta, TrustedContext } from '@fshine/contracts';
import { ScriptedChatModel, type ScriptedStep } from './src/model';
import {
  createTaxAgentRuntime,
  FALLBACK_FAILURE,
  FALLBACK_MISUNDERSTOOD,
  FALLBACK_TIMEOUT,
  NO_ACCOUNT_SET_MESSAGE,
  type AgentSessionState,
} from './src';
import { FakeSessionRepo, FakeToolClient, fakeErr, fakeMeta, fakeOk, recordRequests } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_1',
    principalId: 'wecom:u1',
    allowedAccountSetIds: ['as_001', 'as_002'],
    sessionId: 'sess_1',
    ...overrides,
  };
}

async function seedState(sessions: FakeSessionRepo, state: AgentSessionState): Promise<void> {
  await sessions.upsert({
    sessionId: 'sess_1',
    principalId: 'wecom:u1',
    channelConversationId: 'conv_1',
    updatedAt: new Date().toISOString(),
    state,
  });
}

function lastMessage(req: { messages: Array<{ role: string; content: string }> }): { role: string; content: string } {
  return req.messages[req.messages.length - 1]!;
}

function parseLastResult(req: { messages: Array<{ role: string; content: string }> }): {
  tool: string;
  result: { ok: boolean; data: Record<string, unknown>; meta: EnvelopeMeta };
} {
  return JSON.parse(lastMessage(req).content) as {
    tool: string;
    result: { ok: boolean; data: Record<string, unknown>; meta: EnvelopeMeta };
  };
}

const VOUCHER_PAGE_1 = {
  total: 2,
  docs: [
    {
      id: 'v1',
      type: '记',
      number: '001',
      journalDate: '2026-07-02',
      haveAnnex: 1,
      entryDtoList: [
        { summary: '报销差旅费', accountTitleCode: '6602', debitAmount: 1200, creditAmount: 0 },
      ],
    },
    {
      id: 'v2',
      type: '记',
      number: '002',
      journalDate: '2026-07-15',
      haveAnnex: 2,
      entryDtoList: [
        { summary: '收到货款', accountTitleCode: '1122', debitAmount: 0, creditAmount: 8000 },
      ],
    },
  ],
};

describe('createTaxAgentRuntime 完整查证流', () => {
  it('search → period → list_vouchers → reply,工具结果逐轮附加进模型上下文', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: [{ id: 'as_001', name: '幻晟' }] }),
      get_current_accounting_period: () =>
        fakeOk({ period: '202607' }, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
      list_vouchers: () =>
        fakeOk(VOUCHER_PAGE_1, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
    });

    const script: ScriptedStep[] = [
      '{"action":"call","tool":"search_account_sets","args":{"query":"幻晟"}}',
      '{"action":"call","tool":"get_current_accounting_period","args":{"accountSetId":"as_001"}}',
      '{"action":"call","tool":"list_vouchers","args":{"accountSetId":"as_001","period":"202607"}}',
      (req) => {
        const parsed = parseLastResult(req);
        expect(parsed.tool).toBe('list_vouchers');
        expect(parsed.result.ok).toBe(true);
        const data = parsed.result.data as { total: number; docs: unknown[] };
        const meta = parsed.result.meta;
        return JSON.stringify({
          action: 'reply',
          text: `账套「${meta.accountSetName}」${String((data.docs[0] as { journalDate: string }).journalDate).slice(0, 7).replace('-', '')} 期间共 ${data.total} 张凭证。来源:${meta.source},取回时间:${meta.retrievedAt}`,
        });
      },
    ];
    const { model, requests } = recordRequests(ScriptedChatModel(script));
    const runtime = createTaxAgentRuntime({ model, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查一下幻晟本期的凭证', client);

    expect(reply.text).toContain('幻晟');
    expect(reply.text).toContain('202607');
    expect(reply.text).toContain('api_live');
    expect(reply.text).toContain('2026-09-15T10:00:00+08:00');

    expect(client.calls.map((call) => call.tool)).toEqual([
      'search_account_sets',
      'get_current_accounting_period',
      'list_vouchers',
    ]);

    expect(requests).toHaveLength(4);
    expect(requests[0]!.system).toContain('search_account_sets');
    expect(requests[0]!.system).toContain('{"action":"reply"');
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: '查一下幻晟本期的凭证' }]);

    expect(requests[1]!.messages).toHaveLength(2);
    expect(requests[1]!.messages[0]!.role).toBe('user');
    expect(requests[1]!.messages[1]!.role).toBe('assistant');
    expect(requests[1]!.messages[1]!.content).toContain('"tool":"search_account_sets"');
    expect(requests[1]!.messages[1]!.content).toContain('"ok":true');
    expect(requests[1]!.messages[1]!.content).toContain('"as_001"');

    expect(requests[2]!.messages).toHaveLength(3);
    expect(requests[2]!.messages[2]!.content).toContain('"tool":"get_current_accounting_period"');
    expect(requests[2]!.messages[2]!.content).toContain('"period":"202607"');

    expect(requests[3]!.messages).toHaveLength(4);
    expect(requests[3]!.messages[3]!.content).toContain('"tool":"list_vouchers"');

    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.lastVoucherQuery).toEqual({
      accountSetId: 'as_001',
      accountSetName: '幻晟',
      period: '202607',
    });
    expect(state.lastVoucherQuery?.nextCursor).toBeUndefined();
  });
});

describe('createTaxAgentRuntime 多候选澄清', () => {
  const TWO = [{ id: 'as_001', name: '幻晟' }, { id: 'as_002', name: '幻晟二店' }];

  it('search 命中多个候选:回复编号列表,候选与过期时间入库', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: TWO }),
    });
    const script: ScriptedStep[] = [
      '{"action":"call","tool":"search_account_sets","args":{"query":"幻晟"}}',
      (req) => {
        const parsed = parseLastResult(req);
        const list = (parsed.result.data.accountSets as Array<{ id: string; name: string }>)
          .map((item, index) => `${index + 1}. ${item.name}`)
          .join(' ');
        return JSON.stringify({ action: 'reply', text: `找到多个账套,请回复编号选择:${list}` });
      },
    ];
    const runtime = createTaxAgentRuntime({ model: ScriptedChatModel(script), sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查幻晟的凭证', client);

    expect(reply.text).toContain('1. 幻晟');
    expect(reply.text).toContain('2. 幻晟二店');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toEqual(TWO);
    expect(state.expiresAt).toBeDefined();
    expect(Date.parse(state.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('第二轮回复"1":以对应 id 继续,清 pendingCandidates', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      pendingCandidates: TWO,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const client = new FakeToolClient({
      get_current_accounting_period: () =>
        fakeOk({ period: '202608' }, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
    });
    const { model, requests } = recordRequests(
      ScriptedChatModel([
        '{"action":"call","tool":"get_current_accounting_period","args":{"accountSetId":"as_001"}}',
        '{"action":"reply","text":"幻晟 当前会计期间是 202608。"}',
      ]),
    );
    const runtime = createTaxAgentRuntime({ model, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '1', client);

    expect(reply.text).toContain('202608');
    expect(client.callsOf('get_current_accounting_period')).toEqual([{ accountSetId: 'as_001' }]);
    expect(requests[0]!.messages[0]!.role).toBe('user');
    expect(requests[0]!.messages[0]!.content).toContain('as_001');
    expect(requests[0]!.messages[0]!.content).toContain('幻晟');

    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toBeUndefined();
    expect(state.expiresAt).toBeUndefined();
  });

  it('候选已过期:不复活,重新搜索并再次澄清', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      pendingCandidates: TWO,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    let searchCount = 0;
    const client = new FakeToolClient({
      search_account_sets: () => {
        searchCount += 1;
        return fakeOk({ accountSets: TWO });
      },
    });
    const { model, requests } = recordRequests(
      ScriptedChatModel([
        '{"action":"call","tool":"search_account_sets","args":{"query":"幻晟"}}',
        '{"action":"reply","text":"找到多个账套:1. 幻晟 2. 幻晟二店,请选择。"}',
      ]),
    );
    const runtime = createTaxAgentRuntime({ model, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '1', client);

    expect(reply.text).toContain('多个账套');
    expect(searchCount).toBe(1);
    // 未注入"用户选择了账套"前缀,走正常搜索流程
    expect(requests[0]!.messages[0]!.content).toBe('1');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.pendingCandidates).toEqual(TWO);
    expect(Date.parse(state.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('search 无候选:直接回复没有找到该账套', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: [] }),
    });
    const runtime = createTaxAgentRuntime({
      model: ScriptedChatModel(['{"action":"call","tool":"search_account_sets","args":{"query":"不存在"}}']),
      sessions,
    });

    const reply = await runtime.handleTurn(makeCtx(), '查一下不存在账套的凭证', client);

    expect(reply.text).toBe(NO_ACCOUNT_SET_MESSAGE);
  });
});

describe('createTaxAgentRuntime 下一页', () => {
  it('上一轮带 nextCursor:用户回复"下一页"直接用 cursor 续查并更新游标', async () => {
    const sessions = new FakeSessionRepo();
    await seedState(sessions, {
      lastVoucherQuery: {
        accountSetId: 'as_001',
        accountSetName: '幻晟',
        period: '202607',
        nextCursor: 'cur_2',
      },
    });
    const client = new FakeToolClient({
      list_vouchers: () =>
        fakeOk({ ...VOUCHER_PAGE_1, nextCursor: 'cur_3' }, fakeMeta({ accountSetId: 'as_001', accountSetName: '幻晟' })),
    });
    const { model, requests } = recordRequests(
      ScriptedChatModel([
        (req) => {
          const parsed = parseLastResult(req);
          expect(parsed.tool).toBe('list_vouchers');
          return JSON.stringify({ action: 'reply', text: `已取下一页,共 ${String(parsed.result.data.total)} 条,还有更多` });
        },
      ]),
    );
    const runtime = createTaxAgentRuntime({ model, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '下一页', client);

    expect(reply.text).toContain('下一页');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.args).toEqual({ accountSetId: 'as_001', period: '202607', cursor: 'cur_2' });
    // 结果作为 assistant 消息进入模型上下文
    expect(requests[0]!.messages[1]!.role).toBe('assistant');
    expect(requests[0]!.messages[1]!.content).toContain('"nextCursor":"cur_3"');
    const state = sessions.peek('sess_1')!.state as AgentSessionState;
    expect(state.lastVoucherQuery?.nextCursor).toBe('cur_3');
  });
});

describe('createTaxAgentRuntime 错误处理', () => {
  it('ACCOUNT_SET_FORBIDDEN:回复安全话术,不透出其他账套名与原始错误', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      search_account_sets: () => fakeOk({ accountSets: [{ id: 'as_001', name: '幻晟' }] }),
      list_vouchers: () => fakeErr('ACCOUNT_SET_FORBIDDEN', '账套 as_002 不在 wecom:u1 的允许范围内'),
    });
    const runtime = createTaxAgentRuntime({
      model: ScriptedChatModel([
        '{"action":"call","tool":"search_account_sets","args":{"query":"幻晟"}}',
        '{"action":"call","tool":"list_vouchers","args":{"accountSetId":"as_001","period":"202607"}}',
      ]),
      sessions,
    });

    const reply = await runtime.handleTurn(makeCtx(), '查幻晟的凭证', client);

    expect(reply.text).toBe('没有该账套的访问权限');
    expect(reply.text).not.toContain('as_002');
    expect(reply.text).not.toContain('wecom');
  });

  it('NEEDS_LOGIN:回复登录处理话术', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient({
      get_current_accounting_period: () => fakeErr('NEEDS_LOGIN', '幻账平台登录态失效'),
    });
    const runtime = createTaxAgentRuntime({
      model: ScriptedChatModel([
        '{"action":"call","tool":"get_current_accounting_period","args":{"accountSetId":"as_001"}}',
      ]),
      sessions,
    });

    const reply = await runtime.handleTurn(makeCtx(), '幻晟现在是几月', client);

    expect(reply.text).toBe('系统登录需要处理,暂时无法查询,请稍后再试');
  });
});

describe('createTaxAgentRuntime 协议健壮性', () => {
  it('非法输出纠偏一次后成功,纠偏 user 消息进入上下文', async () => {
    const sessions = new FakeSessionRepo();
    const { model, requests } = recordRequests(
      ScriptedChatModel(['我觉得你要查凭证。', '{"action":"reply","text":"好的,已为你查到。"}']),
    );
    const runtime = createTaxAgentRuntime({ model, sessions });

    const reply = await runtime.handleTurn(makeCtx(), '查凭证', new FakeToolClient());

    expect(reply.text).toBe('好的,已为你查到。');
    expect(requests).toHaveLength(2);
    const correction = lastMessage(requests[1]!);
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('JSON');
  });

  it('连续两次非法输出:兜底文案', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      model: ScriptedChatModel(['第一句不是 JSON', '第二句也不是']),
      sessions,
    });

    const reply = await runtime.handleTurn(makeCtx(), '查凭证', new FakeToolClient());

    expect(reply.text).toBe(FALLBACK_MISUNDERSTOOD);
  });

  it('调用未发现工具按协议违规处理,纠偏后恢复', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      model: ScriptedChatModel([
        '{"action":"call","tool":"delete_voucher","args":{"id":"v1"}}',
        '{"action":"reply","text":"已恢复。"}',
      ]),
      sessions,
    });
    const client = new FakeToolClient();

    const reply = await runtime.handleTurn(makeCtx(), '删掉凭证', client);

    expect(reply.text).toBe('已恢复。');
    expect(client.calls).toHaveLength(0);
  });
});

describe('createTaxAgentRuntime 预算与轮次', () => {
  it('模型一直 call:达到 maxSteps(6)后兜底', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient();
    const { model, requests } = recordRequests(
      ScriptedChatModel(['{"action":"call","tool":"get_login_status","args":{}}']),
    );
    const runtime = createTaxAgentRuntime({ model, sessions, maxSteps: 6 });

    const reply = await runtime.handleTurn(makeCtx(), '查凭证', client);

    expect(reply.text).toBe(FALLBACK_MISUNDERSTOOD);
    expect(client.calls).toHaveLength(6);
    expect(requests).toHaveLength(6);
  });

  it('turnBudgetMs 用尽:第一步前即返回超时兜底,不再调用模型与工具', async () => {
    const sessions = new FakeSessionRepo();
    const client = new FakeToolClient();
    const { model, requests } = recordRequests(
      ScriptedChatModel(['{"action":"reply","text":"不应到达"}']),
    );
    const runtime = createTaxAgentRuntime({ model, sessions, turnBudgetMs: 0 });

    const reply = await runtime.handleTurn(makeCtx(), '查凭证', client);

    expect(reply.text).toBe(FALLBACK_TIMEOUT);
    expect(requests).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });
});

describe('createTaxAgentRuntime 工具结果保险裁剪', () => {
  it('超大 JSON 截断到 6000 字符以内并带标记', async () => {
    const sessions = new FakeSessionRepo();
    const big = 'x'.repeat(20_000);
    const client = new FakeToolClient({
      get_login_status: () => fakeOk({ loggedIn: true, padding: big }),
    });
    const script: ScriptedStep[] = [
      '{"action":"call","tool":"get_login_status","args":{}}',
      (req) => {
        const last = lastMessage(req);
        expect(last.content.length).toBeLessThan(6_200);
        expect(last.content).toContain('结果过长已截断');
        return '{"action":"reply","text":"ok"}';
      },
    ];
    const runtime = createTaxAgentRuntime({ model: ScriptedChatModel(script), sessions });

    const reply = await runtime.handleTurn(makeCtx(), '登录状态', client);

    expect(reply.text).toBe('ok');
  });

  it('工具清单为空(host 连接未就绪):以失败话术收场,不进模型循环', async () => {
    const sessions = new FakeSessionRepo();
    const { model } = recordRequests(
      ScriptedChatModel(['{"action":"reply","text":"不该被触达"}']),
    );
    const emptyClient = {
      tools: () => [],
      call: async () => {
        throw new Error('不应被调用');
      },
    };

    const runtime = createTaxAgentRuntime({ model, sessions });
    const reply = await runtime.handleTurn(makeCtx(), '查一下幻晟本期的凭证', emptyClient);

    expect(reply.text).toBe(FALLBACK_FAILURE);
  });
});
