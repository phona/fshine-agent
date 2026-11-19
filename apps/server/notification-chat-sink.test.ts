/**
 * 主动推送 sink（`notification-chat-sink.ts`）· 确定性单测（零网络、零真模型、零真平台）。
 *
 * 钉住的语义（每条都对应任务书里的一条纪律）：
 *   ① 只推 3 类（waiting_user/timed_out/resource_limited）；
 *      accepted/started/resumed/completed 一律不推（后者由结果正文投递负责）；
 *      failed 由失败唤醒出口负责；cancelled 走取消唤醒出口（渲染文案只作兜底）；
 *   ② 文案只来自 `renderNotification`（四类人话），过用户可见出口清理；
 *   ③ 非 live 不投递、只记 suppressed；读不到任务范围不猜路由；
 *   ④ 同回合已交给模型的一次性核销（不重复发同一条）；
 *   ⑤ 回合在跑时改期到回合之后（不抢先推）；
 *   ⑥ 投递抛错向上抛（outbox 才能有界重试），任务事实不动；
 *   ⑦ 组合 sink：文件审计与聊天推送各自独立，不互相吞噬。
 */
import { describe, expect, it } from 'vitest';
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import type { Notification, NotificationKind } from '../../packages/agent/src/notifications';
import {
  composeNotificationSinks,
  createChatNotificationSink,
  PUSHED_NOTIFICATION_KINDS,
} from './notification-chat-sink';

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
    // 2026-11-19 口径变更：failed 移出（失败由失败唤醒出口直发）；唤醒切片再把 cancelled
    // 移出（「用户说停」由取消唤醒出口说）——两者都不在直发清单里。
    expect([...PUSHED_NOTIFICATION_KINDS]).toEqual(['waiting_user', 'timed_out', 'resource_limited']);
  });

  it('① cancelled 不再由本 sink 渲染直发：交给取消唤醒出口说（事实带业务名；渲染文案只作兜底）', async () => {
    const delivery = fakeDelivery();
    const wakes: Array<{ taskId: string; principalId: string; sessionId: string; factText: string; fallbackText: string }> = [];
    const { sink, events } = sinkOf({
      delivery: delivery.port,
      wakeCancelled: async (input) => {
        wakes.push(input);
        return true;
      },
    });
    const result = await sink.send(notification('cancelled', { reason: 'cancelled_by_user' }));
    expect(result.delivered).toBe(true);
    // 事实唤醒给模型（业务名在内、不含句柄/内部码）；渲染文案降级为模型挂掉时的兜底。
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ taskId: 'task-1', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId });
    expect(wakes[0]!.factText).toContain('[已停止]');
    expect(wakes[0]!.factText).toContain('查应收账款');
    expect(wakes[0]!.fallbackText).toContain('已按你说的停了');
    // sink 自己不投那条渲染文案（用户看到的话由模型的唤醒回合给）。
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'notification_cancel_woken', result: 'handed_over' }));
  });

  it('① cancelled 走岔路：唤醒出口交不出话 → 如实记 not_delivered（不冒充已说、不自己补一条）', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port, wakeCancelled: async () => false });
    await sink.send(notification('cancelled', { reason: 'cancelled_by_user' }));
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'notification_cancel_woken', result: 'not_delivered' }));
  });

  it('① cancelled 未接唤醒出口 → 只记 suppressed（wake_unavailable），不直发渲染文案', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port });
    await sink.send(notification('cancelled', { reason: 'cancelled_by_user' }));
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'notification_push_suppressed',
      reason: 'wake_unavailable',
    }));
  });
});

describe('主动推送 sink：不投递的分支（suppressed，绝不记 sent）', () => {
  it('③ 非 live：零 sendText，记 deliveryMode=silent', async () => {
    const delivery = fakeDelivery('silent');
    const { sink, events } = sinkOf({ delivery: delivery.port });
    const result = await sink.send(notification('timed_out'));
    expect(result.delivered).toBe(true);
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'notification_push_suppressed',
      reason: 'delivery_unavailable',
      deliveryMode: 'silent',
    }));
    expect(events.some((e) => e['event'] === 'notification_push_sent')).toBe(false);
  });

  it('③ 没有投递面：同样只记 suppressed', async () => {
    const { sink, events } = sinkOf();
    await sink.send(notification('timed_out'));
    expect(events).toContainEqual(expect.objectContaining({ reason: 'delivery_unavailable', deliveryMode: 'unavailable' }));
  });

  it('③ 读不到任务范围：不猜路由', async () => {
    const delivery = fakeDelivery();
    const { sink, events } = sinkOf({ delivery: delivery.port, taskScope: () => undefined });
    await sink.send(notification('timed_out'));
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: 'task_scope_unresolved' }));
  });

  it('④ 同回合已交给模型：一次性核销，第二次不再核销', async () => {
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
    await sink.send(notification('timed_out'));
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ reason: 'relayed_in_turn' }));
    await sink.send(notification('timed_out'));
    expect(delivery.sent).toHaveLength(1);
  });
});

describe('主动推送 sink：时序与失败', () => {
  it('⑤ 会话有回合在跑 → 改期到回合之后（本次不阻塞、不抢先推）', async () => {
    const delivery = fakeDelivery();
    const deferredRuns: Array<() => Promise<void>> = [];
    const { sink, events } = sinkOf({
      delivery: delivery.port,
      deferWhileTurnActive: (_sessionKey, run) => {
        deferredRuns.push(run);
        return true;
      },
    });
    const result = await sink.send(notification('timed_out'));
    expect(result.delivered).toBe(true);
    expect(delivery.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ event: 'notification_push_deferred', reason: 'turn_active' }));
    await deferredRuns[0]!();
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
});
