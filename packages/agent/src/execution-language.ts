import { HOST_ERROR_CODE_NAMES } from './error-codes';
import { PLATFORM_OPERATIONS } from './platform-contract';

const OPERATION_NAME_WHITELIST: ReadonlySet<string> = new Set<string>();
const REGISTERED_OPERATION_ALTERNATION = Object.values(PLATFORM_OPERATIONS)
  .flatMap((name) => [...new Set([name, name.slice(name.indexOf('.') + 1)])])
  .map((token) => String.raw`\b${token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\b`)
  .join('|');

/** Generic fingerprints for internal execution language that must not appear in user replies. */
export const EXECUTION_LANGUAGE_FINGERPRINTS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  whitelist?: ReadonlySet<string>;
}> = [
  { label: '脚本路径', pattern: /src\/[^\s）)，,，；;]*\.js/ },
  { label: '错误码', pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/ },
  { label: 'JSON 片段', pattern: /candidates\s*:|[{}]/ },
  {
    label: 'operation 名',
    pattern: new RegExp([
      String.raw`\b(?=(?:[a-z0-9-]*\.)+[a-z0-9-]*-)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b`,
      REGISTERED_OPERATION_ALTERNATION,
    ].join('|')),
    whitelist: OPERATION_NAME_WHITELIST,
  },
  { label: '内部控制词', pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/ },
];

/** Return labels for internal execution-language shapes found in text. */
export function executionLanguageFingerprints(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern, whitelist } of EXECUTION_LANGUAGE_FINGERPRINTS) {
    if (!whitelist) {
      if (pattern.test(text)) hits.push(label);
      continue;
    }
    const tokens = text.match(new RegExp(pattern.source, 'g')) ?? [];
    if (tokens.some((token) => !whitelist.has(token))) hits.push(label);
  }
  return hits;
}

/**
 * 执行语言**删除**判据表（D-136/D-138，2026-10-26 立项；2026-11-11 T8 扩面）。
 *
 * 与上方指纹表同源但作用不同：指纹表是"发现即告警"（探针/附注准入用），这里做删除。
 * 2026-11-11 起删除面从「只收零争议形态」（协议标记 + 全大写码）扩到**覆盖确认面与
 * 回复面**——五类指纹各有一条删除臂，任一类都不许再出现在用户可见文本里（判据 =
 * 删除后的文本过 `executionLanguageFingerprints` 零命中）。今天的两条败状：修好臂 A2
 * 回复泄漏错误码、确认面（计划通知）此前根本不走删除集。
 *
 * 误删仍要防：小写 snake **只在带失败语义词根时**才算错误码（与评测尺 2026-11-10 的
 * Y2 假红校准同口径——`gamma_collection` 这类对象名同义写法是正常叙述，不删）；
 * 宿主自己的码表词（TASK_FORBIDDEN 族）保留（码上屏是既有产品行为）。
 *
 * 匹配在**归一影子**上做（见 scrubExecutionLanguageText）：plain / tight / folded 三种
 * 影子各自带上回原始文本的区间映射，命中即按区间删原文——对抗形态（同义改写、跨行
 * 拆分、全角/零宽/HTML 实体变形）都落在同一套判据上，不必给每种变形写一条正则。
 */
export type ExecutionLanguageShadow = 'plain' | 'tight' | 'folded';

export const EXECUTION_LANGUAGE_SCRUB_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  shadow: ExecutionLanguageShadow;
  /** 命中白名单的 token 保留（宿主自己的码表词不是泄漏）。 */
  whitelist?: ReadonlySet<string>;
}> = [
  { label: '工具调用协议', pattern: /<\/?(?:tool_call|tool_result|function|parameter)[^>]*>/g, shadow: 'plain' },
  { label: '脚本路径', pattern: /src\/[^\s）)，,，；;]*\.js/g, shadow: 'tight' },
  {
    label: '错误码',
    pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    shadow: 'folded',
    // 宿主码表词（TASK_FORBIDDEN 族）保留——它们出现在宿主自己的确定性话术里，
    // 码上屏是既有产品行为（用户可引用码报告问题）；删除只针对平台/worker 侧码。
    whitelist: HOST_ERROR_CODE_NAMES,
  },
  // 小写/混合蛇形码（同义改写面）：必须带失败语义词根，词根表与评测尺独立持有但同义
  // （两份尺子刻意不同源：谁先收紧，另一边的差异会在评测输出里显形）。
  {
    label: '错误码',
    pattern: /(?<![a-z0-9_])(?=[a-z0-9_]*_)(?:[a-z0-9]+_)*(?:not_found|failed|error|invalid|declined|missing|denied|ambiguous|no_data|parse|shape)(?:_[a-z0-9]+)*(?![a-z0-9_])/gi,
    shadow: 'folded',
  },
  { label: 'JSON 片段', pattern: /candidates\s*:/g, shadow: 'plain' },
  { label: 'operation 名', pattern: new RegExp([String.raw`\b(?=(?:[a-z0-9-]*\.)+[a-z0-9-]*-)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b`, REGISTERED_OPERATION_ALTERNATION].join('|'), 'g'), shadow: 'tight', whitelist: OPERATION_NAME_WHITELIST },
  { label: '内部控制词', pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/g, shadow: 'tight' },
];

/**
 * 影子文本：`text` 是归一后的扫描面，`spans[i]` 是该字符在**原文本**里的区间。
 * 命中区间按 spans 映射回原文再删，原文其余部分逐字节保留。
 */
interface Shadow { text: string; spans: ReadonlyArray<{ start: number; end: number }> }

interface Unit { ch: string; start: number; end: number }

/** 不可见字符（零宽族）：扫描面前直接丢——它们的唯一作用就是拆散形态。 */
const INVISIBLE_PATTERN = /[\u00ad\u200b-\u200f\u2060\ufeff]/;
const WHITESPACE_PATTERN = /[\s\u3000]/;
/** HTML 实体：确认面/回复面里出现过 `&lt;tool_call&gt;` 这类编码变形。 */
const HTML_ENTITY_AT_START = /^&(?:lt|gt|amp|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/i;

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

/** 原文 → 归一单元序列：NFKC 逐字归一、实体解码、不可见字符丢弃；每个单元带原文区间。 */
function toUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < text.length) {
    const entity = HTML_ENTITY_AT_START.exec(text.slice(index))?.[0];
    if (entity) {
      for (const ch of decodeHtmlEntity(entity)) units.push({ ch, start: index, end: index + entity.length });
      index += entity.length;
      continue;
    }
    const code = text.codePointAt(index)!;
    const ch = String.fromCodePoint(code);
    const width = ch.length;
    if (!INVISIBLE_PATTERN.test(ch)) {
      for (const normalized of ch.normalize('NFKC')) units.push({ ch: normalized, start: index, end: index + width });
    }
    index += width;
  }
  return units;
}

const unitShadow = (units: ReadonlyArray<Unit>): Shadow => ({
  text: units.map((unit) => unit.ch).join(''),
  spans: units.map((unit) => ({ start: unit.start, end: unit.end })),
});

/** tight：删掉全部空白——路径/点分名/中文控制词被换行拆开时仍然连成一体。 */
function tightShadow(units: ReadonlyArray<Unit>): Shadow {
  return unitShadow(units.filter((unit) => !WHITESPACE_PATTERN.test(unit.ch)));
}

/**
 * folded：把"空白/下划线的连续段"折成单个 `_`——`PERIOD_NO_\nDATA`、`PERIOD\nNO\nDATA`
 * 折回 `PERIOD_NO_DATA`；纯小写散文里的空白原样留一个空格，避免把普通句子折成 snake
 * 形态（那会把 `the not found case` 误删成一整段）。
 */
function foldedShadow(units: ReadonlyArray<Unit>): Shadow {
  const out: Unit[] = [];
  let index = 0;
  const nextSignificant = (from: number): number => {
    let at = from;
    while (at < units.length && WHITESPACE_PATTERN.test(units[at]!.ch)) at += 1;
    return at;
  };
  while (index < units.length) {
    const unit = units[index]!;
    if (unit.ch === '_' || WHITESPACE_PATTERN.test(unit.ch)) {
      let end = index;
      let hasUnderscore = false;
      while (end < units.length && (units[end]!.ch === '_' || WHITESPACE_PATTERN.test(units[end]!.ch))) {
        if (units[end]!.ch === '_') hasUnderscore = true;
        end += 1;
      }
      const previous = out.at(-1);
      const next = units[nextSignificant(end)];
      const previousIsWord = previous !== undefined && /[A-Za-z0-9_]/.test(previous.ch);
      const nextIsWord = next !== undefined && /[A-Za-z0-9_]/.test(next.ch);
      const uppercaseNeighbours = previousIsWord && nextIsWord && /[A-Z0-9_]/.test(previous!.ch) && /[A-Z0-9]/.test(next!.ch);
      if (hasUnderscore || uppercaseNeighbours) {
        // 这一整段（空白/下划线混排）折成**一个** `_`：`PERIOD_NO_\nDATA`、
        // `PERIOD\nNO\nDATA` 两种拆法都折回 `PERIOD_NO_DATA`。
        out.push({ ch: '_', start: units[index]!.start, end: units[end - 1]!.end });
      } else if (previousIsWord || nextIsWord) {
        out.push({ ch: ' ', start: units[index]!.start, end: units[end - 1]!.end });
      }
      index = end;
      continue;
    }
    out.push(unit);
    index += 1;
  }
  return unitShadow(out);
}

function shadowsOf(text: string): Record<ExecutionLanguageShadow, Shadow> {
  const units = toUnits(text);
  return { plain: unitShadow(units), tight: tightShadow(units), folded: foldedShadow(units) };
}

export interface ExecutionLanguageScrubResult {
  /** 删除后的文本（零命中时与输入同一引用）。 */
  text: string;
  /** 删掉的 token 数（各臂命中的**去重**跨度数）。 */
  removed: number;
  /** 命中的臂标签，按表序去重。 */
  labels: string[];
}

/**
 * 删除式出口整理：五类执行语言 + 工具调用协议标记，原文其余部分逐字节保留。
 *
 * 纯函数：不抛异常、不打日志。命中白名单的 token（宿主自己的码表词）保留；
 * 同一跨度被两条臂同时命中时只计一次（例如全大写码同时满足两条错误码臂）。
 */
export function scrubExecutionLanguageText(text: string): ExecutionLanguageScrubResult {
  if (!text) return { text, removed: 0, labels: [] };
  const shadows = shadowsOf(text);
  const collected: Array<{ start: number; end: number; label: string }> = [];
  for (const arm of EXECUTION_LANGUAGE_SCRUB_PATTERNS) {
    const shadow = shadows[arm.shadow];
    for (const match of shadow.text.matchAll(new RegExp(arm.pattern.source, arm.pattern.flags))) {
      const matched = match[0];
      if (!matched || match.index === undefined) continue;
      if (arm.whitelist?.has(matched)) continue;
      const first = shadow.spans[match.index];
      const last = shadow.spans[match.index + matched.length - 1];
      if (!first || !last) continue;
      collected.push({ start: first.start, end: last.end, label: arm.label });
    }
  }
  // JSON 协议片段：只收 `candidates:` 这个协议标签（D-020 的复读形态）。**花括号形态
  // 刻意不进删除集**：正文里引用一小段 JSON（"接口偶发返回 {"kind":"delegate"} 之类的
  // 内部标记，已忽略"）是既有断言钉住的产品行为（reply-exit.test.ts「防误伤」用例——
  // 整段有可读内容时既不替换也不删），删它就是把用户能读懂的引用一并抹掉。这一类仍由
  // 指纹表守（探针可见），删除面只做零争议形态。
  for (const match of text.matchAll(/candidates\s*:/g)) {
    collected.push({ start: match.index, end: match.index + match[0].length, label: 'JSON 片段' });
  }
  const distinct: Array<{ start: number; end: number; label: string }> = [];
  const seen = new Set<string>();
  for (const span of collected) {
    const key = `${span.start}-${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(span);
  }
  if (distinct.length === 0) return { text, removed: 0, labels: [] };
  const labels: string[] = [];
  for (const span of distinct) if (!labels.includes(span.label)) labels.push(span.label);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of [...distinct].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, removed: distinct.length, labels };
}


