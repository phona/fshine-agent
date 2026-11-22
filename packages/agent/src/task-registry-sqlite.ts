/**
 * 最小任务底账的 SQLite 实现（B 类：任务归属跨进程仍然成立）。
 *
 * S1 事实模型（docs/design/task-redefinition.md，2026-11-22）：语义与内存版
 * （task-registry.ts 的 createTaskRegistry）逐项一致：同一事实写入方法族（begin /
 * noteExecution / setResultText / archiveReply / waitForUser / answerResumes /
 * markCancelled / markTimedOut / markDied / markResourceLimited / claimNextQueued /
 * armLease / expireLeases / onTaskFact / get / list），越权与不存在同一 TaskOwnershipError。
 * 没有状态机、没有转换矩阵：机械事实一次性写入（时刻列 WHERE IS NULL），结束事实不翻案。
 * 差别只在写入落 packages/core 的最小 SQLite 引擎（见 task-store.ts），进程重启后底账仍在——
 * 归属校验与等待/租约形状因此也是跨重启的不变量。
 */
import { openTaskStore, type ExecutionRow, type OperationRow, type StoredTask, type TaskRow, type TaskStore } from '@fshine/core';
import type { ExecutionFailure, ExecutionOutcome, ExecutionStatus } from '@fshine/contracts/execution-contract';
import {
  TaskOwnershipError,
  TaskSettledError,
  decideOperationClaim,
  deriveTaskName,
  operationStatusOf,
  taskEndedOf,
  type ExecutionRecord,
  type MutationOptions,
  type OperationClaim,
  type OperationClaimInput,
  type OperationRecord,
  type OperationStatus,
  type PendingQuestion,
  type TaskEventKind,
  type TaskFact,
  type TaskFactHook,
  type TaskRecord,
  type TaskRegistry,
  type TaskScope,
  type TimeoutKind,
} from './task-registry';

/** 带关闭口的底账：进程/入口负责关库（ask、server 的收尾路径）。 */
export interface SqliteTaskRegistry extends TaskRegistry {
  close(): void;
  /**
   * CAP-01 S1：底层 SQLite 引擎句柄——fileStore 建在其上（装配层是唯一构造 fileStore 处；
   * 同一连接，不开第二个库连接）。行访问器面 = @fshine/core 的 TaskStore。
   */
  readonly store: TaskStore;
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

  function factOf(row: TaskRow, event: TaskEventKind, at: string): TaskFact {
    return {
      taskId: row.taskId,
      taskNo: row.taskNo ?? 0,
      name: row.name ?? deriveTaskName(row.request),
      event,
      at,
      stateVersion: at,
    };
  }

  function toRecord(stored: StoredTask): TaskRecord {
    return {
      taskId: stored.task.taskId,
      principalId: stored.task.principalId,
      sessionId: stored.task.sessionId,
      request: stored.task.request,
      ...(stored.task.resultText === undefined ? {} : { resultText: stored.task.resultText }),
      ...(stored.task.pendingQuestion === undefined
        ? {}
        : { pendingQuestion: stored.task.pendingQuestion as PendingQuestion }),
      ...(stored.task.waitingSince === undefined ? {} : { waitingSince: stored.task.waitingSince }),
      ...(stored.task.leaseOwner === undefined ? {} : { leaseOwner: stored.task.leaseOwner }),
      ...(stored.task.leaseUntil === undefined ? {} : { leaseUntil: stored.task.leaseUntil }),
      ...(stored.task.diedAt === undefined ? {} : { diedAt: stored.task.diedAt }),
      ...(stored.task.cancelledAt === undefined ? {} : { cancelledAt: stored.task.cancelledAt }),
      ...(stored.task.timedOutAt === undefined ? {} : { timedOutAt: stored.task.timedOutAt }),
      ...(stored.task.resourceLimitedAt === undefined ? {} : { resourceLimitedAt: stored.task.resourceLimitedAt }),
      // P1：旧库只读（未迁移）时三列为缺省（undefined），读出缺省不伪造。
      ...(stored.task.taskNo === undefined ? {} : { taskNo: stored.task.taskNo }),
      ...(stored.task.name === undefined ? {} : { name: stored.task.name }),
      ...(stored.task.replyText === undefined ? {} : { replyText: stored.task.replyText }),
      ...(stored.task.longRunningNotifiedAt === undefined
        ? {}
        : { longRunningNotifiedAt: stored.task.longRunningNotifiedAt }),
      ...(stored.task.waitContactLostNotifiedAt === undefined
        ? {}
        : { waitContactLostNotifiedAt: stored.task.waitContactLostNotifiedAt }),
      ...(stored.task.runningSince === undefined ? {} : { runningSince: stored.task.runningSince }),
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

  function toOperationRecord(row: OperationRow): OperationRecord {
    return {
      dispatchKey: row.dispatchKey,
      scopeKey: row.scopeKey,
      ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
      opSeq: row.opSeq,
      operation: row.operation,
      status: row.status as OperationStatus,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.outcome === undefined ? {} : { outcome: row.outcome as ExecutionOutcome }),
      attempt: row.attempt,
      claimedAt: row.claimedAt,
      ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
      ...(row.deliveredAt === undefined ? {} : { deliveredAt: row.deliveredAt }),
      ...(row.replayOf === undefined ? {} : { replayOf: row.replayOf }),
    };
  }

  function requireOperation(dispatchKey: string): OperationRecord {
    const row = store.getOperation(dispatchKey);
    if (row === undefined) {
      throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
    }
    return toOperationRecord(row);
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
        // P1：名称 v1 = 机械回落（与迁移回填/显示回落同规则）；编号由 store 单条 SQL 原子分配。
        name: deriveTaskName(input.request),
        // inline 建行即开跑（running_since 写入）；后台受理（queued）等 runner 认领。
        ...(input.queued === true ? {} : { runningSince: now }),
        createdAt: now,
        updatedAt: now,
      };
      store.insertTask(row);
      const stored = require(input.taskId);
      emit(factOf(stored.task, input.queued === true ? 'queued' : 'started', now));
      return toRecord(stored);
    },
    noteExecution(taskId, record: ExecutionRecord) {
      const inserted = store.insertExecution({
        requestId: record.requestId,
        taskId,
        operation: record.operation,
        status: record.status,
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.dispatchKey === undefined ? {} : { dispatchKey: record.dispatchKey }),
      });
      if (!inserted) throw new TaskOwnershipError();
      store.touchTask(taskId, new Date().toISOString());
    },
    setResultText(taskId, resultText) {
      const at = new Date().toISOString();
      require(taskId);
      store.setResultText(taskId, { resultText, updatedAt: at });
      emit(factOf(store.getTask(taskId)!.task, 'result_archived', at));
    },
    archiveReply(taskIds, replyText) {
      // 同回合各任务行同值、单事务；不存在的 id 由 store 忽略（调用方保证 id 来自本回合）。
      const at = new Date().toISOString();
      store.setReplyForTasks(taskIds, replyText, at);
      for (const taskId of taskIds) {
        const stored = store.getTask(taskId);
        if (stored !== undefined) emit(factOf(stored.task, 'result_archived', at));
      }
    },
    get(taskId, scope) {
      return toRecord(require(taskId, scope));
    },
    listWaiting(scope) {
      // 只返回等待行（给 scope 时走 (principal, session) 索引，不全表映射）。
      return store.listWaitingRows(scope).map(toRecord);
    },
    listRunning() {
      // 在跑事实（长时间提醒扫描；不读全表）：running_since 非空、无等待形状、无结束事实。
      return store.listRunningTasks().map((row) => toRecord({ task: row, executions: [] }));
    },
    claimLongRunningNotice(taskId, stage, at) {
      // 原子「每档仅一次」领取：已提醒过返回 false（零写入）；不改任务事实、不产事件。
      return store.claimLongRunningNotice(taskId, stage, at);
    },
    list(scope) {
      return store.listTasks(scope).map(toRecord);
    },
    waitForUser(taskId, pendingQuestion, options: MutationOptions = {}) {
      const stored = require(taskId, options.scope);
      if (taskEndedOf(stored.task)) throw new TaskSettledError(taskId);
      const at = new Date().toISOString();
      store.setWaiting(taskId, { pendingQuestion, waitingSince: at, updatedAt: at });
      store.releaseLease(taskId, at);
      emit(factOf(store.getTask(taskId)!.task, 'waiting_user', at));
      return toRecord(require(taskId));
    },
    answerResumes(taskId, options: MutationOptions = {}) {
      const stored = require(taskId, options.scope);
      if (taskEndedOf(stored.task)) throw new TaskSettledError(taskId);
      const at = new Date().toISOString();
      store.setWaiting(taskId, { waitingSince: null, updatedAt: at });
      emit(factOf(store.getTask(taskId)!.task, 'resumed', at));
      return toRecord(require(taskId));
    },
    markCancelled(taskId, options: MutationOptions = {}) {
      require(taskId, options.scope);
      const at = new Date().toISOString();
      const written = store.markTaskFact(taskId, { fact: 'cancelled', at, updatedAt: at });
      if (written) emit(factOf(store.getTask(taskId)!.task, 'cancelled', at));
      return toRecord(require(taskId));
      // 一次性事实：重复取消零写入、零事件（written=false 时行原样读回）。
    },
    markTimedOut(taskId, _kind: TimeoutKind, options: MutationOptions = {}) {
      require(taskId, options.scope);
      const at = new Date().toISOString();
      const written = store.markTaskFact(taskId, { fact: 'timed_out', at, updatedAt: at });
      if (written) emit(factOf(store.getTask(taskId)!.task, 'timed_out', at));
      return toRecord(require(taskId));
    },
    markDied(taskId) {
      require(taskId);
      const at = new Date().toISOString();
      const written = store.markTaskFact(taskId, { fact: 'died', at, updatedAt: at });
      if (written) emit(factOf(store.getTask(taskId)!.task, 'died', at));
      return toRecord(require(taskId));
    },
    markResourceLimited(taskId, options: MutationOptions = {}) {
      require(taskId, options.scope);
      const at = new Date().toISOString();
      const written = store.markTaskFact(taskId, { fact: 'resource_limited', at, updatedAt: at });
      if (written) emit(factOf(store.getTask(taskId)!.task, 'resource_limited', at));
      return toRecord(require(taskId));
    },
    noteRoundFailed(taskId) {
      const stored = require(taskId);
      emit(factOf(stored.task, 'round_failed', new Date().toISOString()));
    },
    claimNextQueued({ owner, leaseMs }) {
      const at = new Date().toISOString();
      const row = store.claimNextUnstarted({
        owner,
        leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: at,
      });
      if (row === undefined) return undefined;
      emit(factOf(row, 'started', at));
      return toRecord(require(row.taskId));
    },
    armLease(taskId, { owner, leaseMs }, options: MutationOptions = {}) {
      const stored = require(taskId, options.scope);
      if (taskEndedOf(stored.task)) throw new TaskSettledError(taskId);
      const at = new Date().toISOString();
      store.armLease(taskId, {
        owner,
        leaseUntil: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: at,
      });
      return toRecord(require(taskId));
    },
    expireLeases(now = new Date().toISOString()) {
      const affected: TaskRecord[] = [];
      for (const row of store.listRunningExpiredLeases(now)) {
        try {
          const at = new Date().toISOString();
          const written = store.markTaskFact(row.taskId, { fact: 'died', at, updatedAt: at });
          if (written) emit(factOf(store.getTask(row.taskId)!.task, 'died', at));
          affected.push(toRecord(require(row.taskId)));
        } catch (error) {
          // 并发下事实已被其他进程写入：跳过（不是本进程的过期目标），不推翻已发生的事实。
          if (error instanceof TaskSettledError) continue;
          throw error;
        }
      }
      return affected;
    },
    onTaskFact(hook) {
      factHook = hook;
    },
    claimOperation(input: OperationClaimInput): OperationClaim {
      const now = input.now ?? new Date().toISOString();
      // 读候选 → 纯函数决策 → 写：全部在同一 BEGIN IMMEDIATE 写事务（跨进程并发不重号、
      // 第二者看到的是已提交的 claimed 行，因此不会并发执行同一身份）。
      return store.transaction((): OperationClaim => {
        let candidates: OperationRecord[] = [];
        if (input.dispatchKey !== undefined) {
          const row = store.getOperation(input.dispatchKey);
          if (row !== undefined) candidates = [toOperationRecord(row)];
        } else if (input.replayWindow !== undefined) {
          candidates = store.listOperationCandidates({
            scopeKey: input.scopeKey,
            operation: input.operation,
            attempt: input.replayWindow,
          }).map(toOperationRecord);
        }
        const decision = decideOperationClaim(input, candidates);
        switch (decision.action) {
          case 'mint': {
            const row = store.mintOperation({
              scopeKey: input.scopeKey,
              operation: input.operation,
              attempt: input.attempt,
              now,
              ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
            });
            return { kind: 'minted', dispatchKey: row.dispatchKey, opSeq: row.opSeq, reclaimed: false };
          }
          case 'reclaim': {
            const row = store.reclaimOperation(decision.row.dispatchKey, {
              attempt: input.attempt,
              now,
              ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
            });
            if (row === undefined) return { kind: 'unresolved', reason: 'prior_unknown' };
            return { kind: 'minted', dispatchKey: row.dispatchKey, opSeq: row.opSeq, reclaimed: true };
          }
          case 'replay': {
            const { row } = decision;
            if (row.outcome === undefined) {
              store.applyOperationState(row.dispatchKey, {
                expectedStatus: row.status,
                status: 'unknown',
                reason: 'prior_unknown',
                settledAt: now,
              });
              return { kind: 'unresolved', reason: 'prior_unknown', dispatchKey: row.dispatchKey };
            }
            // 仅推进窗口标记（身份不变），让下一次恢复仍能找回这一行。
            store.applyOperationState(row.dispatchKey, {
              expectedStatus: row.status,
              status: row.status,
              reason: row.reason ?? null,
              outcomeJson: JSON.stringify(row.outcome),
              settledAt: row.settledAt ?? null,
              deliveredAt: row.deliveredAt ?? null,
              attempt: input.attempt,
            });
            return { kind: 'replayed', dispatchKey: row.dispatchKey, opSeq: row.opSeq, outcome: row.outcome };
          }
          case 'in_progress':
            return {
              kind: 'in_progress',
              dispatchKey: decision.row.dispatchKey,
              opSeq: decision.row.opSeq,
              claimedAt: decision.row.claimedAt,
            };
          case 'unresolved': {
            for (const row of decision.rows) {
              if (row.status !== 'claimed' && row.status !== 'unknown') continue;
              store.applyOperationState(row.dispatchKey, {
                expectedStatus: row.status,
                status: 'unknown',
                reason: decision.reason,
                settledAt: now,
              });
            }
            const first = decision.rows[0];
            return {
              kind: 'unresolved',
              reason: decision.reason,
              ...(first === undefined ? {} : { dispatchKey: first.dispatchKey }),
            };
          }
          case 'conflict':
            return { kind: 'conflict', reason: 'operation_mismatch', dispatchKey: decision.row.dispatchKey };
        }
      });
    },
    settleOperation(dispatchKey: string, outcome: ExecutionOutcome, options: { now?: string; taskId?: string } = {}) {
      const now = options.now ?? new Date().toISOString();
      return store.transaction((): OperationRecord => {
        const current = store.getOperation(dispatchKey);
        if (current === undefined) {
          throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
        }
        // 已落定的行不被覆盖（重复落定不改变事实；unknown 不被晚到的结果洗白）。
        if (current.status !== 'claimed') return toOperationRecord(current);
        const status = operationStatusOf(outcome);
        store.applyOperationState(dispatchKey, {
          expectedStatus: 'claimed',
          status,
          reason: status === 'unknown' ? 'result_unknown' : null,
          outcomeJson: JSON.stringify(outcome),
          settledAt: now,
          deliveredAt: now,
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        });
        return requireOperation(dispatchKey);
      });
    },
    markOperationUnknown(dispatchKey: string, reason: string, options: { now?: string } = {}) {
      const now = options.now ?? new Date().toISOString();
      return store.transaction((): OperationRecord => {
        const current = store.getOperation(dispatchKey);
        if (current === undefined) {
          throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
        }
        if (current.status !== 'claimed') return toOperationRecord(current);
        store.applyOperationState(dispatchKey, {
          expectedStatus: 'claimed',
          status: 'unknown',
          reason,
          settledAt: now,
        });
        return requireOperation(dispatchKey);
      });
    },
    getOperation(dispatchKey) {
      const row = store.getOperation(dispatchKey);
      return row === undefined ? undefined : toOperationRecord(row);
    },
    listAcceptedOperations() {
      // 底账里按状态取（重启后本进程内存为空，唯一可恢复来源就是这行）。
      return store.listOperationsByStatus('accepted').map(toOperationRecord);
    },
    settleAcceptedOperation(dispatchKey, outcome, options = {}) {
      const now = options.now ?? new Date().toISOString();
      return store.transaction((): OperationRecord => {
        const current = store.getOperation(dispatchKey);
        if (current === undefined) {
          throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
        }
        // 只推进 accepted 行；已终态/未知不覆盖（幂等，未知不被洗白）。
        if (current.status !== 'accepted') return toOperationRecord(current);
        const status = operationStatusOf(outcome);
        if (status === 'accepted') return toOperationRecord(current);
        store.applyOperationState(dispatchKey, {
          expectedStatus: 'accepted',
          status,
          reason: status === 'unknown' ? 'result_unknown' : null,
          outcomeJson: JSON.stringify(outcome),
          settledAt: now,
          deliveredAt: now,
        });
        return requireOperation(dispatchKey);
      });
    },
    releaseTaskLease(taskId, options: MutationOptions = {}) {
      require(taskId, options.scope);
      store.releaseLease(taskId, new Date().toISOString());
      return toRecord(require(taskId));
    },
    store,
    close() {
      store.close();
    },
  };
}
