import { describe, expect, it } from 'vitest';
import { createPlatformExecutionGate, PlatformExecutionAbortedError, PlatformExecutionQueueFullError, PlatformExecutionWaitTimeoutError } from './src/platform-execution-gate';

describe('PlatformExecutionGate', () => {
  it('grants one slot and releases the next waiter in FIFO order', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 2 });
    const first = gate.enqueue({ requestId: 'first' });
    const firstLease = await first.acquired;
    firstLease.start();

    const second = gate.enqueue({ requestId: 'second' });
    const third = gate.enqueue({ requestId: 'third' });
    expect(second.state).toBe('queued');
    expect(third.state).toBe('queued');

    firstLease.release();
    const secondLease = await second.acquired;
    expect(second.state).toBe('granted');
    secondLease.start();
    secondLease.release();

    const thirdLease = await third.acquired;
    expect(third.state).toBe('granted');
    thirdLease.start();
    thirdLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('removes an aborted queued waiter so it can never acquire a later slot', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 });
    const first = gate.enqueue({ requestId: 'first' });
    const firstLease = await first.acquired;
    firstLease.start();

    const controller = new AbortController();
    const queued = gate.enqueue({ requestId: 'queued', signal: controller.signal });
    const queuedRejected = expect(queued.acquired).rejects.toBeInstanceOf(PlatformExecutionAbortedError);
    controller.abort();
    await queuedRejected;
    expect(queued.state).toBe('cancelled');
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });

    firstLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('rejects admission after the bounded FIFO queue fills', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 });
    const first = gate.enqueue({ requestId: 'first' });
    const firstLease = await first.acquired;
    firstLease.start();
    const second = gate.enqueue({ requestId: 'second' });

    expect(() => gate.enqueue({ requestId: 'third' })).toThrow(PlatformExecutionQueueFullError);
    const secondRejected = expect(second.acquired).rejects.toBeInstanceOf(PlatformExecutionAbortedError);
    second.cancel();
    await secondRejected;
    firstLease.release();
  });

  it('releases a granted but unstarted reservation when cancelled', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 });
    const first = gate.enqueue({ requestId: 'first' });
    const firstLease = await first.acquired;
    const second = gate.enqueue({ requestId: 'second' });

    first.cancel();
    expect(first.state).toBe('cancelled');
    const secondLease = await second.acquired;
    secondLease.start();
    secondLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    firstLease.release();
  });

  it('does not start work when cancellation lands after grant but before start', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 1 });
    const controller = new AbortController();
    let started = false;
    const run = gate.run({ requestId: 'first', signal: controller.signal }, async () => { started = true; });
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(PlatformExecutionAbortedError);
    expect(started).toBe(false);
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('waitTimeoutMs bounds the queue wait: rejects with PlatformExecutionWaitTimeoutError, later requests still admitted', async () => {
    // 上界的用途（修复 2）：共享闸默认并发 1，别会话的 inline worker 最长占槽
    // DEFAULT_WORKER_TIMEOUT_MS（600s）。没有等待上界的调用方（如确认码直执行）会无界
    // 挂在队首——上界到期必须以可区分的错误形态出队，且不污染闸的后续状态。
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 });
    const holder = gate.enqueue({ requestId: 'holder' });
    const holderLease = await holder.acquired;
    holderLease.start();

    const timedOut = gate.enqueue({ requestId: 'waiter', waitTimeoutMs: 20 });
    await expect(timedOut.acquired).rejects.toBeInstanceOf(PlatformExecutionWaitTimeoutError);
    expect(timedOut.state).toBe('cancelled');
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });

    holderLease.release();
    const after = gate.enqueue({ requestId: 'after', waitTimeoutMs: 20 });
    const afterLease = await after.acquired;
    afterLease.start();
    afterLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  }, 2_000);

  it('waitTimeoutMs does not fire when the slot is granted before the deadline', async () => {
    const gate = createPlatformExecutionGate({ concurrency: 1, maxQueue: 4 });
    const holder = gate.enqueue({ requestId: 'holder' });
    const holderLease = await holder.acquired;
    holderLease.start();
    const waiter = gate.enqueue({ requestId: 'waiter', waitTimeoutMs: 5_000 });
    holderLease.release();
    const lease = await waiter.acquired;
    expect(waiter.state).toBe('granted');
    lease.start();
    lease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
