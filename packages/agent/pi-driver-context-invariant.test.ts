/**
 * P0-B 长会话输出与压缩错序：上下文不变式（先证后码的机械判据）。
 *
 * 不变式 INV：每次请求 W − (T + Δ_worst) ≥ MIN_OUTPUT（W=声明窗口，T=转录估算，
 * Δ_worst=4096+sys+tools，MIN_OUTPUT=1024）。对应三条保证的判据（全部假件，零网络）：
 *   ① 压缩阈值随最坏差值缩放：reserveTokens ≥ fixedOverhead + 1024（默认臂与缩放臂都成立）；
 *   ② 压缩后仍有输出预算：摘要请求有界已有 T7 测试（compaction-window.test.ts）覆盖，
 *      此处不重复；
 *   ③ 窗口过小明确拒绝：装配期 window < 6656 抛错拒绝能力声明；运行期 no_cut 且超
 *      LIMIT（W − Δ − 1024）时抛错有界失败、**一次模型请求都不发**（区别于 thinking-only
 *      空回复——那是模型行为，靠收尾催问解决，两形态分别验证）。
 * 回归：fixedOverhead 缺省（0）时 compactionSettingsFor 与旧行为逐字段一致。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import {
  compactionSettingsFor,
  compactTranscriptWithPi,
  createPiTurnDriver,
  fixedRequestOverheadTokens,
  CONTEXT_WINDOW_FLOOR_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  MIN_OUTPUT_BUDGET_TOKENS,
  CONTEXT_REQUEST_FRAMING_TOKENS,
  invariantReserveTokens,
  invariantLimitTokens,
  type PiModelRuntime,
} from './src/pi-driver';

describe('P0-B ① 压缩阈值按最坏差值缩放', () => {
  it('回归：fixedOverhead 缺省时与旧行为逐字段一致', () => {
    expect(compactionSettingsFor(DEFAULT_CONTEXT_WINDOW)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    expect(compactionSettingsFor(40_000)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    expect(compactionSettingsFor(8_000)).toEqual({
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 2_400,
    });
  });

  it('默认臂：大固定开销时 reserve ≥ Δ_worst + MIN_OUTPUT', () => {
    const overhead = CONTEXT_REQUEST_FRAMING_TOKENS + 20_000; // sys+tools 很大的工具面
    const settings = compactionSettingsFor(DEFAULT_CONTEXT_WINDOW, overhead);
    expect(settings.reserveTokens).toBeGreaterThanOrEqual(overhead + MIN_OUTPUT_BUDGET_TOKENS);
    expect(settings.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  });

  it('缩放臂：小窗口下 reserve 仍不低于不变式下界', () => {
    const overhead = CONTEXT_REQUEST_FRAMING_TOKENS + 2_000;
    const settings = compactionSettingsFor(8_000, overhead);
    expect(settings.reserveTokens).toBeGreaterThanOrEqual(overhead + MIN_OUTPUT_BUDGET_TOKENS);
    expect(settings.keepRecentTokens).toBeGreaterThanOrEqual(512);
  });
});

describe('P0-B Δ_worst 估算', () => {
  it('fixedRequestOverheadTokens ≥ 4096 且随 sys/tools 增长', () => {
    const small = fixedRequestOverheadTokens('你是助手。', []);
    expect(small).toBeGreaterThanOrEqual(CONTEXT_REQUEST_FRAMING_TOKENS);
    const bigger = fixedRequestOverheadTokens(`${'你是助手。'.repeat(400)}`, [
      { name: 'task_status', description: '查询任务状态', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
    ]);
    expect(bigger).toBeGreaterThan(small);
  });
});

function invariantRuntime(contextWindow: number, opts: { failingSummary?: boolean } = {}): { runtime: PiModelRuntime; calls: () => number } {
  let calls = 0;
  const runtime: PiModelRuntime = {
    model: {
      id: 'step-3.7-flash',
      name: 'step-3.7-flash',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 4_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      streamSimple: async () => {
        calls += 1;
        throw new Error('（测试）不变式违反时不得发起任何模型请求');
      },
      completeSimple: async () => {
        if (opts.failingSummary) {
          return {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'maximum context length exceeded: 30000 + 4000 > 20000',
            timestamp: Date.now(),
          } as unknown as AgentMessage;
        }
        return {
          role: 'assistant',
          content: [{ type: 'text', text: '【夹具摘要】' }],
          stopReason: 'stop',
          timestamp: Date.now(),
        } as unknown as AgentMessage;
      },
    } as unknown as MutableModels,
  };
  return { runtime, calls: () => calls };
}

function userMessage(chars: number): AgentMessage {
  return { role: 'user', content: `请处理：${'x'.repeat(chars)}`, timestamp: 1 } as unknown as AgentMessage;
}

/** 单条 ≈5.9k token 的当前回合消息：W=20_000、Δ=13_096 时超阈值(5_880)、no_cut、且超 LIMIT。 */
const noCutOverLimit: AgentMessage[] = [userMessage(23_600)];

describe('P0-B ③ 窗口过小 / 不变式无解时明确拒绝', () => {
  it('compactTranscriptWithPi：no_cut 且超 LIMIT → 抛错（有界失败），不伪造压缩', async () => {
    // W=20_000、Δ=13_096 → reserve=14_120、阈值=5_880=LIMIT；单条 ~5.9k token 当前回合
    // 消息超阈值、装得进 keepRecent(6_000) → prefix 空（no_cut）且 est>LIMIT → 拒绝。
    const { runtime } = invariantRuntime(20_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        compactTranscriptWithPi(noCutOverLimit, { fixedOverheadTokens: 13_096 }, runtime),
      ).rejects.toThrow('上下文不变式不满足');
      expect(error.mock.calls.some((call) => String(call[0]).includes('context_invariant_violated'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it('compactTranscriptWithPi：未超阈值 → 原样返回（旧行为不变）', async () => {
    const { runtime } = invariantRuntime(20_000);
    const small: AgentMessage[] = [userMessage(200)];
    const output = await compactTranscriptWithPi(small, undefined, runtime);
    expect(output).toBe(small);
  });

  it('装配期：window < 下界 → createPiTurnDriver 拒绝能力声明', () => {
    const { runtime } = invariantRuntime(CONTEXT_WINDOW_FLOOR_TOKENS - 1);
    expect(() => createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime }))
      .toThrow('低于装配期下界');
    const ok = invariantRuntime(CONTEXT_WINDOW_FLOOR_TOKENS);
    expect(() => createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime: ok.runtime })).not.toThrow();
  });

  it('运行期（故障形态二：不变式违反 ≠ thinking-only）：压缩救不回时一次请求都不发，空文本有界失败', async () => {
    // 单条 30k token 当前回合消息 + 摘要必败（超窗 error）：force 压缩 → 摘要失败 →
    // degrade 对单条消息无能为力 → 仍超 LIMIT → run() 请求前把关拒绝。
    const { runtime, calls } = invariantRuntime(20_000, { failingSummary: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const driver = createPiTurnDriver({ env: { LLM_MODEL: 'step-3.7-flash' }, runtime });
      const result = await driver.run({
        systemPrompt: '你是助手。',
        tools: [],
        messages: [userMessage(120_000)],
        onStep: () => {},
        exec: async () => undefined,
        deadline: Date.now() + 30_000,
      });
      expect(calls(), 'INV 无解时不得把必然失败的请求发给模型').toBe(0);
      expect(result.text).toBe('');
      expect(error.mock.calls.some((call) => String(call[0]).includes('pi_driver_context_invariant_rejected'))).toBe(true);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

/**
 * D3 单源合一（先证后码）：原实现有两条独立阈值来源——
 *   回合内 emergency 线：headroom = max(EMERGENCY_OVERFLOW_HEADROOM_TOKENS, Δ+MIN_OUTPUT)
 *   请求前 INV 线：      limit = W − Δ − MIN_OUTPUT
 * 因 EMERGENCY_OVERFLOW_HEADROOM_TOKENS = MIN_OUTPUT_BUDGET_TOKENS = 1024 且 Δ≥0，
 * max(1024, Δ+1024) ≥ Δ+1024 恒真、等号恒取（a≤x ⇒ max(a,x)=x），两线逐输入同一触发点。
 * 收敛为 invariantReserveTokens/invariantLimitTokens 单一来源后，须机械证明：
 *   (i)  单源 reserve ≡ 原 max 形式（∀ Δ≥0）；
 *   (ii) ≥4 组窗口/配置下，给定 T，`T > emergency 线` ⇔ `T > INV 线`（触发点逐输入一致）。
 * 反向绊线：把单源表达式改错（如 +1）⇒ 本组断言必须红。
 */
describe('P0-B D3 单源阈值：emergency 线 ≡ INV 线（恒等断言）', () => {
  it('(i) 单源 reserve ≡ 原两源 max(1024, Δ+1024)，等号对 ∀ Δ≥0 恒成立', () => {
    // 被收敛掉的第二常量取值 1024，与 MIN_OUTPUT_BUDGET_TOKENS 同值——这是等号恒取的前提。
    expect(MIN_OUTPUT_BUDGET_TOKENS).toBe(1_024);
    const deltas = [0, 1, 512, 1_023, 1_024, 1_025, 4_096, 13_096, 65_536, 1_000_000];
    for (const delta of deltas) {
      const oldMax = Math.max(1_024, delta + 1_024);
      // max(a, x) ≥ x 恒真；此处 a 与 x 的常数项同值且 Δ≥0 ⇒ 恒取 x。
      expect(oldMax).toBeGreaterThanOrEqual(delta + 1_024);
      expect(oldMax).toBe(delta + 1_024);
      // 单源必须逐值等于旧 max 形式（不是只在某个特定 W 下数值巧合相等）。
      expect(invariantReserveTokens(delta)).toBe(oldMax);
      expect(invariantReserveTokens(delta)).toBe(delta + MIN_OUTPUT_BUDGET_TOKENS);
    }
  });

  it('(ii) ≥4 组窗口/配置下两条线触发点逐输入一致（T > emergency ⇔ T > INV）', () => {
    const configs: ReadonlyArray<{ window: number; delta: number; label: string }> = [
      { window: DEFAULT_CONTEXT_WINDOW, delta: 0, label: '缺省 128k、Δ=0' },
      { window: DEFAULT_CONTEXT_WINDOW, delta: 13_096, label: '缺省 128k、大 Δ' },
      { window: 40_000, delta: 6_592, label: '中窗口 40k' },
      { window: 8_192, delta: 0, label: '小窗口 8192、Δ=0' },
      { window: 8_192, delta: 5_120, label: '小窗口 8192、Δ 极大' },
    ];
    expect(configs.length).toBeGreaterThanOrEqual(4);
    for (const { window, delta, label } of configs) {
      const invLine = invariantLimitTokens(window, delta);
      // 单源构造：INV 线由同一 reserve 派生。
      expect(invLine, label).toBe(window - invariantReserveTokens(delta));
      // 旧 emergency 线（被收敛的第二源）：window − max(1024, Δ+1024)。
      const emergencyLine = window - Math.max(1_024, delta + 1_024);
      expect(invLine, label).toBe(emergencyLine);
      // 触发条件「T > 线」逐输入一致：不触发的仍不触发，触发的仍触发，边界不漂移。
      for (const T of [0, invLine - 1, invLine, invLine + 1, window, window + 1]) {
        expect(T > invLine, `${label} T=${T}`).toBe(T > emergencyLine);
      }
    }
  });

  it('(i-b) Δ 取极小/0 时单源退化为 MIN_OUTPUT，仍等于 max(1024, Δ+1024)', () => {
    for (const delta of [0, 1]) {
      expect(invariantReserveTokens(delta)).toBe(delta + MIN_OUTPUT_BUDGET_TOKENS);
      expect(invariantReserveTokens(delta)).toBe(Math.max(1_024, delta + 1_024));
    }
  });
});
