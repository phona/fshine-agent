/**
 * CAP-01 单文件参数（`fileParams`）· **默认服务装配**端到端（假渠道事实 + 真 dummy 夹具；零网络）。
 *
 * 缺陷背景：桥的 `fileParams` 翻译此前只在测试自己构造桥时生效；`createServer` 的默认
 * 装配没有把部署声明透传下去，生产路径上附件仍然到不了执行层。
 *
 * 本用例只经 `createServer` 装配（不手搓桥）：
 *   用户发附件（纯附件消息 → pending 文件行）→ 文字消息激活 → Main 用 `task_run.inputFiles`
 *   交办（宿主复制任务副本）→ Worker 以占位值调用 `dummy.scratch --input/--output`
 *   → 宿主按 `contextProfiles.*.fileParams` 声明把 `--input` 换成物化路径、`--output`
 *   换成任务 out/ 下的确定路径 → 真 dummy 读到附件字节并写出产物 → 兜底扫描登记
 *   → 回合交付端口收到 `exec-output.json`。
 *
 * 反向绊线：把 profile 的 `fileParams` 去掉，`--input` 保持占位值，dummy 读不到文件、
 * 执行失败、产物缺失——同一用例必须红（ttl 手工验证；不在套件里重复放一份变体）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createDummyCliClient } from '../../packages/agent/src/dummy-cli-client';
import { createServer } from './server';

/** 仓内夹具树：复制一份到临时目录（平台的 tmp/task_<id> 不落在仓内）。 */
const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures');
const FIXTURE_DIRS = ['dummy-platform', 'platforms', 'scenarios'] as const;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-file-params-'));
  tempDirs.push(dir);
  return dir;
}

function copyFixtureRoot(dir: string): string {
  const fixtures = path.join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  for (const name of FIXTURE_DIRS) {
    cpSync(path.join(FIXTURES_ROOT, name), path.join(fixtures, name), { recursive: true });
  }
  return path.join(fixtures, 'dummy-platform');
}

function testConfig(root: string): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true },
    },
    contextProfiles: {
      dummy: {
        root,
        gateway: 'bin/dummy',
        skillRoots: ['.agents/skills-serve'],
        // 部署对执行层的声明：`dummy.scratch` 吃一个文件、写一个文件。
        fileParams: { input: '--input', output: '--output' },
      },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 有推送面 = 后台派发（async）；0 窗口让受理即返回，产物走后台完成投递（确定性）。
    runtime: { taskRunWaitMs: 0 },
  };
}

const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

function incoming(
  messageId: string,
  text: string,
  attachments?: readonly IncomingAttachment[],
): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
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

interface Fixture {
  dir: string;
  root: string;
  server: Awaited<ReturnType<typeof createServer>>;
  logs: Array<Record<string, unknown>>;
  delivered: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }>;
  outcomes: ExecutionOutcome[];
  /** 第二回合（文字消息）的 Main 驱动从这里拿附件 fileId。 */
  setFileId: (fileId: string) => void;
}

async function makeFixture(): Promise<Fixture> {
  const dir = tempDir();
  const root = copyFixtureRoot(dir);
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const logs: Array<Record<string, unknown>> = [];
  const delivered: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> = [];
  const outcomes: ExecutionOutcome[] = [];
  let fileId: string | undefined;

  const mainDriver: TurnDriver = {
    async run(input) {
      if (fileId === undefined) throw new Error('（测试）附件尚未登记，没有可交办的 fileId');
      await input.exec('task_run', { task: '统计名册的行数与字节数', inputFiles: [fileId] });
      return { text: '名册统计完成。', messages: [] as unknown as DriverMessage[] };
    },
  };
  const workerDriver: TurnDriver = {
    async run(input) {
      // 模型看不到真实路径：占位值由宿主按部署声明替换。
      const outcome = await input.exec('execute_operation', {
        operation: 'dummy.scratch',
        args: { '--input': '(host-fills)', '--output': '(host-fills)' },
      });
      outcomes.push(outcome as ExecutionOutcome);
      if ((outcome as ExecutionOutcome).status !== 'completed') {
        throw new Error(`（测试）执行层未成功：${JSON.stringify(outcome)}`);
      }
      return { text: '名册统计完成。', messages: [] as unknown as DriverMessage[] };
    },
  };

  const server = await createServer({
    env: { ...process.env, LLM_MODEL: 'test-model' },
    config: testConfig(root),
    dbPath: path.join(dir, 'state.db'),
    stateDir,
    createDrivers: () => ({ mainDriver, workerDriver }),
    // 执行客户端 = 仓内真 dummy（与默认装配同一个适配器）；只把操作集合收窄到本次用例。
    createExecutionFace: async () => ({
      client: createDummyCliClient({
        root,
        gateway: 'bin/dummy',
        stateDir,
        env: process.env,
      }),
      allowedOperations: ['dummy.scratch'],
      // 本用例只验证单文件参数翻译（scratch 是任务内本地写，不是对外写操作）：在**测试替身**
      // 里把它登记为只读能力，使其对 viewer 也可用；生产默认面仍只从 access=read 派生只读集合。
      readOnlyOperations: ['dummy.scratch'],
    }),
    fileDelivery: {
      deliveryMode: 'live',
      async sendToConversation(route, files): Promise<DeliveryReceipt> {
        delivered.push({ route, files });
        return {
          route,
          parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })),
        };
      },
    },
    logger: (line) => logs.push(line),
  });

  return {
    dir,
    root,
    server,
    logs,
    delivered,
    outcomes,
    setFileId: (value) => {
      fileId = value;
    },
  };
}

describe('CAP-01 单文件参数：默认服务装配（createServer + 真 dummy 夹具）', () => {
  it('附件 → 委派 → 执行层 --input 收到物化路径 → 写产物 → 交付', async () => {
    const { root, server, logs, delivered, outcomes, setFileId } = await makeFixture();
    try {
      // ① 纯附件消息：登记为 pending 文件（不调模型、不建任务）。
      const attachmentReply = await server.handler(
        incoming('m-file', '', [stagedAttachment(root, '名册.csv', Buffer.from('a\nb\nc\n'))]),
      );
      expect(attachmentReply).toBe('');
      const attached = logs.find((line) => line['event'] === 'message_attachment_only');
      expect(attached).toBeDefined();
      setFileId((attached!['fileIds'] as string[])[0]!);

      // ② 文字消息激活 pending 并起回合：Main 交办（inputFiles）→ Worker 调 dummy.scratch。
      const reply = await server.handler(incoming('m-go', '统计这份名册'));
      expect(reply).toContain('名册统计完成。');

      // ③ 执行层真的读到了附件：--input 指向宿主物化的任务输入，内容 = 附件字节。
      await vi.waitFor(() => {
        expect(outcomes).toHaveLength(1);
      }, { timeout: 30_000 });
      const outcome = outcomes[0]!;
      expect(outcome.status).toBe('completed');
      const data = (outcome as Extract<ExecutionOutcome, { status: 'completed' }>).data as {
        input: string;
        output: string;
        lines: number;
        chars: number;
      };
      expect(data.lines).toBe(3);
      expect(data.chars).toBe(6);
      expect(data.input).toMatch(/\/tmp\/task_[^/]+\/in\/[^/]+\.csv$/);
      expect(data.input.startsWith(path.join(root, 'tmp', 'task_'))).toBe(true);
      expect(readFileSync(data.input, 'utf8')).toBe('a\nb\nc\n');
      // --output 也由宿主分配在任务 out/ 下（执行层写到那里）。
      expect(data.output).toMatch(/\/tmp\/task_[^/]+\/out\/exec-output\.json$/);

      // ④ 产物经兜底扫描登记后进入交付：渠道端口收到执行层写出的文件。
      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1);
      }, { timeout: 30_000 });
      const files = delivered[0]!.files;
      expect(files.map((file) => file.filename)).toEqual(['exec-output.json']);
      expect(JSON.parse(files[0]!.data.toString('utf8'))).toEqual({ lines: 3, chars: 6 });
    } finally {
      await server.close();
    }
  }, 60_000);
});
