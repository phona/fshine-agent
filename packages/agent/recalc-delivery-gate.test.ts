/**
 * recalc_xlsx 投递前机械闸 · TDD 用例（docs/decisions/index.md §九十九 步骤 ③）。
 *
 * 判定（owner 最初职责边界裁定，2026-11-17 纠偏）：
 *   · 执行层交付无公式数据、公式工程只归 Main 的 recalc_xlsx；
 *   · 投递门**完全报告驱动，不解析任何 xlsx 内容**：
 *       - 文件有 name + sha256 双匹配的实算报告 → status=pass 投递 / fail 不投递；
 *       - 无报告 → 放行（执行层交付的数据，边界内信任）。
 *   · builder 自检（认不出公式形态就拒盖章）归执行器内部 scanWorkbookFormulas，不在此门。
 *
 * 这条边界把「任意外部 xlsx 的形态空间」从投递安全判定里彻底移除——不再有 shared/array/
 * 前导字节等形态绕过问题。原先按内容扫描的用例随机制退役，由下列报告驱动用例取代。
 *
 * 挂点：recalc 报告写在独立 runDir 根（宿主独占，run_js 无写权限），终判在 server
 * deliverTurnFiles 读字节处（报告可能晚于 run_js out/ 扫描产生）。缺省未注入执行器 = 不启用。
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
  return { name, sha256: sha256(bytes), status, file: 'in/file_x.xlsx' };
}

// ───────────────────────────── 判定核心（报告驱动） ─────────────────────────────
describe('recalc_delivery_gate 判定核心（报告驱动，不解析内容）', () => {
  it('无报告 → 放行（执行层交付的无公式数据，边界内信任）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const decision = decideRecalcDelivery({ bytes: f, name: '汇总.xlsx', reports: [] });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.NO_REPORT);
  });

  it('无报告的任意字节（含非 xlsx / 前导字节 / 特殊形态）一律放行——门不打开内容', async () => {
    for (const [name, bytes] of [
      ['preamble.xlsx', Buffer.concat([Buffer.from('junk'), await xlsxBuffer({ A1: 1 })])],
      ['坏文件.xlsx', Buffer.from('not a workbook')],
      ['data.csv', Buffer.from('a,b\n1,2\n', 'utf8')],
    ] as Array<[string, Buffer]>) {
      const d = decideRecalcDelivery({ bytes, name, reports: [] });
      expect(d.deliver).toBe(true);
      expect(d.reason).toBe(RECALC_DELIVERY_GATE_STATUS.NO_REPORT);
    }
  });

  it('同 sha 改名不改判定：fail 报告按 sha 绑定，改文件名也拦（Codex R13-major）', async () => {
    const f = await xlsxBuffer({ A1: 1 });
    const failReport = reportFor(f, 'bad.xlsx', 'fail');
    // 同字节、改名投递——仍须按 sha 命中 fail 报告并拦截。
    const d = decideRecalcDelivery({ bytes: f, name: 'renamed-clean.csv', reports: [failReport] });
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL);
  });

  it('同 sha 多份报告：只认最新一份，旧 pass 不覆盖新 fail（Codex R9-P2）', async () => {
    const f = await xlsxBuffer({ A1: 1 });
    const oldPass = { ...reportFor(f, '汇总.xlsx', 'pass'), createdAt: 1000 };
    const newFail = { ...reportFor(f, '汇总.xlsx', 'fail'), createdAt: 2000 };
    const d = decideRecalcDelivery({ bytes: f, name: '汇总.xlsx', reports: [oldPass, newFail] });
    expect(d.deliver).toBe(false);
    expect(d.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL);
    // 反过来：旧的 fail 不压新的 pass。
    const d2 = decideRecalcDelivery({
      bytes: f, name: '汇总.xlsx',
      reports: [{ ...newFail, createdAt: 1000 }, { ...oldPass, createdAt: 2000 }],
    });
    expect(d2.deliver).toBe(true);
  });

  it('有匹配 fail 报告 → 不投递（reason=report_fail）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const decision = decideRecalcDelivery({ bytes: f, name: '汇总.xlsx', reports: [reportFor(f, '汇总.xlsx', 'fail')] });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL);
  });

  it('有匹配 pass 报告 → 投递（reason=pass）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const decision = decideRecalcDelivery({ bytes: f, name: '汇总.xlsx', reports: [reportFor(f, '汇总.xlsx', 'pass')] });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.PASS);
  });

  it('报告 sha256 不匹配当前字节 → 视为无报告放行（不是本文件的实算结论）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const other = await xlsxBuffer({ A1: 99 });
    const decision = decideRecalcDelivery({ bytes: f, name: '汇总.xlsx', reports: [reportFor(other, '汇总.xlsx', 'fail')] });
    // 报告绑定的是别的字节，对本文件不构成实算结论 → 按无报告处理。
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe(RECALC_DELIVERY_GATE_STATUS.NO_REPORT);
  });
});

describe('collectRecalcReports：从会话 runs 目录收集报告绑定', () => {
  it('只读 run 根目录 .recalc-report.json（宿主独占）；out/ 里的伪造报告一律不认（Codex P1-1）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recalc-gate-reports-'));
    dirs.push(root);
    const store = openTaskStore(':memory:');
    const fileStore = createFileStore({ store, workspaceRoot: path.join(root, 'workspace') });
    const sessionDir = sessionDirOf(fileStore.workspaceRoot, SCOPE);
    const writeRootReport = (runId: string, obj: unknown): void => {
      const runDir = path.join(sessionDir, 'runs', runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, '.recalc-report.json'), JSON.stringify(obj), 'utf8');
    };
    const writeOutReport = (runId: string, obj: unknown): void => {
      const out = path.join(sessionDir, 'runs', runId, 'out');
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, '.recalc-report.json'), JSON.stringify(obj), 'utf8');
    };
    writeRootReport('run_good', { name: '汇总.xlsx', sha256: 'abc', status: 'pass', file: 'in/file_x.xlsx' });
    writeRootReport('run_bad', { name: '汇总.xlsx', sha256: 'def', status: 'fail', file: 'in/file_y.xlsx' });
    writeOutReport('run_forged', { name: '汇总.xlsx', sha256: 'forged', status: 'pass', file: 'in/file_z.xlsx' });
    const badRun = path.join(sessionDir, 'runs', 'run_corrupt');
    mkdirSync(badRun, { recursive: true });
    writeFileSync(path.join(badRun, '.recalc-report.json'), '{not json', 'utf8');

    const reports = collectRecalcReports(fileStore.workspaceRoot, SCOPE);
    expect(reports).toHaveLength(2);
    expect(reports).toEqual(expect.arrayContaining([
      { name: '汇总.xlsx', sha256: 'abc', status: 'pass', file: 'in/file_x.xlsx' },
      { name: '汇总.xlsx', sha256: 'def', status: 'fail', file: 'in/file_y.xlsx' },
    ]));
    expect(reports.some((r) => r.sha256 === 'forged')).toBe(false);
  });
});

// ───────────────────────────── 闸门应用（清单过滤） ─────────────────────────────
describe('applyRecalcDeliveryGate：投递清单过滤', () => {
  it('未启用闸（enabled=false）→ 清单逐字节不变（缺省未注入执行器行为不变）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const files = [
      { name: '汇总.xlsx', bytes: f },
      { name: 'plain.txt', bytes: Buffer.from('hello') },
    ];
    const out = await applyRecalcDeliveryGate({ files, reports: [], enabled: false });
    expect(out.gated).toEqual([]);
    expect(out.outgoing).toEqual(files);
    expect(out.outgoing[0]!.bytes).toBe(files[0]!.bytes);
  });

  it('启用闸：fail 报告的文件被拦，无报告 / pass 报告照常 → 清单逐字节一致', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const plain = await xlsxBuffer({ A1: 1, B1: '文本' });
    const csv = Buffer.from('a,b\n1,2\n', 'utf8');
    const out = await applyRecalcDeliveryGate({
      files: [
        { name: '坏表.xlsx', bytes: f },
        { name: '纯数据.xlsx', bytes: plain },
        { name: 'data.csv', bytes: csv },
      ],
      reports: [reportFor(f, '坏表.xlsx', 'fail')],
      enabled: true,
    });
    expect(out.outgoing.map((x) => x.name)).toEqual(['纯数据.xlsx', 'data.csv']);
    expect(out.gated).toEqual([
      { name: '坏表.xlsx', sha256: sha256(f), reason: RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL },
    ]);
    expect(out.outgoing[0]!.bytes).toBe(plain);
  });
});

// ───────────────────────────── 报告写出携带绑定字段 ─────────────────────────────
describe('recalc 报告绑定字段：write 出的 .recalc-report.json 含 name/sha256/status', () => {
  it('execute 真实执行器后报告 JSON 可被 collectRecalcReports 直接消费并匹配', async () => {
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
  extraPlainFile?: { name: string; bytes: Buffer };
  recalcMode: 'gate' | 'disabled' | 'default';
  /** 预置报告状态：'pass' 放行 / 'fail' 拦截 / undefined 无报告（放行）。 */
  reportStatus?: 'pass' | 'fail';
}): Promise<ServerGateFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recalc-gate-server-'));
  dirs.push(dir);
  const logs: Array<Record<string, unknown>> = [];
  const calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> = [];

  const runJs: RunJsExecutor = {
    async runJs({ scope }) {
      const { createFileStore, runDirOf } = await import('./src/file-store');
      const { openTaskStore: openStore } = await import('@fshine/core');
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
      if (input.reportStatus !== undefined) {
        const recalcRunDir = runDirOf(workspaceRoot, scope, 'run_gate_recalc_00000000000000000001');
        mkdirSync(recalcRunDir, { recursive: true });
        writeFileSync(
          path.join(recalcRunDir, '.recalc-report.json'),
          JSON.stringify({
            status: input.reportStatus, name: '汇总.xlsx', sha256: sha256(input.formulaXlsx),
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

  // 片 2：交付物只从 Worker 出 —— Main 交办，Worker 的 run_js 产出文件。
  const mainDriver: TurnDriver = {
    async run(runInput) {
      await runInput.exec('task_run', { task: '汇总并生成表格' });
      return { text: '汇总完成。', messages: [] as unknown as DriverMessage[] };
    },
  };
  const workerDriver: TurnDriver = {
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
    createDrivers: () => ({ mainDriver, workerDriver }),
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
  it('注入 recalc 执行器 + fail 报告 → 不投递（recalc_gated），端口零调用', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({ formulaXlsx: f, recalcMode: 'gate', reportStatus: 'fail' });
    try {
      const reply = await server.handler(serverIncoming());
      expect(reply).toContain('公式实算校验');
      expect(calls).toHaveLength(0);
      const gated = logs.filter((l) => l['event'] === 'recalc_delivery_gated');
      expect(gated).toHaveLength(1);
      expect(gated[0]!['items']).toEqual([
        { name: '汇总.xlsx', sha256: sha256(f), reason: RECALC_DELIVERY_GATE_STATUS.REPORT_FAIL },
      ]);
    } finally {
      await server.close();
    }
  });

  it('无报告（执行层数据）→ 照常投递，不误伤', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({ formulaXlsx: f, recalcMode: 'gate' });
    try {
      await server.handler(serverIncoming());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.xlsx');
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('匹配 pass 报告 → 经 server 实际投递（正向链路）', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const { server, logs, calls } = await makeServerGateFixture({
      formulaXlsx: f, recalcMode: 'gate', reportStatus: 'pass',
    });
    try {
      await server.handler(serverIncoming());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.xlsx');
      expect(calls[0]!.files[0]!.data).toEqual(f);
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe('server 投递闸 · 混合批次', () => {
  it('批次含 fail 报告表 + 无报告 CSV → 只投 CSV，用户可见「部分未投递」话术', async () => {
    const f = await xlsxBuffer({ A1: 1, C1: FORMULA_CELL });
    const csv = Buffer.from('名称,金额\n甲,6\n', 'utf8');
    const { server, logs, calls } = await makeServerGateFixture({
      formulaXlsx: f,
      extraPlainFile: { name: '明细.values.csv', bytes: csv },
      recalcMode: 'gate',
      reportStatus: 'fail',
    });
    try {
      const reply = await server.handler(serverIncoming());
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files.map((x) => x.filename)).toEqual(['明细.values.csv']);
      expect(reply).toContain('部分');
      expect(reply).toMatch(/未投递|未发送|未通过/);
      expect(logs.some((l) => l['event'] === 'recalc_delivery_gated')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
