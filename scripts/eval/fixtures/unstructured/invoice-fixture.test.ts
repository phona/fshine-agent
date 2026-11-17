/**
 * 文本型 PDF 夹具自检（零网络、零外部 PDF 库）。
 *
 * 目的：证明 `scripts/eval/fixtures/unstructured/invoice-2026-10-18.pdf` **不是手搓二进制**，
 * 而是由仓内生成脚本产出的、结构合法的单页文本 PDF；且文本提取器能读出模拟发票的
 * 日期 / 金额 / 客户三行。
 *
 * 为什么用仓内提取器而不是 pdftotext：本机与 CI 均未安装 poppler（2026-11-17 实测
 * `which pdftotext` = not found；仓内也没有 PDF 解析依赖，见 AGENTS.md 不新增解析库）。
 * 提取器只实现本夹具用到的 PDF 子集（xref 结构校验 + BT/ET 里的 Tj/TJ 文本算子），
 * 不是通用 PDF 库；它的职责是证明「文本在内容流里、按标准文本算子存放」，而
 * 不是替代 poppler 的渲染级解析。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVOICE_FACT } from './invoice-fact';
import { generateInvoicePdf } from './make-invoice-pdf';
import { extractPdfTextLines, validatePdfStructure } from './pdf-text';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PDF = path.join(HERE, 'invoice-2026-10-18.pdf');

describe('文本型 PDF 发票夹具', () => {
  it('仓内产物与生成脚本逐字节一致（禁止手改二进制）', () => {
    const checkedIn = readFileSync(FIXTURE_PDF);
    const regenerated = generateInvoicePdf();
    expect(regenerated.equals(checkedIn)).toBe(true);
  });

  it('结构合法：单页、无图片对象、xref 偏移均指向真实对象', () => {
    const pdf = readFileSync(FIXTURE_PDF);
    const structure = validatePdfStructure(pdf);
    expect(structure.pageCount).toBe(1);
    expect(structure.objectCount).toBe(5);
    expect(structure.rootType).toBe('Catalog');
    // 文本型：没有图片 XObject（不是扫描件/位图）。
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    expect(pdf.toString('latin1')).toContain('/Contents 5 0 R');
  });

  it('文本提取器读出预期三行（日期 / 金额 / 客户）', () => {
    const lines = extractPdfTextLines(readFileSync(FIXTURE_PDF));
    expect(lines).toEqual([...INVOICE_FACT.lines]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(INVOICE_FACT.date);
    expect(lines[1]).toContain(INVOICE_FACT.amountDisplay);
    expect(lines[2]).toContain(INVOICE_FACT.customer);
  });

  it('截断 PDF 必须被结构校验拒绝（证明提取器不是裸 grep 字节）', () => {
    const pdf = readFileSync(FIXTURE_PDF);
    const truncated = pdf.subarray(0, Math.floor(pdf.length / 2));
    expect(() => validatePdfStructure(truncated)).toThrow();
  });

  it('金额与日期不与其他 eval 夹具冲突（scripts/eval 下除本目录与 r2d-* 用例外零命中）', () => {
    const evalRoot = path.resolve(HERE, '..', '..');
    const cap01Root = path.join(evalRoot, 'cap01');
    const offenders: string[] = [];
    for (const entry of readdirSync(evalRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const fullPath = path.join(entry.parentPath, entry.name);
      // 本目录（夹具/生成器/提取器）与 r2d 用例（判据/产物校验/入口）是本夹具的合法引用面。
      if (fullPath.startsWith(HERE + path.sep)) continue;
      if (fullPath.startsWith(cap01Root + path.sep) && entry.name.startsWith('r2d-')) continue;
      const text = readFileSync(fullPath, 'utf8');
      if (text.includes(INVOICE_FACT.amount) || text.includes(INVOICE_FACT.date)) {
        offenders.push(path.relative(evalRoot, fullPath));
      }
    }
    expect(offenders).toEqual([]);
  });
});
