import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CASES_PATH,
  PLAN_POLICY_ENV_KEYS,
  PLAN_POLICY_LINES,
  PLAN_POLICY_TIERS,
  TURN_MARKS,
  fixtureEnvOf,
  loadCases,
  toCorpusEntries,
} from './cases';
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

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 写一份最小 cases.yaml（fixture 块由参数决定），返回路径。 */
function casesFileWithFixture(fixtureYaml: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cases-plan-policy-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'cases.yaml');
  writeFileSync(file, `version: 1
cases:
  - id: T1
    group: test
    kind: probe
    inBaseline: false
    incidents: [test]
    intent: test
    businessGoal: test
    fixture:
${fixtureYaml}
    allowedSideEffects:
      writableCollections: []
      writes: []
    messages:
      - text: hi
    expectations: null
    expect: test
`);
  return file;
}

function stockFixture(extra = ''): string {
  return `      name: stock-platform
      isolation: per-case-state-dir
      env: {}
${extra}`;
}

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

  it('占位条目不得进基线：score 与统一报告两侧同源的前提（2026-11-10 评审 low）', () => {
    // 占位条目 inBaseline:true 时，报告侧先判 placeholder ⇒ skip，score 侧若只看
    // inBaseline 就会评估它——两侧判定不同源。score.ts 已补 placeholder 跳过做防御，
    // 数据层再钉死"占位不进基线"，不让这种条目出现在默认判定集里。
    for (const spec of cases.filter((item) => item.placeholder)) {
      expect(spec.inBaseline, `${spec.id} 是占位条目却 inBaseline:true`).toBe(false);
    }
    // 判定集与跳过集同源：CorpusEntry 必须携带占位标记，score.ts 才看得见。
    const entries = toCorpusEntries(cases);
    for (const spec of cases.filter((item) => item.placeholder)) {
      const entry = entries.find((item) => item.case === spec.id);
      expect(entry?.placeholder, `${spec.id} 的 CorpusEntry 丢了 placeholder 标记`).toBe(true);
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

/**
 * message 级 answerTypes（2026-11-10 owner 裁定）：用例作者对本轮问题的封闭答案分类，
 * judge 定型用。解析必须校验 verdict 枚举与 id/shape 非空——分类表写错不能被静默丢弃
 * （那会让 judge 退回四维通用定义，语义判定静默失守）。
 */
describe('message 级 answerTypes', () => {
  const y2 = cases.find((item) => item.id === 'Y2')!;

  it('Y2 第 3 条消息挂了 A/B/C/D 分类表（pass/pass/fail/fail，shape 非空）', () => {
    const types = y2.messages[2]?.answerTypes ?? [];
    expect(types.map((type) => [type.id, type.verdict])).toEqual([
      ['A', 'pass'],
      ['B', 'pass'],
      ['C', 'fail'],
      ['D', 'fail'],
    ]);
    for (const type of types) {
      expect(type.shape.trim().length, `${type.id} 缺 shape`).toBeGreaterThan(0);
    }
  });

  const caseYaml = (answerTypes: string): string => `cases:
  - id: T
    group: g
    kind: probe
    inBaseline: false
    incidents: [x]
    intent: i
    businessGoal: b
    fixture:
      name: dummy-platform
      isolation: tmp
      env: {}
    allowedSideEffects:
      writableCollections: []
      writes: []
    checks: []
    messages:
      - text: hi
${answerTypes}
    expectations: null
    expect: e
`;

  const loadYaml = (answerTypes: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fshine-cases-'));
    const file = path.join(dir, 'cases.yaml');
    writeFileSync(file, caseYaml(answerTypes));
    try {
      return loadCases(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const valid = `        answerTypes:
          - id: A
            verdict: pass
            shape: ok`;

  it('合法分类表可解析（正例：解析器不是恒拒）', () => {
    const parsed = loadYaml(valid);
    expect(parsed[0]?.messages[0]?.answerTypes).toEqual([{ id: 'A', verdict: 'pass', shape: 'ok' }]);
  });

  it('verdict 只收 pass/fail：未知值 fail-fast', () => {
    expect(() => loadYaml(valid.replace('verdict: pass', 'verdict: maybe'))).toThrow(/verdict 不是 pass\/fail/);
  });

  it('id 必须非空：空字符串 fail-fast', () => {
    expect(() => loadYaml(valid.replace('id: A', "id: ''"))).toThrow(/id 不是非空字符串/);
  });

  it('shape 必须非空：空字符串 fail-fast', () => {
    expect(() => loadYaml(valid.replace('shape: ok', "shape: ''"))).toThrow(/shape 不是非空字符串/);
  });

  it('answerTypes 不是数组 fail-fast（不静默当没有分类表）', () => {
    expect(() => loadYaml('        answerTypes: nope')).toThrow(/answerTypes 不是数组/);
  });
});

describe('fixture.planPolicy 四档预算表（stock 夹具的按用例旋钮）', () => {
  it('全表拍平为 12 个 STOCK_PLAN_* 键；confirm.weight 落在 BUDGET 真名', () => {
    const file = casesFileWithFixture(stockFixture(`      planPolicy:
        auto: { calls: 2, seconds: 60, weight: 6 }
        notify: { calls: 10, seconds: 180, weight: 18 }
        confirm: { calls: 20, seconds: 600, weight: 60 }
        hard: { calls: 1, seconds: 1800, weight: 180 }
`));
    const spec = loadCases(file)[0]!;
    const env = fixtureEnvOf(spec.fixture);
    expect(Object.keys(env).sort()).toEqual(
      PLAN_POLICY_TIERS.flatMap((tier) => PLAN_POLICY_LINES.map((line) => PLAN_POLICY_ENV_KEYS[tier][line])).sort(),
    );
    expect(env['STOCK_PLAN_HARD_CALLS']).toBe('1');
    expect(env['STOCK_PLAN_BUDGET_WEIGHT']).toBe('60');
    expect(env['STOCK_PLAN_CONFIRM_WEIGHT']).toBeUndefined();
  });

  it('缺档/缺线不注入（夹具缺省是唯一缺省来源）', () => {
    const file = casesFileWithFixture(stockFixture(`      planPolicy:
        hard:
          calls: 1
`));
    const spec = loadCases(file)[0]!;
    expect(fixtureEnvOf(spec.fixture)).toEqual({ STOCK_PLAN_HARD_CALLS: '1' });
  });

  it('拒绝零 / 负数 / 小数 / 字符串阈值', () => {
    for (const value of ['0', '-1', '1.5', "'2'", 'true']) {
      const file = casesFileWithFixture(stockFixture(`      planPolicy:
        hard:
          calls: ${value}
`));
      expect(() => loadCases(file), `calls: ${value} 应被拒`).toThrow(/正整数/);
    }
  });

  it('拒绝未知档位与未知线名', () => {
    for (const policy of [
      `        urgent: { calls: 1 }`,
      `        hard: { cost: 1 }`,
    ]) {
      const file = casesFileWithFixture(stockFixture(`      planPolicy:
${policy}
`));
      expect(() => loadCases(file), policy).toThrow(/不是四档之一|不是三线之一/);
    }
  });

  it('拒绝空表 / 空档 / 非映射', () => {
    for (const policy of [`      planPolicy: {}`, `      planPolicy:\n        hard: {}`, `      planPolicy: 3`]) {
      const file = casesFileWithFixture(stockFixture(`${policy}\n`));
      expect(() => loadCases(file), policy).toThrow(/至少声明一条档位阈值|空档|不是映射/);
    }
  });

  it('只接受 stock 夹具：dummy 声明四档表即失败', () => {
    const file = casesFileWithFixture(`      name: dummy-platform
      isolation: per-case-state-dir
      env: {}
      planPolicy:
        hard: { calls: 1 }
`);
    expect(() => loadCases(file)).toThrow(/只适用于 stock-platform/);
  });

  it('fixture.env 与 planPolicy 重复声明同一阈值即失败', () => {
    const file = casesFileWithFixture(`      name: stock-platform
      isolation: per-case-state-dir
      env:
        STOCK_PLAN_HARD_CALLS: '5'
      planPolicy:
        hard: { calls: 1 }
`);
    expect(() => loadCases(file)).toThrow(/重复声明 STOCK_PLAN_HARD_CALLS/);
  });

  it('真实 cases.yaml 目前没有 stock 四档表（机制就绪但未改任何现有 case）', () => {
    expect(cases.filter((spec) => spec.fixture.planPolicy !== undefined)).toEqual([]);
  });
});
