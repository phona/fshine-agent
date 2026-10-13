/**
 * 服务装配：配置 → 存储 → Agent runtime + Context Worker → 计划确认路由 → 企微 handler。
 *
 * 抽出来是为了让同一套装配既能被 `main.ts` 用于生产启动，也能被离线全链 e2e 复用
 * （替换 driver / workerDriver / env / dbPath），避免验收脚本和生产装配各写一遍、
 * 慢慢漂移。渠道的 start/stop 和信号处理留给调用方。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  closeStore,
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
  loadOperationArgSpecs,
  newGateSecret,
  type CandidateExtractor,
  type ContextTaskRunner,
  type TurnDriver,
} from '@fshine/agent';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import type { AuditStore, ReplyHandler, TaskPlanRepo } from '@fshine/contracts';
import { turnBudgetMsFor } from '@fshine/contracts';
import { createProposalCommitRunner } from './proposal-commit';
import { createMessageHandler } from './handler';
import { createPlanConfirmationWiring } from './plan-confirmation-route';
import { loadBusinessSkill } from './business-skill';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 接口完整性硬门：平台自己的 operations lint 不过，服务就不起。
 *
 * 为什么卡在启动而不是跑到一半：无人值守服务"起不来"比"跑到一半才发现能力不可达"好。
 * 2026-10-08 实证：一个执行域的 validator 不可达，worker 只能自己写校验脚本重造校验，
 * 而执行层文档里那句 node -e 又被 serve 的 bash 门拦死——白烧一轮还发出误导帧。域声明了
 * contract.js 却没有可达的校验 operation、UI 域缺 prepare/commit/verify 之类，都在这个
 * 门的射程内（判据归平台 lint 所有，宿主只负责"不过就不起"，不在这里复刻任何一条规则）。
 *
 * 语义：非零退出、exec 自身失败（脚本缺失/不可执行/超时）一律转成带 lint 输出的 Error
 * 抛出，拒绝启动；stdout 与 stderr 全进错误信息——人要能从这里看出缺什么。platformRoot
 * 未配时不跑这个门：没有根就无从判断（与 loadOperationArgSpecs 的"未配即空表"同一立场：
 * 缺的是判据，不是放行）。
 */
function assertPlatformOperationsHealthy(platformRoot: string): void {
  const script = path.join(platformRoot, 'scripts', 'lint-operations.js');
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd: platformRoot, encoding: 'utf8' });
    const detail = typeof stdout === 'string' ? stdout.trim() : '';
    if (detail) console.log(JSON.stringify({ event: 'platform_operations_lint_passed', detail }));
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
      message?: string;
    };
    const stdout = chunkText(failure.stdout);
    const stderr = chunkText(failure.stderr);
    throw new Error([
      `平台接口完整性检查未通过，服务拒绝启动（根 ${platformRoot}，退出码 ${failure.status ?? 'n/a'}）。`,
      '平台接口完整性 lint 输出（缺什么从这里看）：',
      stdout || '(stdout 空)',
      stderr || '(stderr 空)',
      // exec 自身失败（脚本缺失/不可执行/被杀）时 lint 没吐字，才需要底层异常文本；
      // lint 红着退出时它的输出已经在上两行，再抄一遍只是噪音。
      ...(stdout || stderr ? [] : [failure.message ? `执行检查本身失败：${failure.message}` : '']),
    ].filter((line) => line !== '').join('\n'));
  }
}

/** exec 失败的 stdio 块取文本（字符串/Buffer/缺失三态都收）。 */
function chunkText(chunk: string | Buffer | null | undefined): string {
  if (typeof chunk === 'string') return chunk.trim();
  return chunk ? chunk.toString('utf8').trim() : '';
}

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
  replyHandler: ReplyHandler;
  channel: WecomBotChannel;
  platformRoot?: string;
  planActivationSecret: string;
  close(): Promise<void>;
}

export async function createServerAssembly(overrides: ServerAssemblyOverrides = {}): Promise<ServerAssembly> {
  const env = overrides.env ?? process.env;
  const config = loadConfig({ env, yamlPath: env['AGENT_CONFIG_PATH'] || undefined });
  const platformRoot = config.contextProfiles['17dz']?.root;
  // 接口完整性硬门：lint 红就抛错、拒绝启动（不建存储、不接渠道），判据与输出见上方函数注释。
  if (platformRoot) assertPlatformOperationsHealthy(platformRoot);
  const dbPath = overrides.dbPath ?? path.join(repoRoot, 'data/agent.db');
  const store = createSqliteStore(dbPath);

  for (const record of principalScopeRecords(config)) {
    await store.principalScopes.upsert(record);
  }

  // fshine 全进程树声明为 serve 法域：worker 的 bash 子进程、以及服务端直调的
  // 提案落账都受平台网关与 serve-policy 守卫的矩阵裁决。
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
  // 平台健康冷却时长（Lane 2 治标补法）：连续 AUTH 类平台失败达阈值后，会话在此时长内
  // 不再发起平台调用（宿主前置拦截 + 合成终稿）。部署侧可用 FSHINE_PLATFORM_COOLDOWN_MS
  // 覆盖；非法/缺省值忽略并用默认 10 分钟（platform-health.ts 的唯一定义）。
  const cooldownRaw = Number.parseInt(env['FSHINE_PLATFORM_COOLDOWN_MS'] ?? '', 10);
  const platformCooldownMs = Number.isFinite(cooldownRaw) && cooldownRaw > 0 ? cooldownRaw : undefined;
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
    // A1：绕开平台执行器的告警出口（披露是增强不是门——与附件披露、计划通知同族）。
    // 判据在 platformExecutorBypassed：整轮只有本地执行、零计划门放行的平台执行调用、
    // 却又落盘了产物。落两处：结构化日志行给运维实时看，tool_calls 一行给事后按请求串查
    // （平台审计在另一个仓，宿主不跨仓读它）。
    onExecutorBypassed: (event) => {
      console.warn(JSON.stringify({ event: 'platform_executor_bypassed', ...event }));
      const now = new Date().toISOString();
      void store.toolCalls.insert({
        requestId: event.requestId,
        toolName: 'platform_executor_bypassed',
        safeArguments: {
          taskId: event.taskId,
          localCalls: event.localCalls,
          planGateCalls: event.planGateCalls,
          auxiliaryCalls: event.auxiliaryCalls,
          producedFiles: event.producedFiles,
        },
        startedAt: now,
        finishedAt: now,
        status: 'ok',
        errorCode: 'PLATFORM_EXECUTOR_BYPASSED',
      }).catch((error) => {
        console.warn(JSON.stringify({ event: 'executor_bypassed_audit_failed', error: String(error) }));
      });
    },
    // G1 工具门留痕：放行与拦截都进 tool_calls 审计（requestId 串查平台侧）。
    serveGateAudit: (event) => {
      const now = new Date().toISOString();
      void store.toolCalls.insert({
        requestId: event.requestId ?? '',
        toolName: `serve_gate:${event.tool}`,
        // detail 是摘要（命令原文 / 路径 / 计划 calls 摘要）；reason 是被拦原因
        // （门的拒绝理由 / 计划裁决）。两者都落：只有 detail 的行看得见
        // "发生了什么"、看不见"为什么"，排查时还要回去拿 worker 转录。
        safeArguments: { detail: event.detail ?? '', ...(event.reason ? { reason: event.reason } : {}) },
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
      async listBySession() { return []; },
    },
    workerDriver,
    profileId: '17dz',
    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      // 提案落账后端（B 波 B4，C 波后唯一的落账路径；B 波那个"落账后端接不接"的开关已
      // 退役，后端恒接）：是否放行由 isCommitEnabled 单独派生——mock ⇒ 全链路放开；真平台 ⇒
      // 还须显式 FSHINE_REAL_COMMIT=1，否则确认码只到达"确认收到但不写"（confirm_held），
      // 零写入。没有第二级接线开关可串，真平台的那道闸因此也少一个能被人忘掉的环节。
      proposalCommitRunner: createProposalCommitRunner({ platformRoot, gateSecret }),
      proposalCommitEnabled: isCommitEnabled(env),
    } : {}),
  });

  // 计划确认门接线收敛到 apps/server/plan-confirmation-route.ts 的工厂（D-013）：
  // assembly 与 scripts/ask.ts 共用同一份装配，不再逐字复刻。
  const planConfirmation = createPlanConfirmationWiring({ dbPath, platformRoot, planActivationSecret });
  // 平台 args 规格（任务 1 会话实体的查表依据）：与 worker 驱动同一份平台数据源，一次性
  // 派生后显式传表（operation-labels 的"纯数据 + 显式传表"纪律——调用方持有 Map 并注入）。
  // 派生失败/未配平台根 → 空表 → runtime 不提取得会话实体（安全缺省，判定回退三个来源）。
  const operationArgSpecs = platformRoot ? await loadOperationArgSpecs(platformRoot) : undefined;
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
    turnBudgetMs: turnBudgetMsFor(config.contextProfiles['17dz']),
    platformTask,
    // 召回事实台账的结构化事实源（D-065）：存储未启用时不注入（静默降级）。
    ...(store.platformTasks ? { platformTasks: store.platformTasks } : {}),
    // 会话实体提取的规格查表依据（任务 1）：空表/未配平台根时不注入（安全缺省）。
    ...(operationArgSpecs && operationArgSpecs.size > 0 ? { operationArgSpecs } : {}),
    // 任务计划状态（Phase 6）：存储未启用时缺省，长任务拆解照常、只是没有进度投影。
    ...(taskPlans ? { taskPlans } : {}),
    // 业务 skill（架构 §5）：启动时读文件，每回合进系统提示词；缺失 = 不注入。
    ...(businessSkill.text ? { businessSkill: businessSkill.text } : {}),
    // 平台健康冷却（Lane 2）：连续 AUTH 类平台失败达阈值后会话进入冷却，冷却期内不再
    // 发起平台调用。时长经 env 覆盖（见上），阈值固定 2（platform-health.ts 缺省）。
    ...(platformCooldownMs ? { platformCooldownMs } : {}),
  });

  // platformRoot 必须传给渠道：附件要落在平台工作区内，否则 worker 的路径守卫会把每个
  // 附件都判成"工作区外"，症状是"读不到附件"这种指代不清的报错（2026-10-07 实测）。
  const channel = new WecomBotChannel({
    env,
    ...(platformRoot ? { platformRoot } : {}),
    ...(overrides.channelClientFactory ? { clientFactory: overrides.channelClientFactory } : {}),
  });
  const handler = createMessageHandler({ store, runtime, planConfirmation, env, ...(platformRoot ? { platformRoot } : {}) });

  return {
    store,
    runtime,
    platformTask,
    handler,
    replyHandler: handler,
    channel,
    ...(platformRoot ? { platformRoot } : {}),
    planActivationSecret,
    close: async () => {
      planConfirmation.close();
      closeStore(store);
    },
  };
}
