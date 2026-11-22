/**
 * B4 结构化答复值分类（Grok 复审 2026-11-22 恢复）。
 *
 * 事故形状：server 的 failureOutcome 用 `ledgerFacts.length === 0` 判「零执行 = unsupported」，
 * 但 taskLedgerFactsOf 零执行也推一条说明行（长度恒 ≥1），该分支永远到不了 → 零执行被判
 * outcome=failed（用户被告知「没办成/可重试」，而实际是「这件事根本没法办」）。
 * 修法：零执行看**真实执行行**（hasExecutions），不看账本事实行数。
 */
import { describe, expect, it } from 'vitest';
import { taskFailureOutcomeOf } from './server';

describe('taskFailureOutcomeOf：原因码 > 零执行 > 执行失败', () => {
  it('零执行且无结构化码 → unsupported（办不了；不走「执行发生过且失败」）', () => {
    expect(taskFailureOutcomeOf({ resultUnknown: false, hasExecutions: false })).toBe('unsupported');
  });

  it('有真实执行行且失败 → failed（不因账本事实行存在而误判 unsupported）', () => {
    expect(taskFailureOutcomeOf({ resultUnknown: false, hasExecutions: true })).toBe('failed');
  });

  it('结构化码优先：not_permitted → blocked、unsupported → unsupported（不受 hasExecutions 影响）', () => {
    expect(taskFailureOutcomeOf({ reasonCode: 'not_permitted', resultUnknown: false, hasExecutions: false })).toBe('blocked');
    expect(taskFailureOutcomeOf({ reasonCode: 'unsupported', resultUnknown: false, hasExecutions: true })).toBe('unsupported');
  });

  it('结果未知（died）不因零执行降级为 unsupported → failed', () => {
    expect(taskFailureOutcomeOf({ resultUnknown: true, hasExecutions: false })).toBe('failed');
  });
});
