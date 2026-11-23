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
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from './testing/task-facts';
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
        : { kind: 'ended', report: '脚本完成' };
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
  /** args 可为函数：按上一回合收集到的结果动态解析（如用受理回执的 taskId 引用任务）。 */
  calls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> | ((results: readonly unknown[]) => Record<string, unknown>) }>;
  text: string;
}

/** 脚本化 Main：逐回合按步骤调工具（结果按调用顺序收集），零模型。 */
function scriptedMainDriver(steps: MainStep[], results: unknown[]): TurnDriver {
  return {
    async run(input) {
      const step = steps.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.calls ?? []) {
        const args = typeof call.args === 'function' ? call.args(results) : call.args;
        results.push(await input.exec(call.tool, args));
      }
      return { text: step.text, messages: [...input.messages] };
    },
  };
}

/**
 * 2026-11-20 机制变化：数字 ref（#1）退役，取消改用受理回执里的真实 taskId。
 * 脚本按上一回合 results[0] 的 taskId 动态取引用，断言强度不变（仍取消同一任务）。
 */
function taskIdRefFrom(results: readonly unknown[]): Record<string, unknown> {
  const receipt = results[0] as { taskId?: unknown } | undefined;
  if (typeof receipt?.taskId !== 'string') throw new Error('（测试）受理回执没有 taskId，无法按 taskId 取消');
  return { ref: receipt.taskId };
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
        expect(registry.get('task_runjs', SCOPE).termination?.kind).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      const task = registry.get('task_runjs', SCOPE);
      expect(task.termination?.kind).toBe('cancelled');
      expect(task.termination?.kind).toBe('cancelled');
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
        // 2026-11-20：数字 ref 退役，按受理回执的 taskId 取消。
        { calls: [{ tool: TASK_CANCEL_TOOL, args: taskIdRefFrom }], text: '好，已请求停止。' },
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
        expect(taskLivenessOf(registry.get(receipt.taskId, SCOPE))).toBe('running');
      }, { timeout: 5000 });

      await session.send('算了别做了，取消掉');
      // 机械回执：请求 ≠ 已取消（先 requested，确认中止后才 cancelled）。
      // 2026-11-18：取消回执新增 taskNo / taskRequest（供核对是否指错任务），改成子集断言 + 身份断言。
      expect(results[1]).toMatchObject({ outcome: 'requested', taskId: receipt.taskId });
      const cancelReceipt = results[1] as unknown as { taskRequest?: string; userMessage?: string };
      // 2026-11-20：取消回执是模型可见投影，不带 taskNo（底账仍有）；以任务引用/业务名指代。
      expect(cancelReceipt).not.toHaveProperty('taskNo');
      expect(cancelReceipt.taskRequest).toContain('alpha');
      // 用户可读的一句话：含业务对象 + 结果（2026-11-20：任务编号属工单腔，不进用户面）。
      // 断言锚点从「编号 1」改成「不带编号」——原断言断的是用户可见面出现编号，该行为已废。
      expect(cancelReceipt.userMessage).toContain('alpha');
      expect(cancelReceipt.userMessage).not.toMatch(/#\d+|编号\s*#?\d+/);
      expect(cancelReceipt.userMessage).toMatch(/已请求停止|已停止/);
      // 创建时间随回执给出：历史结论转述时能说"11-18 开的"，不与"刚才"混淆。
      expect((cancelReceipt as unknown as { taskCreatedAt?: string }).taskCreatedAt).toMatch(/T/);

      await vi.waitFor(() => {
        expect(registry.get(receipt.taskId, SCOPE).termination?.kind).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      const task = registry.get(receipt.taskId, SCOPE);
      expect(task.termination?.kind).toBe('cancelled');
      expect(task.termination?.kind).toBe('cancelled');
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
        expect(registry.get('task_stubborn', SCOPE).termination?.kind).toBe('cancelled');
      }, { timeout: 5000 });
      await runner.whenIdle();

      // 迟到的 gate「completed」不得把任务改回 completed、也不得落成执行事实。
      for (const release of client.releases) release({ status: 'completed', data: { rows: 2 } });
      await sleep(50);
      const task = registry.get('task_stubborn', SCOPE);
      expect(task.termination?.kind).toBe('cancelled');
      expect(task.termination?.kind).toBe('cancelled');
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
    registry.setResultText('task_done', '查到 2 条。');

    const results: unknown[] = [];
    const mainDriver: TurnDriver = {
      async run(input) {
        // 2026-11-20：数字 ref 退役，按真实 taskId 取消。
        results.push(await input.exec(TASK_CANCEL_TOOL, { ref: 'task_done' }));
        return { text: '该任务已经完成，不能取消。', messages: input.messages };
      },
    };
    const runner = createTaskRunner({
      registry,
      policy: createResourcePolicy(),
      executor: { async execute(): Promise<TaskExecutionOutcome> { return { kind: 'ended', report: 'x' }; } },
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

    // 机械回执：终态任务无操作，原样给出真实终止种类（模型不得据此宣称已取消）。
    // 同上：回执带身份，断言改为子集 + 身份存在。
    expect(results[0]).toMatchObject({ outcome: 'terminal', taskId: 'task_done', settled: 'completed' });
    expect(results[0]).not.toHaveProperty('taskNo');
    // 终态：用户可见话术必须说"没停成 + 已完成"（真实种类），不能只说"已取消"。
    expect((results[0] as unknown as { userMessage?: string }).userMessage).toContain('没停成');
    expect((results[0] as unknown as { userMessage?: string }).userMessage).toContain('已完成');
    expect((results[0] as unknown as { userMessage?: string }).userMessage).not.toContain('已取消');
    const task = registry.get('task_done', SCOPE);
    expect(lastExecutionOf(task)?.status).toBe('completed');
    expect(lastFailureOf(task)).toBeUndefined();
    expect(task.resultText).toBe('查到 2 条。');
  });

  it('④ 已结束任务（各终止种类）再取消：回执按真实种类说，不统一「已经办完了」、不改写终止事件', async () => {
    // 反向绊线：把回执改回统一 `没停成：… 已经办完了`（或把 settled 固定成 completed）→ 本用例红。
    const cases: ReadonlyArray<{
      kind: 'completed' | 'round_failed' | 'died' | 'timed_out' | 'resource_limited' | 'cancelled';
      word: RegExp;
      seed: (registry: TaskRegistry, taskId: string) => void;
    }> = [
      {
        kind: 'completed',
        word: /已完成/,
        seed: (registry, taskId) => {
          registry.noteExecution(taskId, { requestId: 'req_done', operation: 'dummy.query', status: 'completed' });
          registry.setResultText(taskId, '查到 2 条。');
        },
      },
      { kind: 'round_failed', word: /已失败/, seed: (registry, taskId) => registry.noteRoundFailed(taskId) },
      { kind: 'died', word: /结果未知/, seed: (registry, taskId) => registry.markDied(taskId) },
      { kind: 'timed_out', word: /已超时/, seed: (registry, taskId) => registry.markTimedOut(taskId, 'execution') },
      { kind: 'resource_limited', word: /资源拒绝/, seed: (registry, taskId) => registry.markResourceLimited(taskId) },
      { kind: 'cancelled', word: /已取消/, seed: (registry, taskId) => registry.markCancelled(taskId, { scope: SCOPE }) },
    ];
    for (const testCase of cases) {
      const registry = createTaskRegistry();
      const taskId = `task_terminal_${testCase.kind}`;
      registry.begin({
        taskId,
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        request: `办 ${testCase.kind} 的事`,
      });
      testCase.seed(registry, taskId);
      const results: unknown[] = [];
      const mainDriver: TurnDriver = {
        async run(input) {
          results.push(await input.exec(TASK_CANCEL_TOOL, { ref: taskId }));
          return { text: '查过了，按事实说。', messages: input.messages };
        },
      };
      const runner = createTaskRunner({
        registry,
        policy: createResourcePolicy(),
        executor: { async execute(): Promise<TaskExecutionOutcome> { return { kind: 'ended', report: 'x' }; } },
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
      await session.send(`把 ${taskId} 取消掉`);

      const receipt = results[0] as { outcome?: string; settled?: string; userMessage?: string };
      expect(receipt.outcome, testCase.kind).toBe('terminal');
      // 真实终止种类原样交给模型；用户可见话术按种类说（不再统一「已经办完了」）。
      expect(receipt.settled, testCase.kind).toBe(testCase.kind);
      expect(receipt.userMessage, testCase.kind).toMatch(testCase.word);
      expect(receipt.userMessage, testCase.kind).not.toContain('已经办完了');
      if (testCase.kind !== 'completed') expect(receipt.userMessage, testCase.kind).not.toMatch(/办完/);
      // 终止事实不被取消调用改写。
      expect(registry.get(taskId, SCOPE).termination?.kind, testCase.kind).toBe(testCase.kind);
    }
  });

  it('⑤ 在飞取消窗口内落定为失败（结果未知）：回执按 died 说，回合不把失败终态记成 completed 观察', async () => {
    const registry = createTaskRegistry();
    // 中止后不确认取消，而是以「结果未知」落定（执行端可能已发生副作用的真实形状）。
    const executor: TaskExecutor = {
      async execute(_task, context): Promise<TaskExecutionOutcome> {
        return await new Promise<TaskExecutionOutcome>((resolve) => {
          context.signal.addEventListener('abort', () => resolve({ kind: 'result_unknown' }));
        });
      },
    };
    const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
    const results: unknown[] = [];
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: faceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      mainDriver: scriptedMainDriver([
        { calls: [{ tool: TASK_RUN_TOOL, args: { task: '查一下 alpha 集合' } }], text: '已受理。' },
        { calls: [{ tool: TASK_CANCEL_TOOL, args: taskIdRefFrom }], text: '好，我看看停没停。' },
      ], results),
      workerDriver: {
        async run() {
          throw new Error('（测试）background 派发不应调用 createSession 的 workerDriver');
        },
      },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: registry,
      policy: createResourcePolicy(),
      taskDispatch: 'async',
      taskRunner: runner,
      // 窗口 > 0：取消请求在回合内等到「结果未知」落定。
      taskRunWaitMs: 1_500,
    });
    await session.send('帮我查 alpha 集合，跑起来别等');
    const turn = await session.send('算了别做了，取消掉');

    const receipt = results[1] as { outcome?: string; settled?: string; userMessage?: string };
    // 回执按真实终止种类说（died = 结果未知），不冒充已停、不统一「已经办完了」。
    expect(receipt.outcome).toBe('terminal');
    expect(receipt.settled).toBe('died');
    expect(receipt.userMessage).toContain('结果未知');
    expect(receipt.userMessage).not.toContain('已经办完了');
    // 反向绊线：把窗口内落定的失败终态记成 completed 观察 → 这里变成 [{kind:'completed'}]，必红。
    expect(turn.terminalObservedInTurn ?? []).toEqual([]);
    expect(registry.get((results[0] as { taskId: string }).taskId, SCOPE).termination?.kind).toBe('died');
  });
});
