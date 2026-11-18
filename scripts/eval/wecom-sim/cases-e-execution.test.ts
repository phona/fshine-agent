/**
 * E 组·附件 → 执行层（W-19～W-21）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 机械判据（用户可见结果）：
 *   W-19  文件+「做成一张新表发我」→ 收到**回传文件**；字节真实可开：华远 21000 / 明达 18000 /
 *         合计 39000（run_js 真实读入站 xlsx、真实写出汇总表，经交付端口上传回传）；
 *   W-20  同输入但「只回数字，不要生成文件」→ 只回文字数字，零文件投递；
 *   W-21  文件+「存进 documents 集合」→ 只读部署如实拒绝：零写入（执行层审计无写行）、
 *         无写执行事实、不宣称成功。
 *
 * 数字对不对 = run_js 子进程读的是真实入站字节（file_refs 登记 → 激活 → 物化 in/）；
 * 回传字节 = 假 SDK 记录的 uploadMedia 真实 Buffer（测试里用 exceljs 重新打开核对）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lastToolResultJsonOf,
  lastToolResultOf,
  manifestFileIdsOf,
  settleDispatch,
  startWecomSim,
  salesSampleXlsxAsync,
  textAssistant,
  toolCallAssistant,
} from './harness';

/** run_js 汇总代码：读 in/ 下 xlsx，按客户求和；writeOutFile=true 时写 out/销售汇总.xlsx。 */
function summaryCode(writeOutFile: boolean): string {
  const writeBlock = writeOutFile
    ? `
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('汇总');
  sheet.addRow(['客户', '金额']);
  for (const [customer, amount] of byCustomer) sheet.addRow([customer, amount]);
  sheet.addRow(['合计', total]);
  fs.mkdirSync('out', { recursive: true });
  await out.xlsx.writeFile(path.join('out', '销售汇总.xlsx'));
`
    : '';
  return [
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const ExcelJS = require('exceljs');`,
    `(async () => {`,
    `  const wb = new ExcelJS.Workbook();`,
    `  await wb.xlsx.load(fs.readFileSync(fs.readdirSync('in').map((n) => path.join('in', n)).find((p) => p.endsWith('.xlsx'))));`,
    `  const byCustomer = new Map(); let total = 0;`,
    `  wb.worksheets[0].eachRow((row, index) => {`,
    `    if (index === 1) return;`,
    `    const customer = String(row.getCell(1).value ?? '').trim();`,
    `    const amount = Number(row.getCell(3).value ?? 0);`,
    `    if (customer === '') return;`,
    `    byCustomer.set(customer, (byCustomer.get(customer) ?? 0) + amount); total += amount;`,
    `  });`,
    `  console.log('SUM ' + JSON.stringify({ total, byCustomer: Object.fromEntries(byCustomer) }));`,
    writeBlock,
    `})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });`,
  ].join('\n');
}

/** run_js 真实 stdout 的 SUM 行 → 数字（解析失败立即暴露）。 */
function sumFromStdout(stdout: string): { total: number; byCustomer: Record<string, number> } {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('SUM '));
  if (line === undefined) throw new Error(`run_js 真实出口没有 SUM 行：${stdout.slice(0, 160)}`);
  return JSON.parse(line.slice(4)) as { total: number; byCustomer: Record<string, number> };
}

/** 汇总数字 → 用户可读句子（数字全部来自 run_js 真实出口）。 */
function sumReply(sum: { total: number; byCustomer: Record<string, number> }, withFile: boolean): string {
  const parts = Object.entries(sum.byCustomer).map(([customer, amount]) => `${customer} ${amount} 元`);
  return `按客户汇总：${parts.join('，')}，合计 ${sum.total} 元。${withFile ? '汇总表已生成，见附件。' : ''}`;
}

describe('E 组·附件 → 执行层（W-19～W-21）', () => {
  it('W-19 汇总成表发我：回传 xlsx 真实可开，华远 21000 / 明达 18000 / 合计 39000', async () => {
    const sample = await salesSampleXlsxAsync();
    // 回传文件需要会话投递端口 → 该样本走 async 装配（server 有推送面就一律 background）；
    // 短等待窗口给足，让 Worker 摘要同回合交给 Main（与既有样本语义一致）。
    const sim = await startWecomSim({ label: 'w19', taskDispatch: 'async', taskRunWaitMs: 20_000 });
    try {
      // 片 2：交付物只从 Worker 出 —— Main 交办并转述，Worker 的 run_js 写 out/ 回传。
      const taskText = '按客户汇总金额并生成销售汇总表';
      sim.book.mainTurn('按客户汇总金额，做成一张新表发我\n[附件:销售明细.xlsx]', [
        (call) => {
          const fileIds = manifestFileIdsOf(call.messages);
          if (fileIds.length === 0) throw new Error('Main 脚本没有从文件清单注入里拿到 fileId。');
          return toolCallAssistant('task_run', { task: taskText, inputFiles: fileIds });
        },
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask(taskText, [
        (call) => {
          const fileIds = manifestFileIdsOf(call.messages);
          if (fileIds.length === 0) throw new Error('Worker 脚本没有拿到任务文件清单（副本 fileId）。');
          return toolCallAssistant('run_js', { inputs: fileIds, code: summaryCode(true) });
        },
        (call) => {
          const output = lastToolResultJsonOf(call.messages);
          const stdout = typeof output?.['stdout'] === 'string' ? output['stdout'] : '';
          return textAssistant(sumReply(sumFromStdout(stdout), true));
        },
      ]);
      sim.sendFile('销售明细.xlsx', sample);
      await settleDispatch();
      sim.sendText('按客户汇总金额，做成一张新表发我');
      await sim.waitFor('回传文件上传', () => sim.sdk.uploads.length > 0 && sim.finalBubbles().length === 1);

      // 回传事实：uploadMedia + sendMediaMessage 各一次，文件名可读。
      expect(sim.sdk.uploads.map((upload) => upload.filename)).toEqual(['销售汇总.xlsx']);
      expect(sim.sdk.media).toHaveLength(1);
      expect(sim.sdk.media[0]).toMatchObject({ kind: 'sendMediaMessage', mediaType: 'file' });
      // 投递事实：live 端口 sent（后台完成回调；受理回合的 message_done 不再承载文件投递）。
      await sim.waitFor('文件投递落账', () => sim.logs.some((line) => line['event'] === 'file_delivery'));
      const delivery = sim.logs.filter((line) => line['event'] === 'file_delivery');
      expect(delivery).toHaveLength(1);
      expect(delivery[0]).toMatchObject({ status: 'sent', files: 1 });
      // 用户可见正文给出真实数字。
      expect(sim.finalBubbles()[0]!.content).toContain('合计 39000 元');

      // 回传字节真实可开：华远 21000 / 明达 18000 / 合计 39000。
      const delivered = sim.sdk.uploads.find((upload) => upload.filename === '销售汇总.xlsx')?.data;
      expect(delivered).toBeDefined();
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      // exceljs 的 Buffer 形状与 @types/node 的 Buffer 泛型不兼容（运行时同一对象），此处显式收窄。
      await workbook.xlsx.load(delivered as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.getWorksheet('汇总');
      expect(sheet).toBeDefined();
      const rows: Array<[string, number]> = [];
      sheet!.eachRow((row, index) => {
        if (index === 1) return;
        rows.push([String(row.getCell(1).value), Number(row.getCell(2).value)]);
      });
      expect(rows).toEqual([['华远贸易', 21000], ['明达物流', 18000], ['合计', 39000]]);
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('W-20 只要数字不要文件：只回文字数字，零文件投递', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w20' });
    try {
      sim.book.mainTurn('按客户汇总金额，只回给我数字，不要生成文件\n[附件:销售明细.xlsx]', [
        (call) => {
          const fileIds = manifestFileIdsOf(call.messages);
          if (fileIds.length === 0) throw new Error('Main 脚本没有拿到 fileId。');
          return toolCallAssistant('run_js', { inputs: fileIds, code: summaryCode(false) });
        },
        (call) => {
          const output = lastToolResultJsonOf(call.messages);
          const stdout = typeof output?.['stdout'] === 'string' ? output['stdout'] : '';
          return textAssistant(sumReply(sumFromStdout(stdout), false));
        },
      ]);
      sim.sendFile('销售明细.xlsx', sample);
      await settleDispatch();
      sim.sendText('按客户汇总金额，只回给我数字，不要生成文件');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      expect(reply).toContain('华远贸易 21000 元');
      expect(reply).toContain('明达物流 18000 元');
      expect(reply).toContain('合计 39000 元');
      // 不投递任何文件：零上传、零主动媒体、无 file_delivery 事件。
      expect(sim.sdk.uploads).toHaveLength(0);
      expect(sim.sdk.media).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'file_delivery')).toBe(false);
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('W-21 要求写入 documents：只读部署如实拒绝，零写入、无写执行事实', async () => {
    const sample = await salesSampleXlsxAsync();
    const sim = await startWecomSim({ label: 'w21' });
    try {
      sim.book.mainTurn('把里面的数据存进 documents 集合\n[附件:销售明细.xlsx]', [
        toolCallAssistant('task_run', { task: '把附件里的销售数据存进 documents 集合' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask('把附件里的销售数据存进 documents 集合', [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.prepare',
          args: { '--collection': 'documents', '--window': 'W202611', '--count': '3' },
        }),
        (call) => {
          // 宿主允许集合边界的真实拒绝（写操作不在只读允许集、未发起执行）：如实转述。
          const result = lastToolResultOf(call.messages);
          expect(result?.isError).toBe(true);
          expect(result?.text).toContain('当前权限不支持这个操作');
          return textAssistant('当前没有写权限：执行层写操作未开放，写入没有执行，你的数据原样保留。');
        },
      ]);
      sim.sendFile('销售明细.xlsx', sample);
      await settleDispatch();
      const messageId = sim.sendText('把里面的数据存进 documents 集合');
      await sim.waitFor('拒绝话术终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      expect(reply).toContain('没有写权限');
      expect(reply).not.toContain('已写入');
      expect(reply).not.toContain('写入成功');
      // 无写执行事实：允许集合边界在发起前拒绝，不产生执行行。
      const done = sim.doneOf(messageId);
      expect(done).toBeDefined();
      expect(done!.executions).toHaveLength(0);
      // 执行层审计零写面：audit.jsonl 不存在（一次执行都没发起）或存在但无 prepare/commit 行。
      const auditPath = path.join(sim.execStateDir, 'audit.jsonl');
      const auditText = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
      expect(auditText).not.toContain('dummy.prepare');
      expect(auditText).not.toContain('dummy.commit');
    } finally {
      await sim.close();
    }
  }, 90_000);
});
