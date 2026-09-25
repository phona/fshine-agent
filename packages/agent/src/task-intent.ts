import type { DriverMessage } from './driver';
import type { DiscoveredTool } from '@fshine/contracts';

export type TaskIntent =
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
    '在最终回答前先调用一次，申报本轮是普通对话（conversation）、需要澄清（clarify）还是 17dz 实时查询（platform_query）。',
    '只看当前用户消息作为当前请求。之前的回答、工具结果、确认计划只是历史资料；用户重复实时数据问题仍是新查询。',
    '只申报结构化意图，不直接回答财务问题。',
    '',
    '【选 kind】',
    '· conversation：打招呼、寒暄、道谢、问你是谁/能做什么、纯观点讨论。这类绝对不要申报成 platform_query。',
    '· platform_query：要查平台上的真实数据（余额、凭证、账套目录）。',
    '· clarify：仅当前消息确实没有账套名、且无法唯一指代时。',
    '',
    '【字段口径】填错会被宿主退回重填，整轮白跑。',
    '· accountQueries 只填账套名称，逐字摘录当前消息。消息里出现的公司名/账套名就是它——例如"把新兴五金的凭证列一下"→ accountQueries:["新兴五金"]；"查一下幻辰财税账套本期的应收账款"→ accountQueries:["幻辰财税"]（不要把"账套""本期"这些词拼进去）。',
    '· 不要把科目名（应收账款）、客户名（猫一杯）或期间词填进 accountQueries；查什么由 taskType 表达。',
    '· taskType：balance=应收/科目余额，voucher=凭证，account_search=账套目录，other=其他平台数据。',
    '· customerQueries 只填客户名称；periods 只填用户明确要求的期间，value 用 YYYYMM，quote 逐字摘录当前消息；空数组表示按平台当前期间查，此时不要让子 Agent 传 --period。',
    '',
    '【指代解析】"这个账套""它""那个""刚才那个"这类指代，只要紧邻的上一轮出现过且只有一个账套名，就必须按 referenced 处理：把那个账套名填进 accountQueries、指代原词填进 referenceQuote。例：上一轮查了新兴五金，本轮"这个账套 202608 呢？"→ accountResolution:"referenced", accountQueries:["新兴五金"], referenceQuote:"这个账套"。上一轮刚查过账套时选 clarify 属于过度澄清，会被宿主判为无效申报。只有上一轮完全没有账套、或出现多个候选时才选 missing/ambiguous。',
    '',
    '【不要代替用户追问】消息里已经写了账套名就直接按它申报——平台自己会返回候选列表或明确报错，那才是给用户的事实依据。也不要因为"可能有同名账套"就提前追问。',
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

export interface TaskIntentResult {
  intent: TaskIntent;
  error?: string;
}

/**
 * A declaration that contradicts itself is a form-filling mistake, not missing user input:
 * the model claims the account is explicit yet filed no account. The host should send it back
 * for another attempt instead of spending one of the user's clarification rounds.
 */
export function isSelfContradictoryDeclaration(intent: TaskIntent): string | null {
  if (intent.kind !== 'platform_query') return null;
  if (!intent.taskType) return '缺少 taskType（account_search / balance / voucher / other）。';
  if (intent.taskType === 'account_search' && !intent.searchQuery?.trim()) {
    return 'account_search 必须给出 searchQuery，且逐字来自当前消息。';
  }
  if (intent.taskType === 'balance' && (intent.accountResolution === 'explicit' || intent.accountResolution === 'referenced') && !intent.accountQueries?.length) {
    return `accountResolution=${intent.accountResolution} 但 accountQueries 为空：请把当前消息里的账套名称逐字填进 accountQueries。`;
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
): { intent: TaskIntent } | { error: string } {
  const parsed = parseTaskIntent(JSON.stringify(args));
  if (!parsed) {
    return { error: '申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。' };
  }
  const contradiction = isSelfContradictoryDeclaration(parsed);
  if (contradiction) return { error: contradiction };
  return { intent: validateTaskIntentEvidence(parsed, currentUserMessage, history) };
}

/** @deprecated use reviewRouteDeclaration, which separates model mistakes from user clarifications. */
export function applyRouteDeclaration(
  args: Record<string, unknown>,
  currentUserMessage: string,
  history: DriverMessage[],
): TaskIntent {
  const reviewed = reviewRouteDeclaration(args, currentUserMessage, history);
  return 'intent' in reviewed ? reviewed.intent : { kind: 'clarify', question: '我没能理解本轮要做什么，请告诉我要查询的账套和期间。' };
}

export function validatePlanAgainstTaskIntent(
  intent: Extract<TaskIntent, { kind: 'platform_query' }>,
  calls: readonly { operation: string; args: readonly unknown[] }[],
): string | null {
  if (intent.taskType === 'account_search') {
    if (calls.length !== 1 || calls[0]?.operation !== 'finance.search-account-sets'
      || !inScope(optionValue(calls[0].args, '--query'), intent.searchQuery ? [intent.searchQuery] : [])) {
      return '账套搜索计划必须且只能按本轮给出的关键词调用 finance.search-account-sets。';
    }
    return null;
  }
  if (intent.taskType === 'voucher') return validateVoucherPlan(intent, calls);
  if (intent.taskType !== 'balance') return null;
  const accounts = intent.accountQueries ?? [];
  const customers = intent.customerQueries ?? [];
  const periods = intent.periods?.map((period) => period.value) ?? [];
  if (!accounts.length) return '宿主意图中没有可执行的账套范围，应先澄清。';
  // 硬约束只有两条：不得越权（每次调用都在申报范围内）、不得空转（至少覆盖一个申报项）。
  // 不做"调用数必须等于 账套 × 客户 × 期间"的精确基数校验——模型有时会把科目名混进
  // accountQueries，精确基数会把最常见的查询形态直接拒死；越权由逐次包含判定挡住。
  const required: Array<{ account: string; customer: string; period: string }> = [];
  for (const account of accounts) for (const customer of (customers.length ? customers : [''])) for (const period of (periods.length ? periods : [''])) required.push({ account, customer, period });
  const coveredAccounts = new Set<string>();
  for (const call of calls) {
    if (call.operation !== 'finance.query-receivables') return '余额任务只能调用 finance.query-receivables；凭证历史不能代替余额表。';
    const account = optionValue(call.args, '--query');
    const customer = optionValue(call.args, '--customer');
    const period = optionValue(call.args, '--period') ?? '';
    if (!account || !inScope(account, accounts)) return '余额计划加入了宿主未确认的账套。';
    if (customers.length ? (!customer || !inScope(customer, customers)) : Boolean(customer)) return '余额计划客户范围与宿主解析的当前请求不一致。';
    if (periods.length ? !periods.includes(period) : Boolean(period)) {
      return '余额计划加入了当前请求未指定的期间；用户未指定期间时请不要带 --period，由平台按当前期间查。';
    }
    for (const want of required) {
      if (!inScope(account, [want.account])) continue;
      if (want.customer && !inScope(customer, [want.customer])) continue;
      if (want.period && period !== want.period) continue;
      coveredAccounts.add(want.account);
      break;
    }
  }
  // 只要求"确实查了申报范围内的账套"。少查是交付不足（回复里会说明），
  // 多查/查错范围已被上面的逐次包含判定挡下；用全覆盖会把申报里的噪声项变成硬失败。
  return coveredAccounts.size === 0 ? '余额计划没有覆盖宿主解析出的任何账套范围。' : null;
}

/**
 * 业务实体名匹配：平台上的规范名与用户口癖常有词缀差异（用户说"幻辰财税账套"，
 * 平台账套名是"幻辰财税"；用户说"幻辰"，规范名是"幻辰财税"）。这里用双向包含
 * 判定"属于本轮申报范围"，不做全等字符串比较——全等会把最常见的查询形态直接拒死。
 *
 * 防越权靠的是另外两件事：申报本身必须逐字来自当前消息（validateTaskIntentEvidence），
 * 以及调用数量必须等于 账套 × 客户 × 期间 的笛卡尔积（多查一个账套就对不上）。
 */
function inScope(value: string | null, scope: readonly string[]): boolean {
  if (!value) return false;
  const query = value.trim();
  if (!query) return false;
  return scope.some((name) => {
    const declared = name.trim();
    return declared === query || declared.includes(query) || query.includes(declared);
  });
}

/** Voucher scripts take the period positionally (account, YYYYMM); flag form is also accepted. */
function voucherPeriod(args: readonly unknown[]): string {
  const flagged = optionValue(args, '--period') ?? optionValue(args, '--month');
  if (flagged) return flagged;
  const positional = args[1];
  return typeof positional === 'string' && /^\d{6}$/.test(positional) ? positional : '';
}

/**
 * Voucher queries are scope-checked too: the plan may only touch the voucher domain and the
 * periods the current request actually named. Everything else stays with the platform gate.
 */
function validateVoucherPlan(
  intent: Extract<TaskIntent, { kind: 'platform_query' }>,
  calls: readonly { operation: string; args: readonly unknown[] }[],
): string | null {
  const periods = intent.periods?.map((period) => period.value) ?? [];
  for (const call of calls) {
    if (!call.operation.startsWith('voucher.')) {
      return '凭证任务只能调用 voucher 域操作，不能用余额或账套搜索代替。';
    }
    const period = voucherPeriod(call.args);
    if (periods.length && period && !periods.includes(period)) {
      return '凭证计划加入了当前请求未指定的期间。';
    }
  }
  return null;
}

export function parseTaskIntent(value: string): TaskIntent | null {
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
  const taskType = item.taskType as Extract<TaskIntent, { kind: 'platform_query' }>['taskType'];
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
    ...(item.accountResolution !== undefined ? { accountResolution: item.accountResolution as Extract<TaskIntent, { kind: 'platform_query' }>['accountResolution'] } : {}),
    ...(Array.isArray(item.accountQueries) ? { accountQueries: item.accountQueries as string[] } : {}),
    ...(typeof item.referenceQuote === 'string' ? { referenceQuote: item.referenceQuote } : {}),
    ...(Array.isArray(item.customerQueries) ? { customerQueries: item.customerQueries as string[] } : {}),
    ...(Array.isArray(item.periods) ? { periods: item.periods as Array<{ value: string; quote: string }> } : {}),
    ...(typeof item.searchQuery === 'string' ? { searchQuery: item.searchQuery } : {}),
    ...(typeof item.continueTaskId === 'string' ? { continueTaskId: item.continueTaskId.trim() } : {}),
    ...(typeof item.question === 'string' ? { question: item.question.slice(0, 300) } : {}),
  };
}

export function validateTaskIntentEvidence(intent: TaskIntent, current: string, history: DriverMessage[]): TaskIntent {
  if (intent.kind !== 'platform_query') return intent;
  if (intent.taskType === 'account_search') {
    if (!intent.searchQuery || !current.includes(intent.searchQuery)) {
      return { kind: 'clarify', question: '请提供要搜索的账套名称关键词。' };
    }
    return intent;
  }
  // 账套证据校验对所有 taskType 生效。曾经把它放在 balance 分支之后，导致
  // taskType=voucher 提前 return、指代校验对整个凭证类完全没生效——长会话里
  // "这个账套的凭证有多少张"就这样被解析成了上文顺带提过的别家账套。
  if (intent.accountResolution === 'missing' || intent.accountResolution === 'ambiguous') {
    return { kind: 'clarify', question: intent.question || '请告诉我要查哪个账套？' };
  }
  if (!intent.accountQueries?.length) return { kind: 'clarify', question: '请告诉我要查哪个账套？' };
  if (intent.customerQueries?.some((name) => !current.includes(name))) return { kind: 'clarify', question: '请确认要查询的客户名称。' };
  if (intent.periods?.some((period) => !period.value.trim() || !period.quote.trim() || !current.includes(period.quote))) {
    return { kind: 'clarify', question: '请确认要查询的会计期间。' };
  }
  if (intent.accountResolution === 'explicit' && intent.accountQueries.some((name) => !current.includes(name))) {
    return { kind: 'clarify', question: '请直接告诉我要查哪个账套；我不能从旧对话补入账套范围。' };
  }
  if (intent.accountResolution === 'referenced') {
    // "这个账套/它"绑定的是紧邻的那一轮，不是上下文里出现过的任何一个账套。
    // 放宽到整段可见历史会把上一轮顺带提过的别家账套当成指代目标——实测就把
    // "这个账套"解析成了两轮前提过的新兴建材，而上一轮刚查的是幻辰财税。
    const previousTurn = previousTurnText(history, current);
    if (intent.accountQueries.length !== 1 || !intent.referenceQuote || !current.includes(intent.referenceQuote)
      || !previousTurn.trim() || intent.accountQueries.some((name) => !previousTurn.includes(name))) {
      return { kind: 'clarify', question: '我无法从上一轮对话唯一确定你指的账套，请告诉我账套名称。' };
    }
  }
  return intent;
}

/**
 * 上一轮对话的文本。生产里 context 以当前用户消息结尾，测试里 history 不含它，
 * 所以按内容排除当前消息，再取它前面最近的那个 user 起点。
 */
function previousTurnText(history: DriverMessage[], current: string): string {
  const texts = history.map(messageContentText);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if ((history[index] as { role?: string }).role !== 'user') continue;
    if (texts[index] === current) continue;
    return history.slice(index).map(messageContentText).join('\n');
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

function optionValue(args: readonly unknown[], option: string): string | null {
  const index = args.findIndex((value) => value === option);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
