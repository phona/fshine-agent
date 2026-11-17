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
import type { ContextProfileConfig, RuntimeConfig } from '@fshine/contracts';
import type { ExecutionClient } from '@fshine/contracts/execution-contract';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createPiTurnDriver, parseContextWindow, type PiTurnDriverOptions } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/dummy-cli-client';
import type { TurnDriver } from '../packages/agent/src/driver-contract';
import {
  MAIN_PROTOCOL_NOTE,
  createSession,
  createTaskExecutor,
  type Session,
  type TranscriptStore,
  type TurnFileRef,
  type WorkerSkill,
  type RunJsMemoryExitEvent,
  type RunJsLayoutUnsafeReport,
} from '../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  notificationKindForTransition,
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
import { createTaskRunner, type TaskExecutor, type TaskRunner } from '../packages/agent/src/task-runner';
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
 */
export type DriverFactory = (env: NodeJS.ProcessEnv) =>
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
 * 安全值来源见 `scripts/eval/pi-native/safe-config.ts` 与
 * `docs/product/exp-pi-native-config-headroom.md`（余量不等式 + 摘要输出预算推导）。
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
  /** P6：派发模式覆盖；缺省取 `runtime.dispatchMode ?? 'inline'`。 */
  dispatchMode?: 'inline' | 'background';
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
  /** B1：会话转录持久化端口（装配方构造具体存储注入）；缺省 undefined = 不落盘会话（现行为）。 */
  transcriptStore?: TranscriptStore;
  /** B1：转录读/写失败上报（fail-open 日志；缺省静默）。 */
  onTranscriptError?: (error: unknown) => void;
  /** CAP-01 S1：run_js 执行器端口（装配层构造注入；缺省不注入 = Main 无 run_js 工具）。 */
  runJsExecutor?: RunJsExecutor;
  /** CAP-01 ④：run_js 内存墙结构化事件上报（装配层接日志；缺省静默）。 */
  onRunJsMemoryExit?: (event: RunJsMemoryExitEvent) => void;
  /** CAP-01 symlink 收窄：run_js 运行目录布局不安全的结构化事件上报（装配层接日志；缺省静默）。 */
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
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
   */
  taskExecutionBridge?: {
    store: TaskFileBridgeStore;
    dirParams?: { input?: string; output?: string };
    /** 单文件参数（执行层吃一个文件 / 写一个文件）：宿主填物化路径，不猜。 */
    fileParams?: { input?: string; output?: string };
    limits?: { maxOutputFileBytes?: number; maxOutputCount?: number };
    onSkip?: (reason: string) => void;
  };
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

/** 缺省执行面：仓内 dummy CLI + 从执行层自述派生的只读允许集（空集合按注入话术拒绝）。 */
async function defaultExecutionFace(input: {
  profile: ContextProfileConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  emptyOperationsMessage: string;
  emptyOperationsError: (message: string) => Error;
}): Promise<ExecutionFace> {
  const client = createDummyCliClient({
    root: input.profile.root,
    gateway: input.profile.gateway!,
    stateDir: input.stateDir,
    env: input.env,
  });
  const operations = await client.listOperations();
  // 两条集合各自派生：只读集合只看 access=read；允许集合是当前读路径切片（未来写操作
  // 进入允许集合时，只读集合不会跟着变大——这正是 P1 要消除的「碰巧成立」）。
  const readOnlyOperations = readOnlyOperationNames(operations);
  const allowedOperations = [...readOnlyOperations];
  if (allowedOperations.length === 0) {
    throw input.emptyOperationsError(input.emptyOperationsMessage);
  }
  return { client, allowedOperations, readOnlyOperations };
}

/** 执行面解析（注入优先，缺省仓内 dummy；后台派发与装配核心共用同一链，不另建装配）。 */
export interface ExecutionFaceResolverInput {
  profile: ContextProfileConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  emptyOperationsMessage: string;
  emptyOperationsError?: (message: string) => Error;
  createExecutionFace?: ExecutionFaceFactory;
}

export async function resolveExecutionFace(input: ExecutionFaceResolverInput): Promise<ExecutionFace> {
  if (input.createExecutionFace !== undefined) {
    return await input.createExecutionFace(input.profile, input.env);
  }
  return await defaultExecutionFace({
    profile: input.profile,
    env: input.env,
    stateDir: input.stateDir,
    emptyOperationsMessage: input.emptyOperationsMessage,
    emptyOperationsError: input.emptyOperationsError ?? ((message) => new Error(message)),
  });
}

/** worker 回合上限之上的租约余量：覆盖最长回合 + 收尾，避免在飞回合被误判 result_unknown。 */
const LEASE_MARGIN_MS = 60_000;

/**
 * 后台派发装配（P6）：解析 runtime → 执行面/worker 驱动（可复用或自建）→ 单回合执行器
 * （可注入假件）→ TaskRunner。runner 为**进程级**对象，由入口（server）或装配核心构建后
 * 注入会话；本函数不 pump（触发点由调用方掌握：受理后/落定后/启动恢复）。
 */
export interface BackgroundDispatchInput {
  env: NodeJS.ProcessEnv;
  profile: ContextProfileConfig;
  stateDir: string;
  registry: TaskRegistry;
  policy: ResourcePolicy;
  workerSkills?: readonly WorkerSkill[];
  runtime?: RuntimeConfig;
  emptyOperationsMessage: string;
  emptyOperationsError?: (message: string) => Error;
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 测试注入：假后台执行器（缺省 = 真实 Worker 回合执行器）。 */
  taskExecutor?: TaskExecutor;
  /** 预构建执行面/worker 驱动（装配核心复用；已给 taskExecutor 时不需要）。 */
  face?: ExecutionFace;
  workerDriver?: TurnDriver;
  /** runner 覆盖（测试确定性：leaseMs/时钟/属主；缺省 leaseMs=workerTurnMs+60s）。 */
  runnerOptions?: { leaseMs?: number; owner?: string; now?: () => Date };
}

export interface BackgroundDispatch {
  runner: TaskRunner;
}

export async function createBackgroundDispatch(input: BackgroundDispatchInput): Promise<BackgroundDispatch> {
  const resolved = resolveRuntimeConfig(input.runtime);
  let executor = input.taskExecutor;
  if (executor === undefined) {
    const face = input.face ?? await resolveExecutionFace({
      profile: input.profile,
      env: input.env,
      stateDir: input.stateDir,
      emptyOperationsMessage: input.emptyOperationsMessage,
      ...(input.emptyOperationsError === undefined ? {} : { emptyOperationsError: input.emptyOperationsError }),
      ...(input.createExecutionFace === undefined ? {} : { createExecutionFace: input.createExecutionFace }),
    });
    const workerDriver = input.workerDriver ?? (input.createDrivers !== undefined
      ? (await input.createDrivers(input.env)).workerDriver
      : createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env), ...compactionSettingsFrom(input.env) }));
    executor = await createTaskExecutor({
      client: face.client,
      allowedOperations: face.allowedOperations,
      // U3：只读集合是执行面显式派生的 `access=read` 集合，不是允许集合的影子。
      readOnlyOperations: face.readOnlyOperations,
      workerDriver,
      ...(input.workerSkills === undefined ? {} : { workerSkills: input.workerSkills }),
      registry: input.registry,
      workerTurnMs: resolved.workerTurnMs,
      // 可信工作目录：装配层持有的 profile.root（绝不取模型输出/用户消息）。
      workerWorkspaceRoot: input.profile.root,
    });
  }
  const runner = createTaskRunner({
    registry: input.registry,
    policy: input.policy,
    executor,
    leaseMs: input.runnerOptions?.leaseMs ?? resolved.workerTurnMs + LEASE_MARGIN_MS,
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

/** R5 B 通道注入器：用户下一次回合开始前取走本 (principal, session) 的待注入机械事实。 */
export interface NotificationAttachment {
  taskFactProvider(principalId: string, sessionId: string): string | undefined;
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
const B_CHANNEL_KINDS = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'resource_limited', 'waiting_user']);
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
    const kind = notificationKindForTransition(fact.from, fact.to, fact.reason as NotificationReason | undefined);
    if (kind === undefined) return;
    // R5 补字段：waiting_user 时从底账读回 pendingQuestion.missing（事实钩子无 scope，
    // 底账自身即事实来源；读不到不编造）。
    const record = (registry as unknown as {
      get(taskId: string): { principalId: string; sessionId: string; pendingQuestion?: { missing?: readonly string[] } };
    }).get(fact.taskId);
    const missing = kind === 'waiting_user' ? record.pendingQuestion?.missing : undefined;
    outbox.record({
      taskId: fact.taskId,
      kind,
      at: fact.at,
      stateVersion: fact.stateVersion ?? fact.at,
      taskNo: fact.taskNo,
      name: fact.name,
      ...(fact.reason === undefined ? {} : { reason: fact.reason }),
      ...(missing === undefined ? {} : { missing }),
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
              ...(fact.reason === undefined ? {} : { reason: fact.reason }),
              ...(missing === undefined ? {} : { missing }),
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
      if (mine.length > injectionLimit) {
        return `[任务事实] 自上次对话以来有 ${mine.length} 项任务状态变化（超出单次注入上限 ${injectionLimit} 条），请用任务查询工具查看。`;
      }
      return `[任务事实] ${mine.join('\n')}`;
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
  const dispatchMode: 'inline' | 'background' = input.dispatchMode ?? input.runtime?.dispatchMode ?? 'inline';
  const resolved = resolveRuntimeConfig(input.runtime);
  const policy = input.policy ?? createResourcePolicy(input.runtime);

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
      mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, input.profile.executorLabel)}${delivery.promptBlock}\n\n${MAIN_PROTOCOL_NOTE}`;
      mainSkillRegistry = delivery.registry;
    }
    const drivers = input.createDrivers !== undefined
      ? await input.createDrivers(input.env)
      : { mainDriver: createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env), ...compactionSettingsFrom(input.env), reuseConversation: true }), workerDriver: createPiTurnDriver({ env: input.env, ...contextWindowFrom(input.env), ...compactionSettingsFrom(input.env) }) };

    // P6：background = 受理/后台路径；runner 进程级共享（server 注入），缺省按本会话执行面构建。
    let runner = input.taskRunner;
    if (dispatchMode === 'background' && runner === undefined) {
      runner = (await createBackgroundDispatch({
        env: input.env,
        profile: input.profile,
        stateDir: input.stateDir,
        registry: taskRegistry,
        policy,
        workerSkills,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        emptyOperationsMessage: input.emptyOperationsMessage,
        ...(input.emptyOperationsError === undefined ? {} : { emptyOperationsError: input.emptyOperationsError }),
        ...(input.createDrivers === undefined ? {} : { createDrivers: input.createDrivers }),
        ...(input.createExecutionFace === undefined ? {} : { createExecutionFace: input.createExecutionFace }),
        ...(input.taskExecutor === undefined ? {} : { taskExecutor: input.taskExecutor }),
        ...(input.runnerOptions === undefined ? {} : { runnerOptions: input.runnerOptions }),
        face,
        workerDriver: drivers.workerDriver,
      })).runner;
    }
    // P4：通知链仅 background 且提供 sink 时启用（inline 默认零新增路径；投递由调用方触发）。
    if (dispatchMode === 'background' && input.notificationSink !== undefined) {
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
      taskRegistry,
      policy,
      dispatchMode,
      ...(runner === undefined ? {} : { taskRunner: runner }),
      ...(mainSkillRegistry === undefined ? {} : { mainSkillRegistry }),
      ...(input.taskFactProvider === undefined ? {} : { taskFactProvider: input.taskFactProvider }),
      ...(input.transcriptStore === undefined ? {} : { transcriptStore: input.transcriptStore }),
      ...(input.onTranscriptError === undefined ? {} : { onTranscriptError: input.onTranscriptError }),
      ...(input.runJsExecutor === undefined ? {} : { runJsExecutor: input.runJsExecutor }),
      ...(input.onRunJsMemoryExit === undefined ? {} : { onRunJsMemoryExit: input.onRunJsMemoryExit }),
      ...(input.onRunJsLayoutUnsafe === undefined ? {} : { onRunJsLayoutUnsafe: input.onRunJsLayoutUnsafe }),
      ...(input.taskInputCopier === undefined ? {} : { taskInputCopier: input.taskInputCopier }),
      ...(taskBridge === undefined ? {} : { taskExecutionBridge: taskBridge }),
      ...(input.fileManifestProvider === undefined ? {} : { fileManifestProvider: input.fileManifestProvider }),
      mainTurnMs: resolved.mainTurnMs,
      workerTurnMs: resolved.workerTurnMs,
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
  // R4 登记边界：ask/redo 是进程内单轮入口，不承接后台派发（受理后进程即退出会半程丢任务）。
  // 显式拒绝而非静默忽略——需要 background 的部署走 server 渠道面。
  if ((config.runtime?.dispatchMode ?? 'inline') === 'background') {
    throw new AssemblyRefusedError(`${input.purpose} 入口不支持 runtime.dispatchMode=background——后台派发由 server 渠道面承接（本入口不静默忽略）。`);
  }

  const stateDir = path.join(input.runtimeDir, 'state');
  const dbPath = input.dbPath
    ?? (config.store?.dbPath !== undefined ? path.resolve(config.store.dbPath) : DEFAULT_DB_PATH);
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
