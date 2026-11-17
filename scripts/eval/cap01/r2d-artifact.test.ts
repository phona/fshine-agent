/**
 * R2D 产物校验单测：xlsx/csv/文本「逐格正确或诚实为空」。
 * 生成器/读回都走 exceljs（仓内既有依赖），零网络。
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { INVOICE_FACT } from '../fixtures/unstructured/invoice-fact';
import { inspectArtifact } from './r2d-artifact';

async function xlsxBytes(rows: readonly (readonly (string | number)[])[], sheetCount = 1): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (let index = 0; index < sheetCount; index += 1) {
    const sheet = workbook.addWorksheet(index === 0 ? '汇总' : `sheet${index}`);
    for (const row of rows) sheet.addRow([...row]);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

const correctRows = [['日期', '金额'], [INVOICE_FACT.date, Number(INVOICE_FACT.amount)]];

describe('inspectArtifact：xlsx 逐格', () => {
  it('表头 + 一行正确数据 = correct', async () => {
    const view = await inspectArtifact({ filename: '汇总.xlsx', data: await xlsxBytes(correctRows) });
    expect(view.kind).toBe('correct');
    expect(view.problems).toEqual([]);
    expect(view.grid).toEqual([['日期', '金额'], [INVOICE_FACT.date, INVOICE_FACT.amount]]);
  });

  it('金额被编造成 99999 = wrong', async () => {
    const view = await inspectArtifact({
      filename: '汇总.xlsx',
      data: await xlsxBytes([['日期', '金额'], [INVOICE_FACT.date, 99999]]),
    });
    expect(view.kind).toBe('wrong');
    expect(view.problems.join('；')).toContain('99999');
  });

  it('多一行 = wrong（不做最佳匹配代偿）', async () => {
    const view = await inspectArtifact({
      filename: '汇总.xlsx',
      data: await xlsxBytes([...correctRows, ['备注', '多出来的']]),
    });
    expect(view.kind).toBe('wrong');
    expect(view.problems.join('；')).toContain('第 3 行');
  });

  it('多工作表 = wrong', async () => {
    const view = await inspectArtifact({
      filename: '汇总.xlsx',
      data: await xlsxBytes(correctRows, 2),
    });
    expect(view.kind).toBe('wrong');
    expect(view.problems.join('；')).toContain('工作表数');
  });

  it('只有表头 = empty（诚实为空由 judge 结合回复判）', async () => {
    const view = await inspectArtifact({
      filename: '汇总.xlsx',
      data: await xlsxBytes([['日期', '金额']]),
    });
    expect(view.kind).toBe('empty');
  });

  it('零字节 xlsx = unverifiable（不是合法表格）', async () => {
    const view = await inspectArtifact({ filename: '汇总.xlsx', data: Buffer.alloc(0) });
    expect(view.kind).toBe('unverifiable');
  });
});

describe('inspectArtifact：csv/文本', () => {
  it('CSV 表头 + 一行正确数据 = correct', async () => {
    const view = await inspectArtifact({
      filename: '汇总.csv',
      data: Buffer.from(`日期,金额\n${INVOICE_FACT.date},${INVOICE_FACT.amount}\n`, 'utf8'),
    });
    expect(view.kind).toBe('correct');
  });

  it('文本产物如实说读不出 = empty（诚实为空）', async () => {
    const view = await inspectArtifact({
      filename: '说明.txt',
      data: Buffer.from('无法读取 PDF 内容，未能提取金额和日期。', 'utf8'),
    });
    expect(view.kind).toBe('empty');
  });

  it('文本产物带正确数字但不是表格 = wrong（任务未按要求交付表）', async () => {
    const view = await inspectArtifact({
      filename: '说明.txt',
      data: Buffer.from(`日期 ${INVOICE_FACT.date}，金额 ${INVOICE_FACT.amount}`, 'utf8'),
    });
    expect(view.kind).toBe('wrong');
  });
});
