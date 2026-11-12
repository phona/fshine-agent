/**
 * S4 判据：执行细节不外泄到用户面（回复面 + 通知面）——2026-11-12 立项（issue #50 用例4）。
 *
 * 为什么单独一份尺：T8 在探针里只是**被动测量**（execution-language-eval 的指纹 → note），
 * 而「用户可见面不许出现执行细节」是一条产品断言，必须有用例与判据对它负责。本模块
 * 把「任意一次任务执行（含失败路径）出厂之后，用户真正看到的那两版文本」作为判定输入，
 * 机械回答：这里面还有没有调用参数 / 错误堆栈 / 内部 id / 工具调用协议标记。
 *
 * 两个用户面（缺一不可，理由见 T8 的两条败状）：
 *   · 回复面 reply        —— 模型终稿经 `sanitizeUserVisibleReply`（reply-exit.ts）出厂的那一版；
 *   · 通知面 notification —— 平台 scopeSummary/noticeText 经 `formatPlanMessage`
 *                            （plan-runtime.ts）拼成的「计划通知：…」帧。确认面此前根本不走
 *                            删除集，就是从这里漏的（confirmation-surface-scrub.test.ts 头部）。
 *
 * 三层判据（谁都不许替代谁）：
 *   ① 删除集幸存者（scrub-survivors）——生产 `scrubExecutionLanguageText` 在**已出厂的**
 *      用户面上仍能删掉东西 = 出口漏挂/漏删。这一层用 `EXECUTION_LANGUAGE_SCRUB_PATTERNS`
 *      的**消费函数**（import 生产实现，不改它），语义 =「机制自己的契约没被满足」。
 *   ② 五类指纹（fingerprint）——评测侧自持的独立尺（scripts/eval/execution-language-eval.ts，
 *      与宿主那份刻意不同源：宿主漏报时这把尺要能自己看见）。
 *   ③ 四类断言（detector）——本用例的验收断言：调用参数 / 错误堆栈 / 内部 id / 工具调用
 *      协议标记。这三类是**现有删除集不覆盖**的面（flag 形态、堆栈帧、plan_/task_ id、
 *      网关命令原文），所以必须由用例自己持有判据，不能拿「机制没删」当「没有泄漏」。
 *
 * 归一影子（评测侧独立实现，语义与生产同族：NFKC / 实体 / 零宽 / 空白拆分），**多做两件
 * 生产不做的事**：URL 百分号编码（`%3C`、`%5F`、`%0A`）与 `\uXXXX` / `\xXX` 反斜杠转义
 * 解码——它们正是本轮对抗语料点名的「编码变形」。生产尺不解码这两种形态，于是编码后的
 * 泄漏会原样留在用户面上；用例必须能把它认出来（判红是成果：说明机制缺一层归一）。
 *
 * 误报纪律（本尺是**评测尺**，报错比漏报更贵——假红会把红绿信号泡掉）：
 *   · 宿主自己的码表词（HOST_ERROR_CODE_NAMES，TASK_FORBIDDEN 族）在用户面上是既有产品
 *     行为（execution-language.ts:75-78 的删除白名单 + execution-language-scrub.test.ts
 *     钉住），本尺同样不报；
 *   · 正文里引用一小段 JSON（`{"kind":"delegate"} 已忽略`）是 reply-exit.test.ts:112-123
 *     钉住的**不允许误伤**行为：`json-fragment` 只在删除集会删（`candidates:`）或带调用
 *     参数键（collection/window/operation/args/payload）时算 hard，裸花括号只记 soft
 *     （报告可见、不翻红绿）。soft 的边界由 execution-leak-criteria.test.ts 钉死。
 *
 * 纯函数：只吃文本，不读网络、不写文件、不改任何生产模块（全部 import 复用）。
 */
import { HOST_ERROR_CODE_NAMES } from '../../packages/agent/src/error-codes';
import { EXECUTION_LANGUAGE_SCRUB_PATTERNS, scrubExecutionLanguageText } from '../../packages/agent/src/execution-language';
import { formatPlanMessage, type PlanEvaluation } from '../../packages/agent/src/plan-runtime';
import { sanitizeUserVisibleReply } from '../../packages/agent/src/reply-exit';
import { executionLanguageFingerprints } from './execution-language-eval';

// ── 类与严重度 ───────────────────────────────────────────────────────────────

/** 本用例的验收断言四类（issue #50 用例4 原文：调用参数 / 错误堆栈 / 内部 id / 工具调用协议标记）。 */
export type AskClass = 'call-param' | 'error-stack' | 'internal-id' | 'protocol-marker';

/** 五类指纹（与 execution-language-eval.ts 的标签一一对应；被五类指纹尺独立判出）。 */
export type FingerprintClass = 'script-path' | 'error-code' | 'json-fragment' | 'operation-name' | 'internal-control-term';

export type LeakClass = AskClass | FingerprintClass;

export const ASK_CLASS_LABELS: Record<AskClass, string> = {
  'call-param': '调用参数',
  'error-stack': '错误堆栈',
  'internal-id': '内部 id',
  'protocol-marker': '工具调用协议标记',
};

export const LEAK_CLASS_LABELS: Record<LeakClass, string> = {
  ...ASK_CLASS_LABELS,
  'script-path': '脚本路径',
  'error-code': '错误码',
  'json-fragment': 'JSON 片段',
  'operation-name': 'operation 名',
  'internal-control-term': '内部控制词',
};

/** hard = 翻红绿；soft = 报告可见但不翻（只用于既有产品行为钉住的 JSON 引用形态）。 */
export type LeakSeverity = 'hard' | 'soft';

export type SurfaceKind = 'reply' | 'notification';

export interface LeakFinding {
  /** 判据层：删除集幸存者 / 独立指纹尺 / 四类断言检测器。 */
  origin: 'scrub-survivor' | 'fingerprint' | 'detector';
  class: LeakClass;
  severity: LeakSeverity;
  /** 命中的原文摘录（报告与失败信息用；不删原文任何字符）。 */
  token: string;
  /** 命中位置与影子（审计用：`surface@12` / `tight@40`）。 */
  where: string;
  /** 为什么算泄漏（一句）。 */
  reason: string;
}

export interface UserVisibleSurface {
  kind: SurfaceKind;
  /** 用例 id（探针测量时来自报告行）。 */
  caseId?: string;
  /** 轮下标（0 起，缺省 = 单轮）。 */
  turn?: number;
  /** 出厂后的用户可见文本。 */
  text: string;
}

export interface SurfaceVerdict {
  kind: SurfaceKind;
  caseId?: string;
  turn?: number;
  text: string;
  findings: LeakFinding[];
  hardCount: number;
}

export interface ExecutionLeakVerdict {
  /** 零 hard 才通过（soft 只进 notes）。 */
  passed: boolean;
  surfaces: SurfaceVerdict[];
  hardByClass: Partial<Record<LeakClass, number>>;
  notes: string[];
}

// ── 评测侧归一影子（独立实现） ───────────────────────────────────────────────

type ShadowKind = 'surface' | 'tight' | 'folded';

interface Unit { ch: string; start: number; end: number }
interface Shadow { kind: ShadowKind; text: string; spans: ReadonlyArray<{ start: number; end: number }> }

const INVISIBLE_PATTERN = /[\u00ad\u200b-\u200f\u2060\ufeff]/;
const SPACE_PATTERN = /[\s\u3000]/;
const HTML_ENTITY_AT_START = /^&(?:lt|gt|amp|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/i;
/** URL 百分号编码（含 `%uXXXX` 的旧式写法）。生产尺没有这一层——正因如此它才必须在评测尺上。 */
const PERCENT_ESCAPE_AT_START = /^%(?:u([0-9a-f]{4})|([0-9a-f]{2}))/i;
/** 反斜杠转义（`\uXXXX` / `\u{XXXX}` / `\xXX`）。 */
const BACKSLASH_ESCAPE_AT_START = /^\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/i;
/** CJK 区（紧影子命中的防误报闸：被空白拆开的 token 与中文散文在紧影子上不可分）。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function decodeHtmlEntity(entity: string): string {
  const body = entity.slice(1, -1).toLowerCase();
  if (body === 'lt') return '<';
  if (body === 'gt') return '>';
  if (body === 'amp') return '&';
  if (body === 'quot') return '"';
  if (body === 'apos') return "'";
  if (body === 'nbsp') return ' ';
  const numeric = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff) {
    try { return String.fromCodePoint(numeric); } catch { return entity; }
  }
  return entity;
}

function pushDecoded(units: Unit[], ch: string, start: number, end: number): void {
  for (const normalized of ch.normalize('NFKC')) {
    if (!INVISIBLE_PATTERN.test(normalized)) units.push({ ch: normalized, start, end });
  }
}

/**
 * 原文 → 归一单元序列。与生产 toUnits 的差别（有意）：
 *   · 先解 URL 百分号编码与反斜杠转义（`%3Ctool_call%3E`、`\u003C` 都要还原成 `<`）；
 *   · 其余步骤同族：HTML 实体解码 → NFKC 逐字 → 丢零宽族。
 */
export function evalUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const entity = HTML_ENTITY_AT_START.exec(rest)?.[0];
    if (entity) {
      pushDecoded(units, decodeHtmlEntity(entity), index, index + entity.length);
      index += entity.length;
      continue;
    }
    const percent = PERCENT_ESCAPE_AT_START.exec(rest);
    if (percent) {
      const code = Number.parseInt(percent[1] ?? percent[2]!, 16);
      if (code > 0) pushDecoded(units, String.fromCodePoint(code), index, index + percent[0].length);
      index += percent[0].length;
      continue;
    }
    const backslash = BACKSLASH_ESCAPE_AT_START.exec(rest);
    if (backslash) {
      const code = Number.parseInt(backslash[1] ?? backslash[2] ?? backslash[3]!, 16);
      if (code > 0) pushDecoded(units, String.fromCodePoint(code), index, index + backslash[0].length);
      index += backslash[0].length;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const ch = String.fromCodePoint(codePoint);
    const width = ch.length;
    if (!INVISIBLE_PATTERN.test(ch)) pushDecoded(units, ch, index, index + width);
    index += width;
  }
  return units;
}

const unitShadow = (kind: ShadowKind, units: ReadonlyArray<Unit>): Shadow => ({
  kind,
  text: units.map((unit) => unit.ch).join(''),
  spans: units.map((unit) => ({ start: unit.start, end: unit.end })),
});

/** tight：删掉全部空白——被换行拆开的码/名/标签重新连成一体。 */
const tightShadow = (units: ReadonlyArray<Unit>): Shadow =>
  unitShadow('tight', units.filter((unit) => !SPACE_PATTERN.test(unit.ch)));

/**
 * folded：空白/下划线的连续段折成单个 `_`（`PERIOD_NO_\nDATA` / `PERIOD\nNO\nDATA` 都折回
 * `PERIOD_NO_DATA`）；纯散文里的空白留一个空格（避免把普通句子折成 snake 形态）。
 * 与生产同语义、写法独立（照抄生产实现会让两把尺共享同一个假阴性）。
 */
const foldedShadow = (units: ReadonlyArray<Unit>): Shadow => {
  const out: Unit[] = [];
  let index = 0;
  const nextSignificant = (from: number): number => {
    let at = from;
    while (at < units.length && SPACE_PATTERN.test(units[at]!.ch)) at += 1;
    return at;
  };
  while (index < units.length) {
    const unit = units[index]!;
    if (unit.ch !== '_' && !SPACE_PATTERN.test(unit.ch)) {
      out.push(unit);
      index += 1;
      continue;
    }
    let end = index;
    let hasUnderscore = false;
    while (end < units.length && (units[end]!.ch === '_' || SPACE_PATTERN.test(units[end]!.ch))) {
      if (units[end]!.ch === '_') hasUnderscore = true;
      end += 1;
    }
    const previous = out.at(-1);
    const next = units[nextSignificant(end)];
    const previousIsWord = previous !== undefined && /[A-Za-z0-9_]/.test(previous.ch);
    const nextIsWord = next !== undefined && /[A-Za-z0-9_]/.test(next.ch);
    const upperNeighbours = previousIsWord && nextIsWord && /[A-Z0-9_]/.test(previous!.ch) && /[A-Z0-9]/.test(next!.ch);
    if (hasUnderscore || upperNeighbours) out.push({ ch: '_', start: units[index]!.start, end: units[end - 1]!.end });
    else if (previousIsWord || nextIsWord) out.push({ ch: ' ', start: units[index]!.start, end: units[end - 1]!.end });
    index = end;
  }
  return unitShadow('folded', out);
};

export function evalShadows(text: string): Record<ShadowKind, Shadow> {
  const units = evalUnits(text);
  return { surface: unitShadow('surface', units), tight: tightShadow(units), folded: foldedShadow(units) };
}

/**
 * 影子命中回原文：返回命中区间与「这次命中是否忠实」。
 *
 * 忠实 = 影子文本里的 token 确实由原文里那一串字符构成，差别只来自影子允许的变形：
 *   · surface：解码（实体/百分号/转义/NFKC/零宽）是受控变换，一律算忠实；
 *   · tight / folded：命中区间里**没被映射单元覆盖**的原文残渣只许是空白（folded 另许 `_`）；
 *   · 紧/折影子另加 CJK 闸：中文散文夹在两个 ASCII 片段之间时紧影子上与「被拆开的 token」
 *     同形（`src/x/ 与 query.js`），这类不报——评测尺宁可漏报这一段，也不制造假红。
 */
function matchSlice(text: string, shadow: Shadow, index: number, length: number): { slice: string; faithful: boolean } {
  const first = shadow.spans[index];
  const last = shadow.spans[index + length - 1];
  if (!first || !last) return { slice: '', faithful: false };
  const slice = text.slice(first.start, last.end);
  if (shadow.kind === 'surface') return { slice, faithful: true };
  const covered = new Array<boolean>(last.end - first.start).fill(false);
  for (let at = index; at < index + length; at += 1) {
    const span = shadow.spans[at];
    if (!span) return { slice, faithful: false };
    if (span.start < first.start || span.end > last.end) return { slice, faithful: false };
    for (let cursor = span.start; cursor < span.end; cursor += 1) covered[cursor - first.start] = true;
  }
  for (let cursor = first.start; cursor < last.end; cursor += 1) {
    if (covered[cursor - first.start]) continue;
    const ch = text[cursor]!;
    const allowed = shadow.kind === 'folded' ? SPACE_PATTERN.test(ch) || ch === '_' : SPACE_PATTERN.test(ch);
    if (!allowed) return { slice, faithful: false };
  }
  if (CJK_PATTERN.test(slice)) return { slice, faithful: false };
  return { slice, faithful: true };
}

function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ── ③ 四类断言检测器（本用例自持；删除集不覆盖的面） ────────────────────────

interface LeakDetector {
  id: string;
  class: LeakClass;
  severity: LeakSeverity;
  shadows: readonly ShadowKind[];
  pattern: RegExp;
  /**
   * 紧影子上的写法：紧影子把空白删光，词间 `\b` 不再成立（`the plan budget` → `theplanbudget`）。
   * 给了就用它扫紧影子，缺省沿用 pattern。
   */
  tightPattern?: RegExp;
  reason: string;
}

/**
 * 断言四类的形态表。每条都写成「带足够上下文才命中」的形状（宁可漏报不假红）：
 * 单一裸词（`error` / `limit`）不报——那正是 Y2 假红校准与英文控词补丁的反面教训。
 */
export const EXECUTION_LEAK_DETECTORS: readonly LeakDetector[] = [
  // ── 工具调用协议标记（删除集也收；跨行拆分后仍在用户面上 = 出口漏删） ──
  {
    id: 'protocol-tag',
    class: 'protocol-marker',
    severity: 'hard',
    shadows: ['tight'],
    pattern: /<\/?(?:tool_call|tool_result|function|parameter)[^>]*>/gi,
    reason: '工具调用协议标签（删除集同族；出现在用户面上即泄漏）',
  },
  {
    id: 'protocol-control-token',
    class: 'protocol-marker',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /<\|(?:tool_call|tool|im_start|im_end|endoftext)\|>/gi,
    reason: '模型协议控制符（工具调用面）',
  },
  {
    id: 'protocol-json-key',
    class: 'protocol-marker',
    severity: 'hard',
    shadows: ['surface', 'tight'],
    pattern: /"?(?:tool_calls|tool_call_id|function_call|tool_use)"?\s*[:=]?/i,
    reason: '工具调用协议键名',
  },
  // ── 错误堆栈（失败路径最容易泄的一类；删除集完全不覆盖） ──
  {
    id: 'stack-frame',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\bat\s+[^\n(]{0,80}\([^\n)]*:\d+:\d+\)/,
    reason: 'V8 堆栈帧（函数名 + 源位置）',
  },
  {
    id: 'stack-node-internal',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\bnode:internal\/[a-z0-9/._-]+/i,
    reason: 'Node 内部模块路径',
  },
  {
    id: 'stack-exception-compound',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    // 复合异常名（TypeError 族）大小写不敏感：`TYPEERROR:` 是同义改写面。裸 `Error:` 单列
    // 一条、保持大小写敏感——小写 `error:` 在英文散文里太常见，收了就是假红。
    pattern: /\b(?:TypeError|RangeError|ReferenceError|SyntaxError):\s/i,
    reason: '异常类名 + 消息（堆栈头）',
  },
  {
    id: 'stack-exception-bare',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\bError:\s/,
    reason: '异常类名 + 消息（堆栈头）',
  },
  {
    id: 'stack-source-location',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /[\w./\\-]+\.(?:ts|tsx|js|cjs|mjs|py):\d+:\d+/,
    reason: '源位置 `文件:行:列`',
  },
  {
    id: 'stack-python-traceback',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /Traceback \(most recent call last\)/i,
    reason: 'Python 回溯头',
  },
  {
    id: 'stack-errno',
    class: 'error-stack',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\b(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EPIPE|EADDRINUSE)\b/i,
    reason: '系统调用错误码（errno）',
  },
  // ── 内部 id（宿主/平台标识；删除集不覆盖） ──
  {
    id: 'id-named-key',
    class: 'internal-id',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\b(?:planId|plan_id|taskId|task_id|runId|run_id|proposalId|proposal_id|sessionId|session_id|dispatchKey|dispatch_key|callId|call_id|traceId|trace_id|spanId|span_id|requestId|request_id|messageId|message_id)\b\s*[:=＝]?\s*["']?[A-Za-z0-9_-]{4,}/i,
    reason: '内部 id 的键名 + 取值',
  },
  {
    id: 'id-prefixed-value',
    class: 'internal-id',
    severity: 'hard',
    shadows: ['surface', 'tight'],
    pattern: /\b(?:plan|task|run|proposal|session|dispatch|msg|req|call|trace|span)_[0-9a-f][0-9A-Za-z_-]{3,}\b/,
    reason: '内部 id 取值（前缀 + 十六进制族）',
  },
  {
    id: 'id-uuid',
    class: 'internal-id',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    reason: 'UUID（请求/会话标识的常见载体）',
  },
  {
    id: 'id-model-api',
    class: 'internal-id',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\b(?:toolu_[0-9A-Za-z]{4,}|chatcmpl-[0-9A-Za-z]{4,})\b/,
    reason: '模型 API 交互 id',
  },
  // ── 调用参数（删除集不覆盖：flag 形态与网关命令原文） ──
  {
    id: 'param-flag',
    class: 'call-param',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /--[a-z][a-z0-9-]{1,}(?:=|\s+)[^\s，。,；;）)]+/i,
    reason: 'CLI 参数原文（--flag value / --flag=value）',
  },
  {
    id: 'param-assignment',
    class: 'call-param',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\b(?:collection|window|operation|args|params|payload)\s*[:=]\s*["']?[A-Za-z0-9_.-]{2,}/i,
    reason: '调用键值对（collection=… / operation: …）',
  },
  {
    id: 'param-json-object',
    class: 'call-param',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\{[^{}]{0,200}"(?:collection|window|operation|args|payload|params|candidates|tool_calls)"\s*:/i,
    reason: 'JSON 调用参数对象',
  },
  {
    id: 'param-gateway-command',
    class: 'call-param',
    severity: 'hard',
    shadows: ['surface', 'tight'],
    pattern: /(?:bin\/(?:dummy|generic)|(?:dummy|ballot|stock|finance)\.(?:query|prepare|commit|proposal|proposal-commit|search-[a-z-]+))/i,
    reason: '网关命令 / operation 名原文',
  },
  {
    id: 'param-args-array',
    class: 'call-param',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /\[\s*"--[a-z][a-z0-9-]*"/i,
    reason: 'args 数组原文（["--collection", "alpha"]）',
  },
  // ── JSON 片段：删除集只收 `candidates:`；裸引用（含内部标记引用）是钉住的既有行为 ──
  {
    id: 'json-candidates-label',
    class: 'json-fragment',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /candidates\s*:/i,
    reason: '委派协议标签 `candidates:`（在删除集内，留屏即漏删）',
  },
  // ── operation 名 / 脚本路径 / 内部控制词：删除集有臂，跨行与全角形态由影子兜住 ──
  {
    id: 'script-path-shape',
    class: 'script-path',
    severity: 'hard',
    shadows: ['surface'],
    pattern: /src[/\\][^\s）)，,，；;]*\.js/i,
    reason: '平台脚本路径',
  },
  {
    id: 'operation-name-dotted',
    class: 'operation-name',
    severity: 'hard',
    shadows: ['surface', 'tight'],
    // 与评测指纹尺同形（点分名 + 末段含横杠）：只认 `voucher.query-saved` 这一族，
    // 不收纯 `a.b`（正常英文句读 e.g./i.e. 与版本号 v1.2 不是操作名）。
    pattern: /\b(?=[a-z][a-z0-9.-]*\.[a-z][a-z0-9-]*-)[a-z][a-z0-9.-]*\b/,
    reason: 'operation 名（点分带横杠形态）',
  },
  {
    id: 'internal-control-term-zh',
    class: 'internal-control-term',
    severity: 'hard',
    shadows: ['tight'],
    pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/g,
    reason: '内部控制词（中文词形）',
  },
  {
    id: 'internal-control-term-en',
    class: 'internal-control-term',
    severity: 'hard',
    shadows: ['surface', 'tight'],
    pattern: /\b(?:quota|plan[ ]?budget|plan[ ]?gate|circuit[ -]?breaker|rejection[ ]?limit|retry[ ]?limit)\b/i,
    tightPattern: /(?:quota|plan[ ]?budget|plan[ ]?gate|circuit[ -]?breaker|rejection[ ]?limit|retry[ ]?limit)/i,
    reason: '内部控制词（英文词形；探针 INTERNAL_CONTROL_TERM_EN 同族）',
  },
];

// ── 判据主函数 ───────────────────────────────────────────────────────────────

/** 删除集标签 → 本用例的类（迁移表；删除集加了新臂而不在这里登记时，`deletionSetCoverage()` 会报缺口）。 */
const SCRUB_LABEL_CLASS: Readonly<Record<string, LeakClass>> = {
  工具调用协议: 'protocol-marker',
  脚本路径: 'script-path',
  错误码: 'error-code',
  'JSON 片段': 'json-fragment',
  'operation 名': 'operation-name',
  内部控制词: 'internal-control-term',
};

/** 删除集的标签清单（读生产表本身，用于覆盖自校验——不改它，也不为绿把它加长/砍短）。 */
export function deletionSetLabels(): string[] {
  return [...new Set(EXECUTION_LANGUAGE_SCRUB_PATTERNS.map((arm) => arm.label))];
}

/** ① 删除集幸存者：已出厂文本里还有生产删除集能删的东西。 */
function scrubSurvivorFindings(text: string): LeakFinding[] {
  const scrubbed = scrubExecutionLanguageText(text);
  if (scrubbed.removed === 0) return [];
  return scrubbed.labels.map((label) => ({
    origin: 'scrub-survivor' as const,
    class: SCRUB_LABEL_CLASS[label] ?? 'error-code',
    severity: 'hard' as const,
    token: label,
    where: 'scrub',
    reason: `删除集（${label}）在已出厂文本上仍有命中 ${scrubbed.removed} 处——出口漏删/漏挂`,
  }));
}

/** 错误码命中是否全是宿主自己的码表词（既有产品行为，不报）。 */
function hostCodeOnly(text: string): boolean {
  const upper = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  const lower = text.match(/(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]*_)(?:[A-Za-z0-9]+_)*(?:not_found|failed|error|invalid|declined|missing|denied|ambiguous|no_data|parse|shape|needs_input)(?:_[A-Za-z0-9]+)*(?![A-Za-z0-9_])/gi) ?? [];
  const tokens = [...upper, ...lower];
  return tokens.length > 0 && tokens.every((token) => HOST_ERROR_CODE_NAMES.has(token));
}

const FINGERPRINT_LABEL_CLASS: Readonly<Record<string, FingerprintClass>> = {
  脚本路径: 'script-path',
  错误码: 'error-code',
  'JSON 片段': 'json-fragment',
  'operation 名': 'operation-name',
  内部控制词: 'internal-control-term',
};

/** ② 五类指纹（评测侧独立尺）。 */
function fingerprintFindings(text: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const label of executionLanguageFingerprints(text)) {
    if (label === '错误码' && hostCodeOnly(text)) continue;
    findings.push({
      origin: 'fingerprint',
      class: FINGERPRINT_LABEL_CLASS[label] ?? 'error-code',
      // 裸花括号/JSON 引用是 reply-exit.test.ts「防误伤」钉住的既有行为：只记 soft；
      // 带调用参数键的 JSON 与 `candidates:` 由检测器按 hard 报。
      severity: label === 'JSON 片段' ? 'soft' : 'hard',
      token: label,
      where: 'fingerprint',
      reason: `独立指纹尺命中「${label}」`,
    });
  }
  return findings;
}

/** ③ 四类断言检测器（含五类里的路径/控制词形态；删除集未覆盖的 flag/堆栈/id 也在这里）。 */
function detectorFindings(text: string): LeakFinding[] {
  const shadows = evalShadows(text);
  const findings: LeakFinding[] = [];
  for (const detector of EXECUTION_LEAK_DETECTORS) {
    for (const kind of detector.shadows) {
      const shadow = shadows[kind];
      const source = kind === 'tight' && detector.tightPattern ? detector.tightPattern : detector.pattern;
      const pattern = new RegExp(source.source, source.flags.includes('g') ? source.flags : `${source.flags}g`);
      for (const match of shadow.text.matchAll(pattern)) {
        const matched = match[0];
        if (!matched || match.index === undefined) continue;
        const { slice, faithful } = matchSlice(text, shadow, match.index, matched.length);
        if (!faithful) continue;
        findings.push({
          origin: 'detector',
          class: detector.class,
          severity: detector.severity,
          token: excerpt(matched),
          where: `${kind}@${(shadow.spans[match.index]?.start ?? 0) + 1}${slice ? '' : ''}`,
          reason: `${detector.reason}（检测器 ${detector.id}）`,
        });
      }
    }
  }
  return findings;
}

/**
 * 单面判定：一份用户可见文本（回复面或通知面）的三层判据合集。
 * 纯函数、零副作用；soft 也返回（调用方按 severity 决定红绿）。
 * 去重键 = 层 + 类 + 命中 token（同一 token 被多个影子/多条臂同时命中只留一条；
 * `where` 保留在条目里供审计，不进键——否则同一处会在 surface/tight 两个影子上报两次）。
 */
export function judgeUserVisibleText(text: string): LeakFinding[] {
  const all = [...scrubSurvivorFindings(text), ...fingerprintFindings(text), ...detectorFindings(text)];
  const seen = new Set<string>();
  return all.filter((finding) => {
    // token 归一（去空白）：同一处会在 surface/tight 两个影子上各报一次，折叠成一条。
    const key = `${finding.origin}:${finding.class}:${finding.token.replace(/\s+/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 多面判定：S4 用例的判据本体。`passed = hardCount === 0`。
 * notes 只作报告（soft 计数、类分布），不参与红绿。
 */
export function judgeExecutionLeakSurfaces(surfaces: readonly UserVisibleSurface[]): ExecutionLeakVerdict {
  const judged: SurfaceVerdict[] = surfaces.map((surface) => {
    const findings = judgeUserVisibleText(surface.text);
    return {
      kind: surface.kind,
      ...(surface.caseId === undefined ? {} : { caseId: surface.caseId }),
      ...(surface.turn === undefined ? {} : { turn: surface.turn }),
      text: surface.text,
      findings,
      hardCount: findings.filter((finding) => finding.severity === 'hard').length,
    };
  });
  const hardByClass: Partial<Record<LeakClass, number>> = {};
  let softCount = 0;
  for (const surface of judged) {
    for (const finding of surface.findings) {
      if (finding.severity === 'soft') softCount += 1;
      else hardByClass[finding.class] = (hardByClass[finding.class] ?? 0) + 1;
    }
  }
  const hardCount = judged.reduce((sum, surface) => sum + surface.hardCount, 0);
  const notes: string[] = [];
  notes.push(`判定面 ${judged.length} 个（回复面 ${judged.filter((s) => s.kind === 'reply').length}、通知面 ${judged.filter((s) => s.kind === 'notification').length}）；hard ${hardCount}、soft ${softCount}`);
  const classSummary = (Object.entries(hardByClass) as Array<[LeakClass, number]>)
    .map(([klass, count]) => `${LEAK_CLASS_LABELS[klass]}×${count}`).join('、');
  if (classSummary) notes.push(`hard 类分布：${classSummary}`);
  if (softCount > 0) {
    notes.push(`soft ${softCount} 处（JSON 引用形态，reply-exit.test.ts:112-123 钉住的既有行为；报告可见、不翻红绿）`);
  }
  return { passed: hardCount === 0, surfaces: judged, hardByClass, notes };
}

// ── 用例装配：任意任务执行（含失败路径）→ 出厂 → 判定 ───────────────────────

export interface ExecutionScenario {
  id: string;
  /** 该轮是否有真实执行（reply-exit 的零执行数值溯源探查按它开关）。 */
  executed: boolean;
  /** 模型终稿原文（出厂前）。 */
  reply: string;
  /** 平台下发/宿主拼接的通知面原文（scopeSummary/noticeText）；缺席 = 该场景无通知面。 */
  notification?: string;
}

export interface ExitPipeline {
  reply: (scenario: ExecutionScenario) => string;
  notification: (raw: string) => string;
}

/**
 * 真实出厂管道：与运行时同两条链（import 生产实现，不改它）。
 *   · 回复面 = `sanitizeUserVisibleReply`（reply-exit.ts 的出口整理：删路径 → 整段申报替换
 *     → 删执行语言 → 零执行金额只留痕）；
 *   · 通知面 = `formatPlanMessage`（plan-runtime.ts 的计划通知唯一出处，T8 起同一把删除尺）。
 */
export const PRODUCTION_EXIT_PIPELINE: ExitPipeline = {
  reply: (scenario) => sanitizeUserVisibleReply({
    text: scenario.reply,
    executed: scenario.executed,
    needsRounds: 0,
    evidence: () => '',
  }).text,
  notification: (raw) => formatPlanMessage(evaluationFor(raw)),
};

/** 测试与变异用：故意乱来的桩（直通，什么都不删）——用来证明判据不是恒绿。 */
export const PASSTHROUGH_EXIT_PIPELINE: ExitPipeline = {
  reply: (scenario) => scenario.reply,
  notification: (raw) => raw,
};

function evaluationFor(scopeSummary: string): PlanEvaluation {
  return {
    planId: 'plan_s4_eval',
    version: 1,
    decision: 'confirm',
    estimate: { calls: 1, seconds: 60, weight: 1 },
    delta: { addedCalls: 1 },
    cumulative: {},
    reasonCode: 'CONFIRM_THRESHOLD',
    status: 'pending',
    scopeSummary,
  };
}

export interface ExecutionLeakCaseResult {
  verdict: ExecutionLeakVerdict;
  /** 出厂后的用户面（判定的真实输入：报告里要能看到用户真正收到的是哪一版）。 */
  surfaces: UserVisibleSurface[];
}

/**
 * 判据输出的人读渲染（失败信息 = 判据输出原文，不另写一份摘要——两处措辞必然漂移）。
 * `maxLines` 只截断展示，截断时显式写出「还有 N 面未列出」，不静默吞证据。
 */
export function renderExecutionLeakReport(verdict: ExecutionLeakVerdict, maxLines = 200): string {
  const hardTotal = verdict.surfaces.reduce((sum, surface) => sum + surface.hardCount, 0);
  const lines: string[] = [];
  lines.push(`S4 判定：${verdict.passed ? '通过' : '不通过'}（hard ${hardTotal}）`);
  lines.push(...verdict.notes);
  const offending = verdict.surfaces.filter((surface) => surface.hardCount > 0);
  for (const surface of offending) {
    lines.push(`--- ${surface.caseId ?? '?'} [${surface.kind}] hard=${surface.hardCount}`);
    lines.push(`    用户面原文：${JSON.stringify(surface.text)}`);
    for (const finding of surface.findings.filter((item) => item.severity === 'hard')) {
      lines.push(`    · [${LEAK_CLASS_LABELS[finding.class]}] ${JSON.stringify(finding.token)} @${finding.where}：${finding.reason}`);
    }
  }
  if (offending.length < verdict.surfaces.length) {
    lines.push(`（另有 ${verdict.surfaces.length - offending.length} 个面零 hard，未列出）`);
  }
  if (lines.length > maxLines) {
    const rest = lines.length - maxLines;
    lines.splice(maxLines, rest, `…（报告超过 ${maxLines} 行，余 ${rest} 行未展示：调大 maxLines 或看 execution-leak-criteria.json）`);
  }
  return lines.join('\n');
}

/**
 * S4 用例本体：把场景（任意任务执行，含失败路径）过出厂管道，再对**出厂后**的
 * 回复面与通知面跑判据。`exit` 只为测试/变异注入（缺省 = 生产管道）。
 */
export function runExecutionLeakCase(
  scenarios: readonly ExecutionScenario[],
  exit: ExitPipeline = PRODUCTION_EXIT_PIPELINE,
): ExecutionLeakCaseResult {
  const surfaces: UserVisibleSurface[] = [];
  for (const scenario of scenarios) {
    surfaces.push({
      kind: 'reply',
      caseId: scenario.id,
      text: exit.reply(scenario),
    });
    if (scenario.notification !== undefined) {
      surfaces.push({
        kind: 'notification',
        caseId: scenario.id,
        text: exit.notification(scenario.notification),
      });
    }
  }
  return { verdict: judgeExecutionLeakSurfaces(surfaces), surfaces };
}
