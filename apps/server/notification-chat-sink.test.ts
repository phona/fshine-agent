/**
 * 主动推送 sink（`notification-chat-sink.ts`）· 确定性单测（零网络、零真模型、零真平台）。
 *
 * 钉住的语义（每条都对应任务书里的一条纪律）：
 *   ① 只推 4 类（waiting_user/timed_out/resource_limited/cancelled）；
 *      accepted/started/resumed/completed 一律不推（后者由结果正文投递负责）；
 *   ② 文案只来自 `renderNotification`（四类人话），过用户可见出口清理；
 *   ③ 非 live 不投递、读不到任务范围不猜路由、路由拆不出不猜路由、剥完为空不投——
 *      这四类都是**终态跳过**（`{delivered:false, skipped}`）：不重试、**绝不记 delivered**；
 *   ④ 同回合已交给模型的一次性核销（用户已从模型口中听到 → 不重复发，也不是跳过）；
 *   ⑤ 会话在跑回合时不抢先推（照实报**未送达**，交 outbox 既有退避重试；装配侧回合末补驱动）；
 *   ⑥ 投递抛错向上抛（outbox 才能有界重试），任务事实不动；
 *   ⑦ 组合 sink：文件审计与聊天推送各自独立，不互相吞噬；跳过不合成「送达」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { createNotificationOutbox, type Notification, type NotificationKind } from '../../packages/agent/src/notifications';
import {
  composeNotificationSinks,
  createChatNotificationSink,
  PUSHED_NOTIFICATION_KINDS,
} from './notification-chat-sink';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-sink-'));
  tempDirs.push(dir);
  return dir;
}

/** 手动时钟（退避断言不依赖真实时间）。 */
function manualClock(startIso: string) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
    iso: () => new Date(ms).toISOString(),
  };
}

function notification(kind: NotificationKind, payload: Partial<Notification['payload']> = {}): Notification {
  return {
    id: 1,
    taskId: 'task-1',
    kind,
    stateVersion: 'v1',
    payload: { at: '2026-11-18T10:00:00.000Z', name: '查应收账款', ...payload },
    createdAt: '2026-11-18T10:00:00.000Z',
    attempts: 0,
    exhausted: false,
  };
}

interface Sent {
  route: ChannelRoute;
  text: string;
}

function fakeDelivery(mode: 'live' | 'silent' = 'live', behavior: 'ok' | 'throw' = 'ok') {
  const sent: Sent[] = [];
  return {
    sent,
    port: {
      deliveryMode: mode,
      async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
        if (behavior === 'throw') throw new Error('渠道不可用');
        sent.push({ route, text });
        return { parts: [{ type: 'text', text }] } as unknown as DeliveryReceipt;
      },
    },
  };
}

const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
const ROUTE = { channel: 'wecom', conversationId: 'conv-a' };

function sinkOf(overrides: Partial<Parameters<typeof createChatNotificationSink>[0]> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const sink = createChatNotificationSink({
    taskScope: () => SCOPE,
    log: (line) => events.push(line),
    ...overrides,
  });
  return { sink, events };
}

describe('主动推送 sink：种类与文案', () => {
  it('① waiting_user 推一条人话（业务名 + 还缺什么），路由还原到原会话', async () => {
    const delivery = fakeDelivery();
    const { sink } = sinkOf({ delivery: delivery.port });
    const result = await sink.send(notification('waiting_user', { missing: ['账套名'] }));
    expect(result.delivered).toBe(true);
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0]!.route).toEqual(ROUTE);
    expect(delivery.sent[0]!.text).toContain('需要你一句话');
    expect(delivery.sent[0]!.text).toContain('查应收账款');
    expect(delivery.sent[0]!.text).toContain('账套名');
  });

  it('① failed 不再由本 sink 推（2026-11-19 收口）；result_unknown 也不读作成功', async () => {
    // 口径变更：后台任务失败的主动告知改由 task-completion-delivery 的失败投递分支直发
    // （deliverTaskFailure + failureMessageFor 模板），本 sink 不推 failed——两套话术并存
    // 会双发。这里钉住「failed → kind_not_pushed」；result_unknown 落底账 failed + reason，
    // 用户话术同样走失败分支，本 sink 不再转发。
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port });
    await sink.send(notification('failed', { reason: 'failed_confirmed' }));
    await sink.send(notification('failed', { reason: 'result_unknown' }));
    expect(delivery.sent).toEqual([]);
    expect(events.filter((e) => e['reason'] === 'kind_not_pushed')).toHaveLength(2);
  });

  it('① 噪音类与 completed 一律不推（后者由结果正文投递负责）', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port });
    for (const kind of ['accepted', 'started', 'resumed', 'completed'] as const) {
      const result = await sink.send(notification(kind));
      expect(result.delivered).toBe(true);
    }
    expect(delivery.sent).toEqual([]);
    expect(events.map((e) => e['reason'])).toEqual(Array(4).fill('kind_not_pushed'));
  });

  it('② 文案过用户可见出口清理（服务器路径不出现在用户文本里）', async () => {
    const delivery = fakeDelivery();
    const { sink } = sinkOf({ delivery: delivery.port });
    await sink.send(notification('timed_out', { name: '整理 /home/fictional-user/fictional-projects/fshine-agent/.runtime/x.xlsx' }));
    expect(delivery.sent[0]!.text).not.toContain('/home/');
  });

  it('① 推送种类清单是本文件唯一来源（防有人悄悄加种类绕过职责划分）', () => {
    // 2026-11-19 口径变更：failed 移出（失败由 task-completion-delivery 失败分支直发）。
    expect([...PUSHED_NOTIFICATION_KINDS]).toEqual(['waiting_user', 'timed_out', 'resource_limited', 'cancelled']);
  });
});

describe('主动推送 sink：不投递的分支（终态跳过 / 未送达，绝不记 sent 也绝不记 delivered）', () => {
  it('③ 非 live：零 sendText，记 deliveryMode=silent，回执按**终态跳过**（不重试、不写 delivered）', async () => {
    const delivery = fakeDelivery('silent');
    const { sink, events } = sinkOf({ delivery: delivery.port });
    const result = await sink.send(notification('timed_out'));
    // 2026-11-19：旧实现回 delivered:true → outbox 写 delivered_at（用户什么都没收到却记了
    // 送达，重试也不再接管）。现在如实报「跳过」：没有东西可发/永不可能送达。
    expect(result.delivered).toBe(false);
    expect(result.skipped).toBe('delivery_unavailable');
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'notification_push_suppressed',
      reason: 'delivery_unavailable',
      deliveryMode: 'silent',
    }));
    expect(events.some((e) => e['event'] === 'notification_push_sent')).toBe(false);
  });

  it('③ 没有投递面：同样按终态跳过回执', async () => {
    const { sink, events } = sinkOf();
    const result = await sink.send(notification('timed_out'));
    expect(result).toMatchObject({ delivered: false, skipped: 'delivery_unavailable' });
    expect(events).toContainEqual(expect.objectContaining({ reason: 'delivery_unavailable', deliveryMode: 'unavailable' }));
  });

  it('③ 读不到任务范围：不猜路由，按终态跳过回执', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port, taskScope: () => undefined });
    const result = await sink.send(notification('timed_out'));
    expect(result).toMatchObject({ delivered: false, skipped: 'task_scope_unresolved' });
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: 'task_scope_unresolved' }));
  });

  it('③ 路由拆不出（sessionId 形状异常）：不猜路由，按终态跳过回执', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({
      delivery: delivery.port,
      taskScope: () => ({ principalId: 'wecom:user-a', sessionId: '没有分隔符' }),
    });
    const result = await sink.send(notification('timed_out'));
    expect(result).toMatchObject({ delivered: false, skipped: 'route_unresolvable' });
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: 'route_unresolvable' }));
  });

  it('④ 同回合已交给模型：一次性核销，第二次不再核销（用户已听模型说过 → 不是跳过）', async () => {
    const delivery = fakeDelivery();
    let claims = 1;
    const { sink, events } = sinkOf({
      delivery: delivery.port,
      claimRelayedInTurn: () => {
        if (claims === 0) return false;
        claims -= 1;
        return true;
      },
    });
    const first = await sink.send(notification('timed_out'));
    expect(first.delivered).toBe(true); // 模型已把这件事说给用户（用户级事实成立）
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: 'relayed_in_turn' }));
    const second = await sink.send(notification('timed_out'));
    expect(second.delivered).toBe(true);
    expect(delivery.sent).toHaveLength(1);
  });
});

describe('chat sink × 真 outbox：既有退避重试真正接管（不新增第二套重试）', () => {
  it('改期/瞬时故障一路不记 delivered → 退避到点后重试送达；跳过则终态不重试', async () => {
    // 场景（2026-11-19 投递真相切片）：通知落库时会话在跑回合（改期）→ 回合结束后第一次真发
    // 又撞渠道瞬时故障 → 必须有第三次机会（既有退避重试），最后真的送达；全程绝不提前写
    // delivered_at（投递没落地就不算送达）。
    const dbPath = path.join(tempDir(), 'state.db');
    const clock = manualClock('2026-11-19T08:00:00.000Z');
    let turnActive = true;
    let sendAttempts = 0;
    const sent: string[] = [];
    const skipScenario = { skip: false };
    const events: Array<Record<string, unknown>> = [];
    const chatSink = createChatNotificationSink({
      taskScope: () => (skipScenario.skip ? undefined : SCOPE),
      delivery: {
        deliveryMode: 'live',
        async sendText(): Promise<DeliveryReceipt> {
          sendAttempts += 1;
          if (sendAttempts === 1) throw new Error('渠道瞬时故障');
          sent.push('送到');
          return { parts: [{ type: 'text' }] } as unknown as DeliveryReceipt;
        },
      },
      turnActive: () => turnActive,
      log: (line) => events.push(line),
    });
    const outbox = createNotificationOutbox({
      dbPath,
      sink: chatSink,
      now: clock.now,
      maxAttempts: 4,
      baseBackoffMs: 1000,
      maxBackoffMs: 5000,
    });
    try {
      outbox.record({ taskId: 'task-1', kind: 'timed_out', at: clock.iso() });
      // ① 回合在跑：不投递、也不消耗尝试次数（旧实现这里就写 delivered_at 了）。
      expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'deferred', attempts: 0 }]);
      expect(outbox.listNotifications('task-1')[0]!.deliveredAt).toBeUndefined();
      expect(outbox.listNotifications('task-1')[0]!.attempts).toBe(0);
      expect(sent).toEqual([]);

      // ② 回合结束：第一次真发撞瞬时故障 → 不记 delivered，退避重试排队（attempts=1）。
      turnActive = false;
      expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1 }]);
      expect(outbox.listNotifications('task-1')[0]!.deliveredAt).toBeUndefined();

      // ③ 退避到点：送达（既有机制兜住了，用户最终收到）。
      clock.advance(1000);
      expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'delivered', attempts: 2 }]);
      expect(sent).toHaveLength(1);
      expect(outbox.listNotifications('task-1')[0]!.deliveredAt).toBeDefined();
      expect(outbox.undelivered()).toEqual([]);
      expect(events.map((event) => event['event'])).toEqual([
        'notification_push_deferred',
        'notification_push_failed',
        'notification_push_sent',
      ]);

      // ④ 好好的一条通知碰上「终态跳过」（读不到任务范围 = 重试也不会变）：不重试、不记 delivered，
      //    且行留在未送达集合里可查（如实记「跳过」）。
      skipScenario.skip = true;
      outbox.record({ taskId: 'task-2', kind: 'timed_out', at: clock.iso() });
      expect(await outbox.deliverPending()).toMatchObject([{ outcome: 'skipped' }]);
      const skipped = outbox.listNotifications('task-2')[0]!;
      expect(skipped.deliveredAt).toBeUndefined();
      expect(skipped.lastError).toBe('SKIPPED:task_scope_unresolved');
      expect(outbox.undelivered('task-2')).toHaveLength(1);
      // 再推进很久也不重试（跳过的反面 = 无意义重试；不放开上限、不变成无限重试）。
      clock.advance(600_000);
      const attemptsBefore = outbox.listNotifications('task-2')[0]!.attempts;
      await outbox.deliverPending();
      expect(outbox.listNotifications('task-2')[0]!.attempts).toBe(attemptsBefore);
    } finally {
      outbox.close();
    }
  });
});

describe('主动推送 sink：时序与失败', () => {
  it('⑤ 会话有回合在跑 → 本次不投递、回执照实报未送达（交 outbox 既有退避重试；回合末补驱动 → 送达）', async () => {
    const delivery = fakeDelivery();
    let turnActive = true;
    const { sink, events } = sinkOf({
      delivery: delivery.port,
      turnActive: () => turnActive,
    });
    const whileTurn = await sink.send(notification('timed_out'));
    // 2026-11-19：旧实现回 delivered:true（投递其实还没发生）→ outbox 写 delivered_at、
    // 不再重试；若随后 sendText 抛错，这条推送永久消失。现在如实报「改期」（未送达、
    // 也没尝试）：不写 delivered_at、不消耗尝试次数。
    expect(whileTurn).toMatchObject({ delivered: false, deferred: true });
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'notification_push_deferred', reason: 'turn_active' }));

    // 回合结束（装配侧补一次投递驱动 = 再来一次 send）：送达，且只送达一次。
    turnActive = false;
    const afterTurn = await sink.send(notification('timed_out'));
    expect(afterTurn.delivered).toBe(true);
    expect(delivery.sent).toHaveLength(1);
  });

  it('⑥ 投递抛错向上抛（outbox 才能有界重试），并记 failed 事件', async () => {
    const delivery = fakeDelivery('live', 'throw');
    const { sink, events } = sinkOf({ delivery: delivery.port });
    await expect(sink.send(notification('timed_out'))).rejects.toThrow('渠道不可用');
    expect(events).toContainEqual(expect.objectContaining({ event: 'notification_push_failed' }));
    expect(events.some((e) => e['event'] === 'notification_push_sent')).toBe(false);
  });

  it('⑦ 组合 sink：一个失败不吞掉另一个，整体报告未送达', async () => {
    const ok: string[] = [];
    const composed = composeNotificationSinks([
      { async send() { ok.push('file'); return { delivered: true }; } },
      { async send() { throw new Error('push down'); } },
    ]);
    const result = await composed.send(notification('failed'));
    expect(ok).toEqual(['file']);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('push down');
  });

  it('⑦ 组合 sink：没有失败但有终态跳过 → 整体按跳过回执（跳过不合成「送达」）', async () => {
    const composed = composeNotificationSinks([
      { async send() { return { delivered: true }; } },
      { async send() { return { delivered: false, skipped: 'empty_after_strip' }; } },
    ]);
    const result = await composed.send(notification('timed_out'));
    expect(result).toMatchObject({ delivered: false, skipped: 'empty_after_strip' });
  });

  it('⑦ 组合 sink：全部送达才回 delivered（含「本 sink 不管这个 kind」的常态）', async () => {
    const composed = composeNotificationSinks([
      { async send() { return { delivered: true }; } },
      { async send() { return { delivered: true }; } },
    ]);
    expect((await composed.send(notification('completed'))).delivered).toBe(true);
  });
});
