/**
 * tax-agent 运行时:会话状态机(澄清/翻页/历史)+ TurnDriver 驱动的模型回合。
 * 模型交互(原生 function calling、流式、超时)由 TurnDriver 实现——
 * 生产用 pi-driver(pi-agent-core + pi-ai),测试用 ScriptedTurnDriver。
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
import { ToolUserError, type TurnDriver } from './driver';
import {
  appendTurnHistory,
  extractAccountSetList,
  extractNextCursor,
  freshPendingCandidates,
  loadSessionState,
  matchPendingCandidate,
  saveSessionState,
  type AgentSessionState,
  type PendingCandidate,
} from './session';

export const FALLBACK_TIMEOUT = '查询超时,请稍后再试';
export const FALLBACK_FAILURE = '查询失败,请稍后再试或联系管理员';

const NEXT_PAGE_PATTERN = /下一页|还有吗|还有更多|再来一页|继续/;

const DEFAULT_SESSION_TTL_MS = 300_000;
/** 回合预算:进度帧让等待可感知,不再需要黑盒式硬限;超时最终帧仍会收场 */
const DEFAULT_TURN_BUDGET_MS = 150_000;

export interface TaxAgentRuntimeDeps {
  driver: TurnDriver;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
}

export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): AgentRuntime {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;

  return {
    async handleTurn(ctx: TrustedContext, userMessage: string, tools: HostToolClient): Promise<AgentReply> {
      const discovered = tools.tools();
      // 工具清单为空 = host 连接未就绪/无可用工具:此回合必然无法完成任何查询,
      // 尽早用准确的失败话术收场,而不是让模型在没有工具的对话里空转
      if (discovered.length === 0) return { text: FALLBACK_FAILURE };
      const loaded = await loadSessionState(deps.sessions, ctx.sessionId);
      const state = loaded.state;
      try {
        const deadline = Date.now() + turnBudgetMs;
        const reply = await runTurn(ctx, userMessage, tools, state, deps.driver, deadline, sessionTtlMs);
        // 有界历史重放的数据来源:仅用户消息与最终回复(工具结果不重放)
        state.history = appendTurnHistory(state.history, userMessage, reply.text);
        return reply;
      } finally {
        await saveSessionState(deps.sessions, ctx.sessionId, ctx.principalId, state, loaded.record);
      }
    },
  };
}

async function runTurn(
  ctx: TrustedContext,
  userMessage: string,
  tools: HostToolClient,
  state: AgentSessionState,
  driver: TurnDriver,
  deadline: number,
  sessionTtlMs: number,
): Promise<AgentReply> {
  const knownAccountSets = new Map<string, string>();
  const messages = buildMessages(state, userMessage, knownAccountSets, ctx, sessionTtlMs);

  const exec = async (tool: ReadToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const outcome = await tools.call(tool, args, signal);
    if (!outcome.ok) throw new ToolUserError(toUserMessage(outcome.error));
    noteToolResult(tool, args, outcome, state, knownAccountSets, userMessage, sessionTtlMs);
    return outcome.data;
  };

  const { text } = await driver.run({
    systemPrompt: buildSystemPrompt(tools.tools()),
    tools: tools.tools(),
    messages,
    onStep: ctx.onStep ?? (() => {}),
    exec,
    deadline,
  });

  if (text.trim() === '') {
    // driver 未能产出回复:超时(abort)与环境异常(模型/网络)分别归因
    return { text: Date.now() >= deadline ? FALLBACK_TIMEOUT : FALLBACK_FAILURE };
  }
  return { text };
}

/** 组装本轮模型上下文:有界历史重放 + 开场消息(澄清还原 / 翻页 / 原样) */
function buildMessages(
  state: AgentSessionState,
  userMessage: string,
  knownAccountSets: Map<string, string>,
  ctx: TrustedContext,
  sessionTtlMs: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const entry of state.history ?? []) {
    messages.push({ role: entry.role, content: entry.content });
  }

  // 开场消息三形态:澄清选中 / 翻页快捷 / 普通
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
      content: `用户此前提出请求:「${originalRequest}」,刚从候选中选定账套「${selected.name}」(accountSetId: ${selected.id})。请调用工具继续处理该请求,直至给出最终答复。`,
    });
    return messages;
  }
  if (state.lastVoucherQuery?.nextCursor && NEXT_PAGE_PATTERN.test(userMessage)) {
    // 翻页:游标在会话状态里,通过开场消息交给模型去调用
    const last = state.lastVoucherQuery;
    knownAccountSets.set(last.accountSetId, last.accountSetName);
    ctx.onStep?.(`翻页拉取凭证:「${last.accountSetName}」${last.period}…`);
    messages.push({
      role: 'user',
      content: `用户要继续上一查询的下一页:账套「${last.accountSetName}」(accountSetId: ${last.accountSetId})、期间 ${last.period},nextCursor=${last.nextCursor}。请调用 list_vouchers 完成翻页,并汇总本页结果。`,
    });
    return messages;
  }
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

/** 工具结果的会话副作用记账:账套名录、多候选澄清、翻页游标 */
function noteToolResult(
  tool: ReadToolName,
  args: Record<string, unknown>,
  outcome: Extract<ToolOutcome, { ok: true }>,
  state: AgentSessionState,
  knownAccountSets: Map<string, string>,
  userMessage: string,
  sessionTtlMs: number,
): void {
  if (tool === 'search_account_sets') {
    const candidates = extractAccountSetList(outcome.data);
    for (const candidate of candidates) knownAccountSets.set(candidate.id, candidate.name);
    if (candidates.length === 0) {
      state.pendingCandidates = undefined;
      state.expiresAt = undefined;
      state.pendingRequest = undefined;
      return;
    }
    if (candidates.length > 1) {
      state.pendingCandidates = candidates.map((candidate) => ({ id: candidate.id, name: candidate.name }));
      state.expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
      // 记住触发澄清的原始请求:用户选定候选后据此还原意图
      state.pendingRequest = userMessage;
    }
  } else if (tool === 'list_vouchers') {
    const accountSetId = stringArg(args, 'accountSetId');
    if (!accountSetId) return;
    const nextCursor = extractNextCursor(outcome.data);
    state.lastVoucherQuery = {
      accountSetId,
      accountSetName: outcome.meta.accountSetName ?? knownAccountSets.get(accountSetId) ?? '',
      period: stringArg(args, 'period'),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }
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
    '你绝不编造数据,所有回答只能基于工具返回的结果;需要数据时必须调用工具查询。',
    '',
    '可用工具(名称、描述、inputSchema 的紧凑 JSON):',
    toolLines,
    '',
    '回答规则:',
    '- 数据回复必须带上所用账套名称、会计期间(如使用)、数据来源(meta.source)与取回时间(meta.retrievedAt)。',
    '- search_account_sets 返回多个候选账套时,必须以编号列表列出全部候选让用户选择,不得自行猜测;只返回一个候选时直接采用;没有候选时明确告知用户没有找到。',
    '- list_vouchers 结果含 nextCursor 时,必须告知用户"还有更多,回复\'下一页\'继续"。',
    '- list_vouchers 首次查询不要传任何分页参数(默认首页);只有用户要看后续页时才用上一页结果里的 nextCursor,不要自行传 pageNo。',
    '- 工具参数中的 progress 是给用户的进度提示(一句话,≤60 字,只描述即将进行的动作,严禁包含任何结果)。',
    '- 始终使用简体中文回复。',
    '- 对话开头的「历史消息」仅供上下文参考;请以最新一条用户消息为当前任务,不要重复回答历史里已经回答过的问题。',
    '- 提及 accountSetId、期间、凭证号等标识时,只能使用工具结果中出现的原值,严禁编造;历史或工具结果中没有的标识,不要提及。',
    `- 工具结果出现 NEEDS_LOGIN 时,回复:"${NEEDS_LOGIN_MESSAGE}"`,
  ].join('\n');
}

export type { PendingCandidate, AgentSessionState };
