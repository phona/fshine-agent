/**
 * S4 · 财务应收 Oracle + 5 条 SimCase 草稿的自检（确定性、零模型、零 judge）。
 *
 * 覆盖：
 *   ① 真值常量与数据集机械复算逐项对账（真值只在 `./finance-oracles`，改数据必须先改这里）；
 *   ② 五个 Oracle 均由 `resolveOracle(id, FINANCE_AR_ORACLES)` 解析；未知 id 不回落；
 *   ③ 五条草稿形状有效、真值写进 `forbiddenKnowledge`、用例字段无泄漏；
 *   ④ 每条用例的正确答复判通过（绿）；
 *   ⑤ 8 条判据的反向绊线：改核销金额 / 把跨期核销计入 / 把未来应收计入 /
 *      把未结清判成逾期，全部必须判负；
 *   ⑥ ⑧「两半分开判」：原始事实错但派生对 → raw=false / derived=true；
 *      派生错但原始事实可对上 → raw=true / derived=false。
 */

import { describe, expect, it } from 'vitest';
import { validateSimCase, type SimCase } from '../case';
import { resolveOracle, type SimExecutionFact, type SimOracleContext, type SimOracleVerdict } from '../oracle';
import { findCaseLeaks, buildSimulatorPrompt, findPromptLeaks } from '../simulator';
import { normalizeForMatch } from '../contamination';
import { AS_OF_DATE, FINANCE_DATASET } from '../../finance/dataset';
import { computeTruth } from '../../finance/truth';
import { AR_TRUTH, AR_TRUTH_PATTERNS, FINANCE_AR_ORACLES } from './finance-oracles';
import { FINANCE_AR_CASES } from './finance-cases';

const READ_OK: SimExecutionFact = { operation: 'dummy.query', status: 'completed' };
const READ_FAIL: SimExecutionFact = { operation: 'dummy.query', status: 'failed' };
const NO_JUDGE = { complete: async (): Promise<never> => { throw new Error('财务应收 Oracle 不应调用判官'); } };

function context(input: {
  readonly replies: readonly string[];
  readonly userMessages?: readonly string[];
  readonly executions: readonly SimExecutionFact[];
}): SimOracleContext {
  const replies = [...input.replies];
  return {
    finalReply: replies[replies.length - 1] ?? '',
    replies,
    userMessages: [...(input.userMessages ?? ['（测试用）'])],
    executions: input.executions,
  };
}

function caseOf(id: string): SimCase {
  const found = FINANCE_AR_CASES.find((caseDef) => caseDef.id === id);
  if (found === undefined) throw new Error(`缺用例 ${id}`);
  return found;
}

function judge(id: string, oracleContext: SimOracleContext): SimOracleVerdict {
  const caseDef = caseOf(id);
  const oracle = resolveOracle(caseDef.oracleId, FINANCE_AR_ORACLES);
  return oracle.judge(oracleContext, NO_JUDGE) as SimOracleVerdict;
}

function checksOf(verdict: SimOracleVerdict): Record<string, boolean> {
  return verdict.detail['checks'] as Record<string, boolean>;
}

function notApplicableOf(verdict: SimOracleVerdict): readonly string[] {
  return verdict.detail['notApplicable'] as readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 真值常量 ↔ 数据集
// ─────────────────────────────────────────────────────────────────────────────

describe('财务应收真值常量（只在 Oracle 模块内）', () => {
  const truth = computeTruth(FINANCE_DATASET, AR_TRUTH.asOfDate);

  it('快照日与数据集一致（as-of 口径不能两处漂移）', () => {
    expect(AR_TRUTH.asOfDate).toBe(AS_OF_DATE);
  });

  it('全量真值与数据集复算一致（60000 / 23500 / 36500 / 逾期 3 笔 12500）', () => {
    expect(truth.total).toEqual({ customer: '合计', ...AR_TRUTH.total });
  });

  it('三家客户真值与数据集复算逐行一致', () => {
    const rows = truth.byCustomer.map((row) => ({ ...row }));
    const expected = Object.entries(AR_TRUTH.byCustomer).map(([customer, rowValue]) => ({ customer, ...rowValue }));
    expect(rows).toEqual(expected);
  });

  it('真值模式覆盖每一行金额与笔数（forbiddenKnowledge 才能防泄漏）', () => {
    const rows = [AR_TRUTH.total, ...Object.values(AR_TRUTH.byCustomer)];
    for (const rowValue of rows) {
      for (const amount of [rowValue.receivable, rowValue.writtenOff, rowValue.outstanding, rowValue.overdueAmount]) {
        if (amount > 0) expect(AR_TRUTH_PATTERNS).toContain(String(amount));
      }
      expect(AR_TRUTH_PATTERNS).toContain(`${rowValue.invoiceCount}笔`);
      if (rowValue.overdueCount > 0) expect(AR_TRUTH_PATTERNS).toContain(`${rowValue.overdueCount}笔`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例形状与卫生
// ─────────────────────────────────────────────────────────────────────────────

describe('五条 SimCase 草稿', () => {
  it('形状全部有效，允许 finish', () => {
    expect(FINANCE_AR_CASES.map((caseDef) => caseDef.id)).toEqual([
      'SIM-FIN-01', 'SIM-FIN-02', 'SIM-FIN-03', 'SIM-FIN-04', 'SIM-FIN-05',
    ]);
    for (const caseDef of FINANCE_AR_CASES) {
      expect(validateSimCase(caseDef), caseDef.id).toEqual({ ok: true, errors: [] });
      expect(caseDef.allowedActions).toContain('finish');
    }
  });

  it('五个 Oracle 由套件局部注册解析；未知 id 不回落', () => {
    expect(FINANCE_AR_ORACLES.map((oracle) => oracle.id)).toEqual([
      'oracle:finance-ar-summary',
      'oracle:finance-ar-outstanding-source',
      'oracle:finance-ar-customer-filter',
      'oracle:finance-ar-overdue',
      'oracle:finance-ar-missing-data',
    ]);
    for (const caseDef of FINANCE_AR_CASES) {
      const oracle = resolveOracle(caseDef.oracleId, FINANCE_AR_ORACLES);
      expect(oracle.id).toBe(caseDef.oracleId);
      expect(oracle.truthPatterns.length).toBeGreaterThan(0);
    }
    expect(() => resolveOracle('oracle:finance-ar-not-registered', FINANCE_AR_ORACLES)).toThrow(/未知 oracleId/);
  });

  it('真值全部写进 forbiddenKnowledge，且用例字段无泄漏', () => {
    for (const caseDef of FINANCE_AR_CASES) {
      const oracle = resolveOracle(caseDef.oracleId, FINANCE_AR_ORACLES);
      for (const pattern of oracle.truthPatterns) {
        expect(caseDef.forbiddenKnowledge, `${caseDef.id} 缺真值 ${pattern}`).toContain(pattern);
      }
      expect(findCaseLeaks(caseDef, oracle.truthPatterns, normalizeForMatch), caseDef.id).toEqual([]);
    }
  });

  it('模拟用户 prompt 不含真值 / 夹具 / Oracle 标识（真值只进 Oracle）', () => {
    for (const caseDef of FINANCE_AR_CASES) {
      const oracle = resolveOracle(caseDef.oracleId, FINANCE_AR_ORACLES);
      const prompt = buildSimulatorPrompt({
        goal: caseDef.goal,
        persona: caseDef.persona,
        knowledge: caseDef.knowledge,
        behaviorRules: caseDef.behaviorRules,
        terminal: caseDef.terminal,
        allowedActions: caseDef.allowedActions,
        userMessages: [caseDef.initialMessage],
        lastSystemReply: '（尚未回复）',
        userTurn: 2,
      });
      expect(findPromptLeaks(prompt, caseDef, oracle.truthPatterns, normalizeForMatch), caseDef.id).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 绿：每条用例的正确答复判通过
// ─────────────────────────────────────────────────────────────────────────────

describe('正确答复判通过', () => {
  it('场景 1 正常交办：应收/已核销/未结清', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 36500 元，共 9 笔。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict)).toMatchObject({ receivable_total: true, written_off_total: true, outstanding_total: true });
    expect(notApplicableOf(verdict)).toEqual(expect.arrayContaining(['unpaid_not_overdue', 'overdue_follows_due_on']));
  });

  it('场景 2 追问未结清来源：总数 + 三家拆分', () => {
    const verdict = judge('SIM-FIN-02', context({
      replies: ['未结清合计 36500 元。华远贸易未结清 10500 元；明达物流未结清 18000 元；新程科技未结清 8000 元。'],
      userMessages: ['未结清一共多少？按三家拆一下。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict)).toMatchObject({ outstanding_total: true, per_invoice_attribution: true });
  });

  it('场景 2 追问未结清来源：没有总数、只有三家齐全都对，也算答出来源', () => {
    const verdict = judge('SIM-FIN-02', context({
      replies: ['华远贸易未结清 10500 元；明达物流未结清 18000 元；新程科技未结清 8000 元。'],
      userMessages: ['未结清按三家拆一下，我想看看来源。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict).outstanding_total).toBe(true);
  });

  it('场景 3 指定客户筛选：只查明达物流', () => {
    const verdict = judge('SIM-FIN-03', context({
      replies: ['明达物流截至 2026-10-31：应收 25000 元，已核销 7000 元，未结清 18000 元。'],
      userMessages: ['只查明达物流一家的汇总。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict)).toMatchObject({ receivable_total: true, written_off_total: true, outstanding_total: true });
  });

  it('场景 4 发现逾期：3 笔 / 12500，逐笔列出，未到期的不算逾期', () => {
    const verdict = judge('SIM-FIN-04', context({
      replies: [
        '截至 2026-10-31，逾期 3 笔，金额 12500 元。'
        + 'INV-A-001 未结清 3500 元，已逾期；'
        + 'INV-B-001 未结清 5000 元，已逾期；'
        + 'INV-B-003 未结清 4000 元，已逾期。'
        + 'INV-B-002 今天到期，不算逾期。',
      ],
      userMessages: ['截至上月底，哪几笔应收已经逾期？分别还欠多少？'],
      executions: [READ_OK],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict)).toMatchObject({
      unpaid_not_overdue: true,
      overdue_follows_due_on: true,
      per_invoice_attribution: true,
    });
    expect(verdict.detail['overdueClaimedIds']).toEqual(['INV-A-001', 'INV-B-001', 'INV-B-003']);
  });

  it('场景 5 数据缺失：如实说明、不编造、不假装查完', () => {
    const verdict = judge('SIM-FIN-05', context({
      replies: [
        '明达物流的收款和核销数据今天没有同步上，未结清和逾期情况我无法确认。'
        + '已经确认的部分：华远贸易未结清 10500 元，新程科技未结清 8000 元。'
        + '整体未结清需要等数据补齐后核对。',
      ],
      userMessages: ['三家客户截至上月底的应收和未结清；有一家收款数据可能没同步上。'],
      executions: [READ_OK, READ_FAIL],
    }));
    expect(verdict.pass, JSON.stringify(verdict.detail)).toBe(true);
    expect(checksOf(verdict)).toMatchObject({
      no_fabrication: true,
      raw_facts_supported: true,
      evidence_insufficient_disclosed: true,
    });
    expect(notApplicableOf(verdict)).toContain('derived_matches_truth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 反向绊线：故意错答必须判负（且只打中对应判据）
// ─────────────────────────────────────────────────────────────────────────────

describe('反向绊线', () => {
  it('改核销金额 → 已核销/未结清判负', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23501 元，未结清 36499 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).written_off_total).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
    expect(checksOf(verdict).receivable_total).toBe(true);
  });

  it('把跨期核销计入 → 已核销/未结清判负', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 27500 元，未结清 32500 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).written_off_total).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
  });

  it('把未来应收计入 → 应收总额判负', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 65000 元，已核销 23500 元，未结清 41500 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).receivable_total).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
  });

  it('把未分配收款直接抵扣 → 未结清判负', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 34500 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
    expect(checksOf(verdict).written_off_total).toBe(true);
  });

  it('把未结清判成逾期 → 未核销≠逾期 / 逾期判断同时判负', () => {
    const verdict = judge('SIM-FIN-04', context({
      replies: ['截至 2026-10-31，未结清 36500 元，逾期 36500 元（全部逾期）。'],
      userMessages: ['哪些应收已经逾期？'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).unpaid_not_overdue).toBe(false);
    expect(checksOf(verdict).overdue_follows_due_on).toBe(false);
  });

  it('把未来应收单当作本期逐笔明细 → 归属判负', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 36500 元。INV-A-004 应收 5000 元，未结清 5000 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).per_invoice_attribution).toBe(false);
    expect(checksOf(verdict).receivable_total).toBe(true);
  });

  it('客户之间串户 → 归属判负（汇总数仍对）', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 36500 元。华远贸易未结清 18000 元。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).per_invoice_attribution).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(true);
  });

  it('编造账上不存在的金额 → 无编造判负（汇总数仍对）', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 36500 元，另有 77777 元待查。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).no_fabrication).toBe(false);
    expect(verdict.detail['fabricatedAmounts']).toEqual([77777]);
  });

  it('指定客户却给全量 → 客户筛选判负', () => {
    const verdict = judge('SIM-FIN-03', context({
      replies: ['应收合计 60000 元，已核销 23500 元，未结清 36500 元。'],
      userMessages: ['只查明达物流一家的汇总。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).receivable_total).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 两半分开判
// ─────────────────────────────────────────────────────────────────────────────

describe('原始事实与派生结果分开判', () => {
  it('原始事实错（收款单金额对不上）但派生结果对 → raw=false / derived=true', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 36500 元。其中 RCP-001 收了 6000 元。'],
      executions: [READ_OK],
    }));
    expect(checksOf(verdict).raw_facts_supported).toBe(false);
    expect(checksOf(verdict).derived_matches_truth).toBe(true);
    expect(checksOf(verdict).no_fabrication).toBe(true);
  });

  it('派生结果错（未结清少算一家）但原始事实可对上 → raw=true / derived=false', () => {
    const verdict = judge('SIM-FIN-01', context({
      replies: ['截至 2026-10-31，应收合计 60000 元，已核销 23500 元，未结清 28500 元。'],
      executions: [READ_OK],
    }));
    expect(checksOf(verdict).raw_facts_supported).toBe(true);
    expect(checksOf(verdict).derived_matches_truth).toBe(false);
    expect(checksOf(verdict).outstanding_total).toBe(false);
    expect(checksOf(verdict).no_fabrication).toBe(true);
  });

  it('缺失数据场景没有失败读取 → 证据不足不成立（场景未发生，不算通过）', () => {
    const verdict = judge('SIM-FIN-05', context({
      replies: ['明达物流的收款数据没有同步上，未结清无法确认。'],
      executions: [READ_OK],
    }));
    expect(verdict.pass).toBe(false);
    expect(checksOf(verdict).evidence_insufficient_disclosed).toBe(false);
  });
});
