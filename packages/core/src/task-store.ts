/**
 * 最小任务底账的 SQLite 引擎（B 类：任务归属持久化，最小形状）。
 *
 * 只建两张表，字段按最小切片清单收口：
 *   · tasks：task_id / principal_id / session_id / request / status /
 *     result_text / failure_reason / created_at / updated_at
 *     +（P1 底账演化）task_no / name / reply_text
 *     +（P2a 契约核心）reason / pending_question / waiting_since / lease_owner / lease_until
 *     +（预期契约 2026-11-18）long_running_notified_at / long_running_stuck_notified_at
 *       （前者现用；后者随 2026-11-19「卡住」档删除后不再读写，列保留仅为旧库兼容）；
 *   · executions：request_id / task_id / operation / status / error_json。
 *
 * 为什么加 P1 三列（2026-11-14）：数字 ID 稳定简短（任务书 §3，不得回退面向业务的
 * UUID）；业务名称 v1 机械回落（决策问题 #4 v1，零模型、不改 task_run 工具 schema）；
 * Main 最终回复存档（S1，决策问题 #12：同回合各任务行同值，不建 turns 表）。
 *
 * 为什么加 P2a 五列（2026-11-14，docs/history/r4-joint-interfaces.md §1）：
 *   · reason：机械终止原因（cancelled_by_user/timeout/failed_confirmed/result_unknown/
 *     resource_limited）——与 failure_reason（人读文本）分工，result_unknown ≠ failed ≠ success；
 *   · pending_question / waiting_since：waiting_user 形状（JSON：missing[]/candidates?/raw? + ISO 时刻）；
 *   · lease_owner / lease_until：后台认领租约（仅 running 持有；过期 → result_unknown，不自动重放）。
 *
 * 迁移口径（版本化迁移；登记：本注 + docs/decisions/index.md R4 登记节）：
 *   · 触发 = 可写打开且 tasks 表缺列（旧库）或缺 operations 表 / executions.dispatch_key
 *     （U3 schema v4）；只读打开永不迁移——旧库只读时新列新表读出缺省（不崩溃）、主库哈希不变；
 *   · 迁移前自动备份：wal_checkpoint(FULL) 后整文件复制为 <dbPath>.backup-v<N>
 *     （N = 迁移目标 schema 版本，当前 4；不覆盖、不自动删除；:memory: 与库文件不存在不生成）；
 *   · 回填 task_no（仅缺该列时）：按 (created_at, task_id) 升序、单条 SQL（ROW_NUMBER）
 *     连续分配，只填 NULL 行（幂等：二次打开零差异）；历史行 name/reply_text/reason 等
 *     保持 NULL（无存档不伪造，显示层标注「该任务无最终回复存档」）；
 *   · U3 新增面只做**前向加法**：operations 是 CREATE TABLE IF NOT EXISTS，executions 只
 *     ADD COLUMN dispatch_key（历史执行行 = NULL，语义仍是「一行 = 一次真实执行」，不补写、
 *     不改写）；二次打开零差异，旧库形状（tasks/executions 既有列与行）逐字节不变；
 *   · PRAGMA user_version 记录版本（新库直接建 v4）；向前兼容：加列/加表不破坏旧代码 SELECT。
 *
 * file_refs（CAP-01 S0，设计 v8 §4；文档 2026-11-18 删除、git 历史可考）：文件事实的
 * 8 列最小形状，纯新增表走 CREATE TABLE IF NOT EXISTS，**不升 schema 版本**（旧库
 * 可写打开时由 SCHEMA_BASE 补建；只读旧库读出缺省，不崩溃）。没有 state 枚举——
 * activated_at IS NULL 即 pending；不存 path——字节位置由 workspace 布局 + file_id
 * 派生（见 packages/agent/src/file-store.ts），本表没有、也不得有 path 列。
 * 时间戳用 epoch 毫秒（INTEGER）：本表由机械写入方（fileStore）独占，读取方只做
 * 比较，不做人类展示——与 tasks 表的 ISO TEXT 有意不同。
 *
 * file_refs.task_id（CAP-01 S2，v8 §4 作用域规则）：纯前向加法第 9 列（TEXT NULL）。
 * Main 只解析 task_id IS NULL 的行；Worker 只解析 task_id = 当前任务的行——越权/不存在/
 * 过期在上层同码 FILE_REF_UNAVAILABLE（本层一律 undefined，防存在性 oracle）。旧库可写
 * 打开时 ADD COLUMN（迁移谓词扩展，与 tasks 列迁移共用同一次 v4 备份；不升 user_version）；
 * 只读旧库（有 file_refs 无 task_id 列）Main 解析退回旧 3 条件查询（历史行都是 Main 侧）、
 * Worker 解析读出 undefined、写入确定性拒绝。
 *
 * inbound_messages（跨重启渠道重投幂等，2026-11-19）：把「这一条入站消息处理过没有」
 * 从进程内存搬成底账事实。主键 (principal_id, session_id, message_id)——渠道 messageId
 * 只在同一会话内有意义，跨会话同名消息不得互相吞。纯新增表走 CREATE TABLE IF NOT EXISTS，
 * **不升 schema 版本**（旧库可写打开时由 SCHEMA_BASE 补建；只读旧库读出缺省，不崩溃）。
 * 两阶段：认领写 state='processing'（claimed_at）；处理完成 UPDATE state='done' +
 * reply_text + completed_at。命中原行时——done → 回放 reply_text（零新副作用）；processing
 * → 上一进程未落定，不重复执行（由上层回「上次没办完、结果未知」并记事件）。处理失败删行（失败不缓存，
 * 渠道可重投）。claimed_at/completed_at 用 ISO TEXT（与本表读取比对口径一致；启动清扫按
 * COALESCE(completed_at, claimed_at) < 保留期）。本表不承载任务/执行事实，只做入站消息查重。
 *
 * 数字编号（P1）：
 *   · 分配 = 计数器行（task_sequences.name='task_no'）在**同一事务**内
 *     `UPDATE task_sequences SET value = value + 1 … RETURNING value` + INSERT：
 *     并发安全（SQLite 写事务串行化；多进程并发实测唯一连续）；失败随事务回滚
 *     （失败不占号）；计数器单调不减（每次打开按 MAX(现值, 历史最大编号) 校正）
 *     → 删除/修剪后也不复用、存量编号不重排；
 *   · 同回合各任务行写同一最终回复（setReplyForTasks，单事务，同值）。
 *
 * 状态写入（P2a 唯一写路径）：
 *   · applyTaskState **单条语句**写 status/reason/result_text/failure_reason/pending_question/
 *     waiting_since/lease_owner/lease_until + updated_at，WHERE task_id AND
 *     status=@expectedStatus（乐观并发；不匹配不写）；
 *   · claimQueued 在 BEGIN IMMEDIATE 写事务内先取最老 queued 行，再经同一语句置
 *     running + 租约（进程内/跨进程并发认领不重号）；
 *   · 其他模块禁止直接 UPDATE tasks.status（源码级守卫见
 *     packages/agent/task-registry-write-path.test.ts）。
 *
 * 为什么不恢复旧 store.ts（2026-11-13 删除）而是新写最小引擎：旧 store 承载
 * TaskPlan / ChangeIntent / TaskRun / PlatformTask 等多套旧 hub 对象与状态机，
 * 本切片不迁它们的计划字段（planId / stepIndex / totalSteps / lastProgress /
 * deadline / originMessage 一概不出现），也不复制多套状态机——表就是上面两张。
 *
 * better-sqlite3 是同步 API：本层不加 async 包装；调用方（task-registry-sqlite）
 * 本来就同步。读出的 status/error 是存储原值，由 registry 侧按领域类型收口。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 当前 schema 版本（PRAGMA user_version）。2 = P1；3 = P2a 契约核心；4 = U3 逻辑操作身份（operations + executions.dispatch_key）。 */
export const TASK_STORE_SCHEMA_VERSION = 4;

/** 一条最小任务底账行（存储形状；领域收口在 task-registry-sqlite）。 */
export interface TaskRow {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /** 'queued' | 'running' | 'waiting_user' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'timed_out' | 'unexecuted'（registry 侧取值）。 */
  status: string;
  resultText?: string;
  failureReason?: string;
  /** P2a：机械终止原因（TaskReason；与 failure_reason 分工）。 */
  reason?: string;
  /** P2a：waiting_user 的问题形状（PendingQuestion，JSON 存读；缺省=非等待）。 */
  pendingQuestion?: unknown;
  /** P2a：进入等待的时刻（ISO）。 */
  waitingSince?: string;
  /** P2a：后台认领租约（仅 running 持有）。 */
  leaseOwner?: string;
  leaseUntil?: string;
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

/** P2a 单语句状态写入（TaskRegistry 唯一写路径；expectedStatus = 乐观并发期望值）。 */
export interface TaskStateWrite {
  /** 期望的当前状态：不匹配（并发已变化）则不写、返回 false。 */
  expectedStatus: string;
  status: string;
  reason?: string | null;
  resultText?: string | null;
  failureReason?: string | null;
  /** PendingQuestion（本层 JSON 编码）；undefined/null = NULL（无等待形状）。 */
  pendingQuestion?: unknown;
  waitingSince?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
  updatedAt: string;
}

export interface TaskStore {
  /** 插入任务并返回落库行（P1：task_no 由本语句原子分配；失败抛出，不消耗编号）。 */
  insertTask(row: TaskRow): TaskRow;
  /** 触碰 updatedAt；任务不存在返回 false（调用方按拒绝路径处理）。 */
  touchTask(taskId: string, updatedAt: string): boolean;
  /**
   * P2a 唯一状态写入（单语句）：任务不存在/期望状态不符返回 false（零写入）。
   */
  applyTaskState(taskId: string, state: TaskStateWrite): boolean;
  /**
   * P2a 原子认领最老 queued（created_at, task_id 升序）：同一写事务内置 running + 租约；
   * 无 queued 返回 undefined。
   */
  claimQueued(input: { owner: string; leaseUntil: string; updatedAt: string }): TaskRow | undefined;
  /**
   * 预期契约（2026-11-18；2026-11-19 唤醒切片删除「卡住」档）：原子领取一档「长时间没动静」
   * 提醒——只有当该档时间列为 NULL 时才写入并返回 true（并发/重启下同一任务每档至多一次；
   * 已提醒过返回 false，零写入）。stage = 'overdue'（10 分钟「久无动静」档）| 'contact_lost'
   * （长任务等待与执行层断了联系；只说明没拿到回执，不代表任务失败）。
   * 30 分钟「卡住」档已删（其列保留仅为旧库兼容，不再读写）。
   */
  claimLongRunningNotice(taskId: string, stage: 'overdue' | 'contact_lost', at: string): boolean;
  /**
   * 预期契约：只读 running 行（长时间提醒扫描用；避免每趟 pump 全表分配）。
   * 不读不写状态；旧库只读（未迁移）时该列读出缺省。
   */
  listRunningTasks(): TaskRow[];
  /** P2a：running 且租约已过期（lease_until 非空且 <= now）的任务行。 */
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
  listTasks(scope?: { principalId: string; sessionId: string }, status?: string): StoredTask[];
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

/** 当前版本的表与索引（新建库直接落 v3；旧库先建这里缺的、再加列回填）。 */
const SCHEMA_BASE = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  result_text TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_no INTEGER,
  name TEXT,
  reply_text TEXT,
  reason TEXT,
  pending_question TEXT,
  waiting_since TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  -- 预期契约（2026-11-18）：已发过「超预期」长时间提醒的时刻（ISO，NULL = 未提醒）。
  -- 纯前向加法列，不升 user_version。long_running_stuck_notified_at（30 分钟「卡住」档）
  -- 已随 2026-11-19 唤醒切片删除读取/写入，列保留仅为旧库兼容（迁移历史不动）。
  long_running_notified_at TEXT,
  long_running_stuck_notified_at TEXT,
  -- 「这一轮开始跑」的时刻（ISO，单调写一次；NULL = 未跑过）。长任务受理后租约会被清掉，
  -- 「跑了多久」不能只从租约反推，否则最该提醒的任务反而不在提醒扫描里（2026-11-19）。
  running_since TEXT,
  -- 2026-11-19：长任务等待「与执行层断了联系（无回执）」已告知过用户的时刻（ISO，NULL = 未告知）。
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

/** 版本化新增列（名 → SQLite 列类型）：P1 三列 + P2a 五列 + 预期契约两列，按版本正序。 */
const TASK_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['task_no', 'INTEGER'],
  ['name', 'TEXT'],
  ['reply_text', 'TEXT'],
  ['reason', 'TEXT'],
  ['pending_question', 'TEXT'],
  ['waiting_since', 'TEXT'],
  ['lease_owner', 'TEXT'],
  ['lease_until', 'TEXT'],
  // 预期契约（2026-11-18）：单调写入一次的时间戳列（前向加法，不升 user_version）。
  ['long_running_notified_at', 'TEXT'],
  ['long_running_stuck_notified_at', 'TEXT'],
  // 2026-11-19：本轮开始运行的时刻（长任务受理后租约被清，提醒扫描需要独立起点）。
  ['running_since', 'TEXT'],
  // 2026-11-19：长任务等待「断联系」告知过用户的时刻（同一「每档至多一次」口径）。
  ['wait_contact_lost_notified_at', 'TEXT'],
];

interface TaskDbRow {
  task_id: string;
  principal_id: string;
  session_id: string;
  request: string;
  status: string;
  result_text: string | null;
  failure_reason: string | null;
  task_no?: number | null;
  name?: string | null;
  reply_text?: string | null;
  reason?: string | null;
  pending_question?: string | null;
  waiting_since?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
  long_running_notified_at?: string | null;
  // 旧库兼容列：30 分钟「卡住」档删除后不再读写（见上面 schema 注释）。
  long_running_stuck_notified_at?: string | null;
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

/** 旧库迁移标记的读取：tasks 表不存在 = 全新库（直接建 v4）。 */
function taskTableColumns(db: Database.Database): Set<string> {
  return tableColumnsOf(db, 'tasks');
}

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
        const missing = tableExists ? TASK_COLUMNS.filter(([name]) => !columns.has(name)) : [];
        const operationsMissing = tableExists && operationSchemaMissing(writable);
        // CAP-01 S2：旧 file_refs（有表无 task_id 列）→ ADD COLUMN（前向加法，不升版本）。
        const fileRefTaskMissing = tableExists && fileRefTaskColumnMissing(writable);
        const fileRefDeliverableMissing = tableExists && fileRefDeliverableColumnMissing(writable);
        if (missing.length > 0 || operationsMissing || fileRefTaskMissing || fileRefDeliverableMissing) {
          // 旧库迁移：先备份（目标版本命名），再加列，再（仅缺 task_no 时）回填编号，
          // 最后建唯一索引与版本号。U3 的 operations / executions.dispatch_key、task 列迁移
          // 与 file_refs.task_id / file_refs.deliverable 共用同一次备份（同一目标版本 v4；
          // 已有备份保留最早副本）。
          backupBeforeMigration(writable, dbPath);
          for (const [name, type] of missing) writable.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
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
        if (missing.some(([name]) => name === 'task_no')) {
          // 单条 SQL 回填：历史行按 (created_at, task_id) 升序从当前最大值之后连续分配。
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
  const hasLifecycleColumns = columns.has('reason')
    && columns.has('pending_question')
    && columns.has('waiting_since')
    && columns.has('lease_owner')
    && columns.has('lease_until');
  const allocateTaskNo = hasTaskNoColumn
    ? db.prepare("UPDATE task_sequences SET value = value + 1 WHERE name = 'task_no' RETURNING value")
    : undefined;
  const insertTaskStmt = hasTaskNoColumn
    ? db.prepare(`
        INSERT INTO tasks (
          task_id, principal_id, session_id, request, status, result_text, failure_reason, created_at, updated_at,
          task_no, name, reply_text
        )
        VALUES (
          @taskId, @principalId, @sessionId, @request, @status, @resultText, @failureReason, @createdAt, @updatedAt,
          @taskNo, @name, @replyText
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
      status: string;
      resultText: string | null;
      failureReason: string | null;
      createdAt: string;
      updatedAt: string;
      name: string | null;
      replyText: string | null;
    }) => {
      const allocated = allocate.get() as { value: number };
      insert.run({ ...bound, taskNo: allocated.value });
    });
  })();
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?');
  const touch = db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?');
  /** P2a 唯一状态写入语句（单条；源码级守卫按此判据守住「单写路径」）。 */
  // 旧库只读打开（未迁移）时可能没有 running_since 列：语句按列存在性拼装，不硬引用。
  const hasRunningSinceColumn = columns.has('running_since');
  const applyState = hasLifecycleColumns
    ? db.prepare(`
        UPDATE tasks
        SET status = @status,
            reason = @reason,
            result_text = @resultText,
            failure_reason = @failureReason,
            pending_question = @pendingQuestionJson,
            waiting_since = @waitingSince,
            lease_owner = @leaseOwner,
            lease_until = @leaseUntil,
            ${hasRunningSinceColumn
              // 本轮开始运行时刻：第一次进入 running 时写入，之后保持（长任务受理后清租约不清它）。
              ? "running_since = CASE WHEN @status = 'running' THEN COALESCE(running_since, @updatedAt) ELSE running_since END,"
              : ''}
            updated_at = @updatedAt
        WHERE task_id = @taskId AND status = @expectedStatus
      `)
    : undefined;
  const selectOldestQueued = hasLifecycleColumns
    ? db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at, task_id LIMIT 1")
    : undefined;
  const selectExpiredLeases = hasLifecycleColumns
    ? db.prepare("SELECT * FROM tasks WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY created_at, task_id")
    : undefined;
  // 预期契约（2026-11-18）：只读 running 行（长时间提醒扫描）与「仅一次」的原子领取。
  // claim 语句不写 status（状态单写路径不受影响）；旧库只读（未迁移）时没有该列 = 不能领。
  // 30 分钟「卡住」档已随 2026-11-19 唤醒切片删除：long_running_stuck_notified_at 列保留
  // （旧库兼容、迁移历史不动），但不再读写。
  const hasLongRunningColumn = columns.has('long_running_notified_at');
  const hasWaitContactLostColumn = columns.has('wait_contact_lost_notified_at');
  const selectRunningTasks = db.prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at, task_id");
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
  /** 按 scope + 状态取行（2026-11-19：交办前的「有没有待确认提案」检查必须走索引，不能全表）。 */
  const selectTasksScopedByStatus = db.prepare(
    'SELECT * FROM tasks WHERE principal_id = ? AND session_id = ? AND status = ? ORDER BY created_at, task_id',
  );

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
   * 再经唯一状态语句置 running；期望状态不符（被抢）返回 undefined。
   */
  const claimTx = applyState !== undefined && selectOldestQueued !== undefined
    ? db.transaction((input: { owner: string; leaseUntil: string; updatedAt: string }) => {
        const row = selectOldestQueued.get() as TaskDbRow | undefined;
        if (row === undefined) return undefined;
        const changed = applyState.run({
          taskId: row.task_id,
          expectedStatus: row.status,
          status: 'running',
          reason: null,
          resultText: row.result_text,
          failureReason: row.failure_reason,
          pendingQuestionJson: row.pending_question,
          waitingSince: row.waiting_since ?? null,
          leaseOwner: input.owner,
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
    status: row.status,
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    // P2a 列（旧库只读未迁移时为 undefined：读出缺省，不崩溃）。
    ...(row.reason === null || row.reason === undefined ? {} : { reason: row.reason }),
    // JSON 解析失败即抛出（存储损坏必须可见，不静默吞成 undefined）。
    ...(row.pending_question === null || row.pending_question === undefined
      ? {}
      : { pendingQuestion: JSON.parse(row.pending_question) as unknown }),
    ...(row.waiting_since === null || row.waiting_since === undefined ? {} : { waitingSince: row.waiting_since }),
    ...(row.lease_owner === null || row.lease_owner === undefined ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_until === null || row.lease_until === undefined ? {} : { leaseUntil: row.lease_until }),
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

  const missingLifecycleError =
    '任务底账是旧版 schema（缺 P2a 生命周期列）且以只读打开：不能写任务状态（请先用可写入口完成迁移）。';
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
        throw new Error('任务底账是旧版 schema（缺 task_no/编号计数器）且以只读打开：不能插入任务（请先用可写入口完成迁移）。');
      }
      insertTaskTx({
        taskId: row.taskId,
        principalId: row.principalId,
        sessionId: row.sessionId,
        request: row.request,
        status: row.status,
        resultText: row.resultText ?? null,
        failureReason: row.failureReason ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        name: row.name ?? null,
        replyText: row.replyText ?? null,
      });
      return toTask(selectTask.get(row.taskId) as TaskDbRow);
    },
    touchTask(taskId, updatedAt) {
      return touch.run(updatedAt, taskId).changes > 0;
    },
    applyTaskState(taskId, state) {
      if (applyState === undefined) throw new Error(missingLifecycleError);
      return applyState.run({
        taskId,
        expectedStatus: state.expectedStatus,
        status: state.status,
        reason: state.reason ?? null,
        resultText: state.resultText ?? null,
        failureReason: state.failureReason ?? null,
        pendingQuestionJson: state.pendingQuestion === undefined || state.pendingQuestion === null
          ? null
          : JSON.stringify(state.pendingQuestion),
        waitingSince: state.waitingSince ?? null,
        leaseOwner: state.leaseOwner ?? null,
        leaseUntil: state.leaseUntil ?? null,
        updatedAt: state.updatedAt,
      }).changes > 0;
    },
    claimQueued(input) {
      if (claimTx === undefined) throw new Error(missingLifecycleError);
      const row = claimTx.immediate(input);
      return row === undefined ? undefined : toTask(row);
    },
    listRunningExpiredLeases(now) {
      if (selectExpiredLeases === undefined) throw new Error(missingLifecycleError);
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
    listTasks(scope, status) {
      const rows = (scope === undefined
        ? selectTasks.all()
        : status === undefined
          ? selectTasksScoped.all(scope.principalId, scope.sessionId)
          : selectTasksScopedByStatus.all(scope.principalId, scope.sessionId, status)) as TaskDbRow[];
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
