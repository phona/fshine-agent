/**
 * 重复提问 / 历史答复不得冒充实时（RR1–RR4 的验收锚点，2026-11-12 补齐）。
 *
 * 背景：直连改造删掉了强制申报，模型不调用委派工具、直接凭历史作答时，出口的执行痕迹门
 * （delegate_without_execution）没有信号——类 3 的确定性缺口。本文件钉住补齐后的判据：
 *   RR1 本会话有在册任务 + 本回合零委派零执行 + 回复带数字结论 → 确定性话术拦下；
 *       判据是"本回合有没有执行"，不是文本异同；同文但真执行 → 放行（RR2 一并覆盖）；
 *   RR2 去重只认 messageId / dispatchKey，不认文本：两个独立请求 = 两次真执行，
 *       第二次回复来自第二次执行（宿主层不复用旧 run）；
 *   RR3 误伤边界：无任务记录的会话、不含数字结论的回复、task_control 显式状态查询
 *       都不触发任何改写；
 *   RR4 三层幂等的既有回归锁：消息级 messageId（tests/e2e/turn-loop-interactive.test.ts）、
 *       任务级 dispatchKey（packages/agent/task-manager.test.ts）、同任务活跃期拒绝
 *       （同上）——本文件不重复实现，只做运行时侧的"新请求必然新执行"锚点。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlatformTaskRecord, TrustedContext } from '@fshine/contracts';
import { messageTextFor } from './src/error-codes';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

const REPEAT_TEXT = messageTextFor('REPEAT_WITHOUT_EXECUTION');

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'req_repeat', principalId: 'wecom:user_a', sessionId: 'sess_1', ...overrides };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: run ?? (async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
  };
}

/** 本会话在册任务的事实源（RR1 门的唯一会话语义输入）。 */
function platformTasksWith(count: number) {
  const records: PlatformTaskRecord[] = Array.from({ length: count }, (_, index) => ({
    taskId: `task_existing_${index + 1}`,
    parentSessionId: 'sess_1',
    principalId: 'wecom:user_a',
    workerMessages: [],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  }));
  const listBySession = vi.fn(async (): Promise<PlatformTaskRecord[]> => records);
  return { listBySession };
}

function captureWarnEvents(eventName: string): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const line = args[0];
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['event'] === eventName) events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
}

describe('RR1 历史答复不得冒充实时（宿主事实判据，不看文本异同）', () => {
  it('有在册任务 + 零委派零执行 + 回复带数字 → 确定性话术拦下，零平台调用', async () => {
    const run = vi.fn(async (): Promise<SubagentTaskResult> => ({ taskId: 'task_never', text: '不应被调用' }));
    const audit = captureWarnEvents('repeat_without_execution');
    try {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ text: '上次查到的应收余额是 61000 元。' }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(run),
        platformTasks: platformTasksWith(1),
      });

      const reply = await runtime.handleTurn(makeCtx(), '把上次的应收余额再告诉我一遍');

      expect(reply.text).toBe(REPEAT_TEXT);
      expect(reply.text).not.toContain('61000');
      expect(run).not.toHaveBeenCalled();
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({ requestId: 'req_repeat', tasksInSession: 1 });
    } finally {
      audit.restore();
    }
  });

  it('改写过的问句同样触发（判据不是文本相同；同一事实对任何措辞都成立）', async () => {
    for (const question of ['刚才那个数是多少来着？', '应收账款现在什么情况？']) {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ text: '应收余额 61000 元。' }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(),
        platformTasks: platformTasksWith(2),
      });
      const reply = await runtime.handleTurn(makeCtx({ requestId: `req_${question.length}` }), question);
      expect(reply.text, question).toBe(REPEAT_TEXT);
    }
  });

  it('同文但本轮真执行（run_task + 执行痕迹）→ 放行', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: 'run_task', args: { request: '查询幻东的应收账款余额' } }] }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async () => ({ taskId: 'task_fresh', text: '幻东 202609 应收余额为 61000 元。', execution: { planId: 'plan_1', version: 1, calls: 1 } })),
      platformTasks: platformTasksWith(1),
    });

    const reply = await runtime.handleTurn(makeCtx(), '把上次的应收余额再告诉我一遍');

    expect(reply.text).toContain('61000');
  });
});

describe('RR2 去重不阻塞新的真实执行（新请求 = 新执行，不复用旧结果）', () => {
  it('两个独立请求各调一次 run_task：执行两次，第二次回复来自第二次执行', async () => {
    let call = 0;
    const run = vi.fn(async (): Promise<SubagentTaskResult> => {
      call += 1;
      return { taskId: `task_${call}`, text: `第 ${call} 次执行的余额为 ${call}00 元。`, execution: { planId: `plan_${call}`, version: 1, calls: 1 } };
    });
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([
        { toolCalls: [{ tool: 'run_task', args: { request: '查询幻东的应收账款余额' } }] },
        { toolCalls: [{ tool: 'run_task', args: { request: '查询幻东的应收账款余额' } }] },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(run),
      platformTasks: platformTasksWith(1),
    });

    const first = await runtime.handleTurn(makeCtx({ requestId: 'req_1' }), '查一下幻东的应收余额');
    const second = await runtime.handleTurn(makeCtx({ requestId: 'req_2' }), '查一下幻东的应收余额');

    expect(run).toHaveBeenCalledTimes(2);                          // 同文不触发宿主层去重
    expect(first.text).toContain('100');
    expect(second.text).toContain('200');
    expect(second.text).not.toBe(first.text);                       // 第二次来自第二次执行，不是旧回执
  });
});

describe('RR3 误伤边界（三要素缺一不拦）', () => {
  it('无任务记录的会话：带数字的闲聊原样通过', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '如果按 50 元一份算，10 份就是 500 元。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith(0),
    });

    const reply = await runtime.handleTurn(makeCtx(), '50 元一份，10 份多少钱？');

    expect(reply.text).toBe('如果按 50 元一份算，10 份就是 500 元。');
  });

  it('有任务记录但回复不含数字结论：原样通过（状态陈述不需要重新执行）', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '之前那个任务已经完成，结果我也整理过。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith(3),
    });

    const reply = await runtime.handleTurn(makeCtx(), '之前那个任务怎么样了？');

    expect(reply.text).toBe('之前那个任务已经完成，结果我也整理过。');
  });

  it('task_control 显式状态查询：即使答复带数字也不改写（状态面答复不需要重新执行）', async () => {
    const backgroundTasks = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      cancel: vi.fn(async () => null),
    };
    const driver: TurnDriver = {
      run: async (input) => {
        await input.exec('task_control', { action: 'list' });
        return { text: '后台任务清单里 2 个任务，最近一个已完成。', messages: input.messages };
      },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith(2),
      backgroundTasks: backgroundTasks as never,
    });

    const reply = await runtime.handleTurn(makeCtx(), '我的任务到哪一步了？');

    expect(reply.text).toBe('后台任务清单里 2 个任务，最近一个已完成。');
  });

  it('委派工具在场但模型选择不调用：任务数为 0 时不拦（没有可依据的会话事实）', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '余额大概是 500 元。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      // 无 platformTasks 注入 = 查不到在册任务 → 门不开（宁缺勿猜）
    });

    const reply = await runtime.handleTurn(makeCtx(), '余额多少？');

    expect(reply.text).toBe('余额大概是 500 元。');
  });
});
