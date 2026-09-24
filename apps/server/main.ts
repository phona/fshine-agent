/**
 * 服务装配入口:配置 → SQLite 任务/审计存储 → Agent runtime + Context Worker → 企微长连接。
 * 启动:npm start(即 node --env-file=.env --import tsx apps/server/main.ts)
 * 平台 Context 未提供通用执行能力时，任务会以 capability_unavailable 阻断。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStore, createSqlitePendingPlanConfirmationRepo, createSqliteStore, loadConfig, principalScopeRecords } from '@fshine/core';
import {
  createContextTaskRunner,
  createLongMemoryCandidateExtractor,
  createMemoryCandidateModel,
  createPiCodingTurnDriver,
  createPiTurnDriver,
  createTaxAgentRuntime,
  ensureMockStatePath,
  isCommitEnabled,
  isPlatformMock,
} from '@fshine/agent';
import { WecomBotChannel } from '@fshine/channel-wecom';
import { createCommitRunner, createPrepareRunner, newGateSecret } from './commit';
import { createMessageHandler } from './handler';
import { createServerReplyHandler } from './reply';
import { asAgentPendingRepo, createPlanConfirmationRoute } from './plan-confirmation-route';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const config = loadConfig({
    env: process.env,
    yamlPath: process.env['AGENT_CONFIG_PATH'] || undefined,
  });
  const platformRoot = config.contextProfiles['17dz']?.root;
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const dbPath = process.env['DB_PATH'] ?? path.join(repoRoot, 'data/agent.db');
  const store = createSqliteStore(dbPath);
  const pendingPlanRepo = createSqlitePendingPlanConfirmationRepo(dbPath);

  for (const record of principalScopeRecords(config)) {
    await store.principalScopes.upsert(record);
  }

  // fshine 全进程树声明为 serve 法域：worker 的 bash 子进程、以及服务端
  // 直调的 dry-run/commit 都受平台 bin/17dz 网关与 serve-policy 守卫的矩阵裁决。
  // 开发者的交互式 shell 不在本树内，不受影响。
  process.env.DZ_SERVE = '1'; // 平台 serve 法域（E4 命名；旧名由平台双读兼容）
  // HMAC 密钥进程内生成：重启使未决 commit 自然失效（pending 本就 10 分钟过期）。
  // 注意：DZ_GATE_SECRET 故意不进 process.env——worker 与服务端同进程，
  // 进程级注入会让模型经 read/工具面拿到密钥自行铸令牌。密钥只经 commit.ts
  // 单次 spawn 的 extraEnv 传给落账子进程（worker 路径本就不需要它）。
  const gateSecret = newGateSecret();
  const planActivationSecret = process.env['DZ_PLAN_ACTIVATION_SECRET'] ?? newGateSecret();

  // 平台 mock 控制面（DZ_EXECUTOR=mock 时网关换 mock 应答器，gate 照真）：
  // 兜底状态路径必须在 worker/commit 子进程产生前写入本进程 env（全树继承）。
  const mockStatePath = platformRoot ? ensureMockStatePath(platformRoot) : null;
  if (isPlatformMock()) {
    console.log(JSON.stringify({ event: 'platform_mock_enabled', state: mockStatePath, commitEnabled: true }));
  }

  const driver = createPiTurnDriver({ env: process.env });
  const memoryCandidateExtractor = createLongMemoryCandidateExtractor(createMemoryCandidateModel(driver, { timeoutMs: 15_000 }));
  const workerDriver = createPiCodingTurnDriver({
    env: process.env,
    planActivationSecret,
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
      // 落账总闸（派生规则）：mock 之下写假状态默认放开；真平台须显式 FSHINE_REAL_COMMIT=1。
      commitEnabled: isCommitEnabled(),
    } : {}),
  });

  const confirmationRoute = createPlanConfirmationRoute({
    repo: asAgentPendingRepo(pendingPlanRepo),
    activate: async (pending) => {
      if (!platformRoot) throw new Error('幻账平台根目录未配置');
      const { activatePendingPlan } = await import('@fshine/agent');
      await activatePendingPlan({
        platformRoot,
        planId: pending.planId,
        evidence: 'user-confirmed',
        activationSecret: planActivationSecret,
      });
    },
  });
  const planConfirmation = {
    handle: confirmationRoute.handle,
    savePending: async (pending: { planId: string; version: number; taskId: string; principalId: string; sessionId: string; requestId: string; userText: string }) => {
      await pendingPlanRepo.savePending({ ...pending, decision: 'confirm', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), evaluation: {} });
    },
  };

  const runtime = createTaxAgentRuntime({
    driver,
    // Context State extraction is a separate tool-free background turn using the same provider/model.
    contextModelDriver: driver,
    sessions: store.sessions,
    conversationLog: store.conversationLog,
    contextStates: store.contextStates,
    memoryRecords: store.memoryRecords,
    memoryCandidateExtractor,
    sessionTtlMs: config.sessionTtlMs,
    // Leave time for the Main Agent to interpret the subagent's final text
    // after the delegated turn reaches its own deadline.
    turnBudgetMs: (config.contextProfiles['17dz']?.workerTimeoutMs ?? 600_000) + 120_000,
    platformTask,
  });

  const channel = new WecomBotChannel({ env: process.env });

  const sharedHandler = createMessageHandler({ store, runtime, planConfirmation });
  await channel.start(createServerReplyHandler(sharedHandler));

  console.log(JSON.stringify({ event: 'server_started', db: dbPath, contextProfiles: Object.keys(config.contextProfiles) }));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ event: 'shutting_down', signal }));
    await channel.stop();
    pendingPlanRepo.close();
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
