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
  judgeFactAnswer, judgeSessionFacts, judgeTaskContinuity,
  type FactExpectation, type FactVerdict, type TaskTurnFact, type TaskView, type TaskVerdict,
} from './oracle';
import {
  analyzeCompaction, judgeCompactionLifecycle, R6_COMPACTION_BOUNDS,
  type CompactionAnalysis, type CompactionAttempt, type CompactionBounds, type CompactionVerdict, type TurnObservation,
} from './compaction';
import type { BudgetUsage, ReplyRecord, SampleDisposition, SessionEvidence, SessionJudgement, Track, TurnRecord, Wave } from './evidence';
import { buildEvidenceSummary, classifySample } from './evidence';
import type { TrackPlan } from './load-generator';
import {
  accountCalls, CallAccountingGuard, resolveLimits, R6HardStopError,
  type ModelCallRecord,
} from './accounting';
import { scanStructureLeak, type StructureLeakBounds, type StructureLeakReport } from './structure-leak';

/** 会话面（真实 = 生产同源装配适配；测试 = 假会话）。只暴露只读事实。 */
export interface HarnessSession {
  send(text: string): Promise<{ readonly reply: string; readonly taskIds: readonly string[] }>;
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

/**
 * 跑一遍会话计划：逐轮注入真实内容 → 采集事实 → Oracle 判定 → 组装证据。
 * 结束条件不由本函数决定压缩时机——它只把计划跑完；是否继续追加推进轮由调用方按压缩计数决定。
 */
export async function runHarnessSession(input: HarnessRunInput): Promise<HarnessRunResult> {
  const { session, plan } = input;
  const at = input.at ?? DEFAULT_AT;
  const startedAt = at(0);
  const turns: TurnRecord[] = [];
  const replies: ReplyRecord[] = [];
  const tokenCurve: TurnObservation[] = [];
  const taskTurns: TaskTurnFact[] = [];
  const factVerdicts: FactVerdict[] = [];
  const factAnswers: { expectation: FactExpectation; reply: string }[] = [];

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
    turns.push({ index: spec.index, text: spec.text, ...(spec.fact ? { expected: JSON.stringify(spec.fact) } : {}) });
    const callsBefore = session.budget().calls;
    const tokensBefore = session.transcriptTokens();
    const messagesBefore = session.transcriptMessages();
    const result = await session.send(spec.text);
    const reply = result.reply ?? '';
    replies.push({ index: spec.index, text: reply, replyChars: reply.length, durationMs: 0 });
    const callsDelta = session.budget().calls - callsBefore;
    // ② 回填累计逐次调用记录（摘要独立于 budget hook 计数）。
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
    // tokensBefore/messagesBefore 供后续扩展（当前不参与判定；保留以留观测钩子）。
    void tokensBefore; void messagesBefore;
  }

  const sessionFacts = judgeSessionFacts(factAnswers);
  const taskVerdict: TaskVerdict = judgeTaskContinuity(taskTurns);
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
    taskVerdict, compactionVerdict,
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
