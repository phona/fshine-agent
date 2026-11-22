/**
 * R5 前置批 P0-C 针对性审计（确定性回归；零真实模型）。
 *
 * 审计对象与检查点（owner 指令 5 项）：
 *   ① 取消请求已发出但 Worker 未退出 → 并发许可不得提前释放；
 *   ② Worker 取消后实际模型调用与资源消耗仍被计入（meterRound）；
 *   ③ finally 路径覆盖异常/取消/超时，不漏计；
 *   ④ budgetFor 可选端口缺省不传时，正式后台执行不得绕过预算策略；
 *   ⑤ 取消/重复提交/幂等重放不产生重复执行或重复计量。
 *
 * 用真实 ResourcePolicy（生产面唯一 policy 实现，ask-runtime.createBackgroundDispatch
 * 直接注入）+ 假底账 + 手动控制执行回合；全部确定性，无 IO、无真实模型。
 */
import { describe, expect, it } from 'vitest';
import { createResourcePolicy } from './src/resource-policy';
import {
  createTaskRunner,
  type PendingQuestion,
  type TaskExecutionInput,
  type TaskExecutionContext,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRecordView,
  type TaskRegistryPort,
} from './src/task-runner';

/** 假底账内部状态词（S1：真实底账无 status；本测试替身仅供本文件断言）。 */
type TaskStatus =
  | 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'cancelled'
  | 'completed' | 'failed' | 'timed_out' | 'unexecuted';

// ---------------------------------------------------------------------------
// 最小假底账：只实现 runner 消费面（状态存取 + 认领/过期），不做完整合法边矩阵
//（合法边语义由 task-runner.test.ts 钉住；本文件只审计许可/计量/幂等）。
// ---------------------------------------------------------------------------

class AuditRegistry implements TaskRegistryPort {
  private readonly tasks = new Map<string, TaskRecordView & { status: TaskStatus; leaseOwner?: string; leaseUntil?: string }>();
  private seq = 0;

  begin(input: { taskId: string; principalId: string; sessionId: string; request: string; queued?: boolean }): TaskRecordView {
    const now = new Date().toISOString();
    const task = {
      taskId: input.taskId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      request: input.request,
      status: input.queued === true ? 'queued' : 'running',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(input.taskId, task as TaskRecordView & { status: TaskStatus; leaseOwner?: string; leaseUntil?: string });
    return this.snapshot(input.taskId);
  }

  statusOf(taskId: string): TaskStatus {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`不存在：${taskId}`);
    return task.status;
  }

  get(taskId: string): TaskRecordView {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`不存在：${taskId}`);
    return this.snapshot(taskId);
  }

  transition(taskId: string, to: TaskStatus): TaskRecordView {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`不存在：${taskId}`);
    if (['cancelled', 'completed', 'failed', 'timed_out', 'unexecuted'].includes(task.status)) {
      throw new Error(`任务 ${taskId} 已终态（${task.status}），拒绝 ${to}`);
    }
    task.status = to;
    return this.snapshot(taskId);
  }

  waitForUser(taskId: string, _q: PendingQuestion): TaskRecordView { return this.transition(taskId, 'waiting_user'); }
  answerResumes(taskId: string): TaskRecordView { return this.transition(taskId, 'running'); }
  requestCancel(taskId: string): TaskRecordView { return this.transition(taskId, 'cancelling'); }
  confirmCancelled(taskId: string): TaskRecordView { return this.transition(taskId, 'cancelled'); }
  timeout(taskId: string): TaskRecordView { return this.transition(taskId, 'timed_out'); }
  markResultUnknown(taskId: string): TaskRecordView { return this.transition(taskId, 'unexecuted'); }
  fail(taskId: string): void { this.transition(taskId, 'failed'); }

  // --- TaskRegistryPort（S1 事实写入面；测试替身仍以状态词建模供本文件断言） ---
  markCancelled(taskId: string): TaskRecordView { return this.transition(taskId, 'cancelled'); }
  markTimedOut(taskId: string, _kind?: unknown): TaskRecordView { return this.transition(taskId, 'timed_out'); }
  markDied(taskId: string): TaskRecordView { return this.transition(taskId, 'failed'); }
  noteRoundFailed(taskId: string): void { this.transition(taskId, 'failed'); }
  archiveReply(taskIds: readonly string[], replyText: string): void {
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task === undefined) continue;
      if (!['cancelled', 'completed', 'failed', 'timed_out', 'unexecuted'].includes(task.status)) task.status = 'completed';
      (task as { resultText?: string }).resultText = replyText;
    }
  }

  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecordView | undefined {
    const next = [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next === undefined) return undefined;
    next.status = 'running';
    next.leaseOwner = input.owner;
    next.leaseUntil = new Date(Date.now() + input.leaseMs).toISOString();
    return this.snapshot(next.taskId);
  }

  expireLeases(): readonly TaskRecordView[] { return []; }

  private snapshot(taskId: string): TaskRecordView {
    const t = this.tasks.get(taskId);
    if (t === undefined) throw new Error(`不存在：${taskId}`);
    const { ...rest } = t;
    return rest as TaskRecordView;
  }
}

// ---------------------------------------------------------------------------
// 手动控制执行回合：挂起直到外部给结局或 abort。
// ---------------------------------------------------------------------------

interface Running {
  taskId: string;
  signal: AbortSignal;
  finish: (outcome: TaskExecutionOutcome) => void;
  reject: (error: unknown) => void;
}

class ManualExecutor implements TaskExecutor {
  readonly invocations: TaskExecutionInput[] = [];
  private readonly running = new Map<string, Running>();

  execute(task: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.invocations.push(task);
    return new Promise<TaskExecutionOutcome>((resolve, reject) => {
      this.running.set(task.taskId, {
        taskId: task.taskId,
        signal: context.signal,
        finish: (outcome) => { this.running.delete(task.taskId); resolve(outcome); },
        reject: (error) => { this.running.delete(task.taskId); reject(error); },
      });
    });
  }

  at(taskId: string): Running { return this.running.get(taskId)!; }
}

function setup(config?: Parameters<typeof createResourcePolicy>[0]) {
  const registry = new AuditRegistry();
  const policy = createResourcePolicy(config, { now: () => fakeNow });
  const executor = new ManualExecutor();
  let fakeNow = 1_000_000;
  const clock = (): Date => { fakeNow += 1; return new Date(fakeNow); };
  const runner = createTaskRunner({ registry, policy, executor, now: clock });
  // 镜像生产受理路径（execution-runtime delegate + P0-C 修复）：submit 前以真实 taskId
  // 探测准入并释放——policy 在此刻建立任务共享预算（§2 budgets 建账入口）。
  const submit = (input: { taskId: string; principalId: string; sessionId: string; request: string }) => {
    const probe = policy.acquire('background', { taskId: input.taskId });
    if (probe.ok === false) throw new Error(`探测被拒：${probe.reason}`);
    policy.release(probe);
    return runner.submit(input);
  };
  return { registry, policy, executor, runner, submit, tick: () => { fakeNow += 100; } };
}

describe('P0-C① 取消已请求但 Worker 未退出 → 许可不提前释放', () => {
  it('running 取消请求后，后台并发许可仍被占用（第二任务不得启动），回合落定才释放', async () => {
    const { registry, policy, executor, runner, submit } = setup({ backgroundConcurrency: 1, queueCapacity: 0 });
    submit({ taskId: 't1', principalId: 'p', sessionId: 's', request: '一' });
    submit({ taskId: 't2', principalId: 'p', sessionId: 's', request: '二' });
    runner.pump();
    expect(executor.invocations.map((i) => i.taskId)).toEqual(['t1']);

    const outcome = runner.cancel('t1');
    expect(outcome).toEqual({ outcome: 'requested', taskId: 't1' });
    // 关键断言：Worker 未退出（executor 挂起中），许可不得提前释放。
    expect(policy.snapshot().background.active).toBe(1); // 许可 taskId 为匿名（见 p0c.md 登记缺口）
    // t2 仍 queued，未被直派发。
    expect(registry.statusOf('t2')).toBe('queued');
    expect(executor.invocations).toHaveLength(1);

    executor.at('t1').finish({ kind: 'cancelled' });
    // 等 schedulePump 的再派发微任务启动 t2，再手动收尾（否则 whenIdle 永等 t2）。
    for (let i = 0; i < 20 && executor.invocations.every((inv) => inv.taskId !== 't2'); i += 1) {
      await Promise.resolve();
    }
    executor.at('t2').finish({ kind: 'ended', report: 'ok' });
    await runner.whenIdle();
    expect(policy.snapshot().background.active).toBe(0);
    expect(registry.statusOf('t1')).toBe('cancelled');
    expect(registry.statusOf('t2')).toBe('completed');
    // 释放后 t2 经 schedulePump 接续启动（恰好一次，无重复执行）。
    expect(executor.invocations.map((i) => i.taskId)).toEqual(['t1', 't2']);
  });
});

describe('P0-C② Worker 取消后实际调用与消耗仍被计入', () => {
  it('取消回合 consume(calls=1, ms>0)，后续准入按耗尽预算拒绝', async () => {
    const { registry, policy, executor, runner, submit } = setup({
      backgroundConcurrency: 1,
      taskBudget: { ms: 10_000, calls: 1 },
    });
    submit({ taskId: 't1', principalId: 'p', sessionId: 's', request: '一' });
    runner.pump();
    expect(executor.invocations).toHaveLength(1);
    runner.cancel('t1');
    executor.at('t1').finish({ kind: 'cancelled' });
    await runner.whenIdle();
    const used = policy.budgetFor('t1').used;
    expect(used.calls).toBe(1); // 取消回合照计
    expect(used.ms).toBeGreaterThan(0);
    // 预算 calls=1 已耗尽：同任务再次准入必须被拒（不因取消而豁免）。
    const again = policy.acquire('background', { taskId: 't1' });
    expect(again).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    expect(registry.statusOf('t1')).toBe('cancelled');
  });
});

describe('P0-C③ finally 覆盖异常/取消/超时，不漏计', () => {
  it('三种结局各计一次且许可释放', async () => {
    const { policy, executor, runner, registry, submit, tick } = setup({
      backgroundConcurrency: 1,
      taskBudget: { ms: 1_000_000, calls: 10 },
    });
    // 异常（非 abort）
    submit({ taskId: 'e', principalId: 'p', sessionId: 's', request: '异常' });
    runner.pump();
    executor.at('e').reject(new Error('boom'));
    await runner.whenIdle();
    expect(policy.budgetFor('e').used.calls).toBe(1);
    expect(registry.statusOf('e')).toBe('failed');
    expect(policy.snapshot().background.active).toBe(0);
    // 取消（abort 异常路径）
    tick();
    submit({ taskId: 'c', principalId: 'p', sessionId: 's', request: '取消' });
    runner.pump();
    runner.cancel('c');
    const abortError = new Error('aborted') as Error & { name: string };
    abortError.name = 'AbortError';
    executor.at('c').reject(abortError);
    await runner.whenIdle();
    expect(policy.budgetFor('c').used.calls).toBe(1);
    expect(registry.statusOf('c')).toBe('cancelled');
    // 超时
    tick();
    submit({ taskId: 'o', principalId: 'p', sessionId: 's', request: '超时' });
    runner.pump();
    executor.at('o').finish({ kind: 'timed_out' });
    await runner.whenIdle();
    expect(policy.budgetFor('o').used.calls).toBe(1);
    expect(registry.statusOf('o')).toBe('timed_out');
    expect(policy.snapshot().background.active).toBe(0);
    // 总量：三回合各一次，无漏计无重复。
    expect(policy.budgetFor('e').used.calls + policy.budgetFor('c').used.calls + policy.budgetFor('o').used.calls).toBe(3);
  });
});

describe('P0-C④ budgetFor 可选端口不得让正式后台执行绕过预算', () => {
  it('生产装配（真实 ResourcePolicy）下 budgetFor 必在，后台回合按预算强制', async () => {
    // 生产面唯一接线：ask-runtime.createBackgroundDispatch 直接注入 createResourcePolicy 实例
    //（接口 budgetFor 必选，resource-policy.ts:500），runner.meterRound 不会走缺省分支。
    const { policy, executor, runner, submit } = setup({
      backgroundConcurrency: 1,
      taskBudget: { ms: 1_000_000, calls: 1 },
    });
    submit({ taskId: 't1', principalId: 'p', sessionId: 's', request: '一' });
    runner.pump();
    executor.at('t1').finish({ kind: 'needs_input', question: { missing: ['x'] } });
    await runner.whenIdle();
    expect(policy.budgetFor('t1').used.calls).toBe(1);
    // 预算耗尽：接续回合被拒，不再执行、不再计量。
    const resumed = runner.resume('t1', { answer: 'x' });
    expect(resumed).toEqual({ outcome: 'rejection', taskId: 't1', reason: 'budget_exhausted' });
    expect(executor.invocations).toHaveLength(1);
    expect(policy.budgetFor('t1').used.calls).toBe(1);
  });

  it('policy 未配置 taskBudget（缺省）时：计量照做（calls 记账），不作为硬上限', async () => {
    const { policy, executor, runner, submit } = setup();
    submit({ taskId: 't1', principalId: 'p', sessionId: 's', request: '一' });
    runner.pump();
    executor.at('t1').finish({ kind: 'ended', report: 'ok' });
    await runner.whenIdle();
    expect(policy.budgetFor('t1').used.calls).toBe(1);
    expect(policy.budgetFor('t1').limits).toBeNull(); // 未配置=不强制，但用量照记
  });
});

describe('P0-C⑤ 取消/重复提交/幂等重放不重复执行不重复计量', () => {
  it('重复受理同 taskId 被确定性拒绝，不覆盖底账行、不再消耗编号', () => {
    const { runner, submit } = setup();
    const first = submit({ taskId: 'dup', principalId: 'p', sessionId: 's', request: '一' });
    expect(first.taskId).toBe('dup');
    expect(() => submit({ taskId: 'dup', principalId: 'p', sessionId: 's', request: '二' }))
      .toThrow(/重复受理/);
  });

  it('取消 queued 任务：不启动执行、不计量', async () => {
    const { policy, executor, runner, registry, submit } = setup({ taskBudget: { ms: 1_000_000, calls: 5 } });
    submit({ taskId: 'q', principalId: 'p', sessionId: 's', request: '一' });
    const outcome = runner.cancel('q');
    expect(outcome).toEqual({ outcome: 'cancelled', taskId: 'q' });
    runner.pump(); // 终态后不得被认领
    await runner.whenIdle();
    expect(executor.invocations).toHaveLength(0);
    expect(registry.statusOf('q')).toBe('cancelled');
    expect(policy.budgetFor('q').used.calls).toBe(0); // 仅在 acquire 时建账，未 consume
  });

  it('终态任务的取消是幂等 no-op（terminal），不触发 abort、不重复计量', async () => {
    const { policy, executor, runner, submit } = setup({ taskBudget: { ms: 1_000_000, calls: 5 } });
    submit({ taskId: 't', principalId: 'p', sessionId: 's', request: '一' });
    runner.pump();
    executor.at('t').finish({ kind: 'ended', report: 'ok' });
    await runner.whenIdle();
    expect(runner.cancel('t')).toEqual({ outcome: 'terminal', taskId: 't', status: 'completed' });
    expect(policy.budgetFor('t').used.calls).toBe(1); // 无第二次计量
  });
});
