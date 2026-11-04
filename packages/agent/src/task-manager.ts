import { randomUUID } from 'node:crypto';
import type {
  BackgroundTaskEvent,
  TaskRunRecord,
  TaskRunRepo,
  TaskRunState,
  TrustedContext,
  TurnInputContext,
} from '@fshine/contracts';
import { ToolUserError } from './driver';
import type {
  ContextTaskRunner,
  PreparedContextTaskRun,
  ContextTaskRunArgs,
  RunWorkspaceFile,
  SubagentTaskResult,
} from './context';
import {
  PlatformExecutionAbortedError,
  PlatformExecutionQueueFullError,
  type PlatformExecutionGate,
  type PlatformExecutionLease,
  type PlatformExecutionTicket,
} from './platform-execution-gate';

export interface TaskReceipt {
  taskId: string;
  runId: string;
  dispatchKey: string;
  state: TaskRunState;
  label?: string;
}

export interface TaskControlReceipt {
  found: boolean;
  taskId: string;
  runId?: string;
  state?: TaskRunState;
  /** true means cancellation was requested from an active Worker; false means state is already terminal. */
  requested: boolean;
}

export interface TaskManagerScope {
  principalId: string;
  sessionId: string;
}

export interface BackgroundTaskSubmitInput {
  /** Host-generated identity for this source tool call or task event. */
  dispatchKey: string;
  args: ContextTaskRunArgs;
  trusted: TrustedContext;
  originMessage: string;
  originUserEventId?: string;
  inputContext?: TurnInputContext;
  planId?: string;
  step?: { stepIndex: number; totalSteps: number };
}

export interface PreparedBackgroundTaskSubmitInput {
  dispatchKey: string;
  prepared: PreparedContextTaskRun;
  trusted: TrustedContext;
  originMessage: string;
  originUserEventId?: string;
  inputContext?: TurnInputContext;
  planId?: string;
  step?: { stepIndex: number; totalSteps: number };
  metadata?: Record<string, unknown>;
}

export interface BackgroundTaskManager {
  submit(input: BackgroundTaskSubmitInput): Promise<TaskReceipt>;
  submitPrepared(input: PreparedBackgroundTaskSubmitInput): Promise<TaskReceipt>;
  list(scope: TaskManagerScope): Promise<TaskRunRecord[]>;
  get(scope: TaskManagerScope, taskId: string): Promise<TaskRunRecord | null>;
  cancel(scope: TaskManagerScope, taskId: string): Promise<TaskControlReceipt>;
  subscribe(listener: (event: BackgroundTaskEvent) => Promise<void>): () => void;
  recoverInterrupted(now?: string): Promise<number>;
  shutdown(options?: { drainMs?: number }): Promise<void>;
}

export interface BackgroundTaskManagerOptions {
  runner: ContextTaskRunner;
  repo: TaskRunRepo;
  /** Must be the same instance supplied to ContextTaskRunner and host commit runners. */
  executionGate: PlatformExecutionGate;
  /** Invalidates plan/proposal state before a waiting-confirmation run is marked cancelled. */
  onCancelPending?: (run: TaskRunRecord, scope: TaskManagerScope) => Promise<boolean>;
  now?: () => number;
  newId?: () => string;
}

interface ActiveRun {
  input: PreparedBackgroundTaskSubmitInput;
  prepared: PreparedContextTaskRun;
  record: TaskRunRecord;
  controller: AbortController;
  ticket: PlatformExecutionTicket;
  execution: Promise<void>;
  eventDispatched: boolean;
  /** False until the prepared operation is about to be invoked. */
  executionStarted: boolean;
  /** Synchronously installed before an async host-confirmation invalidator runs. */
  cancelBarrier?: { promise: Promise<boolean>; resolve(value: boolean): void };
}

const ACTIVE_STATES: readonly TaskRunState[] = ['queued', 'running', 'cancelling'];
const TERMINAL_STATES = new Set<TaskRunState>([
  'completed', 'failed', 'cancelled', 'waiting_input', 'waiting_confirmation', 'interrupted',
]);
const TRANSITION_RETRIES = 4;
const RESULT_PERSIST_RETRIES = 3;
const RESULT_EVENT_PREFIX = 'task-run:';
/**
 * 停止受理后台任务的统一用户话术（D-132b）：submit 入口检查与停机窗口内的落库前
 * 复查共用同一句——同一事实一个权威位置，两道闸对用户的发音必须一致。
 */
const STOPPING_REJECT_MESSAGE = '服务正在停止接收后台任务，请稍后重试。';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '后台任务执行失败。';
}

/**
 * before/after 快照的内容 diff。D-116 起条目可降级（无 sha256，标 hashSkipped）：
 * 两侧都无哈希 → 内容比较对它失效（undefined === undefined），大小变化仍会被看见；
 * 一侧有哈希一侧没有 → 视为变化（保守归因，宁可多报不漏报）。
 */
export function outputDiff(before: readonly RunWorkspaceFile[], after: readonly RunWorkspaceFile[]): RunWorkspaceFile[] {
  const prior = new Map(before.map((file) => [file.relativePath, file]));
  return after.filter((file) => {
    const old = prior.get(file.relativePath);
    return !old || old.sha256 !== file.sha256 || old.size !== file.size;
  });
}

function resultState(result: SubagentTaskResult): Extract<TaskRunState, 'completed' | 'failed' | 'waiting_input' | 'waiting_confirmation'> {
  if (result.pendingPlan || result.proposalCreated) return 'waiting_confirmation';
  if (result.hostConfirmationOutcome === 'confirm_failed') return 'failed';
  // 已落账但读回不足：人工核对未完成，任务不能算 completed；置 failed
  // 是“仍需人工处理”的开放态，不是“一次写入都没发生”的失败。
  if (result.hostConfirmationOutcome === 'confirm_committed_unverified') return 'failed';
  if (result.hostConfirmationOutcome === 'confirm_held') return 'waiting_confirmation';
  if (result.needs || result.clarification) return 'waiting_input';
  return 'completed';
}

function requestSummary(
  input: Pick<PreparedBackgroundTaskSubmitInput, 'originMessage'> & { args?: ContextTaskRunArgs },
  metadata?: Record<string, unknown>,
): string {
  if (metadata?.kind === 'host_confirmation') return '确认待处理操作';
  const source = input.originMessage || input.args?.request || input.args?.stepLabel || '后台任务';
  return source
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, '文件')
    .replace(/\b(?:password|passwd|token|secret)\s*[:=]\s*\S+/gi, '凭据=[已隐藏]')
    .replace(/\b(?:确认|取消)\s*[A-Z0-9]{6}\b/gi, '确认码')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || '后台任务';
}

function isTerminal(state: TaskRunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** In-process Worker lifecycle manager. Durable facts are written before receipts/events are exposed. */
export function createBackgroundTaskManager(options: BackgroundTaskManagerOptions): BackgroundTaskManager {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => `run_${randomUUID()}`);
  const listeners = new Set<(event: BackgroundTaskEvent) => Promise<void>>();
  const inFlightDispatches = new Map<string, Promise<TaskReceipt>>();
  const reservedTasks = new Set<string>();
  const activeTasks = new Set<string>();
  const activeRuns = new Map<string, ActiveRun>();
  const pendingDispatches = new Set<Promise<void>>();
  let stopping = false;

  const transition = async (
    runId: string,
    expectedStates: readonly TaskRunState[],
    patch: Partial<TaskRunRecord>,
  ): Promise<TaskRunRecord | null> => {
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const current = await options.repo.get(runId);
      if (!current || !expectedStates.includes(current.state)) return current;
      const changed = await options.repo.transition(
        runId,
        expectedStates,
        { ...patch, updatedAt: iso(now()) },
        current.revision,
      );
      if (changed) return await options.repo.get(runId);
    }
    return await options.repo.get(runId);
  };

  const latestForTask = async (scope: TaskManagerScope, taskId: string): Promise<TaskRunRecord | null> => {
    const records = await options.repo.listBySession(scope.principalId, scope.sessionId);
    const matches = records.filter((record) => record.taskId === taskId);
    return matches.at(-1) ?? null;
  };

  const receiptFor = (run: TaskRunRecord): TaskReceipt => ({
    taskId: run.taskId,
    runId: run.runId,
    dispatchKey: run.dispatchKey,
    state: run.state,
    ...(typeof run.metadata?.label === 'string' ? { label: run.metadata.label } : {}),
  });

  const emitTerminal = async (record: TaskRunRecord, result?: SubagentTaskResult, error?: string): Promise<void> => {
    if (!record.resultEventId) return;
    const event: BackgroundTaskEvent = {
      eventId: record.resultEventId,
      run: record,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    };
    for (const listener of [...listeners]) {
      try {
        await listener(event);
      } catch (listenerError) {
        console.error(JSON.stringify({
          event: 'background_task_event_listener_failed',
          runId: record.runId,
          taskId: record.taskId,
          errorType: listenerError instanceof Error ? listenerError.name : 'UnknownError',
        }));
      }
    }
  };

  const scheduleDispatch = (active: ActiveRun, record: TaskRunRecord, result?: SubagentTaskResult, error?: string): void => {
    if (active.eventDispatched) return;
    active.eventDispatched = true;
    const dispatch = emitTerminal(record, result, error).finally(() => pendingDispatches.delete(dispatch));
    pendingDispatches.add(dispatch);
  };

  const scheduleTask = (active: ActiveRun): void => {
    active.execution = new Promise<void>((resolve) => {
      setImmediate(() => {
        void execute(active).finally(resolve);
      });
    });
  };

  const installCancelBarrier = (active: ActiveRun): NonNullable<ActiveRun['cancelBarrier']> => {
    if (active.cancelBarrier) return active.cancelBarrier;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const barrier = { promise, resolve };
    active.cancelBarrier = barrier;
    return barrier;
  };

  const settleCancelBarrier = (active: ActiveRun, value: boolean): void => {
    const barrier = active.cancelBarrier;
    if (!barrier) return;
    active.cancelBarrier = undefined;
    barrier.resolve(value);
  };

  const waitForCancelBarrier = async (active: ActiveRun): Promise<boolean> => {
    while (active.cancelBarrier) {
      const barrier = active.cancelBarrier;
      if (await barrier.promise) return true;
    }
    return false;
  };

  /**
   * 停机收卷单个 run（shutdown 循环与 execute 末道闸共用，D-132b）：分类与话术只有
   * 这一份——未启动的待确认类标 interrupted（宿主授权不撤，恢复后可再确认），排队中
   * 标 cancelled，运行中转 cancelling 交由执行续篇收尾。终态/缺失的 run 不动（continue
   * 语义）。票据只在排队/待确认两枝回收；运行中那枝的票据随执行续篇自然释放。
   */
  const windDownForStop = async (active: ActiveRun): Promise<void> => {
    const current = await options.repo.get(active.record.runId);
    if (!current || isTerminal(current.state)) return;
    const unstartedHostConfirmation = current.metadata?.kind === 'host_confirmation'
      && !active.executionStarted
      && ['queued', 'running'].includes(current.state);
    if (unstartedHostConfirmation) {
      // Shutdown interrupts this receipt but does not revoke its still-valid host approval.
      // The user may confirm it again after service recovery.
      await transition(current.runId, ['queued', 'running'], {
        state: 'interrupted',
        endedAt: iso(now()),
        resultEventId: current.resultEventId ?? `${RESULT_EVENT_PREFIX}${current.runId}`,
        deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
      });
      active.ticket.cancel();
      settleCancelBarrier(active, true);
    } else if (current.state === 'queued') {
      await transition(current.runId, ['queued'], {
        state: 'cancelled',
        endedAt: iso(now()),
        resultEventId: current.resultEventId ?? `${RESULT_EVENT_PREFIX}${current.runId}`,
        deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
      });
      active.ticket.cancel();
    } else if (current.state === 'running') {
      await transition(current.runId, ['running'], { state: 'cancelling' });
    }
    active.controller.abort();
  };

  const stopBeforeExecution = async (active: ActiveRun, lease?: PlatformExecutionLease): Promise<void> => {
    active.ticket.cancel();
    lease?.release();
    const current = await options.repo.get(active.record.runId);
    if (current && isTerminal(current.state)) {
      scheduleDispatch(active, current, current.result as SubagentTaskResult | undefined, current.error);
      return;
    }
    if (current && ACTIVE_STATES.includes(current.state)) {
      const cancelled = await persistTerminal(active, 'cancelled', {
        deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
      });
      activeTasks.delete(active.record.taskId);
      scheduleDispatch(active, cancelled);
    }
  };

  const persistTerminal = async (
    active: ActiveRun,
    state: Extract<TaskRunState, 'completed' | 'failed' | 'cancelled' | 'waiting_input' | 'waiting_confirmation'>,
    patch: Partial<TaskRunRecord>,
  ): Promise<TaskRunRecord> => {
    for (let attempt = 0; attempt < RESULT_PERSIST_RETRIES; attempt += 1) {
      try {
        const current = await options.repo.get(active.record.runId);
        if (current && isTerminal(current.state)) return current;
        const updated = await transition(active.record.runId, ['running', 'cancelling', 'queued'], {
          ...patch,
          state,
          endedAt: iso(now()),
          resultEventId: active.record.resultEventId,
        });
        if (updated && isTerminal(updated.state)) return updated;
      } catch (error) {
        console.error(JSON.stringify({
          event: 'background_task_result_persist_failed',
          runId: active.record.runId,
          taskId: active.record.taskId,
          attempt: attempt + 1,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
      }
      if (attempt + 1 < RESULT_PERSIST_RETRIES) await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
    // Never rerun an external operation because result storage failed. Preserve the in-memory result
    // and emit its stable event identity so the host can still attempt delivery and report the gap.
    const current = await options.repo.get(active.record.runId);
    if (current && isTerminal(current.state)) return current;
    console.error(JSON.stringify({ event: 'background_task_terminal_state_unpersisted', runId: active.record.runId, taskId: active.record.taskId }));
    return {
      ...active.record,
      ...patch,
      state,
      endedAt: iso(now()),
      updatedAt: iso(now()),
      resultEventId: active.record.resultEventId,
    };
  };

  async function execute(active: ActiveRun): Promise<void> {
    let lease: PlatformExecutionLease | undefined;
    let result: SubagentTaskResult | undefined;
    let executionError: unknown;
    try {
      // 停机末道闸（D-132b）：落库前复查之后仍隔着落库 await 的残余窗口里，run 会在
      // shutdown 遍历 activeRuns 之后才排上队，没有谁会来取消它。起 Worker 前复查
      // stopping：命中则按 shutdown 同一套收卷分类落终态（不新起 Worker、票据随收卷
      // 回收），并照常派发终态事件——被 shutdown 遍历收卷的 run 也是经各自 execute
      // 续篇派发终态的，两路口径一致；排干期外的残留投递由宿主启动期清扫兜底。
      if (stopping) {
        await windDownForStop(active);
        const stopped = await options.repo.get(active.record.runId);
        if (stopped && isTerminal(stopped.state)) {
          scheduleDispatch(active, stopped, stopped.result as SubagentTaskResult | undefined, stopped.error);
        }
        return;
      }
      let current = await options.repo.get(active.record.runId);
      if (!current || current.state !== 'queued') {
        if (current && isTerminal(current.state)) scheduleDispatch(active, current, current.result as SubagentTaskResult | undefined, current.error);
        return;
      }
      if (await waitForCancelBarrier(active)) {
        await stopBeforeExecution(active);
        return;
      }

      try {
        lease = await active.ticket.acquired;
      } catch (error) {
        executionError = error;
      }
      if (!lease) {
        const state: 'cancelled' | 'failed' = active.controller.signal.aborted || executionError instanceof PlatformExecutionAbortedError
          ? 'cancelled'
          : 'failed';
        const updated = await persistTerminal(active, state, {
          ...(state === 'cancelled' ? {} : { error: safeError(executionError) }),
          deliveryState: active.record.deliveryRoute ? 'pending' : 'not_required',
        });
        activeTasks.delete(active.record.taskId);
        scheduleDispatch(active, updated, undefined, updated.error);
        return;
      }

      current = await options.repo.get(active.record.runId);
      if (active.controller.signal.aborted || await waitForCancelBarrier(active) || !current || current.state !== 'queued') {
        await stopBeforeExecution(active, lease);
        lease = undefined;
        return;
      }

      let beforeFiles: RunWorkspaceFile[] = [];
      try { beforeFiles = await active.prepared.snapshotWorkspace(); }
      catch (error) {
        console.warn(JSON.stringify({ event: 'background_task_workspace_snapshot_failed', phase: 'before', runId: active.record.runId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
      }
      current = await options.repo.get(active.record.runId);
      if (active.controller.signal.aborted || await waitForCancelBarrier(active) || !current || current.state !== 'queued') {
        await stopBeforeExecution(active, lease);
        lease = undefined;
        return;
      }

      const startedAt = now();
      const deadlineMs = startedAt + active.prepared.timeoutMs;
      const initialMetadata = {
        ...(active.record.metadata ?? {}),
        workspaceDir: active.prepared.workspaceDir,
        beforeFiles,
        outputFiles: [],
        noticeDeliveries: [],
      };
      const running = await transition(active.record.runId, ['queued'], {
        state: 'running',
        startedAt: iso(startedAt),
        deadline: iso(deadlineMs),
        metadata: initialMetadata,
      });
      if (!running || running.state !== 'running') {
        await stopBeforeExecution(active, lease);
        lease = undefined;
        return;
      }
      active.record = running;

      // A queued host confirmation can be cancelled while it holds a granted but unstarted
      // lease. Recheck the barrier and durable state after the running CAS, then start the lease
      // and prepared operation without an intervening await.
      current = await options.repo.get(active.record.runId);
      if (active.controller.signal.aborted || !current || current.state !== 'running') {
        await stopBeforeExecution(active, lease);
        lease = undefined;
        return;
      }
      while (active.cancelBarrier) {
        const barrier = active.cancelBarrier;
        if (await barrier.promise) {
          await stopBeforeExecution(active, lease);
          lease = undefined;
          return;
        }
        current = await options.repo.get(active.record.runId);
        if (active.controller.signal.aborted || !current || current.state !== 'running') {
          await stopBeforeExecution(active, lease);
          lease = undefined;
          return;
        }
      }
      active.executionStarted = true;
      lease.start();

      let progressWrites = Promise.resolve();
      const onStep = (text: string): void => {
        progressWrites = progressWrites.then(async () => {
          try {
            const latest = await options.repo.get(active.record.runId);
            if (!latest || latest.state !== 'running') return;
            await transition(active.record.runId, ['running'], { lastProgress: text.slice(0, 300) });
          } catch (error) {
            console.warn(JSON.stringify({ event: 'background_task_progress_persist_failed', runId: active.record.runId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
          }
        });
      };
      let noticeSeq = 0;
      const onNotice = active.input.trusted.onBackgroundNotice
        ? async (text: string): Promise<void> => {
          await active.input.trusted.onBackgroundNotice!(text);
          noticeSeq += 1;
          const latest = await options.repo.get(active.record.runId);
          if (!latest || latest.state !== 'running') throw new Error('后台任务状态已变化，计划通知未能登记。');
          const noticeDeliveries = [
            ...((latest.metadata?.noticeDeliveries as Array<{ noticeId: string; text: string; status: 'sent' }> | undefined) ?? []),
            { noticeId: `${active.record.runId}:notice:${noticeSeq}`, text, status: 'sent' as const },
          ];
          const saved = await transition(active.record.runId, ['running'], {
            metadata: { ...(latest.metadata ?? {}), noticeDeliveries },
          });
          if (!saved || saved.state !== 'running') throw new Error('后台通知已送达，但通知回执未能保存；Worker 已暂停。');
          active.record = saved;
        }
        : undefined;

      try {
        result = await active.prepared.execute({
          background: true,
          backgroundRunId: active.record.runId,
          signal: active.controller.signal,
          lease,
          startedAt,
          deadline: deadlineMs,
          onStep,
          ...(onNotice ? { onNotice } : {}),
        });
      } catch (error) {
        executionError = error;
      } finally {
        // Free the shared browser/platform profile before awaiting persistence or any session event consumer.
        lease.release();
        lease = undefined;
      }
      await progressWrites;

      let afterFiles: RunWorkspaceFile[] = [];
      try { afterFiles = await active.prepared.snapshotWorkspace(); }
      catch (error) {
        console.warn(JSON.stringify({ event: 'background_task_workspace_snapshot_failed', phase: 'after', runId: active.record.runId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
      }
      const latest = await options.repo.get(active.record.runId);
      const baseMetadata = latest?.metadata ?? active.record.metadata ?? {};
      const metadata = {
        ...baseMetadata,
        workspaceDir: active.prepared.workspaceDir,
        beforeFiles: (baseMetadata.beforeFiles as RunWorkspaceFile[] | undefined) ?? beforeFiles,
        outputFiles: outputDiff(beforeFiles, afterFiles),
      };

      let state: Extract<TaskRunState, 'completed' | 'failed' | 'cancelled' | 'waiting_input' | 'waiting_confirmation'>;
      let errorText: string | undefined;
      if (executionError !== undefined) {
        state = active.controller.signal.aborted || executionError instanceof PlatformExecutionAbortedError ? 'cancelled' : 'failed';
        if (state === 'failed') errorText = safeError(executionError);
      } else if (result) {
        state = resultState(result);
      } else {
        state = 'failed';
        errorText = '后台 Worker 没有返回结果。';
      }
      const updated = await persistTerminal(active, state, {
        ...(result ? { result, resultText: result.text } : {}),
        ...(errorText ? { error: errorText } : {}),
        metadata,
        deliveryState: active.record.deliveryRoute ? 'pending' : 'not_required',
      });
      activeTasks.delete(active.record.taskId);
      scheduleDispatch(active, updated, result, updated.error);
    } catch (error) {
      if (lease) lease.release();
      const current = await options.repo.get(active.record.runId).catch(() => null);
      if (current && isTerminal(current.state)) {
        activeTasks.delete(active.record.taskId);
        scheduleDispatch(active, current, current.result as SubagentTaskResult | undefined, current.error);
        return;
      }
      const terminalState = active.controller.signal.aborted ? 'cancelled' : 'failed';
      const updated = await persistTerminal(active, terminalState, {
        ...(terminalState === 'failed' ? { error: safeError(error) } : {}),
        deliveryState: active.record.deliveryRoute ? 'pending' : 'not_required',
      });
      activeTasks.delete(active.record.taskId);
      scheduleDispatch(active, updated, undefined, updated.error);
    } finally {
      activeRuns.delete(active.record.runId);
      activeTasks.delete(active.record.taskId);
    }
  }

  async function submitNew(input: BackgroundTaskSubmitInput): Promise<TaskReceipt> {
    const prepare = options.runner.prepare;
    if (!prepare) throw new ToolUserError('后台任务执行器未提供稳定任务准备接口。');
    const prepared = await prepare.call(options.runner, input.args, { trusted: input.trusted });
    return submitPreparedNew({
      dispatchKey: input.dispatchKey,
      prepared,
      trusted: input.trusted,
      originMessage: input.originMessage,
      ...(input.originUserEventId ? { originUserEventId: input.originUserEventId } : {}),
      ...(input.inputContext ? { inputContext: input.inputContext } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.step ? { step: input.step } : {}),
      metadata: {
        ...(input.args.entitySources ? { entitySources: structuredClone(input.args.entitySources) } : {}),
        ...(input.args.stepLabel ? { stepLabel: input.args.stepLabel } : {}),
      },
    });
  }

  async function submitPreparedNew(input: PreparedBackgroundTaskSubmitInput): Promise<TaskReceipt> {
    const prepared = input.prepared;
    if (activeTasks.has(prepared.taskId) || reservedTasks.has(prepared.taskId)) {
      throw new ToolUserError('该任务已有 Worker 正在排队或运行，请先查询或取消后再继续。');
    }
    // 同步预留（TOCTOU）：检查与预留之间不得出现任何 await——同 taskId、不同 dispatchKey
    // 的并发提交（taskEventDispatchKey 与 userDispatchKey 同拍到达）曾可双双通过检查，
    // 各建一条 queued run、各起一个 Worker 写同一 tmp/task_<taskId> 工作区。所有失败
    // 路径统一由下方 catch 回收；成功路径在 activeTasks.add 之后释放。
    reservedTasks.add(prepared.taskId);
    try {
      return await submitPreparedReserved(input, prepared);
    } catch (error) {
      reservedTasks.delete(prepared.taskId);
      throw error;
    }
  }

  async function submitPreparedReserved(input: PreparedBackgroundTaskSubmitInput, prepared: PreparedContextTaskRun): Promise<TaskReceipt> {
    const priorRuns = await options.repo.listBySession(input.trusted.principalId, input.trusted.sessionId);
    if (priorRuns.some((run) => run.taskId === prepared.taskId && ACTIVE_STATES.includes(run.state))) {
      throw new ToolUserError('该任务已有 Worker 正在排队或运行，请先查询或取消后再继续。');
    }

    const controller = new AbortController();
    let ticket: PlatformExecutionTicket;
    try {
      ticket = options.executionGate.enqueue({ requestId: input.trusted.requestId, signal: controller.signal });
    } catch (error) {
      if (error instanceof PlatformExecutionQueueFullError) throw new ToolUserError('平台执行队列已满，请稍后重试。');
      throw error;
    }

    const createdAt = iso(now());
    const runId = newId();
    let frozenInputs: unknown[] = [];
    try {
      frozenInputs = await prepared.materializeInputs?.(runId) ?? [];
    } catch (error) {
      ticket.cancel();
      throw error instanceof ToolUserError ? error : new ToolUserError(safeError(error));
    }
    const priorTaskRuns = priorRuns.filter((run) => run.taskId === prepared.taskId);
    const existingLabel = [...priorTaskRuns].reverse()
      .map((run) => run.metadata?.label)
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    const taskNumber = new Set(priorRuns.map((run) => run.taskId)).size + 1;
    const summary = requestSummary(input, input.metadata);
    const label = existingLabel ?? `任务 ${taskNumber} · ${summary}`;
    const record: TaskRunRecord = {
      runId,
      taskId: prepared.taskId,
      dispatchKey: input.dispatchKey,
      principalId: input.trusted.principalId,
      sessionId: input.trusted.sessionId,
      originRequestId: input.trusted.requestId,
      originUserEventId: input.originUserEventId ?? `${input.trusted.requestId}:user`,
      request: prepared.request,
      originMessage: input.metadata?.kind === 'host_confirmation' ? '用户已确认待处理操作' : input.originMessage,
      createdAt,
      updatedAt: createdAt,
      state: 'queued',
      resultEventId: `${RESULT_EVENT_PREFIX}${runId}`,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.step ? { stepIndex: input.step.stepIndex, totalSteps: input.step.totalSteps } : {}),
      ...(input.inputContext ? { inputContext: structuredClone(input.inputContext) } : {}),
      ...(input.trusted.deliveryRoute ? { deliveryRoute: structuredClone(input.trusted.deliveryRoute) } : {}),
      deliveryState: input.trusted.deliveryRoute ? 'pending' : 'not_required',
      metadata: {
        workspaceDir: prepared.workspaceDir,
        ...(frozenInputs.length > 0 ? { inputFiles: structuredClone(frozenInputs) } : {}),
        ...(input.metadata ? structuredClone(input.metadata) : {}),
        label,
        requestSummary: summary,
      },
    };
    try {
      // 停机窗口收口·前半（D-132b）：submitIdempotently 的入口检查之后隔着 prepare、
      // materializeInputs 等多个 await——停机在这些 await 里置位时，提交会带着"已排队"
      // 回执照常落库并调度。落库前再查一次 stopping，命中即以与入口同句的用户错误拒绝
      // （用户拿到的是诚实的重试提示，不是假回执）；ticket 由本 try 的 catch 回收，
      // reserved 由 submitPreparedNew 的 catch 释放。
      if (stopping) throw new ToolUserError(STOPPING_REJECT_MESSAGE);
      const saved = await options.repo.createOrGetByDispatchKey(record);
      if (saved.runId !== runId) {
        ticket.cancel();
        reservedTasks.delete(prepared.taskId);
        return receiptFor(saved);
      }
      const active: ActiveRun = {
        input,
        prepared,
        record: saved,
        controller,
        ticket,
        execution: Promise.resolve(),
        eventDispatched: false,
        executionStarted: false,
      };
      activeRuns.set(runId, active);
      activeTasks.add(prepared.taskId);
      reservedTasks.delete(prepared.taskId);
      scheduleTask(active);
      return receiptFor(saved);
    } catch (error) {
      ticket.cancel();
      throw error;
    }
  }

  async function submitIdempotently(dispatchKey: string, create: () => Promise<TaskReceipt>): Promise<TaskReceipt> {
    if (stopping) throw new ToolUserError(STOPPING_REJECT_MESSAGE);
    const existing = await options.repo.getByDispatchKey(dispatchKey);
    if (existing) return receiptFor(existing);
    const pending = inFlightDispatches.get(dispatchKey);
    if (pending) return pending;
    const promise = create();
    inFlightDispatches.set(dispatchKey, promise);
    try {
      return await promise;
    } finally {
      if (inFlightDispatches.get(dispatchKey) === promise) inFlightDispatches.delete(dispatchKey);
    }
  }

  return {
    submit: (input) => submitIdempotently(input.dispatchKey, () => submitNew(input)),
    submitPrepared: (input) => submitIdempotently(input.dispatchKey, () => submitPreparedNew(input)),
    /** Returns task runs newest registration first; TaskRunRepo preserves registration order. */
    async list(scope) {
      const rows = await options.repo.listBySession(scope.principalId, scope.sessionId);
      return rows.reverse();
    },
    get: latestForTask,
    async cancel(scope, taskId) {
      const current = await latestForTask(scope, taskId);
      if (!current) return { found: false, taskId, requested: false };
      const active = activeRuns.get(current.runId);

      const isHostConfirmation = current.metadata?.kind === 'host_confirmation';
      if (isHostConfirmation && (current.state === 'queued' || (current.state === 'running' && active && !active.executionStarted))) {
        if (!options.onCancelPending) {
          return { found: true, taskId, runId: current.runId, state: current.state, requested: false };
        }
        if (active?.cancelBarrier) {
          await active.cancelBarrier.promise;
          const latest = await options.repo.get(current.runId);
          return { found: true, taskId, runId: current.runId, state: latest?.state ?? current.state, requested: false };
        }

        // This in-memory barrier is installed synchronously before awaiting host invalidation.
        // A gate grant may happen during the await, but execute() cannot start the operation.
        if (active && !active.executionStarted) installCancelBarrier(active);
        let invalidated = false;
        try { invalidated = await options.onCancelPending(current, scope); }
        catch (error) {
          console.error(JSON.stringify({ event: 'background_task_pending_cancel_failed', runId: current.runId, taskId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
        }
        if (!invalidated) {
          if (active) settleCancelBarrier(active, false);
          const latest = await options.repo.get(current.runId);
          return { found: true, taskId, runId: current.runId, state: latest?.state ?? current.state, requested: false };
        }

        const cancellationResult = { taskId, text: '任务已取消。' };
        let updated: TaskRunRecord | null = null;
        try {
          updated = await transition(current.runId, ['queued', 'running', 'cancelling'], {
            state: 'cancelled',
            endedAt: iso(now()),
            resultEventId: `${current.runId}:cancelled`,
            result: cancellationResult,
            resultText: cancellationResult.text,
            error: undefined,
          });
        } catch (error) {
          console.error(JSON.stringify({ event: 'background_task_pending_cancel_state_failed', runId: current.runId, taskId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
        }
        if (active) {
          // The authorization is now invalidated. Even if persistence had a transient failure,
          // do not let this prepared commit reach its execute method.
          active.controller.abort();
          active.ticket.cancel();
          settleCancelBarrier(active, true);
        }
        const latest = updated ?? await options.repo.get(current.runId);
        if (latest?.state === 'cancelled') {
          if (active) scheduleDispatch(active, latest, cancellationResult);
          else await emitTerminal(latest, cancellationResult);
        }
        return { found: true, taskId, runId: current.runId, state: latest?.state ?? current.state, requested: false };
      }

      if (current.state === 'queued') {
        const updated = await transition(current.runId, ['queued'], {
          state: 'cancelled',
          endedAt: iso(now()),
          resultEventId: current.resultEventId ?? `${RESULT_EVENT_PREFIX}${current.runId}`,
          deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
        });
        active?.controller.abort();
        active?.ticket.cancel();
        if (updated && isTerminal(updated.state) && !active) await emitTerminal(updated, undefined, updated.error);
        return { found: true, taskId, runId: current.runId, state: updated?.state ?? current.state, requested: false };
      }
      if (current.state === 'running') {
        const updated = await transition(current.runId, ['running'], { state: 'cancelling' });
        active?.controller.abort();
        return { found: true, taskId, runId: current.runId, state: updated?.state ?? 'cancelling', requested: true };
      }
      if (current.state === 'cancelling') {
        active?.controller.abort();
        return { found: true, taskId, runId: current.runId, state: 'cancelling', requested: true };
      }
      if (current.state === 'waiting_input') {
        const cancellationResult = { taskId, text: '任务已取消。' };
        const updated = await transition(current.runId, ['waiting_input'], {
          state: 'cancelled',
          endedAt: iso(now()),
          resultEventId: `${current.runId}:cancelled`,
          result: cancellationResult,
          resultText: cancellationResult.text,
          error: undefined,
        });
        if (updated?.state === 'cancelled') await emitTerminal(updated, cancellationResult);
        return { found: true, taskId, runId: current.runId, state: updated?.state ?? current.state, requested: false };
      }
      if (current.state === 'waiting_confirmation') {
        if (!options.onCancelPending) {
          return { found: true, taskId, runId: current.runId, state: current.state, requested: false };
        }
        let invalidated = false;
        try { invalidated = await options.onCancelPending(current, scope); }
        catch (error) {
          console.error(JSON.stringify({ event: 'background_task_pending_cancel_failed', runId: current.runId, taskId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
        }
        if (!invalidated) {
          const latest = await options.repo.get(current.runId);
          return { found: true, taskId, runId: current.runId, state: latest?.state ?? current.state, requested: false };
        }
        const cancellationResult = { taskId, text: '任务已取消。' };
        const updated = await transition(current.runId, ['waiting_confirmation'], {
          state: 'cancelled',
          endedAt: iso(now()),
          resultEventId: `${current.runId}:cancelled`,
          result: cancellationResult,
          resultText: cancellationResult.text,
          error: undefined,
        });
        if (updated?.state === 'cancelled') await emitTerminal(updated, cancellationResult);
        return { found: true, taskId, runId: current.runId, state: updated?.state ?? current.state, requested: false };
      }
      return { found: true, taskId, runId: current.runId, state: current.state, requested: false };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async recoverInterrupted(at = iso(now())) {
      return options.repo.interruptActive(at);
    },
    async shutdown(shutdownOptions = {}) {
      stopping = true;
      for (const active of activeRuns.values()) {
        const current = await options.repo.get(active.record.runId);
        if (!current || isTerminal(current.state)) continue;
        const unstartedHostConfirmation = current.metadata?.kind === 'host_confirmation'
          && !active.executionStarted
          && ['queued', 'running'].includes(current.state);
        if (unstartedHostConfirmation) {
          // Shutdown interrupts this receipt but does not revoke its still-valid host approval.
          // The user may confirm it again after service recovery.
          await transition(current.runId, ['queued', 'running'], {
            state: 'interrupted',
            endedAt: iso(now()),
            resultEventId: current.resultEventId ?? `${RESULT_EVENT_PREFIX}${current.runId}`,
            deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
          });
          active.ticket.cancel();
          settleCancelBarrier(active, true);
        } else if (current.state === 'queued') {
          await transition(current.runId, ['queued'], {
            state: 'cancelled',
            endedAt: iso(now()),
            resultEventId: current.resultEventId ?? `${RESULT_EVENT_PREFIX}${current.runId}`,
            deliveryState: current.deliveryRoute ? 'pending' : 'not_required',
          });
          active.ticket.cancel();
        } else if (current.state === 'running') {
          await transition(current.runId, ['running'], { state: 'cancelling' });
        }
        active.controller.abort();
      }
      const drainMs = Math.max(0, shutdownOptions.drainMs ?? 5_000);
      if (drainMs === 0) return;
      const drainUntil = Date.now() + drainMs;
      while (Date.now() < drainUntil) {
        const active = [...activeRuns.values()].map((run) => run.execution);
        const dispatches = [...pendingDispatches];
        if (active.length === 0 && dispatches.length === 0) return;
        const remainingMs = drainUntil - Date.now();
        await Promise.race([
          Promise.allSettled([...active, ...dispatches]).then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs, 50))),
        ]);
      }
    },
  };
}
