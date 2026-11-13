/**
 * Minimal Rewrite U3 最小 server 入口：企微长连接 → Minimal runtime → 渠道回复。
 *
 * 启动：npm start（node --env-file-if-exists=.env --import tsx apps/server/main.ts）
 * 配置：--config=<path> 或 AGENT_CONFIG_PATH 优先；缺省仓根 config/agent.yaml（部署配置，
 * 复制 config/agent.example.yaml 填写）。都找不到即拒启——server 不回落仓内 eval/demo 配置，
 * 避免把评测夹具当成部署面静默启动。
 *
 * 本切片不做（后续切片）：计划确认 / 后台派发 / 产物 / 提案；附件只登记不消费。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WecomBotChannel } from '@fshine/channel-wecom';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { explicitConfigFrom } from '../../scripts/resolve-config-path';
import { createMinimalServer, resolveSingleProfile } from './minimal-server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const explicit = explicitConfigFrom();
  const configPath = explicit ?? path.join(REPO_ROOT, 'config', 'agent.yaml');
  if (!existsSync(configPath)) {
    throw new Error(
      `找不到部署配置：${configPath}——请复制 config/agent.example.yaml 为 config/agent.yaml 填写，`
      + '或用 AGENT_CONFIG_PATH / --config=<path> 指向部署配置。',
    );
  }
  const config = loadConfig({ yamlPath: configPath });
  const env = effectiveDeploymentEnv(config, process.env);
  const { id: profileId, profile } = resolveSingleProfile(config);
  const dbPath = config.store?.dbPath !== undefined
    ? path.resolve(config.store.dbPath)
    : path.join(REPO_ROOT, '.runtime', 'minimal', 'state.db');

  const server = await createMinimalServer({ env, config, dbPath });
  const channel = new WecomBotChannel({ env, platformRoot: profile.root });
  await channel.start(server.handler);
  console.log(JSON.stringify({ event: 'minimal_server_started', configPath, profileId, dbPath }));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: 'minimal_server_shutdown', signal }));
    await channel.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
