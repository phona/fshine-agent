/**
 * 唤醒入口（driver 侧）· 脚本化 ModelRuntime 直测（零真实请求）。
 *
 * 形状（owner 2026-11-19）：任务状态变化 → 用一条宿主**事实**唤醒会话里的模型，由它把话
 * 带给用户；宿主只投递它说的话。本文件钉驱动侧四件事：
 *   · 空闲会话：事实注入 → 触发回合 → 取回**本回合**模型正文（不取上一回合答复）；
 *   · **唤醒回合零工具**（2026-11-19 复核 F1）：唤醒请求不声明任何工具（Pi 原生
 *     `setActiveToolsByName` 按回合切换），收尾恢复——下一用户回合工具面照旧；
 *   · 会话忙：事实入队（Pi 原生 followUp），wake 返回 busy——由当前回合处理，宿主不得另行投递；
 *   · 失败：回合报错 / 空回复（含只调工具不产出正文）→ failed，不冒充正文；
 *   · 切点：事实之后只有 toolResult 或非 stop 的 assistant 时取不到（工具结果不是模型的话）。
 *
 * 反向绊线（把实现改坏必须变红，逐条实测见提交说明）：
 *   · 切点判据退回「整段转录最后一条 assistant」→ 空回复用例返回历史答复、变红；
 *   · 认 toolResult 当正文 → toolResult 用例变红；
 *   · 去掉 busy 分支 → busy 用例收到 failed（重复投递的根因）变红；
 *   · 去掉 runFailure 判据 → 模型报错用例变红；
 *   · 去掉唤醒回合的工具清空/恢复 → 零工具声明与恢复用例变红。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import type { TurnDriverInput } from './src/driver-contract';
import { createPiTurnDriver, wakeReplyText } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

const user = (text: string, ts = 1): AgentMessage => ({ role: 'user', content: text, timestamp: ts } as unknown as AgentMessage);

function assistant(content: unknown[], stopReason = 'stop', errorMessage?: string): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

const textAssistant = (text: string) => assistant([{ type: 'text', text }]);
const toolCallAssistant = (name: string, id = 'call-1') =>
  assistant([{ type: 'toolCall', id, name, arguments: {} }], 'toolUse');

const PROBE: DiscoveredTool = {
  name: 'probe',
  description: '（测试）阻塞探针',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const FACT = '[任务完成]「汇总那件事」已由执行端确认完成。结果正文（逐字）：共 7 条。请把这件事告诉用户。';

function turnInput(messages: AgentMessage[], overrides: Partial<TurnDriverInput> = {}): TurnDriverInput {
  return {
    systemPrompt: '你是业务助手。',
    tools: [PROBE],
    messages,
    onStep: () => {},
    exec: async () => ({ ok: true }),
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 请求 messages 的 user 文本（injections/custom 先投影、真实 prompt 最后）。 */
function userTextsOf(messages: readonly unknown[]): string[] {
  return messages
    .filter((message) => (message as { role?: string }).role === 'user')
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => String((part as { text?: unknown }).text ?? '')).join('');
      }
      return '';
    });
}

/**
 * 某次请求**有效**的工具声明（F1 断言用）：Pi 把工具集变化写成 system 消息上的
 * `toolsAdded`/`toolsRemoved` 增量（`getCurrentTools` 同规则）；折叠全部 system 增量
 * 得到「本次请求模型实际拿到的工具」。唤醒回合必须为 []。
 */
function declaredToolNames(messages: readonly unknown[]): string[] {
  const tools = new Set<string>();
  for (const message of messages) {
    const record = message as {
      role?: string;
      toolsAdded?: ReadonlyArray<{ name?: string }>;
      toolsRemoved?: ReadonlyArray<{ name?: string }>;
    };
    if (record.role !== 'system') continue;
    for (const tool of record.toolsRemoved ?? []) tools.delete(String(tool.name ?? ''));
    for (const tool of record.toolsAdded ?? []) tools.add(String(tool.name ?? ''));
  }
  return [...tools];
}

async function driverWith(responses: ReadonlyArray<AgentMessage | ((context: { messages: readonly unknown[] }) => AgentMessage)>) {
  const requests: Array<{ messages: readonly unknown[]; toolNames: string[] }> = [];
  let index = 0;
  const scripted = await createScriptedModelRuntime({
    contextWindow: 40_000,
    script: (_callIndex, context) => {
      requests.push({ messages: context.messages, toolNames: declaredToolNames(context.messages) });
      const slot = responses[index];
      index += 1;
      if (slot === undefined) return undefined;
      return typeof slot === 'function' ? slot(context) : slot;
    },
  });
  const driver = createPiTurnDriver({
    env: { LLM_MODEL: 'test-model' },
    modelRuntime: scripted.runtime,
    reuseConversation: true,
  });
  return { driver, requests, scripted };
}

describe('唤醒入口（driver 侧，脚本化模型）', () => {
  it('空闲会话：事实触发回合，取回本回合模型正文；转录里事实与正文都在', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { driver, requests } = await driverWith([
        textAssistant('先办的事：A 汇总完成。'),
        textAssistant('对了，你之前交办的那件事办完了：共 7 条。'),
      ]);
      const first = await driver.run(turnInput([user('先办一件小事。')]));
      expect(first.text).toBe('先办的事：A 汇总完成。');

      const woke = await driver.wake!(FACT);
      expect(woke.outcome).toBe('woken');
      expect(woke.text, '取回的是唤醒回合的正文，不是上一回合答复').toBe('对了，你之前交办的那件事办完了：共 7 条。');
      // 模型真的读到了事实（不是话术）：唤醒回合请求里 fact 是最后一条 user。
      const wakeRequest = requests.at(-1)!;
      expect(userTextsOf(wakeRequest.messages).at(-1)).toBe(FACT);
      // 唤醒回合对模型不声明任何工具（F1：清执行面不够，模型不能有工具可调）。
      expect(wakeRequest.toolNames, '唤醒回合请求零工具声明').toEqual([]);
      // 转录一致性：事实（custom → user 投影）与模型那句话都在会话转录里。
      const transcript = driver.transcript!();
      const texts = userTextsOf(transcript);
      expect(texts).toContain(FACT);
      expect(transcript.some((message) => {
        const content = (message as { content?: unknown }).content;
        return (message as { role?: string }).role === 'assistant'
          && Array.isArray(content)
          && content.some((block) => (block as { text?: unknown }).text === '对了，你之前交办的那件事办完了：共 7 条。');
      })).toBe(true);
      driver.close?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('切点守卫：事实之后只有 toolResult / 非 stop 的 assistant 时取不到；事实不在尾部取不到', () => {
    // 正向：事实之后是本回合 assistant（stop）→ 取它。
    expect(wakeReplyText([user('旧问题。', 1), textAssistant('旧答复。'), user(FACT, 2), textAssistant('新话。')], FACT))
      .toBe('新话。');
    // 事实不在转录里（无法归属本回合）→ 不取任何正文（旧实现会回扫到「旧答复。」）。
    expect(wakeReplyText([user('旧问题。', 1), textAssistant('旧答复。')], FACT)).toBe('');
    // 事实之后只有 toolResult（工具事实不是模型的话）→ 不认。
    expect(wakeReplyText([
      user('旧问题。', 1),
      textAssistant('旧答复。'),
      user(FACT, 2),
      { role: 'toolResult', content: [{ type: 'text', text: '请直接回答用户，不必调用工具。' }], timestamp: 3 } as unknown as AgentMessage,
    ], FACT)).toBe('');
    // 事实之后是 error/aborted 的 assistant → 不认（失败回合不得冒充答复）；
    // 供应商错误可能带半截正文，照样不是本回合可用的答复。
    expect(wakeReplyText([user(FACT, 2), assistant([], 'error', 'boom')], FACT)).toBe('');
    expect(wakeReplyText([user(FACT, 2), assistant([{ type: 'text', text: '半截话' }], 'error', 'boom')], FACT)).toBe('');
    expect(wakeReplyText([user(FACT, 2), assistant([], 'aborted')], FACT)).toBe('');
    expect(wakeReplyText([user(FACT, 2), assistant([{ type: 'text', text: '半截话' }], 'aborted')], FACT)).toBe('');
  });

  it('F1 边界：唤醒回合请求零工具声明，回合收尾恢复——下一用户回合工具面照旧', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { driver, requests } = await driverWith([
        textAssistant('第一回合答复。'),
        textAssistant('办好了：共 7 条。'),
        textAssistant('第二回合答复。'),
      ]);
      await driver.run(turnInput([user('第一问。')]));
      expect(requests.at(-1)!.toolNames).toEqual(['probe']);
      const woke = await driver.wake!(FACT);
      expect(woke.outcome).toBe('woken');
      expect(requests.at(-1)!.toolNames, '唤醒回合对模型不声明任何工具').toEqual([]);
      const second = await driver.run(turnInput([user('第二问。')]));
      expect(second.text).toBe('第二回合答复。');
      expect(requests.at(-1)!.toolNames, '唤醒回合后必须恢复工具面（否则用户回合没有工具）').toEqual(['probe']);
      driver.close?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('会话忙：wake 返回 busy（事实入队、当前回合处理），宿主不另行投递', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gate = deferred<void>();
      const started = deferred<void>();
      const requests: Array<readonly unknown[]> = [];
      const scripted = await createScriptedModelRuntime({
        contextWindow: 40_000,
        script: (index, context) => {
          requests.push(context.messages);
          if (index === 0) return toolCallAssistant('probe');
          return textAssistant('顺带说一句：你等的那件事办完了，结果是 7 条。');
        },
      });
      const driver = createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: scripted.runtime,
        reuseConversation: true,
      });
      const running = driver.run(turnInput([user('先办一件小事。')], {
        exec: async () => {
          started.resolve();
          await gate.promise;
          return { ok: true };
        },
      }));
      // 工具执行挂住 = 会话仍在流式中。
      await started.promise;
      const woke = await driver.wake!(FACT);
      expect(woke.outcome, '流式中的唤醒必须报 busy（事实入队），不能另起回合').toBe('busy');
      expect(woke.text).toBeUndefined();
      gate.resolve();
      const result = await running;
      // 当前回合把事实读进去了：它之后的正文就是模型对这件事的话（由前台路径投递）。
      expect(userTextsOf(requests.at(-1)!).at(-1)).toBe(FACT);
      expect(result.text, '当前回合的收尾正文 = 模型对事实的话（由当前回合负责）').toBe('顺带说一句：你等的那件事办完了，结果是 7 条。');
      driver.close?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('失败：唤醒回合模型报错 → failed（残缺正文不得冒充模型的话）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { driver } = await driverWith([
        textAssistant('上一回合答复。'),
        // 供应商错误形状：带了半截正文，但 stopReason=error —— 不是本回合的可用答复。
        assistant([{ type: 'text', text: '写到一半断了的内容' }], 'error', 'provider 529'),
      ]);
      await driver.run(turnInput([user('先问一句。')]));
      const woke = await driver.wake!(FACT);
      expect(woke).toEqual({ outcome: 'failed' });
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_wake_failed'))).toBe(true);
      driver.close?.();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('失败：唤醒回合空回复 → failed，不得返回上一回合答复', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { driver } = await driverWith([
        textAssistant('上一回合答复。'),
        assistant([]),
      ]);
      const first = await driver.run(turnInput([user('先问一句。')]));
      expect(first.text).toBe('上一回合答复。');
      const woke = await driver.wake!(FACT);
      expect(woke).toEqual({ outcome: 'failed' });
      expect(woke.text).toBeUndefined();
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_wake_empty_reply'))).toBe(true);
      driver.close?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('走岔路：脚本模型在唤醒回合硬发工具调用 → 零工具声明下匹配不到工具（不碰执行面），空正文 → failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let execCalls = 0;
      const toolNamesPerRequest: string[][] = [];
      let index = 0;
      const scripted = await createScriptedModelRuntime({
        contextWindow: 40_000,
        script: (_callIndex, context) => {
          toolNamesPerRequest.push(declaredToolNames(context.messages));
          index += 1;
          if (index === 1) return textAssistant('先问一句的答复。');
          // 唤醒回合：脚本模型无视「零工具声明」硬发 toolCall（真实模型没有可调的声明面，
          // 这是脚本夹具的极限情况）；Pi 记一条工具错误回执后以空 assistant 收尾（不产出正文）。
          if (index === 2) return toolCallAssistant('probe', 'call-wake');
          return assistant([]);
        },
      });
      const driver = createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: scripted.runtime,
        reuseConversation: true,
      });
      await driver.run(turnInput([user('先问一句。')], {
        exec: async () => {
          execCalls += 1;
          return { ok: true };
        },
      }));
      const woke = await driver.wake!(FACT, { deadline: Date.now() + 30_000 });
      expect(woke).toEqual({ outcome: 'failed' });
      // 唤醒回合请求零工具声明；硬发的调用匹配不到工具 → 到不了 exec（执行层零调用）。
      expect(toolNamesPerRequest[1], '唤醒回合请求零工具声明').toEqual([]);
      expect(execCalls, '唤醒回合的工具调用不得打到执行面').toBe(0);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes('pi_driver_wake_empty_reply'))).toBe(true);
      driver.close?.();
    } finally {
      warn.mockRestore();
    }
  });

  it('未实现的驱动（无实例级会话）：wake 不可用 → unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textAssistant('答复。') });
      // 一次性会话（reuseConversation 缺省）= 回合级会话，没有可唤醒对象。
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime });
      await driver.run(turnInput([user('问一句。')]));
      const woke = await driver.wake!(FACT);
      expect(woke).toEqual({ outcome: 'unavailable' });
    } finally {
      warn.mockRestore();
    }
  });
});
