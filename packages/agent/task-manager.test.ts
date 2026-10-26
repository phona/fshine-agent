import { describe, expect, it, vi } from 'vitest';
import type {
  BackgroundTaskEvent,
  TaskRunRecord,
  TaskRunRepo,
  TaskRunState,
  TrustedContext,
} from '@fshine/contracts';
import type { ContextTaskRunner, PreparedContextTaskRun, Run17dzTaskArgs, SubagentTaskResult } from './src/context';
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
} = {}): RunnerHarness {
  let taskSeq = 0;
  const executions: RunnerHarness['executions'] = [];
  let preparedCount = 0;
  const runner: ContextTaskRunner = {
    tool: { name: 'run_17dz_task', description: 'test', inputSchema: {} },
    run: async () => { throw new Error('manager must execute the prepared handle'); },
    prepare: async (requestArgs: Run17dzTaskArgs) => {
      preparedCount += 1;
      const taskId = requestArgs.taskId ?? `task-${++taskSeq}`;
      let snapshotIndex = 0;
      const prepared: PreparedContextTaskRun = {
        taskId,
        request: requestArgs.request,
        timeoutMs: args.timeoutMs ?? 100,
        workspaceDir: `tmp/${taskId}`,
        snapshotWorkspace: async () => args.snapshots?.[Math.min(snapshotIndex++, (args.snapshots?.length ?? 1) - 1)] ?? [],
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
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 });
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

  it('cancels a queued task so it cannot start after the active task releases the slot', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 });
    const first = deferred<SubagentTaskResult>();
    const executions: string[] = [];
    const harness = mockRunner({ execute: async ({ prepared }) => { executions.push(prepared.taskId); return prepared.taskId === 'task-1' ? first.promise : { taskId: prepared.taskId, text: 'second' }; } });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate });
    const firstReceipt = await manager.submit(input('first'));
    await waitFor(() => executions.includes('task-1'));
    const secondReceipt = await manager.submit(input('second'));
    expect((await repo.get(secondReceipt.runId))?.state).toBe('queued');

    const cancelled = await manager.cancel({ principalId: 'wecom:user-1', sessionId: 'session-1' }, secondReceipt.taskId);
    expect(cancelled).toMatchObject({ found: true, state: 'cancelled', requested: false });
    first.resolve({ taskId: firstReceipt.taskId, text: 'first done' });
    await waitFor(async () => (await repo.get(firstReceipt.runId))?.state === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executions).toEqual(['task-1']);
    expect((await repo.get(secondReceipt.runId))?.state).toBe('cancelled');
    await manager.shutdown({ drainMs: 100 });
  });

  it('starts the Worker deadline after queue wait and freezes run output and ACKed notices', async () => {
    const repo = new MemoryTaskRuns();
    let now = 100;
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4, now: () => now });
    const first = deferred<SubagentTaskResult>();
    const snapshots = [
      [{ path: '/platform/tmp/task-2/old.xlsx', relativePath: 'old.xlsx', size: 1, sha256: 'old' }],
      [{ path: '/platform/tmp/task-2/old.xlsx', relativePath: 'old.xlsx', size: 2, sha256: 'changed' }, { path: '/platform/tmp/task-2/new.xlsx', relativePath: 'new.xlsx', size: 3, sha256: 'new' }],
    ];
    const harness = mockRunner({ timeoutMs: 500, snapshots, execute: async ({ prepared, options }) => {
      if (prepared.taskId === 'task-1') return first.promise;
      await options.onNotice?.('计划通知：确认扩大范围');
      return { taskId: prepared.taskId, text: 'done', pendingPlan: { taskId: prepared.taskId } as never };
    } });
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: gate, now: () => now });
    const noticeAck = vi.fn(async () => {});
    const firstReceipt = await manager.submit(input('first'));
    await waitFor(() => harness.executions.length === 1);
    const secondReceipt = await manager.submit(input('second', { trusted: trusted({ onBackgroundNotice: noticeAck }) }));
    now = 5_000;
    first.resolve({ taskId: firstReceipt.taskId, text: 'first done' });
    await waitFor(() => harness.executions.length === 2);
    const started = harness.executions.find((item) => item.taskId === secondReceipt.taskId)!;
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
    await manager.shutdown({ drainMs: 100 });
  });

  it('keeps the slot through running cancellation cleanup and lets an already-completed result win the race', async () => {
    const repo = new MemoryTaskRuns();
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 });
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 }),
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
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 });
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
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 });
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 }),
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
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 });
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 }),
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 }),
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
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 });
    const runner: ContextTaskRunner = {
      tool: { name: 'run_17dz_task', description: 'test', inputSchema: {} },
      run: async () => { throw new Error('manager must execute the prepared handle'); },
      prepare: async (requestArgs: Run17dzTaskArgs) => {
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 }),
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

  it('closes waiting-input runs without invoking the confirmation invalidator', async () => {
    const repo = new MemoryTaskRuns();
    const onCancelPending = vi.fn(async () => true);
    const manager = createBackgroundTaskManager({
      runner: mockRunner({ execute: async ({ prepared }) => ({ taskId: prepared.taskId, text: '', needs: { missing: ['range'], reason: 'missing range' } }) }).runner,
      repo,
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 }),
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
    const manager = createBackgroundTaskManager({ runner: harness.runner, repo, executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 }) });
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
      executionGate: createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 }),
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
});
