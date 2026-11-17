/**
 * Pi 原生 Session/压缩替换 · 反向绊线（故意破坏禁止行为必须红）。
 *
 * 三条：
 *   A. 静态「禁止回潮」：生产驱动源码不得再出现任何自研压缩符号/事件——一旦有人把
 *      host 摘要/裁剪/阈值/降级/溢出恢复或 D1 臂加回来，本守卫即红。
 *   B. 配置适配承重：把 Pi 压缩配置关掉（模拟缺失配置适配）→ Pi 不再压缩（坏状态）；
 *      用生产 `piCompactionSettings` 则正常压缩。若适配被删成 `enabled:false`，B 即红。
 *   C. A 口径 `retry_scheduled=0`：必然超窗场景下驱动不得记录任何重试调度（不因超窗重试）。
 *
 * 迁移（1.5.2）：B 的裸夹具从已删除的 `AgentHarness` 换成公开 `createAgentSession`
 * （同一个 Pi 压缩实现，经 `SettingsManager.inMemory({compaction})` 传入配置）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAgentSession,
  createExtensionRuntime,
  SettingsManager,
  SessionManager,
  type AgentSessionEvent,
  type CompactionSettings,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver, piCompactionSettings } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

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

// ─────────────────────────────────────────────────────────── 夹具（零网络）
function usage(totalTokens: number) {
  return {
    input: totalTokens, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: totalTokens + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function asst(content: unknown[], totalTokens: number, stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(totalTokens), stopReason, timestamp: Date.now() + Math.random(),
  } as unknown as AgentMessage;
}
function user(text: string, ts = 1): AgentMessage {
  return { role: 'user', content: text, timestamp: ts } as unknown as AgentMessage;
}
function isSummaryRequest(messages: readonly unknown[]): boolean {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
}

/** 足够长、可被 Pi 切出尾段的历史（字符量 ≈ 2.5× keepRecentTokens×4）。 */
function seedHistory(contextWindow: number, compaction: CompactionSettings): AgentMessage[] {
  const keepRecent = compaction.keepRecentTokens ?? 20_000;
  const targetChars = Math.ceil(keepRecent * 4 * 2.5);
  const pairs = 8;
  const per = Math.ceil(targetChars / (pairs * 2));
  const filler = '背景'.repeat(Math.ceil(per / 2));
  const out: AgentMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push(user(`历史 ${i}：${filler}`, i * 2 + 1));
    out.push(asst([{ type: 'text', text: '此前答复' }], 100));
  }
  out.push(user('继续。', 100));
  return out;
}

function loader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'sys',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** 裸 AgentSession：种子历史 + 一次越阈响应；返回压缩事件序列。 */
async function runBareSession(compaction: CompactionSettings, contextWindow: number): Promise<string[]> {
  const threshold = contextWindow - (compaction.reserveTokens ?? 0);
  const scripted = await createScriptedModelRuntime({
    contextWindow,
    maxTokens: 4_096,
    script: (_index, context) => {
      if (isSummaryRequest(context.messages)) return asst([{ type: 'text', text: '摘要。' }], 10);
      return asst([{ type: 'text', text: '好的。' }], threshold + 1_000);
    },
  });
  const sessionManager = SessionManager.inMemory(process.cwd());
  for (const message of seedHistory(contextWindow, compaction)) {
    sessionManager.appendMessage(message as never);
  }
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model: scripted.runtime.getModel('llm', scripted.modelId)!,
    modelRuntime: scripted.runtime,
    thinkingLevel: 'off',
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction }),
    resourceLoader: loader(),
    customTools: [],
    tools: [],
  });
  const compactions: string[] = [];
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'compaction_end') compactions.push(event.result === undefined ? 'failed' : 'completed');
  });
  await session.prompt('继续。', { expandPromptTemplates: false });
  session.dispose();
  return compactions;
}

describe('反向绊线 B · 配置适配承重（关掉设置 → Pi 不压缩）', () => {
  it('compaction.enabled=false：即使上下文越阈，Pi 也不压缩（坏状态=缺失配置适配）', async () => {
    const compactions = await runBareSession({ enabled: false, reserveTokens: 2_048, keepRecentTokens: 2_457 }, 8_192);
    expect(compactions, '禁用压缩时不得发生压缩——证明配置适配承重').toEqual([]);
  });

  it('piCompactionSettings(8192)：开启且缩放，Pi 越过阈值即压缩', async () => {
    const compactions = await runBareSession(piCompactionSettings(8_192), 8_192);
    expect(compactions, '生产设置应让 Pi 压缩').toContain('completed');
  });
});

describe('反向绊线 C · A 口径 retry_scheduled=0（不因超窗重试）', () => {
  it.each([8_192, 40_000])('W=%i：必然超窗场景不得记录 pi_driver_retry_scheduled', async (contextWindow) => {
    const scripted = await createScriptedModelRuntime({
      contextWindow,
      maxTokens: 4_096,
      script: () => asst([], 0, 'error'),
    });
    // 必然超窗：错误携带 provider 超窗话术（Pi 判据识别为 context overflow）。
    const runtime = scripted.runtime;
    const driver = createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: runtime });

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnLines.push(String(args[0])); };
    try {
      await driver.run({
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
