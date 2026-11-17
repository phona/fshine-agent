/**
 * R6 测试基建 · 确定性自证：压缩生命周期判据（Pi 原生行为判据）。
 *
 * 断言：有效压缩计数、零收益连串、有界性（H6.a/H6.b）、覆盖不足与证据缺口分类**判得对**。
 * 判据面向**可观测行为**（压缩尝试 before/after、单回合模型调用计数），不绑定任何
 * fshine 私有事件名或重试常量。
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeCompaction, judgeCompactionLifecycle, R6_COMPACTION_BOUNDS,
  type CompactionAttempt, type TurnObservation,
} from './compaction';

function obs(turn: number, modelCalls: number, producedReply = true): TurnObservation {
  return { turn, transcriptTokens: 1000 * turn, transcriptMessages: turn, modelCalls, producedReply };
}
function att(turn: number, kind: CompactionAttempt['kind'], before: number, after: number, summaryChunks?: number): CompactionAttempt {
  return summaryChunks === undefined ? { turn, kind, before, after } : { turn, kind, before, after, summaryChunks };
}

describe('压缩生命周期 · analyze', () => {
  it('有效压缩 / 零收益 / overflow / 未归类 计数正确', () => {
    const a = analyzeCompaction(
      [att(1, 'threshold', 111000, 20000), att(2, 'overflow', 110000, 19000), att(3, 'post_turn', 20000, 20000), att(4, 'unknown', 21000, 22000)],
      [obs(1, 1), obs(2, 2)],
    );
    expect(a.effectiveCount).toBe(2);
    expect(a.zeroYieldCount).toBe(2);
    expect(a.overflowCount).toBe(1);
    expect(a.unclassifiedCount).toBe(1);
  });

  it('连续零收益最长连串正确', () => {
    const a = analyzeCompaction(
      [att(1, 'threshold', 100, 50), att(2, 'post_turn', 50, 50), att(3, 'post_turn', 50, 50), att(4, 'post_turn', 50, 60), att(5, 'threshold', 60, 30)],
      [obs(1, 1)],
    );
    expect(a.maxZeroYieldRun).toBe(3);
  });
});

describe('压缩生命周期 · judge', () => {
  it('3 次有效压缩、有界 → 覆盖充分且无硬零', () => {
    const a = analyzeCompaction([att(1, 'threshold', 111000, 20000), att(2, 'overflow', 110000, 19000), att(3, 'threshold', 112000, 21000)], [obs(1, 2), obs(2, 3), obs(3, 2)]);
    const v = judgeCompactionLifecycle(a);
    expect(v.hardZeroHits).toEqual([]);
    expect(v.coverageSufficient).toBe(true);
  });

  it('H6.a：连续零收益达上限 → 硬零', () => {
    const a = analyzeCompaction([att(1, 'post_turn', 100, 100), att(2, 'post_turn', 100, 110), att(3, 'post_turn', 110, 120)], [obs(1, 1)]);
    expect(judgeCompactionLifecycle(a).hardZeroHits).toContain('H6.a');
  });

  it('H6.b：单回合模型调用超上限 → 硬零', () => {
    const a = analyzeCompaction([att(1, 'threshold', 100, 50)], [obs(1, 9)]);
    expect(judgeCompactionLifecycle(a).hardZeroHits).toContain('H6.b');
  });

  it('H6.b-summaryChunks：原生暴露且超上限 → 硬零', () => {
    const a = analyzeCompaction([att(1, 'threshold', 100, 50, 20)], [obs(1, 2)]);
    expect(judgeCompactionLifecycle(a).hardZeroHits).toContain('H6.b-summaryChunks');
  });

  it('有效压缩不足 → 覆盖不足（非判负），且无硬零', () => {
    const a = analyzeCompaction([att(1, 'threshold', 100, 50)], [obs(1, 2)]);
    const v = judgeCompactionLifecycle(a);
    expect(v.coverageSufficient).toBe(false);
    expect(v.hardZeroHits).toEqual([]);
  });

  it('证据缺口：触发未归类 + 摘要分片未暴露', () => {
    const a = analyzeCompaction([att(1, 'unknown', 100, 50)], [obs(1, 2)]);
    const v = judgeCompactionLifecycle(a);
    expect(v.evidenceGaps).toContain('CMP1.trigger_unclassified');
    expect(v.evidenceGaps).toContain('CMP4.summary_chunks_unexposed');
  });

  it('预注册上限为有界（零收益 <3、单回合调用 ≤4、分片 ≤16、有效 ≥3）', () => {
    expect(R6_COMPACTION_BOUNDS).toMatchObject({ zeroYieldRunLimit: 3, modelCallsPerTurnLimit: 4, summaryChunksLimit: 16, minEffectiveCompactions: 3 });
  });
});
