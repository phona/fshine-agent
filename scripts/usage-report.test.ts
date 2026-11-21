/**
 * 模型用量报表（阶段 3）：聚合纯函数 + CLI 参数解析与渲染。
 *
 * 判据（ask 原文）：
 *   · 固定样本 → 断言聚合数与 p50/p95（最近秩法）；
 *   · 空数组 → 「无数据」（CLI exit 0）；
 *   · 缺 ttft 行 → tokens/s 为 n/a 且不抛。
 *
 * 聚合判定全部在 packages/agent/src/model-usage.ts 的纯函数里；本文件同时覆盖
 * scripts/ops/usage-report.ts 的参数解析与渲染（只装饰，不做判定）。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateModelUsage,
  nearestRankPercentile,
  parseUsageLine,
  type ModelUsageLine,
  type UsageDayGroup,
} from '../packages/agent/src/model-usage';
import { parseUsageReportArgs, renderUsageReport } from './ops/usage-report';

const DAY_1 = '2026-11-21';

/** 固定样本：wecom:t1 四行（含一行缺 ttft）+ wecom:t2 一行（worker）+ 一行无主体。 */
function sampleLines(): ModelUsageLine[] {
  const row = (over: Partial<ModelUsageLine> & Pick<ModelUsageLine, 'at'>): ModelUsageLine => ({
    agent: 'main',
    modelId: 'workbuddy/deepseek-v4.1-flash',
    stopReason: 'stop',
    durationMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
    ...over,
  });
  return [
    // wecom:t1 @ D1：durations [1000,2000,3000,4000]，ttft [100,200,缺,400]；
    // 可算率行（有 ttft 且 dur>ttft）的 output 合计 6300、窗口合计 6300ms → 恰 1000 tokens/s。
    row({ at: `${DAY_1}T10:00:00.000Z`, principalId: 'wecom:t1', sessionId: 'sess_1', durationMs: 1000, ttftMs: 100, usage: { input: 10, output: 900, cacheRead: 100, cacheWrite: 5, reasoning: 50, totalTokens: 1060 } }),
    row({ at: `${DAY_1}T11:00:00.000Z`, principalId: 'wecom:t1', sessionId: 'sess_1', durationMs: 2000, ttftMs: 200, usage: { input: 20, output: 1800, cacheRead: 200, cacheWrite: 5, reasoning: 60, totalTokens: 2080 } }),
    row({ at: `${DAY_1}T12:00:00.000Z`, principalId: 'wecom:t1', sessionId: 'sess_1', durationMs: 3000, usage: { input: 30, output: 3000, cacheRead: 300, cacheWrite: 5, reasoning: 70, totalTokens: 3400 } }),
    row({ at: `${DAY_1}T13:00:00.000Z`, principalId: 'wecom:t1', sessionId: 'sess_1', durationMs: 4000, ttftMs: 400, usage: { input: 40, output: 3600, cacheRead: 400, cacheWrite: 5, reasoning: 80, totalTokens: 4120 } }),
    // wecom:t2 @ D2：worker、无 ttft。
    row({ at: '2026-11-22T09:00:00.000Z', agent: 'worker', principalId: 'wecom:t2', durationMs: 500, usage: { input: 200, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 700 } }),
    // 无主体（后台兜底 Worker 的行）。
    row({ at: `${DAY_1}T14:00:00.000Z`, agent: 'worker', durationMs: 100, ttftMs: 50, usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 11 } }),
  ];
}

describe('aggregateModelUsage：固定样本 → 聚合数与最近秩 p50/p95', () => {
  const groups = aggregateModelUsage(sampleLines());

  it('按 (principalId, day) 分组、升序输出', () => {
    expect(groups.map((group) => `${group.principalId || '(无主体)'}@${group.day}`))
      .toEqual(['(无主体)@2026-11-21', 'wecom:t1@2026-11-21', 'wecom:t2@2026-11-22']);
  });

  it('wecom:t1 组：调用数、tokens 合计、平均耗时', () => {
    const t1 = groups.find((group) => group.principalId === 'wecom:t1')!;
    expect(t1.calls).toBe(4);
    expect(t1.inputTokens).toBe(100);
    expect(t1.outputTokens).toBe(9300);
    expect(t1.cacheReadTokens).toBe(1000);
    expect(t1.reasoningTokens).toBe(260);
    expect(t1.totalTokens).toBe(10660);
    expect(t1.avgDurationMs).toBe(2500);
  });

  it('wecom:t1 组：最近秩 p50/p95 耗时与首字延迟（缺 ttft 行不进首字分位）', () => {
    const t1 = groups.find((group) => group.principalId === 'wecom:t1')!;
    // n=4：p50 = 第 ⌈2⌉ 个 = 2000；p95 = 第 ⌈3.8⌉ 个 = 4000。
    expect(t1.p50DurationMs).toBe(2000);
    expect(t1.p95DurationMs).toBe(4000);
    // ttft 样本 [100,200,400]：p50 = 第 ⌈1.5⌉ 个 = 200；p95 = 第 ⌈2.85⌉ 个 = 400。
    expect(t1.p50TtftMs).toBe(200);
    expect(t1.p95TtftMs).toBe(400);
    // 输出 tokens/s = 6300 tokens / 6.3 s = 1000（缺 ttft 的 3000-token 行不进分子分母）。
    expect(t1.outputTokensPerSecond).toBe(1000);
  });

  it('wecom:t2 组：单行、无 ttft → 首字与 tokens/s 为 n/a（null），不抛', () => {
    const t2 = groups.find((group) => group.principalId === 'wecom:t2')!;
    expect(t2.calls).toBe(1);
    expect(t2.p50DurationMs).toBe(500);
    expect(t2.p95DurationMs).toBe(500);
    expect(t2.p50TtftMs).toBeNull();
    expect(t2.p95TtftMs).toBeNull();
    expect(t2.outputTokensPerSecond).toBeNull();
    expect(() => renderUsageReport(groups)).not.toThrow();
  });
});

describe('aggregateModelUsage：过滤', () => {
  const lines = sampleLines();

  it('sinceMs：只保留 at >= since 的行（分位随样本重算）', () => {
    const since = Date.parse(`${DAY_1}T12:00:00.000Z`);
    const filtered = aggregateModelUsage(lines, { sinceMs: since });
    const t1 = filtered.find((group) => group.principalId === 'wecom:t1')!;
    expect(t1.calls).toBe(2);
    expect(t1.avgDurationMs).toBe(3500);
    // n=2：p50 = 第 ⌈1⌉ 个 = 3000；p95 = 第 ⌈1.9⌉ 个 = 4000。
    expect(t1.p50DurationMs).toBe(3000);
    expect(t1.p95DurationMs).toBe(4000);
  });

  it('principal 过滤：只留该主体（无主体行排除）', () => {
    const filtered = aggregateModelUsage(lines, { principalId: 'wecom:t1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.principalId).toBe('wecom:t1');
  });

  it('agent 过滤：只留该角色', () => {
    const filtered = aggregateModelUsage(lines, { agent: 'worker' });
    expect(filtered.map((group) => group.principalId).sort()).toEqual(['', 'wecom:t2']);
  });
});

describe('parseUsageLine：宽容解析', () => {
  it('合法行原样解析；principalId/sessionId 空串省略', () => {
    const line = parseUsageLine(JSON.stringify({
      at: `${DAY_1}T10:00:00.000Z`, agent: 'main', principalId: '', sessionId: 'sess_1',
      modelId: 'm', stopReason: 'stop', durationMs: 100, ttftMs: 20,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 6 },
    }));
    expect(line).toBeDefined();
    expect(line!.principalId).toBeUndefined();
    expect(line!.sessionId).toBe('sess_1');
    expect(line!.ttftMs).toBe(20);
  });

  it('坏行返回 undefined：非 JSON / 缺 usage / 负数 / agent 非法 / at 不可解析', () => {
    expect(parseUsageLine('不是 JSON')).toBeUndefined();
    expect(parseUsageLine('[]')).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ at: `${DAY_1}T10:00:00.000Z`, agent: 'main', modelId: 'm', stopReason: 'stop', durationMs: 100 }))).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ at: `${DAY_1}T10:00:00.000Z`, agent: 'main', modelId: 'm', stopReason: 'stop', durationMs: -1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } }))).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ at: `${DAY_1}T10:00:00.000Z`, agent: 'bogus', modelId: 'm', stopReason: 'stop', durationMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } }))).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ at: 'yesterday', agent: 'main', modelId: 'm', stopReason: 'stop', durationMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } }))).toBeUndefined();
  });
});

describe('nearestRankPercentile：最近秩法', () => {
  it('n=1 任何分位都取唯一值；n=2 p50 取第 1 个、p95 取第 2 个', () => {
    expect(nearestRankPercentile([42], 50)).toBe(42);
    expect(nearestRankPercentile([42], 95)).toBe(42);
    expect(nearestRankPercentile([10, 20], 50)).toBe(10);
    expect(nearestRankPercentile([10, 20], 95)).toBe(20);
  });
});

describe('renderUsageReport：渲染', () => {
  it('空数组 → 「无数据」', () => {
    expect(renderUsageReport([])).toBe('无数据');
  });

  it('null 计量渲染 n/a；无主体渲染占位', () => {
    const groups: UsageDayGroup[] = [{
      principalId: '', day: DAY_1, calls: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0,
      reasoningTokens: 0, totalTokens: 3, avgDurationMs: 100, p50DurationMs: 100, p95DurationMs: 100,
      p50TtftMs: null, p95TtftMs: null, outputTokensPerSecond: null,
    }];
    const rendered = renderUsageReport(groups);
    expect(rendered).toContain('(无主体)');
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered.split('\n')[1]!).toContain('n/a');
  });
});

describe('parseUsageReportArgs：CLI 参数', () => {
  it('--since 7d 以传入 now 为基准换算', () => {
    const parsed = parseUsageReportArgs(['--since', '7d'], 1_000_000_000);
    if ('usageError' in parsed) throw new Error(parsed.usageError);
    expect(parsed.sinceMs).toBe(1_000_000_000 - 7 * 86_400_000);
  });

  it('--since=ISO 与 --principal / --agent / --file 组合', () => {
    const parsed = parseUsageReportArgs([
      '--since=2026-11-14T00:00:00Z', '--principal', 'wecom:t1', '--agent=worker', '--file', '/tmp/usage.jsonl',
    ], Date.now());
    if ('usageError' in parsed) throw new Error(parsed.usageError);
    expect(parsed.sinceMs).toBe(Date.parse('2026-11-14T00:00:00Z'));
    expect(parsed.principalId).toBe('wecom:t1');
    expect(parsed.agent).toBe('worker');
    expect(parsed.filePath).toBe('/tmp/usage.jsonl');
  });

  it('非法值给 usageError：未知参数 / 非法 agent / 非法 since', () => {
    expect(parseUsageReportArgs(['--bogus'])).toHaveProperty('usageError');
    expect(parseUsageReportArgs(['--agent', 'bogus'])).toHaveProperty('usageError');
    expect(parseUsageReportArgs(['--since', '上周'])).toHaveProperty('usageError');
    expect(parseUsageReportArgs(['--principal'])).toHaveProperty('usageError');
  });
});
