import { describe, expect, it } from 'vitest';
import { auditDeclarationNotes, classifyAuditDeclaration } from './audit-declaration';
import type { ExecutionAuditRow } from './evidence';

/**
 * audited 申报模式五查交叉核的表征锁（D-206 闭环判据第一块，PR #25 后的契约）。
 *
 * 钉两件事：
 *   ① 五查（覆盖/幻影源/值不符/运算闭合/格式）每条至少一红一绿，且红的时候**只红那一条**
 *      （checks 逐条布尔 + findings 指认）——判据互相污染时这里必须看得见；
 *   ② 契约边界：`:=` 行不验算（算式对错归 judge，PR #25 同契约）、解析器只认封闭语法
 *      （括号/乘除/运算词/空右值 malformed）、回复无数字则不要求有块、空回复全绿。
 *
 * 事实基准用审计行 result.items 的契约定死形状（evidence.ts 的 ExecutionAuditRow.result）：
 * 夹具侧由 audit-result.test.ts 与 fixtures/*.cjs 落地，本锁只消费形状，不等夹具完工。
 */

/** 审计行夹具：一次 query completed 的 result.items（契约形状）。 */
function auditRows(items: Array<{ id: string; name?: string; value?: number }>): ExecutionAuditRow[] {
  return [{ mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], exitCode: 0, result: { items, count: items.length } }];
}

/** beta 三条记录（dummy 夹具种子：rec-101/102/103 = 500/300/200）。 */
const BETA_ROWS = auditRows([
  { id: 'rec-101', name: 'beta-item-1', value: 500 },
  { id: 'rec-102', name: 'beta-item-2', value: 300 },
  { id: 'rec-103', name: 'beta-item-3', value: 200 },
]);

const ALL_GREEN = { coverage: true, phantomSource: true, valueMismatch: true, operationClosure: true, format: true } as const;

/** 规范回复：每个数字都有申报行，申报行都核得上。 */
const CANONICAL_PROSE = 'beta-item-1 (rec-101) 是 500，beta-item-2 (rec-102) 是 300，beta-item-3 (rec-103) 是 200，合计 1000。';
const CANONICAL_BLOCK = '[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]';
const canonical = `${CANONICAL_PROSE}\n${CANONICAL_BLOCK}`;

function classify(reply: string, rows: readonly ExecutionAuditRow[] = BETA_ROWS) {
  return classifyAuditDeclaration(reply, rows);
}

describe('audited 申报五查：覆盖（回复里每个数字都有申报行）', () => {
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

describe('audited 申报五查：幻影源（申报的 rec 号不在任何审计行 result.items 里）', () => {
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

describe('audited 申报五查：值不符（申报值 ≠ result.items 里的 value）', () => {
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

describe('audited 申报五查：运算闭合（:= 右侧每个数都有申报行，递归到引用行）', () => {
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

  it('红：自引用环——"1000 := 1000 + 500" 的 1000 只有自己可依', () => {
    const v = classify('合计 1000。\n[audit]\n500 <- rec-101\n1000 := 1000 + 500\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('1000');
  });
});

describe('audited 申报五查：格式（有数字但没有审计块，或行不可解析）', () => {
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
  it(':= 行不验算——"999 := 500 + 300 + 200" 实算 1000 也全绿（算式对错归 judge，PR #25 同契约）', () => {
    const reply = '合计 999。\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n999 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
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
