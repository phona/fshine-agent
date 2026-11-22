/**
 * 评测本地观察词表（不是产品状态）。
 *
 * 评测/审计 harness（R6 oracle、business-e2e、convergence T1 证据）沿用一套离散观察词，
 * 这里把账本**机械事实**映射成该词表，供证据快照与机械判据使用；产品面没有这个投影
 * （task_status/task_result 只读 liveness + 账本事实）。
 *
 * 口径（机械、不读自由文本）：结束时刻 > 等待形状 > 汇报存档 > 在跑/未启动。
 */
export interface ObservedTaskFacts {
  pendingQuestion?: unknown;
  cancelledAt?: string;
  timedOutAt?: string;
  resourceLimitedAt?: string;
  diedAt?: string;
  resultText?: string;
  replyText?: string;
  runningSince?: string;
  leaseUntil?: string;
  executions?: readonly { status: string }[];
}

export function observedTaskStatusOf(task: ObservedTaskFacts): string {
  if (task.cancelledAt !== undefined) return 'cancelled';
  if (task.timedOutAt !== undefined) return 'timed_out';
  if (task.resourceLimitedAt !== undefined) return 'resource_limited';
  if (task.diedAt !== undefined) return 'failed';
  if (task.pendingQuestion !== undefined) return 'waiting_user';
  const last = task.executions?.[task.executions.length - 1];
  if (last !== undefined) {
    if (last.status === 'failed' || last.status === 'refused' || last.status === 'needs_input') return 'failed';
    if (last.status === 'accepted') return (task.resultText ?? task.replyText ?? '').trim() !== '' ? 'completed' : 'running';
    return 'completed';
  }
  if ((task.resultText ?? task.replyText ?? '').trim() !== '') return 'completed';
  if (task.leaseUntil !== undefined) return 'running';
  if (task.runningSince === undefined) return 'queued';
  return 'failed';
}
