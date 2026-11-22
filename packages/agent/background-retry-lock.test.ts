/**
 * A2b 后台执行器「同对象确定性失败不重撞」锁（2026-11-19）。
 *
 * 根因（本分支实测）：inline `createSession.send` 路径有 A2b 锁（deterministicFailuresThisTurn /
 * deterministicKey，见 deterministic-failure-guard.test.ts），但**后台**执行器 `createTaskExecutor`
 * 的 exec 闭包完全没有这段——同一确定性拒绝（retryable !== true，含未声明）在**一个后台回合内**
 * 被反复打到执行层（实测 dummy.denied / GATE_REFUSE 被真实调用 2 次，且没有 execution_retry_blocked）。
 * 这正是 owner 的红线：宁可停，也绝不把执行层打爆。
 *
 * 判据（与前台 inline **同一份**「键 + 记录 + 判定」，见 src/deterministic-retry-lock.ts）：
 *   ① 键 = (operation, 对象参数)；对象取法与内联一致（--collection/--topic）。
 *   ② retryable !== true 的 failed/refused → 记入本回合；再次同键发起 → 宿主侧确定性拒绝
 *      （不发起执行），事件 execution_retry_blocked 走 options.onExecutionEvent；任务结局如实失败。
 *   ③ 回合边界：每个后台回合（每次 execute()；即一次 task_run 委派，见 background-write-confirmation
 *      的「一回合 worker 消费一轮」约定）独立清零，不跨回合记忆。
 *   ④ 被挡时返回业务话术（复用 failureMessageFor 的 executor_failed/host_fault），不含内部词。
 *
 * 反向绊线：把后台 exec 里的 retryLock.before/after 去掉 → ① / 绊线用例红（真实调用变 2/3 次）。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from './testing/task-facts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createTaskExecutor, EXECUTE_OPERATION_TOOL, type ExecutionEvent } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutor, type TaskRunner } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';
import { internalTermIn } from './src/user-facing-failure';

const SCOPE = { principalId: 'wecom:bglock', sessionId: 'conv-bglock' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [{ name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] }],
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'bg-retry-lock-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

/** 计数执行层：每次真实到达执行层就记账一次；结局由 outcomeFor 决定（可含真实拒绝）。 */
class CountingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  constructor(private readonly outcomeFor: (request: ExecutionRequest) => ExecutionOutcome) {}
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return this.outcomeFor(request);
  }
}

interface WorkerCapture {
  /** 每次 exec 的返回值（被挡的抛错位置记 undefined）。 */
  results: unknown[];
  /** 每次 exec 的抛错原文（成功位置 undefined）——断言被挡话术用。 */
  errors: Array<string | undefined>;
}

/**
 * 多轮脚本化 Worker：每次 run（= 一个后台回合）消费一轮里的全部工具调用。工具抛错**被捕获后
 * 继续**（真实 Pi 驱动把工具错误当工具结果交回模型、回合不中断）——被挡的调用不会打断回合。
 */
function roundWorker(
  rounds: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  capture: WorkerCapture,
): TurnDriver {
  const remaining = rounds.map((calls) => [...calls]);
  return {
    async run(input) {
      const calls = remaining.shift() ?? [];
      for (const args of calls) {
        try {
          capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
          capture.errors.push(undefined);
        } catch (error) {
          capture.errors.push(error instanceof Error ? error.message : String(error));
          capture.results.push(undefined);
        }
      }
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

const QUERY = (collection: string): Record<string, unknown> => ({
  operation: 'dummy.query',
  args: { '--collection': collection },
});

async function makeExecutor(input: {
  client: ExecutionClient;
  registry: TaskRegistry;
  worker: TurnDriver;
  onEvent?: (event: ExecutionEvent) => void;
}): Promise<TaskExecutor> {
  return createTaskExecutor({
    client: input.client,
    allowedOperations: ['dummy.query'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: input.worker,
    registry: input.registry,
    workerTurnMs: 30_000,
    ...(input.onEvent === undefined ? {} : { onExecutionEvent: input.onEvent }),
  });
}

/** 受理 + 跑完一轮（后台任务不阻塞调用方；whenIdle 供测试收口）。 */
async function runBackground(
  registry: TaskRegistry,
  executor: TaskExecutor,
  taskId: string,
  request = '查一下 alpha 集合',
): Promise<TaskRunner> {
  const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
  runner.submit({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
  runner.pump();
  await runner.whenIdle();
  return runner;
}

/** 取某类事件（typed 窄化，避免在 union 上直接索引字段）。 */
function eventsNamed<K extends ExecutionEvent['event']>(
  events: readonly ExecutionEvent[],
  name: K,
): Array<Extract<ExecutionEvent, { event: K }>> {
  return events.filter((event) => event.event === name) as Array<Extract<ExecutionEvent, { event: K }>>;
}

const REFUSED: (request: ExecutionRequest) => ExecutionOutcome = () => ({
  status: 'refused',
  error: { code: 'GATE_REFUSE', message: 'alpha 集合被策略拒绝', retryable: false },
});

describe('A2b 后台执行器：同对象确定性失败不重撞', () => {
  it('① 同键确定性拒绝两次 → 执行层真实调用 1 次；第二次落 execution_retry_blocked；任务如实失败', async () => {
    const registry = makeRegistry();
    const events: ExecutionEvent[] = [];
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(REFUSED);
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[QUERY('alpha'), QUERY('alpha')]], capture),
      onEvent: (event) => events.push(event),
    });

    await runBackground(registry, executor, 't_same_key');

    // 执行层只被真实调用一次（第二次在发起前被宿主拦下）。
    expect(client.requests).toHaveLength(1);
    // 落地一条 execution_retry_blocked（含 operation/object/code/declaredRetryable）。
    const blocked = eventsNamed(events, 'execution_retry_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.taskId).toBe('t_same_key');
    expect(blocked[0]!.operation).toBe('dummy.query');
    expect(blocked[0]!.object).toBe('alpha');
    expect(blocked[0]!.code).toBe('GATE_REFUSE');
    expect(blocked[0]!.declaredRetryable).toBe(false);
    // 被挡话术是业务语言、不含内部词（模型据此如实收尾）。
    const blockedMessage = capture.errors[1]!;
    expect(blockedMessage).toContain('没办成');
    expect(internalTermIn(blockedMessage)).toBeUndefined();
    // 任务结局如实失败（不报成功）。
    expect(['failed', 'refused']).toContain(lastExecutionOf(registry.get('t_same_key', SCOPE))?.status);
  });

  it('② 不同对象（换集合）的两次拒绝 → 各自真实调用（锁只锁同对象）', async () => {
    const registry = makeRegistry();
    const events: ExecutionEvent[] = [];
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(REFUSED);
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[QUERY('alpha'), QUERY('beta')]], capture),
      onEvent: (event) => events.push(event),
    });

    await runBackground(registry, executor, 't_diff_key');

    expect(client.requests.map((request) => request.args['--collection'])).toEqual(['alpha', 'beta']);
    expect(eventsNamed(events, 'execution_retry_blocked')).toEqual([]);
    expect(['failed', 'refused']).toContain(lastExecutionOf(registry.get('t_diff_key', SCOPE))?.status);
  });

  it('③ retryable:true 的失败 → 不被锁（允许再试），并留 execution_retry_allowed', async () => {
    const registry = makeRegistry();
    const events: ExecutionEvent[] = [];
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(() => ({
      status: 'failed',
      error: { code: 'TRANSIENT', message: 'busy', retryable: true },
    }));
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[QUERY('alpha'), QUERY('alpha')]], capture),
      onEvent: (event) => events.push(event),
    });

    await runBackground(registry, executor, 't_retryable');

    expect(client.requests).toHaveLength(2);
    expect(eventsNamed(events, 'execution_retry_blocked')).toEqual([]);
    const allowed = eventsNamed(events, 'execution_retry_allowed');
    expect(allowed).toHaveLength(2);
    expect(allowed[0]!.object).toBe('alpha');
    expect(allowed[0]!.code).toBe('TRANSIENT');
  });

  it('③-2 retryable:true 放行有次数上界（E14 口径：同一件事一个回合内兜/重试 ≤2 次）：第 3 次发起前被拦', async () => {
    // 根因（真模型验收实跑）：夹具对参数形状错误 INVALID_RECORDS 声明 retryable:true，A2b 放行，
    // 实测 Worker 一个回合里用 5 种错误写法连撞 5 次——放行没有次数上限。修法：放行次数用尽后，
    // 同一 (operation, 对象) 转入既有拦截路径（before 拦下 + 既有 execution_retry_blocked 事件），
    // 任务结局如实失败；回合边界不跨回合累计（与确定性失败锁同一作用域）。
    const registry = makeRegistry();
    const events: ExecutionEvent[] = [];
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(() => ({
      status: 'failed',
      error: { code: 'INVALID_RECORDS', message: '--records 必须是结构化数组（每项 {name, value}）', retryable: true },
    }));
    const badShape = (marker: string): Record<string, unknown> => ({
      operation: 'dummy.query',
      args: { '--collection': 'alpha', '--records': marker },
    });
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[badShape('bad-1'), badShape('bad-2'), badShape('bad-3')]], capture),
      onEvent: (event) => events.push(event),
    });

    await runBackground(registry, executor, 't_retryable_budget');

    // 执行层只被真实打到 2 次（第 2 次失败后预算用尽，第 3 次在发起前被拦）。
    expect(client.requests).toHaveLength(2);
    const allowed = eventsNamed(events, 'execution_retry_allowed');
    expect(allowed).toHaveLength(2);
    const blocked = eventsNamed(events, 'execution_retry_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!).toMatchObject({
      taskId: 't_retryable_budget',
      operation: 'dummy.query',
      object: 'alpha',
      code: 'INVALID_RECORDS',
      // 执行层当时确实说可重试——拦的是次数，不改写它的声明。
      declaredRetryable: true,
    });
    // 任务结局如实失败（不把「停下来」讲成成功）。
    expect(['failed', 'refused']).toContain(lastExecutionOf(registry.get('t_retryable_budget', SCOPE))?.status);
  });

  it('④ 跨回合不记忆：下一个回合同键再调 → 允许（本回合才锁）', async () => {
    const registry = makeRegistry();
    const events: ExecutionEvent[] = [];
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(REFUSED);
    const executor = await makeExecutor({
      client,
      registry,
      // 回合 1（连续两次同键）→ 第二次被挡；回合 2（新一次 execute，同键一次）→ 新锁放行。
      worker: roundWorker([[QUERY('alpha'), QUERY('alpha')], [QUERY('alpha')]], capture),
      onEvent: (event) => events.push(event),
    });

    // 回合 1：真实调用 1 次 + 拦截 1 次。
    await runBackground(registry, executor, 't_turn1');
    expect(client.requests).toHaveLength(1);
    expect(eventsNamed(events, 'execution_retry_blocked')).toHaveLength(1);

    // 回合 2（另一次 execute；锁不跨回合）→ 同对象 alpha 再调 → 放行（真实调用第 2 次）。
    await runBackground(registry, executor, 't_turn2');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]!.args['--collection']).toBe('alpha');
    // 跨回合不累计：回合 2 里没有新的拦截。
    expect(eventsNamed(events, 'execution_retry_blocked')).toHaveLength(1);
  });

  it('零变化对照：成功过的重复照常放行（同对象两次都成功各执行一次）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(() => ({ status: 'completed', data: { rows: 2 } }));
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[QUERY('alpha'), QUERY('alpha')]], capture),
    });

    await runBackground(registry, executor, 't_success_repeat');

    expect(client.requests).toHaveLength(2);
    expect(lastExecutionOf(registry.get('t_success_repeat', SCOPE))?.status).toBe('completed');
  });
});

/**
 * 反向绊线：把后台 exec 里的 A2b 接线去掉 → 本用例红（三次同键会真实调用三次）。
 * 键 + 判定单源于 deterministic-retry-lock.ts，被后台执行器引用。
 */
describe('反向绊线：后台不接 A2b 锁时必须红', () => {
  it('同一确定性拒绝在一个后台回合内只落一次真实调用（去掉接线即 3 次）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [], errors: [] };
    const client = new CountingClient(REFUSED);
    const executor = await makeExecutor({
      client,
      registry,
      worker: roundWorker([[QUERY('alpha'), QUERY('alpha'), QUERY('alpha')]], capture),
    });
    await runBackground(registry, executor, 't_tripwire');
    // 三次同键：只有第一次真实到达执行层。
    expect(client.requests).toHaveLength(1);
  });
});
