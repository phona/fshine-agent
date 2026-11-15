/**
 * 长生命周期 Pi 会话 · 回归（零真实模型、确定性夹具）。
 *
 * 缺陷（阶段四真实证据）：产品装配链 `assembleSessionCore` + `createPiTurnDriver` 的
 * `run()` 每回合新建并关闭会话，再靠宿主重灌投影转录续上下文；降窗压缩后下一回合请求超窗
 * → `pi_driver_empty_reply`（`Assistant request exceeded the context window`），同窗口裸单会话 0 空。
 *
 * 判据（任务书 §4.1）：同一业务会话跨回合复用同一个 Pi Session；压缩后的 Pi
 * 原生状态持久用于后续回合。本文件三条确定性绊线：
 *   ① 机制：reuseConversation 下 N 回合只创建 **1** 个 Session；每回合一次性（缺省）
 *      创建 N 个——若实现回退成「每回合重建」，①必红；
 *   ② 行为：小窗、多次压缩后继续多轮，每回合都有非空回复且 provider 侧请求不超窗；
 *   ③ 工具闭包：复用会话时每回合的 exec/onStep 必须换成本回合的（不钉死首回合）。
 *
 * 迁移（1.5.2）：会话创建从 `MemorySessionRepo.create` 换成公开 `SessionManager.create` /
 * `SessionManager.inMemory`（同一「会话数」事实）；断言等价，不是放宽。
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import { createPiTurnDriver, piCompactionSettings } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';
import type { TurnDriverInput } from './src/driver-contract';

const WINDOW = 8_192;
const SUMMARY_MARKER = '【此前会话摘要】';

function usage(input: number, output: number) {
  return {
    input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function asst(content: unknown[], stopReason = 'stop', input = 10, output = 10, errorMessage?: string): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(input, output), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  } as unknown as AgentMessage;
}
function textReply(text: string, input = 10): AgentMessage {
  return asst([{ type: 'text', text }], 'stop', input, 20);
}
function replyOverThreshold(text: string, contextWindow: number): AgentMessage {
  const reserve = piCompactionSettings(contextWindow).reserveTokens;
  return textReply(text, contextWindow - reserve + 1_000);
}
function toolCallReply(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return asst([{ type: 'toolCall', id, name, arguments: args }], 'stop');
}
const estTokens = (messages: readonly unknown[]): number => Math.ceil(JSON.stringify(messages).length / 4);

function isSummaryRequest(messages: readonly unknown[]): boolean {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
}

interface Observed { sends: number; over: number; maxTokens: number; summaries: number; seen: number[]; }

function makeScripted(options: {
  contextWindow?: number;
  /** 依序返回主请求响应；用尽后回落 `fallback`（缺省「好的。」）。 */
  queue?: AgentMessage[];
  fallback?: (index: number) => AgentMessage;
  summary?: AgentMessage;
} = {}): Promise<{ driver: ReturnType<typeof createPiTurnDriver>; observed: () => Observed; runtime: Awaited<ReturnType<typeof createScriptedModelRuntime>> }> {
  const contextWindow = options.contextWindow ?? WINDOW;
  const queue = [...(options.queue ?? [])];
  const state: Observed = { sends: 0, over: 0, maxTokens: 0, summaries: 0, seen: [] };
  return createScriptedModelRuntime({
    contextWindow,
    maxTokens: 1_024,
    script: (index, context) => {
      const tokens = estTokens(context.messages);
      if (isSummaryRequest(context.messages)) {
        state.summaries += 1;
        return options.summary ?? asst([{ type: 'text', text: '摘要：用户连续投喂背景块，仍在查询 W1。' }]);
      }
      state.sends += 1;
      state.seen.push(tokens);
      state.maxTokens = Math.max(state.maxTokens, tokens);
      if (tokens > contextWindow) state.over += 1;
      const next = queue.shift();
      if (next !== undefined) return next;
      return options.fallback?.(index) ?? textReply('好的。');
    },
  }).then((scripted) => ({
    driver: createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime, reuseConversation: true }),
    observed: () => ({ ...state, seen: [...state.seen] }),
    runtime: scripted,
  }));
}

function makeInput(messages: AgentMessage[], opts: Partial<TurnDriverInput> & { tools?: DiscoveredTool[] } = {}): TurnDriverInput {
  const { tools, ...rest } = opts;
  return {
    systemPrompt: '你是助手。',
    tools: tools ?? [],
    messages,
    onStep: () => {},
    exec: async () => undefined,
    deadline: Date.now() + 60_000,
    ...rest,
  };
}

const user = (text: string, ts = 1): AgentMessage => ({ role: 'user', content: text, timestamp: ts } as unknown as AgentMessage);

/** 足够长、可被 Pi 切出尾段的历史。 */
function seedHistory(contextWindow: number): AgentMessage[] {
  const keepRecent = piCompactionSettings(contextWindow).keepRecentTokens;
  const targetChars = Math.ceil(keepRecent * 4 * 2.5);
  const pairs = 8;
  const per = Math.ceil(targetChars / (pairs * 2));
  const filler = '背景'.repeat(Math.ceil(per / 2));
  const out: AgentMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push(user(`历史 ${i}：${filler}`, i * 2 + 1));
    out.push(textReply('此前答复', 100));
  }
  return out;
}

// ─────────────────────────────── ① 机制：同一会话跨回合只创建一次
describe('① 同一业务会话跨回合复用同一个 Pi Session', () => {
  it('reuseConversation 下 5 回合只创建 1 个 Session；每回合一次性（缺省）创建 5 个', async () => {
    const inMemorySpy = vi.spyOn(SessionManager, 'inMemory');
    const createSpy = vi.spyOn(SessionManager, 'create');
    const creations = () => inMemorySpy.mock.calls.length + createSpy.mock.calls.length;
    try {
      inMemorySpy.mockClear();
      createSpy.mockClear();
      const reused = await makeScripted({ contextWindow: 40_000 });
      let messages: AgentMessage[] = [];
      for (let turn = 0; turn < 5; turn += 1) {
        const result = await reused.driver.run(makeInput([...messages, user(`第 ${turn} 轮问题。`, turn + 1)]));
        messages = result.messages;
      }
      expect(creations(), '同一业务会话跨 5 回合必须只创建一个 Pi Session（不每回合重建）').toBe(1);

      inMemorySpy.mockClear();
      createSpy.mockClear();
      const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textReply('好的。') });
      const perTurn = createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime });
      let perTurnMessages: AgentMessage[] = [];
      for (let turn = 0; turn < 5; turn += 1) {
        const result = await perTurn.run(makeInput([...perTurnMessages, user(`第 ${turn} 轮问题。`, turn + 1)]));
        perTurnMessages = result.messages;
      }
      // 反向绊线基线：每回合一次性语义（Worker/直测缺省）仍是 5 个会话——实现若回退成
      // 「产品装配也每回合重建」，上面的 reuse 断言会先红。
      expect(creations(), '每回合一次性模式应创建 5 个会话（基线）').toBe(5);
    } finally {
      inMemorySpy.mockRestore();
      createSpy.mockRestore();
    }
  });
});

// ─────────────────────────────── ② 行为：小窗多次压缩后继续多轮
describe('② 小窗多次压缩后继续多轮：每回合非空回复且请求不超窗', () => {
  it('W=8192：12 回合（经历多次压缩）每回合有正文、provider 请求不超窗', async () => {
    const { driver, observed } = await makeScripted({
      contextWindow: WINDOW,
      fallback: () => replyOverThreshold('好的。', WINDOW),
    });
    const filler = 'background context block for planning and traceability. '.repeat(100); // ~5.8k chars
    let messages: AgentMessage[] = seedHistory(WINDOW);
    const empties: number[] = [];
    let summarySeen = false;

    for (let turn = 0; turn < 12; turn += 1) {
      const result = await driver.run(makeInput([...messages, user(`背景补充（第 ${turn} 轮）：${filler}`, turn + 1)]));
      if (result.text.trim() === '') empties.push(turn);
      messages = result.messages;
      if (JSON.stringify(messages).includes(SUMMARY_MARKER)) summarySeen = true;
    }

    const obs = observed();
    expect(empties, '每回合都必须有非空回复（压缩后不得退回空回复）').toEqual([]);
    expect(obs.over, '任何一次 provider 请求都不得超窗').toBe(0);
    expect(obs.maxTokens, '请求峰值必须在窗口内').toBeLessThanOrEqual(WINDOW);
    expect(obs.summaries, '12 回合长会话必须经历多次 Pi 原生压缩').toBeGreaterThanOrEqual(2);
    expect(summarySeen, '压缩后宿主投影仍应看到 Pi 原生摘要').toBe(true);
  });
});

// ─────────────────────────────── ③ 工具闭包不钉死首回合
describe('③ 复用会话时工具闭包按回合更新', () => {
  it('两回合各触发一次工具调用：exec/onStep 分别为本回合闭包', async () => {
    const tool: DiscoveredTool = { name: 'lookup', description: '查询', inputSchema: { type: 'object', properties: {} } };
    const { driver } = await makeScripted({
      contextWindow: 40_000,
      queue: [
        toolCallReply('call_1', 'lookup', { q: 'W1' }),
        textReply('第一回合完成。'),
        toolCallReply('call_2', 'lookup', { q: 'W2' }),
        textReply('第二回合完成。'),
      ],
    });

    const calls: string[] = [];
    const steps: string[] = [];
    let messages: AgentMessage[] = [];
    for (let turn = 0; turn < 2; turn += 1) {
      const execMarker = `exec-turn-${turn}`;
      const stepMarker = `step-turn-${turn}`;
      const result = await driver.run(makeInput([...messages, user(`第 ${turn} 轮：查 W1。`, turn + 1)], {
        tools: [tool],
        exec: async (name) => { calls.push(`${name}:${execMarker}`); return { rows: 1 }; },
        onStep: (text) => { steps.push(`${stepMarker}:${text}`); },
      }));
      messages = result.messages;
    }

    expect(calls, '每回合的工具执行必须走本回合 exec 闭包（不得钉死首回合）').toEqual(['lookup:exec-turn-0', 'lookup:exec-turn-1']);
    expect(steps.some((s) => s.startsWith('step-turn-0:')), '首回合 onStep 生效').toBe(true);
    expect(steps.some((s) => s.startsWith('step-turn-1:')), '次回合 onStep 生效（每回合换闭包）').toBe(true);
  });
});
