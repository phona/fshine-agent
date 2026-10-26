/**
 * 服务装配入口:配置 → SQLite 任务/审计存储 → Agent runtime + Context Worker → 企微长连接。
 * 启动:npm start(即 node --env-file=.env --import tsx apps/server/main.ts)
 * 平台 Context 未提供通用执行能力时，任务会以 capability_unavailable 阻断。
 *
 * 装配本身在 assembly.ts，生产和离线全链 e2e 共用同一份。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepScratchDirs, listScratchDirNames } from '@fshine/agent';
import { createServerAssembly, repoRoot } from './assembly';
import { runtimeModeOf } from './runtime-mode';

/**
 * 终态任务工作区的保留时长（grace）：交付物已在回合末复制进会话产物库
 * （artifact-store.ts），续跑要旧产物时宿主从库里物化，scratch 只是中间产物；
 * 终态后只留一段排障与重试窗口（W5 起取代 24h 一刀切）。
 */
const SCRATCH_TERMINAL_GRACE_MS = 60 * 60 * 1000;
/** 非终态（从没拿到结局，如崩溃的委派）工作区的闲置保留时长：抛弃兜底，防无限堆积。 */
const SCRATCH_ABANDONED_TTL_MS = 24 * 60 * 60 * 1000;
/** 清理周期：启动时跑一次，之后每 6h 一次（不依赖重启）。 */
const SCRATCH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const assembly = await createServerAssembly({ env: process.env });
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  // 清理：只扫 tmp/task_<uuid>（我们自己的命名，同任务续跑共享工作区），平台自己的
  // tmp/ 产物一律不碰。判据是任务终态（W5）：终态且过了 grace 才删——交付物已在
  // 会话产物库里，scratch 对续跑不再不可替代；在飞与刚终态的一律保留。
  if (assembly.platformRoot) {
    const sweep = async () => {
      // 终态判据快照：台账里 outcome 为 done/failed 的任务（needs 可续、查不到/抛错
      // = 不确定，都按非终态保留）。一次性快照——任务状态只在回合内变，sweep 过程中
      // 不再变，无需事务。
      const terminal = new Set<string>();
      let pinned = new Set<string>();
      try {
        pinned = new Set(await assembly.store.taskRuns?.listPinnedTaskIds() ?? []);
      } catch (error) {
        // A failed pin query must not make live or undelivered task workspaces collectible.
        pinned = new Set(listScratchDirNames(assembly.platformRoot!));
        console.error(JSON.stringify({
          event: 'background_task_gc_pin_lookup_failed',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      const repo = assembly.store.platformTasks;
      if (repo) {
        for (const name of listScratchDirNames(assembly.platformRoot!)) {
          try {
            const task = await repo.get(name);
            if (task && (task.outcome === 'done' || task.outcome === 'failed')) terminal.add(name);
          } catch { /* 查不到 = 不确定 → 非终态 */ }
        }
      }
      const r = sweepScratchDirs(assembly.platformRoot!, Date.now(), {
        terminalGraceMs: SCRATCH_TERMINAL_GRACE_MS,
        abandonedTtlMs: SCRATCH_ABANDONED_TTL_MS,
        isTerminal: (taskId) => terminal.has(taskId) && !pinned.has(taskId),
        isPinned: (taskId) => pinned.has(taskId),
      });
      if (r.removed.length > 0 || r.errors.length > 0) {
        console.log(JSON.stringify({ event: 'scratch_sweep', removed: r.removed.length, kept: r.kept.length, errors: r.errors.length }));
        for (const e of r.errors) console.warn(JSON.stringify({ event: 'scratch_sweep_error', name: e.name, error: e.error }));
      }
    };
    void sweep();
    sweepTimer = setInterval(() => { void sweep(); }, SCRATCH_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.(); // 不因这个定时器挡住进程退出
  }

  await assembly.channel.start(assembly.replyHandler);
  console.log(JSON.stringify({
    event: 'server_started',
    db: process.env['DB_PATH'] ?? path.join(repoRoot, 'data/agent.db'),
    contextProfiles: assembly.platformRoot ? ['17dz'] : [],
  }));
  // 生效模式一行可观测（2026-10-21 真平台切换事故补丁）：executor / 运维授权 / 写授权
  // 一屏可查，不用再做法医式核查。只含三个模式键——绝不全量打 env（.env 有 LLM 密钥）。
  console.log(JSON.stringify({ event: 'runtime_mode', ...runtimeModeOf(process.env) }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: 'shutting_down', signal }));
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    // Stop admissions, cancel/wind down Worker runs, and let terminal event delivery finish while
    // the channel and durable stores are still available.
    await assembly.backgroundTasks.shutdown();
    await assembly.channel.stop();
    await assembly.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
