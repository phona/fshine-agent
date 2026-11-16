/**
 * S3/S4/S5 · as-of 真值表测试（S4 Oracle 的真值即此表；数字全部手算可复核）。
 *
 * 断言分三类：
 *   ① 硬编码真值表——按客户与全量逐行比对（这是 Oracle 的输入，改数据必须同步改这里）；
 *   ② 恒等式——每行 应收 − 已核销 = 未结清；客户行合计 = 全量行；
 *   ③ 口径边界——6 类边界样本各自落在哪条记录，且「未来应收排除 / 跨期核销不计入 /
 *      未分配收款不抵扣 / dueOn == asOf 不逾期 / issuedOn == asOf 纳入」逐条可证。
 */
import { describe, expect, it } from 'vitest';
import { AS_OF_DATE, FINANCE_DATASET } from './dataset';
import { asOfInvoice, computeTruth, includedInvoices, includedWriteoffs, type TruthRow } from './truth';

const truth = computeTruth(FINANCE_DATASET);
const includedArIds = includedInvoices(FINANCE_DATASET).map((invoice) => invoice.id);
const includedWriteoffKeys = includedWriteoffs(FINANCE_DATASET).map((writeoff) => `${writeoff.arId}->${writeoff.receiptId}`);

function projectionOf(invoiceId: string) {
  const invoice = FINANCE_DATASET.invoices.find((candidate) => candidate.id === invoiceId);
  if (invoice === undefined) throw new Error(`未知应收 ${invoiceId}`);
  return asOfInvoice(invoice, includedWriteoffs(FINANCE_DATASET), AS_OF_DATE);
}

function rowOf(customer: string): TruthRow {
  const row = truth.byCustomer.find((candidate) => candidate.customer === customer);
  if (row === undefined) throw new Error(`真值表缺客户 ${customer}`);
  return row;
}

describe('真值表（as-of 2026-10-31）', () => {
  it('按客户：应收 / 已核销 / 未结清 / 逾期笔数与金额', () => {
    expect(truth.byCustomer).toEqual([
      { customer: '华远贸易', invoiceCount: 3, receivable: 24000, writtenOff: 13500, outstanding: 10500, overdueCount: 1, overdueAmount: 3500 },
      { customer: '明达物流', invoiceCount: 3, receivable: 25000, writtenOff: 7000, outstanding: 18000, overdueCount: 2, overdueAmount: 9000 },
      { customer: '新程科技', invoiceCount: 3, receivable: 11000, writtenOff: 3000, outstanding: 8000, overdueCount: 0, overdueAmount: 0 },
    ]);
  });

  it('全量：应收 60000 · 已核销 23500 · 未结清 36500 · 逾期 3 笔 / 12500', () => {
    expect(truth.total).toEqual({
      customer: '合计', invoiceCount: 9, receivable: 60000, writtenOff: 23500, outstanding: 36500, overdueCount: 3, overdueAmount: 12500,
    });
  });

  it('恒等式：每行 应收 − 已核销 = 未结清；客户行合计 = 全量行', () => {
    for (const row of [...truth.byCustomer, truth.total]) {
      expect(row.receivable - row.writtenOff).toBe(row.outstanding);
      expect(row.overdueAmount).toBeLessThanOrEqual(row.outstanding);
    }
    const summed = truth.byCustomer.reduce(
      (acc, row) => ({
        invoiceCount: acc.invoiceCount + row.invoiceCount,
        receivable: acc.receivable + row.receivable,
        writtenOff: acc.writtenOff + row.writtenOff,
        outstanding: acc.outstanding + row.outstanding,
        overdueCount: acc.overdueCount + row.overdueCount,
        overdueAmount: acc.overdueAmount + row.overdueAmount,
      }),
      { invoiceCount: 0, receivable: 0, writtenOff: 0, outstanding: 0, overdueCount: 0, overdueAmount: 0 },
    );
    expect(summed).toEqual({
      invoiceCount: truth.total.invoiceCount,
      receivable: truth.total.receivable,
      writtenOff: truth.total.writtenOff,
      outstanding: truth.total.outstanding,
      overdueCount: truth.total.overdueCount,
      overdueAmount: truth.total.overdueAmount,
    });
  });

  it('period 只是发生月标识：按 period 汇总金额仍达全量 60000（不是过滤条件）', () => {
    const byPeriod = new Map<string, number>();
    for (const invoice of includedInvoices(FINANCE_DATASET)) {
      byPeriod.set(invoice.period, (byPeriod.get(invoice.period) ?? 0) + invoice.amount);
    }
    expect([...byPeriod.values()].reduce((acc, amount) => acc + amount, 0)).toBe(60000);
    expect([...byPeriod.keys()].sort()).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });
});

describe('6 类边界样本 + 未分配收款：各自落在哪条记录', () => {
  it('① 完全结清：INV-A-002（6000/6000）、INV-C-001（3000/3000）——已结清即不逾期', () => {
    for (const [id, amount] of [['INV-A-002', 6000], ['INV-C-001', 3000]] as const) {
      const projection = projectionOf(id);
      expect(projection.settlement).toBe('settled');
      expect(projection.writtenOff).toBe(amount);
      expect(projection.outstanding).toBe(0);
      expect(projection.overdue).toBe(false);
    }
  });

  it('② 部分核销：INV-A-001 6500/10000、INV-B-001 7000/12000、INV-A-003 1000/8000', () => {
    const expected = [
      ['INV-A-001', 6500, 3500],
      ['INV-B-001', 7000, 5000],
      ['INV-A-003', 1000, 7000],
    ] as const;
    for (const [id, writtenOff, outstanding] of expected) {
      const projection = projectionOf(id);
      expect(projection.settlement).toBe('partial');
      expect(projection.writtenOff).toBe(writtenOff);
      expect(projection.outstanding).toBe(outstanding);
    }
  });

  it('③ 尚未到期：INV-A-003 / INV-B-002 / INV-C-002 / INV-C-003——未结清 > 0 但不逾期', () => {
    for (const id of ['INV-A-003', 'INV-B-002', 'INV-C-002', 'INV-C-003']) {
      const projection = projectionOf(id);
      expect(projection.outstanding).toBeGreaterThan(0);
      expect(projection.overdue).toBe(false);
      expect(projection.invoice.dueOn >= AS_OF_DATE).toBe(true);
    }
  });

  it('④ 已逾期：INV-A-001（due 06-14）、INV-B-001（due 09-09）、INV-B-003（due 10-25）', () => {
    expect(['INV-A-001', 'INV-B-001', 'INV-B-003'].map((id) => projectionOf(id).overdue)).toEqual([true, true, true]);
    expect(['INV-A-001', 'INV-B-001', 'INV-B-003'].map((id) => projectionOf(id).outstanding)).toEqual([3500, 5000, 4000]);
  });

  it('⑤ 未来应收一律排除：INV-A-004（issuedOn 2026-11-05 > asOf）', () => {
    expect(includedArIds).not.toContain('INV-A-004');
    expect(truth.total.receivable).toBe(60000);
    const allInvoices = FINANCE_DATASET.invoices.reduce((acc, invoice) => acc + invoice.amount, 0);
    expect(allInvoices).toBe(65000);
    expect(allInvoices - truth.total.receivable).toBe(5000);
  });

  it('⑥ 跨期核销不计入：INV-B-003←RCP-005 4000（effectiveOn 2026-11-10 > asOf）', () => {
    expect(includedWriteoffKeys).not.toContain('INV-B-003->RCP-005');
    expect(projectionOf('INV-B-003').writtenOff).toBe(0);
    const allWriteoffs = FINANCE_DATASET.writeoffs.reduce((acc, writeoff) => acc + writeoff.amount, 0);
    expect(allWriteoffs).toBe(27500);
    expect(allWriteoffs - truth.total.writtenOff).toBe(4000);
  });

  it('⑦ 未分配收款不抵扣：RCP-006 2000 无任何核销行', () => {
    const receiptId = 'RCP-006';
    expect(FINANCE_DATASET.writeoffs.some((writeoff) => writeoff.receiptId === receiptId)).toBe(false);
    const receiptsTotal = FINANCE_DATASET.receipts.reduce((acc, receipt) => acc + receipt.amount, 0);
    expect(receiptsTotal).toBe(33000);
    // 若误把收款总额当抵扣，会得到 60000−33000=27000 或再减未分配 2000=34500；正确答案是 36500。
    expect(truth.total.outstanding).toBe(36500);
    expect(truth.total.outstanding).not.toBe(27000);
    expect(truth.total.outstanding).not.toBe(34500);
  });

  it('边界包含性：issuedOn == asOf 纳入（INV-C-003）；dueOn == asOf 不逾期（INV-B-002）', () => {
    expect(projectionOf('INV-C-003').invoice.issuedOn).toBe(AS_OF_DATE);
    expect(includedArIds).toContain('INV-C-003');
    expect(projectionOf('INV-B-002').invoice.dueOn).toBe(AS_OF_DATE);
    expect(projectionOf('INV-B-002').overdue).toBe(false);
    expect(projectionOf('INV-B-002').outstanding).toBe(9000);
  });
});

describe('按客户筛选（第 3 号交互口径）', () => {
  it('单客户真值 = 该客户行；换客户不串户', () => {
    expect(rowOf('华远贸易')).toEqual(truth.byCustomer[0]);
    expect(rowOf('明达物流').outstanding).toBe(18000);
    expect(rowOf('新程科技').overdueCount).toBe(0);
    expect(new Set(truth.byCustomer.map((row) => row.customer)).size).toBe(truth.byCustomer.length);
  });
});
