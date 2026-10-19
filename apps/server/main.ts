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
import { sweepScratchDirs } from '@fshine/agent';
import { createServerAssembly, repoRoot } from './assembly';

/** 工作区保留时长：默认 24h。同任务的续跑仍要用上一轮的产物，所以不能按回合删。 */
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** 清理周期：启动时跑一次，之后每 6h 一次（不依赖重启）。 */
const SCRATCH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const assembly = await createServerAssembly({ env: process.env });

  // 清理：只扫 tmp/task_<uuid>（我们自己的命名，同任务续跑共享工作区），平台自己的
  // tmp/ 产物一律不碰。
  if (assembly.platformRoot) {
    const sweep = () => {
      const r = sweepScratchDirs(assembly.platformRoot!, Date.now(), SCRATCH_TTL_MS);
      if (r.removed.length > 0 || r.errors.length > 0) {
        console.log(JSON.stringify({ event: 'scratch_sweep', removed: r.removed.length, kept: r.kept.length, errors: r.errors.length }));
        for (const e of r.errors) console.warn(JSON.stringify({ event: 'scratch_sweep_error', name: e.name, error: e.error }));
      }
    };
    sweep();
    const timer = setInterval(sweep, SCRATCH_SWEEP_INTERVAL_MS);
    timer.unref?.(); // 不因这个定时器挡住进程退出
  }

  await assembly.channel.start(assembly.replyHandler);
  console.log(JSON.stringify({
    event: 'server_started',
    db: process.env['DB_PATH'] ?? path.join(repoRoot, 'data/agent.db'),
    contextProfiles: assembly.platformRoot ? ['17dz'] : [],
  }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: 'shutting_down', signal }));
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
