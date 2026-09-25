import type { DriverMessage } from './driver';
import type { DiscoveredTool } from '@fshine/contracts';

export type TurnDeclaration =
  | { kind: 'conversation' }
  | { kind: 'clarify'; question: string }
  | {
    kind: 'platform_query';
    taskType: 'account_search' | 'balance' | 'voucher' | 'other';
    accountResolution?: 'explicit' | 'referenced' | 'missing' | 'ambiguous';
    accountQueries?: string[];
    referenceQuote?: string;
    customerQueries?: string[];
    periods?: Array<{ value: string; quote: string }>;
    searchQuery?: string;
    question?: string;
    /** Continue an existing 17dz subagent task (host re-validates ownership). */
    continueTaskId?: string;
  };

export const ROUTE_CURRENT_TURN_TOOL_NAME = 'route_current_turn';

export const ROUTE_CURRENT_TURN_TOOL: DiscoveredTool = {
  name: ROUTE_CURRENT_TURN_TOOL_NAME,
  description: [
    '在最终回答前先调用一次，申报本轮是普通对话（conversation）、需要澄清（clarify）还是平台实时查询（platform_query）。',
    '只看当前用户消息作为当前请求。之前的回答、工具结果、确认计划只是历史资料；用户重复实时数据问题仍是新查询。',
    '只申报结构化意图，不直接回答数据问题。',
    '',
    '【选 kind】',
    '· conversation：打招呼、寒暄、道谢、问你是谁/能做什么、纯观点讨论。这类绝对不要申报成 platform_query。',
    '· platform_query：要查平台上的真实数据。',
    '· clarify：仅当前消息没有可执行的查询对象、且无法唯一指代时。',
    '',
    '【字段口径】填错会被宿主退回重填，整轮白跑。',
    '· accountQueries 只填名称本身，逐字摘录当前消息；不要把类别词拼进去，也不要把附属筛选条件填进来。',
    '· 查什么由 taskType 表达；customerQueries / periods / searchQuery 只填对应的附属筛选，不要与 accountQueries 混填。',
    '· taskType 四选一：account_search / balance / voucher / other。宿主不再按 taskType 校验具体操作；该字段只转交执行层选择执行口径，拿不准填 other。',
    '· customerQueries 只填名称；periods 只填用户明确要求的时间范围，value 用 YYYYMM，quote 逐字摘录当前消息；空数组表示按平台当前范围查，此时不要让子 Agent 传 --period。',
    '',
    '【指代解析】"这个""它""那个""刚才那个"这类指代，只要紧邻的上一轮出现过且只有一个名称，就必须按 referenced 处理：把那个名称填进 accountQueries、指代原词填进 referenceQuote。例：上一轮查了某对象，本轮"这个 202608 呢？"→ accountResolution:"referenced", accountQueries:["上一轮出现的名称"], referenceQuote:"这个"。上一轮刚查过时选 clarify 属于过度澄清，会被宿主判为无效申报。只有上一轮完全没有候选、或出现多个候选时才选 missing/ambiguous。',
    '',
    '【不要代替用户追问】消息里已经写了名称就直接按它申报——平台自己会返回候选列表或明确报错，那才是给用户的事实依据。也不要因为"可能有同名"就提前追问。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['conversation', 'clarify', 'platform_query'] },
      question: { type: 'string' },
      taskType: { type: 'string', enum: ['account_search', 'balance', 'voucher', 'other'] },
      accountResolution: { type: 'string', enum: ['explicit', 'referenced', 'missing', 'ambiguous'] },
      accountQueries: { type: 'array', items: { type: 'string' } },
      referenceQuote: { type: 'string' },
      customerQueries: { type: 'array', items: { type: 'string' } },
      periods: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, quote: { type: 'string' } }, required: ['value', 'quote'], additionalProperties: false } },
      searchQuery: { type: 'string' },
      continueTaskId: { type: 'string', description: '仅在用户补充了子 Agent 索要的信息、需要继续同一个 17dz 子任务时使用' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

export interface TurnDeclarationResult {
  intent: TurnDeclaration;
  error?: string;
}

/**
 * A declaration that contradicts itself is a form-filling mistake, not missing user input:
 * the model claims the account is explicit yet filed no account. The host should send it back
 * for another attempt instead of spending one of the user's clarification rounds.
 */
export function isSelfContradictoryDeclaration(intent: TurnDeclaration): string | null {
  if (intent.kind !== 'platform_query') return null;
  if (!intent.taskType) return '缺少 taskType（account_search / balance / voucher / other）。';
  if (intent.taskType === 'account_search' && !intent.searchQuery?.trim()) {
    return 'account_search 必须给出 searchQuery，且逐字来自当前消息。';
  }
  if (intent.taskType === 'balance' && (intent.accountResolution === 'explicit' || intent.accountResolution === 'referenced') && !intent.accountQueries?.length) {
    return `accountResolution=${intent.accountResolution} 但 accountQueries 为空：请把当前消息里的名称逐字填进 accountQueries。`;
  }
  return null;
}

/**
 * Host-side entry for a route_current_turn tool call.
 *
 * Order matters: a self-contradictory declaration is the model's form-filling mistake and must
 * be sent back for another attempt, while a merely unsupported scope claim is a genuine
 * clarification for the user. Checking contradiction first keeps those two apart.
 */
export function reviewRouteDeclaration(
  args: Record<string, unknown>,
  currentUserMessage: string,
  history: DriverMessage[],
): { intent: TurnDeclaration } | { error: string } {
  const parsed = parseTurnDeclaration(JSON.stringify(args));
  if (!parsed) {
    return { error: '申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。' };
  }
  const contradiction = isSelfContradictoryDeclaration(parsed);
  if (contradiction) return { error: contradiction };
  return { intent: validateTurnDeclarationEvidence(parsed, currentUserMessage, history) };
}

/** @deprecated use reviewRouteDeclaration, which separates model mistakes from user clarifications. */
export function applyRouteDeclaration(
  args: Record<string, unknown>,
  currentUserMessage: string,
  history: DriverMessage[],
): TurnDeclaration {
  const reviewed = reviewRouteDeclaration(args, currentUserMessage, history);
  return 'intent' in reviewed ? reviewed.intent : { kind: 'clarify', question: '我没能理解本轮要做什么，请告诉我要查询的对象和范围。' };
}

/**
 * 领域无关的实体来源集合（架构 §2 第 9 条）。宿主不懂业务，只做字符串包含：
 * 计划里每个实体都必须能在三个来源的并集里逐字找到。
 *
 * 三个来源全部由调用方注入——**不从申报契约的字段推导**。申报契约的字段在契约
 * 瘦身（Phase 4）后会消失，这个校验必须能独立存活。
 */
export interface PlanEntitySources {
  /** ① 当前用户消息原文。 */
  currentMessage: string;
  /** ② 本轮注入的指代消解证据文本（宿主主动回溯产出，可为空）。 */
  referenceEvidence?: string;
  /** ③ 本任务迄今的平台响应（tool_result 内容，逐条）。 */
  platformResponses?: readonly string[];
}

/** 单条平台响应纳入包含判定的截断长度（与宿主留存 tool_result 的截断一致）。 */
const PLATFORM_RESPONSE_LIMIT = 20_000;
/** 纳入判定的平台响应条数上限：覆盖"目录查询拿到唯一候选、再按候选名查"这类跨计划解析。 */
const PLATFORM_RESPONSE_MAX = 20;

/**
 * 计划实体来源校验（架构 §2 第 9 条，领域无关）。
 *
 * 每个 call 的 args 里所有字符串都要逐一检查：以 `-` 开头的是 flag 不是实体，跳过；
 * 其余字符串必须能在「当前消息 / 检索证据 / 本轮平台响应」的并集里逐字找到。
 *
 * 与旧的领域分支的差别（roadmap 明确接受）：宿主不再强制"某类任务只能调某个操作"，
 * 操作与任务类型是否匹配归执行层 SKILL 与平台门禁。但实体来源校验不弱于原来——
 * 不在三个来源里的字符串参数一律拒绝。执行层调目录查询拿到的唯一候选名逐字来自
 * 本轮平台响应，因此天然放行，宿主不需要懂业务就能判"这是合法解析出来的"。
 */
export function validatePlanEntities(
  calls: readonly { operation: string; args: readonly unknown[] }[],
  sources: PlanEntitySources,
): string | null {
  const responses = (sources.platformResponses ?? []).slice(-PLATFORM_RESPONSE_MAX);
  const haystack = [
    sources.currentMessage,
    sources.referenceEvidence ?? '',
    ...responses.map((response) => response.slice(0, PLATFORM_RESPONSE_LIMIT)),
  ].join('\n');
  for (const call of calls) {
    for (const value of call.args) {
      if (typeof value !== 'string') continue;
      const token = value.trim();
      // flag（--query）不是实体；空串无实体含义
      if (!token || token.startsWith('-')) continue;
      if (!haystack.includes(token)) {
        // 只报第一个越权值并截断：worker 修正后重新提交完整 calls，逐次暴露即可
        return `计划包含未在当前请求、检索证据或平台响应中出现的参数：${token.slice(0, 80)}`;
      }
    }
  }
  return null;
}

export function parseTurnDeclaration(value: string): TurnDeclaration | null {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const item = parsed as Record<string, unknown>;
  if (item.kind === 'conversation') return { kind: 'conversation' };
  if (item.kind === 'clarify') {
    return typeof item.question === 'string' && item.question.trim()
      ? { kind: 'clarify', question: item.question.trim().slice(0, 300) }
      : null;
  }
  if (item.kind !== 'platform_query' || !['account_search', 'balance', 'voucher', 'other'].includes(String(item.taskType))) return null;
  const taskType = item.taskType as Extract<TurnDeclaration, { kind: 'platform_query' }>['taskType'];
  if (item.accountResolution !== undefined && !['explicit', 'referenced', 'missing', 'ambiguous'].includes(String(item.accountResolution))) return null;
  if (item.accountQueries !== undefined && (!Array.isArray(item.accountQueries) || item.accountQueries.some((value) => typeof value !== 'string'))) return null;
  if (item.referenceQuote !== undefined && typeof item.referenceQuote !== 'string') return null;
  if (item.customerQueries !== undefined && (!Array.isArray(item.customerQueries) || item.customerQueries.some((value) => typeof value !== 'string'))) return null;
  if (item.periods !== undefined && (!Array.isArray(item.periods) || item.periods.some((value) => !value || typeof value !== 'object' || typeof (value as { value?: unknown }).value !== 'string' || typeof (value as { quote?: unknown }).quote !== 'string'))) return null;
  if (item.searchQuery !== undefined && typeof item.searchQuery !== 'string') return null;
  if (item.continueTaskId !== undefined && (typeof item.continueTaskId !== 'string' || !item.continueTaskId.trim())) return null;
  if (item.question !== undefined && typeof item.question !== 'string') return null;
  return {
    kind: 'platform_query', taskType,
    ...(item.accountResolution !== undefined ? { accountResolution: item.accountResolution as Extract<TurnDeclaration, { kind: 'platform_query' }>['accountResolution'] } : {}),
    ...(Array.isArray(item.accountQueries) ? { accountQueries: item.accountQueries as string[] } : {}),
    ...(typeof item.referenceQuote === 'string' ? { referenceQuote: item.referenceQuote } : {}),
    ...(Array.isArray(item.customerQueries) ? { customerQueries: item.customerQueries as string[] } : {}),
    ...(Array.isArray(item.periods) ? { periods: item.periods as Array<{ value: string; quote: string }> } : {}),
    ...(typeof item.searchQuery === 'string' ? { searchQuery: item.searchQuery } : {}),
    ...(typeof item.continueTaskId === 'string' ? { continueTaskId: item.continueTaskId.trim() } : {}),
    ...(typeof item.question === 'string' ? { question: item.question.slice(0, 300) } : {}),
  };
}

export function validateTurnDeclarationEvidence(intent: TurnDeclaration, current: string, history: DriverMessage[]): TurnDeclaration {
  if (intent.kind !== 'platform_query') return intent;
  if (intent.taskType === 'account_search') {
    if (!intent.searchQuery || !current.includes(intent.searchQuery)) {
      return { kind: 'clarify', question: '请提供要搜索的名称关键词。' };
    }
    return intent;
  }
  // 名称证据校验对所有 taskType 生效。曾经把它放在 balance 分支之后，导致
  // taskType=voucher 提前 return、指代校验对整个凭单类完全没生效——长会话里
  // "这个的凭单有多少张"就这样被解析成了上文顺带提过的别家名称。
  if (intent.accountResolution === 'missing' || intent.accountResolution === 'ambiguous') {
    return { kind: 'clarify', question: intent.question || '请告诉我要查哪个对象？' };
  }
  if (!intent.accountQueries?.length) return { kind: 'clarify', question: '请告诉我要查哪个对象？' };
  if (intent.customerQueries?.some((name) => !current.includes(name))) return { kind: 'clarify', question: '请确认要查询的对象名称。' };
  if (intent.periods?.some((period) => !period.value.trim() || !period.quote.trim() || !current.includes(period.quote))) {
    return { kind: 'clarify', question: '请确认要查询的时间范围。' };
  }
  if (intent.accountResolution === 'explicit' && intent.accountQueries.some((name) => !current.includes(name))) {
    return { kind: 'clarify', question: '请直接告诉我要查询的对象；我不能从旧对话补入范围。' };
  }
  if (intent.accountResolution === 'referenced') {
    // 指代绑定的是紧邻的那一轮，不是上下文里出现过的任何一个名称。
    // 放宽到整段可见历史会把上一轮顺带提过的别家名称当成指代目标——实测就把
    // 一个指代解析成了两轮前提过的另一家，而上一轮刚查的是另一家。
    const previousTurn = previousTurnText(history, current);
    const rejected = intent.accountQueries.length !== 1 || !intent.referenceQuote || !current.includes(intent.referenceQuote)
      || !previousTurn.trim() || intent.accountQueries.some((name) => !previousTurn.includes(name));
    if (typeof process !== 'undefined' && process.env?.DZ_DEBUG_REFERENCE === '1') {
      console.info(JSON.stringify({ event: 'reference_check', current, declared: intent.accountQueries, rejected, previousTurn: previousTurn.slice(0, 400) }));
    }
    if (rejected) {
      return { kind: 'clarify', question: '我无法从上一轮对话唯一确定你指的对象，请告诉我具体名称。' };
    }
  }
  return intent;
}

/**
 * 上一轮对话的文本。生产里 context 以当前用户消息结尾，测试里 history 不含它，
 * 所以按内容排除当前消息，再取它前面最近的那个 user 起点。
 */
export function previousTurnText(history: DriverMessage[], current: string): string {
  // 生产里 context 以当前用户消息结尾；先把它排除在搜索范围外，
  // 否则 slice 会把它又带回来（指代校验就变成了"当前消息里有没有这个名称"）。
  const last = history.length - 1;
  const end = last >= 0 && messageContentText(history[last]!) === current ? last : history.length;
  const texts = history.map(messageContentText);
  for (let index = end - 1; index >= 0; index -= 1) {
    if ((history[index] as { role?: string }).role !== 'user') continue;
    if (texts[index] === current) continue;
    return history.slice(index, end).map(messageContentText).join('\n');
  }
  return '';
}

function messageContentText(message: DriverMessage): string {
  const value = message as { content?: unknown };
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return '';
  return value.content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const block = part as { type?: unknown; text?: unknown };
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(Boolean).join('\n');
}
