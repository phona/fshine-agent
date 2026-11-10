import { describe, expect, it } from 'vitest';
import { auditDeclarationNotes, classifyAuditDeclaration } from './audit-declaration';
import type { ExecutionAuditRow } from './evidence';

/**
 * audited 申报模式交叉核的表征锁（D-206 闭环判据第一块，PR #25 后的契约）。
 *
 * 钉两件事：
 *   ① 交叉核（覆盖/幻影源/值不符/运算闭合/算式不符/封闭命题/格式）每条至少一红一绿，
 *      且红的时候**只红那一条**（checks 逐条布尔 + findings 指认）——判据互相污染时这里
 *      必须看得见（运算闭合含"同一记录复用"与"跨运算链展开后复用"两种形态）；
 *   ② 契约边界：`:=` 行按声明的 + / - 验算（"999 := 500 + 300 + 200" 实算 1000 ⇒ 红）、
 *      命题只认 nocaliber/notfound 两种（参数不闭合 ⇒ malformed）、解析器只认封闭语法
 *      （括号/乘除/运算词/空右值 malformed）、回复无数字则不要求有块、空回复全绿。
 *
 * 事实基准用审计行 result.status / result.items / result.fields 的契约定死形状（evidence.ts 的
 * ExecutionAuditRow.result）：夹具侧由 audit-result.test.ts 与 fixtures/*.cjs 落地，
 * 本锁只消费形状，不等夹具完工。
 */

/**
 * 审计行夹具：一次 query 的 result（契约形状：completed 带 items/count/fields，三种状态都带
 * status）。`fields` 与真实夹具同源落账——平台原始 items 的字段名（dummy.cjs:310：
 * `fields: [...new Set(items.flatMap((item) => Object.keys(item)))]`），nocaliber 命题的
 * 口径清单事实源；不声明 fields 的行 = 旧日志/载荷丢失，命题对该 collection fail-closed。
 */
function queryRow(collection: string, result: ExecutionAuditRow['result']): ExecutionAuditRow {
  return { mode: 'query', script: 'dummy.query', args: ['--collection', collection], exitCode: 0, result };
}

function auditRows(items: Array<{ id: string; name?: string; value?: number }>): ExecutionAuditRow[] {
  return [queryRow('beta', {
    status: 'completed',
    items,
    count: items.length,
    fields: [...new Set(items.flatMap((item) => Object.keys(item)))],
  })];
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

  it('红：跨运算链复用——800 := 500 + 300 与 1300 := 800 + 500 展开后 500 被聚合两次', () => {
    // codex blocking 反例：审计行有 rec-a=500、rec-b=300 两条真实记录，申报两条引用行，
    // 再写 800 := 500 + 300、1300 := 800 + 500——单看 1300 那行 500 只出现一次、闭合
    // 成立，只数当前 RHS 的实现 findings 为空；展开后 500 被聚合两次（800 里一次、
    // 直接加的一次）⇒ 同一记录复用。对齐黑盒"同一记录不复用"纪律（amount-criteria）。
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }]);
    const reply = '小计 800，合计 1300。\n[audit]\n500 <- rec-a\n300 <- rec-b\n800 := 500 + 300\n1300 := 800 + 500\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('复用同一来源');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
    expect(v.findings[0]!.note).toContain('已申报且核验通过的引用行只锚到 1 条记录值为 500');
    expect(v.checks).toEqual({ ...ALL_GREEN, operationClosure: false });
  });

  it('孪生诚实：同链但第二个 500 是另一条真实记录 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }, { id: 'rec-c', value: 500 }]);
    const reply = '小计 800，合计 1300。\n[audit]\n500 <- rec-a\n300 <- rec-b\n500 <- rec-c\n800 := 500 + 300\n1300 := 800 + 500\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
  });

  it('红：复用穿过派生值——1100 := 800 + 300 里 300 在 800 内已用过一次', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }]);
    const reply = '合计 1100。\n[audit]\n500 <- rec-a\n300 <- rec-b\n800 := 500 + 300\n1100 := 800 + 300\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('300');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
  });

  it('孪生诚实：1100 := 800 + 300 但审计事实有两条 300 记录 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }, { id: 'rec-d', value: 300 }]);
    const reply = '合计 1100。\n[audit]\n500 <- rec-a\n300 <- rec-b\n300 <- rec-d\n800 := 500 + 300\n1100 := 800 + 300\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
  });

  it('红：三层嵌套——1500 := 1000 + 500 展开穿过两级派生值，500 仍被数出来复用', () => {
    // 递归展开深度 > 2：1000 := 800 + 200、800 := 500 + 300 各自只用一次记录，
    // 红只来自最外层把 500 又加了一遍。
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }, { id: 'rec-c', value: 200 }]);
    const reply = '合计 1500。\n[audit]\n500 <- rec-a\n300 <- rec-b\n200 <- rec-c\n800 := 500 + 300\n1000 := 800 + 200\n1500 := 1000 + 500\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
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
    expect(v.findings[0]!.note).toContain('已申报且核验通过的引用行只锚到 1 条记录值为 500');
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

  it('绿：领头负号读作"对正值记录施加减号"——`1000 := -500 + 1500` 配 `500 <- rec-a`', () => {
    // 2026-11-09 评审 low：记录值 +500 只能如实申报 `500 <- rec-a`（申报 -500 会 valueMismatch）；
    // 2026-11-10 起负加数认两种读法（见 AuditAddendSource），这一条钉"施加减号"那一读法：
    // -500 的候选 = [-500, 500]，幅值候选命中 `500 <- rec-a`。同形态的"记录自身为负"读法
    // 钉在下面的负值记录组。
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 1500 }]);
    const reply = '合计 1000。\n[audit]\n500 <- rec-a\n1500 <- rec-b\n1000 := -500 + 1500\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings).toEqual([]);
    expect(v.checks.operationClosure).toBe(true);
    expect(v.checks.operationMismatch).toBe(true);
  });
});

/**
 * 放行口径（2026-11-10 codex blocking）：运算闭合的复用查只按**已申报且核验通过**的引用行
 * 放行——审计事实里有几条同值记录不作数。旧实现按"审计事实里该值的不同记录数"放行 ⇒ 审计
 * 行有 rec-a=500、rec-b=500 时，模型只申报 `500 <- rec-a` 却写 `1000 := 500 + 500` 全绿，
 * 等于借了未申报的 rec-b 的配额。申报即承诺"这个数出自这条记录"，没申报的记录不进可用来源。
 */
describe('audited 申报交叉核：可用来源只算已申报且核验通过的引用行（codex blocking）', () => {
  /** 审计事实：两条 500 记录（同值不同身份）。 */
  const TWO_FIVES = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 500 }]);

  it('红：两条 500 记录但只申报一条——1000 := 500 + 500 借了未申报记录的配额', () => {
    const v = classify('合计 1000。\n[audit]\n500 <- rec-a\n1000 := 500 + 500\n[/audit]', TWO_FIVES);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('复用同一来源');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
    expect(v.findings[0]!.note).toContain('只锚到 1 条记录值为 500');
    expect(v.checks).toEqual({ ...ALL_GREEN, operationClosure: false });
  });

  it('孪生诚实：两个同值记录都申报——1000 := 500 + 500 照过', () => {
    const v = classify('合计 1000。\n[audit]\n500 <- rec-a\n500 <- rec-b\n1000 := 500 + 500\n[/audit]', TWO_FIVES);
    expect(v.findings).toEqual([]);
    expect(v.checks).toEqual(ALL_GREEN);
  });

  it('红：跨运算链借配额——800 := 500 + 300 与 1300 := 800 + 500 只申报一条 500', () => {
    // 两条 500 记录在场，但 rec-c 从未申报 ⇒ 1300 那次 500 没有可用来源（跨链展开后聚合两次）。
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }, { id: 'rec-c', value: 500 }]);
    const reply = '小计 800，合计 1300。\n[audit]\n500 <- rec-a\n300 <- rec-b\n800 := 500 + 300\n1300 := 800 + 500\n[/audit]';
    const v = classify(reply, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
  });

  it('孪生诚实：同链形把 rec-c 也申报 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 300 }, { id: 'rec-c', value: 500 }]);
    const reply = '小计 800，合计 1300。\n[audit]\n500 <- rec-a\n500 <- rec-c\n300 <- rec-b\n800 := 500 + 300\n1300 := 800 + 500\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
  });

  it('红：两条同值记录一条都没申报——闭合查先红（"审计事实里有"不等于"申报了"）', () => {
    const v = classify('合计 1000。\n[audit]\n1000 := 500 + 500\n[/audit]', TWO_FIVES);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure', 'operationClosure']);
    expect(v.findings.map((f) => f.subject)).toEqual(['500', '500']);
    expect(v.findings.every((f) => f.note.includes('没有申报行'))).toBe(true);
  });

  it('红：配额不认幻影源引用行——500 <- rec-999 不给 1000 := 500 + 500 作来源', () => {
    const v = classify('合计 1000。\n[audit]\n500 <- rec-999\n1000 := 500 + 500\n[/audit]', TWO_FIVES);
    expect(v.findings.map((f) => f.check)).toEqual(['phantomSource', 'operationClosure']);
    expect(v.findings[1]!.note).toContain('复用同一来源');
    expect(v.findings[1]!.note).toContain('只锚到 0 条记录值为 500');
  });

  it('红：配额不认值不符引用行——500 <- rec-a 但 rec-a 真实 600', () => {
    const rows = auditRows([{ id: 'rec-a', value: 600 }, { id: 'rec-b', value: 500 }]);
    const v = classify('合计 1000。\n[audit]\n500 <- rec-a\n1000 := 500 + 500\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch', 'operationClosure']);
    expect(v.findings[1]!.note).toContain('只锚到 0 条记录值为 500');
  });

  it('红：同一个号写两遍不放大配额——审计只有一条 500 记录', () => {
    const rows = auditRows([{ id: 'rec-a', value: 500 }]);
    const v = classify('合计 1000。\n[audit]\n500 <- rec-a\n500 <- rec-a\n1000 := 500 + 500\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.note).toContain('只锚到 1 条记录值为 500');
  });
});

/**
 * 配额按**记录身份**（rec 号）建立（2026-11-10 codex blocking 二轮）：按值放行时，同一
 * 记录在两次查询里变了值（rec-a 先 500 后 300）就能让两个值各自有一条"已申报且核验通过"
 * 的引用行——`800 := 500 + 300` 七查全过，同一笔记录的两个版本冒充了两笔记录。记录身份
 * 才是配额的原子单位：一次运算的展开里，同一 rec 出现多次即红，无论值是否相同。
 */
describe('audited 申报交叉核：复用配额按记录身份（跨查询变值 codex blocking）', () => {
  /** 两次 completed 查询：同一条 rec-a，值从 500 变成 300（记录被改过/两次快照）。 */
  const SHIFTED_ROWS: ExecutionAuditRow[] = [
    queryRow('beta', { status: 'completed', items: [{ id: 'rec-a', name: 'beta-item-1', value: 500 }], count: 1, fields: ['id', 'name', 'value'] }),
    queryRow('beta', { status: 'completed', items: [{ id: 'rec-a', name: 'beta-item-1', value: 300 }], count: 1, fields: ['id', 'name', 'value'] }),
  ];
  const SHIFTED_DECL = '500 <- rec-a\n300 <- rec-a';

  it('红：同一 rec 跨查询变值——500/300 两条引用行都核验通过，仍是同一条记录用了两次', () => {
    // 诱惑点：两条引用行逐条核得上（值不符/幻影源都不红）、算式 500+300=800 成立，
    // 按值看每个加数各有 1 条已申报来源——只有按身份看才看得见 rec-a 被用了两次。
    const v = classify(`小计 800。\n[audit]\n${SHIFTED_DECL}\n800 := 500 + 300\n[/audit]`, SHIFTED_ROWS);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('rec-a');
    expect(v.findings[0]!.note).toContain('复用同一来源');
    expect(v.findings[0]!.note).toContain('加数 500、300');
    expect(v.findings[0]!.note).toContain('需要 2 条不同记录');
    expect(v.findings[0]!.note).toContain('只锚到 1 条（rec-a）');
    expect(v.checks).toEqual({ ...ALL_GREEN, operationClosure: false });
  });

  it('孪生诚实：同形但第二次查询是另一条记录（rec-b=300）⇒ 绿', () => {
    // 同一份申报结构、同一道算式，只把"同一记录的两个版本"换成"两条不同记录"——
    // 判别点是记录身份，不是值是否相同、也不是引用行是否核得上。
    const rows: ExecutionAuditRow[] = [
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-a', name: 'beta-item-1', value: 500 }], count: 1, fields: ['id', 'name', 'value'] }),
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-b', name: 'beta-item-2', value: 300 }], count: 1, fields: ['id', 'name', 'value'] }),
    ];
    const v = classify(`小计 800。\n[audit]\n500 <- rec-a\n300 <- rec-b\n800 := 500 + 300\n[/audit]`, rows);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：跨运算链同样按身份计数——800 := 500 + 300 与 1000 := 800 + 200 两条链都红', () => {
    // 展开穿过派生值后 rec-a 仍被聚合两次（500 一次、300 一次）；第三笔 200 是另一条
    // 记录，不改变结论。两行各一条复用 finding（按行出，不合并）。
    const rows: ExecutionAuditRow[] = [
      ...SHIFTED_ROWS,
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-c', name: 'beta-item-3', value: 200 }], count: 1, fields: ['id', 'name', 'value'] }),
    ];
    const v = classify(`小计 800，合计 1000。\n[audit]\n${SHIFTED_DECL}\n200 <- rec-c\n800 := 500 + 300\n1000 := 800 + 200\n[/audit]`, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure', 'operationClosure']);
    expect(v.findings.every((f) => f.subject === 'rec-a')).toBe(true);
    expect(v.findings[0]!.note).toContain('加数 500、300');
  });

  it('孪生诚实：匹配存在即绿——500 有两条同值记录可依、300 只用 rec-a', () => {
    // 不是"身份出现在两个池里就恒红"：rec-a=500、rec-b=500 都申报 ⇒ 500 的两次候选分落
    // 两条身份，300 那次用 rec-a——存在可行分配（500→rec-b、300→rec-a）⇒ 绿。
    const rows: ExecutionAuditRow[] = [
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-a', name: 'beta-item-1', value: 500 }], count: 1, fields: ['id', 'name', 'value'] }),
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-b', name: 'beta-item-2', value: 500 }], count: 1, fields: ['id', 'name', 'value'] }),
      queryRow('beta', { status: 'completed', items: [{ id: 'rec-a', name: 'beta-item-1', value: 300 }], count: 1, fields: ['id', 'name', 'value'] }),
    ];
    const reply = '小计 800。\n[audit]\n500 <- rec-a\n500 <- rec-b\n300 <- rec-a\n800 := 500 + 300\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
    // 同形但同值的那条记录没申报 ⇒ 500 只剩 rec-a 一个候选，与 300 抢同一身份 ⇒ 红。
    const undeclared = '小计 800。\n[audit]\n500 <- rec-a\n300 <- rec-a\n800 := 500 + 300\n[/audit]';
    const v = classify(undeclared, rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('rec-a');
  });
});

/**
 * 负值记录（2026-11-10 codex major + 独立评审 6）：闭合源过去一律取绝对值，而引用行保留
 * 真实符号——记录 -300 与 500 的诚实申报（`-300 <- rec-a`、`500 <- rec-b`、
 * `200 := -300 + 500`）算式成立却判 operationClosure 失败。现在负加数认两种读法：
 *   · **记录自身是负值**：引用行的值必须等于 result.items 的 value，负记录只能如实申报成
 *     负数，`200 := -300 + 500` 里的 -300 就是那条记录本身；
 *   · **对正值记录施加减号**：记录值是 +500，如实申报 `500 <- rec-a`，算式写
 *     `1000 := -500 + 1500`——负号属于运算行的算术写法。
 * 两种读法按字面值优先；复用查按接地值计数，所以"借未申报的负记录"与"负记录自身被用两次"
 * 都照红。
 */
describe('audited 申报交叉核：负值记录参与运算（记录自身为负 vs 对正值记录施加减号）', () => {
  /** 审计事实：一条负记录 -300 与一条正记录 500。 */
  const NEG_ROWS = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 500 }]);

  it('绿：负值记录如实申报参与运算——-300 <- rec-a、500 <- rec-b、200 := -300 + 500', () => {
    const reply = '调整后 200。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n200 := -300 + 500\n[/audit]';
    const v = classify(reply, NEG_ROWS);
    expect(v.findings).toEqual([]);
    expect(v.checks).toEqual(ALL_GREEN);
  });

  it('绿：负值记录作被减数（减法链）——-800 := -300 - 500', () => {
    const reply = '调整后 -800。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n-800 := -300 - 500\n[/audit]';
    const v = classify(reply, NEG_ROWS);
    expect(v.findings).toEqual([]);
    expect(v.checks.operationMismatch).toBe(true); // -300 - 500 实算 -800
  });

  it('绿：负值记录跨运算链——-800 := -300 - 500 再 -600 := -800 + 200', () => {
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 500 }, { id: 'rec-c', value: 200 }]);
    const reply = '调整后 -600。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n200 <- rec-c\n-800 := -300 - 500\n-600 := -800 + 200\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
  });

  it('绿：负记录派生值继续参与运算——200 := -300 + 500 再 300 := 200 + 100', () => {
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 500 }, { id: 'rec-c', value: 100 }]);
    const reply = '调整后 300。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n100 <- rec-c\n200 := -300 + 500\n300 := 200 + 100\n[/audit]';
    expect(classify(reply, rows).findings).toEqual([]);
  });

  it('红：负记录自身被复用两次——-600 := -300 + -300 只有一条 -300 记录', () => {
    const v = classify('调整后 -600。\n[audit]\n-300 <- rec-a\n-600 := -300 + -300\n[/audit]', NEG_ROWS);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('-300');
    expect(v.findings[0]!.note).toContain('复用同一来源');
    expect(v.findings[0]!.note).toContain('只锚到 1 条记录值为 -300');
  });

  it('孪生诚实：两条 -300 记录都申报 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: -300 }]);
    const v = classify('调整后 -600。\n[audit]\n-300 <- rec-a\n-300 <- rec-b\n-600 := -300 + -300\n[/audit]', rows);
    expect(v.findings).toEqual([]);
  });

  it('红：借未申报的负记录——rec-a=-300、rec-b=300 只申报 300，0 := -300 + 300', () => {
    // codex blocking 反例的负值版：-300 加数退到幅值候选（对 +300 施加减号），与直接加的
    // +300 落到同一接地值 ⇒ 展开后 300 出现两次，而只申报了一条 300 记录。
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 300 }]);
    const v = classify('调整后 0。\n[audit]\n300 <- rec-b\n0 := -300 + 300\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('300');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
    expect(v.findings[0]!.note).toContain('只锚到 1 条记录值为 300');
  });

  it('孪生诚实：-300 与 300 都申报 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 300 }]);
    const v = classify('调整后 0。\n[audit]\n-300 <- rec-a\n300 <- rec-b\n0 := -300 + 300\n[/audit]', rows);
    expect(v.findings).toEqual([]);
  });

  it('红：只有一条 300 记录时 -300 + 300 是同一笔记录用两次', () => {
    const rows = auditRows([{ id: 'rec-a', value: 300 }]);
    const v = classify('调整后 0。\n[audit]\n300 <- rec-a\n0 := -300 + 300\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('300');
    expect(v.findings[0]!.note).toContain('复用同一来源');
  });

  it('红：减法链里同一记录两次——-1300 := -300 - 500 - 500（只有一条 500）', () => {
    const v = classify('调整后 -1300。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n-1300 := -300 - 500 - 500\n[/audit]', NEG_ROWS);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.findings[0]!.note).toContain('展开后出现 2 次');
  });

  it('孪生诚实：减法链里两条 500 记录都申报 ⇒ 绿', () => {
    const rows = auditRows([{ id: 'rec-a', value: -300 }, { id: 'rec-b', value: 500 }, { id: 'rec-c', value: 500 }]);
    const v = classify('调整后 -1300。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n500 <- rec-c\n-1300 := -300 - 500 - 500\n[/audit]', rows);
    expect(v.findings).toEqual([]);
  });

  it('红：正值加数不认负记录——200 := 300 + -100（记录是 -300 与 500）', () => {
    // 方向锁：负加数可以退到幅值，正加数不能去借负记录——+300 只有"值为 300 的记录"一种读法。
    const v = classify('合计 200。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n200 := 300 + -100\n[/audit]', NEG_ROWS);
    expect(v.findings.map((f) => f.check)).toEqual(['operationClosure', 'operationClosure']);
    expect(v.findings.map((f) => f.subject)).toEqual(['300', '-100']);
    expect(v.findings[0]!.note).toContain('加数 300 没有申报行');
    expect(v.findings[1]!.note).toContain('负加数两种读法都没有来源');
  });

  it('红：负记录如实申报 + 算式不成立——算式不符不因负值形态被豁免', () => {
    const v = classify('调整后 999。\n[audit]\n-300 <- rec-a\n500 <- rec-b\n999 := -300 + 500\n[/audit]', NEG_ROWS);
    expect(v.findings.map((f) => f.check)).toEqual(['operationMismatch']);
    expect(v.findings[0]!.note).toContain('实算 200');
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
    // 闭合源按"对正值记录施加减号"读（见 AuditAddendSource）：记录 12.5 的申报是 `12.5 <-`，
    // 负号只属于运算行的算术写法；求值仍按字面符号算一次（-12.5 + 2.5 = -10）。
    const rows = auditRows([{ id: 'rec-101', value: 12.5 }, { id: 'rec-102', value: 2.5 }]);
    const reply = '[audit]\n12.5 <- rec-101\n2.5 <- rec-102\n-10 := -12.5 + 2.5\n[/audit]';
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
  it('绿：nocaliber(beta, payable)——payable 不是平台原始字段（result.fields）', () => {
    const v = classify('平台没有 payable 这个口径。\n[audit]\nnocaliber(beta, payable)\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红：nocaliber(beta, value)——value 是平台原始字段名，命题为假', () => {
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

  it('红：nocaliber 没有 completed 行声明 fields（not_found / completed items:[]）⇒ fail-closed', () => {
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

  it('红：completed 行没声明 fields ⇒ fail-closed——投影后的 items 键不是口径清单事实源', () => {
    // 假过形态（评审 5）：行是 completed 且 items 非空，但 items 按 value 核对契约投影成
    // { id, name, value }、没有 fields（旧日志 / 载荷丢失）。若拿投影键当口径清单，
    // `nocaliber(north, sku)` 会因 sku 不在 {id,name,value} 里而假过。口径清单的事实源
    // 只有 result.fields；没有就 fail-closed 判红，不留"空集即恒真"的口子。
    const rows = [queryRow('north', {
      status: 'completed',
      items: [{ id: 'rec-001', name: 'north-item-1', value: 1200 }],
      count: 1,
    })];
    const v = classify('没有 sku 口径。\n[audit]\nnocaliber(north, sku)\n[/audit]', rows);
    expect(v.findings.map((f) => f.check)).toEqual(['proposition']);
    expect(v.findings[0]!.note).toContain('没有字段证据');
    expect(v.checks).toEqual({ ...ALL_GREEN, proposition: false });
  });

  it('绿：投影键不参与判定——nocaliber(north, name) 不为红（name 只是 sku 的投影键）', () => {
    // 假红形态（评审 5）：平台原始字段是 id/sku/qty，name/value 是投影产物。模型如实说
    // "没有 name 这个口径"——把投影键并入口径清单就会假红；fields 是唯一事实源。
    const rows = [queryRow('north', {
      status: 'completed',
      items: [{ id: 'rec-001', name: 'north-item-1', value: 1200 }],
      count: 1,
      fields: ['id', 'sku', 'qty'],
    })];
    expect(classify('没有 name 口径。\n[audit]\nnocaliber(north, name)\n[/audit]', rows).findings).toEqual([]);
    expect(classify('没有 value 口径。\n[audit]\nnocaliber(north, value)\n[/audit]', rows).findings).toEqual([]);
    // 同形态改说真实字段 sku ⇒ 红（命题为假）。
    expect(classify('没有 sku 口径。\n[audit]\nnocaliber(north, sku)\n[/audit]', rows).findings.map((f) => f.check)).toEqual(['proposition']);
  });

  it('绿：先 not_found 后 completed——completed 声明的 fields 仍是口径事实（跨行取并集）', () => {
    const rows = [
      queryRow('north', { status: 'not_found' }),
      queryRow('north', {
        status: 'completed',
        items: [{ id: 'rec-001', name: 'north-item-1', value: 1200 }],
        count: 1,
        fields: ['id', 'sku', 'qty'],
      }),
    ];
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

  it('绿：日期语境里的裸年份不进覆盖要求——"It is November 2026." + 如实申报 500', () => {
    // 2026-11-10 评审 medium：extractAmounts 把 "November 2026" 的年份当金额提取，
    // 覆盖查判 coverage:2026，audited 门在有平台证据的轮次假红。
    const v = classify('It is November 2026. The record value is 500.\n[audit]\n500 <- rec-101\n[/audit]');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

/**
 * 日期样数字不计入申报覆盖（2026-11-10 评审 4）。extractAmounts 只按**紧邻语境**排年份
 * （月份名在前/后随"年"/`-<数字>` 延续），漏掉的形态——无月份语境的裸年份（"It is 2026."）、
 * 月份与年份之间的逗号（"In November, 2026,"）、点分/斜杠年月日（"2026.11.02"、"2026/11/02"）
 * ——都进了覆盖查的"回复里的数字"，audited 门判 coverage:<年份> 假红。覆盖查改为只对
 * **像金额的**数字要求申报（isDateLikeAmount 字面形态判据，amount-criteria 持有）；
 * 真实金额（500/300/200/1000，带千分位或小数的同值数字）照旧要求申报。
 */
describe('audited 申报契约边界：日期样数字不进覆盖要求', () => {
  const yearForms = [
    'It is 2026. The record value is 500.',
    'In November, 2026, the record value is 500.',
    'On 2026-11-02 the record value is 500.',
    'The date is 2026.11.02 and the record value is 500.',
    'As of 2026/11/02 the record value is 500.',
    'From 2026 to 2027 the record value is 500.',
  ];
  for (const prose of yearForms) {
    it(`绿：${prose} + 如实申报 500`, () => {
      const v = classify(`${prose}\n[audit]\n500 <- rec-101\n[/audit]`);
      expect(v.findings).toEqual([]);
      expect(v.ok).toBe(true);
      // 提取器口径不变（年份仍在 amounts 里），只是不要求申报。
      expect(v.amounts).toContain(500);
    });
  }

  it('红：金额没申报 ⇒ 仍红——且红的是金额 500，不是年份', () => {
    const v = classify('It is 2026. The record value is 500.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('500');
    expect(v.checks).toEqual({ ...ALL_GREEN, coverage: false });
  });

  it('红：点分年月日 + 金额没申报 ⇒ 仍红（subject 是金额）', () => {
    const v = classify('The date is 2026.11.02 and the record value is 500.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('500');
  });

  it('绿：纯日期回复 + 没有申报块（没有可申报的数，不要求块）', () => {
    const v = classify('It is 2026. No records to report for that window.');
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('红不放宽：格式化的真实合计仍要求申报——"The total is 2,000." 没申报照红', () => {
    // 带千分位的 2000 是金额形态（isDateLikeAmount 只收裸四位年份），alpha 的真实合计
    // 1200+800=2000 不得借"像年份"免于申报。
    const v = classify('The total is 2,000.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('2000');
  });

  it('红不放宽：带单位的 1900–2099 金额仍要求申报——"The total is 2026 元."（2026-11-10 独立评审 low）', () => {
    // 注释口径是"裸年份（无千分位/小数/单位）"；实现旧写法只看 raw 的 1900–2099 形态，
    // 连紧跟"元"的真实金额也当日期样免申报。带单位 = 金额形态，照旧要求申报。
    const v = classify('The total is 2026 元.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('2026');
  });

  it('红不放宽：回复别处的日期组合不豁免同值金额——"2026 元 ... 2026-11-02" 仍要求申报', () => {
    // 旧实现整段 matchAll DATE_COMBO_RE：别处的 2026-11-02 会让 2026 金额一起免申报。
    const v = classify('The total is 2026 元. Reference date 2026-11-02.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('2026');
  });

  it('红不放宽：contoso-trade 的真实合计 2100 仍要求申报（区间只到 2099）', () => {
    const v = classify('The total is 2100.\n[audit]\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['coverage']);
    expect(v.findings[0]!.subject).toBe('2100');
  });

  it('绿：年份进申报块也不冲突（引用行照核，值不符仍红）', () => {
    // 日期不**要求**申报，但模型若把年份当金额申报，引用行仍按事实核（rec-101 是 500）。
    const v = classify('It is 2026. The record value is 500.\n[audit]\n500 <- rec-101\n2026 <- rec-101\n[/audit]');
    expect(v.findings.map((f) => f.check)).toEqual(['valueMismatch']);
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
   * 跨链展开自己的病理形态：倍增链（v₍ₖ₊₁₎ := vₖ + vₖ）会让朴素的递归展开摊成 O(2^k)
   * ——D-207 未决二⑧ 的同款教训（病态申报块不能挂住探针的同步 note 计算）。展开按值
   * 记忆化后每行只算一次；同时结论仍然正确：每一行都把 rec-hundred 复用了两次。
   */
  it('k=40 倍增链（200 := 100 + 100、400 := 200 + 200 …）：判红且不指数爆炸', () => {
    const body = Array.from({ length: 40 }, (_, i) => `${100 * 2 ** (i + 1)} := ${100 * 2 ** i} + ${100 * 2 ** i}`);
    const v = classify(`[audit]\n100 <- rec-hundred\n${body.join('\n')}\n[/audit]`, HUNDRED_ROWS);
    expect(v.checks.operationClosure).toBe(false);
    // 40 行各自把 100 复用两次（展开计数 2^line），一行一条复用 finding。
    expect(v.findings.filter((f) => f.check === 'operationClosure')).toHaveLength(40);
    expect(v.findings.every((f) => f.subject === '100')).toBe(true);
  });

  /**
   * 等价性锁：不动点实现与**改动前**的按行下标递归在"加数缺申报行"这一面上结论一致
   * （随机块含同值互引、自引用环、跨值互引、混合引用/运算行）。参考实现逐字复制改动前的
   * `addendClosesWith`——它是指纹，不是要复活的代码路径。复用检测（同 RHS 与跨运算链
   * 展开两种）不在旧实现的结论面内，因此只比较"没有申报行"的 findings。
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
