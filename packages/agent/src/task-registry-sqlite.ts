/**
 * 最小任务底账的 SQLite 实现（B 类：任务归属跨进程仍然成立）。
 *
 * 语义与内存版（task-registry.ts 的 createTaskRegistry）逐项一致：同一状态机归约核心
 * （reduceTaskState）+ 同一方法族（begin / noteExecution / complete / fail / archiveReply /
 * transition / waitForUser / answerResumes / requestCancel / confirmCancelled / timeout /
 * markResultUnknown / claimNextQueued / expireLeases / onTaskFact / get / list），
 * 越权与不存在同一 TaskOwnershipError。差别只在写入落 packages/core 的最小 SQLite 引擎
 * （见 task-store.ts；状态写入经单语句 applyTaskState），进程重启后底账仍在——
 * 归属校验与等待/租约形状因此也是跨重启的不变量。
 *
 * 表内不含计划字段（planId / stepIndex / totalSteps / lastProgress / deadline /
 * originMessage 一概没有）：最小切片没有计划门，也不迁移旧 TaskRunRecord。
 */
import { openTaskStore, type ExecutionRow, type StoredTask, type TaskRow } from '@fshine/core';
import type { ExecutionFailure, ExecutionStatus } from '@fshine/contracts/execution-contract';
import {
  TaskOwnershipError,
  TaskTransitionError,
  deriveTaskName,
  judgeReportedTask,
  reduceTaskState,
  type ExecutionRecord,
  type MutationOptions,
  type PendingQuestion,
  type TaskAction,
  type TaskFact,
  type TaskFactHook,
  type TaskReason,
  type TaskRecord,
  type TaskRegistry,
  type TaskScope,
  type TaskStateSnapshot,
  type TaskStatus,
  type TimeoutKind,
  type TransitionOptions,
} from './task-registry';

/** 带关闭口的底账：进程/入口负责关库（ask、server 的收尾路径）。 */
export interface SqliteTaskRegistry extends TaskRegistry {
  close(): void;
}

/** 打开选项（P1 任务查看）：readOnly 只读打开既有库；写方法调用由 SQLite 拒绝。 */
export interface SqliteTaskRegistryOptions {
  readOnly?: boolean;
}

export function createSqliteTaskRegistry(
  dbPath: string,
  options: SqliteTaskRegistryOptions = {},
): SqliteTaskRegistry {
  const store = openTaskStore(dbPath, { readOnly: options.readOnly === true });
  let factHook: TaskFactHook | undefined;

  const emit = (fact: TaskFact): void => {
    if (factHook === undefined) return;
    try {
      factHook(fact);
    } catch {
      // 事实已机械落库；消费者故障不得回滚/改变任务事实（不重试、不落库）。
    }
  };

  function toRecord(stored: StoredTask): TaskRecord {
    return {
      taskId: stored.task.taskId,
      principalId: stored.task.principalId,
      sessionId: stored.task.sessionId,
      request: stored.task.request,
      status: stored.task.status as TaskStatus,
      ...(stored.task.reason === undefined ? {} : { reason: stored.task.reason as TaskReason }),
      ...(stored.task.resultText === undefined ? {} : { resultText: stored.task.resultText }),
      ...(stored.task.failureReason === undefined ? {} : { failureReason: stored.task.failureReason }),
      ...(stored.task.pendingQuestion === undefined
        ? {}
        : { pendingQuestion: stored.task.pendingQuestion as PendingQuestion }),
      ...(stored.task.waitingSince === undefined ? {} : { waitingSince: stored.task.waitingSince }),
      ...(stored.task.leaseOwner === undefined ? {} : { leaseOwner: stored.task.leaseOwner }),
      ...(stored.task.leaseUntil === undefined ? {} : { leaseUntil: stored.task.leaseUntil }),
      // P1：旧库只读（未迁移）时三列为缺省（undefined），读出缺省不伪造。
      ...(stored.task.taskNo === undefined ? {} : { taskNo: stored.task.taskNo }),
      ...(stored.task.name === undefined ? {} : { name: stored.task.name }),
      ...(stored.task.replyText === undefined ? {} : { replyText: stored.task.replyText }),
      executions: stored.executions.map((execution: ExecutionRow) => ({
        requestId: execution.requestId,
        operation: execution.operation,
        status: execution.status as ExecutionStatus,
        ...(execution.error === undefined ? {} : { error: execution.error as ExecutionFailure }),
      })),
      createdAt: stored.task.createdAt,
      updatedAt: stored.task.updatedAt,
    };
  }

  function require(taskId: string, scope?: TaskScope): StoredTask {
    const stored = store.getTask(taskId);
    if (
      stored === undefined
      || (scope !== undefined && (stored.task.principalId !== scope.principalId || stored.task.sessionId !== scope.sessionId))
    ) {
      throw new TaskOwnershipError();
    }
    return stored;
  }

  function snapshotOf(row: TaskRow): TaskStateSnapshot {
    return {
      status: row.status as TaskStatus,
      ...(row.reason === undefined ? {} : { reason: row.reason as TaskReason }),
      ...(row.pendingQuestion === undefined ? {} : { pendingQuestion: row.pendingQuestion as PendingQuestion }),
      ...(row.waitingSince === undefined ? {} : { waitingSince: row.waitingSince }),
      ...(row.leaseOwner === undefined ? {} : { leaseOwner: row.leaseOwner }),
      ...(row.leaseUntil === undefined ? {} : { leaseUntil: row.leaseUntil }),
    };
  }

  /**
   * 单一写路径：读当值行 → 状态机归约 → applyTaskState（单语句 + expectedStatus
   * 乐观并发）→ 事实钩子 → 读回。非法转换在归约处抛 TaskTransitionError（零写入）。
   */
  function commit(
    taskId: string,
    scope: TaskScope | undefined,
    action: TaskAction,
    extras: { resultText?: string; failureReason?: string | null } = {},
  ): TaskRecord {
    const stored = require(taskId, scope);
    const at = new Date().toISOString();
    const from = stored.task.status as TaskStatus;
    const next = reduceTaskState(snapshotOf(stored.task), action, at);
    const applied = store.applyTaskState(taskId, {
      expectedStatus: from,
      status: next.status,
      reason: next.reason ?? null,
      resultText: 'resultText' in extras ? extras.resultText ?? null : stored.task.resultText ?? null,
      failureReason: 'failureReason' in extras ? extras.failureReason ?? null : stored.task.failureReason ?? null,
      pendingQuestion: next.pendingQuestion,
      waitingSince: next.waitingSince ?? null,
      leaseOwner: next.leaseOwner ?? null,
      leaseUntil: next.leaseUntil ?? null,
      updatedAt: at,
    });
    if (!applied) throw new TaskTransitionError(from, next.status, '状态已被并发修改');
    emit({
      taskId,
      taskNo: stored.task.taskNo ?? 0,
      name: stored.task.name ?? deriveTaskName(stored.task.request),
      from,
      to: next.status,
      ...(next.reason === undefined ? {} : { reason: next.reason }),
      at,
    });
    return toRecord(require(taskId));
  }

  return {
    begin(input) {
      const now = new Date().toISOString();
      const status: TaskStatus = input.status ?? 'running';
      const row: TaskRow = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        status,
        // P1：名称 v1 = 机械回落（与迁移回填/显示回落同规则）；编号由 store 单条 SQL 原子分配。
        name: deriveTaskName(input.request),
        createdAt: now,
        updatedAt: now,
      };
      store.insertTask(row);
      const stored = require(input.taskId);
      emit({
        taskId: input.taskId,
        taskNo: stored.task.taskNo ?? 0,
        name: stored.task.name ?? deriveTaskName(stored.task.request),
        to: status,
        at: now,
      });
      return toRecord(stored);
    },
    noteExecution(taskId, record: ExecutionRecord) {
      const inserted = store.insertExecution({
        requestId: record.requestId,
        taskId,
        operation: record.operation,
        status: record.status,
        ...(record.error === undefined ? {} : { error: record.error }),
      });
      if (!inserted) throw new TaskOwnershipError();
      store.touchTask(taskId, new Date().toISOString());
    },
    complete(taskId, resultText) {
      const stored = require(taskId);
      // 终态 = 读回已记录执行事实后的同一判定（与内存版逐项一致；不嗅探汇报文本）。
      const judgement = judgeReportedTask(stored.executions.map((execution: ExecutionRow) => ({
        operation: execution.operation,
        status: execution.status as ExecutionStatus,
        ...(execution.error === undefined ? {} : { error: execution.error as ExecutionFailure }),
      })));
      commit(
        taskId,
        undefined,
        { action: 'transition', to: judgement.status },
        { resultText, failureReason: judgement.failureReason ?? null },
      );
    },
    fail(taskId, reason) {
      commit(taskId, undefined, { action: 'transition', to: 'failed' }, { failureReason: reason });
    },
    archiveReply(taskIds, replyText) {
      // 同回合各任务行同值、单事务；不存在的 id 由 store 忽略（调用方保证 id 来自本回合）。
      store.setReplyForTasks(taskIds, replyText, new Date().toISOString());
    },
    get(taskId, scope) {
      return toRecord(require(taskId, scope));
    },
    list(scope) {
      return store.listTasks(scope).map(toRecord);
    },
    transition(taskId, to, options: TransitionOptions = {}) {
      return commit(taskId, options.scope, {
        action: 'transition',
        to,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
    },
    waitForUser(taskId, pendingQuestion, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'waitForUser', pendingQuestion });
    },
    answerResumes(taskId, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'answerResumes' });
    },
    requestCancel(taskId, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'requestCancel' });
    },
    confirmCancelled(taskId, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'confirmCancelled' });
    },
    timeout(taskId, kind: TimeoutKind, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'timeout', kind });
    },
    markResultUnknown(taskId, options: MutationOptions = {}) {
      return commit(taskId, options.scope, { action: 'markResultUnknown' });
    },
    claimNextQueued({ owner, leaseMs }) {
      const at = new Date().toISOString();
      const row = store.claimQueued({
        owner,
        leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: at,
      });
      if (row === undefined) return undefined;
      emit({
        taskId: row.taskId,
        taskNo: row.taskNo ?? 0,
        name: row.name ?? deriveTaskName(row.request),
        from: 'queued',
        to: 'running',
        at,
      });
      return toRecord(require(row.taskId));
    },
    expireLeases(now = new Date().toISOString()) {
      const affected: TaskRecord[] = [];
      for (const row of store.listRunningExpiredLeases(now)) {
        try {
          affected.push(commit(row.taskId, undefined, { action: 'markResultUnknown' }));
        } catch (error) {
          // 并发下状态已被其他进程改变：跳过（不是本进程的过期目标），不推翻已发生的事实。
          if (error instanceof TaskTransitionError) continue;
          throw error;
        }
      }
      return affected;
    },
    onTaskFact(hook) {
      factHook = hook;
    },
    close() {
      store.close();
    },
  };
}
