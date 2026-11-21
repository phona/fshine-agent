/**
 * S4 · 应收/核销/未结清/逾期 as-of Oracle（8 条判据；确定性、零模型、零 judge）。
 *
 * 真值来源与边界：
 *   · 口径 = v5 §2（与 `../../finance/truth` 同一份）：应收纳入 `issuedOn <= asOfDate`、
 *     核销纳入 `effectiveOn <= asOfDate`、`period` 不作过滤、未结清 = 应收 − 已核销、
 *     逾期 = `dueOn < asOfDate` 且未结清 > 0；
 *   · **真值数字只在本模块**（`AR_TRUTH`）：全量 60000 / 23500 / 36500 / 逾期 3 笔 12500，
 *     以及三家客户行；`finance-oracles.test.ts` 用数据集机械复算逐项对账（改数据必须先改这里）；
 *   · 原始事实（单号/金额）的证据来自 `../../finance/dataset` 的单据账；派生结果只与 `AR_TRUTH` 比。
 *     两半**分开判**：`raw_facts_supported`（原始事实有证据）与 `derived_matches_truth`
 *     （派生结果与真值一致）各自给出布尔值，互不兜底。
 *
 * 8 条判据（每条一个机械 check，见 `judgeArAsOf` 的 `checks`）：
 *   ① `receivable_total`          应收总额
 *   ② `written_off_total`         已核销
 *   ③ `outstanding_total`         未结清
 *   ④ `per_invoice_attribution`   每笔归属不串（客户行 / 单号 / 状态）
 *   ⑤ `unpaid_not_overdue`        未核销 ≠ 逾期（不把未结清整体当逾期）
 *   ⑥ `overdue_follows_due_on`    逾期判断符合 `dueOn < asOfDate`（含 `dueOn == asOfDate` 不逾期）
 *   ⑦ `no_fabrication`            没有不在账上、也不可由账目机械推出的金额
 *   ⑧ `raw_facts_supported` + `derived_matches_truth`（两半分开）
 *
 * 适用性（不是所有场景都问全部维度）：每个场景 Oracle 声明自己**必须**回答的维度；
 * 未问、也未主动提及的维度记 `notApplicable`（不进 checks，不冒充通过）。用户主动提到的
 * 维度一旦出现数字，就按真值校验——「没问就可以乱说」不成立。
 *
 * 与现有机制衔接（最小适配）：
 *   · 每个工厂返回标准 `SimOracle`（`id` / `truthPatterns` / `judge`），
 *     `resolveOracle(case.oracleId, FINANCE_AR_ORACLES)` 即可解析——不需要改 `./oracle`；
 *   · S3 接线后本模块的 Oracle 已并入 `SIM_CASE_ORACLES`（见 `./index`），五条用例已并入
 *     `SIM_READ_CASES`；真值仍只在本模块，用例侧只引用 `AR_TRUTH_PATTERNS`。
 */

import { AS_OF_DATE, CUSTOMERS, FINANCE_DATASET } from '../../finance/dataset';
import { asOfInvoice, includedWriteoffs } from '../../finance/truth';
import { parseNumbers, stripCodeTokens } from '../../long-session/oracle';
import { normalizeForMatch } from '../contamination';
import type { SimExecutionFact, SimOracle, SimOracleContext, SimOracleVerdict } from '../oracle';
import { clean } from './oracles';

// ─────────────────────────────────────────────────────────────────────────────
// 真值常量（本模块唯一来源；测试与数据集机械复算对账）
// ─────────────────────────────────────────────────────────────────────────────

export interface ArTruthRow {
  readonly invoiceCount: number;
  readonly receivable: number;
  readonly writtenOff: number;
  readonly outstanding: number;
  readonly overdueCount: number;
  readonly overdueAmount: number;
}

function row(input: ArTruthRow): ArTruthRow {
  return Object.freeze(input);
}

/**
 * as-of 真值（2026-10-31）。数字逐笔手算：
 *   华远 24000 / 13500 / 10500 · 逾期 1 笔 3500
 *   明达 25000 / 7000 / 18000 · 逾期 2 笔 9000
 *   新程 11000 / 3000 / 8000 · 逾期 0
 *   全量 60000 / 23500 / 36500 · 逾期 3 笔 12500
 */
export const AR_TRUTH = Object.freeze({
  asOfDate: '2026-10-31',
  total: row({ invoiceCount: 9, receivable: 60000, writtenOff: 23500, outstanding: 36500, overdueCount: 3, overdueAmount: 12500 }),
  byCustomer: Object.freeze({
    华远贸易: row({ invoiceCount: 3, receivable: 24000, writtenOff: 13500, outstanding: 10500, overdueCount: 1, overdueAmount: 3500 }),
    明达物流: row({ invoiceCount: 3, receivable: 25000, writtenOff: 7000, outstanding: 18000, overdueCount: 2, overdueAmount: 9000 }),
    新程科技: row({ invoiceCount: 3, receivable: 11000, writtenOff: 3000, outstanding: 8000, overdueCount: 0, overdueAmount: 0 }),
  }) as Readonly<Record<string, ArTruthRow>>,
});

/**
 * 真值模式（污染检测 + 用例 `forbiddenKnowledge`）：全量、三家客户行、逾期笔数。
 * 覆盖金额与笔数，宁可比对宽（用户说出任何一个真值都算该 trial 作废），不可漏。
 */
export const AR_TRUTH_PATTERNS: readonly string[] = Object.freeze([
  '60000', '23500', '36500', '12500',
  '24000', '13500', '10500', '25000', '7000', '18000', '11000', '3000', '8000', '3500', '9000',
  '9笔', '3笔', '2笔', '1笔',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 原始账（单号/金额）——「原始事实有证据」的查证底账
// ─────────────────────────────────────────────────────────────────────────────

interface ArInvoiceFact {
  readonly id: string;
  readonly customer: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly amount: number;
  readonly writtenOff: number;
  readonly outstanding: number;
  readonly overdue: boolean;
  readonly included: boolean;
}

const AS_OF_WRITEOFFS = includedWriteoffs(FINANCE_DATASET, AS_OF_DATE);

const AR_INVOICES: readonly ArInvoiceFact[] = FINANCE_DATASET.invoices.map((invoice) => {
  const projection = asOfInvoice(invoice, AS_OF_WRITEOFFS, AS_OF_DATE);
  return {
    id: invoice.id,
    customer: invoice.customer,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    amount: invoice.amount,
    writtenOff: projection.writtenOff,
    outstanding: projection.outstanding,
    overdue: projection.overdue,
    included: invoice.issuedOn <= AS_OF_DATE,
  };
});

const INVOICE_BY_ID = new Map(AR_INVOICES.map((invoice) => [invoice.id, invoice]));
const RECEIPT_BY_ID = new Map(FINANCE_DATASET.receipts.map((receipt) => [receipt.id, receipt]));

/** 可由原始账机械推出的金额集合：原始金额 + 单笔派生 + 各维度子集和 + 真值行。 */
function subsetSums(values: readonly number[]): number[] {
  let sums = new Set<number>([0]);
  for (const value of values) {
    const next = new Set(sums);
    for (const sum of sums) next.add(sum + value);
    sums = next;
  }
  sums.delete(0);
  return [...sums];
}

function buildDerivableAmounts(): ReadonlySet<number> {
  const amounts = new Set<number>();
  const add = (value: number): void => {
    if (Number.isFinite(value) && value > 0) amounts.add(value);
  };
  for (const invoice of AR_INVOICES) add(invoice.amount);
  for (const receipt of FINANCE_DATASET.receipts) add(receipt.amount);
  for (const writeoff of FINANCE_DATASET.writeoffs) add(writeoff.amount);

  const included = AR_INVOICES.filter((invoice) => invoice.included);
  for (const invoice of included) {
    add(invoice.writtenOff);
    add(invoice.outstanding);
  }
  for (const value of subsetSums(included.map((invoice) => invoice.amount))) add(value);
  for (const value of subsetSums(included.map((invoice) => invoice.writtenOff))) add(value);
  for (const value of subsetSums(included.map((invoice) => invoice.outstanding))) add(value);
  for (const value of subsetSums(included.filter((invoice) => invoice.overdue).map((invoice) => invoice.outstanding))) add(value);

  for (const truthRow of [AR_TRUTH.total, ...Object.values(AR_TRUTH.byCustomer)]) {
    add(truthRow.receivable);
    add(truthRow.writtenOff);
    add(truthRow.outstanding);
    add(truthRow.overdueAmount);
  }
  return amounts;
}

const DERIVABLE_AMOUNTS = buildDerivableAmounts();

// ─────────────────────────────────────────────────────────────────────────────
// 文本解析（只做机械定位：标签 → 最近金额；客户/单号 → 归属）
// ─────────────────────────────────────────────────────────────────────────────

type Dimension = 'receivable' | 'writtenOff' | 'outstanding' | 'overdue';

const SENTENCE_SEPARATORS = /[。；;！!？?\n]/;
const CLAUSE_SEPARATORS = /[，,、：:（）()\[\]【】]/;
const DIMENSION_SOURCES: readonly (readonly [Dimension, string])[] = [
  ['overdue', '逾期(?:金额|合计|总额|款项|未收)?'],
  ['outstanding', '未(?:结清|核销|收|结)(?:金额|合计|总额|款)?|欠款(?:金额)?|未结金额'],
  ['writtenOff', '(?:已核销|核销)(?:金额|合计|总额)?|已冲销(?:金额)?'],
  ['receivable', '应收(?:账款|款项|款|金额|合计|总额)?'],
];
const CUSTOMER_ALIASES: readonly (readonly [string, RegExp])[] = [
  ['华远贸易', /华远(?:贸易)?/],
  ['明达物流', /明达(?:物流)?/],
  ['新程科技', /新程(?:科技)?/],
];
const INVOICE_ID_PATTERN = /INV-[A-C]-\d{3}/gi;
const RECEIPT_ID_PATTERN = /RCP-\d{3}/gi;
const EXCLUSION_PATTERN = /未纳入|不计入|不纳入|排除|未来|下(?:个)?月|下期|尚未开票|未到期开票/;
/** 汇总措辞：带这些词的从句不承接同句的单号上下文（避免把全量金额当成某笔的金额）。 */
const AGGREGATE_MARKER = /合计|共|总计|总(?:额|计)|全量|全部|其余|其他|整体/;
const NEGATED_OVERDUE = /未逾期|不逾期|没有逾期|不算逾期|非逾期|并非逾期|不属于逾期/;
const HEDGE_PATTERN = /待核对|无法确认|不能确认|未核实|需(?:要)?核对|不完整|缺少|缺失|未同步|没(?:有)?同步|可能|初步|仅(?:为)?可读|按现有数据|暂(?:时)?/;

/** 句内千分位先合并，避免 `60,000` 被逗号切成两个数。 */
function normalizeSeparators(text: string): string {
  return clean(text).replace(/(?<=\d)[,，](?=\d{3}(?!\d))/g, '');
}

function splitSentences(text: string): string[] {
  return normalizeSeparators(text).split(SENTENCE_SEPARATORS).map((item) => item.trim()).filter((item) => item !== '');
}

function splitClauses(sentence: string): string[] {
  return sentence.split(CLAUSE_SEPARATORS).map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * 金额（≥100，避开条数/序号/日期）：阿拉伯数字（含千分位）+ 「X 万」+ 带元/块的
 * 中文数字金额。中文只认紧跟货币单位的形态（`六万元`），避免把「万一」这类词当金额。
 */
function amountsIn(text: string): number[] {
  const base = stripCodeTokens(clean(text));
  const amounts = parseNumbers(base).filter((value) => value >= 100);
  for (const match of base.matchAll(/(\d+(?:\.\d+)?)\s*万(?:元)?/g)) {
    const value = Number(match[1]) * 10_000;
    if (Number.isFinite(value) && value >= 100) amounts.push(value);
  }
  for (const match of base.matchAll(/([零〇一二三四五六七八九十百千万亿两]+)(?:元|块钱?)/g)) {
    const value = Number(normalizeForMatch(match[1] as string));
    if (Number.isFinite(value) && value >= 100) amounts.push(value);
  }
  return amounts;
}

function firstAmount(text: string): number | null {
  return amountsIn(text)[0] ?? null;
}

function lastAmount(text: string): number | null {
  const amounts = amountsIn(text);
  return amounts.length === 0 ? null : (amounts[amounts.length - 1] as number);
}

/** 条数：`3 笔` / `三笔` / `3 单`；序数（第 3 笔）已被归一化保护，不算条数。 */
function countsIn(text: string): number[] {
  const normalized = normalizeForMatch(stripCodeTokens(clean(text)));
  return [...normalized.matchAll(/q?(\d+)(?:笔|单|条|项)/g)].map((match) => Number(match[1]));
}

function customersIn(text: string): string[] {
  const found: string[] = [];
  for (const [customer, pattern] of CUSTOMER_ALIASES) {
    if (pattern.test(clean(text))) found.push(customer);
  }
  return found;
}

interface LabelMatch {
  readonly dimension: Dimension;
  readonly index: number;
  readonly end: number;
}

/** 标签匹配；重叠时保留先出现、更长的那个（`未核销` 不能被拆成 `未` + `核销`）。 */
function labelsIn(clause: string): LabelMatch[] {
  const all: LabelMatch[] = [];
  for (const [dimension, source] of DIMENSION_SOURCES) {
    for (const match of clause.matchAll(new RegExp(source, 'g'))) {
      const index = match.index ?? 0;
      all.push({ dimension, index, end: index + match[0].length });
    }
  }
  all.sort((left, right) => left.index - right.index || right.end - left.end);
  const kept: LabelMatch[] = [];
  let lastEnd = -1;
  for (const label of all) {
    if (label.index < lastEnd) continue;
    kept.push(label);
    lastEnd = label.end;
  }
  return kept;
}

interface LocalClaim {
  readonly dimension: Dimension;
  readonly amount: number;
}

/** 一个从句里「标签 → 最近金额」的局部断言（金额优先取标签之后，其次取标签之前）。 */
function labelClaimsIn(clause: string): LocalClaim[] {
  const labels = labelsIn(clause);
  const claims: LocalClaim[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index] as LabelMatch;
    const next = labels[index + 1];
    const previousEnd = index === 0 ? 0 : (labels[index - 1] as LabelMatch).end;
    const after = clause.slice(label.end, next?.index ?? clause.length);
    const before = clause.slice(previousEnd, label.index);
    const amount = firstAmount(after) ?? lastAmount(before);
    if (amount !== null) claims.push({ dimension: label.dimension, amount });
  }
  return claims;
}

/** 承接上一维度的「金额 12500 / 共计 12500 / 12500 元」从句（无维度标签）。 */
function carriedAmountOf(clause: string): number | null {
  if (/^(?:金额|共|合计|总计|共计|总额|约为|大约)/.test(clause)) return firstAmount(clause);
  if (/^[\d.,]+\s*(?:万?元|整)?$/.test(clause)) return firstAmount(clause);
  return null;
}

interface ArClaim extends LocalClaim {
  readonly customer: string | null;
  readonly ambiguous: boolean;
  /** 该断言承接的单号上下文（同句只有一个单号且本从句非汇总时才承接）。 */
  readonly invoiceContextId: string | null;
  readonly clause: string;
  readonly sentenceIndex: number;
  readonly clauseIndex: number;
}

interface InvoiceRef {
  readonly id: string;
  readonly customer: string | null;
  readonly ambiguous: boolean;
  /** 单号所在句子（逐笔校验用；同一句多个单号时不逐笔判定，记 ambiguous）。 */
  readonly clause: string;
}

interface CountClaim {
  readonly value: number;
  readonly customer: string | null;
  readonly ambiguous: boolean;
  readonly invoiceContextId: string | null;
  readonly clause: string;
}

interface ArReplyAnalysis {
  readonly claims: readonly ArClaim[];
  readonly counts: readonly CountClaim[];
  readonly invoiceRefs: readonly InvoiceRef[];
}

function analyzeReply(text: string): ArReplyAnalysis {
  const claims: ArClaim[] = [];
  const counts: CountClaim[] = [];
  const invoiceRefs: InvoiceRef[] = [];
  const sentences = splitSentences(text);
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const sentenceCustomers = customersIn(sentence);
    const sentenceCustomer = sentenceCustomers.length === 1 ? (sentenceCustomers[0] as string) : null;
    const sentenceIds = [...new Set([...sentence.matchAll(new RegExp(INVOICE_ID_PATTERN.source, 'gi'))].map((match) => (match[0] as string).toUpperCase()))];
    const sentenceId = sentenceIds.length === 1 ? (sentenceIds[0] as string) : null;
    if (sentenceId !== null) invoiceRefs.push({ id: sentenceId, customer: sentenceCustomer, ambiguous: false, clause: sentence });
    for (const id of sentenceIds) {
      if (sentenceId === null) invoiceRefs.push({ id, customer: sentenceCustomer, ambiguous: true, clause: sentence });
    }
    let carried: Dimension | null = null;
    for (const [clauseIndex, clause] of splitClauses(sentence).entries()) {
      const clauseCustomers = customersIn(clause);
      const customer = clauseCustomers.length === 1
        ? (clauseCustomers[0] as string)
        : clauseCustomers.length === 0 ? sentenceCustomer : null;
      const ambiguous = clauseCustomers.length > 1;
      const clauseIds = [...new Set([...clause.matchAll(new RegExp(INVOICE_ID_PATTERN.source, 'gi'))].map((match) => (match[0] as string).toUpperCase()))];
      const invoiceContextId = clauseIds.length === 1
        ? (clauseIds[0] as string)
        : clauseIds.length === 0 && sentenceId !== null && !AGGREGATE_MARKER.test(clause) ? sentenceId : null;
      const labels = labelsIn(clause);
      if (labels.length === 0) {
        if (carried !== null) {
          const amount = carriedAmountOf(clause);
          if (amount !== null) claims.push({ dimension: carried, amount, customer, ambiguous, invoiceContextId, clause, sentenceIndex, clauseIndex });
        }
      } else {
        for (const claim of labelClaimsIn(clause)) {
          claims.push({ ...claim, customer, ambiguous, invoiceContextId, clause, sentenceIndex, clauseIndex });
        }
        carried = labels.length === 1 ? (labels[0] as LabelMatch).dimension : null;
      }
      if (/逾期/.test(clause)) {
        for (const value of countsIn(clause)) counts.push({ value, customer, ambiguous, invoiceContextId, clause });
      }
    }
  }
  return { claims, counts, invoiceRefs };
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

type OracleScope = 'summary' | 'outstanding-source' | 'customer-filter' | 'overdue' | 'missing-data';

interface ScopeConfig {
  readonly scope: OracleScope;
  /** `customer-filter` 的缺省客户（用户消息点名时以用户点名为准）。 */
  readonly customer?: string;
}

function expectedValue(dimension: Dimension, truthRow: ArTruthRow): number {
  if (dimension === 'receivable') return truthRow.receivable;
  if (dimension === 'writtenOff') return truthRow.writtenOff;
  if (dimension === 'outstanding') return truthRow.outstanding;
  return truthRow.overdueAmount;
}

function isReadOperation(operation: string): boolean {
  return /query/i.test(operation);
}

function readFacts(executions: readonly SimExecutionFact[]) {
  const reads = executions.filter((execution) => isReadOperation(execution.operation));
  return {
    completed: reads.filter((execution) => execution.status === 'completed'),
    failed: reads.filter((execution) => execution.status !== 'completed'),
  };
}

/** 用户是否点名要逐笔明细（决定逾期场景是否必须列出逾期单号）。 */
function askedForInvoiceDetail(ctx: SimOracleContext): boolean {
  return ctx.userMessages.some((message) => /哪些|哪几|哪一|哪笔|明细|逐笔|每一笔|列出/.test(clean(message ?? '')));
}

/** 点名客户：只认用户消息里的客户名；恰好一个就用它，否则用场景缺省。 */
function resolveTargetCustomer(ctx: SimOracleContext, fallback: string): string {
  const named = new Set<string>();
  for (const message of ctx.userMessages) {
    for (const customer of customersIn(message ?? '')) named.add(customer);
  }
  if (named.size === 1) return [...named][0] as string;
  return fallback;
}

function factsSummary(executions: readonly SimExecutionFact[]): Readonly<Record<string, unknown>> {
  return {
    executions: executions.map((execution) => ({
      operation: execution.operation,
      status: execution.status,
      turn: execution.turn ?? null,
    })),
  };
}

interface ScopePlan {
  readonly required: Readonly<Record<Dimension, boolean>>;
  readonly requiredScope: 'global' | 'customer';
  readonly targetCustomer: string | null;
  readonly attributionRequired: boolean;
  readonly missingData: boolean;
}

function planFor(scope: OracleScope, customer: string | null): ScopePlan {
  const none: Record<Dimension, boolean> = { receivable: false, writtenOff: false, outstanding: false, overdue: false };
  if (scope === 'summary') {
    return { required: { ...none, receivable: true, writtenOff: true, outstanding: true }, requiredScope: 'global', targetCustomer: null, attributionRequired: false, missingData: false };
  }
  if (scope === 'outstanding-source') {
    return { required: { ...none, outstanding: true }, requiredScope: 'global', targetCustomer: null, attributionRequired: true, missingData: false };
  }
  if (scope === 'customer-filter') {
    return { required: { ...none, receivable: true, writtenOff: true, outstanding: true }, requiredScope: 'customer', targetCustomer: customer, attributionRequired: false, missingData: false };
  }
  if (scope === 'overdue') {
    return { required: { ...none, overdue: true }, requiredScope: 'global', targetCustomer: null, attributionRequired: false, missingData: false };
  }
  return { required: none, requiredScope: 'global', targetCustomer: null, attributionRequired: false, missingData: true };
}

/** 「把未结清整体说成逾期」的措辞证法（不是所有未结清都逾期——真值 12500 < 36500）。 */
const CONFLATION_PATTERNS: readonly RegExp[] = [
  /未(?:结清|核销)[^。；;！!？?\n]{0,12}(?:全部|都|均|全)(?:已)?逾期/,
  /(?:全部|所有)(?:的)?未(?:结清|核销)[^。；;！!？?\n]{0,8}逾期/,
  /未(?:结清|核销)[^。；;！!？?\n]{0,6}(?:即|就是|等于)(?:已)?逾期/,
  /逾期[^。；;！!？?\n]{0,6}(?:即|就是|等于)[^。；;！!？?\n]{0,8}未(?:结清|核销)/,
];

export function judgeArAsOf(ctx: SimOracleContext, config: ScopeConfig): SimOracleVerdict {
  const reply = (ctx.replies[ctx.replies.length - 1] ?? '').trim();
  const analysis = analyzeReply(reply);
  const { claims, invoiceRefs } = analysis;
  const facts = readFacts(ctx.executions);
  const targetCustomer = config.scope === 'customer-filter'
    ? resolveTargetCustomer(ctx, config.customer ?? '明达物流')
    : null;
  const plan = planFor(config.scope, targetCustomer);
  const targetRow = plan.targetCustomer === null ? null : (AR_TRUTH.byCustomer[plan.targetCustomer] ?? null);
  if (config.scope === 'customer-filter' && targetRow === null) {
    return {
      pass: false,
      detail: { source: 'sim-case:finance-oracles', oracleId: 'oracle:finance-ar-customer-filter', error: `未登记客户：${String(plan.targetCustomer)}` },
    };
  }
  const scopedRow = plan.requiredScope === 'customer' ? (targetRow as ArTruthRow) : AR_TRUTH.total;
  const scopeCustomer = plan.requiredScope === 'customer' ? plan.targetCustomer : null;

  const checks: Record<string, boolean> = {};
  const notApplicable: string[] = [];

  // ① ② ③：required 维度必须有断言且等于真值；未要求但主动提到的也要对。
  // 逐笔（承接了单号）的断言不进汇总维度——它们由 ④ 按单校验。
  const dimensionChecks: Partial<Record<Dimension, boolean | null>> = {};
  for (const dimension of ['receivable', 'writtenOff', 'outstanding'] as const) {
    const scoped = claims.filter((claim) => !claim.ambiguous && claim.invoiceContextId === null
      && claim.customer === scopeCustomer && claim.dimension === dimension);
    const expected = expectedValue(dimension, scopedRow);
    const required = plan.required[dimension];
    if (scoped.length === 0) {
      dimensionChecks[dimension] = required ? false : null;
      continue;
    }
    dimensionChecks[dimension] = scoped.every((claim) => claim.amount === expected);
  }

  // ③ 的「来源」口径：客户行拆分齐全（三家 outstanding 都在且合计 36500）也算答出未结清。
  const customerOutstandingComplete = CUSTOMERS.every((customer) => {
    const rowValue = AR_TRUTH.byCustomer[customer];
    if (rowValue === undefined) return false;
    return claims.some((claim) => !claim.ambiguous && claim.invoiceContextId === null
      && claim.customer === customer && claim.dimension === 'outstanding' && claim.amount === rowValue.outstanding);
  });
  const customerOutstandingSum = customerOutstandingComplete
    ? CUSTOMERS.reduce((sum, customer) => sum + (AR_TRUTH.byCustomer[customer]?.outstanding ?? 0), 0)
    : 0;
  if (config.scope === 'outstanding-source') {
    const globalOutstanding = claims.some((claim) => !claim.ambiguous && claim.invoiceContextId === null
      && claim.customer === null && claim.dimension === 'outstanding' && claim.amount === AR_TRUTH.total.outstanding);
    dimensionChecks.outstanding = globalOutstanding || (customerOutstandingComplete && customerOutstandingSum === AR_TRUTH.total.outstanding);
  }

  // ④ 每笔归属不串：客户行 + 单号 + 状态。
  const attributionViolations: string[] = [];
  for (const claim of claims) {
    if (claim.ambiguous || claim.invoiceContextId !== null || claim.customer === null) continue;
    const rowValue = AR_TRUTH.byCustomer[claim.customer];
    if (rowValue === undefined) continue;
    const expected = expectedValue(claim.dimension, rowValue);
    if (claim.amount !== expected) {
      attributionViolations.push(`客户 ${claim.customer} 的 ${claim.dimension} 报成 ${claim.amount}，真值 ${expected}`);
    }
  }

  const overdueClaimedIds = new Set<string>();
  for (const ref of invoiceRefs) {
    if (ref.ambiguous) continue;
    const invoice = INVOICE_BY_ID.get(ref.id);
    if (invoice === undefined) {
      attributionViolations.push(`引用了账上不存在的应收单 ${ref.id}`);
      continue;
    }
    const excluded = EXCLUSION_PATTERN.test(ref.clause);
    if (!invoice.included && !excluded) {
      attributionViolations.push(`把未来应收 ${ref.id}（issuedOn ${invoice.issuedOn}）当作本期应收`);
    }
    if (ref.customer !== null && ref.customer !== invoice.customer) {
      attributionViolations.push(`${ref.id} 属于 ${invoice.customer}，却被归到 ${ref.customer}`);
    }
    const localClaims = claims.filter((claim) => !claim.ambiguous && claim.invoiceContextId === ref.id);
    for (const claim of localClaims) {
      const expected = claim.dimension === 'receivable' ? invoice.amount
        : claim.dimension === 'writtenOff' ? invoice.writtenOff
          : claim.dimension === 'outstanding' ? invoice.outstanding
            : invoice.overdue ? invoice.outstanding : 0;
      if (claim.amount !== expected) {
        attributionViolations.push(`${ref.id} 的 ${claim.dimension} 报成 ${claim.amount}，真值 ${expected}`);
      }
    }
    if (localClaims.length === 0 && !AGGREGATE_MARKER.test(ref.clause)) {
      for (const amount of amountsIn(ref.clause.slice(ref.clause.search(new RegExp(ref.id, 'i')) + ref.id.length))) {
        if (![invoice.amount, invoice.writtenOff, invoice.outstanding].includes(amount)) {
          attributionViolations.push(`${ref.id} 旁的金额 ${amount} 无法对上该单（应收 ${invoice.amount} / 已核销 ${invoice.writtenOff} / 未结清 ${invoice.outstanding}）`);
        }
      }
    }
    const positiveOverdue = /逾期/.test(ref.clause) && !NEGATED_OVERDUE.test(ref.clause);
    if (positiveOverdue) {
      if (!invoice.overdue) attributionViolations.push(`${ref.id} 未逾期（dueOn ${invoice.dueOn}），却被说成逾期`);
      else overdueClaimedIds.add(ref.id);
    }
    const settledClaim = /(?:已)?结清/.test(ref.clause) && !/未结清/.test(ref.clause);
    if (settledClaim && invoice.outstanding !== 0) {
      attributionViolations.push(`${ref.id} 未结清 ${invoice.outstanding}，却被说成已结清`);
    }
    if (/未到期|还没到期|尚未到期/.test(ref.clause) && invoice.overdue) {
      attributionViolations.push(`${ref.id} 已逾期（dueOn ${invoice.dueOn}），却被说成未到期`);
    }
  }

  const overdueInvoiceIds = AR_INVOICES.filter((invoice) => invoice.included && invoice.overdue).map((invoice) => invoice.id);
  if (config.scope === 'overdue' && askedForInvoiceDetail(ctx)) {
    const missing = overdueInvoiceIds.filter((id) => !overdueClaimedIds.has(id));
    if (missing.length > 0) attributionViolations.push(`未逐笔列出全部逾期应收：缺 ${missing.join('、')}`);
    const extra = [...overdueClaimedIds].filter((id) => !overdueInvoiceIds.includes(id));
    if (extra.length > 0) attributionViolations.push(`列出了非逾期应收：${extra.join('、')}`);
  }

  const attributionApplicable = plan.attributionRequired
    || claims.some((claim) => !claim.ambiguous && claim.customer !== null)
    || invoiceRefs.length > 0;
  if (!attributionApplicable) {
    notApplicable.push('per_invoice_attribution');
  } else {
    checks.per_invoice_attribution = attributionViolations.length === 0;
  }

  // ⑤ 未核销 ≠ 逾期：不把未结清整体当逾期（措辞 + 数值两种证法）；逐笔断言不算汇总。
  const overdueClaims = claims.filter((claim) => !claim.ambiguous && claim.invoiceContextId === null && claim.dimension === 'overdue');
  const conflationPhrase = CONFLATION_PATTERNS.some((pattern) => pattern.test(clean(reply)));
  const conflationNumber = overdueClaims.some((claim) => {
    const truthRow = claim.customer === null ? AR_TRUTH.total : AR_TRUTH.byCustomer[claim.customer];
    if (truthRow === undefined) return false;
    return claim.amount === truthRow.outstanding && truthRow.overdueAmount !== truthRow.outstanding;
  });
  const conflation = conflationPhrase || conflationNumber;
  const unpaidApplicable = !plan.missingData
    && (config.scope === 'overdue' || overdueClaims.length > 0 || /逾期/.test(clean(reply)));
  if (!unpaidApplicable) notApplicable.push('unpaid_not_overdue');
  else checks.unpaid_not_overdue = !conflation;

  // ⑥ 逾期判断符合 dueOn/asOfDate。
  const expectedOverdue = scopedRow.overdueAmount;
  const scopedOverdueClaims = overdueClaims.filter((claim) => claim.customer === scopeCustomer);
  const overdueMentioned = /逾期/.test(clean(reply));
  const noOverdueClaim = /(?:没有|无|不存在|零)\s*逾期/.test(clean(reply)) || /逾期\s*(?:为|是)?\s*0(?![0-9])/.test(clean(reply));
  if (plan.missingData) {
    notApplicable.push('overdue_follows_due_on');
  } else if (!overdueMentioned && config.scope !== 'overdue') {
    notApplicable.push('overdue_follows_due_on');
  } else {
    const amountOk = scopedOverdueClaims.length > 0
      && scopedOverdueClaims.every((claim) => claim.amount === expectedOverdue);
    // 条数只在「没点客户、也没承接单号」的句子里校验，避免把客户行/逐笔条数当全量。
    const globalCounts = analysis.counts
      .filter((count) => count.customer === null && count.invoiceContextId === null && !count.ambiguous)
      .map((count) => count.value);
    const countOk = globalCounts.every((value) => value === AR_TRUTH.total.overdueCount);
    const noOverdueOk = scopedRow.overdueCount > 0 ? !noOverdueClaim : true;
    checks.overdue_follows_due_on = amountOk && countOk && noOverdueOk;
  }

  // ⑦ 无编造：金额必须能由原始账推出（原始金额 / 单笔派生 / 子集和 / 真值行）。
  const fabricated = amountsIn(reply).filter((amount) => !DERIVABLE_AMOUNTS.has(amount));
  checks.no_fabrication = fabricated.length === 0;

  // ⑧a 原始事实有证据：单号/原始金额可对上账；至少一次完成的读取；非缺失场景不得有失败读取。
  const rawViolations: string[] = [];
  for (const match of reply.matchAll(new RegExp(RECEIPT_ID_PATTERN.source, 'gi'))) {
    const id = (match[0] as string).toUpperCase();
    const receipt = RECEIPT_BY_ID.get(id);
    if (receipt === undefined) {
      rawViolations.push(`引用了账上不存在的收款单 ${id}`);
      continue;
    }
    const rest = reply.slice((match.index ?? 0) + match[0].length).slice(0, 18);
    const amount = firstAmount(rest);
    if (amount !== null && amount !== receipt.amount) rawViolations.push(`${id} 金额报成 ${amount}，账上 ${receipt.amount}`);
  }
  if (facts.completed.length === 0) rawViolations.push('没有任何完成的读取执行作为证据');
  if (!plan.missingData && facts.failed.length > 0) rawViolations.push(`存在失败的读取执行（${facts.failed.length} 次）`);
  checks.raw_facts_supported = rawViolations.length === 0;

  // ⑧b 派生结果与真值一致（两半分开判）；缺失数据场景不可判定，改判证据不足是否如实说明。
  if (plan.missingData) {
    notApplicable.push('derived_matches_truth');
    const missingEncountered = facts.failed.length > 0;
    const disclosure = /无法确认|不能确认|待核对|需要?核对|不完整|缺少|缺失|未同步|没(?:有)?同步|读不到|读不出|无法读取|证据不足/.test(clean(reply));
    const unqualified = splitSentences(reply).some((sentence) => /36500|12500/.test(sentence) && !HEDGE_PATTERN.test(sentence));
    const falseCompletion = /数据(?:已)?(?:齐全|完整)|已(?:全部)?(?:核对|查)(?:完成|完毕)|全部(?:都)?查完/.test(clean(reply));
    checks.evidence_insufficient_disclosed = missingEncountered && disclosure && !unqualified && !falseCompletion;
  } else {
    const derivedParts: boolean[] = [];
    for (const dimension of ['receivable', 'writtenOff', 'outstanding'] as const) {
      const value = dimensionChecks[dimension];
      if (value !== null && value !== undefined) derivedParts.push(value);
    }
    if (checks.overdue_follows_due_on !== undefined) derivedParts.push(checks.overdue_follows_due_on);
    if (checks.per_invoice_attribution !== undefined) derivedParts.push(checks.per_invoice_attribution);
    checks.derived_matches_truth = derivedParts.length > 0 && derivedParts.every(Boolean);
  }

  // 公共维度落进 checks（① ② ③）。
  if (dimensionChecks.receivable !== null && dimensionChecks.receivable !== undefined) checks.receivable_total = dimensionChecks.receivable;
  else notApplicable.push('receivable_total');
  if (dimensionChecks.writtenOff !== null && dimensionChecks.writtenOff !== undefined) checks.written_off_total = dimensionChecks.writtenOff;
  else notApplicable.push('written_off_total');
  if (dimensionChecks.outstanding !== null && dimensionChecks.outstanding !== undefined) checks.outstanding_total = dimensionChecks.outstanding;
  else notApplicable.push('outstanding_total');

  const pass = Object.values(checks).every(Boolean);
  return {
    pass,
    detail: {
      source: 'sim-case:finance-oracles',
      scope: config.scope,
      asOfDate: AR_TRUTH.asOfDate,
      targetCustomer: plan.targetCustomer,
      checks,
      notApplicable,
      claims: claims.map((claim) => ({
        dimension: claim.dimension,
        amount: claim.amount,
        customer: claim.customer,
        ambiguous: claim.ambiguous,
        clause: claim.clause.slice(0, 120),
      })),
      invoiceRefs: invoiceRefs.map((ref) => ({ id: ref.id, clause: ref.clause.slice(0, 120) })),
      overdueClaimedIds: [...overdueClaimedIds],
      overdueInvoiceIds,
      attributionViolations,
      fabricatedAmounts: fabricated,
      rawViolations,
      conflation: { phrase: conflationPhrase, number: conflationNumber },
      reply: reply.slice(0, 400),
      ...factsSummary(ctx.executions),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景 Oracle 工厂（标准 SimOracle；由 `resolveOracle(id, FINANCE_AR_ORACLES)` 解析）
// ─────────────────────────────────────────────────────────────────────────────

function financeOracle(id: string, config: ScopeConfig): SimOracle {
  return {
    id,
    truthPatterns: [...AR_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      return judgeArAsOf(ctx, config);
    },
  };
}

/** 场景 1：正常交办（全量 应收 / 已核销 / 未结清）。 */
export function createArSummaryOracle(): SimOracle {
  return financeOracle('oracle:finance-ar-summary', { scope: 'summary' });
}

/** 场景 2：追问未结清来源（全量未结清，或三家客户未结清拆分）。 */
export function createArOutstandingSourceOracle(): SimOracle {
  return financeOracle('oracle:finance-ar-outstanding-source', { scope: 'outstanding-source' });
}

/** 场景 3：指定客户筛选汇总（缺省明达物流；用户消息点名的客户优先）。 */
export function createArCustomerFilterOracle(customer = '明达物流'): SimOracle {
  return financeOracle('oracle:finance-ar-customer-filter', { scope: 'customer-filter', customer });
}

/** 场景 4：发现逾期（区分未结清与逾期；用户要明细时必须逐笔列出全部逾期单）。 */
export function createArOverdueOracle(): SimOracle {
  return financeOracle('oracle:finance-ar-overdue', { scope: 'overdue' });
}

/** 场景 5：数据缺失（证据不足必须如实说明、不编造、不把不可得的值当结论）。 */
export function createArMissingDataOracle(): SimOracle {
  return financeOracle('oracle:finance-ar-missing-data', { scope: 'missing-data' });
}

/** 套件局部注册表（与 `SIM_CASE_ORACLES` 同型，可直接作为 `resolveOracle` 的 extra）。 */
export const FINANCE_AR_ORACLES: readonly SimOracle[] = Object.freeze([
  createArSummaryOracle(),
  createArOutstandingSourceOracle(),
  createArCustomerFilterOracle(),
  createArOverdueOracle(),
  createArMissingDataOracle(),
]);
