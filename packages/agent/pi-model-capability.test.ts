/**
 * T4 · 模型能力读取 + Pi 压缩配置适配（架构调整相位 1）。
 *
 * 断言：
 *   · pi-driver 的 contextWindow 从模型能力读，未提供时缺省值不变（128_000）；
 *   · `piCompactionSettings` 是纯配置适配（Pi 配置，非压缩机制）：窗口装得下 Pi 缺省就
 *     沿用缺省；小窗口按比例缩放，使 Pi 原生阈值不越窗口本身（8192 下不缩放 Pi 会自压）。
 */
import { describe, expect, it } from 'vitest';
import { createPiModelRuntime, piCompactionSettings } from './src/pi-driver';

const ENV = { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'model-capability-key', LLM_MODEL: 'step-3.7-flash' };
/** 今天的硬编码值：未提供能力时必须还是它。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

describe('T4 压缩阈值读模型能力', () => {
  it('不给能力：contextWindow 缺省不变（128_000）', () => {
    expect(createPiModelRuntime(ENV, 'step-3.7-flash').model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('给能力：模型的 contextWindow 从能力读', () => {
    expect(createPiModelRuntime(ENV, 'step-3.7-flash', { contextWindow: 40_000 }).model.contextWindow).toBe(40_000);
  });

  it('大窗口沿用 Pi 缺省压缩设置（纯配置，不发明阈值）', () => {
    expect(piCompactionSettings(128_000)).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
    expect(piCompactionSettings(200_000)).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
  });
});

describe('T4b Pi 压缩配置适配（窗口缩放，非压缩机制）', () => {
  it('小窗口按比例缩放：reserve/keepRecent 都不越窗口', () => {
    const settings = piCompactionSettings(8_192);
    expect(settings.enabled).toBe(true);
    expect(settings.reserveTokens).toBeLessThan(8_192);
    expect(settings.keepRecentTokens).toBeLessThan(8_192);
    // 阈值 = W − reserve 仍为正、装得下（不越窗口本身）。
    expect(8_192 - settings.reserveTokens).toBeGreaterThan(0);
  });

  it('缩放是纯函数且单调安全：任意有限窗口 reserve/keepRecent 均为正有限整数', () => {
    for (const window of [2_000, 8_192, 40_000, 128_000]) {
      const settings = piCompactionSettings(window);
      expect(Number.isFinite(settings.reserveTokens)).toBe(true);
      expect(Number.isFinite(settings.keepRecentTokens)).toBe(true);
      expect(settings.reserveTokens).toBeGreaterThan(0);
      expect(settings.keepRecentTokens).toBeGreaterThan(0);
    }
  });
});
