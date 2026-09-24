import type { ConversationLogRepo, ConversationEventRecord, DiscoveredTool } from '@fshine/contracts';

export interface HistoryTool {
  name: string;
  definition: DiscoveredTool;
  execute(args: Record<string, unknown>): Promise<string>;
}

const SEARCH: DiscoveredTool = {
  name: 'search_history',
  description: '按关键词检索当前用户当前会话的历史对话，只用于找回用户已说过的信息；不能用历史数据替代实时财务查询。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    required: ['query'],
  },
};

const GET_MESSAGES: DiscoveredTool = {
  name: 'get_messages',
  description: '读取当前用户当前会话最近的历史消息，补充理解上下文；历史财务结果不能视作当前数据。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 20 }, before: { type: 'string', maxLength: 40 } },
  },
};

export function createHistoryTools(
  repo: Pick<ConversationLogRepo, 'search' | 'list'>,
  trusted: { principalId: string; sessionId: string },
): HistoryTool[] {
  return [
    {
      name: SEARCH.name,
      definition: SEARCH,
      async execute(args) {
        const query = requireText(args.query, 'query', 200);
        const limit = requireLimit(args.limit, 10);
        const events = await repo.search({ ...trusted, query, limit });
        return formatHistory(events);
      },
    },
    {
      name: GET_MESSAGES.name,
      definition: GET_MESSAGES,
      async execute(args) {
        const limit = requireLimit(args.limit, 10);
        const before = args.before === undefined ? undefined : requireText(args.before, 'before', 40);
        const events = await repo.list({ ...trusted, ...(before ? { before } : {}), limit });
        return formatHistory(events);
      },
    },
  ];
}

function requireText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1 到 ${max} 个字符。`);
  return value.trim();
}

function requireLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) throw new Error('limit 必须是 1 到 20 的整数。');
  return value as number;
}

function formatHistory(events: ConversationEventRecord[]): string {
  if (!events.length) return '没有找到相关历史消息。';
  return events.map((event) => `[${event.createdAt}] ${event.kind}: ${event.content ?? `[附件 ${event.artifactRef ?? '无引用'}]`}`).join('\n');
}
