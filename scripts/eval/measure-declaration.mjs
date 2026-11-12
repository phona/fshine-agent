#!/usr/bin/env node
/**
 * 申报契约遵循测量（workflow 用例 C1 / 仓内 id P1）：探针日志 + 逐轮回复 → 绿/红/灰 verdict。
 *
 * 只读探针自己的产物，不改任何实现：
 *   · <out>/probe.log          —— 宿主埋点原文（**route_declaration_invalid 的唯一来源**：
 *      该事件只在宿主 stdout console.warn 埋点，落不进 tool_calls 表，已核 agent-*.db）；
 *   · <root>/.runtime/probe-*.json —— 逐轮戳的 reply 投影（回复面判据②）。
 *
 * 判据本体在 scripts/eval/declaration-criteria.ts（judgeDeclarationContract：重试有界 /
 * 回合收口 / 回复面空洞话术 / 证据完整性），本脚本只做证据装配与呈现。消息条数从
 * cases.yaml 同一条用例的 messages 读——"用例跑完了吗"是语料事实，不另写一份在测量脚本里。
 *
 * 用法：
 *   node --import tsx scripts/eval/measure-declaration.mjs --root <worktree> --out <run outdir>
 *     [--case P1] [--report <probe json>]
 * 退出码（用户裁定 2026-11-12；映射唯一出处 scripts/eval/exit-codes.ts）：
 *   0 = 绿（判据全过）｜2 = 红（有违例）｜3 = 灰/异常（不可判：日志/报告缺、证据解析不出、用法错误）
 * 输出：stdout 人读摘要 + <out>/declaration-criteria.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const caseId = argValue('--case') ?? 'P1';
if (!root || !out) {
  console.error('用法: node --import tsx scripts/eval/measure-declaration.mjs --root <worktree> --out <run outdir> [--case P1] [--report <probe json>]');
  process.exit(exitCodeFor('inconclusive')); // 用法/环境错误：无法得出有效判定
}

const { judgeDeclarationContract, declarationCriteriaSummary } = await import(pathToFileURL(
  path.join(root, 'scripts/eval/declaration-criteria.ts'),
).href);
const { loadCases } = await import(pathToFileURL(
  path.join(root, 'scripts/eval/cases.ts'),
).href);

// ── 探针日志（runner 的产物；每次 run 独占一个 out 目录） ────────────────────────
const logPath = path.join(out, 'probe.log');
if (!existsSync(logPath)) {
  console.error(`灰：找不到探针日志 ${logPath}——证据缺席，不判绿（先跑 run-probe-step37.mjs）`);
  process.exit(exitCodeFor('inconclusive'));
}
const logText = readFileSync(logPath, 'utf8');

// ── 探针报告（逐轮 reply）。不指定就取 <root>/.runtime 里含本用例的最新一份 ──
const spec = loadCases().find((item) => item.id === caseId);
if (!spec) {
  console.error(`灰：cases.yaml 里没有用例 ${caseId}`);
  process.exit(exitCodeFor('inconclusive'));
}
const expectedTurns = spec.messages.length;

function pickReport() {
  const explicit = argValue('--report');
  if (explicit) return explicit;
  const runtimeDir = path.join(root, '.runtime');
  if (!existsSync(runtimeDir)) return undefined;
  const candidates = readdirSync(runtimeDir)
    .filter((name) => /^probe-.*\.json$/.test(name))
    .map((name) => path.join(runtimeDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.results) && parsed.results.some((row) => row?.id === caseId)) return file;
    } catch { /* 读不动就试下一份 */ }
  }
  return undefined;
}

const reportPath = pickReport();
let turns = [];
let reportNote = '';
if (!reportPath) {
  reportNote = `（灰源）找不到含 ${caseId} 的探针报告——回复面判据②在本轮不判（回合收口与计数面仍判）`;
} else {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const row = report.results.find((item) => item?.id === caseId);
    turns = (row?.turns ?? []).map((turn) => ({
      reply: typeof turn?.reply === 'string' ? turn.reply : '',
      ...(typeof turn?.requestId === 'string' ? { requestId: turn.requestId } : {}),
    }));
    reportNote = `探针报告 ${reportPath}`;
  } catch (error) {
    reportNote = `（灰源）探针报告读不动：${error instanceof Error ? error.message : String(error)}`;
  }
}

const verdict = judgeDeclarationContract({ logText, turns, expectedTurns, caseId });

const lines = [
  ...declarationCriteriaSummary(verdict),
  `  证据：${reportNote}`,
];
if (!verdict.evidence.sectionFound) {
  lines.push(`  · 日志里没有 ${caseId} 的段——请确认跑的是 --only ${caseId}（或给了含它的日志）`);
}
for (const line of lines) console.log(line);

mkdirSync(out, { recursive: true });
const artifact = path.join(out, 'declaration-criteria.json');
writeFileSync(artifact, JSON.stringify({ verdict, logPath, reportPath: reportPath ?? null, at: new Date().toISOString() }, null, 2), 'utf8');
console.log(`判据产物 ${artifact}`);

if (verdict.outcome === 'inconclusive') process.exit(exitCodeFor('inconclusive'));
process.exit(exitCodeFor(verdict.ok ? 'pass' : 'fail'));
