/**
 * CAP-01 入站附件上限（20MB）· server 级确定性验证（假渠道事实 + 假执行面 + 假模型驱动；零网络）：
 *   ① 19MB 通过并登记（pending）；
 *   ② 21MB 被拒：不登记、无模型回合、结构化事件含 bytes 与上限、用户话术含「20MB」；
 *   ③ 恰好 20MB：放行（判据是 `> 上限`，「上限 20MB」= 最多可发 20MB）。
 * 另覆盖：文字+附件超限整条消息拒绝（不得静默丢掉附件继续回合）。
 *
 * 大文件用稀疏文件（truncate）构造：字节数真实、源侧不占盘；登记时会真实复制进
 * workspace（19/20MB 各一份），仅用于证明「通过并登记」。
 */
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, IncomingAttachment, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const MB = 1024 * 1024;
const LIMIT_BYTES = 20 * MB;

const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-cap01-attachment-limit-'));
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
};

interface DriverCount {
  creations: number;
  runs: DriverMessage[][];
}

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

/** 渠道落盘形状的附件：稀疏文件（真实字节数，源侧不占盘）。 */
function stagedSparseAttachment(root: string, filename: string, bytes: number): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, '');
  truncateSync(filePath, bytes);
  return { filename, path: filePath, bytes };
}

interface Fixture {
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
  return { dbPath, server, ro, logs, count };
}

function tooLargeLogs(logs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return logs.filter((line) => line['event'] === 'inbound_attachment_too_large');
}

describe('CAP-01 入站附件 20MB 上限（server 级）', () => {
  it('① 19MB 通过并登记为 pending', async () => {
    const { dbPath, server, ro, logs } = await makeFixture();
    try {
      const message = incoming('m-19', '', [
        stagedSparseAttachment(path.dirname(dbPath), '大表-19.xlsx', 19 * MB),
      ]);
      expect(await server.handler(message)).toBe(''); // 纯附件：空回执（渠道走文件收据窗）

      const rows = ro.listFileRefs(SCOPE);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('大表-19.xlsx');
      expect(rows[0]!.bytes).toBe(19 * MB);
      expect(rows[0]!.activatedAt).toBeUndefined(); // pending
      expect(logs.some((line) => line['event'] === 'message_attachment_only')).toBe(true);
      expect(tooLargeLogs(logs)).toEqual([]);
    } finally {
      ro.close();
      await server.close();
    }
  }, 60_000);

  it('② 21MB 被拒：不登记、无模型回合、事件含 bytes 与上限、话术含「20MB」', async () => {
    const { dbPath, server, ro, logs, count } = await makeFixture();
    try {
      const message = incoming('m-21', '', [
        stagedSparseAttachment(path.dirname(dbPath), '超大表-21.xlsx', 21 * MB),
      ]);
      const reply = await server.handler(message);

      // 用户话术明确（不静默丢弃）。
      expect(reply).toContain('20MB');
      expect(reply).toContain('压缩或拆分');
      // 不登记（底账零行）且不起模型回合（驱动零创建/零调用）。
      expect(ro.listFileRefs(SCOPE)).toEqual([]);
      expect(count.creations).toBe(0);
      expect(count.runs).toHaveLength(0);
      // 结构化事件：bytes 与上限都在（机械事实，便于追溯）。
      const events = tooLargeLogs(logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        messageId: 'm-21',
        name: '超大表-21.xlsx',
        bytes: 21 * MB,
        limitBytes: LIMIT_BYTES,
      });
      expect(logs.some((line) => line['event'] === 'message_attachment_only')).toBe(false);
    } finally {
      ro.close();
      await server.close();
    }
  }, 60_000);

  it('③ 恰好 20MB：放行并登记（上限 = 最多可发 20MB，判据 `> 上限` 才拒）', async () => {
    const { dbPath, server, ro, logs } = await makeFixture();
    try {
      const message = incoming('m-20', '', [
        stagedSparseAttachment(path.dirname(dbPath), '正好-20.xlsx', LIMIT_BYTES),
      ]);
      expect(await server.handler(message)).toBe('');

      const rows = ro.listFileRefs(SCOPE);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.bytes).toBe(LIMIT_BYTES);
      expect(tooLargeLogs(logs)).toEqual([]);
    } finally {
      ro.close();
      await server.close();
    }
  }, 60_000);

  it('文字+附件超限：整条消息拒绝（附件不静默丢失、不起回合），话术同 ②', async () => {
    const { dbPath, server, ro, logs, count } = await makeFixture(new Map([['汇总这份明细', '已汇总']]));
    try {
      const reply = await server.handler(
        incoming('m-text-21', '汇总这份明细', [
          stagedSparseAttachment(path.dirname(dbPath), '超大明细.xlsx', 21 * MB),
        ]),
      );

      expect(reply).toContain('20MB');
      expect(ro.listFileRefs(SCOPE)).toEqual([]); // 一个附件都没登记
      expect(ro.listTasks(SCOPE)).toEqual([]);
      expect(count.creations).toBe(0); // 没有开回合、没有调模型
      expect(tooLargeLogs(logs)).toHaveLength(1);
      expect(logs.some((line) => line['event'] === 'message_done')).toBe(false);
    } finally {
      ro.close();
      await server.close();
    }
  }, 60_000);
});
