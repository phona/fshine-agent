/**
 * Phase3 隔离 PoC —— fshine 压缩编排（pi-driver）8 场景确定性验证。
 *
 * 边界（硬）：产品代码零修改；只用确定性假模型运行时（不发任何网络请求）；
 * 不升级 Pi；不读 .env、不烧付费模型额度；仅新增本测试文件（scripts/** 纳入 vitest unit）。
 *
 * 方法：直接调用生产压缩/驱动函数（compactTranscriptWithPi / createPiTurnDriver）+
 * 单例假 PiModelRuntime（completeSimple 返回夹具摘要、streamSimple 计数/抛错）。
 * 每个场景给机械断言；需要真实模型判「摘要语义质量」的部分在本文件末尾显式标 UNVERIFIED。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  estimateContextTokens,
  shouldCompact,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import {
  compactionSettingsFor,
  compactTranscriptWithPi,
  createPiTurnDriver,
  type PiModelRuntime,
} from '../../../packages/agent/src/pi-driver';
import { createTaskRegistry } from '../../../packages/agent/src/task-registry';

const SUMMARY_TEXT = '【夹具摘要】对象 ORD-2026-0007，游标保留 cursor=eyJvZmZzZXQiOjEwMH0，最近结论 beta W2 无数据。';
const DEFAULT_WINDOW = 40_000;

interface SummaryRequest {
  promptTokens: number;
  maxTokens: number;
  /** 摘要请求的实际文本（user 消息）——用于核对语义保留指令是否送达摘要模型。 */
  promptText: string;
}

/** 确定性假 Pi 运行时：摘要返回夹具；可选「像真实供应商一样拒绝超窗请求」/「摘要失败」。 */
function makeRuntime(
  contextWindow: number,
  opts: {
    summaryText?: string;
    enforceWindow?: boolean;
    modelMaxTokens?: number;
    throwOnStream?: boolean;
    failingSummary?: boolean;
  } = {},
): { runtime: PiModelRuntime; summaryRequests: SummaryRequest[]; streamCalls: () => number } {
  const summaryRequests: SummaryRequest[] = [];
  let streamCalls = 0;
  const modelMaxTokens = opts.modelMaxTokens ?? 32_000;
  const runtime: PiModelRuntime = {
    model: {
      id: 'step-3.7-flash',
      name: 'step-3.7-flash',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: modelMaxTokens,
    } as unknown as PiModelRuntime['model'],
    models: {
      completeSimple: async (
        _model: unknown,
        context: { systemPrompt?: string; messages?: Array<{ content?: unknown }> },
        options?: { maxTokens?: number },
      ) => {
        const text = `${context.systemPrompt ?? ''}\n${(context.messages ?? []).map((m) => contentText(m.content)).join('\n')}`;
        const promptTokens = Math.ceil(text.length / 4);
        const maxTokens = options?.maxTokens ?? modelMaxTokens;
        summaryRequests.push({ promptTokens, maxTokens, promptText: text });
        if (opts.failingSummary) {
          return {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: `maximum context length exceeded: ${promptTokens} + ${maxTokens} > ${contextWindow}`,
            timestamp: Date.now(),
          } as unknown as AgentMessage;
        }
        if (opts.enforceWindow && promptTokens + maxTokens > contextWindow) {
          return {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: `maximum context length exceeded: ${promptTokens} + ${maxTokens} > ${contextWindow}`,
            timestamp: Date.now(),
          } as unknown as AgentMessage;
        }
        return {
          role: 'assistant',
          content: [{ type: 'text', text: opts.summaryText ?? SUMMARY_TEXT }],
          stopReason: 'stop',
          timestamp: Date.now(),
        } as unknown as AgentMessage;
      },
      streamSimple: async () => {
        streamCalls += 1;
        if (opts.throwOnStream) throw new Error('（PoC）本地运行时禁止真实请求');
        return { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now() } as unknown as AgentMessage;
      },
    } as unknown as MutableModels,
  };
  return { runtime, summaryRequests, streamCalls: () => streamCalls };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    const record = block as { type?: string; text?: string };
    return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
  }).join('');
}

function userMsg(text: string, timestamp = 0): AgentMessage {
  return { role: 'user', content: text, timestamp } as unknown as AgentMessage;
}
function assistantText(text: string, timestamp = 0): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp } as unknown as AgentMessage;
}
/** assistant 工具调用（pi 原生 toolCall 块）。 */
function assistantToolCall(name: string, args: Record<string, unknown>, timestamp = 0): AgentMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id: `call_${name}`, name, arguments: args }], stopReason: 'toolUse', timestamp } as unknown as AgentMessage;
}
/** 工具结果（pi 原生 toolResult 消息）。 */
function toolResult(name: string, text: string, timestamp = 0): AgentMessage {
  return { role: 'toolResult', toolCallId: `call_${name}`, content: text, timestamp } as unknown as AgentMessage;
}

/** 多轮旧历史（user+assistant），fillerChars 控制体量。 */
function history(turns: number, fillerChars: number, offset = 0): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(userMsg(`第 ${offset + i} 轮：查一下第 ${offset + i} 个对象的应收余额。`, offset + i));
    out.push(assistantText(`第 ${offset + i} 轮答复：${'x'.repeat(fillerChars)}`, offset + i));
  }
  return out;
}

/** 足够越过 128k 缺省设置阈值（W=40000 → 阈值 23616）的历史。 */
function bigHistory(): AgentMessage[] {
  return history(45, 2_600);
}

function tokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens(messages as never).tokens;
}

// ---------------------------------------------------------------------------
// ① 正常接近阈值 → 触发有效压缩
// ---------------------------------------------------------------------------
describe('① 正常接近阈值：压缩被触发且产物真的变小', () => {
  it('转录超阈值：发起摘要、首条为原生摘要、token 严格下降并回落到阈值以下、当前回合保留', async () => {
    const { runtime, summaryRequests } = makeRuntime(DEFAULT_WINDOW);
    const messages = [...bigHistory(), userMsg('最后：请汇总今天查到的所有数值。', 99_999)];
    const before = tokens(messages);
    const threshold = DEFAULT_WINDOW - compactionSettingsFor(DEFAULT_WINDOW).reserveTokens;
    expect(before, '夹具未越过阈值').toBeGreaterThan(threshold);
    expect(shouldCompact(before, DEFAULT_WINDOW, compactionSettingsFor(DEFAULT_WINDOW))).toBe(true);

    const compacted = await compactTranscriptWithPi(messages, undefined, runtime);
    const after = tokens(compacted);

    expect(summaryRequests.length, '接近阈值却没有发起摘要').toBeGreaterThan(0);
    expect(JSON.stringify(compacted[0]), '首条不是原生摘要').toContain('【此前会话摘要】');
    expect(after, '压缩没有让上下文变小').toBeLessThan(before);
    expect(after, '产物未回落到阈值以下').toBeLessThanOrEqual(threshold);
    expect(JSON.stringify(compacted), '当前回合的问题被压缩吃掉').toContain('请汇总今天查到的所有数值');
  });
});

// ---------------------------------------------------------------------------
// ② 无可压缩历史 → 避免无收益摘要调用
// ---------------------------------------------------------------------------
describe('② 无可压缩历史：是否避免无收益摘要调用', () => {
  it('②a 转录未越阈值：compact 原样返回同一数组、零摘要调用', async () => {
    const { runtime, summaryRequests } = makeRuntime(DEFAULT_WINDOW);
    const messages = history(20, 900); // ≈4.6k token，远低于阈值 23616
    const before = tokens(messages);
    expect(shouldCompact(before, DEFAULT_WINDOW, compactionSettingsFor(DEFAULT_WINDOW))).toBe(false);

    const compacted = await compactTranscriptWithPi(messages, undefined, runtime);
    expect(summaryRequests.length, '未越阈值却调用了摘要模型').toBe(0);
    expect(compacted, '未越阈值应原样返回同一数组').toBe(messages);
  });

  it('②b 有 prefix 但保留尾段自身已达/超目标：现状仍发起零收益摘要调用（§七十预判未实施）', async () => {
    // §六十九 实测几何：W=8192、Δ≈4656 → reserve=5680、target=limit=2512；当前回合（工具循环）
    // 自身 > target，splitForCompaction 只切出 1 条小旧消息 → 「摘要换摘要」，tokensAfter≥tokensBefore。
    const W = 8_192;
    const delta = 4_656;
    const { runtime, summaryRequests } = makeRuntime(W, { enforceWindow: true, modelMaxTokens: 4_000 });
    const messages = [
      userMsg('继续核对。', 40),
      assistantToolCall('dummy.query', { collection: 'orders' }, 41),
      toolResult('dummy.query', 'y'.repeat(20_000), 50), // ~5k token：当前回合主体
    ];
    const before = tokens(messages);
    const target = W - compactionSettingsFor(W, delta).reserveTokens;
    expect(before, '夹具未越过触发线').toBeGreaterThan(target);

    const compacted = await compactTranscriptWithPi(messages, { force: true, fixedOverheadTokens: delta }, runtime);
    const after = tokens(compacted);
    // 现状（无 §七十 precheck）：摘要确实被调用，且这次压缩零/负缩减 —— 即「无收益摘要调用」。
    expect(summaryRequests.length, '本应暴露零收益摘要调用，却没有发起摘要').toBeGreaterThan(0);
    expect(after, `压缩零收益（before=${before} after=${after}）：§七十 precheck 未实施时应观察到该形态`).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// ③ 当前回合自身超窗 → 请求前有界失败
// ---------------------------------------------------------------------------
describe('③ 当前回合自身超窗：请求前有界失败、不发请求', () => {
  it('③a no_cut 且超 LIMIT（大固定开销）：compactTranscriptWithPi 抛 context_invariant_violated、零摘要调用', async () => {
    // W=20000、Δ=13096 → reserve=14120、threshold=LIMIT=5880、keepRecent=6000；
    // 单条 5900 token 当前回合消息：>阈值、装得进 keepRecent → prefix 空（no_cut）且超 LIMIT。
    const { runtime, summaryRequests } = makeRuntime(20_000, { modelMaxTokens: 4_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        compactTranscriptWithPi([userMsg('x'.repeat(23_600), 1)], { fixedOverheadTokens: 13_096 }, runtime),
      ).rejects.toThrow('上下文不变式不满足');
      expect(summaryRequests.length, 'no_cut 有界失败路径不得调用摘要模型').toBe(0);
      expect(error.mock.calls.some((c) => String(c[0]).includes('context_invariant_violated'))).toBe(true);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('③b driver.run 请求前把关：摘要救不回时 streamSimple 零调用、返回空文本、发 rejected 事件', async () => {
    const W = 20_000;
    const { runtime, streamCalls } = makeRuntime(W, { throwOnStream: true, modelMaxTokens: 4_000, failingSummary: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime });
      const result = await driver.run({
        systemPrompt: '你是助手。',
        tools: [],
        messages: [userMsg('请处理：' + 'x'.repeat(120_000), 1)],
        onStep: () => {},
        exec: async () => undefined,
        deadline: Date.now() + 30_000,
      });
      expect(streamCalls(), '不变式无解时不得把必然失败的请求发给模型').toBe(0);
      expect(result.text).toBe('');
      expect(error.mock.calls.some((call) => String(call[0]).includes('pi_driver_context_invariant_rejected'))).toBe(true);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 多轮工具调用 → 保护当前执行上下文
// ---------------------------------------------------------------------------
describe('④ 多轮工具调用：切分保护当前回合（不拆散 toolCall 与 toolResult）', () => {
  it('当前回合含 toolCall+toolResult：压缩后保留尾段含该配对、不以 toolResult 开头、顺序不变', async () => {
    const W = 8_192;
    const delta = 4_656;
    const { runtime } = makeRuntime(W, { enforceWindow: true, modelMaxTokens: 4_000 });
    const messages = [
      userMsg('继续核对。', 40),
      assistantToolCall('dummy.query', { collection: 'orders' }, 41),
      toolResult('dummy.query', 'y'.repeat(20_000), 50),
    ];
    const compacted = await compactTranscriptWithPi(messages, { force: true, fixedOverheadTokens: delta }, runtime);
    expect(JSON.stringify(compacted[0]), '未发生压缩：首条不是摘要').toContain('【此前会话摘要】');
    const kept = compacted.slice(1);
    expect((kept[0] as { role?: string }).role, '保留尾段以 toolResult 开头：toolCall/结果配对被拆散').not.toBe('toolResult');
    const idxCall = kept.findIndex((m) => (m as { role?: string }).role === 'assistant');
    const idxResult = kept.findIndex((m) => (m as { role?: string }).role === 'toolResult');
    expect(idxCall, '当前回合的 assistant toolCall 被压缩吃掉').toBeGreaterThanOrEqual(0);
    expect(idxResult, '当前回合的 toolResult 被压缩吃掉').toBeGreaterThanOrEqual(0);
    expect(idxCall, 'toolCall 与 toolResult 顺序被打乱').toBeLessThan(idxResult);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 大型工具结果 → 合理裁剪与恢复
// ---------------------------------------------------------------------------
describe('⑤ 大型工具结果：摘要输入有界（裁剪只作用于摘要输入），数据靠重调工具恢复', () => {
  it('单条超大 toolResult：摘要请求 ≤ 窗口；产物按 target 裁剪（丢超大结果）、当前回合保留', async () => {
    const { runtime, summaryRequests } = makeRuntime(DEFAULT_WINDOW, { enforceWindow: true, modelMaxTokens: 32_000 });
    const messages = [
      userMsg('查询大批量订单明细。', 1),
      assistantToolCall('dummy.query', { collection: 'orders' }, 2),
      toolResult('dummy.query', 'z'.repeat(400_000), 3), // ~100k token：单条远超一次摘要输入预算
      userMsg('请只汇总总数。', 4),
    ];
    const compacted = await compactTranscriptWithPi(messages, { force: true }, runtime);

    expect(summaryRequests.length, '超大单条消息导致摘要未发起').toBeGreaterThan(0);
    for (const req of summaryRequests) {
      expect(
        req.promptTokens + req.maxTokens,
        `摘要请求自身超窗（prompt ${req.promptTokens} + maxTokens ${req.maxTokens} > ${DEFAULT_WINDOW}）：供应商会拒绝，压缩永远失败`,
      ).toBeLessThanOrEqual(DEFAULT_WINDOW);
    }
    expect(JSON.stringify(compacted[0]), '未发生压缩').toContain('【此前会话摘要】');
    expect(JSON.stringify(compacted[0]), '注入摘要未声明重取数据路径').toContain('具体数据请以重新调用工具的结果为准');
    expect(JSON.stringify(compacted), '当前回合问题被吃掉').toContain('请只汇总总数');
  });

  it('体量落在保留尾段内的 toolResult：原文字节一字不改地留在 kept（无驱动级静默截断）', async () => {
    const { runtime } = makeRuntime(DEFAULT_WINDOW);
    const payload = 'DATA-' + 'q'.repeat(600);
    const messages = [
      ...bigHistory(),
      userMsg('查看明细。', 41),
      assistantToolCall('dummy.query', { collection: 'orders' }, 42),
      toolResult('dummy.query', payload, 43),
    ];
    const compacted = await compactTranscriptWithPi(messages, undefined, runtime);
    expect(JSON.stringify(compacted[0]), '夹具未触发压缩，用例不成立').toContain('【此前会话摘要】');
    expect(
      compacted.some((m) => (m as { role?: string }).role === 'toolResult' && contentText((m as { content?: unknown }).content) === payload),
      '保留尾段里的工具结果被静默改写/截断',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 多次连续压缩 → 重复摘要循环
// ---------------------------------------------------------------------------
describe('⑥ 多次连续压缩：工具循环几何下不收敛（重复摘要循环）', () => {
  it('复现 §六十九 零收益循环：emergency 力压缩反复调用摘要且 token 不降', async () => {
    const W = 8_192;
    const delta = 4_656;
    const { runtime, summaryRequests } = makeRuntime(W, { enforceWindow: true, modelMaxTokens: 4_000 });
    const messages = [
      userMsg('继续核对。', 40),
      assistantToolCall('dummy.query', { collection: 'orders' }, 41),
      toolResult('dummy.query', 'y'.repeat(20_000), 50),
    ];
    const target = W - compactionSettingsFor(W, delta).reserveTokens; // 2512，emergency 线同值

    // 模拟 transformContext emergency 臂：tokens > 线就以 force 压缩，最多 6 轮；连续两轮无下降即认定循环。
    let current = messages;
    const trace: Array<{ round: number; before: number; after: number }> = [];
    for (let round = 0; round < 6 && tokens(current) > target; round += 1) {
      const before = tokens(current);
      current = await compactTranscriptWithPi(current, { force: true, fixedOverheadTokens: delta }, runtime);
      const after = tokens(current);
      trace.push({ round: round + 1, before, after });
      if (after >= before && round >= 1) break;
    }

    const stagnant = trace.filter((t) => t.after >= t.before);
    expect(trace.length, '夹具未触发 emergency 压缩').toBeGreaterThan(1);
    expect(stagnant.length, `未观察到零收益压缩轮（trace=${JSON.stringify(trace)}）`).toBeGreaterThan(0);
    expect(summaryRequests.length, '循环未表现为反复摘要调用').toBeGreaterThan(1);
    // 零收益 ≠ 零调用：每轮至少一次真实摘要调用。
    expect(summaryRequests.length).toBeGreaterThanOrEqual(trace.length);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 压缩后继续交办 → 保持必要语义
// ---------------------------------------------------------------------------
describe('⑦ 压缩后继续交办：机制面保留必要语义；质量面标未验证', () => {
  it('摘要指令把保留清单（对象标识/游标/未决问题）送达摘要模型；注入摘要含重取数据提示；当前回合可续', async () => {
    const { runtime, summaryRequests } = makeRuntime(DEFAULT_WINDOW);
    const messages = [
      userMsg('核对 ORD-2026-0007，游标 cursor=eyJvZmZzZXQiOjEwMH0 原值保留。', 1),
      ...bigHistory(),
      userMsg('继续：请汇总所有数值。', 99_999),
    ];
    const compacted = await compactTranscriptWithPi(messages, undefined, runtime);

    const combined = summaryRequests.map((r) => r.promptText).join('\n');
    expect(summaryRequests.length, '未发生压缩，用例不成立').toBeGreaterThan(0);
    expect(combined, '摘要指令未要求保留当前对象标识').toContain('当前正在处理的对象标识');
    expect(combined, '摘要指令未要求保留分页游标原值').toContain('分页游标原值');
    expect(combined, '摘要指令未要求保留未决问题').toContain('未决问题');
    expect(JSON.stringify(compacted[0]), '注入摘要未声明更早逐字内容已不在上下文').toContain('更早的逐字内容已不在上下文中');
    expect(JSON.stringify(compacted), '压缩后当前回合问题丢失（无法继续交办）').toContain('请汇总所有数值');
  });
});

// ---------------------------------------------------------------------------
// ⑧ 执行事实找回 → 仍经 fshine 账本
// ---------------------------------------------------------------------------
describe('⑧ 执行事实找回：事实存于 fshine 底账，独立于被压缩的转录', () => {
  it('转录被压掉对象名后，任务底账仍原样读回 taskNo/name/resultText', async () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'p1', sessionId: 's1' };
    const task = registry.begin({
      taskId: 'task_1',
      principalId: 'p1',
      sessionId: 's1',
      request: '核对 ORD-2026-0999 的应收余额',
      status: 'running',
    });
    registry.noteExecution('task_1', { requestId: 'req_1', operation: 'query', status: 'completed' });
    registry.complete('task_1', 'ORD-2026-0999 应收余额 1234.56，游标 page_7。');

    // 压缩转录（含对象名 ORD-2026-0999 的旧消息被摘要替换）。
    const { runtime } = makeRuntime(DEFAULT_WINDOW);
    const messages = [
      userMsg('核对 ORD-2026-0999 的应收余额。', 1),
      ...bigHistory(),
      userMsg('继续。', 99_999),
    ];
    const compacted = await compactTranscriptWithPi(messages, undefined, runtime);
    expect(JSON.stringify(compacted), '夹具未触发压缩，用例不成立').toContain('【此前会话摘要】');
    expect(JSON.stringify(compacted), '对象名仍逐字留在转录（则本场景不成立）').not.toContain('ORD-2026-0999');

    // 事实仍经底账读回（与转录无关的持久化）：task_status/task_result 的数据源。
    const stored = registry.get('task_1', scope);
    expect(stored.taskNo).toBe(task.taskNo);
    expect(stored.name).toContain('ORD-2026-0999');
    expect(stored.resultText).toContain('1234.56');
    expect(stored.executions.map((e) => e.requestId)).toContain('req_1');
    expect(JSON.stringify(compacted[0]), '注入摘要未指向账本重取路径').toContain('具体数据请以重新调用工具的结果为准');
  });
});

// ---------------------------------------------------------------------------
// UNVERIFIED（需真实模型判摘要质量，本轮零付费模型实验，不跑）
// ---------------------------------------------------------------------------
describe('UNVERIFIED 登记（未运行，需真实模型）', () => {
  it.todo('⑦ 摘要正文是否真的无损保留对象标识/游标/未决问题（质量面）——需真实模型，未验证');
  it.todo('②b/⑥ 在 128k 生产窗口的命中率与用户级影响——无真实长会话读数，不外推，未验证');
  it.todo('⑤ 大型工具结果在真实执行层的裁剪策略（本 PoC 只覆盖驱动消费侧）——未验证');
});
