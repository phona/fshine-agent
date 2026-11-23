/**
 * 长任务异步（契约 v4）端到端测试：accepted → 回合结束/释放槽位 → wait 长轮询 →
 * 唤醒 Worker 续跑 / 重启续等 / 用户 abort / 协议违约 fail-closed。
 *
 * 全部零网络、零真实等待：
 *   · 执行层 = 脚本化假客户端（第一回合返回 accepted，后续只经 wait 端口推进）；
 *   · 等待端口 = 手动控制的假 wait（测试显式 resolve accepted/completed/failed）；
 *   · 时钟 = 注入 now + 假定时器（不真 sleep）；
 *   · 重启用例 = 同一临时 SQLite 文件：关库 → 重新打开 → 新 runner 从 bottom ledger
 *     的 accepted 行重建等待（不是复用上一进程的内存表）。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from './testing/task-facts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutor, type ExecutionEvent } from './src/execution-runtime';
import type { TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver-contract';
import type { FileStore } from './src/file-store';
import { createFileStore } from './src/file-store';
import { createTaskExecutionBridge } from './src/task-file-bridge';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import {
  createTaskRunner,
  type LongTaskWaitPort,
  type LongTaskWaitResult,
  type ResourcePermit,
  type ResourcePolicyPort,
  type RunnerTimers,
  type TaskRunner,
} from './src/task-runner';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'p', sessionId: 's' } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 纯内存可控时钟（runner 的 nextDue 判定用）。 */
class Clock {
  now = 1_000_000;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** 不自动触发的假定时器（pump 由测试显式调用）。 */
class ManualTimers implements RunnerTimers {
  readonly armed: Array<{ delay: number }> = [];
  set(_callback: () => void, delayMs: number): unknown {
    this.armed.push({ delay: delayMs });
    return this.armed.length;
  }
  clear(): void {
    // 测试里不真触发；clear 不需要动作。
  }
}

/** 并发上限 1 的许可假件（证明 accepted 后槽位真的被释放）。 */
class CapPolicy implements ResourcePolicyPort {
  active = 0;
  readonly limit = 1;
  acquire(kind: 'foreground' | 'background'): ResourcePermit | { reason: 'queue_full' } {
    if (this.active >= this.limit) return { reason: 'queue_full' };
    this.active += 1;
    return { kind, state: 'active' };
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
  cancelQueued(): void {}
}

/** 手动 wait 端口：每次 wait 挂起，直到测试显式 resolve/reject。 */
class ManualLongTasks implements LongTaskWaitPort {
  readonly waits: Array<{
    operationId: string;
    timeoutMs: number;
    resolve: (result: LongTaskWaitResult) => void;
    reject: (error: Error) => void;
  }> = [];
  readonly aborts: string[] = [];
  abortResult: { aborted: boolean; reason?: string } = { aborted: true };
  timeoutMs = 30_000;
  pollAfterMs = 250;

  wait(operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<LongTaskWaitResult> {
    return new Promise((resolve, reject) => {
      const abortError = (): Error => {
        const error = new Error('wait aborted');
        error.name = 'AbortError';
        return error;
      };
      if (signal?.aborted === true) {
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      this.waits.push({ operationId, timeoutMs, resolve, reject });
    });
  }

  async abort(operationId: string): Promise<{ aborted: boolean; reason?: string }> {
    this.aborts.push(operationId);
    return this.abortResult;
  }
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    { name: 'dummy.longtask', label: 'long task', args: [], long_running: true },
    { name: 'dummy.query', label: 'query', args: [] },
  ],
};

/** 脚本化执行层：execute 只被调用一次（续跑不允许重复发起同一 operation）。 */
class ScriptedClient implements ExecutionClient {
  readonly executeCalls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  constructor(
    private readonly manifest: CapabilityManifest = MANIFEST,
    private readonly acceptedOperation = 'dummy.longtask',
  ) {}
  async capabilities(): Promise<CapabilityManifest> {
    return this.manifest;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.executeCalls.push({ operation: request.operation, args: { ...request.args } });
    if (request.operation === this.acceptedOperation) {
      return { status: 'accepted', operationId: 'op-1', pollAfterMs: 250 };
    }
    return { status: 'completed', data: { collection: 'documents', count: 1 } };
  }
}

function delegationOf(input: TurnDriverInput): string {
  const message = input.messages[input.messages.length - 1];
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : '')).join('\n');
  }
  return '';
}

/**
 * 脚本化 Worker：
 *   · 首轮 LONG 任务 → 发起 dummy.longtask（accepted）；
 *   · 首轮 SHORT 任务 → 发起 dummy.query（completed）；
 *   · 续跑（委派含「长任务结果」）→ 不再发起任何执行，只汇报核对结论。
 */
class ScriptedWorker implements TurnDriver {
  readonly rounds: Array<{ delegation: string; resumed: boolean }> = [];
  readonly execResults: unknown[] = [];
  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    const delegation = delegationOf(input);
    const resumed = delegation.includes('## 长任务结果');
    this.rounds.push({ delegation, resumed });
    if (resumed) return { text: '已核对长任务结果并完成。', messages: input.messages };
    if (delegation.includes('LONG')) {
      this.execResults.push(await input.exec('execute_operation', { operation: 'dummy.longtask', args: { seconds: 30 } }));
      return { text: '已发起长任务。', messages: input.messages };
    }
    if (delegation.includes('SHORT')) {
      this.execResults.push(await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'documents' } }));
      return { text: '查询完成。', messages: input.messages };
    }
    return { text: '无执行。', messages: input.messages };
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  registry: TaskRegistry;
  policy: CapPolicy;
  client: ScriptedClient;
  driver: ScriptedWorker;
  longTasks: ManualLongTasks;
  runner: TaskRunner;
  clock: Clock;
  events: ExecutionEvent[];
}

async function makeHarness(options: {
  registry?: TaskRegistry;
  client?: ScriptedClient;
  driver?: ScriptedWorker;
  longTasks?: ManualLongTasks;
  clock?: Clock;
} = {}): Promise<Harness> {
  const registry = options.registry ?? createTaskRegistry();
  const clock = options.clock ?? new Clock();
  const client = options.client ?? new ScriptedClient();
  const driver = options.driver ?? new ScriptedWorker();
  const longTasks = options.longTasks ?? new ManualLongTasks();
  const events: ExecutionEvent[] = [];
  const policy = new CapPolicy();
  const executor = await createTaskExecutor({
    client,
    allowedOperations: ['dummy.longtask', 'dummy.query'],
    workerDriver: driver,
    registry,
    now: () => clock.now,
    onExecutionEvent: (event) => events.push(event),
  });
  const runner = createTaskRunner({
    registry,
    policy,
    executor,
    now: () => new Date(clock.now),
    timers: new ManualTimers(),
    longTasks,
    log: (line) => {
      if (typeof line['event'] === 'string' && line['event'].startsWith('execution_')) {
        events.push(line as unknown as ExecutionEvent);
      }
    },
  });
  return { registry, policy, client, driver, longTasks, runner, clock, events };
}

function submit(runner: TaskRunner, taskId: string, request: string): void {
  runner.submit({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
  runner.pump();
}

describe('长任务异步（契约 v4）', () => {
  it('① accepted → 回合结束、槽位释放（其它任务立刻能跑）；wait 完成 → Worker 续跑、任务 completed', async () => {
    const h = await makeHarness();
    submit(h.runner, 'A', 'LONG 浏览器导出');
    await flush();
    await flush();
    // accepted 不是失败：任务保持 running，租约与并发槽都已释放。
    expect(taskMayBeRunningOf(h.registry.get('A', SCOPE))).toBe(true);
    expect(h.registry.get('A', SCOPE).leaseUntil).toBeUndefined();
    expect(h.policy.active).toBe(0);
    expect(h.driver.rounds.filter((round) => !round.resumed)).toHaveLength(1);
    await flush();
    expect(h.longTasks.waits).toHaveLength(1);
    expect(h.longTasks.waits[0]!.operationId).toBe('op-1');

    // 槽位确实空出来了：另一笔任务立刻跑完。
    submit(h.runner, 'B', 'SHORT 查询');
    await flush();
    expect(archivedReportOf(h.registry.get('B', SCOPE)) !== undefined || (archivedReportOf(h.registry.get('B', SCOPE)) !== undefined || lastExecutionOf(h.registry.get('B', SCOPE))?.status === 'completed')).toBe(true);
    expect(taskMayBeRunningOf(h.registry.get('A', SCOPE))).toBe(true);

    // wait 完成 → 唤醒 Worker 续跑（同一任务、不重复发起 operation）。
    h.clock.advance(5_000);
    h.longTasks.waits[0]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '长任务完成', files: [], logs: [] } },
    });
    await flush();
    await h.runner.whenIdle();

    expect(archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || (archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || lastExecutionOf(h.registry.get('A', SCOPE))?.status === 'completed')).toBe(true);
    expect(h.driver.rounds.some((round) => round.resumed)).toBe(true);
    expect(h.client.executeCalls.filter((call) => call.operation === 'dummy.longtask')).toHaveLength(1);
    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'execution_accepted', operationId: 'op-1' }),
      expect.objectContaining({ event: 'execution_wait_resumed', operationId: 'op-1' }),
    ]));
  });

  it('② wait 超窗（accepted）→ 任务仍 running、按 pollAfterMs 重排；第二次 wait 完成', async () => {
    const h = await makeHarness();
    submit(h.runner, 'A', 'LONG 导出');
    await flush();
    await flush();
    expect(h.longTasks.waits).toHaveLength(1);
    expect(h.longTasks.waits[0]!.timeoutMs).toBe(30_000);

    h.longTasks.waits[0]!.resolve({
      status: 'accepted',
      pollAfterMs: 250,
      outcome: { status: 'accepted', operationId: 'op-1', pollAfterMs: 250 },
    });
    await flush();
    expect(taskMayBeRunningOf(h.registry.get('A', SCOPE))).toBe(true);
    expect(h.longTasks.waits).toHaveLength(1); // 还没到点

    h.clock.advance(250);
    h.runner.pump();
    await flush();
    expect(h.longTasks.waits).toHaveLength(2);
    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'execution_wait_timeout', operationId: 'op-1' }),
    ]));

    h.longTasks.waits[1]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '第二次完成' } },
    });
    await flush();
    await h.runner.whenIdle();
    expect(archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || (archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || lastExecutionOf(h.registry.get('A', SCOPE))?.status === 'completed')).toBe(true);
  });

  it('③ abort → 任务写结束事实且不再被 wait 唤醒；停不下来时仍在推进（有活 worker）', async () => {
    const h = await makeHarness();
    submit(h.runner, 'A', 'LONG 导出');
    await flush();
    await flush();

    expect(h.runner.cancel('A').outcome).toBe('requested');
    await h.runner.whenIdle();
    expect(h.longTasks.aborts).toEqual(['op-1']);
    expect(h.registry.get('A', SCOPE).endedAt).toBeTruthy();
    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'execution_aborted', operationId: 'op-1', result: 'cancelled' }),
    ]));

    // 取消后重排也不会再 wait（等待项已摘除、任务终态）。
    h.clock.advance(10_000);
    h.runner.pump();
    await flush();
    expect(h.longTasks.waits).toHaveLength(1);

    // 停不下来：不得宣称取消，回 running 并记 failed 事件。
    const h2 = await makeHarness();
    h2.longTasks.abortResult = { aborted: false, reason: '执行层拒绝中止' };
    submit(h2.runner, 'A', 'LONG 导出');
    await flush();
    await flush();
    expect(h2.runner.cancel('A').outcome).toBe('requested');
    await h2.runner.whenIdle();
    expect(taskMayBeRunningOf(h2.registry.get('A', SCOPE))).toBe(true);
    expect(h2.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'execution_aborted', operationId: 'op-1', result: 'failed' }),
    ]));
    h2.clock.advance(250);
    h2.runner.pump();
    await flush();
    expect(h2.longTasks.waits.length).toBeGreaterThanOrEqual(2);
  });

  it('④ 重启：关库重开，新 runner 从底账 accepted 行重新 wait → 续跑 completed，且不重复发起', async () => {
    const dbPath = path.join(tempDir('long-task-restart-'), 'tasks.sqlite');
    const clock = new Clock();
    const driver = new ScriptedWorker();
    const client = new ScriptedClient();

    const registry1 = createSqliteTaskRegistry(dbPath);
    const h1 = await makeHarness({ registry: registry1, clock, driver, client });
    submit(h1.runner, 'A', 'LONG 重启导出');
    await flush();
    await flush();
    expect(taskMayBeRunningOf(registry1.get('A', SCOPE))).toBe(true);
    expect(registry1.listAcceptedOperations()).toHaveLength(1);
    expect(h1.longTasks.waits).toHaveLength(1);
    registry1.close(); // 模拟进程退出：wait 结果永远不会回来

    const registry2 = createSqliteTaskRegistry(dbPath);
    const longTasks2 = new ManualLongTasks();
    const h2 = await makeHarness({ registry: registry2, clock, driver, client, longTasks: longTasks2 });
    expect(registry2.listAcceptedOperations()).toHaveLength(1);
    h2.runner.pump();
    await flush();
    expect(longTasks2.waits).toHaveLength(1);
    expect(longTasks2.waits[0]!.operationId).toBe('op-1');

    longTasks2.waits[0]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '重启后完成' } },
    });
    await flush();
    await h2.runner.whenIdle();
    expect(archivedReportOf(registry2.get('A', SCOPE)) !== undefined || (archivedReportOf(registry2.get('A', SCOPE)) !== undefined || lastExecutionOf(registry2.get('A', SCOPE))?.status === 'completed')).toBe(true);
    const resumed = driver.rounds.filter((round) => round.resumed);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.delegation).toContain('续跑·上下文重建');
    // 续跑注记说清「上一回合已发起过」：执行层总共只被调用一次。
    expect(client.executeCalls).toHaveLength(1);
    registry2.close();
  });

  it('⑤b 声明了长任务但装配没给等待端口 → 落 failed + 结构化事件（告警面），不给用户编话', async () => {
    // 2026-11-19 只读审计 #3：这是**装配面缺陷**（部署漏接 wait/abort），用户做不了什么——
    // 按 owner 的失败归宿规则归第 3 档「告警/开发介入」：落终态 + 一条可供部署侧告警面
    // （`npm run alerts` 的 host_fault 规则认这个事件名）识别的事件，不投用户话术。
    const client = new ScriptedClient(MANIFEST, 'dummy.longtask');
    const driver = new ScriptedWorker();
    const registry = createTaskRegistry();
    const logs: Array<Record<string, unknown>> = [];
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.longtask'],
      workerDriver: driver,
      registry,
      now: () => 1_000_000,
    });
    const runner = createTaskRunner({
      registry,
      policy: new CapPolicy(),
      executor,
      now: () => new Date(1_000_000),
      timers: new ManualTimers(),
      // 故意不给 longTasks：accepted 无处推进 = 装配错误。
      log: (line) => logs.push(line),
    });
    submit(runner, 'A', 'LONG 导出');
    await flush();
    await runner.whenIdle();

    // 装配缺陷：追加「结果未知」终止事件（died），末条执行仍是 accepted 不冒充完成。
    expect(registry.get('A', SCOPE).endedAt).toBeTruthy();
    expect(archivedReportOf(registry.get('A', SCOPE))).toBeUndefined();
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'task_long_task_unsupported', taskId: 'A' }),
    ]));
    // 不重复发起（执行层只被调一次；也没有任何续跑回合）。
    expect(client.executeCalls).toHaveLength(1);
    expect(driver.rounds).toHaveLength(1);
  });

  it('⑤ 未声明 long_running 的 operation 返回 accepted → fail-closed（落 failed + 事件）', async () => {
    const declaredPlain: CapabilityManifest = {
      contractVersion: 4,
      operations: [{ name: 'dummy.query', label: 'query', args: [] }],
    };
    const client = new ScriptedClient(declaredPlain, 'dummy.query');
    const driver = new ScriptedWorker();
    const registry = createTaskRegistry();
    const events: ExecutionEvent[] = [];
    const policy = new CapPolicy();
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query'],
      workerDriver: driver,
      registry,
      now: () => 1_000_000,
      onExecutionEvent: (event) => events.push(event),
    });
    const runner = createTaskRunner({
      registry,
      policy,
      executor,
      now: () => new Date(1_000_000),
      timers: new ManualTimers(),
      longTasks: new ManualLongTasks(),
    });
    submit(runner, 'A', 'SHORT 查询');
    await flush();
    await runner.whenIdle();

    expect(['failed', 'refused']).toContain(lastExecutionOf(registry.get('A', SCOPE))?.status);
    expect(lastFailureOf(registry.get('A', SCOPE))?.error?.message).toContain('数据异常');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'execution_accepted_undeclared', operation: 'dummy.query' }),
    ]));
    expect(events.some((event) => event['event'] === 'execution_accepted')).toBe(false);
  });

  it('⑧ wait 返回失败 → 唤醒 Worker 并注入「失败了：<reason>」注记；任务如实 failed、不重复发起', async () => {
    const h = await makeHarness();
    submit(h.runner, 'A', 'LONG 失败导出');
    await flush();
    await flush();
    h.longTasks.waits[0]!.resolve({
      status: 'failed',
      outcome: { status: 'failed', error: { code: 'LONG_TASK_FAILED', message: '执行层失败说明' } },
    });
    await flush();
    await h.runner.whenIdle();

    expect(['failed', 'refused']).toContain(lastExecutionOf(h.registry.get('A', SCOPE))?.status);
    expect(lastFailureOf(h.registry.get('A', SCOPE))?.error?.message).toContain('执行层失败说明');
    const resumed = h.driver.rounds.find((round) => round.resumed);
    expect(resumed?.delegation).toContain('失败了：执行层失败说明');
    expect(resumed?.delegation).toContain('不要盲目重试');
    expect(h.client.executeCalls).toHaveLength(1);
  });

  it('⑥ 普通 operation 路径零变化（completed 逐字、无长任务事件、槽位正常释放）', async () => {
    const h = await makeHarness();
    submit(h.runner, 'B', 'SHORT 查询');
    await flush();
    await h.runner.whenIdle();
    const task = h.registry.get('B', SCOPE);
    expect(archivedReportOf(task) !== undefined || (archivedReportOf(task) !== undefined || lastExecutionOf(task)?.status === 'completed')).toBe(true);
    expect(task.resultText).toBeUndefined();
    expect(task.replyText).toBe('查询完成。');
    expect(task.executions.map((execution) => execution.status)).toEqual(['completed']);
    expect(h.policy.active).toBe(0);
    expect(h.longTasks.waits).toHaveLength(0);
    expect(h.events.filter((event) => event['event'] !== undefined && String(event['event']).startsWith('execution_'))).toHaveLength(0);
  });

  it('⑨ wait 连续出站失败 → 指数退避重排（封顶 60s），任务保持 running 不判死', async () => {
    const h = await makeHarness();
    submit(h.runner, 'A', 'LONG 导出');
    await flush();
    await flush();
    expect(h.longTasks.waits).toHaveLength(1);

    // runner 的等待推进事件走 log 出口（不是执行器的 ExecutionEvent 联合），按字符串取。
    const retries = (): Array<{ failures: number; delayMs: number }> => h.events
      .filter((event) => String(event['event']) === 'execution_wait_retry')
      .map((event) => {
        const line = event as unknown as { failures: number; delayMs: number };
        return { failures: line.failures, delayMs: line.delayMs };
      });

    // 执行层一直不可达：每次失败都退避，任务事实保持 running（结果只能由 wait 终态落定）。
    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const waits = h.longTasks.waits.length;
      h.longTasks.waits[waits - 1]!.reject(new Error('executor unreachable'));
      await flush();
      const seen = retries();
      expect(seen).toHaveLength(attempt + 1);
      expect(seen[attempt]!.failures).toBe(attempt + 1);
      delays.push(seen[attempt]!.delayMs);
      expect(taskMayBeRunningOf(h.registry.get('A', SCOPE))).toBe(true);
      // 退避到期才重排下一次 wait（到期前 pump 不应再打执行层）。
      h.clock.advance(seen[attempt]!.delayMs - 1);
      h.runner.pump();
      await flush();
      expect(h.longTasks.waits).toHaveLength(waits);
      h.clock.advance(1);
      h.runner.pump();
      await flush();
      expect(h.longTasks.waits).toHaveLength(waits + 1);
    }

    // 250 → 500 → 1000 … 单调翻倍到 60s 封顶，之后不再增长（不按秒打执行层）。
    expect(delays.slice(0, 4)).toEqual([250, 500, 1000, 2000]);
    expect(delays[delays.length - 1]).toBe(60_000);
    expect(Math.max(...delays)).toBe(60_000);

    // 恢复后取到终态：退避计数清零，任务照常完成。
    h.longTasks.waits[h.longTasks.waits.length - 1]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '导出完成' } },
    });
    await flush();
    await h.runner.whenIdle();
    expect(archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || (archivedReportOf(h.registry.get('A', SCOPE)) !== undefined || lastExecutionOf(h.registry.get('A', SCOPE))?.status === 'completed')).toBe(true);
    expect(h.client.executeCalls).toHaveLength(1);
  });

  it('⑦ wait completed 的输出文件/大日志走同一套回程登记：Worker 只见 fileId，读得回字节，无绝对路径', async () => {
    const runtimeRoot = tempDir('long-task-files-');
    const platformRoot = path.join(runtimeRoot, 'platform');
    const store = openTaskStore(':memory:');
    const fileStore: FileStore = createFileStore({ store, workspaceRoot: path.join(runtimeRoot, 'workspace') });
    const client = new ScriptedClient();
    const driver = new ScriptedWorker();
    const registry = createTaskRegistry();
    const clock = new Clock();
    const longTasks = new ManualLongTasks();
    const events: ExecutionEvent[] = [];
    const policy = new CapPolicy();
    const bridgeFactory = (input: { taskId: string }) => createTaskExecutionBridge({
      platformRoot,
      fileStore,
      scope: SCOPE,
      inner: client,
    })(input.taskId);
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.longtask', 'dummy.query'],
      workerDriver: driver,
      registry,
      now: () => clock.now,
      backgroundTaskBridge: bridgeFactory,
      onExecutionEvent: (event) => events.push(event),
    });
    const runner = createTaskRunner({
      registry,
      policy,
      executor,
      now: () => new Date(clock.now),
      timers: new ManualTimers(),
      longTasks,
    });
    submit(runner, 'A', 'LONG 产出导出');
    await flush();
    await flush();
    // 诊断：受理后任务应保持 running 且等待项已建（若这里失败，说明首轮执行没走到 accepted）。
    expect(taskMayBeRunningOf(registry.get('A', SCOPE))).toBe(true);
    expect(longTasks.waits).toHaveLength(1);

    const fileBytes = Buffer.from('name,value\nalpha,1\n', 'utf8');
    const largeLog = `large-log-start ${'x'.repeat(5_000)} large-log-end`;
    const smallLog = '短日志：已处理 1 条';
    longTasks.waits[0]!.resolve({
      status: 'completed',
      outcome: {
        status: 'completed',
        data: {
          summary: '导出完成',
          files: [{ name: 'report.csv', content: fileBytes.toString('base64') }],
          logs: [
            { name: 'run.log', text: largeLog },
            { name: 'brief.log', text: smallLog },
          ],
        },
      },
    });
    await flush();
    await runner.whenIdle();
    expect(archivedReportOf(registry.get('A', SCOPE)) !== undefined || (archivedReportOf(registry.get('A', SCOPE)) !== undefined || lastExecutionOf(registry.get('A', SCOPE))?.status === 'completed')).toBe(true);

    const resumed = driver.rounds.find((round) => round.resumed);
    expect(resumed).toBeDefined();
    const delegation = resumed!.delegation;
    // 文件与日志都只以 fileId 出现；大日志正文不灌进转录，绝对路径不出现。
    expect(delegation).toContain('"fileId"');
    expect(delegation).not.toContain(largeLog.slice(0, 64));
    expect(delegation).not.toContain(platformRoot);
    expect(delegation).not.toContain(runtimeRoot);
    expect(delegation).not.toMatch(/"\/(home|tmp|var|usr)\//);
    expect(delegation).toContain(smallLog);

    // Worker 侧能从任务文件读回字节（与普通任务文件同一解析面）。
    const taskFiles = fileStore.listTaskFiles({ scope: SCOPE, taskId: 'A', now: Date.now() });
    const report = taskFiles.find((file) => file.name === 'report.csv');
    expect(report).toBeDefined();
    expect(report!.bytes).toBe(fileBytes.length);
    const logFile = taskFiles.find((file) => file.name === 'run.log.log');
    expect(logFile).toBeDefined();

    const materialized = fileStore.materializeInputs({
      runDir: path.join(runtimeRoot, 'readback'),
      scope: SCOPE,
      fileIds: [report!.fileId],
      resolution: { side: 'worker', taskId: 'A' },
    });
    const bytes = readFileSync(path.join(runtimeRoot, 'readback', 'in', materialized[0]!.materializedName));
    expect(bytes.equals(fileBytes)).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'execution_wait_files_registered',
        operationId: 'op-1',
        files: 1,
        logsFileized: 1,
      }),
    ]));
    store.close();
  });
});

describe('dummy CLI 适配器：长任务传输面', () => {
  function stateDir(): string {
    return tempDir('dummy-longtask-');
  }

  it('execute → accepted；wait 到 completed；abort 确认；未完成窗口返回 accepted', async () => {
    const dir = stateDir();
    const client = createDummyCliClient({
      root: FIXTURE_ROOT,
      gateway: 'bin/dummy',
      stateDir: dir,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    });
    const manifest = await client.capabilities();
    const declared = manifest.operations.find((operation) => operation.name === 'dummy.longtask');
    expect(declared?.long_running).toBe(true);

    const accepted = await client.execute({
      requestId: 'req_long_1',
      dispatchKey: 'dk_long_1',
      operation: 'dummy.longtask',
      args: { seconds: 0 },
    });
    expect(accepted.status).toBe('accepted');
    const operationId = (accepted as { operationId: string }).operationId;
    expect(operationId).toMatch(/^op_/);

    const completed = await client.wait!(operationId, 5_000);
    expect(completed.status).toBe('completed');

    const stillRunning = await client.execute({
      requestId: 'req_long_2',
      dispatchKey: 'dk_long_2',
      operation: 'dummy.longtask',
      args: { seconds: 3_600 },
    });
    const longId = (stillRunning as { operationId: string }).operationId;
    const windowed = await client.wait!(longId, 100);
    expect(windowed.status).toBe('accepted');
    expect((windowed as { operationId: string }).operationId).toBe(longId);

    expect(await client.abort!(longId)).toEqual({ aborted: true });
    const again = await client.abort!(longId);
    expect(again.aborted).toBe(false);
    expect((again as { reason?: string }).reason).toContain('already');
  }, 20_000);
});
