/**
 * R6 测试基建 · 结构泄漏判据（确定性、零模型；**只增读数，不参与处置**）。
 *
 * 判据对象（任一命中即记 `structure_leak`）：
 *   ① `bare_task_envelope`：任务底账结构整段出现在文本里（裸 JSON 信封，如
 *      `{"taskId":"task_<uuid>","taskNo":16,"requestIds":["req_<uuid>"],...}` 或
 *      `{"tasks":[{...}]}`）；识别依据是 JSON 键形状，不做内容嗅探。
 *   ② `internal_task_id`：内部 `task_<uuid>` 标识出现在**给用户的文本或工具参数**里。
 *   ③ `internal_request_id`：内部 `req_<uuid>` 标识出现在**给用户的文本或工具参数**里。
 *   ④ `bulk_detail_package`：整包明细直接进上下文——单条文本的行数 **或** UTF-8 字节数
 *      超过阈值（阈值见 `R6_STRUCTURE_LEAK_BOUNDS`，可整体注入覆盖）。
 *
 * 扫描面（只读既有证据，不新增模型调用）：
 *   · `reply`：会话给用户的回复文本（`SessionEvidence.replies`）——四条规则全适用；
 *   · `tool_args`：模型提交的工具参数（`SessionEvidence.toolCalls[].args`）——四条规则全适用；
 *   · `tool_result`：工具结果摘要（`SessionEvidence.toolCalls[].resultSummary`）——只判
 *     信封与整包；**内部 id 是正常回执字段，不按 id 规则计入**（判据只把 id 泄漏限定在
 *     「给用户的文本或工具参数」）；
 *   · `transcript`：可选原始转录文本（真实适配器暴露时显式传入）——只判信封与整包。
 *
 * **不改既有 disposition**：本模块是纯读数，`classifySample` 不引用它；报告携带
 * `affectsDisposition: false` 作为机器可读声明。判官 U2（JSON·内部结构泄漏率）仍独立。
 */
import type { ReplyRecord, ToolCallRecord } from './evidence';

export const STRUCTURE_LEAK_CODES = [
  'bare_task_envelope',
  'internal_task_id',
  'internal_request_id',
  'bulk_detail_package',
] as const;

export type StructureLeakCode = (typeof STRUCTURE_LEAK_CODES)[number];

export const STRUCTURE_LEAK_SURFACES = ['reply', 'tool_args', 'tool_result', 'transcript'] as const;

export type StructureLeakSurface = (typeof STRUCTURE_LEAK_SURFACES)[number];

/** 判据阈值（显式、可调）：缺省值以真实 Wave1 的 400 行整包明细为命中下限设计。 */
export interface StructureLeakBounds {
  /** 单条文本行数 **>** 此值 → 整包明细。缺省 200（400 行整包必中；普通回复远低于此）。 */
  readonly maxBulkLines: number;
  /** 单条文本 UTF-8 字节数 **>** 此值 → 整包明细。缺省 16 KiB。 */
  readonly maxBulkBytes: number;
  /** 非相邻信封键（`"taskId"` 与 `"requestIds"/"executions"/"taskNo"`）的最大共现窗口（字符）。 */
  readonly envelopeSpanChars: number;
  /** 是否扫描 `tool_result` 面（缺省 true；关掉时工具结果整体不计）。 */
  readonly scanToolResults: boolean;
}

export const R6_STRUCTURE_LEAK_BOUNDS: StructureLeakBounds = {
  maxBulkLines: 200,
  maxBulkBytes: 16_384,
  envelopeSpanChars: 2_000,
  scanToolResults: true,
};

export interface StructureLeakHit {
  readonly turn: number;
  readonly surface: StructureLeakSurface;
  readonly code: StructureLeakCode;
  /** 可复核坐标（工具调用序号 / 文本偏移 / 转录面）。 */
  readonly ref: string;
  /** 截断证据（≤180 字符），供人工复核；不倾倒整包原文。 */
  readonly evidence: string;
}

export interface StructureLeakReport {
  /** 判据标识（读数统一命名）。 */
  readonly criterion: 'structure_leak';
  /** 机器可读声明：本读数不参与 classification。恒为 false。 */
  readonly affectsDisposition: false;
  readonly bounds: StructureLeakBounds;
  /** 已扫描的回合数（回复与工具调用覆盖到的 turn 并集）。 */
  readonly scannedTurns: number;
  /** 至少一条命中的回合数。 */
  readonly hitTurns: number;
  /** 命中条数（按 turn+surface+code 去重，一回合同类多处只计一条）。 */
  readonly totalHits: number;
  readonly byCode: Readonly<Record<StructureLeakCode, number>>;
  readonly bySurface: Readonly<Record<StructureLeakSurface, number>>;
  readonly byTurn: readonly { readonly turn: number; readonly hits: number }[];
  readonly hits: readonly StructureLeakHit[];
}

/** 扫描输入：只用既有证据（回复 + 工具调用，可选原始转录）。 */
export interface StructureLeakInput {
  readonly replies: readonly Pick<ReplyRecord, 'index' | 'text'>[];
  readonly toolCalls?: readonly Pick<ToolCallRecord, 'turn' | 'tool' | 'agent' | 'seq' | 'args' | 'resultSummary'>[];
  readonly transcriptText?: string;
}

/** 缺省命中的判定面矩阵（见文件头注释）。 */
const SURFACE_CODES: Readonly<Record<StructureLeakSurface, readonly StructureLeakCode[]>> = {
  reply: STRUCTURE_LEAK_CODES,
  tool_args: STRUCTURE_LEAK_CODES,
  tool_result: ['bare_task_envelope', 'bulk_detail_package'],
  transcript: ['bare_task_envelope', 'bulk_detail_package'],
};

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TASK_ID_PATTERN = new RegExp(`(?<![0-9A-Za-z])task_${UUID}(?![0-9A-Za-z])`);
const REQUEST_ID_PATTERN = new RegExp(`(?<![0-9A-Za-z])req_${UUID}(?![0-9A-Za-z])`);
/** 裸信封的键形状（任务底账 / 任务列表 / 执行清单）。 */
const ENVELOPE_START_PATTERN = /\{\s*"(?:tasks|taskId|requestIds|executions)"\s*:/;
/** 非相邻键的共现证据（`"taskId"` 之后出现这些键之一）。 */
const ENVELOPE_PEER_KEYS = ['"requestIds"', '"executions"', '"taskNo"'] as const;

function emptyByCode(): Record<StructureLeakCode, number> {
  return { bare_task_envelope: 0, internal_task_id: 0, internal_request_id: 0, bulk_detail_package: 0 };
}

function emptyBySurface(): Record<StructureLeakSurface, number> {
  return { reply: 0, tool_args: 0, tool_result: 0, transcript: 0 };
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 命中位置附近的截断证据（空白折叠 + 上限 180 字符）。 */
function snippet(text: string, index: number, matchLength = 0): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + Math.max(matchLength, 60) + 30);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const clipped = body.length > 160 ? `${body.slice(0, 160)}…` : body;
  return `${start > 0 ? '…' : ''}${clipped}${end < text.length ? '…' : ''}`;
}

/** 裸任务信封：JSON 键形状（相邻）或 `"taskId"` 与底账键在窗口内共现（缩进/跨行）。 */
function findBareEnvelope(text: string, spanChars: number): { index: number; length: number } | null {
  const direct = ENVELOPE_START_PATTERN.exec(text);
  if (direct !== null) return { index: direct.index, length: direct[0].length };
  const keyAt = text.indexOf('"taskId"');
  if (keyAt < 0) return null;
  const window = text.slice(keyAt, keyAt + spanChars);
  if (!ENVELOPE_PEER_KEYS.some((key) => window.includes(key))) return null;
  return { index: keyAt, length: '"taskId"'.length };
}

function detect(
  code: StructureLeakCode,
  text: string,
  bounds: StructureLeakBounds,
): { index: number; length: number } | null {
  switch (code) {
    case 'bare_task_envelope':
      return findBareEnvelope(text, bounds.envelopeSpanChars);
    case 'internal_task_id': {
      const match = TASK_ID_PATTERN.exec(text);
      return match === null ? null : { index: match.index, length: match[0].length };
    }
    case 'internal_request_id': {
      const match = REQUEST_ID_PATTERN.exec(text);
      return match === null ? null : { index: match.index, length: match[0].length };
    }
    case 'bulk_detail_package': {
      const lines = lineCount(text);
      const bytes = byteLength(text);
      if (lines <= bounds.maxBulkLines && bytes <= bounds.maxBulkBytes) return null;
      return { index: 0, length: 0 };
    }
  }
}

function bulkEvidence(text: string, bounds: StructureLeakBounds): string {
  return `${lineCount(text)} 行 / ${byteLength(text)} 字节（阈值 >${bounds.maxBulkLines} 行或 >${bounds.maxBulkBytes} 字节）`;
}

interface ScanAccumulator {
  readonly hits: StructureLeakHit[];
  readonly seen: Set<string>;
}

function scanSurface(
  accumulator: ScanAccumulator,
  surface: StructureLeakSurface,
  text: string,
  turn: number,
  ref: string,
  bounds: StructureLeakBounds,
): void {
  if (text === '') return;
  for (const code of SURFACE_CODES[surface]) {
    const found = detect(code, text, bounds);
    if (found === null) continue;
    const key = `${turn}|${surface}|${code}`;
    if (accumulator.seen.has(key)) continue;
    accumulator.seen.add(key);
    accumulator.hits.push({
      turn,
      surface,
      code,
      ref,
      evidence: code === 'bulk_detail_package' ? bulkEvidence(text, bounds) : snippet(text, found.index, found.length),
    });
  }
}

function stringifyArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(args);
  }
}

function compareHits(a: StructureLeakHit, b: StructureLeakHit): number {
  if (a.turn !== b.turn) return a.turn - b.turn;
  const surfaceDelta = STRUCTURE_LEAK_SURFACES.indexOf(a.surface) - STRUCTURE_LEAK_SURFACES.indexOf(b.surface);
  if (surfaceDelta !== 0) return surfaceDelta;
  return STRUCTURE_LEAK_CODES.indexOf(a.code) - STRUCTURE_LEAK_CODES.indexOf(b.code);
}

/**
 * 扫描一次会话的既有证据；零模型、纯函数、确定性。返回逐回合命中与分类计数。
 * `bounds` 可整体覆盖（测试/校准用）；缺省 = `R6_STRUCTURE_LEAK_BOUNDS`。
 */
export function scanStructureLeak(
  input: StructureLeakInput,
  bounds: StructureLeakBounds = R6_STRUCTURE_LEAK_BOUNDS,
): StructureLeakReport {
  const accumulator: ScanAccumulator = { hits: [], seen: new Set() };
  const scanned = new Set<number>();

  for (const reply of input.replies) {
    scanned.add(reply.index);
    scanSurface(accumulator, 'reply', reply.text, reply.index, `reply#${reply.index}`, bounds);
  }

  for (const call of input.toolCalls ?? []) {
    scanned.add(call.turn);
    const seq = call.seq === undefined ? `turn${call.turn}` : `#${call.seq}`;
    const agent = call.agent === undefined ? '' : `:${call.agent}`;
    const tool = call.tool === undefined ? '?' : call.tool;
    scanSurface(accumulator, 'tool_args', stringifyArgs(call.args), call.turn, `tool-args(${tool}${agent}${seq})`, bounds);
    if (bounds.scanToolResults) {
      scanSurface(
        accumulator, 'tool_result', call.resultSummary ?? '', call.turn,
        `tool-result(${tool}${agent}${seq})`, bounds,
      );
    }
  }

  if (input.transcriptText !== undefined && input.transcriptText !== '') {
    scanSurface(accumulator, 'transcript', input.transcriptText, 0, 'transcript', bounds);
  }

  const hits = [...accumulator.hits].sort(compareHits);
  const byCode = emptyByCode();
  const bySurface = emptyBySurface();
  const turnCounts = new Map<number, number>();
  for (const hit of hits) {
    byCode[hit.code] += 1;
    bySurface[hit.surface] += 1;
    turnCounts.set(hit.turn, (turnCounts.get(hit.turn) ?? 0) + 1);
  }

  return {
    criterion: 'structure_leak',
    affectsDisposition: false,
    bounds,
    scannedTurns: scanned.size,
    hitTurns: turnCounts.size,
    totalHits: hits.length,
    byCode,
    bySurface,
    byTurn: [...turnCounts.entries()].sort((a, b) => a[0] - b[0]).map(([turn, count]) => ({ turn, hits: count })),
    hits,
  };
}

/** 单会话读数（写进 `evidence.json` 的 `structureLeak` 字段；不含逐条命中原文）。 */
export interface StructureLeakSummary {
  readonly criterion: 'structure_leak';
  readonly affectsDisposition: false;
  readonly bounds: StructureLeakBounds;
  readonly scannedTurns: number;
  readonly hitTurns: number;
  readonly totalHits: number;
  readonly byCode: Readonly<Record<StructureLeakCode, number>>;
  readonly bySurface: Readonly<Record<StructureLeakSurface, number>>;
  readonly byTurn: readonly { readonly turn: number; readonly hits: number }[];
}

export function structureLeakSummary(report: StructureLeakReport): StructureLeakSummary {
  return {
    criterion: 'structure_leak',
    affectsDisposition: report.affectsDisposition,
    bounds: report.bounds,
    scannedTurns: report.scannedTurns,
    hitTurns: report.hitTurns,
    totalHits: report.totalHits,
    byCode: report.byCode,
    bySurface: report.bySurface,
    byTurn: report.byTurn,
  };
}

/** 逐会话读数（批汇总的输入行）。 */
export interface StructureLeakSessionReading {
  readonly sessionId: string;
  readonly scannedTurns: number;
  readonly hitTurns: number;
  readonly totalHits: number;
  readonly byCode: Readonly<Record<StructureLeakCode, number>>;
}

/** 批汇总：逐会话计数 + 总命中（供 R6 summary/报告字段消费）。 */
export interface StructureLeakBatch {
  readonly criterion: 'structure_leak';
  readonly affectsDisposition: false;
  readonly sessions: number;
  readonly scannedTurns: number;
  readonly hitTurns: number;
  readonly totalHits: number;
  readonly byCode: Readonly<Record<StructureLeakCode, number>>;
  readonly perSession: readonly StructureLeakSessionReading[];
}

/** 汇总多会话读数：会话内先按 turn+surface+code 去重，跨会话直接相加。 */
export function aggregateStructureLeak(
  readings: readonly { readonly sessionId: string; readonly report: StructureLeakReport }[],
): StructureLeakBatch {
  const byCode = emptyByCode();
  const perSession: StructureLeakSessionReading[] = [];
  let scannedTurns = 0;
  let hitTurns = 0;
  let totalHits = 0;
  for (const { sessionId, report } of readings) {
    perSession.push({
      sessionId,
      scannedTurns: report.scannedTurns,
      hitTurns: report.hitTurns,
      totalHits: report.totalHits,
      byCode: report.byCode,
    });
    scannedTurns += report.scannedTurns;
    hitTurns += report.hitTurns;
    totalHits += report.totalHits;
    for (const code of STRUCTURE_LEAK_CODES) byCode[code] += report.byCode[code];
  }
  return {
    criterion: 'structure_leak',
    affectsDisposition: false,
    sessions: readings.length,
    scannedTurns,
    hitTurns,
    totalHits,
    byCode,
    perSession,
  };
}
