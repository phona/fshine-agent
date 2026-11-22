/**
 * R6 测试基建 · 会话执行管线（确定性；把负载计划跑过会话面 → 事实 → Oracle → 证据）。
 *
 * 本模块定义**会话面接口** `HarnessSession` 与管线 `runHarnessSession`。它**只采集事实**：
 *   · 逐轮 send 语料并记录回复；
 *   · 读取会话面暴露的转录体量、压缩尝试、模型调用计量、任务快照；
 *   · 交给 Oracle（事实/任务/压缩生命周期）判定；
 *   · 组装 SessionEvidence + SessionJudgement，交证据采集器落盘。
 *
 * **零真实模型**：确定性测试用 `FakeHarnessSession`（`fake-session.ts`）；Wave1 的真实模型
 * 会话由**与生产同源装配**的适配器提供同一接口（见 harness 设计 §二/§八；迁移前不接线，
 * 标注待 Wave1 前冒烟）。本模块不 import 产品运行时、不读压缩阈值、不改触发/门控。
 */
import {
  judgeFactAnswer, judgeSessionFacts, judgeTaskContinuity, parseNumbers, taskHasFact, taskFactSignature,
  type FactExpectation, type FactFailureCode, type FactVerdict, type TaskFailureCode, type TaskTurnFact, type TaskView, type TaskVerdict,
} from './oracle';
import {
  analyzeCompaction, judgeCompactionLifecycle, R6_COMPACTION_BOUNDS,
  type CompactionAnalysis, type CompactionAttempt, type CompactionBounds, type CompactionVerdict, type TurnObservation,
} from './compaction';
import type { BudgetUsage, ReplyRecord, SampleDisposition, SessionEvidence, SessionJudgement, Track, TurnRecord, Wave } from './evidence';
import { buildEvidenceSummary, classifySample } from './evidence';
import type { TrackPlan, TurnSpec } from './load-generator';
import {
  accountCalls, CallAccountingGuard, resolveLimits, R6HardStopError,
  type ModelCallRecord,
} from './accounting';
import { scanStructureLeak, type StructureLeakBounds, type StructureLeakReport } from './structure-leak';

/**
 * 一次执行调用的可移植投影（`execute_operation` 审计行；只读事实）。
 * `objects` = 本次执行参数里的字符串叶子记号（集合名/窗口等）；「执行对象是否串台」
 * 只用这份机械投影判定，不看模型自述。
 */
export interface ExecutionFact {
  readonly operation: string;
  readonly objects: readonly string[];
}

/** 一次 `task_cancel` 调用的机械结果（目标任务 + 执行层回执结果）。 */
export interface CancelFact {
  readonly taskId: string | null;
  /** `requested` = 已受理等确认；`terminal` = 目标已是终态；`cancelled` = 已确认取消。 */
  readonly outcome: string | null;
  readonly status: string | null;
}

/** 会话面（真实 = 生产同源装配适配；测试 = 假会话）。只暴露只读事实。 */
export interface HarnessSession {
  send(text: string): Promise<{ readonly reply: string; readonly taskIds: readonly string[] }>;
  /**
   * 只交办、不等后台任务收尾（background 派发下受理即返回）。用于真交错/在飞取消：
   * `deferIdle` 轮调用它；下一个非延迟轮或会话结束时由 harness `waitIdle` 统收尾。
   * 缺省 = 不支持（带 `deferIdle` 的计划会确定性拒绝，不假装交错）。
   */
  sendNoWait?(text: string): Promise<{ readonly reply: string; readonly taskIds: readonly string[] }>;
  /** 等后台任务收尾（与 `sendNoWait` 配对）。 */
  waitIdle?(): Promise<void>;
  tasks(): readonly TaskView[];
  transcriptTokens(): number;
  transcriptMessages(): number;
  /** 累计真实模型调用计量（完整计量；含摘要调用；能分离则 summaryCalls 单列）。 */
  budget(): BudgetUsage;
  /**
   * 逐次真实模型调用明细（主 / Pi 摘要 / 重试 / 溢出恢复），供**全量记账 + 先验硬停**消费。
   * 生产同源装配适配器**必须**提供（否则摘要/重试调用会漏账）；缺省缺省（undefined）时 harness
   * 退化为按 budget 调用差补记「主模型」粗记录，并在证据中标注未逐次暴露。
   */
  modelCallLedger?(): readonly ModelCallRecord[];
  /** Pi 原生 Session 生命周期暴露的压缩尝试（顺序）。 */
  compactionAttempts(): readonly CompactionAttempt[];
  /** 刚结束的一轮机械上是否调用了 task_cancel（H5 判据）。 */
  cancelCalledLastTurn(): boolean;
  /**
   * 刚结束的一轮机械上发起的执行调用（`execute_operation` 审计行）。
   * 缺省 = 会话面未暴露；此时带执行类期望的轮记为 `E-INCONCLUSIVE`（不冒充判定）。
   */
  executionsLastTurn?(): readonly ExecutionFact[];
  /**
   * 刚结束的一轮 `task_cancel` 调用结果（目标任务 + outcome/status）。
   * 缺省 = 会话面未暴露；`expectInflightCancel` 在任务已 completed 时据此区分
   * 「取消到达时目标已完成（如实迟到）」与「取消指错任务/未生效」。
   */
  cancelFactsLastTurn?(): readonly CancelFact[];
  /**
   * 本回合**被测会话 Pi 面**的模型调用数（含摘要/重试；用于 H6.b 单回合上限）。
   * 缺省 = 按 `budget().calls` 的回合差分（全部模型调用，含 Worker）。真实装配下
   * Worker 是每次委派独立的一次性 Pi 会话，其调用计入全量预算，但不算被测长会话的
   * 「回合」——不区分会把 Worker 调用误算进 H6.b。
   */
  mainModelCallsLastTurn?(): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 轮期望判定（interaction 轮可机械判定；只读会话面事实、零模型）
// ─────────────────────────────────────────────────────────────────────────────

export type TurnExpectationCheck =
  | 'no_new_task' | 'new_task' | 'no_execution' | 'execution_objects'
  | 'prev_tasks_unchanged' | 'task_fact_in' | 'reply_excludes' | 'cancel_honest'
  | 'inflight_cancel';

/** 单条轮期望判负。`code` 只复用既有枚举（预注册 §2.3 E-A..E-K 与任务码 H3/H4/H5）。 */
export interface TurnExpectationFailure {
  readonly turn: number;
  readonly label?: string;
  readonly check: TurnExpectationCheck;
  readonly code: FactFailureCode | TaskFailureCode;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface TurnExpectationVerdict {
  readonly pass: boolean;
  /** 实际执行的期望检查条数（形状自证用）。 */
  readonly checked: number;
  readonly failures: readonly TurnExpectationFailure[];
  readonly codes: readonly (FactFailureCode | TaskFailureCode)[];
}

export interface TurnExpectationContext {
  /** 该轮 send 之前的任务账本快照。 */
  readonly tasksBefore: readonly TaskView[];
  /** 该轮 send 之后的任务账本快照。 */
  readonly tasksAfter: readonly TaskView[];
  /** 该轮 `execute_operation` 审计行；null = 会话面未暴露。 */
  readonly executions: readonly ExecutionFact[] | null;
  /** 该轮 `task_cancel` 回执事实；null = 会话面未暴露。 */
  readonly cancelFacts?: readonly CancelFact[] | null;
  readonly reply: string;
}

/** 取消声称的措辞信号（与 `judgeTaskContinuity` 的 H5 同族）。 */
const CANCEL_CLAIMS: readonly string[] = ['已取消', '已经取消', '取消成功', '已帮你取消', '取消掉了'];
/** 否定词：紧邻信号之前出现即视为「未声称取消」（如「没能取消成功」「不是取消成功」）。 */
const CANCEL_NEGATIONS: readonly string[] = ['没能', '没有', '并未', '不是', '并非', '未能', '未', '没', '无法', '不能', '不可'];

/**
 * 回复是否**声称取消成功**（机械判定，去空白后按信号 + 紧邻否定词看）。
 * 「没能取消成功 / 没有取消 / 无法取消」不算声称；「已取消 / 取消成功」算。
 */
export function claimsCancel(reply: string): boolean {
  const text = compactText(reply ?? '');
  for (const signal of CANCEL_CLAIMS) {
    let from = 0;
    while (true) {
      const at = text.indexOf(signal, from);
      if (at < 0) break;
      const before = text.slice(Math.max(0, at - 4), at);
      if (!CANCEL_NEGATIONS.some((negation) => before.includes(negation))) return true;
      from = at + signal.length;
    }
  }
  return false;
}

/** 已完成目标被撤销时，回复里「如实说取消不了」的机械信号（与声称取消并存时按如实处理）。 */
const CANCEL_REFUSAL_SIGNALS: readonly string[] = [
  '取消不了', '无法取消', '不能取消', '没法取消', '无法再取消', '没法再取消',
  '早就办完', '早已办完', '已经办完', '早就跑完', '已经跑完', '已经结束', '早就结束',
  '已完成', '已是完成', '终态', '没有可取消',
];

/**
 * 回复是否**明确说明目标取消不了/早已完成**（机械信号；只看字面，不做语义判断）。
 * 与 `claimsCancel` 并用：已完成任务的诚实回执常同时提到另一个任务「已取消」。
 */
export function statesCancelRefused(reply: string): boolean {
  const text = compactText(reply ?? '');
  return CANCEL_REFUSAL_SIGNALS.some((signal) => text.includes(signal));
}

function compactText(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 回复文本负向检查：纯数字片段按「出现该数值」判，其余按去空白子串判。 */
export function replyExcludedHits(reply: string, excludes: readonly string[], scope?: string): string[] {
  const full = reply ?? '';
  // 作用域：只检查提到该对象的句子/段落（按换行与句末标点切）。
  const text = scope === undefined || scope === ''
    ? full
    : full.split(/\n+|(?<=[。！？!?])/u).filter((chunk) => chunk.includes(scope)).join('\n');
  // 引号里的内容是**提及**而非宣称（2026-11-18）：实测 N5-B 回复写「"3 条"的说法作废」——
  // 它恰是在否定那个值，却被负向词判成沿用。与收敛判据同一原则：引用≠断言。
  const withoutQuotes = text
    .replace(/“[^”]*”/g, '“”')
    .replace(/「[^」]*」/g, '「」')
    .replace(/『[^』]*』/g, '『』');
  const compact = compactText(withoutQuotes);
  const nums = parseNumbers(withoutQuotes);
  const hits: string[] = [];
  for (const raw of excludes) {
    const token = raw.trim();
    if (token === '') continue;
    if (/^-?\d+(?:\.\d+)?$/.test(token)) {
      if (nums.includes(Number(token))) hits.push(token);
      continue;
    }
    if (compact.includes(compactText(token))) hits.push(token);
  }
  return hits;
}

function pickTask(tasks: readonly TaskView[], which: 'oldest' | 'latest'): TaskView | undefined {
  if (tasks.length === 0) return undefined;
  const keyed = tasks.map((task, index) => ({ task, key: task.taskNo ?? index + 1 }));
  keyed.sort((a, b) => a.key - b.key);
  return (which === 'oldest' ? keyed[0] : keyed[keyed.length - 1])?.task;
}

function newTaskIds(before: readonly TaskView[], after: readonly TaskView[]): string[] {
  const known = new Set(before.map((task) => task.taskId));
  return after.filter((task) => !known.has(task.taskId)).map((task) => task.taskId);
}

/**
 * 判定一轮的机械期望（纯函数）。返回该轮的判负清单；空 = 通过。
 * 码的复用口径（不新造语义重复码）：
 *   · 控制意图失败（该建/不该建、不该执行、改口径未落到执行对象）→ E-D；
 *   · 任务账本被改写/状态不符 → E-G（连续性）；
 *   · 回复含不该出现的结论 → E-B（误答）；
 *   · 会话面未暴露执行审计 → E-INCONCLUSIVE（不冒充判定）。
 */
export function judgeTurnExpectations(spec: TurnSpec, ctx: TurnExpectationContext): TurnExpectationFailure[] {
  const failures: TurnExpectationFailure[] = [];
  const push = (check: TurnExpectationCheck, code: FactFailureCode | TaskFailureCode, evidence: Record<string, unknown>): void => {
    failures.push({ turn: spec.index, ...(spec.label === undefined ? {} : { label: spec.label }), check, code, evidence });
  };
  const created = newTaskIds(ctx.tasksBefore, ctx.tasksAfter);
  const countChanged = ctx.tasksBefore.length !== ctx.tasksAfter.length;

  if (spec.expectNoNewTask === true && (countChanged || created.length > 0)) {
    push('no_new_task', 'E-D', { tasksBefore: ctx.tasksBefore.length, tasksAfter: ctx.tasksAfter.length, newTaskIds: created });
  }
  if (spec.expectNewTask === true && created.length === 0) {
    push('new_task', 'E-D', { tasksBefore: ctx.tasksBefore.map((t) => t.taskId), tasksAfter: ctx.tasksAfter.map((t) => t.taskId) });
  }
  if (spec.expectNoExecution === true) {
    if (ctx.executions === null) push('no_execution', 'E-INCONCLUSIVE', { reason: 'execution_surface_missing' });
    else if (ctx.executions.length > 0) push('no_execution', 'E-D', { executions: ctx.executions.length, operations: ctx.executions.map((e) => e.operation) });
  }
  if (spec.expectExecutionObjects !== undefined && spec.expectExecutionObjects.length > 0) {
    if (ctx.executions === null) {
      push('execution_objects', 'E-INCONCLUSIVE', { reason: 'execution_surface_missing', expected: spec.expectExecutionObjects });
    } else {
      const seen = ctx.executions.flatMap((e) => e.objects);
      const missing = spec.expectExecutionObjects.filter((want) => !seen.some((got) => got.toLowerCase() === want.toLowerCase()));
      if (missing.length > 0) push('execution_objects', 'E-D', { expected: spec.expectExecutionObjects, missing, seen });
    }
  }
  if (spec.expectPrevTasksUnchanged === true) {
    const afterById = new Map(ctx.tasksAfter.map((task) => [task.taskId, task]));
    const changed: Record<string, unknown>[] = [];
    for (const before of ctx.tasksBefore) {
      const after = afterById.get(before.taskId);
      if (after === undefined) { changed.push({ taskId: before.taskId, disappeared: true }); continue; }
      if (taskFactSignature(after) !== taskFactSignature(before)) changed.push({ taskId: before.taskId, before: taskFactSignature(before), after: taskFactSignature(after) });
      if (after.requestIds.join(',') !== before.requestIds.join(',')) {
        changed.push({ taskId: before.taskId, requestIdsBefore: before.requestIds, requestIdsAfter: after.requestIds });
      }
    }
    if (changed.length > 0) push('prev_tasks_unchanged', 'E-G', { changed });
  }
  if (spec.expectTaskFactIn !== undefined) {
    const picked = pickTask(ctx.tasksAfter, spec.expectTaskFactIn.which);
    if (picked === undefined) {
      push('task_fact_in', 'E-G', { which: spec.expectTaskFactIn.which, tasksAfter: 0 });
    } else if (!spec.expectTaskFactIn.facts.some((fact) => taskHasFact(picked, fact))) {
      push('task_fact_in', 'E-G', {
        which: spec.expectTaskFactIn.which, taskId: picked.taskId,
        facts: { liveness: picked.liveness, ended: picked.ended, cancelled: picked.cancelled, reported: picked.reported, lastExecutionStatus: picked.lastExecutionStatus ?? null },
        expected: spec.expectTaskFactIn.facts,
      });
    }
  }
  if (spec.replyExcludes !== undefined && spec.replyExcludes.length > 0) {
    const hits = replyExcludedHits(ctx.reply, spec.replyExcludes, spec.replyExcludesScope);
    if (hits.length > 0) push('reply_excludes', 'E-B', { hits });
  }
  if (spec.expectCancelHonest === true) {
    const claims = claimsCancel(ctx.reply);
    const latest = pickTask(ctx.tasksAfter, spec.cancelTarget ?? 'latest');
    if (latest === undefined) {
      push('cancel_honest', 'E-D', { reason: 'no_task_to_cancel' });
    } else if (!latest.cancelled) {
      // 任务已办完（有汇报存档 / 末条执行 completed）且未声称取消 = 如实（诚实回执可能同时提到别的任务已取消）。
      const done = latest.reported || latest.lastExecutionStatus === 'completed';
      const honest = done && (!claims || statesCancelRefused(ctx.reply));
      if (!honest) {
        push('cancel_honest', 'E-D', {
          taskId: latest.taskId, which: spec.cancelTarget ?? 'latest',
          liveness: latest.liveness, ended: latest.ended, reported: latest.reported, claimsCancelled: claims,
        });
      }
    }
  }
  if (spec.expectInflightCancel === true) {
    // 在飞取消：轮前最新任务必须真的还在飞（running 或未启动排队），否则没有观测窗口（不冒充判定）。
    const before = pickTask(ctx.tasksBefore, 'latest');
    const live = before !== undefined && (before.liveness === 'running' || (before.liveness === null && !before.ended));
    if (!live) {
      push('inflight_cancel', 'E-INCONCLUSIVE', {
        reason: 'no_inflight_window',
        before: before === undefined ? null : { liveness: before.liveness, ended: before.ended, reported: before.reported },
      });
    } else {
      const after = ctx.tasksAfter.find((task) => task.taskId === before.taskId);
      if (after === undefined) {
        push('inflight_cancel', 'E-D', { taskId: before.taskId, before: { liveness: before.liveness, ended: before.ended }, after: null });
      } else if (!after.cancelled) {
        // 任务已办完还可能有两种：①取消到达时它已完成（如实迟到，pass）；
        // ②取消指错任务/未落到该任务（fail）。用 task_cancel 回执的目标与 outcome 区分。
        const facts = ctx.cancelFacts ?? null;
        if (facts === null) {
          push('inflight_cancel', 'E-INCONCLUSIVE', {
            reason: 'cancel_surface_missing', taskId: before.taskId, liveness: after.liveness, reported: after.reported,
          });
        } else {
          const targeted = facts.find((fact) => fact.taskId === before.taskId);
          // 取消到达时目标已完成 = 如实迟到（回复不得声称已取消；明确说取消不了也算如实）。
          const arrivedAfterCompletion = (after.reported || after.lastExecutionStatus === 'completed')
            && targeted?.outcome === 'terminal'
            && (!claimsCancel(ctx.reply) || statesCancelRefused(ctx.reply));
          if (!arrivedAfterCompletion) {
            push('inflight_cancel', 'E-D', {
              taskId: before.taskId, liveness: after.liveness, reported: after.reported,
              reason: targeted === undefined ? 'cancel_target_mismatch' : 'cancel_not_effective',
              cancelFacts: facts, claimsCancelled: claimsCancel(ctx.reply),
            });
          }
        }
      }
    }
  }
  return failures;
}

function countChecks(spec: TurnSpec): number {
  return [
    spec.expectNoNewTask === true, spec.expectNewTask === true, spec.expectNoExecution === true,
    spec.expectExecutionObjects !== undefined && spec.expectExecutionObjects.length > 0,
    spec.expectPrevTasksUnchanged === true, spec.expectTaskFactIn !== undefined,
    spec.replyExcludes !== undefined && spec.replyExcludes.length > 0, spec.expectCancelHonest === true,
    spec.expectInflightCancel === true,
  ].filter(Boolean).length;
}

export interface HarnessRunInput {
  readonly session: HarnessSession;
  readonly plan: TrackPlan;
  readonly wave: Wave;
  readonly track: Track;
  readonly sessionId: string;
  readonly principalId: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly limits: Readonly<Record<string, number>>;
  /** 注入墙钟（测试确定性，用于 wallMs 硬停）；缺省 `Date.now`。 */
  readonly now?: () => number;
  /**
   * 注入真实等待实现（`gapMs` 用）。缺省 = 真 `setTimeout`；测试注入以断言「真的等了」，
   * 生产路径绝不用注入时钟假装空档。
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 起点时钟；缺省固定值保证可复现。 */
  readonly at?: (turn: number) => string;
  readonly infraSignals?: readonly string[];
  readonly productFaultSignals?: readonly string[];
  readonly bounds?: CompactionBounds;
  /** 结构泄漏判据的阈值覆盖（缺省 `R6_STRUCTURE_LEAK_BOUNDS`；只影响读数）。 */
  readonly structureLeakBounds?: StructureLeakBounds;
}

export interface HarnessRunResult {
  readonly evidence: SessionEvidence;
  readonly judgement: SessionJudgement;
  readonly disposition: SampleDisposition;
  readonly summary: Readonly<Record<string, unknown>>;
  /** 结构泄漏读数（不参与 disposition；见 `structure-leak.ts`）。 */
  readonly structureLeak: StructureLeakReport;
}

const DEFAULT_AT = (turn: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString();

/** 缺省等待：真 `setTimeout`（`gapMs` 的真空档，不用注入时钟假装）。 */
const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 延迟轮缺少 `sendNoWait`：确定性拒绝（不静默退化成阻塞 send 假装交错）。 */
function requireSendNoWait(session: HarnessSession): NonNullable<HarnessSession['sendNoWait']> {
  if (typeof session.sendNoWait !== 'function') {
    throw new Error('计划含 deferIdle 轮，但会话面未提供 sendNoWait（不能假装真交错）');
  }
  return session.sendNoWait;
}

/** 延迟轮缺少 `waitIdle`：确定性拒绝（不能把在飞任务带进后续判定）。 */
function requireWaitIdle(session: HarnessSession): NonNullable<HarnessSession['waitIdle']> {
  if (typeof session.waitIdle !== 'function') {
    throw new Error('计划含 deferIdle 轮，但会话面未提供 waitIdle（不能把在飞任务带进后续判定）');
  }
  return session.waitIdle;
}

/**
 * 跑一遍会话计划：逐轮注入真实内容 → 采集事实 → Oracle 判定 → 组装证据。
 * 结束条件不由本函数决定压缩时机——它只把计划跑完；是否继续追加推进轮由调用方按压缩计数决定。
 */
export async function runHarnessSession(input: HarnessRunInput): Promise<HarnessRunResult> {
  const { session, plan } = input;
  const at = input.at ?? DEFAULT_AT;
  const sleep = input.sleep ?? DEFAULT_SLEEP;
  const startedAt = at(0);
  const turns: TurnRecord[] = [];
  const replies: ReplyRecord[] = [];
  const tokenCurve: TurnObservation[] = [];
  const taskTurns: TaskTurnFact[] = [];
  const factVerdicts: FactVerdict[] = [];
  const factAnswers: { expectation: FactExpectation; reply: string }[] = [];
  const expectationFailures: TurnExpectationFailure[] = [];
  let expectationChecks = 0;
  /** 上一轮是 `deferIdle`（后台任务未收尾），下一非延迟轮发送前需先 `waitIdle`。 */
  let pendingIdle = false;

  // 全量记账 + 单实验硬停（先验拒绝）：上限取 R6 预注册 §十三.D 冻结值（缺省），
  // limits 仅用于测试注入更小上限做确定性验证。
  const guard = new CallAccountingGuard(
    resolveLimits(input.limits),
    input.now ? { now: input.now } : {},
  );
  const hasLedger = typeof session.modelCallLedger === 'function';
  const derivedRecords: ModelCallRecord[] = [];
  let hardStop: Readonly<Record<string, unknown>> | null = null;

  for (const spec of plan.turns) {
    // ① 先验：达上限即拒绝发起本回合请求（有界失败，不靠模型自觉）。
    try {
      guard.precheck();
    } catch (error) {
      if (error instanceof R6HardStopError) { hardStop = { ...error.stop }; break; }
      throw error;
    }
    // ② 真实空档（`gapMs`）：在 send 之前用真 setTimeout 等满，不用注入时钟假装。
    if (spec.gapMs !== undefined && spec.gapMs > 0) await sleep(spec.gapMs);
    // ②' 上一个延迟轮的后台任务在**本轮发送前**收尾：保证本轮看到的账本/结论是落定后的。
    if (spec.deferIdle !== true && pendingIdle) {
      await requireWaitIdle(session).call(session);
      pendingIdle = false;
    }
    turns.push({
      index: spec.index, text: spec.text,
      ...(spec.fact ? { expected: JSON.stringify(spec.fact) } : {}),
      ...(spec.gapMs === undefined ? {} : { gapMs: spec.gapMs }),
      ...(spec.deferIdle === true ? { deferIdle: true } : {}),
    });
    const callsBefore = session.budget().calls;
    const tokensBefore = session.transcriptTokens();
    const messagesBefore = session.transcriptMessages();
    // 轮前后任务账本快照（`expectNoNewTask` / `expectNewTask` / 状态保持的机械依据）。
    const tasksBefore = session.tasks();
    // `deferIdle` 轮只交办（受理即返回），其余轮与既有语义一致（send 内等到 idle）。
    const result = spec.deferIdle === true
      ? await requireSendNoWait(session).call(session, spec.text)
      : await session.send(spec.text);
    if (spec.deferIdle === true && spec.settleBeforeJudge === true) {
      await requireWaitIdle(session).call(session);
      pendingIdle = false;
    } else if (spec.deferIdle === true) {
      pendingIdle = true;
    }
    const reply = result.reply ?? '';
    replies.push({ index: spec.index, text: reply, replyChars: reply.length, durationMs: 0 });
    const callsDelta = session.mainModelCallsLastTurn !== undefined
      ? session.mainModelCallsLastTurn()
      : session.budget().calls - callsBefore;
    // ③ 回填累计逐次调用记录（摘要独立于 budget hook 计数）。
    if (hasLedger) {
      guard.replace((session.modelCallLedger?.() ?? []).map((r) => ({ ...r, sessionId: input.sessionId })));
    } else {
      // 会话面未暴露逐次明细：按 budget 调用差补记「主模型」粗记录（token 未观测，不虚增）。
      const budgetCalls = session.budget().calls;
      while (derivedRecords.length < budgetCalls) {
        derivedRecords.push({
          seq: derivedRecords.length + 1, kind: 'main', sessionId: input.sessionId, turn: spec.index,
          tokens: { input: 0, output: 0, total: 0 }, tokensObserved: false, durationMs: 0,
        });
      }
      guard.replace(derivedRecords);
    }
    tokenCurve.push({
      turn: spec.index,
      transcriptTokens: session.transcriptTokens(),
      transcriptMessages: session.transcriptMessages(),
      modelCalls: callsDelta,
      producedReply: reply.trim().length > 0,
    });
    taskTurns.push({
      turn: spec.index,
      tasks: session.tasks(),
      reply,
      cancelCalled: session.cancelCalledLastTurn(),
    });
    if (spec.fact) {
      factVerdicts.push(judgeFactAnswer(spec.fact, reply));
      factAnswers.push({ expectation: spec.fact, reply });
    }
    // ④ 轮期望（interaction 轮也判定；全部只看会话面机械事实）。
    expectationChecks += countChecks(spec);
    const executions = typeof session.executionsLastTurn === 'function'
      ? session.executionsLastTurn()
      : null;
    const cancelFacts = typeof session.cancelFactsLastTurn === 'function'
      ? session.cancelFactsLastTurn()
      : null;
    expectationFailures.push(...judgeTurnExpectations(spec, {
      tasksBefore, tasksAfter: session.tasks(), executions, cancelFacts, reply,
    }));
    // tokensBefore/messagesBefore 供后续扩展（当前不参与判定；保留以留观测钩子）。
    void tokensBefore; void messagesBefore;
  }

  // 计划以延迟轮收尾（例如最后一个交互轮只交办）：等后台收尾后再组装证据与判定。
  if (pendingIdle) {
    await requireWaitIdle(session).call(session);
    pendingIdle = false;
  }

  const sessionFacts = judgeSessionFacts(factAnswers);
  const taskVerdict: TaskVerdict = judgeTaskContinuity(taskTurns);
  const turnExpectations: TurnExpectationVerdict = {
    pass: expectationFailures.length === 0,
    checked: expectationChecks,
    failures: expectationFailures,
    codes: [...new Set(expectationFailures.map((failure) => failure.code))],
  };
  const attempts = session.compactionAttempts();
  const analysis: CompactionAnalysis = analyzeCompaction(attempts, tokenCurve);
  const compactionVerdict: CompactionVerdict = judgeCompactionLifecycle(analysis, input.bounds ?? R6_COMPACTION_BOUNDS);

  const evidence: SessionEvidence = {
    wave: input.wave, track: input.track, sessionId: input.sessionId,
    principalId: input.principalId, model: input.model, contextWindow: input.contextWindow,
    limits: input.limits, budgetUsed: session.budget(), budgetStopped: hardStop,
    startedAt, endedAt: at(plan.turns.length),
    turns, replies, compactionAttempts: attempts, tokenCurve,
    modelCalls: guard.ledger(), callAccounting: guard.usage(),
    toolCalls: [], taskTurns, tasksFinal: session.tasks(), resourceSamples: [],
    infraSignals: input.infraSignals ?? [], productFaultSignals: input.productFaultSignals ?? [],
  };
  const judgement: SessionJudgement = {
    factVerdicts, sessionFactsPass: sessionFacts.pass, factFailures: sessionFacts.failures,
    taskVerdict, compactionVerdict, turnExpectations,
  };
  // 结构泄漏 = 只读读数：扫描已记录的回复与工具调用，不新增模型调用、不参与处置。
  const structureLeak = scanStructureLeak(
    { replies: evidence.replies, toolCalls: evidence.toolCalls },
    input.structureLeakBounds,
  );
  return {
    evidence, judgement,
    disposition: classifySample(evidence, judgement),
    summary: buildEvidenceSummary(evidence, judgement, structureLeak),
    structureLeak,
  };
}
