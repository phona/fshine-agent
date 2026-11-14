/**
 * 任务归属底账（B 类：任务归属，最小形状）。
 *
 * 为什么需要它：委派任务必须绑定发起它的可信身份与会话，事后按业务查询时，
 * 越权（换一个 principal/session）必须被确定性拒绝。可信身份来自装配层的
 * principalId/sessionId（配置与渠道事实），**不接受模型输入**。
 *
 * P1 底账演化（最小增量，豁免零新增机制——数字 ID/名称/回复存档是任务书点名的确定性责任）：
 *   · taskNo：数字任务编号（由 SQLite 底账单条 SQL 原子分配；内存实现同口径自增）；
 *   · name：业务名称 v1 = 机械回落 deriveTaskName(request)（零模型；来源=任务交办原文，
 *     与迁移回填/显示回落同规则；#4-a 模型命名递延，不改 run_task 工具 schema）；
 *   · replyText：Main 本回合最终回复（send 收尾后 archiveReply 同值写本回合各任务行）。
 *
 * 这里不做的（登记缺口，不在这里预造）：
 *   · 任务级幂等键（dispatchKey）与"同键重复提交返回原任务"：最小入口没有重投/重放面
 *     （无渠道、无后台重投），接入渠道与重投的切片按最小形状补；
 *   · 取消 / 确认 / 恢复状态机：写与确认切片再定；本切片任务只有
 *     running/completed/failed/unexecuted（unexecuted = 已汇报但零次向执行层发起调用）。
 *
 * 拒绝路径（回归锁，见 runtime.test.ts）：换 principal 或换 session 取任务
 * 一律 TaskOwnershipError；取不存在的任务与越权同一错误（不泄漏任务是否存在）。
 */
import type { ExecutionFailure, ExecutionStatus } from '@fshine/contracts/execution-contract';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'unexecuted';

/** 机械命名默认上限（字符；超长截断加省略号）。 */
const TASK_NAME_MAX = 40;

/**
 * 业务名称 v1（机械回落，零模型、确定性）：取任务交办原文首个空行之前的段落，
 * 空白折叠为单行，超 maxLength 字符截断加「…」；原文无内容给机械占位。
 * 单一来源（新行写入 / 历史行 NULL 显示回落 / 旧库回填口径都用本函数）。
 */
export function deriveTaskName(request: string, maxLength: number = TASK_NAME_MAX): string {
  const firstParagraph = request.split(/\n[ \t]*\n/)[0] ?? '';
  const single = firstParagraph.replace(/\s+/g, ' ').trim();
  if (single === '') return '未命名任务';
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single;
}

/** 一次已发起的执行调用（requestId 由宿主持有，模型不可见）。 */
export interface ExecutionRecord {
  requestId: string;
  operation: string;
  status: ExecutionStatus;
  error?: ExecutionFailure;
}

/** 判定只需要的执行事实投影（内存 ExecutionRecord 与 SQLite 读回行共用）。 */
export interface ExecutedFact {
  operation: string;
  status: ExecutionStatus;
  error?: ExecutionFailure;
}

/**
 * 完成判定（内存 / SQLite 共用，两实现逐项一致）：只看已记录的执行事实，不嗅探汇报文本。
 *   · 零条执行 → unexecuted（Worker 汇报了但没向执行层发起任何调用）；
 *   · 全部 completed → completed；
 *   · 任一非 completed → failed，failureReason 机械合成（取首个非 completed 的
 *     operation/status/error.message 原样；无 error.message 时以状态收尾）。
 * 为什么不是无条件 completed：Worker 以汇报结束不等于执行层成功——「执行层实际成功 /
 * 拒绝或失败 / 未发起执行」必须在顶层 status 上可区分（B 类如实交付）。
 */
export function judgeReportedTask(executions: readonly ExecutedFact[]): {
  status: 'completed' | 'failed' | 'unexecuted';
  failureReason?: string;
} {
  if (executions.length === 0) {
    return {
      status: 'unexecuted',
      failureReason: '未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。',
    };
  }
  const unsuccessful = executions.find((execution) => execution.status !== 'completed');
  if (unsuccessful === undefined) return { status: 'completed' };
  const message = unsuccessful.error?.message ?? '';
  return {
    status: 'failed',
    failureReason: message === ''
      ? `执行层未成功：${unsuccessful.operation} 返回 ${unsuccessful.status}。`
      : `执行层未成功：${unsuccessful.operation} 返回 ${unsuccessful.status}：${message}`,
  };
}

/** 一条最小任务底账：归属 + 状态 + 结果文本 + 执行调用清单。 */
export interface TaskRecord {
  taskId: string;
  principalId: string;
  sessionId: string;
  /** 委派原文（任务请求；审计与结果解释用；业务名称的机械来源）。 */
  request: string;
  status: TaskStatus;
  resultText?: string;
  failureReason?: string;
  /** P1：数字任务编号（底账分配，唯一、不复用；旧库只读/未迁移时缺省）。 */
  taskNo?: number;
  /** P1：业务名称（新行=机械回落写入；历史行缺省，显示层同规则回落）。 */
  name?: string;
  /** P1：本回合 Main 最终回复全文（同回合各任务行同值；缺省=无最终回复存档）。 */
  replyText?: string;
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
  /**
   * P1：把本回合 Main 最终回复逐字写入各任务行（同回合各任务行同值）。
   * 调用点唯一：execution-runtime.send 收尾后；不存在的 taskId 不写（调用方保证 id 来自本回合）。
   */
  archiveReply(taskIds: readonly string[], replyText: string): void;
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
  /** 内存实现的编号：与 SQLite 底账同口径（自增、不复用）——测试与纯内存嵌入用。 */
  let nextTaskNo = 0;
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
      nextTaskNo += 1;
      const task: MutableTaskRecord = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        status: 'running',
        taskNo: nextTaskNo,
        name: deriveTaskName(input.request),
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
      // 终态 = 已记录执行事实的判定；汇报原文恒存（非成功终态也保留 Worker 汇报）。
      const judgement = judgeReportedTask(task.executions);
      task.status = judgement.status;
      task.resultText = resultText;
      if (judgement.failureReason === undefined) {
        delete task.failureReason;
      } else {
        task.failureReason = judgement.failureReason;
      }
      touch(task);
    },
    fail(taskId, reason) {
      const task = require(taskId);
      task.status = 'failed';
      task.failureReason = reason;
      touch(task);
    },
    archiveReply(taskIds, replyText) {
      for (const taskId of taskIds) {
        const task = tasks.get(taskId);
        if (task === undefined) continue;
        task.replyText = replyText;
        touch(task);
      }
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
