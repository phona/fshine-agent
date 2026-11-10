import { describe, expect, it } from 'vitest';
import { createPlatformExecutionGate, PlatformExecutionAbortedError, PlatformExecutionQueueFullError } from './src/platform-execution-gate';

describe('PlatformExecutionGate', () => {
  it('admits every request immediately: concurrency tolerance belongs to the execution layer', async () => {
    // 2026-11-10 仲裁：宿主不再串行化平台调用。同一时刻两件作业都必须立即拿到槽位，
    // 不存在 FIFO 等待队列——平台能容忍多少并发由执行层自己的限流/熔断决定。
    const gate = createPlatformExecutionGate({ maxQueue: 4 });
    const first = gate.enqueue({ requestId: 'first' });
    const second = gate.enqueue({ requestId: 'second' });

    expect(first.state).toBe('granted');
    expect(second.state).toBe('granted');
    expect(gate.snapshot()).toEqual({ active: 2, queued: 0 });

    const firstLease = await first.acquired;
    const secondLease = await second.acquired;
    firstLease.start();
    secondLease.start();
    firstLease.release();
    secondLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('rejects admission when the host backlog reaches maxQueue', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const first = gate.enqueue({ requestId: 'first' });
    const firstLease = await first.acquired;
    firstLease.start();

    expect(() => gate.enqueue({ requestId: 'second' })).toThrow(PlatformExecutionQueueFullError);
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });

    firstLease.release();
    const after = gate.enqueue({ requestId: 'after' });
    const afterLease = await after.acquired;
    afterLease.start();
    afterLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('rejects an already-aborted request without occupying a slot', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const controller = new AbortController();
    controller.abort();
    const ticket = gate.enqueue({ requestId: 'aborted', signal: controller.signal });
    await expect(ticket.acquired).rejects.toBeInstanceOf(PlatformExecutionAbortedError);
    expect(ticket.state).toBe('cancelled');
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('releases a granted but unstarted reservation when cancelled', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const first = gate.enqueue({ requestId: 'first' });
    await first.acquired;

    first.cancel();
    expect(first.state).toBe('cancelled');
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    const after = gate.enqueue({ requestId: 'after' });
    const afterLease = await after.acquired;
    afterLease.start();
    afterLease.release();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('does not start work when cancellation lands after grant but before start', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    const controller = new AbortController();
    let started = false;
    const run = gate.run({ requestId: 'first', signal: controller.signal }, async () => { started = true; });
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(PlatformExecutionAbortedError);
    expect(started).toBe(false);
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('run releases its slot after the operation settles, including on failure', async () => {
    const gate = createPlatformExecutionGate({ maxQueue: 1 });
    await expect(gate.run({ requestId: 'fails' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    await gate.run({ requestId: 'succeeds' }, async (lease) => { lease.start(); });
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
