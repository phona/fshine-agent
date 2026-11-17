/**
 * recalc_xlsx 执行器（宿主 agent 工具，Main 面；docs/decision-log.md §九十九）。
 *
 * 职责：把一个「本回合运行目录内的 xlsx」交给 LibreOffice 强制重算后读回，比对
 * 缓存值与计算值、检测公式错误格、按需导出 CSV 纯数据。产物落本回合 runDir/out/，
 * 与 run_js 同一 fileStore 纪律（不新增第二套协议/框架）。
 *
 * 边界（B 类确定性不变量，不依赖模型遵守提示词）：
 *   · file 只接受规范相对路径 in/<fileId><安全扩展名>；绝对/.. /多级/反斜杠/非规范
 *     一律 path_escape；物化目标 realpath 逃出 runDir/in 同样 path_escape；
 *   · 无 soffice 或版本不符 → 启动时 available=false、工具不上工具面；运行期调用
 *     返回 engine_failed（fail-closed），不崩；
 *   · 超时杀整组进程（detached spawn 的 pgid = pid），哨兵超时不依赖引擎配合。
 *
 * LO 重算事实（2026-11-17 实测）：profile 里 `OOXMLRecalcMode` 必须 oor:type="xs:int"
 * 且值 = 0（强制重算）；值 1 或不带 type 会让 LO 沿用缓存（陈旧值不被发现）。独立
 * UserInstallation profile 每次新建，避免与用户/其它进程共享配置。
 *
 * 进程 spawn 只在本模块（runtime 经 type-only import 端口，import 图守卫钉住）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  FileRefUnavailableError,
  runDirOf,
  sessionDirOf,
  type FileStore,
  type FileScope,
} from './file-store';
import { workerSubprocessEnv } from './worker-env';

/** 固定版本（Q1①）：低于/不等于此前缀一律不上工具面。 */
export const RECALC_XLSX_REQUIRED_VERSION = '26.8.3';
/** 进上下文的 valueDiffs 条数上限（机械事实全量落 report，进模型上下文封顶）。 */
export const RECALC_XLSX_DEFAULT_MAX_VALUE_DIFFS = 50;
/** 输入字节上限（与入站附件同量级，防超大工作簿拖垮 LO）。 */
export const RECALC_XLSX_DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 超时上限（宿主常量；模型无 timeoutMs 参数）。 */
export const RECALC_XLSX_DEFAULT_TIMEOUT_MS = 120_000;
/** 数值比对相对容差（吸收 LO 浮点尾数差异，不掩盖真实陈旧值）。 */
const VALUE_COMPARE_REL_TOL = 1e-9;
/** 错误码集合（契约；不得改名）。 */
export type RecalcErrorCode =
  | 'path_escape' | 'not_found' | 'corrupt' | 'too_large' | 'timeout' | 'engine_failed';

/** file 参数解析结果；非规范形式返回 null。 */
export interface RecalcFilePath {
  readonly fileId: string;
  readonly ext: string;
}

/** 只接受 in/<fileId><安全扩展名>；fileId 形如 file_<hex>。 */
const FILE_PATH_PATTERN = /^in\/(file_[A-Za-z0-9]+)(\.[A-Za-z0-9]{1,16})?$/;

export function parseRecalcFilePath(raw: string): RecalcFilePath | null {
  if (typeof raw !== 'string' || raw !== raw.trim()) return null;
  if (raw.includes('\\') || raw.includes('\0') || raw.includes('?') || raw.includes('#')) return null;
  const match = FILE_PATH_PATTERN.exec(raw);
  if (match === null) return null;
  return { fileId: match[1]!, ext: match[2] ?? '' };
}

/** 启动时探测到的引擎事实（结构化事件；不进用户话术）。 */
export interface RecalcEngineFacts {
  readonly available: boolean;
  readonly sofficePath: string;
  readonly version: string;
}

/** 引擎端口：probe 在构造时调用一次；convert 每次调用独立 profile。 */
export interface RecalcEngine {
  probe(): RecalcEngineFacts | null;
  convert(input: {
    sourcePath: string;
    outDir: string;
    signal: AbortSignal;
  }): Promise<{ outputPath: string }>;
}

export interface RecalcErrorCell {
  sheet: string;
  ref: string;
  code: string;
}
export interface RecalcValueDiff {
  sheet: string;
  ref: string;
  cached: ExcelJS.CellValue;
  computed: ExcelJS.CellValue;
}
export interface RecalcArtifacts {
  report: string;
  values?: string;
}
export interface RecalcXlsxResult {
  status: 'pass' | 'fail' | 'error';
  error?: RecalcErrorCode;
  errorCells: RecalcErrorCell[];
  valueDiffs: RecalcValueDiff[];
  artifacts: RecalcArtifacts;
  /** 引擎重算墙钟耗时（ms）；R4 资源账与结构化事件用。缺省装配的执行器必填，注入替身可省。 */
  durationMs?: number;
}

/** 单次 recalc 的开销事件（结构化事件，只进日志/资源账，不进用户话术）。 */
export interface RecalcCostEvent {
  readonly engineMs: number;
  readonly status: RecalcXlsxResult['status'];
}

export interface RecalcXlsxInput {
  /** 契约参数：本回合运行目录的规范相对路径 in/<fileId><安全扩展名>。 */
  file: string;
  sheet?: string;
  export: 'csv' | 'none';
  /** 宿主注入的作用域（模型不可提供）；决定 runDir 与物化解析。 */
  scope: FileScope;
  signal?: AbortSignal;
}

export interface RecalcXlsxExecutor {
  readonly available: boolean;
  readonly engineFacts: RecalcEngineFacts | null;
  recalc(input: RecalcXlsxInput): Promise<RecalcXlsxResult>;
}

export interface RecalcXlsxExecutorOptions {
  fileStore: FileStore;
  engine: RecalcEngine;
  timeoutMs?: number;
  maxInputBytes?: number;
  /** 进上下文的 valueDiffs 条数上限；全量仍写 report。 */
  maxValueDiffs?: number;
  onEngineEvent?: (event: {
    available: boolean;
    version: string | null;
    sofficePath: string | null;
    reason?: string;
  }) => void;
}

/** 单元格的「值」：公式格取计算/缓存 result；错误格保留 {error}。 */
function cellValueOf(value: ExcelJS.CellValue | undefined): ExcelJS.CellValue {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    return (value as { result: ExcelJS.CellValue }).result ?? null;
  }
  return value ?? null;
}

function errorCodeOf(value: ExcelJS.CellValue): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    const err = (value as { error: unknown }).error;
    if (typeof err === 'string') return err;
  }
  return null;
}

function valuesEqual(a: ExcelJS.CellValue, b: ExcelJS.CellValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= VALUE_COMPARE_REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return false;
}

/** CSV 单元格转义（逗号/引号/换行包引号，内部引号翻倍）。 */
function csvCell(value: ExcelJS.CellValue): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

/** 结果里的机械路径均相对 runDir（与 run_js 的 out/ 约定一致）。 */
function relativeArtifact(runDir: string, absolute: string): string {
  return path.relative(runDir, absolute).split(path.sep).join('/');
}

export function createRecalcXlsxExecutor(options: RecalcXlsxExecutorOptions): RecalcXlsxExecutor {
  const timeoutMs = options.timeoutMs ?? RECALC_XLSX_DEFAULT_TIMEOUT_MS;
  const maxInputBytes = options.maxInputBytes ?? RECALC_XLSX_DEFAULT_MAX_INPUT_BYTES;
  const maxValueDiffs = options.maxValueDiffs ?? RECALC_XLSX_DEFAULT_MAX_VALUE_DIFFS;

  // 启动探测一次：版本不符/不可用即 available=false（上报结构化事件，不进话术）。
  const facts = options.engine.probe();
  const available =
    facts !== null && facts.available === true && facts.version.startsWith(RECALC_XLSX_REQUIRED_VERSION);
  options.onEngineEvent?.({
    available,
    version: facts?.version ?? null,
    sofficePath: facts?.sofficePath ?? null,
    ...(available ? {} : { reason: facts === null ? 'engine_absent' : 'version_mismatch' }),
  });

  return {
    available,
    engineFacts: facts,
    async recalc(input: RecalcXlsxInput): Promise<RecalcXlsxResult> {
      const startedAt = Date.now();
      const parsed = parseRecalcFilePath(input.file);
      if (parsed === null) return errorResult('path_escape');
      if (!available) return errorResult('engine_failed');

      const scope = input.scope;
      if (scope === undefined || !scope.principalId || !scope.sessionId) {
        throw new Error('recalc_xlsx 需要 scope（宿主注入）。');
      }
      const runId = `run_${randomUUID().replaceAll('-', '')}`;
      const runDir = runDirOf(options.fileStore.workspaceRoot, scope, runId);
      const outDir = path.join(runDir, 'out');
      mkdirSync(outDir, { recursive: true });

      // 物化（scope/激活/TTL 校验）；fileId 不可用 → not_found（统一码，不泄露存在性）。
      let materialized;
      try {
        const list = options.fileStore.materializeInputs({
          runDir,
          scope,
          fileIds: [parsed.fileId],
          resolution: { side: 'main' },
        });
        materialized = list[0];
      } catch (error) {
        if (error instanceof FileRefUnavailableError) return errorResult('not_found');
        throw error;
      }
      if (materialized === undefined) return errorResult('not_found');

      const inDir = path.join(runDir, 'in');
      const sourcePath = path.join(inDir, materialized.materializedName);
      // realpath 逃逸校验（symlink）：真实路径必须在 in/ 之内，否则 path_escape。
      try {
        const realIn = realpathSync(inDir);
        const realSource = realpathSync(sourcePath);
        const rel = path.relative(realIn, realSource);
        if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          return errorResult('path_escape');
        }
        const st = lstatSync(sourcePath);
        if (st.isSymbolicLink() || !st.isFile()) return errorResult('path_escape');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return errorResult('not_found');
        return errorResult('path_escape');
      }

      try {
        if (statSync(sourcePath).size > maxInputBytes) return errorResult('too_large');
      } catch {
        return errorResult('not_found');
      }

      // 源必须是可读 xlsx（缓存值来源）；读不动 → corrupt（不起引擎）。
      let srcWb: ExcelJS.Workbook;
      try {
        srcWb = await readWorkbook(sourcePath);
      } catch {
        return errorResult('corrupt');
      }

      // 引擎转换（强制重算）；带超时哨兵 + abort（不依赖引擎配合）。
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted === true) controller.abort();
      let outputPath: string;
      try {
        const converted = await withTimeout(
          options.engine.convert({ sourcePath, outDir, signal: controller.signal }),
          timeoutMs,
          controller,
        );
        outputPath = converted.outputPath;
      } catch (error) {
        if (isTimeout(error)) return errorResult('timeout');
        return errorResult('engine_failed');
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
      }

      // 计算后工作簿读回；读不动 → corrupt。
      let outWb: ExcelJS.Workbook;
      try {
        outWb = await readWorkbook(outputPath);
      } catch {
        return errorResult('corrupt');
      }

      const errorCells: RecalcErrorCell[] = [];
      const allDiffs: RecalcValueDiff[] = [];
      const csvRows: string[] = ['sheet,ref,value'];
      const selectedSheets =
        input.sheet === undefined
          ? srcWb.worksheets.map((ws) => ws.name)
          : srcWb.worksheets.some((ws) => ws.name === input.sheet)
            ? [input.sheet]
            : [];

      for (const sheetName of selectedSheets) {
        const srcSheet = srcWb.getWorksheet(sheetName);
        const outSheet = outWb.getWorksheet(sheetName);
        if (srcSheet === undefined) continue;
        srcSheet.eachRow((row, rowNumber) => {
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const address = cell.address;
            const cachedCell = cell.value;
            const computedCell = outSheet?.getCell(rowNumber, colNumber).value;
            const computedValue = cellValueOf(computedCell);
            const err = errorCodeOf(computedValue);
            if (err !== null) {
              errorCells.push({ sheet: sheetName, ref: address, code: err });
            }
            const isFormula = !!cachedCell && typeof cachedCell === 'object' && !Array.isArray(cachedCell)
              && 'formula' in cachedCell;
            if (isFormula) {
              const cachedValue = cellValueOf(cachedCell);
              if (!valuesEqual(cachedValue, computedValue)) {
                allDiffs.push({ sheet: sheetName, ref: address, cached: cachedValue, computed: computedValue });
              }
            }
            if (input.export === 'csv' && computedValue !== null) {
              csvRows.push(`${csvCell(sheetName)},${csvCell(address)},${csvCell(computedValue)}`);
            }
          });
        });
      }

      // 报告：全量机械事实落盘（进上下文的 valueDiffs 才封顶）。
      // 投递闸绑定字段（步骤 ③）：name = 输入文件用户可见名、sha256 = 源字节哈希——
      // 投递面据此确认「这份报告是对那个待投递文件做的实算」（不匹配 = 不投递）。
      const reportStatus = errorCells.length > 0 || allDiffs.length > 0 ? 'fail' : 'pass';
      const reportPath = path.join(outDir, '.recalc-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify({
          status: reportStatus,
          name: materialized.name,
          sha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
          file: input.file,
          sheet: input.sheet ?? null,
          engine: options.engine.probe(),
          errorCells,
          valueDiffs: allDiffs,
          counts: { errorCells: errorCells.length, valueDiffs: allDiffs.length },
        }),
        'utf8',
      );

      let valuesArtifact: string | undefined;
      if (input.export === 'csv') {
        const name = `${parsed.fileId}.values.csv`;
        const csvPath = path.join(outDir, name);
        writeFileSync(csvPath, `${csvRows.join('\n')}\n`, 'utf8');
        valuesArtifact = relativeArtifact(runDir, csvPath);
      }

      return {
        status: errorCells.length > 0 || allDiffs.length > 0 ? 'fail' : 'pass',
        errorCells,
        valueDiffs: allDiffs.slice(0, maxValueDiffs),
        artifacts: {
          report: relativeArtifact(runDir, reportPath),
          ...(valuesArtifact === undefined ? {} : { values: valuesArtifact }),
        },
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

function errorResult(error: RecalcErrorCode): RecalcXlsxResult {
  return { status: 'error', error, errorCells: [], valueDiffs: [], artifacts: { report: 'out/.recalc-report.json' } };
}

const TIMEOUT_SENTINEL = Symbol('recalc-timeout');
function isTimeout(error: unknown): boolean {
  return error === TIMEOUT_SENTINEL || (error instanceof Error && error.name === 'RecalcTimeoutError');
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(TIMEOUT_SENTINEL);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ───────────────────────────── 真实 soffice 引擎 ─────────────────────────────

export interface SofficeEngineOptions {
  /** soffice 可执行文件；缺省 'soffice'（PATH 可见才上工具面，Q1①）。 */
  sofficePath?: string;
  /** profile 根目录；缺省系统临时目录（每次 convert 新建独立子目录）。 */
  profileRoot?: string;
}

/** profile 配置：OOXMLRecalcMode=xs:int(0) 强制重算（实测值 1 会沿用缓存）。 */
const RECALC_PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse" oor:type="xs:int"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula"><prop oor:name="OOXMLRecalcMode" oor:op="fuse" oor:type="xs:int"><value>0</value></prop></item>
</oor:items>
`;

/** 杀整组进程（detached spawn 的 pgid = pid）；ESRCH 忽略。 */
export function killSofficeProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已不存在：无事可做。
  }
}

export function createSofficeRecalcEngine(options: SofficeEngineOptions = {}): RecalcEngine {
  const sofficePath = options.sofficePath ?? 'soffice';
  const profileRoot = options.profileRoot ?? path.join(os.tmpdir(), 'fshine-recalc-profiles');

  return {
    probe(): RecalcEngineFacts | null {
      let out: string;
      try {
        out = execFileSync(sofficePath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      } catch {
        return null;
      }
      const match = /LibreOffice\s+(\d+\.\d+\.\d+)/.exec(out);
      return {
        available: match !== null,
        sofficePath,
        version: match?.[1] ?? '',
      };
    },
    async convert({ sourcePath, outDir, signal }): Promise<{ outputPath: string }> {
      const profile = path.join(profileRoot, `profile_${randomUUID().replaceAll('-', '')}`);
      const userDir = path.join(profile, 'user');
      mkdirSync(userDir, { recursive: true });
      writeFileSync(path.join(userDir, 'registrymodifications.xcu'), RECALC_PROFILE_XCU, 'utf8');

      const child = spawn(
        sofficePath,
        [
          '--headless',
          `-env:UserInstallation=file://${profile}`,
          '--norestore',
          '--convert-to',
          'xlsx:Calc MS Excel 2007 XML',
          '--outdir',
          outDir,
          sourcePath,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: workerSubprocessEnv(process.env),
        },
      );
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error('soffice spawn 失败（无 pid）');
      }
      const onAbort = (): void => killSofficeProcessGroup(pid);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      if (signal.aborted) throw new Error('soffice aborted');
      const outputPath = path.join(outDir, path.basename(sourcePath));
      // 输出不存在 = 转换失败（由上层归 engine_failed）。
      statSync(outputPath);
      return { outputPath };
    },
  };
}

// ───────────────────────────── 投递前机械闸（步骤 ③） ─────────────────────────────
//
// 判定（owner 裁定）：待投递项若是含公式的 xlsx，必须有对应 pass 的实算报告（按文件名 +
// sha256 绑定）；报告缺失/fail/不匹配 = 不投递 + 结构化事件说明原因。无公式表格与纯数据
// CSV 行为逐字节不变。挂点在 server.deliverTurnFiles 读字节处（recalc 报告在独立 runDir、
// 可能晚于 run-js out/ 扫描产生，见 decision-log §九十九）；缺省未注入 recalc 执行器 = 不启用。

/** 闸门判定原因（结构化事件 reason；不得改名）。 */
export const RECALC_DELIVERY_GATE_STATUS = {
  PASS: 'pass',
  NO_FORMULAS: 'no_formulas',
  CSV_DATA: 'csv_data',
  NOT_XLSX: 'not_xlsx',
  REPORT_MISSING: 'report_missing',
  REPORT_FAIL: 'report_fail',
  REPORT_MISMATCH: 'report_mismatch',
} as const;
export type RecalcDeliveryGateReason =
  (typeof RECALC_DELIVERY_GATE_STATUS)[keyof typeof RECALC_DELIVERY_GATE_STATUS];

/** 报告绑定（从 .recalc-report.json 投影的机械事实；不含公式明细/内容）。 */
export interface RecalcReportBinding {
  name: string;
  sha256: string;
  status: 'pass' | 'fail';
  file?: string;
}

export interface RecalcDeliveryDecision {
  deliver: boolean;
  reason: RecalcDeliveryGateReason;
}

/** xlsx 是否含公式（exceljs 读 buffer；读不动 = 非 xlsx，按 false 处理不误伤）。 */
export async function xlsxHasFormulas(bytes: Buffer): Promise<boolean> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    let found = false;
    wb.eachSheet((ws) => {
      if (found) return;
      ws.eachRow((row) => {
        if (found) return;
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value;
          if (v && typeof v === 'object' && !Array.isArray(v) && 'formula' in v) found = true;
        });
      });
    });
    return found;
  } catch {
    return false; // 损坏/非 xlsx：不是「含公式表格」，闸门不介入（逐字节不变）
  }
}

function looksLikeXlsx(name: string, bytes: Buffer): boolean {
  // 扩展名 + ZIP 魔数（PK\x03\x04）双判据；避免把 CSV/文本误当 xlsx 读。
  return name.toLowerCase().endsWith('.xlsx') && bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** 从会话 runs 目录收集所有实算报告绑定（坏报告跳过；不递归越界、不读成分）。 */
export function collectRecalcReports(workspaceRoot: string, scope: FileScope): RecalcReportBinding[] {
  const runsDir = path.join(sessionDirOf(workspaceRoot, scope), 'runs');
  if (!existsSync(runsDir)) return [];
  const out: RecalcReportBinding[] = [];
  let runIds: string[];
  try {
    runIds = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const runId of runIds) {
    const reportPath = path.join(runsDir, runId, 'out', '.recalc-report.json');
    if (!existsSync(reportPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
      const name = parsed['name'];
      const digest = parsed['sha256'];
      const status = parsed['status'];
      if (typeof name !== 'string' || typeof digest !== 'string') continue;
      if (status !== 'pass' && status !== 'fail') continue;
      out.push({
        name,
        sha256: digest,
        status,
        ...(typeof parsed['file'] === 'string' ? { file: parsed['file'] } : {}),
      });
    } catch {
      continue; // 坏 JSON：跳过，不影响其它报告
    }
  }
  return out;
}

/**
 * 单个待投递项判定。reports 里须有 name + sha256 双匹配且 status=pass 的报告才放行。
 */
export async function decideRecalcDelivery(input: {
  bytes: Buffer;
  name: string;
  reports: readonly RecalcReportBinding[];
}): Promise<RecalcDeliveryDecision> {
  if (!looksLikeXlsx(input.name, input.bytes)) {
    return { deliver: true, reason: input.name.toLowerCase().endsWith('.csv')
      ? RECALC_DELIVERY_GATE_STATUS.CSV_DATA
      : RECALC_DELIVERY_GATE_STATUS.NOT_XLSX };
  }
  if (!await xlsxHasFormulas(input.bytes)) {
    return { deliver: true, reason: RECALC_DELIVERY_GATE_STATUS.NO_FORMULAS };
  }
  const digest = createHash('sha256').update(input.bytes).digest('hex');
  const matching = input.reports.filter((r) => r.name === input.name && r.sha256 === digest);
  if (matching.length === 0) {
    // 区分「同名但 sha 不同」（mismatch）与「完全没有该文件的报告」（missing）。
    const sameName = input.reports.some((r) => r.name === input.name);
    return {
      deliver: false,
      reason: sameName ? RECALC_DELIVERY_GATE_STATUS.REPORT_MISMATCH : RECALC_DELIVERY_GATE_STATUS.REPORT_MISSING,
    };
  }
  if (!matching.some((r) => r.status === 'pass')) {
    return { deliver: false, reason: RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL };
  }
  return { deliver: true, reason: RECALC_DELIVERY_GATE_STATUS.PASS };
}

/** 对投递清单应用闸门。enabled=false（未注入 recalc 执行器）时逐字节原样返回。 */
export async function applyRecalcDeliveryGate(input: {
  files: ReadonlyArray<{ name: string; bytes: Buffer }>;
  reports: readonly RecalcReportBinding[];
  enabled: boolean;
}): Promise<{
  outgoing: Array<{ name: string; bytes: Buffer }>;
  gated: Array<{ name: string; sha256: string; reason: RecalcDeliveryGateReason }>;
}> {
  if (!input.enabled) {
    return { outgoing: [...input.files], gated: [] };
  }
  const outgoing: Array<{ name: string; bytes: Buffer }> = [];
  const gated: Array<{ name: string; sha256: string; reason: RecalcDeliveryGateReason }> = [];
  for (const file of input.files) {
    const decision = await decideRecalcDelivery({ bytes: file.bytes, name: file.name, reports: input.reports });
    if (decision.deliver) {
      outgoing.push(file); // 同一 Buffer 引用：逐字节不变
    } else {
      gated.push({
        name: file.name,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        reason: decision.reason,
      });
    }
  }
  return { outgoing, gated };
}
