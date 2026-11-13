/**
 * PiTurnDriver:基于 pi.dev 生态(@earendil-works/pi-agent-core + pi-ai)的回合驱动。
 * 模型走原生 function calling(无自定义 JSON 协议);流式响应;空闲超时。
 * 事实类进度(重试等)由 host 钩子负责;工具级进度在本驱动的 execute 内渲染。
 */
import { Agent, type AgentTool, DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, estimateTokens, generateSummary, serializeConversation, shouldCompact, type AgentMessage, type CompactionSettings } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
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
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { Type } from 'typebox';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver-contract';
import { renderToolStepText } from './step-text';

const IDLE_TIMEOUT_MS = 90_000; // 流式空闲超时:每收到一个 chunk(含 reasoning 增量)即重置
const OVERALL_TIMEOUT_MS = 300_000; // 单次模型调用总上限(兜底,正常由回合预算约束)
/** 主模型瞬时失败的原地重试延迟（与 worker 同族，只是主驱动原先没有这条腿）。 */
const MAIN_MODEL_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];
/** 回合内应急压缩的触发余量：估算 token 逼近窗口上限时才压（正常增长由回合前压缩管理）。 */
const EMERGENCY_OVERFLOW_HEADROOM_TOKENS = 1_024;

/**
 * 供应商错误话术 → 是否「上下文超限」。超限重试同一条请求没有意义，必须先压缩再重发；
 * 限流/5xx/网络等瞬时错误不在此列（它们走 isRetryableAssistantError 的有界重试）。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /maximum context/i,
  /max(?:imum)? context (?:window|length)/i,
  /exceeds? (?:the )?context/i,
  /context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /token limit/i,
  /reduce the length/i,
];

export function isContextOverflowError(message: string | undefined): boolean {
  if (!message) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 空回复的第二种形状：模型以 `stopReason=stop` 收尾，但 content 只有 thinking 块、
 * 没有 text（今天实测：主模型只输出了思考过程）。这不是供应商错误也不是窗口爆了，
 * 催一次「给出最终文本」通常就能收尾；有正文/toolResult 终结/error/aborted 都不催。
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
 * 装配层持有配置、驱动只收参数）——硬编码的那一份会直接决定压缩阈值
 * （阈值 = contextWindow − reserveTokens），窗口声明错了，压缩要么永远不触发（窗口爆了
 * 才知道），要么过早触发。未提供能力时沿用本缺省值，行为与提供能力前逐字节一致。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 单次输出上限的缺省值（token）：同 DEFAULT_CONTEXT_WINDOW，属能力声明的一部分。 */
export const DEFAULT_MAX_TOKENS = 32_000;

/** 模型能力声明（部署层提供；驱动只收参数，不猜、不按名字查表）。 */
export interface PiModelCapabilities {
  /** 上下文窗口（token）：压缩阈值与溢出判定都用它。 */
  contextWindow?: number;
  /** 单次输出上限（token）。 */
  maxTokens?: number;
}

/** Core Agent drops custom messages by default; explicitly project only our host task context. */
export function plannerMessagesToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') return [message];
    const custom = message as unknown as { role?: string; customType?: string; content?: unknown; timestamp?: number };
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
 * `envVarName` 只进错误信息:同一份词表被 LLM_THINKING_LEVEL 与 LLM_MAIN_THINKING_LEVEL
 * 两个入口共用(词表只有这一个权威位置),报错必须指向真正配错的那一个变量。
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
 * 非法值抛中文错误。窗口是压缩阈值的唯一来源——把一个写错的值静默当成缺省，
 * 会让压缩在真实窗口之外才触发（T7 的贴边空回复正是这样发生的），所以这里 fail-fast。
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
  /**
   * 显式模型 id(分层模型接缝):装配层持有配置,按 LLM_MAIN_MODEL(缺省回落 LLM_MODEL)
   * 解析后传入,驱动不自行读取 Main 专用 env。缺省(不传)回落 env.LLM_MODEL——
   * 直连调用方(scripts/ask.ts 等手工入口)与历史行为逐字段一致。
   */
  modelId?: string;
  /**
   * 显式思考深度:装配层按 LLM_MAIN_THINKING_LEVEL(缺省回落 LLM_THINKING_LEVEL)校验后
   * 传入。缺省(不传)回落 env.LLM_THINKING_LEVEL(此处校验,报错指向该变量)。
   */
  thinkingLevel?: PiThinkingLevel;
  /**
   * 显式模型能力(上下文窗口，token):同 modelId/thinkingLevel，装配层持有配置、驱动只收
   * 参数。缺省 = DEFAULT_CONTEXT_WINDOW(128_000)，与提供能力前的行为逐字节一致。
   */
  contextWindow?: number;
  /**
   * 注入的模型运行时（测试/嵌入用）。缺省 = 按 env 构造；注入时不读 env 的连接字段，
   * 只用于直测驱动控制流（模型错误分流、收尾催问）而不发真实请求。
   */
  runtime?: PiModelRuntime;
}

export interface PiModelRuntime {
  models: MutableModels;
  model: Model<Api>;
}

/**
 * 环境范围认证上下文：先查驱动收到的 env（装配下传的 effectiveEnv / 直连调用方
 * 传入的 env），缺失才回落库默认上下文（process.env + node:fs）。
 *
 * 为什么必须显式织入（issue #20 切片 C+D 回归 / Codex blocking）：pi-ai 默认认证
 * 上下文只读 process.env（库 auth/context.js 头注："Default auth context: env vars
 * from process.env"），而部署配置把 LLM_API_KEY 派生进 effectiveEnv——只把它当
 * options.env 传进来，认证解析看不到它，首次模型请求必然失败。密钥不写回
 * process.env：装配层设计注释已明令，进程级注入会让模型经工具面拿到密钥。
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
 *
 * 导出给认证链接线测试用（`pi-driver-auth.test.ts` 走库的 `Models.getAuth` 解析面，
 * 不起网络）。生产入口仍是 `createPiTurnDriver`。
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

  // kimi coding 端点不接受 developer 角色(pi 对 reasoning 模型的默认行为),
  // 按 pi-ai 文档用 compat.supportsDeveloperRole=false 显式声明,模型推理能力不受影响
  const kimiModel: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'llm',
    baseUrl,
    reasoning: true,
    // Kimi accepts reasoning_effort, but only the ordinary low/medium/high
    // values are meaningful. Explicitly reject Pi's opt-in xhigh/max levels.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    thinkingLevelMap: KIMI_THINKING_LEVEL_MAP,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 能力来自调用方声明（模型能力），未声明时用缺省常数——不再是这里的魔法字面量。
    // 显式声明先校验：非法窗口值不允许静默回落到缺省（那会让压缩阈值与真实窗口脱节）。
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

/** 摘要请求的模板/系统提示余量（token）：`<conversation>` 包裹 + 摘要指令 + system prompt。 */
const SUMMARY_PROMPT_OVERHEAD_TOKENS = 1_024;
/** 一次压缩最多串行发起的摘要请求数；超过说明前缀远超窗口，按摘要失败处理。 */
const MAX_SUMMARY_CHUNKS = 16;
const COMPACTION_INSTRUCTIONS = '这是助手会话的压缩。摘要必须保留:1)当前正在处理的对象标识与名称;2)当前的处理范围;3)最近一次工具结果里的分页游标原值(用户要靠它翻页);4)用户的关键意图与未决问题;5)已得出的中间结论与未完成的步骤(长任务靠它续跑)。如果输入包含宿主标明的历史引用,必须保留其来源是“用户消息附带的引用”;引用是转述数据,不得总结成用户本人直接陈述、选择、确认或授权。如果更早的消息因窗口限制被省略,如实写明省略了哪一段,不得把省略的内容补写成事实。';

/**
 * 按模型能力推导压缩设置（T7 窗口贴边修复）。
 *
 * 为什么不能直接用 DEFAULT_COMPACTION_SETTINGS：那组常数按 128k 窗口设计
 * （reserveTokens=16384、keepRecentTokens=20000）。窗口只有 40000 时阈值 = 23616，
 * 一旦跨过，摘要请求会把已超窗的整段转录塞给模型——输入 + 摘要输出预留超过窗口，
 * 摘要必然失败，转录原样返回，主请求继续贴边/越窗，模型只能回空。keepRecentTokens
 * 不缩放还会把小窗口下的**全部消息**留下再拼摘要，产物比输入更长（压缩方向反了）。
 *
 * 缩放规则：默认设置装得下（窗口 ≥ reserveTokens + keepRecentTokens = 36384，含 128k
 * 缺省与 40k 这类窗口）就逐字段返回默认值，压缩时机一点不变；装不下的窗口按 25% 预留
 * 摘要、30% 保留尾段，保证「保留尾段 + 摘要输出 + 模板余量」一定装得进窗口。
 */
export function compactionSettingsFor(contextWindow: number): CompactionSettings {
  // 默认设置装得下（保留尾段 + 摘要预留都在窗口内）就逐字段沿用默认值：
  // 128k 缺省、以及 40k 这类仍能容纳 20000+16384 的窗口都保持原有阈值，
  // 不因 T7 修复改变它们的压缩时机。只有装不下时才按比例缩放。
  if (!Number.isFinite(contextWindow)
    || contextWindow >= DEFAULT_COMPACTION_SETTINGS.reserveTokens + DEFAULT_COMPACTION_SETTINGS.keepRecentTokens) {
    return DEFAULT_COMPACTION_SETTINGS;
  }
  const reserveTokens = Math.max(1_024, Math.min(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.floor(contextWindow * 0.25),
  ));
  const keepRecentTokens = Math.max(512, Math.min(
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    Math.floor(contextWindow * 0.3),
  ));
  return { enabled: true, reserveTokens, keepRecentTokens };
}

function roleOf(message: AgentMessage | undefined): string | undefined {
  return (message as { role?: string } | undefined)?.role;
}

function lastUserIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]) === 'user') return index;
  }
  return -1;
}

/** 单条消息在摘要 prompt 里的估算 token（与 generateSummary 的 serializeConversation 同口径）。 */
function summaryMessageTokens(message: AgentMessage): number {
  return Math.ceil(serializeConversation(plannerMessagesToLlm([message])).length / 4);
}

function summaryChunkTokens(chunk: readonly AgentMessage[]): number {
  return SUMMARY_PROMPT_OVERHEAD_TOKENS + chunk.reduce((total, message) => total + summaryMessageTokens(message), 0);
}

/**
 * 摘要请求的输入预算：窗口 − 摘要输出预留 − 模板余量 − 上一轮摘要。
 * ≤0 表示这个窗口连一次有界摘要都发不出去（异常小的窗口），调用方按失败降解。
 */
function summaryInputAllowance(
  contextWindow: number,
  maxTokens: number,
  previousSummary: string | undefined,
): number {
  const previous = previousSummary ? Math.ceil(previousSummary.length / 4) : 0;
  return contextWindow - maxTokens - SUMMARY_PROMPT_OVERHEAD_TOKENS - previous;
}

/**
 * 切出「摘要前缀 / 保留尾段」。
 * 两条纪律：① 最后一条 user 消息及其之后的内容（当前回合）在装得下时整轮保留；
 * ② 尾段不能以 toolResult 开头——那会把 assistant toolCall 与结果拆散，provider 会拒绝。
 */
function splitForCompaction(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
): { prefix: AgentMessage[]; kept: AgentMessage[] } {
  let start = messages.length;
  let keptTokens = 0;
  while (start > 0 && keptTokens < keepRecentTokens) {
    start -= 1;
    keptTokens += estimateTokens(messages[start]!);
  }
  const lastUser = lastUserIndex(messages);
  // 没有 user 消息的转录（测试夹具/异常持久化）按估算切点即可；真实转录总有当前回合。
  if (lastUser >= 0) {
    const lastTurnTokens = estimateContextTokens(messages.slice(lastUser)).tokens;
    if (lastTurnTokens <= keepRecentTokens) {
      // 当前回合本身装得下：整轮保留，切点不能越过它的 user 消息。
      start = Math.min(start, lastUser);
    } else if (start <= lastUser) {
      // 当前回合太大必须切：至少保留最后一条 user 之后的内容。
      start = lastUser + 1;
    }
  }
  // 尾段不能以 toolResult 开头：那会把 assistant toolCall 与结果拆散，provider 会拒绝。
  while (start > 0 && roleOf(messages[start]) === 'toolResult') start -= 1;
  if (start <= 0) return { prefix: [], kept: [...messages] };
  return { prefix: messages.slice(0, start), kept: messages.slice(start) };
}

/** 取一段装得进 allowance 的前缀分片；单条就超预算时返回它自己，由调用方截断。 */
function takeSummaryChunk(remaining: readonly AgentMessage[], allowance: number): AgentMessage[] {
  const chunk: AgentMessage[] = [];
  let used = SUMMARY_PROMPT_OVERHEAD_TOKENS;
  for (const message of remaining) {
    const cost = summaryMessageTokens(message);
    if (chunk.length > 0 && used + cost > allowance) break;
    chunk.push(message);
    used += cost;
    if (used > allowance) break;
  }
  return chunk;
}

/** 单条消息都比预算大时：摘要只读截断后的文本（只改摘要输入，不改转录）。 */
function clampMessageForSummary(message: AgentMessage, allowance: number): AgentMessage {
  const maxChars = Math.max(0, (allowance - SUMMARY_PROMPT_OVERHEAD_TOKENS) * 4);
  const text = serializeConversation(plannerMessagesToLlm([message]));
  return {
    role: 'user',
    content: `${text.slice(0, maxChars)}\n…（单条消息过长，摘要只读取前 ${maxChars} 字符）`,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * 有界摘要：每一条摘要请求的「输入 + maxTokens」都必须装进模型窗口；
 * 前缀超过单次预算时按 oldest-first 分片、携带上一条摘要续写（不丢中间段）。
 */
async function summarizeWithinWindow(
  prefix: readonly AgentMessage[],
  runtime: PiModelRuntime,
  settings: CompactionSettings,
): Promise<{ ok: true; text: string; chunks: number } | { ok: false; error: string }> {
  const { models, model } = runtime;
  const maxTokens = Math.min(
    Math.floor(0.8 * settings.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let remaining = [...prefix];
  let previous: string | undefined;
  let chunks = 0;
  while (remaining.length > 0) {
    if (chunks >= MAX_SUMMARY_CHUNKS) {
      return { ok: false, error: `摘要分片超过上限 ${MAX_SUMMARY_CHUNKS}（前缀 ${prefix.length} 条）` };
    }
    const allowance = summaryInputAllowance(model.contextWindow, maxTokens, previous);
    // 预算连模板余量都装不下：这个窗口物理上做不了有界摘要（异常小的能力声明）。
    if (allowance <= SUMMARY_PROMPT_OVERHEAD_TOKENS) {
      return { ok: false, error: `摘要输入预算不足（${allowance} ≤ 模板余量）` };
    }
    let chunk = takeSummaryChunk(remaining, allowance);
    if (chunk.length === 0) return { ok: false, error: '摘要分片为空' };
    if (summaryChunkTokens(chunk) > allowance) chunk = [clampMessageForSummary(chunk[0]!, allowance)];
    const summary = await generateSummary(
      plannerMessagesToLlm(chunk), models, model,
      settings.reserveTokens,
      COMPACTION_INSTRUCTIONS,
      previous, undefined, undefined, undefined, BACKGROUND_CONTEXT,
    );
    if (!summary.ok) return { ok: false, error: String(summary.error) };
    previous = summary.value;
    remaining = remaining.slice(chunk.length);
    chunks += 1;
  }
  return { ok: true, text: previous ?? '', chunks };
}

/** 尾段仍超预算时，按整轮从最旧处丢；最后一个 user 消息及其之后永不丢。 */
function trimToBudget(messages: readonly AgentMessage[], target: number): AgentMessage[] {
  let result = [...messages];
  while (result.length > 1 && estimateContextTokens(result).tokens > target) {
    const lastUser = lastUserIndex(result);
    if (lastUser <= 1) break;
    let cut = 1;
    while (cut < lastUser && roleOf(result[cut]) !== 'user') cut += 1;
    result = [result[0]!, ...result.slice(cut)];
  }
  return result;
}

/**
 * 摘要不可用且已经超窗时的确定性降解：丢掉最旧消息、保留最后一条 user 及之后的消息，
 * 并在上下文里显式声明「更早内容已省略」。宁可让本轮基于最近的对话内容作答，也不要
 * 把超窗请求发给模型拿一句零数字兜底。
 */
function degradeByDropping(messages: readonly AgentMessage[], target: number): AgentMessage[] {
  const lastUser = lastUserIndex(messages);
  let kept = messages.slice(lastUser >= 0 ? lastUser : Math.max(0, messages.length - 1));
  while (kept.length > 1 && estimateContextTokens(kept).tokens > target) kept = kept.slice(1);
  const notice = {
    role: 'user',
    content: '【此前的对话因上下文压缩失败已省略】只能依据下面保留下来的最近消息回答；不要编造被省略的内容。',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
  const output = [notice, ...kept];
  console.warn(JSON.stringify({
    event: 'context_compact_degraded',
    tokensBefore: estimateContextTokens([...messages]).tokens,
    tokensAfter: estimateContextTokens(output).tokens,
    dropped: messages.length - kept.length,
  }));
  return output;
}

/**
 * 原生 compact 的宿主侧收敛：阈值判断 → pi 原生摘要 → 保留最近尾段。
 *
 * 为什么是显式函数而不是 createPiTurnDriver 里的一段闭包：压缩产物到底是什么
 * （原生摘要 + 保留尾段，没有第三块宿主声明）必须能用假模型运行时直测——生产调用点
 * 仍然只有 createPiTurnDriver 的 compact 一处，测试直接调这一段生产代码。
 * force:true 跳过阈值判断强制压缩（会话过期软着陆，旧转录压成摘要种子）。
 *
 * 产物纪律：**直接用 pi 原生 compact 的返回值**（摘要消息 + 保留尾段）。宿主不再往产物
 * 里塞自己的块（曾经的"压缩引用索引 sidecar"制造了宿主影子状态：它随每次压缩复利、
 * 要求模型去调用历史检索工具读"更早引用"，而那条工具路径已删除）。
 *
 * T7 起压缩设置随窗口缩放，摘要请求本身有界（见 compactionSettingsFor /
 * summarizeWithinWindow）：贴着窗口的转录也必须能压出「摘要 + 装得下的尾段」。
 */
export async function compactTranscriptWithPi(
  messages: AgentMessage[],
  opts: { force?: boolean } | undefined,
  runtime: PiModelRuntime,
): Promise<AgentMessage[]> {
  const { model } = runtime;
  const settings = compactionSettingsFor(model.contextWindow);
  const est = estimateContextTokens(messages);
  if (!opts?.force && !shouldCompact(est.tokens, model.contextWindow, settings)) return messages;

  let { prefix, kept } = splitForCompaction(messages, settings.keepRecentTokens);
  if (prefix.length === 0 && opts?.force) {
    // 强制压缩（会话过期软着陆）：整段旧转录压成摘要种子，不要求切出保留尾段。
    prefix = [...messages];
    kept = [];
  }
  if (prefix.length === 0) {
    // 全部消息都在当前回合里：没有可摘要的前缀，压缩帮不上忙（不伪造摘要）。
    console.warn(JSON.stringify({
      event: 'context_compact_no_cut',
      tokens: est.tokens,
      contextWindow: model.contextWindow,
      messages: messages.length,
    }));
    return messages;
  }

  const summary = await summarizeWithinWindow(prefix, runtime, settings);
  if (!summary.ok) {
    console.warn(JSON.stringify({
      event: 'context_compact_failed',
      error: summary.error.slice(0, 200),
      tokens: est.tokens,
      contextWindow: model.contextWindow,
      messages: messages.length,
    }));
    if (est.tokens > model.contextWindow) {
      return degradeByDropping(messages, Math.max(1, model.contextWindow - settings.reserveTokens));
    }
    return messages;
  }

  const summaryMessage = {
    role: 'user',
    content: `【此前会话摘要】\n${summary.text}\n(以上为此前对话的压缩摘要;具体数据请以重新调用工具的结果为准;更早的逐字内容已不在上下文中)`,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
  let output = [summaryMessage, ...kept];
  const target = Math.max(1, model.contextWindow - settings.reserveTokens);
  if (estimateContextTokens(output).tokens > target) {
    const trimmed = trimToBudget(output, target);
    console.log(JSON.stringify({
      event: 'context_compact_trimmed',
      tokensBefore: est.tokens,
      tokensAfter: estimateContextTokens(trimmed).tokens,
      removedMessages: output.length - trimmed.length,
    }));
    output = trimmed;
  }
  console.log(JSON.stringify({
    event: 'context_compacted',
    tokensBefore: est.tokens,
    tokensAfter: estimateContextTokens(output).tokens,
    keptMessages: kept.length,
    summaryChunks: summary.chunks,
    contextWindow: model.contextWindow,
  }));
  return output;
}

/** 从 env 构建 kimi 兼容的 pi 驱动;env 缺失在创建时即抛中文错误。 */
export function createPiTurnDriver(options: PiTurnDriverOptions): TurnDriver {
  const modelId = options.modelId ?? options.env.LLM_MODEL ?? '';
  const { models, model } = options.runtime ?? createPiModelRuntime(options.env, modelId, {
    // 能力声明只有显式传入这一条来源：装配层持有配置，驱动不猜、不按模型名查表。
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  });

  // 思考深度(pi 统一抽象):off/minimal/low/medium/high/xhigh/max。
  // 是否生效取决于模型/端点是否支持思考参数;不支持的供应商 pi-ai 静默忽略。
  // 词表与校验在 parsePiThinkingLevel(模块级唯一定义);装配层显式传入时已校验过,
  // 走到 env 回落才在这里报错,错误信息仍指向 LLM_THINKING_LEVEL。
  const thinkingLevel = options.thinkingLevel
    ?? parsePiThinkingLevel(options.env.LLM_THINKING_LEVEL, 'LLM_THINKING_LEVEL');

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const providerToolNames = createProviderToolNameMap(input.tools);
      const tools = input.tools.map((tool) => toAgentTool(
        tool,
        input,
        providerToolNames.get(tool.name)!,
      )) as unknown as AgentTool<any, any>[];
      // 转录即状态:messages 是上一轮持久化的 pi 原生转录(含工具调用与结果),直接续用
      const initialMessages = input.messages;

      const agent = new Agent({
        initialState: {
          systemPrompt: input.systemPrompt,
          model,
          tools,
          messages: initialMessages,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        streamFn: models.streamSimple.bind(models),
        convertToLlm: plannerMessagesToLlm,
        // 回合内应急压缩（T7）：工具循环把上下文推到窗口边缘时，在**下一条模型请求前**
        // 压一次，而不是把超窗请求发出去换一个空回复。正常回合靠回合前压缩，这里只是
        // 兜底；压完的视图装得下就不会在同一回合里反复触发。
        transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
          const tokens = estimateContextTokens(messages).tokens;
          if (tokens <= model.contextWindow - EMERGENCY_OVERFLOW_HEADROOM_TOKENS) return messages;
          console.warn(JSON.stringify({
            event: 'context_emergency_compact',
            tokens,
            contextWindow: model.contextWindow,
            messages: messages.length,
          }));
          return compactTranscriptWithPi(messages, { force: true }, { models, model });
        },
      });

      const remaining = input.deadline - Date.now();
      if (remaining <= 0) return { text: '', messages: agent.state.messages };
      let timedOut = false;
      const abortTimer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, Math.max(1, remaining));

      // 模型瞬时失败：观测（errorMessage 进日志，不再静默吞成空文本）+ 有界重试。
      // pi-agent-core 遇 stopReason=error 正常 return 不抛异常，错误只在 state.errorMessage；
      // 原先主驱动不看它，宿主只看到空文本 → 兜底一句零数字的「查询失败」。两类分流：
      //   · 上下文超限：先压缩（有界摘要）再重发同一条请求；
      //   · 限流/5xx/网络（pi-ai 判据）：原地等一小段再重发。
      // 超时/abort 是宿主自己的收尾事实，不重试。
      let modelAttempt = 0;
      try {
        for (;;) {
          await agent.continue();
          if (timedOut) break;
          const errorMessage = agent.state.errorMessage;
          if (!errorMessage) break;
          console.error(JSON.stringify({
            event: 'pi_driver_model_error',
            attempt: modelAttempt + 1,
            errorMessage: errorMessage.slice(0, 500),
            contextWindow: model.contextWindow,
          }));
          // 剥掉结尾的 error assistant：continue() 只认 user/toolResult 结尾（SDK _prepareRetry 同款）。
          const messages = agent.state.messages;
          const last = messages[messages.length - 1] as { role?: string } | undefined;
          if (last?.role === 'assistant') agent.state.messages = messages.slice(0, -1);
          if (modelAttempt >= MAIN_MODEL_RETRY_DELAYS_MS.length) break;
          if (isContextOverflowError(errorMessage)) {
            const tokensBefore = estimateContextTokens(agent.state.messages).tokens;
            const compacted = await compactTranscriptWithPi(agent.state.messages, { force: true }, { models, model });
            const tokensAfter = estimateContextTokens(compacted).tokens;
            if (tokensAfter >= tokensBefore) break; // 压不动：重发只会再撞同一面墙
            agent.state.messages = compacted;
            console.info(JSON.stringify({
              event: 'pi_driver_context_overflow_recovered',
              attempt: modelAttempt + 1,
              tokensBefore,
              tokensAfter,
              messagesAfter: compacted.length,
              contextWindow: model.contextWindow,
            }));
          } else if (isRetryableAssistantError({ stopReason: 'error', errorMessage } as Parameters<typeof isRetryableAssistantError>[0])) {
            await new Promise((resolve) => setTimeout(resolve, MAIN_MODEL_RETRY_DELAYS_MS[modelAttempt]));
            if (timedOut || Date.now() >= input.deadline) break;
          } else {
            break; // 非瞬时错误：重试无意义
          }
          modelAttempt += 1;
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_driver_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        return { text: '', messages: agent.state.messages };
      } finally {
        clearTimeout(abortTimer);
      }

      // Aborted/error assistant messages may contain a partial streamed answer.
      // Never expose that as a successful response.
      if (timedOut || hasFailedAssistantMessage(agent.state.messages)) {
        const failed = agent.state.messages[agent.state.messages.length - 1] as {
          stopReason?: string;
          errorMessage?: string;
        } | undefined;
        if (!timedOut) {
          console.error(JSON.stringify({
            event: 'pi_driver_failed_assistant',
            stopReason: failed?.stopReason,
            errorMessage: failed?.errorMessage?.slice(0, 500),
            contextWindow: model.contextWindow,
          }));
        }
        return { text: '', messages: agent.state.messages };
      }

      // 取终结文本:最后一条 assistant 的正文;若工具以确定性话术终结(terminate),
      // 最后一条是 toolResult,取其文本
      let text = '';
      for (let i = agent.state.messages.length - 1; i >= 0; i -= 1) {
        const message = agent.state.messages[i] as {
          role?: string;
          content?: unknown;
          stopReason?: string;
        } | undefined;
        if (message?.role === 'assistant') {
          text = textFromContent(message.content);
          if (message.stopReason !== 'stop') text = '';
          break;
        }
        if (message?.role === 'toolResult') {
          text = textFromContent(message.content);
          break;
        }
      }
      if (!text) {
        // 空回复必须留下可归因的形状（下一轮排查不用再靠猜"是不是窗口爆了"）。
        const last = agent.state.messages[agent.state.messages.length - 1] as {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          content?: unknown;
        } | undefined;
        console.warn(JSON.stringify({
          event: 'pi_driver_empty_reply',
          role: last?.role,
          stopReason: last?.stopReason,
          errorMessage: last?.errorMessage?.slice(0, 300),
          contentBlocks: Array.isArray(last?.content)
            ? last.content.map((block) => (block as { type?: string }).type ?? 'unknown')
            : typeof last?.content,
          contextWindow: model.contextWindow,
        }));
      }
      // 只思考没正文：催一次最终文本（一轮一次）。催问作为 user 消息进入转录——
      // 它是本回合真实发生过的一次宿主请求，不是隐藏改写；失败仍走原有空回复兜底。
      if (shouldNudgeFinalReply(agent.state.messages, text) && Date.now() < input.deadline) {
        console.warn(JSON.stringify({ event: 'pi_driver_final_text_nudge', contextWindow: model.contextWindow }));
        agent.state.messages = [
          ...agent.state.messages,
          { role: 'user', content: FINAL_REPLY_NUDGE, timestamp: Date.now() } as unknown as AgentMessage,
        ];
        try {
          await agent.continue();
        } catch (error) {
          console.error(JSON.stringify({
            event: 'pi_driver_final_text_nudge_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }));
        }
        if (!timedOut && !agent.state.errorMessage) {
          const last = agent.state.messages[agent.state.messages.length - 1] as {
            role?: string;
            content?: unknown;
            stopReason?: string;
          } | undefined;
          if (last?.role === 'assistant') {
            text = last.stopReason === 'stop' ? textFromContent(last.content) : '';
          } else if (last?.role === 'toolResult') {
            text = textFromContent(last.content);
          }
        }
        if (!text) {
          console.warn(JSON.stringify({
            event: 'pi_driver_final_text_nudge_empty',
            errorMessage: agent.state.errorMessage?.slice(0, 300),
            contextWindow: model.contextWindow,
          }));
        }
      }
      // 转录交还 runtime 持久化:包含本回合全部用户消息/工具调用/结果
      return { text, messages: agent.state.messages };
    },

    /** 上下文压缩（pi 原生 compact 的宿主侧收敛，实现见 compactTranscriptWithPi）：超阈值时
     *  摘要替换旧消息、保留最近尾巴；失败不阻塞回合。 */
    async compact(messages: AgentMessage[], opts?: { force?: boolean }): Promise<AgentMessage[]> {
      return compactTranscriptWithPi(messages, opts, { models, model });
    },
    // 服务端确定性回复(确认码直执)合成原生形状 assistant 消息,防止毒化下一模型回合
    synthesizeAssistant: (text: string): AgentMessage =>
      toPiMessage({ role: 'assistant', content: text }, modelId),
  };
}

/** 有界历史/当前消息 → pi 的 AgentMessage。assistant 必须带完整内部形状
 *  (api/provider/model/usage),否则 pi-ai 结算 usage 时会崩溃(2026-09-16 实测)。 */
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
 *
 * Domain tools may use names such as `workflow.start`, while OpenAI-compatible
 * function calling only accepts `[A-Za-z0-9_-]{1,64}`.  Keep ordinary names
 * unchanged for backwards-compatible transcripts, and only rewrite names
 * that the provider cannot accept.  The returned map is deliberately one-way:
 * execution always closes over the original discovered tool name.
 */
export function createProviderToolNameMap(tools: readonly DiscoveredTool[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();

  // Reserve names that can be sent unchanged first. This prevents an
  // invalid name such as `workflow.start` from stealing an existing
  // `workflow_start` function name.
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
  // Small deterministic FNV-1a hash; this is only a collision suffix, not a
  // security boundary or identifier exposed to the domain implementation.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function toAgentTool(
  tool: DiscoveredTool,
  input: TurnDriverInput,
  providerName = tool.name,
) {
  return {
    name: providerName,
    label: tool.name,
    description: tool.description,
    // host tools/list 的 inputSchema 是标准 JSON Schema,typebox 兼容该子集;
    // 注入可选 progress 参数:模型可提供一句话意图短语,仅用于进度帧
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
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      // progress 是给进度帧的意图短语,不进工具参数
      const { progress, ...args } = params as Record<string, unknown> & { progress?: unknown };
      const phrase = typeof progress === 'string' ? progress : '';
      // 帧文本由 renderToolStepText 一处合成：内部工具与协议材料复读都不出帧；
      // 返回 null 时静默跳过——空串会在渠道上投出一条空进度帧,比不发帧更糟。
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
            terminate: true,
          };
        }
        throw error;
      }
    },
  };
}

function hasFailedAssistantMessage(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
    if (message?.role === 'assistant') {
      return message.stopReason === 'aborted' || message.stopReason === 'error';
    }
  }
  return false;
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
