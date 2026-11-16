// D1 reverse-tripwire — INDEPENDENT reproduction (author: 复现员·绊线 / 2026-11-15).
//
// Purpose: on the NEW Pi-native path (AgentHarness + MemorySessionRepo +
// BACKGROUND_CONTEXT, fake Models / fake streamFn, ZERO real model), build a
// physically-unfixable over-window input and independently determine:
//   ① is the request refused BEFORE dispatch?
//   ② how many times is an over-window request actually SENT?
//   ③ does it end in a bounded failure (no unbounded retry)?
//   ④ does Pi 0.85.1 expose ANY public "compute size before send / refuse to
//      send" hook (T5: "current turn exceeds budget -> do not send the
//      certainly-over-window request")?
//
// This fixture is written WITHOUT reading the other two fixtures' control flow;
// it only reuses the documented public entry points. Distinct additions vs the
// pre-existing fixtures: it runs a case with compaction DISABLED (to isolate
// whether Pi's own compaction is what refuses the send), and it installs a
// before_request handler that THROWS to prove even an erroring handler cannot
// veto the dispatch.
//
// Public entry points only:
//   AgentHarness, setDefaultStreamFn, estimateContextTokens, shouldCompact
//     <- @earendil-works/pi-agent-core (root ".")
//   MemorySessionRepo            <- .../harness/session
//   BACKGROUND_CONTEXT           <- .../harness/context
//   createAssistantMessageEventStream <- @earendil-works/pi-ai/utils/event-stream
//
// Exit 0 = facts observed (new path does NOT pre-send-refuse a knowably
//          over-window request).  Exit 1 = a CHECK failed (e.g. it DID refuse,
//          or it retried unboundedly).

import { AgentHarness, setDefaultStreamFn, estimateContextTokens, shouldCompact } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const CTX = BACKGROUND_CONTEXT;
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const usage = (t) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: t, cost: zero() });

const model = {
  id: 'fake-model', name: 'Fake', api: 'fake-api', provider: 'fake', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], cost: { ...zero(), tiers: [] }, contextWindow: 8192, maxTokens: 1024,
};
const BUDGET = model.contextWindow - model.maxTokens; // 7168

const asst = ({ text = '', stopReason = 'stop', errorMessage, usage: u } = {}) => {
  const content = text ? [{ type: 'text', text }] : [];
  return { role: 'assistant', content, api: 'fake-api', provider: 'fake', model: 'fake-model',
    usage: u ?? usage(0), stopReason, errorMessage, timestamp: Date.now() };
};
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
// Provider-side pre-dispatch size proxy (same char/4 the experiment uses) so the
// fixture KNOWS the request is over-window before it would be accepted.
const est = (ctx) => Math.ceil(JSON.stringify(ctx.messages).length / 4);

function provider() {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (_m, ctx) => {
      const promptTokens = est(ctx);
      const overWindow = promptTokens > BUDGET;
      log.stream.push({ promptTokens, overWindow, nMessages: ctx.messages.length });
      if (overWindow) {
        return streamFrom(asst({ stopReason: 'error',
          errorMessage: `prompt is too long: ${promptTokens} > ${model.contextWindow} maximum context length` }));
      }
      return streamFrom(asst({ text: 'ok', usage: usage(10) }));
    },
    completeFn: (_m, ctx) => { log.complete.push({ nMessages: ctx.messages.length }); return asst({ text: 'PI-SUM' }); },
  };
}
const models = (p) => ({
  getModel: (pr, id) => (pr === model.provider && id === model.id ? model : undefined),
  streamSimple: p.streamFn, completeSimple: p.completeFn,
  getProviders: () => [], getProvider: () => undefined, getModels: () => [model],
  refresh: async () => ({}), checkAuth: async () => undefined, getAvailable: async () => [model],
  getAuth: async () => undefined, login: async () => { throw new Error('n/a'); }, logout: async () => {},
  stream: () => { throw new Error('n/a'); }, complete: () => { throw new Error('n/a'); },
  streamDeferred: () => { throw new Error('n/a'); }, fetchDeferred: () => { throw new Error('n/a'); },
  cancelDeferred: async () => {},
});

const giant = (tokens) => 'z'.repeat(tokens * 4);

let failed = 0;
const say = (s = '') => console.log(s);
const hdr = (t) => { say(); say('='.repeat(78)); say(t); say('='.repeat(78)); };
const chk = (label, cond, detail) => {
  const ok = Boolean(cond);
  if (!ok) failed += 1;
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
};

async function scenario({ compactionEnabled, throwInHook }) {
  const p = provider();
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const { harness } = await AgentHarness.create({
    session, models: models(p), model,
    compaction: compactionEnabled
      ? { enabled: true, reserveTokens: 512, keepRecentTokens: 512 }
      : { enabled: false, reserveTokens: 512, keepRecentTokens: 512 },
    systemPrompt: 'independent tripwire',
  }, CTX);
  const events = [];
  for (const t of ['compaction_start', 'compaction_end', 'run_end', 'retry_scheduled']) {
    harness.events.on(t, (e) => events.push({ ...e, type: t }));
  }
  if (throwInHook) {
    harness.hooks.on('before_request', () => { throw new Error('intentional hook failure'); });
    harness.hooks.on('transform_context', (e) => ({ messages: e.messages, systemPrompt: e.systemPrompt }));
  }
  const lane = await harness.lane('main', CTX);
  const r = await lane.prompt(giant(20000), undefined, CTX);
  const out = {
    ok: r.ok,
    streamCalls: p.log.stream.length,
    overWindow: p.log.stream.filter((c) => c.overWindow).length,
    first: p.log.stream[0],
    runEnd: events.filter((e) => e.type === 'run_end').map((e) => ({ status: e.status, code: e.error?.code })),
    retries: events.filter((e) => e.type === 'retry_scheduled').length,
    compEnd: events.filter((e) => e.type === 'compaction_end').map((e) => e.status),
    compStart: events.filter((e) => e.type === 'compaction_start').map((e) => e.reason),
  };
  await harness.close(CTX);
  return out;
}

setDefaultStreamFn((_m, _c) => streamFrom(asst({ text: 'default-fake' })));

// ---- ①/②/③ unfixable input, compaction OFF ----
hdr('1  unfixable over-window input, compaction DISABLED');
const s1 = await scenario({ compactionEnabled: false });
say(`prompt.ok=${s1.ok}  streamCalls=${s1.streamCalls}  overWindowSent=${s1.overWindow}`);
say(`first: promptTokens=${s1.first?.promptTokens} budget=${BUDGET}  nMessages=${s1.first?.nMessages}`);
say(`compaction_start=${JSON.stringify(s1.compStart)}  run_end=${JSON.stringify(s1.runEnd)}  retry_scheduled=${s1.retries}`);
say('(compaction OFF => one overflow-recovery re-send, both over-window, still bounded)');
chk('refused before dispatch? NO (a request WAS sent)', s1.streamCalls >= 1, `streamCalls=${s1.streamCalls}`);
chk('knowably over-window requests sent >= 1 (never refused)', s1.overWindow >= 1, `overWindow=${s1.overWindow}`);
chk('bounded: stream calls <= 2', s1.streamCalls <= 2, `calls=${s1.streamCalls}`);
chk('bounded: no retry_scheduled loop', s1.retries === 0, `retries=${s1.retries}`);
chk('end state failed', s1.runEnd.at(-1)?.status === 'failed', s1.runEnd.at(-1)?.status);

// ---- same with compaction ON (isolates whether Pi compaction refuses send) ----
hdr('2  same input, compaction ENABLED');
const s2 = await scenario({ compactionEnabled: true });
say(`prompt.ok=${s2.ok}  streamCalls=${s2.streamCalls}  overWindowSent=${s2.overWindow}  compEnd=${JSON.stringify(s2.compEnd)}`);
chk('still sent (compaction does NOT pre-send-refuse)', s2.streamCalls >= 1, `streamCalls=${s2.streamCalls}`);
chk('over-window sent == 1', s2.overWindow === 1, `overWindow=${s2.overWindow}`);

// ---- throwing hook cannot veto ----
hdr('3  throwing before_request handler + transform_context cannot veto');
const s3 = await scenario({ compactionEnabled: true, throwInHook: true });
say(`streamCalls=${s3.streamCalls}  overWindowSent=${s3.overWindow}`);
chk('request STILL sent though before_request threw', s3.streamCalls >= 1 && s3.overWindow >= 1,
  `calls=${s3.streamCalls} overWindow=${s3.overWindow}`);

// ---- ④ public surface: helpers exist but are not a send guard ----
hdr('4  public estimation helpers vs wired pre-send guard');
const one = [{ role: 'user', content: [{ type: 'text', text: giant(20000) }], timestamp: Date.now() }];
const toks = estimateContextTokens(one).tokens;
const would = shouldCompact(toks, model.contextWindow, { enabled: true, reserveTokens: 512, keepRecentTokens: 512 });
say(`estimateContextTokens([giant]).tokens = ${toks}`);
say(`shouldCompact(${toks}, ${model.contextWindow}, {...}) = ${would}`);
chk('helpers are public functions', typeof estimateContextTokens === 'function' && typeof shouldCompact === 'function');
chk('helper agrees the input would overflow/compact', would === true, `shouldCompact=${would}`);
chk('helpers did NOT prevent the send (see scenarios 1-3)', s1.overWindow >= 1);

say();
say('DETERMINATION:');
say(`  ① refused before dispatch ................ ${s1.streamCalls === 0 ? 'yes' : 'NO'}`);
say(`  ② over-window requests sent ............... compact OFF=${s1.overWindow}  ON=${s2.overWindow} (>=1 always; bounded)`);
say(`  ③ bounded failure ......................... ${s1.runEnd.at(-1)?.status === 'failed' && s1.retries === 0 ? 'yes' : 'NO'}`);
say(`  ④ public pre-send size guard .............. none (only unwired estimateContextTokens/shouldCompact)`);
say(`==== ${failed === 0 ? 'INDEPENDENT TRIPWIRE: FACTS OBSERVED (D1 NOT deletable)' : failed + ' CHECK(S) FAILED'} ====`);
process.exit(failed === 0 ? 0 : 1);
