/**
 * 单条消息联调入口（issue #10 切片 A）：把一条用户消息灌进生产装配的黑盒入口，打印最终回复。
 * 用法：npm run ask -- "查一下幻辰财税本期的凭证" [--conversation <id>] [--db <path>] [--config=<path>]
 *
 * 装配唯一来源 = `apps/server/assembly.ts#createServerAssembly()`：driver/runtime/
 * platformTask/计划确认门/handler 全在装配里接线（含业务 Skill、上下文/长期记忆、
 * 平台执行队列与门审计、operation 规格、提案复核、Main 独立模型配置、profile.gateway
 * → worker 驱动穿线），本文件零接线代码——生产装配有什么门，ask 就过什么门。
 * 独立验收库（--db，缺省 data/ask-<ts>.db），不碰生产数据。
 *
 * 链路逻辑在 scripts/ask-session.ts 的适配器里（切片 B）；本文件只做参数解析与输出。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAskSession, type MessageTurn } from './ask-session';
import { explicitConfigFrom, resolveConfigPath } from './resolve-config-path';

export interface AskCliArgs {
  /** 要问的问题（剩余位置参数按空格拼接，与既有用法一致）。 */
  question: string;
  /** --conversation <id>：固定会话 id 供多轮脚本复用同一会话（指代/召回测试）；缺省随机。 */
  conversationId?: string;
  /** --db <path>：固定库文件供多轮脚本跨进程复用会话历史；缺省独立时间戳库。 */
  dbPath?: string;
  /** --config=<path>：显式配置（与 probe / resolve-config-path 同一入口）。 */
  configPath?: string;
}

/**
 * CLI 参数解析（导出供回归测试钉住：用法不退化）。语义与旧版逐条一致：
 *   · `--conversation <id>` / `--db <path>` 吃后随一个值，值不进 question；
 *   · `--config=<path>` 等号形式（与 probe 同款）；
 *   · 其余位置参数按空格拼成 question；空 question = 用法错误（exit 2）。
 */
export function parseAskCliArgs(argv: readonly string[]): { args: AskCliArgs; usageError: boolean } {
  let conversationId: string | undefined;
  let dbPath: string | undefined;
  const configFlag = argv.find((arg) => arg.startsWith('--config='));
  const configPath = configFlag !== undefined && configFlag.slice('--config='.length).trim() !== ''
    ? configFlag.slice('--config='.length).trim()
    : undefined;
  const questionParts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--conversation') {
      conversationId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--db') {
      dbPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) continue;
    questionParts.push(arg);
  }
  const question = questionParts.join(' ').trim();
  return {
    args: {
      question,
      ...(conversationId ? { conversationId } : {}),
      ...(dbPath ? { dbPath } : {}),
      ...(configPath ? { configPath } : {}),
    },
    usageError: question === '',
  };
}

function printTurn(turn: MessageTurn): void {
  if (turn.progress.length) {
    console.log('\n===== 进度 =====\n' + turn.progress.join('\n'));
  }
  for (const notice of turn.notices) {
    console.log('\n===== 计划通知 =====\n' + notice + '\n');
  }
  console.log('\n===== 回复 =====\n' + (turn.error !== null ? `（回合失败：${turn.error}）` : turn.reply));
}

async function main(): Promise<void> {
  const { args, usageError } = parseAskCliArgs(process.argv.slice(2));
  if (usageError) {
    console.error('用法：npm run ask -- "要问的问题" [--conversation <id>] [--db <path>] [--config=<path>]');
    process.exit(2);
  }
  // 配置同源（与 probe / acceptance / assembly 同一入口）：显式 --config= > AGENT_CONFIG_PATH
  // > config/agent.yaml（存在才用）> scripts/eval/eval.agent.yaml（回退时物化绝对路径副本）。
  const yamlPath = resolveConfigPath(args.configPath ?? explicitConfigFrom());
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CONFIG_PATH: yamlPath };
  // 独立 SQLite（--db 显式指定优先；缺省独立时间戳库）+ 固定会话 id（--conversation 优先）。
  const session = await createAskSession({
    env,
    ...(args.dbPath ? { dbPath: path.resolve(args.dbPath) } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
  });
  const started = Date.now();
  let turn: MessageTurn;
  try {
    // 一次消息、同进程会话；多轮脚本复用同一 --conversation/--db 再起进程即可续上。
    turn = await session.sendMessage(args.question);
  } finally {
    await session.close();
  }
  printTurn(turn);
  const dbPath = session.dbPath;
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s · db: ${dbPath})`);
  // 证据链摘要（切片 D）：关联 id 与阶梯一行，供人读与下游报告对账。
  console.log(JSON.stringify({
    event: 'ask_evidence',
    evalRunId: turn.evidence.evalRunId,
    caseId: turn.evidence.caseId,
    messageId: turn.messageId,
    requestId: turn.evidence.requestId ?? null,
    taskId: turn.evidence.delegations[0]?.taskId ?? null,
    platformCalls: turn.evidence.executionRows.length,
    refused: turn.evidence.executionRows.filter((row) => row.refused).length,
    ladderRung: turn.ladderRung,
  }));
}

// 仅直接执行时运行（tsx 场景 process.argv[1] 即本文件）：vitest 会 import 本模块复用
// parseAskCliArgs，不加守卫会在加载时跑一轮消息并 process.exit，把测试进程带走。
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('ask 失败:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
