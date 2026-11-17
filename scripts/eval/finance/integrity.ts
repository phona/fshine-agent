/**
 * S3/S4/S5 · 财务数据集完整性校验（8 条，纯函数、确定性、零模型）。
 *
 * 每条校验独立成函数，返回**违规列表**（空数组 = 通过）；`INTEGRITY_CHECKS` 登记 8 条，
 * `checkIntegrity` 汇总。违规只报事实（哪条记录、哪个口径），不修数据、不做兜底。
 *
 * 正交性约定（避免一条脏数据被多条校验重复记账，测试据此做「只触发对应一条」的绊线）：
 *   · 单笔应收/单笔收款的累计口径（C5/C6）在 **id 非唯一** 时跳过比较——那是 C1/C2 的
 *     事实，此时「按 id 找唯一对方」不可判定，不得猜；
 *   · C3 已报「引用不存在」时，C5/C6/C7 不再对被引用的脏行做二次判定。
 *
 * 金额单位与日期格式见 `./dataset`。日期为 `YYYY-MM-DD`，可直接字典序比较。
 */
import type { FinanceDataset, Invoice, Receipt, Writeoff } from './dataset';

export type IntegrityCheckId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8';

export interface IntegrityViolation {
  readonly check: IntegrityCheckId;
  /** 违规记录标识（id 或 `arId->receiptId`），便于定位。 */
  readonly subject: string;
  readonly message: string;
}

export interface IntegrityCheck {
  readonly id: IntegrityCheckId;
  readonly name: string;
  readonly run: (dataset: FinanceDataset) => readonly IntegrityViolation[];
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }
  return groups;
}

function sumAmounts(items: readonly { readonly amount: number }[]): number {
  return items.reduce((acc, item) => acc + item.amount, 0);
}

/** C1 · invoice id 唯一。 */
export function checkInvoiceIdUnique(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const [id, rows] of groupBy(dataset.invoices, (row) => row.id)) {
    if (rows.length > 1) {
      violations.push({ check: 'C1', subject: id, message: `invoice id 重复 ${rows.length} 次` });
    }
  }
  return violations;
}

/** C2 · receipt id 唯一。 */
export function checkReceiptIdUnique(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const [id, rows] of groupBy(dataset.receipts, (row) => row.id)) {
    if (rows.length > 1) {
      violations.push({ check: 'C2', subject: id, message: `receipt id 重复 ${rows.length} 次` });
    }
  }
  return violations;
}

/** C3 · 核销引用的 arId / receiptId 必须存在。 */
export function checkWriteoffReferencesExist(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const invoiceIds = new Set(dataset.invoices.map((invoice) => invoice.id));
  const receiptIds = new Set(dataset.receipts.map((receipt) => receipt.id));
  const violations: IntegrityViolation[] = [];
  for (const writeoff of dataset.writeoffs) {
    const subject = `${writeoff.arId}->${writeoff.receiptId}`;
    if (!invoiceIds.has(writeoff.arId)) {
      violations.push({ check: 'C3', subject, message: `核销引用的应收单不存在：${writeoff.arId}` });
    }
    if (!receiptIds.has(writeoff.receiptId)) {
      violations.push({ check: 'C3', subject, message: `核销引用的收款单不存在：${writeoff.receiptId}` });
    }
  }
  return violations;
}

/** C4 · 核销金额必须为正（> 0；0 与负数都不合法）。 */
export function checkWriteoffAmountPositive(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const writeoff of dataset.writeoffs) {
    if (!Number.isFinite(writeoff.amount) || writeoff.amount <= 0) {
      violations.push({
        check: 'C4',
        subject: `${writeoff.arId}->${writeoff.receiptId}`,
        message: `核销金额必须 > 0，实为 ${writeoff.amount}`,
      });
    }
  }
  return violations;
}

/** C5 · 单笔应收累计核销 ≤ 应收金额（id 非唯一时跳过，交 C1）。 */
export function checkInvoiceWriteoffCap(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const invoicesById = groupBy(dataset.invoices, (invoice) => invoice.id);
  const writeoffsByAr = groupBy(dataset.writeoffs, (writeoff) => writeoff.arId);
  const violations: IntegrityViolation[] = [];
  for (const [arId, writeoffs] of writeoffsByAr) {
    const invoices = invoicesById.get(arId);
    if (invoices === undefined || invoices.length !== 1) continue; // C3 / C1 负责
    const invoice = invoices[0] as Invoice;
    const writtenOff = sumAmounts(writeoffs);
    if (writtenOff > invoice.amount) {
      violations.push({
        check: 'C5',
        subject: arId,
        message: `累计核销 ${writtenOff} 超过应收 ${invoice.amount}`,
      });
    }
  }
  return violations;
}

/** C6 · 单笔收款累计分配 ≤ 收款金额（id 非唯一时跳过，交 C2）。 */
export function checkReceiptAllocationCap(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const receiptsById = groupBy(dataset.receipts, (receipt) => receipt.id);
  const writeoffsByReceipt = groupBy(dataset.writeoffs, (writeoff) => writeoff.receiptId);
  const violations: IntegrityViolation[] = [];
  for (const [receiptId, writeoffs] of writeoffsByReceipt) {
    const receipts = receiptsById.get(receiptId);
    if (receipts === undefined || receipts.length !== 1) continue; // C3 / C2 负责
    const receipt = receipts[0] as Receipt;
    const allocated = sumAmounts(writeoffs);
    if (allocated > receipt.amount) {
      violations.push({
        check: 'C6',
        subject: receiptId,
        message: `累计分配 ${allocated} 超过收款 ${receipt.amount}`,
      });
    }
  }
  return violations;
}

/** C7 · 核销生效日不得早于其收款日（`effectiveOn >= receipt.receivedOn`）。 */
export function checkWriteoffEffectiveAfterReceipt(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const receiptsById = groupBy(dataset.receipts, (receipt) => receipt.id);
  const violations: IntegrityViolation[] = [];
  for (const writeoff of dataset.writeoffs) {
    const receipts = receiptsById.get(writeoff.receiptId);
    // 无引用 → C3；id 非唯一 → 收款日不可判定，交 C2（两条都不在此重复记账）。
    if (receipts === undefined || receipts.length !== 1) continue;
    const receipt = receipts[0] as Receipt;
    if (writeoff.effectiveOn < receipt.receivedOn) {
      violations.push({
        check: 'C7',
        subject: `${writeoff.arId}->${writeoff.receiptId}`,
        message: `核销生效日 ${writeoff.effectiveOn} 早于收款日 ${receipt.receivedOn}`,
      });
    }
  }
  return violations;
}

/** C8 · `period` 必须等于 `issuedOn` 的前 7 位（发生月标识，不参与过滤）。 */
export function checkPeriodMatchesIssuedOn(dataset: FinanceDataset): readonly IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const invoice of dataset.invoices) {
    const monthOfIssue = invoice.issuedOn.slice(0, 7);
    if (invoice.period !== monthOfIssue) {
      violations.push({
        check: 'C8',
        subject: invoice.id,
        message: `period ${invoice.period} ≠ issuedOn 月份 ${monthOfIssue}`,
      });
    }
  }
  return violations;
}

/** 8 条校验登记表（顺序稳定 = 编号顺序；测试逐条遍历）。 */
export const INTEGRITY_CHECKS: readonly IntegrityCheck[] = [
  { id: 'C1', name: 'invoice id 唯一', run: checkInvoiceIdUnique },
  { id: 'C2', name: 'receipt id 唯一', run: checkReceiptIdUnique },
  { id: 'C3', name: '核销 arId/receiptId 存在', run: checkWriteoffReferencesExist },
  { id: 'C4', name: '核销金额 > 0', run: checkWriteoffAmountPositive },
  { id: 'C5', name: '单笔应收累计核销 ≤ 应收', run: checkInvoiceWriteoffCap },
  { id: 'C6', name: '单笔收款累计分配 ≤ 收款', run: checkReceiptAllocationCap },
  { id: 'C7', name: 'effectiveOn ≥ receivedOn', run: checkWriteoffEffectiveAfterReceipt },
  { id: 'C8', name: 'period = issuedOn 月份', run: checkPeriodMatchesIssuedOn },
];

/** 汇总 8 条（空数组 = 数据集完整）。 */
export function checkIntegrity(dataset: FinanceDataset): readonly IntegrityViolation[] {
  return INTEGRITY_CHECKS.flatMap((check) => check.run(dataset));
}

/** 类型面导出手（供测试构造局部脏数据时使用）。 */
export type { FinanceDataset, Invoice, Receipt, Writeoff };
