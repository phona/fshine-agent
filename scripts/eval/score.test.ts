import { describe, expect, it } from 'vitest';
import {
  evaluateProbeCase, evaluateWriteChainCase, loadBaseline, loadCorpus, partitionCorpusForScoring,
  validAuditFailuresValue,
  type Baseline, type ProbeResultRow,
} from './score';
import type { CaseSpec } from './cases';
import type { ConversationWriteChainFacts } from './write-chain';

/** 打分器锁：纯判定函数 + 语料/基线真实文件的一致性。变异验证口径见各 it 注释。 */

const ZERO_DIMS = { groundedness: 0, entityFidelity: 0, failureHonesty: 0, presentationHygiene: 0 };

function probeRow(overrides: Partial<ProbeResultRow> = {}): ProbeResultRow {
  return { id: 'probe-X', ok: true, dims: { ...ZERO_DIMS }, unclassifiedNotes: 0, notes: [], turns: [], ...overrides };
}

function facts(overrides: Partial<ConversationWriteChainFacts> = {}): ConversationWriteChainFacts {
  return {
    conversationId: 'acc-write-51',
    sessionKey: 'wecom:u:acc-write-51',
    cases: ['5.1', '5.2'],
    proposalAttempts: 1,
    intents: [{ status: 'committed', hasResult: true }],
    confirmCodeOffered: true,
    ...overrides,
  };
}

describe('evaluateProbeCase（机械+评委判定）', () => {
  const baselineCase = { dims: { ...ZERO_DIMS } };

  it('全零 dims + ok → 通过；任一维超上限 → 该维红（变异口径：比较符反转则此断言红）', () => {
    const pass = evaluateProbeCase('probe-X', probeRow(), baselineCase);
    expect(pass.pass).toBe(true);
    expect(pass.checks).toHaveLength(5); // 四维 + 探针ok
    const worse = evaluateProbeCase('probe-X', probeRow({ dims: { ...ZERO_DIMS, presentationHygiene: 1 } }), baselineCase);
    expect(worse.pass).toBe(false);
    expect(worse.checks.find((check) => check.name === '卫生违例')).toMatchObject({ pass: false, expected: '≤0', actual: '1' });
  });

  it('「不劣化」档：基线上限 1 时，1 过 2 红（A2 观察项的口径）', () => {
    const lenient = { dims: { ...ZERO_DIMS, entityFidelity: 1 } };
    expect(evaluateProbeCase('probe-X', probeRow({ dims: { ...ZERO_DIMS, entityFidelity: 1 } }), lenient).pass).toBe(true);
    expect(evaluateProbeCase('probe-X', probeRow({ dims: { ...ZERO_DIMS, entityFidelity: 2 } }), lenient).pass).toBe(false);
  });

  it('okMode：strict（缺省）要求 ok=true；free 不断言 ok（缺点出现与否是方差，上限由 dims 承载）', () => {
    expect(evaluateProbeCase('probe-X', probeRow({ ok: false }), baselineCase).pass).toBe(false);
    // free：ok 真假都不断言——不存在"必须为 false"的模式（惩罚改进，首轮实测踩过）
    const free = evaluateProbeCase('probe-X', probeRow({ ok: false }), { ...baselineCase, okMode: 'free' });
    expect(free.pass).toBe(true);
    expect(free.checks.some((check) => check.name === '探针ok')).toBe(false);
    expect(evaluateProbeCase('probe-X', probeRow({ ok: true }), { ...baselineCase, okMode: 'free' }).pass).toBe(true);
  });

  it('评委分量：≥ 基线−容差（默认 1）过；null 基线跳过；缺评委结果不检查', () => {
    const withJudge = {
      ...baselineCase,
      judge: { groundedness: 2, entityFidelity: 1, failureHonesty: null, presentationHygiene: 2 },
    };
    const judge = { scores: { groundedness: 1, entityFidelity: 1, failureHonesty: 0, presentationHygiene: 2 }, evidence: [], model: 'm' };
    const verdict = evaluateProbeCase('probe-X', probeRow(), withJudge, judge as never);
    expect(verdict.pass).toBe(true); // groundedness 1 ≥ 2-1；entity 1 ≥ 1-1；honesty null 跳过
    const strict = evaluateProbeCase('probe-X', probeRow(), withJudge, { ...judge, scores: { ...judge.scores, groundedness: 0 } } as never);
    expect(strict.checks.find((check) => check.name === '评委·有据')).toMatchObject({ pass: false, expected: '≥1', actual: '0' });
  });

  it('探针报告缺该用例 / 基线缺该用例都红（不是静默跳过）', () => {
    expect(evaluateProbeCase('probe-X', undefined, baselineCase).pass).toBe(false);
    expect(evaluateProbeCase('probe-X', probeRow(), undefined).pass).toBe(false);
  });

  it('口径答案分类门：需要答案分类的轮次在没跑 --judge 时显式红——不把“没判”读成“没问题”', () => {
    // 三层断言模型②：口径编造判定归 judge 的 answerTypes，机械层不再判；但默认路径
    // （无 --judge）该轴无人判定——与申报门同一纪律 fail-closed，不静默计通过。
    const spec = {
      messages: [{ text: 'check payable', answerTypes: [{ id: 'A', verdict: 'pass', shape: '声明缺失只给记录值' }] }],
    } as CaseSpec;
    const noJudge = evaluateProbeCase('probe-X', probeRow(), baselineCase, undefined, spec);
    expect(noJudge.checks.find((check) => check.name === '期望·口径答案分类'))
      .toMatchObject({ pass: false, expected: 'judge 按 answerTypes 定型（--judge）' });
    expect(noJudge.pass).toBe(false);
    // 跑了评委 ⇒ 不出该门（该轴由评委分承载：回复落 fail 形态 ⇒ groundedness 0 ⇒ 评委分检查红）。
    const judge = { scores: { groundedness: 2, entityFidelity: 0, failureHonesty: 0, presentationHygiene: 0 }, evidence: [], model: 'm' };
    expect(evaluateProbeCase('probe-X', probeRow(), baselineCase, judge as never, spec)
      .checks.some((check) => check.name === '期望·口径答案分类')).toBe(false);
    // 没有答案分类的用例不出该门、不因该门红。
    const plain = evaluateProbeCase('probe-X', probeRow(), baselineCase, undefined, { messages: [{ text: 'x' }] } as CaseSpec);
    expect(plain.checks.some((check) => check.name === '期望·口径答案分类')).toBe(false);
    expect(plain.pass).toBe(true);
  });
});

describe('audited 申报失败门（PR #26 评审 blocking：申报判定不能对评分零影响）', () => {
  const baselineCase = { dims: { ...ZERO_DIMS } };
  const auditCheckOf = (verdict: ReturnType<typeof evaluateProbeCase>) =>
    verdict.checks.find((check) => check.name === 'audited·申报失败');

  it('申报失败数 > 0 ⇒ 该检查红（计数是 findings 全量，不枚举失败种类）', () => {
    const verdict = evaluateProbeCase('probe-X', probeRow({ auditFailures: 3 }), baselineCase, undefined, undefined, true);
    expect(auditCheckOf(verdict)).toMatchObject({ pass: false, expected: '≤0', actual: '3' });
    expect(verdict.pass).toBe(false);
  });

  it('申报失败数 = 0 ⇒ 该检查绿，整例通过（变异口径：actual <= limit 改成 < ⇒ 此断言红）', () => {
    const verdict = evaluateProbeCase('probe-X', probeRow({ auditFailures: 0 }), baselineCase, undefined, undefined, true);
    expect(auditCheckOf(verdict)).toMatchObject({ pass: true, expected: '≤0', actual: '0' });
    expect(verdict.pass).toBe(true);
  });

  it('基线放宽上限时 = limit 也过（只增才算劣化）', () => {
    const verdict = evaluateProbeCase(
      'probe-X', probeRow({ auditFailures: 2 }), { ...baselineCase, auditFailures: 2 }, undefined, undefined, true,
    );
    expect(auditCheckOf(verdict)!.pass).toBe(true);
  });

  it('黑盒模式 ⇒ 无此检查（即使报告行带了计数也不门）', () => {
    const verdict = evaluateProbeCase('probe-X', probeRow({ auditFailures: 9 }), baselineCase);
    expect(auditCheckOf(verdict)).toBeUndefined();
    expect(verdict.pass).toBe(true);
  });

  it('audited 行缺计数 ⇒ fail-closed（缺列不是 0："没跑交叉核"不能冒充"查过且全过"）', () => {
    const verdict = evaluateProbeCase('probe-X', probeRow(), baselineCase, undefined, undefined, true);
    expect(auditCheckOf(verdict)).toMatchObject({ pass: false, actual: '缺计数（未跑申报交叉核）' });
    expect(verdict.pass).toBe(false);
  });

  it('显式不适用（整例没有可核轮）⇒ 检查照出且判失败——"没得核"不是"查过且全过"（2026-11-10 评审 2 high）', () => {
    // 旧语义 pass=true：「整例没有一个可核轮」被当成通过，等于"无证据 = 通过"——与本分支
    // 既有口径（evidence.ts mechanicallyPassed：零证据 ⇒ false）相悖。选失败而非三态"待定"
    // 的理由见 auditFailuresCheckOf 注释；actual 与真实计数失败可区分（可审计性不丢）。
    const verdict = evaluateProbeCase('probe-X', probeRow({ auditFailures: 'not-applicable' }), baselineCase, undefined, undefined, true);
    expect(auditCheckOf(verdict)).toMatchObject({ pass: false, expected: '≤0', actual: '不适用（整例没有可核轮）' });
    expect(verdict.pass).toBe(false);
  });

  it('审计源不可读（有轮次但证据缺席）⇒ 判失败，不因"还有干净轮次"放行（2026-11-10 评审 high）', () => {
    const verdict = evaluateProbeCase('probe-X', probeRow({ auditFailures: 'unverifiable' }), baselineCase, undefined, undefined, true);
    expect(auditCheckOf(verdict)).toMatchObject({ pass: false, actual: '不可核（审计源不可读）' });
    expect(verdict.pass).toBe(false);
  });

  it('报告格式守卫：接受非负整数与两个显式状态，拒收缺列/负数/小数（零轮占位不让整份报告 exit 2）', () => {
    // 探针报告行 → score.ts 的格式守卫（main() 里用它筛 staleAudit）。判据导出后单测
    // 直接钉：N/A 若被拒收，--quick --audit 里有零轮占位/崩溃用例就会整份报告 exit 2，
    // 连带申报全对的其余用例都打不了分；缺列仍必须 fail-closed。
    expect(validAuditFailuresValue(0)).toBe(true);
    expect(validAuditFailuresValue(2)).toBe(true);
    expect(validAuditFailuresValue('not-applicable')).toBe(true);
    expect(validAuditFailuresValue('unverifiable')).toBe(true);
    // -1 是不可知哨兵不是计数：`-1 <= limit` 会让它冒充全过（2026-11-10 评审 low）。
    expect(validAuditFailuresValue(-1)).toBe(false);
    expect(validAuditFailuresValue(1.5)).toBe(false);
    expect(validAuditFailuresValue(Number.NaN)).toBe(false);
    expect(validAuditFailuresValue(undefined)).toBe(false);
    expect(validAuditFailuresValue(null)).toBe(false);
  });
});

describe('判定集/跳过集同源：占位条目即使被误标 inBaseline 也不评估', () => {
  // 2026-11-10 评审 low：统一报告侧先判 placeholder，score.ts 主循环旧写法只看
  // inBaseline——占位条目一旦被误标 inBaseline:true，两侧判定就分叉（报告 skip、
  // score 评估）。主循环的过滤已收敛到 partitionCorpusForScoring，这里直接钉该函数：
  // 只测报告侧（unifiedCasePassedOf）时，删掉 score 侧占位分支仍然全绿。
  it('placeholder:true 且 inBaseline:true ⇒ 进跳过集，不进判定集（判别点：抹掉占位标记后进判定集）', () => {
    const q5b = loadCorpus().find((entry) => entry.case === 'Q5b')!;
    expect(q5b.placeholder).toBe(true);
    const promoted = { ...q5b, inBaseline: true };
    const { judged, skipped } = partitionCorpusForScoring([promoted]);
    expect(judged).toEqual([]);
    expect(skipped.map((entry) => entry.id)).toEqual([promoted.id]);
    // 判别点：同一输入抹掉占位标记 ⇒ 进判定集。证明上面的 skip 不是 inBaseline 单独造成的。
    const asNonPlaceholder = { ...promoted, placeholder: undefined };
    expect(partitionCorpusForScoring([asNonPlaceholder]).judged.map((entry) => entry.id))
      .toEqual([asNonPlaceholder.id]);
    expect(partitionCorpusForScoring([asNonPlaceholder]).skipped).toEqual([]);
  });

  it('普通未进基线条目仍按 skipped（占位判据没有吞掉既有口径）', () => {
    const nonBaseline = loadCorpus().find((entry) => !entry.inBaseline && entry.placeholder !== true)!;
    const { judged, skipped } = partitionCorpusForScoring([nonBaseline]);
    expect(judged).toEqual([]);
    expect(skipped.map((entry) => entry.id)).toEqual([nonBaseline.id]);
  });
});

describe('evaluateWriteChainCase（写链判定）', () => {
  const group = {
    proposalAttemptsAtLeast: 1, confirmCodeOffered: true, intentCreated: true, committed: true, readbackVerified: true,
  };

  it('全链形状 → 通过', () => {
    const verdict = evaluateWriteChainCase({ id: 'write-chain-51', kind: 'acceptance', conversation: 'acc-write-51', inBaseline: true, incidents: ['x'], expect: '' }, facts(), group);
    expect(verdict.pass).toBe(true);
    expect(verdict.checks.map((check) => check.name)).toEqual(['提案尝试', '确认码已给出', '提案意图已建', '落账 committed', '读回校验在']);
  });

  it('D-097 反例形状（承诺了录入但零尝试/零意图/无码）→ 逐项红', () => {
    const verdict = evaluateWriteChainCase(
      { id: 'write-chain-51', kind: 'acceptance', conversation: 'acc-write-51', inBaseline: true, incidents: ['x'], expect: '' },
      facts({ proposalAttempts: 0, intents: [], confirmCodeOffered: false }),
      group,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.filter((check) => !check.pass).map((check) => check.name)).toEqual(['提案尝试', '确认码已给出', '提案意图已建', '落账 committed', '读回校验在']);
  });

  it('落账但读回摘要缺失（verified 恒假的「已落账报失败」前兆）→ 只读回红', () => {
    const verdict = evaluateWriteChainCase(
      { id: 'write-chain-51', kind: 'acceptance', conversation: 'acc-write-51', inBaseline: true, incidents: ['x'], expect: '' },
      facts({ intents: [{ status: 'committed', hasResult: false }] }),
      group,
    );
    expect(verdict.checks.find((check) => check.name === '落账 committed')!.pass).toBe(true);
    expect(verdict.checks.find((check) => check.name === '读回校验在')!.pass).toBe(false);
  });

  it('会话缺失（验收没跑到该组）红，不静默', () => {
    const verdict = evaluateWriteChainCase({ id: 'write-chain-51', kind: 'acceptance', conversation: 'acc-write-51', inBaseline: true, incidents: ['x'], expect: '' }, undefined, group);
    expect(verdict.pass).toBe(false);
  });
});

describe('真实语料/基线文件一致性锁', () => {
  const corpus = loadCorpus();
  const baseline: Baseline = loadBaseline();

  it('语料可解析、id 唯一、六条存量事故各有用例落点', () => {
    const incidents = new Set(corpus.flatMap((entry) => entry.incidents));
    const corpusText = JSON.stringify(corpus);
    for (const incident of ['围栏', '驼峰', '抽象泄漏', '2048', '复读', '实体串台']) {
      expect(corpusText.includes(incident), `事故「${incident}」须有语料落点`).toBe(true);
    }
    expect(incidents.size).toBeGreaterThan(0);
  });

  it('进基线的语料 ⊆ baseline（cases 按语料 id，writeChain 按会话 id）', () => {
    for (const entry of corpus.filter((item) => item.inBaseline)) {
      if (entry.kind === 'probe') {
        expect(baseline.cases[entry.id], `${entry.id} 须有基线项`).toBeDefined();
      } else {
        expect(baseline.writeChain[entry.conversation!], `${entry.id} 须有 writeChain 基线项`).toBeDefined();
      }
    }
  });

  it('基线项反向都有语料落点（防删语料留孤儿基线）', () => {
    const probeIds = new Set(corpus.filter((item) => item.kind === 'probe').map((item) => item.id));
    const conversations = new Set(corpus.filter((item) => item.kind === 'acceptance').map((item) => item.conversation));
    for (const id of Object.keys(baseline.cases)) expect(probeIds.has(id), `基线 cases.${id} 无语料落点`).toBe(true);
    for (const conversation of Object.keys(baseline.writeChain)) {
      expect(conversations.has(conversation), `基线 writeChain.${conversation} 无语料落点`).toBe(true);
    }
  });

  // 2026-11-08 切片 C：corpus.jsonl 并进 cases.yaml 时核对 acceptance.ts 的 CASES——
  // 原语料只列到 5.3，漏了同会话的 5.4（复用码二次确认）。以 acceptance.ts 的实际
  // 用例组为准（5.4 是该写链的「复用码不双计」格，不是新会话）。
  it('write-chain-51 的写链用例组覆盖确认链（5.1→5.1b→5.2→5.3→5.4）', () => {
    const entry = corpus.find((item) => item.id === 'write-chain-51');
    expect(entry!.cases).toEqual(['5.1', '5.1b', '5.2', '5.3', '5.4']);
  });
});
