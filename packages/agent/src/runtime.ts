/**
 * Agent 运行时(转录即状态)。
 * 会话状态 = 一份完整消息转录(含工具调用与结果),每轮全文进模型;
 * 上下文压缩由 driver.compact(pi 原生 compact)负责;数据准入由 17dz 分页契约负责。
 * TTL 过期不静默清零:旧转录经 compact 压成「摘要+最近尾巴」种子续会话(软着陆,不失忆)。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { loadTranscript, saveTranscript } from './session';
import { NEEDS_LOGIN_MESSAGE, toUserMessage } from './errors';
import { ToolUserError, type TurnDriver } from './driver';
import { createSkillRegistry, READ_SKILL_TOOL, type SkillMetadata, type SkillRegistry } from './skills';
import type { AgentReply, ConversationSessionRepo, DiscoveredResource, DiscoveredTool, HostToolClient, TrustedContext } from '@fshine/contracts';

const DEFAULT_SESSION_TTL_MS = 86_400_000; // 24h:财务助手"上午查账、下午接着问",分钟级 TTL 会造成静默失忆
/** 回合预算:超时 driver 中止并返回空文本 */
const DEFAULT_TURN_BUDGET_MS = 150_000;

export const FALLBACK_TIMEOUT = '查询超时,请稍后再试';
export const FALLBACK_FAILURE = '查询失败,请稍后再试或联系管理员';
/** Deterministic response when this turn's explicit account-set lookup found no match. */
export const ACCOUNT_SET_SEARCH_MISS = '未找到匹配的账套，无法继续查询。请提供完整的账套名称或更具体的名称后重试。';
/** Direct balance/ledger requests must not be answered by scanning vouchers. */
export const READ_KNOWLEDGE_RESOURCE_TOOL = 'read_knowledge_resource';

export interface TaxAgentRuntimeDeps {
  driver: TurnDriver;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
  /** Optional Pi-compatible skill-directory registry. */
  skillRegistry?: SkillRegistry;
}

/** 账套授权 + 工具编排全在工具面内;模型看到的转录就是全部事实。 */
export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): AgentRuntimeShape {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;
  // This is deliberately separate from pi-agent-core.  The service uses the
  // core loop directly, while this registry provides the small part of the Pi
  // coding-agent skill protocol that is useful to a non-interactive service.
  const skillRegistry = deps.skillRegistry ?? createSkillRegistry();

  return {
    async handleTurn(ctx: TrustedContext, userMessage: string, tools: HostToolClient): Promise<AgentReply> {
      const resources = tools.resources?.() ?? [];
      const allowedResourceUris = new Set(resources.map((resource) => resource.uri));
      const skills = await discoverSkillMetadata(skillRegistry);
      const discoveredHostTools = withKnowledgeResourceTool(tools.tools(), resources);
      // 无可用工具 = host 未就绪/无权限:此回合必然无法完成任何查询,尽早收场
      if (discoveredHostTools.length === 0) return { text: FALLBACK_FAILURE };
      const discovered = withSkillTool(discoveredHostTools, skills);

      const { messages: loaded, expired } = await loadTranscript(deps.sessions, ctx.sessionId, sessionTtlMs);
      // 过期软着陆:旧转录压成「摘要+最近尾巴」种子续用,不做静默清零。
      // compact 缺席(如测试驱动)或摘要失败时原样续用——宁可带着旧上下文,也不让用户被失忆。
      let context = loaded;
      if (expired && loaded.length > 0) {
        console.info(JSON.stringify({ event: 'session_resume_seeding', sessionId: ctx.sessionId, staleMessages: loaded.length }));
        context = deps.driver.compact ? await deps.driver.compact(loaded, { force: true }) : loaded;
      }
      // 尺寸治理:超过模型窗口阈值时压缩(compact 内部判断,未超限原样返回)
      if (deps.driver.compact) context = await deps.driver.compact(context);
      context.push({ role: 'user', content: userMessage, timestamp: Date.now() } as unknown as AgentMessage);

      const deadline = Date.now() + turnBudgetMs;
      // 账套定位是本回合的局部事实。搜索明确返回空结果后，禁止模型把历史
      // 转录里的 accountSetId 当作本轮新账套继续查询；若模型改用新的查询词
      // 重新搜索并命中，则解除此保护。这样保留历史上下文，同时避免串账套。
      let accountSetSearchMiss = false;
      const result = await deps.driver.run({
        systemPrompt: SYSTEM_PROMPT(discovered, skills),
        tools: discovered,
        messages: context,
        onStep: ctx.onStep ?? (() => {}),
        exec: async (tool, args, signal) => {
          if (accountSetSearchMiss && hasAccountSetId(args)) {
            throw new ToolUserError('本轮搜索未找到匹配账套，不能沿用历史账套。请提供正确的账套名称或更具体的名称后重试。');
          }
          if (tool === READ_KNOWLEDGE_RESOURCE_TOOL) {
            const uri = args['uri'];
            if (typeof uri !== 'string') throw new ToolUserError('知识资源 URI 无效。');
            if (!allowedResourceUris.has(uri)) throw new ToolUserError('该知识资源未被当前数据源声明或授权。');
            if (!tools.readResource) throw new ToolUserError('当前数据源不支持读取知识资源。');
            const resource = await tools.readResource(uri, signal);
            if (!resource.ok) throw new ToolUserError(toUserMessage(resource.error));
            return resource.data;
          }
          if (tool === READ_SKILL_TOOL) {
            const name = args['name'];
            if (typeof name !== 'string' || !skills.some((skill) => skill.name === name)) {
              throw new ToolUserError('该技能未被当前运行时发现或授权。');
            }
            try {
              const skill = await skillRegistry.read(name);
              return skill.content;
            } catch (error) {
              throw new ToolUserError(error instanceof Error ? `技能读取失败:${error.message}` : '技能读取失败。');
            }
          }
          const outcome = await tools.call(tool, args, signal);
          if (!outcome.ok) throw new ToolUserError(toUserMessage(outcome.error));
          if (tool === 'search_account_sets') {
            accountSetSearchMiss = isEmptyAccountSetSearch(outcome.data);
          }
          return outcome.data;
        },
        deadline,
      });

      await saveTranscript(deps.sessions, {
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
        messages: result.messages,
      });

      // A model may stop calling tools after an empty lookup and still compose
      // an answer from historical tool results.  That is unsafe: an empty
      // search is a hard boundary for this turn, not merely a hint to the
      // model.  Override any such stale-context answer deterministically.
      if (accountSetSearchMiss && result.text.trim()) return { text: ACCOUNT_SET_SEARCH_MISS };

      if (!result.text.trim()) {
        const reason = Date.now() >= deadline ? 'turn_timeout' : 'empty_reply';
        console.info(JSON.stringify({ event: 'fallback_reply', requestId: ctx.requestId, reason }));
        return { text: Date.now() >= deadline ? FALLBACK_TIMEOUT : FALLBACK_FAILURE };
      }
      return { text: result.text };
    },
  };
}

type AgentRuntimeShape = import('@fshine/contracts').AgentRuntime;

/** 系统提示:身份 + 工具面 + 纪律规则。规则全部对应实测故障,勿随意删除。 */
function SYSTEM_PROMPT(
  tools: readonly { name: string; description: string; inputSchema: unknown }[],
  skills: readonly SkillMetadata[] = [],
): string {
  const toolLines = tools
    .map((tool) => `- ${tool.name}:${tool.description};inputSchema=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');
  return [
    '你是企业财务助手。可用工具决定当前权限；不能编造数据或绕过工具权限。',
    '你绝不编造数据,所有回答只能基于本轮与历史中的工具结果;涉及当前数据的问题必须重新调用工具查询,不得仅凭历史对话作答。',
    '',
    '可用工具(名称、描述、inputSchema 的紧凑 JSON):',
    toolLines,
    '',
    skillPrompt(skills),
    '',
    '回答规则:',
    '- 数据回复必须带上所用账套名称、会计期间(如使用)与数据来源。',
    '- accountSetId 只能使用工具返回的 as_xxx 原值,严禁用账套名称代替或编造。',
    '- 用户本轮明确提到账套名称时,必须先调用 search_account_sets 定位;若返回空 accountSets,必须停止查询并请用户补充或更正账套名称,严禁沿用历史账套 ID 调用其他工具。只有用户明确说“刚才那个/这个账套”等指代时才可复用历史账套。',
    '- list_vouchers 结果含 nextCursor 时,告知用户可回复"下一页"继续;用户说"下一页"时把 nextCursor 原样传入 cursor 参数,说"上一页"时把 prevCursor 原样传入;已在第一页则如实说明。',
    '- 工具结果出现 NEEDS_LOGIN 时,回复:"' + NEEDS_LOGIN_MESSAGE + '"',
    '- 始终使用简体中文回复。',
  ].join('\n');
}

async function discoverSkillMetadata(registry: SkillRegistry): Promise<readonly SkillMetadata[]> {
  try {
    return await registry.discover();
  } catch (error) {
    // A broken optional skill must not take down a data-query turn.  The
    // registry itself remains responsible for strict read-time containment.
    console.warn(JSON.stringify({
      event: 'skill_discovery_failed',
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    }));
    return [];
  }
}

function skillPrompt(skills: readonly SkillMetadata[]): string {
  if (skills.length === 0) return '可用技能:无。';
  const lines = skills.map((skill) => `- ${skill.name}:${skill.description}`);
  return [
    '可用技能(只提供领域指令，不是事实数据):',
    ...lines,
    `需要使用某项技能时，必须调用 ${READ_SKILL_TOOL} 并传入精确的 name；不要猜测未列出的技能。`,
  ].join('\n');
}

function hasAccountSetId(args: Record<string, unknown>): boolean {
  return typeof args['accountSetId'] === 'string' && args['accountSetId'].trim() !== '';
}

function isEmptyAccountSetSearch(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const accountSets = (data as { accountSets?: unknown }).accountSets;
  return Array.isArray(accountSets) && accountSets.length === 0;
}

/**
 * Resources are exposed to the model as one constrained virtual tool. The
 * URI enum is built from the host's already-filtered resources, while the
 * host still re-checks the URI at read time. This keeps resource access
 * discoverable without granting the model arbitrary resources/read access.
 */
function withKnowledgeResourceTool(
  tools: readonly DiscoveredTool[],
  resources: readonly DiscoveredResource[],
): readonly DiscoveredTool[] {
  if (resources.length === 0 || tools.some((tool) => tool.name === READ_KNOWLEDGE_RESOURCE_TOOL)) return tools;
  const uris = [...new Set(resources.map((resource) => resource.uri).filter((uri) => uri.trim() !== ''))];
  if (uris.length === 0) return tools;
  return [
    ...tools,
    {
      name: READ_KNOWLEDGE_RESOURCE_TOOL,
      description: '读取当前 MCP 已发现且已授权的知识资源。只能使用下列 URI；资源由数据源维护，读取后再按其契约调用相关工具。',
      inputSchema: {
        type: 'object',
        required: ['uri'],
        additionalProperties: false,
        properties: {
          uri: { type: 'string', enum: uris },
        },
      },
    },
  ];
}

/**
 * Expose skill metadata and a constrained virtual reader to Pi.  The model
 * never receives a filesystem path; runtime.exec validates the name again and
 * the registry performs the final realpath containment check before reading.
 */
function withSkillTool(
  tools: readonly DiscoveredTool[],
  skills: readonly SkillMetadata[],
): readonly DiscoveredTool[] {
  if (skills.length === 0 || tools.some((tool) => tool.name === READ_SKILL_TOOL)) return tools;
  return [
    ...tools,
    {
      name: READ_SKILL_TOOL,
      description: '按名称读取当前运行时已发现且已授权的 SKILL.md 领域指令。只能使用技能目录中列出的 name。',
      inputSchema: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', enum: skills.map((skill) => skill.name) },
        },
      },
    },
  ];
}
