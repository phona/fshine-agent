/**
 * audited 申报模式：封闭申报语法解析 + 「申报-事实」交叉核（D-206 闭环判据第一块，
 * owner 2026-11-09 裁定 + PR #25 后的契约）。
 *
 * **背景**：PR #25 删掉了 `clauseLedgerResult`——那个用正则从模型自由文本推断算式归属的
 * 解析器成了 19 轮 codex 审查的打地鼠现场。owner 裁定：机械层只做封闭世界查表，算式对错
 * 归 judge。正解是 eval 时注入调试提示词，让模型逐轮在回复末尾追加一段**封闭语法**的申报：
 *
 *   [audit]
 *   500 <- rec-101           ← 引用行：申报值 ← 记录号
 *   1000 := 500 + 300 + 200  ← 运算行：申报值 := 加数链（只认 + / - 链，RHS 实算必须等于申报值）
 *   nocaliber(beta, payable) ← 命题行：beta 的查询结果 items 没有 payable 这个字段
 *   notfound(gamma)          ← 命题行：gamma 的最近一次查询结果状态是 not_found
 *   [/audit]
 *
 * 本模块只做两件事：① 按封闭语法解析申报块（**不做任何自由文本推断**——clauseLedgerResult
 * 正是自由文本推断，不许以任何形式复活）；② 把申报与宿主持有的结构化事实（审计行
 * `result.items` / `result.status`）做交叉核，每条不过产出一条 note（判红）。
 *
 * 块分界只认**独占行首的 `[audit]` 与独占行尾的 `[/audit]`**：夹在句子中间的标记是正文
 * （模型复述申报指令的形态），不是分界——判据见 AUDIT_OPEN_LINE_RE 处。
 *
 * **交叉核**（不过 ⇒ 对应 note）：
 *   覆盖    —— 回复里每个数字都有申报行（引用或运算）；回复无数字则不要求有块；
 *   幻影源  —— 申报的 rec 号不出现在任何审计行 result.items 里；
 *   值不符  —— 申报值 ≠ 该记录在 result.items 里的 value；
 *   运算闭合 —— := 右侧每个数都有申报行（递归到引用行）；0 是格式噪声不是金额，不要求
 *              申报；同一加数值的出现次数不得超过审计事实里该值的不同记录数（同一记录
 *              不得在一次运算里复用两次冒充合计）；
 *   算式不符 —— := 右侧按声明的 + / - 精确十进制求值必须等于左侧（"999 := 500 + 300 +
 *              200" 实算 1000 ⇒ 红；"0.3 := 0.1 + 0.2" 十进制精确相等 ⇒ 绿——JS 浮点
 *              不参与判定）；
 *   封闭命题 —— `nocaliber(collection, caliber)`（caliber 不是该 collection 查询结果
 *              items 的字段名）与 `notfound(collection)`（该 collection 最近一次查询结果
 *              状态是 not_found）两种命题必须与审计行事实一致；只有这两种，不发明第三种。
 *              nocaliber 需要**非空字段证据**：not_found / needs_input / completed 但
 *              items 为空时字段集不可知，命题 fail-closed（不能从空结果断言"没有这个字段"）；
 *   格式    —— 有数字但没有审计块，或行不可解析（命题行参数不闭合也算 malformed）。
 *
 * **归属**：封闭世界查表是 fshine 通用机制（AGENTS.md 改动归属）；申报格式的注入与夹具
 * 落账在评测/执行层适配边界，不在本模块。本模块无 I/O、不跑模型，纯函数，可被单测直接 import
 * （与 amount-criteria.ts 同款抽法）。
 */
import { extractAmounts } from './amount-criteria';
import type { ExecutionAuditRow } from './evidence';

// ── 形状 ──

/** 交叉核的名字（判红时逐条可指认；顺序即 note 的产出序）。 */
export type AuditDeclarationCheck =
  | 'coverage'
  | 'phantomSource'
  | 'valueMismatch'
  | 'operationClosure'
  | 'operationMismatch'
  | 'proposition'
  | 'format';

export const AUDIT_DECLARATION_CHECKS: readonly AuditDeclarationCheck[] = [
  'coverage',
  'phantomSource',
  'valueMismatch',
  'operationClosure',
  'operationMismatch',
  'proposition',
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

/** 运算行：`值 := 数 + 数 …`。RHS 按声明的 + / - 求值，必须等于左侧申报值。 */
export interface AuditOperationLine {
  kind: 'operation';
  /** 申报的结果值（:= 左侧）。 */
  value: number;
  /** := 右侧的加数链（原顺序、保留字面符号——运算验算用）。 */
  addends: readonly number[];
  /**
   * 闭合查用的源值：首项按字面符号，后续项取操作数绝对值（"500 + -300" 说的是 300 这笔
   * 记录、不是一条 -300 的记录；"500 - 300" 同理）。零不进闭合要求（零不是金额）。
   */
  closureValues: readonly number[];
  /** := 右侧按声明运算符（+ / -，左结合）精确十进制求出的值——note 回显用。 */
  computed: number;
  /** 精确十进制比较：右侧实算是否等于左侧申报值（JS 浮点误差不参与判定）。 */
  arithmeticOk: boolean;
  /** := 右侧原文（note 回显用）。 */
  rhs: string;
  raw: string;
}

/** 封闭命题名（只认这两种，解析器不发明第三种）。 */
export type AuditPropositionName = 'nocaliber' | 'notfound';

/**
 * 命题行：不申报金额，申报一个可被审计行机械核对的封闭事实。
 *   · `nocaliber(collection, caliber)` —— caliber 不是该 collection 查询结果 items 的字段名；
 *   · `notfound(collection)`           —— 该 collection 最近一次查询结果状态是 not_found。
 */
export interface AuditPropositionLine {
  kind: 'proposition';
  name: AuditPropositionName;
  /** 参数（nocaliber = [collection, caliber]；notfound = [collection]）。 */
  args: readonly string[];
  raw: string;
}

export type AuditDeclarationLine = AuditReferenceLine | AuditOperationLine | AuditPropositionLine;

/** 一条违例（note 与结构化判定同源，供测试与报告分别消费）。 */
export interface AuditDeclarationFinding {
  check: AuditDeclarationCheck;
  /** 违例对象：数字（覆盖/值不符/运算闭合/算式不符）、记录号（幻影源）、命题原文或 'block'（块级格式）。 */
  subject: string;
  /** 逐轮 note 文案（探针 note 风格：说清哪条检查不过、涉及哪个数/哪个记录号）。 */
  note: string;
}

export interface AuditDeclarationVerdict {
  /** 交叉核全过 = 申报与事实一致（回复无数字时无块也过）。 */
  ok: boolean;
  /** 逐查是否通过（true = 该查无违例）。 */
  checks: Record<AuditDeclarationCheck, boolean>;
  /** 解析出的申报行（块级格式故障时为空——没有可解析的块就没有申报）。 */
  lines: readonly AuditDeclarationLine[];
  /** 回复（申报块外）提取到的金额值（extractAmounts 口径，按值去重）。 */
  amounts: readonly number[];
  /** 逐条违例（顺序 = AUDIT_DECLARATION_CHECKS 列举序）。 */
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
/** 运算行 RHS 里的「运算符 + 数」项（求值用；数与运算符之间空白任意）。 */
const OPERATION_TERM_RE = new RegExp(`([+-])\\s*(${NUMBER_SOURCE})`, 'g');
const NUMBER_RE = new RegExp(NUMBER_SOURCE, 'g');
/**
 * 封闭命题行：只认 `nocaliber(collection, caliber)` 与 `notfound(collection)` 两种，
 * 参数是**非空白、不含逗号/括号**的字面量（记录号同款：带空格的参数不认）。参数个数
 * 写死在正则里——少参/多参/空参一律 malformed，解析器不发明第三种命题。
 */
const NOCALIBER_LINE_RE = /^nocaliber\(\s*([^,()\s]+)\s*,\s*([^,()\s]+)\s*\)$/;
const NOTFOUND_LINE_RE = /^notfound\(\s*([^,()\s]+)\s*\)$/;
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

/** 十进制字面量（value = units / 10^scale）。封闭语法只收有限小数，不用浮点求值。 */
interface DecimalValue {
  units: bigint;
  scale: number;
}

/** 解析封闭语法已接受的数值字面量（可选负号 + 整数/小数）；形态不对返回 null。 */
function parseDecimalLiteral(literal: string): DecimalValue | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(literal);
  if (!match) return null;
  const fraction = match[3] ?? '';
  const units = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`);
  return { units, scale: fraction.length };
}

function addDecimal(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = left.units * 10n ** BigInt(scale - left.scale);
  const rightUnits = right.units * 10n ** BigInt(scale - right.scale);
  return { units: leftUnits + rightUnits, scale };
}

function negateDecimal(value: DecimalValue): DecimalValue {
  return { units: -value.units, scale: value.scale };
}

function decimalEquals(left: DecimalValue, right: DecimalValue): boolean {
  const scale = Math.max(left.scale, right.scale);
  return left.units * 10n ** BigInt(scale - left.scale)
    === right.units * 10n ** BigInt(scale - right.scale);
}

function decimalToNumber(value: DecimalValue): number {
  return Number(value.units) / 10 ** value.scale;
}

/**
 * 按 RHS 里声明的运算符（+ / -，左结合）求值。只对已过 OPERATION_RHS_RE 的串调用；
 * 数字与运算符都是封闭字面量，没有优先级问题（纯 + / - 链）。求值用十进制整数
 * （units + scale）而不是 JS 浮点：0.1 + 0.2 在浮点下是 0.30000000000000004，会把
 * "0.3 := 0.1 + 0.2" 这种合法申报判成算式不符；也不引 epsilon——十进制精确相等不是
 * "差一点也算对"的口子，而是字面量的数学值比较。
 */
function evaluateOperationRhs(
  rhs: string,
  declared: DecimalValue,
): { addends: number[]; closureValues: number[]; computed: number; arithmeticOk: boolean } | null {
  const first = rhs.match(new RegExp(`^(${NUMBER_SOURCE})`));
  if (!first) return null;
  const firstLiteral = first[1]!;
  let total = parseDecimalLiteral(firstLiteral);
  if (!total) return null;
  const addends = [Number(firstLiteral)];
  // 首项按字面符号（"-12.5 + 2.5" 的 -12.5 是一笔负值记录）；后续操作数取绝对值作为
  // 闭合源值（"500 + -300" 与 "500 - 300" 说的都是 300 这笔记录）。
  const closureValues = [Number(firstLiteral)];
  // 从首个数字之后开始扫运算符项：NUMBER_SOURCE 自带可选负号，若从 0 开始扫，
  // "-12.5 + 2.5" 的领头负号会被当成减法再算一遍（首个数字因此单独取出）。
  const rest = rhs.slice(first[0].length);
  for (const term of rest.matchAll(OPERATION_TERM_RE)) {
    const operandLiteral = term[2]!;
    const operand = parseDecimalLiteral(operandLiteral);
    if (!operand) return null;
    addends.push(Number(operandLiteral));
    closureValues.push(Math.abs(Number(operandLiteral)));
    total = addDecimal(total, term[1] === '-' ? negateDecimal(operand) : operand);
  }
  return {
    addends,
    closureValues,
    computed: decimalToNumber(total),
    arithmeticOk: decimalEquals(total, declared),
  };
}

/**
 * 解析申报块内的行。逐行只认三种封闭形态，其余一律 malformed（交给格式查）：
 *   · 引用行 `值 <- 记录号`（记录号是非空白串，`rec 101` 这类带空格的不认）；
 *   · 运算行 `值 := 数 + 数 …`（RHS 必须过 + / - 链校验：括号、乘除、运算词、
 *     `1000 :=` 空右值、`500 + 300` 缺 `:=` 全是 malformed）；
 *   · 命题行 `nocaliber(collection, caliber)` / `notfound(collection)`（参数个数与
 *     形态写死；其它名字或参数不闭合的形态都是 malformed，不发明第三种命题）。
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
      const lhsLiteral = op[1]!;
      const value = Number(lhsLiteral);
      const declared = parseDecimalLiteral(lhsLiteral);
      const rhs = (op[2] ?? '').trim();
      if (Number.isFinite(value) && declared && OPERATION_RHS_RE.test(rhs)) {
        const evaluated = evaluateOperationRhs(rhs, declared);
        if (evaluated) {
          lines.push({ kind: 'operation', value, ...evaluated, rhs, raw });
          continue;
        }
      }
    }
    const nocaliber = raw.match(NOCALIBER_LINE_RE);
    if (nocaliber) {
      lines.push({ kind: 'proposition', name: 'nocaliber', args: [nocaliber[1]!, nocaliber[2]!], raw });
      continue;
    }
    const notfound = raw.match(NOTFOUND_LINE_RE);
    if (notfound) {
      lines.push({ kind: 'proposition', name: 'notfound', args: [notfound[1]!], raw });
      continue;
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
 * 加数闭合表：哪些**值**有申报行可依，且若那是运算行则递归到引用行（运算闭合查）。
 *
 * 按值做最小不动点，而不是按行下标做深度优先展开：同值互引的病态块（k 条同值运算行）会让
 * 按行下标的搜索摊成 O(2^k)——真实块远小于此，但探针的 note 计算是同步的，一块病态申报
 * 能把整轮挂住（D-207 未决二⑧）。不动点语义与按行下标搜索同构：
 *   · 有引用行的值直接闭合；
 *   · 运算行的值闭合 ⇔ 它的每个加数都闭合。
 * 自引用环因此不闭合——"1000 := 1000 + 500" 的 1000 只有自己这一行可依，不动点永远推不到
 * 它（与旧实现的 used 集合同结论：递归到不了引用行）。不动点按值判定，只回答"这个值有没有
 * 申报行可依"；**同一记录不得复用两次**由下面的 recordCountsByValue 在闭合之后另查
 * （"1000 := 500 + 500" 配一条 `500 <- rec-101` 虽然闭合，但只有一条 500 记录 ⇒ 红）。
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
      if (line.closureValues.filter((addend) => addend !== 0).every((addend) => closed.has(addend))) {
        closed.add(line.value);
        grew = true;
      }
    }
  }
  return closed;
}

/**
 * 审计事实里每个数值对应多少条**不同记录**。闭合查照值核对，但"同一记录复用两次冒充
 * 合计"（`1000 := 500 + 500` 配一条 `500 <- rec-101`）必须单列：值级不动点会让同一份
 * 来源同时给两个加数作依据。夹具种子值互异，同值两笔必然意味着同一记录被用两次（与
 * amount-criteria 的"加数互异/同一记录不复用"同口径）；换一个执行层后若确有多条同值
 * 记录，这里按不同记录数放行——不硬编码夹具形态。
 *
 * 逐 item 取身份（id 优先、退到 name），不用 collectRecordFacts 的键——那张表把同一
 * 记录的 id 与 name 都当键，会把自己的别名数成两条记录。
 */
function recordCountsByValue(rows: readonly ExecutionAuditRow[]): Map<number, number> {
  const recordsByValue = new Map<number, Set<string>>();
  for (const [rowIndex, row] of rows.entries()) {
    const items = Array.isArray(row.result?.items) ? row.result.items : [];
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.value !== 'number' || !Number.isFinite(item.value)) continue;
      const identity = typeof item.id === 'string' && item.id.length > 0
        ? item.id
        : typeof item.name === 'string' && item.name.length > 0
          ? item.name
          : `${row.ts ?? rowIndex}#${index}`;
      const records = recordsByValue.get(item.value) ?? new Set<string>();
      records.add(identity);
      recordsByValue.set(item.value, records);
    }
  }
  return new Map([...recordsByValue].map(([value, records]) => [value, records.size]));
}

/**
 * 命题的 collection 事实域：带 result 的审计行里，args 出现过该 collection 字面量的那些行。
 * args 是执行层自己的调用参数（dummy 的 `--collection`、stock 的 `--shelf`、ballot 的
 * `--topic`），本模块不解析具体 flag 名——**任何 flag 的值**等于命题里的 collection 就算
 * 该行查的是它（独立元素或 `--flag=value` 形态）。不硬编码 flag 名是层级纪律：换一个执行层
 * 后这条机制仍成立。带 result 的行 = query 类调用（completed / not_found / needs_input
 * 都落 result，见 evidence.ts 的 result 契约）。
 */
function queryRowsForCollection(rows: readonly ExecutionAuditRow[], collection: string): ExecutionAuditRow[] {
  return rows.filter((row) => {
    if (!row.result || typeof row.result !== 'object') return false;
    return argumentStrings(row.args).some((arg) => {
      if (arg === collection) return true;
      const eq = arg.indexOf('=');
      return eq > 0 && arg.startsWith('--') && arg.slice(eq + 1) === collection;
    });
  });
}

/**
 * 从审计行的调用参数里取全部字符串。`args` 的契约是 `unknown`：bash 路径落字符串数组
 * （`['--collection', 'beta']`），结构化路径可能落对象（`{'--collection': 'beta'}`，或
 * 嵌套数组）。只认数组会让另一种载体的命题全部变成"无据可核"假红，也会让 notfound 的
 * "最近一次"看不到新的结构化查询——这里只摊平字符串，不解析具体 flag 名（层级纪律：
 * 换一个执行层后这条机制仍成立）。
 */
function argumentStrings(args: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(args);
  return out;
}

/**
 * 一条 query 审计行的结果状态。旧日志（status 字段落地前）没有 status：带 items 的行按
 * completed 读，没有 items 也没 status 的行状态未知。
 */
function queryResultStatus(row: ExecutionAuditRow): 'completed' | 'not_found' | 'needs_input' | undefined {
  const status = row.result?.status;
  if (status === 'completed' || status === 'not_found' || status === 'needs_input') return status;
  return Array.isArray(row.result?.items) ? 'completed' : undefined;
}

/**
 * 该 collection 的查询结果字段名集合。**事实源优先用 `result.fields`**（夹具把平台原始
 * 数据的字段名随 query 响应落账）：stock 夹具的 items 按 value 核对契约投影成
 * { id, name, value }，只看 items 会让 `nocaliber(north, sku)` 假过——sku 正是被投影掉
 * 的原始字段。旧日志没有 fields 时才回退到 items 的键。
 *
 * 返回值 `null` = 没有可核的字段证据（该 collection 只有 not_found / needs_input，或
 * completed 但 items 为空）——此时"这个字段不存在"无法从空结果推出来，命题 fail-closed。
 * 跨该 collection 的全部查询行取并集：同一轮里先 not_found 后 completed 时，completed
 * 的字段仍是事实。
 */
function collectionFieldNames(rows: readonly ExecutionAuditRow[]): Set<string> | null {
  const fields = new Set<string>();
  for (const row of rows) {
    const declared = row.result?.fields;
    if (Array.isArray(declared) && declared.some((field) => typeof field === 'string' && field.length > 0)) {
      for (const field of declared) {
        if (typeof field === 'string' && field.length > 0) fields.add(field);
      }
      continue;
    }
    const items = Array.isArray(row.result?.items) ? row.result.items : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const key of Object.keys(item)) fields.add(key);
    }
  }
  return fields.size > 0 ? fields : null;
}

/** note 回显的回复摘要（探针同款：截断不省略，长回复不刷屏）。 */
function snippet(reply: string): string {
  return reply.slice(0, 80);
}

// ── 交叉核 ──

/**
 * 结构化判定（供测试与报告）。窄形状：交叉核逐条布尔 + 解析出的申报行 + 违例清单；
 * 不做聚合、不读盘、不跑模型。**findings 是唯一事实源**：每条违例只 append 一次，
 * `checks` 由它派生（不另开计数通路——评分侧按 findings 全量计数）。
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
  // 命题行不是金额申报，不参与覆盖（nocaliber/notfound 只申报"没有"什么）。
  if (scan.content !== null) {
    const declared = new Set(
      parsed.lines.flatMap((line) => (line.kind === 'proposition' ? [] : [line.value])),
    );
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

  // ── 运算闭合：:= 右侧每个数都有申报行（递归到引用行）──
  // 两件事同属"这个加数有没有可依的来源"：① 值级闭合（缺申报行）；② 同一记录的复用
  // （值级闭合只回答"有行可依"，`1000 := 500 + 500` 配一条 `500 <- rec-101` 会让同一份
  // 来源同时给两个加数作依据）。零不是金额，不进闭合要求。
  if (parsed.lines.some((line) => line.kind === 'operation')) {
    const closed = closingValues(parsed.lines);
    const recordCounts = recordCountsByValue(auditRows);
    for (const line of parsed.lines) {
      if (line.kind !== 'operation') continue;
      const occurrences = new Map<number, number>();
      for (const addend of line.closureValues) {
        if (addend === 0) continue;
        occurrences.set(addend, (occurrences.get(addend) ?? 0) + 1);
        if (closed.has(addend)) continue;
        findings.push({
          check: 'operationClosure',
          subject: String(addend),
          note: `申报运算不闭合：${line.value} := … 的加数 ${addend} 没有申报行（递归到引用行）：「${line.raw}」`,
        });
      }
      for (const [addend, count] of occurrences) {
        // 不闭合已经由上一段判红，这里只查"有来源但来源不够分给每个加数"的复用形态。
        // recordCounts 为 0 时（加数由另一条运算行闭合、审计事实里没有同值记录），
        // 至多允许出现一次；出现两次就是同一份派生账被复用。
        if (!closed.has(addend) || count <= Math.max(recordCounts.get(addend) ?? 0, 1)) continue;
        findings.push({
          check: 'operationClosure',
          subject: String(addend),
          note: `申报运算复用同一来源：${line.value} := … 的加数 ${addend} 出现 ${count} 次，`
            + `审计事实里只有 ${recordCounts.get(addend) ?? 0} 条记录值为 ${addend}——同一记录不得在一次运算里复用两次：「${line.raw}」`,
        });
      }
    }
  }

  // ── 算式不符：:= 右侧按声明的 + / - 求值必须等于左侧 ──
  // 与闭合查独立：加数没有申报行（不闭合）不豁免算式错，算式对也不豁免不闭合。
  // 比较用精确十进制（见 evaluateOperationRhs），0.1 + 0.2 不会因浮点误差假红。
  for (const line of parsed.lines) {
    if (line.kind !== 'operation' || line.arithmeticOk) continue;
    findings.push({
      check: 'operationMismatch',
      subject: String(line.value),
      note: `申报算式不符：「${line.raw}」按声明的 + / - 实算 ${line.computed}，与申报值 ${line.value} 不符`,
    });
  }

  // ── 封闭命题：nocaliber / notfound 必须与审计行事实一致 ──
  // 事实域 = args 里出现该 collection 的 query 审计行（见 queryRowsForCollection）。
  //   · notfound 按**最近一次**匹配行的 result.status 判（审计行按落账顺序；同轮先
  //     not_found 后重查 completed 时，过时的 not_found 命题不再成立）；
  //   · nocaliber 取匹配行 items 字段名的并集（completed 的字段仍是事实）；
  //   · 无匹配审计行 = 命题无事实可核，按 fail-closed 判红（"平台说没有"不能只靠模型自述）。
  for (const line of parsed.lines) {
    if (line.kind !== 'proposition') continue;
    const collection = line.args[0]!;
    const matches = queryRowsForCollection(auditRows, collection);
    if (line.name === 'notfound') {
      if (matches.length === 0) {
        findings.push({
          check: 'proposition',
          subject: line.raw,
          note: `申报命题无据可核：notfound(${collection}) 没有该 collection 的查询审计行（结果状态无处核对）`,
        });
        continue;
      }
      const status = queryResultStatus(matches[matches.length - 1]!);
      if (status !== 'not_found') {
        findings.push({
          check: 'proposition',
          subject: line.raw,
          note: `申报命题不符：notfound(${collection}) 但该 collection 最近一次查询结果状态是 ${status ?? '未知'}`,
        });
      }
      continue;
    }
    const caliber = line.args[1]!;
    if (matches.length === 0) {
      findings.push({
        check: 'proposition',
        subject: line.raw,
        note: `申报命题无据可核：nocaliber(${collection}, ${caliber}) 没有该 collection 的查询审计行（字段名集合无处核对）`,
      });
      continue;
    }
    const fields = collectionFieldNames(matches);
    if (fields === null) {
      findings.push({
        check: 'proposition',
        subject: line.raw,
        note: `申报命题无据可核：nocaliber(${collection}, ${caliber}) 的查询审计行没有字段证据（not_found / needs_input / 空 items）——不能从空结果断言"没有这个字段"`,
      });
      continue;
    }
    if (fields.has(caliber)) {
      findings.push({
        check: 'proposition',
        subject: line.raw,
        note: `申报命题不符：nocaliber(${collection}, ${caliber}) 但该 collection 查询结果 items 的字段名含「${caliber}」（字段名：${[...fields].join(' / ')}）`,
      });
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
