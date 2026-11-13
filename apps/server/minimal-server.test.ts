/**
 * U3 最小 server 的假渠道回归（零网络、零真实企微、零真实平台）：
 *   · 假渠道（SdkClientLike stub）+ 假执行客户端 + 假模型驱动：
 *     消息进（message.text）→ 可信身份取自渠道事实 → Minimal runtime → 回复出（终帧）；
 *   · 未开通 principal 被确定性拒绝，且不建会话、不调模型、不发起执行；
 *   · 身份映射：principalId = <channel>:<userid>，sessionId = <channel>:<conversationId>。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import type { AppConfig } from '@fshine/contracts';
import type {
  CancelResult,
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { WecomBotChannel, type SdkClientLike } from '@fshine/channel-wecom';
import { createPiTurnDriver, type PiModelRuntime } from '../../packages/agent/src/pi-driver';
import { createMinimalServer } from './minimal-server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'minimal-server-'));
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
  async cancel(): Promise<CancelResult> {
    return 'not_found';
  }
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
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
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function streamOf(message: AgentMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'done', reason: (message as { stopReason?: string }).stopReason, message };
    },
    result: async () => message,
  };
}

function driverFor(responses: AgentMessage[]) {
  const runtime: PiModelRuntime = {
    model: {
      id: 'test-model',
      name: 'test-model',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 40_000,
      maxTokens: 32_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      streamSimple: async () => {
        const response = responses.shift();
        if (!response) throw new Error('假模型运行时没有更多响应');
        return streamOf(response);
      },
      completeSimple: async () => textAssistant('【夹具摘要】'),
    } as unknown as MutableModels,
  };
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, runtime });
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

describe('U3 最小 server（假渠道 + 假执行客户端 + 假模型）', () => {
  it('消息进 → 回复出；身份取自渠道事实；执行经结构化请求', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const client = new FakeClient();
    const frames: Array<{ streamId: string; content: string; finish: boolean }> = [];
    const server = await createMinimalServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({
        mainDriver: driverFor([
          toolCallAssistant('run_task', { task: '查询 documents 窗口 W202611' }, 'call_main_1'),
          textAssistant('documents 窗口 W202611 共 3 条。'),
        ]),
        workerDriver: driverFor([
          toolCallAssistant('execute_operation', {
            operation: 'dummy.query',
            args: { '--collection': 'documents', '--window': 'W202611' },
          }, 'call_worker_1'),
          textAssistant('已查询 documents W202611：3 条。'),
        ]),
      }),
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
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
    const done = logs.find((line) => line['event'] === 'minimal_message_done');
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
    const server = await createMinimalServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => {
        driverCreations += 1;
        return { mainDriver: driverFor([]), workerDriver: driverFor([]) };
      },
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });

    const stub = sdkStub(frames);
    const channel = new WecomBotChannel({
      env: { WECOM_BOT_ID: 'bot-id', WECOM_BOT_SECRET: 'bot-secret' },
      clientFactory: () => stub,
      platformRoot: dir,
    });
    await channel.start(server.handler);
    stub.emit('message.text', textMessageFrame('stranger', '你好', 'msg-2', 'req-2'));

    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.finish)).toHaveLength(1);
    });
    expect(frames.filter((frame) => frame.finish)[0]!.content).toContain('未开通使用权限');
    expect(driverCreations).toBe(0);
    expect(client.requests).toHaveLength(0);
    const refused = logs.find((line) => line['event'] === 'minimal_message_refused');
    expect(refused!['principalId']).toBe('wecom:stranger');

    await channel.stop();
    server.close();
  });
});
