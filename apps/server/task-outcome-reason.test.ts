/**
 * F3-1 反向绊线：失败唤醒出口的 blocked 判据**只认结构化原因码**，不扫 reason 文本。
 *
 * 旧实现用 `reason.includes('权限') || reason.includes('不允许')` 判 permission_denied：
 * 执行层如实回报「对象 X 的权限字段校验失败」（业务失败，非允许集合拒绝）也会命中，
 * 被误判成 blocked。本文件的核心用例钉死：reason 里出现「权限」但原因码不是 not_permitted
 * → 不得判 blocked。该用例在旧实现上必红（见文末反向验证说明）。
 */
import { describe, expect, it } from 'vitest';
import { classifyFailureOutcome, isZeroExecutionPermissionDenied } from './task-outcome-reason';

describe('F3-1 blocked 判据只用结构化原因码（不扫文案）', () => {
  it('① reason 文本含「权限」但原因码不是 not_permitted → 不得判 blocked（旧实现会判错）', () => {
    // 零执行；reason 文本里带着「权限」二字，但结构化原因码是另一个业务码。
    const input = {
      terminal: 'failed' as const,
      reasonText: '对象 X 的权限字段校验失败，本次业务办理未完成',
      reasonCode: 'PERMISSION_FIELD_CHECK_FAILED', // 不是 not_permitted
      ledgerReasonCode: 'failed_confirmed',
    };
    expect(isZeroExecutionPermissionDenied(input)).toBe(false);
    // 零执行 + 非权限拒绝码 + 非权限底账码 → unsupported（绝不是 blocked）。
    expect(classifyFailureOutcome([], input)).toBe('unsupported');
  });

  it('② reason 文本含「不允许」但原因码不是 not_permitted → 不得判 blocked', () => {
    const input = {
      terminal: 'failed' as const,
      reasonText: '集合当前不允许写入（业务锁），不是允许集合拒绝',
      reasonCode: 'COLLECTION_LOCKED', // 执行层锁集合拒绝，不是允许集合拒绝
    };
    expect(isZeroExecutionPermissionDenied(input)).toBe(false);
    expect(classifyFailureOutcome([], input)).toBe('unsupported');
  });

  it('③ 原因码是 not_permitted → 零执行判 blocked（正向，不放宽断言）', () => {
    const input = {
      terminal: 'failed' as const,
      reasonCode: 'not_permitted',
    };
    expect(isZeroExecutionPermissionDenied(input)).toBe(true);
    expect(classifyFailureOutcome([], input)).toBe('blocked');
  });

  it('④ 有执行事实时不受零执行原因码影响，终态 failed 仍判 failed', () => {
    const input = { terminal: 'failed' as const, reasonCode: 'not_permitted' };
    expect(classifyFailureOutcome([{ status: 'failed', error: { code: 'FAULT' } }], input)).toBe('failed');
  });
});

/**
 * 反向验证（本轮亲自执行过，原始读数）：把 `isZeroExecutionPermissionDenied` 临时改回旧
 * 文本判据 `return /权限|不允许/.test(input.reasonText ?? '')`，运行
 * `npx vitest run apps/server/task-outcome-reason.test.ts` →
 *   `Test Files 1 failed (1)` / `Tests 3 failed | 1 passed (4)`：
 *   用例 ①②（reason 含「权限/不允许」但码非 not_permitted，被旧实现误判 blocked）与
 *   用例 ③（码是 not_permitted，旧实现因无文本而误判非 blocked）全红。
 * 恢复结构化判据后 → `Tests 4 passed (4)`。绊线有效，断言未放宽。
 */
