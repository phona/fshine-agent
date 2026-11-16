/**
 * server 装配（宿主接线）：
 *   渠道消息 → 可信身份（principalId/sessionId 取自渠道事实）→ 回合运行时 → 渠道回复。
 *
 * 本切片不做（后续切片）：计划确认 / 产物回收 / 提案；附件只登记不消费。
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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppConfig, ContextProfileConfig, ReplyHandler } from '@fshine/contracts';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { applyExecutorLabel, loadAgentProfile } from '../../packages/agent/src/agent-profile';
import { MAIN_PROTOCOL_NOTE, type Session } from '../../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  type NotificationOutbox,
  type NotificationSink,
} from '../../packages/agent/src/notifications';
import { createResourcePolicy } from '../../packages/agent/src/resource-policy';
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

export async function createServer(deps: ServerDeps): Promise<Server> {
  const { id: profileId, profile } = resolveSingleProfile(deps.config);
  if (profile.gateway === undefined && deps.createExecutionFace === undefined) {
    throw new Error(`contextProfile ${profileId} 缺少 gateway——server 需要执行层挂载声明。`);
  }

  const log = deps.logger ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const taskRegistry = createSqliteTaskRegistry(deps.dbPath);
  // 角色文本与技能面在启动时装载一次：配置坏即启动失败，不静默降级。
  const profileMd = await loadAgentProfile();
  const workerSkills = await loadWorkerSkills(profile.root, profile.skillRoots);
  // Main 技能面（唯一机制）：固定 `<repo>/.agents/skills` → catalog；目录为空时 promptBlock
  // 空串 → 提示逐字节不变；catalog 非空才交出 read_skill 登记表（不读配置键、无模式开关）。
  const mainSkills = await loadMainSkillDelivery(defaultMainSkillsDir());
  // catalog 字节数进启动日志（证据面）：0 = 空索引（技能面未启用），不静默。
  log({ event: 'main_skills_loaded', catalogBytes: mainSkills.catalogBytes });
  const mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, profile.executorLabel)}${mainSkills.promptBlock}\n\n${MAIN_PROTOCOL_NOTE}`;
  const stateDir = deps.stateDir ?? path.join(REPO_ROOT, '.runtime', 'server', 'state');

  // B1 会话转录持久化：装配层是唯一构造具体存储处（基于 Pi SessionManager 的独立存储层）。
  // cwd 跨重启必须稳定（Pi 会话 header 记录 cwd；变了会解析到不同身份，见
  // session-persistence.ts 的 (principalId, sessionId) 唯一映射）。
  const sessionStoreDir = deps.sessionStoreDir ?? path.join(path.dirname(deps.dbPath), 'sessions');
  const sessionPersistence = new SessionPersistence({ rootDir: sessionStoreDir, cwd: REPO_ROOT });

  // P5：资源策略进程级一份（跨会话共享账本）；缺省 runtime 段 = 现行为缺省（单并发/无队列）。
  const dispatchMode = deps.config.runtime?.dispatchMode ?? 'inline';
  const policy = createResourcePolicy(deps.config.runtime);
  // P6/P4：background 才启用新受理/后台/通知路径；缺省 inline 零新增路径。
  let runner: TaskRunner | undefined;
  let outbox: NotificationOutbox | undefined;
  let notificationAttachment: ReturnType<typeof attachNotificationOutbox> | undefined;
  if (dispatchMode === 'background') {
    runner = (await createBackgroundDispatch({
      env: deps.env,
      profile,
      stateDir,
      registry: taskRegistry,
      policy,
      workerSkills,
      ...(deps.config.runtime === undefined ? {} : { runtime: deps.config.runtime }),
      emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
      ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
      ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
      ...(deps.taskExecutor !== undefined ? { taskExecutor: deps.taskExecutor } : {}),
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
          emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
          taskRegistry,
          mainSystemPrompt,
          workerSkills,
          ...(mainSkills.registry === undefined ? {} : { mainSkillRegistry: mainSkills.registry }),
          policy,
          dispatchMode,
          ...(runner === undefined ? {} : { taskRunner: runner }),
          ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
          ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
          ...(notificationAttachment === undefined ? {} : { taskFactProvider: notificationAttachment.taskFactProvider }),
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
    if (message.attachmentOnly === true) {
      // 本切片不消费附件（登记缺口：附件暂存/注入归后续切片）；空回复让渠道走文件收据窗。
      log({ event: 'message_attachment_only', principalId, sessionId, messageId: message.messageId });
      return '';
    }
    // 渠道重投（同 messageId）命中：幂等重放既有回执（无任何新副作用）。
    const dedupKey = message.messageId.trim() === ''
      ? undefined
      : `${principalId}\u0000${sessionId}\u0000${message.messageId}`;
    const replayed = dedupKey === undefined ? undefined : messageReplies.get(dedupKey);
    if (replayed !== undefined) {
      log({ event: 'message_duplicate_replayed', principalId, sessionId, messageId: message.messageId });
      return await replayed;
    }
    const pending = enqueueSessionTurn(`${principalId}\u0000${sessionId}`, async () => {
      await drainNotifications();
      const session = await sessionFor(principalId, sessionId);
      const turn = await session.send(message.text);
      // 本回合没有可用正文（溢出恢复失败 / 只有思考没正文且催问后仍空）= 回合失败。
      // 不得当作成功回执：空串会让渠道一个终帧都不发（用户什么也收不到），也不记
      // message_done。放在这里抛出 = 走既有的「回合失败」路径（失败不进重投缓存，
      // 渠道适配器的 handler 异常分支回失败话术），不新造机制、不重试。
      if (turn.reply.trim() === '') {
        throw new Error('本回合未产出可用回复（模型侧失败），本回合未完成。');
      }
      return turn;
    }).then(
      (turn) => {
        log({
          event: 'message_done',
          principalId,
          sessionId,
          messageId: message.messageId,
          taskIds: [...turn.taskIds],
          executions: turn.executions.map((execution) => ({
            requestId: execution.requestId,
            operation: execution.operation,
            status: execution.status,
          })),
        });
        return turn.reply;
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
      sessions.clear();
      outbox?.close();
      taskRegistry.close();
      // B1：释放会话存储句柄（PI Session mutation barrier + JsonlStorage）；awaitable 以便
      // 进程内「重启」在同一测试里先释放再重建（同 dbPath 重建不得二次打开同一文件）。
      await sessionPersistence.close();
    },
  };
}
