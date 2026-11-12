/**
 * 申报契约判据的表征锁（declaration-criteria.ts）。
 *
 * 两层：
 *   · **真实事故原文**（r01 / r04 / arch-d C2 / arch-a 健康样例）：日志行逐字转抄自
 *     `out/**` 的归档 probe.log（run 名与行内容写在每个夹具的注释里）。转抄不改字符——
 *     夹具的形状就是事故的形状。**重复行用 repeatLine 生成**（原文里本来就是同一条完全
 *     相同的行重复 n 次，log 里唯一的差别只是次数），次数取原文的真实计数。
 *   · **语料锁**：cases.yaml 的 P1 条目与判据常量/runner 登记表三方对齐（id、消息条数、
 *     bait 轮在、probe-real-agent.ts 有对应判定体）——任一处漂移这里先红。
 *
 * 判据的"有牙"证明就在本文件：同一条判据在真实事故日志上必须红、在健康样例上必须绿；
 * 阈值边界（2 容差 / 3 判红）单独锁一条，改阈值必须是有意识的行为。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_CASE_ID,
  INVALID_DECLARATION_TOLERANCE,
  judgeDeclarationContract,
  parseDeclarationEvents,
  replyFaceViolation,
  sliceCaseSection,
} from './declaration-criteria';
import { loadCases } from './cases';
import { FALLBACK_FAILURE, FALLBACK_TIMEOUT, NO_EXECUTION_CLARIFICATION } from '../../packages/agent/src/runtime-messages';

const evalDir = path.dirname(fileURLToPath(import.meta.url));

/** 原文里同一条 JSON 行重复 n 次（log 里这些行逐字相同）。 */
function repeatLine(line: string, times: number): string[] {
  return Array.from({ length: times }, () => line);
}

// ── 真实事故原文：T9 r01（单回合同一形状被拒 33 次后模型弃权） ────────────────
// 转抄自 t9-rerun/r01-flash/probe.log：段头 1 行 + 33 条同文 route_declaration_invalid +
// route_declaration_missing + turn_span(req_14ed…, outcome=route_declaration_missing)。
const R01_HEADER = '=== T9 两个不同对象/期间的查询之后问「刚才查的是哪个」——必须答对最近一次，不许串 ===';
const R01_INVALID =
  '{"event":"route_declaration_invalid","requestId":"req_14ed2645-2b70-450d-a801-59ca234f2cc3","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}';
const R01_MISSING = '{"event":"route_declaration_missing","requestId":"req_14ed2645-2b70-450d-a801-59ca234f2cc3"}';
const R01_SPAN =
  '{"event":"turn_span","requestId":"req_14ed2645-2b70-450d-a801-59ca234f2cc3","durationMs":53120,"outcome":"route_declaration_missing","tokensIn":9552,"tokensOut":5803,"cacheRead":271296,"cacheWrite":0,"tokens":286651,"reasoning":0}';
const R01_LOG = [
  R01_HEADER,
  '{"event":"platform_operations_lint_passed","detail":"dummy operations ok: 12 operations"}',
  ...repeatLine(R01_INVALID, 33),
  R01_MISSING,
  R01_SPAN,
  '',
].join('\n');
/** r01 那条弃权回复的原文（NO_EXECUTION_CLARIFICATION）。 */
const R01_REPLY = NO_EXECUTION_CLARIFICATION;

describe('真实事故原文：单回合申报死循环（T9 r01）', () => {
  const verdict = judgeDeclarationContract({
    logText: R01_LOG,
    turns: [{ reply: R01_REPLY, requestId: 'req_14ed2645-2b70-450d-a801-59ca234f2cc3' }],
    expectedTurns: 1,
    caseId: 'T9',
  });

  it('红在"重试无界"（33 次 > 容差 2），且原始计数如实报出', () => {
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('retry-unbounded');
    expect(verdict.evidence.maxInvalidPerTurn).toBe(33);
    expect(verdict.evidence.parsedInvalidCount).toBe(33);
    expect(verdict.evidence.rawInvalidOccurrences).toBe(33);
    expect(verdict.violations.join('\n')).toContain('被拒 33 次');
    expect(verdict.violations.join('\n')).toContain('keys=[kind,request] kind=conversation');
  });

  it('回合是闭合的（turn_span 在）：红的原因只有计数，不冒充"没出口"', () => {
    expect(verdict.evidence.turns[0]!.closed).toBe(true);
    expect(verdict.evidence.replyWaitTimeout).toBe(false);
    expect(verdict.outcome).not.toBe('turn-not-closed');
  });

  it('判据②在这份日志上通过：NO_EXECUTION_CLARIFICATION 是可行动的 fail-closed 话术', () => {
    expect(verdict.evidence.replyFaceViolations).toEqual([]);
    expect(verdict.outcome).not.toBe('hollow-reply');
  });
});

// ── 真实事故原文：arch-d C2（单回合 226 次 / 整例 242 次 + 300s 看门狗 + 0 轮） ──
// 转抄自 probe-step37/arch-d-weak/probe.log：段头 + 同一 requestId 的 226 条同文被拒行
// （原文整例 242 条：另外 16 条落在别的 requestId 上）+ 看门狗行「✗ 等待回复超时(300s)：你好，你能做什么？」。
const ARCHD_HEADER = '=== C2 30 轮混合对话：4 collection轮转的线程隔离、话题切换、澄清-选择、跨轮召回给数带框定、跨轮总结不塌缩 ===';
const ARCHD_INVALID =
  '{"event":"route_declaration_invalid","requestId":"req_d904b5e1-59dc-4f63-a4dd-814ed9d278c8","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}';
const ARCHD_WATCHDOG = '  ✗ 等待回复超时(300s)：你好，你能做什么？';
const ARCHD_LOG = [ARCHD_HEADER, ...repeatLine(ARCHD_INVALID, 226), ARCHD_WATCHDOG, ''].join('\n');

describe('真实事故原文：看门狗收掉的死循环（arch-d C2）', () => {
  const verdict = judgeDeclarationContract({
    logText: ARCHD_LOG,
    turns: [],
    expectedTurns: 30,
    caseId: 'C2',
  });

  it('红：226 次同形状拒收 + 300s 看门狗 + 0 轮跑完', () => {
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('retry-unbounded');
    expect(verdict.evidence.maxInvalidPerTurn).toBe(226);
    const text = verdict.violations.join('\n');
    expect(text).toContain('被拒 226 次');
    expect(text).toContain('等待回复超时');
    expect(text).toContain('用例没跑完');
  });

  it('探针日志里没有 turn_span：回合未闭合也算出来（不靠看门狗行单独兜底）', () => {
    expect(verdict.evidence.turns.every((turn) => !turn.closed)).toBe(true);
    expect(verdict.evidence.observedTurns).toBe(1);
    expect(verdict.evidence.expectedTurns).toBe(30);
  });
});

// ── 真实事故原文：T9 r04（2 次被拒后弃权） ────────────────────────────────────
// 转抄自 t9-rerun/r04-flash/probe.log（requestId 与行文逐字）。
const R04_LOG = [
  R01_HEADER,
  ...repeatLine(
    '{"event":"route_declaration_invalid","requestId":"req_ca67914e-b50a-4cb1-b68c-f11390b000c8","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
    2,
  ),
  '{"event":"route_declaration_missing","requestId":"req_ca67914e-b50a-4cb1-b68c-f11390b000c8"}',
  '{"event":"turn_span","requestId":"req_ca67914e-b50a-4cb1-b68c-f11390b000c8","durationMs":14300,"outcome":"route_declaration_missing","tokensIn":1551,"tokensOut":1401,"cacheRead":18368,"cacheWrite":0,"tokens":21320,"reasoning":0}',
  '',
].join('\n');

describe('真实事故原文：容差之内的弃权（T9 r04）——本判据的诚实边界', () => {
  const verdict = judgeDeclarationContract({
    logText: R04_LOG,
    turns: [{ reply: NO_EXECUTION_CLARIFICATION, requestId: 'req_ca67914e-b50a-4cb1-b68c-f11390b000c8' }],
    expectedTurns: 1,
    caseId: 'T9',
  });

  it('绿：2 次被拒 ≤ 容差、回合闭合、出口话术可行动（r04 的红属于归因判据，不属本判据）', () => {
    expect(verdict.ok).toBe(true);
    expect(verdict.outcome).toBe('clean');
    expect(verdict.evidence.maxInvalidPerTurn).toBe(2);
  });

  it('弃权事实仍然如实记在 informational 里（不进红绿，但不许看不见）', () => {
    expect(verdict.informational.join('\n')).toContain('route_declaration_missing');
    expect(verdict.evidence.turns[0]!.declarationMissing).toBe(true);
  });
});

// ── 健康样例：arch-a 弱模型 C1 的一轮（2 次被拒，同回合自纠成功） ──────────────
// 转抄自 probe-step37/arch-a-weak/probe.log 的 C1 段第一轮：2 条被拒 → turn_declaration
// conversation → turn_span outcome=ok。
const ARCH_A_HEALTHY_OK = [
  '=== C1 20 轮混合对话，观察漂移、变慢与旧范围渗入 ===',
  '{"event":"route_declaration_invalid","requestId":"req_b3d22ed1-b97a-4bd6-9ecf-61f307edb0a7","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
  '{"event":"route_declaration_invalid","requestId":"req_b3d22ed1-b97a-4bd6-9ecf-61f307edb0a7","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
  '{"event":"turn_declaration","requestId":"req_b3d22ed1-b97a-4bd6-9ecf-61f307edb0a7","kind":"conversation"}',
  '{"event":"turn_span","requestId":"req_b3d22ed1-b97a-4bd6-9ecf-61f307edb0a7","durationMs":17795,"outcome":"ok","tokensIn":3500,"tokensOut":1700,"cacheRead":16832,"cacheWrite":0,"tokens":22032,"reasoning":0}',
  '',
].join('\n');

describe('健康样例：容差之内的自纠（arch-a C1 第一轮）', () => {
  const verdict = judgeDeclarationContract({
    logText: ARCH_A_HEALTHY_OK,
    turns: [{ reply: '我可以帮你核对平台上的记录。告诉我要核对的对象和窗口即可。', requestId: 'req_b3d22ed1-b97a-4bd6-9ecf-61f307edb0a7' }],
    expectedTurns: 1,
    caseId: 'C1',
  });

  it('绿：2 次被拒 ≤ 容差 + 回合闭合 + 回复有正文', () => {
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.maxInvalidPerTurn).toBe(2);
    expect(verdict.evidence.turns[0]!.closed).toBe(true);
  });
});

// ── 阈值边界锁：容差 2 与判红 3 是一对（改阈值必须同时改这条与文件头的分布表） ──
describe('阈值边界（≥3 判红）', () => {
  const boundaryLog = (count: number): string => [
    '=== P1 申报契约 ===',
    ...repeatLine(
      '{"event":"route_declaration_invalid","requestId":"req-x","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
      count,
    ),
    '{"event":"turn_span","requestId":"req-x","durationMs":1000,"outcome":"ok"}',
    '',
  ].join('\n');

  it(`容差 ${INVALID_DECLARATION_TOLERANCE} 次以内（含）绿`, () => {
    for (const count of [0, 1, INVALID_DECLARATION_TOLERANCE]) {
      const verdict = judgeDeclarationContract({
        logText: boundaryLog(count),
        turns: [{ reply: '好了，这一段我核对完了。', requestId: 'req-x' }],
        expectedTurns: 1,
      });
      expect(verdict.ok, `count=${count} 应绿`).toBe(true);
    }
  });

  it(`容差 + 1 = ${INVALID_DECLARATION_TOLERANCE + 1} 次起红（同形状、零信息退回）`, () => {
    const verdict = judgeDeclarationContract({
      logText: boundaryLog(INVALID_DECLARATION_TOLERANCE + 1),
      turns: [{ reply: '好了，这一段我核对完了。', requestId: 'req-x' }],
      expectedTurns: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('retry-unbounded');
  });
});

// ── 判据②：回复面空洞话术（把"话术不可行动"做成能红的尺） ────────────────────
describe('回复面空洞话术（判据②）', () => {
  const hollow = (reply: string): string => [
    '=== P1 申报契约 ===',
    '{"event":"route_declaration_invalid","requestId":"req-y","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
    '{"event":"turn_span","requestId":"req-y","durationMs":1000,"outcome":"ok"}',
    '',
  ].join('\n');

  it('FALLBACK_FAILURE 原文 = 红（零信息：没有对象、没有原因、没有下一步）', () => {
    const verdict = judgeDeclarationContract({ logText: hollow(FALLBACK_FAILURE), turns: [{ reply: FALLBACK_FAILURE }], expectedTurns: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('hollow-reply');
    expect(verdict.violations.join('\n')).toContain('零信息空洞话术');
  });

  it('FALLBACK_TIMEOUT 原文 = 红', () => {
    expect(replyFaceViolation(FALLBACK_TIMEOUT)).toContain('零信息空洞话术');
  });

  it('空回复 = 红', () => {
    const verdict = judgeDeclarationContract({ logText: hollow('   '), turns: [{ reply: '   ' }], expectedTurns: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('hollow-reply');
    expect(verdict.violations.join('\n')).toContain('空回复');
  });

  it('NO_EXECUTION_CLARIFICATION = 放行（裁定认可的 fail-closed 话术）', () => {
    expect(replyFaceViolation(NO_EXECUTION_CLARIFICATION)).toBeNull();
  });

  it('有内容的回复不误判（"查询失败"开头的解释句带原因/下一步——不是锚定句）', () => {
    expect(replyFaceViolation('查询失败的原因是对象名不完整，请把 collection 全名告诉我，我重新查一次。')).toBeNull();
    expect(replyFaceViolation('刚才查的是 contoso-trade 的 W2 窗口，两条记录。')).toBeNull();
  });
});

// ── 判据④：证据不完整不判绿（"解析不出"≠"零"） ───────────────────────────────
describe('证据完整性（判据④）', () => {
  it('被拒行存在但 JSON 被截断 → inconclusive，绝不判绿', () => {
    const broken = [
      '=== P1 申报契约 ===',
      '{"event":"route_declaration_invalid","requestId":"req-z","reason":"申报不是合法的结构化意', // 截断行
      '{"event":"turn_span","requestId":"req-z","durationMs":1000,"outcome":"ok"}',
      '',
    ].join('\n');
    const verdict = judgeDeclarationContract({ logText: broken, turns: [{ reply: '一段正常回复。' }], expectedTurns: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('inconclusive');
    expect(verdict.evidence.rawInvalidOccurrences).toBe(1);
    expect(verdict.evidence.parsedInvalidCount).toBe(0);
  });

  it('日志里没有本用例的段 → inconclusive（不拿别的用例的日志冒充）', () => {
    const other = '=== Z9 别的用例 ===\n{"event":"turn_span","requestId":"req-o","durationMs":1,"outcome":"ok"}\n';
    const verdict = judgeDeclarationContract({ logText: other, turns: [{ reply: '正常回复。' }], expectedTurns: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('inconclusive');
    expect(verdict.evidence.sectionFound).toBe(false);
  });

  it('用例段只取本段：别的用例段里的被拒行不计入本用例', () => {
    const twoSections = [
      '=== T9 别的用例 ===',
      ...repeatLine('{"event":"route_declaration_invalid","requestId":"req-t9","reason":"x","keys":["kind","request"],"kind":"conversation"}', 9),
      '{"event":"turn_span","requestId":"req-t9","durationMs":1,"outcome":"ok"}',
      '=== P1 申报契约 ===',
      '{"event":"route_declaration_invalid","requestId":"req-p1","reason":"申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。","keys":["kind","request"],"kind":"conversation"}',
      '{"event":"turn_span","requestId":"req-p1","durationMs":1,"outcome":"ok"}',
      '',
    ].join('\n');
    const verdict = judgeDeclarationContract({ logText: twoSections, turns: [{ reply: '一段正常回复。' }], expectedTurns: 1 });
    expect(verdict.evidence.parsedInvalidCount).toBe(1);
    expect(verdict.ok).toBe(true);
  });
});

// ── 解析层单元 ────────────────────────────────────────────────────────────────
describe('parseDeclarationEvents / sliceCaseSection', () => {
  it('只认四种申报事件，别的 JSON 行（delegation_span 等）不进结果', () => {
    const events = parseDeclarationEvents([
      '{"event":"delegation_span","requestId":"req-a","outcome":"ok"}',
      '{"event":"turn_declaration","requestId":"req-a","kind":"delegate","requestLength":12}',
      '{"event":"turn_span","requestId":"req-a","durationMs":9,"outcome":"ok"}',
      '前缀不是 JSON 的行',
      '',
    ].join('\n'));
    expect(events.map((event) => event.event)).toEqual(['turn_declaration', 'turn_span']);
    expect(events[0]!.requestId).toBe('req-a');
    expect(events[1]!.durationMs).toBe(9);
  });

  it('段边界：切到下一个用例头为止，尾部汇总行不吞进段里', () => {
    const log = [
      '=== P1 申报契约 ===',
      '{"event":"turn_span","requestId":"req-p","durationMs":1,"outcome":"ok"}',
      '=== P2 下一个用例 ===',
      '{"event":"turn_span","requestId":"req-q","durationMs":1,"outcome":"ok"}',
      '================ 汇总 ================',
      '',
    ].join('\n');
    const section = sliceCaseSection(log, 'P1');
    expect(section).not.toBeNull();
    expect(section).toContain('req-p');
    expect(section).not.toContain('req-q');
    expect(section).not.toContain('汇总');
  });
});

// ── 语料锁：cases.yaml 的 P1 与判据常量 / runner 登记表三方对齐 ────────────────
describe('语料锁：cases.yaml 的 P1', () => {
  const cases = loadCases();
  const spec = cases.find((item) => item.id === DECLARATION_CASE_ID);

  it('用例在（probe 类型、进语料但不进基线、有事故标签）', () => {
    expect(spec, `cases.yaml 里缺 ${DECLARATION_CASE_ID}`).toBeDefined();
    expect(spec!.kind).toBe('probe');
    expect(spec!.inBaseline).toBe(false);
    expect(spec!.incidents.length).toBeGreaterThan(0);
  });

  it('消息里有一条 engineered bait 轮 + 一条 T9 原形的归因轮', () => {
    const texts = spec!.messages.map((message) => message.text ?? '');
    expect(texts.some((text) => text.includes('刚才查的是哪个'))).toBe(true);
    // bait 轮：用户明确不给执行授权（先别查/等我挑），同时把"下一步做什么"摆到模型面前——
    // 这正是让它想往 conversation 申报里多带 request 的动机。语料被改掉这一句，这里先红。
    const bait = texts.find((text) => text.includes('先别') && text.includes('我挑一个'));
    expect(bait, 'cases.yaml 的 P1 缺 engineered bait 轮').toBeDefined();
  });

  it('判定体在 probe-real-agent.ts 登记（否则 loadProbeCases 会让整个探针 fail-fast）', () => {
    const probeSource = readFileSync(path.join(evalDir, '..', 'probe-real-agent.ts'), 'utf8');
    for (const item of cases.filter((entry) => entry.kind === 'probe')) {
      expect(
        new RegExp(`(^|\\n)\\s*'?${item.id}'?:\\s*async\\s*\\(`).test(probeSource),
        `cases.yaml 的 ${item.id} 在 probe-real-agent.ts 没有判定体`,
      ).toBe(true);
    }
  });
});
