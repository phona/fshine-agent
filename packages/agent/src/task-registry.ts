/**
 * 任务归属底账（B 类：任务归属，最小形状）。
 *
 * 为什么需要它：委派任务必须绑定发起它的可信身份与会话，事后按业务查询时，
 * 越权（换一个 principal/session）必须被确定性拒绝。可信身份来自装配层的
 * principalId/sessionId（配置与渠道事实），**不接受模型输入**。
 *
 * 这里不做的（登记缺口，不在这里预造）：
 *   · 任务级幂等键（dispatchKey）与"同键重复提交返回原任务"：最小入口没有重投/重放面
 *     （无渠道、无后台重投），接入渠道与重投的切片按最小形状补；
 *   · 取消 / 确认 / 恢复状态机：写与确认切片再定；本切片任务只有 running/completed/failed。
 *
 * 拒绝路径（回归锁，见 runtime.test.ts）：换 principal 或换 session 取任务
 * 一律 TaskOwnershipError；取不存在的任务与越权同一错误（不泄漏任务是否存在）。
 */
import type { ExecutionFailure, ExecutionStatus } from '@fshine/contracts/execution-contract';

export type TaskStatus = 'running' | 'completed' | 'failed';

/** 一次已发起的执行调用（requestId 由宿主持有，模型不可见）。 */
export interface ExecutionRecord {
  requestId: string;
  operation: string;
  status: ExecutionStatus;
  error?: ExecutionFailure;
}

/** 一条最小任务底账：归属 + 状态 + 结果文本 + 执行调用清单。 */
export interface TaskRecord {
  taskId: string;
  principalId: string;
  sessionId: string;
  /** 委派原文（任务请求；审计与结果解释用）。 */
  request: string;
  status: TaskStatus;
  resultText?: string;
  failureReason?: string;
  executions: readonly ExecutionRecord[];
  createdAt: string;
  updatedAt: string;
}

/** 任务归属校验失败：越权与不存在同一错误，不泄漏存在性。 */
export class TaskOwnershipError extends Error {
  constructor() {
    super('任务不存在或不属于当前会话。');
    this.name = 'TaskOwnershipError';
  }
}

export interface TaskScope {
  principalId: string;
  sessionId: string;
}

export interface TaskRegistry {
  begin(input: { taskId: string; principalId: string; sessionId: string; request: string }): TaskRecord;
  noteExecution(taskId: string, record: ExecutionRecord): void;
  complete(taskId: string, resultText: string): void;
  fail(taskId: string, reason: string): void;
  /** 按可信 scope 取任务：principalId 与 sessionId 都必须一致，否则 TaskOwnershipError。 */
  get(taskId: string, scope: TaskScope): TaskRecord;
  /** scope 缺省 = 全部任务；给出时只返回该 principal + session 的任务（不跨会话泄漏）。 */
  list(scope?: TaskScope): readonly TaskRecord[];
}

/** 库内可变形状：对外只读视图由 TaskRecord 承担。 */
interface MutableTaskRecord extends Omit<TaskRecord, 'executions'> {
  executions: ExecutionRecord[];
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, MutableTaskRecord>();
  const require = (taskId: string): MutableTaskRecord => {
    const task = tasks.get(taskId);
    if (!task) throw new TaskOwnershipError();
    return task;
  };
  const touch = (task: MutableTaskRecord): void => {
    task.updatedAt = new Date().toISOString();
  };
  return {
    begin(input) {
      const now = new Date().toISOString();
      const task: MutableTaskRecord = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        status: 'running',
        executions: [],
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.taskId, task);
      return task;
    },
    noteExecution(taskId, record) {
      const task = require(taskId);
      task.executions.push(record);
      touch(task);
    },
    complete(taskId, resultText) {
      const task = require(taskId);
      task.status = 'completed';
      task.resultText = resultText;
      touch(task);
    },
    fail(taskId, reason) {
      const task = require(taskId);
      task.status = 'failed';
      task.failureReason = reason;
      touch(task);
    },
    get(taskId, scope) {
      const task = tasks.get(taskId);
      if (!task || task.principalId !== scope.principalId || task.sessionId !== scope.sessionId) {
        throw new TaskOwnershipError();
      }
      return task;
    },
    list(scope) {
      const all = [...tasks.values()];
      if (scope === undefined) return all;
      return all.filter((task) => task.principalId === scope.principalId && task.sessionId === scope.sessionId);
    },
  };
}
