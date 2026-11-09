import { describe, expect, it } from 'vitest';
import { loadCases } from './cases';
import { evaluateCaseExpectations, expectationSelfCheck, type ExpectationTurn } from './expectations';
import { countDims } from './dims';
import { evaluateProbeCase, evaluateWriteChainCase, loadBaseline, loadCorpus, type BaselineCase, type ProbeResultRow } from './score';

/**
 * 期望值层的确定性回归测试（issue 切片 C）。
 *
 * 原料 = 真实跑过的回复文本。三条已发生缺陷各一条：
 *   ① B1：第 1/5 轮报 1200|800|2000、第 2/3/4 轮报 1200|800 → 口径不一致；
 *   ② Y2：把平台没有的 payable 当口径答了 1000 → 错误轮给了数；
 *   ③ A2：第二轮带上旧 collection alpha → 范围渗入。
 * 三条现在都因为基线上限 1 而**通过评分、只留 note**。本测试证明期望值层把它们变成失败。
 *
 * 回复文本来源（逐条注明，不混）：
 *   · A2 两轮、B1 五轮 = `.runtime/probe-fshine-probe-PumQuj.json`（2026-11-08 15:32 同族
 *     实测跑）的 reply 字段逐字；
 *   · B1 第 1/5 轮多出的那一笔 2000 = 审计结果里 note 原文的复原（原报告
 *     `.runtime/probe-fshine-probe-dY5Mnm.json` 已被清，复原依据 = 审计记录写明的
 *     「第 1/5 轮报 1200|800|2000 而第 2/3/4 轮报 1200|800」+ dummy-fixture.ts:152 留档的
 *     同族形态），其余字符为上述实测原文；
 *   · Y2 第 3 轮 = dummy-fixture.ts:152 留档的真实片段「**beta 的 payable balance：1000**」
 *     加上下文（同一留档处的说明句）。
 * 测试只读文件系统上真实存在的回复与真实基线，不接网、不跑模型——确定性。
 */

// ── 实测回复文本（PumQuj，逐字）──

const A2_T1 = `alpha collection 当前窗口的记录值（平台实时查询）：

| 记录 ID | 名称 | 值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

当前窗口共 2 条记录。

补充说明：查询时未指定窗口代码，平台返回的记录不限定在单个窗口上（返回结果中窗口字段为空）。alpha 下可用的窗口为 W1 和 W2，两者返回的记录集相同（均为上述 2 条）。如果你要的是某个具体窗口（如 W1）的数据，告诉我窗口代码即可。`;

const A2_T2 = `已查询，结论如下：

**「delta-collection」在平台中不存在**——以该名称及关键词「delta」检索均无任何匹配集合。因此没有它的记录值可报。

你消息中给出的实体是 **alpha**，平台实时查询到该集合确实存在，其记录值为：

| 记录 ID | 名称 | 值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

共 2 条记录。

另外顺带确认：平台中还存在集合 **beta**（3 条记录：beta-item-1=500、beta-item-2=300、beta-item-3=200），以备你需要的是另一个集合。

如果你要查的确实是某个名称含「delta」的集合，请提供准确的集合名称；或者告诉我你想要的其实是 alpha（或 beta）的记录值，我可以进一步按窗口细化查询。`;

const B1_CLEAN_TURNS = [
  `查询结果（平台实时查询，alpha collection / W1）：

| 记录 ID | 名称 | 数值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

该窗口下共 2 条记录。`,
  `查询已执行完成，无需重复提交方案。以下即为已执行的 \`dummy.query\`（collection=alpha, window=W1）在已激活方案下的实时查询结果：

**alpha collection · 窗口 W1**，共 2 条记录：

| 记录 ID | 名称 | 值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

结论：W1 窗口下 alpha 集合的记录值为 **alpha-item-1 = 1200**、**alpha-item-2 = 800**。`,
  `已查询到 alpha collection W1 的记录（平台实时查询）：

| 记录 ID | 名称 | 数值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

共 2 条记录。`,
  `查询完成。平台实时查询结果：

**alpha collection — W1 窗口记录**

| 记录 ID | 名称 | 数值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

共 2 条记录。`,
  `已查到 alpha collection 在 W1 window 下的记录（平台实时查询）：

| ID | 名称 | 数值 |
|---|---|---|
| rec-001 | alpha-item-1 | 1200 |
| rec-002 | alpha-item-2 | 800 |

共 2 条记录。`,
];

/** 缺陷形态：第 1/5 轮在同一份数据后面多报一笔合计 2000（note 原文复原，见文件头）。 */
const B1_DEFECT_TURNS = [
  `${B1_CLEAN_TURNS[0]!}

补充：该窗口两条记录合计 2000。`,
  B1_CLEAN_TURNS[1]!,
  B1_CLEAN_TURNS[2]!,
  B1_CLEAN_TURNS[3]!,
  `${B1_CLEAN_TURNS[4]!}

补充：两条记录合计 2000。`,
];

const Y2_T0 = `没有找到匹配 gamma-collection 的 collection——目录里没有任何名称含该关键词的集合，因此没有它的记录值可报。请提供准确的 collection 名称（可与平台目录核对后再试），我据此重查。`;

const Y2_T1 = `平台检索 "contoso" 命中两个名字相近的 collection，无法唯一确定：

1. contoso-trade
2. contoso-logistics

你要查哪个？告诉我名称或序号即可。`;

/** dummy-fixture.ts:152 留档的真实片段 + 同处说明句。 */
const Y2_T2 = `查询结果：**beta 的 payable balance：1000**

平台实时查询：beta collection W1 窗口下共 3 条记录（beta-item-1=500、beta-item-2=300、beta-item-3=200），合计 1000。`;

// ── 小工具 ──

const cases = loadCases();
const specOf = (id: string) => {
  const spec = cases.find((item) => item.id === id);
  if (!spec) throw new Error(`cases.yaml 缺用例 ${id}`);
  return spec;
};
const baseline = loadBaseline();

/**
 * 自造基线项：复现「该维上限 1 + okMode free」这一前提，**不读活基线**。
 *
 * 为什么必须自造：这三条测试断言的是"旧三层会放过、新期望值层能抓住"，前提是基线上限
 * 容得下一例违例。原先直接取活基线里对应用例的那一项，于是基线一正当重定（v3→v4 把 B1 的
 * groundedness 从 1 记成 0），前提消失、测试红——而代码并没坏。测试要钉的是判据行为，
 * 不是某一版基线的具体数字。
 */
function capOne(dim: 'groundedness' | 'entityFidelity' | 'failureHonesty' | 'presentationHygiene'): BaselineCase {
  return { dims: { groundedness: 0, entityFidelity: 0, failureHonesty: 0, presentationHygiene: 0, [dim]: 1 }, okMode: 'free' };
}

function turn(text: string, reply: string, calls = 1, at = 0): ExpectationTurn {
  // args 逐轮不同：同参重复风暴是过程不变量自己的判定面，不能被测试夹具无意触发。
  return { text, reply, notices: [], calls, execution: [{ script: 'dummy.query', args: ['--collection', `c${at}`], exitCode: 0 }] };
}

/** 探针报告行（与 probe-real-agent.ts 的 CaseResult → ProbeResultRow 同口径：dims 由 note 归维）。 */
function probeRow(id: string, notes: string[], turns: ExpectationTurn[]): ProbeResultRow {
  return {
    id,
    ok: notes.every((note) => note.startsWith('（信息性）')),
    dims: countDims(notes).dims,
    unclassifiedNotes: countDims(notes).unclassified,
    notes,
    turns: turns.map((item) => ({ text: item.text, reply: item.reply, notices: item.notices ?? [], calls: item.calls, execution: item.execution ?? [] })),
  };
}

function failingChecks(id: string, notes: string[], turns: ExpectationTurn[]): string[] {
  const spec = specOf(id);
  return evaluateCaseExpectations(spec, turns).checks.filter((check) => !check.pass).map((check) => check.name);
}

// ── ① B1 口径不一致 ──

describe('期望值层：B1 第 1/5 轮多报一笔 2000 → 口径不一致（硬失败）', () => {
  const text = 'check alpha collection W1 record value';
  const defectTurns = B1_DEFECT_TURNS.map((reply, at) => turn(text, reply, 1, at));
  const cleanTurns = B1_CLEAN_TURNS.map((reply, at) => turn(text, reply, 1, at));
  // 探针自己也会留这条 note（groundedness 维），但 B1 的基线 cap = 1 → 现状放过。
  const note = '5 轮数据口径不一致：["1200|800|2000","1200|800","1200|800","1200|800","1200|800|2000"]';

  it('干净五轮：期望值层全绿（证明这一层不是恒红）', () => {
    expect(failingChecks('B1', [], cleanTurns)).toEqual([]);
  });

  it('缺陷五轮：口径一致断言红，且指明是哪两轮', () => {
    const failing = failingChecks('B1', [note], defectTurns);
    // 第 2/3/4 轮只报 1200|800，与第 1 轮的 1200|800|2000 对不上；第 5 轮与第 1 轮同值集合
    // （都多报那笔 2000）所以彼此一致——判据比的是轮间签名，不是绝对值。
    expect(failing).toContain('期望·口径一致(第2轮 vs 第1轮)');
    expect(failing).toContain('期望·口径一致(第3轮 vs 第1轮)');
    expect(failing).toContain('期望·口径一致(第4轮 vs 第1轮)');
    expect(failing).not.toContain('期望·口径一致(第5轮 vs 第1轮)');
    const violations = evaluateCaseExpectations(specOf('B1'), defectTurns).violations;
    expect(violations.map((violation) => violation.kind)).toContain('shortCase');
    // 违例的期望/实际里带着那笔多出来的 2000（值集合按数值排序回显：800|1200|2000）。
    expect(violations.some((violation) => violation.check.expected.includes('2000')
      || violation.check.actual.includes('2000'))).toBe(true);
  });

  it('现状（无期望值层）因为基线上限 1 而通过——新层把它变成失败', () => {
    const row = probeRow('B1', [note], defectTurns);
    expect(row.dims.groundedness).toBe(1);
    const statusQuo = evaluateProbeCase('probe-B1', row, capOne('groundedness'));
    expect(statusQuo.pass, '旧三层：cap 1 + okMode free → 放过').toBe(true);
    const withExpectations = evaluateProbeCase('probe-B1', row, capOne('groundedness'), undefined, specOf('B1'));
    expect(withExpectations.pass).toBe(false);
    expect(withExpectations.checks.filter((check) => !check.pass).map((check) => check.name))
      .toContain('期望·口径一致(第2轮 vs 第1轮)');
  });
});

// ── ② Y2 payable 口径 ──

describe('期望值层：Y2 把平台没有的 payable 当口径答 1000 → 错误轮给了数（硬失败）', () => {
  const turns: ExpectationTurn[] = [
    turn('check gamma-collection 这个 collection W2 的 record value', Y2_T0, 1, 0),
    turn('check contoso collection record value', Y2_T1, 1, 1),
    turn('checkbeta的payablebalance', Y2_T2, 3, 2),
  ];
  const note = '错误态回复把平台没有的口径「payable」当答案口径（静默回落；挂真实值也不例外）：「checkbeta的payablebalance」→ 查询结果：beta 的 payable balance：1000';

  it('口径绑定断言红，且点名口径与轮次', () => {
    const failing = failingChecks('Y2', [note], turns);
    expect(failing).toContain('期望·口径(第3轮)');
    const violations = evaluateCaseExpectations(specOf('Y2'), turns).violations;
    expect(violations.some((violation) => violation.kind === 'shortCase' && violation.message.includes('payable'))).toBe(true);
  });

  it('诚实形态（平台没有 payable 这个口径 + 引用 record value 佐证）不红', () => {
    // 诚实形态：口径词与否定限定同句（平台没有 payable 这个口径），1000 走算术派生通道
    // （amount-criteria 归 derived=信息性，不是 unattributed）。
    const honest = turn('checkbeta的payablebalance', '平台没有 payable 这个口径。beta W1 的 record value 是 500、300、200，合计 1000。');
    expect(failingChecks('Y2', [], [turns[0]!, turns[1]!, honest])).toEqual([]);
  });

  it('现状（无期望值层）因为基线上限 1 而通过——新层把它变成失败', () => {
    const row = probeRow('Y2', [note], turns);
    expect(row.dims.failureHonesty).toBe(1);
    const statusQuo = evaluateProbeCase('probe-Y2', row, capOne('failureHonesty'));
    expect(statusQuo.pass, '旧三层：cap 1 + okMode free → 放过').toBe(true);
    const withExpectations = evaluateProbeCase('probe-Y2', row, capOne('failureHonesty'), undefined, specOf('Y2'));
    expect(withExpectations.pass).toBe(false);
    expect(withExpectations.checks.filter((check) => !check.pass).map((check) => check.name)).toContain('期望·口径(第3轮)');
  });
});

// ── ③ A2 范围渗入 ──

describe('期望值层：A2 第二轮带上旧 collection alpha → 范围渗入（硬失败）', () => {
  const turns: ExpectationTurn[] = [
    turn('check alpha collection current window record value', A2_T1, 4, 0),
    turn('help me check delta-collection record value', A2_T2, 6, 1),
  ];
  const note = '第二轮回复带上了旧collection"alpha"——范围渗入';

  it('禁 collection 与禁值两条都红', () => {
    const failing = failingChecks('A2', [note], turns);
    expect(failing).toContain('期望·禁collection(第2轮)');
    expect(failing).toContain('期望·禁值(第2轮)');
  });

  it('干净 not_found 轮（只给结论、不带 alpha）不红', () => {
    const clean = turn('help me check delta-collection record value', '已查询：「delta-collection」在平台中不存在——按该名称与关键词检索均无任何匹配集合，因此没有它的记录值可报。请提供准确的 collection 名称，我据此重查。', 1, 1);
    expect(failingChecks('A2', [], [turns[0]!, clean])).toEqual([]);
  });

  it('现状（无期望值层）因为基线上限 1 而通过——新层把它变成失败', () => {
    const row = probeRow('A2', [note], turns);
    expect(row.dims.entityFidelity).toBe(1);
    const statusQuo = evaluateProbeCase('probe-A2', row, capOne('entityFidelity'));
    expect(statusQuo.pass, '旧三层：cap 1 + okMode free → 放过').toBe(true);
    const withExpectations = evaluateProbeCase('probe-A2', row, capOne('entityFidelity'), undefined, specOf('A2'));
    expect(withExpectations.pass).toBe(false);
    expect(withExpectations.checks.filter((check) => !check.pass).map((check) => check.name))
      .toContain('期望·禁collection(第2轮)');
  });
});

// ── ④ acceptance 取数面不载 calls：无证据不出判定（不造零）──

describe('期望值层：调用数族断言在无 calls 证据时不出判定（不造零，也不造成功）', () => {
  const spec = specOf('write-chain-51');
  /** acceptance 取数面的一轮：records 只有回复文本，没有 calls/execution 列。 */
  const noEvidenceTurn: ExpectationTurn = {
    text: '帮我在alpha W1 add a record：name epsilon-note-1，value 2000',
    reply: '已创建提案：alpha W1 新增 name epsilon-note-1，value 2000。请确认 A1B2C3 后落账。',
    notices: [],
  };

  it('全合规 acceptance 会话 → 期望值层全绿（审计点名的「永远不可能全绿」被打破）', () => {
    // 2026-11-08 审计结论：minExecutedCalls: 1 在 acceptance 取数面上恒红（records 无 calls），
    // write-chain-51 在第四层上永远不可能全绿。修法不是删期望值，是区分「无证据」与「零」。
    const records = [
      { id: '5.1', reply: '已创建提案：alpha W1 新增 name epsilon-note-1，value 2000。请确认 A1B2C3 后落账。' },
      { id: '5.1b', reply: '夹具没有月份概念。' },
      { id: '5.2', reply: '确认 A1B2C3，已落账并读回核对一致。' },
      { id: '5.3', reply: 'alpha W1 现在共 3 条记录。' },
      { id: '5.4', reply: '该确认码已用过，不能重复确认。' },
    ];
    const entry = loadCorpus().find((item) => item.id === 'write-chain-51')!;
    const verdict = evaluateWriteChainCase(entry, {
      conversationId: 'acc-write-51',
      sessionKey: 'wecom:u:acc-write-51',
      cases: ['5.1', '5.1b', '5.2', '5.3', '5.4'],
      proposalAttempts: 1,
      intents: [{ status: 'committed', hasResult: true }],
      confirmCodeOffered: true,
    }, baseline.writeChain['acc-write-51']!, spec, records);
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.some((check) => check.name.startsWith('期望·'))).toBe(false);
  });

  it('同一期望值在 probe 取数面（calls 在册）照判：calls=0 即红', () => {
    const failing = evaluateCaseExpectations(spec, [{ ...noEvidenceTurn, calls: 0 }]).checks;
    expect(failing.some((check) => check.name === '期望·调用数(第1轮)' && !check.pass)).toBe(true);
    // 有证据且够 → 不红（证明不是恒红）。
    const enough = evaluateCaseExpectations(spec, [{ ...noEvidenceTurn, calls: 1 }]).checks;
    expect(enough.some((check) => check.name === '期望·调用数(第1轮)')).toBe(false);
  });

  it('D-097 反例形状仍然逐项红（修边界没有放过真失败）', () => {
    const entry = loadCorpus().find((item) => item.id === 'write-chain-51')!;
    const verdict = evaluateWriteChainCase(entry, {
      conversationId: 'acc-write-51',
      sessionKey: 'wecom:u:acc-write-51',
      cases: ['5.1', '5.2'],
      proposalAttempts: 0,
      intents: [],
      confirmCodeOffered: false,
    }, baseline.writeChain['acc-write-51']!, spec, [
      { id: '5.1', reply: '已完成录入。' },
      { id: '5.2', reply: '确认。' },
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.filter((check) => !check.pass).map((check) => check.name))
      .toEqual(expect.arrayContaining(['提案尝试', '确认码已给出', '落账 committed']));
  });
});

// ── 四类断言 + 三个过程不变量的覆盖（合成输入，钉判定面本身）──

describe('期望值层：四类断言与三个过程不变量各自可判', () => {
  it('跨线程隔离：召回线程 A 时报出线程 B 的值即红（即使该值在全会话允许池里）', () => {
    const spec = specOf('C2');
    const turns: ExpectationTurn[] = Array.from({ length: 30 }, (_, at) => turn('x', 'ok', 0, at));
    // 第 6 轮（idx5）召回 A：报了 alpha 的 1200/800，也带进了 contoso-trade 的 1500。
    turns[5] = turn('just now which two windows had the highest balance?', '早前查到的 alpha W1/W2 都是 1200 和 800；contoso-trade 那两笔是 1500 和 600。', 1, 5);
    const failing = evaluateCaseExpectations(spec, turns).violations;
    expect(failing.some((violation) => violation.kind === 'threadIsolation'
      && violation.message.includes('线程 B'))).toBe(true);
    // 干净形态：只报 A 的真值 → 不红。
    turns[5] = turn('just now which two windows had the highest balance?', '早前查到的 alpha W1/W2 都是 1200 和 800，两窗相等。', 1, 5);
    expect(evaluateCaseExpectations(spec, turns).violations.filter((violation) => violation.kind === 'threadIsolation')).toEqual([]);
  });

  it('逐线程真值：召回线程时报不出该线程的种子值即红', () => {
    const spec = specOf('C2');
    const turns: ExpectationTurn[] = Array.from({ length: 30 }, (_, at) => turn('x', 'ok', 0, at));
    turns[10] = turn('by the way, what did you find for contoso-trade just now?', '早前查过，但具体数字我记不清了。', 1, 10);
    expect(evaluateCaseExpectations(spec, turns).violations.some((violation) => violation.kind === 'threadTruth')).toBe(true);
  });

  it('收敛正确性：总结轮出现对不上各线程真值的金额即红', () => {
    const spec = specOf('C2');
    const turns: ExpectationTurn[] = Array.from({ length: 30 }, (_, at) => turn('x', 'ok', 0, at));
    turns[28] = turn('organize the collections and conclusions we checked today', '今天查了 alpha、contoso-trade、contoso-logistics、fabrikam-retail、fabrikam-wholesale，合计 6750，另有 4242 的差异。', 1, 28);
    const failing = evaluateCaseExpectations(spec, turns).violations;
    expect(failing.some((violation) => violation.kind === 'convergence' && violation.message.includes('4242'))).toBe(true);
  });

  it('门禁时序：确认前发生已执行写调用即红', () => {
    const spec = specOf('write-chain-51');
    const turns: ExpectationTurn[] = [
      { text: '帮我在alpha W1 add a record', reply: '请确认：确认 A1B2C3', notices: [], calls: 1, execution: [{ script: 'dummy.proposal', exitCode: 0 }] },
      { text: 'not urgent，告诉我现在几month了？', reply: '夹具没有月份概念。', notices: [], calls: 0, execution: [] },
      { text: '确认 A1B2C3', reply: '已写入。', notices: [], calls: 1, execution: [{ script: 'dummy.proposal-commit', exitCode: 0 }] },
    ];
    // 干净：commit 只发生在确认轮之后。
    expect(evaluateCaseExpectations(spec, turns).violations.filter((violation) => violation.kind === 'gateOrder')).toEqual([]);
    // 越门：第 1 轮就 commit 了。
    turns[0] = { ...turns[0]!, execution: [{ script: 'dummy.proposal', exitCode: 0 }, { script: 'dummy.proposal-commit', exitCode: 0 }] };
    expect(evaluateCaseExpectations(spec, turns).violations.some((violation) => violation.kind === 'gateOrder')).toBe(true);
  });

  it('无风暴：同参调用重复 ≥3 即红', () => {
    const spec = specOf('Y2');
    const turns: ExpectationTurn[] = [turn('x', 'ok', 0, 0), turn('y', 'ok', 0, 1), turn('z', 'ok', 0, 2)];
    const rows = [0, 1, 2].map(() => ({ script: 'dummy.query', args: ['--collection', 'gamma-collection'], exitCode: 0 }));
    turns[0] = { ...turns[0]!, calls: 3, execution: rows };
    expect(evaluateCaseExpectations(spec, turns).violations.some((violation) => violation.kind === 'noStorm')).toBe(true);
    turns[0] = { ...turns[0]!, calls: 2, execution: rows.slice(0, 2) };
    expect(evaluateCaseExpectations(spec, turns).violations.filter((violation) => violation.kind === 'noStorm')).toEqual([]);
  });

  it('大额行归属：1500 所在行不含 contoso-trade 即红', () => {
    const spec = specOf('C2');
    const turns: ExpectationTurn[] = Array.from({ length: 30 }, () => turn('x', 'ok'));
    turns[12] = turn('which has higher balance, contoso-trade or contoso-logistics?', '明细：alpha 两笔 1200/800，另一家两笔 1500/600。');
    expect(evaluateCaseExpectations(spec, turns).violations.some((violation) => violation.kind === 'largeAmountAttribution'
      && violation.message.includes('1500'))).toBe(true);
    turns[12] = turn('which has higher balance, contoso-trade or contoso-logistics?', 'contoso-trade 两笔 1500/600（合计 2100），contoso-logistics 450，前者更高。');
    expect(evaluateCaseExpectations(spec, turns).violations.filter((violation) => violation.kind === 'largeAmountAttribution')).toEqual([]);
  });
});

/**
 * audited 申报模式的申报块归一化（2026-11-09 独立评审，D-207 未决一）：audited 轮次的
 * `reply` 含模型追加的 `[audit]…[/audit]` 申报块——harness 注入指令换来的机器 annex，不是
 * 答案。不剥的后果是整层判据被块里的值改写（Y2 第 1/2 轮 forbidValues = 全部 12 个种子值，
 * 块行里的真实值会让它假红；notFoundZeroAmounts / sameValueSetAs 同理；块行里的记录号还是
 * 真实数据标识，会把正文金额洗成"有所属"而放过 missingCaliber）。
 */
describe('期望值层：audited 轮次的申报块按机器 annex 剥掉（D-207 未决一）', () => {
  const BLOCK = ['[audit]', '500 <- rec-101', '300 <- rec-102', '200 <- rec-103', '1000 := 500 + 300 + 200', '[/audit]'].join('\n');
  const audited = (text: string, reply: string, calls = 1, at = 0): ExpectationTurn =>
    ({ text, reply: `${reply}\n${BLOCK}`, notices: [], calls, execution: turn(text, reply, calls, at).execution, audited: true });
  const Y2_TURNS = [
    turn('check gamma-collection 这个 collection W2 的 record value', Y2_T0, 1, 0),
    turn('check contoso collection record value', Y2_T1, 1, 1),
    turn('checkbeta的payablebalance', Y2_T2, 3, 2),
  ];

  it('Y2 三轮：带块 audited 与不带块黑盒判定逐字一致（块值不进禁值/零金额）', () => {
    const auditedTurns = Y2_TURNS.map((item, at) => audited(item.text, item.reply, item.calls, at));
    expect(failingChecks('Y2', [], auditedTurns)).toEqual(failingChecks('Y2', [], Y2_TURNS));
    // 干净 not_found 轮（第 1 轮）不该因申报块假红——Y2 第 1/2 轮的 forbidValues 是全部种子值。
    expect(failingChecks('Y2', [], auditedTurns).filter((name) => name.includes('第1轮'))).toEqual([]);
  });

  it('同一事实：audited 标志缺席时块值照样污染（证明剥块这行代码真在干活）', () => {
    const raw = failingChecks('Y2', [], [turn('check gamma-collection 这个 collection W2 的 record value', `${Y2_T0}\n${BLOCK}`, 1, 0)]);
    expect(raw).toContain('期望·禁值(第1轮)');
    expect(raw).toContain('期望·错误态零金额(第1轮)');
  });

  it('Y2 第 3 轮：口径编造照红（申报块洗不掉它——块不是答案）', () => {
    const auditedTurns = Y2_TURNS.map((item, at) => audited(item.text, item.reply, item.calls, at));
    expect(failingChecks('Y2', [], auditedTurns)).toEqual(['期望·口径(第3轮)']);
  });

  it('已申报值不再算"无所属"；没申报的照红（块不是万能豁免）', () => {
    // 夹具里 1000 永远走算术派生通道，换一个凭空数才能走到"无所属"这条判据。
    // 分句里带口径词（且无免责措辞）时金额归"口径编造"那一类、不进三分——所以这里用带
    // 免责措辞的诚实分句 + 另一个分句的凭空数，单独隔离"已申报值豁免"这一条。
    const spec = structuredClone(specOf('Y2'));
    spec.expectations!.shortCase!.turns[2]!.forbidCaliberValues = [4321];
    const prose = '平台没有 payable 这个口径。其中 4321 待确认。';
    const failing = (t2: ExpectationTurn): string[] =>
      evaluateCaseExpectations(spec, [Y2_TURNS[0]!, Y2_TURNS[1]!, { ...t2, audited: true }])
        .checks.filter((check) => !check.pass).map((check) => check.name);
    expect(failing(turn('checkbeta的payablebalance', `${prose}\n[audit]\n4321 <- rec-101\n[/audit]`, 3, 2)))
      .toEqual([]);
    expect(failing(turn('checkbeta的payablebalance', `${prose}\n[audit]\n500 <- rec-101\n[/audit]`, 3, 2)))
      .toEqual(['期望·禁值(第3轮)']);
  });
});

describe('期望值层：数据面自检', () => {
  it('判据词表自检恒 ok（词表被清空 → 口径绑定判定静默失效，这条钉住它）', () => {
    // 与 exposure-lint 的自校验同族：判据词表是机制的一部分，不是可清的数据。
    const selfCheck = expectationSelfCheck();
    expect(selfCheck.problems).toEqual([]);
    expect(selfCheck.ok).toBe(true);
  });

  it('未审计占位条目没有 expectations——不猜期望值，也不因此多报', () => {
    for (const spec of cases.filter((item) => item.placeholder)) {
      expect(spec.expectations, `${spec.id} 是占位条目，不应有期望值`).toBeNull();
      expect(evaluateCaseExpectations(spec, [])).toEqual({ violations: [], checks: [] });
    }
  });

  it('进基线的用例都有期望值声明（否则第四层在该用例上恒空）', () => {
    for (const spec of cases.filter((item) => item.inBaseline && item.kind === 'probe')) {
      expect(spec.expectations, `${spec.id} 进基线但缺 expectations`).not.toBeNull();
    }
  });
});
