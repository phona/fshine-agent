/**
 * 报告层测试（PR #21 四审 blocking + minor 的回归锁）。
 *
 * buildCaseReport / summarizeReport 是纯函数，同一输入同一输出——这里钉两件本轮修的事：
 *   ① 读回证据逐条调用关联（不再拿用例级 some() 给所有调用背书）；
 *   ② 阶梯摘要计数修括号（旧写法 `?? 0 + 1` 让同档计数永不递增）。
 */
import { describe, expect, it } from 'vitest';
import { aggregateMetrics, type HostGateRow } from './evidence';
import { buildCaseReport, buildUnifiedReport, metricInputs, summarizeReport, type ReportCaseInput, type UnifiedReport } from './report';

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

  it('auditMissing 轮：调用数不可知 ⇒ 省略 executedCalls/refusedCalls，不写 0（2026-11-10 评审 low）', () => {
    // 旧实现从 execution:[] 派生 0/0，与 calls=-1 的"不可知不写 0"纪律矛盾；只有
    // ladderRung=INCONCLUSIVE 暗示证据缺口。现在报告行显式带 calls:-1 + auditMissing:true，
    // 计数列整体缺席。
    const line = buildCaseReport(caseInput({
      turns: [{
        messageId: 'm1',
        text: '查一下',
        reply: 'r',
        notices: [],
        ms: 10,
        execution: [],
        calls: -1,
        auditMissing: true,
      }],
    }));
    const turn = line.turns[0]!;
    expect(turn.auditMissing).toBe(true);
    expect(turn.calls).toBe(-1);
    expect('executedCalls' in turn).toBe(false);
    expect('refusedCalls' in turn).toBe(false);
    // 孪生：有证据的零调用轮照常写 0（缺席与零可区分）。
    const clean = buildCaseReport(caseInput({
      turns: [{ messageId: 'm2', text: '查一下', reply: 'r', notices: [], ms: 10, execution: [], calls: 0 }],
    })).turns[0]!;
    expect(clean).toMatchObject({ executedCalls: 0, refusedCalls: 0, calls: 0 });
    expect('auditMissing' in clean).toBe(false);
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
      metrics: { cases: 1, passed: 1, passRate: 1, interventions: 0, gateRefusals: 0, planActivations: 0, planNotActivated: 0, safetyViolations: null, durationMs: 40 },
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

describe('metricInputs：跳过用例不进通过率分母（占位/未跑）', () => {
  it('passOf 返回 undefined ⇒ 不进分母但遥测在册，cases 与 passRate 分母同步', () => {
    // 2026-11-10 独立评审 medium：Q5b/Q13b 占位条目从未跑过，不能计入通过率。
    // 2026-11-10 codex major：但遥测不能随分母一起消失——跳过不是没跑。
    const ran = buildCaseReport(caseInput({ caseId: 'a1' }));
    const placeholder = buildCaseReport(caseInput({ caseId: 'Q5b' }));
    const inputs = metricInputs([ran, placeholder], (item) => (item.caseId === 'Q5b' ? undefined : true));
    expect(inputs.map((item) => item.caseId)).toEqual(['a1', 'Q5b']);
    expect(inputs.map((item) => item.pass)).toEqual([true, undefined]);
    const metrics = aggregateMetrics(inputs);
    expect(metrics.cases).toBe(1);
    expect(metrics.passRate).toBe(1);
    expect(metrics.durationMs).toBe(ran.durationMs + placeholder.durationMs);
  });
});

describe('buildUnifiedReport：跳过用例在 cases[] 里显式标 verdict', () => {
  it('passOf undefined ⇒ verdict=skip（ok 原值保留但不冒充通过），metrics 分母同步', () => {
    // 2026-11-10 独立评审 medium：旧报告 cases[] 只有 ok:true，跳过用例（未进基线）
    // 只看 cases 的消费者会误读为通过。verdict 与 metricInputs 同源（passOf）。
    const report = buildUnifiedReport({
      at: 'now',
      evalRunId: 'r',
      cases: [caseInput({ caseId: 'a1' }), caseInput({ caseId: 'D1' })],
      passOf: (line) => (line.caseId === 'D1' ? undefined : true),
    });
    expect(report.cases.map((line) => [line.caseId, line.verdict, line.ok]))
      .toEqual([['a1', 'pass', true], ['D1', 'skip', true]]);
    expect(report.metrics.cases).toBe(1);
    expect(report.metrics.passed).toBe(1);
  });

  it('没有 passOf 时 verdict 退回 ok（旧调用方不伪造跳过）', () => {
    const report = buildUnifiedReport({
      at: 'now',
      evalRunId: 'r',
      cases: [caseInput({ caseId: 'a1' }), caseInput({ caseId: 'a2', ok: false })],
    });
    expect(report.cases.map((line) => line.verdict)).toEqual(['pass', 'fail']);
    expect(report.metrics.cases).toBe(2);
    expect(report.metrics.passed).toBe(1);
  });
});

/**
 * 门拒绝口径校准（2026-11-10）：`serve_gate:plan_submit` 的每一行按设计都记
 * status=error（记的是判定结果，不是放行），成功激活也在其中。把这类行并进
 * gateRefusals 会把「PLAN ACTIVE 成功激活」报成门拒绝——Y2 实测 6 个 plan_submit
 * error 行 = 3 次激活 + 3 次格式 decline，真实调用拒绝 0，旧报告写"门拒绝 6 次"。
 */
describe('门拒绝与计划提交分口径：控制台「门拒绝 N 次」= 真拒绝数', () => {
  const planSubmit = (reason: string): HostGateRow => ({
    requestId: 'req-1',
    toolName: 'serve_gate:plan_submit',
    status: 'error',
    errorCode: 'GATE_BLOCKED',
    reason,
  });
  const planRows: HostGateRow[] = [
    planSubmit('PLAN ACTIVE（plan_1 v1）：按已提交 calls 执行；平台会逐次校验本计划。'),
    planSubmit('PLAN DECLINED：PLAN_JSON_PARSE: 期望 方案是合法 JSON；实际 …'),
    planSubmit('PLAN ACTIVE（plan_2 v1）：按已提交 calls 执行；平台会逐次校验本计划。'),
    planSubmit('PLAN DECLINED：PLAN_SHAPE_PREFIX: 期望 bin/dummy plan 之前只允许 …'),
    planSubmit('PLAN ACTIVE（plan_3 v1）：按已提交 calls 执行；平台会逐次校验本计划。'),
    planSubmit('PLAN NEEDS_USER_CONFIRM：计划里含需用户确认的写操作'),
  ];
  const trueRefusal: HostGateRow = { requestId: 'req-1', toolName: 'serve_gate:bash', status: 'error', reason: 'SERVE_BLOCK: 未激活计划' };

  it('Y2 形态：6 个 plan_submit error 行 = 3 激活 + 3 未激活，门拒绝 0', () => {
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'r', cases: [caseInput({ gateRows: planRows })] });
    expect(report.metrics.gateRefusals).toBe(0);
    expect(report.metrics.planActivations).toBe(3);
    expect(report.metrics.planNotActivated).toBe(3);
    const summary = summarizeReport(report);
    // 硬要求：控制台「门拒绝 N 次」必须等于真拒绝数，不能把激活算进去。
    expect(summary).toContain('门拒绝 0 次');
    expect(summary).toContain('计划提交 6 次（激活 3 / 未激活 3）');
  });

  it('真拒绝与计划提交并排：门拒绝只数非 plan_submit 的 error 行', () => {
    const report = buildUnifiedReport({
      at: 'now',
      evalRunId: 'r',
      cases: [caseInput({ gateRows: [...planRows, trueRefusal] })],
    });
    expect(report.metrics.gateRefusals).toBe(1);
    expect(summarizeReport(report)).toContain('门拒绝 1 次');
    // 报告 JSON 的 metrics 同时带两个计划口径，读 JSON 的消费者不必再自己分派。
    expect(report.metrics).toMatchObject({ planActivations: 3, planNotActivated: 3 });
  });

  it('metricInputs 原样传门裁决行（不在报告层另算一份计数）', () => {
    const line = buildCaseReport(caseInput({ gateRows: planRows }));
    const inputs = metricInputs([line]);
    expect(inputs[0]!.gateRows).toEqual(planRows);
    const metrics = aggregateMetrics(inputs);
    expect(metrics.gateRefusals).toBe(0);
    expect(metrics.planActivations).toBe(3);
    expect(metrics.planNotActivated).toBe(3);
  });
});
