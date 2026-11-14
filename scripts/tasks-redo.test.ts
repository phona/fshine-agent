/**
 * tasks --redo（P3 人工接管 v1）：终态任务一键重新推进。
 *
 * 本文件钉住（用户视角可演示的机械事实）：
 *   · 终态判定矩阵：completed/failed/unexecuted 可；running 与未知态拒（exit 2）；
 *   · 输入=存储的交办原文逐字：经**真实 createSession** + 记录驱动断言唯一 user 消息逐字节相等；
 *   · 无历史注入：原任务的回复/失败原因/执行错误哨兵不出现在驱动器可见输入；
 *   · 原任务记录零改动；输出逐字含「原任务 #编号 → 新任务 #编号（状态：…）」；
 *   · redo 走生产同源装配：principal/session/dbPath/argv/env 原样传给装配函数；
 *   · 错误码：装配门拒绝 2 / 装配其它错误 1 / send 失败 1（如实报告已创建的新任务）/ 未达标 1。
 * e2e：真实子进程跑 CLI 的确定性拒绝路径（不含模型调用；LLM_API_KEY 显式置空）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_CONTRACT_VERSION,
  type ExecutionClient,
} from '@fshine/contracts/execution-contract';
import { createSession, type Session } from '../packages/agent/src/execution-runtime';
import type { TurnDriver, TurnDriverInput } from '../packages/agent/src/driver-contract';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import type { TaskRecord, TaskStatus } from '../packages/agent/src/task-registry';
import { AssemblyRefusedError } from './ask-runtime';
import { parseTaskArgs, renderRedoPairLine, runRedo, type RedoDeps } from './tasks';

const REPO_ROOT = path.resolve(__dirname, '..');

const dirs: string[] = [];
function tempDir(prefix = 'tasks-redo-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:fixture-user', sessionId: 'ask-redo-session' };
const REQUEST = '帮我查一下 beta 集合、窗口 W1 的数据';

function syntheticTask(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    request: REQUEST,
    status: 'failed',
    taskNo: 1,
    executions: [],
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

/** 走真实 SQLite 注册表造终态任务（与 P1 查看面消费同一份存储）。 */
function seedTerminalTask(dbPath: string, input: {
  taskId: string;
  status: 'completed' | 'failed' | 'unexecuted';
  request?: string;
  resultText?: string;
  executionError?: string;
}): void {
  const registry = createSqliteTaskRegistry(dbPath);
  registry.begin({ taskId: input.taskId, ...SCOPE, request: input.request ?? REQUEST });
  if (input.status === 'completed') {
    registry.noteExecution(input.taskId, { requestId: `req_${input.taskId}`, operation: 'dummy.query', status: 'completed' });
    registry.complete(input.taskId, input.resultText ?? '已查询 beta：3 条。');
  } else if (input.status === 'unexecuted') {
    registry.complete(input.taskId, input.resultText ?? '本轮未发起调用。');
  } else {
    registry.noteExecution(input.taskId, {
      requestId: `req_${input.taskId}`,
      operation: 'dummy.query',
      status: 'failed',
      ...(input.executionError === undefined ? {} : { error: { code: 'COLLECTION_FAULT', message: input.executionError } }),
    });
    registry.complete(input.taskId, input.resultText ?? '执行层报告故障。');
  }
  registry.close();
}

function readTask(dbPath: string, taskId: string): TaskRecord {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    return registry.get(taskId, SCOPE);
  } finally {
    registry.close();
  }
}

function listTaskIds(dbPath: string): string[] {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    return registry.list().map((task) => task.taskId).sort();
  } finally {
    registry.close();
  }
}

interface Recorder {
  mainInputs: TurnDriverInput[];
}

function recordingMain(recorder: Recorder, mode: 'delegate' | 'chat'): TurnDriver {
  return {
    async run(input) {
      recorder.mainInputs.push(input);
      if (mode === 'chat') return { text: '本轮没有交办。', messages: [...input.messages] };
      await input.exec('run_task', { task: '（模型复述的任务文本）' });
      return { text: '已重新交办并收到汇报。', messages: [...input.messages] };
    },
  };
}

function workerOk(): TurnDriver {
  return {
    async run(input) {
      return { text: 'Worker 汇报：本轮没有可执行的调用。', messages: [...input.messages] };
    },
  };
}

function fakeClient(): ExecutionClient {
  return {
    capabilities: async () => ({
      contractVersion: EXECUTION_CONTRACT_VERSION,
      operations: [{ name: 'dummy.query', args: [] }],
    }),
    execute: async () => {
      throw new Error('测试不应调用执行层');
    },
  };
}

/** 把真实 createSession 装成 redo 的"生产同源装配"注入件（记录 Main 驱动可见输入）。 */
async function realSession(
  dbPath: string,
  recorder: Recorder,
  mode: 'delegate' | 'chat' = 'delegate',
): Promise<{ session: Session; close: () => void }> {
  const registry = createSqliteTaskRegistry(dbPath);
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: fakeClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: recordingMain(recorder, mode),
    workerDriver: workerOk(),
    mainSystemPrompt: 'TEST SYSTEM PROMPT',
    taskRegistry: registry,
  });
  return { session, close: () => registry.close() };
}

function redoInput(task: TaskRecord, dbPath: string): Parameters<typeof runRedo>[0] {
  return { task, dbPath, argv: [], env: {}, runtimeDir: tempDir() };
}

describe('tasks --redo：参数解析', () => {
  it('--redo 与 taskId 组合（位置无关、--config 透传）；缺 id/与 --out 冲突/重复是用法错误', () => {
    expect(parseTaskArgs(['task_x', '--redo'])).toEqual({ taskId: 'task_x', redo: true });
    expect(parseTaskArgs(['--redo', 'task_x'])).toEqual({ taskId: 'task_x', redo: true });
    expect(parseTaskArgs(['task_x', '--redo', '--config=/tmp/x.yaml'])).toEqual({ taskId: 'task_x', redo: true });
    expect(parseTaskArgs(['--redo'])).toMatchObject({ usageError: expect.stringContaining('--redo 需要与 taskId 一起使用') });
    expect(parseTaskArgs(['task_x', '--redo', '--out', 'a.md']))
      .toMatchObject({ usageError: expect.stringContaining('--redo 与 --out 不能同时使用') });
    expect(parseTaskArgs(['task_x', '--redo', '--redo']))
      .toMatchObject({ usageError: expect.stringContaining('最多接受一个 --redo') });
    // 既有形态不动：无 --redo 时返回对象里没有 redo 键。
    expect(parseTaskArgs(['task_x'])).toEqual({ taskId: 'task_x' });
  });
});

describe('tasks --redo：终态判定与拒绝路径', () => {
  it('completed/failed/unexecuted 可重新推进；running/未知态/空原文拒绝且不触发装配', async () => {
    let assembleCalls = 0;
    const deps: RedoDeps = {
      assemble: async () => {
        assembleCalls += 1;
        throw new Error('不应装配');
      },
    };

    const running = await runRedo(redoInput(syntheticTask({ taskId: 'task_r', status: 'running' }), '/nope.db'), deps);
    expect(running.exitCode).toBe(2);
    expect(running.stdout).toBe('');
    expect(running.stderr).toBe('任务正在进行中，不能重新推进：task_r（仅已完成、失败或未执行的任务可以重新推进）。\n');

    const bogus = await runRedo(redoInput(syntheticTask({ taskId: 'task_b', status: 'bogus' as TaskStatus }), '/nope.db'), deps);
    expect(bogus.exitCode).toBe(2);
    expect(bogus.stderr).toBe('任务状态无法识别（bogus），拒绝重新推进：task_b。\n');

    const blank = await runRedo(redoInput(syntheticTask({ taskId: 'task_e', status: 'failed', request: '   ' }), '/nope.db'), deps);
    expect(blank.exitCode).toBe(2);
    expect(blank.stderr).toBe('任务缺少交办原文，无法重新推进：task_e。\n');

    expect(assembleCalls).toBe(0);
  });

  it('终态矩阵：三种终态都进入装配，principal/session/dbPath/argv/env 原样下传', async () => {
    const seen: Array<Record<string, unknown>> = [];
    for (const status of ['completed', 'failed', 'unexecuted'] as const) {
      const dir = tempDir();
      const dbPath = path.join(dir, 'state.db');
      seedTerminalTask(dbPath, { taskId: `task_${status}`, status });
      const task = readTask(dbPath, `task_${status}`);
      const recorder: Recorder = { mainInputs: [] };
      const built = await realSession(dbPath, recorder);
      const env = { MARKER: 'env-sentinel' };
      const argv = ['task_' + status, '--redo'];
      const outcome = await runRedo(
        { task, dbPath, argv, env, runtimeDir: path.join(dir, 'redo') },
        {
          assemble: async (input) => {
            seen.push({ ...input });
            return { session: built.session, close: built.close };
          },
        },
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stderr).toBe('');
      expect(outcome.stdout).toContain('原任务 #1 → 新任务 #2');
      expect(outcome.stdout).toContain('（状态：未执行）');
      expect(outcome.stdout).toContain(`任务底账：${dbPath}（新任务已写入）`);
      // 新任务确实落账；原任务不在 stdout 的详情渲染里被改写（另见零改动用例）。
      const ids = listTaskIds(dbPath);
      expect(ids).toHaveLength(2);
    }
    for (const input of seen) {
      expect(input['purpose']).toBe('重新推进');
      expect(input['sessionId']).toBe(SCOPE.sessionId);
      expect(input['principalId']).toBe(SCOPE.principalId);
      expect(input['env']).toMatchObject({ MARKER: 'env-sentinel' });
      expect(input['argv']).toEqual(expect.arrayContaining(['--redo']));
    }
  });
});

describe('tasks --redo：原文逐字与无历史注入', () => {
  it('send 收到的就是存储的交办原文（含空白），Main 转录恰一条 user 消息', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const request = '  帮我查 beta\n（第二行，原样空白）  ';
    seedTerminalTask(dbPath, { taskId: 'task_v', status: 'failed', request });
    const task = readTask(dbPath, 'task_v');
    expect(task.request).toBe(request);

    const recorder: Recorder = { mainInputs: [] };
    const built = await realSession(dbPath, recorder);
    const outcome = await runRedo(redoInput(task, dbPath), {
      assemble: async () => ({ session: built.session, close: built.close }),
    });

    expect(outcome.exitCode).toBe(0);
    expect(recorder.mainInputs).toHaveLength(1);
    const messages = recorder.mainInputs[0]!.messages;
    expect(messages).toHaveLength(1);
    expect((messages[0] as { role: string }).role).toBe('user');
    expect((messages[0] as { content: unknown }).content).toBe(request);
    expect(outcome.stdout).toContain('（状态：未执行）');
  });

  it('原任务的回复/失败原因/执行错误哨兵不出现在驱动器可见输入（禁历史注入绊线）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const sentinelResult = 'SENTINEL_RESULT_9f2a';
    const sentinelError = 'SENTINEL_EXEC_ERROR_9f2a';
    seedTerminalTask(dbPath, {
      taskId: 'task_sentinel',
      status: 'failed',
      request: '帮我查 faulty-one 集合的数据',
      resultText: sentinelResult,
      executionError: sentinelError,
    });
    const task = readTask(dbPath, 'task_sentinel');
    expect(task.resultText).toBe(sentinelResult);
    expect(task.failureReason).toContain(sentinelError);

    const recorder: Recorder = { mainInputs: [] };
    const built = await realSession(dbPath, recorder);
    const outcome = await runRedo(redoInput(task, dbPath), {
      assemble: async () => ({ session: built.session, close: built.close }),
    });

    expect(outcome.exitCode).toBe(0);
    const visible = JSON.stringify(recorder.mainInputs);
    expect(visible).not.toContain(sentinelResult);
    expect(visible).not.toContain(sentinelError);
    expect(outcome.stdout).not.toContain(sentinelResult);
    expect(outcome.stdout).not.toContain(sentinelError);
  });

  it('redo 前后原任务记录逐字段零改动（写入只落新 taskId）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath, { taskId: 'task_keep', status: 'failed', executionError: '读取故障。' });
    const before = readTask(dbPath, 'task_keep');

    const recorder: Recorder = { mainInputs: [] };
    const built = await realSession(dbPath, recorder);
    const outcome = await runRedo(redoInput(before, dbPath), {
      assemble: async () => ({ session: built.session, close: built.close }),
    });
    expect(outcome.exitCode).toBe(0);

    const after = readTask(dbPath, 'task_keep');
    expect(after).toEqual(before);
  });
});

describe('tasks --redo：输出与错误码', () => {
  it('成功输出：回复 + 逐字配对行 + 底账行；多新任务一行一个', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath, { taskId: 'task_ok', status: 'completed' });
    const task = readTask(dbPath, 'task_ok');
    const recorder: Recorder = { mainInputs: [] };
    const built = await realSession(dbPath, recorder);
    const outcome = await runRedo(redoInput(task, dbPath), {
      assemble: async () => ({ session: built.session, close: built.close }),
    });
    const newId = listTaskIds(dbPath).find((id) => id !== 'task_ok')!;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(
      `已重新交办并收到汇报。\n\n原任务 #1 → 新任务 #2（状态：未执行）\n`
      + `任务底账：${dbPath}（新任务已写入）\n`,
    );
    // 新任务确实落账（编号=2；原任务编号保持 1）。
    const reopened = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(reopened.get(newId, SCOPE).taskNo).toBe(2);
    expect(reopened.get('task_ok', SCOPE).taskNo).toBe(1);
    reopened.close();
  });

  it('装配门拒绝 → exit 2（话术原样）；装配其它错误 → exit 1；send 失败 → exit 1 且报告已创建的新任务', async () => {
    const base = syntheticTask({ taskId: 'task_x' });

    const refused = await runRedo(redoInput(base, '/nope.db'), {
      assemble: async () => {
        throw new AssemblyRefusedError('未检测到 LLM_API_KEY——重新推进 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。');
      },
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe('未检测到 LLM_API_KEY——重新推进 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。\n');

    const broken = await runRedo(redoInput(base, '/nope.db'), {
      assemble: async () => { throw new Error('装配爆炸'); },
    });
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toBe('重新推进未完成：装配爆炸\n');

    const created = syntheticTask({ taskId: 'task_new', taskNo: 2, status: 'running' });
    let taskCalls = 0;
    const session = {
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      transcript: () => [],
      send: async () => { throw new Error('回合爆炸'); },
      tasks: () => {
        taskCalls += 1;
        return taskCalls === 1 ? [base] : [base, created];
      },
      getTask: () => base,
    } as unknown as Session;
    const half = await runRedo(redoInput(base, '/nope.db'), {
      assemble: async () => ({ session, close: () => {} }),
    });
    expect(half.exitCode).toBe(1);
    expect(half.stdout).toContain('原任务 #1 → 新任务 #2（状态：进行中）');
    expect(half.stderr).toBe('重新推进未完成：回合爆炸\n');

    const chat = await runRedo(redoInput(base, '/nope.db'), {
      assemble: async () => ({
        session: {
          principalId: SCOPE.principalId,
          sessionId: SCOPE.sessionId,
          transcript: () => [],
          send: async () => ({ reply: '本轮没有交办。', taskIds: [], executions: [], progress: [] }),
          tasks: () => [base],
          getTask: () => base,
        } as unknown as Session,
        close: () => {},
      }),
    });
    expect(chat.exitCode).toBe(1);
    expect(chat.stdout).toBe('本轮没有交办。\n');
    expect(chat.stderr).toBe('未达标：本轮没有产生新任务（重新推进未生效）。\n');
    expect(renderRedoPairLine(
      syntheticTask({ taskId: 'task_a', taskNo: 1 }),
      syntheticTask({ taskId: 'task_b', taskNo: 2, status: 'completed' }),
    )).toBe('原任务 #1 → 新任务 #2（状态：已完成）');
  });
});

/** e2e：真实子进程跑 CLI（与 `npm run tasks` 同 flag 形态；LLM_API_KEY 显式置空避免 .env 泄漏）。 */
function runTasks(args: string[], env: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_CONFIG_PATH: '', LLM_API_KEY: '' };
  delete childEnv['DB_PATH'];
  delete childEnv['INIT_CWD'];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', '--import', 'tsx', 'scripts/tasks.ts', ...args],
    { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('tasks --redo：CLI 端到端（确定性拒绝路径，无模型调用）', () => {
  it('running 拒绝 exit 2；未知 id exit 2；无 key 装配门拒绝 exit 2；三者都不产生新任务', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath, { taskId: 'task_done', status: 'completed' });
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 'task_running', ...SCOPE, request: '进行中的任务' });
    registry.close();
    const before = listTaskIds(dbPath);

    const running = runTasks(['task_running', '--redo'], { DB_PATH: dbPath });
    expect(running.status).toBe(2);
    expect(running.stderr).toContain('任务正在进行中，不能重新推进：task_running');
    expect(running.stdout).toBe('');

    const unknown = runTasks(['task_absent', '--redo'], { DB_PATH: dbPath });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('找不到任务：task_absent');

    const missingKey = runTasks(['task_done', '--redo'], { DB_PATH: dbPath });
    expect(missingKey.status).toBe(2);
    expect(missingKey.stderr).toContain('未检测到 LLM_API_KEY——重新推进 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。');

    expect(listTaskIds(dbPath)).toEqual(before);
  });

  it('用法错误 exit 2：--redo 无 id；--redo 与 --out 同用；重复 --redo', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath, { taskId: 'task_done', status: 'completed' });

    const noId = runTasks(['--redo'], { DB_PATH: dbPath });
    expect(noId.status).toBe(2);
    expect(noId.stderr).toContain('--redo 需要与 taskId 一起使用');

    const conflict = runTasks(['task_done', '--redo', '--out', 'x.md'], { DB_PATH: dbPath });
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toContain('--redo 与 --out 不能同时使用');

    const twice = runTasks(['task_done', '--redo', '--redo'], { DB_PATH: dbPath });
    expect(twice.status).toBe(2);
    expect(twice.stderr).toContain('最多接受一个 --redo');
  });
});
