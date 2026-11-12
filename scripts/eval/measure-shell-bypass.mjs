#!/usr/bin/env node
/**
 * B3 shell 绕过测量：探针报告 + runner 保留的 per-case state → `judgeShellBypass` 结论。
 *
 * 只读探针自己的产物，不改任何实现：
 *   · .runtime/probe-<runId>.json —— 逐轮 gateRows（宿主门裁决行）与 execution（执行层审计行）；
 *   · <out>/state/*               —— runner 钩子保留的 per-case stateDir：
 *       plans.json（计划声明 calls）、agent-*.db（plan_confirmation_resolutions 的用户确认）。
 *
 * 判据本体在 scripts/eval/shell-bypass-criteria.ts（纯函数）；本脚本只做证据装配与呈现。
 * 网关名不另立名单：从用例夹具声明的 gateway 出发，把它 bin/ 下**同一个文件**的别名一并收进来
 * （fixture 的 bin/generic 是 bin/dummy 的符号链接；探针跑的 profile.gateway 用的是另一个名字）。
 *
 * 两个根的分工：**量具**（判据本体、cases.yaml、夹具声明、production 模块）取自本脚本所在的
 * worktree——判据不是被测量对象的属性；**证据**（.runtime 的探针报告）取自 `--root`
 * （跑过那次探针的 worktree，缺省 = 量具 worktree）。state 永远取自 `<out>/state`。
 *
 * 用法：node --import tsx scripts/eval/measure-shell-bypass.mjs --out <run outdir> [--root <evidence worktree>] [--case B3]
 * 输出：stdout 人读摘要 + <out>/shell-bypass-criteria.json（结构化，含逐行证据）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

const out = argValue('--out');
if (!out) {
  console.error('用法: node --import tsx scripts/eval/measure-shell-bypass.mjs --out <run outdir> [--root <evidence worktree>] [--case B3]');
  process.exit(2);
}
const caseId = argValue('--case') ?? 'B3';
/** 量具根 = 本脚本所在 worktree（判据本体与 production 模块同源，不随被测对象走）。 */
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(argValue('--root') ?? worktree);

const importTs = (rel) => import(pathToFileURL(path.join(worktree, rel)).href);
const { judgeShellBypass } = await importTs('scripts/eval/shell-bypass-criteria.ts');
const { loadCases } = await importTs('scripts/eval/cases.ts');
const { loadOperationSemantics, loadOperationArgSpecs } = await importTs('packages/agent/src/operation-labels.ts');

// ── 报告 ↔ 保留 state 配对（与 U1/T5 测量同一判据：messageId 交集最大）──────────────
const runtimeDir = path.join(root, '.runtime');
const stateRoot = path.join(out, 'state');
const dirs = existsSync(stateRoot) ? readdirSync(stateRoot).map((name) => path.join(stateRoot, name)) : [];
const stateMessageIds = [];
const dbByDir = new Map();
for (const dir of dirs) {
  const dbName = readdirSync(dir).find((name) => /^agent-\d+\.db$/.test(name));
  if (!dbName) continue;
  let db;
  try { db = new Database(path.join(dir, dbName), { readonly: true, fileMustExist: true }); } catch { continue; }
  dbByDir.set(dir, db);
  try {
    for (const row of db.prepare('SELECT wecom_message_id FROM agent_requests').all()) stateMessageIds.push(row.wecom_message_id);
  } catch { /* 库形状不合：如实缺席 */ }
}
if (!existsSync(runtimeDir)) {
  console.error(`找不到探针报告目录：${runtimeDir}（先跑 run-probe-step37.mjs）`);
  process.exit(2);
}
const probeReports = readdirSync(runtimeDir).filter((name) => name.startsWith('probe-') && name.endsWith('.json'));
const scored = probeReports.map((name) => {
  const file = path.join(runtimeDir, name);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return { name, file, score: -1, parsed: null }; }
  const ids = (parsed.results ?? []).flatMap((row) => (row.turns ?? []).map((turn) => turn.messageId));
  const score = ids.filter((id) => stateMessageIds.includes(id)).length;
  return { name, file, score, parsed };
}).sort((a, b) => b.score - a.score);
const report = scored.find((entry) => entry.parsed && (entry.parsed.results ?? []).some((row) => row.id === caseId));
if (!report) {
  console.error(`.runtime 里没有含用例 ${caseId} 的探针报告——先用 run-probe-step37.mjs --only ${caseId} 跑探针`);
  process.exit(1);
}
const caseResult = report.parsed.results.find((row) => row.id === caseId);
const turns = caseResult.turns ?? [];
const turnMessageIds = turns.map((turn) => turn.messageId).filter(Boolean);
let stateDir = null;
let db = null;
let bestOverlap = -1;
for (const [dir, candidateDb] of dbByDir) {
  let ids = [];
  try { ids = candidateDb.prepare('SELECT wecom_message_id FROM agent_requests').all().map((row) => row.wecom_message_id); } catch { /* 缺席 */ }
  const overlap = ids.filter((id) => turnMessageIds.includes(id)).length;
  if (overlap > bestOverlap) { bestOverlap = overlap; stateDir = dir; db = candidateDb; }
}

// ── 夹具声明（gateway / root 都从 cases.yaml 的用例声明出发，不另立名单）─────────────
// 夹具 root/gateway 住在 cases.yaml 顶层的 fixtures 块（case 条目只带夹具名字）：同一个文件、
// 同一份真相，这里按名字取一次，不在脚本里另抄 root 或网关名。
const CASES_PATH = path.join(worktree, 'scripts', 'eval', 'cases.yaml');
const casesDoc = parseYaml(readFileSync(CASES_PATH, 'utf8'));
const spec = loadCases().find((row) => row.id === caseId);
const fixtureName = spec?.fixture?.name ?? argValue('--fixture') ?? 'dummy-platform';
const fixtureDecl = casesDoc?.fixtures?.[fixtureName] ?? {};
if (!fixtureDecl.root || !fixtureDecl.gateway) {
  console.error(`cases.yaml 的 fixtures.${fixtureName} 缺 root/gateway 声明`);
  process.exit(2);
}
const fixtureRoot = path.resolve(worktree, String(fixtureDecl.root));
const declaredGateway = String(fixtureDecl.gateway);
/** 同一个可执行文件的全部别名（fixture 的 bin/generic 是 bin/dummy 的软链）。 */
function gatewayAliases(fixtureDir, gateway) {
  const names = new Set([gateway]);
  try {
    const declared = realpathSync(path.join(fixtureDir, gateway));
    const binDir = path.dirname(path.join(fixtureDir, gateway));
    for (const entry of readdirSync(binDir)) {
      const candidate = path.join(binDir, entry);
      try { if (realpathSync(candidate) === declared) names.add(path.relative(fixtureDir, candidate)); } catch { /* 断链跳过 */ }
    }
  } catch { /* 夹具不在场：只用声明名 */ }
  return [...names];
}
const gateways = gatewayAliases(fixtureRoot, declaredGateway);

// ── 声明与确认记录 ────────────────────────────────────────────────────────────
const stateFileCandidates = [];
if (stateDir) {
  stateFileCandidates.push(stateDir);
  for (const entry of readdirSync(stateDir)) {
    const child = path.join(stateDir, entry);
    if (entry.startsWith('case-') && existsSync(child)) stateFileCandidates.push(child);
  }
}
function readStateFile(name) {
  for (const dir of stateFileCandidates) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    }
  }
  return null;
}
const plansFile = readStateFile('plans.json');
const declarations = Object.values(plansFile?.plans ?? {}).map((plan) => ({
  planId: plan.id ?? '',
  calls: Array.isArray(plan.calls) ? plan.calls : [],
})).filter((row) => row.planId);
const confirmations = (() => {
  if (!db) return [];
  try {
    return db.prepare("SELECT plan_id, resolved_at FROM plan_confirmation_resolutions WHERE resolution = 'confirmed' ORDER BY resolved_at").all()
      .map((row) => ({ at: row.resolved_at, planId: row.plan_id }));
  } catch { return []; }
})();

// ── 判定 ─────────────────────────────────────────────────────────────────────
const semantics = await loadOperationSemantics(fixtureRoot, declaredGateway);
const specs = await loadOperationArgSpecs(fixtureRoot, declaredGateway);
const verdict = judgeShellBypass({
  gateways,
  turns: turns.map((turn, index) => ({
    index,
    gateRows: Array.isArray(turn.gateRows) ? turn.gateRows : [],
    executionRows: Array.isArray(turn.execution) ? turn.execution : [],
  })),
  declarations,
  confirmations,
  operationSemantics: semantics,
  operationArgsSpecs: specs,
});

// ── 呈现 ─────────────────────────────────────────────────────────────────────
console.log(`[B3] case=${caseId} report=${report.name} stateDir=${stateDir ?? '(未配对)'} gateways=${gateways.join(',')}`);
console.log(`[B3] declarations=${declarations.length} confirmations=${confirmations.length} bashRows=${verdict.rows.length}`);
console.log(`[B3] verdict=${verdict.verdict} c1=${verdict.criteria.c1} c2=${verdict.criteria.c2} c3=${verdict.criteria.c3} c4=${verdict.criteria.c4} T5=${verdict.reconciliation.verdict}`);
for (const note of verdict.criteria.notes) console.log(`[B3] note: ${note}`);
for (const row of verdict.rows) {
  console.log(`[B3] ${row.release.padEnd(28)} turn=${row.turn} form=${row.form} tier=${row.tier} decl=${row.declaration} recorded=${row.recordedAs} :: ${row.command.slice(0, 120)}`);
}
for (const item of verdict.writeFaceExecutions) console.log(`[B3] writeFaceExec turn=${item.turn} mode=${item.mode} script=${item.script} planId=${item.planId ?? ''}`);
for (const item of verdict.stateTouches) console.log(`[B3] stateTouch turn=${item.turn} :: ${item.command.slice(0, 120)}`);

const outFile = path.join(out, 'shell-bypass-criteria.json');
writeFileSync(outFile, `${JSON.stringify({
  caseId,
  report: report.name,
  stateDir,
  gateways,
  out: verdict,
}, null, 2)}\n`);
console.log(`[B3] wrote ${outFile}`);
process.exit(verdict.verdict === 'red' ? 1 : 0);
