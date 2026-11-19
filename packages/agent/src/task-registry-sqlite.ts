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
import { openTaskStore, type ExecutionRow, type OperationRow, type StoredTask, type TaskRow, type TaskStore } from '@fshine/core';
import type { ExecutionFailure, ExecutionOutcome, ExecutionStatus } from '@fshine/contracts/execution-contract';
import {
  TaskOwnershipError,
  TaskTransitionError,
  decideOperationClaim,
  deriveTaskName,
  judgeReportedTask,
  operationStatusOf,
  reduceTaskState,
  type ExecutionRecord,
  type MutationOptions,
  type OperationClaim,
  type OperationClaimInput,
  type OperationRecord,
  type OperationStatus,
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
      // 预期契约（2026-11-18）：旧库只读（未迁移）时该列为缺省，读出缺省不伪造。
      ...(stored.task.longRunningNotifiedAt === undefined
        ? {}
        : { longRunningNotifiedAt: stored.task.longRunningNotifiedAt }),
      ...(stored.task.longRunningStuckNotifiedAt === undefined
        ? {}
        : { longRunningStuckNotifiedAt: stored.task.longRunningStuckNotifiedAt }),
      // 2026-11-19：本轮开始运行时刻（长任务受理后租约被清，提醒扫描用它算「跑了多久」）。
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
      stateVersion: at,
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
        stateVersion: now,
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
        ...(record.dispatchKey === undefined ? {} : { dispatchKey: record.dispatchKey }),
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
    listWaiting(scope) {
      // 只返回等待行（给 scope 时走 (principal, session, status) 索引，不全表映射）。
      return store.listTasks(scope, 'waiting_user')
        .filter((stored) => stored.task.status === 'waiting_user')
        .map(toRecord);
    },
    listRunning() {
      // 预期契约（2026-11-18）：只读 running 行（长时间提醒扫描；不读全表）。
      return store.listRunningTasks().map((row) => toRecord({ task: row, executions: [] }));
    },
    claimLongRunningNotice(taskId, stage, at) {
      // 原子「每档仅一次」领取：已提醒过返回 false（零写入）；不改任务状态、不产状态事实。
      return store.claimLongRunningNotice(taskId, stage, at);
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
        stateVersion: at,
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
      const stored = require(taskId, options.scope);
      if (stored.task.status !== 'running') return toRecord(stored);
      // 长任务让出槽位：状态仍是 running（没有合法自反边），只清单据租约——别的字段原样保留。
      store.applyTaskState(taskId, {
        expectedStatus: 'running',
        status: 'running',
        reason: stored.task.reason ?? null,
        resultText: stored.task.resultText ?? null,
        failureReason: stored.task.failureReason ?? null,
        pendingQuestion: stored.task.pendingQuestion,
        waitingSince: stored.task.waitingSince ?? null,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date().toISOString(),
      });
      return toRecord(require(taskId));
    },
    store,
    close() {
      store.close();
    },
  };
}
