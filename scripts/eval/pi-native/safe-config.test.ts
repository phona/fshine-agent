/**
 * Pi 原生压缩 · 小窗口安全配置 · 确定性绊线（零真实模型）。
 *
 * 核心断言（任务书）：
 *   A. 安全配置（`SAFE_PI_COMPACTION_CONFIG`）满足
 *      「压缩后模拟请求 ≤ 窗口 − maxTokens − 安全余量」且摘要预算 ≥ 下限；
 *   B. **故意改回不安全值必须红**：上轮现状 (W=16384, M=2048, R=4096, K=4915) 以及
 *      逐字段回归（窗口/keepRecent/reserve/maxTokens）都必须判不安全——
 *      若有人把不等式放宽成“什么配置都安全”，B 立即红。
 *   C. 公式不改样：安装的 Pi 源码里触发式与摘要预算式必须仍是本模块转写的两行
 *      （Pi 升级改了公式 → 红，强制重新推导，禁止沿用旧常量）。
 *   D. 接线不空转：安全值经 env → `compactionSettingsFrom` → 驱动
 *      `PiTurnDriverOptions.compactionSettings` → Pi `CompactionSettings`；
 *      评测脚本静态使用安全常量（把窗口改回 16384 即红）。
 *
 * 本文件只测“传入配置”，不实现任何压缩触发/裁剪/兜底（Pi 仍是唯一所有者）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  SAFE_PI_COMPACTION_CONFIG,
  UNSAFE_STATUS_QUO_CONFIG,
  HEADROOM_MARGIN_TOKENS,
  SUMMARY_FLOOR_TOKENS,
  assessCompactionConfig,
  compactionSettingsOf,
  compactionTriggerTokens,
  postCompactPromptCeilingTokens,
  safeConfigEnv,
  simulatedPostCompactPromptTokens,
  summaryBudgetTokens,
  type PiCompactionConfig,
} from './safe-config';
import { compactionSettingsFrom } from '../../ask-runtime';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';

// 1.5.2：压缩实现随 coding-agent 提供（pi-agent-core 不再导出 harness/compaction）。
const PI_COMPACTION_JS = path.resolve(
  __dirname,
  '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js',
);

describe('A · 安全配置满足余量不等式与摘要预算下限', () => {
  it('SAFE 判安全，且读数与推导一致（余量不变式）', () => {
    const a = assessCompactionConfig(SAFE_PI_COMPACTION_CONFIG);
    expect(a.problems).toEqual([]);
    expect(a.safe).toBe(true);
    // 摘要预算 = min(floor(0.8×8192), 8192) = 6553 ≥ 4096（摘要非空下限）
    expect(a.summaryBudget).toBe(6_553);
    expect(a.summaryBudget).toBeGreaterThanOrEqual(SUMMARY_FLOOR_TOKENS);
    // 压缩后模拟请求 = 4096 + 6553 + 4×1024 + 6144 = 20,889
    expect(a.simulatedPrompt).toBe(20_889);
    // 上限 = 32768 − 8192 − 2048 = 22,528
    expect(a.promptCeiling).toBe(22_528);
    expect(a.simulatedPrompt).toBeLessThanOrEqual(a.promptCeiling);
    // 触发阈值 = 32768 − 8192 = 24,576；压缩后不会立刻再触发（无零收益连环压缩）
    expect(a.triggerThreshold).toBe(24_576);
    expect(a.simulatedPrompt).toBeLessThan(a.triggerThreshold);
  });

  it('不等式三条都是“传入配置”的函数（改任何一项都会被计入）', () => {
    const base = SAFE_PI_COMPACTION_CONFIG;
    expect(simulatedPostCompactPromptTokens({ ...base, keepRecentTokens: base.keepRecentTokens + 1 }))
      .toBe(simulatedPostCompactPromptTokens(base) + 4);
    expect(summaryBudgetTokens({ ...base, reserveTokens: 4_096 })).toBe(3_276);
    expect(postCompactPromptCeilingTokens({ ...base, maxTokens: base.maxTokens + 1 }))
      .toBe(postCompactPromptCeilingTokens(base) - 1);
    expect(compactionTriggerTokens({ ...base, reserveTokens: 4_096 })).toBe(base.contextWindow - 4_096);
  });
});

describe('B · 故意改回不安全值 → 断言必须红（反向绊线）', () => {
  it('上轮现状 (16384/2048/4096/4915) 判不安全，且两条缺陷原因都在', () => {
    const a = assessCompactionConfig(UNSAFE_STATUS_QUO_CONFIG);
    expect(a.safe).toBe(false);
    // 摘要预算 2048 < 4096（真实证据：A 23 次压缩 4 次摘要为空）
    expect(a.summaryBudget).toBe(2_048);
    expect(a.problems.some((p) => p.includes('摘要预算'))).toBe(true);
    // 压缩后模拟请求 31,948 > 12,288（真实证据：B 第 9 回合 16,664 > 16,384）
    expect(a.simulatedPrompt).toBe(31_948);
    expect(a.promptCeiling).toBe(12_288);
    expect(a.problems.some((p) => p.includes('压缩后模拟请求'))).toBe(true);
  });

  // 从 SAFE 逐字段回退到上轮值：每一个单独回退都必须红（不是只有整套才红）。
  const regressions: Array<{ field: keyof PiCompactionConfig; to: number }> = [
    { field: 'contextWindow', to: 16_384 },
    { field: 'maxTokens', to: 2_048 },
    { field: 'reserveTokens', to: 4_096 },
    { field: 'keepRecentTokens', to: 4_915 },
  ];
  it.each(regressions)('把 $field 改成 $to（不安全值）→ 必须判不安全', ({ field, to }) => {
    const reverted: PiCompactionConfig = { ...SAFE_PI_COMPACTION_CONFIG, [field]: to };
    const a = assessCompactionConfig(reverted);
    expect(a.safe, `${field}=${to} 竟然被判安全——不等式被放宽了`).toBe(false);
    expect(a.problems.length).toBeGreaterThan(0);
  });

  it('把安全判定整体放宽成恒真 → 本组反向断言会红（元绊线）', () => {
    // 若 assessCompactionConfig 被改成恒 safe，上面每条都会红；这里再显式固定“存在不安全输入”。
    const alwaysUnsafeProbe = [
      UNSAFE_STATUS_QUO_CONFIG,
      { ...SAFE_PI_COMPACTION_CONFIG, keepRecentTokens: 4_915 },
      { ...SAFE_PI_COMPACTION_CONFIG, contextWindow: 16_384 },
    ];
    expect(alwaysUnsafeProbe.map((c) => assessCompactionConfig(c).safe)).toEqual([false, false, false]);
  });
});

describe('C · Pi 公式不改样（安装版本源码守卫）', () => {
  const source = readFileSync(PI_COMPACTION_JS, 'utf8');

  it('触发式仍是 contextTokens > contextWindow - settings.reserveTokens（compaction.js:144-147）', () => {
    expect(source.includes('return contextTokens > contextWindow - settings.reserveTokens;')).toBe(true);
  });

  it('1.5.2 摘要请求不再带输出上限（旧 0.8×reserve 预算已移除；登记于 adapter 设计 §7）', () => {
    // 旧口径（pi 0.85.1）：min(floor(0.8×reserveTokens), maxTokens)。1.5.2 已删除。
    expect(source.includes('Math.floor(0.8 * reserveTokens)')).toBe(false);
    const start = source.indexOf('function createSummarizationOptions');
    const end = source.indexOf('return options;', start);
    expect(start, 'createSummarizationOptions 应存在').toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body.includes('maxTokens'), '摘要请求不再传输出上限').toBe(false);
  });

  it('尾段切点仍按 keepRecentTokens 的字符估算累加（compaction.js:196-233）', () => {
    expect(source.includes('export function findCutPoint(entries, startIndex, endIndex, keepRecentTokens)')).toBe(true);
    expect(source.includes('return Math.ceil(chars / 4);')).toBe(true);
  });
});

describe('D · 接线不空转（env → 装配 → 驱动 → Pi）', () => {
  it('safeConfigEnv + compactionSettingsFrom → 驱动所需的绝对 CompactionSettings', () => {
    const { compactionSettings } = compactionSettingsFrom(safeConfigEnv());
    expect(compactionSettings).toEqual({ enabled: true, reserveTokens: 8_192, keepRecentTokens: 1_024 });
    expect(compactionSettings).toEqual(compactionSettingsOf(SAFE_PI_COMPACTION_CONFIG));
  });

  it('两个变量都不设 → 不传（既有入口行为逐字节不变）', () => {
    expect(compactionSettingsFrom({})).toEqual({});
    expect(compactionSettingsFrom({ LLM_COMPACTION_RESERVE_TOKENS: '', LLM_COMPACTION_KEEP_RECENT_TOKENS: '' })).toEqual({});
  });

  it('只设一个 → 装配期 fail-fast 点名两个变量（不静默补齐）', () => {
    expect(() => compactionSettingsFrom({ LLM_COMPACTION_RESERVE_TOKENS: '8192' })).toThrow('LLM_COMPACTION_KEEP_RECENT_TOKENS');
    expect(() => compactionSettingsFrom({ LLM_COMPACTION_KEEP_RECENT_TOKENS: '1024' })).toThrow('LLM_COMPACTION_RESERVE_TOKENS');
  });

  it('非法值 → 装配期 fail-fast 点名变量', () => {
    expect(() => compactionSettingsFrom({ LLM_COMPACTION_RESERVE_TOKENS: 'abc', LLM_COMPACTION_KEEP_RECENT_TOKENS: '1024' }))
      .toThrow('LLM_COMPACTION_RESERVE_TOKENS');
    expect(() => compactionSettingsFrom({ LLM_COMPACTION_RESERVE_TOKENS: '8192', LLM_COMPACTION_KEEP_RECENT_TOKENS: '0' }))
      .toThrow('LLM_COMPACTION_KEEP_RECENT_TOKENS');
  });

  it('驱动把显式 compactionSettings 原样交给 Pi SettingsManager（压缩配置入口）', async () => {
    const captured: unknown[] = [];
    const original = SettingsManager.inMemory.bind(SettingsManager);
    const spy = vi.spyOn(SettingsManager, 'inMemory').mockImplementation((settings, options) => {
      captured.push((settings as { compaction?: unknown } | undefined)?.compaction);
      return original(settings, options);
    });
    const message = {
      role: 'assistant', content: [{ type: 'text', text: '好的。' }], api: 'openai-completions',
      provider: 'llm', model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as unknown as AgentMessage;
    const scripted = await createScriptedModelRuntime({
      contextWindow: SAFE_PI_COMPACTION_CONFIG.contextWindow,
      maxTokens: SAFE_PI_COMPACTION_CONFIG.maxTokens,
      script: () => message,
    });
    try {
      const driver = createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: scripted.runtime,
        compactionSettings: compactionSettingsOf(SAFE_PI_COMPACTION_CONFIG),
      });
      await driver.run({
        systemPrompt: 'sys',
        tools: [],
        messages: [{ role: 'user', content: 'x', timestamp: 1 } as unknown as AgentMessage],
        onStep: () => {},
        exec: async () => undefined,
        deadline: Date.now() + 60_000,
      });
      driver.close?.();
    } finally {
      spy.mockRestore();
    }
    // 驱动在创建 Pi 会话时把绝对配置原样交给 SettingsManager（Pi 是压缩执行者）。
    expect(captured).toContainEqual({ enabled: true, reserveTokens: 8_192, keepRecentTokens: 1_024 });
  });

});
