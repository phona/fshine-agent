/**
 * 失败投递的「末次决定性失败码」（2026-11-21 独立审查 major 修复的守卫；2026-11-22 Grok 复审
 * 恢复被 S1 误删的回溯语义）。
 *
 * 事故形状：同一任务先被 CONFIRMATION_REQUIRED 拒、后来才出现真正的失败码；旧实现用
 * `.find` 取**第一条**失败码，把分类引到「等确认 / 我方故障（话术带重试）」，与任务实际
 * 终局相反，用户被引导重试。修法与 execution-runtime 的 P0「末次决定性结果」同口径：
 * 倒序取最后一条 **带非空 code** 的 failed/refused——末条无码时继续往前找（不停在无码行）。
 */
import { describe, expect, it } from 'vitest';
import { lastDecisiveFailureCode } from './server';

describe('lastDecisiveFailureCode：倒序取最后一条 failed/refused 的非空 error.code', () => {
  it('先 CONFIRMATION_REQUIRED 拒、后 EXECUTOR_FAILED：取后者（不是首条）', () => {
    expect(lastDecisiveFailureCode([
      { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED' } },
      { status: 'failed', error: { code: 'EXECUTOR_FAILED' } },
    ])).toBe('EXECUTOR_FAILED');
  });

  it('成功之后的失败：取最后那条失败（先成功后失败 = 末次决定性）', () => {
    expect(lastDecisiveFailureCode([
      { status: 'completed' },
      { status: 'failed', error: { code: 'COLLECTION_FAULT' } },
    ])).toBe('COLLECTION_FAULT');
  });

  it('跳过没有 error.code 的行与完成行；无失败行 = undefined', () => {
    expect(lastDecisiveFailureCode([
      { status: 'completed' },
      { status: 'failed' },
      { status: 'refused', error: { code: '' } },
    ])).toBeUndefined();
  });

  it('末条 failed/refused 无码：继续往前找真实码（不停在无码行）', () => {
    expect(lastDecisiveFailureCode([
      { status: 'refused', error: { code: 'GATE_REFUSE' } },
      { status: 'failed' },
    ])).toBe('GATE_REFUSE');
  });
});
