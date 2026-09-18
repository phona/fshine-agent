import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, ContextToolProvider, IncomingChannelMessage, TrustedContext } from '@fshine/contracts';
import { closeStore, createSqliteStore, newId } from '@fshine/core';
import { createContextTaskRunner, createTaxAgentRuntime, ScriptedTurnDriver, ToolUserError } from '@fshine/agent';
import { createMessageHandler } from '../../apps/server/handler';

const stores: ReturnType<typeof createSqliteStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) closeStore(store); });

function trusted(sessionId = 'e2e-context'): TrustedContext {
  return { requestId: newId('req'), principalId: 'wecom:e2e_user', allowedAccountSetIds: [], sessionId };
}

function message(text: string): IncomingChannelMessage {
  return { wecomUserId: 'e2e_user', conversationId: 'e2e', messageId: newId('msg'), chatType: 'single', text, receivedAt: new Date().toISOString() };
}

function provider(): ContextToolProvider {
  return {
    tools: () => [{ name: 'search_account_sets', description: '搜索账套', inputSchema: { type: 'object' } }],
    call: async () => ({ accountSets: [{ id: 'as_003', name: '幻辰' }] }),
  };
}

function runner(store: ReturnType<typeof createSqliteStore>, workerDriver: ReturnType<typeof ScriptedTurnDriver>) {
  const profiles: Record<string, ContextProfileConfig> = {
    '17dz': { root: process.cwd(), skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks: store.platformTasks!, workerDriver, provider: provider() });
}

describe('本地 E2E × Context Worker（进程内 Fake Provider）', () => {
  it('主 Agent 只委托 run_17dz_task，首次任务完成', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    await store.principalScopes.upsert({ wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', mcpProfile: 'unused', enabled: true });
    const platform = runner(store, ScriptedTurnDriver([{ text: '已查询幻辰，应收余额为 686985.49 元。' }]));
    const main = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: 'run_17dz_task', args: { request: '查幻辰的应收账款' } }], text: '已完成平台查询。' }]),
      sessions: store.sessions,
      platformTask: platform,
    });
    const handler = createMessageHandler({ store, runtime: main });
    expect(await handler(message('查幻辰的应收账款'))).toContain('已完成平台查询');
  });

  it('needs_input 续接、重新创建 Runner 后恢复为 completed', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    const first = runner(store, ScriptedTurnDriver([{ text: '找到两个客户，请选择幻州幻东机械有限公司。' }]));
    const pending = await first.run({ request: '幻东在幻辰还欠多少' }, { trusted: trusted() });
    expect(pending.status).toBe('needs_input');
    const resumed = runner(store, ScriptedTurnDriver([{ text: '已恢复任务并查询完成。' }]));
    const done = await resumed.run({ taskId: pending.taskId, request: '继续', answer: '选择幻州幻东机械有限公司' }, { trusted: trusted() });
    expect(done.status).toBe('completed');
    expect((await store.platformTasks!.get(pending.taskId))?.status).toBe('completed');
  });

  it('Context Profile 越权路径被拒绝', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    const task = createContextTaskRunner({
      profiles: { '17dz': { root: process.cwd(), skillRoots: ['../outside'] } },
      tasks: store.platformTasks!,
      workerDriver: ScriptedTurnDriver([{ text: '不应执行' }]),
      provider: provider(),
    });
    await expect(task.run({ request: '读取任意路径' }, { trusted: trusted() })).rejects.toBeInstanceOf(ToolUserError);
  });

  it('没有通用执行能力时返回 capability_unavailable 并保存 blocked 状态', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    const task = createContextTaskRunner({
      profiles: { '17dz': { root: process.cwd(), skillRoots: ['.agents/skills'] } },
      tasks: store.platformTasks!,
      workerDriver: ScriptedTurnDriver([{ text: '不应执行' }]),
    });
    const result = await task.run({ request: '查幻辰账套' }, { trusted: trusted('capability') });
    expect(result.status).toBe('blocked');
    expect(result.error).toContain('CAPABILITY_UNAVAILABLE');
    expect((await store.platformTasks!.get(result.taskId))?.status).toBe('blocked');
  });
});
