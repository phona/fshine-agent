/**
 * PiTurnDriver:基于 pi.dev 生态(@earendil-works/pi-agent-core + pi-ai)的回合驱动。
 * 模型走原生 function calling(无自定义 JSON 协议);流式响应;空闲超时。
 * 事实类进度(重试等)由 host 钩子负责;工具级进度在本驱动的 execute 内渲染。
 */
import { Agent, type AgentTool, DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, estimateTokens, generateSummary, shouldCompact, type AgentMessage } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { Type } from 'typebox';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { renderToolStepText } from './step-text';

const IDLE_TIMEOUT_MS = 90_000; // 流式空闲超时:每收到一个 chunk(含 reasoning 增量)即重置
const OVERALL_TIMEOUT_MS = 300_000; // 单次模型调用总上限(兜底,正常由回合预算约束)
const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
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

export interface PiTurnDriverOptions {
  env: Record<string, string | undefined>;
}

/** 从 env 构建 kimi 兼容的 pi 模型集合;env 缺失在创建时即抛中文错误。 */
export function createPiTurnDriver(options: PiTurnDriverOptions): TurnDriver {
  const baseUrl = (options.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = options.env.LLM_API_KEY;
  const modelId = options.env.LLM_MODEL ?? '';
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

  // 思考深度(pi 统一抽象):off/minimal/low/medium/high/xhigh/max。
  // 是否生效取决于模型/端点是否支持思考参数;不支持的供应商 pi-ai 静默忽略。
  const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const thinkingLevelRaw = options.env.LLM_THINKING_LEVEL ?? '';
  if (thinkingLevelRaw !== '' && !THINKING_LEVELS.has(thinkingLevelRaw)) {
    throw new Error(`环境变量 LLM_THINKING_LEVEL 无效:${thinkingLevelRaw}(可选 off/minimal/low/medium/high/xhigh/max)`);
  }
  const thinkingLevel = (thinkingLevelRaw || undefined) as
    | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    | undefined;

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
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
  const provider = createProvider({
    id: 'llm',
    name: 'LLM',
    baseUrl,
    auth: { apiKey: envApiKeyAuth('LLM API key', ['LLM_API_KEY']) },
    models: [kimiModel],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel('llm', modelId);
  if (!model) throw new Error(`LLM 模型 ${modelId} 注册失败`);

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
      });

      const remaining = input.deadline - Date.now();
      if (remaining <= 0) return { text: '', messages: agent.state.messages };
      let timedOut = false;
      const abortTimer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, Math.max(1, remaining));

      try {
        await agent.continue();
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
      // 转录交还 runtime 持久化:包含本回合全部用户消息/工具调用/结果
      return { text, messages: agent.state.messages };
    },

    /** 上下文压缩(pi 原生 compact):超阈值时摘要替换旧消息,保留最近尾巴。失败不阻塞回合。
     *  force:true 跳过阈值判断强制压缩(会话过期软着陆,旧转录压成摘要种子)。 */
    async compact(messages: AgentMessage[], opts?: { force?: boolean }): Promise<AgentMessage[]> {
      const est = estimateContextTokens(messages);
      if (!opts?.force && !shouldCompact(est.tokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return messages;
      const summary = await generateSummary(
        messages, models, model,
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        '这是助手会话的压缩。摘要必须保留:1)当前正在处理的对象标识与名称;2)当前的时间范围;3)最近一次工具结果里的分页游标原值(用户要靠它翻页);4)用户的关键意图与未决问题;5)已得出的中间结论与未完成的步骤(长任务靠它续跑)。',
        undefined, undefined, undefined, undefined, BACKGROUND_CONTEXT,
      );
      if (!summary.ok) {
        console.warn(JSON.stringify({ event: 'context_compact_failed', error: String(summary.error).slice(0, 200) }));
        return messages;
      }
      const kept: AgentMessage[] = [];
      let keptTokens = 0;
      for (let i = messages.length - 1; i >= 0 && keptTokens < DEFAULT_COMPACTION_SETTINGS.keepRecentTokens; i -= 1) {
        kept.unshift(messages[i]!);
        keptTokens += estimateTokens(messages[i]!);
      }
      console.log(JSON.stringify({ event: 'context_compacted', tokensBefore: est.tokens, keptMessages: kept.length }));
      return [
        { role: 'user', content: `【此前会话摘要】\n${summary.value}\n(以上为此前对话的压缩摘要;具体数据请以重新调用工具的结果为准)`, timestamp: Date.now() } as unknown as AgentMessage,
        ...kept,
      ];
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
            details: {},
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
