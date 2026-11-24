/**
 * R6 测试基建 · 确定性自证：三态处置 + 证据采集器 schema。
 */
import { describe, it, expect } from 'vitest';
import { classifySample, collectEvidence, buildEvidenceSummary, type SessionEvidence, type SessionJudgement } from './evidence';
import { analyzeCompaction, judgeCompactionLifecycle } from './compaction';
import { judgeTaskContinuity } from './oracle';
import { accountCalls } from './accounting';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkEvidence(overrides: Partial<SessionEvidence> = {}): SessionEvidence {
  return {
    wave: 'Wave1', track: 'LS1', sessionId: 's1', principalId: 'p', model: 'step-3.7-flash',
    contextWindow: 128000, limits: {}, budgetUsed: { calls: 0, tokens: 0, tokensObserved: false, ms: 0, summaryCalls: null },
    budgetStopped: null, startedAt: 'T0', endedAt: 'T1',
    turns: [], replies: [], compactionAttempts: [], tokenCurve: [], toolCalls: [],
    modelCalls: [], callAccounting: accountCalls([]),
    taskTurns: [], tasksFinal: [], resourceSamples: [], infraSignals: [], productFaultSignals: [],
    ...overrides,
  };
}

/** 构造 judgement：effectiveCompactions 控制覆盖；hardZero 控制任务硬零。 */
function mkJudgement(opts: { effective: number; hardZero?: boolean }): SessionJudgement {
  const attempts = Array.from({ length: opts.effective }, (_, i) => ({ turn: i + 1, kind: 'threshold' as const, before: 100000, after: 20000 }));
  const compactionVerdict = judgeCompactionLifecycle(analyzeCompaction(attempts, []));
  const taskVerdict = opts.hardZero
    ? judgeTaskContinuity([{ turn: 1, tasks: [{ taskId: 't1', request: 'r', started: true, ended: true, reported: true, waiting: false, mayBeRunning: false, requestIds: [] }] }])
    : judgeTaskContinuity([]);
  return { factVerdicts: [], sessionFactsPass: true, factFailures: [], taskVerdict, compactionVerdict };
}

describe('三态处置（优先序：产品故障 > 环境中断 > 覆盖不足 > 有效）', () => {
  it('硬零命中 → product_fault（保留判负，不作废）', () => {
    expect(classifySample(mkEvidence(), mkJudgement({ effective: 3, hardZero: true }))).toBe('product_fault');
  });

  it('产品故障信号 → product_fault', () => {
    expect(classifySample(mkEvidence({ productFaultSignals: ['compaction_chain_error'] }), mkJudgement({ effective: 3 }))).toBe('product_fault');
  });

  it('产品故障优先于环境信号：产品故障不被环境信号吞掉', () => {
    expect(classifySample(mkEvidence({ productFaultSignals: ['x'], infraSignals: ['ECONNRESET'] }), mkJudgement({ effective: 3 }))).toBe('product_fault');
  });

  it('环境中断 → environment_interrupted（登记待重跑，不判产品负）', () => {
    expect(classifySample(mkEvidence({ infraSignals: ['ECONNRESET'] }), mkJudgement({ effective: 3 }))).toBe('environment_interrupted');
  });

  it('有效压缩不足 → insufficient_coverage（保留留档）', () => {
    expect(classifySample(mkEvidence(), mkJudgement({ effective: 1 }))).toBe('insufficient_coverage');
  });

  it('达标且无故障 → valid', () => {
    expect(classifySample(mkEvidence(), mkJudgement({ effective: 3 }))).toBe('valid');
  });
});

describe('证据采集器 · schema 落盘', () => {
  it('schema 文件齐全，evidence.json 含处置、硬零与全量记账', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'r6-ev-'));
    try {
      const evidence = mkEvidence();
      const judgement = mkJudgement({ effective: 3 });
      const { dir, summary } = collectEvidence(tmp, evidence, judgement);
      const expected = ['manifest.json', 'turns.jsonl', 'replies.jsonl', 'compaction-events.jsonl', 'token-curve.jsonl', 'model-calls.jsonl', 'tool-calls.jsonl', 'tasks-snapshots.jsonl', 'tasks-final.json', 'resource-samples.jsonl', 'structure-leak.jsonl', 'evidence.json'];
      const present = readdirSync(dir);
      for (const f of expected) expect(present).toContain(f);
      expect(summary['disposition']).toBe('valid');
      expect(summary['effectiveCompactions']).toBe(3);
      expect(buildEvidenceSummary(evidence, judgement)['hardZeroHits']).toEqual([]);
      const structureLeak = summary['structureLeak'] as Record<string, unknown>;
      expect(structureLeak['affectsDisposition']).toBe(false);
      expect(structureLeak['totalHits']).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
