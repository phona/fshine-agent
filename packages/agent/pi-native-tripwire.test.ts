/**
 * Pi 原生 Session/压缩替换 · 反向绊线（故意破坏禁止行为必须红）。
 *
 * 三条：
 *   A. 静态「禁止回潮」：生产驱动源码不得再出现任何自研压缩符号/事件——一旦有人把
 *      host 摘要/裁剪/阈值/降级/溢出恢复或 D1 臂加回来，本守卫即红。
 *   B. 配置适配承重：把 Pi 压缩配置关掉（模拟缺失配置适配）→ Pi 不再压缩（坏状态）；
 *      用生产 `piCompactionSettings` 则正常压缩。若适配被删成 `enabled:false`，T2 即红。
 *   C. A 口径 `retry_scheduled=0`：必然超窗场景下驱动不得记录任何重试调度（不因超窗重试）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentHarness, type AgentMessage } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createPiTurnDriver, piCompactionSettings, type PiModelRuntime } from './src/pi-driver';

const FORBIDDEN_SYMBOLS = [
  'compactTranscriptWithPi',
  'compactionSettingsFor',
  'splitForCompaction',
  'summarizeWithinWindow',
  'trimToBudget',
  'degradeByDropping',
  'invariantReserveTokens',
  'invariantLimitTokens',
  'fixedRequestOverheadTokens',
  'CONTEXT_WINDOW_FLOOR_TOKENS',
  'MIN_OUTPUT_BUDGET_TOKENS',
  'CONTEXT_REQUEST_FRAMING_TOKENS',
  'isContextOverflowError',
  'pi_driver_pre_request_compacted',
  'pi_driver_context_overflow_recovered',
  'context_emergency_compact',
];

describe('反向绊线 A · 生产驱动不含任何自研压缩回潮', () => {
  const source = readFileSync(path.resolve(__dirname, 'src/pi-driver.ts'), 'utf8');
  it.each(FORBIDDEN_SYMBOLS)('不得出现已删符号/事件：%s', (symbol) => {
    expect(source.includes(symbol), `${symbol} 回潮：Pi 必须是压缩生命周期唯一所有者`).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────── 夹具（与 T 系列同口径）
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

async function runBareHarness(compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } | undefined, contextWindow: number) {
  const model = {
    id: 'test-model', name: 'test-model', api: 'openai-completions', provider: 'llm',
    baseUrl: 'http://127.0.0.1:9', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4_096,
  } as unknown as PiModelRuntime['model'];
  const models = {
    getModel: () => model,
    streamSimple: async () => streamOf(asst([{ type: 'text', text: '好的。' }])),
    completeSimple: async () => asst([{ type: 'text', text: '摘要。' }]),
    cancelDeferred: async () => {},
  } as unknown as PiModelRuntime['models'];
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  const { harness } = await AgentHarness.create({
    session, models, model, tools: [], activeToolNames: [], systemPrompt: 'sys',
    ...(compaction ? { compaction } : {}),
  }, BACKGROUND_CONTEXT);
  const compactions: string[] = [];
  harness.events.on('compaction_end', (event) => { compactions.push(event.status); });
  const lane = await harness.lane('main', BACKGROUND_CONTEXT);
  await lane.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: '旧答复' }], api: 'openai-completions',
    provider: 'llm', model: 'test-model', usage: usage(contextWindow), stopReason: 'stop', timestamp: 1,
  } as unknown as AgentMessage, BACKGROUND_CONTEXT);
  await lane.prompt('继续。', undefined, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  return compactions;
}

describe('反向绊线 B · 配置适配承重（关掉设置 → Pi 不压缩）', () => {
  it('compaction.enabled=false：即使上下文越阈，Pi 也不压缩（坏状态=缺失配置适配）', async () => {
    const compactions = await runBareHarness({ enabled: false, reserveTokens: 2_048, keepRecentTokens: 2_457 }, 8_192);
    expect(compactions, '禁用压缩时不得发生压缩——证明配置适配承重').toEqual([]);
  });

  it('piCompactionSettings(8192)：开启且缩放，Pi 越过阈值即压缩', async () => {
    const compactions = await runBareHarness(piCompactionSettings(8_192), 8_192);
    expect(compactions, '生产设置应让 Pi 压缩').toContain('completed');
  });
});

describe('反向绊线 C · A 口径 retry_scheduled=0（不因超窗重试）', () => {
  it.each([8_192, 40_000])('W=%i：必然超窗场景不得记录 pi_driver_retry_scheduled', async (contextWindow) => {
    const model = {
      id: 'test-model', name: 'test-model', api: 'openai-completions', provider: 'llm',
      baseUrl: 'http://127.0.0.1:9', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4_096,
    } as unknown as PiModelRuntime['model'];
    const models = {
      getModel: () => model,
      streamSimple: async () => streamOf(asst([], 'error', 'maximum context length exceeded')),
      completeSimple: async () => asst([{ type: 'text', text: '摘要。' }]),
      cancelDeferred: async () => {},
    } as unknown as PiModelRuntime['models'];
    const runtime = { model, models } as unknown as PiModelRuntime;

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnLines.push(String(args[0])); };
    try {
      await createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, runtime }).run({
        systemPrompt: '你是助手。',
        tools: [],
        messages: [user('x'.repeat(contextWindow * 4 + 4_000), 1)],
        onStep: () => {},
        exec: async () => undefined,
        deadline: Date.now() + 60_000,
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(
      warnLines.some((line) => line.includes('pi_driver_retry_scheduled')),
      'A 口径：超窗不得进入重试调度',
    ).toBe(false);
  });
});
