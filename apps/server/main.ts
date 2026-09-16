/**
 * V0 装配入口:配置 → SQLite 审计 → MCP host(按 profile 懒加载)→ Agent runtime → 企微长连接。
 * 启动:npm start(即 node --env-file=.env --import tsx apps/server/main.ts)
 * 17dz 真环境未就绪时,可用 D17Z_USE_FAKE=1 接 Fake server 全链路演示。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStore, createSqliteStore, loadConfig, newId, principalScopeRecords } from '@fshine/core';
import { McpHost, type McpHostAudit } from '@fshine/mcp-host';
import { createTaxAgentRuntime, OpenAICompatibleChatModel } from '@fshine/agent';
import { NodeWebSocketImpl, WecomBotChannel } from '@fshine/channel-wecom';
import type { McpProfileConfig } from '@fshine/contracts';
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

  const runtime = createTaxAgentRuntime({
    model: OpenAICompatibleChatModel({ env: process.env }),
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
  });

  const audit: McpHostAudit = {
    onStart(event) {
      void store.toolCalls.insert({
        requestId: event.requestId,
        toolName: event.toolName,
        safeArguments: event.safeArguments,
        startedAt: event.startedAt,
        status: 'running',
      });
    },
    onEnd(event) {
      void store.toolCalls.finish(event.requestId, {
        finishedAt: event.finishedAt,
        status: event.status,
        errorCode: event.errorCode,
        traceId: event.traceId,
        source: event.source,
        artifactId: event.artifactId,
      });
    },
  };

  const hosts = new Map<string, McpHost>();
  const useFakeMcp = process.env['D17Z_USE_FAKE'] === '1';

  function profileFor(name: string): McpProfileConfig {
    if (useFakeMcp) {
      return {
        command: process.execPath,
        args: ['--import', 'tsx', path.join(repoRoot, 'packages/mcp-fake/src/main.ts')],
        cwd: repoRoot,
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        env: { FAKE_ALLOWED_ACCOUNT_SETS: process.env['D17Z_ALLOWED_ACCOUNT_SETS'] ?? '' },
      };
    }
    const profile = config.mcpProfiles[name];
    if (!profile) throw new Error(`配置里没有名为 ${name} 的 mcpProfile`);
    return profile;
  }

  function hostFor(name: string): McpHost {
    let host = hosts.get(name);
    if (!host) {
      host = new McpHost({ profile: profileFor(name), audit });
      hosts.set(name, host);
    }
    return host;
  }

  const channel = new WecomBotChannel({ env: process.env, WebSocketImpl: NodeWebSocketImpl });

  await channel.start(createMessageHandler({ store, runtime, hostFor }));

  console.log(JSON.stringify({ event: 'server_started', db: dbPath, fakeMcp: useFakeMcp }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: 'shutting_down', signal }));
    await channel.stop();
    for (const host of hosts.values()) host.stop();
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
