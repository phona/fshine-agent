import { describe, expect, it } from 'vitest';
import { auditDeclarationNotes, classifyAuditDeclaration } from './audit-declaration';
import type { ExecutionAuditRow } from './evidence';

/**
 * audited 申报模式交叉核的表征锁（D-206 闭环判据第一块，PR #25 后的契约）。
 *
 * 钉两件事：
 *   ① 交叉核（覆盖/幻影源/值不符/运算闭合/算式不符/封闭命题/格式）每条至少一红一绿，
 *      且红的时候**只红那一条**（checks 逐条布尔 + findings 指认）——判据互相污染时这里
 *      必须看得见；
 *   ② 契约边界：`:=` 行按声明的 + / - 验算（"999 := 500 + 300 + 200" 实算 1000 ⇒ 红）、
 *      命题只认 nocaliber/notfound 两种（参数不闭合 ⇒ malformed）、解析器只认封闭语法
 *      （括号/乘除/运算词/空右值 malformed）、回复无数字则不要求有块、空回复全绿。
 *
 * 事实基准用审计行 result.items / result.status 的契约定死形状（evidence.ts 的
 * ExecutionAuditRow.result）：夹具侧由 audit-result.test.ts 与 fixtures/*.cjs 落地，
 * 本锁只消费形状，不等夹具完工。
 */

/** 审计行夹具：一次 query 的 result（契约形状：completed 带 items/count，三种状态都带 status）。 */
function queryRow(collection: string, result: ExecutionAuditRow['result']): ExecutionAuditRow {
  return { mode: 'query', script: 'dummy.query', args: ['--collection', collection], exitCode: 0, result };
}

function auditRows(items: Array<{ id: string; name?: string; value?: number }>): ExecutionAuditRow[] {
  return [queryRow('beta', { status: 'completed', items, count: items.length })];
}

/** beta 三条记录（dummy 夹具种子：rec-101/102/103 = 500/300/200）。 */
const BETA_ROWS = auditRows([
  { id: 'rec-101', name: 'beta-item-1', value: 500 },
  { id: 'rec-102', name: 'beta-item-2', value: 300 },
  { id: 'rec-103', name: 'beta-item-3', value: 200 },
]);

const ALL_GREEN = {
  coverage: true,
  phantomSource: true,
  valueMismatch: true,
  operationClosure: true,
  operationMismatch: true,
  proposition: true,
  format: true,
} as const;

/** 规范回复：每个数字都有申报行，申报行都核得上。 */
const CANONICAL_PROSE = 'beta-item-1 (rec-101) 是 500，beta-item-2 (rec-102) 是 300，beta-item-3 (rec-103) 是 200，合计 1000。';
const CANONICAL_BLOCK = '[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]';
const canonical = `${CANONICAL_PROSE}\n${CANONICAL_BLOCK}`;

function classify(reply: string, rows: readonly ExecutionAuditRow[] = BETA_ROWS) {
  return classifyAuditDeclaration(reply, rows);
}

describe('audited 申报交叉核：覆盖（回复里每个数字都有申报行）', () => {
  it('绿：规范回复——每个数字都有引用行或运算行', () => {
    const v = classify(canonical);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.checks).toEqual(ALL_GREEN);
  });

  it('红：合计数字没有申报行——只红覆盖这一条', () => {
    const reply = `${CANONICAL_PROSE}\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n[/audit]`;
    const v = classify(reply);
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('1000');
    expect(v.findings[0]!.note).toContain('数字 1000 没有对应申报行');
    expect(v.checks).toEqual({ ...ALL_GREEN, coverage: false });
  });

  it('绿：回复无数字——不要求有申报块', () => {
    const v = classify('好的，这次没有要报的数。');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('绿：空回复', () => {
    const v = classify('');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe('audited 申报交叉核：幻影源（申报的 rec 号不在任何审计行 result.items 里）', () => {
  it('红：记录号 rec-999 平台没拉回过——只红幻影源这一条', () => {
    const v = classify('beta-item-1 是 500。\n[audit]\n500 <- rec-999\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['phantomSource']);
    expect(v.findings[0]!.subject).toBe('rec-999');
    expect(v.findings[0]!.note).toContain('记录号 rec-999 不在任何审计行 result.items 里');
    expect(v.checks).toEqual({ ...ALL_GREEN, phantomSource: false });
  });

  it('绿：记录号在审计行 result.items 里', () => {
    expect(classify('beta-item-1 是 500。\n[audit]\n500 <- rec-101\n[/audit]').findings).toEqual([]);
  });

  it('红：回复无数字但申报了幻影源——申报本身照审计', () => {
    const v = classify('已查询。\n[audit]\n500 <- rec-999\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['phantomSource']);
    expect(v.checks.phantomSource).toBe(false);
  });
});

describe('audited 申报交叉核：值不符（申报值 ≠ result.items 里的 value）', () => {
  it('红：rec-101 真实 500、申报 600——只红值不符这一条', () => {
    const v = classify('beta-item-1 是 600。\n[audit]\n600 <- rec-101\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch']);
    expect(v.findings[0]!.subject).toBe('rec-101');
    expect(v.findings[0]!.note).toContain('记录号 rec-101 申报 600');
    expect(v.findings[0]!.note).toContain('500');
    expect(v.checks).toEqual({ ...ALL_GREEN, valueMismatch: false });
  });

  it('绿：申报值 = result.items 里的 value', () => {
    expect(classify('beta-item-1 是 500。\n[audit]\n500 <- rec-101\n[/audit]').findings).toEqual([]);
  });

  it('记录号也按 name 命中（stock 夹具域字段投影成 name/value）', () => {
    expect(classify('beta-item-1 是 500。\n[audit]\n500 <- beta-item-1\n[/audit]').findings).toEqual([]);
    const v = classify('beta-item-1 是 600。\n[audit]\n600 <- beta-item-1\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch']);
  });
});

describe('audited 申报交叉核：运算闭合（:= 右侧每个数都有申报行，递归到引用行）', () => {
  it('红：加数 500/300/200 没有申报行——只红运算闭合这一条', () => {
    const v = classify('合计 1000。\n[audit]\n1000 := 500 + 300 + 200\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure', 'operationClosure', 'operationClosure']);
    expect(v.findings.map((f) => f.subject)).toEqual(['500', '300', '200']);
    expect(v.findings[0]!.note).toContain('加数 500 没有申报行');
    expect(v.checks).toEqual({ ...ALL_GREEN, operationClosure: false });
  });

  it('绿：每个加数都有引用行', () => {
    expect(classify(canonical).findings).toEqual([]);
  });

  it('绿：加数由另一条运算行闭合（递归到引用行）', () => {
    const reply = '合计 1000。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n800 := 500 + 300\n1000 := 800 + 200\n[/audit]';
    expect(classify(reply).findings).toEqual([]);
  });

  it('红：自引用环——"200 := 100 + 100" 的 100 没有引用行可依（算式本身成立）', () => {
    const v = classify('[audit]\n200 := 100 + 100\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure', 'operationClosure']);
    expect(v.findings.map((f) => f.subject)).toEqual(['100', '100']);
    expect(v.checks).toEqual({ ...ALL_GREEN, operationClosure: false });
  });

  it('红：1000 := 500 + 500 配一条 `500 <- rec-101`——同一记录复用两次冒充合计', () => {
    const v = classify('合计 1000。\n[audit]\n500 <- rec-101\n1000 := 500 + 500\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('复用同一来源');
    expect(v.findings[0]!.note).toContain('只有 1 条记录值为 500');
  });

  it('绿：同值加数但审计事实有两条不同记录——不是同一记录复用', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 500 }]);
    const v = classify('合计 1000。\n[audit]\n500 <- rec-a\n500 <- rec-b\n1000 := 500 + 500\n[/audit]', rows);
    expect(v.findings).toEqual([]);
  });

  it('绿：零加数不是金额，不要求申报（200 := 500 - 300 + 0）', () => {
    const v = classify('合计 200。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 := 500 - 300 + 0\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.checks.operationClosure).toBe(true);
  });

  it('绿：`500 + -300` 的闭合源值是 300，不要求申报一条 -300 的记录', () => {
    const v = classify('合计 200。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 := 500 + -300\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.checks.operationClosure).toBe(true);
  });
});

describe('audited 申报算式验算：:= RHS 按声明的 + / - 求值必须等于 LHS', () => {
  it('绿：1000 := 500 + 300 + 200 实算相等', () => {
    const v = classify(canonical);
    expect(v.findings).toEqual([]);
    expect(v.checks.operationMismatch).toBe(true);
  });

  it('绿：400 := 500 - 300 + 200（运算符参与求值，负项照减）', () => {
    const reply = '合计 400。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n400 := 500 - 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('绿：首个操作数带负号——"-10 := -12.5 + 2.5" 只算一次领头负号', () => {
    const rows = auditRows([{ id: 'rec-101', value: -12.5 }, { id: 'rec-102', value: 2.5 }]);
    const reply = '[audit]\n-12.5 <- rec-101\n2.5 <- rec-102\n-10 := -12.5 + 2.5\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：999 := 500 + 300 + 200 实算 1000——只红算式不符这一条', () => {
    const reply = '合计 999。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n999 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings.map((f) => f.check)).toEqual(['operationMismatch']);
    expect(v.findings[0]!.subject).toBe('999');
    expect(v.findings[0]!.note).toContain('申报算式不符');
    expect(v.findings[0]!.note).toContain('1000');
    expect(v.checks).toEqual({ ...ALL_GREEN, operationMismatch: false });
  });

  it('绿：0.3 := 0.1 + 0.2 ——精确十进制相等，JS 浮点误差不判红', () => {
    const rows = auditRows([{ id: 'rec-a', value: 0.1 }, { id: 'rec-b', value: 0.2 }]);
    const v = classify('合计 0.3。\n[audit]\n0.1 <- rec-a\n0.2 <- rec-b\n0.3 := 0.1 + 0.2\n[/audit]', rows);
    expect(v.findings).toEqual([]);
    expect(v.checks.operationMismatch).toBe(true);
  });

  it('红：1000 := 500 - 300 + 200 实算 400——不按无符号和 1000 放行', () => {
    const reply = '合计 1000。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 - 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings.map((f) => f.check)).toEqual(['operationMismatch']);
    expect(v.findings[0]!.note).toContain('400');
  });
});

describe('audited 封闭命题：nocaliber / notfound 必须与审计行事实一致', () => {
  it('绿：nocaliber(beta, payable)——caliber 不是查询结果 items 的字段名', () => {
    const v = classify('平台没有 payable 这个口径。\n[audit]\nnocaliber(beta, payable)\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：nocaliber(beta, value)——value 恰是 items 字段名，命题为假', () => {
    const v = classify('平台没有 value 这个口径。\n[audit]\nnocaliber(beta, value)\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['proposition']);
    expect(v.findings[0]!.subject).toBe('nocaliber(beta, value)');
    expect(v.findings[0]!.note).toContain('申报命题不符');
    expect(v.findings[0]!.note).toContain('value');
    expect(v.checks).toEqual({ ...ALL_GREEN, proposition: false });
  });

  it('绿：notfound(gamma)——审计行记录该 collection 最近一次查询状态是 not_found', () => {
    const v = classify('gamma 没找到。\n[audit]\nnotfound(gamma)\n[/audit]', [queryRow('gamma', { status: 'not_found' })]);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：notfound(beta)——beta 最近一次查询是 completed，命题为假', () => {
    const v = classify('beta 没找到。\n[audit]\nnotfound(beta)\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['proposition']);
    expect(v.findings[0]!.note).toContain('申报命题不符');
    expect(v.findings[0]!.note).toContain('completed');
  });

  it('红：notfound(gamma)——needs_input 不是 not_found', () => {
    const v = classify('gamma 没找到。\n[audit]\nnotfound(gamma)\n[/audit]', [queryRow('gamma', { status: 'needs_input' })]);
    expect(v.findings.map((f) => f.check)).toEqual(['proposition']);
    expect(v.findings[0]!.note).toContain('needs_input');
  });

  it('红：命题没有该 collection 的查询审计行——无据可核，fail-closed', () => {
    const v = classify('gamma 没找到。\n[audit]\nnotfound(gamma)\nnocaliber(gamma, payable)\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['proposition', 'proposition']);
    expect(v.findings.every((f) => f.note.includes('无据可核'))).toBe(true);
  });

  it('红：nocaliber 只有空字段证据（not_found / completed items:[]）⇒ fail-closed', () => {
    const rows = [
      queryRow('gamma', { status: 'not_found' }),
      queryRow('empty', { status: 'completed', items: [], count: 0 }),
    ];
    const v = classify('已查询。\n[audit]\nnocaliber(gamma, payable)\nnocaliber(empty, payable)\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['proposition', 'proposition']);
    expect(v.findings.every((f) => f.note.includes('没有字段证据'))).toBe(true);
  });

  it('红：nocaliber 用平台原始字段名核——stock 的 sku 被投影成 name 也仍是真实字段', () => {
    const rows = [queryRow('north', {
      status: 'completed',
      items: [{ id: 'rec-001', name: 'north-item-1', value: 1200 }],
      count: 1,
      fields: ['id', 'sku', 'qty'],
    })];
    const v = classify('没有 sku 口径。\n[audit]\nnocaliber(north, sku)\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['proposition']);
    expect(v.findings[0]!.note).toContain('sku');
    expect(classify('没有 payable 口径。\n[audit]\nnocaliber(north, payable)\n[/audit]', rows).findings).toEqual([]);
  });

  it('结构化调用参数（Record）同样参与 collection 核对：notfound 取最近一次查询', () => {
    const rows: ExecutionAuditRow[] = [
      { mode: 'query', script: 'dummy.query', args: { '--collection': 'gamma' }, exitCode: 0, result: { status: 'completed', items: [{ id: 'rec-1', value: 1 }], count: 1 } },
      { mode: 'query', script: 'dummy.query', args: { '--collection': 'gamma' }, exitCode: 0, result: { status: 'not_found' } },
    ];
    expect(classify('gamma 没找到。\n[audit]\nnotfound(gamma)\n[/audit]', rows).findings).toEqual([]);
    // 旧数组行 + 新结构化行混排时，"最近一次"按落账顺序看得到结构化查询。
    const mixed: ExecutionAuditRow[] = [
      { mode: 'query', script: 'dummy.query', args: ['--collection', 'delta'], exitCode: 0, result: { status: 'not_found' } },
      { mode: 'query', script: 'dummy.query', args: { '--collection': 'delta' }, exitCode: 0, result: { status: 'completed', items: [{ id: 'rec-2', value: 2 }], count: 1 } },
    ];
    expect(classify('delta 没找到。\n[audit]\nnotfound(delta)\n[/audit]', mixed).findings.map((f) => f.check)).toEqual(['proposition']);
  });

  it('红：命题行不可解析 ⇒ malformed（少参/多参/空参/错形态）', () => {
    for (const line of [
      'nocaliber(beta)',              // 少参
      'nocaliber(beta, payable, x)',  // 多参
      'nocaliber(beta,)',             // 空参
      'notfound(beta, payable)',      // 多参
      'notfound()',                   // 空参
      'nocaliber beta, payable',      // 缺括号
      'NOCALIBER(beta, payable)',     // 名字大小写不认
      'nomedger(beta)',               // 第三种命题不发明
    ]) {
      const v = classify(`已查询。\n[audit]\n${line}\n[/audit]`);
      expect(v.checks.format, line).toBe(false);
      expect(v.findings.some((f) => f.check === 'format' && f.note.includes(line)), line).toBe(true);
    }
  });
});

describe('audited 申报交叉核：格式（有数字但没有审计块，或行不可解析）', () => {
  it('红：有数字但没有 [audit] 申报块——只红格式这一条', () => {
    const v = classify(CANONICAL_PROSE);
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.note).toContain('没有 [audit] 申报块');
    expect(v.checks).toEqual({ ...ALL_GREEN, format: false });
  });

  it('红：申报块有不可解析的行——只红格式这一条', () => {
    const v = classify('beta-item-1 是 500。\n[audit]\n500 <- rec-101\noops\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.subject).toBe('oops');
    expect(v.findings[0]!.note).toContain('不可解析的行');
    expect(v.checks).toEqual({ ...ALL_GREEN, format: false });
  });

  it('红：:= 右侧只认 + / - 链——括号/乘除/运算词/空右值/单数右值/缺 := 一律 malformed', () => {
    for (const line of [
      '1000 := (500 + 300) + 200',   // 括号
      '1000 := 500 * 300',           // 乘
      '1000 := 500 × 300',           // 全角乘
      '1000 := 500 plus 300',        // 运算词
      '1000 := 500 / 200',           // 除
      '1000 :=',                     // 空右值
      '1000 := 500',                 // 单数右值（不是链）
      '500 + 300',                   // 缺 := 也不是引用行
      '500 => rec-101',              // 错箭头
      '500 <- rec 101',              // 记录号带空格
      '500 <-- rec-101',             // 错箭头（双横）
    ]) {
      const v = classify(`beta-item-1 是 500。\n[audit]\n500 <- rec-101\n${line}\n[/audit]`);
      expect(v.checks.format, line).toBe(false);
      expect(v.findings.some((f) => f.check === 'format' && f.note.includes(line)), line).toBe(true);
    }
  });

  it('红：块未闭合（有 [audit] 没有 [/audit]）', () => {
    const v = classify('beta-item-1 是 500。\n[audit]\n500 <- rec-101');
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.note).toContain('未闭合');
  });

  it('红：多个申报块（封闭格式只允许一个）', () => {
    const v = classify('beta-item-1 是 500。\n[audit]\n500 <- rec-101\n[/audit]\n[audit]\n500 <- rec-102\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.note).toContain('只允许一个申报块');
  });

  it('红：闭合标记顺序颠倒', () => {
    const v = classify('beta-item-1 是 500。\n[/audit]\n500 <- rec-101\n[audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.note).toContain('顺序颠倒');
  });
});

describe('audited 申报契约边界', () => {
  it(':= 行验算——"999 := 500 + 300 + 200" 实算 1000 ⇒ 红「申报算式不符」', () => {
    const reply = '合计 999。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n999 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings.map((f) => f.check)).toEqual(['operationMismatch']);
    expect(v.findings[0]!.note).toContain('申报算式不符');
    expect(v.ok).toBe(false);
  });

  it('块内数字不算"回复里的数字"——无正文数字时引用行不触发覆盖缺口', () => {
    const v = classify('已查询。\n[audit]\n500 <- rec-101\n300 <- rec-102\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.amounts).toEqual([]);
  });

  it('空申报块 + 有正文数字：覆盖缺口照红（块在册但什么都没申报）', () => {
    const v = classify('合计 1000。\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.checks).toEqual({ ...ALL_GREEN, coverage: false });
  });

  it('note 与结构化判定同源（auditDeclarationNotes = findings 原序）', () => {
    const reply = '合计 1000。\n[audit]\n1000 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(auditDeclarationNotes(reply, BETA_ROWS)).toEqual(v.findings.map((f) => f.note));
  });

  it('负数与小数按封闭语法收（值不符仍照核）', () => {
    const rows = auditRows([{ id: 'rec-101', name: 'beta-item-1', value: -12.5 }]);
    expect(classify('调整后是 -12.5。\n[audit]\n-12.5 <- rec-101\n[/audit]', rows).findings).toEqual([]);
    const v = classify('调整后是 -13.5。\n[audit]\n-13.5 <- rec-101\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch']);
  });
});

/**
 * 指令复述的假红锁（2026-11-09 独立评审）：申报指令本身含字面 `[audit]`/`[/audit]`
 * （"以 [audit] 开始、以 [/audit] 结束"），模型复述指令时这两个标记随句子进**正文**。
 * 分界只认「开标记独占行首 + 闭标记独占行尾」，所以复述不构成块——否则合法的无数字轮会被
 * 判成 malformed / 未闭合 / 正文被吞进块（数字逃过覆盖查）。
 */
describe('audited 申报契约边界：正文里复述指令标记不是申报块', () => {
  it('两个标记都在句中被复述 + 无正文数字：全绿（不判 malformed）', () => {
    const v = classify('我会追加 [audit] 申报块，以 [/audit] 结束。本轮没有具体数字。');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('只复述开标记 + 无正文数字：全绿（不判"块未闭合"）', () => {
    const v = classify('我会在末尾追加 [audit] 申报块。本轮没有具体数字。');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('两个标记夹住真实正文（句子中间）：正文不被吞进块，真块照解析', () => {
    const reply = [
      '我会追加 [audit] 申报块：beta-item-1 是 500，合计 1000。以 [/audit] 结束。',
      '[audit]',
      '500 <- rec-101',
      '300 <- rec-102',
      '200 <- rec-103',
      '1000 := 500 + 300 + 200',
      '[/audit]',
    ].join('\n');
    const v = classify(reply);
    // 正文里的 500/1000 由真块申报；复述句里的标记既不当分界也不产生 malformed 行。
    expect(v.findings).toEqual([]);
    expect(v.lines.flatMap((line) => (line.kind === 'proposition' ? [] : [line.value]))).toEqual([500, 300, 200, 1000]);
    expect(v.amounts).toEqual([500, 1000]);
  });

  it('一行式块仍成立（开标记行首 + 闭标记行尾，块内容照解析）', () => {
    const v = classify('beta-item-1 是 500。\n[audit] 500 <- rec-101 [/audit]');
    expect(v.findings).toEqual([]);
    expect(v.lines).toHaveLength(1);
  });

  it('复述标记 + 有正文数字 + 没有真块：照红"有数字但没有申报块"（不是格式故障文案）', () => {
    const v = classify('我会追加 [audit] 申报块。beta-item-1 是 500。');
    expect(v.findings.map((f) => f.check)).toEqual(['format']);
    expect(v.findings[0]!.note).toContain('没有 [audit] 申报块');
  });
});

/**
 * 覆盖口径与文件惯例对齐（2026-11-09 独立评审）：独立 0 是平台回复的格式噪声，不是金额
 * （amount-criteria 错误态路径 `if (amount.value === 0) continue` 与 expectations 的 valuesIn
 * 同款）。夹具没有任何记录值为 0 ⇒ 诚实的 `0 <- rec-NNN` 永远栽在值不符上、无成功查询的
 * 轮次连 `0 := 500 - 500` 都写不出来；覆盖查要求它 = 合法「0 results」式回复假红。
 */
describe('audited 申报契约边界：独立 0 不进覆盖要求', () => {
  it('绿：正文"0 results" + 没有申报块（0 不是金额，不要求块）', () => {
    const v = classify('0 results found for that window. Try another name.');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('绿：正文"0 results" + 空申报块', () => {
    const v = classify('0 results\n[audit]\n[/audit]');
    expect(v.findings).toEqual([]);
  });

  it('红只剩值不符：申报 `0 <- rec-101`（记录真实 500）——申报本身照审计，但不要求申报 0', () => {
    const v = classify('0 results\n[audit]\n0 <- rec-101\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch']);
  });

  it('绿：运算行形态的 0 仍成立（加数锚到不同的真实记录）', () => {
    const v = classify('0 results\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n0 := 500 - 300 - 200\n[/audit]');
    expect(v.findings).toEqual([]);
  });

  it('红：0 := 500 - 500 是同一记录复用——0 不进覆盖不等于加数可以重复', () => {
    const v = classify('0 results\n[audit]\n500 <- rec-101\n0 := 500 - 500\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.note).toContain('复用同一来源');
  });
});

/**
 * 覆盖可被运算行 LHS 全额满足（2026-11-09 独立评审 + D-207 未决二⑥；本轮补算式验算后的
 * 残余面）："The total is 1000" 配 `1000 := 500 + 300 + 200` + 三条真实引用行仍然全绿——
 * 加数真实、算式内部成立，但 1000 平台从未返回过。机械层只能核「数 ← 记录值」与算式
 * 内部一致，核不了"这个结果值该不该报"；该残余归 judge。算式不成立（999 := …）本轮起
 * 由 operationMismatch 判红，不再是残余。
 */
describe('audited 申报契约边界：运算行 LHS 满足覆盖，算式内部一致', () => {
  it('绿：编造合计 1000 —— 加数锚到真实记录且算式成立即过机械门（"该不该报"归 judge）', () => {
    const reply = 'The total is 1000\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：加数都加不出来的 999 —— 算式不符（覆盖由 LHS 满足，不豁免验算）', () => {
    const reply = 'The total is 999\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n999 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings.map((f) => f.check)).toEqual(['operationMismatch']);
    expect(v.findings[0]!.subject).toBe('999');
  });

  it('红：合计没有申报行——只红覆盖这一条（运算行 LHS 是覆盖的唯一豁免形态）', () => {
    const v = classify('The total is 1000\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('1000');
  });
});

/**
 * 运算闭合的实现边界（2026-11-09 独立评审）：按**值**做最小不动点，不按行下标深度展开——
 * k 条同值运算行（无接地引用行）会把按行下标的搜索摊成 O(2^k)，探针的 note 计算是同步的，
 * 一块病态申报能把整轮挂住（实测：k=12 旧实现 200s 不终止；k=80 新实现 0ms）。
 */
describe('audited 申报契约边界：运算闭合按值不动点（同值互引不发散）', () => {
  /** 同值互引病态块：k 条 `200 := 100 + 100`（算式成立），没有任何引用行可接地。 */
  const pathological = (k: number): string => `[audit]\n${Array.from({ length: k }, () => '200 := 100 + 100').join('\n')}\n[/audit]`;
  /** 值为 100 的记录：接地引用行用。 */
  const HUNDRED_ROWS = auditRows([{ id: 'rec-hundred', name: 'hundred-item', value: 100 }]);

  it('k=80 同值互引（无接地）：判"不闭合"且立即返回（旧实现会挂住）', () => {
    const v = classify(pathological(80));
    expect(v.checks.operationClosure).toBe(false);
    expect(v.checks.operationMismatch).toBe(true); // 算式成立（200 = 100 + 100），红只来自闭合
    expect(v.findings.filter((f) => f.check === 'operationClosure')).toHaveLength(160); // 80 行 × 2 加数
  });

  it('k=40 同值互引 + 一条接地引用行：同一记录被 40 行各复用两次，判红且立即返回', () => {
    const v = classify(`[audit]\n100 <- rec-hundred\n${Array.from({ length: 40 }, () => '200 := 100 + 100').join('\n')}\n[/audit]`, HUNDRED_ROWS);
    expect(v.checks.operationClosure).toBe(false);
    expect(v.findings.filter((f) => f.check === 'operationClosure')).toHaveLength(40); // 一行一条复用
  });

  /**
   * 等价性锁：不动点实现与**改动前**的按行下标递归在"加数缺申报行"这一面上结论一致
   * （随机块含同值互引、自引用环、跨值互引、混合引用/运算行）。参考实现逐字复制改动前的
   * `addendClosesWith`——它是指纹，不是要复活的代码路径。复用检测是本轮新增判据，不在
   * 旧实现的结论面内，因此只比较"没有申报行"的 findings。
   */
  it('等价性：不动点与改动前的按行下标递归在随机块上同结论', () => {
    type RefLine = { kind: 'reference' | 'operation'; value: number; addends: readonly number[] };
    const refClosesWith = (addend: number, lines: readonly RefLine[], used: ReadonlySet<number>): boolean => {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.value !== addend || used.has(index)) continue;
        if (line.kind === 'reference') return true;
        const next = new Set(used);
        next.add(index);
        if (line.addends.every((inner) => refClosesWith(inner, lines, next))) return true;
      }
      return false;
    };
    // 确定性 PRNG（同种子同序列：测试不许靠运气）。
    let seed = 20261109;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const alphabet = [100, 200, 300, 400];
    for (let round = 0; round < 300; round += 1) {
      const lines: RefLine[] = [];
      const body: string[] = [];
      for (let i = 0; i < 1 + rand(6); i += 1) {
        const value = alphabet[rand(alphabet.length)]!;
        if (rand(3) === 0) {
          lines.push({ kind: 'reference', value, addends: [] });
          body.push(`${value} <- rec-${100 + i}`);
        } else {
          const addends = [alphabet[rand(alphabet.length)]!, alphabet[rand(alphabet.length)]!];
          lines.push({ kind: 'operation', value, addends });
          body.push(`${value} := ${addends[0]} + ${addends[1]}`);
        }
      }
      const reply = `合计 100\n[audit]\n${body.join('\n')}\n[/audit]`;
      const verdict = classify(reply, BETA_ROWS);
      const expected = lines.filter((line) => line.kind === 'operation')
        .flatMap((line) => line.addends.filter((addend) => !refClosesWith(addend, lines, new Set())));
      const actual = verdict.findings
        .filter((f) => f.check === 'operationClosure' && f.note.includes('没有申报行'))
        .map((f) => Number(f.subject));
      expect([...actual].sort((a, b) => a - b), reply).toEqual([...expected].sort((a, b) => a - b));
    }
  });
});
