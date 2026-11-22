/**
 * 最小任务底账的 SQLite 引擎（B 类：任务归属持久化，最小形状）。
 *
 * S1 事实模型（docs/design/task-redefinition.md，2026-11-22）：task 没有 status——
 * 表只记**机械事实**，不再存任何「结论」字段（旧 status/reason/failure_reason 三列已删）：
 *   · tasks：task_id / principal_id / session_id / request / result_text / created_at /
 *     updated_at + task_no / name / reply_text（P1）+ pending_question / waiting_since /
 *     lease_owner / lease_until（等待形状与租约）+ long_running_notified_at /
 *     wait_contact_lost_notified_at / running_since（提醒事实）+ **四个一次性机械时刻**：
 *     died_at（看门狗观察到租约过期）/ cancelled_at（用户取消确认）/ timed_out_at（机械超时）/
 *     resource_limited_at（资源拒绝）。每个时刻列至多写一次（一次性写入即并发去重）。
 *   · executions：request_id / task_id / operation / status / error_json（逐笔执行事实）。
 *   · operations：claimed→resulted 幂等账（U3，行就是身份）——存活与结果判定的事实源。
 *
 * 存活推导（registry 侧 taskLivenessOf）：等待形状 → waiting_user；有效租约 → running；
 * 租约过期或 died_at → died；其余（未启动/已收尾）→ undefined。 queued = running_since
 * IS NULL 且四个时刻列全 NULL（未启动任务可被认领）。
 *
 * 迁移口径（版本化迁移）：
 *   · 触发 = 可写打开且 tasks 表仍是旧形状（有 status 列，v4 及更早）或缺 operations 表 /
 *     executions.dispatch_key；只读打开永不迁移；
 *   · 迁移前自动备份：<dbPath>.backup-v5（不覆盖、不自动删除）；
 *   · v5 = tasks 表重建：删 status/reason/failure_reason 三列（结论不迁移——执行行 executions
 *     就是事实），加四个时刻列（NULL 起步）；旧库曾离开过 queued 的行回填 running_since
 *     （updated_at），避免迁移后被当作未启动任务重新认领；旧 cancelled/timed_out 行按
 *     updated_at 机械回填对应时刻列（该列语义 = 那次机械写入发生的时刻）；
 *   · 回填 task_no（仅缺该列时）：按 (created_at, task_id) 升序连续分配，只填 NULL 行；
 *   · U3/file_refs/inbound 面只做前向加法（不变）；
 *   · PRAGMA user_version 记录版本（新库直接建 v5）。
 *
 * file_refs（CAP-01 S0/S2）与 inbound_messages（2026-11-19）语义不变，见下方历史注释与
 * git 历史（本头注只保留现行口径，逐列说明见各表 SCHEMA_BASE 注释）。
 *
 * 数字编号（P1）：分配 = 计数器行在同一事务内 RETURNING value + INSERT；失败随事务回滚；
 * 计数器单调不减（删除/修剪后不复用、不重排）；同回合各任务行写同一最终回复。
 *
 * 事实写入（唯一写路径；本层单条语句 + WHERE 一次性条件做并发防护）：
 *   · markTaskFact：died/cancelled/timed_out/resource_limited 四个时刻列的一次性写入
 *     （WHERE 对应列 IS NULL——重复触发零写入），同时清租约（结束事实的任务不再持租约）；
 *   · setWaiting / armLease / setResultText / setReplyForTasks：等待形状、租约、报告存档；
 *   · claimNextUnstarted：BEGIN IMMEDIATE 内取最老未启动行，写 running_since + 租约
 *     （进程内/跨进程并发认领不重号）；
 *   · 其他模块禁止直接 UPDATE tasks（源码级守卫见 packages/agent/task-registry-write-path.test.ts）。
 *
 * better-sqlite3 是同步 API：本层不加 async 包装；调用方（task-registry-sqlite）本来就同步。
 * 读出的 status/error 是存储原值，由 registry 侧按领域类型收口。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 当前 schema 版本（PRAGMA user_version）。2 = P1；3 = P2a；4 = U3；5 = S1 事实模型（删结论列，加四个机械时刻列）。 */
export const TASK_STORE_SCHEMA_VERSION = 5;

/** 一次性机械事实（task 重定义 S1）：四个时刻列对应的机械事件。 */
export type TaskEndFact = 'died' | 'cancelled' | 'timed_out' | 'resource_limited';

/** 一条最小任务底账行（存储形状；领域收口在 task-registry-sqlite）。 */
export interface TaskRow {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  resultText?: string;
  /** waiting_user 的问题形状（PendingQuestion，JSON 存读；缺省=非等待）。 */
  pendingQuestion?: unknown;
  /** 进入等待的时刻（ISO）。 */
  waitingSince?: string;
  /** 后台认领租约（在跑/接续回合持有；结束事实写入时清空）。 */
  leaseOwner?: string;
  leaseUntil?: string;
  /** 看门狗观察到租约过期的时刻（ISO；一次性）。结果未知，禁止自动重放。 */
  diedAt?: string;
  /** 用户取消确认的时刻（ISO；一次性）。 */
  cancelledAt?: string;
  /** 机械超时（等待到期/回合超时/排队超时）的时刻（ISO；一次性）。 */
  timedOutAt?: string;
  /** 资源拒绝（受理/派发被 policy 拒）的时刻（ISO；一次性）。 */
  resourceLimitedAt?: string;
  /** P1：数字任务编号（SQLite 原子分配，唯一、不复用；旧库只读读出为缺省）。 */
  taskNo?: number;
  /** P1：业务名称（v1=机械回落；历史行为缺省，显示层同规则回落）。 */
  name?: string;
  /** P1：本回合 Main 最终回复全文（同回合各任务行同值；缺省=无存档）。 */
  replyText?: string;
  /**
   * 预期契约（2026-11-18）：宿主已发过对应档「长时间没动静」提醒的时刻（ISO）。
   * NULL = 尚未提醒。只用来保证同一任务每档只提醒一次（重启不重发）；不改任务状态。
   *   · longRunningNotifiedAt = 「久无动静」档（10 分钟；唤醒切片起由唤醒模型说）；
   *   · waitContactLostNotifiedAt = 长任务等待「与执行层断了联系」档（无回执的传输截断；
   *     2026-11-19）——只说明没拿到回执，**不代表长任务失败**（任务继续等）。
   * 30 分钟「卡住」档已随 2026-11-19 唤醒切片删除（long_running_stuck_notified_at 列保留
   * 仅为旧库兼容，不再读写）。
   */
  longRunningNotifiedAt?: string;
  waitContactLostNotifiedAt?: string;
  /**
   * 本轮开始运行时刻（ISO，单调写一次）：长任务受理后会清租约，「跑了多久」需要独立起点，
   * 否则最该主动汇报的长任务不在提醒扫描里（2026-11-19）。
   */
  runningSince?: string;
  createdAt: string;
  updatedAt: string;
}

/** 一条执行记录行（存储形状）。 */
export interface ExecutionRow {
  requestId: string;
  taskId: string;
  operation: string;
  /** ExecutionStatus（registry 侧取值）。 */
  status: string;
  /** ExecutionFailure，JSON 存读；未知形状原样返回给 registry。 */
  error?: unknown;
  /** U3：本次真实执行所属的稳定逻辑操作身份（历史行缺省 = 无记录，不伪造）。 */
  dispatchKey?: string;
}

/**
 * 一条逻辑操作账行（U3；存储形状）。
 * 行就是身份：dispatch_key 主键，UNIQUE(scope_key, op_seq) 是唯一约束；
 * **没有**、也不得有任何以 (operation, args) 为键的唯一约束（参数相同的两笔合法操作
 * 必须是两行）。
 */
export interface OperationRow {
  dispatchKey: string;
  /** 身份作用域：'task:<taskId>'（交办内操作）或 'turn:<sessionId>:<turnNo>'（Main task_run）。 */
  scopeKey: string;
  /** 交办内操作的 taskId；turn 作用域在受理回执落定后回填。 */
  taskId?: string;
  /** 作用域内单调递增序号（首次创建时原子分配，永不复用、不重排）。 */
  opSeq: number;
  operation: string;
  /** claimed | completed | needs_input | failed | refused | unknown。 */
  status: string;
  /** 机械原因（待核对/中断等；可空）。 */
  reason?: string;
  /** 执行层原始 outcome（JSON 存读；completed 时即「已有结果」）。 */
  outcome?: unknown;
  /** 认领时所在的运行时回合号（重放窗口判定）。 */
  attempt: number;
  claimedAt: string;
  settledAt?: string;
  /**
   * 结果落定并交给 Pi 回合的时刻（settle 时写入，与 settledAt 同刻）。
   * NULL = 尚未落定/未交付（claimed/unknown）；它不证明模型已读取。
   */
  deliveredAt?: string;
  /** 本行是哪个 dispatch_key 的重放（审计用；可空）。 */
  replayOf?: string;
}

/** 原子认领请求：**不含参数**（禁止按参数文本/哈希绑定；签名形状即结构性保证）。 */
export interface OperationClaimRequest {
  scopeKey: string;
  operation: string;
  attempt: number;
  taskId?: string;
  now: string;
}

/** 逻辑操作行的状态写入（expectedStatus = 乐观并发期望值）。 */
export interface OperationStateWrite {
  expectedStatus: string;
  status: string;
  reason?: string | null;
  outcomeJson?: string | null;
  claimedAt?: string;
  settledAt?: string | null;
  deliveredAt?: string | null;
  attempt?: number;
  taskId?: string | null;
}

/**
 * 文件解析侧（CAP-01 S2，v8 §4 作用域规则）：
 *   · `{ side: 'main' }` —— Main（run_js 输入 / task_run inputFiles 校验 / 清单）只解析
 *     task_id IS NULL 的行；
 *   · `{ side: 'worker', taskId }` —— Worker 只解析 task_id = taskId 的行（当前任务的
 *     副本与产物；跨任务/跨身份一律解析不到）。
 * 越权（principal/session/task 不符）与不存在在上层同码 FILE_REF_UNAVAILABLE。
 */
export type FileRefResolution = { side: 'main' } | { side: 'worker'; taskId: string };

/**
 * 一条文件事实行（CAP-01 S0；存储形状）。
 *
 * 9 列（S0 8 列 + S2 task_id，v8 §4）：没有 state 枚举——activated_at IS NULL 即 pending，
 * 非 NULL = 已激活（可读，同时是 TTL 起点）；不存 path——字节位置按 workspace 布局 +
 * (principal, session, file_id) 派生；name 只是用户可见名（交付时用），存储/物化文件名
 * 一律用 file_id + 自 name 派生的安全扩展名，路径不可由 name 拼出。
 * taskId 缺省 = Main 侧会话文件（task_id NULL）；交办副本/任务产物绑定所属任务。
 */
export interface FileRefRow {
  fileId: string;
  principalId: string;
  sessionId: string;
  /** 所属任务（CAP-01 S2；缺省 undefined = task_id NULL = Main 侧会话文件）。 */
  taskId?: string;
  /** 用户可见文件名（不进路径；存储/物化命名见 packages/agent/src/file-store.ts）。 */
  name: string;
  sha256: string;
  bytes: number;
  /** NULL = pending；非 NULL = 已激活（epoch ms；TTL 起点）。 */
  activatedAt?: number;
  createdAt: number;
  /**
   * 是否可交付给用户（方案 A：登记面打标，投递面按角色过滤，**不看文件名**）。
   * 缺省/undefined = true（用户产物与历史行）；宿主内部诊断产物由写侧显式传 false。
   * 读路径总是返回布尔（旧库缺列 / 旧行 NULL 按 true 读出）。
   */
  deliverable?: boolean;
}

/** 任务 + 其执行记录（读取单位）。 */
export interface StoredTask {
  task: TaskRow;
  executions: ExecutionRow[];
}

/**
 * 一条入站消息处理底账行（渠道重投幂等，B 类确定性事实；存储形状）。
 * 主键 (principalId, sessionId, messageId)：渠道 messageId 只在同一会话内有意义。
 * state='processing'（已认领，未落定）| 'done'（已完成，replyText 可回放）。
 */
export interface InboundMessageRow {
  messageId: string;
  principalId: string;
  sessionId: string;
  state: string;
  /** 最终回执（仅 state='done' 有值；回放用）。 */
  replyText?: string;
  /** 认领时刻（ISO）。 */
  claimedAt: string;
  /** 完成时刻（ISO；NULL = 尚未完成）。 */
  completedAt?: string;
}

/**
 * 入站消息认领结果：
 *   · claimed    —— 首次认领（本调用负责处理，调用方据此起回合）；
 *   · done       —— 已处理过：回放 replyText，**不产生任何新副作用**；
 *   · processing —— 已认领但未落定（上一进程挂了）：不重复执行。
 */
export type InboundClaimOutcome =
  | { outcome: 'claimed' }
  | { outcome: 'done'; replyText: string }
  | { outcome: 'processing' };

/** 一次性机械事实写入（唯一写路径之一）：fact 对应的时刻列至多写一次（重复触发零写入）。 */
export interface TaskEndFactWrite {
  fact: TaskEndFact;
  at: string;
  updatedAt: string;
}

export interface TaskStore {
  /** 插入任务并返回落库行（P1：task_no 由本语句原子分配；失败抛出，不消耗编号）。 */
  insertTask(row: TaskRow): TaskRow;
  /** 触碰 updatedAt；任务不存在返回 false（调用方按拒绝路径处理）。 */
  touchTask(taskId: string, updatedAt: string): boolean;
  /**
   * 一次性机械事实写入：died/cancelled/timed_out/resource_limited 的时刻列至多写一次
   * （WHERE 对应列 IS NULL；重复触发返回 false，零写入）。同时清租约（结束事实的任务
   * 不再持租约——存活推导不再看租约）。
   */
  markTaskFact(taskId: string, write: TaskEndFactWrite): boolean;
  /**
   * 等待形状写入（waiting_user 事实）：pendingQuestion JSON + waiting_since；给出 null =
   * 清除（答复接续）。任务已有结束事实（cancelled/died/timed_out/resource_limited）时
   * 拒绝写入（返回 false，零写入）——结束事实不翻案。
   */
  setWaiting(taskId: string, write: {
    pendingQuestion?: unknown;
    waitingSince?: string | null;
    updatedAt: string;
  }): boolean;
  /**
   * 租约写入（存活事实）：认领/接续回合的在跑凭据。running_since 首次写入后单调不变。
   */
  armLease(taskId: string, write: { owner: string; leaseUntil: string; updatedAt: string }): boolean;
  /** 清租约（长任务受理让出槽位；任务事实不动）。 */
  releaseLease(taskId: string, updatedAt: string): boolean;
  /** worker 汇报存档（resultText；不判结论——汇报原文就是事实）。 */
  setResultText(taskId: string, write: { resultText: string; updatedAt: string }): boolean;
  /**
   * 原子认领最老未启动任务（created_at, task_id 升序）：同一写事务内写 running_since + 租约；
   * 无未启动任务返回 undefined。认领条件 = running_since IS NULL 且四个时刻列全 NULL。
   */
  claimNextUnstarted(input: { owner: string; leaseUntil: string; updatedAt: string }): TaskRow | undefined;
  /**
   * 原子领取一档「长时间没动静」提醒——只有当该档时间列为 NULL 时才写入并返回 true
   * （并发/重启下同一任务每档至多一次；已提醒过返回 false，零写入）。
   * stage = 'overdue'（10 分钟「久无动静」档）| 'contact_lost'（长任务等待与执行层断了
   * 联系；只说明没拿到回执，不代表任务失败）。
   */
  claimLongRunningNotice(taskId: string, stage: 'overdue' | 'contact_lost', at: string): boolean;
  /**
   * 只读「在跑」行（长时间提醒扫描用；避免每趟 pump 全表分配）：
   * running_since 非空、无等待形状、四个时刻列全 NULL（含长任务等待回执的行）。
   */
  listRunningTasks(): TaskRow[];
  /** 租约已过期（lease_until 非空且 <= now）且未写 died 的任务行（看门狗扫描）。 */
  listRunningExpiredLeases(now: string): TaskRow[];
  /**
   * P1：把同一回合的最终回复写入各任务行（同值、单事务）。
   * 不存在的 taskId 不写（调用方保证 id 来自本回合 begin）。
   */
  setReplyForTasks(taskIds: readonly string[], replyText: string, updatedAt: string): void;
  /** 追加一条执行记录；任务不存在返回 false（不写孤儿行）。 */
  insertExecution(row: ExecutionRow): boolean;
  getTask(taskId: string): StoredTask | undefined;
  /** scope 缺省 = 全部任务；给出时按 principal + session 过滤。 */
  listTasks(scope?: { principalId: string; sessionId: string }): StoredTask[];
  /** 只读等待行（waiting_user 事实：pending_question 非空且无结束事实）；scope 过滤走索引。 */
  listWaitingRows(scope?: { principalId: string; sessionId: string }): StoredTask[];
  /**
   * U3：读重放窗口候选行（同 scope / 同 operation / 同 attempt，按 op_seq 升序）。
   * 判定由 registry 的纯函数做；本方法只读。
   */
  listOperationCandidates(input: { scopeKey: string; operation: string; attempt: number }): OperationRow[];
  /**
   * 长任务（契约 v4）：按状态列出逻辑操作行（accepted = 执行层已受理、等待宿主 wait）。
   * 只读；claimed_at 升序。旧库无 operations 表时返回空（不崩溃、不伪造）。
   */
  listOperationsByStatus(status: string): OperationRow[];
  /** U3：按身份键读回一行（重试/重放只读回，不重铸）。 */
  getOperation(dispatchKey: string): OperationRow | undefined;
  /**
   * U3：原子铸造一笔新逻辑操作（op_seq = scope 内 MAX+1 与 INSERT 同一 BEGIN IMMEDIATE
   * 写事务；主键 + UNIQUE(scope_key, op_seq) 兜底并发）。唯一铸造点。
   */
  mintOperation(input: OperationClaimRequest): OperationRow;
  /**
   * U3：把已有行重新置 claimed（**同一 dispatchKey**，只用于读操作的可安全重试或
   * 幂等重入；写操作不得走这里——不重铸、不改变身份）。
   */
  reclaimOperation(dispatchKey: string, input: { attempt: number; now: string; taskId?: string }): OperationRow | undefined;
  /** U3：单语句状态写入（expectedStatus 不匹配返回 false，零写入）。 */
  applyOperationState(dispatchKey: string, write: OperationStateWrite): boolean;
  /** U3：把「读候选 + 决策 + 写」包进同一 BEGIN IMMEDIATE 写事务。 */
  transaction<T>(fn: () => T): T;
  /** CAP-01 S0：插入一条文件事实行（无 DB 生成列；file_id 冲突由主键抛出）。 */
  insertFileRef(row: FileRefRow): FileRefRow;
  /**
   * CAP-01 S0/S2：按解析侧读一行文件事实。越权（principal/session/task 不符）与不存在
   * 同为 undefined（防存在性 oracle；机械原因只进日志，见 v8 §4）。
   * Main 侧只解析 task_id IS NULL；Worker 侧只解析 task_id = 指定任务（v8 §4 作用域规则）。
   */
  getFileRef(
    fileId: string,
    scope: { principalId: string; sessionId: string },
    resolution: FileRefResolution,
  ): FileRefRow | undefined;
  /** CAP-01 S0：按 scope 列出（created_at, file_id 升序；量 = 会话文件数，不做分页）。 */
  listFileRefs(scope: { principalId: string; sessionId: string }): FileRefRow[];
  /**
   * 保留期字节回收：列出全部作用域的文件事实行（created_at, file_id 升序；只读扫描，
   * 不删行）。ops 入口按行派生字节路径；行本身保留做审计。
   */
  listAllFileRefs(): FileRefRow[];
  /**
   * 入站内容去重（2026-11-18 owner）：把一行 Main 侧（task_id IS NULL）文件事实的
   * name 与 activated_at 更新为本次值（复用既有 file_id；sha256/bytes 不动）。身份键固定
   * 为 (file_id, principal_id, session_id) 且只命中 Main 侧行——跨作用域/任务副本不可能
   * 被改写。返回是否命中一行。
   *
   * pending→pending 复用（2026-11-18 owner，F-1）：`activatedAt: null` 保持该行 pending
   * （复用不得替用户激活）；给出 `createdAt` 时同时把 created_at 刷新为本次收到时刻，
   * pending 激活窗口（created_at → 被文字消息激活）因此重新计时，与回收器
   * `file-ref-cleanup.ts` 的 pending 过期口径（now − created_at > TTL）保持一致。
   */
  updateFileRef(input: {
    fileId: string;
    principalId: string;
    sessionId: string;
    name: string;
    /** null = 保持 pending（不激活）；number = 激活/刷新激活时刻。 */
    activatedAt: number | null;
    /** 给出时刷新 created_at（pending 窗口重新计时）；缺省 = 不动。 */
    createdAt?: number;
  }): boolean;
  /**
   * CAP-01 S1：激活 scope 内 TTL 窗口（created_at >= createdAfter）的全部 pending 行
   * （activated_at IS NULL → 置 = activatedAt）；返回激活行数。已激活行与窗口外（过期）
   * pending 不动——过期 pending 保持 pending（孤儿清理归后续 TTL 清扫，本层不删）。
   */
  activatePendingFileRefs(
    scope: { principalId: string; sessionId: string },
    input: { activatedAt: number; createdAfter: number },
  ): number;
  /**
   * 入站消息幂等认领（渠道重投，2026-11-19）：同 (principalId, sessionId, messageId) 原子
   * 首次写入 state='processing' 并返回 claimed；已存在且 state='done' → 回放 replyText；
   * 已存在且 state='processing' → 上一进程未落定（不重复执行）。纯新增表；旧库只读缺表时抛错。
   */
  claimInboundMessage(input: {
    messageId: string;
    principalId: string;
    sessionId: string;
    claimedAt: string;
  }): InboundClaimOutcome;
  /** 入站消息处理完成：置 state='done' + 最终回执；命中一行返回 true。 */
  completeInboundMessage(input: {
    messageId: string;
    principalId: string;
    sessionId: string;
    replyText: string;
    completedAt: string;
  }): boolean;
  /** 入站消息处理失败：删除认领行（失败不缓存，渠道可重投）；命中一行返回 true。 */
  releaseInboundMessage(input: {
    messageId: string;
    principalId: string;
    sessionId: string;
  }): boolean;
  /** 入站消息只读一行（旧库只读缺表时返回 undefined，不崩溃）。 */
  getInboundMessage(input: {
    messageId: string;
    principalId: string;
    sessionId: string;
  }): InboundMessageRow | undefined;
  /**
   * 入站消息启动清扫：删除 claimed_at/completed_at 早于保留期的行（保留期由调用方按
   * 部署事实派生）。返回删除行数；旧库只读缺表时返回 0。
   */
  cleanupInboundMessages(before: string): number;
  close(): void;
}

/** 当前版本的表与索引（新建库直接落 v5；旧库先重建 tasks、再补建缺的表）。 */
const SCHEMA_BASE = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  result_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_no INTEGER,
  name TEXT,
  reply_text TEXT,
  -- waiting_user 事实（PendingQuestion JSON：missing[]/candidates?/raw? + ISO 时刻）。
  pending_question TEXT,
  waiting_since TEXT,
  -- 存活事实：租约（在跑/接续回合持有；结束事实写入时清空）。
  lease_owner TEXT,
  lease_until TEXT,
  -- 四个一次性机械时刻（S1 事实模型；NULL = 未发生；至多写一次）。
  -- died_at：看门狗观察到租约过期（结果未知，禁止自动重放）。
  died_at TEXT,
  -- cancelled_at：用户取消确认。
  cancelled_at TEXT,
  -- timed_out_at：机械超时（等待到期/回合超时/排队超时）。
  timed_out_at TEXT,
  -- resource_limited_at：资源拒绝（受理/派发被 policy 拒）。
  resource_limited_at TEXT,
  -- 已发过「久无动静」提醒的时刻（ISO，NULL = 未提醒；每档至多一次）。
  long_running_notified_at TEXT,
  -- 「这一轮开始跑」的时刻（ISO，单调写一次；NULL = 未跑过=可认领）。
  running_since TEXT,
  -- 长任务等待「与执行层断了联系（无回执）」已告知过用户的时刻（ISO，NULL = 未告知）。
  wait_contact_lost_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks (principal_id, session_id);
CREATE TABLE IF NOT EXISTS task_sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT,
  dispatch_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions (task_id);
CREATE TABLE IF NOT EXISTS operations (
  dispatch_key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  task_id TEXT,
  op_seq INTEGER NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  outcome_json TEXT,
  attempt INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  delivered_at TEXT,
  replay_of TEXT,
  UNIQUE (scope_key, op_seq)
);
CREATE INDEX IF NOT EXISTS idx_operations_scope ON operations (scope_key, attempt, operation);
CREATE TABLE IF NOT EXISTS file_refs (
  file_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  task_id TEXT,
  -- 方案 A（2026-11-18）：登记面角色标记；缺省 1 = 可交付（历史行与用户产物），
  -- 宿主内部诊断产物显式写 0。纯前向加法列，不升 user_version。
  deliverable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_file_refs_scope ON file_refs (principal_id, session_id);
CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id TEXT,
  principal_id TEXT,
  session_id TEXT,
  state TEXT,
  reply_text TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  -- 渠道 messageId 只在同一会话内有意义：主键带 principal + session，跨会话同名不互相吞。
  PRIMARY KEY (principal_id, session_id, message_id)
);
`;

/** 数字编号唯一索引：部分索引允许历史/缺省行多个 NULL，但已分配编号必须唯一。 */
const SCHEMA_TASK_NO_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_no ON tasks (task_no) WHERE task_no IS NOT NULL';

/** v5 tasks 表的列清单（迁移重建时按列存在性取源值；新库直接按此形状建）。 */
const TASKS_V5_COLUMNS: readonly string[] = [
  'task_id', 'principal_id', 'session_id', 'request', 'result_text', 'created_at', 'updated_at',
  'task_no', 'name', 'reply_text', 'pending_question', 'waiting_since', 'lease_owner', 'lease_until',
  'died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at',
  'long_running_notified_at', 'running_since', 'wait_contact_lost_notified_at',
];

interface TaskDbRow {
  task_id: string;
  principal_id: string;
  session_id: string;
  request: string;
  result_text: string | null;
  task_no?: number | null;
  name?: string | null;
  reply_text?: string | null;
  pending_question?: string | null;
  waiting_since?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
  died_at?: string | null;
  cancelled_at?: string | null;
  timed_out_at?: string | null;
  resource_limited_at?: string | null;
  long_running_notified_at?: string | null;
  wait_contact_lost_notified_at?: string | null;
  running_since?: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionDbRow {
  request_id: string;
  task_id: string;
  operation: string;
  status: string;
  error_json: string | null;
  dispatch_key?: string | null;
}

interface OperationDbRow {
  dispatch_key: string;
  scope_key: string;
  task_id: string | null;
  op_seq: number;
  operation: string;
  status: string;
  reason: string | null;
  outcome_json: string | null;
  attempt: number;
  claimed_at: string;
  settled_at: string | null;
  delivered_at: string | null;
  replay_of: string | null;
}

interface FileRefDbRow {
  file_id: string;
  principal_id: string;
  session_id: string;
  name: string;
  sha256: string;
  bytes: number;
  activated_at: number | null;
  created_at: number;
  task_id?: string | null;
  /** 旧库缺列 / 旧行缺省时为 undefined（按 true 读出）。 */
  deliverable?: number | null;
}

interface InboundMessageDbRow {
  message_id: string;
  principal_id: string;
  session_id: string;
  state: string;
  reply_text: string | null;
  claimed_at: string;
  completed_at: string | null;
}

/**
 * 身份键 = scope + 作用域内序号（持久化字段的纯函数）：重建出来的字符串与铸造时
 * 按构造相等，消除「恢复后是不是又掷了一个新身份」的歧义。序号只在首次铸造时分配一次。
 */
export function operationKeyOf(scopeKey: string, opSeq: number): string {
  return `dk_${scopeKey}:${opSeq}`;
}

/** 打开选项（P1 任务查看）：readOnly 只读打开既有库，不写任何字节、不做任何迁移。 */
export interface OpenTaskStoreOptions {
  /**
   * true = 只读视图：不建目录、不设 pragma、不执行建表/迁移；库文件必须已存在
   * （fileMustExist）。写方法仍在但由 SQLite 拒绝（SQLITE_READONLY）。
   */
  readOnly?: boolean;
}

/** 表列名集合：表不存在 = 空集。 */
function tableColumnsOf(db: Database.Database, table: string): Set<string> {
  const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(info.map((column) => column.name));
}

/** 旧库迁移标记的读取：tasks 表不存在 = 全新库（直接建 v5）。 */
function taskTableColumns(db: Database.Database): Set<string> {
  return tableColumnsOf(db, 'tasks');
}

/** v5 迁移谓词：tasks 表已存在且仍带旧结论列（status）——需要重建为事实形状。 */
function tasksTableNeedsRebuild(db: Database.Database): boolean {
  const columns = taskTableColumns(db);
  return columns.size > 0 && columns.has('status');
}

/**
 * v5 tasks 表重建：旧表（v4 及更早）→ 新事实形状。结论列（status/reason/failure_reason）
 * 不迁移（结论不是事实；逐笔执行事实在 executions 里）；机械时刻按旧库可用信息回填：
 *   · cancelled/timed_out：旧 status 即机械事实，updated_at = 那次写入的时刻；
 *   · died：旧 failed+result_unknown 的租约过期语义不回填（执行行与 running_since 足够）；
 *   · 曾离开过 queued 的行回填 running_since（updated_at）——避免迁移后被当作未启动重新认领。
 * 逐列按旧表实际列存在性取源（极旧库缺列取 NULL），历史行其余事实原样搬运。
 */
function rebuildTasksTableToV5(db: Database.Database): void {
  const oldColumns = taskTableColumns(db);
  const sourceOf = (column: string): string =>
    oldColumns.has(column) ? `"${column}"` : 'NULL';
  const columnList = TASKS_V5_COLUMNS.map((column) => `"${column}"`).join(', ');
  const selectList = TASKS_V5_COLUMNS.map((column) => {
    if (column === 'cancelled_at') {
      // 旧 cancelled 行：更新时刻即用户取消确认的时刻（机械事实）。
      return oldColumns.has('status')
        ? `CASE WHEN "status" = 'cancelled' THEN "updated_at" ELSE NULL END AS "cancelled_at"`
        : 'NULL AS "cancelled_at"';
    }
    if (column === 'timed_out_at') {
      return oldColumns.has('status')
        ? `CASE WHEN "status" = 'timed_out' THEN "updated_at" ELSE NULL END AS "timed_out_at"`
        : 'NULL AS "timed_out_at"';
    }
    if (column === 'running_since') {
      // 曾离开 queued 的旧行（任何非 queued 终局/等待/取消）不再可被认领：回填 updated_at。
      // 极旧库（v2/v3）没有 running_since 列：sourceOf 按列存在性取源（NULL 兜底）。
      return oldColumns.has('status')
        ? `CASE WHEN "status" = 'queued' THEN ${sourceOf('running_since')} ELSE COALESCE(${sourceOf('running_since')}, "updated_at") END AS "running_since"`
        : `COALESCE(${sourceOf('running_since')}, "updated_at") AS "running_since"`;
    }
    return `${sourceOf(column)} AS "${column}"`;
  }).join(', ');
  // 重建期间关外键（executions REFERENCES tasks(task_id)；DROP tasks 需要临时解除），
  // 结束后恢复——迁移事务内数据完整性由同库迁移语义保证。
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE tasks_v5 (${TASKS_V5_COLUMNS.map((column) =>
      `"${column}" ${TASKS_V5_BUILD_COLUMN_SHAPES[column]}`).join(', ')});
    INSERT INTO tasks_v5 (${columnList}) SELECT ${selectList} FROM "tasks";
    DROP TABLE "tasks";
    ALTER TABLE tasks_v5 RENAME TO "tasks";
  `);
  db.pragma('foreign_keys = ON');
}

/** v5 tasks 表的列形状（重建用；与 SCHEMA_BASE 的 tasks 定义一致）。 */
const TASKS_V5_BUILD_COLUMN_SHAPES: Readonly<Record<string, string>> = {
  task_id: 'TEXT PRIMARY KEY',
  principal_id: 'TEXT NOT NULL',
  session_id: 'TEXT NOT NULL',
  request: 'TEXT NOT NULL',
  result_text: 'TEXT',
  created_at: 'TEXT NOT NULL',
  updated_at: 'TEXT NOT NULL',
  task_no: 'INTEGER',
  name: 'TEXT',
  reply_text: 'TEXT',
  pending_question: 'TEXT',
  waiting_since: 'TEXT',
  lease_owner: 'TEXT',
  lease_until: 'TEXT',
  died_at: 'TEXT',
  cancelled_at: 'TEXT',
  timed_out_at: 'TEXT',
  resource_limited_at: 'TEXT',
  long_running_notified_at: 'TEXT',
  running_since: 'TEXT',
  wait_contact_lost_notified_at: 'TEXT',
};

/** U3 加法迁移是否需要执行：operations 表缺失，或 executions 缺 dispatch_key 列。 */
function operationSchemaMissing(db: Database.Database): boolean {
  const hasOperations = tableColumnsOf(db, 'operations').size > 0;
  const executionColumns = tableColumnsOf(db, 'executions');
  // executions 表不存在（极旧库）= 由 SCHEMA_BASE 直接按新形状建，不需要 ALTER。
  const missingDispatchColumn = executionColumns.size > 0 && !executionColumns.has('dispatch_key');
  return !hasOperations || missingDispatchColumn;
}

/**
 * CAP-01 S2 加法迁移谓词：file_refs 表已存在但缺 task_id 列（S0/S1 时代的旧库）。
 * 表不存在 = 由 SCHEMA_BASE 直接按新形状建，不需要 ALTER。纯前向加法（TEXT NULL），
 * 不升 user_version；与 tasks 列迁移共用同一次 v4 备份（已有备份保留最早副本）。
 */
function fileRefTaskColumnMissing(db: Database.Database): boolean {
  const fileRefColumns = tableColumnsOf(db, 'file_refs');
  return fileRefColumns.size > 0 && !fileRefColumns.has('task_id');
}

/**
 * 方案 A 加法迁移谓词：file_refs 表已存在但缺 deliverable 列（角色标记上线前的旧库）。
 * 与 task_id 同一种前向加法：ADD COLUMN ... NOT NULL DEFAULT 1——旧行按 1（可交付）读出，
 * 不升 user_version。
 */
function fileRefDeliverableColumnMissing(db: Database.Database): boolean {
  const fileRefColumns = tableColumnsOf(db, 'file_refs');
  return fileRefColumns.size > 0 && !fileRefColumns.has('deliverable');
}

/**
 * 迁移前自动备份（只做一次，不覆盖）：先 checkpoint 把 WAL 合入主文件，再整文件复制。
 * 命名 = <dbPath>.backup-v<迁移目标版本>（当前 v3）；`:memory:` 与库文件不存在不生成；
 * 已有同名备份时保留最早副本。
 */
function backupBeforeMigration(db: Database.Database, dbPath: string): void {
  if (dbPath === ':memory:') return;
  const backupPath = `${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`;
  if (existsSync(backupPath)) return;
  db.pragma('wal_checkpoint(FULL)');
  copyFileSync(dbPath, backupPath);
}

export function openTaskStore(dbPath: string, options: OpenTaskStoreOptions = {}): TaskStore {
  const readOnly = options.readOnly === true;
  const db = readOnly
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : (() => {
        if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
        const writable = new Database(dbPath);
        writable.pragma('journal_mode = WAL');
        writable.pragma('foreign_keys = ON');

        const columns = taskTableColumns(writable);
        const tableExists = columns.size > 0;
        const operationsMissing = tableExists && operationSchemaMissing(writable);
        // CAP-01 S2：旧 file_refs（有表无 task_id 列）→ ADD COLUMN（前向加法，不升版本）。
        const fileRefTaskMissing = tableExists && fileRefTaskColumnMissing(writable);
        const fileRefDeliverableMissing = tableExists && fileRefDeliverableColumnMissing(writable);
        // S1（v5）：旧形状 tasks（带 status 结论列）→ 重建为事实形状。
        const needsV5Rebuild = tasksTableNeedsRebuild(writable);
        if (needsV5Rebuild || operationsMissing || fileRefTaskMissing || fileRefDeliverableMissing) {
          // 旧库迁移：先备份（目标版本命名），再重建/加列，再（仅缺 task_no 时）回填编号，
          // 最后建唯一索引与版本号。共用同一次备份（同一目标版本 v5；已有备份保留最早副本）。
          backupBeforeMigration(writable, dbPath);
          if (needsV5Rebuild) rebuildTasksTableToV5(writable);
          const executionColumns = tableColumnsOf(writable, 'executions');
          if (executionColumns.size > 0 && !executionColumns.has('dispatch_key')) {
            writable.exec('ALTER TABLE executions ADD COLUMN dispatch_key TEXT');
          }
          if (fileRefTaskMissing) writable.exec('ALTER TABLE file_refs ADD COLUMN task_id TEXT');
          if (fileRefDeliverableMissing) {
            writable.exec('ALTER TABLE file_refs ADD COLUMN deliverable INTEGER NOT NULL DEFAULT 1');
          }
        }
        writable.exec(SCHEMA_BASE);
        if (needsV5Rebuild && !columns.has('task_no')) {
          // 单条 SQL 回填：历史行按 (created_at, task_id) 升序从当前最大值之后连续分配
          //（仅极旧库缺 task_no 列时；重建已按源列搬运编号）。
          writable.prepare(`
            UPDATE tasks SET task_no = @base + (
              SELECT rn FROM (
                SELECT task_id, ROW_NUMBER() OVER (ORDER BY created_at, task_id) AS rn
                FROM tasks WHERE task_no IS NULL
              ) AS ordered WHERE ordered.task_id = tasks.task_id
            ) WHERE task_no IS NULL
          `).run({ base: (writable.prepare('SELECT COALESCE(MAX(task_no), 0) AS base FROM tasks').get() as { base: number }).base });
        }
        // 编号计数器：单调不减（MAX(现值, 历史最大编号)）——迁移/重开都不会回收编号。
        writable.prepare(`
          INSERT INTO task_sequences (name, value)
          VALUES ('task_no', (SELECT COALESCE(MAX(task_no), 0) FROM tasks))
          ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)
        `).run();
        writable.exec(SCHEMA_TASK_NO_INDEX);
        const currentVersion = writable.pragma('user_version', { simple: true }) as number;
        if (currentVersion < TASK_STORE_SCHEMA_VERSION) {
          writable.pragma(`user_version = ${TASK_STORE_SCHEMA_VERSION}`);
        }
        return writable;
      })();

  // 语句面：旧库只读（未迁移）时缺列/缺表，含新列的语句不 prepare
  // （否则 PRAGMA 阶段即报 no such column/table）；对应写方法给确定性拒绝。
  const columns = taskTableColumns(db);
  const hasTaskNoColumn = columns.has('task_no');
  const hasReplyColumn = columns.has('reply_text');
  const hasFactColumns = columns.has('pending_question')
    && columns.has('waiting_since')
    && columns.has('lease_owner')
    && columns.has('lease_until')
    && columns.has('died_at')
    && columns.has('cancelled_at')
    && columns.has('timed_out_at')
    && columns.has('resource_limited_at')
    && columns.has('running_since');
  const allocateTaskNo = hasTaskNoColumn
    ? db.prepare("UPDATE task_sequences SET value = value + 1 WHERE name = 'task_no' RETURNING value")
    : undefined;
  // 插入语句含 running_since 列——只在两列都存在（已迁移）的库上 prepare；
  // 旧形状只读打开时保持 undefined（写入给确定性拒绝，prepare 不崩）。
  const insertTaskStmt = hasTaskNoColumn && hasFactColumns
    ? db.prepare(`
        INSERT INTO tasks (
          task_id, principal_id, session_id, request, result_text, created_at, updated_at,
          task_no, name, reply_text, running_since
        )
        VALUES (
          @taskId, @principalId, @sessionId, @request, @resultText, @createdAt, @updatedAt,
          @taskNo, @name, @replyText, @runningSince
        )
      `)
    : undefined;
  /** 分配 + 插入同一事务：失败（如 taskId 冲突）回滚计数器（失败不占号）。 */
  const insertTaskTx = (() => {
    if (allocateTaskNo === undefined || insertTaskStmt === undefined) return undefined;
    const allocate = allocateTaskNo;
    const insert = insertTaskStmt;
    return db.transaction((bound: {
      taskId: string;
      principalId: string;
      sessionId: string;
      request: string;
      resultText: string | null;
      createdAt: string;
      updatedAt: string;
      name: string | null;
      replyText: string | null;
      runningSince: string | null;
    }) => {
      const allocated = allocate.get() as { value: number };
      insert.run({ ...bound, taskNo: allocated.value });
    });
  })();
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?');
  const touch = db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?');
  // 事实写入语句族（唯一写路径；源码级守卫按此判据守住「单写路径」）。
  // 一次性机械事实：WHERE 对应时刻列 IS NULL——重复触发零写入；写入同时清租约。
  const markDiedStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET died_at = @at, lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId AND died_at IS NULL
      `)
    : undefined;
  const markCancelledStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET cancelled_at = @at, lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId AND cancelled_at IS NULL
      `)
    : undefined;
  const markTimedOutStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET timed_out_at = @at, lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId AND timed_out_at IS NULL
      `)
    : undefined;
  const markResourceLimitedStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET resource_limited_at = @at, lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId AND resource_limited_at IS NULL
      `)
    : undefined;
  const setWaitingStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET pending_question = @pendingQuestionJson,
            waiting_since = @waitingSince,
            updated_at = @updatedAt
        WHERE task_id = @taskId AND cancelled_at IS NULL AND died_at IS NULL
          AND timed_out_at IS NULL AND resource_limited_at IS NULL
      `)
    : undefined;
  const armLeaseStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks
        SET lease_owner = @owner,
            lease_until = @leaseUntil,
            running_since = COALESCE(running_since, @updatedAt),
            updated_at = @updatedAt
        WHERE task_id = @taskId AND cancelled_at IS NULL AND died_at IS NULL
          AND timed_out_at IS NULL AND resource_limited_at IS NULL
      `)
    : undefined;
  // 清租约语句只在事实列齐备（已迁移）的库上 prepare；旧形状库上 releaseLease 给确定性拒绝。
  const releaseLeaseStmt = hasFactColumns
    ? db.prepare(`
        UPDATE tasks SET lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId
      `)
    : undefined;
  const setResultTextStmt = db.prepare(`
    UPDATE tasks SET result_text = @resultText, updated_at = @updatedAt WHERE task_id = @taskId
  `);
  // 认领条件 = 未启动（running_since NULL）且无任何结束事实（四个时刻列全 NULL）。
  const selectOldestUnstarted = hasFactColumns
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE running_since IS NULL AND died_at IS NULL AND cancelled_at IS NULL
          AND timed_out_at IS NULL AND resource_limited_at IS NULL
        ORDER BY created_at, task_id LIMIT 1
      `)
    : undefined;
  const selectExpiredLeases = hasFactColumns
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE lease_until IS NOT NULL AND lease_until <= ?
          AND died_at IS NULL AND cancelled_at IS NULL AND timed_out_at IS NULL
        ORDER BY created_at, task_id
      `)
    : undefined;
  // 预期契约（2026-11-18）：只读在跑行（长时间提醒扫描；含长任务等待回执的行）。
  // 在跑事实 = running_since 非空、无等待形状、四个时刻列全 NULL。
  const selectRunningTasks = hasFactColumns
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE running_since IS NOT NULL AND pending_question IS NULL
          AND died_at IS NULL AND cancelled_at IS NULL AND timed_out_at IS NULL
          AND resource_limited_at IS NULL
        ORDER BY created_at, task_id
      `)
    : undefined;
  const hasLongRunningColumn = columns.has('long_running_notified_at');
  const hasWaitContactLostColumn = columns.has('wait_contact_lost_notified_at');
  const claimLongRunningNoticeStatements = {
    overdue: hasLongRunningColumn
      ? db.prepare(`
          UPDATE tasks SET long_running_notified_at = @at
          WHERE task_id = @taskId AND long_running_notified_at IS NULL
        `)
      : undefined,
    // 长任务等待「断联系」档（2026-11-19）：同一「每档至多一次」口径（重启不重发）。
    contact_lost: hasWaitContactLostColumn
      ? db.prepare(`
          UPDATE tasks SET wait_contact_lost_notified_at = @at
          WHERE task_id = @taskId AND wait_contact_lost_notified_at IS NULL
        `)
      : undefined,
  };
  const setReply = hasReplyColumn
    ? db.prepare(`
        UPDATE tasks SET reply_text = @replyText, updated_at = @updatedAt WHERE task_id = @taskId
      `)
    : undefined;
  const hasDispatchColumn = (() => {
    const cols = tableColumnsOf(db, 'executions');
    return cols.size > 0 && cols.has('dispatch_key');
  })();
  const insertExecution = hasDispatchColumn
    ? db.prepare(`
        INSERT INTO executions (request_id, task_id, operation, status, error_json, dispatch_key)
        VALUES (@requestId, @taskId, @operation, @status, @errorJson, @dispatchKey)
      `)
    : db.prepare(`
        INSERT INTO executions (request_id, task_id, operation, status, error_json)
        VALUES (@requestId, @taskId, @operation, @status, @errorJson)
      `);
  const selectTask = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  const selectExecutions = db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY rowid');
  const selectTasks = db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id');
  const selectTasksScoped = db.prepare(
    'SELECT * FROM tasks WHERE principal_id = ? AND session_id = ? ORDER BY created_at, task_id',
  );
  /** 按 scope 取等待行（2026-11-19：交办前的「有没有待确认提案」检查必须走索引，不能全表）。 */
  const selectWaitingScoped = hasFactColumns
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE principal_id = ? AND session_id = ? AND pending_question IS NOT NULL
          AND cancelled_at IS NULL AND died_at IS NULL AND timed_out_at IS NULL
          AND resource_limited_at IS NULL
        ORDER BY created_at, task_id
      `)
    : undefined;
  const selectWaitingAll = hasFactColumns
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE pending_question IS NOT NULL AND cancelled_at IS NULL AND died_at IS NULL
          AND timed_out_at IS NULL AND resource_limited_at IS NULL
        ORDER BY created_at, task_id
      `)
    : undefined;

  const hasOperations = tableColumnsOf(db, 'operations').size > 0;
  const selectOperation = hasOperations
    ? db.prepare('SELECT * FROM operations WHERE dispatch_key = ?')
    : undefined;
  const selectOperationCandidates = hasOperations
    ? db.prepare('SELECT * FROM operations WHERE scope_key = @scopeKey AND operation = @operation AND attempt = @attempt ORDER BY op_seq')
    : undefined;
  const selectOperationsByStatus = hasOperations
    ? db.prepare('SELECT * FROM operations WHERE status = ? ORDER BY claimed_at, op_seq')
    : undefined;
  const selectMaxOpSeq = hasOperations
    ? db.prepare('SELECT COALESCE(MAX(op_seq), 0) AS maxSeq FROM operations WHERE scope_key = ?')
    : undefined;
  const insertOperation = hasOperations
    ? db.prepare(`
        INSERT INTO operations (
          dispatch_key, scope_key, task_id, op_seq, operation, status, reason, outcome_json,
          attempt, claimed_at, settled_at, delivered_at, replay_of
        )
        VALUES (
          @dispatchKey, @scopeKey, @taskId, @opSeq, @operation, 'claimed', NULL, NULL,
          @attempt, @now, NULL, NULL, NULL
        )
      `)
    : undefined;
  const reclaimOperationStmt = hasOperations
    ? db.prepare(`
        UPDATE operations
        SET status = 'claimed', reason = NULL, outcome_json = NULL, settled_at = NULL,
            delivered_at = NULL, claimed_at = @now, attempt = @attempt,
            task_id = COALESCE(@taskId, task_id)
        WHERE dispatch_key = @dispatchKey
      `)
    : undefined;
  const applyOperationStateStmt = hasOperations
    ? db.prepare(`
        UPDATE operations
        SET status = @status,
            reason = @reason,
            outcome_json = @outcomeJson,
            claimed_at = COALESCE(@claimedAt, claimed_at),
            settled_at = @settledAt,
            delivered_at = @deliveredAt,
            attempt = COALESCE(@attempt, attempt),
            task_id = COALESCE(@taskId, task_id)
        WHERE dispatch_key = @dispatchKey AND status = @expectedStatus
      `)
    : undefined;
  /** 熔铸事务：MAX(op_seq)+1 与 INSERT 同一 BEGIN IMMEDIATE（并发认领不重号）。 */
  const mintOperationTx = insertOperation === undefined || selectMaxOpSeq === undefined
    ? undefined
    : db.transaction((input: OperationClaimRequest) => {
        const { maxSeq } = selectMaxOpSeq.get(input.scopeKey) as { maxSeq: number };
        const opSeq = maxSeq + 1;
        const dispatchKey = operationKeyOf(input.scopeKey, opSeq);
        insertOperation!.run({
          dispatchKey,
          scopeKey: input.scopeKey,
          taskId: input.taskId ?? null,
          opSeq,
          operation: input.operation,
          attempt: input.attempt,
          now: input.now,
        });
        return selectOperation!.get(dispatchKey) as OperationDbRow;
      });

  /**
   * 认领事务：BEGIN IMMEDIATE 先拿写锁再取行（跨进程并发下读到最新已提交数据）；
   * 再写 running_since + 租约（认领即「已启动」事实）；行已被并发认领则返回 undefined。
   */
  const claimTx = armLeaseStmt !== undefined && selectOldestUnstarted !== undefined
    ? db.transaction((input: { owner: string; leaseUntil: string; updatedAt: string }) => {
        const row = selectOldestUnstarted.get() as TaskDbRow | undefined;
        if (row === undefined) return undefined;
        const changed = armLeaseStmt.run({
          taskId: row.task_id,
          owner: input.owner,
          leaseUntil: input.leaseUntil,
          updatedAt: input.updatedAt,
        }).changes > 0;
        if (!changed) return undefined;
        return selectTask.get(row.task_id) as TaskDbRow;
      })
    : undefined;

  // file_refs（CAP-01 S0/S2）：只读旧库没有该表 = 没有文件事实（读出缺省，不崩溃；写入给
  // 确定性拒绝）。解析侧按 v8 §4 拆两条查询：Main 只解析 task_id IS NULL；Worker 只解析
  // task_id = 当前任务。只读旧库（有表无 task_id 列）：Main 退回旧 3 条件查询（历史行都是
  // Main 侧会话文件），Worker 无行可解析（undefined）。
  const hasFileRefs = tableColumnsOf(db, 'file_refs').size > 0;
  const hasFileRefTaskColumn = hasFileRefs && tableColumnsOf(db, 'file_refs').has('task_id');
  // 方案 A：只读旧库（有表无 deliverable 列）不能写，但 prepare 含该列的语句会直接报
  // no such column——按列是否存在选语句形状；可写打开时迁移已补列。
  const hasFileRefDeliverableColumn = hasFileRefs && tableColumnsOf(db, 'file_refs').has('deliverable');
  const insertFileRefStmt = hasFileRefTaskColumn
    ? hasFileRefDeliverableColumn
      ? db.prepare(`
          INSERT INTO file_refs (file_id, principal_id, session_id, task_id, name, sha256, bytes, activated_at, created_at, deliverable)
          VALUES (@fileId, @principalId, @sessionId, @taskId, @name, @sha256, @bytes, @activatedAt, @createdAt, @deliverable)
        `)
      : db.prepare(`
          INSERT INTO file_refs (file_id, principal_id, session_id, task_id, name, sha256, bytes, activated_at, created_at)
          VALUES (@fileId, @principalId, @sessionId, @taskId, @name, @sha256, @bytes, @activatedAt, @createdAt)
        `)
    : undefined;
  const selectMainFileRef = hasFileRefTaskColumn
    ? db.prepare('SELECT * FROM file_refs WHERE file_id = ? AND principal_id = ? AND session_id = ? AND task_id IS NULL')
    : hasFileRefs
      ? db.prepare('SELECT * FROM file_refs WHERE file_id = ? AND principal_id = ? AND session_id = ?')
      : undefined;
  const selectWorkerFileRef = hasFileRefTaskColumn
    ? db.prepare('SELECT * FROM file_refs WHERE file_id = ? AND principal_id = ? AND session_id = ? AND task_id = ?')
    : undefined;
  const selectFileRefsScoped = hasFileRefs
    ? db.prepare('SELECT * FROM file_refs WHERE principal_id = ? AND session_id = ? ORDER BY created_at, file_id')
    : undefined;
  const selectFileRefsAll = hasFileRefs
    ? db.prepare('SELECT * FROM file_refs ORDER BY created_at, file_id')
    : undefined;
  // 复用只允许 Main 侧行（task_id IS NULL）：任务副本/产物绑定任务，不能被入站登记改写。
  // created_at 只在显式给出 @createdAt 时刷新（COALESCE 保旧值）：pending→pending 复用需要
  // 让激活窗口重新计时，已激活复用则保留原始登记时刻做审计。
  const updateMainFileRefStmt = hasFileRefTaskColumn
    ? db.prepare(`
        UPDATE file_refs SET name = @name, activated_at = @activatedAt,
          created_at = COALESCE(@createdAt, created_at)
        WHERE file_id = @fileId AND principal_id = @principalId AND session_id = @sessionId
          AND task_id IS NULL
      `)
    : undefined;
  const activatePendingFileRefsStmt = hasFileRefs
    ? db.prepare(`
        UPDATE file_refs SET activated_at = @activatedAt
        WHERE principal_id = @principalId AND session_id = @sessionId
          AND activated_at IS NULL AND created_at >= @createdAfter
      `)
    : undefined;

  // inbound_messages（2026-11-19）：入站消息跨重启幂等底账。纯新增表——可写打开必由
  // SCHEMA_BASE 建成；只读旧库缺表 = 没有账（get 读出缺省、cleanup 返回 0；写入给确定性拒绝）。
  const hasInboundMessages = tableColumnsOf(db, 'inbound_messages').size > 0;
  const insertInboundStmt = hasInboundMessages
    ? db.prepare(`
        INSERT INTO inbound_messages (message_id, principal_id, session_id, state, reply_text, claimed_at, completed_at)
        VALUES (@messageId, @principalId, @sessionId, 'processing', NULL, @claimedAt, NULL)
        ON CONFLICT(principal_id, session_id, message_id) DO NOTHING
      `)
    : undefined;
  const selectInboundStmt = hasInboundMessages
    ? db.prepare('SELECT * FROM inbound_messages WHERE principal_id = ? AND session_id = ? AND message_id = ?')
    : undefined;
  const completeInboundStmt = hasInboundMessages
    ? db.prepare(`
        UPDATE inbound_messages SET state = 'done', reply_text = @replyText, completed_at = @completedAt
        WHERE principal_id = @principalId AND session_id = @sessionId AND message_id = @messageId
      `)
    : undefined;
  const deleteInboundStmt = hasInboundMessages
    ? db.prepare('DELETE FROM inbound_messages WHERE principal_id = ? AND session_id = ? AND message_id = ?')
    : undefined;
  const cleanupInboundStmt = hasInboundMessages
    ? db.prepare('DELETE FROM inbound_messages WHERE COALESCE(completed_at, claimed_at) < ?')
    : undefined;
  /** 认领事务（BEGIN IMMEDIATE）：INSERT ... DO NOTHING 与冲突后的读同一写事务，跨进程不重号、不误判。 */
  const claimInboundTx = insertInboundStmt === undefined || selectInboundStmt === undefined
    ? undefined
    : db.transaction((input: { messageId: string; principalId: string; sessionId: string; claimedAt: string }): InboundClaimOutcome => {
        const inserted = insertInboundStmt.run(input).changes > 0;
        if (inserted) return { outcome: 'claimed' };
        const row = selectInboundStmt.get(input.principalId, input.sessionId, input.messageId) as InboundMessageDbRow | undefined;
        if (row !== undefined && row.state === 'done') return { outcome: 'done', replyText: row.reply_text ?? '' };
        return { outcome: 'processing' };
      });

  const toFileRef = (row: FileRefDbRow): FileRefRow => ({
    fileId: row.file_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    ...(row.task_id === null || row.task_id === undefined ? {} : { taskId: row.task_id }),
    name: row.name,
    sha256: row.sha256,
    bytes: row.bytes,
    ...(row.activated_at === null || row.activated_at === undefined ? {} : { activatedAt: row.activated_at }),
    createdAt: row.created_at,
    // 方案 A：缺列/旧行 NULL/1 → 可交付；只有显式 0 才是内部诊断产物。
    deliverable: row.deliverable === 0 ? false : true,
  });

  const toInbound = (row: InboundMessageDbRow): InboundMessageRow => ({
    messageId: row.message_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    state: row.state,
    ...(row.reply_text === null || row.reply_text === undefined ? {} : { replyText: row.reply_text }),
    claimedAt: row.claimed_at,
    ...(row.completed_at === null || row.completed_at === undefined ? {} : { completedAt: row.completed_at }),
  });

  const toTask = (row: TaskDbRow): TaskRow => ({
    taskId: row.task_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    request: row.request,
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.pending_question === null || row.pending_question === undefined
      ? {}
      : { pendingQuestion: JSON.parse(row.pending_question) as unknown }),
    ...(row.waiting_since === null || row.waiting_since === undefined ? {} : { waitingSince: row.waiting_since }),
    ...(row.lease_owner === null || row.lease_owner === undefined ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_until === null || row.lease_until === undefined ? {} : { leaseUntil: row.lease_until }),
    // 四个一次性机械时刻（S1 事实模型；NULL = 未发生）。
    ...(row.died_at === null || row.died_at === undefined ? {} : { diedAt: row.died_at }),
    ...(row.cancelled_at === null || row.cancelled_at === undefined ? {} : { cancelledAt: row.cancelled_at }),
    ...(row.timed_out_at === null || row.timed_out_at === undefined ? {} : { timedOutAt: row.timed_out_at }),
    ...(row.resource_limited_at === null || row.resource_limited_at === undefined
      ? {}
      : { resourceLimitedAt: row.resource_limited_at }),
    // P1：旧库只读（未迁移）时列不存在 → row.task_no 为 undefined：读出缺省，不崩溃。
    ...(row.task_no === null || row.task_no === undefined ? {} : { taskNo: row.task_no }),
    ...(row.name === null || row.name === undefined ? {} : { name: row.name }),
    ...(row.reply_text === null || row.reply_text === undefined ? {} : { replyText: row.reply_text }),
    ...(row.long_running_notified_at === null || row.long_running_notified_at === undefined
      ? {}
      : { longRunningNotifiedAt: row.long_running_notified_at }),
    ...(row.wait_contact_lost_notified_at === null || row.wait_contact_lost_notified_at === undefined
      ? {}
      : { waitContactLostNotifiedAt: row.wait_contact_lost_notified_at }),
    ...(row.running_since === null || row.running_since === undefined ? {} : { runningSince: row.running_since }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const toExecution = (row: ExecutionDbRow): ExecutionRow => ({
    requestId: row.request_id,
    taskId: row.task_id,
    operation: row.operation,
    status: row.status,
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) as unknown }),
    ...(row.dispatch_key === null || row.dispatch_key === undefined ? {} : { dispatchKey: row.dispatch_key }),
  });

  const toOperation = (row: OperationDbRow): OperationRow => ({
    dispatchKey: row.dispatch_key,
    scopeKey: row.scope_key,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    opSeq: row.op_seq,
    operation: row.operation,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.outcome_json === null ? {} : { outcome: JSON.parse(row.outcome_json) as unknown }),
    attempt: row.attempt,
    claimedAt: row.claimed_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.replay_of === null ? {} : { replayOf: row.replay_of }),
  });

  const storedTask = (row: TaskDbRow): StoredTask => ({
    task: toTask(row),
    executions: (selectExecutions.all(row.task_id) as ExecutionDbRow[]).map(toExecution),
  });

  const missingFactColumnsError =
    '任务底账是旧版 schema（缺事实模型列）且以只读打开：不能写任务事实（请先用可写入口完成迁移）。';
  const missingOperationsError =
    '任务底账是旧版 schema（缺 U3 operations 表/executions.dispatch_key）且以只读打开：不能读写逻辑操作账（请先用可写入口完成迁移）。';
  const missingFileRefsError =
    '任务底账是旧版 schema（缺 file_refs 表）且以只读打开：不能登记文件事实（请先用可写入口完成迁移）。';
  const missingFileRefTaskColumnError =
    '任务底账是旧版 schema（file_refs 缺 task_id 列）且以只读打开：不能登记文件事实（请先用可写入口完成迁移）。';
  const missingInboundError =
    '任务底账是旧版 schema（缺 inbound_messages 表）且以只读打开：不能读写入站消息幂等账（请先用可写入口完成迁移）。';

  /**
   * U3：把「读候选 + 决策 + 写」包进同一写事务（BEGIN IMMEDIATE）。
   * 声明在返回对象之外，保留泛型签名（better-sqlite3 同步事务）。
   */
  const runTransaction = <T>(fn: () => T): T =>
    (db.transaction(fn) as unknown as { immediate: () => T }).immediate();

  return {
    insertTask(row) {
      if (insertTaskTx === undefined) {
        throw new Error('任务底账是旧版 schema（缺 task_no/编号计数器或事实模型列）且以只读打开：不能插入任务（请先用可写入口完成迁移）。');
      }
      insertTaskTx({
        taskId: row.taskId,
        principalId: row.principalId,
        sessionId: row.sessionId,
        request: row.request,
        resultText: row.resultText ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        name: row.name ?? null,
        replyText: row.replyText ?? null,
        runningSince: row.runningSince ?? null,
      });
      return toTask(selectTask.get(row.taskId) as TaskDbRow);
    },
    touchTask(taskId, updatedAt) {
      return touch.run(updatedAt, taskId).changes > 0;
    },
    markTaskFact(taskId, write) {
      const statement = write.fact === 'died'
        ? markDiedStmt
        : write.fact === 'cancelled'
          ? markCancelledStmt
          : write.fact === 'timed_out'
            ? markTimedOutStmt
            : markResourceLimitedStmt;
      if (statement === undefined) throw new Error(missingFactColumnsError);
      return statement.run({ taskId, at: write.at, updatedAt: write.updatedAt }).changes > 0;
    },
    setWaiting(taskId, write) {
      if (setWaitingStmt === undefined) throw new Error(missingFactColumnsError);
      return setWaitingStmt.run({
        taskId,
        pendingQuestionJson: write.pendingQuestion === undefined || write.pendingQuestion === null
          ? null
          : JSON.stringify(write.pendingQuestion),
        waitingSince: write.waitingSince ?? null,
        updatedAt: write.updatedAt,
      }).changes > 0;
    },
    armLease(taskId, write) {
      if (armLeaseStmt === undefined) throw new Error(missingFactColumnsError);
      return armLeaseStmt.run({
        taskId,
        owner: write.owner,
        leaseUntil: write.leaseUntil,
        updatedAt: write.updatedAt,
      }).changes > 0;
    },
    releaseLease(taskId, updatedAt) {
      if (releaseLeaseStmt === undefined) throw new Error(missingFactColumnsError);
      return releaseLeaseStmt.run({ taskId, updatedAt }).changes > 0;
    },
    setResultText(taskId, write) {
      return setResultTextStmt.run({ taskId, resultText: write.resultText, updatedAt: write.updatedAt }).changes > 0;
    },
    claimNextUnstarted(input) {
      if (claimTx === undefined) throw new Error(missingFactColumnsError);
      const row = claimTx.immediate(input);
      return row === undefined ? undefined : toTask(row);
    },
    listRunningExpiredLeases(now) {
      if (selectExpiredLeases === undefined) throw new Error(missingFactColumnsError);
      return (selectExpiredLeases.all(now) as TaskDbRow[]).map(toTask);
    },
    claimLongRunningNotice(taskId, stage, at) {
      const statement = claimLongRunningNoticeStatements[stage];
      if (statement === undefined) {
        const column = stage === 'overdue' ? 'long_running_notified_at' : 'wait_contact_lost_notified_at';
        throw new Error(`任务底账是旧版 schema（缺 ${column} 列）且以只读打开：不能写长时间提醒事实（请先用可写入口完成迁移）。`);
      }
      return statement.run({ taskId, at }).changes > 0;
    },
    listRunningTasks() {
      if (selectRunningTasks === undefined) return [];
      return (selectRunningTasks.all() as TaskDbRow[]).map(toTask);
    },
    setReplyForTasks(taskIds, replyText, updatedAt) {
      if (setReply === undefined) {
        throw new Error('任务底账是旧版 schema（缺 reply_text 列）且以只读打开：不能写回复存档（请先用可写入口完成迁移）。');
      }
      const apply = db.transaction((ids: readonly string[]) => {
        for (const taskId of ids) setReply.run({ taskId, replyText, updatedAt });
      });
      apply(taskIds);
    },
    insertExecution(row) {
      if (taskExists.get(row.taskId) === undefined) return false;
      const bound = {
        requestId: row.requestId,
        taskId: row.taskId,
        operation: row.operation,
        status: row.status,
        errorJson: row.error === undefined ? null : JSON.stringify(row.error),
      };
      if (hasDispatchColumn) insertExecution.run({ ...bound, dispatchKey: row.dispatchKey ?? null });
      else insertExecution.run(bound);
      return true;
    },
    getTask(taskId) {
      const row = selectTask.get(taskId) as TaskDbRow | undefined;
      return row === undefined ? undefined : storedTask(row);
    },
    listTasks(scope) {
      const rows = (scope === undefined
        ? selectTasks.all()
        : selectTasksScoped.all(scope.principalId, scope.sessionId)) as TaskDbRow[];
      return rows.map(storedTask);
    },
    listWaitingRows(scope) {
      if (selectWaitingAll === undefined || selectWaitingScoped === undefined) return [];
      const rows = (scope === undefined
        ? selectWaitingAll.all()
        : selectWaitingScoped.all(scope.principalId, scope.sessionId)) as TaskDbRow[];
      return rows.map(storedTask);
    },
    listOperationCandidates(input) {
      if (selectOperationCandidates === undefined) throw new Error(missingOperationsError);
      return (selectOperationCandidates.all(input) as OperationDbRow[]).map(toOperation);
    },
    listOperationsByStatus(status) {
      // 只读旧库没有 operations 表 = 没有账（读出空集，不崩溃、不伪造）。
      if (selectOperationsByStatus === undefined) return [];
      return (selectOperationsByStatus.all(status) as OperationDbRow[]).map(toOperation);
    },
    getOperation(dispatchKey) {
      // 只读旧库没有 operations 表 = 没有账（读出缺省，不崩溃、不伪造）。
      if (selectOperation === undefined) return undefined;
      const row = selectOperation.get(dispatchKey) as OperationDbRow | undefined;
      return row === undefined ? undefined : toOperation(row);
    },
    mintOperation(input) {
      if (mintOperationTx === undefined) throw new Error(missingOperationsError);
      return toOperation(mintOperationTx.immediate(input));
    },
    reclaimOperation(dispatchKey, input) {
      if (reclaimOperationStmt === undefined || selectOperation === undefined) {
        throw new Error(missingOperationsError);
      }
      reclaimOperationStmt.run({
        dispatchKey,
        now: input.now,
        attempt: input.attempt,
        taskId: input.taskId ?? null,
      });
      const row = selectOperation.get(dispatchKey) as OperationDbRow | undefined;
      return row === undefined ? undefined : toOperation(row);
    },
    applyOperationState(dispatchKey, write) {
      if (applyOperationStateStmt === undefined) throw new Error(missingOperationsError);
      return applyOperationStateStmt.run({
        dispatchKey,
        expectedStatus: write.expectedStatus,
        status: write.status,
        reason: write.reason ?? null,
        outcomeJson: write.outcomeJson ?? null,
        claimedAt: write.claimedAt ?? null,
        settledAt: write.settledAt ?? null,
        deliveredAt: write.deliveredAt ?? null,
        attempt: write.attempt ?? null,
        taskId: write.taskId ?? null,
      }).changes > 0;
    },
    transaction(fn) {
      return runTransaction(fn);
    },
    insertFileRef(row) {
      if (insertFileRefStmt === undefined) {
        throw new Error(hasFileRefs ? missingFileRefTaskColumnError : missingFileRefsError);
      }
      insertFileRefStmt.run({
        fileId: row.fileId,
        principalId: row.principalId,
        sessionId: row.sessionId,
        taskId: row.taskId ?? null,
        name: row.name,
        sha256: row.sha256,
        bytes: row.bytes,
        activatedAt: row.activatedAt ?? null,
        createdAt: row.createdAt,
        ...(hasFileRefDeliverableColumn ? { deliverable: row.deliverable === false ? 0 : 1 } : {}),
      });
      // 无 DB 生成列（file_id/时间戳都来自调用方）：行即落库行；deliverable 读路径总是布尔。
      return { ...row, deliverable: row.deliverable ?? true };
    },
    getFileRef(fileId, scope, resolution) {
      // 解析侧决定查询（v8 §4）：Main → task_id IS NULL；Worker → task_id = 指定任务。
      // 只读旧库（无 task_id 列）Worker 无行可解析：undefined（与不存在同形，不崩溃）。
      const row = (
        resolution.side === 'main'
          ? selectMainFileRef?.get(fileId, scope.principalId, scope.sessionId)
          : selectWorkerFileRef?.get(fileId, scope.principalId, scope.sessionId, resolution.taskId)
      ) as FileRefDbRow | undefined;
      return row === undefined ? undefined : toFileRef(row);
    },
    listFileRefs(scope) {
      if (selectFileRefsScoped === undefined) return [];
      return (selectFileRefsScoped.all(scope.principalId, scope.sessionId) as FileRefDbRow[]).map(toFileRef);
    },
    listAllFileRefs() {
      if (selectFileRefsAll === undefined) return [];
      return (selectFileRefsAll.all() as FileRefDbRow[]).map(toFileRef);
    },
    updateFileRef(input) {
      if (updateMainFileRefStmt === undefined) {
        throw new Error(hasFileRefs ? missingFileRefTaskColumnError : missingFileRefsError);
      }
      return updateMainFileRefStmt.run({
        fileId: input.fileId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        name: input.name,
        activatedAt: input.activatedAt,
        createdAt: input.createdAt ?? null,
      }).changes > 0;
    },
    activatePendingFileRefs(scope, input) {
      if (activatePendingFileRefsStmt === undefined) throw new Error(missingFileRefsError);
      return activatePendingFileRefsStmt.run({
        principalId: scope.principalId,
        sessionId: scope.sessionId,
        activatedAt: input.activatedAt,
        createdAfter: input.createdAfter,
      }).changes;
    },
    claimInboundMessage(input) {
      if (claimInboundTx === undefined) throw new Error(missingInboundError);
      return claimInboundTx.immediate(input);
    },
    completeInboundMessage(input) {
      if (completeInboundStmt === undefined) throw new Error(missingInboundError);
      return completeInboundStmt.run({
        messageId: input.messageId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        replyText: input.replyText,
        completedAt: input.completedAt,
      }).changes > 0;
    },
    releaseInboundMessage(input) {
      if (deleteInboundStmt === undefined) throw new Error(missingInboundError);
      return deleteInboundStmt.run(input.principalId, input.sessionId, input.messageId).changes > 0;
    },
    getInboundMessage(input) {
      // 只读旧库没有该表 = 没有账（读出缺省，不崩溃、不伪造）。
      if (selectInboundStmt === undefined) return undefined;
      const row = selectInboundStmt.get(input.principalId, input.sessionId, input.messageId) as InboundMessageDbRow | undefined;
      return row === undefined ? undefined : toInbound(row);
    },
    cleanupInboundMessages(before) {
      // 只读旧库没有该表 = 无行可清（返回 0，不崩溃）。
      if (cleanupInboundStmt === undefined) return 0;
      return cleanupInboundStmt.run(before).changes;
    },
    close() {
      db.close();
    },
  };
}
