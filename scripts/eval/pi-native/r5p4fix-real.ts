/**
 * R5-P4 补 · 修复后真实模型重跑（产品装配链 + 单长生命周期 Pi Session）。
 *
 * 被测对象 = 产品装配链 `assembleSessionCore` + 产品 `createPiTurnDriver`，
 * Main 驱动显式 `reuseConversation: true`（补丁 7e20fbd 的修复路径）。
 *
 * 非产品码：只做装配 + 取证。取证用**取证侧**包装：
 *   · 包装 `AgentHarness.create`（同一导出对象）以订阅 Pi 原生事件（compaction_* / run_end / retry_scheduled …）；
 *   · 在 `compaction_end(completed)` 时读 `lane.findEntries` 取压缩条目的 tokensBefore / retainedTail 条数 / 摘要长度；
 *   · 经公开接缝注入包装过的 `models` 记录真实 usage / 计时 / 请求消息摘要。
 *
 * 本轮（配置修正）：A/B/C 的窗口 / maxTokens / reserveTokens / keepRecentTokens 一律取
 * `safe-config.ts` 的 `SAFE_PI_COMPACTION_CONFIG`（按“窗口 − 输出预算 − 余量”算出的安全值），
 * 经驱动的 `compactionSettings` 配置接缝显式传入；**不含任何压缩决策逻辑**。
 * D 是“工具结果致超窗”的补充探针（不计入 N=3），故意保持小窗口，不作安全配置声明。
 *
 * 用法：
 *   node --env-file=<repo>/.env --import tsx \
 *     scripts/eval/pi-native/r5p4fix-real.ts --scenario=A
 */
import { appendFileSync, mkdirSync, writeFileSync, writeFileSync as writeJsonSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHarness } from '@earendil-works/pi-agent-core';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { assembleSessionCore } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createPiModelRuntime, createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import {
  SAFE_PI_COMPACTION_CONFIG,
  assessCompactionConfig,
  compactionSettingsOf,
  safeConfigEnv,
} from './safe-config';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'r5p4fix2');

function argValue(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

// --------------------------------------------------------------- scenarios

const FILLER = (n: number, tag: string): string => {
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
const fill = (tag: string, n = 130): string => `背景补充（${tag}），读完即可，不需要做任何事：\n${FILLER(n, tag)}`;

interface Scenario {
  name: string;
  dispatchMode: 'inline' | 'background';
  /** true = 使用 SAFE_PI_COMPACTION_CONFIG（A/B/C 主样本）；false = 补充探针（D）。 */
  safeConfig?: boolean;
  window: number;
  maxTokens: number;
  turns: string[];
  seedBulk?: boolean;
}

function scenarios(): Record<string, Scenario> {
  return {
    A: {
      name: 'A-长对话连续压缩',
      dispatchMode: 'inline',
      safeConfig: true,
      window: SAFE_PI_COMPACTION_CONFIG.contextWindow,
      maxTokens: SAFE_PI_COMPACTION_CONFIG.maxTokens,
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
    },
    B: {
      name: 'B-多任务交替交办',
      dispatchMode: 'background',
      safeConfig: true,
      window: SAFE_PI_COMPACTION_CONFIG.contextWindow,
      maxTokens: SAFE_PI_COMPACTION_CONFIG.maxTokens,
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
    },
    C: {
      name: 'C-长会话稳定性',
      dispatchMode: 'inline',
      safeConfig: true,
      window: SAFE_PI_COMPACTION_CONFIG.contextWindow,
      maxTokens: SAFE_PI_COMPACTION_CONFIG.maxTokens,
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
    },
    D: {
      // 补充探针（不计入 N=3 主样本）：工具结果致超窗后的续发是否有界。
      name: 'D-工具结果致超窗（补充）',
      dispatchMode: 'inline',
      window: 8192,
      maxTokens: 2048,
      seedBulk: true,
      turns: [
        `用 run_task 让执行层查 collection=bulk（窗口 W1）的全部记录，然后只告诉我记录总条数，以及第一条的 name。`,
        `再确认一次：bulk 的记录总条数是多少？不要编造。`,
        `用一句话总结这次查询是否成功并说明依据。`,
      ],
    },
  };
}

function seedState(bulkCount: number): unknown {
  const bulkItems = [];
  for (let i = 0; i < bulkCount; i += 1) {
    bulkItems.push({
      id: `bulk-${String(i).padStart(4, '0')}`,
      name: `bulk-item-${String(i).padStart(4, '0')}-record-with-fairly-long-descriptive-name-for-token-pressure`,
      value: 100 + i,
    });
  }
  return {
    collections: {
      alpha: { items: [{ id: 'rec-001', name: 'alpha-item-1', value: 1200 }, { id: 'rec-002', name: 'alpha-item-2', value: 800 }], windows: ['W1', 'W2'], locked: false, records: { W1: 2, W2: 1 } },
      beta: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], windows: ['W1'], locked: false, records: { W1: 1 } },
      bulk: { items: bulkItems, windows: ['W1'], locked: false, records: { W1: bulkCount } },
    },
  };
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
      head: [...text].slice(0, 60).join(''),
      hasCompactionSummary: text.startsWith('【此前会话摘要】'),
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
  const make = (kind: ModelCall['kind'], ctx: unknown, opts: unknown, model: unknown): ModelCall => {
    const rec: ModelCall = {
      label, kind, callIndex: records.length, start: Date.now(), end: null, ms: null,
      stopReason: null, error: null, usage: null,
      reqMaxTokens: Number((opts as { maxTokens?: unknown })?.maxTokens ?? ((model as { maxTokens?: number })?.maxTokens)) || null,
      msgs: summarizeMsgs((ctx as { messages?: unknown })?.messages), toolCalls: [],
    };
    records.push(rec);
    return rec;
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'streamSimple') {
        return (model: unknown, ctx: unknown, opts: unknown) => {
          const rec = make('stream', ctx, opts, model);
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
          const rec = make('complete', ctx, opts, model);
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

// --------------------------------------------------------------- native Pi event capture

const nativeEvents: Array<Record<string, unknown>> = [];
const compactions: Array<Record<string, unknown>> = [];
const pendingReads: Array<Promise<void>> = [];
let currentTurn = 0;
let eventsFile = '';

interface HarnessRef { harness: { events: { on: (t: string, f: (e: unknown) => void) => void } }; lane: { findEntries: (q: undefined, c: unknown) => Promise<Array<Record<string, unknown>>> }; label: string }

function installHarnessProbe(): HarnessRef[] {
  const refs: HarnessRef[] = [];
  const original = AgentHarness.create.bind(AgentHarness) as (...a: unknown[]) => Promise<{ harness: unknown }>;
  // 取证侧包装：只订阅事件/读条目，不改 Pi 行为。
  (AgentHarness as unknown as { create: (...a: unknown[]) => Promise<unknown> }).create = async (config: unknown, ctx: unknown) => {
    const created = await original(config, ctx);
    const harness = created.harness as HarnessRef['harness'];
    const cfg = config as { activeToolNames?: string[] } | undefined;
    const names = Array.isArray(cfg?.activeToolNames) ? cfg!.activeToolNames : [];
    const label = names.includes('run_task') ? 'main' : 'worker';
    const lane = await (harness as unknown as { lane: (n: string, c: unknown) => Promise<HarnessRef['lane']> }).lane('main', ctx);
    refs.push({ harness, lane, label });
    const rec = (type: string, e: Record<string, unknown>) => {
      const entry: Record<string, unknown> = { at: Date.now(), turn: currentTurn, harness: label, type };
      if (type === 'compaction_start') { entry.reason = e['reason']; entry.startedAt = e['startedAt']; }
      if (type === 'compaction_end') {
        entry.reason = e['reason']; entry.status = e['status']; entry.endedAt = e['endedAt'];
        const err = e['error'] as { code?: string } | undefined;
        if (err !== undefined) entry.errorCode = err.code;
      }
      if (type === 'run_end') { entry.status = e['status']; const err = e['error'] as { code?: string } | undefined; if (err !== undefined) entry.errorCode = err.code; }
      if (type === 'retry_scheduled') { entry.attempt = e['attempt']; entry.maxAttempts = e['maxAttempts']; entry.delayMs = e['delayMs']; entry.errorMessage = String(e['errorMessage'] ?? '').slice(0, 200); }
      if (type === 'turn_end') { entry.tipId = e['tipId']; entry.status = e['status']; }
      if (type === 'fault' || type === 'handler_error') entry.detail = JSON.stringify(e).slice(0, 400);
      nativeEvents.push(entry);
      if (eventsFile !== '') appendFileSync(eventsFile, JSON.stringify(entry) + '\n');
    };
    harness.events.on('compaction_start', (e) => rec('compaction_start', e as Record<string, unknown>));
    harness.events.on('compaction_end', (e) => {
      const ev = e as Record<string, unknown>;
      rec('compaction_end', ev);
      if (ev['status'] !== 'completed') return;
      pendingReads.push((async () => {
        try {
          const entries = await lane.findEntries(undefined, ctx);
          const comps = entries.filter((x) => x['type'] === 'compaction');
          const hit = comps.find((x) => x['id'] === ev['entryId']) ?? comps[comps.length - 1];
          const tail = (hit?.['retainedTail'] ?? []) as Array<{ role?: string }>;
          compactions.push({
            harness: label,
            turn: currentTurn,
            at: Date.now(),
            entryId: ev['entryId'] ?? null,
            reason: ev['reason'] ?? null,
            seq: hit?.['seq'] ?? null,
            tokensBefore: hit?.['tokensBefore'] ?? null,
            retainedTailCount: tail.length,
            retainedTailRoles: tail.map((m) => m.role ?? '?'),
            summaryChars: typeof hit?.['summary'] === 'string' ? [...(hit!['summary'] as string)].length : null,
            compactionUsage: hit?.['usage'] ?? null,
          });
        } catch (error) {
          compactions.push({ harness: label, turn: currentTurn, error: String(error) });
        }
      })());
    });
    for (const t of ['run_end', 'retry_scheduled', 'turn_end', 'fault', 'handler_error']) {
      harness.events.on(t, (e) => rec(t, e as Record<string, unknown>));
    }
    return created;
  };
  return refs;
}

// --------------------------------------------------------------- main

async function main(): Promise<void> {
  const scenarioId = argValue('scenario', 'A')!;
  const scenario = scenarios()[scenarioId];
  if (scenario === undefined) throw new Error(`未知场景：${scenarioId}`);

  const windowSize = Number(argValue('window', String(scenario.window)));
  const maxOut = Number(argValue('maxtokens', String(scenario.maxTokens)));
  const limit = Number(argValue('limit', '0'));

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LLM_MODEL = process.env.LLM_MODEL ?? 'step-3.7-flash';
  env.LLM_CONTEXT_WINDOW = String(windowSize);
  if (scenario.safeConfig === true) Object.assign(env, safeConfigEnv(SAFE_PI_COMPACTION_CONFIG));
  if ((env.LLM_API_KEY ?? '').trim() === '') throw new Error('缺 LLM_API_KEY（不假装跑通）。');
  if (env.LLM_MODEL !== 'step-3.7-flash') throw new Error(`模型必须固定 step-3.7-flash，实际 ${env.LLM_MODEL}`);

  const outDir = path.join(OUT_ROOT, scenarioId);
  mkdirSync(path.join(outDir, 'transcript'), { recursive: true });
  eventsFile = path.join(outDir, 'native-events.jsonl');
  writeFileSync(eventsFile, '');

  const sessionId = `r5p4fix-${scenarioId}-${Date.now()}`;
  const dbPath = path.join(outDir, 'state.db');
  const stateDir = path.join(outDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  if (scenario.seedBulk === true) writeJsonSync(path.join(stateDir, 'dummy-state.json'), JSON.stringify(seedState(260), null, 2));

  const cfgPath = materializeEvalConfig(FIXTURE_CONFIG, path.join(outDir, 'agent-config.yaml'));
  const config = loadConfig({ yamlPath: cfgPath, env });
  const effective = effectiveDeploymentEnv(config, env);
  const profileId = Object.keys(config.contextProfiles)[0]!;
  const profile = config.contextProfiles[profileId]!;
  const principalId = Object.entries(config.principals).find(([, p]) => p.enabled)?.[0]!;

  // 安全配置先决条件：A/B/C 必须在任何模型调用之前通过余量不等式；不过即退出（不烧调用）。
  if (scenario.safeConfig === true) {
    const assessment = assessCompactionConfig(SAFE_PI_COMPACTION_CONFIG);
    if (!assessment.safe) {
      throw new Error(`安全配置不成立，拒绝开跑（不烧真实模型）：${assessment.problems.join('；')}`);
    }
    if (windowSize !== SAFE_PI_COMPACTION_CONFIG.contextWindow || maxOut !== SAFE_PI_COMPACTION_CONFIG.maxTokens) {
      throw new Error(`A/B/C 窗口/输出预算必须等于预注册安全值（W=${SAFE_PI_COMPACTION_CONFIG.contextWindow}, M=${SAFE_PI_COMPACTION_CONFIG.maxTokens}），实际 W=${windowSize}, M=${maxOut}`);
    }
  }

  const records: ModelCall[] = [];
  const modelId = effective.LLM_MODEL!;
  const caps = { contextWindow: windowSize, maxTokens: maxOut };
  const compactionOptions = scenario.safeConfig === true
    ? { compactionSettings: compactionSettingsOf(SAFE_PI_COMPACTION_CONFIG) }
    : {};
  const mainRt = createPiModelRuntime(effective, modelId, caps);
  const workerRt = createPiModelRuntime(effective, modelId, caps);
  // Main = 单长生命周期 Pi 会话（补丁 7e20fbd 的修复路径）；Worker = 每回合一次性（产品设计）。
  const mainDriver = createPiTurnDriver({
    env: effective,
    reuseConversation: true,
    ...compactionOptions,
    runtime: { models: wrapModels(mainRt.models, records, 'main'), model: mainRt.model },
  });
  const workerDriver = createPiTurnDriver({
    env: effective,
    ...compactionOptions,
    runtime: { models: wrapModels(workerRt.models, records, 'worker'), model: workerRt.model },
  });

  const harnessRefs = installHarnessProbe();

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
    runtime: { dispatchMode: scenario.dispatchMode },
    createDrivers: () => ({ mainDriver, workerDriver }),
  });

  const startedAt = Date.now();
  const turns: Array<Record<string, unknown>> = [];
  const LIMITS = { maxModelCalls: 80, maxTokens: 600_000, wallMs: 45 * 60_000 };
  let stopped = false;

  try {
    for (let i = 0; i < scenario.turns.length; i += 1) {
      if (limit > 0 && i >= limit) break;
      currentTurn = i + 1;
      const text = scenario.turns[i]!;
      const t0 = Date.now();
      const callIndexBefore = records.length;
      const compactionIndexBefore = compactions.length;
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
      await Promise.all(pendingReads.splice(0, pendingReads.length));
      const t1 = Date.now();

      turns.push({
        index: i + 1,
        userLen: text.length,
        userHead: [...text].slice(0, 120).join(''),
        reply,
        replyEmpty: reply.trim() === '',
        taskIds: [...taskIds],
        executions,
        error,
        startedAt: t0,
        endedAt: t1,
        callIndexBefore,
        callIndexAfter: records.length,
        compactionsBefore: compactionIndexBefore,
        compactionsAfter: compactions.length,
        compactionsThisTurn: compactions.slice(compactionIndexBefore),
      });
      writeFileSync(path.join(outDir, 'turns.json'), JSON.stringify(turns, null, 2));
      writeFileSync(path.join(outDir, 'compactions.json'), JSON.stringify(compactions, null, 2));
      const transcript = assembled.session.transcript() as unknown[];
      writeFileSync(path.join(outDir, 'transcript', `turn-${i + 1}.json`), JSON.stringify(transcript.map((m) => summarizeMsgs([m])[0]), null, 2));
      const tasks = assembled.session.tasks().map((t) => ({
        taskId: t.taskId, taskNo: t.taskNo, name: t.name, status: t.status,
        reason: t.reason, failureReason: t.failureReason, resultText: t.resultText, replyText: t.replyText,
        executions: t.executions,
      }));
      writeFileSync(path.join(outDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
      writeFileSync(path.join(outDir, 'model-calls.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const calls = records.length;
      const tokens = records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0);
      const wall = Date.now() - startedAt;
      if (calls > LIMITS.maxModelCalls || tokens > LIMITS.maxTokens || wall > LIMITS.wallMs) {
        stopped = true;
        console.warn(`[r5p4fix] 达硬停：calls=${calls} tokens=${tokens} wallMs=${wall}`);
        break;
      }
    }
  } finally {
    const completedCompactions = compactions.filter((c) => c['error'] === undefined && c['tokensBefore'] !== undefined);
    const summary = {
      scenario: scenario.name,
      scenarioId,
      mode: 'product-assembly-chain+reuseConversation',
      model: modelId,
      provider: 'openai-completions',
      providerDeclaredMaxInputTokens: 262144,
      configuredContextWindow: windowSize,
      maxOutputTokens: maxOut,
      configuredReserveTokens: scenario.safeConfig === true ? SAFE_PI_COMPACTION_CONFIG.reserveTokens : null,
      configuredKeepRecentTokens: scenario.safeConfig === true ? SAFE_PI_COMPACTION_CONFIG.keepRecentTokens : null,
      safeConfigAssessed: scenario.safeConfig === true ? assessCompactionConfig(SAFE_PI_COMPACTION_CONFIG) : null,
      windowLowered: windowSize < 262144,
      dispatchMode: scenario.dispatchMode,
      mainDriverReuseConversation: true,
      principalId,
      sessionId,
      wallMs: Date.now() - startedAt,
      turns: turns.length,
      emptyTurns: turns.filter((t) => t['replyEmpty'] === true).length,
      modelCalls: records.length,
      mainCalls: records.filter((r) => r.label === 'main').length,
      workerCalls: records.filter((r) => r.label === 'worker').length,
      summaryCalls: records.filter((r) => r.kind === 'complete').length,
      totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0),
      totalInputTokens: records.reduce((s, r) => s + (r.usage?.input ?? 0), 0),
      totalOutputTokens: records.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
      totalCost: records.reduce((s, r) => s + (r.usage?.cost ?? 0), 0),
      compactionStarts: nativeEvents.filter((e) => e['type'] === 'compaction_start').length,
      compactionEnds: nativeEvents.filter((e) => e['type'] === 'compaction_end').map((e) => ({ harness: e['harness'], turn: e['turn'], reason: e['reason'], status: e['status'], errorCode: e['errorCode'] })),
      completedCompactionEntries: completedCompactions,
      completedCompactionCount: completedCompactions.length,
      retryScheduled: nativeEvents.filter((e) => e['type'] === 'retry_scheduled').length,
      harnesses: harnessRefs.map((r) => r.label),
      stoppedAtLimit: stopped,
    };
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    assembled.close();
    console.warn(`[r5p4fix] ${scenarioId} summary: ${JSON.stringify({ turns: summary.turns, emptyTurns: summary.emptyTurns, compactions: summary.completedCompactionCount, calls: summary.modelCalls, tokens: summary.totalTokens, wallMs: summary.wallMs })}`);
  }
  console.warn(`[r5p4fix] done → ${outDir}`);
  process.exit(0);
}

await main().catch((error: unknown) => {
  console.error('r5p4fix 运行失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
