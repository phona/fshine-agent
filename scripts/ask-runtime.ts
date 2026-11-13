/**
 * ask 共享装配：配置 → 生效环境 → 前置门 → 执行层面 → 任务底账 → 回合会话。
 *
 * 消费方（唯一来源，不复制第二份装配）：
 *   · scripts/ask.ts    —— npm run ask（purpose='ask'）；
 *   · scripts/tasks.ts  —— npm run tasks -- <id> --redo（purpose='重新推进'）。
 *
 * ask 行为/输出逐字不变（P3 抽取的硬约束）：
 *   · 五处装配门（缺 LLM key / 非单一 profile / 缺 gateway / 无 enabled principal /
 *     执行层零只读 operation）抛 AssemblyRefusedError；ask 侧 catch 后原样打印并 exit 2，
 *     与抽取前 ask.ts 的 console.error + exit 2 逐字节一致；话术里的调用方名词用 purpose
 *     参数化：purpose='ask' 时逐字等于抽取前原文。
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
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/dummy-cli-client';
import { MAIN_PROTOCOL_NOTE, createSession, type Session } from '../packages/agent/src/execution-runtime';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
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
  mkdirSync(stateDir, { recursive: true });
  const auditPath = path.join(stateDir, 'audit.jsonl');
  env['EXECUTION_AUDIT_PATH'] = auditPath;
  // fail-closed 隔离门：root 必须在仓内夹具目录、网关可达、审计通道可写读。
  assertEvalIsolation(assessEvalIsolation({
    env,
    platformRoot: profile.root,
    gateway: profile.gateway,
  }), `${input.purpose}（仓内 dummy 面）`);

  const client = createDummyCliClient({ root: profile.root, gateway: profile.gateway, stateDir, env });
  const operations = await client.listOperations();
  const allowedOperations = readOnlyOperationNames(operations);
  if (allowedOperations.length === 0) {
    throw new AssemblyRefusedError('执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。');
  }

  const dbPath = input.dbPath
    ?? (config.store?.dbPath !== undefined ? path.resolve(config.store.dbPath) : DEFAULT_DB_PATH);
  const taskRegistry = createSqliteTaskRegistry(dbPath);
  try {
    const workerSkills = await loadWorkerSkills(profile.root, profile.skillRoots);
    const profileMd = await loadAgentProfile();
    const session = await createSession({
      principalId,
      sessionId: input.sessionId,
      client,
      allowedOperations,
      mainDriver: createPiTurnDriver({ env }),
      workerDriver: createPiTurnDriver({ env }),
      mainSystemPrompt: `${applyExecutorLabel(profileMd.instructions, profile.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`,
      workerSkills,
      taskRegistry,
    });
    return {
      session,
      principalId,
      sessionId: input.sessionId,
      dbPath,
      auditPath,
      stateDir,
      close: () => taskRegistry.close(),
    };
  } catch (error) {
    taskRegistry.close();
    throw error;
  }
}
