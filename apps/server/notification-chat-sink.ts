/**
 * 后台任务状态的**主动推送**（B 类：任务事实到用户的如实交付；渠道无关的 sink，装配注入）。
 *
 * 为什么需要：outbox 已有 9 类意图 + 用户话术 + 有界重试，但 sink 一直写的是文件
 * （`notifications.jsonl`）——失败/等补充这类事，用户只有**下次开口**时才间接知道
 * （事实注入）。本模块把「用户必须知道、或必须做点什么」的那几类主动发回原会话。
 *
 * 纪律（与文件投递 / 完成投递同一套四必守）：
 *   · 只推 waiting_user / timed_out / resource_limited；accepted/started/resumed 是噪音
 *     （回合内回执已经说了），completed 由结果正文投递（`task-completion-delivery.ts`）
 *     负责——两边都推就是同一件事说两遍；failed 由失败唤醒出口负责（2026-11-19 唤醒切片）；
 *   · `cancelled`（用户说停）**不经本文件的渲染文案**直发：改走唤醒出口（`wakeCancelled`
 *     → 唤醒原会话模型说；模型说不出话才投渲染文案作兜底）——用户看到的话永远是模型说的；
 *   · 文案只复用 `renderNotification`（四类人话 + 内部术语黑名单），不新增一句话、不加编号；
 *   · 非 live 部署不投递，记 suppressed，**绝不记 sent**；
 *   · 同回合已交给模型的（受理窗口内落定的失败/等补充）不推：模型会自己转述；
 *   · 投递失败只记事件、由 outbox 有界重试，**不改任务事实**。
 *
 * 不做的：新表/新定时器/新配置键/第二套话术。
 */
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { renderNotification } from '../../packages/agent/src/notification-render';
import type { Notification, NotificationKind, NotificationSink } from '../../packages/agent/src/notifications';
import { stripServerPaths } from '../../packages/agent/src/server-paths';
import { routeFromSessionId, taskCancelledFactText } from './task-completion-delivery';

/**
 * 主动推送给用户的意图（其余种类按上面的职责划分不推）。
 *
 * 2026-11-19 口径变更：**failed 不再由本 sink 推**——后台任务失败的主动告知改由
 * `task-completion-delivery.ts` 的失败分支直发（failureMessageFor 话术模板，归类自底账执行
 * 事实的 code；不推 Worker 失败原文）。原因：renderNotification 的 failed 文案「没办成：<name>」
 * 与 failureMessageFor 的失败种类话术并存会双发；统一到失败出口后，本 sink 只留与完成/失败
 * 投递不重叠的等待/超时/忙。
 *
 * 2026-11-19 唤醒切片：`cancelled` 也移出本清单——用户说停不再由宿主渲染「已按你说的停了」，
 * 改由 {@link ChatNotificationSinkOptions.wakeCancelled} 唤醒模型说（渲染文案降级为兜底）。
 */
export const PUSHED_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'waiting_user',
  'timed_out',
  'resource_limited',
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
  /**
   * 「用户说停」出口（cancelled；2026-11-19 唤醒切片）：取消不再由本 sink 渲染直发——
   * 交给装配注入的统一状态变化唤醒出口（喂取消事实 → 唤醒原会话模型说 → 模型说不出话才投
   * `fallbackText`）。返回「用户可见的那句话是否已交出」。缺省 = 未接会话面：只记 suppressed，
   * **不冒充已说**（不投渲染文案——宿主的话只在「模型回合挂掉」时才有位置）。
   */
  wakeCancelled?(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    factText: string;
    fallbackText: string;
  }): Promise<boolean>;
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
      const isCancelled = notification.kind === 'cancelled';
      if (!isCancelled && !PUSHED_NOTIFICATION_KINDS.includes(notification.kind)) {
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
      // 渲染文案（唯一话术来源）也是 cancelled 的降级兜底：过用户可见出口清理。
      const renderedText = stripServerPaths(
        renderNotification({ kind: notification.kind, payload: notification.payload }),
      ).text;
      const run = async (): Promise<void> => {
        // 同回合已交给模型（快活失败/等补充）：模型会自己转述，不重复发一条。
        if (options.claimRelayedInTurn?.(sessionKey, notification.taskId) === true) {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'relayed_in_turn' });
          return;
        }
        // 用户说停：唤醒模型说（宿主只喂事实）；模型说不出话才投渲染文案（降级兜底）。
        // 非 live / 唤醒失败的事实留存与投递抑制记账由唤醒出口统一处置（同一套四必守）。
        if (isCancelled) {
          const wakeCancelled = options.wakeCancelled;
          if (wakeCancelled === undefined) {
            log({ event: 'notification_push_suppressed', ...tagged, reason: 'wake_unavailable' });
            return;
          }
          const handedOver = await wakeCancelled({
            taskId: notification.taskId,
            principalId: scope.principalId,
            sessionId: scope.sessionId,
            factText: taskCancelledFactText(
              notification.payload.name === undefined ? {} : { name: notification.payload.name },
            ),
            fallbackText: renderedText,
          });
          log({
            event: 'notification_cancel_woken',
            ...tagged,
            result: handedOver ? 'handed_over' : 'not_delivered',
          });
          return;
        }
        if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
          log({
            event: 'notification_push_suppressed',
            ...tagged,
            reason: 'delivery_unavailable',
            deliveryMode: delivery?.deliveryMode ?? 'unavailable',
          });
          return;
        }
        const route = routeFromSessionId(scope.sessionId);
        if (route === undefined) {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'route_unresolvable' });
          return;
        }
        // 剥完为空不投（空帧用户什么都收不到）。
        if (renderedText.trim() === '') {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'empty_after_strip' });
          return;
        }
        const sendText = delivery.sendText;
        try {
          const receipt = await sendText(route, renderedText);
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
