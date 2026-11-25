/**
 * cleanup-runs：保留期清理的**显式 ops 入口**（run 目录 + 过期文件引用字节）。
 *
 * 用法：
 *   npm run cleanup:runs --                 # 按 runtime 段清理到期的 run 目录与过期文件字节
 *   npm run cleanup:runs -- --dry-run       # 空跑：零删除，只报「本应删哪些」
 *   npm run cleanup:runs -- --config=<path> # 与 ask/tasks/ops 同义（AGENT_CONFIG_PATH 次之）
 *
 * 边界（本切片刻意最小）：
 *   · **默认只有显式运行才会删**：server/ask 启动路径默认不引用清理执行器；server 另有
 *     显式开关 `runtime.fileRetentionSweepOnStart`（缺省 false）可在启动装配后扫一次
 *     （守卫见 scripts/cleanup-runs.test.ts）；
 *   · run 目录规则在 `packages/agent/src/run-dir-cleanup.ts`：只处理仓库自己的
 *     `<workspace>/<16hex>/<16hex>/runs/run_<32hex>` 布局，lstat 不跟随 symlink，
 *     根内包含判定，单项失败只记事件不中断；
 *   · 文件字节规则在 `packages/agent/src/file-ref-cleanup.ts`：只按底账行（只读打开）
 *     派生路径，删**已过 `runtime.fileRefTtlDays` 可读期**的字节；**不删 file_refs 行**
 *     （保留做审计），不碰未过期行与 run 目录；
 *   · 配置来源与 server 同一优先级：显式 --config / AGENT_CONFIG_PATH > 仓根
 *     config/agent.yaml（存在时）> 代码缺省（保留期 30 天 / 文件可读期 7 天）；
 *     不回落 eval/fixture 配置。
 *
 * 输出：每条结构化事件一行 JSON（action=kept/deleted_bytes/would_delete/skipped_* 等），
 * 末行 `run_dir_cleanup_summary` 与 `file_ref_cleanup_summary`；删除失败（delete_failed）时
 * 退出码 1，其余 0，用法错误 2。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, openTaskStore } from '@fshine/core';
import { workspaceRootOf } from '../apps/server/server';
import { cleanupExpiredFileRefBytes } from '../packages/agent/src/file-ref-cleanup';
// 机械原因原文取具名 helper 的唯一导出（issue #72 合并；归属理由与守卫边界见
// run-dir-cleanup.ts 的 errorText 注释）。
import { cleanupExpiredRunDirs, errorText } from '../packages/agent/src/run-dir-cleanup';
import { resolveRuntimeConfig, type ResolvedRuntimeConfig } from '../packages/agent/src/resource-policy';
import { explicitConfigFrom } from './resolve-config-path';
import { resolveTaskDbPath } from './tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = '用法：npm run cleanup:runs -- [--dry-run] [--config=<path>]\n'
  + '  按 runtime 段清理到期的 run 目录（<workspace>/<身份哈希>/<会话哈希>/runs/run_<hex>）\n'
  + '  与过期文件引用字节（按 runtime 配置的可读期；只删字节，不删 file_refs 行）；\n'
  + '  --dry-run 空跑：零删除，只输出「本应删哪些」。';

export interface CleanupRunsCliArgs {
  /** true = 空跑（零删除）。缺省 false = 实际清理。 */
  dryRun: boolean;
}

/** 参数：--dry-run 开关（至多一次）+ --config= 透传；不接受位置参数。 */
export function parseCleanupRunsArgs(argv: readonly string[]): CleanupRunsCliArgs | { usageError: string } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--config=')) continue;
    if (arg === '--dry-run') {
      if (dryRun) return { usageError: '最多接受一个 --dry-run。' };
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) return { usageError: `未知参数：${arg}` };
    return { usageError: `不接受位置参数：${arg}（本命令只按保留期清理，不接受单任务参数）。` };
  }
  return { dryRun };
}

export interface CleanupRunsContext {
  readonly dbPath: string;
  readonly workspaceRoot: string;
  readonly config: ResolvedRuntimeConfig;
  /** 配置来源（'defaults' = 没有部署配置，使用代码缺省）。 */
  readonly configSource: string;
}

/**
 * 装配点解析（与 server 同一配置优先级）：显式配置 > 仓根 config/agent.yaml（存在时）>
 * 代码缺省。显式配置读不到 / 非法 → 抛错（不静默回落，避免用错保留期误删）。
 */
export function resolveCleanupRunsContext(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  cwd: string;
}): CleanupRunsContext {
  const explicit = explicitConfigFrom([...input.argv], input.env);
  const deploymentPath = explicit ?? path.join(input.repoRoot, 'config', 'agent.yaml');
  const appConfig = explicit !== undefined
    ? loadConfig({ yamlPath: explicit, env: input.env })
    : existsSync(deploymentPath)
      ? loadConfig({ yamlPath: deploymentPath, env: input.env })
      : undefined;
  // dbPath 与 server 同规则：配置里有就用配置值（相对 cwd 解析）；否则走 tasks/ops 的同一解析链。
  const dbPath = appConfig?.store?.dbPath !== undefined
    ? path.resolve(input.cwd, appConfig.store.dbPath)
    : resolveTaskDbPath({ argv: input.argv, env: input.env, repoRoot: input.repoRoot, cwd: input.cwd }).dbPath;
  return {
    dbPath,
    workspaceRoot: workspaceRootOf(dbPath),
    config: resolveRuntimeConfig(appConfig?.runtime),
    configSource: appConfig === undefined ? 'defaults' : deploymentPath,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseCleanupRunsArgs(argv);
  if ('usageError' in parsed) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    process.exitCode = 2;
    return;
  }

  let context: CleanupRunsContext;
  try {
    context = resolveCleanupRunsContext({ argv, env: process.env, repoRoot: REPO_ROOT, cwd: process.cwd() });
  } catch (error) {
    console.error(`无法加载配置：${errorText(error)}`);
    process.exitCode = 2;
    return;
  }

  const result = cleanupExpiredRunDirs({
    workspaceRoot: context.workspaceRoot,
    config: context.config,
    dryRun: parsed.dryRun,
  });
  for (const event of result.events) console.log(JSON.stringify(event));
  console.log(JSON.stringify({
    event: 'run_dir_cleanup_summary',
    dryRun: parsed.dryRun,
    workspaceRoot: context.workspaceRoot,
    configSource: context.configSource,
    rootMissing: result.rootMissing,
    ...result.summary,
  }));

  // 过期文件引用字节：底账只读打开（不建库、不写库、不删行）；库不存在 = 无行可回收。
  let fileRefFailed = false;
  if (!existsSync(context.dbPath)) {
    console.log(JSON.stringify({
      event: 'file_ref_cleanup_summary',
      dryRun: parsed.dryRun,
      workspaceRoot: context.workspaceRoot,
      dbMissing: true,
      scanned: 0,
      deleted: 0,
      wouldDelete: 0,
      kept: 0,
      bytesMissing: 0,
      skipped: 0,
      failed: 0,
    }));
  } else {
    let store: ReturnType<typeof openTaskStore> | undefined;
    try {
      store = openTaskStore(context.dbPath, { readOnly: true });
      const fileRefResult = cleanupExpiredFileRefBytes({
        store,
        workspaceRoot: context.workspaceRoot,
        config: context.config,
        dryRun: parsed.dryRun,
      });
      for (const event of fileRefResult.events) console.log(JSON.stringify(event));
      console.log(JSON.stringify({
        event: 'file_ref_cleanup_summary',
        dryRun: parsed.dryRun,
        workspaceRoot: context.workspaceRoot,
        dbMissing: false,
        rootMissing: fileRefResult.rootMissing,
        ...fileRefResult.summary,
      }));
      fileRefFailed = fileRefResult.summary.failed > 0;
    } catch (error) {
      // 底账打不开/回收抛错：如实报错并置失败退出码（不静默当作「没有可回收的」）。
      console.log(JSON.stringify({ event: 'file_ref_cleanup_failed', reason: errorText(error) }));
      fileRefFailed = true;
    } finally {
      store?.close();
    }
  }
  if (result.summary.failed > 0 || fileRefFailed) process.exitCode = 1;
}

// 仅作为 CLI 直接运行时执行 main；被 import（测试/复用）时不触发任何清理
// （与 ask/tasks/ops 同一守卫；Node >=24 提供 import.meta.main）。
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error('cleanup-runs 运行失败：', errorText(error));
    process.exitCode = 1;
  });
}
