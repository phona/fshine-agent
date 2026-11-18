/**
 * R6 Wave1 · 真实模型会话适配（生产同源装配 → HarnessSession）。
 *
 * 定位：把**与 `npm run ask` 同源的装配**（`assembleSessionCore`：Main→Worker 委派、Task Registry、
 * 仓内 dummy 执行层）跑成 `runHarnessSession` 能消费的 `HarnessSession`。只采集事实：
 *   · 逐轮输入由 harness 给，这里只 send 并读会话面；
 *   · 压缩尝试/模型调用/摘要调用来自 **Pi 原生 AgentSession 事件**
 *     （`compaction_start` / `compaction_end(result.tokensBefore|estimatedTokensAfter|usage)` /
 *      `message_end(assistant.usage)` / `summarization_retry_*`），不读阈值、不改触发/门控；
 *   · 任务事实来自真实 `TaskRegistry`（经 `Session.tasks()`）；取消回执的机械依据是本回合
 *     是否实际调用了 `task_cancel`（由 Pi 原生 tool_call 事件观测）。
 *
 * 观测实现：`createPiTurnDriver` 不暴露内部 AgentSession。为**不改产品码**，本模块在进程内
 * 对公开类 `AgentSession.prototype.subscribe`/`prompt` 做只读包裹：subscribe 拿到实例后附一条
 * 只读事件监听；prompt 用本轮用户原文识别主会话（Worker 的委派文本不同）。归属用
 * AsyncLocalStorage 绑定到当前 RealSession（同进程并发 ≤5 会话时互不串账）。
 * 包裹只记录事实，不改变任何调用参数与返回值。
 *
 * 纪律：真实模型质量结论只由本适配器产生（预注册 §〇.1）；假会话不得冒充。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig, ContextProfileConfig } from '@fshine/contracts';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { createResourcePolicy } from '../../../packages/agent/src/resource-policy';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { TASK_CANCEL_TOOL, EXECUTE_OPERATION_TOOL } from '../../../packages/agent/src/execution-runtime';
import {
  assembleSessionCore, compactionSettingsFrom, contextWindowFrom, createBackgroundDispatch, resolveExecutionFace,
} from '../../ask-runtime';
import { estimateContextTokens } from '../token-estimate';
import type { CancelFact, ExecutionFact, HarnessSession } from './harness';
import type { CompactionAttempt } from './compaction';
import type { TaskView } from './oracle';
import type { BudgetUsage, ToolCallRecord } from './evidence';
import type { CallKind, ModelCallRecord } from './accounting';

/** 把参数里的字符串叶子全部收集（执行对象记号：集合名/窗口等）。 */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) stringLeaves(item, out); return out; }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) stringLeaves(item, out);
  }
  return out;
}

/**
 * execute_operation 的调用参数 → 对象记号集合（`--collection=beta` → `beta`）。
 * 只做机械投影：展示/判定用，不改变调用参数。
 */
function executionObjectsOf(args: unknown): readonly string[] {
  let parsed = args;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; } catch { /* 保留原串 */ }
  }
  const leaves = stringLeaves(parsed);
  const tokens = leaves.flatMap((leaf) => leaf.split(/[=\s,]+/)).map((t) => t.trim()).filter((t) => t !== '');
  return [...new Set(tokens)];
}

function operationOf(args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const operation = (args as { operation?: unknown }).operation;
    if (typeof operation === 'string') return operation;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pi 原生事件观测（只读包裹公开类；归属按 AsyncLocalStorage 绑定到会话）
// ─────────────────────────────────────────────────────────────────────────────

interface SessionRecord {
  readonly session: AgentSession;
  readonly createdSeq: number;
  isMain: boolean;
  subscribed: boolean;
  turn: number;
  attempts: CompactionAttempt[];
  calls: ModelCallRecord[];
  toolsThisTurn: Set<string>;
  lastTurnTools: Set<string>;
  /** 压缩开始时的上下文估算（compaction_end 无 result 时的 before 事实）。 */
  atCompactionStart: number | null;
  pendingRetry: boolean;
  pendingOverflow: boolean;
  summaryRetries: number;
  lastAssistantStop: string | null;
  lastCompactionError?: string;
  fallbackAfter?: number;
  toolCalls: ToolCallRecord[];
  /** tool_execution_start 的调用参数（`tool_execution_end` 事件**不带** args，按 toolCallId 补齐）。 */
  pendingToolArgs: Map<string, unknown>;
  /** 逐次执行审计行（`execute_operation` 的 start 事件；带回合号）。 */
  executions: Array<{ readonly turn: number; readonly fact: ExecutionFact }>;
  /** 逐次 `task_cancel` 回执（end 事件的 result；带回合号）。 */
  cancels: Array<{ readonly turn: number; readonly fact: CancelFact }>;
}

/** 每个 RealSession 一个 collector（进程内并发会话互不串账）。 */
interface Collector {
  readonly records: SessionRecord[];
  readonly events: Record<string, unknown>[];
  nextSeq: number;
  pendingText: string | null;
  currentTurn: number;
  installed: boolean;
}

const COLLECTOR_ALS = new AsyncLocalStorage<Collector>();
let prototypesPatched = false;

function newCollector(): Collector {
  return { records: [], events: [], nextSeq: 1, pendingText: null, currentTurn: 0, installed: false };
}

function recordFor(collector: Collector, session: AgentSession): SessionRecord {
  let rec = collector.records.find((s) => s.session === session);
  if (rec === undefined) {
    rec = {
      session, createdSeq: collector.records.length, isMain: false, subscribed: false,
      turn: collector.currentTurn, attempts: [], calls: [],
      toolsThisTurn: new Set(), lastTurnTools: new Set(),
      atCompactionStart: null, pendingRetry: false, pendingOverflow: false, summaryRetries: 0,
      lastAssistantStop: null, toolCalls: [], pendingToolArgs: new Map(), executions: [], cancels: [],
    };
    collector.records.push(rec);
  }
  return rec;
}

function usageOf(message: unknown): { input: number; output: number; total: number } | null {
  const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (usage === undefined || usage === null) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(usage['input']);
  const output = num(usage['output']);
  const total = num(usage['totalTokens']) || input + output + num(usage['cacheRead']) + num(usage['cacheWrite']);
  return { input, output, total };
}

function mapReason(reason: unknown): CompactionAttempt['kind'] {
  if (reason === 'threshold') return 'threshold';
  if (reason === 'overflow') return 'overflow';
  return 'unknown';
}

function estimateOf(messages: readonly unknown[]): number {
  return estimateContextTokens(messages).tokens;
}

function pushCall(collector: Collector, rec: SessionRecord, kind: CallKind, turn: number, tokens: { input: number; output: number; total: number }, observed: boolean): void {
  rec.calls.push({
    seq: collector.nextSeq, kind, sessionId: '', turn,
    tokens, tokensObserved: observed, durationMs: 0,
  });
  collector.nextSeq += 1;
}

function onSessionEvent(collector: Collector, rec: SessionRecord, event: unknown): void {
  const e = event as Record<string, unknown>;
  const type = String(e['type'] ?? '');
  const turn = rec.turn;
  if (type === 'message_end') {
    const message = e['message'] as { role?: string; stopReason?: string; content?: unknown } | undefined;
    if (message?.role !== 'assistant') return;
    const usage = usageOf(message);
    const kind: CallKind = rec.pendingRetry ? 'retry' : rec.pendingOverflow ? 'overflow_recovery' : 'main';
    pushCall(collector, rec, kind, turn, usage ?? { input: 0, output: 0, total: 0 }, usage !== null);
    if (rec.pendingRetry) rec.pendingRetry = false;
    if (rec.pendingOverflow) rec.pendingOverflow = false;
    rec.lastAssistantStop = message.stopReason ?? null;
    // 本回合实际发出的工具调用名（H5 的机械依据）。
    const blocks = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
    for (const block of blocks) {
      if (block['type'] === 'toolCall' && typeof block['name'] === 'string') rec.toolsThisTurn.add(block['name']);
    }
    return;
  }
  if (type === 'auto_retry_start') { rec.pendingRetry = true; return; }
  if (type === 'summarization_retry_scheduled') { rec.summaryRetries += 1; return; }
  if (type === 'compaction_start') {
    rec.atCompactionStart = estimateOf((rec.session.messages ?? []) as readonly unknown[]);
    return;
  }
  if (type === 'compaction_end') {
    const result = e['result'] as { tokensBefore?: number; estimatedTokensAfter?: number; usage?: unknown; summary?: string } | undefined;
    const before = result?.tokensBefore ?? rec.atCompactionStart ?? estimateOf((rec.session.messages ?? []) as readonly unknown[]);
    const afterObserved = typeof result?.estimatedTokensAfter === 'number';
    const after = result?.estimatedTokensAfter ?? estimateOf((rec.session.messages ?? []) as readonly unknown[]);
    if (!afterObserved) rec.fallbackAfter = (rec.fallbackAfter ?? 0) + 1;
    rec.attempts.push({ turn, kind: mapReason(e['reason']), before, after });
    if (result !== undefined) {
      const usage = usageOf({ usage: result.usage });
      pushCall(collector, rec, 'summary', turn, usage ?? { input: 0, output: 0, total: 0 }, usage !== null);
    }
    const errorMessage = e['errorMessage'];
    if (typeof errorMessage === 'string' && errorMessage.trim() !== '') rec.lastCompactionError = errorMessage;
    rec.atCompactionStart = null;
    if (e['willRetry'] === true) rec.pendingOverflow = true;
    return;
  }
  if (type === 'tool_execution_start') {
    // end 事件不带 args：按 toolCallId 暂存，供执行对象判定与 tool-calls 证据使用。
    const args = e['args'] ?? null;
    rec.pendingToolArgs.set(String(e['toolCallId'] ?? ''), args);
    // 执行审计行（发起即记；后续失败/拒绝仍是一次真实执行尝试）。
    if (String(e['toolName'] ?? '') === EXECUTE_OPERATION_TOOL) {
      const inner = args !== null && typeof args === 'object' ? (args as { args?: unknown }).args : undefined;
      rec.executions.push({ turn, fact: { operation: operationOf(args), objects: executionObjectsOf(inner ?? args) } });
    }
    return;
  }
  if (type === 'tool_execution_end') {
    const result = e['result'];
    let summary = '';
    try { summary = JSON.stringify(result) ?? ''; } catch { summary = String(result); }
    const callId = String(e['toolCallId'] ?? '');
    const args = rec.pendingToolArgs.get(callId) ?? e['args'] ?? null;
    rec.pendingToolArgs.delete(callId);
    rec.toolCalls.push({
      turn, agent: rec.isMain ? 'main' : 'worker', seq: rec.toolCalls.length + 1,
      tool: String(e['toolName'] ?? '?'), args,
      resultSummary: summary.length <= 400 ? summary : `${summary.slice(0, 400)}…`,
      elapsedMs: typeof e['durationMs'] === 'number' ? e['durationMs'] : 0,
    });
    // task_cancel 回执：目标任务 + outcome/status（在飞取消的「如实迟到 vs 指错任务」判据）。
    if (String(e['toolName'] ?? '') === TASK_CANCEL_TOOL) {
      let parsed: unknown = result;
      if (typeof result === 'string') {
        try { parsed = JSON.parse(result) as unknown; } catch { parsed = null; }
      }
      const obj = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      rec.cancels.push({
        turn,
        fact: {
          taskId: typeof obj['taskId'] === 'string' ? obj['taskId'] : null,
          outcome: typeof obj['outcome'] === 'string' ? obj['outcome'] : null,
          status: typeof obj['status'] === 'string' ? obj['status'] : null,
        },
      });
    }
  }
}

/** 安装只读观测（进程内一次）。归属由 AsyncLocalStorage 提供；无 collector 的会话不记录。 */
function installPiObservation(): void {
  if (prototypesPatched) return;
  prototypesPatched = true;
  const proto = AgentSession.prototype as unknown as {
    subscribe: (listener: (event: unknown) => void) => () => void;
    prompt: (text: string, options?: unknown) => Promise<void>;
  };
  const origSubscribe = proto.subscribe;
  const origPrompt = proto.prompt;
  proto.subscribe = function (this: AgentSession, listener) {
    const collector = COLLECTOR_ALS.getStore();
    if (collector !== undefined) {
      const rec = recordFor(collector, this);
      if (!rec.subscribed) {
        rec.subscribed = true;
        origSubscribe.call(this, (event) => onSessionEvent(collector, rec, event));
      }
    }
    return origSubscribe.call(this, listener);
  };
  proto.prompt = function (this: AgentSession, text, options) {
    const collector = COLLECTOR_ALS.getStore();
    if (collector !== undefined) {
      const rec = recordFor(collector, this);
      if (collector.pendingText !== null && typeof text === 'string' && text.trim() === collector.pendingText.trim()) rec.isMain = true;
    }
    return origPrompt.call(this, text, options);
  };

  // 驱动 console 事实（pi_driver_* / context_*）：进程内一次，按 ALS 归属到会话。
  const savedConsole = { warn: console.warn, info: console.info, error: console.error, log: console.log };
  const wrap = (orig: (...a: unknown[]) => void) => (...args: unknown[]): void => {
    const collector = COLLECTOR_ALS.getStore();
    if (collector !== undefined) {
      const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ').trim();
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const event = String(parsed['event'] ?? '');
          if (DRIVER_EVENT_PREFIXES.some((p) => event.startsWith(p))) collector.events.push(parsed);
        } catch { /* 非 JSON */ }
      }
    }
    orig(...args);
  };
  console.warn = wrap(savedConsole.warn.bind(console));
  console.info = wrap(savedConsole.info.bind(console));
  console.error = wrap(savedConsole.error.bind(console));
  console.log = wrap(savedConsole.log.bind(console));
}

/** 把驱动包进 collector 的 ALS 上下文（会话创建/事件/调用都归属本会话）。 */
function scopeDriver(driver: TurnDriver, collector: Collector): TurnDriver {
  const scoped: TurnDriver = {
    run: (input) => COLLECTOR_ALS.run(collector, () => driver.run(input)),
  } as TurnDriver;
  if (driver.transcript !== undefined) (scoped as { transcript?: TurnDriver['transcript'] }).transcript = () => driver.transcript!();
  if (driver.close !== undefined) (scoped as { close?: TurnDriver['close'] }).close = () => driver.close!();
  if (driver.sessionInfo !== undefined) (scoped as { sessionInfo?: TurnDriver['sessionInfo'] }).sessionInfo = () => driver.sessionInfo!();
  if (driver.synthesizeAssistant !== undefined) {
    (scoped as { synthesizeAssistant?: TurnDriver['synthesizeAssistant'] }).synthesizeAssistant = (text) => driver.synthesizeAssistant!(text);
  }
  return scoped;
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实会话适配
// ─────────────────────────────────────────────────────────────────────────────

export interface RealSessionInput {
  readonly env: Record<string, string | undefined>;
  readonly config: AppConfig;
  readonly profile: ContextProfileConfig;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly sessionDir: string;
  readonly window: number;
}

export interface RealSession extends HarnessSession {
  readonly sessionId: string;
  readonly principalId: string;
  readonly window: number;
  readonly registry: SqliteTaskRegistry;
  /** Pi 原生会话文件（主会话；落盘未启用时 undefined）。 */
  sessionFile(): string | undefined;
  /** 本会话（主会话）转录的文本投影（泄漏机械扫描用；只读事实）。 */
  transcriptText(): string;
  /** 驱动 console 事实（pi_driver_* / context_* 事件行）。 */
  driverEvents(): readonly Record<string, unknown>[];
  /** 会话文件里的 compaction 条目摘要（无效摘要入库判定用）。 */
  compactionEntries(): readonly { summaryChars: number; summary: string; tokensBefore: number | null }[];
  /** 观测缺口/信号。 */
  meta(): {
    readonly observationGap: string | null;
    readonly summaryCalls: number;
    readonly mainModelCalls: number;
    readonly allModelCalls: number;
    readonly mainTokens: number;
    readonly allTokens: number;
    readonly maxMainCallsPerTurn: number;
    readonly maxAllCallsPerTurn: number;
    readonly attemptsWithFallbackAfter: number;
    readonly zeroReplyTurns: number[];
  };
  close(): void;
}

const DRIVER_EVENT_PREFIXES = ['pi_driver_', 'context_', 'session_compact'];

export async function openRealSession(input: RealSessionInput): Promise<RealSession> {
  installPiObservation();
  const windowOpts = contextWindowFrom(input.env);
  if (windowOpts.contextWindow !== input.window) {
    throw new Error(`窗口装配漂移：期望 ${input.window}，实际 ${String(windowOpts.contextWindow)}（G3-M2）`);
  }

  const collector = newCollector();
  const registry = createSqliteTaskRegistry(input.dbPath);
  const policy = createResourcePolicy();
  const face = await resolveExecutionFace({
    profile: input.profile,
    env: input.env,
    stateDir: input.stateDir,
    emptyOperationsMessage: '空允许集合，拒绝',
  });
  // 与 `assembleSessionCore` 的缺省驱动同源：窗口 +（可选）压缩配置透传。本适配器注入
  // createDrivers 后必须自己保留这两个 seam，否则观测会话与生产装配漂移。
  const driverOptions = {
    env: input.env, ...windowOpts, ...compactionSettingsFrom(input.env),
    sessionDir: input.sessionDir,
    workspaceDir: input.sessionDir,
  } as const;
  const mainDriver: TurnDriver = createPiTurnDriver({ ...driverOptions, reuseConversation: true });
  const workerDriver: TurnDriver = createPiTurnDriver({ ...driverOptions });
  const scopedMain = scopeDriver(mainDriver, collector);
  const scopedWorker = scopeDriver(workerDriver, collector);
  const dispatch = await createBackgroundDispatch({
    env: input.env, profile: input.profile, stateDir: input.stateDir, registry, policy,
    emptyOperationsMessage: '空允许集合，拒绝', face, workerDriver: scopedWorker,
  });
  const assembled = await assembleSessionCore({
    env: input.env,
    profile: input.profile,
    principalId: input.principalId,
    sessionId: input.sessionId,
    dbPath: input.dbPath,
    stateDir: input.stateDir,
    setAuditPath: true,
    emptyOperationsMessage: '空允许集合，拒绝',
    taskRegistry: registry,
    policy,
    createDrivers: () => ({ mainDriver: scopedMain, workerDriver: scopedWorker }),
    createExecutionFace: async () => face,
    taskRunner: dispatch.runner,
    taskDispatch: 'async',
  });

  const zeroReplyTurns: number[] = [];
  let turn = 0;

  const mainRec = (): SessionRecord | undefined =>
    collector.records.find((s) => s.isMain) ?? collector.records[0];

  /**
   * 一轮发送。`awaitIdle=false` = background 只交办（受理即返回），后台任务由
   * `waitIdle` 统一收尾——用于 LS6 的真交错（A 在飞插 B）与在飞取消窗口。
   */
  async function performSend(text: string, awaitIdle: boolean): Promise<{ reply: string; taskIds: readonly string[] }> {
    turn += 1;
    collector.pendingText = text;
    collector.currentTurn = turn;
    for (const rec of collector.records) rec.turn = turn;
    try {
      const result = await COLLECTOR_ALS.run(collector, async () => {
        const sent = await assembled.session.send(text);
        if (awaitIdle) await dispatch.runner.whenIdle();
        return sent;
      });
      if ((result.reply ?? '').trim() === '') zeroReplyTurns.push(turn);
      return { reply: result.reply ?? '', taskIds: result.taskIds ?? [] };
    } catch (error) {
      zeroReplyTurns.push(turn);
      collector.events.push({
        event: 'r6_send_error', turn,
        message: error instanceof Error ? error.message : String(error),
      });
      return { reply: '', taskIds: [] };
    } finally {
      collector.pendingText = null;
      for (const rec of collector.records) {
        rec.lastTurnTools = new Set(rec.toolsThisTurn);
        rec.toolsThisTurn = new Set();
      }
    }
  }

  return {
    sessionId: input.sessionId,
    principalId: input.principalId,
    window: input.window,
    registry,

    async send(text: string) {
      return performSend(text, true);
    },

    /** 只交办：不等后台任务收尾（真交错/在飞取消用；收尾由 waitIdle 显式触发）。 */
    async sendNoWait(text: string) {
      return performSend(text, false);
    },

    /** 等所有后台任务落定（与 sendNoWait 配对；幂等）。 */
    async waitIdle() {
      await dispatch.runner.whenIdle();
    },

    tasks(): readonly TaskView[] {
      return assembled.session.tasks().map((task) => ({
        taskId: task.taskId,
        ...(task.taskNo === undefined ? {} : { taskNo: task.taskNo }),
        request: task.request,
        status: task.status,
        ...(task.reason === undefined ? {} : { reason: task.reason }),
        requestIds: task.executions.map((e) => e.requestId),
      }));
    },

    transcriptTokens(): number {
      const rec = mainRec();
      return rec === undefined ? 0 : estimateOf((rec.session.messages ?? []) as readonly unknown[]);
    },

    transcriptMessages(): number {
      const rec = mainRec();
      return rec === undefined ? 0 : (rec.session.messages ?? []).length;
    },

    budget(): BudgetUsage {
      const recs = collector.records.flatMap((s) => s.calls);
      return {
        calls: recs.length,
        tokens: recs.reduce((sum, r) => sum + r.tokens.total, 0),
        tokensObserved: recs.length > 0 && recs.every((r) => r.tokensObserved),
        ms: 0,
        summaryCalls: recs.filter((r) => r.kind === 'summary').length,
      };
    },

    modelCallLedger(): readonly ModelCallRecord[] {
      return collector.records.flatMap((s) => s.calls).slice().sort((a, b) => a.seq - b.seq);
    },

    compactionAttempts(): readonly CompactionAttempt[] {
      return mainRec()?.attempts ?? [];
    },

    cancelCalledLastTurn(): boolean {
      return mainRec()?.lastTurnTools.has(TASK_CANCEL_TOOL) ?? false;
    },

    /**
     * 本回合 worker 实际发起的 execute_operation（审计行：operation + 参数对象记号）。
     * 只读 tool_execution_end 观测，不改任何调用参数；对象记号用于「执行对象是否串台」判定。
     */
    executionsLastTurn(): readonly ExecutionFact[] {
      const out: ExecutionFact[] = [];
      for (const rec of collector.records) {
        for (const item of rec.executions) {
          if (item.turn === turn) out.push(item.fact);
        }
      }
      return out;
    },

    /** 本回合 task_cancel 回执（目标任务/结果）；用于在飞取消的迟到判定。 */
    cancelFactsLastTurn(): readonly CancelFact[] {
      const out: CancelFact[] = [];
      for (const rec of collector.records) {
        for (const item of rec.cancels) {
          if (item.turn === turn) out.push(item.fact);
        }
      }
      return out;
    },

    mainModelCallsLastTurn(): number {
      const rec = mainRec();
      return rec === undefined ? 0 : rec.calls.filter((c) => c.turn === turn).length;
    },

    sessionFile(): string | undefined {
      return mainDriver.sessionInfo?.()?.sessionFile;
    },

    transcriptText(): string {
      const rec = mainRec();
      if (rec === undefined) return '';
      try {
        return JSON.stringify((rec.session.messages ?? []) as readonly unknown[]);
      } catch { return ''; }
    },

    driverEvents(): readonly Record<string, unknown>[] { return collector.events; },

    compactionEntries() {
      const file = mainDriver.sessionInfo?.()?.sessionFile;
      if (file === undefined) return [];
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry['type'] === 'compaction')
          .map((entry) => ({
            summary: String(entry['summary'] ?? ''),
            summaryChars: String(entry['summary'] ?? '').length,
            tokensBefore: typeof entry['tokensBefore'] === 'number' ? entry['tokensBefore'] : null,
          }));
      } catch { return []; }
    },

    meta() {
      const recs = collector.records.flatMap((s) => s.calls);
      const mainCalls = collector.records.filter((s) => s.isMain).flatMap((s) => s.calls);
      const main = mainRec();
      const byTurn = new Map<number, number>();
      const allByTurn = new Map<number, number>();
      for (const r of recs) allByTurn.set(r.turn, (allByTurn.get(r.turn) ?? 0) + 1);
      for (const r of mainCalls) byTurn.set(r.turn, (byTurn.get(r.turn) ?? 0) + 1);
      const gap = collector.records.length === 0
        ? 'no_pi_session_observed'
        : collector.records.some((s) => s.isMain) ? null : 'main_session_identified_by_creation_order';
      return {
        observationGap: gap,
        summaryCalls: recs.filter((r) => r.kind === 'summary').length,
        mainModelCalls: mainCalls.length,
        allModelCalls: recs.length,
        mainTokens: mainCalls.reduce((sum, r) => sum + r.tokens.total, 0),
        allTokens: recs.reduce((sum, r) => sum + r.tokens.total, 0),
        maxMainCallsPerTurn: Math.max(0, ...byTurn.values()),
        maxAllCallsPerTurn: Math.max(0, ...allByTurn.values()),
        attemptsWithFallbackAfter: main?.fallbackAfter ?? 0,
        zeroReplyTurns: [...zeroReplyTurns],
      };
    },

    close(): void {
      try { mainDriver.close?.(); } catch { /* dispose 失败不影响证据 */ }
      assembled.close();
      registry.close();
    },
  };
}
