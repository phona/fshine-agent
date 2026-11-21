/**
 * 模型用量落盘（阶段 2：装配注入前的 sink 本体 + 一次真实（假驱动）回合的端到端）。
 *
 * 判据（ask 原文）：
 *   · 一次真实（假驱动）回合后 usage.jsonl 恰一行、字段齐全、**不含消息正文/工具参数**；
 *   · 写失败只记结构化事件（model_usage_write_failed）、不影响回合、不抛；
 *   · 拿不到的身份字段（principalId/sessionId/ttftMs）省略，不许编。
 *
 * 「假驱动回合」= 真实 createPiTurnDriver（真实 Pi AgentSession 事件链）+ 脚本化模型运行时，
 * onModelUsage 接的是**生产 sink 本体**（不是测试桩）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from './src/pi-driver';
import { createModelUsageSink, usageFilePathOf, type ModelUsageLine } from './src/model-usage';
import type { TurnDriverInput } from './src/driver-contract';
import { SCRIPTED_MODEL_ID, createScriptedModelRuntime, type ScriptedStreamStep } from './testing/scripted-model-runtime';

const USAGE_A = { input: 120, output: 45, cacheRead: 30, cacheWrite: 10, reasoning: 5, totalTokens: 210 };

function assistant(text: string, stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: SCRIPTED_MODEL_ID,
    usage: { ...USAGE_A, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

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

function streamSteps(...deltas: readonly { delayMs: number; text: string }[]): readonly ScriptedStreamStep[] {
  let accumulated = '';
  const steps: ScriptedStreamStep[] = [{ event: { type: 'start', partial: partialOf('') as never } }];
  for (const delta of deltas) {
    accumulated += delta.text;
    steps.push({
      delayMs: delta.delayMs,
      event: { type: 'text_delta', contentIndex: 0, delta: delta.text, partial: partialOf(accumulated) as never },
    });
  }
  return steps;
}

function runInput(prompt: string): TurnDriverInput {
  return {
    systemPrompt: '你是助手。',
    tools: [],
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() } as unknown as AgentMessage],
    onStep: () => {},
    exec: async () => ({ ok: true }),
    deadline: Date.now() + 60_000,
  };
}

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fshine-usage-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('model-usage sink：usage.jsonl 落盘', () => {
  it('一次真实（假驱动）回合后 usage.jsonl 恰一行、字段齐全、不含正文', async () => {
    const dbPath = tempDbPath();
    const filePath = usageFilePathOf(dbPath);
    const scripted = await createScriptedModelRuntime({
      script: () => assistant('收到，已处理完毕。'),
      streamScript: () => streamSteps({ delayMs: 25, text: '收到，' }, { delayMs: 30, text: '已处理完毕。' }),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: SCRIPTED_MODEL_ID },
      modelRuntime: scripted.runtime,
      onModelUsage: createModelUsageSink({
        filePath,
        agent: 'main',
        principalId: 'wecom:t1',
        sessionId: 'sess_1',
      }),
    });

    await driver.run(runInput('你好，机密提示词'));
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines, '一次回合 = 恰一行').toHaveLength(1);

    const line = JSON.parse(lines[0]!) as ModelUsageLine;
    expect(line.at, 'at 是可解析的 ISO 时刻').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(line.at))).toBe(false);
    expect(line.agent).toBe('main');
    expect(line.principalId).toBe('wecom:t1');
    expect(line.sessionId).toBe('sess_1');
    expect(line.modelId).toBe(SCRIPTED_MODEL_ID);
    expect(line.stopReason).toBe('stop');
    expect(typeof line.durationMs).toBe('number');
    expect(line.durationMs).toBeGreaterThan(0);
    expect(line.ttftMs).toBeDefined();
    expect(line.usage).toEqual(USAGE_A);
    // 行里不许有消息正文 / prompt（连「不出现」的断言都直接对整行原文做）。
    expect(raw).not.toContain('已处理完毕');
    expect(raw).not.toContain('机密提示词');
    expect(raw).not.toContain('text_delta');
  });

  it('无 ttft 的 entry：行里省略 ttftMs 键（缺省不填）', () => {
    const filePath = path.join(tempDbPath(), 'usage.jsonl');
    const sink = createModelUsageSink({ filePath, agent: 'worker' });
    sink({
      modelId: SCRIPTED_MODEL_ID,
      stopReason: 'aborted',
      durationMs: 1234,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 6 },
    });
    const line = JSON.parse(readFileSync(filePath, 'utf8').trim()) as ModelUsageLine;
    expect(Object.hasOwn(line, 'ttftMs')).toBe(false);
    expect(line.agent).toBe('worker');
    expect(Object.hasOwn(line, 'principalId')).toBe(false);
    expect(Object.hasOwn(line, 'sessionId')).toBe(false);
  });

  it('写失败只记结构化事件、不抛（观测不得影响回合）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fshine-usage-'));
    dirs.push(dir);
    // filePath 指向一个已存在的目录 → appendFileSync 必失败（EISDIR）。
    const filePath = path.join(dir, 'usage.jsonl');
    mkdirSync(filePath, { recursive: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createModelUsageSink({ filePath, agent: 'main', principalId: 'wecom:t1' });

    expect(() => sink({
      modelId: SCRIPTED_MODEL_ID,
      stopReason: 'stop',
      durationMs: 10,
      ttftMs: 5,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3 },
    })).not.toThrow();

    const events = warnSpy.mock.calls.map((call) => {
      try { return JSON.parse(String(call[0])) as Record<string, unknown>; } catch { return undefined; }
    }).filter((event): event is Record<string, unknown> => event?.['event'] === 'model_usage_write_failed');
    expect(events).toHaveLength(1);
    expect(events[0]!['path']).toBe(filePath);
    expect(String(events[0]!['reason'])).not.toBe('');
  });

  it('usageFilePathOf：与 dbPath 同目录、标准文件名', () => {
    expect(usageFilePathOf('/x/y/state.db')).toBe(path.join('/x/y', 'usage.jsonl'));
    expect(usageFilePathOf('state.db')).toBe(path.join(path.dirname('state.db'), 'usage.jsonl'));
  });
});
