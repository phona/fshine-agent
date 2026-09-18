import { describe, expect, it } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import type { ContextTaskRunner, SubagentTaskResult } from './src/context';
import { RUN_17DZ_TASK_DESCRIPTION, RUN_17DZ_TASK_SCHEMA, RUN_17DZ_TASK_TOOL } from './src/context';
import { ScriptedTurnDriver, type ScriptedTurnStep, type TurnDriver, type TurnDriverInput } from './src/driver';
import { createTaxAgentRuntime, FALLBACK_FAILURE, FALLBACK_TIMEOUT } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_test',
    principalId: 'wecom:user_a',
    allowedAccountSetIds: ['as_001'],
    sessionId: 'sess_1',
    ...overrides,
  };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_17DZ_TASK_TOOL, description: RUN_17DZ_TASK_DESCRIPTION, inputSchema: RUN_17DZ_TASK_SCHEMA },
    run: run ?? (async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
  };
}

function recordingDriver(script: ScriptedTurnStep[]) {
  const base = ScriptedTurnDriver(script);
  const inputs: TurnDriverInput[] = [];
  const driver: TurnDriver = {
    run: async (input) => {
      inputs.push(input);
      return base.run(input);
    },
  };
  return { driver, inputs };
}

describe('createTaxAgentRuntime', () => {
  it('主 Agent 只暴露 run_17dz_task，并取得子 Agent 自然语言结果', async () => {
    const calls: Array<{ request: string; taskId?: string }> = [];
    let toolResult: unknown;
    const platformTask = subagent(async (args) => {
      calls.push(args);
      return { taskId: 'task_1', text: '请向用户确认客户名称。' };
    });
    const driver: TurnDriver = {
      run: async (input) => {
        expect(input.tools.map((tool) => tool.name)).toEqual(['run_17dz_task']);
        toolResult = await input.exec('run_17dz_task', { request: '查询客户余额' });
        return {
          text: '请问您指的是哪一家客户？',
          messages: [...input.messages, { role: 'assistant', content: '请问您指的是哪一家客户？', timestamp: Date.now() } as never],
        };
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask });
    const reply = await runtime.handleTurn(makeCtx(), '查询幻东余额');

    expect(calls).toEqual([{ request: '查询客户余额' }]);
    expect(toolResult).toEqual({ taskId: 'task_1', text: '请向用户确认客户名称。' });
    expect(reply.text).toBe('请问您指的是哪一家客户？');
  });

  it('继续委派时透传 taskId 和外层 AbortSignal', async () => {
    let observedSignal: AbortSignal | undefined;
    const platformTask = subagent(async (args, _ctx, signal) => {
      observedSignal = signal;
      expect(args).toEqual({ request: '用户选择 A 公司', taskId: 'task_1' });
      return { taskId: 'task_1', text: '查询完成。' };
    });
    const controller = new AbortController();
    const driver: TurnDriver = {
      run: async (input) => {
        await input.exec('run_17dz_task', { request: '用户选择 A 公司', taskId: 'task_1' }, controller.signal);
        return { text: '最终答复', messages: input.messages };
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask });
    await runtime.handleTurn(makeCtx(), 'A 公司');
    expect(observedSignal).toBe(controller.signal);
  });

  it('保存主 Agent 转录并在下一轮完整恢复', async () => {
    const sessions = new FakeSessionRepo();
    const { driver, inputs } = recordingDriver([{ text: '第一轮回复' }, { text: '第二轮回复' }]);
    const runtime = createTaxAgentRuntime({ driver, sessions, platformTask: subagent() });
    await runtime.handleTurn(makeCtx(), '第一句话');
    await runtime.handleTurn(makeCtx(), '第二句话');

    const second = inputs[1]!.messages as Array<{ role: string; content: string }>;
    expect(second.some((message) => message.role === 'user' && message.content === '第一句话')).toBe(true);
    expect(second.some((message) => message.role === 'assistant' && message.content === '第一轮回复')).toBe(true);
    expect(second.at(-1)?.content).toBe('第二句话');
  });

  it('TTL 过期时通过 driver.compact 软着陆', async () => {
    const sessions = new FakeSessionRepo();
    const base = ScriptedTurnDriver([{ text: '第一轮' }, { text: '恢复后' }]);
    const forced: boolean[] = [];
    const inputs: TurnDriverInput[] = [];
    const driver: TurnDriver = {
      run: async (input) => { inputs.push(input); return base.run(input); },
      compact: async (messages, opts) => {
        if (!opts?.force) return messages;
        forced.push(true);
        return [{ role: 'user', content: '【此前摘要】正在查幻辰余额', timestamp: Date.now() } as never];
      },
    };
    const runtime = createTaxAgentRuntime({ driver, sessions, platformTask: subagent(), sessionTtlMs: 300_000 });
    await runtime.handleTurn(makeCtx(), '第一句话');
    const record = sessions.peek('sess_1')!;
    await sessions.upsert({ ...record, updatedAt: new Date(Date.now() - 600_000).toISOString() });
    await runtime.handleTurn(makeCtx(), '继续');

    expect(forced).toHaveLength(1);
    expect(JSON.stringify(inputs[1]!.messages)).toContain('此前摘要');
  });

  it('空回复使用失败兜底并保存当前转录', async () => {
    const sessions = new FakeSessionRepo();
    const runtime = createTaxAgentRuntime({
      driver: { run: async (input) => ({ text: '', messages: input.messages }) },
      sessions,
      platformTask: subagent(),
    });
    const reply = await runtime.handleTurn(makeCtx(), '查一下');
    expect(reply.text).toBe(FALLBACK_FAILURE);
    expect((sessions.peek('sess_1')?.state as unknown[]).length).toBeGreaterThan(0);
  });

  it('截止时间已过且无回复时使用超时兜底', async () => {
    const runtime = createTaxAgentRuntime({
      driver: { run: async () => ({ text: '', messages: [] }) },
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      turnBudgetMs: -1,
    });
    expect((await runtime.handleTurn(makeCtx(), '查一下')).text).toBe(FALLBACK_TIMEOUT);
  });
});
