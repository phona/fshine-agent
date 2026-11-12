/**
 * S3「事实问题必须新取」判据单测（issue #50 用例 3）。
 *
 * 判据自持（同 unreq-action-criteria 的纪律）：不 import 宿主 @fshine/agent、不起网络，
 * 只吃审计行投影。反例同时是变异测试的种子——把 `rowFetchesFact` 的任一子条件挖空
 * （refused / 脚本类 / 对象精确匹配 / 结果完成态），至少一条断言会红。
 *
 * 最关键的一条：**正确但陈旧的回复不满足判据**——回复里写对旧值（甚至写对任何值）都
 * 不影响判定，只有重问轮自己的已执行获取才算数（这是「禁止用提高召回准确率的方式实现」
 * 的机械面）。
 */
import { describe, expect, it } from 'vitest';
import {
  auditFact,
  judgeFreshFactFetch,
  rowFetchesFact,
  type FreshFactFetchExpectation,
  type FreshnessTurnEvidence,
} from './freshness-criteria';

const WANT: FreshFactFetchExpectation = { fact: 'alpha', askTurn: 0, requeryTurn: 7, gapTurns: 6 };

/** 一个 8 轮会话的骨架：首问与重问之间 6 轮（中间轮默认零调用）。 */
function turns(overrides: Partial<Record<number, FreshnessTurnEvidence>> = {}): Array<FreshnessTurnEvidence | undefined> {
  const base: Array<FreshnessTurnEvidence | undefined> = Array.from({ length: 8 }, (_unused, index) => ({ index, reply: '', execution: [] }));
  for (const [key, value] of Object.entries(overrides)) base[Number(key)] = value;
  return base;
}

/** 首问轮的真实获取（A1 实测形态：结构化 query，args 平铺）。 */
const ASK: FreshnessTurnEvidence = {
  index: 0,
  reply: 'alpha 当前有 2 条记录：alpha-item-1 = 1200、alpha-item-2 = 800',
  execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0, result: { status: 'completed', collection: 'alpha', count: 2 } }],
};

describe('S3 事实问题必须新取：红绿翻转', () => {
  it('绿：重问轮内存在对事实的已执行获取', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: {
        index: 7,
        reply: '查过了：alpha 当前 1200 / 800',
        execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0, result: { status: 'completed', collection: 'alpha', count: 2 } }],
      },
    }));
    expect(verdict.outcome).toBe('fresh-fetch');
    expect(verdict.fetchRows).toHaveLength(1);
    expect(verdict.askFetched).toBe(true);
  });

  it('红：重问轮零调用——回复即使复述了首问的正确值也不算新取', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: { index: 7, reply: 'alpha 当前 2 条记录：alpha-item-1 = 1200、alpha-item-2 = 800', execution: [] },
    }));
    expect(verdict.outcome).toBe('stale-recall');
    expect(verdict.fetchRows).toHaveLength(0);
    expect(verdict.summary).toContain('该轮零执行调用');
    expect(verdict.summary).toContain('隔 6 轮前的旧值');
  });

  it('红：重问轮只查了别的事实（beta），没碰 alpha', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: {
        index: 7,
        reply: 'beta W1 有 3 条：500 / 300 / 200',
        execution: [{ script: 'dummy.query', args: ['--collection', 'beta', '--window', 'W1'], exitCode: 0 }],
      },
    }));
    expect(verdict.outcome).toBe('stale-recall');
    expect(verdict.otherRows).toHaveLength(1);
    expect(verdict.summary).toContain('没有一次是「alpha」');
  });

  it('红：重问轮对 alpha 的调用被门拒（调到了门、没执行）', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: {
        index: 7,
        reply: 'alpha 是 1200 / 800',
        execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], refused: 'PLAN_REQUIRED' }],
      },
    }));
    expect(verdict.outcome).toBe('stale-recall');
    expect(verdict.unmetRows).toHaveLength(1);
    expect(verdict.summary).toContain('全部未执行');
  });

  it('红：重问轮查了 alpha 但平台答 not_found（没取到结果，不算获取）', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: {
        index: 7,
        reply: '没有找到 alpha 的数据',
        execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0, result: { status: 'not_found', collection: 'alpha' } }],
      },
    }));
    expect(verdict.outcome).toBe('stale-recall');
    expect(verdict.unmetRows).toHaveLength(1);
    expect(verdict.fetchRows).toHaveLength(0);
  });
});

describe('S3 判据的形状口径', () => {
  it('对象名精确匹配：查 alpha-group 不算获取 alpha；查 alpha 才算', () => {
    const group = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: { index: 7, execution: [{ script: 'dummy.query', args: ['--collection', 'alpha-group'], exitCode: 0, result: { status: 'completed', collection: 'alpha-group' } }] },
    }));
    expect(group.outcome).toBe('stale-recall');
    const alpha = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: { index: 7, execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 }] },
    }));
    expect(alpha.outcome).toBe('fresh-fetch');
  });

  it('args 三种形态与 result 规范名都能认出对象：--flag=value / 结构化对象 / 只有 result', () => {
    for (const row of [
      { script: 'dummy.query', args: ['--collection=alpha'], exitCode: 0 },
      { script: 'dummy.query', args: { collection: 'alpha', window: 'W1' }, exitCode: 0 },
      { script: 'dummy.query', exitCode: 0, result: { status: 'completed', collection: 'alpha', count: 2 } },
    ] as const) {
      const verdict = judgeFreshFactFetch(WANT, turns({ 0: ASK, 7: { index: 7, execution: [row] } }));
      expect(verdict.outcome, JSON.stringify(row)).toBe('fresh-fetch');
    }
  });

  it('result.collection 优先于 args：别名检索（args 点名别名）也按规范名判', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: { index: 7, execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0, result: { status: 'completed', collection: 'alpha' } }] },
    }));
    expect(verdict.outcome).toBe('fresh-fetch');
    expect(auditFact({ script: 'dummy.query', args: ['--collection', 'alp'], result: { collection: 'alpha' } })).toEqual({ fact: 'alpha', fromResult: true });
  });

  it('非 query 脚本不算获取（scratch / prepare 都不行）', () => {
    for (const script of ['dummy.scratch', 'dummy.prepare', 'dummy.commit']) {
      expect(rowFetchesFact({ script, args: ['--collection', 'alpha'], exitCode: 0 }, 'alpha')).toBe(false);
    }
    expect(rowFetchesFact({ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 }, 'alpha')).toBe(true);
  });

  it('中间轮获取过该事实：记 gapFetchTurns 证据，但不替代重问轮的新取', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      3: { index: 3, execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 }] },
      7: { index: 7, execution: [] },
    }));
    expect(verdict.outcome).toBe('stale-recall');
    expect(verdict.gapFetchTurns).toEqual([3]);
    expect(verdict.notes.join('\n')).toContain('第4轮获取过「alpha」');
  });

  it('重问轮审计源不可读 / 该轮没跑到 = 不出判定（inconclusive，不判红也不判绿）', () => {
    const missing = judgeFreshFactFetch(WANT, turns({
      0: ASK,
      7: { index: 7, execution: [], auditMissing: true },
    }));
    expect(missing.outcome).toBe('inconclusive');
    // 只有 0..6 轮（重问轮没跑到）：稀疏孔位，不把"没跑"当"零调用"判红。
    const notRun: Array<FreshnessTurnEvidence | undefined> = Array.from({ length: 7 }, (_unused, index) => ({ index, execution: [] }));
    notRun[0] = ASK;
    expect(judgeFreshFactFetch(WANT, notRun).outcome).toBe('inconclusive');
  });

  it('首问轮没获取 = 信息性 note，不改判据结果（判据只看重问轮）', () => {
    const verdict = judgeFreshFactFetch(WANT, turns({
      0: { index: 0, execution: [] },
      7: { index: 7, execution: [{ script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 }] },
    }));
    expect(verdict.outcome).toBe('fresh-fetch');
    expect(verdict.askFetched).toBe(false);
    expect(verdict.notes.join('\n')).toContain('构造前提不完整');
  });
});
