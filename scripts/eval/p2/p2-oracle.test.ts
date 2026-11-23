/**
 * P2 判定层单测（确定性、零模型）：冻结口径逐条钉住 + 反向绊线。
 *
 * 覆盖：
 *   · 记账四类（main/summary/retry/overflow_recovery）分类；
 *   · 三态处置接缝 `classifyP2Sample`（含「R6 压缩覆盖不足不外溢」的口径）；
 *   · 事实/任务/机械硬零映射；编造数值禁令；
 *   · 脚本表匹配与耗尽抛错；`evidence.ts` 的 Track 扩展不改变 classifySample 行为。
 */
import { describe, expect, it } from 'vitest';
import type { SessionEvidence, SessionJudgement } from '../long-session/evidence';
import { classifySample } from '../long-session/evidence';
import { judgeTaskContinuity, type TaskTurnFact } from '../long-session/oracle';
import { accountCalls } from '../long-session/accounting';
import { classifyModelCall, judgementOf, looksLikeSummaryRequest, P2ScriptBook, sessionEvidenceOf } from './p2-harness';
import {
  assertNoFabricatedNumbers, claimsCompletion, classifyP2Sample,
  coverageOf, judgeP2Case, sampleRecordOf,
} from './p2-oracle';
import { textAssistant } from '../business-e2e/shared-instance';
import type { P2CaseDefinition, P2Observation } from './p2-types';

function emptyEvidence(): SessionEvidence {
  return sessionEvidenceOf({
    sessionId: 'wecom:test', principalId: 'wecom:test-user',
    turns: [{ index: 1, text: '查询 alpha', reply: 'alpha 共 2 条' }],
    taskTurns: [], tasksFinal: [], modelCalls: [],
  });
}

function emptyJudgement(): SessionJudgement {
  return judgementOf({ facts: [], taskTurns: [] });
}

function baseCase(overrides: Partial<P2CaseDefinition> = {}): P2CaseDefinition {
  return {
    id: 'T1', scenario: 'S1', title: 't', objective: 't',
    turns: ['查询 alpha'], mode: 'inline',
    granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
    hardZeros: [], failureCriteria: [], truth: { facts: [] },
    coverage: (obs) => coverageOf('S1', obs.turns.length > 0, {}),
    checks: () => [],
    ...overrides,
  };
}

function observationWith(partial: Partial<P2Observation>): P2Observation {
  const base: P2Observation = {
    caseId: 'T1', scenario: 'S1', principalId: 'wecom:test-user', sessionId: 'wecom:test',
    mode: 'inline',
    turns: [{ index: 1, text: '查询 alpha', reply: 'alpha 共 2 条，总额 2000。', taskIds: [] }],
    taskTurns: [], tasksFinal: [], execRecords: [], toolCalls: [], deliveries: [],
    modelCalls: [], compactionAttempts: [], transcriptTexts: [],
    evidence: emptyEvidence(), judgement: emptyJudgement(), extras: {},
  };
  return { ...base, ...partial };
}

describe('记账四类分类（预注册 §3.3）', () => {
  it('主调用 → main', () => {
    expect(classifyModelCall({ summaryRequest: false })).toBe('main');
  });
  it('上一请求失败/中止 → retry', () => {
    expect(classifyModelCall({ previousStopReason: 'error', summaryRequest: false })).toBe('retry');
    expect(classifyModelCall({ previousStopReason: 'aborted', summaryRequest: false })).toBe('retry');
  });
  it('上一请求因长度截断 → overflow_recovery', () => {
    expect(classifyModelCall({ previousStopReason: 'length', summaryRequest: false })).toBe('overflow_recovery');
  });
  it('压缩摘要请求 → summary', () => {
    expect(classifyModelCall({ summaryRequest: true })).toBe('summary');
  });
  it('摘要请求识别：无 user 轮次或系统提示含摘要指令', () => {
    expect(looksLikeSummaryRequest({ messages: [{ role: 'assistant', content: 'x' }] })).toBe(true);
    expect(looksLikeSummaryRequest({ messages: [{ role: 'user', content: 'x' }], systemPrompt: '请生成会话摘要' })).toBe(true);
    expect(looksLikeSummaryRequest({ messages: [{ role: 'user', content: 'x' }], systemPrompt: 'worker' })).toBe(false);
  });
});

describe('三态处置接缝 classifyP2Sample（预注册 §5.1）', () => {
  it('产品故障优先：硬零命中 → product_fault（即使 P2 覆盖也不足）', () => {
    const evidence = emptyEvidence();
    const judgement: SessionJudgement = {
      ...emptyJudgement(),
      taskVerdict: judgeTaskContinuity([{ turn: 1, tasks: [{ taskId: 't', request: 'x', started: true, ended: true, reported: true, waiting: false, mayBeRunning: false, requestIds: [] }] }]),
    };
    expect(classifyP2Sample({ evidence, judgement, coverage: coverageOf('S1', false, {}) })).toBe('product_fault');
  });

  it('环境中断次之：仅 infra 信号 → environment_interrupted', () => {
    const evidence = { ...emptyEvidence(), infraSignals: ['OOM'] };
    expect(classifyP2Sample({ evidence, judgement: emptyJudgement(), coverage: coverageOf('S1', true, {}) }))
      .toBe('environment_interrupted');
  });

  it('R6 压缩覆盖不足不外溢：无压缩但 P2 覆盖成立 → valid', () => {
    const evidence = emptyEvidence();
    const judgement = emptyJudgement();
    // R6 自身会判覆盖不足（无 ≥3 次有效压缩）——这正是接缝要处理的差异。
    expect(classifySample(evidence, judgement)).toBe('insufficient_coverage');
    expect(classifyP2Sample({ evidence, judgement, coverage: coverageOf('S1', true, {}) })).toBe('valid');
  });

  it('P2 覆盖不足 → insufficient_coverage（不折算成失败）', () => {
    expect(classifyP2Sample({ evidence: emptyEvidence(), judgement: emptyJudgement(), coverage: coverageOf('S2', false, {}) }))
      .toBe('insufficient_coverage');
  });
});

describe('证据层 Track 扩展守卫（P2 标签不改变 classifySample 语义）', () => {
  it('track=P2 与 track=LS1 的处置判定一致', () => {
    const ls1 = { ...emptyEvidence(), track: 'LS1' as const };
    const p2 = { ...emptyEvidence(), track: 'P2' as const };
    const judgement = emptyJudgement();
    expect(classifySample(p2, judgement)).toBe(classifySample(ls1, judgement));
  });
});

describe('硬零/编造数值', () => {
  it('虚假完成：回复称「已完成」但零执行 → falseCompletion=1（H4 同源硬零）', () => {
    const caseDef = baseCase();
    const obs = observationWith({
      turns: [{ index: 1, text: '查询 alpha', reply: '已完成 alpha 核对。', taskIds: [] }],
    });
    const judgement = judgeP2Case(caseDef, obs);
    expect(judgement.mechanical.violations.falseCompletion).toBe(1);
    expect(judgement.hardZeroHits).toContain('false_completion');
    expect(judgement.pass).toBe(false);
  });

  it('越权执行：执行对象不在授予范围 → unauthorized（severe）', () => {
    const caseDef = baseCase();
    const obs = observationWith({
      execRecords: [{
        requestId: 'req_1', operation: 'dummy.query', args: { '--collection': 'beta' },
        collection: 'beta', status: 'completed',
      }],
    });
    const judgement = judgeP2Case(caseDef, obs);
    expect(judgement.mechanical.violations.unauthorized).toBe(1);
    expect(judgement.mechanical.severity).toBe('severe');
    expect(judgement.hardZeroHits).toContain('unauthorized');
  });

  it('机械样本记录把执行层四态如实投影（completed/failed/refused）', () => {
    const caseDef = baseCase();
    const obs = observationWith({
      execRecords: [
        { requestId: 'a', operation: 'dummy.query', args: { '--collection': 'alpha', '--window': 'W1' }, collection: 'alpha', status: 'completed' },
        { requestId: 'b', operation: 'dummy.query', args: { '--collection': 'alpha', '--window': 'W1' }, collection: 'alpha', status: 'failed', errorCode: 'COLLECTION_FAULT' },
      ],
    });
    const sample = sampleRecordOf(caseDef, obs);
    expect(sample.executions.map((execution) => execution.status)).toEqual(['completed', 'failed']);
    expect(sample.executions[1]?.error?.code).toBe('COLLECTION_FAULT');
  });

  it('编造数值：失败回合出现真值外数字 → 判红（窗口编码不算编造）', () => {
    const ok = assertNoFabricatedNumbers('读取 faulty-one W1 失败，没有条数或金额。', []);
    expect(ok.pass).toBe(true);
    const bad = assertNoFabricatedNumbers('读取失败，但看着像 2 条。', []);
    expect(bad.pass).toBe(false);
    expect(bad.hardZero).toBe(true);
  });

  it('「已完成」关键词判定（虚假完成判据输入）', () => {
    expect(claimsCompletion('任务已完成。')).toBe(true);
    expect(claimsCompletion('已超时未完成。')).toBe(false);
    expect(claimsCompletion('读取失败，没有完成。')).toBe(false);
  });
});

describe('脚本表（P2ScriptBook）', () => {
  it('Main 精确匹配、Worker 子串匹配；耗尽即抛（不静默通过）', () => {
    const book = new P2ScriptBook();
    book.mainTurn('查询 alpha', [textAssistant('ok')], 1);
    book.workerTask('核对 alpha 集合', [textAssistant('worker ok')]);
    expect(book.response('main', { messages: [{ role: 'user', content: '查询 alpha' }] })).toBeDefined();
    // 第二次 Main 调用：脚本耗尽
    expect(() => book.response('main', { messages: [{ role: 'user', content: '查询 alpha' }] })).toThrow(/响应耗尽/);
    const worker = book.response('worker', {
      messages: [{ role: 'user', content: '宿主委派：请核对 alpha 集合 W1 的记录（快照如下）' }],
    });
    expect(worker).toBeDefined();
    expect(() => book.response('main', { messages: [{ role: 'user', content: '未知话术' }] })).toThrow(/脚本缺失/);
  });

  it('逐次调用记账按类别累加，且记录所属键与回合号', () => {
    const book = new P2ScriptBook();
    book.mainTurn('第一轮', [textAssistant('a'), textAssistant('b')], 1);
    book.response('main', { messages: [{ role: 'user', content: '第一轮' }] });
    book.response('main', { messages: [{ role: 'user', content: '第一轮' }] });
    const usage = accountCalls(book.calls);
    expect(usage.calls).toBe(2);
    expect(usage.byKind.main.calls).toBe(2);
    expect(book.calls[0]?.key).toBe('第一轮');
    expect(book.calls[0]?.turn).toBe(1);
  });
});

describe('任务 Oracle 与 P2 判定组合', () => {
  const turn = (tasks: TaskTurnFact['tasks']): TaskTurnFact => ({ turn: 1, tasks });
  it('H3 重复 requestId 归属多任务 → 硬零（任务判据原样复用）', () => {
    const verdict = judgeTaskContinuity([turn([
      { taskId: 'a', request: 'x', started: true, ended: true, reported: true, waiting: false, mayBeRunning: false, requestIds: ['req_1'] },
      { taskId: 'b', request: 'y', started: true, ended: true, reported: true, waiting: false, mayBeRunning: false, requestIds: ['req_1'] },
    ])]);
    expect(verdict.hardZeroHits).toContain('H3');
  });
  it('H5 已取消回执但未调用 task_cancel → 硬零', () => {
    const verdict = judgeTaskContinuity([{ turn: 1, tasks: [], reply: '已取消。', cancelCalled: false }]);
    expect(verdict.hardZeroHits).toContain('H5');
  });
  it('E-G 同编号映射到多任务 → 判负（编号混淆）', () => {
    const verdict = judgeTaskContinuity([turn([
      { taskId: 'a', taskNo: 1, request: 'x', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true, requestIds: [] },
      { taskId: 'b', taskNo: 1, request: 'y', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true, requestIds: [] },
    ])]);
    expect(verdict.codes).toContain('E-G');
  });
});
