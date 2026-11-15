/**
 * R5-C 压缩计量：六项可观测（调用次数 / token / 耗时 / 前后长度 / 触发原因 / 关联标识）。
 *
 * 观测而非限流——这些用例只读压缩路径发出的结构化日志事件 `context_compaction_metrics`，
 * 不改变任何触发/门控行为。每项计量一条断言，删掉对应字段即红（反向绊线）。
 *
 * 摘要正文只在显式开关打开时随事件落盘，缺省关闭：缺省路径下任何捕获到的日志都不含
 * 夹具摘要正文（默认不落盘真实用户摘要正文）。
 */
import { describe, expect, it, vi } from 'vitest';
import { estimateContextTokens, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import {
  compactTranscriptWithPi,
  compactionCaptureEnabled,
  COMPACTION_CAPTURE_SUMMARY_ENV,
  type PiModelRuntime,
} from './src/pi-driver';

const WINDOW = 40_000;
const MAX_TOKENS = 32_000;
const SUMMARY_TEXT = '【夹具摘要】用户在核对多轮应收余额，最近一次结论是 beta W2 无数据。';

/** 摘要调用返回的固定用量：每调一次都返回这份，便于核对累加。 */
const UNIT_USAGE = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 120 };

interface RecordingRuntime {
  runtime: PiModelRuntime;
  /** 每次摘要调用返回的 usage（按调用顺序）。 */
  calls: Array<{ totalTokens: number }>;
}

/** 假模型运行时：摘要由夹具返回，记录每次调用的 usage（不发任何网络请求）。 */
function recordingRuntime(contextWindow: number): RecordingRuntime {
  const calls: Array<{ totalTokens: number }> = [];
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
      maxTokens: MAX_TOKENS,
    } as unknown as PiModelRuntime['model'],
    models: {
      completeSimple: async () => {
        calls.push({ totalTokens: UNIT_USAGE.totalTokens });
        return {
          role: 'assistant',
          content: [{ type: 'text', text: SUMMARY_TEXT }],
          stopReason: 'stop',
          usage: { ...UNIT_USAGE },
          timestamp: Date.now(),
        };
      },
    } as unknown as MutableModels,
  };
  return { runtime, calls };
}

/** 多轮转录：每轮 user + assistant；末尾补当前回合用户问题（与 T7 用例同形）。 */
function transcript(turns: number, fillerChars: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: 'user',
      content: `第 ${index} 轮：帮我查一下第 ${index} 个对象的应收余额。`,
      timestamp: index * 2,
    } as unknown as AgentMessage);
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `第 ${index} 轮答复：${'x'.repeat(fillerChars)}` }],
      stopReason: 'stop',
      timestamp: index * 2 + 1,
    } as unknown as AgentMessage);
  }
  messages.push({ role: 'user', content: '最后：请汇总今天查到的所有数值。', timestamp: 99_999 } as unknown as AgentMessage);
  return messages;
}

interface MetricsEvent {
  event: string;
  trigger: string;
  correlationId: string;
  outcome: string;
  summaryCalls: number;
  summaryUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  elapsedMs: number;
  tokensBefore: number;
  tokensAfter: number;
  summaryText?: string;
}

/** 捕获 console.log 里的压缩计量事件（返回事件数组与全部原始行）。 */
async function captureMetrics(run: () => Promise<unknown>): Promise<{ events: MetricsEvent[]; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const events = lines
    .filter((line) => line.includes('context_compaction_metrics'))
    .map((line) => JSON.parse(line) as MetricsEvent);
  return { events, lines };
}

/** 120 轮 × 800 字符 ≈ 24k token：越过 40k 窗口阈值（23616），前缀能被单次摘要吃掉。 */
function thresholdTranscript(): AgentMessage[] {
  return transcript(120, 800);
}

describe('R5-C 六项压缩计量', () => {
  it('阈值路径：一次压缩发出一个计量事件，六项齐备', async () => {
    const { runtime, calls } = recordingRuntime(WINDOW);
    const input = thresholdTranscript();
    const before = estimateContextTokens(input).tokens;
    let compacted: AgentMessage[] = [];

    const { events } = await captureMetrics(async () => {
      // 非 force：由 shouldCompact 阈值触发（trigger 缺省解析为 threshold）。
      compacted = await compactTranscriptWithPi(input, undefined, runtime);
    });

    expect(events.length, '阈值触发应恰好发出一个压缩计量事件').toBe(1);
    const metrics = events[0]!;

    // ① 调用次数
    expect(metrics.summaryCalls, '摘要调用次数应等于实际发起的摘要请求数').toBe(calls.length);
    expect(metrics.summaryCalls).toBeGreaterThan(0);
    // ② token（各分片累加）
    expect(metrics.summaryUsage.totalTokens, '摘要 token 应为各次调用返回用量之和').toBe(
      calls.reduce((sum, call) => sum + call.totalTokens, 0),
    );
    expect(metrics.summaryUsage.input).toBe(UNIT_USAGE.input * calls.length);
    expect(metrics.summaryUsage.output).toBe(UNIT_USAGE.output * calls.length);
    // ③ 耗时
    expect(typeof metrics.elapsedMs, '耗时必须是数字（删掉字段即红）').toBe('number');
    expect(metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    // ④ 压缩前后长度
    expect(metrics.tokensBefore, '压缩前长度应为输入转录的估算 token').toBe(before);
    expect(metrics.tokensAfter, '压缩后长度应为产物转录的估算 token').toBe(estimateContextTokens(compacted).tokens);
    expect(metrics.tokensAfter).toBeLessThan(metrics.tokensBefore);
    // ⑤ 触发原因
    expect(metrics.trigger).toBe('threshold');
    // ⑥ 关联标识
    expect(typeof metrics.correlationId).toBe('string');
    expect(metrics.correlationId.length).toBeGreaterThan(0);
  });

  it('触发原因枚举：INV 复核 / overflow / 回合边界 逐项可归因', async () => {
    for (const trigger of ['invariant', 'overflow', 'turn_boundary'] as const) {
      const { runtime } = recordingRuntime(WINDOW);
      const { events } = await captureMetrics(async () => {
        await compactTranscriptWithPi(thresholdTranscript(), { force: true, trigger }, runtime);
      });
      expect(events.length).toBe(1);
      expect(events[0]!.trigger, `显式传入的触发原因 ${trigger} 应原样落入计量`).toBe(trigger);
    }
  });

  it('触发原因缺省解析：force → turn_boundary，非 force → threshold', async () => {
    const forced = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), { force: true }, recordingRuntime(WINDOW).runtime);
    });
    expect(forced.events[0]!.trigger).toBe('turn_boundary');
    const thresholded = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), undefined, recordingRuntime(WINDOW).runtime);
    });
    expect(thresholded.events[0]!.trigger).toBe('threshold');
  });

  it('关联标识：显式 correlationId 原样回显；缺省生成且两次调用不同', async () => {
    const echoed = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), { force: true, correlationId: 'cmp-known-1' }, recordingRuntime(WINDOW).runtime);
    });
    expect(echoed.events[0]!.correlationId, '显式 correlationId 应原样回显（关联调用与触发点）').toBe('cmp-known-1');

    const first = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), { force: true }, recordingRuntime(WINDOW).runtime);
    });
    const second = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), { force: true }, recordingRuntime(WINDOW).runtime);
    });
    const id1 = first.events[0]!.correlationId;
    const id2 = second.events[0]!.correlationId;
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
    expect(id1, '缺省关联标识应每次压缩不同').not.toBe(id2);
  });
});

describe('R5-C 摘要正文捕获开关（缺省关闭）', () => {
  it('缺省路径：计量事件与实际日志都不含摘要正文', async () => {
    const { runtime } = recordingRuntime(WINDOW);
    const { events, lines } = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), undefined, runtime);
    });
    expect(events.length).toBe(1);
    expect('summaryText' in events[0]!, '缺省路径计量事件不得含摘要正文').toBe(false);
    expect(lines.join('\n'), '缺省路径捕获到的任何日志都不得含摘要正文').not.toContain(SUMMARY_TEXT);
  });

  it('显式开关打开：计量事件携带摘要正文（仅隔离测试环境）', async () => {
    const { runtime } = recordingRuntime(WINDOW);
    const { events } = await captureMetrics(async () => {
      await compactTranscriptWithPi(thresholdTranscript(), { captureSummaryText: true }, runtime);
    });
    expect(events[0]!.summaryText, '开关打开时计量事件应携带摘要正文').toBe(SUMMARY_TEXT);
  });

  it('开关解析：仅显式非空值打开，空/未设置为关闭', () => {
    expect(compactionCaptureEnabled(undefined)).toBe(false);
    expect(compactionCaptureEnabled({})).toBe(false);
    expect(compactionCaptureEnabled({ [COMPACTION_CAPTURE_SUMMARY_ENV]: '' })).toBe(false);
    expect(compactionCaptureEnabled({ [COMPACTION_CAPTURE_SUMMARY_ENV]: '0' })).toBe(false);
    expect(compactionCaptureEnabled({ [COMPACTION_CAPTURE_SUMMARY_ENV]: '1' })).toBe(true);
    expect(compactionCaptureEnabled({ [COMPACTION_CAPTURE_SUMMARY_ENV]: 'true' })).toBe(true);
  });
});
