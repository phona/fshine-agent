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
import type { DiscoveredTool, McpToolName } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { defaultStepText } from './step-text';

const IDLE_TIMEOUT_MS = 90_000; // 流式空闲超时:每收到一个 chunk(含 reasoning 增量)即重置
const OVERALL_TIMEOUT_MS = 300_000; // 单次模型调用总上限(兜底,正常由回合预算约束)
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
      const names = new Map<string, string>();
      const tools = input.tools.map((tool) => toAgentTool(tool, input, names)) as unknown as AgentTool<any, any>[];
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
        toolExecution: 'sequential',
      });

      const remaining = Math.max(1_000, input.deadline - Date.now());
      let timedOut = false;
      const abortTimer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, remaining);

      try {
        await agent.continue();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_driver_error',
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
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
        '这是财务查询助手的会话压缩。摘要必须保留:1)当前使用的账套 id(as_xxx)与名称;2)会计期间;3)最近一次 list_vouchers 结果里的 nextCursor/prevCursor 原值(用户要靠它翻页);4)用户的关键业务意图与未决问题;5)已得出的中间结论与未完成的步骤(长任务靠它续跑)。',
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

function toAgentTool(
  tool: DiscoveredTool,
  input: TurnDriverInput,
  names: Map<string, string>,
) {
  return {
    name: tool.name,
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
            '一句话说明你即将做什么(≤60 字),作为给用户看的进度提示;只许描述即将进行的动作,严禁包含任何结果数字',
        },
      },
    }),
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      // progress 是给进度帧的意图短语,不进工具参数
      const { progress, ...args } = params as Record<string, unknown> & { progress?: unknown };
      const phrase = typeof progress === 'string' ? progress : '';
      input.onStep(phrase || defaultStepText(tool.name, args, names));
      try {
        const data = await input.exec(tool.name as McpToolName, args, signal);
        rememberAccountSets(tool.name, data, names);
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

function rememberAccountSets(
  toolName: string,
  data: unknown,
  names: Map<string, string>,
): void {
  if (toolName !== 'search_account_sets' || !data || typeof data !== 'object') return;
  const accountSets = (data as { accountSets?: unknown }).accountSets;
  if (!Array.isArray(accountSets)) return;
  for (const item of accountSets) {
    const record = item as { id?: unknown; name?: unknown };
    if (typeof record.id === 'string' && typeof record.name === 'string') {
      names.set(record.id, record.name);
    }
  }
}

function defaultStep(
  toolName: string,
  args: Record<string, unknown>,
  names: Map<string, string>,
): string {
  const accountSetId = typeof args['accountSetId'] === 'string' ? args['accountSetId'] : '';
  const name = accountSetId !== '' ? names.get(accountSetId) ?? accountSetId : '';
  switch (toolName) {
    case 'search_account_sets': {
      const query = typeof args['query'] === 'string' ? args['query'].slice(0, 30) : '';
      return `正在检索账套:${query}…`;
    }
    case 'get_current_accounting_period':
      return name ? `已定位账套「${name}」,查询当前会计期间…` : '查询当前会计期间…';
    case 'list_vouchers': {
      const period = typeof args['period'] === 'string' ? args['period'] : '';
      return name ? `拉取凭证:「${name}」${period}…` : '拉取凭证中…';
    }
    case 'inspect_account_set':
      return name ? `正在做账套「${name}」摸底…` : '正在做账套摸底…';
    case 'get_login_status':
      return '检查平台登录状态…';
    default:
      return `正在调用 ${toolName}…`;
  }
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
