/**
 * 任务归属底账 + 守护事实（B 类：任务归属与存活，最小形状）。
 *
 * 为什么需要它：委派任务必须绑定发起它的可信身份与会话，事后按业务查询时，
 * 越权（换一个 principal/session）必须被确定性拒绝。可信身份来自装配层的
 * principalId/sessionId（配置与渠道事实），**不接受模型输入**。
 *
 * S1 事实模型（docs/design/task-redefinition.md，2026-11-22）：task 没有 status。
 * 底账只记两件真东西：
 *   · worker 汇报（语义）：resultText（完成汇报）/ replyText（Main 最终回复存档）/ 逐笔执行行；
 *   · 宿主守护事实（机械）：归属（taskId/principalId/sessionId）+ 存活（waiting_user /
 *     running / died，由等待形状、租约与看门狗推导，见 {@link taskLivenessOf}）+
 *     claimed→resulted 幂等账（operations 表，行就是身份）+ 四个一次性机械时刻
 *     （diedAt/cancelledAt/timedOutAt/resourceLimitedAt）。
 * 没有任何「结论」字段（旧 status/reason/failureReason 已删）：做没做成读执行行与汇报，
 * 不在底账上写总结论；任务收尾不再走转换矩阵。
 *
 * U3 稳定逻辑操作身份（2026-11-16，仅追加，不新建第二套 Registry）：
 *   · 在**现有**底账上增加一张 operations 账（内存实现用 Map，SQLite 实现用 operations 表），
 *     行就是身份：dispatch_key 主键 + UNIQUE(scope_key, op_seq)，**没有**任何以
 *     (operation, args) 为键的唯一约束——参数完全相同的两笔合法操作必须是两行、各执行一次；
 *   · 铸造点唯一：首次创建逻辑操作时分配 op_seq 并落库；重试/重规划只读回同一行；
 *   · 认领与写事实都是原子的：读候选 → 纯函数决策 → 写，在 registry 侧一次完成
 *     （SQLite 实现包在 BEGIN IMMEDIATE 写事务里）；进行中的重复请求返回 in_progress，
 *     不发起第二次执行；
 *   · 证明不了新调用属于已有操作 → unresolved（停止副作用，交由调用方如实告知），
 *     不猜绑定；读操作（装配方声明的只读集合）可安全重发，不被 key 逻辑误挡。
 *
 * 这里不做的（登记缺口，不在这里预造）：
 *   · 通用 Exactly Once：宿主只承诺「同一身份至多一次自动执行 + 结果未知可核对」，
 *     外部幂等键/状态查询/回读归执行层；
 *   · 事件流/订阅体系：事实钩子只做单回调注入（供通知/采集），不持久化事件。
 *
 * 拒绝路径（回归锁，见 runtime.test.ts）：换 principal 或换 session 取任务
 * 一律 TaskOwnershipError；取不存在的任务与越权同一错误（不泄漏任务是否存在）。
 */
import type { ExecutionFailure, ExecutionOutcome, ExecutionStatus } from '@fshine/contracts/execution-contract';
import {
  stillProgressingOf,
  taskAcceptedInFlightOf,
  taskEndedOf,
  taskUnstartedOf,
} from '@fshine/core';

/** 存活/推进判定与底账扫描共用的唯一谓词（实现在 @fshine/core 的 task-progress；此处只转出）。 */
export {
  stillProgressingOf,
  taskEndedOf,
  taskProgressEndedOf,
  taskReportedOf,
  taskStartedOf,
  taskUnstartedOf,
  taskAcceptedInFlightOf,
} from '@fshine/core';

/**（历史注记）宿主脚本工具的操作名常量与 inline 终局判定已随 S1 一并删除：执行端回合只记事实，不判业务终局。 */

/** waiting_user 的机械问题形状（执行层 needs_input 事实；不编造、不改写候选）。 */
export interface PendingQuestion {
  missing: readonly string[];
  candidates?: readonly string[];
  raw?: string;
  /** 写操作提案（可选）：needs_confirmation 与 needs_input 同走等待事实，不另立状态。 */
  confirmation?: PendingConfirmation;
}

/**
 * 写操作提案的机械形状（执行层 needs_confirmation 事实；原样承载，不解释、不裁决）。
 * handle 是执行层发放的确认凭据：留底账供后续回合透传，**不进模型/用户可见投影**
 * （execution-runtime 的 toModelVisibleOutcome / pendingQuestionView 负责剥离）。
 */
export interface PendingConfirmation {
  /** 执行层发放的确认句柄（非空；宿主持有）。 */
  handle: string;
  /** 机械摘要（可展示；非空）。 */
  summary: string;
  expiresAt?: string;
  /** 提案所属 operation（执行事实原样；接续透传时用）。 */
  operation: string;
  /**
   * 提案调用的参数**原文**（不透明数据：宿主不解析业务字段、不改写、不补——与句柄同一条
   * 底账记录，不另建表）。2026-11-19 live 修复（确认后续跑 Worker 是新会话、没有转录）：
   * 只给摘要时 Worker 只能从人话摘要重编参数，与执行层绑定校验相撞（摘要超 10 条被截断 →
   * 漏 --records → CONFIRMATION_BINDING_MISMATCH）；确认续跑时这份参数原样交回 Worker。
   * 缺省 = 旧记录（无参数可交回；渲染端不编造）。
   */
  args?: Record<string, unknown>;
}

/** 机械事实事件（通知/采集消费；每次机械事实写入一条）。 */
export type TaskEventKind =
  | 'queued'          // 受理（后台排队）
  | 'started'         // 开始跑（inline 建行 / 队列认领）
  | 'resumed'         // 等待接续（答复/确认后新回合）
  | 'waiting_user'    // 进入等待（needs_input / 待确认提案）
  | 'result_archived' // worker 汇报存档（完成事实）
  | 'cancelled'       // 用户取消确认
  | 'timed_out'       // 机械超时（等待到期 / 回合超时 / 排队超时）
  | 'died'            // 看门狗观察到租约过期（结果未知）
  | 'resource_limited' // 资源拒绝
  | 'round_failed';   // 回合失败事实（无汇报收尾/抛错/结果未知；通知与唤醒面的事实源）

/** 一条机械事实（供通知/采集，非事件总线）。 */
export interface TaskFact {
  taskId: string;
  taskNo: number;
  name: string;
  event: TaskEventKind;
  at: string;
  /** 稳定去重版本（通知 outbox 唯一键第三段）；缺省 = at。 */
  stateVersion?: string | number;
}

export type TaskFactHook = (fact: TaskFact) => void;

/** 机械命名默认上限（字符；超长截断加省略号）。 */
const TASK_NAME_MAX = 40;

/**
 * 业务名称 v1（机械回落，零模型、确定性）：取任务交办原文首个空行之前的段落，
 * 空白折叠为单行，超 maxLength 字符截断加「…」；原文无内容给机械占位。
 * 单一来源（新行写入 / 历史行 NULL 显示回落 / 旧库回填口径都用本函数）。
 */
export function deriveTaskName(request: string, maxLength: number = TASK_NAME_MAX): string {
  const firstParagraph = request.split(/\n[ \t]*\n/)[0] ?? '';
  const single = firstParagraph.replace(/\s+/g, ' ').trim();
  if (single === '') return '未命名任务';
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single;
}

/** 一次已发起的执行调用（requestId 由宿主持有，模型不可见）。 */
export interface ExecutionRecord {
  requestId: string;
  operation: string;
  status: ExecutionStatus;
  error?: ExecutionFailure;
  /** U3：这次真实执行所属的稳定逻辑操作身份（回放不写执行行，故回放不产生新记录）。 */
  dispatchKey?: string;
}

/** 机械超时种类（等待到期 / 回合超时 / 排队超时）。 */
export type TimeoutKind = 'queued' | 'execution' | 'waiting_user';

/**
 * 存活事实的输入投影（内存 TaskRecord 与 SQLite 读回行共用；pendingQuestion 只判有无）。
 * executions 只读末条 status（判断「已受理、等回执」的长任务：末条 = accepted）；缺省 = 无执行行
 * （旧调用面不传也算合法）。resultText/replyText 只判有无汇报存档（长任务完成后汇报走
 * archiveReply，续跑成功不追加执行行——末条仍是 accepted）。
 */
export type TaskLivenessFacts = Pick<
  TaskRecord,
  'leaseOwner' | 'leaseUntil' | 'diedAt' | 'cancelledAt' | 'timedOutAt' | 'resourceLimitedAt'
  | 'roundFailedAt' | 'runningSince'
> & {
  pendingQuestion?: unknown;
  executions?: readonly { status: string }[];
  resultText?: string;
  replyText?: string;
};

/** 存活（守护事实）：waiting_user / running / died；undefined = 未启动或已收尾（读执行行与汇报分辨）。 */
export type TaskLiveness = 'running' | 'died' | 'waiting_user';

/**
 * 存活推导（纯函数；只看机械事实，不做任何业务判定）：
 *   · 已有结束事实（cancelled/timed_out/resource_limited）→ undefined（已收尾，不翻案）；
 *   · diedAt → died（结果未知）；
 *   · 等待形状 → waiting_user；
 *   · 本轮已停（round_failed_at / 汇报存档）→ undefined——租约残留也不翻案；
 *   · 仍在推进（唯一谓词 {@link stillProgressingOf}）时：有效租约 → running，租约已过期 → died；
 *     末条执行 = accepted 且无汇报存档（长任务已受理、等回执）→ running；
 *   · 其余（未启动）→ undefined。
 */
export function taskLivenessOf(task: TaskLivenessFacts, now: string = new Date().toISOString()): TaskLiveness | undefined {
  // 结束事实（取消/超时/资源拒绝）不翻案；结果未知（died）仍是 liveness 三值之一。
  if (task.cancelledAt !== undefined || task.timedOutAt !== undefined || task.resourceLimitedAt !== undefined) {
    return undefined;
  }
  if (task.diedAt !== undefined) return 'died';
  if (task.pendingQuestion !== undefined) return 'waiting_user';
  // 唯一谓词：已汇报 / round_failed（本轮已停）的行不是 running（租约残留也不翻案）。
  if (!stillProgressingOf(task)) return undefined;
  if (task.leaseUntil !== undefined) return task.leaseUntil > now ? 'running' : 'died';
  // 长任务「已受理、等回执」（2026-11-22 Grok 复审）：受理时租约被释放，末条执行 = accepted。
  // 任务是活的（等回执），不是「未启动/已收尾」——投影为 running（旧 status='running' 语义）。
  if (taskAcceptedInFlightOf(task)) return 'running';
  return undefined;
}

/** 一条最小任务底账：归属 + 机械事实 + 汇报存档 + 执行调用清单（无结论字段）。 */
export interface TaskRecord {
  taskId: string;
  principalId: string;
  sessionId: string;
  /** 委派原文（任务请求；审计与结果解释用；业务名称的机械来源）。 */
  request: string;
  /** worker 完成汇报（inline 收尾逐字存档；后台完成经 archiveReply 同义存档面）。 */
  resultText?: string;
  /** P1：本回合 Main 最终回复全文（同回合各任务行同值；缺省=无最终回复存档）。 */
  replyText?: string;
  /** 等待事实：待用户补齐的问题/待确认提案（原样持久化；答复后清除，收尾后保留为历史）。 */
  pendingQuestion?: PendingQuestion;
  /** 进入等待的时刻（ISO）。 */
  waitingSince?: string;
  /** 存活事实：在跑租约（认领/接续回合持有；结束事实写入时清空）。 */
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
  /** 用户取消**请求**的时刻（ISO；一次性；请求 ≠ 确认——确认才写 cancelledAt）。 */
  cancelRequestedAt?: string;
  /** P1：数字任务编号（底账分配，唯一、不复用；旧库只读/未迁移时缺省）。 */
  taskNo?: number;
  /** P1：业务名称（新行=机械回落写入；历史行缺省，显示层同规则回落）。 */
  name?: string;
  /** 本轮开始运行的时刻（ISO，单调写一次）；NULL = 未跑过（未启动，可被认领）。 */
  runningSince?: string;
  /**
   * 本轮以无结果收尾（回合失败/无汇报）的时刻（ISO，一次性）。不是业务结论、不改失败归类
   * （无汇报 ≠ 结果未知）；只表示这一轮已停——长时间提醒扫描据此不再把已收尾的任务当「在跑」。
   */
  roundFailedAt?: string;
  /** 已发过「久无动静」提醒的时刻（ISO；每档只写一次，重启不重发）。 */
  longRunningNotifiedAt?: string;
  /** 长任务等待「与执行层断了联系（无回执）」已告知过用户的时刻（ISO；每档只写一次）。 */
  waitContactLostNotifiedAt?: string;
  executions: readonly ExecutionRecord[];
  createdAt: string;
  updatedAt: string;
}

/** 任务归属校验失败：越权与不存在同一错误，不泄漏存在性。 */
export class TaskOwnershipError extends Error {
  constructor() {
    super('任务不存在或不属于当前会话。');
    this.name = 'TaskOwnershipError';
  }
}

/**
 * 机械事实写入被拒：任务已有结束事实（不翻案）或并发下事实已被写入。
 * 携带已有事实，供调用方如实收尾（不是错误恢复点——事实已经发生）。
 */
export class TaskSettledError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`任务已收尾，事实不翻案：${taskId}。`);
    this.name = 'TaskSettledError';
    this.taskId = taskId;
  }
}

export interface TaskScope {
  principalId: string;
  sessionId: string;
}

/** 事实变更方法的公共选项：给出 scope 时先校验归属（越权与不存在同错）。 */
export interface MutationOptions {
  scope?: TaskScope;
}

/** 逻辑操作账的状态集（U3 + 长任务 v4）。completed/needs_confirmation/needs_input/failed/
 * refused 与执行结果同态；accepted = 执行层已受理长任务（operationId 在 outcome 里），
 * 等待宿主用 wait 推进；claimed = 已认领未落定；unknown = 结果未知（待核对，禁止自动重放）。
 * needs_confirmation 只是执行层返回的机械事实：宿主把它记进账行，不代表宿主裁决确认。
 */
export const OPERATION_STATUSES = ['claimed', 'accepted', 'completed', 'needs_confirmation', 'needs_input', 'failed', 'refused', 'unknown'] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** 一条逻辑操作账行（对外只读视图；行就是身份）。 */
export interface OperationRecord {
  /** 身份键（首次创建时铸造并落库；此后只读）——格式 `dk_<scopeKey>:<opSeq>`。 */
  dispatchKey: string;
  /** 身份作用域：'task:<taskId>'（交办内操作）或 'turn:<sessionId>:<turnNo>'（Main task_run）。 */
  scopeKey: string;
  /** 交办内操作的 taskId；turn 作用域在受理回执落定后回填。 */
  taskId?: string;
  opSeq: number;
  operation: string;
  status: OperationStatus;
  /** 待核对/中断的机械原因（可空）。 */
  reason?: string;
  /** 执行层原始 outcome（completed 时即「已有结果」）。 */
  outcome?: ExecutionOutcome;
  /** 认领时所在的运行时回合号（重放窗口判定）。 */
  attempt: number;
  claimedAt: string;
  settledAt?: string;
  /**
   * 结果落定并交给 Pi 回合的时刻（settle 时与 settledAt 同刻写入）。
   * 它**不**证明模型已读取结果；NULL = 尚未落定/未交付（claimed 或 unknown 行）。
   */
  deliveredAt?: string;
  replayOf?: string;
}

/**
 * 认领请求：**没有 args 字段**（结构性保证：不存在按参数文本/哈希去重绑定的代码路径）。
 */
export interface OperationClaimInput {
  scopeKey: string;
  operation: string;
  /** 本次运行时回合号（由宿主按驱动事件推进；模型不可提供）。 */
  attempt: number;
  /** 被运行时丢弃的那次尝试的回合号；给出即「有重放窗口」。 */
  replayWindow?: number;
  /** 读操作（装配方声明的只读集合）：只在读路径为 true；重试可安全重发。 */
  readOnly?: boolean;
  /** 显式携带已持久化身份（只用于读回同一条记录，不接受现造的新键）。 */
  dispatchKey?: string;
  taskId?: string;
  now?: string;
}

/** 认领结果（五态互斥；in_progress/unresolved/conflict 都**不产生**任何新副作用）。 */
export type OperationClaim =
  | { kind: 'minted'; dispatchKey: string; opSeq: number; reclaimed: boolean }
  | { kind: 'replayed'; dispatchKey: string; opSeq: number; outcome: ExecutionOutcome }
  | { kind: 'in_progress'; dispatchKey: string; opSeq: number; claimedAt: string }
  | { kind: 'unresolved'; reason: 'ambiguous_replay' | 'prior_unknown'; dispatchKey?: string }
  | { kind: 'conflict'; reason: 'operation_mismatch'; dispatchKey: string };

/** 同一身份对应不同 operation：确定性拒绝（零副作用，行不改；code 供码级判据读取）。 */
export class DispatchConflictError extends Error {
  readonly code = 'dispatch_conflict';
  readonly dispatchKey: string;

  constructor(dispatchKey: string) {
    super('同一逻辑操作身份对应了不同的 operation：已拒绝本次执行（dispatch_conflict）。');
    this.name = 'DispatchConflictError';
    this.dispatchKey = dispatchKey;
  }
}

/** 认领决策（纯函数产出；两个实现共用同一语义）。 */
export type OperationClaimDecision =
  | { action: 'mint' }
  | { action: 'reclaim'; row: OperationRecord }
  | { action: 'replay'; row: OperationRecord }
  | { action: 'in_progress'; row: OperationRecord }
  | { action: 'unresolved'; reason: 'ambiguous_replay' | 'prior_unknown'; rows: readonly OperationRecord[] }
  | { action: 'conflict'; row: OperationRecord };

/**
 * 重绑定决策（内存/SQLite 共用，只读输入、零 IO）：候选行由调用方按
 * 「显式 dispatchKey」或「(scope, operation, replayWindow)」读出；本函数不接收 args。
 *
 * 规则（dispatchKey 设计 §5.3；设计文档 2026-11-18 删除，git 历史可考）：
 *   · 显式键：同 operation 且已落定 → 回放；进行中 → in_progress；未知 → 待核对；
 *     不同 operation → conflict；键不存在 → 待核对（不按该键铸造）；
 *   · 无窗口 → 铸造新行（两笔合法同参数操作 = 两行两 key）；
 *   · 窗口内 0 行 → 铸造；≥2 行 → 无法证明映射（读操作可安全重发 → 铸造新行；
 *     写操作 → 待核对）；恰 1 行 → 同名同上规则，异名 → conflict。
 */
export function decideOperationClaim(
  input: Pick<OperationClaimInput, 'operation' | 'readOnly' | 'dispatchKey' | 'replayWindow'>,
  candidates: readonly OperationRecord[],
): OperationClaimDecision {
  const readOnly = input.readOnly === true;

  if (input.dispatchKey !== undefined) {
    const row = candidates[0];
    if (row === undefined) return { action: 'unresolved', reason: 'prior_unknown', rows: [] };
    if (row.operation !== input.operation) return { action: 'conflict', row };
    if (row.status === 'claimed') return { action: 'in_progress', row };
    if (row.status === 'unknown') return { action: 'unresolved', reason: 'prior_unknown', rows: [row] };
    return { action: 'replay', row };
  }

  if (input.replayWindow === undefined) return { action: 'mint' };
  if (candidates.length === 0) return { action: 'mint' };
  if (candidates.length > 1) {
    // 读操作没有副作用，可安全重发（新行新 key，仍不合并、不猜哪条是重放）。
    return readOnly ? { action: 'mint' } : { action: 'unresolved', reason: 'ambiguous_replay', rows: candidates };
  }

  const row = candidates[0] as OperationRecord;
  if (row.operation !== input.operation) return { action: 'conflict', row };
  if (row.status === 'claimed') return readOnly ? { action: 'reclaim', row } : { action: 'in_progress', row };
  if (row.status === 'unknown') {
    return readOnly ? { action: 'reclaim', row } : { action: 'unresolved', reason: 'prior_unknown', rows: [row] };
  }
  return readOnly ? { action: 'reclaim', row } : { action: 'replay', row };
}

/** 执行结果 → 账行状态；外部结果未知（result_unknown）落 unknown，不冒充失败确认。 */
export function operationStatusOf(outcome: ExecutionOutcome): OperationStatus {
  if (outcome.status === 'failed' && outcome.error.code === 'result_unknown') return 'unknown';
  return outcome.status;
}

export interface TaskRegistry {
  /**
   * 受理：建一行事实。缺省 = inline（建行即开跑，running_since 写入）；queued = 后台受理
   * （P6 submit：不写 running_since，等 runner 认领）。
   */
  begin(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    request: string;
    queued?: boolean;
  }): TaskRecord;
  noteExecution(taskId: string, record: ExecutionRecord): void;
  /** worker 完成汇报逐字存档（事实；不判结论、不嗅探文本）。 */
  setResultText(taskId: string, resultText: string): void;
  /**
   * P1：把本回合 Main 最终回复逐字写入各任务行（同回合各任务行同值）。
   * 调用点唯一：execution-runtime.send 收尾后；不存在的 taskId 不写（调用方保证 id 来自本回合）。
   * 后台完成也经本方法存档（runner settle：replyText 即完成汇报的事实存档面）。
   */
  archiveReply(taskIds: readonly string[], replyText: string): void;
  /** 按可信 scope 取任务：principalId 与 sessionId 都必须一致，否则 TaskOwnershipError。 */
  get(taskId: string, scope?: TaskScope): TaskRecord;
  /** scope 缺省 = 全部任务；给出时只返回该 principal + session 的任务（不跨会话泄漏）。 */
  list(scope?: TaskScope): readonly TaskRecord[];
  /**
   * 只读等待行（waiting_user 事实：pendingQuestion 非空且无结束事实）。
   * 给出 scope 时只返回该 principal + session 的等待行（交办前的「有没有待确认提案」检查走索引）。
   */
  listWaiting(scope?: TaskScope): readonly TaskRecord[];
  /**
   * 只读在跑行（长时间提醒扫描用；避免每趟 pump 全表分配）：唯一谓词 {@link stillProgressingOf}
   * （已启动、无结束事实、无 round_failed、无汇报存档、无等待形状；含长任务等待回执的行）。
   */
  listRunning(): readonly TaskRecord[];
  /**
   * 原子领取一档「长时间没动静」提醒——只有该档尚未提醒过才写入并返回 true；已提醒过返回
   * false（零写入）。stage = 'overdue'（10 分钟档）| 'contact_lost'（断联系档）。
   * 并发/重启下同一任务每档至多一次；不改任务事实、不产事件。
   */
  claimLongRunningNotice(taskId: string, stage: 'overdue' | 'contact_lost', at: string): boolean;
  /** 等待事实写入（pendingQuestion + waiting_since；清租约）。任务已收尾时拒绝（不翻案）。 */
  waitForUser(taskId: string, pendingQuestion: PendingQuestion, options?: MutationOptions): TaskRecord;
  /** 答复接续：清除等待事实（同一 Task 新回合；task_no/executions 不新建）。 */
  answerResumes(taskId: string, options?: MutationOptions): TaskRecord;
  /** 用户取消确认：cancelled_at 一次性写入（重复取消零写入）。 */
  markCancelled(taskId: string, options?: MutationOptions): TaskRecord;
  /** 机械超时：timed_out_at 一次性写入（等待到期/回合超时/排队超时）。 */
  markTimedOut(taskId: string, kind: TimeoutKind, options?: MutationOptions): TaskRecord;
  /** 看门狗：租约过期 → died_at 一次性写入（结果未知，禁止自动重放）。 */
  markDied(taskId: string): TaskRecord;
  /** 资源拒绝：resource_limited_at 一次性写入（受理/派发被 policy 拒）。 */
  markResourceLimited(taskId: string, options?: MutationOptions): TaskRecord;
  /** 用户取消**请求**：cancel_requested_at 一次性写入（请求 ≠ 确认；不清租约、不改终局）。 */
  markCancelRequested(taskId: string, options?: MutationOptions): TaskRecord;
  /**
   * 回合失败事实（不写任务结论）：回合以「没有汇报」收尾/抛错/结果未知时，落一条一次性机械时刻
   * （round_failed_at）并发一条事实事件——失败通知、失败唤醒与在跑扫描的事实源。事实依据 =
   * 底账现状（无汇报存档、执行行原样）；不写业务结论、不改终局、不清租约（无汇报 ≠ 结果未知）。
   */
  noteRoundFailed(taskId: string): void;
  /**
   * 原子认领最老未启动任务：写 running_since + 租约；无未启动任务返回 undefined。
   * 这是 P6 队列的唯一入口（不引第二套队列）。
   */
  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecord | undefined;
  /** 接续回合的在跑凭据（存活事实）：写租约；running_since 首次写入后单调不变。 */
  armLease(taskId: string, input: { owner: string; leaseMs: number }, options?: MutationOptions): TaskRecord;
  /** 过期的租约 → died_at（返回受影响任务；不自动重放）。 */
  expireLeases(now?: string): readonly TaskRecord[];
  /** 单回调事实钩子（供通知/采集）：注入替换旧回调；被拒的事实不发；钩子异常不回滚事实。 */
  onTaskFact(hook: TaskFactHook | undefined): void;
  /**
   * U3：认领一笔逻辑操作（原子；签名不含 args）。
   *   · minted → 调用方可用该 dispatchKey 发起（唯一铸造点，op_seq 只在此分配一次）；
   *   · replayed → 直接返回已有结果，**不**再调用执行层；
   *   · in_progress → 同一身份正在执行，本次不得并发执行；
   *   · unresolved → 无法证明绑定，调用方必须停止副作用并如实告知待核对；
   *   · conflict → 同身份不同 operation，确定性拒绝。
   */
  claimOperation(input: OperationClaimInput): OperationClaim;
  /**
   * U3：落定认领（status 取 outcome 四态；result_unknown → unknown）。
   * `deliveredAt` 在落定时写入（= settledAt），表示结果已交给 Pi 回合、可供回放；
   * 它不表示模型已读取。标记 unknown 的路径不写 deliveredAt（NULL = 未落定/未交付）。
   */
  settleOperation(dispatchKey: string, outcome: ExecutionOutcome, options?: { now?: string; taskId?: string }): OperationRecord;
  /** U3：结果未知（调用中断/外部无回执）→ unknown + reason；禁止自动重放。 */
  markOperationUnknown(dispatchKey: string, reason: string, options?: { now?: string }): OperationRecord;
  /** U3：按身份键读回（审计/测试；不存在返回 undefined）。 */
  getOperation(dispatchKey: string): OperationRecord | undefined;
  /**
   * 长任务（契约 v4）：所有 accepted 行（按 claimed_at 升序）。宿主重启后据此重新 wait——
   * operationId 在 outcome 里，taskId 绑定到任务行。只读；不推进任何事实。
   */
  listAcceptedOperations(): readonly OperationRecord[];
  /**
   * 长任务终态落定：accepted → completed/failed（别的状态不覆盖，幂等）。
   * 结果由 wait 返回；这里只把账行从「进行中」推进到终态，不重放、不重铸身份。
   */
  settleAcceptedOperation(dispatchKey: string, outcome: ExecutionOutcome, options?: { now?: string }): OperationRecord;
  /**
   * 长任务让出槽位：清掉租约（任务事实不动，等待宿主 wait 唤醒）。
   * 不产事件（存活仍由在跑事实承担）；只清租约，避免 expireLeases 把等待中的任务判成 died。
   */
  releaseTaskLease(taskId: string, options?: MutationOptions): TaskRecord;
}

/** 库内可变形状：对外只读视图由 TaskRecord 承担。 */
interface MutableTaskRecord extends Omit<TaskRecord, 'executions'> {
  executions: ExecutionRecord[];
}

/** 内存实现打开选项（测试/纯内存嵌入）：注入时钟供租约与时刻计算（缺省系统时钟）。 */
export interface MemoryTaskRegistryOptions {
  now?: () => Date;
}

export function createTaskRegistry(options: MemoryTaskRegistryOptions = {}): TaskRegistry {
  const clock = options.now ?? ((): Date => new Date());
  const tasks = new Map<string, MutableTaskRecord>();
  /** U3 逻辑操作账：行就是身份（内存实现仅用于测试/纯内存嵌入；语义与 SQLite 逐项一致）。 */
  const operations = new Map<string, OperationRecord>();
  /** 内存实现的编号：与 SQLite 底账同口径（自增、不复用）——测试与纯内存嵌入用。 */
  let nextTaskNo = 0;
  let factHook: TaskFactHook | undefined;

  const operationKeyOf = (scopeKey: string, opSeq: number): string => `dk_${scopeKey}:${opSeq}`;

  /** 作用域内序号分配（唯一铸造点；MAX+1，永不复用）。 */
  const mintOperationRow = (input: OperationClaimInput, now: string): OperationRecord => {
    let maxSeq = 0;
    for (const row of operations.values()) {
      if (row.scopeKey === input.scopeKey && row.opSeq > maxSeq) maxSeq = row.opSeq;
    }
    const opSeq = maxSeq + 1;
    const row: OperationRecord = {
      dispatchKey: operationKeyOf(input.scopeKey, opSeq),
      scopeKey: input.scopeKey,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      opSeq,
      operation: input.operation,
      status: 'claimed',
      attempt: input.attempt,
      claimedAt: now,
    };
    operations.set(row.dispatchKey, row);
    return row;
  };

  const require = (taskId: string, scope?: TaskScope): MutableTaskRecord => {
    const task = tasks.get(taskId);
    if (
      !task
      || (scope !== undefined && (task.principalId !== scope.principalId || task.sessionId !== scope.sessionId))
    ) {
      throw new TaskOwnershipError();
    }
    return task;
  };

  const emit = (task: MutableTaskRecord, event: TaskEventKind, at: string): void => {
    if (factHook === undefined) return;
    try {
      factHook({
        taskId: task.taskId,
        taskNo: task.taskNo ?? 0,
        name: task.name ?? deriveTaskName(task.request),
        event,
        at,
        stateVersion: at,
      });
    } catch {
      // 事实已机械落库；消费者故障不得回滚/改变任务事实（不重试、不落库）。
    }
  };

  const touch = (task: MutableTaskRecord, at: string): void => {
    task.updatedAt = at;
  };

  const clearLease = (task: MutableTaskRecord): void => {
    delete task.leaseOwner;
    delete task.leaseUntil;
  };

  return {
    begin(input) {
      const now = clock().toISOString();
      nextTaskNo += 1;
      const task: MutableTaskRecord = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        taskNo: nextTaskNo,
        name: deriveTaskName(input.request),
        executions: [],
        // inline 建行即开跑（running_since 写入）；后台受理（queued）等 runner 认领。
        ...(input.queued === true ? {} : { runningSince: now }),
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(input.taskId, task);
      emit(task, input.queued === true ? 'queued' : 'started', now);
      return task;
    },
    noteExecution(taskId, record) {
      const task = require(taskId);
      task.executions.push(record);
      task.updatedAt = clock().toISOString();
    },
    setResultText(taskId, resultText) {
      const at = clock().toISOString();
      const task = require(taskId);
      task.resultText = resultText;
      touch(task, at);
      emit(task, 'result_archived', at);
    },
    archiveReply(taskIds, replyText) {
      const at = clock().toISOString();
      for (const taskId of taskIds) {
        const task = tasks.get(taskId);
        if (task === undefined) continue;
        task.replyText = replyText;
        touch(task, at);
        // 后台完成的事实存档：同 result_archived 事件（同一事实来源，通知/采集同口径）。
        emit(task, 'result_archived', at);
      }
    },
    get(taskId, scope) {
      return require(taskId, scope);
    },
    listWaiting(scope) {
      return [...tasks.values()]
        .filter((task) => task.pendingQuestion !== undefined
          && !taskEndedOf(task)
          && (scope === undefined
            || (task.principalId === scope.principalId && task.sessionId === scope.sessionId)))
        .map((task) => ({ ...task }));
    },
    listRunning() {
      // 在跑事实 = 唯一谓词（已启动 + 无结束/回合失败/汇报/等待）；与 SQLite 同口径。
      return [...tasks.values()]
        .filter((task) => stillProgressingOf(task))
        .map((task) => ({ ...task }));
    },
    claimLongRunningNotice(taskId, stage, at) {
      const task = require(taskId);
      const field = stage === 'overdue' ? 'longRunningNotifiedAt' : 'waitContactLostNotifiedAt';
      if (task[field] !== undefined) return false;
      task[field] = at;
      return true;
    },
    list(scope) {
      const all = [...tasks.values()];
      if (scope === undefined) return all;
      return all.filter((task) => task.principalId === scope.principalId && task.sessionId === scope.sessionId);
    },
    waitForUser(taskId, pendingQuestion, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (taskEndedOf(task)) throw new TaskSettledError(taskId);
      task.pendingQuestion = pendingQuestion;
      task.waitingSince = at;
      clearLease(task);
      touch(task, at);
      emit(task, 'waiting_user', at);
      return task;
    },
    answerResumes(taskId, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (taskEndedOf(task)) throw new TaskSettledError(taskId);
      delete task.pendingQuestion;
      delete task.waitingSince;
      touch(task, at);
      emit(task, 'resumed', at);
      return task;
    },
    markCancelled(taskId, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (task.cancelledAt !== undefined) return task; // 一次性事实：重复取消零写入、零事件
      task.cancelledAt = at;
      clearLease(task);
      touch(task, at);
      emit(task, 'cancelled', at);
      return task;
    },
    markTimedOut(taskId, _kind, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (task.timedOutAt !== undefined) return task;
      task.timedOutAt = at;
      clearLease(task);
      touch(task, at);
      emit(task, 'timed_out', at);
      return task;
    },
    markDied(taskId) {
      const at = clock().toISOString();
      const task = require(taskId);
      if (task.diedAt !== undefined) return task;
      // 唯一谓词：已汇报 / round_failed / 等待 / 未启动的行 = 已知事实，不把「没停完」改写成
      // died（结果未知）——过期扫描既有过滤，直调同样不翻案（与 SQLite 的 WHERE 守卫同口径）。
      if (!stillProgressingOf(task)) return task;
      task.diedAt = at;
      clearLease(task);
      touch(task, at);
      emit(task, 'died', at);
      return task;
    },
    markResourceLimited(taskId, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (task.resourceLimitedAt !== undefined) return task;
      task.resourceLimitedAt = at;
      clearLease(task);
      touch(task, at);
      emit(task, 'resource_limited', at);
      return task;
    },
    markCancelRequested(taskId, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (task.cancelRequestedAt !== undefined) return task; // 一次性事实：重复请求零写入
      task.cancelRequestedAt = at;
      // 请求 ≠ 确认：不清租约、不发终局事件（用户可见的「你要我停」由重启对账出口说）。
      touch(task, at);
      return task;
    },
    noteRoundFailed(taskId) {
      const task = require(taskId);
      const at = clock().toISOString();
      // 一次性收尾事实：本轮已停（不写业务结论、不清租约）；存活扫描据此不再当「在跑」。
      if (task.roundFailedAt === undefined) task.roundFailedAt = at;
      emit(task, 'round_failed', at);
    },
    claimNextQueued({ owner, leaseMs }) {
      const now = clock().toISOString();
      const task = [...tasks.values()]
        .filter((candidate) => taskUnstartedOf(candidate))
        .sort((left, right) => (left.createdAt === right.createdAt
          ? (left.taskId < right.taskId ? -1 : 1)
          : (left.createdAt < right.createdAt ? -1 : 1)))[0];
      if (task === undefined) return undefined;
      if (task.runningSince === undefined) task.runningSince = now;
      task.leaseOwner = owner;
      task.leaseUntil = new Date(clock().getTime() + leaseMs).toISOString();
      touch(task, now);
      emit(task, 'started', now);
      return task;
    },
    armLease(taskId, { owner, leaseMs }, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      if (taskEndedOf(task)) throw new TaskSettledError(taskId);
      if (task.runningSince === undefined) task.runningSince = at;
      task.leaseOwner = owner;
      task.leaseUntil = new Date(clock().getTime() + leaseMs).toISOString();
      touch(task, at);
      return task;
    },
    expireLeases(now = clock().toISOString()) {
      const affected: TaskRecord[] = [];
      for (const task of tasks.values()) {
        if (task.leaseUntil === undefined || task.leaseUntil > now) continue;
        // 唯一谓词：已汇报 / round_failed / 等待 / 已收尾的行没有「过期租约 = 结果未知」可写。
        if (!stillProgressingOf(task)) continue;
        affected.push(this.markDied(task.taskId));
      }
      return affected;
    },
    onTaskFact(hook) {
      factHook = hook;
    },
    claimOperation(input) {
      const now = input.now ?? clock().toISOString();
      let candidates: OperationRecord[] = [];
      if (input.dispatchKey !== undefined) {
        const row = operations.get(input.dispatchKey);
        if (row !== undefined) candidates = [row];
      } else if (input.replayWindow !== undefined) {
        candidates = [...operations.values()]
          .filter((row) => row.scopeKey === input.scopeKey
            && row.operation === input.operation
            && row.attempt === input.replayWindow)
          .sort((left, right) => left.opSeq - right.opSeq);
      }
      const decision = decideOperationClaim(input, candidates);
      switch (decision.action) {
        case 'mint': {
          const row = mintOperationRow(input, now);
          return { kind: 'minted', dispatchKey: row.dispatchKey, opSeq: row.opSeq, reclaimed: false };
        }
        case 'reclaim': {
          const row = decision.row;
          row.status = 'claimed';
          delete row.reason;
          delete row.outcome;
          delete row.settledAt;
          delete row.deliveredAt;
          row.claimedAt = now;
          // 记下本次绑定到的窗口号（身份不变；只用于后续恢复再次找回同一行）。
          row.attempt = input.attempt;
          if (input.taskId !== undefined) row.taskId = input.taskId;
          return { kind: 'minted', dispatchKey: row.dispatchKey, opSeq: row.opSeq, reclaimed: true };
        }
        case 'replay': {
          const { row } = decision;
          if (row.outcome === undefined) {
            row.status = 'unknown';
            row.reason = 'prior_unknown';
            row.settledAt = now;
            return { kind: 'unresolved', reason: 'prior_unknown', dispatchKey: row.dispatchKey };
          }
          // 仅推进窗口标记，不新铸身份：下一次恢复仍能找回这一行。
          row.attempt = input.attempt;
          return { kind: 'replayed', dispatchKey: row.dispatchKey, opSeq: row.opSeq, outcome: row.outcome };
        }
        case 'in_progress':
          return {
            kind: 'in_progress',
            dispatchKey: decision.row.dispatchKey,
            opSeq: decision.row.opSeq,
            claimedAt: decision.row.claimedAt,
          };
        case 'unresolved': {
          for (const row of decision.rows) {
            if (row.status === 'claimed' || row.status === 'unknown') {
              row.status = 'unknown';
              row.reason = decision.reason;
              row.settledAt = now;
            }
          }
          const first = decision.rows[0];
          return {
            kind: 'unresolved',
            reason: decision.reason,
            ...(first === undefined ? {} : { dispatchKey: first.dispatchKey }),
          };
        }
        case 'conflict':
          return { kind: 'conflict', reason: 'operation_mismatch', dispatchKey: decision.row.dispatchKey };
      }
    },
    settleOperation(dispatchKey, outcome, options = {}) {
      const row = operations.get(dispatchKey);
      if (row === undefined) {
        throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
      }
      // 已落定的行不被覆盖（重复落定不改变事实；unknown 不被晚到的结果洗白）。
      if (row.status !== 'claimed') return row;
      const now = options.now ?? new Date().toISOString();
      row.status = operationStatusOf(outcome);
      if (row.status === 'unknown') row.reason = 'result_unknown';
      else delete row.reason;
      row.outcome = outcome;
      row.settledAt = now;
      row.deliveredAt = now;
      if (options.taskId !== undefined) row.taskId = options.taskId;
      return row;
    },
    markOperationUnknown(dispatchKey, reason, options = {}) {
      const row = operations.get(dispatchKey);
      if (row === undefined) {
        throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
      }
      if (row.status !== 'claimed') return row;
      row.status = 'unknown';
      row.reason = reason;
      row.settledAt = options.now ?? new Date().toISOString();
      return row;
    },
    getOperation(dispatchKey) {
      return operations.get(dispatchKey);
    },
    listAcceptedOperations() {
      return [...operations.values()]
        .filter((row) => row.status === 'accepted')
        .sort((left, right) => (left.claimedAt < right.claimedAt ? -1 : left.claimedAt > right.claimedAt ? 1 : left.opSeq - right.opSeq));
    },
    settleAcceptedOperation(dispatchKey, outcome, options = {}) {
      const row = operations.get(dispatchKey);
      if (row === undefined) {
        throw new Error(`未知的逻辑操作身份：${dispatchKey}（只认已持久化的 key，不接受现造身份）。`);
      }
      // 只推进 accepted 行；重复落定/已终态不覆盖（幂等，未知不被洗白）。
      if (row.status !== 'accepted') return row;
      const now = options.now ?? new Date().toISOString();
      row.status = operationStatusOf(outcome);
      if (row.status === 'accepted') return row; // 仍进行中：不推进
      if (row.status === 'unknown') row.reason = 'result_unknown';
      else delete row.reason;
      row.outcome = outcome;
      row.settledAt = now;
      row.deliveredAt = now;
      return row;
    },
    releaseTaskLease(taskId, options = {}) {
      const at = clock().toISOString();
      const task = require(taskId, options.scope);
      clearLease(task);
      touch(task, at);
      return task;
    },
  };
}
