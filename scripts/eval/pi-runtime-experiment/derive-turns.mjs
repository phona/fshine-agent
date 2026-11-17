#!/usr/bin/env node
/**
 * 事后重算：用已落盘的证据（turns.json 的调用区间 + model-calls.jsonl）重算逐回合「是否有用户可见回复」。
 *
 * 为什么需要：replay.mjs 首版用「session.messages 最后一条 assistant」取回复；Pi 对
 * recoverable-length 的响应会把它从 session.messages 里省略，导致上一回合的文本被误当成
 * 本回合回复。修复后的判据是「本回合最后一条主调用 stopReason=stop 且 output>1」，并与
 * 修复后脚本写下的 replyByCallRule 对照。本脚本只读证据、不改判据、不重跑模型。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = path.join(REPO_ROOT, '.runtime', 'pi-runtime-experiment', process.argv[2] ?? 'A');
const turns = JSON.parse(readFileSync(path.join(dir, 'turns.json'), 'utf8'));
const calls = readFileSync(path.join(dir, 'model-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const derived = turns.map((t) => {
  const slice = calls.filter((c) => c.callIndex >= t.callIndexBefore && c.callIndex < t.callIndexAfter);
  const mainCalls = slice.filter((c) => c.isSummary !== true && c.kind === 'stream');
  const last = mainCalls.at(-1);
  const producedReply = last !== undefined && last.stopReason === 'stop' && (last.usage?.output ?? 0) > 1;
  return {
    turn: t.index,
    callRange: [t.callIndexBefore, t.callIndexAfter],
    lastMainCall: last?.callIndex ?? null,
    lastMainStopReason: last?.stopReason ?? null,
    lastMainOutput: last?.usage?.output ?? null,
    producedReply,
    harnessSaidEmpty: t.replyEmpty === true,
    recordedReply: producedReply ? (t.reply ?? '').slice(0, 200) : '',
  };
});

const out = {
  scenario: path.basename(dir),
  note: 'Mechanical re-derivation from recorded evidence; no model calls.',
  turns: derived,
  emptyTurns: derived.filter((d) => !d.producedReply).map((d) => d.turn),
  nonEmptyTurns: derived.filter((d) => d.producedReply).map((d) => d.turn),
  harnessEmptyTurns: turns.filter((t) => t.replyEmpty === true).map((t) => t.index),
  harnessUnderCount: derived.filter((d) => !d.producedReply && d.harnessSaidEmpty === false).map((d) => d.turn),
};
writeFileSync(path.join(dir, 'turns.derived.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ scenario: out.scenario, emptyTurns: out.emptyTurns, harnessEmptyTurns: out.harnessEmptyTurns, harnessUnderCount: out.harnessUnderCount }, null, 2));
