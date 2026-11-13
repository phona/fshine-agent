/**
 * 最小任务底账的 SQLite 实现（B 类：任务归属跨进程仍然成立）。
 *
 * 语义与内存版（task-registry.ts 的 createTaskRegistry）逐项一致：begin / noteExecution /
 * complete / fail / get(scope) / list(scope)，越权与不存在同一 TaskOwnershipError。
 * 差别只在写入落 packages/core 的最小 SQLite 引擎（两张表，见 task-store.ts），
 * 进程重启后底账仍在——归属校验因此也是跨重启的不变量。
 *
 * 表内不含计划字段（planId / stepIndex / totalSteps / lastProgress / deadline /
 * originMessage 一概没有）：最小切片没有计划门，也不迁移旧 TaskRunRecord。
 */
import { openTaskStore, type ExecutionRow, type TaskRow, type StoredTask } from '@fshine/core';
import type { ExecutionFailure, ExecutionStatus } from '@fshine/contracts/execution-contract';
import {
  TaskOwnershipError,
  judgeReportedTask,
  type ExecutionRecord,
  type TaskRecord,
  type TaskRegistry,
  type TaskStatus,
  type TaskScope,
} from './task-registry';

/** 带关闭口的底账：进程/入口负责关库（ask、server 的收尾路径）。 */
export interface SqliteTaskRegistry extends TaskRegistry {
  close(): void;
}

export function createSqliteTaskRegistry(dbPath: string): SqliteTaskRegistry {
  const store = openTaskStore(dbPath);

  function toRecord(stored: StoredTask): TaskRecord {
    return {
      taskId: stored.task.taskId,
      principalId: stored.task.principalId,
      sessionId: stored.task.sessionId,
      request: stored.task.request,
      status: stored.task.status as TaskStatus,
      ...(stored.task.resultText === undefined ? {} : { resultText: stored.task.resultText }),
      ...(stored.task.failureReason === undefined ? {} : { failureReason: stored.task.failureReason }),
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

  return {
    begin(input) {
      const now = new Date().toISOString();
      const row: TaskRow = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      store.insertTask(row);
      return toRecord(require(input.taskId));
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
      const outcome = {
        status: judgement.status,
        resultText,
        updatedAt: new Date().toISOString(),
        ...(judgement.failureReason === undefined ? {} : { failureReason: judgement.failureReason }),
      };
      if (!store.setTaskOutcome(taskId, outcome)) {
        throw new TaskOwnershipError();
      }
    },
    fail(taskId, reason) {
      if (!store.setTaskOutcome(taskId, { status: 'failed', failureReason: reason, updatedAt: new Date().toISOString() })) {
        throw new TaskOwnershipError();
      }
    },
    get(taskId, scope) {
      return toRecord(require(taskId, scope));
    },
    list(scope) {
      return store.listTasks(scope).map(toRecord);
    },
    close() {
      store.close();
    },
  };
}
