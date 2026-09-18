import { READ_TOOLS, type ReadToolName, type WriteToolName } from '@fshine/contracts';

/** tools/list 返回的 inputSchema,逐字对齐 docs/17dz-mcp-spec.md §6.2,客户端零依赖 17dz 源码。 */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: ReadToolName | WriteToolName;
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
    pageSize: { type: 'integer', minimum: 1, maximum: 20, default: 4 },
    allPages: { type: 'boolean', description: '仅 true 有意义:拉全期间(服务端上限 1000 张)' },
    cursor: { type: 'string', description: '分页游标(上一页响应的 nextCursor)' },
  },
  oneOf: [
    {
      comment: '默认模式:不传任何分页参数 = 首页 4 张',
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

const SEARCH_REFERENCES_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountSetId', 'referenceType', 'query'],
  additionalProperties: false,
  properties: {
    accountSetId: { type: 'string', minLength: 1 },
    referenceType: { type: 'string', minLength: 1, description: '第一阶段支持 subject | assistant;其他值(如 employee)返回 status=unavailable' },
    query: { type: 'string', minLength: 1, description: '名称/简称/编码/关键字,非空' },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subjectCode: { type: 'string', pattern: '^\\d{4,}$', description: 'assistant 查询限定科目(按科目的辅助核算类型收窄客户/供应商)' },
        assistantType: { enum: ['customer', 'supplier', 'employee', 'other'] },
      },
    },
  },
};

const VOUCHER_CONTRACT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountSetId', 'entries'],
  additionalProperties: false,
  properties: {
    accountSetId: { type: 'string', minLength: 1, description: '账套稳定 id（search_account_sets 获取）' },
    date: { type: 'string', format: 'date', description: '凭证日期 YYYY-MM-DD（可选）' },
    template: { type: 'string', description: '模板标注（可选），执行器不依赖' },
    voucherNo: { type: 'string', description: '记字第（可选）。不填用页面自动号' },
    entries: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['summary', 'subjectCode'], additionalProperties: false,
        properties: {
          summary: { type: 'string', minLength: 1 },
          subjectCode: { type: 'string', minLength: 1, description: '科目编码，如 1121' },
          assistantName: { type: 'string', minLength: 1, description: '辅助核算名称（客户/供应商），可选' },
          debit: { type: 'number', minimum: 0 },
          credit: { type: 'number', minimum: 0 },
        },
      },
    },
  },
};

const VALIDATE_VOUCHER_INPUT_SCHEMA: JsonSchema = {
  type: 'object', required: ['contract'], additionalProperties: false,
  properties: { contract: VOUCHER_CONTRACT_SCHEMA },
};

const SUBMIT_VOUCHER_INPUT_SCHEMA: JsonSchema = {
  type: 'object', required: ['contract', 'idempotencyKey'], additionalProperties: false,
  properties: {
    contract: VOUCHER_CONTRACT_SCHEMA,
    idempotencyKey: { type: 'string', minLength: 1, description: '调用方生成的 UUID，自行留存' },
    confirmed: { type: 'boolean', default: false },
  },
};

const SUBMIT_VOUCHER_BATCH_INPUT_SCHEMA: JsonSchema = {
  type: 'object', required: ['contracts', 'idempotencyKey'], additionalProperties: false,
  properties: {
    contracts: { type: 'array', minItems: 1, maxItems: 100, description: 'VoucherContract 数组，index 即结果里的 index / 台账键的 :index', items: VOUCHER_CONTRACT_SCHEMA },
    idempotencyKey: { type: 'string', minLength: 1, description: 'batchKey：调用方生成的 UUID，自行留存' },
    confirmed: { type: 'boolean', default: false },
  },
};

const GET_SUBMISSION_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object', required: ['tool', 'idempotencyKey'], additionalProperties: false,
  properties: {
    tool: { enum: ['submit_voucher', 'submit_voucher_batch'] },
    idempotencyKey: { type: 'string', minLength: 1 },
  },
};

const WRITE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'validate_voucher',
    description: '离线校验记账凭证契约（不起浏览器，秒回）。跑结构与业务规则校验：借贷平衡、借贷互斥、非零，并检查账套解析与部署范围。契约怎么改、改完对不对，用这个工具迭代，不要直接 submit。',
    inputSchema: VALIDATE_VOUCHER_INPUT_SCHEMA,
  },
  {
    name: 'submit_voucher',
    description: '录入一张记账凭证。confirmed=false（默认）= dry-run，返回预览且不落库、不写幂等台账；confirmed=true 才真正执行。幂等状态机见规范 §8。',
    inputSchema: SUBMIT_VOUCHER_INPUT_SCHEMA,
  },
  {
    name: 'submit_voucher_batch',
    description: '批量录入凭证（1~100 张）。confirmed=false（默认）返回逐张预览且不写台账；confirmed=true 时任一张校验不过则整批拒绝，成功或失败快照可按 batchKey 幂等重放。',
    inputSchema: SUBMIT_VOUCHER_BATCH_INPUT_SCHEMA,
  },
  {
    name: 'get_submission_status',
    description: '查询写操作幂等台账（只读，不进执行队列）。batch 单张查询用 `${batchKey}:${index}` 与 submit_voucher；整批查询用 batchKey 与 submit_voucher_batch。',
    inputSchema: GET_SUBMISSION_STATUS_INPUT_SCHEMA,
  },
];

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
      '查询指定账套某期间的记账凭证列表(只读)。分页四模式互斥(schema 的 oneOf 强制,违反直接校验失败):①不传任何分页参数=默认首页 4 张;②pageNo(+pageSize) 手动翻页;③allPages=true 一次拉全(服务端上限 1000 张=10 页);④cursor 用上一页响应的 nextCursor 续翻。返回的 docs 为平台 docDto:{ id, type(凭证字), number(凭证号), journalDate(记账日期 YYYY-MM-DD), haveAnnex(附件数), entryDtoList:[{ summary, accountTitleCode, debitAmount, creditAmount, assistantName }] }。凭证显示号 = type + \'-\' + number(如 记-001)。',
    inputSchema: LIST_VOUCHERS_INPUT_SCHEMA,
  },
  {
    name: 'inspect_account_set',
    description:
      '账套摸底:科目表 + 辅助核算档案 + 近期历史凭证。用于『这家账套的科目/对手方怎么记』这类只能现查的问题。meta.source=cache 表示命中缓存未重新抓取。数据是平台当前现状,会随时间变化,不要长期留存当作不变事实。摸底样本不完整,解析具体科目/客户/供应商稳定 id 请用 search_references。',
    inputSchema: INSPECT_ACCOUNT_SET_INPUT_SCHEMA,
  },
  {
    name: 'search_references',
    description:
      '把用户输入的名称/简称/编码/关键字模糊解析成当前账套内的稳定 id(只读,用平台真实档案,绝不猜 id)。referenceType:subject=科目(候选含 id/code/name/useAssistant/assistantType),assistant=客户/供应商辅助档案(候选含 id/code/name/type)。返回统一形状 {referenceType, status, query, candidates, details?};status:matched 唯一匹配(可直接拿 id 查余额/明细),ambiguous 多候选(列出候选让用户选,不要自动挑),not_found 无匹配,unavailable 该 referenceType 平台暂不支持。filters.assistantType=customer/supplier、filters.subjectCode 可收窄候选。推荐流程:search_references(referenceType="assistant") → assistantId → get_auxiliary_balance(assistantId)。',
    inputSchema: SEARCH_REFERENCES_INPUT_SCHEMA,
  },
  ...WRITE_TOOL_DEFINITIONS,
];

export function toolDefinitionFor(name: ReadToolName | WriteToolName): ToolDefinition {
  const found = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!found) throw new Error(`未知的 tool: ${name}`);
  return found;
}

/** 顺序与 READ_TOOLS 一致,供测试断言。 */
export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((tool) => tool.name);
