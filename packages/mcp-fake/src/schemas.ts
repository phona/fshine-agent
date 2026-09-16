import { READ_TOOLS, type ReadToolName } from '@fshine/contracts';

/** tools/list 返回的 inputSchema,逐字对齐 docs/17dz-mcp-spec.md §6.2,客户端零依赖 17dz 源码。 */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: ReadToolName;
  description: string;
  inputSchema: JsonSchema;
}

const GET_LOGIN_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const SEARCH_ACCOUNT_SETS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
  },
};

const GET_CURRENT_ACCOUNTING_PERIOD_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountSetId'],
  additionalProperties: false,
  properties: {
    accountSetId: { type: 'string', minLength: 1 },
  },
};

const LIST_VOUCHERS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountSetId', 'period'],
  additionalProperties: false,
  properties: {
    accountSetId: { type: 'string', minLength: 1 },
    period: { type: 'string', pattern: '^\\d{6}$' },
    pageNo: { type: 'integer', minimum: 0 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    allPages: { type: 'boolean', description: '仅 true 有意义:拉全期间(服务端上限 1000 张)' },
    cursor: { type: 'string', description: '分页游标(上一页响应的 nextCursor)' },
  },
  oneOf: [
    {
      comment: '默认模式:不传任何分页参数 = 首页 20 张',
      not: {
        anyOf: [
          { required: ['pageNo'] },
          { required: ['allPages'] },
          { required: ['cursor'] },
        ],
      },
    },
    {
      comment: '手动翻页',
      required: ['pageNo'],
      not: { anyOf: [{ required: ['allPages'] }, { required: ['cursor'] }] },
    },
    {
      comment: '拉全(allPages 仅 const true 命中,false 不算数)',
      required: ['allPages'],
      properties: { allPages: { const: true } },
      not: { anyOf: [{ required: ['pageNo'] }, { required: ['cursor'] }] },
    },
    {
      comment: '游标续翻',
      required: ['cursor'],
      not: { anyOf: [{ required: ['pageNo'] }, { required: ['allPages'] }] },
    },
  ],
};

const INSPECT_ACCOUNT_SET_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountSetId'],
  additionalProperties: false,
  properties: {
    accountSetId: { type: 'string', minLength: 1 },
    task: { type: 'string', description: '可选,摸底侧重点提示(如 bills)' },
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_login_status',
    description:
      '检查 幻账平台登录态。返回 { loggedIn: bool }。loggedIn=false 时尽快通知人工处理登录(本系统不处理凭据,没有自动登录)。',
    inputSchema: GET_LOGIN_STATUS_INPUT_SCHEMA,
  },
  {
    name: 'search_account_sets',
    description:
      '在工作台按名称模糊搜索账套,返回 [{id, name}](受部署的 ALLOWED_ACCOUNT_SETS 约束)。id 是稳定定位标识,后续所有 tool(含 VoucherContract)都用 id;name 仅供展示。这是定位 accountSetId 的第一步——不确定时先搜,不要猜。',
    inputSchema: SEARCH_ACCOUNT_SETS_INPUT_SCHEMA,
  },
  {
    name: 'get_current_accounting_period',
    description:
      '查询账套当前会计期间(如 202607,格式 YYYYMM)。期间参数一律以本工具返回为准,不要自行推算。',
    inputSchema: GET_CURRENT_ACCOUNTING_PERIOD_INPUT_SCHEMA,
  },
  {
    name: 'list_vouchers',
    description:
      '查询指定账套某期间的记账凭证列表(只读)。分页四模式互斥(schema 的 oneOf 强制,违反直接校验失败):①不传任何分页参数=默认首页 20 张;②pageNo(+pageSize) 手动翻页;③allPages=true 一次拉全(服务端上限 1000 张=10 页);④cursor 用上一页响应的 nextCursor 续翻。返回的 docs 为平台 docDto:{ id, type(凭证字), number(凭证号), journalDate(记账日期 YYYY-MM-DD), haveAnnex(附件数), entryDtoList:[{ summary, accountTitleCode, debitAmount, creditAmount, assistantName }] }。凭证显示号 = type + \'-\' + number(如 记-001)。',
    inputSchema: LIST_VOUCHERS_INPUT_SCHEMA,
  },
  {
    name: 'inspect_account_set',
    description:
      '账套摸底:科目表 + 辅助核算档案 + 近期历史凭证。用于『这家账套的科目/对手方怎么记』这类只能现查的问题。meta.source=cache 表示命中缓存未重新抓取。数据是平台当前现状,会随时间变化,不要长期留存当作不变事实。',
    inputSchema: INSPECT_ACCOUNT_SET_INPUT_SCHEMA,
  },
];

export function toolDefinitionFor(name: ReadToolName): ToolDefinition {
  const found = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!found) throw new Error(`未知的 read tool: ${name}`);
  return found;
}

/** 顺序与 READ_TOOLS 一致,供测试断言。 */
export const TOOL_NAMES: readonly string[] = [...READ_TOOLS];
