/**
 * PiTurnDriver：基于 pi.dev 生态（@earendil-works/pi-agent-core + pi-ai）的回合驱动。
 *
 * Pi 原生 Session/Harness 是**会话转录与压缩生命周期的唯一所有者**：
 *   · 转录由 `AgentHarness` + `SessionRepo` 持有（业务层只读投影，见 projectTranscript）；
 *   · 压缩的触发 / 执行（摘要）/ 尾段保留 / 溢出恢复全部由 Pi 决定与执行；
 *   · fshine 不再实现任何第二套摘要 / 裁剪 / 阈值判定 / 降级 / 重试 / 溢出恢复。
 *
 * fshine 只保留两件不可转交的事：
 *   ① 把宿主转录喂给 Pi 并把 Pi 的转录读回（业务层投影）；
 *   ② 依 Pi 契约传入 `CompactionSettings`（见 piCompactionSettings —— **Pi 配置适配，非压缩机制**）。
 *
 * 模型走原生 function calling（无自定义 JSON 协议）；流式响应；空闲超时。
 */
import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentMessage,
  type AgentToolResult,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core';
import { MemorySessionRepo, type Entry } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core/harness/context';
import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  envApiKeyAuth,
  type Api,
  type AuthContext,
  type Message,
  type Model,
  type MutableModels,
  type RetryPolicy,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { Type } from 'typebox';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver-contract';
import { renderToolStepText } from './step-text';

/** 主模型瞬时失败的有界重试策略（交给 Pi 原生 RetryPolicy 执行；同旧 [1000,2000] 两次延迟）。 */
const MAIN_MODEL_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1_000 };

/**
 * 空回复的第二种形状：模型以 `stopReason=stop` 收尾，但 content 只有 thinking 块、
 * 没有 text。这不是供应商错误也不是窗口爆了，催一次「给出最终文本」通常就能收尾；
 * 有正文/toolResult 终结/error/aborted 都不催。
 */
export function shouldNudgeFinalReply(messages: readonly AgentMessage[], text: string): boolean {
  if (text.trim()) return false;
  const last = messages[messages.length - 1] as { role?: string; stopReason?: string } | undefined;
  return last?.role === 'assistant' && last.stopReason === 'stop';
}

/** 只输出思考没正文时的收尾催问（一轮一次；不影响正常回复）。 */
const FINAL_REPLY_NUDGE = '请直接给出面向用户的最终回复文本，不要只输出思考过程。';
const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 模型的上下文窗口缺省值（token）。**这是缺省，不是能力声明本身**：真实部署的窗口由
 * 模型能力提供（createPiModelRuntime 的 capabilities / PiTurnDriverOptions.contextWindow，
 * 装配层持有配置、驱动只收参数）。未提供能力时沿用本缺省值。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 单次输出上限的缺省值（token）：同 DEFAULT_CONTEXT_WINDOW，属能力声明的一部分。 */
export const DEFAULT_MAX_TOKENS = 32_000;

/** 模型能力声明（部署层提供；驱动只收参数，不猜、不按名字查表）。 */
export interface PiModelCapabilities {
  /** 上下文窗口（token）。 */
  contextWindow?: number;
  /** 单次输出上限（token）。 */
  maxTokens?: number;
}

/**
 * **Pi 配置适配（Integration），非压缩机制。**
 *
 * Pi 的 `shouldCompact(tokens, W, settings)` 要求调用方提供**绝对** `CompactionSettings`
 * （`@earendil-works/pi-agent-core` 的 `CompactionSettings` 只有
 * `enabled/reserveTokens/keepRecentTokens` 三个绝对字段，无窗口相对字段、无缩放助手）。
 * Pi 缺省值按 128k 窗口设计（reserve=16384、keepRecent=20000）：小窗口下 reserve 会
 * 超过窗口本身，不缩放则 Pi 自身行为已失效（短回合被压、零收益循环）。
 *
 * 因此本函数只做一件纯配置的事：**窗口装得下 Pi 缺省就沿用缺省，否则按比例缩放**——
 * 这是履行 Pi 契约的入参，**不含任何 fshine 的压缩决策/安全闸 math**（无 INV 下界、
 * 无 Δ、无 emergency 线、无 shouldCompact 复刻）。触发/执行/摘要/尾段/溢出恢复全归 Pi。
 *
 * 纯函数、无副作用、无外部依赖。
 */
export function piCompactionSettings(contextWindow: number): CompactionSettings {
  const defaults = DEFAULT_COMPACTION_SETTINGS;
  if (!Number.isFinite(contextWindow)
    || contextWindow >= defaults.reserveTokens + defaults.keepRecentTokens) {
    return { ...defaults };
  }
  return {
    enabled: true,
    reserveTokens: Math.max(1, Math.min(defaults.reserveTokens, Math.floor(contextWindow * 0.25))),
    keepRecentTokens: Math.max(1, Math.min(defaults.keepRecentTokens, Math.floor(contextWindow * 0.3))),
  };
}

/** Core Agent drops custom messages by default; explicitly project only our host task context. */
export function plannerMessagesToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') return [message];
    const custom = message as unknown as { role?: string; customType?: string; content?: unknown; summary?: unknown; timestamp?: number };
    // Pi 原生压缩摘要（role=compactionSummary）必须进 provider 请求：否则复用同一会话时
    // 压缩后的摘要对模型不可见（转录仍在 session 里，但请求里被本投影器丢弃）。
    if (custom.role === 'compactionSummary' && typeof custom.summary === 'string') {
      return [{
        role: 'user',
        content: [{ type: 'text', text: `【此前会话摘要】\n${custom.summary}` }],
        timestamp: custom.timestamp ?? 0,
      }];
    }
    if (custom.role !== 'custom' || !['background_task_event', 'background_task_roster'].includes(custom.customType ?? '')
      || typeof custom.content !== 'string' || !custom.content.trim()) return [];
    return [{ role: 'user', content: [{ type: 'text', text: custom.content }], timestamp: custom.timestamp ?? 0 }];
  });
}

/** Kimi coding/OpenAI-compatible endpoint's supported reasoning controls. */
export const KIMI_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: null,
  max: null,
} as const;

/** pi 统一思考深度词表:off/minimal/low/medium/high/xhigh/max(是否生效取决于模型/端点支持)。 */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * 校验思考深度原始值:合法原样返回,空串归一为 undefined(= 不带思考参数),非法抛中文错误。
 */
export function parsePiThinkingLevel(rawValue: string | undefined, envVarName: string): PiThinkingLevel | undefined {
  const value = rawValue ?? '';
  if (value === '') return undefined;
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`环境变量 ${envVarName} 无效:${value}(可选 ${PI_THINKING_LEVELS.join('/')})`);
  }
  return value as PiThinkingLevel;
}

/**
 * 校验上下文窗口的原始声明（token）：空串/未设置归一为 undefined（回落 128k 缺省），
 * 非法值抛中文错误。
 */
export function parseContextWindow(rawValue: string | number | undefined, envVarName: string): number | undefined {
  if (rawValue === undefined) return undefined;
  const text = String(rawValue).trim();
  if (text === '') return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${envVarName} 必须是正整数（当前: ${text}）`);
  }
  return value;
}

export interface PiTurnDriverOptions {
  env: Record<string, string | undefined>;
  /** 显式模型 id(分层模型接缝)。缺省(不传)回落 env.LLM_MODEL。 */
  modelId?: string;
  /** 显式思考深度。缺省(不传)回落 env.LLM_THINKING_LEVEL。 */
  thinkingLevel?: PiThinkingLevel;
  /** 显式模型能力(上下文窗口，token)。缺省 = DEFAULT_CONTEXT_WINDOW。 */
  contextWindow?: number;
  /** 注入的模型运行时（测试/嵌入用）。 */
  runtime?: PiModelRuntime;
  /**
   * 会话生命周期归属（任务书 §4.1）：true = 本驱动实例**首次 run 创建一次** Pi
   * Session/Harness，后续 run 复用它（跨回合保留 Pi 原生转录与压缩状态）；
   * false/缺省 = 每回合一次性会话（Worker/直测沿用，行为逐字节不变）。
   * 生产装配只在**业务会话级**驱动（Main）上传 true：驱动实例随业务会话创建，
   * 因此会话生命周期随业务会话、不随回合。
   */
  reuseConversation?: boolean;
}

export interface PiModelRuntime {
  models: MutableModels;
  model: Model<Api>;
}

type ConversationHarness = Awaited<ReturnType<typeof AgentHarness.create>>['harness'];
type ConversationLane = Awaited<ReturnType<ConversationHarness['lane']>>;

/**
 * 本驱动实例持有的 Pi 会话（仅 reuseConversation）。
 * slot.current 是回合归因槽：事件 listener 只随会话注册一次，每回合指向本回合的计数/失败。
 */
interface Conversation {
  harness: ConversationHarness;
  lane: ConversationLane;
  slot: { current: { retryScheduled: number; runFailure?: { code: string; message: string } } | undefined };
}

/**
 * 宿主转录是否仍是上一回合投影的前缀扩展（reuseConversation 的增量追加判据）。
 * 正常路径下宿主原样保留交回的投影数组元素引用；引用不同再按 JSON 等价兜底，
 * 仍不等价则视为分叉（异常路径，调用方重建会话）。
 */
function isPrefixExtension(prefix: readonly AgentMessage[], messages: readonly AgentMessage[]): boolean {
  if (messages.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] === messages[index]) continue;
    try {
      if (JSON.stringify(prefix[index]) === JSON.stringify(messages[index])) continue;
    } catch {
      return false;
    }
    return false;
  }
  return true;
}

/**
 * 环境范围认证上下文：先查驱动收到的 env，缺失才回落库默认上下文。
 */
function envScopedAuthContext(
  env: Record<string, string | undefined>,
  fallback: AuthContext,
): AuthContext {
  return {
    async env(name: string): Promise<string | undefined> {
      const value = env[name];
      if (typeof value === 'string' && value.trim() !== '') return value;
      return fallback.env(name);
    },
    fileExists: (path: string) => fallback.fileExists(path),
  };
}

/**
 * 从 env 构建 kimi 兼容的 pi 模型集合与认证上下文;env 缺失在创建时即抛中文错误。
 */
export function createPiModelRuntime(
  env: Record<string, string | undefined>,
  modelId: string,
  capabilities: PiModelCapabilities = {},
): PiModelRuntime {
  const baseUrl = (env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY;
  if (!baseUrl || !apiKey || !modelId) {
    const missing = [
      ['LLM_API_BASE_URL', baseUrl],
      ['LLM_API_KEY', apiKey],
      ['LLM_MODEL', modelId],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(`缺少环境变量 ${missing.join('、')},无法初始化 LLM 客户端`);
  }

  const kimiModel: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'llm',
    baseUrl,
    reasoning: true,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    thinkingLevelMap: KIMI_THINKING_LEVEL_MAP,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: parseContextWindow(capabilities.contextWindow, 'contextWindow') ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: capabilities.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  const provider = createProvider({
    id: 'llm',
    name: 'LLM',
    baseUrl,
    auth: { apiKey: envApiKeyAuth('LLM API key', ['LLM_API_KEY']) },
    models: [kimiModel],
    api: openAICompletionsApi(),
  });
  const models = createModels({
    authContext: envScopedAuthContext(env, defaultProviderAuthContext()),
  });
  models.setProvider(provider);
  const model = models.getModel('llm', modelId);
  if (!model) throw new Error(`LLM 模型 ${modelId} 注册失败`);
  return { models, model };
}

/** 从 env 构建 kimi 兼容的 pi 驱动;env 缺失在创建时即抛中文错误。 */
export function createPiTurnDriver(options: PiTurnDriverOptions): TurnDriver {
  const modelId = options.modelId ?? options.env.LLM_MODEL ?? '';
  const { models, model } = options.runtime ?? createPiModelRuntime(options.env, modelId, {
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  });

  const thinkingLevel = options.thinkingLevel
    ?? parsePiThinkingLevel(options.env.LLM_THINKING_LEVEL, 'LLM_THINKING_LEVEL');

  // Pi 配置适配：把窗口派生的绝对 CompactionSettings 交给 Pi（非压缩机制，见函数注释）。
  const compaction = piCompactionSettings(model.contextWindow);

  // 会话生命周期（§4.1）：reuseConversation 时本实例持有唯一 Pi 会话，跨回合连续；
  // 否则每次 run 一次性（既有行为）。
  const reuseConversation = options.reuseConversation === true;
  let conversation: Promise<Conversation> | undefined;
  /** 上一回合交回的投影转录（仅 reuseConversation）：用于只追加新增尾部，不重灌历史。 */
  let lastProjected: AgentMessage[] | undefined;

  const openConversation = async (
    tools: ReturnType<typeof toAgentTool>[],
    systemPrompt: string,
  ): Promise<Conversation> => {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const created = await AgentHarness.create({
      session,
      models,
      model,
      tools: tools as never,
      activeToolNames: tools.map((tool) => tool.name),
      systemPrompt,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      toProviderMessages: plannerMessagesToLlm,
      compaction,
      retry: MAIN_MODEL_RETRY_POLICY,
    }, BACKGROUND_CONTEXT);
    const harness = created.harness;
    const lane = await harness.lane('main', BACKGROUND_CONTEXT);

    // 模型错误/瞬时重试的可归因事件（Pi 原生生命周期事件转成宿主结构化日志）。
    // 归因槽按回合切换（slot.current），复用会话时 listener 只注册一次、不随回合泄漏。
    const slot: Conversation['slot'] = { current: undefined };
    harness.events.on('retry_scheduled', (event) => {
      if (slot.current) slot.current.retryScheduled += 1;
      console.warn(JSON.stringify({
        event: 'pi_driver_retry_scheduled',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: String(event.errorMessage).slice(0, 500),
      }));
    });
    harness.events.on('run_end', (event) => {
      if (event.status === 'failed' && slot.current) {
        slot.current.runFailure = { code: event.error.code, message: event.error.message };
      }
    });
    return { harness, lane, slot };
  };

  /**
   * 取本回合的会话：复用模式下首次创建、其后只换本回合工具闭包（exec/onStep 不能钉死首回合）；
   * 每回合一次性模式下新建。
   */
  const acquireConversation = async (
    tools: ReturnType<typeof toAgentTool>[],
    systemPrompt: string,
  ): Promise<Conversation> => {
    if (!reuseConversation) {
      const active = await openConversation(tools, systemPrompt);
      active.slot.current = { retryScheduled: 0 };
      return active;
    }
    if (conversation === undefined) {
      conversation = openConversation(tools, systemPrompt);
      // 创建失败不缓存，下一回合重试（fail-closed，不钉死坏会话）。
      conversation.catch(() => { conversation = undefined; });
    }
    const active = await conversation;
    await active.harness.setTools(tools as never, BACKGROUND_CONTEXT);
    await active.lane.setActiveTools(tools.map((tool) => tool.name), BACKGROUND_CONTEXT);
    active.slot.current = { retryScheduled: 0 };
    return active;
  };

  /** 丢弃复用会话（异常/转录分叉时重建；正常路径不触发）。 */
  const discardConversation = async (): Promise<void> => {
    const previous = conversation;
    conversation = undefined;
    lastProjected = undefined;
    if (previous === undefined) return;
    const closed = await previous.catch(() => undefined);
    if (closed !== undefined) await closed.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  };

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const providerToolNames = createProviderToolNameMap(input.tools);

      // 取消/截止：父级取消信号 + 回合截止，合成一个 abort 信号交给 Pi 的运行上下文。
      const abort = new AbortController();
      const onParentAbort = () => abort.abort();
      if (input.signal) {
        if (input.signal.aborted) abort.abort();
        else input.signal.addEventListener('abort', onParentAbort, { once: true });
      }
      const remaining = input.deadline - Date.now();
      if (remaining <= 0) {
        if (input.signal) input.signal.removeEventListener('abort', onParentAbort);
        return { text: '', messages: [...input.messages] };
      }
      const timer = setTimeout(() => abort.abort(), Math.max(1, remaining));

      const tools = input.tools.map((tool) => toAgentTool(
        tool,
        input,
        providerToolNames.get(tool.name)!,
        abort.signal,
      ));

      let harness: Conversation['harness'] | undefined;
      try {
        let active = await acquireConversation(tools, input.systemPrompt);
        harness = active.harness;
        let lane = active.lane;

        // 转录即状态：首回合把宿主历史喂给 Pi 会话；复用会话时只追加新增尾部
        // （生产上即 taskFactProvider 新注入的事实与新的用户消息），不重灌旧投影。
        const last = input.messages[input.messages.length - 1];
        const lastIsUser = last !== undefined && (last as { role?: string }).role === 'user';
        const history = lastIsUser ? input.messages.slice(0, -1) : input.messages;
        let toAppend: AgentMessage[] = history;
        if (reuseConversation && lastProjected !== undefined) {
          if (isPrefixExtension(lastProjected, input.messages)) {
            const delta = input.messages.slice(lastProjected.length);
            toAppend = lastIsUser ? delta.slice(0, -1) : delta;
          } else {
            // 宿主转录与 Pi 会话不再同源（异常路径）：重建会话并全量追加，保证正确性优先。
            await discardConversation();
            active = await acquireConversation(tools, input.systemPrompt);
            harness = active.harness;
            lane = active.lane;
            toAppend = history;
          }
        }
        for (const message of toAppend) await lane.appendMessage(message, BACKGROUND_CONTEXT);

        const runContext = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
        if (lastIsUser) {
          const runResult = await lane.prompt([last], runContext);
          if (!runResult.ok) {
            console.error(JSON.stringify({ event: 'pi_driver_run_rejected', reason: String(runResult.error) }));
          }
        }

        const slot = active.slot;
        let messages = await projectTranscript(lane);
        const runFailure = slot.current?.runFailure;
        const retryScheduled = slot.current?.retryScheduled ?? 0;

        // 供应商错误归因：run 失败 / 错误 assistant 必须可查（不许静默吞成空文本）。
        if (runFailure !== undefined) {
          console.error(JSON.stringify({
            event: 'pi_driver_model_error',
            attempt: 1,
            errorCode: runFailure.code,
            errorMessage: runFailure.message.slice(0, 500),
            retryScheduled,
            contextWindow: model.contextWindow,
          }));
        }
        const failedAssistant = lastAssistantStop(messages);
        if (failedAssistant?.stopReason === 'error' || failedAssistant?.stopReason === 'aborted') {
          console.error(JSON.stringify({
            event: 'pi_driver_failed_assistant',
            stopReason: failedAssistant.stopReason,
            errorMessage: failedAssistant.errorMessage?.slice(0, 500),
            contextWindow: model.contextWindow,
          }));
        }

        let text = finalReplyText(messages);

        if (!text) {
          // 空回复必须留下可归因的形状。
          const lastMessage = messages[messages.length - 1] as {
            role?: string; stopReason?: string; errorMessage?: string; content?: unknown;
          } | undefined;
          console.warn(JSON.stringify({
            event: 'pi_driver_empty_reply',
            role: lastMessage?.role,
            stopReason: lastMessage?.stopReason,
            errorMessage: lastMessage?.errorMessage?.slice(0, 300),
            contentBlocks: Array.isArray(lastMessage?.content)
              ? lastMessage.content.map((block) => (block as { type?: string }).type ?? 'unknown')
              : typeof lastMessage?.content,
            contextWindow: model.contextWindow,
          }));
        }

        // 只思考没正文：催一次最终文本（一轮一次）。催问作为 user 消息进入转录——
        // 它是本回合真实发生过的一次宿主请求，不是隐藏改写。
        if (shouldNudgeFinalReply(messages, text) && Date.now() < input.deadline) {
          console.warn(JSON.stringify({ event: 'pi_driver_final_text_nudge', contextWindow: model.contextWindow }));
          const nudgeContext = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
          try {
            await lane.prompt(FINAL_REPLY_NUDGE, undefined, nudgeContext);
          } catch (error) {
            console.error(JSON.stringify({
              event: 'pi_driver_final_text_nudge_failed',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }));
          }
          messages = await projectTranscript(lane);
          text = finalReplyText(messages);
          if (!text) {
            console.warn(JSON.stringify({
              event: 'pi_driver_final_text_nudge_empty',
              contextWindow: model.contextWindow,
            }));
          }
        }

        // 复用会话：记住本回合交回的投影，下一回合只追加新增尾部（Pi 原生转录/压缩状态
        // 留在同一会话里，不再靠宿主重灌投影转录续上下文）。
        lastProjected = messages;
        return { text, messages };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_driver_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }));
        // 异常后会话中可能有半程条目、与宿主转录不再同源：丢弃并下一回合重建（不硬续坏状态）。
        if (reuseConversation) await discardConversation();
        return { text: '', messages: [...input.messages] };
      } finally {
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener('abort', onParentAbort);
        // 一次性会话随回合关闭；复用会话随驱动实例（=业务会话）存活，此处不关闭。
        if (!reuseConversation && harness) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      }
    },

    // 服务端确定性回复（确认码直执）合成原生 assistant 消息，防止毒化下一模型回合
    synthesizeAssistant: (text: string): AgentMessage =>
      toPiMessage({ role: 'assistant', content: text }, modelId),
  };
}

/**
 * 把 Pi 会话分支投影成宿主转录（业务层只读投影）：压缩条目替换其之前的一切为
 * 「摘要 + 保留尾段」；普通消息原样保留（含宿主 custom 事件、工具调用与结果）。
 */
async function projectTranscript(lane: {
  findEntries(query: undefined, context: typeof BACKGROUND_CONTEXT): Promise<Entry[]>;
}): Promise<AgentMessage[]> {
  const entries = [...await lane.findEntries(undefined, BACKGROUND_CONTEXT)].sort((a, b) => a.seq - b.seq);
  let messages: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      messages = [summaryToMessage(entry.summary, entry.timestamp), ...entry.retainedTail];
    } else if (entry.type === 'message') {
      messages.push(entry.message);
    }
  }
  return messages;
}

/** Pi 压缩摘要 → 宿主转录里的一条用户消息（包装文案固定，不承载压缩决策）。 */
function summaryToMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: 'user',
    content: `【此前会话摘要】\n${summary}`,
    timestamp,
  } as unknown as AgentMessage;
}

/** 最后一条 assistant 的 stopReason/errorMessage（无则 undefined）。 */
function lastAssistantStop(messages: readonly AgentMessage[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (message?.role === 'assistant') return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * 取终结文本：最后一条 assistant 的正文（stopReason 必须为 stop）；若最后一条是
 * toolResult（工具以确定性话术终结），取其文本。
 */
function finalReplyText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (message?.role === 'assistant') {
      const text = message.stopReason === 'stop' ? textFromContent(message.content) : '';
      return text;
    }
    if (message?.role === 'toolResult') {
      return textFromContent(message.content);
    }
  }
  return '';
}

/** 有界历史/当前消息 → pi 的 AgentMessage。assistant 必须带完整内部形状，否则结算会崩溃。 */
function toPiMessage(
  message: { role: string; content: string },
  modelId: string,
): AgentMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: message.content }],
      api: 'openai-completions',
      provider: 'llm',
      model: modelId,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as unknown as AgentMessage;
  }
  return { role: 'user', content: message.content, timestamp: Date.now() } as unknown as AgentMessage;
}

/**
 * Build provider-facing names independently from domain tool names.
 */
export function createProviderToolNameMap(tools: readonly DiscoveredTool[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();

  for (const tool of tools) {
    if (isProviderToolName(tool.name)) {
      result.set(tool.name, tool.name);
      used.add(tool.name);
    }
  }

  for (const tool of tools) {
    if (result.has(tool.name)) continue;

    const base = tool.name.replace(/[^A-Za-z0-9_-]/g, '_') || 'domain_tool';
    let candidate = fitProviderToolName(base, tool.name);
    if (used.has(candidate)) {
      const suffix = `_${stableNameHash(tool.name)}`;
      candidate = fitProviderToolName(`${base}${suffix}`, tool.name);
      let n = 2;
      while (used.has(candidate)) {
        candidate = fitProviderToolName(`${base}${suffix}_${n}`, tool.name);
        n += 1;
      }
    }
    result.set(tool.name, candidate);
    used.add(candidate);
  }
  return result;
}

function isProviderToolName(name: string): boolean {
  return name.length > 0 && name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH && PROVIDER_TOOL_NAME_RE.test(name);
}

function fitProviderToolName(base: string, original: string): string {
  if (base.length <= PROVIDER_TOOL_NAME_MAX_LENGTH && isProviderToolName(base)) return base;
  const suffix = `_${stableNameHash(original)}`;
  const prefixLength = Math.max(1, PROVIDER_TOOL_NAME_MAX_LENGTH - suffix.length);
  return `${base.slice(0, prefixLength)}${suffix}`;
}

function stableNameHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 构造 Pi Harness 原生工具定义（execute 收 Harness 的回调/上下文参数并忽略之）。 */
export function toAgentTool(
  tool: DiscoveredTool,
  input: TurnDriverInput,
  providerName = tool.name,
  signal?: AbortSignal,
) {
  return {
    name: providerName,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      properties: {
        ...typeof tool.inputSchema === 'object' && tool.inputSchema !== null
          ? (tool.inputSchema as { properties?: Record<string, unknown> }).properties
          : {},
        progress: {
          type: 'string',
          description:
            '一句话说明你即将做什么(≤50 字),作为给用户看的进度提示;只许描述即将进行的动作,严禁包含任何结果数字、编号或协议字段',
        },
      },
    }),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _onUpdate?: unknown,
      _toolContext?: unknown,
      _invocation?: unknown,
      _context?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const { progress, ...args } = params as Record<string, unknown> & { progress?: unknown };
      const phrase = typeof progress === 'string' ? progress : '';
      const step = renderToolStepText(tool.name, phrase);
      if (step) input.onStep(step);
      try {
        const data = await input.exec(tool.name, args, signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          details: {},
        };
      } catch (error) {
        if (error instanceof ToolUserError) {
          // 确定性失败话术直接终结回合,不经模型复述
          return {
            content: [{ type: 'text' as const, text: error.message }],
            details: {},
            terminate: true,
          };
        }
        throw error;
      }
    },
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('')
    .trim();
}
