/**
 * 观测面接线（2026-11-17 补口）· server 生产装配级确定性验证（假渠道事实 + 假执行面 + 假驱动；零网络）。
 *
 * 三条已确认缺口（docs/product/event-catalog.md 核对结论）：
 *   ① `onFileRefUnavailable` 从未注入：文件引用被拒的机械 reason（missing/foreign/expired/pending）
 *      从来不进任何日志。本用例断言装配层注入后发出 `file_ref_unavailable`（reason 原值），
 *      且用户可见回复与模型可见工具话术都不含机械 reason/fileId（防存在性 oracle）。
 *   ② 任务 out/ 兜底扫描的 `skipped` 被丢：本用例在任务 out/ 放一个 symlink，断言收尾扫描
 *      发出 `task_output_sweep_skipped`（数量 + reason 分布），而不是静默丢弃。
 *   ③ `inbound_files_registered` 只覆盖「文字+附件」：纯附件路径补发同一事件（不改名、不丢
 *      `message_attachment_only`），断言两条路径的「附件已登记」都可查。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AppConfig,
  IncomingAttachment,
  IncomingChannelMessage,
} from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { FileRefUnavailableError, type FileStore } from '../../packages/agent/src/file-store';
import type { RunJsExecutor } from '../../packages/agent/src/run-js-executor';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-obs' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-obs-wiring-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(root: string, fileParams?: { input?: string; output?: string }): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: {
        root,
        gateway: 'bin/dummy',
        skillRoots: ['.agents/skills-serve'],
        ...(fileParams === undefined ? {} : { fileParams }),
      },
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

function incoming(
  messageId: string,
  text: string,
  attachments?: readonly IncomingAttachment[],
): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-obs',
    messageId,
    chatType: 'single',
    text,
    ...(attachments === undefined ? {} : { attachments }),
    ...(text.trim() === '' ? { attachmentOnly: true } : {}),
    receivedAt: new Date().toISOString(),
  };
}

/** 渠道落盘形状的附件：写到临时目录（adapter 的 saveAttachments 义务），返回契约形状。 */
function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

/** 单步主驱动：调一次工具（错误按真实驱动语义记为工具结果），然后返回给定文本。 */
function toolCallingDriver(input: {
  tool: string;
  args: Record<string, unknown>;
  reply: string;
  toolErrors: string[];
}): TurnDriver {
  return {
    async run(runInput) {
      try {
        await runInput.exec(input.tool, input.args);
      } catch (error) {
        input.toolErrors.push(error instanceof Error ? error.message : String(error));
      }
      return {
        text: input.reply,
        messages: [...runInput.messages, { role: 'assistant', content: input.reply } as never],
      };
    },
  };
}

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
}

async function makeFixture(input: {
  dir: string;
  root: string;
  mainDriver: TurnDriver;
  workerDriver?: TurnDriver;
  client?: ExecutionClient;
  createRunJsExecutor?: (fileStore: FileStore) => RunJsExecutor;
  fileParams?: { input?: string; output?: string };
}): Promise<Fixture> {
  const logs: Array<Record<string, unknown>> = [];
  const client = input.client ?? new FaceClient();
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(input.root, input.fileParams),
    dbPath: path.join(input.dir, 'state.db'),
    createDrivers: () => ({
      mainDriver: input.mainDriver,
      workerDriver: input.workerDriver ?? {
        async run() {
          throw new Error('（测试）worker 不应被调用');
        },
      },
    }),
    createExecutionFace: async () => ({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    ...(input.createRunJsExecutor === undefined ? {} : { createRunJsExecutor: input.createRunJsExecutor }),
    logger: (line) => logs.push(line),
  });
  return { server, logs };
}

describe('观测面接线（三条已确认缺口）', () => {
  it('① 文件引用被拒：file_ref_unavailable 事件带机械 reason；用户/模型话术零泄露', async () => {
    const dir = tempDir();
    const toolErrors: string[] = [];
    const mainDriver = toolCallingDriver({
      tool: 'run_js',
      args: { code: "console.log('x');", inputs: ['file_missing'] },
      reply: '本轮没有可用的输入文件。',
      toolErrors,
    });
    const fx = await makeFixture({
      dir,
      root: FIXTURE_ROOT,
      mainDriver,
      // 执行器在解析输入阶段拒绝（与真实执行器 FileRefUnavailableError 同形），不 spawn 子进程。
      createRunJsExecutor: () => ({
        async runJs() {
          throw new FileRefUnavailableError('missing_or_foreign:file_missing');
        },
      }),
    });
    try {
      const reply = await fx.server.handler(incoming('m-ref-1', '用这个文件跑一下'));

      const events = fx.logs.filter((line) => line['event'] === 'file_ref_unavailable');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: 'file_ref_unavailable',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        reason: 'missing_or_foreign:file_missing',
      });

      // 用户可见文本零变化：回复仍是模型文本，机械 reason/fileId 不泄露。
      expect(reply).toBe('本轮没有可用的输入文件。');
      expect(reply).not.toContain('missing_or_foreign');
      expect(reply).not.toContain('file_missing');
      // 模型可见工具话术也统一（防存在性 oracle）：不含 reason/fileId。
      expect(toolErrors).toHaveLength(1);
      expect(toolErrors[0]).toContain('输入文件不可用');
      expect(toolErrors[0]).not.toContain('missing_or_foreign');
      expect(toolErrors[0]).not.toContain('file_missing');
    } finally {
      await fx.server.close();
    }
  });

  it('② 任务 out/ 兜底扫描拒收：task_output_sweep_skipped 含数量与 reason 分布', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'platform');
    mkdirSync(root, { recursive: true });
    const toolErrors: string[] = [];
    const mainDriver = toolCallingDriver({
      tool: 'task_run',
      args: { task: '整理一下任务文件' },
      reply: '已完成。',
      toolErrors,
    });
    const workerDriver: TurnDriver = {
      async run(runInput) {
        // 触发桥的单文件输出参数翻译：宿主在任务 out/ 下分配确定路径。
        await runInput.exec('execute_operation', {
          operation: 'dummy.query',
          args: { '--output': 'placeholder' },
        });
        return {
          text: '已处理。',
          messages: [...runInput.messages, { role: 'assistant', content: '已处理。' } as never],
        };
      },
    };
    const client: ExecutionClient = {
      async capabilities() {
        return MANIFEST;
      },
      async execute(request) {
        // 在宿主分配的任务 out/ 里放一个 symlink：兜底扫描必须拒收并留下机械 reason。
        const outPath = String(request.args['--output']);
        const outDir = path.dirname(outPath);
        mkdirSync(outDir, { recursive: true });
        symlinkSync(path.join(dir, 'outside-target'), path.join(outDir, 'evil-link'));
        return { status: 'completed', data: {} };
      },
    };
    const fx = await makeFixture({
      dir,
      root,
      mainDriver,
      workerDriver,
      client,
      fileParams: { output: '--output' },
    });
    try {
      const reply = await fx.server.handler(incoming('m-sweep-1', '整理一下文件'));

      const events = fx.logs.filter((line) => line['event'] === 'task_output_sweep_skipped');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'task_output_sweep_skipped',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        skipped: 1,
        reasons: { symlink: 1 },
      });
      expect(String(events[0]!['taskId'])).toMatch(/^task_/);
      // 拒收事实不进用户话术。
      expect(reply).toBe('已完成。');
      expect(reply).not.toContain('symlink');
      expect(toolErrors).toEqual([]);
    } finally {
      await fx.server.close();
    }
  });

  it('③ 纯附件路径也发 inbound_files_registered（与 message_attachment_only 并存，不改名）', async () => {
    const dir = tempDir();
    const mainDriver: TurnDriver = {
      async run() {
        throw new Error('（测试）纯附件不应调模型');
      },
    };
    const fx = await makeFixture({ dir, root: FIXTURE_ROOT, mainDriver });
    try {
      const reply = await fx.server.handler(
        incoming('m-file-only-1', '', [stagedAttachment(dir, '名册.xlsx', Buffer.from('mingce-bytes'))]),
      );

      expect(reply).toBe(''); // 用户可见回执逐字不变（渠道走既有文件收据窗）。
      const registered = fx.logs.filter((line) => line['event'] === 'inbound_files_registered');
      const attachmentOnly = fx.logs.filter((line) => line['event'] === 'message_attachment_only');
      expect(registered).toHaveLength(1);
      expect(attachmentOnly).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        event: 'inbound_files_registered',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        messageId: 'm-file-only-1',
      });
      expect(registered[0]!['fileIds']).toEqual(attachmentOnly[0]!['fileIds']);
      expect(registered[0]!['fileIds']).toHaveLength(1);
    } finally {
      await fx.server.close();
    }
  });
});
