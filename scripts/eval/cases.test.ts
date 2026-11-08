import { describe, expect, it } from 'vitest';
import { CASES_PATH, TURN_MARKS, loadCases, toCorpusEntries } from './cases';
import { loadBaseline } from './score';

/**
 * 用例语料数据锁（issue 切片 C）：cases.yaml 是唯一用例数据源，本测试锁它的**结构不变量**。
 *
 * 防的故障形态：
 *   · 语料与判定体脱钩（yaml 有 id 而 probe-real-agent.ts 没有 CASE_RUNNERS 条目）——
 *     探针侧 loadProbeCases 已 fail-fast，这里锁数据面：进基线的条目必须有基线项；
 *   · 未审计用例被凭猜补上期望值（那会让第四层在没核过的用例上红，制造假回归）；
 *   · 消息序列为空/文本缺失（跑起来是空转，报告却像跑过）。
 */

const cases = loadCases();
const baseline = loadBaseline();

describe('cases.yaml 结构', () => {
  it('可解析、id 唯一、probe 与 acceptance 两类都在', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.some((item) => item.kind === 'probe')).toBe(true);
    expect(cases.some((item) => item.kind === 'acceptance')).toBe(true);
  });

  it('每个用例都有非空消息序列；probe 消息必须有原文', () => {
    for (const spec of cases) {
      expect(spec.messages.length, `${spec.id} 消息序列为空`).toBeGreaterThan(0);
      if (spec.kind !== 'probe') continue;
      for (const message of spec.messages) {
        expect(typeof message.text === 'string' && message.text.length > 0, `${spec.id} 有消息缺原文`).toBe(true);
      }
    }
  });

  it('轮次标记只用声明过的六个（past/recall/requery/landing/reasoning/summary）', () => {
    for (const spec of cases) {
      for (const message of spec.messages) {
        for (const mark of message.marks ?? []) expect(TURN_MARKS).toContain(mark);
      }
    }
  });

  it('followUps 的条件分支只用声明过的两种（clarified / pausePrompted）', () => {
    for (const spec of cases) {
      for (const message of spec.followUps ?? []) {
        if (message.when === undefined) continue;
        expect(['clarified', 'pausePrompted'], `${spec.id} 未知条件 ${message.when}`).toContain(message.when);
      }
    }
  });
});

describe('审计过的用例（四元组完整）与未审计占位（不猜）', () => {
  it('非占位条目四元组齐全：businessGoal / fixture / allowedSideEffects / checks / expectations', () => {
    for (const spec of cases.filter((item) => !item.placeholder)) {
      expect(spec.businessGoal.length, `${spec.id} 缺 businessGoal`).toBeGreaterThan(0);
      expect(spec.fixture.name.length, `${spec.id} 缺 fixture 声明`).toBeGreaterThan(0);
      expect(spec.fixture.isolation.length, `${spec.id} 缺隔离声明`).toBeGreaterThan(0);
      expect(spec.allowedSideEffects, `${spec.id} 缺副作用声明`).toBeDefined();
      expect(spec.expectations, `${spec.id} 缺期望值（判定层在该用例上恒空）`).not.toBeNull();
    }
  });

  it('占位条目不猜内容：expectations 为 null，且必须声明卡点', () => {
    const placeholders = cases.filter((item) => item.placeholder);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const spec of placeholders) {
      expect(spec.expectations, `${spec.id} 是占位条目却带了期望值`).toBeNull();
      // 2026-11-08 升级（PR #21 审查 blocking 的修复一部分）：原守卫只 grep expect 里的
      // "切片 E"——那是把"卡在哪"编码成一个魔法子串，Q5b/Q13b 这类"判据齐全但需要真平台
      // 数据"的条目就会被误判。现在每个占位条目必须显式声明 blocker， Parsing 层缺了就 fail
      // （cases.ts 的 fail），测试层再钉一遍非空。
      expect((spec.blocker ?? '').trim().length, `${spec.id} 占位条目未声明 blocker`).toBeGreaterThan(0);
    }
  });

  it('占位不等于没审计：prose 层（businessGoal/checks）可以齐全', () => {
    // Q5b/Q13b 按 9ba6d0f 原文恢复：判据 prose 层完整，只差机械层（需真平台数据）。
    // 防止有人把"占位"当成"可以只写一句话"的借口——那正是静默丢覆盖的形态。
    for (const id of ['Q5b', 'Q13b']) {
      const spec = cases.find((item) => item.id === id);
      expect(spec, `${id} 应已恢复`).toBeDefined();
      expect(spec!.businessGoal.length).toBeGreaterThan(40);
      expect(spec!.checks.length).toBeGreaterThan(0);
      expect(spec!.incidents.length).toBeGreaterThan(0);
      expect(spec!.blocker).toContain('dummy 夹具');
    }
  });

  it('写副作用只在允许清单里声明（默认只读）', () => {
    for (const spec of cases) {
      for (const write of spec.allowedSideEffects.writes) {
        expect(spec.allowedSideEffects.writableCollections, `${spec.id} 写了未声明可写的 collection`).toContain(write.collection);
      }
    }
  });
});

describe('语料 ↔ 基线 ↔ 用例', () => {
  it('语料条目与用例一一对应（id 前缀 probe- / acceptance 同 id）', () => {
    const entries = toCorpusEntries(cases);
    expect(entries.length).toBe(cases.length);
    for (const entry of entries) {
      const spec = cases.find((item) => (item.kind === 'probe' ? `probe-${item.id}` : item.id) === entry.id);
      expect(spec, `语料 ${entry.id} 对不上用例`).toBeDefined();
      expect(entry.inBaseline).toBe(spec!.inBaseline);
    }
  });

  it('进基线的条目都有基线项（语料 ⊆ 基线锁，score.ts 的 exit 2 判据同口径）', () => {
    for (const entry of toCorpusEntries(cases).filter((item) => item.inBaseline)) {
      if (entry.kind === 'probe') expect(baseline.cases[entry.id], `${entry.id} 缺基线项`).toBeDefined();
      else expect(baseline.writeChain[entry.conversation!], `${entry.id} 缺 writeChain 基线项`).toBeDefined();
    }
  });

  it('acceptance 条目的会话与用例组对得上', () => {
    const entry = toCorpusEntries(cases).find((item) => item.id === 'write-chain-51');
    expect(entry?.conversation).toBe('acc-write-51');
    expect(entry?.cases).toEqual(['5.1', '5.1b', '5.2', '5.3', '5.4']);
  });

  it('夹具声明的目录真实存在（防指向已删除的夹具）', async () => {
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    for (const spec of cases) {
      const root = path.resolve(CASES_PATH, '..', 'fixtures', spec.fixture.name);
      expect(existsSync(root), `${spec.id} 的夹具 ${spec.fixture.name} 不存在`).toBe(true);
    }
  });
});
