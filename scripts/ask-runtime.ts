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
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/dummy-cli-client';
import type { TurnDriver } from '../packages/agent/src/driver-contract';
import {
  MAIN_PROTOCOL_NOTE,
  createSession,
  createTaskExecutor,
  type Session,
  type WorkerSkill,
} from '../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  notificationKindForTransition,
  type NotificationOutbox,
  type NotificationReason,
  type NotificationSink,
} from '../packages/agent/src/notifications';
import { createResourcePolicy, resolveRuntimeConfig, type ResourcePolicy } from '../packages/agent/src/resource-policy';
import type { TaskRegistry } from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { createTaskRunner, type TaskExecutor, type TaskRunner } from '../packages/agent/src/task-runner';
import { loadWorkerSkills } from '../packages/agent/src/worker-skills';
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

/** 执行面：结构化执行客户端 + 本轮允许集合（装配核心的产出面）。 */
export interface ExecutionFace {
  client: ExecutionClient;
  allowedOperations: readonly string[];
}

/** 执行面工厂（server 测试替身注入用；缺省 = 仓内 dummy CLI + 只读允许集非空校验）。 */
export type ExecutionFaceFactory = (
  profile: ContextProfileConfig,
  env: NodeJS.ProcessEnv,
) => Promise<ExecutionFace>;

/** 回合驱动工厂（runner 记录包装器 / server 测试替身注入用；缺省 = 真实 Pi 驱动 ×2）。 */
export type DriverFactory = (env: NodeJS.ProcessEnv) => { mainDriver: TurnDriver; workerDriver: TurnDriver };

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
  /** 预装载 Worker 技能（server 启动时装载一次）；缺省现装。 */
  workerSkills?: readonly WorkerSkill[];
  /** P5：runtime 段（资源强制单一配置入口）；缺省 = 现行为缺省（单并发/无队列/无任务级预算）。 */
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
  const allowedOperations = readOnlyOperationNames(operations);
  if (allowedOperations.length === 0) {
    throw input.emptyOperationsError(input.emptyOperationsMessage);
  }
  return { client, allowedOperations };
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
      ? input.createDrivers(input.env).workerDriver
      : createPiTurnDriver({ env: input.env }));
    executor = await createTaskExecutor({
      client: face.client,
      allowedOperations: face.allowedOperations,
      workerDriver,
      ...(input.workerSkills === undefined ? {} : { workerSkills: input.workerSkills }),
      registry: input.registry,
      workerTurnMs: resolved.workerTurnMs,
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
}

/**
 * registry 事实 → 通知 outbox（P4 §4 冻结口径的唯一接线点）：
 *   · `onTaskFact(fact)` 单回调；有通知意图才 record（cancelling/unexecuted 等过渡态不写）；
 *   · stateVersion 缺省 = fact.at（同一事实重复触发稳定去重）；payload 仅底账白名单字段；
 *   · 投递失败不影响任务事实（outbox 自身语义）。
 */
export function attachNotificationOutbox(
  registry: TaskRegistry,
  outbox: NotificationOutbox,
  options: NotificationHookOptions = {},
): void {
  registry.onTaskFact((fact) => {
    const kind = notificationKindForTransition(fact.from, fact.to, fact.reason as NotificationReason | undefined);
    if (kind === undefined) return;
    outbox.record({
      taskId: fact.taskId,
      kind,
      at: fact.at,
      stateVersion: fact.stateVersion ?? fact.at,
      taskNo: fact.taskNo,
      name: fact.name,
      ...(fact.reason === undefined ? {} : { reason: fact.reason }),
    });
    if (options.deliverOnRecord === true) {
      void outbox.deliverPending().catch(() => {});
    }
  });
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

  // 底账：注入的归调用方（不在此关）；自建的由本核心关闭（SQLite 需要 close 收尾）。
  const ownedRegistry: SqliteTaskRegistry | undefined = input.taskRegistry === undefined
    ? createSqliteTaskRegistry(input.dbPath)
    : undefined;
  const taskRegistry: TaskRegistry = input.taskRegistry ?? ownedRegistry!;
  let notifications: NotificationOutbox | undefined;
  try {
    const workerSkills = input.workerSkills ?? await loadWorkerSkills(input.profile.root, input.profile.skillRoots);
    let mainSystemPrompt = input.mainSystemPrompt;
    if (mainSystemPrompt === undefined) {
      const profileMd = await loadAgentProfile();
      mainSystemPrompt = `${applyExecutorLabel(profileMd.instructions, input.profile.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`;
    }
    const drivers = input.createDrivers !== undefined
      ? input.createDrivers(input.env)
      : { mainDriver: createPiTurnDriver({ env: input.env }), workerDriver: createPiTurnDriver({ env: input.env }) };

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
      mainDriver: drivers.mainDriver,
      workerDriver: drivers.workerDriver,
      mainSystemPrompt,
      workerSkills,
      taskRegistry,
      policy,
      dispatchMode,
      ...(runner === undefined ? {} : { taskRunner: runner }),
      mainTurnMs: resolved.mainTurnMs,
      workerTurnMs: resolved.workerTurnMs,
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
