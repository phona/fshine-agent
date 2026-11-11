/**
 * T7 窗口贴边：压缩必须让上下文真的变小，且摘要请求自己不得超出模型窗口。
 *
 * 今天实测（长窗臂 C1 index 16/18/19，window=40000）：空回复落到
 * 「查询失败,请稍后再试或联系管理员」。根因链的两段都在这里钉住：
 *   ① 压缩设置用的是 128k 窗口的常数（reserveTokens=16384、keepRecentTokens=20000）。
 *      窗口只有 40000 时，阈值 23616 一旦跨过，摘要请求把**整段转录**（已 30k-48k）
 *      塞进一次模型调用；输入 + 摘要输出预留远超窗口 ⇒ 摘要失败 ⇒ 转录原样返回 ⇒
 *      主请求继续贴着/越过窗口 ⇒ 模型返回空 ⇒ 宿主兜底话术零数字。
 *   ② keepRecentTokens(20000) 不随窗口缩放：小窗口下压缩会把**全部消息**留下再拼一条
 *      摘要，产物比输入还长——压缩方向反了，越压越大。
 *
 * 机械判据（假模型运行时离线执行生产压缩代码；它像真实供应商一样拒绝
 * `promptTokens + maxTokens > contextWindow` 的请求）：
 *   · 每一次摘要请求都必须满足 promptTokens + maxTokens ≤ 窗口（不允许把超窗请求发给模型）；
 *   · 超窗转录压缩后必须真的产生原生摘要，且估算 token 严格下降、回落到阈值以下；
 *   · 小窗口下未到阈值时不得压缩（当前实现会把全部消息 + 摘要一起返回，越压越大）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import {
  compactionSettingsFor,
  compactTranscriptWithPi,
  DEFAULT_CONTEXT_WINDOW,
  type PiModelRuntime,
} from './src/pi-driver';

const WINDOW = 40_000;
const MAX_TOKENS = 32_000;
const SUMMARY_TEXT = '【夹具摘要】用户在核对多轮应收余额，最近一次结论是 beta W2 无数据。';

interface SummaryRequest {
  promptTokens: number;
  maxTokens: number;
}

/**
 * 假模型运行时：摘要由夹具返回；请求超窗时像真实 OpenAI 兼容端点一样返回
 * stopReason=error（`generateSummary` 把它转成 CompactionError）。
 */
function enforcingRuntime(contextWindow: number): { runtime: PiModelRuntime; requests: SummaryRequest[] } {
  const requests: SummaryRequest[] = [];
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
      completeSimple: async (
        _model: unknown,
        context: { systemPrompt?: string; messages?: Array<{ content?: unknown }> },
        options?: { maxTokens?: number },
      ) => {
        // 与供应商同口径：把这次请求实际要发的文本换算成 token。
        const text = `${context.systemPrompt ?? ''}\n${(context.messages ?? []).map((message) => contentText(message.content)).join('\n')}`;
        const promptTokens = Math.ceil(text.length / 4);
        const maxTokens = options?.maxTokens ?? MAX_TOKENS;
        requests.push({ promptTokens, maxTokens });
        if (promptTokens + maxTokens > contextWindow) {
          return {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: `maximum context length exceeded: ${promptTokens} + ${maxTokens} > ${contextWindow}`,
            usage: { input: promptTokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: promptTokens },
            timestamp: Date.now(),
          };
        }
        return {
          role: 'assistant',
          content: [{ type: 'text', text: SUMMARY_TEXT }],
          stopReason: 'stop',
          usage: { input: promptTokens, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: promptTokens + 10 },
          timestamp: Date.now(),
        };
      },
    } as unknown as MutableModels,
  };
  return { runtime, requests };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    const record = block as { type?: string; text?: string };
    return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
  }).join('');
}

/** 多轮转录：每轮一条 user + 一条 assistant；末尾补当前回合的用户问题。 */
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

describe('T7 压缩在窗口贴边时必须真的缩小上下文', () => {
  it('超窗转录：摘要请求不超窗、产物有摘要且 token 严格下降', async () => {
    const { runtime, requests } = enforcingRuntime(WINDOW);
    // 200 轮 × ~900 字符 ≈ 45k token，远超 40k 窗口。
    const input = transcript(200, 900);
    const before = estimateContextTokens(input).tokens;
    expect(before, '夹具没有构造出超窗转录，用例不成立').toBeGreaterThan(WINDOW);

    const compacted = await compactTranscriptWithPi(input, undefined, runtime);

    expect(requests.length, '压缩没有发起任何摘要请求').toBeGreaterThan(0);
    for (const request of requests) {
      expect(
        request.promptTokens + request.maxTokens,
        `摘要请求自己超出模型窗口（prompt ${request.promptTokens} + maxTokens ${request.maxTokens} > ${WINDOW}）——供应商会拒绝它，压缩永远失败`,
      ).toBeLessThanOrEqual(WINDOW);
    }
    expect(JSON.stringify(compacted[0]), '压缩没有发生：首条不是原生摘要').toContain('【此前会话摘要】');
    const after = estimateContextTokens(compacted).tokens;
    expect(after, '压缩没有让上下文变小（把整段转录原样返回不是压缩）').toBeLessThan(before);
    expect(
      shouldCompact(after, WINDOW, DEFAULT_COMPACTION_SETTINGS),
      `压缩后的上下文仍有 ${after} token，没有回落到默认阈值以下`,
    ).toBe(false);
    // 当前回合的问题必须留下——压缩不能把要回答的这句话也吃掉。
    expect(JSON.stringify(compacted)).toContain('请汇总今天查到的所有数值');
  });

  it('小窗口未到阈值：不压缩（当前实现会把全部消息 + 摘要一起返回，越压越大）', async () => {
    const smallWindow = 20_000;
    const { runtime } = enforcingRuntime(smallWindow);
    // 25 轮 × ~800 字符 ≈ 5k token：远低于 20k 窗口，却是旧常数阈值（20000-16384=3616）之上。
    const input = transcript(25, 800);
    const before = estimateContextTokens(input).tokens;
    expect(before).toBeGreaterThan(smallWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    expect(
      shouldCompact(before, smallWindow, DEFAULT_COMPACTION_SETTINGS),
      '这个夹具在当前常数阈值下没有触发压缩，用例不成立',
    ).toBe(true);

    const compacted = await compactTranscriptWithPi(input, undefined, runtime);
    const after = estimateContextTokens(compacted).tokens;

    expect(
      after,
      `压缩把上下文从 ${before} 变成了 ${after}：未到窗口该有的占用却触发了压缩，且 keepRecentTokens 不随窗口缩放把全部消息都留下了`,
    ).toBeLessThanOrEqual(before);
    // 变更方向：真正需要压缩的窗口下，压缩产物必须仍带原生摘要（不许为了变小而静默丢历史）。
    if (after < before) expect(JSON.stringify(compacted[0])).toContain('【此前会话摘要】');
  });
});

describe('T7 压缩设置随窗口缩放（128k 缺省逐字段不变）', () => {
  it('128k 与更大的窗口沿用默认设置：现有压缩时机不被 T7 改动', () => {
    expect(compactionSettingsFor(DEFAULT_CONTEXT_WINDOW)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    expect(compactionSettingsFor(200_000)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    // 40k 仍装得下「保留尾段 20000 + 摘要预留 16384」，保持原有阈值（长会话用例按它取数）。
    expect(compactionSettingsFor(40_000)).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it('装不下默认设置的窗口按比例缩放：保留尾段 + 摘要预留必须留在窗口内', () => {
    for (const window of [8_000, 16_000, 20_000]) {
      const settings = compactionSettingsFor(window);
      expect(settings.reserveTokens + settings.keepRecentTokens, `窗口 ${window} 的默认预留装不下`).toBeLessThan(window);
      expect(settings.reserveTokens).toBeLessThan(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
      expect(settings.keepRecentTokens).toBeLessThan(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
    }
  });
});
