#!/usr/bin/env node
/**
 * S3「事实问题必须新取」测量（issue #50 用例 3）：探针报告 → 判据输出与证据。
 *
 * 只读探针自己的产物，不改任何实现、不起网络、不读模型自述以外的来源：
 *   · <root>/.runtime/probe-*.json —— 探针报告（逐轮 reply / execution 执行层审计行）
 *   · cases.yaml（经 <root>/scripts/eval/cases.ts 加载）—— S3 的 freshFactFetch 声明
 *     （fact / askTurn / requeryTurn / gapTurns；N 只有一个事实源）
 *
 * 判据本体在 <root>/scripts/eval/freshness-criteria.ts 的 judgeFreshFactFetch（与探针
 * 判定体、期望值层共用同一份实现）——本脚本只做报告解析与呈现。
 *
 * 用法：
 *   node --import tsx scripts/eval/measure-freshness.mjs --root <worktree> --out <run outdir> \
 *     [--report <probe-*.json>]
 * 缺省取 <root>/.runtime 里最新一份含 S3 结果的探针报告。
 * 输出：stdout 判据原文 + <out>/freshness-criteria.json（结构化，含逐条证据）。
 * 退出码：0 = 绿（重问轮有新取）；1 = 红（stale-recall）；2 = 不可判/用法错误。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

const root = argValue('--root');
const out = argValue('--out');
if (!root || !out) {
  console.error('用法: node --import tsx scripts/eval/measure-freshness.mjs --root <worktree> --out <run outdir> [--report <probe-*.json>]');
  process.exit(2);
}

const { loadCases } = await import(pathToFileURL(path.join(root, 'scripts/eval/cases.ts')).href);
const { judgeFreshFactFetch } = await import(pathToFileURL(path.join(root, 'scripts/eval/freshness-criteria.ts')).href);

// ── 探针报告：显式 --report 优先；否则取 .runtime 里 S3 轮次最多的报告（并列取最新修改） ──
// 不按文件名/readdir 顺序取：失败的跑批也会落一份含 S3 的结果行（0 轮 / crashed），
// 按"轮次最多"选才不会把没跑起来的报告当证据。
const runtimeDir = path.join(root, '.runtime');
function findReport() {
  const explicit = argValue('--report');
  if (explicit) return path.resolve(explicit);
  if (!existsSync(runtimeDir)) return null;
  const all = readdirSync(runtimeDir)
    .filter((name) => name.startsWith('probe-') && name.endsWith('.json'))
    .map((name) => path.join(runtimeDir, name));
  let best = null;
  let bestTurns = -1;
  for (const file of all) {
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const row = (doc.results ?? []).find((item) => item.id === 'S3');
    if (!row) continue;
    const turns = Array.isArray(row.turns) ? row.turns.length : 0;
    if (turns > bestTurns) { best = file; bestTurns = turns; }
    else if (turns === bestTurns && best && existsSync(best)) {
      if (statSync(file).mtimeMs > statSync(best).mtimeMs) best = file;
    }
  }
  return best;
}
const reportPath = findReport();
if (!reportPath) {
  console.error('找不到含 S3 结果的探针报告（.runtime/probe-*.json）——先跑 run-probe-step37.mjs --only S3');
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const s3 = (report.results ?? []).find((row) => row.id === 'S3');
if (!s3) {
  console.error(`报告 ${path.basename(reportPath)} 里没有 S3 结果`);
  process.exit(2);
}
const spec = loadCases().find((item) => item.id === 'S3');
const want = spec?.expectations?.invariants?.freshFactFetch;
if (!want) {
  console.error('cases.yaml 的 S3 缺 freshFactFetch 声明——判据没有执行对象');
  process.exit(2);
}

// ── 逐轮证据（报告的 turns 是完整 Turn 序列化：reply / execution / calls / auditMissing 随行） ──
const turns = (s3.turns ?? []).map((turn, index) => ({
  index,
  reply: typeof turn.reply === 'string' ? turn.reply : '',
  execution: Array.isArray(turn.execution) ? turn.execution : [],
  ...(turn.auditMissing === true ? { auditMissing: true } : {}),
}));
const verdict = judgeFreshFactFetch(want, turns);

// ── 逐轮调用面（判据输出的证据原文；只看审计行，不看回复数值） ──
const turnRows = turns.map((turn, index) => {
  const executed = (turn.execution ?? []).filter((row) => !row.refused);
  const factRows = executed.filter((row) => (row.script ?? '').endsWith('.query')
    && (row.result?.collection === want.fact
      || (Array.isArray(row.args) && row.args.some((item) => item === want.fact))));
  return {
    turn: index + 1,
    calls: typeof s3.turns[index]?.calls === 'number' ? s3.turns[index].calls : undefined,
    scripts: executed.map((row) => row.script),
    factQuery: factRows.length > 0,
  };
});

const result = {
  report: path.basename(reportPath),
  case: 'S3',
  fact: want.fact,
  askTurn: want.askTurn,
  requeryTurn: want.requeryTurn,
  gapTurns: want.gapTurns,
  outcome: verdict.outcome,
  green: verdict.outcome === 'fresh-fetch',
  summary: verdict.summary,
  fetchRows: verdict.fetchRows,
  unmetRows: verdict.unmetRows,
  otherRows: verdict.otherRows,
  askFetched: verdict.askFetched,
  gapFetchTurns: verdict.gapFetchTurns,
  notes: verdict.notes,
  turnRows,
  requeryReply: turns[want.requeryTurn]?.reply ?? '',
};
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'freshness-criteria.json'), JSON.stringify(result, null, 2) + '\n');

// ── 人读摘要（判据输出原文） ──
console.log('═══ S3 事实问题必须新取（issue #50 用例 3）════════════════════');
console.log(`配置根: ${root}`);
console.log(`探针报告: ${path.basename(reportPath)}`);
console.log(`构造: 第${want.askTurn + 1}轮首问「${want.fact}」→ 隔 ${want.gapTurns} 轮 → 第${want.requeryTurn + 1}轮重问（同一事实）`);
console.log(`判据: ${verdict.summary}`);
console.log(`判定: ${verdict.outcome === 'fresh-fetch' ? '绿' : verdict.outcome === 'stale-recall' ? '红' : '不可判'}（只判路径，不判数值）`);
console.log('逐轮调用面（execution 审计行）：');
for (const row of turnRows) {
  const mark = row.turn - 1 === want.requeryTurn ? ' ←重问轮' : row.turn - 1 === want.askTurn ? ' ←首问轮' : '';
  console.log(`  第${row.turn}轮 calls=${row.calls ?? '?'} scripts=[${row.scripts.join(', ')}] factQuery(${want.fact})=${row.factQuery ? '有' : '无'}${mark}`);
}
if (verdict.unmetRows.length) {
  for (const row of verdict.unmetRows) console.log(`  碰过该事实但未执行/未取到结果: ${row.detail}`);
}
for (const row of verdict.otherRows) console.log(`  该轮其它已执行调用: ${row.detail}`);
for (const note of verdict.notes) console.log(`note: ${note}`);
console.log(`重问轮回复（仅存证，不参与判定）：${result.requeryReply.slice(0, 120).replace(/\n/g, ' ')}${result.requeryReply.length > 120 ? '…' : ''}`);
console.log(`输出: ${path.join(out, 'freshness-criteria.json')}`);
process.exit(verdict.outcome === 'fresh-fetch' ? 0 : verdict.outcome === 'stale-recall' ? 1 : 2);
