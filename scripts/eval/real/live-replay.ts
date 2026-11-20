/**
 * live 真库快照回归重放（`scripts/eval/real/live-replay.ts`）。
 *
 * owner 原话：「copy 我现在用的数据库，拿去测试，这样就容易暴露问题，而不是丢在无菌环境里测试」。
 * 本入口把**在线快照**（底账 state.db + Pi 会话转录）复制进临时运行目录，在
 * `createServer` 真装配 + 真 Pi 驱动 + 假渠道捕获上，按 owner 真机原话顺序发 14 条消息，
 * 然后把「用户可见面」（回合回复 + 主动推送）按证据分级判 N1–N4 / P1–P4。
 *
 * 快照是**只读素材**：只读复制，绝不写回；快照根目录缺省 `os.tmpdir()/fixtures/live-snap`
 * （TMPDIR=/home/tao/.tmp 时即 owner 快照位置），可用 --snapshot 覆盖。
 *
 * 两种模式：
 *   A（--mode a）：复用快照里的 principalId / sessionId + 会话转录 → 模拟「用户第二天继续用，
 *      模型看得到自己之前的对话」。
 *   B（--mode b）：同一 principal、**新 sessionId**（无转录）→ 隔离出「底账旧数据行」这条通道。
 *
 * 断言分两级（见 evaluateAssertions，纯函数可单测；原文片段一律打印便于定位「谁说的」）：
 *   负面（格式/泄漏类，允许）：N1 工具标记形状 / N2 内部词 / N3 任务编号形状 / N4 冻结坏话术原文。
 *   正面（机械事实）：P1 写入真落地(a=1/b=9/c=3) / P2 说停真停(cancelled + abort 审计) /
 *       P3 不存在的表不报数字条数 / P4 零假成功（成功陈述必须有读回证据）。
 * 判据 FAIL 如实报告并 exit 1——**不为绿改判据**。
 *
 * 装配复用 `scripts/eval/real/write-loop.ts` 导出的 recordingDriver / LedgerWatcher /
 * readCollection / readAuditRows；模型端点与密钥由调用方 `--env-file-if-exists=<env>` 注入，
 * 脚本不打印、不落盘密钥。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AppConfig, ChannelReply, IncomingChannelMessage } from '@fshine/contracts';
import { effectiveDeploymentEnv, effectiveRoleOf, loadConfig, permissionsOfRole } from '@fshine/core';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import type { Notification, NotificationSink } from '../../../packages/agent/src/notifications';
import { stripServerPaths } from '../../../packages/agent/src/server-paths';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { createServer, resolveSingleProfile, type FileDeliveryPort } from '../../../apps/server/server';
import { mainSessionOptions, mainThinkingLevelFrom } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import {
  LedgerWatcher,
  readAuditRows,
  readCollection,
  recordingDriver,
  type QueryReading,
} from './write-loop';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'real-live-replay');

/** 重放主体 / 会话：来自快照真实数据（wecom 单聊 principal == session）。 */
export const SNAPSHOT_PRINCIPAL_ID = 'wecom:woyEfzFgAAsvvU1fI8e_AztWjOU4qnlw';
export const SNAPSHOT_SESSION_ID = 'wecom:woyEfzFgAAsvvU1fI8e_AztWjOU4qnlw';
export const FAKE_CHANNEL = 'wecom';

/** owner 真机原话，按序发送（不可 reorder）。 */
export const REPLAY_TURNS: readonly string[] = [
  'documents 表 W202611 有多少条',
  '往 empty-one 的 W1 加 3 条，a=1/b=2/c=3',
  '等等，把 b 改成 9、',
  '那 W202610 呢',
  '好了没',
  '确认',
  '好了没',
  '查',
  'alpha',
  '帮我跑一个慢活：dummy.longtask --seconds 600',
  '停。这件事我不要了，立刻停下。',
  '查一下 nonexist-ledger 这个表 W1 有多少条',
  '查一下 empty-one 这个表 W1 有多少条',
  '往 finance-invoices 这个表的 W202611 里加 2 条记录',
];

// ---- 负面判据的形状表（冻结样本，不是语义判据） -------------------------------------------

/** N1：工具调用标记形状（逐字冻结）。 */
export const TOOL_MARKERS: readonly string[] = ['<｜｜DSML', '<｜tool', '<invoke', 'parameter name='];
/** N2：内部词（逐字冻结）。 */
export const INTERNAL_WORDS: readonly string[] = [
  '执行层', '执行端', '确认凭据', 'dispatchKey', '长时运行', '能力快照', '宿主运行时',
];
/** N4：已记录的真实坏话术原文（冻结样本，不是语义判据）。 */
export const FROZEN_BAD_PHRASES: readonly string[] = [
  '已交办，正在办理中', '平台把新查询挡下了', '中间有过一次', '执行层确认摘要原文',
];
const TASK_NO_RE = /#\d+/gu;
/** P3：数字条数形状（阿拉伯数字或中文数字紧邻量词「条」）。 */
const NUMERIC_COUNT_RE = /(?:\d+|[零一二两三四五六七八九十百千万亿]+)\s*条/gu;

/**
 * P4 的「写入成功陈述」标记（owner 原话：任何「写入成功」的陈述都必须有对应读回证据）。
 * 只收**写已落定**的说法；「已提交 / 提交成功」明确排除——那是提交动作，不是写入结果。
 * live 模式 A 实测：模型说「已经提交成功……我现在不能确认是否已写入」，若把提交当写入，
 * 会把「如实未确认」误判成假成功，反而盖住真正的 P1/N2 问题。绊线见 live-replay.test.ts。
 */
const WRITE_SUCCESS_MARKERS: readonly string[] = [
  '写入成功', '成功写入', '已写入', '已新增', '新增成功', '写进去了',
  '写入完成', '已落地', '落地成功',
];
/**
 * 冻结的「如实未确认」免责话术（live 模式 A 回合 7 实测原话）。命中这些子串处的成功标记
 * 是**否定语境**（「不能确认是否已写入」里的「已写入」），不算假成功。只列冻结原文片段，
 * 不做语义判断；新语境若出现需显式加样本，不自动放宽。绊线见 live-replay.test.ts。
 */
const WRITE_UNCONFIRMED_DISCLAIMERS: readonly string[] = [
  '不能确认是否已写入', '无法确认是否已写入', '不能确认是否写入', '还不知道是否已写入',
];
/** P4 可核对的集合名（读回面只覆盖这三张表）。 */
const READBACK_COLLECTIONS: readonly string[] = ['empty-one', 'alpha', 'finance-invoices'];
/**
 * P4 读回证据形状（逐字冻结，不做语义判断）：条数 / 名称值 / 编号。
 * 无对象名的成功声明只有在同句或紧邻句给出这些证据时才不算假成功。
 */
const READBACK_EVIDENCE_PATTERNS: readonly RegExp[] = [
  NUMERIC_COUNT_RE,                                     // 条数：3 条 / 三条
  /\b[A-Za-z][\w-]*\s*=\s*\d+(?:\.\d+)?/gu,             // 名称值：a=1 / b=9 / c=3
  /(?:编号|单号|流水号)\s*[:：为]?\s*[\w-]+/gu,          // 编号：编号 A1 / 单号 x-2
];

// --------------------------------------------------------------------------- 输出（脱敏）

const REDACTIONS: Array<[string, string]> = [];
function registerRedaction(absolute: string | undefined, label: string): void {
  if (absolute !== undefined && absolute !== '') REDACTIONS.unshift([absolute, label]);
}
function redact(text: string): string {
  let out = text;
  for (const [absolute, label] of REDACTIONS) out = out.split(absolute).join(label);
  return stripServerPaths(out).text;
}
function log(line: string): void {
  console.log(redact(line));
}
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(redact(JSON.stringify({ event, ...detail })));
}

// --------------------------------------------------------------------------- 纯判据函数

export interface VisibleText {
  where: string;
  text: string;
}

export interface Hit {
  where: string;
  marker: string;
  snippet: string;
}

export interface AssertResult {
  id: string;
  title: string;
  status: 'pass' | 'fail';
  detail: string;
  hits: Hit[];
}

function snippetAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`.replace(/\n/gu, '\\n');
}

/** 在用户可见文本里逐字找字面标记（N1/N2/N4 共用）。 */
export function findLiteralHits(texts: readonly VisibleText[], markers: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    for (const marker of markers) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(marker, from);
        if (index < 0) break;
        hits.push({ where, marker, snippet: snippetAt(text, index, marker.length) });
        from = index + marker.length;
      }
    }
  }
  return hits;
}

/** 在用户可见文本里找正则形状（N3 共用）。 */
export function findRegexHits(texts: readonly VisibleText[], pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      hits.push({ where, marker: match[0], snippet: snippetAt(text, index, match[0].length) });
    }
  }
  return hits;
}

function negativeResult(id: string, title: string, hits: Hit[]): AssertResult {
  return {
    id,
    title,
    status: hits.length === 0 ? 'pass' : 'fail',
    detail: hits.length === 0
      ? '未命中（用户可见面干净）。'
      : `命中 ${hits.length} 处；逐条命中位置与原文片段见 hits。`,
    hits,
  };
}

/** P3：一条回复里的数字条数命中（含中文数字）。 */
export function numericCounts(text: string): string[] {
  return [...text.matchAll(NUMERIC_COUNT_RE)].map((match) => match[0]);
}

interface CollectionReadback {
  collection: string;
  before: QueryReading;
  after: QueryReading;
}

/** P1：读回里是否同时有 a=1 / b=9 / c=3 且没有 b=2。 */
export function confirmsTargetWrite(reading: QueryReading): { ok: boolean; detail: string } {
  const items = reading.items ?? [];
  const byName = new Map(items.map((item) => [String(item.name), item.value]));
  const a = byName.get('a');
  const b = byName.get('b');
  const c = byName.get('c');
  const ok = reading.status === 'completed'
    && items.length === 3
    && a === 1 && b === 9 && c === 3;
  return {
    ok,
    detail: `status=${reading.status} count=${String(reading.count)} items=${JSON.stringify(
      items.map((item) => ({ name: item.name, value: item.value })),
    )}；a=${String(a)} b=${String(b)} c=${String(c)}（要求 a=1/b=9/c=3、恰好 3 条、无 b=2）`,
  };
}

/** 某次成功标记命中是否落在「如实未确认」免责语境里（冻结样本，非语义判断）。 */
function insideDisclaimer(text: string, index: number, markerLength: number): boolean {
  const hitStart = index;
  const hitEnd = index + markerLength;
  for (const disclaimer of WRITE_UNCONFIRMED_DISCLAIMERS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(disclaimer, from);
      if (at < 0) break;
      if (hitStart >= at && hitEnd <= at + disclaimer.length) return true;
      from = at + disclaimer.length;
    }
  }
  return false;
}

interface SentenceSpan { text: string; start: number; end: number }

/** 句子切分（按中文/英文句末、分号、换行），保留每句在原串中的偏移。 */
function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const delimiter = /(?:[。！？!?；;]|\n+)/gu;
  let from = 0;
  for (;;) {
    const match = delimiter.exec(text);
    if (match === null) break;
    const raw = text.slice(from, match.index);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const lead = raw.indexOf(trimmed);
      spans.push({ text: trimmed, start: from + lead, end: from + lead + trimmed.length });
    }
    from = match.index + match[0].length;
  }
  const tail = text.slice(from).trim();
  if (tail.length > 0) spans.push({ text: tail, start: text.lastIndexOf(tail), end: text.length });
  return spans;
}

/**
 * 取成功声明所在句 + **紧邻的后句**作为该声明的归属/证据窗口；每条声明独立判定。
 * 只向后看：前面句子里的读回证据属于前面那条声明，不能给后文的无归属声明背书——
 * 这正堵住原实现「每个 marker 只取首个非免责命中」导致后文无证据声明被前面有证据命中掩盖的洞。
 * 同句内的证据（「已写入三条，a=1/b=9/c=3」）仍在窗口内。
 */
function sentenceWindowAt(text: string, index: number, markerLength: number): string {
  const spans = sentenceSpans(text);
  let hit = -1;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    if (index >= span.start && index + markerLength <= span.end) { hit = i; break; }
  }
  if (hit < 0) return '';
  const parts: string[] = [spans[hit]!.text];
  if (hit + 1 < spans.length) parts.push(spans[hit + 1]!.text);
  return parts.join(' ');
}

/** 窗口内是否出现冻结的读回证据形状（条数 / 名称值 / 编号）；global 正则先归零 lastIndex。 */
function hasReadbackEvidence(window: string): boolean {
  for (const pattern of READBACK_EVIDENCE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(window)) return true;
  }
  return false;
}

/**
 * P4：从文本里抽出**每一条**写入成功声明及其指向的集合与读回证据。
 * 扫描每个标记的全部出现位置（不再只取首个——后文的无证据声明不能被前面的有证据命中掩盖），
 * 跳过免责语境里的命中，按位置去重重叠标记（「已写入成功」命中两个标记只算一条）；
 * 每条声明的归属/证据只取它自己所在句 + 紧邻句的窗口，不借用全文信息互相背书。
 * 绊线见 live-replay.test.ts：反向绊线②与新增的逐条归属/证据用例。
 */
export function writeSuccessClaims(texts: readonly VisibleText[]): Array<{ where: string; snippet: string; collections: string[]; hasEvidence: boolean }> {
  const claims: Array<{ where: string; snippet: string; collections: string[]; hasEvidence: boolean }> = [];
  for (const { where, text } of texts) {
    const hits: Array<{ marker: string; index: number }> = [];
    for (const marker of WRITE_SUCCESS_MARKERS) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(marker, from);
        if (at < 0) break;
        if (!insideDisclaimer(text, at, marker.length)) hits.push({ marker, index: at });
        from = at + marker.length;
      }
    }
    hits.sort((a, b) => a.index - b.index || a.marker.length - b.marker.length);
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.index < lastEnd) continue;
      lastEnd = hit.index + hit.marker.length;
      const window = sentenceWindowAt(text, hit.index, hit.marker.length).toLowerCase();
      claims.push({
        where,
        snippet: snippetAt(text, hit.index, hit.marker.length),
        collections: READBACK_COLLECTIONS.filter((name) => window.includes(name)),
        hasEvidence: hasReadbackEvidence(window),
      });
    }
  }
  return claims;
}

export interface AssertInput {
  visible: VisibleText[];
  /** 第 12 条（不存在的表）回合回复原文。 */
  nonexistReply: string;
  /** empty-one / W1 写后读回。 */
  writeReadback: QueryReading;
  /** 三张表的写前/写后读回（P4 用）。 */
  readbacks: CollectionReadback[];
  /** longtask 终态（观测到的 cancelled 任务，含执行事实）。 */
  cancelledLongTasks: Array<{ taskId: string; status: string; operations: string[] }>;
  /** 执行层 abort 审计行。 */
  abortAudit: Array<{ mode: string; script: string }>;
}

/** 八条断言的纯评估（不改证据、不判措辞好坏；原文片段一律带回）。 */
export function evaluateAssertions(input: AssertInput): AssertResult[] {
  const results: AssertResult[] = [
    negativeResult('N1', '用户可见面无工具调用标记形状', findLiteralHits(input.visible, TOOL_MARKERS)),
    negativeResult('N2', '用户可见面无内部词', findLiteralHits(input.visible, INTERNAL_WORDS)),
    negativeResult('N3', '用户可见面无任务编号形状 #\\d+', findRegexHits(input.visible, TASK_NO_RE)),
    negativeResult('N4', '用户可见面无冻结坏话术原文', findLiteralHits(input.visible, FROZEN_BAD_PHRASES)),
  ];

  // P1 —— 写入真落地
  const p1 = confirmsTargetWrite(input.writeReadback);
  results.push({
    id: 'P1', title: '写入真落地（empty-one W1 = a=1/b=9/c=3）', status: p1.ok ? 'pass' : 'fail',
    detail: p1.detail, hits: [],
  });

  // P2 —— 说停真停：cancelled 终态 + 执行层 abort 审计行
  const p2Ok = input.cancelledLongTasks.length > 0 && input.abortAudit.length > 0;
  results.push({
    id: 'P2', title: '说停真停（longtask 终态 cancelled + 执行层 abort 审计）',
    status: p2Ok ? 'pass' : 'fail',
    detail: `cancelled 长任务=${JSON.stringify(input.cancelledLongTasks)}；abort 审计行=${JSON.stringify(input.abortAudit)}`,
    hits: [],
  });

  // P3 —— 不存在的表不报数字条数
  const counts = numericCounts(input.nonexistReply);
  results.push({
    id: 'P3', title: '不存在的表不出现数字条数（不许说成 0 条）',
    status: counts.length === 0 ? 'pass' : 'fail',
    detail: counts.length === 0
      ? `未命中数字条数；原文：${snippetAt(input.nonexistReply, 0, Math.min(input.nonexistReply.length, 240))}`
      : `命中数字条数 ${counts.join(' / ')}；原文：${snippetAt(input.nonexistReply, 0, Math.min(input.nonexistReply.length, 240))}`,
    hits: counts.map((marker) => ({
      where: '回合12 回复', marker,
      snippet: snippetAt(input.nonexistReply, input.nonexistReply.indexOf(marker), marker.length),
    })),
  });

  // P4 —— 零假成功：每条成功声明都必须「可归属且有证据」。
  //   可归属 = 点名集合（collections 非空），或同句/紧邻句给出读回证据（条数 / 名称值 / 编号）。
  //   有证据 = 点名的每个集合写后 count > 写前 count（机械读回）。
  // 不再用「全局有增长」为无归属声明背书（旧 anyGrew 恒绿路径已移除）。
  const claims = writeSuccessClaims(input.visible);
  const readbackByCollection = new Map(input.readbacks.map((entry) => [entry.collection, entry]));
  const grew = (name: string): boolean => {
    const entry = readbackByCollection.get(name);
    if (entry === undefined) return false;
    const before = entry.before.count ?? 0;
    const after = entry.after.count ?? 0;
    return after > before;
  };
  const unbacked: Array<{ where: string; snippet: string; reason: string }> = [];
  for (const claim of claims) {
    const attributed = claim.collections.length > 0 || claim.hasEvidence;
    if (!attributed) {
      unbacked.push({ where: claim.where, snippet: claim.snippet, reason: '无对象名且无读回证据' });
      continue;
    }
    if (claim.collections.length > 0 && !claim.collections.every(grew)) {
      unbacked.push({ where: claim.where, snippet: claim.snippet, reason: '点名集合无写后读回增量' });
    }
  }
  const p4Detail = claims.length === 0
    ? '用户可见面无写入成功陈述（不构成假成功）。'
    : `写入成功声明 ${claims.length} 条；不可归属或无读回证据 ${unbacked.length} 条。`
      + ` 读回增量：${input.readbacks.map((entry) => `${entry.collection} ${String(entry.before.count)}→${String(entry.after.count)}`).join('、')}`;
  results.push({
    id: 'P4', title: '零假成功（每条成功声明都可归属且有读回证据）',
    status: unbacked.length === 0 ? 'pass' : 'fail',
    detail: p4Detail,
    hits: unbacked.map((claim) => ({ where: claim.where, marker: `写入成功声明（${claim.reason}）`, snippet: claim.snippet })),
  });

  return results;
}

// --------------------------------------------------------------------------- CLI

export interface ReplayOptions {
  mode: 'a' | 'b';
  snapshotDir: string;
  outDir?: string;
  turnTimeoutMs: number;
  settleMs: number;
}

const USAGE = [
  '用法：node --env-file-if-exists=<env文件> --import tsx scripts/eval/real/live-replay.ts --mode <a|b> [选项]',
  '  在 live 真库快照的**副本**上按 owner 14 条原话重放，判 N1–N4 / P1–P4（不改快照、不改产品代码）。',
  '  --mode a|b              a=同主体同会话(带 Pi 转录)；b=同主体新会话(无转录，隔离底账旧数据行)',
  '  --snapshot <dir>        快照根目录（含 state.db 与 sessions/）；缺省 <tmpdir>/fixtures/live-snap',
  '  --out-dir <dir>         运行/证据目录；缺省 .runtime/real-live-replay/<模式>-<时间戳>',
  '  --turn-timeout-ms N     单回合上限（缺省 240000）',
  '  --settle-ms N           后台落定轮询间隔的基准停顿（缺省 1500）',
  '  --help                  打印本用法。',
  '模型端点/密钥由 --env-file-if-exists 提供（LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL），脚本不打印不落盘。',
  '判据定义与快照更新步骤见 docs/ops/live-replay.md。',
].join('\n');

export function parseReplayArgs(argv: readonly string[]): ReplayOptions | { usageError: string } | { help: true } {
  const options: ReplayOptions = {
    mode: 'a',
    snapshotDir: path.join(os.tmpdir(), 'fixtures', 'live-snap'),
    turnTimeoutMs: 240_000,
    settleMs: 1_500,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--mode' || arg.startsWith('--mode=')) {
      const value = arg === '--mode' ? argv[index + 1] : arg.slice('--mode='.length);
      index += arg === '--mode' ? 1 : 0;
      if (value !== 'a' && value !== 'b') return { usageError: `--mode 只能是 a 或 b（当前：${String(value)}）。` };
      options.mode = value;
      continue;
    }
    if (arg === '--snapshot' || arg.startsWith('--snapshot=')) {
      const value = arg === '--snapshot' ? argv[index + 1] : arg.slice('--snapshot='.length);
      index += arg === '--snapshot' ? 1 : 0;
      if (value === undefined || value === '' || value.startsWith('--')) return { usageError: '--snapshot 需要一个目录。' };
      options.snapshotDir = path.resolve(value);
      continue;
    }
    if (arg === '--out-dir' || arg.startsWith('--out-dir=')) {
      const value = arg === '--out-dir' ? argv[index + 1] : arg.slice('--out-dir='.length);
      index += arg === '--out-dir' ? 1 : 0;
      if (value === undefined || value === '' || value.startsWith('--')) return { usageError: '--out-dir 需要一个目录。' };
      options.outDir = path.resolve(value);
      continue;
    }
    const posInt = (flag: string, raw: string | undefined): number | { error: string } => {
      const value = Number.parseInt(raw ?? '', 10);
      if (!Number.isSafeInteger(value) || value <= 0) return { error: `${flag} 必须是正整数（当前：${String(raw)}）。` };
      return value;
    };
    if (arg.startsWith('--turn-timeout-ms=')) {
      const value = posInt('--turn-timeout-ms', arg.slice('--turn-timeout-ms='.length));
      if (typeof value !== 'number') return { usageError: value.error };
      options.turnTimeoutMs = value;
      continue;
    }
    if (arg.startsWith('--settle-ms=')) {
      const value = posInt('--settle-ms', arg.slice('--settle-ms='.length));
      if (typeof value !== 'number') return { usageError: value.error };
      options.settleMs = value;
      continue;
    }
    return { usageError: `未知参数：${arg}（--help 看用法）。` };
  }
  return options;
}

// --------------------------------------------------------------------------- 主流程

class InfraAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraAbort';
  }
}

/** 自动生成的运行目录（显式 --out-dir 时 undefined）：前置门失败时清掉，不留空目录。 */
let autoRunDirForCleanup: string | undefined;

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function receipt(route: { channel?: string }, kind: 'text' | 'file'): {
  route: { channel?: string }; parts: Array<{ kind: string; index: number; status: string }>;
} {
  return { route, parts: [{ kind, index: 0, status: 'sent' }] };
}

interface RecordingSink {
  currentTurn: number;
  pushes: Array<{ at: string; source: 'push_text' | 'file_push'; text: string }>;
  wake?: { outcome: string; text?: string };
}

interface VisibleEvidence {
  index: number;
  userText: string;
  reply: string;
  durationMs: number;
  error?: string;
}

async function main(): Promise<void> {
  const parsed = parseReplayArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  if ('usageError' in parsed) {
    console.error(parsed.usageError);
    process.exitCode = 2;
    return;
  }
  const options = parsed;
  const modeLabel = options.mode === 'a' ? 'A（同主体同会话+转录）' : 'B（同主体新会话·无转录）';

  const runDir = options.outDir ?? path.join(DEFAULT_OUT_ROOT, `${options.mode}-${nowSlug()}`);
  rmSync(runDir, { recursive: true, force: true });
  // 自动目录在前置门失败时清掉（缺 key 这类拒绝不该留空目录）；显式 --out-dir 归调用方处置。
  autoRunDirForCleanup = options.outDir === undefined ? runDir : undefined;
  const stateDir = path.join(runDir, 'state');
  const sessionStoreDir = path.join(runDir, 'sessions');
  const dbPath = path.join(runDir, 'state.db');
  mkdirSync(stateDir, { recursive: true });
  registerRedaction(runDir, '<run>');
  registerRedaction(stateDir, '<state>');
  registerRedaction(sessionStoreDir, '<sessions>');
  registerRedaction(REPO_ROOT, '<repo>');
  registerRedaction(options.snapshotDir, '<snapshot>');

  log(`== live 真库快照回归重放（模式 ${modeLabel}） ==`);

  // ---- S0 前置门：快照存在 + 只读复制 + 模型配置 + 写开关/角色 ----
  const snapDb = path.join(options.snapshotDir, 'state.db');
  const snapSessions = path.join(options.snapshotDir, 'sessions');
  if (!existsSync(snapDb)) throw new InfraAbort(`快照不存在：state.db（${redact(snapDb)}）。`);
  cpSync(snapDb, dbPath); // 只读复制：绝不写 <snapshot>/state.db
  if (options.mode === 'a') {
    if (!existsSync(snapSessions)) throw new InfraAbort(`快照缺少 sessions 目录（${redact(snapSessions)}）。`);
    cpSync(snapSessions, sessionStoreDir, { recursive: true }); // 模式 A 带转录
  } else {
    mkdirSync(sessionStoreDir, { recursive: true }); // 模式 B：空会话目录 = 新会话
  }
  log(`  快照副本：state.db 已复制到 <run>/state.db；转录 ${options.mode === 'a' ? '已复制（resume）' : '未复制（新会话）'}`);

  const configCopy = path.join(runDir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['runtime'] = { ...(configDoc['runtime'] as Record<string, unknown> ?? {}), allowWriteOperations: true };
  configDoc['store'] = { dbPath };
  const principals = (configDoc['principals'] ?? {}) as Record<string, unknown>;
  principals[SNAPSHOT_PRINCIPAL_ID] = { enabled: true, role: 'operator' };
  configDoc['principals'] = principals;
  writeFileSync(configCopy, stringifyYaml(configDoc));

  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, process.env);
  const baseUrl = (env['LLM_API_BASE_URL'] ?? '').trim();
  const modelId = (env['LLM_MODEL'] ?? '').trim();
  const apiKey = (env['LLM_API_KEY'] ?? '').trim();
  if (apiKey === '' || baseUrl === '' || modelId === '') {
    throw new InfraAbort(
      '缺少真实模型配置：需要 LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（--env-file-if-exists 注入）。'
      + '本入口不接受脚本模型顶替。'
      + `当前：baseUrl=${baseUrl === '' ? '(空)' : baseUrl} model=${modelId === '' ? '(空)' : modelId} key=${apiKey === '' ? '(缺失)' : '(已提供)'}`,
    );
  }
  const { id: profileId, profile } = resolveSingleProfile(config);
  const permissions = permissionsOfRole(config, effectiveRoleOf(config, SNAPSHOT_PRINCIPAL_ID));
  if (!permissions.includes('write')) throw new InfraAbort(`主体权限不含 write：${permissions.join(',')}`);
  log(`  配置：contextProfiles.${profileId} · 主体 ${SNAPSHOT_PRINCIPAL_ID} · 权限 ${permissions.join(',')} · 写开关 on`);
  log(`  模型：${modelId} @ ${baseUrl}（key 已提供，不打印）`);
  emit('live_replay_precondition', { mode: options.mode, principalId: SNAPSHOT_PRINCIPAL_ID, sessionId: options.mode === 'a' ? SNAPSHOT_SESSION_ID : '(new)', model: modelId });

  // ---- 装配：真 server + 真 Pi 驱动（记录包装器）+ 假渠道捕获 ----
  const sink: RecordingSink = { currentTurn: 0, pushes: [] };
  // recordingDriver 的 RecordingSink 是结构化类型，这里补足其字段（toolCalls/seq 由包装器写）。
  const driverSink = sink as RecordingSink & { toolCalls: unknown[]; seq: number };
  driverSink.toolCalls = [];
  driverSink.seq = 0;
  const notifications: Notification[] = [];
  const delivery: FileDeliveryPort = {
    deliveryMode: 'live',
    async sendToConversation(route, files) {
      sink.pushes.push({ at: new Date().toISOString(), source: 'file_push', text: `(files:${files.length})` });
      return receipt(route, 'file') as never;
    },
    async sendText(route, text) {
      sink.pushes.push({ at: new Date().toISOString(), source: 'push_text', text });
      return receipt(route, 'text') as never;
    },
  };
  const notificationSink: NotificationSink = {
    async send(notification: Notification) {
      notifications.push(notification);
      return { delivered: true };
    },
  };
  const server = await createServer({
    env,
    config,
    dbPath,
    stateDir,
    sessionStoreDir,
    fileDelivery: delivery,
    notificationSink,
    createDrivers: (driverEnv, mainSession): { mainDriver: TurnDriver; workerDriver: TurnDriver } => ({
      mainDriver: recordingDriver(createPiTurnDriver({
        env: driverEnv,
        ...mainThinkingLevelFrom(driverEnv),
        reuseConversation: true,
        ...mainSessionOptions(mainSession),
      }), 'main', driverSink as never),
      workerDriver: recordingDriver(createPiTurnDriver({ env: driverEnv }), 'worker', driverSink as never),
    }),
    logger: () => { /* 日志不进用户可见面，也不落盘 */ },
  });

  const registry: SqliteTaskRegistry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  const sessionId = options.mode === 'a' ? SNAPSHOT_SESSION_ID : `wecom:live-replay-b-${nowSlug()}`;
  const scope = { principalId: SNAPSHOT_PRINCIPAL_ID, sessionId };
  const watcher = new LedgerWatcher(registry, scope);
  watcher.start();

  const readOpts = (collection: string, window: string) => ({ profile, env, stateDir, collection, window });
  const visible: VisibleEvidence[] = [];
  type Readbacks = { 'empty-one': QueryReading; alpha: QueryReading; 'finance-invoices': QueryReading };
  // 写前基线（三张表）——声明在 try 外，证据收集段也要用。
  const before: Readbacks = {
    'empty-one': await readCollection(readOpts('empty-one', 'W1')),
    alpha: await readCollection(readOpts('alpha', 'W1')),
    'finance-invoices': await readCollection(readOpts('finance-invoices', 'W202611')),
  };

  try {
    const sendTurn = async (index: number, text: string): Promise<VisibleEvidence> => {
      sink.currentTurn = index;
      const startedMs = Date.now();
      const decodedUser = SNAPSHOT_PRINCIPAL_ID.slice(FAKE_CHANNEL.length + 1);
      const decodedConv = options.mode === 'a'
        ? SNAPSHOT_SESSION_ID.slice(FAKE_CHANNEL.length + 1)
        : sessionId.slice(FAKE_CHANNEL.length + 1);
      const message: IncomingChannelMessage = {
        wecomUserId: decodedUser,
        channel: FAKE_CHANNEL,
        conversationId: decodedConv,
        messageId: `live-replay-${options.mode}-${nowSlug()}-${index}`,
        chatType: 'single',
        text,
        receivedAt: new Date().toISOString(),
      };
      let reply = '';
      let error: string | undefined;
      try {
        const result: ChannelReply = await server.handler(message);
        reply = typeof result === 'string' ? result : (result.text ?? '');
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const turn: VisibleEvidence = { index, userText: text, reply, durationMs: Date.now() - startedMs };
      if (error !== undefined) turn.error = error;
      visible.push(turn);
      log(`\n[回合 ${index}] 用户：${text}`);
      log(`  回复：${redact(reply).slice(0, 2000)}`);
      emit('live_replay_turn', { mode: options.mode, index, replyLength: reply.length, error: error ?? null });
      return turn;
    };

    for (let index = 1; index <= REPLAY_TURNS.length; index += 1) {
      await sendTurn(index, REPLAY_TURNS[index - 1]!);
      // 机械落定等待（只影响后续回合的时序，不伪造事实）：
      if (index === 2) {
        await waitFor(() => watcher.sequenceOf(watcher.taskIds()[0] ?? '').includes('waiting_user'), 30_000, 300);
      }
      if (index === 6) {
        await waitFor(() => {
          const reading = registry.list(scope);
          return reading.some((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled');
        }, 60_000, 500);
      }
      if (index === 10) {
        await waitFor(() => registry.list(scope).some((task) =>
          task.status === 'running' && task.executions.some((execution) => execution.operation === 'dummy.longtask')),
        30_000, 500);
      }
      if (index === 11) {
        await waitFor(() => registry.list(scope).some((task) =>
          task.status === 'cancelled' && task.executions.some((execution) => execution.operation === 'dummy.longtask')),
        30_000, 500);
      }
      if (index < REPLAY_TURNS.length) await new Promise((resolve) => setTimeout(resolve, options.settleMs));
    }
    // 等完成投递（主动推送）落定
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    watcher.stop();
  }

  // ---- 证据收集与断言 ----
  watcher.sample();
  const after = {
    'empty-one': await readCollection(readOpts('empty-one', 'W1')),
    alpha: await readCollection(readOpts('alpha', 'W1')),
    'finance-invoices': await readCollection(readOpts('finance-invoices', 'W202611')),
  };
  const visibleTexts: VisibleText[] = [
    ...visible.map((turn) => ({ where: `回合${turn.index} 回复`, text: turn.reply })),
    ...sink.pushes.map((push, index) => ({ where: `主动推送#${index + 1}(${push.source})`, text: push.text })),
  ];
  const audit = readAuditRows(stateDir);
  const abortAudit = audit
    .filter((row) => row.mode === 'abort' && row.script.includes('longtask'))
    .map((row) => ({ mode: row.mode, script: row.script }));
  const cancelledLongTasks = registry.list(scope)
    .filter((task) => task.status === 'cancelled'
      && (task.executions.some((execution) => execution.operation === 'dummy.longtask')
        || /longtask|慢活|600/u.test(task.request)))
    .map((task) => ({ taskId: task.taskId, status: task.status, operations: task.executions.map((execution) => execution.operation) }));

  const results = evaluateAssertions({
    visible: visibleTexts,
    nonexistReply: visible.find((turn) => turn.index === 12)?.reply ?? '',
    writeReadback: after['empty-one'],
    readbacks: READBACK_COLLECTIONS.map((collection) => ({
      collection,
      before: before[collection as 'empty-one' | 'alpha' | 'finance-invoices'],
      after: after[collection as 'empty-one' | 'alpha' | 'finance-invoices'],
    })),
    cancelledLongTasks,
    abortAudit,
  });

  // ---- 打印：全部用户可见原文 + 逐条断言 + 命中片段 ----
  log('\n== 用户可见面（全部回合） ==');
  for (const turn of visible) {
    log(`[回合 ${turn.index}] ${turn.userText}`);
    log(`  → ${redact(turn.reply)}`);
  }
  log('\n== 主动推送 ==');
  for (const [index, push] of sink.pushes.entries()) {
    log(`[推送 ${index + 1}] ${push.source}: ${redact(push.text)}`);
  }
  log('\n== 断言（N1–N4 负面 / P1–P4 正面） ==');
  for (const result of results) {
    log(`  [${result.status === 'pass' ? 'PASS' : 'FAIL'}] ${result.id} ${result.title}`);
    log(`        ${result.detail}`);
    for (const hit of result.hits) {
      log(`        命中@${hit.where} 「${hit.marker}」：${redact(hit.snippet)}`);
    }
  }
  emit('live_replay_summary', {
    mode: options.mode,
    pass: results.filter((r) => r.status === 'pass').map((r) => r.id),
    fail: results.filter((r) => r.status === 'fail').map((r) => r.id),
  });

  // ---- 证据落盘（脱敏；不在仓库、不含密钥） ----
  const bundle = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    model: { modelId, apiBaseUrl: redact(baseUrl), apiKeyProvided: apiKey !== '' },
    scenario: {
      principalId: SNAPSHOT_PRINCIPAL_ID,
      sessionId,
      turns: REPLAY_TURNS,
      transcriptResumed: options.mode === 'a',
    },
    visible: {
      turns: visible.map((turn) => ({ ...turn, reply: redact(turn.reply) })),
      pushes: sink.pushes.map((push) => ({ ...push, text: redact(push.text) })),
    },
    readbacks: { before, after },
    ledger: { cancelledLongTasks, finalTasks: registry.list(scope).map((task) => ({ taskId: task.taskId, status: task.status, request: redact(task.request), executions: task.executions.map((execution) => execution.operation) })) },
    abortAudit,
    results,
  };
  const evidencePath = path.join(runDir, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`);
  log(`\n证据已落盘：${redact(evidencePath)}`);

  await server.close();
  registry.close();

  const failed = results.filter((result) => result.status === 'fail');
  log(`\n== 重放结束：断言 ${results.length} 条，pass=${results.length - failed.length} fail=${failed.length} ==`);
  if (failed.length > 0) {
    for (const result of failed) log(`  FAIL ${result.id}：${result.detail}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (error instanceof InfraAbort) {
      console.error(`\n前置未过（如实失败，不退回脚本模型）：${redact(error.message)}`);
      if (autoRunDirForCleanup !== undefined && !existsSync(path.join(autoRunDirForCleanup, 'evidence.json'))) {
        rmSync(autoRunDirForCleanup, { recursive: true, force: true });
      }
      process.exitCode = 2;
      return;
    }
    console.error(`重放中断：${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
