import { describe, expect, it } from 'vitest';
import { loadCases } from './cases';
import { evaluateCaseExpectations, expectationSelfCheck, type ExpectationTurn } from './expectations';
import type { ExecutionAuditRow } from './evidence';
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

/**
 * Y2 第 3 轮**历史真实回复原文**（修复单 1/2 的原料，逐字转录，不混合成）：
 *   · Y2_T2_REAL_BOX = `.runtime/probe-fshine-probe-cZ07DK.json`（2026-11-09 09:46 黑盒
 *     实测跑）Y2 turns[2].reply——"beta-item-1 — value 500" 就是正确引用 beta 明细那句；
 *   · Y2_T2_REAL_TABLE = `.runtime/probe-fshine-probe-pr0c9f.json`（2026-11-09 09:52
 *     audited 实测跑，该轮回复未附申报块）Y2 turns[2].reply——表格明细 + "合计 1000"
 *     （1000 走算术派生通道）同场，且正文多处置身 gamma-collection（夹具外名字）。
 * 新断言（entityAttribution）必须先在这两条原文上双向验证：跑新断言必须空（不假红），
 * 把 beta 的 500 挂给 alpha-item-1 必须红（真能抓）。不用合成 spec 自说自话——上一轮
 * 的病就是把 forbidCaliberValues 改成 [500] 自证；真实 Y2 spec 的禁值只有 [1000]，
 * 500 的红只能来自归属本身。
 */
const Y2_T2_REAL_BOX = `查询完成。结果如下：

**collection "beta" 中不存在名为 "payable balance"（应付余额）的 record，因此无法返回其 value。**

平台实时查询确认：

- collection "beta" 存在，仅有窗口 W1，共 3 条记录：
  - beta-item-1 — value 500
  - beta-item-2 — value 300
  - beta-item-3 — value 200
- 该 collection 内没有名为 "payable balance" 的记录，也没有窗口 W2（beta 只有 W1）。

为排除名称歧义，我还核查了平台上其余可见 collection（alpha、alpha-group、contoso-trade、contoso-logistics、fabrikam-retail、fabrikam-wholesale、locked-one、empty-one），均无 "payable balance" 这条记录；另外，线索中的 "gamma-collection" 在平台上不存在。

如需进一步定位，请确认该记录的确切名称或其所属 collection 名称，我可以重新查询。`;

const Y2_T2_REAL_TABLE = `按方案执行的查询已跑完，结果如下：

**方案中的调用（gamma-collection / W2）→ 未能取到数据**

平台返回：\`gamma-collection\` 这个集合名匹配不到任何集合，候选为空。也就是说该名称在平台上不存在，不是数据缺失或窗口无数据的问题，而是名称本身无法解析。

**已另行查到的、与「beta」相关的结果（唯一窗口 W1）**

| 记录 | 数值 |
|---|---|
| beta-item-1 | 500 |
| beta-item-2 | 300 |
| beta-item-3 | 200 |
| 合计 | 1000 |

另需说明两点：
- \`W2\` 窗口对 beta 集合没有数据，beta 只有 W1 一个窗口。
- 平台记录只有「名称」和「数值」两列，没有名为 payable balance 的字段，因此无法按该名称定位到具体余额；上表是 beta 集合 W1 下的全部记录及合计。

**具体阻碍**：方案里指定的集合名 \`gamma-collection\` 在平台上不存在，现有集合为 alpha、beta、alpha-group、contoso-trade、fabrikam-retail、fabrikam-wholesale。要拿到目标数据，需要你确认这个名称是否笔误、正确集合名是什么；如果本意就是查 beta，则 W1 的数据已在上面给出，但「payable balance」这个字段名平台侧没有对应列，也需你确认它指合计还是某一项。`;

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

  it('calls=-1（审计源不可读）不是证据：不报"调用数不足"，重查/闲聊族也不拿它当判定', () => {
    // 2026-11-10 独立评审 medium：探针在 auditMissing 时记 -1（不可知）。旧写法把它
    // 原样返回——minExecutedCalls 拿 -1 与阈值比，报"已执行调用不足"（假红）；
    // requeryPerTurn / chitchatZeroCalls 则因 -1 既不等于 0 也不大于 0 而静默放过（假绿）。
    const unknown = { ...noEvidenceTurn, calls: -1 };
    expect(evaluateCaseExpectations(spec, [unknown]).checks.some((check) => check.name === '期望·调用数(第1轮)')).toBe(false);
    const requery = evaluateCaseExpectations(specOf('B1'), [unknown, unknown]).checks;
    expect(requery.some((check) => check.name.startsWith('期望·每轮真查'))).toBe(false);
    const chitchat = evaluateCaseExpectations(
      specOf('C2'),
      Array.from({ length: 30 }, () => unknown),
    ).checks;
    expect(chitchat.some((check) => check.name.startsWith('期望·闲聊零调用'))).toBe(false);
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

/**
 * 申报豁免收窄（2026-11-09 PR #26 评审 major）：PR #26 把「已申报值」一律移出
 * `forbidCaliberValues` 检查，于是正文把 beta 的 500 挂给 alpha-item-1、再如实申报
 * `500 <- rec-101`，交叉核过、禁值检查也被消掉。豁免必须收窄为
 * 「引用行（<-）申报过 + 不在 verdict.misattributed 里」，且不得洗白轮次适当性：
 * 申报证明"数有出处"，不证明"挂对了"，也不证明"这轮该说"。
 *
 * 校准用 cases.yaml 的 Y2 第 1/3 轮：第 3 轮引用真实值作佐证是合法形态（继续绿），
 * 第 1 轮（not_found）给数必须红——即使申报属实。
 */
describe('期望值层：申报豁免收窄（PR #26 评审 major）', () => {
  const TEXTS = [
    'check gamma-collection 这个 collection W2 的 record value',
    'check contoso collection record value',
    'checkbeta的payablebalance',
  ];
  type Item = { id: string; name: string; value: number };
  const betaFacts: Item[] = [
    { id: 'rec-101', name: 'beta-item-1', value: 500 },
    { id: 'rec-102', name: 'beta-item-2', value: 300 },
    { id: 'rec-103', name: 'beta-item-3', value: 200 },
  ];
  const contosoFacts: Item[] = [
    { id: 'rec-401', name: 'contoso-trade-item-1', value: 1500 },
    { id: 'rec-402', name: 'contoso-trade-item-2', value: 600 },
  ];
  // args 逐轮不同：同参重复风暴是过程不变量自己的判定面（与 turn() 同款理由）。
  const auditedTurn = (index: number, prose: string, block: string, items: Item[]): ExpectationTurn => ({
    text: TEXTS[index]!,
    reply: `${prose}\n${block}`,
    notices: [],
    calls: 1,
    execution: [{ script: 'dummy.query', args: ['--collection', `a${index}`], exitCode: 0,
      result: { items, count: items.length } }] satisfies ExecutionAuditRow[],
    audited: true,
  });
  const failing = (turns: ExpectationTurn[], spec = specOf('Y2')): string[] =>
    evaluateCaseExpectations(spec, turns).checks.filter((check) => !check.pass).map((check) => check.name);
  /** 三轮 Y2 外壳（第 1/2 轮用原回复/原判据，第 3 轮由调用方给）。 */
  const shell = (turn2: ExpectationTurn): ExpectationTurn[] => [
    turn(TEXTS[0]!, Y2_T0, 1, 0),
    turn(TEXTS[1]!, Y2_T1, 1, 1),
    turn2,
  ];

  it('张冠李戴 + 如实申报 ⇒ 红（真实 Y2 spec：禁值只有 1000，500 的挂错仍必须红）', () => {
    // 不把 500 塞进 forbidCaliberValues——真实 Y2 只禁 1000。正文把 beta 的 500 挂给
    // alpha-item-1；申报行 `500 <- rec-101` 与事实完全对得上。张冠李戴是独立硬失败。
    const t2 = auditedTurn(2, 'alpha-item-1 record value is 500。请确认。', '[audit]\n500 <- rec-101\n[/audit]', betaFacts);
    expect(failing(shell(t2), specOf('Y2'))).toEqual(['期望·张冠李戴(第3轮)']);
    const violations = evaluateCaseExpectations(specOf('Y2'), shell(t2)).violations;
    expect(violations.some((violation) => violation.kind === 'shortCase' && violation.message.includes('500'))).toBe(true);
  });

  it('未登记的凭空名字 + 如实申报 ⇒ 红（显式归属未登记名字，audited 不再假绿）', () => {
    // 2026-11-10 独立评审 medium：仲裁 2 拆伪实体扫描后，foo-item-1 这类未登记名字只落
    // unattributed；audited 把 unattributed 交给申报交叉核，于是 `500 <- rec-101` 能洗白
    // "正文挂给了谁"。unregisteredAttribution 只收显式归属措辞 + 夹具命名形状，补回这一维。
    const t2 = auditedTurn(2, 'foo-item-1 record value is 500。请确认。', '[audit]\n500 <- rec-101\n[/audit]', betaFacts);
    expect(failing(shell(t2), specOf('Y2'))).toEqual(['期望·张冠李戴(第3轮)']);
  });

  it('not_found 轮的真实值 + 如实申报 ⇒ 红（回归锁：forbidValues/零金额本来就不看 declared）', () => {
    // 这条钉的是既有的轮次适当性判据——forbidValues / notFoundZeroAmounts 从未把 declared
    // 当豁免面，因此它是回归锁，不是"申报豁免收窄"的修复证据。收窄的修复证据见上一条
    // 张冠李戴 + 真实 Y2 spec 的用例。
    const prose = `${Y2_T0}\n另：contoso-trade 的 W2 窗口下有两条记录（值 1500、600）。`;
    const t0 = auditedTurn(0, prose, '[audit]\n1500 <- rec-401\n600 <- rec-402\n[/audit]', contosoFacts);
    const checks = evaluateCaseExpectations(specOf('Y2'), [t0, turn(TEXTS[1]!, Y2_T1, 1, 1), turn(TEXTS[2]!, '平台没有 payable 这个口径。beta W1 的 record value 是 500、300、200，合计 1000。', 1, 2)]).checks;
    const names = checks.filter((check) => !check.pass).map((check) => check.name);
    // 禁值（forbidValues）与错误态零金额两条都不看 declared，是轮次适当性的硬边界。
    expect(names).toContain('期望·禁值(第1轮)');
    expect(names).toContain('期望·错误态零金额(第1轮)');
  });

  it('第 3 轮引用真实值作佐证（引用行申报、非张冠李戴）⇒ 绿', () => {
    // 与上面同一批真实值、同一申报块，只是放在允许引用佐证的第 3 轮（Y2 现有合法形态）。
    const t2 = auditedTurn(2, '平台没有 payable 这个口径。beta W1 的 record value 是 500、300、200，合计 1000。',
      '[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]', betaFacts);
    expect(failing(shell(t2))).toEqual([]);
  });

  it('`:=` 行申报的值不豁免（验算归 cross-check，期望值层只认引用行）', () => {
    const spec = structuredClone(specOf('Y2'));
    spec.expectations!.shortCase!.turns[2]!.forbidCaliberValues = [4321];
    // 4321 只在运算行里申报，正文里无所属——旧「一律豁免」会把它洗白。
    const t2 = auditedTurn(2, '平台没有 payable 这个口径。其中 4321 待确认。', '[audit]\n4321 := 4000 + 321\n[/audit]', []);
    expect(failing(shell(t2), spec)).toEqual(['期望·禁值(第3轮)']);
  });
});

/**
 * 实体键归属（entityAttribution，2026-11-09 修复单 1/2；2026-11-09 仲裁 2 改登记制）：
 * 本轮回复里**点名了的实体**，归给它的值集必须是它真实值集的子集。判定直接消费
 * classifyErrorStateAmounts 的 verdict.misattributed（不重造绑定逻辑），非空即红；事实
 * 来源 = 夹具的记录归属（dummy-fixture ENTITY_REAL_VALUES / MOCK_ITEM_VALUES /
 * MOCK_ITEM_ID_BINDINGS / MOCK_ABSENT_COLLECTIONS，逐条抄自夹具种子或用例查询事实）
 * ——模型之外的事实，可对。misattributed 是**硬失败归属信号**（含 window×实体无效的绑定；
 * 算术派生——行内明细的合计——落 derived 不记红）。
 *
 * 2026-11-09 仲裁 2：绑定面只收登记过的名字。**已登记的不存在对象**（gamma-collection，
 * Y2 第 1 轮查询过、平台答过 not_found）作为零值实体进表，挂非零金额即张冠李戴；**未
 * 登记的凭空名字**（foo-item-1）不进最近前置绑定。2026-11-10 评审 medium 补：正文用
 * 显式归属措辞把金额挂给它时，unregisteredAttribution 单列硬失败（audited 申报块只核
 * 数↔记录值，核不到"挂给谁"）；普通复合词/占位符由名字形状闸挡在门外。
 *
 * 双向验证只用**历史真实回复原文**（Y2_T2_REAL_BOX / Y2_T2_REAL_TABLE，见各自注释里的
 * 探针报告出处），不拿合成 spec 自说自话。注意真实 spec 的禁值只有 [1000]：500 是第 3
 * 轮合法佐证，所以"beta 的 500 挂给 alpha-item-1"的红**只能**来自归属断言本身。
 */
describe('期望值层：实体键归属（entityAttribution——点名实体的值集 ⊆ 真实值集）', () => {
  const TEXTS = [
    'check gamma-collection 这个 collection W2 的 record value',
    'check contoso collection record value',
    'checkbeta的payablebalance',
  ];
  /** 三轮 Y2 外壳（第 1/2 轮用既有干净夹具回复，第 3 轮由调用方给）。 */
  const shell = (turn2: ExpectationTurn): ExpectationTurn[] => [
    turn(TEXTS[0]!, Y2_T0, 1, 0),
    turn(TEXTS[1]!, Y2_T1, 1, 1),
    turn2,
  ];
  const failing = (turns: ExpectationTurn[]): string[] =>
    evaluateCaseExpectations(specOf('Y2'), turns).checks.filter((check) => !check.pass).map((check) => check.name);

  it('schema：断言进真实 Y2 用例（cases.yaml 第 3 轮 entityAttribution: true），不靠隐藏耦合', () => {
    const turn2 = specOf('Y2').expectations!.shortCase!.turns[2]!;
    expect(turn2.entityAttribution).toBe(true);
    // 与口径绑定正交：同轮两个键各管一头（"编了哪个口径" / "数挂给了谁"）。
    expect(turn2.missingCaliber).toBe('payable');
  });

  it('不假红：Y2 第 3 轮真实回复原文（正确引用 beta 明细）跑新断言全绿', () => {
    // 黑盒实测原文（beta-item-1 — value 500 逐字）。
    expect(failing(shell(turn(TEXTS[2]!, Y2_T2_REAL_BOX, 3, 2)))).toEqual([]);
    // 表格 + 合计 1000 实测原文：1000 走算术派生（分句合计 + 可加出的真实值），同样全绿；
    // 正文里 gamma-collection（夹具外名字）出现多次但与金额不同分句，不构成归属主张。
    expect(failing(shell(turn(TEXTS[2]!, Y2_T2_REAL_TABLE, 13, 2)))).toEqual([]);
  });

  it('真能抓：同一真实回复把 beta 的 500 挂给 alpha-item-1 ⇒ 张冠李戴红', () => {
    const misbound = Y2_T2_REAL_BOX.replace('beta-item-1 — value 500', 'alpha-item-1 — value 500');
    expect(misbound).not.toBe(Y2_T2_REAL_BOX); // 变异确实施加上了（防 replace 静默失配）
    expect(failing(shell(turn(TEXTS[2]!, misbound, 3, 2)))).toEqual(['期望·张冠李戴(第3轮)']);
    const violations = evaluateCaseExpectations(specOf('Y2'), shell(turn(TEXTS[2]!, misbound, 3, 2))).violations;
    expect(violations.some((violation) => violation.kind === 'shortCase' && violation.message.includes('500'))).toBe(true);
    // 表格形态同抓（| beta-item-1 | 500 | → | alpha-item-1 | 500 |；1000 的合计派生不受影响）。
    const misboundTable = Y2_T2_REAL_TABLE.replace('| beta-item-1 | 500 |', '| alpha-item-1 | 500 |');
    expect(failing(shell(turn(TEXTS[2]!, misboundTable, 13, 2)))).toEqual(['期望·张冠李戴(第3轮)']);
  });

  it('已登记的不存在对象：正文把真实值挂给 gamma-collection ⇒ 张冠李戴（各措辞形态）', () => {
    // 2026-11-09 仲裁 2：gamma-collection 是 Y2 第 1 轮查询过、平台答过 not_found 的对象
    // （dummy-fixture MOCK_ABSENT_COLLECTIONS 登记为零值实体）——挂非零金额即假归属。
    // 判别力不靠词法形状（伪实体扫描已拆），靠登记事实。
    for (const prose of [
      'gamma-collection record value is 500。请确认。',
      'gamma-collection 的记录值是 500。请确认。',
      'gamma-collection balance is 500。请确认。',
      'gamma-collection 的余额是 500。请确认。',
    ]) {
      expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2))), prose).toEqual(['期望·张冠李戴(第3轮)']);
    }
  });

  it('未登记的凭空名字：foo-item-1 显式归属各措辞 ⇒ 张冠李戴硬红（audited 不再假绿）', () => {
    // 2026-11-10 独立评审 medium：没有登记事实的名字不进 misattributed，但正文用显式
    // 归属措辞把金额挂给它时，unregisteredAttribution 单列一维——申报块只核数↔记录值，
    // 核不到"正文挂给了谁"。普通复合词（well-known / rec-XXX）由形状闸挡在门外。
    for (const prose of [
      'foo-item-1 record value is 500。请确认。',
      'foo-item-1 的记录值是 500。请确认。',
      'foo-item-1 balance is 500。请确认。',
      'foo-item-1 的余额是 500。请确认。',
      'foo-item-1: 500',
    ]) {
      expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2))), prose).toEqual(['期望·张冠李戴(第3轮)']);
    }
  });

  it('豁免交互：已登记不存在对象 + 如实申报引用行 ⇒ declaredExempt 吞不掉（申报只证数有出处，不证挂对）', () => {
    type Item = { id: string; name: string; value: number };
    const betaFacts: Item[] = [
      { id: 'rec-101', name: 'beta-item-1', value: 500 },
      { id: 'rec-102', name: 'beta-item-2', value: 300 },
      { id: 'rec-103', name: 'beta-item-3', value: 200 },
    ];
    const auditedTurn = (prose: string, block: string): ExpectationTurn => ({
      text: TEXTS[2]!,
      reply: `${prose}\n${block}`,
      notices: [],
      calls: 1,
      execution: [{ script: 'dummy.query', args: ['--collection', 'a2'], exitCode: 0,
        result: { items: betaFacts, count: betaFacts.length } }] satisfies ExecutionAuditRow[],
      audited: true,
    });
    // 申报行逐字对事实（500 确是 rec-101 的值）——「一律豁免」也不能把"挂给谁"一起洗白。
    expect(failing(shell(auditedTurn('平台没有 payable 这个口径。gamma-collection record value is 500。', '[audit]\n500 <- rec-101\n[/audit]'))))
      .toEqual(['期望·张冠李戴(第3轮)']);
    // 对照组：同一个值正确挂给 beta-item-1 + 同一申报行 ⇒ 绿（豁免面没收窄成恒红，
    // 红只来自"挂给了谁"这一维）。
    expect(failing(shell(auditedTurn('平台没有 payable 这个口径。beta-item-1 record value is 500。', '[audit]\n500 <- rec-101\n[/audit]'))))
      .toEqual([]);
  });

  it('不假红：未知名字在场、金额正确挂给已知实体 ⇒ 绿（绑定面收窄，不是整句抹黑）', () => {
    for (const prose of [
      '平台没有 payable 这个口径。beta-item-1 的值是 500，foo-item-1 不存在。',
      '平台没有 payable 这个口径。gamma-collection 不存在；beta-item-1 record value is 500。',
      '平台没有 payable 这个口径。beta W1 的 record value 是 500、300、200，合计 1000。',
    ]) {
      expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2))), prose).toEqual([]);
    }
  });

  /**
   * 2026-11-09 评审 2：行内明细 + 合计是常见诚实形态。合计挂在最后一条 item 上时不能因为
   * "所绑实体单值不含合计"就记张冠李戴——明细列总计改绑所属 collection（totalOwnerCollection），
   * 1000 按 beta 的全额（500+300+200）验，落 derived。
   * 孪生红：合计写错（1200）仍必须红。
   */
  it('不假红：行内明细 "beta-item-1 = 500、…，合计 1000" ⇒ 绿（合计绑所属 collection）', () => {
    const prose = '平台没有 payable 这个口径。beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1000。请确认。';
    expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2)))).toEqual([]);
  });

  it('孪生：同形态的错误合计 1200 ⇒ 张冠李戴红（放宽并集不放过算错的合计）', () => {
    const prose = '平台没有 payable 这个口径。beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1200。请确认。';
    expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2)))).toContain('期望·张冠李戴(第3轮)');
  });

  it('不假红：未知 not-found 对象在前、金额明确归属后随实体 ⇒ 绿（倒装归属）', () => {
    for (const prose of [
      '平台没有 payable 这个口径。gamma-collection not found, but 500 is the value of beta-item-1. Please confirm.',
      '平台没有 payable 这个口径。gamma-collection 不存在，500 是 beta-item-1 的记录值。请确认。',
    ]) {
      expect(failing(shell(turn(TEXTS[2]!, prose, 1, 2))), prose).toEqual([]);
    }
  });

  /**
   * 2026-11-09 同行评审 low 的期望值面复现：alpha 被更长的 alpha-related 遮蔽后不能
   * 留在 specific 里把 500 记成"挂给 alpha"——否则 declaredExempt 被挡、entityAttribution
   * 假红。如实申报引用行时整轮应绿。
   */
  it('specific 用过滤后 mentions：alpha-related + 如实申报 ⇒ 不误红', () => {
    const audited: ExpectationTurn = {
      text: TEXTS[2]!,
      reply: '500 for alpha-related comparison. Please confirm.\n[audit]\n500 <- rec-101\n[/audit]',
      notices: [],
      calls: 1,
      execution: [{ script: 'dummy.query', args: ['--collection', 'a2'], exitCode: 0,
        result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } }] satisfies ExecutionAuditRow[],
      audited: true,
    };
    expect(failing(shell(audited))).toEqual([]);
  });

  /**
   * 2026-11-09 同行评审 low：entityAttribution 是 generic 键，但事实表静态来自 dummy-fixture。
   * 非 dummy 夹具必须在事实源守卫处红，且不得再拿 dummy 的值做归属判定。
   */
  it('事实源守卫：非 dummy-platform 夹具 ⇒ 出守卫红，不以 dummy 事实判张冠李戴', () => {
    const y2 = specOf('Y2');
    const stock = { ...y2, fixture: { ...y2.fixture, name: 'stock-platform' } };
    const prose = 'alpha-item-1 record value is 500。请确认。';
    const names = evaluateCaseExpectations(stock, shell(turn(TEXTS[2]!, prose, 1, 2)))
      .checks.filter((check) => !check.pass).map((check) => check.name);
    expect(names).toContain('期望·实体归属事实源(第3轮)');
    expect(names).not.toContain('期望·张冠李戴(第3轮)');
  });

  /**
   * 2026-11-09 评审 9（正面护栏）：entityAttribution 的事实表**静态**来自 dummy-fixture
   * （分类器编译期 import），因此"开这个键"与"fixture.name === 'dummy-platform'"必须同时
   * 成立。负面用例（上面）钉非 dummy 夹具出守卫红；这条钉正面事实——每个开键的轮次其
   * 用例夹具都已是 dummy-platform。将来给别的夹具接上事实表时，这两条一起放开。
   */
  it('事实源护栏（正面）：开 entityAttribution 的每个轮次，其用例夹具都是 dummy-platform', () => {
    const opened: Array<{ id: string; turn: number }> = [];
    for (const spec of cases) {
      for (const [index, turn2] of (spec.expectations?.shortCase?.turns ?? []).entries()) {
        if (turn2.entityAttribution) opened.push({ id: spec.id, turn: index });
      }
    }
    expect(opened.length, '至少有一个用例开 entityAttribution（全空则本断言与负面用例都失去意义）').toBeGreaterThan(0);
    for (const { id, turn: index } of opened) {
      const spec = cases.find((item) => item.id === id)!;
      expect(spec.fixture.name, `${id} 第 ${index + 1} 轮开了 entityAttribution`).toBe('dummy-platform');
    }
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
