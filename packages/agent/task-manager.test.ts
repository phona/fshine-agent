import { describe, expect, it, vi } from 'vitest';
import type {
  BackgroundTaskEvent,
  TaskRunRecord,
  TaskRunRepo,
  TaskRunState,
  TrustedContext,
} from '@fshine/contracts';
import type { ContextTaskRunner, ContextTaskRunArgs, PreparedContextTaskRun, SubagentTaskResult } from './src/context';
import { ToolUserError } from './src/driver';
import { createPlatformExecutionGate } from './src/platform-execution-gate';
import { createBackgroundTaskManager } from './src/task-manager';

class MemoryTaskRuns implements TaskRunRepo {
  readonly records = new Map<string, TaskRunRecord>();
  async createOrGetByDispatchKey(record: TaskRunRecord) {
    const existing = [...this.records.values()].find((item) => item.dispatchKey === record.dispatchKey);
    if (existing) return structuredClone(existing);
    this.records.set(record.runId, structuredClone(record));
    return structuredClone(record);
  }
  async get(runId: string) { return structuredClone(this.records.get(runId) ?? null); }
  async getByDispatchKey(key: string) {
    const record = [...this.records.values()].find((item) => item.dispatchKey === key);
    return structuredClone(record ?? null);
  }
  async listBySession(principalId: string, sessionId: string) {
    return [...this.records.values()]
      .filter((item) => item.principalId === principalId && item.sessionId === sessionId)
      .map((item) => structuredClone(item));
  }
  async transition(runId: string, expected: readonly TaskRunState[], patch: Partial<TaskRunRecord>, revision?: number) {
    const current = this.records.get(runId);
    if (!current || !expected.includes(current.state) || (revision !== undefined && current.revision !== revision)) return false;
    const next = { ...current, ...structuredClone(patch), revision: (current.revision ?? 0) + 1 };
    this.records.set(runId, next);
    return true;
  }
  async listPinnedTaskIds() { return []; }
  async interruptActive(now: string) {
    let count = 0;
    for (const [runId, row] of this.records) {
      if (!['queued', 'running', 'cancelling'].includes(row.state)) continue;
      this.records.set(runId, { ...row, state: 'interrupted', endedAt: now, updatedAt: now, revision: (row.revision ?? 0) + 1 });
      count += 1;
    }
    return count;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function trusted(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'request-1', principalId: 'wecom:user-1', sessionId: 'session-1', ...overrides };
}

function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await predicate()) { resolve(); return; }
      if (Date.now() - started > 2_000) { reject(new Error('timed out waiting for task manager state')); return; }
      setTimeout(poll, 0);
    };
    poll();
  });
}

interface RunnerHarness {
  runner: ContextTaskRunner;
  executions: Array<{ taskId: string; deadline: number; signal?: AbortSignal }>;
  preparedCount: number;
}

function mockRunner(args: {
  timeoutMs?: number;
  execute?: (input: { prepared: PreparedContextTaskRun; options: Parameters<PreparedContextTaskRun['execute']>[0] }) => Promise<SubagentTaskResult>;
  snapshots?: Array<Array<{ path: string; relativePath: string; size: number; sha256: string }>>;
  /** 覆盖 before/after 快照（可按 taskId 卡住，用于把"提交"与"执行开始"分开）。 */
  snapshotWorkspace?: (taskId: string) => Promise<Array<{ path: string; relativePath: string; size: number; sha256: string }>>;
} = {}): RunnerHarness {
  let taskSeq = 0;
  const executions: RunnerHarness['executions'] = [];
  let preparedCount = 0;
  const runner: ContextTaskRunner = {
    tool: { name: 'run_task', description: 'test', inputSchema: {} },
    run: async () => { throw new Error('manager must execute the prepared handle'); },
    prepare: async (requestArgs: ContextTaskRunArgs) => {
      preparedCount += 1;
      const taskId = requestArgs.taskId ?? `task-${++taskSeq}`;
      let snapshotIndex = 0;
      const prepared: PreparedContextTaskRun = {
        taskId,
        request: requestArgs.request,
        timeoutMs: args.timeoutMs ?? 100,
        workspaceDir: `tmp/${taskId}`,
        snapshotWorkspace: async () => {
          if (args.snapshotWorkspace) return args.snapshotWorkspace(taskId);
          return args.snapshots?.[Math.min(snapshotIndex++, (args.snapshots?.length ?? 1) - 1)] ?? [];
        },
        execute: async (options) => {
          executions.push({ taskId, deadline: options.deadline, ...(options.signal ? { signal: options.signal } : {}) });
          if (args.execute) return args.execute({ prepared, options });
          return { taskId, text: 'done' };
        },
      };
      return prepared;
    },
  };
  return { runner, executions, get preparedCount() { return preparedCount; } };
}

function input(dispatchKey: string, overrides: Partial<Parameters<ReturnType<typeof createBackgroundTaskManager>['submit']>[0]> = {}) {
  return {
    dispatchKey,
    args: { request: 'query test' },
    trusted: trusted(),
    originMessage: 'original user request',
    ...overrides,
  };
}

describe('BackgroundTaskManager', () => {
  it('persists real IDs before returning, deduplicates dispatch keys, and emits only after terminal persistence', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const completion = deferred<SubagentTaskResult>();
    const harness = mockRunner({ execute: () => completion.promise });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate, newId: (() => { let i = 0; return () => `run-${++i}`; })() });
    const seen: BackgroundTaskEvent[] = [];
    manager.subscribe(async (event) => {
      const persisted = await repo.get(event.run.runId);
      expect(persisted?.state).toBe('completed');
      expect(persisted?.resultEventId).toBe(event.eventId);
      expect(gate.snapshot().active).toBe(0);
      seen.push(event);
    });

    const receipt = await manager.submit(input('dispatch-1'));
    const registered = await repo.get(receipt.runId);
    expect(receipt).toMatchObject({ taskId: 'task-1', runId: 'run-1', state: 'queued' });
    expect(registered).toMatchObject({ taskId: 'task-1', runId: 'run-1', state: 'queued', dispatchKey: 'dispatch-1' });
    expect(harness.executions).toHaveLength(0);
    const duplicate = await manager.submit(input('dispatch-1'));
    expect(duplicate).toEqual(receipt);
    expect(harness.preparedCount).toBe(1);

    await waitFor(() => harness.executions.length === 1);
    completion.resolve({ taskId: 'task-1', text: 'done' });
    await waitFor(() => seen.length === 1);
    expect(seen[0]?.eventId).toBe(`task-run:${receipt.runId}`);
    expect(seen[0]?.result).toMatchObject({ taskId: 'task-1', text: 'done' });
    const terminalReplay = await manager.submit(input('dispatch-1'));
    expect(terminalReplay).toMatchObject({ runId: receipt.runId, state: 'completed' });
    expect(harness.preparedCount).toBe(1);
    const resumed = await manager.submit(input('dispatch-resume', {
      args: { request: '补充期间信息', taskId: receipt.taskId },
      originMessage: '补充期间信息',
    }));
    expect(resumed.taskId).toBe(receipt.taskId);
    expect(resumed.label).toBe(receipt.label);
    await waitFor(() => seen.length === 2);
    await manager.shutdown({ drainMs: 100 });
  });

  it('cancels a task before its Worker starts so the platform operation never runs', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const first = deferred<SubagentTaskResult>();
    const executions: string[] = [];
    const harness = mockRunner({ execute: async ({ prepared }) => { executions.push(prepared.taskId); return prepared.taskId === 'task-1' ? first.promise : { taskId: prepared.taskId, text: 'second' }; } });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate });
    const firstReceipt = await manager.submit(input('first'));
    await waitFor(() => executions.includes('task-1'));
    const secondReceipt = await manager.submit(input('second'));
    expect((await repo.get(secondReceipt.runId))?.state).toBe('queued');

    // 准入闸不再排队等待（并发容忍归执行层），第二件作业已获准但 Worker 尚未启动；
    // 在这个窗口里取消，执行阶段必须看到终态而直接收束、不产生平台调用。
    const cancelled = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, secondReceipt.taskId);
    expect(cancelled).toMatchObject({ found: true, state: 'cancelled', requested: false });
    first.resolve({ taskId: firstReceipt.taskId, text: 'first done' });
    await waitFor(async () => (await repo.get(firstReceipt.runId))?.state === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executions).toEqual(['task-1']);
    expect((await repo.get(secondReceipt.runId))?.state).toBe('cancelled');
    await manager.shutdown({ drainMs: 100 });
  });

  it('starts the Worker deadline at execution start (no queue wait) and freezes run output and ACKed notices', async () => {
    const repo = new MemoryTaskRuns();
    let now = 100;
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const first = deferred<SubagentTaskResult>();
    const secondSnapshotStarted = deferred<void>();
    const releaseSecondSnapshot = deferred<void>();
    let secondSnapshotCalls = 0;
    const snapshots = [
      [{ path: '/platform/tmp/task-2/old.xlsx', relativePath: 'old.xlsx', size: 1, sha256: 'old' }],
      [{ path: '/platform/tmp/task-2/old.xlsx', relativePath: 'old.xlsx', size: 2, sha256: 'changed' }, { path: '/platform/tmp/task-2/new.xlsx', relativePath: 'new.xlsx', size: 3, sha256: 'new' }],
    ];
    const harness = mockRunner({
      timeoutMs: 500,
      snapshots,
      // 卡住 task-2 的 before 快照：提交已经完成，但执行还没走到 startedAt=now()。
      // 只有在这之后推进时钟，deadline 断言才能区分"提交时算"与"执行开始时算"。
      snapshotWorkspace: async (taskId) => {
        if (taskId !== 'task-2') return snapshots[0]!;
        const index = secondSnapshotCalls++;
        if (index === 0) {
          secondSnapshotStarted.resolve();
          await releaseSecondSnapshot.promise;
        }
        return snapshots[Math.min(index, snapshots.length - 1)]!;
      },
      execute: async ({ prepared, options }) => {
        if (prepared.taskId === 'task-1') return first.promise;
        await options.onNotice?.('计划通知：确认扩大范围');
        return { taskId: prepared.taskId, text: 'done', pendingPlan: { taskId: prepared.taskId } as never };
      },
    });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate, now: () => now });
    const noticeAck = vi.fn(async () => {});
    const firstReceipt = await manager.submit(input('first'));
    await waitFor(() => harness.executions.length === 1);
    const secondReceipt = await manager.submit(input('second', { trusted: trusted({ onBackgroundNotice: noticeAck }) }));
    await secondSnapshotStarted.promise;
    // 提交已完成（时钟 100），执行开始被快照卡住；推进到 5000 再放行。
    now = 5_000;
    releaseSecondSnapshot.resolve();
    await waitFor(() => harness.executions.length === 2);
    const started = harness.executions.find((item) => item.taskId === secondReceipt.taskId)!;
    // 2026-11-10 仲裁后没有宿主等待队列：deadline 从执行开始起算（5000 + 500），
    // 不是在 submit 时（100 + 500）预先算好。
    expect(started.deadline).toBe(5_500);
    await waitFor(async () => (await repo.get(secondReceipt.runId))?.state === 'waiting_confirmation');
    const record = await repo.get(secondReceipt.runId);
    expect(noticeAck).toHaveBeenCalledWith('计划通知：确认扩大范围');
    expect(record?.metadata).toMatchObject({
      workspaceDir: `tmp/${secondReceipt.taskId}`,
      outputFiles: [
        { relativePath: 'old.xlsx', size: 2, sha256: 'changed' },
        { relativePath: 'new.xlsx', size: 3, sha256: 'new' },
      ],
      noticeDeliveries: [{ noticeId: `${secondReceipt.runId}:notice:1`, text: '计划通知：确认扩大范围', status: 'sent' }],
    });
    first.resolve({ taskId: firstReceipt.taskId, text: 'first done' });
    await waitFor(async () => (await repo.get(firstReceipt.runId))?.state === 'completed');
    await manager.shutdown({ drainMs: 100 });
  });

  it('keeps the slot through running cancellation cleanup and lets an already-completed result win the race', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 2 });
    const completion = deferred<SubagentTaskResult>();
    const harness = mockRunner({ execute: () => completion.promise });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate });
    const events: BackgroundTaskEvent[] = [];
    manager.subscribe(async (event) => {
      expect(gate.snapshot().active).toBe(0);
      expect((await repo.get(event.run.runId))?.state).toBe('completed');
      events.push(event);
    });
    const receipt = await manager.submit(input('running-cancel'));
    await waitFor(() => harness.executions.length === 1);

    const cancelReceipt = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    expect(cancelReceipt).toMatchObject({ state: 'cancelling', requested: true });
    expect(gate.snapshot().active).toBe(1);
    expect(events).toHaveLength(0);
    completion.resolve({ taskId: receipt.taskId, text: 'finished before abort took effect' });
    await waitFor(() => events.length === 1);
    expect((await repo.get(receipt.runId))?.state).toBe('completed');
    await manager.shutdown({ drainMs: 100 });
  });

  it('persists failed state and stable result event identity before notifying subscribers', async () => {
    const repo = new MemoryTaskRuns();
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async () => { throw new Error('controlled failure'); } }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
    });
    let observed = false;
    manager.subscribe(async (event) => {
      const persisted = await repo.get(event.run.runId);
      expect(persisted?.state).toBe('failed');
      expect(persisted?.resultEventId).toBe(event.eventId);
      expect(event.error).toBe('controlled failure');
      observed = true;
    });
    await manager.submit(input('failing'));
    await waitFor(() => observed);
    await manager.shutdown({ drainMs: 100 });
  });

  it('submits a prepared host confirmation through the same gate without exposing its confirmation code', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const materializeInputs = vi.fn(async () => [{ sourcePath: '/upload/source.xlsx', path: '/platform/tmp/task-host/.inputs/run-host/1_source.xlsx', filename: 'source.xlsx', size: 4, sha256: 'hash' }]);
    const prepared: PreparedContextTaskRun = {
      taskId: 'task-host',
      request: '用户确认了待处理操作。',
      timeoutMs: 1_000,
      workspaceDir: 'tmp/task-host',
      materializeInputs,
      snapshotWorkspace: async () => [],
      execute: async () => ({ taskId: 'task-host', text: '确认完成。', hostConfirmationOutcome: 'confirm_executed' }),
    };
    const manager = createBackgroundTaskManager({ runner: mockRunner().runner, repo, executionGate: gate, newId: () => 'run-host' });
    const seen: BackgroundTaskEvent[] = [];
    manager.subscribe(async (event) => {
      expect(gate.snapshot().active).toBe(0);
      expect((await repo.get(event.run.runId))?.state).toBe('completed');
      seen.push(event);
    });
    const receipt = await manager.submitPrepared({
      dispatchKey: 'confirm-request:host-confirmation',
      prepared,
      trusted: trusted(),
      originMessage: '用户已确认待处理操作',
      metadata: { kind: 'host_confirmation' },
    });
    const registered = await repo.get(receipt.runId);
    expect(receipt).toMatchObject({ taskId: 'task-host', runId: 'run-host', state: 'queued', label: '任务 1 · 确认待处理操作' });
    expect(registered?.originMessage).toBe('用户已确认待处理操作');
    expect(registered?.resultEventId).toBe('task-run:run-host');
    expect(registered?.metadata).toMatchObject({ kind: 'host_confirmation', inputFiles: [{ sha256: 'hash' }] });
    expect(materializeInputs).toHaveBeenCalledWith('run-host');
    await waitFor(() => seen.length === 1);
    expect(seen[0]?.result).toMatchObject({ hostConfirmationOutcome: 'confirm_executed' });
    expect((seen[0]?.result as { execution?: unknown })?.execution).toBeUndefined();
    await manager.shutdown({ drainMs: 100 });
  });

  it('blocks a queued host confirmation while cancellation invalidates its pending authorization', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 2 });
    const blockerResult = deferred<SubagentTaskResult>();
    const blockerStarted = deferred<void>();
    const invalidationStarted = deferred<void>();
    const finishInvalidation = deferred<boolean>();
    const executions: string[] = [];
    const hostExecute = vi.fn(async () => ({ taskId: 'task-host-cancel', text: '不应提交。', hostConfirmationOutcome: 'confirm_executed' as const }));
    const onCancelPending = vi.fn(async () => {
      invalidationStarted.resolve();
      return finishInvalidation.promise;
    });
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: ({ prepared }) => {
        executions.push(prepared.taskId);
        blockerStarted.resolve();
        return blockerResult.promise;
      } }).runner,
      repo,
      executionGate: gate,
      onCancelPending,
    });
    const blocker = await manager.submit(input('host-cancel-blocker'));
    await blockerStarted.promise;

    const hostReceipt = await manager.submitPrepared({
      dispatchKey: 'host-cancel-dispatch',
      prepared: {
        taskId: 'task-host-cancel', request: '用户确认了待处理操作。', timeoutMs: 1_000, workspaceDir: 'tmp/task-host-cancel',
        snapshotWorkspace: async () => [], execute: hostExecute,
      },
      trusted: trusted(),
      originMessage: '用户已确认待处理操作',
      metadata: { kind: 'host_confirmation' },
    });
    const cancelPromise = manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, hostReceipt.taskId);
    await invalidationStarted.promise;

    blockerResult.resolve({ taskId: blocker.taskId, text: 'done' });
    await waitFor(async () => (await repo.get(blocker.runId))?.state === 'completed' && gate.snapshot().active === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hostExecute).not.toHaveBeenCalled();

    finishInvalidation.resolve(true);
    const control = await cancelPromise;
    expect(onCancelPending).toHaveBeenCalledTimes(1);
    expect(control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    expect((await repo.get(hostReceipt.runId))?.state).toBe('cancelled');
    expect(hostExecute).not.toHaveBeenCalled();
    await manager.shutdown({ drainMs: 100 });
  });

  it('rechecks a cancellation barrier installed during the final pre-start state read', async () => {
    const repo = new MemoryTaskRuns();
    const finalReadStarted = deferred<void>();
    const releaseFinalRead = deferred<void>();
    const invalidationStarted = deferred<void>();
    const finishInvalidation = deferred<boolean>();
    const hostExecute = vi.fn(async () => ({ taskId: 'task-final-read-race', text: '不应提交。', hostConfirmationOutcome: 'confirm_executed' as const }));
    const onCancelPending = vi.fn(async () => {
      invalidationStarted.resolve();
      return finishInvalidation.promise;
    });
    const manager = createBackgroundTaskManager({
      runner: mockRunner().runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
      onCancelPending,
      newId: () => 'run-final-read-race',
    });
    const receipt = await manager.submitPrepared({
      dispatchKey: 'final-read-race',
      prepared: {
        taskId: 'task-final-read-race', request: '用户确认了待处理操作。', timeoutMs: 1_000, workspaceDir: 'tmp/task-final-read-race',
        snapshotWorkspace: async () => [], execute: hostExecute,
      },
      trusted: trusted(), originMessage: '用户已确认待处理操作', metadata: { kind: 'host_confirmation' },
    });

    const originalGet = repo.get.bind(repo);
    let runningReads = 0;
    repo.get = async (runId: string) => {
      const record = await originalGet(runId);
      if (runId === receipt.runId && record?.state === 'running') {
        runningReads += 1;
        // The first running read is transition()'s post-CAS fetch. Hold the manager's next
        // read so cancellation can install its barrier in the exact grant-to-start gap.
        if (runningReads === 2) {
          finalReadStarted.resolve();
          await releaseFinalRead.promise;
          return originalGet(runId);
        }
      }
      return record;
    };

    await finalReadStarted.promise;
    const cancellation = manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    await invalidationStarted.promise;
    releaseFinalRead.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hostExecute).not.toHaveBeenCalled();

    finishInvalidation.resolve(true);
    expect(await cancellation).toMatchObject({ state: 'cancelled', requested: false });
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    expect(hostExecute).not.toHaveBeenCalled();
    await manager.shutdown({ drainMs: 100 });
  });

  it('does not claim queued host confirmation cancellation without an invalidator', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 2 });
    const blockerResult = deferred<SubagentTaskResult>();
    const blockerStarted = deferred<void>();
    const hostStarted = deferred<void>();
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: ({ prepared }) => {
        if (prepared.taskId === 'task-1') { blockerStarted.resolve(); return blockerResult.promise; }
        hostStarted.resolve();
        return Promise.resolve({ taskId: prepared.taskId, text: '仍待确认。', hostConfirmationOutcome: 'confirm_held' });
      } }).runner,
      repo,
      executionGate: gate,
    });
    const blocker = await manager.submit(input('host-no-invalidator-blocker'));
    await blockerStarted.promise;
    const hostReceipt = await manager.submitPrepared({
      dispatchKey: 'host-no-invalidator-dispatch',
      prepared: {
        taskId: 'task-host-no-invalidator', request: '用户确认了待处理操作。', timeoutMs: 1_000, workspaceDir: 'tmp/task-host-no-invalidator',
        snapshotWorkspace: async () => [], execute: async () => { hostStarted.resolve(); return { taskId: 'task-host-no-invalidator', text: '仍待确认。', hostConfirmationOutcome: 'confirm_held' }; },
      },
      trusted: trusted(), originMessage: '用户已确认待处理操作', metadata: { kind: 'host_confirmation' },
    });

    const control = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, hostReceipt.taskId);
    expect(control).toMatchObject({ found: true, state: 'queued', requested: false });
    expect((await repo.get(hostReceipt.runId))?.state).toBe('queued');
    blockerResult.resolve({ taskId: blocker.taskId, text: 'done' });
    await hostStarted.promise;
    await waitFor(async () => (await repo.get(hostReceipt.runId))?.state === 'waiting_confirmation');
    await manager.shutdown({ drainMs: 100 });
  });

  it('marks a queued host confirmation interrupted on shutdown without revoking its authorization', async () => {
    const repo = new MemoryTaskRuns();
    const blockerResult = deferred<SubagentTaskResult>();
    const blockerStarted = deferred<void>();
    const hostExecute = vi.fn(async () => ({ taskId: 'task-shutdown-host', text: '不应在关停时提交。', hostConfirmationOutcome: 'confirm_executed' as const }));
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: () => { blockerStarted.resolve(); return blockerResult.promise; } }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 2 }),
      onCancelPending,
    });
    const blocker = await manager.submit(input('shutdown-host-blocker'));
    await blockerStarted.promise;
    const hostReceipt = await manager.submitPrepared({
      dispatchKey: 'shutdown-host-dispatch',
      prepared: {
        taskId: 'task-shutdown-host', request: '用户确认了待处理操作。', timeoutMs: 1_000, workspaceDir: 'tmp/task-shutdown-host',
        snapshotWorkspace: async () => [], execute: hostExecute,
      },
      trusted: trusted(), originMessage: '用户已确认待处理操作', metadata: { kind: 'host_confirmation' },
    });

    const shutdown = manager.shutdown({ drainMs: 500 });
    await waitFor(async () => (await repo.get(hostReceipt.runId))?.state === 'interrupted');
    expect(onCancelPending).not.toHaveBeenCalled();
    expect(hostExecute).not.toHaveBeenCalled();
    blockerResult.resolve({ taskId: blocker.taskId, text: 'done' });
    await shutdown;
    expect((await repo.get(hostReceipt.runId))?.state).toBe('interrupted');
    await manager.shutdown({ drainMs: 0 });
  });

  it('lists newest registrations first when same-time run IDs sort in the opposite order', async () => {
    const repo = new MemoryTaskRuns();
    const ids = ['z-old', 'a-new'];
    const manager = createBackgroundTaskManager({
      runner: mockRunner().runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 2 }),
      now: () => 1_000,
      newId: () => ids.shift()!,
    });
    const first = await manager.submit(input('same-time-old', { args: { request: 'first task', taskId: 'task-shared' } }));
    await waitFor(async () => (await repo.get(first.runId))?.state === 'completed');
    const second = await manager.submit(input('same-time-new', { args: { request: 'second task', taskId: 'task-shared' } }));
    await waitFor(async () => (await repo.get(second.runId))?.state === 'completed');

    expect(first.runId).toBe('z-old');
    expect(second.runId).toBe('a-new');
    expect((await manager.get({ principalId: 'wecom:user-1', sessionId: 'session-1' }, 'task-shared'))?.runId).toBe('a-new');
    expect((await manager.list({ principalId: 'wecom:user-1', sessionId: 'session-1' })).map((run) => run.runId)).toEqual(['a-new', 'z-old']);
    await manager.shutdown({ drainMs: 100 });
  });

  it('同 taskId、不同 dispatchKey 的并发提交只允许一个登记（TOCTOU：检查与预留之间不得有 await）', async () => {
    // 事故形状：taskEventDispatchKey 与 userDispatchKey 同拍到达（同 taskId、不同 key），
    // submitIdempotently 的按 key 去重拦不住；submitPreparedNew 的 reservedTasks.has 检查
    // 与 add 之间隔着 await listBySession，而 add 与 run 落库之间还隔着 await
    // materializeInputs（生产是真实附件拷贝，慢 I/O）。两个提交在两个窗口里交错时双双
    // 通过、各建一条 queued run、各起一个 Worker 写同一 tmp/task_<taskId> 工作区。
    // 复现：listBySession 与 materializeInputs 都人为延迟，使第二个提交的 list 在第一个
    // run 落库**之前**解析（第一窗口），两个 run 都落库（第二窗口）。
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const repo = new MemoryTaskRuns();
    const listNow = repo.listBySession.bind(repo);
    repo.listBySession = async (principalId: string, sessionId: string) => {
      await delay(10);
      return listNow(principalId, sessionId);
    };
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const runner: ContextTaskRunner = {
      tool: { name: 'run_task', description: 'test', inputSchema: {} },
      run: async () => { throw new Error('manager must execute the prepared handle'); },
      prepare: async (requestArgs: ContextTaskRunArgs) => {
        const prepared: PreparedContextTaskRun = {
          taskId: requestArgs.taskId ?? 'task-race',
          request: requestArgs.request,
          timeoutMs: 1_000,
          workspaceDir: `tmp/${requestArgs.taskId ?? 'task-race'}`,
          snapshotWorkspace: async () => [],
          materializeInputs: async () => { await delay(30); return []; },
          execute: async () => ({ taskId: requestArgs.taskId ?? 'task-race', text: 'done' }),
        };
        return prepared;
      },
    };
    const manager = createBackgroundTaskManager({ runner, repo, executionGate: gate });

    const settled = await Promise.allSettled([
      manager.submit(input('user-dispatch', { args: { request: '查幻辰应收', taskId: 'task-race' } })),
      manager.submit(input('event-dispatch', { args: { request: '查幻辰应收', taskId: 'task-race' } })),
    ]);

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ToolUserError);
    expect(reason.message).toContain('该任务已有 Worker 正在排队或运行');
    // 仓储里该 taskId 只有一条 run：不出现两个 Worker 写同一工作区
    const runs = (await listNow('wecom:user-1', 'session-1')).filter((run) => run.taskId === 'task-race');
    expect(runs).toHaveLength(1);
    await manager.shutdown({ drainMs: 100 });
  });

  it('cancels waiting confirmation only after the host invalidates its pending confirmation', async () => {
    const repo = new MemoryTaskRuns();
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({
        taskId: prepared.taskId,
        text: '等待确认。',
        proposalCreated: { proposalId: 'opaque-ref' },
      }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
      onCancelPending,
    });
    const eventIds: string[] = [];
    manager.subscribe(async (event) => { eventIds.push(event.eventId); });
    const receipt = await manager.submit(input('pending-confirmation'));
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'waiting_confirmation');

    const control = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    expect(onCancelPending).toHaveBeenCalledTimes(1);
    expect(control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    expect((await repo.get(receipt.runId))?.resultEventId).toBe(`${receipt.runId}:cancelled`);
    await waitFor(() => eventIds.length === 2);
    expect(eventIds[1]).toBe(`${receipt.runId}:cancelled`);
    await manager.shutdown({ drainMs: 100 });
  });

  it('取消等待确认的 run 不等投递链：终态投递排在调用方回合之后也要返回（P0 停机死等）', async () => {
    // 事故形状（2026-11-12 探针 run3：停机整轮 300s 零回复、后续消息全堵）：
    //   用户回合占着会话串行队列 → 回合内 task_control(cancel) → manager.cancel
    //   → 终态事件交给订阅者投递，而生产订阅者（assembly 的 handler.enqueueTaskEvent）
    //   把事件挂在**同一条**会话队列的队尾 → 就地 await 就是「自己等自己」：
    //   调用方等投递、投递等调用方所在的回合，那一回合永不返回。
    // 本用例用同构替身复现该等待环：订阅者把投递排在「当前回合」之后，而当前回合
    // 要等 cancel 返回才 resolve。cancel 返回 = 取消状态已持久化；投递随后照常送达。
    const repo = new MemoryTaskRuns();
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({
        taskId: prepared.taskId,
        text: '等待确认。',
        proposalCreated: { proposalId: 'opaque-ref' },
      }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
      onCancelPending,
    });
    const turn = deferred<void>();
    const delivered: string[] = [];
    let queueTail: Promise<void> = turn.promise;
    manager.subscribe(async (event) => {
      const prev = queueTail;
      const queued = prev.then(() => { delivered.push(event.eventId); });
      queueTail = queued;
      await queued;
    });
    const receipt = await manager.submit(input('stop-deadlock'));
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'waiting_confirmation');

    const outcome = await Promise.race([
      manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId)
        .then((control) => ({ kind: 'returned' as const, control })),
      new Promise<{ kind: 'deadlock' }>((resolve) => setTimeout(() => resolve({ kind: 'deadlock' }), 500)),
    ]);
    expect(outcome.kind).toBe('returned');
    if (outcome.kind === 'returned') {
      expect(outcome.control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    }
    // 取消状态的持久化独立于投递：cancel 返回时库里已是 cancelled（状态面不等投递）。
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    // 投递没有被丢掉：回合让出会话队列后，终态事件照常送达（失败恢复由库里
    // deliveryState=pending + 启动期清扫兜底，本用例只锁"不就地等待"这件事）。
    expect(delivered).toEqual([]);
    turn.resolve();
    await waitFor(() => delivered.includes(`${receipt.runId}:cancelled`));
    await manager.shutdown({ drainMs: 100 });
  });

  it('closes waiting-input runs without invoking the confirmation invalidator', async () => {
    const repo = new MemoryTaskRuns();
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({ taskId: prepared.taskId, text: '', needs: { missing: ['range'], reason: 'missing range' } }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
      onCancelPending,
    });
    const events: BackgroundTaskEvent[] = [];
    manager.subscribe(async (event) => { events.push(event); });
    const receipt = await manager.submit(input('waiting-input'));
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'waiting_input');

    const control = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    expect(control).toMatchObject({ state: 'cancelled', requested: false });
    expect(onCancelPending).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[1]?.run.state).toBe('cancelled');
    await manager.shutdown({ drainMs: 100 });
  });

  it('取消等待输入的 run：投递链被在飞事件占住时 cancel 仍立即返回；两个终态事件各恰投递一次', async () => {
    // 并发关系：取消发起时，该 run 的 waiting_input 终态事件可能**正在**被订阅者投递。
    // 投递链不因取消让路，取消也不得等它。终态事件共两条（等待输入 → 已取消），每条恰好
    // 一次：解耦不丢投递，也不重复投递。
    const repo = new MemoryTaskRuns();
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({ taskId: prepared.taskId, text: '', needs: { missing: ['range'], reason: 'missing range' } }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
    });
    const delivered: string[] = [];
    const releaseInflight = deferred<void>();
    let queueTail: Promise<void> = Promise.resolve();
    manager.subscribe(async (event) => {
      const queued = queueTail.then(() => releaseInflight.promise).then(() => { delivered.push(event.eventId); });
      queueTail = queued;
      await queued;
    });
    const receipt = await manager.submit(input('stop-waiting-input'));
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'waiting_input');
    await new Promise((resolve) => setImmediate(resolve)); // 监听器已进入第一跳投递

    const outcome = await Promise.race([
      manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId)
        .then((control) => ({ kind: 'returned' as const, control })),
      new Promise<{ kind: 'deadlock' }>((resolve) => setTimeout(() => resolve({ kind: 'deadlock' }), 500)),
    ]);
    expect(outcome.kind).toBe('returned');
    if (outcome.kind === 'returned') {
      expect(outcome.control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    }
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    expect(delivered).toEqual([]); // cancel 返回时在飞投递尚未完成——没有等它

    releaseInflight.resolve();
    await waitFor(() => delivered.includes(`${receipt.runId}:cancelled`));
    expect(delivered).toEqual([`task-run:${receipt.runId}`, `${receipt.runId}:cancelled`]);
    await manager.shutdown({ drainMs: 100 });
  });

  it('取消等待确认的 run：取消发生在监听器投递进行中，cancel 不等在飞投递；迟到终态事件恰一次', async () => {
    // 与上一条同构，但走 waiting_confirmation 分支（取消前需宿主作废待确认授权）。
    // 用户点名要的并发面：取消 → 不等待正在进行的投递 → 迟到的终态事件仍恰好投递一次。
    const repo = new MemoryTaskRuns();
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({
        taskId: prepared.taskId,
        text: '等待确认。',
        proposalCreated: { proposalId: 'opaque-ref' },
      }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
      onCancelPending,
    });
    const delivered: string[] = [];
    const releaseInflight = deferred<void>();
    let queueTail: Promise<void> = Promise.resolve();
    manager.subscribe(async (event) => {
      const queued = queueTail.then(() => releaseInflight.promise).then(() => { delivered.push(event.eventId); });
      queueTail = queued;
      await queued;
    });
    const receipt = await manager.submit(input('stop-inflight'));
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'waiting_confirmation');
    await new Promise((resolve) => setImmediate(resolve));

    const outcome = await Promise.race([
      manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId)
        .then((control) => ({ kind: 'returned' as const, control })),
      new Promise<{ kind: 'deadlock' }>((resolve) => setTimeout(() => resolve({ kind: 'deadlock' }), 500)),
    ]);
    expect(outcome.kind).toBe('returned');
    if (outcome.kind === 'returned') {
      expect(outcome.control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    }
    expect(onCancelPending).toHaveBeenCalledTimes(1);
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    expect(delivered).toEqual([]);

    releaseInflight.resolve();
    await waitFor(() => delivered.includes(`${receipt.runId}:cancelled`));
    expect(delivered).toEqual([`task-run:${receipt.runId}`, `${receipt.runId}:cancelled`]);
    await manager.shutdown({ drainMs: 100 });
  });

  it('取消已排期未启动的 queued run：cancel 立即返回落 cancelled，迟到的启动路径不起 Worker；同消息重投不重启', async () => {
    const repo = new MemoryTaskRuns();
    const snapshotEntered = deferred<void>();
    const releaseSnapshot = deferred<void>();
    let snapshotCalls = 0;
    const harness = mockRunner({
      snapshotWorkspace: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          snapshotEntered.resolve();
          await releaseSnapshot.promise;
        }
        return [];
      },
    });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: createPlatformExecutionGate({ maxQueue: 1 }) });
    const delivered: string[] = [];
    manager.subscribe(async (event) => { delivered.push(event.eventId); });
    const receipt = await manager.submit(input('stop-queued'));
    await snapshotEntered.promise;
    expect((await repo.get(receipt.runId))?.state).toBe('queued'); // Worker 已排期但尚未启动

    const control = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    expect(control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    expect(delivered).toEqual([]); // 终态投递由迟到的启动路径收尾，取消不等它

    releaseSnapshot.resolve();
    await waitFor(() => delivered.includes(`task-run:${receipt.runId}`));
    expect(harness.executions).toHaveLength(0); // 放行后启动路径看到终态，没有起 Worker
    expect(delivered).toEqual([`task-run:${receipt.runId}`]); // 恰好一次

    // 同一条消息（同 dispatchKey）重投：返回既有 cancelled 回执，不重启 Worker。
    const replay = await manager.submit(input('stop-queued'));
    expect(replay).toMatchObject({ runId: receipt.runId, state: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.preparedCount).toBe(1);
    expect(harness.executions).toHaveLength(0);
    await manager.shutdown({ drainMs: 100 });
  });

  it('取消运行中的 run：先返回 cancelling（正在停止≠已停），随后真实落 cancelled；终态事件恰一次', async () => {
    const repo = new MemoryTaskRuns();
    const harness = mockRunner({
      execute: async ({ options }) => new Promise<SubagentTaskResult>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('worker aborted')); return; }
        options.signal?.addEventListener('abort', () => reject(new Error('worker aborted')), { once: true });
      }),
    });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: createPlatformExecutionGate({ maxQueue: 1 }) });
    const events: BackgroundTaskEvent[] = [];
    manager.subscribe(async (event) => { events.push(event); });
    const receipt = await manager.submit(input('stop-running'));
    await waitFor(() => harness.executions.length === 1);

    const control = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, receipt.taskId);
    // 受理 ≠ 已停：requested:true 只表示取消请求已发给活动 Worker；此刻状态是 cancelling。
    expect(control).toMatchObject({ found: true, state: 'cancelling', requested: true });
    expect((await repo.get(receipt.runId))?.state).toBe('cancelling');
    expect(events).toHaveLength(0);

    // 执行续篇收尾：真实落 cancelled，终态事件恰好一次。
    await waitFor(async () => (await repo.get(receipt.runId))?.state === 'cancelled');
    await waitFor(() => events.length === 1);
    expect(events[0]?.run.state).toBe('cancelled');
    expect(events.filter((event) => event.run.state === 'cancelled')).toHaveLength(1);
    await manager.shutdown({ drainMs: 100 });
  });

  it('持久库里进程内无 ActiveRun 的 queued 行取消不等投递链：cancel 返回时投递尚未发生，终态恰一次', async () => {
    // 取消的四条分支中，queued 且无 ActiveRun 的这一支也要在库内落 cancelled 后由
    // dispatchTerminal 派发终态——与有 ActiveRun 的 queued（由执行续篇收尾）区分开。
    const repo = new MemoryTaskRuns();
    const now = new Date().toISOString();
    const runId = 'run-seed-queued';
    repo.records.set(runId, {
      runId, taskId: 'task-seed', dispatchKey: 'seed-queued', principalId: 'wecom:user-1', sessionId: 'session-1',
      originRequestId: 'old', originUserEventId: 'old:user', request: 'frozen', originMessage: 'original',
      createdAt: now, updatedAt: now, state: 'queued', resultEventId: `task-run:${runId}`,
    });
    const manager = createBackgroundTaskManager({
      runner: mockRunner().runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
    });
    const delivered: string[] = [];
    const releaseInflight = deferred<void>();
    manager.subscribe(async (event) => { await releaseInflight.promise; delivered.push(event.eventId); });

    const outcome = await Promise.race([
      manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, 'task-seed')
        .then((control) => ({ kind: 'returned' as const, control })),
      new Promise<{ kind: 'deadlock' }>((resolve) => setTimeout(() => resolve({ kind: 'deadlock' }), 500)),
    ]);
    expect(outcome.kind).toBe('returned');
    if (outcome.kind === 'returned') {
      expect(outcome.control).toMatchObject({ found: true, state: 'cancelled', requested: false });
    }
    expect((await repo.get(runId))?.state).toBe('cancelled');
    expect(delivered).toEqual([]); // 返回时没有等待投递

    releaseInflight.resolve();
    await waitFor(() => delivered.length === 1);
    expect(delivered).toEqual([`task-run:${runId}`]);
    await manager.shutdown({ drainMs: 100 });
  });

  it('recovers interrupted runs without executing them and enforces principal/session scope', async () => {
    const repo = new MemoryTaskRuns();
    const now = new Date().toISOString();
    for (const [runId, state] of [['old-q', 'queued'], ['old-r', 'running'], ['old-c', 'cancelling']] as const) {
      repo.records.set(runId, {
        runId, taskId: `task-${runId}`, dispatchKey: `d-${runId}`, principalId: 'wecom:user-1', sessionId: 'session-1',
        originRequestId: 'old', originUserEventId: 'old:user', request: 'frozen', originMessage: 'original', createdAt: now, updatedAt: now, state,
      });
    }
    const harness = mockRunner();
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: createPlatformExecutionGate({ maxQueue: 4 }) });
    expect(await manager.recoverInterrupted(now)).toBe(3);
    expect([...repo.records.values()].map((item) => item.state)).toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(harness.executions).toHaveLength(0);
    expect(await manager.get({ principalId: 'other', sessionId: 'session-1' }, 'task-old-q')).toBeNull();
    expect(await manager.list({ principalId: 'other', sessionId: 'session-1' })).toEqual([]);
    const unauthorized = await manager.cancel({ principalId: 'other', sessionId: 'session-1' }, 'task-old-q');
    expect(unauthorized).toMatchObject({ found: false, requested: false });
    await manager.shutdown({ drainMs: 100 });
  });

  it('drains terminal event listeners before shutdown returns', async () => {
    const repo = new MemoryTaskRuns();
    const listenerEntered = deferred<void>();
    const finishListener = deferred<void>();
    const manager = createBackgroundTaskManager({
      runner: mockRunner().runner,
      repo,
      executionGate: createPlatformExecutionGate({ maxQueue: 1 }),
    });
    manager.subscribe(async () => {
      listenerEntered.resolve();
      await finishListener.promise;
    });
    const receipt = await manager.submit(input('shutdown-drain'));
    await listenerEntered.promise;
    let stopped = false;
    const shutdown = manager.shutdown({ drainMs: 1_000 }).then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finishListener.resolve();
    await shutdown;
    expect(stopped).toBe(true);
    expect((await repo.get(receipt.runId))?.state).toBe('completed');
  });

  it('停机窗口内迟到的提交在落库前被拒：与入口同文案、无新 run、无 Worker（D-132b）', async () => {
    // 事故形状：submitIdempotently 的入口 stopping 检查之后隔着 prepare/materializeInputs
    // 多个 await——停机在 await 里置位时，提交带着"已排队"回执照常落库并调度，重启后
    // 变成 interrupted 死任务。复现：prepare 内卡住，入口检查已过、shutdown 置位后再放行。
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const prepareEntered = deferred<void>();
    const releasePrepare = deferred<void>();
    const executions: string[] = [];
    let preparedCount = 0;
    const runner: ContextTaskRunner = {
      tool: { name: 'run_task', description: 'test', inputSchema: {} },
      run: async () => { throw new Error('manager must execute the prepared handle'); },
      prepare: async (requestArgs: ContextTaskRunArgs) => {
        preparedCount += 1;
        prepareEntered.resolve();
        await releasePrepare.promise;
        const prepared: PreparedContextTaskRun = {
          taskId: requestArgs.taskId ?? 'task-stop-window',
          request: requestArgs.request,
          timeoutMs: 1_000,
          workspaceDir: 'tmp/task-stop-window',
          snapshotWorkspace: async () => [],
          execute: async () => { executions.push('task-stop-window'); return { taskId: 'task-stop-window', text: 'done' }; },
        };
        return prepared;
      },
    };
    const manager = createBackgroundTaskManager({ runner, repo, executionGate: gate });

    const submitPromise = manager.submit(input('stop-window'));
    await prepareEntered.promise; // 已过 submitIdempotently 入口检查
    await manager.shutdown({ drainMs: 0 }); // stopping 置位；此刻无在飞 run
    releasePrepare.resolve();

    const settled = await Promise.allSettled([submitPromise]);
    expect(settled[0]?.status).toBe('rejected');
    const reason = (settled[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ToolUserError);
    expect(reason.message).toBe('服务正在停止接收后台任务，请稍后重试。');
    expect(preparedCount).toBe(1);
    // 仓储无新 run、无 Worker 启动、排队票据无残留。
    expect(await repo.listBySession('wecom:user-1', 'session-1')).toHaveLength(0);
    expect(executions).toHaveLength(0);
    expect(gate.snapshot().queued).toBe(0);
  });

  it('遍历 activeRuns 之后才排上队的迟到 run 在 execute 入口被末道闸收卷为 cancelled，不起 Worker（D-132b）', async () => {
    // 残余窗口：落库前复查之后仍隔着 createOrGetByDispatchKey 一个 await——停机恰落在
    // 这个 await 上时，run 在 shutdown 的 activeRuns 遍历之后才登记并调度，没有谁会来
    // 取消它。复现：落库 await 上卡住、shutdown（遍历时 activeRuns 为空）后再放行。
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const harness = mockRunner();
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate });
    const createEntered = deferred<void>();
    const releaseCreate = deferred<void>();
    const originalCreate = repo.createOrGetByDispatchKey.bind(repo);
    repo.createOrGetByDispatchKey = async (record: TaskRunRecord) => {
      createEntered.resolve();
      await releaseCreate.promise;
      return originalCreate(record);
    };

    const submitPromise = manager.submit(input('late-schedule'));
    await createEntered.promise; // 已过入口检查与预留，卡在落库 await 上
    await manager.shutdown({ drainMs: 0 }); // stopping 置位且 activeRuns 遍历已过
    releaseCreate.resolve();
    const receipt = await submitPromise; // 回执仍是 queued——这正是要收卷的窗口

    await waitFor(async () => (await repo.get(receipt.runId))?.state !== 'queued');
    expect((await repo.get(receipt.runId))?.state).toBe('cancelled');
    expect(harness.executions).toHaveLength(0); // 无 Worker 启动
    expect(gate.snapshot().queued).toBe(0); // 排队票据已回收
    await manager.shutdown({ drainMs: 100 });
  });
});
