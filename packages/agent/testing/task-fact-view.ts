/**
 * 测试专用：从底账机械事实推导「旧状态词」的只读视图（S1 事实模型）。
 *
 * 底账不再有 status/reason/failureReason 结论字段（S1 2026-11-22）；测试若要断言
 * 「做没做成」，只能读机械事实（等待形状、四个一次性时刻、汇报存档、逐笔执行行）。
 * 本模块把这些事实机械投影成旧词，**仅供既有测试用例迁移期复用**——它不参与产品代码，
 * 也不把任何结论写回底账。产品消费方一律直接读 taskStateWordOf / 执行行。
 *
 * 投影口径对齐旧 judgeReportedTask（以逐笔执行行为准，不嗅探汇报文本；零执行 = unexecuted）。
 */
import type { TaskRecord } from '../src/task-registry';

/**
 * 决定性执行行（inline judgeReportedTask 口径）：以**末条**执行事实为准；末条是**成功的**
 * run_js 宿主脚本时，回到此前最后一条非脚本执行事实（成功脚本不盖失败的写/待补充）；末条是
 * 失败脚本仍按末条决定（「查询成功 + 脚本失败 → failed」是冻结用例）。
 * **例外（旧后台 lastWritable 口径）**：本回合已有 completed 的**业务写**（非只读、非脚本）
 * 时，脚本失败不改写业务终局（adversarial-worker ⑪：已落库的写不得被脚本失败翻成失败）；
 * 只读集合由调用方按装配声明传入（缺省空 = 不区分，⑪ 显式传 READ_ONLY）。
 */
function decisiveExecutionOf(
  task: TaskRecord,
  /** 装配声明的只读集合；undefined = 调用方没给（inline judge 口径：脚本失败仍按末条决定）。 */
  readOnlyOperations?: ReadonlySet<string>,
): TaskRecord['executions'][number] | undefined {
  const executions = task.executions;
  const last = executions[executions.length - 1];
  if (last === undefined) return undefined;
  if (last.operation === 'run_js' && last.status === 'completed') {
    return [...executions].reverse().find((entry) => entry.operation !== 'run_js') ?? last;
  }
  if (readOnlyOperations !== undefined
    && last.operation === 'run_js'
    && (last.status === 'failed' || last.status === 'refused')) {
    const completedWrite = [...executions].reverse().find(
      (entry) => entry.operation !== 'run_js'
        && !readOnlyOperations.has(entry.operation)
        && entry.status === 'completed',
    );
    if (completedWrite !== undefined) return completedWrite;
  }
  return last;
}

/** 旧状态词投影（机械事实 → 词；只按键读事实，不做业务归类）。 */
export function taskStatusOf(task: TaskRecord, readOnlyOperations?: readonly string[]): string {
  // 一次性结束事实先于等待形状（超时/取消落定后 pendingQuestion 可能仍在底账：结束事实不翻案）。
  if (task.cancelledAt !== undefined) return 'cancelled';
  if (task.timedOutAt !== undefined) return 'timed_out';
  if (task.resourceLimitedAt !== undefined) return 'resource_limited';
  if (task.diedAt !== undefined) return 'failed';
  if (task.pendingQuestion !== undefined) return 'waiting_user';
  const decisive = decisiveExecutionOf(task, readOnlyOperations === undefined ? undefined : new Set(readOnlyOperations));
  if (decisive !== undefined) {
    if (decisive.status === 'failed' || decisive.status === 'refused' || decisive.status === 'needs_input') {
      return 'failed';
    }
    if (decisive.status === 'accepted') {
      // 长任务：accepted 执行行 + 已存档汇报 = 已收尾（无新执行行，等待回执后 Worker 只汇报）；
      // 仍在等回执（无汇报）→ running。
      return (task.resultText ?? task.replyText ?? '').trim() !== '' ? 'completed' : 'running';
    }
    return 'completed';
  }
  // 零执行：有汇报存档 = 旧 unexecuted（零执行收尾）；有租约 = 仍在跑；否则「已启动但无汇报收尾」= failed
  //（无汇报的空回合 / 抛错 / 崩溃；与产品 taskStateWordOf 的 failed 同口径）。
  if ((task.resultText ?? task.replyText ?? '').trim() !== '') return 'unexecuted';
  if (task.leaseUntil !== undefined) return 'running';
  if (task.runningSince === undefined) return 'queued';
  return 'failed';
}

/** 旧原因词投影（机械时刻 / 决定性执行行机械码）。 */
export function taskReasonOf(task: TaskRecord, readOnlyOperations?: readonly string[]): string | undefined {
  if (task.cancelledAt !== undefined) return 'cancelled_by_user';
  if (task.timedOutAt !== undefined) return 'timeout';
  if (task.resourceLimitedAt !== undefined) return 'resource_limited';
  if (task.diedAt !== undefined) return 'result_unknown';
  const decisive = decisiveExecutionOf(task, readOnlyOperations === undefined ? undefined : new Set(readOnlyOperations));
  if (decisive !== undefined && decisive.status === 'failed') {
    return decisive.error?.code === 'result_unknown' ? 'result_unknown' : 'failed_confirmed';
  }
  return undefined;
}

/** 旧失败原文投影（决定性执行行的执行层 message；不存在即 undefined，不伪造）。 */
export function taskFailureReasonOf(task: TaskRecord, readOnlyOperations?: readonly string[]): string | undefined {
  return decisiveExecutionOf(task, readOnlyOperations === undefined ? undefined : new Set(readOnlyOperations))?.error?.message;
}
