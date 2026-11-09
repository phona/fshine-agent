/**
 * 探针侧纯函数单测（PR #21 八审 major 的回归锁）。
 *
 * 覆盖 caseReportInputOf：intents / gateRows / delegations 必须按**全部轮次**累积。
 * 旧写法 `intents: turns.at(-1)?.intents` 只取最后一轮，而 report.ts 的
 * countInterventionPoints 只数 status=pending——提案等用户确认后提交成功时最终态是
 * committed，那个"用户必须确认"的停点就从干预指标里消失，完整写链被报成零次干预。
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_INSTRUCTION, QUICK_CASE_IDS, auditFailureCount, auditFailuresFieldOf, auditFailuresOf,
  auditOutgoingText, caseReportInputOf, errorStateNotes, loadBaselineForProbe, unifiedCasePassedOf,
} from './probe-real-agent';
import { mergeCallPhases, type ExecutionAuditRow } from './eval/evidence';
import { classifyAuditDeclaration } from './eval/audit-declaration';
import { buildCaseReport } from './eval/report';
import { auditFailuresCheckOf, evaluateProbeCase, type ProbeResultRow } from './eval/score';
import { emptyDimCounts } from './eval/dims';
import { loadCases } from './eval/cases';
import {
  MOCK_ACCOUNTS,
  MOCK_COLLECTION_WINDOWS,
  MOCK_ITEMS,
  MOCK_ITEM_IDS,
  MOCK_ITEM_VALUES,
} from './eval/dummy-fixture';

const turn = (messageId: string, intents: Array<{ intentId: string; status: 'pending' | 'committed' }>) => ({
  text: '录入',
  reply: 'r',
  ms: 10,
  notices: [],
  messageId,
  calls: 1,
  refusedCalls: 0,
  taskIds: [],
  execution: [],
  gateRows: [],
  intents: intents.map((i) => ({ intentId: i.intentId, status: i.status, hasReadback: i.status === 'committed' })),
  delegations: [],
  ladder: [],
  ladderRung: 'completed' as const,
});

const item = { id: 'probe-5.1', group: 'acceptance 写链', intent: '录入' };

describe('caseReportInputOf：宿主事实按全部轮次累积（八审 major）', () => {
  it('intents 累积全部轮次，而非只取最后一轮', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }]),
      turn('m2', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    expect(input.intents.map((i) => `${i.intentId}:${i.status}`)).toEqual(['i1:pending', 'i1:committed']);
  });

  it('提案等确认后提交成功，干预停点仍计入 1（旧写法会报 0）', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }]),
      turn('m2', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    const line = buildCaseReport(input);
    expect(line.interventionPoints).toBe(1);
  });

  it('从未 pending 的意图不计停点', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    expect(buildCaseReport(input).interventionPoints).toBe(0);
  });

  it('多个不同意图各自计一次（不因同 status 合并）', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }, { intentId: 'i2', status: 'pending' }]),
    ], { ok: true, notes: [] });
    expect(buildCaseInput_safe(input)).toBe(2);
  });
});

// 小工具：避免在本文件里再引一次 aggregateMetrics 的类型噪音。
function buildCaseInput_safe(input: ReturnType<typeof caseReportInputOf>): number {
  return buildCaseReport(input).interventionPoints;
}

/**
 * 注意（2026-11-09 十二审）：本文件钉住 mergeCallPhases 的口径，但**钉不住探针真的用了它**。
 * 探针的 calls/refusedCalls 取 mergedRows 这件事，变异测试打不到——那条路只有真模型回合
 * 才走得到（本文件全程离线）。已做的补偿：① 直接读代码确认接线在位（探针 :540/:556/:560
 * 与用例级 caseRows 都走 mergeCallPhases）；② 真跑一次 --only A1 确认调用数正常。
 * 后续若要把这条也钉住，需要给探针的 send 注入替身审计行——那是另一个工程量，登记在案。
 */
describe('起止合并后的调用数口径（十二审 major）', () => {
  it('一次成功提案调用计 1 次，不是 2 次', () => {
    // 复现缺陷：calls/refusedCalls 直接数审计行，而起止两行让一次成功提案被计成两次。
    const rows = [
      { callId: 'c1', phase: 'start' as const, mode: 'commit', script: 'dummy.proposal-commit' },
      { callId: 'c1', phase: 'result' as const, mode: 'commit', script: 'dummy.proposal-commit', exitCode: 0 },
    ];
    const merged = mergeCallPhases(rows);
    expect(merged.filter((r) => !r.refused)).toHaveLength(1);
    expect(merged.filter((r) => r.refused)).toHaveLength(0);
  });

  it('一次被令牌门拒的提交计 1 次拒绝，不是 1 次已执行', () => {
    // 复现缺陷：start 行没有 refused，按原始行数会被计成"已执行"——让最小调用数检查假绿。
    const rows = [
      { callId: 'c1', phase: 'start' as const, mode: 'commit', script: 'dummy.proposal-commit' },
      { callId: 'c1', phase: 'result' as const, mode: 'commit', script: 'dummy.proposal-commit', exitCode: 3, refused: 'proposal' },
    ];
    const merged = mergeCallPhases(rows);
    expect(merged.filter((r) => !r.refused)).toHaveLength(0);
    expect(merged.filter((r) => r.refused)).toHaveLength(1);
  });
});

// ── audited 申报模式接线（--audit；D-206/D-207） ──
// 黑盒模式（默认）行为零变化由两条钉住：① auditOutgoingText(audit=false) 对 yaml 原文
// 逐字返回；② errorStateNotes(audit=false) 的 note 集合与原三条一致（本组每个黑盒
// 对照例）。audited 模式只改两处：首轮出站文本加指令前缀；错误态「无所属金额」note
// 换成 audit-declaration 的交叉核 note（口径编造照跑、derived 保留）。

/** errorStateNotes 的最小 Turn 替身（同文件既有 turn() 的同款抽法；只填判定用字段）。 */
const auditTurn = (reply: string, text: string, execution: ExecutionAuditRow[] = []) => ({
  text,
  reply,
  ms: 10,
  notices: [],
  messageId: 'm1',
  calls: 0,
  refusedCalls: 0,
  taskIds: [],
  execution,
  gateRows: [],
  intents: [],
  delegations: [],
  ladder: [],
  ladderRung: 'completed' as const,
});

describe('--audit 首轮指令前缀（auditOutgoingText：黑盒逐字、audited 只加第一条）', () => {
  // 用 cases.yaml 的真实语料钉"逐字"——不另编文本，钉的是 yaml → 出站这条通路。
  const y2 = loadCases().find((spec) => spec.id === 'Y2');
  const firstText = y2?.messages[0]?.text ?? '';
  const secondText = y2?.messages[1]?.text ?? '';

  it('flag 关闭时首轮出站文本逐字等于 yaml 文本', () => {
    expect(firstText.length).toBeGreaterThan(0);
    expect(auditOutgoingText(firstText, 0, false)).toBe(firstText);
  });

  it('flag 关闭时后续轮同样逐字等于 yaml 文本', () => {
    expect(secondText.length).toBeGreaterThan(0);
    expect(auditOutgoingText(secondText, 1, false)).toBe(secondText);
  });

  it('--audit 打开：首轮 = 指令前缀 + yaml 文本逐字保留在前缀之后', () => {
    const outgoing = auditOutgoingText(firstText, 0, true);
    expect(outgoing.startsWith(AUDIT_INSTRUCTION)).toBe(true);
    expect(outgoing).toBe(`${AUDIT_INSTRUCTION}${firstText}`);
    // spec.messages 本身不改的推论：前缀只是出站包装，yaml 原文一个字符都没动。
    expect(firstText).toBe(y2?.messages[0]?.text);
  });

  it('--audit 打开：后续轮不加前缀（指令经转录持续可见，不逐轮重复）', () => {
    expect(auditOutgoingText(secondText, 1, true)).toBe(secondText);
    expect(auditOutgoingText(secondText, 2, true)).toBe(secondText);
  });
});

describe('AUDIT_INSTRUCTION 词表纪律（防回归钉子：词表清空/被真实词污染即红）', () => {
  it('一个数字都不许有（数字进指令 → 模型回显 → 覆盖查假红）', () => {
    expect(AUDIT_INSTRUCTION).not.toMatch(/[0-9]/);
  });

  it('夹具真实词表逐族零命中', () => {
    // turn.text 喂 asked windows / account 提及 / DUMMY_ITEM_NAME / 公司名 / 期间多条
    // 判定正则——真实词漏进指令会造假红，所以这里对全族词表断言而不只点名几个。
    const forbidden: readonly string[] = [
      ...MOCK_ACCOUNTS,
      ...Object.values(MOCK_ITEMS).flat(),
      ...MOCK_ITEM_IDS,
      ...Object.values(MOCK_COLLECTION_WINDOWS).flat(),
      ...Object.values(MOCK_ITEM_VALUES).map(String),
      // 点名族（ask 明示的禁用词，即使哪天从夹具消失也钉在这）。
      'rec-101', 'alpha', 'beta', 'W1', '500',
    ];
    for (const token of forbidden) {
      expect(AUDIT_INSTRUCTION.includes(token), `指令不得含夹具真实词「${token}」`).toBe(false);
    }
    // 形态级（显式词表之外的漏网形态）：dummy item 名族与公司后缀族。
    expect(AUDIT_INSTRUCTION).not.toMatch(/[a-z0-9][a-z0-9-]*-item-\d+/i);
    expect(AUDIT_INSTRUCTION).not.toMatch(/\b[A-Za-z][A-Za-z0-9&.'-]{1,30}(?:[ .-](?:LLC|Ltd|Inc|GmbH|Co|Corp|Company))\b/);
  });

  it('必备要素齐备且中性（三种行示例 + 无数字不需要块 + 不提 eval/测试）', () => {
    expect(AUDIT_INSTRUCTION).toContain('[audit]');
    expect(AUDIT_INSTRUCTION).toContain('[/audit]');
    expect(AUDIT_INSTRUCTION).toContain('<-');
    expect(AUDIT_INSTRUCTION).toContain(':=');
    // 行数必须是三种（旧文案「只有两种行」把命题行排除在外，真实跑批不可达）。
    expect(AUDIT_INSTRUCTION).toContain('共三种行');
    expect(AUDIT_INSTRUCTION).toContain('rec-XXX');
    expect(AUDIT_INSTRUCTION).toContain('某笔记录的 value');
    // 第三种命题行必须由指令教给模型，否则真实 audited 跑永远不会产生 nocaliber/notfound。
    expect(AUDIT_INSTRUCTION).toContain('nocaliber(');
    expect(AUDIT_INSTRUCTION).toContain('notfound(');
    // := 的 RHS 语义必须写明"实算等于左侧"，否则模型不知道算式会被验算。
    expect(AUDIT_INSTRUCTION).toContain('实算必须等于左侧');
    expect(AUDIT_INSTRUCTION).toContain('回复里没有数字时不需要块');
    // 无数字轮也可以只写命题行——否则 notfound/nocaliber 恰好在最需要它的错误态轮
    // 被"没有数字不需要块"劝退。
    expect(AUDIT_INSTRUCTION).toContain('只写对应的命题行');
    // 每轮生效的语义来源（指令只注入第一轮、靠转录续效）。
    expect(AUDIT_INSTRUCTION).toContain('每轮回复末尾');
    // 机器会核的三条义务必须教齐（2026-11-09 评审 medium）：标记锚定 / 覆盖 / 闭合。
    expect(AUDIT_INSTRUCTION).toContain('独占一行');
    expect(AUDIT_INSTRUCTION).toContain('行首');
    expect(AUDIT_INSTRUCTION).toContain('行尾');
    expect(AUDIT_INSTRUCTION).toContain('每个数字都必须有一条引用行或运算行申报');
    expect(AUDIT_INSTRUCTION).toContain('每个加数也必须有申报行可依');
    expect(AUDIT_INSTRUCTION).toContain('逐层递归到引用行');
    // 中性：不带业务口径、不提 eval/测试/harness 字样。
    expect(AUDIT_INSTRUCTION).not.toMatch(/eval|test|测试|probe|harness|payable|bank|debt|collection|window/i);
  });

  /**
   * 指令回路（2026-11-09 评审 medium）：按指令字面教出的形状（标记独占行 + 引用行 +
   * 运算行 + 每个加数都有引用行）必须被解析器接受；反过来，指令遗漏的三种义务各造一个
   * 违例，确认解析器确实会判红（否则指令补义务是空话）。
   */
  it('指令所教形状可被解析器接受（标记独占行 + 加数递归引用）', () => {
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: {
        status: 'completed', items: [{ id: 'rec-a', name: 'left', value: 60 }, { id: 'rec-b', name: 'right', value: 40 }], count: 2,
      } },
    ];
    const reply = '合计 100。\n[audit]\n60 <- rec-a\n40 <- rec-b\n100 := 60 + 40\n[/audit]';
    const verdict = classifyAuditDeclaration(reply, rows);
    expect(verdict.findings).toEqual([]);
    expect(verdict.lines.map((line) => line.kind)).toEqual(['reference', 'reference', 'operation']);
  });

  it('指令三义务的违例各红一条：未覆盖 / 加数未申报 / 标记未锚定', () => {
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: {
        status: 'completed', items: [{ id: 'rec-a', value: 500 }, { id: 'rec-b', value: 60 }], count: 2,
      } },
    ];
    // 覆盖：正文有 500、块里只有别的值。
    expect(classifyAuditDeclaration('结果是 500。\n[audit]\n300 <- rec-a\n[/audit]', rows).findings.map((f) => f.check).sort())
      .toEqual(['coverage', 'valueMismatch']);
    // 闭合：:= 的加数没有引用行。
    expect(classifyAuditDeclaration('合计 100。\n[audit]\n60 <- rec-b\n100 := 60 + 40\n[/audit]', rows).findings.map((f) => f.check))
      .toEqual(['operationClosure']);
    // 标记锚定：[/audit] 后跟正文 ⇒ 未闭合。
    expect(classifyAuditDeclaration('结果是 500。\n[audit]\n500 <- rec-a\n[/audit]。', rows).findings.map((f) => f.check))
      .toEqual(['format']);
  });
});

describe('errorStateNotes 的 audited 接线（无所属 → 申报交叉核；口径编造照跑、derived 保留）', () => {
  const unattributedTurn = () => auditTurn(
    'The platform returned no data for that query. It is 700. Please try another name.',
    'check beta record value',
  );
  const caliberTurn = () => auditTurn(
    'beta payable balance is 500. Please confirm which record you mean.',
    'check beta payable balance',
  );
  const mismatchRows: ExecutionAuditRow[] = [
    { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } },
  ];

  it('黑盒模式：无所属金额 note 照旧', () => {
    const notes = errorStateNotes(unattributedTurn(), [], []);
    expect(notes.some((n) => n.startsWith('错误态回复出现无所属金额数字'))).toBe(true);
  });

  /**
   * 2026-11-09 评审 high 的直接接线锁：伪实体扫描曾把 well-known / real-time 当未知实体，
   * 让 "beta-item-1 has a well-known value of 500" 在**共享黑盒路径**产生无所属/张冠李戴
   * note（errorStateNotes 的金额归属两条），把正确值判成假红。
   */
  it('黑盒模式：普通英文复合词不产生金额归属 note（well-known / real-time）', () => {
    for (const reply of [
      'beta-item-1 has a well-known value of 500. Please confirm.',
      'beta-item-1 real-time value is 500. Please confirm.',
    ]) {
      const notes = errorStateNotes(auditTurn(reply, 'check beta payable balance', mismatchRows), [], []);
      expect(notes.filter((n) => n.startsWith('错误态回复出现无所属金额数字')), reply).toEqual([]);
      expect(notes.filter((n) => n.startsWith('错误态回复把金额挂到不属于它的实体')), reply).toEqual([]);
    }
  });

  it('audited 模式：无所属那条被交叉核 note 替换', () => {
    const notes = errorStateNotes(unattributedTurn(), [], [], true);
    expect(notes.some((n) => n.startsWith('错误态回复出现无所属金额数字'))).toBe(false);
    expect(notes.some((n) => n.includes('回复有数字但没有 [audit] 申报块'))).toBe(true);
  });

  it('audited 模式：口径编造 note 照跑（classifyErrorStateAmounts 不整块跳过）', () => {
    const blackbox = errorStateNotes(caliberTurn(), [], []);
    const audited = errorStateNotes(caliberTurn(), [], [], true);
    const caliber = (ns: string[]) => ns.filter((n) => n.startsWith('错误态回复把平台没有的口径'));
    expect(caliber(blackbox)).toHaveLength(1);
    expect(caliber(audited)).toHaveLength(1);
  });

  it('audited 模式：derived 信息性 note 保留；申报与事实对得上时交叉核不出 note', () => {
    const reply = [
      'The record values are 500 and 300, and the total is 800. Please let me know if you need more.',
      '[audit]',
      '500 <- rec-101',
      '300 <- rec-102',
      '800 := 500 + 300',
      '[/audit]',
    ].join('\n');
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [
        { id: 'rec-101', name: 'beta-item-1', value: 500 },
        { id: 'rec-102', name: 'beta-item-2', value: 300 },
      ], count: 2 } },
    ];
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', rows), [], [], true);
    expect(audited.some((n) => n.startsWith('（信息性）错误态回复出现真实数据加总'))).toBe(true);
    expect(audited.some((n) => n.startsWith('申报') || n.includes('申报块'))).toBe(false);
  });

  it('audited 模式：交叉核真在判申报-事实一致性（申报值不符即 note；黑盒那条不出现）', () => {
    const reply = [
      'The platform returned no data. The record value is 999.',
      '[audit]',
      '999 <- rec-101',
      '[/audit]',
      'Please try another name.',
    ].join('\n');
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', mismatchRows), [], [], true);
    expect(audited.some((n) => n.startsWith('申报值不符：记录号 rec-101 申报 999'))).toBe(true);
    expect(audited.some((n) => n.startsWith('错误态回复出现无所属金额数字'))).toBe(false);
    // 同一回复黑盒模式下仍走无所属那条——两条路径互不污染。
    const blackbox = errorStateNotes(auditTurn(reply, 'check beta record value', mismatchRows), [], []);
    expect(blackbox.some((n) => n.startsWith('错误态回复出现无所属金额数字'))).toBe(true);
    expect(blackbox.some((n) => n.startsWith('申报值不符'))).toBe(false);
  });

  /**
   * 张冠李戴留在原判据上（2026-11-09 独立评审）：交叉核只核「数 ↔ 记录号在 result.items 里
   * 的 value」，不看这个数在正文里挂给哪个实体——"alpha-item-1 record value is 500" 配
   * `500 <- rec-101`（beta 真实 500）能交叉核全过。所以 audited 路径不是把整条"无所属"note
   * 换掉，而是只把"完全没有归属"那一半交给申报块；实体/window 绑定照跑。
   */
  it('audited 模式：张冠李戴照红（交叉核对不上"挂给谁"这一类）', () => {
    const reply = 'alpha-item-1 record value is 500. Please try another name.\n[audit]\n500 <- rec-101\n[/audit]';
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } },
    ];
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', rows), [], [], true);
    // 申报与事实对得上（500 确是 rec-101 的值）⇒ 交叉核无 note；但 500 挂在 alpha-item-1 上。
    expect(audited.some((n) => n.startsWith('申报'))).toBe(false);
    expect(audited.some((n) => n.startsWith('错误态回复把金额挂到不属于它的实体/window'))).toBe(true);
    // 黑盒路径同一条（misattributed ⊂ unattributed，合并口径不变）。
    const blackbox = errorStateNotes(auditTurn(reply, 'check beta record value', rows), [], []);
    expect(blackbox.some((n) => n.startsWith('错误态回复出现无所属金额数字'))).toBe(true);
  });

  it('audited 模式：申报块补上的归属不判张冠李戴（"完全没有归属"才交给交叉核）', () => {
    // 正文没点名任何实体、只给了合计：黑盒会算"无所属"，audited 由申报块补归属，且不挂错实体。
    const reply = 'The total is 1000. Please let me know.\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]';
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [
        { id: 'rec-101', name: 'beta-item-1', value: 500 },
        { id: 'rec-102', name: 'beta-item-2', value: 300 },
        { id: 'rec-103', name: 'beta-item-3', value: 200 },
      ], count: 3 } },
    ];
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', rows), [], [], true);
    expect(audited.filter((n) => n.startsWith('错误态回复把金额挂到不属于它的实体/window'))).toEqual([]);
    expect(audited.filter((n) => n.startsWith('申报'))).toEqual([]);
  });

  it('audited 模式：误差判定吃答案正文——块行本身不额外判成张冠李戴', () => {
    // 块行 `700 <- rec-101`（rec-101 真实 500）自己就是"点名 rec-101 而金额不属于它"的形态：
    // 分句判定若吃含块原文，会在申报值不符之外再多判一条张冠李戴（同一根因摊成两条 note）。
    // 剥块后只留交叉核那一票。
    const reply = 'The platform returned no data. Please try another name.\n[audit]\n700 <- rec-101\n[/audit]';
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', mismatchRows), [], [], true);
    expect(audited.some((n) => n.startsWith('申报值不符：记录号 rec-101 申报 700'))).toBe(true);
    expect(audited.filter((n) => n.startsWith('错误态回复把金额挂到不属于它的实体/window'))).toEqual([]);
  });
});

/**
 * 报告行的 audited 申报失败计数（PR #26 评审 blocking）：交叉核失败的 note 归不进四维、
 * 落 unclassified，评分器不门 unclassified —— 判定输出因此必须另有一列进报告行。
 */
describe('audited 申报失败计数进报告行（auditFailures）', () => {
  const rows: ExecutionAuditRow[] = [
    { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } },
  ];
  // 两条不同检查并红：rec-101 申报 999（值不符）+ rec-404 不在 result.items（幻影源）。
  const twoFindingReply = 'The record values are 999 and 777.\n[audit]\n999 <- rec-101\n777 <- rec-404\n[/audit]';
  const cleanReply = 'The record value is 500. Please try another name.\n[audit]\n500 <- rec-101\n[/audit]';

  it('逐错误态轮累计 findings 全量——两条不同检查并红计 2（不枚举失败种类）', () => {
    expect(auditFailureCount([auditTurn(twoFindingReply, 'check beta record value', rows)])).toBe(2);
  });

  it('申报全对的轮计 0；多轮计数求和', () => {
    expect(auditFailureCount([auditTurn(cleanReply, 'check beta record value', rows)])).toBe(0);
    expect(auditFailureCount([
      auditTurn(cleanReply, 'check beta record value', rows),
      auditTurn(twoFindingReply, 'check beta record value', rows),
    ])).toBe(2);
  });

  it('黑盒报告行不产该字段；audited 行只在真跑过计数时产（缺席不写成 0）', () => {
    expect(auditFailuresFieldOf(false, 9)).toEqual({});
    expect('auditFailures' in auditFailuresFieldOf(false, 9)).toBe(false);
    expect(auditFailuresFieldOf(true, 2)).toEqual({ auditFailures: 2 });
    // 缺席 = 没跑交叉核，不能冒充"查过且全过"；score.ts 对缺计数 fail-closed。
    expect(auditFailuresFieldOf(true, undefined)).toEqual({});
    expect('auditFailures' in auditFailuresFieldOf(true, undefined)).toBe(false);
  });
});

/**
 * 公共收集入口（PR #26 评审 3 / codex major）：计数不能靠各 runner 自觉返回——旧写法只有
 * A2/A3/A4/Y2 有，A1/A5/B1 缺列，而 score.ts 对 audited 报告任一缺列 exit 2，--quick --audit
 * 即使申报全对也整份报告打不了分。现在 main() 对每个 runner 的 turns 统一调 auditFailuresOf。
 */
describe('auditFailures 公共收集入口：默认子集每个 runner 都产列且值对', () => {
  const rows: ExecutionAuditRow[] = [
    { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } },
  ];
  const twoFindingReply = 'The record values are 999 and 777.\n[audit]\n999 <- rec-101\n777 <- rec-404\n[/audit]';
  const cleanReply = 'The record value is 500. Please try another name.\n[audit]\n500 <- rec-101\n[/audit]';
  const turns = () => [
    auditTurn(cleanReply, 'check beta record value', rows),
    auditTurn(twoFindingReply, 'check beta record value', rows),
  ];

  it('默认子集 = --quick 的 A1/A2/A4/A5/B1（含非错误态用例）', () => {
    expect([...QUICK_CASE_IDS].sort()).toEqual(['A1', 'A2', 'A4', 'A5', 'B1']);
  });

  for (const id of [...QUICK_CASE_IDS].sort()) {
    it(`${id}：audited 报告行带 auditFailures 列，值 = 逐轮 findings 累计`, () => {
      const field = auditFailuresOf(true, turns());
      expect(field.auditFailures).toBe(2);
      // 接到评分面：不再是「缺计数」fail-closed，而是按实值对照上限判红。
      const verdict = evaluateProbeCase(`probe-${id}`, {
        id, ok: true, dims: emptyDimCounts(), unclassifiedNotes: 0, notes: [], turns: [], ...field,
      }, { dims: emptyDimCounts() }, undefined, undefined, true);
      const check = verdict.checks.find((item) => item.name === 'audited·申报失败');
      expect(check).toMatchObject({ pass: false, actual: '2' });
    });
  }

  it('零轮占位用例记显式不适用（不是 0）：检查照出但不冒充"查过且全过"', () => {
    // 2026-11-09 评审 medium：旧断言 `auditFailures: 0` 把零轮占位写成"查过且全过"。
    expect(auditFailuresOf(true, [])).toEqual({ auditFailures: 'not-applicable' });
    expect(auditFailuresCheckOf('not-applicable', 0)).toMatchObject({ pass: true, actual: '不适用' });
  });

  it('没有平台证据的轮次不核：auditMissing / execution 为空都不算申报失败', () => {
    // auditMissing = 审计源不可读，证据缺席 ≠ 零申报；execution 为空 = 该轮没有平台调用
    // （纯闲聊/日期轮的英文年份会被 extractAmounts 当金额，旧实现因此假红 format）。
    const missing = { ...auditTurn(cleanReply, 'check beta record value', rows), auditMissing: true, execution: [] };
    expect(auditFailuresOf(true, [missing])).toEqual({ auditFailures: 'not-applicable' });
    const chat = auditTurn('It is November 2026.', '现在几月了？', []);
    expect(auditFailuresOf(true, [chat])).toEqual({ auditFailures: 'not-applicable' });
    // 混合：只计有平台证据的那一轮。
    expect(auditFailuresOf(true, [chat, auditTurn(twoFindingReply, 'check beta record value', rows)]))
      .toEqual({ auditFailures: 2 });
  });

  it('黑盒不产列（缺席 ≠ 0，旧行为不变）', () => {
    expect(auditFailuresOf(false, turns())).toEqual({});
    expect('auditFailures' in auditFailuresOf(false, turns())).toBe(false);
  });
});

/**
 * 统一报告判定与 score.ts 同源（2026-11-09 评审 low）：旧实现自建空 dims / -1 calls /
 * 恒吃 input.ok，minExecutedCalls（D1/X1）与 okMode free（A2/B1/Y2）都会与 score.ts 打架。
 * 现在直接复用 evaluateProbeCase；只有未进基线的用例走最小口径。
 */
describe('统一报告与 score.ts 同源判定（unifiedCasePassedOf）', () => {
  const probeRow = (over: Partial<ProbeResultRow> = {}): ProbeResultRow => ({
    id: 'A1', ok: true, dims: emptyDimCounts(), unclassifiedNotes: 0, notes: [], turns: [], ...over,
  });
  const baselineCase = { dims: emptyDimCounts() };

  it('申报失败但其余判据通过 ⇒ passed=false（旧写法会因 input.ok 报绿）', () => {
    expect(unifiedCasePassedOf(probeRow({ auditFailures: 2 }), undefined, baselineCase, true)).toBe(false);
  });

  it('申报全过 ⇒ passed=true', () => {
    expect(unifiedCasePassedOf(probeRow({ auditFailures: 0 }), undefined, baselineCase, true)).toBe(true);
  });

  it('audited 缺计数 ⇒ passed=false（与 score.ts 缺列 fail-closed 同口）', () => {
    expect(unifiedCasePassedOf(probeRow(), undefined, baselineCase, true)).toBe(false);
  });

  it('显式不适用 ⇒ passed=true（零轮/无证据不是失败，也不是 0）', () => {
    expect(unifiedCasePassedOf(probeRow({ auditFailures: 'not-applicable' }), undefined, baselineCase, true)).toBe(true);
  });

  it('黑盒不消费申报计数（旧行为不变）', () => {
    expect(unifiedCasePassedOf(probeRow(), undefined, baselineCase, false)).toBe(true);
  });

  it('与 evaluateProbeCase 同判：同一计数/上限下通过性一致', () => {
    const limit = { dims: emptyDimCounts(), auditFailures: 1 };
    for (const [failures, expected] of [[1, true], [2, false]] as const) {
      const row = probeRow({ auditFailures: failures });
      expect(evaluateProbeCase('probe-A1', row, limit, undefined, undefined, true).pass).toBe(expected);
      expect(unifiedCasePassedOf(row, undefined, limit, true, 'probe-A1')).toBe(expected);
    }
  });

  it('真实 calls 参与判定：D1 minExecutedCalls=8 用实数，不再固定 -1', () => {
    const d1 = loadCases().find((spec) => spec.id === 'D1')!;
    const reply = 'alpha、beta、contoso-trade、fabrikam-retail：1200、800、500、300、200、1500、600、880';
    const rowOf = (calls: number): ProbeResultRow => probeRow({
      id: 'D1',
      turns: [{ text: d1.messages[0]!.text!, reply, notices: ['计划通知'], calls, refusedCalls: 0, execution: [] }],
    });
    expect(unifiedCasePassedOf(rowOf(8), d1, baselineCase, false, 'probe-D1')).toBe(true);
    expect(unifiedCasePassedOf(rowOf(4), d1, baselineCase, false, 'probe-D1')).toBe(false);
  });

  it('okMode free：free 模式不因探针 ok=false 判负（dims 仍按基线 cap）', () => {
    const free = { dims: emptyDimCounts(), okMode: 'free' as const };
    expect(unifiedCasePassedOf(probeRow({ ok: false }), undefined, free, false)).toBe(true);
    expect(unifiedCasePassedOf(probeRow({ ok: false }), undefined, baselineCase, false)).toBe(false);
  });

  it('dims cap 参与判定：超过基线上限 ⇒ passed=false', () => {
    const capped = { dims: { ...emptyDimCounts(), groundedness: 0 } };
    expect(unifiedCasePassedOf(probeRow({ dims: { ...emptyDimCounts(), groundedness: 1 } }), undefined, capped, false)).toBe(false);
  });
});

/**
 * 基线取数的失败面（2026-11-09 评审 low）：黑盒路径不消费基线，不能让缺失/损坏的
 * baseline.json 在所有用例跑完后把探针打挂；audited 路径的申报门需要上限，仍 fail-closed。
 */
describe('loadBaselineForProbe：黑盒缺失放宽、audited 仍 fail-closed', () => {
  const missing = '/nonexistent/fshine-baseline.json';
  it('黑盒：基线不可读 ⇒ undefined（降级到探针 ok + 期望值层，不打死探针）', () => {
    expect(loadBaselineForProbe(false, missing)).toBeUndefined();
  });
  it('audited：基线不可读 ⇒ 原样抛出（申报失败门的上限不能猜）', () => {
    expect(() => loadBaselineForProbe(true, missing)).toThrow(/ENOENT|no such file/i);
  });
});
