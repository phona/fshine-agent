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
  effectiveDeploymentEnv,
  loadConfig,
  principalScopeRecords,
} from '@fshine/core';
import {
  createContextTaskRunner,
  createBackgroundTaskManager,
  createPlatformExecutionGate,
  createLongMemoryCandidateExtractor,
  createMemoryCandidateModel,
  createPiCodingTurnDriver,
  createPiTurnDriver,
  createTaxAgentRuntime,
  loadOperationArgSpecs,
  loadProposalSchema,
  reviewProposalWithDriver,
  newGateSecret,
  parsePiThinkingLevel,
  planDraftExample,
  type CandidateExtractor,
  type ContextTaskRunner,
  type BackgroundTaskManager,
  type PlatformExecutionGate,
  type TurnDriver,
} from '@fshine/agent';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import type { AuditStore, ChannelReply, ChannelRoute, ReplyHandler, TaskPlanRepo } from '@fshine/contracts';
import { resolveActiveProfileId, turnBudgetMsFor } from '@fshine/contracts';
import { createProposalCommitRunner } from './proposal-commit';
import { createMessageHandler } from './handler';
import { sweepUndeliveredTaskRuns } from './background-delivery';
import { createPlanConfirmationWiring } from './plan-confirmation-route';
import { loadBusinessSkill } from './business-skill';
import { workerDispatchModeOf, type WorkerDispatchMode } from './dispatch-mode';

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
  /** Execution-layer subagent driver. Defaults to the pi coding agent driver. */
  workerDriver?: TurnDriver;
  /** Isolated tool-free driver for Context State extraction. Defaults to `driver`. */
  contextModelDriver?: TurnDriver;
  memoryCandidateExtractor?: CandidateExtractor;
  /** Inject the WeCom SDK client (offline harness); defaults to the real WSClient. */
  channelClientFactory?: () => SdkClientLike;
  /** Inject the whole channel (offline harness):装配硬前提（D-126/D-134）的失败形态注入用。 */
  channel?: WecomBotChannel;
  /** Host-only dispatch mode override; default comes from FSHINE_WORKER_DISPATCH_MODE. */
  workerDispatchMode?: WorkerDispatchMode;
}

/**
 * background 模式的装配硬前提（D-126 / D-134，与 assertPlatformOperationsHealthy 同一
 * 立场：无人值守服务"起不来"比"跑到一半才发现能力不可达"好）。两项都只在 background
 * 委派模式下检查——inline 的交付走回合回执，无主动发送与后台事件续跑需求：
 *   · 渠道主动发送能力（sendToConversation）：background 下 inline 收集已关
 *     （collectProduced:false），后台完成与通知只有主动发送一条路，缺它则一切后台
 *     结果都无法交付，只会在运行期逐次留 failed；
 *   · 会话转录存储（conversationLog）：后台完成事件的续跑与交付都要写会话历史，
 *     缺失时 runtime 只能在运行期抛错、事件静默丢失。
 */
export function assertBackgroundAssemblyReady(args: {
  workerDispatchMode: WorkerDispatchMode;
  channel: { sendToConversation?: unknown };
  conversationLog?: unknown;
}): void {
  if (args.workerDispatchMode !== 'background') return;
  if (typeof args.channel.sendToConversation !== 'function') {
    throw new Error([
      'background 委派模式要求渠道具备主动发送能力（sendToConversation）：',
      '后台完成与通知只能经主动发送送达，缺它则一切后台结果都无法交付。',
      '请接入具备主动发送能力的渠道，或改回 inline 模式（FSHINE_WORKER_DISPATCH_MODE=inline）。',
    ].join('\n'));
  }
  if (!args.conversationLog) {
    throw new Error([
      'background 委派模式要求会话转录存储（conversationLog）：',
      '后台完成事件的续跑与交付都依赖它，缺失时事件在运行期被静默丢弃。',
      '请检查存储装配，或改回 inline 模式（FSHINE_WORKER_DISPATCH_MODE=inline）。',
    ].join('\n'));
  }
}

export interface ServerAssembly {
  store: AuditStore;
  runtime: ReturnType<typeof createTaxAgentRuntime>;
  platformTask: ContextTaskRunner;
  backgroundTasks: BackgroundTaskManager;
  /** Shared handler: the exact entry the WeCom channel feeds messages into. */
  handler: ReturnType<typeof createMessageHandler>;
  /** Production channel wiring: progress + awaited plan notices are not dropped. */
  replyHandler: ReplyHandler;
  channel: WecomBotChannel;
  platformRoot?: string;
  /** Active profile 的键（C5）：单 profile 派生，多/零 profile 未显式指定时 undefined。 */
  activeProfileId?: string;
  planActivationSecret: string;
  workerDispatchMode: WorkerDispatchMode;
  /**
   * 部署配置生效后的环境：config/agent.yaml 的 yaml 派生值打底，非空 env 覆盖。
   * 驱动 / 渠道 / handler / business skill 都用这一份；暴露给 main.ts 的停机排干
   * 这类装配外读取点，避免它们再去读 process.env 而漏掉 yaml 源。
   */
  effectiveEnv: NodeJS.ProcessEnv;
  /**
   * 实际使用的 SQLite 库路径（overrides.dbPath > 非空 DB_PATH > 仓库根 data/agent.db）。
   * main.ts 的启动日志用它，不再自己直读 process.env.DB_PATH。
   */
  dbPath: string;
  close(): Promise<void>;
}

export async function createServerAssembly(overrides: ServerAssemblyOverrides = {}): Promise<ServerAssembly> {
  const env = overrides.env ?? process.env;
  const config = loadConfig({ env, yamlPath: env['AGENT_CONFIG_PATH'] || undefined });
  // 部署配置（issue #20 切片 C+D）：yaml 是源、非空 env 是覆盖口。合并规则唯一实现
  // 在 @fshine/core 的 effectiveDeploymentEnv（非空 env 覆盖 yaml、空串不覆盖、未建模
  // 键原样透传）；这里集中构造一次，沿既有 seam 下传——驱动 / 渠道 / handler /
  // business skill 继续按 env 读取，消费方零改动。scripts/smoke-wecom.ts 复用同一函数。
  const effectiveEnv: NodeJS.ProcessEnv = effectiveDeploymentEnv(config, env);
  const workerDispatchMode = overrides.workerDispatchMode ?? workerDispatchModeOf(effectiveEnv);
  // Active profile 派生（C5）：单 profile → 其键；零/多 profile → undefined（各消费点
  // 按无平台能力降级，runner 侧 resolveContextProfile fail-closed）。宿主不取实例名缺省。
  const activeProfileId = resolveActiveProfileId(config.contextProfiles);
  const activeProfile = activeProfileId === undefined ? undefined : config.contextProfiles[activeProfileId];
  const platformRoot = activeProfile?.root;
  // 接口完整性硬门：lint 红就抛错、拒绝启动（不建存储、不接渠道），判据与输出见上方函数注释。
  if (platformRoot) assertPlatformOperationsHealthy(platformRoot);
  // 宿主库路径链（2026-11-10 仲裁修订令）：overrides.dbPath（测试 / e2e harness 的注入）
  // > effectiveEnv.DB_PATH（yaml `store.dbPath` 派生值，非空 env 覆盖，合并规则唯一实现
  // 在 effectiveDeploymentEnv）> 仓库根 data/agent.db。空串按未配置处理（--env-file 的
  // `DB_PATH=` 形态不该把库指到空路径）。
  const configuredDbPath = (effectiveEnv['DB_PATH'] ?? '').trim();
  const dbPath = overrides.dbPath
    ?? (configuredDbPath === '' ? path.join(repoRoot, 'data/agent.db') : configuredDbPath);
  const store = createSqliteStore(dbPath);
  // W2 产物库字节根：与库同处（布局 data/sessions/<sessionId>/artifacts/）。随
  // dbPath 覆盖走——测试把库指到临时位置时，产物字节也落在那里，不污染真实 data/。
  const dataRoot = path.dirname(dbPath);
  if (!store.taskRuns) throw new Error('SQLite task run store 未启用');

  // One host-owned admission gate is shared by inline Workers, background Workers, resumes, and
  // proposal commits executed by a prepared host-confirmation run. It only applies host backlog
  // backpressure (maxQueue); platform concurrency tolerance belongs to the execution layer
  // (2026-11-10 ruling — no host-side concurrency knob).
  const platformQueueRaw = Number.parseInt(effectiveEnv['FSHINE_PLATFORM_QUEUE_CAPACITY'] ?? '', 10);
  const platformExecutionGate: PlatformExecutionGate = createPlatformExecutionGate({
    maxQueue: Number.isFinite(platformQueueRaw) && platformQueueRaw >= 0 ? platformQueueRaw : 100,
  });

  for (const record of principalScopeRecords(config)) {
    await store.principalScopes.upsert(record);
  }

  // fshine 全进程树声明为 serve 法域：worker 的 bash 子进程、以及服务端直调的
  // 提案落账都受平台网关与 serve-policy 守卫的矩阵裁决。
  // 注入 env 的测试里旧代码改的就是那个注入对象（不是真实进程 env），这里保持同一
  // 取舍；生产 / 脚本传入的 env 就是 process.env，而服务端直调的 plan CLI 等 spawn
  // 点以 {...process.env} 为基境——这层进程级声明必须留在原地，否则法域被削弱。
  if (env === process.env) process.env.EXECUTION_SERVE = '1';
  effectiveEnv.EXECUTION_SERVE = '1';
  // HMAC 密钥进程内生成：重启使未决 commit 自然失效。EXECUTION_GATE_SECRET 故意不进 env——
  // 进程级注入会让模型经 read/工具面拿到密钥自行铸令牌。
  const gateSecret = newGateSecret();
  // 计划激活密钥：yaml `execution.planActivationSecret` > 非空 env；都缺省 = 进程内生成。
  // 空串按未配置处理（--env-file 的空 `KEY=` 不该把密钥变成空串）。
  const planActivationSecret = (effectiveEnv['EXECUTION_PLAN_ACTIVATION_SECRET'] ?? '').trim() || newGateSecret();

  // 任务计划状态（Phase 6）：AuditStore 的可选成员，存储未实现时缺省（降级不报错）。
  const taskPlans: TaskPlanRepo | undefined = (store as { taskPlans?: TaskPlanRepo }).taskPlans;
  // 业务 skill（架构 §5）：读文件失败/文件缺失都只记日志，不影响启动。
  const businessSkill = await loadBusinessSkill(effectiveEnv);
  console.log(JSON.stringify(businessSkill.text
    ? { event: 'business_skill_loaded', path: businessSkill.path, chars: businessSkill.text.length }
    : { event: 'business_skill_skipped', path: businessSkill.path }));

  // 分层模型接缝：Main Agent 可单独配更快的模型（LLM_MAIN_MODEL），执行层 worker 仍走
  // LLM_MODEL——worker 驱动的输入原样不动（pi-coding-driver 只认 env.LLM_MODEL）。
  // 装配层持有配置、驱动只收参数：Main 专用变量在这里解析成显式 modelId/thinkingLevel，
  // pi-driver 不再自行读取。两个变量都缺省时 createPiTurnDriver 收到的 options 与旧装配
  // 逐字段一致（恒等断言钉在 model-seam-wiring.test.ts），行为零变化。
  // 空白值视为未配置：注释掉值留空不该挡启动（模型选择器不是安全门，宽进）；真正要
  // fail-fast 的是思考深度词表——非法值在此即抛，报错点名 LLM_MAIN_THINKING_LEVEL。
  const mainModelOverride = (effectiveEnv['LLM_MAIN_MODEL'] ?? '').trim();
  const mainThinkingRaw = (effectiveEnv['LLM_MAIN_THINKING_LEVEL'] ?? '').trim();
  const mainThinkingLevel = mainThinkingRaw
    ? parsePiThinkingLevel(mainThinkingRaw, 'LLM_MAIN_THINKING_LEVEL')
    : undefined;
  const driver = overrides.driver ?? createPiTurnDriver({
    env: effectiveEnv,
    ...(mainModelOverride ? { modelId: mainModelOverride } : {}),
    ...(mainThinkingLevel ? { thinkingLevel: mainThinkingLevel } : {}),
  });
  // Context 抽取缺省跟随 Main（`?? driver` 排在 Main 覆盖解析之后，结构上保证跟随）：
  // 抽取与主回合同量级（无工具、单轮、短输出），Main 换小模型时抽取跟着换——同一供应商
  // 配额下的同量级任务，没有理由让它单独留在强模型上；也不逼部署为它再配一套变量。
  // 确要隔离（如抽取质量劣化）时仍可显式注入 overrides.contextModelDriver，语义不变。
  const contextModelDriver = overrides.contextModelDriver ?? driver;
  const memoryCandidateExtractor = overrides.memoryCandidateExtractor
    ?? createLongMemoryCandidateExtractor(createMemoryCandidateModel(contextModelDriver, { timeoutMs: 15_000 }));
  const workerDriver = overrides.workerDriver ?? createPiCodingTurnDriver({
    env: effectiveEnv,
    // Pi 会话存放位置（FSHINE_PI_AGENT_DIR）：驱动读的是 process.env 直连而非 options.env
    // （切片约定消费方零改动），故装配把 yaml / env 生效值显式下传；缺省不传，
    // 驱动保持原回落链（process.env → <cwd>/data/pi-agent）。
    ...((effectiveEnv['FSHINE_PI_AGENT_DIR'] ?? '').trim()
      ? { agentDir: (effectiveEnv['FSHINE_PI_AGENT_DIR'] ?? '').trim() }
      : {}),
    // label 表派生根：平台操作的人类可读名来自平台公共 CLI 的第 5 列
    ...(platformRoot ? { platformRoot } : {}),
    // 网关调用形式（C7b 收口补漏）：label/规格/语义/协议四张派生表与 serve 门共用同一
    // profile.gateway 声明——C7b 起 loader 对未声明 gateway 一律降级空表（不回退实例名），
    // 装配不穿线 = 生产静默零进度帧、零参数摘要、写关闭前置判定失效。未声明 = 不传，
    // loader 按同一安全缺省降级，与"未配平台根"同判据。
    ...(activeProfile?.gateway ? { gateway: activeProfile.gateway } : {}),
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
    executionGate: platformExecutionGate,
    // C5：active profile 派生（单 profile → 其键；零/多 → undefined，消费方 fail-closed）。
    profileId: activeProfileId,
    // 写路径隔离复核（第 2 包生产接线）：装配必须注入真实复核驱动，
    // 未注入时提案创建路径直接失败（不再记 skipped 就继续）。
    // 驱动 = contextModelDriver（隔离回合、无工具，与上下文抽取同一驱动面），
    // 不是 Main 驱动，也不是一个独立评委模型（那是仍待定的另一步）。
    proposalReviewTurn: (input) => reviewProposalWithDriver(contextModelDriver, input),
    // 提案 schema 取问（接口文档 §5）：按 profile 的 root 与 gateway spawn
    // operation list --json，取 proposal.create 行的 proposalSchema。
    proposalSchemaLoader: (args) => loadProposalSchema(args.platformRoot, args.gateway),

    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      // 提案落账后端（B 波 B4，C 波后唯一的落账路径）：配了平台根就恒定接线。这里**没有**
      // "这个部署允不允许落账"的开关位（2026-11-08 架构裁定）——写能不能真落地归执行层，
      // 由平台自己的 commit 门裁决并给出拒绝 / warning / dryrun 提示，宿主经既有失败链路
      // 如实转述。宿主只承诺自己确实做到的事（后端已注入），做不到就如实说配置故障。
      //
      // gateway 必须一起传（2026-11-08 修，PR #21 过程中定位）：C7b 起
      // `loadOperationProtocols(root, gateway)` 对未声明/非法的 gateway **一律降级空表**
      // （operation-labels.ts，绝不回退遗留网关名），而空表 ⇒ `operationForProtocol` 找不到
      // `proposal.commit` 角色 ⇒ `refuseCommit` ⇒ 每条写链都死在 commit 这一步
      // （acceptance 5.2 实跑 `change_intent_commit_failed`、意图 status=failed、基线
      // write-chain-51 从 committed:true 掉到 false）。同文件的 schema loader(:312)、
      // plan 确认接线(:330)、operation 规格(:368) 都传了 gateway，只漏了这一处。
      proposalCommitRunner: createProposalCommitRunner({
        platformRoot,
        gateSecret,
        ...(activeProfile?.gateway ? { gateway: activeProfile.gateway } : {}),
      }),
      // plan 申请的命令形态（变更项 ②）：worker 提示词的许可段只经注入拿到它，通用编排层
      // 不出现网关名。取值单一来源 = planDraftExample(activeProfile?.gateway)（C7b 起
      // gateway 未声明即抛，宿主不持任何实例网关名缺省；形状与平台 plan schema 的一致性
      // 由 plan-teaching.test 钉住）。
      planCommandForm: planDraftExample(activeProfile?.gateway),
    } : {}),
  });
  // The task manager may cancel a waiting confirmation using the original principal/session/task
  // identity. This route is host-owned and does not synthesize positive user confirmation evidence.
  const planConfirmation = createPlanConfirmationWiring({ dbPath, platformRoot, planActivationSecret, gateway: activeProfile?.gateway });
  const backgroundTasks = createBackgroundTaskManager({
    runner: platformTask,
    repo: store.taskRuns,
    executionGate: platformExecutionGate,
    onCancelPending: async (run, scope) => {
      let cancelled = false;
      try {
        cancelled = (await planConfirmation.cancelTask(scope.principalId, scope.sessionId, run.taskId)) > 0;
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'background_confirmation_cancel_failed',
          taskId: run.taskId,
          runId: run.runId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        return false;
      }
      const intents = store.changeIntents;
      if (intents) {
        const pending = await intents.findPendingBySession(scope.principalId, scope.sessionId, run.taskId);
        if (pending) {
          await intents.updateStatus(pending.intentId, 'cancelled');
          cancelled = true;
        }
      }
      return cancelled;
    },
  });
  // Old queued/running background work is queryable but never replayed after process restart.
  // This must finish before main.ts snapshots GC pins or starts the channel.
  await backgroundTasks.recoverInterrupted();

  // 计划确认门接线收敛到 apps/server/plan-confirmation-route.ts 的工厂（D-013）：
  // assembly 与 scripts/ask.ts 共用同一份装配，不再逐字复刻。
  // 平台 args 规格（任务 1 会话实体的查表依据）：与 worker 驱动同一份平台数据源，一次性
  // 派生后显式传表（operation-labels 的"纯数据 + 显式传表"纪律——调用方持有 Map 并注入）。
  // 派生失败/未配平台根 → 空表 → runtime 不提取得会话实体（安全缺省，判定回退三个来源）。
  const operationArgSpecs = platformRoot ? await loadOperationArgSpecs(platformRoot, activeProfile?.gateway) : undefined;
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
    turnBudgetMs: turnBudgetMsFor(activeProfile),
    platformTask,
    backgroundTasks,
    workerDispatchMode,
    // 召回事实台账的结构化事实源（D-065）：存储未启用时不注入（静默降级）。
    ...(store.platformTasks ? { platformTasks: store.platformTasks } : {}),
    // 会话实体提取的规格查表依据（任务 1）：空表/未配平台根时不注入（安全缺省）。
    ...(operationArgSpecs && operationArgSpecs.size > 0 ? { operationArgSpecs } : {}),
    // 任务计划状态（Phase 6）：存储未启用时缺省，长任务拆解照常、只是没有进度投影。
    ...(taskPlans ? { taskPlans } : {}),
    // 业务 skill（架构 §5）：启动时读文件，每回合进系统提示词；缺失 = 不注入。
    ...(businessSkill.text ? { businessSkill: businessSkill.text } : {}),
    // 执行层称谓（C2）：从 active profile 的 executorLabel 声明注入 Main Agent 系统
    // 提示词；未声明 = 宿主中性缺省（DEFAULT_EXECUTOR_LABEL），不静默取实例名。
    ...(activeProfile?.executorLabel ? { executorLabel: activeProfile.executorLabel } : {}),
  });

  // platformRoot 必须传给渠道：附件要落在平台工作区内，否则 worker 的路径守卫会把每个
  // 附件都判成"工作区外"，症状是"读不到附件"这种指代不清的报错（2026-10-07 实测）。
  const channel = overrides.channel ?? new WecomBotChannel({
    env: effectiveEnv,
    ...(platformRoot ? { platformRoot } : {}),
    ...(overrides.channelClientFactory ? { clientFactory: overrides.channelClientFactory } : {}),
  });
  // D-126 / D-134：background 模式的装配硬前提在此收口（渠道主动发送 + 会话转录存储），
  // 缺能力即拒绝启动——语义与判据见 assertBackgroundAssemblyReady 的注释。
  assertBackgroundAssemblyReady({ workerDispatchMode, channel, conversationLog: store.conversationLog });
  const pushToConversation = (route: ChannelRoute, reply: ChannelReply) => {
    if (!channel.sendToConversation) throw new Error('企微渠道未提供主动交付能力');
    return channel.sendToConversation(route, reply);
  };
  // 一次性崩溃恢复收尾（P1）：后台完成事件只活在内存 promise 链上，进程重启后"终态但
  // 投递未决"的 run 会永远停在 pending（工作区被 pin、用户拿不到已完成的结果）。清扫
  // 不重跑 Worker，只重投已入库（sha256 校验过）的产物与已存结果文本；不可恢复的标
  // failed 并给用户可行动通知。接线点必须在渠道就绪之后（未启动的渠道主动交付会抛
  // "尚未启动"），故包在 channel.start 末尾——生产 main.ts、e2e harness 与探针脚本都经
  // 同一入口，无需各自记得调用；清扫自身吞掉一切错误只留日志，不影响 start 的成败。
  const startChannel = channel.start.bind(channel);
  channel.start = async (replyHandler: ReplyHandler) => {
    await startChannel(replyHandler);
    void sweepUndeliveredTaskRuns({ store, pushToConversation }).catch((error) => {
      console.error(JSON.stringify({
        event: 'background_recovery_sweep_failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  };
  const handler = createMessageHandler({
    store,
    runtime,
    planConfirmation,
    env: effectiveEnv,
    workerDispatchMode,
    pushToConversation,
    ...(platformRoot ? { platformRoot } : {}),
    dataRoot,
  });
  // Completion ingress is registered before the channel can accept the first turn. Every event
  // is serialized with user turns by handler.enqueueTaskEvent and delivered without its frame.
  const unsubscribeTaskEvents = backgroundTasks.subscribe((event) => handler.enqueueTaskEvent(event));

  return {
    store,
    runtime,
    platformTask,
    backgroundTasks,
    handler,
    replyHandler: handler,
    channel,
    ...(platformRoot ? { platformRoot } : {}),
    ...(activeProfileId !== undefined ? { activeProfileId } : {}),
    planActivationSecret,
    workerDispatchMode,
    effectiveEnv,
    dbPath,
    close: async () => {
      await backgroundTasks.shutdown();
      unsubscribeTaskEvents();
      planConfirmation.close();
      closeStore(store);
    },
  };
}
