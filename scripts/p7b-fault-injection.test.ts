/**
 * R4 P7b · P7-T06 故障注入套件（TDD：先在红 → 最小实现转绿 → 反向绊线）。
 *
 * 范围（owner 2026-11-14 授权；6 类故障 + 重复消息幂等 + 重启三态）：
 *   ① 模型超时（假 driver 到截止无产出 / AbortError）；② Worker 崩溃（部分执行后崩溃）；
 *   ③ 通知失败（假 sink 拒绝/抛错/恢复）；④ 重复消息（假渠道同 messageId 重投 → 幂等）；
 *   ⑤ 池满（backgroundConcurrency=1 + queueCapacity=0 → 确定性拒绝 resource_limited）；
 *   ⑥ 重启三态（queued 重领 / running 租约过期 → result_unknown 不重放 / completed 不重跑）。
 *
 * 确定性断言口径（本套件先行冻结；对应 r4-acceptance.md 的 P7-T06 / R-D / R-E 与
 * r4-joint-interfaces.md §1/§4/§5；不改冻结判据、不改历史证据）：
 *   · 预期状态：任务终态按 P2 状态机落库（timed_out/timeout、failed/failed_confirmed、
 *     failed/result_unknown、failed/resource_limited）；
 *   · 不挂死：受理与收尾在有限步内完成；后台满载不阻塞前台（前台配额独立）；
 *   · 不重复副作用：同一故障/重投下执行端调用次数不增（driver/client/executor 计数钉住）；
 *   · 通知不丢：timed_out/failed/resource_limited 意图如实落库且 payload.reason 原样；
 *   · 假件：假 Main/Worker driver、假 executor、假 sink、假渠道（server.handler 渠道事实）
 *     + 仓内 dummy 配置；零网络、零真实模型、零真实平台。
 *
 * 已知先在红的两类（本提交即证据）：④ 重复消息（受理无 messageId 幂等）与
 * ⑤ 池满（queueCapacity=0 无「拒绝落点」，任务静默留在 queued）——见 P6 报告 §七 登记缺口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../packages/agent/src/driver-contract';
import { createTaskExecutor } from '../packages/agent/src/execution-runtime';
import {
  createNotificationOutbox,
  createNotificationReader,
  type Notification,
  type NotificationSink,
} from '../packages/agent/src/notifications';
import type { TaskRegistry, TaskScope } from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../packages/agent/src/task-runner';
import { assembleSessionCore } from './ask-runtime';
import { createServer } from '../apps/server/server';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

const dirs: string[] = [];
function tempDir(prefix = 'p7b-fault-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = {
  root: FIXTURE_ROOT,
  gateway: 'bin/dummy',
  skillRoots: ['.agents/skills-serve'],
};
const SCOPE_A: TaskScope = { principalId: 'wecom:user-a', sessionId: 'conv-a' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  executeCalls = 0;
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    this.executeCalls += 1;
    return { status: 'completed', data: {} };
  }
}

function unreachableDriver(): TurnDriver {
  return {
    async run() {
      throw new Error('（测试）该 driver 不应被调用');
    },
  };
}

interface MainPlan {
  delegates?: readonly string[];
  reply?: string;
}

interface MainDriverRecord {
  messages: readonly DriverMessage[];
  execResults: unknown[];
}

/**
 * 假 Main driver：按用户文本查计划并逐一委派；`numberReceipts` 时回执带累计回合号
 * （用于重复消息：重投若真的再跑一个 Main 回合，回执号会变化）。
 */
function fakeMainDriver(
  plans: ReadonlyMap<string, MainPlan>,
  records: MainDriverRecord[],
  options: { numberReceipts?: boolean } = {},
): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = plans.get(text);
      if (plan === undefined) throw new Error(`（测试）未配置计划的回合：${text}`);
      const execResults: unknown[] = [];
      for (const request of plan.delegates ?? []) {
        const tool = input.tools[0];
        if (tool === undefined) throw new Error('（测试）Main 无工具面');
        execResults.push(await input.exec(tool.name, { task: request }));
      }
      records.push({ messages: input.messages, execResults });
      const reply = plan.reply
        ?? (options.numberReceipts === true ? `已受理 #${records.length}。` : `（测试回复：${text}）`);
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

type ExecHandler = (input: TaskExecutionInput) => Promise<TaskExecutionOutcome>;

/** 假后台 executor：按入队顺序消费行为，记录每次调用（重复执行/重放计数用）。 */
class FakeExecutor implements TaskExecutor {
  readonly calls: TaskExecutionInput[] = [];
  private readonly handlers: ExecHandler[];

  constructor(handlers: readonly ExecHandler[] = []) {
    this.handlers = [...handlers];
  }

  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls.push(input);
    const handler = this.handlers.shift();
    if (handler === undefined) throw new Error('（测试）假 executor 没有配置行为');
    return await handler(input);
  }
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

/** 恒失败的假 sink（投递失败解耦断言用；不触网）。 */
class FailingSink implements NotificationSink {
  sends = 0;
  async send(): Promise<{ delivered: boolean; error: string }> {
    this.sends += 1;
    return { delivered: false, error: 'CHANNEL_DOWN' };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface AssembleOptions {
  dbPath: string;
  principalId?: string;
  sessionId?: string;
  mainPlans: ReadonlyMap<string, MainPlan>;
  records?: MainDriverRecord[];
  numberReceipts?: boolean;
  taskExecutor?: TaskExecutor;
  taskRegistry?: ReturnType<typeof createSqliteTaskRegistry>;
  notificationSink?: NotificationSink;
  backgroundConcurrency?: number;
  queueCapacity?: number;
  runnerOptions?: { leaseMs?: number; now?: () => Date; owner?: string };
}

/** background 模式装配（假执行面/假 driver/假 executor/假 sink），参数与集成联合测试同构。 */
async function assembleBackground(options: AssembleOptions): Promise<Awaited<ReturnType<typeof assembleSessionCore>>> {
  return await assembleSessionCore({
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    profile: PROFILE,
    principalId: options.principalId ?? SCOPE_A.principalId,
    sessionId: options.sessionId ?? SCOPE_A.sessionId,
    dbPath: options.dbPath,
    stateDir: path.join(path.dirname(options.dbPath), 'state'),
    setAuditPath: true,
    emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
    mainSystemPrompt: '（测试）Main 系统提示',
    workerSkills: [],
    createDrivers: () => ({
      mainDriver: fakeMainDriver(options.mainPlans, options.records ?? [], {
        ...(options.numberReceipts === undefined ? {} : { numberReceipts: options.numberReceipts }),
      }),
      workerDriver: unreachableDriver(),
    }),
    createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
    runtime: {
      dispatchMode: 'background',
      backgroundConcurrency: options.backgroundConcurrency ?? 1,
      queueCapacity: options.queueCapacity ?? 0,
    },
    ...(options.taskExecutor === undefined ? {} : { taskExecutor: options.taskExecutor }),
    ...(options.notificationSink === undefined ? {} : { notificationSink: options.notificationSink }),
    ...(options.taskRegistry === undefined ? {} : { taskRegistry: options.taskRegistry }),
    ...(options.runnerOptions === undefined ? {} : { runnerOptions: options.runnerOptions }),
  });
}

/** 收尾静默：等在飞回合落定；红期或清理中错误不改变测试结论。 */
async function settleQuietly(assembled: Awaited<ReturnType<typeof assembleSessionCore>>): Promise<void> {
  try {
    await assembled.runner?.whenIdle();
  } catch {
    // 忽略：测试结论由断言决定
  }
}

describe('P7-T06 故障注入 · ① 模型超时（假 driver）', () => {
  it('①-1 到截止无产出（真驱动契约：返回空文本）→ timed_out/timeout；不挂死；通知与前台正常', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    let clock = 1_000_000;
    const now = (): number => clock;
    let driverCalls = 0;
    const timeoutDriver: TurnDriver = {
      async run(input) {
        driverCalls += 1;
        clock += 1000; // 越过 workerTurnMs(=1000)：模拟驱动到截止中止且无产出（pi-driver 同款结局）
        return { text: '', messages: input.messages };
      },
    };
    const executor = await createTaskExecutor({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      workerDriver: timeoutDriver,
      registry,
      workerTurnMs: 1000,
      now,
    });
    const sink = new FakeSink();
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['查一下 documents', { delegates: ['查一下 documents'], reply: '已受理。' }],
      ['现在有空吗', { reply: '前台可用。' }],
    ]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      taskRegistry: registry,
      notificationSink: sink,
      mainPlans: plans,
      records,
    });
    try {
      const turn = await assembled.session.send('查一下 documents');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle(); // 「不挂死」：有限步内收尾
      const task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('timed_out');
      expect(task.reason).toBe('timeout');
      expect(task.replyText).toBeUndefined(); // 超时不产生结果存档（不以汇报冒充）
      expect(driverCalls).toBe(1); // 不重放
      // 通知如实：timed_out 意图 + reason=timeout，投递可达
      await assembled.notifications!.deliverPending();
      const reader = createNotificationReader(dbPath);
      const rows = reader.listNotifications(taskId);
      reader.close();
      expect(rows.map((row) => row.kind)).toEqual(['accepted', 'started', 'timed_out']);
      expect(rows.find((row) => row.kind === 'timed_out')!.payload.reason).toBe('timeout');
      expect(rows.every((row) => row.deliveredAt !== undefined)).toBe(true);
      // 超时不永久占用资源；前台仍可用
      expect(assembled.policy.snapshot().background.active).toBe(0);
      const second = await assembled.session.send('现在有空吗');
      expect(second.reply).toBe('前台可用。');
      expect(assembled.policy.snapshot().foreground.active).toBe(0);
    } finally {
      await settleQuietly(assembled);
      assembled.close();
      registry.close();
    }
  });

  it('①-2 驱动以 AbortError 结束在截止之后 → 同样 timed_out（不误判 failed）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    let clock = 2_000_000;
    let driverCalls = 0;
    const abortDriver: TurnDriver = {
      async run() {
        driverCalls += 1;
        clock += 1000;
        const error = new Error('（测试）回合到截止被中止');
        error.name = 'AbortError';
        throw error;
      },
    };
    const executor = await createTaskExecutor({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      workerDriver: abortDriver,
      registry,
      workerTurnMs: 1000,
      now: () => clock,
    });
    const plans = new Map<string, MainPlan>([['查 documents', { delegates: ['查 documents'], reply: '已受理。' }]]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, taskRegistry: registry, mainPlans: plans });
    try {
      const turn = await assembled.session.send('查 documents');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      const task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('timed_out');
      expect(task.reason).toBe('timeout');
      expect(driverCalls).toBe(1);
    } finally {
      await settleQuietly(assembled);
      assembled.close();
      registry.close();
    }
  });
});

describe('P7-T06 故障注入 · ② Worker 崩溃（假 driver）', () => {
  it('② 部分执行后崩溃 → failed/failed_confirmed；已发生调用保留、不重放、无结果存档', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    const client = new FaceClient();
    let driverCalls = 0;
    const crashDriver: TurnDriver = {
      async run(input) {
        driverCalls += 1;
        await input.exec('execute_operation', { operation: 'dummy.query', args: {} });
        throw new Error('（假件）Worker 回合崩溃');
      },
    };
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.query'],
      workerDriver: crashDriver,
      registry,
      workerTurnMs: 1000,
      now: () => 3_000_000,
    });
    const sink = new FakeSink();
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['查一下 documents', { delegates: ['查一下 documents'], reply: '已受理。' }]]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      taskRegistry: registry,
      notificationSink: sink,
      mainPlans: plans,
      records,
    });
    try {
      const turn = await assembled.session.send('查一下 documents');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      const task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('failed');
      expect(task.reason).toBe('failed_confirmed');
      expect(task.failureReason).toContain('Worker 回合崩溃');
      expect(task.replyText).toBeUndefined(); // 崩溃不冒充完成
      // 已发生的执行事实保留（部分执行 ≠ 成功），且不重放
      expect(task.executions).toHaveLength(1);
      expect(task.executions[0]!.status).toBe('completed');
      expect(driverCalls).toBe(1);
      expect(client.executeCalls).toBe(1);
      await assembled.notifications!.deliverPending();
      const reader = createNotificationReader(dbPath);
      const rows = reader.listNotifications(taskId);
      reader.close();
      expect(rows.map((row) => row.kind)).toEqual(['accepted', 'started', 'failed']);
      expect(rows.find((row) => row.kind === 'failed')!.payload.reason).toBe('failed_confirmed');
    } finally {
      await settleQuietly(assembled);
      assembled.close();
      registry.close();
    }
  });
});

describe('P7-T06 故障注入 · ③ 通知失败（假 sink）', () => {
  it('③-1 投递失败不改变任务结果：任务 completed、结果可取回；未送达可见（attempts/lastError）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const sink = new FailingSink();
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: '结果全文' })]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['任务A', { delegates: ['任务A'], reply: '已受理。' }]]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, notificationSink: sink, mainPlans: plans, records });
    try {
      const turn = await assembled.session.send('任务A');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      await assembled.notifications!.deliverPending();
      const reader = createNotificationReader(dbPath);
      const rows = reader.listNotifications(taskId);
      reader.close();
      expect(sink.sends).toBe(3);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.deliveredAt === undefined)).toBe(true);
      expect(rows.every((row) => row.attempts >= 1)).toBe(true);
      expect(rows.every((row) => row.lastError === 'CHANNEL_DOWN')).toBe(true);
      // 任务结果与投递解耦：completed + 结果可取回，无失败痕迹
      const task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('completed');
      expect(task.replyText).toBe('结果全文');
      expect(task.failureReason).toBeUndefined();
      expect(task.reason).toBeUndefined();
    } finally {
      await settleQuietly(assembled);
      assembled.close();
    }
  });

  it('③-2 假 sink 抛异常不逃逸：attempts 递增、有界停止、未送达仍可见（exhausted）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    let clock = Date.parse('2026-11-14T00:00:00.000Z');
    const outbox = createNotificationOutbox({
      dbPath,
      sink: {
        async send() {
          throw new Error('SINK_CRASH');
        },
      },
      maxAttempts: 2,
      baseBackoffMs: 1000,
      now: () => new Date(clock),
    });
    try {
      outbox.record({ taskId: 'task_n', kind: 'completed', at: new Date(clock).toISOString(), taskNo: 1, name: '任务' });
      const first = await outbox.deliverPending();
      expect(first).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1, error: 'SINK_CRASH' }]);
      clock += 1001; // 越过退避
      const second = await outbox.deliverPending();
      expect(second).toMatchObject([{ outcome: 'stopped', attempts: 2 }]);
      const row = outbox.listNotifications('task_n')[0]!;
      expect(row.deliveredAt).toBeUndefined();
      expect(row.exhausted).toBe(true);
      expect(row.attempts).toBe(2);
      expect(row.lastError).toBe('SINK_CRASH');
    } finally {
      outbox.close();
    }
  });

  it('③-3 恢复后重投递成功（同进程有界重试）：失败 → 退避到期 → delivered', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    let clock = Date.parse('2026-11-14T00:00:00.000Z');
    let sends = 0;
    const outbox = createNotificationOutbox({
      dbPath,
      sink: {
        async send() {
          sends += 1;
          return sends === 1 ? { delivered: false, error: 'CHANNEL_DOWN' } : { delivered: true };
        },
      },
      maxAttempts: 3,
      baseBackoffMs: 1000,
      now: () => new Date(clock),
    });
    try {
      outbox.record({ taskId: 'task_r', kind: 'completed', at: new Date(clock).toISOString(), taskNo: 1, name: '任务' });
      const first = await outbox.deliverPending();
      expect(first).toMatchObject([{ outcome: 'retry_scheduled', attempts: 1 }]);
      clock += 1001;
      const second = await outbox.deliverPending();
      expect(second).toMatchObject([{ outcome: 'delivered', attempts: 2 }]);
      const row = outbox.listNotifications('task_r')[0]!;
      expect(row.deliveredAt).toBeDefined();
      expect(row.lastError).toBeUndefined();
      expect(row.exhausted).toBe(false);
    } finally {
      outbox.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 重复消息（假渠道）：同 messageId 重投必须幂等——不新增任务、不重复执行、
//    回执幂等重放（历史 D-119 口径：「查重先于一切副作用，回执重放」）。
// ---------------------------------------------------------------------------

function serverConfig(mode: 'inline' | 'background'): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    ...(mode === 'background'
      ? { runtime: { dispatchMode: 'background' as const, backgroundConcurrency: 1, queueCapacity: 0 } }
      : {}),
  };
}

function incoming(messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

describe('P7-T06 故障注入 · ④ 重复消息（假渠道同 messageId 重投）', () => {
  it('④-1 后台模式：重投不新增任务/不重复执行，回执幂等重放（查重先于副作用）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([
      async () => await gate.promise,
      async () => ({ kind: 'completed', resultText: '完成' }),
    ]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['查一下 documents', { delegates: ['查一下 documents'] }]]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: serverConfig('background'),
      dbPath,
      createDrivers: () => ({
        mainDriver: fakeMainDriver(plans, records, { numberReceipts: true }),
        workerDriver: unreachableDriver(),
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
      taskExecutor: executor,
      notificationSink: new FakeSink(),
      logger: () => {},
    });
    const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
    try {
      const message = incoming('msg-dup', '查一下 documents');
      const [first, second] = await Promise.all([server.handler(message), server.handler(message)]);
      expect(second).toBe(first); // 回执幂等重放（重投不得出现新受理号）
      expect(records).toHaveLength(1); // 查重先于 Main 回合：重投不再跑模型
      expect(registry.list(SCOPE_A)).toHaveLength(1); // 不新增任务
      expect(executor.calls).toHaveLength(1); // 不重复执行
      gate.resolve({ kind: 'completed', resultText: '完成' });
      await vi.waitFor(() => expect(registry.get(registry.list(SCOPE_A)[0]!.taskId, SCOPE_A).status).toBe('completed'));
      expect(executor.calls).toHaveLength(1); // 收尾后仍无第二次执行
    } finally {
      server.close();
      registry.close();
    }
  });

  it('④-2 inline 模式：重投不新增任务/不重复执行层调用，回执幂等重放', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const face = new FaceClient();
    let workerCalls = 0;
    const workerDriver: TurnDriver = {
      async run(input) {
        workerCalls += 1;
        await input.exec('execute_operation', { operation: 'dummy.query', args: {} });
        const text = '（执行层汇报）查询完成。';
        return { text, messages: [...input.messages, { role: 'assistant', content: text } as never] };
      },
    };
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['查一下 documents', { delegates: ['查一下 documents'] }]]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: serverConfig('inline'),
      dbPath,
      createDrivers: () => ({
        mainDriver: fakeMainDriver(plans, records, { numberReceipts: true }),
        workerDriver,
      }),
      createExecutionFace: async () => ({ client: face, allowedOperations: ['dummy.query'] }),
      logger: () => {},
    });
    const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
    try {
      const message = incoming('msg-dup-inline', '查一下 documents');
      const [first, second] = await Promise.all([server.handler(message), server.handler(message)]);
      expect(second).toBe(first);
      expect(records).toHaveLength(1);
      expect(registry.list(SCOPE_A)).toHaveLength(1);
      expect(workerCalls).toBe(1);
      expect(face.executeCalls).toBe(1);
    } finally {
      server.close();
      registry.close();
    }
  });
});

describe('P7-T06 故障注入 · ⑤ 池满（backgroundConcurrency=1 + queueCapacity=0）', () => {
  it('⑤ 满员新交办确定性拒绝 resource_limited；运行中任务不受损；无积压；前台可用', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([
      async () => await gate.promise,
      async () => ({ kind: 'failed', reason: '（测试）拒绝路径不应派发执行' }),
      async () => ({ kind: 'failed', reason: '（测试）拒绝路径不应派发执行' }),
    ]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['第一件慢事', { delegates: ['第一件慢事'], reply: '第一件已受理。' }],
      ['第二件', { delegates: ['第二件'], reply: '第二件回执。' }],
      ['第三件', { delegates: ['第三件'], reply: '第三件回执。' }],
      ['现在有空吗', { reply: '前台可用。' }],
    ]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      mainPlans: plans,
      records,
      backgroundConcurrency: 1,
      queueCapacity: 0,
    });
    try {
      const first = await assembled.session.send('第一件慢事');
      const task1 = first.taskIds[0]!;
      expect(assembled.taskRegistry.get(task1, SCOPE_A).status).toBe('running');
      expect(executor.calls.map((call) => call.taskId)).toEqual([task1]);

      // 满员 → 确定性拒绝（机械面：受理工具结果 accepted=false + reason=resource_limited；
      // 任务终态按 P2 状态机落库 failed+resource_limited；话术不判——那是模型面）
      const second = await assembled.session.send('第二件');
      const receipt2 = records[1]!.execResults[0] as Record<string, unknown>;
      expect(receipt2).toMatchObject({ accepted: false, reason: 'resource_limited' });
      const task2 = String(receipt2['taskId']);
      expect(assembled.taskRegistry.get(task2, SCOPE_A).status).toBe('failed');
      expect(assembled.taskRegistry.get(task2, SCOPE_A).reason).toBe('resource_limited');
      // 无无限积压：没有 queued 行；拒绝任务不进入执行
      expect(assembled.taskRegistry.list(SCOPE_A).filter((task) => task.status === 'queued')).toHaveLength(0);
      expect(executor.calls.map((call) => call.taskId)).toEqual([task1]);

      const third = await assembled.session.send('第三件');
      const receipt3 = records[2]!.execResults[0] as Record<string, unknown>;
      expect(receipt3).toMatchObject({ accepted: false, reason: 'resource_limited' });
      expect(executor.calls.map((call) => call.taskId)).toEqual([task1]);

      // 前台配额独立：后台满载仍可确定性查询
      const front = await assembled.session.send('现在有空吗');
      expect(front.reply).toBe('前台可用。');
      expect(assembled.policy.snapshot().foreground.active).toBe(0);

      // 放行：运行中任务正常收尾；拒绝任务不被改写、不被补派发
      gate.resolve({ kind: 'completed', resultText: '第一件完成' });
      await assembled.runner!.whenIdle();
      expect(assembled.taskRegistry.get(task1, SCOPE_A).status).toBe('completed');
      expect(assembled.taskRegistry.get(task2, SCOPE_A).status).toBe('failed');
      expect(assembled.taskRegistry.get(task2, SCOPE_A).reason).toBe('resource_limited');
      expect(executor.calls.map((call) => call.taskId)).toEqual([task1]);

      // 拒绝通知：resource_limited 意图如实落库（九类枚举之一）
      const reader = createNotificationReader(dbPath);
      const rows = reader.listNotifications(task2);
      reader.close();
      expect(rows.some((row) => row.kind === 'resource_limited')).toBe(true);
    } finally {
      gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });
});

describe('P7-T06 故障注入 · ⑥ 重启三态（queued 重领 / unknown 不重放 / completed 不重跑）', () => {
  it('⑥ 重启恢复：三态处置 + 通知不重复/如实承载 result_unknown', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    let registryRef: TaskRegistry | undefined;
    const executor1 = new FakeExecutor([
      // 执行端确认完成前，已向底账记录一次执行调用（「不重放副作用」的审计行基线）
      async (input) => {
        registryRef?.noteExecution(input.taskId, { requestId: 'req_done_1', operation: 'dummy.query', status: 'completed' });
        return { kind: 'completed', resultText: '第一次结果' };
      },
      async () => await gate.promise,
    ]);
    const first = await assembleBackground({
      dbPath,
      taskExecutor: executor1,
      mainPlans: new Map(),
      notificationSink: new FakeSink(),
    });
    registryRef = first.taskRegistry;
    first.runner!.submit({ taskId: 'task_done', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '已完成任务' });
    first.runner!.pump();
    await first.runner!.whenIdle();
    expect(first.taskRegistry.get('task_done', SCOPE_A).status).toBe('completed');

    first.runner!.submit({ taskId: 'task_running', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '在飞任务' });
    first.runner!.pump();
    await vi.waitFor(() => expect(executor1.calls).toHaveLength(2));
    expect(first.taskRegistry.get('task_running', SCOPE_A).leaseUntil).toBeDefined();

    first.runner!.submit({ taskId: 'task_queued', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '排队任务' });
    // 不 pump：受理后进程中断（queued 行留在底账）
    first.close();

    // 新进程：同一底账、新 runner，注入未来时钟使租约过期
    const executor2 = new FakeExecutor([async () => ({ kind: 'completed', resultText: '重启后结果' })]);
    const second = await assembleBackground({
      dbPath,
      taskExecutor: executor2,
      mainPlans: new Map(),
      notificationSink: new FakeSink(),
      runnerOptions: { now: () => new Date(Date.now() + 3_600_000) },
    });
    try {
      const summary = second.runner!.pump();
      await second.runner!.whenIdle();
      expect(summary.recovered).toEqual(['task_running']);
      // unknown 不重放：执行端只收到 queued 任务
      expect(executor2.calls.map((call) => call.taskId)).toEqual(['task_queued']);
      const running = second.taskRegistry.get('task_running', SCOPE_A);
      expect(running.status).toBe('failed');
      expect(running.reason).toBe('result_unknown');
      // completed 不重跑：审计执行行零新增（不重放副作用）
      const done = second.taskRegistry.get('task_done', SCOPE_A);
      expect(done.status).toBe('completed');
      expect(done.executions).toHaveLength(1);
      // queued 重领：同一任务、编号不变、执行追加、结果存档
      const queued = second.taskRegistry.get('task_queued', SCOPE_A);
      expect(queued.status).toBe('completed');
      expect(queued.taskNo).toBe(3);
      expect(queued.replyText).toBe('重启后结果');
      // 通知不重复、不丢失：unknown 以 failed 意图 + result_unknown 原因承载
      const reader = createNotificationReader(dbPath);
      const doneRows = reader.listNotifications('task_done');
      const runningRows = reader.listNotifications('task_running');
      const queuedRows = reader.listNotifications('task_queued');
      reader.close();
      expect(doneRows.map((row) => row.kind)).toEqual(['accepted', 'started', 'completed']);
      expect(runningRows.map((row) => row.kind)).toEqual(['accepted', 'started', 'failed']);
      expect(runningRows.find((row) => row.kind === 'failed')!.payload.reason).toBe('result_unknown');
      expect(queuedRows.map((row) => row.kind)).toEqual(['accepted', 'started', 'completed']);
    } finally {
      second.close();
    }
  });
});
