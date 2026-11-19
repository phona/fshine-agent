/**
 * 片 1（feat/worker-run-js）：后台任务产物的**投递面**接线 · server 级确定性验证。
 *
 * 覆盖：
 *   ① 后台任务 completed 带 files（任务作用域登记事实）→ 走与前台 TurnResult.files
 *      **同一交付面**投递：端口收到 1 份文件字节、结果文本另走 sendText、事件记 sent；
 *   ② 无投递端口 → fail-closed：file_delivery 记 delivery_unavailable、**不记 sent**，
 *      结果文本仍如实送达（文件未送达 ≠ 结果没送达）。
 *
 * 零网络：假执行面 + 假模型驱动 + 假 executor（真返回 files）+ 假投递端口。
 * run_js 真跑在 runtime-worker-background-run-js.test.ts（同一装配链的上一环）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, OutgoingFileReply } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createFileStore } from '../../packages/agent/src/file-store';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { createServer, workspaceRootOf, type FileDeliveryPort } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const PRINCIPAL = 'wecom:user-a';
const SESSION = 'wecom:conv-a';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-bg-files-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      [PRINCIPAL]: { enabled: true },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: { backgroundConcurrency: 1, queueCapacity: 0, taskRunWaitMs: 0 },
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

const unreachableWorker: TurnDriver = {
  async run() {
    throw new Error('（测试）后台任务的 Worker 由 executor 替身接管，不该被调用');
  },
};

function plannedMainDriver(): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const tool = input.tools.find((candidate) => candidate.name === 'task_run');
      if (tool === undefined) throw new Error('（测试）Main 无 task_run 工具面');
      await input.exec(tool.name, { task: '做一张汇总表' });
      const reply = `已受理：${text}`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

/** 假后台执行器：completed 带本任务产物登记事实（files 走任务作用域）。 */
function completedWithFiles(files: ReadonlyArray<{ fileId: string; name: string; bytes: number }>): TaskExecutor {
  return {
    async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
      return { kind: 'completed', resultText: '汇总表已生成。', files };
    },
  };
}

interface PortCalls {
  files: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }>;
  texts: Array<{ route: ChannelRoute; text: string }>;
}

function livePort(): { port: FileDeliveryPort; calls: PortCalls } {
  const calls: PortCalls = { files: [], texts: [] };
  return {
    calls,
    port: {
      deliveryMode: 'live',
      async sendToConversation(route, files): Promise<DeliveryReceipt> {
        calls.files.push({ route, files });
        return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
      },
      async sendText(route, text): Promise<DeliveryReceipt> {
        calls.texts.push({ route, text });
        return { route, parts: [{ kind: 'text' as const, index: 0, status: 'sent' as const }] };
      },
    },
  };
}

/** 把一份文件真登记进 server 的 workspace（投递面按 fileId 现读字节）。 */
function registerServerFile(input: { dbPath: string; name: string; bytes: Buffer }): {
  fileId: string;
  name: string;
  bytes: number;
} {
  const workspaceRoot = workspaceRootOf(input.dbPath);
  const store = openTaskStore(input.dbPath);
  const fileStore = createFileStore({ store, workspaceRoot });
  try {
    const file = fileStore.putFile({
      scope: { principalId: PRINCIPAL, sessionId: SESSION },
      name: input.name,
      bytes: input.bytes,
      activatedAt: Date.now(),
    });
    return { fileId: file.fileId, name: file.name, bytes: file.bytes };
  } finally {
    store.close();
  }
}

describe('片 1：后台任务产物投递（server 级）', () => {
  it('① completed.files → 同一交付面投递 1 份文件；结果文本另走 sendText；事件记 sent', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    // 先登记字节（server 启动前写库，避免同库并发写）。
    const file = registerServerFile({ dbPath, name: '汇总.xlsx', bytes: Buffer.from('pk-bytes-of-summary') });
    const { port, calls } = livePort();
    const logs: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      createDrivers: () => ({ mainDriver: plannedMainDriver(), workerDriver: unreachableWorker }),
      createExecutionFace: async () => ({
        client: new FaceClient(),
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      taskExecutor: completedWithFiles([file]),
      fileDelivery: port,
      logger: (line) => logs.push(line),
    });
    try {
      const reply = await server.handler(incoming('msg-bg-1', '把数据做成表格发我'));
      // 「只交办」回合静默（owner 2026-11-19）：模型那段受理卡片不发终帧（reply 为空）。
      expect(reply).toBe('');

      // 后台完成 → 文件经交付面（sendToConversation）投递；文本经 sendText 单独送达。
      await vi.waitFor(() => {
        expect(calls.files).toHaveLength(1);
        expect(calls.texts).toHaveLength(1);
      });
      expect(calls.files[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(calls.files[0]!.files).toHaveLength(1);
      expect(calls.files[0]!.files[0]!.filename).toBe('汇总.xlsx');
      expect(calls.files[0]!.files[0]!.data.toString()).toBe('pk-bytes-of-summary');
      expect(calls.texts[0]!.text).toBe('汇总表已生成。');

      // 事件面：文件投递记 sent、文本投递记 sent（都不是 suppressed）。
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toHaveLength(1);
        expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
      });
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent' && line['files'] === 1)).toBe(true);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('② 无投递端口 → 文件 fail-closed（delivery_unavailable、不记 sent）；结果文本照常送达', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const file = registerServerFile({ dbPath, name: '汇总.xlsx', bytes: Buffer.from('pk-bytes') });
    const logs: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      createDrivers: () => ({ mainDriver: plannedMainDriver(), workerDriver: unreachableWorker }),
      createExecutionFace: async () => ({
        client: new FaceClient(),
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      taskExecutor: completedWithFiles([file]),
      // 无会话投递端口（文件必须 fail-closed）；通知 sink 仍是一个推送面 → 后台派发（async）。
      notificationSink: { async send() { return { delivered: true }; } },
      logger: (line) => logs.push(line),
    });
    try {
      await server.handler(incoming('msg-bg-2', '把数据做成表格发我'));
      // 文件：没有端口即如实记 delivery_unavailable，绝不记 sent。
      await vi.waitFor(() => {
        expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'delivery_unavailable')).toBe(true);
      });
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
      // 文本投递同样按无端口如实记账（suppressed），不谎报 sent。
      await vi.waitFor(() => {
        expect(logs.some((line) => line['event'] === 'task_result_delivery_suppressed')).toBe(true);
      });
      expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
    } finally {
      await server.close();
    }
  }, 30_000);
});
