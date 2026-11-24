/**
 * 底账事实读数（交付面/兜底面用；**不读任何「怎么结束」种类**）。
 *
 * 为什么单独一个模块：这个读数原来死在 `createServer` 的闭包里，没有任何用例能碰它——
 * 2026-11-24 grok minor 就是从这里漏过去的：`waiting` 只看了 `pendingQuestion`、没看结束事实，
 * 于是「已取消/租约过期但还留着提案」的行被算成等待，`resultUnknown` 被压掉、
 * `taskFailureFactOf` 返回 undefined，而 `ended`（租约过期）不在 NOTIFICATION_KINDS 里、
 * 没有通知面兜它——那一支**没有任何人告诉用户「结果未知」**。抽成纯函数才有绊线可钉。
 *
 * 判据单一来源：`waiting` 直接用 `@fshine/core` 的 `taskWaitingOf`（提问在场且本轮未停），
 * 不在这里另写一遍——结束事实故意不清 `pending_question`（提案的句柄/摘要/写入参数只在它上面），
 * 「可不可答」由谓词的 `endedAt === undefined` 决定，不是靠删数据。
 */
import { taskWaitingOf } from '@fshine/core';
import { taskReportedOf, taskStartedOf } from '../../packages/agent/testing/task-facts';

/** 读数所需的底账行字段（结构形状；registry.get 的返回值满足它）。 */
export interface TaskFactRecord {
  runningSince?: string;
  leaseUntil?: string;
  pendingQuestion?: unknown;
  endedAt?: string;
  executions?: readonly { status: string }[];
  resultText?: string;
  replyText?: string;
}

export interface TaskFactReading {
  started: boolean;
  reported: boolean;
  waiting: boolean;
  liveWorker: boolean;
  /** 已启动、无汇报、不在等待、本进程没有活 worker、且没有确定的执行事实。 */
  resultUnknown: boolean;
}

/** 确定的执行事实（末条 failed/refused/completed 都是可读结果，按执行事实归类）。 */
function hasDefiniteExecution(record: TaskFactRecord): boolean {
  const last = record.executions?.[record.executions.length - 1]?.status;
  return last === 'failed' || last === 'refused' || last === 'completed';
}

export function taskFactReadingOf(record: TaskFactRecord, liveWorker: boolean): TaskFactReading {
  const started = taskStartedOf(record);
  const reported = taskReportedOf(record);
  const waiting = taskWaitingOf({ pendingQuestion: record.pendingQuestion, endedAt: record.endedAt });
  return {
    started,
    reported,
    waiting,
    liveWorker,
    resultUnknown: started && !reported && !waiting && !liveWorker && !hasDefiniteExecution(record),
  };
}
