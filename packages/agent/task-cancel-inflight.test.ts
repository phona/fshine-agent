/**
 * 业务级：用户交办一件要跑一阵的活，中途说「别做了」——取消必须**真的中止在飞执行**，
 * 不是只把账本改成 cancelled 让脚本/执行继续跑完。
 *
 * 三个用例对应三条可观察断言：
 *   ① 在飞 `run_js`（先写 out/ 再 sleep）→ 取消：进程被杀（无残留 pid）、取消后不再写
 *      产物、账本终态 `cancelled`（请求 ≠ 已取消，先 requested 后确认）；
 *   ② 在飞执行层调用（挂在 gate 上）→ 取消：该调用不再以 completed 落定、任务终态
 *      `cancelled`；执行层不配合中止时宿主也不等它（中止信号由宿主侧闭合）；
 *   ③ 已完成任务再取消 → 如实返回 `terminal/completed`，绝不把 completed 改写成 cancelled。
 *
 * 接线事实（避免把测试当生产面）：`run_js` 在 Main/Inline Worker 工具面，background
 * Worker 工具面只有 `execute_operation`（见 execution-runtime.ts `createTaskExecutor`）。
 * ① 用**真实受限执行器 + TaskRunner 端口**钉住「取消信号 → 进程组」这条链（执行器与
 * 生产同源）；② 用生产 `createTaskExecutor` 钉住委托路径的信号贯穿；③ 走 Main 的
 * `task_cancel` 工具面，断言机械回执与底账不被改写。
 *
 * 零网络、零真实模型：执行层是 gate/脚本假件，脚本是仓内 Node 受限子进程。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createFileStore, sessionDirOf } from './src/file-store';
import {
  createSession,
  createTaskExecutor,
  EXECUTE_OPERATION_TOOL,
  TASK_CANCEL_TOOL,
  TASK_RUN_TOOL,
} from './src/execution-runtime';
import { createResourcePolicy } from './src/resource-policy';
import { createRunJsExecutor, type RunJsExecutor } from './src/run-js-executor';
import { createTaskRegistry, type TaskRegistry, type TaskScope } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  createTaskRunner,
  type TaskExecutionOutcome,
  type TaskExecutor,
} from './src/task-runner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

const SCOPE: TaskScope = { principalId: 'wecom:biz-cancel', sessionId: 'sess-cancel-inflight' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function abortError(): Error {
  const error = new Error('执行层调用被取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 在飞脚本：先落一个产物 + 自己的 pid，再在 2.5s 后写 late.txt（取消后不得出现），
 * 并保持事件循环 6s（未取消时会一直占着进程）。
 */
const SLOW_RUN_JS = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('out/early.txt', 'early');",
  "fs.writeFileSync('out/pid.txt', String(process.pid));",
  "setTimeout(() => { fs.writeFileSync('out/late.txt', 'late'); }, 2500);",
  "setTimeout(() => {}, 6000);",
].join('\n');

/** 等 run_js 真的起来（pid 文件出现）；返回 run 目录与脚本进程 pid。 */
async function waitForRunPid(runsRoot: string, timeoutMs = 5000): Promise<{ runDir: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(runsRoot)) {
      for (const runId of readdirSync(runsRoot)) {
        const runDir = path.join(runsRoot, runId);
        const pidPath = path.join(runDir, 'out', 'pid.txt');
        if (existsSync(pidPath)) {
          return { runDir, pid: Number(readFileSync(pidPath, 'utf8')) };
        }
      }
    }
    await sleep(20);
  }
  throw new Error('run_js 未在预期时间内启动（没看到 out/pid.txt）。');
}

/** 任务执行器：把一个 run_js 回合当作任务执行（真实受限执行器；信号来自 runner）。 */
function runJsTaskExecutor(runJs: RunJsExecutor): TaskExecutor {
  return {
    async execute(task, context): Promise<TaskExecutionOutcome> {
      const output = await runJs.runJs({
        code: SLOW_RUN_JS,
        scope: { principalId: task.principalId, sessionId: task.sessionId },
        taskId: task.taskId,
        signal: context.signal,
      });
      return output.audit.killReason === 'abort'
        ? { kind: 'cancelled' }
        : { kind: 'completed', resultText: '脚本完成' };
    },
  };
}

/**
 * 挂在 gate 上的执行层调用：resolve 由测试持有（模拟一次迟迟不回的执行层调用）。
 * honorAbort=true 时观察宿主传入的取消信号并以 AbortError 结束（真实适配器的义务）；
 * false 时完全不理信号（证明宿主不依赖执行层配合也不吊死）。
 */
class GatedClient implements ExecutionClient {
  calls = 0;
  aborted = false;
  readonly releases: Array<(outcome: ExecutionOutcome) => void> = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly honorAbort: boolean) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  execute(_request: unknown, options?: { signal?: AbortSignal }): Promise<ExecutionOutcome> {
    this.calls += 1;
    this.signals.push(options?.signal);
    return new Promise<ExecutionOutcome>((resolve, reject) => {
      this.releases.push(resolve);
      const signal = options?.signal;
      if (!this.honorAbort || signal === undefined) return;
      const onAbort = (): void => {
        this.aborted = true;
        reject(abortError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 生产同形的 Worker 回合（只发一次 execute_operation，然后按 abort 结束）。 */
function gatedWorkerDriver(): TurnDriver {
  return {
    async run(input) {
      try {
        await input.exec(EXECUTE_OPERATION_TOOL, { operation: 'dummy.query', args: {} }, input.signal);
      } catch {
        // Pi 原生：工具调用异常转成工具结果；随后本回合按 abort 收尾。
      }
      if (input.signal?.aborted === true) throw abortError();
      return { text: '查询完成', messages: [...input.messages] };
    },
  };
}

function faceClient(): ExecutionClient {
  return {
    async capabilities(): Promise<CapabilityManifest> {
      return MANIFEST;
    },
    async execute(): Promise<ExecutionOutcome> {
      return { status: 'completed', data: {} };
    },
  };
}

interface MainStep {
  calls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

/** 脚本化 Main：逐回合按步骤调工具（结果按调用顺序收集），零模型。 */
function scriptedMainDriver(steps: MainStep[], results: unknown[]): TurnDriver {
  return {
    async run(input) {
      const step = steps.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.calls ?? []) results.push(await input.exec(call.tool, call.args));
      return { text: step.text, messages: [...input.messages] };
    },
  };
}

function submit(runner: ReturnType<typeof createTaskRunner>, taskId: string, request: string): void {
  runner.submit({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
}

describe('取消在飞任务（真的中止执行，不只改账本）', () => {
  it('① 在飞 run_js：取消 → 进程组死、取消后不再写产物、账本 cancelled', async () => {
    const dir = tempDir('task-cancel-runjs-');
    const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
    const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
    const runJs = createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES });
    const policy = createResourcePolicy();
    const runner = createTaskRunner({
      registry,
      policy,
      executor: runJsTaskExecutor(runJs),
      leaseMs: 60_000,
    });
    try {
      submit(runner, 'task_runjs', '跑一个要几秒的脚本，结果写 out/');
      runner.pump();
      expect(runner.inFlight()).toEqual(['task_runjs']);

      // 在飞证据：脚本已跑起来并写了第一个产物（正对照，证明不是没启动）。
      const runsRoot = path.join(sessionDirOf(fileStore.workspaceRoot, SCOPE), 'runs');
      const started = await waitForRunPid(runsRoot);
      expect(existsSync(path.join(started.runDir, 'out', 'early.txt'))).toBe(true);

      // 取消：先「已请求」，确认中止后才 cancelled。
      expect(runner.cancel('task_runjs', SCOPE)).toEqual({ outcome: 'requested', taskId: 'task_runjs' });
      await vi.waitFor(() => {
        expect(registry.get('task_runjs', SCOPE).status).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      const task = registry.get('task_runjs', SCOPE);
      expect(task.status).toBe('cancelled');
      expect(task.reason).toBe('cancelled_by_user');
      // 执行真的停了：脚本进程已不存在，进程表里也没有本 run 的任何残留进程。
      expect(processAlive(started.pid)).toBe(false);
      const ps = execFileSync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' });
      expect(ps).not.toContain(started.runDir);

      // 越过脚本原计划写 late.txt 的时刻（2.5s）：取消之后不得再有产物写入。
      await sleep(3000);
      expect(existsSync(path.join(started.runDir, 'out', 'late.txt'))).toBe(false);
      expect(runner.inFlight()).toEqual([]);
    } finally {
      registry.close();
    }
  });

  it('② 在飞执行层调用（gate，执行层配合中止）：取消后调用不返回 completed、任务终态 cancelled', async () => {
    const dir = tempDir('task-cancel-gate-');
    const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
    const client = new GatedClient(true);
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: gatedWorkerDriver(),
      registry,
      workerTurnMs: 30_000,
    });
    const policy = createResourcePolicy();
    const runner = createTaskRunner({ registry, policy, executor, leaseMs: 60_000 });
    // 业务链：Main 先交办（background 受理）→ 执行层调用在飞 → 用户说「别做了」→ Main 调 task_cancel。
    const results: unknown[] = [];
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      mainDriver: scriptedMainDriver([
        { calls: [{ tool: TASK_RUN_TOOL, args: { task: '查一下 alpha 集合' } }], text: '已受理，后台跑着。' },
        { calls: [{ tool: TASK_CANCEL_TOOL, args: { ref: '#1' } }], text: '好，已请求停止。' },
      ], results),
      workerDriver: {
        async run() {
          throw new Error('（测试）background 派发不应调用 createSession 的 workerDriver');
        },
      },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: registry,
      policy,
      taskDispatch: 'async',
      taskRunner: runner,
      // B 切片：钉 0 窗口（本套件测取消在飞机制；窗口行为由专测覆盖）。
      taskRunWaitMs: 0,
    });
    try {
      await session.send('帮我查 alpha 集合，跑起来别等');
      const receipt = results[0] as { taskId: string; accepted: boolean };
      // B 切片回执去编号：受理回执不带 taskNo（编号只在详情面）。
      expect(receipt).toMatchObject({ accepted: true });
      expect(receipt).not.toHaveProperty('taskNo');

      // 在飞：执行层调用已发起、gate 未回。
      await vi.waitFor(() => {
        expect(client.calls).toBe(1);
        expect(registry.get(receipt.taskId, SCOPE).status).toBe('running');
      }, { timeout: 5000 });

      await session.send('算了别做了，取消掉');
      // 机械回执：请求 ≠ 已取消（先 requested，确认中止后才 cancelled）。
      // 2026-11-18：取消回执新增 taskNo / taskRequest（供核对是否指错任务），改成子集断言 + 身份断言。
      expect(results[1]).toMatchObject({ outcome: 'requested', taskId: receipt.taskId });
      const cancelReceipt = results[1] as unknown as { taskNo?: number; taskRequest?: string; userMessage?: string };
      expect(cancelReceipt.taskNo).toBe(1);
      expect(cancelReceipt.taskRequest).toContain('alpha');
      // 用户可读的一句话：含业务对象 + 编号 + 结果（2026-11-18 owner 要求，不许只给裸编号）。
      expect(cancelReceipt.userMessage).toContain('alpha');
      expect(cancelReceipt.userMessage).toContain('编号 1');
      expect(cancelReceipt.userMessage).toMatch(/已请求停止|已停止/);
      // 创建时间随回执给出：历史结论转述时能说"11-18 开的"，不与"刚才"混淆。
      expect((cancelReceipt as unknown as { taskCreatedAt?: string }).taskCreatedAt).toMatch(/T/);

      await vi.waitFor(() => {
        expect(registry.get(receipt.taskId, SCOPE).status).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      const task = registry.get(receipt.taskId, SCOPE);
      expect(task.status).toBe('cancelled');
      expect(task.reason).toBe('cancelled_by_user');
      // 中止信号真的到达执行层调用（不是宿主自己假想取消）。
      expect(client.aborted).toBe(true);
      expect(client.signals[0]?.aborted).toBe(true);
      // 这次调用没有以 completed 落进执行事实。
      expect(task.executions.filter((execution) => execution.status === 'completed')).toEqual([]);
      expect(runner.inFlight()).toEqual([]);
    } finally {
      registry.close();
    }
  });

  it('②b 执行层不配合中止（gate 永不回应）：宿主仍能终结为 cancelled，不吊死在取消上', async () => {
    const dir = tempDir('task-cancel-stubborn-');
    const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
    const client = new GatedClient(false);
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: gatedWorkerDriver(),
      registry,
      workerTurnMs: 30_000,
    });
    const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
    try {
      submit(runner, 'task_stubborn', '查一下 beta 集合');
      runner.pump();
      await vi.waitFor(() => expect(client.calls).toBe(1), { timeout: 5000 });

      expect(runner.cancel('task_stubborn', SCOPE)).toEqual({ outcome: 'requested', taskId: 'task_stubborn' });
      await vi.waitFor(() => {
        expect(registry.get('task_stubborn', SCOPE).status).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      // 迟到的 gate「completed」不得把任务改回 completed、也不得落成执行事实。
      for (const release of client.releases) release({ status: 'completed', data: { rows: 2 } });
      await sleep(50);
      const task = registry.get('task_stubborn', SCOPE);
      expect(task.status).toBe('cancelled');
      expect(task.reason).toBe('cancelled_by_user');
      expect(task.executions.filter((execution) => execution.status === 'completed')).toEqual([]);
      expect(runner.inFlight()).toEqual([]);
    } finally {
      registry.close();
    }
  });

  it('③ 已完成任务再取消：如实返回 terminal/completed，不把 completed 改成 cancelled', async () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 'task_done', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '查 alpha' });
    registry.noteExecution('task_done', {
      requestId: 'req_done',
      operation: 'dummy.query',
      status: 'completed',
    });
    registry.complete('task_done', '查到 2 条。');

    const results: unknown[] = [];
    const mainDriver: TurnDriver = {
      async run(input) {
        results.push(await input.exec(TASK_CANCEL_TOOL, { ref: '#1' }));
        return { text: '该任务已经完成，不能取消。', messages: input.messages };
      },
    };
    const runner = createTaskRunner({
      registry,
      policy: createResourcePolicy(),
      executor: { async execute(): Promise<TaskExecutionOutcome> { return { kind: 'completed', resultText: 'x' }; } },
    });
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: faceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      mainDriver,
      workerDriver: {
        async run() {
          throw new Error('（测试）该 driver 不应被调用');
        },
      },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: registry,
      taskRunner: runner,
    });

    await session.send('把 #1 取消掉');

    // 机械回执：终态任务无操作，原样给出 completed（模型不得据此宣称已取消）。
    // 同上：回执带身份，断言改为子集 + 身份存在。
    expect(results[0]).toMatchObject({ outcome: 'terminal', taskId: 'task_done', status: 'completed' });
    expect((results[0] as unknown as { taskNo?: number }).taskNo).toBeTypeOf('number');
    // 终态：用户可见话术必须说"没停成 + 已完成"，不能只说"已取消"。
    expect((results[0] as unknown as { userMessage?: string }).userMessage).toContain('没停成');
    expect((results[0] as unknown as { userMessage?: string }).userMessage).toContain('completed');
    const task = registry.get('task_done', SCOPE);
    expect(task.status).toBe('completed');
    expect(task.reason).toBeUndefined();
    expect(task.resultText).toBe('查到 2 条。');
  });
});
