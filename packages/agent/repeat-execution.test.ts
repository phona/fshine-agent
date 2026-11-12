/**
 * 重复提问 / 历史答复不得冒充实时（RR1 窄门，2026-11-12 收窄后的验收锚点）。
 *
 * 收窄裁定（用户裁定 1）：
 *   · 旧判据（宽，已删除）：本会话有在册任务 + 本回合零委派零执行 + 回复带数字结论 →
 *     一律替换。它不区分"用户把同一请求再发一遍"与"用户换了个说法问同一个话题"。
 *   · 新判据（窄）：只有**当前请求与此前已执行过的请求完全同身份**（requestKey 逐字相等，
 *     requestKey = 归一化正文 + 引用指纹的稳定哈希）、且本回合零委派零执行、回复带数字
 *     结论时，才把历史答复替换掉——不允许把历史结果冒充本轮结果。
 *   · 改写过的问句 = 不同身份 → 不拦（那是普通聊天，由模型如实作答；不新增业务语义分类器）。
 *   · 同文但本轮真执行（execution / 委派工具调用在场）→ 必然放行。
 *   · 辅助存储（platformTasks.listBySession）读取失败或未注入 → 记录 inconclusive 事件，
 *     既不当作已验证通过、也不据此阻断普通聊天。
 *   · messageId 去重与 dispatchKey 幂等是既有机制，不因本门改变（RR2 锚点）。
 *
 * RR3 误伤边界：无记录 / 无数字结论 / task_control 显式状态查询 / 协议复读都不触发改写。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlatformTaskRecord, TrustedContext } from '@fshine/contracts';
import { messageTextFor } from './src/error-codes';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ScriptedTurnDriver, type TurnDriver } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { buildRequestKey } from './src/repeat-request';
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

/**
 * 实体范围来源快照的记录替身：requestKey 是"此前已执行请求"的精确身份。
 * 契约层 PlatformTaskRecord 的 requestKey 字段随本批新增（老记录缺省 = 不可精确匹配）。
 */
function platformTasksWith(records: ReadonlyArray<{ requestKey?: string }>): { listBySession: ReturnType<typeof vi.fn> } {
  const list = records.map((record, index) => ({
    taskId: `task_existing_${index + 1}`,
    parentSessionId: 'sess_1',
    principalId: 'wecom:user_a',
    workerMessages: [],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...(record.requestKey ? { requestKey: record.requestKey } : {}),
  })) as unknown as PlatformTaskRecord[];
  const listBySession = vi.fn(async (): Promise<PlatformTaskRecord[]> => list);
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

describe('RR1 窄门：只有与已执行请求完全同身份才做事实保护（不看措辞相似）', () => {
  it('同身份 + 零委派零执行 + 数字结论 → 确定性话术拦下，零平台调用', async () => {
    const question = '把上次的应收余额再告诉我一遍';
    const run = vi.fn(async (): Promise<SubagentTaskResult> => ({ taskId: 'task_never', text: '不应被调用' }));
    const audit = captureWarnEvents('repeat_without_execution');
    try {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ text: '上次查到的应收余额是 61000 元。' }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(run),
        platformTasks: platformTasksWith([{ requestKey: buildRequestKey(question) }]),
      });

      const reply = await runtime.handleTurn(makeCtx(), question);

      expect(reply.text).toBe(REPEAT_TEXT);
      expect(reply.text).not.toContain('61000');
      expect(run).not.toHaveBeenCalled();
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({ requestId: 'req_repeat' });
      // 事件只陈述"命中精确身份"，不把任务数当判据（旧 detail 的 tasksInSession 已退役）
      expect(audit.events[0]).not.toHaveProperty('tasksInSession');
    } finally {
      audit.restore();
    }
  });

  it('改写过的问句（不同身份）不拦：会话有在册任务也照常放行', async () => {
    // 收窄的核心：旧宽判据在这里会替换（本会话有任务 + 零委派 + 数字），
    // 新窄判据要求 requestKey 逐字相等——改写 = 不同身份。
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '应收余额 61000 元。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey('查一下幻东的应收账款余额') }]),
    });

    const reply = await runtime.handleTurn(makeCtx(), '刚才那个数是多少来着？');

    expect(reply.text).toBe('应收余额 61000 元。');
  });

  it('同文但引用指纹不同 → 不同身份，不拦（requestKey 含引用身份）', async () => {
    const question = '查一下幻东的应收账款余额';
    const priorQuote = { kind: 'text' as const, text: '幻东账套' };
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '应收回款 61000 元。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey(question, { messageReference: priorQuote }) }]),
    });

    const reply = await runtime.handleTurn(makeCtx(), question);

    expect(reply.text).toBe('应收回款 61000 元。');
  });

  it('同文但本轮真执行（run_task + 执行痕迹）→ 放行', async () => {
    const question = '把上次的应收余额再告诉我一遍';
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: 'run_task', args: { request: '查询幻东的应收账款余额' } }] }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(async () => ({ taskId: 'task_fresh', text: '幻东 202609 应收余额为 61000 元。', execution: { planId: 'plan_1', version: 1, calls: 1 } })),
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey(question) }]),
    });

    const reply = await runtime.handleTurn(makeCtx(), question);

    expect(reply.text).toContain('61000');
  });

  it('辅助存储读取失败：不替换、不阻断，只记 inconclusive 事件（可观测）', async () => {
    const question = '把上次的应收余额再告诉我一遍';
    const audit = captureWarnEvents('rr1_identity_inconclusive');
    try {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ text: '上次查到的应收余额是 61000 元。' }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(),
        platformTasks: {
          listBySession: vi.fn(async () => { throw new Error('storage down'); }),
        } as never,
      });

      const reply = await runtime.handleTurn(makeCtx(), question);

      // 不能把"读不到"当成"没有重复"（不判绿），也不能据此阻断普通聊天（不替换）
      expect(reply.text).toBe('上次查到的应收余额是 61000 元。');
      expect(audit.events).toHaveLength(1);
    } finally {
      audit.restore();
    }
  });

  it('辅助存储未注入：同样记 inconclusive、不替换', async () => {
    const audit = captureWarnEvents('rr1_identity_inconclusive');
    try {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ text: '余额大概是 500 元。' }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(),
        // 无 platformTasks 注入 = 无法建立精确身份 → 不猜
      });

      const reply = await runtime.handleTurn(makeCtx(), '余额多少？');

      expect(reply.text).toBe('余额大概是 500 元。');
      expect(audit.events).toHaveLength(1);
    } finally {
      audit.restore();
    }
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
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey('查一下幻东的应收余额') }]),
    });

    const first = await runtime.handleTurn(makeCtx({ requestId: 'req_1' }), '查一下幻东的应收余额');
    const second = await runtime.handleTurn(makeCtx({ requestId: 'req_2' }), '查一下幻东的应收余额');

    expect(run).toHaveBeenCalledTimes(2);                          // 同文不触发宿主层去重
    expect(first.text).toContain('100');
    expect(second.text).toContain('200');
    expect(second.text).not.toBe(first.text);                       // 第二次来自第二次执行，不是旧回执
  });
});

describe('RR3 误伤边界（缺一不拦）', () => {
  it('无任务记录的会话：带数字的闲聊原样通过', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '如果按 50 元一份算，10 份就是 500 元。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith([]),
    });

    const reply = await runtime.handleTurn(makeCtx(), '50 元一份，10 份多少钱？');

    expect(reply.text).toBe('如果按 50 元一份算，10 份就是 500 元。');
  });

  it('有任务记录但回复不含数字结论：原样通过（状态陈述不需要重新执行）', async () => {
    const question = '之前那个任务怎么样了？';
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '之前那个任务已经完成，结果我也整理过。' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey(question) }]),
    });

    const reply = await runtime.handleTurn(makeCtx(), question);

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
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey('我的任务到哪一步了？') }]),
      backgroundTasks: backgroundTasks as never,
    });

    const reply = await runtime.handleTurn(makeCtx(), '我的任务到哪一步了？');

    expect(reply.text).toBe('后台任务清单里 2 个任务，最近一个已完成。');
  });

  it('协议复读走 ② 协议复读门：不归重复提问门', async () => {
    const question = '你好';
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ text: '{"recorded":"conversation"}' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasksWith([{ requestKey: buildRequestKey(question) }]),
    });

    const reply = await runtime.handleTurn(makeCtx(), question);

    expect(reply.text).not.toContain('recorded');
  });
});
