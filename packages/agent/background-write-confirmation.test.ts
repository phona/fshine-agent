/**
 * S1 守护测试：后台写确认回环的**底账承载与后台识别**（不做推送、不做接续轮透传）。
 *
 * 背景：写确认回环此前只在 inline 成立——提案（needs_confirmation）由 Worker 回合产出后，
 * createTaskExecutor 不认识它，把它归成 failed，并把**原始 outcome 直接回给 Worker**
 * （带 confirmation.handle）。一旦写操作走后台，句柄会漏进模型上下文，用户也永远看不到提案。
 *
 * 本切片判据（先红后绿）：
 *   ① 后台任务跑出 needs_confirmation → 任务落 waiting_user（复用既有等待状态机，不新状态），
 *      底账 pending_question.confirmation.summary 有值；可见投影无 handle；
 *   ② Worker 收到的工具结果与 task_status 投影里 JSON.stringify 不含 `cf_` 与 `handle`；
 *   ③ 同任务接续轮再次 proposal → 新提案替换旧提案（旧 handle 不再可见）；
 *   ④ 非写操作的后台任务行为逐字节不变（零变化对照）。
 *
 * 反向绊线：把脱敏改回「原始 outcome 回给 Worker」→ ② 必须红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createSession, createTaskExecutor, EXECUTE_OPERATION_TOOL } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutionOutcome, type TaskExecutor, type TaskRunner } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';
import { createNotificationOutbox } from './src/notifications';
import { renderNotification } from './src/notification-render';
import { attachNotificationOutbox } from '../../scripts/ask-runtime';

const SCOPE = { principalId: 'wecom:s1', sessionId: 'conv-s1' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.query', label: 'query', args: [] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
  ],
};

const SUMMARY = 'alpha 集合 2 条记录将被覆盖，不可撤销';
const EXPIRES_AT = '2026-11-18T12:00:00.000Z';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'bg-write-confirm-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

/** 写操作执行层：第一次/后续每次调用都发一个提案（handle 可指定）。 */
class ProposalClient implements ExecutionClient {
  readonly requests: Array<{ operation: string; confirmation?: unknown }> = [];
  private seq = 0;

  constructor(private readonly handle: () => string) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: { operation: string; confirmation?: unknown }): Promise<ExecutionOutcome> {
    this.requests.push(request);
    this.seq += 1;
    return {
      status: 'needs_confirmation',
      confirmation: { handle: this.handle(), summary: SUMMARY, expiresAt: EXPIRES_AT },
      data: { collection: 'alpha', freeze: this.seq },
    };
  }
}

/**
 * S3 用执行层：只读正常完成，写操作发提案（与 ProposalClient 同形）。
 * 记录每次请求的 confirmation（透传断言用）。
 */
class S3Client implements ExecutionClient {
  readonly requests: Array<{ operation: string; confirmation?: unknown }> = [];

  constructor(private readonly handle = 'cf_s3_handle') {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: { operation: string; confirmation?: unknown }): Promise<ExecutionOutcome> {
    this.requests.push(request);
    if (request.operation === 'dummy.query') return { status: 'completed', data: { rows: 2 } };
    return {
      status: 'needs_confirmation',
      confirmation: { handle: this.handle, summary: SUMMARY, expiresAt: EXPIRES_AT },
      data: { collection: 'alpha' },
    };
  }
}

/** 只读执行层：正常完成（零变化对照用）。 */
class ReadClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: { rows: 2 } };
  }
}

interface WorkerCapture {
  /** Worker 收到的工具结果原文（每次 exec 返回一份）。 */
  results: unknown[];
}

const WRITE_ARGS = { operation: 'dummy.commit', args: { '--collection': 'alpha' } };
const READ_ARGS = { operation: 'dummy.query', args: {} };

function callingWorker(args: Record<string, unknown>, capture: WorkerCapture): TurnDriver {
  return {
    async run(input) {
      capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

/** 多轮脚本化 Worker：每轮消费一组工具调用（S3 透传断言用）。 */
function roundWorker(
  rounds: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  capture: WorkerCapture,
): TurnDriver {
  const remaining = rounds.map((calls) => [...calls]);
  return {
    async run(input) {
      const calls = remaining.shift() ?? [];
      for (const args of calls) capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

async function makeExecutor(input: {
  client: ExecutionClient;
  registry: TaskRegistry;
  worker: TurnDriver;
}): Promise<TaskExecutor> {
  return createTaskExecutor({
    client: input.client,
    allowedOperations: ['dummy.query', 'dummy.commit'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: input.worker,
    registry: input.registry,
    workerTurnMs: 30_000,
  });
}

function makeRunner(registry: TaskRegistry, executor: TaskExecutor): TaskRunner {
  return createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
}

/** 受理 + 跑完一轮（后台任务不阻塞调用方；whenIdle 供测试收口）。 */
async function runBackground(registry: TaskRegistry, executor: TaskExecutor, taskId: string): Promise<TaskRunner> {
  const runner = makeRunner(registry, executor);
  runner.submit({
    taskId,
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    request: '把 alpha 集合提交到生产',
  });
  runner.pump();
  await runner.whenIdle();
  return runner;
}

/** 用 Main 假驱动调一次 task_status（生产 statusView 投影）。 */
async function taskStatusOf(registry: TaskRegistry, ref: string): Promise<Record<string, unknown>> {
  let captured: unknown;
  const mainDriver: TurnDriver = {
    async run(input) {
      captured = await input.exec('task_status', { ref });
      return { text: '（测试回合）', messages: [] as unknown as DriverMessage[] };
    },
  };
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new ReadClient(),
    allowedOperations: ['dummy.query'],
    mainDriver,
    workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: registry as never,
  });
  await session.send('看看那个任务');
  return captured as Record<string, unknown>;
}

describe('S1 后台写确认：底账承载与后台识别', () => {
  /**
   * 在 Main 工具面上调一次工具（生产 createSession 装配 + 假 Main 驱动）。
   * 返回工具结果或工具错误原文——错误也是事实（本套件要用它断言拒绝话术）。
   */
  async function callMainTool(input: {
    registry: TaskRegistry;
    tool: string;
    args: Record<string, unknown>;
    runner?: TaskRunner;
  }): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    let captured: { ok: boolean; value?: unknown; error?: string } | undefined;
    const mainDriver: TurnDriver = {
      async run(turnInput) {
        try {
          captured = { ok: true, value: await turnInput.exec(input.tool, input.args) };
        } catch (error) {
          captured = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        return { text: '（测试回合）', messages: [] as unknown as DriverMessage[] };
      },
    };
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new ReadClient(),
      allowedOperations: ['dummy.query'],
      mainDriver,
      workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: input.registry as never,
      ...(input.runner === undefined ? {} : { taskRunner: input.runner }),
    });
    await session.send('（测试）');
    return captured!;
  }

  it('⑧ 已有待确认提案时再 task_run 被拒绝，并给「确认/不」两个动作（不再新开任务）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ProposalClient(() => 'cf_guard'),
      registry,
      worker: callingWorker(WRITE_ARGS, capture),
    });
    await runBackground(registry, executor, 't_guard');
    expect(registry.get('t_guard', SCOPE).status).toBe('waiting_user');
    const before = registry.list(SCOPE).length;

    const result = await callMainTool({ registry, tool: 'task_run', args: { task: '再把 alpha 提交一次' } });
    expect(result.ok).toBe(false);
    // 话术：说清在等什么 + 两个可执行动作；不暴露内部工具名。
    expect(result.error).toContain('等你确认');
    expect(result.error).toContain('回「确认」');
    expect(result.error).toContain('回「不」');
    expect(result.error).not.toContain('task_resume');
    // 没有新任务行（不产生半截任务）。
    expect(registry.list(SCOPE)).toHaveLength(before);
  });

  it('⑨ 用户回「确认」时 task_resume 省略 ref 也能接续同一个任务（编号不变）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ProposalClient(() => 'cf_resume'),
      registry,
      worker: callingWorker(WRITE_ARGS, capture),
    });
    const runner = await runBackground(registry, executor, 't_resume');
    const taskNo = registry.get('t_resume', SCOPE).taskNo;

    const result = await callMainTool({ registry, tool: 'task_resume', args: { answer: '确认' }, runner });
    expect(result.ok).toBe(true);
    expect((result.value as { outcome?: string }).outcome).toBe('started');
    await runner.whenIdle();

    // 同一任务（编号不变）被接续，而不是新开一个。
    expect(registry.list(SCOPE)).toHaveLength(1);
    expect(registry.get('t_resume', SCOPE).taskNo).toBe(taskNo);
  });

  it('⑩ task_status 列表默认只给最近 10 条（新→旧）+ 截断计数，不把 20 条历史全倒给模型', async () => {
    const registry = makeRegistry();
    // 造 12 个已完成任务（编号 1..12），按创建顺序。
    for (let index = 1; index <= 12; index += 1) {
      const taskId = `t_list_${index}`;
      registry.begin({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: `第 ${index} 件事` });
      registry.transition(taskId, 'completed');
    }
    const result = await callMainTool({ registry, tool: 'task_status', args: {} });
    expect(result.ok).toBe(true);
    const listed = result.value as {
      tasks: ReadonlyArray<{ taskNo?: number }>;
      total?: number;
      truncated?: number;
    };
    expect(listed.tasks).toHaveLength(10);
    // 新→旧：第一条是最新的 #12。
    expect(listed.tasks[0]!.taskNo).toBe(12);
    expect(listed.tasks[9]!.taskNo).toBe(3);
    expect(listed.total).toBe(12);
    expect(listed.truncated).toBe(2);
  });

  it('① 后台 needs_confirmation → waiting_user，底账 pending_question.confirmation.summary 有值', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ProposalClient(() => 'cf_s1_first'),
      registry,
      worker: callingWorker(WRITE_ARGS, capture),
    });

    await runBackground(registry, executor, 't_confirm');

    const task = registry.get('t_confirm', SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.waitingSince).toBeDefined();
    // 底账（SQLite JSON 列，零迁移）：提案摘要原样承载。
    const stored = registry.store.getTask('t_confirm');
    const pending = stored?.task.pendingQuestion as {
      confirmation?: { summary?: string };
    } | undefined;
    expect(pending?.confirmation?.summary).toBe(SUMMARY);
    // 可见投影不带句柄（句柄留底账供 S3 透传）。
    const visible = await taskStatusOf(registry, '#1');
    expect(visible.status).toBe('waiting_user');
    const projected = JSON.stringify(visible);
    expect(projected).not.toContain('cf_');
    expect(projected).not.toContain('handle');
    expect(projected).toContain(SUMMARY);
  });

  it('⑤ S2 待确认推送：用户看到「将写入什么」+ 两个动作；句柄不进 payload/文案', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-write-push-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    const outbox = createNotificationOutbox({ dbPath, sink: { send: async () => ({ delivered: true }) } });
    attachNotificationOutbox(registry, outbox);
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ProposalClient(() => 'cf_push_secret_handle'),
      registry,
      worker: callingWorker(WRITE_ARGS, capture),
    });

    await runBackground(registry, executor, 't_push');

    const rows = outbox.listNotifications('t_push');
    const waiting = rows.find((row) => row.kind === 'waiting_user');
    expect(waiting).toBeDefined();
    // 摘要进 payload（执行层原话），句柄不进——用户不需要也不该看到凭据。
    expect(waiting!.payload.summary).toBe(SUMMARY);
    expect(JSON.stringify(waiting!.payload)).not.toContain('cf_');
    expect('handle' in waiting!.payload).toBe(false);

    // 用户可见文案：说清将写入什么 + 两个能做的动作，且不含内部术语/句柄。
    const text = renderNotification({ kind: waiting!.kind, payload: waiting!.payload });
    expect(text).toContain(SUMMARY);
    expect(text).toContain('回「确认」');
    expect(text).toContain('回「不」');
    expect(text).not.toContain('cf_');
    expect(text).not.toContain('handle');
  });

  it('② Worker 工具结果与 task_status 投影都不含 cf_ 与 handle', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ProposalClient(() => 'cf_s1_leak_check'),
      registry,
      worker: callingWorker(WRITE_ARGS, capture),
    });

    await runBackground(registry, executor, 't_leak');

    expect(capture.results).toHaveLength(1);
    const workerSaw = JSON.stringify(capture.results[0]);
    expect(workerSaw).not.toContain('cf_');
    expect(workerSaw).not.toContain('handle');
    // 脱敏不是隐藏一切：机械摘要仍然可见（Worker 要知道在等什么确认）。
    expect(workerSaw).toContain(SUMMARY);

    const visible = await taskStatusOf(registry, '#1');
    const projected = JSON.stringify(visible);
    expect(projected).not.toContain('cf_');
    expect(projected).not.toContain('handle');
    expect(projected).toContain(SUMMARY);
  });

  it('③ 接续轮再次 proposal：新提案替换旧提案，旧 handle 不再可见', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    let handleSeq = 0;
    const executor: TaskExecutor = await createTaskExecutor({
      client: new ProposalClient(() => `cf_s1_round_${++handleSeq}`),
      allowedOperations: ['dummy.query', 'dummy.commit'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: callingWorker(WRITE_ARGS, capture),
      registry,
      workerTurnMs: 30_000,
    });
    const runner = await runBackground(registry, executor, 't_replace');

    const first = registry.get('t_replace', SCOPE).pendingQuestion?.confirmation?.handle;
    expect(first).toBe('cf_s1_round_1');

    const resumed = runner.resume('t_replace', { answer: '确认，提交吧', scope: SCOPE });
    expect(resumed.outcome).toBe('started');
    await runner.whenIdle();

    const task = registry.get('t_replace', SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_s1_round_2');
    // 旧句柄不再可见（底账与投影都不带）。
    const ledger = JSON.stringify(task);
    expect(ledger).not.toContain('cf_s1_round_1');
    const projected = JSON.stringify(await taskStatusOf(registry, '#1'));
    expect(projected).not.toContain('cf_s1_round_1');
    expect(projected).not.toContain('cf_s1_round_2');
    expect(projected).not.toContain('handle');
  });

  it('⑥ S3 接续轮透传：底账句柄 + 用户原话交给执行层；只读不消耗、一轮只发一次', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new S3Client('cf_s3_handle');
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query', 'dummy.commit'],
      readOnlyOperations: ['dummy.query'],
      // 轮 1：发起写提案；轮 2：先读一次（不得消耗确认）再提交两条写。
      workerDriver: roundWorker([[WRITE_ARGS], [READ_ARGS, WRITE_ARGS, WRITE_ARGS]], capture),
      registry,
      workerTurnMs: 30_000,
    });
    const runner = await runBackground(registry, executor, 't_s3');
    // 首回合自造提案不带句柄（没有「上一回合的用户表态」）。
    expect(client.requests[0]!.confirmation).toBeUndefined();
    expect(registry.get('t_s3', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_s3_handle');

    const resumed = runner.resume('t_s3', { answer: '确认，提交吧', scope: SCOPE });
    expect(resumed.outcome).toBe('started');
    await runner.whenIdle();

    // 只读调用不消耗确认。
    expect(client.requests[1]!.operation).toBe('dummy.query');
    expect(client.requests[1]!.confirmation).toBeUndefined();
    // 首条非只读执行拿到底账句柄 + 用户原话。
    expect(client.requests[2]!.operation).toBe('dummy.commit');
    expect(client.requests[2]!.confirmation).toEqual({ handle: 'cf_s3_handle', userText: '确认，提交吧' });
    // 一轮只发一次：同一回合的第二条写不再带句柄。
    expect(client.requests[3]!.operation).toBe('dummy.commit');
    expect(client.requests[3]!.confirmation).toBeUndefined();
  });

  it('⑦ 同回合 prepare 后立刻 commit：两条都不带句柄（同回合自我确认不是用户表态）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new S3Client('cf_same_turn');
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query', 'dummy.commit'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: roundWorker([[WRITE_ARGS, WRITE_ARGS]], capture),
      registry,
      workerTurnMs: 30_000,
    });
    await runBackground(registry, executor, 't_same');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]!.confirmation).toBeUndefined();
    expect(client.requests[1]!.confirmation).toBeUndefined();
  });

  it('④ 非写操作后台任务逐字节不变（零变化对照）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const executor = await makeExecutor({
      client: new ReadClient(),
      registry,
      worker: callingWorker(READ_ARGS, capture),
    });
    const runner = makeRunner(registry, executor);
    runner.submit({
      taskId: 't_read',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      request: '查一下 alpha 集合',
    });
    runner.pump();
    await runner.whenIdle();

    // 工具结果与执行层原始信封逐字节一致（非 needs_confirmation 不经过任何改写）。
    expect(JSON.stringify(capture.results[0])).toBe('{"status":"completed","data":{"rows":2}}');

    const task = registry.get('t_read', SCOPE);
    expect(task.status).toBe('completed');
    expect(task.pendingQuestion).toBeUndefined();

    // 执行器结局形状与改动前同形：completed + resultText（无 files 时不加字段）。
    // 用独立底账再跑一次（同一 principal/session 的同一操作已有认领事实，重放会走到
    // 待核对分支——那是 U3 语义，不是本对照要测的东西）。
    const freshRegistry = makeRegistry();
    freshRegistry.begin({
      taskId: 't_read_direct',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      request: '查一下 alpha 集合',
    });
    const freshCapture: WorkerCapture = { results: [] };
    const freshExecutor = await makeExecutor({
      client: new ReadClient(),
      registry: freshRegistry,
      worker: callingWorker(READ_ARGS, freshCapture),
    });
    const direct = await freshExecutor.execute(
      {
        taskId: 't_read_direct',
        request: '查一下 alpha 集合',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
      },
      { signal: new AbortController().signal },
    );
    expect(direct satisfies TaskExecutionOutcome).toEqual({
      kind: 'completed',
      resultText: '已按执行层回执汇报。',
    });
  });
});
