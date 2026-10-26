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

/**
 * 引用文字的渲染预览上限（D-118）：对齐压缩 sidecar 的 512 字节预览惯例
 * （compaction-context 的 MAX_QUOTE_BODY_PREVIEW_BYTES）。引用文字本身可到
 * 16,384 字节（contracts MAX_QUOTED_TEXT_BYTES）× limit 20 条——原样 stringify
 * 单次工具输出可膨胀数百 KB 进模型上下文，与本模块"紧凑工具输出"的纪律不符。
 * 截断只在渲染层：持久历史（本工具的检索/读取）仍是全文权威来源。
 */
const MAX_QUOTE_RENDER_BYTES = 512;

/** UTF-8 安全截断：按字符推进，不劈开多字节字符；未超限原样返回。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let output = '';
  let used = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function formatHistory(events: ConversationEventRecord[]): string {
  if (!events.length) return '没有找到相关历史消息。';
  return events.map((event) => {
    const body = event.content ?? `[附件 ${event.artifactRef ?? '无引用'}]`;
    const reference = event.messageReference;
    if (!reference) return `[${event.createdAt}] ${event.kind}: ${body}`;
    let quoted: string;
    if (typeof reference.text !== 'string') {
      quoted = `媒体内容暂未读取，类型：${reference.kind}`;
    } else {
      const preview = truncateUtf8(reference.text, MAX_QUOTE_RENDER_BYTES);
      quoted = `${JSON.stringify(preview)}${reference.truncated ? '（引用文字已截断）' : ''}`
        + `${preview !== reference.text ? '（引用已截断，全文走持久历史检索）' : ''}`;
    }
    return `[${event.createdAt}] ${event.kind}:\n  正文：${JSON.stringify(body)}\n  引用(${reference.kind})：${quoted}`;
  }).join('\n');
}
