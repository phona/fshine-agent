/**
 * R6 测试基建 · 证据采集器 + 三态处置（确定性、只采集事实、零模型）。
 *
 * 纪律（owner ③.2 / ③.4）：
 *   · 区分「覆盖不足 / 环境中断 / 产品故障」三态；**不得把因产品故障触发硬停或无法完成压缩的
 *     样本简单作废**（防幸存者偏差）——产品故障样本**保留并判负**，环境中断样本登记待重跑，
 *     覆盖不足样本标记为不可用但保留原始留档。
 *   · 单实验硬停保留；真实模型调用**完整计量**（含摘要调用在内，能分离则单列）。
 *   · 观测只写事实，不改触发/门控。
 *
 * 本模块是**纯函数 + 落盘**：不 import 产品运行时。落盘根 `.runtime/r6/...`（gitignored）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CompactionAttempt, TurnObservation, CompactionVerdict } from './compaction';
import type { TaskTurnFact, TaskView } from './oracle';
import type { FactFailureCode, FactVerdict, TaskVerdict } from './oracle';

export type Wave = 'Wave1' | 'Wave2';
export type Track = 'LS1' | 'LS2' | 'LS3' | 'LS4' | 'LS5';

/** 三态处置（+ 有效）。产品故障**不**作废。 */
export type SampleDisposition = 'valid' | 'insufficient_coverage' | 'environment_interrupted' | 'product_fault';

export interface TurnRecord {
  readonly index: number;
  readonly text: string;
  readonly expected?: string;
}

export interface ReplyRecord {
  readonly index: number;
  readonly text: string;
  readonly replyChars: number;
  readonly durationMs: number;
}

export interface ToolCallRecord {
  readonly turn: number;
  readonly agent: 'main' | 'worker';
  readonly seq: number;
  readonly tool: string;
  readonly args: unknown;
  readonly resultSummary: string;
  readonly elapsedMs: number;
}

export interface ResourceSample {
  readonly ts: string;
  readonly rssBytes: number;
  readonly cpuPct: number;
}

export interface BudgetUsage {
  readonly calls: number;
  readonly tokens: number;
  readonly tokensObserved: boolean;
  readonly ms: number;
  /** 能分离时的摘要调用数（Pi 原生不暴露则 null）。 */
  readonly summaryCalls: number | null;
}

export interface SessionEvidence {
  readonly wave: Wave;
  readonly track: Track;
  readonly sessionId: string;
  readonly principalId: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly limits: Readonly<Record<string, number>>;
  readonly budgetUsed: BudgetUsage;
  readonly budgetStopped: Readonly<Record<string, unknown>> | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly turns: readonly TurnRecord[];
  readonly replies: readonly ReplyRecord[];
  readonly compactionAttempts: readonly CompactionAttempt[];
  readonly tokenCurve: readonly TurnObservation[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly taskTurns: readonly TaskTurnFact[];
  readonly tasksFinal: readonly TaskView[];
  readonly resourceSamples: readonly ResourceSample[];
  /** 环境/基础设施故障信号（OOM/tmp/网络/模型 5xx）。 */
  readonly infraSignals: readonly string[];
  /** 产品故障信号（非硬零，但指向产品链路异常，如压缩链路持续报错）。 */
  readonly productFaultSignals: readonly string[];
}

/** 逐会话判定输入（Oracle 结果 + 硬零命中 + 环境信号）。 */
export interface SessionJudgement {
  readonly factVerdicts: readonly FactVerdict[];
  readonly sessionFactsPass: boolean;
  readonly factFailures: readonly FactFailureCode[];
  readonly taskVerdict: TaskVerdict;
  readonly compactionVerdict: CompactionVerdict;
}

/**
 * 三态处置（确定性规则，冻结）：
 *   1. 任一硬零命中（H1–H7）或产品故障信号 → `product_fault`（**保留并判负，不作废**）；
 *   2. 否则有环境/基础设施故障信号 → `environment_interrupted`（登记，待重跑；不判产品负）；
 *   3. 否则有效压缩不足（覆盖不足）→ `insufficient_coverage`（保留留档，样本不可用于结论）；
 *   4. 否则 → `valid`。
 * 顺序即优先级：产品故障 > 环境中断 > 覆盖不足 > 有效（产品故障不得被环境信号吞掉）。
 */
export function classifySample(evidence: SessionEvidence, judgement: SessionJudgement): SampleDisposition {
  const hardZero = judgement.taskVerdict.hardZeroHits.length > 0 || judgement.compactionVerdict.hardZeroHits.length > 0;
  if (hardZero || evidence.productFaultSignals.length > 0) return 'product_fault';
  if (evidence.infraSignals.length > 0) return 'environment_interrupted';
  if (!judgement.compactionVerdict.coverageSufficient) return 'insufficient_coverage';
  return 'valid';
}

/** 证据根目录（gitignored）。 */
export function evidenceDir(root: string, wave: Wave, track: Track, sessionId: string): string {
  return path.join(root, 'r6', wave.toLowerCase(), track.toLowerCase(), sessionId);
}

/** 汇总清单（evidence.json 内容；只陈述事实 + Oracle 结论 + 处置）。 */
export function buildEvidenceSummary(evidence: SessionEvidence, judgement: SessionJudgement): Record<string, unknown> {
  const disposition = classifySample(evidence, judgement);
  return {
    manifest: {
      sessionId: evidence.sessionId, principalId: evidence.principalId, model: evidence.model,
      contextWindow: evidence.contextWindow, wave: evidence.wave, track: evidence.track,
      limits: evidence.limits, budgetUsed: evidence.budgetUsed, budgetStopped: evidence.budgetStopped,
      startedAt: evidence.startedAt, endedAt: evidence.endedAt,
    },
    effectiveCompactions: judgement.compactionVerdict.facts['effectiveCompactions'] ?? null,
    compactionFacts: judgement.compactionVerdict.facts,
    coverageSufficient: judgement.compactionVerdict.coverageSufficient,
    evidenceGaps: judgement.compactionVerdict.evidenceGaps,
    hardZeroHits: [...judgement.taskVerdict.hardZeroHits, ...judgement.compactionVerdict.hardZeroHits],
    taskCodes: judgement.taskVerdict.codes,
    sessionFactsPass: judgement.sessionFactsPass,
    factFailures: judgement.factFailures,
    infraSignals: evidence.infraSignals,
    productFaultSignals: evidence.productFaultSignals,
    disposition,
    files: {
      turns: 'turns.jsonl', replies: 'replies.jsonl', compactionEvents: 'compaction-events.jsonl',
      tokenCurve: 'token-curve.jsonl', toolCalls: 'tool-calls.jsonl',
      tasksSnapshots: 'tasks-snapshots.jsonl', tasksFinal: 'tasks-final.json',
      resourceSamples: 'resource-samples.jsonl', manifest: 'manifest.json',
    },
  };
}

function jsonl<T>(rows: readonly T[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * 落盘逐会话证据（原始留档，未归一）；返回写入目录与摘要。
 * 全部为事实文件；判官/Oracle 只读消费（对齐 harness 设计 §五）。
 */
export function collectEvidence(root: string, evidence: SessionEvidence, judgement: SessionJudgement): {
  readonly dir: string;
  readonly summary: Record<string, unknown>;
} {
  const dir = evidenceDir(root, evidence.wave, evidence.track, evidence.sessionId);
  mkdirSync(dir, { recursive: true });
  const summary = buildEvidenceSummary(evidence, judgement);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    sessionId: evidence.sessionId, principalId: evidence.principalId, model: evidence.model,
    contextWindow: evidence.contextWindow, wave: evidence.wave, track: evidence.track,
    limits: evidence.limits, budgetUsed: evidence.budgetUsed, budgetStopped: evidence.budgetStopped,
    startedAt: evidence.startedAt, endedAt: evidence.endedAt,
  }, null, 2));
  writeFileSync(path.join(dir, 'turns.jsonl'), jsonl(evidence.turns));
  writeFileSync(path.join(dir, 'replies.jsonl'), jsonl(evidence.replies));
  writeFileSync(path.join(dir, 'compaction-events.jsonl'), jsonl(evidence.compactionAttempts));
  writeFileSync(path.join(dir, 'token-curve.jsonl'), jsonl(evidence.tokenCurve));
  writeFileSync(path.join(dir, 'tool-calls.jsonl'), jsonl(evidence.toolCalls));
  writeFileSync(path.join(dir, 'tasks-snapshots.jsonl'), jsonl(evidence.taskTurns.map((t) => ({
    turn: t.turn, tasks: t.tasks, reply: t.reply ?? null, cancelCalled: t.cancelCalled ?? false,
  }))));
  writeFileSync(path.join(dir, 'tasks-final.json'), JSON.stringify(evidence.tasksFinal, null, 2));
  writeFileSync(path.join(dir, 'resource-samples.jsonl'), jsonl(evidence.resourceSamples));
  writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(summary, null, 2));
  return { dir, summary };
}
