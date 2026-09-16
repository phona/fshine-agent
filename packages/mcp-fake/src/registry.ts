import type {
  AccountSet,
  InspectAccountSetResult,
  VoucherDoc,
  VoucherEntry,
} from '@fshine/contracts';

/** 账套注册表种子数据(spec §3 稳定 id);as_001/as_002 让"幻晟"命中两个候选,测澄清路径。 */
export const ACCOUNT_SETS: AccountSet[] = [
  { id: 'as_001', name: '幻晟' },
  { id: 'as_002', name: '幻晟(深圳)' },
  { id: 'as_003', name: '易晟汽车' },
];

export const CURRENT_PERIOD = '202607';

export function accountSetById(id: string): AccountSet | undefined {
  return ACCOUNT_SETS.find((a) => a.id === id);
}

/** 各期间确定性总数;202607 共 45 张。 */
const PERIOD_TOTALS: Record<string, number> = {
  '202605': 12,
  '202606': 23,
  '202607': 45,
};

export function voucherTotalFor(period: string): number {
  return PERIOD_TOTALS[period] ?? 0;
}

const ENTRY_CODE_CYCLE = ['1002', '1122', '2202'];

export function buildVoucherDoc(period: string, n: number): VoucherDoc {
  const year = period.slice(0, 4);
  const month = period.slice(4, 6);
  const day = String(((n * 7) % 28) + 1).padStart(2, '0');
  const amount = n * 100 + 0.25;
  const codeA = ENTRY_CODE_CYCLE[n % ENTRY_CODE_CYCLE.length] ?? '1002';
  const codeB = ENTRY_CODE_CYCLE[(n + 1) % ENTRY_CODE_CYCLE.length] ?? '1122';
  const credit: VoucherEntry = {
    summary: `费用报销事项${n}`,
    accountTitleCode: codeB,
    debitAmount: 0,
    creditAmount: amount,
  };
  if (n % 2 === 0) credit.assistantName = '易晟汽车';
  return {
    id: `doc_${period}_${String(n).padStart(4, '0')}`,
    type: '记',
    number: String(n).padStart(3, '0'),
    journalDate: `${year}-${month}-${day}`,
    haveAnnex: n % 3,
    entryDtoList: [
      { summary: `费用报销事项${n}`, accountTitleCode: codeA, debitAmount: amount, creditAmount: 0 },
      credit,
    ],
  };
}

/** 游标编码:base64url({"pageNo":N}),与 spec 示例 eyJwYWdlTm8iOjF9 同构。 */
export function encodeCursor(pageNo: number): string {
  return Buffer.from(JSON.stringify({ pageNo }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'pageNo' in parsed) {
      const pageNo = (parsed as { pageNo?: unknown }).pageNo;
      if (typeof pageNo === 'number' && Number.isInteger(pageNo) && pageNo >= 0) return pageNo;
    }
    return null;
  } catch {
    return null;
  }
}

export function inspectAccountSet(account: AccountSet): InspectAccountSetResult {
  void account;
  return {
    subjects: [
      { code: '1001', name: '库存现金' },
      { code: '1002', name: '银行存款' },
      { code: '1122', name: '应收账款' },
      { code: '2202', name: '应付账款' },
      { code: '2221', name: '应交税费' },
      { code: '6001', name: '主营业务收入' },
    ],
    assistants: [
      { type: '客户', name: '易晟汽车', id: 'c00089' },
      { type: '供应商', name: '深圳市某某电子有限公司', id: 's00231' },
    ],
    recentVouchers: [
      { voucherNo: '记-045', journalDate: '2026-07-28', summary: '银行手续费', amount: 120.5 },
      { voucherNo: '记-044', journalDate: '2026-07-25', summary: '采购配件-易晟汽车', amount: 4400.25 },
      { voucherNo: '记-043', journalDate: '2026-07-21', summary: '员工差旅报销', amount: 860 },
    ],
  };
}
