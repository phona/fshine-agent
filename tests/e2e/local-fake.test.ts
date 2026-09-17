import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingChannelMessage, TrustedContext } from '@fshine/contracts';
import { closeStore, createSqliteStore, newId } from '@fshine/core';
import { createTaxAgentRuntime, ScriptedTurnDriver, type TurnDriver, type TurnDriverInput } from '@fshine/agent';
import { createMessageHandler } from '../../apps/server/handler';
import type { McpHost } from '@fshine/mcp-host';
import { InProcessFakeMcpClient } from './fake-mcp';

const stores: ReturnType<typeof createSqliteStore>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) closeStore(store);
});

function context(sessionId = `e2e-${Math.random().toString(16).slice(2)}`): TrustedContext {
  return {
    requestId: newId('req'),
    principalId: 'wecom:e2e_user',
    allowedAccountSetIds: ['as_001'],
    sessionId,
  };
}

function message(wecomUserId: string, text: string, conversationId = 'e2e'): IncomingChannelMessage {
  return {
    wecomUserId,
    conversationId,
    messageId: newId('msg'),
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

/** Minimal in-process host shape accepted by the message handler. */
function fakeHost(client: InProcessFakeMcpClient): McpHost {
  const host = {
    conversationNamespace: 'in-process-fake-mcp',
    discoveredTools: client.tools(),
    ensureReady: async () => undefined,
    clientFor: () => client,
  };
  return host as unknown as McpHost;
}

function makeStore(user = 'e2e_user') {
  const store = createSqliteStore(':memory:');
  stores.push(store);
  return { store, user };
}

describe('本地 E2E × 进程内 Fake MCP', () => {
  it('未授权用户被拒绝，且不会触发 Fake MCP', async () => {
    const client = await InProcessFakeMcpClient.create();
    const { store } = makeStore();
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '不应执行' }]),
      sessions: store.sessions,
    });
    const handler = createMessageHandler({
      store,
      runtime,
      hostFor: () => fakeHost(client),
    });

    const reply = await handler(message('stranger_404', '查一下幻晟本期的凭证'));
    expect(reply).toContain('未开通查询权限');
    expect(client.calls).toEqual([]);
  });

  it('账套搜索出现两个候选，选择后使用稳定 id 查询并续接凭证', async () => {
    const client = await InProcessFakeMcpClient.create({ env: { FAKE_ENABLE_WRITE: '1' } });
    const { store } = makeStore();
    await store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: ['as_001'], mcpProfile: 'fake', enabled: true,
    });
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([
        {
          toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }],
          text: '找到两个候选：1. 幻晟；2. 幻晟(深圳)，请回复序号。',
        },
        {
          toolCalls: [
            { tool: 'get_current_accounting_period', args: { accountSetId: 'as_001' } },
            { tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202607', pageSize: 4 } },
          ],
          text: '已选择幻晟（as_001），本期有凭证，可回复“下一页”继续。',
        },
      ]),
      sessions: store.sessions,
    });
    const handler = createMessageHandler({ store, runtime, hostFor: () => fakeHost(client) });

    const first = await handler(message('e2e_user', '查一下幻晟本期的凭证'));
    const second = await handler(message('e2e_user', '1'));
    expect(first).toContain('两个候选');
    expect(second).toContain('as_001');
    expect(client.callsOf('search_account_sets')).toEqual([{ query: '幻晟' }]);
    expect(client.callsOf('get_current_accounting_period')).toEqual([{ accountSetId: 'as_001' }]);
    expect(client.callsOf('list_vouchers')[0]).toMatchObject({ accountSetId: 'as_001', period: '202607' });
  });

  it('Fake MCP 分页返回游标，下一页从 offset=4 开始', async () => {
    const client = await InProcessFakeMcpClient.create();
    const first = await client.call('list_vouchers', { accountSetId: 'as_001', period: '202607', pageSize: 4 });
    assert(first.ok);
    const firstData = first.data as { docs: unknown[]; nextCursor?: string; offset?: number };
    expect(firstData.docs).toHaveLength(4);
    expect(firstData.offset).toBe(0);
    expect(firstData.nextCursor).toBeTruthy();

    const second = await client.call('list_vouchers', {
      accountSetId: 'as_001', period: '202607', cursor: firstData.nextCursor,
    });
    assert(second.ok);
    const secondData = second.data as { docs: unknown[]; offset?: number; prevCursor?: string };
    expect(secondData.docs).toHaveLength(4);
    expect(secondData.offset).toBe(4);
    expect(secondData.prevCursor).toBeTruthy();
  });

  it('跨轮追问保留账套上下文，并通过 Fake MCP 获取下一页', async () => {
    const client = await InProcessFakeMcpClient.create();
    const inputs: TurnDriverInput[] = [];
    const base = ScriptedTurnDriver([
      {
        toolCalls: [{ tool: 'search_account_sets', args: { query: '幻晟' } }],
        text: '幻晟本期凭证第一页已返回，请回复下一页。',
      },
      {
        toolCalls: [{ tool: 'list_vouchers', args: { accountSetId: 'as_001', period: '202607', pageSize: 4 } }],
        text: '幻晟的下一页凭证已返回。',
      },
      { text: '刚才查的是幻晟账套（as_001）。' },
    ]);
    const driver: TurnDriver = {
      run: async (input) => {
        inputs.push(input);
        return base.run(input);
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions: new InProcessSessionRepo() });
    const ctx = context('follow-up');
    await runtime.handleTurn(ctx, '查幻晟本期凭证', client);
    await runtime.handleTurn(ctx, '下一页', client);
    const reply = await runtime.handleTurn(ctx, '刚才查的是哪个账套？', client);

    expect(reply.text).toContain('幻晟');
    expect(inputs[2]?.messages.some((entry) => JSON.stringify(entry).includes('幻晟本期凭证第一页'))).toBe(true);
    expect(client.callsOf('list_vouchers')).toHaveLength(1);
  });

  it('validate_voucher 可读写校验，但 submit_voucher、batch 和 workflow.confirm 从未调用', async () => {
    const client = await InProcessFakeMcpClient.create({ env: { FAKE_ENABLE_WRITE: '1' } });
    const contract = {
      accountSetId: 'as_001', date: '2026-07-31', template: 'bill.receive',
      entries: [
        { summary: 'E2E 收票', subjectCode: '1121', debit: 100 },
        { summary: 'E2E 收票', subjectCode: '1122', assistantName: '客户甲', credit: 100 },
      ],
    };
    const valid = await client.call('validate_voucher', { contract });
    const invalid = await client.call('validate_voucher', { contract: { ...contract, entries: [contract.entries[0]] } });
    assert(valid.ok);
    assert(invalid.ok);
    expect((valid.data as { ok: boolean }).ok).toBe(true);
    expect((invalid.data as { ok: boolean }).ok).toBe(false);
    expect(client.calls.map((call) => call.tool)).toEqual(['validate_voucher', 'validate_voucher']);
    expect(client.calls.some((call) => ['submit_voucher', 'submit_voucher_batch', 'workflow.confirm'].includes(call.tool))).toBe(false);
  });

  it('Fake MCP resources 与 inspect_account_set 可用，且资源读取受已发现 URI 限制', async () => {
    const client = await InProcessFakeMcpClient.create({ env: { FAKE_ENABLE_RESOURCES: '1' } });
    const resources = client.resources();
    expect(resources.map((resource) => resource.uri)).toContain('17dz://domains/voucher/templates');
    const resource = await client.readResource('17dz://domains/voucher/templates');
    assert(resource.ok);
    expect(resource.data.contents[0]?.text).toContain('voucher templates');
    const inspect = await client.call('inspect_account_set', { accountSetId: 'as_001' });
    assert(inspect.ok);
    expect((inspect.data as { subjects: Array<{ code: string }> }).subjects.map((subject) => subject.code)).toContain('1122');
  });
});

/** Tiny deterministic session repository for runtime-only E2E scenarios. */
class InProcessSessionRepo {
  private readonly records = new Map<string, { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }>();

  async get(sessionId: string) {
    return this.records.get(sessionId) ?? null;
  }

  async upsert(record: { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }) {
    this.records.set(record.sessionId, { ...record });
  }
}
