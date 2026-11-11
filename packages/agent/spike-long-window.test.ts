/**
 * SPIKE-ONLY 长窗旋钮的表征锁（spike-long-window.ts）：
 *   · 三个环境变量未设置时，contextWindow 必须仍是接线前的 128_000，TTL 覆盖必须是
 *     undefined，transcript 装配开关必须是关闭——缺省行为不许变。
 *   · 设置后按值生效；非法值 fail-closed 抛错，不静默落回缺省。
 *
 * 这是 spike 分支的临时测试，随旋钮一起删除（最长保留到 2026-12-31）。
 */
import { describe, expect, it } from 'vitest';
import { createPiModelRuntime } from './src/pi-driver';
import {
  SPIKE_CONTEXT_WINDOW_ENV,
  SPIKE_DEFAULT_CONTEXT_WINDOW,
  SPIKE_SESSION_TTL_MS_ENV,
  SPIKE_TRANSCRIPT_MODE_ENV,
  isSpikeTranscriptModeEnabled,
  spikeContextWindow,
  spikeSessionTtlMs,
} from './src/spike-long-window';

const BASE_ENV = { LLM_API_BASE_URL: 'https://example.invalid/v1', LLM_API_KEY: 'test-key' };

describe('SPIKE 长窗旋钮：缺省行为不变', () => {
  it('contextWindow 缺省仍是 128_000（旋钮未设置时与接线前一致）', () => {
    expect(SPIKE_DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    expect(spikeContextWindow({})).toBe(128_000);
    expect(createPiModelRuntime(BASE_ENV, 'test-model').model.contextWindow).toBe(128_000);
  });

  it('sessionTtlMs 缺省不覆盖（调用方仍走 config/DEFAULT 回落）', () => {
    expect(spikeSessionTtlMs({})).toBeUndefined();
  });

  it('transcript 装配开关缺省关闭', () => {
    expect(isSpikeTranscriptModeEnabled({})).toBe(false);
    expect(isSpikeTranscriptModeEnabled({ [SPIKE_TRANSCRIPT_MODE_ENV]: '' })).toBe(false);
    expect(isSpikeTranscriptModeEnabled({ [SPIKE_TRANSCRIPT_MODE_ENV]: '0' })).toBe(false);
    expect(isSpikeTranscriptModeEnabled({ [SPIKE_TRANSCRIPT_MODE_ENV]: 'false' })).toBe(false);
  });
});

describe('SPIKE 长窗旋钮：设置后按值生效', () => {
  it('contextWindow 可由环境变量设为 40_000', () => {
    const env = { ...BASE_ENV, [SPIKE_CONTEXT_WINDOW_ENV]: '40000' };
    expect(spikeContextWindow(env)).toBe(40_000);
    expect(createPiModelRuntime(env, 'test-model').model.contextWindow).toBe(40_000);
  });

  it('sessionTtlMs 可由环境变量覆盖', () => {
    expect(spikeSessionTtlMs({ [SPIKE_SESSION_TTL_MS_ENV]: '45000' })).toBe(45_000);
  });

  it('transcript 装配开关接受 1/true（大小写与空白不敏感）', () => {
    expect(isSpikeTranscriptModeEnabled({ [SPIKE_TRANSCRIPT_MODE_ENV]: '1' })).toBe(true);
    expect(isSpikeTranscriptModeEnabled({ [SPIKE_TRANSCRIPT_MODE_ENV]: ' TRUE ' })).toBe(true);
  });
});

describe('SPIKE 长窗旋钮：非法值 fail-closed', () => {
  it.each(['0', '-1', '1.5', 'abc'])('contextWindow=%s 抛错，不静默回落', (value) => {
    expect(() => spikeContextWindow({ [SPIKE_CONTEXT_WINDOW_ENV]: value })).toThrow(SPIKE_CONTEXT_WINDOW_ENV);
  });

  it.each(['0', '-1', '1.5', 'abc'])('sessionTtlMs=%s 抛错，不静默回落', (value) => {
    expect(() => spikeSessionTtlMs({ [SPIKE_SESSION_TTL_MS_ENV]: value })).toThrow(SPIKE_SESSION_TTL_MS_ENV);
  });
});
