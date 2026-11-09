/**
 * 报告层测试（PR #21 四审 blocking + minor 的回归锁）。
 *
 * buildCaseReport / summarizeReport 是纯函数，同一输入同一输出——这里钉两件本轮修的事：
 *   ① 读回证据逐条调用关联（不再拿用例级 some() 给所有调用背书）；
 *   ② 阶梯摘要计数修括号（旧写法 `?? 0 + 1` 让同档计数永不递增）。
 */
import { describe, expect, it } from 'vitest';
import { buildCaseReport, summarizeReport, type ReportCaseInput, type UnifiedReport } from './report';

function caseInput(overrides: Partial<ReportCaseInput> = {}): ReportCaseInput {
  return {
    caseId: 'c1',
    group: 'G',
    intent: 'test',
    ok: true,
    notes: [],
    turns: [
      {
        messageId: 'm1',
        text: '查一下',
        reply: '查到了',
        notices: [],
        ms: 100,
        execution: [{ mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'p1' }],
      },
    ],
    intents: [],
    gateRows: [],
    delegations: [],
    ...overrides,
  };
}

describe('buildCaseReport：读回证据逐条调用关联（四审 blocking）', () => {
  it('本行 proposalId 命中 committed+读回 → verified/delivered', () => {
    const line = buildCaseReport(caseInput({
      intents: [{ intentId: 'i1', proposalId: 'p1', status: 'committed', hasReadback: true }],
    }));
    expect(line.ladder.map((c) => c.rung)).toEqual(['delivered']);
  });

  it('用例级 some() 的旧形态：另一 proposalId 的未验证写不被历史成功背书', () => {
    // 复现缺陷：本用例成功提交过 p1，随后另一笔 p2 没有读回证据。旧写法
    // `intents.some(...)` 会判 readbackVerified=true，把 p2 也标成 verified/delivered。
    const line = buildCaseReport(caseInput({
      turns: [{
        messageId: 'm2',
        text: '再写一笔',
        reply: '写好了',
        notices: [],
        ms: 100,
        execution: [{ mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'p2' }],
      }],
      intents: [{ intentId: 'i1', proposalId: 'p1', status: 'committed', hasReadback: true }],
    }));
    expect(line.ladder.map((c) => c.rung)).toEqual(['completed']);
  });

  it('pending / 无读回的提案不贡献 verified', () => {
    for (const intent of [
      { intentId: 'i1', proposalId: 'p1', status: 'pending' as const, hasReadback: false },
      { intentId: 'i2', proposalId: 'p1', status: 'committed' as const, hasReadback: false },
    ]) {
      const line = buildCaseReport(caseInput({ intents: [intent] }));
      expect(line.ladder.map((c) => c.rung), JSON.stringify(intent)).toEqual(['completed']);
    }
  });
});

describe('summarizeReport：阶梯计数修括号（四审 minor）', () => {
  it('同档多次调用计数正确（旧写法恒为 1）', () => {
    const turns = Array.from({ length: 4 }, (_unused, index) => ({
      messageId: `m${index}`,
      text: 'q',
      reply: 'r',
      notices: [] as string[],
      ms: 10,
      execution: [{ mode: 'query' as const, script: 'dummy.query', exitCode: 0 }],
    }));
    const report: UnifiedReport = {
      at: 'now',
      evalRunId: 'r',
      kind: 'eval-report',
      basis: [],
      cases: [buildCaseReport(caseInput({ turns }))],
      // 四条 delivered（读类 exitCode=0 + 回复非空 ⇒ verified 再升 delivered）。
      // ReportCallLine 要求的其余字段对本断言无意义，填占位。
      calls: buildCaseReport(caseInput({ turns })).ladder.map((entry) => ({
        at: 'now',
        evalRunId: 'r',
        caseId: 'c1',
        turnIndex: 0,
        messageId: 'm0',
        turnRung: entry.rung,
        latencyMs: 10,
        script: entry.script,
        rung: entry.rung,
        basis: entry.basis,
        ...(entry.refusedReason ? { refusedReason: entry.refusedReason } : {}),
      })),
      metrics: { cases: 1, passed: 1, passRate: 1, interventions: 0, gateRefusals: 0, safetyViolations: null, durationMs: 40 },
    };
    const summary = summarizeReport(report);
    // 旧写法 `rungCounts.get(rung) ?? 0 + 1` 解析成 `?? 1`：键已存在时原样返回，四次调用
    // 也显示 1。修括号后应为 4。
    expect(summary).toContain('delivered 4');
  });
});

describe('干预停点：提案确认后提交成功仍计入（八审 major）', () => {
  it('最后一轮快照是 committed 时，早前的 pending 停点不消失', () => {
    // 复现缺陷：探针旧写法只把最后一轮的 intents 传给 buildCaseReport，而
    // countInterventionPoints 只数 status=pending。提案等确认→提交成功后最终态是
    // committed，那个"用户必须确认"的停点从干预指标里消失，完整写链报成零次干预。
    const line = buildCaseReport(caseInput({
      turns: [{
        messageId: 'm1',
        text: '录入',
        reply: '已登记，等待确认',
        notices: [],
        ms: 100,
        execution: [{ mode: 'prepare', script: 'dummy.proposal', exitCode: 0, proposalId: 'p1' }],
      }],
      // 累积全部轮次快照：早前 pending + 最终 committed（同一 intentId）
      intents: [
        { intentId: 'i1', proposalId: 'p1', status: 'pending', hasReadback: false },
        { intentId: 'i1', proposalId: 'p1', status: 'committed', hasReadback: true },
      ],
    }));
    expect(line.interventionPoints).toBe(1);
  });

  it('从未 pending 的意图不计停点', () => {
    const line = buildCaseReport(caseInput({
      intents: [{ intentId: 'i1', proposalId: 'p1', status: 'committed', hasReadback: true }],
    }));
    expect(line.interventionPoints).toBe(0);
  });
});
