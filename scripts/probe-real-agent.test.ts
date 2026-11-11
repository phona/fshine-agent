/**
 * 探针侧纯函数单测（PR #21 八审 major 的回归锁）。
 *
 * 覆盖 caseReportInputOf：intents / gateRows / delegations 必须按**全部轮次**累积。
 * 旧写法 `intents: turns.at(-1)?.intents` 只取最后一轮，而 report.ts 的
 * countInterventionPoints 只数 status=pending——提案等用户确认后提交成功时最终态是
 * committed，那个"用户必须确认"的停点就从干预指标里消失，完整写链被报成零次干预。
 */
import { fork, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CASE_CHILD_STDIO, CASE_RESULT_SENTINEL, QUICK_CASE_IDS, auditFailureCount, auditFailuresFieldOf, auditFailuresOf,
  auditOutgoingText, caseCallCountsOf, caseCrashOf, caseReportInputOf, childFailureNote, crashEvidenceFromChildPayload, errorStateNotes,
  isolatePlatformState, loadBaselineForProbe, parseChildCasePayload, probeAuditPath, probeCaseStateDir,
  realAmounts, recallMissed, restorePlatformState, runCaseChildProcess,
  unifiedCasePassedOf,
  type ScriptLine, type Turn,
} from './probe-real-agent';
import { AUDIT_INSTRUCTION } from './eval/audit-instruction';
import { mergeCallPhases, type ExecutionAuditRow } from './eval/evidence';
import { classifyAuditDeclaration } from './eval/audit-declaration';
import { buildCaseReport, buildUnifiedReport } from './eval/report';
import { auditFailuresCheckOf, evaluateProbeCase, type ProbeResultRow } from './eval/score';
import { countDims, emptyDimCounts } from './eval/dims';
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
// 换成 audit-declaration 的交叉核 note（缺失口径表面事实/derived 保留）。

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
    expect(AUDIT_INSTRUCTION).toContain('回复里没有金额数字时不需要块');
    // 无数字轮也可以只写命题行——否则 notfound/nocaliber 恰好在最需要它的错误态轮
    // 被"没有数字不需要块"劝退。
    expect(AUDIT_INSTRUCTION).toContain('只写对应的命题行');
    // 每轮生效的语义来源（指令只注入第一轮、靠转录续效）。
    expect(AUDIT_INSTRUCTION).toContain('每轮回复末尾');
    // 机器会核的三条义务必须教齐（2026-11-09 评审 medium）：标记锚定 / 覆盖 / 闭合。
    expect(AUDIT_INSTRUCTION).toContain('独占一行');
    expect(AUDIT_INSTRUCTION).toContain('行首');
    expect(AUDIT_INSTRUCTION).toContain('行尾');
    expect(AUDIT_INSTRUCTION).toContain('每个金额数字都必须有一条引用行或运算行申报');
    expect(AUDIT_INSTRUCTION).toContain('每个加数也必须有申报行可依');
    expect(AUDIT_INSTRUCTION).toContain('逐层递归到引用行');
    // 指令不得比交叉核更严（2026-11-10 独立评审 medium）：判据对日期样数字与零值免申报、
    // 封闭数字语法不收千分位/单位；照字面执行指令的合作模型会因申报日期或写 `1,000`
    // 吃假红。两条豁免/格式义务必须教给模型。
    expect(AUDIT_INSTRUCTION).toContain('日期样数字（如年份）和零值不是金额，不需要申报');
    expect(AUDIT_INSTRUCTION).toContain('不要使用千分位分隔符、货币符号或单位后缀');
    // 逐轮事实域消歧（2026-11-10 独立评审 low）：召回轮零调用复述此前查询得到的金额在
    // audited 门下不可表达（无块 ⇒ 格式红；补引用行 ⇒ 本轮事实域无该记录 ⇒ 幻影源红），
    // 指令必须把"每个带金额的轮次本轮重查"教给模型，而不是让照召回语义写的回复吃假红。
    expect(AUDIT_INSTRUCTION).toContain('申报只以本轮回复前的平台查询为据');
    expect(AUDIT_INSTRUCTION).toContain('需要复述就先在本轮重新查询');
    // 中性：不带业务口径、不提 eval/测试/harness 字样。
    expect(AUDIT_INSTRUCTION).not.toMatch(/eval|test|测试|probe|harness|payable|bank|debt|collection|window/i);
  });

  /**
   * 指令回路（2026-11-09 评审 3）：**指令自身的示例块**必须能被解析器接受——模型照抄
   * 示例，示例错了等于指令教出红。示例只用尖括号占位（零数字纪律），这里把占位替换成
   * 安全数值后进场；义务段三句也在本测试内断言——删掉任一条义务，本测试先红，而不是只
   * 让旁边的字符串断言红。
   */
  it('指令自身示例块（占位替换后）能过解析器；义务段三句缺一即红', () => {
    // 机器会核的三条义务必须在指令里（删义务段 ⇒ 本测试先红）。
    for (const clause of [
      '两个标记各独占一行',
      '正文里出现的每个金额数字都必须有一条引用行或运算行申报',
      '运算行右侧的每个加数也必须有申报行可依',
    ]) {
      expect(AUDIT_INSTRUCTION, `指令缺机器义务「${clause}」`).toContain(clause);
    }
    // 取示例块：行首 [audit] 到行尾 [/audit]。首句里的行中标记是正文（模型复述指令的
    // 形态），不是示例块；这里与解析器同一扫描口径，示例块缺失/未锚定即红。
    const example = /(?:^|\n)(\[audit\]\n[\s\S]*?\n\[\/audit\])(?=\n|$)/.exec(AUDIT_INSTRUCTION)?.[1];
    expect(example, '指令缺可解析示例块（行首 [audit] / 行尾 [/audit]）').toBeTruthy();
    const reply = `合计 <合计>。\n${example!}`
      .replaceAll('<加数一>', '60')
      .replaceAll('<记录号一>', 'rec-a')
      .replaceAll('<加数二>', '40')
      .replaceAll('<记录号二>', 'rec-b')
      .replaceAll('<合计>', '100');
    const rows: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: {
        status: 'completed', items: [{ id: 'rec-a', name: 'left', value: 60 }, { id: 'rec-b', name: 'right', value: 40 }], count: 2,
      } },
    ];
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

describe('errorStateNotes 的 audited 接线（无所属 → 申报交叉核；缺失口径表面事实/derived 保留）', () => {
  const unattributedTurn = () => auditTurn(
    'The platform returned no data for that query. It is 700. Please try another name.',
    'check beta record value',
  );
  const caliberTurn = () => auditTurn(
    '平台没有 payable 口径，beta 的应付余额合计是 1000，请确认。',
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

  it('口径表面事实只出信息性 note（黑盒/audited 同口径；旧口径违例 note 已删除）', () => {
    const caliberNotes = (ns: string[]) => ns.filter((n) => n.startsWith('（信息性）缺失口径表面事实'));
    for (const notes of [
      errorStateNotes(caliberTurn(), [], []),
      errorStateNotes(caliberTurn(), [], [], true),
    ]) {
      const found = caliberNotes(notes);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('payable');
      expect(found[0]).toContain('1000');
      expect(found[0]).toContain('同句');
      expect(found[0]).toContain('表面事实；口径判定归 judge（答案分类表）');
      expect(notes.some((n) => n.startsWith('错误态回复把平台没有的口径'))).toBe(false);
    }
  });

  it('口径表面事实 note 不计违例：只触发它的回复 ok 不受影响、四维零计数', () => {
    const reply = '平台没有 payable 口径，beta 的应付余额合计是 1000，请确认。';
    const notes = errorStateNotes(auditTurn(reply, 'check beta payable balance'), [], []);
    expect(notes.filter((n) => n.startsWith('（信息性）缺失口径表面事实'))).toHaveLength(1);
    // ok 判据与探针主循环同式（notes.every 信息性）；信息性 note 也不进四维/未归维计数。
    expect(notes.every((note) => note.startsWith('（信息性）'))).toBe(true);
    expect(countDims(notes)).toEqual({ dims: emptyDimCounts(), unclassified: 0 });
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
 * 澄清问句判据（2026-11-10 校准）：探针与期望值层曾各存一份逐字相同的正则——两层
 * "一致"不是独立确认，是同一把尺量了两次。Y2 实测第 2 轮「请补充以下信息之一 …
 * 或者说明是否连同 window 一起调整」两层同时判"没有问句"（假红）。现在两层都
 * import scripts/eval/clarification-shape.ts；这里钉探针消费点（clarificationShapeNotes
 * 经 errorStateNotes 的 note 文案不变）。
 */
describe('澄清问句判据：探针层消费同一份 shared 判据', () => {
  const CANDIDATES = ['contoso-trade', 'contoso-logistics'] as const;
  /** Y2 第 2 轮实测原文（逐字转录自 .runtime/probe-fshine-probe-IhdXQv.json）。 */
  const Y2_T1_ACTUAL = `未完成：无法唯一确定要查询的 collection。

平台实时查询返回：关键词 "contoso" 匹配到两个 collection——

- contoso-trade
- contoso-logistics

平台要求确认确切的 collection 名称后重查，在名称唯一确定前不会返回任何 record value（不做猜测）。

请补充以下信息之一：
1. 确切的 collection 全名（contoso-trade 或 contoso-logistics，或你实际想查的其它名称）；
2. 或者说明是否连同 window 一起调整（当前请求带的是 W2）。

拿到确切名称后，我会立即重新查询并给出该 collection 在 W2 下的 record value。`;

  it('Y2 实测第 2 轮判有问句（旧词表漏「请补充 / 或者说明是否」）', () => {
    const notes = errorStateNotes(
      auditTurn(Y2_T1_ACTUAL, 'check contoso collection record value'),
      CANDIDATES,
      [],
    );
    expect(notes.filter((note) => note.startsWith('澄清回复没有问句'))).toEqual([]);
  });

  it('负向对照：候选全列但只是罗列、无请求动作 ⇒ 仍判没有问句（判据不是恒真）', () => {
    const notes = errorStateNotes(
      auditTurn('contoso-trade 与 contoso-logistics 都在目录里。', 'check contoso collection record value'),
      CANDIDATES,
      [],
    );
    expect(notes.filter((note) => note.startsWith('澄清回复没有问句'))).toHaveLength(1);
  });
});

/**
 * 风暴两口径披露（2026-11-10 校准）：硬尺只数**本轮**同参重复；整例跨轮聚合只写进
 * 信息性 note，且必须同时写明「单轮 X 次 / 整例 Y 次」——旧版探针只说单轮数，
 * 期望值层旧版按整例平铺判红，同一份审计行两个口径、报告不解释。
 */
describe('错误轮风暴：信息性 note 同时写明单轮与整例两个口径', () => {
  const row = () => ({ script: 'dummy.query', args: ['--collection', 'beta'], exitCode: 0 });

  it('单轮 ×2 + 另一轮 ×1：无硬风暴 note，信息性 note 同时披露 2 次 / 3 次', () => {
    const thisTurn = [row(), row()];
    const caseRows = [...thisTurn, row()];
    const notes = errorStateNotes(
      { ...auditTurn('beta W1 没有数据，请换一个名称。', 'check beta record value'), calls: 2 },
      [],
      thisTurn,
      false,
      caseRows,
    );
    expect(notes.filter((note) => note.startsWith('错误轮同一调用重复'))).toEqual([]);
    const info = notes.filter((note) => note.startsWith('（信息性）错误轮平台调用数'));
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('单轮同一调用最多重复 2 次');
    expect(info[0]).toContain('整例 3 次');
  });

  it('单轮 ×3：硬风暴 note 照旧（单轮口径判违例），不被信息性文案替代', () => {
    const rows = [row(), row(), row()];
    const notes = errorStateNotes(
      { ...auditTurn('beta W1 没有数据，请换一个名称。', 'check beta record value'), calls: 3 },
      [],
      rows,
      false,
      rows,
    );
    expect(notes.some((note) => note.startsWith('错误轮同一调用重复 3 次'))).toBe(true);
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
    // 2026-11-10 评审 2 high：N/A **不得判过**——"整例没有可核轮"意味着交叉核既没跑也没
    // 过；actual 与真实计数失败可区分（不适用 vs 计数）。
    expect(auditFailuresCheckOf('not-applicable', 0)).toMatchObject({ pass: false, actual: '不适用（整例没有可核轮）' });
  });

  it('auditMissing 轮不可核 ⇒ 显式 unverifiable，门判失败（不因同例另有干净轮次放行）', () => {
    // 2026-11-10 独立评审 high：旧写法跳过 auditMissing 轮，只要另一轮可核就回数字——
    // phantom 申报（rec-ghost）永远不被核，整例照过。证据缺席 = 核不了，不是不适用。
    const missing = { ...auditTurn(cleanReply, 'check beta record value', rows), auditMissing: true, execution: [] };
    expect(auditFailuresOf(true, [missing])).toEqual({ auditFailures: 'unverifiable' });
    expect(auditFailuresCheckOf('unverifiable', 0)).toMatchObject({ pass: false, actual: '不可核（审计源不可读）' });
    // 混合：干净轮次不能给缺失证据的那一轮背书。
    const mixed = auditFailuresOf(true, [auditTurn(cleanReply, 'check beta record value', rows), missing]);
    expect(mixed).toEqual({ auditFailures: 'unverifiable' });
    expect(auditFailuresCheckOf(mixed.auditFailures, 0).pass).toBe(false);
  });

  it('没有平台证据且没写申报块的轮次不核（纯闲聊/日期轮）', () => {
    // execution 为空 = 该轮没有平台调用（纯闲聊/日期轮的英文年份会被 extractAmounts
    // 当金额，旧实现因此假红 format）；没有申报块就没有可核的申报。
    const chat = auditTurn('It is November 2026.', '现在几月了？', []);
    expect(auditFailuresOf(true, [chat])).toEqual({ auditFailures: 'not-applicable' });
    // 混合：只计有平台证据的那一轮。
    expect(auditFailuresOf(true, [chat, auditTurn(twoFindingReply, 'check beta record value', rows)]))
      .toEqual({ auditFailures: 2 });
  });

  it('没有平台证据但写了申报块 ⇒ 照核（phantom 申报不被整轮跳过）', () => {
    // 2026-11-10 独立评审 high 的复现形态：回复带 `[audit]` 块、该轮 execution 为空。
    // 空事实基准下引用行必是幻影源、加数无申报行，不能因为"没有平台调用"就跳过整轮。
    const phantom = auditTurn('小计 800。\n[audit]\n500 <- rec-ghost\n800 := 500 + 300\n[/audit]', 'check beta record value', []);
    const field = auditFailuresOf(true, [phantom]);
    expect(typeof field.auditFailures).toBe('number');
    expect(field.auditFailures as number).toBeGreaterThan(0);
    expect(auditFailuresCheckOf(field.auditFailures, 0).pass).toBe(false);
  });

  it('零证据轮回复里有金额 ⇒ 判红不跳过——"无证据 ≠ 通过"（2026-11-10 评审 2 high）', () => {
    // 反例：该轮没有任何平台调用，回复却给出金额（没查就答 ⇒ 无据可核）。旧实现对
    // "execution 为空 + 没有申报块"整轮跳过，该轮不计失败、整例照过；现在按
    // hasAuditableContent 照核——空事实基准下"有数字没有块"就是格式红。
    const unevidenced = auditTurn('The total is 1000.', '现在几月了？', []);
    const field = auditFailuresOf(true, [unevidenced]);
    expect(typeof field.auditFailures).toBe('number');
    expect(field.auditFailures as number).toBeGreaterThan(0);
    expect(auditFailuresCheckOf(field.auditFailures, 0).pass).toBe(false);
    // 孪生诚实：同一句话在有平台证据的轮次且申报完备 ⇒ 0（判据核的是"无据可核"，
    // 不是这句话本身——不恒红）。
    const evidenced: ExecutionAuditRow[] = [
      { callId: 'c1', phase: 'result', mode: 'query', script: 'dummy.query', result: {
        status: 'completed', items: [
          { id: 'rec-101', name: 'beta-item-1', value: 500 },
          { id: 'rec-102', name: 'beta-item-2', value: 300 },
          { id: 'rec-103', name: 'beta-item-3', value: 200 },
        ], count: 3,
      } },
    ];
    const clean = auditTurn(
      'The total is 1000.\n[audit]\n500 <- rec-101\n300 <- rec-102\n200 <- rec-103\n1000 := 500 + 300 + 200\n[/audit]',
      'check beta record value', evidenced,
    );
    expect(auditFailuresOf(true, [clean])).toEqual({ auditFailures: 0 });
    expect(auditFailuresCheckOf(0, 0).pass).toBe(true);
  });

  it('黑盒不产列（缺席 ≠ 0，旧行为不变）', () => {
    expect(auditFailuresOf(false, turns())).toEqual({});
    expect('auditFailures' in auditFailuresOf(false, turns())).toBe(false);
  });
});

/**
 * 统一报告判定与 score.ts 同源（2026-11-09 评审 low）：旧实现自建空 dims / -1 calls /
 * 恒吃 input.ok，minExecutedCalls（D1/X1）与 okMode free（A2/B1/Y2）都会与 score.ts 打架。
 * 现在直接复用 evaluateProbeCase；未进基线的用例与 score.ts 的 skipped 同口径跳过
 * （baselineKnown 时返回 undefined），只有基线整份不可读（baselineKnown=false）才走最小口径。
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

  it('显式不适用 ⇒ passed=false（"整例没有可核轮"不是"查过且全过"——2026-11-10 评审 2 high）', () => {
    expect(unifiedCasePassedOf(probeRow({ auditFailures: 'not-applicable' }), undefined, baselineCase, true)).toBe(false);
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
    // D1 不在 baseline.json（inBaseline=false）：基线已加载时统一报告按 score.ts 的
    // skipped 同口径跳过（unifiedCasePassedOf 返回 undefined，见下一条）。这里显式传
    // baselineKnown=false 模拟"基线整份不可读的黑盒降级"——只有这条最小口径才逐条消费
    // expectations，用它钉住真实 calls（旧实现固定 -1 的回归从这里漏过去）。
    expect(unifiedCasePassedOf(rowOf(8), d1, undefined, false, 'probe-D1', false)).toBe(true);
    expect(unifiedCasePassedOf(rowOf(4), d1, undefined, false, 'probe-D1', false)).toBe(false);
    // 基线可读但 D1 不在基线：跳过，不冒充通过也不计入分母（与 score.ts 一致）。
    expect(unifiedCasePassedOf(rowOf(8), d1, undefined, false, 'probe-D1')).toBeUndefined();
  });

  it('占位条目（Q5b/Q13b）从未跑 ⇒ undefined 跳过，不冒充通过', () => {
    // 2026-11-10 独立评审 medium：占位 runner 返回 turns: []、ok=true、expectations: null，
    // 旧写法走最小口径 row.ok && 空 checks ⇒ 统一报告计为通过，与 score.ts 跳过非基线
    // 用例不一致。跳过值不进通过率分母（report.metricInputs 同口径）。
    const q5b = loadCases().find((spec) => spec.id === 'Q5b')!;
    expect(q5b.placeholder).toBe(true);
    expect(unifiedCasePassedOf(probeRow({ id: 'Q5b' }), q5b, undefined, false)).toBeUndefined();
    expect(unifiedCasePassedOf(probeRow({ id: 'Q5b' }), q5b, undefined, true)).toBeUndefined();
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

  it('calls=-1（审计源不可读）在 score.ts 与统一报告两条路径都不出调用数判定', () => {
    // 2026-11-10 独立评审 medium：-1 是探针的不可知哨兵，不是"零调用"。两个消费面
    // （score.ts 的 evaluateProbeCase / 统一报告的 unifiedCasePassedOf）共用
    // expectations.ts 的 callsEvidenceOf，任一边把它当证据都会漂移：minExecutedCalls
    // 拿 -1 比阈值假红，requery/chitchat 拿 -1 当零假绿。
    const d1 = loadCases().find((spec) => spec.id === 'D1')!;
    const reply = 'alpha、beta、contoso-trade、fabrikam-retail：1200、800、500、300、200、1500、600、880';
    const rowOf = (calls: number): ProbeResultRow => probeRow({
      id: 'D1',
      turns: [{ text: d1.messages[0]!.text!, reply, notices: ['计划通知'], calls, refusedCalls: 0, execution: [] }],
    });
    const scored = evaluateProbeCase('probe-D1', rowOf(-1), { dims: emptyDimCounts() }, undefined, d1, false);
    expect(scored.checks.some((check) => check.name === '期望·调用数(第1轮)')).toBe(false);
    expect(scored.pass).toBe(true);
    // D1 不在基线：基线可读时统一报告按 score.ts 的 skipped 跳过（undefined）；基线整份
    // 不可读的黑盒降级（baselineKnown=false）才走「探针 ok + 期望值层」最小口径——-1 在
    // 这条路径同样不出调用数判定。
    expect(unifiedCasePassedOf(rowOf(-1), d1, undefined, false, 'probe-D1')).toBeUndefined();
    expect(unifiedCasePassedOf(rowOf(-1), d1, undefined, false, 'probe-D1', false)).toBe(true);
    // 有证据的 0 仍照判（证明 -1 的"不判"没有把整条断言关掉）。
    expect(unifiedCasePassedOf(rowOf(0), d1, undefined, false, 'probe-D1', false)).toBe(false);
  });
});

/**
 * 入口守卫（2026-11-10 独立评审 high）：本模块顶层导出大量纯函数供单测 import，
 * `main()` 只能直接运行时执行。行为锁用子进程 import——若守卫被去掉，import 即装配探针
 * （先打"黑盒模式/audited 申报模式"并继续跑 main），这个测试会在输出/退出码上变红。
 * 直接在 vitest 进程里 import 测不出：守卫失效会先污染测试进程本身。
 */
describe('入口守卫：import 模块不执行 main()', () => {
  it('子进程 import 探针模块 ⇒ 退出码 0 且无探针装配输出', () => {
    const probeUrl = new URL('./probe-real-agent.ts', import.meta.url).href;
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(probeUrl)})`],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env } },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).not.toContain('=== ');
    expect(child.stdout).not.toContain('黑盒模式');
    expect(child.stdout).not.toContain('audited 申报模式');
    expect(child.stderr).not.toContain('探针失败');
  });
});

/**
 * runner 抛错（2026-11-10 独立评审 medium）：崩溃用例必须同时进探针报告与统一报告。
 * 旧写法 catch 只 push results ⇒ 统一报告的用例计数与通过率被静默缩小。
 */
describe('runner 抛错：崩溃用例进统一报告，不被静默漏掉', () => {
  it('崩溃产物同时含 result 与 report input；占位 N/A、有基线项判失败', () => {
    const q5b = loadCases().find((spec) => spec.id === 'Q5b')!;
    const crash = caseCrashOf(q5b, new Error('runner 崩了'), 'probe-x', true);
    expect(crash.result.ok).toBe(false);
    expect(crash.result.turns).toEqual([]);
    // 零轮崩溃没有可核轮次：显式不适用，不写缺列（score.ts 会整份 exit 2）也不写 0。
    expect(crash.result.auditFailures).toBe('not-applicable');
    expect(crash.input.caseId).toBe('Q5b');
    expect(crash.input.ok).toBe(false);
    expect(crash.input.notes).toEqual(['runner 崩了']);
    // 未跑的占位条目：N/A 跳过（不进通过率分母），但用例行仍在报告里。
    expect(unifiedCasePassedOf(crash.result, q5b, undefined, true)).toBeUndefined();

    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const landed = caseCrashOf(a1, new Error('runner 崩了'), 'probe-x', true);
    expect(unifiedCasePassedOf(landed.result, a1, { dims: emptyDimCounts() }, true)).toBe(false);
    // 黑盒崩溃不产申报列（没跑交叉核，0 不成立），同样按失败计入。
    const black = caseCrashOf(a1, 'boom', 'probe-x', false);
    expect(black.result.auditFailures).toBeUndefined();
    expect(unifiedCasePassedOf(black.result, a1, { dims: emptyDimCounts() }, false)).toBe(false);
  });

  it('中途中止：崩溃前审计窗口的调用保留在 result / 统一报告 JSONL，不再静默清零', () => {
    // 2026-11-10 独立评审 medium：caseCrashOf 被任何 runner 抛错消费时无条件写
    // platformCalls/refusedCalls=0、ladder=[]、turns=[]——跑了若干调用后崩溃的用例在
    // 探针汇总显示"平台调用 0"，统一报告也没有这些调用的 JSONL 行。main 的 catch 手里
    // 有 auditBefore 与 executionAuditRows()，按真实窗口重建。
    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const before: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'pre'], exitCode: 0 };
    const rows: ExecutionAuditRow[] = [
      { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 },
      { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], refused: 'serve_gate:token' },
    ];
    const crash = caseCrashOf(a1, new Error('boom after calls'), 'probe-x', true, {
      auditBefore: 1, auditRows: [before, ...rows], elapsedMs: 2500,
    });
    expect(crash.result.platformCalls).toBe(2);
    expect(crash.result.refusedCalls).toBe(1);
    expect(crash.result.ladder).toHaveLength(2);
    expect(crash.input.turns).toHaveLength(1);
    expect(crash.input.turns[0]!.reply).toBeNull();
    expect(crash.input.turns[0]!.execution).toHaveLength(2);
    expect(crash.input.notes.some((note) => note.includes('保留 2 次平台调用'))).toBe(true);
    // 统一报告 JSONL 面：崩溃前的两次调用各有自己的行（旧写法 0 行）。
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls).toHaveLength(2);
    expect(report.calls.every((line) => line.messageId.includes('crash-window'))).toBe(true);
    // 申报计数仍不适用（没有完整回复可交叉核），但执行证据不再被清零。
    expect(crash.result.auditFailures).toBe('not-applicable');
  });

  it('审计源不可读：platformCalls 记 -1（不可知），不冒充零调用', () => {
    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const crash = caseCrashOf(a1, 'boom', 'probe-x', true, { auditRows: null });
    expect(crash.result.platformCalls).toBe(-1);
    expect(crash.result.refusedCalls).toBe(-1);
    expect(crash.result.ladder).toEqual([]);
    expect(crash.input.turns).toEqual([]);
  });

  it('正常路径：审计源不可读 ⇒ 用例级调用数同样记 -1（不冒充有证据的零调用）', () => {
    // 2026-11-10 独立评审 low：正常（非崩溃）路径旧写法用空 caseRows 派生 0/0，
    // case-ledger 的 knownPlatformCalls(0) 会把"读不到"当成"有证据的零调用"计入合计。
    expect(caseCallCountsOf(null, [])).toEqual({ platformCalls: -1, refusedCalls: -1 });
    // 孪生：审计源可读时照常计数（被拒行也数）。
    expect(caseCallCountsOf([], [])).toEqual({ platformCalls: 0, refusedCalls: 0 });
    const rows: ExecutionAuditRow[] = [
      { mode: 'query', script: 'dummy.query', exitCode: 0 },
      { mode: 'query', script: 'dummy.query', refused: 'serve_gate:token' },
    ];
    expect(caseCallCountsOf([], rows)).toEqual({ platformCalls: 2, refusedCalls: 1 });
  });

  it('审计源不可读但有时延证据：崩溃窗口行带 -1/auditMissing，报告不写 executedCalls 0', () => {
    // 合成崩溃窗口行的 execution 只能是 []（证据不可读）。不显式带 -1/auditMissing 时，
    // buildCaseReport 会按空数组派生 0/0——与结果级 platformCalls:-1 自相矛盾。
    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const crash = caseCrashOf(a1, 'boom', 'probe-x', true, { auditRows: null, elapsedMs: 2500 });
    expect(crash.input.turns).toHaveLength(1);
    const line = buildCaseReport(crash.input).turns[0]!;
    expect(line).toMatchObject({ auditMissing: true, calls: -1, latencyMs: 2500 });
    expect('executedCalls' in line).toBe(false);
    expect('refusedCalls' in line).toBe(false);
  });

  it('中途中止：已完成轮次保住（申报计数不再一律 N/A），正在跑的轮次单列、JSONL 不重复', () => {
    // send 逐轮追加 turnsInFlight（见 probe-real-agent 的崩溃证据注释）：runner 在
    // 第 2 轮抛错时，第 1 轮的回复/审计窗口仍在 catch 手里。旧写法 turns:[] ⇒
    // auditFailures 只有 'not-applicable' 一种值；现在有可核轮次就照常算。
    const a1 = loadCases().find((spec) => spec.id === 'A1')!;
    const completedRow: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const completed: Turn = {
      text: 'q1', reply: 'alpha 查完了。', ms: 10, notices: [], messageId: 'm1',
      calls: 1, refusedCalls: 0, taskIds: [], execution: [completedRow],
      gateRows: [], intents: [], delegations: [], ladder: [], ladderRung: 'INCONCLUSIVE',
    };
    const tail: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], exitCode: 0 };
    const crash = caseCrashOf(a1, new Error('boom on turn 2'), 'probe-x', true, {
      auditRows: [completedRow, tail], turns: [completed], elapsedMs: 500,
    });
    expect(crash.result.turns).toEqual([completed]);
    expect(crash.result.auditFailures).toBe(0);
    expect(crash.input.turns).toHaveLength(2);
    expect(crash.input.turns[0]!.messageId).toBe('m1');
    expect(crash.input.turns[1]!.messageId).toContain('crash-window');
    expect(crash.input.turns[0]!.execution).toHaveLength(1);
    expect(crash.input.turns[1]!.execution).toHaveLength(1);
    // 两次调用各一行，不因"完整轮次 + 崩溃窗口"重复计数。
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls).toHaveLength(2);
  });
});

/**
 * calls=-1（审计源不可读）在探针 **note 面**也按无证据处理（2026-11-10 独立评审 low）：
 * 评分/期望值面已走 callsEvidenceOf 跳过，但 realAmounts / recallMissed 旧写法用
 * `calls <= 0` 把 -1 当零——跳过该轮金额、发"既没召回也没重查"假红。`=== 0` 系列
 * 只在有证据的零调用上成立；-1 的证据缺口由 main 的用例级信息性 note 呈现。
 */
describe('calls=-1 在探针 note 面按无证据处理', () => {
  const probeTurn = (overrides: Partial<Turn> = {}): Turn => ({
    text: 'q', reply: 'r', ms: 1, notices: [], messageId: 'm1',
    calls: 1, refusedCalls: 0, taskIds: [], execution: [],
    gateRows: [], intents: [], delegations: [], ladder: [], ladderRung: 'INCONCLUSIVE',
    ...overrides,
  });
  const script: ScriptLine[] = [{ text: 'q', tasks: [] }, { text: 'q', tasks: [] }];

  it('realAmounts 不把 -1 当零排除（否则召回轮允许集会缺该轮金额）', () => {
    const turns = [
      probeTurn({ calls: -1, reply: 'value 500' }),
      probeTurn({ calls: 0, reply: 'value 300' }),
    ];
    expect([...realAmounts(turns, script, 2, [])]).toEqual([500]);
  });

  it('recallMissed 只在有证据的 0 且未复述结论时成立', () => {
    expect(recallMissed(probeTurn({ calls: -1, reply: 'let me check that later' }), new Set())).toBe(false);
    expect(recallMissed(probeTurn({ calls: 0, reply: 'let me check that later' }), new Set())).toBe(true);
    expect(recallMissed(probeTurn({ calls: 0, reply: 'no records' }), new Set())).toBe(false);
    // 线程有金额时先看回复有没有数，calls 不参与。
    expect(recallMissed(probeTurn({ calls: -1, reply: 'nothing' }), new Set([500]))).toBe(true);
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

/**
 * ambient 击穿回归锁（issue #20 切片 A 建立，2026-11-10 续篇改状态根传导）。
 *
 * 2026-11-10 消费端边界裁定后：夹具对四个状态路径（MOCK / PLAN / PROPOSAL / AUDIT）的
 * env2 读取（含调试回退）全部退役——状态根只认测试专用 `--state-dir` flag。探针没有
 * argv 通道（宿主 spawn 固定 argv），故经 `FSHINE_EVAL_FIXTURE_STATE_DIR` 测试桥把
 * per-case 根交给夹具 shell 入口，入口翻成 flag。本组断言预置：
 *   · 四个状态的 ambient 专名与规范名（证明夹具忽略它们，不会被 ambient 改道）；
 *   · 辅助组（memory / breaker / cache）的 ambient 名（规范族 + STOCK_* 专名）：证明探针
 *     清场它们——stock auxPaths 的 env2 优先读 ambient（2026-11-10 Codex major 修复）；
 *   · ambient 桥键（证明探针的 per-case 覆盖赢——桥值必须指向 case 目录）；
 *   · 三个令牌面专名（证明探针仍然清场它们）。
 * 然后：
 *   ① 隔离后桥键 == case 目录；四个状态规范名保持 ambient 原值（探针不再注入/清场它们）；
 *      辅助组 ambient 名全部不可见（清场）；
 *   ② 用隔离后的 process.env 真跑一次夹具：状态/审计文件只落在 case 目录，ambient 根为空
 *      （抽掉桥覆盖 → 夹具会落到 ambient 根，本断言必红）；
 *   ③ probeAuditPath() == caseDir/audit.jsonl（探针传给 safety-gate 的路径与夹具派生
 *      同根同规则）；restorePlatformState 把 ambient 原值原样恢复（备份/恢复对称）；
 *   ④ 再隔离一次拿到另一份 case 目录（per-case 隔离不是共用文件）。
 */
describe('isolatePlatformState：状态根只走测试桥 + 专名清场', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixtureRoot = path.join(repoRoot, 'scripts', 'eval', 'fixtures', 'dummy-platform');
  const genericBin = path.join(fixtureRoot, 'bin', 'generic');
  const RATE_LIMIT_KEY = 'EXECUTION_RATE_LIMIT_STATE';
  const STATE_KEYS = [
    'EXECUTION_MOCK_STATE', 'EXECUTION_PLAN_STATE', 'EXECUTION_PROPOSAL_STATE', 'EXECUTION_AUDIT_PATH',
  ] as const;
  const TOKEN_KEYS = [
    'DUMMY_GATE_SECRET', 'DUMMY_COMMIT_TOKEN', 'DUMMY_PLAN_ACTIVATION_SECRET',
  ] as const;
  // 辅助组（memory / breaker / cache）ambient 名：规范族 + STOCK_* 调试专名。stock.cjs 的
  // auxPaths() 用 env2 优先读它们，探针必须在评测进程内清场（2026-11-10 Codex major 修复）。
  const AUX_KEYS = [
    'EXECUTION_MEMORY_STATE', 'EXECUTION_BREAKER_STATE', 'EXECUTION_CACHE_STATE',
    'STOCK_MEMORY_STATE', 'STOCK_BREAKER_STATE', 'STOCK_CACHE_STATE',
  ] as const;
  const STATE_DEBUG_KEYS = [
    'DUMMY_STATE', 'DUMMY_PLAN_STATE', 'DUMMY_PROPOSAL_STATE', 'DUMMY_AUDIT_PATH',
  ] as const;

  const savedOf = (keys: readonly string[]): Record<string, string | undefined> =>
    Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  const restoreSaved = (saved: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  it('预置 ambient 状态名/桥键后，夹具仍只用 case 目录；restore 原样恢复', () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'probe-isolate-'));
    const ambientRoot = mkdtempSync(path.join(os.tmpdir(), 'probe-ambient-'));
    const ambient: Record<string, string> = {
      // 四个状态路径的 ambient 名（夹具已不读；保留预置证明它们不再能改道）
      DUMMY_STATE: path.join(ambientRoot, 'dummy-state.json'),
      DUMMY_PLAN_STATE: path.join(ambientRoot, 'dummy-plans.json'),
      DUMMY_PROPOSAL_STATE: path.join(ambientRoot, 'dummy-proposals.json'),
      DUMMY_AUDIT_PATH: path.join(ambientRoot, 'dummy-audit.jsonl'),
      EXECUTION_MOCK_STATE: path.join(ambientRoot, 'mock.json'),
      EXECUTION_PLAN_STATE: path.join(ambientRoot, 'plans.json'),
      EXECUTION_PROPOSAL_STATE: path.join(ambientRoot, 'proposals.json'),
      EXECUTION_AUDIT_PATH: path.join(ambientRoot, 'audit.jsonl'),
      // ambient 桥键：探针必须覆盖它，否则夹具会写到 ambient 根
      FSHINE_EVAL_FIXTURE_STATE_DIR: ambientRoot,
      // 令牌面专名：探针必须清场
      DUMMY_GATE_SECRET: path.join(ambientRoot, 'gate-secret'),
      DUMMY_COMMIT_TOKEN: path.join(ambientRoot, 'commit-token'),
      DUMMY_PLAN_ACTIVATION_SECRET: path.join(ambientRoot, 'plan-secret'),
      // 辅助组 ambient 名：探针必须与令牌专名同待遇清场（stock auxPaths 的 env2 优先读）
      EXECUTION_MEMORY_STATE: path.join(ambientRoot, 'memory.json'),
      EXECUTION_BREAKER_STATE: path.join(ambientRoot, 'breaker.json'),
      EXECUTION_CACHE_STATE: path.join(ambientRoot, 'cache.json'),
      STOCK_MEMORY_STATE: path.join(ambientRoot, 'stock-memory.json'),
      STOCK_BREAKER_STATE: path.join(ambientRoot, 'stock-breaker.json'),
      STOCK_CACHE_STATE: path.join(ambientRoot, 'stock-cache.json'),
    };
    const savedAmbient = savedOf(Object.keys(ambient));
    const savedRate = savedOf([RATE_LIMIT_KEY]);
    const savedGate = savedOf(['EXECUTION_GATE_SECRET', 'EXECUTION_COMMIT_TOKEN']);
    try {
      Object.assign(process.env, ambient);
      // 直提 commit 走「有 secret 才验」的遗留契约；本断言不考令牌门，剥掉 ambient secret。
      delete process.env['EXECUTION_GATE_SECRET'];
      delete process.env['EXECUTION_COMMIT_TOKEN'];
      const firstCaseDir = isolatePlatformState(stateDir);
      expect(firstCaseDir.startsWith(stateDir)).toBe(true);
      expect(probeCaseStateDir()).toBe(firstCaseDir);
      // 桥覆盖赢：探针的 per-case 根压过 ambient 值。
      expect(process.env['FSHINE_EVAL_FIXTURE_STATE_DIR']).toBe(firstCaseDir);
      // 探针不再注入/清场四个状态路径：ambient 原值保持不动（夹具忽略它们）。
      for (const key of STATE_KEYS) expect(process.env[key]).toBe(ambient[key]);
      for (const key of STATE_DEBUG_KEYS) expect(process.env[key]).toBe(ambient[key]);
      // 令牌面专名被清场（规范名由 harness 注入，专名不得可见）。
      for (const key of TOKEN_KEYS) expect(process.env[key], `${key} 仍在 ambient：夹具会从第二顺位专名取令牌面`).toBeUndefined();
      // 辅助组 ambient 名同样被清场：否则 stock auxPaths 的 env2 会盖过 per-case 状态根
      // （打开态熔断 → BREAKER_OPEN；memory/cache 跨用例共享或写外部文件）。
      for (const key of AUX_KEYS) expect(process.env[key], `${key} 仍在 ambient：夹具 auxPaths 会优先读它`).toBeUndefined();

      // 真跑一次夹具（commit 会落主状态；query 只读不写）：状态/审计只落 case 目录
      // （--state-dir 由桥传导）。
      const run = spawnSync(genericBin, ['commit', 'dummy.commit', '--collection', 'alpha', '--count', '1'], {
        encoding: 'utf8', cwd: fixtureRoot, env: process.env,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('"status":"completed"');
      expect(existsSync(path.join(firstCaseDir, 'dummy-state.json')), '夹具主状态必须落在 case 目录').toBe(true);
      expect(existsSync(path.join(firstCaseDir, 'audit.jsonl')), '夹具审计必须从同一状态根派生').toBe(true);
      // 探针传给 safety-gate 的审计路径 == 夹具实际写入的路径（同根同规则）。
      expect(probeAuditPath()).toBe(path.join(firstCaseDir, 'audit.jsonl'));
      // ambient 根没有被写：抽掉桥覆盖 / 恢复 env 读取，这条必红。
      expect(readdirSync(ambientRoot), 'ambient 状态根被写入 = 隔离被击穿').toEqual([]);

      // restore 对称：ambient 原值回来（桥键 + 状态名 + 令牌专名）。
      restorePlatformState();
      for (const [key, value] of Object.entries(ambient)) expect(process.env[key]).toBe(value);

      // 再隔一次 = 另一份 case 目录（不是所有用例共用一个）。
      const secondCaseDir = isolatePlatformState(stateDir);
      expect(secondCaseDir).not.toBe(firstCaseDir);
      expect(probeCaseStateDir()).toBe(secondCaseDir);
    } finally {
      restorePlatformState();
      restoreSaved(savedAmbient);
      restoreSaved(savedRate);
      restoreSaved(savedGate);
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(ambientRoot, { recursive: true, force: true });
    }
  });

  it('缺限流键以外的规范名不注入：四个状态规范名在隔离后仍是 ambient 值（生产零注入语义）', () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'probe-isolate-'));
    const savedRate = savedOf([RATE_LIMIT_KEY]);
    // 运行者环境可能自带 EXECUTION_* 状态路径（文档允许的 mock 联调方式）；本用例的判据是
    // “探针不注入也不改写它们”，不是“它们必然缺席”——与隔离前逐键比较（2026-11-10 评审修）。
    const ambientState = savedOf(STATE_KEYS);
    try {
      delete process.env[RATE_LIMIT_KEY];
      isolatePlatformState(stateDir);
      expect(process.env[RATE_LIMIT_KEY]!.startsWith(stateDir), '限流状态仍按例隔离').toBe(true);
      for (const key of STATE_KEYS) expect(process.env[key], `${key} 不应被探针注入或改写`).toBe(ambientState[key]);
    } finally {
      restorePlatformState();
      restoreSaved(savedRate);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('子进程回传：哨兵 JSON 与非零退出证据', () => {
  const payload = {
    result: { id: 'A1', turns: [], ok: true },
    input: { caseId: 'A1' },
  };

  it('哨兵之后的 JSON 可解析；哨兵之前的噪声不影响', () => {
    const raw = `噪声行\n${CASE_RESULT_SENTINEL}\n${JSON.stringify(payload)}\n`;
    const parsed = parseChildCasePayload(raw);
    expect(parsed?.result.id).toBe('A1');
    expect(parsed?.input.caseId).toBe('A1');
  });

  it('没有哨兵、JSON 坏、或 caseId 对不上 → null', () => {
    expect(parseChildCasePayload('黑盒模式')).toBeNull();
    expect(parseChildCasePayload(`${CASE_RESULT_SENTINEL}\n{`)).toBeNull();
    expect(parseChildCasePayload(`${CASE_RESULT_SENTINEL}\n${JSON.stringify({
      result: { id: 'A1', turns: [] },
      input: { caseId: 'B1' },
    })}`)).toBeNull();
  });

  it('非零退出的证据是退出码/信号 + stderr 尾部，不编轮次', () => {
    expect(childFailureNote(2, null, '忽略\n评测安全门拒绝跑危险用例')).toBe(
      '子进程失败（exit 2）：忽略 | 评测安全门拒绝跑危险用例',
    );
    expect(childFailureNote(null, 'SIGKILL', '')).toBe('子进程失败（signal SIGKILL）');
  });
});

/**
 * 父进程 fail 分支（2026-11-11 Codex blocking）：子进程可能已经执行过平台调用，然后被
 * 信号杀掉，或回传 JSON 解析失败。父进程读不到子进程审计文件，省略 evidence 会让
 * caseCrashOf 把 platformCalls/refusedCalls 写成 0。这两条走的就是 runCaseChildProcess
 * 的 fail()——把证据参数抽掉，断言必须红。
 */
describe('子进程失败：证据缺席记 -1，有效回传保留执行证据', () => {
  const item = {
    id: 'A1',
    group: 'g',
    intent: 'i',
    run: async () => ({ turns: [] as Turn[] }),
  };
  const executedTurn = (messageId: string, execution: ExecutionAuditRow[]): Turn => ({
    text: 'q', reply: 'alpha 查完了。', ms: 10, notices: [], messageId,
    calls: execution.filter((row) => !row.refused).length,
    refusedCalls: execution.filter((row) => row.refused).length,
    taskIds: [], execution,
    gateRows: [], intents: [], delegations: [], ladder: [], ladderRung: 'INCONCLUSIVE',
  });
  /** 不真的 fork：把脚本化的 fd 3 / 退出码喂给父进程的同一条 fail 路径。 */
  function scriptedFork(script: {
    code: number | null;
    signal: NodeJS.Signals | null;
    payload: string;
    stderr?: string;
  }): typeof fork {
    return (() => {
      const child = new EventEmitter();
      const stderr = new PassThrough();
      const result = new PassThrough();
      setImmediate(() => {
        if (script.stderr) stderr.write(script.stderr);
        stderr.end();
        if (script.payload) result.write(script.payload);
        result.end();
        child.emit('exit', script.code, script.signal);
      });
      return Object.assign(child, {
        stderr,
        stdio: [null, null, stderr, result, null],
        kill() { return true; },
      });
    }) as unknown as typeof fork;
  }

  it('执行平台调用后非零退出：没有回传记 -1；fd 3 有有效 payload 则保留调用，都不记 0', async () => {
    const killed = await runCaseChildProcess(item, 'probe-x', false, 0, process.env, scriptedFork({
      code: null, signal: 'SIGKILL', payload: '',
    }));
    expect(killed.processFailed).toBe(true);
    expect(killed.result.crashed).toBe(true);
    expect(killed.result.platformCalls).toBe(-1);
    expect(killed.result.refusedCalls).toBe(-1);
    expect(killed.result.platformCalls).not.toBe(0);
    expect(killed.result.refusedCalls).not.toBe(0);

    const done: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const refused: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], refused: 'serve_gate:token' };
    const tail: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'gamma'], exitCode: 0 };
    const turn = executedTurn('m1', [done, refused]);
    const raw = `${CASE_RESULT_SENTINEL}\n${JSON.stringify({
      result: {
        id: 'A1', turns: [turn], ok: true,
        // 申报数是子进程对自己观测总数的权威（2026-11-11 仲裁）：故意少于崩溃窗口里的行。
        // 结果用 2/0，不按行重算成 3/1；行本身仍进阶梯与 JSONL，不许丢，也不许记成没证据的 0。
        platformCalls: 2, refusedCalls: 0,
      },
      input: {
        caseId: 'A1', ok: true, notes: [],
        intents: [], gateRows: [], delegations: [],
        turns: [
          { messageId: 'm1', text: 'q', reply: 'alpha 查完了。', notices: [], execution: [done, refused] },
          {
            messageId: 'probe-x:A1:crash-window', text: '(runner 崩溃：该轮未形成完整轮次)', reply: null,
            notices: [], execution: [tail],
          },
        ],
      },
    })}\n`;
    const exited = await runCaseChildProcess(item, 'probe-x', false, 0, process.env, scriptedFork({
      code: 1, signal: null, payload: raw,
    }));
    expect(exited.processFailed).toBe(true);
    expect(exited.result.crashed).toBe(true);
    expect(exited.result.platformCalls).toBe(2);
    expect(exited.result.refusedCalls).toBe(0);
    expect(exited.result.platformCalls).not.toBe(0);
    expect(exited.result.ladder).toHaveLength(3);
    expect(exited.result.notes.some((note) => note.includes('保留 3 次平台调用'))).toBe(true);
    expect(exited.result.turns).toEqual([turn]);
    expect(exited.input.turns.some((line) => line.execution.some((row) => Array.isArray(row.args) && row.args[1] === 'gamma'))).toBe(true);
    const kept = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [exited.input] });
    expect(kept.calls).toHaveLength(3);
  });

  it('执行后回传 JSON 解析失败：总数记 -1；已闭合的 turns 留下，不记 0', async () => {
    const row: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const turn = executedTurn('m1', [row]);
    // 哨兵后的 JSON 在 turns 数组闭合之后被截断，整体解析失败。
    const truncated = `${CASE_RESULT_SENTINEL}\n{"result":{"id":"A1","group":"g","intent":"i","turns":${JSON.stringify([turn])},"platformCalls":1`;
    const parsed = await runCaseChildProcess(item, 'probe-x', false, 0, process.env, scriptedFork({
      code: 0, signal: null, payload: truncated,
    }));
    expect(parsed.processFailed).toBe(true);
    expect(parsed.result.notes[0]).toContain('回传 JSON 不可解析');
    expect(parsed.result.platformCalls).toBe(-1);
    expect(parsed.result.refusedCalls).toBe(-1);
    expect(parsed.result.platformCalls).not.toBe(0);
    expect(parsed.result.refusedCalls).not.toBe(0);
    expect(parsed.result.turns).toEqual([turn]);
    expect(parsed.input.turns[0]?.execution).toEqual([row]);

    const garbage = await runCaseChildProcess(item, 'probe-x', false, 0, process.env, scriptedFork({
      code: 0, signal: null, payload: `${CASE_RESULT_SENTINEL}\n{`,
    }));
    expect(garbage.result.platformCalls).toBe(-1);
    expect(garbage.result.refusedCalls).toBe(-1);
    expect(garbage.result.turns).toEqual([]);
    expect(garbage.result.platformCalls).not.toBe(0);
  });

  function childPayload(result: Record<string, unknown>, inputTurns: unknown[]): string {
    return `${CASE_RESULT_SENTINEL}\n${JSON.stringify({
      result: { id: 'A1', ok: false, ...result },
      input: { caseId: 'A1', ok: false, notes: [], intents: [], gateRows: [], delegations: [], turns: inputTurns },
    })}\n`;
  }

  it('子进程声明 -1 且有行：总数保持不可知，观测行仍进阶梯与 JSONL', () => {
    // 2026-11-11 仲裁：有行时旧写法丢掉 payload 里的 -1，按行数收成「正好 N」。
    // 已看到的调用是真证据，但「至少 N」不是「一共 N」。
    const alpha: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const beta: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], refused: 'serve_gate:token' };
    const turn = executedTurn('m1', [alpha]);
    const raw = childPayload(
      { turns: [turn], platformCalls: -1, refusedCalls: -1 },
      [
        { messageId: 'm1', text: 'q', reply: 'alpha 查完了。', notices: [], execution: [alpha] },
        {
          messageId: 'probe-x:A1:crash-window', text: '(runner 崩溃：该轮未形成完整轮次)', reply: null,
          notices: [], execution: [beta],
        },
      ],
    );
    const evidence = crashEvidenceFromChildPayload(raw, 'A1');
    expect(evidence.declaredCalls).toBe(-1);
    expect(evidence.declaredRefused).toBe(-1);
    expect(evidence.auditRows).toEqual([alpha, beta]);
    const crash = caseCrashOf(item, new Error('killed'), 'probe-x', false, evidence);
    expect(crash.result.platformCalls).toBe(-1);
    expect(crash.result.refusedCalls).toBe(-1);
    expect(crash.result.ladder).toHaveLength(2);
    expect(crash.result.notes.some((note) => note.includes('保留 2 次平台调用'))).toBe(true);
    expect(crash.input.turns.some((line) => line.execution.some((row) => Array.isArray(row.args) && row.args[1] === 'alpha'))).toBe(true);
    expect(crash.input.turns.some((line) => line.execution.some((row) => Array.isArray(row.args) && row.args[1] === 'beta'))).toBe(true);
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls).toHaveLength(2);
    expect(report.calls.every((line) => line.script === 'dummy.query')).toBe(true);
  });

  it('子进程声明确定数且有行：用声明数，不按行数重算', () => {
    const alpha: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const beta: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'beta'], refused: 'serve_gate:token' };
    const turn = executedTurn('m1', [alpha, beta]);
    const raw = childPayload(
      { turns: [turn], platformCalls: 5, refusedCalls: 0 },
      [{ messageId: 'm1', text: 'q', reply: 'alpha 查完了。', notices: [], execution: [alpha, beta] }],
    );
    const evidence = crashEvidenceFromChildPayload(raw, 'A1');
    expect(evidence.declaredCalls).toBe(5);
    expect(evidence.declaredRefused).toBe(0);
    const crash = caseCrashOf(item, new Error('killed'), 'probe-x', false, evidence);
    // 按行重算会得到 2/1。声明才是总数。
    expect(crash.result.platformCalls).toBe(5);
    expect(crash.result.refusedCalls).toBe(0);
    expect(crash.result.ladder).toHaveLength(2);
    expect(crash.result.notes.some((note) => note.includes('保留 2 次平台调用'))).toBe(true);
    const report = buildUnifiedReport({ at: 'now', evalRunId: 'probe-x', cases: [crash.input] });
    expect(report.calls).toHaveLength(2);
  });

  it('无行不可知仍是 -1，knownZero 仍是 0；声明缺席时有行仍按行计数', () => {
    const unknown = crashEvidenceFromChildPayload(
      childPayload({ turns: [], platformCalls: -1, refusedCalls: -1 }, []),
      'A1',
    );
    expect(unknown.auditRows).toBeNull();
    expect(unknown.declaredCalls).toBe(-1);
    const unknownCrash = caseCrashOf(item, 'boom', 'probe-x', false, unknown);
    expect(unknownCrash.result.platformCalls).toBe(-1);
    expect(unknownCrash.result.refusedCalls).toBe(-1);

    const absent = crashEvidenceFromChildPayload(childPayload({ turns: [] }, []), 'A1');
    expect(absent.auditRows).toBeNull();
    expect(absent.declaredCalls).toBeUndefined();
    expect(absent.declaredRefused).toBeUndefined();
    const absentCrash = caseCrashOf(item, 'boom', 'probe-x', false, absent);
    expect(absentCrash.result.platformCalls).toBe(-1);
    expect(absentCrash.result.refusedCalls).toBe(-1);

    const zero = crashEvidenceFromChildPayload(
      childPayload({ turns: [], platformCalls: 0, refusedCalls: 0 }, []),
      'A1',
    );
    expect(zero.auditRows).toEqual([]);
    expect(zero.declaredCalls).toBe(0);
    const zeroCrash = caseCrashOf(item, 'boom', 'probe-x', false, zero);
    expect(zeroCrash.result.platformCalls).toBe(0);
    expect(zeroCrash.result.refusedCalls).toBe(0);

    const unreadable = executedTurn('m1', []);
    unreadable.calls = -1;
    unreadable.refusedCalls = -1;
    unreadable.auditMissing = true;
    const masked = crashEvidenceFromChildPayload(
      childPayload({ turns: [unreadable], platformCalls: 0, refusedCalls: 0 }, []),
      'A1',
    );
    expect(masked.auditRows).toBeNull();
    const maskedCrash = caseCrashOf(item, 'boom', 'probe-x', false, masked);
    expect(maskedCrash.result.platformCalls).toBe(-1);
    expect(maskedCrash.result.refusedCalls).toBe(-1);

    const row: ExecutionAuditRow = { mode: 'query', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 };
    const counted = executedTurn('m1', [row]);
    const legacy = crashEvidenceFromChildPayload(
      childPayload(
        { turns: [counted] },
        [{ messageId: 'm1', text: 'q', reply: 'alpha 查完了。', notices: [], execution: [row] }],
      ),
      'A1',
    );
    expect(legacy.declaredCalls).toBeUndefined();
    expect(legacy.auditRows).toEqual([row]);
    const legacyCrash = caseCrashOf(item, 'boom', 'probe-x', false, legacy);
    expect(legacyCrash.result.platformCalls).toBe(1);
    expect(legacyCrash.result.refusedCalls).toBe(0);
  });
});

/**
 * 债 D-209：FSHINE_EVAL_FIXTURE_STATE_DIR 只许出现在已知站点。
 * 扫描面 = packages / apps / scripts 下的可执行文本（ts/js/cjs/mjs/py/sh，以及 bin 下无扩展名脚本）。
 * 文档与 yaml 注释不在扫描面——它们解释桥，不是运行时引用。
 *
 * 允许名单比裁定括号多两处，都是重构前就存在的引用，本片不改它们的行为：
 *   · scripts/probe-real-agent.test.ts —— 探针自己的表征测试（含本守卫）
 *   · scripts/acceptance.ts —— leak-lint 登记理由已写明它是设置方
 * 生产代码（packages / apps 的非测试源）零命中；往名单外加一处引用即红。
 */
describe('D-209：状态根桥只被已知站点引用，前缀与形状不变', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const BRIDGE = 'FSHINE_EVAL_FIXTURE_STATE_DIR';
  const ALLOWLIST = [
    'packages/agent/platform-leak-lint.test.ts',
    'scripts/acceptance.ts',
    'scripts/eval/fixtures/dummy-platform/bin/dummy',
    'scripts/eval/fixtures/stock-platform/bin/stock',
    'scripts/probe-real-agent.test.ts',
    'scripts/probe-real-agent.ts',
  ];
  const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.sh']);

  function bridgeCodeHits(extra: { rel: string; text: string }[] = []): string[] {
    const hits = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.runtime' || entry.name === 'coverage') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(abs); continue; }
        const ext = path.extname(entry.name);
        const rel = path.relative(repoRoot, abs);
        const fixtureBin = rel.includes(`${path.sep}bin${path.sep}`) && ext === '';
        if (!CODE_EXT.has(ext) && !fixtureBin) continue;
        if (readFileSync(abs, 'utf8').includes(BRIDGE)) hits.add(rel.split(path.sep).join('/'));
      }
    };
    for (const top of ['packages', 'apps', 'scripts']) {
      const abs = path.join(repoRoot, top);
      if (existsSync(abs)) walk(abs);
    }
    for (const item of extra) {
      if (item.text.includes(BRIDGE)) hits.add(item.rel);
    }
    return [...hits].sort();
  }

  it('可执行引用闭集 = 探针 + 表征测试 + acceptance + 两个 shell 入口 + leak-lint 登记', () => {
    expect(bridgeCodeHits()).toEqual(ALLOWLIST);
  });

  it('前缀是 FSHINE_EVAL_，shell 入口仍把桥翻成 --state-dir', () => {
    const probe = readFileSync(path.join(repoRoot, 'scripts/probe-real-agent.ts'), 'utf8');
    expect(probe).toContain("const FIXTURE_STATE_DIR_KEY = 'FSHINE_EVAL_FIXTURE_STATE_DIR'");
    expect(BRIDGE.startsWith('FSHINE_EVAL_')).toBe(true);
    expect(BRIDGE).toBe('FSHINE_EVAL_FIXTURE_STATE_DIR');
    for (const [rel, impl] of [
      ['scripts/eval/fixtures/dummy-platform/bin/dummy', 'dummy.cjs'],
      ['scripts/eval/fixtures/stock-platform/bin/stock', 'stock.cjs'],
    ] as const) {
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(src).toContain('if [ -n "${FSHINE_EVAL_FIXTURE_STATE_DIR:-}" ]; then');
      expect(src).toContain(`exec node "$(dirname "$0")/${impl}" --state-dir "$FSHINE_EVAL_FIXTURE_STATE_DIR" "$@"`);
    }
  });

  it('失效化：生产代码多一处引用即红（名单外的 runtime.ts）', () => {
    const hits = bridgeCodeHits([{
      rel: 'packages/agent/src/runtime.ts',
      text: 'const leak = process.env.FSHINE_EVAL_FIXTURE_STATE_DIR;',
    }]);
    const outside = hits.filter((rel) => !ALLOWLIST.includes(rel));
    expect(outside).toEqual(['packages/agent/src/runtime.ts']);
  });

  it('隐藏 --case 未知 id 不掉进父进程跑批', () => {
    const child = spawnSync(process.execPath, [
      '--import', 'tsx',
      path.join(repoRoot, 'scripts/probe-real-agent.ts'),
      '--case', '__missing__',
      '--eval-run-id', 'probe-test',
    ], { encoding: 'utf8', cwd: repoRoot, timeout: 20000 });
    expect(child.status, child.stderr).not.toBe(0);
    expect(child.stdout).not.toContain('黑盒模式');
    expect(child.stderr).toContain('没有用例');
  }, 30000);

  it('父进程同一套 stdio fork 能拉起子进程（缺 ipc 槽会在父进程抛，用例根本不起）', () => {
    const child = fork(path.join(repoRoot, 'scripts/probe-real-agent.ts'), [
      '--case', '__missing__', '--eval-run-id', 'probe-test',
    ], {
      execArgv: ['--import', 'tsx'],
      stdio: [...CASE_CHILD_STDIO],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('fork 超时'));
      }, 20000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        try {
          expect(code, stderr).not.toBe(0);
          expect(stderr).toContain('没有用例');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }, 30000);
});
