/**
 * S3/S4/S5 · as-of 真值表（S4 Oracle 的输入；纯函数、确定性、零模型）。
 *
 * 口径严格按 v5 §2（与 `./dataset` 文件头一致）：
 *   · 应收纳入 = `issuedOn <= asOfDate`；核销纳入 = `effectiveOn <= asOfDate`；
 *   · `period` 不参与任何过滤；
 *   · 未结清（单笔）= 应收金额 − 该单 as-of 内的累计核销；
 *   · 逾期 = `dueOn < asOfDate`（严格）且未结清 > 0；
 *   · 收款只在被核销行引用时才影响未结清——**未分配收款不抵扣**。
 *
 * 本模块不读模型、不读 env、不触网；真值只由 `FinanceDataset` 机械推导，可逐笔手算复核：
 *
 *   华远贸易
 *     INV-A-001 10000  核销 4000(RCP-001)+2500(RCP-007)=6500 → 未结清 3500  到期 06-14 → 逾期
 *     INV-A-002  6000  核销 6000(RCP-002)                    → 未结清    0  结清（不逾期）
 *     INV-A-003  8000  核销 1000(RCP-001)                    → 未结清 7000  到期 11-19 → 未到期
 *     INV-A-004  5000  issuedOn 11-05 > asOf                 → 整笔排除
 *     小计：应收 24000 · 核销 13500 · 未结清 10500 · 逾期 1 笔 / 3500
 *
 *   明达物流
 *     INV-B-001 12000  核销 7000(RCP-003)                    → 未结清 5000  到期 09-09 → 逾期
 *     INV-B-002  9000  无核销                                → 未结清 9000  到期 10-31 = asOf → 不逾期
 *     INV-B-003  4000  核销 4000 但 effectiveOn 11-10 > asOf → 不计入 → 未结清 4000、到期 10-25 → 逾期
 *     小计：应收 25000 · 核销 7000 · 未结清 18000 · 逾期 2 笔 / 9000
 *
 *   新程科技
 *     INV-C-001  3000  核销 3000(RCP-004)                    → 未结清    0  结清
 *     INV-C-002  7000  无核销                                → 未结清 7000  到期 12-15 → 未到期
 *     INV-C-003  1000  issuedOn 10-31 = asOf（纳入）、无核销  → 未结清 1000  到期 11-15 → 未到期
 *     小计：应收 11000 · 核销 3000 · 未结清 8000 · 逾期 0 笔 / 0
 *
 *   全量：应收 60000 · 核销 23500 · 未结清 36500 · 逾期 3 笔 / 12500
 *   未分配收款 RCP-006 2000 不被任何核销引用 → 不抵扣；若误减，全量未结清会算成 34500（错）。
 */
import { AS_OF_DATE, CUSTOMERS, type FinanceDataset, type Invoice, type Writeoff } from './dataset';

/** 单笔应收在 as-of 口径下的结清状态。 */
export type Settlement = 'settled' | 'partial' | 'unpaid';

/** 单笔应收的 as-of 投影。 */
export interface InvoiceAsOf {
  readonly invoice: Invoice;
  /** 该单在 as-of 内被纳入的累计核销。 */
  readonly writtenOff: number;
  /** 未结清 = 应收 − 已核销。 */
  readonly outstanding: number;
  readonly settlement: Settlement;
  /** `dueOn < asOfDate` 且未结清 > 0。 */
  readonly overdue: boolean;
}

/** 真值表的一行（客户或全量）。 */
export interface TruthRow {
  /** 客户名；全量行为 `'合计'`。 */
  readonly customer: string;
  /** 纳入 as-of 的应收笔数（未来应收已排除）。 */
  readonly invoiceCount: number;
  readonly receivable: number;
  readonly writtenOff: number;
  readonly outstanding: number;
  readonly overdueCount: number;
  readonly overdueAmount: number;
}

export interface TruthTable {
  readonly asOfDate: string;
  /** 按 `CUSTOMERS` 顺序。 */
  readonly byCustomer: readonly TruthRow[];
  readonly total: TruthRow;
}

/** as-of 纳入的应收（`issuedOn <= asOfDate`，含当日）。 */
export function includedInvoices(dataset: FinanceDataset, asOfDate: string = AS_OF_DATE): readonly Invoice[] {
  return dataset.invoices.filter((invoice) => invoice.issuedOn <= asOfDate);
}

/** as-of 纳入的核销（`effectiveOn <= asOfDate`，含当日）；跨期核销不计入。 */
export function includedWriteoffs(dataset: FinanceDataset, asOfDate: string = AS_OF_DATE): readonly Writeoff[] {
  return dataset.writeoffs.filter((writeoff) => writeoff.effectiveOn <= asOfDate);
}

/** 单笔应收的 as-of 投影（`writeoffs` 须已按 as-of 过滤，见 `includedWriteoffs`）。 */
export function asOfInvoice(invoice: Invoice, writeoffs: readonly Writeoff[], asOfDate: string = AS_OF_DATE): InvoiceAsOf {
  const writtenOff = writeoffs
    .filter((writeoff) => writeoff.arId === invoice.id)
    .reduce((acc, writeoff) => acc + writeoff.amount, 0);
  const outstanding = invoice.amount - writtenOff;
  const settlement: Settlement = outstanding === 0 ? 'settled' : writtenOff === 0 ? 'unpaid' : 'partial';
  return { invoice, writtenOff, outstanding, settlement, overdue: invoice.dueOn < asOfDate && outstanding > 0 };
}

function emptyRow(customer: string): TruthRow {
  return { customer, invoiceCount: 0, receivable: 0, writtenOff: 0, outstanding: 0, overdueCount: 0, overdueAmount: 0 };
}

/** 计算 as-of 真值表（按客户 + 全量）。未知客户直接抛错，不静默丢弃。 */
export function computeTruth(
  dataset: FinanceDataset,
  asOfDate: string = AS_OF_DATE,
  customers: readonly string[] = CUSTOMERS,
): TruthTable {
  const invoices = includedInvoices(dataset, asOfDate);
  const writeoffs = includedWriteoffs(dataset, asOfDate);
  const known = new Set(customers);
  for (const invoice of invoices) {
    if (!known.has(invoice.customer)) {
      throw new Error(`应收 ${invoice.id} 的客户 ${invoice.customer} 未在 CUSTOMERS 登记（不得静默丢弃）`);
    }
  }

  const rows = new Map<string, TruthRow>(customers.map((customer) => [customer, emptyRow(customer)]));
  for (const invoice of invoices) {
    const projection = asOfInvoice(invoice, writeoffs, asOfDate);
    const row = rows.get(invoice.customer) as TruthRow;
    rows.set(invoice.customer, {
      customer: row.customer,
      invoiceCount: row.invoiceCount + 1,
      receivable: row.receivable + invoice.amount,
      writtenOff: row.writtenOff + projection.writtenOff,
      outstanding: row.outstanding + projection.outstanding,
      overdueCount: row.overdueCount + (projection.overdue ? 1 : 0),
      overdueAmount: row.overdueAmount + (projection.overdue ? projection.outstanding : 0),
    });
  }

  const byCustomer = customers.map((customer) => rows.get(customer) as TruthRow);
  const total = byCustomer.reduce<TruthRow>((acc, row) => ({
    customer: '合计',
    invoiceCount: acc.invoiceCount + row.invoiceCount,
    receivable: acc.receivable + row.receivable,
    writtenOff: acc.writtenOff + row.writtenOff,
    outstanding: acc.outstanding + row.outstanding,
    overdueCount: acc.overdueCount + row.overdueCount,
    overdueAmount: acc.overdueAmount + row.overdueAmount,
  }), emptyRow('合计'));

  return { asOfDate, byCustomer, total };
}
