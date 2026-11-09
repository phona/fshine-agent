/**
 * audited 申报模式：封闭申报语法解析 + 「申报-事实」五查交叉核（D-206 闭环判据第一块，
 * owner 2026-11-09 裁定 + PR #25 后的契约）。
 *
 * **背景**：PR #25 删掉了 `clauseLedgerResult`——那个用正则从模型自由文本推断算式归属的
 * 解析器成了 19 轮 codex 审查的打地鼠现场。owner 裁定：机械层只做封闭世界查表，算式对错
 * 归 judge。正解是 eval 时注入调试提示词，让模型逐轮在回复末尾追加一段**封闭语法**的申报：
 *
 *   [audit]
 *   500 <- rec-101          ← 引用行：申报值 ← 记录号
 *   1000 := 500 + 300 + 200 ← 运算行：申报值 := 加数链（只认 + / - 链）
 *   [/audit]
 *
 * 本模块只做两件事：① 按封闭语法解析申报块（**不做任何自由文本推断**——clauseLedgerResult
 * 正是自由文本推断，不许以任何形式复活）；② 把申报与宿主持有的结构化事实（审计行
 * `result.items`）做五查交叉核，每条不过产出一条 note（判红）。
 *
 * 块分界只认**独占行首的 `[audit]` 与独占行尾的 `[/audit]`**：夹在句子中间的标记是正文
 * （模型复述申报指令的形态），不是分界——判据见 AUDIT_OPEN_LINE_RE 处。
 *
 * **五查**（不过 ⇒ 对应 note）：
 *   覆盖    —— 回复里每个数字都有申报行（引用或运算）；回复无数字则不要求有块；
 *   幻影源  —— 申报的 rec 号不出现在任何审计行 result.items 里；
 *   值不符  —— 申报值 ≠ 该记录在 result.items 里的 value；
 *   运算闭合 —— := 右侧每个数都有申报行（递归到引用行）；
 *   格式    —— 有数字但没有审计块，或行不可解析。
 *
 * **`:=` 行不验算**（算式对错归 judge，与 PR #25 同契约）：这里只验闭合——右侧每个加数
 * 都要有申报行可依。"1000 := 500 + 300 + 200" 实算是不是 1000，不归机械层管。
 *
 * **归属**：封闭世界查表是 fshine 通用机制（AGENTS.md 改动归属）；申报格式的注入与夹具
 * 落账在评测/执行层适配边界，不在本模块。本模块无 I/O、不跑模型，纯函数，可被单测直接 import
 * （与 amount-criteria.ts 同款抽法）。
 */
import { extractAmounts } from './amount-criteria';
import type { ExecutionAuditRow } from './evidence';

// ── 形状 ──

/** 五查的名字（判红时逐条可指认；顺序即 D-206 闭环判据里的列举序）。 */
export type AuditDeclarationCheck =
  | 'coverage'
  | 'phantomSource'
  | 'valueMismatch'
  | 'operationClosure'
  | 'format';

export const AUDIT_DECLARATION_CHECKS: readonly AuditDeclarationCheck[] = [
  'coverage',
  'phantomSource',
  'valueMismatch',
  'operationClosure',
  'format',
];

/** 引用行：`值 <- 记录号`。记录号 = 审计行 result.items 里的 id 或 name。 */
export interface AuditReferenceLine {
  kind: 'reference';
  /** 申报值。 */
  value: number;
  /** 引用的记录号。 */
  ref: string;
  /** 行原文（note 回显用）。 */
  raw: string;
}

/** 运算行：`值 := 数 + 数 …`。只收形态，**不验算**（算式对错归 judge）。 */
export interface AuditOperationLine {
  kind: 'operation';
  /** 申报的结果值（:= 左侧）。 */
  value: number;
  /** := 右侧的加数链（原顺序；运算符只用于校验形态，不在此求值）。 */
  addends: readonly number[];
  raw: string;
}

export type AuditDeclarationLine = AuditReferenceLine | AuditOperationLine;

/** 一条违例（note 与结构化判定同源，供测试与报告分别消费）。 */
export interface AuditDeclarationFinding {
  check: AuditDeclarationCheck;
  /** 违例对象：数字（覆盖/值不符/运算闭合）或记录号（幻影源）或 'block'（块级格式）。 */
  subject: string;
  /** 逐轮 note 文案（探针 note 风格：说清哪条检查不过、涉及哪个数/哪个记录号）。 */
  note: string;
}

export interface AuditDeclarationVerdict {
  /** 五查全过 = 申报与事实一致（回复无数字时无块也过）。 */
  ok: boolean;
  /** 逐查是否通过（true = 该查无违例）。 */
  checks: Record<AuditDeclarationCheck, boolean>;
  /** 解析出的申报行（块级格式故障时为空——没有可解析的块就没有申报）。 */
  lines: readonly AuditDeclarationLine[];
  /** 回复（申报块外）提取到的金额值（extractAmounts 口径，按值去重）。 */
  amounts: readonly number[];
  /** 逐条违例（顺序 = 五查列举序）。 */
  findings: readonly AuditDeclarationFinding[];
}

// ── 封闭语法 ──

/** 数字：可选负号 + 整数或小数。封闭格式里就这一种数字形态（千分位/单位缩放一律不收）。 */
const NUMBER_SOURCE = '-?\\d+(?:\\.\\d+)?';
/** 引用行：`500 <- rec-101`。两侧空白任意（含零）。 */
const REFERENCE_LINE_RE = new RegExp(`^(${NUMBER_SOURCE})\\s*<-\\s*(\\S+)$`);
/** 运算行：`1000 := 500 + 300 + 200`。RHS 单独校验（括号/乘除/运算词在此关外）。 */
const OPERATION_LINE_RE = new RegExp(`^(${NUMBER_SOURCE})\\s*:=\\s*(.+)$`);
/** RHS 只认 `数 (op 数)+` 的 + / - 链——至少一个运算符（"链"），乘除/括号/运算词一律不匹配。 */
const OPERATION_RHS_RE = new RegExp(`^${NUMBER_SOURCE}(?:\\s*[+-]\\s*${NUMBER_SOURCE})+$`);
const NUMBER_RE = new RegExp(NUMBER_SOURCE, 'g');
/**
 * 开标记必须**独占行首**（该行在它之前只有空白）、闭标记必须**独占行尾**（该行在它之后
 * 只有空白）。标记夹在句子中间是**正文**，不是块分界——申报指令本身含这两个字面标记
 * （"以 [audit] 开始、以 [/audit] 结束"），模型复述指令时它们随句子进正文；若按字面出现
 * 当分界，合法的无数字轮会被判成「块内正文 malformed」（两个标记都复述）、「块未闭合」
 * （只复述开标记）、或「正文被吞进块、数字逃过覆盖查 + malformed 行」（两个标记夹住真实
 * 正文）——三种都是假红（D-207 未决二⑦）。一行式块仍成立：`[audit] 500 <- rec-101
 * [/audit]` 的开标记在行首、闭标记在行尾，块内容照解析。
 */
const AUDIT_OPEN_LINE_RE = /(?:^|\n)[^\S\r\n]*\[audit\]/g;
const AUDIT_CLOSE_LINE_RE = /\[\/audit\][^\S\r\n]*(?=\r?\n|$)/g;
const AUDIT_OPEN_TOKEN = '[audit]';
const AUDIT_CLOSE_TOKEN = '[/audit]';

interface BlockScan {
  /** 唯一且闭合完好的申报块内容；null = 没有可解析的块（缺块/未闭合/多个/顺序颠倒）。 */
  content: string | null;
  /** 块级格式故障的 note 文案（null = 块级无恙）。 */
  blockFault: string | null;
  /** 剥掉申报块后的回复正文——覆盖检查的数字来源（块内数字不算"回复里的数字"）。 */
  prose: string;
}

/**
 * 扫描申报块。块级只认「恰好一个行首 `[audit]` + 恰好一个行尾 `[/audit]` 且开在闭前」：
 * 缺块、未闭合、多个块、顺序颠倒都记 blockFault 且**不解析任何行**——没有可解析的块就
 * 没有申报，覆盖/幻影源/值不符/运算闭合随之无对象可查（格式查一条 note 说清根因，
 * 不把同一根因摊成五条）。块级故障时 `prose` = 全文（没有可认定的块，就没有"块外正文"）。
 */
function scanAuditBlock(reply: string): BlockScan {
  const opens = [...reply.matchAll(AUDIT_OPEN_LINE_RE)].map((m) => {
    const end = (m.index ?? 0) + m[0].length;
    return { start: end - AUDIT_OPEN_TOKEN.length, end };
  });
  const closes = [...reply.matchAll(AUDIT_CLOSE_LINE_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const block = opens.length === 1 && closes.length === 1 && opens[0]!.end <= closes[0]!.start
    ? { start: opens[0]!.start, end: closes[0]!.end }
    : null;
  const prose = block ? reply.slice(0, block.start) + reply.slice(block.end) : reply;
  if (opens.length === 0 && closes.length === 0) return { content: null, blockFault: null, prose };
  if (opens.length === 0) {
    return { content: null, blockFault: '申报块格式：回复有 [/audit] 没有 [audit] 申报块', prose };
  }
  if (closes.length === 0) {
    return { content: null, blockFault: '申报块格式：块未闭合——回复有 [audit] 没有 [/audit]', prose };
  }
  if (opens.length > 1 || closes.length > 1) {
    return {
      content: null,
      blockFault: `申报块格式：回复出现 ${opens.length} 个 [audit] 与 ${closes.length} 个 [/audit]（封闭格式只允许一个申报块）`,
      prose,
    };
  }
  if (!block) {
    return { content: null, blockFault: '申报块格式：标记顺序颠倒——[/audit] 出现在 [audit] 之前', prose };
  }
  return { content: reply.slice(block.start + AUDIT_OPEN_TOKEN.length, closes[0]!.start), blockFault: null, prose };
}

/**
 * 解析申报块内的行。逐行只认两种封闭形态，其余一律 malformed（交给格式查）：
 *   · 引用行 `值 <- 记录号`（记录号是非空白串，`rec 101` 这类带空格的不认）；
 *   · 运算行 `值 := 数 + 数 …`（RHS 必须过 + / - 链校验：括号、乘除、运算词、
 *     `1000 :=` 空右值、`500 + 300` 缺 `:=` 全是 malformed）。
 * 空行跳过（封闭格式里的排版空白，不是违例）。
 */
function parseDeclarationLines(content: string): { lines: AuditDeclarationLine[]; malformed: string[] } {
  const lines: AuditDeclarationLine[] = [];
  const malformed: string[] = [];
  for (const raw of content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)) {
    const ref = raw.match(REFERENCE_LINE_RE);
    if (ref) {
      const value = Number(ref[1]);
      const record = ref[2];
      if (Number.isFinite(value) && record) {
        lines.push({ kind: 'reference', value, ref: record, raw });
        continue;
      }
      malformed.push(raw);
      continue;
    }
    const op = raw.match(OPERATION_LINE_RE);
    if (op) {
      const value = Number(op[1]);
      const rhs = (op[2] ?? '').trim();
      if (Number.isFinite(value) && OPERATION_RHS_RE.test(rhs)) {
        const addends = [...rhs.matchAll(NUMBER_RE)].map((m) => Number(m[0]));
        lines.push({ kind: 'operation', value, addends, raw });
        continue;
      }
    }
    malformed.push(raw);
  }
  return { lines, malformed };
}

// ── 事实基准 ──

/**
 * 审计行 → 记录号事实表：`记录号 → 该号在 result.items 里出现过的全部可核数值`。
 * 匹配按契约的字面读法——记录号**出现在 result.items 里**（id 或 name 命中均可，
 * stock 夹具的域字段投影成 name/value，只认 id 会把它整个判成幻影源）。数值收集跨
 * 全部审计行（"任何审计行"，与幻影源查同域）；同一行里同一个号只收一次。
 */
function collectRecordFacts(rows: readonly ExecutionAuditRow[]): Map<string, number[]> {
  const facts = new Map<string, number[]>();
  for (const row of rows) {
    const items = Array.isArray(row.result?.items) ? row.result!.items! : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const key of [item.id, item.name]) {
        if (typeof key !== 'string' || key.length === 0) continue;
        const bucket = facts.get(key) ?? [];
        if (typeof item.value === 'number' && Number.isFinite(item.value) && !bucket.includes(item.value)) {
          bucket.push(item.value);
        }
        facts.set(key, bucket);
      }
    }
  }
  return facts;
}

/**
 * 加数闭合表：哪些**值**有申报行可依，且若那是运算行则递归到引用行（D-206 五查之运算闭合）。
 *
 * 按值做最小不动点，而不是按行下标做深度优先展开：同值互引的病态块（k 条同值运算行）会让
 * 按行下标的搜索摊成 O(2^k)——真实块远小于此，但探针的 note 计算是同步的，一块病态申报
 * 能把整轮挂住（D-207 未决二⑧）。不动点语义与按行下标搜索同构：
 *   · 有引用行的值直接闭合；
 *   · 运算行的值闭合 ⇔ 它的每个加数都闭合。
 * 自引用环因此不闭合——"1000 := 1000 + 500" 的 1000 只有自己这一行可依，不动点永远推不到
 * 它（与旧实现的 used 集合同结论：递归到不了引用行）。同一行可同时给两个加数作依据
 * （"1000 := 500 + 500" 配一条 `500 <- rec-101` 是闭合的）——不动点按值判定，天然如此。
 */
function closingValues(lines: readonly AuditDeclarationLine[]): Set<number> {
  const closed = new Set<number>();
  for (const line of lines) {
    if (line.kind === 'reference') closed.add(line.value);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const line of lines) {
      if (line.kind !== 'operation' || closed.has(line.value)) continue;
      if (line.addends.every((addend) => closed.has(addend))) {
        closed.add(line.value);
        grew = true;
      }
    }
  }
  return closed;
}

/** note 回显的回复摘要（探针同款：截断不省略，长回复不刷屏）。 */
function snippet(reply: string): string {
  return reply.slice(0, 80);
}

// ── 五查交叉核 ──

/**
 * 结构化判定（供测试与报告）。窄形状：五查逐条布尔 + 解析出的申报行 + 违例清单；
 * 不做聚合、不读盘、不跑模型。
 */
export function classifyAuditDeclaration(
  reply: string,
  auditRows: readonly ExecutionAuditRow[],
): AuditDeclarationVerdict {
  const scan = scanAuditBlock(reply);
  const parsed = scan.content === null
    ? { lines: [] as AuditDeclarationLine[], malformed: [] as string[] }
    : parseDeclarationLines(scan.content);
  // 「回复里的数字」= 申报块之外的**金额**（extractAmounts 口径：金额形态的数字，标识符尾段/
  // 年份/window 码已排除）+ 文件惯例的零值排除。复用生产提取器而不是另养一份——两份形态学
  // 不同会让这里看不见生产侧的漏判（amount-criteria.test.ts 顶部记着这个坑）。
  // 零值排除与 amount-criteria 错误态路径（:429 `if (amount.value === 0) continue`）和
  // expectations 的 valuesIn（同款过滤）同口径：0/0.00 是平台回复的格式噪声，不是金额。
  // 不排除的后果：独立 0 会被提取，而夹具没有任何记录值为 0 ⇒ 诚实的 `0 <- rec-NNN` 永远
  // 栽在值不符上，无成功查询的轮次连 `0 := 500 - 500` 都写不出来——合法「0 results」式回复
  // 只能假红（D-207 未决二①）。
  const amounts = extractAmounts(scan.prose).map((amount) => amount.value).filter((value) => value !== 0);
  const facts = collectRecordFacts(auditRows);
  const findings: AuditDeclarationFinding[] = [];

  // ── 覆盖：回复里每个数字都有申报行（引用或运算）──
  // 只在块可解析时查：块缺/坏时格式查已判红（同一根因一条 note，不摊成五条）。
  if (scan.content !== null) {
    const declared = new Set(parsed.lines.map((line) => line.value));
    for (const value of amounts) {
      if (declared.has(value)) continue;
      findings.push({
        check: 'coverage',
        subject: String(value),
        note: `申报覆盖缺口：回复里的数字 ${value} 没有对应申报行（引用或运算）：「${snippet(reply)}」`,
      });
    }
  }

  // ── 幻影源 + 值不符（都只对引用行；幻影即止，不把同一记录号摊成两条）──
  for (const line of parsed.lines) {
    if (line.kind !== 'reference') continue;
    const known = facts.has(line.ref);
    if (!known) {
      findings.push({
        check: 'phantomSource',
        subject: line.ref,
        note: `申报幻影源：记录号 ${line.ref} 不在任何审计行 result.items 里（申报值 ${line.value}）`,
      });
      continue;
    }
    const values = facts.get(line.ref) ?? [];
    if (!values.includes(line.value)) {
      const actual = values.length > 0 ? values.join(' / ') : '（该记录没有可核的数值）';
      findings.push({
        check: 'valueMismatch',
        subject: line.ref,
        note: `申报值不符：记录号 ${line.ref} 申报 ${line.value}，result.items 里是 ${actual}`,
      });
    }
  }

  // ── 运算闭合：:= 右侧每个数都有申报行（递归到引用行）；不验算 ──
  if (parsed.lines.some((line) => line.kind === 'operation')) {
    const closed = closingValues(parsed.lines);
    for (const line of parsed.lines) {
      if (line.kind !== 'operation') continue;
      for (const addend of line.addends) {
        if (closed.has(addend)) continue;
        findings.push({
          check: 'operationClosure',
          subject: String(addend),
          note: `申报运算不闭合：${line.value} := … 的加数 ${addend} 没有申报行（递归到引用行）：「${line.raw}」`,
        });
      }
    }
  }

  // ── 格式：块级故障 / 有数字但缺块 / 行不可解析 ──
  if (scan.blockFault !== null) {
    findings.push({ check: 'format', subject: 'block', note: scan.blockFault });
  } else if (scan.content === null && amounts.length > 0) {
    findings.push({
      check: 'format',
      subject: 'block',
      note: `回复有数字但没有 [audit] 申报块：「${snippet(reply)}」`,
    });
  }
  for (const raw of parsed.malformed) {
    findings.push({ check: 'format', subject: raw, note: `申报块有不可解析的行：「${raw}」` });
  }

  const checks = Object.fromEntries(
    AUDIT_DECLARATION_CHECKS.map((check) => [check, !findings.some((finding) => finding.check === check)]),
  ) as Record<AuditDeclarationCheck, boolean>;
  return { ok: findings.length === 0, checks, lines: parsed.lines, amounts, findings };
}

/**
 * 逐轮 note 文案（探针接线用）。与结构化判定同源——`classifyAuditDeclaration` 的 findings
 * 原序，一条违例一句 note，风格对齐 probe 现有 note（说清哪条检查不过、涉及哪个数/哪个
 * 记录号）。
 */
export function auditDeclarationNotes(
  reply: string,
  auditRows: readonly ExecutionAuditRow[],
): string[] {
  return classifyAuditDeclaration(reply, auditRows).findings.map((finding) => finding.note);
}

/**
 * 答案正文 = 剥掉申报块的回复。申报块是**机器 annex**（harness 注入指令换来的结构化申报），
 * 不是答案本身：期望值层（expectations.ts）判"该报什么"与误差判定的分句核对都要看正文，
 * 否则只在块里出现的申报值会改价值集合判定、块行里的记录号会让金额凭空"有所属"
 * （D-207 未决一）。块级故障（多个/未闭合/顺序颠倒）时没有可认定的块 ⇒ 原样返回——
 * 那种轮次格式查已经判红，不在这里二次猜。
 *
 * 与 scanAuditBlock 同源（prose 就是它算的），不另写一份标记匹配——两份标记形态学会漂移。
 */
export function stripAuditDeclaration(reply: string): string {
  return scanAuditBlock(reply).prose;
}
