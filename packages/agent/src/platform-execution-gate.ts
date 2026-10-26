/**
 * Shared FIFO semaphore for platform operations, including Worker and host-side commit work.
 *
 * 命名澄清（D-121）：本模块是**并发准入闸**（capacity/admission）——只回答"同一时刻
 * 最多多少平台作业在跑、超出的按 FIFO 排队"，不做任何授权裁决。本仓语境里的
 * "平台执行门 / G1 / 授信期门"指 serve-gate.ts 的授权裁决（是否放行这次调用）。
 * 两者顺序：请求经 serve-gate 裁决获准后才可能到达这里排队取槽；本闸发出的 lease
 * 只表示并发槽位占有（调度事实），**不构成执行授权**——拿到 lease ≠ 已获准执行。
 */

export class PlatformExecutionQueueFullError extends Error {
  constructor() {
    super('平台执行队列已满，请稍后重试。');
    this.name = 'PlatformExecutionQueueFullError';
  }
}

export class PlatformExecutionAbortedError extends Error {
  constructor() {
    super('平台执行排队已取消。');
    this.name = 'PlatformExecutionAbortedError';
  }
}

/**
 * 排队等待超过调用方声明的上界（修复 2）：与 abort 不同——请求没有被谁取消，只是
 * 调用方等不起（如确认码直执行必须在渠道流式回复窗口内出回执）。出队后不占闸状态，
 * 调用方自行决定"稍后重试"类语义。
 */
export class PlatformExecutionWaitTimeoutError extends Error {
  constructor() {
    super('平台执行排队等待超时，请稍后重试。');
    this.name = 'PlatformExecutionWaitTimeoutError';
  }
}

export interface PlatformExecutionLease {
  /** Timestamp when this request acquired the shared platform slot. */
  acquiredAt: number;
  /** Time spent waiting in the shared FIFO queue. */
  waitedMs: number;
  /** Marks the reservation as owned by an operation. Cancellation can no longer release it. */
  start(): void;
  /** Releases the platform slot once. Call only after the operation and its child process settle. */
  release(): void;
}

export type PlatformExecutionTicketState = 'queued' | 'granted' | 'started' | 'cancelled' | 'released';

export interface PlatformExecutionTicket {
  readonly requestId: string;
  readonly state: PlatformExecutionTicketState;
  /** Resolves only when a slot is reserved, or rejects when cancelled before it starts. */
  readonly acquired: Promise<PlatformExecutionLease>;
  /** Removes a queued waiter, or releases an unstarted reservation. */
  cancel(): void;
}

/**
 * 并发准入闸（D-121）：FIFO 槽位调度，不做授权裁决——授权裁决住 serve-gate.ts
 * （G1/授信期门）。这里发出的 lease 只表示槽位占有，不构成执行授权。
 */
export interface PlatformExecutionGate {
  /**
   * Synchronously admits one request into the slot or bounded FIFO queue. It never starts work;
   * callers may persist their own queued record before awaiting `ticket.acquired`.
   *
   * `waitTimeoutMs` bounds only the **queue wait**: a request still queued after the deadline is
   * removed and its `acquired` rejects with PlatformExecutionWaitTimeoutError. Grants are never
   * revoked — once a slot is reserved the operation itself is bounded by its own deadline.
   */
  enqueue(input: { requestId: string; signal?: AbortSignal; waitTimeoutMs?: number }): PlatformExecutionTicket;
  /** Convenience wrapper for host operations which do not need a persisted queued state. */
  run<T>(input: { requestId: string; signal?: AbortSignal; waitTimeoutMs?: number }, operation: (lease: PlatformExecutionLease) => Promise<T>): Promise<T>;
  snapshot(): { active: number; queued: number };
}

export interface PlatformExecutionGateOptions {
  /** Defaults to FSHINE_PLATFORM_CONCURRENCY, then 1. */
  concurrency?: number;
  /** Maximum number of queued requests in addition to active slots. */
  maxQueue: number;
  now?: () => number;
}

interface QueueEntry {
  requestId: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  state: PlatformExecutionTicketState;
  resolve: (lease: PlatformExecutionLease) => void;
  reject: (error: Error) => void;
  promise: Promise<PlatformExecutionLease>;
  abortListener?: () => void;
  lease?: PlatformExecutionLease;
  /** Queue-wait bound timer; cleared as soon as the entry leaves the queue (grant/cancel/timeout). */
  waitTimer?: ReturnType<typeof setTimeout>;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Creates the single-process FIFO admission gate shared by all platform work. */
export function createPlatformExecutionGate(options: PlatformExecutionGateOptions): PlatformExecutionGate {
  const fromEnv = Number.parseInt(process.env.FSHINE_PLATFORM_CONCURRENCY ?? '', 10);
  const concurrency = positiveInteger(options.concurrency, positiveInteger(fromEnv, 1));
  const maxQueue = Math.max(0, Number.isFinite(options.maxQueue) ? Math.floor(options.maxQueue) : 0);
  const now = options.now ?? Date.now;
  const active = new Set<QueueEntry>();
  const queue: QueueEntry[] = [];

  const cleanupAbort = (entry: QueueEntry): void => {
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener('abort', entry.abortListener);
    entry.abortListener = undefined;
    if (entry.waitTimer) {
      clearTimeout(entry.waitTimer);
      entry.waitTimer = undefined;
    }
  };

  const rejectCancelled = (entry: QueueEntry): void => {
    entry.state = 'cancelled';
    cleanupAbort(entry);
    entry.reject(new PlatformExecutionAbortedError());
  };

  const grant = (entry: QueueEntry): void => {
    if (entry.state !== 'queued') return;
    entry.state = 'granted';
    active.add(entry);
    cleanupAbort(entry);
    const acquiredAt = now();
    let released = false;
    const lease: PlatformExecutionLease = {
      acquiredAt,
      waitedMs: Math.max(0, acquiredAt - entry.enqueuedAt),
      start: () => {
        if (entry.state === 'granted') entry.state = 'started';
      },
      release: () => {
        if (released) return;
        released = true;
        if (entry.state !== 'cancelled') entry.state = 'released';
        active.delete(entry);
        cleanupAbort(entry);
        pump();
      },
    };
    entry.lease = lease;
    entry.resolve(lease);
  };

  const removeQueued = (entry: QueueEntry): boolean => {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    rejectCancelled(entry);
    return true;
  };

  function pump(): void {
    while (active.size < concurrency && queue.length > 0) {
      const next = queue.shift()!;
      if (next.state !== 'queued') continue;
      if (next.signal?.aborted) {
        rejectCancelled(next);
        continue;
      }
      grant(next);
    }
  }

  const enqueue = (input: { requestId: string; signal?: AbortSignal; waitTimeoutMs?: number }): PlatformExecutionTicket => {
    const enqueuedAt = now();
    let resolve!: (lease: PlatformExecutionLease) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PlatformExecutionLease>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Admission may be cancelled before its owning manager reaches the scheduled waiter;
    // keep the rejection observed without changing the original Promise contract.
    void promise.catch(() => {});
    const entry: QueueEntry = {
      requestId: input.requestId,
      enqueuedAt,
      ...(input.signal ? { signal: input.signal } : {}),
      state: 'queued',
      resolve,
      reject,
      promise,
    };
    const ticket: PlatformExecutionTicket = {
      requestId: input.requestId,
      get state() { return entry.state; },
      acquired: promise,
      cancel: () => {
        if (entry.state === 'queued') {
          if (!removeQueued(entry)) rejectCancelled(entry);
          pump();
          return;
        }
        // If a slot was granted but the caller has not started work yet, release it safely.
        if (entry.state === 'granted') {
          entry.state = 'cancelled';
          entry.lease?.release();
        }
      },
    };

    if (input.signal?.aborted) {
      rejectCancelled(entry);
      return ticket;
    }
    if (active.size < concurrency) {
      grant(entry);
    } else {
      if (queue.length >= maxQueue) throw new PlatformExecutionQueueFullError();
      queue.push(entry);
      if (input.signal) {
        entry.abortListener = () => {
          removeQueued(entry);
          pump();
        };
        input.signal.addEventListener('abort', entry.abortListener, { once: true });
        // Close the race between the first aborted check and listener registration.
        if (input.signal.aborted) entry.abortListener();
      }
      // Queue-wait bound (修复 2): the entry leaves the queue with a distinct error shape so
      // callers that must answer within their own reply window can map it to a retryable reply.
      const waitTimeoutMs = input.waitTimeoutMs;
      if (waitTimeoutMs !== undefined && Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
        entry.waitTimer = setTimeout(() => {
          const index = queue.indexOf(entry);
          if (entry.state !== 'queued' || index < 0) return;
          queue.splice(index, 1);
          entry.state = 'cancelled';
          cleanupAbort(entry);
          entry.reject(new PlatformExecutionWaitTimeoutError());
          pump();
        }, waitTimeoutMs);
        entry.waitTimer.unref?.();
      }
    }
    return ticket;
  };

  return {
    enqueue,
    async run(input, operation) {
      const ticket = enqueue(input);
      const lease = await ticket.acquired;
      if (input.signal?.aborted) {
        ticket.cancel();
        throw new PlatformExecutionAbortedError();
      }
      lease.start();
      try {
        return await operation(lease);
      } finally {
        lease.release();
      }
    },
    snapshot: () => ({ active: active.size, queued: queue.length }),
  };
}
