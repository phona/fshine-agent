/**
 * recalc_xlsx 投递前机械闸 · TDD 用例（docs/decision-log.md §九十九 步骤 ③）。
 *
 * 判定（owner 裁定）：待投递项若是**含公式的 xlsx**，必须存在一份对应的、状态 pass 的
 * 实算报告（.recalc-report.json，按文件名 + sha256 绑定）；报告缺失 / fail / 不匹配 =
 * 不投递，并出结构化事件说明原因。无公式表格与纯数据 CSV 行为逐字节不变。
 *
 * 挂点（时序决定，见 decision-log §九十九）：recalc 报告写在独立 runDir，且 recalc_xlsx 与
 * run_js 先后调用、各自 runDir —— run-js-executor.ts:416-423 扫 out/ 处看不到后产出的报告，
 * 故最终判定放在 apps/server/server.ts deliverTurnFiles 读字节处；run_js 侧只做标注（本切片
 * 无需标注，闸门纯在投递面）。两条路都 fail-closed；缺省未注入 recalc 执行器时行为逐字节不变。
 *
 * exceljs 只在 recalc-xlsx-executor.ts（本测试通过它间接使用），**不进 file-store.ts**
 * （import-boundary.test.ts 的 file-store/exceljs 静态断言钉住，独立复核 gap1 补）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import { createFileStore, sessionDirOf } from './src/file-store';
import {
  RECALC_DELIVERY_GATE_STATUS,
  applyRecalcDeliveryGate,
  collectRecalcReports,
  decideRecalcDelivery,
  xlsxHasFormulas,
  type RecalcReportBinding,
} from './src/recalc-xlsx-executor';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:gate-u', sessionId: 'gate-sess' };
const FORMULA_CELL = { formula: 'A1+B1', result: 2 } as ExcelJS.CellValue;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function xlsxBuffer(cells: Record<string, ExcelJS.CellValue>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('汇总');
  for (const [address, value] of Object.entries(cells)) ws.getCell(address).value = value;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reportFor(bytes: Buffer, name: string, status: 'pass' | 'fail'): RecalcReportBinding {
  return { name, sha256: sha256(bytes), status, file: `in/file_x.xlsx` };
}

// ───────────────────────────── 判定核心 ─────────────────────────────
describe('recalc_delivery_gate 判定核心', () => {
  const formula = { formula: 'A1+B1', result: 2 } as ExcelJS.CellValue;

  it('xlsxHasFormulas：含公式 xlsx = true；纯数据 xlsx / CSV 文本 = false', async () => {
    const withFormula = await xlsxBuffer({ A1: 1, B1: 2, C1: formula });
    const noFormula = await xlsxBuffer({ A1: 1, B1: 2, C1: '文本' });
    expect(await xlsxHasFormulas(withFormula)).toBe(true);
    expect(await xlsxHasFormulas(noFormula)).toBe(false);
    expect(await xlsxHasFormulas(Buffer.from('a,b,c\n1,2,3\n', 'utf8'))).toBe(false);
  });

  it('带公式 xlsx 无报告 → 不投递（reason=report_missing）', async () => {
    const bytes = await xlsxBuffer({ A1: 1, C1: formula });
    const decision = await decideRecalcDelivery({ bytes, name: '汇总.xlsx', reports: [] });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_MISSING);
  });

  it('带公式 xlsx 报告 fail → 不投递（reason=report_fail）', async () => {
    const bytes = await xlsxBuffer({ A1: 1, C1: formula });
    const decision = await decideRecalcDelivery({
      bytes, name: '汇总.xlsx', reports: [reportFor(bytes, '汇总.xlsx', 'fail')],
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL);
  });

  it('带公式 xlsx 报告与文件不匹配（sha256 不同）→ 不投递（reason=report_mismatch）', async () => {
    const bytes = await xlsxBuffer({ A1: 1, C1: formula });
    const other = await xlsxBuffer({ A1: 999, C1: formula });
    const decision = await decideRecalcDelivery({
      bytes, name: '汇总.xlsx', reports: [reportFor(other, '汇总.xlsx', 'pass')],
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_MISMATCH);
  });

  it('带公式 xlsx + 匹配 pass 报告 → 投递（reason=pass）', async () => {
    const bytes = await xlsxBuffer({ A1: 1, C1: formula });
    const decision = await decideRecalcDelivery({
      bytes, name: '汇总.xlsx', reports: [reportFor(bytes, '汇总.xlsx', 'pass')],
    });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.PASS);
  });

  it('无公式 xlsx → 投递（reason=no_formulas），不要求报告', async () => {
    const bytes = await xlsxBuffer({ A1: 1, B1: '文本' });
    const decision = await decideRecalcDelivery({ bytes, name: '纯数据.xlsx', reports: [] });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.NO_FORMULAS);
  });

  it('纯数据 CSV → 投递（reason=csv_data），逐字节不改', async () => {
    const bytes = Buffer.from('名称,金额\n甲,6\n', 'utf8');
    const decision = await decideRecalcDelivery({ bytes, name: '汇总.values.csv', reports: [] });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.CSV_DATA);
  });

  it('损坏的 xlsx 字节（exceljs 读不动）按非公式放行（逐字节不变，不误伤）', async () => {
    const decision = await decideRecalcDelivery({
      bytes: Buffer.from('not a workbook'), name: '坏文件.xlsx', reports: [],
    });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.NOT_XLSX);
  });
});

// ───────────────────────────── 报告收集（绑定文件名/sha256） ─────────────────────────────
describe('collectRecalcReports：从会话 runs 目录收集报告绑定', () => {
  it('只读 run 根目录 .recalc-report.json（宿主独占）；out/ 里的伪造报告一律不认（Codex P1-1）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recalc-gate-reports-'));
    dirs.push(root);
    const store = openTaskStore(':memory:');
    const fileStore = createFileStore({ store, workspaceRoot: path.join(root, 'workspace') });
    const sessionDir = sessionDirOf(fileStore.workspaceRoot, SCOPE);
    // 宿主独占位置：runDir 根（run_js 子进程无写权限，只有 out/ 与 scratch/ 可写）。
    const writeRootReport = (runId: string, obj: unknown): void => {
      const runDir = path.join(sessionDir, 'runs', runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, '.recalc-report.json'), JSON.stringify(obj), 'utf8');
    };
    // run_js 可写位置：out/ —— 模型伪造的 pass 报告放这里必须被忽略。
    const writeOutReport = (runId: string, obj: unknown): void => {
      const out = path.join(sessionDir, 'runs', runId, 'out');
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, '.recalc-report.json'), JSON.stringify(obj), 'utf8');
    };
    writeRootReport('run_good', { name: '汇总.xlsx', sha256: 'abc', status: 'pass', file: 'in/file_x.xlsx' });
    writeRootReport('run_bad', { name: '汇总.xlsx', sha256: 'def', status: 'fail', file: 'in/file_y.xlsx' });
    // Codex 复现：模型经 run_js 在 out/ 写 pass 报告（缓存 999 未重算），必须不被收集。
    writeOutReport('run_forged', { name: '汇总.xlsx', sha256: 'forged', status: 'pass', file: 'in/file_z.xlsx' });
    // 坏 JSON 跳过
    const badRun = path.join(sessionDir, 'runs', 'run_corrupt');
    mkdirSync(badRun, { recursive: true });
    writeFileSync(path.join(badRun, '.recalc-report.json'), '{not json', 'utf8');

    const reports = collectRecalcReports(fileStore.workspaceRoot, SCOPE);
    expect(reports).toHaveLength(2);
    expect(reports).toEqual(expect.arrayContaining([
      { name: '汇总.xlsx', sha256: 'abc', status: 'pass', file: 'in/file_x.xlsx' },
      { name: '汇总.xlsx', sha256: 'def', status: 'fail', file: 'in/file_y.xlsx' },
    ]));
    // 明确断言 out/ 的伪造报告没被收进来。
    expect(reports.some((r) => r.sha256 === 'forged')).toBe(false);
  });
});

// ───────────────────────────── 闸门应用（step 前后清单一致） ─────────────────────────────
describe('applyRecalcDeliveryGate：投递清单过滤', () => {
  const formula = { formula: 'A1+B1', result: 2 } as ExcelJS.CellValue;

  it('未启用闸（enabled=false）→ 清单逐字节不变（缺省未注入执行器行为不变）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: formula });
    const csv = Buffer.from('a,b\n1,2\n', 'utf8');
    const files = [
      { name: '汇总.xlsx', bytes: f },
      { name: 'plain.txt', bytes: Buffer.from('hello') },
      { name: 'data.csv', bytes: csv },
    ];
    const out = await applyRecalcDeliveryGate({ files, reports: [], enabled: false });
    expect(out.gated).toEqual([]);
    expect(out.outgoing).toEqual(files);
    expect(out.outgoing[0]!.bytes).toBe(files[0]!.bytes); // 同一 Buffer 引用（逐字节不变）
  });

  it('启用闸：公式无报告被拦，无公式/CSV 照常 → step 前后非闸门项清单一致', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: formula });
    const plain = await xlsxBuffer({ A1: 1, B1: '文本' });
    const csv = Buffer.from('a,b\n1,2\n', 'utf8');
    const files = [
      { name: '汇总.xlsx', bytes: f },
      { name: '纯数据.xlsx', bytes: plain },
      { name: 'data.csv', bytes: csv },
    ];
    const out = await applyRecalcDeliveryGate({ files, reports: [], enabled: true });
    expect(out.outgoing.map((x) => x.name)).toEqual(['纯数据.xlsx', 'data.csv']);
    expect(out.gated).toEqual([
      { name: '汇总.xlsx', sha256: sha256(f), reason: RECALC_DELIVERY_GATE_STATUS.REPORT_MISSING },
    ]);
    // 保留项字节引用不变（step 前后逐字节一致）
    expect(out.outgoing[0]!.bytes).toBe(plain);
    expect(out.outgoing[1]!.bytes).toBe(csv);
  });

  it('启用闸：匹配 pass 报告的公式 xlsx 也照常投递', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: formula });
    const out = await applyRecalcDeliveryGate({
      files: [{ name: '汇总.xlsx', bytes: f }],
      reports: [reportFor(f, '汇总.xlsx', 'pass')],
      enabled: true,
    });
    expect(out.outgoing.map((x) => x.name)).toEqual(['汇总.xlsx']);
    expect(out.gated).toEqual([]);
  });
});

// ───────────────────────────── 报告写出携带绑定字段 ─────────────────────────────
describe('recalc 报告绑定字段：write 出的 .recalc-report.json 含 name/sha256/status', () => {
  it('execute 真实执行器后报告 JSON 可被 collectRecalcReports 直接消费并匹配', async () => {
    // 用注入假引擎的最小执行器跑一次，验证报告写出带绑定字段。
    const { createRecalcXlsxExecutor, RECALC_XLSX_REQUIRED_VERSION } = await import('./src/recalc-xlsx-executor');
    const root = mkdtempSync(path.join(os.tmpdir(), 'recalc-gate-bind-'));
    dirs.push(root);
    const store = openTaskStore(':memory:');
    const fileStore = createFileStore({ store, workspaceRoot: path.join(root, 'workspace') });
    const src = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const file = fileStore.putFile({ scope: SCOPE, name: '汇总.xlsx', bytes: src, activatedAt: Date.now() });
    const engine = {
      probe: () => ({ available: true, sofficePath: '/fake', version: RECALC_XLSX_REQUIRED_VERSION }),
      async convert({ sourcePath, outDir }: { sourcePath: string; outDir: string }) {
        const out = path.join(outDir, path.basename(sourcePath));
        writeFileSync(out, src);
        return { outputPath: out };
      },
    };
    const executor = createRecalcXlsxExecutor({ fileStore, engine });
    const result = await executor.recalc({ file: `in/${file.fileId}.xlsx`, export: 'none', scope: SCOPE });
    expect(result.status).toBe('pass');
    const reports = collectRecalcReports(fileStore.workspaceRoot, SCOPE);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sha256).toBe(sha256(src));
    expect(reports[0]!.name).toBe('汇总.xlsx');
    expect(reports[0]!.status).toBe('pass');
  });
});

// ───────────────────────────── server 挂点：终判在 deliverTurnFiles 读字节处 ─────────────────────────────
// 证明接线真正生效（拆掉 server 闸 → 这些用例转红）。用 createServer + 假驱动 + 假投递端口，
// 注入一个「run_js 产物是含公式 xlsx」的假执行器；recalc 执行器注入 = 闸门启用。
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, OutgoingFileReply } from '@fshine/contracts';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import type { RunJsExecutor } from './src/run-js-executor';
import type { RecalcXlsxExecutor } from './src/recalc-xlsx-executor';
import { createServer } from '../../apps/server/server';

interface ServerGateFixture {
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }>;
}

async function makeServerGateFixture(input: {
  formulaXlsx: Buffer;
  /** 额外写入 out/ 的非公式文件（用于混合批次；名字以 .csv 结尾）。 */
  extraPlainFile?: { name: string; bytes: Buffer };
  /** 'gate' = 注入启用的执行器；'disabled' = 显式注入 undefined（禁用闸）；'default' = 不注入工厂。 */
  recalcMode: 'gate' | 'disabled' | 'default';
  /**
   * 预置一份与投递字节匹配的 pass 实算报告（正向链路：pass 报告 → 含公式 xlsx 实际投递）。
   * 报告写在独立 recalc runDir 的 out/.recalc-report.json，绑定 name + sha256；
   * 模拟「recalc_xlsx 已对该文件实算通过」，验证 server 闸放行端到端假设。
   */
  withMatchingPassReport?: boolean;
}): Promise<ServerGateFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recalc-gate-server-'));
  dirs.push(dir);
  const logs: Array<Record<string, unknown>> = [];
  const calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> = [];

  // 假 run_js：把含公式 xlsx 写进 out/ 并登记成产物（走真实 fileStore.registerOutputsFromOut）。
  const runJs: RunJsExecutor = {
    async runJs({ scope }) {
      const { createFileStore, runDirOf } = await import('./src/file-store');
      const { openTaskStore: openStore } = await import('@fshine/core');
      // 复用 server 的 workspaceRoot 布局：从 dbPath 派生（与 workspaceRootOf 同一公式）。
      const workspaceRoot = path.join(path.dirname(path.join(dir, 'state.db')), 'workspace');
      const store = openStore(':memory:');
      const fs = createFileStore({ store, workspaceRoot });
      const runId = 'run_gate_runjs_0000000000000000000001';
      const runDir = runDirOf(workspaceRoot, scope, runId);
      const out = path.join(runDir, 'out');
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, '汇总.xlsx'), input.formulaXlsx);
      if (input.extraPlainFile !== undefined) {
        writeFileSync(path.join(out, input.extraPlainFile.name), input.extraPlainFile.bytes);
      }
      if (input.withMatchingPassReport === true) {
        // 正向链路：recalc_xlsx 已对该字节实算通过 → 报告在独立 runDir，绑定 name+sha256。
        // 报告 sha 必须是「被投递文件」的字节哈希，与 server 读回投递字节一致才匹配。
        const recalcRunDir = runDirOf(workspaceRoot, scope, 'run_gate_recalc_00000000000000000001');
        mkdirSync(recalcRunDir, { recursive: true });
        writeFileSync(
          path.join(recalcRunDir, '.recalc-report.json'),
          JSON.stringify({
            status: 'pass', name: '汇总.xlsx', sha256: sha256(input.formulaXlsx),
            file: 'in/file_x.xlsx', errorCells: [], valueDiffs: [],
          }),
          'utf8',
        );
      }
      const { outputs } = fs.registerOutputsFromOut({
        runDir, scope, limits: { maxFileBytes: 20 * 1024 * 1024, maxCount: 20 },
      });
      return {
        exitCode: 0, exitSignal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        outputs: outputs.map((o) => ({ fileId: o.fileId, name: o.name, bytes: o.bytes })),
        audit: {
          runId, runDir, scriptSha256: 'x', inputFileIds: [], materializedInputs: [], inputBytes: 0,
          outputs: outputs.map((o) => ({ fileId: o.fileId, name: o.name, bytes: o.bytes })),
          skippedOutputs: [], exitCode: 0, exitSignal: null, durationMs: 0,
        },
      };
    },
  };

  const driver: TurnDriver = {
    async run(runInput) {
      await runInput.exec('run_js', { code: 'noop' });
      return { text: '汇总完成。', messages: [] as unknown as DriverMessage[] };
    },
  };
  const face = async () => ({
    client: {
      async capabilities() { return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'q', args: [] }] }; },
      async execute() { return { status: 'completed' as const, data: {} }; },
    },
    allowedOperations: ['dummy.query'],
    readOnlyOperations: ['dummy.query'],
  });
  const config: AppConfig = {
    principals: { 'wecom:u': { enabled: true, accountSetScope: 'all', capabilities: ['read'] } },
    contextProfiles: { dummy: { root: dir, gateway: 'bin/dummy', skillRoots: [] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
  const recalcExecutor: RecalcXlsxExecutor = {
    available: true,
    engineFacts: null,
    async recalc() { throw new Error('（测试）闸用例不调用 recalc'); },
  };
  const server = await createServer({
    env: { LLM_MODEL: 'test' },
    config,
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({ mainDriver: driver, workerDriver: driver }),
    createExecutionFace: face,
    createRunJsExecutor: () => runJs,
    ...(input.recalcMode === 'gate'
      ? { createRecalcXlsxExecutor: () => recalcExecutor }
      : input.recalcMode === 'disabled'
        ? { createRecalcXlsxExecutor: () => undefined }
        : {}),
    fileDelivery: {
      deliveryMode: 'live',
      async sendToConversation(route, files): Promise<DeliveryReceipt> {
        calls.push({ route, files });
        return { route, parts: files.map((_, i) => ({ kind: 'file', index: i, status: 'sent' })) };
      },
    },
    logger: (line) => { logs.push(line); },
  });
  return { server, logs, calls };
}

function serverIncoming(): IncomingChannelMessage {
  return {
    wecomUserId: 'u', channel: 'wecom', conversationId: 'c-gate', messageId: 'm-gate',
    chatType: 'single', text: '汇总', receivedAt: new Date().toISOString(),
  };
}

describe('server 投递闸挂点（终判在 deliverTurnFiles）', () => {
  it('注入 recalc 执行器 + 公式 xlsx 无报告 → 不投递（recalc_gated），端口零调用', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({ formulaXlsx: f, recalcMode: 'gate' });
    try {
      const reply = await server.handler(serverIncoming());
      expect(reply).toContain('公式实算校验');
      expect(calls).toHaveLength(0); // 端口没收到任何文件
      const gated = logs.filter((l) => l['event'] === 'recalc_delivery_gated');
      expect(gated).toHaveLength(1);
      expect(gated[0]!['items']).toEqual([
        { name: '汇总.xlsx', sha256: sha256(f), reason: RECALC_DELIVERY_GATE_STATUS.REPORT_MISSING },
      ]);
      const done = logs.find((l) => l['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'recalc_gated', files: 0 });
    } finally {
      await server.close();
    }
  });

  it('显式禁用闸（注入 undefined）→ 同样公式 xlsx 照常投递（逐字节不变）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({ formulaXlsx: f, recalcMode: 'disabled' });
    try {
      await server.handler(serverIncoming());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.xlsx');
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(false);
      const done = logs.find((l) => l['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'sent', files: 1 });
    } finally {
      await server.close();
    }
  });

  it('注入 recalc 执行器 + 匹配 pass 报告 → 含公式 xlsx 经 server 实际投递（正向链路，独立复核 gap4）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({
      formulaXlsx: f, recalcMode: 'gate', withMatchingPassReport: true,
    });
    try {
      const reply = await server.handler(serverIncoming());
      // 端到端假设：报告绑定的 name+sha 与被投递（run_js 注册）的字节同一 → 闸放行、实际投递。
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.xlsx');
      expect(calls[0]!.files[0]!.data).toEqual(f); // 逐字节一致
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(false);
      expect(reply).not.toContain('公式实算校验');
      const done = logs.find((l) => l['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'sent', files: 1 });
    } finally {
      await server.close();
    }
  });
});

describe('server 投递闸 · 混合批次（独立复核 Gap5）', () => {
  it('批次含被拦公式表 + 正常 CSV → 只投 CSV，用户可见「部分未投递」话术，不谎称全部送达', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const csv = Buffer.from('名称,金额\n甲,6\n', 'utf8');
    const { server, logs, calls } = await makeServerGateFixture({
      formulaXlsx: f,
      extraPlainFile: { name: '明细.values.csv', bytes: csv },
      recalcMode: 'gate',
    });
    try {
      const reply = await server.handler(serverIncoming());
      // 端口只收到 CSV（被拦的公式表不投）
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files.map((x) => x.filename)).toEqual(['明细.values.csv']);
      // 用户正文必须如实说明「部分未投递」——不能只留「汇总完成。」让用户误以为全送达。
      expect(reply).toContain('部分');
      expect(reply).toMatch(/未投递|未发送|未通过/);
      // 事件面：recalc_delivery_gated 记被拦项；file_delivery 记 sent（仅 1 份）。
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(true);
      const sent = logs.find((l) => l['event'] === 'file_delivery' && l['status'] === 'sent');
      expect(sent?.['files']).toBe(1);
      const done = logs.find((l) => l['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'sent', files: 1 });
    } finally {
      await server.close();
    }
  });
});
