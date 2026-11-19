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
 *   · 同回合已交给模型的（受理窗口内落定的失败/等补充）不推：模型会自己转述；
 *   · 投递失败只记事件、由 outbox 有界重试，**不改任务事实**。
 *
 * 回执纪律（2026-11-19 投递真相切片）：**投出去了才记 delivered**。四类分支各有正确回执：
 *   · 没有东西要发 / 永不可能送达（非 live、读不到范围、路由拆不出、剥完为空）→
 *     `{delivered:false, skipped:'<reason>'}`：outbox 不写 delivered_at、不再重试（重试也没用），
 *     行留在未送达集合里可查——「跳过」不许被记成「送达」；
 *   · 会话此刻在跑回合（改期）→ `{delivered:false, deferred:true}`：**没尝试投递**（不算失败
 *     尝试、不消耗 attempts），不记 delivered——由 outbox 既有退避重试接管（装配侧回合结束后
 *     补一次投递驱动即送达）；
 *   · 本 sink 不负责的 kind（@see PUSHED_NOTIFICATION_KINDS）→ `{delivered:true}`：不是「跳过」
 *     也不是「送达」，这条通知由别的 sink（落盘审计）负责，本 sink 无事可做；
 *   · 同回合已交给模型（relayed_in_turn）→ `{delivered:true}`：用户已经听到了这句话（模型
 *     说的），用户级事实成立——不记 delivered 反而会把「已告知」误报成没人知道。
 *
 * 不做的：新表/新定时器/新配置键/第二套话术/第二套重试。
 */
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { renderNotification } from '../../packages/agent/src/notification-render';
import type {
  DeliveryReceipt as NotificationDeliveryReceipt,
  Notification,
  NotificationKind,
  NotificationSink,
  NotificationTerminalFact,
} from '../../packages/agent/src/notifications';
import { stripServerPaths } from '../../packages/agent/src/server-paths';
import { routeFromSessionId } from './task-completion-delivery';

/**
 * 主动推送给用户的意图（其余种类按上面的职责划分不推）。
 *
 * 2026-11-19 口径变更：**failed 不再由本 sink 推**——后台任务失败的主动告知改由
 * `task-completion-delivery.ts` 的失败投递分支直发（deliverTaskFailure + failureMessageFor
 * 话术模板，归类自底账执行事实的 code；不推 Worker 失败原文）。原因：renderNotification
 * 的 failed 文案「没办成：<name>」与 failureMessageFor 的失败种类话术并存会双发；统一到
 * 宿主模板后，本 sink 只留与完成/失败投递不重叠的等待/超时/忙/取消。
 */
export const PUSHED_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'waiting_user',
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
   * 该会话此刻是否有回合在跑（装配侧给出的事实）。true = 本次不投递（模型还在打字时不抢先
   * 推一条），回执按未送达交 outbox 既有退避重试——装配侧在回合结束后补一次投递驱动。
   * 缺省 = 无判据（照常投递）。
   */
  turnActive?(sessionKey: string): boolean;
  /** 本回合已交给模型的任务（一次性核销）：true = 不推。 */
  claimRelayedInTurn?(sessionKey: string, taskId: string): boolean;
  /** 结构化事件出口（不含结果正文与内部路径）。 */
  log(line: Record<string, unknown>): void;
}

/**
 * 组合多个 sink（文件审计 + 聊天推送）：各自独立成败，互不吞噬。
 * 回执取最「需要再动一次」的那个（任一 sink 的表态都算数）：
 *   ① 失败（delivered=false 且未声明跳过/改期，或抛错）→ 整体失败（outbox 有界退避重试）；
 *   ② 改期（deferred）→ 整体改期（不算尝试、不写 delivered_at，下一次投递驱动再来）；
 *   ③ 终态跳过（skipped）→ 整体跳过（不写 delivered_at、不再重试）；
 *   ④ 全都送达 → delivered。
 * 绝不把「跳过/改期」合成「送达」（旧实现就是这样把用户没收到的东西记成已送达的）。
 * 已送达的 sink 重复收到同一通知，幂等由 sink 自身保证。
 */
export function composeNotificationSinks(sinks: readonly NotificationSink[]): NotificationSink {
  return {
    async send(notification: Notification): Promise<NotificationDeliveryReceipt> {
      const results = await Promise.allSettled(sinks.map((sink) => sink.send(notification)));
      const failed = results.find(
        (result) => result.status === 'rejected'
          || (result.value.delivered === false && result.value.skipped === undefined && result.value.deferred !== true),
      );
      if (failed !== undefined) {
        if (failed.status === 'rejected') {
          return { delivered: false, error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason) };
        }
        return { delivered: false, error: failed.value.error ?? 'SINK_UNDELIVERED' };
      }
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<NotificationDeliveryReceipt> => result.status === 'fulfilled',
      );
      if (fulfilled.some((result) => result.value.deferred === true)) {
        return { delivered: false, deferred: true };
      }
      const skipped = fulfilled.find((result) => result.value.delivered === false);
      if (skipped !== undefined) {
        return {
          delivered: false,
          ...(skipped.value.skipped === undefined ? {} : { skipped: skipped.value.skipped }),
          ...(skipped.value.deliveryMode === undefined ? {} : { deliveryMode: skipped.value.deliveryMode }),
        };
      }
      return { delivered: true };
    },
  };
}

/**
 * 通知投递**终局**的日志行（2026-11-19 第 3 档接线；形状单源，ops/alerts 的 delivery_failed
 * 规则按 `result` 判——改这里必须同步 `alert-rules.ts` 的 `isDeliveryFailure`）。
 * 装配层（server）把它接到 outbox 的 `onTerminal` 上：一条通知未送达就进终局时落一条。
 */
export function notificationTerminalLogLine(terminal: NotificationTerminalFact): Record<string, unknown> {
  return {
    event: 'notification_delivery_terminal',
    taskId: terminal.taskId,
    kind: terminal.kind,
    notificationId: terminal.notificationId,
    result: terminal.outcome,
    attempts: terminal.attempts,
    reason: terminal.reason,
    // 部署模式事实（跳过回执带；exhausted 无此字段）：告警判据按 live+skipped 切。
    ...(terminal.deliveryMode === undefined ? {} : { deliveryMode: terminal.deliveryMode }),
  };
}

export function createChatNotificationSink(options: ChatNotificationSinkOptions): NotificationSink {
  const { log } = options;
  return {
    async send(notification: Notification): Promise<NotificationDeliveryReceipt> {
      const base = { taskId: notification.taskId, kind: notification.kind, notificationId: notification.id };
      if (!PUSHED_NOTIFICATION_KINDS.includes(notification.kind)) {
        // 本 sink 不负责这一类（落盘审计由另一个 sink 负责）：不是「跳过」也不是「送达」，
        // 本 sink 无事可做 → 回执 delivered（组合面按「各自该做的都做了」判）。
        log({ event: 'notification_push_skipped', ...base, reason: 'kind_not_pushed' });
        return { delivered: true };
      }
      // 部署模式事实（既有事实：装配注入的 deliveryMode；没有投递面 = unavailable）：
      // 随**跳过**回执带给 outbox/告警面——live 部署上出现跳过 = 渠道配置/路由配错，
      // 用户那边表现为「彻底收不到任何消息」，必须有人看见；silent/unavailable 是部署属性。
      const delivery = options.delivery;
      const deploymentMode = delivery?.deliveryMode ?? 'unavailable';
      const scope = options.taskScope(notification.taskId);
      if (scope === undefined) {
        // 读不到任务范围 = 路由不可知，重试也不会变（不猜路由）→ 终态跳过。
        log({ event: 'notification_push_suppressed', ...base, reason: 'task_scope_unresolved', deliveryMode: deploymentMode });
        return { delivered: false, skipped: 'task_scope_unresolved', deliveryMode: deploymentMode };
      }
      const sessionKey = `${scope.principalId}\u0000${scope.sessionId}`;
      const tagged = { ...base, principalId: scope.principalId, sessionId: scope.sessionId };
      if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
        // 部署属性（没有投递面 / 非 live）：永不可能送达 → 终态跳过；**绝不记 delivered**
        //（silent 闸会让用户的收件箱里什么都没有，记送达就是假账）。
        log({
          event: 'notification_push_suppressed',
          ...tagged,
          reason: 'delivery_unavailable',
          deliveryMode: deploymentMode,
        });
        return { delivered: false, skipped: 'delivery_unavailable', deliveryMode: deploymentMode };
      }
      const sendText = delivery.sendText;
      const run = async (): Promise<NotificationDeliveryReceipt> => {
        // 同回合已交给模型（快活失败/等补充）：模型会自己转述，不重复发一条。用户**已经听到**
        // 了这件事（由模型说出）——用户级事实成立，不能报成「没人知道」。
        if (options.claimRelayedInTurn?.(sessionKey, notification.taskId) === true) {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'relayed_in_turn' });
          return { delivered: true };
        }
        const route = routeFromSessionId(scope.sessionId);
        if (route === undefined) {
          // sessionId 形状拆不出路由：重试也不会变（不猜路由）→ 终态跳过。
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'route_unresolvable' });
          return { delivered: false, skipped: 'route_unresolvable', deliveryMode: deploymentMode };
        }
        // 文案来自渲染器（唯一话术来源）；过用户可见出口清理，剥完为空不投（空帧用户什么都
        // 收不到）——没有东西可发是终态（渲染是纯函数，重试还是空）→ 终态跳过。
        const text = stripServerPaths(renderNotification({ kind: notification.kind, payload: notification.payload })).text;
        if (text.trim() === '') {
          log({ event: 'notification_push_suppressed', ...tagged, reason: 'empty_after_strip' });
          return { delivered: false, skipped: 'empty_after_strip', deliveryMode: deploymentMode };
        }
        try {
          const receipt = await sendText(route, text);
          log({ event: 'notification_push_sent', ...tagged, parts: receipt.parts.length });
          return { delivered: true };
        } catch (error) {
          log({
            event: 'notification_push_failed',
            ...tagged,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
      if (options.turnActive?.(sessionKey) === true) {
        // 会话此刻在跑回合：本次不投递（不抢先推），回执按**改期**交出去——本次**没有尝试
        // 投递**，所以不算一次失败尝试、不写 delivered_at、不消耗 attempts；装配侧在回合结束
        // 后补一次投递驱动（既有 deliverPending），那一刻 turnActive 已为 false，推送即落地。
        log({ event: 'notification_push_deferred', ...tagged, reason: 'turn_active' });
        return { delivered: false, deferred: true };
      }
      return await run();
    },
  };
}
