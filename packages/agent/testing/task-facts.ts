/**
 * 测试/评测专用：任务账本的**原始事实**读取器。
 *
 * 不维护任务状态机：底账没有 status，也没有任务级生命周期枚举。这里只机械读出账本事实，
 * 不做任何投影、不合成状态词：
 *   · 启动 / 结束 / 汇报 / 等待 / 可能还在跑——布尔事实（@fshine/core task-progress 同源）；
 *   · 逐笔执行行原值（operation / status / error）——做没做成读执行行；
 *   · worker 汇报存档（resultText / replyText 原文）。
 *
 * 判据用法：断言账本事实（执行行 status、汇报非空、结束事实在场 / 不在场），
 * 不再有「把事实投影成一个状态词」的中间层。
 */
import type { TaskRecord } from '../src/task-registry';
import {
  taskEndedOf,
  taskMayBeRunningOf,
  taskProgressEndedOf,
  taskReportedOf,
  taskStartedOf,
  taskUnstartedOf,
  taskWaitingOf,
} from '../src/task-registry';

export {
  taskEndedOf,
  taskMayBeRunningOf,
  taskProgressEndedOf,
  taskReportedOf,
  taskStartedOf,
  taskUnstartedOf,
  taskWaitingOf,
};

/** 执行行的事实读取面（真执行行带 requestId/operation；测试最小形状也可）。 */
export interface ExecutionFactRow {
  status: string;
  operation?: string;
  requestId?: string;
  error?: { code?: string; message?: string };
}

/** 逐笔执行行（原值；追加序）。 */
export function executionsOf(task: { executions?: readonly ExecutionFactRow[] }): readonly ExecutionFactRow[] {
  return task.executions ?? [];
}

/** 末条执行行（原值；无执行行 = undefined）。 */
export function lastExecutionOf(task: { executions?: readonly ExecutionFactRow[] }): ExecutionFactRow | undefined {
  const executions = task.executions;
  return executions === undefined ? undefined : executions[executions.length - 1];
}

/** 最后一条失败/拒绝执行行（原值；无则 undefined）——机械事实，不做业务归类。 */
export function lastFailureOf(task: { executions?: readonly ExecutionFactRow[] }): ExecutionFactRow | undefined {
  const executions = task.executions;
  if (executions === undefined) return undefined;
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const row = executions[index]!;
    if (row.status === 'failed' || row.status === 'refused') return row;
  }
  return undefined;
}

/** worker 汇报存档原文（resultText ?? replyText；空白 = undefined）。 */
export function archivedReportOf(task: Pick<TaskRecord, 'resultText' | 'replyText'>): string | undefined {
  const report = (task.resultText ?? task.replyText ?? '').trim();
  return report === '' ? undefined : report;
}

/**
 * 任务账本的**事实视图**（无任务级状态词）：启动/结束/汇报/等待/可能还在跑 + 末条执行行原值。
 * 供评测证据快照与 oracle 消费；不合成任何「任务状态词」。
 */
export interface TaskFactView {
  started: boolean;
  ended: boolean;
  reported: boolean;
  waiting: boolean;
  /** 跨进程读者的事实代理：仍在推进 + 租约未过期或 accepted 在途（不是状态词）。 */
  mayBeRunning: boolean;
  lastExecutionStatus?: string;
}

/** 账本记录 → 事实视图（纯函数；布尔事实由 @fshine/core task-progress 同源派生）。 */
export function taskFactViewOf(task: {
  leaseOwner?: string;
  leaseUntil?: string;
  runningSince?: string;
  endedAt?: string;
  pendingQuestion?: unknown;
  executions?: readonly { status: string }[];
  resultText?: string;
  replyText?: string;
}, now: string = new Date().toISOString()): TaskFactView {
  const last = lastExecutionOf(task)?.status;
  return {
    started: taskStartedOf(task),
    ended: taskEndedOf(task) || taskReportedOf(task),
    reported: taskReportedOf(task),
    waiting: taskWaitingOf(task),
    mayBeRunning: taskMayBeRunningOf(task, now),
    ...(last === undefined ? {} : { lastExecutionStatus: last }),
  };
}
