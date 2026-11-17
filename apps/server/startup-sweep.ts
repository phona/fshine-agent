/**
 * server 启动保留期清扫（`runtime.fileRetentionSweepOnStart`；**缺省关闭**）。
 *
 * 边界（本切片刻意最小）：
 *   · 缺省 false = 零行为：不调用执行器、不新建目录、不删任何文件、不打清理日志；
 *   · 开启时由 main.ts 在「启动装配完成后、渠道开始接消息之前」调用一次
 *     `cleanupExpiredRunDirs`（dryRun=false，与 `npm run cleanup:runs` 同一执行器与判定）；
 *   · 结果只写一行结构化启动日志：删除/保留/跳过/失败计数 + 跳过原因分布；
 *   · **不做周期调度**：只扫一次，定时/周期清理归部署侧；
 *   · 清扫抛错不阻断 server 启动：记 `run_dir_cleanup_startup_failed` 观测事件后返回，
 *     调用方继续后续装配（渠道照常启动）。
 *
 * 配置来源：只读 `resolveRuntimeConfig` 的解析值（缺省与校验的唯一出处），不在这里
 * 重读 `config.runtime.*`（单一配置源守卫 `resource-policy-single-source.test.ts` 覆盖）。
 */
import type { ResolvedRuntimeConfig } from '../../packages/agent/src/resource-policy';
import {
  cleanupExpiredRunDirs,
  type CleanupRunDirsInput,
  type RunDirCleanupResult,
} from '../../packages/agent/src/run-dir-cleanup';

/** 跳过原因分布：只统计 `skipped_*`（删除失败另计 failed，不算跳过）。 */
function skipReasonCounts(events: RunDirCleanupResult['events']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (!event.action.startsWith('skipped_')) continue;
    counts[event.action] = (counts[event.action] ?? 0) + 1;
  }
  return counts;
}

export interface StartupSweepInput {
  /** `resolveRuntimeConfig` 的解析值（开关与保留期的唯一来源）。 */
  readonly config: ResolvedRuntimeConfig;
  /** 文件区 workspace 根（`workspaceRootOf(dbPath)`，与 cleanup:runs 同一布局）。 */
  readonly workspaceRoot: string;
  /** 执行器注入（测试用；缺省 = 真实 `cleanupExpiredRunDirs`）。 */
  readonly sweep?: (input: CleanupRunDirsInput) => RunDirCleanupResult;
  /** 日志注入（测试用；缺省 = 结构化 JSON 一行到 stdout）。 */
  readonly log?: (event: Record<string, unknown>) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 开关开启时执行一次 run 目录保留期清扫并记录启动日志；关闭时立即返回（零行为）。
 * 只返回结果供测试/调用方核对；抛错已在本函数内收口，绝不向上抛。
 */
export function sweepExpiredRunDirsOnStart(input: StartupSweepInput): RunDirCleanupResult | undefined {
  if (!input.config.fileRetentionSweepOnStart) return undefined;
  const log = input.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));

  let result: RunDirCleanupResult;
  try {
    result = (input.sweep ?? cleanupExpiredRunDirs)({
      workspaceRoot: input.workspaceRoot,
      config: input.config,
      dryRun: false,
    });
  } catch (error) {
    log({
      event: 'run_dir_cleanup_startup_failed',
      workspaceRoot: input.workspaceRoot,
      reason: errorText(error),
    });
    return undefined;
  }

  log({
    event: 'run_dir_cleanup_startup',
    workspaceRoot: input.workspaceRoot,
    rootMissing: result.rootMissing,
    scanned: result.summary.scanned,
    deleted: result.summary.deleted,
    kept: result.summary.kept,
    skipped: result.summary.skipped,
    failed: result.summary.failed,
    skipReasons: skipReasonCounts(result.events),
  });
  return result;
}
