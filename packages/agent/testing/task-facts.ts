/**
 * 测试/评测专用：任务账本的**原始事实**读取器（S1 事实模型）。
 *
 * 底账没有 status/outcome。这里只机械读出账本事实，不做任何投影、不合成状态词：
 *   · liveness（宿主守护状态，唯一保留的三值：running / died / waiting_user）；
 *   · 逐笔执行行原值（operation / status / error）——做没做成读执行行；
 *   · worker 汇报存档（resultText / replyText 原文）；
 *   · 终止事件（cancelled/timed_out/resource_limited/died/round_failed/completed；追加事件账）。
 *
 * 判据用法：断言账本事实（执行行 status、终止事件 kind、汇报非空），或断言 liveness 三值；
 * 不再有「把事实投影成一个状态词」的中间层。
 */
import type { TaskRecord, TaskTermination } from '../src/task-registry';
import { taskEndedOf, taskLivenessOf, taskReportedOf, taskUnstartedOf } from '../src/task-registry';

export { taskEndedOf, taskLivenessOf, taskReportedOf, taskUnstartedOf };

export type TaskLiveness = NonNullable<ReturnType<typeof taskLivenessOf>>;

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
 * 任务账本的**机械事实视图**（无任务级状态词）：存活三值 + 一次收尾/取消/汇报事实 + 末条执行行原值。
 * 供评测证据快照与 R6 oracle 消费；不合成任何「任务状态词」。
 */
export interface TaskFactView {
  liveness: TaskLiveness | null;
  ended: boolean;
  cancelled: boolean;
  died: boolean;
  timedOut: boolean;
  resourceLimited: boolean;
  reported: boolean;
  lastExecutionStatus?: string;
}

/** 账本记录 → 机械事实视图（纯函数；liveness 由 {@link taskLivenessOf} 推导）。 */
export function taskFactViewOf(task: {
  leaseOwner?: string;
  leaseUntil?: string;
  runningSince?: string;
  termination?: TaskTermination;
  pendingQuestion?: unknown;
  executions?: readonly { status: string }[];
  resultText?: string;
  replyText?: string;
}): TaskFactView {
  const last = lastExecutionOf(task)?.status;
  return {
    liveness: taskLivenessOf(task) ?? null,
    ended: taskEndedOf(task) || taskReportedOf(task) || (last !== undefined && ['completed', 'failed', 'refused'].includes(last)),
    cancelled: task.termination?.kind === 'cancelled',
    died: task.termination?.kind === 'died',
    timedOut: task.termination?.kind === 'timed_out',
    resourceLimited: task.termination?.kind === 'resource_limited',
    reported: taskReportedOf(task),
    ...(last === undefined ? {} : { lastExecutionStatus: last }),
  };
}
