/**
 * 后台任务状态的**主动推送**（B 类：任务事实到用户的如实交付；渠道无关的 sink，装配注入）。
 *
 * 为什么需要：outbox 已有 9 类意图 + 用户话术 + 有界重试，但 sink 一直写的是文件
 * （`notifications.jsonl`）——失败/等补充这类事，用户只有**下次开口**时才间接知道
 * （事实注入）。本模块把「用户必须知道、或必须做点什么」的那几类主动发回原会话。
 *
 * 纪律（与文件投递 / 完成投递同一套四必守）：
 *   · 只推 waiting_user / failed / timed_out / resource_limited / cancelled；
 *     accepted/started/resumed 是噪音（回合内回执已经说了），completed 由结果正文投递
 *     （`task-completion-delivery.ts`）负责——两边都推就是同一件事说两遍；
 *   · 文案只复用 `renderNotification`（四类人话 + 内部术语黑名单），不新增一句话、不加编号；
 *   · 非 live 部署不投递，记 suppressed，**绝不记 sent**；
 *   · 同回合已交给模型的（1.5 秒窗口内的失败/等补充）不推：模型会自己转述；
 *   · 投递失败只记事件、由 outbox 有界重试，**不改任务事实**。
 *
 * 不做的：新表/新定时器/新配置键/第二套话术。
 */
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { renderNotification } from '../../packages/agent/src/notification-render';
import type { Notification, NotificationKind, NotificationSink } from '../../packages/agent/src/notifications';
import { stripServerPaths } from '../../packages/agent/src/server-paths';
import { routeFromSessionId } from './task-completion-delivery';

/** 主动推送给用户的意图（其余种类按上面的职责划分不推）。 */
export const PUSHED_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'waiting_user',
  'failed',
  'timed_out',
  'resource_limited',
  'cancelled',
];

/** 宿主主动投递面（与完成投递同一端口形状；文字只要求 sendText）。 */
export interface ChatPushDeliveryPort {
  readonly deliveryMode: 'live' | 'silent';
  sendText?(route: ChannelRoute, text: string): Promise<DeliveryReceipt>;
}

export interface ChatNotificationSinkOptions {
  /** 任务底账 → 投递范围（principal/session）。读不到返回 undefined（不猜路由）。 */
  taskScope(taskId: string): { principalId: string; sessionId: string } | undefined;
  /** 主动投递面；缺省 = 无投递面（按 suppressed 记账，绝不记 sent）。 */
  delivery?: ChatPushDeliveryPort;
  /**
   * 回合内改期：该会话此刻有回合在跑时，把这次推送排到回合之后并返回 true
   * （装配侧因此不阻塞 outbox；模型还在打字时不抢先推一条）。
   */
  deferWhileTurnActive?(sessionKey: string, run: () => Promise<void>): boolean;
  /** 本回合已交给模型的任务（一次性核销）：true = 不推。 */
  claimRelayedInTurn?(sessionKey: string, taskId: string): boolean;
  /** 结构化事件出口（不含结果正文与内部路径）。 */
  log(line: Record<string, unknown>): void;
}

/**
 * 组合多个 sink（文件审计 + 聊天推送）：各自独立成败，互不吞噬。
 * 任一未送达 → 整体未送达（outbox 会重试；已送达的 sink 重复收到同一通知，幂等由 sink 自身保证）。
 */
export function composeNotificationSinks(sinks: readonly NotificationSink[]): NotificationSink {
  return {
    async send(notification: Notification): Promise<{ delivered: boolean; error?: string }> {
      const results = await Promise.allSettled(sinks.map((sink) => sink.send(notification)));
      const failed = results.find((result) => result.status === 'rejected' || result.value.delivered === false);
      if (failed === undefined) return { delivered: true };
      if (failed.status === 'rejected') {
        return { delivered: false, error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason) };
      }
      return { delivered: false, error: failed.value.error ?? 'SINK_UNDELIVERED' };
    },
  };
}

export function createChatNotificationSink(options: ChatNotificationSinkOptions): NotificationSink {
  const { log } = options;
  return {
    async send(notification: Notification): Promise<{ delivered: boolean; error?: string }> {
      const base = { taskId: notification.taskId, kind: notification.kind, notificationId: notification.id };
      if (!PUSHED_NOTIFICATION_KINDS.includes(notification.kind)) {
        log({ event: 'notification_push_skipped', ...base, reason: 'kind_not_pushed' });
        return { delivered: true };
      }
      const scope = options.taskScope(notification.taskId);
      if (scope === undefined) {
        log({ event: 'notification_push_suppressed', ...base, reason: 'task_scope_unresolved' });
        return { delivered: true };
      }
      const sessionKey = `${scope.principalId}\u0000${scope.sessionId}`;
      const tagged = { ...base, principalId: scope.principalId, sessionId: scope.sessionId };
      const delivery = options.delivery;
      if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
        log({
          event: 'notification_push_suppressed',
          ...tagged,
          reason: 'delivery_unavailable',
          deliveryMode: delivery?.deliveryMode ?? 'unavailable',
        });
        return { delivered: true };
      }
      const sendText = delivery.sendText;
      const run = async (): Promise<void> => {
        // 同回合已交给模型（快活失败/等补充）：模型会自己转述，不重复发一条。
        if (options.claimRelayedInTurn?.(sessionKey, notification.taskId) === true) {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'relayed_in_turn' });
          return;
        }
        const route = routeFromSessionId(scope.sessionId);
        if (route === undefined) {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'route_unresolvable' });
          return;
        }
        // 文案来自渲染器（唯一话术来源）；过用户可见出口清理，剥完为空不投（空帧用户什么都收不到）。
        const text = stripServerPaths(renderNotification({ kind: notification.kind, payload: notification.payload })).text;
        if (text.trim() === '') {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'empty_after_strip' });
          return;
        }
        try {
          const receipt = await sendText(route, text);
          log({ event: 'notification_push_sent', ...tagged, parts: receipt.parts.length });
        } catch (error) {
          log({
            event: 'notification_push_failed',
            ...tagged,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
      if (options.deferWhileTurnActive?.(sessionKey, run) === true) {
        log({ event: 'notification_push_deferred', ...tagged, reason: 'turn_active' });
        return { delivered: true };
      }
      await run();
      return { delivered: true };
    },
  };
}
