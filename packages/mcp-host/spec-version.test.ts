import { describe, expect, it } from 'vitest';
import {
  checkServerSpecVersion,
  EXPECTED_SPEC_VERSION,
  SpecVersionMismatchError,
} from './src/index';

describe('checkServerSpecVersion(验收 #1 纯函数部分)', () => {
  it('specVersion 0.5 与 0.6 均通过', () => {
    expect(() =>
      checkServerSpecVersion({ name: '17dz-read', version: '0.1.0', specVersion: '0.5', allowedAccountSets: null }),
    ).not.toThrow();
    });
    expect(() => checkServerSpecVersion({ name: '17dz', version: '0.1.0', specVersion: '0.6', allowedAccountSets: null })).not.toThrow();

  it('specVersion 0.4 抛 SpecVersionMismatchError,带中文运维提示', () => {
    try {
      checkServerSpecVersion({ name: '17dz-read', version: '0.1.0', specVersion: '0.4' });
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SpecVersionMismatchError);
      expect((err as Error).message).toContain('specVersion');
      expect((err as SpecVersionMismatchError).actual).toBe('0.4');
      expect((err as SpecVersionMismatchError).expected).toBe('0.6');
    }
  });

  it('serverInfo 缺失 / 无 specVersion / 非字符串 specVersion 都抛错', () => {
    expect(() => checkServerSpecVersion(undefined)).toThrow(SpecVersionMismatchError);
    expect(() => checkServerSpecVersion({})).toThrow(SpecVersionMismatchError);
    expect(() => checkServerSpecVersion({ specVersion: 5 })).toThrow(SpecVersionMismatchError);
  });

  it('当前优先版本为 0.6', () => {
    expect(EXPECTED_SPEC_VERSION).toBe('0.6');
  });
});
