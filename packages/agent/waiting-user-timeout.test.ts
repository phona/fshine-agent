/**
 * waiting_user 到期消费者（W 切片，2026-11-18；先红后绿）。
 *
 * 目标：任务进入 waiting_user 后超过 `waitUserTimeoutMs`，由 TaskRunner 的单一有界定时器轮
 * 自动落 `timed_out` + 既有 reason=timeout，并沿既有事实钩子写一条 timed_out 通知。
 *
 * 全部用真底账（SQLite 持久化）+ 假时钟/假定时器 + 假 sink：
 *   · 假时钟：不真 sleep 24 小时；`now` 注入 TaskRunner（等待到期的唯一判据）；
 *   · 假定时器：单一定时器轮由测试推进（到期才触发 pump）；
 *   · 假 sink：通知 outbox 的真实现 + 假发送器（零网络、零真实平台）。
 *
 * 覆盖：
 *   ① 到期 → timed_out + reason=timeout + 一条 timed_out 通知；
 *   ② 差 1ms → 仍 waiting_user（反向绊线：真实时钟会提前判超时）；
 *   ③ 到期前 task_resume → running，之后不再判超时；
 *   ④ 进程重启：库里等待行按 waiting_since + timeout 在启动后第一趟 pump 判超时；
 *   ⑤ 缺省装配（未注入 waitUserTimeoutMs）→ 不建定时器、行为与改动前一致。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from './testing/task-facts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNotificationOutbox,
  type DeliveryReceipt,
  type NotificationSink,
} from './src/notifications';
import { createResourcePolicy } from './src/resource-policy';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  createTaskRunner,
  type PendingQuestion,
  type TaskExecutionInput,
  type TaskExecutionContext,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRecordView,
  type TaskRunner,
} from './src/task-runner';
import { attachNotificationOutbox } from '../../scripts/ask-runtime';

const SCOPE = { principalId: 'p', sessionId: 's' } as const;
const QUESTION: PendingQuestion = { missing: ['工单号'] };

const dirs: string[] = [];
const registries: SqliteTaskRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'waiting-timeout-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

function openRegistry(dbPath = tempDbPath()): SqliteTaskRegistry {
  const registry = createSqliteTaskRegistry(dbPath);
  registries.push(registry);
  return registry;
}

/** 手动推进的假时钟（TaskRunner 的唯一时间来源）。 */
class FakeClock {
  ms: number;
  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
  }
  readonly now = (): Date => new Date(this.ms);
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** 单一定时器轮的假实现：advance 推进时钟并把到期回调按时间顺序执行。 */
class FakeTimers {
  private nextId = 1;
  private readonly entries = new Map<number, { at: number; callback: () => void }>();
  setCalls = 0;
  constructor(private readonly clock: FakeClock) {}
  readonly set = (callback: () => void, delayMs: number): unknown => {
    this.setCalls += 1;
    const id = this.nextId;
    this.nextId += 1;
    this.entries.set(id, { at: this.clock.ms + delayMs, callback });
    return id;
  };
  readonly clear = (handle: unknown): void => {
    this.entries.delete(handle as number);
  };
  get armed(): number {
    return this.entries.size;
  }
  advance(deltaMs: number): void {
    this.clock.advance(deltaMs);
    const due = [...this.entries.entries()]
      .filter(([, entry]) => entry.at <= this.clock.ms)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, entry] of due) {
      if (!this.entries.delete(id)) continue;
      entry.callback();
    }
  }
}

class NullSink implements NotificationSink {
  readonly sent: string[] = [];
  async send(notification: { kind: string }): Promise<DeliveryReceipt> {
    this.sent.push(notification.kind);
    return { delivered: true };
  }
}

/** 手动控制的后台执行回合（测试里显式给结局）。 */
class ManualExecutor implements TaskExecutor {
  readonly inputs: TaskExecutionInput[] = [];
  private readonly pending = new Map<string, (outcome: TaskExecutionOutcome) => void>();

  execute(task: TaskExecutionInput, _context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.inputs.push(task);
    return new Promise<TaskExecutionOutcome>((resolve) => {
      this.pending.set(task.taskId, resolve);
    });
  }

  finish(taskId: string, outcome: TaskExecutionOutcome): void {
    const resolve = this.pending.get(taskId);
    if (resolve === undefined) throw new Error(`任务 ${taskId} 没有在飞回合`);
    this.pending.delete(taskId);
    resolve(outcome);
  }
}

/**
 * 造一条 waiting_user 行，并把 waiting_since 改写成指定时刻（模拟持久底账里早已等待的行；
 * 只用于测试夹具，产品写入仍走 registry 方法族）。
 */
function seedWaiting(registry: SqliteTaskRegistry, taskId: string, waitingSince: string): TaskRecordView {
  registry.begin({ taskId, ...SCOPE, request: '补一下工单号' });
  registry.waitForUser(taskId, QUESTION);
  // 改写 waiting_since 到指定时刻（存储层单条等待事实写入；结束事实未写故可写）。
  registry.store.setWaiting(taskId, {
    pendingQuestion: QUESTION,
    waitingSince,
    updatedAt: waitingSince,
  });
  return registry.get(taskId, SCOPE);
}

function stack(options: {
  timeoutMs?: number;
  startIso: string;
  timers?: FakeTimers;
  clock?: FakeClock;
}): { dbPath: string; registry: SqliteTaskRegistry; runner: TaskRunner; clock: FakeClock; timers: FakeTimers; executor: ManualExecutor } {
  const dbPath = tempDbPath();
  const registry = openRegistry(dbPath);
  const clock = options.clock ?? new FakeClock(options.startIso);
  const timers = options.timers ?? new FakeTimers(clock);
  const executor = new ManualExecutor();
  const runner = createTaskRunner({
    registry,
    policy: createResourcePolicy(),
    executor,
    now: clock.now,
    timers,
    ...(options.timeoutMs === undefined ? {} : { waitUserTimeoutMs: options.timeoutMs }),
  });
  return { dbPath, registry, runner, clock, timers, executor };
}

function withOutbox(registry: SqliteTaskRegistry, dbPath: string): ReturnType<typeof createNotificationOutbox> {
  const outbox = createNotificationOutbox({ dbPath, sink: new NullSink() });
  attachNotificationOutbox(registry, outbox);
  return outbox;
}

describe('waiting_user 到期消费者', () => {
  it('① 到期 → timed_out + reason=timeout，且只有一条 timed_out 通知', () => {
    const start = '2026-11-01T00:00:00.000Z';
    const h = stack({ timeoutMs: 2_000, startIso: start });
    const outbox = withOutbox(h.registry, h.dbPath);
    seedWaiting(h.registry, 'w1', start);

    h.runner.pump(); // 单一有界定时器轮从这里武装
    expect(h.registry.get('w1', SCOPE).pendingQuestion).toBeDefined();
    expect(h.timers.armed).toBe(1);

    h.timers.advance(2_000);

    const task = h.registry.get('w1', SCOPE);
    expect(task.endedAt).toBeTruthy();
    expect(task.endedAt).toBeTruthy();
    // 既有 reason 枚举 + 既有通知意图（不新造状态/事件名）。
    const timedOut = outbox.listNotifications('w1').filter((notification) => notification.kind === 'timed_out');
    expect(timedOut).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(timedOut[0]!.payload)).reason).toBe('timeout');
  });

  it('② 差 1ms → 仍 waiting_user（真实时钟实现会提前判超时）', () => {
    // waiting_since 取一个很早的固定时刻：若实现偷用真实时钟（2026-11-18），必然已到期。
    const since = '2020-01-01T00:00:00.000Z';
    const clock = new FakeClock(since);
    const h = stack({ timeoutMs: 1_000, startIso: since, clock });
    seedWaiting(h.registry, 'w2', since);

    clock.advance(999); // 距离到期还差 1ms
    h.runner.pump();
    expect(h.registry.get('w2', SCOPE).pendingQuestion).toBeDefined();

    clock.advance(1); // 恰好到期（边界闭合：>= timeout）
    h.runner.pump();
    expect(h.registry.get('w2', SCOPE).endedAt).toBeTruthy();
  });

  it('③ 到期前 task_resume → running，之后不再被判超时', async () => {
    const start = '2026-11-02T00:00:00.000Z';
    const h = stack({ timeoutMs: 1_000, startIso: start });
    seedWaiting(h.registry, 'w3', start);
    h.runner.pump();

    h.timers.advance(999);
    expect(h.runner.resume('w3', { answer: 'WO-42', scope: SCOPE })).toEqual({ outcome: 'started', taskId: 'w3' });
    expect(taskMayBeRunningOf(h.registry.get('w3', SCOPE))).toBe(true);
    expect(h.executor.inputs.map((input) => input.answer)).toEqual(['WO-42']);

    h.timers.advance(10_000); // 越过原到期点：已接续的回合不得被判等待超时
    expect(taskMayBeRunningOf(h.registry.get('w3', SCOPE))).toBe(true);

    h.executor.finish('w3', { kind: 'ended', report: '补答后完成' });
    await h.runner.whenIdle();
    expect(executionsOf(h.registry.get('w3', SCOPE))).toEqual([]);
  });

  it('④ 进程重启：库里早已等待的行在启动后第一趟 pump 判 timed_out（按 waiting_since 判定）', () => {
    const dbPath = tempDbPath();
    const since = '2026-11-03T00:00:00.000Z';
    const first = openRegistry(dbPath);
    seedWaiting(first, 'w4', since);
    first.close();
    registries.splice(registries.indexOf(first), 1); // 已手动关闭

    const second = openRegistry(dbPath);
    const clock = new FakeClock('2026-11-03T00:00:01.000Z'); // since + 1s，timeout=1s
    const executor = new ManualExecutor();
    const runner = createTaskRunner({
      registry: second,
      policy: createResourcePolicy(),
      executor,
      now: clock.now,
      timers: new FakeTimers(clock),
      waitUserTimeoutMs: 1_000,
    });
    const outbox = withOutbox(second, dbPath);

    const summary = runner.pump(); // 启动后的第一个推进周期（不依赖上一进程的内存定时器）
    expect(summary.timedOutWaiting).toEqual(['w4']);
    expect(second.get('w4', SCOPE).endedAt).toBeTruthy();
    expect(second.get('w4', SCOPE).endedAt).toBeTruthy();
    expect(outbox.listNotifications('w4').filter((notification) => notification.kind === 'timed_out')).toHaveLength(1);
    expect(executor.inputs).toHaveLength(0); // 等待超时不是执行回合，不重放
  });

  it('⑤ 缺省装配（未配 waitUserTimeoutMs）→ 不建定时器，等待行保持原状', () => {
    const since = '2020-01-01T00:00:00.000Z';
    const timers = new FakeTimers(new FakeClock(since));
    const h = stack({ startIso: since, timers });
    seedWaiting(h.registry, 'w5', since);

    h.runner.pump();
    h.clock.advance(365 * 24 * 60 * 60 * 1_000);
    h.runner.pump();

    expect(timers.setCalls).toBe(0);
    expect(h.registry.get('w5', SCOPE).pendingQuestion).toBeDefined();
  });
});
