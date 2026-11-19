/**
 * 任务归属底账 + 生命周期状态事实（B 类：任务归属与状态，最小形状）。
 *
 * 为什么需要它：委派任务必须绑定发起它的可信身份与会话，事后按业务查询时，
 * 越权（换一个 principal/session）必须被确定性拒绝。可信身份来自装配层的
 * principalId/sessionId（配置与渠道事实），**不接受模型输入**。
 *
 * P1 底账演化（最小增量，豁免零新增机制——数字 ID/名称/回复存档是任务书点名的确定性责任）：
 *   · taskNo：数字任务编号（由 SQLite 底账单条 SQL 原子分配；内存实现同口径自增）；
 *   · name：业务名称 v1 = 机械回落 deriveTaskName(request)（零模型；来源=任务交办原文，
 *     与迁移回填/显示回落同规则；#4-a 模型命名递延，不改 task_run 工具 schema）；
 *   · replyText：Main 本回合最终回复（send 收尾后 archiveReply 同值写本回合各任务行）。
 *
 * P2a 契约核心（2026-11-14；来源 docs/history/r4-joint-interfaces.md §1 v1 冻结）：
 *   · 状态集 queued/running/waiting_user/cancelling/cancelled/completed/failed/timed_out
 *     + 保留 unexecuted（已汇报零执行）；
 *   · 合法转换矩阵见 LEGAL_TRANSITIONS（其余一律拒绝并留痕：TaskTransitionError，
 *     状态不变、零事实）；cancelling→running 是「中止未获确认不得宣称取消」的回滚边；
 *   · 取消语义：requestCancel 只落 cancelling（请求 ≠ 取消），confirmCancelled 才落
 *     cancelled；确认/超时写机械原因（TASK_REASONS）；
 *   · waiting_user 形状：pending_question（JSON：missing[]/candidates?[]/raw?）+ waiting_since；
 *     答复 answerResumes 续同一 Task（task_no 不变、executions 追加、不得新建任务）；
 *   · 唯一写路径：所有状态变化经本方法族（原子持久化 + onTaskFact 事实钩子）；
 *     任何模块禁止直接 UPDATE tasks.status（源码级守卫见 task-registry-write-path.test.ts）；
 *   · result_unknown ≠ failed ≠ success：重启后无法确认的 running 任务经
 *     markResultUnknown / expireLeases 落 failed + reason=result_unknown，禁止自动重放。
 *
 * inline 路径维持现冻结语义（judgeReportedTask 不改；complete/fail 仍按既有口径收尾，
 * waiting_user 仅后台任务使用）。
 *
 * U3 稳定逻辑操作身份（2026-11-16，仅追加，不新建第二套 Registry）：
 *   · 在**现有**底账上增加一张 operations 账（内存实现用 Map，SQLite 实现用 operations 表），
 *     行就是身份：dispatch_key 主键 + UNIQUE(scope_key, op_seq)，**没有**任何以
 *     (operation, args) 为键的唯一约束——参数完全相同的两笔合法操作必须是两行、各执行一次；
 *   · 铸造点唯一：首次创建逻辑操作时分配 op_seq 并落库；重试/重规划只读回同一行
 *     （claimOperation 的结构不接受 args，因此「按参数文本去重」没有代码路径）；
 *   · 认领与写状态都是原子的：读候选 → 纯函数决策 → 写，在 registry 侧一次完成
 *     （SQLite 实现包在 BEGIN IMMEDIATE 写事务里）；进行中的重复请求返回 in_progress，
 *     不发起第二次执行；
 *   · 证明不了新调用属于已有操作 → unresolved（停止副作用，交由调用方落 result_unknown），
 *     不猜绑定；读操作（装配方声明的只读集合）可安全重发，不被 key 逻辑误挡。
 *
 * 这里不做的（登记缺口，不在这里预造）：
 *   · 通用 Exactly Once：宿主只承诺「同一身份至多一次自动执行 + 结果未知可核对」，
 *     外部幂等键/状态查询/回读归执行层；
 *   · 事件流/订阅体系：事实钩子只做单回调注入（供 P4/P6），不持久化事件。
 *
 * 拒绝路径（回归锁，见 runtime.test.ts）：换 principal 或换 session 取任务
 * 一律 TaskOwnershipError；取不存在的任务与越权同一错误（不泄漏任务是否存在）。
 */
import type { ExecutionFailure, ExecutionOutcome, ExecutionStatus } from '@fshine/contracts/execution-contract';

/** P2a：冻结状态集（顺序即契约登记顺序）。unexecuted = 已汇报零执行（保留）。 */
export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'timed_out',
  'unexecuted',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 机械终止原因（冻结枚举）：result_unknown ≠ failed ≠ success，禁止自动重放。 */
export const TASK_REASONS = [
  'cancelled_by_user',
  'timeout',
  'failed_confirmed',
  'result_unknown',
  'resource_limited',
] as const;

export type TaskReason = (typeof TASK_REASONS)[number];

/** 超时种类（超时链：queued 排队等待 / execution 执行 / waiting_user 用户等待）。 */
export type TimeoutKind = 'queued' | 'execution' | 'waiting_user';

/**
 * 写操作提案的机械形状（执行层 needs_confirmation 事实；原样承载，不解释、不裁决）。
 * handle 是执行层发放的确认凭据：留底账供后续回合透传（S3），**不进模型/用户可见投影**
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
}

/** waiting_user 的机械问题形状（执行层 needs_input 事实；不编造、不改写候选）。 */
export interface PendingQuestion {
  missing: readonly string[];
  candidates?: readonly string[];
  raw?: string;
  /** 写操作提案（可选）：needs_confirmation 与 needs_input 同走 waiting_user，不新状态。 */
  confirmation?: PendingConfirmation;
}

/**
 * 状态事实（供 P4/P6，非事件总线）：每次成功状态变化一条；begin 创建事实无 from
 * （不是状态转换）。v1.1：`stateVersion` 为稳定去重版本（P4 outbox 唯一键用），
 * 缺省 = `at`（集成若提供注册表计数器可显式传入更精确版本）。
 */
export interface TaskFact {
  taskId: string;
  taskNo: number;
  name: string;
  from?: TaskStatus;
  to: TaskStatus;
  reason?: TaskReason;
  at: string;
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

/** 判定只需要的执行事实投影（内存 ExecutionRecord 与 SQLite 读回行共用）。 */
export interface ExecutedFact {
  operation: string;
  status: ExecutionStatus;
  error?: ExecutionFailure;
}

/**
 * 完成判定（内存 / SQLite 共用，两实现逐项一致）：只看已记录的执行事实，不嗅探汇报文本。
 *   · 零条执行 → unexecuted（Worker 汇报了但没向执行层发起任何调用）；
 *   · 全部 completed → completed；
 *   · 任一非 completed → failed，failureReason 机械合成（取首个非 completed 的
 *     operation/status/error.message 原样；无 error.message 时以状态收尾）。
 * 为什么不是无条件 completed：Worker 以汇报结束不等于执行层成功——「执行层实际成功 /
 * 拒绝或失败 / 未发起执行」必须在顶层 status 上可区分（B 类如实交付）。
 *
 * P2a 不改本判定（E05/E06 冻结语义）；waiting_user 由后台路径的 waitForUser 单独进入，
 * 本函数仅服务于 inline complete 的终态判定。
 */
export function judgeReportedTask(executions: readonly ExecutedFact[]): {
  status: 'completed' | 'failed' | 'unexecuted';
  failureReason?: string;
} {
  if (executions.length === 0) {
    return {
      status: 'unexecuted',
      failureReason: '未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。',
    };
  }
  const unsuccessful = executions.find((execution) => execution.status !== 'completed');
  if (unsuccessful === undefined) return { status: 'completed' };
  const message = unsuccessful.error?.message ?? '';
  return {
    status: 'failed',
    failureReason: message === ''
      ? `执行层未成功：${unsuccessful.operation} 返回 ${unsuccessful.status}。`
      : `执行层未成功：${unsuccessful.operation} 返回 ${unsuccessful.status}：${message}`,
  };
}

/** 一条最小任务底账：归属 + 状态 + 机械原因/等待形状/租约 + 结果文本 + 执行调用清单。 */
export interface TaskRecord {
  taskId: string;
  principalId: string;
  sessionId: string;
  /** 委派原文（任务请求；审计与结果解释用；业务名称的机械来源）。 */
  request: string;
  status: TaskStatus;
  /** 机械终止原因（cancelled_by_user/timeout/failed_confirmed/result_unknown/resource_limited）。 */
  reason?: TaskReason;
  resultText?: string;
  failureReason?: string;
  /** waiting_user：待用户补齐的问题（原样持久化；答复后清除，等待超时保留为历史）。 */
  pendingQuestion?: PendingQuestion;
  /** waiting_user：进入等待的时刻（ISO）。 */
  waitingSince?: string;
  /** 后台认领租约（仅 running 且已认领时存在；离开 running 即清空）。 */
  leaseOwner?: string;
  leaseUntil?: string;
  /** P1：数字任务编号（底账分配，唯一、不复用；旧库只读/未迁移时缺省）。 */
  taskNo?: number;
  /** P1：业务名称（新行=机械回落写入；历史行缺省，显示层同规则回落）。 */
  name?: string;
  /** P1：本回合 Main 最终回复全文（同回合各任务行同值；缺省=无最终回复存档）。 */
  replyText?: string;
  /**
   * 预期契约（2026-11-18）：宿主已发出「长时间没动静」提醒的时刻（ISO）。
   * 缺省 = 尚未提醒；写入一次后不再改（同一任务只提醒一次，重启不重发）。
   * 只此一档（10 分钟超预期档）；30 分钟「卡住」档已随 2026-11-19 唤醒切片删除。
   */
  longRunningNotifiedAt?: string;
  /**
   * 本轮开始运行的时刻（ISO，单调写一次）。长任务受理后租约会被清掉，「跑了多久」不能
   * 只从租约反推——否则最该主动汇报的长任务反而不在提醒扫描里（2026-11-19）。
   * 缺省 = 未跑过（排队中 / 旧库只读未迁移）。
   */
  runningSince?: string;
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

/** 非法状态转换：确定性拒绝（状态不变、零事实）；携带 from/to 便于审计与测试断言。 */
export class TaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus, detail = '') {
    super(`非法任务状态转换：${from} → ${to}${detail === '' ? '' : `（${detail}）`}。`);
    this.name = 'TaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface TaskScope {
  principalId: string;
  sessionId: string;
}

/** 状态变更方法的公共选项：给出 scope 时先校验归属（越权与不存在同错）。 */
export interface MutationOptions {
  scope?: TaskScope;
}

/** transition 额外允许机械原因（与目标状态不符一律拒绝，防编造）。 */
export interface TransitionOptions extends MutationOptions {
  reason?: TaskReason;
}

/**
 * 冻结的合法转换矩阵（r4-joint-interfaces.md §1；其余一律拒绝并留痕）。
 *   · queued→running（认领/启动）；queued→cancelling→cancelled；
 *   · running→{completed|failed|waiting_user|cancelling|timed_out}+unexecuted（保留的内联零执行终态）；
 *   · waiting_user→{running（答复接续）|cancelling|timed_out}；
 *   · cancelling→cancelled（确认）；cancelling→running（中止未获确认不得宣称取消，回滚并留痕）。
 * 登记：queued→timed_out 为 P2-T04「排队等待超时」所需（§1 列举边未含；最小处置见实施报告）。
 */
const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelling', 'timed_out'],
  running: ['completed', 'failed', 'waiting_user', 'cancelling', 'timed_out', 'unexecuted'],
  waiting_user: ['running', 'cancelling', 'timed_out'],
  cancelling: ['cancelled', 'running'],
  cancelled: [],
  completed: [],
  failed: [],
  timed_out: [],
  unexecuted: [],
};

/** 任务状态机的可持久化投影（内存与 SQLite 实现共用同一 reducer）。 */
export interface TaskStateSnapshot {
  status: TaskStatus;
  reason?: TaskReason;
  pendingQuestion?: PendingQuestion;
  waitingSince?: string;
  leaseOwner?: string;
  leaseUntil?: string;
}

/** 状态机动作（语义冻结的方法族经动作归约到同一转换核心）。 */
export type TaskAction =
  | { action: 'transition'; to: TaskStatus; reason?: TaskReason }
  | { action: 'waitForUser'; pendingQuestion: PendingQuestion }
  | { action: 'answerResumes' }
  | { action: 'requestCancel' }
  | { action: 'confirmCancelled' }
  | { action: 'timeout'; kind: TimeoutKind }
  | { action: 'markResultUnknown' };

function assertLegalEdge(from: TaskStatus, to: TaskStatus, detail = ''): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) throw new TaskTransitionError(from, to, detail);
}

/** 机械原因由目标状态确定；显式 reason 与目标不符一律拒绝（防编造）。 */
function mechanicalReason(from: TaskStatus, to: TaskStatus, reason?: TaskReason): TaskReason | undefined {
  const allowed: readonly TaskReason[] =
    to === 'cancelled'
      ? ['cancelled_by_user']
      : to === 'timed_out'
        ? ['timeout']
        : to === 'failed'
          ? ['failed_confirmed', 'result_unknown', 'resource_limited']
          : [];
  if (reason === undefined) {
    if (to === 'cancelled') return 'cancelled_by_user';
    if (to === 'timed_out') return 'timeout';
    if (to === 'failed') return 'failed_confirmed';
    return undefined;
  }
  if (!allowed.includes(reason)) throw new TaskTransitionError(from, to, `原因 ${reason} 与目标状态不符`);
  return reason;
}

/** waiting_user 形状校验：missing 必须是非空字符串数组；candidates/raw 可选（不编造）。 */
function assertPendingQuestion(question: PendingQuestion): void {
  if (!Array.isArray(question.missing) || question.missing.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError('pendingQuestion 形状非法：missing 必须是非空字符串数组。');
  }
  if (question.candidates !== undefined
    && (!Array.isArray(question.candidates) || question.candidates.some((item) => typeof item !== 'string'))) {
    throw new TypeError('pendingQuestion 形状非法：candidates 必须是字符串数组。');
  }
  if (question.raw !== undefined && typeof question.raw !== 'string') {
    throw new TypeError('pendingQuestion 形状非法：raw 必须是字符串。');
  }
  if (question.confirmation !== undefined) {
    const { handle, summary, expiresAt, operation } = question.confirmation;
    if (typeof handle !== 'string' || handle.trim() === '') {
      throw new TypeError('pendingQuestion 形状非法：confirmation.handle 必须是非空字符串。');
    }
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw new TypeError('pendingQuestion 形状非法：confirmation.summary 必须是非空字符串。');
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || expiresAt.trim() === '')) {
      throw new TypeError('pendingQuestion 形状非法：confirmation.expiresAt 必须是非空字符串。');
    }
    if (typeof operation !== 'string' || operation.trim() === '') {
      throw new TypeError('pendingQuestion 形状非法：confirmation.operation 必须是非空字符串。');
    }
  }
}

/**
 * 状态机唯一归约核心（内存/SQLite 共用；不碰存储）：
 * 校验边与原因，计算下一状态投影。非法转换抛 TaskTransitionError（状态不变）。
 * 租约不变量：只有 running 可以持有租约（离开 running 即清空；认领方在归约后自行写入）。
 */
export function reduceTaskState(current: TaskStateSnapshot, action: TaskAction, now: string): TaskStateSnapshot {
  const next: TaskStateSnapshot = { ...current };
  delete next.reason;

  switch (action.action) {
    case 'transition': {
      assertLegalEdge(current.status, action.to);
      next.status = action.to;
      const reason = mechanicalReason(current.status, action.to, action.reason);
      if (reason !== undefined) next.reason = reason;
      break;
    }
    case 'waitForUser': {
      assertLegalEdge(current.status, 'waiting_user');
      assertPendingQuestion(action.pendingQuestion);
      next.status = 'waiting_user';
      next.pendingQuestion = action.pendingQuestion;
      next.waitingSince = now;
      break;
    }
    case 'answerResumes': {
      assertLegalEdge(current.status, 'running');
      next.status = 'running';
      delete next.pendingQuestion;
      delete next.waitingSince;
      break;
    }
    case 'requestCancel': {
      assertLegalEdge(current.status, 'cancelling');
      next.status = 'cancelling';
      break;
    }
    case 'confirmCancelled': {
      assertLegalEdge(current.status, 'cancelled');
      next.status = 'cancelled';
      next.reason = 'cancelled_by_user';
      break;
    }
    case 'timeout': {
      const expected: TaskStatus = action.kind === 'queued' ? 'queued' : action.kind === 'execution' ? 'running' : 'waiting_user';
      if (current.status !== expected) {
        throw new TaskTransitionError(current.status, 'timed_out', `超时种类 ${action.kind} 只适用于 ${expected} 状态`);
      }
      assertLegalEdge(current.status, 'timed_out');
      next.status = 'timed_out';
      next.reason = 'timeout';
      break;
    }
    case 'markResultUnknown': {
      assertLegalEdge(current.status, 'failed');
      next.status = 'failed';
      next.reason = 'result_unknown';
      break;
    }
  }

  if (next.status !== 'running') {
    delete next.leaseOwner;
    delete next.leaseUntil;
  }
  return next;
}

/** 机械事实的种子（from 仅状态转换事实有；begin 创建事实无 from）。 */
export interface TaskFactSeed {
  from?: TaskStatus;
  to: TaskStatus;
  reason?: TaskReason;
  at: string;
  /** v1.1：稳定去重版本；缺省 = at。 */
  stateVersion?: string | number;
}

/**
 * 逻辑操作账的状态集（U3 + 长任务 v4）。completed/needs_confirmation/needs_input/failed/
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
   * 将来 resume 判据只把它当「已有结果可回放」，不把它当「模型已确认」。
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
  begin(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    request: string;
    /** 初始状态：缺省 running（inline 现冻结语义）；queued = 后台受理（P6 submit）。 */
    status?: 'queued' | 'running';
  }): TaskRecord;
  noteExecution(taskId: string, record: ExecutionRecord): void;
  complete(taskId: string, resultText: string): void;
  fail(taskId: string, reason: string): void;
  /**
   * P1：把本回合 Main 最终回复逐字写入各任务行（同回合各任务行同值）。
   * 调用点唯一：execution-runtime.send 收尾后；不存在的 taskId 不写（调用方保证 id 来自本回合）。
   */
  archiveReply(taskIds: readonly string[], replyText: string): void;
  /** 按可信 scope 取任务：principalId 与 sessionId 都必须一致，否则 TaskOwnershipError。 */
  get(taskId: string, scope: TaskScope): TaskRecord;
  /** scope 缺省 = 全部任务；给出时只返回该 principal + session 的任务（不跨会话泄漏）。 */
  list(scope?: TaskScope): readonly TaskRecord[];
  /**
   * 只读 waiting_user 行（到期扫描用：避免每趟 pump 全表分配）。
   * 给出 scope 时只返回该 principal + session 的等待行（交办前的「有没有待确认提案」检查走索引）。
   */
  listWaiting(scope?: TaskScope): readonly TaskRecord[];
  /**
   * 只读 running 行（预期契约 2026-11-18：长时间提醒扫描用；避免每趟 pump 全表分配）。
   * 只读状态事实，不做判定。
   */
  listRunning(): readonly TaskRecord[];
  /**
   * 预期契约（2026-11-18；2026-11-19 唤醒切片只留一档）：原子领取「长时间没动静」提醒——
   * 尚未提醒过才写入并返回 true；已提醒过返回 false（零写入）。
   * 并发/重启下同一任务至多一次；不改任务状态、不产状态事实。
   */
  claimLongRunningNotice(taskId: string, at: string): boolean;
  /** 通用状态转换（合法边见冻结矩阵；给出 scope 先校验归属）。 */
  transition(taskId: string, to: TaskStatus, options?: TransitionOptions): TaskRecord;
  /** running→waiting_user：持久化 pendingQuestion（missing/candidates?/raw?）与 waiting_since。 */
  waitForUser(taskId: string, pendingQuestion: PendingQuestion, options?: MutationOptions): TaskRecord;
  /** waiting_user→running：答复续同一 Task（清除等待形状；task_no/executions 不新建）。 */
  answerResumes(taskId: string, options?: MutationOptions): TaskRecord;
  /** 取消请求（≠ 取消）：queued/running/waiting_user→cancelling。 */
  requestCancel(taskId: string, options?: MutationOptions): TaskRecord;
  /** 取消确认（abort 观察/执行层确认后）：cancelling→cancelled + reason=cancelled_by_user。 */
  confirmCancelled(taskId: string, options?: MutationOptions): TaskRecord;
  /** 超时：queued/running/waiting_user→timed_out + reason=timeout（等待超时保留历史形状）。 */
  timeout(taskId: string, kind: TimeoutKind, options?: MutationOptions): TaskRecord;
  /** 重启后无法确认结果：running→failed + reason=result_unknown（禁止自动重放）。 */
  markResultUnknown(taskId: string, options?: MutationOptions): TaskRecord;
  /**
   * 原子认领最老的 queued 任务：queued→running + 租约（owner/leaseMs）。
   * 无 queued 返回 undefined；这是 P6 队列的唯一入口（不引第二套队列）。
   */
  claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecord | undefined;
  /** 过期的 running 租约 → result_unknown（返回受影响任务；不自动重放）。 */
  expireLeases(now?: string): readonly TaskRecord[];
  /** 单回调事实钩子（供 P4/P6）：注入替换旧回调；拒绝的转换不发事实；钩子异常不回滚事实。 */
  onTaskFact(hook: TaskFactHook | undefined): void;
  /**
   * U3：认领一笔逻辑操作（原子；签名不含 args）。
   *   · minted → 调用方可用该 dispatchKey 发起（唯一铸造点，op_seq 只在此分配一次）；
   *   · replayed → 直接返回已有结果，**不**再调用执行层；
   *   · in_progress → 同一身份正在执行，本次不得并发执行；
   *   · unresolved → 无法证明绑定，调用方必须停止副作用并交还待核对；
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
   * operationId 在 outcome 里（`{status:'accepted', operationId, pollAfterMs?}`），
   * taskId 绑定到任务行。只读；不推进任何状态。
   */
  listAcceptedOperations(): readonly OperationRecord[];
  /**
   * 长任务终态落定：accepted → completed/failed（别的状态不覆盖，幂等）。
   * 结果由 wait 返回；这里只把账行从「进行中」推进到终态，不重放、不重铸身份。
   */
  settleAcceptedOperation(dispatchKey: string, outcome: ExecutionOutcome, options?: { now?: string }): OperationRecord;
  /**
   * 长任务让出槽位：清掉 running 行的租约（任务仍 running，等待宿主 wait 唤醒）。
   * 不产状态转换事实（状态没变）；只清租约，避免 expireLeases 把等待中的任务判成
   * result_unknown。
   */
  releaseTaskLease(taskId: string, options?: MutationOptions): TaskRecord;
}

/** 库内可变形状：对外只读视图由 TaskRecord 承担。 */
interface MutableTaskRecord extends Omit<TaskRecord, 'executions'> {
  executions: ExecutionRecord[];
}

export function createTaskRegistry(): TaskRegistry {
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

  const snapshotOf = (task: MutableTaskRecord): TaskStateSnapshot => ({
    status: task.status,
    ...(task.reason === undefined ? {} : { reason: task.reason }),
    ...(task.pendingQuestion === undefined ? {} : { pendingQuestion: task.pendingQuestion }),
    ...(task.waitingSince === undefined ? {} : { waitingSince: task.waitingSince }),
    ...(task.leaseOwner === undefined ? {} : { leaseOwner: task.leaseOwner }),
    ...(task.leaseUntil === undefined ? {} : { leaseUntil: task.leaseUntil }),
  });

  const applySnapshot = (task: MutableTaskRecord, next: TaskStateSnapshot): void => {
    task.status = next.status;
    if (next.reason === undefined) delete task.reason; else task.reason = next.reason;
    if (next.pendingQuestion === undefined) delete task.pendingQuestion; else task.pendingQuestion = next.pendingQuestion;
    if (next.waitingSince === undefined) delete task.waitingSince; else task.waitingSince = next.waitingSince;
    if (next.leaseOwner === undefined) delete task.leaseOwner; else task.leaseOwner = next.leaseOwner;
    if (next.leaseUntil === undefined) delete task.leaseUntil; else task.leaseUntil = next.leaseUntil;
  };

  const factOf = (task: MutableTaskRecord, seed: TaskFactSeed): TaskFact => ({
    taskId: task.taskId,
    taskNo: task.taskNo ?? 0,
    name: task.name ?? deriveTaskName(task.request),
    ...(seed.from === undefined ? {} : { from: seed.from }),
    to: seed.to,
    ...(seed.reason === undefined ? {} : { reason: seed.reason }),
    at: seed.at,
    // v1.1：稳定去重版本，缺省 = at（本实现不建计数器；集成可显式传入更精确版本）。
    stateVersion: seed.stateVersion ?? seed.at,
  });

  const emit = (fact: TaskFact): void => {
    if (factHook === undefined) return;
    try {
      factHook(fact);
    } catch {
      // 事实已机械落库；消费者故障不得回滚/改变任务事实（不重试、不落库）。
    }
  };

  const commit = (
    task: MutableTaskRecord,
    action: TaskAction,
    extras: { resultText?: string; failureReason?: string | null } = {},
  ): TaskFact => {
    const at = new Date().toISOString();
    const from = task.status;
    const next = reduceTaskState(snapshotOf(task), action, at);
    applySnapshot(task, next);
    if (extras.resultText !== undefined) task.resultText = extras.resultText;
    if (extras.failureReason !== undefined) {
      if (extras.failureReason === null) delete task.failureReason;
      else task.failureReason = extras.failureReason;
    }
    task.updatedAt = at;
    // 本轮开始运行时刻：第一次进入 running 写一次，之后不动（长任务受理会清租约，不清它）。
    if (task.status === 'running' && task.runningSince === undefined) task.runningSince = at;
    const fact = factOf(task, {
      from,
      to: next.status,
      ...(next.reason === undefined ? {} : { reason: next.reason }),
      at,
    });
    emit(fact);
    return fact;
  };

  return {
    begin(input) {
      const now = new Date().toISOString();
      nextTaskNo += 1;
      const status = input.status ?? 'running';
      const task: MutableTaskRecord = {
        taskId: input.taskId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        request: input.request,
        status,
        taskNo: nextTaskNo,
        name: deriveTaskName(input.request),
        executions: [],
        ...(status === 'running' ? { runningSince: now } : {}),
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(input.taskId, task);
      emit(factOf(task, { to: status, at: now }));
      return task;
    },
    noteExecution(taskId, record) {
      const task = require(taskId);
      task.executions.push(record);
      task.updatedAt = new Date().toISOString();
    },
    complete(taskId, resultText) {
      const task = require(taskId);
      // 终态 = 已记录执行事实的判定；汇报原文恒存（非成功终态也保留 Worker 汇报）。
      const judgement = judgeReportedTask(task.executions);
      commit(
        task,
        { action: 'transition', to: judgement.status },
        { resultText, failureReason: judgement.failureReason ?? null },
      );
    },
    fail(taskId, reason) {
      const task = require(taskId);
      commit(task, { action: 'transition', to: 'failed' }, { failureReason: reason });
    },
    archiveReply(taskIds, replyText) {
      for (const taskId of taskIds) {
        const task = tasks.get(taskId);
        if (task === undefined) continue;
        task.replyText = replyText;
        task.updatedAt = new Date().toISOString();
      }
    },
    get(taskId, scope) {
      return require(taskId, scope);
    },
    listWaiting(scope) {
      return [...tasks.values()]
        .filter((task) => task.status === 'waiting_user'
          && (scope === undefined
            || (task.principalId === scope.principalId && task.sessionId === scope.sessionId)))
        .map((task) => ({ ...task }));
    },
    listRunning() {
      return [...tasks.values()].filter((task) => task.status === 'running').map((task) => ({ ...task }));
    },
    claimLongRunningNotice(taskId, at) {
      const task = require(taskId);
      if (task.longRunningNotifiedAt !== undefined) return false;
      task.longRunningNotifiedAt = at;
      return true;
    },
    list(scope) {
      const all = [...tasks.values()];
      if (scope === undefined) return all;
      return all.filter((task) => task.principalId === scope.principalId && task.sessionId === scope.sessionId);
    },
    transition(taskId, to, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'transition', to, ...(options.reason === undefined ? {} : { reason: options.reason }) });
      return task;
    },
    waitForUser(taskId, pendingQuestion, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'waitForUser', pendingQuestion });
      return task;
    },
    answerResumes(taskId, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'answerResumes' });
      return task;
    },
    requestCancel(taskId, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'requestCancel' });
      return task;
    },
    confirmCancelled(taskId, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'confirmCancelled' });
      return task;
    },
    timeout(taskId, kind, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'timeout', kind });
      return task;
    },
    markResultUnknown(taskId, options = {}) {
      const task = require(taskId, options.scope);
      commit(task, { action: 'markResultUnknown' });
      return task;
    },
    claimNextQueued({ owner, leaseMs }) {
      const candidates = [...tasks.values()]
        .filter((task) => task.status === 'queued')
        .sort((left, right) => (left.createdAt === right.createdAt
          ? (left.taskId < right.taskId ? -1 : 1)
          : (left.createdAt < right.createdAt ? -1 : 1)));
      const task = candidates[0];
      if (task === undefined) return undefined;
      const at = new Date().toISOString();
      commit(task, { action: 'transition', to: 'running' });
      task.leaseOwner = owner;
      task.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      task.updatedAt = at;
      return task;
    },
    expireLeases(now = new Date().toISOString()) {
      const affected: TaskRecord[] = [];
      for (const task of tasks.values()) {
        if (task.status !== 'running') continue;
        if (task.leaseUntil === undefined || task.leaseUntil > now) continue;
        commit(task, { action: 'markResultUnknown' });
        affected.push(task);
      }
      return affected;
    },
    onTaskFact(hook) {
      factHook = hook;
    },
    claimOperation(input) {
      const now = input.now ?? new Date().toISOString();
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
      const task = require(taskId, options.scope);
      delete task.leaseOwner;
      delete task.leaseUntil;
      task.updatedAt = new Date().toISOString();
      return task;
    },
  };
}
