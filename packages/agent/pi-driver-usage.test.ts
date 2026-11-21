/**
 * 模型调用用量与延迟观测（阶段 1：驱动采集；owner 2026-11-21 批准的最小方案）。
 *
 * 判据（ask 原文）：
 *   · 每一条 assistant 的 `message_end`（正常结束与 error/aborted 都算）采集一条用量记录，
 *     经新增可选回调 `onModelUsage` 传出；缺省不传 = 零行为变化；
 *   · durationMs = assistant message_start → message_end（无 message_start 用本回合发起时刻兜底）；
 *   · ttftMs = 首个流式文本 delta 到达时刻 − message_start（无 delta/非流式 = 缺省不填）；
 *   · usage 六字段如实来自消息；**不含消息正文、工具参数、prompt**。
 *
 * 事件序列经真实 Pi AgentSession 产生：脚本化 ModelRuntime（testing/scripted-model-runtime）
 * 用 streamScript 推 start → text_delta ×N → done，agent loop 转成
 * message_start / message_update / message_end——不是自建假事件。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import { createPiTurnDriver, type PiModelUsageEntry } from './src/pi-driver';
import type { TurnDriverInput } from './src/driver-contract';
import {
  SCRIPTED_MODEL_ID,
  createScriptedModelRuntime,
  type ScriptedStreamStep,
} from './testing/scripted-model-runtime';

/** 断言用的一组真实形状 usage（六字段齐全）。 */
const USAGE_A = { input: 120, output: 45, cacheRead: 30, cacheWrite: 10, reasoning: 5, totalTokens: 210 };
const USAGE_B = { input: 80, output: 12, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 92 };

function assistant(text: string, usage: typeof USAGE_A, stopReason = 'stop', errorMessage?: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: SCRIPTED_MODEL_ID,
    usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string, usage: typeof USAGE_A): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: SCRIPTED_MODEL_ID,
    usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 流式 partial（agent loop 用它发 message_start / message_update；done 时被最终消息替换）。 */
function partialOf(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: SCRIPTED_MODEL_ID,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 「start → text_delta ×N」的流式脚本；done/error 收尾由夹具按最终 message 追加。 */
function streamSteps(...deltas: readonly { delayMs: number; text: string }[]): readonly ScriptedStreamStep[] {
  let accumulated = '';
  const steps: ScriptedStreamStep[] = [{ event: { type: 'start', partial: partialOf('') as never } }];
  for (const delta of deltas) {
    accumulated += delta.text;
    steps.push({
      delayMs: delta.delayMs,
      event: {
        type: 'text_delta',
        contentIndex: 0,
        delta: delta.text,
        partial: partialOf(accumulated) as never,
      },
    });
  }
  return steps;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function runInput(prompt: string, tools: readonly DiscoveredTool[] = []): TurnDriverInput {
  return {
    systemPrompt: '你是助手。',
    tools,
    messages: [userMessage(prompt)],
    onStep: () => {},
    exec: async () => ({ ok: true }),
    deadline: Date.now() + 60_000,
  };
}

const QUERY_TOOL: DiscoveredTool = {
  name: 'dummy.query',
  description: '查询',
  inputSchema: { type: 'object', properties: {} },
};

describe('pi-driver onModelUsage：每条 assistant message_end 一条用量记录', () => {
  it('流式回合：message_start → text delta ×N → message_end → 一条记录，duration/ttft/usage 如实、不含正文', async () => {
    const entries: PiModelUsageEntry[] = [];
    const scripted = await createScriptedModelRuntime({
      script: () => assistant('收到，已处理完毕。', USAGE_A),
      streamScript: () => streamSteps(
        { delayMs: 30, text: '收到，' },
        { delayMs: 40, text: '已处理完毕。' },
      ),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: (entry) => entries.push(entry),
    });

    const result = await driver.run(runInput('你好'));
    expect(result.text).toContain('已处理完毕');

    expect(entries, '一条 assistant 消息 = 一条用量记录').toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.modelId).toBe(SCRIPTED_MODEL_ID);
    expect(entry.stopReason).toBe('stop');
    expect(entry.usage).toEqual(USAGE_A);
    // durationMs = message_start → message_end：覆盖两个 delta 的真实等待（30+40=70ms，留调度余量）。
    expect(entry.durationMs).toBeGreaterThanOrEqual(55);
    expect(entry.durationMs).toBeLessThan(5000);
    // ttftMs = 首个 text_delta − message_start：首个 delta 前有 30ms 真实等待。
    expect(entry.ttftMs).toBeDefined();
    expect(entry.ttftMs!).toBeGreaterThanOrEqual(20);
    expect(entry.ttftMs!).toBeLessThanOrEqual(entry.durationMs);
    // 不许携带正文/工具参数/prompt。
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('收到');
    expect(serialized).not.toContain('你好');
  });

  it('无 delta（非流式收尾）：ttft 缺省不填，duration/usage 照常', async () => {
    const entries: PiModelUsageEntry[] = [];
    const scripted = await createScriptedModelRuntime({
      script: () => assistant('直接答复。', USAGE_B),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: (entry) => entries.push(entry),
    });

    await driver.run(runInput('在吗'));
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.stopReason).toBe('stop');
    expect(entry.usage).toEqual(USAGE_B);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.hasOwn(entry, 'ttftMs'), '无 delta → 不填 ttftMs（键都不出现）').toBe(false);
    expect(JSON.stringify(entry)).not.toContain('直接答复');
  });

  it('error/aborted 的 message_end 也各发一条（stopReason 如实；error 后 Pi 原生重试成功 = 第二条 stop）', async () => {
    const entries: PiModelUsageEntry[] = [];
    const scripted = await createScriptedModelRuntime({
      script: (index) => index === 0
        ? assistant('', USAGE_B, 'error', '503 service unavailable: overloaded')
        : assistant('重试后答复。', USAGE_A),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: (entry) => entries.push(entry),
    });

    await driver.run(runInput('再试一次'));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]!.stopReason).toBe('error');
    expect(entries[0]!.usage).toEqual(USAGE_B);
    expect(entries[entries.length - 1]!.stopReason).toBe('stop');
    expect(entries[entries.length - 1]!.usage).toEqual(USAGE_A);
  });

  it('aborted 收尾也发一条（stopReason=aborted，不重试 = 恰一条）', async () => {
    const entries: PiModelUsageEntry[] = [];
    const scripted = await createScriptedModelRuntime({
      script: () => assistant('', USAGE_B, 'aborted'),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: (entry) => entries.push(entry),
    });

    await driver.run(runInput('打断'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.stopReason).toBe('aborted');
    expect(entries[0]!.usage).toEqual(USAGE_B);
  });

  it('工具轮次：一个回合两条 assistant 消息 = 两条记录（按消息各自计时，不跨消息累计）', async () => {
    const entries: PiModelUsageEntry[] = [];
    const scripted = await createScriptedModelRuntime({
      script: (index) => index === 0
        ? toolCallAssistant('dummy.query', { collection: 'documents' }, 'call_1', USAGE_B)
        : assistant('查询完成，共 3 条。', USAGE_A),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: (entry) => entries.push(entry),
    });

    const result = await driver.run(runInput('查一下', [QUERY_TOOL]));
    expect(result.text).toContain('查询完成');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.stopReason).toBe('toolUse');
    expect(entries[0]!.usage).toEqual(USAGE_B);
    expect(entries[1]!.stopReason).toBe('stop');
    expect(entries[1]!.usage).toEqual(USAGE_A);
    // 工具参数不许进记录。
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('documents');
    expect(serialized).not.toContain('dummy.query');
  });

  it('缺省不传 onModelUsage：零行为变化（回合照常完成）', async () => {
    const scripted = await createScriptedModelRuntime({
      script: () => assistant('正常答复。', USAGE_A),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
    });
    const result = await driver.run(runInput('嗨'));
    expect(result.text).toContain('正常答复');
  });
});
