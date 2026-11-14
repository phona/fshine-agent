/**
 * R4 集成 Run 联合测试（先在红；接线转绿）：P5 资源强制 + P6 后台派发 + P4 通知 + resultText 存档。
 *
 * 全部假件（假 Main driver / 假执行面 / 假 executor / 假 sink），零网络、零真实模型、零真实平台；
 * background 模式确定性。inline 缺省路径不在此文件（由既有金样覆盖）。
 *
 * 焦点（任务书 §③）：
 *   ① 受理快速返回；② 并发受 policy 限制；③ waiting_user 释放并同 Task 接续；④ 通知生成/去重/投递；
 *   ⑤ 重启恢复（queued 重领 / unknown 不重放 / completed 不重跑）；⑥ 取消请求不被报成已取消；
 *   ⑦ 多用户归属不绕过；⑧ resultText 经 archiveReply 取回；⑨ dispatchMode 配置面；⑩ tasks 通知展示。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextProfileConfig } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { loadConfig } from '@fshine/core';
import type { DriverMessage, TurnDriver } from '../packages/agent/src/driver-contract';
import {
  createNotificationReader,
  type Notification,
  type NotificationSink,
} from '../packages/agent/src/notifications';
import { TaskOwnershipError, type TaskRecord, type TaskRegistry, type TaskScope } from '../packages/agent/src/task-registry';
import type {
  TaskExecutionInput,
  TaskExecutionContext,
  TaskExecutionOutcome,
  TaskExecutor,
} from '../packages/agent/src/task-runner';
import { assembleAskRuntime, assembleSessionCore } from './ask-runtime';
import { renderTaskDetail } from './tasks';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

const dirs: string[] = [];
function tempDir(prefix = 'r4-integ-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE: ContextProfileConfig = {
  root: FIXTURE_ROOT,
  gateway: 'bin/dummy',
  skillRoots: ['.agents/skills-serve'],
};

const SCOPE_A: TaskScope = { principalId: 'wecom:user-a', sessionId: 'conv-a' };
const SCOPE_B: TaskScope = { principalId: 'wecom:user-b', sessionId: 'conv-b' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
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

/** 假 Main driver：按用户文本查计划，逐一委派并记录 run_task 的返回（即受理事实）。 */
function fakeMainDriver(plans: ReadonlyMap<string, MainPlan>, records: MainDriverRecord[]): TurnDriver {
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
      const reply = plan.reply ?? `（测试回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

type ExecHandler = (input: TaskExecutionInput, context: TaskExecutionContext) => Promise<TaskExecutionOutcome>;

/** 假后台 executor：按入队顺序消费行为，记录调用/并发峰值（并发上限断言用）。 */
class FakeExecutor implements TaskExecutor {
  readonly calls: TaskExecutionInput[] = [];
  readonly contexts: TaskExecutionContext[] = [];
  maxActive = 0;
  private active = 0;
  private readonly handlers: ExecHandler[];

  constructor(handlers: readonly ExecHandler[] = []) {
    this.handlers = [...handlers];
  }

  async execute(input: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.calls.push(input);
    this.contexts.push(context);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const handler = this.handlers.shift();
    if (handler === undefined) throw new Error('（测试）假 executor 没有配置行为');
    try {
      return await handler(input, context);
    } finally {
      this.active -= 1;
    }
  }
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean; error?: string }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

/** 恒失败的假 sink（通知投递失败解耦断言用；不触网）。 */
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
  backgroundConcurrency?: number;
  mainPlans: ReadonlyMap<string, MainPlan>;
  records?: MainDriverRecord[];
  taskExecutor?: TaskExecutor;
  notificationSink?: NotificationSink;
  taskRegistry?: TaskRegistry;
  runnerOptions?: { leaseMs?: number; now?: () => Date; owner?: string };
}

/** background 模式装配（假执行面/假 driver/假 executor/假 sink）。 */
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
      mainDriver: fakeMainDriver(options.mainPlans, options.records ?? []),
      workerDriver: unreachableDriver(),
    }),
    createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
    runtime: { dispatchMode: 'background', backgroundConcurrency: options.backgroundConcurrency ?? 1 },
    ...(options.taskExecutor === undefined ? {} : { taskExecutor: options.taskExecutor }),
    ...(options.notificationSink === undefined ? {} : { notificationSink: options.notificationSink }),
    ...(options.taskRegistry === undefined ? {} : { taskRegistry: options.taskRegistry }),
    ...(options.runnerOptions === undefined ? {} : { runnerOptions: options.runnerOptions }),
  });
}

/** 收尾静默：关闭底账前等在飞回合落定；红期（runner 未接线）或清理中错误不改变测试结论。 */
async function settleQuietly(assembled: Awaited<ReturnType<typeof assembleSessionCore>>): Promise<void> {
  try {
    await assembled.runner?.whenIdle();
  } catch {
    // 忽略：测试结论由断言决定
  }
}

describe('R4 联合：P6 后台受理与执行（background 模式，假 executor）', () => {
  it('① 受理快速返回：Main 拿到 queued 受理事实，不等待后台执行', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([async () => await gate.promise]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['查一下 documents 窗口 W202611', { delegates: ['查 documents 窗口 W202611'], reply: '已受理。' }],
    ]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, mainPlans: plans, records });
    try {
      const turn = await assembled.session.send('查一下 documents 窗口 W202611');
      // 回合已返回（executor 仍挂起）：受理与执行解耦
      expect(executor.calls).toHaveLength(1);
      expect(turn.taskIds).toHaveLength(1);
      const taskId = turn.taskIds[0]!;
      const accepted = records[0]!.execResults[0] as Record<string, unknown>;
      expect(accepted).toMatchObject({ taskId, status: 'queued', accepted: true });
      expect(accepted['taskNo']).toBe(1);
      expect(String(accepted['name']).length).toBeGreaterThan(0);
      expect(String(accepted['notice'])).toContain('#1');
      // 受理后已触发派发：行进入 running，尚未终态
      expect(assembled.taskRegistry.get(taskId, SCOPE_A).status).toBe('running');
      // 放行后台回合 → 收尾 completed
      gate.resolve({ kind: 'completed', resultText: 'documents W202611 共 3 条。' });
      await assembled.runner!.whenIdle();
      expect(assembled.taskRegistry.get(taskId, SCOPE_A).status).toBe('completed');
    } finally {
      gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });

  it('② 并发受 policy 限制：backgroundConcurrency=1 时任务串行，其余留在 queued', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gates = [deferred<TaskExecutionOutcome>(), deferred<TaskExecutionOutcome>(), deferred<TaskExecutionOutcome>()];
    const executor = new FakeExecutor(gates.map((gate) => async () => await gate.promise));
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['任务一', { delegates: ['任务一'], reply: 'r1' }],
      ['任务二', { delegates: ['任务二'], reply: 'r2' }],
      ['任务三', { delegates: ['任务三'], reply: 'r3' }],
    ]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, mainPlans: plans, records });
    try {
      const turns = [
        await assembled.session.send('任务一'),
        await assembled.session.send('任务二'),
        await assembled.session.send('任务三'),
      ];
      const ids = turns.map((turn) => turn.taskIds[0]!);
      const statusOf = (taskId: string): string => assembled.taskRegistry.get(taskId, SCOPE_A).status;
      expect(executor.calls).toHaveLength(1);
      expect(ids.map(statusOf)).toEqual(['running', 'queued', 'queued']);
      gates[0]!.resolve({ kind: 'completed', resultText: '一完成' });
      await vi.waitFor(() => expect(executor.calls).toHaveLength(2));
      gates[1]!.resolve({ kind: 'completed', resultText: '二完成' });
      await vi.waitFor(() => expect(executor.calls).toHaveLength(3));
      gates[2]!.resolve({ kind: 'completed', resultText: '三完成' });
      await assembled.runner!.whenIdle();
      expect(executor.maxActive).toBe(1);
      expect(ids.map(statusOf)).toEqual(['completed', 'completed', 'completed']);
    } finally {
      for (const gate of gates) gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });

  it('③ waiting_user：释放后台许可，答复接续同一 Task（taskNo 不变）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const first = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([
      async () => await first.promise,
      async (input) => {
        expect(input.answer).toBe('W202611');
        return { kind: 'completed', resultText: '结果：3 条。' };
      },
    ]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['查 documents', { delegates: ['查 documents'] }]]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, mainPlans: plans, records });
    try {
      const turn = await assembled.session.send('查 documents');
      const taskId = turn.taskIds[0]!;
      await vi.waitFor(() => expect(executor.calls).toHaveLength(1));
      first.resolve({ kind: 'needs_input', question: { missing: ['窗口'] } });
      await assembled.runner!.whenIdle();
      let task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('waiting_user');
      expect(task.pendingQuestion).toEqual({ missing: ['窗口'] });
      // 挂起期间执行资源归零（许可已释放；预算保留由 P5 单测覆盖）
      expect(assembled.policy.snapshot().background.active).toBe(0);
      const resumed = assembled.runner!.resume(taskId, { answer: 'W202611', scope: SCOPE_A });
      expect(resumed).toMatchObject({ outcome: 'started', taskId });
      await vi.waitFor(() => expect(executor.calls).toHaveLength(2));
      await assembled.runner!.whenIdle();
      task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('completed');
      expect(task.taskNo).toBe(1);
      expect(task.replyText).toBe('结果：3 条。');
    } finally {
      first.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });

  it('⑤ 重启恢复：queued 重领 / 过期租约 result_unknown 不重放 / completed 不重跑', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const pending = deferred<TaskExecutionOutcome>();
    const executor1 = new FakeExecutor([
      async () => ({ kind: 'completed', resultText: '第一次结果' }),
      async () => await pending.promise,
    ]);
    const first = await assembleBackground({ dbPath, taskExecutor: executor1, mainPlans: new Map() });
    first.runner!.submit({ taskId: 'task_done', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '已完成任务' });
    first.runner!.pump();
    await first.runner!.whenIdle();
    expect(first.taskRegistry.get('task_done', SCOPE_A).status).toBe('completed');

    first.runner!.submit({ taskId: 'task_running', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '在飞任务' });
    first.runner!.pump();
    await vi.waitFor(() => expect(executor1.calls).toHaveLength(2));
    first.runner!.submit({ taskId: 'task_queued', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId, request: '排队任务' });
    first.runner!.pump();
    expect(first.taskRegistry.get('task_queued', SCOPE_A).status).toBe('queued');
    first.close(); // 进程终止（在飞回合悬置）

    // 新进程：同一底账、新 runner，注入未来时钟使租约过期
    const executor2 = new FakeExecutor([async () => ({ kind: 'completed', resultText: '重启后结果' })]);
    const second = await assembleBackground({
      dbPath,
      taskExecutor: executor2,
      mainPlans: new Map(),
      runnerOptions: { now: () => new Date(Date.now() + 3_600_000) },
    });
    try {
      const summary = second.runner!.pump();
      await second.runner!.whenIdle();
      expect(summary.recovered).toEqual(['task_running']);
      const running = second.taskRegistry.get('task_running', SCOPE_A);
      expect(running.status).toBe('failed');
      expect(running.reason).toBe('result_unknown');
      // unknown 不重放：执行端零调用
      expect(executor2.calls.map((call) => call.taskId)).toEqual(['task_queued']);
      expect(second.taskRegistry.get('task_queued', SCOPE_A).status).toBe('completed');
      // completed 不重跑
      expect(second.taskRegistry.get('task_done', SCOPE_A).status).toBe('completed');
    } finally {
      // 在飞回合永久悬置（重启场景）；不 resolve、不在关库后收尾。
      second.close();
    }
  });

  it('⑥ 取消请求不被报成已取消：确认才 cancelled；未获确认回滚后如实收尾', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const secondGate = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([
      // 任务一：观察 abort 后确认取消
      async (_input, context) => {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) return resolve();
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { kind: 'cancelled' };
      },
      // 任务二：忽略 cancel 请求，照常完成（中止未获确认）
      async () => await secondGate.promise,
    ]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['任务一', { delegates: ['任务一'] }],
      ['任务二', { delegates: ['任务二'] }],
    ]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, mainPlans: plans, records });
    try {
      const first = await assembled.session.send('任务一');
      const taskId1 = first.taskIds[0]!;
      await vi.waitFor(() => expect(executor.calls).toHaveLength(1));
      expect(assembled.runner!.cancel(taskId1, SCOPE_A)).toEqual({ outcome: 'requested', taskId: taskId1 });
      expect(assembled.taskRegistry.get(taskId1, SCOPE_A).status).toBe('cancelling');
      await vi.waitFor(() => expect(assembled.taskRegistry.get(taskId1, SCOPE_A).status).toBe('cancelled'));
      expect(assembled.taskRegistry.get(taskId1, SCOPE_A).reason).toBe('cancelled_by_user');

      const second = await assembled.session.send('任务二');
      const taskId2 = second.taskIds[0]!;
      await vi.waitFor(() => expect(executor.calls).toHaveLength(2));
      expect(assembled.runner!.cancel(taskId2, SCOPE_A)).toEqual({ outcome: 'requested', taskId: taskId2 });
      expect(assembled.taskRegistry.get(taskId2, SCOPE_A).status).toBe('cancelling');
      secondGate.resolve({ kind: 'completed', resultText: '照常完成' });
      await vi.waitFor(() => expect(assembled.taskRegistry.get(taskId2, SCOPE_A).status).toBe('completed'));
      // 未获确认：不得宣称取消
      expect(assembled.taskRegistry.get(taskId2, SCOPE_A).reason).toBeUndefined();
    } finally {
      secondGate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });

  it('⑦ 多用户归属不绕过：越权读/取消/接续/转换同一 TaskOwnershipError', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    const executorA = new FakeExecutor([async () => await gate.promise]);
    const plansA = new Map<string, MainPlan>([['A 的任务', { delegates: ['A 的任务'] }]]);
    const a = await assembleBackground({ dbPath, taskExecutor: executorA, mainPlans: plansA });
    const b = await assembleBackground({
      dbPath,
      principalId: SCOPE_B.principalId,
      sessionId: SCOPE_B.sessionId,
      taskExecutor: new FakeExecutor(),
      mainPlans: new Map(),
      taskRegistry: a.taskRegistry,
    });
    try {
      await a.session.send('A 的任务');
      const taskId = a.session.tasks()[0]!.taskId;
      expect(() => b.session.getTask(taskId)).toThrowError(TaskOwnershipError);
      expect(() => b.taskRegistry.get(taskId, SCOPE_B)).toThrowError(TaskOwnershipError);
      expect(b.session.tasks()).toHaveLength(0);
      expect(() => b.runner!.cancel(taskId, SCOPE_B)).toThrowError(TaskOwnershipError);
      expect(() => b.runner!.resume(taskId, { scope: SCOPE_B })).toThrowError(TaskOwnershipError);
      expect(() => b.taskRegistry.transition(taskId, 'cancelling', { scope: SCOPE_B })).toThrowError(TaskOwnershipError);
      // 归属事实不回退：任务仍在 A 名下 running
      expect(a.taskRegistry.get(taskId, SCOPE_A).status).toBe('running');
    } finally {
      gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(a);
      b.close();
      a.close();
    }
  });

  it('⑧ resultText 经 archiveReply 逐字存档（结果可找回，不被受理话术覆盖）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' })]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['查 documents W202611', { delegates: ['查 documents W202611'], reply: '已受理。' }]]);
    const assembled = await assembleBackground({ dbPath, taskExecutor: executor, mainPlans: plans, records });
    try {
      const turn = await assembled.session.send('查 documents W202611');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      const task = assembled.session.getTask(taskId);
      expect(task.status).toBe('completed');
      expect(task.replyText).toBe('W202611：documents 共 3 条。');
    } finally {
      await settleQuietly(assembled);
      assembled.close();
    }
  });
});

describe('R4 联合：P5 前台许可（inline 模式）', () => {
  it('⑭ 前台被占满时确定性拒绝；释放后可再入且回合结束已释放（P5 强制点）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['你好', { reply: '你好。' }]]);
    const assembled = await assembleSessionCore({
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
      profile: PROFILE,
      principalId: SCOPE_A.principalId,
      sessionId: SCOPE_A.sessionId,
      dbPath,
      stateDir: path.join(path.dirname(dbPath), 'state'),
      setAuditPath: true,
      emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
      mainSystemPrompt: '（测试）Main 系统提示',
      workerSkills: [],
      createDrivers: () => ({
        mainDriver: fakeMainDriver(plans, records),
        workerDriver: unreachableDriver(),
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
      runtime: { dispatchMode: 'inline' },
    });
    try {
      const held = assembled.policy.acquire('foreground', { taskId: '外部回合' });
      if (held.ok === false) throw new Error('（测试）前台许可应可准入');
      await expect(assembled.session.send('你好')).rejects.toThrowError(/前台回合被资源策略拒绝/);
      assembled.policy.release(held);
      const turn = await assembled.session.send('你好');
      expect(turn.reply).toBe('你好。');
      // 回合结束已释放：账本归零（不泄漏许可）
      expect(assembled.policy.snapshot().foreground.active).toBe(0);
    } finally {
      assembled.close();
    }
  });

  it('⑮ inline 委派派生许可：深度超限确定性拒绝，落 resource_limited 且不进入执行', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['任务X', { delegates: ['任务X'], reply: '（不应到达）' }]]);
    const assembled = await assembleSessionCore({
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
      profile: PROFILE,
      principalId: SCOPE_A.principalId,
      sessionId: SCOPE_A.sessionId,
      dbPath,
      stateDir: path.join(path.dirname(dbPath), 'state'),
      setAuditPath: true,
      emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
      mainSystemPrompt: '（测试）Main 系统提示',
      workerSkills: [],
      createDrivers: () => ({
        mainDriver: fakeMainDriver(plans, records),
        workerDriver: unreachableDriver(),
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
      runtime: { dispatchMode: 'inline', maxDelegationDepth: 0 },
    });
    try {
      await expect(assembled.session.send('任务X')).rejects.toThrowError(/资源策略拒绝|resource_limited/);
      // 半成品不留：任务行落 failed + 机械原因 resource_limited；执行端零调用（unreachableDriver 未被触发）
      const tasks = assembled.taskRegistry.list(SCOPE_A);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('failed');
      expect(tasks[0]!.reason).toBe('resource_limited');
      // 失败路径不泄漏许可
      expect(assembled.policy.snapshot().foreground.active).toBe(0);
      expect(assembled.policy.snapshot().background.active).toBe(0);
    } finally {
      assembled.close();
    }
  });

  it('⑰ 后台满载不阻塞前台：后台任务挂起（1/1）时前台回合仍即时完成', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const gate = deferred<TaskExecutionOutcome>();
    const executor = new FakeExecutor([async () => await gate.promise]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([
      ['交办一件慢事', { delegates: ['交办一件慢事'], reply: '已受理，稍后给你结果。' }],
      ['顺便问一句', { reply: '现在后台还有任务在跑。' }],
    ]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      mainPlans: plans,
      records,
      backgroundConcurrency: 1,
    });
    try {
      const first = await assembled.session.send('交办一件慢事');
      expect(executor.calls).toHaveLength(1);
      expect(assembled.taskRegistry.get(first.taskIds[0]!, SCOPE_A).status).toBe('running');
      // 后台配额已满（1/1）：前台许可独立 → 回合立即完成（若被后台阻塞则拒绝/挂起，本断言红）
      const second = await assembled.session.send('顺便问一句');
      expect(second.reply).toBe('现在后台还有任务在跑。');
      expect(second.taskIds).toHaveLength(0);
      expect(assembled.policy.snapshot().foreground.active).toBe(0);
      // 放行后台后正常收尾（在飞回合不泄漏）
      gate.resolve({ kind: 'completed', resultText: '慢事完成' });
      await assembled.runner!.whenIdle();
      expect(assembled.policy.snapshot().background.active).toBe(0);
    } finally {
      gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await settleQuietly(assembled);
      assembled.close();
    }
  });
});

describe('R4 联合：P4 通知（假 sink，background 模式）', () => {
  it('④ 通知生成/去重/投递 + 只读可查（未送达 → 已送达）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const sink = new FakeSink();
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: '完成结果' })]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['任务A', { delegates: ['任务A'] }]]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      mainPlans: plans,
      records,
      notificationSink: sink,
    });
    const reader = createNotificationReader(dbPath);
    try {
      const turn = await assembled.session.send('任务A');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      // 事实→意图映射：受理/开始/完成各一条（cancelling 等过渡态不产生）
      expect(reader.listNotifications(taskId).map((notification) => notification.kind)).toEqual([
        'accepted',
        'started',
        'completed',
      ]);
      // 去重：同一事实重复触发不新增
      const completed = reader.listNotifications(taskId).find((notification) => notification.kind === 'completed')!;
      const again = assembled.notifications!.record({
        taskId,
        kind: 'completed',
        at: completed.payload.at,
        stateVersion: completed.stateVersion,
        ...(completed.payload.taskNo === undefined ? {} : { taskNo: completed.payload.taskNo }),
        ...(completed.payload.name === undefined ? {} : { name: completed.payload.name }),
      });
      expect(again.created).toBe(false);
      expect(reader.listNotifications(taskId)).toHaveLength(3);
      // 投递前：未送达只读可见
      expect(reader.undelivered(taskId).map((notification) => notification.kind)).toEqual([
        'accepted',
        'started',
        'completed',
      ]);
      // 假 sink 投递
      await assembled.notifications!.deliverPending();
      expect(sink.sent.map((notification) => notification.kind)).toEqual(['accepted', 'started', 'completed']);
      expect(reader.undelivered(taskId)).toEqual([]);
      expect(reader.listNotifications(taskId).every((notification) => notification.deliveredAt !== undefined)).toBe(true);
    } finally {
      reader.close();
      assembled.close();
    }
  });

  it('⑯ 通知投递失败不改变任务结果：任务仍 completed、结果可取回；未送达可见（attempts/lastError）', async () => {
    const dbPath = path.join(tempDir(), 'state.db');
    const sink = new FailingSink();
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: '结果全文' })]);
    const records: MainDriverRecord[] = [];
    const plans = new Map<string, MainPlan>([['任务A', { delegates: ['任务A'] }]]);
    const assembled = await assembleBackground({
      dbPath,
      taskExecutor: executor,
      mainPlans: plans,
      records,
      notificationSink: sink,
    });
    const reader = createNotificationReader(dbPath);
    try {
      const turn = await assembled.session.send('任务A');
      const taskId = turn.taskIds[0]!;
      await assembled.runner!.whenIdle();
      // 投递连续失败：未送达可见、有 attempts 与 lastError（不静默）
      await assembled.notifications!.deliverPending();
      const rows = reader.listNotifications(taskId);
      expect(rows).toHaveLength(3);
      expect(rows.every((notification) => notification.deliveredAt === undefined)).toBe(true);
      expect(rows.every((notification) => notification.attempts >= 1)).toBe(true);
      expect(rows.every((notification) => notification.lastError === 'CHANNEL_DOWN')).toBe(true);
      expect(reader.undelivered(taskId)).toHaveLength(3);
      // 任务结果与投递解耦：completed + 结果可取回，无失败痕迹
      const task = assembled.taskRegistry.get(taskId, SCOPE_A);
      expect(task.status).toBe('completed');
      expect(task.replyText).toBe('结果全文');
      expect(task.failureReason).toBeUndefined();
      expect(task.reason).toBeUndefined();
    } finally {
      reader.close();
      assembled.close();
    }
  });
});

describe('R4 联合：配置面（runtime.dispatchMode）', () => {
  function writeConfig(file: string, runtimeLines: readonly string[]): string {
    writeFileSync(file, [
      'principals: {}',
      'contextProfiles:',
      '  t:',
      `    root: ${FIXTURE_ROOT}`,
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
      'runtime:',
      ...runtimeLines,
    ].join('\n') + '\n');
    return file;
  }

  it('⑨ 合法值解析；非法值 fail-fast 点名 runtime.dispatchMode；未知键仍拒', () => {
    const dir = tempDir();
    const background = loadConfig({ yamlPath: writeConfig(path.join(dir, 'a.yaml'), ['  dispatchMode: background']) });
    expect(background.runtime?.dispatchMode).toBe('background');
    const inline = loadConfig({ yamlPath: writeConfig(path.join(dir, 'b.yaml'), ['  dispatchMode: inline']) });
    expect(inline.runtime?.dispatchMode).toBe('inline');
    expect(() => loadConfig({ yamlPath: writeConfig(path.join(dir, 'c.yaml'), ['  dispatchMode: parallel']) }))
      .toThrowError(/runtime\.dispatchMode/);
    expect(() => loadConfig({ yamlPath: writeConfig(path.join(dir, 'd.yaml'), ['  dispatchModee: inline']) }))
      .toThrowError(/不是已知字段/);
  });
});

describe('R4 联合：ask 入口对 background 的登记边界', () => {
  it('⑬ assembleAskRuntime 对 runtime.dispatchMode=background 显式拒绝（不静默忽略/不半程丢任务）', async () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'ask-background.yaml');
    writeFileSync(configPath, [
      'principals:',
      '  "test:user":',
      '    enabled: true',
      'contextProfiles:',
      '  t:',
      `    root: ${FIXTURE_ROOT}`,
      '    gateway: bin/dummy',
      '    skillRoots: [".agents/skills-serve"]',
      'runtime:',
      '  dispatchMode: background',
    ].join('\n') + '\n');
    await expect(assembleAskRuntime({
      purpose: 'ask',
      argv: [`--config=${configPath}`],
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'], LLM_API_KEY: 'test-key' },
      runtimeDir: dir,
      sessionId: 'ask-bg',
    })).rejects.toThrowError(/入口不支持 runtime\.dispatchMode=background/);
  });
});

describe('R4 联合：tasks 详情通知投递展示（只读最小）', () => {
  function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      taskId: 'task_x',
      principalId: SCOPE_A.principalId,
      sessionId: SCOPE_A.sessionId,
      request: '查一下',
      status: 'completed',
      executions: [],
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
      taskNo: 1,
      name: '查一下',
      ...overrides,
    };
  }

  it('⑩ 有通知行显示投递段（已送达/未送达/已停止）；无行不显示', () => {
    const base = taskRecord();
    expect(renderTaskDetail(base)).not.toContain('通知投递');
    const notifications: Notification[] = [
      {
        id: 1, taskId: base.taskId, kind: 'accepted', stateVersion: 't1',
        payload: { at: 't1' }, createdAt: 't1', deliveredAt: 't1', attempts: 1, exhausted: false,
      },
      {
        id: 2, taskId: base.taskId, kind: 'completed', stateVersion: 't2',
        payload: { at: 't2' }, createdAt: 't2', attempts: 3, exhausted: false, lastError: 'boom',
      },
      {
        id: 3, taskId: base.taskId, kind: 'failed', stateVersion: 't3',
        payload: { at: 't3', reason: 'failed_confirmed' }, createdAt: 't3', attempts: 5, exhausted: true, lastError: 'boom',
      },
    ];
    const text = renderTaskDetail(base, { notifications });
    expect(text).toContain('通知投递');
    expect(text).toContain('已受理：已送达');
    expect(text).toContain('已完成：未送达（重试 3/5）');
    expect(text).toContain('失败：未送达（已停止重试）');
  });
});
