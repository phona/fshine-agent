import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  aggregateMetrics,
  classifyExecutionCall,
  messageLadderRung,
  type AggregateMetrics,
  type CallLadderEntry,
  type ExecutionAuditRow,
  type HostDelegationFacts,
  type HostGateRow,
  type HostIntentFacts,
  type LadderRung,
  type MetricCaseInput,
} from './evidence';

/**
 * 统一评测报告（issue 切片 D）：一条命令产出的 JSON + JSONL 两份面。
 *
 * 判定的唯一依据是宿主/执行层持有的结构化事实（scripts/eval/evidence.ts 的三源证据），
 * **不读模型自述**：
 *   · 用户可见交付 = handler 返回的最终回复非空（delivered 的唯一判据）；
 *   · 执行层状态 / 写后读回 = 执行层审计行（mode/script/args/refused/exitCode）+
 *     宿主 change_intents 的 committed+读回摘要（verified 只由它授予，执行层自己说"成了"不算）；
 *   · 宿主审计与调用记录 = tool_calls 的 serve_gate:* 门裁决行 + task_runs 的委派事实；
 *   · 时延 = 逐轮墙钟；可获得 usage = 埋点行的真实 provider 分项（缺席即缺席，不编零）。
 *
 * 每条平台调用标 authorized/invoked/completed/verified/delivered；无证据标 INCONCLUSIVE
 * 而非成功（issue 验收标准原话的机械对应）。
 *
 * 两份面的分工：
 *   · JSON（eval-report-<runId>.json）= 全量结构（逐用例、逐轮、逐调用 + 聚合指标），
 *     人读与程序化消费（score.ts 等）；
 *   · JSONL（eval-report-<runId>.jsonl）= 一行一次平台调用，扁平可 grep / 可追加，
 *     跨 run 对齐用（evalRunId/caseId/messageId/script/rung）。
 */

/** 一条平台调用在报告里的行（JSONL 的一行 = 这个形状）。 */
export interface ReportCallLine {
  at: string;
  evalRunId: string;
  caseId: string;
  /** 轮下标（0-based）与消息 id（关联链起点）。 */
  turnIndex: number;
  messageId: string;
  script: string;
  rung: CallLadderEntry['rung'];
  refusedReason?: string;
  basis: string[];
  /** 该轮整体阶梯（链上最低档；无执行层证据 = INCONCLUSIVE）。 */
  turnRung: LadderRung | 'INCONCLUSIVE';
  latencyMs: number;
}

/** 一轮的报告行（用户可见交付 + 该轮调用阶梯 + 时延 + usage）。 */
export interface ReportTurnLine {
  turnIndex: number;
  messageId: string;
  text: string;
  /** 用户可见交付（最终回复；handler 抛错/未返回时为 null）。 */
  reply: string | null;
  notices: string[];
  delivered: boolean;
  latencyMs: number;
  ladderRung: LadderRung | 'INCONCLUSIVE';
  ladder: CallLadderEntry[];
  /** 该轮已执行 / 被拒的调用数（执行层审计口径）。 */
  executedCalls: number;
  refusedCalls: number;
  /** 真实 provider usage 分项（无证据时整个字段缺席，不编零）。 */
  tokens?: { main?: number; worker?: number };
}

/** 一个用例的报告行。 */
export interface ReportCaseLine {
  caseId: string;
  group?: string;
  intent?: string;
  ok: boolean;
  /**
   * 用例判定（与 score.ts 的 judged/skipped 同口径）：`pass`/`fail` 是完整判定结果，
   * `skip` = 未进基线 / 占位条目，**不进通过率分母也不冒充通过**（2026-11-10 独立评审
   * medium：旧报告只有 ok，跳过用例的 ok 仍是 true，只看 cases 的消费者会误读成通过）。
   * 给了 passOf 时以它为准；没给时按 ok。
   */
  verdict: 'pass' | 'fail' | 'skip';
  notes: string[];
  turns: ReportTurnLine[];
  /** 用例内全部调用的阶梯（跨轮拼起来；门禁时序/风暴的聚合面）。 */
  ladder: CallLadderEntry[];
  /** 写路径的宿主事实（提案意图：committed + 读回摘要）。 */
  intents: HostIntentFacts[];
  /** 宿主门裁决行（serve_gate:* / platform_executor_bypassed）。 */
  gateRows: HostGateRow[];
  /** 委派事实（task_runs：挂起等人的停点在这里可见）。 */
  delegations: HostDelegationFacts[];
  durationMs: number;
  tokens?: number;
  /** 干预停点数（pending 意图 + waiting_* run，按首次出现去重）。 */
  interventionPoints: number;
}

export interface UnifiedReport {
  at: string;
  evalRunId: string;
  kind: 'eval-report';
  /** 报告口径说明（判定独立于 Agent 自述的凭据）。 */
  basis: string[];
  cases: ReportCaseLine[];
  calls: ReportCallLine[];
  metrics: AggregateMetrics;
}

/** 报告输入：逐用例的事实（探针/验收 runner 采集后传进来）。 */
export interface ReportCaseInput {
  caseId: string;
  group?: string;
  intent?: string;
  ok: boolean;
  notes: string[];
  turns: Array<{
    messageId: string;
    text: string;
    reply: string | null;
    notices: string[];
    ms: number;
    execution: ExecutionAuditRow[];
    tokens?: { main?: number; worker?: number };
  }>;
  intents: HostIntentFacts[];
  gateRows: HostGateRow[];
  delegations: HostDelegationFacts[];
}

const REPORT_BASIS = [
  '用户可见交付 = handler 返回的最终回复（非空才标 delivered）',
  '执行层状态 = EXECUTION_AUDIT_PATH 的审计行（refused 在册 = 调到了门、未执行）',
  '写后读回 = 宿主 change_intents 的 committed + result 摘要（verified 只由它授予）',
  '宿主审计与调用记录 = tool_calls 的 serve_gate:* 行 + task_runs 委派事实',
  '无证据标 INCONCLUSIVE，不标成功',
] as const;

/** 干预停点去重计数（会话级常驻的 pending 意图/挂起 run 只计一次）。 */
function countInterventionPoints(
  intents: readonly HostIntentFacts[],
  delegations: readonly HostDelegationFacts[],
): number {
  const intents_ = new Set(intents.filter((intent) => intent.status === 'pending').map((intent) => intent.intentId));
  const runs = new Set(
    delegations
      .filter((run) => run.state === 'waiting_confirmation' || run.state === 'waiting_input')
      .map((run) => run.runId ?? run.taskId),
  );
  return intents_.size + runs.size;
}

/** 逐用例事实 → 报告行（纯函数：同一输入同一输出，可单测）。 */
export function buildCaseReport(input: ReportCaseInput): ReportCaseLine {
  // 读回证据**逐条调用**关联（2026-11-09 四审 blocking）：旧写法
  // `input.intents.some(committed && hasReadback)` 是**用例级**的——本用例只要成功提交过
  // 一笔，后续另一 proposalId 的未验证写调用也会被判 verified/delivered，甚至更早轮次被
  // 追认成功。ask-session 侧已按 proposalId 修过，这个生产报告入口是同一条判据的第二个
  // 落点，一并收口。关联键 = 该行 proposalId ↔ 意图 proposalId；关联不上 = 未验证。
  const verifiedProposals = new Set(
    input.intents
      .filter((intent) => intent.status === 'committed' && intent.hasReadback && intent.proposalId)
      .map((intent) => intent.proposalId!),
  );
  const readbackFor = (row: { proposalId?: string }): boolean =>
    row.proposalId !== undefined && verifiedProposals.has(row.proposalId);
  const ladder: CallLadderEntry[] = [];
  const turns: ReportTurnLine[] = input.turns.map((turn, index) => {
    const delivered = typeof turn.reply === 'string' && turn.reply.length > 0;
    const turnLadder = turn.execution.map((row) => classifyExecutionCall({ row, readbackVerified: readbackFor(row), delivered }));
    ladder.push(...turnLadder);
    const main = turn.tokens?.main;
    const worker = turn.tokens?.worker;
    return {
      turnIndex: index,
      messageId: turn.messageId,
      text: turn.text,
      reply: turn.reply,
      notices: turn.notices,
      delivered,
      latencyMs: turn.ms,
      ladderRung: messageLadderRung(turnLadder),
      ladder: turnLadder,
      executedCalls: turn.execution.filter((row) => !row.refused).length,
      refusedCalls: turn.execution.filter((row) => row.refused).length,
      ...((main !== undefined || worker !== undefined)
        ? { tokens: { ...(main !== undefined ? { main } : {}), ...(worker !== undefined ? { worker } : {}) } }
        : {}),
    };
  });
  const durationMs = turns.reduce((sum, turn) => sum + turn.latencyMs, 0);
  const mainTotal = input.turns.reduce((sum, turn) => sum + (turn.tokens?.main ?? 0), 0);
  const workerTotal = input.turns.reduce((sum, turn) => sum + (turn.tokens?.worker ?? 0), 0);
  const hasTokens = input.turns.some((turn) => turn.tokens?.main !== undefined || turn.tokens?.worker !== undefined);
  return {
    caseId: input.caseId,
    ...(input.group ? { group: input.group } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    ok: input.ok,
    verdict: input.ok ? 'pass' : 'fail',
    notes: input.notes,
    turns,
    ladder,
    intents: input.intents,
    gateRows: input.gateRows,
    delegations: input.delegations,
    durationMs,
    ...(hasTokens ? { tokens: mainTotal + workerTotal } : {}),
    interventionPoints: countInterventionPoints(input.intents, input.delegations),
  };
}

/** 扁平化：一行一次平台调用（JSONL 面）。 */
export function buildCallLines(report: Omit<UnifiedReport, 'calls' | 'metrics'>): ReportCallLine[] {
  const lines: ReportCallLine[] = [];
  for (const item of report.cases) {
    for (const turn of item.turns) {
      for (const entry of turn.ladder) {
        lines.push({
          at: report.at,
          evalRunId: report.evalRunId,
          caseId: item.caseId,
          turnIndex: turn.turnIndex,
          messageId: turn.messageId,
          script: entry.script,
          rung: entry.rung,
          ...(entry.refusedReason ? { refusedReason: entry.refusedReason } : {}),
          basis: entry.basis,
          turnRung: turn.ladderRung,
          latencyMs: turn.latencyMs,
        });
      }
    }
  }
  return lines;
}

/**
 * 聚合指标输入（通过率/干预/安全违规/耗时/Token）。
 *
 * 2026-11-09 十三审 major：pass 改用**完整用例判定**（旧三层 + 期望值层），不再只取
 * `item.ok`（探针自身的 ok = 没有 note）。本 PR 明确要捕获的形态正是"旧三层通过、期望值层
 * 失败"——那种结果旧写法会在这份统一报告里计成通过，与 score.ts 的最终打分自相矛盾。
 * 用例判定由调用方经 `passOf` 注入（score.ts 的 evaluateProbeCase 是那一层的权威），
 * 本模块不重复实现一遍判据。
 */
export function metricInputs(
  cases: readonly ReportCaseLine[],
  passOf?: (item: ReportCaseLine) => boolean | undefined,
): MetricCaseInput[] {
  return cases.flatMap((item) => {
    const pass = passOf ? passOf(item) : item.verdict === 'skip' ? undefined : item.verdict === 'pass';
    // undefined = 跳过（未跑起来的占位条目 / 未进基线的用例）：与 score.ts 的 skipped
    // 口径一致——不进通过率分母，也不冒充通过。用例行本身仍留在报告 cases 里可审计。
    if (pass === undefined) return [];
    return [{
      caseId: item.caseId,
      pass,
      ladder: item.ladder,
      interventionPoints: item.interventionPoints,
      durationMs: item.durationMs,
      ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
      // 门裁决 error 行 = 安全违规的第二来源（与 evidence.aggregateMetrics 同口径）。
      ...(item.gateRows.length ? { gateErrors: item.gateRows.filter((row) => row.status === 'error').length } : {}),
    }];
  });
}

/** 组一份统一报告（JSON 面的对象）。 */
export function buildUnifiedReport(args: {
  at: string;
  evalRunId: string;
  cases: ReportCaseInput[];
  /**
   * 逐用例的完整判定（旧三层 + 期望值层）。给了它，报告通过率就与 score.ts 的最终打分
   * 同源；不给则退回探针自身 ok（会在"旧三层过、期望值层失败"的用例上虚高）。
   * 返回 `undefined` = 该用例跳过（占位条目/未跑），不进通过率分母（见 metricInputs）。
   */
  passOf?: (item: ReportCaseLine) => boolean | undefined;
}): UnifiedReport {
  const caseLines = args.cases.map((input) => {
    const line = buildCaseReport(input);
    if (!args.passOf) return line;
    const pass = args.passOf(line);
    return { ...line, verdict: pass === undefined ? 'skip' as const : pass ? 'pass' as const : 'fail' as const };
  });
  const head = { at: args.at, evalRunId: args.evalRunId, kind: 'eval-report' as const, basis: [...REPORT_BASIS], cases: caseLines };
  return { ...head, calls: buildCallLines(head), metrics: aggregateMetrics(metricInputs(caseLines)) };
}

/** 落盘两份面：.runtime/eval-report-<evalRunId>.json 与同名 .jsonl。 */
export function writeUnifiedReport(dir: string, report: UnifiedReport): { json: string; jsonl: string } {
  const jsonPath = path.join(dir, `eval-report-${report.evalRunId}.json`);
  const jsonlPath = path.join(dir, `eval-report-${report.evalRunId}.jsonl`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(
    jsonlPath,
    report.calls.map((line) => JSON.stringify(line)).join('\n') + (report.calls.length ? '\n' : ''),
  );
  return { json: jsonPath, jsonl: jsonlPath };
}

/** 人读摘要（终端用）：聚合指标 + 阶梯分布。 */
export function summarizeReport(report: UnifiedReport): string {
  const rungCounts = new Map<string, number>();
  // 2026-11-09 四审 minor：旧写法 `get(...) ?? 0 + 1` 被解析成 `get(...) ?? (0 + 1)`
  // ——空值合并优先级低于加法，于是键已存在时原样返回旧计数、永不递增，同档十次调用也显示 1，
  // 终端摘要低报调用量。加括号修正。
  for (const line of report.calls) rungCounts.set(line.rung, (rungCounts.get(line.rung) ?? 0) + 1);
  const rungs = [...rungCounts.entries()].map(([rung, count]) => `${rung} ${count}`).join('、') || '无调用';
  const tokenNote = report.metrics.tokens === undefined ? 'usage 无证据' : `tokens ${report.metrics.tokens}`;
  // 安全违规：null = 未测（无证据源），不是 0。渲染成"未测"，别让它读起来像"测过、0 违规"。
  const violationNote = report.metrics.safetyViolations === null
    ? '安全违规 未测（无证据源）'
    : `安全违规 ${report.metrics.safetyViolations}`;
  return [
    `用例 ${report.metrics.passed}/${report.metrics.cases}（通过率 ${(report.metrics.passRate * 100).toFixed(0)}%）`,
    `干预 ${report.metrics.interventions} 次`,
    `门拒绝 ${report.metrics.gateRefusals} 次`,
    violationNote,
    `耗时 ${(report.metrics.durationMs / 1000).toFixed(1)}s`,
    tokenNote,
    `调用阶梯：${rungs}`,
  ].join(' · ');
}
