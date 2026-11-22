/**
 * TaskRunner 语义测试（P6，先红后绿；来源 docs/history/r4-joint-interfaces.md §1/§2/§3 v1 冻结）。
 *
 * 全部用假端口：
 *   · FakeRegistry —— 镜像 P2 契约核心的**消费面语义**（状态集/合法边/租约/认领/过期/取消/等待）；
 *     后台终态按 P2 契约测试同口径由「执行端确认的结局」经 transition/fail 落底账，
 *     不走 inline judgeReportedTask（其「首个非 completed 判负」会误伤等待接续）；
 *   · FakePolicy —— 前后台独立计数的许可假件（acquire/release/cancelQueued）；
 *   · FakeExecutor —— 手动控制的延迟执行回合（记录并发、输入、abort 信号）。
 *
 * 覆盖：受理快速返回 / 排队启动收尾 / 并发上限 / 重启恢复三态（queued 重领、过期租约 unknown
 * 不重放、completed 不重跑、inline 无租约不回收）/ 取消语义（请求≠取消、确认才 cancelled、
 * 未确认回 running 如实落终态）/ waiting_user 释放与同任务接续 / 满载前台可用（许可拒绝=错误面，
 * 不排队阻塞）/ 收尾不覆盖外部终态。
 *
 * 明确不在本文件断言（职责边界）：后台转录不进 mainMessages（由注入 executor 保证，
 * runner 只编排且不持有转录）；通知投递（P4）；资源限额实现（P5）。
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionStatus } from '@fshine/contracts/execution-contract';
import { deriveTaskName, type ExecutionRecord } from './src/task-registry';
import {
  createTaskRunner,
  type CancelOutcome,
  type PendingQuestion,
  type PumpSummary,
  type ResourcePermit,
  type ResourcePolicyPort,
  type ResourceRejection,
  type ResourceRejectionReason,
  type TaskExecutionInput,
  type TaskExecutionContext,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRecordView,
  type TaskRegistryPort,
  type TaskRunner,
  type TaskScope,
  type TimeoutKind,
} from './src/task-runner';

/**
 * 假底账内部状态词（S1：真实底账已无 status/reason 结论字段——本轮测试替身仍以旧状态词
 * 建模、仅供本文件断言；契约消费面字段（pendingQuestion/lease/四个时刻）与真实实现同形）。
 */
type TaskStatus =
  | 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'cancelled'
  | 'completed' | 'failed' | 'timed_out' | 'unexecuted';
type TaskReason = 'cancelled_by_user' | 'timeout' | 'failed_confirmed' | 'result_unknown' | 'resource_limited';

// ---------------------------------------------------------------------------
// 假底账：镜像 P2 §1 的消费面（合法边矩阵/租约/认领/过期/取消/等待/执行事实判定）。
// ---------------------------------------------------------------------------

const LEGAL_EDGES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelling', 'cancelled', 'timed_out'],
  running: ['completed', 'failed', 'waiting_user', 'cancelling', 'cancelled', 'timed_out', 'unexecuted'],
  waiting_user: ['running', 'cancelling', 'cancelled', 'timed_out'],
  cancelling: ['cancelled', 'running'],
  cancelled: [],
  completed: [],
  failed: [],
  timed_out: [],
  unexecuted: [],
};

interface FakeTask {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  status: TaskStatus;
  reason?: TaskReason;
  resultText?: string;
  failureReason?: string;
  pendingQuestion?: PendingQuestion;
  waitingSince?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  runningSince?: string;
  diedAt?: string;
  cancelledAt?: string;
  timedOutAt?: string;
  resourceLimitedAt?: string;
  cancelRequestedAt?: string;
  roundFailedAt?: string;
  taskNo: number;
  name: string;
  executions: ExecutionRecord[];
  createdAt: string;
  updatedAt: string;
}

interface FakeFact {
  taskId: string;
  from?: TaskStatus;
  to: TaskStatus;
  reason?: TaskReason;
}

class FakeRegistry implements TaskRegistryPort {
  private readonly tasks = new Map<string, FakeTask>();
  private nextNo = 0;
  private requestSeq = 0;
  readonly facts: FakeFact[] = [];

  constructor(private readonly clock: () => Date) {}

  /** 模拟持久底账里的既有行（上一进程遗留），不产生新事实。 */
  seed(input: {
    taskId: string;
    status: TaskStatus;
    request?: string;
    leaseOwner?: string;
    leaseUntil?: string;
  }): void {
    this.nextNo += 1;
    const now = this.clock().toISOString();
    const task: FakeTask = {
      taskId: input.taskId,
      principalId: 'p',
      sessionId: 's',
      request: input.request ?? '种子任务',
      status: input.status,
      ...(input.status === 'running' ? { runningSince: now } : {}),
      taskNo: this.nextNo,
      name: deriveTaskName(input.request ?? '种子任务'),
      executions: [],
      createdAt: now,
      updatedAt: now,
      ...(input.leaseOwner === undefined ? {} : { leaseOwner: input.leaseOwner }),
      ...(input.leaseUntil === undefined ? {} : { leaseUntil: input.leaseUntil }),
    };
    this.tasks.set(task.taskId, task);
  }

  /** 执行回合记录执行事实（真实装配里由执行入口调用；runner 不代记）。 */
  noteExecution(taskId: string, status: ExecutionStatus, message?: string): void {
    const task = this.require(taskId);
    this.requestSeq += 1;
    task.executions.push({
      requestId: `req_test_${this.requestSeq}`,
      operation: 'dummy.query',
      status,
      ...(message === undefined ? {} : { error: { code: 'TEST_CODE', message } }),
    });
  }

  statusOf(taskId: string): TaskStatus {
    return this.require(taskId).status;
  }

  requestOf(taskId: string): string {
    return this.require(taskId).request;
  }

  reasonOf(taskId: string): TaskReason | undefined {
    return this.require(taskId).reason;
  }

  failureReasonOf(taskId: string): string | undefined {
    return this.require(taskId).failureReason;
  }

  pendingQuestionOf(taskId: string): PendingQuestion | undefined {
    return this.require(taskId).pendingQuestion;
  }

  waitingSinceOf(taskId: string): string | undefined {
    return this.require(taskId).waitingSince;
  }

  leaseUntilOf(taskId: string): string | undefined {
    return this.require(taskId).leaseUntil;
  }

  taskNoOf(taskId: string): number | undefined {
    return this.require(taskId).taskNo;
  }

  executionsOf(taskId: string): readonly ExecutionRecord[] {
    return [...this.require(taskId).executions];
  }

  factsOf(taskId: string): readonly FakeFact[] {
    return this.facts.filter((fact) => fact.taskId === taskId);
  }

  // --- TaskRegistryPort ---

  begin(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    request: string;
    queued?: boolean;
  }): TaskRecordView {
    if (this.tasks.has(input.taskId)) throw new Error(`重复任务：${input.taskId}`);
    this.nextNo += 1;
    const now = this.clock().toISOString();
    const task: FakeTask = {
      taskId: input.taskId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      request: input.request,
      status: input.queued === true ? 'queued' : 'running',
      ...(input.queued === true ? {} : { runningSince: now }),
      taskNo: this.nextNo,
      name: deriveTaskName(input.request),
      executions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    this.facts.push({ taskId: task.taskId, to: task.status });
    return task;
  }

  get(taskId: string, scope?: TaskScope): TaskRecordView {
    return this.require(taskId, scope);
  }

  transition(taskId: string, to: TaskStatus, options?: { reason?: TaskReason; scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, to, options?.reason === undefined ? {} : { reason: options.reason });
    return task;
  }

  waitForUser(taskId: string, pendingQuestion: PendingQuestion, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, 'waiting_user');
    task.pendingQuestion = pendingQuestion;
    task.waitingSince = this.clock().toISOString();
    return task;
  }

  answerResumes(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, 'running');
    task.pendingQuestion = undefined;
    task.waitingSince = undefined;
    return task;
  }

  requestCancel(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, 'cancelling');
    return task;
  }

  confirmCancelled(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, 'cancelled');
    return task;
  }

  timeout(taskId: string, kind: TimeoutKind, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    const expected: TaskStatus = kind === 'queued' ? 'queued' : kind === 'execution' ? 'running' : 'waiting_user';
    if (task.status !== expected) throw new Error(`超时种类 ${kind} 只适用于 ${expected}，当前 ${task.status}`);
    this.commit(task, 'timed_out');
    return task;
  }

  markResultUnknown(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    this.commit(task, 'failed', { reason: 'result_unknown' });
    return task;
  }

  fail(taskId: string, reason: string): void {
    const task = this.require(taskId);
    this.commit(task, 'failed');
    task.failureReason = reason;
    task.updatedAt = this.clock().toISOString();
  }

  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecordView | undefined {
    const candidate = [...this.tasks.values()]
      .filter((task) => task.status === 'queued')
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))[0];
    if (candidate === undefined) return undefined;
    this.commit(candidate, 'running');
    if (candidate.runningSince === undefined) candidate.runningSince = this.clock().toISOString();
    candidate.leaseOwner = input.owner;
    candidate.leaseUntil = new Date(this.clock().getTime() + input.leaseMs).toISOString();
    candidate.updatedAt = this.clock().toISOString();
    return candidate;
  }

  expireLeases(now = this.clock().toISOString()): readonly TaskRecordView[] {
    const affected: FakeTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      // 与 P2 同口径：无租约（inline 任务）不在回收范围；仅过期租约落 result_unknown。
      if (task.leaseUntil === undefined || task.leaseUntil > now) continue;
      this.commit(task, 'failed', { reason: 'result_unknown' });
      affected.push(task);
    }
    return affected;
  }

  // --- TaskRegistryPort（S1 事实写入面；测试替身仍以状态词建模供本文件断言） ---

  markCancelled(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    if (task.status !== 'cancelled') this.commit(task, 'cancelled');
    return task;
  }

  markTimedOut(taskId: string, _kind: TimeoutKind, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    if (task.status !== 'timed_out') this.commit(task, 'timed_out');
    return task;
  }

  markDied(taskId: string): TaskRecordView {
    const task = this.require(taskId);
    if (!task.diedAt) {
      task.diedAt = this.clock().toISOString();
      // 真实 markDied 幂等（WHERE died_at IS NULL，不抛）：已落 failed（如先 noteRoundFailed）
      // 时只补 reason，不重走非法边。
      if ((LEGAL_EDGES[task.status] ?? []).includes('failed')) {
        this.commit(task, 'failed', { reason: 'result_unknown' });
      } else {
        task.reason = 'result_unknown';
      }
    }
    return task;
  }

  markCancelRequested(taskId: string, options?: { scope?: TaskScope }): TaskRecordView {
    const task = this.require(taskId, options?.scope);
    // 请求 ≠ 确认：只落请求时刻（一次性），不改终局、不清租约。
    if (task.cancelRequestedAt === undefined) task.cancelRequestedAt = this.clock().toISOString();
    return task;
  }

  /** 回合失败事实：底账不写结论（真实实现落 round_failed_at 一次性收尾事实）；测试替身落 failed 供断言。 */
  noteRoundFailed(taskId: string): void {
    const task = this.require(taskId);
    const legal = (LEGAL_EDGES[task.status] ?? []).includes('failed');
    if (legal) this.commit(task, 'failed');
    if (task.roundFailedAt === undefined) task.roundFailedAt = this.clock().toISOString();
  }

  /** 后台完成汇报存档（可选端口；runner 有它即走存档面）。 */
  archiveReply(taskIds: readonly string[], replyText: string): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task === undefined) continue;
      if ((LEGAL_EDGES[task.status] ?? []).includes('completed')) this.commit(task, 'completed');
      task.resultText = replyText;
    }
  }

  diedAtOf(taskId: string): string | undefined {
    return this.require(taskId).diedAt;
  }

  cancelRequestedAtOf(taskId: string): string | undefined {
    return this.require(taskId).cancelRequestedAt;
  }

  roundFailedAtOf(taskId: string): string | undefined {
    return this.require(taskId).roundFailedAt;
  }

  // --- 内部 ---

  private require(taskId: string, scope?: TaskScope): FakeTask {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`任务不存在：${taskId}`);
    if (scope !== undefined && (task.principalId !== scope.principalId || task.sessionId !== scope.sessionId)) {
      throw new Error(`越权访问：${taskId}`);
    }
    return task;
  }

  private commit(task: FakeTask, to: TaskStatus, options: { reason?: TaskReason } = {}): void {
    const from = task.status;
    if (!(LEGAL_EDGES[from] ?? []).includes(to)) throw new Error(`非法任务状态转换：${from} → ${to}`);
    task.status = to;
    const at = this.clock().toISOString();
    if (to === 'cancelled') { task.reason = options.reason ?? 'cancelled_by_user'; if (task.cancelledAt === undefined) task.cancelledAt = at; }
    else if (to === 'timed_out') { task.reason = options.reason ?? 'timeout'; if (task.timedOutAt === undefined) task.timedOutAt = at; }
    else if (to === 'failed') { task.reason = options.reason ?? 'failed_confirmed'; }
    else task.reason = undefined;
    if (to !== 'running') {
      task.leaseOwner = undefined;
      task.leaseUntil = undefined;
    }
    task.updatedAt = this.clock().toISOString();
    this.facts.push({
      taskId: task.taskId,
      from,
      to,
      ...(task.reason === undefined ? {} : { reason: task.reason }),
    });
  }
}

// ---------------------------------------------------------------------------
// 假许可：前后台独立计数；满载即拒绝（错误面），不实现第二套队列。
// ---------------------------------------------------------------------------

class FakePolicy implements ResourcePolicyPort {
  backgroundInUse = 0;
  foregroundInUse = 0;
  readonly acquireCalls: { kind: 'foreground' | 'background'; taskId?: string }[] = [];
  readonly released: ResourcePermit[] = [];
  readonly cancelledQueued: string[] = [];
  /** 测试注入的强制拒绝（模拟 P5 的容量满/预算尽）。 */
  forcedRejection?: ResourceRejectionReason;

  constructor(
    readonly backgroundLimit = 1,
    readonly foregroundLimit = 1,
  ) {}

  acquire(kind: 'foreground' | 'background', opts?: { taskId?: string }): ResourcePermit | ResourceRejection {
    this.acquireCalls.push({ kind, ...(opts?.taskId === undefined ? {} : { taskId: opts.taskId }) });
    if (kind === 'background') {
      if (this.forcedRejection !== undefined) return { reason: this.forcedRejection };
      if (this.backgroundInUse >= this.backgroundLimit) return { reason: 'queue_full' };
      this.backgroundInUse += 1;
      return { kind: 'background', ...(opts?.taskId === undefined ? {} : { taskId: opts.taskId }) };
    }
    if (this.foregroundInUse >= this.foregroundLimit) return { reason: 'queue_full' };
    this.foregroundInUse += 1;
    return { kind: 'foreground', ...(opts?.taskId === undefined ? {} : { taskId: opts.taskId }) };
  }

  release(permit: ResourcePermit): void {
    if (permit.kind === 'background') this.backgroundInUse -= 1;
    else this.foregroundInUse -= 1;
    this.released.push(permit);
  }

  cancelQueued(taskId: string): void {
    this.cancelledQueued.push(taskId);
  }

  // --- P0-C① 后台计量：与真实 ResourcePolicy 同契约（未准入的任务抛错，不造预算） ---
  readonly budgetTaskIds = new Set<string>();
  readonly metered: { taskId: string; usage: { calls?: number; ms?: number } }[] = [];

  budgetFor(taskId: string): { consume(usage: { calls?: number; ms?: number }): void } {
    if (!this.budgetTaskIds.has(taskId)) throw new Error(`未知任务预算：${taskId}`);
    return {
      consume: (usage) => {
        this.metered.push({ taskId, usage });
      },
    };
  }
}

function isRejection(value: ResourcePermit | ResourceRejection): value is ResourceRejection {
  return typeof value === 'object' && value !== null && 'reason' in value;
}

// ---------------------------------------------------------------------------
// 假执行器：每任务一次回合；手动落定，便于测并发上限与 abort 观察。
// ---------------------------------------------------------------------------

interface ExecutorCall {
  input: TaskExecutionInput;
  context: TaskExecutionContext;
}

class FakeExecutor implements TaskExecutor {
  readonly calls: ExecutorCall[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  private readonly settles: { resolve: (outcome: TaskExecutionOutcome) => void; reject: (error: unknown) => void }[] = [];

  constructor(private readonly registry: FakeRegistry) {}

  execute(input: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const index = this.calls.length;
    this.calls.push({ input, context });
    return new Promise<TaskExecutionOutcome>((resolve, reject) => {
      const settle = (kind: 'resolve' | 'reject', value: unknown): void => {
        this.concurrent -= 1;
        (kind === 'resolve' ? resolve : reject)(value as never);
      };
      this.settles[index] = { resolve: (outcome) => settle('resolve', outcome), reject: (error) => settle('reject', error) };
    });
  }

  noteExecution(index: number, status: ExecutionStatus, message?: string): void {
    this.registry.noteExecution(this.calls[index]!.input.taskId, status, message);
  }

  settle(index: number, outcome: TaskExecutionOutcome): void {
    this.settles[index]!.resolve(outcome);
  }

  failRound(index: number, error: unknown): void {
    this.settles[index]!.reject(error);
  }
}

// ---------------------------------------------------------------------------
// 装配与工具
// ---------------------------------------------------------------------------

function harness(options: { backgroundLimit?: number } = {}) {
  const clock = { now: new Date('2026-11-14T00:00:00.000Z') };
  const registry = new FakeRegistry(() => clock.now);
  const start = (startOptions: { backgroundLimit?: number } = {}) => {
    const policy = new FakePolicy(startOptions.backgroundLimit ?? options.backgroundLimit ?? 1);
    const executor = new FakeExecutor(registry);
    const errors: { taskId: string; error: unknown }[] = [];
    const runner: TaskRunner = createTaskRunner({
      registry,
      policy,
      executor,
      owner: 'test-runner',
      leaseMs: 10_000,
      now: () => clock.now,
      onError: (failure) => errors.push(failure),
    });
    return { policy, executor, runner, errors };
  };
  return { clock, registry, start, ...start() };
}

/** 等到条件成立（冲刷微任务与 0ms 宏任务；最多 200 轮）。 */
async function until(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`until 超时：${message}`);
}

function submit(h: ReturnType<typeof harness>, taskId: string, request = `任务 ${taskId}`): TaskRecordView {
  return h.runner.submit({ taskId, principalId: 'p', sessionId: 's', request });
}

// ---------------------------------------------------------------------------
// 1. 受理快速返回
// ---------------------------------------------------------------------------

describe('受理（submit）', () => {
  it('受理即 queued、同步返回、不执行不占许可（Main 不等待）', () => {
    const h = harness();
    const record = h.runner.submit({ taskId: 't1', principalId: 'p', sessionId: 's', request: '查一下今年销售额' });
    expect(record.runningSince).toBeUndefined();
    expect(record.name).toBe(deriveTaskName('查一下今年销售额'));
    expect(h.executor.calls).toHaveLength(0);
    expect(h.policy.acquireCalls).toHaveLength(0);
    expect(h.registry.statusOf('t1')).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// 2. 排队 / 启动 / 收尾
// ---------------------------------------------------------------------------

describe('排队 → 启动 → 收尾', () => {
  it('pump 按许可启动排队任务：认领→running→回合收尾，许可归还、在飞清空', async () => {
    const h = harness({ backgroundLimit: 2 });
    submit(h, 't1', '第一个任务');
    submit(h, 't2', '第二个任务');

    const summary = h.runner.pump();
    expect(summary.started).toEqual(['t1', 't2']);
    expect(h.registry.statusOf('t1')).toBe('running');
    expect(h.registry.leaseUntilOf('t1')).toBeDefined();
    expect(h.executor.calls.map((call) => call.input.taskId)).toEqual(['t1', 't2']);
    const first = h.executor.calls[0]!;
    expect(first.input.principalId).toBe('p');
    expect(first.input.sessionId).toBe('s');
    expect(first.input.request).toBe('第一个任务');
    expect(first.context.signal.aborted).toBe(false);

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '第一个完成' });
    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'ended', report: '第二个完成' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.statusOf('t2')).toBe('completed');
    expect(h.policy.backgroundInUse).toBe(0);
    expect(h.runner.inFlight()).toEqual([]);
  });

  it('后台终态 = 执行端确认的回合结局：不做 task 级 judge 二次判定（历史非 completed 执行行不判负）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    // P2 契约同口径：后台路径由 runner 按执行层确认的结果落终态，不经过 inline
    // judgeReportedTask——否则等待接续的历史 needs_input 行会把已完成的接续误判为 failed。
    h.executor.noteExecution(0, 'needs_input');
    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '完成' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.reasonOf('t1')).toBeUndefined();
    expect(h.registry.executionsOf('t1')).toHaveLength(2);
  });

  it('执行端确认失败：failed + 机械原因 failed_confirmed + 原因原文落底账', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'ended' }); // 无汇报 = 回合失败事实（S1：执行端不产出结论）
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('failed');
    expect(h.registry.reasonOf('t1')).toBe('failed_confirmed');
    // 2026-11-22 Grok 复审：无汇报收尾还要落一条「本轮已停」事实（round_failed_at），
    // 否则 running_since 仍在、无结束事实，「久无动静」扫描会把已结束的任务当「还在跑」。
    expect(h.registry.roundFailedAtOf('t1')).toBeDefined();
  });

  it('执行端确认执行超时：running→timed_out + reason=timeout（P5 边界内的执行端判定）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'timed_out' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('timed_out');
    expect(h.registry.reasonOf('t1')).toBe('timeout');
    expect(h.policy.backgroundInUse).toBe(0);
  });

  it('结果未知（result_unknown）：落 died_at（「结果未知」是 died 语义，不是「无汇报」）', async () => {
    // Grok 复审 2026-11-22：S1 后 settle 只 noteRoundFailed 清租约、不 markDied → 底账无
    // died_at，展示词退成「无汇报」，重启对账也认不出这条已死行。结果未知必须落 died_at。
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'result_unknown' });
    await h.runner.whenIdle();

    expect(h.registry.diedAtOf('t1')).toBeDefined();
    expect(h.registry.reasonOf('t1')).toBe('result_unknown');
  });
});

// ---------------------------------------------------------------------------
// 3. 并发上限
// ---------------------------------------------------------------------------

describe('并发上限（仅按许可）', () => {
  it('backgroundConcurrency=1 下三任务串行，任何时刻不超发', async () => {
    const h = harness({ backgroundLimit: 1 });
    submit(h, 't1');
    submit(h, 't2');
    submit(h, 't3');

    h.runner.pump();
    expect(h.executor.calls.map((call) => call.input.taskId)).toEqual(['t1']);
    expect(h.executor.maxConcurrent).toBe(1);

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '一' });
    await until(() => h.executor.calls.length === 2, 't2 在 t1 释放许可后上位');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    expect(h.executor.maxConcurrent).toBe(1);

    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'ended', report: '二' });
    await until(() => h.executor.calls.length === 3, 't3 在 t2 释放许可后上位');
    expect(h.executor.calls[2]!.input.taskId).toBe('t3');
    expect(h.executor.maxConcurrent).toBe(1);

    h.executor.noteExecution(2, 'completed');
    h.executor.settle(2, { kind: 'ended', report: '三' });
    await h.runner.whenIdle();
    expect(h.executor.maxConcurrent).toBe(1);
    expect(h.policy.backgroundInUse).toBe(0);
    expect(['t1', 't2', 't3'].map((id) => h.registry.statusOf(id))).toEqual(['completed', 'completed', 'completed']);
  });
});

// ---------------------------------------------------------------------------
// 4. 满载语义与前台可用
// ---------------------------------------------------------------------------

describe('许可拒绝 = 错误面（不排队阻塞）；前台独立配额可用', () => {
  it('派发被拒：pump 如实报 reason、任务留在 queued、零执行；容量恢复即派发', async () => {
    const h = harness({ backgroundLimit: 1 });
    submit(h, 't1');
    submit(h, 't2');
    h.runner.pump(); // t1 占用唯一后台许可；t2 尝试派发被拒

    h.policy.forcedRejection = 'queue_full';
    const saturated: PumpSummary = h.runner.pump();
    expect(saturated.rejection).toBe('queue_full');
    expect(saturated.started).toEqual([]);
    expect(h.registry.statusOf('t2')).toBe('queued');
    expect(h.executor.calls).toHaveLength(1);
    expect(saturated).not.toBeInstanceOf(Promise);

    h.policy.forcedRejection = undefined;
    h.executor.settle(0, { kind: 'ended' }); // 无汇报 = 回合失败事实
    await until(() => h.executor.calls.length === 2, '容量恢复后 t2 被派发');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    h.executor.settle(1, { kind: 'ended' }); // 无汇报 = 回合失败事实
    await h.runner.whenIdle();
    expect(h.registry.statusOf('t2')).toBe('failed');
  });

  it('后台满载时前台许可即时可用、受理即时返回（独立配额，不被阻塞）', () => {
    const h = harness({ backgroundLimit: 1 });
    submit(h, 't1');
    submit(h, 't2');
    h.runner.pump();
    expect(h.executor.calls).toHaveLength(1); // 后台已满载

    const foreground = h.policy.acquire('foreground');
    expect(isRejection(foreground)).toBe(false);
    if (!isRejection(foreground)) h.policy.release(foreground);
    expect(h.policy.foregroundInUse).toBe(0);

    const accepted = submit(h, 't3'); // 满载期间受理仍即时成功
    expect(accepted.runningSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 重启恢复三态
// ---------------------------------------------------------------------------

describe('重启恢复（queued 重领 / running 过期租约 unknown 不重放 / completed 不重跑）', () => {
  it('新进程第一次 pump：queued 重新认领执行；过期租约→result_unknown 且零重放；completed 不动', async () => {
    const h = harness();
    // 模拟上一进程留下的持久底账。
    h.registry.seed({ taskId: 'tq', status: 'queued', request: '排队未跑' });
    h.registry.seed({
      taskId: 'tr',
      status: 'running',
      request: '运行中中断',
      leaseOwner: 'dead-process',
      leaseUntil: '2026-11-13T23:59:00.000Z', // 已过期（时钟 00:00）
    });
    h.registry.seed({ taskId: 'tc', status: 'completed', request: '已完成' });

    const restarted = h.start(); // 新进程：新 runner/policy/executor，共享持久底账
    const summary = restarted.runner.pump();
    expect(summary.recovered).toEqual(['tr']);
    expect(h.registry.statusOf('tr')).toBe('failed');
    expect(h.registry.reasonOf('tr')).toBe('result_unknown');

    // queued 重领：旧行被认领并执行；completed 行不重跑；tr 不重放。
    expect(restarted.executor.calls.map((call) => call.input.taskId)).toEqual(['tq']);
    restarted.executor.noteExecution(0, 'completed');
    restarted.executor.settle(0, { kind: 'ended', report: '补跑完成' });
    await restarted.runner.whenIdle();

    expect(h.registry.statusOf('tq')).toBe('completed');
    expect(h.registry.statusOf('tc')).toBe('completed');
    expect(h.registry.executionsOf('tr')).toHaveLength(0);
    expect(restarted.executor.calls.map((call) => call.input.taskId)).not.toContain('tr');
    expect(restarted.executor.calls.map((call) => call.input.taskId)).not.toContain('tc');
  });

  it('无租约的 running 不在回收范围（inline 任务保护），也不被 runner 认领', () => {
    const h = harness();
    h.registry.seed({ taskId: 't-inline', status: 'running', request: 'inline 运行中' });

    const restarted = h.start();
    const summary = restarted.runner.pump();
    expect(summary.recovered).toEqual([]);
    expect(h.registry.statusOf('t-inline')).toBe('running');
    expect(restarted.executor.calls).toHaveLength(0);
  });

  it('租约未过期的 running 不回捞、不重领（长回合保护）', () => {
    const h = harness();
    h.registry.seed({
      taskId: 't-alive',
      status: 'running',
      request: '租约仍有效',
      leaseOwner: 'other-runner',
      leaseUntil: '2026-11-14T00:05:00.000Z',
    });

    const restarted = h.start();
    const summary = restarted.runner.pump();
    expect(summary.recovered).toEqual([]);
    expect(h.registry.statusOf('t-alive')).toBe('running');
    expect(restarted.executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 取消语义
// ---------------------------------------------------------------------------

describe('取消（请求 ≠ 取消；确认才 cancelled；未确认回 running）', () => {
  it('queued 取消：请求→确认机械完成、policy 出队、不会再被执行', async () => {
    const h = harness({ backgroundLimit: 1 });
    submit(h, 't1');
    submit(h, 't2');
    h.runner.pump(); // t1 running，t2 留在 queued

    const outcome: CancelOutcome = h.runner.cancel('t2');
    expect(outcome).toEqual({ outcome: 'cancelled', taskId: 't2' });
    expect(h.registry.statusOf('t2')).toBe('cancelled');
    expect(h.policy.cancelledQueued).toEqual(['t2']);
    // 请求 ≠ 取消 的留痕在事实里（queued→cancelling→cancelled）。
    expect(h.registry.factsOf('t2').map((fact) => [fact.from, fact.to])).toEqual([
      [undefined, 'queued'],
      ["queued", "cancelled"],
    ]);

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '完成' });
    await h.runner.whenIdle();
    expect(h.executor.calls.map((call) => call.input.taskId)).toEqual(['t1']);
  });

  it('running 取消：先落 cancelling 并 abort；执行端确认后才 cancelled（reason=cancelled_by_user）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    const call = h.executor.calls[0]!;
    call.context.signal.addEventListener('abort', () => {
      h.executor.settle(0, { kind: 'cancelled' });
    });

    const outcome = h.runner.cancel('t1');
    expect(outcome).toEqual({ outcome: 'requested', taskId: 't1' });
    expect(h.registry.statusOf("t1")).toBe("running"); // 请求已发出但未确认：仍是 running
    expect(call.context.signal.aborted).toBe(true);

    await h.runner.whenIdle();
    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.registry.reasonOf('t1')).toBe('cancelled_by_user');
    expect(h.policy.backgroundInUse).toBe(0);
  });

  it('running 取消：请求落持久列 cancel_requested_at（请求 ≠ 确认；确认后才 cancelled）', async () => {
    // Grok 复审 2026-11-22：取消请求此前只进进程内 Set，无持久列——断电重启后底账看不出
    // 「你要我停、没停完」。请求必须落 cancel_requested_at（一次性、不改终局、不清租约）。
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    const call = h.executor.calls[0]!;
    call.context.signal.addEventListener('abort', () => {
      h.executor.settle(0, { kind: 'cancelled' });
    });

    const outcome = h.runner.cancel('t1');
    expect(outcome).toEqual({ outcome: 'requested', taskId: 't1' });
    // 请求已持久化（重启对账可读）——但未确认：仍是 running，不是 cancelled。
    expect(h.registry.cancelRequestedAtOf('t1')).toBeDefined();
    expect(h.registry.statusOf('t1')).toBe('running');

    await h.runner.whenIdle();
    expect(h.registry.statusOf('t1')).toBe('cancelled');
  });

  it('queued 取消：机械确认直接 cancelled，不写取消请求列（未启动没有「没停完」）', () => {
    const h = harness();
    submit(h, 't1'); // 未启动（queued）
    h.runner.cancel('t1');
    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.registry.cancelRequestedAtOf('t1')).toBeUndefined();
  });

  it('running 取消未获确认（回合照常完成）→ 回 running 并如实落终态，不宣称取消', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.runner.cancel('t1'); // abort 已发，但执行端未观察
    expect(h.registry.statusOf("t1")).toBe("running");

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '做完了' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.reasonOf('t1')).toBeUndefined();
  });

  it('running 取消未获确认且回合报错（非 abort）→ 回 running 后记失败（不落 cancelled）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.runner.cancel('t1');
    h.executor.failRound(0, new Error('执行端崩溃'));
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('failed');
  });

  it('running 取消后执行端以 AbortError 结束 → 视为 abort 观察，确认 cancelled', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.runner.cancel('t1');
    h.executor.failRound(0, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.registry.reasonOf('t1')).toBe('cancelled_by_user');
  });

  it('终态任务取消为无操作（terminal）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '完成' });
    await h.runner.whenIdle();

    expect(h.runner.cancel("t1")).toEqual({ outcome: "terminal", taskId: "t1" });
    expect(h.registry.statusOf('t1')).toBe('completed');
  });

  it('waiting_user 取消：无在飞回合可中止，请求后机械确认 cancelled', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'needs_input', question: { missing: ['合同编号'] } });
    await h.runner.whenIdle();
    expect(h.registry.statusOf('t1')).toBe('waiting_user');

    expect(h.runner.cancel('t1')).toEqual({ outcome: 'cancelled', taskId: 't1' });
    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.registry.reasonOf('t1')).toBe('cancelled_by_user');
  });
});

// ---------------------------------------------------------------------------
// 7. waiting_user：释放资源与同任务接续
// ---------------------------------------------------------------------------

describe('waiting_user：释放执行许可；答复续同一 Task', () => {
  it('任务进入 waiting_user 即释放许可，后续排队任务得以执行', async () => {
    const h = harness({ backgroundLimit: 1 });
    submit(h, 't1');
    submit(h, 't2');
    h.runner.pump();
    expect(h.executor.calls.map((call) => call.input.taskId)).toEqual(['t1']);

    h.executor.settle(0, { kind: 'needs_input', question: { missing: ['合同编号'], raw: '平台要求补充' } });
    await until(() => h.registry.statusOf('t1') === 'waiting_user', 't1 进入等待');
    // 等待即释放：t1 的许可已被归还（t2 随即可取得而占用，故看归还记录而非当前占用数）。
    expect(h.policy.released.length).toBeGreaterThanOrEqual(1);
    expect(h.registry.pendingQuestionOf('t1')).toEqual({ missing: ['合同编号'], raw: '平台要求补充' });
    expect(h.registry.waitingSinceOf('t1')).toBeDefined();

    await until(() => h.executor.calls.length === 2, 't2 取得释放的许可');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'ended', report: '二完成' });
    await h.runner.whenIdle();
    expect(h.registry.statusOf('t2')).toBe('completed');
    expect(h.registry.statusOf('t1')).toBe('waiting_user');
  });

  it('答复接续：answerResumes + 新回合；编号不变、执行追加、等待形状清除', async () => {
    const h = harness();
    submit(h, 't1', '跟进合同');
    h.runner.pump();
    h.executor.noteExecution(0, 'needs_input');
    h.executor.settle(0, { kind: 'needs_input', question: { missing: ['合同编号'] } });
    await h.runner.whenIdle();

    const taskNo = h.registry.taskNoOf('t1');
    const resumeOutcome = h.runner.resume('t1', { answer: '编号是 123' });
    expect(resumeOutcome).toEqual({ outcome: 'started', taskId: 't1' });
    expect(h.registry.statusOf('t1')).toBe('running');
    expect(h.registry.pendingQuestionOf('t1')).toBeUndefined();
    expect(h.registry.waitingSinceOf('t1')).toBeUndefined();
    expect(h.executor.calls).toHaveLength(2);
    expect(h.executor.calls[1]!.input.taskId).toBe('t1');
    expect(h.executor.calls[1]!.input.answer).toBe('编号是 123');
    expect(h.executor.calls[1]!.context.signal).not.toBe(h.executor.calls[0]!.context.signal);

    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'ended', report: '续跑完成' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.taskNoOf('t1')).toBe(taskNo); // 同一 Task：编号不变
    expect(h.registry.executionsOf('t1')).toHaveLength(2); // 执行追加
  });

  it('接续前许可被拒：不改变等待态（宁可晚跑，不伪造接续）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'needs_input', question: { missing: ['x'] } });
    await h.runner.whenIdle();

    h.policy.forcedRejection = 'quota_exceeded';
    const outcome = h.runner.resume('t1', { answer: '补上了' });
    expect(outcome).toEqual({ outcome: 'rejection', taskId: 't1', reason: 'quota_exceeded' });
    expect(h.registry.statusOf('t1')).toBe('waiting_user');
    expect(h.registry.pendingQuestionOf('t1')).toEqual({ missing: ['x'] });
    expect(h.executor.calls).toHaveLength(1);
  });

  it('非等待任务不可接续（not_waiting）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    expect(h.runner.resume("t1", { answer: "x" })).toEqual({ outcome: "not_waiting", taskId: "t1" });
    expect(h.executor.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. 安全绊线：收尾不覆盖外部终态；不重复认领
// ---------------------------------------------------------------------------

describe('安全绊线', () => {
  it('回合收尾不得覆盖外部终态（如外部执行超时）：终态保留、许可释放、错误可见', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.registry.timeout('t1', 'execution'); // 外部（超时边界）先行落终态
    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'ended', report: '迟到的汇报' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('timed_out');
    expect(h.registry.reasonOf('t1')).toBe('timeout');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.taskId).toBe('t1');
    expect(h.policy.backgroundInUse).toBe(0);
  });

  it('pump 幂等：已认领任务不重复执行；无排队任务时归还许可', () => {
    const h = harness({ backgroundLimit: 2 });
    submit(h, 't1');
    const first = h.runner.pump();
    expect(first.started).toEqual(['t1']);
    const second = h.runner.pump();
    expect(second.started).toEqual([]);
    expect(h.executor.calls).toHaveLength(1);
    expect(h.policy.backgroundInUse).toBe(1); // t1 占用中，未泄漏
    expect(h.policy.released).toHaveLength(2); // 两轮 pump 各一次「见无任务→归还」
  });

  it('执行端同步抛错（防御分支）：回合落 failed、原因原文可见、许可不泄漏', async () => {
    const h = harness();
    submit(h, 't1');
    // 真实执行端应为 async；此分支保证坏实现（同步抛错）不把任务卡死在 running、不吞许可。
    const throwing: TaskExecutor = {
      execute: () => {
        throw new Error('同步崩溃');
      },
    };
    const runner = createTaskRunner({
      registry: h.registry,
      policy: h.policy,
      executor: throwing,
      owner: 'test-runner',
      leaseMs: 10_000,
      now: () => h.clock.now,
    });
    runner.pump();
    await runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('failed');
    expect(h.policy.backgroundInUse).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P0-C 后台预算与生命周期
// ---------------------------------------------------------------------------

describe('P0-C 后台预算与生命周期', () => {
  it('① 后台回合计入任务预算：完成回合 consume {calls:1, ms}；未准入任务跳过计量不报错', async () => {
    const h = harness();
    submit(h, 't1');
    h.policy.budgetTaskIds.add('t1');
    h.runner.pump();
    expect(h.registry.statusOf('t1')).toBe('running');
    h.executor.settle(0, { kind: 'ended', report: '（测试结果）' });
    await h.runner.whenIdle();
    expect(h.policy.metered.filter((entry) => entry.taskId === 't1')).toEqual([
      { taskId: 't1', usage: { calls: 1, ms: 0 } },
    ]);

    // 未准入（受理侧 seed 被拒/假件无预算）的任务：回合照常落终态、不计量、不抛错。
    submit(h, 't2');
    h.runner.pump();
    h.executor.settle(1, { kind: 'ended', report: '（测试结果2）' });
    await h.runner.whenIdle();
    expect(h.registry.statusOf('t2')).toBe('completed');
    expect(h.policy.metered.some((entry) => entry.taskId === 't2')).toBe(false);
  });

  it('② 取消后不再消费：running 取消落定后恰好计一次实际时长、许可归还，后续 pump 不再计量', async () => {
    const h = harness();
    submit(h, 't1');
    h.policy.budgetTaskIds.add('t1');
    h.runner.pump();
    expect(h.runner.cancel('t1').outcome).toBe('requested');
    expect(h.executor.calls[0]!.context.signal.aborted).toBe(true);
    h.executor.settle(0, { kind: 'cancelled' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.policy.backgroundInUse).toBe(0);
    expect(h.policy.metered.filter((entry) => entry.taskId === 't1')).toHaveLength(1);
    h.runner.pump();
    expect(h.policy.metered.filter((entry) => entry.taskId === 't1')).toHaveLength(1);
  });

  it('④ 幂等：同 taskId 重复受理被确定性拒绝，底账不覆盖、编号不重复消耗', () => {
    const h = harness();
    const first = submit(h, 't1', '第一个任务');
    expect(() => submit(h, 't1', '重复任务')).toThrow('重复受理');
    expect(h.registry.statusOf('t1')).toBe('queued');
    expect(h.registry.requestOf('t1')).toBe('第一个任务');
    expect(h.registry.taskNoOf('t1')).toBe(first.taskNo);
    // 另一 taskId 不受影响。
    submit(h, 't2', '第二个任务');
    expect(h.registry.statusOf('t2')).toBe('queued');
  });
});
