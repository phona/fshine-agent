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
 * 长时间无动静提醒（2026-11-18，预期契约切片；2026-11-19 唤醒切片改形）：与 waiting_user
 * 到期消费者共用**同一个**有界定时器轮（不新增第二个循环）。判据只看持久化底账：
 *   · 任务 running、从认领时刻（无租约的长任务用 running_since）起超过 `longRunningNoticeMs`
 *     （缺省 10 分钟）→ 交给提醒端口处置（**只此一档**，每任务一次）。
 * 「已发」时刻持久化在任务行（owner 列），原子领取保证并发/重启下至多一次。
 * **1:1 与群聊都发**（owner 2026-11-19 补 #9：群 = 独立主体，群里的任务就是这个群的事；
 * 判据只看底账任务事实，不用「群聊一律不发」的一刀切，也不碰进程内集合——重启后照样发）。
 * 发送失败只记事件、不改任务事实；**同一档内允许一次重试**（总尝试 ≤2，2026-11-19：先领取
 * 后投递的失败不再等于「这档永久不发」，见 deliverNotice——重试是投递如实修复 a70c5eeb
 * 引入的，wake 分支分叉点没见过它，不取入侧「不重试」的旧底稿）。
 * 未注入阈值或通知端口时完全不扫、零行为变化。
 *
 * 「卡住」那一档（>30 分钟「我卡住了，建议先停掉」，2026-11-18 起的第二档）**已删**（owner
 * 2026-11-19）：它断言了我们不知道的事（「我卡住了」），还替用户下结论（「建议先停掉」）；
 * 只留上面一档。
 *
 * 提醒分两层：本模块只交**时机 + 事实原料**（业务名、已跑多久；事实文本与「模型回合挂掉时
 * 的兜底一句」由端口按宿主的身份/隐私口径拼，见 {@link longRunningNoticeFactText} 与
 * {@link LONG_RUNNING_NOTICE_FALLBACK_TEXT}）；用户看到的
 * 那句话由**模型**在唤醒回合里写（端口实现负责唤醒与投递，见 server 的
 * `createLongRunningNoticePort`）。事实不报进度（不写 operation 名、不写已执行次数、不写
 * 最近一步）——我们不知道进度，就不编。
 *
 * 「断联系」档（`contact_lost` = 长任务等待与执行层断了联系、无回执；只说明没拿到回执，
 * 不代表任务失败）：文案仍由**装配方注入**（`contactLostNoticeText`，既有失败话术种类
 * `unknown_result` 的同一句话）——本模块不自己写文案（保持零仓内 import）；交付同样经提醒
 * 端口（该注入文案同时用作事实与兜底，模型说得出话时说自己的话）。
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
// 底账端口（§1 最小消费面；S1 事实模型——没有 status，只记事实）
// ---------------------------------------------------------------------------

export type TimeoutKind = 'queued' | 'execution' | 'waiting_user';

/** 写操作提案的机械形状（与 task-registry.PendingConfirmation 同形；本文件零仓内 import）。 */
export interface PendingConfirmation {
  handle: string;
  summary: string;
  expiresAt?: string;
  operation: string;
  /**
   * 提案调用的参数原文（不透明数据：宿主不解析、不改写）。确认续跑（`confirm()`）时随
   * 提案对象原样注入 TaskExecutionInput.pendingConfirmation，由执行端渲染进 Worker 委派
   * 的机械事实——续跑 Worker 是新会话，没有这份参数就只能从摘要重编（live 实测撞绑定校验）。
   * 缺省 = 旧记录（无参数可交回）。与 task-registry 同名同义，跨边界逐字透传。
   */
  args?: Record<string, unknown>;
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

/** 任务行只读投影（runner 只读这些事实字段；其余字段与本模块无关）。 */
export interface TaskRecordView {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  resultText?: string;
  /** Main 最终回复存档（后台完成经 archiveReply 同义写本字段；与 resultText 同为汇报事实）。 */
  replyText?: string;
  pendingQuestion?: PendingQuestion;
  waitingSince?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  /** 一次性机械事实（S1）：died（看门狗）/ cancelled（用户取消）/ timed_out（超时）/ resource_limited（资源拒绝）。 */
  diedAt?: string;
  cancelledAt?: string;
  timedOutAt?: string;
  resourceLimitedAt?: string;
  /** 用户取消**请求**的时刻（ISO；一次性；请求 ≠ 确认——确认才写 cancelledAt）。 */
  cancelRequestedAt?: string;
  /** 本轮开始运行时刻（ISO，单调写一次）：长任务受理后租约被清，提醒扫描靠它算「跑了多久」。 */
  runningSince?: string;
  taskNo?: number;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

/** 状态变更方法的公共选项：给出 scope 时底账先校验归属（越权与不存在同错）。 */
export interface MutationOptions {
  scope?: TaskScope;
}

/** 任务已收尾（结束事实存在）：事实不翻案的确定性拒绝。 */
export class TaskSettledError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`任务已收尾，事实不翻案：${taskId}。`);
    this.name = 'TaskSettledError';
    this.taskId = taskId;
  }
}

export interface TaskRegistryPort {
  /** 受理：缺省 inline（建行即开跑）；queued = 后台受理（submit，等 runner 认领）。 */
  begin(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    request: string;
    queued?: boolean;
  }): TaskRecordView;
  get(taskId: string, scope?: TaskScope): TaskRecordView;
  waitForUser(taskId: string, pendingQuestion: PendingQuestion, options?: MutationOptions): TaskRecordView;
  answerResumes(taskId: string, options?: MutationOptions): TaskRecordView;
  markCancelled(taskId: string, options?: MutationOptions): TaskRecordView;
  markTimedOut(taskId: string, kind: TimeoutKind, options?: MutationOptions): TaskRecordView;
  markDied(taskId: string): TaskRecordView;
  /**
   * 用户取消**请求**（2026-11-22，Grok 复审恢复）：请求 ≠ 确认——落一条持久事实
   * （cancel_requested_at，一次性），表明「用户要我停，但还没确认停下」。取消确认/断电
   * 重启后据此如实说清「你要我停、没停完」（不是已取消，也不重放）。不改任务终局、不清租约。
   */
  markCancelRequested(taskId: string, options?: MutationOptions): TaskRecordView;
  /**
   * 回合失败事实（无执行事实可判定时的机械事件）：不写任务结论，只发事实事件
   * （通知/唤醒面消费——失败通知与失败唤醒的事实源）。
   */
  noteRoundFailed(taskId: string): void;
  /**
   * 后台成功结果的逐字存档（可选；集成接线后的底账实现提供）。
   * 语义 = P2 的 `archiveReply`：回合以汇报收尾后调用，逐字写任务行（结果可找回）。
   */
  archiveReply?(taskIds: readonly string[], replyText: string): void;
  /** 原子认领最老未启动任务（写 running_since + lease）；无则 undefined。队列唯一入口。 */
  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecordView | undefined;
  /** 接续回合的在跑凭据（存活事实；可选；缺省 = 接续回合不持租约）。 */
  armLease?(taskId: string, input: { owner: string; leaseMs: number }): TaskRecordView;
  /** 过期租约 → died 事实（返回受影响任务；不自动重放）。 */
  expireLeases(now?: string): readonly TaskRecordView[];
  /**
   * 只读任务行（waiting_user 到期扫描用；可选）。缺省 = 不启用到期消费者（零行为变化）；
   * 真底账实现提供。
   */
  list?(scope?: TaskScope): readonly TaskRecordView[];
  /**
   * 只读 **等待行**（到期扫描用；可选）。缺省时回落到 `list()` 再过滤——
   * 大积压（实测 500 任务）下全表 list 每趟 pump 都分配一遍，把 RSS 顶到 10% 门槛以上；
   * 提供本方法后每趟只取等待行（通常 0 条）。
   */
  listWaiting?(): readonly TaskRecordView[];
  /**
   * 只读 **在跑行**（长时间无动静提醒扫描用；可选）。缺省时回落到 `list()` 再过滤
   * （同一性能口径）。只读事实，不做判定。
   */
  listRunning?(): readonly TaskRecordView[];
  /**
   * 预期契约：原子领取一档提醒（'overdue' = 10 分钟「久无动静」档 /
   * 'contact_lost' = 长任务等待与执行层断了联系、无回执）。
   * 返回 true = 本次由本进程发出（已落库，重启不重发）；false = 该档已提醒过（零写入）。
   * 缺省 = 不启用提醒（无法持久化「已发」事实时不发——fail-closed，避免重启重复打扰）。
   */
  claimLongRunningNotice?(taskId: string, stage: 'overdue' | 'contact_lost', at: string): boolean;
  // ---- 长任务（契约 v4；全部可选：不实现 = 不支持长任务，零行为变化） ----
  /** accepted 行（按 claimed_at 升序）：重启后重新 wait 的唯一来源。 */
  listAcceptedOperations?(): readonly AcceptedOperationRecordView[];
  /** accepted → 终态（wait 返回的原始回执；非 accepted 行不覆盖）。 */
  settleAcceptedOperation?(dispatchKey: string, outcome: unknown): void;
  /** 清租约（长任务让出并发槽；任务事实不动）。 */
  releaseTaskLease?(taskId: string): void;
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
  /**
   * 写确认透传（2026-11-19 显式确认切片）：**只在确认路径**（`runner.confirm()`）出现——
   * 用户明确表示「按这版提交」时，从底账提案取出句柄 + 摘要交给执行端；执行端把句柄随
   * 本回合的每条非只读执行原样交给执行层。`resume()`（补充/改口径）**永不**带该字段：
   * 旧提案视为作废，语义在「用户明确确认」，不在「下一条消息的默认含义」。
   */
  pendingConfirmation?: PendingConfirmation;
  /**
   * 确认路径·句柄已过期（2026-11-19 owner 口径修正）：用户确认时底账提案已过 `expiresAt`——
   * **不判失败、不结束任务**；接续一个回合让 Worker **重新生成同一提案**（内容没变就照原样
   * 再提一次，不要擅自改参数）。执行端据此渲染机械事实。与 pendingConfirmation 互斥
   *（过期即不带旧句柄）。缺省 = 非过期确认（零变化）。
   */
  confirmationExpired?: boolean;
  /**
   * 长任务续跑（契约 v4）：上一轮委派以 accepted 结束时，runner 用 wait 取回结果后
   * 在这里把受理事实与执行层原始回执交回执行端；执行端据此渲染「长任务结果」并续跑
   * 同一任务。缺省 = 首轮执行/普通接续（零变化）。
   */
  resumedOperation?: ResumedOperation;
}

/**
 * 长任务受理事实（执行端返回 accepted 时携带；runner 据此释放槽位、落账并等待）。
 * operationId 是执行层发放的不透明句柄（宿主只转交 wait/abort）；dispatchKey 是宿主
 * 自己的稳定操作身份（账行键，重启后靠它读回同一行）。
 */
export interface AcceptedOperation {
  operationId: string;
  operation: string;
  dispatchKey: string;
  /** 执行层建议的轮询间隔（缺省由 runner 配置/缺省值决定）。 */
  pollAfterMs?: number;
}

/** 续跑用：受理事实 + wait 返回的原始回执（执行端原样注入 Worker，不解释）。 */
export interface ResumedOperation extends AcceptedOperation {
  outcome: unknown;
  /**
   * 本次续跑是否跨越了宿主重启（等待项是从底账 accepted 行重建的）。
   * 续跑注记据此区分「同一进程内唤醒」与「重启后唤醒」——Worker 的上一回合上下文不在了。
   */
  restarted?: boolean;
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
 * 一次执行回合的机械结局（runner 据此落事实；S1：执行端**不产出结论**，只报回合事实）：
 *   · ended        → 回合收尾。report = Worker 的汇报原文（事实存档面）；缺省/空 = 本回合
 *     没有产出结果汇报（执行行就是事实，不判成败、不合成失败文案）。
 *   · needs_input  → 执行层要求补充输入（等待事实 + 同 Task 接续）；
 *   · needs_confirmation → 执行层冻结了一次待确认写操作（等待事实；confirmation 原样进
 *     底账 pendingQuestion.confirmation 待后续回合透传）；
 *   · timed_out    → 执行回合超时（P5 边界内的执行端判定）；
 *   · cancelled    → 执行端确认已中止（abort 观察）；
 *   · result_unknown → 结果未知（无法证明本次调用属于已有操作 / 外部无回执 / 调用中断）——
 *     不是成功也不是确认失败；账行落 unknown，禁止自动重试。
 *   · accepted     → 长任务已受理（契约 v4）：本轮工作结束——任务在跑，runner 释放槽位与
 *     租约，并落账等待（重启后按账行重新 wait）。不是失败、不是完成。
 */
export type TaskExecutionOutcome =
  /**
   * 后台回合收尾。report = Worker 汇报原文（事实）；files = 本回合 Worker 产出的**任务
   * 作用域**交付物（登记事实）；这是后台面对 TurnResult.files 的同位面：装配方按它投递。
   * zeroExecReason = 零执行的机械原因（'not_permitted' = 发起前被宿主拒绝——唤醒面据此
   * 按「本次不允许」说清；'unsupported' = 零执行且非权限拒绝——没有发生任何办理动作，
   * 唤醒面按「办不了」说清）；缺省 = 无该事实。
   *
   * executionOutcome（2026-11-22 补，如实交付红线）：本回合执行事实的**机械结局**——宿主
   * 完成/失败投递面据此分流（不能只看「有没有汇报」：Worker 在被拒/失败后也会汇报一句
   * 解释，把那种回合说成「办好了」就是虚假成功）。
   *   · 缺省 / 'success'    = 有汇报即结果（含零执行收尾）；装配方走**完成**回调；
   *   · 'failed' / 'refused' = 本回合有执行以失败/拒绝收尾；装配方走**失败**回调，
   *     且 runner 不把汇报落成完成存档（做没做成由账本执行事实说）；
   *   · 'not_permitted'      = 发起前被宿主拒绝（本次不允许）。
   * errorCode / failureReason 只在 failed/refused 时有值：执行层原始码（只用于归类，不进
   * 用户文本）与执行层失败原文（机械原因；投递面事实文案用）。
   */
  | {
    kind: 'ended';
    report?: string;
    files?: readonly TaskOutcomeFile[];
    zeroExecReason?: 'not_permitted' | 'unsupported';
    executionOutcome?: 'success' | 'failed' | 'refused' | 'not_permitted';
    errorCode?: string;
    failureReason?: string;
  }
  | { kind: 'needs_input'; question: PendingQuestion }
  /**
   * 本回合以「写操作提案待用户确认」收尾：question 是等待事实的问题形状，
   * confirmation 是执行层发放的句柄/摘要（落底账 pendingQuestion.confirmation）。
   */
  | { kind: 'needs_confirmation'; question: PendingQuestion; confirmation: PendingConfirmation }
  | { kind: 'timed_out' }
  | { kind: 'cancelled' }
  /** U3：结果未知（账行 unknown；禁止自动重试）。 */
  | { kind: 'result_unknown' }
  /**
   * 长任务已受理（契约 v4）：执行层返回 accepted，本轮工作结束——任务在跑，
   * runner 释放槽位与租约，并落账等待（重启后按账行重新 wait）。不是失败、不是完成。
   */
  | ({ kind: 'accepted' } & AcceptedOperation);

export interface TaskExecutor {
  execute(task: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome>;
}

/** 提醒事实里业务名的上限（字符；超长截断加省略号——事实给模型读，防止刷屏）。 */
const NOTICE_NAME_MAX = 30;

/**
 * 「长时间无动静」的**事实**（宿主拼，给模型读；用户看到的那句话由模型写）：
 *   `[久无动静]「<业务名>」已经跑了 N 分钟还没有结果，我这边也不知道进度。请如实告诉用户，
 *    并给他两个选择：停下来，还是继续等。`
 *
 * 只放机械事实（业务名 + 已跑多久 + 「不知道进度」）与一条交代，不报进度、不编原因。name
 * 缺省 = 主语用中性指代（不猜名）；minutes 由调用方按底账时刻机械算出。
 */
export function longRunningNoticeFactText(input: { name?: string; minutes: number }): string {
  const raw = input.name?.trim() ?? '';
  const trimmed = raw.length <= NOTICE_NAME_MAX ? raw : `${raw.slice(0, NOTICE_NAME_MAX)}…`;
  const subject = trimmed === '' ? '你交代的那件事' : `「${trimmed}」`;
  return `[久无动静]${subject}已经跑了 ${input.minutes} 分钟还没有结果，我这边也不知道进度。`
    + '请如实告诉用户，并给他两个选择：停下来，还是继续等。';
}

/**
 * 唤醒降级兜底文本：这一档**唯一允许的宿主用户文案**，只走「模型回合挂掉/说不出话」的
 * 降级路径（驱动没有可唤醒的会话 / 唤醒回合报错或空回复 / 非 live 部署不唤醒）——模型
 * 说得出话时永远不用它。
 *
 * 2026-11-19 之前它是本档的唯一文案（直接由宿主发出）；唤醒切片起改为兜底。内容不动：
 * 只给用户可做的两个动作（停下来 / 继续等），不报进度（不写 operation 名、不写已执行
 * 次数、不写最近一步），也不诱导重试。
 */
export const LONG_RUNNING_NOTICE_FALLBACK_TEXT =
  '这件事比预计久了。要我停下来，还是继续等？（回「停」我就停）';

/**
 * 单档提醒的投递尝试上限（首投 + 一次重试 = 2；到限即止，不无限重试）。
 * 「已发」领取在投递前落库，因此重试必须发生在**同一档**内（见 deliverNotice）。
 */
export const LONG_RUNNING_NOTICE_ATTEMPTS = 2;

/**
 * 主动提醒端口（装配方实现：唤醒任务所属会话的模型说话，模型挂掉则投兜底文案；见 server 的
 * `createLongRunningNoticePort`）。实现方自己负责路由解析、唤醒与投递纪律；异常不应抛出
 * （抛出与返回 false 同处理：按失败记账，同一档内由 runner 再试一次）。
 *
 * 文案归属：「久无动静」档的事实与兜底一句（模型回合挂掉）由 runner 生成（模块常量 /
 * {@link longRunningNoticeFactText}）；`contact_lost`（长任务等待与执行层断了联系、无回执）
 * 档的文案由**装配方注入**（`contactLostNoticeText`）——它是既有失败话术种类
 * `unknown_result` 的同一句话，runner 不自己写文案（保持零仓内 import），注入文案同时用作
 * 事实与兜底。
 *
 * 判据（2026-11-19 owner 补：#9 群聊覆盖 / #10 重启后判据）：**只看任务事实**——发不发由
 * 「这个任务属于谁、活在哪个会话」决定（端口收到的 taskId/principalId/sessionId 全来自
 * 底账任务行），不再有「群聊一律不发」的一刀切，也不依赖任何进程内集合（重启后照样发）。
 * 群主体的隐私口径（事实与话术不带业务名）归端口实现（宿主身份约定，见 server 的
 * `isGroupPrincipal`）。
 */
export interface LongRunningNoticePort {
  /**
   * 处置一条提醒：把 `factText` 唤醒给任务所属会话的模型、投递它说的话；模型说不出话时投
   * `fallbackText`（如实、不诱导重试）。`name`/`minutes`/`stage` 只作事实与记账
   * （含结构化事件；**群主体不带业务名**由端口裁量）。返回「用户可见的那句话已交出」
   * （模型说了 / 兜底送达）——false/抛出 = 本次没送到，同一档内由 runner 再试一次（至多两次）。
   */
  sendNotice(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    stage: 'overdue' | 'contact_lost';
    name?: string;
    minutes: number;
    factText: string;
    fallbackText: string;
  }): Promise<boolean>;
}

/**
 * 等待用户提醒端口（2026-11-21 live P0）：后台任务由非等待态进入 `waiting_user`
 * （needs_input / needs_confirmation 收尾）时触发**恰好一次**——宿主据此唤醒原会话的
 * 模型，把「还缺什么 / 待确认什么」说给用户并等表态。live 实测缺陷：进入等待此前只落
 * 底账（唯一用户面是 outbox 模板推送），模型不知道有人在等它说话，用户只能自己猜着发
 * 「按这版提交」才拿到确认摘要。
 *
 * 恰一次语义（去重 = (taskId, 进入等待次数)）：runner 只在**非等待态**回合以 needs_*
 * 收尾落等待后触发本端口——状态机禁止 waiting→waiting，回到 running 再进等待 = 新的
 * 一次收尾 = 新的一次触发；端口自身不承担重试（投递失败由宿主侧退回待注入，与完成 /
 * 失败出口同一纪律）。`question` 直读底账提交后的 pendingQuestion（事实源 = 底账），
 * **句柄（confirmation.handle）不进本端口之外的任何用户面**——用户可见文本归宿主拼装
 * （missing 列表 + summary 原文 + expiresAt；见 server 的 taskWaitingUserFactText）。
 * 实现方自己负责唤醒与投递纪律，异常不应抛出（抛出按 report 记账，不改任务事实）。
 * 缺省不接 = 零行为变化（等待只有 outbox 事实记录）。
 */
export interface WaitingUserNoticePort {
  sendNotice(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    /** 底账业务名（deriveTaskName 机械回落；缺省 = 宿主用中性指代）。 */
    name?: string;
    /** 等待事实（底账 pendingQuestion 原样）：missing 必带；confirmation 仅待确认时有。 */
    question: PendingQuestion;
  }): void | Promise<void>;
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
// 长任务等待端口（契约 v4；装配方用 ExecutionClient.wait/abort 实现）
// ---------------------------------------------------------------------------

/** wait 的机械结果（accepted = 窗口内仍在执行；其余 = 终态）。 */
export interface LongTaskWaitResult {
  status: 'accepted' | 'completed' | 'failed' | 'refused' | 'needs_input' | 'needs_confirmation';
  /** 执行层建议的下次轮询间隔（accepted 时有效）。 */
  pollAfterMs?: number;
  /** failed/refused 的机械话术（落 failureReason 用；不编造）。 */
  message?: string;
  /** 执行层原始回执（原样交给续跑回合；runner 不解释）。 */
  outcome: unknown;
}

/**
 * `failed` + `error.code = 'result_unknown'` 是**无回执**（这一次 wait 调用被传输超时截断）：
 * 它**不是**长任务失败的终态——结果未知优先于任何结论。runner 的处置（2026-11-19 owner
 * 裁定「能兜则兜、兜不住才暴露」）：
 *   · 任务保持 running、不杀任务、不唤醒 Worker 报失败（继续等结果）；
 *   · 退避重排再查一次（指数退避、封顶 60s：不撞执行层；也不会因为一次截断就放弃）；
 *   · 连续两次仍拿不到回执（自查也查不出来）才如实告知用户一次（既有失败话术种类
 *     `unknown_result` 的同一句话 + 一个动作；每任务一次，持久化领取）；
 *   · 之后任何一次 wait 取到真实回执（含 accepted/终态）即视为联系恢复，一切照常。
 */
export interface LongTaskWaitPort {
  /**
   * 长轮询 wait(operationId, timeoutMs)；窗口内未完成返回 accepted。
   * signal 中止后应尽快以 AbortError 拒绝（runner 的取消路径）。
   */
  wait(operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<LongTaskWaitResult>;
  /** 请求执行层中止；只有 aborted:true 才算确认停掉。缺省 = 不支持中止。 */
  abort?(operationId: string): Promise<{ aborted: boolean; reason?: string }>;
  /** 单次长轮询窗口（缺省 30s）。 */
  timeoutMs?: number;
  /** accepted 未给 pollAfterMs 时的重排间隔（缺省 1s）。 */
  pollAfterMs?: number;
}

/** runner 只读的 accepted 账行投影（实现方 = task-registry 的 OperationRecord）。 */
export interface AcceptedOperationRecordView {
  dispatchKey: string;
  taskId?: string;
  operation: string;
  outcome?: unknown;
}

/**
 * wait 这次调用拿到的是「无回执」吗（传输截断；outcome 形状读，同 acceptedOf 口径）：
 * 适配器以 `failed` + `code: result_unknown` 如实回「没有回执」——**不代表长任务失败**
 * （它可能还在执行层跑）。runner 据此走「先兜、兜不住才说」的等待路径，不判死。
 */
function waitNoReceiptOf(result: LongTaskWaitResult): boolean {
  if (result.status !== 'failed') return false;
  const outcome = result.outcome;
  if (outcome === null || typeof outcome !== 'object') return false;
  const error = (outcome as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 'result_unknown';
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
   * 只此一档：30 分钟「卡住」档已随 2026-11-19 唤醒切片删除（见文件头）。
   */
  longRunningNoticeMs?: number;
  /**
   * 提醒投递端口：缺省 = 不启用（无法投递就不打扰）。端口负责事实拼装（群主体去业务名）、
   * 唤醒任务所属会话与投递；runner 只判时机与「已发」（底账任务事实，不碰进程内集合）。
   */
  longRunningNotice?: LongRunningNoticePort;
  /**
   * 等待用户提醒端口（2026-11-21 live P0）：任务由非等待态进入 waiting_user 时触发恰好
   * 一次（needs_input / needs_confirmation 收尾；形状见 {@link WaitingUserNoticePort}）。
   * 缺省不接 = 零行为变化。
   */
  waitingUserNotice?: WaitingUserNoticePort;
  /**
   * 长任务等待「与执行层断了联系（无回执）」档的用户文案（装配方注入；**单一话术来源** =
   * `user-facing-failure.ts` 的 `unknown_result` 档，不在 runner 里另写一句）。缺省 = 不发
   * 这一档（无法持久化/无话术就不发——与提醒端口同一 fail-closed 口径）。
   */
  contactLostNoticeText?: string;
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
  /**
   * 长任务等待端口（契约 v4；装配方用 ExecutionClient 的 wait/abort 实现）。
   * 注入后并配合底账的 accepted 行能力：accepted 回合释放槽位后由 runner 的**同一个**
   * 有界定时器驱动 wait；完成即续跑、超窗按 pollAfterMs 重排、失败如实落终态、
   * 用户取消走 abort。缺省 = 不支持长任务（accepted 会被当作装配错误确定性失败）。
   */
  longTasks?: LongTaskWaitPort;
}

export interface SubmitInput {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
}

/** 单趟派发结果（错误面如实返回；不是通知系统）。 */
export interface PumpSummary {
  /** 本次 pump 判为 died 的过期租约任务（结果未知，禁止自动重放）。 */
  recovered: readonly string[];
  /** 本次启动执行回合的任务（认领成功）。 */
  started: readonly string[];
  /** 因许可拒绝而停止派发时的拒绝原因（任务保持未启动，等容量恢复/下次触发）。 */
  rejection?: ResourceRejectionReason;
  /**
   * 本次按 waiting_since + waitUserTimeoutMs 判为 timed_out 的任务。
   * 仅在启用到期消费者时出现（未注入 waitUserTimeoutMs 时字段整个缺省，返回形状不变）。
   */
  timedOutWaiting?: readonly string[];
}

export type CancelOutcome =
  /** 已确认取消（未启动/等待中的任务无在飞回合，机械确认）。 */
  | { outcome: 'cancelled'; taskId: string }
  /** 已请求中止（在跑：等执行端确认，确认前不得宣称已取消）。 */
  | { outcome: 'requested'; taskId: string }
  /** 已收尾的任务无操作（事实已发生，不翻案）。 */
  | { outcome: 'terminal'; taskId: string };

export type ResumeOutcome =
  | { outcome: 'started'; taskId: string }
  | { outcome: 'rejection'; taskId: string; reason: ResourceRejectionReason }
  | { outcome: 'not_waiting'; taskId: string };

/**
 * 显式确认的机械结局（2026-11-19 owner 拍板）：确认是一个**显式动作**（`task_confirm`），
 * 不是「下一条消息的默认含义」。与 ResumeOutcome 同形的三种之外：
 *   · `not_waiting`     —— 任务不在 waiting_user（无待确认提案可提交）；
 *   · `no_confirmation` —— waiting_user 但没有提案（是等补充信息，不是等确认）；
 *   · `expired`         —— 提案已过 `expiresAt`：**不判失败、不结束任务**，接续一个回合让
 *     Worker 重新生成同一提案（任务仍回 waiting_user，等用户再确认；零写执行）。业务话术
 *     （「那份提案过期了，我重新给你一份」）由调用方给出。
 * 前两种 = 确定性拒绝（零执行）；`expired` 是「重提」而非拒绝。
 */
export type ConfirmOutcome =
  | { outcome: 'started'; taskId: string }
  | { outcome: 'rejection'; taskId: string; reason: ResourceRejectionReason }
  | { outcome: 'not_waiting'; taskId: string }
  | { outcome: 'no_confirmation'; taskId: string }
  | { outcome: 'expired'; taskId: string };

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
  /**
   * 显式确认（2026-11-19 owner 拍板）：用户明确表示「按这版提交」时，从底账提案取出句柄并
   * 把任务接续下去——`userText` = 用户原话，随本回合确认路径交给执行端。**只有本方法透传
   * 待确认句柄**（`resume()` 永不透传）；提案缺失/已过期一律确定性拒绝（零执行）。
   */
  confirm(taskId: string, options?: { userText?: string; scope?: TaskScope }): ConfirmOutcome;
  /** 本进程在飞执行回合的任务 id（只读快照）。 */
  inFlight(): readonly string[];
  /**
   * 本进程内某任务**最近一次已落定回合**的机械结局（如实交付分流用；一次性读取）。
   * 受理窗口的调用方（Main 的 task_run 短等待）拿不到 executor 的返回值，只能从底账推断
   * 落定——底账不存结局（S1：没有 status），失败/被拒的机械原因（如「当前权限不支持这个
   * 操作」）与 zeroExecReason 就只剩这一处直接来源。缺省（未落定/已读/跨进程）= undefined，不猜。
   */
  roundOutcomeOf?(taskId: string): TaskExecutionOutcome | undefined;
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

/** 任务已收尾（结束事实存在；含已存档汇报——收尾后不可再取消/接续）。 */
function taskEndedOf(task: TaskRecordView): boolean {
  return task.diedAt !== undefined
    || task.cancelledAt !== undefined
    || task.timedOutAt !== undefined
    || task.resourceLimitedAt !== undefined
    || (task.resultText ?? task.replyText ?? '').trim() !== '';
}

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
   * 长时间无动静提醒（预期契约）：一个阈值 + 投递端口 + 可持久化的「已发」领取。
   * 缺任何一项都不启用（无法持久化就不发——重启不重复打扰是硬要求）。
   */
  const longRunningNoticeMs = options.longRunningNoticeMs ?? 0;
  const longRunningNotice = options.longRunningNotice;
  /** 「断联系」档的用户文案（装配注入；单一话术来源 = unknown_result 档）。 */
  const contactLostNoticeText = options.contactLostNoticeText;
  const longRunningRowsSource = registry.listRunning !== undefined ? registry.listRunning : registry.list;
  const longRunningConsumerEnabled = longRunningNoticeMs > 0
    && registry.claimLongRunningNotice !== undefined
    && longRunningNotice !== undefined
    && longRunningRowsSource !== undefined;
  const waitingConsumerEnabled = waitUserTimeoutMs > 0 && (registry.listWaiting !== undefined || registry.list !== undefined);
  /**
   * 长任务等待（契约 v4）：需要注入端口 + 底账 accepted 行能力 + 状态落定/清租约能力。
   * 缺一项 = 不支持长任务（accepted 在 settle 处按装配错误确定性失败，不留下无人推进的行）。
   */
  const longTasks = options.longTasks;
  const longTaskEnabled = longTasks !== undefined
    && registry.listAcceptedOperations !== undefined
    && registry.settleAcceptedOperation !== undefined
    && registry.releaseTaskLease !== undefined;
  const longTaskPollMs = longTasks?.pollAfterMs ?? 1_000;
  const longTaskWaitTimeoutMs = longTasks?.timeoutMs ?? 30_000;
  /**
   * wait 瞬时故障的退避上限（60s）：执行层长时间不可用时，等待项继续存在（事实不丢），
   * 但重试频率收敛到一分钟一次，不把执行层打爆。
   */
  const LONG_TASK_MAX_RETRY_DELAY_MS = 60_000;
  /** 两个消费者共用**同一个**有界定时器轮（不新增第二个循环）；长任务等待也接在这一个上。 */
  const dueConsumerEnabled = waitingConsumerEnabled || longRunningConsumerEnabled || longTasks !== undefined;
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

  /** 本进程在飞执行回合：taskId → abort 控制器 / 落定链。不是队列（队列=底账未启动行）。 */
  const controllers = new Map<string, AbortController>();
  /**
   * 已落定回合的执行结局（仅本进程；受理窗口一次读取后即删）。底账不存结论（S1），
   * 但窗口内的 Main 需要知道「刚落定的是失败/被拒还是成功」才能如实转述。
   */
  const roundOutcomes = new Map<string, TaskExecutionOutcome>();
  const ROUND_OUTCOMES_LIMIT = 64;
  const inFlight = new Map<string, Promise<void>>();
  /** 本进程已请求停止（abort）的在飞回合：确认取消的判定依据（取消请求不是底账事实）。 */
  const cancelRequested = new Set<string>();
  let pumpQueued = false;

  /**
   * 长任务等待表（dispatchKey → 等待项）。不是队列：队列仍是底账 queued 行；这里只是
   * 「本进程正在等谁」的账，条目可由 pump 从底账 accepted 行重建（重启路径）。
   */
  interface WaiterEntry {
    taskId: string;
    dispatchKey: string;
    operation: string;
    operationId: string;
    pollAfterMs: number;
    /** 下次允许发起 wait 的时刻（epoch ms；超窗重排、瞬时故障退避都写这里）。 */
    nextDue: number;
    /** 等待起点（execution_wait_resumed 的 waitedMs 口径）。 */
    startedAt: number;
    inFlight: boolean;
    /** 等待项由底账重建（上一次进程留下的 accepted 行）= 宿主重启后续等。 */
    restarted?: boolean;
    /**
     * 连续瞬时故障次数（wait 出站失败 / 子进程被杀 / 超时抛错 / 无回执的传输截断）。退避重排用：
     * 执行层宕机时按 pollAfterMs 固定重试会变成每秒打一次执行层。真实取到回执即清零。
     */
    transientFailures?: number;
    /**
     * 连续「无回执」截断次数（2026-11-19）：第一次截断先自己再查一次（兜），自查这一趟
     * 若仍拿不到回执（又一次截断，或直接出站失败）就如实告知用户一次。真实回执
     * （含 accepted/终态）即清零。
     */
    noReceiptStreak?: number;
    controller?: AbortController;
  }
  const waiters = new Map<string, WaiterEntry>();
  /**
   * 在飞的取消确认调用（whenIdle 收尾等待）。wait 本身是长轮询、可以挂很久，**不**计入
   * idle 判据——它是等待账，不是执行回合；续跑回合会写 inFlight，whenIdle 照常等它。
   */
  const cancelCalls = new Set<Promise<void>>();

  /** 回合收尾后清租约（存活事实：回合已结束的任务不再持租约；一次性事实写入也清，双保险）。 */
  function releaseLeaseQuietly(taskId: string): void {
    try {
      registry.releaseTaskLease?.(taskId);
    } catch (error) {
      report(taskId, error);
    }
  }

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
      try {
        pump();
      } catch (error) {
        // 微任务里的异常不能变成进程级未捕获错误（如收尾阶段底账已关闭）：只如实上报
        // 观察点，不改变任务事实（与 due 定时器回调同一口径）。
        report('pump_tick', error);
      }
    });
  }

  interface WaitingScan {
    timedOut: string[];
    nextDue?: number;
  }

  /** 等待行的到期时刻（waiting_since + 阈值）；非等待行/坏时间戳不参与判定。 */
  function waitingDeadlineOf(task: TaskRecordView): number | undefined {
    if (task.pendingQuestion === undefined || task.waitingSince === undefined) return undefined;
    const since = Date.parse(task.waitingSince);
    return Number.isFinite(since) ? since + waitUserTimeoutMs : undefined;
  }

  function isSettledRace(error: unknown): boolean {
    return error instanceof Error && error.name === 'TaskSettledError';
  }

  /**
   * 单趟扫描持久化底账：到期等待行走 markTimedOut('waiting_user')（一次性机械事实），
   * 返回下一个到期时刻。并发下任务已被答复/取消时吞掉事实竞争（不是本进程的目标），
   * 不推翻已发生的事实。
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
          registry.markTimedOut(task.taskId, 'waiting_user');
          timedOut.push(task.taskId);
        } catch (error) {
          if (isSettledRace(error)) continue;
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
  /**
   * running 行的开始时刻。
   *   · 首选底账的 `running_since`（单调写一次）——长任务受理后会清租约，「跑了多久」
   *     不能只从租约反推，否则最该提醒的长任务反而不在扫描里（2026-11-19 修）；
   *   · 旧行（迁移前写入、没有该列）回落到「租约到期时刻 − leaseMs」；
   *   · 两者都没有（inline/未认领）→ 不猜开始时刻，不参与判定。
   */
  function runningStartedAt(task: TaskRecordView): number | undefined {
    if (task.runningSince === undefined) return undefined;
    const since = Date.parse(task.runningSince);
    if (Number.isFinite(since)) return since;
    if (task.leaseUntil === undefined) return undefined;
    const until = Date.parse(task.leaseUntil);
    return Number.isFinite(until) ? until - leaseMs : undefined;
  }

  /** 原子领取一档提醒（已提醒过 → false）；底账不可写时如实上报并跳过（不打扰）。 */
  function claimNotice(task: TaskRecordView, stage: 'overdue' | 'contact_lost', nowMs: number): boolean {
    try {
      return registry.claimLongRunningNotice!(task.taskId, stage, new Date(nowMs).toISOString());
    } catch (error) {
      report(task.taskId, error);
      return false;
    }
  }

  /**
   * 投递一条提醒（fire-and-forget；失败**再试一次**，每次一条事件，不改任务事实）。
   *
   * 文案归属：「久无动静」档的事实与兜底一句由 runner 拼（见 {@link longRunningNoticeFactText}
   * 与 {@link LONG_RUNNING_NOTICE_FALLBACK_TEXT}，端口只负责唤醒与投递）；`contact_lost`
   * （长任务等待与执行层断了联系、无回执）档的文案由**装配方注入**（`contactLostNoticeText`）
   * ——它是既有失败话术种类 `unknown_result` 的同一句话，runner 不自己写文案（保持零仓内
   * import），注入文案同时用作事实与兜底。
   *
   * 2026-11-19（投递真相切片）：本档是**先领取后投递**（claim 落库 = 每档只发一次），旧实现
   * 在领取成功、投递失败（非 live / 路由未知 / 渠道抛错）时直接放弃——该档永久不发，用户永远
   * 等不到这条提醒（而底账上「已发」已经写下了）。修法 = 允许**一次**重试（总尝试 ≤2，与仓内
   * 「同一件事一个回合内 ≤2 次」同口径）：
   *   · 选「重试」而不是「回滚领取」：回滚后每一趟扫描都会重新领取并重发（任务跑多久就重试多久
   *     = 重试风暴），且要在底账上新增一条「反领取」写路径；重试一次即止 = 有界、无新状态、
   *     不新增表/配置键。
   *   · 上限 = 2 次尝试；到限仍失败 = 该档到此为止（不无限重试），事实只进结构化事件
   *     （result: 'failed'，每条带 attempt），告警面据此可见（见 docs/ops/alerts.md）。
   */
  function deliverNotice(
    task: TaskRecordView,
    stage: 'overdue' | 'contact_lost',
    minutes: number,
    factText: string,
    fallbackText: string,
  ): void {
    const base = {
      taskId: task.taskId,
      principalId: task.principalId,
      sessionId: task.sessionId,
      stage,
      minutes,
    };
    const send = (async (): Promise<void> => {
      // 同一档内有界重试（首投 + 1 = ≤2）：领取先于投递，投递失败不再等于「这档永久不发」。
      // 群主体的隐私口径（事实/话术不带业务名）在端口实现里裁量——runner 只交事实原料。
      for (let attempt = 1; attempt <= LONG_RUNNING_NOTICE_ATTEMPTS; attempt += 1) {
        let delivered = false;
        try {
          delivered = await longRunningNotice!.sendNotice({
            ...base,
            ...(task.name === undefined ? {} : { name: task.name }),
            factText,
            fallbackText,
          });
        } catch (error) {
          log?.({
            event: 'task_long_running_notice',
            ...base,
            result: 'failed',
            attempt,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        log?.({ event: 'task_long_running_notice', ...base, result: delivered ? 'sent' : 'failed', attempt });
        if (delivered) return;
      }
    })();
    noticeSends.add(send);
    void send.finally(() => noticeSends.delete(send));
  }

  /**
   * 长任务等待「与执行层断了联系（无回执）」的如实告知（2026-11-19 owner 裁定「能兜则兜、
   * 兜不住才暴露」）：只在连续两次无回执（第一次截断后的自查也查不出来）后发一次，
   * 文案 = 装配注入的既有 `unknown_result` 话术（不新写）；每任务一次（持久化领取，
   * 重启不重发）。缺端口/缺领取能力/缺文案 = 不发（fail-closed，与提醒端口同一口径）。
   */
  function notifyWaitContactLost(task: TaskRecordView, nowMs: number): void {
    if (longRunningNotice === undefined || contactLostNoticeText === undefined) return;
    if (registry.claimLongRunningNotice === undefined) return;
    if (!claimNotice(task, 'contact_lost', nowMs)) return;
    const startedAt = runningStartedAt(task);
    deliverNotice(
      task,
      'contact_lost',
      startedAt === undefined ? 0 : Math.max(0, Math.floor((nowMs - startedAt) / 60_000)),
      // 注入文案同时用作「喂给模型的事实」与「模型回合挂掉时的兜底」。
      contactLostNoticeText,
      contactLostNoticeText,
    );
  }

  /** 兜不住就暴露（按任务 ID 的唯一入口；只在任务仍在跑时发一次，读不到就如实上报）。 */
  function exposeContactLost(taskId: string, nowMs: number): void {
    try {
      const task = registry.get(taskId);
      if (task.runningSince === undefined || task.pendingQuestion !== undefined || taskEndedOf(task)) return;
      notifyWaitContactLost(task, nowMs);
    } catch (error) {
      report(taskId, error);
    }
  }

  /**
   * 单趟扫描 running 行（共用同一刷新周期）：返回本次发出的任务与下一个到期点。
   * **1:1 与群聊都发**（2026-11-19 owner 补 #9：群 = 独立主体，群里的任务本来就是这个群
   * 的事）；判据只看底账任务事实（任务属于谁、活在哪个会话），不引入任何进程内集合或
   * 「群聊一律不发」的一刀切（#10：重启后照样发）。话术层面的隐私口径（群主体不带业务名）
   * 归端口。每任务只发一次（原子领取持久化，重启不重发）。
   */
  function scanLongRunning(nowMs: number): LongRunningScan {
    const noticed: string[] = [];
    let nextDue: number | undefined;
    for (const task of longRunningRowsSource!()) {
      if (task.runningSince === undefined || task.pendingQuestion !== undefined || taskEndedOf(task)) {
        continue; // 回落 list() 时按在跑事实过滤
      }
      const startedAt = runningStartedAt(task);
      if (startedAt === undefined) continue;
      const elapsed = nowMs - startedAt;
      if (elapsed < longRunningNoticeMs) {
        const due = startedAt + longRunningNoticeMs;
        if (nextDue === undefined || due < nextDue) nextDue = due;
        continue;
      }
      // 群聊覆盖（owner 2026-11-19 #9）：判据只看底账任务事实，不设「群聊一律不发」，
      // 也不依赖进程内会话集合（#10：重启后照样发）；群主体隐私口径归端口。
      if (!claimNotice(task, 'overdue', nowMs)) continue;
      noticed.push(task.taskId);
      // 分钟数下限 1：阈值可被部署配到亚分钟（「已经跑了 0 分钟」是废话）。
      const minutes = Math.max(1, Math.floor(elapsed / 60_000));
      // 事实（给模型读）与兜底一句（模型回合挂掉）都由本模块拼，端口只负责唤醒与投递。
      deliverNotice(
        task,
        'overdue',
        minutes,
        longRunningNoticeFactText({
          ...(task.name === undefined ? {} : { name: task.name }),
          minutes,
        }),
        LONG_RUNNING_NOTICE_FALLBACK_TEXT,
      );
    }
    return { noticed, ...(nextDue === undefined ? {} : { nextDue }) };
  }

  /** accepted outcome 的机械读取（operationId/pollAfterMs 是执行层给的形状；坏形状跳过）。 */
  function acceptedOf(outcome: unknown): { operationId: string; pollAfterMs?: number } | undefined {
    if (outcome === null || typeof outcome !== 'object') return undefined;
    const record = outcome as { operationId?: unknown; pollAfterMs?: unknown };
    if (typeof record.operationId !== 'string' || record.operationId === '') return undefined;
    const poll = typeof record.pollAfterMs === 'number' && Number.isFinite(record.pollAfterMs) && record.pollAfterMs >= 0
      ? record.pollAfterMs
      : undefined;
    return { operationId: record.operationId, ...(poll === undefined ? {} : { pollAfterMs: poll }) };
  }

  /** 从底账重建等待表（重启路径）：accepted 行 → 本进程等待项。已收尾/进入等待的行不进入
   * （不复活已结束的事实）；同时清一次租约（进程在 settle 后、清租约前崩溃时补上，
   * 避免长任务等待期间被 expireLeases 判 died）。
   */
  function syncWaiters(nowMs: number): void {
    if (!longTaskEnabled) return;
    for (const row of registry.listAcceptedOperations!()) {
      if (row.taskId === undefined || waiters.has(row.dispatchKey)) continue;
      let task: TaskRecordView;
      try {
        task = registry.get(row.taskId);
      } catch (error) {
        report(row.taskId, error);
        continue;
      }
      if (task.pendingQuestion !== undefined || taskEndedOf(task)) continue;
      const accepted = acceptedOf(row.outcome);
      if (accepted === undefined) {
        report(row.taskId, new Error(`accepted 账行缺少 operationId（${row.dispatchKey}），无法等待。`));
        continue;
      }
      waiters.set(row.dispatchKey, {
        taskId: row.taskId,
        dispatchKey: row.dispatchKey,
        operation: row.operation,
        operationId: accepted.operationId,
        pollAfterMs: accepted.pollAfterMs ?? longTaskPollMs,
        nextDue: nowMs,
        startedAt: nowMs,
        inFlight: false,
        restarted: true,
      });
      try {
        registry.releaseTaskLease?.(row.taskId);
      } catch (error) {
        report(row.taskId, error);
      }
    }
  }

  /** 发起一轮 wait（异步、不阻塞 pump；结果经 handleWaitResult 推进）。 */
  function startWait(entry: WaiterEntry, nowMs: number): void {
    if (entry.inFlight) return;
    entry.inFlight = true;
    const controller = new AbortController();
    entry.controller = controller;
    // waitedMs 口径 = 从受理/发现开始的整段等待（entry.startedAt），不是最后一个 wait 窗口。
    const startedAt = entry.startedAt;
    const call = (async (): Promise<void> => {
      let result: LongTaskWaitResult;
      try {
        result = await longTasks!.wait(entry.operationId, longTaskWaitTimeoutMs, controller.signal);
      } catch (error) {
        // 取消（abort 路径）不算故障；其余（出站失败/子进程被杀）按瞬时故障退避重排，
        // 不把任务判死——长任务结果只能由 wait 的终态落定。退避是指数型的且封顶：
        // 执行层整体宕机时固定 pollAfterMs 会变成每秒一次出站调用（打爆执行层）。
        if (!controller.signal.aborted) {
          const live = waiters.get(entry.dispatchKey);
          if (live === entry) {
            const failures = (entry.transientFailures ?? 0) + 1;
            entry.transientFailures = failures;
            const delayMs = Math.min(entry.pollAfterMs * 2 ** Math.min(failures - 1, 16), LONG_TASK_MAX_RETRY_DELAY_MS);
            entry.nextDue = now().getTime() + delayMs;
            log?.({ event: 'execution_wait_retry', operationId: entry.operationId, failures, delayMs });
            // 前一次是「无回执」的截断、这一趟「自己再查一次」又出站失败＝联系还没恢复：
            // 与截断同一处置（兜不住才暴露一次，claim 保证每任务只发一次）。
            if ((entry.noReceiptStreak ?? 0) >= 1) exposeContactLost(entry.taskId, now().getTime());
            schedulePump();
          }
        }
        return;
      } finally {
        entry.inFlight = false;
        if (entry.controller === controller) delete entry.controller;
      }
      // 真实回执（含 accepted/终态）才算「联系恢复」：清零瞬时故障与「无回执」连续计数；
      // 无回执的传输截断不算回执（退避要能长起来，且「先兜一次」的判定要靠这个连续计数）。
      if (waitNoReceiptOf(result)) {
        entry.noReceiptStreak = (entry.noReceiptStreak ?? 0) + 1;
      } else {
        entry.transientFailures = 0;
        entry.noReceiptStreak = 0;
      }
      try {
        await handleWaitResult(entry, result, startedAt);
      } catch (error) {
        report(entry.taskId, error);
      }
    })();
    void call.catch(() => undefined);
  }

  /** wait 返回后的推进：accepted=重排；完成=续跑 Worker；失败=如实落终态。 */
  async function handleWaitResult(entry: WaiterEntry, result: LongTaskWaitResult, startedAt: number): Promise<void> {
    const nowMs = now().getTime();
    const live = waiters.get(entry.dispatchKey);
    if (live !== entry) return; // 已被取消/外部终态摘除：不再推进
    if (result.status === 'accepted') {
      log?.({ event: 'execution_wait_timeout', operationId: entry.operationId });
      entry.nextDue = nowMs + (result.pollAfterMs ?? entry.pollAfterMs);
      schedulePump();
      return;
    }
    const task = registry.get(entry.taskId);
    if (task.pendingQuestion !== undefined || taskEndedOf(task)) {
      // 已收尾/进入等待：不再推进等待项（不复活已结束的事实）。
      waiters.delete(entry.dispatchKey);
      return;
    }
    if (waitNoReceiptOf(result)) {
      // 单次 wait 被传输截断（没有回执）：**不代表长任务失败**（它可能还在执行层跑），
      // 也**不杀任务**。先兜：退避重排、继续等（下一趟就是「自己再查一次」）；
      // 连续两次仍拿不到回执（自查也查不出来）才如实暴露一次——不必把不确定性当结论播出去。
      // 退避是指数型且封顶（同出站故障车道口径），执行层整体不可达时不按秒撞。
      const failures = (entry.transientFailures ?? 0) + 1;
      entry.transientFailures = failures;
      const delayMs = Math.min(entry.pollAfterMs * 2 ** Math.min(failures - 1, 16), LONG_TASK_MAX_RETRY_DELAY_MS);
      entry.nextDue = nowMs + delayMs;
      log?.({ event: 'execution_wait_retry', operationId: entry.operationId, failures, delayMs, reason: 'no_receipt' });
      if ((entry.noReceiptStreak ?? 0) >= 2) notifyWaitContactLost(task, nowMs);
      schedulePump();
      return;
    }
    if (result.status === 'failed' || result.status === 'refused') {
      // 失败/拒绝也要唤醒 Worker（续跑注记 #3）：先取许可再落账；许可不足就保持 accepted
      // 账行（事实不丢），稍后重排。执行端会据失败事实如实说明并给出可选项。
      const acquired = policy.acquire('background', { taskId: entry.taskId });
      if (isRejection(acquired) || acquired.state === 'queued') {
        if (!isRejection(acquired)) policy.release(acquired);
        entry.nextDue = nowMs + entry.pollAfterMs;
        schedulePump();
        return;
      }
      waiters.delete(entry.dispatchKey);
      registry.settleAcceptedOperation!(entry.dispatchKey, result.outcome);
      log?.({ event: 'execution_wait_resumed', operationId: entry.operationId, waitedMs: Math.max(0, nowMs - startedAt) });
      startRound(registry.get(entry.taskId), acquired, undefined, {
        operationId: entry.operationId,
        operation: entry.operation,
        dispatchKey: entry.dispatchKey,
        pollAfterMs: entry.pollAfterMs,
        ...(entry.restarted === true ? { restarted: true } : {}),
        outcome: result.outcome,
      });
      return;
    }
    // 完成（含 needs_input/needs_confirmation）：先取许可再落账，许可不足就保持 accepted
    // 账行（结果不丢），稍后重排。
    const acquired = policy.acquire('background', { taskId: entry.taskId });
    if (isRejection(acquired) || acquired.state === 'queued') {
      if (!isRejection(acquired)) policy.release(acquired);
      entry.nextDue = nowMs + entry.pollAfterMs;
      schedulePump();
      return;
    }
    waiters.delete(entry.dispatchKey);
    registry.settleAcceptedOperation!(entry.dispatchKey, result.outcome);
    log?.({ event: 'execution_wait_resumed', operationId: entry.operationId, waitedMs: Math.max(0, nowMs - startedAt) });
    startRound(registry.get(entry.taskId), acquired, undefined, {
      operationId: entry.operationId,
      operation: entry.operation,
      dispatchKey: entry.dispatchKey,
      pollAfterMs: entry.pollAfterMs,
      ...(entry.restarted === true ? { restarted: true } : {}),
      outcome: result.outcome,
    });
  }

  /** 本任务在等的长任务（内存表优先；重启后可能还没 sync，查一次底账）。 */
  function pendingWaiterOf(taskId: string): WaiterEntry | undefined {
    for (const entry of waiters.values()) {
      if (entry.taskId === taskId) return entry;
    }
    if (!longTaskEnabled) return undefined;
    for (const row of registry.listAcceptedOperations!()) {
      if (row.taskId !== taskId) continue;
      const accepted = acceptedOf(row.outcome);
      if (accepted === undefined) continue;
      return {
        taskId,
        dispatchKey: row.dispatchKey,
        operation: row.operation,
        operationId: accepted.operationId,
        pollAfterMs: accepted.pollAfterMs ?? longTaskPollMs,
        nextDue: now().getTime(),
        startedAt: now().getTime(),
        inFlight: false,
        restarted: true,
      };
    }
    return undefined;
  }

  /** 用户取消：请求执行层 abort；确认才落 cancelled，否则回 running 并如实记失败事件。 */
  function abortPendingWait(entry: WaiterEntry): void {
    entry.controller?.abort();
    const call = (async (): Promise<void> => {
      const abortFn = longTasks?.abort;
      let aborted = false;
      let reason = '适配器不支持中止长任务。';
      if (abortFn !== undefined) {
        try {
          const result = await abortFn.call(longTasks, entry.operationId);
          aborted = result.aborted;
          if (result.reason !== undefined) reason = result.reason;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      try {
        const task = registry.get(entry.taskId);
        if (taskEndedOf(task) || task.pendingQuestion !== undefined) return;
        if (aborted) {
          waiters.delete(entry.dispatchKey);
          // 账行如实关闭（长任务没有完成；错误码是宿主侧取消事实，不冒充执行层失败）。
          registry.settleAcceptedOperation?.(entry.dispatchKey, {
            status: 'failed',
            error: { code: 'cancelled_by_user', message: '长任务已按用户请求中止。' },
          });
          registry.markCancelled(entry.taskId);
          log?.({ event: 'execution_aborted', operationId: entry.operationId, result: 'cancelled' });
          return;
        }
        log?.({ event: 'execution_aborted', operationId: entry.operationId, result: 'failed', reason });
        // 未获确认：不得宣称取消（任务事实不动，等待项重排）。
        entry.nextDue = now().getTime();
        schedulePump();
      } catch (error) {
        report(entry.taskId, error);
      }
    })();
    cancelCalls.add(call);
    void call.finally(() => cancelCalls.delete(call));
  }

  function pump(): PumpSummary {
    // 重启恢复：过期租约 → died 事实（结果未知，禁止自动重放）。取消请求只存在于本进程
    //（abort 控制器）；进程死在「请求了停、还没确认」的窗口时，租约随后过期 → died——
    // 做没做完说不清，如实按结果未知收尾（旧 cancelling 孤儿回收面已被事实模型覆盖）。
    const recovered = registry.expireLeases(now().toISOString()).map((task) => task.taskId);
    let waiting: WaitingScan | undefined;
    let nextDue: number | undefined;
    if (dueConsumerEnabled) {
      const nowMs = now().getTime();
      const due = lastDueScan?.nextDue;
      const shouldScan = lastDueScan === undefined
        || (due !== undefined && nowMs >= due)
        || nowMs - lastDueScan.at >= waitingScanThrottleMs;
      if (shouldScan) {
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
      // 长任务等待：每趟从底账补齐等待项（accepted 行通常为 0~个别条），到点发起 wait。
      if (longTasks !== undefined) {
        syncWaiters(nowMs);
        for (const entry of [...waiters.values()]) {
          if (!entry.inFlight && entry.nextDue <= nowMs) startWait(entry, nowMs);
          if (!entry.inFlight && (nextDue === undefined || entry.nextDue < nextDue)) {
            nextDue = entry.nextDue;
          }
        }
      }
    }
    const started: string[] = [];
    let rejection: ResourceRejectionReason | undefined;
    for (;;) {
      // 先取许可再认领：认领即写 running_since（已启动事实），而已启动的任务不会被二次认领——
      // 许可不足的任务必须保持未启动，不得先认领再退回。
      const acquired = policy.acquire('background');
      if (isRejection(acquired)) {
        rejection = acquired.reason;
        break;
      }
      // 排队许可（state='queued'）= 暂无槽位；后台队列是底账未启动行，不是 policy 队列——
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
    if (dueConsumerEnabled) {
      // 扫描被节流时，「本趟没有到期项」不等于「以后也不会到期」：
      //   · 本趟刚认领的任务在扫描之后才变 running（扫描时还看不到它们）；
      //   · 长任务在飞时 wait 挂起（inFlight 不算到期项），后续没有别的事件再 pump。
      // 两种情况都必须补一个扫描节拍，否则「跑到多久该提醒」永远等不到下一次扫描。
      const keepScanning = started.length > 0 || waiters.size > 0;
      const reasscan = nextDue === undefined && keepScanning && longRunningConsumerEnabled
        ? now().getTime() + waitingScanThrottleMs
        : undefined;
      armDueTimer(nextDue ?? reasscan);
    }
    return {
      recovered,
      started,
      ...(rejection === undefined ? {} : { rejection }),
      ...(waiting === undefined ? {} : { timedOutWaiting: waiting.timedOut }),
    };
  }

  function startRound(
    task: TaskRecordView,
    permit: ResourcePermit,
    answer?: string,
    resumedOperation?: ResumedOperation,
    /**
     * 写确认透传（2026-11-19 显式确认切片）：**确认路径**（`confirm()`）在 answerResumes
     * 之前取出的底账提案（waiting_user → running 会把 pendingQuestion 清掉，所以必须先取出
     * 再交给执行端）。`resume()` 永不传本参数——补充/改口径不带句柄。缺省 = 无待确认提案。
     */
    pendingConfirmation?: PendingConfirmation,
    /**
     * 确认路径·句柄已过期（2026-11-19 owner 口径修正）：与 pendingConfirmation 互斥——过期
     * 即不带旧句柄，改为让执行端渲染「重新生成同一提案」的机械事实。缺省 = 非过期确认。
     */
    confirmationExpired?: boolean,
  ): void {
    const controller = new AbortController();
    controllers.set(task.taskId, controller);
    // 接续回合的在跑凭据（存活事实）：认领路径已带租约，这里补齐接续/长任务续跑回合——
    // 否则进程中断后的接续回合无法被看门狗回收（旧登记缺口，事实模型下由租约事实覆盖）。
    if (task.leaseUntil === undefined && registry.armLease !== undefined) {
      try {
        registry.armLease(task.taskId, { owner, leaseMs });
      } catch (error) {
        if (!isSettledRace(error)) report(task.taskId, error);
      }
    }
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
      ...(resumedOperation === undefined ? {} : { resumedOperation }),
      ...(pendingConfirmation === undefined ? {} : { pendingConfirmation }),
      ...(confirmationExpired === true ? { confirmationExpired: true } : {}),
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
   * 收尾：按回合事实落底账（S1 事实模型：没有终态转换，只有机械事实写入）。
   * 结束事实（cancelled/died/timed_out/resource_limited）不翻案——回合与取消/看门狗竞争时，
   * 先落的事实留下，后到的写入被一次性语义拒绝（TaskSettledError 只上报不覆盖）。
   */
  function settle(taskId: string, result: RoundResult): void {
    if (result.kind === 'threw') {
      // 回合已结束（抛错）：先清在跑租约——否则任务行残留有效租约，存活面会一直报「running」
      // （失败/唤醒面据此误判仍在下班）。结束事实不翻案：markCancelled/markTimedOut 已清租约，
      // 这里对非 abort 分支兜底。
      releaseLeaseQuietly(taskId);
      if (isAbortError(result.error) && cancelRequested.delete(taskId)) {
        // abort 观察 + 用户确曾请求停止：确认取消（一次性事实；重复写零写入）。
        try {
          registry.markCancelled(taskId);
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        return;
      }
      // 回合失败：事实已在执行行里；这里只发回合失败事实事件（失败通知/唤醒面的事实源），
      // 不写任务结论、不合成失败文案。
      try {
        registry.noteRoundFailed(taskId);
      } catch (error) {
        if (!isSettledRace(error)) report(taskId, error);
      }
      return;
    }

    const { outcome } = result;
    // 受理窗口（Main 的短等待）拿不到 executor 返回值：把本回合机械结局留一份在进程内，
    // 由 roundOutcomeOf 一次性读取（有界；落定即覆盖，不落底账——底账不存结论，S1）。
    if (outcome.kind === 'ended') {
      roundOutcomes.delete(taskId);
      roundOutcomes.set(taskId, outcome);
      while (roundOutcomes.size > ROUND_OUTCOMES_LIMIT) {
        const oldest = roundOutcomes.keys().next().value;
        if (oldest === undefined) break;
        roundOutcomes.delete(oldest);
      }
    }
    switch (outcome.kind) {
      case 'accepted': {
        // 长任务受理（契约 v4）：回合正常结束、任务在跑；释放租约（槽位在 finally
        // 释放）后交给等待端口推进。未注入等待端口 = 装配错误：不能留下无人推进的
        // 在跑任务，记装配面缺陷事件（owner 2026-11-19 失败归宿规则第 3 档）。
        if (!longTaskEnabled) {
          log?.({ event: 'task_long_task_unsupported', taskId });
          // 无等待端口 = 装配缺陷：回合已结束，释放租约并发回合失败事实（存活面不留活行）。
          releaseLeaseQuietly(taskId);
          try {
            registry.noteRoundFailed(taskId);
            // 装配缺陷导致受理的长任务无人推进：落「结果未知」结束事实（存活面不留活行，
            // 做没做完说不清——不冒充完成，也不留 running 幽灵行）。
            registry.markDied(taskId);
          } catch (error) {
            if (!isSettledRace(error)) report(taskId, error);
          }
          return;
        }
        try {
          registry.releaseTaskLease?.(taskId);
        } catch (error) {
          report(taskId, error);
        }
        const nowMs = now().getTime();
        waiters.set(outcome.dispatchKey, {
          taskId,
          dispatchKey: outcome.dispatchKey,
          operation: outcome.operation,
          operationId: outcome.operationId,
          pollAfterMs: outcome.pollAfterMs ?? longTaskPollMs,
          nextDue: nowMs,
          startedAt: nowMs,
          inFlight: false,
        });
        schedulePump();
        return;
      }
      case 'ended': {
        // 外部事实先行（超时边界/取消确认/看门狗）：已收尾的任务不再追加事实——迟到回合的
        // 汇报不落存档（事实不翻案），并经 onError 观察点如实上报。
        try {
          const current = registry.get(taskId);
          if (taskEndedOf(current)) {
            report(taskId, new Error(`回合收尾时任务已收尾（事实不翻案）：${taskId}。`));
            return;
          }
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        // 汇报逐字存档（事实；空白结果不落——显示层不以汇报冒充）；无汇报 = 回合失败事实
        //（执行行就是事实，不判成败、不合成失败文案）。
        // S1 如实交付（2026-11-22）：本回合执行结局是 failed/refused/not_permitted 时，
        // Worker 那句汇报是**对失败的说明**，不是完成结果——不落完成存档（落下去就会让
        // 投递面把被拒/失败说成「办好了」）。做没做成由账本执行事实说。
        const reportText = (outcome.report ?? '').trim();
        const roundSucceeded = outcome.executionOutcome === undefined || outcome.executionOutcome === 'success';
        releaseLeaseQuietly(taskId);
        if (roundSucceeded && reportText !== '') {
          try {
            if (registry.archiveReply !== undefined) registry.archiveReply([taskId], outcome.report!);
            else registry.noteRoundFailed(taskId); // 无存档面 = 结果可找回机制缺失，按失败事实上报
          } catch (error) {
            if (!isSettledRace(error)) report(taskId, error);
          }
          return;
        }
        // 回合以「无汇报/失败」收尾：任务已结束——noteRoundFailed 落一条一次性机械时刻
        // （round_failed_at）。否则底账 running_since 仍在、无结束事实，`listRunning` 会把已
        // 结束的任务当「还在跑」，几秒办完的任务 10 分钟后被叫醒「已经跑了 N 分钟还没有结果」
        // （2026-11-22 Grok 复审）。**不是** died（无汇报 ≠ 结果未知；round_failed 只是「本轮
        // 已停」，不改业务失败归类、不改唤醒话术）。
        try {
          registry.noteRoundFailed(taskId);
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        return;
      }
      case 'result_unknown':
        // U3：结果未知 ≠ 成功 ≠ 确认失败（账行 unknown 已禁止自动重试）；发回合失败事实事件。
        // 2026-11-22（Grok 复审）：结果未知是 **died 语义**——必须落 died_at（一次性机械时刻），
        // 否则底账看不出「结果未知」（展示词退成「无汇报」，重启对账也认不出这条已死行）。
        releaseLeaseQuietly(taskId);
        try {
          registry.noteRoundFailed(taskId);
          registry.markDied(taskId);
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        return;
      case 'needs_input':
        try {
          registry.waitForUser(taskId, outcome.question);
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
          return;
        }
        notifyWaitingUser(taskId);
        return;
      case 'needs_confirmation':
        // 写操作提案：与 needs_input 同一等待事实（confirmation 随问题落底账，是否确认由
        // 后续回合的用户表态与执行层校验决定）。
        try {
          registry.waitForUser(taskId, { ...outcome.question, confirmation: outcome.confirmation });
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
          return;
        }
        notifyWaitingUser(taskId);
        return;
      case 'timed_out':
        try {
          registry.markTimedOut(taskId, 'execution');
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        return;
      case 'cancelled':
        // 执行端确认中止：写取消事实（一次性；未请求而确认的取消同样如实落 cancelled_at）。
        try {
          registry.markCancelled(taskId);
        } catch (error) {
          if (!isSettledRace(error)) report(taskId, error);
        }
        return;
    }
  }

  /**
   * 等待用户出口（2026-11-21 live P0）：等待落账**之后**触发一次宿主端口（fire-and-forget，
   * 不阻塞回合收尾、不占并发槽——唤醒回合的耗时与资源由宿主侧承担）。等待事实直读底账
   * 提交后的 pendingQuestion（不透传 outcome 引用：事实源 = 底账）；形状兜底 = 底账没有
   * 等待形状就不触发（不猜）。恰一次：本函数只在 needs_input / needs_confirmation 收尾
   * 落等待后各调用一次（状态机禁止 waiting→waiting；回 running 再进 = 新收尾 = 新一次）。
   */
  function notifyWaitingUser(taskId: string): void {
    const waitingUserNotice = options.waitingUserNotice;
    if (waitingUserNotice === undefined) return;
    try {
      const task = registry.get(taskId);
      const question = task.pendingQuestion;
      if (question === undefined || taskEndedOf(task)) return;
      const noticed = waitingUserNotice.sendNotice({
        taskId,
        principalId: task.principalId,
        sessionId: task.sessionId,
        ...(task.name === undefined ? {} : { name: task.name }),
        question,
      });
      if (noticed !== undefined) void Promise.resolve(noticed).catch(() => undefined);
    } catch (error) {
      report(taskId, error);
    }
  }

  function cancel(taskId: string, scope?: TaskScope): CancelOutcome {
    const task = registry.get(taskId, scope);
    if (taskEndedOf(task)) {
      return { outcome: 'terminal', taskId };
    }
    if (task.pendingQuestion !== undefined) {
      // 等待中的任务：回合已结束，无在飞执行可中止——机械确认取消。
      registry.markCancelled(taskId, mutationOptions(scope));
      return { outcome: 'cancelled', taskId };
    }
    if (task.runningSince === undefined) {
      // 未启动：尚未开始执行，无中止可等——机械确认取消。
      registry.markCancelled(taskId, mutationOptions(scope));
      policy.cancelQueued(taskId);
      return { outcome: 'cancelled', taskId };
    }
    // 在跑：请求 ≠ 取消。abort 本进程在飞回合；长任务没有在飞回合（槽位已释放），
    // 取消必须走执行层 abort；确认（回合以 cancelled 收尾/abort 成功）才写取消事实——
    // 进程死在请求与确认之间时，租约随后过期 → died（做没做完说不清，如实按结果未知）。
    // 2026-11-22（Grok 复审恢复）：请求本身落**持久事实**（cancel_requested_at）——进程/本进程
    // 内存都靠不住，重启对账要据此说清「你要我停、没停完」，不能只留进程内 Set。
    cancelRequested.add(taskId);
    try {
      registry.markCancelRequested(taskId, mutationOptions(scope));
    } catch (error) {
      // 取消请求写失败不阻断 abort（请求仍生效）；如实记观测，不吞。
      if (!isSettledRace(error)) report(taskId, error);
    }
    controllers.get(taskId)?.abort();
    const waiting = pendingWaiterOf(taskId);
    if (waiting !== undefined) {
      waiters.set(waiting.dispatchKey, waiting);
      abortPendingWait(waiting);
    }
    return { outcome: 'requested', taskId };
  }

  function resume(taskId: string, options?: { answer?: string; scope?: TaskScope }): ResumeOutcome {
    const scope = options?.scope;
    const task = registry.get(taskId, scope);
    if (task.pendingQuestion === undefined || taskEndedOf(task)) {
      return { outcome: 'not_waiting', taskId };
    }
    const acquired = policy.acquire('background', { taskId });
    if (isRejection(acquired)) {
      return { outcome: 'rejection', taskId, reason: acquired.reason };
    }
    // 语义收窄（2026-11-19）：resume = 用户补充信息 / 改口径 / 说了别的——**永不透传句柄**。
    // 旧提案随 answerResumes 清掉（作废）；Worker 重新提案是允许且期望的（新提案替换旧的）。
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

  /**
   * 显式确认（2026-11-19 owner 拍板）：用户明确表示「按这版提交」。
   *   · waiting_user + 提案存在 + 未过期 → 取句柄 → answerResumes → startRound（answer =
   *     用户原话，pendingConfirmation = 底账提案）：句柄只在确认路径透传；
   *   · waiting_user + 提案已过期 → **不判失败、不结束任务**：接续一个回合让 Worker 重新生成
   *     同一提案（confirmationExpired 事实），返回 `expired`（零写执行，任务仍回 waiting_user）；
   *   · 非 waiting_user / 无提案 → 确定性拒绝（零执行，不 acquire 许可、不接续）。
   */
  function confirm(taskId: string, options?: { userText?: string; scope?: TaskScope }): ConfirmOutcome {
    const scope = options?.scope;
    const task = registry.get(taskId, scope);
    if (task.pendingQuestion === undefined || taskEndedOf(task)) {
      return { outcome: 'not_waiting', taskId };
    }
    const confirmation = task.pendingQuestion?.confirmation;
    if (confirmation === undefined) {
      // waiting_user 但没有提案 = 在等补充信息，不是等确认。
      return { outcome: 'no_confirmation', taskId };
    }
    // 过期判定（owner 2026-11-19）：句柄过期就过期——不判失败、不结束任务，接续一个回合让
    // Worker 重新生成同一提案（带 confirmationExpired 事实、不带旧句柄），任务仍回 waiting_user。
    const expired = confirmation.expiresAt !== undefined
      && Number.isFinite(Date.parse(confirmation.expiresAt))
      && Date.parse(confirmation.expiresAt) <= now().getTime();
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
    if (expired) {
      startRound(resumed, acquired, options?.userText, undefined, undefined, true);
      return { outcome: 'expired', taskId };
    }
    startRound(resumed, acquired, options?.userText, undefined, confirmation);
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
      if (cancelCalls.size > 0) {
        await Promise.allSettled([...cancelCalls]);
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
        // 不存在（越权/不存在同错）：正常受理（后台受理 = 未启动事实，等 runner 认领）。
        return registry.begin({
          taskId: input.taskId,
          principalId: input.principalId,
          sessionId: input.sessionId,
          request: input.request,
          queued: true,
        });
      }
      throw new Error(`重复受理（幂等拒绝）：任务 ${input.taskId} 已存在。`);
    },
    pump,
    whenIdle,
    cancel,
    resume,
    confirm,
    inFlight: () => [...inFlight.keys()],
    roundOutcomeOf: (taskId) => {
      const outcome = roundOutcomes.get(taskId);
      roundOutcomes.delete(taskId);
      return outcome;
    },
  };
}
