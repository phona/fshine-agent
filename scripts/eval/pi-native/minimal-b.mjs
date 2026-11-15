// Minimal-plan-B driver (experiment artifact, phase 3 validation).
//
// Definition B under test:
//   Pi native Session/Harness owns ALL compaction + overflow recovery; fshine
//   keeps EXACTLY ONE pre-request budget check (no compactTranscriptWithPi, no
//   host summarization / trimming / degradation / retry).
//
// This module is the minimal-B driver itself. It contains NO host-side
// compaction code: no summary prompt, no split, no trim, no degrade, no
// re-compaction retry loop. The only fshine decision is the single
// `preRequestBudgetCheck` that runs BEFORE the harness is ever invoked.
//
// Public entry points only (no private API, no copied Pi source):
//   AgentHarness, setDefaultStreamFn, estimateContextTokens  <- pi-agent-core (root)
//   MemorySessionRepo                                       <- pi-agent-core/harness/session
//   BACKGROUND_CONTEXT                                      <- pi-agent-core/harness/context
//   createAssistantMessageEventStream                       <- pi-ai/utils/event-stream

import { AgentHarness, setDefaultStreamFn, estimateContextTokens } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const CTX = BACKGROUND_CONTEXT;

// Same fixed-overhead accounting as the shipped P0-B INV line, so the single
// retained check is the *same kind* of check the product keeps. Kept minimal:
// framing (serialization/round-trip) + minimum output budget + sys/tools markup.
export const FRAMING_TOKENS = 4096;
export const MIN_OUTPUT_TOKENS = 1024;

export function fixedRequestOverheadTokens(systemPrompt, tools) {
  const sys = Math.ceil(systemPrompt.length / 4);
  const toolsText = tools
    .map((t) => `${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.parameters ?? {})}`)
    .join('\n');
  return FRAMING_TOKENS + sys + Math.ceil(toolsText.length / 4);
}

/** Deterministic bounded-failure error raised by the single fshine gate. */
export class PreRequestBudgetRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreRequestBudgetRefusal';
  }
}

// ------------------------------------------------------------ fake provider bits

const cost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
export const usage = (totalTokens) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: cost() });

export function makeModel({ contextWindow = 128000, maxTokens = 1024 } = {}) {
  return {
    id: 'fake-model', name: 'Fake Model', api: 'fake-api', provider: 'fake',
    baseUrl: 'http://localhost', reasoning: false, input: ['text'],
    cost: { ...cost(), tiers: [] }, contextWindow, maxTokens,
  };
}

export function assistant({ text = '', stopReason = 'stop', errorMessage, usage: u, toolCalls } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (toolCalls) content.push(...toolCalls);
  return {
    role: 'assistant', content, api: 'fake-api', provider: 'fake', model: 'fake-model',
    usage: u ?? usage(0), stopReason, errorMessage, timestamp: Date.now(),
  };
}

export const toolCall = (id, name, args = {}) => ({ type: 'toolCall', id, name, arguments: args });

/** Wrap one AssistantMessage into a real AssistantMessageEventStream. */
export function streamFrom(message) {
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

/**
 * Provider-side pre-dispatch size proxy: the fake provider KNOWS whether a
 * request is over-window before accepting it (same char/4 heuristic the whole
 * experiment uses). Every streamSimple call is logged.
 */
export const est = (messages) => Math.ceil(JSON.stringify(messages).length / 4);

export function makeResponder({ stream, complete }) {
  const log = { stream: [], complete: [] };
  return {
    log,
    streamFn: (model, ctx) => {
      log.stream.push({ messages: ctx.messages, promptTokens: est(ctx.messages) });
      return stream(log.stream.length - 1, ctx);
    },
    completeFn: (model, ctx) => {
      log.complete.push({ messages: ctx.messages });
      return complete(log.complete.length - 1, ctx);
    },
  };
}

/** Minimal object satisfying the pi-ai Models surface the harness consumes. */
export function makeModels(resp, model) {
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

export function collectEvents(harness) {
  const events = [];
  for (const type of [
    'compaction_start', 'compaction_end', 'run_end', 'retry_scheduled', 'retry_end', 'turn_end', 'tool_end', 'handler_error',
  ]) {
    harness.events.on(type, (e) => events.push(e));
  }
  return events;
}

export async function entriesAscending(lane) {
  const entries = await lane.findEntries(undefined, CTX);
  return [...entries].sort((a, b) => a.seq - b.seq);
}

/**
 * Reconstruct fshine's view of the transcript from the harness lane tip.
 * Pi owns the transcript; fshine only reads it back to run its single
 * pre-request budget check on the NEXT request. Compaction entries replace
 * everything before them with `summary` + `retainedTail`.
 */
export async function laneTranscript(lane) {
  const entries = await entriesAscending(lane);
  let messages = [];
  for (const e of entries) {
    if (e.type === 'compaction') {
      messages = [
        { role: 'user', content: `【summary】${e.summary ?? ''}` },
        ...(e.retainedTail ?? []),
      ];
    } else if (e.type === 'message') {
      messages.push(e.message);
    }
  }
  return messages;
}

// ------------------------------------------------------------------ the driver

/**
 * createMinimalBDriver: the whole minimal-B driver.
 *
 * fshine's responsibilities are exactly two:
 *   1. hold the (read-back) transcript view;
 *   2. run the single pre-request budget check before each `run()`.
 * Everything else — triggering compaction, executing the summary, cutting,
 * retaining the tail, recovering from overflow — is Pi's, driven through the
 * public AgentHarness + CompactionSettings + RetryPolicy.
 */
export async function createMinimalBDriver({
  model,
  models,
  tools = [],
  activeToolNames,
  systemPrompt = '',
  compaction,
  retry,
  history = [],
}) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, CTX);
  const handle = await AgentHarness.create(
    { session, models, model, tools, activeToolNames, systemPrompt, compaction, retry },
    CTX,
  );
  const harness = handle.harness;
  const lane = await harness.lane('main', CTX);
  const budget = model.contextWindow - fixedRequestOverheadTokens(systemPrompt, tools) - MIN_OUTPUT_TOKENS;

  // fshine's seed view (empty in the full-Pi path: Pi owns the transcript).
  let transcript = [...history];

  return {
    harness,
    lane,
    model,
    budget,
    get transcript() { return transcript; },

    /**
     * The single fshine pre-request budget check (B retains exactly this).
     * Returns { tokens, budget, over }.
     */
    preRequestBudgetCheck(nextRequestMessages) {
      const tokens = estimateContextTokens(nextRequestMessages).tokens;
      return { tokens, budget, over: tokens > budget };
    },

    /**
     * Run one turn. `userText` is the current user message.
     *
     * allowOverWindow is ONLY for the reverse tripwire / control fixtures: it
     * models a build WITHOUT the single check, to prove the check is load
     * bearing. Production never sets it.
     */
    async run({ userText, allowOverWindow = false }) {
      const userMsg = { role: 'user', content: userText, timestamp: Date.now() };
      const nextRequest = [...transcript, userMsg];
      const check = this.preRequestBudgetCheck(nextRequest);
      if (!allowOverWindow && check.over) {
        // Bounded failure BEFORE any request: zero harness/provider calls.
        throw new PreRequestBudgetRefusal(
          `pre-request budget exceeded: ${check.tokens} > ${check.budget} (window=${model.contextWindow})`,
        );
      }
      const res = await lane.prompt(userText, undefined, CTX);
      transcript = await laneTranscript(lane);
      return { ok: res.ok, error: res.ok ? undefined : res.error, check };
    },

    async close() { await harness.close(CTX); },
  };
}

setDefaultStreamFn((_model, _ctx) => streamFrom(assistant({ text: 'default-fake' })));
