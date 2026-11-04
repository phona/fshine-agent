import { describe, expect, it } from 'vitest';
import { ALLOW_REAL_ENV, runtimeModeOf } from './runtime-mode';

/**
 * 启动模式日志的判据（2026-10-21 事故补丁）：mock/real 判定与业务代码同一把尺
 * （isPlatformMock，只认字面量 'mock'）；两道授权门只认字面量 '1'。
 */
describe('runtimeModeOf', () => {
  it('mock：EXECUTION_EXECUTOR=mock → executor=mock，授权闸无意义', () => {
    const m = runtimeModeOf({ EXECUTION_EXECUTOR: 'mock' });
    expect(m.executor).toBe('mock');
    expect(m.executorRaw).toBe('mock');
    expect(m.realExecutionAllowed).toBe(false);
    expect(m.realCommitAuthorized).toBe(false);
    expect(m.note).toContain('mock 应答器');
  });

  it('真平台已授权（2026-10-21 生产形态）：空执行器 + EXECUTION_ALLOW_REAL=1 → real 且放行', () => {
    const m = runtimeModeOf({ EXECUTION_EXECUTOR: '', [ALLOW_REAL_ENV]: '1' });
    expect(m.executor).toBe('real');
    expect(m.executorRaw).toBe('');
    expect(m.realExecutionAllowed).toBe(true);
    expect(m.realCommitAuthorized).toBe(false);
    expect(m.note).toContain('触平台执行已授权');
    expect(m.note).toContain('confirm_held');                       // 写未授权的后果说清
  });

  it('真平台未授权：什么都没设 → real 且执行将被门拒绝（fail-closed 的可见形态）', () => {
    const m = runtimeModeOf({});
    expect(m.executor).toBe('real');
    expect(m.executorRaw).toBe('');
    expect(m.realExecutionAllowed).toBe(false);
    expect(m.note).toContain('REAL_EXECUTION_NOT_ALLOWED');
  });

  it('授权门只认字面量 1：true/yes/0/空值一律不算授权', () => {
    for (const raw of ['true', 'yes', '0', '', ' 1', '1 ']) {
      expect(runtimeModeOf({ [ALLOW_REAL_ENV]: raw }).realExecutionAllowed, raw).toBe(false);
    }
    expect(runtimeModeOf({ [ALLOW_REAL_ENV]: '1' }).realExecutionAllowed).toBe(true);
  });

  it('执行器判定只认字面量 mock：怪值（大小写/空格）落到 real 且原值露出', () => {
    const m = runtimeModeOf({ EXECUTION_EXECUTOR: 'Mock' });
    expect(m.executor).toBe('real');
    expect(m.executorRaw).toBe('Mock');                              // 诊断用：怪值原样可见
    expect(runtimeModeOf({ EXECUTION_EXECUTOR: ' mock' }).executor).toBe('real');
  });

  it('写授权：FSHINE_REAL_COMMIT=1 才算；空/未设不算', () => {
    expect(runtimeModeOf({ FSHINE_REAL_COMMIT: '1' }).realCommitAuthorized).toBe(true);
    expect(runtimeModeOf({ FSHINE_REAL_COMMIT: '' }).realCommitAuthorized).toBe(false);
    expect(runtimeModeOf({}).realCommitAuthorized).toBe(false);
    expect(runtimeModeOf({ FSHINE_REAL_COMMIT: 'true' }).realCommitAuthorized).toBe(false);
  });

  it('全开形态：real + 双授权 → note 说明执行与写落账都已授权', () => {
    const m = runtimeModeOf({ EXECUTION_EXECUTOR: '', [ALLOW_REAL_ENV]: '1', FSHINE_REAL_COMMIT: '1' });
    expect(m.realExecutionAllowed).toBe(true);
    expect(m.realCommitAuthorized).toBe(true);
    expect(m.note).toContain('写落账已授权');
  });
});
