/**
 * server 入口：企微长连接 → 回合运行时 → 渠道回复。
 *
 * 启动：npm start（node --env-file-if-exists=.env --import tsx apps/server/main.ts）
 * 配置：--config=<path> 或 AGENT_CONFIG_PATH 优先；缺省仓根 config/agent.yaml（部署配置，
 * 复制 config/agent.example.yaml 填写）。都找不到即拒启——server 不回落仓内 eval/fixture 配置，
 * 避免把评测夹具当成部署面静默启动。
 *
 * 本切片不做（后续切片）：计划确认 / 后台派发 / 产物 / 提案；附件只登记不消费。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WecomBotChannel } from '@fshine/channel-wecom';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { resolveRuntimeConfig } from '../../packages/agent/src/resource-policy';
import { explicitConfigFrom } from '../../scripts/resolve-config-path';
import {
  channelModeOf,
  createChannelForMode,
  serverStartedEvent,
  startChannelForMode,
} from './channel-mode';
import { createServer, resolveSingleProfile, workspaceRootOf } from './server';
import { createFileNotificationSink } from './notification-file-sink';
import { sweepExpiredRunDirsOnStart } from './startup-sweep';

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
    : path.join(REPO_ROOT, '.runtime', 'state.db');

  // 渠道装配档位（yaml `channel.mode`；缺省 offline）：
  //   offline = 不调用 channel.start（不建 WS 连接），出站视为 silent；
  //   shadow  = 建立连接（入站照收），出站模式显式 silent（六类路径全抑制）；
  //   live    = 改动前的生产语义（显式 live，真实投递）。
  // 真实渠道必须**显式声明**出站模式——不声明则适配器拒绝真实出站（fail-safe 退化为
  // silent）。档位只认 yaml，无 FSHINE_* 环境变量覆盖口。
  const channelMode = channelModeOf(config);
  const channel = createChannelForMode(channelMode, (deliveryMode) =>
    new WecomBotChannel({ env, platformRoot: profile.root, deliveryMode }));
  // R5 A 通道缺省：渠道无关落盘 sink（background 时生效；真实企微 sink 仍 blocked，不接真实平台）。
  // CAP-01 S1 交付端口（v8 §7 主动投递 B）：装配层持有渠道的 sendToConversation 面并注入
  // server——handler 只返回 text，文件由这里发出（只传 files，不传正文）；deliveryMode 用
  // 渠道生效模式，非 live 的投递由 server 记 suppressed、不记 sent。
  const server = await createServer({
    env,
    config,
    dbPath,
    notificationSink: createFileNotificationSink(path.join(path.dirname(dbPath), 'notifications.jsonl')),
    fileDelivery: {
      deliveryMode: channel.deliveryMode,
      sendToConversation: (route, files) => channel.sendToConversation(route, { files }),
      // 纯附件后主动追问：文字走既有主动投递面（silent 由 server 先行抑制，不靠闸门假回执）。
      sendText: (route, text) => channel.sendToConversation(route, { text }),
    },
  });
  // 保留期启动清扫（runtime.fileRetentionSweepOnStart；缺省 false = 零行为变化）：
  // 装配完成、渠道真正开始接消息之前扫一次——run 目录按保留期、过期 file_refs 按
  // runtime.fileRefTtlDays 回收字节（同一开关、只扫一次，不引入定时器；周期调度归部署侧）。
  // 抛错已在 sweepExpiredRunDirsOnStart 内收口为观测事件，不阻断启动。
  sweepExpiredRunDirsOnStart({
    config: resolveRuntimeConfig(config.runtime),
    workspaceRoot: workspaceRootOf(dbPath),
    dbPath,
  });
  // offline 下不 start：不建立 WS 连接、不认证，渠道出站保持 silent。
  await startChannelForMode(channelMode, channel, server.handler);
  // 档位与出站投递模式入启动日志：部署侧一眼看出「连没连、发不发」。
  console.log(JSON.stringify(serverStartedEvent({
    configPath,
    profileId,
    dbPath,
    channelMode,
    deliveryMode: channel.deliveryMode,
  })));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: 'server_shutdown', signal }));
    await channel.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
