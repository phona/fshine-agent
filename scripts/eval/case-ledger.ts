#!/usr/bin/env ts-node
// scripts/eval/case-ledger.ts
// 扫 .runtime/probe-*.json 与 data/acceptance-report-*.json，按用例聚合统计，输出 out/case-ledger.md。
// .runtime 是 gitignored 的，文件缺失时宽容跳过。

import { mkdirSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface ProbeResult {
  id: string;
  group: string;
  intent: string;
  turns: Array<{
    text: string;
    reply: string;
    ms: number;
    notices: unknown[];
    calls: number;
  }>;
  /** 执行层审计行总数（2026-11-08 换源：原 ledgerCalls 读宿主 EXECUTION_PLAN_STATE 账本，
   * 现为数 EXECUTION_AUDIT_PATH 的审计行，被拒行也数）。旧字段名随源退役。 */
  platformCalls: number;
  /** 其中被执行层门拒绝的行数。 */
  refusedCalls?: number;
  notes: string[];
  dims: Record<string, number>;
  unclassifiedNotes: number;
  ok: boolean;
  tokens?: {
    main: { total: number };
    worker: { total: number };
  };
}

interface ProbeFile {
  at: string;
  results: ProbeResult[];
}

interface AcceptanceEntry {
  id: string;
  conversationId: string;
  durationMs: number;
  leakFlags: string[];
  notices: unknown;
  planRejects: unknown;
  [key: string]: unknown;
}

type CaseKey = string;
type CaseSource = 'probe' | 'acceptance';

interface CaseStats {
  source: CaseSource;
  runs: number;
  platformCalls: number;
  tokenSum: number;
  tokenSkipped: number;
  notes: Set<string>;
  nonOk: number;
}

function sumTokens(r: ProbeResult): number | undefined {
  if (!r.tokens) return undefined;
  const mainTotal = typeof r.tokens.main?.total === 'number' ? r.tokens.main.total : 0;
  const workerTotal = typeof r.tokens.worker?.total === 'number' ? r.tokens.worker.total : 0;
  return mainTotal + workerTotal;
}

async function collectProbeFiles(dir: string): Promise<ProbeFile[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files: ProbeFile[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('probe-') || !entry.endsWith('.json')) continue;
    const full = join(dir, entry);
    try {
      const text = await (await import('node:fs/promises')).readFile(full, 'utf-8');
      const parsed = JSON.parse(text) as ProbeFile;
      if (Array.isArray(parsed.results)) files.push(parsed);
    } catch {
      // skip unreadable / unparseable files
    }
  }
  return files;
}

async function collectAcceptanceFiles(dir: string): Promise<AcceptanceEntry[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const acc: AcceptanceEntry[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('acceptance-report-') || !entry.endsWith('.json')) continue;
    const full = join(dir, entry);
    try {
      const text = await (await import('node:fs/promises')).readFile(full, 'utf-8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && typeof item.id === 'string') {
            acc.push(item as AcceptanceEntry);
          }
        }
      }
    } catch {
      // skip
    }
  }
  return acc;
}

function aggregateProbes(files: ProbeFile[]): Map<CaseKey, CaseStats> {
  const map = new Map<CaseKey, CaseStats>();
  for (const file of files) {
    for (const r of file.results) {
      const key = r.id;
      let stats = map.get(key);
      if (!stats) {
        stats = { source: 'probe', runs: 0, platformCalls: 0, tokenSum: 0, tokenSkipped: 0, notes: new Set(), nonOk: 0 };
        map.set(key, stats);
      }
      stats.runs += 1;
      stats.platformCalls += typeof r.platformCalls === 'number' ? r.platformCalls : 0;
      const tokens = sumTokens(r);
      if (tokens === undefined) {
        stats.tokenSkipped += 1;
      } else {
        stats.tokenSum += tokens;
      }
      for (const note of r.notes) {
        if (note) stats.notes.add(note);
      }
      if (r.ok !== true) stats.nonOk += 1;
    }
  }
  return map;
}

function aggregateAcceptance(entries: AcceptanceEntry[]): Map<CaseKey, CaseStats> {
  const map = new Map<CaseKey, CaseStats>();
  for (const entry of entries) {
    // 取 id 前缀（"5.1" → "5"）作为用例键；找不到点则用完整 id
    const dot = entry.id.indexOf('.');
    const key = dot > 0 ? entry.id.slice(0, dot) : entry.id;
    let stats = map.get(key);
    if (!stats) {
      stats = { source: 'acceptance', runs: 0, platformCalls: 0, tokenSum: 0, tokenSkipped: 0, notes: new Set(), nonOk: 0 };
      map.set(key, stats);
    }
    stats.runs += 1;
    // acceptance 报告无平台调用数字段，也不参与 token / ok 统计
    stats.tokenSkipped += 1; // 全量跳过，仅计数
    const flags = Array.isArray(entry.leakFlags) ? entry.leakFlags : [];
    for (const flag of flags) {
      if (flag) stats.notes.add(flag);
    }
    // 无 ok 字段，不记 nonOk
  }
  return map;
}

function renderMarkdown(probeMap: Map<CaseKey, CaseStats>, accMap: Map<CaseKey, CaseStats>): string {
  const lines: string[] = [];
  lines.push('# Case Ledger');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Probe 用例聚合');
  lines.push('');
  lines.push('| 用例 | 跑次数 | 平台调用合计 | token 合计 | token 跳过跑次 | 不同 note 数 | 非 ok 次数 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const probeKeys = Array.from(probeMap.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of probeKeys) {
    const s = probeMap.get(key)!;
    lines.push(
      `| ${key} | ${s.runs} | ${s.platformCalls} | ${s.tokenSum} | ${s.tokenSkipped} | ${s.notes.size} | ${s.nonOk} |`
    );
  }
  if (probeKeys.length === 0) {
    lines.push('| （无数据） | | | | | | |');
  }
  lines.push('');
  lines.push('## Acceptance Report 聚合');
  lines.push('');
  lines.push('acceptance-report 使用独立编号（如 1.1 / 5.3），无平台调用、token、ok 字段；以下按 id 前缀聚合。');
  lines.push('');
  lines.push('| 用例前缀 | 跑次数 | token 跳过跑次 | leakFlags 数 |');
  lines.push('| --- | ---: | ---: | ---: |');
  const accKeys = Array.from(accMap.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of accKeys) {
    const s = accMap.get(key)!;
    lines.push(`| ${key} | ${s.runs} | ${s.tokenSkipped} | ${s.notes.size} |`);
  }
  if (accKeys.length === 0) {
    lines.push('| （无数据） | | | |');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('说明：');
  lines.push('- Probe 数据来自 `.runtime/probe-*.json`，按 `results[].id` 聚合。');
  lines.push('- Acceptance 数据来自 `data/acceptance-report-*.json`，按 `id` 前缀聚合（如 `5.1` → `5`）。');
  lines.push('- token 合计仅统计 `tokens.main.total + tokens.worker.total`，缺失该字段的跑次计入"token 跳过跑次"。');
  lines.push('- 非 ok 次数 = `ok !== true` 的跑次。');
  return lines.join('\n');
}

async function main() {
  const probeFiles = await collectProbeFiles(join(process.cwd(), '.runtime'));
  const accEntries = await collectAcceptanceFiles(join(process.cwd(), 'data'));
  const probeMap = aggregateProbes(probeFiles);
  const accMap = aggregateAcceptance(accEntries);
  const md = renderMarkdown(probeMap, accMap);
  const outDir = join(process.cwd(), 'out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'case-ledger.md');
  await (await import('node:fs/promises')).writeFile(outPath, md, 'utf-8');
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error('case-ledger failed:', err);
  process.exit(1);
});
