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
    expect(v.lines.map((line) => line.value)).toEqual([500, 300, 200, 1000]);
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

  it('绿：运算行形态的 0 仍成立（加数锚到真实记录）', () => {
    const v = classify('0 results\n[audit]\n500 <- rec-101\n0 := 500 - 500\n[/audit]');
    expect(v.findings).toEqual([]);
  });
});

/**
 * 覆盖可被运算行 LHS 全额满足（2026-11-09 独立评审 + D-207 未决二⑥）：运算行只验**闭合**
 * （右侧每个加数都有申报行可依），不验算——所以 "The total is 1000" 配
 * `1000 := 500 + 300 + 200` + 三条真实引用行，机械五查全绿，即便 1000 平台从未返回过。
 * 算式对错归 judge（PR #25 同契约）；机械层补不了它，登记在账（D-207 未决二⑥）而不是
 * 偷偷加一道算术检查。
 */
describe('audited 申报契约边界：运算行 LHS 满足覆盖，算式不验算', () => {
  it('绿：编造合计 1000 —— 加数锚到真实记录即过机械门（残余风险归 judge）', () => {
    const reply = 'The total is 1000\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]';
    const v = classify(reply);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('绿：连加数都加不出来的 999 也不判（"不验算"是契约，不是漏判）', () => {
    const reply = 'The total is 999\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n999 := 500 + 300 + 200\n[/audit]';
    expect(classify(reply).findings).toEqual([]);
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
  /** 同值互引病态块：k 条 `500 := 500 + 500`，没有任何引用行可接地。 */
  const pathological = (k: number): string => `[audit]\n${Array.from({ length: k }, () => '500 := 500 + 500').join('\n')}\n[/audit]`;

  it('k=80 同值互引（无接地）：判"不闭合"且立即返回（旧实现会挂住）', () => {
    const v = classify(`合计 500\n${pathological(80)}`);
    expect(v.checks.operationClosure).toBe(false);
    expect(v.findings.filter((f) => f.check === 'operationClosure')).toHaveLength(160); // 80 行 × 2 加数
  });

  it('k=40 同值互引 + 一条接地引用行：闭合（引用行优先接地，不展开互引）', () => {
    const v = classify(`合计 500\n[audit]\n500 <- rec-101\n${Array.from({ length: 40 }, () => '500 := 500 + 500').join('\n')}\n[/audit]`);
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  /**
   * 等价性锁：不动点实现与**改动前**的按行下标递归在同一批随机块上结论一致（随机块含同值
   * 互引、自引用环、跨值互引、混合引用/运算行）。参考实现逐字复制改动前的
   * `addendClosesWith`——它是指纹，不是要复活的代码路径。
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
      const actual = verdict.findings.filter((f) => f.check === 'operationClosure').map((f) => Number(f.subject));
      expect([...actual].sort((a, b) => a - b), reply).toEqual([...expected].sort((a, b) => a - b));
    }
  });
});
