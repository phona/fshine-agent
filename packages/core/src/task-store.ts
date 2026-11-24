/**
 * 最小任务底账的 SQLite 引擎（B 类：任务归属持久化，最小形状）。
 *
 * 不维护任务状态机（owner 2026-11-23）：task 不存任何「状态」——表只记**机械事实**：
 *   · tasks：task_id / principal_id / session_id / request / result_text / created_at /
 *     updated_at + task_no / name / reply_text（P1）+ pending_question / waiting_since /
 *     lease_owner / lease_until（等待形状与租约）+ long_running_notified_at /
 *     wait_contact_lost_notified_at / running_since（提醒与启动事实）。
 *     **没有** died/cancelled/timed_out/resource_limited/round_failed/cancel_requested 列，
 *     也没有 status/reason/failure_reason：这些是「结论/状态」，不存。
 *   · task_ends：**一条「这一轮在 T 停下」的机械事实**（task_id + at，同任务至多一条，
 *     不可变）。**没有 kind**——怎么结束不存；消费方读原始事实（汇报/执行行/活 worker）就地算。
 *   · executions：request_id / task_id / operation / status / error_json（逐笔执行事实）。
 *   · operations：claimed→resulted 幂等账（U3，行就是身份）——存活与结果判定的事实源。
 *
 * 活/结束现推（task-progress 的布尔事实谓词，**不存状态词**）：排队 = running_since 空 +
 * 无汇报 + 无提问；仍在推进 = 已启动 + 无结束事实 + 无汇报/提问；可能还活着（跨进程）=
 * 仍在推进 + 租约未过期或 accepted 在途；等用户 = pending_question。SQL 侧（重启扫描
 * listRunningTasks 等）只查「running_since 非空 + 无汇报 + 无提问 + 无结束事实」。
 *
 * 迁移口径（版本化迁移）：
 *   · 触发 = 可写打开且 tasks 表仍是旧形状（有 status 列/六个终态列，v5 及更早）——重建为
 *     事实形状；
 *   · v6 = tasks 表重建：删 status/reason/failure_reason 与六个终态列；**升级前已停下的旧行**
 *     写一条结束事实（旧终态列原时刻 / 旧 status 属已停集合 / 已有汇报，回退 updated_at）；
 *     **升级前从未启动的排队行也不写**——它是已受理、还没开跑的工作，重启后由 pump 认领，
 *     写成已停会让它既不再执行也没有「结果未知」出口；仍在等待或在跑的行同样不写——在跑行
 *     给一条已过期的迁移租约，交给启动恢复「租约过期 → 结束事实（结果未知）」并通知；历史
 *     汇报与执行事实原样保留；
 *   · v7 = task_events（带终止种类 kind 的旧事件账）→ task_ends：只保留「停下时刻」，
 *     丢掉种类；旧任务事实原样；
 *   · 只读打开旧形状库不迁移：读取投影把仍在的旧终态列还原成「停下时刻」（不写库）；
 *   · 回填 task_no（仅缺该列时）：按 (created_at, task_id) 升序连续分配，只填 NULL 行；
 *   · U3/file_refs/inbound 面只做前向加法（不变）；
 *   · PRAGMA user_version 记录版本（新库直接建 v7）。
 *
 * file_refs（CAP-01 S0/S2）与 inbound_messages（2026-11-19）语义不变，见下方历史注释与
 * git 历史（本头注只保留现行口径，逐列说明见各表 SCHEMA_BASE 注释）。
 *
 * 数字编号（P1）：分配 = 计数器行在同一事务内 RETURNING value + INSERT；失败随事务回滚；
 * 计数器单调不减（删除/修剪后不复用、不重排）；同回合各任务行写同一最终回复。
 *
 * 事实写入（唯一写路径；本层单条语句 + WHERE 一次性条件做并发防护）：
 *   · appendEndFact：结束事实的**一次性追加**（同任务已有结束事实 → 零写入），同一写事务
 *     内清租约（结束的任务不再持租约）；
 *   · setWaiting / armLease / setResultText / setReplyForTasks：等待形状、租约、报告存档；
 *   · claimNextUnstarted：BEGIN IMMEDIATE 内取最老未启动行，写 running_since + 租约
 *     （进程内/跨进程并发认领不重号）；
 *   · 其他模块禁止直接 UPDATE tasks（源码级守卫见 packages/agent/task-registry-write-path.test.ts）。
 *
 * better-sqlite3 是同步 API：本层不加 async 包装；调用方（task-registry-sqlite）本来就同步。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stillProgressingSqlWhere, TASK_PROGRESS_REPORT_FIELDS, TASK_PROGRESS_STARTED_COLUMN, type TaskProgressFacts } from './task-progress';

/** 当前 schema 版本（PRAGMA user_version）。2 = P1；3 = P2a；4 = U3；5 = S1 事实模型；6 = 零状态（删终态列）；7 = 结束事实去种类（task_events → task_ends）。 */
export const TASK_STORE_SCHEMA_VERSION = 7;

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
  /** 后台认领租约（在跑/接续回合持有；终止事件写入时清空）。 */
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
   * 否则最该主动汇报的长任务不在提醒扫描里（2026-11-19）。NULL = 未启动（可被认领）。
   */
  runningSince?: string;
  createdAt: string;
  updatedAt: string;
}

/** 一条结束事实（追加事实账；存储形状：只有「停下时刻」，没有种类）。 */
export interface TaskEndRow {
  taskId: string;
  at: string;
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

/** 任务 + 其执行记录与结束事实（读取单位）。 */
export interface StoredTask {
  task: TaskRow;
  executions: ExecutionRow[];
  /** 结束事实账（追加、不可变；同任务至多一条；只有时刻，没有种类）。 */
  ends: TaskEndRow[];
}

/**
 * 读取单位 → 「仍在推进」判定的输入投影：结束事实来自 task_ends 追加账（tasks 行没有
 * 终态列）。StoredTask 消费方（底账扫描 / 告警投影）必须经这里喂谓词——只取
 * `stored.task` 会让已结束任务仍被读成在跑/等待（2026-11-23 告警假「卡住」判负）。
 */
export function storedTaskProgressOf(stored: StoredTask): TaskProgressFacts {
  const last = stored.ends[stored.ends.length - 1];
  return {
    ...stored.task,
    ...(last === undefined ? {} : { endedAt: last.at }),
    executions: stored.executions,
  };
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

/** 一条结束事实的追加写入（唯一不可变写路径）。 */
export interface TaskEndWrite {
  taskId: string;
  at: string;
  updatedAt: string;
}

export interface TaskStore {
  /** 插入任务并返回落库行（P1：task_no 由本语句原子分配；失败抛出，不消耗编号）。 */
  insertTask(row: TaskRow): TaskRow;
  /** 触碰 updatedAt；任务不存在返回 false（调用方按拒绝路径处理）。 */
  touchTask(taskId: string, updatedAt: string): boolean;
  /**
   * 追加一条结束事实（append-only）：同任务**已有结束事实**时零写入并返回 false
   * （结束不翻案）；写入成功时同一写事务内清租约（结束的任务不再持租约）。
   * 读 task_ends（不是 tasks 的列）；只有时刻，没有种类。
   */
  appendEndFact(write: TaskEndWrite): boolean;
  /** 读结束事实账（按追加序；通常 0/1 条）。 */
  listEndFacts(taskId: string): TaskEndRow[];
  /**
   * 等待形状写入（waiting_user 事实）：pendingQuestion JSON + waiting_since；给出 null =
   * 清除（答复接续）。任务已有结束事实时拒绝写入（返回 false，零写入）——结束事实不翻案。
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
   * 无未启动任务返回 undefined。认领条件 = running_since IS NULL 且无结束事实。
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
   * running_since 非空、无等待形状、无汇报存档、无终止事件（含长任务等待回执的行）。
   */
  listRunningTasks(): TaskRow[];
  /** 租约已过期（lease_until 非空且 <= now）且仍在推进（无终止事件/汇报/等待）的任务行（看门狗扫描）。 */
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
  /** 只读等待行（waiting_user 事实：pending_question 非空且无终止事件）；scope 过滤走索引。 */
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

/** 当前版本的表与索引（新建库直接落 v7；旧库先重建 tasks / 结束事实、再补建缺的表）。 */
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
  -- 存活事实：租约（在跑/接续回合持有；终止事件写入时清空）。
  lease_owner TEXT,
  lease_until TEXT,
  -- 已发过「久无动静」提醒的时刻（ISO，NULL = 未提醒；每档至多一次）。
  long_running_notified_at TEXT,
  -- 「这一轮开始跑」的时刻（ISO，单调写一次；NULL = 未跑过=可认领）。
  running_since TEXT,
  -- 长任务等待「与执行层断了联系（无回执）」已告知过用户的时刻（ISO，NULL = 未告知）。
  wait_contact_lost_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks (principal_id, session_id);
CREATE TABLE IF NOT EXISTS task_ends (
  task_id TEXT PRIMARY KEY,
  -- 「这一轮在 T 停下」的机械时刻；没有 kind——怎么结束不存。
  at TEXT NOT NULL
);
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

/** v6 tasks 表的列清单（迁移重建时按列存在性取源值；新库直接按此形状建）。 */
const TASKS_V6_COLUMNS: readonly string[] = [
  'task_id', 'principal_id', 'session_id', 'request', 'result_text', 'created_at', 'updated_at',
  'task_no', 'name', 'reply_text', 'pending_question', 'waiting_since', 'lease_owner', 'lease_until',
  'long_running_notified_at', 'running_since', 'wait_contact_lost_notified_at',
];

/** v5 及更早的终态列（v6 重建必须删掉；出现任一 = 需要迁移）。 */
const PRE_ZERO_STATE_TERMINAL_COLUMNS: readonly string[] = [
  'died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at', 'round_failed_at', 'cancel_requested_at',
];

/**
 * v5 及更早的「已停」status 值（只用于**迁移 / 只读投影**判断旧行停没停：
 * 不持久化种类、不写进新库）。不在此列 = 未停：queued / running / waiting_user /
 * cancelling / accepted —— 它们要么还在跑、要么还能接续、要么要交给启动恢复。
 */
const PRE_ZERO_STOPPED_STATUSES: readonly string[] = [
  'completed', 'failed', 'cancelled', 'canceled', 'timed_out', 'resource_limited',
  'died', 'round_failed', 'unexecuted', 'failed_confirmed',
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
  long_running_notified_at?: string | null;
  wait_contact_lost_notified_at?: string | null;
  running_since?: string | null;
  created_at: string;
  updated_at: string;
  /**
   * 旧 v5 终态列（只读打开未迁移的旧库时仍在；可写打开会迁移掉）。只读读取投影据它们
   * 还原终止事实——不写库、不建事件账。
   */
  cancelled_at?: string | null;
  timed_out_at?: string | null;
  resource_limited_at?: string | null;
  died_at?: string | null;
  round_failed_at?: string | null;
}

interface TaskEndDbRow {
  task_id: string;
  at: string;
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

/** v6 迁移谓词：tasks 表已存在且仍是旧形状（带结论列或六个终态列）——需要重建为零状态形状。 */
function tasksTableNeedsRebuild(db: Database.Database): boolean {
  const columns = taskTableColumns(db);
  return columns.size > 0
    && (columns.has('status') || PRE_ZERO_STATE_TERMINAL_COLUMNS.some((column) => columns.has(column)));
}

/**
 * v6 tasks 表重建：旧表（v5 及更早）→ 事实形状。
 *
 * 「结论」列（status/reason/failure_reason）与六个终态列不迁移到任务行（不存状态）；
 * 只把**升级前已停下**的旧行当已结束：
 *   · running_since 按 updated_at 回填（极旧库缺列时），避免迁移后被当作未启动重新认领；
 *   · 已停的行写**一条结束事实**（task_ends：task_id + at，**不带种类**）：at = 匹配到的旧
 *     终态列原时刻（旧 schema 列顺序：cancelled_at → timed_out_at → resource_limited_at →
 *     died_at → round_failed_at（旧 schema 列顺序），或旧 status 属于已停集合，或已有汇报；都没有才回退
 *     updated_at。怎么结束不迁移——旧结论词不进入新库；**等待形状不清**（提案的句柄/摘要/
 *     写入参数只在 pending_question 上，删了就没有「用户被要求批准的那一次写」的记录）。
 *   · 仍在等待（pending_question 非空、无旧终态、无汇报）或旧 status=running/cancelling 的行
 *     **不写**结束事实：提问保留、running_since 回填后进入既有续跑 / 重启对账 / 取消路径
 *     （写死会让它们既不能答也不能停，或在跑行被静默写成已停、用户收不到「结果未知」）。
 *   · **升级前从未启动的排队行也不写**结束事实：它是已受理、还没开跑的工作，基线语义就是
 *     重启后由 pump 认领（claimNextUnstarted 只收 running_since 为空的行）。写成已停会让这份
 *     交办既不再执行、也没有「结果未知」出口，用户永远收不到告知；running_since 保持 NULL。
 * 逐列按旧表实际列存在性取源（极旧库缺列取 NULL），历史行其余事实原样搬运。
 */
function rebuildTasksToZeroState(db: Database.Database): void {
  const oldColumns = taskTableColumns(db);
  const sourceOf = (column: string): string =>
    oldColumns.has(column) ? `"${column}"` : 'NULL';

  // 结束时刻 = 匹配到的旧终态列原时刻（与旧代码同一优先级）；该列为 NULL / 旧库无该列时
  // 回退 updated_at（v4 及更早只有 status，没有独立时刻可读）。
  const terminalTimestampColumns = [
    'cancelled_at', 'timed_out_at', 'resource_limited_at', 'died_at', 'round_failed_at',
  ].filter((column) => oldColumns.has(column));
  const atExpr = terminalTimestampColumns.length === 0
    ? '"updated_at"'
    : `CASE ${terminalTimestampColumns.map((column) => `WHEN "${column}" IS NOT NULL THEN "${column}"`).join(' ')} ELSE "updated_at" END`;
  // 「升级前已停下」：旧终态列非空 / 旧 status 属已停集合 / 已有汇报存档 / 从未启动且没有提问。
  // 只用于决定迁移时写不写结束事实与留不留等待形状，不持久化任何种类。
  const endedBeforeExpr = [
    ...terminalTimestampColumns.map((column) => `"${column}" IS NOT NULL`),
    ...(oldColumns.has('status')
      ? [`"status" IN (${PRE_ZERO_STOPPED_STATUSES.map((status) => `'${status}'`).join(', ')})`]
      : []),
  ].join(' OR ') || '0';
  const reportedExpr = TASK_PROGRESS_REPORT_FIELDS
    .filter((field) => oldColumns.has(field.column))
    .map((field) => `TRIM(COALESCE("${field.column}", '')) <> ''`)
    .join(' OR ') || '0';
  // 「升级前已启动」：旧 running_since 非空，或旧 status 是在跑/取消中（v4 没有 running_since 列，
  // 只能靠 status 判断）。用来区分「在跑的行」与「从未启动的排队行」——后者零执行，
  // 不能走「结果未知」的恢复告知（那是假话），只能当「未启动即已停」。
  // 列名走 task-progress 的单一来源（本模块不另写列名）；这是**迁移期读旧表**的判据，
  // 与运行期的「仍在推进」谓词不是一回事（后者只作用于当前 schema）。
  const startedSignals = [
    ...(oldColumns.has(TASK_PROGRESS_STARTED_COLUMN.column)
      ? [`"${TASK_PROGRESS_STARTED_COLUMN.column}" IS NOT NULL`]
      : []),
    ...(oldColumns.has('status')
      ? [`COALESCE("status", '') IN ('running', 'cancelling', 'waiting_user')`]
      : []),
  ];
  const startedBeforeExpr = startedSignals.length > 0 ? `(${startedSignals.join(' OR ')})` : '0';
  const questionPresentExpr = oldColumns.has('pending_question')
    ? `COALESCE("pending_question", '') <> ''`
    : '0';
  // 「升级前已停下」= 旧终态列 / 旧 status 属已停集合 / 已有汇报存档。
  // **不含「未启动」**：未启动且无提问的 queued 行是已受理、还没开跑的工作——基线语义就是
  // 重启后由 pump 认领（`claimQueued`）。把它写成结束事实，升级后这份交办既不会被执行、
  // 也没有「结果未知」出口（listRunningExpiredLeases 不收 running_since 为空的行），
  // 用户永远收不到告知（2026-11-24 grok blocking）。它继续排队即可。
  const hadStoppedExpr = `(${endedBeforeExpr}) OR (${reportedExpr})`;
  // 升级前已启动、没有提问、没有结束事实、没有 accepted 在途的行：给一条**已过期**的迁移租约，
  // 让启动恢复（expireLeases）按既有「租约过期 → 结束事实（结果未知）」路径收尾并通知用户，
  // 而不是静默写成已停、也不是永远挂着。从未启动的排队行**不给**（零执行，说「结果未知」是假话）。
  const syntheticLeaseExpr = `${startedBeforeExpr} AND NOT (${questionPresentExpr})`
    + ' AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = "tasks".task_id)'
    + ' AND NOT EXISTS (SELECT 1 FROM executions x WHERE x.task_id = "tasks".task_id AND x.status = \'accepted\')';

  const columnList = TASKS_V6_COLUMNS.map((column) => `"${column}"`).join(', ');
  const selectList = TASKS_V6_COLUMNS.map((column) => {
    if (column === 'running_since') {
      // 升级前**已启动且未停**的行回填 updated_at（迁移后不再被当未启动认领，交给恢复路径）；
      // 升级前已停的行与从未启动的排队行保持原值——NULL = 还没开跑，迁移后继续排队
      // （`claimNextUnstarted` 要求 running_since IS NULL 且无结束事实）。
      return `CASE WHEN ${hadStoppedExpr} OR NOT (${startedBeforeExpr}) THEN ${sourceOf('running_since')}`
        + ` ELSE COALESCE(${sourceOf('running_since')}, "updated_at") END AS "running_since"`;
    }
    if (column === 'pending_question' || column === 'waiting_since') {
      // **不清等待形状**（2026-11-24 grok blocking，与运行时 appendEndFact 回退后同口径）：
      // 提案（句柄/摘要/写入参数）只存在于 pending_question 上，执行行不带它——旧库里
      // 「已停但仍有提案」的行（用户被问到确认、随后超时/取消）若被清字段，底账就失去
      // 「用户被要求批准的那次写」的记录。可执行性由谓词决定，不由删数据决定。
      return `${sourceOf(column)} AS "${column}"`;
    }
    if (column === 'lease_owner' || column === 'lease_until') {
      const synthetic = column === 'lease_owner' ? `'migration'` : '"updated_at"';
      return `CASE WHEN ${syntheticLeaseExpr} THEN ${synthetic} ELSE ${sourceOf(column)} END AS "${column}"`;
    }
    return `${sourceOf(column)} AS "${column}"`;
  }).join(', ');
  // 重建期间关外键（executions REFERENCES tasks(task_id)；DROP tasks 需要临时解除），
  // 结束后恢复。整段重建包在**一个事务**里（SQLite 的 DDL 是事务性的）：中途任一步失败
  //（进程被杀 / 磁盘满 / 残留 tasks_v6 冲突）必须整体回滚——绝不能出现「DROP 已提交、
  // RENAME 没跑」把旧账丢在无人读取的 tasks_v6、下次启动又建出空表的假迁移
  //（2026-11-23 review blocking）。注：PRAGMA foreign_keys 在事务内是 no-op，故开关都在事务外。
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // 先确保 task_ends 存在（SCHEMA_BASE 的 CREATE IF NOT EXISTS；tasks 已存在时是 no-op）。
      db.exec(SCHEMA_BASE);
      db.exec(`
        INSERT OR IGNORE INTO task_ends (task_id, at)
        SELECT "task_id", ${atExpr} FROM "tasks" WHERE ${hadStoppedExpr};
        CREATE TABLE tasks_v6 (${TASKS_V6_COLUMNS.map((column) =>
          `"${column}" ${TASKS_V6_BUILD_COLUMN_SHAPES[column]}`).join(', ')});
        INSERT INTO tasks_v6 (${columnList}) SELECT ${selectList} FROM "tasks";
        DROP TABLE "tasks";
        ALTER TABLE tasks_v6 RENAME TO "tasks";
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * v7 结束事实去种类：v6 的 task_events（task_id, kind, at, state_version）→ task_ends
 * （task_id, at）。旧 kind 列**丢弃**——「怎么结束」不再持久化；同任务保留最早一条时刻。
 */
function migrateTaskEventsToEnds(db: Database.Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_BASE); // 建出 task_ends（IF NOT EXISTS）
    db.exec(`
      INSERT OR IGNORE INTO task_ends (task_id, at)
      SELECT task_id, MIN(at) FROM task_events GROUP BY task_id;
      DROP TABLE task_events;
    `);
  })();
}

/** v7 迁移谓词：库里有 v6 的 task_events（带 kind 的旧事件账）。 */
function taskEventsTablePresent(db: Database.Database): boolean {
  return tableColumnsOf(db, 'task_events').size > 0;
}

/** v6 tasks 表的列形状（重建用；与 SCHEMA_BASE 的 tasks 定义一致）。 */
const TASKS_V6_BUILD_COLUMN_SHAPES: Readonly<Record<string, string>> = {
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
 * 命名 = <dbPath>.backup-v<迁移目标版本>（当前 schema 版本（TASK_STORE_SCHEMA_VERSION））；`:memory:` 与库文件不存在不生成；
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
        // 零状态（v6）：旧形状 tasks（带结论列/六个终态列）→ 重建为只存事实的形状。
        const needsV6Rebuild = tasksTableNeedsRebuild(writable);
        // v7：v6 的 task_events（带 kind）→ task_ends（只留停下时刻，丢掉种类）。
        const needsV7EndFacts = taskEventsTablePresent(writable);
        if (needsV6Rebuild || needsV7EndFacts || operationsMissing || fileRefTaskMissing || fileRefDeliverableMissing) {
          // 旧库迁移：先备份（目标版本命名），再重建/加列，再（仅缺 task_no 时）回填编号，
          // 最后建唯一索引与版本号。共用同一次备份（同一目标版本 v7；已有备份保留最早副本）。
          backupBeforeMigration(writable, dbPath);
          if (needsV6Rebuild) rebuildTasksToZeroState(writable);
          if (needsV7EndFacts) migrateTaskEventsToEnds(writable);
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
        if (needsV6Rebuild && !columns.has('task_no')) {
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
  // 零状态事实列（旧库只读未迁移时缺失 → 对应写方法确定性拒绝、读扫描返回空）。
  const hasFactColumns = columns.has('pending_question')
    && columns.has('waiting_since')
    && columns.has('lease_owner')
    && columns.has('lease_until')
    && columns.has('running_since');
  // 结束事实账（追加事实；旧库只读缺表 = 没有结束事实可读）。
  // 只读打开 v6 旧库（task_events 带 kind）时读 at 列（kind 不参与），可写打开会迁移；
  // 旧库只读没有 task_ends：写语句与在跑扫描不 prepare（给确定性拒绝/空集），读取投影走
  // task_events.at。
  const hasTaskEnds = tableColumnsOf(db, 'task_ends').size > 0;
  const hasV6TaskEvents = tableColumnsOf(db, 'task_events').size > 0;
  const zeroStateReady = hasFactColumns && hasTaskEnds;
  const allocateTaskNo = hasTaskNoColumn
    ? db.prepare("UPDATE task_sequences SET value = value + 1 WHERE name = 'task_no' RETURNING value")
    : undefined;
  // 插入语句含 running_since 列——只在两列都存在（已迁移）的库上 prepare；
  // 旧形状只读打开时保持 undefined（写入给确定性拒绝，prepare 不崩）。
  const insertTaskStmt = hasTaskNoColumn && zeroStateReady
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
  // 结束事实 = **追加事实**（task_ends；同任务至多一条），不是 tasks 的可变状态列。
  // 写事务（BEGIN IMMEDIATE）：先看同任务有无结束事实 → 无则追加一条 + 清租约。
  const endFactSource = hasTaskEnds ? 'task_ends' : (hasV6TaskEvents ? 'task_events' : undefined);
  const hasEndFactStmt = endFactSource !== undefined
    ? db.prepare(`SELECT 1 AS present FROM ${endFactSource} WHERE task_id = ? LIMIT 1`)
    : undefined;
  const insertEndFactStmt = hasTaskEnds
    ? db.prepare(`
        INSERT INTO task_ends (task_id, at)
        VALUES (@taskId, @at)
        ON CONFLICT(task_id) DO NOTHING
      `)
    : undefined;
  const clearLeaseAfterEnd = hasFactColumns
    ? db.prepare(`
        UPDATE tasks SET lease_owner = NULL, lease_until = NULL, updated_at = @updatedAt
        WHERE task_id = @taskId
      `)
    : undefined;
  // 结束事实**不删等待形状**（2026-11-24 grok blocking 回退）：提案（句柄/摘要/写入参数）
  // 只存在于 pending_question 上，执行行不带它——等待超时/用户取消后清掉字段，底账就失去
  // 「用户被要求批准的那次写」的完整记录。可执行性由谓词决定，不由删数据决定：
  // `taskWaitingOf` 已要求 endedAt 缺省才算等待（结束的行不再显示「等待用户」、redo 放行、
  // resume/confirm 被结束事实拒绝），所以不需要靠清字段来消除死角。
  const appendEndFactTx = hasEndFactStmt !== undefined
    && insertEndFactStmt !== undefined
    && clearLeaseAfterEnd !== undefined
    ? db.transaction((input: TaskEndWrite): boolean => {
        if (hasEndFactStmt.get(input.taskId) !== undefined) return false;
        if (insertEndFactStmt.run(input).changes === 0) return false;
        clearLeaseAfterEnd.run({ taskId: input.taskId, updatedAt: input.updatedAt });
        return true;
      })
    : undefined;
  const setWaitingStmt = zeroStateReady
    ? db.prepare(`
        UPDATE tasks
        SET pending_question = @pendingQuestionJson,
            waiting_since = @waitingSince,
            updated_at = @updatedAt
        WHERE task_id = @taskId
          AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = tasks.task_id)
      `)
    : undefined;
  const armLeaseStmt = zeroStateReady
    ? db.prepare(`
        UPDATE tasks
        SET lease_owner = @owner,
            lease_until = @leaseUntil,
            running_since = COALESCE(running_since, @updatedAt),
            updated_at = @updatedAt
        WHERE task_id = @taskId
          AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = tasks.task_id)
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
  // 认领条件 = 未启动（running_since NULL）且无终止事件。
  const selectOldestUnstarted = zeroStateReady
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE running_since IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = tasks.task_id)
        ORDER BY created_at, task_id LIMIT 1
      `)
    : undefined;
  // 过期租约候选：只取「仍在推进」的行（唯一谓词：无汇报/等待/终止事件）。
  const selectExpiredLeases = zeroStateReady
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE lease_until IS NOT NULL AND lease_until <= ?
          AND (${stillProgressingSqlWhere()})
        ORDER BY created_at, task_id
      `)
    : undefined;
  // 在跑行（长时间提醒扫描；含长任务等待回执的行）：唯一谓词（已启动 + 无汇报/等待/终止事件）。
  // SQL 与 TS 判定由同一份列清单/事件清单派生（@fshine/core task-progress），不许在这里手写。
  const selectRunningTasks = zeroStateReady
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE ${stillProgressingSqlWhere()}
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
  // 结束事实读取：新库读 task_ends；只读打开 v6 旧库（未迁移）读 task_events 的 at（kind 不参与）。
  const selectEndFacts = hasTaskEnds
    ? db.prepare('SELECT task_id, at FROM task_ends WHERE task_id = ?')
    : hasV6TaskEvents
      ? db.prepare('SELECT task_id, at FROM task_events WHERE task_id = ? ORDER BY seq')
      : undefined;
  /**
   * 只读打开**未迁移的旧库**（tasks 仍是旧形状、没有结束事实账）时，把仍在的旧终态列
   * 还原成「停下时刻」交给读取投影（只取 at，不还原任何种类），不写库、不建表。优先级
   * 旧 schema 列顺序：cancelled_at → timed_out_at → resource_limited_at → died_at → round_failed_at。
   * 有结束事实账（已是 v6/v7 / 可写打开已迁移）时事实账优先，本合成不生效。
   */
  const PRE_ZERO_STATE_END_SOURCES = [
    'cancelled_at', 'timed_out_at', 'resource_limited_at', 'died_at', 'round_failed_at',
  ] as const;
  const preZeroStateEndSources = selectEndFacts === undefined
    ? PRE_ZERO_STATE_END_SOURCES.filter((column) => columns.has(column))
    : [];
  const preZeroStateEndOf = (row: TaskDbRow): TaskEndRow | undefined => {
    for (const column of preZeroStateEndSources) {
      const at = row[column];
      if (typeof at === 'string' && at !== '') {
        return { taskId: row.task_id, at };
      }
    }
    // v4 没有终态时刻列：停过的信号只在旧 status 里（只取「停了没」，不还原种类）。
    if (selectEndFacts === undefined && columns.has('status')) {
      const status = (row as unknown as Record<string, unknown>)['status'];
      if (typeof status === 'string' && PRE_ZERO_STOPPED_STATUSES.includes(status)) {
        return { taskId: row.task_id, at: row.updated_at };
      }
    }
    return undefined;
  };
  const endsOf = (row: TaskDbRow): TaskEndRow[] => {
    if (selectEndFacts !== undefined) {
      return (selectEndFacts.all(row.task_id) as TaskEndDbRow[]).map(toEndFact);
    }
    const end = preZeroStateEndOf(row);
    return end === undefined ? [] : [end];
  };
  const selectTasks = db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id');
  const selectTasksScoped = db.prepare(
    'SELECT * FROM tasks WHERE principal_id = ? AND session_id = ? ORDER BY created_at, task_id',
  );
  /** 按 scope 取等待行（2026-11-19：交办前的「有没有待确认提案」检查必须走索引，不能全表）。 */
  const selectWaitingScoped = zeroStateReady
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE principal_id = ? AND session_id = ? AND pending_question IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = tasks.task_id)
        ORDER BY created_at, task_id
      `)
    : undefined;
  const selectWaitingAll = zeroStateReady
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE pending_question IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM task_ends e WHERE e.task_id = tasks.task_id)
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

  const toEndFact = (row: TaskEndDbRow): TaskEndRow => ({
    taskId: row.task_id,
    at: row.at,
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
    // 结束事实账优先；旧形状只读库由仍在的旧终态列合成时刻（不写库、不还原种类）。
    ends: endsOf(row),
  });

  const missingFactColumnsError =
    '任务底账是旧版 schema（缺零状态事实列/结束事实账）且以只读打开：不能写任务事实（请先用可写入口完成迁移）。';
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
    appendEndFact(write) {
      if (appendEndFactTx === undefined) throw new Error(missingFactColumnsError);
      return (appendEndFactTx as unknown as { immediate: (input: TaskEndWrite) => boolean })
        .immediate(write);
    },
    listEndFacts(taskId) {
      if (selectEndFacts !== undefined) {
        return (selectEndFacts.all(taskId) as TaskEndDbRow[]).map(toEndFact);
      }
      // 旧形状只读库没有结束事实账：与 storedTask 同源，从仍在的旧终态列还原时刻（不写库）。
      const row = selectTask.get(taskId) as TaskDbRow | undefined;
      if (row === undefined) return [];
      const end = preZeroStateEndOf(row);
      return end === undefined ? [] : [end];
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
