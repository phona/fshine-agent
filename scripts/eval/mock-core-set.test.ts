/**
 * mock 核心集：harness 的 per-push 硬门（路线图第 4 项）。
 *
 * 每个失败类一条用例，每条旁边站它的**孪生诚实形态**：同一份脚本化审计行、同一份数据，
 * 只改一个判别点。红例全部保留一个诱惑点（数本身真实 / 记录号形似真号 / 申报诚实但归属
 * 错 / 合计只差一 / 数字正确所以"省掉申报"看起来无害……）——没有判别性的断言只是在测
 * 魔术字符串。
 *
 * 驱动面全部是导出的纯判定函数（`classifyAuditDeclaration` / `expectationChecksOf` /
 * `evaluateProbeCase` / `unifiedCasePassedOf` / `caseCrashOf`）：脚本化回复（含申报块）+
 * 脚本化审计行（含 result.status/items/count/fields——fields 是 nocaliber 命题的口径
 * 清单事实源），不跑模型、不跑探针、不碰真实平台（import 探针模块由入口守卫保证不执行
 * main()，见 `probe-real-agent.test.ts` 的子进程 import 锁）。进 vitest unit project ⇒
 * `scripts/ci.sh` 的 `npm run test -- --project unit` 每次 push 自动跑（不另造 npm
 * script / ci.sh 行）。
 *
 * 数据从简：beta 三条记录（rec-101/102/103 = 500/300/200）+ gamma 一条 not_found 审计行。
 * 数值必须与 `scripts/eval/dummy-fixture.ts` 的种子一致——期望值层的口径/归属判定直接
 * 消费那张事实表，换数字会让"诚实佐证"变成另一个判据的输入。例外：复用放行/负值记录
 * 两组钉的是交叉核的**记录级**规则（同一记录不得复用、负记录符号两种读法），审计行是
 * 脚本事实、不喂期望值层，故另立最小记录集（rec-a/rec-b），不用 seed 值凑形态。
 *
 * 隐私纪律（2026-11-10 收口；评审 9 修正守备边界）：本文件的样本名一律中性夹具词（beta /
 * gamma / rec-* / contoso-trade）。`packages/agent/exposure-lint.test.ts` 的 B 类零命中
 * 守卫**只覆盖映射表 C 组登记过的名字**（扫 `git ls-files` 全量、禁词表拆段 + sha256
 * 自校验）——**不在词表内的客户名它拦不到**，不能把 B 类写成所有真实客户名的回归锁。
 * 本波回填的那个客户名（已脱敏，不在 B 类）靠人工补扫发现；本文件不另立第二张禁词表，
 * 也**不声称**有守卫覆盖它。
 *
 * 自校验（本文件的存在理由）：把任一判据改坏（恒放过），对应红例的**判定输出**必须变绿——
 * 断言红例的那条测试因此转红；还原判据后复绿。逐条变异证据留在 PR 的 mutationProof 里；
 * 测试本身不写"变异模式"开关——判据只有一份，改坏就红。
 */
import { describe, expect, it } from 'vitest';
import {
  anyExecutedCall, caseCrashOf, executedCallsTotal, firstTurnPlanCallsNote, fiveTurnCallsNote,
  planResumeState, realAmounts, recallMissed, unifiedCasePassedOf, type Turn,
} from '../probe-real-agent';
import { classifyErrorStateAmounts, extractAmounts } from './amount-criteria';
import { classifyAuditDeclaration } from './audit-declaration';
import { AUDIT_INSTRUCTION } from './audit-instruction';
import { loadCases, type CaseExpectations, type CaseSpec } from './cases';
import type { ExecutionAuditRow } from './evidence';
import { buildUnifiedReport } from './report';
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

  it('红：未登记名字的 total 族归属同样硬失败——"foo-collection total is 1000" + 如实申报', () => {
    // 2026-11-10 独立评审 medium：unregisteredAttribution 的归属词表原来只收
    // value/balance/记录值/值/余额，"total/合计/加总/求和"逃出窄闸 ⇒ audited 申报块把
    // "把真实合计显式挂给未登记名字"洗成绿。已登记的 gamma 同句走 misattributed，
    // 尺子必须一致。诱惑点：1000 是前句 beta 500+300+200 的真实合计，申报与算式全对。
    const prose = 'beta 的 record value 是 500、300、200。foo-collection total is 1000.';
    const reply = `${prose}\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与算式全对').toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
    // 已登记名字的孪生：同一形态（同分句显式 total 归属）仍走 misattributed。
    const twin = `beta 的 record value 是 500、300、200。gamma-collection total is 1000.\n${TOTAL_BLOCK}`;
    expect(failingExpectationNames(spec, rowOf('check beta record value', twin, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });

  it('红：合计/加总/求和/总计措辞把真实合计挂给未登记名字同样硬失败；孪生 beta 同措辞 ⇒ 绿', () => {
    // 诱惑点：1000 是 beta 500+300+200 的真实合计，申报与算式全对；唯一判别点是归属
    // 措辞从英文 "total is" 换成了中文同义族（合计/加总/求和/总计）——词表只在英文侧
    // 收全时，这些句子会被 audited 申报块洗成绿（unregisteredAttribution 的窄闸漏词）。
    for (const wording of ['合计', '加总', '求和', '总计']) {
      const prose = `beta 的 record value 是 500、300、200。foo-collection 的${wording}是 1000.`;
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
      expect(verdict.unregisteredAttribution.map((amount) => amount.value), wording).toEqual([1000]);
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与算式全对').toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), wording)
        .toEqual(['期望·张冠李戴(第1轮)']);
      // 孪生：同一措辞挂给真实合计的所有者 beta ⇒ derived，不记归属失败。
      const twinProse = `beta 的 record value 是 500、300、200。beta 的${wording}是 1000.`;
      expect(failingExpectationNames(spec, rowOf('check beta record value', `${twinProse}\n${TOTAL_BLOCK}`, BETA_ROWS)), wording)
        .toEqual([]);
    }
  });

  it('红：total 族边界——无系词 / 所有格倒装 / 总额族挂给未登记名字，audited 仍红', () => {
    // 2026-11-10 独立评审 medium：词表只收 value/balance/total is 时，下面这些同义形态的
    // unregisteredAttribution 为空；1000 又因 TOTAL_FRAMING_RE+replyRealValues 降 derived
    // ⇒ audited 申报块全绿。逐句钉住边界（诱惑点同上：申报与算式全对）。
    for (const claim of [
      'foo-collection 合计 1000',
      'foo-collection total 1000',
      "1000 is foo-collection's total",
      '1000 是 foo-collection 的总额',
      'foo-collection 总额是 1000',
      'foo-collection 总和是 1000',
      'foo-collection 共计 1000',
      'foo-collection 小计是 1000',
      'foo-collection 总数是 1000',
      'foo-collection sum is 1000',
      'foo-collection combined is 1000',
    ]) {
      const prose = `beta 的 record value 是 500、300、200。${claim}。`;
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
      expect(verdict.unregisteredAttribution.map((amount) => amount.value), claim).toEqual([1000]);
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与算式全对').toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), claim)
        .toEqual(['期望·张冠李戴(第1轮)']);
    }
  });

  it('诚实 "beta 的总计是 1000" 不判张冠李戴——总计 已进合计框架词表（旧已知残余转绿）', () => {
    // 2026-11-10 独立评审核对 finding 1 时发现：只把 total 族补进倒装归属而不补
    // TOTAL_FRAMING_RE，会把诚实的 "beta 的总计是 1000" 从假绿翻成假红。总计 与
    // 合计/加总/求和 同族，框架词表同步收；诚实合计落 derived，未登记名字侧仍红（上一条）。
    const verdict = classifyErrorStateAmounts(
      'beta 的 record value 是 500、300、200。beta 的总计是 1000.',
      'checkbeta的payablebalance',
      extractAmounts,
    );
    expect(verdict.misattributed).toEqual([]);
    expect(verdict.unattributed).toEqual([]);
    expect(verdict.derived.map((amount) => amount.value)).toEqual([1000]);
    const reply = `beta 的 record value 是 500、300、200。beta 的总计是 1000.\n${TOTAL_BLOCK}`;
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS))).toEqual([]);
  });

  it('红：倒装 total 归属给已登记零值实体（gamma-collection）同样硬失败——三种形态', () => {
    // 2026-11-10 独立评审 high：attributesToFollowingEntity 只认 value/balance，金额在前、
    // 实体在后的 total 归属绕过倒装通道 ⇒ 1000 落 derived，audited 申报块全绿。已登记
    // 零值实体的任何非零归属都是假归属，三种分支（of / 所有格 / 中文）各自钉住。
    for (const claim of [
      "1000 is gamma-collection's total.",
      '1000 is the total of gamma-collection.',
      '1000 是 gamma-collection 的合计。',
    ]) {
      const prose = `beta 的 record value 是 500、300、200。${claim}`;
      const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
      expect(verdict.misattributed.map((amount) => amount.value), claim).toEqual([1000]);
      expect(verdict.derived, claim).toEqual([]);
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与算式全对').toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), claim)
        .toEqual(['期望·张冠李戴(第1轮)']);
    }
  });

  it('不假红：普通复合词 / 已登记名字的自然别名不出「未登记名字」硬失败（audited 路径）', () => {
    // 2026-11-10 独立评审 low：形状闸把 *-item / *-record 当夹具实体、把 beta-collection
    // 当未登记名字 ⇒ audited 申报块全对仍出归属硬 note。判别点 = 名字形状证据。
    for (const [prose, auditBlock] of [
      ['line-item value is 500. Please confirm.', block('500 <- rec-101')],
      ['data-record value is 500. Please confirm.', block('500 <- rec-101')],
      ['beta 的 record value 是 500、300、200。beta-collection total is 1000.', TOTAL_BLOCK],
    ] as const) {
      const reply = `${prose}\n${auditBlock}`;
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, prose).toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), prose)
        .toEqual([]);
    }
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

// ── ④b 零值实体不进 pool 源（评审 1 原句：同分句幽灵名 + 总计）──

describe('mock 核心集 · 零值实体不进 pool 源', () => {
  // 诱惑点：gamma-collection 是平台真实答过 not_found 的已登记对象（不是乱写的名字），
  // 1000 又是前句 beta 500+300+200 的真实合计——旧实现把零值实体收进 specific，
  // pool 从全回复真实值退化成空池，未绑定的 1000 被 clause 级 misbound 记成"挂给
  // gamma"（假红）。修法只把零值实体挡在 pool 源外：显式归属（"gamma-collection
  // total is 1000"）仍走 misbound 判红，不能借 pool 回退一起洗白。
  const spec = mockSpec({
    shortCase: { turns: [{ index: 0, entityAttribution: true }] },
  });

  it('孪生诚实（评审 1 原句）：同分句 "gamma-collection not found, total is 1000" ⇒ derived，不记张冠李戴', () => {
    const prose = 'beta 的 record value 是 500、300、200。gamma-collection not found, total is 1000.';
    const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
    // 纯核层钉完整 verdict：1000 是前句的合计（derived），不是 gamma 的总计。
    expect(verdict.misattributed).toEqual([]);
    expect(verdict.unattributed).toEqual([]);
    expect(verdict.derived.map((amount) => amount.value)).toEqual([1000]);
    const reply = `${prose}\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS))).toEqual([]);
  });

  it('孪生诚实：零值实体的自然同义免责句与 "not found" 同判（has no records / doesn\'t exist / 中没有记录 / is empty）', () => {
    // 2026-11-10 独立评审 high：模型不会照抄 "not found"。免责词表只认旧字面时，
    // 零值实体仍是最近前置归属人，真实合计被记成张冠李戴（纯核 mis:[1000]，期望值层
    // 报「期望·张冠李戴」）。每条都在同一条 beta 前句 + 真实申报下判绿。
    const disclaimers = [
      'empty-one has no records',
      "gamma-collection doesn't exist",
      // 裸 "no such collection" 不含实体名 ⇒ 不能切断任何归属，是空测；带实体名才钉词表项。
      'gamma-collection: no such collection',
      'gamma-collection 中没有记录',
      'gamma-collection is empty',
    ];
    for (const disclaimer of disclaimers) {
      const prose = `beta 的 record value 是 500、300、200。${disclaimer}, total is 1000.`;
      const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
      expect(verdict.misattributed, disclaimer).toEqual([]);
      expect(verdict.unattributed, disclaimer).toEqual([]);
      expect(verdict.derived.map((amount) => amount.value), disclaimer).toEqual([1000]);
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, disclaimer).toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), disclaimer).toEqual([]);
    }
  });

  it('红：五形态免责句下不可验的 1600 不能借免责洗白——免责只切断归属，不免除算账', () => {
    // 诱惑点：免责句读起来像"这一句不用管"，1600 也只比 beta 实计 1000 多 600（600 还是
    // contoso-trade 的真实值）——数字像模像样。但回复里可见的加数只有 beta 的 500/300/200，
    // 1600 算不出来。免责只把金额从最近前置绑定里摘出去（detached），摘出去之后仍要过
    // 摊账/可见实体聚合验证；把免责当算术赦免会让编造合计整体转绿。
    const disclaimers = [
      'empty-one has no records',
      "gamma-collection doesn't exist",
      'gamma-collection: no such collection',
      'gamma-collection 中没有记录',
      'gamma-collection is empty',
    ];
    for (const disclaimer of disclaimers) {
      const red = classifyErrorStateAmounts(
        `beta 的 record value 是 500、300、200。${disclaimer}, total is 1600.`,
        'checkbeta的payablebalance',
        extractAmounts,
      );
      expect(red.unattributed.map((amount) => amount.value), disclaimer).toEqual([1600]);
      expect(red.misattributed, disclaimer).toEqual([]);
      expect(red.derived, disclaimer).toEqual([]);
      // 孪生（同五形态、同一分句骨架）：只把合计换回真实的 1000 ⇒ derived。
      const twin = classifyErrorStateAmounts(
        `beta 的 record value 是 500、300、200。${disclaimer}, total is 1000.`,
        'checkbeta的payablebalance',
        extractAmounts,
      );
      expect(twin.derived.map((amount) => amount.value), disclaimer).toEqual([1000]);
      expect(twin.unattributed, disclaimer).toEqual([]);
    }
  });

  it('孪生诚实：同分句有值实体（不是来源）+ 免责零值实体 + 真实合计 ⇒ derived，不记张冠李戴', () => {
    // 2026-11-10 独立评审 medium：上一版只覆盖「本分句无有值实体」的 pool 回退。同一
    // 分句里 alpha 有值（1200）但 1000 不是它的合计——旧实现跳过 gamma 后把 1000 绑给
    // alpha，specific 非空 ⇒ 张冠李戴。免责提及是归属边界，金额退回全回复摊账通道。
    const alphaItems = [
      { id: 'rec-001', name: 'alpha-item-1', value: 1200 },
      { id: 'rec-002', name: 'alpha-item-2', value: 800 },
    ];
    const alphaRows: ExecutionAuditRow[] = [
      ...BETA_ROWS,
      queryRow('alpha', { status: 'completed', items: alphaItems, count: alphaItems.length, fields: ['id', 'name', 'value'] }),
    ];
    const prose = 'beta 的 record value 是 500、300、200。alpha 的 record value 是 1200，gamma-collection not found, total is 1000.';
    const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
    expect(verdict.misattributed).toEqual([]);
    expect(verdict.unattributed).toEqual([]);
    expect(verdict.derived.map((amount) => amount.value)).toEqual([1000]);
    const reply = `${prose}\n${block('500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1200 <- rec-001', '1000 := 500 + 300 + 200')}`;
    expect(classifyAuditDeclaration(reply, alphaRows).findings, '诱惑点：申报与算式全对').toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, alphaRows))).toEqual([]);
    // 红不松：同一分句去掉免责措辞（gamma 只是显式 total 归属）⇒ 张冠李戴仍红。
    const twin = 'beta 的 record value 是 500、300、200。alpha 的 record value 是 1200，gamma-collection total is 1000.';
    expect(classifyErrorStateAmounts(twin, 'checkbeta的payablebalance', extractAmounts)
      .misattributed.map((amount) => amount.value)).toEqual([1000]);
  });

  it('红：detached 合计只认"可见实体的完整聚合"——只列 alpha 的 1200 却报其全额 2000 ⇒ 无据', () => {
    // 诱惑点：2000 确实是 alpha 的 1200+800 全额，来源真实、算术成立；代理只抄了 1200
    // 就报全额——800 不在回复里，"可见"的加数凑不出 2000。免责切断归属后，若按实体
    // 真实值集验而不看可见性，这条会被洗成 derived（部分枚举冒充全额合计）。
    const prose = 'beta 的 record value 是 500、300、200。alpha 的 record value 是 1200，gamma-collection not found, total is 2000.';
    const red = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
    expect(red.unattributed.map((amount) => amount.value)).toEqual([2000]);
    expect(red.misattributed).toEqual([]);
    expect(red.derived).toEqual([]);
    // 孪生：同一分句把 alpha 的两条明细都列出来（1200、800）再报合计 2000 ⇒ 可见完整聚合。
    const twin = classifyErrorStateAmounts(
      'beta 的 record value 是 500、300、200。alpha 的 record value 是 1200、800，gamma-collection not found, total is 2000.',
      'checkbeta的payablebalance',
      extractAmounts,
    );
    expect(twin.derived.map((amount) => amount.value)).toEqual([2000]);
    expect(twin.unattributed).toEqual([]);
    expect(twin.misattributed).toEqual([]);
  });

  it('红：同一分句形但显式归属幽灵名 "gamma-collection total is 1000" + 如实申报 ⇒ 张冠李戴仍红', () => {
    // 诱惑点：1000 是真实合计、`1000 := 500 + 300 + 200` 交叉核全绿——只有正文把它说成
    // gamma 的总计。pool 回退不许把显式归属一起放宽。
    const reply = `gamma-collection total is 1000.\n${TOTAL_BLOCK}`;
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, '诱惑点：申报与算式全对').toEqual([]);
    expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)))
      .toEqual(['期望·张冠李戴(第1轮)']);
  });
});

// ── ④c 归属词表 × 句构矩阵（仲裁 1：audited 端到端逐格钉死）──

describe('mock 核心集 · 归属词表 × 句构矩阵', () => {
  // 诱惑点（每一格共用）：1000 是前句 beta 500/300/200 的真实合计，申报块与算式全对——
  // 漏一个词或一个句构，gamma 侧那一格就从「期望·张冠李戴」洗成 derived（申报块可全额
  // 对上，整轮 audited 绿），foo 侧则漏记未登记归属。四轮评审每轮补一个词/一种句构就是
  // 打地鼠：判据侧三处各维护一份词表，补一处漏两处。
  //
  // 矩阵是**独立于实现的第二份词表**：不从 amount-criteria.ts 的 EN_ATTRIBUTION_NOUNS /
  // CN_ATTRIBUTION_NOUNS 导出（导出即同源枚举，实现换词、测试跟着换，等于没钉住）。
  // 词表 × 句构全矩阵在 amount-criteria.test.ts（纯核层）与这里（audited/期望值层）
  // 各钉一份；实现里换一个词，两处对应格同时红，这就是"换词即一格红"的终止条件。
  //
  // 坐标 = 归属词 × 句构 × 期望（每个 expect 的 message 带当格坐标）：词 17 个 =
  // 直接断言族 {value, balance, 记录值, 值, 余额} ∪ 合计族 {total, sum, combined, 合计,
  // 加总, 求和, 总计, 总额, 总和, 共计, 小计, 总数}；句构 8 个 = 英文 5 + 中文 2 +
  // 跨语言倒装无系词（`1000 = X <词>`）。17×8 **全交叉 = 136 格**：2026-11-10 独立评审
  // high——旧矩阵按语言各跑各的（5×5 + 12×3 = 61），跨语言格（英文词进中文构、中文词进
  // 英文构）从未钉住，`1000 是 X 的 total` 这类实测形态整例假绿。
  // 已登记零值实体 gamma-collection 的 136 格全部张冠李戴；未登记名字 foo-collection
  // 的 136 格全部 unregisteredAttribution；诚实孪生 136 格全绿（合计族用真实全额 1000，
  // 直接断言族用单条真值 500——"beta 的值是 1000"本就是假归属，那正是矩阵红侧钉住的形态）。
  const spec = mockSpec({ shortCase: { turns: [{ index: 0, entityAttribution: true }] } });
  const MATRIX_PREFIX = 'beta 的 record value 是 500、300、200。';
  const MATRIX_EN_NOUNS = ['value', 'balance', 'total', 'sum', 'combined'] as const;
  const MATRIX_CN_NOUNS = ['记录值', '值', '余额', '合计', '加总', '求和', '总计', '总额', '总和', '共计', '小计', '总数'] as const;
  const MATRIX_NOUNS = [...MATRIX_EN_NOUNS, ...MATRIX_CN_NOUNS] as const;
  type Shape = readonly [shape: string, make: (entity: string, noun: string, amount: number) => string];
  const SHAPES: readonly Shape[] = [
    ['正向', (entity, noun, amount) => `${entity} ${noun} is ${amount}`],
    ['所有格正向', (entity, noun, amount) => `${entity}'s ${noun} is ${amount}`],
    ['倒装所有格', (entity, noun, amount) => `${amount} is ${entity}'s ${noun}`],
    ['倒装of', (entity, noun, amount) => `${amount} is the ${noun} of ${entity}`],
    ['无系词', (entity, noun, amount) => `${entity} ${noun} ${amount}`],
    ['中文正向', (entity, noun, amount) => `${entity} 的${noun}是 ${amount}`],
    ['中文倒装', (entity, noun, amount) => `${amount} 是 ${entity} 的${noun}`],
    ['倒装无系词', (entity, noun, amount) => `${amount} = ${entity} ${noun}`],
  ];
  /** 17 词 × 8 构 = 136 格（全交叉）。数量断言防"矩阵被悄悄砍窄"。 */
  const CELL_COUNT = MATRIX_NOUNS.length * SHAPES.length;

  /**
   * 跑一格：纯核判定 + audited 申报交叉核 + 期望值层三条一起取。
   * 申报块永远是 TOTAL_BLOCK（诱惑点：申报与算式全对，红的只可能是归属）。
   */
  const cell = (entity: string, noun: string, make: Shape[1], amount: number) => {
    const prose = `${MATRIX_PREFIX}${make(entity, noun, amount)}。`;
    const reply = `${prose}\n${TOTAL_BLOCK}`;
    return {
      verdict: classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts),
      audit: classifyAuditDeclaration(reply, BETA_ROWS).findings,
      failing: failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)),
    };
  };

  /** 逐格遍历（17 词 × 8 构全交叉），把坐标与三种判定交给调用方断。 */
  const eachCell = (run: (noun: string, shape: string, make: Shape[1]) => void): void => {
    for (const noun of MATRIX_NOUNS) {
      for (const [shape, make] of SHAPES) run(noun, shape, make);
    }
  };

  it('矩阵·已登记零值实体 gamma-collection：17 词 × 8 构 = 136 格全部「期望·张冠李戴」', () => {
    // 逐格诱惑点：1000 是真实合计、申报块与算式全对——漏词/漏构那一格被申报块洗成
    // derived（整轮绿），只有登记事实（gamma 值为空）该让它红。
    expect(CELL_COUNT).toBe(136);
    let cells = 0;
    eachCell((noun, shape, make) => {
      const coordinate = `坐标=gamma × ${noun} × ${shape}`;
      const judged = cell('gamma-collection', noun, make, 1000);
      expect(judged.verdict.misattributed.map((amount) => amount.value), coordinate).toEqual([1000]);
      expect(judged.audit, `${coordinate}（诱惑点：申报与算式全对）`).toEqual([]);
      expect(judged.failing, coordinate).toEqual(['期望·张冠李戴(第1轮)']);
      cells += 1;
    });
    expect(cells).toBe(CELL_COUNT);
  });

  it('矩阵·未登记名字 foo-collection：17 词 × 8 构 = 136 格全部 unregisteredAttribution', () => {
    // 逐格诱惑点：名字是凭空写的（没有登记事实可核），但正文用显式归属措辞把真实合计
    // 挂给它——没有这一维，audited 申报块只核"数↔记录值"，核不到"挂给了谁"，整格假绿。
    let cells = 0;
    eachCell((noun, shape, make) => {
      const coordinate = `坐标=foo × ${noun} × ${shape}`;
      const judged = cell('foo-collection', noun, make, 1000);
      expect(judged.verdict.unregisteredAttribution.map((amount) => amount.value), coordinate).toEqual([1000]);
      expect(judged.verdict.misattributed, `${coordinate}（未登记名字不进张冠李戴）`).toEqual([]);
      expect(judged.audit, `${coordinate}（诱惑点：申报与算式全对）`).toEqual([]);
      expect(judged.failing, coordinate).toEqual(['期望·张冠李戴(第1轮)']);
      cells += 1;
    });
    expect(cells).toBe(CELL_COUNT);
  });

  it('矩阵·诚实孪生：同一矩阵挂给真实所有者 beta ⇒ 136 格三处全空（不假红）', () => {
    // 假红防线：绑定面补齐后，每一格都要能区分"挂错人"与"挂对人的合计/真值"。合计族
    // 用 1000（beta 真实全额，走合计验证落 derived）；直接断言族用 500（beta 的单条
    // 真实值）。完整 verdict 三处全空 + audited 交叉核 + 期望值层全绿。
    const totalFamily: ReadonlySet<string> = new Set([
      'total', 'sum', 'combined', '合计', '加总', '求和', '总计', '总额', '总和', '共计', '小计', '总数',
    ]);
    let cells = 0;
    eachCell((noun, shape, make) => {
      const coordinate = `坐标=beta × ${noun} × ${shape}`;
      const amount = totalFamily.has(noun) ? 1000 : 500;
      const judged = cell('beta', noun, make, amount);
      expect(judged.verdict.misattributed, coordinate).toEqual([]);
      expect(judged.verdict.unregisteredAttribution, coordinate).toEqual([]);
      expect(judged.verdict.unattributed, coordinate).toEqual([]);
      expect(judged.audit, coordinate).toEqual([]);
      expect(judged.failing, coordinate).toEqual([]);
      cells += 1;
    });
    expect(cells).toBe(CELL_COUNT);
  });

  it('矩阵·连接变体（audited 端到端）：破折号/冠词/括号/逗号/之/Markdown 装饰都判红', () => {
    // 2026-11-10 独立评审 high：这些形态旧实现全部漏判——申报块全额对上、期望值层
    // 看不到归属问题，整例假绿。逐句钉 audited 三层（verdict / 交叉核 / 期望值）。
    const judge = (sentence: string) => {
      const prose = `${MATRIX_PREFIX}${sentence}。`;
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      return {
        verdict: classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts),
        audit: classifyAuditDeclaration(reply, BETA_ROWS).findings,
        failing: failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)),
      };
    };
    for (const sentence of [
      '1000 — the total of gamma-collection',
      '1000 is the total of the gamma-collection',
      '1000（gamma-collection 的合计）',
      '1000，gamma-collection 的合计',
      '1000——gamma-collection 的合计',
      '1000 是 gamma-collection 之合计',
      '1000 (gamma-collection total)',
      '1000 is the total of **gamma-collection**',
      '1000 是 `gamma-collection` 的合计',
      '1000 is the total of “gamma-collection”',
      "1000 is the total of gamma-collection's records",
      '1000 is the total of gamma-collection’s records',
    ]) {
      const judged = judge(sentence);
      expect(judged.verdict.misattributed.map((amount) => amount.value), sentence).toEqual([1000]);
      expect(judged.audit, `${sentence}（诱惑点：申报与算式全对）`).toEqual([]);
      expect(judged.failing, sentence).toEqual(['期望·张冠李戴(第1轮)']);
    }
    for (const sentence of [
      '1000 — the total of foo-collection',
      '1000 is the total of the foo-collection',
      '1000（foo-collection 的合计）',
      '1000，foo-collection 的合计',
      '1000 是 foo-collection 之合计',
      '1000 = foo-collection total',
      '`foo-collection` value is 1000',
      '**foo-collection** value is 1000',
      '“foo-collection” value is 1000',
    ]) {
      const judged = judge(sentence);
      expect(judged.verdict.unregisteredAttribution.map((amount) => amount.value), sentence).toEqual([1000]);
      expect(judged.verdict.misattributed, sentence).toEqual([]);
      expect(judged.audit, `${sentence}（诱惑点：申报与算式全对）`).toEqual([]);
      expect(judged.failing, sentence).toEqual(['期望·张冠李戴(第1轮)']);
    }
  });

  it('矩阵·belongs-to 与表格行（audited 端到端）：显式从属/表格形状同样判红', () => {
    const judge = (sentence: string) => {
      const prose = `${MATRIX_PREFIX}${sentence}。`;
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      return {
        verdict: classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts),
        audit: classifyAuditDeclaration(reply, BETA_ROWS).findings,
        failing: failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)),
      };
    };
    for (const sentence of ['500 belongs to gamma-collection', '500 属于 gamma-collection']) {
      const judged = judge(sentence);
      expect(judged.verdict.misattributed.map((amount) => amount.value), sentence).toEqual([500]);
      expect(judged.audit, sentence).toEqual([]);
      expect(judged.failing, sentence).toEqual(['期望·张冠李戴(第1轮)']);
    }
    for (const sentence of ['500 belongs to foo-collection', '500 属于 foo-collection']) {
      const judged = judge(sentence);
      expect(judged.verdict.unregisteredAttribution.map((amount) => amount.value), sentence).toEqual([500]);
      expect(judged.audit, sentence).toEqual([]);
      expect(judged.failing, sentence).toEqual(['期望·张冠李戴(第1轮)']);
    }
    // 表格行：CLAUSE_SPLIT 在换行切分，正文里另起一行即独立分句。
    for (const [sentence, fail] of [
      ['| gamma-collection | 1000 |', '期望·张冠李戴(第1轮)'],
      ['| foo-collection | 1000 |', '期望·张冠李戴(第1轮)'],
    ] as const) {
      const prose = `${MATRIX_PREFIX}\n${sentence}`;
      const reply = `${prose}\n${TOTAL_BLOCK}`;
      const verdict = classifyErrorStateAmounts(prose, 'checkbeta的payablebalance', extractAmounts);
      expect(verdict.misattributed.length + verdict.unregisteredAttribution.length, sentence).toBe(1);
      expect(classifyAuditDeclaration(reply, BETA_ROWS).findings, sentence).toEqual([]);
      expect(failingExpectationNames(spec, rowOf('check beta record value', reply, BETA_ROWS)), sentence).toEqual([fail]);
    }
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

// ── ⑤b2 日期样数字不计申报覆盖（评审 4）──

describe('mock 核心集 · 日期样数字不计覆盖', () => {
  // 诱惑点：2026 是回复里出现的四位数字——"每个数字都要申报"的字面读法会要求
  // coverage:2026，而日期没有可申报的记录来源（audited 门在有平台证据的轮次假红）。
  // 判据只排日期**字面形态**：裸年份 1900-2099 与年月日组合；带格式的同值数字（2,000）
  // 与区间外的真实合计（2100）仍是金额形态，照旧要求申报。
  it('红：日期样数字在场、真实金额 500 没申报 ⇒ 只红 500（不是 2026）', () => {
    const reply = 'It is 2026. The record value is 500.\n[audit]\n[/audit]';
    const verdict = classifyAuditDeclaration(reply, BETA_ROWS);
    // 提取器口径不变：年份仍在 amounts 里；只是覆盖查不要求它申报。
    expect(verdict.amounts).toEqual([2026, 500]);
    expect(verdict.findings.map((finding) => `${finding.check}:${finding.subject}`)).toEqual(['coverage:500']);
  });

  it('孪生诚实：同一回复如实申报 500 ⇒ 绿（2026 不需要申报行）', () => {
    const reply = 'It is 2026. The record value is 500.\n[audit]\n500 <- rec-101\n[/audit]';
    expect(classifyAuditDeclaration(reply, BETA_ROWS).findings).toEqual([]);
  });

  it('红不放宽：带千分位的真实合计 2,000 仍要求申报（日期排除只收裸年份）', () => {
    const verdict = classifyAuditDeclaration('The total is 2,000.\n[audit]\n[/audit]', BETA_ROWS);
    expect(verdict.findings.map((finding) => `${finding.check}:${finding.subject}`)).toEqual(['coverage:2000']);
  });

  it('红不放宽：区间外的真实合计 2100 仍要求申报（年份区间 1900-2099，不吞 2100）', () => {
    const verdict = classifyAuditDeclaration('The total is 2100.\n[audit]\n[/audit]', BETA_ROWS);
    expect(verdict.findings.map((finding) => `${finding.check}:${finding.subject}`)).toEqual(['coverage:2100']);
  });

  it('红：带货币/缩放单位的 2026 元 / 2026 RMB 仍是金额，必须申报（日期排除只收裸年份）', () => {
    // 诱惑点：2026 是四位数字、形似年份——下方孪生里的日期组合确实免申报；但货币单位
    // 说明它是金额。日期判据看的是**出现位置**上的字面形态，不是"这串数字全文里像日期"。
    for (const prose of [
      'The total is 2026 元.',
      'The total is 2026 RMB.',
      // 首现是裸年份、同值在别处是带单位金额 / 换格式金额：首现只是提示，不能据此免申报。
      'It is 2026. The total is 2026 元.',
      'It is 2026. The total is 2,026.',
    ]) {
      const verdict = classifyAuditDeclaration(`${prose}\n[audit]\n[/audit]`, BETA_ROWS);
      expect(verdict.findings.map((finding) => `${finding.check}:${finding.subject}`), prose)
        .toEqual(['coverage:2026']);
    }
    // 位置锚定：回复别处的日期组合不能豁免同值金额（每处出现都得是日期样才排除）。
    const positioned = classifyAuditDeclaration(
      'The total is 2026 元. Reference date 2026-11-02.\n[audit]\n[/audit]',
      BETA_ROWS,
    );
    expect(positioned.findings.map((finding) => `${finding.check}:${finding.subject}`))
      .toEqual(['coverage:2026']);
    // 孪生诚实：同一个 2026 作为日期组合出现时不要求申报——只申报真实金额 500 ⇒ 绿。
    const twin = classifyAuditDeclaration(
      'The reference date is 2026-11-02. The record value is 500.\n[audit]\n500 <- rec-101\n[/audit]',
      BETA_ROWS,
    );
    expect(twin.findings).toEqual([]);
  });

  it('已知残余（不判）：裸四位真实合计 2000 与年份同形态 ⇒ 不进覆盖要求', () => {
    // "别把真实金额误排"的代价：alpha 的真实合计 1200+800=2000 是裸四位数字，与年份
    // 字面无法确定性区分，覆盖查放行。挂到实体的编造值仍由 errorStateNotes 的张冠李戴
    // 通道判红；格式化写法 "2,000" 照旧要求申报（上一条）。这是残余，不是期望行为。
    const verdict = classifyAuditDeclaration('The total is 2000.\n[audit]\n[/audit]', BETA_ROWS);
    expect(verdict.findings).toEqual([]);
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

// ── ⑤e-2 复用配额按记录身份（codex blocking 二轮：同一 rec 跨查询变值）──

describe('mock 核心集 · 复用配额按记录身份', () => {
  // 诱惑点：rec-a 在两次查询里先 500 后 300，两条引用行逐条核得上（值相符、非幻影），
  // 算式 500+300=800 也成立——按值放行时每个加数各有 1 条"已申报且核验通过"的来源，
  // 七查全过。但记录身份才是配额单位：同一 rec 的两个版本冒充了两笔记录。
  const SHIFTED_ROWS: ExecutionAuditRow[] = [
    queryRow('delta', {
      status: 'completed',
      items: [{ id: 'rec-a', name: 'delta-item-1', value: 500 }],
      count: 1,
      fields: ['id', 'name', 'value'],
    }),
    queryRow('delta', {
      status: 'completed',
      items: [{ id: 'rec-a', name: 'delta-item-1', value: 300 }],
      count: 1,
      fields: ['id', 'name', 'value'],
    }),
  ];

  it('红：同一 rec 跨查询变值——800 := 500 + 300 两条引用行都核验通过，仍判复用', () => {
    const reply = `delta 的小计 800。\n${block('500 <- rec-a', '300 <- rec-a', '800 := 500 + 300')}`;
    const verdict = classifyAuditDeclaration(reply, SHIFTED_ROWS);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('rec-a');
    expect(verdict.findings[0]!.note).toContain('复用同一来源');
    expect(verdict.findings[0]!.note).toContain('需要 2 条不同记录');
    expect(verdict.findings[0]!.note).toContain('只锚到 1 条（rec-a）');
  });

  it('孪生诚实：同形但第二次查询是另一条记录 ⇒ 绿', () => {
    const rows: ExecutionAuditRow[] = [
      SHIFTED_ROWS[0]!,
      queryRow('delta', {
        status: 'completed',
        items: [{ id: 'rec-b', name: 'delta-item-2', value: 300 }],
        count: 1,
        fields: ['id', 'name', 'value'],
      }),
    ];
    const reply = `delta 的小计 800。\n${block('500 <- rec-a', '300 <- rec-b', '800 := 500 + 300')}`;
    expect(classifyAuditDeclaration(reply, rows).findings).toEqual([]);
  });

  it('红：跨运算链同样按身份计数——800 := 500 + 300 再 1000 := 800 + 200，rec-a 展开后仍两次', () => {
    // 诱惑点：两条运算行单看都成立（800 = 500+300、1000 = 800+200），200 属于另一条
    // 记录 rec-c；只有把 800 展开到接地值后才看得见 rec-a 被聚合了两次。按行出两条
    // finding（不合并），主语是记录身份——与按值查的"加数计数"是两把尺。
    const rows: ExecutionAuditRow[] = [
      ...SHIFTED_ROWS,
      queryRow('delta', {
        status: 'completed',
        items: [{ id: 'rec-c', name: 'delta-item-3', value: 200 }],
        count: 1,
        fields: ['id', 'name', 'value'],
      }),
    ];
    const reply = `delta 的小计 800、合计 1000。\n${block('500 <- rec-a', '300 <- rec-a', '200 <- rec-c', '800 := 500 + 300', '1000 := 800 + 200')}`;
    const verdict = classifyAuditDeclaration(reply, rows);
    expect(verdict.findings.map((finding) => finding.check))
      .toEqual(['operationClosure', 'operationClosure']);
    expect(verdict.findings.every((finding) => finding.subject === 'rec-a')).toBe(true);
    expect(verdict.findings[0]!.note).toContain('加数 500、300');
  });

  it('孪生诚实：匹配存在即绿——500 有两条同值记录可依、300 只用 rec-a（不是身份出现两次就恒红）', () => {
    // 判别点不是"身份在池里出现 ≥2 次"，而是"存在一个把每次出现分到不同身份的分配"：
    // rec-a=500、rec-b=500 都申报时，500 分给 rec-b、300 分给 rec-a ⇒ 绿。同形但同值的
    // rec-b 没申报 ⇒ 500 只剩 rec-a 一个候选，与 300 抢同一身份 ⇒ 红。
    const rows: ExecutionAuditRow[] = [
      ...SHIFTED_ROWS,
      queryRow('delta', {
        status: 'completed',
        items: [{ id: 'rec-b', name: 'delta-item-2', value: 500 }],
        count: 1,
        fields: ['id', 'name', 'value'],
      }),
    ];
    const matched = `delta 的小计 800。\n${block('500 <- rec-a', '500 <- rec-b', '300 <- rec-a', '800 := 500 + 300')}`;
    expect(classifyAuditDeclaration(matched, rows).findings).toEqual([]);
    const undeclared = `delta 的小计 800。\n${block('500 <- rec-a', '300 <- rec-a', '800 := 500 + 300')}`;
    const verdict = classifyAuditDeclaration(undeclared, rows);
    expect(verdict.findings.map((finding) => finding.check)).toEqual(['operationClosure']);
    expect(verdict.findings[0]!.subject).toBe('rec-a');
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

// ── ⑩ calls:-1 是无证据状态（评审 3）──

describe('mock 核心集 · calls:-1 无证据', () => {
  // 诱惑点：-1 字面上"小于 1"，拿它比阈值会报"已执行调用不足"（假红）；它又不是 0，
  // requery / chitchat 会静默放过（假绿）。正确读法：负数 = 审计源不可读（探针的不可知
  // 哨兵），三种消费一律不出判定；有证据的 0 / 1 照判——"不判"不等于把整条断言关掉。
  const rowWithCalls = (calls: number): ProbeResultRow => ({
    id: 'mock-core', ok: true, dims: { ...ZERO_DIMS }, unclassifiedNotes: 0, notes: [],
    turns: [{ text: 'mock 核心集', reply: 'beta-item-1 是 500。', notices: [], calls }],
  });
  const specs = {
    minExecutedCalls: mockSpec({ shortCase: { turns: [{ index: 0, minExecutedCalls: 1 }] } }),
    requery: mockSpec({ invariants: { requeryPerTurn: [0] } }),
    chitchat: mockSpec({ invariants: { chitchatZeroCalls: [0] } }),
  };

  it('红：有证据的调用数照判——0 次真查 / 1 次闲聊调用各出检查', () => {
    expect(expectationChecksOf(specs.minExecutedCalls, rowWithCalls(0)).map((check) => check.name))
      .toEqual(['期望·调用数(第1轮)']);
    expect(expectationChecksOf(specs.requery, rowWithCalls(0)).map((check) => check.name))
      .toEqual(['期望·每轮真查(第1轮)']);
    expect(expectationChecksOf(specs.chitchat, rowWithCalls(1)).map((check) => check.name))
      .toEqual(['期望·闲聊零调用(第1轮)']);
  });

  it('孪生：calls:-1 在三种消费里都不出判定（不出红也不出绿）', () => {
    expect(expectationChecksOf(specs.minExecutedCalls, rowWithCalls(-1))).toEqual([]);
    expect(expectationChecksOf(specs.requery, rowWithCalls(-1))).toEqual([]);
    expect(expectationChecksOf(specs.chitchat, rowWithCalls(-1))).toEqual([]);
  });
});

// ── ⑩b calls:-1 在探针 note 面同样无判定（2026-11-10 评审 low）──

describe('mock 核心集 · calls:-1 在 note 面无判定', () => {
  // 诱惑点：-1 字面"小于 0"，旧写法 `calls <= 0` 把它当零——该轮金额从允许池里消失
  // （后续召回/对比轮把真实值误判成串台），召回轮被记"既没召回也没重查"；反过来
  // `calls > 0` 系列不会给 -1 发任何 note。判别点：有证据的 0 照判，不可知的 -1 不出红。
  const probeTurn = (overrides: Partial<Turn> = {}): Turn => ({
    text: 'q', reply: 'r', ms: 1, notices: [], messageId: 'm1',
    calls: 1, refusedCalls: 0, taskIds: [], execution: [],
    gateRows: [], intents: [], delegations: [], ladder: [], ladderRung: 'INCONCLUSIVE',
    ...overrides,
  });
  const script = [{ text: 'q', tasks: [] }, { text: 'q', tasks: [] }];

  it('红：有证据的零调用照判——realAmounts 排除该轮金额、recallMissed 成立', () => {
    const turns = [
      probeTurn({ calls: 0, reply: 'value 300' }),
      probeTurn({ calls: 0, reply: 'let me check that later' }),
    ];
    expect([...realAmounts(turns, script, 2, [])]).toEqual([]);
    expect(recallMissed(turns[1]!, new Set())).toBe(true);
  });

  it('孪生：calls:-1 是不可知——金额仍进允许池、召回轮不发假红', () => {
    const unknown = probeTurn({ calls: -1, reply: 'let me check that later' });
    const turns = [probeTurn({ calls: -1, reply: 'value 500' }), unknown];
    expect([...realAmounts(turns, script, 2, [])]).toEqual([500]);
    expect(recallMissed(unknown, new Set())).toBe(false);
    // 线程有金额时 recallMissed 本来就不看 calls：-1 不改变这条既有判据。
    expect(recallMissed(probeTurn({ calls: -1, reply: 'nothing' }), new Set([500]))).toBe(true);
  });

  it('红：B1/X1 的调用数 note 不把 -1 当计数——不可知不出红，有证据的少调用照红', () => {
    // 2026-11-10 独立评审 medium：`reduce(sum + calls)` 把 -1 拉低和值 ⇒ B1 发
    // "5 轮只产生 4 次"假红（groundedness 1，基线 cap 0 ⇒ 评分假红）；X1 直接发
    // "只产生 -1 次"。判别点：-1 不参与求和/不用来比阈值，已知的少调用仍照判。
    expect(executedCallsTotal([{ calls: 2 }, { calls: -1 }])).toBeUndefined();
    expect(fiveTurnCallsNote([{ calls: 2 }, { calls: -1 }])).toBeUndefined();
    expect(fiveTurnCallsNote([{ calls: 2 }, { calls: 2 }, { calls: 0 }, { calls: 0 }, { calls: 0 }]))
      .toBe('5 轮只产生 4 次平台调用——有轮次没真查');
    expect(firstTurnPlanCallsNote(-1)).toBeUndefined();
    expect(firstTurnPlanCallsNote(3)).toBe('4 collection 计划只产生 3 次平台调用——有collection没真查');
  });

  it('红：A5 的 "是否发生过调用" 不被 -1 抵消——已知调用照报，纯 -1 不出判定', () => {
    // 旧写法 `sum > 0`：一轮 1 次 + 一轮 -1 ⇒ 和为 0，真实发生过的调用被吞掉（假绿）；
    // 反向纯 -1 又可能被当成零。判别点 = 有证据的调用与不可知分开。
    expect(anyExecutedCall([{ calls: 1 }, { calls: -1 }])).toBe(true);
    expect(anyExecutedCall([{ calls: -1 }])).toBe(false);
    expect(anyExecutedCall([{ calls: 0 }, { calls: 0 }])).toBe(false);
  });

  it('红：G1 恢复判定在窗口含 -1 时不可知——不发 not-resumed 假红，有证据的零调用照判', () => {
    // 旧写法 `sum <= 0` 把 -1 当零 ⇒ not-resumed。不可知且无正向证据时应显式
    // inconclusive（main 的信息性 note 呈现证据缺口），而不是断言"计划未恢复"。
    const g1Turn = (calls: number, reply = '') => probeTurn({ calls, reply, text: 'q' });
    expect(planResumeState([g1Turn(0), g1Turn(-1)], ['alpha'], 0)).toBe('inconclusive');
    expect(planResumeState([g1Turn(0), g1Turn(0)], ['alpha'], 0)).toBe('not-resumed');
    // 正向证据（步骤标记）优先：-1 不影响可以确认的 resumed。
    expect(planResumeState([g1Turn(-1, '第 2/3 步'), g1Turn(-1)], ['alpha'], 0)).toBe('resumed');
  });
});

// ── ⑪ 占位用例 N/A（评审 5）──

describe('mock 核心集 · 占位用例 N/A', () => {
  // 诱惑点：占位用例（Q5b/Q13b：turns:[]、expectations: null、不在基线）的探针行
  // ok=true、四维全零、checks 为空——旧统一报告公式 `row.ok && checks.every(...)` 把它
  // 算成"通过"，通过率分母里混进一条从未跑过的用例。正确口径：显式 N/A（undefined，
  // 跳过分母），不是通过也不是失败；崩溃用例同样不静默漏，有基线时按失败计。
  /** 真实占位行的形状：零轮 + `auditFailures: 'not-applicable'`（auditFailuresOf(audited, [])）。 */
  const emptyRow = (id: string): ProbeResultRow => ({
    id, ok: true, dims: { ...ZERO_DIMS }, unclassifiedNotes: 0, notes: [], turns: [],
    auditFailures: 'not-applicable',
  });

  it('红：占位用例不被计为通过——显式 N/A（undefined）', () => {
    const q5b = loadCases().find((spec) => spec.id === 'Q5b')!;
    expect(q5b.placeholder, 'Q5b 必须是占位用例').toBe(true);
    expect(unifiedCasePassedOf(emptyRow('Q5b'), q5b, undefined, true)).toBeUndefined();
  });

  it('孪生：同形但不是占位的非基线用例同样跳过（C2/D1/D2/X1——与 score.ts 的 skipped 同口径）', () => {
    // 2026-11-10 独立评审 medium：旧实现只对占位条目返回 undefined，非占位的
    // inBaseline:false 用例（C2/D1/D2/X1）退回最小口径并计进 metrics.cases；score.ts
    // 则把所有 !inBaseline 记 skipped——同一份报告两套通过率口径。现在统一按基线跳过。
    const spec = mockSpec({ shortCase: { turns: [] } });
    expect(unifiedCasePassedOf(emptyRow('mock-core'), spec, undefined, false)).toBeUndefined();
    // 基线整份不可读（baselineKnown=false，黑盒降级）保留最小口径：此时 score.ts 也无法
    // 运行，两侧不存在可比口径；不能把整份报告的通过率清空。
    expect(unifiedCasePassedOf(emptyRow('mock-core'), spec, undefined, false, 'mock-core', false))
      .toBe(true);
    const baselineSpec = { ...mockSpec({ shortCase: { turns: [] } }), inBaseline: true };
    expect(unifiedCasePassedOf(emptyRow('mock-core'), baselineSpec, undefined, false, 'mock-core', false))
      .toBe(true);
  });

  it('红：两侧同源按 inBaseline 判——残留基线键 / 缺基线项各自与 score.ts 同向', () => {
    // 2026-11-10 评审 low：旧实现看 baselineCase 有无。inBaseline 翻 false 但基线键残留时，
    // 报告会评估/计数而 score.ts skip；inBaseline true 缺基线项时报告 skip 而 score.ts exit 2。
    const staleKeySpec = mockSpec({ shortCase: { turns: [] } }); // inBaseline:false
    expect(unifiedCasePassedOf(emptyRow('mock-core'), staleKeySpec, { dims: { ...ZERO_DIMS } }, false))
      .toBeUndefined();
    // 缺基线项：与 score.ts 的 exit 2 同向——报告记失败，不静默跳过。
    const missingKeySpec = { ...mockSpec({ shortCase: { turns: [] } }), inBaseline: true };
    expect(unifiedCasePassedOf(emptyRow('mock-core'), missingKeySpec, undefined, false)).toBe(false);
  });

  it('红：残留基线键不能把从未跑过的占位条目拉进评估——占位判据先于基线键', () => {
    // 旧顺序先看 baselineCase：占位条目若残留一个基线键，会被 evaluateProbeCase 评估，
    // 而不是显式 N/A（2026-11-10 评审 low）。
    // 2026-11-10 独立评审 low 的补洞：Q5b 本身 inBaseline:false，只测它的话**删掉
    // placeholder 分支仍然绿**（inBaseline 检查单独就会 skip）。这里用同一占位 spec
    // 翻成 inBaseline:true 模拟"占位被误标进基线"，并给出残留基线键——只有占位判据先跑
    // 才 N/A。
    const q5b = loadCases().find((spec) => spec.id === 'Q5b')!;
    const promoted = { ...q5b, inBaseline: true };
    expect(promoted.placeholder).toBe(true);
    expect(unifiedCasePassedOf(emptyRow('Q5b'), promoted, { dims: { ...ZERO_DIMS } }, false)).toBeUndefined();
    // 判别点：抹掉占位标记后同一输入会被基线评估并判过（证明上面的 undefined 不是
    // inBaseline 键单独造成的）。
    const asNonPlaceholder = { ...promoted, placeholder: undefined };
    expect(unifiedCasePassedOf(emptyRow('Q5b'), asNonPlaceholder, { dims: { ...ZERO_DIMS } }, false)).toBe(true);
  });

  it('红：runner 崩溃的占位用例同样 N/A；有基线的崩溃用例判失败（不静默漏）', () => {
    const q5b = loadCases().find((spec) => spec.id === 'Q5b')!;
    const crashedPlaceholder = caseCrashOf(q5b, new Error('runner 崩了'), 'probe-x', true);
    expect(crashedPlaceholder.result.auditFailures).toBe('not-applicable');
    expect(unifiedCasePassedOf(crashedPlaceholder.result, q5b, undefined, true)).toBeUndefined();
    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const crashedBaseline = caseCrashOf(a1, 'boom', 'probe-x', true);
    expect(crashedBaseline.result.ok).toBe(false);
    expect(unifiedCasePassedOf(crashedBaseline.result, a1, { dims: { ...ZERO_DIMS } }, true)).toBe(false);
  });

  it('红：非基线用例在报告两侧一致——verdict=skip、不进通过率分母（基线可读时）', () => {
    // 诱惑点：行 ok=true、四维全零、checks 为空——只看 ok 的消费者会读成"通过"；
    // 同步 bug 形态（2026-11-10 评审 medium）是 unifiedCasePassedOf 只对占位跳过，
    // 非占位的 !inBaseline 用例退回最小口径 ⇒ cases 计 pass、metrics 分母多 1，
    // 与 score.ts 的 skipped 相反。两侧同口径 = 判定值与报告分母一起跳。
    const spec = mockSpec({ shortCase: { turns: [] } });
    const input = { caseId: 'mock-core', ok: true, notes: [], turns: [], intents: [], gateRows: [], delegations: [] };
    const skipped = buildUnifiedReport({
      at: 'now', evalRunId: 'mock', cases: [input],
      passOf: () => unifiedCasePassedOf(emptyRow('mock-core'), spec, undefined, true),
    });
    expect(skipped.cases.map((line) => line.verdict)).toEqual(['skip']);
    expect(skipped.metrics.cases, '跳过用例不能进通过率分母').toBe(0);
    // 孪生：同一行、同一判定函数，进基线且给基线项 ⇒ 真判定为 pass 且计入分母
    // （证明上面不是恒跳；spec 必须 inBaseline:true，否则按语料 skipped 先返回 undefined）。
    const counted = buildUnifiedReport({
      at: 'now', evalRunId: 'mock', cases: [input],
      passOf: () => unifiedCasePassedOf(emptyRow('mock-core'), { ...spec, inBaseline: true }, { dims: { ...ZERO_DIMS } }, true),
    });
    expect(counted.cases.map((line) => line.verdict)).toEqual(['pass']);
    expect(counted.metrics.cases).toBe(1);
    expect(counted.metrics.passed).toBe(1);
  });
});

// ── ⑫ runner 崩溃：真实执行窗口不被清零（2026-11-10 评审 medium）──

describe('mock 核心集 · 崩溃真实窗口', () => {
  // 诱惑点：runner 中途中止时，旧产物的 platformCalls/refusedCalls=0、ladder=[]、turns=[]
  // 看起来"干净"——"没跑完"被读成"没调用"，已完成轮次与崩溃窗口里的真实调用从统一报告
  // 消失。判别点：真实窗口按 auditBefore 切片计数，-1 只给"审计源不可读"。
  const a1 = loadCases().find((spec) => spec.id === 'A1')!;
  const executed: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
  const refused: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], refused: 'serve_gate:token' };
  const completed: Turn = {
    text: '查 alpha', reply: '查完了。', ms: 10, notices: [], messageId: 'm1',
    calls: 1, refusedCalls: 0, taskIds: [], execution: [executed],
    gateRows: [], intents: [], delegations: [], ladder: [], ladderRung: 'INCONCLUSIVE',
  };

  it('红：崩溃用例判失败（不静默跳过），且窗口前/窗口内不混算、被拒与时延都保住', () => {
    const crash = caseCrashOf(a1, new Error('runner 崩了'), 'probe-x', true, {
      // 窗口前一条 + 窗口内两条：只数窗口内的（2），不是全部 3、也不是 0。
      auditBefore: 1, auditRows: [executed, executed, refused], turns: [completed], elapsedMs: 2500,
    });
    expect(crash.result.platformCalls).toBe(2);
    expect(crash.result.refusedCalls).toBe(1);
    expect(crash.result.ladder).toHaveLength(2);
    // 已完成轮次保住：申报计数按真实回复算（0 条 findings），不是一律 N/A。
    expect(crash.result.auditFailures).toBe(0);
    // 崩溃窗口单列：完成轮 + 未完成轮各一条；未完成轮没有用户可见交付，时延取用例墙钟。
    expect(crash.input.turns.map((turn) => turn.messageId))
      .toEqual(['m1', expect.stringContaining('crash-window')]);
    expect(crash.input.turns[1]!.reply).toBeNull();
    expect(crash.input.turns[1]!.execution).toEqual([refused]);
    // 崩溃窗口时延 = 用例墙钟 − 已完成轮次（2500 − 10），不是整段墙钟再被报告加总
    // （旧写法 10 + 2500 = 2510；2026-11-10 评审 low）。报告总时长回到 2500。
    expect(crash.input.turns[1]!.ms).toBe(2490);
    // 统一报告口径：崩溃用例判失败（skip 会使通过率分母缩水），调用一行不少。
    expect(unifiedCasePassedOf(crash.result, undefined, { dims: { ...ZERO_DIMS } }, true)).toBe(false);
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls).toHaveLength(2);
    expect(report.cases[0]!.durationMs).toBe(2500);
    expect(report.metrics.durationMs).toBe(2500);
  });

  it('红：崩溃在 free 基线（A2/B1/Y2）下也判失败——free 容忍 note 方差，不容忍崩溃', () => {
    // 2026-11-10 评审 medium：evaluateProbeCase 对 okMode:'free' 不出 ok 检查；崩溃若发生在
    // 所有期望轮次完成之后（如 assembly.close() 抛错），四维/期望值层全过 ⇒ 整例 pass。
    // 判别点 = crashed 标记与 okMode 正交。
    const freeBaseline = { dims: { ...ZERO_DIMS }, okMode: 'free' as const };
    const crash = caseCrashOf(a1, 'boom', 'probe-x', false, {
      auditRows: [executed], turns: [completed], elapsedMs: 30,
    });
    expect(unifiedCasePassedOf(crash.result, undefined, freeBaseline, false)).toBe(false);
    // 孪生：同一 free 基线、同一行但不崩溃 ⇒ pass（证明失败不是恒判）。
    const normal = rowOf('查 alpha', '查完了。', [executed]);
    expect(unifiedCasePassedOf(normal, undefined, freeBaseline, false)).toBe(true);
  });

  it('红：崩溃窗口按已覆盖行多集扣除——merge 顺序不是时间序也不重复/丢调用', () => {
    // 2026-11-10 评审 medium：mergeCallPhases 输出 results→starts→passthrough；已完成轮有
    // passthrough 行、崩溃窗口有 callId 行时，按数量 slice 会把已完成轮的 passthrough 行
    // 重复进崩溃窗口，崩溃窗口的真实调用从 JSONL 消失（probe18）。多集扣除按内容而非顺序。
    const proposalStart: ExecutionAuditRow = { callId: 'c1', phase: 'start', mode: 'prepare', script: 'dummy.proposal-create' };
    const crash = caseCrashOf(a1, 'boom', 'probe-x', false, {
      auditRows: [executed, proposalStart], turns: [completed], elapsedMs: 30,
    });
    const partial = crash.input.turns[1]!;
    expect(partial.execution.map((row) => row.callId ?? row.script)).toEqual(['c1']);
    expect(partial.execution[0]!.script).toBe('dummy.proposal-create');
    // 统一报告 JSONL：已完成调用只出现一次，崩溃窗口调用也在。
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls.map((line) => line.script).sort()).toEqual(['dummy.proposal-create', 'dummy.query']);
  });

  it('红：同一调用的 phase 演进不重复计入崩溃窗口——按 callId 扣除，不按 JSON 内容', () => {
    // 2026-11-10 独立评审 medium：已完成轮存 start-only 行、崩溃窗口 mergedRows 存同一
    // callId 的 start+result 合并行，两边 JSON 不同；按内容多集扣除认不出覆盖，同一次调用
    // 会在统一报告里出现两行（completed 轮一行 + crash-window 一行）。
    const start: ExecutionAuditRow = { callId: 'c1', phase: 'start', mode: 'prepare', script: 'dummy.proposal-create' };
    const result: ExecutionAuditRow = { callId: 'c1', phase: 'result', mode: 'prepare', script: 'dummy.proposal-create', exitCode: 0 };
    const completedWithStart: Turn = { ...completed, execution: [start] };
    const crash = caseCrashOf(a1, 'boom', 'probe-x', false, {
      auditRows: [start, result], turns: [completedWithStart],
    });
    // 该调用已被已完成轮覆盖 ⇒ 没有崩溃窗口 partial turn。
    expect(crash.input.turns.map((turn) => turn.messageId)).toEqual(['m1']);
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls.map((line) => line.script)).toEqual(['dummy.proposal-create']);
  });

  it('红：崩溃在所有已完成轮次之后、无新审计行 ⇒ 崩溃窗口时延仍计入 duration', () => {
    // 2026-11-10 独立评审 low：旧实现只在 tailRows 非空时挂 partialTurn——没有新审计行的
    // 崩溃窗口把 elapsedMs−completedMs 的墙钟证据丢掉，duration 只剩已完成轮次之和。
    const crash = caseCrashOf(a1, 'boom', 'probe-x', false, {
      auditRows: [executed], turns: [completed], elapsedMs: 100,
    });
    expect(crash.input.turns).toHaveLength(2);
    expect(crash.input.turns[1]).toMatchObject({ reply: null, ms: 90, execution: [] });
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.cases[0]!.durationMs).toBe(100);
    expect(report.calls).toHaveLength(1);
  });

  it('红：elapsedMs 缺席时崩溃窗口不写 0——时延字段缺席而不是伪造零', () => {
    // CrashEvidence 的注释写"缺席不编零"，旧实现 `elapsedMs ?? 0` 正好相反（2026-11-10 评审 low）。
    const crash = caseCrashOf(a1, 'boom', 'probe-x', false, {
      auditRows: [executed, refused], turns: [completed],
    });
    expect('ms' in crash.input.turns[1]!).toBe(false);
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect('latencyMs' in report.cases[0]!.turns[1]!).toBe(false);
    // 有证据的已完成轮时延照常，durationMs 只加有证据的部分。
    expect(report.cases[0]!.turns[0]!.latencyMs).toBe(10);
    expect(report.cases[0]!.durationMs).toBe(10);
  });

  it('孪生：同一完成轮次不崩溃 ⇒ 正常行判过（崩溃是唯一判别点）', () => {
    const row = rowOf('查 alpha', '查完了。', [executed], {
      id: 'A1',
      turns: [{ text: '查 alpha', reply: '查完了。', notices: [], calls: 1, execution: [executed] }],
      auditFailures: 0,
    });
    expect(evaluateProbeCase('probe-A1', row, { dims: { ...ZERO_DIMS } }, undefined, undefined, true).pass).toBe(true);
  });
});
