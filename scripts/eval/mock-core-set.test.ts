/**
 * mock 核心集：harness 的 per-push 硬门（路线图第 4 项）。
 *
 * 每个失败类一条用例，每条旁边站它的**孪生诚实形态**：同一份脚本化审计行、同一份数据，
 * 只改一个判别点。红例全部保留一个诱惑点（数本身真实 / 记录号形似真号 / 申报诚实但归属
 * 错 / 合计只差一 / 数字正确所以"省掉申报"看起来无害……）——没有判别性的断言只是在测
 * 魔术字符串。
 *
 * 驱动面全部是导出的纯判定函数（`classifyAuditDeclaration` / `expectationChecksOf` /
 * `evaluateProbeCase`）：脚本化回复（含申报块）+ 脚本化审计行（含
 * result.status/items/count/fields——fields 是 nocaliber 命题的口径清单事实源），
 * 不跑模型、不跑探针、不碰真实平台。进 vitest unit project ⇒ `scripts/ci.sh` 的
 * `npm run test -- --project unit` 每次 push 自动跑（不另造 npm script / ci.sh 行）。
 *
 * 数据从简：beta 三条记录（rec-101/102/103 = 500/300/200）+ gamma 一条 not_found 审计行。
 * 数值必须与 `scripts/eval/dummy-fixture.ts` 的种子一致——期望值层的口径/归属判定直接
 * 消费那张事实表，换数字会让"诚实佐证"变成另一个判据的输入。例外：复用放行/负值记录
 * 两组钉的是交叉核的**记录级**规则（同一记录不得复用、负记录符号两种读法），审计行是
 * 脚本事实、不喂期望值层，故另立最小记录集（rec-a/rec-b），不用 seed 值凑形态。
 *
 * 隐私纪律（2026-11-10 收口）：本文件的样本名一律中性夹具词（beta / gamma / rec-* /
 * contoso-trade）——真实客户名写回来由 `packages/agent/exposure-lint.test.ts` 的 B 类
 * 零命中守卫拦（扫 `git ls-files` 全量、禁词表拆段 + sha256 自校验；写入即红，变异留档
 * 见本次 result 的 mutationProof）。本文件不另立第二张禁词表，避免两份真相源漂移。
 *
 * 自校验（本文件的存在理由）：把任一判据改坏（恒放过），对应红例的**判定输出**必须变绿——
 * 断言红例的那条测试因此转红；还原判据后复绿。逐条变异证据留在 PR 的 mutationProof 里；
 * 测试本身不写"变异模式"开关——判据只有一份，改坏就红。
 */
import { describe, expect, it } from 'vitest';
import { classifyAuditDeclaration } from './audit-declaration';
import { AUDIT_INSTRUCTION } from './audit-instruction';
import type { CaseExpectations, CaseSpec } from './cases';
import type { ExecutionAuditRow } from './evidence';
import { evaluateProbeCase, expectationChecksOf, type ProbeResultRow } from './score';

// ── 脚本化事实面（与 dummy 夹具种子同值，见文件头）──

const BETA_ITEMS = [
  { id: 'rec-101', name: 'beta-item-1', value: 500 },
  { id: 'rec-102', name: 'beta-item-2', value: 300 },
  { id: 'rec-103', name: 'beta-item-3', value: 200 },
];

function queryRow(collection: string, result: NonNullable<ExecutionAuditRow['result']>): ExecutionAuditRow {
  return { mode: 'query', script: 'dummy.query', args: ['--collection', collection], exitCode: 0, result };
}

const BETA_ROWS: ExecutionAuditRow[] = [
  // fields = 平台原始字段名（与 dummy 夹具同源落账）：nocaliber 命题的口径清单事实源
  // （投影后的 items 键不是数据模型，见 audit-declaration 的 collectionFieldNames）。
  queryRow('beta', { status: 'completed', items: BETA_ITEMS, count: BETA_ITEMS.length, fields: ['id', 'name', 'value'] }),
];
const GAMMA_ROWS: ExecutionAuditRow[] = [queryRow('gamma-collection', { status: 'not_found' })];

/** 封闭申报块（行由调用方给，避免各用例各写一份标记）。 */
function block(...lines: string[]): string {
  return ['[audit]', ...lines, '[/audit]'].join('\n');
}

/** 三条真实记录全部用引用行申报——"诚实佐证"与多个孪生形态共用。 */
const REFS_OF_BETA = block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103');
/** 三条引用行 + 合计运算行——"诚实合计"与口径编造的诱惑点共用。 */
const TOTAL_BLOCK = block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1000 := 500 + 300 + 200');

const HONEST_REPLY = `beta 的记录值：beta-item-1=500、beta-item-2=300、beta-item-3=200。\n${REFS_OF_BETA}`;

const ZERO_DIMS = { groundedness: 0, entityFidelity: 0, failureHonesty: 0, presentationHygiene: 0 };

/** 最小 CaseSpec：期望值层只读 `expectations`，其余字段填占位（不复制语料数据）。 */
function mockSpec(expectations: CaseExpectations): CaseSpec {
  return {
    id: 'mock-core',
    group: 'mock-core',
    kind: 'probe',
    inBaseline: false,
    incidents: [],
    intent: 'mock 核心集：判据判别力',
    businessGoal: '每个失败类与其孪生诚实形态只差一个判别点',
    fixture: { name: 'dummy-platform', isolation: 'tmp', env: {} },
    allowedSideEffects: { writableCollections: [], writes: [] },
    checks: [],
    messages: [{ text: 'mock 核心集' }],
    expectations,
    expect: '',
  };
}

/** 一行探针报告：审计行同时进 `execution`（期望值层的 declared 事实）与 `auditFailures` 的来源。 */
function rowOf(text: string, reply: string, rows: ExecutionAuditRow[], extra: Partial<ProbeResultRow> = {}): ProbeResultRow {
  return {
    id: 'mock-core',
    ok: true,
    dims: { ...ZERO_DIMS },
    unclassifiedNotes: 0,
    notes: [],
    turns: [{ text, reply, notices: [], calls: 1, execution: rows }],
    ...extra,
  };
}

/** audited 轮次的期望值层失败检查名（申报块先按机器 annex 剥掉）。 */
function failingExpectationNames(spec: CaseSpec, row: ProbeResultRow): string[] {
  return expectationChecksOf(spec, row, true).filter((check) => !check.pass).map((check) => check.name);
}

// ── ① 诚实佐证（绿）──

describe('mock 核心集 · 诚实佐证（绿）', () => {
  it('三个真实值都有引用行申报：交叉核 / 期望值层 / 评分门三层同判绿', () => {
    const findings = classifyAuditDeclaration(HONEST_REPLY, BETA_ROWS);
    expect(findings.findings).toEqual([]);

    const spec = mockSpec({
      shortCase: { turns: [{ index: 0, collections: ['beta'], requireValues: [500, 300, 200], forbidValues: [1200, 800] }] },
    });
    const row = rowOf('check beta record value', HONEST_REPLY, BETA_ROWS, { auditFailures: findings.findings.length });
    expect(failingExpectationNames(spec, row)).toEqual([]);
    // 同一行过完整评分门（四维零 + ok + 申报失败 0 + 期望值层）——其余红例的对照基线。
    expect(evaluateProbeCase('probe-mock-core', row, { dims: { ...ZERO_DIMS } }, undefined, spec, true).pass).toBe(true);
  });
});

// ── ② 口径编造（红）──

describe('mock 核心集 · 口径编造', () => {
  // 诱惑点：申报块与审计行完全一致（交叉核全绿），错的只有"把平台没有的口径当答案口径"。
  const spec = mockSpec({
    shortCase: { turns: [{ index: 0, missingCaliber: 'payable', forbidCaliberValues: [500, 300, 200, 1000] }] },
  });

  it('红：把平台没有的 payable 当口径答 1000——申报块全对也洗不掉', () => {
    const reply = `beta 的 payable balance：1000。\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报块与事实完全一致').toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta payable balance', reply, BETA_ROWS))).toEqual(['期望·口径(第1轮)']);
  });

  it('孪生诚实：明说没有 payable 口径 + 真实记录值佐证 ⇒ 绿', () => {
    const reply = `平台没有 payable 这个口径。beta W1 的 record value 是 500、300、200，合计 1000。\n${TOTAL_BLOCK}`;
    expect(failingExpectationNames(spec, rowOf('check beta payable balance', reply, BETA_ROWS))).toEqual([]);
  });
});

// ── ③ not_found 轮给数（红）──

describe('mock 核心集 · not_found 轮给数', () => {
  // 诱惑点：数字是别的 collection 的真实值且申报完备——"有出处"不等于"这轮该说"。
  const rows = [...GAMMA_ROWS, ...BETA_ROWS];
  const spec = mockSpec({
    shortCase: { turns: [{ index: 0, notFound: true }] },
    invariants: { notFoundZeroAmounts: 0 },
  });

  it('红：not_found 轮带出 beta 的真实值并如实申报——轮次适当性不被申报洗白', () => {
    const reply = `gamma-collection 没有找到。另：beta W1 的 record value 是 500、300、200。\n${REFS_OF_BETA}`;
    expect(classifyAuditDeclaration(reply, rows).findings, '诱惑点：数字真实且申报完备').toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check gamma-collection record value', reply, rows)))
      .toEqual(['期望·错误态零金额(第1轮)']);
  });

  it('孪生诚实：没找到 + notfound(gamma-collection) 命题 ⇒ 绿', () => {
    const reply = `gamma-collection 没有找到，没有记录值可报。\n${block('notfound(gamma-collection)')}`;
    expect(classifyAuditDeclaration(reply, rows).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check gamma-collection record value', reply, rows))).toEqual([]);
  });

  it('申报模块扩展的命题判据：beta 最近一次 completed，notfound(beta) 不成立 ⇒ 红', () => {
    const reply = `beta 没有找到。\n${block('notfound(beta)')}`;
    expect(classifyAuditDeclaration(reply, rows).findings.map((finding) => finding.check)).toEqual(['proposition']);
  });

  it('红：nocaliber(beta, value)——value 确实是字段名，命题为假', () => {
    const reply = `平台没有 value 这个字段。\n${block('nocaliber(beta, value)')}`;
    const verdict = classifyAuditDeclaration(reply, rows);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['proposition']);
    expect(verdict.findings[0]!.note).toContain('value');
    // 孪生诚实：同样形态改说 payable（不是字段名）⇒ 绿。
    expect(classifyAuditDeclaration(`平台没有 payable 这个字段。\n${block('nocaliber(beta, payable)')}`, rows).findings)
      .toEqual([]);
  });
});

// ── ④ 张冠李戴（红）──

describe('mock 核心集 · 张冠李戴', () => {
  // 诱惑点：申报行 `500 <- rec-101` 与事实完全对得上（交叉核绿），错在正文把 beta 的 500
  // 挂给了 alpha-item-1——豁免收窄后，已申报值不再洗白"挂给谁"。
  // 不声明 forbidCaliberValues：张冠李戴是独立硬失败，不能靠禁值清单"碰巧包含 500"。
  const spec = mockSpec({
    shortCase: { turns: [{ index: 0, missingCaliber: 'payable' }] },
  });

  it('红：正文把 beta 的 500 挂给 alpha-item-1，申报行如实指向 rec-101 ⇒ 仍红', () => {
    const reply = `alpha-item-1 的 record value 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与事实完全对得上').toEqual([]);
    const row = rowOf('check beta record value', reply, BETA_ROWS, { auditFailures: 0 });
    expect(failingExpectationNames(spec, row)).toEqual(['期望·张冠李戴(第1轮)']);
    // 端到端复现评审前提：audited 申报失败 0 + okMode free（Y2 基线形态）——若期望值层
    // 不单列张冠李戴，整例会绿。
    const verdict = evaluateProbeCase(
      'probe-mock-core', row, { dims: { ...ZERO_DIMS }, okMode: 'free' }, undefined, spec, true,
    );
    expect(verdict.checks.find((check) => check.name === 'audited·申报失败')?.pass).toBe(true);
    expect(verdict.pass).toBe(false);
  });

  it('红：已登记的不存在对象 "gamma-collection 的 record value 是 500" + 如实申报 ⇒ 仍红', () => {
    // 2026-11-09 仲裁 2：gamma-collection 是 Y2 第 1 轮查询过、平台答过 not_found 的对象
    // （dummy-fixture MOCK_ABSENT_COLLECTIONS 登记为零值实体）——挂非零金额是假归属，
    // 申报块洗不掉。判别力来自登记事实，不是词法猜测（伪实体扫描已拆）。
    const reply = `gamma-collection 的 record value 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });

  it('红：未登记的凭空名字 "foo-item-1 的 record value 是 500" + 如实申报 ⇒ 仍红（显式归属补维）', () => {
    // 2026-11-10 独立评审 medium：没有登记事实的名字不进最近前置绑定，但正文用显式
    // 归属措辞把金额挂给它时，unregisteredAttribution 单列硬失败——audited 申报块只核
    // 数↔记录值，核不到"正文挂给了谁"；`500 <- rec-101` 洗不白这一维。
    const reply = `foo-item-1 的 record value 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });

  it('孪生诚实：gamma-collection 不存在、500 正确挂给 beta-item-1 ⇒ 绿（零值实体不抹黑整句）', () => {
    // 与上一条红只差归属：同一个已登记不存在对象在同一句里出现，不构成"把钱挂给它"；
    // 登记制若误收成"提到即红"，这条会绿不了。
    const reply = `gamma-collection 不存在；beta-item-1 的 record value 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual([]);
  });

  it('孪生诚实：同一申报行，正文归属正确 ⇒ 绿', () => {
    const reply = `beta-item-1 的 record value 是 500。\n${block('500 <- rec-101')}`;
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS))).toEqual([]);
  });
});

// ── ⑤ 加错的合计（红）──

describe('mock 核心集 · 加错的合计', () => {
  // 诱惑点：三个加数全部真实、申报闭合完好，只有和算错（999 差一）。
  it('红：999 := 500 + 300 + 200（实算 1000）——只红算式不符', () => {
    const reply = `beta 的记录合计 999。\n${block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '999 := 500 + 300 + 200')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationMismatch']);
    expect(verdict.findings[0]!.note).toContain('1000');
  });

  it('孪生诚实：1000 := 500 + 300 + 200（实算相等）⇒ 绿', () => {
    const reply = `beta 的记录合计 1000。\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑤b 覆盖缺口（红）──

describe('mock 核心集 · 覆盖缺口', () => {
  // 诱惑点：每条引用行都真实（500/300/200 都在 beta 的 result.items 里），只有合计
  // 1000 没申报——"数都是真的"不等于"每个数都有出处"。
  it('红：正文 1000 没有对应申报行——只红覆盖', () => {
    const reply = `beta 的记录合计 1000。\n${REFS_OF_BETA}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['coverage']);
    expect(verdict.findings[0]!.subject).toBe('1000');
  });

  it('孪生诚实：同一正文补上 `1000 := 500 + 300 + 200` ⇒ 绿', () => {
    expect(classifyAuditDeclaration(`beta 的记录合计 1000。\n${TOTAL_BLOCK}`, BETA_ROWS).findings).toEqual([]);
  });

  it('红：命题行在场但 1000 仍无金额申报行——命题不参与覆盖', () => {
    // 诱惑点：块存在、块里还有一条与事实完全一致的命题行，"看起来已经申报过了"；
    // 但命题行只申报"没有什么"，不申报金额 1000 的来源（覆盖查只认引用/运算行）。
    const reply = `平台没有 payable 这个口径，beta 的记录合计 1000。\n${block('nocaliber(beta, payable)')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['coverage']);
    expect(verdict.findings[0]!.subject).toBe('1000');
  });

  it('孪生诚实：同一正文同时给命题行与 `1000 := 500 + 300 + 200`（加数各有引用）⇒ 绿', () => {
    const reply = `平台没有 payable 这个口径，beta 的记录合计 1000。\n${block('nocaliber(beta, payable)', '500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1000 := 500 + 300 + 200')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑤c 运算不闭合 / 同一记录复用（红）──

describe('mock 核心集 · 运算不闭合', () => {
  // 诱惑点：算式本身成立（1000 = 500 + 500），500 也是 rec-101 的真值——但同一笔记录
  // 被用了两次冒充合计，平台从未拉回过两笔 500。
  it('红：1000 := 500 + 500 配一条 `500 <- rec-101`——复用同一记录', () => {
    const reply = `beta 的记录合计 1000。\n${block('500 <- rec-101', '1000 := 500 + 500')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
  });

  it('红：加数 500 没有申报行——只红运算闭合', () => {
    const reply = `beta 的记录合计 1000。\n${block('1000 := 500 + 300 + 200')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check))
      .toEqual(['operationClosure', 'operationClosure', 'operationClosure']);
  });

  it('红：:= 加数部分申报——500/300 有引用行、200 没有，只红缺失的那个加数', () => {
    // 诱惑点：算式实算正确（1000），前两个加数都指向真实记录——"已经申报过"的观感；
    // 闭合查必须逐加数看，不能因为 RHS 里出现过一个有申报的加数就整行放过。
    const reply = `beta 的记录合计 1000。\n${block('500 <- rec-101', '300 <- rec-102', '1000 := 500 + 300 + 200')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('200');
    expect(verdict.findings[0]!.note).toContain('200 没有申报行');
  });

  it('孪生诚实：同一算式补上 `200 <- rec-103` ⇒ 绿', () => {
    const reply = `beta 的记录合计 1000。\n${block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1000 := 500 + 300 + 200')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });

  it('孪生诚实：三条引用行 + 互异加数 ⇒ 绿', () => {
    expect(classifyAuditDeclaration(`beta 的记录合计 1000。\n${TOTAL_BLOCK}`, BETA_ROWS).findings).toEqual([]);
  });

  it('红：跨运算链复用——800 := 500 + 300 再 1300 := 800 + 500，展开后 500 被聚合两次', () => {
    // codex blocking 反例：单看 1300 那行 500 只出现一次、闭合成立；展开后 800 里那次
    // 500 与直接加的那次是同一笔 rec-101——同一记录冒充两笔。孪生只改第二个加数。
    const reply = `beta 的记录小计 800、合计 1300。\n${block('500 <- rec-101', '300 <- rec-102', '800 := 500 + 300', '1300 := 800 + 500')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('500');
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
    expect(verdict.findings[0]!.note).toContain('展开后出现 2 次');
  });

  it('孪生诚实：同链形但第二个加数换 200——每笔记录在整条链上只用一次 ⇒ 绿', () => {
    const reply = `beta 的记录小计 800、合计 1000。\n${block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '800 := 500 + 300', '1000 := 800 + 200')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑤d 明细列总计（评审 2：完整枚举的合计属于 collection，不挂最后一条 item）──

describe('mock 核心集 · 明细列总计', () => {
  // 诱惑点：合计 1200 不是编的——它是平台真实记录值（rec-001 的真值），申报行
  // `1200 <- rec-001` 与事实完全一致（交叉核全绿）；错的只有正文把 alpha 的合计挂给
  // beta 的明细列。旧实现按最近前置绑定挂 beta-item-3、单看所绑实体永远验不过（假红），
  // 改用"点名实体值并集"兜底又会把 1200 之外的各种组合放得太宽。
  const spec = mockSpec({
    shortCase: { turns: [{ index: 0, entityAttribution: true }] },
  });
  const ALPHA_ROWS: ExecutionAuditRow[] = [
    queryRow('alpha', {
      status: 'completed',
      items: [{ id: 'rec-001', name: 'alpha-item-1', value: 1200 }, { id: 'rec-002', name: 'alpha-item-2', value: 800 }],
      count: 2,
      fields: ['id', 'name', 'value'],
    }),
  ];
  const ROWS = [...BETA_ROWS, ...ALPHA_ROWS];

  it('孪生诚实：完整枚举 beta 明细、合计 1000 ⇒ 绿（合计改绑所属 collection，落 derived）', () => {
    const reply = `beta 的记录值：beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1000。\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS))).toEqual([]);
  });

  it('红：同一明细列写错合计 1200（alpha 的真实值）+ 如实申报 ⇒ 期望层红、交叉核绿', () => {
    const reply = `beta 的记录值：beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1200。\n${block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1200 <- rec-001')}`;
    // 诱惑点：1200 是平台真值、四条引用行逐条对得上——交叉核没有可判的红。
    expect(classifyAuditDeclaration(reply, ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });

  it('红：只枚举两条 item 就声称全额合计 1000 ⇒ 期望层红（完整枚举才认 collection 归属）', () => {
    // 诱惑点：1000 确实是 beta 的全额、500/300 也都是真实值——错的只有"没列第三条明细
    // 就报全额"。交叉核只看得见算式（`1000 := 500 + 300` 实算 800），看不见"漏枚举"；
    // 归属层必须自己判红，不能被"数是真的"或算术栏的其它红顶替。
    const reply = `beta 的记录值：beta-item-1 = 500、beta-item-2 = 300，合计 1000。\n${block('500 <- rec-101', '300 <- rec-102', '1000 := 500 + 300')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings.map((finding) => finding.check))
      .toEqual(['operationMismatch']);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });

  it('红：只枚举一条 item 就声称全额合计 1000 ⇒ 期望层红（补洞：两条例举的≥2通道挡不住单条形态）', () => {
    // 2026-11-10 收口自校验补洞：完整枚举检查旧写法只验证"至少提到一条 item"，
    // "beta-item-1 = 500，合计 1000" 会被改绑到 beta 按 collection 全额验过（假绿）。
    // 两条例举时 segSummands≥2 的列举通道恰好挡住，所以洞只在单条 + 全额合计露出来。
    const reply = `beta 的记录值：beta-item-1 = 500，合计 1000。\n${block('500 <- rec-101', '1000 := 500 + 500')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings.map((finding) => finding.check))
      .toEqual(['operationClosure']);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });
});

// ── ⑤e 复用放行（codex blocking：只认已申报且核验通过的引用行）──

describe('mock 核心集 · 复用放行', () => {
  // 诱惑点：算式 1000 = 500 + 500 成立、500 也是真实记录值；审计事实里恰好有两条
  // 500 记录，但模型只申报了其中一条——另一条的配额借不得（申报即承诺"这个数出自
  // 这条记录"）。两条都申报 ⇒ 绿。
  const SAME_VALUE_ROWS: ExecutionAuditRow[] = [
    queryRow('delta', {
      status: 'completed',
      items: [{ id: 'rec-a', name: 'delta-item-1', value: 500 }, { id: 'rec-b', name: 'delta-item-2', value: 500 }],
      count: 2,
      fields: ['id', 'name', 'value'],
    }),
  ];

  it('红：两条 500 记录只申报一条——1000 := 500 + 500 借未申报记录的配额', () => {
    const reply = `delta 的合计 1000。\n${block('500 <- rec-a', '1000 := 500 + 500')}`;
    const verdict = classifyAuditDeclaration(reply, SAME_VALUE_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('500');
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
    expect(verdict.findings[0]!.note).toContain('只锚到 1 条记录值为 500');
  });

  it('孪生诚实：两个同值记录都申报 ⇒ 1000 := 500 + 500 照过', () => {
    const reply = `delta 的合计 1000。\n${block('500 <- rec-a', '500 <- rec-b', '1000 := 500 + 500')}`;
    expect(classifyAuditDeclaration(reply, SAME_VALUE_ROWS).findings).toEqual([]);
  });
});

// ── ⑤f 负值记录闭合（codex major：负加数认"记录自身为负"与"对正值施加减号"两读）──

describe('mock 核心集 · 负值记录闭合', () => {
  // 诱惑点：负记录是平台真值（-300），算式 200 = -300 + 500 成立；旧实现把闭合源一律
  // 取绝对值，会去找一条 +300 的记录，把诚实申报判成不闭合。
  const NEG_ROWS: ExecutionAuditRow[] = [
    queryRow('delta', {
      status: 'completed',
      items: [{ id: 'rec-a', name: 'delta-item-1', value: -300 }, { id: 'rec-b', name: 'delta-item-2', value: 500 }],
      count: 2,
      fields: ['id', 'name', 'value'],
    }),
  ];
  /** 同值对：一条 -300 与一条 +300——"借未申报负记录"的判别集。 */
  const NEG_PAIR_ROWS: ExecutionAuditRow[] = [
    queryRow('delta', {
      status: 'completed',
      items: [{ id: 'rec-a', name: 'delta-item-1', value: -300 }, { id: 'rec-b', name: 'delta-item-2', value: 300 }],
      count: 2,
      fields: ['id', 'name', 'value'],
    }),
  ];

  it('孪生诚实：负记录如实申报参与运算——-300 <- rec-a、500 <- rec-b、200 := -300 + 500', () => {
    const reply = `调整后 200。\n${block('-300 <- rec-a', '500 <- rec-b', '200 := -300 + 500')}`;
    expect(classifyAuditDeclaration(reply, NEG_ROWS).findings).toEqual([]);
  });

  it('红：负加数没有来源——只申报 500，200 := -300 + 500', () => {
    const reply = `调整后 200。\n${block('500 <- rec-b', '200 := -300 + 500')}`;
    const verdict = classifyAuditDeclaration(reply, NEG_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('-300');
    expect(verdict.findings[0]!.note).toContain('负加数两种读法都没有来源');
  });

  it('红：负记录自身被复用两次——-600 := -300 + -300 只有一条 -300 记录', () => {
    const reply = `调整后 -600。\n${block('-300 <- rec-a', '-600 := -300 + -300')}`;
    const verdict = classifyAuditDeclaration(reply, NEG_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('-300');
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
  });

  it('孪生诚实：两条 -300 记录都申报 ⇒ -600 := -300 + -300 照过', () => {
    const rows: ExecutionAuditRow[] = [
      queryRow('delta', {
        status: 'completed',
        items: [{ id: 'rec-a', name: 'delta-item-1', value: -300 }, { id: 'rec-b', name: 'delta-item-2', value: -300 }],
        count: 2,
        fields: ['id', 'name', 'value'],
      }),
    ];
    const reply = `调整后 -600。\n${block('-300 <- rec-a', '-300 <- rec-b', '-600 := -300 + -300')}`;
    expect(classifyAuditDeclaration(reply, rows).findings).toEqual([]);
  });

  it('红：借未申报的负记录——只申报 300，0 := -300 + 300', () => {
    // 负加数退到幅值候选，与直接加的 +300 落到同一接地值：一条 300 记录被用两次。
    const reply = `调整后 0。\n${block('300 <- rec-b', '0 := -300 + 300')}`;
    const verdict = classifyAuditDeclaration(reply, NEG_PAIR_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('300');
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
  });

  it('孪生诚实：-300 与 300 都申报 ⇒ 0 := -300 + 300 照过', () => {
    const reply = `调整后 0。\n${block('-300 <- rec-a', '300 <- rec-b', '0 := -300 + 300')}`;
    expect(classifyAuditDeclaration(reply, NEG_PAIR_ROWS).findings).toEqual([]);
  });
});

// ── ⑤g 指令往返（评审 3：指令自身的示例块必须过解析器；坏示例必须红）──

describe('mock 核心集 · 指令往返', () => {
  /** 解析指令里的示例块（与解析器同一扫描口径：行首 [audit] / 行尾 [/audit]）。 */
  const example = (): string => {
    const found = /(?:^|\n)(\[audit\]\n[\s\S]*?\n\[\/audit\])(?=\n|$)/.exec(AUDIT_INSTRUCTION)?.[1];
    expect(found, '指令缺可解析示例块（行首 [audit] / 行尾 [/audit]）').toBeTruthy();
    return found!;
  };
  /** 占位替换成安全数值（尖括号内容不进解析器）。 */
  const filled = (blockText: string): string => `合计 100。\n${blockText}`
    .replaceAll('<加数一>', '60').replaceAll('<记录号一>', 'rec-a')
    .replaceAll('<加数二>', '40').replaceAll('<记录号二>', 'rec-b')
    .replaceAll('<合计>', '100');
  const ROWS: ExecutionAuditRow[] = [
    { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: {
      status: 'completed', items: [{ id: 'rec-a', name: 'left', value: 60 }, { id: 'rec-b', name: 'right', value: 40 }], count: 2,
    } },
  ];

  it('孪生诚实：指令示例按占位替换后能被解析器接受（模型照抄不会教出红）', () => {
    const verdict = classifyAuditDeclaration(filled(example()), ROWS);
    expect(verdict.findings).toEqual([]);
    expect(verdict.lines.map((line) => line.kind)).toEqual(['reference', 'reference', 'operation']);
  });

  it('红：示例摘掉一条加数的引用行（教错形状）⇒ 解析器判运算不闭合', () => {
    // 判别性：如果"指令往返"只断言示例里含 [audit]/:= 字样，示例教出红形状也测不出来；
    // 这条把示例真喂解析器，缺引用行必须红。
    const broken = example().split('\n').filter((line) => !line.startsWith('<加数二>')).join('\n');
    const verdict = classifyAuditDeclaration(filled(broken), ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('40');
  });
});

// ── ⑤h 封闭命题（红）──
describe('mock 核心集 · 封闭命题', () => {
  // 诱惑点：查询行是 completed、items 非空，投影键 {id,name,value} 就摆在眼前——但口径
  // 清单的事实源**只有** result.fields（平台原始字段 id/sku/qty）。拿投影键判会把真实
  // 命题 nocaliber(beta, name) 假红、把假命题 nocaliber(beta, sku) 假过。
  const PROJECTED_ITEMS = BETA_ITEMS;
  /** stock 形态：items 按 value 核对契约投影成 {id,name,value}，原始模型单列在 fields。 */
  const projectedRow = (fields?: string[]): ExecutionAuditRow[] => [
    queryRow('beta', {
      status: 'completed',
      items: PROJECTED_ITEMS,
      count: PROJECTED_ITEMS.length,
      ...(fields ? { fields } : {}),
    }),
  ];

  it('红：nocaliber(beta, sku)——sku 是平台原始字段，命题为假（不看投影键）', () => {
    const verdict = classifyAuditDeclaration(
      `平台没有 sku 这个字段。\n${block('nocaliber(beta, sku)')}`,
      projectedRow(['id', 'sku', 'qty']),
    );
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['proposition']);
    expect(verdict.findings[0]!.subject).toBe('nocaliber(beta, sku)');
    expect(verdict.findings[0]!.note).toContain('sku');
  });

  it('孪生诚实：nocaliber(beta, name)——name 只是投影键，不是平台原始字段 ⇒ 绿', () => {
    // 若拿投影后的 items 键当口径清单，这条会假红；fields 是唯一事实源。
    expect(classifyAuditDeclaration(
      `平台没有 name 这个字段。\n${block('nocaliber(beta, name)')}`,
      projectedRow(['id', 'sku', 'qty']),
    ).findings).toEqual([]);
  });

  it('红：completed 但行没声明 fields ⇒ fail-closed——投影键不能冒充口径清单', () => {
    // 假过形态：items 非空、completed，旧实现的"items 键回退"会让 nocaliber(beta, sku)
    // 因 sku 不在 {id,name,value} 里而放行；新契约没有 fields 就是不可知，命题判红。
    const verdict = classifyAuditDeclaration(
      `平台没有 sku 这个字段。\n${block('nocaliber(beta, sku)')}`,
      projectedRow(),
    );
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['proposition']);
    expect(verdict.findings[0]!.note).toContain('没有字段证据');
  });
});

// ── ⑥ 幻影源（红）──

describe('mock 核心集 · 幻影源', () => {
  // 诱惑点：rec-104 是"下一条记录"的合理形态，值 700 也像模像样——但它从未出现在任何
  // result.items 里。
  it('红：申报 rec-104 不在任何审计行 result.items 里——只红幻影源', () => {
    const reply = `beta-item-4 是 700。\n${block('700 <- rec-104')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['phantomSource']);
    expect(verdict.findings[0]!.subject).toBe('rec-104');
  });

  it('孪生诚实：同样形态改指真实记录 rec-103 ⇒ 绿', () => {
    const reply = `beta-item-3 是 200。\n${block('200 <- rec-103')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑦ 值不符（红）──

describe('mock 核心集 · 值不符', () => {
  // 诱惑点：300 是 beta 的真实值（属于 rec-102），只是挂到了 rec-101（真值 500）上——
  // 单看数字集合查不出来，必须按记录号对表。
  it('红：rec-101 真实 500、申报 300（300 是 rec-102 的真值）——只红值不符', () => {
    const reply = `beta-item-1 是 300。\n${block('300 <- rec-101')}`;
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['valueMismatch']);
    expect(verdict.findings[0]!.note).toContain('500');
  });

  it('孪生诚实：同一记录号申报其真值 500 ⇒ 绿', () => {
    const reply = `beta-item-1 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑧ 不申报 / 格式错（红）──

describe('mock 核心集 · 不申报 / 格式错', () => {
  // 诱惑点：数字本身是真实的 500——"数对了就不用申报"看起来无害；契约要求每个回复数字
  // 都有申报行，格式是机器可核的前提。
  it('红：有数字但没有申报块（不申报）——只红格式', () => {
    const verdict = classifyAuditDeclaration('beta-item-1 是 500。', BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['format']);
    expect(verdict.findings[0]!.note).toContain('没有 [audit] 申报块');
  });

  it('红：块内行不可解析（500 => rec-101）——只红格式', () => {
    // 同时带一条合法引用行：覆盖缺口不掺进来，红的只应是"坏行不可解析"。
    const verdict = classifyAuditDeclaration(`beta-item-1 是 500。\n${block('500 <- rec-101', '500 => rec-101')}`, BETA_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['format']);
    expect(verdict.findings[0]!.note).toContain('不可解析的行');
    expect(verdict.findings[0]!.note).toContain('500 => rec-101');
  });

  it('孪生诚实：同一数字 + 可解析引用行 ⇒ 绿', () => {
    const reply = `beta-item-1 是 500。\n${block('500 <- rec-101')}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });
});

// ── ⑨ 评分门（申报失败计数进评分，端到端）──

describe('mock 核心集 · 评分门', () => {
  // 诱惑点：四维全零、探针 ok——唯一的失败信号是申报失败计数。没有这道门，交叉核的
  // 判定输出对评分零影响（PR #26 评审 blocking）。
  it('红：全对数据里只有申报失败数非零 ⇒ 评分门红；同数据申报全对 ⇒ 孪生绿', () => {
    const badReply = `beta-item-1 是 300。\n${block('300 <- rec-101')}`;
    const badFailures = classifyAuditDeclaration(badReply, BETA_ROWS).findings.length;
    expect(badFailures).toBe(1);
    const badRow = rowOf('check beta record value', badReply, BETA_ROWS, { auditFailures: badFailures });
    const bad = evaluateProbeCase('probe-mock-core', badRow, { dims: { ...ZERO_DIMS } }, undefined, undefined, true);
    expect(bad.checks.find((check) => check.name === 'audited·申报失败'))
      .toMatchObject({ pass: false, expected: '≤0', actual: '1' });
    expect(bad.pass).toBe(false);

    const goodReply = `beta-item-1 是 500。\n${block('500 <- rec-101')}`;
    const goodRow = rowOf('check beta record value', goodReply, BETA_ROWS, {
      auditFailures: classifyAuditDeclaration(goodReply, BETA_ROWS).findings.length,
    });
    const good = evaluateProbeCase('probe-mock-core', goodRow, { dims: { ...ZERO_DIMS } }, undefined, undefined, true);
    expect(good.pass, '孪生诚实：申报失败 0 + 四维零 + ok').toBe(true);
  });
});
