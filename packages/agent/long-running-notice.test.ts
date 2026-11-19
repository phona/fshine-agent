/**
 * 预期契约（2026-11-18 owner 定）：后台任务长时间无动静的两档主动提醒（先红后绿）。
 *
 * 目标（机械、只看持久化底账 + 注入时钟）：
 *   · 任务 running 且从认领时刻起 10 分钟内 → **一条都不发**；
 *   · > 10 分钟仍无事件 → 发一条「比预计久了，停下来还是继续等」（每任务一次）；
 *   · > 30 分钟仍无事件 → 再发一条「卡住了，建议先停掉」（每任务一次，之后不再发）；
 *   · 只在 1:1 会话发（group 不发，也不落「已发」）；
 *   · 「已发」落库：重开 registry 再扫 → 零发送（重启不重发）；
 *   · 投递失败 → 同一档内重试一次（总尝试 ≤2，2026-11-19 投递真相切片）：失败不再等于
 *     「这档永久不发」；成功即止、一直失败也止于两次（不无限重试、不重复打扰）。
 *   · 文案只给用户可做的动作，不报进度（不写 operation 名、不写次数、不写最近一步）。
 *
 * 全部用真底账（SQLite 持久化）+ 假时钟/假定时器 + 假提醒端口（零网络、零真实平台）：
 *   · 假时钟：不真 sleep 10 分钟；`now` 注入 TaskRunner（阈值判定的唯一时间来源）；
 *   · 假定时器：与 waiting_user 到期消费者共用的那**一个**有界定时器轮由测试推进；
 *   · 假端口：记录每次投递（stage/文案/分钟数），判据只看它。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createResourcePolicy } from './src/resource-policy';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  LONG_RUNNING_NOTICE_TEXT,
  LONG_RUNNING_STUCK_NOTICE_TEXT,
  createTaskRunner,
  type LongRunningNoticePort,
  type TaskExecutionContext,
  type TaskExecutionInput,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRunner,
} from './src/task-runner';

const SCOPE = { principalId: 'p', sessionId: 'wecom:conv-private' } as const;
const GROUP_SCOPE = { principalId: 'p', sessionId: 'wecom:conv-group' } as const;
/** 两个阈值（测试用秒级值；生产缺省 10 分钟 / 30 分钟由配置源给出）。 */
const NOTICE_MS = 600_000;
const STUCK_MS = 1_800_000;
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
  stage: 'overdue' | 'stuck';
  minutes: number;
  text: string;
}

/** 记录每次投递的假提醒端口；`direct` 模拟 chatType 事实源。
 *  `results` = 第 n 次调用的送达结果（超出列表时沿用最后一个值；缺省 = 一直送达）。 */
function recordingNotice(
  direct: (sessionId: string) => boolean = () => true,
  results: readonly boolean[] = [true],
): {
  port: LongRunningNoticePort;
  sends: NoticeSend[];
} {
  const sends: NoticeSend[] = [];
  const port: LongRunningNoticePort = {
    isDirectSession: direct,
    async sendNotice(input): Promise<boolean> {
      const result = results[sends.length] ?? results[results.length - 1] ?? true;
      sends.push({ ...input });
      return result;
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
  /** 假提醒端口的逐次送达结果（首投/重试观察用；缺省一直送达）。 */
  noticeResults?: readonly boolean[];
}): Stack {
  const dbPath = tempDbPath();
  const registry = options.registry ?? openRegistry(dbPath);
  const clock = options.clock ?? new FakeClock(options.startIso);
  const timers = options.timers ?? new FakeTimers(clock);
  const { port, sends } = recordingNotice(options.direct, options.noticeResults);
  const events: Array<Record<string, unknown>> = [];
  const runner = createTaskRunner({
    registry,
    policy: createResourcePolicy(),
    executor: new IdleExecutor(),
    now: clock.now,
    timers,
    leaseMs: LEASE_MS,
    longRunningNoticeMs: NOTICE_MS,
    longRunningStuckNoticeMs: STUCK_MS,
    longRunningNotice: port,
    log: (line) => events.push(line),
  });
  return { dbPath, registry, runner, clock, timers, sends, events };
}

describe('预期契约：长时间无动静的两档主动提醒', () => {
  it('① 10 分钟内零发送、>10min 发一次、第二次扫描不再发；>30min 再一条，之后不再发', async () => {
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

    // 到 10 分钟：发一条「比预计久了，停下来还是继续等」。
    h.timers.advance(60_000);
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      taskId: 'slow-1',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      stage: 'overdue',
      minutes: 10,
      text: LONG_RUNNING_NOTICE_TEXT,
    });
    // 文案必须给出两个可做的动作；不得出现进度事实（operation 名/次数/最近一步）。
    expect(h.sends[0]!.text).toContain('停下来');
    expect(h.sends[0]!.text).toContain('继续等');
    expect(h.sends[0]!.text).not.toMatch(/operation|\.query|已执行|次|最近一步/);
    // 「已发」已落库（超预期档）。
    expect(h.registry.get('slow-1', SCOPE).longRunningNotifiedAt).toBeDefined();
    expect(h.registry.get('slow-1', SCOPE).longRunningStuckNotifiedAt).toBeUndefined();

    // 紧接着再扫一趟：不再发（每档一次）。
    h.clock.advance(1_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);

    // 到 30 分钟：再发一条「卡住了」。
    h.timers.advance(20 * 60_000 - 1_000);
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({
      taskId: 'slow-1',
      stage: 'stuck',
      text: LONG_RUNNING_STUCK_NOTICE_TEXT,
    });
    expect(h.registry.get('slow-1', SCOPE).longRunningStuckNotifiedAt).toBeDefined();

    // 之后不再自动发（再推进 10 分钟 + 主动扫）。
    h.timers.advance(10 * 60_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(2);

    // 两档各一条事件（成功）。
    expect(h.events.map((event) => event['event'])).toEqual([
      'task_long_running_notice',
      'task_long_running_notice',
    ]);
    expect(h.events.map((event) => event['result'])).toEqual(['sent', 'sent']);
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
      longRunningStuckNoticeMs: STUCK_MS,
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

  it('⑤ 先领取后投递失败 → 同一档内重试一次即达（不再永久不发）；事件逐次留痕', async () => {
    // 2026-11-19（投递真相切片）：领取成功、投递失败（渠道瞬时故障/路由未知）不得等于「这档
    // 永久不发」——旧实现先落「已发」再发，失败就没有下一次机会。修法：同一档内允许一次重试
    // （总尝试 ≤2）。本用例钉住「失败后重试真的送达」。
    const start = '2026-11-05T00:00:00.000Z';
    const h = stack({ startIso: start, noticeResults: [false, true] });
    seedRunning(h.registry, 'flaky-1', start);

    h.runner.pump();
    h.timers.advance(11 * 60_000);
    await h.runner.whenIdle();

    // 首投失败 + 重试成功：用户**收到**了这条提醒（旧实现只发一次 → 永远收不到）。
    expect(h.sends.map((send) => send.stage)).toEqual(['overdue', 'overdue']);
    expect(h.events.map((event) => event['result'])).toEqual(['failed', 'sent']);
    expect(h.events.map((event) => event['attempt'])).toEqual([1, 2]);
    // 「已发」仍在投递前落库（每档一次：不因重试变成每档多次提醒）。
    expect(h.registry.get('flaky-1', SCOPE).longRunningNotifiedAt).toBeDefined();

    // 再扫一趟：不再发（重试不是「重复打扰」——每档至多两条：首投 + 一次重试）。
    h.clock.advance(1_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(2);
  });

  it('⑥ 不该重试的仍然不重试：投递成功只发一次；投递一直失败也止于两次（不无限重试）', async () => {
    const start = '2026-11-06T00:00:00.000Z';
    // (a) 健康投递：一次成功即止（不因新机制多发一条）。
    const healthy = stack({ startIso: start });
    seedRunning(healthy.registry, 'healthy-1', start);
    healthy.runner.pump();
    healthy.timers.advance(11 * 60_000);
    await healthy.runner.whenIdle();
    expect(healthy.sends.map((send) => send.stage)).toEqual(['overdue']);
    expect(healthy.events.map((event) => event['result'])).toEqual(['sent']);

    // (b) 渠道持续不可用：最多两次尝试即止（有界），不随扫描次数增长。
    const broken = stack({ startIso: start, noticeResults: [false, false, false, false] });
    seedRunning(broken.registry, 'broken-1', start);
    broken.runner.pump();
    broken.timers.advance(11 * 60_000);
    await broken.runner.whenIdle();
    expect(broken.sends).toHaveLength(2);
    expect(broken.events.map((event) => event['result'])).toEqual(['failed', 'failed']);
    // 后续扫描不再重发（「已发」领取保留：每档一条提醒的事实不变）。
    broken.clock.advance(60_000);
    broken.runner.pump();
    broken.timers.advance(15 * 60_000);
    await broken.runner.whenIdle();
    expect(broken.sends).toHaveLength(2);
  });
});
