/**
 * 服务装配入口:配置 → SQLite 任务/审计存储 → Agent runtime + Context Worker → 企微长连接。
 * 启动:npm start(即 node --env-file=.env --import tsx apps/server/main.ts)
 * 平台 Context 未提供通用执行能力时，任务会以 capability_unavailable 阻断。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStore, createSqliteStore, loadConfig, principalScopeRecords } from '@fshine/core';
import { createContextTaskRunner, createPiCodingTurnDriver, createPiTurnDriver, createTaxAgentRuntime } from '@fshine/agent';
import { WecomBotChannel } from '@fshine/channel-wecom';
import { renderBarChartPng } from './chart';
import { createCommitRunner, createPrepareRunner, newGateSecret } from './commit';
import { createMessageHandler } from './handler';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const config = loadConfig({
    env: process.env,
    yamlPath: process.env['AGENT_CONFIG_PATH'] || undefined,
  });
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const dbPath = process.env['DB_PATH'] ?? path.join(repoRoot, 'data/agent.db');
  const store = createSqliteStore(dbPath);

  for (const record of principalScopeRecords(config)) {
    await store.principalScopes.upsert(record);
  }

  // fshine 全进程树声明为 serve 法域：worker 的 bash 子进程、以及服务端
  // 直调的 dry-run/commit 都受平台 serve.sh 网关与 withPlatform 守卫的矩阵裁决。
  // 开发者的交互式 shell 不在本树内，不受影响。
  process.env.FSHINE_MODE = 'serve';
  // HMAC 密钥进程内生成：重启使未决 commit 自然失效（pending 本就 10 分钟过期）。
  const gateSecret = newGateSecret();
  process.env.FSHINE_GATE_SECRET = gateSecret;

  const driver = createPiTurnDriver({ env: process.env });
  const workerDriver = createPiCodingTurnDriver({
    env: process.env,
    // G1 工具门留痕：放行与拦截都进 tool_calls 审计（requestId 串查平台侧）。
    serveGateAudit: (event) => {
      const now = new Date().toISOString();
      void store.toolCalls.insert({
        requestId: event.requestId ?? '',
        toolName: `serve_gate:${event.tool}`,
        safeArguments: { detail: event.detail ?? '' },
        startedAt: now,
        finishedAt: now,
        status: event.allowed ? 'ok' : 'error',
        errorCode: event.allowed ? undefined : 'GATE_BLOCKED',
      }).catch((error) => {
        console.warn(JSON.stringify({ event: 'serve_gate_audit_failed', error: String(error) }));
      });
    },
  });
  const platformRoot = config.contextProfiles['17dz']?.root;
  const platformTask = createContextTaskRunner({
    profiles: config.contextProfiles,
    tasks: store.platformTasks ?? {
      async get() { return null; },
      async upsert() { throw new Error('SQLite platform task store 未启用'); },
    },
    workerDriver,
    profileId: '17dz',
    // 两步确认写开放：执行器存在即启用；缺任一执行器时写流程自动禁用
    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      prepareRunner: createPrepareRunner({ platformRoot, gateSecret }),
      commitRunner: createCommitRunner({ platformRoot, gateSecret }),
    } : {}),
  });

  const runtime = createTaxAgentRuntime({
    driver,
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
    // Leave time for the Main Agent to interpret the subagent's final text
    // after the delegated turn reaches its own deadline.
    turnBudgetMs: (config.contextProfiles['17dz']?.workerTimeoutMs ?? 600_000) + 120_000,
    platformTask,
  });

  const channel = new WecomBotChannel({ env: process.env });

  const sharedHandler = createMessageHandler({ store, runtime });
  // 演示关键词:验证图片回传通道(真实场景 = 17dz artifact 截图,随 P6 接入)
  const DEMO_IMAGE_PATTERN = /发图|测试图片|图片/;

  await channel.start(async (message) => {
    if (DEMO_IMAGE_PATTERN.test(message.text)) {
      return {
        text: '幻晟 202607 凭证金额分布(模拟数据 · 图片通道演示)',
        image: {
          data: renderBarChartPng([1200, 1850, 990, 2400, 1750, 3000, 1500, 2200]),
          filename: 'voucher-202607.png',
        },
      };
    }
    return sharedHandler(message);
  });

  console.log(JSON.stringify({ event: 'server_started', db: dbPath, contextProfiles: Object.keys(config.contextProfiles) }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: 'shutting_down', signal }));
    await channel.stop();
    closeStore(store);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
