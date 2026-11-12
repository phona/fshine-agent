#!/usr/bin/env node
/**
 * S4 测量：把**任意一次探针跑**（真实模型 + mock 执行器）的用户面过一遍 S4 判据。
 *
 * 为什么是"任意一次"：用例 S4 的构造面就是「任意任务执行，含失败路径」——它不该绑在某条
 * 消息脚本上。本脚本读探针报告 `.runtime/probe-*.json`（探针自己落的产物，只读不改），
 * 对每个用例的每一轮取两个用户面：
 *   · 回复面   = `turn.reply`（模型终稿，已经过 reply-exit 出厂链）；
 *   · 通知面   = `turn.notices`（`计划通知：…` 帧，已经过 formatPlanMessage 的执行语言删除）。
 * 判据本体在 scripts/eval/execution-leak-criteria.ts（与用例同一份实现——测量与用例判据
 * 必须同源，否则"用例绿、测量红"这种分歧没人能解释）。
 *
 * 用法：
 *   node --import tsx scripts/eval/measure-execution-leak.mjs --root <worktree> --out <run outdir> [--only A2,U1]
 *   缺省挑 `.runtime/probe-*.json` 里最新的那一份；`--report <path>` 可显式指定。
 *
 * 输出：stdout 人读摘要 + `<out>/execution-leak-criteria.json`（逐面逐条证据）。
 * 退出码（用户裁定 2026-11-12；映射唯一出处 scripts/eval/exit-codes.ts）：
 *   有 hard 命中（判据红）= 2（可当门用）；无 = 0；没报告可读/用法错误 = 3（不把"没跑"当"通过"）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 退出码映射唯一出处（用户裁定 2026-11-12）：与本脚本同目录，不随 --root 走。
const { exitCodeFor } = await import(new URL('./exit-codes.ts', import.meta.url).href);

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const root = argValue('--root');
const out = argValue('--out');
if (!root || !out) {
  console.error('用法: node --import tsx scripts/eval/measure-execution-leak.mjs --root <worktree> --out <run outdir> [--only A2,U1] [--report .runtime/probe-xxx.json]');
  process.exit(exitCodeFor('inconclusive')); // 用法/环境错误：无法得出有效判定
}
const only = (argValue('--only') ?? '').split(',').map((id) => id.trim()).filter(Boolean);

const { judgeExecutionLeakSurfaces, renderExecutionLeakReport } = await import(pathToFileURL(
  path.join(root, 'scripts/eval/execution-leak-criteria.ts'),
).href);

// ── 选报告：显式 --report > .runtime 里 mtime 最新的一份 ─────────────────────
function pickReport() {
  const explicit = argValue('--report');
  if (explicit) {
    const full = path.isAbsolute(explicit) ? explicit : path.join(root, explicit);
    return existsSync(full) ? full : null;
  }
  const runtimeDir = path.join(root, '.runtime');
  if (!existsSync(runtimeDir)) return null;
  const candidates = readdirSync(runtimeDir)
    .filter((name) => name.startsWith('probe-') && name.endsWith('.json'))
    .map((name) => path.join(runtimeDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

const reportPath = pickReport();
if (!reportPath) {
  console.error(`没有可读的探针报告（找的是 <root>/.runtime/probe-*.json，root=${root}）——先跑 run-probe-step37.mjs，别把"没跑"当"通过"`);
  process.exit(exitCodeFor('inconclusive'));
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`探针报告读不了（${reportPath}）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(exitCodeFor('inconclusive'));
}
const results = (Array.isArray(report.results) ? report.results : []).filter((row) => only.length === 0 || only.includes(row.id));
if (results.length === 0) {
  console.error(`报告 ${path.basename(reportPath)} 里没有可判定的用例行（--only=${only.join(',') || '(未设)'}）—` +
    '探针可能没跑到该用例，判据不把缺席当干净。');
  process.exit(exitCodeFor('inconclusive'));
}

// ── 组装用户面（回复面 + 通知面） ────────────────────────────────────────────
const surfaces = [];
for (const row of results) {
  const turns = Array.isArray(row.turns) ? row.turns : [];
  turns.forEach((turn, index) => {
    if (typeof turn?.reply === 'string' && turn.reply.trim()) {
      surfaces.push({ kind: 'reply', caseId: row.id, turn: index, text: turn.reply });
    }
    const notices = Array.isArray(turn?.notices) ? turn.notices : [];
    for (const notice of notices) {
      if (typeof notice === 'string' && notice.trim()) {
        surfaces.push({ kind: 'notification', caseId: row.id, turn: index, text: notice });
      }
    }
  });
}

const verdict = judgeExecutionLeakSurfaces(surfaces);
console.log(`[S4 测量] root=${root}`);
console.log(`[S4 测量] report=${reportPath}`);
console.log(`[S4 测量] cases=${results.map((row) => row.id).join(',')}`);
console.log(renderExecutionLeakReport(verdict, 400));

const outDir = path.resolve(out);
const payload = {
  root,
  report: reportPath,
  at: new Date().toISOString(),
  only,
  summary: {
    surfaces: verdict.surfaces.length,
    hard: verdict.surfaces.reduce((sum, surface) => sum + surface.hardCount, 0),
    soft: verdict.surfaces.reduce((sum, surface) => sum + surface.findings.filter((f) => f.severity === 'soft').length, 0),
    hardByClass: verdict.hardByClass,
    passed: verdict.passed,
  },
  surfaces: verdict.surfaces.map((surface) => ({
    caseId: surface.caseId,
    turn: surface.turn,
    kind: surface.kind,
    text: surface.text,
    findings: surface.findings,
  })),
};
writeFileSync(path.join(outDir, 'execution-leak-criteria.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`[S4 测量] 写出 ${path.join(outDir, 'execution-leak-criteria.json')}`);
process.exit(exitCodeFor(verdict.passed ? 'pass' : 'fail'));
