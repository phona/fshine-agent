/**
 * Phase 2 pure-module tests: step cap, handover file, proposal review,
 * committed_unverified classifier, tool-definition guard. No model, no
 * platform, no network: every assertion is deterministic.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKER_STEP_CAP, parseStepCap, stepCapDecision } from './worker-step-cap';
import {
  HANDOVER_VERSION,
  mergeExecutedCalls,
  parseHandover,
  readHandoverFile,
  serializeHandover,
  writeHandoverFile,
  type TaskHandover,
} from './task-handover';
import { mechanicalReview, parseReviewReply, reviewProposalWithDriver } from './proposal-review';
import { isCommittedUnverified, renderCommittedUnverifiedReply } from './committed-unverified';
import { decideToolDefinitionGuard } from './tool-definition-guard';
import { decideTurnExit } from './turn-exit';
import type { TurnDriver } from './driver';

describe('step cap', () => {
  it('defaults to 50', () => {
    expect(DEFAULT_WORKER_STEP_CAP).toBe(50);
    expect(stepCapDecision(50).windDown).toBe(false);
    expect(stepCapDecision(50).remaining).toBe(0);
  });
  it('fires wind-down on the 51st allowed call, not before', () => {
    expect(stepCapDecision(49).windDown).toBe(false);
    expect(stepCapDecision(50).windDown).toBe(false);
    expect(stepCapDecision(51).windDown).toBe(true);
    expect(stepCapDecision(51).remaining).toBe(0);
  });
  it('is configurable and rejects invalid values', () => {
    expect(stepCapDecision(3, 2).windDown).toBe(true);
    expect(parseStepCap('10')).toBe(10);
    expect(parseStepCap('abc')).toBe(DEFAULT_WORKER_STEP_CAP);
    expect(parseStepCap(0)).toBe(DEFAULT_WORKER_STEP_CAP);
  });
});

const handover = (over: Partial<TaskHandover> = {}): TaskHandover => ({
  version: HANDOVER_VERSION,
  taskId: 'task-1',
  planId: 'plan-1',
  planVersion: 2,
  completedSteps: ['step-a'],
  executedCalls: [{ operation: 'dummy.query', args: ['--record', 'alpha'] }],
  unfinishedSteps: ['step-b'],
  nextAction: 'run step-b',
  lastResultSummary: 'alpha read ok',
  updatedAt: '2026-11-04T00:00:00.000Z',
  ...over,
});

describe('task handover', () => {
  it('round-trips through serialize/parse', () => {
    expect(parseHandover(serializeHandover(handover()))).toEqual(handover());
  });
  it('rejects a wrong version and a non-JSON file', () => {
    expect(parseHandover(JSON.stringify({ ...handover(), version: 99 }))).toBeNull();
    expect(parseHandover('not json')).toBeNull();
  });
  it('writes and reads the file from the task workspace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fshine-handover-'));
    writeHandoverFile(root, 'task-1', handover());
    expect(readHandoverFile(root, 'task-1')).toEqual(handover());
    expect(readHandoverFile(root, 'task-missing')).toBeNull();
  });
  it('does not double-count executed calls on resume', () => {
    const already = [{ operation: 'dummy.query', args: ['--record', 'alpha'] }];
    const from = [
      { operation: 'dummy.query', args: ['--record', 'alpha'] },
      { operation: 'dummy.query', args: ['--record', 'beta'] },
    ];
    expect(mergeExecutedCalls(already, from)).toHaveLength(2);
  });
});

describe('proposal review', () => {
  it('blocks a failed dry-run and an empty summary without a model', () => {
    expect(mechanicalReview({ proposalSchema: {}, dryRunEnvelope: { status: 'failed' }, summaryText: 'x' })?.verdict).toBe('inconsistent');
    expect(mechanicalReview({ proposalSchema: {}, dryRunEnvelope: { status: 'completed' }, summaryText: '  ' })?.verdict).toBe('inconsistent');
    expect(mechanicalReview({ proposalSchema: {}, dryRunEnvelope: { status: 'completed' }, summaryText: 'x' })).toBeNull();
  });
  it('accepts a strict-JSON consistent reply and rejects garbage', () => {
    expect(parseReviewReply('{"verdict":"consistent","fields":[]}')).toEqual({ verdict: 'consistent', fields: [] });
    expect(parseReviewReply('looks fine')).toBeNull();
    expect(parseReviewReply('{"verdict":"maybe","fields":[]}')).toBeNull();
  });
  it('fail-closes when the reviewer turn throws', async () => {
    const throwing: TurnDriver = {
      run: async () => { throw new Error('model down'); },
    } as unknown as TurnDriver;
    const verdict = await reviewProposalWithDriver(
      throwing,
      { proposalSchema: {}, dryRunEnvelope: { status: 'completed', data: {} }, summaryText: 'x' },
    );
    expect(verdict.verdict).toBe('inconsistent');
  });
});

describe('committed_unverified', () => {
  it('classifies readback-short as committed_unverified, not success and not plain failure', () => {
    expect(isCommittedUnverified({ ok: false, verified: false, errorCode: 'PROPOSAL_VERIFY_SHORT' })).toBe(true);
    expect(isCommittedUnverified({ ok: false, verified: false, readBack: { before: 1, after: 2, delta: 1, required: 2 } })).toBe(true);
    expect(isCommittedUnverified({ ok: true, verified: true })).toBe(false);
    expect(isCommittedUnverified({ ok: false, verified: false, readBack: { before: 1, after: 3, delta: 2, required: 2 } })).toBe(false);
  });
  it('renders the never-completed report with a reconciliation entry', () => {
    const text = renderCommittedUnverifiedReply({ before: 1, after: 2, delta: 1, required: 2 });
    expect(text).toContain('已落账、读回不足、需人工核对');
    expect(text).toContain('人工核对入口');
    expect(text).not.toContain('已完成');
  });
});

describe('tool-definition guard', () => {
  it('blocks a formatted answer when tools were removed and nothing executed', () => {
    expect(decideToolDefinitionGuard({ toolsPresent: false, execution: false }).blocked).toBe(true);
    expect(decideToolDefinitionGuard({ toolsPresent: true, execution: false }).blocked).toBe(false);
    expect(decideToolDefinitionGuard({ toolsPresent: false, execution: true }).blocked).toBe(false);
  });
  it('scripted turn: a formatted fake answer with zero execution is blocked by turn-exit, not passed through', () => {
    // Scripted, not a real model: the "model" text is a fixed string that
    // looks like a completed answer. The host gate, not the text, decides.
    const decision = decideTurnExit({
      delegationFailed: false,
      execution: false,
      pendingPlan: false,
      resultPendingPlan: false,
      intentKind: 'delegate',
      backgroundStarted: false,
      backgroundTaskId: null,
      backgroundRunId: null,
      backgroundTaskState: null,
      backgroundReceiptText: null,
      needsLoop: false,
      planModeTurn: false,
      needsRounds: 0,
      planSteps: 0,
      planStepOutcomes: [],
      lastNeeds: null,
      activatedPlan: null,
      protocolReplay: false,
      resultText: '已完成：共 2 条记录，合计 61000。',
      hasFinancialFigure: (text) => /\d/.test(text),
      usefulWorkerNote: () => '',
    });
    expect(decision.kind).not.toBe('ok');
    expect(decideToolDefinitionGuard({ toolsPresent: false, execution: false }).blocked).toBe(true);
  });
});
