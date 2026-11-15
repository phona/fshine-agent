/**
 * D6 指标抽取（纯函数，只读 run-dir；零产品码改动）。
 *
 * 从 `collect.ts` 落盘的逐样本 run-dir 抽取 D 轴（规模/资源）指标，逐指标
 * `{available, value, source, note}`，沿用 collect 的诚实纪律：不可得如实标注、
 * 不编造数字；无取消样本的取消残留标 not-applicable 而非 0。
 *
 * 指标（设计登记）：
 *   1. activeTasksPeak    活跃任务峰值（task-facts 时间戳扫描；无 task-facts 降级上界）
 *   2. workerStarts       worker 会话启动次数（worker 调用按 (turn,taskId) 去重首条）
 *   3. toolCalls          工具调用总数 + agent×tool 分桶；worker execute_operation
 *                         与 tasks.json executions[] 交叉核对（不一致写 note）
 *   4. inFlightPeak       在飞工具调用峰值（startedAt+elapsedMs 区间最大重叠；
 *                         明示是 in-flight 峰值而非队列长度）
 *   5. tokens             累计 token（逐轮 available 全真才有效，复用
 *                         summarizeModelUsage 判定）+ 预算使用率（hardlimits.json）
 *   6. postCancelResidue  取消后残留执行（仅当证据含取消事实才计算）
 *   7. resourceRelease    样本级不可得 → 引用 batch 层 report.json 的 resources
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { summarizeModelUsage, type TaskFactLine } from './collect';
import type { ExecutionsExport, MetaFile, ToolCallRecord } from '../convergence-r1/evidence';

export interface D6Metric<V> {
  available: boolean;
  value?: V;
  source: string;
  note: string;
}

export interface ActiveTasksPeakValue {
  peak: number;
  /** 降级口径（无 task-facts 时间戳）只能给上界。 */
  isUpperBound?: boolean;
}

export interface ToolCallsValue {
  total: number;
  byAgentTool: Record<string, number>;
  workerExecuteOperations: number;
}

export interface TokensValue {
  total: number;
  budgetMax?: number;
  utilization?: number;
}

export interface PostCancelResidueValue {
  cancelledTaskId: string;
  cancelledAt: string;
  toolCallsAfter: number;
  executionsAfter: number;
  auditLinesAfter: number;
  residue: boolean;
}

export interface D6Metrics {
  activeTasksPeak: D6Metric<ActiveTasksPeakValue>;
  workerStarts: D6Metric<number>;
  toolCalls: D6Metric<ToolCallsValue>;
  inFlightPeak: D6Metric<number>;
  tokens: D6Metric<TokensValue>;
  postCancelResidue: D6Metric<PostCancelResidueValue>;
  resourceRelease: D6Metric<unknown>;
  /** 抽取来源 run-dir（复核定位用）。 */
  runDir: string;
}

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'refused', 'cancelled', 'canceled']);
const CANCEL_STATES = new Set(['cancelled', 'canceled']);

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        // collect.ts 的 jsonl() 对字符串行二次编码（auditLines 原文行落成 "\"…\""），读回需再解一层。
        if (typeof parsed === 'string') return JSON.parse(parsed) as T;
        return parsed as T;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is T => r !== undefined);
}

/** worker 调用的会话键：tool-calls schema 无 taskId 字段，args 内若有 taskId 优先用之，否则按 turn 归并（同一 turn 的 worker 调用属同一委派会话）。 */
function workerSessionKey(call: ToolCallRecord): string {
  const args = (call.args ?? {}) as { taskId?: unknown };
  const taskId = typeof args.taskId === 'string' && args.taskId !== '' ? args.taskId : undefined;
  return taskId === undefined ? `turn:${call.turn}` : `task:${taskId}`;
}

function tsMs(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? NaN : t;
}

/** 活跃任务峰值：task-facts 时间戳扫描（进非终态 +1 / 进终态 -1）。 */
function peakFromTaskFacts(facts: readonly TaskFactLine[]): number | undefined {
  const events = facts
    .map((f) => ({ ts: tsMs(f.ts), delta: TERMINAL_TASK_STATES.has(f.to) ? -1 : 1 }))
    .filter((e) => !Number.isNaN(e.ts))
    .sort((a, b) => a.ts - b.ts);
  if (events.length === 0) return undefined;
  let active = 0;
  let peak = 0;
  for (const e of events) {
    active += e.delta;
    if (active > peak) peak = active;
  }
  return peak;
}

/** 在飞工具调用峰值：区间最大重叠（sweep：起点 +1 / 终点 -1，同一时刻先结束）。 */
function inFlightPeakOf(calls: readonly ToolCallRecord[]): number | undefined {
  const events: Array<{ t: number; d: number }> = [];
  for (const c of calls) {
    const s = tsMs(c.startedAt);
    if (Number.isNaN(s)) continue;
    const e = s + (Number.isFinite(c.elapsedMs) ? c.elapsedMs : 0);
    events.push({ t: s, d: 1 }, { t: e, d: -1 });
  }
  if (events.length === 0) return undefined;
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/** hardlimits.json 由 run.ts 落在批根（run-dir 上两级）；run-dir 内也容忍（自包含夹具）。 */
function findHardLimits(runDir: string): Record<string, unknown> | undefined {
  return readJson<Record<string, unknown>>(path.join(runDir, 'hardlimits.json'))
    ?? readJson<Record<string, unknown>>(path.join(runDir, '..', '..', 'hardlimits.json'));
}

/** 从一次 run-dir 抽取 D6 指标（只读，不落盘；调用方决定并入 manifest 或写 d6.json）。 */
export function extractD6(runDir: string): D6Metrics {
  // ── 1) 活跃任务峰值 ─────────────────────────────────────────────
  const facts = readJsonl<TaskFactLine>(path.join(runDir, 'task-facts.jsonl'));
  const meta = readJson<MetaFile>(path.join(runDir, 'meta.json'));
  const tasksExport = readJson<ExecutionsExport>(path.join(runDir, 'tasks.json'));
  const toolCallsFile = readJson<{ toolCalls: ToolCallRecord[] }>(path.join(runDir, 'tool-calls.json'));
  const calls = toolCallsFile?.toolCalls ?? [];

  let activeTasksPeak: D6Metric<ActiveTasksPeakValue>;
  const scanned = facts.length > 0 ? peakFromTaskFacts(facts) : undefined;
  if (scanned !== undefined) {
    activeTasksPeak = { available: true, value: { peak: scanned }, source: 'task-facts.jsonl', note: '时间戳扫描：进非终态 +1、进终态（completed/failed/refused/cancelled）-1，取扫描中最大同时活跃数' };
  } else if ((meta?.turns?.length ?? 0) > 0) {
    // 降级：taskIds 累积集 − 终态任务；无时间戳只能给上界。
    const seen = new Set<string>();
    for (const t of meta!.turns) for (const id of t.taskIds ?? []) seen.add(id);
    const terminal = new Set((tasksExport?.tasks ?? []).filter((t) => TERMINAL_TASK_STATES.has(t.status)).map((t) => t.taskId));
    const upper = [...seen].filter((id) => !terminal.has(id)).length;
    activeTasksPeak = { available: true, value: { peak: upper, isUpperBound: true }, source: 'meta.turns[].taskIds', note: '无 task-facts 时间戳，降级为 meta.turns[].taskIds 累积集减 tasks.json 终态任务的上界（无时间序列，不能给真实峰值）' };
  } else {
    activeTasksPeak = { available: false, source: 'task-facts.jsonl / meta.json', note: 'task-facts 与 meta.turns 均不可得或为空' };
  }

  // ── 2) worker 启动次数 ─────────────────────────────────────────
  const workerCalls = calls.filter((c) => c.agent === 'worker');
  const workerSessions = new Set(workerCalls.map(workerSessionKey));
  const workerStarts: D6Metric<number> = calls.length === 0
    ? { available: false, source: 'tool-calls.json', note: 'tool-calls.json 不可得或为空' }
    : { available: true, value: workerSessions.size, source: 'tool-calls.json', note: 'agent=worker 调用按会话键（args.taskId，缺省按 turn 归并）去重后计数；每会话首个 worker 调用=一次 worker 启动' };

  // ── 3) 工具调用次数 + 交叉核对 ────────────────────────────────
  const byAgentTool: Record<string, number> = {};
  for (const c of calls) byAgentTool[`${c.agent}/${c.tool}`] = (byAgentTool[`${c.agent}/${c.tool}`] ?? 0) + 1;
  const workerExecCount = byAgentTool['worker/execute_operation'] ?? 0;
  const executionsTotal = (tasksExport?.tasks ?? []).reduce((a, t) => a + t.executions.length, 0);
  let tcNote = `总数 + agent×tool 分桶（与样本实查同口径）；worker execute_operation=${workerExecCount} 即执行层调用次数`;
  if (workerExecCount !== executionsTotal) {
    tcNote += `；不一致：tasks.json executions 总数=${executionsTotal}（缺失=被宿主拒绝前不发执行、或多路复用），已登记不判`;
  }
  const toolCalls: D6Metric<ToolCallsValue> = calls.length === 0
    ? { available: false, source: 'tool-calls.json', note: 'tool-calls.json 不可得或为空' }
    : { available: true, value: { total: calls.length, byAgentTool, workerExecuteOperations: workerExecCount }, source: 'tool-calls.json', note: tcNote };

  // ── 4) 在飞工具调用峰值 ────────────────────────────────────────
  const inFlight = inFlightPeakOf(calls);
  const inFlightPeak: D6Metric<number> = inFlight === undefined
    ? { available: false, source: 'tool-calls.json', note: 'startedAt/elapsedMs 不可得，无法扫描区间重叠（队列长度本就无原生记录）' }
    : { available: true, value: inFlight, source: 'tool-calls.json', note: 'in-flight 工具调用峰值（startedAt+elapsedMs 区间最大重叠），非排队深度/队列长度——队列无原生记录，不做「待运行−observedMaxConcurrency」推导' };

  // ── 5) 累计 token / 预算 ────────────────────────────────────────
  let tokens: D6Metric<TokensValue>;
  if (meta === undefined) {
    tokens = { available: false, source: 'meta.json', note: 'meta.json 不可得' };
  } else {
    const usage = summarizeModelUsage(meta);
    if (!usage.available || usage.tokens.total === undefined) {
      tokens = { available: false, source: 'meta.json', note: usage.note };
    } else {
      const limits = findHardLimits(runDir);
      const budgetRaw = limits === undefined ? undefined : (limits as { maxTokens?: unknown }).maxTokens;
      const budget = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : undefined;
      if (budget === undefined) {
        tokens = { available: true, value: { total: usage.tokens.total }, source: 'meta.json + hardlimits.json', note: `token 可得（${usage.note}）；但预算不可得（hardlimits 缺失或 maxTokens=unavailable），不给使用率` };
      } else {
        const utilization = usage.tokens.total / budget;
        tokens = { available: true, value: { total: usage.tokens.total, budgetMax: budget, utilization }, source: 'meta.json + hardlimits.json', note: `累计=逐轮求和；使用率=累计/登记上限（${usage.tokens.total}/${budget}）` };
      }
    }
  }

  // ── 6) 取消后残留执行 ──────────────────────────────────────────
  const cancelFromFacts = facts.find((f) => CANCEL_STATES.has(f.to));
  const cancelFromNotes = readJsonl<{ ts: string; kind: string; taskId: string }>(path.join(runDir, 'notifications.jsonl'))
    .find((n) => n.kind === 'cancel' || n.kind === 'cancelled');
  const cancel = cancelFromFacts !== undefined
    ? { taskId: cancelFromFacts.taskId, ts: cancelFromFacts.ts }
    : cancelFromNotes === undefined ? undefined : { taskId: cancelFromNotes.taskId, ts: cancelFromNotes.ts };
  let postCancelResidue: D6Metric<PostCancelResidueValue>;
  if (cancel === undefined) {
    postCancelResidue = { available: false, source: 'task-facts.jsonl / notifications.jsonl', note: 'not-applicable：本 run 无取消事实（无 to=cancelled 事实、无 cancel 通知），不按 0 计' };
  } else {
    const cut = tsMs(cancel.ts);
    // 归属：调用 args 带 taskId 直接归属；带 ref（'#n'）按 tasks.json 创建序近似解析；
    // 均无则不可归属（undefined）。
    const refIndex = new Map<string, string>();
    (tasksExport?.tasks ?? []).forEach((t, i) => refIndex.set(`#${i + 1}`, t.taskId));
    const attributedTaskId = (c: ToolCallRecord): string | undefined => {
      const args = (c.args ?? {}) as { taskId?: unknown; ref?: unknown };
      if (typeof args.taskId === 'string' && args.taskId !== '') return args.taskId;
      if (typeof args.ref === 'string' && refIndex.has(args.ref)) return refIndex.get(args.ref);
      return undefined;
    };
    // 残留=被取消任务自身在取消之后的执行活动，不是「取消之后任意调用」：
    // main 面控制调用（task_status / task_result / 其他任务的 run_task）与被取消任务无关，
    // 毫秒粒度下会把合法后续轮误计成残留（测量面缺陷，非产品竞态）。判据：
    //   tool-calls —— 归属到被取消任务，或未归属到其他任务的 worker 执行回合；
    //   executions —— 仅被取消任务自身（updatedAt>cut 为新增近似）；
    //   audit —— 可解析且带 taskId 时按归属过滤，否则按时间戳保守计数。
    const toolCallsAfter = calls.filter((c) => {
      const s = tsMs(c.startedAt);
      if (Number.isNaN(s) || Number.isNaN(cut) || s <= cut) return false;
      const attr = attributedTaskId(c);
      if (attr !== undefined && attr !== cancel.taskId) return false;
      return attr === cancel.taskId || c.agent === 'worker';
    }).length;
    // executions 行无独立时间戳：以所属任务 updatedAt>cut 为新增近似（note 标注）。
    const executionsAfter = (tasksExport?.tasks ?? [])
      .filter((t) => t.taskId === cancel.taskId)
      .filter((t) => { const u = tsMs(t.updatedAt); return !Number.isNaN(u) && !Number.isNaN(cut) && u > cut; })
      .reduce((a, t) => a + t.executions.length, 0);
    const auditLinesAfter = readJsonl<{ ts?: string; taskId?: unknown }>(path.join(runDir, 'audit.jsonl'))
      .filter((r) => {
        const t = r.ts === undefined ? NaN : tsMs(r.ts);
        if (Number.isNaN(t) || Number.isNaN(cut) || t <= cut) return false;
        return !(typeof r.taskId === 'string' && r.taskId !== cancel.taskId);
      }).length;
    const residue = toolCallsAfter > 0 || executionsAfter > 0 || auditLinesAfter > 0;
    postCancelResidue = {
      available: true,
      value: { cancelledTaskId: cancel.taskId, cancelledAt: cancel.ts, toolCallsAfter, executionsAfter, auditLinesAfter, residue },
      source: 'task-facts.jsonl + tool-calls.json + tasks.json + audit.jsonl',
      note: `残留=被取消任务自身在取消时间戳之后的执行活动（归属到该任务的 tool-calls / 未归属其他任务的 worker 回合 / 该任务 executions 新行 / 归属该任务的 audit 新行，任一>0 即残留）；executions 行无独立时间戳，以任务 updatedAt 近似；ref 按 tasks.json 创建序近似解析`,
    };
  }

  // ── 7) 停止后资源释放 ──────────────────────────────────────────
  const report = readJson<{ resources?: unknown }>(path.join(runDir, '..', '..', 'report.json'));
  const resourceRelease: D6Metric<unknown> = report?.resources !== undefined
    ? { available: true, value: report.resources, source: 'report.json (batch)', note: '样本级 RSS/CPU 不可得，引用 batch 层 report.json 的 resources（batch.ts 批级采样）' }
    : { available: false, source: 'report.json (batch)', note: '样本级不可得（RSS/CPU 只在 batch 层采样）；本 run-dir 无批级 report.json，停止后资源释放无法从样本证据判定' };

  return { activeTasksPeak, workerStarts, toolCalls, inFlightPeak, tokens, postCancelResidue, resourceRelease, runDir };
}
