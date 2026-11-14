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
 *     与迁移回填/显示回落同规则；#4-a 模型命名递延，不改 run_task 工具 schema）；
 *   · replyText：Main 本回合最终回复（send 收尾后 archiveReply 同值写本回合各任务行）。
 *
 * P2a 契约核心（2026-11-14；来源 docs/product/r4-joint-interfaces.md §1 v1 冻结）：
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
 * 这里不做的（登记缺口，不在这里预造）：
 *   · 任务级幂等键（dispatchKey）与"同键重复提交返回原任务"：最小入口没有重投/重放面
 *     （无渠道、无后台重投），接入渠道与重投的切片按最小形状补；
 *   · 事件流/订阅体系：事实钩子只做单回调注入（供 P4/P6），不持久化事件。
 *
 * 拒绝路径（回归锁，见 runtime.test.ts）：换 principal 或换 session 取任务
 * 一律 TaskOwnershipError；取不存在的任务与越权同一错误（不泄漏任务是否存在）。
 */
import type { ExecutionFailure, ExecutionStatus } from '@fshine/contracts/execution-contract';

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

/** waiting_user 的机械问题形状（执行层 needs_input 事实；不编造、不改写候选）。 */
export interface PendingQuestion {
  missing: readonly string[];
  candidates?: readonly string[];
  raw?: string;
}

/**
 * 状态事实（供 P4/P6，非事件总线）：每次成功状态变化一条；begin 创建事实无 from
 * （不是状态转换）。
 */
export interface TaskFact {
  taskId: string;
  taskNo: number;
  name: string;
  from?: TaskStatus;
  to: TaskStatus;
  reason?: TaskReason;
  at: string;
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

/** 终态：不再有任何出边（历史与原因保留）。 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['cancelled', 'completed', 'failed', 'timed_out', 'unexecuted']);

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
}

/** 库内可变形状：对外只读视图由 TaskRecord 承担。 */
interface MutableTaskRecord extends Omit<TaskRecord, 'executions'> {
  executions: ExecutionRecord[];
}

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, MutableTaskRecord>();
  /** 内存实现的编号：与 SQLite 底账同口径（自增、不复用）——测试与纯内存嵌入用。 */
  let nextTaskNo = 0;
  let factHook: TaskFactHook | undefined;

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
  };
}
