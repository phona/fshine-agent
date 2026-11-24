/**
 * 底账机械事实 → 采集行（TaskFactLine / NotificationLine）。**只采集不判**。
 *
 * 为什么单独一个模块：business-e2e 的 model-executor 与 spread-axis/executor 各有一份
 * 逐字相同的「事件 → 事实增量」表。2026-11-24 grok blocking：终局事件改名
 * （cancelled/timed_out/resource_limited → user_stop/deadline_reached/capacity_blocked）
 * 后两份表都没跟上，未知事件走 `?? {}` 回落成 ended:false，取消/到点/容量拒绝被采集成
 * 「还没结束」，d6 的活跃峰值因此虚高（而 d6 单测自己手写 ended:true，不走这条映射，
 * 门禁全绿）。两份相同副本 = 同一个 bug 犯两次，所以收成一份。
 *
 * 守卫形状：表按 `TaskEventKind` **穷尽**声明——底账再改事件名，这里编译期就红，
 * 不像 `Record<string, …>` 那样静默回落。行为绊线见 `task-facts-collect.test.ts`
 * （走真 registry 的 markCancelled/markTimedOut/noteResourceRefused）。
 */
import type { TaskEventKind, TaskFact } from '../../../packages/agent/src/task-registry';
import { NOTIFICATION_KINDS } from '../../../packages/agent/src/notifications';
import type { NotificationLine, TaskFactLine } from './collect';

/** 事件 → 事实增量（布尔投影；缺省字段由 base 补）。 */
export const TASK_FACT_EVENTS: Readonly<Record<TaskEventKind, Partial<TaskFactLine>>> = {
  accepted: { started: false, ended: false, reported: false, waiting: false, mayBeRunning: false },
  started: { started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
  resumed: { started: true, waiting: false, mayBeRunning: true },
  waiting_user: { waiting: true, mayBeRunning: false },
  user_stop: { ended: true, mayBeRunning: false },
  deadline_reached: { ended: true, mayBeRunning: false },
  capacity_blocked: { ended: true, mayBeRunning: false },
  result_archived: { ended: true, reported: true, mayBeRunning: false },
  ended: { ended: true, mayBeRunning: false },
};

/** 底账一条机械事实 → 采集行（不含通知判定）。 */
export function taskFactLineOf(fact: TaskFact): TaskFactLine {
  const base: TaskFactLine = {
    ts: fact.at,
    taskId: fact.taskId,
    started: true,
    ended: false,
    reported: false,
    waiting: false,
    mayBeRunning: false,
  };
  return { ...base, ...(TASK_FACT_EVENTS[fact.event] ?? {}) };
}

/** 这条事实是否同时是一条用户可见通知（通知种类由产品侧单一来源定）。 */
export function isNotificationFact(event: string): boolean {
  return (NOTIFICATION_KINDS as readonly string[]).includes(event);
}

/** 通知行（种类照搬事件名；不合成任务级状态词）。 */
export function notificationLineOf(fact: TaskFact): NotificationLine {
  return { ts: fact.at, taskId: fact.taskId, kind: fact.event };
}
