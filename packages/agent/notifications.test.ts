/**
 * P4 通知 outbox 与投递（冻结契约 §4，2026-11-14 并行轨；先红后绿）。
 *
 * 覆盖（契约 §4 测试面）：
 *   ① 意图枚举（9 类）与状态转移→意图映射；
 *   ② outbox 写点与去重：唯一 (task_id, kind, state_version)，重复事实不新增、不覆盖；
 *   ③ payload 字段白名单：仅来自传入底账事实，编造/未知字段被拒且不落库；
 *   ④ 假 sink 投递成功路径：delivered_at / attempts 落库；
 *   ⑤ 重试/退避/attempts 上限：超限停止且未送达仍可见（不静默丢）；
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
  notificationKindForTransition,
  type DeliveryReceipt,
  type Notification,
  type NotificationFact,
  type NotificationReason,
  type NotificationSink,
  type TaskState,
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
  return { taskId: 'task_1', kind: 'completed', at: T0, taskNo: 7, name: '查询日报', ...overrides };
}

function harness(
  dbPath: string,
  sink: FakeSink,
  overrides: { maxAttempts?: number; baseBackoffMs?: number; maxBackoffMs?: number } = {},
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
  it('9 类意图枚举冻结、顺序与集合精确', () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      'accepted',
      'started',
      'waiting_user',
      'resumed',
      'completed',
      'failed',
      'cancelled',
      'timed_out',
      'resource_limited',
    ]);
  });

  const cases: Array<{ from?: TaskState; to: TaskState; reason?: NotificationReason; kind?: string }> = [
    { to: 'queued', kind: 'accepted' },
    { from: 'queued', to: 'running', kind: 'started' },
    { from: 'waiting_user', to: 'running', kind: 'resumed' },
    { from: 'running', to: 'waiting_user', kind: 'waiting_user' },
    { from: 'running', to: 'completed', kind: 'completed' },
    { from: 'running', to: 'failed', reason: 'failed_confirmed', kind: 'failed' },
    { from: 'running', to: 'failed', reason: 'result_unknown', kind: 'failed' },
    { from: 'running', to: 'cancelled', reason: 'cancelled_by_user', kind: 'cancelled' },
    { from: 'running', to: 'timed_out', reason: 'timeout', kind: 'timed_out' },
    { from: 'running', to: 'failed', reason: 'resource_limited', kind: 'resource_limited' },
    { from: 'queued', to: 'cancelling', kind: undefined },
    { from: 'running', to: 'unexecuted', kind: undefined },
  ];

  for (const c of cases) {
    it(`映射 ${c.from ?? '∅'}→${c.to}${c.reason === undefined ? '' : `（${c.reason}）`} = ${c.kind ?? '无意图'}`, () => {
      expect(notificationKindForTransition(c.from, c.to, c.reason)).toBe(c.kind);
    });
  }
});

describe('P4 outbox 写点与去重（P4-T01）', () => {
  it('record 落库：唯一键、payload、created_at、初始投递态', () => {
    const { outbox, clock } = harness(tempDbPath(), new FakeSink());
    const { notification, created } = outbox.record(fact());
    expect(created).toBe(true);
    expect(notification).toMatchObject({
      taskId: 'task_1',
      kind: 'completed',
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
    outbox.record(fact({ kind: 'completed', stateVersion: 2 }));
    outbox.record(fact({ taskId: 'task_2', kind: 'started', stateVersion: 2 }));
    expect(outbox.listNotifications()).toHaveLength(4);
    expect(outbox.listNotifications('task_2')).toHaveLength(1);
    outbox.close();
  });
});

describe('P4 payload 仅来自传入事实（P4-T04 确定性字段来源）', () => {
  it('payload 只含白名单字段，不挟带内部字段；可选字段缺省即不出现（不伪造）', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const { notification } = outbox.record(fact({ reason: 'failed_confirmed', requestIds: ['req_1'] }));
    expect(notification.payload).toEqual({
      at: T0,
      taskNo: 7,
      name: '查询日报',
      reason: 'failed_confirmed',
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
    const { notification } = outbox.record(fact({ kind: 'failed', reason: 'result_unknown' }));
    expect(notification.kind).toBe('failed');
    expect(notification.payload.reason).toBe('result_unknown');
    const [row] = outbox.listNotifications();
    expect(row!.kind).toBe('failed');
    expect(row!.payload.reason).toBe('result_unknown');
    outbox.close();
  });

  it('非法 kind / reason / taskNo / 缺 at 被拒，且不落库', () => {
    const { outbox } = harness(tempDbPath(), new FakeSink());
    const forgedKind = { taskId: 'task_1', kind: 'done', at: T0 };
    const forgedReason = { ...fact(), reason: '模型猜测的原因' };
    const forgedNo = { ...fact(), taskNo: 0 };
    const missingAt = { taskId: 'task_1', kind: 'completed' };
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
    expect(sink.sent[0]).toMatchObject({ taskId: 'task_1', kind: 'completed' });
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
    const kinds = ['completed', 'failed', 'cancelled', 'timed_out', 'waiting_user'] as const;
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
    outbox.record(fact({ taskId: 'task_b', kind: 'failed', at: T0, reason: 'failed_confirmed' }));
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
