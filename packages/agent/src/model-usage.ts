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
