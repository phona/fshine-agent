/**
 * server 的假渠道回归（零网络、零真实企微、零真实平台）：
 *   · 假渠道（SdkClientLike stub）+ 假执行客户端 + 假模型驱动：
 *     消息进（message.text）→ 可信身份取自渠道事实 → 回合运行时 → 回复出（终帧）；
 *   · 未开通 principal 被确定性拒绝，且不建会话、不调模型、不发起执行；
 *   · 身份映射：principalId = <channel>:<userid>，sessionId = <channel>:<conversationId>。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import { createPiTurnDriver } from '../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../packages/agent/testing/scripted-model-runtime';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:test-user': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query items', args: [{ name: '--collection', required: true }] }],
};

class FakeClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return { status: 'completed', data: { collection: 'documents', window: 'W202611', count: 3 } };
  }
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

async function driverFor(responses: AgentMessage[]) {
  const scripted = await createScriptedModelRuntime({
    contextWindow: 40_000,
    script: (index) => responses[index],
  });
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime });
}

interface StubFrame {
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
}

interface StubChannelClient extends SdkClientLike {
  emit(event: string, frame: StubFrame): void;
}

function sdkStub(frames: Array<{ streamId: string; content: string; finish: boolean }>): StubChannelClient {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, listener: (...args: any[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      handlers.set(event, list);
      return undefined;
    },
    connect() {
      queueMicrotask(() => {
        for (const listener of handlers.get('authenticated') ?? []) listener();
      });
      return undefined;
    },
    disconnect() {},
    async replyStream(frame, streamId, content, finish) {
      frames.push({ streamId, content, finish });
      return undefined;
    },
    async uploadMedia() {
      return { media_id: 'media_1' };
    },
    async replyMedia() {
      return undefined;
    },
    async sendMessage() {
      return undefined;
    },
    async downloadFile() {
      return { buffer: Buffer.alloc(0) };
    },
    emit(event, frame) {
      for (const listener of handlers.get(event) ?? []) listener(frame);
    },
  };
}

function textMessageFrame(userid: string, text: string, messageId: string, reqId: string): StubFrame {
  return {
    headers: { req_id: reqId },
    // 企微 text 消息的真实形状：正文在 text.content（不是 text 字符串）。
    body: { msgtype: 'text', from: { userid }, msgid: messageId, chattype: 'single', text: { content: text } },
  };
}

describe('server（假渠道 + 假执行客户端 + 假模型）', () => {
  it('消息进 → 回复出；身份取自渠道事实；执行经结构化请求', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const client = new FakeClient();
    const frames: Array<{ streamId: string; content: string; finish: boolean }> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: async () => ({
        mainDriver: await driverFor([
          toolCallAssistant('run_task', { task: '查询 documents 窗口 W202611' }, 'call_main_1'),
          textAssistant('documents 窗口 W202611 共 3 条。'),
        ]),
        workerDriver: await driverFor([
          toolCallAssistant('execute_operation', {
            operation: 'dummy.query',
            args: { '--collection': 'documents', '--window': 'W202611' },
          }, 'call_worker_1'),
          textAssistant('已查询 documents W202611：3 条。'),
        ]),
      }),
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
      deliveryMode: 'live',
    });
    await channel.start(server.handler);

    // 触发 stub 的 message.text 事件（不连真实企微）。
    stub.emit('message.text', textMessageFrame('test-user', '帮我查一下 documents 窗口 W202611 的数据', 'msg-1', 'req-1'));

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.finish)).toHaveLength(1);
    });
    const final = frames.filter((frame) => frame.finish)[0]!;
    expect(final.content).toContain('3 条');

    // 执行经结构化请求（宿主生成 requestId；operation 来自允许集合）。
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.operation).toBe('dummy.query');
    expect(client.requests[0]!.requestId).toMatch(/^req_[0-9a-f-]{36}$/);

    // 身份取自渠道事实；回复完成事件带 taskId。
    const done = logs.find((line) => line['event'] === 'message_done');
    expect(done).toBeDefined();
    expect(done!['principalId']).toBe('wecom:test-user');
    expect(done!['sessionId']).toBe('wecom:test-user');
    expect(done!['taskIds']).toHaveLength(1);

    await channel.stop();
    server.close();
  });

  it('未开通的 principal：确定性拒绝，不建会话、不调模型、不发起执行', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const client = new FakeClient();
    const frames: Array<{ streamId: string; content: string; finish: boolean }> = [];
    let driverCreations = 0;
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: async () => {
        driverCreations += 1;
        return { mainDriver: await driverFor([]), workerDriver: await driverFor([]) };
      },
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
      deliveryMode: 'live',
    });
    await channel.start(server.handler);
    stub.emit('message.text', textMessageFrame('stranger', '你好', 'msg-2', 'req-2'));

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.finish)).toHaveLength(1);
    });
    expect(frames.filter((frame) => frame.finish)[0]!.content).toContain('未开通使用权限');
    expect(driverCreations).toBe(0);
    expect(client.requests).toHaveLength(0);
    const refused = logs.find((line) => line['event'] === 'message_refused');
    expect(refused!['principalId']).toBe('wecom:stranger');

    await channel.stop();
    server.close();
  });

  // B2 端到端：**缺省静默**下，拒绝路径的整条链仍跑通（拒绝文案确实生成），但**实际用户可见
  // 投递 = 0**，且被抑制的发送留下可观测证据。渠道按缺省构造（不传 deliveryMode）。
  it('Silent Shadow 端到端：拒绝路径产出文案但零用户可见投递，尝试可观测', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      createExecutionFace: async () => ({ client: new FakeClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const frames: Array<{ streamId: string; content: string; finish: boolean }> = [];
    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
      // 不传 deliveryMode：走缺省静默闸门
    });
    await channel.start(server.handler);
    stub.emit('message.text', textMessageFrame('stranger', '你好', 'msg-silent', 'req-silent'));

    // 宿主确实跑了拒绝路径（文案生成、拒绝事件登记）。
    await vi.waitFor(() => {
      expect(logs.some((line) => line['event'] === 'message_refused')).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 判据：底层的全部出站调用为零（stub 一帧都没收到）——实际用户可见投递 = 0。
    expect(frames).toHaveLength(0);
    // 尝试可观测：闸门登记了被抑制的发送（ack + 拒绝终帧）。
    const evidence = channel.shadowEvidence();
    expect(evidence.mode).toBe('silent');
    expect(evidence.userVisibleSuppressed).toBeGreaterThanOrEqual(1);

    await channel.stop();
    server.close();
  });

  /**
   * 缺陷①：模型侧空回复（溢出恢复后正文为空 / 只有思考没正文且催问后仍空）时，宿主只写了
   * `pi_driver_empty_reply` 日志，渠道侧拿到空串 → 一个终帧都不发，用户什么也收不到。
   * 修复：`execution-runtime.send` 把空文本显式变成回合失败 → 渠道既有失败转述通道
   * （handler 抛错 → 兜底失败话术）把明确失败发给用户；失败回合也不记 message_done。
   */
  it('模型侧空回复：用户收到明确失败话术，而不是静默无回复', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const client = new FakeClient();
    const frames: Array<{ streamId: string; content: string; finish: boolean }> = [];
    const emptyReply = () => ({
      ...textAssistant(''),
      content: [],
    });
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      // 两次都空：首答空 → 驱动催问一次（既有机制）→ 仍空 → 本回合失败。
      createDrivers: async () => ({
        mainDriver: await driverFor([emptyReply(), emptyReply()]),
        workerDriver: await driverFor([]),
      }),
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
      // 失败话术必须真实可见；缺省静默闸会抑制全部出站（由 Silent Shadow 用例单独覆盖）。
      deliveryMode: 'live',
    });
    await channel.start(server.handler);
    stub.emit('message.text', textMessageFrame('test-user', '帮我查一下 documents', 'msg-3', 'req-3'));

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.finish)).toHaveLength(1);
    }, { timeout: 5_000 });
    const final = frames.filter((frame) => frame.finish)[0]!;
    expect(final.content, '用户必须看到明确失败面').toBe('处理失败,请稍后再试');
    expect(logs.some((line) => line['event'] === 'message_done'), '失败回合不得记成功完成事件').toBe(false);
    expect(client.requests).toHaveLength(0);

    await channel.stop();
    server.close();
  });
});
