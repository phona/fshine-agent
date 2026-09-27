/**
 * 服务装配：配置 → 存储 → Agent runtime + Context Worker → 计划确认路由 → 企微 handler。
 *
 * 抽出来是为了让同一套装配既能被 `main.ts` 用于生产启动，也能被离线全链 e2e 复用
 * （替换 driver / workerDriver / env / dbPath），避免验收脚本和生产装配各写一遍、
 * 慢慢漂移。渠道的 start/stop 和信号处理留给调用方。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeStore,
  createSqlitePendingPlanConfirmationRepo,
  createSqliteStore,
  loadConfig,
  principalScopeRecords,
} from '@fshine/core';
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
  type CandidateExtractor,
  type ContextTaskRunner,
  type TurnDriver,
} from '@fshine/agent';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import type { AuditStore, TaskPlanRepo } from '@fshine/contracts';
import { createCommitRunner, createPrepareRunner, newGateSecret } from './commit';
import { createMessageHandler } from './handler';
import { createServerReplyHandler } from './reply';
import { asAgentPendingRepo, createPlanConfirmationRoute } from './plan-confirmation-route';
import { loadBusinessSkill } from './business-skill';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ServerAssemblyOverrides {
  /** Process environment used for config, platform wiring and every spawned subprocess. */
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  /** Main Agent driver. Defaults to the configured model driver. */
  driver?: TurnDriver;
  /** 17dz subagent driver. Defaults to the pi coding agent driver. */
  workerDriver?: TurnDriver;
  /** Isolated tool-free driver for Context State extraction. Defaults to `driver`. */
  contextModelDriver?: TurnDriver;
  memoryCandidateExtractor?: CandidateExtractor;
  /** Inject the WeCom SDK client (offline harness); defaults to the real WSClient. */
  channelClientFactory?: () => SdkClientLike;
}

export interface ServerAssembly {
  store: AuditStore;
  runtime: ReturnType<typeof createTaxAgentRuntime>;
  platformTask: ContextTaskRunner;
  /** Shared handler: the exact entry the WeCom channel feeds messages into. */
  handler: ReturnType<typeof createMessageHandler>;
  /** Production channel wiring: progress + awaited plan notices are not dropped. */
  replyHandler: ReturnType<typeof createServerReplyHandler>;
  channel: WecomBotChannel;
  platformRoot?: string;
  planActivationSecret: string;
  close(): Promise<void>;
}

export async function createServerAssembly(overrides: ServerAssemblyOverrides = {}): Promise<ServerAssembly> {
  const env = overrides.env ?? process.env;
  const config = loadConfig({ env, yamlPath: env['AGENT_CONFIG_PATH'] || undefined });
  const platformRoot = config.contextProfiles['17dz']?.root;
  const dbPath = overrides.dbPath ?? path.join(repoRoot, 'data/agent.db');
  const store = createSqliteStore(dbPath);
  const pendingPlanRepo = createSqlitePendingPlanConfirmationRepo(dbPath);

  for (const record of principalScopeRecords(config)) {
    await store.principalScopes.upsert(record);
  }

  // fshine 全进程树声明为 serve 法域：worker 的 bash 子进程、以及服务端直调的
  // dry-run/commit 都受平台 bin/17dz 网关与 serve-policy 守卫的矩阵裁决。
  env.DZ_SERVE = '1';
  // HMAC 密钥进程内生成：重启使未决 commit 自然失效。DZ_GATE_SECRET 故意不进 env——
  // 进程级注入会让模型经 read/工具面拿到密钥自行铸令牌。
  const gateSecret = newGateSecret();
  const planActivationSecret = env['DZ_PLAN_ACTIVATION_SECRET'] ?? newGateSecret();

  const mockStatePath = platformRoot ? ensureMockStatePath(platformRoot) : null;
  if (isPlatformMock()) {
    console.log(JSON.stringify({ event: 'platform_mock_enabled', state: mockStatePath, commitEnabled: true }));
  }

  // 任务计划状态（Phase 6）：AuditStore 的可选成员，存储未实现时缺省（降级不报错）。
  const taskPlans: TaskPlanRepo | undefined = (store as { taskPlans?: TaskPlanRepo }).taskPlans;
  // 业务 skill（架构 §5）：读文件失败/文件缺失都只记日志，不影响启动。
  const businessSkill = await loadBusinessSkill(env);
  console.log(JSON.stringify(businessSkill.text
    ? { event: 'business_skill_loaded', path: businessSkill.path, chars: businessSkill.text.length }
    : { event: 'business_skill_skipped', path: businessSkill.path }));

  const driver = overrides.driver ?? createPiTurnDriver({ env });
  const contextModelDriver = overrides.contextModelDriver ?? driver;
  const memoryCandidateExtractor = overrides.memoryCandidateExtractor
    ?? createLongMemoryCandidateExtractor(createMemoryCandidateModel(contextModelDriver, { timeoutMs: 15_000 }));
  const workerDriver = overrides.workerDriver ?? createPiCodingTurnDriver({
    env,
    // label 表派生根：平台操作的人类可读名来自平台公共 CLI 的第 5 列
    ...(platformRoot ? { platformRoot } : {}),
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
    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      prepareRunner: createPrepareRunner({ platformRoot, gateSecret }),
      commitRunner: createCommitRunner({ platformRoot, gateSecret }),
      commitEnabled: isCommitEnabled(),
    } : {}),
  });

  const confirmationRoute = createPlanConfirmationRoute({
    repo: asAgentPendingRepo(pendingPlanRepo),
    // 激活前先问平台这条计划是否还有效：被新计划取代时给用户确定性的解释，
    // 而不是把 PLAN_NOT_PENDING 吞成一句"处理失败"。
    verifyActivatable: async (pending) => {
      if (!platformRoot) throw new Error('幻账平台根目录未配置');
      const { loadPlanStatus, PlanSupersededError } = await import('@fshine/agent');
      const status = await loadPlanStatus({ platformRoot, planId: pending.planId });
      if (status && status.status !== 'pending') {
        throw new PlanSupersededError(pending.planId, pending.version, pending.taskId);
      }
    },
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
    contextModelDriver,
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
    // 任务计划状态（Phase 6）：存储未启用时缺省，长任务拆解照常、只是没有进度投影。
    ...(taskPlans ? { taskPlans } : {}),
    // 业务 skill（架构 §5）：启动时读文件，每回合进系统提示词；缺失 = 不注入。
    ...(businessSkill.text ? { businessSkill: businessSkill.text } : {}),
  });

  const channel = new WecomBotChannel({ env, ...(overrides.channelClientFactory ? { clientFactory: overrides.channelClientFactory } : {}) });
  const handler = createMessageHandler({ store, runtime, planConfirmation });

  return {
    store,
    runtime,
    platformTask,
    handler,
    replyHandler: createServerReplyHandler(handler),
    channel,
    ...(platformRoot ? { platformRoot } : {}),
    planActivationSecret,
    close: async () => {
      pendingPlanRepo.close();
      closeStore(store);
    },
  };
}
