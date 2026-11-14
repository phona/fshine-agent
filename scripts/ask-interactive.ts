/**
 * P7a 交互式 ask（`npm run ask -- --interactive [--principal/--session/--trace]`）。
 *
 * 依据：R4 验收设计 P7-T01「连续交互会话：同一 Session 连续回合；逐回合输出（回复+机械证据）；
 * exit 0」；owner 接线纪律：同一 Runtime（经 scripts/ask-runtime.ts 的共享装配，五门与
 * 话术逐字不变）、ask.ts 只加最小 hook、不建影子 Runtime。
 *
 * 语义：
 *   · 单进程一个 Session：stdin 逐行 send（空行跳过，EOF 结束），跨回合同一底账 scope；
 *   · 逐回合输出「===== 回合 N =====」+ 回复 + 机械证据（委派/结构化执行/审计行/底账）；
 *   · 空回复或 send 异常 = 该回合失败：如实输出并置 exit 1，不重试掩盖、不静默吞；
 *   · 装配门拒绝（缺密钥等五门）→ exit 2（话术来自共享装配，字节不变）；
 *   · --trace：逐回合记录进 TraceRecorder（mode=interactive；原样记录，未归一）。
 */
import { readFileSync } from 'node:fs';
import { AssemblyRefusedError, assembleAskRuntimeCli, type AskRuntime } from './ask-runtime';
import { createTraceRecorder, type TraceRecorder, type TraceTurnRecord } from './ask-trace';
import type { Session } from '../packages/agent/src/execution-runtime';
import type { ExecutionRecord } from '../packages/agent/src/task-registry';

export interface InteractiveTurnRecord {
  index: number;
  session: string;
  text: string;
  reply: string;
  taskIds: readonly string[];
  executionCount: number;
  auditLines: readonly string[];
  mainMessages: readonly unknown[];
  workerMessages: readonly (readonly unknown[])[];
}

export interface InteractiveLoopInput {
  session: Session;
  lines: AsyncIterable<string> | Iterable<string>;
  write: (line: string) => void;
  principalId: string;
  sessionId: string;
  auditPath?: string;
  dbPath?: string;
  onTurn?: (record: InteractiveTurnRecord) => void;
}

async function* asAsyncIterable(lines: AsyncIterable<string> | Iterable<string>): AsyncIterable<string> {
  if (Symbol.asyncIterator in (lines as object)) {
    yield* lines as AsyncIterable<string>;
    return;
  }
  yield* lines as Iterable<string>;
}

function readAuditLines(file: string | undefined): string[] {
  if (file === undefined) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

export async function runInteractiveLoop(input: InteractiveLoopInput): Promise<number> {
  input.write('===== 交互会话 =====');
  input.write(`principal=${input.principalId} session=${input.sessionId}（逐行发送；EOF 结束）`);
  let index = 0;
  let failures = 0;
  for await (const rawLine of asAsyncIterable(input.lines)) {
    const text = rawLine.trim();
    if (text === '') continue;
    index += 1;
    const auditBefore = readAuditLines(input.auditPath).length;
    const startedMs = Date.now();
    input.write(`===== 回合 ${index} =====`);
    let reply = '';
    let taskIds: readonly string[] = [];
    let executions: readonly ExecutionRecord[] = [];
    try {
      const result = await input.session.send(text);
      reply = result.reply;
      taskIds = result.taskIds;
      executions = result.executions;
    } catch (error) {
      failures += 1;
      input.write(`回合失败：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const auditLines = readAuditLines(input.auditPath).slice(auditBefore);
    input.write('===== 回复 =====');
    input.write(reply);
    input.write('===== 机械证据 =====');
    input.write(`principal=${input.principalId} session=${input.sessionId} 委派=${taskIds.length > 0 ? '是' : '否'}`);
    const completed = executions.filter((execution) => execution.status === 'completed').length;
    input.write(
      `taskId=${taskIds[0] ?? '（无委派）'} 结构化执行=${executions.length} 次（完成 ${completed}）`
      + ` dummy 审计=${auditLines.length} 行 用时=${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
    );
    if (input.dbPath !== undefined) input.write(`任务底账=${input.dbPath}`);
    for (const execution of executions) {
      input.write(JSON.stringify({
        event: 'execution',
        taskId: taskIds[0] ?? '',
        requestId: execution.requestId,
        operation: execution.operation,
        status: execution.status,
        ...(execution.error !== undefined ? { error: execution.error } : {}),
      }));
    }
    for (const line of auditLines) input.write(line);
    if (reply.trim() === '') {
      failures += 1;
      input.write('回合失败：回复为空（如实记录，不重试掩盖）。');
    }
    input.onTurn?.({
      index,
      session: input.sessionId,
      text,
      reply,
      taskIds: [...taskIds],
      executionCount: executions.length,
      auditLines,
      mainMessages: [...input.session.transcript()],
      workerMessages: [],
    });
  }
  return failures === 0 ? 0 : 1;
}

export interface InteractiveCliInput {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  sessionId: string;
  principalId?: string;
  traceDir?: string;
  lines: AsyncIterable<string> | Iterable<string>;
  write: (line: string) => void;
  writeError: (line: string) => void;
}

export async function runInteractiveCli(input: InteractiveCliInput): Promise<number> {
  let runtime: AskRuntime;
  try {
    runtime = await assembleAskRuntimeCli({
      argv: input.argv,
      env: input.env,
      runtimeDir: input.runtimeDir,
      sessionId: input.sessionId,
      ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    });
  } catch (error) {
    if (error instanceof AssemblyRefusedError) {
      input.writeError(error.message);
      return 2;
    }
    throw error;
  }
  try {
    let recorder: TraceRecorder | undefined;
    if (input.traceDir !== undefined) {
      recorder = createTraceRecorder({
        dir: input.traceDir,
        mode: 'interactive',
        principalId: runtime.principalId,
        sessionId: runtime.sessionId,
        dbPath: runtime.dbPath,
      });
    }
    const recorderRef = recorder;
    const code = await runInteractiveLoop({
      session: runtime.session,
      lines: input.lines,
      write: input.write,
      principalId: runtime.principalId,
      sessionId: runtime.sessionId,
      auditPath: runtime.auditPath,
      dbPath: runtime.dbPath,
      ...(recorderRef === undefined
        ? {}
        : { onTurn: (record: InteractiveTurnRecord) => recorderRef.recordTurn(record as TraceTurnRecord) }),
    });
    recorder?.finish({ scenario: `interactive-${runtime.sessionId}` });
    return code;
  } finally {
    runtime.close();
  }
}
