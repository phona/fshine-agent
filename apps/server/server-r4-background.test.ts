/**
 * R4 集成 Run server 联合测试（先在红；接线转绿）：
 *   ⑪ 同会话串行化（P5-T02）：两条并发消息都处理、顺序正确、转录不互相覆盖；
 *   ⑫ background 渠道回合端到端：受理返回 → 后台完成 → 结果经 archiveReply 取回 →
 *      假 sink 投递通知；只读底账/通知可查。
 *
 * 假件：渠道事实直接构造（ReplyHandler 入口；渠道适配边界另有既有 server.test.ts 假渠道金样）、
 * 假执行面、假模型 driver、假 executor、假 sink；零网络、零真实模型、零真实平台。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createNotificationReader, type Notification, type NotificationSink } from '../../packages/agent/src/notifications';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-r4-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(mode: 'inline' | 'background'): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
      'wecom:user-b': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    ...(mode === 'background' ? { runtime: { dispatchMode: 'background' as const, backgroundConcurrency: 1 } } : {}),
  };
}

function incoming(userId: string, conversationId: string, messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

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

interface ServerDriverRecord {
  messages: readonly DriverMessage[];
  /** 宿主事实注入（R5 B 通道）：Pi 原生 custom message 交付，不进 messages 快照。 */
  injections: readonly string[];
  execResults: unknown[];
}

interface ServerPlan {
  delegates?: readonly string[];
  reply?: string;
}

function plannedDriver(plans: ReadonlyMap<string, ServerPlan>, records: ServerDriverRecord[]): TurnDriver {
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
      records.push({ messages: input.messages, injections: input.injections ?? [], execResults });
      const reply = plan.reply ?? `（测试回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeExecutor implements TaskExecutor {
  readonly calls: Array<{ taskId: string }> = [];
  private readonly handlers: Array<() => Promise<TaskExecutionOutcome>>;
  constructor(handlers: ReadonlyArray<() => Promise<TaskExecutionOutcome>> = []) {
    this.handlers = [...handlers];
  }
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls.push({ taskId: input.taskId });
    const handler = this.handlers.shift();
    if (handler === undefined) throw new Error('（测试）假 executor 没有配置行为');
    return await handler();
  }
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

describe('R4 联合：server 同会话串行化（P5-T02）', () => {
  it('⑪ 同会话两条并发消息：两条都回复、顺序正确、转录不互相覆盖', async () => {
    const dir = tempDir();
    const gate = deferred<void>();
    const records: ServerDriverRecord[] = [];
    let turn = 0;
    const mainDriver: TurnDriver = {
      async run(input) {
        turn += 1;
        const current = turn;
        records.push({ messages: input.messages, injections: input.injections ?? [], execResults: [] });
        if (current === 1) await gate.promise;
        const reply = `回合${current}回复`;
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig('inline'),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver, workerDriver: unreachableDriver() }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: () => {},
    });
    try {
      const first = server.handler(incoming('user-a', 'conv-a', 'msg-1', '第一件事'));
      const second = server.handler(incoming('user-a', 'conv-a', 'msg-2', '第二件事'));
      const both = Promise.all([first, second]).catch(() => undefined);
      await vi.waitFor(() => expect(records).toHaveLength(1));
      // 串行化：第一回合未结束前，第二回合不得开始（转录不被并发覆盖）
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(records).toHaveLength(1);
      gate.resolve();
      const replies = await both;
      expect(replies).toBeDefined();
      expect(replies![0]).toBe('回合1回复');
      expect(replies![1]).toBe('回合2回复');
      // 第二回合看到完整转录（user1 + assistant1 + user2），没有互相覆盖
      expect(records.map((record) => record.messages.length)).toEqual([1, 3]);
    } finally {
      gate.resolve();
      server.close();
    }
  });
});

describe('R4 联合：server background 渠道回合（假 executor/sink）', () => {
  it('⑫ 受理返回 → 后台完成 → 结果可取回 → 通知投递（accepted/started/completed）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const sink = new FakeSink();
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' })]);
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['查 documents W202611', { delegates: ['查 documents W202611'], reply: '已受理，稍后通知你。' }],
    ]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig('background'),
      dbPath,
      createDrivers: () => ({ mainDriver: plannedDriver(plans, records), workerDriver: unreachableDriver() }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      notificationSink: sink,
      logger: () => {},
    });
    const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
    const reader = createNotificationReader(dbPath);
    try {
      const reply = await server.handler(incoming('user-a', 'conv-a', 'msg-1', '查 documents W202611'));
      expect(reply).toBe('已受理，稍后通知你。');
      // 受理事实（task_run 返回）带数字编号/业务名/queued
      const accepted = records[0]!.execResults[0] as Record<string, unknown>;
      expect(accepted).toMatchObject({ status: 'queued', accepted: true, taskNo: 1 });
      expect(String(accepted['notice'])).toContain('#1');
      const taskId = String(accepted['taskId']);
      const taskScope = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
      // 后台完成 + 结果经 archiveReply 取回
      await vi.waitFor(() => {
        expect(registry.get(taskId, taskScope).status).toBe('completed');
      });
      expect(registry.get(taskId, taskScope).replyText).toBe('W202611：documents 共 3 条。');
      // 通知投递（假 sink）：受理/开始/完成
      await server.deliverPending();
      await vi.waitFor(() => {
        expect(sink.sent.map((notification) => notification.kind)).toEqual(['accepted', 'started', 'completed']);
      });
      expect(reader.listNotifications(taskId).every((notification) => notification.deliveredAt !== undefined)).toBe(true);
      expect(reader.undelivered(taskId)).toEqual([]);
    } finally {
      reader.close();
      registry.close();
      server.close();
    }
  });
});

describe('R5 通知：投递驱动与 B 通道事实注入', () => {
  it('⑬ 落库即试投失败后，下一次渠道回合开头 drain 补投（deliverPending 有真实调用方）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    let failFirst = true;
    const sentKinds: string[] = [];
    const flakySink: NotificationSink = {
      async send(notification) {
        sentKinds.push(notification.kind);
        // 首次投递失败（outbox 记 retry_scheduled，退避基数 1s）。
        if (failFirst) {
          failFirst = false;
          return { delivered: false, error: '（测试）渠道暂不可用' };
        }
        return { delivered: true };
      },
    };
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' })]);
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['查 documents W202611', { delegates: ['查 documents W202611'], reply: '已受理，稍后通知你。' }],
      ['还在吗', { reply: '在的。' }],
    ]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig('background'),
      dbPath,
      createDrivers: () => ({ mainDriver: plannedDriver(plans, records), workerDriver: unreachableDriver() }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      notificationSink: flakySink,
      logger: () => {},
    });
    const reader = createNotificationReader(dbPath);
    try {
      await server.handler(incoming('user-a', 'conv-a', 'msg-1', '查 documents W202611'));
      // 首投失败 → 至少一条未送达。
      await vi.waitFor(() => expect(reader.undelivered().length).toBeGreaterThan(0));
      // 退避到点（基数 1s）后，用户下一次回合开头 drain 一次 pending → 补投成功。
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await server.handler(incoming('user-a', 'conv-a', 'msg-2', '还在吗'));
      await vi.waitFor(() => expect(reader.undelivered()).toEqual([]));
      expect(sentKinds.length).toBeGreaterThanOrEqual(4);
    } finally {
      reader.close();
      server.close();
    }
  });

  it('⑭ B 通道：后台终态事实在下一次回合以普通 user 消息注入（幂等 + 有界）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const executor = new FakeExecutor([async () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' })]);
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['查 documents W202611', { delegates: ['查 documents W202611'], reply: '已受理，稍后通知你。' }],
      ['下一步', { reply: '收到事实。' }],
      ['再一步', { reply: '好。' }],
    ]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig('background'),
      dbPath,
      createDrivers: () => ({ mainDriver: plannedDriver(plans, records), workerDriver: unreachableDriver() }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      notificationSink: new FakeSink(),
      logger: () => {},
    });
    try {
      await server.handler(incoming('user-a', 'conv-a', 'msg-1', '查 documents W202611'));
      await server.handler(incoming('user-a', 'conv-a', 'msg-2', '下一步'));
      // 第二回合的注入面：宿主事实经 `injections` 交给驱动（Pi 原生 custom message 投影成 user），
      // `messages` 只是只读转录快照 + 本回合用户消息。
      const injected = records[1]!.injections.filter((text) => text.startsWith('[任务事实]'));
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain('办完了');
      expect(injected[0]).toContain('查 documents W202611');
      expect(injected[0]).not.toContain('task_status');
      // 幂等：第三回合不再重复注入同一事实。
      await server.handler(incoming('user-a', 'conv-a', 'msg-3', '再一步'));
      const third = records[2]!.injections.filter((text) => text.startsWith('[任务事实]'));
      expect(third).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
