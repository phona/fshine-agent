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

/** 会话面（真实 = 生产同源装配适配；测试 = 假会话）。只暴露只读事实。 */
export interface HarnessSession {
  send(text: string): Promise<{ readonly reply: string; readonly taskIds: readonly string[] }>;
  tasks(): readonly TaskView[];
  transcriptTokens(): number;
  transcriptMessages(): number;
  /** 累计真实模型调用计量（完整计量；含摘要调用；能分离则 summaryCalls 单列）。 */
  budget(): BudgetUsage;
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
  /** 起点时钟；缺省固定值保证可复现。 */
  readonly at?: (turn: number) => string;
  readonly infraSignals?: readonly string[];
  readonly productFaultSignals?: readonly string[];
  readonly bounds?: CompactionBounds;
}

export interface HarnessRunResult {
  readonly evidence: SessionEvidence;
  readonly judgement: SessionJudgement;
  readonly disposition: SampleDisposition;
  readonly summary: Readonly<Record<string, unknown>>;
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

  for (const spec of plan.turns) {
    turns.push({ index: spec.index, text: spec.text, ...(spec.fact ? { expected: JSON.stringify(spec.fact) } : {}) });
    const callsBefore = session.budget().calls;
    const tokensBefore = session.transcriptTokens();
    const messagesBefore = session.transcriptMessages();
    const result = await session.send(spec.text);
    const reply = result.reply ?? '';
    replies.push({ index: spec.index, text: reply, replyChars: reply.length, durationMs: 0 });
    const callsDelta = session.budget().calls - callsBefore;
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
    limits: input.limits, budgetUsed: session.budget(), budgetStopped: null,
    startedAt, endedAt: at(plan.turns.length),
    turns, replies, compactionAttempts: attempts, tokenCurve,
    toolCalls: [], taskTurns, tasksFinal: session.tasks(), resourceSamples: [],
    infraSignals: input.infraSignals ?? [], productFaultSignals: input.productFaultSignals ?? [],
  };
  const judgement: SessionJudgement = {
    factVerdicts, sessionFactsPass: sessionFacts.pass, factFailures: sessionFacts.failures,
    taskVerdict, compactionVerdict,
  };
  return {
    evidence, judgement,
    disposition: classifySample(evidence, judgement),
    summary: buildEvidenceSummary(evidence, judgement),
  };
}
