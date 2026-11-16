// B-viability tripwire on the Pi-native harness path (owner decision 2/3/4).
//
// Definition B under test:
//   Pi native Session/Harness owns ALL compaction + overflow recovery; fshine
//   keeps exactly ONE pre-request budget check (no old compactTranscriptWithPi,
//   no host summarization/trim/degrade/retry).
//
// Question: does that single fshine budget check cover
//   (Q1) the FIRST model request of a run, and
//   (Q2) the CONTINUATION requests emitted after a tool result (same run)?
//
// Method (zero real model: fake Models + fake stream fn):
//   B1  prove the pre-run budget check DOES gate the first request (refuse ->
//       0 sends); control: without the check the over-window request IS sent.
//   B2  start with a fitting first request; the assistant calls a tool whose
//       RESULT is over-window; the harness then emits a continuation. Show the
//       continuation IS sent over-window, and that public hooks
//       (transform_context / before_payload / before_request, even THROWING)
//       cannot veto it. => Q2 = NO.
//   B3  cite the public hook contracts (file:line) that lack any abort/block.
//
// Public entry points only (no private API, no copied Pi source):
//   AgentHarness, setDefaultStreamFn                    <- @earendil-works/pi-agent-core (root)
//   MemorySessionRepo                                   <- .../harness/session
//   BACKGROUND_CONTEXT                                  <- .../harness/context
//   createAssistantMessageEventStream                   <- @earendil-works/pi-ai/utils/event-stream
//
// Exit 0 = facts observed (check covers first request only; continuation NOT).
// Exit 1 = a CHECK unexpectedly failed.

import { AgentHarness, setDefaultStreamFn, estimateContextTokens } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Type } from 'typebox';

const CTX = BACKGROUND_CONTEXT;
const cost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const usage = (t) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: t, cost: cost() });

const model = {
  id: 'fake-model', name: 'Fake', api: 'fake-api', provider: 'fake', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], cost: { ...cost(), tiers: [] }, contextWindow: 8192, maxTokens: 1024,
};
// fshine's "single pre-request budget check" mirrors the shipped INV line:
// budget = contextWindow - (framing + MIN_OUTPUT); here we use W - maxTokens as
// the conservative request-vs-window budget the fake provider also enforces.
const BUDGET = model.contextWindow - model.maxTokens; // 7168

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

// Provider-side pre-dispatch size proxy (same char/4 the experiment uses): the
// fake provider KNOWS a request is over-window before accepting it.
const est = (messages) => Math.ceil(JSON.stringify(messages).length / 4);

// ---- fshine's ONE pre-request budget check (the only fshine gate B retains) --
function preRequestBudgetCheck(messages) {
  const tokens = estimateContextTokens(messages).tokens;
  return { tokens, over: tokens > BUDGET, budget: BUDGET };
}

function makeProvider() {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (_m, ctx) => {
      const promptTokens = est(ctx.messages);
      const overWindow = promptTokens > BUDGET;
      log.stream.push({ promptTokens, overWindow, nMessages: ctx.messages.length });
      if (overWindow) {
        return streamFrom(asst({ stopReason: 'error',
          errorMessage: `prompt is too long: ${promptTokens} > ${model.contextWindow} maximum context length` }));
      }
      return streamFrom(asst({ text: 'ok', usage: usage(10) }));
    },
    completeFn: () => asst({ text: 'PI-SUM' }),
  };
}

function makeModels(resp) {
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

// A tool whose RESULT is itself large enough to blow the window. `counter` lets
// a scenario assert the task is executed exactly ONCE across a recovery.
const bigResultTool = (tokens, counter) => ({
  name: 'bigtool', description: 'Returns a large payload.', label: 'Big',
  parameters: Type.Object({}),
  execute: async () => {
    if (counter) counter.n += 1;
    return { content: [{ type: 'text', text: 'R'.repeat(tokens * 4) }], details: {} };
  },
});

async function buildHarness({ resp, compaction, tools = [], activeToolNames, hooks } = {}) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const handle = await AgentHarness.create(
    { session, models: makeModels(resp), model, compaction, tools, activeToolNames, systemPrompt: 'test harness' },
    CTX,
  );
  const unsubs = [];
  if (hooks) for (const [name, fn] of Object.entries(hooks)) unsubs.push(handle.harness.hooks.on(name, fn));
  return { harness: handle.harness, unsubs };
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

// -------------------------------------------------------------------- B1

async function b1_firstRequestCovered() {
  header('B1  pre-run budget check covers the FIRST request');
  const resp = makeProvider();
  const { harness } = await buildHarness({ resp, compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 } });
  const lane = await harness.lane('main', CTX);

  // Build the intended first request as a fshine transcript (user giant message).
  const giant = { role: 'user', content: 'z'.repeat(20000 * 4), timestamp: Date.now() };
  const gate = preRequestBudgetCheck([giant]);
  line(`fshine pre-check: tokens=${gate.tokens} budget=${gate.budget} over=${gate.over}`);

  // WITH the check: refuse => do not call the harness at all.
  if (gate.over) {
    line('  -> fshine REFUSES before harness.run(); zero provider calls');
  } else {
    await lane.prompt('z'.repeat(20000 * 4), undefined, CTX);
  }
  const sentWithCheck = resp.log.stream.length;
  line(`stream calls WITH fshine pre-check = ${sentWithCheck}`);

  check('fshine pre-check flags the input as over-window', gate.over === true, `over=${gate.over}`);
  check('(Q1) with the check: zero requests sent', sentWithCheck === 0, `calls=${sentWithCheck}`);

  // CONTROL: without the check, the same over-window input is sent.
  const resp2 = makeProvider();
  const h2 = await buildHarness({ resp: resp2, compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 } });
  const lane2 = await h2.harness.lane('main', CTX);
  await lane2.prompt('z'.repeat(20000 * 4), undefined, CTX);
  const sentWithout = resp2.log.stream.length;
  const overWithout = resp2.log.stream.filter((c) => c.overWindow).length;
  line(`stream calls WITHOUT fshine pre-check = ${sentWithout}  (over-window = ${overWithout})`);
  check('control: without the check the over-window request IS sent', overWithout >= 1, `overWindow=${overWithout}`);

  await harness.close(CTX);
  await h2.harness.close(CTX);
}

// -------------------------------------------------------------------- B2

async function b2_continuationNotCoverable() {
  header('B2  continuation after a tool result is NOT coverable by any public seam');
  const resp = makeProvider();
  const execCount = { n: 0 };
  // First assistant answer -> tool call; tool returns an over-window result; the
  // harness then emits a continuation carrying that result.
  let first = true;
  resp.streamFn = (_m, ctx) => {
    const promptTokens = est(ctx.messages);
    const overWindow = promptTokens > BUDGET;
    resp.log.stream.push({ promptTokens, overWindow, nMessages: ctx.messages.length });
    if (overWindow) {
      return streamFrom(asst({ stopReason: 'error',
        errorMessage: `prompt is too long: ${promptTokens} > ${model.contextWindow} maximum context length` }));
    }
    if (first) {
      first = false;
      return streamFrom(asst({ stopReason: 'toolUse', toolCalls: [toolCall('tc-1', 'bigtool', {})], usage: usage(10) }));
    }
    return streamFrom(asst({ text: 'done', usage: usage(10) }));
  };

  // Public hooks that TRY to veto every continuation: they throw. If throwing
  // could veto the dispatch, no over-window continuation would be sent.
  const hooks = {
    transform_context: () => { throw new Error('transform_context veto attempt'); },
    before_payload: () => { throw new Error('before_payload veto attempt'); },
    before_request: () => { throw new Error('before_request veto attempt'); },
  };

  const { harness, unsubs } = await buildHarness({
    resp, compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 },
    tools: [bigResultTool(20000, execCount)], activeToolNames: ['bigtool'], hooks,
  });
  const lane = await harness.lane('main', CTX);
  const runEnds = [];
  harness.events.on('run_end', (e) => runEnds.push(e));

  // The first request (small user msg) passes the fshine pre-check.
  const gate = preRequestBudgetCheck([{ role: 'user', content: 'go', timestamp: Date.now() }]);
  line(`fshine pre-check on first request: tokens=${gate.tokens} over=${gate.over}`);
  check('first request passes the pre-run check', gate.over === false, `over=${gate.over}`);

  const r = await lane.prompt('go', undefined, CTX);
  const sent = resp.log.stream.length;
  const over = resp.log.stream.filter((c) => c.overWindow).length;
  line(`lane.prompt ok=${r.ok}  stream calls=${sent}  over-window=${over}`);
  line(`run_end = ${JSON.stringify(runEnds.map((e) => ({ status: e.status, error: e.error?.code })))}`);
  line('stream sizes = ' + JSON.stringify(resp.log.stream.map((c) => c.promptTokens)));

  check('(Q2) continuation over-window request WAS sent despite hooks', over >= 1, `overWindow=${over}`);
  check('(Q2) throwing public hooks did NOT veto the send', sent >= 2, `calls=${sent}`);
  line(`tool executions = ${execCount.n}`);
  check('task executed exactly once (no duplicate run after overflow)', execCount.n === 1, `executions=${execCount.n}`);

  for (const u of unsubs) u();
  await harness.close(CTX);
}

// -------------------------------------------------------------------- B3

function b3_hookContracts() {
  header('B3  public hook contracts (from shipped d.ts) — none can abort a send');
  line('file: node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts');
  line('  transform_context  :510  event{messages,systemPrompt}  result{messages?,systemPrompt?}  -> transform only, NO abort/block');
  line('  before_request     :520  event{model,step,attempt,streamOptions}  result{streamOptions?}  -> no messages/payload/window');
  line('  before_payload     :531  event{model,payload}  result{payload}  -> replace payload only, NO abort/block');
  line('  before_tool        :550  result{args?,block?}  -> can block a TOOL, not a model request');
  line('  before_run         :486  result{messages?}  -> pre-run rewrite only, no size gate');
  line('  before_compaction  :582  result{decline?,compaction?}  -> can decline COMPACTION, not a send');
  line('invocation sites (dist js):');
  line('  runtime/drive/generation.js:120 transform_context -> {messages: result?.messages ?? ctx.messages}');
  line('  runtime/drive/generation.js:128 before_payload    -> result?.payload');
  line('  overflow recovery is POST-response: runtime/drive/response.js:111');
  line('  threshold compaction is at checkpoint: runtime/drive/structural.js:863 (shouldCompact)');
}

setDefaultStreamFn((_m, _ctx) => streamFrom(asst({ text: 'default-fake' })));

await b1_firstRequestCovered();
await b2_continuationNotCoverable();
b3_hookContracts();

line();
line('DETERMINATION:');
line('  Q1 first request covered by fshine single pre-run budget check ... YES (refuse)');
line('  Q2 tool-result continuation covered by any public seam ......... NO (sent; hooks cannot veto)');
line(`==== ${failures === 0 ? 'B TRIPWIRE: FACTS OBSERVED (B does NOT cover continuation)' : failures + ' CHECK(S) FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
