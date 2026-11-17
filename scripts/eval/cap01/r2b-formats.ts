/**
 * CAP-01 R2B 格式矩阵验收（脚本化；与 r2-functional.ts 互补——真模型行为归 R2，本脚本无模型）。
 *
 * 被测面 = CAP-01 的 xlsx 处理管线「run_js 执行面」生产装配同源三件套直驱
 * （createSqliteTaskRegistry + createFileStore + createRunJsExecutor，node_modules 解析根与
 * apps/server/server.ts 同一构造；run 目录布局/受限子进程/交付箱扫描全部走产品实现）。
 *
 * 方法：脚本化生成 10 类 xlsx，每类喂给固定 compute 代码（harness 持有、内容不参与判定——
 * 判定对象是执行面处理该格式的结果），逐类断言三件事：
 *   能读   —— run 内 CENSUS 与生成器 Oracle 一致（读到的行数/合并区/公式面/列数 = 写入面）；
 *   能算   —— 产物首工作表与 Oracle 逐格一致（列数/行数/每格文本；多行多列/缺行缺列/值错都算）；
 *   产物可重开 —— 产物字节经 fileStore 登记后用 exceljs 重新打开成功并完成上一条比对。
 * 每类独立结论 ok / error(原因)；**「静默成功但产物错」算红**（exit 0 + 产物与 Oracle 不符 =
 * error，原因写明）；失败样本连证据（CENSUS/stdout/stderr/审计/fixture 字节）一起落盘，不筛绿。
 *
 * 10 类与判据（fixture 由生成器写入，Oracle 由同一数据源算出，不依赖库读回——生成器另有
 * 自检重读，自检失败记 harness error，不冒充产品结论）：
 *   ① 标准 12 行        12 行月份明细 → 按月合计（行数/合计数/逐格）。
 *   ② 空表（只有表头）  0 数据行 → 产物 = 仅表头一行（不伪造数据行）。
 *   ③ 单单元格          A1 单值 → 全表合计写回单格。
 *   ④ 合并单元格        标题行 A1:C1 合并 + 表头 + 6 数据行 → 合并区可读（merges/master 值）
 *                        且数据区聚合正确。
 *   ⑤ 公式（缓存值缺失）销售额列全为公式且无缓存值 → 公式保真读取（文本与数量），且产物
 *                        必须如实记录「不可计算」，**不得伪造数值合计**（伪造 = 静默成功但
 *                        产物错 = 红）。缓存值缺失 ⇒ 从文件算不出数值合计，能算的部分 =
 *                        公式普查与缺失缓存值计数。
 *   ⑥ 日期列            三个基准各一 run：1900 基准日期格、1904 基准日期格（真 1904 文件：
 *                        exceljs 4.4.0 写侧不支持 date1904（2026-11-17 实测 serial 46037 两套
 *                        基准相同），生成器用 JSZip 补 workbookPr date1904="1" 并把 serial −1462
 *                        造出；1904 读回正确与否由 exceljs 读侧实现）、文本型日期（保持文本，
 *                        不静默转日期/序数）。日期以 ISO 日期串读回比对——1904 误读会偏 1462 天，
 *                        一眼即红。
 *   ⑦ 中文列名+中文数据 品名/单价/数量 → 中文名保真 + 数量合计 + 总金额（生成器同序同算，
 *                        IEEE 同位比对）。
 *   ⑧ 超宽 200 列       200 列 × 3 行 → 列数 = 200 + 每行 199 列总和（生成器同序同算）。
 *   ⑨ 10 万行           readFile 全表合计（与其它类同一读法族；2026-11-17 实测 512MB 子进程
 *                        堆内可容：maxRSS 387MB / heapUsed 171MB / 808ms）。记耗时与内存峰值：
 *                        宿主 audit.durationMs、子进程 ru_maxrss（CENSUS 附带 maxRssKB）、
 *                        harness RSS 抽样——指标只记录，不设通过阈值（设计稿未给阈值，不发明）；
 *                        判定只看行数/合计/产物重开。streaming reader（WorkbookReader）在受限
 *                        子进程内结构不可用（exceljs 打包 tmp 包对 tmpdir 祖先 /home 逐级
 *                        fs.lstat，越过 --allow-fs-read 白名单 → ERR_ACCESS_DENIED，2026-11-17
 *                        实测）——附一个仅观测的 streaming-probe run 如实登记（UNDEFINED：
 *                        设计稿未规定流式读支持），不影响结论。
 *   ⑩ 损坏文件（半截 zip）合法 xlsx 截半 → **必须明确报错**：exitCode≠0、零产物登记、stderr
 *                        非空；exit 0 或登记了产物 = 静默成功 = 红。
 *
 * UNDEFINED 登记（设计稿未写清、本脚本不发明判据的行为）：产物同名（每次 run 独立 run 目录
 * + 单产物，未覆盖同名产物去重/覆盖口径）；空产物（out/ 为空且 exit 0 的合法空产物口径）；
 * 32MB/50MiB 产物超限行为（不在 10 类范围）。
 *
 * 运行（先 export TMPDIR=<可写临时目录>）：
 *   node --import tsx scripts/eval/cap01/r2b-formats.ts [--type 01,06] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r2b/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 十类全 ok；1 = 任一类 error。
 */
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createFileStore, fileStoragePathOf, type FileScope, type FileStore } from '../../../packages/agent/src/file-store';
import { createRunJsExecutor, type RunJsExecutor, type RunJsOutput } from '../../../packages/agent/src/run-js-executor';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// jszip 无类型声明（exceljs 传递依赖，仓内 hoisted）——createRequire 引入并本地声明最小形状。
const requireCjs = createRequire(import.meta.url);
interface JsZipEntry {
  async(type: 'string'): Promise<string>;
}
interface JsZipArchive {
  file(name: string): JsZipEntry | null;
  file(name: string, data: string): JsZipArchive;
  readonly files: Record<string, { name: string }>;
  generateAsync(options: { type: 'nodebuffer'; compression: string; compressionOptions?: { level: number } }): Promise<Buffer>;
}
const JSZIP = requireCjs('jszip') as { loadAsync(data: Buffer): Promise<JsZipArchive> };

const SCOPE: FileScope = { principalId: 'fixture-user', sessionId: 'cap01-r2b' };
const OUTPUT_NAME = '汇总.xlsx';

// ── exceljs Oracle 工具（与 r2-functional.ts 同形：cellText/gridOfXlsx/compareGrids） ─────

/** exceljs 单元格值 → 规范文本（数字/公式结果/richText 归一；空 = ''）。 */
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
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '<non-finite>';
  }
  return String(value).trim();
}

/** 首工作表 → 稀疏行号映射（保留空行号信息，逐格比对按行号对齐，不压缩空行）。 */
async function gridOfXlsx(bytes: Buffer): Promise<{ grid: Map<number, string[]>; columnCount: number; sheetCount: number }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  const grid = new Map<number, string[]>();
  if (sheet === undefined) return { grid, columnCount: 0, sheetCount: workbook.worksheets.length };
  const columnCount = Math.max(sheet.columnCount, 1);
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    grid.set(rowNumber, cells);
  });
  return { grid, columnCount, sheetCount: workbook.worksheets.length };
}

export interface GridDiff {
  ok: boolean;
  problems: string[];
}

/** 逐格一致：行号集合一致、每格文本一致（额外行列/空工作表都算不一致）。 */
function compareGrids(actual: { grid: Map<number, string[]>; columnCount: number; sheetCount: number }, expected: readonly string[][]): GridDiff {
  const problems: string[] = [];
  if (actual.sheetCount !== 1) {
    problems.push(`工作表数 ${actual.sheetCount} ≠ 1`);
  }
  const expectedHeader = expected[0];
  if (expectedHeader === undefined) {
    problems.push('Oracle 空网格（harness bug）');
    return { ok: false, problems };
  }
  if (actual.columnCount !== expectedHeader.length) {
    problems.push(`列数 ${actual.columnCount} ≠ 预期 ${expectedHeader.length}`);
  }
  const expectedRows = expected.length;
  for (let rowNumber = 1; rowNumber <= Math.max(expectedRows, actual.grid.size); rowNumber += 1) {
    const actualRow = actual.grid.get(rowNumber);
    const expectedRow = expected[rowNumber - 1];
    if (expectedRow === undefined && actualRow !== undefined) {
      const nonEmpty = actualRow.filter((cell) => cell !== '');
      if (nonEmpty.length > 0) problems.push(`第 ${rowNumber} 行为预期之外的非空行：${JSON.stringify(nonEmpty)}`);
      continue;
    }
    if (expectedRow !== undefined && actualRow === undefined) {
      problems.push(`第 ${rowNumber} 行缺失（预期 ${JSON.stringify(expectedRow)}）`);
      continue;
    }
    if (expectedRow === undefined || actualRow === undefined) continue;
    for (let column = 1; column <= Math.max(expectedRow.length, actualRow.length); column += 1) {
      const expectedCell = expectedRow[column - 1] ?? '';
      const actualCell = actualRow[column - 1] ?? '';
      if (expectedCell !== actualCell) {
        problems.push(`第 ${rowNumber} 行第 ${column} 列：实际 ${JSON.stringify(actualCell)} ≠ 预期 ${JSON.stringify(expectedCell)}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── census 比对：expected 键全部相等（Object.is 精确比对）；actual 多出的键记为观测值 ──

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((key, index) => key !== kb[index])) return false;
    return ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function censusSubset(actual: Record<string, unknown>, expected: Record<string, unknown>): { ok: boolean; problems: string[]; extras: Record<string, unknown> } {
  const problems: string[] = [];
  for (const key of Object.keys(expected)) {
    if (!deepEqual(actual[key], expected[key])) {
      problems.push(`census.${key} 实际 ${JSON.stringify(actual[key])} ≠ 预期 ${JSON.stringify(expected[key])}`);
    }
  }
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) extras[key] = actual[key];
  }
  return { ok: problems.length === 0, problems, extras };
}

// ── 断言收集（与 r2-functional.ts 同形） ─────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

class Checks {
  readonly list: Check[] = [];

  check(name: string, pass: boolean, detail: string): void {
    this.list.push({ name, pass, detail });
  }

  get allPassed(): boolean {
    return this.list.every((entry) => entry.pass);
  }
}

// ── 类型/运行定义 ────────────────────────────────────────────────────────────

interface RunOracle {
  census: Record<string, unknown>;
  outputGrid: readonly string[][];
}

interface RunDef {
  /** run 标签（'run1' / '1900' / '1904' / 'streaming-probe'）。 */
  label: string;
  /** 用户可见名（file_refs.name 原值）。 */
  fixtureName: string;
  /** fixture 落盘路径（evidence 目录内；登记源 = 该文件，字节即此文件）。 */
  fixturePath: string;
  bytes: Buffer;
  code: string;
  expected: 'success' | 'explicit-error';
  oracle: RunOracle;
  selfChecks: Check[];
  genMs: number;
  /** gated=false = 仅观测 run（探测类；结论只记录，不影响类型结论）。 */
  gated?: boolean;
}

interface TypeDef {
  /** '01'..'10'。 */
  id: string;
  slug: string;
  name: string;
  /** 类型级说明（判据口径，进 summary）。 */
  note?: string;
  buildRuns(fixturesDir: string): Promise<RunDef[]>;
}

interface RunOutcome {
  label: string;
  status: 'ok' | 'error';
  reason?: string;
  checks: Check[];
  metrics: Record<string, unknown>;
  evidence: Record<string, unknown>;
  /** 仅观测 run（gated=false）：不影响类型结论，只记录。 */
  observedOnly?: boolean;
}

interface TypeOutcome {
  id: string;
  slug: string;
  name: string;
  status: 'ok' | 'error';
  reason?: string;
  runs: RunOutcome[];
  metrics: Record<string, unknown>;
  note?: string;
}

// ── compute 代码（run.cjs 内容；CommonJS，cwd = run 目录；只打 CENSUS 一行，防 64KiB 截断） ──

/** ①②⑩：标准两列按月合计（空表自然产出仅表头；损坏文件在 readFile 处炸出明确错误）。 */
const AGG_MONTHLY_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  const months = []; const sums = new Map(); let grand = 0; let dataRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const month = ws.getCell(r, 1).value;
    if (month === null || month === undefined) continue;
    const amount = Number(ws.getCell(r, 2).value);
    dataRows += 1;
    const key = String(month).trim();
    if (!sums.has(key)) { sums.set(key, 0); months.push(key); }
    sums.set(key, (sums.get(key) ?? 0) + amount);
    grand += amount;
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['月份', '销售额']);
  for (const m of months) sheet.addRow([m, sums.get(m)]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ dataRows, months: months.length, grandTotal: grand }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ③：单单元格——全表合计写回单格。 */
const SINGLE_CELL_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  let cells = 0; let sum = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (v === null || v === undefined) return;
      cells += 1;
      const n = Number(v);
      sum += Number.isFinite(n) ? n : NaN;
    });
  });
  const out = new ExcelJS.Workbook();
  out.addWorksheet('汇总').getCell('A1').value = sum;
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ cells, sum }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ④：合并标题 + 表头占 1-2 行，从第 3 行起聚合；CENSUS 带合并区与 master 值。 */
const MERGED_TITLE_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  const merges = (ws.model && Array.isArray(ws.model.merges)) ? ws.model.merges.map(String) : [];
  const months = []; const sums = new Map(); let grand = 0; let dataRows = 0;
  for (let r = 3; r <= ws.rowCount; r++) {
    const month = ws.getCell(r, 1).value;
    if (month === null || month === undefined) continue;
    const amount = Number(ws.getCell(r, 2).value);
    dataRows += 1;
    const key = String(month).trim();
    if (!sums.has(key)) { sums.set(key, 0); months.push(key); }
    sums.set(key, (sums.get(key) ?? 0) + amount);
    grand += amount;
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['月份', '销售额']);
  for (const m of months) sheet.addRow([m, sums.get(m)]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ dataRows, months: months.length, grandTotal: grand, merges, masterA1: String(ws.getCell('A1').value ?? '') }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ⑤：公式普查——公式保真读回（文本与数量），缓存值缺失如实计数；产物不伪造数值合计。 */
const FORMULA_CENSUS_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  let formulaCells = 0; let missingCache = 0; const formulas = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const v = ws.getCell(r, 2).value;
    if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && 'formula' in v) {
      formulaCells += 1;
      const rec = v;
      if (rec.result === undefined || rec.result === null) missingCache += 1;
      formulas.push(String(rec.formula));
    }
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['公式单元格数', formulaCells]);
  sheet.addRow(['缺缓存值公式数', missingCache]);
  sheet.addRow(['公式文本', formulas.join('|')]);
  sheet.addRow(['数值合计', '不可计算：销售额列全部为公式且无缓存值']);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ formulaCells, missingCache, formulas }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ⑥：日期读回——Date → D:<ISO 日期>；文本 → T:<原文>；其他类型 → ?<JSON>（Oracle 视为红）。 */
const DATE_ECHO_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const rows = []; let dates = 0; let texts = 0; let others = 0; const sheets = [];
  for (const ws of wb.worksheets) {
    sheets.push(ws.name);
    ws.eachRow({ includeEmpty: false }, (row) => {
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        if (v === null || v === undefined) continue;
        if (v instanceof Date) { dates += 1; rows.push([ws.name, cell.address, 'D:' + v.toISOString().slice(0, 10)]); }
        else if (typeof v === 'string') { texts += 1; rows.push([ws.name, cell.address, 'T:' + v]); }
        else { others += 1; rows.push([ws.name, cell.address, '?' + JSON.stringify(v)]); }
      }
    });
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('读回');
  sheet.addRow(['工作表', '单元格', '读回值']);
  for (const r of rows) sheet.addRow(r);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ dates, texts, others, sheets }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ⑦：中文品名/单价/数量——数量合计 + 总金额（与生成器同序同算，IEEE 同位比对）。 */
const CN_AGGREGATE_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  const names = []; const qty = new Map(); let totalAmount = 0; let dataRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const name = ws.getCell(r, 1).value;
    if (name === null || name === undefined) continue;
    const price = Number(ws.getCell(r, 2).value);
    const quantity = Number(ws.getCell(r, 3).value);
    dataRows += 1;
    const key = String(name).trim();
    if (!qty.has(key)) { qty.set(key, 0); names.push(key); }
    qty.set(key, (qty.get(key) ?? 0) + quantity);
    totalAmount += price * quantity;
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['品名', '数量']);
  for (const n of names) sheet.addRow([n, qty.get(n)]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ dataRows, names, totalAmount }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ⑧：200 列宽表——列数 + 每行 199 列总和（与生成器同序同算）。 */
const WIDE_SUM_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  const columnCount = ws.columnCount;
  const rowTotals = []; let dataRows = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    if (ws.getCell(r, 1).value === null || ws.getCell(r, 1).value === undefined) continue;
    let s = 0;
    for (let c = 2; c <= columnCount; c++) s += Number(ws.getCell(r, c).value);
    rowTotals.push(s);
    dataRows += 1;
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['行', '总和']);
  rowTotals.forEach((t, i) => sheet.addRow(['行' + (i + 1), t]));
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  console.log('CENSUS ' + JSON.stringify({ columnCount, dataRows, rowTotals }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/**
 * ⑨：10 万行——readFile 全表合计（与其它类同一读法族；2026-11-17 实测 512MB 子进程堆内
 * 可容：maxRSS 387MB / heapUsed 171MB / 808ms）。CENSUS 附带 maxRssKB（子进程 ru_maxrss，
 * Linux KB）与 inScriptMs（run 内耗时）——观测指标，Oracle 只 gate dataRows/grandTotal。
 *
 * 另注（探测 run 仅观测，不 gate）：exceljs streaming reader（WorkbookReader）在受限子进程
 * 内**结构不可用**——其打包的 tmp 包会对 tmpdir 祖先目录（如 /home）逐级 fs.lstat，路径在
 * --allow-fs-read 白名单之外 → ERR_ACCESS_DENIED（2026-11-17 实测）。设计稿未规定流式读
 * 支持，按「口径不明就记录」如实登记，不判产品红。
 */
const BIG_READ_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const t0 = Date.now();
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  let n = 0; let sum = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    n += 1;
    sum += Number(ws.getCell(r, 2).value);
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['行数', n]);
  sheet.addRow(['合计', sum]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
  const ru = process.resourceUsage();
  console.log('CENSUS ' + JSON.stringify({ dataRows: n, grandTotal: sum, maxRssKB: ru.maxRSS, inScriptMs: Date.now() - t0 }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

/** ⑨ 观测 run：streaming reader 在受限子进程内的可用性探测（结果只记录，不影响结论）。 */
const STREAMING_PROBE_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const input = fs.readdirSync('in').find((n) => n.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path.join('in', input), { sharedStrings: false, hyperlinks: false, styles: false });
  let n = 0; let sum = 0;
  const done = new Promise((resolve, reject) => {
    reader.on('worksheet', (ws) => {
      ws.on('row', (row) => {
        if (row.number <= 1) return;
        const num = Number(row.getCell(2).value);
        if (Number.isFinite(num)) { n += 1; sum += num; }
      });
    });
    reader.on('end', resolve);
    reader.on('close', resolve);
    reader.on('error', reject);
  });
  reader.read();
  await done;
  console.log('CENSUS ' + JSON.stringify({ dataRows: n, grandTotal: sum }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
`.trim();

// ── fixture 生成器 ───────────────────────────────────────────────────────────

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildWorkbook(write: (workbook: ExcelJS.Workbook) => void | Promise<void>): Promise<Buffer> {
  return (async () => {
    const workbook = new ExcelJS.Workbook();
    await write(workbook);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  })();
}

/** ISO 日期串 → UTC 零点 Date（exceljs 日期格以 UTC 基准读写，2026-11-17 实测）。 */
function utcDateOf(iso: string): Date {
  const parts = iso.split('-');
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
}

/** 1900 → 1904 基准补丁（exceljs 4.4.0 写侧不支持 date1904，2026-11-17 实测）：workbookPr
 *  加 date1904="1"，全部 sheet 内日期 serial −1462（1900 幽灵闰日 + 两基准差）。 */
async function patchTo1904(bytes1900: Buffer): Promise<Buffer> {
  const zip = await JSZIP.loadAsync(bytes1900);
  const workbookEntry = zip.file('xl/workbook.xml');
  if (workbookEntry === null) throw new Error('fixture 缺 xl/workbook.xml（harness bug）');
  const workbookXml = await workbookEntry.async('string');
  zip.file('xl/workbook.xml', workbookXml.replace('<workbookPr ', '<workbookPr date1904="1" '));
  for (const entryName of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entryName)) continue;
    const entry = zip.file(entryName);
    if (entry === null) continue;
    const xml = await entry.async('string');
    zip.file(entryName, xml.replace(/<v>(\d+)<\/v>/g, (_match, digits: string) => `<v>${Number(digits) - 1462}</v>`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** 重读 fixture 与源数据网格比对（生成器自检；失败 = harness/库漂移，记 harness error）。 */
async function reopenGrid(bytes: Buffer): Promise<{ grid: readonly string[][]; columnCount: number; sheetCount: number; raw: Awaited<ReturnType<typeof gridOfXlsx>> }> {
  const raw = await gridOfXlsx(bytes);
  const rows: string[][] = [];
  for (let rowNumber = 1; rowNumber <= raw.grid.size; rowNumber += 1) {
    const row = raw.grid.get(rowNumber);
    if (row !== undefined) rows.push(row);
  }
  return { grid: rows, columnCount: raw.columnCount, sheetCount: raw.sheetCount, raw };
}

// exceljs 流式读写面的最小本地形状（绕开 exceljs d.ts 里流式类的复杂泛型）。
interface StreamRow {
  number: number;
  getCell(column: number): { value: ExcelJS.CellValue };
}
interface StreamWorksheetReader {
  on(event: 'row', listener: (row: StreamRow) => void): void;
}
interface StreamWorkbookReader {
  on(event: 'worksheet', listener: (ws: StreamWorksheetReader) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  read(): void;
}
interface StreamSheetWriter {
  addRow(...cells: unknown[]): void;
  commit(): void;
}
interface StreamWorkbookWriter {
  addWorksheet(name: string): StreamSheetWriter;
  commit(): Promise<void>;
}
const STREAM_XLSX = (ExcelJS as unknown as {
  stream: {
    xlsx: {
      WorkbookReader: new (file: string, options: Record<string, unknown>) => StreamWorkbookReader;
      WorkbookWriter: new (options: { stream: import('node:stream').Writable }) => StreamWorkbookWriter;
    };
  };
}).stream.xlsx;

const T01_MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const T01_VALUES = [214073, 158262, 186349, 141827, 229518, 173462, 198271, 154396, 236514, 182743, 213859, 167328];
const T01_GRAND = T01_VALUES.reduce((sum, value) => sum + value, 0);

const T04_ROWS: ReadonlyArray<readonly [string, number, string]> = [
  ['1月', 100, '华东'], ['1月', 250, '华南'],
  ['2月', 200, '华东'], ['2月', 150, '华北'],
  ['3月', 300, '华东'], ['3月', 50, '华南'],
];
const T04_GRAND = T04_ROWS.reduce((sum, [, value]) => sum + value, 0);

const T05_MONTHS = ['1月', '2月', '3月'];
const T05_FORMULAS = ['1+1', '2+2', '3+3'];

const T06_DATES = ['2026-01-15', '2026-02-28', '2026-12-31'];
const T06_TEXT_DATES = ['2026-01-15', '2026/2/28', '2026年12月31日'];

const T07_ROWS: ReadonlyArray<readonly [string, number, number]> = [
  ['龙井茶', 128.5, 3], ['普洱茶', 66.75, 7], ['铁观音', 39.25, 12], ['大红袍', 999.5, 2],
];
const T07_TOTAL = T07_ROWS.reduce((sum, [, price, qty]) => sum + price * qty, 0);

const T08_WIDE_COLUMNS = 200;
const T08_DATA_ROWS = 3;
const T08_CELL = (row: number, column: number): number => ((row * 200 + column * 7) % 97) + 1;
const T08_ROW_TOTALS: number[] = Array.from({ length: T08_DATA_ROWS }, (_unused, row) => {
  let total = 0;
  for (let column = 2; column <= T08_WIDE_COLUMNS; column += 1) total += T08_CELL(row + 1, column);
  return total;
});

const T09_ROW_COUNT = 100_000;
const T09_GRAND = (T09_ROW_COUNT * (T09_ROW_COUNT + 1)) / 2;

const TEN_TYPE_DEFS: TypeDef[] = [
  {
    id: '01',
    slug: 'std12',
    name: '标准 12 行',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('明细');
        sheet.addRow(['月份', '销售额']);
        for (let index = 0; index < 12; index += 1) sheet.addRow([T01_MONTHS[index], T01_VALUES[index]]);
      });
      const fixturePath = path.join(fixturesDir, 't01-std12.xlsx');
      writeFileSync(fixturePath, bytes);
      const sourceGrid = [['月份', '销售额'], ...T01_MONTHS.map((month, index) => [month, String(T01_VALUES[index] ?? 0)])];
      const reopened = await reopenGrid(bytes);
      const selfDiff = compareGrids(reopened.raw, sourceGrid);
      return [{
        label: 'run1',
        fixtureName: '月度销售明细.xlsx',
        fixturePath,
        bytes,
        code: AGG_MONTHLY_CODE,
        expected: 'success',
        oracle: {
          census: { dataRows: 12, months: 12, grandTotal: T01_GRAND },
          outputGrid: sourceGrid,
        },
        selfChecks: [{ name: 'fixture-reopen', pass: selfDiff.ok, detail: selfDiff.ok ? `fixture 重读与源数据逐格一致（列数 ${reopened.columnCount}）` : selfDiff.problems.slice(0, 6).join('；') }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '02',
    slug: 'header-only',
    name: '空表（只有表头）',
    note: '0 数据行：产物 = 仅表头一行，不得伪造数据行（UNDEFINED 登记见文件头）。',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        workbook.addWorksheet('明细').addRow(['月份', '销售额']);
      });
      const fixturePath = path.join(fixturesDir, 't02-header-only.xlsx');
      writeFileSync(fixturePath, bytes);
      const reopened = await reopenGrid(bytes);
      const selfDiff = compareGrids(reopened.raw, [['月份', '销售额']]);
      return [{
        label: 'run1',
        fixtureName: '只有表头.xlsx',
        fixturePath,
        bytes,
        code: AGG_MONTHLY_CODE,
        expected: 'success',
        oracle: {
          census: { dataRows: 0, months: 0, grandTotal: 0 },
          outputGrid: [['月份', '销售额']],
        },
        selfChecks: [{ name: 'fixture-reopen', pass: selfDiff.ok && reopened.raw.grid.size === 1, detail: selfDiff.ok ? `fixture 重读只有表头 1 行（列数 ${reopened.columnCount}）` : selfDiff.problems.slice(0, 6).join('；') }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '03',
    slug: 'single-cell',
    name: '单单元格',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        workbook.addWorksheet('明细').getCell('A1').value = 428571;
      });
      const fixturePath = path.join(fixturesDir, 't03-single-cell.xlsx');
      writeFileSync(fixturePath, bytes);
      const reopened = await reopenGrid(bytes);
      const selfDiff = compareGrids(reopened.raw, [['428571']]);
      return [{
        label: 'run1',
        fixtureName: '单单元格.xlsx',
        fixturePath,
        bytes,
        code: SINGLE_CELL_CODE,
        expected: 'success',
        oracle: {
          census: { cells: 1, sum: 428571 },
          outputGrid: [['428571']],
        },
        selfChecks: [{ name: 'fixture-reopen', pass: selfDiff.ok, detail: selfDiff.ok ? `fixture 重读 A1=428571（列数 ${reopened.columnCount}）` : selfDiff.problems.slice(0, 6).join('；') }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '04',
    slug: 'merged-title',
    name: '合并单元格',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('明细');
        sheet.getCell('A1').value = '销售月报（标题）';
        sheet.mergeCells('A1:C1');
        sheet.addRow(['月份', '销售额', '备注']);
        for (const [month, value, region] of T04_ROWS) sheet.addRow([month, value, region]);
      });
      const fixturePath = path.join(fixturesDir, 't04-merged-title.xlsx');
      writeFileSync(fixturePath, bytes);
      // 自检：合并区存在、master 值在、表头与数据区逐格直读一致（slave 单元格读回形状是
      // exceljs 实现细节——实测 slave 读回 master 值——不进判据）。
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      const sheet = workbook.worksheets[0]!;
      const merges = (sheet.model && Array.isArray(sheet.model.merges)) ? sheet.model.merges.map(String) : [];
      const mergeOk = merges.includes('A1:C1') && sheet.getCell('A1').value === '销售月报（标题）';
      const dataCells: string[] = [];
      for (let row = 2; row <= 2 + T04_ROWS.length; row += 1) {
        for (let column = 1; column <= 3; column += 1) dataCells.push(cellText(sheet.getCell(row, column).value));
      }
      const expectedDataCells = ['月份', '销售额', '备注', ...T04_ROWS.flatMap(([month, value, region]) => [month, String(value), region])];
      const dataOk = deepEqual(dataCells, expectedDataCells);
      return [{
        label: 'run1',
        fixtureName: '合并标题月报.xlsx',
        fixturePath,
        bytes,
        code: MERGED_TITLE_CODE,
        expected: 'success',
        oracle: {
          census: { dataRows: 6, months: 3, grandTotal: T04_GRAND, merges: ['A1:C1'], masterA1: '销售月报（标题）' },
          outputGrid: [['月份', '销售额'], ['1月', '350'], ['2月', '350'], ['3月', '350']],
        },
        selfChecks: [
          { name: 'merge-region', pass: mergeOk, detail: mergeOk ? `合并区读回 = ${JSON.stringify(merges)}，A1 master = ${JSON.stringify(sheet.getCell('A1').value)}` : `合并区读回异常：${JSON.stringify(merges)}` },
          { name: 'fixture-data-region', pass: dataOk, detail: dataOk ? '表头+数据区直读逐格一致' : `数据区读回异常：${JSON.stringify(dataCells)}` },
        ],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '05',
    slug: 'formula-no-cache',
    name: '带公式（缓存值缺失）',
    note: '缓存值缺失 ⇒ 从文件算不出数值合计；判据 = 公式保真读取（文本+数量）+ 产物如实记录「不可计算」+ 不伪造数值合计（伪造 = 静默成功但产物错 = 红）。',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('明细');
        sheet.addRow(['月份', '销售额']);
        for (let index = 0; index < T05_MONTHS.length; index += 1) {
          sheet.addRow([T05_MONTHS[index], { formula: T05_FORMULAS[index] }]);
        }
      });
      const fixturePath = path.join(fixturesDir, 't05-formula-no-cache.xlsx');
      writeFileSync(fixturePath, bytes);
      // 自检：每个销售额格 = {formula} 且无 result（exceljs 4.4.0 实测形状：{formula:'1+1'}，无 result 键）。
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      const sheet = workbook.worksheets[0]!;
      let formulaOk = true;
      const details: string[] = [];
      for (let index = 0; index < T05_FORMULAS.length; index += 1) {
        const value = sheet.getCell(index + 2, 2).value;
        const ok = value !== null && typeof value === 'object' && !Array.isArray(value) && 'formula' in value
          && String((value as { formula: unknown }).formula) === T05_FORMULAS[index]
          && (value as { result?: unknown }).result === undefined;
        formulaOk = formulaOk && ok;
        details.push(`B${index + 2}=${JSON.stringify(value)}`);
      }
      return [{
        label: 'run1',
        fixtureName: '公式无缓存.xlsx',
        fixturePath,
        bytes,
        code: FORMULA_CENSUS_CODE,
        expected: 'success',
        oracle: {
          census: { formulaCells: 3, missingCache: 3, formulas: [...T05_FORMULAS] },
          outputGrid: [
            ['公式单元格数', '3'],
            ['缺缓存值公式数', '3'],
            ['公式文本', '1+1|2+2|3+3'],
            ['数值合计', '不可计算：销售额列全部为公式且无缓存值'],
          ],
        },
        selfChecks: [{ name: 'formula-shape', pass: formulaOk, detail: formulaOk ? '3 个公式格均 {formula} 且无缓存值' : `公式格形状异常：${details.join('；')}` }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '06',
    slug: 'dates',
    name: '日期列（1900/1904 基准、文本型日期）',
    note: '两个 run：1900 基准 + 文本型日期；1904 基准（真 1904 文件 = JSZip 补 date1904="1" + serial −1462，exceljs 写侧不支持该标志，2026-11-17 实测）。日期按 ISO 日期串读回——1904 误读偏 1462 天即红。',
    async buildRuns(fixturesDir) {
      const startedA = Date.now();
      const bytes1900 = await buildWorkbook((workbook) => {
        const sheet1900 = workbook.addWorksheet('d1900');
        for (let index = 0; index < T06_DATES.length; index += 1) {
          sheet1900.getCell(index + 1, 1).value = utcDateOf(T06_DATES[index]!);
        }
        const sheetText = workbook.addWorksheet('文本日期');
        for (let index = 0; index < T06_TEXT_DATES.length; index += 1) {
          sheetText.getCell(index + 1, 1).value = T06_TEXT_DATES[index];
        }
      });
      const fixturePath1900 = path.join(fixturesDir, 't06-dates-1900.xlsx');
      writeFileSync(fixturePath1900, bytes1900);
      // 自检：日期格读回 = 写入日期（ISO 日期串）；文本格原样。
      const wb1900 = new ExcelJS.Workbook();
      await wb1900.xlsx.load(bytes1900 as unknown as ExcelJS.Buffer);
      const read1900Dates = T06_DATES.map((_iso, index) => {
        const value = wb1900.worksheets[0]!.getCell(index + 1, 1).value;
        return value instanceof Date ? value.toISOString().slice(0, 10) : `<非日期:${JSON.stringify(value)}>`;
      });
      const read1900Texts = T06_TEXT_DATES.map((_text, index) => {
        const value = wb1900.worksheets[1]!.getCell(index + 1, 1).value;
        return typeof value === 'string' ? value : `<非文本:${JSON.stringify(value)}>`;
      });
      const check1900 = deepEqual(read1900Dates, T06_DATES) && deepEqual(read1900Texts, T06_TEXT_DATES);

      const startedB = Date.now();
      const bytes1904Base = await buildWorkbook((workbook) => {
        const sheet1904 = workbook.addWorksheet('d1904');
        for (let index = 0; index < T06_DATES.length; index += 1) {
          sheet1904.getCell(index + 1, 1).value = utcDateOf(T06_DATES[index]!);
        }
      });
      const bytes1904 = await patchTo1904(bytes1904Base);
      const fixturePath1904 = path.join(fixturesDir, 't06-dates-1904.xlsx');
      writeFileSync(fixturePath1904, bytes1904);
      // 自检：补丁后的真 1904 文件按 1904 基准读回同一组日期（exceljs 读侧实现 date1904）。
      const wb1904 = new ExcelJS.Workbook();
      await wb1904.xlsx.load(bytes1904 as unknown as ExcelJS.Buffer);
      const read1904Dates = T06_DATES.map((_iso, index) => {
        const value = wb1904.worksheets[0]!.getCell(index + 1, 1).value;
        return value instanceof Date ? value.toISOString().slice(0, 10) : `<非日期:${JSON.stringify(value)}>`;
      });
      const check1904 = deepEqual(read1904Dates, T06_DATES);

      const dateRows1900 = [
        ['工作表', '单元格', '读回值'],
        ...T06_DATES.map((iso, index) => ['d1900', `A${index + 1}`, `D:${iso}`]),
        ...T06_TEXT_DATES.map((text, index) => ['文本日期', `A${index + 1}`, `T:${text}`]),
      ];
      const dateRows1904 = [
        ['工作表', '单元格', '读回值'],
        ...T06_DATES.map((iso, index) => ['d1904', `A${index + 1}`, `D:${iso}`]),
      ];
      return [
        {
          label: '1900+文本',
          fixtureName: '日期1900基准.xlsx',
          fixturePath: fixturePath1900,
          bytes: bytes1900,
          code: DATE_ECHO_CODE,
          expected: 'success',
          oracle: {
            census: { dates: 3, texts: 3, others: 0, sheets: ['d1900', '文本日期'] },
            outputGrid: dateRows1900,
          },
          selfChecks: [{ name: 'fixture-reopen', pass: check1900, detail: check1900 ? `1900 基准日期读回 ${JSON.stringify(read1900Dates)}，文本读回 ${JSON.stringify(read1900Texts)}` : `1900 fixture 读回异常：dates=${JSON.stringify(read1900Dates)} texts=${JSON.stringify(read1900Texts)}` }],
          genMs: Date.now() - startedA,
        },
        {
          label: '1904',
          fixtureName: '日期1904基准.xlsx',
          fixturePath: fixturePath1904,
          bytes: bytes1904,
          code: DATE_ECHO_CODE,
          expected: 'success',
          oracle: {
            census: { dates: 3, texts: 0, others: 0, sheets: ['d1904'] },
            outputGrid: dateRows1904,
          },
          selfChecks: [{ name: 'fixture-reopen', pass: check1904, detail: check1904 ? `1904 基准（date1904="1"+serial−1462）读回 ${JSON.stringify(read1904Dates)}` : `1904 fixture 读回异常：${JSON.stringify(read1904Dates)}` }],
          genMs: Date.now() - startedB,
        },
      ];
    },
  },
  {
    id: '07',
    slug: 'chinese',
    name: '中文列名+中文数据',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('茶叶');
        sheet.addRow(['品名', '单价（元）', '数量']);
        for (const [name, price, qty] of T07_ROWS) sheet.addRow([name, price, qty]);
      });
      const fixturePath = path.join(fixturesDir, 't07-chinese.xlsx');
      writeFileSync(fixturePath, bytes);
      const reopened = await reopenGrid(bytes);
      const selfDiff = compareGrids(reopened.raw, [['品名', '单价（元）', '数量'], ...T07_ROWS.map(([name, price, qty]) => [name, String(price), String(qty)])]);
      return [{
        label: 'run1',
        fixtureName: '中文销售数据.xlsx',
        fixturePath,
        bytes,
        code: CN_AGGREGATE_CODE,
        expected: 'success',
        oracle: {
          census: { dataRows: 4, names: [...T07_ROWS.map(([name]) => name)], totalAmount: T07_TOTAL },
          outputGrid: [['品名', '数量'], ...T07_ROWS.map(([name, _price, qty]) => [name, String(qty)])],
        },
        selfChecks: [{ name: 'fixture-reopen', pass: selfDiff.ok, detail: selfDiff.ok ? `fixture 重读中文逐格一致（总金额生成器侧 = ${T07_TOTAL}）` : selfDiff.problems.slice(0, 6).join('；') }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '08',
    slug: 'wide200',
    name: '超宽 200 列',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const bytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('宽表');
        sheet.addRow(['序号', ...Array.from({ length: T08_WIDE_COLUMNS - 1 }, (_unused, index) => `列${String(index + 1).padStart(3, '0')}`)]);
        for (let row = 1; row <= T08_DATA_ROWS; row += 1) {
          sheet.addRow([row, ...Array.from({ length: T08_WIDE_COLUMNS - 1 }, (_unused, index) => T08_CELL(row, index + 2))]);
        }
      });
      const fixturePath = path.join(fixturesDir, 't08-wide200.xlsx');
      writeFileSync(fixturePath, bytes);
      const reopened = await reopenGrid(bytes);
      // 自检：列数 = 200，且按同一循环重算行总和与 Oracle 一致。
      const recomputeTotals = reopened.grid.slice(1).map((cells) => {
        let total = 0;
        for (let column = 1; column < cells.length; column += 1) total += Number(cells[column]);
        return total;
      });
      const selfOk = reopened.columnCount === T08_WIDE_COLUMNS && deepEqual(recomputeTotals, T08_ROW_TOTALS);
      return [{
        label: 'run1',
        fixtureName: '宽表200列.xlsx',
        fixturePath,
        bytes,
        code: WIDE_SUM_CODE,
        expected: 'success',
        oracle: {
          census: { columnCount: 200, dataRows: 3, rowTotals: [...T08_ROW_TOTALS] },
          outputGrid: [['行', '总和'], ...T08_ROW_TOTALS.map((total, index) => [`行${index + 1}`, String(total)])],
        },
        selfChecks: [{ name: 'fixture-reopen', pass: selfOk, detail: selfOk ? `fixture 重读列数 ${reopened.columnCount}，行总和重算 ${JSON.stringify(recomputeTotals)}` : `fixture 读回异常：列数 ${reopened.columnCount}，行总和 ${JSON.stringify(recomputeTotals)} ≠ Oracle ${JSON.stringify(T08_ROW_TOTALS)}` }],
        genMs: Date.now() - started,
      }];
    },
  },
  {
    id: '09',
    slug: 'rows100k',
    name: '10 万行',
    note: '判定只看行数/合计/产物重开；指标（生成耗时/宿主 audit.durationMs/子进程 ru_maxrss/harness RSS）只记录不设阈值（设计稿未给阈值）。readFile 变体 2026-11-17 实测：808ms / 子进程 maxRSS 387MB / heapUsed 171MB（512MB 堆内）。streaming reader（WorkbookReader）在受限子进程内结构不可用（exceljs 打包 tmp 包对 tmpdir 祖先 /home 逐级 lstat，越过 --allow-fs-read 白名单 → ERR_ACCESS_DENIED）——streaming-probe run 仅观测不 gate（UNDEFINED：设计稿未规定流式读支持）。',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const fixturePath = path.join(fixturesDir, 't09-rows100k.xlsx');
      await new Promise<void>((resolve, reject) => {
        const writer = new STREAM_XLSX.WorkbookWriter({ stream: createWriteStream(fixturePath) });
        const sheet = writer.addWorksheet('明细');
        sheet.addRow(['序号', '数值']);
        for (let index = 1; index <= T09_ROW_COUNT; index += 1) sheet.addRow([index, index]);
        try {
          sheet.commit();
          void writer.commit().then(() => resolve()).catch(reject);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const bytes = readFileSync(fixturePath);
      const genMs = Date.now() - started;
      // 自检：流式重读行数与合计（大文件合理读法），失败 = harness/库漂移。
      const selfStart = Date.now();
      const reRead = await new Promise<{ rows: number; sum: number }>((resolve, reject) => {
        const reader = new STREAM_XLSX.WorkbookReader(fixturePath, { sharedStrings: false, hyperlinks: false, styles: false });
        let rows = 0;
        let sum = 0;
        const done = new Promise<void>((resolveDone, rejectDone) => {
          reader.on('worksheet', (ws) => {
            ws.on('row', (row) => {
              if (row.number <= 1) return;
              const num = Number(row.getCell(2).value);
              if (Number.isFinite(num)) { rows += 1; sum += num; }
            });
          });
          reader.on('end', resolveDone);
          reader.on('close', resolveDone);
          reader.on('error', rejectDone);
        });
        reader.read();
        void done.then(() => resolve({ rows, sum })).catch(reject);
      });
      const selfOk = reRead.rows === T09_ROW_COUNT && reRead.sum === T09_GRAND;
      return [
        {
          label: 'run1',
          fixtureName: '十万行明细.xlsx',
          fixturePath,
          bytes,
          code: BIG_READ_CODE,
          expected: 'success',
          oracle: {
            census: { dataRows: T09_ROW_COUNT, grandTotal: T09_GRAND },
            outputGrid: [['行数', String(T09_ROW_COUNT)], ['合计', String(T09_GRAND)]],
          },
          selfChecks: [{ name: 'fixture-reopen', pass: selfOk, detail: selfOk ? `fixture 流式重读 ${reRead.rows} 行 / 合计 ${reRead.sum}（自检耗时 ${Date.now() - selfStart}ms，fixture ${statSync(fixturePath).size}B）` : `fixture 流式重读异常：${JSON.stringify(reRead)}` }],
          genMs,
        },
        {
          label: 'streaming-probe',
          fixtureName: '十万行明细.xlsx',
          fixturePath,
          bytes,
          code: STREAMING_PROBE_CODE,
          expected: 'explicit-error',
          oracle: { census: {}, outputGrid: [['Oracle 不适用（流式探测，仅观测）']] },
          selfChecks: [{ name: 'fixture-reopen', pass: selfOk, detail: '与 run1 同一 fixture（见 run1 自检）' }],
          genMs: 0,
          gated: false,
        },
      ];
    },
  },
  {
    id: '10',
    slug: 'corrupt',
    name: '损坏文件（半截 zip）',
    note: '必须明确报错：exitCode≠0 + 零产物登记 + stderr 非空；exit 0 或登记产物 = 静默成功 = 红。',
    async buildRuns(fixturesDir) {
      const started = Date.now();
      const validBytes = await buildWorkbook((workbook) => {
        const sheet = workbook.addWorksheet('明细');
        sheet.addRow(['月份', '销售额']);
        for (let index = 0; index < 12; index += 1) sheet.addRow([T01_MONTHS[index], T01_VALUES[index]]);
      });
      const bytes = validBytes.subarray(0, Math.floor(validBytes.length / 2));
      const fixturePath = path.join(fixturesDir, 't10-corrupt.xlsx');
      writeFileSync(fixturePath, bytes);
      // 自检：半截 zip 必须打不开（若 exceljs 静默打开，fixture 定义即不成立）。
      let checkFailedToOpen = false;
      let checkDetail = '';
      try {
        await gridOfXlsx(bytes);
        checkDetail = `半截 zip（${bytes.length}B / 原 ${validBytes.length}B）竟被 exceljs 静默打开——fixture 定义不成立`;
      } catch (error) {
        checkFailedToOpen = true;
        checkDetail = `半截 zip（${bytes.length}B / 原 ${validBytes.length}B）重读报错（预期）：${error instanceof Error ? error.message : String(error)}`;
      }
      return [{
        label: 'run1',
        fixtureName: '损坏文件.xlsx',
        fixturePath,
        bytes,
        code: AGG_MONTHLY_CODE,
        expected: 'explicit-error',
        oracle: { census: {}, outputGrid: [['Oracle 不适用（预期明确报错）']] },
        selfChecks: [{ name: 'fixture-corrupt', pass: checkFailedToOpen, detail: checkDetail }],
        genMs: Date.now() - started,
      }];
    },
  },
];

// ── 生产装配同源三件套（run_js 执行面；无渠道/无模型——格式矩阵不走 LLM） ────

interface HarnessContext {
  dir: string;
  dbPath: string;
  workspaceRoot: string;
  fileStore: FileStore;
  executor: RunJsExecutor;
}

async function makeHarness(): Promise<HarnessContext> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cap01-r2b-'));
  const dbPath = path.join(dir, 'state.db');
  const taskRegistry = createSqliteTaskRegistry(dbPath);
  // 与 apps/server/server.ts workspaceRootOf（server.ts:154）同一布局：<db 目录>/workspace。
  const workspaceRoot = path.join(path.dirname(dbPath), 'workspace');
  const fileStore = createFileStore({ store: taskRegistry.store, workspaceRoot });
  // 与 server.ts:170-172 同一构造（真实受限执行器；NODE_PATH/权限模型产品实现）。
  const executor = createRunJsExecutor({ fileStore, nodeModulesDir: path.join(REPO_ROOT, 'node_modules') });
  return { dir, dbPath, workspaceRoot, fileStore, executor };
}

// ── 单 run 执行与判定 ────────────────────────────────────────────────────────

function firstFailure(checks: readonly Check[]): string {
  const failed = checks.find((entry) => !entry.pass);
  return failed === undefined ? '' : failed.detail;
}

async function executeRun(typeId: string, def: RunDef, ctx: HarnessContext): Promise<RunOutcome> {
  const checks = new Checks();
  const prefix = `${typeId}:${def.label}`;
  const metrics: Record<string, unknown> = {
    genMs: def.genMs,
    fixtureBytes: def.bytes.length,
    fixtureSha256: sha256Of(def.bytes),
    fixturePath: def.fixturePath,
  };
  const evidence: Record<string, unknown> = { expected: def.expected, oracle: def.oracle };

  // 生成器自检（harness 侧）：fixture 必须满足类型定义性质；失败记 harness error，不冒充产品结论。
  for (const selfCheck of def.selfChecks) {
    checks.check(`${prefix}:selfcheck-${selfCheck.name}`, selfCheck.pass, selfCheck.detail);
  }
  if (!def.selfChecks.every((entry) => entry.pass)) {
    return {
      label: def.label,
      status: 'error',
      reason: `harness 生成器自检失败（fixture 与类型定义不符，非产品结论）：${firstFailure(checks.list)}`,
      checks: checks.list,
      metrics,
      evidence,
    };
  }

  try {
    // 登记（pending → 激活）→ run_js：生产装配同源路径（file_refs 行 + 受限子进程 + 交付箱扫描）。
    const registered = ctx.fileStore.registerInboundFile({ scope: SCOPE, name: def.fixtureName, sourcePath: def.fixturePath });
    ctx.fileStore.activatePendingInputs({ scope: SCOPE, now: Date.now() });
    const result: RunJsOutput = await ctx.executor.runJs({ code: def.code, inputs: [registered.fileId], scope: SCOPE });
    metrics['runId'] = result.audit.runId;
    metrics['runDurationMs'] = result.audit.durationMs;
    metrics['exitCode'] = result.exitCode;
    metrics['exitSignal'] = result.exitSignal;
    metrics['killReason'] = result.audit.killReason;
    metrics['stdoutBytes'] = result.stdout.length;
    metrics['stderrBytes'] = result.stderr.length;
    metrics['harnessRssMB'] = Math.round(process.memoryUsage().rss / 1048576);
    evidence['stdout'] = result.stdout.slice(-4000);
    evidence['stderr'] = result.stderr.slice(-4000);
    evidence['audit'] = {
      scriptSha256: result.audit.scriptSha256,
      materializedInputs: result.audit.materializedInputs,
      outputs: result.audit.outputs,
      skippedOutputs: result.audit.skippedOutputs,
      durationMs: result.audit.durationMs,
    };

    if (def.expected === 'explicit-error') {
      // ⑩：损坏文件必须明确报错——exit 0 = 静默成功 = 红；登记了产物 = 静默成功 = 红；stderr 必须 non-empty。
      checks.check(
        `${prefix}:explicit-failure`,
        result.exitCode !== 0 || result.exitSignal !== null,
        `exitCode=${result.exitCode} exitSignal=${result.exitSignal}${result.audit.killReason !== undefined ? ` killReason=${result.audit.killReason}` : ''}——该 run 预期明确失败（exit 0 = 静默成功 = 红）`,
      );
      checks.check(
        `${prefix}:no-artifact`,
        result.outputs.length === 0 && result.audit.skippedOutputs.length === 0,
        `产物登记=${result.outputs.length}，拒收项=${result.audit.skippedOutputs.length}——报错的 run 不得交付任何产物`,
      );
      checks.check(
        `${prefix}:error-visible`,
        result.stderr.trim() !== '',
        `stderr ${result.stderr.length}B${result.stderr.trim() !== '' ? `，报错内容（截录）：${result.stderr.trim().slice(0, 300)}` : '（空——错误不可见）'}`,
      );
      if (result.stderr.trim() !== '' && /zip|central directory|corrupt|invalid|excel/i.test(result.stderr)) {
        metrics['stderrMatchesParseError'] = true;
      }
      return finalize();
    }

    // expected = success：四道门。
    checks.check(
      `${prefix}:exit`,
      result.exitCode === 0 && result.exitSignal === null && result.audit.killReason === undefined,
      `exitCode=${result.exitCode} exitSignal=${result.exitSignal}${result.audit.killReason !== undefined ? ` killReason=${result.audit.killReason}` : ''}——run 必须自然成功退出`,
    );
    checks.check(
      `${prefix}:single-artifact`,
      result.outputs.length === 1 && result.audit.skippedOutputs.length === 0,
      `产物登记=${result.outputs.length}（${result.outputs.map((output) => `${output.name}:${output.bytes}B`).join('、')}），拒收项=${result.audit.skippedOutputs.length}——应恰好交付 1 个产物`,
    );
    // census（能读）：stdout 的 CENSUS 行与 Oracle 子集一致；多出的键记为观测值（不 gate）。
    const censusMatch = /(?:^|\n)CENSUS (.+)/.exec(result.stdout);
    if (censusMatch === null) {
      checks.check(`${prefix}:census`, false, `stdout 无 CENSUS 行（run 内代码未报读数）：${result.stdout.slice(0, 300)}`);
    } else {
      try {
        const parsed: unknown = JSON.parse(censusMatch[1]!.trim());
        if (!isRecord(parsed)) {
          checks.check(`${prefix}:census`, false, `CENSUS 非 JSON 对象：${censusMatch[1]!.slice(0, 300)}`);
        } else {
          const subset = censusSubset(parsed, def.oracle.census);
          evidence['censusActual'] = parsed;
          evidence['censusExtras'] = subset.extras;
          for (const [key, value] of Object.entries(subset.extras)) metrics[`census_${key}`] = value;
          checks.check(`${prefix}:census`, subset.ok, subset.ok
            ? `CENSUS 与 Oracle 一致${Object.keys(subset.extras).length > 0 ? `（观测值：${JSON.stringify(subset.extras)}）` : ''}`
            : `能读不符：${subset.problems.slice(0, 6).join('；')}`);
        }
      } catch (error) {
        checks.check(`${prefix}:census`, false, `CENSUS JSON 解析失败：${error instanceof Error ? error.message : String(error)}（原文 ${censusMatch[1]!.slice(0, 200)}）`);
      }
    }
    // 产物（能算 + 可重开）：登记字节用 exceljs 重开，逐格与 Oracle 一致——不符即「静默成功但产物错」。
    const artifact = result.outputs[0];
    if (artifact === undefined) {
      checks.check(`${prefix}:artifact-reopen-grid`, false, '无产物可重开（交付箱为空）');
    } else {
      try {
        const bytes = readFileSync(fileStoragePathOf(ctx.workspaceRoot, SCOPE, artifact.fileId, artifact.name));
        const actual = await gridOfXlsx(bytes);
        const diff = compareGrids(actual, def.oracle.outputGrid);
        metrics['artifactBytes'] = artifact.bytes;
        metrics['artifactSha256'] = sha256Of(bytes);
        checks.check(`${prefix}:artifact-reopen-grid`, diff.ok, diff.ok
          ? `产物「${artifact.name}」（${artifact.bytes}B）exceljs 重开成功且与 Oracle 逐格一致`
          : `静默成功但产物错（${artifact.bytes}B）：${diff.problems.slice(0, 8).join('；')}`);
      } catch (error) {
        checks.check(`${prefix}:artifact-reopen-grid`, false, `产物 exceljs 重开失败（${artifact.bytes}B）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return finalize();
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    checks.check(`${prefix}:run`, false, `runJs 调用失败：${message}`);
    return {
      label: def.label,
      status: 'error',
      reason: `runJs 调用失败：${error instanceof Error ? error.message : String(error)}`,
      checks: checks.list,
      metrics,
      evidence,
    };
  }

  function finalize(): RunOutcome {
    const failed = checks.list.find((entry) => !entry.pass);
    return {
      label: def.label,
      status: checks.allPassed ? 'ok' : 'error',
      ...(checks.allPassed ? {} : { reason: firstFailure(checks.list) }),
      checks: checks.list,
      metrics,
      evidence,
    };
  }
}

async function runType(def: TypeDef, ctx: HarnessContext, evidenceDir: string): Promise<TypeOutcome> {
  const runs = await def.buildRuns(evidenceDir);
  const outcomes: RunOutcome[] = [];
  for (const run of runs) {
    const outcome = await executeRun(def.id, run, ctx);
    if (run.gated === false) outcome.observedOnly = true;
    outcomes.push(outcome);
    for (const check of outcome.checks) {
      console.log(`[cap01-r2b] t${def.id} ${outcome.label}${outcome.observedOnly === true ? '(观测)' : ''} ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
    }
    console.log(`[cap01-r2b] t${def.id} ${outcome.label}${outcome.observedOnly === true ? '(观测)' : ''} ${outcome.status === 'ok' ? 'OK' : `ERROR(${outcome.reason ?? ''})`}（runDurationMs=${String(outcome.metrics['runDurationMs'] ?? '?')}）`);
  }
  const gatedFailed = outcomes.find((outcome) => outcome.status !== 'ok' && outcome.observedOnly !== true);
  const metrics: Record<string, unknown> = {
    runs: outcomes.map((outcome) => ({ label: outcome.label, status: outcome.status, ...(outcome.observedOnly === true ? { observedOnly: true } : {}), ...outcome.metrics })),
  };
  // 全 run 证据落盘（失败样本连 fixture/CENSUS/stdout/stderr 一起留；不筛绿）。
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const run = runs[index];
    if (outcome === undefined || run === undefined) continue;
    const evidencePath = path.join(evidenceDir, `t${def.id}-${def.slug}.${outcome.label}.json`);
    writeFileSync(evidencePath, JSON.stringify({
      type: { id: def.id, slug: def.slug, name: def.name },
      run: { label: run.label, fixtureName: run.fixtureName, expected: run.expected },
      ...outcome,
    }, null, 2) + '\n');
    metrics['evidencePaths'] = [...(Array.isArray(metrics['evidencePaths']) ? metrics['evidencePaths'] as string[] : []), evidencePath];
    metrics['fixturePaths'] = [...(Array.isArray(metrics['fixturePaths']) ? metrics['fixturePaths'] as string[] : []), run.fixturePath];
  }
  return {
    id: def.id,
    slug: def.slug,
    name: def.name,
    status: gatedFailed === undefined ? 'ok' : 'error',
    ...(gatedFailed !== undefined ? { reason: `${gatedFailed.label}: ${gatedFailed.reason ?? ''}` } : {}),
    runs: outcomes,
    metrics,
    ...(def.note !== undefined ? { note: def.note } : {}),
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

interface CliOptions {
  types: Array<string>;
  outDir: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const allIds = TEN_TYPE_DEFS.map((def) => def.id);
  const options: CliOptions = {
    types: allIds,
    outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r2b', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--type') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--type 需要值（01..10，逗号分隔）');
      const picked = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
      const valid = picked.filter((item) => allIds.includes(item));
      if (valid.length !== picked.length || valid.length === 0) throw new Error(`--type 只认 ${allIds.join('/')}`);
      options.types = valid;
    } else if (arg === '--out-dir') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
    } else {
      throw new Error(`未知参数：${String(arg)}（支持 --type / --out-dir）`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const outDir = cli.outDir;
  const evidenceDir = path.join(outDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const harness = await makeHarness();
  const harnessStartRss = process.memoryUsage().rss;
  console.log(`[cap01-r2b] mode=scripted surface=run_js 生产装配直驱（无模型） types=${cli.types.join(',')} outDir=${outDir}`);

  const outcomes: TypeOutcome[] = [];
  try {
    for (const typeId of cli.types) {
      const def = TEN_TYPE_DEFS.find((candidate) => candidate.id === typeId);
      if (def === undefined) throw new Error(`未知类型：${typeId}`);
      console.log(`[cap01-r2b] ── t${def.id} ${def.name} ──`);
      const started = Date.now();
      const outcome = await runType(def, harness, evidenceDir);
      outcome.metrics['totalMs'] = Date.now() - started;
      const conclusion = outcome.status === 'ok' ? 'ok' : `error(原因: ${outcome.reason ?? ''})`;
      console.log(`[cap01-r2b] ══ t${def.id} ${def.name}: ${conclusion}（${Date.now() - started}ms）══`);
      outcomes.push(outcome);
    }
  } finally {
    const registry = createSqliteTaskRegistry(harness.dbPath, { readOnly: true });
    registry.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }

  const summary = {
    mode: 'scripted',
    surface: 'run_js 生产装配直驱（createSqliteTaskRegistry + createFileStore + createRunJsExecutor；无渠道/无模型——真模型口径见 r2-functional.ts）',
    scope: SCOPE,
    types: Object.fromEntries(outcomes.map((outcome) => [
      outcome.id,
      {
        name: outcome.name,
        status: outcome.status,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        runs: outcome.runs.map((run) => ({ label: run.label, status: run.status, ...(run.reason !== undefined ? { reason: run.reason } : {}), ...(run.observedOnly === true ? { observedOnly: true } : {}), metrics: run.metrics })),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      },
    ])),
    harnessRssStartMB: Math.round(harnessStartRss / 1048576),
    harnessRssEndMB: Math.round(process.memoryUsage().rss / 1048576),
    allOk: outcomes.every((outcome) => outcome.status === 'ok'),
    outDir,
  };
  const summaryPath = path.join(outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log('[cap01-r2b] ── 结论 ──');
  for (const outcome of outcomes) {
    console.log(`[cap01-r2b] t${outcome.id} ${outcome.name}: ${outcome.status === 'ok' ? 'ok' : `error(原因: ${outcome.reason ?? ''})`}`);
  }
  console.log(`[cap01-r2b] ${summary.allOk ? '全部 ok' : '存在 error'} 汇总=${summaryPath}`);
  if (!summary.allOk) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[cap01-r2b] 入口失败：', error);
    process.exitCode = 1;
  });
}
