/**
 * recalc_xlsx（宿主 agent 工具，Main 面）· TDD 用例。
 *
 * 覆盖工具契约（docs/decision-log.md §九十九）：
 *   · 参数 {file, sheet?, export}；file 只能是本回合运行目录的规范相对路径 in/<fileId><安全扩展名>，
 *     绝对路径 / .. / 多级 / 反斜杠 / 非规范 / symlink 逃逸一律 path_escape；
 *   · 错误码 path_escape|not_found|corrupt|too_large|timeout|engine_failed；
 *   · 返回 {status, errorCells, valueDiffs(封顶), artifacts}；
 *   · export=csv 真出 CSV 纯数据（表头 + 逐单元格值，公式格取计算值），export=none 不出 CSV；
 *   · LO 26.8.3 独立 profile 强制 OOXML 重算，读回比对缓存值/计算值 → valueDiffs；
 *     错误格 #REF!/#VALUE!/#DIV/0! → errorCells；进程组超时 kill；无引擎 = engine_failed（fail-closed）。
 *
 * 测试用注入的**假引擎**（确定性、零 soffice 依赖）产出「计算后」工作簿；真 soffice 命令形状与
 * profile 由 executor 模块的真实引擎承担（另有 spawn/版本事件用例）。夹具在工作簿层即时构造
 * （.runtime/recalc/fixtures 被 gitignore，不能作为提交测试的依赖）。
 *
 * 另覆盖接线：Main 工具面只在注入执行器时带 recalc_xlsx（fail-closed）；**Worker 面永不上**
 * （裁定 R1/Q1②）；exec 分发按 run_js 同款门控；工具描述只写已实现事实（过
 * tool-description-facts.test.ts 的纪律）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import {
  createFileStore,
  principalHashOf,
  sessionHashOf,
  type FileStore,
} from './src/file-store';
import {
  assertWorkbookExpandedSize,
  createRecalcXlsxExecutor,
  createSofficeRecalcEngine,
  parseRecalcFilePath,
  RECALC_XLSX_DEFAULT_MAX_VALUE_DIFFS,
  RECALC_XLSX_REQUIRED_VERSION,
  type RecalcEngine,
  type RecalcEngineFacts,
  type RecalcXlsxExecutor,
  type RecalcXlsxResult,
  type SofficeChild,
} from './src/recalc-xlsx-executor';
import {
  RECALC_XLSX_TOOL,
  RECALC_XLSX_TOOL_DESCRIPTION,
  RECALC_XLSX_TOOL_SCHEMA,
  createSession,
} from './src/execution-runtime';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:recalc-u', sessionId: 'recalc-sess' };

/** 构造一个 xlsx buffer；cells: 地址 → exceljs 值（公式格写 {formula,result}）。 */
async function workbookBuffer(
  sheetName: string,
  cells: Record<string, ExcelJS.CellValue>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const [address, value] of Object.entries(cells)) ws.getCell(address).value = value;
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 假引擎成功路径：把预置的「计算后」工作簿写到 outDir（basename 与源一致）。 */
function computedEngine(computed: Buffer, facts?: Partial<RecalcEngineFacts>): RecalcEngine {
  const f: RecalcEngineFacts = {
    available: true,
    sofficePath: '/fake/soffice',
    version: RECALC_XLSX_REQUIRED_VERSION,
    ...facts,
  };
  return {
    probe: () => f,
    async convert({ sourcePath, outDir }) {
      const out = path.join(outDir, path.basename(sourcePath));
      writeFileSync(out, computed);
      return { outputPath: out };
    },
  };
}

interface Harness {
  fixtureRoot: string;
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
  /** 登记一个已激活的 xlsx 输入，返回契约里的 in/<fileId><ext> 相对路径。 */
  putInput(name: string, bytes: Buffer): string;
}

function makeHarness(): Harness {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'recalc-xlsx-'));
  dirs.push(fixtureRoot);
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  return {
    fixtureRoot,
    workspaceRoot,
    store,
    fileStore,
    putInput(name, bytes) {
      const file = fileStore.putFile({ scope: SCOPE, name, bytes, activatedAt: Date.now() });
      const ext = path.extname(name);
      return `in/${file.fileId}${ext}`;
    },
  };
}

function makeExecutor(
  h: Harness,
  engine: RecalcEngine,
  overrides: Record<string, unknown> = {},
): RecalcXlsxExecutor {
  return createRecalcXlsxExecutor({
    fileStore: h.fileStore,
    engine,
    ...overrides,
  });
}

// ───────────────────────────── 路径校验（path_escape） ─────────────────────────────
describe('recalc_xlsx 路径校验：只收规范 in/<fileId><安全扩展名>', () => {
  it('parseRecalcFilePath：规范形式解析出 fileId；所有逃逸形式一律拒绝', () => {
    expect(parseRecalcFilePath('in/file_abc123.xlsx')).toEqual({ fileId: 'file_abc123', ext: '.xlsx' });
    expect(parseRecalcFilePath('in/file_abc123')).toEqual({ fileId: 'file_abc123', ext: '' });
    for (const bad of [
      '/abs/file.xlsx',
      '../file.xlsx',
      'in/../file.xlsx',
      'in/sub/file.xlsx',
      'in\\file.xlsx',
      'out/file.xlsx',
      'scratch/file.xlsx',
      'file.xlsx',
      './in/file.xlsx',
      'in/file.xlsx?x',
      'in/file@.xlsx',
    ]) {
      expect(parseRecalcFilePath(bad), bad).toBeNull();
    }
  });

  it('执行器：绝对路径 / .. / 非规范 file → status=error,error=path_escape，且零引擎调用', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    let convertCalls = 0;
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert() { convertCalls += 1; throw new Error('不应被调用'); },
    };
    const executor = makeExecutor(h, engine);
    for (const bad of [path.join(h.fixtureRoot, 'src.xlsx'), '../src.xlsx', `./${rel}`, 'out/x.xlsx']) {
      const res = await executor.recalc({ file: bad, export: 'none', scope: SCOPE });
      expect(res.status, bad).toBe('error');
      expect(res.error, bad).toBe('path_escape');
    }
    expect(convertCalls).toBe(0);
  });

  it('执行器：物化目标是 symlink（realpath 逃逸出 runDir）→ path_escape，零转换', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    const outside = path.join(h.fixtureRoot, 'outside.xlsx');
    writeFileSync(outside, 'payload');
    // 用一个会把物化目标做成逃逸软链的 fileStore 替身（只覆盖 materializeInputs）。
    const evilStore = {
      ...h.fileStore,
      materializeInputs({ runDir }: { runDir: string }) {
        const inDir = path.join(runDir, 'in');
        mkdirSync(inDir, { recursive: true });
        const target = path.join(inDir, path.basename(rel));
        try { rmSync(target); } catch { /* noop */ }
        symlinkSync(outside, target);
        return [{ fileId: 'x', name: 'src.xlsx', materializedName: path.basename(rel) }];
      },
    } as unknown as FileStore;
    let convertCalls = 0;
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert() { convertCalls += 1; throw new Error('不应被调用'); },
    };
    const executor = createRecalcXlsxExecutor({ fileStore: evilStore, engine });
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('path_escape');
    expect(convertCalls).toBe(0);
  });
});

// ───────────────────────────── 错误码：not_found / corrupt / too_large ─────────────────────────────
describe('recalc_xlsx 输入面错误码', () => {
  const okEngine = (): RecalcEngine => ({
    probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
    async convert({ sourcePath, outDir }) {
      const out = path.join(outDir, path.basename(sourcePath));
      writeFileSync(out, sourcePath ? readFileSync(sourcePath) : Buffer.alloc(0));
      return { outputPath: out };
    },
  });

  it('fileId 不存在（未登记）→ not_found', async () => {
    const h = makeHarness();
    const executor = makeExecutor(h, okEngine());
    const res = await executor.recalc({ file: 'in/file_nonexistent.xlsx', export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('not_found');
  });

  it('非 xlsx 垃圾字节 → corrupt（exceljs 读不动），零转换', async () => {
    const h = makeHarness();
    const rel = h.putInput('bad.xlsx', Buffer.from('this is not a zip workbook'));
    let convertCalls = 0;
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert() { convertCalls += 1; throw new Error('不应被调用'); },
    };
    const executor = makeExecutor(h, engine);
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('corrupt');
    expect(convertCalls).toBe(0);
  });

  it('超过 maxInputBytes → too_large，零转换', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 111111 });
    const rel = h.putInput('big.xlsx', src);
    const executor = makeExecutor(h, okEngine(), { maxInputBytes: 10 });
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('too_large');
  });
});

// ───────────────────────────── 比对：valueDiffs / errorCells ─────────────────────────────
describe('recalc_xlsx 读回比对', () => {
  it('缓存值与计算值不一致 → status=fail,valueDiffs 含 {sheet,ref,cached,computed}', async () => {
    const h = makeHarness();
    // 源：A2 公式缓存 999（陈旧）；B1=3。计算后：A2 应为 5。
    const src = await workbookBuffer('汇总', {
      A1: 2, B1: 3, A2: { formula: 'A1+B1', result: 999 },
    });
    const computed = await workbookBuffer('汇总', {
      A1: 2, B1: 3, A2: { formula: 'A1+B1', result: 5 },
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('fail');
    expect(res.valueDiffs).toEqual([
      { sheet: '汇总', ref: 'A2', cached: 999, computed: 5 },
    ]);
    expect(res.errorCells).toEqual([]);
  });

  it('共享公式从属格 {sharedFormula,result} 缓存陈旧 → 也须报 valueDiffs（Codex P1-3）', async () => {
    const h = makeHarness();
    // A2 是共享公式 master（{formula,result}），A3 是从属格（{sharedFormula:'A2',result}，读回无 formula 属性）。
    const src = await workbookBuffer('汇总', {
      A1: 2, B1: 3,
      A2: { formula: 'A1+B1', result: 5 },
      A3: { sharedFormula: 'A2', result: 999 } as unknown as ExcelJS.CellValue,
    });
    const computed = await workbookBuffer('汇总', {
      A1: 2, B1: 3,
      A2: { formula: 'A1+B1', result: 5 },
      A3: { sharedFormula: 'A2', result: 5 } as unknown as ExcelJS.CellValue,
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('fail');
    expect(res.valueDiffs).toEqual([
      { sheet: '汇总', ref: 'A3', cached: 999, computed: 5 },
    ]);
  });

  it('缓存与计算一致（含浮点噪声）→ status=pass,valueDiffs 空', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('汇总', {
      A1: 2, B1: 3, A2: { formula: 'A1+B1', result: 5 },
    });
    const computed = await workbookBuffer('汇总', {
      A1: 2, B1: 3, A2: { formula: 'A1+B1', result: 5.0000000001 },
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('pass');
    expect(res.valueDiffs).toEqual([]);
  });

  it('金额分级差异：1e8 vs 1e8.05 须报 valueDiffs，不被相对容差吞掉（Codex P2-5）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('汇总', {
      A1: { formula: '100000000', result: 100000000 },
    });
    const computed = await workbookBuffer('汇总', {
      A1: { formula: '100000000', result: 100000000.05 },
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('fail');
    expect(res.valueDiffs).toEqual([
      { sheet: '汇总', ref: 'A1', cached: 100000000, computed: 100000000.05 },
    ]);
  });

  it('跨分位边界：100000000.004 vs .006 分位取整后差一分，须报差异（Codex R9-P2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('汇总', { A1: { formula: 'x', result: 100000000.004 } });
    const computed = await workbookBuffer('汇总', { A1: { formula: 'x', result: 100000000.006 } });
    const rel = h.putInput('src.xlsx', src);
    const res = await makeExecutor(h, computedEngine(computed)).recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('fail');
    expect(res.valueDiffs).toHaveLength(1);
  });

  it('错误格 #REF!/#VALUE!/#DIV/0! → status=fail,errorCells 逐格上报', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', {
      A1: { formula: 'NOPE!A1', result: '#N/A' },
      A2: { formula: '1/0', result: '#N/A' },
      A3: { formula: 'X&1', result: '#N/A' },
    });
    const computed = await workbookBuffer('S', {
      A1: { formula: 'NOPE!A1', result: { error: '#REF!' } },
      A2: { formula: '1/0', result: { error: '#DIV/0!' } },
      A3: { formula: 'X&1', result: { error: '#VALUE!' } },
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('fail');
    expect(res.errorCells).toEqual([
      { sheet: 'S', ref: 'A1', code: '#REF!' },
      { sheet: 'S', ref: 'A2', code: '#DIV/0!' },
      { sheet: 'S', ref: 'A3', code: '#VALUE!' },
    ]);
  });

  it('valueDiffs 进上下文封顶（maxValueDiffs）；报告 JSON 保留全量', async () => {
    const h = makeHarness();
    const srcCells: Record<string, ExcelJS.CellValue> = { A1: 1 };
    const compCells: Record<string, ExcelJS.CellValue> = { A1: 1 };
    for (let i = 2; i <= 8; i += 1) {
      srcCells[`A${i}`] = { formula: `A1+${i}`, result: 1000 + i };
      compCells[`A${i}`] = { formula: `A1+${i}`, result: i };
    }
    const src = await workbookBuffer('S', srcCells);
    const computed = await workbookBuffer('S', compCells);
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed), { maxValueDiffs: 2 });
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.valueDiffs.length).toBe(2);
    expect(RECALC_XLSX_DEFAULT_MAX_VALUE_DIFFS).toBeGreaterThanOrEqual(2);
    // 报告 JSON 落 runDir 根 .recalc-report.json（宿主独占，P1-1），保留全量 7 条。
    const newest = latestRunDir(h);
    const report = JSON.parse(readFileSync(path.join(newest, '.recalc-report.json'), 'utf8'));
    expect(report.valueDiffs.length).toBe(7);
  });
});

function listDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .sort();
}

// ───────────────────────────── export=csv / none ─────────────────────────────
describe('recalc_xlsx CSV 导出（契约显式部分）', () => {
  it('export=csv：真出 CSV 表头 + 逐单元格值，公式格取计算值', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('汇总', {
      A1: '名称', B1: '金额', A2: '甲', B2: { formula: '2*3', result: 999 },
    });
    const computed = await workbookBuffer('汇总', {
      A1: '名称', B1: '金额', A2: '甲', B2: { formula: '2*3', result: 6 },
    });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(computed));
    const res = await executor.recalc({ file: rel, export: 'csv', scope: SCOPE });
    expect(res.status).toBe('fail'); // 有 diff
    expect(res.artifacts.values).toMatch(/^out\/.*\.values\.csv$/);
    const runDir = latestRunDir(h);
    const csv = readFileSync(path.join(runDir, 'out', path.basename(res.artifacts.values!)), 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('sheet,ref,value');
    expect(lines).toContain('汇总,A1,名称');
    expect(lines).toContain('汇总,B2,6'); // 计算值，不是缓存 999
    expect(csv).not.toContain('999');
  });

  it('export=csv 但 status=fail（含错误格/差异）→ CSV 不登记为可交付 outputs（Codex R7-P2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: { formula: '1/0', result: 999 } });
    const computed = await workbookBuffer('S', { A1: { formula: '1/0', result: '#DIV/0!' } });
    const file = h.putInput('err.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'csv', scope: SCOPE });
    expect(r.status).toBe('fail');
    expect(r.outputs).toBeUndefined();
    // 即便 fail，artifacts.values 仍给出 CSV 路径供排查（只是不进交付链）。
    expect(r.artifacts.values).toMatch(/^out\/.*\.values\.csv$/);
  });

  it('export=csv：CSV 产物登记进 fileStore 并随结果返回 outputs（Codex P2-4）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('汇总', { A1: '名称', B1: { formula: '2*3', result: 6 } });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(src));
    const res = await executor.recalc({ file: rel, export: 'csv', scope: SCOPE });
    expect(res.outputs).toHaveLength(1);
    expect(res.outputs![0]!.name).toMatch(/\.values\.csv$/);
    expect(res.outputs![0]!.bytes).toBeGreaterThan(0);
    // 产物确实登记进 fileStore（可按 fileId 解析回字节）：用 listActiveFiles 核对。
    const active = h.fileStore.listActiveFiles({ scope: SCOPE, now: Date.now() });
    expect(active.some((f) => f.fileId === res.outputs![0]!.fileId && f.name === res.outputs![0]!.name)).toBe(true);
  });

  it('export=none：不出 CSV，artifacts.values 缺席', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    const executor = makeExecutor(h, computedEngine(src));
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('pass');
    expect(res.artifacts.values).toBeUndefined();
    const runDir = latestRunDir(h);
    const files = (require('node:fs') as typeof import('node:fs')).readdirSync(path.join(runDir, 'out'));
    expect(files.some((f) => f.endsWith('.values.csv'))).toBe(false);
    // P1-1：报告在 runDir 根（宿主独占），不在 out/（run_js 可写、不可信）。
    expect(files).not.toContain('.recalc-report.json');
    expect(existsSync(path.join(runDir, '.recalc-report.json'))).toBe(true);
  });

  it('sheet 只缩 CSV 展示，不缩验证范围：选干净 sheet 但别本有陈旧公式仍须 fail（Codex P1-2）', async () => {
    const h = makeHarness();
    const src = new ExcelJS.Workbook();
    src.addWorksheet('甲').getCell('A1').value = 1; // 干净本
    src.addWorksheet('乙').getCell('A1').value = { formula: '1+1', result: 999 }; // 陈旧本
    const comp = new ExcelJS.Workbook();
    comp.addWorksheet('甲').getCell('A1').value = 1;
    comp.addWorksheet('乙').getCell('A1').value = { formula: '1+1', result: 2 };
    const srcBuf = Buffer.from(await src.xlsx.writeBuffer());
    const compBuf = Buffer.from(await comp.xlsx.writeBuffer());
    const rel = h.putInput('two.xlsx', srcBuf);
    const executor = makeExecutor(h, computedEngine(compBuf));
    const res = await executor.recalc({ file: rel, sheet: '甲', export: 'csv', scope: SCOPE });
    // workbook 级判定：必须验全本，乙的陈旧 diff 不能被「只选甲」掩盖。
    expect(res.status).toBe('fail');
    const runDir = latestRunDir(h);
    const report = JSON.parse(readFileSync(path.join(runDir, '.recalc-report.json'), 'utf8'));
    expect(report.valueDiffs).toEqual(expect.arrayContaining([
      { sheet: '乙', ref: 'A1', cached: 999, computed: 2 },
    ]));
    // CSV 展示范围仍按 sheet='甲' 收窄（此步 CSV 仍在 out/，P2-4 后再改交付链）。
    const csv = readFileSync(path.join(runDir, 'out', path.basename(res.artifacts.values!)), 'utf8');
    expect(csv).not.toContain('999');
  });

  it('sheet 选项：只导出指定 sheet 的单元格', async () => {
    const h = makeHarness();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('甲').getCell('A1').value = 'only-jia';
    wb.addWorksheet('乙').getCell('A1').value = 'only-yi';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rel = h.putInput('two.xlsx', buf);
    const executor = makeExecutor(h, computedEngine(buf));
    const res = await executor.recalc({ file: rel, sheet: '甲', export: 'csv', scope: SCOPE });
    expect(res.status).toBe('pass');
    const runDir = latestRunDir(h);
    const csv = readFileSync(path.join(runDir, 'out', path.basename(res.artifacts.values!)), 'utf8');
    expect(csv).toContain('only-jia');
    expect(csv).not.toContain('only-yi');
  });
});

function latestRunDir(h: Harness): string {
  const root = path.join(
    h.workspaceRoot,
    principalHashOf(SCOPE.principalId),
    sessionHashOf(SCOPE.sessionId),
    'runs',
  );
  const dirs = listDirs(root);
  return dirs[dirs.length - 1]!;
}

// ───────────────────────────── 引擎失败 / 超时 ─────────────────────────────
describe('recalc_xlsx 引擎边界（fail-closed）', () => {
  it('无引擎（probe 不可用）→ available=false，调用返回 engine_failed（不是崩）', async () => {
    const h = makeHarness();
    const engine: RecalcEngine = { probe: () => null, async convert() { throw new Error('不应被调用'); } };
    const events: Array<Record<string, unknown>> = [];
    const executor = createRecalcXlsxExecutor({ fileStore: h.fileStore, engine, onEngineEvent: (e) => events.push(e as never) });
    expect(executor.available).toBe(false);
    expect(executor.engineFacts).toBeNull();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('engine_failed');
    // 启动结构化事件：available=false，不进用户话术。
    expect(events.some((e) => e.available === false)).toBe(true);
  });

  it('版本非 26.8.3 → available=false（结构化事件带 version）', () => {
    const h = makeHarness();
    const events: Array<Record<string, unknown>> = [];
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: '7.4.0' }),
      async convert() { throw new Error('不应被调用'); },
    };
    createRecalcXlsxExecutor({ fileStore: h.fileStore, engine, onEngineEvent: (e) => events.push(e as never) });
    expect(events.some((e) => e.version === '7.4.0' && e.available === false)).toBe(true);
  });

  it('spawn 失败（convert 抛错）→ engine_failed', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert() { throw new Error('spawn ENOENT'); },
    };
    const executor = makeExecutor(h, engine);
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(res.status).toBe('error');
    expect(res.error).toBe('engine_failed');
    // Codex R9-P1：失败也须落 fail 报告，投递门才能拦住已排队的文件。
    const { collectRecalcReports } = await import('./src/recalc-xlsx-executor');
    const reports = collectRecalcReports(h.workspaceRoot, SCOPE);
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ name: 'src.xlsx', status: 'fail' });
    const { decideRecalcDelivery, RECALC_DELIVERY_GATE_STATUS } = await import('./src/recalc-xlsx-executor');
    const decision = decideRecalcDelivery({ bytes: src, name: 'src.xlsx', reports });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL);
  });

  it('超时（引擎不响应 abort，执行器超时哨兵）→ timeout', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 1 });
    const rel = h.putInput('src.xlsx', src);
    const engine: RecalcEngine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert() { await new Promise((resolve) => setTimeout(resolve, 5000)); throw new Error('late'); },
    };
    const executor = makeExecutor(h, engine, { timeoutMs: 25 });
    const started = Date.now();
    const res = await executor.recalc({ file: rel, export: 'none', scope: SCOPE });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe('error');
    expect(res.error).toBe('timeout');
  });
});

// ───────────────────────────── 接线：工具面 / 分发 / 描述 ─────────────────────────────
const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};
class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> { return MANIFEST; }
  async execute(): Promise<ExecutionOutcome> { return { status: 'completed', data: {} }; }
}
const noopWorker: TurnDriver = {
  async run() { return { text: '', messages: [] as unknown as DriverMessage[] }; },
};
const neverRecalc: RecalcXlsxExecutor = {
  available: true,
  engineFacts: null,
  async recalc() { throw new Error('不应被调用'); },
};

async function captureFace(input: { withRecalc?: boolean }): Promise<{
  toolNames: string[];
  executed: Array<{ tool: string; args: Record<string, unknown> }>;
  result: unknown;
}> {
  const h = makeHarness();
  const executed: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let toolNames: string[] = [];
  const executor = input.withRecalc === true ? neverRecalc : undefined;
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: {
      async run(runInput) {
        toolNames = runInput.tools.map((t) => t.name);
        const args = { file: 'in/file_x.xlsx', export: 'none' };
        const result = await runInput.exec(RECALC_XLSX_TOOL, args);
        executed.push({ tool: RECALC_XLSX_TOOL, args });
        return { text: 'ok', messages: [] as unknown as DriverMessage[], ...(result === undefined ? {} : {}) };
      },
    },
    workerDriver: noopWorker,
    mainSystemPrompt: 'test',
    taskRegistry: h.store as never,
    ...(executor === undefined ? {} : { recalcXlsxExecutor: executor }),
  });
  let result: unknown;
  try {
    const turn = await session.send('recalc');
    result = turn;
  } catch (error) {
    result = error;
  }
  return { toolNames, executed, result };
}

describe('recalc_xlsx 接线（fail-closed + Worker 不上）', () => {
  it('未注入执行器：工具面无 recalc_xlsx，exec 直调被拒', async () => {
    const face = await captureFace({ withRecalc: false });
    expect(face.toolNames).not.toContain(RECALC_XLSX_TOOL);
    expect(String(face.result)).toContain('Main 工具面之外的调用');
  });

  it('注入执行器：工具面带 recalc_xlsx，schema 与常量一致', async () => {
    const face = await captureFace({ withRecalc: true });
    expect(face.toolNames).toContain(RECALC_XLSX_TOOL);
    expect(RECALC_XLSX_TOOL_SCHEMA).toEqual({
      type: 'object',
      properties: {
        file: expect.any(Object),
        sheet: expect.any(Object),
        export: expect.any(Object),
      },
      required: ['file', 'export'],
      additionalProperties: false,
    });
  });

  it('handler 把 recalc 的 CSV 产物收进 turnFiles（Codex P2-4）', async () => {
    const h = makeHarness();
    const csvOut = { fileId: 'file_csvout1', name: 'src.values.csv', bytes: 42 };
    const outputExecutor: RecalcXlsxExecutor = {
      available: true,
      engineFacts: null,
      async recalc() {
        return {
          status: 'pass', errorCells: [], valueDiffs: [],
          artifacts: { report: '.recalc-report.json', values: 'out/src.values.csv' },
          outputs: [csvOut],
        };
      },
    };
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(runInput) {
          await runInput.exec(RECALC_XLSX_TOOL, { file: 'in/file_x.xlsx', export: 'csv' });
          return { text: 'ok', messages: [] as unknown as DriverMessage[] };
        },
      },
      workerDriver: noopWorker,
      mainSystemPrompt: 'test',
      taskRegistry: h.store as never,
      recalcXlsxExecutor: outputExecutor,
    });
    const turn = await session.send('export csv');
    expect(turn.files).toEqual([csvOut]);
  });

  it('Worker 工具面永不上 recalc_xlsx（即使注入执行器）', async () => {
    // 静态守卫：Worker 工具面装配处不得出现 recalcTool()。
    const { readFileSync: read } = require('node:fs') as typeof import('node:fs');
    const src = read(path.join(__dirname, 'src', 'execution-runtime.ts'), 'utf8');
    const workerToolsLine = src.split('\n').find((l) => l.includes('tools: [executeOperationTool()'));
    expect(workerToolsLine).toBeDefined();
    expect(workerToolsLine).not.toContain('recalc');
  });

  it('工具描述只写已实现事实：不含业务流程话术、不诱导其它工具', () => {
    for (const phrase of ['请重试', '兜底', '话术', '告诉用户', '汇报给用户', '如果失败', '失败就']) {
      expect(RECALC_XLSX_TOOL_DESCRIPTION).not.toContain(phrase);
    }
    expect(RECALC_XLSX_TOOL_DESCRIPTION).not.toContain('task_run');
    expect(RECALC_XLSX_TOOL_DESCRIPTION).toContain('in/<fileId><安全扩展名>');
    expect(RECALC_XLSX_TOOL_DESCRIPTION).toContain('export');
    expect(RECALC_XLSX_TOOL_DESCRIPTION).toContain('csv');
  });
});

// ───────────────────────────── 独立复核 Gap1：LO 重算耗时进 R4 资源账 + 结构化事件 ─────────────────────────────
import { createResourcePolicy } from './src/resource-policy';

describe('recalc_xlsx 重算开销入 R4 账（独立复核 Gap1）', () => {
  /** 注入执行器：recalc 结果带 durationMs，供 runtime 计量与结构化事件。 */
  const costExecutor = (durationMs: number): RecalcXlsxExecutor => ({
    available: true,
    engineFacts: null,
    async recalc(input): Promise<RecalcXlsxResult> {
      void input;
      return {
        status: 'pass', errorCells: [], valueDiffs: [],
        artifacts: { report: 'out/.recalc-report.json' },
        durationMs,
      };
    },
  });

  it('一次 recalc 调用：前台预算 calls+1 且 ms 累计 ≈ durationMs；onRecalcCost 报耗时事件', async () => {
    const h = makeHarness();
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 10 } });
    const events: Array<Record<string, unknown>> = [];
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(runInput) {
          await runInput.exec(RECALC_XLSX_TOOL, { file: 'in/file_x.xlsx', export: 'none' });
          return { text: 'ok', messages: [] as unknown as DriverMessage[] };
        },
      },
      workerDriver: noopWorker,
      mainSystemPrompt: 'test',
      taskRegistry: h.store as never,
      recalcXlsxExecutor: costExecutor(137),
      policy,
      onRecalcCost: (event) => events.push(event as never),
    });
    await session.send('recalc');
    const budget = policy.budgetFor(`session:${SCOPE.principalId}:${SCOPE.sessionId}`);
    expect(budget.used.calls).toBe(1);
    expect(budget.used.ms).toBeGreaterThanOrEqual(137);
    expect(events).toHaveLength(1);
    expect(events[0]!.engineMs).toBe(137);
    expect(events[0]!.status).toBe('pass');
    expect(events[0]!.principalId).toBe(SCOPE.principalId);
  });

  it('预算耗尽（calls=1）：第二次 recalc 被预检拒绝，不执行（Codex R11-P2）', async () => {
    const h = makeHarness();
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 1 } });
    let executed = 0;
    const executor: RecalcXlsxExecutor = {
      available: true, engineFacts: null,
      async recalc() { executed += 1; return { status: 'pass', errorCells: [], valueDiffs: [], artifacts: { report: 'out/.recalc-report.json' }, durationMs: 5 }; },
    };
    const results: string[] = [];
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(runInput) {
          for (let i = 0; i < 2; i++) {
            try { await runInput.exec(RECALC_XLSX_TOOL, { file: 'in/file_x.xlsx', export: 'none' }); results.push('ok'); }
            catch { results.push('rejected'); }
          }
          return { text: 'ok', messages: [] as unknown as DriverMessage[] };
        },
      },
      workerDriver: noopWorker,
      mainSystemPrompt: 'test',
      taskRegistry: h.store as never,
      recalcXlsxExecutor: executor,
      policy,
    });
    await session.send('recalc');
    expect(results).toEqual(['ok', 'rejected']);
    expect(executed).toBe(1);
  });

  it('无 policy（缺省）→ recalc 仍可用，无预算对象可入账但不报错', async () => {
    const h = makeHarness();
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(runInput) {
          const r = await runInput.exec(RECALC_XLSX_TOOL, { file: 'in/file_x.xlsx', export: 'none' });
          expect((r as RecalcXlsxResult).status).toBe('pass');
          return { text: 'ok', messages: [] as unknown as DriverMessage[] };
        },
      },
      workerDriver: noopWorker,
      mainSystemPrompt: 'test',
      taskRegistry: h.store as never,
      recalcXlsxExecutor: costExecutor(5),
    });
    await expect(session.send('recalc')).resolves.toBeDefined();
  });
});

// ───────────────────────── Codex 二轮复审 4×P2 回归 ─────────────────────────
describe('recalc_xlsx Codex 二轮复审 P2 回归', () => {
  it('执行器对不支持的公式形态返回 unsupported_formula，不盖 pass 章（Codex R7-P2）', async () => {
    const h = makeHarness();
    // 构造真·数组公式源文件（exceljs 写回会丢 ref，手工在 OOXML 注入 t=array ref）。
    const base = await workbookBuffer('S', { A1: { formula: 'TRANSPOSE(C1:D1)', result: 1 }, C1: 1, D1: 2 });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(base);
    const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))!;
    let xml = await zip.file(sheetName)!.async('string');
    xml = xml.replace(/<f>(TRANSPOSE\(C1:D1\))<\/f>/, '<f t="array" ref="A1:A2">$1</f>');
    zip.file(sheetName, xml);
    const file = h.putInput('array.xlsx', Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })));
    const ex = makeExecutor(h, computedEngine(base));
    const r = await ex.recalc({ file, export: 'none', scope: SCOPE });
    expect(r.status).toBe('error');
    expect(r.error).toBe('unsupported_formula');
  });

  it('CSV 注入（控制字符前缀）：\\t=1+1 也被中和（Codex R7-P2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: '\t=1+1' });
    const computed = await workbookBuffer('S', { A1: '\t=1+1' });
    const file = h.putInput('ctrl.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'csv', scope: SCOPE });
    expect(r.status).toBe('pass');
    const csv = readFileSync(path.join(latestRunDir(h), 'out', path.basename(r.artifacts.values!)), 'utf8');
    expect(csv).not.toMatch(/S,A1,\t?=1\+1/);
  });

  it('CSV 注入：以 = 开头的文本被中和为纯数据，数字保持（Codex R6-P2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: '=1+1', B1: -12.5, C1: '@SUM' });
    const computed = await workbookBuffer('S', { A1: '=1+1', B1: -12.5, C1: '@SUM' });
    const file = h.putInput('inject.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'csv', scope: SCOPE });
    expect(r.status).toBe('pass');
    const csv = readFileSync(path.join(latestRunDir(h), 'out', path.basename(r.artifacts.values!)), 'utf8');
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM");
    expect(csv).toContain('-12.5');
    expect(csv).not.toMatch(/S,A1,=1\+1/);
  });

  it('压缩炸弹：实际解压字节超限被流式截断拒绝，不看 CD 声明（Codex R6/R12-P1）', async () => {
    // 构造真实 >128MB 解压内容（全 0 高度压缩，ZIP 本体很小）。关键：即便把 CD 声明
    // 改成 1KB 伪造，流式解压计数仍能发现真实大小并中断——这正是结构性修法的证据。
    const JSZipLib = (await import('jszip')).default;
    const zip = new JSZipLib();
    const chunk = '0'.repeat(1024 * 1024);
    zip.file('bomb.xml', chunk.repeat(129)); // 129MB 解压内容
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    // 伪造 CD 声明尺寸为 512（攻击者手法）——新校验不应被它影响。
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    let p = bytes.readUInt32LE(eocd + 16);
    bytes.writeUInt32LE(512, p + 24);
    await expect(assertWorkbookExpandedSize(bytes)).rejects.toThrow(/too_large/);
  });

  it('前导字节 ZIP 的压缩炸弹仍被拒（JSZip 能解析前导字节，实际解压计数不依赖 CD 偏移）', async () => {
    const JSZipLib = (await import('jszip')).default;
    const zip = new JSZipLib();
    const chunk = '0'.repeat(1024 * 1024);
    zip.file('bomb.xml', chunk.repeat(129));
    const body = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const withPreamble = Buffer.concat([Buffer.alloc(16, 0x41), body]);
    await expect(assertWorkbookExpandedSize(withPreamble)).rejects.toThrow(/too_large/);
  });

  it('falsy result（0/false）：公式结果 0 能被读回，一致→pass、CSV 出 0（Codex R5-P1）', async () => {
    const h = makeHarness();
    // ExcelJS 写回后 cell.value 会省略 result=0，但 cell.result 保留——必须读 cell.result。
    const src = await workbookBuffer('S', { A1: { formula: '1-1', result: 0 }, A2: { formula: '1=1', result: false } });
    const computed = await workbookBuffer('S', { A1: { formula: '1-1', result: 0 }, A2: { formula: '1=1', result: false } });
    const file = h.putInput('falsy.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'csv', scope: SCOPE });
    expect(r.status).toBe('pass');
    expect(r.valueDiffs).toHaveLength(0);
    const runDir = latestRunDir(h);
    const csv = readFileSync(path.join(runDir, 'out', path.basename(r.artifacts.values!)), 'utf8');
    expect(csv).toContain('S,A1,0');
    expect(csv).not.toContain('[object Object]');
  });

  it('日期公式：cached/computed 为不同 Date 对象但时间戳相同 → pass（Codex R2-P2-1）', async () => {
    const h = makeHarness();
    const d = new Date('2026-01-01T00:00:00.000Z');
    const src = await workbookBuffer('S', { A1: { formula: 'DATE(2026,1,1)', result: new Date(d.getTime()) } });
    const computed = await workbookBuffer('S', { A1: { formula: 'DATE(2026,1,1)', result: new Date(d.getTime()) } });
    const file = h.putInput('date.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'none', scope: SCOPE });
    expect(r.status).toBe('pass');
    expect(r.valueDiffs).toHaveLength(0);
  });

  it('CSV：超链接/富文本格导出其 text，不出 [object Object]（Codex R2-P2-2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('S', { A1: 'plain', A2: 'placeholder' });
    // 计算后 workbook 含超链接与富文本结构化 cell。
    const outWb = new ExcelJS.Workbook();
    const ws = outWb.addWorksheet('S');
    ws.getCell('A1').value = { text: 'Example', hyperlink: 'https://example.com' } as ExcelJS.CellHyperlinkValue;
    ws.getCell('A2').value = { richText: [{ text: 'Hello ' }, { text: 'World' }] } as ExcelJS.CellRichTextValue;
    const computed = Buffer.from(await outWb.xlsx.writeBuffer());
    const file = h.putInput('rich.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, export: 'csv', scope: SCOPE });
    expect(r.status).toBe('pass');
    const runDir = latestRunDir(h);
    const csv = readFileSync(path.join(runDir, 'out', path.basename(r.artifacts.values!)), 'utf8');
    expect(csv).toContain('Example');
    expect(csv).toContain('Hello World');
    expect(csv).not.toContain('[object Object]');
  });

  // 假 child：once('error') 注册即记录；emit('error') 触发 rejection；pid 可控。
  function fakeChild(opts: { pid?: number; emitError?: Error; close?: boolean; autoClose?: boolean }): SofficeChild & { fireError(): void; readonly errorRegistered: boolean; readonly closeRegistered: boolean } {
    let onError: ((e: Error) => void) | undefined;
    let onClose: (() => void) | undefined;
    return {
      pid: opts.pid,
      once(event, listener) {
        if (event === 'error') onError = listener as (e: Error) => void;
        else {
          onClose = listener as () => void;
          if (opts.autoClose) queueMicrotask(() => onClose?.());
        }
        return this;
      },
      get errorRegistered() { return onError !== undefined; },
      get closeRegistered() { return onClose !== undefined; },
      fireError() { onError?.(opts.emitError ?? new Error('spawn ENOENT')); },
      fireClose() { onClose?.(); },
    } as SofficeChild & { fireError(): void; readonly errorRegistered: boolean; readonly closeRegistered: boolean };
  }

  it('spawn 失败：error handler 先于 pid 检查注册，不产生 unhandled error（Codex R2-P2-3）', async () => {
    const h = makeHarness();
    const child = fakeChild({ pid: undefined, emitError: new Error('spawn ENOENT') });
    let registered = false;
    const engine = createSofficeRecalcEngine({
      profileRoot: path.join(h.fixtureRoot, 'profiles'),
      spawnProcess: () => { registered = true; return child; },
    });
    // 关键：在 pid===undefined 抛错前，error handler 必须已挂（fakeChild.once 被调用）。
    // 用 process.on('unhandledRejection') 监听，确保没有裸 error 事件逃逸。
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await engine.convert({ sourcePath: '/tmp/x.xlsx', outDir: h.fixtureRoot, signal: new AbortController().signal });
    } catch {
      // 期望抛错（spawn 失败）
    }
    // 关键：convert 抛错后再真的触发 child 的 error 事件——被遗弃的 processOutcome
    // 必须已有 no-op rejection handler，否则这里会产生 unhandledRejection 终止 Node。
    child.fireError();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(registered).toBe(true);
    // 核心不变量：pid 检查抛错时，error handler 必须已经挂上（否则 Node 未处理 error 会杀 server）。
    expect(child.errorRegistered).toBe(true);
    expect(unhandled).toHaveLength(0);
  });

  it('pre-aborted signal：spawn 前即拒，绝不启动 soffice（Codex R2-P2-4）', async () => {
    const h = makeHarness();
    let spawned = 0;
    const engine = createSofficeRecalcEngine({
      profileRoot: path.join(h.fixtureRoot, 'profiles'),
      spawnProcess: () => { spawned += 1; return fakeChild({ pid: 12345, close: true }); },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(engine.convert({ sourcePath: '/tmp/x.xlsx', outDir: h.fixtureRoot, signal: ctrl.signal })).rejects.toThrow(/aborted/);
    expect(spawned).toBe(0);
  });

  it('sheet 指向不存在的表 → error not_found，不产出空 CSV（Codex R3-P2）', async () => {
    const h = makeHarness();
    const src = await workbookBuffer('Actual', { A1: 42 });
    const computed = await workbookBuffer('Actual', { A1: 42 });
    const file = h.putInput('sheet.xlsx', src);
    const ex = makeExecutor(h, computedEngine(computed));
    const r = await ex.recalc({ file, sheet: 'Missing', export: 'csv', scope: SCOPE });
    expect(r.status).toBe('error');
    expect(r.error).toBe('not_found');
    expect(r.artifacts.values).toBeUndefined();
  });

  it('convert 结束（成功/失败）后独立 profile 被清理（Codex R3-P2）', async () => {
    const h = makeHarness();
    const profileRoot = path.join(h.fixtureRoot, 'profiles-r3');
    const engine = createSofficeRecalcEngine({
      profileRoot,
      spawnProcess: () => fakeChild({ pid: 12345, autoClose: true }),
    });
    writeFileSync(path.join(h.fixtureRoot, 'x.xlsx'), 'stub');
    try { await engine.convert({ sourcePath: path.join(h.fixtureRoot, 'x.xlsx'), outDir: h.fixtureRoot, signal: new AbortController().signal }); } catch { /* 输出缺失 → engine_failed，不影响清理断言 */ }
    expect(existsSync(profileRoot)).toBe(true);
    expect(require('node:fs').readdirSync(profileRoot)).toHaveLength(0);
  });
});
