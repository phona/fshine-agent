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
import { createServerAssembly, repoRoot } from './assembly';

async function main(): Promise<void> {
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const assembly = await createServerAssembly({ env: process.env });

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
