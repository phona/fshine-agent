/**
 * CAP-01 R2 功能验收（可重复执行，不靠人工点）。
 *
 * 口径（CAP-01 设计 v8 §7/§8 S2/S3，文档 2026-11-18 删除、git 历史可考 + R2 验收指令）：
 * 只验用户可见结果与安全不变量；全样本保留，不筛绿；失败样本连证据一起落盘。
 *
 * 场景（假渠道 = 直调 server.handler；执行层 = 仓内 dummy 面；装配 = apps/server/server.ts
 * 生产装配缺省链——fileStore/run_js 执行器/清单注入/主动投递 B 全部同源）：
 *
 *   S1 已退役（2026-11-19）：原「Main 直做」场景——Main 的 run_js 直接写 out/、
 *      由宿主登记并投递。产品边界已改为「交付物只从 Worker 出」：Main 的 run_js 只能写
 *      scratch/（run-js-executor.ts 的 RunJsWritableDirs、execution-runtime.ts 的
 *      runJsInTurn），该场景的前提（Main 直接产出交付物）已不存在。等价覆盖由 S3 承接：
 *      Main task_run → Worker run_js → 产物回 Main、逐格一致、file_refs 登记行、行数据
 *      不进 Main。退役登记见 docs/decisions/debt.md。
 *
 *   S2 投递失败：同数据经 task_run.inputFiles 交给 Worker（Worker run_js 产出汇总），
 *      投递端口换成必抛实现（live 模式，带空 receipt 部分回执形状）。产物由后台完成面
 *      投递（taskRunWaitMs=0 强制走完成回调，产品同款路径）；断言：
 *        ① 用户话术含「未送达」（同步回执 + 后台完成投递的主动文字，同一用户可见面）；
 *        ② 结构化事件 file_delivery 的 status != sent（= delivery_failed）；
 *        ③ 全部日志里没有任何 sent 记录（file_delivery 与 message_done.fileDelivery 两处）。
 *      前提检查：回合确实产出了文件（端口收到字节）；没产出 = 该路径未触发 = 判 FAIL 并写明。
 *
 *   S3 Worker 链路：同数据经 task_run.inputFiles 交给 Worker。断言：
 *        ① Main 确实交办且带了 inputFiles（工具参数里有入站 fileId）；
 *        ② 产物回 Main：主动投递端口收到产物；按 sha256 对回 file_refs 行——该行是新
 *          fileId（≠ 入站 fileId、≠ 交办副本 fileId）、task_id 绑定（Worker 产物面）；
 *        ③ 产物内容与预期逐格一致（同一 Oracle 重解析）；
 *        ④ 行数据不出现在 **Main** 的工具参数与转录里（2026-11-17 口径收窄：设计约束是
 *          行数据不进 Main 上下文；Worker 经 run_js 读行数据是设计行为，不计入红）——
 *          对 24 个销售额原值逐个做「词边界」grep：覆盖 Main 全部工具调用参数与结果、
 *          Main 驱动回合输入（含清单注入/委派文本）与输出转录。Worker 面的命中数写进
 *          detail 作信息（「worker 面命中 N 处，按设计不计入」），供人看、不判红。金额是
 *          6 位数字，为排除 fileId/runId/时间戳等机械十六进制或连续数字的子串误报，grep
 *          带 alnum 边界（前后不得是字母数字）——真实泄漏（自然文本/JSON 值/代码字面量）
 *          一定带边界，ID 碰撞一定不带。Main 面覆盖下限 >= 4 保留（空扫描不许假绿）。
 *
 * 模型口径：产品侧（Main/Worker Pi 驱动）用真实模型 step-3.7-flash（与历史批次同源：
 * config/agent.fixture.yaml + .env 的 LLM_*；记录 env 请求名与转录 assistant.model 实际名）。
 * calls 计法与 convergence-r1 同源：转录 assistant 消息条数（下界，见 runner.ts:451）。
 * 无 LLM_API_KEY 或显式 --scripted 时降级脚本化驱动（同一段断言原样跑），报告写 model=scripted。
 * 真实回合中途失败一律如实记 FAIL，不静默降级、不重试换样本。
 *
 * 委派任务行的机械事实说明：inline 委派里 Worker 汇报但零执行时，汇报不覆盖执行事实
 * （`unexecuted` 这个结论词已删，底账只留汇报与执行行）——R2 把「存在任务行」本身当断言
 * 对象（S3 必须交办），不判其成败。
 *
 * 运行：
 *   node --env-file=<含 LLM_API_KEY 的 env> --import tsx scripts/eval/cap01/r2-functional.ts \
 *     [--scripted] [--scenario s2,s3] [--out-dir <dir>]
 * 缺省 out-dir = .runtime/eval-cap01-r2/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 场景全过；1 = 任一 FAIL。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import ExcelJS from 'exceljs';
import { effectiveDeploymentEnv, loadConfig, openTaskStore } from '@fshine/core';
import type {
  AppConfig,
  ChannelReply,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { DriverMessage, TurnDriver } from '../../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { contextWindowFrom, compactionSettingsFrom } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createServer, type FileDeliveryPort } from '../../../apps/server/server';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskStartedOf, taskUnstartedOf, taskWaitingOf } from '../../../packages/agent/testing/task-facts';
import { rowDataLeakDetail, scanRowDataLeakage } from './row-data-scan';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

// ── 夹具：24 行明细（12 个月 × 各 2 行），销售额用 6 位互异整数 ────────────────
// 6 位且互异：合计是逐格 Oracle 的预期；原值同时是 S3 的泄漏 grep 目标（见文件头 ④）。
const RAW_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['1月', 214073], ['1月', 158262],
  ['2月', 186349], ['2月', 141827],
  ['3月', 229518], ['3月', 173462],
  ['4月', 198271], ['4月', 154396],
  ['5月', 236514], ['5月', 182743],
  ['6月', 213859], ['6月', 167328],
  ['7月', 187462], ['7月', 129384],
  ['8月', 201573], ['8月', 148629],
  ['9月', 228496], ['9月', 174938],
  ['10月', 243817], ['10月', 193526],
  ['11月', 219734], ['11月', 165482],
  ['12月', 252918], ['12月', 204361],
];
/** 泄漏 grep 目标：24 个销售额原值（十进制字符串；无前导零）。 */
const RAW_VALUE_STRINGS: readonly string[] = [...new Set(RAW_ROWS.map(([, value]) => String(value)))];
/** 逐格 Oracle：表头 + 12 行月份合计（保持夹具首次出现序 = 1月→12月）。 */
const EXPECTED_GRID: readonly string[][] = [
  ['月份', '销售额'],
  ...(() => {
    const months: string[] = [];
    const sums = new Map<string, number>();
    for (const [month, value] of RAW_ROWS) {
      if (!sums.has(month)) {
        sums.set(month, 0);
        months.push(month);
      }
      sums.set(month, (sums.get(month) ?? 0) + value);
    }
    return months.map((month) => [month, String(sums.get(month) ?? 0)]);
  })(),
];

async function buildFixtureXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('明细');
  sheet.addRow(['月份', '销售额']);
  for (const [month, value] of RAW_ROWS) sheet.addRow([month, value]);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ── exceljs Oracle：重开收到的产物，逐格比对 ─────────────────────────────────

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
    if (!Number.isFinite(value)) return `<non-finite>`;
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value).trim();
}

/** 首工作表 → 稀疏行号映射（保留空行号信息，逐格比对按行号对齐，不压缩空行）。 */
async function gridOfXlsx(bytes: Buffer): Promise<{ grid: Map<number, string[]>; columnCount: number; sheetCount: number }> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 的 load 参数是它自带的 Buffer 接口（与 Node 24 的泛型 Buffer 形不一致，仅形状转换）。
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

/** 逐格一致：行号集合一致、每格文本一致（额外行列/合计行/空工作表都算不一致）。 */
function compareGrids(actual: { grid: Map<number, string[]>; columnCount: number; sheetCount: number }, expected: readonly string[][]): GridDiff {
  const problems: string[] = [];
  if (actual.sheetCount !== 1) {
    problems.push(`工作表数 ${actual.sheetCount} ≠ 1`);
  }
  if (actual.columnCount !== expected[0]!.length) {
    problems.push(`列数 ${actual.columnCount} ≠ 预期 ${expected[0]!.length}`);
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

// ── 记录包装器（与 convergence-r1 runner 的 recordingDriver 同形；透传不改语义） ──

interface ToolCallRecord {
  agent: 'main' | 'worker';
  seq: number;
  tool: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  resultSummary?: string;
}

interface DriverRunRecord {
  agent: 'main' | 'worker';
  systemPrompt: string;
  toolNames: readonly string[];
  messages: readonly DriverMessage[];
  injections: readonly string[];
  resultText: string;
  resultMessages: readonly DriverMessage[];
}

interface ScenarioSink {
  calls: ToolCallRecord[];
  runs: DriverRunRecord[];
}

function safeClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value)) as unknown;
  } catch {
    return `<unserializable:${String(value).slice(0, 200)}>`;
  }
}

function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: ScenarioSink): TurnDriver {
  return {
    async run(input) {
      const runRecord: DriverRunRecord = {
        agent,
        systemPrompt: input.systemPrompt,
        toolNames: input.tools.map((tool) => tool.name),
        messages: safeClone(input.messages) as readonly DriverMessage[],
        injections: [...(input.injections ?? [])],
        resultText: '',
        resultMessages: [],
      };
      sink.runs.push(runRecord);
      let seq = 0;
      const result = await inner.run({
        ...input,
        exec: async (tool, args, signal) => {
          seq += 1;
          try {
            const value = await input.exec(tool, args, signal);
            sink.calls.push({
              agent,
              seq,
              tool,
              args: safeClone(args),
              result: safeClone(value),
              resultSummary: typeof value === 'string' ? value.slice(0, 300) : undefined,
            });
            return value;
          } catch (error) {
            sink.calls.push({
              agent,
              seq,
              tool,
              args: safeClone(args),
              isError: true,
              resultSummary: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
      runRecord.resultText = result.text;
      runRecord.resultMessages = safeClone(result.messages) as readonly DriverMessage[];
      return result;
    },
    ...(inner.synthesizeAssistant !== undefined ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
}

// ── 交付端口（live 捕获 / live 必抛） ────────────────────────────────────────

interface DeliveredFile {
  filename: string;
  bytes: number;
  sha256: string;
  data: Buffer;
}

interface PortCapture {
  deliveryMode: 'live' | 'silent';
  calls: Array<{ route: ChannelRoute; files: DeliveredFile[] }>;
  /** sendText 面（后台任务完成/失败话术等主动文字投递；与文件投递同一用户可见面）。 */
  texts: Array<{ route: ChannelRoute; text: string }>;
}

function capturePort(): PortCapture & FileDeliveryPort {
  const capture: PortCapture = { deliveryMode: 'live', calls: [], texts: [] };
  return {
    ...capture,
    deliveryMode: 'live',
    async sendToConversation(route, files: readonly OutgoingFileReply[]): Promise<DeliveryReceipt> {
      const delivered: DeliveredFile[] = files.map((file) => ({
        filename: file.filename,
        bytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        data: file.data,
      }));
      capture.calls.push({ route, files: delivered });
      return {
        route,
        parts: delivered.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })),
      };
    },
  };
}

function throwingPort(): PortCapture & FileDeliveryPort {
  const capture: PortCapture = { deliveryMode: 'live', calls: [], texts: [] };
  return {
    ...capture,
    deliveryMode: 'live',
    async sendToConversation(route, files: readonly OutgoingFileReply[]): Promise<DeliveryReceipt> {
      const delivered: DeliveredFile[] = files.map((file) => ({
        filename: file.filename,
        bytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        data: file.data,
      }));
      capture.calls.push({ route, files: delivered });
      // 必抛实现（R2 S2）：带 receipt 部分回执形状（模拟「先到部分 ACK 再失败」的真实形状）。
      const error = new Error('企微主动交付失败（file[0] upload）: R2 验收注入的必抛投递') as Error & { receipt?: DeliveryReceipt };
      error.receipt = { route, parts: [] };
      throw error;
    },
    // 文件投递失败话术由后台完成投递面用 sendText 送达（产品 server-cap01-delivery 同款路径）：
    // 这里捕获用户可见文字，让「用户看到未送达」的断言落在真实的用户可见面。
    async sendText(route, text: string): Promise<DeliveryReceipt> {
      capture.texts.push({ route, text });
      return { route, parts: [{ kind: 'text' as const, index: 0, status: 'sent' as const }] };
    },
  };
}

// ── 场景夹具：server 生产装配（缺省执行器/文件区/清单注入/投递 B） ────────────

interface ScenarioPaths {
  dir: string;
  dbPath: string;
  attachmentPath: string;
}

interface ScenarioHarness {
  paths: ScenarioPaths;
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  sink: ScenarioSink;
  port: PortCapture & FileDeliveryPort;
  modelObserved: () => string | undefined;
}

const PRINCIPAL_ID = 'wecom:fixture-user';
const CONVERSATION_ID = 'conv-cap01-r2';

async function makeHarness(options: {
  port: PortCapture & FileDeliveryPort;
  scripted: boolean;
  label: string;
  /** 覆盖 runtime.taskRunWaitMs（缺省产品值 1500ms）。 */
  taskRunWaitMs?: number;
}): Promise<ScenarioHarness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cap01-r2-${options.label}-`));
  const dbPath = path.join(dir, 'state.db');
  // 配置：仓内 dummy 面同源物化（与 ask/eval 同一份 fixture 配置），dbPath 指入本场景。
  const configCopy = path.join(dir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(configDoc));
  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  // runtime.taskRunWaitMs 由策略层解析（YAML 的 runtime 段白名单不含它）：装配后直接注入，
  // 与产品测试（server-cap01-delivery.test.ts 的 testConfig）同一构造口径。
  if (options.taskRunWaitMs !== undefined) {
    config.runtime = { ...(config.runtime ?? {}), taskRunWaitMs: options.taskRunWaitMs };
  }
  const env = effectiveDeploymentEnv(config, process.env);

  const sink: ScenarioSink = { calls: [], runs: [] };
  const scripted = options.scripted;
  const createDrivers = scripted
    ? (): { mainDriver: TurnDriver; workerDriver: TurnDriver } => ({
        mainDriver: recordingDriver(scriptedMainDriver(), 'main', sink),
        workerDriver: recordingDriver(scriptedWorkerDriver(), 'worker', sink),
      })
    : (driverEnv: NodeJS.ProcessEnv): { mainDriver: TurnDriver; workerDriver: TurnDriver } => {
        // 与 server 缺省装配同一构造（ask-runtime.ts 的缺省分支），只多一层记录包装。
        const make = (agent: 'main' | 'worker', reuseConversation: boolean): TurnDriver =>
          recordingDriver(
            createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv), ...compactionSettingsFrom(driverEnv), ...(reuseConversation ? { reuseConversation: true } : {}) }),
            agent,
            sink,
          );
        return { mainDriver: make('main', true), workerDriver: make('worker', false) };
      };

  const logs: Array<Record<string, unknown>> = [];
  const server = await createServer({
    env,
    config,
    dbPath,
    stateDir: path.join(dir, 'state'),
    createDrivers,
    fileDelivery: options.port,
    logger: (line) => logs.push(line),
  });
  return {
    paths: { dir, dbPath, attachmentPath: path.join(dir, 'attachments', '月度销售明细.xlsx') },
    server,
    logs,
    sink,
    port: options.port,
    modelObserved: () => observedModelOf(sink.runs),
  };
}

/** 实际模型名（转录 assistant.model.id；与历史批次 evidence 的 assistant.usage 同源面）。 */
function observedModelOf(runs: readonly DriverRunRecord[]): string | undefined {
  for (const run of [...runs].reverse()) {
    for (const message of [...run.resultMessages].reverse()) {
      const model = (message as { model?: { id?: unknown } }).model;
      if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '') {
        return model.id;
      }
    }
  }
  return undefined;
}

function assistantCount(messages: readonly DriverMessage[]): number {
  return messages.filter((message) => (message as { role?: unknown }).role === 'assistant').length;
}

// ── 脚本化驱动（仅 model=scripted 降级用；同一段断言原样跑） ──────────────────

/** run_js 聚合脚本（cwd = run 目录；读 in/ 单个 xlsx → 按月合计写 out/汇总.xlsx）。 */
const AGGREGATE_RUN_JS_CODE = `
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
(async () => {
  const entries = fs.readdirSync('in');
  const input = entries.find((name) => name.endsWith('.xlsx'));
  if (input === undefined) { console.error('in/ 没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join('in', input));
  const ws = wb.worksheets[0];
  const months = [];
  const sums = new Map();
  for (let r = 2; r <= ws.rowCount; r++) {
    const month = ws.getCell(r, 1).value;
    const amount = Number(ws.getCell(r, 2).value);
    if (month === null || month === undefined) continue;
    const key = String(month).trim();
    if (!sums.has(key)) { sums.set(key, 0); months.push(key); }
    sums.set(key, sums.get(key) + amount);
  }
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['月份', '销售额']);
  for (const m of months) sheet.addRow([m, sums.get(m)]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile('out/汇总.xlsx');
})().catch((error) => { console.error(error); process.exit(1); });
`.trim();

function fileIdFromInjections(injections: readonly string[]): string | undefined {
  for (const text of injections) {
    const match = /fileId:\s*(file_[0-9a-f]{32})/.exec(text);
    if (match !== null) return match[1];
  }
  return undefined;
}

function scriptedAssistant(text: string): DriverMessage {
  return {
    role: 'assistant',
    content: text,
    api: 'openai-completions',
    provider: 'scripted',
    model: { id: 'scripted', name: 'scripted', api: 'openai-completions', provider: 'scripted', baseUrl: '', input: [], cost: {} },
    usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
    stopReason: 'stop',
  } as unknown as DriverMessage;
}

function scriptedMainDriver(): TurnDriver {
  return {
    async run(input) {
      const fileId = fileIdFromInjections(input.injections ?? []);
      await input.exec('task_run', {
        task: '把附件里每个月的销售额合计成每月一行，生成汇总 Excel。',
        ...(fileId === undefined ? {} : { inputFiles: [fileId] }),
      });
      return { text: '执行层已完成汇总，见附件。', messages: [scriptedAssistant('执行层已完成汇总，见附件。')] };
    },
  };
}

function scriptedWorkerDriver(): TurnDriver {
  return {
    async run(input) {
      const fileId = fileIdFromInjections(input.messages.map((message) => messageText(message)));
      await input.exec('run_js', { code: AGGREGATE_RUN_JS_CODE, ...(fileId === undefined ? {} : { inputs: [fileId] }) });
      return { text: '已按月合计并生成汇总文件。', messages: [scriptedAssistant('已按月合计并生成汇总文件。')] };
    },
  };
}

function messageText(message: DriverMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('\n');
  return JSON.stringify(content ?? '');
}

// ── 断言收集 ────────────────────────────────────────────────────────────────

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

function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

function incomingMessage(messageId: string, text: string, attachment: IncomingAttachment): IncomingChannelMessage {
  return {
    wecomUserId: 'fixture-user',
    channel: 'wecom',
    conversationId: CONVERSATION_ID,
    messageId,
    chatType: 'single',
    text,
    attachments: [attachment],
    receivedAt: new Date().toISOString(),
  };
}

function deliveredFiles(port: PortCapture): DeliveredFile[] {
  return port.calls.flatMap((call) => call.files);
}

/** 轮询等待（异步后台投递事实；超时即按现状采样，不重试换样本）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** handler 回执的用户可见正文（string 直用；RichChannelReply 取 text）。 */
function textOf(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : reply.text ?? '';
}

// ── 场景夹具与断言 ──────────────────────────────────────────────────────────

const S2_INSTRUCTION =
  '刚发的表在附件里，麻烦汇总一下：把每个月的销售额合计成每月一行，生成 Excel 发我，'
  + '表头用「月份、销售额」，一共 12 行，按 1月 到 12月 排，不要加别的行列。';
const S3_INSTRUCTION =
  '附件这张表请走执行层处理：把每个月的销售额合计成每月一行，汇总成 Excel 发我，'
  + '表头用「月份、销售额」，一共 12 行，按 1月 到 12月 排，不要加别的行列。';

interface ScenarioOutcome {
  scenario: 's2' | 's3';
  status: 'pass' | 'fail';
  checks: Check[];
  notes: string[];
  calls: number;
  error?: string;
  evidence: Record<string, unknown>;
}

async function runScenarioS2(scripted: boolean): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const notes: string[] = [];
  const port = throwingPort();
  // 交付物只从 Worker 出：Worker 产物经后台完成面投递（而不是 Main 回合内投递）。
  // taskRunWaitMs=0 让 task_run 受理即返回、完成投递走后台完成回调——这是产品
  // server-cap01-delivery.test.ts ①（投递失败 → 用户看到未送达）钉住的同一路径；
  // 缺省 1500ms 的短等待窗口会把快活任务「同回合交给模型」，产物投递失败的话术
  // 只能随后台完成面送出，无法进 handler 的同步回执。
  const harness = await makeHarness({ port, scripted, label: 's2', taskRunWaitMs: 0 });
  let reply: ChannelReply = '';
  let handlerError: string | undefined;
  try {
    const fixture = await buildFixtureXlsx();
    const attachment = stagedAttachment(harness.paths.dir, '月度销售明细.xlsx', fixture);
    try {
      reply = await harness.server.handler(incomingMessage('r2-s2-1', S2_INSTRUCTION, attachment));
    } catch (error) {
      handlerError = error instanceof Error ? error.message : String(error);
    }
    // 后台完成投递是异步的：等投递端口/文字面出现事实再判（最多 5s，失败样本不重试）。
    await waitFor(() => port.calls.length >= 1 || port.texts.length >= 1, 5_000);
  } finally {
    await harness.server.close();
  }

  // 前提：回合确实产出了文件（必抛端口先收到字节才谈得上投递失败）。
  const attempted = deliveredFiles(port);
  checks.check('s2-premise-file-produced', handlerError === undefined && attempted.length >= 1, handlerError !== undefined ? `回合失败：${handlerError}` : `必抛端口收到 ${attempted.length} 个待投文件（${attempted.map((file) => `${file.filename}:${file.bytes}B`).join('、')}）——没产出文件 = 投递失败路径未触发`);

  // ① 用户话术含「未送达」——用户可见面 = 同步回执 + 后台完成投递的主动文字。
  const userVisibleText = [textOf(reply), ...port.texts.map((entry) => entry.text)].join('\n');
  checks.check(
    's2-user-sees-not-delivered',
    userVisibleText.includes('未送达'),
    `回复=${JSON.stringify(reply)}；主动文字=${JSON.stringify(port.texts.map((entry) => entry.text))}`,
  );

  // ② 结构化事件 status != sent（live 必抛 → delivery_failed）。
  const deliveryEvents = harness.logs.filter((line) => line['event'] === 'file_delivery') as Array<Record<string, unknown>>;
  const failedEvent = deliveryEvents.find((line) => line['status'] === 'delivery_failed');
  checks.check('s2-structured-event-not-sent', deliveryEvents.length >= 1 && failedEvent !== undefined, `file_delivery 事件=${JSON.stringify(deliveryEvents)}`);

  // ③ 全链没有 sent 记录（file_delivery 事件与 message_done.fileDelivery 两处）。
  const sentEvents = deliveryEvents.filter((line) => line['status'] === 'sent');
  const doneLog = harness.logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
  const deliveryFact = (doneLog?.['fileDelivery'] ?? undefined) as { status?: unknown } | undefined;
  const sentInDone = deliveryFact?.['status'] === 'sent';
  checks.check('s2-no-sent-record', sentEvents.length === 0 && !sentInDone, `file_delivery sent 记录=${sentEvents.length}；message_done.fileDelivery=${JSON.stringify(deliveryFact)}`);

  const calls = harness.sink.runs.reduce((sum, run) => sum + assistantCount(run.resultMessages), 0);
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);

  return {
    scenario: 's2',
    status: checks.allPassed ? 'pass' : 'fail',
    checks: checks.list,
    notes,
    calls,
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      attemptedFiles: attempted.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      deliveredTexts: port.texts.map((entry) => entry.text),
    },
  };
}

async function runScenarioS3(scripted: boolean): Promise<ScenarioOutcome> {
  const checks = new Checks();
  const notes: string[] = [];
  const port = capturePort();
  const harness = await makeHarness({ port, scripted, label: 's3' });
  let reply: ChannelReply = '';
  let handlerError: string | undefined;
  let inboundFileId: string | undefined;
  try {
    const fixture = await buildFixtureXlsx();
    const attachment = stagedAttachment(harness.paths.dir, '月度销售明细.xlsx', fixture);
    try {
      reply = await harness.server.handler(incomingMessage('r2-s3-1', S3_INSTRUCTION, attachment));
    } catch (error) {
      handlerError = error instanceof Error ? error.message : String(error);
    }
    const inboundLog = harness.logs.find((line) => line['event'] === 'inbound_files_registered') as Record<string, unknown> | undefined;
    const fileIds = Array.isArray(inboundLog?.['fileIds']) ? (inboundLog['fileIds'] as string[]) : [];
    inboundFileId = fileIds[0];
  } finally {
    await harness.server.close();
  }

  // 底账只读核验：任务行、file_refs 行（入站 / 交办副本 / 产物）。
  let taskRows: Array<Record<string, unknown>> = [];
  let fileRows: Array<{ fileId: string; taskId?: string; name: string; sha256: string; bytes: number }> = [];
  try {
    const registry = createSqliteTaskRegistry(harness.paths.dbPath, { readOnly: true });
    taskRows = registry.list().map((task) => ({ taskId: task.taskId, request: task.request, started: taskStartedOf(task), reported: taskReportedOf(task), waiting: taskWaitingOf(task), mayBeRunning: taskMayBeRunningOf(task) }));
    fileRows = registry.store.listFileRefs({ principalId: PRINCIPAL_ID, sessionId: `wecom:${CONVERSATION_ID}` }).map((row) => ({
      fileId: row.fileId,
      ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
      name: row.name,
      sha256: row.sha256,
      bytes: row.bytes,
    }));
    registry.close();
  } catch (error) {
    checks.check('s3-registry-readable', false, `只读打开底账失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // ① Main 确实交办且带了 inputFiles（工具参数面）。
  const runTaskCalls = harness.sink.calls.filter((call) => call.agent === 'main' && call.tool === 'task_run');
  const inputFilesArg = runTaskCalls.flatMap((call) => {
    const args = call.args as { inputFiles?: unknown } | undefined;
    return Array.isArray(args?.inputFiles) ? (args?.inputFiles as string[]) : [];
  });
  checks.check(
    's3-delegated-with-input-files',
    runTaskCalls.length >= 1 && taskRows.length >= 1 && inboundFileId !== undefined && inputFilesArg.includes(inboundFileId),
    `task_run 调用=${runTaskCalls.length}；task 行=${taskRows.length}；入站 fileId=${inboundFileId ?? '（日志缺失）'}；inputFiles 参数=${JSON.stringify(inputFilesArg)}`,
  );

  // Worker 确实跑了 run_js（S2 切片的任务作用域工具面）。
  const workerRunJsCalls = harness.sink.calls.filter((call) => call.agent === 'worker' && call.tool === 'run_js');
  checks.check('s3-worker-ran-run-js', workerRunJsCalls.length >= 1, `Worker run_js 调用=${workerRunJsCalls.length}`);

  // ② 产物回 Main：端口收到文件；sha 对回 file_refs 行——新 fileId、task_id 绑定、非交办副本。
  const delivered = deliveredFiles(port);
  // 交办副本 = task 绑定行中 sha256 与入站行相同的行（Worker 不解析它们，产物必须另有新行）。
  const inboundSha = inboundFileId === undefined ? undefined : fileRows.find((row) => row.fileId === inboundFileId)?.sha256;
  const copyIds = new Set(
    inboundSha === undefined
      ? []
      : fileRows.filter((row) => row.taskId !== undefined && row.sha256 === inboundSha).map((row) => row.fileId),
  );
  const artifactRows: Array<{ file: DeliveredFile; row: { fileId: string; taskId?: string; name: string; sha256: string; bytes: number } | undefined }> = delivered.map((file) => ({
    file,
    row: fileRows.find((row) => row.sha256 === file.sha256) ?? undefined,
  }));
  const matchingArtifact = artifactRows.find((entry) =>
    entry.row !== undefined
    && entry.row.taskId !== undefined
    && entry.row.fileId !== inboundFileId
    && !copyIds.has(entry.row.fileId)
  );
  checks.check(
    's3-artifact-back-as-new-fileid',
    delivered.length >= 1 && matchingArtifact !== undefined,
    `交付=${delivered.length} 个；file_refs=${JSON.stringify(fileRows)}；入站=${inboundFileId}；交办副本=${JSON.stringify([...copyIds])}；命中产物行=${matchingArtifact?.row?.fileId ?? '无'}`,
  );

  // ③ 产物内容逐格一致（Oracle 重解析）——同一口径：**每个收到的产物**都要与预期一致，
  // 禁「最佳匹配」代偿（交付面里任何一个不符文件都是用户实际收到的错误产物）。
  const parsedList: Array<{ filename: string; diff: GridDiff }> = [];
  for (const entry of artifactRows) {
    try {
      const actual = await gridOfXlsx(entry.file.data);
      parsedList.push({ filename: entry.file.filename, diff: compareGrids(actual, EXPECTED_GRID) });
    } catch (error) {
      parsedList.push({ filename: entry.file.filename, diff: { ok: false, problems: [`exceljs 打开失败：${error instanceof Error ? error.message : String(error)}`] } });
    }
  }
  if (delivered.length > 0) {
    const bad = parsedList.filter((entry) => !entry.diff.ok);
    checks.check('s3-artifact-cell-by-cell', bad.length === 0, bad.length === 0
      ? `全部 ${parsedList.length} 个收到的产物与预期逐格一致`
      : `${bad.length}/${parsedList.length} 个收到的产物与预期不符：${bad.map((entry) => `「${entry.filename}」${entry.diff.problems.slice(0, 6).join('；')}`).join(' || ')}`);
  } else {
    checks.check('s3-artifact-cell-by-cell', false, handlerError !== undefined ? `回合失败无产物：${handlerError}` : '交付面没有任何文件可解析');
  }

  // ④ 行数据不出现在 Main 的工具参数与转录里（口径 2026-11-17：只判 Main 面）。
  // Worker 经 run_js 读行数据是设计行为：Worker 面命中数只作信息写进 detail，不判红；
  // Main 面覆盖下限 >= 4 保留（收窄后不许变成空扫描假绿）。
  const leakScan = scanRowDataLeakage(harness.sink.calls, harness.sink.runs, RAW_VALUE_STRINGS);
  checks.check('s3-no-row-data-in-params-or-transcript', leakScan.pass, rowDataLeakDetail(leakScan, RAW_VALUE_STRINGS.length));

  const calls = harness.sink.runs.reduce((sum, run) => sum + assistantCount(run.resultMessages), 0);
  if (handlerError !== undefined) notes.push(`handler 抛错：${handlerError}`);

  return {
    scenario: 's3',
    status: checks.allPassed ? 'pass' : 'fail',
    checks: checks.list,
    notes,
    calls,
    ...(handlerError !== undefined ? { error: handlerError } : {}),
    evidence: {
      reply,
      logs: harness.logs,
      toolCalls: harness.sink.calls,
      driverRuns: harness.sink.runs,
      deliveredFiles: delivered.map((file) => ({ filename: file.filename, bytes: file.bytes, sha256: file.sha256 })),
      fileRefs: fileRows,
      taskRows,
      parsedArtifacts: parsedList,
      leakScanSurfaces: leakScan.mainSurfaceCount,
      leakScanWorkerHits: leakScan.workerHits.length,
      expectedGrid: EXPECTED_GRID,
    },
  };
}

/** 交办副本的源（=fileId 等于 sourceFileId 的行）——占位实现（见 matchingArtifact 判定）。 */
function findCopySource(_fileId: string, _rows: Array<{ fileId: string; taskId?: string; sha256: string }>): string {
  return '';
}

// ── 入口 ────────────────────────────────────────────────────────────────────

interface CliOptions {
  scripted: boolean;
  scenarios: Array<'s2' | 's3'>;
  outDir: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { scripted: false, scenarios: ['s2', 's3'], outDir: path.join(REPO_ROOT, '.runtime', 'eval-cap01-r2', new Date().toISOString().replace(/[:.]/g, '-')) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--scripted') options.scripted = true;
    else if (arg === '--scenario') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--scenario 需要值（s2/s3，逗号分隔）');
      const picked = value.split(',').map((item) => item.trim()).filter((item) => item !== '') as Array<'s2' | 's3'>;
      const valid = picked.filter((item) => item === 's2' || item === 's3');
      if (valid.length !== picked.length || valid.length === 0) throw new Error(`--scenario 只认 s2/s3：${value}`);
      options.scenarios = valid;
    } else if (arg === '--out-dir') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
    } else {
      throw new Error(`未知参数：${arg}（支持 --scripted / --scenario / --out-dir）`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const requestedModel = process.env['LLM_MODEL'] ?? '';
  const hasKey = (process.env['LLM_API_KEY'] ?? '').trim() !== '';
  const scripted = cli.scripted || !hasKey;
  if (!hasKey) {
    console.log('[cap01-r2] 未检测到 LLM_API_KEY——按验收口径降级脚本化，报告写 model=scripted。');
  }
  const mode = scripted ? 'scripted' : 'real';
  mkdirSync(cli.outDir, { recursive: true });
  console.log(`[cap01-r2] mode=${mode} requestedModel=${requestedModel || '(env 未设置)'} scenarios=${cli.scenarios.join(',')} outDir=${cli.outDir}`);

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of cli.scenarios) {
    console.log(`[cap01-r2] ── 场景 ${scenario.toUpperCase()} 开始（mode=${mode}）──`);
    const started = Date.now();
    let outcome: ScenarioOutcome;
    try {
      outcome = scenario === 's2'
        ? await runScenarioS2(scripted)
        : await runScenarioS3(scripted);
    } catch (error) {
      outcome = {
        scenario,
        status: 'fail',
        checks: [{ name: `${scenario}-harness`, pass: false, detail: `场景抛错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }],
        notes: ['场景级异常（装配/渠道/驱动层），证据缺失即 FAIL'],
        calls: 0,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        evidence: {},
      };
    }
    outcome.evidence = { ...outcome.evidence, durationMs: Date.now() - started, mode };
    const evidencePath = path.join(cli.outDir, `${outcome.scenario}-evidence.json`);
    writeFileSync(evidencePath, JSON.stringify(outcome.evidence, null, 2) + '\n');
    for (const check of outcome.checks) {
      console.log(`[cap01-r2] ${outcome.scenario} ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
    }
    for (const note of outcome.notes) {
      console.log(`[cap01-r2] ${outcome.scenario} NOTE ${note}`);
    }
    console.log(`[cap01-r2] ── 场景 ${outcome.scenario.toUpperCase()} ${outcome.status.toUpperCase()}（calls=${outcome.calls}，${Date.now() - started}ms，证据=${evidencePath}）──`);
    outcomes.push(outcome);
  }

  const totalCalls = outcomes.reduce((sum, outcome) => sum + outcome.calls, 0);
  const observedModels = new Set<string>();
  for (const outcome of outcomes) {
    const evidenceModel = (outcome.evidence as { driverRuns?: DriverRunRecord[] }).driverRuns;
    if (evidenceModel !== undefined) {
      const model = observedModelOf(evidenceModel);
      if (model !== undefined) observedModels.add(model);
    }
  }
  const modelField = scripted
    ? 'scripted'
    : observedModels.size === 1
      ? [...observedModels][0]!
      : observedModels.size === 0
        ? requestedModel
        : `mixed:${[...observedModels].join('|')}`;
  const allPass = outcomes.every((outcome) => outcome.status === 'pass');
  const summary = {
    model: modelField,
    requestedModel,
    mode,
    observedModels: [...observedModels],
    totalCalls,
    callBudgetMax: 24,
    budgetRespected: totalCalls <= 24,
    scenarios: Object.fromEntries(outcomes.map((outcome) => [
      outcome.scenario,
      { status: outcome.status, calls: outcome.calls, checks: outcome.checks, notes: outcome.notes, ...(outcome.error !== undefined ? { error: outcome.error } : {}) },
    ])),
  };
  const summaryPath = path.join(cli.outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`[cap01-r2] model=${modelField}（请求面=${requestedModel || '(env 未设置)'}，mode=${mode}）`);
  for (const outcome of outcomes) {
    console.log(`[cap01-r2] ${outcome.scenario}=${outcome.status.toUpperCase()} calls=${outcome.calls}`);
  }
  console.log(`[cap01-r2] total_calls=${totalCalls}/24 汇总=${summaryPath}`);
  if (!allPass) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r2] 入口失败：', error);
    process.exitCode = 1;
  });
}
