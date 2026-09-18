import type {
  AccountSet,
  AssistantReferenceCandidate,
  InspectAccountSetResult,
  SearchReferencesArgs,
  SearchReferencesResult,
  SubjectReferenceCandidate,
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

/** 游标编码:base64url({"offset":N}),与真实 17dz 的 offset 游标同构。 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'offset' in parsed) {
      const offset = (parsed as { offset?: unknown }).offset;
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
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

// ---- search_references ----

export interface FakeSubject {
  id: string;
  code: string;
  name: string;
  useAssistant: boolean;
  assistantType: 'customer' | 'supplier' | 'employee' | 'other' | null;
}

export interface FakeAssistant {
  id: string;
  code: string;
  name: string;
  type: 'customer' | 'supplier';
}

/** 各账套独立的全量科目表 + 客户/供应商档案;as_001 与 as_003 无交集,测跨账套隔离。 */
export const FAKE_REFERENCES: Record<string, { subjects: FakeSubject[]; assistants: FakeAssistant[] }> = {
  as_001: {
    subjects: [
      { id: 's1001', code: '1001', name: '库存现金', useAssistant: false, assistantType: null },
      { id: 's1002', code: '1002', name: '银行存款', useAssistant: false, assistantType: null },
      { id: 's1122', code: '1122', name: '应收账款', useAssistant: true, assistantType: 'customer' },
      { id: 's2202', code: '2202', name: '应付账款', useAssistant: true, assistantType: 'supplier' },
      { id: 's6001', code: '6001', name: '主营业务收入', useAssistant: false, assistantType: null },
    ],
    assistants: [
      { id: 'c1', code: '00001', name: '客户甲', type: 'customer' },
      { id: 's1', code: '10001', name: '供应商乙', type: 'supplier' },
    ],
  },
  // as_002 幻晟(深圳):与 as_001 同名账套但档案独立
  as_002: {
    subjects: [
      { id: 't1002', code: '1002', name: '银行存款', useAssistant: false, assistantType: null },
      { id: 't1122', code: '1122', name: '应收账款', useAssistant: true, assistantType: 'customer' },
    ],
    assistants: [
      { id: 'c2', code: '00002', name: '客户甲(深圳)', type: 'customer' },
    ],
  },
  as_003: {
    subjects: [
      { id: 'u1001', code: '1001', name: '库存现金', useAssistant: false, assistantType: null },
      { id: 'u1002', code: '1002', name: '银行存款', useAssistant: false, assistantType: null },
      { id: 'u1122', code: '1122', name: '应收账款', useAssistant: true, assistantType: 'customer' },
      // 员工类辅助核算:平台适配器未加载该档案 → unavailable 场景
      { id: 'u1221', code: '1221', name: '其他应收款', useAssistant: true, assistantType: 'employee' },
      { id: 'u2202', code: '2202', name: '应付账款', useAssistant: true, assistantType: 'supplier' },
      { id: 'u6601', code: '6601', name: '销售费用', useAssistant: true, assistantType: 'other' },
    ],
    assistants: [
      { id: '283655291', code: '00002', name: '幻州幻东机械制造有限公司', type: 'customer' },
      { id: 'c00089', code: '00089', name: '易晟汽车', type: 'customer' },
      { id: 's00702', code: '00702', name: '幻州幻东供应链管理有限公司', type: 'supplier' },
      { id: 's00231', code: '00231', name: '易晟汽车', type: 'supplier' },
    ],
  },
};

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function statusOf(count: number): SearchReferencesResult['status'] {
  if (count === 1) return 'matched';
  return count > 1 ? 'ambiguous' : 'not_found';
}

export function searchReferences(account: AccountSet, args: SearchReferencesArgs): SearchReferencesResult {
  const referenceType = args.referenceType;
  const query = args.query;
  const base = { referenceType, query };

  // 第一阶段只支持 subject/assistant;employee 等如实报 unavailable
  if (referenceType !== 'subject' && referenceType !== 'assistant') {
    return {
      ...base,
      status: 'unavailable',
      candidates: [],
      details: {
        reason: `referenceType "${referenceType}" 当前平台暂不支持查询`,
        supportedTypes: ['subject', 'assistant'],
      },
    };
  }

  const data = FAKE_REFERENCES[account.id] ?? { subjects: [], assistants: [] };
  const filters = args.filters ?? {};
  const requestedType = filters.assistantType;
  if (requestedType === 'employee' || requestedType === 'other') {
    return {
      ...base,
      status: 'unavailable',
      candidates: [],
      details: {
        reason: `assistantType "${requestedType}" 的完整档案当前平台适配器未加载`,
        supportedTypes: ['subject', 'assistant'],
        supportedAssistantTypes: ['customer', 'supplier'],
      },
    };
  }

  if (referenceType === 'subject') {
    let subjects = data.subjects;
    if (filters.subjectCode) {
      subjects = subjects.filter((s) => s.code === filters.subjectCode);
    }
    const norm = normalize(query);
    let tier = subjects.filter((s) => s.code === query.trim());
    if (tier.length === 0) tier = subjects.filter((s) => normalize(s.id) === norm);
    if (tier.length === 0) tier = subjects.filter((s) => normalize(s.name) === norm);
    if (tier.length === 0) {
      tier = subjects.filter((s) => normalize(s.name).includes(norm) || normalize(s.code).includes(norm));
    }
    const candidates: SubjectReferenceCandidate[] = tier.map((s) => ({
      id: s.id, code: s.code, name: s.name, useAssistant: s.useAssistant, assistantType: s.assistantType,
    }));
    return { ...base, status: statusOf(candidates.length), candidates };
  }

  // assistant:subjectCode 按科目的辅助核算类型收窄;科目不存在/未启用辅助核算如实 not_found
  let scopeTypes: Array<'customer' | 'supplier'> = ['customer', 'supplier'];
  if (filters.subjectCode) {
    const subject = data.subjects.find((s) => s.code === filters.subjectCode);
    if (!subject) {
      return {
        ...base, status: 'not_found', candidates: [],
        details: { reason: `filters.subjectCode ${filters.subjectCode} 在当前账套科目表中不存在` },
      };
    }
    if (!subject.useAssistant) {
      return {
        ...base, status: 'not_found', candidates: [],
        details: { reason: `科目 ${subject.code}(${subject.name}) 未启用辅助核算` },
      };
    }
    if (subject.assistantType === 'employee' || subject.assistantType === 'other' || subject.assistantType === null) {
      return {
        ...base,
        status: 'unavailable',
        candidates: [],
        details: {
          reason: `科目 ${subject.code} 的辅助核算类型为 ${subject.assistantType ?? '未知'},当前平台适配器仅加载客户/供应商完整档案`,
          supportedTypes: ['subject', 'assistant'],
          supportedAssistantTypes: ['customer', 'supplier'],
        },
      };
    }
    scopeTypes = [subject.assistantType];
  }

  const norm = normalize(query);
  const raw = query.trim();
  const candidates: AssistantReferenceCandidate[] = [];
  for (const type of scopeTypes) {
    if (requestedType && type !== requestedType) continue;
    const pool = data.assistants.filter((a) => a.type === type);
    let tier = pool.filter((a) => a.code === raw);
    if (tier.length === 0) tier = pool.filter((a) => normalize(a.id) === norm);
    if (tier.length === 0) tier = pool.filter((a) => normalize(a.name) === norm);
    if (tier.length === 0) {
      tier = pool.filter((a) => normalize(a.name).includes(norm) || normalize(a.code).includes(norm));
    }
    for (const a of tier) {
      if (!candidates.some((c) => c.id === a.id)) {
        candidates.push({ id: a.id, code: a.code, name: a.name, type });
      }
    }
  }
  return { ...base, status: statusOf(candidates.length), candidates };
}
