/**
 * K 组·文件 → 聚合（K-1～K-3）· 自动用例（企微 × dummy 自动联调；真装配链，见 ./harness.ts）。
 *
 * 判据落在**用户可见结果 + 真实读写字节**上（模型响应脚本化、执行层真实）：
 *   K-1  一次发 3 份客户明细（含重复行）+「合并成一张汇总表发我」→
 *        ① 只回**一条**结果 + **一个**回传文件（一条终帧、一次 upload/投递）；
 *        ② 回传 xlsx 可重新打开，按客户合计 + 重复行按业务口径（订单号）去重后的合计 =
 *           三份之和（= 16000）；原始行合计 19500（不分客户、不去重）不得出现；
 *        ③ 正文说清口径：合并了 3 份、去掉 2 条重复——数字全部来自 run_js 真实 stdout。
 *   K-2  群会话发一个文件 +「按客户汇总，做张表发我」→
 *        ① 结果投回**群会话**（投递与回传均路由到 group-w，不经单聊）；
 *        ② **零主动提醒**（30s 附件追问与主动文字都不发）；
 *        ③ **私聊会话收不到**（无任何路由到单聊主体 user-a 的投递）。
 *   K-3  文件合计与执行层 documents W202611（从 fixtures 数据集 1200+800+900，2 处
 *        「来源」注释见代码）**故意不一致**，用户要求「核对一下」→
 *        ① 如实指出两边数与差额（文件 2500 / 执行层 2900 / 差 400）；
 *        ② 不擅自改任何一边、不宣称「已修正」（零写执行事实、审计无 prepare/commit）；
 *        ③ 给出可执行下一步（以哪边为准 / 重新导出）。
 *
 * 数字纪律：期望值可预置，但都带「来源」注释（三份客户明细逐行/数据集逐项；
 * 见各常量的行内注释），正文与文件数字一律来自 run_js 真算（真实 exceljs 读 in/、
 * 写 out/）与假 SDK 记录的 uploadMedia 真实字节（测试里用 exceljs 重新打开核对）。
 * 反向绊线见文件底部注释（已实测、已还原）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lastToolResultJsonOf,
  manifestFileIdsOf,
  settleDispatch,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  type SimResponse,
} from './harness';

// ─────────────────────────────────────────────────────────────────────────────
// 本地小件（用例专属；不改共享 harness，避免波及既有 A/B/C/D/E/F/G/H 样本）
// ─────────────────────────────────────────────────────────────────────────────

/** 一行客户明细：订单号（业务去重键）/ 客户 / 金额。 */
interface DetailRow {
  readonly order: string;
  readonly customer: string;
  readonly amount: number;
}

/** 生成一份客户明细 xlsx（列：订单号 / 客户 / 金额；真 exceljs 序列化）。 */
async function detailXlsxAsync(sheetName: string, rows: readonly DetailRow[]): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(['订单号', '客户', '金额']);
  for (const row of rows) sheet.addRow([row.order, row.customer, row.amount]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * 合并 run_js（真 exceljs 读写）：读 in/ 下**全部** xlsx → 按订单号去重（首见保留，业务口径：
 * 同一订单被重复导入只计一次）→ 按客户合计 → 可选写 out/<outName> 汇总表 →
 * 打印一条 `AGG {files,rows,deduped,byCustomer,total}` 供脚本派生（不硬编数字）。
 */
function mergeRunJs(writeOut: boolean, outName: string): string {
  const writeBlock = writeOut
    ? `
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['客户', '金额']);
  for (const customer of [...byCustomer.keys()].sort()) sheet.addRow([customer, byCustomer.get(customer)]);
  sheet.addRow(['合计', total]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile(path.join('out', ${JSON.stringify(outName)}));
`
    : '';
  return `(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ExcelJS = require('exceljs');
  const files = fs.readdirSync('in').filter((name) => name.endsWith('.xlsx')).sort();
  const seen = new Set();
  const byCustomer = new Map();
  let rows = 0;
  let deduped = 0;
  let total = 0;
  for (const name of files) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(path.join('in', name)));
    const ws = wb.worksheets[0];
    ws.eachRow((row, index) => {
      if (index === 1) return;
      const order = String(row.getCell(1).value ?? '').trim();
      const customer = String(row.getCell(2).value ?? '').trim();
      const amount = Number(row.getCell(3).value ?? 0);
      if (order === '' || customer === '') return;
      rows += 1;
      if (seen.has(order)) { deduped += 1; return; }
      seen.add(order);
      byCustomer.set(customer, (byCustomer.get(customer) ?? 0) + amount);
      total += amount;
    });
  }
  console.log('AGG ' + JSON.stringify({ files: files.length, rows, deduped, byCustomer: Object.fromEntries(byCustomer), total }));
${writeBlock}
})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });
`;
}

interface AggResult {
  readonly files: number;
  readonly rows: number;
  readonly deduped: number;
  readonly byCustomer: Record<string, number>;
  readonly total: number;
}

/** 解析 run_js 真实 stdout 的 AGG 行（缺失/解析失败 = undefined，立即暴露形状漂移）。 */
function parseAgg(stdout: string): AggResult | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('AGG '));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.slice(4)) as AggResult;
  } catch {
    return undefined;
  }
}

/** Main：从文件清单取 fileId 交办（inputFiles）→ 转述 Worker 真实摘要。 */
function mainDelegateSummary(taskText: string): readonly SimResponse[] {
  return [
    (call) => {
      const fileIds = manifestFileIdsOf(call.messages);
      if (fileIds.length === 0) throw new Error('Main 脚本没有从文件清单注入里拿到 fileId。');
      return toolCallAssistant('task_run', { task: taskText, inputFiles: fileIds });
    },
    (call) => {
      const summary = lastToolResultJsonOf(call.messages)?.['summary'];
      if (typeof summary !== 'string' || summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
      return textAssistant(summary);
    },
  ];
}

/** Worker：run_js 合并（真读 in/）+ 按真实 stdout 汇报口径与数字。 */
function workerMergeResponses(writeOut: boolean, outName: string): readonly SimResponse[] {
  return [
    (call) => {
      const fileIds = manifestFileIdsOf(call.messages);
      if (fileIds.length === 0) throw new Error('Worker 脚本没有拿到任务文件清单（交办副本 fileId）。');
      return toolCallAssistant('run_js', { inputs: fileIds, code: mergeRunJs(writeOut, outName) });
    },
    (call) => {
      const output = lastToolResultJsonOf(call.messages);
      const stdout = typeof output?.['stdout'] === 'string' ? output['stdout'] : '';
      const agg = parseAgg(stdout);
      if (agg === undefined) throw new Error(`run_js 真实出口没有 AGG 行：${stdout.slice(0, 160)}`);
      const parts = [...Object.entries(agg.byCustomer)].sort().map(([customer, amount]) => `${customer} ${amount} 元`);
      const dedupeNote = agg.deduped > 0 ? `，去掉 ${agg.deduped} 条重复` : '';
      return textAssistant(
        `合并了 ${agg.files} 份明细${dedupeNote}，按客户汇总：${parts.join('，')}，合计 ${agg.total} 元。${writeOut ? '汇总表已生成，见附件。' : ''}`,
      );
    },
  ];
}

/** 汇总回传表重开后的行（[客户, 金额]；含「合计」行）。 */
async function reopenedRows(bytes: Buffer): Promise<Array<[string, number]>> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  // exceljs 的 Buffer 形状与 @types/node 泛型不兼容（运行时同一对象），显式收窄。
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet('汇总');
  if (sheet === undefined) throw new Error('回传 xlsx 没有「汇总」工作表。');
  const rows: Array<[string, number]> = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    rows.push([String(row.getCell(1).value), Number(row.getCell(2).value)]);
  });
  return rows;
}

// ── K-1 明细：3 份客户明细，含 2 条跨文件重复行（订单号相同）───────────────────
// 「来源」：每份逐行预置；合计 = 逐行求和（三份之和 = 16000，去重后）。
//   File1 华远贸易：8721+8722+8723 = 3000+2500+1500 = 7000
//   File2 明达物流：9011+9012+9013 = 4000+2000+1000 = 7000
//   File3 新程科技补录：9521+9522 = 1200+800 = 2000（另含 8723、9012 两条重复行）
const HUA_YUAN_ROWS: readonly DetailRow[] = [
  { order: '8721', customer: '华远贸易', amount: 3000 },
  { order: '8722', customer: '华远贸易', amount: 2500 },
  { order: '8723', customer: '华远贸易', amount: 1500 },
];
const MING_DA_ROWS: readonly DetailRow[] = [
  { order: '9011', customer: '明达物流', amount: 4000 },
  { order: '9012', customer: '明达物流', amount: 2000 },
  { order: '9013', customer: '明达物流', amount: 1000 },
];
const XIN_CHENG_ROWS: readonly DetailRow[] = [
  { order: '9521', customer: '新程科技', amount: 1200 },
  { order: '9522', customer: '新程科技', amount: 800 },
  { order: '8723', customer: '华远贸易', amount: 1500 }, // 重复行（File1 已录 8723）
  { order: '9012', customer: '明达物流', amount: 2000 }, // 重复行（File2 已录 9012）
];

// K-1 期望（来源见上）：去重后 华远 7000 / 明达 7000 / 新程 2000 / 合计 16000；去重 2 条；
// 不去重则 19500（反向绊线读数的来源）。按客户断言（出表顺序不参与判据）。
const K1_EXPECTED_BY_CUSTOMER: Record<string, number> = { 华远贸易: 7000, 明达物流: 7000, 新程科技: 2000 };
const K1_EXPECTED_TOTAL = 16000;

describe('K 组·文件 → 聚合（K-1～K-3）', () => {
  it('K-1 三份明细合并汇总：一条结果 + 一个回传表，去重后合计 16000，正文说清口径', async () => {
    const file1 = await detailXlsxAsync('华远贸易', HUA_YUAN_ROWS);
    const file2 = await detailXlsxAsync('明达物流', MING_DA_ROWS);
    const file3 = await detailXlsxAsync('新程科技补录', XIN_CHENG_ROWS);
    const sim = await startWecomSim({ label: 'k1', taskDispatch: 'async', taskRunWaitMs: 20_000 });
    try {
      // 合并窗内到达的指令 + 三个附件合成一回合；三个文件名按到达顺序列出。
      const mergedText = '合并成一张汇总表发我\n[附件:华远贸易.xlsx]\n[附件:明达物流.xlsx]\n[附件:新程科技补录.xlsx]';
      const taskText = '把三份客户明细合并成一张汇总表';
      sim.book.mainTurn(mergedText, mainDelegateSummary(taskText));
      sim.book.workerTask(taskText, workerMergeResponses(true, '客户汇总.xlsx'));

      sim.sendFile('华远贸易.xlsx', file1);
      await settleDispatch();
      sim.sendFile('明达物流.xlsx', file2);
      await settleDispatch();
      sim.sendFile('新程科技补录.xlsx', file3);
      await settleDispatch();
      sim.sendText('合并成一张汇总表发我'); // 3s 窗口内到达（适配器真实定时器远未到点）
      await sim.waitFor('回传文件上传 + 一条终帧', () => sim.sdk.uploads.length > 0 && sim.finalBubbles().length === 1);

      // ① 只回一条结果 + 一个回传文件。
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.sdk.uploads.map((upload) => upload.filename)).toEqual(['客户汇总.xlsx']);
      expect(sim.sdk.media).toHaveLength(1);
      expect(sim.sdk.media[0]).toMatchObject({ kind: 'sendMediaMessage', mediaType: 'file' });
      await sim.waitFor('文件投递落账', () => sim.logs.some((line) => line['event'] === 'file_delivery'));
      const delivery = sim.logs.filter((line) => line['event'] === 'file_delivery');
      expect(delivery).toHaveLength(1);
      expect(delivery[0]).toMatchObject({ status: 'sent', files: 1 });

      // ② 回传 xlsx 真实可开：按客户合并、重复行去重后的合计 = 三份之和（16000）。
      const delivered = sim.sdk.uploads.find((upload) => upload.filename === '客户汇总.xlsx')?.data;
      expect(delivered).toBeDefined();
      const rowsBack = await reopenedRows(delivered!);
      const totalRow = rowsBack.find(([customer]) => customer === '合计');
      const byCustomerBack = Object.fromEntries(rowsBack.filter(([customer]) => customer !== '合计'));
      expect(byCustomerBack).toEqual(K1_EXPECTED_BY_CUSTOMER);
      expect(totalRow?.[1]).toBe(K1_EXPECTED_TOTAL);

      // 不去重的原始行合计 19500 不得出现在回传表里（反向绊线读数：去掉去重即出现 19500）。
      const rawTotal = HUA_YUAN_ROWS.concat(MING_DA_ROWS, XIN_CHENG_ROWS).reduce((sum, row) => sum + row.amount, 0);
      expect(rawTotal).toBe(19500); // 「来源」：3 份逐行求和（含 2 条重复行）
      expect(rowsBack.some(([, amount]) => amount === rawTotal)).toBe(false);

      // ③ 正文说清口径（合并了几份、去重几条）——数字来自 run_js 真实 stdout。
      const reply = sim.finalBubbles()[0]!.content;
      expect(reply).toContain('合并了 3 份');
      expect(reply).toContain('去掉 2 条重复');
      expect(reply).toContain('华远贸易 7000 元');
      expect(reply).toContain('明达物流 7000 元');
      expect(reply).toContain('新程科技 2000 元');
      expect(reply).toContain('合计 16000 元');
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('K-2 群里发文件做汇总：结果投回群会话、零主动提醒、私聊收不到', async () => {
    // 「来源」：单文件逐行 3000+1000(华远)=4000 / 2000(明达)=2000，合计 6000。
    const rows: readonly DetailRow[] = [
      { order: 'W1', customer: '华远贸易', amount: 3000 },
      { order: 'W2', customer: '明达物流', amount: 2000 },
      { order: 'W3', customer: '华远贸易', amount: 1000 },
    ];
    const file = await detailXlsxAsync('客户明细', rows);
    // 群主体显式给 operator 让任务真跑起来（默认 viewer 只读）。
    const sim = await startWecomSim({ label: 'k2', taskDispatch: 'async', taskRunWaitMs: 20_000, groupRole: 'operator' });
    const GROUP = { chatType: 'group' as const, conversationId: 'group-w' };
    try {
      const mergedText = '按客户汇总，做张表发我\n[附件:客户明细.xlsx]';
      const taskText = '把群里的客户明细按客户汇总成一张表';
      sim.book.mainTurn(mergedText, mainDelegateSummary(taskText));
      sim.book.workerTask(taskText, workerMergeResponses(true, '群客户汇总.xlsx'));

      sim.sendFile('客户明细.xlsx', file, GROUP);
      await settleDispatch();
      sim.sendText('按客户汇总，做张表发我', GROUP);
      await sim.waitFor('群回传文件上传 + 一条终帧', () => sim.sdk.uploads.length > 0 && sim.finalBubbles().length === 1);

      // ① 结果投回群会话：回传经 sendMediaMessage 路由到 group-w；投递事件 sessionId = wecom:group-w。
      expect(sim.sdk.uploads.map((upload) => upload.filename)).toEqual(['群客户汇总.xlsx']);
      expect(sim.sdk.media).toHaveLength(1);
      expect(sim.sdk.media[0]).toMatchObject({ kind: 'sendMediaMessage', chatId: 'group-w', mediaType: 'file' });
      const delivery = sim.logs.filter((line) => line['event'] === 'file_delivery');
      expect(delivery).toHaveLength(1);
      expect(delivery[0]).toMatchObject({ status: 'sent', files: 1, sessionId: 'wecom:group-w' });
      // 正文给出真实数字（结果本身投回群）。
      expect(sim.finalBubbles()[0]!.content).toContain('合计 6000 元');

      // ② 零主动提醒：30s 推进后既无附件追问，也无主动文字。
      await sim.clock.advance(30_000);
      expect(sim.nudgeTexts()).toHaveLength(0);
      expect(sim.sdk.proactiveTexts).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);

      // ③ 私聊会话收不到：没有任何投递/回传/主动文字路由到单聊主体 user-a。
      const toSingle = [...sim.sdk.media, ...sim.sdk.proactiveTexts].filter((record) => record.chatId === 'user-a');
      expect(toSingle).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'file_delivery' && line['sessionId'] === 'wecom:user-a')).toBe(false);
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('K-3 文件与执行层对不上：如实报差额、不改任一边、不宣称已修正、给出下一步', async () => {
    // 「来源」：文件逐行 1500(华远)+1000(明达)=2500；执行层 documents W202611 由 fixtures 数据集
    // scripts/eval/fixtures/scenarios/dummy-finance/datasets/documents.json（1200/800/900）合计 = 2900。
    // 两者故意不一致：差额 = 2900 - 2500 = 400。
    const rows: readonly DetailRow[] = [
      { order: 'K1', customer: '华远贸易', amount: 1500 },
      { order: 'K2', customer: '明达物流', amount: 1000 },
    ];
    const FILE_TOTAL = 2500;
    const EXEC_TOTAL = 2900; // 数据集 1200 + 800 + 900
    const DIFF = 400;
    const file = await detailXlsxAsync('客户核对', rows);
    const sim = await startWecomSim({ label: 'k3', taskDispatch: 'async', taskRunWaitMs: 20_000 });
    try {
      const mergedText = '核对一下：这份明细和 documents 集合 W202611 的合计对得上吗\n[附件:客户核对.xlsx]';
      const taskText = '核对客户明细文件与 documents 集合 W202611 的合计是否一致';

      // Worker 侧：先 run_js 真算文件合计，再真实查执行层，最后按两边真实数汇报差额。
      let fileTotal: number | undefined;
      sim.book.workerTask(taskText, [
        (call) => {
          const fileIds = manifestFileIdsOf(call.messages);
          if (fileIds.length === 0) throw new Error('Worker 脚本没有拿到任务文件清单。');
          return toolCallAssistant('run_js', { inputs: fileIds, code: fileTotalRunJs() });
        },
        (call) => {
          const output = lastToolResultJsonOf(call.messages);
          const stdout = typeof output?.['stdout'] === 'string' ? output['stdout'] : '';
          const parsed = parseFileTotal(stdout);
          if (parsed === undefined) throw new Error(`run_js 真实出口没有 FILE 行：${stdout.slice(0, 160)}`);
          fileTotal = parsed.total;
          return toolCallAssistant('execute_operation', {
            operation: 'dummy.query',
            args: { '--collection': 'documents', '--window': 'W202611' },
          });
        },
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          const data = (outcome?.['data'] ?? {}) as { items?: ReadonlyArray<{ value?: number }>; sum?: number };
          const execTotal = typeof data.sum === 'number'
            ? data.sum
            : (data.items ?? []).reduce((sum, item) => sum + (typeof item.value === 'number' ? item.value : 0), 0);
          if (fileTotal === undefined) throw new Error('Worker 脚本没有拿到文件合计。');
          return textAssistant(reconcileText(fileTotal, execTotal));
        },
      ]);
      sim.book.mainTurn(mergedText, mainDelegateSummary(taskText));

      sim.sendFile('客户核对.xlsx', file);
      await settleDispatch();
      const messageId = sim.sendText('核对一下：这份明细和 documents 集合 W202611 的合计对得上吗');
      await sim.waitFor('核对回合终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // ① 如实指出两边的数与差额（数字来自真实读写：run_js 真算 + 执行层真查）。
      expect(reply).toContain(String(FILE_TOTAL));
      expect(reply).toContain(String(EXEC_TOTAL));
      expect(reply).toContain(String(DIFF));
      // ② 不擅自改任何一边、不宣称已修正。
      for (const claim of ['已修正', '已修改', '已更新', '已对齐', '已写入', '已调整', '已同步']) {
        expect(reply).not.toContain(claim);
      }
      // ③ 给出可执行下一步（以哪边为准 / 重新导出）。
      expect(reply).toContain('为准');
      expect(reply).toContain('重新导出');

      // 机械事实：本回合只做真实读（run_js 读取 + dummy.query），零写执行。
      const done = sim.doneOf(messageId);
      expect(done).toBeDefined();
      const operations = done!.executions.map((execution) => execution.operation);
      expect(operations).toContain('dummy.query');
      expect(operations).toContain('run_js');
      for (const operation of operations) {
        expect(['dummy.query', 'run_js']).toContain(operation);
      }
      // 执行层审计无任何写行（prepare/commit 从未发起）。
      const auditPath = path.join(sim.execStateDir, 'audit.jsonl');
      const auditText = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
      expect(auditText).not.toContain('dummy.prepare');
      expect(auditText).not.toContain('dummy.commit');
    } finally {
      await sim.close();
    }
  }, 90_000);
});

/** K-3 的文件合计 run_js：真读 in/ 下 xlsx，按客户合计并打印 `FILE {total,byCustomer}`。 */
function fileTotalRunJs(): string {
  return `(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ExcelJS = require('exceljs');
  const entry = fs.readdirSync('in').filter((name) => name.endsWith('.xlsx')).sort()[0];
  if (entry === undefined) { console.error('没有 xlsx 输入'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(path.join('in', entry)));
  const ws = wb.worksheets[0];
  const byCustomer = {};
  let total = 0;
  ws.eachRow((row, index) => {
    if (index === 1) return;
    const customer = String(row.getCell(2).value ?? '').trim();
    const amount = Number(row.getCell(3).value ?? 0);
    if (customer === '') return;
    byCustomer[customer] = (byCustomer[customer] ?? 0) + amount;
    total += amount;
  });
  console.log('FILE ' + JSON.stringify({ total, byCustomer }));
})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });
`;
}

/** 解析 run_js 真实 stdout 的 FILE 行。 */
function parseFileTotal(stdout: string): { total: number; byCustomer: Record<string, number> } | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('FILE '));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.slice(5)) as { total: number; byCustomer: Record<string, number> };
  } catch {
    return undefined;
  }
}

/** 核对汇报（数字全部来自两边真实读数）：如实报差额、声明未改动、给可执行下一步。 */
function reconcileText(fileTotal: number, execTotal: number): string {
  const diff = execTotal - fileTotal;
  return `我把两边都核了一遍：文件里合计 ${fileTotal} 元，执行层 documents W202611 合计 ${execTotal} 元，两边差 ${diff} 元。我没有改动任何一边。下一步建议：以执行层为准，让财务重新导出这份文件后再核对一次。`;
}

/*
 * 反向绊线（均实测、实测后已还原；读数见本轨提交说明）：
 *   ① K-1：把 mergeRunJs 的「按订单号去重」（`if (seen.has(order)) ...` 分支）去掉 →
 *      重复行被重复计数，实测回传表变 华远 8500 / 明达 9000（合计 19500）≠ 16000，
 *      K-1 ② 必红；还原后绿。
 *   ② K-2：把 harness.ts 的 fileDeliveryPort.sendToConversation 固定成单聊
 *      （`{ ...route, conversationId: 'user-a' }`）→ 实收回传 chatId 变 user-a，
 *      K-2 ① 的 chatId/sessionId 断言必红；还原后绿。
 */
