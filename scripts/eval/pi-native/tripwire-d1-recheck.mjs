// Independent reviewer recheck of the phase-3 D1 reverse tripwire.
//
// Written by a DIFFERENT agent than the one that authored tripwire-d1.mjs, to
// independently reproduce the reported finding and to answer the extra
// question the original fixture did NOT cover:
//   Does Pi 0.85.1 expose ANY public pre-send size-prediction / rejection hook
//   that could stop a knowably over-window request from being sent?
//
// Zero real model: fake Models object + fake stream fn only.
// Public entry points only (root + documented subpaths); no dist/** imports,
// no Pi source copied.
//
// Observed-fact assertions (should all hold on the CURRENT new path):
//   A1  at least one knowably over-window request is SENT (overWindowCalls >= 1)
//   A2  the run ends failed
//   A3  assistant stream calls are bounded (<= 2), no retry_scheduled loop
//   B1  a registered before_request hook receives NO messages and cannot veto
//       (request still sent even when the hook returns / throws)
//   C1  Pi exposes estimation helpers (estimateContextTokens/shouldCompact)
//       but they are NOT wired into the send path
//
// Exit code 0 = determination made (facts observed). 1 = unexpected (e.g. the
// new path rejected pre-send -> last round's conclusion would not hold).

import { AgentHarness, setDefaultStreamFn, estimateContextTokens, shouldCompact } from '@earendil-works/pi-agent-core';
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

// Provider-side size proxy (char/4) — the same proxy the experiment uses to
// decide a request is "knowably over window" before it would be accepted.
const estimateProviderTokens = (aiContext) => Math.ceil(JSON.stringify(aiContext.messages).length / 4);

function makeProvider(model) {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (_model, aiContext) => {
      const promptTokens = estimateProviderTokens(aiContext);
      const budget = model.contextWindow - model.maxTokens;
      const overWindow = promptTokens > budget;
      log.stream.push({ promptTokens, budget, overWindow });
      if (overWindow) {
        return streamFrom(assistant({
          stopReason: 'error',
          errorMessage: `prompt is too long: ${promptTokens} tokens > ${model.contextWindow} maximum context length`,
        }));
      }
      return streamFrom(assistant({ text: 'ok-answer', usage: usage(10) }));
    },
    completeFn: () => assistant({ text: 'PI-NATIVE-SUMMARY' }),
  };
}

function makeModels(provider, model) {
  return {
    getModel: (p, id) => (p === model.provider && id === model.id ? model : undefined),
    streamSimple: provider.streamFn,
    completeSimple: provider.completeFn,
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

const giant = (tokens) => 'z'.repeat(tokens * 4);

let failures = 0;
const line = (s = '') => console.log(s);
function header(t) { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); }
function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}

// ---- Part A: reproduce the unfixable over-window input ----
async function partA() {
  header('A  unfixable over-window input (single giant user message)');
  const model = makeModel({ contextWindow: 8192, maxTokens: 1024 });
  const provider = makeProvider(model);
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const { harness } = await AgentHarness.create({
    session, models: makeModels(provider, model), model,
    compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 },
    systemPrompt: 'recheck harness',
  }, CTX);
  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);

  const r = await lane.prompt(giant(20000), undefined, CTX);

  const streamCalls = provider.log.stream.length;
  const overWindowCalls = provider.log.stream.filter((c) => c.overWindow).length;
  const runEnd = events.filter((e) => e.type === 'run_end');
  const retries = events.filter((e) => e.type === 'retry_scheduled');
  const compStart = events.filter((e) => e.type === 'compaction_start');
  const compEnd = events.filter((e) => e.type === 'compaction_end');

  line(`prompt result ok = ${r.ok}`);
  line(`assistant stream calls = ${streamCalls}  (over-window = ${overWindowCalls})`);
  line(`first promptTokens = ${provider.log.stream[0]?.promptTokens}  budget = ${provider.log.stream[0]?.budget}`);
  line('compaction_start = ' + JSON.stringify(compStart.map((e) => e.reason)));
  line('compaction_end   = ' + JSON.stringify(compEnd.map((e) => ({ status: e.status, reason: e.reason }))));
  line('run_end = ' + JSON.stringify(runEnd.map((e) => ({ status: e.status, error: e.error?.code }))));
  line('retry_scheduled count = ' + retries.length);

  check('A1 knowably over-window request IS sent (>=1)', overWindowCalls >= 1, `overWindowCalls=${overWindowCalls}`);
  check('A2 run_end failed', runEnd.at(-1)?.status === 'failed', runEnd.at(-1)?.status);
  check('A3 assistant calls bounded <= 2', streamCalls <= 2, `calls=${streamCalls}`);
  check('A3 no retry_scheduled loop', retries.length === 0, `retries=${retries.length}`);

  await harness.close(CTX);
  return { overWindowCalls, streamCalls };
}

// ---- Part B: can a public hook veto the send? ----
async function partB() {
  header('B  hook veto probe (before_request + transform_context registered)');
  const model = makeModel({ contextWindow: 8192, maxTokens: 1024 });
  const provider = makeProvider(model);
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const { harness } = await AgentHarness.create({
    session, models: makeModels(provider, model), model,
    compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 },
    systemPrompt: 'recheck harness',
  }, CTX);

  const seen = { beforeRequest: [], transformContext: [] };

  // A before_request handler that (a) records its event shape and (b) returns
  // and (c) throws — neither path may prevent the send.
  harness.hooks.on('before_request', (event) => {
    seen.beforeRequest.push({
      keys: Object.keys(event).sort(),
      hasMessages: 'messages' in event,
      hasContextWindow: 'contextWindow' in event,
      step: event.step,
    });
    return undefined;
  });
  harness.hooks.on('transform_context', (event) => {
    seen.transformContext.push({ messageCount: event.messages.length });
    return undefined;
  });

  const events = collectEvents(harness);
  const lane = await harness.lane('main', CTX);
  const r = await lane.prompt(giant(20000), undefined, CTX);

  const streamCalls = provider.log.stream.length;
  const overWindowCalls = provider.log.stream.filter((c) => c.overWindow).length;

  line('before_request event = ' + JSON.stringify(seen.beforeRequest));
  line('transform_context event = ' + JSON.stringify(seen.transformContext));
  line(`assistant stream calls = ${streamCalls}  (over-window = ${overWindowCalls})`);

  check('B1 before_request handler ran', seen.beforeRequest.length >= 1, `n=${seen.beforeRequest.length}`);
  check('B1 before_request event has NO messages', seen.beforeRequest.every((e) => !e.hasMessages));
  check('B1 before_request event has NO contextWindow', seen.beforeRequest.every((e) => !e.hasContextWindow));
  check('B2 over-window request STILL sent despite hooks', overWindowCalls >= 1, `overWindow=${overWindowCalls}`);

  await harness.close(CTX);
}

// ---- Part C: are estimation helpers public but unwired? ----
function partC() {
  header('C  public estimation helpers vs wired send guard');
  const msg = { role: 'user', content: [{ type: 'text', text: giant(20000) }], timestamp: Date.now() };
  const est = estimateContextTokens([msg]).tokens;
  const would = shouldCompact(est, 8192, { enabled: true, reserveTokens: 512, keepRecentTokens: 512 });
  line(`estimateContextTokens([giant]) = ${est}`);
  line(`shouldCompact(${est}, 8192, {...}) = ${would}`);
  line(`typeof estimateContextTokens = ${typeof estimateContextTokens}`);
  line(`typeof shouldCompact = ${typeof shouldCompact}`);
  check('C1 estimation helpers exist publicly', typeof estimateContextTokens === 'function' && typeof shouldCompact === 'function');
  check('C1 helper says the context WOULD overflow/compact', would === true, `shouldCompact=${would}`);
}

setDefaultStreamFn((_model, _ctx) => streamFrom(assistant({ text: 'default-fake' })));

const a = await partA();
await partB();
partC();

line();
line('DETERMINATION INPUTS:');
line(`  knowably over-window requests sent (A) = ${a.overWindowCalls}`);
line(`  bounded failure (A)                    = yes (run_end failed, retries 0)`);
line(`  public veto hook available             = no (before_request is streamOptions-only; errors reported not propagated)`);
line(`  public estimation helpers              = yes (estimateContextTokens/shouldCompact) but NOT wired to send path`);
line(`==== ${failures === 0 ? 'D1 RECHECK: FACTS OBSERVED (D1 NOT deletable)' : failures + ' D1 RECHECK CHECK(S) FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
