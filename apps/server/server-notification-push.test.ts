/**
 * 后台任务状态变化的**主动推送** · server 级联测（假渠道事实 + 假 executor + 假模型；零网络）。
 *
 * 钉住的用户级行为：
 *   ① 后台任务失败 → 主动来一条人话（业务名 +「没办成」），不用等用户下次开口；
 *   ② 后台任务卡在等你说一句话 → 等待唤醒出口说清还缺什么（2026-11-21 live P0 改形：
 *      模板直发退役，唤醒原会话模型说——用户仍会主动收到一句话，断言强度不放宽）；
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
import { echoCompletionWake } from './testing/echo-completion-wake';
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
    principals: { 'wecom:user-a': { enabled: true } },
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

/** 模型：第一回合委派一句，回复里如实转述（工具报错与真实 Pi 一样作为工具结果回给模型）；
 *  唤醒回合（完成事实触发）按产品形状脚本化：模型把事实里的结果正文复读给用户。 */
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
    async wake(factText) {
      return echoCompletionWake(factText);
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
  it('① 后台失败 → 主动一句人话（话术模板，不含 Worker 原文/内部词），不冒充成功', async () => {
    // 口径变更（2026-11-19）：失败主动告知由失败投递分支直发，用户文本 = failureMessageFor
    // 模板（kind 归类自执行事实的 code；假执行器不落执行事实 → 取不到 → executor_failed）。
    // **不再拼接业务名**——模板话术是宿主契约，不把执行层原文/内部形态带给用户。
    const { server, delivery } = await runCase({ outcome: () => ({ kind: 'ended' }) });
    try {
      await server.handler(incoming('查 documents W202611'));
      await vi.waitFor(() => expect(delivery.pushed).toHaveLength(1));
      expect(delivery.pushed[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(delivery.pushed[0]!.text).toBe('没办成。再试一次，还是先放着？');
      // 用户文本里不出现内部形态（执行层原文「拒绝」与原始 reason 都不进文本）。
      expect(delivery.pushed[0]!.text).not.toMatch(/task_|request_|uuid|[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(delivery.pushed[0]!.text).not.toContain('执行层');
    } finally {
      server.close();
    }
  });

  it('② 后台任务等你说一句话 → 等待唤醒出口说清还缺什么（2026-11-21：模板直发退役，改唤醒模型说）', async () => {
    // 机制变化（2026-11-21 live P0）：进入 waiting_user 的主动告知从「chat sink 渲染直发」
    // 改为「唤醒原会话模型说」（runner 的 waitingUserNotice 端口 → task_waiting_user_wake；
    // 事实 = missing 列表 + confirmation.summary 原文与 expiresAt；兜底 = summary 原文）。
    // 旧断言「需要你一句话…」（通知渲染器模板）随直发退役；用户级「等待也要说清」由本条 +
    // server-state-wake 的 ⑤e/⑤f 共同钉住，断言强度不放宽（用户仍会主动收到一句话）。
    const { server, delivery } = await runCase({
      outcome: () => ({ kind: 'needs_input', question: { missing: ['账套名'] } }),
    });
    try {
      await server.handler(incoming('查 documents W202611'));
      await vi.waitFor(() => expect(delivery.pushed).toHaveLength(1));
      expect(delivery.pushed[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(delivery.pushed[0]!.text).toContain('账套名');
      // 不是旧渲染模板（那条随直发机制退役；用户文本 = 模型按事实说的话）。
      expect(delivery.pushed[0]!.text).not.toContain('需要你一句话');
    } finally {
      server.close();
    }
  });

  it('③ 后台完成 → 恰一次完成投递（投递的是模型唤醒回合那句），无第二条推送', async () => {
    // 2026-11-19 唤醒切片：宿主不再拼完成文案（身份行已删）——完成消息 = 唤醒原会话模型、
    // 由它把结果说给用户；这里脚本模型把事实里的结果正文复读。
    // 断言没有第二条：改期到回合后的 chatSink 推送（完成类本来就该零推）在这段安静期内落地。
    const resultText = 'W202611：documents 共 3 条。';
    const { server, delivery } = await runCase({ outcome: () => ({ kind: 'ended', report: resultText }) });
    try {
      await server.handler(incoming('查 documents W202611'));
      // 完成正文确实送达（证明链路是通的，不是整体没投）。
      await vi.waitFor(() => expect(delivery.pushed.some((p) => p.text.includes('documents 共 3 条'))).toBe(true));
      // 恰一条：完成投递 = 模型那句；没有 chatSink 的「办完了」第二条。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(delivery.pushed).toHaveLength(1);
      expect(delivery.pushed[0]!.text).toBe(resultText);
      expect(delivery.pushed[0]!.text).not.toMatch(/「[^」]*」办完了：/);
    } finally {
      server.close();
    }
  });

  it('④ silent 部署 → 零投递（suppressed），推送不会假报送达', async () => {
    const { server, delivery } = await runCase({
      deliveryMode: 'silent',
      outcome: () => ({ kind: 'ended' }),
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
      outcome: () => ({ kind: 'ended' }),
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
