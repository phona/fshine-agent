/**
 * server 装配（宿主接线）：
 *   渠道消息 → 可信身份（principalId/sessionId 取自渠道事实）→ 回合运行时 → 渠道回复。
 *
 * 本切片不做（后续切片）：计划确认 / 产物回收 / 提案。CAP-01 S1：入站附件登记为
 * pending 文件事实（查重先于附件分支），带文字的消息激活本会话 TTL 内 pending；run_js
 * 执行器与文件清单注入由本装配构造注入（runtime 不 spawn）；回合产出文件走主动投递（B）——
 * handler 只返回 text，文件经注入的 fileDelivery.sendToConversation 发出（无端口 fail-closed，
 * 非 live 记 suppressed 不记 sent，投递失败用户可见「未送达」）。
 * R4（P5/P6/P4）：会话按 promise 链串行化（同会话不并发）；`runtime.dispatchMode='background'`
 * 时启动建进程级 TaskRunner（含重启恢复 pump）与通知 outbox（注入 sink），受理即回执；
 * 缺省 'inline' = 上段现行为。
 * 执行面 = profile 声明的网关（缺省仓内 dummy CLI，不触网）；模型 = 真实 Pi 驱动（env）。
 * 任务底账 = SQLite（B 类）：会话共享一个库，list/get 按 principal+session 收口。
 *
 * P0 装配同源：门（单一 profile / gateway）与启动时装载（底账、角色文本、技能）留在本文件，
 * 门之后的装配链走 scripts/ask-runtime.ts 的共享核心（执行面/驱动/底账/提示词均可注入）——
 * 与 ask/redo、eval runner 同一装配点（守卫见 scripts/p0-assembly-single-point.test.ts）。
 * server 不做评测隔离门、不设 EXECUTION_AUDIT_PATH（部署面现行为，零变化）。
 *
 * 测试注入点（假渠道回归用，见 server.test.ts）：createDrivers / createExecutionFace；
 * 缺省实现走真实 Pi 驱动与仓内 dummy 客户端——测试替身不触碰任何真实平台。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  AppConfig,
  ChannelRoute,
  ContextProfileConfig,
  DeliveryReceipt,
  IncomingChannelMessage,
  OutgoingFileReply,
  ReplyHandler,
} from '@fshine/contracts';
import { applyExecutorLabel, loadAgentProfile } from '../../packages/agent/src/agent-profile';
import {
  createFileStore,
  fileStoragePathOf,
  INBOUND_MAX_FILE_BYTES,
  type FileScope,
  type FileStore,
  type RegisteredFile,
} from '../../packages/agent/src/file-store';
import { createRunJsExecutor, type RunJsExecutor } from '../../packages/agent/src/run-js-executor';
import {
  applyRecalcDeliveryGate,
  collectRecalcReports,
  createRecalcXlsxExecutor,
  createSofficeRecalcEngine,
  type RecalcXlsxExecutor,
} from '../../packages/agent/src/recalc-xlsx-executor';
import { FILES_GENERATED_NOTICE, mainProtocolNoteFor, type Session, type TurnFileRef } from '../../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  type NotificationOutbox,
  type NotificationSink,
} from '../../packages/agent/src/notifications';
import { createResourcePolicy, fileRefTtlMsOf, resolveRuntimeConfig } from '../../packages/agent/src/resource-policy';
import { SessionPersistence } from '../../packages/agent/src/session-persistence';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import type { TaskExecutor, TaskRunner } from '../../packages/agent/src/task-runner';
import { defaultMainSkillsDir, loadMainSkillDelivery, loadWorkerSkills } from '../../packages/agent/src/worker-skills';
import {
  assembleSessionCore,
  attachNotificationOutbox,
  createBackgroundDispatch,
  type DriverFactory,
  type ExecutionFace,
} from '../../scripts/ask-runtime';
import { createAttachmentFactQueue, createScopedNoteQueue } from './attachment-facts';
import { AttachmentNudge, type NudgeClock } from './attachment-nudge';
import { deliverTaskResult } from './task-completion-delivery';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 渠道重投幂等窗口（有界 FIFO；同 messageId 的回执在此窗口内重放）。 */
const MESSAGE_REPLY_LIMIT = 1024;

/** 执行面：结构化执行客户端 + 本轮允许集合（从执行层自述的 access=read 派生）。 */
export type { ExecutionFace };

export interface ServerDeps {
  /** 生效环境（LLM_* / 渠道凭据由入口以 effectiveDeploymentEnv 合入）。 */
  env: NodeJS.ProcessEnv;
  config: AppConfig;
  /** SQLite 任务底账路径（入口缺省 .runtime/state.db）。 */
  dbPath: string;
  /** dummy 执行层审计落盘目录；缺省 .runtime/server/state。 */
  stateDir?: string;
  /**
   * B1 会话转录持久化根目录；缺省 `<dbPath 所在目录>/sessions`（同一部署状态根——
   * 重启用同一 dbPath 即恢复；测试各用临时 dbPath 自动隔离，无跨用例串扰）。
   * 每 principal 在其下获得独立子树（隔离），装配层是唯一构造具体存储处。
   */
  sessionStoreDir?: string;
  /** 测试注入：Pi 回合驱动工厂；缺省真实 Pi 驱动（读 env）。 */
  createDrivers?: DriverFactory;
  /** 测试注入：执行面；缺省仓内 dummy CLI（按 profile root+gateway spawn）。 */
  createExecutionFace?: (profile: ContextProfileConfig, env: NodeJS.ProcessEnv) => Promise<ExecutionFace>;
  /** 测试注入：后台执行回合（dispatchMode=background 时使用）；缺省真实 Worker 回合执行器。 */
  taskExecutor?: TaskExecutor;
  /** 测试注入 / 部署注入：通知投递 sink（background 时建 outbox；真实 WeCom 适配面归后续切片）。 */
  notificationSink?: NotificationSink;
  /**
   * CAP-01 S1 交付端口（v8 §7 主动投递 B）：装配层注入渠道的 sendToConversation 面与生效
   * 模式。缺省 undefined = 无投递端口：有文件的回合 fail-closed（用户可见
   * 「文件未送达（当前渠道不支持文件投递）」+ 事件 delivery_unavailable）。
   */
  fileDelivery?: FileDeliveryPort;
  /**
   * 测试注入：run_js 执行器工厂（装配构造、按 fileStore 闭包）；缺省 = 真实受限执行器
   * （Node 权限模型，见 run-js-executor.ts——runtime 不 spawn，spawn 归执行器）。
   */
  createRunJsExecutor?: (fileStore: FileStore) => RunJsExecutor;
  /**
  /**
   * 测试注入：recalc_xlsx 执行器工厂（装配构造、按 fileStore 闭包）；缺省 = 真实 soffice
   * 引擎（PATH 可见且版本 26.8.3 才上工具面；缺失/版本不符 = fail-closed 不上工具）。
   */
  createRecalcXlsxExecutor?: (fileStore: FileStore) => RecalcXlsxExecutor | undefined;
  /**
   * 测试注入：主动追问的时钟/调度器（缺省真实 setTimeout；注入后测试用手动时钟推进，
   * 不真 sleep 30 秒）。只作用于附件追问定时器，不影响其它回合逻辑。
   */
  attachmentNudgeClock?: NudgeClock;
  logger?: (line: Record<string, unknown>) => void;
}

export interface Server {
  handler: ReplyHandler;
  /** 显式触发通知投递（同进程有界重试；background 无 outbox 时为空操作）。 */
  deliverPending(): Promise<void>;
  /**
   * 释放底账与 B1 会话存储句柄。返回 Promise：调用方可 await 以确保存储句柄已释放
   * （进程内「重启」= close 后同 dbPath 重建时须先释放，否则同文件二次打开会读到陈旧内存态）。
   */
  close(): Promise<void>;
}

/**
 * 文件投递端口（CAP-01 S1，v8 §7 主动投递 B）：装配层注入渠道的主动投递面——server 只传
 * **文件**（正文走 handler 回执文本；四必守 #1：两边只发各自的东西，否则文本发两遍）。
 * deliveryMode 来自渠道装配事实：非 'live' 的部署一律记 `suppressed`，**不许记 `sent`**——
 * silent 闸会让 sendToConversation 返回带 sent 的回执但用户看不到任何东西（不得采信）。
 */
export interface FileDeliveryPort {
  readonly deliveryMode: 'live' | 'silent';
  sendToConversation(route: ChannelRoute, files: readonly OutgoingFileReply[]): Promise<DeliveryReceipt>;
  /**
   * 主动投递一条**文字**（纯附件后追问等宿主主动消息）。缺省 = 该部署面不支持文字主动
   * 投递（追问按 suppressed 记账，不冒充 sent）。非 live 部署由调用方先行抑制，不调用它。
   */
  sendText?(route: ChannelRoute, text: string): Promise<DeliveryReceipt>;
}

/** 无投递端口 / 非 live 部署时给用户的兜底话术（v8 §7 四必守 #4 fail-closed；事件另记 delivery_unavailable）。 */
const FILE_DELIVERY_UNAVAILABLE_NOTE = '文件未送达（当前渠道不支持文件投递）';
/** live 投递失败时给用户的如实话术（v8 §7 失败必须可见；事件另记 delivery_failed，不记 sent）。 */
const FILE_DELIVERY_FAILED_NOTE = '文件未送达（投递失败，请重试或联系管理员）';
/** recalc 投递闸拦下含公式但无 pass 实算报告的表格时给用户的如实话术（事件另记 recalc_delivery_gated）。 */
const RECALC_DELIVERY_GATED_NOTE = '部分表格未通过公式实算校验，未予发送（请确认表格已重算校验后再试）';
/** 混合批次（部分投递成功、部分被闸拦）时的如实话术：不让用户误以为全部送达。 */
const RECALC_DELIVERY_PARTIAL_NOTE = '部分表格未通过公式实算校验，未予发送；其余文件已发送';

/**
 * 入站附件上限（20MB，2026-11-17 CAP-01 owner 裁决：100MB 必 OOM，实测 1.1MB 文件处理
 * 峰值 396MB）：与 file-store 的流式兜底 `INBOUND_MAX_FILE_BYTES` 同值单源。**登记前**
 * 按契约 `IncomingAttachment.bytes` 校验：超限整条消息拒绝——一个附件都不登记、不起
 * 模型回合（不静默丢弃、不带超限附件开回合），记一条结构化事件（含 bytes 与上限），
 * 回执给用户明确话术。判据是 `> 上限`：恰好 20MB 放行（「上限 20MB」= 最多可发 20MB，
 * 与 file-store 既有扫描/入站纪律的 `> max` 判据一致）。渠道适配器仍按渠道侧限额先行
 * 拒收；这里是 handler 直调路径（假渠道/测试/未来渠道）的确定性防线。
 */
const INBOUND_ATTACHMENT_LIMIT_BYTES = INBOUND_MAX_FILE_BYTES;
/** 超限话术（用户可见；机械事实 bytes/limit 只进结构化事件，不进话术）。 */
const ATTACHMENT_TOO_LARGE_NOTE =
  `附件超过 ${Math.floor(INBOUND_ATTACHMENT_LIMIT_BYTES / 1024 / 1024)}MB 上限，请压缩或拆分后再发`;

/**
 * 单一 profile 解析（fail-closed）：未指定时 0 个或多个 profile 都拒绝启动，
 * 最小切片不做多 profile 选择，也不静默挑一个。
 */
export function resolveSingleProfile(config: AppConfig): { id: string; profile: ContextProfileConfig } {
  const ids = Object.keys(config.contextProfiles);
  if (ids.length !== 1) {
    throw new Error(`server 需要单一 contextProfile（当前 ${ids.length} 个）——本切片不做多 profile 选择。`);
  }
  const id = ids[0]!;
  return { id, profile: config.contextProfiles[id]! };
}

/**
 * 文件区 workspace 根（CAP-01 S1）：与会话转录存储同一部署状态根——按 dbPath 派生，
 * 重启用同一 dbPath 即落在同一 workspace。字节位置按 (principal, session) 哈希派生
 * （见 packages/agent/src/file-store.ts），不入库、不进转录。
 */
export function workspaceRootOf(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'workspace');
}

export async function createServer(deps: ServerDeps): Promise<Server> {
  const { id: profileId, profile } = resolveSingleProfile(deps.config);
  if (profile.gateway === undefined && deps.createExecutionFace === undefined) {
    throw new Error(`contextProfile ${profileId} 缺少 gateway——server 需要执行层挂载声明。`);
  }

  const log = deps.logger ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const taskRegistry = createSqliteTaskRegistry(deps.dbPath);
  // 解析后配置只读一次：fileStore 的 TTL 由它派生（单一配置源；本文件不重解释 runtime 段）。
  const resolvedRuntime = resolveRuntimeConfig(deps.config.runtime);
  // CAP-01 S1：文件区监管（唯一写侧）建在底账同一引擎连接上（不开第二个库连接）。
  const workspaceRoot = workspaceRootOf(deps.dbPath);
  const fileStore = createFileStore({
    store: taskRegistry.store,
    workspaceRoot,
    ttlMs: fileRefTtlMsOf(resolvedRuntime),
  });
  // CAP-01 S1：run_js 执行器（装配构造；Node 权限模型的受限子进程，runtime 不 spawn）。
  const runJsExecutor = (deps.createRunJsExecutor ?? ((fileStoreRef: FileStore) =>
    createRunJsExecutor({ fileStore: fileStoreRef, nodeModulesDir: path.join(REPO_ROOT, 'node_modules') })))(fileStore);
  // recalc_xlsx（Main 宿主面）：引擎 unavailable（无 soffice / 版本不符）即不构造执行器 →
  // 工具面无 recalc_xlsx（fail-closed）；探测事实进结构化日志，不进用户话术。
  const recalcXlsxExecutor = deps.createRecalcXlsxExecutor
    ? deps.createRecalcXlsxExecutor(fileStore)
    : (() => {
        const engine = createSofficeRecalcEngine();
        const executor = createRecalcXlsxExecutor({
          fileStore,
          engine,
          onEngineEvent: (event) => log({ event: 'recalc_engine_probe', ...event }),
        });
        return executor.available ? executor : undefined;
      })();
  /**
   * CAP-01 S1 清单注入（机械事实）：每回合开始由 runtime 取走本会话已激活（TTL 内）文件。
   * 投影 fileId/name/bytes + activatedAt（收到时间），不含内容/路径/sha256。
   */
  const fileManifestProvider = (principalId: string, sessionId: string): readonly TurnFileRef[] =>
    fileStore.listActiveFiles({ scope: { principalId, sessionId }, now: Date.now() });
  // 角色文本与技能面在启动时装载一次：配置坏即启动失败，不静默降级。
  const profileMd = await loadAgentProfile();
  const workerSkills = await loadWorkerSkills(profile.root, profile.skillRoots);
  // Main 技能面（唯一机制）：固定 `<repo>/.agents/skills` → catalog；目录为空时 promptBlock
  // 空串 → 提示逐字节不变；catalog 非空才交出 read_skill 登记表（不读配置键、无模式开关）。
  const mainSkills = await loadMainSkillDelivery(defaultMainSkillsDir());
  // catalog 字节数进启动日志（证据面）：0 = 空索引（技能面未启用），不静默。
  log({ event: 'main_skills_loaded', catalogBytes: mainSkills.catalogBytes });
  // 写面开关（runtime.allowWriteOperations；缺省 false = 只读）：协议文本与装配允许集同源。
  const allowWriteOperations = deps.config.runtime?.allowWriteOperations === true;
  const mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, profile.executorLabel)}${mainSkills.promptBlock}\n\n${mainProtocolNoteFor(allowWriteOperations)}`;
  const stateDir = deps.stateDir ?? path.join(REPO_ROOT, '.runtime', 'server', 'state');

  // B1 会话转录持久化：装配层是唯一构造具体存储处（基于 Pi SessionManager 的独立存储层）。
  // cwd 跨重启必须稳定（Pi 会话 header 记录 cwd；变了会解析到不同身份，见
  // session-persistence.ts 的 (principalId, sessionId) 唯一映射）。
  const sessionStoreDir = deps.sessionStoreDir ?? path.join(path.dirname(deps.dbPath), 'sessions');
  const sessionPersistence = new SessionPersistence({ rootDir: sessionStoreDir, cwd: REPO_ROOT });

  // P5：资源策略进程级一份（跨会话共享账本）；缺省 runtime 段 = 现行为缺省（前台并发 4 / 排队 16）。
  const dispatchMode = deps.config.runtime?.dispatchMode ?? 'inline';
  const policy = createResourcePolicy(deps.config.runtime);
  // 附件事实/系统注记队列与主动追问（进程内，按 (principal, session) 收口）。
  // 事实出队即在下一回合注入；追问定时器注入时钟（测试不真 sleep），close() 全清。
  const attachmentFacts = createAttachmentFactQueue();
  const systemNotes = createScopedNoteQueue();
  const attachmentNudge = new AttachmentNudge({
    afterMs: resolvedRuntime.attachmentNudgeAfterMs,
    allowWriteOperations,
    ...(deps.attachmentNudgeClock === undefined ? {} : { clock: deps.attachmentNudgeClock }),
    ...(deps.fileDelivery === undefined ? {} : { delivery: deps.fileDelivery }),
    enqueueSystemNote: (principalId, sessionId, note) => systemNotes.enqueue(principalId, sessionId, note),
    log,
  });
  // P6/P4：background 才启用新受理/后台/通知路径；缺省 inline 零新增路径。
  let runner: TaskRunner | undefined;
  let outbox: NotificationOutbox | undefined;
  let notificationAttachment: ReturnType<typeof attachNotificationOutbox> | undefined;
  /**
   * B 切片（工单回执收敛）：本会话已在同一回合拿到结果的任务（快活）——完成投递对其抑制
   * （结果已由模型在本回合转述，不重复发两遍）。条目一次性消费（完成回调核销后即删），
   * 不跨进程（重启后只有未完成的慢活会完成回调，快活不存在跨重启完成）。
   */
  const relayedInTurnTasks = new Map<string, Set<string>>();
  const markRelayedInTurn = (sessionKey: string, taskId: string): void => {
    let set = relayedInTurnTasks.get(sessionKey);
    if (set === undefined) {
      set = new Set();
      relayedInTurnTasks.set(sessionKey, set);
    }
    set.add(taskId);
  };
  if (dispatchMode === 'background') {
    const completionDelivery = deps.fileDelivery;
    runner = (await createBackgroundDispatch({
      env: deps.env,
      profile,
      stateDir,
      registry: taskRegistry,
      policy,
      workerSkills,
      ...(deps.config.runtime === undefined ? {} : { runtime: deps.config.runtime }),
      allowWriteOperations,
      emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
      ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
      ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
      ...(deps.taskExecutor !== undefined ? { taskExecutor: deps.taskExecutor } : {}),
      // B 切片：后台任务确认完成 → 结果主动发回原会话（走既有主动投递面 fileDelivery.sendText）。
      // 回调经会话链串行（快活抑制判定须在受理回合结束后做）；投递失败/抑制只记事件，不改任务事实。
      onTaskCompleted: (completion) => {
        const sessionKey = `${completion.principalId}\u0000${completion.sessionId}`;
        enqueueSessionTurn(sessionKey, async () => {
          // 快活（结果已在本回合交给模型）：抑制，结果不重复发两遍。
          if (relayedInTurnTasks.get(sessionKey)?.delete(completion.taskId) === true) {
            log({
              event: 'task_result_delivery_suppressed',
              principalId: completion.principalId,
              sessionId: completion.sessionId,
              taskId: completion.taskId,
              deliveryMode: completionDelivery?.deliveryMode ?? 'unavailable',
              reason: 'relayed_in_turn',
            });
            return;
          }
          await deliverTaskResult({
            taskId: completion.taskId,
            principalId: completion.principalId,
            sessionId: completion.sessionId,
            resultText: completion.resultText,
          }, {
            ...(completionDelivery === undefined ? {} : { delivery: completionDelivery }),
            log,
          });
        });
      },
    })).runner;
    if (deps.notificationSink !== undefined) {
      outbox = createNotificationOutbox({ dbPath: deps.dbPath, sink: deps.notificationSink });
      // server 进程：事实落库后异步触发投递（终态通知即刻推送；同进程有界重试）。
      // R5 B 通道：同一挂钩缓冲机械事实，下一次回合开始前以普通 user 消息注入主对话。
      notificationAttachment = attachNotificationOutbox(taskRegistry, outbox, { deliverOnRecord: true });
    }
    // 重启恢复：新进程第一次 pump（queued 重领 / 过期租约 → result_unknown 不重放 / completed 不重跑）。
    runner.pump();
  }

  /**
   * R5 投递驱动（零定时器）：除落库即试投（deliverOnRecord）外，每次用户回合开始时
   * drain 一次 pending（piggyback 在既有回合上；无 outbox 时为空操作）。
   */
  const drainNotifications = async (): Promise<void> => {
    if (outbox !== undefined) await outbox.deliverPending();
  };

  /** 会话按（principal, session）双键缓存：群聊里不同用户不共享同一个会话对象。 */
  const sessions = new Map<string, Promise<Session>>();
  const sessionFor = (principalId: string, sessionId: string): Promise<Session> => {
    const key = `${principalId}\u0000${sessionId}`;
    let pending = sessions.get(key);
    if (pending === undefined) {
      pending = (async () => {
        // B1：为本 (principal, session) 打开/新建独立存储句柄（跨 principal 物理隔离），
        // 作为 runtime 的转录端口注入——打开即从存储载入转录，回合后增量持久化。
        const transcriptStore = await sessionPersistence.openOrCreate(principalId, sessionId);
        // 共享装配核心：执行面缺省 = 仓内 dummy CLI（按 profile root+gateway spawn），
        // 驱动缺省 = 真实 Pi 驱动；底账/提示词/技能为启动时装载的同一份（注入不回写）。
        const assembled = await assembleSessionCore({
          env: deps.env,
          profile,
          principalId,
          sessionId,
          dbPath: deps.dbPath,
          stateDir,
          allowWriteOperations,
          emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
          taskRegistry,
          mainSystemPrompt,
          workerSkills,
          ...(mainSkills.registry === undefined ? {} : { mainSkillRegistry: mainSkills.registry }),
          policy,
          dispatchMode,
          // runtime 段随装配核心进会话（单一配置源）：taskRunWaitMs（B 切片短等待窗口）与
          // 回合时限等旋钮由 resolveRuntimeConfig 在核心内统一解析，不再各自单传。
          ...(deps.config.runtime === undefined ? {} : { runtime: deps.config.runtime }),
          ...(runner === undefined ? {} : { taskRunner: runner }),
          ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
          ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
          ...(notificationAttachment === undefined ? {} : { taskFactProvider: notificationAttachment.taskFactProvider }),
          // 目标 A/B：纯附件机械事实与主动追问的系统注记走同一 injections 机制（take 即出队）。
          attachmentFactProvider: attachmentFacts.take,
          systemNoteProvider: systemNotes.take,
          // CAP-01 S1：run_js 执行器（装配构造）与文件清单注入器（机械事实）同源注入。
          // CAP-01 S2：交办复制端口与执行层文件桥同源注入（**同一 fileStore 实例**——文件区
          // 监管唯一写侧）。桥承担回程登记（data.files → 新 file_id、剥 path/base64）与任务
          // out/ 兜底扫描（unexecuted/failed 也扫，v8 §10-3）。出站参数翻译只认部署声明：
          // `fileParams` 来自 profile（键缺失 = 未声明 = 不翻译）；dirParams 当前无部署键，
          // 保持不传（执行层声明目录参数时再走同一条装配路径）。
          runJsExecutor,
          // recalc_xlsx：仅 Main 宿主面（Worker 面由 runtime 恒定不上）；引擎不可用则不注入。
          ...(recalcXlsxExecutor === undefined ? {} : { recalcXlsxExecutor }),
          // recalc 重算开销（R4 资源账）：耗时结构化事件进日志，不进用户话术。
          onRecalcCost: (event) => log({ event: 'recalc_cost', ...event }),
          // CAP-01 ④：内存墙结构化事件（runId/side/bytes/exitCode/exitSignal/stderr 尾窗）——
          // 日志能查到是哪次、多大、怎么死的；用户话术同句由 runtime 出口统一。
          onRunJsMemoryExit: (event) => log({ event: 'run_js_memory_exit', principalId, sessionId, ...event }),
          // CAP-01 symlink 收窄：运行目录布局不安全（预植软链/非真目录）→ 拒跑的结构化事件
          // （runId/哪一项/实际类型/side/taskId）——日志可查；用户只见统一失败话术。
          onRunJsLayoutUnsafe: (event) => log({ event: 'run_js_layout_unsafe', principalId, sessionId, ...event }),
          // 文件引用被拒的机械 reason（missing/foreign/expired/pending/bytes_missing）：
          // 此前从未注入、生产无任何日志事实。只进日志；用户/模型只见统一话术（防存在性 oracle）。
          onFileRefUnavailable: (reason) => log({ event: 'file_ref_unavailable', principalId, sessionId, reason }),
          taskInputCopier: fileStore,
          taskExecutionBridge: {
            store: fileStore,
            ...(profile.fileParams === undefined ? {} : { fileParams: profile.fileParams }),
            onSkip: (reason) => log({ event: 'task_file_bridge_skip', principalId, sessionId, reason }),
          },
          // 任务 out/ 兜底扫描的逐项拒收（此前只取 files，skipped 被丢弃）：数量 + reason 分布。
          onTaskOutputSweepSkipped: (event) => log({ event: 'task_output_sweep_skipped', principalId, sessionId, ...event }),
          fileManifestProvider,
          transcriptStore,
          // fail-open 日志：转录读/写失败不阻塞回合，只上报（错误面由入口按既有归类处理）。
          onTranscriptError: (error) =>
            log({
              event: 'transcript_store_error',
              principalId,
              sessionId,
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        return assembled.session;
      })();
      sessions.set(key, pending);
      // 建立失败不缓存：fail-closed 的错误不钉死给后续消息。
      pending.catch(() => sessions.delete(key));
    }
    return pending;
  };

  /**
   * P5-T02 同会话串行化：handler 在 `acquire('foreground')` 之前按会话排 promise 链
   * （前序失败不阻塞后续；链尾用完即清）。两条并发消息都处理、转录不互相覆盖。
   */
  const sessionChains = new Map<string, Promise<unknown>>();
  function enqueueSessionTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = sessionChains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    sessionChains.set(key, tail);
    void tail.then(() => {
      if (sessionChains.get(key) === tail) sessionChains.delete(key);
    });
    return next;
  }

  /**
   * P7-T06 渠道重投幂等（重复消息）：同 (principal, session, messageId) 只产生一次回执，
   * 重投按既有回执幂等重放——查重先于一切副作用（不新起 Main 回合、不新建任务、不重复执行）；
   * 有界 FIFO（超出淘汰最旧）；处理失败不缓存（渠道可重试，不伪造回执）。
   */
  const messageReplies = new Map<string, Promise<string>>();
  const rememberMessageReply = (key: string, reply: Promise<string>): void => {
    messageReplies.set(key, reply);
    if (messageReplies.size > MESSAGE_REPLY_LIMIT) {
      const oldest = messageReplies.keys().next().value;
      if (oldest !== undefined && oldest !== key) messageReplies.delete(oldest);
    }
  };

  /**
   * CAP-01 S1 入站附件登记：本条消息携带的每个附件登记为 pending 行（流式 sha256 +
   * copy 进 workspace，不引用原路径）。WeCom 现实一条文件消息一个附件；契约允许多个，
   * 逐个登记，任一失败即抛（回执失败，渠道可重投；重复行由 TTL 清孤儿兜底）。
   */
  const registerInboundAttachments = (message: IncomingChannelMessage, scope: FileScope): RegisteredFile[] => {
    const registered: RegisteredFile[] = [];
    for (const attachment of message.attachments ?? []) {
      registered.push(fileStore.registerInboundFile({ scope, name: attachment.filename, sourcePath: attachment.path }));
    }
    return registered;
  };

  /**
   * CAP-01 S1 交付（v8 §7 主动投递 B；失败必须可见）：
   *   · 无端口 → fail-closed：用户可见「未送达」话术 + 事件 delivery_unavailable（四必守 #4）；
   *   · deliveryMode 非 live → 不发起投递，记 `suppressed`（**不许记 sent**——silent 闸的
   *     回执会假报 sent 而用户什么都看不到，宿主不得采信，四必守 #3）；
   *   · live 投递失败 → 结构化事件（含已送达份数，来自 receipt.parts）+ 用户话术，绝不记 sent；
   *   · live 成功 → 事件记 sent（唯一允许 sent 的分支）。
   * handler 仍只返回 text（四必守 #1）：文件字节经端口单独发出，不进回执文本。
   *
   * 投递去重（用户级不变量）：同一回合里 **(sha256, 文件名)** 相同的交付项只发第一份。
   * 判据是实际交付字节的 sha256（登记时已 copy 进 workspace，与 file_refs 行同源）——
   * 不按路径/时间/内容相似度猜；文件名原值参与键（同名不同字节、同字节不同名照常各发）。
   * 被去重的项不产生任何额外事件（事件里的 files = 实际投递份数）。
   *
   * R7-F3：投递结果一旦成功就**不得被日志写失败改写**——sent 事件写在投递 try 之外自成
   * 一段；写失败只降级成一条独立的观测事件（file_delivery_log_write_failed，status 仍
   * sent），绝不改道进投递失败分支、绝不让用户话术出现「未送达/请重试」（否则用户重试
   * 同一产物 → file_refs 两行）。
   */
  const deliverTurnFiles = async (input: {
    files: readonly TurnFileRef[];
    scope: FileScope;
    channel: string;
    conversationId: string;
    principalId: string;
    sessionId: string;
  }): Promise<{ status: 'sent' | 'suppressed' | 'delivery_unavailable' | 'delivery_failed' | 'recalc_gated'; files: number; note?: string }> => {
    const base = {
      principalId: input.principalId,
      sessionId: input.sessionId,
    };
    if (deps.fileDelivery === undefined) {
      log({ event: 'file_delivery', ...base, files: input.files.length, status: 'delivery_unavailable' });
      return { status: 'delivery_unavailable', files: input.files.length, note: FILE_DELIVERY_UNAVAILABLE_NOTE };
    }
    if (deps.fileDelivery.deliveryMode !== 'live') {
      log({
        event: 'file_delivery',
        ...base,
        files: input.files.length,
        status: 'suppressed',
        deliveryMode: deps.fileDelivery.deliveryMode,
      });
      return { status: 'suppressed', files: input.files.length };
    }
    // 字节从文件区派生布局现读（产物在登记时已 copy 进 workspace，原件路径从不进话术）。
    // 同一回合的重复交付（同 sha256 + 同名）在投递层收成一份；顺序保序（先到者投递）。
    const seen = new Set<string>();
    const readFiles: Array<{ name: string; bytes: Buffer }> = [];
    for (const file of input.files) {
      const data = readFileSync(fileStoragePathOf(workspaceRoot, input.scope, file.fileId, file.name));
      const key = `${createHash('sha256').update(data).digest('hex')}\u0000${file.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      readFiles.push({ name: file.name, bytes: data });
    }
    // recalc 投递闸（步骤 ③；时序决定终判落在这里：recalc 报告在独立 runDir、可能晚于
    // run-js out/ 扫描才产生）。缺省未注入 recalc 执行器 = enabled=false，逐字节不变。
    const gateEnabled = recalcXlsxExecutor !== undefined;
    const gate = gateEnabled
      ? await applyRecalcDeliveryGate({
          files: readFiles,
          reports: collectRecalcReports(workspaceRoot, input.scope),
          enabled: true,
        })
      : { outgoing: readFiles, gated: [] as Array<{ name: string; sha256: string; reason: string }> };
    if (gate.gated.length > 0) {
      log({
        event: 'recalc_delivery_gated',
        ...base,
        files: gate.gated.length,
        items: gate.gated,
      });
    }
    const outgoing: OutgoingFileReply[] = gate.outgoing.map((f) => ({ data: f.bytes, filename: f.name }));
    const files = outgoing.length;
    // 所有待投递项都被闸拦下：不发空批、如实告知（fail-closed；非渠道投递失败，不记 sent）。
    if (files === 0 && gate.gated.length > 0) {
      log({ event: 'file_delivery', ...base, files: 0, status: 'recalc_gated' });
      return { status: 'recalc_gated', files: 0, note: RECALC_DELIVERY_GATED_NOTE };
    }
    let receipt: DeliveryReceipt;
    try {
      receipt = await deps.fileDelivery.sendToConversation(
        { channel: input.channel, conversationId: input.conversationId },
        outgoing,
      );
    } catch (error) {
      // 投递失败事实（v8 §7）：结构化事件 + 用户话术；receipt.parts 里先到的 ACK 只作
      // 「已送达份数」照实记录，不把整批记成 sent。
      const parts = (error as { receipt?: { parts?: readonly { kind: string }[] } }).receipt?.parts ?? [];
      const delivered = parts.filter((part) => part.kind === 'file').length;
      log({
        event: 'file_delivery',
        ...base,
        files,
        status: 'delivery_failed',
        delivered,
        message: error instanceof Error ? error.message : String(error),
      });
      return { status: 'delivery_failed', files, note: FILE_DELIVERY_FAILED_NOTE };
    }
    // 走到这里 = 投递已成功，结果不再有任何改写路径（R7-F3）：日志写失败只降级为独立
    // 观测事件；观测事件也写不进（logger 持续抛错）时同样到此为止——除吞掉外别无动作，
    // 用户话术与回合结果已按「sent」定型。
    try {
      log({ event: 'file_delivery', ...base, files, status: 'sent', parts: receipt.parts.length });
    } catch (logError) {
      try {
        log({
          event: 'file_delivery_log_write_failed',
          ...base,
          files,
          status: 'sent',
          message: logError instanceof Error ? logError.message : String(logError),
        });
      } catch {
        // 观测事件写也失败：无第二观测面可用；投递结果已成立，不翻转、不重投、不触达用户。
      }
    }
    // 混合批次（有被闸拦的文件、也有成功投递的）：如实附「部分未投递」话术——
    // 不让用户正文停留在「汇总完成。」而误以为全部表格送达（如实交付 B 类责任）。
    return {
      status: 'sent',
      files,
      ...(gate.gated.length > 0 ? { note: RECALC_DELIVERY_PARTIAL_NOTE } : {}),
    };
  };

  const handler: ReplyHandler = async (message) => {
    const channel = (message.channel ?? 'wecom').trim() || 'wecom';
    // 可信身份取自渠道事实：principal = 发消息的人，session = 聊天窗口（conversationId）。
    const principalId = `${channel}:${message.wecomUserId}`;
    const sessionId = `${channel}:${message.conversationId}`;
    const principal = deps.config.principals[principalId];
    if (principal === undefined || principal.enabled !== true) {
      log({ event: 'message_refused', principalId, sessionId, messageId: message.messageId, reason: 'principal_not_enabled' });
      return `该账号（${principalId}）未开通使用权限，请联系管理员开通。`;
    }
    // 渠道重投（同 messageId）命中：幂等重放既有回执（无任何新副作用）。
    // CAP-01 S1：查重必须先于附件分支——纯附件消息的重投才走缓存，不重复登记。
    const dedupKey = message.messageId.trim() === ''
      ? undefined
      : `${principalId}\u0000${sessionId}\u0000${message.messageId}`;
    const replayed = dedupKey === undefined ? undefined : messageReplies.get(dedupKey);
    if (replayed !== undefined) {
      log({ event: 'message_duplicate_replayed', principalId, sessionId, messageId: message.messageId });
      return await replayed;
    }

    const scope: FileScope = { principalId, sessionId };
    const sessionKey = `${principalId}\u0000${sessionId}`;

    // 条件③“此后没有任何新消息/回合”：任何新入站消息都取消待发追问；非纯附件消息
    // 同时丢弃本批（用户已经给出指令，这批不再需要追问）。纯附件消息保留已累积批次，
    // 由登记成功后的 onAttachments 并入新文件并重新计时。活动令牌随登记传入：附件
    // 登记是异步的，若登记完成前已有更新的消息到达，这次登记不得再补排追问。
    const nudgeActivity = attachmentNudge.onInboundMessage({
      principalId,
      sessionId,
      attachmentOnly: message.attachmentOnly === true,
    });

    // CAP-01 入站附件上限（20MB）：登记前按契约字节数校验。超限 = 整条消息拒绝——
    // 一个附件都不登记、不起模型回合（纯附件与文字+附件同一判据；文字+附件也不得
    // 静默丢掉附件继续回合），事件含 bytes 与上限，回执给用户明确话术。
    const oversizedAttachment = (message.attachments ?? []).find(
      (attachment) => attachment.bytes > INBOUND_ATTACHMENT_LIMIT_BYTES,
    );
    if (oversizedAttachment !== undefined) {
      log({
        event: 'inbound_attachment_too_large',
        principalId,
        sessionId,
        messageId: message.messageId,
        name: oversizedAttachment.filename,
        bytes: oversizedAttachment.bytes,
        limitBytes: INBOUND_ATTACHMENT_LIMIT_BYTES,
      });
      // 拒收也是“新消息”：本批不再有询问的时机，丢弃累积批次（不留下无定时器的孤儿）。
      if (message.attachmentOnly === true) {
        attachmentNudge.onInboundMessage({ principalId, sessionId, attachmentOnly: false });
      }
      return ATTACHMENT_TOO_LARGE_NOTE;
    }

    if (message.attachmentOnly === true) {
      // CAP-01 S1 纯附件：登记为 pending 文件——不调模型、不建 Task、不起回合；空回执让
      // 渠道走既有文件收据窗。登记进会话链（与文字回合串行，保序）。
      const pendingReply = enqueueSessionTurn(sessionKey, async () => {
        let registered: RegisteredFile[];
        try {
          registered = registerInboundAttachments(message, scope);
        } catch (error) {
          // 登记失败：本批没有可追问的文件；这条消息已打断“无新消息”条件，丢弃累积批次
          // （不留无定时器的孤儿状态），失败照常上抛（渠道可重投）。
          attachmentNudge.onInboundMessage({ principalId, sessionId, attachmentOnly: false });
          throw error;
        }
        log({
          event: 'message_attachment_only',
          principalId,
          sessionId,
          messageId: message.messageId,
          fileIds: registered.map((file) => file.fileId),
        });
        // 「附件已登记」在纯附件路径同样可查：补发与「文字+附件」路径同名的事件
        // （不改名、不丢 message_attachment_only，历史口径不断档；消费方按本事件
        // 即可覆盖两条入站路径）。
        log({
          event: 'inbound_files_registered',
          principalId,
          sessionId,
          messageId: message.messageId,
          fileIds: registered.map((file) => file.fileId),
        });
        // 目标 A：登记成功 → 机械事实（名/fileId/字节数/时间，**不含路径**）排队，
        // 下一回合随既有 injections 注入一次。
        // 目标 B：纯附件 → 30s 内无新消息则主动追问（非单聊/关闭/冷却时由组件自行忽略）。
        if (registered.length > 0) {
          const facts = registered.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            bytes: file.bytes,
            receivedAt: message.receivedAt,
          }));
          attachmentFacts.enqueue({ principalId, sessionId, files: facts });
          attachmentNudge.onAttachments({
            principalId,
            sessionId,
            ...(message.chatType === undefined ? {} : { chatType: message.chatType }),
            route: { channel, conversationId: message.conversationId },
            files: facts,
            activity: nudgeActivity,
          });
        } else {
          // 全部附件下载/登记失败：本批无文件可问，丢弃累积批次（消息本身已打断计时）。
          attachmentNudge.onInboundMessage({ principalId, sessionId, attachmentOnly: false });
        }
        return '';
      }).then(
        (reply) => reply,
        (error: unknown) => {
          // 登记失败不缓存：渠道重投可重试（回执不伪造；不标 sent）。
          if (dedupKey !== undefined) messageReplies.delete(dedupKey);
          throw error;
        },
      );
      if (dedupKey !== undefined) rememberMessageReply(dedupKey, pendingReply);
      return await pendingReply;
    }

    const pending = enqueueSessionTurn(sessionKey, async () => {
      // CAP-01 S1：本条消息若带附件，先登记为 pending（文字+附件 → 随即被下面的激活收进本回合）。
      if (message.attachments !== undefined && message.attachments.length > 0) {
        const registered = registerInboundAttachments(message, scope);
        log({
          event: 'inbound_files_registered',
          principalId,
          sessionId,
          messageId: message.messageId,
          fileIds: registered.map((file) => file.fileId),
        });
      }
      // CAP-01 S1 激活语义（v8 §4）：带文字的消息激活本会话全部 TTL 内 pending——指令消息
      // 本身不带附件，不按 messageId。先激活再开回合：回合内的清单/物化读激活后的事实。
      const activated = fileStore.activatePendingInputs({ scope, now: Date.now() });
      if (activated > 0) {
        log({ event: 'pending_files_activated', principalId, sessionId, messageId: message.messageId, activated });
      }
      await drainNotifications();
      const session = await sessionFor(principalId, sessionId);
      const turn = await session.send(message.text);
      // B 切片：本回合已把结果交给模型的任务（快活，仅 background 有完成投递）——完成投递
      // 对其抑制（一次性核销）。完成回调排在会话链上，读本集时本回合已结束（受理回合内
      // 不产生重复投递）；inline 会话没有完成回调，不登记（抑制集合不积累无用条目）。
      if (dispatchMode === 'background') {
        for (const relayedTaskId of turn.relayedTaskIds ?? []) {
          markRelayedInTurn(sessionKey, relayedTaskId);
        }
      }
      // CAP-01 S1 交付 B（v8 §7）：handler 只返回 text；文件经装配注入的端口在回合末主动投递。
      // 投递失败/无端口时以话术如实纠正正文，但不判回合失败（文件未送达 ≠ 回报失败）。
      let reply = turn.reply;
      const files = turn.files ?? [];
      let delivery: { status: string; files: number } | undefined;
      if (files.length > 0) {
        const outcome = await deliverTurnFiles({
          files,
          scope,
          channel,
          conversationId: message.conversationId,
          principalId,
          sessionId,
        });
        // files = 实际投递份数（交付层按 (sha256, 文件名) 去重后的事实，不报回合登记数）。
        delivery = { status: outcome.status, files: outcome.files };
        if (outcome.note !== undefined) {
          // 正文若只是宿主兜底话术（「文件已生成（见附件）」）则整体替换成未送达话术，
          // 否则追加（不覆盖模型正文）。suppressed 不带话术（静默部署本就无真实收件人）。
          reply = reply === FILES_GENERATED_NOTICE || reply.trim() === ''
            ? outcome.note
            : `${reply}\n${outcome.note}`;
        }
      }
      // 本回合没有可用正文（溢出恢复失败 / 只有思考没正文且催问后仍空）= 回合失败。
      // 不得当作成功回执：空串会让渠道一个终帧都不发（用户什么也收不到），也不记
      // message_done。**「只有文件、正文为空」不判失败**（v8 §7 四必守 #2）：文件走投递面，
      // 正文空帧由投递事实话术/宿主兜底话术补足——判失败就走不到投递了。放在这里抛出 =
      // 走既有的「回合失败」路径（失败不进重投缓存，渠道适配器的 handler 异常分支回失败
      // 话术），不新造机制、不重试。
      if (reply.trim() === '' && files.length === 0) {
        throw new Error('本回合未产出可用回复（模型侧失败），本回合未完成。');
      }
      return {
        reply,
        turn,
        ...(delivery === undefined ? {} : { delivery }),
        ...(turn.fileManifestBytes === undefined ? {} : { manifestBytes: turn.fileManifestBytes }),
      };
    }).then(
      (result) => {
        // 回合已成功（回复定型）：message_done 写失败不得翻转结果——只降级为一条独立观测
        // 事件；观测事件也写不进（logger 持续抛错）时同样到此为止，回复照常返回。
        try {
          log({
            event: 'message_done',
            principalId,
            sessionId,
            messageId: message.messageId,
            taskIds: [...result.turn.taskIds],
            // B 切片（可观测）：本回合经 execute_operation 发起的执行次数（执行面扩散观测）。
            operations: result.turn.operations,
            executions: result.turn.executions.map((execution) => ({
              requestId: execution.requestId,
              operation: execution.operation,
              status: execution.status,
            })),
            ...(result.delivery !== undefined ? { fileDelivery: result.delivery } : {}),
            ...(result.manifestBytes === undefined ? {} : { fileManifestBytes: result.manifestBytes }),
          });
        } catch (logError) {
          try {
            log({
              event: 'message_done_log_write_failed',
              principalId,
              sessionId,
              messageId: message.messageId,
              message: logError instanceof Error ? logError.message : String(logError),
            });
          } catch {
            // 观测事件写也失败：无第二观测面可用；回合结果已成立，不翻转、不改写话术。
          }
        }
        return result.reply;
      },
      (error: unknown) => {
        // 处理失败不缓存：渠道重投可重试（回执不伪造）。
        if (dedupKey !== undefined) messageReplies.delete(dedupKey);
        throw error;
      },
    );
    if (dedupKey !== undefined) rememberMessageReply(dedupKey, pending);
    return await pending;
  };

  return {
    handler,
    async deliverPending() {
      await drainNotifications();
    },
    async close() {
      // 停机：撤掉主动追问定时器与批次、清空进程内附件事实/系统注记（重启不补发）。
      attachmentNudge.close();
      attachmentFacts.clear();
      systemNotes.clear();
      relayedInTurnTasks.clear();
      sessions.clear();
      outbox?.close();
      taskRegistry.close();
      // B1：释放会话存储句柄（PI Session mutation barrier + JsonlStorage）；awaitable 以便
      // 进程内「重启」在同一测试里先释放再重建（同 dbPath 重建不得二次打开同一文件）。
      await sessionPersistence.close();
    },
  };
}
