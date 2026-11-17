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
  createRecalcXlsxExecutor,
  parseRecalcFilePath,
  RECALC_XLSX_DEFAULT_MAX_VALUE_DIFFS,
  RECALC_XLSX_REQUIRED_VERSION,
  type RecalcEngine,
  type RecalcEngineFacts,
  type RecalcXlsxExecutor,
  type RecalcXlsxResult,
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
    // 报告 JSON 落 out/.recalc-report.json，保留全量 7 条。
    const newest = latestRunDir(h);
    const report = JSON.parse(readFileSync(path.join(newest, 'out', '.recalc-report.json'), 'utf8'));
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
    expect(files).toContain('.recalc-report.json');
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
