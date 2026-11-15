// Minimal-plan-B verification fixture (phase 3).
//
// Independently built for this run. It does NOT consume the guard-authored
// tripwire-b.mjs. It exercises the minimal-B driver in minimal-b.mjs and
// answers, with observed facts (zero real model):
//
//   Q1  Does the single fshine pre-request budget check cover the FIRST
//       request of a run?              (D1 rerun: unsalvageable over-window)
//   Q2  Does it (or ANY public Pi seam) cover a CONTINUATION request issued
//       after a tool result overflows the window?
//   plus the required behaviour matrix at windows 8192 / 40k / 128k:
//       compactible / non-compactible / tool-result overflow / summary failure /
//       bounded recovery / task executed exactly once.
//
// Reverse tripwire: everything the guard relies on is asserted to FAIL when the
// single check is bypassed (allowOverWindow) — run with:
//       FSHINE_B_REVERSE=1 node verify-minimal-b.mjs
// which must exit non-zero.
//
// Exit 0 = facts observed (Q1 yes, Q2 no). Exit 1 = a check unexpectedly failed.

import { Type } from 'typebox';
import {
  createMinimalBDriver, makeModel, makeResponder, makeModels,
  assistant, streamFrom, usage, toolCall, collectEvents, laneTranscript,
} from './minimal-b.mjs';

const REVERSE = process.env.FSHINE_B_REVERSE === '1';

let failures = 0;

const line = (s = '') => console.log(s);
function header(t) { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); }
function check(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}
// A guard assertion. Normal mode: it must hold. Reverse mode (FSHINE_B_REVERSE=1,
// the single check is deliberately bypassed): it MUST break — a guard assertion
// that still passes means the tripwire has no teeth.
function checkGuarded(label, cond, detail) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${label}  (reverse=${REVERSE})`
    + `${detail !== undefined ? '  -> ' + detail : ''}`);
  return ok;
}

const SYSPROMPT = 'You are a test harness.';
const WINDOWS = [8192, 40000, 128000];

// ---------------------------------------------------------------- Q1 / D1 rerun

async function q1_firstRequest(W) {
  header(`Q1 / D1 rerun  unfixable over-window FIRST request  @ W=${W}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  const resp = makeResponder({
    stream: () => streamFrom(assistant({ text: 'ok', usage: usage(10) })),
    complete: () => assistant({ text: 'SUM' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
  });
  const events = collectEvents(driver.harness);

  line(`budget = ${driver.budget} (window ${W})`);
  const giant = 'z'.repeat(W * 4);
  let refused = false;
  try {
    // In reverse mode the guard is deliberately bypassed here.
    await driver.run({ userText: giant, allowOverWindow: REVERSE });
  } catch (error) {
    refused = error.name === 'PreRequestBudgetRefusal';
    line(`  refused: ${error.name}: ${error.message}`);
  }
  const sent = resp.log.stream.length;
  const over = resp.log.stream.filter((c) => c.promptTokens > W - model.maxTokens).length;
  line(`provider stream calls = ${sent} (over-window = ${over})  refused=${refused}`);
  line('run_end = ' + JSON.stringify(events.filter((e) => e.type === 'run_end').map((e) => e.status)));

  checkGuarded(`W=${W}: single check bounded-refuses the unfixable input`, refused === true);
  checkGuarded(`W=${W}: knowably over-window requests sent == 0`, over === 0, `sent=${sent} over=${over}`);
  checkGuarded(`W=${W}: zero provider stream calls`, sent === 0, `calls=${sent}`);

  await driver.close();
}

async function q1_control_overWindowIsSent(W) {
  header(`Q1 control  bypass the single check -> over-window request IS sent  @ W=${W}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  const resp = makeResponder({
    stream: () => streamFrom(assistant({ text: 'ok', usage: usage(10) })),
    complete: () => assistant({ text: 'SUM' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
  });
  const giant = 'z'.repeat(W * 4);
  await driver.run({ userText: giant, allowOverWindow: true });
  const sent = resp.log.stream.length;
  const over = resp.log.stream.filter((c) => c.promptTokens > W - model.maxTokens).length;
  line(`provider stream calls = ${sent} (over-window = ${over})`);
  // Positive control: the single check is load-bearing — bypassing it lets a
  // knowably over-window request out (this is also what reverse mode exercises).
  check(`W=${W}: bypassing the check sends a knowably over-window request`, over >= 1, `over=${over}`);
  await driver.close();
}

// ------------------------------------------------------------------ Q2 continuation

function bigResultTool(tokens, counter) {
  return {
    name: 'bigtool', description: 'Returns a large payload.', label: 'Big',
    parameters: Type.Object({}),
    execute: async () => {
      if (counter) counter.n += 1;
      return { content: [{ type: 'text', text: 'R'.repeat(tokens * 4) }], details: {} };
    },
  };
}

async function q2_toolResultOverflow(W, { hooks } = {}) {
  header(`Q2  tool-result continuation overflows window  @ W=${W}${hooks ? '  (with veto-attempt hooks)' : ''}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  const execCount = { n: 0 };
  let first = true;
  const resp = makeResponder({
    stream: () => {
      if (first) {
        first = false;
        return streamFrom(assistant({ stopReason: 'toolUse', toolCalls: [toolCall('tc-1', 'bigtool', {})], usage: usage(10) }));
      }
      return streamFrom(assistant({ text: 'done', usage: usage(10) }));
    },
    complete: () => assistant({ text: 'SUM' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    tools: [bigResultTool(W, execCount)], activeToolNames: ['bigtool'],
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 500 },
  });
  const unsubs = [];
  if (hooks) {
    for (const name of ['transform_context', 'before_payload', 'before_request']) {
      unsubs.push(driver.harness.hooks.on(name, () => { throw new Error(`${name} veto attempt`); }));
    }
  }
  const runEnds = [];
  driver.harness.events.on('run_end', (e) => runEnds.push(e));

  // First request is small ('go'): passes the single check.
  let errored;
  try { await driver.run({ userText: 'go' }); } catch (e) { errored = e; }
  const sent = resp.log.stream.length;
  const over = resp.log.stream.filter((c) => c.promptTokens > W - model.maxTokens).length;
  line(`run threw = ${errored ? errored.name : 'no'}  stream calls = ${sent}  over-window = ${over}`);
  line(`tool executions = ${execCount.n}`);
  line('run_end = ' + JSON.stringify(runEnds.map((e) => ({ status: e.status, error: e.error?.code }))));

  check(`W=${W}: first request passed the check (small)`, errored === undefined, errored?.name);
  check(`W=${W}: a continuation request was emitted after the tool result`, sent >= 2, `calls=${sent}`);
  // The finding: B cannot prevent this over-window continuation.
  check(`W=${W}: over-window continuation WAS sent (Q2 = NO)`, over >= 1, `over=${over}`);
  check(`W=${W}: task executed exactly once (no duplicate run)`, execCount.n === 1, `executions=${execCount.n}`);
  for (const u of unsubs) u();
  await driver.close();
}

// ------------------------------------------------------------------ compactible

async function compactible(W) {
  header(`compactible  threshold compaction by Pi owns the shrink  @ W=${W}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  const budget = W - 4096 - 1024 - Math.ceil(SYSPROMPT.length / 4);
  const perTurn = Math.floor(budget / 2.5);      // 2*perTurn = 0.8*budget  <= budget
  const reserve = W - Math.floor(perTurn * 1.5); // threshold = 1.5*perTurn  < 2*perTurn
  line(`budget≈${budget} perTurn=${perTurn} reserve=${reserve} threshold=${W - reserve}`);
  const resp = makeResponder({
    stream: (i, ctx) => streamFrom(assistant({
      text: 'A'.repeat(perTurn * 2),
      usage: usage(Math.ceil(JSON.stringify(ctx.messages).length / 4)),
    })),
    complete: () => assistant({ text: 'PI-SUMMARY' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: Math.floor(perTurn / 2) },
  });
  const events = collectEvents(driver.harness);

  let turns = 0;
  let errored;
  try {
    for (let i = 0; i < 4; i += 1) { await driver.run({ userText: 'x'.repeat(perTurn * 4) }); turns += 1; }
  } catch (e) { errored = e; }
  const compactions = events.filter((e) => e.type === 'compaction_end');
  const sent = resp.log.stream.length;
  const over = resp.log.stream.filter((c) => c.promptTokens > W - model.maxTokens).length;
  line(`turns sent = ${turns}  threw = ${errored ? errored.name : 'no'}`);
  line('compaction_end = ' + JSON.stringify(compactions.map((e) => ({ status: e.status, reason: e.reason }))));
  line(`stream calls = ${sent}  over-window = ${over}`);

  check(`W=${W}: Pi performed a completed compaction (no host code)`,
    compactions.some((c) => c.status === 'completed'), JSON.stringify(compactions.map((c) => c.status)));
  check(`W=${W}: no knowably over-window request was sent`, over === 0, `over=${over}`);
  check(`W=${W}: the run kept going after compaction enough turns`, turns >= 3, `turns=${turns}`);
  await driver.close();
}

// ------------------------------------------------------------------ summary failure

async function summaryFailure(W) {
  header(`summary failure  bounded (no unbounded retry)  @ W=${W}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  const budget = W - 4096 - 1024;
  const perTurn = Math.floor(budget / 2.5);
  const reserve = W - Math.floor(perTurn * 1.5);
  const resp = makeResponder({
    stream: (i, ctx) => streamFrom(assistant({
      text: 'A'.repeat(perTurn * 2),
      usage: usage(Math.ceil(JSON.stringify(ctx.messages).length / 4)),
    })),
    complete: () => assistant({ stopReason: 'error', errorMessage: '500 summarizer down' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: Math.floor(perTurn / 2) },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  });
  const events = collectEvents(driver.harness);

  let errored;
  try {
    for (let i = 0; i < 3; i += 1) await driver.run({ userText: 'x'.repeat(perTurn * 4) });
  } catch (e) { errored = e; }
  const retries = events.filter((e) => e.type === 'retry_scheduled');
  const compactions = events.filter((e) => e.type === 'compaction_end');
  line(`completeSimple calls = ${resp.log.complete.length}`);
  line('retry_scheduled = ' + JSON.stringify(retries.map((e) => ({ step: e.step, attempt: e.attempt, max: e.maxAttempts }))));
  line('compaction_end = ' + JSON.stringify(compactions.map((c) => ({ status: c.status }))));

  check(`W=${W}: summary attempts bounded to maxAttempts (=3)`, resp.log.complete.length <= 3, `calls=${resp.log.complete.length}`);
  check(`W=${W}: compaction_end reports failed`, compactions.some((c) => c.status === 'failed'));
  check(`W=${W}: no unwindowed over-window request was sent`,
    resp.log.stream.filter((c) => c.promptTokens > W - model.maxTokens).length === 0);
  await driver.close();
}

// ------------------------------------------------------------------ bounded recovery

async function boundedRecovery(W) {
  header(`bounded recovery  overflow error -> one native recovery -> success  @ W=${W}`);
  const model = makeModel({ contextWindow: W, maxTokens: 1024 });
  let first = true;
  const resp = makeResponder({
    stream: () => {
      if (first) {
        first = false;
        return streamFrom(assistant({ stopReason: 'error', errorMessage: 'prompt is too long: 999999 tokens > maximum context length' }));
      }
      return streamFrom(assistant({ text: 'recovered', usage: usage(10) }));
    },
    complete: () => assistant({ text: 'OVERFLOW-SUMMARY' }),
  });
  const driver = await createMinimalBDriver({
    model, models: makeModels(resp, model), systemPrompt: SYSPROMPT,
    compaction: { enabled: true, reserveTokens: Math.floor(W * 0.3), keepRecentTokens: 200 },
  });
  const events = collectEvents(driver.harness);
  let errored;
  try { await driver.run({ userText: 'overflow please' }); } catch (e) { errored = e; }
  const starts = events.filter((e) => e.type === 'compaction_start');
  const runEnds = events.filter((e) => e.type === 'run_end');
  line('compaction_start reasons = ' + JSON.stringify(starts.map((e) => e.reason)));
  line('run_end = ' + JSON.stringify(runEnds.map((e) => ({ status: e.status }))));
  line(`stream calls = ${resp.log.stream.length}  threw = ${errored ? errored.name : 'no'}`);

  check(`W=${W}: exactly one overflow recovery`, starts.filter((e) => e.reason === 'overflow').length === 1);
  check(`W=${W}: run_end completed after recovery`, runEnds.at(-1)?.status === 'completed', runEnds.at(-1)?.status);
  check(`W=${W}: assistant stream calls bounded (<=2)`, resp.log.stream.length <= 2, `calls=${resp.log.stream.length}`);
  await driver.close();
}

// ------------------------------------------------------------------ main

// Evidence-only: the public hook contracts that lack any request abort.
function hookContractEvidence() {
  header('B3  public hook contracts (0.85.1) — none can abort a model request');
  line('file: node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts');
  line('  transform_context :510 event{messages,systemPrompt} result{messages?,systemPrompt?}  transform only');
  line('  before_request    :520 event{model,step,attempt,streamOptions} result{streamOptions?}  no messages/window');
  line('  before_payload    :531 event{model,payload} result{payload}  replace only, no abort');
  line('  before_tool       :550 result{args?,block?}  blocks a TOOL, not a request');
  line('  before_compaction :582 result{decline?,compaction?}  declines COMPACTION, not a send');
}

for (const W of WINDOWS) {
  await q1_firstRequest(W);
  await q1_control_overWindowIsSent(W);
}
await q2_toolResultOverflow(8192);
await q2_toolResultOverflow(40000, { hooks: true });
for (const W of WINDOWS) await compactible(W);
await summaryFailure(8192);
for (const W of WINDOWS) await boundedRecovery(W);
hookContractEvidence();

line();
line(`Q1 (first request covered by single check) = YES`);
line(`Q2 (tool-result continuation covered by any public seam) = NO`);
line(`reverse-tripwire mode = ${REVERSE}`);
line(`==== failures=${failures} ====`);
process.exit(failures === 0 ? 0 : 1);
