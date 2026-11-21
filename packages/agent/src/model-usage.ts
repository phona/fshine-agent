/**
 * 模型调用用量观测（owner 2026-11-21 批准的最小方案：不建新表、不碰模型面、先不做告警阈值）。
 *
 * 链路：pi-driver 每条 assistant message_end 采集一条 `PiModelUsageEntry`（采集面见
 * pi-driver.ts）→ 装配层（scripts/ask-runtime.ts 的缺省驱动与后台 Worker 兜底、经
 * assembleSessionCore 覆盖 apps/server/server.ts）注入 `createModelUsageSink` 追加落盘到
 * `<dbPath 同目录>/usage.jsonl`（与 alerts.jsonl 同一部署状态根；.runtime/ 已 gitignored）
 * → scripts/ops/usage-report.ts 读行聚合报表（npm run usage）。
 *
 * 纪律（ask 原文）：
 *   · 写失败只记结构化事件（model_usage_write_failed）、绝不抛——观测不得影响回合；
 *   · 装配处能拿到 principal/session 的用真实值；拿不到的字段省略，不许编；
 *   · 行 schema 是落盘与报表的单一来源；行里只有机械计量字段——消息正文、工具参数、
 *     prompt 一概不落（pi-driver 采集面已保证，本模块只搬运）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PiModelUsageEntry } from './pi-driver';

/** usage.jsonl 行：entry + 落盘时刻与装配侧能拿到的身份字段（拿不到的省略，不编）。 */
export interface ModelUsageLine extends PiModelUsageEntry {
  /** 落盘时刻（ISO）。 */
  at: string;
  /** 采集来源的驱动角色：Main 会话驱动 = main；Worker（inline 与后台）= worker。 */
  agent: 'main' | 'worker';
  principalId?: string;
  sessionId?: string;
}

/** usage.jsonl 标准文件名（与 dbPath 同目录）。 */
export const USAGE_FILENAME = 'usage.jsonl';

/** 部署状态根下 usage.jsonl 的标准位置：`<dbPath 同目录>/usage.jsonl`。 */
export function usageFilePathOf(dbPath: string): string {
  return path.join(path.dirname(dbPath), USAGE_FILENAME);
}

export interface ModelUsageSinkOptions {
  filePath: string;
  agent: 'main' | 'worker';
  principalId?: string;
  sessionId?: string;
}

/**
 * 装配侧用量出口：把驱动发来的 entry 变成一行 JSON 追加进 usage.jsonl。
 * 进程内同步 append（单线程不交错，'a' 模式单次 write 原子）；目录不存在时先建；
 * **任何写失败只记结构化事件，绝不抛**。
 */
export function createModelUsageSink(options: ModelUsageSinkOptions): (entry: PiModelUsageEntry) => void {
  return (entry) => {
    const line: ModelUsageLine = {
      at: new Date().toISOString(),
      agent: options.agent,
      ...(options.principalId !== undefined ? { principalId: options.principalId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      modelId: entry.modelId,
      stopReason: entry.stopReason,
      durationMs: entry.durationMs,
      ...(entry.ttftMs !== undefined ? { ttftMs: entry.ttftMs } : {}),
      usage: { ...entry.usage },
    };
    try {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
      appendFileSync(options.filePath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'model_usage_write_failed',
        path: options.filePath,
        reason: String(error instanceof Error ? error.message : error).slice(0, 500),
      }));
    }
  };
}

// ── 报表聚合（scripts/ops/usage-report.ts 的纯函数面；单独导出便于单测）──

/** 报表过滤（缺省全量）。 */
export interface UsageReportFilter {
  /** 只保留 `at >= sinceMs` 的行（epoch 毫秒；--since 7d / ISO 换算后传入）。 */
  sinceMs?: number;
  /** 只保留 principalId 精确相等的行（没有 principalId 的行被排除）。 */
  principalId?: string;
  /** 只保留该驱动角色的行。 */
  agent?: 'main' | 'worker';
}

/** 按 (principalId, day) 聚合出的一组读数。缺 ttft / 无法算 tokens/s 的地方为 null → 报表渲染 n/a。 */
export interface UsageDayGroup {
  /** 行里没有 principalId 的归 ''（跨主体兜底 Worker 的行；报表渲染成占位）。 */
  principalId: string;
  /** UTC 日（ISO `at` 的前 10 字符）。 */
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** 平均耗时（毫秒，四舍五入到整数）。 */
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  /** 输出 tokens/s = Σoutput / (Σ(durationMs−ttftMs)/1000)，只统计有 ttft 且 duration>ttft 的行；无可算行 = null。 */
  outputTokensPerSecond: number | null;
}

/**
 * 宽容解析一行 usage.jsonl：JSON 可解析且最小形状齐全（at 可解析、agent 合法、计量字段为
 * 有限数字）才返回行；坏行返回 undefined（调用方计数后跳过）。
 */
export function parseUsageLine(raw: string): ModelUsageLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const at = record['at'];
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  const agent = record['agent'];
  if (agent !== 'main' && agent !== 'worker') return undefined;
  const modelId = record['modelId'];
  const stopReason = record['stopReason'];
  if (typeof modelId !== 'string' || modelId === '' || typeof stopReason !== 'string') return undefined;
  const durationMs = record['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const usageRecord = record['usage'];
  if (typeof usageRecord !== 'object' || usageRecord === null) return undefined;
  const usage = usageRecord as Record<string, unknown>;
  const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'] as const;
  const usageOut: PiModelUsageEntry['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  for (const key of usageKeys) {
    const value = usage[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    usageOut[key] = value;
  }
  const ttftMs = record['ttftMs'];
  if (ttftMs !== undefined && (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0)) return undefined;
  const principalId = record['principalId'];
  const sessionId = record['sessionId'];
  return {
    at,
    agent,
    ...(typeof principalId === 'string' && principalId !== '' ? { principalId } : {}),
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    modelId,
    stopReason,
    durationMs,
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    usage: usageOut,
  };
}

/** 最近秩法（nearest-rank）百分位：升序第 ⌈p/100 × n⌉ 个（1 起）。空数组返回 0（调用方保证非空）。 */
export function nearestRankPercentile(sortedAscending: readonly number[], percentile: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1]!;
}

/** 行过滤（since/principal/agent），不复制不改行。 */
function lineMatchesFilter(line: ModelUsageLine, filter: UsageReportFilter): boolean {
  if (filter.sinceMs !== undefined && Date.parse(line.at) < filter.sinceMs) return false;
  if (filter.principalId !== undefined && line.principalId !== filter.principalId) return false;
  if (filter.agent !== undefined && line.agent !== filter.agent) return false;
  return true;
}

/** 按 (principalId, day) 聚合；输出按 principalId 再按 day 升序（确定性渲染）。 */
export function aggregateModelUsage(
  lines: readonly ModelUsageLine[],
  filter: UsageReportFilter = {},
): UsageDayGroup[] {
  const buckets = new Map<string, ModelUsageLine[]>();
  for (const line of lines) {
    if (!lineMatchesFilter(line, filter)) continue;
    const key = `${line.principalId ?? ''}\u0000${line.at.slice(0, 10)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [line]);
    else bucket.push(line);
  }
  const groups: UsageDayGroup[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const [principalId = '', day = ''] = key.split('\u0000');
    const bucket = buckets.get(key)!;
    const sum = (pick: (line: ModelUsageLine) => number): number => bucket.reduce((total, line) => total + pick(line), 0);
    const durations = bucket.map((line) => line.durationMs).sort((a, b) => a - b);
    const ttfts = bucket.flatMap((line) => line.ttftMs !== undefined ? [line.ttftMs] : []).sort((a, b) => a - b);
    // tokens/s 只统计「有 ttft 且 duration > ttft」的行：duration == ttft 的行除数为 0，
    // 计入只会虚高——排除（分子分母一起排除，不虚耗）。
    const rateRows = bucket.flatMap((line) => (line.ttftMs !== undefined && line.durationMs > line.ttftMs
      ? [line]
      : []));
    const rateWindowMs = rateRows.reduce((total, line) => total + (line.durationMs - (line.ttftMs ?? 0)), 0);
    groups.push({
      principalId,
      day,
      calls: bucket.length,
      inputTokens: sum((line) => line.usage.input),
      outputTokens: sum((line) => line.usage.output),
      cacheReadTokens: sum((line) => line.usage.cacheRead),
      reasoningTokens: sum((line) => line.usage.reasoning),
      totalTokens: sum((line) => line.usage.totalTokens),
      avgDurationMs: Math.round(sum((line) => line.durationMs) / bucket.length),
      p50DurationMs: nearestRankPercentile(durations, 50),
      p95DurationMs: nearestRankPercentile(durations, 95),
      p50TtftMs: ttfts.length === 0 ? null : nearestRankPercentile(ttfts, 50),
      p95TtftMs: ttfts.length === 0 ? null : nearestRankPercentile(ttfts, 95),
      outputTokensPerSecond: rateRows.length === 0 || rateWindowMs === 0
        ? null
        : Math.round((rateRows.reduce((total, line) => total + line.usage.output, 0) / (rateWindowMs / 1000)) * 10) / 10,
    });
  }
  return groups;
}
