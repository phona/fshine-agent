/**
 * R4 · 稳定性加固 · 假件与装配助手（浸泡/压力/混沌套件共用）。
 *
 * 纯测试基建，零产品语义：全部假 executor / 假 sink / 假渠道（经 `server.handler`）/
 * 可注入时钟；装配走生产同一核心 `assembleSessionCore`（不 mock 产品逻辑）。
 * 预注册：`docs/product/r4-stability-prereg.md` §三/§四。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import type {
  DeliveryReceipt,
  Notification,
  NotificationOutbox,
  NotificationSink,
} from '../../packages/agent/src/notifications';
import { createNotificationOutbox } from '../../packages/agent/src/notifications';
import type {
  TaskExecutionContext,
  TaskExecutionInput,
  TaskExecutionOutcome,
  TaskExecutor,
  TaskRecordView,
  TaskScope,
} from '../../packages/agent/src/task-runner';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { assembleSessionCore, attachNotificationOutbox } from '../ask-runtime';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

export const STAB_PROFILE = { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] };
export const STAB_MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

export type StabRegistry = ReturnType<typeof createSqliteTaskRegistry>;
export type StabAssembled = Awaited<ReturnType<typeof assembleSessionCore>>;
export type StabRuntimeConfig = NonNullable<Parameters<typeof assembleSessionCore>[0]['runtime']>;

// ---------------------------------------------------------------------------
// 可控时钟
// ---------------------------------------------------------------------------

export class ControllableClock {
  private currentMs = Date.parse('2026-11-14T00:00:00.000Z');
  readonly now = (): Date => new Date(this.currentMs);
  get ms(): number {
    return this.currentMs;
  }
  set(ms: number): void {
    this.currentMs = ms;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

// ---------------------------------------------------------------------------
// 假 Main/Worker 驱动
// ---------------------------------------------------------------------------

export interface MainPlan {
  delegates?: readonly string[];
  reply?: string;
}

export interface RecordedTurn {
  messages: readonly DriverMessage[];
  execResults: unknown[];
}

export function createFakeMainDriver(planFor: (text: string) => MainPlan | undefined, records: RecordedTurn[]): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = planFor(text);
      if (plan === undefined) throw new Error(`（stab 假件）未配置计划的回合：${text}`);
      const execResults: unknown[] = [];
      for (const request of plan.delegates ?? []) {
        const tool = input.tools[0];
        if (tool === undefined) throw new Error('（stab 假件）Main 无工具面');
        execResults.push(await input.exec(tool.name, { task: request }));
      }
      records.push({ messages: input.messages, execResults });
      const reply = plan.reply ?? `（stab 假件回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

export function unreachableWorkerDriver(): TurnDriver {
  return {
    async run() {
      throw new Error('（stab 假件）worker driver 不应被直接调用');
    },
  };
}

// ---------------------------------------------------------------------------
// 假执行面（dummy.query）与假 executor
// ---------------------------------------------------------------------------

export class FaceClient implements ExecutionClient {
  executeCalls = 0;
  async capabilities(): Promise<CapabilityManifest> {
    return STAB_MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    this.executeCalls += 1;
    return { status: 'completed', data: {} };
  }
}

export type ExecBehavior = (input: TaskExecutionInput, context: TaskExecutionContext) => Promise<TaskExecutionOutcome>;

export class FakeTaskExecutor implements TaskExecutor {
  readonly calls: TaskExecutionInput[] = [];
  private readonly behavior: ExecBehavior;
  constructor(behavior: ExecBehavior) {
    this.behavior = behavior;
  }
  async execute(input: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.calls.push({ ...input });
    return await this.behavior(input, context);
  }
}

export interface GatedExecutor {
  executor: TaskExecutor;
  calls: TaskExecutionInput[];
  release(): void;
  isReleased(): boolean;
}

/** 门控 executor：前 `gateAfter` 个调用立即完成，其后全部等待 `release()`（制造真实积压）。 */
export function createGatedExecutor(options: { gateAfter?: number; resultText?: (input: TaskExecutionInput) => string } = {}): GatedExecutor {
  const gateAfter = options.gateAfter ?? 0;
  const text = options.resultText ?? ((input: TaskExecutionInput) => `（stab 结果）${input.request}`);
  const calls: TaskExecutionInput[] = [];
  let released = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const executor: TaskExecutor = {
    async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
      calls.push({ ...input });
      if (calls.length > gateAfter && !released) await gate;
      return { kind: 'completed', resultText: text(input) };
    },
  };
  return {
    executor,
    calls,
    release: () => {
      if (!released) {
        released = true;
        releaseGate();
      }
    },
    isReleased: () => released,
  };
}

export interface CancelableExecutor {
  executor: TaskExecutor;
  calls: TaskExecutionInput[];
  wasAborted(): boolean;
}

/** 可取消 executor：`cancelTaskId` 的回合等待 abort signal 后确认 cancelled；其余立即完成。 */
export function createCancelableExecutor(options: { cancelTaskId: string }): CancelableExecutor {
  const calls: TaskExecutionInput[] = [];
  let aborted = false;
  const executor: TaskExecutor = {
    async execute(input: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
      calls.push({ ...input });
      if (input.taskId !== options.cancelTaskId) return { kind: 'completed', resultText: `（stab 结果）${input.request}` };
      return await new Promise<TaskExecutionOutcome>((resolve) => {
        const confirm = (): void => {
          aborted = true;
          resolve({ kind: 'cancelled' });
        };
        if (context.signal.aborted) {
          confirm();
          return;
        }
        context.signal.addEventListener('abort', confirm, { once: true });
      });
    },
  };
  return { executor, calls, wasAborted: () => aborted };
}

// ---------------------------------------------------------------------------
// 假 sink（失败注入 + 实收计数）
// ---------------------------------------------------------------------------

export class InjectingSink implements NotificationSink {
  readonly sent: Notification[] = [];
  readonly deliveredCounts = new Map<number, number>();
  private readonly attemptsSeen = new Map<number, number>();
  private readonly failureEvery: number;
  private readonly failAll: boolean;
  constructor(options: { failureEvery?: number; failAll?: boolean } = {}) {
    this.failureEvery = options.failureEvery ?? 0;
    this.failAll = options.failAll === true;
  }
  async send(notification: Notification): Promise<DeliveryReceipt> {
    this.sent.push(notification);
    const attempt = (this.attemptsSeen.get(notification.id) ?? 0) + 1;
    this.attemptsSeen.set(notification.id, attempt);
    const shouldFail = this.failAll || (this.failureEvery > 0 && notification.id % this.failureEvery === 0 && attempt === 1);
    if (shouldFail) return { delivered: false, error: 'STAB_CHANNEL_DOWN' };
    this.deliveredCounts.set(notification.id, (this.deliveredCounts.get(notification.id) ?? 0) + 1);
    return { delivered: true };
  }
}

// ---------------------------------------------------------------------------
// 装配 / 通知 / 收尾助手
// ---------------------------------------------------------------------------

export interface AssembleStabOptions {
  dbPath: string;
  stateDir: string;
  sessionId: string;
  principalId: string;
  mainDriver: TurnDriver;
  workerDriver: TurnDriver;
  taskExecutor: TaskExecutor;
  registry: StabRegistry;
  runtime: StabRuntimeConfig;
  runnerOptions?: { leaseMs?: number; now?: () => Date; owner?: string };
}

export async function assembleStabSession(options: AssembleStabOptions): Promise<StabAssembled> {
  return await assembleSessionCore({
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    profile: STAB_PROFILE,
    principalId: options.principalId,
    sessionId: options.sessionId,
    dbPath: options.dbPath,
    stateDir: options.stateDir,
    setAuditPath: true,
    emptyOperationsMessage: '（stab 假件）执行层没有声明任何只读 operation',
    mainSystemPrompt: '（stab 假件）Main 系统提示',
    workerSkills: [],
    createDrivers: () => ({ mainDriver: options.mainDriver, workerDriver: options.workerDriver }),
    createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
    runtime: options.runtime,
    taskExecutor: options.taskExecutor,
    taskRegistry: options.registry,
    ...(options.runnerOptions === undefined ? {} : { runnerOptions: options.runnerOptions }),
  });
}

export function attachStabOutbox(
  registry: StabRegistry,
  dbPath: string,
  sink: NotificationSink,
  clock: ControllableClock,
  maxAttempts = 5,
): NotificationOutbox {
  const outbox = createNotificationOutbox({ dbPath, sink, maxAttempts, baseBackoffMs: 1000, now: clock.now });
  attachNotificationOutbox(registry, outbox);
  return outbox;
}

/** 有界收尾：45s 内部预算；超时返回 false（=挂死读数），不吊死测试。 */
export async function waitIdleWithTimeout(assembled: StabAssembled, timeoutMs = 45_000): Promise<boolean> {
  const runner = assembled.runner;
  if (runner === undefined) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runner.whenIdle(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('STAB_IDLE_TIMEOUT')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 推进注入时钟直到未送达归零（或轮次用尽；sink 恒失败时用尽＝读数）。 */
export async function driveDeliveries(outbox: NotificationOutbox, clock: ControllableClock, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await outbox.deliverPending();
    if (outbox.undelivered().length === 0) return;
    clock.advance(2000);
  }
}

export async function pollUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

export function sampleRssMedian(): number {
  const values: number[] = [];
  for (let i = 0; i < 3; i += 1) values.push(process.memoryUsage().rss);
  values.sort((a, b) => a - b);
  return values[1]!;
}

export function rssGrowth(base: number, end: number): number {
  return base > 0 ? (end - base) / base : 0;
}

// ---------------------------------------------------------------------------
// 读数汇总
// ---------------------------------------------------------------------------

const OPEN_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_user', 'cancelling']);

export interface TaskSummary {
  terminalCounts: Record<string, number>;
  terminalReasonCounts: Record<string, number>;
  openOnDrain: number;
  executorCallsPerTask: Record<string, number>;
  duplicateSideEffectTasks: string[];
  callsByTask: Map<string, number>;
}

export function summarizeTasks(tasks: readonly TaskRecordView[], calls: readonly TaskExecutionInput[]): TaskSummary {
  const terminalCounts: Record<string, number> = {};
  const terminalReasonCounts: Record<string, number> = {};
  let openOnDrain = 0;
  for (const task of tasks) {
    terminalCounts[task.status] = (terminalCounts[task.status] ?? 0) + 1;
    if (task.reason !== undefined) terminalReasonCounts[task.reason] = (terminalReasonCounts[task.reason] ?? 0) + 1;
    if (OPEN_STATUSES.has(task.status)) openOnDrain += 1;
  }
  const callsByTask = new Map<string, number>();
  for (const call of calls) callsByTask.set(call.taskId, (callsByTask.get(call.taskId) ?? 0) + 1);
  const executorCallsPerTask: Record<string, number> = {};
  for (const [taskId, count] of callsByTask) executorCallsPerTask[taskId] = count;
  const duplicateSideEffectTasks = [...callsByTask.entries()].filter(([, count]) => count > 1).map(([taskId]) => taskId);
  return { terminalCounts, terminalReasonCounts, openOnDrain, executorCallsPerTask, duplicateSideEffectTasks, callsByTask };
}

export function mergeCalls(...lists: TaskExecutionInput[][]): TaskExecutionInput[] {
  return lists.flat();
}

export interface NotificationSummary {
  rows: Notification[];
  undelivered: number;
  duplicateRows: number;
}

export function notificationSummary(outbox: NotificationOutbox): NotificationSummary {
  const rows = outbox.listNotifications();
  const keys = new Set(rows.map((row) => `${row.taskId}\u0000${row.kind}\u0000${row.stateVersion}`));
  return { rows, undelivered: outbox.undelivered().length, duplicateRows: rows.length - keys.size };
}

export function deliveredToObject(...maps: Map<number, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) {
    for (const [id, count] of map) out[String(id)] = (out[String(id)] ?? 0) + count;
  }
  return out;
}

export function stabScope(principalId: string, sessionId: string): TaskScope {
  return { principalId, sessionId };
}

export function makeStabTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeStabTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function createStabRegistry(dbPath: string): StabRegistry {
  return createSqliteTaskRegistry(dbPath);
}
