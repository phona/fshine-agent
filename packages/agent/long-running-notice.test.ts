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
 *   · **1:1 与群聊都发**（owner 2026-11-19 #9：群 = 独立主体；判据只看底账任务事实）；
 *   · 「已发」落库：重开 registry 再扫 → 零发送（重启不重发）；
 *   · 投递失败 → 同一档内重试一次（总尝试 ≤2，2026-11-19 投递真相切片）：失败不再等于
 *     「这档永久不发」；成功即止、一直失败也止于两次（不无限重试、不重复打扰）。
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

/** runner 交给端口的东西：时机 + 事实文本/兜底句（群主体的去名重建归端口=宿主）。 */
interface NoticeSend {
  taskId: string;
  principalId: string;
  sessionId: string;
  stage: 'overdue' | 'contact_lost';
  name?: string;
  minutes: number;
  factText: string;
  fallbackText: string;
}

/**
 * 记录每次投递的假提醒端口。
 * `results` = 第 n 次调用的送达结果（超出列表时沿用最后一个值；缺省 = 一直送达）；
 * false = 模型说不出话且兜底也失败（本次没交出话）——重试观察用（首投/重试各一条）。
 */
function recordingNotice(
  results: readonly boolean[] = [true],
): {
  port: LongRunningNoticePort;
  sends: NoticeSend[];
} {
  const sends: NoticeSend[] = [];
  const port: LongRunningNoticePort = {
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
  // S1：queued begin 不写 running_since；armLease 的 COALESCE 才能把起点钉到 startedAt。
  registry.begin({ taskId, ...scope, request: '查一下上季度报销明细', queued: true });
  registry.store.armLease(taskId, {
    owner: 'task-runner',
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
  /** 假提醒端口的逐次送达结果（首投/重试观察用；缺省一直送达）。 */
  noticeResults?: readonly boolean[];
}): Stack {
  const dbPath = tempDbPath();
  const registry = options.registry ?? openRegistry(dbPath);
  const clock = options.clock ?? new FakeClock(options.startIso);
  const timers = options.timers ?? new FakeTimers(clock);
  const { port, sends } = recordingNotice(options.noticeResults);
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

    // 到 10 分钟：交一条提醒——runner 拼**事实文本 + 兜底句**（业务名 + 已跑多久；
    // contact_lost 档则是装配注入文案），群主体的隐私口径（去业务名）由端口重建。
    h.timers.advance(60_000);
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      taskId: 'slow-1',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: '查一下上季度报销明细',
      minutes: 10,
    });
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
    // 第二档整档删除：没有第二次投递（「卡住」文案本身也不存在——见 ①c 的 builder 断言）。
    expect(h.sends).toHaveLength(1);

    // 一条事件（成功）。
    expect(h.events.map((event) => event['event'])).toEqual(['task_long_running_notice']);
    expect(h.events.map((event) => event['result'])).toEqual(['sent']);
  });

  it('①d 回合失败（无汇报）落定：写「本轮已停」事实（round_failed_at），不再被「久无动静」叫醒（2026-11-22 Grok 复审）', async () => {
    // S1 后 noteRoundFailed 只发事件不写行内事实、settle 清租约；若再不写结束事实，
    // running_since 仍在 → 旧过滤（running_since + 无结束时刻 + 无等待）会把已结束的任务
    // 当「还在跑」，几秒办完的任务 10 分钟后被叫醒「已经跑了 N 分钟还没有结果」。
    const dbPath = tempDbPath();
    const registry = openRegistry(dbPath);
    const { port, sends } = recordingNotice();
    const executor: TaskExecutor = {
      execute(): Promise<TaskExecutionOutcome> {
        // 无汇报收尾 = 回合失败事实（S1：执行端不产出结论）。
        return Promise.resolve({ kind: 'ended' });
      },
    };
    const runner = createTaskRunner({
      registry,
      policy: createResourcePolicy(),
      executor,
      // 扫描时钟取真实之后 1h：认领写入的 running_since（真实即时）即超过 60s 提醒阈值。
      now: () => new Date(Date.now() + 3_600_000),
      timers: { set: () => 0, clear: () => {} },
      leaseMs: LEASE_MS,
      longRunningNoticeMs: 60_000,
      longRunningNotice: port,
    });
    runner.submit({ taskId: 'fail-1', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '查一下上季度报销明细' });
    runner.pump();
    await runner.whenIdle();
    // 落定写「本轮已停」事实：已结束的任务不再算「在跑」（不是 died——无汇报 ≠ 结果未知）。
    const settled = registry.get('fail-1', SCOPE);
    expect(settled.endedAt).toBeTruthy();
    runner.pump();
    await runner.whenIdle();
    expect(sends).toHaveLength(0);
  });

  it('①e 已存档汇报（completed）的行不在「在跑行」里（listRunning 不再扫到已结束任务）', () => {
    const start = '2026-11-06T00:00:00.000Z';
    const h = stack({ startIso: start });
    seedRunning(h.registry, 'done-1', start);
    h.registry.archiveReply(['done-1'], '办完了。');
    expect(h.registry.listRunning().map((task) => task.taskId)).not.toContain('done-1');
  });

  it('①b 走岔路：端口交不出话（模型说不出话且兜底失败）→ 逐次记 failed，任务不被改判终态、止于两次', async () => {
    // 2026-11-19 并集：投递真相切片把「交不出话」从「当场放弃」改成「同一档内再试一次」
    //（总尝试 ≤2，与仓内「同一件事一个回合内 ≤2 次」同口径）——本用例留下的断言是
    //「有界、不刷屏、不改任务事实」：两次以后不再交、任务仍 running。
    const start = '2026-11-01T00:00:00.000Z';
    const h = stack({ startIso: start, noticeResults: [false, false] });
    seedRunning(h.registry, 'slow-1', start);

    h.runner.pump();
    h.timers.advance(11 * 60_000);
    await h.runner.whenIdle();

    // 端口被交到（事实与兜底句都在），但它如实回报「没交出去」：首投 + 一次重试。
    expect(h.sends).toHaveLength(2);
    expect(h.events).toEqual([
      expect.objectContaining({ event: 'task_long_running_notice', result: 'failed', attempt: 1 }),
      expect.objectContaining({ event: 'task_long_running_notice', result: 'failed', attempt: 2 }),
    ]);
    // 任务事实不动（仍持有租约、未写 died 事实），「已发」已落库（不刷屏）。
    const stillRunning = h.registry.get('slow-1', SCOPE);
    expect(stillRunning.endedAt).toBeUndefined();
    expect(stillRunning.leaseUntil).toBeDefined();
    expect(h.registry.get('slow-1', SCOPE).longRunningNotifiedAt).toBeDefined();
    // 到限即止：再推进时间也不再交。
    h.timers.advance(10 * 60_000);
    h.runner.pump();
    await h.runner.whenIdle();
    expect(h.sends).toHaveLength(2);
  });

  it('①c 事实文本（宿主拼）：业务名缺省用中性指代、长名截断、分钟数逐字进事实、不报进度', () => {
    expect(longRunningNoticeFactText({ minutes: 12 })).toContain('你交代的那件事');
    expect(longRunningNoticeFactText({ name: '  ', minutes: 12 })).toContain('你交代的那件事');
    expect(longRunningNoticeFactText({ name: '查上季度报销', minutes: 12 })).toContain('「查上季度报销」');
    const long = '一'.repeat(40);
    expect(longRunningNoticeFactText({ name: long, minutes: 12 })).not.toContain(long);
    expect(longRunningNoticeFactText({ name: long, minutes: 12 })).toContain('…');
    const fact = longRunningNoticeFactText({ name: '查上季度报销', minutes: 12 });
    expect(fact).toContain('[久无动静]');
    expect(fact).toContain('12 分钟');
    expect(fact).not.toMatch(/operation|\.query|已执行|最近一步/);
    // 删掉的那一档不许以任何形式回潮。
    expect(fact).not.toMatch(/卡住|先停掉/);
    // 兜底句（只走「模型回合挂掉」路径）必须给出两个可做的动作，且不诱导重试。
    expect(LONG_RUNNING_NOTICE_FALLBACK_TEXT).toContain('停下来');
    expect(LONG_RUNNING_NOTICE_FALLBACK_TEXT).toContain('继续等');
    expect(LONG_RUNNING_NOTICE_FALLBACK_TEXT).not.toMatch(/再试一次|卡住|先停掉/);
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

  it('③ 群聊也发（owner 2026-11-19 #9）：群任务照常交提醒、照样落「已发」；1:1 同批照发', async () => {
    // 旧口径（群聊一律不发）已按 owner 指令迁移：群 = 独立主体，群里的任务就是这个群的事；
    // 判据只看底账任务事实（谁的任务、活在哪个会话），不再有 chatType 一刀切。
    const start = '2026-11-03T00:00:00.000Z';
    const h = stack({ startIso: start });
    seedRunning(h.registry, 'group-1', start, GROUP_SCOPE);
    seedRunning(h.registry, 'private-1', start, SCOPE);

    h.runner.pump();
    h.timers.advance(11 * 60_000);
    await h.runner.whenIdle();

    expect(h.sends.map((send) => send.taskId).sort()).toEqual(['group-1', 'private-1']);
    // 群任务的提醒仍带自己的会话事实（投递路由/主体都从任务行来）。
    const groupSend = h.sends.find((send) => send.taskId === 'group-1')!;
    expect(groupSend).toMatchObject({ principalId: GROUP_SCOPE.principalId, sessionId: GROUP_SCOPE.sessionId });
    expect(h.registry.get('group-1', GROUP_SCOPE).longRunningNotifiedAt).toBeDefined();
    expect(h.registry.get('private-1', SCOPE).longRunningNotifiedAt).toBeDefined();
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

  it('⑤ 「断联系」档（contact_lost）：同一「每档至多一次」领取，与「久无动静」档互不吞并，重启不重发（SQLite 面）', () => {
    const start = '2026-11-05T00:00:00.000Z';
    const h = stack({ startIso: start });
    seedRunning(h.registry, 'wait-1', start);

    // 领取成功并落库；同档第二次被拒（零写入）；视图如实暴露时刻。
    expect(h.registry.claimLongRunningNotice('wait-1', 'contact_lost', start)).toBe(true);
    expect(h.registry.claimLongRunningNotice('wait-1', 'contact_lost', start)).toBe(false);
    expect(h.registry.get('wait-1', SCOPE).waitContactLostNotifiedAt).toBe(start);
    // 与「久无动静」档互不吞并（不是同一档）。
    expect(h.registry.get('wait-1', SCOPE).longRunningNotifiedAt).toBeUndefined();
    expect(h.registry.claimLongRunningNotice('wait-1', 'overdue', start)).toBe(true);

    // 重启（同一 dbPath 重开）后仍不重发：领取事实持久。
    h.registry.close();
    const reopened = openRegistry(h.dbPath);
    expect(reopened.claimLongRunningNotice('wait-1', 'contact_lost', start)).toBe(false);
    expect(reopened.get('wait-1', SCOPE).waitContactLostNotifiedAt).toBe(start);
    reopened.close();
  });

  it('⑥ 先领取后投递失败 → 同一档内重试一次即达（不再永久不发）；事件逐次留痕', async () => {
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

  it('⑦ 不该重试的仍然不重试：投递成功只发一次；投递一直失败也止于两次（不无限重试）', async () => {
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
