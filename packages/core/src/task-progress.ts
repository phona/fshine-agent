/**
 * 任务事实的机械判定（B 类；宿主 runtime / runner / 底账扫描共用）。
 *
 * 不维护任务状态机（owner 2026-11-23）：task 只存事实——
 *   · 启动事实（running_since / 租约 / accepted 在途）；
 *   · 汇报存档（result_text / reply_text）；
 *   · 等待形状（pending_question + waiting_since）；
 *   · 执行账本（executions 每笔的 status，执行层契约事实）；
 *   · 一条「这一轮在 T 停下」的机械事实（task_ends，**不分类**：不存怎么结束）。
 * 没有 status，没有终止种类（cancelled/timed_out/resource_limited/died/round_failed/
 * completed），也没有 liveness 三值——「活/结束」由事实现推：
 *   仍在推进 = 已启动 && 无结束事实 && 无汇报存档 && 无等待形状；
 *   可能还活着（跨进程读者）= 仍在推进 && （租约未过期 || accepted 在途）；
 *   在跑（本进程）= 仍在推进 && 本进程有活 worker。
 * 本模块只回答这些**布尔事实**；任何「任务级生命周期枚举」都不在这里、也不在别处。
 *
 * 「怎么结束」不存：消费方读原始事实（汇报 / 执行行 / 活 worker / 等待形状）就地算。
 */

interface TaskStartFacts {
  runningSince?: string;
  /**
   * 在跑租约（认领/接续回合持有）。真实写入路径 armLease 总会同时写 running_since；这里
   * 仍把租约本身当「已启动」信号——旧行/夹具只有租约时不得因此被读成未启动。
   */
  leaseUntil?: string;
  /** 末条执行行（只判 status === 'accepted'；缺省 = 无执行行）。 */
  executions?: readonly { status: string }[];
}

interface TaskReportFacts {
  resultText?: string;
  replyText?: string;
}

/** 推进判定的输入投影（内存 TaskRecord 与 SQLite 读回行同形）。 */
export interface TaskProgressFacts extends TaskStartFacts, TaskReportFacts {
  /** 这一轮停下的机械时刻（追加事实账；没有种类）。在场 = 这一轮已停。 */
  endedAt?: string;
  /** 等待形状（只判有无；waiting_user ≠ 在跑）。 */
  pendingQuestion?: unknown;
}

// ---------------------------------------------------------------------------
// 列清单（TS 字段名 ↔ SQL 列名同源）：汇报存档 / 等待 / 启动只在这里列一次。
// 调用方（尤其 task-store 的 prepared statements）不得再手写 running_since + 结束列的组合。
// ---------------------------------------------------------------------------

/** 「这一轮开始跑」的列（NULL = 未启动）。 */
export const TASK_PROGRESS_STARTED_COLUMN = { key: 'runningSince', column: 'running_since' } as const;

/** 汇报存档列（两列均空才叫「没有汇报」）。 */
export const TASK_PROGRESS_REPORT_FIELDS = [
  { key: 'resultText', column: 'result_text' },
  { key: 'replyText', column: 'reply_text' },
] as const;

/** 等待形状列（waiting_user）；在跑扫描必须排除。 */
export const TASK_PROGRESS_WAITING_FIELD = { key: 'pendingQuestion', column: 'pending_question' } as const;

/** 「这一轮停下」事实账的表名（SQL 判据引用；不是 tasks 的列，也没有 kind 列）。 */
export const TASK_ENDS_TABLE = 'task_ends';

/** 结束事实的 SQL 列清单（表名 + 列名唯一来源）。 */
export const TASK_END_COLUMNS = {
  taskId: 'task_id',
  at: 'at',
} as const;

/** 任务已结束（结束事实在场）。 */
export function taskEndedOf(task: Pick<TaskProgressFacts, 'endedAt'>): boolean {
  return task.endedAt !== undefined;
}

/** 汇报已存档（result_text / reply_text 任一非空 = 有汇报）。 */
export function taskReportedOf(task: TaskReportFacts): boolean {
  return TASK_PROGRESS_REPORT_FIELDS.some((field) => (task[field.key] ?? '').trim() !== '');
}

/** 等待形状在场（pendingQuestion；等待可被下一进程接续，不是在跑）。 */
export function taskWaitingOf(task: Pick<TaskProgressFacts, 'pendingQuestion'>): boolean {
  return task.pendingQuestion !== undefined;
}

/**
 * 本轮已停（仍在推进的反面，**不含「等待用户」**）：结束事实或汇报存档任一在场。
 * 等待中的任务不算「已停」——它还能接续/取消。
 */
export function taskProgressEndedOf(task: Pick<TaskProgressFacts, 'endedAt'> & TaskReportFacts): boolean {
  return taskEndedOf(task) || taskReportedOf(task);
}

/**
 * 已启动：running_since 写入、持有在跑租约，或末条执行 = accepted 在途（后两者沿用既有
 * 长任务口径；真实写入路径租约会连带写 running_since）。
 */
export function taskStartedOf(task: TaskStartFacts & TaskReportFacts): boolean {
  return task.runningSince !== undefined
    || task.leaseUntil !== undefined
    || taskAcceptedInFlightOf(task);
}

/**
 * 长任务「已受理、等回执」：末条执行 = accepted 且**无汇报存档**（完成后只汇报、不追加
 * 执行行，末条仍可能是 accepted——有汇报即已收尾）。
 */
export function taskAcceptedInFlightOf(task: TaskStartFacts & TaskReportFacts): boolean {
  const executions = task.executions;
  if (executions === undefined || executions.length === 0) return false;
  if (executions[executions.length - 1]!.status !== 'accepted') return false;
  return !taskReportedOf(task);
}

/**
 * 唯一谓词：任务仍在推进（见文件头口径）。所有「在跑 / 在办 / 是否已停」判定都调这里；
 * 别处不得再手写 `running_since/runningSince 非空 && 结束事实为空` 的组合。
 */
export function stillProgressingOf(task: TaskProgressFacts): boolean {
  return taskStartedOf(task)
    && !taskProgressEndedOf(task)
    && !taskWaitingOf(task);
}

/**
 * 跨进程读者（CLI / ops）的「可能还活着」事实判定：仍在推进，且租约未过期或 accepted 在途。
 * 只回答布尔事实——不返回 running/died 之类的状态词；消费者按自己的展示需要就地组合。
 */
export function taskMayBeRunningOf(task: TaskProgressFacts, now: string = new Date().toISOString()): boolean {
  if (!stillProgressingOf(task)) return false;
  if (task.leaseUntil !== undefined) return task.leaseUntil > now;
  return taskAcceptedInFlightOf(task);
}

/** 任务未启动（可被队列认领）：没跑过且无结束事实。 */
export function taskUnstartedOf(task: TaskStartFacts & Pick<TaskProgressFacts, 'endedAt'>): boolean {
  return task.runningSince === undefined && !taskEndedOf(task);
}

/**
 * SQL 片段（与 {@link stillProgressingOf} 同一份列清单/事实账派生）：
 * `running_since IS NOT NULL AND 汇报列全空 AND pending_question IS NULL
 *  AND 无结束事实`。
 * 底账的「在跑」扫描（长时间提醒、过期租约、租约过期事实）都拼这一段，不许手写。
 * 结束事实用 `NOT EXISTS` 子查询读 task_ends（追加事实账），不是 tasks 的列。
 */
export function stillProgressingSqlWhere(): string {
  return [
    `${TASK_PROGRESS_STARTED_COLUMN.column} IS NOT NULL`,
    ...TASK_PROGRESS_REPORT_FIELDS.map((field) => `(${field.column} IS NULL OR ${field.column} = '')`),
    `${TASK_PROGRESS_WAITING_FIELD.column} IS NULL`,
    `NOT EXISTS (SELECT 1 FROM ${TASK_ENDS_TABLE} e WHERE e.${TASK_END_COLUMNS.taskId} = tasks.task_id)`,
  ].join(' AND ');
}
