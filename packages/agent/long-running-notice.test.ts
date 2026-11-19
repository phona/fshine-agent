/**
 * 预期契约（2026-11-18 owner 定；2026-11-19 唤醒切片改形、只留一档）：
 * 后台任务长时间无动静的主动提醒（先红后绿）。
 *
 * 目标（机械、只看持久化底账 + 注入时钟）：
 *   · 任务 running 且从认领时刻起 10 分钟内 → **一条都不发**；
 *   · > 10 分钟仍无事件 → 交一条提醒（**只此一档**，每任务一次）：喂给模型的是**事实**
 *     （业务名 + 已跑多久，`longRunningNoticeFactText`）+ 模型挂掉时的兜底句
 *     （`LONG_RUNNING_NOTICE_FALLBACK_TEXT`）；用户看到的那句话由模型写（本文件只验事实）；
 *   · > 30 分钟不再有第二档（「卡住」档整档删除：断言我们不知道的事 + 替用户下结论）；
 *   · 只在 1:1 会话发（group 不发，也不落「已发」）；
 *   · 「已发」落库：重开 registry 再扫 → 零发送（重启不重发）；
 *   · 事实不报进度（不写 operation 名、不写次数、不写最近一步）。
 *
 * 全部用真底账（SQLite 持久化）+ 假时钟/假定时器 + 假提醒端口（零网络、零真实平台）：
 *   · 假时钟：不真 sleep 10 分钟；`now` 注入 TaskRunner（阈值判定的唯一时间来源）；
 *   · 假定时器：与 waiting_user 到期消费者共用的那**一个**有界定时器轮由测试推进；
 *   · 假端口：记录每次投递（taskId/name/minutes/factText/fallbackText），判据只看它。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createResourcePolicy } from './src/resource-policy';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  LONG_RUNNING_NOTICE_FALLBACK_TEXT,
  createTaskRunner,
  longRunningNoticeFactText,
  type LongRunningNoticePort,
  type TaskExecutionContext,
  type TaskExecutionInput,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRunner,
} from './src/task-runner';

const SCOPE = { principalId: 'p', sessionId: 'wecom:conv-private' } as const;
const GROUP_SCOPE = { principalId: 'p', sessionId: 'wecom:conv-group' } as const;
/** 提醒阈值（生产缺省 10 分钟由配置源给出）。 */
const NOTICE_MS = 600_000;
/** 认领租约：必须覆盖测试里的在飞时长（否则 pump 会先把任务判成 result_unknown）。 */
const LEASE_MS = 3_600_000;

const dirs: string[] = [];
const registries: SqliteTaskRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'long-running-notice-'));
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
}

/** 单一定时器轮的假实现：advance 推进时钟并把到期回调按时间顺序执行。 */
class FakeTimers {
  private nextId = 1;
  private readonly entries = new Map<number, { at: number; callback: () => void }>();
  constructor(private readonly clock: FakeClock) {}
  readonly set = (callback: () => void, delayMs: number): unknown => {
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

/** 永不在飞的假执行器（本文件只验提醒，不验执行）。 */
class IdleExecutor implements TaskExecutor {
  readonly inputs: TaskExecutionInput[] = [];
  execute(task: TaskExecutionInput, _context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.inputs.push(task);
    return new Promise<TaskExecutionOutcome>(() => {
      // 刻意不 resolve：任务保持 running（提醒判据只看底账行）。
    });
  }
}

interface NoticeSend {
  taskId: string;
  principalId: string;
  sessionId: string;
  name?: string;
  minutes: number;
  factText: string;
  fallbackText: string;
}

/**
 * 记录每次投递的假提醒端口；`direct` 模拟 chatType 事实源；`delivered` 模拟
 * 「用户可见的那句话已交出」（模型说了 / 兜底送达）；false = 模型说不出话且兜底也失败。
 */
function recordingNotice(
  direct: (sessionId: string) => boolean = () => true,
  delivered: boolean = true,
): {
  port: LongRunningNoticePort;
  sends: NoticeSend[];
} {
  const sends: NoticeSend[] = [];
  const port: LongRunningNoticePort = {
    isDirectSession: direct,
    async sendNotice(input): Promise<boolean> {
      sends.push({ ...input });
      return delivered;
    },
  };
  return { port, sends };
}

/**
 * 造一条 running 行（已认领）：只用于测试夹具——产品写入仍走 registry 方法族。
 * 租约起点 = startedAt（认领时刻），所以 lease_until = startedAt + LEASE_MS。
 */
function seedRunning(
  registry: SqliteTaskRegistry,
  taskId: string,
  startedAt: string,
  scope: { principalId: string; sessionId: string } = SCOPE,
): void {
  registry.begin({ taskId, ...scope, request: '查一下上季度报销明细' });
  registry.store.applyTaskState(taskId, {
    expectedStatus: 'running',
    status: 'running',
    leaseOwner: 'task-runner',
    leaseUntil: new Date(Date.parse(startedAt) + LEASE_MS).toISOString(),
    updatedAt: startedAt,
  });
}

interface Stack {
  dbPath: string;
  registry: SqliteTaskRegistry;
  runner: TaskRunner;
  clock: FakeClock;
  timers: FakeTimers;
  sends: NoticeSend[];
  events: Array<Record<string, unknown>>;
}

function stack(options: {
  startIso: string;
  registry?: SqliteTaskRegistry;
  clock?: FakeClock;
  timers?: FakeTimers;
  direct?: (sessionId: string) => boolean;
  delivered?: boolean;
}): Stack {
  const dbPath = tempDbPath();
  const registry = options.registry ?? openRegistry(dbPath);
  const clock = options.clock ?? new FakeClock(options.startIso);
  const timers = options.timers ?? new FakeTimers(clock);
  const { port, sends } = recordingNotice(options.direct, options.delivered ?? true);
  const events: Array<Record<string, unknown>> = [];
  const runner = createTaskRunner({
    registry,
    policy: createResourcePolicy(),
    executor: new IdleExecutor(),
    now: clock.now,
    timers,
    leaseMs: LEASE_MS,
    longRunningNoticeMs: NOTICE_MS,
    longRunningNotice: port,
    log: (line) => events.push(line),
  });
  return { dbPath, registry, runner, clock, timers, sends, events };
}

describe('预期契约：长时间无动静的主动提醒（只一档）', () => {
  it('① 10 分钟内零发送、>10min 交一次（事实 + 兜底句）、之后不再发；>30min 也没有第二档', async () => {
    const start = '2026-11-01T00:00:00.000Z';
    const h = stack({ startIso: start });
    seedRunning(h.registry, 'slow-1', start);

    h.runner.pump(); // 单一有界定时器轮从这里武装（到期点 = 起点 + 10 分钟）
    expect(h.timers.armed).toBe(1);
    expect(h.sends).toHaveLength(0);

    // 9 分钟时主动扫一趟：仍在窗口内 → 一条都不发。
    h.clock.advance(9 * 60_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(0);

    // 到 10 分钟：交一条提醒（事实喂模型 + 模型挂掉时的兜底句）。
    h.timers.advance(60_000);
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      taskId: 'slow-1',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      minutes: 10,
    });
    // 事实：业务名 + 已跑多久（模型据此说人话）；不得出现进度事实（operation 名/次数/最近一步）。
    expect(h.sends[0]!.factText).toContain('[久无动静]');
    expect(h.sends[0]!.factText).toContain('10 分钟');
    expect(h.sends[0]!.factText).not.toMatch(/operation|\.query|已执行|最近一步/);
    // 兜底句（只走「模型回合挂掉」路径）必须给出两个可做的动作，且不诱导重试。
    expect(h.sends[0]!.fallbackText).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
    expect(h.sends[0]!.fallbackText).toContain('停下来');
    expect(h.sends[0]!.fallbackText).toContain('继续等');
    // 「已发」已落库。
    expect(h.registry.get('slow-1', SCOPE).longRunningNotifiedAt).toBeDefined();

    // 紧接着再扫一趟：不再发（每任务一次）。
    h.clock.advance(1_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);

    // 跨过 30 分钟（第二档已整档删除）：仍只有那一条，不再有「卡住了/建议先停掉」。
    h.timers.advance(30 * 60_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(h.sends.some((send) => /卡住|先停掉/.test(send.factText) || /卡住|先停掉/.test(send.fallbackText))).toBe(false);

    // 一条事件（成功）。
    expect(h.events.map((event) => event['event'])).toEqual(['task_long_running_notice']);
    expect(h.events.map((event) => event['result'])).toEqual(['sent']);
  });

  it('①b 走岔路：端口交不出话（模型说不出话且兜底失败）→ 只记 failed，任务不被改判终态、不重试', async () => {
    const start = '2026-11-01T00:00:00.000Z';
    const h = stack({ startIso: start, delivered: false });
    seedRunning(h.registry, 'slow-1', start);

    h.runner.pump();
    h.timers.advance(11 * 60_000);
    await h.runner.whenIdle();

    // 端口被交到（事实与兜底句都在），但它如实回报「没交出去」。
    expect(h.sends).toHaveLength(1);
    expect(h.events).toEqual([expect.objectContaining({ event: 'task_long_running_notice', result: 'failed' })]);
    // 任务事实不动（仍 running、未被误判 result_unknown），「已发」已落库（不刷屏）。
    expect(h.registry.get('slow-1', SCOPE).status).toBe('running');
    expect(h.registry.get('slow-1', SCOPE).longRunningNotifiedAt).toBeDefined();
    // 不重试：再推进时间也不再交。
    h.timers.advance(10 * 60_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);
  });

  it('①c 事实文本：业务名缺省用中性指代，长名截断；分钟数逐字进事实', () => {
    expect(longRunningNoticeFactText({ minutes: 12 })).toContain('你交代的那件事');
    expect(longRunningNoticeFactText({ name: '  ', minutes: 12 })).toContain('你交代的那件事');
    expect(longRunningNoticeFactText({ name: '查上季度报销', minutes: 12 })).toContain('「查上季度报销」');
    const long = '一'.repeat(40);
    expect(longRunningNoticeFactText({ name: long, minutes: 12 })).not.toContain(long);
    expect(longRunningNoticeFactText({ name: long, minutes: 12 })).toContain('…');
  });

  it('② 重启不重发：「已发」落库，重开 registry 再扫零次发送', async () => {
    const start = '2026-11-02T00:00:00.000Z';
    const dbPath = tempDbPath();
    const first = openRegistry(dbPath);
    const clock = new FakeClock(start);
    const timers = new FakeTimers(clock);
    const before = stack({ startIso: start, registry: first, clock, timers });
    seedRunning(first, 'slow-restart', start);

    before.runner.pump();
    timers.advance(11 * 60_000);
    await before.runner.whenIdle();
    expect(before.sends).toHaveLength(1);
    expect(first.get('slow-restart', SCOPE).longRunningNotifiedAt).toBeDefined();

    first.close();
    registries.splice(registries.indexOf(first), 1); // 已手动关闭

    // 「重启」：同一个库重新打开，新 runner + 新时钟（时间已过 11 分钟）。
    const second = openRegistry(dbPath);
    const restartedAt = new Date(Date.parse(start) + 11 * 60_000).toISOString();
    const after = stack({ startIso: restartedAt, registry: second });
    after.runner.pump();
    await after.runner.whenIdle();
    expect(after.sends).toHaveLength(0);
    expect(second.get('slow-restart', SCOPE).longRunningNotifiedAt).toBeDefined();
  });

  it('③ 群聊不发：chatType 判据为群 → 零发送且不落「已发」；同批 1:1 会话照常发', async () => {
    const start = '2026-11-03T00:00:00.000Z';
    const h = stack({
      startIso: start,
      // 现成的 chatType 事实源形状：只有 single 才发（这里按会话 id 模拟群聊）。
      direct: (sessionId) => sessionId === SCOPE.sessionId,
    });
    seedRunning(h.registry, 'group-1', start, GROUP_SCOPE);
    seedRunning(h.registry, 'private-1', start, SCOPE);

    h.runner.pump();
    h.timers.advance(11 * 60_000);
    await h.runner.whenIdle();

    expect(h.sends.map((send) => send.taskId)).toEqual(['private-1']);
    expect(h.registry.get('group-1', GROUP_SCOPE).longRunningNotifiedAt).toBeUndefined();
  });

  it('④ 缺省装配（未注入提醒端口）→ 不扫也不发，零行为变化', async () => {
    const start = '2026-11-04T00:00:00.000Z';
    const registry = openRegistry();
    const clock = new FakeClock(start);
    const timers = new FakeTimers(clock);
    const runner = createTaskRunner({
      registry,
      policy: createResourcePolicy(),
      executor: new IdleExecutor(),
      now: clock.now,
      timers,
      leaseMs: LEASE_MS,
      longRunningNoticeMs: NOTICE_MS,
      // 无 longRunningNotice 端口 = 不启用（无法投递就不打扰）。
    });
    seedRunning(registry, 'slow-default', start);

    runner.pump();
    clock.advance(60 * 60_000);
    runner.pump();
    await runner.whenIdle();

    expect(timers.armed).toBe(0);
    expect(registry.get('slow-default', SCOPE).longRunningNotifiedAt).toBeUndefined();
  });
});
