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
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextProfileConfig } from '@fshine/contracts';
import type { ExecutionClient } from '@fshine/contracts/execution-contract';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/dummy-cli-client';
import type { TurnDriver } from '../packages/agent/src/driver-contract';
import { MAIN_PROTOCOL_NOTE, createSession, type Session, type WorkerSkill } from '../packages/agent/src/execution-runtime';
import type { TaskRegistry } from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
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
}

/** 装配核心产出：会话 + 本次使用的面（调用方按需读取/关闭）。 */
export interface AssembledSession {
  session: Session;
  auditPath: string;
  /** 本次使用的底账（注入的原样返回；自建的由 close 关闭）。 */
  taskRegistry: TaskRegistry;
  /** 关闭自建底账；注入的底账归调用方（不在此关）。 */
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

/**
 * 共享装配核心（生产面唯一装配链）：
 *   stateDir/审计路径 → 隔离断言（可选）→ 执行面 → 底账 → 技能/角色 → 驱动 → createSession。
 * 顺序与抽取前逐入口一致（门内不建库、不落盘：执行面失败时底账尚未创建）。
 */
export async function assembleSessionCore(input: SessionAssemblyInput): Promise<AssembledSession> {
  const auditPath = path.join(input.stateDir, 'audit.jsonl');
  if (input.setAuditPath === true) {
    mkdirSync(input.stateDir, { recursive: true });
    input.env['EXECUTION_AUDIT_PATH'] = auditPath;
  }
  input.assertIsolation?.();

  const face = input.createExecutionFace !== undefined
    ? await input.createExecutionFace(input.profile, input.env)
    : await defaultExecutionFace({
        profile: input.profile,
        env: input.env,
        stateDir: input.stateDir,
        emptyOperationsMessage: input.emptyOperationsMessage,
        emptyOperationsError: input.emptyOperationsError ?? ((message) => new Error(message)),
      });

  // 底账：注入的归调用方（不在此关）；自建的由本核心关闭（SQLite 需要 close 收尾）。
  const ownedRegistry: SqliteTaskRegistry | undefined = input.taskRegistry === undefined
    ? createSqliteTaskRegistry(input.dbPath)
    : undefined;
  const taskRegistry: TaskRegistry = input.taskRegistry ?? ownedRegistry!;
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
    });
    return {
      session,
      auditPath,
      taskRegistry,
      close: () => ownedRegistry?.close(),
    };
  } catch (error) {
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
