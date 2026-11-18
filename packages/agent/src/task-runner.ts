/**
 * 后台任务执行（P6）：受理 → 底账 queued → dispatcher 认领（lease）→ running → 终态；
 * 进程内调度与重启恢复、取消、资源许可消费。契约来源：docs/history/r4-joint-interfaces.md
 * §1（TaskRegistry）/§2（ResourcePolicy）/§3（TaskRunner）v1 冻结。
 *
 * 边界（硬约束，缺一不做）：
 *   · 队列 = 底账 queued 行 + claim/lease，**不引第二套队列**：本模块不持有待跑清单，
 *     内存 inFlight 只是「本进程在飞回合」的账（谁在跑），不是队列（谁要跑）；
 *   · 状态唯一写路径 = 注入的 TaskRegistryPort（§1 方法族）；本模块不做任何直接状态写入；
 *     后台终态 = **执行端确认的回合结局**（transition/fail 落底账），不做 task 级
 *     judgeReportedTask 二次判定——inline judge 的「首个非 completed 判负」会误伤等待接续
 *     （P2 契约测试同口径：后台路径由 runner 按执行层确认的结果落终态）；逐回合判定归执行端；
 *   · 资源 = 只消费注入的 ResourcePolicyPort 的**后台**许可（§2）；前后台配额独立由 P5 保证，
 *     本模块不申请/不占用前台许可；后台满载时前台路径不经过本模块（不被阻塞）；
 *   · 通知 = 不做（P4 从底账事实钩子取，§1 onTaskFact/§4）；本模块不建事件总线/订阅体系；
 *   · 转录隔离 = 注入的 TaskExecutor 保证（每次派发一个新执行回合）；本模块只编排：不持有
 *     agent 对象（Task 不绑永久 Agent）、不接触 mainMessages、不强制多级 Agent；
 *   · 调度 = 无阻塞 sleep 轮询：pump() 是同步单趟派发（注入时钟 now()；触发来自调用方与
 *     回合落定后的内部再派发）；许可拒绝是错误面（如实返回 reason），不排队阻塞、不空转。
 *
 * 恢复策略（restart）：每次 pump 先 registry.expireLeases(now)——
 *   · queued → claimNextQueued 重新认领（lease 幂等 by taskId）；
 *   · running 且租约过期 → 底账落 result_unknown（禁止自动重放，尤其可能有副作用者）；
 *   · completed/failed 等终态不在认领范围（不重跑）；无租约的 running 属 inline 任务，
 *     不在回收范围（expireLeases 语义）。
 *
 * waiting_user 到期消费者（2026-11-18，W 切片）：注入 `waitUserTimeoutMs` 后，runner 持有
 * **一个**有界定时器（同一时刻至多一个；每次 pump 重算最早到期点后重武装）。每个推进周期
 * （含启动后的第一次 pump）先按底账行的 `waiting_since + waitUserTimeoutMs <= now` 扫一遍：
 * 到期行走既有 `timeout(taskId,'waiting_user')` 合法边 → `timed_out` + reason=timeout，
 * 事实钩子照常产出既有 `timed_out` 通知。判定只看持久化底账，不依赖上一进程的内存定时器，
 * 因此重启后无需额外恢复路径。未注入 `waitUserTimeoutMs`（或底账没有 list 面）时完全不建
 * 定时器、不扫底账——直用 runner 的调用方行为零变化；装配方传 `resolveRuntimeConfig()`
 * 的值（配置缺省 24h）启用。
 *
 * 租约口径（集成要求）：leaseMs 必须覆盖最长执行回合（按 P5 workerTurnMs 取，且执行端以截止
 * 时间强制中止）；§1 无租约续期方法，超出租约的在飞回合会被下一次 pump 判为 result_unknown
 * （保守口径：unknown ≠ failed ≠ success）。
 *
 * 取消状态机（§1/§5）：queued/waiting_user（无在飞回合）→ requestCancel→confirmCancelled
 * 机械确认；running → requestCancel（cancelling）+ abort 信号；执行端确认（返回
 * {kind:'cancelled'} 或 AbortError 结束）才 confirmCancelled；未获确认（回合照常完成/报错）
 * → 回 running 并如实落终态（cancelling→running 是「不得宣称取消」的回滚边）。
 *
 * 登记缺口（不在本模块预造，归属集成/后续切片）：
 *   · 重启时停在 cancelling 的孤儿任务（expireLeases 只回收 running；回滚/确认边界由 P2/P5 定）；
 *   · waiting_user 答复接续回合无租约（answerResumes 不写租约），进程中断后的回收未覆盖；
 *   · 满员/队列满的「拒绝」落点（P7b 起）：由集成接线在受理侧落地——execution-runtime 委派前
 *     按 policy 事实拒绝（任务 failed + resource_limited，不进入执行）；runner 收到排队许可
 *     （state='queued'）时只停止派发（队列 = 底账 queued 行），不据此直派发（否则绕过并发上限）；
 *     queued 超时计时仍由 P5 边界触发底账 timeout（runner 不为排队做计时器）；
 *     waiting_user 到期由上面的单一有界定时器轮消费（W 切片）。
 *   · 后台任务结果文本（resultText）：集成裁定落点=settle 确认 `completed` 终态后经端口
 *     可选方法 `archiveReply` 逐字存档（P2 的 P1 存档面；不经 inline `complete()`/
 *     task 级 judge，避免误伤等待接续）——P6-E01「结果可取回」由此具备执行口径。
 *
 * 移植性：本文件零仓内 import（端口为对接冻结契约的最小结构类型，非新协议层）；集成时由
 * 装配方把 P2 registry / P5 policy / 执行回合接到端口上（结构兼容，签名实现自定）。
 */

// ---------------------------------------------------------------------------
// 底账端口（§1 最小消费面）
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'unexecuted';

/** 机械终止原因（§1 冻结枚举）。 */
export type TaskReason = 'cancelled_by_user' | 'timeout' | 'failed_confirmed' | 'result_unknown' | 'resource_limited';

export type TimeoutKind = 'queued' | 'execution' | 'waiting_user';

/** 写操作提案的机械形状（与 task-registry.PendingConfirmation 同形；本文件零仓内 import）。 */
export interface PendingConfirmation {
  handle: string;
  summary: string;
  expiresAt?: string;
  operation: string;
}

/** waiting_user 的机械问题形状（执行层 needs_input 事实；不编造、不改写候选）。 */
export interface PendingQuestion {
  missing: readonly string[];
  candidates?: readonly string[];
  raw?: string;
  /** 写操作提案（needs_confirmation 与 needs_input 同走 waiting_user，不新状态）。 */
  confirmation?: PendingConfirmation;
}

export interface TaskScope {
  principalId: string;
  sessionId: string;
}

/** 任务行只读投影（runner 只读这些字段；其余字段与本模块无关）。 */
export interface TaskRecordView {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  status: TaskStatus;
  reason?: TaskReason;
  resultText?: string;
  failureReason?: string;
  pendingQuestion?: PendingQuestion;
  waitingSince?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  taskNo?: number;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

/** 状态变更方法的公共选项：给出 scope 时底账先校验归属（越权与不存在同错）。 */
export interface MutationOptions {
  scope?: TaskScope;
}

export interface TransitionOptions extends MutationOptions {
  reason?: TaskReason;
}

export interface TaskRegistryPort {
  /** 受理：status 缺省 running（inline 语义）；'queued' = 后台受理（submit）。 */
  begin(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    request: string;
    status?: 'queued' | 'running';
  }): TaskRecordView;
  get(taskId: string, scope?: TaskScope): TaskRecordView;
  transition(taskId: string, to: TaskStatus, options?: TransitionOptions): TaskRecordView;
  waitForUser(taskId: string, pendingQuestion: PendingQuestion, options?: MutationOptions): TaskRecordView;
  answerResumes(taskId: string, options?: MutationOptions): TaskRecordView;
  requestCancel(taskId: string, options?: MutationOptions): TaskRecordView;
  confirmCancelled(taskId: string, options?: MutationOptions): TaskRecordView;
  timeout(taskId: string, kind: TimeoutKind, options?: MutationOptions): TaskRecordView;
  markResultUnknown(taskId: string, options?: MutationOptions): TaskRecordView;
  /** 已确认失败（无执行事实可判定时的机械失败；原因文本原样落底账）。 */
  fail(taskId: string, reason: string): void;
  /**
   * 后台成功结果的逐字存档（可选；集成接线后的底账实现提供）。
   * 语义 = P2 的 `archiveReply`：settle 确认落 `completed` 终态后调用，逐字写任务行
   * resultText（结果可找回；不经 inline `complete()`/judgeReportedTask）。
   */
  archiveReply?(taskIds: readonly string[], replyText: string): void;
  /** 原子认领最老 queued（queued→running + lease）；无则 undefined。队列唯一入口。 */
  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecordView | undefined;
  /** 过期 running 租约 → result_unknown（返回受影响任务；不自动重放）。 */
  expireLeases(now?: string): readonly TaskRecordView[];
  /**
   * 只读任务行（waiting_user 到期扫描用；可选）。缺省 = 不启用到期消费者（零行为变化）；
   * 真底账实现提供；runner 只读状态与 waitingSince，不直接写状态。
   */
  list?(scope?: TaskScope): readonly TaskRecordView[];
  /**
   * 只读 **waiting_user 行**（到期扫描用；可选）。缺省时回落到 `list()` 再过滤——
   * 大积压（实测 500 任务）下全表 list 每趟 pump 都分配一遍，把 RSS 顶到 10% 门槛以上；
   * 提供本方法后每趟只取等待行（通常 0 条）。
   */
  listWaiting?(): readonly TaskRecordView[];
}

// ---------------------------------------------------------------------------
// 资源许可端口（§2 最小消费面）
// ---------------------------------------------------------------------------

export type ResourceRejectionReason = 'queue_full' | 'quota_exceeded' | 'budget_exhausted' | 'depth_exceeded';

export interface ResourcePermit {
  kind: 'foreground' | 'background';
  taskId?: string;
  /**
   * 许可状态（§2 真实 Permit 的投影）：'queued' = 暂无槽位、等待晋升——后台队列是底账
   * queued 行，runner 不得据排队许可直派发（释放并停止本轮 pump）。测试替身可缺省。
   */
  readonly state?: 'queued' | 'active' | 'released' | 'cancelled';
}

export interface ResourceRejection {
  reason: ResourceRejectionReason;
}

export interface ResourcePolicyPort {
  acquire(kind: 'foreground' | 'background', opts?: { taskId?: string }): ResourcePermit | ResourceRejection;
  release(permit: ResourcePermit): void;
  cancelQueued(taskId: string): void;
  /**
   * 任务预算计量（可选；§2 真实 ResourcePolicy 提供）：后台执行回合按真实 taskId 计入
   * taskBudget（P0-C①：原 consume 唯一调用点在 inline 委派，后台回合不计量）。
   * 未在该策略准入过的任务可能抛错/缺省——调用方跳过计量，不造预算（policy 契约）。
   */
  budgetFor?(taskId: string): { consume(usage: { calls?: number; ms?: number }): void };
}

function isRejection(result: ResourcePermit | ResourceRejection): result is ResourceRejection {
  return typeof result === 'object' && result !== null && 'reason' in result;
}

// ---------------------------------------------------------------------------
// 执行器端口（注入的执行回合；转录隔离/Worker 生命周期由实现方保证）
// ---------------------------------------------------------------------------

export interface TaskExecutionInput {
  taskId: string;
  taskNo?: number;
  name?: string;
  request: string;
  principalId: string;
  sessionId: string;
  /** waiting_user 答复接续时的用户答复原文（首轮执行缺省）。 */
  answer?: string;
}

export interface TaskExecutionContext {
  /** 取消请求的中止信号：执行端观察后以 {kind:'cancelled'} 或 AbortError 结束（确认才 cancelled）。 */
  signal: AbortSignal;
}

/** 后台任务产物引用（结构 = 交付面 TurnFileRef 的机械事实三字段 + 交付角色）。 */
export interface TaskOutcomeFile {
  fileId: string;
  name: string;
  bytes: number;
  deliverable?: boolean;
}

/**
 * 一次执行回合的机械结局（runner 据此走底账合法边；不替执行端二次判定）：
 *   · completed  → 回合正常收尾，**执行端已按本回合执行事实确认成功**（权威）；
 *   · failed     → 已确认失败（原因原文；无执行事实可判定时的机械失败）；
 *   · needs_input→ 执行层要求补充输入（running→waiting_user，同 Task 接续）；
 *   · needs_confirmation → 执行层冻结了一次待确认写操作（running→waiting_user 同一状态机；
 *     confirmation 原样进底账待后续回合透传，S1 不做推送/透传）；
 *   · timed_out  → 执行回合超时（P5 边界内的执行端判定）；
 *   · cancelled  → 执行端确认已中止（abort 观察）。
 *
 * 执行端义务（端口契约；runner 不做 task 级再判定）：completed 仅当本回合确有执行且全部成功；
 * 零执行不得报 completed（如实报 failed/needs_input）；执行层拒绝/失败 → failed（原因原文）。
 * 「执行层实际成功 / 拒绝或失败 / 未发起执行」的顶层可区分性由此在执行端回合判定中成立。
 */
export type TaskExecutionOutcome =
  /**
   * 后台回合完成。files = 本回合 Worker 产出的**任务作用域**交付物（登记事实）；
   * 这是后台面对 TurnResult.files 的同位面（后台没有前台回合）：装配方按它投递。
   */
  | { kind: 'completed'; resultText: string; files?: readonly TaskOutcomeFile[] }
  | { kind: 'failed'; reason: string }
  | { kind: 'needs_input'; question: PendingQuestion }
  /**
   * 本回合以「写操作提案待用户确认」收尾：question 是 waiting_user 的问题形状，
   * confirmation 是执行层发放的句柄/摘要（落底账 pendingQuestion.confirmation，同状态机）。
   */
  | { kind: 'needs_confirmation'; question: PendingQuestion; confirmation: PendingConfirmation }
  | { kind: 'timed_out' }
  | { kind: 'cancelled' }
  /**
   * U3：结果未知（无法证明本次调用属于已有操作 / 外部无回执 / 调用中断）——
   * 不是成功、也不是已确认失败；落 failed + reason=result_unknown，禁止自动重试。
   */
  | { kind: 'result_unknown'; reason: string };

export interface TaskExecutor {
  execute(task: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome>;
}

/**
 * 单一定时器端口（测试注入假时钟/假定时器，不真 sleep）。
 * runner 同一时刻只持有一个 handle；clear 幂等。
 */
export interface RunnerTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface TaskRunnerOptions {
  registry: TaskRegistryPort;
  policy: ResourcePolicyPort;
  executor: TaskExecutor;
  /** 认领租约属主（缺省 'task-runner'；多进程部署由装配方给区分值）。 */
  owner?: string;
  /** 租约时长；必须覆盖最长执行回合（缺省 300_000ms，见头部「租约口径」）。 */
  leaseMs?: number;
  /** 注入时钟（租约计算与过期判定；缺省系统时钟）。 */
  now?: () => Date;
  /**
   * waiting_user 到期阈值（ms）。缺省/0 = 不启用到期消费者（直用 runner 零行为变化）；
   * 装配方传 `resolveRuntimeConfig().waitUserTimeoutMs`（配置缺省 86_400_000）启用。
   * 判定 = 底账 `waiting_since + waitUserTimeoutMs <= now`（与进程内定时器无关，重启可判）。
   */
  waitUserTimeoutMs?: number;
  /** 单一定时器轮（缺省全局 setTimeout；测试注入假定时器）。仅在启用到期消费者时使用。 */
  timers?: RunnerTimers;
  /**
   * waiting 扫描节流（ms，缺省 1000）：pump 很频繁，每趟全表扫 500 行会把 RSS 顶起来
   * （2026-11-18 实测：500 积压下 I5 从 <10% 变 14–28%）。仅当"到了上次算出的到期点、
   * 或距上次扫描超过节流窗口、或从未扫过"才真正扫一次；超时判定精度让出最多一个窗口，
   * 相对缺省 24h 的超时阈值可忽略。
   */
  waitingScanThrottleMs?: number;
  /** 收尾错误的观察点（如外部先落终态、底账拒绝非法边）：不改变任务事实，只如实上报。 */
  onError?: (failure: { taskId: string; error: unknown }) => void;
}

export interface SubmitInput {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
}

/** 单趟派发结果（错误面如实返回；不是通知系统）。 */
export interface PumpSummary {
  /** 本次 pump 判为 result_unknown 的过期租约任务。 */
  recovered: readonly string[];
  /** 本次启动执行回合的任务（认领成功）。 */
  started: readonly string[];
  /** 因许可拒绝而停止派发时的拒绝原因（任务留在 queued，等容量恢复/下次触发）。 */
  rejection?: ResourceRejectionReason;
  /**
   * 本次按 waiting_since + waitUserTimeoutMs 判为 timed_out 的任务。
   * 仅在启用到期消费者时出现（未注入 waitUserTimeoutMs 时字段整个缺省，返回形状不变）。
   */
  timedOutWaiting?: readonly string[];
}

export type CancelOutcome =
  /** 已确认取消（queued/waiting_user 无在飞回合，机械确认）。 */
  | { outcome: 'cancelled'; taskId: string }
  /** 已请求中止（running：等执行端确认，确认前不得宣称已取消）。 */
  | { outcome: 'requested'; taskId: string }
  /** 终态任务无操作。 */
  | { outcome: 'terminal'; taskId: string; status: TaskStatus };

export type ResumeOutcome =
  | { outcome: 'started'; taskId: string }
  | { outcome: 'rejection'; taskId: string; reason: ResourceRejectionReason }
  | { outcome: 'not_waiting'; taskId: string; status: TaskStatus };

export interface TaskRunner {
  /** 受理：底账 begin(status:'queued')，同步返回（Main 不等待）；派发由 pump 触发。 */
  submit(input: SubmitInput): TaskRecordView;
  /**
   * 单趟派发（同步、非阻塞）：先恢复（过期租约→result_unknown），再按后台许可认领并启动
   * 执行回合；许可拒绝即停止并如实返回。无 sleep、无内部轮询。
   */
  pump(): PumpSummary;
  /** 等待在飞回合全部落定（含落定触发的再派发），测试/收尾用。 */
  whenIdle(): Promise<void>;
  /** 取消：请求 ≠ 取消；确认（abort 观察/执行层确认）后才 cancelled（见头部状态机）。 */
  cancel(taskId: string, scope?: TaskScope): CancelOutcome;
  /** waiting_user 答复接续：同一 Task 新回合（编号不变、executions 追加）；许可不足不接续。 */
  resume(taskId: string, options?: { answer?: string; scope?: TaskScope }): ResumeOutcome;
  /** 本进程在飞执行回合的任务 id（只读快照）。 */
  inFlight(): readonly string[];
}

type RoundResult =
  | { kind: 'outcome'; outcome: TaskExecutionOutcome }
  | { kind: 'threw'; error: unknown };

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'cancelled',
  'completed',
  'failed',
  'timed_out',
  'unexecuted',
]);

export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const { registry, policy, executor } = options;
  const owner = options.owner ?? 'task-runner';
  const leaseMs = options.leaseMs ?? 300_000;
  const now = options.now ?? ((): Date => new Date());
  const onError = options.onError;
  /**
   * waiting_user 到期消费者：未配阈值（或底账无 list 面）时完全不建定时器/不扫底账，
   * 直用 runner 的调用方行为零变化。装配方注入配置值（缺省 24h）才启用。
   */
  const waitUserTimeoutMs = options.waitUserTimeoutMs ?? 0;
  const waitingScanThrottleMs = options.waitingScanThrottleMs ?? 1000;
  let lastWaitingScan: { at: number; nextDue?: number } | undefined;
  const waitingConsumerEnabled = waitUserTimeoutMs > 0 && (registry.listWaiting !== undefined || registry.list !== undefined);
  const timers: RunnerTimers | undefined = waitingConsumerEnabled
    ? options.timers ?? {
      set(callback, delayMs) {
        const handle = setTimeout(callback, delayMs);
        const unref = (handle as { unref?: () => void }).unref;
        if (typeof unref === 'function') unref.call(handle);
        return handle;
      },
      clear(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    }
    : undefined;
  /** setTimeout 的最大延迟（超过会被 Node 折成 1ms：先钳到上限，下一轮重算）。 */
  const MAX_TIMER_DELAY_MS = 2_147_483_647;
  let waitingTimer: unknown;
  let waitingTimerArmed = false;

  /** 本进程在飞执行回合：taskId → abort 控制器 / 落定链。不是队列（队列=底账 queued 行）。 */
  const controllers = new Map<string, AbortController>();
  const inFlight = new Map<string, Promise<void>>();
  let pumpQueued = false;

  function report(taskId: string, error: unknown): void {
    if (onError === undefined) return;
    try {
      onError({ taskId, error });
    } catch {
      // 观察者故障不改变任务事实（不重试、不落库）。
    }
  }

  function mutationOptions(scope?: TaskScope): MutationOptions {
    return scope === undefined ? {} : { scope };
  }

  /** 回合落定后的再派发（事件驱动，无 sleep 轮询）。 */
  function schedulePump(): void {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      pump();
    });
  }

  interface WaitingScan {
    timedOut: string[];
    nextDue?: number;
  }

  /** waiting_user 行的到期时刻（waiting_since + 阈值）；非等待行/坏时间戳不参与判定。 */
  function waitingDeadlineOf(task: TaskRecordView): number | undefined {
    if (task.status !== 'waiting_user' || task.waitingSince === undefined) return undefined;
    const since = Date.parse(task.waitingSince);
    return Number.isFinite(since) ? since + waitUserTimeoutMs : undefined;
  }

  function isTransitionRace(error: unknown): boolean {
    return error instanceof Error && error.name === 'TaskTransitionError';
  }

  /**
   * 单趟扫描持久化底账：到期行走既有 timeout(...,'waiting_user') 边，返回下一个到期时刻。
   * 只读 list + 状态方法族（不直接写状态）；并发下任务已被答复/取消时吞掉非法边（不是本进程
   * 的目标），不推翻已发生的事实。
   */
  function scanWaiting(nowMs: number): WaitingScan {
    const timedOut: string[] = [];
    let nextDue: number | undefined;
    const rows = registry.listWaiting !== undefined ? registry.listWaiting() : registry.list!();
    for (const task of rows) {
      const due = waitingDeadlineOf(task);
      if (due === undefined) continue;
      if (due <= nowMs) {
        try {
          registry.timeout(task.taskId, 'waiting_user');
          timedOut.push(task.taskId);
        } catch (error) {
          if (isTransitionRace(error)) continue;
          throw error;
        }
      } else if (nextDue === undefined || due < nextDue) {
        nextDue = due;
      }
    }
    return { timedOut, ...(nextDue === undefined ? {} : { nextDue }) };
  }

  function clearWaitingTimer(): void {
    if (!waitingTimerArmed) return;
    waitingTimerArmed = false;
    timers!.clear(waitingTimer);
    waitingTimer = undefined;
  }

  /** 重武装唯一定时器：无等待行即不建；有则只保留下一个到期点。 */
  function armWaitingTimer(nextDue: number | undefined): void {
    if (!waitingConsumerEnabled) return;
    clearWaitingTimer();
    if (nextDue === undefined) return;
    const delayMs = Math.min(Math.max(0, nextDue - now().getTime()), MAX_TIMER_DELAY_MS);
    waitingTimer = timers!.set(() => {
      waitingTimerArmed = false;
      waitingTimer = undefined;
      try {
        pump();
      } catch (error) {
        // 定时器回调里的异常不能变成进程级未捕获错误（如收尾阶段底账已关闭）：
        // 只如实上报观察点，不改变任务事实（下一趟 pump 会重新判定）。
        report('waiting_user_timeout', error);
      }
    }, delayMs);
    waitingTimerArmed = true;
  }

  function pump(): PumpSummary {
    const recovered = registry.expireLeases(now().toISOString()).map((task) => task.taskId);
    let waiting: WaitingScan | undefined;
    if (waitingConsumerEnabled) {
      const nowMs = now().getTime();
      const due = lastWaitingScan?.nextDue;
      const shouldScan = lastWaitingScan === undefined
        || (due !== undefined && nowMs >= due)
        || nowMs - lastWaitingScan.at >= waitingScanThrottleMs;
      if (shouldScan) {
        waiting = scanWaiting(nowMs);
        lastWaitingScan = { at: nowMs, ...(waiting.nextDue === undefined ? {} : { nextDue: waiting.nextDue }) };
      }
    }
    const started: string[] = [];
    let rejection: ResourceRejectionReason | undefined;
    for (;;) {
      // 先取许可再认领：认领即 running，而 running 没有回 queued 的合法边——
      // 许可不足的任务必须留在 queued，不得先认领再退回。
      const acquired = policy.acquire('background');
      if (isRejection(acquired)) {
        rejection = acquired.reason;
        break;
      }
      // 排队许可（state='queued'）= 暂无槽位；后台队列是底账 queued 行，不是 policy 队列——
      // 据排队许可直派发会绕过并发上限（队列容量>0 时实测 maxActive > backgroundConcurrency）。
      // 释放排队许可并停止本轮派发；槽位释放后的 schedulePump 会重新认领。
      if (acquired.state === 'queued') {
        policy.release(acquired);
        break;
      }
      const claimed = registry.claimNextQueued({ owner, leaseMs });
      if (claimed === undefined) {
        policy.release(acquired);
        break;
      }
      started.push(claimed.taskId);
      startRound(claimed, acquired);
    }
    if (waiting !== undefined) armWaitingTimer(waiting.nextDue);
    return {
      recovered,
      started,
      ...(rejection === undefined ? {} : { rejection }),
      ...(waiting === undefined ? {} : { timedOutWaiting: waiting.timedOut }),
    };
  }

  function startRound(task: TaskRecordView, permit: ResourcePermit, answer?: string): void {
    const controller = new AbortController();
    controllers.set(task.taskId, controller);
    // P0-C①：后台回合按真实 taskId 计入任务预算（calls=1 + 实际时长）；
    // 预算不存在的任务（未准入/无该端口的假件）跳过计量，不影响任务事实。
    const roundStartedAt = now().getTime();
    const input: TaskExecutionInput = {
      taskId: task.taskId,
      ...(task.taskNo === undefined ? {} : { taskNo: task.taskNo }),
      ...(task.name === undefined ? {} : { name: task.name }),
      request: task.request,
      principalId: task.principalId,
      sessionId: task.sessionId,
      ...(answer === undefined ? {} : { answer }),
    };
    // 同步发起（pump 返回前执行端已被调用）；经 Promise 化兜住执行端同步抛错。
    let round: Promise<TaskExecutionOutcome>;
    try {
      round = Promise.resolve(executor.execute(input, { signal: controller.signal }));
    } catch (error) {
      round = Promise.reject(error);
    }
    const chain = round
      .then(
        (outcome): RoundResult => ({ kind: 'outcome', outcome }),
        (error: unknown): RoundResult => ({ kind: 'threw', error }),
      )
      .then((result) => {
        try {
          settle(task.taskId, result);
        } catch (error) {
          report(task.taskId, error);
        } finally {
          controllers.delete(task.taskId);
          inFlight.delete(task.taskId);
          meterRound(task.taskId, now().getTime() - roundStartedAt);
          policy.release(permit);
          schedulePump();
        }
      });
    inFlight.set(task.taskId, chain);
  }

  /** P0-C①：回合计量——完成/失败/取消都在 finally 各计一次实际时长，之后不再消费（P0-C②）。 */
  function meterRound(taskId: string, ms: number): void {
    if (policy.budgetFor === undefined) return;
    try {
      // 直接以 policy 调用（保 this 绑定）；未准入过的任务会抛错——§2 契约不造预算，跳过。
      policy.budgetFor(taskId).consume({ calls: 1, ms });
    } catch {
      // 未在该策略准入过的任务不造预算（§2 契约）：跳过计量，不改变任务事实。
    }
  }

  /**
   * 收尾：读取最新状态（取消请求/外部终态可能先落），走底账合法边，绝不覆盖既有终态。
   * cancelling + 回合照常结束 = 中止未获确认 → 先回 running 再如实落实际终态（留痕）。
   */
  function settle(taskId: string, result: RoundResult): void {
    const status = registry.get(taskId).status;

    if (result.kind === 'threw') {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      if (status === 'cancelling' && isAbortError(result.error)) {
        registry.confirmCancelled(taskId); // abort 观察：确认中止
        return;
      }
      if (status === 'cancelling') registry.transition(taskId, 'running'); // 未获确认：不得宣称取消
      if (status === 'cancelling' || status === 'running') {
        registry.fail(taskId, message);
        return;
      }
      report(taskId, new Error(`回合收尾时任务已处于终态（${status}），不覆盖既有事实。`));
      return;
    }

    const { outcome } = result;
    const live = status === 'cancelling' || status === 'running';
    if (status === 'cancelling' && outcome.kind !== 'cancelled') {
      registry.transition(taskId, 'running'); // 同上：未获确认的中止请求回滚
    }
    if (!live) {
      report(taskId, new Error(`回合收尾（${outcome.kind}）时任务已处于终态（${status}），不覆盖既有事实。`));
      return;
    }
    switch (outcome.kind) {
      case 'completed': {
        // 后台终态 = 执行端确认的回合结局（P2 契约：后台不经 inline judgeReportedTask——
        // 其「首个非 completed 判负」会把等待接续的历史行误判为 failed）。
        registry.transition(taskId, 'completed');
        // 结果逐字存档（集成裁定，P6 报告 §七.3）：确认终态后经 P2 archiveReply 写 resultText；
        // 空白结果不落（缺省=无存档，显示层不以汇报冒充）。
        const resultText = outcome.resultText.trim();
        if (resultText !== '' && registry.archiveReply !== undefined) {
          registry.archiveReply([taskId], outcome.resultText);
        }
        return;
      }
      case 'failed':
        registry.fail(taskId, outcome.reason);
        return;
      case 'result_unknown':
        // U3：结果未知 ≠ 已确认失败 ≠ 成功（既有原因枚举，不新增状态）。
        registry.markResultUnknown(taskId);
        return;
      case 'needs_input':
        registry.waitForUser(taskId, outcome.question);
        return;
      case 'needs_confirmation':
        // 写操作提案：与 needs_input 同一 waiting_user 状态机（不新状态、不建确认门）；
        // confirmation 随问题落底账，是否确认由后续回合的用户表态与执行层校验决定。
        registry.waitForUser(taskId, { ...outcome.question, confirmation: outcome.confirmation });
        return;
      case 'timed_out':
        registry.timeout(taskId, 'execution');
        return;
      case 'cancelled':
        if (status === 'running') registry.requestCancel(taskId); // 无请求而执行端确认取消：补齐请求事实
        registry.confirmCancelled(taskId);
        return;
    }
  }

  function cancel(taskId: string, scope?: TaskScope): CancelOutcome {
    const task = registry.get(taskId, scope);
    if (TERMINAL_STATUSES.has(task.status)) {
      return { outcome: 'terminal', taskId, status: task.status };
    }
    switch (task.status) {
      case 'queued': {
        registry.requestCancel(taskId, mutationOptions(scope));
        policy.cancelQueued(taskId);
        registry.confirmCancelled(taskId, mutationOptions(scope)); // 尚未启动执行：无中止可等，机械确认
        return { outcome: 'cancelled', taskId };
      }
      case 'waiting_user': {
        registry.requestCancel(taskId, mutationOptions(scope));
        registry.confirmCancelled(taskId, mutationOptions(scope)); // 回合已结束：无在飞执行可中止
        return { outcome: 'cancelled', taskId };
      }
      case 'running':
      case 'cancelling': {
        registry.requestCancel(taskId, mutationOptions(scope));
        controllers.get(taskId)?.abort(); // 本进程在飞才可 abort；否则只请求，不宣称取消
        return { outcome: 'requested', taskId };
      }
      default:
        // 'cancelled' 等终态已在上方拦截；此处不可达（穷尽性由类型保证）。
        return { outcome: 'terminal', taskId, status: task.status };
    }
  }

  function resume(taskId: string, options?: { answer?: string; scope?: TaskScope }): ResumeOutcome {
    const scope = options?.scope;
    const task = registry.get(taskId, scope);
    if (task.status !== 'waiting_user') {
      return { outcome: 'not_waiting', taskId, status: task.status };
    }
    const acquired = policy.acquire('background', { taskId });
    if (isRejection(acquired)) {
      return { outcome: 'rejection', taskId, reason: acquired.reason };
    }
    let resumed: TaskRecordView;
    try {
      resumed = registry.answerResumes(taskId, mutationOptions(scope));
    } catch (error) {
      policy.release(acquired);
      throw error;
    }
    startRound(resumed, acquired, options?.answer);
    return { outcome: 'started', taskId };
  }

  async function whenIdle(): Promise<void> {
    for (;;) {
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
        continue;
      }
      if (pumpQueued) {
        await Promise.resolve(); // 让已排队的再派发微任务先跑
        continue;
      }
      return;
    }
  }

  return {
    submit(input) {
      // P0-C④ 幂等：同 taskId 重复受理会静默覆盖底账行并再消耗编号（registry.begin 是
      // tasks.set 覆盖语义）——确定性拒绝重复创建，不猜「同键返回原任务」的语义。
      try {
        registry.get(input.taskId);
      } catch {
        // 不存在（越权/不存在同错）：正常受理。
        return registry.begin({
          taskId: input.taskId,
          principalId: input.principalId,
          sessionId: input.sessionId,
          request: input.request,
          status: 'queued',
        });
      }
      throw new Error(`重复受理（幂等拒绝）：任务 ${input.taskId} 已存在。`);
    },
    pump,
    whenIdle,
    cancel,
    resume,
    inFlight: () => [...inFlight.keys()],
  };
}
