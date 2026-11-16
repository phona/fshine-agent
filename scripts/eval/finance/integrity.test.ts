/**
 * S3/S4/S5 · 数据集完整性校验测试（8 条逐条 + 反向绊线）。
 *
 * 两层：
 *   ① 真实数据集上 8 条逐条零违规（正向）；
 *   ② 对每条校验各注入一条明确、且**只应触发对应一条**的脏数据（反向绊线）——
 *      若把某条校验删掉/写空，对应用例立刻红；若校验之间串扰，`toEqual([id])` 也会红。
 *
 * 脏数据只作用于内存副本，不改 `FINANCE_DATASET`（共享常量）。
 */
import { describe, expect, it } from 'vitest';
import { AS_OF_DATE, CUSTOMERS, FINANCE_DATASET, type FinanceDataset, type Invoice, type Receipt, type Writeoff } from './dataset';
import { checkIntegrity, INTEGRITY_CHECKS } from './integrity';

function withRows(overrides: {
  invoices?: readonly Invoice[];
  receipts?: readonly Receipt[];
  writeoffs?: readonly Writeoff[];
}): FinanceDataset {
  return {
    invoices: overrides.invoices ?? FINANCE_DATASET.invoices,
    receipts: overrides.receipts ?? FINANCE_DATASET.receipts,
    writeoffs: overrides.writeoffs ?? FINANCE_DATASET.writeoffs,
  };
}

/** 追加一行（返回新数组，不动原数组）。 */
function appended<T>(rows: readonly T[], row: T): readonly T[] {
  return [...rows, row];
}

/** 断言：脏数据只触发 `expected` 这一条校验（顺序无关 = 恰好一条，且是该条）。 */
function expectOnly(dataset: FinanceDataset, expected: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8'): void {
  const violations = checkIntegrity(dataset);
  expect([...new Set(violations.map((violation) => violation.check))]).toEqual([expected]);
}

describe('数据集形状不变量', () => {
  it('asOfDate 固定为 2026-10-31', () => {
    expect(AS_OF_DATE).toBe('2026-10-31');
  });

  it('至少 2 个客户、每个客户至少 1 笔应收、客户名全部登记', () => {
    expect(CUSTOMERS.length).toBeGreaterThanOrEqual(2);
    const known = new Set<string>(CUSTOMERS);
    for (const invoice of FINANCE_DATASET.invoices) {
      expect(known.has(invoice.customer)).toBe(true);
    }
    for (const customer of CUSTOMERS) {
      expect(FINANCE_DATASET.invoices.some((invoice) => invoice.customer === customer)).toBe(true);
    }
  });

  it('8 条校验按 C1..C8 登记，编号不重不漏', () => {
    expect(INTEGRITY_CHECKS.map((check) => check.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  });
});

describe('正向：真实数据集 8 条逐条零违规', () => {
  for (const check of INTEGRITY_CHECKS) {
    it(`${check.id} · ${check.name}`, () => {
      expect(check.run(FINANCE_DATASET)).toEqual([]);
    });
  }

  it('checkIntegrity 汇总为空', () => {
    expect(checkIntegrity(FINANCE_DATASET)).toEqual([]);
  });
});

describe('反向绊线：每类违规恰好触发对应一条校验', () => {
  it('C1 · invoice id 重复', () => {
    const dirty = withRows({
      invoices: appended(FINANCE_DATASET.invoices, {
        id: 'INV-A-001', amount: 1, customer: '华远贸易', issuedOn: '2026-10-01', dueOn: '2026-10-01', period: '2026-10',
      }),
    });
    expectOnly(dirty, 'C1');
    expect(checkIntegrity(dirty)).toHaveLength(1);
  });

  it('C2 · receipt id 重复', () => {
    const dirty = withRows({
      receipts: appended(FINANCE_DATASET.receipts, { id: 'RCP-001', amount: 1, receivedOn: '2026-10-01' }),
    });
    expectOnly(dirty, 'C2');
    expect(checkIntegrity(dirty)).toHaveLength(1);
  });

  it('C3 · 核销引用不存在的应收单', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-X-999', receiptId: 'RCP-006', amount: 100, effectiveOn: '2026-10-20',
      }),
    });
    expectOnly(dirty, 'C3');
  });

  it('C3 · 核销引用不存在的收款单', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-C-002', receiptId: 'RCP-X-999', amount: 100, effectiveOn: '2026-10-20',
      }),
    });
    expectOnly(dirty, 'C3');
  });

  it('C4 · 核销金额为 0', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-C-002', receiptId: 'RCP-006', amount: 0, effectiveOn: '2026-10-20',
      }),
    });
    expectOnly(dirty, 'C4');
  });

  it('C4 · 核销金额为负', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-C-002', receiptId: 'RCP-006', amount: -100, effectiveOn: '2026-10-20',
      }),
    });
    expectOnly(dirty, 'C4');
  });

  it('C5 · 单笔应收累计核销超过应收', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-A-002', receiptId: 'RCP-005', amount: 1, effectiveOn: '2026-11-05',
      }),
    });
    expectOnly(dirty, 'C5');
    expect(checkIntegrity(dirty)[0]?.subject).toBe('INV-A-002');
  });

  it('C6 · 单笔收款累计分配超过收款', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-B-002', receiptId: 'RCP-002', amount: 1, effectiveOn: '2026-07-10',
      }),
    });
    expectOnly(dirty, 'C6');
    expect(checkIntegrity(dirty)[0]?.subject).toBe('RCP-002');
  });

  it('C7 · 核销生效日早于收款日', () => {
    const dirty = withRows({
      writeoffs: appended(FINANCE_DATASET.writeoffs, {
        arId: 'INV-C-002', receiptId: 'RCP-005', amount: 10, effectiveOn: '2026-11-01',
      }),
    });
    expectOnly(dirty, 'C7');
  });

  it('C8 · period 与 issuedOn 月份不一致', () => {
    const dirty = withRows({
      invoices: appended(FINANCE_DATASET.invoices, {
        id: 'INV-D-001', amount: 100, customer: '华远贸易', issuedOn: '2026-09-20', dueOn: '2026-10-20', period: '2026-10',
      }),
    });
    expectOnly(dirty, 'C8');
  });
});
