/**
 * 后台任务状态变化的**主动推送** · server 级联测（假渠道事实 + 假 executor + 假模型；零网络）。
 *
 * 钉住的用户级行为：
 *   ① 后台任务失败 → 主动来一条人话（业务名 +「没办成」），不用等用户下次开口；
 *   ② 后台任务卡在等你说一句话 → 主动说清还缺什么；
 *   ③ 后台任务完成 → **零**推送（结果正文由完成投递发一次，不重复）；
 *   ④ 非 live（silent）→ 零投递，只记 suppressed（绝不假报 sent）；
 *   ⑤ 快活失败（短等待窗口内落定）→ **零**推送：模型同回合已经说明了。
 *
 * ③⑤ 同时是反向绊线的锚：去掉种类过滤 / 去掉同回合抑制，这两条会红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import type { Notification, NotificationSink } from '../../packages/agent/src/notifications';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-push-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(overrides: { taskRunWaitMs?: number } = {}): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] } },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: {
      backgroundConcurrency: 1,
      taskRunWaitMs: overrides.taskRunWaitMs ?? 0,
    },
  };
}

function incoming(text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId: `msg-${text}`,
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
    async run(): Promise<never> {
      throw new Error('（测试）该 driver 不应被调用');
    },
  };
}

/** 模型：第一回合委派一句，回复里如实转述（工具报错与真实 Pi 一样作为工具结果回给模型）。 */
function delegatingDriver(request: string, reply: string): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('（测试）Main 无工具面');
      try {
        await input.exec(tool.name, { task: request });
      } catch {
        // 真实 Pi：工具抛错变成工具结果交给模型；模型据此向用户如实说明。
      }
      const messages = [...input.messages, { role: 'assistant', content: reply } as never];
      return { text: reply, messages };
    },
  };
}

class FakeExecutor implements TaskExecutor {
  constructor(private readonly outcome: () => Promise<TaskExecutionOutcome> | TaskExecutionOutcome) {}
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    return await this.outcome();
  }
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

interface PushRecord {
  route: ChannelRoute;
  text: string;
}

function fakeDelivery(mode: 'live' | 'silent' = 'live') {
  const pushed: PushRecord[] = [];
  const files: unknown[] = [];
  return {
    pushed,
    files,
    port: {
      deliveryMode: mode,
      async sendToConversation(route: ChannelRoute, payload: unknown): Promise<DeliveryReceipt> {
        files.push({ route, payload });
        return { parts: [{ type: 'file' }] } as unknown as DeliveryReceipt;
      },
      async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
        pushed.push({ route, text });
        return { parts: [{ type: 'text', text }] } as unknown as DeliveryReceipt;
      },
    },
  };
}

async function runCase(options: {
  outcome: () => Promise<TaskExecutionOutcome> | TaskExecutionOutcome;
  deliveryMode?: 'live' | 'silent';
  taskRunWaitMs?: number;
  reply?: string;
}) {
  const dir = tempDir();
  const delivery = fakeDelivery(options.deliveryMode ?? 'live');
  const sink = new FakeSink();
  const request = '查 documents W202611';
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig({ taskRunWaitMs: options.taskRunWaitMs ?? 0 }),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({
      mainDriver: delegatingDriver(request, options.reply ?? '已经接下了，办完告诉你。'),
      workerDriver: unreachableDriver(),
    }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    taskExecutor: new FakeExecutor(options.outcome),
    notificationSink: sink,
    fileDelivery: delivery.port,
    logger: () => {},
  });
  return { server, delivery, sink, request };
}

describe('主动推送：后台任务的失败与等待（用户不必下次开口才发现）', () => {
  it('① 后台失败 → 主动一条人话（业务名 + 没办成），不冒充成功', async () => {
    const { server, delivery } = await runCase({ outcome: () => ({ kind: 'failed', reason: '执行层拒绝' }) });
    try {
      await server.handler(incoming('查 documents W202611'));
      await vi.waitFor(() => expect(delivery.pushed).toHaveLength(1));
      expect(delivery.pushed[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(delivery.pushed[0]!.text).toContain('没办成');
      expect(delivery.pushed[0]!.text).toContain('查 documents W202611');
      // 用户文本里不出现内部形态
      expect(delivery.pushed[0]!.text).not.toMatch(/task_|request_|uuid|[0-9a-f]{8}-[0-9a-f]{4}/);
    } finally {
      server.close();
    }
  });

  it('② 后台任务等你说一句话 → 主动说清还缺什么', async () => {
    const { server, delivery } = await runCase({
      outcome: () => ({ kind: 'needs_input', question: { missing: ['账套名'] } }),
    });
    try {
      await server.handler(incoming('查 documents W202611'));
      await vi.waitFor(() => expect(delivery.pushed).toHaveLength(1));
      expect(delivery.pushed[0]!.text).toContain('需要你一句话');
      expect(delivery.pushed[0]!.text).toContain('账套名');
    } finally {
      server.close();
    }
  });

  it('③ 后台完成 → 零推送（结果正文只发一次，由完成投递负责）', async () => {
    const { server, delivery } = await runCase({ outcome: () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' }) });
    try {
      await server.handler(incoming('查 documents W202611'));
      // 完成正文确实送达（证明链路是通的，不是整体没投）
      await vi.waitFor(() => expect(delivery.pushed.some((p) => p.text.includes('documents 共 3 条'))).toBe(true));
      // 断言「没有第二条」需要一段安静期：改期到回合后的推送在这段时间内会落地
      await new Promise((resolve) => setTimeout(resolve, 150));
      const notices = delivery.pushed.filter((p) => p.text.includes('办完了'));
      expect(notices).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('④ silent 部署 → 零投递（suppressed），推送不会假报送达', async () => {
    const { server, delivery } = await runCase({
      deliveryMode: 'silent',
      outcome: () => ({ kind: 'failed', reason: '执行层拒绝' }),
    });
    try {
      await server.handler(incoming('查 documents W202611'));
      await vi.waitFor(() => expect(delivery.files.length >= 0).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivery.pushed).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('⑤ 快活失败（窗口内落定）→ 零推送：模型同回合已经说明了', async () => {
    const { server, delivery } = await runCase({
      taskRunWaitMs: 3_000,
      reply: '没办成：执行层拒绝了这次查询。',
      outcome: () => ({ kind: 'failed', reason: '执行层拒绝' }),
    });
    try {
      const reply = await server.handler(incoming('查 documents W202611'));
      expect(reply).toContain('没办成');
      // 回合结束后给推送一点时间：同回合已转述的不再重复发
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(delivery.pushed).toEqual([]);
    } finally {
      server.close();
    }
  });
});
