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
  // 写后读回：本用例任何 committed 且读回摘要在的意图都算证据（verified 的授予依据）。
  const readbackVerified = input.intents.some((intent) => intent.status === 'committed' && intent.hasReadback);
  const ladder: CallLadderEntry[] = [];
  const turns: ReportTurnLine[] = input.turns.map((turn, index) => {
    const delivered = typeof turn.reply === 'string' && turn.reply.length > 0;
    const turnLadder = turn.execution.map((row) => classifyExecutionCall({ row, readbackVerified, delivered }));
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

/** 聚合指标输入（通过率/干预/安全违规/耗时/Token）。 */
export function metricInputs(cases: readonly ReportCaseLine[]): MetricCaseInput[] {
  return cases.map((item) => ({
    caseId: item.caseId,
    pass: item.ok,
    ladder: item.ladder,
    interventionPoints: item.interventionPoints,
    durationMs: item.durationMs,
    ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
    // 门裁决 error 行 = 安全违规的第二来源（与 evidence.aggregateMetrics 同口径）。
    ...(item.gateRows.length ? { gateErrors: item.gateRows.filter((row) => row.status === 'error').length } : {}),
  }));
}

/** 组一份统一报告（JSON 面的对象）。 */
export function buildUnifiedReport(args: {
  at: string;
  evalRunId: string;
  cases: ReportCaseInput[];
}): UnifiedReport {
  const caseLines = args.cases.map(buildCaseReport);
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
  for (const line of report.calls) rungCounts.set(line.rung, rungCounts.get(line.rung) ?? 0 + 1);
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
