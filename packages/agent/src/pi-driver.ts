/**
 * PiTurnDriver：基于 `@earendil-works/pi-coding-agent@1.5.2` 公开 `AgentSession` 的回合驱动。
 *
 * 转录所有权（设计见 `docs/product/pi-152-adapter-design.md`）：
 *   · `AgentSession` + `SessionManager` 是会话转录、agent loop、压缩与原生重试的**唯一所有者**；
 *   · 宿主不再持有第二份可变转录：本驱动只把「本轮新增输入」交给 Pi，并把 Pi 会话
 *     投影成**只读** AgentMessage 快照交回（`TurnDriver.transcript()` 同样只读）；
 *   · 压缩的触发 / 执行（摘要）/ 尾段保留 / 溢出恢复全部归 Pi；fshine 只传绝对
 *     `CompactionSettings`（Pi 配置适配，见 piCompactionSettings —— 不是压缩机制）。
 *
 * 工具面 = `customTools` + 显式白名单 `tools`（Pi 内置 read/bash/edit/write 不激活）；
 * 模型走原生 function calling；模型能力/凭据只来自调用方传入的 env / ModelRuntime。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  DEFAULT_COMPACTION_SETTINGS,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionSettings,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver-contract';
import { renderToolStepText } from './step-text';

/** 主模型瞬时失败的有界重试策略（交给 Pi 原生 RetrySettings 执行；沿用旧 [1000,2000] 两次延迟）。 */
const MAIN_MODEL_RETRY_SETTINGS = { enabled: true, maxRetries: 2, baseDelayMs: 1_000 } as const;

/** 模型 provider id（与 createPiModelRuntime 注册的一致；不取模型输出）。 */
const LLM_PROVIDER_ID = 'llm';

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
 * （只有 `enabled/reserveTokens/keepRecentTokens` 三个绝对字段，无窗口相对字段、无缩放助手）。
 * Pi 缺省值按 128k 窗口设计（reserve=16384、keepRecent=20000）：小窗口下 reserve 会
 * 超过窗口本身，不缩放则 Pi 自身行为已失效（短回合被压、零收益循环）。
 *
 * 因此本函数只做一件纯配置的事：**窗口装得下 Pi 缺省就沿用缺省，否则按比例缩放**——
 * 这是履行 Pi 契约的入参，**不含任何 fshine 的压缩决策/安全闸 math**。触发/执行/摘要/
 * 尾段/溢出恢复全归 Pi。
 *
 * 纯函数、无副作用、无外部依赖。
 */
/** 传给 Pi 的绝对压缩配置（三字段必填；Pi 的 CompactionSettings 字段可选，此处给出确定值）。 */
export interface PiCompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export function piCompactionSettings(contextWindow: number): PiCompactionConfig {
  const defaults = DEFAULT_COMPACTION_SETTINGS;
  // Pi 缺省值在运行期必然存在（DEFAULT_COMPACTION_SETTINGS 常量）；`??` 只为类型收敛，
  // 数值不另造：仍是 Pi 的 16384 / 20000。
  const reserveTokens = defaults.reserveTokens ?? 16_384;
  const keepRecentTokens = defaults.keepRecentTokens ?? 20_000;
  if (!Number.isFinite(contextWindow) || contextWindow >= reserveTokens + keepRecentTokens) {
    return { enabled: defaults.enabled ?? true, reserveTokens, keepRecentTokens };
  }
  return {
    enabled: true,
    reserveTokens: Math.max(1, Math.min(reserveTokens, Math.floor(contextWindow * 0.25))),
    keepRecentTokens: Math.max(1, Math.min(keepRecentTokens, Math.floor(contextWindow * 0.3))),
  };
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
  /** 显式单次输出上限（token）。缺省 = DEFAULT_MAX_TOKENS。 */
  maxTokens?: number;
  /** 注入的模型运行时（测试/嵌入用；必须已注册 LLM_PROVIDER_ID 的 provider）。 */
  modelRuntime?: ModelRuntime;
  /**
   * 显式 Pi 压缩配置（绝对 `reserveTokens`/`keepRecentTokens`）。缺省 = 由窗口派生的
   * `piCompactionSettings(model.contextWindow)`（行为逐字节不变）。装配/评测需要按
   * 「窗口 − 输出预算 − 余量」给出安全值时，经此参数传入；驱动仍只做透传，
   * 触发/执行/摘要/尾段全归 Pi（不含任何 fshine 压缩决策）。
   */
  compactionSettings?: CompactionSettings;
  /**
   * 会话生命周期：true = 本驱动实例持有**一个** AgentSession（首次 run 创建，跨回合复用；
   * 生产装配在业务会话级 Main 上传 true）；false/缺省 = 每回合一次性会话（Worker/直测）。
   */
  reuseConversation?: boolean;
  /**
   * 会话落盘目录（仅实例级会话；缺省 = 进程内 SessionManager.inMemory，不写盘）。
   * 阶段 C 的持久化装配点：显式给出即落盘，可被 resumeSessionFile 重开。
   */
  sessionDir?: string;
  /** 从已落盘的 Pi 会话文件继续同一 Session（只消费一次；缺省 = 新会话）。 */
  resumeSessionFile?: string;
  /**
   * Pi 的 cwd（渲染进系统提示 <cwd> 段的工作目录）。必须是与宿主项目隔离的空目录；
   * 缺省 = 进程临时目录下的 `fshine-pi-<pid>`（不指向仓库根/用户主目录）。
   */
  workspaceDir?: string;
  /** Pi 的 agentDir（配置/凭据发现面）。缺省 = workspaceDir/.pi-agent，不读宿主 ~/.pi。 */
  agentDir?: string;
}

/**
 * 从 env 构建 kimi 兼容的 Pi `ModelRuntime`（公开 API：ModelRuntime.create + registerProvider）。
 * env 缺失在创建时即抛中文错误。认证只认 `options.env` 的 LLM_API_KEY（不读 process.env）。
 */
export async function createPiModelRuntime(
  env: Record<string, string | undefined>,
  modelId: string,
  capabilities: PiModelCapabilities = {},
): Promise<ModelRuntime> {
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

  const runtime = await ModelRuntime.create({
    // 隔离认证存储：不读宿主 ~/.pi/agent/auth.json；凭据只来自本函数的 apiKey。
    authPath: path.join(tmpdir(), `fshine-pi-auth-${process.pid}.json`),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(LLM_PROVIDER_ID, {
    name: 'LLM',
    api: 'openai-completions',
    apiKey,
    models: [{
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      baseUrl,
      reasoning: true,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: parseContextWindow(capabilities.contextWindow, 'contextWindow') ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: capabilities.maxTokens ?? DEFAULT_MAX_TOKENS,
    }],
  });
  if (!runtime.getModel(LLM_PROVIDER_ID, modelId)) throw new Error(`LLM 模型 ${modelId} 注册失败`);
  return runtime;
}

/**
 * 受控 ResourceLoader（公开接口实现，不是 Pi 源码副本）：
 *   · 系统提示 = 装配层给的 fshine 提示（Pi 用它替换默认 coding-assistant preamble）；
 *   · 不加载项目文件（AGENTS.md 等）、扩展、提示模板、主题 → 不自动授予文件系统/终端/MCP；
 *   · 不启用 Pi 的技能读取段（我们只暴露业务工具白名单，不含 read/bash）。
 */
function createFshineResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** 本回合工具执行面（exec/onStep/signal/onRuntimeEvent 每回合更新；工具定义本身随会话固定）。 */
export interface TurnExecSurface {
  exec: TurnDriverInput['exec'];
  onStep: TurnDriverInput['onStep'];
  signal?: AbortSignal;
  /** U3：运行时回合事实（assistant_end / compaction willRetry / auto_retry）→ 宿主重放窗口判定。 */
  onRuntimeEvent?: TurnDriverInput['onRuntimeEvent'];
}

/** 构造 Pi 原生工具定义（execute 动态读取本回合执行面，不钉死首回合闭包）。 */
export interface PiAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Unsafe>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
}

export function toAgentTool(
  tool: DiscoveredTool,
  surface: TurnExecSurface,
  providerName = tool.name,
): PiAgentTool {
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
    ): Promise<AgentToolResult<unknown>> => {
      const { progress, ...args } = params as Record<string, unknown> & { progress?: unknown };
      const phrase = typeof progress === 'string' ? progress : '';
      const step = renderToolStepText(tool.name, phrase);
      if (step) surface.onStep(step);
      try {
        const data = await surface.exec(tool.name, args, surface.signal);
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

/** 本驱动实例持有的 Pi 会话（reuseConversation 时跨回合复用）。 */
interface TurnSlot {
  retryScheduled: number;
  /** 本回合最近一次 assistant 失败（sticky：只用于归因日志）。 */
  runFailure?: { code: string; message: string };
  /**
   * 失败之后是否又有正常 assistant 消息（Pi 原生重试/溢出恢复成功）：
   * `runFailure` 且未 recovered = 本回合仍以失败收尾（不得把尾部 toolResult/旧正文当答复）。
   */
  recovered?: boolean;
}

interface Conversation {
  session: AgentSession;
  sessionManager: SessionManager;
  systemPrompt: string;
  toolNames: string;
  contextWindow: number;
  /** 回合归因槽：事件 listener 只随会话注册一次，每回合指向本回合的计数/失败。 */
  slot: { current: TurnSlot | undefined };
  lastProjection: AgentMessage[];
}

/** 会话创建参数（工具定义与执行面分离：工具随会话固定，执行面每回合换）。 */
interface BuildConversationInput {
  tools: readonly DiscoveredTool[];
  providerNames: Map<string, string>;
  systemPrompt: string;
  surfaceRef: { current: TurnExecSurface | undefined };
  seed: readonly AgentMessage[];
}

/** 从 env 构建 Pi 回合驱动。env 缺失在首次会话创建时抛中文错误。 */
export function createPiTurnDriver(options: PiTurnDriverOptions): TurnDriver {
  const modelId = options.modelId ?? options.env.LLM_MODEL ?? '';
  const thinkingLevel = options.thinkingLevel
    ?? parsePiThinkingLevel(options.env.LLM_THINKING_LEVEL, 'LLM_THINKING_LEVEL');

  let runtimePromise: Promise<ModelRuntime> | undefined;
  const getRuntime = (): Promise<ModelRuntime> => {
    if (runtimePromise === undefined) {
      runtimePromise = options.modelRuntime !== undefined
        ? Promise.resolve(options.modelRuntime)
        : createPiModelRuntime(options.env, modelId, {
          ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        });
      runtimePromise.catch(() => { runtimePromise = undefined; });
    }
    return runtimePromise;
  };

  const reuseConversation = options.reuseConversation === true;
  let conversation: Promise<Conversation> | undefined;
  /** 已就绪的实例级会话（transcript 的同步读面；Promise 兑现时同步写入）。 */
  let resolvedConversation: Conversation | undefined;
  let pendingResumeFile = options.resumeSessionFile;
  let lastTurnProjection: readonly AgentMessage[] = [];
  /**
   * 实例级会话的工具执行面引用（跨回合同一个对象）：工具定义在会话创建时固定，
   * 每次 run 只替换 `current`，因此 exec/onStep 始终是本回合闭包。
   */
  const sessionSurface: { current: TurnExecSurface | undefined } | undefined = reuseConversation
    ? { current: undefined }
    : undefined;

  const workspaceDir = options.workspaceDir ?? path.join(tmpdir(), `fshine-pi-${process.pid}`);
  const agentDir = options.agentDir ?? path.join(workspaceDir, '.pi-agent');

  const buildConversation = async (input: BuildConversationInput): Promise<Conversation> => {
    const runtime = await getRuntime();
    const model = runtime.getModel(LLM_PROVIDER_ID, modelId) as Model<'openai-completions'> | undefined;
    if (!model) throw new Error(`LLM 模型 ${modelId} 未在 ModelRuntime 注册`);

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    if (options.sessionDir !== undefined) mkdirSync(options.sessionDir, { recursive: true });

    const settingsManager = SettingsManager.inMemory({
      compaction: options.compactionSettings ?? piCompactionSettings(model.contextWindow),
      retry: { ...MAIN_MODEL_RETRY_SETTINGS },
    });

    const resumeFile = pendingResumeFile;
    pendingResumeFile = undefined;
    const sessionManager = resumeFile !== undefined
      ? SessionManager.open(resumeFile, options.sessionDir, workspaceDir)
      : options.sessionDir !== undefined
        ? SessionManager.create(workspaceDir, options.sessionDir)
        : SessionManager.inMemory(workspaceDir);
    // 首回合/一次性回合的种子历史只进新会话；恢复会话不重灌（转录归 Pi）。
    if (resumeFile === undefined) {
      for (const message of input.seed) sessionManager.appendMessage(toSessionMessage(message));
    }

    const toolDefinitions = input.tools.map((tool) => toAgentTool(
      tool,
      {
        exec: (name, args, signal) => input.surfaceRef.current === undefined
          ? Promise.reject(new Error('本回合工具执行面尚未就绪'))
          : input.surfaceRef.current.exec(name, args, signal),
        onStep: (text) => input.surfaceRef.current?.onStep(text),
        get signal() { return input.surfaceRef.current?.signal; },
      },
      input.providerNames.get(tool.name) ?? tool.name,
    ));

    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir,
      model,
      modelRuntime: runtime,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      sessionManager,
      settingsManager,
      resourceLoader: createFshineResourceLoader(input.systemPrompt),
      customTools: toolDefinitions as ToolDefinition[],
      // 显式白名单：只激活业务工具。probe 实测 noTools:'all' 会把 customTools 一并关掉。
      tools: toolDefinitions.map((tool) => tool.name),
    });

    const slot: Conversation['slot'] = { current: undefined };
    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'compaction_end') {
        // U3：溢出/阈值压缩后将继续重试 = 上一次 assistant 尝试被丢弃（Pi 的 _omitRecoveryAttempt
        // 只隐藏该尝试及其 toolResult，不回滚已发生的副作用）。只转述事实，判定归宿主。
        if (event.willRetry) input.surfaceRef.current?.onRuntimeEvent?.({ kind: 'recovery', reason: 'compaction' });
        return;
      }
      if (event.type === 'auto_retry_start') {
        if (slot.current) slot.current.retryScheduled += 1;
        // U3：瞬时错误（529 等）的自动重试 = 上一次 assistant 尝试被丢弃；重试响应可能
        // 重发同一 toolCall。与 message_end('error') 同一失败周期内重复转述，宿主侧幂等开窗。
        input.surfaceRef.current?.onRuntimeEvent?.({ kind: 'recovery', reason: 'auto_retry' });
        console.warn(JSON.stringify({
          event: 'pi_driver_retry_scheduled',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: String(event.errorMessage).slice(0, 500),
        }));
        return;
      }
      if (event.type === 'message_end' && event.message.role === 'assistant' && slot.current) {
        const stopReason = event.message.stopReason;
        if (stopReason === 'error' || stopReason === 'aborted') {
          slot.current.runFailure = {
            code: stopReason === 'error' ? 'model_error' : 'aborted',
            message: String(event.message.errorMessage ?? ''),
          };
          slot.current.recovered = false;
          // U3：失败尝试结束。可重试错误（stopReason=error）随后会由 Pi 自动重试；该尝试
          // 可能已发出 toolCall，重试响应可能重发 → 打开 attempt 窗口。中止不重试，不转述。
          if (stopReason === 'error') {
            input.surfaceRef.current?.onRuntimeEvent?.({ kind: 'recovery', reason: 'auto_retry' });
          }
        } else {
          // 失败之后又出现正常 assistant 消息 = Pi 原生重试/溢出恢复已经接上。
          slot.current.recovered = true;
          // U3：正常结束的响应边界（其后的工具调用属于这次响应）。
          input.surfaceRef.current?.onRuntimeEvent?.({ kind: 'assistant_end' });
        }
      }
    });

    const built: Conversation = {
      session,
      sessionManager,
      systemPrompt: input.systemPrompt,
      toolNames: toolDefinitions.map((tool) => tool.name).join(','),
      contextWindow: model.contextWindow,
      slot,
      lastProjection: projectSession(session),
    };
    if (reuseConversation) resolvedConversation = built;
    return built;
  };

  const discardConversation = async (): Promise<void> => {
    const previous = conversation;
    conversation = undefined;
    if (previous === undefined) return;
    const closed = await previous.catch(() => undefined);
    if (closed === undefined) return;
    if (resolvedConversation === closed) resolvedConversation = undefined;
    closed.session.dispose();
  };

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const providerToolNames = createProviderToolNameMap(input.tools);
      const deadline = input.deadline;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { text: '', messages: [...input.messages] };

      const last = input.messages[input.messages.length - 1] as { role?: string; content?: unknown } | undefined;
      const lastIsUser = last !== undefined && last.role === 'user';
      const promptText = lastIsUser ? textFromContent(last?.content) : '';
      const seed = lastIsUser ? input.messages.slice(0, -1) : input.messages;

      // 取消/截止：父级取消信号 + 回合截止 → 合成 abort，交给 Pi 原生 abort()。
      const abort = new AbortController();
      const onParentAbort = () => abort.abort();
      if (input.signal) {
        if (input.signal.aborted) abort.abort();
        else input.signal.addEventListener('abort', onParentAbort, { once: true });
      }
      const timer = setTimeout(() => abort.abort(), Math.max(1, remaining));

      const surfaceRef: { current: TurnExecSurface | undefined } = sessionSurface
        ?? { current: undefined };
      surfaceRef.current = {
        exec: input.exec,
        onStep: input.onStep,
        signal: abort.signal,
        ...(input.onRuntimeEvent === undefined ? {} : { onRuntimeEvent: input.onRuntimeEvent }),
      };

      let active: Conversation | undefined;
      const abortSession = () => {
        if (active !== undefined && abort.signal.aborted) void active.session.abort().catch(() => undefined);
      };
      abort.signal.addEventListener('abort', abortSession, { once: true });

      try {
        let conversationForRun = reuseConversation ? conversation : undefined;
        if (conversationForRun === undefined) {
          conversationForRun = buildConversation({
            tools: input.tools,
            providerNames: providerToolNames,
            systemPrompt: input.systemPrompt,
            surfaceRef,
            seed,
          });
          if (reuseConversation) {
            conversation = conversationForRun;
            conversationForRun.catch(() => { conversation = undefined; });
          }
        }
        active = await conversationForRun;

        // 系统提示/工具名集合在会话内必须稳定；变化时按新配置重建（生产 Main 恒定，不触发）。
        if (reuseConversation && (active.systemPrompt !== input.systemPrompt
          || active.toolNames !== input.tools.map((tool) => providerToolNames.get(tool.name) ?? tool.name).join(','))) {
          if (active.systemPrompt !== input.systemPrompt) {
            console.warn(JSON.stringify({ event: 'pi_driver_prompt_changed_session_rebuild' }));
          }
          await discardConversation();
          conversationForRun = buildConversation({
            tools: input.tools,
            providerNames: providerToolNames,
            systemPrompt: input.systemPrompt,
            surfaceRef,
            seed: [],
          });
          conversation = conversationForRun;
          conversationForRun.catch(() => { conversation = undefined; });
          active = await conversationForRun;
        }

        const session = active.session;
        active.slot.current = { retryScheduled: 0 };
        active.lastProjection = projectSession(session);

        // 宿主事实注入：Pi 原生 custom message（下次请求按 user 角色投影），不触发单独回合。
        for (const injection of abort.signal.aborted ? [] : input.injections ?? []) {
          if (injection.trim() === '') continue;
          await session.sendCustomMessage(
            { customType: 'fshine_task_fact', content: injection, display: false },
            { triggerTurn: false },
          );
        }

        // 本回合是否真的把输入交给了 Pi：已中止 / 无输入时本回合没有任何产出，
        // 不得把转录里的上一回合答复当本回合回复（宁可空文本 = 失败）。
        const promptSent = promptText.trim() !== '' && !abort.signal.aborted;
        if (promptSent) {
          await session.prompt(promptText, { expandPromptTemplates: false });
        }

        let messages = projectSession(session);
        const slot = active.slot.current;
        const runFailure = slot?.runFailure;
        const retryScheduled = slot?.retryScheduled ?? 0;

        // 本回合答复。三条纪律：①本回合没把输入交给 Pi → 空；②Pi 已把本回合判失败
        // （runFailure 且其后没有正常 assistant 消息）→ 空——失败回合的尾部可能是
        // toolResult（例如刚委派出去的 run_task 结果 JSON），它是工具事实、不是给用户的
        // 答复；③否则只取本回合 user 输入之后产生的正文（finalReplyText 按回合切）。
        const turnReplyText = (): string => (!promptSent
          || (slot?.runFailure !== undefined && slot.recovered !== true)
          ? ''
          : finalReplyText(messages, promptText));

        // 供应商错误归因：run 失败 / 错误 assistant 必须可查（不许静默吞成空文本）。
        if (runFailure !== undefined) {
          console.error(JSON.stringify({
            event: 'pi_driver_model_error',
            attempt: 1,
            errorCode: runFailure.code,
            errorMessage: runFailure.message.slice(0, 500),
            retryScheduled,
            contextWindow: active.contextWindow,
          }));
        }
        const failedAssistant = lastAssistantStop(messages);
        if (failedAssistant?.stopReason === 'error' || failedAssistant?.stopReason === 'aborted') {
          console.error(JSON.stringify({
            event: 'pi_driver_failed_assistant',
            stopReason: failedAssistant.stopReason,
            errorMessage: failedAssistant.errorMessage?.slice(0, 500),
          }));
        }

        let text = turnReplyText();

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
          }));
        }

        // 只思考没正文：催一次最终文本（一轮一次）。催问作为 user 消息进入 Pi 转录——
        // 它是本回合真实发生过的一次宿主请求，不是隐藏改写。
        if (promptSent && shouldNudgeFinalReply(messages, text) && Date.now() < deadline && !abort.signal.aborted) {
          console.warn(JSON.stringify({ event: 'pi_driver_final_text_nudge' }));
          try {
            await session.prompt(FINAL_REPLY_NUDGE, { expandPromptTemplates: false });
          } catch (error) {
            console.error(JSON.stringify({
              event: 'pi_driver_final_text_nudge_failed',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }));
          }
          messages = projectSession(session);
          text = turnReplyText();
          if (!text) {
            console.warn(JSON.stringify({ event: 'pi_driver_final_text_nudge_empty' }));
          }
        }

        active.lastProjection = messages;
        lastTurnProjection = messages;
        return { text, messages };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_driver_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }));
        // 异常后会话中可能有半程条目：实例级会话丢弃、下一回合重建（不硬续坏状态）。
        if (reuseConversation) await discardConversation();
        return { text: '', messages: [...input.messages] };
      } finally {
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener('abort', onParentAbort);
        abort.signal.removeEventListener('abort', abortSession);
        // 回合级会话随回合释放；实例级会话随驱动实例（=业务会话）存活。
        if (!reuseConversation && active !== undefined) active.session.dispose();
      }
    },

    /** 只读派生：Pi 会话当前转录（宿主不得据此累积可变历史）。 */
    transcript(): readonly AgentMessage[] {
      // 同步读：实例级会话已就绪时直接读 Pi 的 session.messages（每次重新投影，不缓存历史）。
      return resolvedConversation === undefined ? lastTurnProjection : projectSession(resolvedConversation.session);
    },

    /** 只读审计面（A2/A3 验证与运行期排障用；不做任何行为）。 */
    sessionInfo() {
      if (resolvedConversation === undefined) return undefined;
      return {
        systemPrompt: resolvedConversation.session.systemPrompt,
        activeToolNames: resolvedConversation.session.getActiveToolNames(),
        sessionFile: resolvedConversation.session.sessionFile,
      };
    },

    /** 释放实例级会话（进程正常退出路径）。 */
    close(): void {
      lastTurnProjection = resolvedConversation === undefined
        ? lastTurnProjection
        : projectSession(resolvedConversation.session);
      resolvedConversation = undefined;
      void discardConversation();
    },

    // 服务端确定性回复（确认码直执）合成原生 assistant 消息，防止毒化下一模型回合
    synthesizeAssistant: (text: string): AgentMessage =>
      toPiMessage({ role: 'assistant', content: text }, modelId),
  };
}

/** 会话投影（只读）：过滤 system，Pi 压缩摘要/宿主 custom 消息渲染成宿主可读的 user 消息。 */
function projectSession(session: AgentSession): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const message of session.messages) {
    const record = message as unknown as {
      role?: string; summary?: string; content?: unknown; timestamp?: number;
    };
    if (record.role === 'system') continue;
    if (record.role === 'compactionSummary') {
      messages.push(summaryToMessage(String(record.summary ?? ''), record.timestamp ?? Date.now()));
      continue;
    }
    if (record.role === 'custom') {
      messages.push({
        role: 'user',
        content: textFromContent(record.content),
        timestamp: record.timestamp ?? Date.now(),
      } as unknown as AgentMessage);
      continue;
    }
    messages.push(message);
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

type SessionMessage = Parameters<SessionManager['appendMessage']>[0];

/** 种子消息 → SessionManager 可持久化的 Message（custom 渲染成 user）。 */
function toSessionMessage(message: AgentMessage): SessionMessage {
  const record = message as unknown as { role?: string; content?: unknown; timestamp?: number };
  if (record.role === 'custom') {
    return {
      role: 'user',
      content: textFromContent(record.content),
      timestamp: record.timestamp ?? Date.now(),
    } as unknown as SessionMessage;
  }
  return message as unknown as SessionMessage;
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
 * 取**本回合**的终结文本：只认本回合 user 输入之后产生的消息。
 *
 * 为什么必须按回合切：溢出恢复失败时（恢复摘要被 `length` 拒绝），Pi 会丢弃失败回合的
 * assistant 项，转录末条 assistant 是**上一回合**的答复。旧实现从转录尾部一路回扫，
 * 会把上一回合答复当成本回合回复返回（确定性证据 `scripts/eval/pi152-stageB/injection.ts`
 * 的 D-overflow-length：`finalText='历史答复 7。'`）——用户会以为本回合答完了。
 * 宁可返回空文本（宿主按失败转述），也不返回旧回合答复。
 *
 * 切点 = 转录里最后一条 user 消息之后：本回合的 prompt（或它在 Pi 压缩后变成的摘要）
 * 一定位于上一回合答复之后，因此该切点不会回退到旧回合；prompt 被折进摘要时
 * （溢出恢复成功），摘要之后的恢复答复仍算本回合。本回合没有 user 输入（`promptText`
 * 为空）时不认任何 assistant 正文——无法归属就不冒充。末条是 toolResult（工具以
 * 确定性话术终结）时取其文本。
 *
 * 导出只为确定性守卫测试（同 `shouldNudgeFinalReply` 的导出理由；不接线、不改变行为）。
 */
export function finalReplyText(messages: readonly AgentMessage[], promptText: string): string {
  if (promptText.trim() === '') return '';
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string } | undefined;
    if (message?.role === 'user') {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (message?.role === 'assistant') {
      return message.stopReason === 'stop' ? textFromContent(message.content) : '';
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
      provider: LLM_PROVIDER_ID,
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
