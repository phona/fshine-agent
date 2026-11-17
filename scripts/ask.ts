/**
 * ask：命令行一条消息 → 回合运行时 → 回复 + 机械证据。
 *
 * 用法：
 *   npm run ask -- "帮我查一下 ..." [--principal=wecom:fixture-user] [--session=<id>] [--config=<path>]
 *   npm run ask -- --interactive [--principal=<id>] [--session=<id>] [--trace=<dir>]
 *   npm run ask -- --script <file> [--trace=<dir>]
 *   （AGENT_CONFIG_PATH 与 --config 同义；缺省用 config/agent.fixture.yaml 的仓内 dummy 面。）
 *
 * 边界（本切片）：
 *   · 执行面 = profile 声明的仓内 dummy 夹具（scripts/eval/fixtures/dummy-platform，不触网、
 *     不碰真实平台；隔离门 fail-closed，root 必须在仓内夹具目录之下）；
 *   · 模型 = 真实 Pi 驱动（密钥只在 .env；缺 LLM_API_KEY 直接拒绝，不假装跑通）；
 *     脚本回放（--script）是确定性层：脚本内假 driver，零模型、零网络、不要求密钥；
 *   · 任务底账 = SQLite（缺省 .runtime/state.db，config store.dbPath 可覆盖）：
 *     本进程关库后数据仍在，归属校验跨重启仍成立；
 *   · 单轮路径只做单轮：不做确认 / 后台派发 / 产物 / 提案（后续切片）；
 *     交互式=单进程一个 Session 循环 send；脚本回放=§3.1 的 P7a 子集（见 scripts/ask-replay.ts）。
 *
 * 装配（配置物化/环境派生/前置门/执行层/底账/会话）与 `npm run tasks -- <id> --redo`
 * 共用 scripts/ask-runtime.ts 的同一函数（交互式走 assembleAskRuntimeCli，同一五门）；
 * 本入口只负责参数、运行时目录与输出（P7a 只加 dispatch hook，单轮路径逐字不变）。
 *
 * 打印：回复 + 机械证据行（#编号 + 业务名称 / requestId / operation / status）+ dummy 执行层审计行。
 * 本文件可被安全 import（import.meta.main 守卫）：import 不执行 CLI 主体（测试/复用前提）。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { TaskRecord } from '../packages/agent/src/task-registry';
import { runInteractiveCli } from './ask-interactive';
import { runReplayCli } from './ask-replay';
import { AssemblyRefusedError, assembleAskRuntime, type AskRuntime } from './ask-runtime';
import { taskLabel } from './tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK_ROOT = path.join(REPO_ROOT, '.runtime', 'ask');

type ParsedArgs =
  | { mode: 'turn'; message: string; principalId?: string; sessionId?: string }
  | { mode: 'interactive'; principalId?: string; sessionId?: string; traceDir?: string }
  | { mode: 'script'; scriptPath: string; traceDir?: string; configPath?: string };

const USAGE = [
  '用法：npm run ask -- "消息" [--principal=<id>] [--session=<id>] [--config=<path>]',
  '      npm run ask -- --interactive [--principal=<id>] [--session=<id>] [--trace=<dir>]',
  '      npm run ask -- --script <file> [--trace=<dir>]',
].join('\n');

function parseArgs(argv: readonly string[]): ParsedArgs | { usageError: string } {
  let message = '';
  let principalId: string | undefined;
  let sessionId: string | undefined;
  let configPath: string | undefined;
  let interactive = false;
  let scriptPath: string | undefined;
  let traceDir: string | undefined;

  /** `--flag=` 或 `--flag value` 两形态取值（缺值返回空串）。 */
  const valueAfter = (index: number, inline: string): { value: string; consumed: number } => {
    if (inline !== '') return { value: inline, consumed: 0 };
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) return { value: next.trim(), consumed: 1 };
    return { value: '', consumed: 0 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--principal=')) {
      principalId = arg.slice('--principal='.length).trim() || undefined;
    } else if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length).trim() || undefined;
    } else if (arg.startsWith('--config=')) {
      // 归 explicitConfigFrom 统一解析；这里只跳过。
      configPath = arg.slice('--config='.length).trim() || undefined;
    } else if (arg === '--interactive') {
      interactive = true;
    } else if (arg === '--script' || arg.startsWith('--script=')) {
      const { value, consumed } = valueAfter(index, arg.startsWith('--script=') ? arg.slice('--script='.length).trim() : '');
      index += consumed;
      if (value === '') return { usageError: '--script 缺少脚本文件路径。' };
      scriptPath = value;
    } else if (arg === '--trace' || arg.startsWith('--trace=')) {
      const { value, consumed } = valueAfter(index, arg.startsWith('--trace=') ? arg.slice('--trace='.length).trim() : '');
      index += consumed;
      if (value === '') return { usageError: '--trace 缺少目录路径。' };
      traceDir = value;
    } else if (arg.startsWith('--')) {
      return { usageError: `未知参数：${arg}` };
    } else if (message === '') {
      message = arg;
    } else {
      return { usageError: '只接受一条消息（多段请用引号包成一条）。' };
    }
  }

  // 模式互斥与取值校验（fail-closed，exit 2）。
  if (interactive && scriptPath !== undefined) {
    return { usageError: '--interactive 与 --script 互斥：一次只跑一种回放方式。' };
  }
  if (scriptPath !== undefined) {
    if (message.trim() !== '') return { usageError: '--script 不接受消息参数（消息写在脚本里）。' };
    if (principalId !== undefined || sessionId !== undefined) {
      return { usageError: '--script 模式不接受 --principal/--session 覆盖（身份写在脚本里）。' };
    }
    return {
      mode: 'script',
      scriptPath,
      ...(traceDir === undefined ? {} : { traceDir }),
      ...(configPath === undefined ? {} : { configPath }),
    };
  }
  if (interactive) {
    if (message.trim() !== '') return { usageError: '--interactive 不接受消息参数（消息从标准输入逐行读取）。' };
    return {
      mode: 'interactive',
      ...(principalId === undefined ? {} : { principalId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(traceDir === undefined ? {} : { traceDir }),
    };
  }
  if (traceDir !== undefined) return { usageError: '--trace 需要与 --interactive 或 --script 同用。' };
  if (message.trim() === '') return { usageError: '缺少消息。' };
  return {
    mode: 'turn',
    message,
    ...(principalId === undefined ? {} : { principalId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
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

  // 脚本回放（确定性层：脚本内假 driver；不经过真实模型门）。
  if (parsed.mode === 'script') {
    process.exitCode = await runReplayCli({
      scriptPath: parsed.scriptPath,
      ...(parsed.traceDir === undefined ? {} : { traceDir: parsed.traceDir }),
      ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
      env: process.env,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
    return;
  }

  // 交互式（单进程一个 Session 循环 send；装配走共享函数，五门话术逐字不变）。
  if (parsed.mode === 'interactive') {
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      process.exitCode = await runInteractiveCli({
        argv: process.argv.slice(2),
        env: process.env,
        runtimeDir: ASK_ROOT,
        sessionId: parsed.sessionId ?? `ask-${new Date().toISOString().slice(0, 10)}`,
        ...(parsed.principalId === undefined ? {} : { principalId: parsed.principalId }),
        ...(parsed.traceDir === undefined ? {} : { traceDir: parsed.traceDir }),
        lines: lines[Symbol.asyncIterator](),
        write: (line) => console.log(line),
        writeError: (line) => console.error(line),
      });
    } finally {
      lines.close();
    }
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
