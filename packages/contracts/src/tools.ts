/**
 * V0 read server 的 5 个 tool 契约(spec §6.2)。
 * 运行时真相是 tools/list 返回的 inputSchema;此处的类型供 host / agent / fake server 共用。
 */

export const READ_TOOLS = [
  'get_login_status',
  'search_account_sets',
  'get_current_accounting_period',
  'list_vouchers',
  'inspect_account_set',
] as const;

export type ReadToolName = (typeof READ_TOOLS)[number];

export interface AccountSet {
  /** 稳定 id,server 注册表维护;权限、缓存、审计一律用它 */
  id: string;
  /** 仅供展示 */
  name: string;
}

// ---- get_login_status ----

export interface GetLoginStatusArgs {}

export interface GetLoginStatusResult {
  loggedIn: boolean;
}

// ---- search_account_sets ----

export interface SearchAccountSetsArgs {
  query: string;
}

export interface SearchAccountSetsResult {
  accountSets: AccountSet[];
}

// ---- get_current_accounting_period ----

export interface GetCurrentAccountingPeriodArgs {
  accountSetId: string;
}

/** YYYYMM,如 202607;期间一律以本工具返回为准 */
export interface GetCurrentAccountingPeriodResult {
  period: string;
}

// ---- list_vouchers ----

export interface ListVouchersArgs {
  accountSetId: string;
  /** YYYYMM */
  period: string;
  /** 分页四模式互斥(schema oneOf 强制):①不传=首页20 ②pageNo(+pageSize) ③allPages=true ④cursor */
  pageNo?: number;
  pageSize?: number;
  allPages?: boolean;
  /** 上一页响应的 nextCursor */
  cursor?: string;
}

export interface VoucherEntry {
  summary: string;
  accountTitleCode: string;
  debitAmount: number;
  creditAmount: number;
  assistantName?: string;
}

/** 平台 docDto;凭证显示号 = type + '-' + number(如 记-001) */
export interface VoucherDoc {
  id: string;
  /** 凭证字,如 记 */
  type: string;
  /** 凭证号,如 001 */
  number: string;
  /** 记账日期 YYYY-MM-DD */
  journalDate: string;
  /** 附件数 */
  haveAnnex: number;
  entryDtoList: VoucherEntry[];
}

export interface ListVouchersResult {
  total: number;
  docs: VoucherDoc[];
  /** 仅在还有后续页时返回;allPages 模式不返回 */
  nextCursor?: string;
}

// ---- inspect_account_set ----

export interface InspectAccountSetArgs {
  accountSetId: string;
  /** 可选,摸底侧重点提示(如 bills) */
  task?: string;
}

export interface InspectSubject {
  code: string;
  name: string;
}

export interface InspectAssistant {
  /** 如 客户 / 供应商 */
  type: string;
  name: string;
  id: string;
}

export interface InspectAccountSetResult {
  subjects: InspectSubject[];
  assistants: InspectAssistant[];
  /** spec 未定死结构,原样透传;数据是平台现状,不要长期留存当作不变事实 */
  recentVouchers: Array<Record<string, unknown>>;
}

// ---- 按名字取参/取结果的映射 ----

export interface ReadToolArgsMap {
  get_login_status: GetLoginStatusArgs;
  search_account_sets: SearchAccountSetsArgs;
  get_current_accounting_period: GetCurrentAccountingPeriodArgs;
  list_vouchers: ListVouchersArgs;
  inspect_account_set: InspectAccountSetArgs;
}

export interface ReadToolResultMap {
  get_login_status: GetLoginStatusResult;
  search_account_sets: SearchAccountSetsResult;
  get_current_accounting_period: GetCurrentAccountingPeriodResult;
  list_vouchers: ListVouchersResult;
  inspect_account_set: InspectAccountSetResult;
}
