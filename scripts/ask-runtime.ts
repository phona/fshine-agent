/**
 * 共享装配（ask/redo + server + eval runner 的同一装配点）：
 *   配置 → 生效环境 → 前置门（各入口方言） → 装配核心 → 回合会话。
 *
 * 消费方（不复制第二份装配）：
 *   · scripts/ask.ts    —— npm run ask（purpose='ask'）；
 *   · scripts/tasks.ts  —— npm run tasks -- <id> --redo（purpose='重新推进'）；
 *   · apps/server/server.ts —— 渠道消息回合（每 (principal, session) 一个会话）；
 *   · scripts/eval/convergence-r1/runner.ts —— 评测 trial（注入记录包装器与 per-case 库）。
 *
 * 分层（P0「装配同源」）：
 *   · 各入口的门/方言留在入口侧（server 的部署配置与网关门、runner 的 per-case 配置与隔离门、
 *     ask/redo 的五门）——P0 零行为变化，不把 ask 方言强加给另两入口；
 *   · 门之后的装配链收口到 assembleSessionCore：stateDir/审计路径 → 隔离断言（可选）
 *     → 执行面（缺省仓内 dummy CLI + 只读允许集非空）→ 底账（可注入）→ 技能/角色（可注入）
 *     → 驱动（可注入）→ createSession。它是生产面**唯一**调用 createSession /
 *     createDummyCliClient / readOnlyOperationNames 的文件（P0-T03 守卫钉住）。
 *
 * ask 行为/输出逐字不变（P3 抽取的硬约束，P0 继续钉住）：
 *   · 五处装配门抛 AssemblyRefusedError；ask 侧 catch 后原样打印并 exit 2，话术里的调用方
 *     名词用 purpose 参数化：purpose='ask' 时逐字等于抽取前原文；
 *   · 空只读集合的拒绝类型/话术按入口注入（ask=AssemblyRefusedError；server/runner=普通 Error，
 *     原样保持各自现行为）；
 *   · 其它错误（配置读失败、网关不可启动、隔离门 EvalIsolationRefused 等）照旧上抛，
 *     由入口按各自既有归类处理——本文件不改写错误类别。
 *   · ask.ts 的 rmSync/mkdirSync(.runtime/ask) 留在入口；本文件只写 runtimeDir 下配置
 *     物化副本与 state/audit.jsonl。
 *
 * 本文件不做（边界同 ask）：不落盘会话（Pi 原生转录由调用方内存持有）、不建记忆/检索/
 * 投影、不写任务底账以外的状态。
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextProfileConfig, Permission, RuntimeConfig } from '@fshine/contracts';
import type { ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import {
  effectiveDeploymentEnv,
  effectiveRoleOf,
  loadConfig,
  permissionsOfRole,
} from '@fshine/core';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createModelUsageSink, USAGE_FILENAME, usageFilePathOf } from '../packages/agent/src/model-usage';
import { createPiTurnDriver, parseContextWindow, parsePiThinkingLevel, type PiThinkingLevel, type PiTurnDriverOptions } from '../packages/agent/src/pi-driver';
import type { MainSessionLocation } from '../packages/agent/src/session-persistence';
import { createDummyCliClient, readOnlyOperationNames, writeOperationNames } from '../packages/agent/src/dummy-cli-client';
import { deriveCapabilityCatalog, renderCapabilitySummary, type CapabilityEntry } from '../packages/agent/src/capability-catalog';
import type { TurnDriver } from '../packages/agent/src/driver-contract';
import {
  createSession,
  createTaskExecutor,
  mainProtocolNoteFor,
  OUTCOME_BEHAVIOR_NOTE,
  type Session,
  type TurnFileRef,
  type WorkerSkill,
  type RunJsMemoryExitEvent,
  type RunJsLayoutUnsafeReport,
  type RecalcXlsxExecutor,
  type RecalcCostEvent,
  type TaskOutputSweepSkippedEvent,
  type ExecutionResultFileizedEvent,
  type ExecutionResultOversizeUnhandledEvent,
  type ExecutionEvent,
  type InjectionReceipt,
  type InjectionValue,
} from '../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationOutbox,
  type NotificationReason,
  type NotificationSink,
} from '../packages/agent/src/notifications';
import { renderNotification } from '../packages/agent/src/notification-render';
import { createResourcePolicy, resolveRuntimeConfig, type ResourcePolicy } from '../packages/agent/src/resource-policy';
import type { TaskRegistry } from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import type { RunJsExecutor } from '../packages/agent/src/run-js-executor';
import type { TaskInputCopier } from '../packages/agent/src/file-store';
import { createTaskExecutionBridge, type TaskFileBridgeStore } from '../packages/agent/src/task-file-bridge';
import {
  createTaskRunner,
  type LongRunningNoticePort,
  type LongTaskWaitPort,
  type PartialCompletionFact,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRunner,
  type WaitingUserNoticePort,
} from '../packages/agent/src/task-runner';
import { failureMessageFor } from '../packages/agent/src/user-facing-failure';
import { defaultMainSkillsDir, loadMainSkillDelivery, loadWorkerSkills } from '../packages/agent/src/worker-skills';
import type { SkillRegistry } from '../packages/agent/src/skills';
import { explicitConfigFrom, materializeEvalConfig } from './resolve-config-path';
import { EvalIsolationRefused, assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, '.runtime', 'state.db');

/** 装配前置门拒绝：入口按「前置错误」处理（ask 原样打印 message 并 exit 2）。 */
export class AssemblyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssemblyRefusedError';
  }
}

/**
 * 前置拒绝判定（装配门 + 隔离门）。
 * redo 按 exit 2 归类；ask 不消费隔离门这一条（ask 的隔离门拒绝沿用旧归类：顶层
 * 'ask 运行失败' + exit 1），抽取不追改既有行为。
 */
export function isAssemblyRefusal(error: unknown): boolean {
  return error instanceof AssemblyRefusedError || error instanceof EvalIsolationRefused;
}

export interface AskRuntimeInput {
  /** 调用方名词（进拒绝话术）：ask='ask'；redo='重新推进'。 */
  purpose: string;
  /** 入口 argv（只读其中的 --config=；其余参数由各入口自行解析）。 */
  argv: readonly string[];
  /** 进程 env（原样透传；EXECUTION_AUDIT_PATH 写在派生的生效环境上）。 */
  env: NodeJS.ProcessEnv;
  /** 运行时目录：配置物化副本与 state/audit.jsonl 都落这里。 */
  runtimeDir: string;
  /** 新会话 id。 */
  sessionId: string;
  /** 可信 principal；缺省 = 配置里第一个 enabled principal（ask 现行为）。 */
  principalId?: string;
  /** 显式底账路径（redo 传已解析出的同一库；缺省按配置链）。 */
  dbPath?: string;
  /**
   * Main 技能目录覆盖（**仅代码/测试装配参数**，不是配置键）：缺省 = `<repo>/.agents/skills`
   * （`defaultMainSkillsDir()`）。eval/实验用它把某一臂指向夹具/空目录；生产入口不传。
   */
  mainSkillsDir?: string;
}

export interface AskRuntime {
  session: Session;
  principalId: string;
  sessionId: string;
  dbPath: string;
  auditPath: string;
  stateDir: string;
  /** 关闭底账（进程收尾）。 */
  close(): void;
}

/**
 * 执行面：结构化执行客户端 + 本轮允许集合 + 只读集合（装配核心的产出面）。
 * 只读集合必须由执行层 `access=read` 显式派生，独立于允许集合——写操作进入允许集合时
 * 不得被误当只读（重试会变成二次执行）；缺省注入面也必须显式给出，不允许回落。
 */
export interface ExecutionFace {
  client: ExecutionClient;
  allowedOperations: readonly string[];
  readOnlyOperations: readonly string[];
}

/** 执行面工厂（server 测试替身注入用；缺省 = 仓内 dummy CLI + 只读允许集非空校验）。 */
export type ExecutionFaceFactory = (
  profile: ContextProfileConfig,
  env: NodeJS.ProcessEnv,
) => Promise<ExecutionFace>;

/**
 * 回合驱动工厂（runner 记录包装器 / server 测试替身注入用；缺省 = 真实 Pi 驱动 ×2）。
 * 允许返回 Promise：Pi 1.5.2 的 ModelRuntime 创建是异步的（测试替身按需 await）。
 * `mainSession` = 装配层为本 (principal, session) 解析的 Pi 会话位置（缺省 = 不落盘）；
 * 真实 Pi 驱动据此落盘/resume，测试替身可忽略。
 */
export type DriverFactory = (
  env: NodeJS.ProcessEnv,
  mainSession?: MainSessionLocation,
) =>
  | { mainDriver: TurnDriver; workerDriver: TurnDriver }
  | Promise<{ mainDriver: TurnDriver; workerDriver: TurnDriver }>;

/**
 * 压缩窗口装配接线（缺口 3）：把配置层写进 env 的 `LLM_CONTEXT_WINDOW`（config.ts:442）经既有
 * `parseContextWindow` 解析成驱动的 `contextWindow` 参数——装配层持有配置、驱动只收参数（pi-driver.ts:145
 * 的选项契约）。未设置/空串 → 返回 `{}`，驱动 options 不含 contextWindow，走 128k 缺省（逐字节不变）；
 * 非法值 → parseContextWindow 当场抛中文错误点名变量（不静默回落，理由见 pi-driver.ts:129）。
 */
export function contextWindowFrom(env: Record<string, string | undefined>): { contextWindow?: number } {
  const parsed = parseContextWindow(env.LLM_CONTEXT_WINDOW, 'LLM_CONTEXT_WINDOW');
  return parsed === undefined ? {} : { contextWindow: parsed };
}

/**
 * 压缩配置装配接线（配置修正·余量）：把绝对 `reserveTokens`/`keepRecentTokens` 经两个
 * 环境变量传给驱动的 `PiTurnDriverOptions.compactionSettings`——**纯配置透传**，不含任何
 * 压缩决策/阈值判定（触发/执行/摘要/尾段仍全归 Pi）。
 *
 * · 两个变量都不设置/空串 → 返回 `{}`，驱动走 `piCompactionSettings(window)` 缺省派生，
 *   行为逐字节不变（`npm run ask` / 既有入口零变化）。
 * · 只设一个 → 装配期 fail-fast 点名两个变量（半套绝对配置会让 Pi 的 reserve/keepRecent
 *   组合不可解释，静默补齐等于替调用方发明阈值）。
 * · 非正整数 → `parseContextWindow` 当场抛中文错误点名变量（不静默回落）。
 *
 * 安全值来源见 `scripts/eval/pi-native/safe-config.ts`（余量不等式 + 摘要输出预算推导的实现；
 * 推导文档 2026-11-18 删除，git 历史可考）。
 */
export function compactionSettingsFrom(
  env: Record<string, string | undefined>,
): { compactionSettings?: NonNullable<PiTurnDriverOptions['compactionSettings']> } {
  const reserveTokens = parseContextWindow(env.LLM_COMPACTION_RESERVE_TOKENS, 'LLM_COMPACTION_RESERVE_TOKENS');
  const keepRecentTokens = parseContextWindow(env.LLM_COMPACTION_KEEP_RECENT_TOKENS, 'LLM_COMPACTION_KEEP_RECENT_TOKENS');
  if (reserveTokens === undefined && keepRecentTokens === undefined) return {};
  if (reserveTokens === undefined || keepRecentTokens === undefined) {
    throw new Error('LLM_COMPACTION_RESERVE_TOKENS 与 LLM_COMPACTION_KEEP_RECENT_TOKENS 必须同时设置（只设一个时无法解释 Pi 的压缩配置）');
  }
  return { compactionSettings: { enabled: true, reserveTokens, keepRecentTokens } };
}

/**
 * Main 思考档装配接线（缺口 4：`llm.mainThinkingLevel` 此前在产品代码里零读取——Main 与
 * Worker 共用 `llm.thinkingLevel` 一档）。owner 决定：Main 高、Worker 中。
 *
 *   · `LLM_MAIN_THINKING_LEVEL`（配置层写回自 llm.mainThinkingLevel）优先；
 *   · 未设/空串回落 `LLM_THINKING_LEVEL`——Main 不出现"无档位"，向后兼容；
 *   · 非法档位由 parsePiThinkingLevel 当场抛中文错误点名变量（fail-fast，不静默降级成
 *     供应商/Pi 缺省）。
 *
 * Worker 侧不传参数：驱动的缺省解析（pi-driver.ts:392）就是 `llm.thinkingLevel`。
 */
export function mainThinkingLevelFrom(
  env: Record<string, string | undefined>,
): { thinkingLevel?: PiThinkingLevel } {
  const level = parsePiThinkingLevel(env.LLM_MAIN_THINKING_LEVEL, 'LLM_MAIN_THINKING_LEVEL')
    ?? parsePiThinkingLevel(env.LLM_THINKING_LEVEL, 'LLM_THINKING_LEVEL');
  return level === undefined ? {} : { thinkingLevel: level };
}

/**
 * 会话位置 → Pi 驱动参数（纯映射，无决策）：
 *   · `sessionDir` = 本 principal 的独立会话目录；
 *   · `sessionId` = 新建时交给 Pi 的会话 id（文件名/header 同源，重启按它解析回来）；
 *   · `resumeSessionFile` = 已落盘会话文件（存在才有）→ Pi 原生 resume（含压缩摘要）。
 * 缺省不传 = 进程内内存会话（`npm run ask` / eval / 无渠道入口逐字节不变）。
 */
export function mainSessionOptions(
  mainSession: MainSessionLocation | undefined,
): Pick<PiTurnDriverOptions, 'sessionDir' | 'sessionId' | 'resumeSessionFile'> {
  if (mainSession === undefined) return {};
  return {
    sessionDir: mainSession.sessionDir,
    sessionId: mainSession.piSessionId,
    ...(mainSession.resumeSessionFile === undefined
      ? {}
      : { resumeSessionFile: mainSession.resumeSessionFile }),
  };
}

/**
 * CAP-01 S2：执行层文件桥装配参数（inline 会话面与 background 后台面同形）。
 * store 必须是装配层唯一 fileStore 实例；platformRoot/scope/inner 由各自的构造点填。
 */
export interface TaskFileBridgeAssembly {
  store: TaskFileBridgeStore;
  dirParams?: { input?: string; output?: string };
  /** 单文件参数（执行层吃一个文件 / 写一个文件）：宿主填物化路径，不猜。 */
  fileParams?: { input?: string; output?: string };
  limits?: { maxOutputFileBytes?: number; maxOutputCount?: number };
  onSkip?: (reason: string) => void;
}

/**
 * 装配核心输入。各入口在门之后调用：本核心不做任何门判定、不改错误归类；
 * 一切差异（驱动/执行面/底账/技能提示词/审计路径/隔离断言/空集合话术）都从输入注入。
 */
export interface SessionAssemblyInput {
  /** 生效环境（调用方负责把配置派生值合入；核心按 setAuditPath 写 EXECUTION_AUDIT_PATH）。 */
  env: NodeJS.ProcessEnv;
  /** 已解析的单一 profile（各入口的 profile/gateway 门与方言在调用方）。 */
  profile: ContextProfileConfig;
  principalId: string;
  sessionId: string;
  /** 任务底账路径（注入 taskRegistry 时不再使用）。 */
  dbPath: string;
  /** 状态目录：审计文件落点与 dummy 客户端 --state-dir。 */
  stateDir: string;
  /**
   * true = 确保 stateDir 存在并写 EXECUTION_AUDIT_PATH=<stateDir>/audit.jsonl
   * （ask/redo/runner 现行为）；server 不设（保持「不建目录、不设审计 env」现行为）。
   */
  setAuditPath?: boolean;
  /** 隔离门断言（ask/redo 传 purpose 串；runner 传 case 标签；server 不传）。 */
  assertIsolation?: () => void;
  /** 空只读集合拒绝话术（各入口方言，逐字节保持）。 */
  emptyOperationsMessage: string;
  /** 空集合抛出的错误构造（ask 传 AssemblyRefusedError；缺省普通 Error = server/runner 现行为）。 */
  emptyOperationsError?: (message: string) => Error;
  /**
   * 写面开关（`runtime.allowWriteOperations` 的装配投影；缺省 false = 只读）。
   * true 时仍要看 `allowedPermissions` 是否含 write：两者同时满足写集合才进入允许集合；
   * 只读集合仍只含 access=read。
   */
  allowWriteOperations?: boolean;
  /**
   * 当前主体角色的权限白名单（宿主求交的中间项）。缺省 / 未提供 = 只读（最小权限）。
   * 实际允许集合 = 执行层声明能力 ∩ 本白名单 ∩ 部署总闸。
   */
  allowedPermissions?: readonly Permission[];
  /**
   * 长任务异步（契约 v4）的结构化事件出口（只进日志，不进用户话术）。
   * 前台会话与后台执行器共用同一个出口；缺省静默。
   */
  onExecutionEvent?: (event: ExecutionEvent) => void;
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 预装载底账（server 共享库）；缺省自建并由 close 关闭（注入的归调用方）。 */
  taskRegistry?: TaskRegistry;
  /** 预装载 Main 系统提示（server 启动时装载一次）；缺省现装。 */
  mainSystemPrompt?: string;
  /** 预装载 Main 技能登记表（server 启动时装载一次）；缺省随 Main 提示现装（非空 catalog 才有）。 */
  mainSkillRegistry?: SkillRegistry;
  /**
   * Main 技能目录覆盖（**仅代码/测试装配参数**，不是配置键）：缺省 = `<repo>/.agents/skills`
   * （仓库根标记法定位）。用于实验/测试指向夹具目录；生产入口一律不传。
   */
  mainSkillsDir?: string;
  /** 预装载 Worker 技能（server 启动时装载一次）；缺省现装。 */
  workerSkills?: readonly WorkerSkill[];
  /** P5：runtime 段（资源强制单一配置入口）；缺省 = 现行为缺省（前台并发 4/排队 16/无任务级预算）。 */
  runtime?: RuntimeConfig;
  /** P5：进程级共享策略（server 跨会话复用）；缺省由本核心按 runtime 建。 */
  policy?: ResourcePolicy;
  /**
   * P6：任务派发装配参数（**只由装配方显式传入，不是配置键**）。缺省 'sync' = 委派
   * 同步执行；'async' 需要渠道/后台面（server 装配传 'async'，ask/eval 传 'sync'）。
   */
  taskDispatch?: 'sync' | 'async';
  /** P6：进程级共享 runner（server 预建）；background 且缺省时由本核心按本会话执行面构建。 */
  taskRunner?: TaskRunner;
  /** P6：后台执行回合注入（测试/特殊部署）；缺省 = 真实 Worker 回合执行器。 */
  taskExecutor?: TaskExecutor;
  /** P4：通知 sink（提供且 background 时建 outbox 并挂 onTaskFact；生产由 server 注入）。 */
  notificationSink?: NotificationSink;
  /** P4：outbox attempts 上限（缺省模块缺省 5；reader 需同值对账）。 */
  notificationMaxAttempts?: number;
  /** R5 B 通道：机械事实注入器（server 由 attachNotificationOutbox 返回值提供）。 */
  taskFactProvider?: NotificationAttachment['taskFactProvider'];
  /**
   * Main 会话的 Pi 原生落盘位置（装配层解析 `(principal, session)`；缺省 undefined =
   * 内存会话，`npm run ask` / eval 逐字节现行为）。给出后由 Pi 自己写入/恢复：历史与
   * 压缩摘要都在会话文件里，宿主不搬运任何消息。
   */
  mainSession?: MainSessionLocation;
  /** 纯附件机械事实注入器（与 taskFactProvider 同一 injections 机制；缺省不注入）。 */
  attachmentFactProvider?: (principalId: string, sessionId: string) => InjectionValue | undefined;
  /** 主动追问系统注记注入器（模型可见/用户不可见；缺省不注入）。 */
  systemNoteProvider?: (principalId: string, sessionId: string) => InjectionValue | undefined;
  /** CAP-01 S1：run_js 执行器端口（装配层构造注入；缺省不注入 = Main 无 run_js 工具）。 */
  runJsExecutor?: RunJsExecutor;
  /** recalc_xlsx 执行器端口（Main 宿主面；缺省不注入或引擎不可用 = 无该工具）。 */
  recalcXlsxExecutor?: RecalcXlsxExecutor;
  /** recalc 重算开销结构化事件（R4 资源账；缺省静默）。 */
  onRecalcCost?: (event: RecalcCostEvent & { principalId: string; sessionId: string }) => void;
  /** CAP-01 ④：run_js 内存墙结构化事件上报（装配层接日志；缺省静默）。 */
  onRunJsMemoryExit?: (event: RunJsMemoryExitEvent) => void;
  /** CAP-01 symlink 收窄：run_js 运行目录布局不安全的结构化事件上报（装配层接日志；缺省静默）。 */
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
  /**
   * 文件引用被拒（run_js.inputs / task_run.inputFiles：越权/不存在/pending/过期/字节缺失）
   * 的机械 reason 上报（**只进日志，不进用户话术**——防存在性 oracle；缺省静默）。
   * 装配层接结构化事件（如 server 的 `file_ref_unavailable`）。
   */
  onFileRefUnavailable?: (reason: string) => void;
  /**
   * 任务 out/ 兜底扫描的逐项拒收上报（taskId + 数量 + reason 分布；只进日志，缺省静默）。
   * 装配层接结构化事件（如 server 的 `task_output_sweep_skipped`）。
   */
  onTaskOutputSweepSkipped?: (event: TaskOutputSweepSkippedEvent) => void;
  /**
   * 大响应已文件化（2026-11-19；只进日志，缺省静默）：Worker completed 结果超过
   * `runtime.oversizeDataBytes` → 完整 data 落任务文件，模型只拿摘要 + fileId。
   */
  onExecutionResultFileized?: (event: ExecutionResultFileizedEvent) => void;
  /** 大响应未文件化（无桥/登记失败，已 fail-open；只进日志，缺省静默）。 */
  onExecutionResultOversizeUnhandled?: (event: ExecutionResultOversizeUnhandledEvent) => void;
  /**
   * CAP-01 S2：交办复制端口（task_run.inputFiles 的宿主侧执行；装配层注入 fileStore 本身）。
   * 缺省不注入 = task_run 工具面不带 inputFiles（逐字节不变），模型传了也 fail-closed 拒绝。
   */
  taskInputCopier?: TaskInputCopier;
  /**
   * CAP-01 S2 ②③④：执行层文件桥装配（有值 = 会话执行面经任务文件桥装饰）。store 必须与
   * taskInputCopier **同一 fileStore 实例**（文件区监管唯一写侧）；dirParams 是部署对该执行
   * 层「声明目录参数」的认知（如 '--input-dir'），缺省无 = 桥只承担回程登记与任务 out/ 兜底。
   * 桥在装配核心构造（内层客户端只有这里拿得到：platformRoot=profile.root、scope=本会话身份）。
   * 同一装配参数也供 background 面（按任务懒建桥）。
   */
  taskExecutionBridge?: TaskFileBridgeAssembly;
  /**
   * CAP-01 S1 清单注入（机械事实）：装配层提供本会话已激活（TTL 内）文件清单——
   * 字段只有 fileId/name/bytes。缺省不注入 = 无清单（回合输入逐字节不变）。
   */
  fileManifestProvider?: (principalId: string, sessionId: string) => readonly TurnFileRef[];
  /** P6：runner 覆盖（测试确定性：leaseMs/时钟/属主）。 */
  runnerOptions?: { leaseMs?: number; owner?: string; now?: () => Date };
}

/** 装配核心产出：会话 + 本次使用的面（调用方按需读取/关闭）。 */
export interface AssembledSession {
  session: Session;
  auditPath: string;
  /** 本次使用的底账（注入的原样返回；自建的由 close 关闭）。 */
  taskRegistry: TaskRegistry;
  /** P5：本会话使用的资源策略（注入的原样返回；自建随 close 丢弃）。 */
  policy: ResourcePolicy;
  /** P6：background 模式的后台运行器（注入或自建）；inline 模式 undefined。 */
  runner?: TaskRunner;
  /** P4：本核心建的通知 outbox（未注入 sink/非 background 时 undefined；close 关闭）。 */
  notifications?: NotificationOutbox;
  /** 关闭自建底账/outbox；注入的归调用方（不在此关）。 */
  close(): void;
}

/** 缺省执行面：仓内 dummy CLI + 执行层自述派生的**全集**（读 + 部署总闸允许时的写）。 */
async function defaultExecutionFace(input: {
  profile: ContextProfileConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  emptyOperationsMessage: string;
  emptyOperationsError: (message: string) => Error;
  /** true = 部署总闸允许写面（缺省 false = 只读）。角色求交在 resolveExecutionFace 收口。 */
  allowWriteOperations?: boolean;
}): Promise<ExecutionFace> {
  const client = createDummyCliClient({
    root: input.profile.root,
    gateway: input.profile.gateway!,
    stateDir: input.stateDir,
    env: input.env,
  });
  const operations = await client.listOperations();
  // 两条集合各自派生：只读集合只看 access=read；写集合只看 access=write。写操作进入
  // 允许集合时，只读集合不会跟着变大——重试语义不随写面开关变化。
  const readOnlyOperations = readOnlyOperationNames(operations);
  const writeOperations = writeOperationNames(operations);
  const allowedOperations = input.allowWriteOperations === true
    ? [...readOnlyOperations, ...writeOperations]
    : [...readOnlyOperations];
  if (allowedOperations.length === 0) {
    throw input.emptyOperationsError(input.emptyOperationsMessage);
  }
  return { client, allowedOperations, readOnlyOperations };
}

/**
 * 宿主求交（唯一收口）：实际可用集合 = 执行层声明能力 ∩ 角色白名单 ∩ 部署总闸。
 *   · read  → 只并入执行层自述 access=read 的只读集合；
 *   · write → 角色含 write 且部署总闸打开时，才并入写集合（即基面里不在只读集合的那些）；
 *   · 角色未提供 / 不含 write / 总闸关闭 → 一律只读（最小权限，不静默给写）。
 *
 * 同时作用于缺省执行面与注入的 `createExecutionFace`——角色过滤不因替身注入而失效。
 */
/**
 * 权限集合的缓存键（内部；导出只为绊线测试）。必须是**集合本身**：只分 read/read+write
 * 两档会让自定义角色（例如只有 write）与读写角色共用同一个执行器，后者的只读面被吞。
 */
export function permissionsKey(permissions: readonly Permission[]): string {
  return permissions.length === 0 ? 'none' : [...permissions].sort().join('+');
}

function narrowFaceByPermissions(
  face: ExecutionFace,
  permissions: readonly Permission[],
  allowWriteOperations: boolean,
  emptyOperationsError: (message: string) => Error,
  emptyOperationsMessage: string,
): ExecutionFace {
  const readOnly = [...face.readOnlyOperations];
  const writeOnly = face.allowedOperations.filter((operation) => !face.readOnlyOperations.includes(operation));
  const allowedOperations = [
    ...(permissions.includes('read') ? readOnly : []),
    ...(permissions.includes('write') && allowWriteOperations ? writeOnly : []),
  ];
  if (allowedOperations.length === 0) {
    throw emptyOperationsError(emptyOperationsMessage);
  }
  return { client: face.client, allowedOperations, readOnlyOperations: readOnly };
}

/**
 * 执行层 wait 回执 → runner 的机械等待结果（只做形状投影，不改语义）。
 * accepted 带 pollAfterMs；failed/refused 带执行层原话；其余终态原样交给续跑回合。
 */
function longTaskWaitResultOf(outcome: ExecutionOutcome): {
  status: 'accepted' | 'completed' | 'failed' | 'refused' | 'needs_input' | 'needs_confirmation';
  pollAfterMs?: number;
  message?: string;
  outcome: ExecutionOutcome;
} {
  return {
    status: outcome.status,
    ...(outcome.status === 'accepted' ? { pollAfterMs: outcome.pollAfterMs } : {}),
    ...(outcome.status === 'failed' || outcome.status === 'refused' ? { message: outcome.error.message } : {}),
    outcome,
  };
}

/**
 * 长任务等待端口（契约 v4）：执行面客户端声明了 `wait` 才接。
 * 未声明（或注入的假客户端没有该能力）→ 不接端口，runner 对 accepted 一律 fail-closed
 * （任务落 failed 并落事件），不会留下无人推进的 running 任务。
 */
function longTaskPortOf(client: ExecutionClient): LongTaskWaitPort | undefined {
  if (client.wait === undefined) return undefined;
  return {
    // 必须经 client 调用（不能解构后裸调）：适配器实现允许依赖 this。
    wait: async (operationId, timeoutMs, signal) =>
      longTaskWaitResultOf(await client.wait!(operationId, timeoutMs, signal)),
    ...(client.abort === undefined ? {} : { abort: (operationId: string) => client.abort!(operationId) }),
  };
}

/** 执行面解析（注入优先，缺省仓内 dummy；后台派发与装配核心共用同一链，不另建装配）。 */
export interface ExecutionFaceResolverInput {
  profile: ContextProfileConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  emptyOperationsMessage: string;
  emptyOperationsError?: (message: string) => Error;
  /** true = 部署总闸允许写面（缺省 false = 只读）。仍需角色含 write。 */
  allowWriteOperations?: boolean;
  /** 当前主体角色的权限（read/write）；缺省 = 只读。 */
  allowedPermissions?: readonly Permission[];
  createExecutionFace?: ExecutionFaceFactory;
}

export async function resolveExecutionFace(input: ExecutionFaceResolverInput): Promise<ExecutionFace> {
  const allowWriteOperations = input.allowWriteOperations === true;
  const permissions = input.allowedPermissions ?? ['read'];
  const emptyOperationsError = input.emptyOperationsError ?? ((message: string) => new Error(message));
  const face = input.createExecutionFace !== undefined
    ? await input.createExecutionFace(input.profile, input.env)
    : await defaultExecutionFace({
        profile: input.profile,
        env: input.env,
        stateDir: input.stateDir,
        emptyOperationsMessage: input.emptyOperationsMessage,
        emptyOperationsError,
        ...(input.allowWriteOperations === undefined ? {} : { allowWriteOperations: input.allowWriteOperations }),
      });
  return narrowFaceByPermissions(
    face,
    permissions,
    allowWriteOperations,
    emptyOperationsError,
    input.emptyOperationsMessage,
  );
}

/** worker 回合上限之上的租约余量：覆盖最长回合 + 收尾，避免在飞回合被误判 result_unknown。 */
const LEASE_MARGIN_MS = 60_000;

/**
 * 后台派发装配（P6）：解析 runtime → 执行面/worker 驱动（可复用或自建）→ 单回合执行器
 * （可注入假件）→ TaskRunner。runner 为**进程级**对象，由入口（server）或装配核心构建后
 * 注入会话；本函数不 pump（触发点由调用方掌握：受理后/落定后/启动恢复）。
 */
/**
 * 一次后台执行回合收尾、宿主**投递面**需要的事实（B 切片完成回调接缝；2026-11-23 去 outcome：
 * 触发条件是**有 worker 汇报原文**——这是事实，不是「成功」判定）。
 * **不携带任务结论**：做没做成由 Main 读账本 executions + 死亡事实 + 汇报自己判断。
 */
export interface BackgroundTaskCompletion {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /** worker 汇报原文（有汇报才回调；逐字，未过出口清理）。 */
  resultText: string;
  /**
   * 片 1 产物回程：本回合 Worker 产出的任务作用域交付物（登记事实；后台面对
   * TurnResult.files 的同位面）。缺省 = 本回合无产物。
   */
  files?: readonly TurnFileRef[];
  /** 零执行的机械原因码（如 `not_permitted`）；只供兜底话术归类，不进用户文本。 */
  reasonCode?: string;
  /** 末次原始失败执行事实的错误码；只供兜底话术归类，不进用户文本。 */
  errorCode?: string;
  /** 机械原因原文（执行层失败原文 / 宿主零执行原因）；投递面事实文案用，不进用户文本原样。 */
  reason?: string;
  /** 部分完成事实（已完成对象 + 未成功对象）：只供兜底话术逐项说清，不是任务状态。 */
  partial?: PartialCompletionFact;
}

/**
 * 一次后台执行回合收尾、宿主**失败投递面**需要的事实（2026-11-19 收口；S1 改形；
 * 2026-11-22 补 errorCode/reason；2026-11-23 去 outcome）。触发条件是**没有 worker 汇报原文**
 * 或**结果未知**——两者都是机械事实，不是「失败」判定（做没做成由 Main 读账本事实自己判断）。
 * 回调只带机械事实：种类（无汇报 / 结果未知）、零执行的结构化原因码、原始错误码与失败原文；
 * 做没做成的证据（逐笔执行行）由唤醒面从底账读出喂给 Main。
 */
export interface BackgroundTaskFailure {
  taskId: string;
  principalId: string;
  sessionId: string;
  request: string;
  /** 机械事实种类（no_report = 回合收尾但没有汇报原文；result_unknown = 结果未知）。 */
  status: 'no_report' | 'result_unknown';
  /** 零执行的机械原因码（如 `not_permitted` = 发起前被宿主拒绝）；不是文案，不进用户文本。 */
  reasonCode?: string;
  /** 末次原始失败执行事实的错误码；只用于兜底归类，不进用户文本。 */
  errorCode?: string;
  /** 机械原因原文（投递面事实文案用；不进用户文本原样）。 */
  reason?: string;
  /** 部分完成事实（已完成对象 + 未成功对象）：只供兜底话术逐项说清，不是任务状态。 */
  partial?: PartialCompletionFact;
}

export interface BackgroundDispatchInput {
  env: NodeJS.ProcessEnv;
  profile: ContextProfileConfig;
  stateDir: string;
  /**
   * 部署状态根下的任务底账 db 路径（缺省不传 = 用量落盘退回 stateDir）：兜底 Worker 驱动的
   * usage.jsonl 按 `<dbPath 同目录>/usage.jsonl` 落，与前台 Main/inline Worker 同一文件。
   */
  dbPath?: string;
  registry: TaskRegistry;
  policy: ResourcePolicy;
  workerSkills?: readonly WorkerSkill[];
  runtime?: RuntimeConfig;
  /** `runtime.allowWriteOperations` 的显式投影（缺省取 runtime 值；false = 只读）。 */
  allowWriteOperations?: boolean;
  /**
   * 本装配默认主体的角色权限（构造单会话 runner 时用）；缺省 = 只读。
   * 进程级 runner 跨主体复用时，改用 `permissionsForPrincipal` 按任务主体求交。
   */
  allowedPermissions?: readonly Permission[];
  /**
   * 按任务主体解析角色权限（进程级 runner 用：server 的共享 runner 跨 principal）。
   * 提供时按 `task.principalId` 为每个权限档位建一个执行器（只读 / 读写各一份），
   * 任务执行时按主体取对应允许集合——viewer 的后台写不会借用 operator 的允许集。
   */
  permissionsForPrincipal?: (principalId: string) => readonly Permission[];
  emptyOperationsMessage: string;
  emptyOperationsError?: (message: string) => Error;
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 测试注入：假后台执行器（缺省 = 真实 Worker 回合执行器）。 */
  taskExecutor?: TaskExecutor;
  /**
   * B 切片（工单回执收敛）：后台回合**有汇报**时的投递回调——触发条件是事实（有 worker 汇报
   * 原文），不是「成功」判定。每任务恰好一次；回调在 runner 收尾前同步触发，回调自身负责
   * 异步化（fire-and-forget：不得阻塞收尾、不得改变任务事实）。缺省不接 = 零行为变化。
   */
  onTaskCompleted?: (completion: BackgroundTaskCompletion) => void;
  /**
   * 后台回合**没有汇报**时的投递回调（2026-11-19 收口，与 onTaskCompleted 对称；2026-11-23
   * 去 outcome）：触发条件是事实（回合收尾但没有汇报原文 / 结果未知）。
   * **只带机械事实（status/reason）**；用户可见文本由投递面按原始执行事实生成，不在这里拼话术。
   * 缺省不接 = 零行为变化。
   */
  onTaskFailed?: (failure: BackgroundTaskFailure) => void;
  /** 预构建执行面/worker 驱动（装配核心复用；已给 taskExecutor 时不需要）。 */
  face?: ExecutionFace;
  workerDriver?: TurnDriver;
  /**

   * 片 1：run_js 执行器端口（装配层构造注入，与前台同一实例/构造）。注入后后台 Worker
   * 工具面含 run_js（任务作用域），产物经完成回调上交投递面。缺省不注入 = 零变化。
   */
  runJsExecutor?: RunJsExecutor;
  /**
   * CAP-01 S2 后台文件面：执行层文件桥装配（与 inline 会话面同一形状/同一 store 实例）。
   * 有值 = 本 runner 的每个任务按 (principal, session, taskId) 懒建桥：Worker 委派带任务
   * 文件清单，execute_operation 经桥把声明参数替换为任务目录内的物化路径。
   * 缺省不注入 = 零变化（后台 Worker 无文件面）。
   */
  taskExecutionBridge?: TaskFileBridgeAssembly;
  /**
   * 文件引用被拒（桥物化失败：越权/不存在/pending/过期/字节缺失）的机械 reason 上报；
   * 只进日志，用户/Worker 只见统一话术（与 inline 同一模块常量）。
   */
  onFileRefUnavailable?: (reason: string) => void;
  /**
   * 大响应文件化事件（2026-11-19；只进日志，缺省静默）：后台 Worker 的 completed 结果
   * 超过 `runtime.oversizeDataBytes` → 完整 data 落任务文件 / 无桥时 fail-open 原样返回。
   */
  onExecutionResultFileized?: (event: ExecutionResultFileizedEvent) => void;
  onExecutionResultOversizeUnhandled?: (event: ExecutionResultOversizeUnhandledEvent) => void;
  /**
   * 预期契约（2026-11-18）：长时间无动静提醒的投递端口（装配方接既有主动投递面 +
   * 1:1 判据）。缺省不接 = 不提醒（无法投递就不打扰）。
   */
  longRunningNotice?: LongRunningNoticePort;
  /**
   * 等待用户提醒端口（2026-11-21 live P0）：后台任务由非等待态进入 waiting_user 时触发
   * 恰好一次（形状见 task-runner 的 {@link WaitingUserNoticePort}）；装配方接统一状态变化
   * 唤醒出口。缺省不接 = 零行为变化。
   */
  waitingUserNotice?: WaitingUserNoticePort;
  /** 长任务异步（契约 v4）的结构化事件出口（只进日志；缺省静默）。 */
  onExecutionEvent?: (event: ExecutionEvent) => void;
  /** 结构化事件出口（提醒成功/失败；缺省静默）。 */
  log?: (line: Record<string, unknown>) => void;

  /** runner 覆盖（测试确定性：leaseMs/时钟/属主；缺省 leaseMs=workerTurnMs+60s）。 */
  runnerOptions?: { leaseMs?: number; owner?: string; now?: () => Date };
}

export interface BackgroundDispatch {
  runner: TaskRunner;
}

export async function createBackgroundDispatch(input: BackgroundDispatchInput): Promise<BackgroundDispatch> {
  const resolved = resolveRuntimeConfig(input.runtime);
  const allowWriteOperations = input.allowWriteOperations ?? input.runtime?.allowWriteOperations === true;
  let executor = input.taskExecutor;
  /** 长任务等待端口（契约 v4）：执行面客户端声明 wait 才接；缺省不接 = accepted fail-closed。 */
  let longTasks: LongTaskWaitPort | undefined;
  if (executor === undefined) {
    // 基面 = 执行层全集（读 + 部署总闸允许时的写），不做角色求交；求交在下面按主体收口。
    const baseEmptyError = input.emptyOperationsError ?? ((message: string) => new Error(message));
    const face = input.face ?? (input.createExecutionFace !== undefined
      ? await input.createExecutionFace(input.profile, input.env)
      : await defaultExecutionFace({
        profile: input.profile,
        env: input.env,
        stateDir: input.stateDir,
        emptyOperationsMessage: input.emptyOperationsMessage,
        emptyOperationsError: baseEmptyError,
        allowWriteOperations,
      }));
    const workerDriver = input.workerDriver ?? (input.createDrivers !== undefined
      ? (await input.createDrivers(input.env)).workerDriver
      : createPiTurnDriver({
        env: input.env,
        ...contextWindowFrom(input.env),
        ...compactionSettingsFrom(input.env),
        // 模型用量观测（owner 2026-11-21 最小方案）：兜底 Worker 也落 usage.jsonl，与前台同一
        // 文件（给了 dbPath 时）；进程级 runner 跨主体，任务 principal 在任务执行时才定——
        // 驱动层拿不到 principal/session，按纪律省略（不编）。
        onModelUsage: createModelUsageSink({
          filePath: input.dbPath !== undefined
            ? usageFilePathOf(input.dbPath)
            : path.join(input.stateDir, USAGE_FILENAME),
          agent: 'worker',
        }),
      }));
    // 长任务等待走同一个执行面客户端（CLI 适配器的长轮询）；未实现 wait 的客户端不接端口。
    longTasks = longTaskPortOf(face.client);
    // CAP-01 S2 后台文件面：与 inline 会话桥同一装配参数、同一 store，实例按任务懒建
    // （不建进程级单例：scope 随任务身份，platformRoot/inner 是本次执行面的可信值）。
    const bridgeAssembly = input.taskExecutionBridge;
    const backgroundTaskBridge = bridgeAssembly === undefined
      ? undefined
      : ({ principalId, sessionId, taskId }: { principalId: string; sessionId: string; taskId: string }) =>
        createTaskExecutionBridge({
          platformRoot: input.profile.root,
          fileStore: bridgeAssembly.store,
          scope: { principalId, sessionId },
          inner: face.client,
          ...(bridgeAssembly.dirParams === undefined ? {} : { dirParams: bridgeAssembly.dirParams }),
          ...(bridgeAssembly.fileParams === undefined ? {} : { fileParams: bridgeAssembly.fileParams }),
          ...(bridgeAssembly.limits === undefined ? {} : {
            maxOutputFileBytes: bridgeAssembly.limits.maxOutputFileBytes,
            maxOutputCount: bridgeAssembly.limits.maxOutputCount,
          }),
          ...(bridgeAssembly.onSkip === undefined ? {} : { onSkip: bridgeAssembly.onSkip }),
        })(taskId);
    const buildExecutor = (narrowed: ExecutionFace): Promise<TaskExecutor> => createTaskExecutor({
      client: narrowed.client,
      allowedOperations: narrowed.allowedOperations,
      // U3：只读集合是执行面显式派生的 `access=read` 集合，不是允许集合的影子
      // （角色求交只收窄 allowedOperations，不改 readOnly 身份）。
      readOnlyOperations: face.readOnlyOperations,
      workerDriver,
      ...(input.workerSkills === undefined ? {} : { workerSkills: input.workerSkills }),
      registry: input.registry,
      workerTurnMs: resolved.workerTurnMs,
      // 大响应文件化阈值：策略解析值（单一配置源），后台 Worker 与 inline 同源。
      oversizeDataBytes: resolved.oversizeDataBytes,
      // 可信工作目录：装配层持有的 profile.root（绝不取模型输出/用户消息）。
      workerWorkspaceRoot: input.profile.root,
      // 片 1：run_js 执行器端口（与前台同一构造；缺省不注入 = Worker 工具面零变化）。
      ...(input.runJsExecutor === undefined ? {} : { runJsExecutor: input.runJsExecutor }),
      ...(backgroundTaskBridge === undefined ? {} : { backgroundTaskBridge }),
      ...(input.onFileRefUnavailable === undefined ? {} : { onFileRefUnavailable: input.onFileRefUnavailable }),
      ...(input.onExecutionResultFileized === undefined ? {} : { onExecutionResultFileized: input.onExecutionResultFileized }),
      ...(input.onExecutionResultOversizeUnhandled === undefined
        ? {}
        : { onExecutionResultOversizeUnhandled: input.onExecutionResultOversizeUnhandled }),
      // 长任务异步（契约 v4）事件：accepted / 协议违约 / 续跑回程登记，只进日志。
      ...(input.onExecutionEvent === undefined ? {} : { onExecutionEvent: input.onExecutionEvent }),
    });
    const emptyOperationsError = input.emptyOperationsError ?? ((message: string) => new Error(message));
    const executorForPermissions = (permissions: readonly Permission[]): Promise<TaskExecutor> =>
      buildExecutor(narrowFaceByPermissions(
        face,
        permissions,
        allowWriteOperations,
        emptyOperationsError,
        input.emptyOperationsMessage,
      ));
    if (input.permissionsForPrincipal === undefined) {
      // 单主体装配（ask/eval/会话局部 runner）：直接用本装配的权限档位。
      executor = await executorForPermissions(input.allowedPermissions ?? ['read']);
    } else {
      // 进程级共享 runner 跨主体：按**权限集合本身**缓存执行器（键不能只分 ro/rw——
      // 自定义角色可以只有 write，或 read+write 之外的组合；用布尔档位会让后来的
      // 主体复用上一个主体的允许集）。任务执行时按主体求交：viewer 的后台写不会
      // 借用 operator 的允许集。
      const byPermissions = new Map<string, Promise<TaskExecutor>>();
      const tieredExecutorFor = (principalId: string): Promise<TaskExecutor> => {
        const permissions = input.permissionsForPrincipal!(principalId);
        const key = permissionsKey(permissions);
        let pending = byPermissions.get(key);
        if (pending === undefined) {
          pending = executorForPermissions(permissions);
          byPermissions.set(key, pending);
        }
        return pending;
      };
      executor = {
        async execute(task, context) {
          return await (await tieredExecutorFor(task.principalId)).execute(task, context);
        },
      };
    }
  }
  // B 切片：投递回调接缝——包装实际使用的执行器（注入的或默认构建的同一道包装）。
  // 回调在 runner 收尾前同步触发；快活（结果已同回合交给模型）的抑制由装配调用方处置。
  // S1 事实模型 + 2026-11-23 去 outcome：路由只认事实——**有 worker 汇报原文**走完成回调
  // （把汇报交给唤醒面喂 Main），**没有汇报 / 结果未知**走失败回调。没有「成功/失败」判定，
  // 做没做成由唤醒面的 Main 读账本 executions + 死亡事实自己判断。
  if (input.onTaskCompleted !== undefined || input.onTaskFailed !== undefined) {
    const inner = executor;
    const onTaskCompleted = input.onTaskCompleted;
    const onTaskFailed = input.onTaskFailed;
    executor = {
      async execute(task, context) {
        let outcome: TaskExecutionOutcome;
        try {
          outcome = await inner.execute(task, context);
        } catch (error) {
          // 2026-11-19 唤醒切片：回合**抛错**（Worker 驱动/基础设施故障）也触发失败回调
          // ——此前不触发失败回调，用户只能等下次开口才从 B 通道侧面知道。按同一条出口如实
          // 上报（种类 = 无汇报收尾），然后原样抛出：任务事实仍由 runner 收尾决定，本层不改判。
          onTaskFailed?.({
            taskId: task.taskId,
            principalId: task.principalId,
            sessionId: task.sessionId,
            request: task.request,
            status: 'no_report',
          });
          throw error;
        }
        if (outcome.kind === 'ended') {
          // 路由 = 事实：有汇报原文走完成面（汇报逐字交给唤醒面），否则走失败面（无汇报）。
          // 汇报是不是「在解释失败」不在宿主判——两个面都把账本事实喂给 Main，由 Main 看；
          // 模型说不出话时的兜底话术由投递面按**原始执行事实**（errorCode/failureReason）选，
          // 不把被拒/失败的说明说成「办好了」。
          if ((outcome.report ?? '').trim() !== '') {
            onTaskCompleted?.({
              taskId: task.taskId,
              principalId: task.principalId,
              sessionId: task.sessionId,
              request: task.request,
              resultText: outcome.report!,
              ...(outcome.files === undefined ? {} : { files: outcome.files }),
              ...(outcome.zeroExecReason === undefined ? {} : { reasonCode: outcome.zeroExecReason }),
              ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
              ...(outcome.failureReason === undefined ? {} : { reason: outcome.failureReason }),
              ...(outcome.partial === undefined ? {} : { partial: outcome.partial }),
            });
          } else {
            // 无汇报收尾：零执行被宿主拒绝时带 not_permitted 结构化码，末次原始失败执行事实
            // 带错误码与失败原文（只用于兜底归类与事实文案，不进用户文本）。
            onTaskFailed?.({
              taskId: task.taskId,
              principalId: task.principalId,
              sessionId: task.sessionId,
              request: task.request,
              status: 'no_report',
              ...(outcome.zeroExecReason !== undefined ? { reasonCode: outcome.zeroExecReason } : {}),
              ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
              ...(outcome.failureReason === undefined ? {} : { reason: outcome.failureReason }),
              ...(outcome.partial === undefined ? {} : { partial: outcome.partial }),
            });
          }
        } else if (outcome.kind === 'result_unknown') {
          // 2026-11-19 失败投递收口（S1 改形）：结果未知触发失败回调（不是「有结果汇报」）。
          onTaskFailed?.({
            taskId: task.taskId,
            principalId: task.principalId,
            sessionId: task.sessionId,
            request: task.request,
            status: 'result_unknown',
          });
        }
        return outcome;
      },
    };
  }
  const runner = createTaskRunner({
    registry: input.registry,
    policy: input.policy,
    executor,
    leaseMs: input.runnerOptions?.leaseMs ?? resolved.workerTurnMs + LEASE_MARGIN_MS,
    // 等待用户到期消费者由装配方按配置启用（配置缺省 24h；runner 直用缺省关闭）。
    waitUserTimeoutMs: resolved.waitUserTimeoutMs,
    // 预期契约（2026-11-18）：10 分钟「比预计久了」提醒阈值取自同一配置源（30 分钟「卡住」
    // 档已随 2026-11-19 唤醒切片删除）；投递端口由装配方接（缺省不接 = 不提醒）。
    longRunningNoticeMs: resolved.longRunningNoticeMs,
    ...(input.longRunningNotice === undefined ? {} : { longRunningNotice: input.longRunningNotice }),
    ...(input.waitingUserNotice === undefined ? {} : { waitingUserNotice: input.waitingUserNotice }),
    // 长任务等待「与执行层断了联系（无回执）」档的用户文案（2026-11-19）：装配层从**单一
    // 话术来源**取（user-facing-failure 的 unknown_result 档），runner 不自己写文案。
    contactLostNoticeText: failureMessageFor('unknown_result').text,
    // 长任务异步（契约 v4）：等待端口由执行面客户端提供；缺省不接 = accepted fail-closed。
    ...(longTasks === undefined ? {} : { longTasks }),
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.runnerOptions?.owner === undefined ? {} : { owner: input.runnerOptions.owner }),
    ...(input.runnerOptions?.now === undefined ? {} : { now: input.runnerOptions.now }),
  });
  return { runner };
}

export interface NotificationHookOptions {
  /** true = 每条事实落库后异步触发一次投递（server 进程：终态通知即刻推送）。 */
  deliverOnRecord?: boolean;
  /** R5 B 通道：单次注入上限（缺省 5）；超出汇总成一条计数陈述。 */
  factInjectionLimit?: number;
}

/** R5 B 通道注入器：用户下一次回合开始前取走本 (principal, session) 的待注入机械事实。
 *  取走带回退口（InjectionReceipt.requeue）：本回合没产出用户可见内容时把事实原样放回，
 *  下一次回合再注入（「取走」不等于「已说」，见 execution-runtime 的注入核销）。 */
export interface NotificationAttachment {
  taskFactProvider(principalId: string, sessionId: string): InjectionReceipt | undefined;
}

/**
 * registry 事实 → 通知 outbox（P4 §4 冻结口径的唯一接线点）：
 *   · `onTaskFact(fact)` 单回调；有通知意图才 record（cancelling/unexecuted 等过渡态不写）；
 *   · stateVersion 缺省 = fact.at（同一事实重复触发稳定去重）；payload 仅底账白名单字段；
 *   · 投递失败不影响任务事实（outbox 自身语义）；
 *   · R5 B 通道：同一回调把终态/待补事实按 scope 缓冲为待注入文本（渲染器纯函数产出，
 *     幂等 = 事实键去重（有界 FIFO），有界 = 单次注入条数上限），由
 *     `taskFactProvider` 在下一次回合开始时取走（普通 user-role 注入，见 execution-runtime）。
 */
/**
 * B 通道注入 kinds（非终态唤醒面之外的机械事实）：
 *   · `completed` 不在其中（2026-11-19 复核 F3）：完成已由**唤醒路径**负责说——唤醒回合
 *     由模型把话带给用户；唤醒降级（unavailable/failed）与非 live 不唤醒时，完成**事实**
 *     经 server 的 systemNotes 待注入队列在下一次用户回合补说。若这里再注入一条
 *     `[任务事实] 办完了：…`，同一回合会出现两条同一件事的陈述（旧宿主完成模板残留）。
 *   · `failed` / `cancelled` 同理移出（2026-11-19 唤醒切片）：失败（含回合抛错）由失败唤醒
 *     出口说、「用户说停」由取消唤醒出口说；唤醒降级/非 live 时两条**事实**同样进
 *     systemNotes 待注入队列，宿主兜底屏也在同一出口。这里再注入就是同一件事说两遍。
 *   · 超时/资源拒绝/等补充**保留**：这几类还没改成唤醒，主动推送与 B 通道照旧。
 */
const B_CHANNEL_KINDS = new Set<NotificationKind>(['timed_out', 'resource_limited', 'waiting_user']);
/** 产生通知事件的机械事实（其余事实——汇报存档/这一轮停下——不落通知：完成/失败由唤醒面说）。 */
const NOTIFIED_EVENTS = new Set<string>(NOTIFICATION_KINDS);
const INJECTED_KEYS_LIMIT = 1024;

export function attachNotificationOutbox(
  registry: TaskRegistry,
  outbox: NotificationOutbox,
  options: NotificationHookOptions = {},
): NotificationAttachment {
  const injectionLimit = options.factInjectionLimit ?? 5;
  const pendingFacts: Array<{ scopeKey: string; line: string }> = [];
  const injectedKeys = new Set<string>();
  registry.onTaskFact((fact) => {
    // 事实事件与通知意图同名（accepted/started/…）；只有这些「发生了什么」落 outbox。
    // 汇报存档 / 这一轮停下不是通知意图：完成与失败由投递/唤醒面读原始事实说。
    if (!NOTIFIED_EVENTS.has(fact.event)) return;
    const kind = fact.event as NotificationKind;
    // R5 补字段：waiting_user 时从底账读回 pendingQuestion（事实钩子无 scope，底账自身即
    // 事实来源；读不到不编造）。写确认时再取 confirmation.summary——用户要看到「将写入什么」
    // 才能决定；**handle 永不进 payload**（宿主持有，用户不需要也不该看到）。
    const record = (registry as unknown as {
      get(taskId: string): {
        principalId: string;
        sessionId: string;
        pendingQuestion?: { missing?: readonly string[]; confirmation?: { summary?: string } };
      };
    }).get(fact.taskId);
    const missing = kind === 'waiting_user' ? record.pendingQuestion?.missing : undefined;
    const summary = kind === 'waiting_user' ? record.pendingQuestion?.confirmation?.summary : undefined;
    // 机械原因（事实）：资源拒绝/超时/用户确认停止按事件带；不写任务级结论。
    const reason: NotificationReason | undefined = fact.event === 'resource_limited'
      ? 'resource_limited'
      : fact.event === 'timed_out'
        ? 'timeout'
        : fact.event === 'cancelled'
          ? 'cancelled_by_user'
          : undefined;
    outbox.record({
      taskId: fact.taskId,
      kind,
      at: fact.at,
      stateVersion: fact.stateVersion ?? fact.at,
      taskNo: fact.taskNo,
      name: fact.name,
      ...(reason === undefined ? {} : { reason }),
      ...(missing === undefined ? {} : { missing }),
      ...(summary === undefined ? {} : { summary }),
    });
    if (B_CHANNEL_KINDS.has(kind)) {
      const key = `${fact.taskId}:${kind}:${fact.stateVersion ?? fact.at}`;
      if (!injectedKeys.has(key)) {
        injectedKeys.add(key);
        if (injectedKeys.size > INJECTED_KEYS_LIMIT) {
          injectedKeys.delete(injectedKeys.keys().next().value as string);
        }
        pendingFacts.push({
          scopeKey: `${record.principalId}\u0000${record.sessionId}`,
          line: renderNotification({
            kind,
            payload: {
              at: fact.at,
              taskNo: fact.taskNo,
              name: fact.name,
              ...(reason === undefined ? {} : { reason }),
              ...(missing === undefined ? {} : { missing }),
              ...(summary === undefined ? {} : { summary }),
            },
          }),
        });
      }
    }
    if (options.deliverOnRecord === true) {
      void outbox.deliverPending().catch(() => {});
    }
  });
  return {
    taskFactProvider(principalId, sessionId) {
      const scopeKey = `${principalId}\u0000${sessionId}`;
      const mine: string[] = [];
      for (let index = pendingFacts.length - 1; index >= 0; index -= 1) {
        if (pendingFacts[index]!.scopeKey === scopeKey) {
          mine.unshift(pendingFacts[index]!.line);
          pendingFacts.splice(index, 1);
        }
      }
      if (mine.length === 0) return undefined;
      // 回退口：本回合没产出用户可见内容时原样放回（同一 scope、原顺序、原条目）。
      const requeue = (): void => {
        for (const line of mine) pendingFacts.push({ scopeKey, line });
      };
      if (mine.length > injectionLimit) {
        return {
          text: `[任务事实] 自上次对话以来有 ${mine.length} 项任务状态变化（超出单次注入上限 ${injectionLimit} 条），请用任务查询工具查看。`,
          requeue,
        };
      }
      return { text: `[任务事实] ${mine.join('\n')}`, requeue };
    },
  };
}

/**
 * 共享装配核心（生产面唯一装配链）：
 *   stateDir/审计路径 → 隔离断言（可选）→ 执行面 → 底账 → 技能/角色 → 驱动
 *   →（P5 policy / P6 background runner / P4 outbox）→ createSession。
 * 顺序与抽取前逐入口一致（门内不建库、不落盘：执行面失败时底账尚未创建）。
 */
export async function assembleSessionCore(input: SessionAssemblyInput): Promise<AssembledSession> {
  const taskDispatch: 'sync' | 'async' = input.taskDispatch ?? 'sync';
  const resolved = resolveRuntimeConfig(input.runtime);
  const policy = input.policy ?? createResourcePolicy(input.runtime);
  // 写面开关：显式投影优先，其次 runtime 段；缺省 false = 只读（零行为变化）。
  const allowWriteOperations = input.allowWriteOperations ?? input.runtime?.allowWriteOperations === true;
  // 角色白名单（宿主求交的中间项）：未提供 = 只读（最小权限）。实际允许集合还要与
  // 执行层声明能力和部署总闸求交（resolveExecutionFace 的唯一收口）。
  const allowedPermissions: readonly Permission[] = input.allowedPermissions ?? ['read'];
  const writePermitted = allowWriteOperations && allowedPermissions.includes('write');

  const auditPath = path.join(input.stateDir, 'audit.jsonl');
  if (input.setAuditPath === true) {
    mkdirSync(input.stateDir, { recursive: true });
    input.env['EXECUTION_AUDIT_PATH'] = auditPath;
  }
  input.assertIsolation?.();

  const face = await resolveExecutionFace({
    profile: input.profile,
    env: input.env,
    stateDir: input.stateDir,
    emptyOperationsMessage: input.emptyOperationsMessage,
    allowWriteOperations,
    allowedPermissions,
    ...(input.emptyOperationsError === undefined ? {} : { emptyOperationsError: input.emptyOperationsError }),
    ...(input.createExecutionFace === undefined ? {} : { createExecutionFace: input.createExecutionFace }),
  });

  // CAP-01 S2 ②③④：执行层文件桥在装配核心构造（内层客户端只有这里拿得到）：
  // platformRoot = profile.root（装配层持有的可信路径），scope = 本会话身份，inner = 本会话
  // 执行面。翻译（目录参数替换 + 任务文件物化）、回程登记、任务 out/ 兜底都经此桥——
  // runtime 出口只决定何时调用。未注入 = 零变化缺省（runtime 端口缺省不接）。
  const taskBridge = input.taskExecutionBridge === undefined
    ? undefined
    : createTaskExecutionBridge({
      platformRoot: input.profile.root,
      fileStore: input.taskExecutionBridge.store,
      scope: { principalId: input.principalId, sessionId: input.sessionId },
      inner: face.client,
      ...(input.taskExecutionBridge.dirParams === undefined ? {} : { dirParams: input.taskExecutionBridge.dirParams }),
      ...(input.taskExecutionBridge.fileParams === undefined ? {} : { fileParams: input.taskExecutionBridge.fileParams }),
      ...(input.taskExecutionBridge.limits === undefined ? {} : { limits: input.taskExecutionBridge.limits }),
      ...(input.taskExecutionBridge.onSkip === undefined ? {} : { onSkip: input.taskExecutionBridge.onSkip }),
    });

  // 底账：注入的归调用方（不在此关）；自建的由本核心关闭（SQLite 需要 close 收尾）。
  const ownedRegistry: SqliteTaskRegistry | undefined = input.taskRegistry === undefined
    ? createSqliteTaskRegistry(input.dbPath)
    : undefined;
  const taskRegistry: TaskRegistry = input.taskRegistry ?? ownedRegistry!;
  let notifications: NotificationOutbox | undefined;
  try {
    const workerSkills = input.workerSkills ?? await loadWorkerSkills(input.profile.root, input.profile.skillRoots);
    let mainSystemPrompt = input.mainSystemPrompt;
    let mainSkillRegistry = input.mainSkillRegistry;
    if (mainSystemPrompt === undefined) {
      const profileMd = await loadAgentProfile();
      // Main 技能面（唯一机制）：固定目录 → catalog（name+description）拼在角色文本之后、
      // 协议之前；目录为空/缺失时 promptBlock 为空串 → 提示逐字节不变；catalog 非空才交出
      // read_skill 登记表。目录来自装配参数或 `<repo>/.agents/skills`，不读配置键。
      const delivery = await loadMainSkillDelivery(input.mainSkillsDir ?? defaultMainSkillsDir());
      mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, input.profile.executorLabel)}${delivery.promptBlock}\n\n${mainProtocolNoteFor(writePermitted)}`;
      mainSkillRegistry = delivery.registry;
    }

    // 能力目录（A4/A5）：单一来源 = 执行层 operation 声明的 capability/access。按 capability
    // 分组派生，给 Main 一句极短摘要常驻 + 只读 capabilities() 工具（见 createSession）。
    // 未声明任何 capability → 目录为空：摘要/行为句一律不追加（提示与今天逐字节一致），
    // 并记一次性结构化事件 capability_catalog_undeclared（装配时记，不按回合刷）。
    let capabilityCatalog: readonly CapabilityEntry[] = [];
    const manifest = await face.client.capabilities();
    capabilityCatalog = deriveCapabilityCatalog(manifest.operations);
    if (capabilityCatalog.length === 0) {
      input.onExecutionEvent?.({ event: 'capability_catalog_undeclared', principalId: input.principalId, sessionId: input.sessionId });
    } else {
      mainSystemPrompt += `\n\n${renderCapabilitySummary(capabilityCatalog)}\n\n${OUTCOME_BEHAVIOR_NOTE}`;
    }
    // 模型用量观测（owner 2026-11-21 最小方案）：本装配能拿到真实 principal/session 与 dbPath，
    // 缺省驱动都注入同一个 usage.jsonl sink（`<dbPath 同目录>/usage.jsonl`）。写失败只记
    // 结构化事件、不影响回合（见 model-usage.ts）。
    const usageSink = (agent: 'main' | 'worker') => createModelUsageSink({
      filePath: usageFilePathOf(input.dbPath),
      agent,
      principalId: input.principalId,
      sessionId: input.sessionId,
    });
    const drivers = input.createDrivers !== undefined
      ? await input.createDrivers(input.env, input.mainSession)
      : {
        mainDriver: createPiTurnDriver({
          env: input.env,
          ...contextWindowFrom(input.env),
          ...compactionSettingsFrom(input.env),
          // Main 思考档：llm.mainThinkingLevel 优先、未设回落 llm.thinkingLevel（见 helper 注释）。
          ...mainThinkingLevelFrom(input.env),
          reuseConversation: true,
          ...mainSessionOptions(input.mainSession),
          onModelUsage: usageSink('main'),
        }),
        // Worker 是一次性回合（每任务独立会话），不落业务会话文件；思考档 = 驱动缺省解析
        // （llm.thinkingLevel，owner 决定 medium）。
        workerDriver: createPiTurnDriver({
          env: input.env,
          ...contextWindowFrom(input.env),
          ...compactionSettingsFrom(input.env),
          onModelUsage: usageSink('worker'),
        }),
      };

    // P6：async = 受理/后台路径；runner 进程级共享（server 注入），缺省按本会话执行面构建。
    let runner = input.taskRunner;
    if (taskDispatch === 'async' && runner === undefined) {
      runner = (await createBackgroundDispatch({
        env: input.env,
        profile: input.profile,
        stateDir: input.stateDir,
        registry: taskRegistry,
        policy,
        workerSkills,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        allowWriteOperations,
        allowedPermissions,
        emptyOperationsMessage: input.emptyOperationsMessage,
        ...(input.emptyOperationsError === undefined ? {} : { emptyOperationsError: input.emptyOperationsError }),
        ...(input.createDrivers === undefined ? {} : { createDrivers: input.createDrivers }),
        ...(input.createExecutionFace === undefined ? {} : { createExecutionFace: input.createExecutionFace }),
        ...(input.taskExecutor === undefined ? {} : { taskExecutor: input.taskExecutor }),
        ...(input.runnerOptions === undefined ? {} : { runnerOptions: input.runnerOptions }),
        face,
        workerDriver: drivers.workerDriver,
        // 片 1：后台 Worker 的 run_js 与前台同一执行器端口（缺省不注入 = 工具面零变化）。
        ...(input.runJsExecutor === undefined ? {} : { runJsExecutor: input.runJsExecutor }),
        // 后台文件面与 inline 同源注入：同一 bridge 参数与 fileStore 实例，按任务懒建。
        ...(input.taskExecutionBridge === undefined ? {} : { taskExecutionBridge: input.taskExecutionBridge }),
        ...(input.onFileRefUnavailable === undefined ? {} : { onFileRefUnavailable: input.onFileRefUnavailable }),
        ...(input.onExecutionResultFileized === undefined ? {} : { onExecutionResultFileized: input.onExecutionResultFileized }),
        ...(input.onExecutionResultOversizeUnhandled === undefined
          ? {}
          : { onExecutionResultOversizeUnhandled: input.onExecutionResultOversizeUnhandled }),
        // 长任务异步（契约 v4）事件与前台同一出口。
        ...(input.onExecutionEvent === undefined ? {} : { onExecutionEvent: input.onExecutionEvent }),
      })).runner;
    }
    // P4：通知链仅 async 且提供 sink 时启用（sync 默认零新增路径；投递由调用方触发）。
    if (taskDispatch === 'async' && input.notificationSink !== undefined) {
      notifications = createNotificationOutbox({
        dbPath: input.dbPath,
        sink: input.notificationSink,
        ...(input.notificationMaxAttempts === undefined ? {} : { maxAttempts: input.notificationMaxAttempts }),
      });
      attachNotificationOutbox(taskRegistry, notifications);
    }

    const session = await createSession({
      principalId: input.principalId,
      sessionId: input.sessionId,
      client: face.client,
      allowedOperations: face.allowedOperations,
      // U3：只读集合是执行面显式派生的 `access=read` 集合，不是允许集合的影子。
      readOnlyOperations: face.readOnlyOperations,
      mainDriver: drivers.mainDriver,
      workerDriver: drivers.workerDriver,
      mainSystemPrompt,
      workerSkills,
      capabilityCatalog,
      taskRegistry,
      policy,
      taskDispatch,
      ...(runner === undefined ? {} : { taskRunner: runner }),
      ...(mainSkillRegistry === undefined ? {} : { mainSkillRegistry }),
      ...(input.taskFactProvider === undefined ? {} : { taskFactProvider: input.taskFactProvider }),
      ...(input.attachmentFactProvider === undefined ? {} : { attachmentFactProvider: input.attachmentFactProvider }),
      ...(input.systemNoteProvider === undefined ? {} : { systemNoteProvider: input.systemNoteProvider }),
      ...(input.runJsExecutor === undefined ? {} : { runJsExecutor: input.runJsExecutor }),
      ...(input.recalcXlsxExecutor === undefined ? {} : { recalcXlsxExecutor: input.recalcXlsxExecutor }),
      ...(input.onRecalcCost === undefined ? {} : { onRecalcCost: input.onRecalcCost }),
      ...(input.onRunJsMemoryExit === undefined ? {} : { onRunJsMemoryExit: input.onRunJsMemoryExit }),
      ...(input.onRunJsLayoutUnsafe === undefined ? {} : { onRunJsLayoutUnsafe: input.onRunJsLayoutUnsafe }),
      ...(input.onFileRefUnavailable === undefined ? {} : { onFileRefUnavailable: input.onFileRefUnavailable }),
      ...(input.onTaskOutputSweepSkipped === undefined ? {} : { onTaskOutputSweepSkipped: input.onTaskOutputSweepSkipped }),
      ...(input.onExecutionResultFileized === undefined ? {} : { onExecutionResultFileized: input.onExecutionResultFileized }),
      ...(input.onExecutionResultOversizeUnhandled === undefined
        ? {}
        : { onExecutionResultOversizeUnhandled: input.onExecutionResultOversizeUnhandled }),
      ...(input.taskInputCopier === undefined ? {} : { taskInputCopier: input.taskInputCopier }),
      ...(taskBridge === undefined ? {} : { taskExecutionBridge: taskBridge }),
      // 长任务异步（契约 v4）：inline 前台收到 accepted 也发同一条事件（只进日志）。
      ...(input.onExecutionEvent === undefined ? {} : { onExecutionEvent: input.onExecutionEvent }),
      ...(input.fileManifestProvider === undefined ? {} : { fileManifestProvider: input.fileManifestProvider }),
      mainTurnMs: resolved.mainTurnMs,
      workerTurnMs: resolved.workerTurnMs,
      // B 切片（工单回执收敛）：task_run 短等待窗口（单一配置源 = runtime 解析值）。
      taskRunWaitMs: resolved.taskRunWaitMs,
      // 可信工作目录：装配层持有的 profile.root（绝不取模型输出/用户消息）。
      workerWorkspaceRoot: input.profile.root,
    });
    return {
      session,
      auditPath,
      taskRegistry,
      policy,
      ...(runner === undefined ? {} : { runner }),
      ...(notifications === undefined ? {} : { notifications }),
      close: () => {
        notifications?.close();
        ownedRegistry?.close();
      },
    };
  } catch (error) {
    notifications?.close();
    ownedRegistry?.close();
    throw error;
  }
}

export async function assembleAskRuntime(input: AskRuntimeInput): Promise<AskRuntime> {
  // 配置：显式 --config / AGENT_CONFIG_PATH 优先；缺省物化仓内 dummy 面配置（绝对 root 副本）。
  const explicit = explicitConfigFrom([...input.argv], input.env);
  const configPath = explicit ?? materializeEvalConfig(FIXTURE_CONFIG, path.join(input.runtimeDir, 'agent-config.yaml'));
  const config = loadConfig({ yamlPath: configPath, env: input.env });
  const env = effectiveDeploymentEnv(config, input.env);
  if ((env['LLM_API_KEY'] ?? '').trim() === '') {
    throw new AssemblyRefusedError(`未检测到 LLM_API_KEY——${input.purpose} 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。`);
  }

  const profileIds = Object.keys(config.contextProfiles);
  if (profileIds.length !== 1) {
    throw new AssemblyRefusedError(`${input.purpose} 需要单一 contextProfile（当前 ${profileIds.length} 个）——最小切片不做多 profile 选择。`);
  }
  const profile = config.contextProfiles[profileIds[0]!]!;
  if (!profile.gateway) {
    throw new AssemblyRefusedError('profile 缺少 gateway——最小切片需要执行层挂载声明。');
  }
  const principalId = input.principalId
    ?? Object.entries(config.principals).find(([, principal]) => principal.enabled)?.[0];
  if (principalId === undefined) {
    throw new AssemblyRefusedError('配置里没有 enabled principal——最小切片需要可信身份来源（fail-closed，不回落写死值）。');
  }
  const stateDir = path.join(input.runtimeDir, 'state');
  const dbPath = input.dbPath
    ?? (config.store?.dbPath !== undefined ? path.resolve(config.store.dbPath) : DEFAULT_DB_PATH);
  // 宿主求交：本主体的角色权限（未写 role = viewer = 只读）。实际允许集合还要与
  // 执行层声明能力、runtime.allowWriteOperations 总闸求交（assembleSessionCore 内收口）。
  const role = effectiveRoleOf(config, principalId);
  const allowedPermissions = permissionsOfRole(config, role);
  const assembled = await assembleSessionCore({
    env,
    profile,
    principalId,
    sessionId: input.sessionId,
    dbPath,
    stateDir,
    setAuditPath: true,
    // fail-closed 隔离门：root 必须在仓内夹具目录、网关可达、审计通道可写读。
    assertIsolation: () => {
      assertEvalIsolation(assessEvalIsolation({
        env,
        platformRoot: profile.root,
        gateway: profile.gateway,
      }), `${input.purpose}（仓内 dummy 面）`);
    },
    emptyOperationsMessage: '执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。',
    emptyOperationsError: (message) => new AssemblyRefusedError(message),
    // 写面开关：语义部署键 runtime.allowWriteOperations（缺省 false = 只读，ask 零行为变化）。
    allowWriteOperations: config.runtime?.allowWriteOperations === true,
    // 角色白名单（宿主求交中间项）：未写 role = viewer = 只读。
    allowedPermissions,
    // 进程内单轮入口：没有渠道推送面承接后台完成投递，装配恒为同步等结果（不是配置键）。
    taskDispatch: 'sync',
    ...(input.mainSkillsDir === undefined ? {} : { mainSkillsDir: input.mainSkillsDir }),
  });
  return {
    session: assembled.session,
    principalId,
    sessionId: input.sessionId,
    dbPath,
    auditPath: assembled.auditPath,
    stateDir,
    close: assembled.close,
  };
}

/** CLI 入口装配仪式（单轮 ask 与交互式 ask 共用）：清空并重建 runtimeDir → 同一五门装配。 */
export interface AskRuntimeCliInput {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  sessionId: string;
  principalId?: string;
}

export async function assembleAskRuntimeCli(input: AskRuntimeCliInput): Promise<AskRuntime> {
  rmSync(input.runtimeDir, { recursive: true, force: true });
  mkdirSync(input.runtimeDir, { recursive: true });
  return await assembleAskRuntime({
    purpose: 'ask',
    argv: input.argv,
    env: input.env,
    runtimeDir: input.runtimeDir,
    sessionId: input.sessionId,
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
  });
}
