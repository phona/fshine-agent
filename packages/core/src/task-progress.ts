/**
 * 「任务仍在推进」的唯一判定（B 类存活事实；宿主 runtime / runner / 底账扫描共用）。
 *
 * 为什么收成一处（2026-11-23）：宿主里这个判定曾复制约 5 份、口径漂移——多数调用点只看
 * 「running_since 非空 + 四个结束时刻为空」，把**已汇报**（result_text/reply_text 已存档）
 * 与**回合失败收尾**（round_failed_at）的行仍当「在跑」/「在办」：
 *   · runtime 告诉模型「还有 N 件在办」，其中含已结束行；
 *   · runner 对失败回合已停的任务仍走「在跑」取消分支（写 cancel_requested_at）；
 *   · 过期租约扫描把已知失败（round_failed_at）改写成 died（结果未知）。
 * 本模块是唯一实现：TS 判定与 SQL WHERE 由**同一份列清单**派生，任何调用点只调这里。
 *
 * 口径（布尔判定，不是任务级状态词）：
 *   仍在推进 = 已启动（running_since 非空，或持有在跑租约，或末条执行 = accepted 在途——
 *   后两者沿用既有 liveness 口径）&& 无四个结束时刻（died/cancelled/timed_out/
 *   resource_limited）&& round_failed_at 为空（本轮已停）&& 无汇报存档（result_text 与
 *   reply_text 均空）&& 无等待形状（pending_question 为空）。
 * waiting_user 不算在跑（liveness 三值语义不变：running / died / waiting_user）。
 *
 * 落库 SQL 的「已启动」只认 running_since：真实 accepted 长任务受理时已写 running_since，
 * SQL 扫描面不需要（也不应该）为它加子查询。
 */

interface TaskStartFacts {
  runningSince?: string;
  /**
   * 在跑租约（认领/接续回合持有）。真实写入路径 armLease 总会同时写 running_since；这里
   * 仍把租约本身当「已启动」信号——liveness 既有口径就是「有效租约 → running」，旧行/夹具
   * 只有租约时不得因此被读成未启动。
   */
  leaseUntil?: string;
  /** 末条执行行（只判 status === 'accepted'；缺省 = 无执行行）。 */
  executions?: readonly { status: string }[];
}

interface TaskEndFacts {
  diedAt?: string;
  cancelledAt?: string;
  timedOutAt?: string;
  resourceLimitedAt?: string;
}

interface TaskReportFacts {
  resultText?: string;
  replyText?: string;
}

/** 存活判定的输入投影（内存 TaskRecord 与 SQLite 读回行同形）。 */
export interface TaskProgressFacts extends TaskStartFacts, TaskEndFacts, TaskReportFacts {
  /** 「本轮以无结果收尾」的一次性时刻：不是终局，只表示这一轮已停。 */
  roundFailedAt?: string;
  /** 等待形状（只判有无；waiting_user ≠ 在跑）。 */
  pendingQuestion?: unknown;
}

// ---------------------------------------------------------------------------
// 列清单（TS 字段名 ↔ SQL 列名同源）：结束事实 / 汇报存档 / 等待 / 启动只在这里列一次。
// 调用方（尤其 task-store 的 prepared statements）不得再手写 running_since + 结束列的组合。
// ---------------------------------------------------------------------------

/** 「这一轮开始跑」的列（NULL = 未启动）。 */
export const TASK_PROGRESS_STARTED_COLUMN = { key: 'runningSince', column: 'running_since' } as const;

/** 四个一次性结束时刻（任一非空 = 已收尾，事实不翻案）。 */
export const TASK_PROGRESS_END_FIELDS = [
  { key: 'diedAt', column: 'died_at' },
  { key: 'cancelledAt', column: 'cancelled_at' },
  { key: 'timedOutAt', column: 'timed_out_at' },
  { key: 'resourceLimitedAt', column: 'resource_limited_at' },
] as const;

/** 回合失败收尾（本轮已停；不是业务结论、不是终局）。 */
export const TASK_PROGRESS_ROUND_FAILED_FIELD = { key: 'roundFailedAt', column: 'round_failed_at' } as const;

/** 汇报存档列（两列均空才叫「没有汇报」）。 */
export const TASK_PROGRESS_REPORT_FIELDS = [
  { key: 'resultText', column: 'result_text' },
  { key: 'replyText', column: 'reply_text' },
] as const;

/** 等待形状列（waiting_user）；在跑扫描必须排除。 */
export const TASK_PROGRESS_WAITING_FIELD = { key: 'pendingQuestion', column: 'pending_question' } as const;

/** 任务已收尾（四个一次性机械时刻任一存在）。 */
export function taskEndedOf(task: TaskEndFacts): boolean {
  return TASK_PROGRESS_END_FIELDS.some((field) => task[field.key] !== undefined);
}

/** 汇报已存档（result_text / reply_text 任一非空 = 有汇报）。 */
export function taskReportedOf(task: TaskReportFacts): boolean {
  return TASK_PROGRESS_REPORT_FIELDS.some((field) => (task[field.key] ?? '').trim() !== '');
}

/**
 * 本轮已停（仍在推进的反面，**不含「等待用户」**）：四个结束时刻 / round_failed_at /
 * 汇报存档任一在场。等待中的任务不算「已停」——它还能接续/取消。
 */
export function taskProgressEndedOf(task: TaskEndFacts & TaskReportFacts & { roundFailedAt?: string }): boolean {
  return taskEndedOf(task)
    || task.roundFailedAt !== undefined
    || taskReportedOf(task);
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

/** 任务未启动（可被队列认领）：没跑过且无任何结束事实。 */
export function taskUnstartedOf(task: TaskStartFacts & TaskEndFacts): boolean {
  return task.runningSince === undefined && !taskEndedOf(task);
}

/**
 * SQL 片段（与 {@link stillProgressingOf} 同一份列清单派生）：
 * `running_since IS NOT NULL AND 结束列全 IS NULL AND 汇报列全空 AND pending_question IS NULL`。
 * 底账的「在跑」扫描（长时间提醒、过期租约、markDied 守卫）都拼这一段，不许手写。
 */
export function stillProgressingSqlWhere(): string {
  return [
    `${TASK_PROGRESS_STARTED_COLUMN.column} IS NOT NULL`,
    ...TASK_PROGRESS_END_FIELDS.map((field) => `${field.column} IS NULL`),
    `${TASK_PROGRESS_ROUND_FAILED_FIELD.column} IS NULL`,
    ...TASK_PROGRESS_REPORT_FIELDS.map((field) => `(${field.column} IS NULL OR ${field.column} = '')`),
    `${TASK_PROGRESS_WAITING_FIELD.column} IS NULL`,
  ].join(' AND ');
}
