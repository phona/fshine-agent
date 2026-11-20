/**
 * 答复五态机械分类器：表驱动单测（判据档 §3 / 本切片 B1·G3）。
 *
 * 断言口径：五值 + 三条边界必须逐值命中；任一行改判即红（表驱动，不筛绿）。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  renderOutcomeFact,
  UNSUPPORTED_FACT_FORBIDDEN_WORDS,
  OUTCOME_DETAIL_UNSUPPORTED,
  OUTCOME_DETAIL_NOT_PERMITTED,
  OUTCOME_REASON_NOT_PERMITTED,
  OUTCOME_REASON_UNSUPPORTED,
  type OutcomeLedger,
  type TaskOutcome,
} from './src/task-outcome';

type Row = { name: string } & OutcomeLedger & { expect: TaskOutcome };

/** 一行 = 一个底账形状 + 期望五值。 */
const TABLE: readonly Row[] = [
  // —— completed ——
  {
    name: '全部项成功（单条 completed，无 items = 正常完成）',
    executions: [{ status: 'completed' }],
    terminal: 'completed',
    expect: 'completed',
  },
  {
    name: 'completed 且 items 全部 ok = completed',
    executions: [{ status: 'completed', items: [{ status: 'ok' }, { status: 'ok' }] }],
    terminal: 'completed',
    expect: 'completed',
  },
  // —— partial ——
  {
    name: 'completed 且 items 有 failed = partial',
    executions: [{ status: 'completed', items: [{ status: 'ok' }, { status: 'failed' }] }],
    terminal: 'completed',
    expect: 'partial',
  },
  {
    name: 'completed 且 items 有 unknown = partial',
    executions: [{ status: 'completed', items: [{ status: 'unknown' }] }],
    terminal: 'completed',
    expect: 'partial',
  },
  // —— unsupported ——
  {
    name: '零执行、无权限拒绝、无等待 = unsupported',
    executions: [],
    terminal: 'unexecuted',
    expect: 'unsupported',
  },
  {
    name: '零执行、终态 failed 但原因码非拒绝 = unsupported（目录里没这件事）',
    executions: [],
    terminal: 'failed',
    reasonCode: 'failed_confirmed',
    expect: 'unsupported',
  },
  // —— blocked ——
  {
    name: '零执行 + 权限拒绝 = blocked（不是 unsupported）',
    executions: [],
    terminal: 'failed',
    zeroReason: 'permission_denied',
    expect: 'blocked',
  },
  {
    name: '零执行 + 拒绝原因码 = blocked',
    executions: [],
    terminal: 'failed',
    reasonCode: 'GATE_REFUSE',
    expect: 'blocked',
  },
  {
    name: '零执行 + 用户没答 = blocked',
    executions: [],
    terminal: 'waiting_user',
    zeroReason: 'awaiting_user',
    expect: 'blocked',
  },
  {
    name: '有执行但卡在 needs_input = blocked',
    executions: [{ status: 'needs_input' }],
    terminal: 'waiting_user',
    expect: 'blocked',
  },
  // —— failed ——
  {
    name: '执行发生过且终态 failed = failed',
    executions: [{ status: 'failed', error: { code: 'FAULT' } }],
    terminal: 'failed',
    expect: 'failed',
  },
  {
    name: '结果未知（无回执） = failed',
    executions: [{ status: 'result_unknown' }],
    terminal: 'failed',
    reasonCode: 'result_unknown',
    expect: 'failed',
  },
  // —— 三条边界 ——
  {
    name: '【边界】先失败后成功 → completed（末条决定性结果）',
    executions: [
      { status: 'failed', error: { code: 'PARAM_WRONG' } },
      { status: 'completed' },
    ],
    terminal: 'completed',
    expect: 'completed',
  },
  {
    name: '【边界】零执行 + 权限拒绝 → blocked，不是 unsupported',
    executions: [],
    terminal: 'unexecuted',
    zeroReason: 'permission_denied',
    expect: 'blocked',
  },
  {
    name: '【边界】零执行 + 用户没答 → blocked',
    executions: [],
    terminal: 'unexecuted',
    zeroReason: 'awaiting_user',
    expect: 'blocked',
  },
];

describe('答复五态机械分类器（表驱动）', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const ledger: OutcomeLedger = {
        executions: row.executions,
        terminal: row.terminal,
        ...(row.zeroReason === undefined ? {} : { zeroReason: row.zeroReason }),
        ...(row.reasonCode === undefined ? {} : { reasonCode: row.reasonCode }),
      };
      expect(classifyOutcome(ledger)).toBe(row.expect);
    });
  }

  it('五值全部可达（覆盖性：五值表驱动，不筛绿）', () => {
    const reached = new Set(TABLE.map((row) => classifyOutcome({
      executions: row.executions,
      terminal: row.terminal,
      ...(row.zeroReason === undefined ? {} : { zeroReason: row.zeroReason }),
      ...(row.reasonCode === undefined ? {} : { reasonCode: row.reasonCode }),
    })));
    expect([...reached].sort()).toEqual(['blocked', 'completed', 'failed', 'partial', 'unsupported']);
  });
});

describe('B2 outcome 结构化事实 + B3 原因码拆分', () => {
  it('① unsupported 事实文本不含 再试/重试/retry 字样（G4）', () => {
    const fact = renderOutcomeFact('unsupported') + OUTCOME_DETAIL_UNSUPPORTED;
    for (const word of UNSUPPORTED_FACT_FORBIDDEN_WORDS) expect(fact).not.toContain(word);
    expect(fact).toContain('[outcome=unsupported]');
  });

  it('② blocked 事实必须带非空缺失条件字段', () => {
    const withMissing = renderOutcomeFact('blocked', { missing: '本次不允许写入' });
    expect(withMissing).toContain('[outcome=blocked]');
    expect(withMissing).toMatch(/\[缺=\S[^\]]*\]/);
    // 缺省也不能留空。
    const fallback = renderOutcomeFact('blocked');
    expect(fallback).toMatch(/\[缺=\S[^\]]*\]/);
  });

  it('③ 「没有能力」与「本次不允许」两个原因可辨（B3）', () => {
    expect(OUTCOME_DETAIL_UNSUPPORTED).toContain('没有对应能力');
    expect(OUTCOME_DETAIL_NOT_PERMITTED).toContain('本次不允许');
    expect(OUTCOME_DETAIL_UNSUPPORTED).not.toBe(OUTCOME_DETAIL_NOT_PERMITTED);
  });

  it('④ B3 两个原因码真正接上分类器：not_permitted→blocked，unsupported→unsupported（零执行）', () => {
    expect(OUTCOME_REASON_NOT_PERMITTED).toBe('not_permitted');
    expect(OUTCOME_REASON_UNSUPPORTED).toBe('unsupported');
    expect(classifyOutcome({ executions: [], terminal: 'failed', outcomeReasonCode: OUTCOME_REASON_NOT_PERMITTED })).toBe('blocked');
    expect(classifyOutcome({ executions: [], terminal: 'unexecuted', outcomeReasonCode: OUTCOME_REASON_UNSUPPORTED })).toBe('unsupported');
    // 结构化码优先于 zeroReason（防止文案/旧码覆盖新码）。
    expect(classifyOutcome({
      executions: [], terminal: 'failed',
      outcomeReasonCode: OUTCOME_REASON_UNSUPPORTED, zeroReason: 'permission_denied',
    })).toBe('unsupported');
  });
});
