/**
 * Shared admission/backpressure gate for platform operations, including Worker and host-side
 * commit work.
 *
 * 命名澄清（D-121）：本模块是**准入闸**（admission）——只回答"宿主这一侧是否还能接下一件
 * 平台作业、超出的按宿主待办深度拒绝"，不做任何授权裁决。本仓语境里的
 * "平台执行门 / G1 / 授信期门"指 serve-gate.ts 的授权裁决（是否放行这次调用）。
 * 两者顺序：请求经 serve-gate 裁决获准后才可能到达这里取槽；本闸发出的 lease
 * 只表示调度事实，**不构成执行授权**——拿到 lease ≠ 已获准执行。
 *
 * 并发容忍归执行层（2026-11-10 仲裁）：本闸**不再限制"同一时刻最多多少平台作业在跑"**。
 * 真实平台能容忍多少并发是执行层的内政（执行层自己持有限流令牌桶与熔断），编排层在这里
 * 再实现一遍就是同一机制做两遍、还做在错的层。本闸只保留宿主自己的准入背压：同时在办
 * 的作业数（active 槽位）达到 maxQueue 时拒绝新提交——那是宿主待办深度，不是平台并发
 * 策略。被授予的作业立即开始；本闸没有等待队列，也不产生排队语义。
 */

export class PlatformExecutionQueueFullError extends Error {
  constructor() {
    super('平台执行队列已满，请稍后重试。');
    this.name = 'PlatformExecutionQueueFullError';
  }
}

export class PlatformExecutionAbortedError extends Error {
  constructor() {
    super('平台执行准入已取消。');
    this.name = 'PlatformExecutionAbortedError';
  }
}

export interface PlatformExecutionLease {
  /** Marks the reservation as owned by an operation. Cancellation can no longer release it. */
  start(): void;
  /** Releases the platform slot once. Call only after the operation and its child process settle. */
  release(): void;
}

export type PlatformExecutionTicketState = 'granted' | 'started' | 'cancelled' | 'released';

export interface PlatformExecutionTicket {
  readonly requestId: string;
  readonly state: PlatformExecutionTicketState;
  /** Resolves once a slot is reserved, or rejects when the request was aborted before admission. */
  readonly acquired: Promise<PlatformExecutionLease>;
  /** Releases a granted but unstarted reservation. */
  cancel(): void;
}

/**
 * 准入闸（D-121 + 2026-11-10 仲裁）：只做宿主侧准入/背压，不做授权裁决，也不限制平台
 * 并发。授权裁决住 serve-gate.ts（G1/授信期门）。这里发出的 lease 只表示槽位占有，
 * 不构成执行授权。
 */
export interface PlatformExecutionGate {
  /**
   * Synchronously admits one request into an active slot, or throws
   * `PlatformExecutionQueueFullError` when the host's outstanding backlog is full. It never
   * starts work; callers may persist their own queued record before awaiting `ticket.acquired`.
   *
   * Grants are immediate (there is no FIFO wait queue): the platform's concurrency tolerance
   * belongs to the execution layer, not to this host gate.
   */
  enqueue(input: { requestId: string; signal?: AbortSignal }): PlatformExecutionTicket;
  /** Convenience wrapper for host operations which do not need a persisted queued state. */
  run<T>(input: { requestId: string; signal?: AbortSignal }, operation: (lease: PlatformExecutionLease) => Promise<T>): Promise<T>;
  snapshot(): { active: number; queued: number };
}

export interface PlatformExecutionGateOptions {
  /**
   * Maximum number of outstanding platform operations the host admits at once — the host's
   * own backlog depth (execution-layer concurrency tolerance is not modelled here). Reaching
   * it is backpressure, not a platform concurrency policy.
   */
  maxQueue: number;
}

interface ActiveEntry {
  state: PlatformExecutionTicketState;
}

/** Creates the single-process admission gate shared by all platform work. */
export function createPlatformExecutionGate(options: PlatformExecutionGateOptions): PlatformExecutionGate {
  // maxQueue 语义（2026-11-10 仲裁后）：宿主同时跟踪的未完成平台作业上限。旧配置把它定义
  // 为"等待队列容量"；没有并发上限后等待队列不复存在，保留 maxQueue 作为宿主待办深度的
  // 背压阈值。0 按 1 处理——那表示"不排队"，而不是"一件都不许做"。
  const maxOutstanding = Math.max(1, Number.isFinite(options.maxQueue) ? Math.floor(options.maxQueue) : 1);
  const active = new Set<ActiveEntry>();

  const enqueue = (input: { requestId: string; signal?: AbortSignal }): PlatformExecutionTicket => {
    if (active.size >= maxOutstanding) throw new PlatformExecutionQueueFullError();
    let resolve!: (lease: PlatformExecutionLease) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PlatformExecutionLease>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Admission may be cancelled before its owning manager reaches the scheduled waiter;
    // keep the rejection observed without changing the original Promise contract.
    void promise.catch(() => {});
    const entry: ActiveEntry = { state: 'granted' };
    let released = false;
    const lease: PlatformExecutionLease = {
      start: () => {
        if (entry.state === 'granted') entry.state = 'started';
      },
      release: () => {
        if (released) return;
        released = true;
        if (entry.state !== 'cancelled') entry.state = 'released';
        active.delete(entry);
      },
    };
    const ticket: PlatformExecutionTicket = {
      requestId: input.requestId,
      get state() { return entry.state; },
      acquired: promise,
      cancel: () => {
        // If a slot was granted but the caller has not started work yet, release it safely.
        if (entry.state !== 'granted') return;
        entry.state = 'cancelled';
        active.delete(entry);
        released = true;
      },
    };

    if (input.signal?.aborted) {
      entry.state = 'cancelled';
      reject(new PlatformExecutionAbortedError());
      return ticket;
    }
    active.add(entry);
    resolve(lease);
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
    snapshot: () => ({ active: active.size, queued: 0 }),
  };
}
