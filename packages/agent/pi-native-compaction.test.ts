/**
 * Pi 原生 Session/压缩替换 · T1–T12 确定性回归（零真实模型；窗口 8192 / 40000 / 128000）。
 *
 * 架构前提（A 口径，owner 裁决 2026-11-15）：
 *   · Pi 原生 `AgentHarness` + `SessionRepo` 是会话转录与压缩生命周期的唯一所有者；
 *   · fshine 只喂 Pi 一个窗口派生的 `CompactionSettings`（配置适配），不实现任何第二套
 *     摘要/裁剪/阈值判定/降级/溢出恢复；
 *   · A 口径：接受「请求 → Overflow Recovery → 有界恢复/失败」——必然超窗请求可被外发，
 *     但必须**有界**（每事件至多一次超窗外发、总发出有上界、必定收束，`retry_scheduled=0`）。
 *
 * 夹具：假 `Models`（`getModel`/`streamSimple`/`completeSimple`），假 provider 侧按
 * 「JSON 串长/4 ≈ token」在派发前判定是否超窗（与 a-metrics 夹具同口径）。全部确定性。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { DiscoveredTool } from '@fshine/contracts';
import { createPiTurnDriver, type PiModelRuntime } from './src/pi-driver';
import { createTaskRegistry } from './src/task-registry';
import type { TurnDriverInput } from './src/driver-contract';

const WINDOWS = [8_192, 40_000, 128_000] as const;
const SUMMARY_MARKER = '【此前会话摘要】';

function usage(totalTokens: number) {
  return {
    input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asst(content: unknown[], stopReason = 'stop', errorMessage?: string): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(5), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  } as unknown as AgentMessage;
}
function textReply(text: string): AgentMessage { return asst([{ type: 'text', text }]); }
function toolCallReply(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return asst([{ type: 'toolCall', id, name, arguments: args }]);
}
function overflowReply(): AgentMessage {
  return asst([], 'error', 'maximum context length exceeded: prompt is too long');
}
/** 带显式 provider usage 的 assistant：Pi 用 usage 估算上下文（不是内容长度），故必须对齐。 */
function assistantWithUsage(totalTokens: number): AgentMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: '此前答复' }], api: 'openai-completions',
    provider: 'llm', model: 'test-model', usage: usage(totalTokens), stopReason: 'stop', timestamp: Date.now(),
  } as unknown as AgentMessage;
}
function streamOf(message: AgentMessage) {
  const stop = (message as { stopReason?: string }).stopReason;
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      if (stop === 'error' || stop === 'aborted') {
        yield { type: 'error', reason: stop, error: message };
      } else {
        yield { type: 'done', reason: stop, message };
      }
    },
    result: async () => message,
  };
}
function user(text: string, ts = 1): AgentMessage {
  return { role: 'user', content: text, timestamp: ts } as unknown as AgentMessage;
}
const estTokens = (messages: readonly unknown[]): number => Math.ceil(JSON.stringify(messages).length / 4);

interface RuntimeScript {
  contextWindow: number;
  /** 依序返回；用尽后按「超窗则返回溢出错误，否则返回默认文本」兜底。 */
  queue?: AgentMessage[];
  /** 摘要请求返回（缺省为一段正常摘要消息）。 */
  summary?: AgentMessage;
  /** 假 provider 是否在派发前按窗口执法（超窗 → 溢出错误）。 */
  enforceOverWindow?: boolean;
}
interface RuntimeStats { sends: number; observed: Array<{ tokens: number; over: boolean }>; }

function makeRuntime(opts: RuntimeScript): { runtime: PiModelRuntime; stats: () => RuntimeStats } {
  const observed: RuntimeStats['observed'] = [];
  const queue = [...(opts.queue ?? [])];
  const model = {
    id: 'test-model', name: 'test-model', api: 'openai-completions', provider: 'llm',
    baseUrl: 'http://127.0.0.1:9', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow, maxTokens: 4_096,
  } as unknown as PiModelRuntime['model'];
  const models = {
    getModel: () => model,
    streamSimple: async (_model: unknown, ctx: { messages: unknown[] }) => {
      const tokens = estTokens(ctx.messages);
      const over = tokens > opts.contextWindow;
      observed.push({ tokens, over });
      const next = queue.shift();
      if (next !== undefined) return streamOf(next);
      if (opts.enforceOverWindow && over) return streamOf(overflowReply());
      return streamOf(textReply('好的。'));
    },
    completeSimple: async () => opts.summary ?? asst([{ type: 'text', text: '摘要：此前对话要点，游标 W1。' }]),
    cancelDeferred: async () => {},
  } as unknown as MutableModels;
  return { runtime: { model, models }, stats: () => ({ sends: observed.length, observed: [...observed] }) };
}

function driverFor(runtime: PiModelRuntime) {
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, runtime });
}
function makeInput(messages: AgentMessage[], opts: {
  tools?: DiscoveredTool[];
  exec?: TurnDriverInput['exec'];
  onStep?: TurnDriverInput['onStep'];
  deadlineMs?: number;
} = {}): TurnDriverInput {
  return {
    systemPrompt: '你是助手。',
    tools: opts.tools ?? [],
    messages,
    onStep: opts.onStep ?? (() => {}),
    exec: opts.exec ?? (async () => undefined),
    deadline: Date.now() + (opts.deadlineMs ?? 60_000),
  };
}
const hasSummary = (messages: readonly AgentMessage[]): boolean =>
  messages.some((m) => {
    const content = (m as { content?: unknown }).content;
    return typeof content === 'string' && content.includes(SUMMARY_MARKER);
  });
const roleOf = (m: AgentMessage): string | undefined => (m as { role?: string }).role;

/** 构造 n 轮「user/assistant」历史；末条 assistant 带显式 usage（驱动 Pi 的 token 估算）。 */
function historyWithUsage(totalTokens: number): AgentMessage[] {
  return [
    user('请查询 W1 的账套。', 1),
    assistantWithUsage(Math.max(1, totalTokens - 20)),
    user('继续。', 2),
  ];
}

// ─────────────────────────────────────────────────────────── T1：短对话不无故压缩
describe('T1 短对话不无故压缩（窗口 8192/40k/128k）', () => {
  it.each(WINDOWS)('W=%i：短对话零压缩、交回正文', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({ contextWindow, queue: [textReply('短回复。')] });
    const result = await driverFor(runtime).run(makeInput([user('你好', 1)]));

    expect(result.text).toBe('短回复。');
    expect(hasSummary(result.messages), '短对话不应产生压缩摘要').toBe(false);
    expect(stats().sends, '短对话只发一次请求').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────── T2：达阈 Pi 自动压缩
describe('T2 达阈 Pi 自动压缩（窗口 8192/40k/128k）', () => {
  it.each(WINDOWS)('W=%i：越过阈值 → Pi 原生压缩（摘要在转录里）', async (contextWindow) => {
    const { runtime } = makeRuntime({ contextWindow, queue: [textReply('压缩后的答复。')] });
    const result = await driverFor(runtime).run(makeInput(historyWithUsage(contextWindow)));

    expect(result.text).toBe('压缩后的答复。');
    expect(hasSummary(result.messages), '越过阈值必须由 Pi 压缩出摘要').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── T3：连续压缩无零收益循环
describe('T3 长历史连续压缩无零收益循环', () => {
  it.each(WINDOWS)('W=%i：连续多回合有界收敛，不无限压缩', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({ contextWindow });
    const driver = driverFor(runtime);
    let messages: AgentMessage[] = [assistantWithUsage(Math.floor(contextWindow * 0.9))];
    for (let turn = 0; turn < 3; turn += 1) {
      const result = await driver.run(makeInput([...messages, user(`第 ${turn} 轮问题，${'x'.repeat(200)}`, turn + 1)]));
      expect(result.text, `第 ${turn} 轮必须有答复/收束`).not.toBeUndefined();
      messages = result.messages;
    }
    const stats_ = stats();
    expect(stats_.sends, '三回合总发出有界（无零收益压缩循环）').toBeLessThanOrEqual(3 * 4);
    expect(hasSummary(messages), '长历史应由 Pi 压缩').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── T4：大型工具结果不破坏配对
describe('T4 大型工具结果不破坏 tool_call/result 配对', () => {
  it.each(WINDOWS)('W=%i：工具调用与结果一一配对且不重复执行', async (contextWindow) => {
    const executions: string[] = [];
    const tool: DiscoveredTool = { name: 'lookup', description: '查询', inputSchema: { type: 'object', properties: {} } };
    const { runtime } = makeRuntime({
      contextWindow,
      queue: [toolCallReply('call_1', 'lookup', { q: 'W1' }), textReply('完成。')],
    });
    const result = await driverFor(runtime).run(makeInput([user('查 W1', 1)], {
      tools: [tool],
      exec: async (name) => { executions.push(name); return { rows: 'y'.repeat(400) }; },
    }));

    const ids = new Set<string>();
    for (const m of result.messages) {
      const rec = m as { role?: string; content?: Array<{ type?: string; id?: string }> };
      if (rec.role === 'assistant' && Array.isArray(rec.content)) {
        for (const block of rec.content) if (block.type === 'toolCall' && block.id) ids.add(block.id);
      }
    }
    const resultIds = result.messages
      .filter((m) => roleOf(m) === 'toolResult')
      .map((m) => (m as { toolCallId?: string }).toolCallId);
    expect(ids.size, '至少一次工具调用').toBeGreaterThan(0);
    for (const id of ids) expect(resultIds, '每个 toolCall 必须有配对结果').toContain(id);
    expect(executions, '工具恰好执行一次（压缩/恢复不重复执行业务操作）').toEqual(['lookup']);
  });
});

// ─────────────────────────────────────────────────────────── T5：当前回合超预算（A 口径：有界）
describe('T5 当前回合超预算：A 口径有界（恢复或失败，不无限重试）', () => {
  it.each(WINDOWS)('W=%i：必然超窗 → 有界收束、总发出有上界', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({ contextWindow, enforceOverWindow: true });
    const result = await driverFor(runtime).run(makeInput([
      user('x'.repeat(contextWindow * 4 + 4_000), 1),
    ]));

    expect(typeof result.text, '必定收束（返回一条字符串，不挂死）').toBe('string');
    expect(stats().sends, '有界：至多一次溢出恢复（首请求 + 重发）').toBeLessThanOrEqual(3);
    expect(stats().observed.some((o) => o.over), 'A 口径允许一次必然超窗外发').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────── T6：摘要失败原生有界
describe('T6 摘要失败原生有界', () => {
  it.each(WINDOWS)('W=%i：摘要请求失败 → Pi 有界继续，不无限重试', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({
      contextWindow,
      queue: [textReply('照常答复。')],
      summary: asst([], 'error', 'summary provider failed'),
    });
    const result = await driverFor(runtime).run(makeInput(historyWithUsage(contextWindow)));

    expect(typeof result.text).toBe('string');
    expect(stats().sends, '摘要失败后总发出有界').toBeLessThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────── T7：Overflow Recovery 能恢复并完成
describe('T7 Overflow Recovery 恢复并继续完成', () => {
  it.each(WINDOWS)('W=%i：溢出 → Pi 原生恢复 → 完成本轮', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({
      contextWindow,
      enforceOverWindow: true,
      queue: [textReply('溢出恢复后完成的答复。')],
    });
    // 首条用户消息本身必然超窗（provider 侧按内容执法）；其后有 assistant 边界，Pi 可切出
    // 前缀摘要并把尾段缩到窗口内 → 恢复后重发成功。
    const result = await driverFor(runtime).run(makeInput([
      user('x'.repeat(contextWindow * 4 + 4_000), 1),
      textReply('中间答复'),
      user('继续。', 2),
    ]));

    expect(result.text, '恢复后交回正文').toBe('溢出恢复后完成的答复。');
    expect(stats().observed.some((o) => o.over), '先发生一次必然超窗外发').toBe(true);
    expect(stats().sends, '溢出恢复至多重发一次').toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────── T8：压缩后能找回重要信息
describe('T8 压缩后仍能找回重要信息', () => {
  it.each(WINDOWS)('W=%i：摘要保留关键信息 + 最近消息保留', async (contextWindow) => {
    const { runtime } = makeRuntime({
      contextWindow,
      queue: [textReply('答复。')],
      summary: asst([{ type: 'text', text: '摘要：当前对象 W1，分页游标 page_7，用户意图是查账。' }]),
    });
    const result = await driverFor(runtime).run(makeInput([
      user('查 W1 账套，游标 page_7。', 1),
      assistantWithUsage(contextWindow),
      user('继续翻页。', 2),
    ]));

    const rendered = JSON.stringify(result.messages);
    expect(rendered, '摘要保留对象标识').toContain('W1');
    expect(rendered, '摘要保留分页游标原值').toContain('page_7');
    expect(rendered, '最近一条用户消息保留').toContain('继续翻页');
  });
});

// ─────────────────────────────────────────────────────────── T9：多 Session 并行无跨会话污染
describe('T9 多 Session 并行无跨会话污染', () => {
  it('两个独立驱动并行：各自转录只含自己的回复', async () => {
    const a = makeRuntime({ contextWindow: 40_000, queue: [textReply('会话甲回复。')] });
    const b = makeRuntime({ contextWindow: 40_000, queue: [textReply('会话乙回复。')] });
    const [ra, rb] = await Promise.all([
      driverFor(a.runtime).run(makeInput([user('甲的问题', 1)])),
      driverFor(b.runtime).run(makeInput([user('乙的问题', 2)])),
    ]);
    const ja = JSON.stringify(ra.messages); const jb = JSON.stringify(rb.messages);
    expect(ja).toContain('会话甲回复'); expect(ja).not.toContain('会话乙回复');
    expect(jb).toContain('会话乙回复'); expect(jb).not.toContain('会话甲回复');
  });
});

// ─────────────────────────────────────────────────────────── T10：多 principal 无串线
describe('T10 多 principal 无串线', () => {
  it('不同 principal 的会话转录互不可见（隔离）', async () => {
    const p1 = makeRuntime({ contextWindow: 40_000, queue: [textReply('principal-p1 的结果。')] });
    const p2 = makeRuntime({ contextWindow: 40_000, queue: [textReply('principal-p2 的结果。')] });
    const r1 = await driverFor(p1.runtime).run(makeInput([user('p1 的请求', 1)]));
    const r2 = await driverFor(p2.runtime).run(makeInput([user('p2 的请求', 2)]));
    expect(JSON.stringify(r1.messages)).not.toContain('principal-p2');
    expect(JSON.stringify(r2.messages)).not.toContain('principal-p1');
  });
});

// ─────────────────────────────────────────────────────────── T12：连续多轮生命周期稳定
describe('T11 压缩后仍能经 Task Registry 找回真实任务结果', () => {
  it.each(WINDOWS)('W=%i：Pi 会话压缩不改变 Task Registry 的真实结果', async (contextWindow) => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'wecom:p1', sessionId: 'sess_t11' };
    const REAL_RESULT = '任务真实结果：W1 账套共 3 条记录。';
    registry.begin({ taskId: 'task_t11', ...scope, request: '查询 W1 账套' });
    registry.complete('task_t11', REAL_RESULT);

    // 跑一次会触发 Pi 压缩的长上下文回合；Task Registry 是唯一事实源，不受 Pi 会话影响。
    const { runtime } = makeRuntime({ contextWindow, queue: [textReply('好的。')] });
    await driverFor(runtime).run(makeInput(historyWithUsage(contextWindow)));

    const task = registry.get('task_t11', scope);
    expect(task.resultText).toBe(REAL_RESULT);
  });
});

describe('T12 连续多轮生命周期稳定不丢上下文', () => {
  it.each(WINDOWS)('W=%i：五连续回合稳定，最近用户消息不丢', async (contextWindow) => {
    const { runtime, stats } = makeRuntime({ contextWindow });
    const driver = driverFor(runtime);
    let messages: AgentMessage[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      const result = await driver.run(makeInput([...messages, user(`第 ${turn} 轮：${'z'.repeat(50)}`, turn + 1)]));
      expect(typeof result.text).toBe('string');
      const rendered = JSON.stringify(result.messages);
      expect(rendered, `第 ${turn} 轮最近用户消息必须保留`).toContain(`第 ${turn} 轮`);
      messages = result.messages;
    }
    expect(stats().sends, '五回合并发有界').toBeLessThanOrEqual(5 * 4);
  });
});
