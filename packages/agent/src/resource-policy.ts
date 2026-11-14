/**
 * 资源许可与强制（R4 P5；`docs/product/r4-joint-interfaces.md` §2 冻结面）。
 *
 * 定位：把「并发准入 / 队列容量 / 委派深度 / 任务级共享预算 / 回合时限」收口为一个
 * **纯逻辑对象**——无 IO、无定时器、无持久化；时间由注入时钟提供（缺省 `Date.now`），
 * 因此并发、队列、预算与截止行为全部可确定性测试。实际的中止动作（abort / 落库终态）
 * 归消费方：P2 registry 与 P6 runner / 集成接线按 `permit.deadlineAt` 与拒绝 reason 落地。
 *
 * 冻结接口（§2）：
 *   `acquire(kind, opts?) → Permit | Rejection`（reason ∈ queue_full / quota_exceeded /
 *   budget_exhausted / depth_exceeded）；`release(permit)`；`cancelQueued(taskId)`；
 *   `snapshot()`；`budgetFor(taskId)`。
 *
 * 语义要点（每条都有矩阵测试钉住）：
 *   · 前台（Main 交互回合）与后台（委派 Worker / 后台任务）配额与等待队列**各自独立**；
 *     后台满载不阻塞前台（独立队列，满即确定性拒绝，无无限积压）。
 *   · 子许可（带 `parentPermit` 派生）不占新并发槽：它在父回合内执行；共享父任务预算的
 *     **同一对象**（不复制、不放大）；深度 = 父 + 1，超过 `maxDelegationDepth` 即拒绝，
 *     拒绝不产生半成品（无许可、无预算）。
 *   · waiting_user：任务进入等待时 `release` 立即释放执行资源；任务预算按任务保留
 *     （恢复时同一对象、用量不重置）；恢复**不保留**槽位/队列特权（先到先得，满即拒绝）。
 *   · token 上限仅在部署显式声明 `taskBudget.tokens` 时 `enforced`；未声明 = `unavailable`,
 *     观测用量照实记录但不作为强制上限——不得伪造硬上限（分诊 #10）。
 *   · 缺省（未配置 `runtime` 段）= 现行为：单并发、无队列、无任务级预算、回合时限沿用
 *     执行侧现行缺省（main 300s / worker 180s）、委派深度 1。
 *
 * 接线边界：本模块不改 execution-runtime / server / ask-runtime——强制点接线由集成 Run
 * 承接（联合接口约定 §6）。消费方不得绕过本模块另读 `runtime` 配置（守卫见
 * `resource-policy-single-source.test.ts`）。
 */
import type { RuntimeConfig, TaskBudgetConfig } from '@fshine/contracts';

export type AcquireKind = 'foreground' | 'background';

export type RejectionReason = 'queue_full' | 'quota_exceeded' | 'budget_exhausted' | 'depth_exceeded';

/** 拒绝：确定性、可机械映射（集成层把 reason 映射为任务 resource_limited）。 */
export interface Rejection {
  readonly ok: false;
  readonly kind: AcquireKind;
  readonly taskId: string;
  readonly reason: RejectionReason;
  /** 机械说明（诊断用；不是用户话术）。 */
  readonly message: string;
}

export type PermitState = 'queued' | 'active' | 'released' | 'cancelled';

export interface BudgetUsage {
  /** 本次汇报的墙钟消耗（ms，累计口径由调用方保证；仅 Pi usage 可验证时提供 token）。 */
  readonly ms?: number;
  readonly calls?: number;
  readonly tokens?: number;
}

export interface BudgetExhaustion {
  readonly reason: 'ms' | 'calls' | 'tokens';
  readonly limit: number;
  readonly used: number;
}

export type TaskBudgetLimits = {
  readonly ms: number;
  readonly calls: number;
  readonly tokens?: number;
};

/**
 * 任务级共享预算（父任务与全部子 Worker 共用同一实例）。
 * `limits === null` = 未配置任务级预算（现行为）；`tokens` = 强制状态（未声明限额即 unavailable）。
 */
export interface TaskBudget {
  readonly taskId: string;
  readonly limits: TaskBudgetLimits | null;
  readonly used: { readonly ms: number; readonly calls: number; readonly tokens?: number };
  readonly tokens: 'unavailable' | 'enforced';
  consume(usage: BudgetUsage): void;
  exhausted(): BudgetExhaustion | null;
}

export interface Permit {
  readonly ok: true;
  readonly permitId: string;
  readonly kind: AcquireKind;
  readonly taskId: string;
  /** 委派深度：根许可 0；子许可 = 父 + 1。 */
  readonly depth: number;
  /** 派生来源（子许可）；根许可为 null。 */
  readonly parentPermitId: string | null;
  /** 排队/准入时刻（注入时钟）。 */
  readonly acquiredAt: number;
  state: PermitState;
  /** 激活后的回合截止时刻（排队中为 null；晋升时按当时时钟重算）。 */
  deadlineAt: number | null;
  /** 共享的任务预算（父 → 子同一对象）。 */
  readonly budget: TaskBudget;
}

export interface AcquireOptions {
  /** 任务标识（缺省生成 `permit_task_<n>`）。同任务已有活跃/排队许可时重复准入被拒。 */
  readonly taskId?: string;
  /** 父许可：派生委派许可（共享父预算、深度 +1、不占新并发槽）。 */
  readonly parentPermit?: Permit;
}

export interface KindResources {
  readonly kind: AcquireKind;
  readonly limit: number;
  readonly active: number;
  readonly queued: number;
  readonly activeTaskIds: readonly string[];
  readonly queuedTaskIds: readonly string[];
}

export interface ResourceSnapshot {
  readonly foreground: KindResources;
  readonly background: KindResources;
  /** 派生许可（在父回合内执行的子 Worker）；不占并发槽，单列供 ops 观察。 */
  readonly derived: { readonly active: number; readonly taskIds: readonly string[] };
  readonly queueCapacity: number;
  readonly config: ResolvedRuntimeConfig;
}

export interface ResolvedRuntimeConfig {
  readonly mainConcurrency: number;
  readonly backgroundConcurrency: number;
  readonly queueCapacity: number;
  readonly mainTurnMs: number;
  readonly workerTurnMs: number;
  readonly maxDelegationDepth: number;
  readonly taskBudget: TaskBudgetLimits | null;
  readonly waitUserTimeoutMs: number;
}

/**
 * 缺省 = 现行为（P5 回退断言）：单并发 / 无队列 / 无任务级预算；回合时限沿用执行侧
 * 现行缺省（`execution-runtime.ts` 的 DEFAULT_MAIN_TURN_MS / DEFAULT_WORKER_TURN_MS，
 * 300s/180s）；委派深度 1 = 现架构的 Main → Worker 一层。
 */
export const DEFAULT_RUNTIME_CONFIG: ResolvedRuntimeConfig = Object.freeze({
  mainConcurrency: 1,
  backgroundConcurrency: 1,
  queueCapacity: 0,
  mainTurnMs: 300_000,
  workerTurnMs: 180_000,
  maxDelegationDepth: 1,
  taskBudget: null,
  waitUserTimeoutMs: 86_400_000,
});

function assertRuntimeInteger(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`配置项 ${label} 必须是 ≥${min} 的整数（当前: ${String(value)}）`);
  }
  return value;
}

function assertUsageNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`预算用量 ${label} 必须是 ≥0 的有限数值（当前: ${String(value)}）`);
  }
  return value;
}

function resolveTaskBudget(raw: TaskBudgetConfig | undefined): TaskBudgetLimits | null {
  if (raw === undefined) return null;
  const record = raw as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'ms' && key !== 'calls' && key !== 'tokens') {
      throw new Error(`配置项 runtime.taskBudget.${key} 不是已知字段（可选: ms, calls, tokens）`);
    }
  }
  const ms = assertRuntimeInteger(record['ms'], 'runtime.taskBudget.ms', 1);
  const calls = assertRuntimeInteger(record['calls'], 'runtime.taskBudget.calls', 1);
  const tokens = record['tokens'] === undefined
    ? undefined
    : assertRuntimeInteger(record['tokens'], 'runtime.taskBudget.tokens', 1);
  return Object.freeze(tokens === undefined ? { ms, calls } : { ms, calls, tokens });
}

/**
 * 缺省补齐 + 校验（解析后配置的唯一语义来源）。
 *
 * 与加载层同一判据：非法值 fail-fast（不静默回落）、未知 taskBudget 子键拒绝。此处对
 * 程序化构造同样生效（`loadConfig` 已验证 YAML 面，消费方直接构造时这里兜底）。
 */
export function resolveRuntimeConfig(config: RuntimeConfig = {}): ResolvedRuntimeConfig {
  return Object.freeze({
    mainConcurrency: config.mainConcurrency === undefined
      ? DEFAULT_RUNTIME_CONFIG.mainConcurrency
      : assertRuntimeInteger(config.mainConcurrency, 'runtime.mainConcurrency', 1),
    backgroundConcurrency: config.backgroundConcurrency === undefined
      ? DEFAULT_RUNTIME_CONFIG.backgroundConcurrency
      : assertRuntimeInteger(config.backgroundConcurrency, 'runtime.backgroundConcurrency', 0),
    queueCapacity: config.queueCapacity === undefined
      ? DEFAULT_RUNTIME_CONFIG.queueCapacity
      : assertRuntimeInteger(config.queueCapacity, 'runtime.queueCapacity', 0),
    mainTurnMs: config.mainTurnMs === undefined
      ? DEFAULT_RUNTIME_CONFIG.mainTurnMs
      : assertRuntimeInteger(config.mainTurnMs, 'runtime.mainTurnMs', 1),
    workerTurnMs: config.workerTurnMs === undefined
      ? DEFAULT_RUNTIME_CONFIG.workerTurnMs
      : assertRuntimeInteger(config.workerTurnMs, 'runtime.workerTurnMs', 1),
    maxDelegationDepth: config.maxDelegationDepth === undefined
      ? DEFAULT_RUNTIME_CONFIG.maxDelegationDepth
      : assertRuntimeInteger(config.maxDelegationDepth, 'runtime.maxDelegationDepth', 0),
    taskBudget: resolveTaskBudget(config.taskBudget),
    waitUserTimeoutMs: config.waitUserTimeoutMs === undefined
      ? DEFAULT_RUNTIME_CONFIG.waitUserTimeoutMs
      : assertRuntimeInteger(config.waitUserTimeoutMs, 'runtime.waitUserTimeoutMs', 1),
  });
}

export interface ResourcePolicy {
  acquire(kind: AcquireKind, opts?: AcquireOptions): Permit | Rejection;
  /** 释放许可：active 释放槽位并 FIFO 晋升队首；queued = 放弃等待；幂等。 */
  release(permit: Permit): void;
  /** 取消排队中的许可（出队，腾出队列位）；活跃/未知任务返回 false（活跃取消走中止 + release）。 */
  cancelQueued(taskId: string): boolean;
  snapshot(): ResourceSnapshot;
  /** 任务的共享预算；未在本策略准入过的任务 fail-fast（不静默造预算）。 */
  budgetFor(taskId: string): TaskBudget;
}

export interface ResourcePolicyOptions {
  /** 注入时钟（测试确定性）；缺省 `Date.now`。 */
  readonly now?: () => number;
}

interface TaskBudgetFactoryInput {
  readonly taskId: string;
  readonly limits: TaskBudgetLimits | null;
}

function createTaskBudget(input: TaskBudgetFactoryInput): TaskBudget {
  const { taskId, limits } = input;
  let usedMs = 0;
  let usedCalls = 0;
  let usedTokens = 0;
  let tokensObserved = false;
  return {
    taskId,
    limits,
    tokens: limits !== null && limits.tokens !== undefined ? 'enforced' : 'unavailable',
    get used() {
      const includeTokens = tokensObserved || (limits !== null && limits.tokens !== undefined);
      return includeTokens
        ? { ms: usedMs, calls: usedCalls, tokens: usedTokens }
        : { ms: usedMs, calls: usedCalls };
    },
    consume(usage: BudgetUsage): void {
      if (usage.ms !== undefined) usedMs += assertUsageNumber(usage.ms, 'ms');
      if (usage.calls !== undefined) usedCalls += assertUsageNumber(usage.calls, 'calls');
      if (usage.tokens !== undefined) {
        usedTokens += assertUsageNumber(usage.tokens, 'tokens');
        tokensObserved = true;
      }
    },
    exhausted(): BudgetExhaustion | null {
      if (limits === null) return null;
      // 判定顺序固定（ms → calls → tokens）：同一次查询只报一个机械原因。
      if (usedMs >= limits.ms) return { reason: 'ms', limit: limits.ms, used: usedMs };
      if (usedCalls >= limits.calls) return { reason: 'calls', limit: limits.calls, used: usedCalls };
      if (limits.tokens !== undefined && usedTokens >= limits.tokens) {
        return { reason: 'tokens', limit: limits.tokens, used: usedTokens };
      }
      return null;
    },
  };
}

/**
 * 创建资源策略（单一实例=单一资源账本；进程内单实例，见分诊 #7「单实例 + 文档登记」）。
 */
export function createResourcePolicy(
  config?: RuntimeConfig,
  options: ResourcePolicyOptions = {},
): ResourcePolicy {
  const resolved = resolveRuntimeConfig(config);
  const clock = options.now ?? Date.now;
  let permitSequence = 0;
  let autoTaskSequence = 0;

  const slots: Record<AcquireKind, { active: Permit[]; queue: Permit[] }> = {
    foreground: { active: [], queue: [] },
    background: { active: [], queue: [] },
  };
  /** 活跃 + 排队的许可（按任务；含派生）。 */
  const liveByTask = new Map<string, Permit>();
  /** 任务 → 共享预算（含已完成/等待中的任务：等待恢复需要同一对象、用量不重置）。 */
  const budgets = new Map<string, TaskBudget>();
  /** 派生许可（在父回合内执行；不占并发槽）。 */
  const derivedPermits = new Map<string, Permit>();

  function limitFor(kind: AcquireKind): number {
    return kind === 'foreground' ? resolved.mainConcurrency : resolved.backgroundConcurrency;
  }

  function turnMsFor(kind: AcquireKind): number {
    return kind === 'foreground' ? resolved.mainTurnMs : resolved.workerTurnMs;
  }

  function reject(kind: AcquireKind, taskId: string, reason: RejectionReason, message: string): Rejection {
    return { ok: false, kind, taskId, reason, message };
  }

  function admit(input: {
    kind: AcquireKind;
    taskId: string;
    depth: number;
    parentPermitId: string | null;
    budget: TaskBudget;
    state: 'active' | 'queued';
  }): Permit {
    const now = clock();
    return {
      ok: true,
      permitId: `permit_${++permitSequence}`,
      kind: input.kind,
      taskId: input.taskId,
      depth: input.depth,
      parentPermitId: input.parentPermitId,
      acquiredAt: now,
      state: input.state,
      deadlineAt: input.state === 'active' ? now + turnMsFor(input.kind) : null,
      budget: input.budget,
    };
  }

  function acquire(kind: AcquireKind, opts: AcquireOptions = {}): Permit | Rejection {
    const requested = opts.taskId?.trim();
    const taskId = requested !== undefined && requested !== '' ? requested : `permit_task_${++autoTaskSequence}`;

    const live = liveByTask.get(taskId);
    if (live !== undefined) {
      return reject(kind, taskId, 'quota_exceeded', `任务已有${live.state === 'active' ? '活跃' : '排队'}许可`);
    }

    const parent = opts.parentPermit;
    if (parent !== undefined) {
      if (parent.state !== 'active') {
        return reject(kind, taskId, 'quota_exceeded', `父许可未激活（当前: ${parent.state}），不能派生委派许可`);
      }
      const depth = parent.depth + 1;
      if (depth > resolved.maxDelegationDepth) {
        return reject(kind, taskId, 'depth_exceeded', `委派深度 ${depth} 超过上限 ${resolved.maxDelegationDepth}`);
      }
      const exhausted = parent.budget.exhausted();
      if (exhausted !== null) {
        return reject(
          kind,
          taskId,
          'budget_exhausted',
          `父任务预算已耗尽（${exhausted.reason}: ${exhausted.used}/${exhausted.limit}）`,
        );
      }
      // 派生许可：不占新并发槽；共享父预算的同一对象（不复制、不放大）。
      const permit = admit({
        kind,
        taskId,
        depth,
        parentPermitId: parent.permitId,
        budget: parent.budget,
        state: 'active',
      });
      liveByTask.set(taskId, permit);
      budgets.set(taskId, parent.budget);
      derivedPermits.set(permit.permitId, permit);
      return permit;
    }

    // 等待恢复等场景：任务预算已耗尽 → 确定性拒绝（不重置、不放行）。
    const knownBudget = budgets.get(taskId);
    if (knownBudget !== undefined) {
      const exhausted = knownBudget.exhausted();
      if (exhausted !== null) {
        return reject(
          kind,
          taskId,
          'budget_exhausted',
          `任务预算已耗尽（${exhausted.reason}: ${exhausted.used}/${exhausted.limit}）`,
        );
      }
    }

    const limit = limitFor(kind);
    if (limit <= 0) {
      return reject(kind, taskId, 'quota_exceeded', `${kind === 'foreground' ? '前台' : '后台'}并发上限为 0（准入关闭）`);
    }
    const slot = slots[kind];
    if (slot.active.length >= limit) {
      if (slot.queue.length >= resolved.queueCapacity) {
        return reject(
          kind,
          taskId,
          'queue_full',
          `${kind === 'foreground' ? '前台' : '后台'}并发已满且等待队列已满（容量 ${resolved.queueCapacity}）`,
        );
      }
      const queuedBudget = knownBudget ?? createTaskBudget({ taskId, limits: resolved.taskBudget });
      budgets.set(taskId, queuedBudget);
      const queued = admit({ kind, taskId, depth: 0, parentPermitId: null, budget: queuedBudget, state: 'queued' });
      slot.queue.push(queued);
      liveByTask.set(taskId, queued);
      return queued;
    }

    const budget = knownBudget ?? createTaskBudget({ taskId, limits: resolved.taskBudget });
    budgets.set(taskId, budget);
    const permit = admit({ kind, taskId, depth: 0, parentPermitId: null, budget, state: 'active' });
    slot.active.push(permit);
    liveByTask.set(taskId, permit);
    return permit;
  }

  function release(permit: Permit): void {
    if (permit.state === 'released' || permit.state === 'cancelled') return; // 幂等
    if (permit.parentPermitId !== null) {
      permit.state = 'released';
      liveByTask.delete(permit.taskId);
      derivedPermits.delete(permit.permitId);
      return;
    }
    const slot = slots[permit.kind];
    if (permit.state === 'queued') {
      const index = slot.queue.indexOf(permit);
      if (index !== -1) slot.queue.splice(index, 1);
      permit.state = 'released';
      liveByTask.delete(permit.taskId);
      return;
    }
    const index = slot.active.indexOf(permit);
    if (index !== -1) slot.active.splice(index, 1);
    permit.state = 'released';
    liveByTask.delete(permit.taskId);
    // FIFO 晋升：等待时间不计入回合时限（晋升时按当时时钟取新截止）。
    const next = slot.queue.shift();
    if (next !== undefined) {
      next.state = 'active';
      next.deadlineAt = clock() + turnMsFor(next.kind);
      slot.active.push(next);
    }
  }

  function cancelQueued(taskId: string): boolean {
    const permit = liveByTask.get(taskId);
    if (permit === undefined || permit.state !== 'queued') return false;
    const slot = slots[permit.kind];
    const index = slot.queue.indexOf(permit);
    if (index !== -1) slot.queue.splice(index, 1);
    permit.state = 'cancelled';
    liveByTask.delete(taskId);
    return true;
  }

  function kindResources(kind: AcquireKind): KindResources {
    const slot = slots[kind];
    return {
      kind,
      limit: limitFor(kind),
      active: slot.active.length,
      queued: slot.queue.length,
      activeTaskIds: slot.active.map((permit) => permit.taskId),
      queuedTaskIds: slot.queue.map((permit) => permit.taskId),
    };
  }

  function snapshot(): ResourceSnapshot {
    return {
      foreground: kindResources('foreground'),
      background: kindResources('background'),
      derived: {
        active: derivedPermits.size,
        taskIds: [...derivedPermits.values()].map((permit) => permit.taskId),
      },
      queueCapacity: resolved.queueCapacity,
      config: resolved,
    };
  }

  function budgetFor(taskId: string): TaskBudget {
    const budget = budgets.get(taskId);
    if (budget === undefined) {
      throw new Error(`未知任务预算：${taskId}（未在该策略里准入过的任务不造预算）`);
    }
    return budget;
  }

  return { acquire, release, cancelQueued, snapshot, budgetFor };
}
