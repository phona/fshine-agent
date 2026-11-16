#!/usr/bin/env node
/**
 * U1 补丁前后对照（只读两份重放证据，零模型调用）。
 *
 * 用法：tsx scripts/eval/pi152-stageB/compare-u1.ts --before=<dir> --after=<dir> [--out=<file>]
 * 判据见 .runtime/pi152-stageU1/prereg.md §6（F1–F7）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface HttpRec { turn: number; isSummary: boolean; maxTokens: number | null; status?: number; msgCount: number | null }
interface TurnRec {
  turn: number; replyLen: number; reply: string; error: string | null;
  compactionBefore: number; compactionAfter: number; callBefore: number; callAfter: number;
}
interface EventRec { turn: number; type: string; reason?: string; status?: string; errorMessage?: string; willRetry?: boolean }
interface CallRec {
  turn: number; callIndex: number; isSummary: boolean; stopReason: string | null;
  error: string | null; reqMaxTokens: number | null;
  usage: { input: number; output: number; totalTokens: number; reasoning: number } | null;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}
const jsonl = <T>(file: string): T[] =>
  readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as T);
const json = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

const before = arg('before');
const after = arg('after');
if (before === undefined || after === undefined) throw new Error('用法：--before=<dir> --after=<dir>');

function load(dir: string) {
  return {
    http: jsonl<HttpRec>(path.join(dir, 'http.jsonl')),
    turns: json<TurnRec[]>(path.join(dir, 'turns.json')),
    events: jsonl<EventRec>(path.join(dir, 'events.jsonl')),
    calls: jsonl<CallRec>(path.join(dir, 'model-calls.jsonl')),
  };
}
const B = load(before);
const A = load(after);

const mainMaxByTurn = (http: HttpRec[], turn: number) =>
  http.filter((h) => !h.isSummary && h.turn === turn).map((h) => h.maxTokens ?? null);
const summaryMaxByTurn = (http: HttpRec[], turn: number) =>
  http.filter((h) => h.isSummary && h.turn === turn).map((h) => h.maxTokens ?? null);
const eventsByTurn = (events: EventRec[], turn: number) => events.filter((e) => e.turn === turn);
const callByTurn = (calls: CallRec[], turn: number) => calls.filter((c) => !c.isSummary && c.turn === turn);
const turnRec = (turns: TurnRec[], turn: number) => turns.find((t) => t.turn === turn);

// 补丁前被压到 1 token 的回合（原 12 次）
const clampedTurns = [...new Set(B.http.filter((h) => !h.isSummary && (h.maxTokens ?? 0) <= 1).map((h) => h.turn))];

const rows = clampedTurns.map((turn) => {
  const afterTurn = turnRec(A.turns, turn);
  const events = eventsByTurn(A.events, turn);
  return {
    turn,
    before: {
      mainMaxTokens: mainMaxByTurn(B.http, turn),
      summaryMaxTokens: summaryMaxByTurn(B.http, turn),
      replyLen: turnRec(B.turns, turn)?.replyLen ?? null,
      stopReasons: callByTurn(B.calls, turn).map((c) => c.stopReason),
      compaction: eventsByTurn(B.events, turn).map((e) => `${e.type}:${e.reason ?? ''}:${e.status ?? ''}`),
    },
    after: {
      mainMaxTokens: mainMaxByTurn(A.http, turn),
      mainStatuses: A.http.filter((h) => !h.isSummary && h.turn === turn).map((h) => h.status),
      summaryMaxTokens: summaryMaxByTurn(A.http, turn),
      stopReasons: callByTurn(A.calls, turn).map((c) => c.stopReason),
      outputs: callByTurn(A.calls, turn).map((c) => c.usage?.output ?? null),
      replyLen: afterTurn?.replyLen ?? null,
      replyEmpty: afterTurn === undefined ? null : afterTurn.reply.trim() === '',
      error: afterTurn?.error ?? null,
      compaction: events.map((e) => `${e.type}:${e.reason ?? ''}:${e.status ?? ''}${e.errorMessage ? `:${e.errorMessage}` : ''}`),
    },
  };
});

// F1：补丁后主请求不得落在 1..1023
const afterMainCaps = A.http.filter((h) => !h.isSummary).map((h) => h.maxTokens ?? null);
const f1Violations = A.http.filter((h) => !h.isSummary && h.maxTokens !== null && h.maxTokens > 0 && h.maxTokens < 1024)
  .map((h) => ({ turn: h.turn, maxTokens: h.maxTokens }));
const f1 = f1Violations.length === 0;

// F2：补丁后 maxTokens=1024 的请求，补丁前同 turn 的 room 推导值应 ≤1024
const f1024 = A.http.filter((h) => !h.isSummary && h.maxTokens === 1024);
const f2Suspects = f1024.filter((h) => {
  const beforeCaps = mainMaxByTurn(B.http, h.turn);
  return beforeCaps.length > 0 && beforeCaps.every((c) => (c ?? 0) > 1024);
});
const f2 = f2Suspects.length === 0;

// F4：空回复必须伴随 overflow 事件或有显式错误
const afterEmpty = A.turns.filter((t) => String(t.reply).trim() === '');
const silent = afterEmpty.filter((t) => {
  const events = eventsByTurn(A.events, t.turn).filter((e) => e.type === 'compaction_start' && e.reason === 'overflow');
  const err = typeof t.error === 'string' && t.error.trim() !== '';
  return events.length === 0 && !err;
});
const f4 = silent.length === 0;

const httpErrors = A.http.filter((h) => typeof h.status === 'number' && h.status >= 400)
  .map((h) => ({ turn: h.turn, isSummary: h.isSummary, status: h.status }));

const report = {
  before, after,
  clampedTurns,
  rows,
  checks: {
    f1_noDegenerateMainCaps: { pass: f1, violations: f1Violations, allMainCaps: afterMainCaps },
    f2_noUnneededAmplification: { pass: f2, suspects: f2Suspects, countOf1024: f1024.length },
    f4_boundedDestination: { pass: f4, emptyTurns: afterEmpty.map((t) => t.turn), silentTurns: silent.map((t) => t.turn) },
    f6_httpErrors: httpErrors,
  },
  totals: {
    before: { mainCalls: B.http.filter((h) => !h.isSummary).length, summaryCalls: B.http.filter((h) => h.isSummary).length,
      emptyTurns: B.turns.filter((t) => String(t.reply).trim() === '').length },
    after: { mainCalls: A.http.filter((h) => !h.isSummary).length, summaryCalls: A.http.filter((h) => h.isSummary).length,
      emptyTurns: afterEmpty.length },
  },
};

const out = arg('out');
if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
