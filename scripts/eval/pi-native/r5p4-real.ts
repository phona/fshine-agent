/**
 * R5-P4 真实模型评测夹具（阶段四）——驱动本分支的 Pi 原生替换（AgentHarness+SessionRepo）。
 *
 * 非产品码：只做装配 + 记录（经公开接缝注入包装过的 `models` 记录真实 usage / 计时 / 上下文）。
 * 装配走产品唯一装配链 `assembleSessionCore`；驱动走产品 `createPiTurnDriver`。
 *
 * 用法：
 *   LLM_MODEL=step-3.7-flash LLM_CONTEXT_WINDOW=8192 \
 *     node --import tsx scripts/eval/pi-native/r5p4-real.ts --scenario=A
 *
 * 记录（落 .runtime/r5p4/<scenario>/）：
 *   turns.json / model-calls.jsonl / transcript.main.json / tasks.json / events.jsonl / summary.json
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { assembleSessionCore } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createPiModelRuntime, createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskStartedOf, taskUnstartedOf, taskWaitingOf } from '../../../packages/agent/testing/task-facts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'r5p4');

function argValue(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

// --------------------------------------------------------------- accounting seam

interface ModelCall {
  label: string;
  kind: 'stream' | 'complete';
  callIndex: number;
  start: number;
  end: number | null;
  ms: number | null;
  stopReason: string | null;
  error: string | null;
  usage: { input: number; output: number; totalTokens: number; cost: number } | null;
  reqMaxTokens: number | null;
  msgs: unknown[];
  toolCalls: Array<{ id: string; name: string }>;
}

function summarizeMsgs(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((raw) => {
    const m = raw as { role?: string; content?: unknown; toolCallId?: string; toolName?: string };
    let text = '';
    const toolCalls: Array<{ id: string; name: string }> = [];
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as { type?: string; text?: string; id?: string; name?: string };
        if (b.type === 'text') text += b.text ?? '';
        if (b.type === 'toolCall') toolCalls.push({ id: b.id ?? '', name: b.name ?? '' });
      }
    }
    return {
      role: m.role,
      textLen: [...text].length,
      head: [...text].slice(0, 80).join(''),
      hasSummary: text.includes('摘要'),
      toolCalls,
      ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId }),
      ...(m.toolName === undefined ? {} : { toolName: m.toolName }),
    };
  });
}

function captureMessage(rec: ModelCall, m: unknown): void {
  const msg = m as { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
  if (msg?.usage) {
    rec.usage = {
      input: Number(msg.usage.input ?? 0),
      output: Number(msg.usage.output ?? 0),
      totalTokens: Number(msg.usage.totalTokens ?? 0),
      cost: Number(msg.usage.cost?.total ?? 0),
    };
  }
  if (msg?.stopReason) rec.stopReason = msg.stopReason;
  if (msg?.errorMessage) rec.error = String(msg.errorMessage).slice(0, 400);
  const content = (m as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b.type === 'toolCall') rec.toolCalls.push({ id: b.id ?? '', name: b.name ?? '' });
    }
  }
}

function captureStreamEvent(rec: ModelCall, ev: unknown): void {
  const e = ev as { type?: string; message?: unknown; reason?: string; error?: unknown };
  if (e.type === 'done') captureMessage(rec, e.message);
  else if (e.type === 'error') { rec.stopReason = e.reason ?? 'error'; rec.error = JSON.stringify(e.error ?? {}).slice(0, 400); }
}

function wrapModels<T extends object>(real: T, records: ModelCall[], label: string): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'streamSimple') {
        return (model: unknown, ctx: unknown, opts: unknown) => {
          const rec: ModelCall = {
            label, kind: 'stream', callIndex: records.length, start: Date.now(), end: null, ms: null,
            stopReason: null, error: null, usage: null, reqMaxTokens: Number((opts as { maxTokens?: unknown })?.maxTokens ?? ((model as { maxTokens?: number })?.maxTokens)) || null, msgs: summarizeMsgs((ctx as { messages?: unknown })?.messages), toolCalls: [],
          };
          records.push(rec);
          const stream = (target as { streamSimple: (...a: unknown[]) => object }).streamSimple(model, ctx, opts);
          return new Proxy(stream, {
            get(st, p) {
              if (p === Symbol.asyncIterator) {
                return () => {
                  const it = (st as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                  return {
                    next: async () => { const n = await it.next(); if (n.done) { rec.end ??= Date.now(); rec.ms = rec.end - rec.start; } else captureStreamEvent(rec, n.value); return n; },
                    return: it.return === undefined ? undefined : it.return.bind(it),
                    throw: it.throw === undefined ? undefined : it.throw.bind(it),
                  };
                };
              }
              if (p === 'result') {
                return async () => { const r = await (st as { result: () => Promise<unknown> }).result(); rec.end ??= Date.now(); rec.ms = rec.end - rec.start; captureMessage(rec, r); return r; };
              }
              const v = Reflect.get(st, p, st);
              return typeof v === 'function' ? v.bind(st) : v;
            },
          });
        };
      }
      if (prop === 'completeSimple') {
        return async (model: unknown, ctx: unknown, opts: unknown) => {
          const rec: ModelCall = {
            label, kind: 'complete', callIndex: records.length, start: Date.now(), end: null, ms: null,
            stopReason: null, error: null, usage: null, reqMaxTokens: Number((opts as { maxTokens?: unknown })?.maxTokens ?? ((model as { maxTokens?: number })?.maxTokens)) || null, msgs: summarizeMsgs((ctx as { messages?: unknown })?.messages), toolCalls: [],
          };
          records.push(rec);
          try {
            const m = await (target as { completeSimple: (...a: unknown[]) => Promise<unknown> }).completeSimple(model, ctx, opts);
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
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// --------------------------------------------------------------- scenarios

const FILLER = (n: number, tag: string): string => {
  const sentences = [
    '把这件事拆成可执行的小步，每一步只解决一个明确的问题，做完就地记录事实。',
    '过程中的中间结论要能追溯到来源，不能凭印象补全，也不能把没发生的动作说成发生了。',
    '遇到信息不足时，先如实说明缺什么，再请对方补齐，不要自己替对方假设一个答案。',
    '结果交付时只讲用户看得懂的话，数字用平台返回的原文，不四舍五入也不修饰。',
    '长期运行要能续跑：状态可查、任务可数、失败可解释、取消要有回执。',
  ];
  let out = '';
  for (let i = 0; i < n; i += 1) out += `[${tag}-${i}] ${sentences[i % sentences.length]}\n`;
  return out;
};

interface Scenario { name: string; taskDispatch: 'sync' | 'async'; turns: string[]; }

function fill(tag: string, n = 130): string {
  return `背景补充（${tag}），读完即可：\n${FILLER(n, tag)}`;
}

function scenarios(): Record<string, Scenario> {
  return {
    A: {
      name: 'A-长对话连续压缩',
      taskDispatch: 'sync',
      turns: [
        `先记住两件必须一直遵守的事：(1) 我的项目代号是「蓝鲸-42」；(2) 你回答我时一律用简体中文。\n${fill('A1')}`,
        `请用 task_run 让执行层查一下 collection=alpha（窗口取 recent）的记录，把条数和第一条内容告诉我。`,
        fill('A2'),
        `把刚才 alpha 查询的结果再复述一遍：条数是多少？`,
        fill('A3'),
        fill('A4'),
        `现在回答我：我最开始让你记住的项目代号是什么？我要求你用哪种语言回答？`,
        `请再次用 task_run 查 collection=alpha 的记录并给出条数。`,
        fill('A5'),
        fill('A6'),
        `到目前为止我们已经聊过哪几个主题？请按时间顺序列一下。`,
        fill('A7'),
        fill('A8'),
        `再确认一次：项目代号、必须使用的语言，这两个你分别还记得吗？`,
        fill('A9'),
        `最后：请复述我最早那段背景（A1）的主题。`,
      ],
    },
    B: {
      name: 'B-多任务交替交办',
      taskDispatch: 'async',
      turns: [
        `交办第一个任务：用 task_run 让执行层查 collection=alpha（窗口 recent）的记录，统计条数。`,
        `交办第二个任务：用 task_run 查 topic=budget 的 ballot（窗口 recent）结果，说明票数。`,
        `用 task_status 看一下本会话现有任务，把编号和状态列出来。`,
        fill('B1'),
        `用 task_result 取回第一个任务（#1）的结果，原文告诉我。`,
        fill('B2'),
        fill('B3'),
        `请回答：我最先交办的第一个任务，它的编号是多少、结果是什么？不要编造，找不到就如实说。`,
        `对 #1 发起取消请求，并按返回的机械结果如实告诉我它现在的状态。`,
        `我们一共交办了几个任务？分别是几号、什么状态？`,
      ],
    },
    C: {
      name: 'C-长会话稳定性',
      taskDispatch: 'sync',
      turns: [
        `第 1 段背景：\n${fill('C1')}`,
        `第 2 段背景：\n${fill('C2')}`,
        `用 task_run 查 collection=alpha（窗口 recent）记录，给出条数。`,
        `第 3 段背景：\n${fill('C3')}`,
        `第 4 段背景：\n${fill('C4')}`,
        `用 task_run 再查一次 collection=alpha 的记录。`,
        `第 5 段背景：\n${fill('C5')}`,
        `第 6 段背景：\n${fill('C6')}`,
        `请给出目前为止，你对我每一段背景的要点的一句话概括。`,
        `第 7 段背景：\n${fill('C7')}`,
        `第 8 段背景：\n${fill('C8')}`,
        `第 9 段背景：\n${fill('C9')}`,
        `请确认你仍能正常工作，并复述第 1 段背景的主题。`,
      ],
    },
  };
}

// --------------------------------------------------------------- main

async function main(): Promise<void> {
  const scenarioId = argValue('scenario', 'A')!;
  const scenario = scenarios()[scenarioId];
  if (scenario === undefined) throw new Error(`未知场景：${scenarioId}`);
  const windowSize = Number(argValue('window', process.env.LLM_CONTEXT_WINDOW ?? '16384'));
  const limit = Number(argValue('limit', '0'));
  const maxOut = Number(argValue('maxtokens', '2048'));

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LLM_MODEL = process.env.LLM_MODEL ?? 'step-3.7-flash';
  env.LLM_CONTEXT_WINDOW = String(windowSize);
  if ((env.LLM_API_KEY ?? '').trim() === '') throw new Error('缺 LLM_API_KEY（不假装跑通）。');

  const outDir = path.join(OUT_ROOT, scenarioId);
  mkdirSync(outDir, { recursive: true });
  const eventsFile = path.join(outDir, 'events.jsonl');
  writeFileSync(eventsFile, '');

  const events: unknown[] = [];
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const capture = (level: string, args: unknown[]): void => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    let parsed: unknown = line;
    if (line.startsWith('{')) { try { parsed = JSON.parse(line); } catch { /* 原样 */ } }
    const entry = { level, at: Date.now(), body: parsed };
    events.push(entry);
    appendFileSync(eventsFile, JSON.stringify(entry) + '\n');
  };
  console.warn = (...args: unknown[]) => { capture('warn', args); originalWarn(...args); };
  console.error = (...args: unknown[]) => { capture('error', args); /* 不转发，减少噪声 */ };

  const cfgPath = materializeEvalConfig(FIXTURE_CONFIG, path.join(outDir, 'agent-config.yaml'));
  const config = loadConfig({ yamlPath: cfgPath, env });
  const effective = effectiveDeploymentEnv(config, env);
  const profileId = Object.keys(config.contextProfiles)[0]!;
  const profile = config.contextProfiles[profileId]!;
  const principalId = Object.entries(config.principals).find(([, p]) => p.enabled)?.[0]!;
  const sessionId = `r5p4-${scenarioId}-${Date.now()}`;
  const dbPath = path.join(outDir, 'state.db');
  const stateDir = path.join(outDir, 'state');

  const records: ModelCall[] = [];
  const modelId = effective.LLM_MODEL!;
  const caps = { contextWindow: windowSize, maxTokens: maxOut };
  const mainRt = await createPiModelRuntime(effective, modelId, caps);
  const workerRt = await createPiModelRuntime(effective, modelId, caps);
  // 记录包装器代理的是公开 ModelRuntime（streamSimple/completeSimple 同面），语义只记录不改。
  const mainDriver = createPiTurnDriver({ env: effective, modelRuntime: wrapModels(mainRt, records, 'main') });
  const workerDriver = createPiTurnDriver({ env: effective, modelRuntime: wrapModels(workerRt, records, 'worker') });

  const assembled = await assembleSessionCore({
    env: effective,
    profile,
    principalId,
    sessionId,
    dbPath,
    stateDir,
    setAuditPath: true,
    emptyOperationsMessage: '执行层没有声明任何只读 operation。',
    emptyOperationsError: (message) => new Error(message),
    taskDispatch: scenario.taskDispatch,
    createDrivers: () => ({ mainDriver, workerDriver }),
  });

  const startedAt = Date.now();
  const turns: unknown[] = [];
  const WORKFLOW_LIMITS = { maxModelCalls: 80, maxTokens: 500_000, wallMs: 40 * 60_000 };
  let stopped = false;

  try {
    for (let i = 0; i < scenario.turns.length; i += 1) {
      if (limit > 0 && i >= limit) break;
      const text = scenario.turns[i]!;
      const t0 = Date.now();
      let reply = '';
      let taskIds: readonly string[] = [];
      let executions: readonly unknown[] = [];
      let error: string | null = null;
      try {
        const result = await assembled.session.send(text);
        reply = result.reply;
        taskIds = result.taskIds;
        executions = result.executions;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const transcript = assembled.session.transcript() as unknown[];
      turns.push({
        index: i + 1,
        user: text.slice(0, 200) + (text.length > 200 ? `…(${text.length}字)` : ''),
        userLen: text.length,
        reply,
        replyEmpty: reply.trim() === '',
        taskIds: [...taskIds],
        executions,
        error,
        ms: Date.now() - t0,
      });
      writeFileSync(path.join(outDir, 'turns.json'), JSON.stringify(turns, null, 2));
      writeFileSync(path.join(outDir, 'transcript.main.json'), JSON.stringify(
        { turn: i + 1, messages: transcript.map((m) => summarizeMsgs([m])[0]) }, null, 2));

      // Dump task registry facts after every turn.
      const tasks = assembled.session.tasks().map((t) => ({
        taskId: t.taskId, taskNo: t.taskNo, name: t.name, started: taskStartedOf(t), reported: taskReportedOf(t), waiting: taskWaitingOf(t), mayBeRunning: taskMayBeRunningOf(t),
        reason: lastFailureOf(t)?.error?.code, failureReason: lastFailureOf(t)?.error?.message, resultText: t.resultText, replyText: t.replyText,
        executions: t.executions,
      }));
      writeFileSync(path.join(outDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
      writeFileSync(path.join(outDir, 'model-calls.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const calls = records.length;
      const tokens = records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0);
      const wall = Date.now() - startedAt;
      if (calls > WORKFLOW_LIMITS.maxModelCalls || tokens > WORKFLOW_LIMITS.maxTokens || wall > WORKFLOW_LIMITS.wallMs) {
        stopped = true;
        originalWarn(`[r5p4] 达硬停：calls=${calls} tokens=${tokens} wallMs=${wall}`);
        break;
      }
    }
  } finally {
    const summary = {
      scenario: scenario.name,
      scenarioId,
      taskDispatch: scenario.taskDispatch,
      model: modelId,
      provider: 'openai-completions',
      providerDeclaredMaxInputTokens: 262144,
      configuredContextWindow: windowSize,
      maxOutputTokens: maxOut,
      windowLowered: windowSize < 262144,
      principalId,
      sessionId,
      dbPath,
      wallMs: Date.now() - startedAt,
      modelCalls: records.length,
      mainCalls: records.filter((r) => r.label === 'main').length,
      workerCalls: records.filter((r) => r.label === 'worker').length,
      summaryCalls: records.filter((r) => r.kind === 'complete').length,
      totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0),
      totalInputTokens: records.reduce((s, r) => s + (r.usage?.input ?? 0), 0),
      totalOutputTokens: records.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
      stoppedAtLimit: stopped,
      driverEvents: events.filter((e) => (e as { body?: { event?: string } }).body?.event !== undefined),
    };
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    assembled.close();
  }
  originalWarn(`[r5p4] done → ${outDir}`);
  process.exit(0);
}

await main().catch((error: unknown) => {
  console.error('r5p4 运行失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
