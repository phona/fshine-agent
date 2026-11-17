/**
 * 生成文本型 PDF 发票夹具（纯仓内代码，零 PDF 依赖、零外部进程）。
 *
 * 产物：`invoice-2026-10-18.pdf`（与本脚本同目录，进 git）。内容是单页、ASCII、
 * **未压缩内容流**里的三行文本（日期 / 金额 / 客户名），任何遵循 PDF 文本算子
 * （BT/ET + Tj）的提取器都能读出——用于把「模型遇到不认识的格式」从 UNDEFINED 变成
 * 有读数的用例。
 *
 * 为什么不用 PDF 库：AGENTS.md 禁止为夹具新增解析依赖；手写最小 PDF 1.4 结构足以
 * 产出合法文本页，且 xref 偏移由脚本机械计算（不是手工二进制）。
 *
 * 重新生成：
 *   node --import tsx scripts/eval/fixtures/unstructured/make-invoice-pdf.ts
 * 可选参数：输出路径（缺省 = 同目录 invoice-2026-10-18.pdf）。
 * 生成是确定性的：同一脚本任何时候产出的字节完全相同（夹具测试逐字节比对）。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOICE_FACT } from './invoice-fact';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** PDF 字面字符串转义（`\`、`(`、`)`）。 */
function escapePdfLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** 内容流：三行文本，每行一个 Tj（标准文本算子，未压缩）。 */
function buildContentStream(lines: readonly string[]): string {
  const commands: string[] = ['BT', '/F1 14 Tf', '72 760 Td'];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('0 -26 Td');
    commands.push(`(${escapePdfLiteral(line)}) Tj`);
  });
  commands.push('ET');
  return `${commands.join('\n')}\n`;
}

function pdfObject(id: number, body: string): string {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

/** 生成 PDF 字节（确定性；无时间戳、无随机数）。 */
export function generateInvoicePdf(): Buffer {
  const content = buildContentStream(INVOICE_FACT.lines);
  const contentLength = Buffer.byteLength(content, 'latin1');
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
        + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    ),
    pdfObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    `5 0 obj\n<< /Length ${contentLength} >>\nstream\n${content}endstream\nendobj\n`,
  ];

  const header = '%PDF-1.4\n% fshine text fixture\n';
  const offsets: number[] = [];
  let body = '';
  for (const object of objects) {
    offsets.push(Buffer.byteLength(header, 'latin1') + Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(header, 'latin1') + Buffer.byteLength(body, 'latin1');
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const offset of offsets) {
    xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `);
  }
  const trailer = [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');

  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    Buffer.from(body, 'latin1'),
    Buffer.from(`${xrefLines.join('\n')}\n${trailer}`, 'latin1'),
  ]);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const target = process.argv[2] === undefined
    ? path.join(HERE, INVOICE_FACT.pdfFilename)
    : path.resolve(process.argv[2]);
  writeFileSync(target, generateInvoicePdf());
  console.log(`[make-invoice-pdf] wrote ${path.relative(process.cwd(), target)} (${INVOICE_FACT.lines.length} text lines)`);
}
