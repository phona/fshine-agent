import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, IncomingChannelMessage, TrustedContext } from '@fshine/contracts';
import { closeStore, createSqliteStore, newId } from '@fshine/core';
import {
  createContextTaskRunner,
  createTaxAgentRuntime,
  ScriptedTurnDriver,
  ToolUserError,
  type TurnDriver,
  type TurnDriverInput,
} from '@fshine/agent';
import { createMessageHandler } from '../../apps/server/handler';

const stores: ReturnType<typeof createSqliteStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) closeStore(store); });

function trusted(sessionId = 'e2e-context'): TrustedContext {
  return { requestId: newId('req'), principalId: 'wecom:e2e_user', allowedAccountSetIds: [], sessionId };
}

function message(text: string): IncomingChannelMessage {
  return { wecomUserId: 'e2e_user', conversationId: 'e2e', messageId: newId('msg'), chatType: 'single', text, receivedAt: new Date().toISOString() };
}

function runner(store: ReturnType<typeof createSqliteStore>, workerDriver: TurnDriver) {
  const profiles: Record<string, ContextProfileConfig> = {
    '17dz': { root: process.cwd(), skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks: store.platformTasks!, workerDriver });
}

function workerDriver(responses: string[], observed: TurnDriverInput[] = []): TurnDriver {
  return {
    run: async (input) => {
      observed.push(input);
      const text = responses.shift() ?? '';
      return {
        text,
        messages: [
          ...input.messages,
          { role: 'assistant', content: text, timestamp: Date.now() } as never,
        ],
      };
    },
  };
}

describe('本地 E2E × cwd 固定的 17dz 子 Agent', () => {
  it('主 Agent 委托 run_17dz_task，并原样透传子 Agent 自然语言', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    await store.principalScopes.upsert({ wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true });
    const workerInputs: TurnDriverInput[] = [];
    const workerText = '找到两个客户，请选择幻州幻东机械有限公司。';
    const platform = runner(store, workerDriver([workerText], workerInputs));
    let delegatedResult: unknown;
    const mainDriver: TurnDriver = {
      run: async (input) => {
        expect(input.tools.map((tool) => tool.name)).toEqual(['run_17dz_task']);
        delegatedResult = await input.exec('run_17dz_task', { request: '查幻辰的应收账款' });
        return {
          text: (delegatedResult as { text: string }).text,
          messages: [...input.messages, { role: 'assistant', content: (delegatedResult as { text: string }).text, timestamp: Date.now() } as never],
        };
      },
    };
    const main = createTaxAgentRuntime({
      driver: mainDriver,
      sessions: store.sessions,
      platformTask: platform,
    });
    const handler = createMessageHandler({ store, runtime: main });
    expect(await handler(message('查幻辰的应收账款'))).toBe(workerText);
    expect(delegatedResult).toMatchObject({ taskId: expect.stringMatching(/^task_/), text: workerText });
    expect(workerInputs).toHaveLength(1);
    expect(workerInputs[0]?.cwd).toBe(process.cwd());
    expect(workerInputs[0]?.tools).toEqual([]);
  });

  it('携带 taskId 重新创建 Runner 后恢复同一子 Agent transcript', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    const firstInputs: TurnDriverInput[] = [];
    const first = runner(store, workerDriver(['找到两个客户，请选择幻州幻东机械有限公司。'], firstInputs));
    const pending = await first.run({ request: '幻东在幻辰还欠多少' }, { trusted: trusted() });
    expect(pending.text).toBe('找到两个客户，请选择幻州幻东机械有限公司。');

    const resumedInputs: TurnDriverInput[] = [];
    const resumed = runner(store, workerDriver(['已恢复任务并查询完成。'], resumedInputs));
    const done = await resumed.run({ taskId: pending.taskId, request: '选择幻州幻东机械有限公司后继续查询' }, { trusted: trusted() });
    expect(done).toEqual({ taskId: pending.taskId, text: '已恢复任务并查询完成。' });
    expect(resumedInputs[0]?.sessionId).toBe(pending.taskId);
    expect(resumedInputs[0]?.cwd).toBe(process.cwd());
    expect(resumedInputs[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '幻东在幻辰还欠多少' }),
      expect.objectContaining({ role: 'assistant', content: '找到两个客户，请选择幻州幻东机械有限公司。' }),
    ]));
    expect((await store.platformTasks!.get(pending.taskId))?.workerMessages).toHaveLength(4);
  });

  it('Context Profile 越权路径被拒绝', async () => {
    const store = createSqliteStore(':memory:');
    stores.push(store);
    const task = createContextTaskRunner({
      profiles: { '17dz': { root: process.cwd(), skillRoots: ['../outside'] } },
      tasks: store.platformTasks!,
      workerDriver: ScriptedTurnDriver([{ text: '不应执行' }]),
    });
    await expect(task.run({ request: '读取任意路径' }, { trusted: trusted() })).rejects.toBeInstanceOf(ToolUserError);
  });
});
