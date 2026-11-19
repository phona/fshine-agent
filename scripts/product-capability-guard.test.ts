/**
 * 产品能力页守卫（vitest）：把 `docs/product/capability.md` 变成可审计的活文档。
 *
 * 判据（仓规「文档约束纪律」：写进文档的每一条约束必须有能变红的守卫）：
 *   1. 锚点解析：本页所有 `文件:标题片段` 形态的测试锚点（反引号内 `.test.ts` 路径）
 *      必须唯一命中现存测试——文件存在、且该文件里恰好一个 `it(` / `it.each(` 标题
 *      包含该片段（机制同 `scripts/coverage-matrix-guard.test.ts`）。
 *   2. 「明确不做」17 条：行数恰为 17、编号 1–17 连续（防增删语义）；每条出处单元格
 *      必须含守卫引用（可解析的测试锚点）或「裁定/登记 + 日期」标记。
 *   3. 状态标记：任何带「状态」列的表格，状态单元格只能是四档枚举
 *      （已实现（有守卫）/ 已实现（无守卫）/ 未实现（设计在册）/ 明确不做（裁定））；
 *      非表格行写 `状态：` 的，同行必须出现四档之一（文档头部的「状态：现行」除外）；
 *      全文禁模糊话（「基本支持」「部分支持」「即将」等，出现即红）。
 *   4. 「未实现（设计在册）」：行数下界 + 每行出处非空（不许留空指针）。
 *   5. 反向自检：在内存里故意改坏锚点 / 删掉出处 / 写糊状态 / 删一条「不做」，
 *      断言校验器逐一变红——证明本守卫不是恒绿。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
export const DOC_REL = 'docs/product/capability.md';

const STATUSES = [
  '已实现（有守卫）',
  '已实现（无守卫）',
  '未实现（设计在册）',
  '明确不做（裁定）',
] as const;
const DOC_STATUS_HEADER_ALLOWED = ['状态：现行'] as const;
const VAGUE_PHRASES = ['基本支持', '部分支持', '即将', '马上', '计划支持', '应该可以', '大体'];
const NOT_DOING_COUNT = 17;
const IN_REGISTER_MIN_ROWS = 8;

// ---------- 解析 ----------

/** 提取一个测试文件里所有 `it(` / `it.each(` 标题（含模板串；与覆盖矩阵守卫同一正则）。 */
export function extractTitles(src: string): string[] {
  const out: string[] = [];
  const re = /\bit(?:\.each\s*\([^()]*\))?\s*\(\s*(`|'|")([\s\S]*?)\1/g;
  for (const m of src.matchAll(re)) {
    if (m[2]) out.push(m[2]);
  }
  return out;
}

export type RefCheck =
  | { ok: true; rel: string; title?: string }
  | { ok: false; error: string };

/** 检查一条「文件:标题片段」引用能否唯一定位到用例；不带片段 = 文件级（须是真测试文件）。 */
export function checkRef(root: string, ref: string): RefCheck {
  const colon = ref.indexOf(':');
  const rel = (colon === -1 ? ref : ref.slice(0, colon)).trim();
  const frag = colon === -1 ? '' : ref.slice(colon + 1).trim();
  const abs = path.join(root, rel);
  if (!existsSync(abs)) {
    return { ok: false, error: `引用文件不存在：${rel}` };
  }
  const titles = extractTitles(readFileSync(abs, 'utf8'));
  if (frag === '') {
    if (titles.length === 0) return { ok: false, error: `${rel} 里没有任何 it( 用例，不是测试文件` };
    return { ok: true, rel };
  }
  const hits = titles.filter((t) => t.includes(frag));
  if (hits.length === 0) {
    return {
      ok: false,
      error: `在 ${rel} 中找不到包含「${frag}」的 it( 标题（该文件现有 ${titles.length} 个标题；用例被删/改名即红）`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: `「${frag}」在 ${rel} 中命中 ${hits.length} 个标题，不能唯一定位（引用写太宽）：\n    - ${hits.join('\n    - ')}`,
    };
  }
  return { ok: true, rel, title: hits[0] };
}

/** 测试锚点形状：反引号内 `…​.test.ts` 或 `…​.test.ts:标题片段`。 */
export function isTestRefShape(span: string): boolean {
  return /^[A-Za-z0-9@/._-]+\.test\.ts(?::[^`]+)?$/.test(span);
}

/** 收集文本中所有反引号内的测试锚点（含所在行号，1-based）。 */
export function collectTestRefs(text: string): { ref: string; lineNo: number }[] {
  const out: { ref: string; lineNo: number }[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1];
      if (span !== undefined && isTestRefShape(span)) out.push({ ref: span, lineNo: i + 1 });
    }
  });
  return out;
}

export interface TableRow {
  cells: string[];
  lineNo: number;
}

/** 切出一个 md 表格块（连续 `|` 行）：首行视为表头，`---` 分隔行跳过。 */
export function parseTableBlock(lines: string[], startLineNo: number): { header: string[]; rows: TableRow[] } {
  const raw = lines.map((line, i) => ({ line: line.trim(), lineNo: startLineNo + i }));
  const split = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const first = raw[0];
  if (first === undefined) return { header: [], rows: [] };
  const header = split(first.line);
  const rows: TableRow[] = [];
  for (const { line, lineNo } of raw.slice(1)) {
    const cells = split(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // 分隔行
    rows.push({ cells, lineNo });
  }
  return { header, rows };
}

/** 把文档切成（heading, 内容行）段。 */
export function splitSections(text: string): { heading: string; lines: string[]; startLineNo: number }[] {
  const out: { heading: string; lines: string[]; startLineNo: number }[] = [];
  let current: { heading: string; lines: string[]; startLineNo: number } | undefined;
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^##\s+(.+)$/);
    const heading = m?.[1];
    if (heading !== undefined) {
      current = { heading: heading.trim(), lines: [], startLineNo: i + 1 };
      out.push(current);
      return;
    }
    if (current) current.lines.push(line);
  });
  return out;
}

// ---------- 校验器（纯函数，便于反向自检复用） ----------

export interface DocValidation {
  ok: boolean;
  errors: string[];
  refCount: number;
}

/** 全量校验：锚点 / 状态标记 / 模糊话 / 17 条出处 / 在册行指针 / 结构头。 */
export function validateCapabilityDoc(root: string, text: string): DocValidation {
  const errors: string[] = [];
  const lines = text.split('\n');

  // 结构头与四节
  const head = lines.slice(0, 10).join('\n');
  if (!/状态：现行/.test(head)) errors.push('文档头部缺「状态：现行」行');
  if (!/最后核对[:：]/.test(head)) errors.push('文档头部缺「最后核对」行');
  if (!/基线[:：]/.test(head)) errors.push('文档头部缺「基线」行');
  const headings = splitSections(text).map((s) => s.heading);
  for (const required of ['支持什么', '预期行为', '明确不做', '未实现（设计在册）']) {
    if (!headings.some((h) => h.includes(required))) errors.push(`缺节标题：「${required}」`);
  }

  // 1) 锚点：全部唯一命中现存用例
  const refs = collectTestRefs(text);
  for (const { ref, lineNo } of refs) {
    const r = checkRef(root, ref);
    if (!r.ok) errors.push(`锚点 :${lineNo}「${ref}」→ ${r.error}`);
  }

  // 2) 表格状态列：只能是四档枚举
  let tableBlock: string[] = [];
  let tableStart = 0;
  const flushTable = () => {
    if (tableBlock.length === 0) return;
    const { header, rows } = parseTableBlock(tableBlock, tableStart);
    const statusIdx = header.indexOf('状态');
    if (statusIdx !== -1) {
      for (const row of rows) {
        const cell = row.cells[statusIdx] ?? '';
        if (!(STATUSES as readonly string[]).includes(cell)) {
          errors.push(
            `表格 :${row.lineNo} 状态列「${cell}」不在四档 {${STATUSES.join(' / ')}} 内`,
          );
        }
      }
    }
    tableBlock = [];
  };
  lines.forEach((line, i) => {
    if (line.trim().startsWith('|')) {
      if (tableBlock.length === 0) tableStart = i + 1;
      tableBlock.push(line);
    } else {
      flushTable();
    }
  });
  flushTable();

  // 3) 非表格行内联状态标记（「状态：现行」文档头除外）
  const inlineRe = /状态[：:]/;
  lines.forEach((line, i) => {
    if (line.trim().startsWith('|') || line.trim().startsWith('>')) return;
    if (!inlineRe.test(line)) return;
    if (DOC_STATUS_HEADER_ALLOWED.some((h) => line.includes(h))) return;
    if (!(STATUSES as readonly string[]).some((s) => line.includes(s))) {
      errors.push(`行 :${i + 1} 出现「状态：」但同行没有四档状态标记：${line.trim().slice(0, 60)}`);
    }
  });

  // 4) 模糊话禁词
  for (const phrase of VAGUE_PHRASES) {
    const at = text.indexOf(phrase);
    if (at !== -1) {
      const lineNo = text.slice(0, at).split('\n').length;
      errors.push(`禁模糊话「${phrase}」出现在 :${lineNo}`);
    }
  }

  // 5) 第三节「明确不做」：恰 17 条、编号连续、每条有出处
  const section3 = splitSections(text).find((s) => s.heading.includes('明确不做'));
  if (!section3) {
    errors.push('找不到「明确不做」节');
  } else {
    const tableLines = section3.lines.filter((l) => l.trim().startsWith('|'));
    const firstTableLine3 = tableLines[0];
    if (tableLines.length < 2 || firstTableLine3 === undefined) {
      errors.push('「明确不做」节没有表格行');
    } else {
      const { rows } = parseTableBlock(tableLines, section3.startLineNo + section3.lines.indexOf(firstTableLine3));
      const dataRows = rows.filter((r) => /^\d+$/.test(r.cells[0] ?? ''));
      if (dataRows.length !== NOT_DOING_COUNT) {
        errors.push(`「明确不做」应恰 ${NOT_DOING_COUNT} 条，实际 ${dataRows.length} 条（不许增删语义）`);
      }
      dataRows.forEach((row, idx) => {
        const no = Number(row.cells[0]);
        if (no !== idx + 1) errors.push(`「明确不做」编号不连续：:${row.lineNo} 是 ${no}，应为 ${idx + 1}`);
        const source = row.cells[row.cells.length - 1] ?? '';
        const hasRef = (source.match(/`([^`\n]+)`/g) ?? [])
          .map((s) => s.slice(1, -1))
          .some((span) => isTestRefShape(span) && checkRef(root, span).ok);
        const hasRuling = /(?:裁定|登记)[^\d]{0,8}\d{4}-\d{2}-\d{2}/.test(source);
        if (!hasRef && !hasRuling) {
          errors.push(`「明确不做」#${row.cells[0]}（:${row.lineNo}）缺出处：既无守卫引用，也无裁定/登记日期`);
        }
      });
    }
  }

  // 6) 第四节「未实现（设计在册）」：行数下界 + 出处非空
  const section4 = splitSections(text).find((s) => s.heading.includes('未实现（设计在册）'));
  if (!section4) {
    errors.push('找不到「未实现（设计在册）」节');
  } else {
    const tableLines = section4.lines.filter((l) => l.trim().startsWith('|'));
    const firstTableLine4 = tableLines[0];
    if (tableLines.length < 2 || firstTableLine4 === undefined) {
      errors.push('「未实现（设计在册）」节没有表格行');
    } else {
      const { rows } = parseTableBlock(tableLines, section4.startLineNo + section4.lines.indexOf(firstTableLine4));
      const dataRows = rows.filter((r) => /^\d+$/.test(r.cells[0] ?? ''));
      if (dataRows.length < IN_REGISTER_MIN_ROWS) {
        errors.push(`「未实现（设计在册）」至少 ${IN_REGISTER_MIN_ROWS} 条，实际 ${dataRows.length} 条`);
      }
      for (const row of dataRows) {
        const source = (row.cells[row.cells.length - 1] ?? '').trim();
        if (source === '' || source === '—' || source === '-') {
          errors.push(`「未实现（设计在册）」#${row.cells[0]}（:${row.lineNo}）出处为空`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, refCount: refs.length };
}

// ---------- 测试 ----------

describe('product-capability 守卫', () => {
  const text = readFileSync(path.join(REPO_ROOT, DOC_REL), 'utf8');
  const v = validateCapabilityDoc(REPO_ROOT, text);

  it('文档结构齐全：状态头 / 最后核对 / 基线 / 四节标题', () => {
    const structural = v.errors.filter((e) => /缺「|缺节标题/.test(e));
    expect(structural, structural.join('\n')).toEqual([]);
  });

  it('全部锚点唯一命中现存用例（文件存在 + 恰一个 it( 标题命中）', () => {
    expect(v.refCount).toBeGreaterThan(30);
    const refErrors = v.errors.filter((e) => e.startsWith('锚点 :'));
    expect(refErrors, `锚点失配（用例被删/改名，或引用写太宽）：\n${refErrors.join('\n')}`).toEqual([]);
  });

  it('带「状态」列的表格只能是四档枚举；行内「状态：」必须带四档标记', () => {
    const statusErrors = v.errors.filter((e) => /状态列|四档状态标记/.test(e));
    expect(statusErrors, statusErrors.join('\n')).toEqual([]);
  });

  it('全文禁模糊话（基本支持 / 即将 之类）', () => {
    const vague = v.errors.filter((e) => e.startsWith('禁模糊话'));
    expect(vague, vague.join('\n')).toEqual([]);
  });

  it('「明确不做」恰 17 条、编号连续、每条有守卫引用或裁定/登记日期', () => {
    const nd = v.errors.filter((e) => /明确不做/.test(e));
    expect(nd, nd.join('\n')).toEqual([]);
  });

  it('「未实现（设计在册）」行数达标、出处非空', () => {
    const reg = v.errors.filter((e) => /未实现（设计在册）/.test(e));
    expect(reg, reg.join('\n')).toEqual([]);
  });

  it('总校验零错误（兜底：上面任何一条漏网都在这里红）', () => {
    expect(v.ok, `capability.md 校验失败：\n${v.errors.join('\n')}`).toBe(true);
  });

  describe('反向自检（证明守卫真的会红）', () => {
    it('改坏一个锚点片段 → 校验器报「找不到 it( 标题」', () => {
      const broken = text.replace('W-02 documents W202611', 'W-02 这个标题绝对不存在_xyz');
      expect(broken).not.toBe(text);
      const r = validateCapabilityDoc(REPO_ROOT, broken);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('找不到包含'))).toBe(true);
    });

    it('锚点片段写太宽（命中多个标题）→ 校验器报「不能唯一定位」', () => {
      // apps/server/server-state-wake.test.ts 同时有 ①b/②b/③b/④b 四个「走岔路」标题；去掉区分符必红。
      const broad = text.replace(
        'server-state-wake.test.ts:①b 走岔路：唤醒回合只调工具',
        'server-state-wake.test.ts:走岔路',
      );
      const r = validateCapabilityDoc(REPO_ROOT, broad);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('命中') && e.includes('个标题'))).toBe(true);
    });

    it('删掉「明确不做」某条的出处 → 校验器报「缺出处」', () => {
      const broken = text.replace(
        '裁定 2026-11-17（owner，CAP-01 收口；`docs/architecture/tasks.md` §7）。守卫：`packages/agent/task-surface.test.ts:越权=找不到：同一底账内跨会话同编号不可见`',
        '已裁定，细节从略',
      );
      expect(broken).not.toBe(text);
      const r = validateCapabilityDoc(REPO_ROOT, broken);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('缺出处'))).toBe(true);
    });

    it('删掉「明确不做」整行（17 变 16）→ 校验器报条数不符', () => {
      const lines = text.split('\n');
      const rowIdx = lines.findIndex((l) => l.trim().startsWith('| 17 |'));
      expect(rowIdx).toBeGreaterThan(-1);
      const broken = lines.filter((_, i) => i !== rowIdx).join('\n');
      const r = validateCapabilityDoc(REPO_ROOT, broken);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('应恰 17 条'))).toBe(true);
    });

    it('状态列写糊（「基本支持」）→ 状态枚举与禁模糊话双双变红', () => {
      const broken = text.replace('| 已实现（有守卫） |', '| 基本支持 |');
      expect(broken).not.toBe(text);
      const r = validateCapabilityDoc(REPO_ROOT, broken);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('状态列'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('禁模糊话'))).toBe(true);
    });

    it('「未实现（设计在册）」某行出处清空 → 校验器报出处为空', () => {
      const broken = text.replace(
        '只有机械登记（lifecycle 对 `.pdf/.zip` 只登记、内容 UNDEFINED）；无图片夹具与识别用例（`docs/eval/coverage-matrix.md` §二缺口行）',
        '',
      );
      expect(broken).not.toBe(text);
      const r = validateCapabilityDoc(REPO_ROOT, broken);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('出处为空'))).toBe(true);
    });
  });
});
