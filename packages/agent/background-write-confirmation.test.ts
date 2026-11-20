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
import { createSession, createTaskExecutor, EXECUTE_OPERATION_TOOL, NO_WAITING_TARGET_FACT, NO_WAITING_RESUME_TARGET_FACT } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutionOutcome, type TaskExecutor, type TaskRunner } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';
import { createNotificationOutbox } from './src/notifications';
import { renderNotification } from './src/notification-render';
import { confirmationExpiredMessage, internalTermIn } from './src/user-facing-failure';
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
/**
 * 提案有效期（显式确认切片起 runner 校验过期）：必须是**未来**时间，否则确认路径会走「过期重提」，
 * 不再是「提交」。过期用例用 EXPIRED_AT（过去）。
 */
const EXPIRES_AT = '2035-01-01T00:00:00.000Z';
const EXPIRED_AT = '2000-01-01T00:00:00.000Z';

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

  it('⑥ S3 确认路径透传：底账句柄 + 用户原话交给执行层；只读不消耗、每条非只读都带', async () => {
    // P0（owner 2026-11-19）起口径变更：句柄随**每条**非只读调用携带，不再一轮只发一次——
    // 一次性/防重放由执行层自己保证，宿主截流会让「先 prepare 再 commit」的 commit 拿不到句柄。
    // 显式确认切片（2026-11-19）：句柄**只**经确认路径（runner.confirm）注入；resume 不带。
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

    const confirmed = runner.confirm('t_s3', { userText: '确认，提交吧', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    // 只读调用不消耗确认、也不携带句柄。
    expect(client.requests[1]!.operation).toBe('dummy.query');
    expect(client.requests[1]!.confirmation).toBeUndefined();
    // 首条非只读执行拿到底账句柄 + 用户原话。
    expect(client.requests[2]!.operation).toBe('dummy.commit');
    expect(client.requests[2]!.confirmation).toEqual({ handle: 'cf_s3_handle', userText: '确认，提交吧' });
    // 同一回合的第二条写**也**带同一句柄（执行层自己保证一次性，宿主不再截流）。
    expect(client.requests[3]!.operation).toBe('dummy.commit');
    expect(client.requests[3]!.confirmation).toEqual({ handle: 'cf_s3_handle', userText: '确认，提交吧' });
  });

  it('⑪ 确认回合每条非只读都带句柄：不再独吞（写不进去的根因）', async () => {
    // P0（owner 2026-11-19 live 实测）：待确认句柄原挂在「首条非只读调用」上、发过即止，
    // 而 Worker 第一句往往是 prepare 再才 commit——句柄被 prepare 消耗，真正 commit 时
    // 手里空的 → commit 必然 CONFIRMATION_REQUIRED（写不进去）。修法：句柄随**每条**
    // 非只读调用携带；一次性/防重放由执行层自己保证（契约不承诺宿主复用）。
    // 显式确认切片：句柄只经 runner.confirm 注入。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new S3Client('cf_every_call');
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query', 'dummy.commit'],
      readOnlyOperations: ['dummy.query'],
      // 轮 1：写提案；轮 2：两条写调用（先「prepare 形态」再「commit 形态」）都必须带句柄。
      workerDriver: roundWorker([[WRITE_ARGS], [WRITE_ARGS, WRITE_ARGS]], capture),
      registry,
      workerTurnMs: 30_000,
    });
    const runner = await runBackground(registry, executor, 't_every');
    // 首回合自造提案不带句柄（没有上一轮的用户表态）。
    expect(client.requests[0]!.confirmation).toBeUndefined();
    expect(registry.get('t_every', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_every_call');

    const confirmed = runner.confirm('t_every', { userText: '确认，提交吧', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    // 续跑回合第一条非只读（相当于 prepare）带句柄……
    expect(client.requests[1]!.confirmation).toEqual({ handle: 'cf_every_call', userText: '确认，提交吧' });
    // ……第二条非只读（真正的 commit）也带同一句柄（执行层自己保证一次性，宿主不再截流）。
    expect(client.requests[2]!.confirmation).toEqual({ handle: 'cf_every_call', userText: '确认，提交吧' });
  });

  it('⑫ 确认委派文本出现机械事实：本次任务 = 已确认提案（摘要），明确指令直接提交、原交办 prose 让位', async () => {
    // 话术补丁不解决「新 Worker 不知道上一轮发生了什么」：确认回合的委派必须携带一条
    // **机械事实**（宿主从底账提案组装，不是模型话术）——Worker 据此提交、不重新出提案。
    // 2026-11-20（S3）：这条事实**直接顶替「本次任务」正文**（原交办 prose 不进委派），
    // 动作写成正向的「提交上一轮已确认的提案 / 按已确认的提案直接提交」——13/14 续跑回合
    // 拿原 prose 重跑 prepare 的直接修法。该事实**只在确认路径**出现（resume 不带）。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    let delegationText = '';
    const client = new S3Client('cf_delegation_fact');
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query', 'dummy.commit'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: (() => {
        const inner = roundWorker([[WRITE_ARGS], [WRITE_ARGS]], capture);
        return {
          async run(input) {
            // 委派原文 = Worker 回合第一条 user 消息（renderWorkerDelegation 的产物）。
            const first = input.messages.find((message) => message.role === 'user');
            if (first !== undefined) delegationText = String((first as { content?: unknown }).content ?? '');
            return inner.run(input);
          },
        };
      })(),
      registry,
      workerTurnMs: 30_000,
    });
    const runner = await runBackground(registry, executor, 't_delegation');
    const confirmed = runner.confirm('t_delegation', { userText: '确认，提交吧', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    // 委派文本（renderWorkerDelegation 实际产出）：本次任务 = 已确认提案事实 + 摘要 + 正向提交指令。
    expect(delegationText).toContain('提交上一轮已确认的提案');
    expect(delegationText).toContain(SUMMARY);
    expect(delegationText).toContain('按这些参数直接提交，不要省略或改写任何参数');
    // 2026-11-20（S3）：原交办 prose（含被用户改掉的旧值）不进委派，事实是本次任务正文。
    expect(delegationText.split('## 本次任务\n')[1]!).toContain('提交上一轮已确认的提案');
    // 机械事实是宿主的透传，不含句柄（Worker 永远看不到确认凭据）。
    expect(delegationText).not.toContain('cf_delegation_fact');
    expect(delegationText).not.toContain('handle');
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

/**
 * 同回合自我确认被挡的**结局归类**（owner 2026-11-19 live 实测：后台写不进去 P0）。
 *
 * 根因：模型在**同一回合**里 prepare 出提案后紧接着 commit——同回合没有句柄，commit 被执行层
 * 以 CONFIRMATION_REQUIRED 拒。旧归类只看「最后一条非只读」，于是落成 failed，导致：
 *   ① 用户从没被问到确认；② 下游「有待确认提案就拒绝新建」的守卫不生效（任务不是 waiting_user）；
 *   ③ 用户回「确认」时没有可接续的任务（他 14:37 那句「确认」什么都没发生）。
 *
 * 判据（结构化，不看文案）：本回合 recorded 里存在 needs_confirmation，且所有 failed/refused
 * 条目的码都是 CONFIRMATION_REQUIRED → 判 needs_confirmation（句柄/摘要随问题落底账）；
 * 出现任何其它真实失败（GATE_REFUSE / COLLECTION_NOT_FOUND / …）→ 仍 failed。
 *
 * 反向绊线：去掉这条归类（selfConfirmBlockedRoundOf 返回 undefined）→ ⑬ 立即红（任务变 failed）。
 */
const SELF_CONFIRM_MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.prepare', label: 'prepare', args: [] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.query', label: 'query', args: [] },
    { name: 'dummy.denied', label: 'denied', args: [] },
  ],
};

/** 执行层语义镜像（真 dummy 同形）：prepare 出提案；commit 无句柄 = CONFIRMATION_REQUIRED。 */
class SelfConfirmClient implements ExecutionClient {
  readonly requests: Array<{ operation: string; confirmation?: unknown }> = [];
  constructor(private readonly handle = 'cf_self_confirm') {}
  async capabilities(): Promise<CapabilityManifest> {
    return SELF_CONFIRM_MANIFEST;
  }
  async execute(request: { operation: string; confirmation?: unknown }): Promise<ExecutionOutcome> {
    this.requests.push(request);
    if (request.operation === 'dummy.query') return { status: 'completed', data: { rows: 2 } };
    if (request.operation === 'dummy.prepare') {
      return {
        status: 'needs_confirmation',
        confirmation: { handle: this.handle, summary: SUMMARY, expiresAt: EXPIRES_AT },
        data: { collection: 'alpha' },
      };
    }
    if (request.operation === 'dummy.denied') return { status: 'refused', error: { code: 'GATE_REFUSE', message: 'denied' } };
    // dummy.commit：无句柄（同回合自我确认）→ 被挡；带句柄（用户已表态）→ 完成。
    return request.confirmation === undefined
      ? { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED', message: 'commit requires a confirmation handle' } }
      : { status: 'completed', data: { added: 2 } };
  }
}

const PREPARE_ARGS = { operation: 'dummy.prepare', args: { '--collection': 'alpha' } };
const COMMIT_ARGS = { operation: 'dummy.commit', args: { '--collection': 'alpha' } };
const QUERY_ARGS = { operation: 'dummy.query', args: {} };
const DENIED_ARGS = { operation: 'dummy.denied', args: {} };

function selfConfirmExecutor(client: ExecutionClient, registry: TaskRegistry, worker: TurnDriver): Promise<TaskExecutor> {
  return createTaskExecutor({
    client,
    allowedOperations: ['dummy.prepare', 'dummy.commit', 'dummy.query', 'dummy.denied'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: worker,
    registry,
    workerTurnMs: 30_000,
  });
}

describe('同回合自我确认被挡：结局是 waiting_user（提案），不是 failed', () => {
  it('⑬ prepare→commit 被挡 → 任务 waiting_user、底账有提案、可见面是提案（不是「没办成」）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new SelfConfirmClient('cf_blocked_1');
    const executor = await selfConfirmExecutor(client, registry, roundWorker([[PREPARE_ARGS, COMMIT_ARGS]], capture));
    await runBackground(registry, executor, 't_self_confirm');

    // 结局 = waiting_user（不是 failed）：底账带真实提案（句柄 + 摘要）。
    const task = registry.get('t_self_confirm', SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.summary).toBe(SUMMARY);
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_blocked_1');
    // 两次非只读都真的打到执行层（同回合自我确认不是用户表态，但也不是宿主预先拦下）。
    expect(client.requests.map((r) => r.operation)).toEqual(['dummy.prepare', 'dummy.commit']);

    // 用户可见面 = 提案（含摘要），不是「没办成」；句柄不进可见投影。
    const visible = await taskStatusOf(registry, '#1');
    expect(visible.status).toBe('waiting_user');
    const projected = JSON.stringify(visible);
    expect(projected).toContain(SUMMARY);
    expect(projected).not.toContain('cf_');
    expect(projected).not.toContain('handle');
    expect(projected).not.toContain('没办成');
  });

  it('⑭ 被挡后再 query 成功 → 仍 waiting_user（不被后面的成功掩盖）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new SelfConfirmClient('cf_blocked_2');
    const executor = await selfConfirmExecutor(client, registry, roundWorker([[PREPARE_ARGS, COMMIT_ARGS, QUERY_ARGS]], capture));
    await runBackground(registry, executor, 't_self_confirm_query');

    expect(registry.get('t_self_confirm_query', SCOPE).status).toBe('waiting_user');
    expect(registry.get('t_self_confirm_query', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_blocked_2');
    expect(client.requests.map((r) => r.operation)).toEqual(['dummy.prepare', 'dummy.commit', 'dummy.query']);
  });

  it('⑮ prepare→真实失败（GATE_REFUSE）→ 仍 failed（不许把真失败说成等确认）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new SelfConfirmClient('cf_blocked_3');
    const executor = await selfConfirmExecutor(client, registry, roundWorker([[PREPARE_ARGS, DENIED_ARGS]], capture));
    await runBackground(registry, executor, 't_self_confirm_denied');

    const task = registry.get('t_self_confirm_denied', SCOPE);
    expect(task.status).toBe('failed');
    expect(task.pendingQuestion).toBeUndefined();
  });
});

/**
 * 显式确认切片（2026-11-19 owner 拍板）：确认是一个**显式动作**，不是「下一条消息的默认含义」。
 * 句柄**只**经确认路径（runner.confirm）注入；resume（补充/改口径）**永不**透传；宿主不做意图推断。
 * 反向绊线：把②的「resume 不带句柄」改回旧行为（resume 透传句柄）→ ②红；
 *   把③的过期判定去掉（过期当普通确认直接提交）→ ③红。
 */
describe('显式确认切片：确认是显式动作，resume 永不带句柄', () => {
  /** 确认流执行层：prepare 出提案（每次新句柄）；commit 带句柄成功、无句柄拒绝；query 只读。 */
  class ConfirmFlowClient implements ExecutionClient {
    readonly requests: Array<{ operation: string; confirmation?: unknown }> = [];
    private seq = 0;
    constructor(private readonly firstExpiresAt: string = EXPIRES_AT) {}
    async capabilities(): Promise<CapabilityManifest> {
      return SELF_CONFIRM_MANIFEST;
    }

    async execute(request: { operation: string; confirmation?: unknown }): Promise<ExecutionOutcome> {
      this.requests.push(request);
      if (request.operation === 'dummy.query') return { status: 'completed', data: { rows: 2 } };
      if (request.operation === 'dummy.prepare') {
        this.seq += 1;
        const expiresAt = this.seq === 1 ? this.firstExpiresAt : EXPIRES_AT;
        return {
          status: 'needs_confirmation',
          confirmation: { handle: `cf_flow_${this.seq}`, summary: SUMMARY, expiresAt },
          data: { collection: 'alpha' },
        };
      }
      // dummy.commit：带句柄 = 提交成功；无句柄 = 同回合自我确认被挡（执行层确定性拒绝）。
      return request.confirmation === undefined
        ? { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED', message: 'commit requires a confirmation handle' } }
        : { status: 'completed', data: { added: 2, total: 4 } };
    }
  }

  function flowExecutor(client: ExecutionClient, registry: TaskRegistry, worker: TurnDriver): Promise<TaskExecutor> {
    return createTaskExecutor({
      client,
      allowedOperations: ['dummy.prepare', 'dummy.commit', 'dummy.query'],
      readOnlyOperations: ['dummy.query'],
      workerDriver: worker,
      registry,
      workerTurnMs: 30_000,
    });
  }

  /** 在 Main 工具面上调一次工具（生产 createSession 装配 + 假 Main 驱动）。 */
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
      client: new ConfirmFlowClient(),
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

  it('① 确认路径：task_confirm → 每条非只读都带同名句柄 + 用户原话 → 提交成功、任务 completed', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new ConfirmFlowClient();
    // 轮 1：出提案；轮 2：先读一次（不消耗确认）再提交两条写（都带句柄）。
    const executor = await flowExecutor(
      client,
      registry,
      roundWorker([[PREPARE_ARGS], [QUERY_ARGS, COMMIT_ARGS, COMMIT_ARGS]], capture),
    );
    const runner = await runBackground(registry, executor, 't_confirm_ok');
    expect(registry.get('t_confirm_ok', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_flow_1');

    const outcome = runner.confirm('t_confirm_ok', { userText: '确认，就按这版提交', scope: SCOPE });
    expect(outcome).toEqual({ outcome: 'started', taskId: 't_confirm_ok' });
    await runner.whenIdle();

    // 只读调用不带句柄；两条写调用都带同一句柄 + 用户原话。
    expect(client.requests[1]!.operation).toBe('dummy.query');
    expect(client.requests[1]!.confirmation).toBeUndefined();
    expect(client.requests[2]!.confirmation).toEqual({ handle: 'cf_flow_1', userText: '确认，就按这版提交' });
    expect(client.requests[3]!.confirmation).toEqual({ handle: 'cf_flow_1', userText: '确认，就按这版提交' });
    expect(registry.get('t_confirm_ok', SCOPE).status).toBe('completed');
  });

  it('② 改口径路径：task_resume → 任何调用都不带旧句柄；Worker 重新提案 → 底账是新句柄、旧的不再出现', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new ConfirmFlowClient();
    const executor = await flowExecutor(client, registry, roundWorker([[PREPARE_ARGS], [PREPARE_ARGS]], capture));
    const runner = await runBackground(registry, executor, 't_resume_change');
    expect(registry.get('t_resume_change', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_flow_1');

    // 「改成另一个口径」——语义在 resume（补充/改口径），不是确认。
    const outcome = runner.resume('t_resume_change', { answer: '改成换成集合 beta 再提一次', scope: SCOPE });
    expect(outcome.outcome).toBe('started');
    await runner.whenIdle();

    // 任何调用都不带旧句柄（resume 永不透传）。
    for (const request of client.requests) expect(request.confirmation).toBeUndefined();
    const task = registry.get('t_resume_change', SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_flow_2');
    // 旧句柄不再出现在底账。
    expect(JSON.stringify(task)).not.toContain('cf_flow_1');
  });

  it('③ 过期确认：task_confirm 触发一轮重新提案（不判失败、不结束任务、零写执行）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    // 首份提案已过期（EXPIRED_AT 在过去）；重新提案的那份有效期正常。
    const client = new ConfirmFlowClient(EXPIRED_AT);
    const executor = await flowExecutor(client, registry, roundWorker([[PREPARE_ARGS], [PREPARE_ARGS]], capture));
    const runner = await runBackground(registry, executor, 't_expired');
    expect(registry.get('t_expired', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_flow_1');

    const outcome = runner.confirm('t_expired', { userText: '确认', scope: SCOPE });
    expect(outcome).toEqual({ outcome: 'expired', taskId: 't_expired' });
    await runner.whenIdle();

    // 触发了一轮新的 prepare（重新提案），零写执行（没有 commit 调用）。
    expect(client.requests.map((request) => request.operation)).toEqual(['dummy.prepare', 'dummy.prepare']);
    // 任务仍等待确认，底账是**新**句柄，旧的不再出现。
    const task = registry.get('t_expired', SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_flow_2');
    expect(JSON.stringify(task)).not.toContain('cf_flow_1');
    // 用户可见话术：含「过期」，过 internalTermIn（无内部术语）。
    const message = confirmationExpiredMessage(task.pendingQuestion?.confirmation?.summary);
    expect(message).toContain('过期');
    expect(internalTermIn(message)).toBeUndefined();
  });

  it('④ 无提案确认：没有等待中的提案时 task_confirm 给模型机械事实（不新建任务、不执行）', async () => {
    const registry = makeRegistry();
    // 一个「等补充信息」的等待任务（有 waiting_user，但没有 confirmation 提案）。
    registry.begin({ taskId: 't_needs_input', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '查 alpha 的窗口' });
    registry.waitForUser('t_needs_input', { missing: ['窗口编号'] });
    const before = registry.list(SCOPE).length;
    const runner = makeRunner(registry, await flowExecutor(new ConfirmFlowClient(), registry, roundWorker([], { results: [] })));

    // 没有等待确认的提案 → no-target 结局 + 机械事实（不是给用户的成句话术）。
    const result = await callMainTool({ registry, tool: 'task_confirm', args: {}, runner });
    expect(result.ok).toBe(true);
    const value = result.value as { outcome?: string; fact?: string; runningTasks?: number };
    expect(value.outcome).toBe('no_waiting_task');
    expect(value.fact).toBe(NO_WAITING_TARGET_FACT);
    expect(value.runningTasks).toBe(0);
    expect(internalTermIn(value.fact!)).toBeUndefined();
    // 没有新建任务、没有发起执行。
    expect(registry.list(SCOPE)).toHaveLength(before);
    expect(registry.get('t_needs_input', SCOPE).status).toBe('waiting_user');
  });

  it('⑤ 推断禁止：task_resume 的 answer 是「确认」这类话时也不带句柄（语义在 confirm，不在文案）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new ConfirmFlowClient();
    const executor = await flowExecutor(client, registry, roundWorker([[PREPARE_ARGS], [PREPARE_ARGS]], capture));
    const runner = await runBackground(registry, executor, 't_infer');
    expect(registry.get('t_infer', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_flow_1');

    // 用户原话字面上就是「确认」——但走的是 resume（补充/改口径），宿主不猜：不带句柄。
    const outcome = runner.resume('t_infer', { answer: '确认', scope: SCOPE });
    expect(outcome.outcome).toBe('started');
    await runner.whenIdle();

    for (const request of client.requests) expect(request.confirmation).toBeUndefined();
    expect(registry.get('t_infer', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_flow_2');
  });

  /**
   * 跑一个 Main 回合（脚本模型 = 调用给定工具，然后说一句给定的话），返回 TurnResult 与
   * 工具结果——验证 no-target 时工具结果只给模型机械事实、模型文本原样返回（宿主不替换）。
   */
  async function scriptedConfirmTurn(input: {
    registry: TaskRegistry;
    runner: TaskRunner;
    tool: string;
    args: Record<string, unknown>;
    modelText: string;
  }): Promise<{ reply: string; toolResults: unknown[] }> {
    const toolResults: unknown[] = [];
    const mainDriver: TurnDriver = {
      async run(turnInput) {
        toolResults.push(await turnInput.exec(input.tool, input.args).catch((error: unknown) => {
          throw error;
        }));
        return { text: input.modelText, messages: [] as unknown as DriverMessage[] };
      },
    };
    const session = await createSession({
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      client: new ConfirmFlowClient(),
      allowedOperations: ['dummy.query'],
      mainDriver,
      workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: input.registry as never,
      taskRunner: input.runner,
    });
    const turn = await session.send('确认');
    return { reply: turn.reply, toolResults };
  }

  it('⑥ 没有等确认的事：工具结果给模型机械事实，模型的话原样返回（宿主不再替换）', async () => {
    const registry = makeRegistry();
    const runner = makeRunner(registry, await flowExecutor(new ConfirmFlowClient(), registry, roundWorker([], { results: [] })));
    const modelText = '现在没有等你确认的事。还有其他要办的吗？';
    const { reply, toolResults } = await scriptedConfirmTurn({
      registry, runner, tool: 'task_confirm', args: {}, modelText,
    });
    // 工具结果 = 机械事实（不是给用户的成句话术）。
    expect(toolResults[0]).toMatchObject({
      outcome: 'no_waiting_task',
      fact: NO_WAITING_TARGET_FACT,
      runningTasks: 0,
    });
    expect(internalTermIn((toolResults[0] as { fact: string }).fact)).toBeUndefined();
    // 用户看到的就是脚本模型那句话（提交面不再有宿主替换字段）。
    expect(reply).toBe(modelText);
  });

  it('⑦ 有在跑的任务时：事实带 runningTasks=1；接续的 no-target 事实按 kind 区分', async () => {
    const registry = makeRegistry();
    // begin 缺省 status=running：本会话有一个在跑的任务。
    registry.begin({ taskId: 't_running', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '在跑的活' });
    const runner = makeRunner(registry, await flowExecutor(new ConfirmFlowClient(), registry, roundWorker([], { results: [] })));
    const confirm = await scriptedConfirmTurn({
      registry, runner, tool: 'task_confirm', args: {}, modelText: '现在没有等你确认的事。',
    });
    expect(confirm.toolResults[0]).toMatchObject({
      outcome: 'no_waiting_task',
      fact: NO_WAITING_TARGET_FACT,
      runningTasks: 1,
    });
    const resume = await scriptedConfirmTurn({
      registry, runner, tool: 'task_resume', args: { answer: '按这版' }, modelText: '当前没有等待接续的任务。',
    });
    expect(resume.toolResults[0]).toMatchObject({
      outcome: 'no_waiting_task',
      fact: NO_WAITING_RESUME_TARGET_FACT,
      runningTasks: 1,
    });
    expect(confirm.reply).toBe('现在没有等你确认的事。');
    expect(resume.reply).toBe('当前没有等待接续的任务。');
  });

  it('⑧ 提案回合走岔路：脚本模型不带摘要乱说 → 用户逐字收到它的话；任务仍 waiting_user、句柄未消费、执行层只调一次', async () => {
    const registry = makeRegistry();
    const client = new ConfirmFlowClient();
    const executor = await flowExecutor(client, registry, roundWorker([[PREPARE_ARGS]], { results: [] }));
    const runner = makeRunner(registry, executor);
    const modelText = '好，我先记下了，回头再说。';
    const mainDriver: TurnDriver = {
      async run(turnInput) {
        await turnInput.exec('task_run', { task: '把 alpha 集合提交到生产' });
        // 走岔路：不提要写入什么（不带摘要），只说一句进程话。
        return { text: modelText, messages: [] as unknown as DriverMessage[] };
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
      taskRunner: runner,
      taskDispatch: 'async',
      taskRunWaitMs: 0,
    });
    const turn = await session.send('把 alpha 集合提交到生产');
    await runner.whenIdle();

    // 用户可见面 = 模型原话（宿主不替换），且不含内部词/句柄。
    expect(turn.reply).toBe(modelText);
    expect(internalTermIn(turn.reply)).toBeUndefined();
    expect(JSON.stringify(turn)).not.toContain('cf_flow_1');
    // 机械闸不受影响：任务仍等待确认、句柄仍在底账、执行层没被重复调用。
    const task = registry.get(turn.taskIds[0]!, SCOPE);
    expect(task.status).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_flow_1');
    expect(client.requests).toHaveLength(1);
    for (const request of client.requests) expect(request.confirmation).toBeUndefined();
    // 提案摘要的机械事实在底账里（模型/用户面拿不到句柄）。
    expect(task.pendingQuestion?.confirmation?.summary).toBe(SUMMARY);
  });
});
