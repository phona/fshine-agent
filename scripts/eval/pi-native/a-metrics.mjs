// A-metrics fixture (phase 3, "measure A" run).
//
// Scope of THIS fixture (per owner step 7): MEASURE ONLY. Accept Pi's weaker
// bounded failure ("relax: never emit a knowably-over-window request") and
// report what that actually costs / what the failure bound is. This fixture
// makes NO repair decision and does NOT relax the D1 criterion; it only records
// observed facts.
//
// It measures, on the NEW Pi-native path (bare AgentHarness, NO fshine
// pre-request budget check), four deterministic scenario groups at windows
// 8192 / 40000 / 128000:
//
//   G1  first-request over-window   (bare Pi-Harness, no fshine check)
//   G2  tool-result continuation over-window
//   G3  recoverable overflow        (compaction makes it fit -> success)
//   G4  unrecoverable overflow      (never fits -> must bound-fail)
//
// For each: was a request emitted / how many emissions / did it end in a
// BOUNDED failure (no unbounded retry; retry_scheduled count).
//
// Zero real model: fake Models + fake stream fn only. baseUrl=localhost.
// Public entry points only (no copied Pi source, no dist internals).
//
//   AgentHarness, setDefaultStreamFn            <- @earendil-works/pi-agent-core (root)
//   MemorySessionRepo                           <- .../harness/session
//   BACKGROUND_CONTEXT                          <- .../harness/context
//   createAssistantMessageEventStream           <- @earendil-works/pi-ai/utils/event-stream
//
// Exit 0 = facts observed. Exit 1 = a boundedness invariant unexpectedly broke.

import { AgentHarness, setDefaultStreamFn } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Type } from 'typebox';

const CTX = BACKGROUND_CONTEXT;
const WINDOWS = [8192, 40000, 128000];
const SYSPROMPT = 'test harness';

const cost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const usage = (t) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: t, cost: cost() });

const makeModel = (contextWindow) => ({
  id: 'fake-model', name: 'Fake', api: 'fake-api', provider: 'fake', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], cost: { ...cost(), tiers: [] }, contextWindow, maxTokens: 1024,
});

const asst = ({ text = '', stopReason = 'stop', errorMessage, usage: u, toolCalls } = {}) => {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (toolCalls) content.push(...toolCalls);
  return { role: 'assistant', content, api: 'fake-api', provider: 'fake', model: 'fake-model',
    usage: u ?? usage(0), stopReason, errorMessage, timestamp: Date.now() };
};
const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

const streamFrom = (message) => {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    s.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      s.push({ type: 'error', reason: message.stopReason, error: message });
    } else s.push({ type: 'done', reason: message.stopReason, message });
  });
  return s;
};

// Provider-side pre-dispatch size proxy (char/4), the same accounting the whole
// experiment uses. The fake provider KNOWS whether a request is over-window
// before accepting it, and (mode "enforce") rejects it with a real overflow
// error -- exactly what a real provider does.
const est = (messages) => Math.ceil(JSON.stringify(messages).length / 4);

function makeProvider({ W, maxTokens, respond, completeRespond }) {
  const log = { stream: [], complete: [] };
  const overLimit = W - maxTokens;
  return {
    log,
    overLimit,
    streamFn: (_m, ctx) => {
      const promptTokens = est(ctx.messages);
      const overWindow = promptTokens > overLimit;
      const idx = log.stream.length;
      log.stream.push({ idx, promptTokens, overWindow, nMessages: ctx.messages.length });
      return streamFrom(respond({ ctx, idx, promptTokens, overWindow }));
    },
    completeFn: (_m, ctx) => {
      const idx = log.complete.length;
      log.complete.push({ idx });
      return (completeRespond ? completeRespond({ ctx, idx }) : asst({ text: 'PI-SUMMARY' }));
    },
  };
}

function makeModels(resp, model) {
  return {
    getModel: (p, id) => (p === model.provider && id === model.id ? model : undefined),
    streamSimple: resp.streamFn, completeSimple: resp.completeFn,
    getProviders: () => [], getProvider: () => undefined, getModels: () => [model],
    refresh: async () => ({}), checkAuth: async () => undefined,
    getAvailable: async () => [model], getAuth: async () => undefined,
    login: async () => { throw new Error('n/a'); }, logout: async () => {},
    stream: () => { throw new Error('n/a'); }, complete: () => { throw new Error('n/a'); },
    streamDeferred: () => { throw new Error('n/a'); }, fetchDeferred: () => { throw new Error('n/a'); },
    cancelDeferred: async () => {},
  };
}

// A tool whose RESULT is itself large enough to blow the window. `counter`
// asserts the task is executed exactly ONCE even across overflow recovery.
const bigResultTool = (tokens, counter) => ({
  name: 'bigtool', description: 'Returns a large payload.', label: 'Big',
  parameters: Type.Object({}),
  execute: async () => {
    if (counter) counter.n += 1;
    return { content: [{ type: 'text', text: 'R'.repeat(tokens * 4) }], details: {} };
  },
});

async function buildHarness({ resp, model, compaction, tools = [], activeToolNames, retry }) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const handle = await AgentHarness.create(
    { session, models: makeModels(resp, model), model, compaction, tools, activeToolNames, systemPrompt: SYSPROMPT, retry },
    CTX,
  );
  return handle.harness;
}

// The public 0.85.1 overflow-detection shapes Pi accepts (matches the docs).
function overflowMessage(promptTokens, W) {
  return `prompt is too long: ${promptTokens} tokens > ${W} maximum context length`;
}

// --------------------------------------------------------------- bookkeeping

let failures = 0;
const line = (s = '') => console.log(s);
function header(t) { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); }
function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}

function collect(harness) {
  const ev = [];
  for (const t of ['compaction_start', 'compaction_end', 'run_end', 'retry_scheduled', 'retry_end', 'turn_end', 'handler_error']) {
    harness.events.on(t, (e) => ev.push({ type: t, ...e }));
  }
  return ev;
}

function summarize(label, { W, resp, ev, errored, extra = {} }) {
  const sends = resp.log.stream.length;
  const overs = resp.log.stream.filter((c) => c.overWindow).length;
  const completeCalls = resp.log.complete.length;
  const overTokens = resp.log.stream.filter((c) => c.overWindow).reduce((a, c) => a + c.promptTokens, 0);
  const totalTokens = resp.log.stream.reduce((a, c) => a + c.promptTokens, 0);
  const runEnds = ev.filter((e) => e.type === 'run_end');
  const compEnds = ev.filter((e) => e.type === 'compaction_end');
  const compStarts = ev.filter((e) => e.type === 'compaction_start');
  const retries = ev.filter((e) => e.type === 'retry_scheduled');
  const last = runEnds.at(-1);
  const record = {
    label, W, sends, overs, completeCalls,
    wastedOverTokens: overTokens, totalPromptTokens: totalTokens,
    refused: errored?.name === 'PreRequestBudgetRefusal',
    threw: errored ? errored.name : null,
    runEndStatus: last ? last.status : null,
    runEndError: last ? (last.error?.code ?? last.error ?? null) : null,
    compactionStarts: compStarts.map((e) => e.reason),
    compactionEnds: compEnds.map((e) => e.status),
    retryScheduled: retries.length,
    retryDetail: retries.map((e) => ({ step: e.step, attempt: e.attempt, max: e.maxAttempts })),
    ...extra,
  };
  line(`  sends=${sends} over=${overs} completeCalls=${completeCalls} wastedOverTokens=${overTokens} totalPromptTokens=${totalTokens}`);
  line(`  threw=${record.threw} runEnd=${record.runEndStatus}(${record.runEndError})`);
  line(`  compactionStarts=${JSON.stringify(record.compactionStarts)} compactionEnds=${JSON.stringify(record.compactionEnds)}`);
  line(`  retry_scheduled=${record.retryScheduled} ${JSON.stringify(record.retryDetail)}`);
  return record;
}

const results = [];

// --------------------------------------------------------------------- G1
// First-request over-window on a BARE Pi-Harness (no fshine pre-request check).
// A single giant user message is already over the window. Provider enforces.

async function g1_firstRequestOverwindow(W) {
  header(`G1  first-request over-window, BARE Pi-Harness (no fshine check)  @ W=${W}`);
  const model = makeModel(W);
  const giant = 'z'.repeat(W * 6); // ~1.5*W tokens, clearly over-window, single message
  const resp = makeProvider({
    W, maxTokens: model.maxTokens,
    respond: ({ promptTokens, overWindow }) =>
      overWindow
        ? asst({ stopReason: 'error', errorMessage: overflowMessage(promptTokens, W) })
        : asst({ text: 'ok', usage: usage(10) }),
  });
  const harness = await buildHarness({
    resp, model,
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
  });
  const ev = collect(harness);
  const lane = await harness.lane('main', CTX);
  let errored;
  try { await lane.prompt(giant, undefined, CTX); } catch (e) { errored = e; }
  const rec = summarize(`G1@${W}`, { W, resp, ev, errored });
  check(`W=${W}: bare path DID emit an over-window request (no fshine check)`, rec.overs >= 1, `over=${rec.overs}`);
  check(`W=${W}: bounded (no unbounded retry; retry_scheduled=${rec.retryScheduled})`, rec.retryScheduled <= 3);
  check(`W=${W}: run terminated (run_end present)`, rec.runEndStatus !== null);
  results.push(rec);
  await harness.close(CTX);
}

// --------------------------------------------------------------------- G2
// Tool-result continuation over-window. First request fits; assistant calls a
// tool whose result is huge; the continuation carries it over-window.

async function g2_toolResultContinuation(W) {
  header(`G2  tool-result continuation over-window  @ W=${W}`);
  const model = makeModel(W);
  const execCount = { n: 0 };
  let first = true;
  const resp = makeProvider({
    W, maxTokens: model.maxTokens,
    respond: ({ promptTokens, overWindow }) => {
      if (overWindow) return asst({ stopReason: 'error', errorMessage: overflowMessage(promptTokens, W) });
      if (first) {
        first = false;
        return asst({ stopReason: 'toolUse', toolCalls: [toolCall('tc-1', 'bigtool', {})], usage: usage(10) });
      }
      return asst({ text: 'done', usage: usage(10) });
    },
  });
  const harness = await buildHarness({
    resp, model,
    tools: [bigResultTool(W * 2, execCount)], activeToolNames: ['bigtool'],
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
  });
  const ev = collect(harness);
  const lane = await harness.lane('main', CTX);
  let errored;
  try { await lane.prompt('go', undefined, CTX); } catch (e) { errored = e; }
  const rec = summarize(`G2@${W}`, { W, resp, ev, errored, extra: { toolExecutions: execCount.n } });
  check(`W=${W}: continuation over-window request WAS emitted`, rec.overs >= 1, `over=${rec.overs}`);
  check(`W=${W}: task executed exactly once (no duplicate)`, execCount.n === 1, `executions=${execCount.n}`);
  check(`W=${W}: bounded (no unbounded retry; retry_scheduled=${rec.retryScheduled})`, rec.retryScheduled <= 3);
  results.push(rec);
  await harness.close(CTX);
}

// --------------------------------------------------------------------- G3
// Recoverable overflow: the FIRST response is an overflow error, Pi compacts,
// and the retried request fits -> run completes.

async function g3_recoverableOverflow(W) {
  header(`G3  recoverable overflow (compaction makes it fit -> success)  @ W=${W}`);
  const model = makeModel(W);
  const budget = W - 4096 - 1024 - Math.ceil(SYSPROMPT.length / 4);
  const perTurn = Math.floor(budget / 2.5);
  const reserve = W - Math.floor(perTurn * 1.5);
  let first = true;
  const resp = makeProvider({
    W, maxTokens: model.maxTokens,
    respond: ({ ctx, promptTokens, overWindow }) => {
      if (overWindow) return asst({ stopReason: 'error', errorMessage: overflowMessage(promptTokens, W) });
      if (first) {
        first = false;
        return asst({ stopReason: 'error', errorMessage: overflowMessage(promptTokens, W) });
      }
      return asst({ text: 'A'.repeat(perTurn * 2), usage: usage(Math.ceil(JSON.stringify(ctx.messages).length / 4)) });
    },
  });
  const harness = await buildHarness({
    resp, model,
    compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: Math.floor(perTurn / 2) },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  });
  const ev = collect(harness);
  const lane = await harness.lane('main', CTX);
  let errored;
  try { await lane.prompt('overflow please', undefined, CTX); } catch (e) { errored = e; }
  const rec = summarize(`G3@${W}`, { W, resp, ev, errored });
  check(`W=${W}: recovered (run_end completed)`, rec.runEndStatus === 'completed', rec.runEndStatus);
  check(`W=${W}: bounded (no unbounded retry; retry_scheduled=${rec.retryScheduled})`, rec.retryScheduled <= 3);
  results.push(rec);
  await harness.close(CTX);
}

// --------------------------------------------------------------------- G4
// Unrecoverable overflow: the provider returns overflow for EVERY request no
// matter the size (a persistent outage / hard cap). Pi must bound-fail.

async function g4_unrecoverableOverflow(W) {
  header(`G4  unrecoverable overflow (never fits -> must bound-fail)  @ W=${W}`);
  const model = makeModel(W);
  const resp = makeProvider({
    W, maxTokens: model.maxTokens,
    respond: ({ promptTokens }) =>
      asst({ stopReason: 'error', errorMessage: overflowMessage(promptTokens, W) }),
  });
  const harness = await buildHarness({
    resp, model,
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  });
  const ev = collect(harness);
  const lane = await harness.lane('main', CTX);
  let errored;
  try { await lane.prompt('x'.repeat(2 * W), undefined, CTX); } catch (e) { errored = e; }
  const rec = summarize(`G4@${W}`, { W, resp, ev, errored });
  check(`W=${W}: ended in bounded failure (run_end failed, not hanging)`, rec.runEndStatus === 'failed', rec.runEndStatus);
  check(`W=${W}: sends bounded (<=6, no unbounded loop)`, rec.sends <= 6, `sends=${rec.sends}`);
  check(`W=${W}: summary calls bounded (<=3)`, rec.completeCalls <= 3, `completeCalls=${rec.completeCalls}`);
  results.push(rec);
  await harness.close(CTX);
}

// --------------------------------------------------------------------- main

setDefaultStreamFn((_m, _ctx) => streamFrom(asst({ text: 'default-fake' })));

for (const W of WINDOWS) await g1_firstRequestOverwindow(W);
for (const W of WINDOWS) await g2_toolResultContinuation(W);
for (const W of WINDOWS) await g3_recoverableOverflow(W);
for (const W of WINDOWS) await g4_unrecoverableOverflow(W);

header('RESULTS (machine-readable)');
line(JSON.stringify(results, null, 2));
line();
line(`==== failures=${failures} ====`);
process.exit(failures === 0 ? 0 : 1);
