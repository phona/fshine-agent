#!/usr/bin/env tsx
/**
 * SPIKE 三轴测量（确定性、离线、零模型调用）。
 *
 * 输入（一次探针跑的产物）：
 *   --probe      探针报告 JSON（`scripts/probe-real-agent.ts` 写的 `.runtime/probe-*.json`）
 *   --audit      执行层审计 JSONL（可选；缺省用探针报告里逐轮内嵌的 execution 行）
 *   --plan-state 执行层计划账本 plans.json（可选；档位分布 / SCOPE_EXPANSION 的权威来源）
 *   --state-dir  探针状态根（可选；自动发现 plans*.json / audit*.jsonl）
 *   --cases      用例语料（缺省 scripts/eval/cases.yaml）
 *
 * 输出：一份 JSON（三轴）+ 一份 confirm/notify 原文文本（给人读，机器不判）。
 *
 * 三轴：
 *   ① 门守不守：档位分布、stop/confirm 实际发生、越界拒收、SCOPE_EXPANSION 理由码、用户确认。
 *   ② 召回漂移进没进执行：recall 轮回复里的数字 vs 账本记录值；漂移值是否出现在后续计划调用参数。
 *   ③ 确认面人话：confirm/notify 原文逐条过 `executionLanguageFingerprints`，报命中标签；原文另存。
 *
 * 纪律：
 *   · 不调用模型、不读网络、不读任何 API key；
 *   · 同样的输入跑两次输出逐字节一致（不写时间戳、路径只写相对/文件名）；
 *   · 缺证据报 null 并写 note，绝不把「没有证据」写成 0 或成功。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { executionLanguageFingerprints } from '@fshine/agent';
import { loadCases, type CaseSpec, type CaseMessage } from './cases';
import { extractAmounts, isVerifiedArithmetic, isVerifiedTotal } from './amount-criteria';

// ── 输入形状（只声明本脚本消费的字段；缺席 = 没写过，不是假） ──

export interface AuditRow {
  ts?: string;
  mode?: string;
  script?: string;
  args?: unknown;
  serve?: boolean;
  refused?: string;
  exitCode?: number;
  planId?: string;
  callId?: string;
  phase?: string;
  /** 部分执行层把计划裁决写进审计行；有则直接数，不另行猜。 */
  decision?: string;
  tier?: string;
  planDecision?: string;
  reasonCode?: string;
  result?: {
    status?: string;
    items?: Array<{ id?: string; name?: string; value?: number }>;
    count?: number;
    fields?: string[];
    [identity: string]: unknown;
  };
}

export interface ProbeTurn {
  text?: string;
  reply?: string | null;
  notices?: unknown[];
  execution?: AuditRow[];
  taskIds?: string[];
}

export interface ProbeCase {
  id: string;
  group?: string;
  intent?: string;
  turns?: ProbeTurn[];
  taskIds?: string[];
}

export interface ProbeReport {
  at?: string;
  audited?: boolean;
  results?: ProbeCase[];
}

export interface PlanRecord {
  id: string;
  taskId?: string;
  version?: number;
  decision?: string;
  reasonCode?: string;
  status?: string;
  activatedEvidence?: string;
  estimate?: { calls?: number; seconds?: number; weight?: number };
}

export interface MeasurementOptions {
  probePath: string;
  auditPath?: string;
  planStatePath?: string;
  stateDir?: string;
  casesPath: string;
  outPath: string;
  humanOutPath?: string;
  caseIds?: string[];
}

type Tier = 'execute' | 'notify' | 'confirm' | 'stop';

interface LedgerEntry {
  values: number[];
  sources: string[];
}

interface Ledger {
  entries: Map<string, LedgerEntry>;
  itemToEntity: Map<string, string>;
  /** 审计返回的 item 值按实体投影，供和语料 seedTruth 对照。 */
  auditByEntity: Map<string, number[]>;
  corpusByEntity: Map<string, number[]>;
}

interface AxisOne {
  audit: {
    source: 'explicit' | 'state-dir' | 'probe-report' | 'none';
    rows: number;
    badLines: number;
    refusedCalls: number;
    refusedByReason: Record<string, number>;
    outOfScopeRefusals: number;
    outOfScopeReasons: string[];
  };
  plans: {
    basis: 'plan-state' | 'audit-plan-rows' | 'probe-notices' | 'none';
    tierCounts: Record<Tier, number>;
    total: number;
    unknownDecisions: number;
    stopOccurrences: number;
    confirmOccurrences: number;
    confirmPromptsDelivered: number;
    notifyPromptsDelivered: number;
    stopMessagesDelivered: number;
    confirmActivated: number | null;
    plansConfirmedByUser: number | null;
    scopeExpansionCount: number | null;
    scopeExpansionContexts: Array<{ planId: string; taskId: string; version: number | null; reasonCode: string }>;
    userConfirmations: number;
    userConfirmationMessages: Array<{ caseId: string; turnIndex: number; text: string }>;
    plansConsidered: number;
  };
  criteria: {
    tierDistributionReasonable: boolean | null;
    outOfScopeHasRefusal: boolean | null;
    scopeExpansionTriggeredOnExpansion: boolean | null;
    verdict: 'pass' | 'fail' | 'inconclusive';
  };
  notes: string[];
}

interface AxisTwo {
  ledger: {
    entities: Record<string, number[]>;
    sources: Record<string, string[]>;
    perCase: Record<string, Record<string, number[]>>;
    crossCheck: Array<{ caseId: string; entity: string; corpusValues: number[] | null; auditValues: number[] | null; equal: boolean | null }>;
  };
  recallTurns: Array<{
    caseId: string;
    turnIndex: number;
    userText: string | null;
    corpusMatched: boolean;
    entities: string[];
    status: 'measured' | 'missing-turn' | 'missing-reply' | 'corpus-mismatch' | 'unresolved-entity';
    amounts: Array<{
      value: number;
      raw: string;
      entity: string | null;
      status: 'consistent' | 'derived' | 'drift' | 'zero';
      /** 该数字所在分句带「此前这么说过 / 以实时结果为准」的更正语境：仍是漂移，但计入 retractedDriftCount。 */
      retracted?: boolean;
    }>;
    driftValues: number[];
  }>;
  driftCount: number;
  driftOccurrences: number;
  retractedDriftCount: number;
  driftIntoExecutionCount: number;
  driftExecutionHits: Array<{
    caseId: string;
    turnIndex: number;
    value: number;
    entity: string | null;
    retracted: boolean;
    laterTurnIndex: number;
    script: string | null;
    planId: string | null;
    args: unknown;
  }>;
  planCallArgsScanned: number;
  notes: string[];
}

interface AxisThree {
  messages: number;
  messageHitCount: number;
  fingerprintHitCount: number;
  labelCounts: Record<string, number>;
  hits: Array<{
    caseId: string;
    turnIndex: number;
    source: 'notice' | 'reply';
    labels: string[];
    text: string;
  }>;
  humanReviewFile: string;
}

export interface MeasurementResult {
  schema: 'spike-three-axis/v1';
  inputs: {
    probe: string;
    audit: string | null;
    planState: string | null;
    cases: string;
    caseIds: string[] | null;
  };
  measured: { cases: string[]; turns: number };
  axis1_gate: AxisOne;
  axis2_recall: AxisTwo;
  axis3_confirm_language: AxisThree;
  notes: string[];
}

// ── 小工具 ──

function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), path.resolve(file));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return path.basename(file);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function finiteNumbers(values: readonly unknown[]): number[] {
  return values
    .map((value) => (typeof value === 'number' ? value : Number.NaN))
    .filter((value) => Number.isFinite(value));
}

function sortedUniqueNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsIn(text: string, names: Iterable<string>): Array<{ name: string; at: number }> {
  const hits: Array<{ name: string; at: number }> = [];
  for (const name of names) {
    if (!name) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, 'gi');
    for (const match of text.matchAll(pattern)) hits.push({ name, at: match.index ?? 0 });
  }
  return hits.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/** 数字 token（计划参数用）：千分位/小数/裸整数；排除标识符尾段（rec-001 的 001）。 */
function numbersInArgs(args: unknown): number[] {
  const out: number[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push(value);
      return;
    }
    if (typeof value === 'string') {
      for (const match of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
        const raw = match[0]!;
        const at = match.index ?? 0;
        const digitAt = raw.startsWith('-') ? at + 1 : at;
        if (/(?:[A-Za-z])-$/.test(value.slice(Math.max(0, digitAt - 8), digitAt))) continue;
        const parsed = Number(raw.replace(/,/g, ''));
        if (Number.isFinite(parsed)) out.push(parsed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(args);
  return out;
}

function auditKey(row: AuditRow): string {
  return [
    row.ts ?? '',
    row.mode ?? '',
    row.script ?? '',
    JSON.stringify(row.args ?? null),
    row.refused ?? '',
    row.exitCode ?? '',
    row.planId ?? '',
    row.callId ?? '',
    row.phase ?? '',
  ].join('|');
}

function readAuditJsonl(file: string): { rows: AuditRow[]; badLines: number } {
  const text = readFileSync(file, 'utf8');
  const rows: AuditRow[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as AuditRow);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

function discoverStateFiles(stateDir: string, prefix: string, suffix: string): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => path.join(stateDir, name));
}

function parsePlanState(file: string): PlanRecord[] {
  const parsed = readJson(file) as unknown;
  const records: PlanRecord[] = [];
  const push = (value: unknown, fallbackId?: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const raw = value as Record<string, unknown>;
    const estimateRaw = raw['estimate'];
    const estimate = estimateRaw && typeof estimateRaw === 'object' && !Array.isArray(estimateRaw)
      ? (estimateRaw as Record<string, unknown>)
      : undefined;
    const id = typeof raw['id'] === 'string' ? raw['id']
      : typeof raw['planId'] === 'string' ? raw['planId']
        : fallbackId;
    if (!id) return;
    records.push({
      id,
      ...(typeof raw['taskId'] === 'string' ? { taskId: raw['taskId'] } : {}),
      ...(typeof raw['version'] === 'number' ? { version: raw['version'] } : {}),
      ...(typeof raw['decision'] === 'string' ? { decision: raw['decision'] } : {}),
      ...(typeof raw['reasonCode'] === 'string' ? { reasonCode: raw['reasonCode'] } : {}),
      ...(typeof raw['status'] === 'string' ? { status: raw['status'] } : {}),
      ...(typeof raw['activatedEvidence'] === 'string' ? { activatedEvidence: raw['activatedEvidence'] } : {}),
      ...(estimate
        ? {
            estimate: {
              ...(typeof estimate['calls'] === 'number' ? { calls: estimate['calls'] } : {}),
              ...(typeof estimate['seconds'] === 'number' ? { seconds: estimate['seconds'] } : {}),
              ...(typeof estimate['weight'] === 'number' ? { weight: estimate['weight'] } : {}),
            },
          }
        : {}),
    });
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) push(item);
  } else if (parsed && typeof parsed === 'object') {
    const raw = parsed as Record<string, unknown>;
    const plans = raw['plans'];
    if (plans && typeof plans === 'object' && !Array.isArray(plans)) {
      for (const [id, plan] of Object.entries(plans as Record<string, unknown>)) push(plan, id);
    } else {
      push(parsed);
    }
  }
  return records;
}

function mergePlans(files: readonly string[]): PlanRecord[] {
  const byId = new Map<string, PlanRecord>();
  for (const file of files) {
    for (const plan of parsePlanState(file)) {
      // 后读的同 id 覆盖先读的（state-dir 排序稳定；probe 每例一个状态根，同 id 不应出现）。
      byId.set(plan.id, plan);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── 账本 ──

function readSeedTruth(casesPath: string): Map<string, number[]> {
  const truth = new Map<string, number[]>();
  try {
    const document = YAML.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>;
    const seedTruth = document['seedTruth'];
    if (seedTruth && typeof seedTruth === 'object' && !Array.isArray(seedTruth)) {
      for (const [entity, values] of Object.entries(seedTruth as Record<string, unknown>)) {
        if (Array.isArray(values)) truth.set(entity, sortedUniqueNumbers(finiteNumbers(values)));
      }
    }
  } catch {
    // 语料不可解析由 loadCases 报错；这里不重复抛出。
  }
  return truth;
}

/** 审计参数里点名的执行对象（--collection/--shelf/--table 与 = 形态）。 */
function entityArgsIn(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    for (const flag of ['--collection', '--shelf', '--table']) {
      if (arg === flag) {
        const value = args[index + 1];
        if (typeof value === 'string' && value) out.push(value);
      } else if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1);
        if (value) out.push(value);
      }
    }
  }
  return out;
}

/**
 * 单用例账本（关键：不把整个夹具的 seedTruth 塞给每个用例）。
 *
 * 来源优先级：
 *   ① 该用例执行审计的 query result（平台真实返回的 items[].value）；
 *   ② 该用例 expectations.threads 声明的线程真值；
 *   ③ 该用例审计参数点名、但结果行没带 items 的实体 → 用 cases.yaml 的 seedTruth 补；
 *   ④ 以上都没有（老报告没有 result.items）→ 只在用例文本提到该实体时用 seedTruth 补。
 * 没有出现在该用例里的实体不进账本，避免「没查过的实体值也算据」。
 */
function buildCaseLedger(
  seedTruth: ReadonlyMap<string, number[]>,
  spec: CaseSpec | undefined,
  auditRows: readonly AuditRow[],
  caseTexts: readonly string[],
): Ledger {
  const corpusByEntity = new Map<string, number[]>();
  const auditByEntity = new Map<string, number[]>();
  const sources = new Map<string, Set<string>>();
  const itemToEntity = new Map<string, string>();

  const addCorpus = (entity: string, values: readonly number[], source: string): void => {
    if (!entity) return;
    const list = corpusByEntity.get(entity) ?? [];
    list.push(...values);
    corpusByEntity.set(entity, list);
    const set = sources.get(entity) ?? new Set<string>();
    set.add(source);
    sources.set(entity, set);
  };
  const addAudit = (entity: string, values: readonly number[], source: string): void => {
    if (!entity) return;
    const list = auditByEntity.get(entity) ?? [];
    list.push(...values);
    auditByEntity.set(entity, list);
    const set = sources.get(entity) ?? new Set<string>();
    set.add(source);
    sources.set(entity, set);
  };

  // ② 用例声明的线程真值。
  for (const thread of Object.values(spec?.expectations?.threads ?? {})) {
    if (thread && typeof thread.collection === 'string') {
      addCorpus(thread.collection, finiteNumbers(thread.values ?? []), `cases.${spec?.id ?? '?'}.expectations.threads`);
    }
  }

  // ① 执行审计的 query result：实体名 + items[].value；同时记 item 名 → 实体。
  const queried = new Set<string>();
  for (const row of auditRows) {
    for (const entity of entityArgsIn(row.args)) queried.add(entity);
    const result = row.result;
    if (!result || typeof result !== 'object') continue;
    const contract = new Set(['status', 'items', 'count', 'fields']);
    const identity = Object.entries(result)
      .find(([key, value]) => !contract.has(key) && typeof value === 'string' && value.length > 0);
    if (!identity) continue;
    const entity = identity[1] as string;
    queried.add(entity);
    const values: number[] = [];
    for (const item of result.items ?? []) {
      if (typeof item?.value === 'number' && Number.isFinite(item.value)) values.push(item.value);
      if (typeof item?.name === 'string' && item.name) itemToEntity.set(item.name, entity);
    }
    if (values.length) addAudit(entity, values, 'execution-audit.result');
  }

  // ③ 参数点名但结果行没带 items 的实体：用 seedTruth 补。
  for (const entity of [...queried].sort()) {
    if (auditByEntity.has(entity) || corpusByEntity.has(entity)) continue;
    const truth = seedTruth.get(entity);
    if (truth) addCorpus(entity, truth, 'cases.seedTruth(queried)');
  }

  // ④ 老报告没有 result.items：只在用例文本提到该实体时用 seedTruth 补。
  if (auditByEntity.size === 0 && corpusByEntity.size === 0) {
    const mentioned = [...seedTruth.keys()].filter((entity) => mentionsIn(caseTexts.join('\n'), [entity]).length > 0);
    for (const entity of mentioned) addCorpus(entity, seedTruth.get(entity) ?? [], 'cases.seedTruth(mentioned)');
  }

  const entries = new Map<string, LedgerEntry>();
  for (const [entity, values] of corpusByEntity) {
    entries.set(entity, { values: sortedUniqueNumbers(values), sources: [...(sources.get(entity) ?? [])].sort() });
  }
  for (const [entity, values] of auditByEntity) {
    const existing = entries.get(entity);
    entries.set(entity, {
      values: sortedUniqueNumbers([...(existing?.values ?? []), ...values]),
      sources: [...new Set([...(existing?.sources ?? []), ...(sources.get(entity) ?? [])])].sort(),
    });
  }

  return { entries, itemToEntity, auditByEntity, corpusByEntity };
}

// ── 轴① ──

const CONFIRM_NOTICE_RE = /请回复[^。\n]{0,8}确认|确认继续|当前已暂停|等待用户确认/;
const NOTIFY_NOTICE_RE = /通知送达后将继续执行/;
const STOP_REPLY_RE = /计划执行已停止|计划已停止|已停止执行/;
const USER_CONFIRM_RE = /^\s*(?:确认(?:继续)?(?:\s+\S+)?|继续|confirm|yes|y|ok)\s*[。.!！]?\s*$/i;

function measureAxisOne(
  selected: readonly ProbeCase[],
  auditRows: readonly AuditRow[],
  plans: readonly PlanRecord[],
  planStateRequested: boolean,
  auditSource: AxisOne['audit']['source'],
  badLines: number,
): AxisOne {
  const notes: string[] = [];

  // 拒绝行（越界/计划门/写门都单列原因）。
  const refusedRows = auditRows.filter((row) => typeof row.refused === 'string' && row.refused.length > 0);
  const refusedByReason = sortedRecord(countBy(refusedRows, (row) => row.refused));
  const outOfScopeReasons = [
    'unregistered',
    'local-out-of-tmp',
    'unregistered-operation',
    'entity-out-of-scope',
    'ENTITY_OUT_OF_SCOPE',
  ].filter((reason) => (refusedByReason[reason] ?? 0) > 0);
  const outOfScopeRefusals = outOfScopeReasons.reduce((sum, reason) => sum + (refusedByReason[reason] ?? 0), 0);

  // 从探针正文里数「实际送达」的 confirm/notify 消息（与账本档位交叉核）。
  const confirmNotices = new Set<string>();
  const notifyNotices = new Set<string>();
  const stopTurns: Array<{ caseId: string; turnIndex: number; text: string }> = [];
  const userConfirmationMessages: Array<{ caseId: string; turnIndex: number; text: string }> = [];
  const planIdsByTurn = new Map<string, Set<string>>();
  for (const probeCase of selected) {
    probeCase.turns?.forEach((turn, turnIndex) => {
      for (const notice of turn.notices ?? []) {
        if (typeof notice !== 'string') continue;
        const key = `${probeCase.id}|${notice}`;
        if (CONFIRM_NOTICE_RE.test(notice)) confirmNotices.add(key);
        else if (NOTIFY_NOTICE_RE.test(notice)) notifyNotices.add(key);
      }
      const reply = turn.reply ?? '';
      if (STOP_REPLY_RE.test(reply)) stopTurns.push({ caseId: probeCase.id, turnIndex, text: reply });
      const text = turn.text ?? '';
      if (USER_CONFIRM_RE.test(text)) userConfirmationMessages.push({ caseId: probeCase.id, turnIndex, text });
      const ids = new Set<string>();
      for (const row of turn.execution ?? []) if (row.planId) ids.add(row.planId);
      if (ids.size) planIdsByTurn.set(`${probeCase.id}:${turnIndex}`, ids);
    });
  }

  // 档位：优先 plans.json；其次审计行自带的 decision/reasonCode；最后才用通知/回复启发式。
  const tierCounts: Record<Tier, number> = { execute: 0, notify: 0, confirm: 0, stop: 0 };
  let basis: AxisOne['plans']['basis'] = 'none';
  let unknownDecisions = 0;
  let scopeExpansionCount: number | null = null;
  const scopeExpansionContexts: AxisOne['plans']['scopeExpansionContexts'] = [];
  let confirmActivated: number | null = null;
  let plansConfirmedByUser: number | null = null;

  if (plans.length > 0) {
    basis = 'plan-state';
    for (const plan of plans) {
      const decision = plan.decision ?? '';
      if (decision === 'execute' || decision === 'notify' || decision === 'confirm' || decision === 'stop') {
        tierCounts[decision] += 1;
      } else {
        unknownDecisions += 1;
      }
    }
    scopeExpansionCount = plans.filter((plan) => plan.reasonCode === 'SCOPE_EXPANSION').length;
    // activatedEvidence 缺席 = 旧账本没写这个字段（不可知），不是「零次确认」。
    const hasActivatedEvidence = plans.some((plan) => plan.activatedEvidence !== undefined);
    confirmActivated = hasActivatedEvidence
      ? plans.filter((plan) => plan.decision === 'confirm' && plan.activatedEvidence === 'user-confirmed').length
      : null;
    plansConfirmedByUser = hasActivatedEvidence
      ? plans.filter((plan) => plan.activatedEvidence === 'user-confirmed').length
      : null;

    // SCOPE_EXPANSION 上下文：同一 task 的第二张及以后、且落在 auto 阈值带的计划。
    // 判据用执行层账本自己的 reasonCode，不重算阈值（阈值可能被用例覆盖，账本有最终答案）。
    const byTask = new Map<string, PlanRecord[]>();
    for (const plan of plans) {
      const taskId = plan.taskId ?? '(no-task)';
      const list = byTask.get(taskId) ?? [];
      list.push(plan);
      byTask.set(taskId, list);
    }
    for (const [taskId, list] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ordered = [...list].sort((a, b) => (a.version ?? 0) - (b.version ?? 0) || a.id.localeCompare(b.id));
      ordered.forEach((plan, index) => {
        if (index === 0) return;
        if (plan.reasonCode === 'SCOPE_EXPANSION' || plan.reasonCode === 'INITIAL_SCOPE_THRESHOLD') {
          scopeExpansionContexts.push({
            planId: plan.id,
            taskId,
            version: plan.version ?? null,
            reasonCode: plan.reasonCode,
          });
        }
      });
    }
  } else {
    // 审计行若自带计划裁决字段，直接按 planId 归并（其它执行层可能这样落账）。
    const decisionsByPlan = new Map<string, { decision?: string; reasonCode?: string }>();
    for (const row of auditRows) {
      const decision = row.decision ?? row.tier ?? row.planDecision;
      const reasonCode = row.reasonCode;
      if (!decision && !reasonCode) continue;
      const key = row.planId ?? `row:${auditKey(row)}`;
      const existing = decisionsByPlan.get(key) ?? {};
      decisionsByPlan.set(key, {
        ...existing,
        ...(decision ? { decision } : {}),
        ...(reasonCode ? { reasonCode } : {}),
      });
    }
    if (decisionsByPlan.size > 0) {
      basis = 'audit-plan-rows';
      let scope = 0;
      for (const value of decisionsByPlan.values()) {
        if (value.decision === 'execute' || value.decision === 'notify' || value.decision === 'confirm' || value.decision === 'stop') {
          tierCounts[value.decision] += 1;
        } else if (value.decision) {
          unknownDecisions += 1;
        }
        if (value.reasonCode === 'SCOPE_EXPANSION') scope += 1;
      }
      scopeExpansionCount = scope;
    } else {
      // 启发式：通知文本定 confirm/notify；停止话术定 stop；其余带 planId 的轮次算 execute。
      basis = 'probe-notices';
      tierCounts.confirm = confirmNotices.size;
      tierCounts.notify = notifyNotices.size;
      tierCounts.stop = stopTurns.length;
      const noticeTurns = new Set<string>();
      for (const probeCase of selected) {
        probeCase.turns?.forEach((turn, turnIndex) => {
          const hasNotice = (turn.notices ?? []).some((notice) => typeof notice === 'string'
            && (CONFIRM_NOTICE_RE.test(notice) || NOTIFY_NOTICE_RE.test(notice)));
          if (hasNotice) noticeTurns.add(`${probeCase.id}:${turnIndex}`);
        });
      }
      const stopTurnKeys = new Set(stopTurns.map((turn) => `${turn.caseId}:${turn.turnIndex}`));
      const executeIds = new Set<string>();
      for (const [key, ids] of planIdsByTurn) {
        if (noticeTurns.has(key) || stopTurnKeys.has(key)) continue;
        for (const id of ids) executeIds.add(id);
      }
      tierCounts.execute = executeIds.size;
      scopeExpansionCount = null;
      notes.push('没有 plans.json / 审计计划裁决字段：档位分布由探针通知与回复话术启发式归类，SCOPE_EXPANSION 无证据记 null（不是 0）。');
    }
  }

  const total = tierCounts.execute + tierCounts.notify + tierCounts.confirm + tierCounts.stop;
  const stopMessagesDelivered = stopTurns.length;
  const confirmPromptsDelivered = confirmNotices.size;
  const notifyPromptsDelivered = notifyNotices.size;
  const stopOccurrences = basis === 'plan-state' || basis === 'audit-plan-rows' ? tierCounts.stop : stopMessagesDelivered;
  const confirmOccurrences = basis === 'plan-state' || basis === 'audit-plan-rows' ? tierCounts.confirm : confirmPromptsDelivered;

  if (!planStateRequested && basis !== 'plan-state') {
    notes.push('未提供 --plan-state：confirm/stop 的「实际发生」只能按探针正文里送达的通知/停止话术计数。');
  }
  if (plans.length === 0 && planStateRequested) {
    notes.push('--plan-state 已提供但没有解析出任何计划：档位证据缺席，按通知启发式归类。');
  }
  if (unknownDecisions > 0) notes.push(`有 ${unknownDecisions} 条计划裁决不在 execute/notify/confirm/stop 四档内。`);
  if (outOfScopeRefusals === 0) {
    notes.push('审计里没有越界拒收记录；只凭拒绝行无法证明「若越界一定会被拒」（放行的越界调用与合法调用在审计里同形）。');
  }
  if (scopeExpansionCount === null) {
    notes.push('SCOPE_EXPANSION 理由码没有证据来源（需 plans.json 或审计行的 reasonCode）。');
  }

  // 判据：只在有权威证据时给 true/false；没有证据给 null（不把缺席写成通过）。
  let tierDistributionReasonable: boolean | null = null;
  if (basis === 'plan-state') {
    const promptsMatch = (tierCounts.stop === 0 || stopMessagesDelivered > 0)
      && (tierCounts.confirm === 0 || confirmPromptsDelivered > 0)
      && (tierCounts.notify === 0 || notifyPromptsDelivered > 0);
    tierDistributionReasonable = total > 0 && unknownDecisions === 0 && promptsMatch;
  } else if (basis === 'audit-plan-rows') {
    tierDistributionReasonable = total > 0 && unknownDecisions === 0;
  } else {
    tierDistributionReasonable = null;
  }

  const outOfScopeHasRefusal: boolean | null = outOfScopeRefusals > 0 ? true : null;
  const scopeExpansionTriggeredOnExpansion: boolean | null = scopeExpansionContexts.length === 0
    ? null
    : scopeExpansionContexts.every((context) => context.reasonCode === 'SCOPE_EXPANSION');

  const criteria = [tierDistributionReasonable, outOfScopeHasRefusal, scopeExpansionTriggeredOnExpansion];
  const verdict: AxisOne['criteria']['verdict'] = criteria.some((value) => value === false)
    ? 'fail'
    : criteria.every((value) => value === true) ? 'pass' : 'inconclusive';
  if (tierDistributionReasonable === false) {
    notes.push('档位账本与探针正文不一致：有 stop/confirm/notify 档位，但正文里没有对应的停止话术/确认提示/通知送达消息。');
  }

  return {
    audit: {
      source: auditSource,
      rows: auditRows.length,
      badLines,
      refusedCalls: refusedRows.length,
      refusedByReason,
      outOfScopeRefusals,
      outOfScopeReasons,
    },
    plans: {
      basis,
      tierCounts,
      total,
      unknownDecisions,
      stopOccurrences,
      confirmOccurrences,
      confirmPromptsDelivered,
      notifyPromptsDelivered,
      stopMessagesDelivered,
      confirmActivated,
      plansConfirmedByUser,
      scopeExpansionCount,
      scopeExpansionContexts,
      userConfirmations: userConfirmationMessages.length,
      userConfirmationMessages,
      plansConsidered: plans.length,
    },
    criteria: {
      tierDistributionReasonable,
      outOfScopeHasRefusal,
      scopeExpansionTriggeredOnExpansion,
      verdict,
    },
    notes,
  };
}

// ── 轴② ──

function entitySetForTurn(
  spec: CaseSpec | undefined,
  turnIndex: number,
  reply: string,
  ledger: Ledger,
): string[] {
  const entities = new Set<string>();
  const recall = spec?.expectations?.recalls?.find((item) => item.turn === turnIndex);
  if (recall) {
    const thread = spec?.expectations?.threads?.[recall.thread];
    if (thread) entities.add(thread.collection);
  }
  for (const mention of mentionsIn(reply, ledger.entries.keys())) entities.add(mention.name);
  for (const mention of mentionsIn(reply, ledger.itemToEntity.keys())) {
    const entity = ledger.itemToEntity.get(mention.name);
    if (entity) entities.add(entity);
  }
  if (entities.size === 0 && spec) {
    const message = spec.messages[turnIndex];
    for (const task of message?.tasks ?? []) {
      const thread = spec.expectations?.threads?.[task];
      if (thread) entities.add(thread.collection);
    }
  }
  if (entities.size === 0) {
    const message = spec?.messages[turnIndex];
    for (const mention of mentionsIn(message?.text ?? '', ledger.entries.keys())) entities.add(mention.name);
  }
  if (entities.size === 0 && ledger.entries.size === 1) entities.add([...ledger.entries.keys()][0]!);
  return [...entities].sort();
}

/** 数字所在的强分句（；;。换行；英文句点不切小数）。表格行/列表项天然被换行切开；同一分句里的实体才是归属候选。 */
const CLAUSE_BOUNDARY = /(?<!\d)\.|\.(?!\d)|[。；;\n]/g;

function clauseAround(text: string, at: number): { start: number; end: number } {
  const boundaries = [...text.matchAll(CLAUSE_BOUNDARY)]
    .map((match) => match.index ?? 0)
    .filter((index) => index >= 0);
  let start = 0;
  let end = text.length;
  for (const index of boundaries) {
    if (index < at) start = Math.max(start, index + 1);
    else if (index >= at) end = Math.min(end, index);
  }
  return { start, end };
}

function attributeAmount(
  reply: string,
  at: number,
  ledger: Ledger,
  fallback: readonly string[],
): string | null {
  const clause = clauseAround(reply, at);
  const text = reply.slice(clause.start, clause.end);
  const relativeAt = at - clause.start;

  const collect = (scope: string): Array<{ entity: string; at: number }> => {
    const found: Array<{ entity: string; at: number }> = [];
    for (const mention of mentionsIn(scope, ledger.entries.keys())) found.push({ entity: mention.name, at: mention.at });
    for (const mention of mentionsIn(scope, ledger.itemToEntity.keys())) {
      const entity = ledger.itemToEntity.get(mention.name);
      if (entity) found.push({ entity, at: mention.at });
    }
    return found;
  };

  const pick = (candidates: Array<{ entity: string; at: number }>, relativeAt: number): string | null => {
    if (candidates.length === 0) return null;
    // 归属优先「数字之前最近的一次实体提及」：分句主语在数字前（"alpha（W1：1200、800）和 beta（…）"），
    // 而不是按字符距离把括号里的 beta 抢给 1200。数字前没有实体时，才取其后最近的提及。
    const before = candidates
      .filter((mention) => mention.at <= relativeAt)
      .sort((a, b) => b.at - a.at || a.entity.localeCompare(b.entity));
    if (before.length > 0) return before[0]!.entity;
    const after = [...candidates].sort((a, b) => a.at - b.at || a.entity.localeCompare(b.entity));
    return after[0]?.entity ?? null;
  };

  // 先在强分句里归属；分句里没有实体名时才退回整行，再退回本轮实体集合。
  let mentions = collect(text);
  if (mentions.length === 0) {
    const lineStart = reply.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
    const lineEndRaw = reply.indexOf('\n', at);
    const lineEnd = lineEndRaw === -1 ? reply.length : lineEndRaw;
    const line = reply.slice(lineStart, lineEnd);
    mentions = collect(line);
    if (mentions.length === 0) return fallback.length === 1 ? fallback[0]! : null;
    return pick(mentions, at - lineStart);
  }
  return pick(mentions, relativeAt);
}

function derivedFromLedger(value: number, values: readonly number[]): boolean {
  return isVerifiedTotal(value, values) || isVerifiedArithmetic(value, values);
}

/** 更正语境：数字是「此前说过、现在撤回」的旧值。仍算表面漂移，但单列 retracted 计数供人读。 */
const RETRACTION_RE = /曾被表述|此前(?:说|表述|写成|报)|以.{0,12}为准|更正|纠正|不是本轮|corrected|correction|previous(?:ly)?\s+(?:said|reported)|not the current/i;

function measureAxisTwo(
  selected: readonly ProbeCase[],
  specsById: ReadonlyMap<string, CaseSpec>,
  casesPath: string,
): AxisTwo {
  const notes: string[] = [];
  const recallTurns: AxisTwo['recallTurns'] = [];
  const driftExecutionHits: AxisTwo['driftExecutionHits'] = [];
  let driftCount = 0;
  let driftOccurrences = 0;
  let retractedDriftCount = 0;
  let driftIntoExecutionCount = 0;
  let planCallArgsScanned = 0;
  const seedTruth = readSeedTruth(casesPath);

  // 输出面：跨用例并集（人读用）；漂移判定永远用单用例账本（避免用例间串台）。
  const unionValues = new Map<string, Set<number>>();
  const unionSources = new Map<string, Set<string>>();
  const perCase: Record<string, Record<string, number[]>> = {};
  const crossCheck: AxisTwo['ledger']['crossCheck'] = [];

  for (const probeCase of selected) {
    const spec = specsById.get(probeCase.id);
    if (!spec) {
      notes.push(`用例 ${probeCase.id} 不在语料里：跳过召回轴（无轮次标记可读）。`);
      continue;
    }
    const caseAuditRows = (probeCase.turns ?? []).flatMap((turn) => turn.execution ?? []);
    const caseTexts = (probeCase.turns ?? []).flatMap((turn) => [turn.text ?? '', turn.reply ?? '']);
    const ledger = buildCaseLedger(seedTruth, spec, caseAuditRows, caseTexts);

    const caseEntities: Record<string, number[]> = {};
    for (const entity of [...ledger.entries.keys()].sort()) {
      const entry = ledger.entries.get(entity)!;
      caseEntities[entity] = entry.values;
      const values = unionValues.get(entity) ?? new Set<number>();
      for (const value of entry.values) values.add(value);
      unionValues.set(entity, values);
      const sources = unionSources.get(entity) ?? new Set<string>();
      for (const source of entry.sources) sources.add(source);
      unionSources.set(entity, sources);
    }
    perCase[probeCase.id] = caseEntities;

    for (const entity of [...new Set([...ledger.corpusByEntity.keys(), ...ledger.auditByEntity.keys()])].sort()) {
      const corpus = ledger.corpusByEntity.has(entity) ? sortedUniqueNumbers(ledger.corpusByEntity.get(entity)!) : null;
      const audit = ledger.auditByEntity.has(entity) ? sortedUniqueNumbers(ledger.auditByEntity.get(entity)!) : null;
      crossCheck.push({
        caseId: probeCase.id,
        entity,
        corpusValues: corpus,
        auditValues: audit,
        equal: corpus && audit ? corpus.length === audit.length && corpus.every((value, index) => value === audit[index]) : null,
      });
    }

    spec.messages.forEach((message: CaseMessage, turnIndex) => {
      const marked = (message.marks ?? []).includes('recall')
        || (message as unknown as { type?: string }).type === 'recall'
        || (message as unknown as { recall?: boolean }).recall === true;
      if (!marked) return;
      const turn = probeCase.turns?.[turnIndex];
      const userText = message.text ?? null;
      if (!turn) {
        recallTurns.push({
          caseId: probeCase.id,
          turnIndex,
          userText,
          corpusMatched: false,
          entities: [],
          status: 'missing-turn',
          amounts: [],
          driftValues: [],
        });
        return;
      }
      const corpusMatched = normalizeText(message.text) === normalizeText(turn.text);
      if (!corpusMatched) {
        recallTurns.push({
          caseId: probeCase.id,
          turnIndex,
          userText,
          corpusMatched: false,
          entities: [],
          status: 'corpus-mismatch',
          amounts: [],
          driftValues: [],
        });
        return;
      }
      const reply = turn.reply ?? '';
      if (!reply) {
        recallTurns.push({
          caseId: probeCase.id,
          turnIndex,
          userText,
          corpusMatched: true,
          entities: [],
          status: 'missing-reply',
          amounts: [],
          driftValues: [],
        });
        return;
      }
      const entities = entitySetForTurn(spec, turnIndex, reply, ledger);
      if (entities.length === 0) {
        recallTurns.push({
          caseId: probeCase.id,
          turnIndex,
          userText,
          corpusMatched: true,
          entities,
          status: 'unresolved-entity',
          amounts: [],
          driftValues: [],
        });
        notes.push(`第${turnIndex + 1}轮召回无法解析实体（回复里没有登记实体名）：该轮不计漂移。`);
        return;
      }
      const unionValues = sortedUniqueNumbers(entities.flatMap((entity) => ledger.entries.get(entity)?.values ?? []));
      const amounts: AxisTwo['recallTurns'][number]['amounts'] = [];
      const driftValues = new Set<number>();
      for (const amount of extractAmounts(reply)) {
        const at = amount.at ?? reply.indexOf(amount.raw);
        const attributed = attributeAmount(reply, at, ledger, entities);
        const ledgerValues = attributed ? (ledger.entries.get(attributed)?.values ?? []) : unionValues;
        const clause = clauseAround(reply, Math.max(0, at));
        const retracted = RETRACTION_RE.test(reply.slice(clause.start, clause.end));
        let status: 'consistent' | 'derived' | 'drift' | 'zero';
        if (amount.value === 0) status = 'zero';
        else if (ledgerValues.includes(amount.value)) status = 'consistent';
        else if (derivedFromLedger(amount.value, ledgerValues)) status = 'derived';
        else status = 'drift';
        if (status === 'drift') {
          driftValues.add(amount.value);
          driftOccurrences += 1;
          if (retracted) retractedDriftCount += 1;
        }
        amounts.push({
          value: amount.value,
          raw: amount.raw,
          entity: attributed,
          status,
          ...(status === 'drift' && retracted ? { retracted: true } : {}),
        });
      }
      driftCount += driftValues.size;
      recallTurns.push({
        caseId: probeCase.id,
        turnIndex,
        userText,
        corpusMatched: true,
        entities,
        status: 'measured',
        amounts,
        driftValues: [...driftValues].sort((a, b) => a - b),
      });

      // 漂移值是否进入后续计划调用的参数（只看 recall 轮之后的轮次；同轮调用发生在回复前）。
      const laterTurns = (probeCase.turns ?? []).slice(turnIndex + 1);
      const laterPlanRows: Array<{ laterTurnIndex: number; row: AuditRow }> = [];
      laterTurns.forEach((laterTurn, offset) => {
        for (const row of laterTurn.execution ?? []) {
          if (row.planId || row.serve === true) laterPlanRows.push({ laterTurnIndex: turnIndex + 1 + offset, row });
        }
      });
      planCallArgsScanned += laterPlanRows.length;
      for (const value of [...driftValues].sort((a, b) => a - b)) {
        for (const { laterTurnIndex, row } of laterPlanRows) {
          if (!numbersInArgs(row.args).includes(value)) continue;
          const amount = amounts.find((item) => item.value === value);
          driftExecutionHits.push({
            caseId: probeCase.id,
            turnIndex,
            value,
            entity: amount?.entity ?? null,
            retracted: amount?.retracted === true,
            laterTurnIndex,
            script: row.script ?? null,
            planId: row.planId ?? null,
            args: row.args ?? null,
          });
          driftIntoExecutionCount += 1;
          break;
        }
      }
    });
  }

  if (recallTurns.length === 0) notes.push('所选用例里没有 recall 轮：漂移计数为 0 是「没有对象」，不是「已证明无漂移」。');
  const mismatched = recallTurns.filter((turn) => turn.status === 'corpus-mismatch').length;
  if (mismatched > 0) notes.push(`有 ${mismatched} 个 recall 轮在当前语料与探针报告里的用户文本不一致：跳过该轮（不拿错位的轮次量漂移）。`);
  if (crossCheck.some((item) => item.equal === false)) {
    notes.push('审计返回的记录值与语料 seedTruth 不完全一致：漂移判定用并集（任一来源有该值即视为记录值），差异见 ledger.crossCheck。');
  }
  if (planCallArgsScanned === 0 && driftCount > 0) {
    notes.push('recall 轮之后没有带 planId 的执行行：漂移进入执行记 0；若该用例本身零计划调用，这是有证据的 0，否则检查该轮 execution 字段是否缺席。');
  }

  const entitiesRecord: Record<string, number[]> = {};
  for (const entity of [...unionValues.keys()].sort()) entitiesRecord[entity] = sortedUniqueNumbers(unionValues.get(entity)!);
  const sourcesRecord: Record<string, string[]> = {};
  for (const entity of [...unionSources.keys()].sort()) sourcesRecord[entity] = [...(unionSources.get(entity) ?? [])].sort();

  return {
    ledger: { entities: entitiesRecord, sources: sourcesRecord, perCase, crossCheck },
    recallTurns,
    driftCount,
    driftOccurrences,
    retractedDriftCount,
    driftIntoExecutionCount,
    driftExecutionHits,
    planCallArgsScanned,
    notes,
  };
}

// ── 轴③ ──

const CONFIRM_OR_NOTIFY_REPLY_RE = /请确认|确认继续|请回复[^。\n]{0,8}确认|已暂停|通知送达后将继续执行/;

function measureAxisThree(
  selected: readonly ProbeCase[],
  humanOutPath: string,
): AxisThree {
  const messages: Array<{ caseId: string; turnIndex: number; source: 'notice' | 'reply'; text: string }> = [];
  const seen = new Set<string>();
  for (const probeCase of selected) {
    probeCase.turns?.forEach((turn, turnIndex) => {
      for (const notice of turn.notices ?? []) {
        if (typeof notice !== 'string' || !notice.trim()) continue;
        const key = `${probeCase.id}|notice|${notice}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push({ caseId: probeCase.id, turnIndex, source: 'notice', text: notice });
      }
      const reply = turn.reply ?? '';
      if (reply && CONFIRM_OR_NOTIFY_REPLY_RE.test(reply)) {
        const key = `${probeCase.id}|reply|${reply}`;
        if (!seen.has(key)) {
          seen.add(key);
          messages.push({ caseId: probeCase.id, turnIndex, source: 'reply', text: reply });
        }
      }
    });
  }

  const hits: AxisThree['hits'] = [];
  const labelCounts = new Map<string, number>();
  let fingerprintHitCount = 0;
  for (const message of messages) {
    const labels = executionLanguageFingerprints(message.text);
    if (labels.length === 0) continue;
    fingerprintHitCount += labels.length;
    for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    hits.push({ ...message, labels });
  }

  const lines: string[] = [];
  lines.push('# confirm/notify 原文（给人读；本文件的判据是人，不是机器）');
  lines.push(`# messages: ${messages.length}; messageHitCount: ${hits.length}; fingerprintHitCount: ${fingerprintHitCount}`);
  lines.push('');
  if (messages.length === 0) lines.push('(none)');
  for (const message of messages) {
    const labels = executionLanguageFingerprints(message.text);
    lines.push(`## ${message.caseId} turn ${message.turnIndex + 1} source=${message.source}`);
    lines.push(`labels: ${labels.length ? labels.join(' / ') : '(none)'}`);
    lines.push(message.text);
    lines.push('');
  }
  mkdirSync(path.dirname(humanOutPath), { recursive: true });
  writeFileSync(humanOutPath, lines.join('\n'));

  return {
    messages: messages.length,
    messageHitCount: hits.length,
    fingerprintHitCount,
    labelCounts: sortedRecord(labelCounts),
    hits,
    humanReviewFile: displayPath(humanOutPath),
  };
}

// ── 主流程 ──

function resolveAudit(
  options: MeasurementOptions,
  selected: readonly ProbeCase[],
): { rows: AuditRow[]; source: AxisOne['audit']['source']; badLines: number } {
  if (options.auditPath) {
    const read = readAuditJsonl(options.auditPath);
    return { rows: read.rows, source: 'explicit', badLines: read.badLines };
  }
  if (options.stateDir) {
    const files = discoverStateFiles(options.stateDir, 'audit', '.jsonl');
    if (files.length > 0) {
      const rows: AuditRow[] = [];
      let badLines = 0;
      for (const file of files) {
        const read = readAuditJsonl(file);
        rows.push(...read.rows);
        badLines += read.badLines;
      }
      return { rows, source: 'state-dir', badLines };
    }
  }
  const rows: AuditRow[] = [];
  for (const probeCase of selected) {
    for (const turn of probeCase.turns ?? []) {
      for (const row of turn.execution ?? []) rows.push(row);
    }
  }
  return { rows, source: rows.length > 0 ? 'probe-report' : 'none', badLines: 0 };
}

function resolvePlans(options: MeasurementOptions): { plans: PlanRecord[]; requested: boolean; display: string | null } {
  if (options.planStatePath) {
    return { plans: parsePlanState(options.planStatePath), requested: true, display: options.planStatePath };
  }
  if (options.stateDir) {
    const files = discoverStateFiles(options.stateDir, 'plans', '.json');
    if (files.length > 0) return { plans: mergePlans(files), requested: true, display: files[0]! };
  }
  return { plans: [], requested: false, display: null };
}

export function runSpikeThreeAxis(options: MeasurementOptions): { result: MeasurementResult; outPath: string; humanOutPath: string } {
  const probe = readJson(options.probePath) as ProbeReport;
  if (!Array.isArray(probe.results)) throw new Error(`探针报告没有 results 数组：${options.probePath}`);
  const specs = loadCases(options.casesPath);
  const specsById = new Map(specs.map((spec) => [spec.id, spec]));

  const wanted = options.caseIds && options.caseIds.length > 0 ? new Set(options.caseIds) : null;
  const selected = probe.results.filter((item) => !wanted || wanted.has(item.id));
  if (selected.length === 0) throw new Error(`探针报告里没有所选用例：${options.caseIds?.join(',') ?? '(all)'}`);

  const audit = resolveAudit(options, selected);
  // 去重：崩溃窗口会把同一审计行同时挂在 tailRows 与轮次里。
  const auditRows = [...new Map(audit.rows.map((row) => [auditKey(row), row])).values()];
  const resolvedPlans = resolvePlans(options);

  // 计划按所选用例的 taskId 过滤（state-dir 可能含多例；无 taskId 的计划保留）。
  const selectedTaskIds = new Set(selected.flatMap((probeCase) => probeCase.taskIds ?? []));
  const plans = selectedTaskIds.size > 0
    ? resolvedPlans.plans.filter((plan) => !plan.taskId || selectedTaskIds.has(plan.taskId))
    : resolvedPlans.plans;
  const filteredOutPlans = resolvedPlans.plans.length - plans.length;

  const axis1 = measureAxisOne(selected, auditRows, plans, resolvedPlans.requested, audit.source, audit.badLines);
  if (filteredOutPlans > 0) axis1.notes.push(`按所选用例 taskId 过滤掉 ${filteredOutPlans} 张计划（state-dir 可能含其它用例）。`);
  if (selectedTaskIds.size === 0 && resolvedPlans.plans.length > 0) {
    axis1.notes.push('所选用例没有 taskIds：计划账本未按用例过滤，档位计数可能含同一状态根里的其它用例。');
  }
  const axis2 = measureAxisTwo(selected, specsById, options.casesPath);
  const humanOutPath = options.humanOutPath ?? `${options.outPath.replace(/\.json$/i, '')}.confirm-texts.txt`;
  const axis3 = measureAxisThree(selected, humanOutPath);

  const turnCount = selected.reduce((sum, probeCase) => sum + (probeCase.turns?.length ?? 0), 0);
  const result: MeasurementResult = {
    schema: 'spike-three-axis/v1',
    inputs: {
      probe: displayPath(options.probePath),
      audit: options.auditPath ? displayPath(options.auditPath)
        : audit.source === 'state-dir' && options.stateDir ? displayPath(options.stateDir) : null,
      planState: resolvedPlans.display ? displayPath(resolvedPlans.display) : null,
      cases: displayPath(options.casesPath),
      caseIds: options.caseIds && options.caseIds.length > 0 ? [...options.caseIds] : null,
    },
    measured: { cases: selected.map((probeCase) => probeCase.id), turns: turnCount },
    axis1_gate: axis1,
    axis2_recall: axis2,
    axis3_confirm_language: axis3,
    notes: [
      '本脚本只读文件，不调用模型、不读网络、不读任何 API key。',
      '缺证据一律 null 并写 note；0 只表示「有证据的零」。',
    ],
  };

  mkdirSync(path.dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(result, null, 2)}\n`);
  return { result, outPath: options.outPath, humanOutPath };
}

// ── CLI ──

interface CliOptions extends MeasurementOptions {
  help?: boolean;
}

function argvValue(flag: string, argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === flag) return argv[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function parseCli(argv: readonly string[]): CliOptions {
  const probePath = argvValue('--probe', argv);
  if (!probePath) throw new Error('缺 --probe <探针报告.json>');
  const caseArg = argvValue('--case', argv) ?? argvValue('--only', argv);
  const outPath = argvValue('--out', argv) ?? '.runtime/spike-three-axis.json';
  return {
    probePath,
    casesPath: argvValue('--cases', argv) ?? 'scripts/eval/cases.yaml',
    outPath,
    ...(argvValue('--audit', argv) ? { auditPath: argvValue('--audit', argv)! } : {}),
    ...(argvValue('--plan-state', argv) ? { planStatePath: argvValue('--plan-state', argv)! } : {}),
    ...(argvValue('--state-dir', argv) ? { stateDir: argvValue('--state-dir', argv)! } : {}),
    ...(argvValue('--human-out', argv) ? { humanOutPath: argvValue('--human-out', argv)! } : {}),
    ...(caseArg ? { caseIds: caseArg.split(',').map((id) => id.trim()).filter(Boolean) } : {}),
  };
}

function printSummary(result: MeasurementResult, outPath: string, humanOutPath: string): void {
  const axis1 = result.axis1_gate;
  const axis2 = result.axis2_recall;
  const axis3 = result.axis3_confirm_language;
  console.log('spike 三轴测量');
  console.log(`  轴① 档位 ${JSON.stringify(axis1.plans.tierCounts)} (basis=${axis1.plans.basis})`);
  console.log(`       stop=${axis1.plans.stopOccurrences} confirm=${axis1.plans.confirmOccurrences} 越界拒收=${axis1.audit.outOfScopeRefusals}/${axis1.audit.refusedCalls} SCOPE_EXPANSION=${axis1.plans.scopeExpansionCount ?? 'null'} 用户确认=${axis1.plans.userConfirmations} 判据=${axis1.criteria.verdict}`);
  console.log(`  轴② recall 轮=${axis2.recallTurns.length} 漂移=${axis2.driftCount}（其中更正语境 ${axis2.retractedDriftCount}） 漂移进入执行=${axis2.driftIntoExecutionCount}（扫描后续计划调用 ${axis2.planCallArgsScanned} 行）`);
  console.log(`  轴③ confirm/notify 消息=${axis3.messages} 命中消息=${axis3.messageHitCount} 指纹命中=${axis3.fingerprintHitCount} 标签=${JSON.stringify(axis3.labelCounts)}`);
  console.log(`  输出 ${displayPath(outPath)} / ${displayPath(humanOutPath)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node --import tsx scripts/eval/spike-three-axis.ts --probe <probe.json> [--audit <audit.jsonl>] [--plan-state <plans.json>] [--state-dir <dir>] [--cases <cases.yaml>] [--case A1,B1] [--out <json>] [--human-out <txt>]');
    return;
  }
  const options = parseCli(argv);
  const { result, outPath, humanOutPath } = runSpikeThreeAxis(options);
  printSummary(result, outPath, humanOutPath);
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
