#!/usr/bin/env node
/**
 * 生成企微联调用的样例销售明细表（两份，互相独立）：
 *   1) 销售明细.xlsx —— 12 行、两个客户，金额已知，便于人工逐格核对；
 *   2) 汇总-期望.xlsx 不需要——期望值写在脚本输出里，人工对着看即可。
 *
 * 用法：
 *   node scripts/eval/fixtures/make-sales-sample.mjs /home/tao/.tmp/wecom-sample
 *
 * 为什么放仓内：文件面用例（发文件 → 汇总 → 回传新表）需要一份**金额已知**的输入，
 * 否则「回传的表对不对」只能靠感觉。数据是构造的，不含任何真实业务信息。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const ROWS = [
  { customer: '华远贸易', period: '2025-01', amount: 1000 },
  { customer: '华远贸易', period: '2025-02', amount: 2000 },
  { customer: '华远贸易', period: '2025-03', amount: 3000 },
  { customer: '华远贸易', period: '2025-04', amount: 4000 },
  { customer: '华远贸易', period: '2025-05', amount: 5000 },
  { customer: '华远贸易', period: '2025-06', amount: 6000 },
  { customer: '明达物流', period: '2025-07', amount: 500 },
  { customer: '明达物流', period: '2025-08', amount: 1500 },
  { customer: '明达物流', period: '2025-09', amount: 2500 },
  { customer: '明达物流', period: '2025-10', amount: 3500 },
  { customer: '明达物流', period: '2025-11', amount: 4500 },
  { customer: '明达物流', period: '2025-12', amount: 5500 },
];

const outDir = process.argv[2];
if (outDir === undefined || outDir === '') {
  console.error('用法：node scripts/eval/fixtures/make-sales-sample.mjs <输出目录>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('销售明细');
sheet.columns = [
  { header: '客户', key: 'customer', width: 16 },
  { header: '月份', key: 'period', width: 12 },
  { header: '金额', key: 'amount', width: 12 },
];
for (const row of ROWS) sheet.addRow(row);

const target = path.join(outDir, '销售明细.xlsx');
await workbook.xlsx.writeFile(target);

const byCustomer = new Map();
let total = 0;
for (const row of ROWS) {
  byCustomer.set(row.customer, (byCustomer.get(row.customer) ?? 0) + row.amount);
  total += row.amount;
}

console.log(`已生成：${target}`);
console.log(`行数：${ROWS.length}`);
for (const [customer, sum] of byCustomer) console.log(`期望（按客户）：${customer} = ${sum}`);
console.log(`期望（合计）：${total}`);
