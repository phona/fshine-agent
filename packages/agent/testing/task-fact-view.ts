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

/** 旧状态词投影（机械事实 → 词；只按键读事实，不做业务归类）。 */
export function taskStatusOf(task: TaskRecord): string {
  if (task.pendingQuestion !== undefined) return 'waiting_user';
  if (task.cancelledAt !== undefined) return 'cancelled';
  if (task.timedOutAt !== undefined) return 'timed_out';
  if (task.resourceLimitedAt !== undefined) return 'resource_limited';
  if (task.diedAt !== undefined) return 'failed';
  const executions = task.executions;
  if (executions.length > 0) {
    const last = executions[executions.length - 1];
    if (last !== undefined && (last.status === 'failed' || last.status === 'refused' || last.status === 'needs_input')) {
      return 'failed';
    }
    if (last !== undefined && last.status === 'accepted') return 'running';
    return 'completed';
  }
  // 零执行：有汇报存档 = 旧 unexecuted（零执行收尾）；否则按存活机械事实区分 queued/running。
  if ((task.resultText ?? task.replyText ?? '').trim() !== '') return 'unexecuted';
  if (task.runningSince === undefined) return 'queued';
  return 'running';
}

/** 旧原因词投影（机械时刻 / 执行行机械码）。 */
export function taskReasonOf(task: TaskRecord): string | undefined {
  if (task.cancelledAt !== undefined) return 'cancelled_by_user';
  if (task.timedOutAt !== undefined) return 'timeout';
  if (task.resourceLimitedAt !== undefined) return 'resource_limited';
  if (task.diedAt !== undefined) return 'result_unknown';
  const last = task.executions[task.executions.length - 1];
  if (last !== undefined && last.status === 'failed') {
    return last.error?.code === 'result_unknown' ? 'result_unknown' : 'failed_confirmed';
  }
  return undefined;
}

/** 旧失败原文投影（末条执行行的执行层 message；不存在即 undefined，不伪造）。 */
export function taskFailureReasonOf(task: TaskRecord): string | undefined {
  const last = task.executions[task.executions.length - 1];
  return last?.error?.message;
}
