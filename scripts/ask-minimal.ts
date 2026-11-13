/**
 * Minimal Rewrite U2 最小 ask：命令行一条消息 → Minimal runtime → 回复 + 机械证据。
 *
 * 用法：
 *   npm run ask -- "帮我查一下 ..." [--principal=wecom:demo-user] [--session=<id>] [--config=<path>]
 *   （AGENT_CONFIG_PATH 与 --config 同义；缺省用 config/agent.fixture.yaml 的仓内 dummy 面。）
 *
 * 边界（本切片）：
 *   · 执行面 = profile 声明的仓内 dummy 夹具（scripts/eval/fixtures/dummy-platform，不触网、
 *     不碰真实平台；隔离门 fail-closed，root 必须在仓内夹具目录之下）；
 *   · 模型 = 真实 Pi 驱动（密钥只在 .env；缺 LLM_API_KEY 直接拒绝，不假装跑通）；
 *   · 任务底账 = SQLite（缺省 .runtime/minimal/state.db，config store.dbPath 可覆盖）：
 *     本进程关库后数据仍在，归属校验跨重启仍成立；
 *   · 只做单轮：不做确认 / 后台派发 / 产物 / 提案（后续切片）。
 *
 * 打印：回复 + taskId / requestId / operation / status + dummy 执行层审计行。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/minimal/dummy-cli-client';
import {
  MAIN_PROTOCOL_NOTE,
  createMinimalSession,
} from '../packages/agent/src/minimal/execution-runtime';
import { createSqliteTaskRegistry } from '../packages/agent/src/minimal/task-registry-sqlite';
import { loadWorkerSkills } from '../packages/agent/src/minimal/worker-skills';
import { explicitConfigFrom, materializeEvalConfig } from './resolve-config-path';
import { assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const MINIMAL_ROOT = path.join(REPO_ROOT, '.runtime', 'minimal');
const ASK_ROOT = path.join(MINIMAL_ROOT, 'ask');
const CONFIG_COPY = path.join(ASK_ROOT, 'agent-config.yaml');
const DEFAULT_DB_PATH = path.join(MINIMAL_ROOT, 'state.db');

interface AskArgs {
  message: string;
  principalId?: string;
  sessionId?: string;
}

const USAGE = '用法：npm run ask -- "消息" [--principal=<id>] [--session=<id>] [--config=<path>]';

function parseArgs(argv: readonly string[]): AskArgs | { usageError: string } {
  let message = '';
  let principalId: string | undefined;
  let sessionId: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--principal=')) {
      principalId = arg.slice('--principal='.length).trim() || undefined;
    } else if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length).trim() || undefined;
    } else if (arg.startsWith('--config=')) {
      // 归 explicitConfigFrom 统一解析；这里只跳过。
      continue;
    } else if (arg.startsWith('--')) {
      return { usageError: `未知参数：${arg}` };
    } else if (message === '') {
      message = arg;
    } else {
      return { usageError: '只接受一条消息（多段请用引号包成一条）。' };
    }
  }
  if (message.trim() === '') return { usageError: '缺少消息。' };
  return { message, ...(principalId === undefined ? {} : { principalId }), ...(sessionId === undefined ? {} : { sessionId }) };
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('usageError' in parsed) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    process.exitCode = 2;
    return;
  }

  // 配置：显式 --config / AGENT_CONFIG_PATH 优先；缺省用仓内 dummy 面配置（物化绝对 root 副本）。
  rmSync(ASK_ROOT, { recursive: true, force: true });
  mkdirSync(ASK_ROOT, { recursive: true });
  const explicit = explicitConfigFrom(process.argv.slice(2));
  const configPath = explicit ?? materializeEvalConfig(FIXTURE_CONFIG, CONFIG_COPY);
  const config = loadConfig({ yamlPath: configPath });
  const env = effectiveDeploymentEnv(config, process.env);
  if ((env['LLM_API_KEY'] ?? '').trim() === '') {
    console.error('未检测到 LLM_API_KEY——ask 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。');
    process.exitCode = 2;
    return;
  }

  const profileIds = Object.keys(config.contextProfiles);
  if (profileIds.length !== 1) {
    console.error(`ask 需要单一 contextProfile（当前 ${profileIds.length} 个）——最小切片不做多 profile 选择。`);
    process.exitCode = 2;
    return;
  }
  const profile = config.contextProfiles[profileIds[0]!]!;
  if (!profile.gateway) {
    console.error('profile 缺少 gateway——最小切片需要执行层挂载声明。');
    process.exitCode = 2;
    return;
  }
  const principalId = parsed.principalId
    ?? Object.entries(config.principals).find(([, principal]) => principal.enabled)?.[0];
  if (principalId === undefined) {
    console.error('配置里没有 enabled principal——最小切片需要可信身份来源（fail-closed，不回落写死值）。');
    process.exitCode = 2;
    return;
  }
  const sessionId = parsed.sessionId ?? `ask-minimal-${new Date().toISOString().slice(0, 10)}`;

  const stateDir = path.join(ASK_ROOT, 'state');
  mkdirSync(stateDir, { recursive: true });
  const auditPath = path.join(stateDir, 'audit.jsonl');
  env['EXECUTION_AUDIT_PATH'] = auditPath;
  // fail-closed 隔离门：root 必须在仓内夹具目录、网关可达、审计通道可写读。
  assertEvalIsolation(assessEvalIsolation({
    env,
    platformRoot: profile.root,
    gateway: profile.gateway,
  }), 'ask-minimal（最小 ask）');

  const client = createDummyCliClient({ root: profile.root, gateway: profile.gateway, stateDir, env });
  const operations = await client.listOperations();
  const allowedOperations = readOnlyOperationNames(operations);
  if (allowedOperations.length === 0) {
    console.error('执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。');
    process.exitCode = 2;
    return;
  }

  const dbPath = config.store?.dbPath !== undefined ? path.resolve(config.store.dbPath) : DEFAULT_DB_PATH;
  const taskRegistry = createSqliteTaskRegistry(dbPath);
  try {
    const workerSkills = await loadWorkerSkills(profile.root, profile.skillRoots);
    const profileMd = await loadAgentProfile();
    const session = await createMinimalSession({
      principalId,
      sessionId,
      client,
      allowedOperations,
      mainDriver: createPiTurnDriver({ env }),
      workerDriver: createPiTurnDriver({ env }),
      mainSystemPrompt: `${applyExecutorLabel(profileMd.instructions, profile.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`,
      workerSkills,
      taskRegistry,
    });

    const auditBefore = readLines(auditPath).length;
    const startedMs = Date.now();
    const turn = await session.send(parsed.message);
    const auditLines = readLines(auditPath).slice(auditBefore);
    const tasks = session.tasks().filter((task) => turn.taskIds.includes(task.taskId));
    const facts = tasks.flatMap((task) => task.executions.map((execution) => ({
      taskId: task.taskId,
      requestId: execution.requestId,
      operation: execution.operation,
      status: execution.status,
      ...(execution.error !== undefined ? { error: execution.error } : {}),
    })));

    console.log(`\n===== 回复 =====\n${turn.reply}`);
    console.log([
      '\n===== 机械证据 =====',
      `principal=${principalId} session=${sessionId} 委派=${turn.taskIds.length > 0 ? '是' : '否'}`,
      `taskId=${turn.taskIds[0] ?? '（无委派）'} 结构化执行=${facts.length} 次`
      + `（完成 ${facts.filter((fact) => fact.status === 'completed').length}）`
      + ` dummy 审计=${auditLines.length} 行 用时=${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
      `任务底账=${path.relative(REPO_ROOT, dbPath)}`,
    ].join('\n'));
    for (const fact of facts) console.log(JSON.stringify({ event: 'minimal_execution', ...fact }));
    for (const line of auditLines) console.log(line);

    if (turn.reply.trim() === '' || turn.taskIds.length === 0 || facts.length === 0) {
      console.error('未达标：回复为空或本轮无委派/无结构化执行——如实记录，不重试掩盖。');
      process.exitCode = 1;
    }
  } finally {
    taskRegistry.close();
  }
}

await main().catch((error: unknown) => {
  console.error('ask 运行失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
