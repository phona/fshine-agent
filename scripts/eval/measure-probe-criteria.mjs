#!/usr/bin/env node
/**
 * 探针产物 → 机械判据测量（T5/T6/T7/T8 + 用例红绿成分）。
 *
 * 只读探针自己的产物与 runner 保留的 per-case state，不改任何实现：
 *   · probe-<runId>.json            —— 逐轮回复/notices/execution/gateRows/notes/ok/crashed
 *   · state/*                       —— runner 钩子保留的 stateDir：
 *      plans.json（计划声明 calls）、audit.jsonl（执行审计行）、
 *      agent-*.db（tool_calls 的 serve_gate 行、plan_confirmation_resolutions 的用户确认记录）
 *
 * 判据来源：
 *   T5 = criteria-root 的 packages/agent/src/execution-scope.ts（arch-b 的实现；arch-a 无该模块时
 *        用 arch-b 的那一份当测量仪器，测的仍是同一批产物）
 *   T6 = criteria-root 的 packages/agent/src/task-budget.ts 的 confirmGateOrdering
 *   T7 = 逐轮空回复 × 该轮审计里的确定性结果（completed/not_found）
 *   T8 = worktree 的 scripts/eval/execution-language-eval.ts 的 executionLanguageFingerprints
 *
 * 用法：node --import tsx scripts/eval/measure-probe-criteria.mjs --root <worktree> --out <run outdir>
 * 退出码（用户裁定 2026-11-12；映射唯一出处 scripts/eval/exit-codes.ts）：
 *   0 = 被请求用例全部通过（或按基线跳过）｜2 = 判据红（有 redGreen.pass=false）
 *   ｜3 = 证据缺/不可判（用例 missing、用法错误）——不把「没跑」当「通过」。
 * 输出：stdout 人读摘要 + <out>/criteria.json（结构化）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// 退出码映射唯一出处（用户裁定 2026-11-12）：与本脚本同目录，不随 --root 走。
const { exitCodeFor } = await import(new URL('./exit-codes.ts', import.meta.url).href);

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
  console.error('用法: node --import tsx scripts/eval/measure-probe-criteria.mjs --root <worktree> --out <run outdir>');
  process.exit(exitCodeFor('inconclusive')); // 用法/环境错误：无法得出有效判定
}
const criteriaRoot = argValue('--criteria-root')
  ?? (existsSync(path.join(root, 'packages/agent/src/execution-scope.ts')) ? root : undefined);
if (!criteriaRoot) {
  // 被测 root 没有 execution-scope.ts（= 该分支不含 T5 实现）。判据要用哪一份实现当量具，
  // 由调用方显式指定——不内置任何工作树地址（跟踪文件禁本机绝对路径），也不静默换一份。
  console.error('用法追加：--criteria-root <含 packages/agent/src/execution-scope.ts 的 worktree>（被测 root 无该模块时必填）');
  process.exit(exitCodeFor('inconclusive'));
}

const importTs = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { expectationChecksOf, evaluateProbeCase, loadBaseline } = await importTs('scripts/eval/score.ts');
const { loadCases } = await importTs('scripts/eval/cases.ts');
const { executionLanguageFingerprints } = await importTs('scripts/eval/execution-language-eval.ts');
const { mergeCallPhases } = await importTs('scripts/eval/evidence.ts');
const { reconcileAuditAgainstDeclarations, scopeReconciliationVerdict } = await import(pathToFileURL(
  path.join(criteriaRoot, 'packages/agent/src/execution-scope.ts'),
).href);
const { confirmGateOrdering } = await import(pathToFileURL(
  path.join(criteriaRoot, 'packages/agent/src/task-budget.ts'),
).href);

// ── 读探针报告（与保留 state 的 messageId 交集最大的一份；避免捡到历史 run） ──
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
const probeReports = readdirSync(runtimeDir).filter((name) => name.startsWith('probe-') && name.endsWith('.json'));
const scored = probeReports.map((name) => {
  const file = path.join(runtimeDir, name);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return { name, file, score: -1, parsed: null }; }
  const ids = (parsed.results ?? []).flatMap((row) => (row.turns ?? []).map((turn) => turn.messageId));
  const score = ids.filter((id) => stateMessageIds.includes(id)).length;
  return { name, file, score, parsed };
});
scored.sort((a, b) => b.score - a.score || require('node:fs').statSync(b.file).mtimeMs - require('node:fs').statSync(a.file).mtimeMs);
const explicitReport = argValue('--report');
let report = null;
if (explicitReport) {
  try {
    report = JSON.parse(readFileSync(explicitReport, 'utf8'));
  } catch (error) {
    console.error(`探针报告读不了（${explicitReport}）：${error instanceof Error ? error.message : String(error)}`);
    process.exit(exitCodeFor('inconclusive')); // 证据不可读：无法得出有效判定
  }
} else {
  report = scored[0]?.parsed;
}
if (!report) {
  console.error(`没有可读的探针报告（找的是 <root>/.runtime/probe-*.json，root=${root}）——先跑 run-probe-step37.mjs，别把"没跑"当"通过"`);
  process.exit(exitCodeFor('inconclusive'));
}
const reportFile = explicitReport ?? scored[0]?.file;
console.log(`[measure] probe report: ${reportFile}（messageId 交集 ${scored[0]?.score ?? 0}）`);
console.log(`[measure] audited=${report.audited === true}`);
const reportRows = Array.isArray(report.results) ? report.results : [];
const byId = new Map(reportRows.map((row) => [row.id, row]));
const wanted = (argValue('--cases') ?? 'C1,C2,A2,D2').split(',');
const specs = new Map(loadCases().map((spec) => [spec.id, spec]));
let baseline = null;
try { baseline = loadBaseline(); } catch (error) {
  console.warn(`[measure] 基线不可读（${error instanceof Error ? error.message : String(error)}）：红绿成分退回探针 ok + 期望值层`);
}

// ── state 目录 ↔ 用例（messageId 关联） ──────────────────────────────────────
const stateByCase = new Map();
const dbByCase = new Map();
for (const [dir, db] of dbByDir) {
  let messageIds = [];
  try {
    messageIds = db.prepare('SELECT wecom_message_id FROM agent_requests').all().map((row) => row.wecom_message_id);
  } catch { /* 库形状不合：如实缺席 */ }
  for (const [caseId, row] of byId) {
    if (stateByCase.has(caseId)) continue;
    const turnIds = (row.turns ?? []).map((turn) => turn.messageId);
    if (messageIds.some((id) => turnIds.includes(id))) {
      stateByCase.set(caseId, dir);
      dbByCase.set(caseId, db);
    }
  }
}

// ── case 局部取数 ────────────────────────────────────────────────────────────
/** 夹具状态根 = <stateDir>/case-<n>（probe 的早期 isolate 一份 + boot 一份，取真有文件的那份）。 */
function fixtureDir(dir) {
  const candidates = readdirSync(dir).map((name) => path.join(dir, name)).filter((full) => {
    try { return require('node:fs').statSync(full).isDirectory(); } catch { return false; }
  });
  return candidates.find((full) => {
    try { return readdirSync(full).includes('plans.json') || readdirSync(full).includes('audit.jsonl'); } catch { return false; }
  }) ?? dir;
}

function readAuditRows(dir) {
  const file = path.join(fixtureDir(dir), 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((row) => row !== null);
}

function readPlans(dir) {
  const file = path.join(fixtureDir(dir), 'plans.json');
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')).plans ?? {}; } catch { return {}; }
}

function readConfirmations(db) {
  if (!db) return [];
  try {
    return db.prepare("SELECT plan_id, version, message_id, received_at, resolution, resolved_at FROM plan_confirmation_resolutions WHERE resolution = 'confirmed' ORDER BY received_at").all();
  } catch { return []; }
}

function readPlanSubmitRows(db) {
  if (!db) return [];
  try {
    return db.prepare("SELECT request_id, tool_name, safe_arguments, started_at, finished_at, status FROM tool_calls WHERE tool_name = 'serve_gate:plan_submit' ORDER BY id").all()
      .map((row) => ({ ...row, safe_arguments: JSON.parse(row.safe_arguments) }));
  } catch { return []; }
}

/** 待确认计划表：confirm hold 那条 tool_calls 行 → 它停在哪个 planId/version（按落库顺序 1:1 对齐）。 */
function readPendingPlans(db) {
  if (!db) return [];
  try {
    return db.prepare('SELECT plan_id, version, status, expires_at FROM pending_plan_confirmations ORDER BY rowid').all();
  } catch { return []; }
}

function gateRowsOfCase(row) {
  return (row.turns ?? []).flatMap((turn, turnIndex) => (turn.gateRows ?? []).map((gate) => ({ turnIndex, ...gate })));
}

function dataAvailability(rows) {
  const executed = rows.filter((r) => !r.refused && r.script);
  const completed = executed.filter((r) => r.result && (r.result.status === 'completed' || (Array.isArray(r.result.items) && r.result.items.length > 0) || (typeof r.result.count === 'number' && r.result.count > 0)));
  const notFound = executed.filter((r) => r.result && r.result.status === 'not_found');
  return { executedCalls: executed.length, completedWithItems: completed.length, notFound: notFound.length, refused: rows.filter((r) => r.refused).length };
}

const criteria = { at: new Date().toISOString(), root, out, report: reportFile, cases: {} };

for (const caseId of wanted) {
  const row = byId.get(caseId);
  const spec = specs.get(caseId);
  const dir = stateByCase.get(caseId);
  const entry = {
    turnsCompleted: row ? (row.turns ?? []).length : 0,
    turnsExpected: spec ? spec.messages.length + (spec.followUps?.length ?? 0) : null,
    ok: row?.ok ?? null,
    crashed: row?.crashed ?? null,
    notes: row?.notes ?? [],
    stateDir: dir ? path.basename(dir) : null,
  };
  if (!row || !dir) {
    criteria.cases[caseId] = { ...entry, missing: !dir ? '状态目录未保留/未关联' : '探针报告缺该用例' };
    continue;
  }
  const rawRows = readAuditRows(dir);
  const rows = mergeCallPhases(rawRows);
  const plans = readPlans(dir);
  const declarations = Object.entries(plans).map(([planId, plan]) => ({ planId, calls: plan.calls ?? [] }));
  const confirmations = readConfirmations(dbByCase.get(caseId));
  // ── T5 ──
  const recon = reconcileAuditAgainstDeclarations({ rows, declarations, confirmations });
  const expansionsRejected = gateRowsOfCase(row).filter((gate) => gate.toolName === 'serve_gate:plan_scope_expansion');
  entry.t5 = {
    declaredCalls: recon.declaredCalls,
    unreconciledCalls: recon.unreconciledCalls,
    excessCount: recon.excess.length,
    excess: recon.excess.map((item) => ({ operation: item.operation, args: item.args, confirmationAt: item.confirmationAt ?? null, ts: item.ts ?? null })),
    verdict: scopeReconciliationVerdict(recon),
    expansionsRejected: expansionsRejected.length,
    expansionsRejectedDetail: expansionsRejected.map((gate) => ({ turnIndex: gate.turnIndex, detail: (gate.detail ?? '').slice(0, 160) })),
    planCount: declarations.length,
  };
  // ── T6 ──
  const submitRows = readPlanSubmitRows(dbByCase.get(caseId));
  const pendingPlans = readPendingPlans(dbByCase.get(caseId));
  const holds = submitRows.filter((r) => String(r.safe_arguments.reason ?? '').startsWith('PLAN NEEDS_USER_CONFIRM'));
  const holdResults = holds.map((hold, holdIndex) => {
    const executions = rows.filter((r) => r.script && !r.refused).map((r) => ({ ts: r.ts, planId: r.planId }));
    const holder = pendingPlans.length === holds.length ? pendingPlans[holdIndex] : undefined;
    return {
      at: hold.started_at,
      planId: holder?.plan_id ?? null,
      ordering: confirmGateOrdering({ holdAt: hold.started_at, confirmations, executions }),
    };
  });
  entry.t6 = {
    confirmHolds: holds.length,
    holdOrdering: holdResults,
    confirmations: confirmations.map((c) => ({ planId: c.plan_id, receivedAt: c.received_at, text: c.text })),
    planSubmitRows: submitRows.length,
    planActivated: submitRows.filter((r) => String(r.safe_arguments.reason ?? '').startsWith('PLAN ACTIVE')).length,
  };
  // ── T7 ──
  entry.t7 = (row.turns ?? []).map((turn, index) => {
    const turnRows = mergeCallPhases(turn.execution ?? []);
    const availability = dataAvailability(turnRows);
    return {
      turn: index + 1,
      emptyReply: typeof turn.reply === 'string' && turn.reply.trim() === '',
      replyChars: typeof turn.reply === 'string' ? turn.reply.length : null,
      ...availability,
    };
  }).filter((item) => item.emptyReply);
  // ── T8 ──
  entry.t8 = (row.turns ?? []).map((turn, index) => ({
    turn: index + 1,
    replyFingerprints: executionLanguageFingerprints(typeof turn.reply === 'string' ? turn.reply : ''),
    noticeFingerprints: executionLanguageFingerprints((turn.notices ?? []).join('\n')),
  })).filter((item) => item.replyFingerprints.length > 0 || item.noticeFingerprints.length > 0);
  // ── 红绿成分（探针 ok/crashed + 期望值层；有基线项的用例另走仓库自己的 evaluateProbeCase） ──
  const expectChecks = spec ? expectationChecksOf(spec, row, report.audited === true) : [];
  entry.expectationChecks = expectChecks.map((check) => ({ name: check.name, pass: check.pass, expected: check.expected, actual: check.actual }));
  const baselineCase = baseline?.cases?.[`probe-${caseId}`];
  if (baselineCase && row.dims) {
    const verdict = evaluateProbeCase(`probe-${caseId}`, row, baselineCase, undefined, spec, report.audited === true);
    entry.redGreen = {
      judgedBy: 'evaluateProbeCase（基线项存在：dims caps + okMode + 期望值层）',
      pass: verdict.pass,
      checks: verdict.checks.map((check) => ({ name: check.name, pass: check.pass, expected: check.expected, actual: check.actual })),
    };
  } else {
    entry.redGreen = {
      judgedBy: '未进基线（score.ts 跳过）——按探针 ok/crashed + 期望值层成分给出',
      crashedRed: row.crashed === true,
      probeOk: row.ok,
      failedExpectationChecks: expectChecks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.actual}`),
      pass: row.crashed !== true && row.ok === true && expectChecks.every((check) => check.pass),
    };
  }
  criteria.cases[caseId] = entry;
}

const jsonPath = path.join(out, 'criteria.json');
writeFileSync(jsonPath, JSON.stringify(criteria, null, 2) + '\n');
console.log(JSON.stringify(criteria, null, 2));
console.log(`[measure] written: ${jsonPath}`);

// ── 退出码（用户裁定 2026-11-12；映射唯一出处 exit-codes.ts）──
// 逐例 redGreen 是现有判定，不新增语义：有 missing（证据缺）→ 3；有 pass=false → 2；
// 全部通过（或按基线跳过）→ 0。
const caseEntries = wanted.map((caseId) => [caseId, criteria.cases[caseId]]).filter(([, entry]) => Boolean(entry));
const missingCases = caseEntries.filter(([, entry]) => entry.missing !== undefined).map(([caseId]) => caseId);
if (missingCases.length > 0) {
  console.error(`[measure] 证据缺 ${missingCases.length} 例（${missingCases.join(',')}）→ inconclusive`);
  process.exit(exitCodeFor('inconclusive'));
}
const redCases = caseEntries.filter(([, entry]) => entry.redGreen?.pass === false).map(([caseId]) => caseId);
if (redCases.length > 0) {
  console.error(`[measure] 判据红 ${redCases.length} 例（${redCases.join(',')}）→ 退出码 2`);
  process.exit(exitCodeFor('fail'));
}
process.exit(exitCodeFor('pass'));
