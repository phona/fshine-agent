import { afterEach, describe, expect, it } from 'vitest';
import { createTaxAgentRuntime } from './src/runtime';
import { isSpikeGenericModeEnabled, SPIKE_GENERIC_MODE_ENV } from './src/spike-generic-mode';
import type { TurnDriver } from './src/driver';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner } from './src/context';
import { FakeSessionRepo } from './test-helpers';

const SAVED_ENV = process.env[SPIKE_GENERIC_MODE_ENV];

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env[SPIKE_GENERIC_MODE_ENV];
  else process.env[SPIKE_GENERIC_MODE_ENV] = SAVED_ENV;
});

function setSpikeMode(value: string | undefined): void {
  if (value === undefined) delete process.env[SPIKE_GENERIC_MODE_ENV];
  else process.env[SPIKE_GENERIC_MODE_ENV] = value;
}

function subagent(): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: async () => ({ taskId: 'task_spike', text: '子 Agent 完成。' }),
  };
}

/** 只声明会话、不委派的驱动；把每回合看到的工具名交出来。 */
function conversationDriver(seen: string[][]): TurnDriver {
  return {
    async run(input) {
      seen.push(input.tools.map((tool) => tool.name));
      await input.exec('route_current_turn', { kind: 'conversation' });
      return { text: '好的。', messages: [...input.messages, { role: 'assistant', content: '好的。', timestamp: 1 } as never] };
    },
  };
}

function emptyConversationLog() {
  return {
    append: async () => {},
    list: async () => [],
    search: async () => [],
  };
}

const CTX = {
  requestId: 'req_spike',
  principalId: 'wecom:user_spike',
  sessionId: 'sess_spike',
  capabilities: ['read', 'write'] as const,
};

describe('SPIKE 通用模式开关', () => {
  it('取值解析：缺省 / 0 / false = 关闭，1 / true（含空白大小写） = 打开', () => {
    expect(isSpikeGenericModeEnabled({})).toBe(false);
    expect(isSpikeGenericModeEnabled({ [SPIKE_GENERIC_MODE_ENV]: '' })).toBe(false);
    expect(isSpikeGenericModeEnabled({ [SPIKE_GENERIC_MODE_ENV]: '0' })).toBe(false);
    expect(isSpikeGenericModeEnabled({ [SPIKE_GENERIC_MODE_ENV]: 'false' })).toBe(false);
    expect(isSpikeGenericModeEnabled({ [SPIKE_GENERIC_MODE_ENV]: '1' })).toBe(true);
    expect(isSpikeGenericModeEnabled({ [SPIKE_GENERIC_MODE_ENV]: ' TRUE ' })).toBe(true);
  });

  it('打开时工具面没有 search_history / get_messages，关闭时原样两件都在', async () => {
    const seen: string[][] = [];
    setSpikeMode('1');
    await createTaxAgentRuntime({
      driver: conversationDriver(seen),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      conversationLog: emptyConversationLog(),
    }).handleTurn({ ...CTX, requestId: 'req_spike_tools_on' }, '这个批次呢？');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('search_history');
    expect(seen[0]).not.toContain('get_messages');
    expect(seen[0]).toContain('route_current_turn');

    seen.length = 0;
    setSpikeMode(undefined);
    await createTaxAgentRuntime({
      driver: conversationDriver(seen),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      conversationLog: emptyConversationLog(),
    }).handleTurn({ ...CTX, requestId: 'req_spike_tools_off' }, '这个批次呢？');
    expect(seen[0]).toContain('search_history');
    expect(seen[0]).toContain('get_messages');
  });

  it('打开时 runtime 拿不到 platformTasks / contextStates / memoryRecords：三类读取点全部零调用', async () => {
    const calls = { listBySession: 0, contextGet: 0, contextUpsert: 0, listByPrincipal: 0 };
    const spikeDeps = {
      platformTasks: {
        listBySession: async () => { calls.listBySession += 1; return []; },
      },
      contextStates: {
        get: async () => { calls.contextGet += 1; return null; },
        upsert: async () => { calls.contextUpsert += 1; },
      },
      memoryRecords: {
        listByPrincipal: async () => { calls.listByPrincipal += 1; return []; },
        getCursor: async () => null,
        commit: async () => false,
      },
    };

    // 打开：即使调用方把三个依赖都交进来，runtime 侧也全部为零。
    setSpikeMode('1');
    await createTaxAgentRuntime({
      driver: conversationDriver([]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      conversationLog: emptyConversationLog(),
      ...spikeDeps,
    }).handleTurn({ ...CTX, requestId: 'req_spike_deps_on' }, '刚才那个批次呢？');
    expect(calls).toEqual({ listBySession: 0, contextGet: 0, contextUpsert: 0, listByPrincipal: 0 });

    // 对照：关闭时同样输入会走现有路径（召回底账 / 上下文状态 / 长期记忆投影）。
    setSpikeMode(undefined);
    await createTaxAgentRuntime({
      driver: conversationDriver([]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      conversationLog: emptyConversationLog(),
      ...spikeDeps,
    }).handleTurn({ ...CTX, requestId: 'req_spike_deps_off' }, '刚才那个批次呢？');
    expect(calls.listBySession).toBeGreaterThan(0);
    expect(calls.contextGet).toBeGreaterThan(0);
    expect(calls.listByPrincipal).toBeGreaterThan(0);
  });
});
