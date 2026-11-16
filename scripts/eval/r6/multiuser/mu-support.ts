/**
 * R6 MU（多用户 E2E MU）· 测试基建：**复用现有 R6 Harness**（`../oracle` / `../compaction`），
 * 在**生产同源装配**（`apps/server/server.ts` 的 `createServer`——与 `npm start` 同一装配链）
 * 的**真实交互路径**上驱动 ≥3 principal、多 Session、同进程并发、真实交错的确定性场景。
 *
 * 硬边界（对齐 owner / AGENTS.md）：
 *   · **零真实模型、零真实企微、零真实写**：假渠道事实（直接构造 `IncomingChannelMessage`）
 *     + 假执行客户端 + 假 Pi 回合驱动 + 假后台执行器 + 假通知 sink；全部仓内确定性夹具。
 *   · **不改产品码**：只 import 既有装配（`createServer` / registry / 通知 outbox）与 R6 Harness。
 *   · **任务与权限以 Task Registry 为机械 Oracle**：场景驱动走装配交互路径，判定读 registry
 *     只读快照（`TaskView`）——**不是**用直接 `registry.get` 代替交互路径。
 *   · **本模块不 import 产品运行时做判定**：Oracle 是 `../oracle` 的机械任务判据（H3/H4/H5/E-G）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ChannelReply, IncomingChannelMessage, ReplyHandler, RuntimeConfig } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver, TurnDriverInput, TurnDriverResult } from '../../../../packages/agent/src/driver-contract';
import type { Notification, NotificationSink } from '../../../../packages/agent/src/notifications';
import { createSqliteTaskRegistry } from '../../../../packages/agent/src/task-registry-sqlite';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../../../packages/agent/src/task-runner';
import { createServer, type Server } from '../../../../apps/server/server';
import { WecomBotChannel, type SdkClientLike } from '../../../../packages/channel-wecom/src/index';
import { judgeTaskContinuity, type TaskTurnFact, type TaskView, type TaskVerdict } from '../oracle';
import {
  analyzeCompaction, judgeCompactionLifecycle, R6_COMPACTION_BOUNDS,
  type CompactionAttempt, type CompactionBounds, type CompactionVerdict,
} from '../compaction';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// 身份与场景形状
// ─────────────────────────────────────────────────────────────────────────────

/** ≥3 独立 principal（三用户）；principalId = `wecom:<userid>`（server 从渠道事实派生）。 */
export const MU_PRINCIPALS = ['mu-alice', 'mu-bob', 'mu-carol'] as const;
export type MuPrincipal = (typeof MU_PRINCIPALS)[number];

/** 每 principal 的唯一语料标记（用于检漏：某会话的转录/压缩不得见他人标记）。 */
export const MU_TAGS: Readonly<Record<MuPrincipal, string>> = {
  'mu-alice': 'TAG-ALICE',
  'mu-bob': 'TAG-BOB',
  'mu-carol': 'TAG-CAROL',
};

export function principalIdOf(userId: MuPrincipal): string {
  return `wecom:${userId}`;
}

/** sessionId = `wecom:<conversationId>`（server 从渠道事实派生）；同 principal 多会话 = 多 conversationId。 */
export function sessionIdOf(conversationId: string): string {
  return `wecom:${conversationId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 并发见证：会合同步栅（真交错的机械证明）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 会合同步栅：第 N 个到达者解除全部等待。若真实执行是**串行**（假并发），第一个到达者
 * 永远等不到第 N 个 → 触发安全超时并置 `timedOut=true`——场景据此判定「非串行假并发」。
 * 这是真实并发的机械见证（不是计时近似）。
 */
export class Rendezvous {
  private arrived = 0;
  private released = false;
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;
  timedOut = false;

  constructor(private readonly expected: number, private readonly timeoutMs = 4000) {
    if (expected < 2) throw new RangeError('Rendezvous 至少需要 2 个参与者。');
  }

  arrive(): Promise<void> {
    this.arrived += 1;
    const wait = new Promise<void>((resolve) => { this.waiters.push(resolve); });
    if (this.arrived >= this.expected) {
      this.release();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { this.timedOut = true; this.release(); }, this.timeoutMs);
    }
    return wait;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  get arrivedCount(): number { return this.arrived; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 假回合驱动的计划表（keyed on 用户原文；worker 按任务子串匹配）
// ─────────────────────────────────────────────────────────────────────────────

export interface MuCall { readonly tool: string; readonly args: Readonly<Record<string, unknown>>; }
export interface MuWorkerPlan { readonly operation: string; readonly args: Readonly<Record<string, unknown>>; readonly summary: string; }

export interface MuMainPlan {
  /** 本回合显式工具调用（顺序）；run_task 也走这里（args.task）。 */
  readonly calls?: readonly MuCall[];
  readonly reply: string;
  /** true = 本回合在**执行前**会合同步栅（真并发见证）。 */
  readonly rendezvous?: boolean;
  /** 本回合结束时模拟一次会话内压缩（MU-9）：记录 before/after 与所见标记。 */
  readonly compact?: { readonly before: number; readonly after: number };
}

export interface MuPlanTable {
  readonly main: ReadonlyMap<string, MuMainPlan>;
  readonly worker: ReadonlyMap<string, MuWorkerPlan>;
  /** 用户原文 → principalId（识别 owner，用于检漏与记录五要素）。 */
  readonly ownerOfText: ReadonlyMap<string, MuPrincipal>;
}

/** 计划表构造器（链式登记，减少用例样板）。 */
export class MuPlans {
  private readonly main = new Map<string, MuMainPlan>();
  private readonly worker = new Map<string, MuWorkerPlan>();
  private readonly ownerOfText = new Map<string, MuPrincipal>();

  turn(owner: MuPrincipal, text: string, plan: MuMainPlan): this {
    this.main.set(text, plan);
    this.ownerOfText.set(text, owner);
    return this;
  }

  /** 登记一次「交办」：主回合 run_task + worker execute_operation，worker 用同一原文匹配。 */
  delegate(owner: MuPrincipal, text: string, opts: {
    reply: string; operation: string; args: Readonly<Record<string, unknown>>; summary: string;
    rendezvous?: boolean; compact?: { before: number; after: number };
  }): this {
    this.main.set(text, {
      calls: [{ tool: 'run_task', args: { task: text } }],
      reply: opts.reply,
      ...(opts.rendezvous === undefined ? {} : { rendezvous: opts.rendezvous }),
      ...(opts.compact === undefined ? {} : { compact: opts.compact }),
    });
    this.worker.set(text, { operation: opts.operation, args: opts.args, summary: opts.summary });
    this.ownerOfText.set(text, owner);
    return this;
  }

  table(): MuPlanTable { return { main: this.main, worker: this.worker, ownerOfText: this.ownerOfText }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 采集面（只读事实）
// ─────────────────────────────────────────────────────────────────────────────

export interface MuCallRecord { readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly result: unknown; readonly error: string | null; }
export interface MuMainRecord {
  readonly principalId: string;
  readonly userText: string;
  readonly messages: readonly unknown[];
  /** 宿主事实注入（Pi 原生 custom message；`TurnDriverInput.injections`，独立于 messages）。 */
  readonly injections: readonly string[];
  readonly calls: readonly MuCallRecord[];
  readonly reply: string | null;
}
export interface MuExecRecord {
  readonly requestId: string;
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly collection: string | null;
}
export interface MuCompactionRecord { readonly principalId: string; readonly before: number; readonly after: number; readonly sawTags: readonly string[]; readonly kind: CompactionAttempt['kind']; }
export interface MuTrace { readonly seq: number; readonly principalId: string; readonly phase: 'enter' | 'exit'; readonly text: string; }

export interface MuCtx {
  readonly plans: MuPlanTable;
  /** 可变：MU-9/MU-4 每轮换一个新的会合栅（每轮 3 个参与者）。 */
  rendezvous: Rendezvous | null;
  readonly mainRecords: MuMainRecord[];
  readonly execRecords: MuExecRecord[];
  readonly compactions: MuCompactionRecord[];
  readonly trace: MuTrace[];
  nextSeq: number;
}

function lastUserText(input: TurnDriverInput): string {
  const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
  return typeof last?.content === 'string' ? last.content : '';
}

function tagsIn(text: string): string[] {
  return Object.values(MU_TAGS).filter((tag) => text.includes(tag));
}

/** 主回合驱动：按用户原文取计划；执行显式工具调用（错误也采集，不逃逸）。 */
function makeMainDriver(ctx: MuCtx): TurnDriver {
  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const text = lastUserText(input);
      const plan = ctx.plans.main.get(text);
      if (plan === undefined) throw new Error(`MU 主回合未配置计划：${JSON.stringify(text)}`);
      const owner = ctx.plans.ownerOfText.get(text);
      if (owner === undefined) throw new Error(`MU 未登记原文 owner：${JSON.stringify(text)}`);
      const principal = principalIdOf(owner);
      const calls: MuCallRecord[] = [];
      if (plan.rendezvous === true) {
        ctx.trace.push({ seq: ctx.nextSeq++, principalId: principal, phase: 'enter', text });
        await ctx.rendezvous!.arrive();
      }
      for (const call of plan.calls ?? []) {
        try {
          const result = await input.exec(call.tool, { ...call.args });
          calls.push({ tool: call.tool, args: call.args, result, error: null });
        } catch (error) {
          calls.push({ tool: call.tool, args: call.args, result: null, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (plan.compact !== undefined) {
        const sawTags = new Set<string>();
        for (const message of input.messages) {
          const content = (message as { content?: unknown }).content;
          if (typeof content === 'string') for (const tag of tagsIn(content)) sawTags.add(tag);
        }
        ctx.compactions.push({ principalId: principal, before: plan.compact.before, after: plan.compact.after, sawTags: [...sawTags], kind: 'threshold' });
      }
      ctx.mainRecords.push({ principalId: principal, userText: text, messages: input.messages, injections: input.injections ?? [], calls, reply: plan.reply });
      if (plan.rendezvous === true) {
        ctx.trace.push({ seq: ctx.nextSeq++, principalId: principal, phase: 'exit', text });
      }
      return { text: plan.reply, messages: [...input.messages, { role: 'assistant', content: plan.reply } as never] };
    },
  };
}

/** Worker 驱动：在委派文本里按任务子串匹配计划，发起一次结构化执行，返回汇报。 */
function makeWorkerDriver(ctx: MuCtx): TurnDriver {
  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const text = lastUserText(input);
      let plan: MuWorkerPlan | undefined;
      for (const [request, candidate] of ctx.plans.worker) {
        if (text.includes(request)) { plan = candidate; break; }
      }
      if (plan === undefined) throw new Error(`MU Worker 未配置计划：${text.slice(0, 80)}`);
      await input.exec('execute_operation', { operation: plan.operation, args: { ...plan.args } });
      return { text: plan.summary, messages: [...input.messages, { role: 'assistant', content: plan.summary } as never] };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 假执行客户端 / 假后台执行器 / 假通知 sink
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query items', args: [{ name: '--collection', required: true }] }],
};

/**
 * 假执行客户端：记录 requestId/operation/args（含 `--collection`，用于按语料归属 principal）。
 * `failFor` 按 collection 注入一次性失败（MU-10 单用户故障隔离；与身份解耦，确定性）。
 */
export class MuFaceClient implements ExecutionClient {
  constructor(private readonly ctx: MuCtx, private readonly failFor: ReadonlyMap<string, string> = new Map()) {}

  async capabilities(): Promise<CapabilityManifest> { return MANIFEST; }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const collection = typeof request.args['--collection'] === 'string' ? (request.args['--collection'] as string) : null;
    this.ctx.execRecords.push({ requestId: request.requestId, operation: request.operation, args: request.args, collection });
    const failure = collection === null ? undefined : this.failFor.get(collection);
    if (failure !== undefined) return { status: 'failed', error: { code: 'MU_FAULT', message: failure } };
    return { status: 'completed', data: { collection } };
  }
}

/** 假后台执行器：按次返回脚本化的 TaskExecutionOutcome（background 模式）。 */
export class MuFakeExecutor implements TaskExecutor {
  readonly taskIds: string[] = [];
  private readonly handlers: Array<() => Promise<TaskExecutionOutcome>>;
  constructor(handlers: ReadonlyArray<() => Promise<TaskExecutionOutcome>> = []) { this.handlers = [...handlers]; }
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.taskIds.push(input.taskId);
    const handler = this.handlers.shift();
    if (handler === undefined) return { kind: 'completed', resultText: `（MU 假执行器）任务 ${input.taskId} 完成。` };
    return await handler();
  }
}

/** 假通知 sink：记录全部投递（渠道无关；MU-7 检「错投」时以 B 通道转录为准）。 */
export class MuRecordingSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配（生产同源：createServer）
// ─────────────────────────────────────────────────────────────────────────────

export interface MuServerHandle {
  readonly server: Server;
  readonly ctx: MuCtx;
  readonly dbPath: string;
  readonly dir: string;
  close(): void;
}

export interface CreateMuServerInput {
  readonly dir: string;
  readonly ctx: MuCtx;
  readonly mode: 'inline' | 'background';
  /**
   * 资源旋钮（`runtime` 段）**只由测试文件构造并传入**——本文件不出现旋钮字段名，
   * 以不触 `resource-policy-single-source` 守卫（该守卫排除 `*.test.ts`）。缺省 = 现行为缺省。
   */
  readonly runtime?: RuntimeConfig;
  readonly failFor?: ReadonlyMap<string, string>;
  readonly taskExecutor?: TaskExecutor;
  readonly notificationSink?: MuRecordingSink;
}

/** 仓内 dummy 夹具根（与 server 回归同源；确定性、零网络）。 */
export const MU_FIXTURE_ROOT = path.resolve(HERE, '..', '..', 'fixtures', 'dummy-platform');

function muConfig(mode: 'inline' | 'background', runtime?: RuntimeConfig): AppConfig {
  const principals: AppConfig['principals'] = {};
  for (const userId of MU_PRINCIPALS) {
    principals[principalIdOf(userId)] = { enabled: true, accountSetScope: 'all', capabilities: ['read'] };
  }
  return {
    principals,
    contextProfiles: {
      dummy: { root: MU_FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: { ...(runtime ?? {}), ...(mode === 'background' ? { dispatchMode: 'background' as const } : {}) },
  };
}

export async function createMuServer(input: CreateMuServerInput): Promise<MuServerHandle> {
  const ctx = input.ctx;
  const dbPath = path.join(input.dir, 'state.db');
  const failFor = input.failFor ?? new Map<string, string>();
  const server = await createServer({
    env: { LLM_MODEL: 'mu-test-model' },
    config: muConfig(input.mode, input.runtime),
    dbPath,
    createDrivers: () => ({ mainDriver: makeMainDriver(ctx), workerDriver: makeWorkerDriver(ctx) }),
    // 每会话一个假执行面（装配链逐会话调用该工厂）；同源共享 ctx 采集，身份由 collection 归属。
    createExecutionFace: async () => ({ client: new MuFaceClient(ctx, failFor), allowedOperations: ['dummy.query'] }),
    ...(input.taskExecutor === undefined ? {} : { taskExecutor: input.taskExecutor }),
    ...(input.notificationSink === undefined ? {} : { notificationSink: input.notificationSink }),
    logger: () => {},
  });
  return { server, ctx, dbPath, dir: input.dir, close: () => server.close() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 交互路径辅助：投递回合 / 读任务快照
// ─────────────────────────────────────────────────────────────────────────────

export function incoming(
  userId: MuPrincipal,
  conversationId: string,
  messageId: string,
  text: string,
  chatType: 'single' | 'group' = 'single',
): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
    messageId,
    chatType,
    text,
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

export async function deliver(handler: ReplyHandler, message: IncomingChannelMessage): Promise<string> {
  const reply: ChannelReply = await handler(message);
  return typeof reply === 'string' ? reply : (reply.text ?? '');
}

export interface MuTaskSnapshot {
  readonly taskId: string;
  readonly taskNo: number | undefined;
  readonly principalId: string;
  readonly sessionId: string;
  readonly request: string;
  readonly status: string;
  readonly reason: string | undefined;
  readonly requestIds: readonly string[];
  readonly replyText: string | undefined;
}

/** 只读任务快照（Task Registry 即机械 Oracle 的事实源；只投影，不 import SQLite 实现做判定）。 */
export function readTasks(dbPath: string): MuTaskSnapshot[] {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    return registry.list().map((task) => ({
      taskId: task.taskId,
      taskNo: task.taskNo,
      principalId: task.principalId,
      sessionId: task.sessionId,
      request: task.request,
      status: task.status,
      reason: task.reason,
      requestIds: task.executions.map((execution) => execution.requestId),
      replyText: task.replyText,
    }));
  } finally {
    registry.close();
  }
}

/** 快照 → R6 任务 Oracle 的可移植投影（`../oracle` 的 `TaskView`）。 */
export function toTaskViews(tasks: readonly MuTaskSnapshot[]): TaskView[] {
  return tasks.map((task) => ({
    taskId: task.taskId,
    ...(task.taskNo === undefined ? {} : { taskNo: task.taskNo }),
    request: task.request,
    status: task.status,
    ...(task.reason === undefined ? {} : { reason: task.reason }),
    requestIds: task.requestIds,
  }));
}

/** 以 R6 机械任务判据（H3/H4/H5/E-G）判定跨全批任务；供 MU 串线硬零断言。 */
export function judgeMuTasks(tasks: readonly MuTaskSnapshot[]): TaskVerdict {
  const turn: TaskTurnFact = { turn: 1, tasks: toTaskViews(tasks) };
  return judgeTaskContinuity([turn]);
}

/** MU-9：把逐会话压缩事实交给 R6 压缩生命周期判据（H6）。 */
export function judgeMuCompactions(records: readonly MuCompactionRecord[], bounds: CompactionBounds = R6_COMPACTION_BOUNDS): CompactionVerdict {
  const attempts: CompactionAttempt[] = records.map((record, index) => ({ turn: index + 1, kind: record.kind, before: record.before, after: record.after }));
  return judgeCompactionLifecycle(analyzeCompaction(attempts, []), bounds);
}

// ─────────────────────────────────────────────────────────────────────────────
// 五要素记录 + 用例结果
// ─────────────────────────────────────────────────────────────────────────────

/** 「实际投递对象」的机械取法：回复/事实到达的 (principal, session)。 */
export type MuDeliveryKind = 'reply' | 'fact_injection' | 'notification';

export interface MuDeliveryRecord {
  readonly caseId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly request: string;
  readonly deliveredTo: string;
  readonly kind: MuDeliveryKind;
}

export type MuHardZero = 'cross_principal_leak' | 'unauthorized_execution' | 'notification_misdelivery' | 'task_crossover' | 'fake_concurrency';

export type MuCaseStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface MuCaseResult {
  readonly id: string;
  readonly title: string;
  readonly status: MuCaseStatus;
  readonly hardZeroHits: readonly MuHardZero[];
  readonly records: readonly MuDeliveryRecord[];
  readonly notes: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生命周期辅助
// ─────────────────────────────────────────────────────────────────────────────

export interface MuTempDir { readonly dir: string; cleanup(): void; }

export function makeTempDir(prefix: string): MuTempDir {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 空采集上下文（每用例一份）。 */
export function makeCtx(plans: MuPlanTable, rendezvous: Rendezvous | null = null): MuCtx {
  return { plans, rendezvous, mainRecords: [], execRecords: [], compactions: [], trace: [], nextSeq: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 投递层（MU-8 第二段）：WecomBotChannel + 记录型假 SDK（silent 观察）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 记录型假 SDK（复用 `packages/channel-wecom/adapter.silent-shadow.test.ts` 的 `DeliveryRecorder`
 * 范式）：把每一次出站调用逐条记下。静默模式下它应当**全零**——这就是"实际用户可见投递 = 0"
 * 的直接读数；若有人把静默闸摘掉或翻成 live，替身会记到 ack/终帧调用，断言即红。
 *
 * 零真实平台：本替身不触网，只 Promise.resolve 合成返回值。
 */
export class MuSdkRecorder implements SdkClientLike {
  readonly replyStreams: Array<{ content: string; finish: boolean }> = [];
  readonly sentMessages: Array<{ chatid: string; content: string }> = [];
  readonly activeMedia: Array<{ chatid: string; mediaId: string }> = [];
  readonly mediaReplies: Array<{ mediaType: string; mediaId: string }> = [];
  readonly uploads: Array<{ filename: string }> = [];
  connected = 0;
  disconnected = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private uploadSeq = 0;

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect(): unknown { this.connected += 1; return this; }
  disconnect(): void { this.disconnected += 1; }
  replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.replyStreams.push({ content, finish });
    return Promise.resolve({});
  }
  uploadMedia(_data: Buffer, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id: string }> {
    this.uploads.push({ filename: options.filename });
    this.uploadSeq += 1;
    return Promise.resolve({ media_id: `mu-rec-${this.uploadSeq}` });
  }
  replyMedia(_frame: unknown, mediaType: 'image' | 'file', mediaId: string): Promise<unknown> {
    this.mediaReplies.push({ mediaType, mediaId });
    return Promise.resolve({});
  }
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.sentMessages.push({ chatid, content: body.markdown.content });
    return Promise.resolve({});
  }
  sendMediaMessage(chatid: string, _mediaType: 'file', mediaId: string): Promise<unknown> {
    this.activeMedia.push({ chatid, mediaId });
    return Promise.resolve({});
  }
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> {
    return { buffer: Buffer.from('PK'), filename: 'f.xlsx' };
  }

  /** 用户可见投递调用总数（upload 不是投递本身，但也应在静默下为零）。 */
  get userVisibleCalls(): number {
    return this.replyStreams.length + this.sentMessages.length + this.activeMedia.length + this.mediaReplies.length;
  }
  get allCalls(): number {
    return this.userVisibleCalls + this.uploads.length;
  }
}

/** MU-8 假环境凭据（假件，零真实平台；适配器启动只校验非空）。 */
export const MU_WECOM_ENV: Record<string, string | undefined> = {
  WECOM_BOT_ID: 'mu-bot',
  WECOM_BOT_SECRET: 'mu-secret',
};

export interface MuWecomChannelHandle {
  readonly channel: WecomBotChannel;
  readonly sdk: MuSdkRecorder;
  stop(): Promise<void>;
}

/**
 * 以**显式 silent** 启动 WecomBotChannel，包住给定 `ReplyHandler`（MU-8 第二段用它包 `server.handler`）。
 * 静默模式下所有用户可见出站被闸门抑制并留 `shadowEvidence`——判据"实际用户可见投递 = 0"。
 */
export async function startSilentWecomChannel(handler: ReplyHandler, root: string): Promise<MuWecomChannelHandle> {
  const sdk = new MuSdkRecorder();
  const channel = new WecomBotChannel({
    env: MU_WECOM_ENV,
    clientFactory: () => sdk,
    platformRoot: root,
    attachmentDir: path.join(root, 'tmp', 'attachments'),
    deliveryMode: 'silent',
  });
  const starting = channel.start(handler);
  sdk.emit('authenticated');
  await starting;
  return { channel, sdk, stop: () => channel.stop() };
}

/**
 * 构造一条企微文本入站帧（假件）。群聊给 chatid + chattype='group'；单聊省略 chatid
 * （适配器据此 conversationId = userid）。
 */
export function wecomTextFrame(
  reqId: string,
  opts: { msgid: string; from: string; content: string; chattype: 'single' | 'group'; chatid?: string },
): { headers: { req_id: string }; body: Record<string, unknown> } {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: opts.msgid,
      aibotid: 'mu-bot',
      chattype: opts.chattype,
      from: { userid: opts.from },
      ...(opts.chatid === undefined ? {} : { chatid: opts.chatid }),
      msgtype: 'text',
      text: { content: opts.content },
    },
  };
}

/** 等一次宏任务，让 fire-and-forget 的投递尝试落定。 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export type { DriverMessage, TurnDriver, TaskView, TaskVerdict };
