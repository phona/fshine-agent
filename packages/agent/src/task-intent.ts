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
  };

export const ROUTE_CURRENT_TURN_TOOL_NAME = 'route_current_turn';

export const ROUTE_CURRENT_TURN_TOOL: DiscoveredTool = {
  name: ROUTE_CURRENT_TURN_TOOL_NAME,
  description: [
    '在最终回答前先调用一次，声明本轮是普通对话、需要澄清还是 17dz 实时查询。',
    '只看当前用户消息作为当前请求。之前的回答、工具结果、确认计划只是历史资料；用户重复实时数据问题仍是新查询。',
    '只提交结构化意图，不直接回答财务问题。账套范围缺失或歧义时选择 clarify；不得把客户名当账套、也不得把历史出现的多个账套自动纳入范围。',
    'account_search 的 searchQuery 必须来自当前消息。balance 的账套只有当前消息明确给出或当前消息明确指代且上下文能唯一解析时才算确定。periods 只列用户明确要求的期间，quote 必须逐字摘录当前消息；空 periods 表示按平台当前期间查。',
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
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

export interface TaskIntentResult {
  intent: TaskIntent;
  error?: string;
}

export function validatePlanAgainstTaskIntent(
  intent: Extract<TaskIntent, { kind: 'platform_query' }>,
  calls: readonly { operation: string; args: readonly unknown[] }[],
): string | null {
  if (intent.taskType === 'account_search') {
    if (calls.length !== 1 || calls[0]?.operation !== 'finance.search-account-sets'
      || optionValue(calls[0].args, '--query') !== intent.searchQuery) {
      return '账套搜索计划必须且只能按路由器给出的关键词调用 finance.search-account-sets。';
    }
    return null;
  }
  if (intent.taskType !== 'balance') return null;
  const accounts = intent.accountQueries ?? [];
  const customers = intent.customerQueries ?? [];
  const periods = intent.periods?.map((period) => period.value) ?? [];
  if (!accounts.length) return '宿主意图中没有可执行的账套范围，应先澄清。';
  const customerScope = customers.length ? customers : [''];
  const periodScope = periods.length ? periods : [''];
  if (calls.length !== accounts.length * customerScope.length * periodScope.length) {
    return '余额计划调用数量超出了宿主确认的账套和期间范围。';
  }
  const expected = new Set<string>();
  for (const account of accounts) for (const customer of customerScope) for (const period of periodScope) expected.add(JSON.stringify([account, customer, period]));
  for (const call of calls) {
    if (call.operation !== 'finance.query-receivables') return '余额任务只能调用 finance.query-receivables；凭证历史不能代替余额表。';
    const account = optionValue(call.args, '--query');
    const customer = optionValue(call.args, '--customer');
    const period = optionValue(call.args, '--period') ?? '';
    if (!account || !accounts.includes(account)) return '余额计划加入了宿主未确认的账套。';
    if (customers.length ? (!customer || !customers.includes(customer)) : Boolean(customer)) return '余额计划客户范围与宿主解析的当前请求不一致。';
    if (periods.length ? !periods.includes(period) : Boolean(period)) return '余额计划加入了当前请求未指定的期间。';
    expected.delete(JSON.stringify([account, customer ?? '', period]));
  }
  return expected.size ? '余额计划漏掉了宿主解析出的请求范围。' : null;
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
  if (item.question !== undefined && typeof item.question !== 'string') return null;
  return {
    kind: 'platform_query', taskType,
    ...(item.accountResolution !== undefined ? { accountResolution: item.accountResolution as Extract<TaskIntent, { kind: 'platform_query' }>['accountResolution'] } : {}),
    ...(Array.isArray(item.accountQueries) ? { accountQueries: item.accountQueries as string[] } : {}),
    ...(typeof item.referenceQuote === 'string' ? { referenceQuote: item.referenceQuote } : {}),
    ...(Array.isArray(item.customerQueries) ? { customerQueries: item.customerQueries as string[] } : {}),
    ...(Array.isArray(item.periods) ? { periods: item.periods as Array<{ value: string; quote: string }> } : {}),
    ...(typeof item.searchQuery === 'string' ? { searchQuery: item.searchQuery } : {}),
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
  if (intent.taskType !== 'balance') return intent;
  if (intent.accountResolution === 'missing' || intent.accountResolution === 'ambiguous') {
    return { kind: 'clarify', question: intent.question || '请告诉我要查哪个账套的应收余额？' };
  }
  if (!intent.accountQueries?.length) return { kind: 'clarify', question: '请告诉我要查哪个账套的应收余额？' };
  if (intent.customerQueries?.some((name) => !current.includes(name))) return { kind: 'clarify', question: '请确认要查询的客户名称。' };
  if (intent.periods?.some((period) => !period.value.trim() || !period.quote.trim() || !current.includes(period.quote))) {
    return { kind: 'clarify', question: '请确认要查询的会计期间。' };
  }
  if (intent.accountResolution === 'explicit' && intent.accountQueries.some((name) => !current.includes(name))) {
    return { kind: 'clarify', question: '请直接告诉我要查哪个账套；我不能从旧对话补入账套范围。' };
  }
  if (intent.accountResolution === 'referenced') {
    const historyText = history.map(messageContentText).join('\n');
    if (intent.accountQueries.length !== 1 || !intent.referenceQuote || !current.includes(intent.referenceQuote)
      || intent.accountQueries.some((name) => !historyText.includes(name))) {
      return { kind: 'clarify', question: '我无法从当前对话唯一确定你指的账套，请告诉我账套名称。' };
    }
  }
  return intent;
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
