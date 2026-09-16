/**
 * tax-agent 运行时:JSON 行为协议 + 只读工具循环 + 会话澄清/翻页状态。
 * 只依赖 contracts 接口(host 的 HostToolClient 真实现由 mcp-host 提供)。
 */
import type {
  AgentReply,
  AgentRuntime,
  ConversationSessionRepo,
  DiscoveredTool,
  HostToolClient,
  ReadToolName,
  ToolOutcome,
  TrustedContext,
} from '@fshine/contracts';
import { NEEDS_LOGIN_MESSAGE, toUserMessage } from './errors';
import type { ChatModel, ChatModelMessage } from './model';
import {
  extractAccountSetList,
  extractNextCursor,
  appendTurnHistory,
  freshPendingCandidates,
  loadSessionState,
  matchPendingCandidate,
  saveSessionState,
  type AgentSessionState,
  type PendingCandidate,
} from './session';

export const FALLBACK_MISUNDERSTOOD = '抱歉,我没有理解这个问题,请换个说法';
export const FALLBACK_TIMEOUT = '查询超时,请稍后再试';
export const FALLBACK_FAILURE = '查询失败,请稍后再试或联系管理员';
export const NO_ACCOUNT_SET_MESSAGE = '没有找到该账套';

const CORRECTION_MESSAGE =
  '你的上一条输出不符合约定:必须只输出一个 JSON 对象,前后不能有任何其他文字。只有两种合法形式:\n'
  + '{"action":"call","tool":"<工具名>","args":{...}}\n'
  + '{"action":"reply","text":"<你想对用户说的话>"}\n'
  + '请把你刚才想对用户说的话,原封不动地放进 {"action":"reply","text":"..."} 的 text 字段里,只输出这一个 JSON 对象。';

const NEXT_PAGE_PATTERN = /下一页|还有吗|还有更多|再来一页|继续/;

const DEFAULT_SESSION_TTL_MS = 300_000;
/** 回合预算:进度帧让等待可感知,不再需要黑盒式硬限;LLM 单次超时 120s × 最多 6 步,靠预算截断 */
const DEFAULT_TURN_BUDGET_MS = 150_000;
const DEFAULT_MAX_STEPS = 6;
/** 工具结果进模型上下文前的保险裁剪上限(JSON 字符数) */
const RESULT_CLIP_LIMIT = 6_000;

type OkToolOutcome = Extract<ToolOutcome, { ok: true }>;

type ModelAction =
  | { kind: 'reply'; text: string }
  | { kind: 'call'; tool: ReadToolName; args: Record<string, unknown>; /** 模型可选的意图短语(≤60 字),仅用于进度帧,不许报结果 */ progress?: string };

/** 进度帧默认模板:埋点事实渲染,开发者为每个工具维护一条(协议 §6.2) */
function defaultStepText(
  tool: ReadToolName,
  args: Record<string, unknown>,
  accountSetNames: ReadonlyMap<string, string>,
): string {
  const accountSetId = typeof args['accountSetId'] === 'string' ? args['accountSetId'] : '';
  const name = accountSetId !== '' ? accountSetNames.get(accountSetId) ?? accountSetId : '';
  switch (tool) {
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
  }
}

/** 模型意图短语sanitize:去换行、压空白、截断到 60 字(只许说意图,长度可控) */
function sanitizeProgress(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned !== '' ? cleaned : undefined;
}

type CompletionResult =
  | { kind: 'action'; action: ModelAction }
  | { kind: 'misunderstood' }
  | { kind: 'budget-exceeded' };

export interface TaxAgentRuntimeDeps {
  model: ChatModel;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
  maxSteps?: number;
}

export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): AgentRuntime {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

  return {
    async handleTurn(ctx: TrustedContext, userMessage: string, tools: HostToolClient): Promise<AgentReply> {
      const discovered = tools.tools();
      // 工具清单为空 = host 连接未就绪/无可用工具:此回合必然无法完成任何查询,
      // 尽早用准确的失败话术收场,而不是让模型在没有工具的对话里空转
      if (discovered.length === 0) return { text: FALLBACK_FAILURE };
      const loaded = await loadSessionState(deps.sessions, ctx.sessionId);
      const state = loaded.state;
      try {
        const reply = await runTurn(ctx, userMessage, tools, state);
        // 有界历史重放的数据来源:仅用户消息与最终回复(工具结果不重放)
        state.history = appendTurnHistory(state.history, userMessage, reply.text);
        return reply;
      } finally {
        await saveSessionState(deps.sessions, ctx.sessionId, ctx.principalId, state, loaded.record);
      }
    },
  };

  async function runTurn(
    ctx: TrustedContext,
    userMessage: string,
    tools: HostToolClient,
    state: AgentSessionState,
  ): Promise<AgentReply> {
    const deadline = Date.now() + turnBudgetMs;
    const system = buildSystemPrompt(tools.tools());
    // 只读策略:模型只能调用 tools/list 发现的工具,其余一律按协议违规处理
    const knownTools = new Set<string>(tools.tools().map((tool) => tool.name));
    const knownAccountSets = new Map<string, string>();
    const messages: ChatModelMessage[] = [];
    // 有界历史重放:仅用户消息与最终回复,供追问/指代参考;以最新用户消息为当前任务
    for (const entry of state.history ?? []) {
      messages.push({ role: entry.role, content: entry.content });
    }

        // 1) 澄清候选命中:以所选账套 + 用户原始请求继续,清候选
        const pending = freshPendingCandidates(state);
        const selected = pending.length > 0 ? matchPendingCandidate(userMessage, pending) : null;
        if (selected) {
          // 还原意图:候选是上一轮澄清留下的,最初的请求文本存在 pendingRequest 里
          const originalRequest = state.pendingRequest ?? userMessage;
          state.pendingCandidates = undefined;
          state.expiresAt = undefined;
          state.pendingRequest = undefined;
          knownAccountSets.set(selected.id, selected.name);
          ctx.onStep?.(`已选定账套「${selected.name}」,继续查询…`);
          messages.push({
            role: 'user',
            content: `用户此前提出请求:「${originalRequest}」,刚从候选中选定账套「${selected.name}」(accountSetId: ${selected.id})。请围绕该账套继续处理该请求,直至给出最终答复。`,
          });
        } else if (state.lastVoucherQuery?.nextCursor && NEXT_PAGE_PATTERN.test(userMessage)) {
          // 2) 翻页快捷路径:直接用上一页游标续查,不经模型决策
          const last = state.lastVoucherQuery;
          knownAccountSets.set(last.accountSetId, last.accountSetName);
          ctx.onStep?.(`翻页拉取凭证:「${last.accountSetName}」${last.period}…`);
          if (Date.now() >= deadline) return { text: FALLBACK_TIMEOUT };
          const outcome = await tools.call('list_vouchers', {
            accountSetId: last.accountSetId,
            period: last.period,
            cursor: last.nextCursor,
          });
          if (!outcome.ok) return { text: toUserMessage(outcome.error) };
          recordListVoucherQuery(state, knownAccountSets, last.accountSetId, last.period, outcome);
          messages.push({ role: 'user', content: userMessage });
          messages.push({ role: 'assistant', content: toolResultMessage('list_vouchers', outcome) });
        } else {
          messages.push({ role: 'user', content: userMessage });
        }

        // 3) 协议循环:每轮一个 JSON 动作,最多 maxSteps 轮
        for (let step = 0; step < maxSteps; step += 1) {
          if (Date.now() >= deadline) return { text: FALLBACK_TIMEOUT };
          let result: CompletionResult;
          try {
            result = await completeWithCorrection(deps.model, system, messages, knownTools, deadline);
          } catch (error) {
            if (error instanceof ModelUnavailableError) return { text: FALLBACK_FAILURE };
            throw error;
          }
          if (result.kind === 'misunderstood') return { text: FALLBACK_MISUNDERSTOOD };
          if (result.kind === 'budget-exceeded') return { text: FALLBACK_TIMEOUT };
          const action = result.action;
          if (action.kind === 'reply') return { text: action.text };

          if (Date.now() >= deadline) return { text: FALLBACK_TIMEOUT };
          // 进度埋点:模型意图短语优先,否则默认模板(只说即将做什么,事实帧由 host 重试/超时负责)
          ctx.onStep?.(action.progress ?? defaultStepText(action.tool, action.args, knownAccountSets));
          const outcome = await tools.call(action.tool, action.args);
          if (!outcome.ok) return { text: toUserMessage(outcome.error) };

          if (action.tool === 'search_account_sets') {
            const candidates = extractAccountSetList(outcome.data);
            for (const candidate of candidates) knownAccountSets.set(candidate.id, candidate.name);
            if (candidates.length === 0) {
              state.pendingCandidates = undefined;
              state.expiresAt = undefined;
              state.pendingRequest = undefined;
              return { text: NO_ACCOUNT_SET_MESSAGE };
            }
            if (candidates.length > 1) {
              state.pendingCandidates = candidates.map((candidate) => ({ id: candidate.id, name: candidate.name }));
              state.expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
              // 记住触发澄清的原始请求:用户选定候选后据此还原意图
              state.pendingRequest = userMessage;
            }
          } else if (action.tool === 'list_vouchers') {
            recordListVoucherQuery(
              state,
              knownAccountSets,
              stringArg(action.args, 'accountSetId'),
              stringArg(action.args, 'period'),
              outcome,
            );
          }

          messages.push({ role: 'assistant', content: toolResultMessage(action.tool, outcome) });
        }
        return { text: FALLBACK_MISUNDERSTOOD };
      }
}

// ---- 模型调用与协议解析 ----

/** 模型输出非法时补纠偏 user 消息(最多 2 次);仍失败返回 misunderstood。 */
async function completeWithCorrection(
  model: ChatModel,
  system: string,
  messages: ChatModelMessage[],
  knownTools: ReadonlySet<string>,
  deadline: number,
): Promise<CompletionResult> {
  const callModel = async (): Promise<string> => {
    try {
      return await model.complete({ system, messages });
    } catch (error) {
      // 模型基础设施故障:对用户统一安全话术;但必须留痕,否则"查询失败"无法归因
      console.error(JSON.stringify({
        event: 'model_complete_failed',
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }));
      throw new ModelUnavailableError();
    }
  };

  let output = await callModel();
  // 最多纠偏 2 次(推理型模型偶发先用普通文本作答,需要多次拉回协议)
  for (let round = 0; round <= 2; round += 1) {
    const action = parseModelAction(output, knownTools);
    if (action) return { kind: 'action', action };
    // 留痕:协议失败的原因排查靠这段原始输出
    console.error(JSON.stringify({ event: 'model_parse_failed', round, output: output.slice(0, 300) }));
    if (round === 2 || Date.now() >= deadline) break;
    messages.push({ role: 'user', content: CORRECTION_MESSAGE });
    output = await callModel();
  }
  return { kind: 'misunderstood' };
}

/** 内部标记:模型不可用(调用方统一转安全话术) */
class ModelUnavailableError extends Error {
  constructor() {
    super('model unavailable');
    this.name = 'ModelUnavailableError';
  }
}

function parseModelAction(raw: string, knownTools: ReadonlySet<string>): ModelAction | null {
  const json = extractJsonObject(raw);
  if (json !== null) {
    const action = actionFromJson(json, knownTools);
    if (action) return action;
  }
  // 宽限:模型在 JSON 前后夹了叙述文字导致整体不可解析时,定位 {"action" 起始再试
  const tagIndex = raw.indexOf('{"action"');
  if (tagIndex >= 0) {
    const end = raw.lastIndexOf('}');
    if (end > tagIndex) {
      return actionFromJson(raw.slice(tagIndex, end + 1), knownTools);
    }
  }
  return null;
}

function actionFromJson(json: string, knownTools: ReadonlySet<string>): ModelAction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.action === 'reply') {
    const text = obj.text;
    return typeof text === 'string' && text.trim().length > 0 ? { kind: 'reply', text } : null;
  }
  if (obj.action === 'call') {
    const tool = obj.tool;
    const args = obj.args;
    if (typeof tool !== 'string' || !knownTools.has(tool)) return null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const progress = sanitizeProgress(obj.progress);
    return {
      kind: 'call',
      tool: tool as ReadToolName,
      args: args as Record<string, unknown>,
      ...(progress ? { progress } : {}),
    };
  }
  return null;
}

function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// ---- 工具结果摘要 ----

function toolResultMessage(tool: ReadToolName, outcome: OkToolOutcome): string {
  const summary = clipJson({ ok: true, data: outcome.data, meta: outcome.meta });
  return `{"tool":"${tool}","result":${summary}}`;
}

function clipJson(value: unknown, limit: number = RESULT_CLIP_LIMIT): string {
  const raw = JSON.stringify(value) ?? 'null';
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}……[结果过长已截断]`;
}

function recordListVoucherQuery(
  state: AgentSessionState,
  knownAccountSets: ReadonlyMap<string, string>,
  accountSetId: string,
  period: string,
  outcome: OkToolOutcome,
): void {
  if (!accountSetId) return;
  const nextCursor = extractNextCursor(outcome.data);
  state.lastVoucherQuery = {
    accountSetId,
    accountSetName: outcome.meta.accountSetName ?? knownAccountSets.get(accountSetId) ?? '',
    period,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

// ---- system 提示 ----

function buildSystemPrompt(tools: readonly DiscoveredTool[]): string {
  const toolLines = tools
    .map((tool) => `- ${tool.name}:${tool.description};inputSchema=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');
  return [
    '你是一个企业财务数据查询助手,只读,绝不执行或承诺任何写入、修改操作。',
    '你绝不编造数据,所有回答只能基于工具返回的结果。',
    '',
    '可用工具(名称、描述、inputSchema 的紧凑 JSON):',
    toolLines,
    '',
    '输出协议(必须严格遵守):每一轮你只能输出一个 JSON 对象,不得包含任何其他文字或代码块标记:',
    '- 需要调用工具时:{"action":"call","tool":"<工具名>","args":{...},"progress":"<可选:一句话说明你即将做什么,≤60字,给用户看的进度提示;只许描述即将进行的动作,严禁出现任何结果数字>"}',
    '- 给出最终回答时:{"action":"reply","text":"<给用户的回复>"}',
    '',
    '对话中 role 为 assistant 且含 "tool" 字段的消息,是你此前工具调用的结果摘要(JSON);其中 meta.source 是数据来源,meta.retrievedAt 是取回时间。',
    '',
    '回答规则:',
    '- 数据回复必须带上所用账套名称、会计期间(如使用)、数据来源(meta.source)与取回时间(meta.retrievedAt)。',
    '- search_account_sets 返回多个候选账套时,必须以编号列表列出全部候选让用户选择,不得自行猜测;只返回一个候选时直接采用;没有候选时明确告知用户没有找到。',
    '- list_vouchers 结果含 nextCursor 时,必须告知用户"还有更多,回复\'下一页\'继续"。',
    '- list_vouchers 首次查询不要传任何分页参数(默认首页);只有用户要看后续页时才用上一页结果里的 nextCursor,不要自行传 pageNo。',
    '- 始终使用简体中文回复。',
    '- 对话开头的「历史消息」仅供上下文参考;请以最新一条用户消息为当前任务,不要重复回答历史里已经回答过的问题。',
    '- 提及 accountSetId、期间、凭证号等标识时,只能使用工具结果中出现的原值,严禁编造;历史或工具结果中没有的标识,不要提及。',
    '- 对话开头的「历史消息」仅供上下文参考;请以最新一条用户消息为当前任务,不要重复回答历史里已经回答过的问题。',
    `- 工具结果出现 NEEDS_LOGIN 时,回复:"${NEEDS_LOGIN_MESSAGE}"`,
  ].join('\n');
}

export type { PendingCandidate, AgentSessionState };
