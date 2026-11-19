/**
 * background 渠道 + 附件交办 · server 级端到端（假渠道事实 + 真 dummy 夹具；零网络）。
 *
 * 缺陷背景：`execution-runtime` 已支持后台 Worker 任务文件面（`backgroundTaskBridge`），
 * 但 `apps/server/server.ts` 的 `createBackgroundDispatch` 调用点没注入——background 任务
 * 会复制文件，Worker 却拿不到文件面。本用例只经 `createServer` 默认装配（不手搓桥/执行器）：
 *
 *   纯附件消息（pending）→ 文字消息激活 → Main 从清单取 fileId 用 `task_run.inputFiles`
 *   交办 → 宿主复制任务副本 → 后台 Worker 委派带「任务文件清单」（副本 fileId）→
 *   Worker 以占位值调 `dummy.scratch --input/--output` → 宿主按 `contextProfiles.*.fileParams`
 *   把 `--input` 换成任务目录内的物化路径 → 真 dummy 读到附件字节 → 任务 completed。
 *
 * 判据：不出现「附件交办不支持 / Worker 无文件面」类失败；Worker 转录含副本 fileId、
 * 不含 Main 源 fileId；执行层拿到的是物化路径且字节一致。
 *
 * 反向绊线：把 server 的 `taskExecutionBridge` 注入去掉，本用例必须红（Worker 委派无清单、
 * `--input` 保持占位值、dummy 读不到文件）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  IncomingAttachment,
  IncomingChannelMessage,
} from '@fshine/contracts';
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createDummyCliClient } from '../../packages/agent/src/dummy-cli-client';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { createServer } from './server';

/** 仓内夹具树：复制一份到临时目录（平台的 tmp/task_<id> 不落在仓内）。 */
const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures');
const FIXTURE_DIRS = ['dummy-platform', 'platforms', 'scenarios'] as const;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-bg-file-'));
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
        fileParams: { input: '--input', output: '--output' },
      },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 0 窗口（受理即后台；机械断言不靠时序余量）。
    runtime: { backgroundConcurrency: 1, taskRunWaitMs: 0 },
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
  root: string;
  dbPath: string;
  server: Awaited<ReturnType<typeof createServer>>;
  workerDelegations: string[];
  outcomes: ExecutionOutcome[];
  getReceipt(): Record<string, unknown> | undefined;
  logs: Array<Record<string, unknown>>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = tempDir();
  const root = copyFixtureRoot(dir);
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const logs: Array<Record<string, unknown>> = [];
  const workerDelegations: string[] = [];
  const outcomes: ExecutionOutcome[] = [];
  let receipt: Record<string, unknown> | undefined;

  const mainDriver: TurnDriver = {
    async run(input) {
      // 清单是宿主机械事实注入（injections）：从「本会话文件清单」取源 fileId。
      const manifest = (input.injections ?? []).find((text) => text.startsWith('[本会话文件清单]'));
      if (manifest === undefined) throw new Error('（测试）本回合没有文件清单，Main 无 fileId 可交办');
      const fileId = /fileId:\s*([^，,）)]+)/.exec(manifest)?.[1]?.trim();
      if (fileId === undefined) throw new Error('（测试）清单里没有 fileId');
      receipt = (await input.exec('task_run', {
        task: '统计名册的行数与字节数',
        inputFiles: [fileId],
      })) as Record<string, unknown>;
      return { text: '已受理，后台办理中。', messages: [] as unknown as DriverMessage[] };
    },
  };

  const workerDriver: TurnDriver = {
    async run(input) {
      const first = input.messages[0] as unknown as { content?: unknown } | undefined;
      workerDelegations.push(typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? ''));
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
    dbPath,
    stateDir,
    createDrivers: () => ({ mainDriver, workerDriver }),
    // 执行客户端 = 仓内真 dummy（与默认装配同一个适配器）；只把操作集合收窄到本次用例。
    createExecutionFace: async () => ({
      client: createDummyCliClient({ root, gateway: 'bin/dummy', stateDir, env: process.env }),
      allowedOperations: ['dummy.scratch'],
      // 本用例只验证文件面（scratch 是任务内本地写，不是对外写操作）：在**测试替身**里把它
      // 登记为只读能力，使其对 viewer 也可用；生产默认面仍只从 access=read 派生只读集合。
      readOnlyOperations: ['dummy.scratch'],
    }),
    // 有推送面 = async（派发方式不是配置键）：静默端口只作能力声明，不发起真实投递。
    fileDelivery: { deliveryMode: 'silent', async sendToConversation() { throw new Error('（测试）silent 不投递'); } },
    logger: (line) => logs.push(line),
  });
  return { root, dbPath, server, workerDelegations, outcomes, getReceipt: () => receipt, logs };
}

describe('background 渠道 + 附件交办（createServer 默认装配 + 真 dummy）', () => {
  it('附件 → task_run.inputFiles → 后台 Worker 拿任务副本 → 执行层 --input 读到物化路径', async () => {
    const fx = await makeFixture();
    const registry = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
    try {
      const bytes = Buffer.from('a\nb\nc\n');
      // ① 纯附件消息：登记为 pending（不调模型、不建任务）。
      expect(await fx.server.handler(incoming('m-file', '', [stagedAttachment(fx.root, '名册.csv', bytes)]))).toBe('');

      // ② 文字消息激活 pending 并起回合：Main 交办（background，0 窗口）。
      const reply = await fx.server.handler(incoming('m-go', '统计这份名册'));
      // 「只交办」回合静默（owner 2026-11-19）：模型那段受理卡片不发终帧（reply 为空）。
      expect(reply).toBe('');

      const receipt = fx.getReceipt();
      expect(receipt).toBeDefined();
      expect(receipt!['accepted']).toBe(true);
      const taskId = String(receipt!['taskId']);

      // ③ 后台任务落定（真 dummy 执行）。
      await vi.waitFor(() => expect(fx.outcomes).toHaveLength(1), { timeout: 20_000 });
      await vi.waitFor(() => expect(registry.get(taskId, SCOPE).status).toBe('completed'), { timeout: 20_000 });

      // ④ Worker 委派带任务文件清单（副本 fileId），不含 Main 源 fileId。
      const rows = registry.store.listFileRefs(SCOPE);
      const copy = rows.find((row) => row.taskId === taskId);
      expect(copy).toBeDefined();
      expect(copy!.name).toBe('名册.csv');
      expect(copy!.fileId).not.toBe(rows.find((row) => row.taskId === undefined)!.fileId);
      expect(fx.workerDelegations).toHaveLength(1);
      expect(fx.workerDelegations[0]).toContain('[本任务文件清单]');
      expect(fx.workerDelegations[0]).toContain(copy!.fileId);
      expect(fx.workerDelegations[0]).not.toContain(rows.find((row) => row.taskId === undefined)!.fileId);

      // ⑤ 执行层真的读到了附件：--input 指向宿主物化的任务输入，内容 = 附件字节。
      const outcome = fx.outcomes[0]!;
      expect(outcome.status).toBe('completed');
      const data = (outcome as Extract<ExecutionOutcome, { status: 'completed' }>).data as {
        input: string;
        output: string;
        lines: number;
        chars: number;
      };
      expect(data.input.startsWith(path.join(fx.root, 'tmp', 'task_'))).toBe(true);
      expect(data.input).toMatch(/\/tmp\/task_[^/]+\/in\/[^/]+\.csv$/);
      expect(readFileSync(data.input)).toEqual(bytes);
      expect(data.lines).toBe(3);
      expect(data.chars).toBe(6);

      // ⑥ 无「附件交办不支持 / Worker 无文件面」类失败：桥无拒收、文件引用无不可用事件。
      expect(fx.logs.filter((line) => line['event'] === 'file_ref_unavailable')).toEqual([]);
      expect(fx.logs.filter((line) => line['event'] === 'task_file_bridge_skip')).toEqual([]);
    } finally {
      registry.close();
      await fx.server.close();
    }
  }, 60_000);
});
