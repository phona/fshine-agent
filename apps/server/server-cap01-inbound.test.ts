/**
 * CAP-01 S1 入站附件登记 · server 级确定性验证（假渠道事实 + 假执行面 + 假模型驱动；零网络）。
 *
 * 覆盖（逐条对应 ask）：
 *   ① 纯附件消息重复投递 → 走查重幂等，只登记一次（查重先于附件分支的一切副作用）；
 *   ② 纯附件 → 只登记为 pending：不调模型（不建会话、驱动零创建/零调用）、不建 Task、
 *      回执空串（渠道走既有文件收据窗）；
 *   ③ 激活语义：带文字的消息激活本会话全部 TTL 内 pending——文字+附件一条消息、或
 *      先发文件再发指令（指令消息不带附件，不按 messageId）；登记字节 copy 进 workspace；
 *   ④ TTL 过期的 pending 不激活（同回合 TTL 内新 pending 照常激活，激活计数只含 TTL 内）。
 *
 * 登记行经只读底账核验（core 行访问器）；驱动创建/调用计数 = 「没调模型」的机械证据。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, IncomingAttachment, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { FILE_REF_TTL_MS, fileStoragePathOf } from '../../packages/agent/src/file-store';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { createServer, workspaceRootOf } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-cap01-'));
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

const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

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
};

interface DriverCount {
  creations: number;
  runs: DriverMessage[][];
}

/** 按最后一条 user 文本查回复的假主驱动；创建与调用都计数（= 调模型的机械证据）。 */
function scriptedDriver(replies: ReadonlyMap<string, string>, count: DriverCount): TurnDriver {
  return {
    async run(input) {
      count.runs.push([...input.messages]);
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const reply = replies.get(text);
      if (reply === undefined) throw new Error(`（测试）未配置的回合：${text}`);
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

function incoming(
  userId: string,
  conversationId: string,
  messageId: string,
  text: string,
  attachments?: readonly IncomingAttachment[],
): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
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
  dbPath: string;
  server: Awaited<ReturnType<typeof createServer>>;
  ro: ReturnType<typeof openTaskStore>;
  logs: Array<Record<string, unknown>>;
  count: DriverCount;
}

async function makeFixture(replies: ReadonlyMap<string, string> = new Map()): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const logs: Array<Record<string, unknown>> = [];
  const count: DriverCount = { creations: 0, runs: [] };
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath,
    createDrivers: () => {
      count.creations += 1;
      return { mainDriver: scriptedDriver(replies, count), workerDriver: workerNeverCalled };
    },
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    logger: (line) => logs.push(line),
  });
  const ro = openTaskStore(dbPath, { readOnly: true });
  return { dir, dbPath, server, ro, logs, count };
}

describe('CAP-01 S1 入站附件登记（server 级）', () => {
  it('① 纯附件消息重复投递：走查重，只登记一次', async () => {
    const { dbPath, server, ro, logs } = await makeFixture();
    try {
      const message = incoming('user-a', 'conv-a', 'm-file-1', '', [
        stagedAttachment(path.dirname(dbPath), '数据.xlsx', Buffer.from('excel-bytes')),
      ]);
      expect(await server.handler(message)).toBe('');
      expect(await server.handler(message)).toBe(''); // 同 messageId 重投

      const rows = ro.listFileRefs(SCOPE);
      expect(rows).toHaveLength(1); // 查重先于附件分支：重投没有第二次登记
      expect(rows[0]!.name).toBe('数据.xlsx');
      expect(rows[0]!.activatedAt).toBeUndefined();
      expect(rows[0]!.bytes).toBe('excel-bytes'.length);
      // 第二次投递按既有回执幂等重放；登记事件只有第一次那回。
      expect(logs.filter((line) => line['event'] === 'message_duplicate_replayed')).toHaveLength(1);
      expect(logs.filter((line) => line['event'] === 'message_attachment_only')).toHaveLength(1);
    } finally {
      ro.close();
      await server.close();
    }
  });

  it('② 纯附件：不调模型、不建 Task，回执空串', async () => {
    const { dir, server, ro, logs, count } = await makeFixture();
    try {
      const message = incoming('user-a', 'conv-a', 'm-file-2', '', [
        stagedAttachment(dir, '名册.xlsx', Buffer.from('mingce-bytes')),
      ]);
      const reply = await server.handler(message);

      expect(reply).toBe(''); // 空回执：渠道走既有文件收据窗
      expect(count.creations).toBe(0); // 没建会话 → 没调模型
      expect(count.runs).toHaveLength(0);
      expect(ro.listFileRefs(SCOPE)).toHaveLength(1); // 附件登记为 pending
      expect(ro.listFileRefs(SCOPE)[0]!.activatedAt).toBeUndefined();
      expect(ro.listTasks(SCOPE)).toEqual([]); // 不建 Task
      expect(logs.some((line) => line['event'] === 'message_done')).toBe(false);
    } finally {
      ro.close();
      await server.close();
    }
  });

  it('③ 激活语义：文字+附件一条消息、或先发文件再发指令 → pending 转 activated', async () => {
    const { dir, dbPath, server, ro, logs } = await makeFixture(new Map([['汇总这份明细', '已汇总']]));
    try {
      // 形 A：文字+附件一条消息 → 登记为 pending，随即被本条激活。
      const replyA = await server.handler(
        incoming('user-a', 'conv-a', 'm-1', '汇总这份明细', [stagedAttachment(dir, '明细.xlsx', Buffer.from('mingxi-bytes'))]),
      );
      expect(replyA).toBe('已汇总');
      const rowsA = ro.listFileRefs(SCOPE);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.name).toBe('明细.xlsx');
      expect(rowsA[0]!.activatedAt).toBeDefined();
      // 字节 copy 进 workspace（派生布局），不是对原路径的引用。
      const storageA = fileStoragePathOf(workspaceRootOf(dbPath), SCOPE, rowsA[0]!.fileId, '明细.xlsx');
      expect(readFileSync(storageA).toString()).toBe('mingxi-bytes');

      // 形 B：先发文件（pending，不激活）→ 再发指令（指令消息不带附件；激活本会话 pending）。
      await server.handler(incoming('user-a', 'conv-a', 'm-file-2', '', [stagedAttachment(dir, '名册.xlsx', Buffer.from('mingce-bytes'))]));
      const rowB1 = ro.listFileRefs(SCOPE).find((row) => row.name === '名册.xlsx');
      expect(rowB1?.activatedAt).toBeUndefined();
      await server.handler(incoming('user-a', 'conv-a', 'm-instr-2', '汇总这份明细'));
      const rowB2 = ro.getFileRef(rowB1!.fileId, SCOPE);
      expect(rowB2?.activatedAt).toBeDefined();
      expect(logs.some((line) => line['event'] === 'pending_files_activated')).toBe(true);
    } finally {
      ro.close();
      await server.close();
    }
  });

  it('④ TTL 过期的 pending 不激活（同回合 TTL 内新 pending 照常激活）', async () => {
    const { dir, dbPath, server, ro, logs } = await makeFixture(new Map([['汇总', '已汇总']]));
    try {
      // 种子：过期 pending 行（created_at 早于 TTL 窗口）+ 落字节（排除 bytes_missing 干扰）。
      const seed = openTaskStore(dbPath);
      seed.insertFileRef({
        fileId: 'file_stale_seed',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        name: '旧表.xlsx',
        sha256: 'sha_stale',
        bytes: 3,
        createdAt: Date.now() - FILE_REF_TTL_MS - 60_000, // activatedAt 缺省 = pending
      });
      const staleStorage = fileStoragePathOf(workspaceRootOf(dbPath), SCOPE, 'file_stale_seed', '旧表.xlsx');
      mkdirSync(path.dirname(staleStorage), { recursive: true });
      writeFileSync(staleStorage, '旧字节');
      seed.close();

      await server.handler(incoming('user-a', 'conv-a', 'm-fresh', '', [stagedAttachment(dir, '新表.xlsx', Buffer.from('new-bytes'))]));
      await server.handler(incoming('user-a', 'conv-a', 'm-go', '汇总'));

      const rows = ro.listFileRefs(SCOPE);
      const stale = rows.find((row) => row.fileId === 'file_stale_seed');
      const fresh = rows.find((row) => row.name === '新表.xlsx');
      expect(fresh?.activatedAt).toBeDefined(); // TTL 内照常激活
      expect(stale?.activatedAt).toBeUndefined(); // TTL 过期不激活（保持 pending）
      const activatedLog = logs.find((line) => line['event'] === 'pending_files_activated');
      expect(activatedLog?.['activated']).toBe(1); // 激活计数只含 TTL 内
    } finally {
      ro.close();
      await server.close();
    }
  });
});
