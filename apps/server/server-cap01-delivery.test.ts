/**
 * CAP-01 S1 交付（主动投递 B）· server 级确定性验证（假渠道事实 + 假模型驱动；零网络）。
 *
 * run_js 走真实受限执行器（server 装配缺省构造；Node 权限模型子进程，只写 out/），
 * 产物经真实 fileStore 登记 → 回合末 TurnResult.files → handler 经注入端口投递。
 *
 * 覆盖（逐条对应 ask ⑥，四必守见 v8 §7）：
 *   ① 故意让投递失败 → 用户看到「未送达」、事件记 delivery_failed、**不记 sent**；
 *   ② deliveryMode 非 live（silent）→ 记 `suppressed`、不发起投递、**不记 sent**；
 *   ③ 无投递端口 → fail-closed：用户可见「文件未送达（当前渠道不支持文件投递）」
 *      + 事件 delivery_unavailable；
 *   ④ 只有文件、正文为空 → 不判回合失败，投递照常发生（live 成功记 sent、端口收到字节）；
 *      附：正文空且无文件仍按既有「回合失败」处理（分支两侧都钉住）；
 *   ⑥ server 级清单注入：下一回合的机械事实只有 fileId/name/bytes（无文件内容/sha256），
 *      message_done 记 fileManifestBytes 观察项。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, OutgoingFileReply } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { FILES_GENERATED_NOTICE } from '../../packages/agent/src/execution-runtime';
import { createServer, type FileDeliveryPort } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-cap01-delivery-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
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

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
}

interface DriverStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface DriverCapture {
  toolNames: string[][];
  injections: string[][];
}

/** 按调用序回放的假主驱动（同一会话跨消息复用同一实例与步骤队列）。 */
function sequencedDriver(steps: readonly DriverStep[], capture: DriverCapture): TurnDriver {
  let index = 0;
  return {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      capture.injections.push([...(input.injections ?? [])]);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
      for (const call of step.execCalls ?? []) {
        await input.exec(call.tool, call.args);
      }
      return { text: step.text, messages: [] as unknown as DriverMessage[] };
    },
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

/** live 端口：成功回 per-file 回执；fail=true 抛错（带空 receipt，模拟部分 ACK 形状）。 */
function livePort(options: { fail?: boolean } = {}): { port: FileDeliveryPort; calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> } {
  const calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> = [];
  return {
    calls,
    port: {
      deliveryMode: 'live',
      async sendToConversation(route, files): Promise<DeliveryReceipt> {
        calls.push({ route, files });
        if (options.fail === true) {
          const error = new Error('企微主动交付失败（file[0] upload）: 测试注入的投递失败') as Error & { receipt?: DeliveryReceipt };
          error.receipt = { route, parts: [] };
          throw error;
        }
        return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
      },
    },
  };
}

/** 产物写入脚本：写 out/汇总.txt（cwd = runDir；out/ 由执行器预建）。 */
const RUN_JS_CALL = {
  tool: 'run_js',
  args: { code: "require('node:fs').writeFileSync('out/汇总.txt', 'summary-bytes');" },
};

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  capture: DriverCapture;
}

async function makeFixture(input: {
  steps: readonly DriverStep[];
  port?: FileDeliveryPort;
}): Promise<Fixture> {
  const dir = tempDir();
  const logs: Array<Record<string, unknown>> = [];
  const capture: DriverCapture = { toolNames: [], injections: [] };
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({ mainDriver: sequencedDriver(input.steps, capture), workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    ...(input.port === undefined ? {} : { fileDelivery: input.port }),
    logger: (line) => logs.push(line),
  });
  return { server, logs, capture };
}

describe('CAP-01 S1 交付（主动投递 B，server 级）', () => {
  it('① 故意让投递失败 → 用户看到「未送达」、事件记 delivery_failed、不记 sent', async () => {
    const { port, calls } = livePort({ fail: true });
    const { server, logs } = await makeFixture({
      steps: [{ execCalls: [RUN_JS_CALL], text: '汇总完成。' }],
      port,
    });
    try {
      const reply = await server.handler(incoming('m-fail', '帮我汇总'));
      // 用户话术：模型正文 + 如实的未送达话术（失败不吞）。
      expect(reply).toContain('汇总完成。');
      expect(reply).toContain('未送达');
      // 事件：结构化失败事实，绝不记 sent。
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]!['status']).toBe('delivery_failed');
      expect(deliveryLogs[0]!['files']).toBe(1);
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
      // 回合仍是成功回执（message_done 落了投递事实）。
      const done = logs.find((line) => line['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'delivery_failed', files: 1 });
      expect(calls).toHaveLength(1); // live 确实发起了投递
    } finally {
      await server.close();
    }
  });

  it('② silent → 记 suppressed、不发起投递、不记 sent', async () => {
    let portCalls = 0;
    const port: FileDeliveryPort = {
      deliveryMode: 'silent',
      async sendToConversation() {
        portCalls += 1;
        throw new Error('（测试）silent 部署不应发起投递');
      },
    };
    const { server, logs } = await makeFixture({
      steps: [{ execCalls: [RUN_JS_CALL], text: '汇总完成。' }],
      port,
    });
    try {
      const reply = await server.handler(incoming('m-silent', '帮我汇总'));
      expect(reply).toBe('汇总完成。');
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]!['status']).toBe('suppressed');
      expect(deliveryLogs[0]!['deliveryMode']).toBe('silent');
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
      expect(portCalls).toBe(0); // 非 live 不发起投递
    } finally {
      await server.close();
    }
  });

  it('③ 无投递端口 → fail-closed：用户可见「文件未送达（当前渠道不支持文件投递）」+ delivery_unavailable', async () => {
    const { server, logs } = await makeFixture({
      steps: [{ execCalls: [RUN_JS_CALL], text: '汇总完成。' }],
    });
    try {
      const reply = await server.handler(incoming('m-noport', '帮我汇总'));
      expect(reply).toContain('汇总完成。');
      expect(reply).toContain('文件未送达（当前渠道不支持文件投递）');
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]!['status']).toBe('delivery_unavailable');
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('④ 只有文件、正文为空 → 不判回合失败，投递照常发生（live 成功记 sent）', async () => {
    const { port, calls } = livePort();
    const { server, logs } = await makeFixture({
      steps: [{ execCalls: [RUN_JS_CALL], text: '' }],
      port,
    });
    try {
      // 不抛（判失败就走不到投递了，v8 §7 四必守 #2 的理由）；正文 = 宿主兜底话术。
      const reply = await server.handler(incoming('m-empty', '发文件'));
      expect(reply).toBe(FILES_GENERATED_NOTICE);
      // 投递面收到文件字节（handler 只传 files，文本不进端口）。
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.txt');
      expect(calls[0]!.files[0]!.data.toString()).toBe('summary-bytes');
      expect(calls[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]!['status']).toBe('sent');
      const done = logs.find((line) => line['event'] === 'message_done');
      expect(done?.['fileDelivery']).toEqual({ status: 'sent', files: 1 });
    } finally {
      await server.close();
    }
  });

  it('④b 正文空且无文件 → 仍按既有「回合失败」处理（分支另一侧回归）', async () => {
    const { server, logs } = await makeFixture({ steps: [{ text: '' }] });
    try {
      await expect(server.handler(incoming('m-blank', '说点什么'))).rejects.toThrow('本回合未产出可用回复');
      expect(logs.some((line) => line['event'] === 'message_done')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('⑥ server 级清单注入：下一回合机械事实只有 fileId/name/bytes；message_done 记 fileManifestBytes', async () => {
    const { port } = livePort();
    const { server, logs, capture } = await makeFixture({
      steps: [
        { execCalls: [RUN_JS_CALL], text: '汇总完成。' },
        { text: '已按清单继续处理。' },
      ],
      port,
    });
    try {
      await server.handler(incoming('m-1', '帮我汇总'));
      await server.handler(incoming('m-2', '继续处理上一步的结果'));

      // 第一回合：清单在回合开始构建，产出尚未登记 → 无清单注入；工具面已含 run_js。
      expect(capture.injections[0]).toEqual([]);
      expect(capture.toolNames[0]).toContain('run_js');

      // 第二回合：清单 = 本会话已激活文件，字段只有 fileId/name/bytes。
      expect(capture.injections[1]).toHaveLength(1);
      const manifest = capture.injections[1]![0]!;
      const lines = manifest.split('\n');
      expect(lines[0]).toContain('[本会话文件清单]');
      expect(lines[1]).toMatch(/^- 汇总\.txt（fileId: file_[0-9a-f]{32}，13 字节）$/);
      expect(manifest).not.toContain('summary-bytes'); // 没有文件内容（行数据不进清单）
      expect(manifest).not.toContain('sha256');
      expect(manifest).not.toContain('/');
      const done = logs.filter((line) => line['event'] === 'message_done').at(-1);
      const injected = capture.injections[1]![0]!;
      expect(done?.['fileManifestBytes']).toBe(Buffer.byteLength(injected, 'utf8'));
    } finally {
      await server.close();
    }
  });
});
