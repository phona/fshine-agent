/**
 * 探针侧纯函数单测（PR #21 八审 major 的回归锁）。
 *
 * 覆盖 caseReportInputOf：intents / gateRows / delegations 必须按**全部轮次**累积。
 * 旧写法 `intents: turns.at(-1)?.intents` 只取最后一轮，而 report.ts 的
 * countInterventionPoints 只数 status=pending——提案等用户确认后提交成功时最终态是
 * committed，那个"用户必须确认"的停点就从干预指标里消失，完整写链被报成零次干预。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_INSTRUCTION, auditOutgoingText, caseReportInputOf, errorStateNotes } from './probe-real-agent';
import { mergeCallPhases, type ExecutionAuditRow } from './eval/evidence';
import { buildCaseReport } from './eval/report';
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
// 换成 audit-declaration 的五查交叉核 note（口径编造照跑、derived 保留）。

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

  it('必备要素齐备且中性（两种行示例 + 无数字不需要块 + 不提 eval/测试）', () => {
    expect(AUDIT_INSTRUCTION).toContain('[audit]');
    expect(AUDIT_INSTRUCTION).toContain('[/audit]');
    expect(AUDIT_INSTRUCTION).toContain('<-');
    expect(AUDIT_INSTRUCTION).toContain(':=');
    expect(AUDIT_INSTRUCTION).toContain('rec-XXX');
    expect(AUDIT_INSTRUCTION).toContain('某笔记录的 value');
    expect(AUDIT_INSTRUCTION).toContain('回复里没有数字时不需要块');
    // 每轮生效的语义来源（指令只注入第一轮、靠转录续效）。
    expect(AUDIT_INSTRUCTION).toContain('每轮回复末尾');
    // 中性：不带业务口径、不提 eval/测试/harness 字样。
    expect(AUDIT_INSTRUCTION).not.toMatch(/eval|test|测试|probe|harness|payable|bank|debt|collection|window/i);
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
   * `500 <- rec-101`（beta 真实 500）能五查全过。所以 audited 路径不是把整条"无所属"note
   * 换掉，而是只把"完全没有归属"那一半交给申报块；实体/window 绑定照跑。
   */
  it('audited 模式：张冠李戴照红（交叉核对不上"挂给谁"这一类）', () => {
    const reply = 'alpha-item-1 record value is 500. Please try another name.\n[audit]\n500 <- rec-101\n[/audit]';
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: { items: [{ id: 'rec-101', name: 'beta-item-1', value: 500 }], count: 1 } },
    ];
    const audited = errorStateNotes(auditTurn(reply, 'check beta record value', rows), [], [], true);
    // 申报与事实对得上（500 确是 rec-101 的值）⇒ 五查无 note；但 500 挂在 alpha-item-1 上。
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
