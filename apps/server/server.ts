/**
 * server 装配（宿主接线）：
 *   渠道消息 → 可信身份（principalId/sessionId 取自渠道事实）→ 回合运行时 → 渠道回复。
 *
 * 本切片不做（后续切片）：计划确认 / 产物回收 / 提案。CAP-01 S1：入站附件登记为
 * pending 文件事实（查重先于附件分支），带文字的消息激活本会话 TTL 内 pending；run_js
 * 执行器与文件清单注入由本装配构造注入（runtime 不 spawn）；回合产出文件走主动投递（B）——
 * handler 只返回 text，文件经注入的 fileDelivery.sendToConversation 发出（无端口 fail-closed，
 * 非 live 记 suppressed 不记 sent，投递失败用户可见「未送达」）。
 * R4（P5/P6/P4）：会话按 promise 链串行化（同会话不并发）；启动即建进程级 TaskRunner
 * （含重启恢复 pump）与通知 outbox（注入 sink），任务受理即回执、后台推进——server 是
 * 唯一有渠道推送面的入口，派发恒为 async（不是一个配置开关）。
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
import { effectiveRoleOf, permissionsOfRole } from '@fshine/core';
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
  LONG_RUNNING_NOTICE_FALLBACK_TEXT,
  longRunningNoticeFactText,
  type LongRunningNoticePort,
} from '../../packages/agent/src/task-runner';
import {
  createNotificationOutbox,
  type NotificationOutbox,
  type NotificationSink,
} from '../../packages/agent/src/notifications';
import { createResourcePolicy, fileRefTtlMsOf, resolveRuntimeConfig } from '../../packages/agent/src/resource-policy';
import { SessionPersistence } from '../../packages/agent/src/session-persistence';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { deriveTaskName } from '../../packages/agent/src/task-registry';
import type { TaskExecutor, TaskRunner, WaitingUserNoticePort } from '../../packages/agent/src/task-runner';
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
import {
  deliverTaskResult,
  deliverTaskFailure,
  failureKindFor,
  failureTextFor,
  routeFromSessionId,
  taskCancelledFactText,
  taskCompletionFactText,
  taskCompletionFallbackText,
  taskFailureFactText,
  taskRestartFactText,
  taskWaitingUserFactText,
  waitingUserFallbackText,
  type TaskResultFactKind,
} from './task-completion-delivery';
import {
  OUTCOME_REASON_NOT_PERMITTED,
  type OutcomeLedger,
  type TaskOutcome,
} from '../../packages/agent/src/task-outcome';
import { classifyFailureOutcome } from './task-outcome-reason';
import { composeNotificationSinks, createChatNotificationSink, notificationTerminalLogLine } from './notification-chat-sink';
import {
  createInprocessAlerts,
  type AlertPushPort,
  type AlertTimers,
  type InprocessAlerts,
} from './inprocess-alerts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 同进程在途重投表上限（有界兜底）：条目落定即删，天然有界；上限只防极端并发泄漏。
 * 跨重启判据不在这里——见底账 inbound_messages（task-store.ts）。
 */
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
  /** 测试注入：后台执行回合（server 恒 async 派发时使用）；缺省真实 Worker 回合执行器。 */
  taskExecutor?: TaskExecutor;
  /** 测试注入 / 部署注入：通知投递 sink（提供时建 outbox；真实 WeCom 适配面归后续切片）。 */
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
  /**
   * 进程内告警引擎开关（owner 2026-11-20 决定：第 3 档要有自己的执行者）。
   * 测试注入 opsDir / 时钟 / 定时器 / 推送端口；生产由 main.ts 传 enabled:true + owner 投递端口。
   * 缺省 undefined = 不启用（保持既有装配零行为变化）。
   */
  inprocessAlerts?: {
    enabled: boolean;
    opsDir: string;
    ownerRoute?: ChannelRoute;
    pushPort?: AlertPushPort;
    now?: () => Date;
    timers?: AlertTimers;
    scanIntervalMs?: number;
  };
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
 * 入站消息跨重启幂等的「上一进程未落定」话术（2026-11-19）：底账里这条 messageId 是
 * state='processing'（上一进程认领后挂了）且本进程无在途。不重复执行、不重复办事，如实
 * 告知用户；同时记事件 message_still_processing 供运维发现（这类卡住的账要能被看到）。
 */
const INBOUND_STILL_PROCESSING_NOTE = '这条我还在办，办完会发你，不用再发一遍。';

/**
 * 群主体判定（宿主自己的身份推导，见 handler：群聊 principalId = `<渠道>:group:<会话id>`；
 * 群 = 独立主体，2026-11-18 owner 定）。用于**话术层的隐私口径**——群里的提醒不带业务名
 * （业务名是任务原文，可能是个人数据/具体人的事），1:1 照常带。不用 chatType 事实源、不用
 * 进程内集合：判据只看底账任务行里的主体身份（重启后照样成立）。
 */
export function isGroupPrincipal(principalId: string): boolean {
  const parts = principalId.split(':');
  return parts.length >= 3 && parts[1] === 'group';
}

/**
 * 终态唤醒出口 → 终态类型（缺陷 A，2026-11-21 live）。只有这三类终态有状态变化唤醒出口；
 * waiting_user / 久无动静 / 重启对账不是终态事实——**永远唤醒**，不在抑制范围。
 */
const TERMINAL_WAKE_KINDS: ReadonlyMap<string, 'cancelled' | 'completed' | 'failed'> = new Map([
  ['task_cancel_wake', 'cancelled'],
  ['task_completion_wake', 'completed'],
  ['task_failure_wake', 'failed'],
]);

/**
 * 状态变化唤醒出口 → 投递归属事实种类（2026-11-21 对话形态断言层 ② 的前提）：每个出口
 * 的投递记账行（task_result_delivery_*）带上「这是哪类事实」，eval 侧据此判同一事实是否
 * 被投递两次。久无动静与重启对账都不是终局事实 → 归 warning；未登记的出口不带（不猜）。
 */
const WAKE_FACT_KINDS: ReadonlyMap<string, TaskResultFactKind> = new Map([
  ['task_cancel_wake', 'cancelled'],
  ['task_completion_wake', 'completed'],
  ['task_failure_wake', 'failed'],
  ['task_waiting_user_wake', 'waiting_user'],
  ['task_long_running_wake', 'warning'],
  ['task_restart_wake', 'warning'],
]);

/**
 * 主动提醒投递端口（预期契约 2026-11-18；2026-11-19 owner 补 #9/#10 改形）：
 *   · 判据只看**底账任务事实**（任务属于谁、活在哪个会话）——1:1 与**群聊都发**（群 = 独立
 *     主体，群里的任务就是这个群的事）；不用「群聊一律不发」的一刀切，也不依赖进程内集合
 *     （重启后集合是空的，但提醒照常发）；
 *   · 事实文本与兜底句在这里拼：**群主体去业务名**（中性主语），1:1 带业务名；
 *   · 是否真送达如实返回（失败不重试、不冒充 sent）。
 */
export function createLongRunningNoticePort(input: {
  /**
   * 状态变化唤醒出口（server 的统一出口：喂事实 → 唤醒模型 → 投递它说的话，模型挂掉投
   * fallbackText；见 server.ts 的 wakeStateChangeText）。缺省 = 未接会话面：如实返回
   * false（不冒充已送达、不静默猜）。
   */
  wakeStateChange?: (notice: {
    taskId: string;
    principalId: string;
    sessionId: string;
    name?: string;
    minutes: number;
    factText: string;
    fallbackText: string;
  }) => Promise<boolean>;
}): LongRunningNoticePort {
  return {
    async sendNotice({ taskId, principalId, sessionId, stage, name, minutes, factText, fallbackText }) {
      const wakeStateChange = input.wakeStateChange;
      if (wakeStateChange === undefined) return false;
      // 群主体：事实与话术都不带业务名（隐私口径）——overdue 的事实文本由端口按无名重建；
      // contact_lost 档的文案是注入的固定句（不含业务名），原样转发。1:1：带业务名（用户
      // 要知道是哪件事），事实/兜底句由 runner 传入，端口不重拼。
      if (stage === 'overdue' && isGroupPrincipal(principalId)) {
        return await wakeStateChange({
          taskId,
          principalId,
          sessionId,
          minutes,
          factText: longRunningNoticeFactText({ minutes }),
          fallbackText: LONG_RUNNING_NOTICE_FALLBACK_TEXT,
        });
      }
      return await wakeStateChange({
        taskId,
        principalId,
        sessionId,
        ...(name === undefined ? {} : { name }),
        minutes,
        factText,
        fallbackText,
      });
    },
  };
}

/** 交付结果状态（skipped_internal = 本批全部是宿主内部诊断产物，一件都不投）。 */
export type TurnFileDeliveryStatus =
  | 'sent'
  | 'suppressed'
  | 'delivery_unavailable'
  | 'delivery_failed'
  | 'recalc_gated'
  | 'skipped_internal';

export interface TurnFileDeliveryOutcome {
  status: TurnFileDeliveryStatus;
  files: number;
  note?: string;
}

export interface TurnFileDeliveryInput {
  files: readonly TurnFileRef[];
  scope: FileScope;
  channel: string;
  conversationId: string;
  principalId: string;
  sessionId: string;
}

export interface TurnFileDeliveryDeps {
  fileDelivery?: FileDeliveryPort;
  recalcXlsxExecutor?: RecalcXlsxExecutor;
  workspaceRoot: string;
  log: (line: Record<string, unknown>) => void;
}

/**
 * 交付面最后一道闸（方案 A，2026-11-18）：只投 **deliverable !== false** 的项。
 * 判据只看登记面角色，**不看文件名**（内部产物换成普通名也不会漏放，用户产物叫
 * file_xxx.values.csv 也照投）。返回可投项与本次被过滤的内部产物计数（观测面）。
 */
export function partitionDeliverableTurnFiles(files: readonly TurnFileRef[]): {
  deliverable: readonly TurnFileRef[];
  skippedInternal: number;
} {
  const deliverable = files.filter((file) => file.deliverable !== false);
  return { deliverable, skippedInternal: files.length - deliverable.length };
}

/**
 * CAP-01 S1 交付（v8 §7 主动投递 B；失败必须可见）：
 *   · 交付面第一件事 = 角色闸（partitionDeliverableTurnFiles）：内部诊断产物一律不投；
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
 *
 * 模块级本体（不闭包 createServer 状态）：server 装配与确定性测试走同一份实现。
 */
export async function deliverTurnFilesCore(
  input: TurnFileDeliveryInput,
  deps: TurnFileDeliveryDeps,
): Promise<TurnFileDeliveryOutcome> {
  const base = {
    principalId: input.principalId,
    sessionId: input.sessionId,
  };
  // 方案 A：角色闸在最前——中间产物（deliverable:false）不进任何投递/重算计数。
  const { deliverable: filesToDeliver, skippedInternal } = partitionDeliverableTurnFiles(input.files);
  const internal = skippedInternal > 0 ? { skippedInternal } : {};
  if (filesToDeliver.length === 0) {
    // 本批全是内部诊断产物：不发空批、不调渠道（最后一道闸的拒绝路径）。
    deps.log({ event: 'file_delivery', ...base, ...internal, files: 0, status: 'skipped_internal' });
    return { status: 'skipped_internal', files: 0 };
  }
  if (deps.fileDelivery === undefined) {
    deps.log({ event: 'file_delivery', ...base, ...internal, files: filesToDeliver.length, status: 'delivery_unavailable' });
    return { status: 'delivery_unavailable', files: filesToDeliver.length, note: FILE_DELIVERY_UNAVAILABLE_NOTE };
  }
  if (deps.fileDelivery.deliveryMode !== 'live') {
    deps.log({
      event: 'file_delivery',
      ...base,
      ...internal,
      files: filesToDeliver.length,
      status: 'suppressed',
      deliveryMode: deps.fileDelivery.deliveryMode,
    });
    return { status: 'suppressed', files: filesToDeliver.length };
  }
  // 字节从文件区派生布局现读（产物在登记时已 copy 进 workspace，原件路径从不进话术）。
  // 同一回合的重复交付（同 sha256 + 同名）在投递层收成一份；顺序保序（先到者投递）。
  const seen = new Set<string>();
  const readFiles: Array<{ name: string; bytes: Buffer }> = [];
  for (const file of filesToDeliver) {
    const data = readFileSync(fileStoragePathOf(deps.workspaceRoot, input.scope, file.fileId, file.name));
    const key = `${createHash('sha256').update(data).digest('hex')}\u0000${file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    readFiles.push({ name: file.name, bytes: data });
  }
  // recalc 投递闸（步骤 ③；时序决定终判落在这里：recalc 报告在独立 runDir、可能晚于
  // run-js out/ 扫描才产生）。缺省未注入 recalc 执行器 = enabled=false，逐字节不变。
  const gateEnabled = deps.recalcXlsxExecutor !== undefined;
  const gate = gateEnabled
    ? await applyRecalcDeliveryGate({
        files: readFiles,
        reports: collectRecalcReports(deps.workspaceRoot, input.scope),
        enabled: true,
      })
    : { outgoing: readFiles, gated: [] as Array<{ name: string; sha256: string; reason: string }> };
  if (gate.gated.length > 0) {
    deps.log({
      event: 'recalc_delivery_gated',
      ...base,
      ...internal,
      files: gate.gated.length,
      items: gate.gated,
    });
  }
  const outgoing: OutgoingFileReply[] = gate.outgoing.map((f) => ({ data: f.bytes, filename: f.name }));
  const files = outgoing.length;
  // 所有待投递项都被闸拦下：不发空批、如实告知（fail-closed；非渠道投递失败，不记 sent）。
  if (files === 0 && gate.gated.length > 0) {
    deps.log({ event: 'file_delivery', ...base, ...internal, files: 0, status: 'recalc_gated' });
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
    deps.log({
      event: 'file_delivery',
      ...base,
      ...internal,
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
    deps.log({ event: 'file_delivery', ...base, ...internal, files, status: 'sent', parts: receipt.parts.length });
  } catch (logError) {
    try {
      deps.log({
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
}

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

/**
 * 回合失败判据（唯一一处；owner 2026-11-19 最终形状）。
 *
 * 「一无所有」= 正文为空 **且** 无文件 **且** 没有交办任何任务（taskIds 空）：
 *   · 交办是**唯一豁免**——任务结果由完成投递/唤醒欠着用户一条，空正文不是静默终局；
 *   · **执行事实（executions）不参与豁免**——它是内部动作，用户不会自动收到它；内联只读
 *     失败 / 内联写确认 + 空正文 = 用户什么都收不到（静默终局），必须判回合失败。
 *
 * executions 显式进调用面只为把这条语义钉住（当前它由 taskIds 派生；将来任何来源都必须
 * 遵守「执行事实不豁免」）。判失败走既有「回合失败」路径（调用方 throw），不补宿主话术。
 */
export function turnProducedNothing(input: {
  readonly reply: string;
  readonly fileCount: number;
  readonly taskIds: readonly string[];
  readonly executions: readonly unknown[];
}): boolean {
  return input.reply.trim() === ''
    && input.fileCount === 0
    && input.taskIds.length === 0;
}

export async function createServer(deps: ServerDeps): Promise<Server> {
  const { id: profileId, profile } = resolveSingleProfile(deps.config);
  if (profile.gateway === undefined && deps.createExecutionFace === undefined) {
    throw new Error(`contextProfile ${profileId} 缺少 gateway——server 需要执行层挂载声明。`);
  }

  const baseLog = deps.logger ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  /**
   * 进程内告警引擎（第 3 档执行者）：server 产出的结构化事件经本 log 出口**同时**喂给引擎
   * 就地判（不读自己的日志）。用 reentrancy guard 防止引擎自身事件（alert_persisted 等）
   * 再被 observe 接住形成递归。引擎缺省关闭 = baseLog 原样，既有装配零行为变化。
   */
  let alerts: InprocessAlerts | undefined;
  let logDepth = 0;
  const log = (line: Record<string, unknown>): void => {
    baseLog(line);
    if (alerts === undefined || logDepth > 0) return;
    logDepth += 1;
    try {
      alerts.observe(line);
    } finally {
      logDepth -= 1;
    }
  };
  if (deps.inprocessAlerts?.enabled === true) {
    const cfg = deps.inprocessAlerts;
    alerts = createInprocessAlerts({
      opsDir: cfg.opsDir,
      dbPath: deps.dbPath,
      log,
      ...(cfg.ownerRoute === undefined ? {} : { ownerRoute: cfg.ownerRoute }),
      ...(cfg.pushPort === undefined ? {} : { pushPort: cfg.pushPort }),
      ...(cfg.now === undefined ? {} : { now: cfg.now }),
      ...(cfg.timers === undefined ? {} : { timers: cfg.timers }),
      ...(cfg.scanIntervalMs === undefined ? {} : { scanIntervalMs: cfg.scanIntervalMs }),
    });
  }
  // 未写 role 的 principal 按 viewer（只读，最小权限）处理；启动日志如实登记，不静默。
  for (const [principalId, principal] of Object.entries(deps.config.principals)) {
    if (principal.role === undefined) {
      log({ event: 'principal_role_defaulted', principalId, role: effectiveRoleOf(deps.config, principalId) });
    }
  }
  const taskRegistry = createSqliteTaskRegistry(deps.dbPath);
  /**
   * 任务业务名（完成事实文本里「哪件事」用）：底账 name（机械回落值）；旧库历史行缺省用
   * deriveTaskName(request) 同款回落。读不到底账行（回调触达时行已清/异常）= 无业务名
   * （事实主语用中性指代，不猜名）。
   */
  const taskNameOf = (taskId: string, request: string): string | undefined => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): { name?: string | null; request: string };
      }).get(taskId);
      const name = record.name ?? deriveTaskName(record.request ?? request);
      return name.trim() === '' ? undefined : name;
    } catch {
      return undefined;
    }
  };
  /**
   * 任务归属事实（重启对账出口用：把一条底账恢复事实还原到会话，好唤醒它说清）：
   * 底账行读不到（已清/异常形状）= undefined——不猜会话、不猜到哪个窗口。
   */
  const taskScopeOf = (taskId: string): { principalId: string; sessionId: string; request: string } | undefined => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): { principalId: string; sessionId: string; request: string };
      }).get(taskId);
      return { principalId: record.principalId, sessionId: record.sessionId, request: record.request };
    } catch {
      return undefined;
    }
  };
  /**
   * 快活任务（本回合已把结果交给模型）的降级兜底文本：底账业务名 + 结果原文。
   * background 完成经 runner settle 写 replyText；inline 完成写 resultText——两处兼容读取
   * （与交给模型的 summary 同源同式：settled.replyText ?? settled.resultText）。结果原文为空/
   * 底账读不到 = undefined（不编事实、不投递）。
   */
  const taskCompletionFallbackOf = (taskId: string): string | undefined => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): { request: string; replyText?: string; resultText?: string };
      }).get(taskId);
      const resultText = record.replyText ?? record.resultText ?? '';
      if (resultText.trim() === '') return undefined;
      const name = taskNameOf(taskId, record.request);
      return taskCompletionFallbackText({
        ...(name === undefined ? {} : { name }),
        resultText,
      });
    } catch {
      return undefined;
    }
  };
  /**
   * 快活失败任务的失败事实（回合末兜底投递用；与失败回调同源）：终局 failed（含
   * result_unknown；资源拒绝也是 failed 终局）→ 执行事实的 error.code（failureCodeOf）
   * + result_unknown 状态 + 底账机械原因（reason=resource_limited 时话术必须走「系统太忙」
   * ——2026-11-19 只读审计 #18），输入与失败回调逐字同源；非失败终局（取消/超时/未执行——
   * 窗口内不可达，仅注入式执行器能造）与底账读不到 = undefined（不替它们说话，交回
   * 既有终态推送面）。
   */
  const taskFailureFactOf = (taskId: string): { code?: string; status?: 'result_unknown'; reason?: string; name?: string } | undefined => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): { status?: string; reason?: string | null; request?: string; name?: string | null };
      }).get(taskId);
      if (record.status !== 'failed') return undefined;
      const code = failureCodeOf(taskId);
      const name = taskNameOf(taskId, record.request ?? '');
      return {
        ...(code === undefined ? {} : { code }),
        ...(record.reason === 'result_unknown' ? { status: 'result_unknown' as const } : {}),
        ...(record.reason === undefined || record.reason === null ? {} : { reason: record.reason }),
        ...(name === undefined ? {} : { name }),
      };
    } catch {
      return undefined;
    }
  };
  /**
   * 失败投递的分类输入（2026-11-19）：任务底账执行事实里第一条 failed/refused 行的
   * error.code（执行层原始码，只用于 classifyFailure 归类；**不进用户文本**）。
   * 取不到（无执行行/异常）= undefined，由投递面落 executor_failed。
   */
  const failureCodeOf = (taskId: string): string | undefined => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): { executions?: ReadonlyArray<{ status?: string; error?: { code?: string } }> };
      }).get(taskId);
      const failed = (record.executions ?? []).find((execution) =>
        (execution.status === 'failed' || execution.status === 'refused')
        && typeof execution.error?.code === 'string'
        && execution.error.code !== '',
      );
      return failed?.error?.code;
    } catch {
      return undefined;
    }
  };
  /**
   * 答复五态机械分类（B2/F3-1）：从任务底账取机械事实喂 classifyFailureOutcome，得到五值之一。
   * 零执行 + 权限拒绝（**结构化原因码** not_permitted）→ blocked；零执行非拒绝 → unsupported。
   * 判据只认 reasonCode，不扫 reason 文本里的「权限」字样（那是给模型读的转述，不是事实）。
   * 只输出结构化值（不是话术），供 Main 按值选措辞。取不到底账时按失败原因码保守分类。
   */
  const outcomeOfTask = (
    taskId: string,
    status: 'failed' | 'result_unknown',
    reasonCode?: string,
  ): TaskOutcome => {
    try {
      const record = (taskRegistry as unknown as {
        get(id: string): {
          status?: string;
          reason?: string;
          executions?: ReadonlyArray<{
            status?: string;
            error?: { code?: string };
            items?: readonly { status: 'ok' | 'failed' | 'unknown' }[];
          }>;
        };
      }).get(taskId);
      const executions = (record.executions ?? []).map((execution) => ({
        status: (execution.status === 'completed' || execution.status === 'failed'
          || execution.status === 'refused' || execution.status === 'needs_input'
          || execution.status === 'needs_confirmation' || execution.status === 'accepted'
          ? execution.status : 'result_unknown') as OutcomeLedger['executions'][number]['status'],
        ...(execution.error?.code === undefined ? {} : { error: { code: execution.error.code } }),
        ...(execution.items === undefined ? {} : { items: execution.items }),
      }));
      const terminal = (record.status === 'completed' || record.status === 'failed'
        || record.status === 'timed_out' || record.status === 'unexecuted'
        || record.status === 'running' || record.status === 'waiting_user'
        ? record.status : 'failed') as OutcomeLedger['terminal'];
      return classifyFailureOutcome(executions, {
        terminal,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        ...(record.reason === undefined ? {} : { ledgerReasonCode: record.reason }),
      });
    } catch {
      return 'failed';
    }
  };
  // 解析后配置只读一次：fileStore 的 TTL 由它派生（单一配置源；本文件不重解释 runtime 段）。
  const resolvedRuntime = resolveRuntimeConfig(deps.config.runtime);
  // 入站消息幂等底账启动清扫（2026-11-19）：保留期 = runtime.fileRefTtlDays 派生的毫秒
  // （缺省 7 天）。复用该保留期而非新开配置键——同为「部署保留地平线」的单一来源，且本切片
  // 不改配置 schema。只删过期行（COALESCE(completed_at, claimed_at) < cutoff）；清理失败不影响
  // 启动（只记观测事件）。
  try {
    const inboundCutoff = new Date(Date.now() - fileRefTtlMsOf(resolvedRuntime)).toISOString();
    const removed = taskRegistry.store.cleanupInboundMessages(inboundCutoff);
    if (removed > 0) log({ event: 'inbound_messages_cleanup', removed, cutoff: inboundCutoff });
  } catch (error) {
    log({ event: 'inbound_messages_cleanup_failed', reason: error instanceof Error ? error.message : String(error) });
  }
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
   * 投影 fileId/name/bytes + activatedAt/createdAt（清单时间取 createdAt），不含内容/路径/sha256。
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

  // 会话落盘归 Pi：装配层解析本 (principal, session) 的唯一会话文件位置，直接交给 Pi 驱动
  // （sessionDir/sessionId/resumeSessionFile）。本层无句柄、无 close，也不搬运任何 message。
  const sessionStoreDir = deps.sessionStoreDir ?? path.join(path.dirname(deps.dbPath), 'sessions');
  const sessionPersistence = new SessionPersistence({ rootDir: sessionStoreDir });

  // P5：资源策略进程级一份（跨会话共享账本）；缺省 runtime 段 = 现行为缺省（前台并发 4 / 排队 16）。
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
  // P6/P4：**有渠道推送面就一律 async**（受理即回执、后台推进、完成后主动投递）：
  // fileDelivery（会话投递）或 notificationSink（通知面）任一存在即建 runner；
  // 两者都缺省 = 无端口部署，保持同步等结果（无推送可发，降级不崩——现行为不变）。
  const hasPushSurface = deps.fileDelivery !== undefined || deps.notificationSink !== undefined;
  const taskDispatch: 'sync' | 'async' = hasPushSurface ? 'async' : 'sync';
  // 主动提醒（久无动静）的判据只看**底账任务事实**（任务属于谁、活在哪个会话）——
  // 2026-11-19 owner 补 #10：此前用进程内集合（inbound 时登记）判 1:1，重启后集合是空的，
  // 用户再开口前一条提醒都发不出去；现在群聊也覆盖（#9），进程内集合整体删除。
  const longRunningNotice = createLongRunningNoticePort({
    // 唤醒出口定义在本文件下半部（函数声明，装配完成前不会被调用——启动 pump 也在装配
    // 完成之后才跑）。
    wakeStateChange: (notice) => wakeLongRunningNotice(notice),
  });
  // 等待用户出口（2026-11-21 live P0）：任务由非等待态进入 waiting_user（needs_input /
  // needs_confirmation 收尾）→ **唤醒原会话的模型把待确认/待补说给用户并等表态**，与完成 /
  // 失败/取消/久无动静/重启对账共用同一条状态变化出口（不新建第二套唤醒与投递）。live 实测
  // 缺陷：进入等待此前只落底账，模型不知道有人在等它说话（15:25:55.992 落等待到 15:26:04
  // 零推送），用户只能自己猜着发「按这版提交」才拿到确认摘要。
  //   · 事实机械：missing 列表 + confirmation.summary 原文与 expiresAt；**句柄不进事实**；
  //   · 兜底（模型说不出话）= summary 原文 + expiresAt（执行端原话，不编新话术）；
  //     待补（无提案）没有兜底——只记事件 + 事实留待注入（不猜、不替它说）；
  //   · 去重 = (taskId, 进入等待次数)：runner 只在非等待态落等待时触发端口（状态机禁止
  //     waiting→waiting；回 running 再进 = 新的一次）；投递失败退回待注入，不重试唤醒。
  const waitingUserNotice: WaitingUserNoticePort = {
    sendNotice: (notice) => {
      const confirmation = notice.question.confirmation;
      void (async () => {
        await wakeAndDeliverStateChange({
          taskId: notice.taskId,
          principalId: notice.principalId,
          sessionId: notice.sessionId,
          event: 'task_waiting_user_wake',
          factText: taskWaitingUserFactText({
            ...(notice.name === undefined ? {} : { name: notice.name }),
            missing: notice.question.missing,
            ...(confirmation === undefined ? {} : { summary: confirmation.summary }),
            ...(confirmation?.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
          }),
          ...(confirmation === undefined ? {} : {
            fallbackText: waitingUserFallbackText({
              summary: confirmation.summary,
              ...(confirmation.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
            }),
          }),
        });
      })().catch((error) => {
        log({
          event: 'task_waiting_user_wake_failed',
          taskId: notice.taskId,
          principalId: notice.principalId,
          sessionId: notice.sessionId,
          reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
      });
    },
  };
  let runner: TaskRunner | undefined;
  let outbox: NotificationOutbox | undefined;
  let notificationAttachment: ReturnType<typeof attachNotificationOutbox> | undefined;
  /**
   * 启动 pump 的恢复事实（2026-11-19 唤醒切片）：`running` 且租约过期的任务在启动时如实落
   * result_unknown（不重放）——用户以为它还在办，重启对账出口据此逐条唤醒原会话说清
   * （见文件末）。装配完成后才跑 pump，这里先留一个空集合。
   */
  let startupRecovered: readonly string[] = [];
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
  /**
   * 主动推送抑制（快活失败/等补充）：本回合已把失败原因交给模型的任务——推送不再重复发一条。
   * 一次性核销（推送核销后即删）；有界（会话长了不积累：超上限淘汰最旧）。
   */
  const PUSH_SUPPRESSED_LIMIT = 64;
  const pushSuppressedInTurn = new Map<string, Set<string>>();
  const markPushSuppressedInTurn = (sessionKey: string, taskId: string): void => {
    let set = pushSuppressedInTurn.get(sessionKey);
    if (set === undefined) {
      set = new Set();
      pushSuppressedInTurn.set(sessionKey, set);
    }
    set.add(taskId);
    while (set.size > PUSH_SUPPRESSED_LIMIT) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  };
  const claimPushSuppressedInTurn = (sessionKey: string, taskId: string): boolean => {
    const set = pushSuppressedInTurn.get(sessionKey);
    if (set?.delete(taskId) !== true) return false;
    if (set.size === 0) pushSuppressedInTurn.delete(sessionKey);
    return true;
  };
  /**
   * 唤醒抑制（缺陷 A，2026-11-21 live）：本回合等待窗口观察到落定、且模型本回合已说话的
   * 任务终态——(taskId, 终态类型) 一次性核销：对应的状态变化唤醒不再发送（用户已在本回合
   * 听到这件事，再说一遍就是同一事实两条）。条目只在「回合回复非空」时标记（回复为空 =
   * 不抑制，否则静默）；回合外落定不进这个表（照常唤醒）。有界（同 pushSuppressedInTurn）。
   */
  const WAKE_SUPPRESSED_LIMIT = 64;
  const wakeSuppressedInTurn = new Map<string, Set<string>>();
  const markWakeSuppressedInTurn = (sessionKey: string, taskId: string, kind: string): void => {
    let set = wakeSuppressedInTurn.get(sessionKey);
    if (set === undefined) {
      set = new Set();
      wakeSuppressedInTurn.set(sessionKey, set);
    }
    set.add(`${taskId}\u0000${kind}`);
    while (set.size > WAKE_SUPPRESSED_LIMIT) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  };
  const claimWakeSuppressedInTurn = (sessionKey: string, taskId: string, kind: string): boolean => {
    const set = wakeSuppressedInTurn.get(sessionKey);
    const key = `${taskId}\u0000${kind}`;
    if (set?.delete(key) !== true) return false;
    if (set.size === 0) wakeSuppressedInTurn.delete(sessionKey);
    return true;
  };
  if (taskDispatch === 'async') {
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
      // 进程级共享 runner 跨主体：每个任务的 Worker 允许集合按任务 principal 的角色求交
      // （viewer 的后台写不会借用 operator 的允许集）。
      permissionsForPrincipal: (principalId) =>
        permissionsOfRole(deps.config, effectiveRoleOf(deps.config, principalId)),
      emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
      ...(deps.createDrivers !== undefined ? { createDrivers: deps.createDrivers } : {}),
      ...(deps.createExecutionFace !== undefined ? { createExecutionFace: deps.createExecutionFace } : {}),
      ...(deps.taskExecutor !== undefined ? { taskExecutor: deps.taskExecutor } : {}),
      // CAP-01 S2 后台文件面：与 inline 会话桥同一 fileStore 实例与同一装配参数（profile 声明
      // 的 fileParams），按任务懒建桥——background 的 Worker 才有任务文件清单与物化路径。
      taskExecutionBridge: {
        store: fileStore,
        ...(profile.fileParams === undefined ? {} : { fileParams: profile.fileParams }),
        onSkip: (reason) => log({ event: 'task_file_bridge_skip', mode: 'background', reason }),
      },
      // 文件引用被拒的机械 reason（与 inline 同事件名；只进日志，用户/Worker 只见统一话术）。
      onFileRefUnavailable: (reason) => log({ event: 'file_ref_unavailable', mode: 'background', reason }),
      // 大响应文件化（2026-11-19）：落盘/未落盘只进日志（后台无会话身份可拼时只带任务事实）。
      onExecutionResultFileized: (event) => log({ event: 'execution_result_fileized', mode: 'background', ...event }),
      onExecutionResultOversizeUnhandled: (event) => log({
        event: 'execution_result_oversize_unhandled',
        mode: 'background',
        ...event,
      }),
      // 片 1：后台 Worker 的 run_js 与前台同一执行器端口（缺省不注入 = Worker 工具面零变化）。
      runJsExecutor,
      // 预期契约（2026-11-18；2026-11-19 #9/#10 改形）：久无动静提醒端口（只一档；1:1 与群聊
      // 都发，判据只看底账任务事实，不看进程内集合；群主体话术不带业务名）。
      longRunningNotice,
      // 等待用户出口（2026-11-21 live P0）：任务落 waiting_user → 唤醒原会话模型说
      // （见上方 waitingUserNotice 注释：事实机械、句柄不外泄、恰一次）。
      waitingUserNotice,
      // 长任务异步（契约 v4）：accepted / 协议违约 / 续跑回程登记与等待推进只进日志。
      onExecutionEvent: (event) => log({ mode: 'background', ...event }),
      log: (line) => log({ mode: 'background-runner', ...line }),
      // B 切片（2026-11-19 唤醒切片）：后台任务确认完成 → **唤醒原会话里的模型、由它把
      // 这件事说给用户**，宿主只投递它说的话（宿主常规成功文案已删；身份行已删）。
      // **非 live 部署不唤醒**（没有真实收件人，不白花模型调用；2026-11-19 复核 F5）。
      // 会话拿不到 / 唤醒回合失败（含空回复）→ 宿主兜底**如实报完成事实**（业务名 + 结果
      // 正文；不得说「没弄好/再试一次」——任务其实已成功，2026-11-19 复核 F2）+ 事实留在
      // 待注入（下次用户开口由模型补说）；唤醒时会话忙 = 事实入队、由当前回合负责说
      // （宿主不另行投递，避免说两遍）。
      // 回调经会话链串行（快活抑制判定须在受理回合结束后做）；投递失败/抑制只记事件，不改任务事实。
      onTaskCompleted: (completion) => {
        const sessionKey = `${completion.principalId}\u0000${completion.sessionId}`;
        enqueueSessionTurn(sessionKey, async () => {
          // 快活（结果已在本回合交给模型）：不唤醒、不重复播报（模型已转述）。
          // 但**产物不因抑制丢失**——同回合交给模型的摘要里没有文件，产物只能由这里回程。
          const relayed = relayedInTurnTasks.get(sessionKey)?.delete(completion.taskId) === true;
          const suppressText = (): void => {
            log({
              event: 'task_result_delivery_suppressed',
              principalId: completion.principalId,
              sessionId: completion.sessionId,
              taskId: completion.taskId,
              deliveryMode: completionDelivery?.deliveryMode ?? 'unavailable',
              reason: 'relayed_in_turn',
            });
          };
          // 片 1 产物回程：任务产物走**同一交付面**（deliverable 角色闸、sha256+文件名去重、
          // live/silent 记账与前台 TurnResult.files 完全同源），文本由完成投递送达。
          const files = completion.files ?? [];
          let fileNote: string | undefined;
          if (files.length > 0) {
            const route = routeFromSessionId(completion.sessionId);
            if (route === undefined) {
              // 路由拆不出（异常 sessionId 形状）：如实记账、不猜路由（与文本投递同一纪律）。
              log({
                event: 'file_delivery',
                principalId: completion.principalId,
                sessionId: completion.sessionId,
                taskId: completion.taskId,
                files: files.length,
                status: 'suppressed',
                reason: 'route_unresolvable',
              });
            } else {
              const outcome = await deliverTurnFiles({
                files,
                scope: { principalId: completion.principalId, sessionId: completion.sessionId },
                channel: route.channel,
                conversationId: route.conversationId,
                principalId: completion.principalId,
                sessionId: completion.sessionId,
              });
              fileNote = outcome.note;
            }
          }
          if (relayed) {
            suppressText();
            // 快活抑制只免掉「办完了」这条重复播报；**文件没送达时必须单独说一句**——
            // 同回合模型已经说过「见附件」，用户手上却什么都没有，那就是虚假交付
            // （2026-11-19 真发现：默认窗口下 file_delivery=delivery_failed 后一句提示都没有）。
            // 这一条是投递失败话术，不是完成播报。
            if (fileNote !== undefined) {
              const noteDelivered = await deliverTaskResult({
                taskId: completion.taskId,
                principalId: completion.principalId,
                sessionId: completion.sessionId,
                resultText: fileNote,
                // 投递归属：文件未送达话术不是完成播报，是告警类事实（warning）。
                factKind: 'warning',
              }, {
                ...(completionDelivery === undefined ? {} : { delivery: completionDelivery }),
                log,
              });
              // 2026-11-19（同形缺口，与 woken 投递失败同一手法）：**这一句本身没送出去**时
              // （渠道瞬时故障/路由拆不出），用户会一直以为附件已经到了（模型说过「见附件」）。
              // 后路 = 话术退回既有待注入队列，下一次用户开口由模型补说「文件没送出去」；
              // 不新建重试、不重投同一句话。
              if (!noteDelivered) {
                systemNotes.enqueue(completion.principalId, completion.sessionId, fileNote);
                log({
                  event: 'task_result_delivery_requeued',
                  principalId: completion.principalId,
                  sessionId: completion.sessionId,
                  taskId: completion.taskId,
                  source: 'file_note',
                  reason: 'not_sent',
                });
              }
            }
            return;
          }
          // 完成事实（宿主拼，喂给模型读；不含 handle/内部码/执行层原文以外的内部标识）。
          const name = taskNameOf(completion.taskId, completion.request);
          const factText = taskCompletionFactText({
            ...(name === undefined ? {} : { name }),
            resultText: completion.resultText,
          });
          // 降级兜底文本（**全方案唯一允许的宿主用户文案**；只走 unavailable/failed 降级
          // 路径与非 live 不唤醒路径）：任务已由执行端确认完成——如实报事实（业务名 + 结果
          // 正文），不得说「没弄好/再试一次」（2026-11-19 复核 F2：那会诱导用户重复执行写）。
          const fallbackText = taskCompletionFallbackText({
            ...(name === undefined ? {} : { name }),
            resultText: completion.resultText,
          });
          // 走统一的状态变化出口（见 wakeAndDeliverStateChange）：非 live 不唤醒（不白花模型
          // 调用）、事实进待注入、投递抑制记账照旧；文件未送达的如实话术附在正文后（不覆盖
          // 模型的话）。
          await wakeAndDeliverStateChange({
            taskId: completion.taskId,
            principalId: completion.principalId,
            sessionId: completion.sessionId,
            event: 'task_completion_wake',
            factText,
            fallbackText,
            ...(fileNote === undefined ? {} : { appendText: fileNote }),
          });
        });
      },
      // 失败投递（2026-11-19 收口；唤醒切片改形）：任务终局 failed/result_unknown → **唤醒
      // 模型、由它把失败说给用户**（宿主只喂事实：业务名 + 归类后的业务种类 + 机械原因）。
      // 宿主不再直接投失败话术；唤醒 unavailable/failed（模型说不出话）时降级投**既有失败
      // 话术**（failureMessageFor；这就是「模型回合挂了」的兜底，保留——绝不投 Worker 原文）。
      // 快活失败（本回合已交给模型）经 pushSuppressedInTurn 抑制；非快活失败由这里主动发回
      // 原会话（与完成投递同一主动投递面、同一四必守）。
      onTaskFailed: (failure) => {
        const sessionKey = `${failure.principalId}\u0000${failure.sessionId}`;
        enqueueSessionTurn(sessionKey, async () => {
          // 快活失败：原因本回合已交给模型（模型会转述），不重复唤醒/播报。
          if (claimPushSuppressedInTurn(sessionKey, failure.taskId)) {
            log({
              event: 'task_failure_delivery_suppressed',
              principalId: failure.principalId,
              sessionId: failure.sessionId,
              taskId: failure.taskId,
              deliveryMode: completionDelivery?.deliveryMode ?? 'unavailable',
              reason: 'relayed_in_turn',
            });
            return;
          }
          // 归类输入：底账执行事实的 error.code（failed/refused 行；取不到 = 落 executor_failed）。
          // 归类出口与话术共用同一个 failureKindFor（安全口径：needs_* 一律改判 host_fault）。
          const code = failureCodeOf(failure.taskId);
          const kind = failureKindFor(code, failure.status);
          const name = taskNameOf(failure.taskId, failure.request);
          await wakeAndDeliverStateChange({
            taskId: failure.taskId,
            principalId: failure.principalId,
            sessionId: failure.sessionId,
            event: 'task_failure_wake',
            // 事实（给模型读；业务名 + 归类后的业务种类 + 机械原因），**不投 Worker 失败原文**。
            // B2：追加结构化 outcome 五值（机械事实，不是话术），Main 据此按值选措辞。
            // F3-1：blocked 判据与 missing 字段都只认结构化原因码，不扫 reason 文本「权限」字样。
            factText: taskFailureFactText({
              ...(name === undefined ? {} : { name }),
              kind,
              reason: failure.reason,
              outcome: outcomeOfTask(failure.taskId, failure.status, failure.reasonCode),
              ...(failure.reasonCode === OUTCOME_REASON_NOT_PERMITTED
                ? { missing: '本次允许范围' }
                : {}),
            }),
            // 降级兜底（模型说不出话）= 既有失败话术（与老路径逐字同源）。
            fallbackText: failureTextFor(code, failure.status),
          });
        });
      },
    })).runner;
    if (deps.notificationSink !== undefined) {
      // 主动推送（B 类：任务事实到用户的如实交付）：outbox 的事实除了落盘审计，还要把
      // 「用户必须知道、或必须做点什么」的几类发回原会话——等结果的人不该靠下次开口才发现
      // 任务失败或卡在等他说一句话。文件审计与聊天推送各自独立成败（composeNotificationSinks）。
      const chatSink = createChatNotificationSink({
        // 底账即事实来源：读不到范围就不猜路由（读操作不带 scope，越权=找不到）。
        taskScope: (taskId) => {
          try {
            const record = (taskRegistry as unknown as {
              get(id: string): { principalId: string; sessionId: string };
            }).get(taskId);
            return { principalId: record.principalId, sessionId: record.sessionId };
          } catch {
            return undefined;
          }
        },
        ...(deps.fileDelivery === undefined ? {} : { delivery: deps.fileDelivery }),
        // 会话此刻有回合在跑 → 本次不投递（模型还在打字时不抢先推一条），回执按**改期**交出去
        // （没尝试投递、不消耗尝试次数）；**回合结束**（会话链排空）时 `enqueueSessionTurn` 补一次
        // 投递驱动，那一刻 turnActive 已为 false，推送即落地（不新增定时器/不改重试上限）。
        turnActive: (sessionKey) => sessionChains.has(sessionKey),
        claimRelayedInTurn: claimPushSuppressedInTurn,
        // 「用户说停」（cancelled）改走统一的状态变化唤醒出口（2026-11-19 唤醒切片）：
        // 喂取消事实 → 唤醒模型说 → 模型说不出话投既有渲染文案。sink 不再拼那句话。
        wakeCancelled: (notice) => wakeAndDeliverStateChange({
          taskId: notice.taskId,
          principalId: notice.principalId,
          sessionId: notice.sessionId,
          event: 'task_cancel_wake',
          factText: notice.factText,
          fallbackText: notice.fallbackText,
        }),
        log,
      });
      outbox = createNotificationOutbox({
        dbPath: deps.dbPath,
        sink: composeNotificationSinks([deps.notificationSink, chatSink]),
        // 投递终局（2026-11-19 第 3 档接线）：一条通知**未送达就进终局**（失败到 attempts 上限，
        // 或终态跳过）时落一条结构化事件——「兜不住、用户也做不了什么」不许没有归宿：
        // ops/alerts 的 delivery_failed 规则据此判（exhausted 判投递失败；skipped 是「没有东西
        // 可发/永不可能送达」，不告警——静默部署上每条都 skipped，告警就成了噪音）。
        onTerminal: (terminal) => log(notificationTerminalLogLine(terminal)),
      });
      // server 进程：事实落库后异步触发投递（终态通知即刻推送；同进程有界重试）。
      // R5 B 通道：同一挂钩缓冲机械事实，下一次回合开始前以普通 user 消息注入主对话。
      notificationAttachment = attachNotificationOutbox(taskRegistry, outbox, { deliverOnRecord: true });
    }
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
        // 会话落盘归 Pi：本 (principal, session) 的独立会话位置（跨 principal 物理隔离）交给
        // 真实 Pi 驱动作 sessionDir/sessionId/resumeSessionFile——历史与压缩摘要都在 Pi 会话
        // 文件里，宿主不搬运任何消息、不 seed 任何转录。
        const mainSession = sessionPersistence.resolve(principalId, sessionId);
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
          // 宿主求交：本主体的角色权限（未写 role = viewer = 只读）。实际允许集合还要与
          // 执行层声明能力、部署总闸求交（assembleSessionCore 内收口）。
          allowedPermissions: permissionsOfRole(deps.config, effectiveRoleOf(deps.config, principalId)),
          // 长任务异步（契约 v4）：前台会话的 accepted/协议违约事件只进日志（带会话身份）。
          onExecutionEvent: (event) => log({ principalId, sessionId, ...event }),
          emptyOperationsMessage: '执行层没有声明任何只读 operation——server 拒绝以空允许集合运行。',
          taskRegistry,
          mainSystemPrompt,
          workerSkills,
          ...(mainSkills.registry === undefined ? {} : { mainSkillRegistry: mainSkills.registry }),
          policy,
          // 派发方式是装配参数（不是配置键）：有推送面 = async；无端口部署 = sync。
          taskDispatch,
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
          // 大响应文件化（2026-11-19）：Worker 结果超阈值 → 完整 data 落任务文件，只回摘要 +
          // fileId；未注入桥/登记失败 → fail-open 原样返回。两类事件只进日志，不进用户话术。
          onExecutionResultFileized: (event) => log({ event: 'execution_result_fileized', principalId, sessionId, ...event }),
          onExecutionResultOversizeUnhandled: (event) => log({
            event: 'execution_result_oversize_unhandled',
            principalId,
            sessionId,
            ...event,
          }),
          fileManifestProvider,
          mainSession,
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
   *
   * 链排空那一刻顺带补一次投递驱动（2026-11-19 投递真相切片）：回合期间被改期的主动推送
   * （chat sink 按 `turnActive` 回「改期」）在此刻由**既有** outbox 退避重试接管——
   * 同一个 `deliverPending`（与落库即试投、回合开始 drain 同源），无新定时器、无新重试机制。
   * 排在 delete 之后：此刻会话已无在跑回合，推送不会再被改期。
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
      if (sessionChains.get(key) !== tail) return;
      sessionChains.delete(key);
      void outbox?.deliverPending().catch(() => {});
    });
    return next;
  }

  /**
   * 状态变化唤醒出口（2026-11-19 唤醒切片；完成 / 失败 / 用户说停 / 久无动静 / 重启对账
   * 共用**同一个**入口——不新建第二套唤醒，也不新建第二套投递）。宿主只做四件事：
   * 时机、事实、凭据、投递与记账。本函数只做前三件里的「唤醒取话」：
   *   · 非 live 不唤醒（没有真实收件人，不白花一次模型调用）：记 suppressed 事件，返回
   *     兜底文本（有则投——投递记账照旧走 deliverTaskResult 的 suppressed 分支）；
   *   · live：唤醒原会话模型（Session.wake；事实经 Pi 原生 custom message 注入，唤醒回合
   *     没有工具声明），woken 且正文非空 → 返回**模型写的那句**（调用方原样投递，不得改写）；
   *   · 唤醒 unavailable / failed（含只调工具不产出正文、回合超时中止）→ 事实进既有
   *     systemNotes 待注入（下次用户开口由模型补说，事实不丢）+ 返回兜底文本
   *     （无兜底 = undefined：只记事件，不猜、不替它说）；
   *   · busy（会话正忙，事实已按 Pi 原生队列入队、由当前回合说）→ 返回 undefined，调用方
   *     **不得**另行投递（同一件事说两遍比少说一句糟）。
   * 事实文本由调用方拼（不含句柄/内部码；句柄永不出宿主）；本函数不投递、不记账。
   */
  async function wakeStateChangeText(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    /** 结构化事件名（各出口各自可辨；事实内容不进事件）。 */
    event: string;
    factText: string;
    /** 模型回合挂掉时的兜底一句（全方案唯一允许的宿主用户文案）；缺省 = 无兜底。 */
    fallbackText?: string;
  }): Promise<{ outcome: 'woken' | 'busy' | 'unavailable' | 'failed' | 'suppressed'; text?: string }> {
    const base = {
      principalId: input.principalId,
      sessionId: input.sessionId,
      taskId: input.taskId,
    };
    const delivery = deps.fileDelivery;
    const live = delivery !== undefined && delivery.deliveryMode === 'live';
    if (!live) {
      log({ event: input.event, ...base, outcome: 'suppressed' });
      // 事实不丢：非 live 也一样进待注入（下次用户开口由模型补说）——与唤醒降级同一处置。
      systemNotes.enqueue(input.principalId, input.sessionId, input.factText);
      return { outcome: 'suppressed', ...(input.fallbackText === undefined ? {} : { text: input.fallbackText }) };
    }
    let outcome: 'woken' | 'busy' | 'unavailable' | 'failed' = 'unavailable';
    let modelText = '';
    let wakeFailure: { errorType: string; message: string } | undefined;
    try {
      const session = await sessionFor(input.principalId, input.sessionId);
      const woke = await session.wake(input.factText);
      outcome = woke.outcome;
      modelText = woke.text ?? '';
    } catch (error) {
      outcome = 'failed';
      wakeFailure = {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
    // 唤醒事实只进结构化事件（不带事实内容、不带内部标识）。
    log({ event: input.event, ...base, outcome, ...(wakeFailure ?? {}) });
    // 会话忙：事实已入队，由当前回合处理——宿主不另行投递（说了两遍比少说一句糟）。
    if (outcome === 'busy') return { outcome };
    const wokenText = outcome === 'woken' && modelText.trim() !== '' ? modelText : undefined;
    if (wokenText !== undefined) return { outcome, text: wokenText };
    // 降级（unavailable/failed）与非 live 不唤醒（suppressed）：事实留在「待注入」（既有
    // injections 机制，不新建队列）——下次用户开口由模型补说。
    systemNotes.enqueue(input.principalId, input.sessionId, input.factText);
    return { outcome, ...(input.fallbackText === undefined ? {} : { text: input.fallbackText }) };
  }

  /**
   * 状态变化出口的完整处置：唤醒取话（wakeStateChangeText）→ 有话说就走既有投递面
   * （deliverTaskResult，四必守记账）→ 返回「用户可见的那句话是否已交出」。
   * **busy 也算已交出**：事实已按 Pi 原生态交给正在跑的本回合，由它说（不另投、不算失败）。
   * 完成路径不用本包装（它要把文件未送达话术附在正文后、且靠自己算的文本投递），
   * 其余出口（失败/说停/久无动静/重启对账）走这里，保证同一套投递与记账。
   */
  async function wakeAndDeliverStateChange(input: {
    taskId: string;
    principalId: string;
    sessionId: string;
    event: string;
    factText: string;
    fallbackText?: string;
    /** 附加在用户文本之后的一句（不覆盖模型的话；如「文件没发出去」的如实话术）。 */
    appendText?: string;
  }): Promise<boolean> {
    // 唤醒抑制（缺陷 A）：该终态已在本回合由模型说给用户（回合等待窗口观察到落定 + 回复
    // 非空）→ 状态变化唤醒不再发送，记 wake_suppressed_already_delivered（taskId/kind）。
    // 一次性核销 = 同一终态最多抑制一次；waiting_user / 久无动静 / 重启对账不在
    // TERMINAL_WAKE_KINDS 里，永远照常唤醒。
    const terminalKind = TERMINAL_WAKE_KINDS.get(input.event);
    if (terminalKind !== undefined && claimWakeSuppressedInTurn(
      `${input.principalId}\u0000${input.sessionId}`,
      input.taskId,
      terminalKind,
    )) {
      log({
        event: 'wake_suppressed_already_delivered',
        principalId: input.principalId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        kind: terminalKind,
      });
      return true;
    }
    const resolved = await wakeStateChangeText(input);
    // 会话忙：事实已交给正在跑的回合（由它说）——不是失败、也不另投（同一件事不说两遍）。
    if (resolved.outcome === 'busy') return true;
    if (resolved.text === undefined) return false;
    const resultText = input.appendText === undefined ? resolved.text : `${resolved.text}\n${input.appendText}`;
    // 投递归属（对话形态断言层 ② 的前提）：出口事件名 → 事实种类；未登记出口不带（不猜）。
    const factKind = WAKE_FACT_KINDS.get(input.event);
    const delivered = await deliverTaskResult({
      taskId: input.taskId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      resultText,
      ...(factKind === undefined ? {} : { factKind }),
    }, {
      ...(deps.fileDelivery === undefined ? {} : { delivery: deps.fileDelivery }),
      log,
    });
    // 2026-11-19（投递真相切片）：唤醒**成功**但投递没落地（渠道瞬时故障 / 路由拆不出 /
    // 出口剥空）——旧实现只记事件，那句话就此消失，用户永远收不到（而底账上任务已确认）。
    // 后路 = 把**事实**退回既有待注入队列（与降级路径同一条出口、同一个队列；不新建重试、
    // 不重投同一句话）：下一次用户开口由模型补说这件事。只有在「唤醒回合确实产出了一句话」
    // 时才退（降级/silent 路径 wakeStateChangeText 内部已经入队，不退第二次）。
    if (resolved.outcome === 'woken' && !delivered) {
      systemNotes.enqueue(input.principalId, input.sessionId, input.factText);
      log({
        event: 'task_result_delivery_requeued',
        source: input.event,
        principalId: input.principalId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        reason: 'not_sent',
      });
    }
    return delivered;
  }

  /** 「久无动静」提醒出口（runner 的提醒端口回调；事实与兜底句由 runner 侧拼好）。 */
  async function wakeLongRunningNotice(notice: {
    taskId: string;
    principalId: string;
    sessionId: string;
    name?: string;
    minutes: number;
    factText: string;
    fallbackText: string;
  }): Promise<boolean> {
    return await wakeAndDeliverStateChange({
      taskId: notice.taskId,
      principalId: notice.principalId,
      sessionId: notice.sessionId,
      event: 'task_long_running_wake',
      factText: notice.factText,
      fallbackText: notice.fallbackText,
    });
  }

  /**
   * 渠道重投幂等（重复消息，2026-11-19 跨重启）：**底账事实为唯一判据**——同
   * (principal, session, messageId) 在 inbound_messages 表里留账（见 task-store.ts），
   * 进程重启后同一 messageId 不再被当成新消息。查重先于一切副作用（不新起 Main 回合、
   * 不新建任务、不重复执行）；处理失败删行（渠道可重投，不伪造回执）。
   *
   * 本进程在途表只解决**同进程并发重投**：两路相同 messageId 几乎同时到达时，第二条要在
   * 第一条落定后拿到同一句回执，而不是把第一条的 processing 行误读成「上一进程挂了」。
   * 它不承担跨重启判据——那归底账，且落定即删（天然有界，上限只作兜底）。
   */
  const inboundInFlight = new Map<string, Promise<string>>();
  const rememberInFlight = (key: string, reply: Promise<string>): void => {
    inboundInFlight.set(key, reply);
    if (inboundInFlight.size > MESSAGE_REPLY_LIMIT) {
      const oldest = inboundInFlight.keys().next().value;
      if (oldest !== undefined && oldest !== key) inboundInFlight.delete(oldest);
    }
  };
  /** 处理失败/落定后清在途条目（幂等，键可能已不在）。 */
  const forgetInFlight = (key: string): void => {
    inboundInFlight.delete(key);
  };
  /** 一次入站消息的身份事实（审计 + 底账键）。 */
  type InboundIds = {
    principalId: string;
    sessionId: string;
    speakerId: string;
    messageId: string;
  };
  /** 落定底账（置 done + 最终回执）；写失败只降级为观测事件（不翻转本次成功结果）。 */
  const settleInbound = (ids: InboundIds, replyText: string): void => {
    try {
      taskRegistry.store.completeInboundMessage({
        messageId: ids.messageId,
        principalId: ids.principalId,
        sessionId: ids.sessionId,
        replyText,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      log({ event: 'inbound_message_settle_failed', ...ids, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  /** 处理失败：删认领行（失败不缓存，渠道可重投）；删失败只记观测事件。 */
  const releaseInbound = (ids: InboundIds): void => {
    try {
      taskRegistry.store.releaseInboundMessage({ messageId: ids.messageId, principalId: ids.principalId, sessionId: ids.sessionId });
    } catch (error) {
      log({ event: 'inbound_message_release_failed', ...ids, reason: error instanceof Error ? error.message : String(error) });
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

  /** 交付段接线（本体在模块级 deliverTurnFilesCore；装配只注入依赖）。 */
  const deliverTurnFiles = (input: TurnFileDeliveryInput): Promise<TurnFileDeliveryOutcome> =>
    deliverTurnFilesCore(input, {
      fileDelivery: deps.fileDelivery,
      recalcXlsxExecutor,
      workspaceRoot,
      log,
    });

  const handler: ReplyHandler = async (message) => {
    const channel = (message.channel ?? 'wecom').trim() || 'wecom';
    // 可信身份取自渠道事实。**群 = 独立主体**（owner 2026-11-18）：
    //   · 1:1  → principal = `channel:userid`（发消息的人）
    //   · 群聊 → principal = `channel:group:<conversationId>`（整个群一个主体：同群所有人
    //     共享记忆/文件/任务，「围绕群文件讨论」天然成立；个人数据不进群，群主体按配置授权）
    // session 两侧一致 = 聊天窗口（`channel:conversationId`）：同群所有人落在同一份 Pi 会话。
    // 发言人身份**不是** principal，只作审计（下方 speakerId 进事件）。chatType 缺省按 1:1
    // 处理——与适配器缺省一致，没有 chatType 事实就不擅自把人并进某个群主体。
    const isGroupChat = message.chatType === 'group';
    const principalId = isGroupChat
      ? `${channel}:group:${message.conversationId}`
      : `${channel}:${message.wecomUserId}`;
    const sessionId = `${channel}:${message.conversationId}`;
    // 审计事实：这一回合是谁在群里说的（不改 principal，不加任务列）。
    const speakerId = message.wecomUserId;
    // 入站消息身份事实（事件与幂等底账共用同一组键，避免各处重拼）。
    const inboundIds: InboundIds = { principalId, sessionId, speakerId, messageId: message.messageId };
    const principal = deps.config.principals[principalId];
    if (principal === undefined || principal.enabled !== true) {
      log({ event: 'message_refused', principalId, sessionId, speakerId, messageId: message.messageId, reason: 'principal_not_enabled' });
      // 群主体未开通：与未开通个人同一条拒绝路径、同一句话术（不区分主体形态）。
      return `该账号（${principalId}）未开通使用权限，请联系管理员开通。`;
    }
    // 渠道重投（同 messageId）命中：幂等回放既有回执（无任何新副作用）。
    // CAP-01 S1：查重必须先于附件分支——纯附件消息的重投才走缓存，不重复登记。
    const dedupKey = message.messageId.trim() === ''
      ? undefined
      : `${principalId}\u0000${sessionId}\u0000${message.messageId}`;
    if (dedupKey !== undefined) {
      // ① 本进程在途（并发重投）：等第一条落定，回放同一句（不把它误读成「上一进程挂了」）。
      const inFlight = inboundInFlight.get(dedupKey);
      if (inFlight !== undefined) {
        log({ event: 'message_duplicate_replayed', principalId, sessionId, speakerId, messageId: message.messageId, source: 'in_flight' });
        return await inFlight;
      }
      // ② 底账事实：已落定 → 回放存下的回执（零任务、零执行）；未落定 → 上一进程挂了。
      const prior = taskRegistry.store.getInboundMessage({ messageId: message.messageId, principalId, sessionId });
      if (prior !== undefined && prior.state === 'done') {
        log({ event: 'message_duplicate_replayed', principalId, sessionId, speakerId, messageId: message.messageId, source: 'ledger' });
        return prior.replyText ?? '';
      }
      if (prior !== undefined && prior.state === 'processing') {
        log({ event: 'message_still_processing', principalId, sessionId, speakerId, messageId: message.messageId });
        return INBOUND_STILL_PROCESSING_NOTE;
      }
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
        speakerId,
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

    // 认领幂等账（以底账为准的第一次写入）：同进程在途已在上方拦下，这里兜跨进程竞态。
    // 只在确定要处理这条消息时写——超限拒收等「无副作用返回」不占账（未被缓存，渠道可重投）。
    if (dedupKey !== undefined) {
      const claim = taskRegistry.store.claimInboundMessage({
        messageId: message.messageId,
        principalId,
        sessionId,
        claimedAt: new Date().toISOString(),
      });
      if (claim.outcome === 'done') {
        log({ event: 'message_duplicate_replayed', principalId, sessionId, speakerId, messageId: message.messageId, source: 'ledger' });
        return claim.replyText;
      }
      if (claim.outcome === 'processing') {
        log({ event: 'message_still_processing', principalId, sessionId, speakerId, messageId: message.messageId });
        return INBOUND_STILL_PROCESSING_NOTE;
      }
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
          speakerId,
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
          speakerId,
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
        (reply) => {
          // 落定：底账置 done（回执='' 也如实存下），清在途条目。
          if (dedupKey !== undefined) {
            settleInbound(inboundIds, reply);
            forgetInFlight(dedupKey);
          }
          return reply;
        },
        (error: unknown) => {
          // 登记失败不缓存：删认领行，渠道重投可重试（回执不伪造；不标 sent）。
          if (dedupKey !== undefined) {
            releaseInbound(inboundIds);
            forgetInFlight(dedupKey);
          }
          throw error;
        },
      );
      if (dedupKey !== undefined) rememberInFlight(dedupKey, pendingReply);
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
          speakerId,
          messageId: message.messageId,
          fileIds: registered.map((file) => file.fileId),
        });
      }
      // CAP-01 S1 激活语义（v8 §4）：带文字的消息激活本会话全部 TTL 内 pending——指令消息
      // 本身不带附件，不按 messageId。先激活再开回合：回合内的清单/物化读激活后的事实。
      const activated = fileStore.activatePendingInputs({ scope, now: Date.now() });
      if (activated > 0) {
        log({ event: 'pending_files_activated', principalId, sessionId, speakerId, messageId: message.messageId, activated });
      }
      await drainNotifications();
      const session = await sessionFor(principalId, sessionId);
      const turn = await session.send(message.text);
      // B 切片：本回合已把结果交给模型的任务（快活，async 派发有完成投递）——完成投递
      // 对其抑制（一次性核销）。完成回调排在会话链上，读本集时本回合已结束（受理回合内
      // 不产生重复投递）。
      for (const relayedTaskId of turn.relayedTaskIds ?? []) {
        markRelayedInTurn(sessionKey, relayedTaskId);
      }
      // 快活失败/等补充：失败原因本回合已交给模型（模型会向用户说明）——主动推送不重复发。
      for (const suppressedTaskId of turn.pushSuppressedTaskIds ?? []) {
        markPushSuppressedInTurn(sessionKey, suppressedTaskId);
      }
      // A2b 观测：本回合被拦下的重试逐条落事件（对象/操作/执行层码/它的 retryable 声明）。
      // 告警归部署侧读这条事件；宿主不自建告警通道（也是「宁可停下让人介入」的可见面）。
      // 瞬时故障（执行层显式 retryable:true）：不拦，但同样要可见——否则部署侧只看到
      // 「停了」，看不到「一直在试」。
      for (const allowed of turn.retryAllowed ?? []) {
        log({
          event: 'execution_retry_allowed',
          principalId,
          sessionId,
          speakerId,
          operation: allowed.operation,
          object: allowed.object,
          code: allowed.code,
        });
      }
      for (const blocked of turn.retryBlocked ?? []) {
        log({
          event: 'execution_retry_blocked',
          principalId,
          sessionId,
          speakerId,
          operation: blocked.operation,
          object: blocked.object,
          code: blocked.code,
          declaredRetryable: blocked.declaredRetryable ?? 'unset',
        });
      }
      // CAP-01 S1 交付 B（v8 §7）：handler 只返回 text；文件经装配注入的端口在回合末主动投递。
      // 投递失败/无端口时以话术如实纠正正文，但不判回合失败（文件未送达 ≠ 回报失败）。
      // owner 2026-11-19：用户看到的话永远是模型说的——提案回合、只交办回合、no-target
      // 都不再由宿主替换/吞掉模型文本（措辞放手；句柄、waiting_user 校验、同回合自确认
      // 判等待、执行层 one-shot 绑定与 A2b 同对象锁等动作边界一律不动）。
      let reply = turn.reply;
      const files = turn.files ?? [];
      /**
       * 模型自己有没有说话（**在看文件投递结果之前**取）——兜底判据只看这一条事实。
       * 2026-11-19 只读审计 #8：此前兜底条件是「正文空 **且** 无文件」，于是「快活失败 +
       * 模型沉默 + 本回合有文件」时失败话术永不送达（用户只看到文件，不知道失败了）。
       * 沉默与有没有文件无关：有文件也照样要如实说一句。
       * 两种形状都算沉默：①正文空；②正文被会话出口清理成空、由会话用文件通知
       * （`FILES_GENERATED_NOTICE`）顶上的情形（同一个常量、本文件下方投递话术替换也按它判）。
       */
      const modelSilent = turn.reply.trim() === '' || turn.reply === FILES_GENERATED_NOTICE;
      // 缺陷 A：本回合等待窗口观察到的任务终态 + 模型本回合说了话 = 事实已交出 → 对应的
      // 状态变化唤醒一次性抑制（判定与标记机械：看 TurnResult.terminalObservedInTurn 与
      // modelSilent，不猜模型有没有「提到」这件事）。回复为空不标记（唤醒照发，不静默）；
      // 「见附件」占位顶替正文视为沉默（模型没说话，占位句不带终态事实）。
      if (!modelSilent) {
        for (const observation of turn.terminalObservedInTurn ?? []) {
          markWakeSuppressedInTurn(sessionKey, observation.taskId, observation.kind);
        }
      }
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
      // 豁免不能是静默（2026-11-19 复核缺陷的出口）：交办的任务在短等待窗口内完成（快活，
      // 结果已交给模型转述）而模型**全程没说话**——完成回调按 relayed 抑制播报的前提
      // （模型已经说了）不成立，用户会什么都收不到。不得判回合失败（任务已由执行端确认完成：
      // 「请稍后再试」是假话，对写操作还会诱导重做一次写），也不得沉默——按既有降级兜底
      // **如实报完成事实**（taskCompletionFallbackText：「<业务名>」办好了：<结果>；全方案
      // 唯一允许的宿主用户文案），走 deliverTaskResult 同一投递面与四必守记账。完成回调的
      // relayed 抑制照旧（本分支已把事实送达，不重复播报）；宿主的话只走主动投递面，渠道
      // 终帧（模型的话路）不被替换。
      // 判据 = **模型沉默**（与有没有文件无关；2026-11-19 只读审计 #8：带文件时失败话术
      // 永不送达是静默终局的一种）。
      if (modelSilent) {
        for (const relayedTaskId of turn.relayedTaskIds ?? []) {
          const fallbackText = taskCompletionFallbackOf(relayedTaskId);
          // 底账没有结果原文（生产装配不可达：relayed 的完成行必有非空汇报/归档；空汇报落
          // failed 不归档）→ 不编事实、不投递；完成回调照旧按 relayed 记账。
          if (fallbackText === undefined) continue;
          await deliverTaskResult({
            taskId: relayedTaskId,
            principalId,
            sessionId,
            resultText: fallbackText,
            // 投递归属：模型沉默时宿主兜底说的正是完成事实（taskCompletionFallbackText）。
            factKind: 'completed',
          }, {
            ...(deps.fileDelivery === undefined ? {} : { delivery: deps.fileDelivery }),
            log,
          });
        }
        // 快活**失败**同理（2026-11-19 复核相邻形状）：失败原因本回合已交给模型，推送抑制
        // 的前提（模型会转述）在模型沉默时不成立——逐条按既有失败话术如实送达
        // （deliverTaskFailure；事实从底账取，与失败回调同源，不新写一个字）。失败回调
        // 照旧核销抑制（本分支已送达，不重复发）；非失败终局不替它说话：核销本回合抑制，
        // 交回既有终态推送面（各自既有话术）。
        for (const suppressedTaskId of new Set(turn.pushSuppressedTaskIds ?? [])) {
          const failureFact = taskFailureFactOf(suppressedTaskId);
          if (failureFact === undefined) {
            claimPushSuppressedInTurn(sessionKey, suppressedTaskId);
            continue;
          }
          await deliverTaskFailure({
            taskId: suppressedTaskId,
            principalId,
            sessionId,
            ...failureFact,
            // 投递归属：模型沉默时宿主兜底说的正是失败事实（failureFallbackTextFor）。
            factKind: 'failed',
          }, {
            ...(deps.fileDelivery === undefined ? {} : { delivery: deps.fileDelivery }),
            log,
          });
        }
      }
      // 本回合**一无所有**才判回合失败：正文为空 **且** 无文件 **且** 没有交办任何任务
      // （taskIds 空）。交办是**唯一豁免**——任务结果由完成投递/唤醒欠着用户一条，空正文
      // 不是静默终局（owner 2026-11-19 修缺陷：agent.md 要求交办后不复述过程话，模型照做时
      // 不能因为它闭嘴就被判回合失败）。**执行事实不参与豁免**：executions 是内部动作，用户
      // 不会自动收到它——内联只读失败 / 内联写确认 + 空正文 = 用户什么都收不到，必须判失败。
      // 不得当作成功回执：「一无所有」的空串会让渠道一个终帧都不发，也不记 message_done。
      // **「只有文件、正文为空」不判失败**（v8 §7 四必守 #2）：文件走投递面，正文空帧由
      // 投递事实话术/宿主兜底话术补足——判失败就走不到投递了。判失败走既有的「回合失败」
      // 路径（throw；失败不进重投缓存，渠道适配器的 handler 异常分支回失败话术），
      // 不新造机制、不重试。
      if (turnProducedNothing({
        reply,
        fileCount: files.length,
        taskIds: turn.taskIds,
        executions: turn.executions,
      })) {
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
            speakerId,
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
              speakerId,
              messageId: message.messageId,
              message: logError instanceof Error ? logError.message : String(logError),
            });
          } catch {
            // 观测事件写也失败：无第二观测面可用；回合结果已成立，不翻转、不改写话术。
          }
        }
        // 落定底账（置 done + 最终回执）；写失败只降级为观测事件，不翻转成功回执。
        if (dedupKey !== undefined) {
          settleInbound(inboundIds, result.reply);
          forgetInFlight(dedupKey);
        }
        return result.reply;
      },
      (error: unknown) => {
        // 处理失败不缓存：删认领行，渠道可重投（回执不伪造）。
        if (dedupKey !== undefined) {
          releaseInbound(inboundIds);
          forgetInFlight(dedupKey);
        }
        throw error;
      },
    );
    if (dedupKey !== undefined) rememberInFlight(dedupKey, pending);
    return await pending;
  };

  // 重启恢复 + 重启对账（2026-11-19 唤醒切片）：新进程第一次 pump（queued 重领 / 过期租约 →
  // result_unknown 不重放 / completed 不重跑 / `cancelling` 断电遗留 → 取消孤儿回收）放在
  // 装配完成之后——唤醒出口、提醒端口与会话工厂都已就绪，pump 里可能触发的「久无动静」提醒
  // 与这里逐条发起的重启唤醒都不会撞上未定义。
  if (runner !== undefined) {
    const pump = runner.pump();
    startupRecovered = pump.recovered;
    const pendingCancel = new Set(pump.recoveredCancelling ?? []);
    for (const taskId of [...startupRecovered, ...(pump.recoveredCancelling ?? [])]) {
      const scope = taskScopeOf(taskId);
      if (scope === undefined) {
        // 底账读不到（行已清/异常形状）：不猜会话，只记事件。
        log({ event: 'task_restart_wake', taskId, outcome: 'unresolved' });
        continue;
      }
      const name = taskNameOf(taskId, scope.request);
      // 取消孤儿（用户说过停）按「你要我停，我重启前没停完」如实说——别让用户以为停已生效。
      const factText = taskRestartFactText({
        ...(name === undefined ? {} : { name }),
        ...(pendingCancel.has(taskId) ? { pendingCancel: true } : {}),
      });
      // 逐条 fire-and-forget（经会话链，与用户回合串行）：不阻塞启动、不改变任务事实。
      // 宿主侧**没有**这一条的文案（新增出口）：唤醒不可用/失败 = 只记事件（不静默猜）。
      void enqueueSessionTurn(`${scope.principalId}\u0000${scope.sessionId}`, async () => {
        await wakeAndDeliverStateChange({
          taskId,
          principalId: scope.principalId,
          sessionId: scope.sessionId,
          event: 'task_restart_wake',
          factText,
        });
      });
    }
  }

  return {
    handler,
    async deliverPending() {
      await drainNotifications();
    },
    async close() {
      // 停机：撤掉告警聚合扫描定时器（冷却持久化在文件里，重启不重发）、追问定时器与批次。
      alerts?.close();
      attachmentNudge.close();
      attachmentFacts.clear();
      systemNotes.clear();
      relayedInTurnTasks.clear();
      wakeSuppressedInTurn.clear();
      sessions.clear();
      outbox?.close();
      taskRegistry.close();
      // 会话文件归 Pi 独占（无宿主句柄要释放）：这里不清盘、不重写，重启由 Pi 原生 resume。
    },
  };
}
