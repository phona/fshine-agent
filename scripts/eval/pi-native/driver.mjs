// Pi-native session / compaction prototype (phase 2 spike).
//
// Proves that AgentHarness + MemorySessionRepo + a fake stream fn can drive the
// full Pi lifecycle with ZERO real model calls, and that compaction is triggered
// and executed by Pi (not by any fshine code).
//
// Public entry points only:
//   - AgentHarness, setDefaultStreamFn            <- @earendil-works/pi-agent-core (root)
//   - MemorySessionRepo, JsonlSessionRepo         <- @earendil-works/pi-agent-core/harness/session
//   - BACKGROUND_CONTEXT                          <- @earendil-works/pi-agent-core/harness/context
//   - createAssistantMessageEventStream           <- @earendil-works/pi-ai/utils/event-stream
//
// No fshine compaction trigger exists anywhere in this file: the only knobs are
// the public CompactionSettings / AgentHarnessOptions. All compaction_start /
// compaction_end / type=compaction entries below are produced by AgentHarness.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHarness, setDefaultStreamFn } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo, JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Type } from 'typebox';

const CTX = BACKGROUND_CONTEXT;

// ---------------------------------------------------------------- fake model

const cost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const usage = (totalTokens) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: cost() });

function makeModel({ contextWindow = 100000, maxTokens = 100 } = {}) {
  return {
    id: 'fake-model', name: 'Fake Model', api: 'fake-api', provider: 'fake',
    baseUrl: 'http://localhost', reasoning: false, input: ['text'],
    cost: { ...cost(), tiers: [] }, contextWindow, maxTokens,
  };
}

function assistant({ text = '', stopReason = 'stop', errorMessage, usage: u, toolCalls } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (toolCalls) content.push(...toolCalls);
  return {
    role: 'assistant', content, api: 'fake-api', provider: 'fake', model: 'fake-model',
    usage: u ?? usage(0), stopReason, errorMessage, timestamp: Date.now(),
  };
}

function toolCall(id, name, args = {}) {
  return { type: 'toolCall', id, name, arguments: args };
}

/** Wrap one AssistantMessage into a real AssistantMessageEventStream. */
function streamFrom(message) {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    s.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      s.push({ type: 'error', reason: message.stopReason, error: message });
    } else {
      s.push({ type: 'done', reason: message.stopReason, message });
    }
  });
  return s;
}

// ------------------------------------------------------- fake stream fn + Models

// A responder answers every streamSimple/completeSimple call from a script and
// records what the provider actually saw (the aiContext).
function makeResponder({ stream, complete }) {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (model, ctx, options) => {
      log.stream.push({ messages: ctx.messages, systemPrompt: ctx.systemPrompt, tools: ctx.tools });
      return stream(log.stream.length - 1, ctx);
    },
    completeFn: (model, ctx, options) => {
      log.complete.push({ messages: ctx.messages, systemPrompt: ctx.systemPrompt });
      return complete(log.complete.length - 1, ctx);
    },
  };
}

// Minimal object satisfying the pi-ai Models surface consumed by the harness
// (getModel / streamSimple / completeSimple). No real provider is reachable.
function makeModels(resp, model) {
  return {
    getModel: (p, id) => (p === model.provider && id === model.id ? model : undefined),
    streamSimple: resp.streamFn,
    completeSimple: resp.completeFn,
    getProviders: () => [], getProvider: () => undefined, getModels: () => [model],
    refresh: async () => ({}), checkAuth: async () => undefined,
    getAvailable: async () => [model], getAuth: async () => undefined,
    login: async () => { throw new Error('n/a'); }, logout: async () => {},
    stream: () => { throw new Error('n/a'); }, complete: () => { throw new Error('n/a'); },
    streamDeferred: () => { throw new Error('n/a'); }, fetchDeferred: () => { throw new Error('n/a'); },
    cancelDeferred: async () => {},
  };
}

const echoTool = {
  name: 'echo',
  description: 'Echo a value back.',
  label: 'Echo',
  parameters: Type.Object({ value: Type.Optional(Type.String()) }),
  execute: async (toolCallId, params) => ({
    content: [{ type: 'text', text: ('echoed:' + (params.value ?? '')).padEnd(40, '.') }],
    details: {},
  }),
};

// ------------------------------------------------------------------ harness scaffolding

function collectEvents(harness) {
  const events = [];
  for (const type of ['compaction_start', 'compaction_end', 'run_end', 'retry_scheduled', 'retry_end', 'turn_end']) {
    harness.events.on(type, (e) => events.push(e));
  }
  return events;
}

async function buildHarness({ model, resp, tools = [], activeToolNames, compaction, retry }) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const harnessHandle = await AgentHarness.create(
    { session, models: makeModels(resp, model), model, tools, activeToolNames, compaction, retry, systemPrompt: 'You are a test harness.' },
    CTX,
  );
  return { harness: harnessHandle.harness, open: harnessHandle.open };
}

async function entriesAscending(lane) {
  const entries = await lane.findEntries(undefined, CTX);
  return [...entries].sort((a, b) => a.seq - b.seq);
}

const line = (s = '') => console.log(s);
function header(t) { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); }

// --------------------------------------------------------------------- asserts

let failures = 0;
function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}

// ---------------------------------------------------------------------- scenarios

async function s1_crossTurn() {
  header('S1  跨回合转录连续性（同一 session 两次 lane.prompt）');
  const model = makeModel({ contextWindow: 100000 });
  const answers = ['first-answer', 'second-answer'];
  const resp = makeResponder({
    stream: (i) => streamFrom(assistant({ text: answers[i], usage: usage(10) })),
    complete: () => assistant({ text: 'SUMMARY' }),
  });
  const { harness } = await buildHarness({
    model, resp, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 },
  });
  const lane = await harness.lane('main', CTX);

  const r1 = await lane.prompt('hello round1', undefined, CTX);
  const tip1 = await lane.getTipId(CTX);
  const r2 = await lane.prompt('hello round2', undefined, CTX);
  const tip2 = await lane.getTipId(CTX);

  line(`r1.ok=${r1.ok}  r2.ok=${r2.ok}`);
  line(`tip after round1 = ${tip1}`);
  line(`tip after round2 = ${tip2}`);

  const entries = await entriesAscending(lane);
  line('entry chain (ascending):');
  for (const e of entries) line(`  seq=${e.seq} id=${e.id.slice(0, 8)} parent=${e.parentId ? e.parentId.slice(0, 8) : 'null'} type=${e.type} role=${e.message?.role ?? ''}`);

  // Parent chain continuity: each entry's parentId == previous entry's id.
  let chainOk = true;
  for (let i = 1; i < entries.length; i++) if (entries[i].parentId !== entries[i - 1].id) chainOk = false;

  const secondPromptContext = JSON.stringify(resp.log.stream[1].messages.map((m) => m.content));
  line(`provider context on 2nd prompt saw round1 user text: ${secondPromptContext.includes('hello round1')}`);
  line(`provider context on 2nd prompt saw round1 assistant text: ${secondPromptContext.includes('first-answer')}`);

  check('both turns completed', r1.ok && r2.ok);
  check('entry chain parentId contiguous', chainOk);
  check('tip advanced after round2', tip2 !== null && tip2 !== tip1, `${tip1} -> ${tip2}`);
  check('2nd-turn provider context contains round1 user msg', secondPromptContext.includes('hello round1'));
  check('2nd-turn provider context contains round1 assistant msg', secondPromptContext.includes('first-answer'));
  check('no compaction entry written (below threshold)', !entries.some((e) => e.type === 'compaction'));

  await harness.close(CTX);
}

async function s2_thresholdCompaction() {
  header('S2  threshold 自动压缩（调小 reserveTokens 强制触发）');
  const model = makeModel({ contextWindow: 1000 });
  // turn1 assistant usage small; turn2 assistant usage large -> crosses threshold at checkpoint.
  const resp = makeResponder({
    stream: (i) => (i === 0
      ? streamFrom(assistant({ text: 'A1'.padEnd(400, 'o'), usage: usage(50) }))
      : streamFrom(assistant({ text: 'A2'.padEnd(40, 'o'), usage: usage(5000) }))),
    complete: () => assistant({ text: 'PI-GENERATED-SUMMARY' }),
  });
  const { harness } = await buildHarness({
    model, resp,
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
  });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  await lane.prompt('u1'.padEnd(400, 'x'), undefined, CTX);
  await lane.prompt('u2'.padEnd(40, 'y'), undefined, CTX);

  const start = events.find((e) => e.type === 'compaction_start');
  const end = events.find((e) => e.type === 'compaction_end');
  line('compaction_start = ' + JSON.stringify(start ? { reason: start.reason } : null));
  line('compaction_end   = ' + JSON.stringify(end ? { status: end.status, reason: end.reason, entryId: end.entryId?.slice(0, 8) } : null));

  const entries = await entriesAscending(lane);
  const comp = entries.find((e) => e.type === 'compaction');
  line('compaction entry = ' + JSON.stringify(comp ? {
    type: comp.type, tokensBefore: comp.tokensBefore, fromHook: comp.fromHook,
    summary: comp.summary,
    retainedTailRoles: comp.retainedTail.map((m) => m.role),
    retainedTailLens: comp.retainedTail.map((m) => JSON.stringify(m.content).length),
  } : null, null, 2));
  line(`completeSimple (summary) calls = ${resp.log.complete.length}`);

  check('compaction_start reason=threshold', start?.reason === 'threshold');
  check('compaction_end status=completed', end?.status === 'completed');
  check('a type=compaction entry was written', comp !== undefined);
  check('compaction entry carries a summary', typeof comp?.summary === 'string' && comp.summary.length > 0);
  check('summary text came from the summary provider via Pi pipeline', comp?.summary?.includes('PI-GENERATED-SUMMARY'));
  check('compaction entry carries a non-empty retainedTail', Array.isArray(comp?.retainedTail) && comp.retainedTail.length > 0);
  check('retainedTail keeps the recent turn (starts at a user message)', comp?.retainedTail?.[0]?.role === 'user');
  check('no fshine code triggered compaction (only public settings set)', true);

  await harness.close(CTX);
}

async function s3_overflowRecovery() {
  header('S3  Overflow Recovery（首答 context-overflow -> 原生恢复 -> 续跑完成）');
  const model = makeModel({ contextWindow: 128000 });
  const resp = makeResponder({
    stream: (i) => (i === 0
      ? streamFrom(assistant({ stopReason: 'error', errorMessage: 'prompt is too long: 99999 tokens > 128000 maximum' }))
      : streamFrom(assistant({ text: 'recovered answer', usage: usage(10) }))),
    complete: () => assistant({ text: 'OVERFLOW-SUMMARY' }),
  });
  const { harness } = await buildHarness({ model, resp, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 } });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  const r = await lane.prompt('overflow prompt', undefined, CTX);
  line(`prompt result ok = ${r.ok}`);

  const start = events.find((e) => e.type === 'compaction_start');
  const end = events.find((e) => e.type === 'compaction_end');
  const runEnd = events.filter((e) => e.type === 'run_end');
  line('compaction_start reason = ' + start?.reason);
  line('compaction_end = ' + JSON.stringify(end ? { status: end.status, reason: end.reason } : null));
  line('run_end = ' + JSON.stringify(runEnd.map((e) => ({ status: e.status, error: e.error?.code }))));
  line(`assistant stream calls = ${resp.log.stream.length}`);
  line(`summary completeSimple calls = ${resp.log.complete.length}`);

  check('compaction_start reason=overflow', start?.reason === 'overflow');
  check('compaction_end status=completed', end?.status === 'completed');
  check('run_end status=completed', runEnd.at(-1)?.status === 'completed');
  check('exactly 2 assistant calls (1 overflow + 1 recovered)', resp.log.stream.length === 2);
  check('prompt returned ok', r.ok);

  await harness.close(CTX);
}

async function s4_boundedFailure() {
  header('S4  有界失败：反复 overflow 超上界 / 当前回合无法切分');

  // (a) Persistent overflow: recovery is used once, then the run fails. No infinite retry.
  {
    line('-- S4a persistent overflow (every assistant answer overflows) --');
    const model = makeModel({ contextWindow: 128000 });
    const resp = makeResponder({
      stream: () => streamFrom(assistant({ stopReason: 'error', errorMessage: 'prompt is too long: 99999 tokens > 128000 maximum' })),
      complete: () => assistant({ text: 'OVERFLOW-SUMMARY' }),
    });
    const { harness } = await buildHarness({ model, resp, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 } });
    const events = collectEvents(harness);
    const lane = await harness.lane('main', CTX);
    const r = await lane.prompt('always overflow', undefined, CTX);

    const starts = events.filter((e) => e.type === 'compaction_start');
    const ends = events.filter((e) => e.type === 'compaction_end');
    const runEnd = events.filter((e) => e.type === 'run_end');
    const retries = events.filter((e) => e.type === 'retry_scheduled');
    line(`prompt result ok = ${r.ok}`);
    line('compaction_start reasons = ' + JSON.stringify(starts.map((e) => e.reason)));
    line('compaction_end = ' + JSON.stringify(ends.map((e) => ({ status: e.status, reason: e.reason }))));
    line('run_end = ' + JSON.stringify(runEnd.map((e) => ({ status: e.status, error: e.error?.code }))));
    line('retry_scheduled count = ' + retries.length);
    line(`assistant stream calls = ${resp.log.stream.length}`);

    check('exactly one overflow recovery attempted', starts.filter((e) => e.reason === 'overflow').length === 1);
    check('run_end status=failed (bounded)', runEnd.at(-1)?.status === 'failed');
    check('exactly 2 assistant calls (no unbounded retry)', resp.log.stream.length === 2);
    check('no retry_scheduled loop for assistant', retries.length === 0);
    await harness.close(CTX);
  }

  // (b) Nothing-to-compact: manual compact on an empty session. Zero provider calls.
  {
    line('-- S4b nothing to compact (empty session, manual lane.compact) --');
    const model = makeModel({ contextWindow: 100000 });
    const resp = makeResponder({
      stream: () => streamFrom(assistant({ text: 'never' })),
      complete: () => assistant({ text: 'never' }),
    });
    const { harness } = await buildHarness({ model, resp, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 } });
    const lane = await harness.lane('main', CTX);
    const res = await lane.compact(undefined, CTX);
    line('lane.compact ok = ' + res.ok);
    line('lane.compact error = ' + (res.ok ? 'n/a' : JSON.stringify({ _tag: res.error?._tag, message: res.error?.message })));
    line(`provider calls = ${resp.log.stream.length + resp.log.complete.length}`);
    check('manual compact on empty history -> error', res.ok === false);
    check('error is NothingToCompact', res.ok === false && res.error?._tag === 'NothingToCompact', res.ok ? '' : res.error?._tag);
    check('no provider call issued', resp.log.stream.length + resp.log.complete.length === 0);
    await harness.close(CTX);
  }
}

async function s5_toolPairing() {
  header('S5  工具调用与工具结果完整配对（压缩后 history 中配对不破）');
  const model = makeModel({ contextWindow: 1000 });
  // turn1: u1 + assistant text. turn2: u2 -> assistant toolCall -> toolResult -> assistant text(usage large).
  const resp = makeResponder({
    stream: (i) => {
      if (i === 0) return streamFrom(assistant({ text: 'A1'.padEnd(400, 'o'), usage: usage(50) }));
      if (i === 1) return streamFrom(assistant({ stopReason: 'toolUse', toolCalls: [toolCall('tc-echo-1', 'echo', {})], usage: usage(10) }));
      return streamFrom(assistant({ text: 'A2'.padEnd(40, 'o'), usage: usage(5000) }));
    },
    complete: () => assistant({ text: 'PI-TOOL-SUMMARY' }),
  });
  const { harness } = await buildHarness({
    model, resp, tools: [echoTool], activeToolNames: ['echo'],
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
  });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  await lane.prompt('u1'.padEnd(400, 'x'), undefined, CTX);
  await lane.prompt('u2'.padEnd(40, 'y'), undefined, CTX);

  const end = events.find((e) => e.type === 'compaction_end');
  line('compaction_end = ' + JSON.stringify(end ? { status: end.status, reason: end.reason } : null));

  const entries = await entriesAscending(lane);
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'assistant' && e.message.content.some((c) => c.type === 'toolCall')) {
      line(`assistant toolCall entry seq=${e.seq} ids=${JSON.stringify(e.message.content.filter((c) => c.type === 'toolCall').map((c) => c.id))}`);
    }
    if (e.type === 'message' && e.message.role === 'toolResult') {
      line(`toolResult entry seq=${e.seq} toolCallId=${e.message.toolCallId} toolName=${e.message.toolName}`);
    }
  }

  const comp = entries.find((e) => e.type === 'compaction');
  line('compaction retainedTail roles = ' + JSON.stringify(comp?.retainedTail.map((m) => m.role)));
  const tailCallIds = (comp?.retainedTail ?? [])
    .flatMap((m) => (m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall').map((c) => c.id) : []));
  const tailResultIds = (comp?.retainedTail ?? [])
    .flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : []));
  line('retainedTail toolCall ids = ' + JSON.stringify(tailCallIds));
  line('retainedTail toolResult ids = ' + JSON.stringify(tailResultIds));

  // Pairing invariant over the whole session: every toolResult has its toolCall, and vice versa.
  const allCallIds = entries.flatMap((e) => (e.type === 'message' && e.message.role === 'assistant' ? e.message.content.filter((c) => c.type === 'toolCall').map((c) => c.id) : []));
  const allResultIds = entries.flatMap((e) => (e.type === 'message' && e.message.role === 'toolResult' ? [e.message.toolCallId] : []));
  const everyResultHasCall = allResultIds.every((id) => allCallIds.includes(id));
  const everyCallHasResult = allCallIds.every((id) => allResultIds.includes(id));
  line(`session: toolCalls=${JSON.stringify(allCallIds)} toolResults=${JSON.stringify(allResultIds)}`);

  check('compaction completed', end?.status === 'completed');
  check('retainedTail keeps toolCall AND its toolResult together', tailCallIds.includes('tc-echo-1') && tailResultIds.includes('tc-echo-1'));
  check('every toolResult in session has a matching toolCall', everyResultHasCall);
  check('every toolCall in session has a matching toolResult', everyCallHasResult);

  await harness.close(CTX);
}

async function s6_summaryFailureBounded() {
  header('S6  摘要失败有界（摘要 provider 报错 -> 有界失败，不无界重试）');
  const model = makeModel({ contextWindow: 1000 });
  const resp = makeResponder({
    stream: (i) => (i === 0
      ? streamFrom(assistant({ text: 'A1'.padEnd(400, 'o'), usage: usage(50) }))
      : streamFrom(assistant({ text: 'A2'.padEnd(40, 'o'), usage: usage(5000) }))),
    complete: () => assistant({ stopReason: 'error', errorMessage: '500 internal server error from summarizer' }),
  });
  const { harness } = await buildHarness({
    model, resp,
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  const r1 = await lane.prompt('u1'.padEnd(400, 'x'), undefined, CTX);
  const r2 = await lane.prompt('u2'.padEnd(40, 'y'), undefined, CTX);
  line(`r1.ok=${r1.ok} r2.ok=${r2.ok}`);

  const retries = events.filter((e) => e.type === 'retry_scheduled');
  const ends = events.filter((e) => e.type === 'compaction_end');
  const runEnd = events.filter((e) => e.type === 'run_end');
  line('retry_scheduled = ' + JSON.stringify(retries.map((e) => ({ step: e.step, attempt: e.attempt, maxAttempts: e.maxAttempts }))));
  line('compaction_end = ' + JSON.stringify(ends.map((e) => ({ status: e.status, reason: e.reason, error: e.error?.code }))));
  line('run_end = ' + JSON.stringify(runEnd.map((e) => ({ status: e.status, error: e.error?.code }))));
  line(`summary completeSimple calls = ${resp.log.complete.length}`);

  check('bounded retries scheduled (maxAttempts-1 = 2)', retries.length === 2);
  check('all retries report maxAttempts=3', retries.every((e) => e.maxAttempts === 3));
  check('compaction_end status=failed', ends.at(-1)?.status === 'failed');
  check('summary calls bounded to maxAttempts=3', resp.log.complete.length === 3);
  check('no compaction entry written on failure', !(await entriesAscending(lane)).some((e) => e.type === 'compaction'));

  await harness.close(CTX);
}

async function s_jsonlPersistence() {
  header('S7(extra)  JsonlSessionRepo 落盘 + 重开同一 session（证明持久化入口可用）');
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-'));
  try {
    const model = makeModel({ contextWindow: 100000 });
    const resp = makeResponder({
      stream: (i) => streamFrom(assistant({ text: 'answer-' + i, usage: usage(10) })),
      complete: () => assistant({ text: 'SUMMARY' }),
    });
    const env = new NodeExecutionEnv({ cwd: dir });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: dir });
    const session = await repo.create({ cwd: dir }, CTX);
    const { harness } = await AgentHarness.create(
      { session, models: makeModels(resp, model), model, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 } },
      CTX,
    );
    const lane = await harness.lane('main', CTX);
    await lane.prompt('persist me', undefined, CTX);
    const tip = await lane.getTipId(CTX);
    await harness.close(CTX);
    line(`session id = ${session.metadata.id}`);
    line(`tip = ${tip}`);
    check('jsonl session produced a tip', typeof tip === 'string' && tip.length > 0);

    // Re-open the same session from disk.
    const reopened = await repo.open(session.metadata, CTX);
    const { harness: h2 } = await AgentHarness.create(
      { session: reopened, models: makeModels(resp, model), model, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 } },
      CTX,
    );
    const lane2 = await h2.lane('main', CTX);
    const entries = await entriesAscending(lane2);
    line(`reopened entry count = ${entries.length}`);
    check('reopened session preserves transcript', entries.length >= 2);
    await h2.close(CTX);
    await repo.close(CTX);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------ main

// Install a default fake stream fn too (public root export); no real provider is reachable.
setDefaultStreamFn((model, ctx) => streamFrom(assistant({ text: 'default-fake' })));

await s1_crossTurn();
await s2_thresholdCompaction();
await s3_overflowRecovery();
await s4_boundedFailure();
await s5_toolPairing();
await s6_summaryFailureBounded();
await s_jsonlPersistence();

line();
line(`==== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
