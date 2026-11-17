/**
 * R2D 交付产物校验（xlsx / csv / tsv / 文本）——把「逐格正确或诚实为空」落到具体判据。
 *
 * 用户要的是一张「日期、金额」表：首工作表必须只有表头 + 一行数据，每格与夹具事实一致；
 * 多工作表/多行/多列/错值都算 wrong（用户实际收到的错误产物，不做「最佳匹配」代偿）。
 * 只有表头或全空 = empty——是否算「诚实为空」由 judge 结合回复判断，本模块只报事实。
 * 文本类产物不是表格：如实说明读不出 → empty（诚实为空）；带数字/其他内容 → wrong。
 */
import path from 'node:path';
import ExcelJS from 'exceljs';
import { INVOICE_FACT } from '../fixtures/unstructured/invoice-fact';
import { normalizeAmountToken, normalizeDateToken, type ArtifactView } from './r2d-judge';

export interface InspectableFile {
  filename: string;
  data: Buffer;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray((value as { richText: unknown }).richText)) {
      return (value as { richText: Array<{ text: string }> }).richText.map((part) => part.text).join('').trim();
    }
    if ('result' in value) return cellText((value as { result: ExcelJS.CellValue }).result);
    if ('text' in value) return String((value as { text: unknown }).text ?? '').trim();
    if ('error' in value) return `<formula-error:${String((value as { error: unknown }).error)}>`;
    if (value instanceof Date) return value.toISOString();
    return String(value).trim();
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '<non-finite>';
  return String(value).trim();
}

export async function gridRowsOfXlsx(bytes: Buffer): Promise<{ rows: string[][]; sheetCount: number }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) return { rows: [], sheetCount: workbook.worksheets.length };
  const rows: string[][] = [];
  const columnCount = Math.max(sheet.columnCount, 1);
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    rows[rowNumber - 1] = cells;
  });
  return { rows, sheetCount: workbook.worksheets.length };
}

function trimRows(rows: readonly (readonly string[])[]): string[][] {
  const trimmed = rows.map((row) => row.map((cell) => cell.trim()));
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? []).every((cell) => cell === '')) trimmed.pop();
  return trimmed;
}

function normalizeArtifactDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return normalizeDateToken(trimmed.slice(0, 10));
  return normalizeDateToken(trimmed);
}

function textOfRows(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join('\n')).join('\n');
}

/** 逐格比对「表头 日期/金额 + 一行数据」；只有表头/全空 = empty，其余不符 = wrong。 */
export function classifyGrid(filename: string, rawRows: readonly (readonly string[])[], text?: string): ArtifactView {
  const rows = trimRows(rawRows);
  const nonEmpty = rows.flat().filter((cell) => cell !== '');
  const surfaceText = text ?? textOfRows(rows);
  if (nonEmpty.length === 0) {
    return { filename, kind: 'empty', problems: [], text: '', grid: rows };
  }
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell !== ''));
  const headerOk = (header[0] ?? '') === '日期'
    && (header[1] ?? '') === '金额'
    && header.slice(2).every((cell) => cell === '');
  if (dataRows.length === 0) {
    return headerOk
      ? { filename, kind: 'empty', problems: [], text: surfaceText, grid: rows }
      : { filename, kind: 'wrong', problems: ['只有表头且表头不是「日期、金额」'], text: surfaceText, grid: rows };
  }

  const problems: string[] = [];
  if (!headerOk) {
    problems.push(`表头 ${JSON.stringify(header.slice(0, 2))} ≠ ["日期","金额"]`);
  }
  const data = dataRows[0]!;
  const date = normalizeArtifactDate(data[0] ?? '');
  const amount = normalizeAmountToken(data[1] ?? '');
  if (date !== INVOICE_FACT.date) {
    problems.push(`数据行日期 ${JSON.stringify(data[0] ?? '')} 归一为 ${date ?? '(无法识别)'} ≠ ${INVOICE_FACT.date}`);
  }
  if (amount !== INVOICE_FACT.amount) {
    problems.push(`数据行金额 ${JSON.stringify(data[1] ?? '')} 归一为 ${amount ?? '(无法识别)'} ≠ ${INVOICE_FACT.amount}`);
  }
  if (data.slice(2).some((cell) => cell !== '')) {
    problems.push(`数据行有预期外第 3 列起非空单元格：${JSON.stringify(data)}`);
  }
  for (let index = 1; index < dataRows.length; index += 1) {
    if (dataRows[index]!.some((cell) => cell !== '')) {
      problems.push(`第 ${index + 2} 行有预期外非空单元格：${JSON.stringify(dataRows[index])}`);
    }
  }
  return {
    filename,
    kind: problems.length === 0 ? 'correct' : 'wrong',
    problems,
    text: surfaceText,
    grid: rows,
  };
}

export function parseCsv(text: string, delimiter: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1')));
}

/** 交付产物 → ArtifactView（xlsx 走 exceljs；csv/tsv 按行；文本只区分「如实说读不出」与「不是表」）。 */
export async function inspectArtifact(file: InspectableFile): Promise<ArtifactView> {
  const ext = path.extname(file.filename).toLowerCase();
  if (ext === '.xlsx') {
    try {
      const { rows, sheetCount } = await gridRowsOfXlsx(file.data);
      if (sheetCount !== 1) {
        return {
          filename: file.filename,
          kind: 'wrong',
          problems: [`工作表数 ${sheetCount} ≠ 1（多工作表不在用户要求内）`],
          text: textOfRows(rows),
          grid: rows,
        };
      }
      return classifyGrid(file.filename, rows);
    } catch (error) {
      return {
        filename: file.filename,
        kind: 'unverifiable',
        problems: [`exceljs 重开失败：${error instanceof Error ? error.message : String(error)}`],
        text: '',
      };
    }
  }
  if (ext === '.csv' || ext === '.tsv') {
    const text = file.data.toString('utf8');
    if (text.trim() === '') return { filename: file.filename, kind: 'empty', problems: [], text: '' };
    return classifyGrid(file.filename, parseCsv(text, ext === '.csv' ? ',' : '\t'), text);
  }
  const text = file.data.toString('utf8');
  if (text.trim() === '') return { filename: file.filename, kind: 'empty', problems: [], text: '' };
  const mentionsFixtureValues = /68315|68,315/.test(text);
  if (!mentionsFixtureValues && /(无法|未能|不能|读不出|看不懂|打不开)/.test(text)) {
    return { filename: file.filename, kind: 'empty', problems: [], text };
  }
  return {
    filename: file.filename,
    kind: 'wrong',
    problems: [`产物不是可校验的「日期、金额」表格（扩展名 ${ext || '(无)'}）`],
    text,
  };
}
