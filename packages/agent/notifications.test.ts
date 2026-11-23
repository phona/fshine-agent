/**
 * P4 通知 outbox 与投递（冻结契约 §4，2026-11-14 并行轨；先红后绿）。
 *
 * 覆盖（契约 §4 测试面）：
 *   ① 意图枚举（9 类）与状态转移→意图映射；
 *   ② outbox 写点与去重：唯一 (task_id, kind, state_version)，重复事实不新增、不覆盖；
 *   ③ payload 字段白名单：仅来自传入底账事实，编造/未知字段被拒且不落库；
 *   ④ 假 sink 投递成功路径：delivered_at / attempts 落库；
 *   ⑤ 重试/退避/attempts 上限：超限停止且未送达仍可见（不静默丢）；
 *   ⑤b 终态跳过（2026-11-19 投递真相切片）：sink 报 skipped → 不写 delivered_at、不再重试，
 *      行留在未送达集合里可查（last_error 带 SKIPPED: 前缀）——绝不把跳过记成送达；
 *   ⑥ 终态与等待类通知不静默丢（完成/失败/取消/超时/等待用户）；
 *   ⑦ 失败不影响事实（投递与事实解耦：不抛、同库 tasks 行原样）；
 *   ⑧ 并发调用串行化不重复送达；重启后去重与可见性不变；只读查询（listNotifications/undelivered）。
 *
 * 不触网、不碰真实平台（契约 §4：测试用假发送器）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_KINDS,
  NotificationPayloadError,
  createNotificationOutbox,
  createNotificationReader,
  type DeliveryReceipt,
  type Notification,
  type NotificationFact,
  type NotificationReason,
  type NotificationSink,
  type NotificationTerminalFact,
} from './src/notifications';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'notifications-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

/** 事实时间基准（T0）；时钟可手动推进，退避断言不依赖真实时间。 */
const T0 = '2026-11-14T08:00:00.000Z';

function manualClock(startIso: string = T0) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
    iso: () => new Date(ms).toISOString(),
  };
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  calls = 0;
  constructor(
    private readonly behavior: (notification: Notification, call: number) => DeliveryReceipt | Promise<DeliveryReceipt> =
      () => ({ delivered: true }),
  ) {}
  async send(notification: Notification): Promise<DeliveryReceipt> {
    this.calls += 1;
    this.sent.push(notification);
    return this.behavior(notification, this.calls);
  }
}

function fact(overrides: Partial<NotificationFact> = {}): NotificationFact {
  return { taskId: 'task_1', kind: 'started', at: T0, taskNo: 7, name: '查询日报', ...overrides };
}

function harness(
  dbPath: string,
  sink: FakeSink,
  overrides: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    onTerminal?: (terminal: NotificationTerminalFact) => void;
  } = {},
) {
  const clock = manualClock();
  const outbox = createNotificationOutbox({
    dbPath,
    sink,
    now: clock.now,
    maxAttempts: 3,
    baseBackoffMs: 1000,
    maxBackoffMs: 5000,
    ...overrides,
  });
  return { outbox, clock };
}

describe('P4 通知意图枚举与状态映射（契约 §4）', () => {
  it('7 类事件/通知意图冻结、顺序与集合精确（没有 completed/failed 结论类）', () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      'accepted',
      'started',
      'waiting_user',
      'resumed',
      'user_stop',
      'deadline_reached',
      'capacity_blocked',
    ]);
  });

  // 状态转移→意图映射（notificationKindForTransition / TaskState）已随 S1 事实模型删除：
  // 底账不再有状态转移，通知意图改由机械事实事件映射（notificationKindForEvent）。
  // 对应旧用例一并退役（被删机制的红由机械事实映射的消费者守卫取代）。
});

describe('P4 outbox 写点与去重（P4-T01）', () => {
  it('record 落库：唯一键、payload、created_at、初始投递态', () => {
    const { outbox, clock } = harness(tempDbPath(), new FakeSink());
    const { notification, created } = outbox.record(fact());
    expect(created).toBe(true);
    expect(notification).toMatchObject({
      taskId: 'task_1',
      kind: 'started',
      stateVersion: T0,
      createdAt: clock.iso(),
      attempts: 0,
      exhausted: false,
    });
    expect(notification.deliveredAt).toBeUndefined();
    expect(notification.lastError).toBeUndefined();
    outbox.close();
  });

  it('同 (task_id, kind, state_version) 重复事实不新增、不覆盖', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const first = outbox.record(fact({ name: '查询日报' }));
    expect(first.created).toBe(true);
    const again = outbox.record(fact({ name: '被重复触发时的另一个名字' }));
    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(first.notification.id);
    // 首次事实优先：重复触发不得改写已落库 payload。
    expect(again.notification.payload.name).toBe('查询日报');
    expect(outbox.listNotifications()).toHaveLength(1);
    outbox.close();
  });

  it('state_version 缺省 = 事实时间 at：同 at 去重；不同 at（新一轮等待）各自成行', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    outbox.record(fact({ kind: 'waiting_user', at: T0 }));
    outbox.record(fact({ kind: 'waiting_user', at: T0 }));
    outbox.record(fact({ kind: 'waiting_user', at: '2026-11-14T08:05:00.000Z' }));
    expect(outbox.listNotifications()).toHaveLength(2);
    outbox.close();
  });

  it('不同 kind / 不同 task / 显式 state_version 各自成行', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    outbox.record(fact({ kind: 'started', stateVersion: 1 }));
    outbox.record(fact({ kind: 'started', stateVersion: 2 }));
    outbox.record(fact({ kind: 'user_stop', stateVersion: 2 }));
    outbox.record(fact({ taskId: 'task_2', kind: 'started', stateVersion: 2 }));
    expect(outbox.listNotifications()).toHaveLength(4);
    expect(outbox.listNotifications('task_2')).toHaveLength(1);
    outbox.close();
  });
});

describe('P4 payload 仅来自传入事实（P4-T04 确定性字段来源）', () => {
  it('payload 只含白名单字段，不挟带内部字段；可选字段缺省即不出现（不伪造）', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const { notification } = outbox.record(fact({ reason: 'result_unknown', requestIds: ['req_1'] }));
    expect(notification.payload).toEqual({
      at: T0,
      taskNo: 7,
      name: '查询日报',
      reason: 'result_unknown',
      requestIds: ['req_1'],
    });
    expect(Object.keys(notification.payload).sort()).toEqual(['at', 'name', 'reason', 'requestIds', 'taskNo']);

    const bare = outbox.record({ taskId: 'task_x', kind: 'started', at: T0 }).notification;
    expect(bare.payload).toEqual({ at: T0 });
    expect(Object.keys(bare.payload)).toEqual(['at']);
    outbox.close();
  });

  it('编造/未知字段被拒且不落库（percent、内部字段等一律拒绝）', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const forged = { ...fact(), percent: 80, taskStatus: 'done' };
    expect(() => outbox.record(forged as unknown as NotificationFact)).toThrow(NotificationPayloadError);
    expect(outbox.listNotifications()).toEqual([]);
    outbox.close();
  });

  it('result_unknown 以 failed 意图承载，payload.reason 如实携带（v1.1 澄清口径，不得混淆为 failed_confirmed/success）', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const { notification } = outbox.record(fact({ kind: 'user_stop', reason: 'result_unknown' }));
    expect(notification.kind).toBe('user_stop');
    expect(notification.payload.reason).toBe('result_unknown');
    const [row] = outbox.listNotifications();
    expect(row!.kind).toBe('user_stop');
    expect(row!.payload.reason).toBe('result_unknown');
    outbox.close();
  });

  it('非法 kind / reason / taskNo / 缺 at 被拒，且不落库', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const forgedKind = { taskId: 'task_1', kind: 'done', at: T0 };
    const forgedReason = { ...fact(), reason: '模型猜测的原因' };
    const forgedNo = { ...fact(), taskNo: 0 };
    const missingAt = { taskId: 'task_1', kind: 'started' };
    for (const bad of [forgedKind, forgedReason, forgedNo, missingAt]) {
      expect(() => outbox.record(bad as unknown as NotificationFact)).toThrow(NotificationPayloadError);
    }
    expect(outbox.listNotifications()).toEqual([]);
    outbox.close();
  });
});

describe('P4 假 sink 投递：成功与失败路径（P4-T02）', () => {
  it('投递成功：写 delivered_at、attempts=1、未送达集合清空、sink 收到同一通知', async () => {
    const sink = new FakeSink();
    const { outbox, clock } = harness(tempDbPath(), sink);
    outbox.record(fact());
    const attempts = await outbox.deliverPending();
    expect(attempts).toMatchObject([{ outcome: 'delivered', attempts: 1 }]);
    expect(sink.calls).toBe(1);
    expect(sink.sent[0]).toMatchObject({ taskId: 'task_1', kind: 'started' });
    const [row] = outbox.listNotifications();
    expect(row!.deliveredAt).toBe(clock.iso());
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBeUndefined();
    expect(outbox.undelivered()).toEqual([]);
    outbox.close();
  });

  it('连续失败→恢复：attempts 递增、退避到点才重试、成功写 delivered_at', async () => {
    const sink = new FakeSink((_notification, call) =>
      call <= 2 ? { delivered: false, error: '渠道不可用' } : { delivered: true },
    );
    const { outbox, clock } = harness(tempDbPath(), sink);
    outbox.record(fact());

    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1, error: '渠道不可用' }]);
    clock.advance(999);
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'skipped_not_due', attempts: 1 }]);
    expect(sink.calls).toBe(1);

    clock.advance(1); // 首次退避（1000ms）到期
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'retry_scheduled', attempts: 2, error: '渠道不可用' }]);
    clock.advance(1999); // 第二次退避（累计 3000ms）未到
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'skipped_not_due', attempts: 2 }]);
    expect(sink.calls).toBe(2);

    clock.advance(1); // 累计 3000ms 到期
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'delivered', attempts: 3 }]);
    expect(sink.calls).toBe(3);

    const [row] = outbox.listNotifications();
    expect(row!.deliveredAt).toBe(clock.iso());
    expect(row!.attempts).toBe(3);
    expect(row!.lastError).toBeUndefined();
    expect(outbox.undelivered()).toEqual([]);
    outbox.close();
  });

  it('sink 抛异常同样按失败计：不逃逸、记 last_error、可重试', async () => {
    const sink = new FakeSink(() => {
      throw new Error('渠道连接中断');
    });
    const { outbox } = harness(tempDbPath(), sink);
    outbox.record(fact());
    const attempts = await outbox.deliverPending(); // 不得 reject
    expect(attempts).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1, error: '渠道连接中断' }]);
    const [row] = outbox.undelivered();
    expect(row!.lastError).toBe('渠道连接中断');
    expect(row!.deliveredAt).toBeUndefined();
    outbox.close();
  });

  it('改期（sink 报 deferred）：不写 delivered_at、不消耗 attempts、不记 last_error，下一次驱动再来', async () => {
    // 2026-11-19：改期 = 本次没尝试投递（会话在跑回合，界面让路）。它既不是送达也不是失败，
    // 所以不占 attempts 配额；下一次投递驱动（装配侧回合末补一次）就送到。
    const sink = new FakeSink((_notification, call) =>
      call === 1 ? { delivered: false, deferred: true } : { delivered: true },
    );
    const { outbox } = harness(tempDbPath(), sink, { maxAttempts: 3 });
    outbox.record(fact());
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'deferred', attempts: 0 }]);
    const [row] = outbox.listNotifications();
    expect(row!.deliveredAt).toBeUndefined();
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeUndefined();
    expect(row!.exhausted).toBe(false);
    expect(outbox.undelivered()).toHaveLength(1);
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'delivered', attempts: 1 }]);
    expect(outbox.undelivered()).toEqual([]);
    outbox.close();
  });

  it('投递终局观察口：失败到 attempts 上限 / 终态跳过各报一次（不重复报）', async () => {
    // 2026-11-19 第 3 档接线：未送达就进终局的通知必须落一条观察事件（server 装配接日志，
    // ops/alerts 的 delivery_failed 规则据此可见）——旧实现只改行内状态，谁都不知道。
    const terminals: NotificationTerminalFact[] = [];
    const failing = new FakeSink(() => ({ delivered: false, error: '渠道不可用' }));
    const a = harness(tempDbPath(), failing, { maxAttempts: 2, onTerminal: (terminal) => terminals.push(terminal) });
    a.outbox.record(fact());
    expect(await a.outbox.deliverPending()).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1 }]);
    expect(terminals).toEqual([]); // 还有下一次机会：不算终局
    a.clock.advance(1000);
    expect(await a.outbox.deliverPending()).toMatchObject([{ outcome: 'stopped', attempts: 2 }]);
    expect(terminals).toMatchObject([
      { outcome: 'exhausted', taskId: 'task_1', kind: 'started', attempts: 2, reason: '渠道不可用' },
    ]);
    // 终局只报一次：后续投递驱动对已到限的行早退（不重复报，也不重复调 sink）。
    a.clock.advance(600_000);
    await a.outbox.deliverPending();
    expect(terminals).toHaveLength(1);
    expect(failing.calls).toBe(2);
    a.outbox.close();

    const skips: NotificationTerminalFact[] = [];
    const s = harness(tempDbPath(), new FakeSink(() => ({ delivered: false, skipped: 'empty_after_strip', deliveryMode: 'live' })), {
      maxAttempts: 2,
      onTerminal: (terminal) => skips.push(terminal),
    });
    s.outbox.record(fact());
    await s.outbox.deliverPending();
    // 跳过终局带上部署模式事实（owner 2026-11-19：live + skipped 要告警）。
    expect(skips).toMatchObject([
      { outcome: 'skipped', taskId: 'task_1', kind: 'started', attempts: 2, reason: 'SKIPPED:empty_after_strip', deliveryMode: 'live' },
    ]);
    s.outbox.close();
  });

  it('终态跳过（sink 报 skipped）：不写 delivered_at、不再重试、行留在未送达集合里可查', async () => {
    // 2026-11-19 投递真相切片：真的没有东西要发（如剥完为空）/永不可能送达（如非 live）时，
    // sink 报 skipped。旧行为是 sink 回 delivered:true → 这里写下 delivered_at（用户什么都
    // 没收到，却记成送达，重试也不再接管）。现在：如实记跳过。
    const sink = new FakeSink(() => ({ delivered: false, skipped: 'empty_after_strip' }));
    const { outbox, clock } = harness(tempDbPath(), sink, { maxAttempts: 3 });
    outbox.record(fact());

    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'skipped', attempts: 3, error: 'SKIPPED:empty_after_strip' }]);
    expect(sink.calls).toBe(1);
    const [row] = outbox.listNotifications();
    expect(row!.deliveredAt).toBeUndefined();
    expect(row!.lastError).toBe('SKIPPED:empty_after_strip');
    expect(row!.exhausted).toBe(true); // 重试已停止（不是「还在排队重试」）

    // 之后的任何一次投递驱动都不再调 sink（跳过不是失败：不重试、也不放开上限）。
    clock.advance(600_000);
    expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'stopped', attempts: 3 }]);
    expect(sink.calls).toBe(1);
    expect(outbox.undelivered()).toHaveLength(1);
    outbox.close();
  });

  it('反向绊线口径：跳过与失败是两条路——失败照旧退避重试，跳过一次即止', async () => {
    const failing = new FakeSink(() => ({ delivered: false, error: '渠道不可用' }));
    const a = harness(tempDbPath(), failing, { maxAttempts: 3 });
    a.outbox.record(fact());
    expect(await a.outbox.deliverPending()).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1 }]);
    a.outbox.close();

    const skipping = new FakeSink(() => ({ delivered: false, skipped: 'route_unresolvable' }));
    const b = harness(tempDbPath(), skipping, { maxAttempts: 3 });
    b.outbox.record(fact());
    expect(await b.outbox.deliverPending()).toMatchObject([{ outcome: 'skipped', attempts: 3 }]);
    expect(b.outbox.undelivered()[0]!.lastError).toBe('SKIPPED:route_unresolvable');
    b.outbox.close();
  });
});

describe('P4 重试上限与终态不静默丢（P4-T02/T03）', () => {
  it('attempts 超上限即停止：不再调用 sink，未送达仍可见（exhausted）', async () => {
    const sink = new FakeSink(() => ({ delivered: false, error: '渠道不可用' }));
    const { outbox, clock } = harness(tempDbPath(), sink, { maxAttempts: 3 });
    outbox.record(fact());

    expect((await outbox.deliverPending())[0]!.outcome).toBe('retry_scheduled'); // t0，attempts=1
    clock.advance(1000);
    expect((await outbox.deliverPending())[0]!.outcome).toBe('retry_scheduled'); // attempts=2
    clock.advance(2000); // 累计 3000ms 到期
    expect((await outbox.deliverPending())[0]!.outcome).toBe('stopped'); // attempts=3 → 上限
    clock.advance(10 * 60 * 1000);
    expect((await outbox.deliverPending())[0]!.outcome).toBe('stopped'); // 停止后不再尝试

    expect(sink.calls).toBe(3);
    const [row] = outbox.undelivered();
    expect(row!.attempts).toBe(3);
    expect(row!.deliveredAt).toBeUndefined();
    expect(row!.exhausted).toBe(true);
    expect(row!.lastError).toBe('渠道不可用');
    outbox.close();
  });

  it('终态与等待类（完成/失败/取消/超时/等待用户）超限后全部在未送达集合可见', async () => {
    const sink = new FakeSink(() => ({ delivered: false, error: 'SINK_DOWN' }));
    const { outbox, clock } = harness(tempDbPath(), sink, { maxAttempts: 2 });
    const kinds = ['started', 'user_stop', 'deadline_reached', 'waiting_user', 'capacity_blocked'] as const;
    for (const [index, kind] of kinds.entries()) {
      outbox.record(fact({ taskId: `task_${index}`, kind, at: new Date(Date.parse(T0) + index).toISOString() }));
    }
    await outbox.deliverPending(); // 每行第 1 次失败
    clock.advance(1000);
    await outbox.deliverPending(); // 每行第 2 次失败 → 上限
    clock.advance(100000);
    const later = await outbox.deliverPending();
    expect(later.every((result) => result.outcome === 'stopped')).toBe(true);

    expect(sink.calls).toBe(10);
    const undelivered = outbox.undelivered();
    expect(undelivered.map((n) => n.kind).sort()).toEqual([...kinds].sort());
    for (const notification of undelivered) {
      expect(notification.attempts).toBe(2);
      expect(notification.lastError).toBe('SINK_DOWN');
      expect(notification.exhausted).toBe(true);
    }
    expect(outbox.listNotifications()).toHaveLength(5); // 通知事实保留，未静默消失
    outbox.close();
  });
});

describe('P4 失败不影响事实（投递与事实解耦）', () => {
  it('投递失败不改同库任务行；写点不调用 sink；deliverPending 不抛', async () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    raw.prepare('INSERT INTO tasks (task_id, status) VALUES (?, ?)').run('task_1', 'running');
    raw.close();

    const sink = new FakeSink(() => {
      throw new Error('渠道不可用');
    });
    const { outbox } = harness(dbPath, sink);
    const first = outbox.record(fact());
    expect(first.created).toBe(true);
    expect(sink.calls).toBe(0); // 写入不依赖投递

    await expect(outbox.deliverPending()).resolves.toMatchObject([{ outcome: 'retry_scheduled' }]);
    expect(sink.calls).toBe(1);

    const check = new Database(dbPath, { readonly: true });
    expect(check.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task_1')).toEqual({ status: 'running' });
    check.close();
    expect(outbox.undelivered()).toHaveLength(1); // 失败可见，而非丢失
    outbox.close();
  });

  it('并发 deliverPending 串行化：同一通知不重复送达', async () => {
    let release!: (receipt: DeliveryReceipt) => void;
    const gate = new Promise<DeliveryReceipt>((resolve) => {
      release = resolve;
    });
    const sink = new FakeSink(() => gate);
    const { outbox } = harness(tempDbPath(), sink);
    outbox.record(fact());

    const first = outbox.deliverPending();
    const second = outbox.deliverPending();
    release({ delivered: true });
    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(firstResults).toMatchObject([{ outcome: 'delivered' }]);
    expect(secondResults).toEqual([]); // 第二次进入时已送达
    expect(sink.calls).toBe(1); // 同一通知只送达一次
    expect(outbox.undelivered()).toEqual([]);
    outbox.close();
  });
});

describe('P4 只读查询与持久化（P4-T05 只读形态：不注入对话历史）', () => {
  it('reader 提供 listNotifications/undelivered：已送达/未送达可查，缺库给空集合', async () => {
    const dbPath = tempDbPath();
    const sink = new FakeSink();
    const { outbox } = harness(dbPath, sink);
    outbox.record(fact({ taskId: 'task_a' }));
    await outbox.deliverPending();
    outbox.record(fact({ taskId: 'task_b', kind: 'user_stop', at: T0, reason: 'result_unknown' }));
    outbox.close();

    const reader = createNotificationReader(dbPath);
    expect(reader.listNotifications()).toHaveLength(2);
    expect(reader.listNotifications('task_a')[0]!.deliveredAt).toBeDefined();
    expect(reader.undelivered().map((n) => n.taskId)).toEqual(['task_b']);
    expect(reader.undelivered('task_a')).toEqual([]);
    reader.close();

    const missing = createNotificationReader(path.join(path.dirname(dbPath), 'missing.db'));
    expect(missing.listNotifications()).toEqual([]);
    expect(missing.undelivered()).toEqual([]);
    missing.close();
  });

  it('重启后去重仍生效、未送达仍可见（outbox 由本模块 IF NOT EXISTS 自建且幂等）', async () => {
    const dbPath = tempDbPath();
    const sink = new FakeSink(() => ({ delivered: false, error: '渠道不可用' }));
    const first = harness(dbPath, sink);
    first.outbox.record(fact());
    first.outbox.close();

    const second = harness(dbPath, sink);
    const again = second.outbox.record(fact());
    expect(again.created).toBe(false);
    expect(second.outbox.undelivered()).toHaveLength(1);
    second.outbox.close();

    // 最小表列集与冻结契约 §4 一致（无多余列）。
    const db = new Database(dbPath, { readonly: true });
    const columns = (db.pragma('table_info(notifications)') as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'task_id',
      'kind',
      'state_version',
      'payload_json',
      'created_at',
      'delivered_at',
      'attempts',
      'last_error',
    ]);
    db.close();
  });
});

describe('R5 补字段：payload.missing（waiting_user 缺什么的条目）', () => {
  it('waiting_user 事实携带 missing：落库 payload 原样带出', () => {
    const dbPath = tempDbPath();
    const sink = new FakeSink();
    const { outbox } = harness(dbPath, sink);
    const recorded = outbox.record(fact({
      kind: 'waiting_user',
      missing: ['开票日期', '报销归属项目'],
    }));
    expect(recorded.notification.payload.missing).toEqual(['开票日期', '报销归属项目']);
    outbox.close();
  });

  it('missing 非法形状被拒且不落库（非空字符串数组）', () => {
    const dbPath = tempDbPath();
    const { outbox } = harness(dbPath, new FakeSink());
    for (const bad of [
      ['ok', ''],
      ['ok', 3],
      '开票日期',
    ] as unknown[]) {
      expect(() => outbox.record(fact({ kind: 'waiting_user', missing: bad as never }))).toThrow(
        NotificationPayloadError,
      );
    }
    expect(outbox.listNotifications()).toEqual([]);
    outbox.close();
  });
});
