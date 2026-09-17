/**
 * V0 装配入口:配置 → SQLite 审计 → MCP host(按 profile 懒加载)→ Agent runtime → 企微长连接。
 * 启动:npm start(即 node --env-file=.env --import tsx apps/server/main.ts)
 * 17dz 真环境未就绪时,可用 D17Z_USE_FAKE=1 接 Fake server 全链路演示。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStore, createSqliteStore, loadConfig, newId, principalScopeRecords } from '@fshine/core';
import { McpHost, type McpHostAudit, type McpToolPolicy } from '@fshine/mcp-host';
import { createPiTurnDriver, createTaxAgentRuntime } from '@fshine/agent';
import { WecomBotChannel } from '@fshine/channel-wecom';
import type { McpProfileConfig, PrincipalCapability } from '@fshine/contracts';
import { renderBarChartPng } from './chart';
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
    driver: createPiTurnDriver({ env: process.env }),
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

  function profileFor(name: string, capabilities: readonly PrincipalCapability[] = []): McpProfileConfig {
    if (useFakeMcp) {
      return {
        command: process.execPath,
        args: ['--import', 'tsx', path.join(repoRoot, 'packages/mcp-fake/src/main.ts')],
        cwd: repoRoot,
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        env: {
          FAKE_ALLOWED_ACCOUNT_SETS: process.env['D17Z_ALLOWED_ACCOUNT_SETS'] ?? '',
          ...(capabilities.some((capability) => capability === 'validate' || capability === 'write') ? { FAKE_ENABLE_WRITE: '1' } : {}),
        },
      };
    }
    const profile = config.mcpProfiles[name];
    if (!profile) throw new Error(`配置里没有名为 ${name} 的 mcpProfile`);
    return profile;
  }

  const combinedToolPolicy: McpToolPolicy = {
    allowedTools: [
      'get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set',
      'get_subject_balance', 'get_auxiliary_balance',
      'validate_voucher', 'submit_voucher', 'submit_voucher_batch', 'get_submission_status',
    ],
    categories: {
      get_login_status: 'read', search_account_sets: 'read', get_current_accounting_period: 'read',
      list_vouchers: 'read', inspect_account_set: 'read', get_subject_balance: 'read', get_auxiliary_balance: 'read', validate_voucher: 'validate',
      submit_voucher: 'write', submit_voucher_batch: 'write', get_submission_status: 'status',
    },
  };

  function hostFor(name: string, capabilities: readonly PrincipalCapability[]): McpHost {
    // The process is shared by profile; tool exposure is narrowed by the
    // request-scoped client in the handler, never by the model.
    const key = `${name}:${[...capabilities].sort().join(',')}`;
    let host = hosts.get(key);
    if (!host) {
      host = new McpHost({ profile: profileFor(name, capabilities), audit, toolPolicy: combinedToolPolicy });
      hosts.set(key, host);
    }
    return host;
  }

  const channel = new WecomBotChannel({ env: process.env });

  const sharedHandler = createMessageHandler({ store, runtime, hostFor });
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
