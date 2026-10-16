import { describe, expect, it } from 'vitest';
import {
  evaluateProbeCase, evaluateWriteChainCase, loadBaseline, loadCorpus,
  type Baseline, type ProbeResultRow,
} from './score';
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
    const pass = evaluateProbeCase(probeRow(), baselineCase);
    expect(pass.pass).toBe(true);
    expect(pass.checks).toHaveLength(5); // 四维 + 探针ok
    const worse = evaluateProbeCase(probeRow({ dims: { ...ZERO_DIMS, presentationHygiene: 1 } }), baselineCase);
    expect(worse.pass).toBe(false);
    expect(worse.checks.find((check) => check.name === '卫生违例')).toMatchObject({ pass: false, expected: '≤0', actual: '1' });
  });

  it('「不劣化」档：基线上限 1 时，1 过 2 红（A2 观察项的口径）', () => {
    const lenient = { dims: { ...ZERO_DIMS, entityFidelity: 1 } };
    expect(evaluateProbeCase(probeRow({ dims: { ...ZERO_DIMS, entityFidelity: 1 } }), lenient).pass).toBe(true);
    expect(evaluateProbeCase(probeRow({ dims: { ...ZERO_DIMS, entityFidelity: 2 } }), lenient).pass).toBe(false);
  });

  it('okExpected：缺省 true，A2 式 false 基线接受 ⚠', () => {
    expect(evaluateProbeCase(probeRow({ ok: false }), baselineCase).pass).toBe(false);
    expect(evaluateProbeCase(probeRow({ ok: false }), { ...baselineCase, okExpected: false }).pass).toBe(true);
    expect(evaluateProbeCase(probeRow({ ok: true }), { ...baselineCase, okExpected: false }).pass).toBe(false);
  });

  it('评委分量：≥ 基线−容差（默认 1）过；null 基线跳过；缺评委结果不检查', () => {
    const withJudge = {
      ...baselineCase,
      judge: { groundedness: 2, entityFidelity: 1, failureHonesty: null, presentationHygiene: 2 },
    };
    const judge = { scores: { groundedness: 1, entityFidelity: 1, failureHonesty: 0, presentationHygiene: 2 }, evidence: [], model: 'm' };
    const verdict = evaluateProbeCase(probeRow(), withJudge, judge as never);
    expect(verdict.pass).toBe(true); // groundedness 1 ≥ 2-1；entity 1 ≥ 1-1；honesty null 跳过
    const strict = evaluateProbeCase(probeRow(), withJudge, { ...judge, scores: { ...judge.scores, groundedness: 0 } } as never);
    expect(strict.checks.find((check) => check.name === '评委·有据')).toMatchObject({ pass: false, expected: '≥1', actual: '0' });
  });

  it('探针报告缺该用例 / 基线缺该用例都红（不是静默跳过）', () => {
    expect(evaluateProbeCase(undefined, baselineCase).pass).toBe(false);
    expect(evaluateProbeCase(probeRow(), undefined).pass).toBe(false);
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

  it('write-chain-51 的写链用例组覆盖确认链（5.1→5.1b→5.2）', () => {
    const entry = corpus.find((item) => item.id === 'write-chain-51');
    expect(entry!.cases).toEqual(['5.1', '5.1b', '5.2', '5.3']);
  });
});
