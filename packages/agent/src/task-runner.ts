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
 * 长时间无动静提醒（2026-11-18，预期契约切片）：与 waiting_user 到期消费者共用**同一个**
 * 有界定时器轮（不新增第二个循环）。判据只看持久化底账：
 *   · 任务 running、从认领时刻（租约起点 = lease_until − leaseMs）起超过 `longRunningNoticeMs`
 *     （缺省 10 分钟）→ 发一条「比预计久了，停下来还是继续等」（每任务一次）；
 *   · 超过 `longRunningStuckNoticeMs`（缺省 30 分钟）→ 再发一条「卡住了，建议先停掉」
 *     （每任务一次；此后不再自动发）。
 * 每档「已发」时刻持久化在任务行（owner 列），原子领取保证并发/重启下每档至多一次。
 * 只在 1:1 会话发（chatType 事实源由装配方经 `isDirectSession` 注入；拿不到时按「私聊会话」
 * 这一条机械事实处理——不猜群聊）。发送失败只记事件，不改任务事实、不重试。未注入
 * 两档阈值或通知端口时完全不扫、零行为变化。
 * 文案只给用户可做的动作，不报进度（不写 operation 名、不写已执行次数、不写最近一步）。
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

/** waiting_user 的机械问题形状（执行层 needs_input 事实；不编造、不改写候选）。 */
export interface PendingQuestion {
  missing: readonly string[];
  candidates?: readonly string[];
  raw?: string;
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
  /**
   * 只读 **running 行**（长时间无动静提醒扫描用；可选）。缺省时回落到 `list()` 再过滤
   * （同一性能口径）。只读状态事实，不做判定。
   */
  listRunning?(): readonly TaskRecordView[];
  /**
   * 预期契约：原子领取一档提醒（'overdue' = 10 分钟档 / 'stuck' = 30 分钟档）。
   * 返回 true = 本次由本进程发出（已落库，重启不重发）；false = 该档已提醒过（零写入）。
   * 缺省 = 不启用提醒（无法持久化「已发」事实时不发——fail-closed，避免重启重复打扰）。
   */
  claimLongRunningNotice?(taskId: string, stage: 'overdue' | 'stuck', at: string): boolean;
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

/**
 * 一次执行回合的机械结局（runner 据此走底账合法边；不替执行端二次判定）：
 *   · completed  → 回合正常收尾，**执行端已按本回合执行事实确认成功**（权威）；
 *   · failed     → 已确认失败（原因原文；无执行事实可判定时的机械失败）；
 *   · needs_input→ 执行层要求补充输入（running→waiting_user，同 Task 接续）；
 *   · timed_out  → 执行回合超时（P5 边界内的执行端判定）；
 *   · cancelled  → 执行端确认已中止（abort 观察）。
 *
 * 执行端义务（端口契约；runner 不做 task 级再判定）：completed 仅当本回合确有执行且全部成功；
 * 零执行不得报 completed（如实报 failed/needs_input）；执行层拒绝/失败 → failed（原因原文）。
 * 「执行层实际成功 / 拒绝或失败 / 未发起执行」的顶层可区分性由此在执行端回合判定中成立。
 */
export type TaskExecutionOutcome =
  | { kind: 'completed'; resultText: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'needs_input'; question: PendingQuestion }
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
 * 长时间无动静提醒的用户文案（2026-11-18 owner 定；只给用户可做的动作，**不报进度**：
 * 不写 operation 名、不写已执行次数、不写最近一步）。
 */
export const LONG_RUNNING_NOTICE_TEXT =
  '这件事比预计久了。要我停下来，还是继续等？（回「停」我就停）';

/** 卡住档文案（>30 分钟仍无事件；发过一次后不再发）。 */
export const LONG_RUNNING_STUCK_NOTICE_TEXT =
  '这个我卡住了，建议先停掉；你稍后再试，或者把我们叫过来看看。';

/**
 * 主动提醒投递端口（装配方实现：走宿主既有主动投递面 `fileDelivery.sendText`）。
 * 实现方自己负责路由解析与投递纪律；异常不应抛出（抛出也只按失败事件记）。
 */
export interface LongRunningNoticePort {
  /**
   * 1:1 会话判据（chatType 事实源；缺省 = 按「私聊会话」这一条机械事实处理）。
   * false = 群聊，不发（也不落「已发」）。
   */
  isDirectSession?(sessionId: string): boolean;
  /** 投递一条提醒；返回是否真正送达（失败/抑制只记账，不重试）。 */
  sendNotice(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    stage: 'overdue' | 'stuck';
    minutes: number;
    text: string;
  }): Promise<boolean>;
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
   * 长时间无动静提醒阈值（ms；2026-11-18 预期契约）。缺省/0 = 不启用（零行为变化）；
   * 装配方传 `resolveRuntimeConfig().longRunningNoticeMs`（配置缺省 600_000 = 10 分钟）。
   * 判定只看持久化底账 + 注入时钟，不依赖上一进程的内存定时器（重启可判）。
   */
  longRunningNoticeMs?: number;
  /**
   * 卡住档提醒阈值（ms；> 本值仍无事件 → 再发一条，之后不再发）。缺省/0 = 不启用该档；
   * 装配方传 `resolveRuntimeConfig().longRunningStuckNoticeMs`（配置缺省 1_800_000 = 30 分钟）。
   */
  longRunningStuckNoticeMs?: number;
  /**
   * 提醒投递端口：缺省 = 不启用（无法投递就不打扰）。提供 `isDirectSession` 时群聊不发；
   * 未提供时按「私聊会话」这一条机械事实处理（拿不到 chatType 事实源时的唯一安全默认）。
   */
  longRunningNotice?: LongRunningNoticePort;
  /** 结构化事件出口（`task_long_running_notice`：成功/失败各一条；不含文案与业务内容）。 */
  log?: (line: Record<string, unknown>) => void;
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
  const log = options.log;
  /**
   * waiting_user 到期消费者：未配阈值（或底账无 list 面）时完全不建定时器/不扫底账，
   * 直用 runner 的调用方行为零变化。装配方注入配置值（缺省 24h）才启用。
   */
  const waitUserTimeoutMs = options.waitUserTimeoutMs ?? 0;
  const waitingScanThrottleMs = options.waitingScanThrottleMs ?? 1000;
  /**
   * 长时间无动静提醒（预期契约）：两个阈值 + 投递端口 + 可持久化的「每档已发」领取。
   * 缺任何一项都不启用（无法持久化就不发——重启不重复打扰是硬要求）。
   */
  const longRunningNoticeMs = options.longRunningNoticeMs ?? 0;
  const longRunningStuckNoticeMs = options.longRunningStuckNoticeMs ?? 0;
  const longRunningNotice = options.longRunningNotice;
  const longRunningRowsSource = registry.listRunning !== undefined ? registry.listRunning : registry.list;
  const longRunningConsumerEnabled = longRunningNoticeMs > 0
    && registry.claimLongRunningNotice !== undefined
    && longRunningNotice !== undefined
    && longRunningRowsSource !== undefined;
  const waitingConsumerEnabled = waitUserTimeoutMs > 0 && (registry.listWaiting !== undefined || registry.list !== undefined);
  /** 两个消费者共用**同一个**有界定时器轮（不新增第二个循环）。 */
  const dueConsumerEnabled = waitingConsumerEnabled || longRunningConsumerEnabled;
  let lastDueScan: { at: number; nextDue?: number } | undefined;
  const timers: RunnerTimers | undefined = dueConsumerEnabled
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
  let dueTimer: unknown;
  let dueTimerArmed = false;
  /** 在飞的提醒投递（whenIdle 收尾等待；失败只记账，不改变任务事实）。 */
  const noticeSends = new Set<Promise<void>>();

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

  function clearDueTimer(): void {
    if (!dueTimerArmed) return;
    dueTimerArmed = false;
    timers!.clear(dueTimer);
    dueTimer = undefined;
  }

  /** 重武装唯一定时器：无到期点即不建；有则只保留最早到期点。 */
  function armDueTimer(nextDue: number | undefined): void {
    if (!dueConsumerEnabled) return;
    clearDueTimer();
    if (nextDue === undefined) return;
    const delayMs = Math.min(Math.max(0, nextDue - now().getTime()), MAX_TIMER_DELAY_MS);
    dueTimer = timers!.set(() => {
      dueTimerArmed = false;
      dueTimer = undefined;
      try {
        pump();
      } catch (error) {
        // 定时器回调里的异常不能变成进程级未捕获错误（如收尾阶段底账已关闭）：
        // 只如实上报观察点，不改变任务事实（下一趟 pump 会重新判定）。
        report('due_timer_tick', error);
      }
    }, delayMs);
    dueTimerArmed = true;
  }

  interface LongRunningScan {
    noticed: string[];
    nextDue?: number;
  }

  /**
   * running 行的认领时刻（底账等价事实）：认领时写租约 `lease_until = claim + leaseMs`，
   * 因此起点 = `lease_until − leaseMs`（runner 自己的 leaseMs 口径）。无租约的 running
   * 行（inline/未认领）不参与判定——不猜开始时刻。
   */
  function runningStartedAt(task: TaskRecordView): number | undefined {
    if (task.status !== 'running' || task.leaseUntil === undefined) return undefined;
    const until = Date.parse(task.leaseUntil);
    return Number.isFinite(until) ? until - leaseMs : undefined;
  }

  /** 原子领取一档提醒（已提醒过 → false）；底账不可写时如实上报并跳过（不打扰）。 */
  function claimNotice(task: TaskRecordView, stage: 'overdue' | 'stuck', nowMs: number): boolean {
    try {
      return registry.claimLongRunningNotice!(task.taskId, stage, new Date(nowMs).toISOString());
    } catch (error) {
      report(task.taskId, error);
      return false;
    }
  }

  /** 投递一条提醒（fire-and-forget；成功/失败各记一条事件，不改任务事实、不重试）。 */
  function deliverNotice(task: TaskRecordView, stage: 'overdue' | 'stuck', minutes: number): void {
    const base = {
      taskId: task.taskId,
      principalId: task.principalId,
      sessionId: task.sessionId,
      stage,
      minutes,
    };
    const text = stage === 'stuck' ? LONG_RUNNING_STUCK_NOTICE_TEXT : LONG_RUNNING_NOTICE_TEXT;
    const send = (async (): Promise<void> => {
      try {
        const delivered = await longRunningNotice!.sendNotice({ ...base, text });
        log?.({ event: 'task_long_running_notice', ...base, result: delivered ? 'sent' : 'failed' });
      } catch (error) {
        log?.({
          event: 'task_long_running_notice',
          ...base,
          result: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    noticeSends.add(send);
    void send.finally(() => noticeSends.delete(send));
  }

  /**
   * 单趟扫描 running 行（共用同一刷新周期）：返回本次发出的任务与下一个到期点。
   * 群聊不发（也不落「已发」）；每档只发一次（原子领取持久化，重启不重发）。
   */
  function scanLongRunning(nowMs: number): LongRunningScan {
    const noticed: string[] = [];
    let nextDue: number | undefined;
    const arm = (at: number): void => {
      if (nextDue === undefined || at < nextDue) nextDue = at;
    };
    for (const task of longRunningRowsSource!()) {
      if (task.status !== 'running') continue; // 回落 list() 时过滤
      const startedAt = runningStartedAt(task);
      if (startedAt === undefined) continue;
      const elapsed = nowMs - startedAt;
      const overdueDue = startedAt + longRunningNoticeMs;
      const stuckDue = longRunningStuckNoticeMs > 0 ? startedAt + longRunningStuckNoticeMs : undefined;
      if (elapsed < longRunningNoticeMs) {
        arm(overdueDue);
        continue;
      }
      // 只在 1:1 会话发：chatType 事实源由装配方注入；拿不到时按「私聊会话」机械事实处理。
      if (!(longRunningNotice!.isDirectSession?.(task.sessionId) ?? true)) continue;
      if (stuckDue !== undefined && elapsed >= longRunningStuckNoticeMs) {
        // 卡住档：发过即止（之后不再自动发）。
        if (!claimNotice(task, 'stuck', nowMs)) continue;
        noticed.push(task.taskId);
        deliverNotice(task, 'stuck', Math.floor(elapsed / 60_000));
        continue;
      }
      if (!claimNotice(task, 'overdue', nowMs)) {
        if (stuckDue !== undefined) arm(stuckDue);
        continue;
      }
      noticed.push(task.taskId);
      deliverNotice(task, 'overdue', Math.floor(elapsed / 60_000));
      if (stuckDue !== undefined) arm(stuckDue);
    }
    return { noticed, ...(nextDue === undefined ? {} : { nextDue }) };
  }

  function pump(): PumpSummary {
    const recovered = registry.expireLeases(now().toISOString()).map((task) => task.taskId);
    let waiting: WaitingScan | undefined;
    let scanned = false;
    let nextDue: number | undefined;
    if (dueConsumerEnabled) {
      const nowMs = now().getTime();
      const due = lastDueScan?.nextDue;
      const shouldScan = lastDueScan === undefined
        || (due !== undefined && nowMs >= due)
        || nowMs - lastDueScan.at >= waitingScanThrottleMs;
      if (shouldScan) {
        scanned = true;
        if (waitingConsumerEnabled) {
          waiting = scanWaiting(nowMs);
          if (waiting.nextDue !== undefined) nextDue = waiting.nextDue;
        }
        if (longRunningConsumerEnabled) {
          const longRunning = scanLongRunning(nowMs);
          if (longRunning.nextDue !== undefined && (nextDue === undefined || longRunning.nextDue < nextDue)) {
            nextDue = longRunning.nextDue;
          }
        }
        lastDueScan = { at: nowMs, ...(nextDue === undefined ? {} : { nextDue }) };
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
    if (scanned) armDueTimer(nextDue);
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
      if (noticeSends.size > 0) {
        await Promise.allSettled([...noticeSends]);
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
