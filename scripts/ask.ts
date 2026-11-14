/**
 * ask：命令行一条消息 → 回合运行时 → 回复 + 机械证据。
 *
 * 用法：
 *   npm run ask -- "帮我查一下 ..." [--principal=wecom:fixture-user] [--session=<id>] [--config=<path>]
 *   （AGENT_CONFIG_PATH 与 --config 同义；缺省用 config/agent.fixture.yaml 的仓内 dummy 面。）
 *
 * 边界（本切片）：
 *   · 执行面 = profile 声明的仓内 dummy 夹具（scripts/eval/fixtures/dummy-platform，不触网、
 *     不碰真实平台；隔离门 fail-closed，root 必须在仓内夹具目录之下）；
 *   · 模型 = 真实 Pi 驱动（密钥只在 .env；缺 LLM_API_KEY 直接拒绝，不假装跑通）；
 *   · 任务底账 = SQLite（缺省 .runtime/state.db，config store.dbPath 可覆盖）：
 *     本进程关库后数据仍在，归属校验跨重启仍成立；
 *   · 只做单轮：不做确认 / 后台派发 / 产物 / 提案（后续切片）。
 *
 * 装配（配置物化/环境派生/前置门/执行层/底账/会话）与 `npm run tasks -- <id> --redo`
 * 共用 scripts/ask-runtime.ts 的同一函数；本入口只负责参数、运行时目录与输出。
 *
 * 打印：回复 + 机械证据行（#编号 + 业务名称 / requestId / operation / status）+ dummy 执行层审计行。
 * 本文件可被安全 import（import.meta.main 守卫）：import 不执行 CLI 主体（测试/复用前提）。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskRecord } from '../packages/agent/src/task-registry';
import { AssemblyRefusedError, assembleAskRuntime, type AskRuntime } from './ask-runtime';
import { taskLabel } from './tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK_ROOT = path.join(REPO_ROOT, '.runtime', 'ask');

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

export interface AskEvidenceInput {
  principalId: string;
  sessionId: string;
  /** 本回合首个任务（无委派时缺省）；只读展示口径（#编号/名称/原文）。 */
  task?: Pick<TaskRecord, 'taskNo' | 'name' | 'request'>;
  executionCount: number;
  completedCount: number;
  auditLineCount: number;
  elapsedSeconds: string;
}

/**
 * 机械证据行（前两行；纯函数，测试与 CLI 同源）：业务展示位用「#编号 + 业务名称」，
 * 不用内部 taskId（UUID 只出现在逐条执行证据 JSON 与底账/审计里）。
 */
export function renderAskEvidenceLines(input: AskEvidenceInput): string[] {
  return [
    `principal=${input.principalId} session=${input.sessionId} 委派=${input.task === undefined ? '否' : '是'}`,
    `任务=${input.task === undefined ? '（无委派）' : taskLabel(input.task)} 结构化执行=${input.executionCount} 次`
      + `（完成 ${input.completedCount}） dummy 审计=${input.auditLineCount} 行 用时=${input.elapsedSeconds}s`,
  ];
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

  let runtime: AskRuntime;
  try {
    runtime = await assembleAskRuntime({
      purpose: 'ask',
      argv: process.argv.slice(2),
      env: process.env,
      runtimeDir: ASK_ROOT,
      sessionId: parsed.sessionId ?? `ask-${new Date().toISOString().slice(0, 10)}`,
      ...(parsed.principalId === undefined ? {} : { principalId: parsed.principalId }),
    });
  } catch (error) {
    if (error instanceof AssemblyRefusedError) {
      // 抽取前这几处门就是「原样打印 + exit 2」——逐字保持。
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    const { session, principalId, sessionId, auditPath, dbPath } = runtime;
    const auditBefore = readLines(auditPath).length;
    const startedMs = Date.now();
    const turn = await session.send(parsed.message);
    const auditLines = readLines(auditPath).slice(auditBefore);
    const tasks = session.tasks().filter((task) => turn.taskIds.includes(task.taskId));
    const firstTask = tasks.find((task) => task.taskId === turn.taskIds[0]) ?? tasks[0];
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
      ...renderAskEvidenceLines({
        principalId,
        sessionId,
        ...(firstTask === undefined ? {} : { task: firstTask }),
        executionCount: facts.length,
        completedCount: facts.filter((fact) => fact.status === 'completed').length,
        auditLineCount: auditLines.length,
        elapsedSeconds: ((Date.now() - startedMs) / 1000).toFixed(1),
      }),
      `任务底账=${path.relative(REPO_ROOT, dbPath)}`,
    ].join('\n'));
    for (const fact of facts) console.log(JSON.stringify({ event: 'execution', ...fact }));
    for (const line of auditLines) console.log(line);

    if (turn.reply.trim() === '' || turn.taskIds.length === 0 || facts.length === 0) {
      console.error('未达标：回复为空或本轮无委派/无结构化执行——如实记录，不重试掩盖。');
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

// 仅作为 CLI 直接运行时执行 main：被 import（测试/复用）时不触发任何 CLI 副作用
// （与 tasks.ts/ops.ts 同一守卫；Node >=24 提供 import.meta.main）。
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error('ask 运行失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
