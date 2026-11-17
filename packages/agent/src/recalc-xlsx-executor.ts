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
  rmSync,
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
/** 金额级绝对误差上限：半分（1 分 = 0.01，精确到分即误差 < 0.005）。Codex P2-5。 */
const VALUE_COMPARE_HALF_CENT = 0.005;
/** 浮点尾数噪声相对系数（只补 ULP 级；被半分上限封顶，绝不吞掉分级差异）。Codex P2-5。 */
const VALUE_COMPARE_FLOAT_REL = 1e-9;
/** 错误码集合（契约；不得改名）。 */
export type RecalcErrorCode =
  | 'path_escape' | 'not_found' | 'corrupt' | 'too_large' | 'timeout' | 'engine_failed'
  /** 公式形态无法可靠识别（数组公式等）：不盖 pass 章、不导出，交用户确认（Codex R7）。 */
  | 'unsupported_formula';

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
  /** export=csv 时登记进 fileStore 的 CSV 产物（交付链收口用；与 run_js outputs 同形状）。Codex P2-4。 */
  outputs?: Array<{ fileId: string; name: string; bytes: number }>;
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

/**
 * 单元格的「值」：公式格取计算/缓存 result；错误格保留 {error}。
 *
 * Codex R5-P1：exceljs 4.4.0 对 result=0/false/'' 的公式，读回的 cell.value 会**省略** result，
 * 只有 cell.result 保留。因此必须读 cell.result（cell 是 ExcelJS.Cell，非裸 value）。
 */
function cellValueOf(cell: ExcelJS.Cell): ExcelJS.CellValue {
  const value = cell.value;
  if (value && typeof value === 'object' && !Array.isArray(value)
      && ('formula' in value || 'sharedFormula' in value)) {
    // 先取 cell.result（falsy 也在），再退回 value.result，最后 null。
    const result = (cell as unknown as { result?: ExcelJS.CellValue }).result;
    if (result !== undefined) return result;
    return 'result' in value ? (value as { result?: ExcelJS.CellValue }).result ?? null : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) return value;
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
  // Codex 复审 P2：日期公式（如 DATE(2026,1,1)）读回的是两个不同 Date 对象，按时间戳比。
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    // Codex P2-5：容差取「浮点尾数噪声」与「半分」的较小者——浮点噪声只吸收 ULP 级
    // 重算尾差，但绝对上限锁死在半分，1e8 量级的 0.05 分级差异不再被相对容差吞掉。
    const floatNoise = VALUE_COMPARE_FLOAT_REL * Math.max(1, Math.abs(a), Math.abs(b));
    const tol = Math.min(VALUE_COMPARE_HALF_CENT, floatNoise);
    if (Math.abs(a - b) > tol) return false;
    // Codex R9-P2：即便差值在容差内，若两数分位取整后不同（如 100000000.004 vs .006），
    // 仍是可见的一分钱差异，不能当相等。金额精确到分。
    return Math.round(a * 100) === Math.round(b * 100);
  }
  return false;
}

/** 结构化 cell → 纯文本（Codex 复审 P2：超链接/富文本格 String(value) 会变成 [object Object]）。 */
function cellTextOf(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as unknown as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'] as string;
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as Array<{ text?: string }>).map((run) => run.text ?? '').join('');
    }
    if ('result' in obj) return cellTextOf(obj['result'] as ExcelJS.CellValue);
    if ('error' in obj) return String(obj['error']);
    if ('hyperlink' in obj && typeof obj['hyperlink'] === 'string') return obj['hyperlink'] as string;
  }
  return String(value);
}

/** CSV 单元格转义（逗号/引号/换行包引号，内部引号翻倍）。 */
function csvCell(value: ExcelJS.CellValue, isNumeric = false): string {
  let text = cellTextOf(value);
  // Codex R6-P2：纯数据 CSV 里以 = + - @ 开头的**文本**会在表格软件里被当公式执行。
  // 前置单引号中和（skill 同款口径）；数字类型（含负数）不加，保持数据可用。
  // 表格软件会忽略前导控制字符（\t \n \r 等）再解释公式——先跳过它们再判 = + - @。
  if (!isNumeric && /^[\x00-\x20]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 解压后工作簿数据硬上限（防压缩炸弹在宿主堆里展开成百万格 OOM）。 */
const WORKBOOK_EXPANDED_BYTES_LIMIT = 128 * 1024 * 1024;

/**
 * 从 ZIP central directory 累加未压缩大小，超限即拒（不实际解压，避免宿主 OOM）。
 * Codex R6-P1：3MB 压缩文件可展开成百万格，在 128MB 堆里直接杀掉整个 server。
 */
export function assertWorkbookExpandedSize(bytes: Buffer): void {
  // 不检查开头魔数：合法 ZIP 允许前导字节（Codex R11-P1 —— 前导字节曾绕过大写检查后
  // 仍被 ExcelJS 解压）。全尾部找 EOCD，找不到或结构不合法即 fail-closed 拒绝。
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66 * 1024); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('workbook_zip_invalid'); // 找不到 ZIP 结构：拒，不交给解析器冒 OOM 风险
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  let p = bytes.readUInt32LE(eocd + 16); // central directory 偏移（相对 ZIP 起点）
  // 前导字节 N 让 CD 实际位置 = N + 记录偏移；N = EOCD 实际位置 - CD 记录偏移 - CD 大小。
  const preamble = eocd - p - cdSize;
  if (preamble > 0) p += preamble;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || bytes[p] !== 0x50 || bytes[p + 1] !== 0x4b || bytes[p + 2] !== 0x01) break;
    total += bytes.readUInt32LE(p + 24); // uncompressed size
    if (total > WORKBOOK_EXPANDED_BYTES_LIMIT) throw new Error('workbook_expanded_too_large');
    p += 46 + bytes.readUInt16LE(p + 28) + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
  }
}

async function readWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  assertWorkbookExpandedSize(readFileSync(filePath));
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
        if (statSync(sourcePath).size > maxInputBytes) {
          writeFailReport(runDir, materialized.name, sourcePath, 'too_large', startedAt);
          return errorResult('too_large');
        }
      } catch {
        writeFailReport(runDir, materialized.name, sourcePath, 'not_found', startedAt);
        return errorResult('not_found');
      }

      // 源必须是可读 xlsx（缓存值来源）；读不动 → corrupt（不起引擎）。
      let srcWb: ExcelJS.Workbook;
      try {
        srcWb = await readWorkbook(sourcePath);
      } catch (error) {
        const code = error instanceof Error && error.message === 'workbook_expanded_too_large' ? 'too_large' : 'corrupt';
        writeFailReport(runDir, materialized.name, sourcePath, code, startedAt);
        return errorResult(code);
      }

      // Codex R7-P2：执行器必须与投递门共用「认不出即拒收」的判定——源工作簿含无法可靠
      // 识别的公式形态（数组公式等）时，绝不盖 pass 章，否则投递门虽会挡，report 却自相矛盾。
      const sourceScan = scanWorkbookFormulas(srcWb);
      if ('uncertain' in sourceScan) {
        writeFailReport(runDir, materialized.name, sourcePath, 'unsupported_formula', startedAt);
        return errorResult('unsupported_formula');
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
        const code = isTimeout(error) ? 'timeout' : 'engine_failed';
        writeFailReport(runDir, materialized.name, sourcePath, code, startedAt);
        return errorResult(code);
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
      }

      // 计算后工作簿读回；读不动 → corrupt。
      let outWb: ExcelJS.Workbook;
      try {
        outWb = await readWorkbook(outputPath);
      } catch {
        writeFailReport(runDir, materialized.name, sourcePath, 'corrupt', startedAt);
        return errorResult('corrupt');
      }

      const errorCells: RecalcErrorCell[] = [];
      const allDiffs: RecalcValueDiff[] = [];
      const csvRows: string[] = ['sheet,ref,value'];
      // Codex P1-2：验证范围 = 全本（workbook 级判定，status/report 覆盖所有 sheet）；
      // sheet 参数**只缩 CSV 展示与返回 valueDiffs 呈现**，绝不缩验证范围。
      const allSheets = srcWb.worksheets.map((ws) => ws.name);
      const sheetFilter = input.sheet;
      // Codex 三复审 P2：sheet 指向不存在的表不能静默产出空 CSV 并 pass。
      if (sheetFilter !== undefined && !allSheets.includes(sheetFilter)) {
        writeFailReport(runDir, materialized.name, sourcePath, 'not_found', startedAt);
        return errorResult('not_found');
      }

      for (const sheetName of allSheets) {
        const srcSheet = srcWb.getWorksheet(sheetName);
        const outSheet = outWb.getWorksheet(sheetName);
        if (srcSheet === undefined) continue;
        srcSheet.eachRow((row, rowNumber) => {
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const address = cell.address;
            const cachedCell = cell.value;
            const computedCellObj = outSheet?.getCell(rowNumber, colNumber);
            const computedValue = computedCellObj === undefined ? null : cellValueOf(computedCellObj);
            const err = errorCodeOf(computedValue);
            if (err !== null) {
              errorCells.push({ sheet: sheetName, ref: address, code: err });
            }
            // Codex P1-3：ExcelJS 共享公式从属格是 {sharedFormula,result}（无 formula 属性），
            // 必须与 anchor 的 {formula,result} 一并按公式格比对，否则 follower 陈旧值漏检。
            const isFormula = !!cachedCell && typeof cachedCell === 'object' && !Array.isArray(cachedCell)
              && ('formula' in cachedCell || 'sharedFormula' in cachedCell);
            if (isFormula) {
              const cachedValue = cellValueOf(cell);
              if (!valuesEqual(cachedValue, computedValue)) {
                allDiffs.push({ sheet: sheetName, ref: address, cached: cachedValue, computed: computedValue });
              }
            }
            // sheet 只收窄 CSV 展示（P1-2）：验证已对全本完成，这里仅决定导出哪些行。
            if (input.export === 'csv' && computedValue !== null
              && (sheetFilter === undefined || sheetName === sheetFilter)) {
              csvRows.push(`${csvCell(sheetName)},${csvCell(address)},${csvCell(computedValue, typeof computedValue === 'number' || computedValue instanceof Date)}`);
            }
          });
        });
      }

      // 报告：全量机械事实落盘（进上下文的 valueDiffs 才封顶）。
      // 投递闸绑定字段（步骤 ③）：name = 输入文件用户可见名、sha256 = 源字节哈希——
      // 投递面据此确认「这份报告是对那个待投递文件做的实算」（不匹配 = 不投递）。
      const reportStatus = errorCells.length > 0 || allDiffs.length > 0 ? 'fail' : 'pass';
      // Codex P1-1：报告写 **runDir 根**（宿主独占），不写 out/——run_js 子进程只有 out/ 与
      // scratch/ 的写权限（run-js-executor.ts --allow-fs-write），无法伪造根报告；投递闸只认根报告。
      const reportPath = path.join(runDir, '.recalc-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify({
          status: reportStatus,
          createdAt: startedAt,
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
      let registeredOutputs: Array<{ fileId: string; name: string; bytes: number }> | undefined;
      if (input.export === 'csv') {
        const name = `${parsed.fileId}.values.csv`;
        const csvPath = path.join(outDir, name);
        const csvBytes = Buffer.from(`${csvRows.join('\n')}\n`, 'utf8');
        writeFileSync(csvPath, csvBytes);
        valuesArtifact = relativeArtifact(runDir, csvPath);
        // Codex R7-P2：含错误格/差异的 fail 工作簿仍写出 CSV 供排查（报告可见），
        // 但**不登记为可交付产物**——否则含 #DIV/0! 的 CSV 会被无条件投递。
        if (reportStatus === 'pass') {
          const registered = options.fileStore.putFile({
            scope, name, bytes: csvBytes, activatedAt: Date.now(),
          });
          registeredOutputs = [{ fileId: registered.fileId, name: registered.name, bytes: registered.bytes }];
        }
      }

      // 进上下文的 valueDiffs 按 sheet 收窄呈现（P1-2），但 report 上方已保留全量。
      const visibleDiffs = sheetFilter === undefined
        ? allDiffs
        : allDiffs.filter((d) => d.sheet === sheetFilter);
      return {
        status: errorCells.length > 0 || allDiffs.length > 0 ? 'fail' : 'pass',
        errorCells,
        valueDiffs: visibleDiffs.slice(0, maxValueDiffs),
        artifacts: {
          report: relativeArtifact(runDir, reportPath),
          ...(valuesArtifact === undefined ? {} : { values: valuesArtifact }),
        },
        ...(registeredOutputs === undefined ? {} : { outputs: registeredOutputs }),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * recalc 失败时也落一份 fail 报告（宿主独占 runDir 根），让投递门能拦住「已排队但重算失败」的
 * 工作簿（Codex R9-P1）：失败不留报告 → 门按 no_report 放行 → 已算坏的表被投递。
 */
function writeFailReport(runDir: string, name: string, sourcePath: string, error: RecalcErrorCode, createdAt: number): void {
  try {
    writeFileSync(
      path.join(runDir, '.recalc-report.json'),
      JSON.stringify({
        status: 'fail',
        name,
        sha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
        error,
        createdAt,
        counts: { errorCells: 0, valueDiffs: 0 },
      }),
      'utf8',
    );
  } catch {
    // 报告写失败不改变 error 结果本身；门可能因无报告放行，但该输入本就未产出可信新值。
  }
}

function errorResult(error: RecalcErrorCode): RecalcXlsxResult {
  return { status: 'error', error, errorCells: [], valueDiffs: [], artifacts: { report: '.recalc-report.json' } };
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
  /** spawn 接缝：仅测试注入假子进程验证 error/abort 边界；生产缺省为 node child_process.spawn。 */
  spawnProcess?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => SofficeChild;
}

/** convert 用到的 child 最小面（测试可注入假实现）。 */
export interface SofficeChild {
  readonly pid?: number;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
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
  const spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts) as unknown as SofficeChild);

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
      // Codex 复审 P2：已在读源工作簿阶段 abort 的信号不能靠 addEventListener 重放——spawn 前先查。
      if (signal.aborted) throw new Error('soffice aborted before spawn');
      const profile = path.join(profileRoot, `profile_${randomUUID().replaceAll('-', '')}`);
      try {
        const userDir = path.join(profile, 'user');
        mkdirSync(userDir, { recursive: true });
        writeFileSync(path.join(userDir, 'registrymodifications.xcu'), RECALC_PROFILE_XCU, 'utf8');

        const child = spawnProcess(
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
        // Codex 复审 P2：error handler 必须在任何可能抛错的检查之前装好——否则 spawn 失败时
        // Node 发出未处理的 'error' 事件会直接终止整个 server（即便上层 catch 了 convert 的 rejection）。
        const processOutcome = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
        // 兜底：pid 失败分支直接 throw 时不会再 await processOutcome；给已挂的 promise 一个
        // no-op rejection handler，避免随后到达的 child 'error' 变成 unhandled rejection 杀掉 Node。
        void processOutcome.catch(() => undefined);
        const pid = child.pid;
        if (pid === undefined) {
          throw new Error('soffice spawn 失败（无 pid）');
        }
        const onAbort = (): void => killSofficeProcessGroup(pid);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort(); // 竞态：addEventListener 之后又 abort 了一次
        try {
          await processOutcome;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
        if (signal.aborted) throw new Error('soffice aborted');
        const outputPath = path.join(outDir, path.basename(sourcePath));
        // 输出不存在 = 转换失败（由上层归 engine_failed）。
        statSync(outputPath);
        return { outputPath };
      } finally {
        // Codex 三复审 P2：每次转换的独立 profile 在任意结束路径上清理，避免 /tmp 无界累积。
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
      }
    },
  };
}

// ───────────────────────────── 投递前机械闸（步骤 ③） ─────────────────────────────
//
// 判定（owner 裁定）：待投递项若是含公式的 xlsx，必须有对应 pass 的实算报告（按文件名 +
// sha256 绑定）；报告缺失/fail/不匹配 = 不投递 + 结构化事件说明原因。无公式表格与纯数据
// CSV 行为逐字节不变。挂点在 server.deliverTurnFiles 读字节处（recalc 报告在独立 runDir、
// 可能晚于 run-js out/ 扫描产生，见 decision-log §九十九）；缺省未注入 recalc 执行器 = 不启用。

/**
 * 闸门判定原因（结构化事件 reason）。
 * 报告驱动后只有三种结果：pass 放行 / fail 拦截 / 无报告（执行层数据）放行。
 */
export const RECALC_DELIVERY_GATE_STATUS = {
  PASS: 'pass',
  REPORT_FAIL: 'report_fail',
  NO_REPORT: 'no_report',
} as const;
export type RecalcDeliveryGateReason =
  (typeof RECALC_DELIVERY_GATE_STATUS)[keyof typeof RECALC_DELIVERY_GATE_STATUS];

/** 报告绑定（从 .recalc-report.json 投影的机械事实；不含公式明细/内容）。 */
export interface RecalcReportBinding {
  name: string;
  sha256: string;
  status: 'pass' | 'fail';
  file?: string;
  /** 报告写出时刻（ms）；同 sha 多份报告时只认最新一份，防旧 pass 覆盖新 fail。 */
  createdAt?: number;
}

export interface RecalcDeliveryDecision {
  deliver: boolean;
  reason: RecalcDeliveryGateReason;
}

/**
 * 工作簿公式形态识别 —— **仅执行器内部使用**（recalc 时判断源表有没有它无法可靠处理的形态）。
 *
 * 投递门不调用本函数：门按「来源 + 可信报告」判定（owner 职责边界裁定），不打开任意 xlsx
 * 去猜内容。认不出就返回 uncertain，执行器据此拒绝盖章（unsupported_formula）。
 */
export type FormulaScan = { hasFormulas: boolean } | { uncertain: true };

/** 调用方已 load 好 workbook 时用（执行器侧复用）。 */
export function scanWorkbookFormulas(wb: ExcelJS.Workbook): FormulaScan {
  let found = false;
  let uncertain = false;
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (uncertain) return;
        const v = cell.value;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const obj = v as unknown as Record<string, unknown>;
          // 数组公式锚点带 ref 且 **不是** 合法共享公式（sharedFormula 的 shareType='shared'）→
          // follower 被 exceljs 读成普通值、无法可靠识别 → 认不准，拒绝（Codex R5/R6）。
          // 必须在「认公式」之前判，否则 early return 会让这条不可达。
          const isSharedAnchor = obj['shareType'] === 'shared';
          if ('formula' in obj && 'ref' in obj && !isSharedAnchor) { uncertain = true; return; }
          if ('formula' in obj || 'sharedFormula' in obj) { found = true; return; }
          // {result:...} 单独出现（数组公式 follower 的典型形态）→ 认不准，拒绝。
          if ('result' in obj && !('text' in obj) && !('richText' in obj)) uncertain = true;
          return;
        }
        // 字符串化的 JSON 对象（exceljs 对某些 array follower 的读回形态）→ 拒绝。
        if (typeof v === 'string' && /^\s*\{.*\}\s*$/.test(v) && v.includes('result')) uncertain = true;
      });
    });
  });
  if (uncertain) return { uncertain: true };
  return { hasFormulas: found };
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
    // Codex P1-1：只读 runDir **根**的 .recalc-report.json（宿主独占位置）；
    // run_js 子进程仅能写 out/ 与 scratch/，故 out/.recalc-report.json 一律不认。
    const reportPath = path.join(runsDir, runId, '.recalc-report.json');
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
        ...(typeof parsed['createdAt'] === 'number' ? { createdAt: parsed['createdAt'] } : {}),
      });
    } catch {
      continue; // 坏 JSON：跳过，不影响其它报告
    }
  }
  return out;
}

/**
 * 投递判定（完全报告驱动，不解析文件内容）。
 *
 * owner 职责边界：执行层交付无公式数据、公式工程只归 Main 的 recalc_xlsx。
 * 因此这里只问一个问题：**这份文件有没有本流程可信的实算报告？**
 *   · 有报告（name + sha256 双匹配）→ 按 pass / fail 决定投递；
 *   · 无报告 → 放行（执行层交付的无公式数据，按边界信任）。
 *
 * 绝不打开 xlsx 去猜「它含不含公式」——那是打地鼠根源，且把一个生产者自检工具误用成了
 * 任意外部文件的安全门。Builder 自检由执行器内部的 scanWorkbookFormulas 负责，不在此处。
 */
export function decideRecalcDelivery(input: {
  bytes: Buffer;
  name: string;
  reports: readonly RecalcReportBinding[];
}): RecalcDeliveryDecision {
  const digest = createHash('sha256').update(input.bytes).digest('hex');
  const matching = input.reports.filter((r) => r.name === input.name && r.sha256 === digest);
  if (matching.length === 0) {
    // 无报告 = 执行层交付的数据文件（边界内信任），照常投递。
    return { deliver: true, reason: RECALC_DELIVERY_GATE_STATUS.NO_REPORT };
  }
  // 同 sha 多份报告（重算多次）：只认最新一份，防旧 pass 覆盖新 fail（Codex R9-P2）。
  const latest = matching.reduce((a, b) => (a.createdAt ?? 0) >= (b.createdAt ?? 0) ? a : b);
  if (latest.status !== 'pass') {
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
    const decision = decideRecalcDelivery({ bytes: file.bytes, name: file.name, reports: input.reports });
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
