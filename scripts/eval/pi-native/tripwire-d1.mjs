// D1 reverse tripwire on the Pi-native harness path (phase 3 gate).
//
// Question this fixture answers: on the NEW path (AgentHarness + Session + Pi
// native compaction only, no fshine pre-request INV gate), is a physically
// unfixable over-window input *bounded-rejected without ever sending an
// over-window request*?
//
// Decision rule (from the implementation ask):
//   (a) count of knowably over-window requests sent MUST be 0
//   (b) run_end failed, total assistant stream calls <= 2, no retry_scheduled loop
//   (c) control: a large-but-splittable transcript still succeeds within window
//   If (a) fails -> keep D1 (pi-driver.ts pre-request INV gate) and report blocked.
//
// Zero real model: fake Models object + fake stream fn only.
//
// Public entry points only:
//   AgentHarness, setDefaultStreamFn            <- @earendil-works/pi-agent-core (root)
//   MemorySessionRepo                           <- @earendil-works/pi-agent-core/harness/session
//   BACKGROUND_CONTEXT                          <- @earendil-works/pi-agent-core/harness/context
//   createAssistantMessageEventStream           <- @earendil-works/pi-ai/utils/event-stream

import { AgentHarness, setDefaultStreamFn } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const CTX = BACKGROUND_CONTEXT;

const cost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const usage = (totalTokens) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: cost() });

function makeModel({ contextWindow = 8192, maxTokens = 1024 } = {}) {
  return {
    id: 'fake-model', name: 'Fake Model', api: 'fake-api', provider: 'fake',
    baseUrl: 'http://localhost', reasoning: false, input: ['text'],
    cost: { ...cost(), tiers: [] }, contextWindow, maxTokens,
  };
}

function assistant({ text = '', stopReason = 'stop', errorMessage, usage: u } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  return {
    role: 'assistant', content, api: 'fake-api', provider: 'fake', model: 'fake-model',
    usage: u ?? usage(0), stopReason, errorMessage, timestamp: Date.now(),
  };
}

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

// Token estimate used by the fake provider to decide whether a request is
// "knowably over window" *before* it would be sent — same rough char/4 proxy
// the whole experiment uses.
const estimateTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 4);

function makeResponder(model) {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (_model, ctx) => {
      const promptTokens = estimateTokens(ctx.messages);
      const budget = model.contextWindow - model.maxTokens;
      const overWindow = promptTokens > budget;
      log.stream.push({ promptTokens, budget, overWindow, messages: ctx.messages });
      // A real provider rejects promptly when input + output reservation exceed the window.
      if (overWindow) {
        return streamFrom(assistant({
          stopReason: 'error',
          errorMessage: `prompt is too long: ${promptTokens} tokens > ${model.contextWindow} maximum context length`,
        }));
      }
      return streamFrom(assistant({ text: 'ok-answer', usage: usage(10) }));
    },
    completeFn: (_model, ctx) => {
      log.complete.push({ messages: ctx.messages });
      return assistant({ text: 'PI-NATIVE-SUMMARY' });
    },
  };
}

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

function collectEvents(harness) {
  const events = [];
  for (const type of ['compaction_start', 'compaction_end', 'run_end', 'retry_scheduled', 'turn_end']) {
    harness.events.on(type, (e) => events.push(e));
  }
  return events;
}

async function buildHarness({ model, resp, compaction }) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const handle = await AgentHarness.create(
    { session, models: makeModels(resp, model), model, compaction, systemPrompt: 'test harness' },
    CTX,
  );
  return { harness: handle.harness };
}

let failures = 0;
const line = (s = '') => console.log(s);
function header(t) { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); }
function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}

// One giant user message whose own size blows the window (no cut point inside the turn).
function giantMessage(tokens) {
  // ~4 chars/token; JSON overhead adds some, so this comfortably exceeds any target.
  return 'z'.repeat(tokens * 4);
}

async function tripwireA() {
  header('D1-A  unfixable over-window input (single giant user message, no cut point)');
  const model = makeModel({ contextWindow: 8192, maxTokens: 1024 });
  const resp = makeResponder(model);
  const { harness } = await buildHarness({
    model, resp, compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 },
  });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  const r = await lane.prompt(giantMessage(20000), undefined, CTX);
  const streamCalls = resp.log.stream.length;
  const overWindowCalls = resp.log.stream.filter((c) => c.overWindow).length;
  const runEnd = events.filter((e) => e.type === 'run_end');
  const retries = events.filter((e) => e.type === 'retry_scheduled');

  line(`prompt result ok = ${r.ok}`);
  line(`assistant stream calls = ${streamCalls}  (over-window = ${overWindowCalls})`);
  line(`first promptTokens = ${resp.log.stream[0]?.promptTokens}  budget = ${resp.log.stream[0]?.budget}`);
  line('run_end = ' + JSON.stringify(runEnd.map((e) => ({ status: e.status, error: e.error?.code }))));
  line('retry_scheduled count = ' + retries.length);

  check('(a) knowably over-window requests sent == 0', overWindowCalls === 0, `overWindowCalls=${overWindowCalls}`);
  check('(b) run_end failed', runEnd.at(-1)?.status === 'failed', runEnd.at(-1)?.status);
  check('(b) assistant calls <= 2 (no unbounded retry)', streamCalls <= 2, `calls=${streamCalls}`);
  check('(b) no retry_scheduled loop', retries.length === 0, `retries=${retries.length}`);

  await harness.close(CTX);
  return { overWindowCalls, streamCalls };
}

async function tripwireC() {
  header('D1-C  control: large-but-splittable transcript still succeeds within window');
  const model = makeModel({ contextWindow: 100000, maxTokens: 1024 });
  const resp = makeResponder(model);
  const { harness } = await buildHarness({
    model, resp, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 500 },
  });
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  // Each individual turn fits comfortably; total history grows large but is splittable.
  for (let i = 0; i < 6; i += 1) {
    const r = await lane.prompt(`round ${i} ` + 'a'.repeat(2000), undefined, CTX);
    if (!r.ok) { check(`round ${i} ok`, false); break; }
  }
  const streamCalls = resp.log.stream.length;
  const overWindowCalls = resp.log.stream.filter((c) => c.overWindow).length;
  const compactions = events.filter((e) => e.type === 'compaction_end');
  line(`assistant stream calls = ${streamCalls}  (over-window = ${overWindowCalls})`);
  line('compaction_end = ' + JSON.stringify(compactions.map((e) => ({ status: e.status, reason: e.reason }))));

  check('(c) splittable transcript sent no over-window request', overWindowCalls === 0, `overWindow=${overWindowCalls}`);
  check('(c) all rounds completed', streamCalls >= 6, `calls=${streamCalls}`);

  await harness.close(CTX);
}

setDefaultStreamFn((_model, _ctx) => streamFrom(assistant({ text: 'default-fake' })));

const a = await tripwireA();
await tripwireC();

line();
line(`D1 tripwire: overWindowCalls(A)=${a.overWindowCalls} streamCalls(A)=${a.streamCalls}`);
line(`==== ${failures === 0 ? 'D1 GATE PASSED' : failures + ' D1 GATE CHECK(S) FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
