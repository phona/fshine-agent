/**
 * 「任务仍在推进」的唯一判定（B 类存活事实；宿主 runtime / runner / 底账扫描共用）。
 *
 * 零状态（owner 2026-11-23）：task 不存任何「状态」列——只有事实：
 *   · 启动事实（started_at / 租约 / accepted 在途）；
 *   · 汇报存档（result_text / reply_text）；
 *   · 等待形状（pending_question）；
 *   · 终止事件（task_events 追加事件账：cancelled / timed_out / resource_limited / died /
 *     round_failed / completed）——「怎么结束」的唯一持久来源，不可变。
 *
 * 「活/结束」由事实现推（见 registry 的 taskLivenessOf）；本模块只回答「还在推进吗」：
 *   仍在推进 = 已启动 && 无终止事件 && 无汇报存档 && 无等待形状。
 * 这是布尔事实判定，不是任务级状态词。SQL 与 TS 由同一份列清单/事件清单派生，任何调用点
 * 只调这里，别处不得再手写 `running_since + 结束列` 的组合。
 */

/** 终止事件种类（「怎么结束」；追加事件账的唯一词表）。 */
export const TASK_TERMINATION_KINDS = [
  'cancelled',
  'timed_out',
  'resource_limited',
  'died',
  'round_failed',
  'completed',
] as const;

export type TaskTerminationKind = (typeof TASK_TERMINATION_KINDS)[number];

/** 一条终止事实（追加事件；不可变）。 */
export interface TaskTermination {
  kind: TaskTerminationKind;
  at: string;
}

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

/** 存活/推进判定的输入投影（内存 TaskRecord 与 SQLite 读回行同形）。 */
export interface TaskProgressFacts extends TaskStartFacts, TaskReportFacts {
  /** 最近终止事件（追加事件账；不是列）。在场 = 这一轮已结束。 */
  termination?: TaskTermination;
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

/** 终止事件账的表名（SQL 判据引用；不是 tasks 的列）。 */
export const TASK_TERMINATIONS_TABLE = 'task_events';

/** 终止事件的 SQL 列清单（表名 + 列名唯一来源）。 */
export const TASK_TERMINATION_COLUMNS = {
  taskId: 'task_id',
  kind: 'kind',
  at: 'at',
} as const;

/** 任务已结束（终止事件在场）。 */
export function taskEndedOf(task: Pick<TaskProgressFacts, 'termination'>): boolean {
  return task.termination !== undefined;
}

/** 汇报已存档（result_text / reply_text 任一非空 = 有汇报）。 */
export function taskReportedOf(task: TaskReportFacts): boolean {
  return TASK_PROGRESS_REPORT_FIELDS.some((field) => (task[field.key] ?? '').trim() !== '');
}

/**
 * 本轮已停（仍在推进的反面，**不含「等待用户」**）：终止事件或汇报存档任一在场。
 * 等待中的任务不算「已停」——它还能接续/取消。
 */
export function taskProgressEndedOf(task: Pick<TaskProgressFacts, 'termination'> & TaskReportFacts): boolean {
  return taskEndedOf(task) || taskReportedOf(task);
}

/**
 * 已启动：running_since 写入、持有在跑租约，或末条执行 = accepted 在途（后两者沿用既有
 * liveness / 长任务口径；真实写入路径租约会连带写 running_since）。
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
    && task.pendingQuestion === undefined;
}

/** 任务未启动（可被队列认领）：没跑过且无终止事件。 */
export function taskUnstartedOf(task: TaskStartFacts & Pick<TaskProgressFacts, 'termination'>): boolean {
  return task.runningSince === undefined && !taskEndedOf(task);
}

/**
 * SQL 片段（与 {@link stillProgressingOf} 同一份列清单/事件清单派生）：
 * `running_since IS NOT NULL AND 汇报列全空 AND pending_question IS NULL
 *  AND 无终止事件`。
 * 底账的「在跑」扫描（长时间提醒、过期租约、markDied 守卫）都拼这一段，不许手写。
 * 终止事件用 `NOT EXISTS` 子查询读 task_events（追加事件账），不是 tasks 的列。
 */
export function stillProgressingSqlWhere(): string {
  return [
    `${TASK_PROGRESS_STARTED_COLUMN.column} IS NOT NULL`,
    ...TASK_PROGRESS_REPORT_FIELDS.map((field) => `(${field.column} IS NULL OR ${field.column} = '')`),
    `${TASK_PROGRESS_WAITING_FIELD.column} IS NULL`,
    `NOT EXISTS (SELECT 1 FROM ${TASK_TERMINATIONS_TABLE} e WHERE e.${TASK_TERMINATION_COLUMNS.taskId} = tasks.task_id)`,
  ].join(' AND ');
}
