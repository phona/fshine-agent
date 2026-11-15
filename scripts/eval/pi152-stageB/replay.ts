#!/usr/bin/env node
/**
 * 阶段 B · G3 真实模型重放（`step-3.7-flash`，迁移后 AgentSession 整链路）。
 * 预注册：.runtime/pi152-stageB/prereg.md §2.3（N=1/场景、一次采样、不重跑）。
 *
 * 装配只用公开导出 + 产品注册函数：
 *   createAgentSession / SessionManager / SettingsManager（pi-coding-agent root）
 *   createPiModelRuntime / piCompactionSettings（packages/agent/src/pi-driver.ts）
 * 压缩配置 = 产品函数 piCompactionSettings(16384)（= reserve 4096 / keepRecent 4915）。
 *
 * HTTP 请求体在传输层记录（包裹 globalThis.fetch），用于判定摘要请求是否带 max_tokens。
 */
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime, piCompactionSettings } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';
import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { SCENARIOS } from './scenarios';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_ROOT = path.join(REPO, '.runtime', 'pi152-stageB');

const MODEL_ID = process.env.LLM_MODEL ?? 'step-3.7-flash';
const CONTEXT_WINDOW = 16_384;
const MAX_TOKENS = 2_048;
const THINKING_LEVEL = 'off';
const TURN_TIMEOUT_MS = 10 * 60_000;
const LIMITS = { maxModelCalls: 60, maxTokens: 1_200_000, wallMs: 40 * 60_000 };

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

// ---------------------------------------------------------------- HTTP body capture
interface HttpRec {
  at: number; turn: number; path: string; status?: number; model?: string;
  hasMaxTokens: boolean; maxTokensField: 'max_tokens' | 'max_completion_tokens' | null;
  maxTokens: number | null; stream?: boolean;
  msgCount: number | null; isSummary: boolean; bodyBytes: number;
}
const httpLog: HttpRec[] = [];
let currentTurn = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  let body: Record<string, unknown> | undefined;
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = undefined; }
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const msgs = Array.isArray(body?.messages) ? (body?.messages as unknown[]) : [];
  const msgsText = JSON.stringify(msgs);
  const rec: HttpRec = {
    at: Date.now(), turn: currentTurn, path: (() => { try { return new URL(url).pathname; } catch { return url; } })(),
    model: typeof body?.model === 'string' ? body.model : undefined,
    hasMaxTokens: body?.max_tokens !== undefined || body?.max_completion_tokens !== undefined,
    maxTokensField: body?.max_tokens !== undefined ? 'max_tokens' : body?.max_completion_tokens !== undefined ? 'max_completion_tokens' : null,
    maxTokens: (body?.max_tokens as number | undefined) ?? (body?.max_completion_tokens as number | undefined) ?? null,
    stream: body?.stream as boolean | undefined,
    msgCount: msgs.length,
    isSummary: msgsText.includes('summarization assistant') || msgsText.includes('<conversation>'),
    bodyBytes: typeof init?.body === 'string' ? init.body.length : 0,
  };
  httpLog.push(rec);
  const res = await realFetch(input as never, init);
  rec.status = res.status;
  return res;
}) as typeof fetch;

// ---------------------------------------------------------------- per-call records (runtime proxy)
interface CallRec {
  kind: string; callIndex: number; turn: number; start: number; end: number | null; ms: number | null;
  stopReason: string | null; error: string | null;
  usage: { input: number; output: number; totalTokens: number; reasoning: number } | null;
  reqMaxTokens: number | null; isSummary: boolean; msgCount: number;
}
function isSummaryContext(ctx: { systemPrompt?: string; messages?: unknown[] }): boolean {
  const sys = typeof ctx?.systemPrompt === 'string' ? ctx.systemPrompt : '';
  if (sys.includes('summar')) return true;
  const msgs = Array.isArray(ctx?.messages) ? ctx.messages : [];
  const first = msgs[0] as { role?: string; content?: unknown } | undefined;
  if (first?.role !== 'system') return false;
  const text = Array.isArray(first.content)
    ? first.content.filter((c: { type?: string }) => c?.type === 'text').map((c: { text?: string }) => c.text ?? '').join('')
    : typeof first.content === 'string' ? first.content : '';
  return text.includes('summar');
}

function wrapRuntime(real: { streamSimple: (...a: never[]) => unknown }, records: CallRec[]) {
  const make = (kind: string, ctx: { systemPrompt?: string; messages?: unknown[] }, opts: { maxTokens?: number } | undefined) => {
    const rec: CallRec = {
      kind, callIndex: records.length, turn: currentTurn, start: Date.now(), end: null, ms: null,
      stopReason: null, error: null, usage: null,
      reqMaxTokens: Number(opts?.maxTokens ?? 0) || null,
      isSummary: isSummaryContext(ctx),
      msgCount: Array.isArray(ctx?.messages) ? ctx.messages.length : 0,
    };
    records.push(rec);
    return rec;
  };
  const capture = (rec: CallRec, msg: {
    usage?: { input?: number; output?: number; totalTokens?: number; reasoning?: number };
    stopReason?: string; errorMessage?: string;
  } | undefined) => {
    if (msg?.usage) {
      rec.usage = {
        input: Number(msg.usage.input ?? 0), output: Number(msg.usage.output ?? 0),
        totalTokens: Number(msg.usage.totalTokens ?? 0), reasoning: Number(msg.usage.reasoning ?? 0),
      };
    }
    if (msg?.stopReason) rec.stopReason = msg.stopReason;
    if (msg?.errorMessage) rec.error = String(msg.errorMessage).slice(0, 400);
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'streamSimple') {
        return (model: never, ctx: never, opts: never) => {
          const rec = make('stream', ctx as never, opts as never);
          const stream = (target.streamSimple as Function)(model, ctx, opts) as {
            [Symbol.asyncIterator]?: () => AsyncIterator<{ type?: string; message?: never; reason?: string; error?: unknown }>;
            result?: () => Promise<never>;
          };
          return new Proxy(stream, {
            get(st, p) {
              if (p === Symbol.asyncIterator) {
                return () => {
                  const it = (st[Symbol.asyncIterator] as () => AsyncIterator<{ type?: string; message?: never; reason?: string; error?: unknown }>)();
                  return {
                    next: async () => {
                      const n = await it.next();
                      if (n.done) { rec.end ??= Date.now(); rec.ms = rec.end - rec.start; }
                      else if (n.value?.type === 'done') {
                        capture(rec, n.value.message as never);
                        rec.end ??= Date.now(); rec.ms = rec.end - rec.start;
                      } else if (n.value?.type === 'error') {
                        rec.stopReason = n.value.reason ?? 'error';
                        rec.error = JSON.stringify(n.value.error ?? {}).slice(0, 400);
                      }
                      return n;
                    },
                    return: it.return === undefined ? undefined : it.return.bind(it),
                    throw: it.throw === undefined ? undefined : it.throw.bind(it),
                  };
                };
              }
              if (p === 'result') {
                return async () => {
                  const r = await (st.result as () => Promise<never>)();
                  rec.end ??= Date.now(); rec.ms = rec.end - rec.start;
                  capture(rec, r as never);
                  return r;
                };
              }
              const v = Reflect.get(st, p, st);
              return typeof v === 'function' ? v.bind(st) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------- dummy execution layer (in-memory)
const DUMMY: Record<string, { items: Array<{ id: string; name: string; value: number }>; windows: string[] }> = {
  alpha: {
    items: [{ id: 'rec-001', name: 'alpha-item-1', value: 1200 }, { id: 'rec-002', name: 'alpha-item-2', value: 800 }],
    windows: ['W1', 'W2'],
  },
  beta: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], windows: ['W1'] },
};
const execLog: Array<{ turn: number; operation: string; args: string }> = [];
let recordSeq = 0;
const createdRecords: string[] = [];

function bridgeExecute(params: { operation?: string; args?: { collection?: string; id?: string } }) {
  const operation = String(params?.operation ?? '');
  const args = params?.args ?? {};
  execLog.push({ turn: currentTurn, operation, args: JSON.stringify(args) });
  if (operation === 'query') {
    const data = DUMMY[String(args.collection ?? '')];
    if (data === undefined) {
      return { status: 'failed', code: 'not_found', message: `collection ${String(args.collection)} 不存在`, available: Object.keys(DUMMY) };
    }
    return { status: 'completed', collection: args.collection, records: data.items.length, items: data.items, windows: data.windows };
  }
  if (operation === 'create_record') {
    recordSeq += 1;
    createdRecords.push(`${String(args.id ?? '')}#${recordSeq}`);
    return { status: 'completed', seq: recordSeq };
  }
  return {
    status: 'failed', code: 'unsupported_operation',
    message: `本会话只接了 Execution Contract 查询桥；${operation || '(空)'} 不受支持，未做任何动作。`,
  };
}

const bridgeTool = {
  name: 'bridge_exec',
  label: 'Bridge Exec',
  description: 'Execution Contract bridge: run one structured execution-layer request {operation, args}. Read-only dummy execution layer; only operation="query" is available.',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', description: 'Operation name (e.g. query).' },
      args: { type: 'object', description: 'Operation arguments, e.g. {collection:"alpha"}.', additionalProperties: true },
    },
    required: ['operation'],
    additionalProperties: true,
  },
  execute: async (_toolCallId: string, params: never) => {
    const result = bridgeExecute(params);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
  },
};

function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '').join('');
    }
  }
  return '';
}

async function main() {
  const scenarioId = argValue('scenario', 'A');
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`未知场景 ${scenarioId}`);
  const outDir = path.join(OUT_ROOT, argValue('out', scenarioId));
  rmSync(path.join(outDir, 'events.jsonl'), { force: true });
  mkdirSync(path.join(outDir, 'cwd'), { recursive: true });
  mkdirSync(path.join(outDir, 'agent'), { recursive: true });
  mkdirSync(path.join(outDir, 'sessions'), { recursive: true });

  const records: CallRec[] = [];
  const useFake = process.argv.includes('--fake');
  const maxTurns = Math.min(Number(argValue('turns', String(scenario.turns.length))), scenario.turns.length);
  let raw: { getModel: (providerId: string, modelId: string) => Model<any> | undefined; streamSimple: (...a: never[]) => unknown };
  if (useFake) {
    // 自检用：确定性假 stream（不联网、不烧模型）。窗口 4096 以便快速触发一次压缩。
    const fake = await createScriptedModelRuntime({
      contextWindow: 4_096, maxTokens: 2_048,
      script: (i, ctx) => {
        if (isSummaryContext(ctx as never)) {
          return { role: 'assistant', content: [{ type: 'text', text: '摘要：自检。' }], api: 'openai-completions', provider: 'llm', model: 'test-model', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as never;
        }
        if (i % 2 === 0) {
          return { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'bridge_exec', arguments: { operation: 'query', args: { collection: 'alpha' } } }], api: 'openai-completions', provider: 'llm', model: 'test-model', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() } as never;
        }
        return { role: 'assistant', content: [{ type: 'text', text: '好的。' }], api: 'openai-completions', provider: 'llm', model: 'test-model', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as never;
      },
    });
    raw = fake.runtime as never;
    void createAssistantMessageEventStream;
  } else {
    raw = await createPiModelRuntime(process.env as Record<string, string | undefined>, MODEL_ID, {
      contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    }) as never;
  }
  const runtime = wrapRuntime(raw as never, records);
  const modelId = useFake ? 'test-model' : MODEL_ID;
  const model = raw.getModel('llm', modelId);
  if (!model) throw new Error('模型未注册');

  const compaction = piCompactionSettings(useFake ? 4_096 : CONTEXT_WINDOW);
  const sessionManager = SessionManager.create(path.join(outDir, 'cwd'), path.join(outDir, 'sessions'));
  const { session } = await createAgentSession({
    cwd: path.join(outDir, 'cwd'),
    agentDir: path.join(outDir, 'agent'),
    model,
    modelRuntime: runtime as never,
    thinkingLevel: THINKING_LEVEL,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction }),
    customTools: [bridgeTool as never],
    tools: ['bridge_exec'],
  });

  const events: Array<Record<string, unknown>> = [];
  const compactions: Array<Record<string, unknown>> = [];
  const rec = (type: string, e: Record<string, unknown>) => {
    const entry: Record<string, unknown> = { at: Date.now(), turn: currentTurn, type };
    if (type === 'compaction_start') entry.reason = e.reason;
    if (type === 'compaction_end') {
      entry.reason = e.reason;
      entry.status = e.result === undefined ? 'failed' : 'completed';
      entry.errorMessage = e.errorMessage;
      entry.willRetry = e.willRetry;
      const r = e.result as { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number; usage?: unknown } | undefined;
      if (r !== undefined) {
        const summary = typeof r.summary === 'string' ? r.summary : '';
        entry.summaryChars = [...summary].length;
        entry.summaryHead = [...summary].slice(0, 120).join('');
        entry.tokensBefore = r.tokensBefore;
        entry.estimatedTokensAfter = r.estimatedTokensAfter ?? null;
        entry.compactionUsage = r.usage ?? null;
        compactions.push({
          turn: currentTurn, at: Date.now(), reason: e.reason, summaryChars: entry.summaryChars,
          summary, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter ?? null,
          usage: r.usage ?? null,
        });
      } else {
        compactions.push({ turn: currentTurn, at: Date.now(), reason: e.reason, failed: true, errorMessage: e.errorMessage });
      }
    }
    if (type === 'auto_retry_start') entry.attempt = e.attempt;
    if (type === 'auto_retry_end') entry.success = e.success;
    if (type === 'summarization_retry_scheduled') entry.attempt = e.attempt;
    events.push(entry);
    appendFileSync(path.join(outDir, 'events.jsonl'), JSON.stringify(entry) + '\n');
  };
  for (const t of ['compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start']) {
    session.subscribe((e: { type?: string }) => { if (e?.type === t) rec(t, e as Record<string, unknown>); });
  }

  const startedAt = Date.now();
  const turns: Array<Record<string, unknown>> = [];
  let stoppedAtLimit = false;

  for (let i = 0; i < maxTurns; i += 1) {
    const turnPrompt = scenario.turns[i];
    if (turnPrompt === undefined) break;
    currentTurn = i + 1;
    const t0 = Date.now();
    const callBefore = records.length;
    const compBefore = compactions.length;
    let error: string | null = null;
    let timedOut = false;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.prompt(turnPrompt),
        new Promise((_, reject) => { turnTimer = setTimeout(() => reject(new Error(`turn_timeout_${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (error.includes('turn_timeout')) { timedOut = true; try { await session.abort(); } catch { /* ignore */ } }
    } finally {
      if (turnTimer !== undefined) clearTimeout(turnTimer);
    }
    try { await session.waitForIdle(); } catch { /* ignore */ }

    const messages = (session.messages ?? []) as readonly { role?: string; timestamp?: number; content?: unknown }[];
    const fresh = messages.filter((m) => m.role === 'assistant' && Number(m.timestamp ?? 0) >= t0 - 500);
    const textOf = (m: { content?: unknown }): string => {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text ?? '').join('');
      return '';
    };
    const lastFresh = fresh[fresh.length - 1];
    const replyFresh = lastFresh === undefined ? '' : textOf(lastFresh);
    turns.push({
      turn: currentTurn,
      planned: turnPrompt.slice(0, 40),
      error, timedOut,
      reply: replyFresh,
      replyLen: [...replyFresh].length,
      replyLastAssistant: lastAssistantText(messages),
      assistantCount: fresh.length,
      callBefore, callAfter: records.length,
      compactionBefore: compBefore, compactionAfter: compactions.length,
      hasFact: JSON.stringify(messages).includes('蓝鲸-42'),
      wallMs: Date.now() - t0,
    });

    const tokens = records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0);
    const wall = Date.now() - startedAt;
    if (records.length > LIMITS.maxModelCalls || tokens > LIMITS.maxTokens || wall > LIMITS.wallMs) {
      stoppedAtLimit = true;
      break;
    }
  }

  // 压缩后首个主请求的 provider prompt tokens
  const postCompactFirst: Array<Record<string, unknown>> = [];
  for (const c of compactions.filter((x) => x.failed !== true)) {
    const at = Number(c.at);
    const next = records.find((r) => r.start >= at && !r.isSummary);
    if (next?.usage) {
      postCompactFirst.push({
        turn: c.turn, compactionAt: at, callIndex: next.callIndex,
        promptTokens: next.usage.totalTokens - next.usage.output,
        outputTokens: next.usage.output, stopReason: next.stopReason,
      });
    }
  }

  const summary = {
    scenario: scenario.name, scenarioId, mode: 'pi-1.5.2-createAgentSession-product-config',
    model: MODEL_ID, configuredContextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_TOKENS,
    compactionSettings: compaction, thinkingLevel: THINKING_LEVEL,
    tools: ['bridge_exec'], turns: turns.length, plannedTurns: scenario.turns.length,
    wallMs: Date.now() - startedAt,
    modelCalls: records.length,
    summaryCalls: records.filter((r) => r.isSummary).length,
    totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0),
    totalInputTokens: records.reduce((s, r) => s + (r.usage?.input ?? 0), 0),
    totalOutputTokens: records.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
    compactionStarts: events.filter((e) => e.type === 'compaction_start').length,
    completedCompactionCount: compactions.filter((c) => c.failed !== true).length,
    failedCompactionCount: compactions.filter((c) => c.failed === true).length,
    failedCompactions: compactions.filter((c) => c.failed === true),
    summaryCharsList: compactions.filter((c) => c.failed !== true).map((c) => ({ turn: c.turn, summaryChars: c.summaryChars })),
    emptySummaryCount: compactions.filter((c) => c.failed !== true && c.summaryChars === 0).length,
    summaryCallErrors: records.filter((r) => r.isSummary && r.stopReason !== 'stop')
      .map((r) => ({ callIndex: r.callIndex, turn: r.turn, stopReason: r.stopReason, output: r.usage?.output ?? null, reasoning: r.usage?.reasoning ?? null })),
    summaryCallAll: records.filter((r) => r.isSummary).map((r) => ({
      callIndex: r.callIndex, turn: r.turn, stopReason: r.stopReason,
      reqMaxTokens: r.reqMaxTokens, output: r.usage?.output ?? null, reasoning: r.usage?.reasoning ?? null,
      input: r.usage?.input ?? null, total: r.usage?.totalTokens ?? null,
    })),
    autoRetries: events.filter((e) => e.type === 'auto_retry_start').length,
    summarizationRetries: events.filter((e) => e.type === 'summarization_retry_scheduled').length,
    postCompactFirstRequests: postCompactFirst,
    overWindowCount: postCompactFirst.filter((p) => Number(p.promptTokens) > CONTEXT_WINDOW).length,
    emptyTurns: turns.filter((t) => String(t.reply).trim() === '').length,
    emptyTurnList: turns.filter((t) => String(t.reply).trim() === '').map((t) => ({ turn: t.turn, error: t.error })),
    staleReplyTurns: turns.filter((t) => String(t.reply).trim() === '' && String(t.replyLastAssistant).trim() !== '')
      .map((t) => ({ turn: t.turn, staleReply: String(t.replyLastAssistant).slice(0, 60) })),
    stoppedAtLimit,
    toolExecCount: execLog.length,
    duplicateToolExecs: findDuplicates(execLog),
    createdRecords,
    httpSummaryRequests: httpLog.filter((h) => h.isSummary).map((h) => ({
      turn: h.turn, status: h.status, model: h.model, hasMaxTokens: h.hasMaxTokens,
      maxTokens: h.maxTokens, msgCount: h.msgCount, bodyBytes: h.bodyBytes,
    })),
    httpMainRequestsMaxTokensAbsent: httpLog.filter((h) => !h.isSummary).every((h) => !h.hasMaxTokens),
    httpCaptured: httpLog.length,
    httpCaptureFailed: httpLog.length === 0,
  };

  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(outDir, 'turns.json'), JSON.stringify(turns, null, 2));
  writeFileSync(path.join(outDir, 'compactions.json'), JSON.stringify(compactions, null, 2));
  writeFileSync(path.join(outDir, 'model-calls.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(path.join(outDir, 'http.jsonl'), httpLog.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(path.join(outDir, 'execs.json'), JSON.stringify(execLog, null, 2));
  process.stdout.write(JSON.stringify({
    scenarioId, turns: turns.length, modelCalls: records.length,
    totalTokens: summary.totalTokens, wallMs: summary.wallMs,
    compactions: compactions.length, emptyTurns: summary.emptyTurns, stoppedAtLimit,
  }));
}

function findDuplicates(log: Array<{ turn: number; operation: string; args: string }>) {
  const seen = new Map<string, number>();
  for (const e of log) {
    const key = `${e.turn}|${e.operation}|${e.args}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([key, n]) => ({ key, count: n }));
}

await main();
