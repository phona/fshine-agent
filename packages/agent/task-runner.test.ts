/**
 * TaskRunner 语义测试（P6，先红后绿；来源 docs/product/r4-joint-interfaces.md §1/§2/§3 v1 冻结）。
 *
 * 全部用假端口：
 *   · FakeRegistry —— 镜像 P2 契约核心的**消费面语义**（状态集/合法边/租约/认领/过期/取消/等待），
 *     complete() 复用仓内 judgeReportedTask（执行事实判定），确保断言不依赖 runner 自造口径；
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
import { deriveTaskName, judgeReportedTask, type ExecutionRecord } from './src/task-registry';
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
  type TaskStatus,
  type TimeoutKind,
} from './src/task-runner';

// ---------------------------------------------------------------------------
// 假底账：镜像 P2 §1 的消费面（合法边矩阵/租约/认领/过期/取消/等待/执行事实判定）。
// ---------------------------------------------------------------------------

const LEGAL_EDGES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelling', 'timed_out'],
  running: ['completed', 'failed', 'waiting_user', 'cancelling', 'timed_out', 'unexecuted'],
  waiting_user: ['running', 'cancelling', 'timed_out'],
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
  reason?: string;
  resultText?: string;
  failureReason?: string;
  pendingQuestion?: PendingQuestion;
  waitingSince?: string;
  leaseOwner?: string;
  leaseUntil?: string;
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
  reason?: string;
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

  reasonOf(taskId: string): string | undefined {
    return this.require(taskId).reason;
  }

  failureReasonOf(taskId: string): string | undefined {
    return this.require(taskId).failureReason;
  }

  resultTextOf(taskId: string): string | undefined {
    return this.require(taskId).resultText;
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
    status?: 'queued' | 'running';
  }): TaskRecordView {
    if (this.tasks.has(input.taskId)) throw new Error(`重复任务：${input.taskId}`);
    this.nextNo += 1;
    const now = this.clock().toISOString();
    const task: FakeTask = {
      taskId: input.taskId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      request: input.request,
      status: input.status ?? 'running',
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

  transition(taskId: string, to: TaskStatus, options?: { reason?: string; scope?: TaskScope }): TaskRecordView {
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

  complete(taskId: string, resultText: string): void {
    const task = this.require(taskId);
    // 与 P2 同口径：终态由已记录执行事实判定（零执行 = unexecuted，不冒充成功）。
    const judgement = judgeReportedTask(task.executions);
    this.commit(task, judgement.status);
    task.resultText = resultText;
    task.failureReason = judgement.failureReason;
    task.updatedAt = this.clock().toISOString();
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

  // --- 内部 ---

  private require(taskId: string, scope?: TaskScope): FakeTask {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`任务不存在：${taskId}`);
    if (scope !== undefined && (task.principalId !== scope.principalId || task.sessionId !== scope.sessionId)) {
      throw new Error(`越权访问：${taskId}`);
    }
    return task;
  }

  private commit(task: FakeTask, to: TaskStatus, options: { reason?: string } = {}): void {
    const from = task.status;
    if (!LEGAL_EDGES[from].includes(to)) throw new Error(`非法任务状态转换：${from} → ${to}`);
    task.status = to;
    if (to === 'cancelled') task.reason = options.reason ?? 'cancelled_by_user';
    else if (to === 'timed_out') task.reason = options.reason ?? 'timeout';
    else if (to === 'failed') task.reason = options.reason ?? 'failed_confirmed';
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
    expect(record.status).toBe('queued');
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
    h.executor.settle(0, { kind: 'completed', resultText: '第一个完成' });
    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'completed', resultText: '第二个完成' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.resultTextOf('t1')).toBe('第一个完成');
    expect(h.registry.statusOf('t2')).toBe('completed');
    expect(h.policy.backgroundInUse).toBe(0);
    expect(h.runner.inFlight()).toEqual([]);
  });

  it('回合「正常收尾」不得掩盖执行层失败事实（终态由底账按执行事实判定）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    // 执行层失败事实已记录，Worker 回合仍以 completed 收尾：任务必须落 failed。
    h.executor.noteExecution(0, 'failed', '执行层调用超时。');
    h.executor.settle(0, { kind: 'completed', resultText: 'Worker 汇报' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('failed');
    expect(h.registry.failureReasonOf('t1')).toContain('执行层调用超时');
  });

  it('零执行回合收尾为 unexecuted（已汇报零执行，不冒充成功）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();
    h.executor.settle(0, { kind: 'completed', resultText: '汇报' });
    await h.runner.whenIdle();
    expect(h.registry.statusOf('t1')).toBe('unexecuted');
    expect(h.registry.resultTextOf('t1')).toBe('汇报');
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
    h.executor.settle(0, { kind: 'completed', resultText: '一' });
    await until(() => h.executor.calls.length === 2, 't2 在 t1 释放许可后上位');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    expect(h.executor.maxConcurrent).toBe(1);

    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'completed', resultText: '二' });
    await until(() => h.executor.calls.length === 3, 't3 在 t2 释放许可后上位');
    expect(h.executor.calls[2]!.input.taskId).toBe('t3');
    expect(h.executor.maxConcurrent).toBe(1);

    h.executor.noteExecution(2, 'completed');
    h.executor.settle(2, { kind: 'completed', resultText: '三' });
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
    h.executor.settle(0, { kind: 'failed', reason: '执行失败' });
    await until(() => h.executor.calls.length === 2, '容量恢复后 t2 被派发');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    h.executor.settle(1, { kind: 'failed', reason: '执行失败' });
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
    expect(accepted.status).toBe('queued');
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
    restarted.executor.settle(0, { kind: 'completed', resultText: '补跑完成' });
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
      ['queued', 'cancelling'],
      ['cancelling', 'cancelled'],
    ]);

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'completed', resultText: '完成' });
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
    expect(h.registry.statusOf('t1')).toBe('cancelling'); // 请求不等于已取消
    expect(call.context.signal.aborted).toBe(true);

    await h.runner.whenIdle();
    expect(h.registry.statusOf('t1')).toBe('cancelled');
    expect(h.registry.reasonOf('t1')).toBe('cancelled_by_user');
    expect(h.policy.backgroundInUse).toBe(0);
  });

  it('running 取消未获确认（回合照常完成）→ 回 running 并如实落终态，不宣称取消', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.runner.cancel('t1'); // abort 已发，但执行端未观察
    expect(h.registry.statusOf('t1')).toBe('cancelling');

    h.executor.noteExecution(0, 'completed');
    h.executor.settle(0, { kind: 'completed', resultText: '做完了' });
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('completed');
    expect(h.registry.reasonOf('t1')).toBeUndefined();
    expect(h.registry.factsOf('t1').map((fact) => [fact.from, fact.to])).toContainEqual(['cancelling', 'running']);
  });

  it('running 取消未获确认且回合报错（非 abort）→ 回 running 后记失败（不落 cancelled）', async () => {
    const h = harness();
    submit(h, 't1');
    h.runner.pump();

    h.runner.cancel('t1');
    h.executor.failRound(0, new Error('执行端崩溃'));
    await h.runner.whenIdle();

    expect(h.registry.statusOf('t1')).toBe('failed');
    expect(h.registry.failureReasonOf('t1')).toContain('执行端崩溃');
    expect(h.registry.factsOf('t1').map((fact) => [fact.from, fact.to])).toContainEqual(['cancelling', 'running']);
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
    h.executor.settle(0, { kind: 'completed', resultText: '完成' });
    await h.runner.whenIdle();

    expect(h.runner.cancel('t1')).toEqual({ outcome: 'terminal', taskId: 't1', status: 'completed' });
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
    expect(h.policy.backgroundInUse).toBe(0);
    expect(h.registry.pendingQuestionOf('t1')).toEqual({ missing: ['合同编号'], raw: '平台要求补充' });
    expect(h.registry.waitingSinceOf('t1')).toBeDefined();

    await until(() => h.executor.calls.length === 2, 't2 取得释放的许可');
    expect(h.executor.calls[1]!.input.taskId).toBe('t2');
    h.executor.noteExecution(1, 'completed');
    h.executor.settle(1, { kind: 'completed', resultText: '二完成' });
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
    h.executor.settle(1, { kind: 'completed', resultText: '续跑完成' });
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
    expect(h.runner.resume('t1', { answer: 'x' })).toEqual({ outcome: 'not_waiting', taskId: 't1', status: 'running' });
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
    h.executor.settle(0, { kind: 'completed', resultText: '迟到的汇报' });
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
});
