#!/usr/bin/env node
/**
 * Pi Runtime 复用实验 · 1.5.2 AgentSession 重放（真实模型 step-3.7-flash）。
 *
 * 只用公开导出：
 *   - @earendil-works/pi-coding-agent root: createAgentSession / SessionManager / SettingsManager / ModelRuntime
 *   - @earendil-works/pi-ai root: createAssistantMessageEventStream（仅 --fake 确定性自检用）
 *
 * 重放「阶段四补」(.runtime/r5p4fix/) 的失败输入（用户回合文本逐字取自
 * scripts/eval/pi-native/r5p4fix-real.ts 的 scenarios()），窗口/输出/压缩设置同样保持
 * 16,384 / 2,048 / {reserve 4,096, keepRecent 4,915}（不调，见 prereg.md）。
 *
 * 用法：
 *   node --env-file=<repo>/.env scripts/eval/pi-runtime-experiment/replay.mjs --scenario=A
 *   node scripts/eval/pi-runtime-experiment/replay.mjs --scenario=A --fake   # 确定性自检，不烧模型
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'pi-runtime-experiment');

// ---------------------------------------------------------------- prereg config (frozen)
const MODEL_ID = 'step-3.7-flash';
const CONTEXT_WINDOW = 16_384;
const MAX_TOKENS = 2_048;
const COMPACTION = { enabled: true, reserveTokens: 4_096, keepRecentTokens: 4_915 };
const THINKING_LEVEL = 'off';
const LIMITS = { maxModelCalls: 80, maxTokens: 600_000, wallMs: 45 * 60_000 };
const TURN_TIMEOUT_MS = 10 * 60_000;

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------- scenarios (verbatim from r5p4fix-real.ts)
const FILLER = (n, tag) => {
  const sentences = [
    '把这件事拆成可执行的小步，每一步只解决一个明确的问题，做完就地记录事实。',
    '过程中的中间结论要能追溯到来源，不能凭印象补全，也不能把没发生的动作说成发生了。',
    '遇到信息不足时，先如实说明缺什么，再请对方补齐，不要自己替对方假设一个答案。',
    '结果交付时只讲用户看得懂的话，数字用平台返回的原文，不四舍五入也不修饰。',
    '长期运行要能续跑：状态可查、任务可数、失败可解释、取消要有回执。',
    '同一件事不要反复重做，重试只允许发生在失败之后，且必须能被审计追溯。',
    '任何结论都要给出依据；依据来自平台返回的事实，不是来自推测。',
  ];
  let out = '';
  for (let i = 0; i < n; i += 1) out += `[${tag}-${i}] ${sentences[i % sentences.length]}\n`;
  return out;
};
const fill = (tag, n = 130) => `背景补充（${tag}），读完即可，不需要做任何事：\n${FILLER(n, tag)}`;

const SCENARIOS = {
  A: {
    name: 'A-长对话连续压缩',
    turns: [
      `先记住两件必须一直遵守的事：(1) 我的项目代号是「蓝鲸-42」；(2) 你回答我时一律用简体中文。\n${fill('A1')}`,
      `请用 run_task 让执行层查一下 collection=alpha（窗口取 recent）的记录，把条数和第一条内容告诉我。`,
      fill('A2'),
      `把刚才 alpha 查询的结果再复述一遍：条数是多少？`,
      fill('A3'),
      fill('A4'),
      `现在回答我：我最开始让你记住的项目代号是什么？我要求你用哪种语言回答？`,
      `请再次用 run_task 查 collection=alpha 的记录并给出条数。`,
      fill('A5'),
      fill('A6'),
      `到目前为止我们已经聊过哪几个主题？请按时间顺序列一下。`,
      fill('A7'),
      fill('A8'),
      `再确认一次：项目代号、必须使用的语言，这两个你分别还记得吗？`,
      fill('A9'),
      `最后：请复述我最早那段背景（A1）的主题。`,
    ],
    // 0.85.1 阶段四补的空摘要回合（1-based）：6/9/12/15
    failureTurns: [6, 9, 12, 15],
  },
  B: {
    name: 'B-多任务交替交办',
    turns: [
      `交办第一个任务：用 run_task 让执行层查 collection=alpha（窗口 recent）的记录，统计条数。`,
      `交办第二个任务：用 run_task 查 topic=budget 的 ballot（窗口 recent）结果，说明票数。`,
      `用 task_status 看一下本会话现有任务，把编号和状态列出来。`,
      fill('B1', 160),
      `用 task_result 取回第一个任务（#1）的结果，原文告诉我。`,
      fill('B2', 160),
      fill('B3', 160),
      `请回答：我最先交办的第一个任务，它的编号是多少、结果是什么？不要编造，找不到就如实说。`,
      `对 #1 发起取消请求，并按返回的机械结果如实告诉我它现在的状态。`,
      fill('B4', 160),
      fill('B5', 160),
      `我们一共交办了几个任务？分别是几号、什么状态？`,
    ],
    // 0.85.1 阶段四补的压缩后空回复回合（1-based）
    failureTurns: [9],
  },
  C: {
    name: 'C-长会话稳定性',
    turns: [
      `第 1 段背景：\n${fill('C1')}`,
      `第 2 段背景：\n${fill('C2')}`,
      `用 run_task 查 collection=alpha（窗口 recent）记录，给出条数。`,
      `第 3 段背景：\n${fill('C3')}`,
      `第 4 段背景：\n${fill('C4')}`,
      `用 run_task 再查一次 collection=alpha 的记录。`,
      `第 5 段背景：\n${fill('C5')}`,
      `第 6 段背景：\n${fill('C6')}`,
      `请给出目前为止，你对我每一段背景的要点的一句话概括。`,
      `第 7 段背景：\n${fill('C7')}`,
      `第 8 段背景：\n${fill('C8')}`,
      `第 9 段背景：\n${fill('C9')}`,
      `请确认你仍能正常工作，并复述第 1 段背景的主题。`,
    ],
    failureTurns: [],
  },
};

// ---------------------------------------------------------------- dummy execution layer (in-memory)
const DUMMY = {
  collections: {
    alpha: {
      items: [{ id: 'rec-001', name: 'alpha-item-1', value: 1200 }, { id: 'rec-002', name: 'alpha-item-2', value: 800 }],
      windows: ['W1', 'W2'], records: { W1: 2, W2: 1 },
    },
    beta: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], windows: ['W1'], records: { W1: 1 } },
  },
};

function bridgeExecute(params) {
  const operation = String(params?.operation ?? '');
  const args = params?.args ?? {};
  const collection = String(args.collection ?? '');
  if (operation === 'query') {
    const data = DUMMY.collections[collection];
    if (data === undefined) {
      return { status: 'failed', code: 'not_found', message: `collection ${collection} 不存在`, available: Object.keys(DUMMY.collections) };
    }
    return { status: 'completed', collection, records: data.items.length, items: data.items, windows: data.windows };
  }
  return {
    status: 'failed',
    code: 'unsupported_operation',
    message: `本会话只接了 Execution Contract 查询桥（operation=query）；${operation || '(空)'} 不受支持，未做任何动作。`,
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
  execute: async (_toolCallId, params) => {
    const result = bridgeExecute(params);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
  },
};

// ---------------------------------------------------------------- accounting seam
function summarizeMsgs(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((raw) => {
    const m = raw ?? {};
    let text = '';
    const toolCalls = [];
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'text') text += block.text ?? '';
        if (block?.type === 'toolCall') toolCalls.push({ id: block.id ?? '', name: block.name ?? '' });
      }
    }
    return {
      role: m.role,
      textLen: [...text].length,
      head: [...text].slice(0, 60).join(''),
      toolCalls,
      ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId }),
      ...(m.toolName === undefined ? {} : { toolName: m.toolName }),
    };
  });
}

function isSummaryContext(ctx) {
  const sys = typeof ctx?.systemPrompt === 'string' ? ctx.systemPrompt : '';
  if (sys.includes('summar')) return true;
  const msgs = Array.isArray(ctx?.messages) ? ctx.messages : [];
  const first = msgs[0];
  if (first?.role !== 'system') return false;
  const blockText = Array.isArray(first.content)
    ? first.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('')
    : typeof first.content === 'string' ? first.content : '';
  return blockText.includes('summar');
}

function wrapRuntime(real, records) {
  const make = (kind, ctx, opts, model) => {
    const promptTokensIgnore = 0;
    const rec = {
      kind,
      callIndex: records.length,
      start: Date.now(),
      end: null,
      ms: null,
      stopReason: null,
      error: null,
      usage: null,
      reqMaxTokens: Number(opts?.maxTokens ?? 0) || null,
      isSummary: isSummaryContext(ctx),
      msgCount: Array.isArray(ctx?.messages) ? ctx.messages.length : 0,
      msgs: summarizeMsgs(ctx?.messages),
      toolCalls: [],
    };
    void promptTokensIgnore;
    records.push(rec);
    return rec;
  };
  const captureMessage = (rec, msg) => {
    if (msg?.usage) {
      rec.usage = {
        input: Number(msg.usage.input ?? 0),
        output: Number(msg.usage.output ?? 0),
        totalTokens: Number(msg.usage.totalTokens ?? 0),
        reasoning: Number(msg.usage.reasoning ?? 0),
      };
    }
    if (msg?.stopReason) rec.stopReason = msg.stopReason;
    if (msg?.errorMessage) rec.error = String(msg.errorMessage).slice(0, 400);
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) if (block?.type === 'toolCall') rec.toolCalls.push({ id: block.id ?? '', name: block.name ?? '' });
    }
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'streamSimple') {
        return (model, ctx, opts) => {
          const rec = make('stream', ctx, opts, model);
          const stream = target.streamSimple(model, ctx, opts);
          return new Proxy(stream, {
            get(st, p) {
              if (p === Symbol.asyncIterator) {
                return () => {
                  const it = st[Symbol.asyncIterator]();
                  return {
                    next: async () => {
                      const n = await it.next();
                      if (n.done) { rec.end ??= Date.now(); rec.ms = rec.end - rec.start; }
                      else if (n.value?.type === 'done') {
                        captureMessage(rec, n.value.message);
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
                  const r = await st.result();
                  rec.end ??= Date.now(); rec.ms = rec.end - rec.start;
                  captureMessage(rec, r);
                  return r;
                };
              }
              const v = Reflect.get(st, p, st);
              return typeof v === 'function' ? v.bind(st) : v;
            },
          });
        };
      }
      if (prop === 'completeSimple') {
        return async (model, ctx, opts) => {
          const rec = make('complete', ctx, opts, model);
          try {
            const m = await target.completeSimple(model, ctx, opts);
            rec.end = Date.now(); rec.ms = rec.end - rec.start;
            captureMessage(rec, m);
            return m;
          } catch (error) {
            rec.end = Date.now(); rec.ms = rec.end - rec.start;
            rec.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------- fake runtime (deterministic self-check only)
function fakeRuntime() {
  const model = {
    id: MODEL_ID, name: MODEL_ID, api: 'openai-completions', provider: 'llm',
    input: ['text'], reasoning: true, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const usage = (total) => ({ input: total - 40, output: 40, totalTokens: total, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  let calls = 0;
  const reply = (text, total = 300) => ({
    role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.id, usage: usage(total), stopReason: 'stop', timestamp: Date.now(),
  });
  const stream = (message) => {
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => { s.push({ type: 'done', reason: message.stopReason, message }); s.end(message); });
    return s;
  };
  return {
    getModel: (p, id) => (p === 'llm' && id === MODEL_ID ? model : undefined),
    getPhysicalModel: (p, id) => (p === 'llm' && id === MODEL_ID ? model : undefined),
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: 'fake-key' }, env: {} }),
    getAvailableSnapshot: () => [model],
    getModels: () => [model],
    getProviders: () => [],
    getError: () => undefined,
    getCompatibilityRequestConfig: () => ({}),
    resolveModel: async () => ({ model, thinkingLevel: 'off' }),
    registerProvider: () => {}, unregisterProvider: () => {}, registerNativeProvider: () => {},
    registerVirtualModel: () => {}, unregisterVirtualModel: () => {},
    streamSimple: (_model, ctx) => {
      calls += 1;
      if (isSummaryContext(ctx)) return stream(reply('【fake summary】 alpha=2 条，项目代号 蓝鲸-42。', 400));
      // 报告大 usage，强制触发压缩阈值（仅自检夹具）
      return stream(reply(`fake-reply-${calls}`, 15_000));
    },
    completeSimple: async () => reply('unused'),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const scenarioId = argValue('scenario', 'A');
  const scenario = SCENARIOS[scenarioId];
  if (scenario === undefined) throw new Error(`未知场景：${scenarioId}`);
  const fake = hasFlag('fake');

  const outDir = path.join(OUT_ROOT, scenarioId + (fake ? '-fake' : ''));
  const sessionDir = path.join(outDir, 'sessions');
  const workDir = path.join(outDir, 'cwd');
  const agentDir = path.join(outDir, 'agent');
  for (const d of [sessionDir, workDir, agentDir]) mkdirSync(d, { recursive: true });
  const eventsFile = path.join(outDir, 'events.jsonl');
  writeFileSync(eventsFile, '');
  const compactionsFile = path.join(outDir, 'compactions.json');
  const turnsFile = path.join(outDir, 'turns.json');
  const callsFile = path.join(outDir, 'model-calls.jsonl');
  const summaryFile = path.join(outDir, 'summary.json');
  for (const f of [compactionsFile, turnsFile]) writeFileSync(f, '[]');
  writeFileSync(callsFile, '');

  // --- runtime
  let runtime;
  if (fake) {
    runtime = fakeRuntime();
  } else {
    const baseUrl = (process.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = process.env.LLM_API_KEY ?? '';
    if (!baseUrl || !apiKey) throw new Error('缺 LLM_API_BASE_URL / LLM_API_KEY（不假装跑通）。');
    if ((process.env.LLM_MODEL ?? '') !== MODEL_ID) throw new Error(`模型必须固定 ${MODEL_ID}，实际 ${process.env.LLM_MODEL}`);
    runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('llm', {
      name: 'LLM',
      api: 'openai-completions',
      apiKey,
      models: [{
        id: MODEL_ID,
        name: MODEL_ID,
        api: 'openai-completions',
        baseUrl,
        reasoning: true,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
      }],
    });
  }

  const model = runtime.getModel('llm', MODEL_ID);
  if (!model) throw new Error(`模型 ${MODEL_ID} 未注册`);
  const records = [];
  const wrapped = wrapRuntime(runtime, records);

  const settingsManager = SettingsManager.inMemory({ compaction: { ...COMPACTION } });
  const sessionManager = SessionManager.create(workDir, sessionDir);

  const created = await createAgentSession({
    cwd: workDir,
    agentDir,
    model,
    modelRuntime: wrapped,
    thinkingLevel: THINKING_LEVEL,
    sessionManager,
    settingsManager,
    customTools: [bridgeTool],
    noTools: 'all',
    tools: ['bridge_exec'],
  });
  const session = created.session;

  // --- event capture
  const events = [];
  const compactions = [];
  let currentTurn = 0;
  const rec = (type, e) => {
    const entry = { at: Date.now(), turn: currentTurn, type };
    if (type === 'compaction_start') entry.reason = e?.reason;
    if (type === 'compaction_end') {
      entry.reason = e?.reason;
      entry.status = e?.result === undefined ? 'failed' : 'completed';
      entry.errorMessage = e?.errorMessage;
      entry.willRetry = e?.willRetry;
      entry.aborted = e?.aborted;
      const r = e?.result;
      if (r !== undefined) {
        const summary = typeof r.summary === 'string' ? r.summary : '';
        entry.summaryChars = [...summary].length;
        entry.summaryHead = [...summary].slice(0, 120).join('');
        entry.tokensBefore = r.tokensBefore;
        entry.estimatedTokensAfter = r.estimatedTokensAfter ?? null;
        entry.firstKeptEntryId = r.firstKeptEntryId ?? null;
        entry.compactionUsage = r.usage ?? null;
        compactions.push({
          turn: currentTurn, at: Date.now(), reason: e?.reason,
          summaryChars: entry.summaryChars, summary, summaryHead: entry.summaryHead,
          tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter ?? null,
          usage: r.usage ?? null,
        });
        writeFileSync(compactionsFile, JSON.stringify(compactions, null, 2));
      } else {
        compactions.push({ turn: currentTurn, at: Date.now(), reason: e?.reason, failed: true, errorMessage: e?.errorMessage });
        writeFileSync(compactionsFile, JSON.stringify(compactions, null, 2));
      }
    }
    if (type === 'auto_retry_start') { entry.attempt = e?.attempt; entry.maxAttempts = e?.maxAttempts; entry.errorMessage = String(e?.errorMessage ?? '').slice(0, 200); }
    if (type === 'auto_retry_end') { entry.success = e?.success; entry.attempt = e?.attempt; entry.finalError = String(e?.finalError ?? '').slice(0, 200); }
    if (type === 'summarization_retry_scheduled') { entry.attempt = e?.attempt; entry.maxAttempts = e?.maxAttempts; entry.errorMessage = String(e?.errorMessage ?? '').slice(0, 200); }
    if (type === 'summarization_retry_attempt_start') { entry.source = e?.source; entry.reason = e?.reason; }
    if (type === 'turn_end') entry.status = e?.status;
    if (type === 'agent_end') { entry.willRetry = e?.willRetry; entry.messageCount = Array.isArray(e?.messages) ? e.messages.length : null; }
    events.push(entry);
    appendFileSync(eventsFile, JSON.stringify(entry) + '\n');
  };
  for (const t of ['compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished', 'turn_end', 'agent_end']) {
    session.subscribe((e) => { if (e?.type === t) rec(t, e); });
  }

  const activeTools = session.getActiveToolNames();

  // --- turn loop
  const turns = [];
  const startedAt = Date.now();
  let stopped = false;
  const live = () => ({
    calls: records.length,
    tokens: records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0),
    wall: Date.now() - startedAt,
  });

  try {
    for (let i = 0; i < scenario.turns.length; i += 1) {
      currentTurn = i + 1;
      const text = scenario.turns[i];
      const t0 = Date.now();
      const callBefore = records.length;
      const compBefore = compactions.length;
      let reply = '';
      let error = null;
      let timedOut = false;
      try {
        await Promise.race([
          session.prompt(text),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`turn_timeout_${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS)),
        ]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (error.includes('turn_timeout')) {
          timedOut = true;
          try { await session.abort(); } catch { /* ignore */ }
        }
      }
      try { await session.waitForIdle(); } catch { /* ignore */ }
      // reply = assistant text produced during THIS turn. Pi omits truncated responses
      // (recoverable length) from session.messages, so "last assistant message" would be stale;
      // filter by message timestamp >= turn start instead.
      const assistants = (session.messages ?? []).filter((m) => m?.role === 'assistant');
      const fresh = assistants.filter((m) => Number(m.timestamp ?? 0) >= t0 - 500);
      reply = fresh
        .filter((m) => Array.isArray(m.content))
        .map((m) => m.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join(''))
        .join('');
      const lastAssistantText = assistants.at(-1)?.content;
      void lastAssistantText;
      const t1 = Date.now();

      const callSlice = records.slice(callBefore);
      const compSlice = compactions.slice(compBefore);
      const mainCalls = callSlice.filter((r) => !r.isSummary && r.kind === 'stream');
      const lastMain = mainCalls.at(-1);
      const replyByCallRule = lastMain !== undefined
        && lastMain.stopReason === 'stop'
        && (lastMain.usage?.output ?? 0) > 1;
      writeFileSync(callsFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      turns.push({
        index: i + 1,
        userLen: text.length,
        userHead: [...text].slice(0, 120).join(''),
        reply,
        replyEmpty: reply.trim() === '',
        replyByCallRule,
        replyRuleAgrees: (reply.trim() !== '') === replyByCallRule,
        error,
        timedOut,
        startedAt: t0,
        endedAt: t1,
        ms: t1 - t0,
        callIndexBefore: callBefore,
        callIndexAfter: records.length,
        callsThisTurn: callSlice.length,
        promptTokensThisTurn: callSlice.reduce((s, r) => s + Math.max(0, (r.usage?.totalTokens ?? 0) - (r.usage?.output ?? 0)), 0),
        compactionsThisTurn: compSlice.map((c) => ({ reason: c.reason, summaryChars: c.summaryChars, failed: c.failed === true, errorMessage: c.errorMessage })),
        failureTurn: scenario.failureTurns.includes(i + 1),
      });
      writeFileSync(turnsFile, JSON.stringify(turns, null, 2));

      const now = live();
      if (now.calls > LIMITS.maxModelCalls || now.tokens > LIMITS.maxTokens || now.wall > LIMITS.wallMs || timedOut) {
        stopped = true;
        console.warn(`[replay] 硬停：calls=${now.calls} tokens=${now.tokens} wallMs=${now.wall} timedOut=${timedOut}`);
        break;
      }
    }
  } finally {
    // --- P1/P2 readings
    const completedCompactions = compactions.filter((c) => c.failed !== true);
    // post-compaction first main request: first non-summary stream call starting after the compaction
    const postCompactFirstRequests = [];
    for (const c of completedCompactions) {
      const next = records.find((r) => r.start >= c.at && !r.isSummary && r.kind === 'stream');
      if (next === undefined) continue;
      postCompactFirstRequests.push({
        turn: c.turn,
        compactionEndAt: c.at,
        callIndex: next.callIndex,
        promptTokens: Math.max(0, (next.usage?.totalTokens ?? 0) - (next.usage?.output ?? 0)),
        outputTokens: next.usage?.output ?? 0,
        stopReason: next.stopReason,
        error: next.error,
      });
    }
    const emptyReplies = turns.filter((t) => t.replyEmpty === true);
    const emptyAfterCompaction = emptyReplies.filter((t) => {
      const priorCompactions = compactions.filter((c) => c.failed !== true && c.at <= t.startedAt);
      return priorCompactions.length > 0;
    });
    const emptySummaries = completedCompactions.filter((c) => c.summaryChars === 0);
    const failedCompactions = compactions.filter((c) => c.failed === true);
    const overWindow = postCompactFirstRequests.filter((r) => r.promptTokens > CONTEXT_WINDOW);
    const summaryCalls = records.filter((r) => r.isSummary);
    const summaryErrors = summaryCalls.filter((r) => r.error !== null || r.stopReason === 'length' || r.stopReason === 'error');
    const summary = {
      scenario: scenario.name,
      scenarioId,
      mode: fake ? 'fake-selfcheck' : 'agentsession-1.5.2-replay',
      model: MODEL_ID,
      provider: 'openai-completions',
      configuredContextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_TOKENS,
      compactionSettings: COMPACTION,
      thinkingLevel: THINKING_LEVEL,
      noTools: 'all',
      tools: ['bridge_exec'],
      activeToolNamesAtStart: activeTools,
      turns: turns.length,
      plannedTurns: scenario.turns.length,
      wallMs: Date.now() - startedAt,
      modelCalls: records.length,
      streamCalls: records.filter((r) => r.kind === 'stream').length,
      summaryCalls: summaryCalls.length,
      totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0),
      totalInputTokens: records.reduce((s, r) => s + (r.usage?.input ?? 0), 0),
      totalOutputTokens: records.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
      totalCost: 0,
      compactionStarts: events.filter((e) => e.type === 'compaction_start').length,
      completedCompactionCount: completedCompactions.length,
      completedCompactionReasons: completedCompactions.map((c) => c.reason),
      failedCompactionCount: failedCompactions.length,
      failedCompactions,
      emptySummaryCount: emptySummaries.length,
      emptySummaryTurns: emptySummaries.map((c) => c.turn),
      summaryCharsList: completedCompactions.map((c) => ({ turn: c.turn, summaryChars: c.summaryChars })),
      summaryCallErrors: summaryErrors.map((r) => ({ callIndex: r.callIndex, stopReason: r.stopReason, error: r.error, output: r.usage?.output ?? null })),
      autoRetries: events.filter((e) => e.type === 'auto_retry_start').length,
      summarizationRetries: events.filter((e) => e.type === 'summarization_retry_scheduled').length,
      postCompactFirstRequests,
      overWindowCount: overWindow.length,
      emptyTurns: emptyReplies.length,
      emptyTurnsByCallRule: turns.filter((t) => t.replyByCallRule !== true).length,
      replyRuleDisagreements: turns.filter((t) => t.replyRuleAgrees !== true).map((t) => t.index),
      emptyTurnsAfterCompaction: emptyAfterCompaction.length,
      emptyTurnsList: turns.filter((t) => t.replyEmpty).map((t) => ({ turn: t.index, error: t.error })),
      stoppedAtLimit: stopped,
      sourceEvidence: 'r5p4fix-real.ts scenarios A/B/C (verbatim)',
    };
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    session.dispose();
    console.warn(`[replay] ${scenarioId} ${JSON.stringify({ turns: summary.turns, empty: summary.emptyTurns, compactions: summary.completedCompactionCount, emptySummaries: summary.emptySummaryCount, overWindow: summary.overWindowCount, calls: summary.modelCalls, tokens: summary.totalTokens, wallMs: summary.wallMs })}`);
    console.warn(`[replay] done → ${outDir}`);
  }
  process.exit(0);
}

await main().catch((error) => {
  console.error('replay 运行失败：', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
