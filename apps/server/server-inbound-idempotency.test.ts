/**
 * 入站消息跨重启幂等（底账事实，2026-11-19）。
 *
 * 问题：渠道重投幂等原先只在进程内存（`messageReplies` Map）——进程一重启，同一条
 * messageId 会被当成新消息**重新处理一遍**（重复建任务、重复执行写操作）。本片把
 * 「这条入站消息处理过没有」搬成底账事实（inbound_messages 表），跨重启仍成立。
 *
 * 真装配：createServer + 真实 handler（不 stub 去重路径），假执行客户端计数执行层调用，
 * 假模型驱动；服务端缺省（无 push 面）= 同步派发，await handler 即回合落定。
 * 用例：
 *   ① 同 messageId 连发两次（同一实例）→ 第二次回放同一句回执、零新任务、零新执行；
 *   ② 关掉 server、同 dbPath 重建、再投同一条 messageId → 回放同一句回执、零新任务、零执行；
 *   ③ 底账留一条 processing（上一进程挂了）→ 再投不执行、回**如实兜底**（没办完/不重复执行/请重发）、落事件；
 *   ④ 不同会话的相同 messageId 不得互相吞（主键含 principal+session）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { createServer, MESSAGE_REPLY_LIMIT, type Server } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
/** 「上一进程挂了」的如实兜底（与 server.ts 的 INBOUND_STILL_PROCESSING_NOTE 逐字一致）。 */
const STILL_PROCESSING_NOTE =
  '这条消息上次没办完（我这边中途中断过），我不会重复执行它，结果未知——麻烦你重发一次。';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-inbound-idem-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:test-user': { enabled: true },
      'wecom:other-user': { enabled: true },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

/** 单聊里 conversationId = userid → principal/session 都是 `wecom:<userid>`。 */
function incoming(userid: string, messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: userid,
    channel: 'wecom',
    conversationId: userid,
    messageId,
    chatType: 'single',
    text: '帮我查一下 documents 窗口 W202611 的数据',
    receivedAt: new Date().toISOString(),
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query items', args: [] }],
};

/** 计数执行客户端：每次真实执行都进 requests（外部副作用计数）。 */
class CountingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return { status: 'completed', data: {} };
  }
}

function mainDriver(): TurnDriver {
  return {
    async run(input) {
      await input.exec('task_run', { task: '查询 documents 窗口 W202611' });
      const reply = '已受理：documents 窗口 W202611 共 3 条。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

function workerDriver(): TurnDriver {
  return {
    async run(input) {
      await input.exec('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } });
      const reply = '已查询 documents W202611：3 条。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

async function startServer(
  dbPath: string,
  client: CountingClient,
  logs: Array<Record<string, unknown>>,
): Promise<Server> {
  return createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath,
    createDrivers: async () => ({ mainDriver: mainDriver(), workerDriver: workerDriver() }),
    createExecutionFace: async () => ({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    logger: (line) => logs.push(line),
  });
}

/** 底账任务行数（另开一条连接读；真值，不看内存）。 */
function countTasks(dbPath: string): number {
  const store = openTaskStore(dbPath);
  const count = store.listTasks().length;
  store.close();
  return count;
}

describe('入站消息跨重启幂等（底账事实）', () => {
  it('① 同一 messageId 连发两次（同一实例）：第二次回放同一句回执，零新任务、零新执行', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();
    const server = await startServer(dbPath, client, logs);
    try {
      const first = await server.handler(incoming('test-user', 'msg-1'));
      const second = await server.handler(incoming('test-user', 'msg-1'));

      expect(second).toBe(first);
      expect(first).toContain('3 条');
      expect(countTasks(dbPath)).toBe(1);
      expect(client.requests).toHaveLength(1);
      expect(logs.filter((line) => line['event'] === 'message_duplicate_replayed').length).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it('② 关掉 server、同 dbPath 重建、再投同一条 messageId：回放同一句回执，零新任务、零执行', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();

    const serverA = await startServer(dbPath, client, logs);
    const first = await serverA.handler(incoming('test-user', 'msg-restart'));
    const tasksAfterFirst = countTasks(dbPath);
    await serverA.close();

    // 进程内「重启」：同 dbPath 重建（去重必须靠底账，内存 Map 已随 serverA 消失）。
    const serverB = await startServer(dbPath, client, logs);
    try {
      const replay = await serverB.handler(incoming('test-user', 'msg-restart'));

      expect(replay).toBe(first);
      expect(replay).toContain('3 条');
      expect(countTasks(dbPath)).toBe(tasksAfterFirst); // 零新任务
      expect(client.requests).toHaveLength(1); // 零执行
      expect(logs.filter((line) => line['event'] === 'message_duplicate_replayed').length).toBeGreaterThanOrEqual(1);
    } finally {
      await serverB.close();
    }
  });

  it('③ 底账留 processing（上一进程挂了）：再投不执行、回如实兜底（不谎称还在办）、落事件', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');

    // 模拟上一进程认领后挂在半途：直接往底账插一条 state='processing' 行。
    const seed = openTaskStore(dbPath);
    const seeded = seed.claimInboundMessage({
      messageId: 'msg-stuck',
      principalId: 'wecom:test-user',
      sessionId: 'wecom:test-user',
      claimedAt: new Date().toISOString(),
    });
    seed.close();
    expect(seeded).toEqual({ outcome: 'claimed' });

    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();
    const server = await startServer(dbPath, client, logs);
    try {
      const reply = await server.handler(incoming('test-user', 'msg-stuck'));

      expect(reply).toBe(STILL_PROCESSING_NOTE);
      // 如实兜底的三条硬要求：不谎称还在办、说明不重复执行、给出下一步（重发）。
      expect(STILL_PROCESSING_NOTE).not.toContain('还在办');
      expect(STILL_PROCESSING_NOTE).not.toContain('办完会发你');
      expect(STILL_PROCESSING_NOTE).toContain('不会重复执行');
      expect(STILL_PROCESSING_NOTE).toContain('重发');
      expect(client.requests).toHaveLength(0); // 不重复执行
      expect(countTasks(dbPath)).toBe(0); // 不重复办事
      const events = logs.filter((line) => line['event'] === 'message_still_processing');
      expect(events).toHaveLength(1);
      expect(events[0]!['messageId']).toBe('msg-stuck');
    } finally {
      await server.close();
    }
  });

  it('④ 不同会话的相同 messageId 不得互相吞（主键含 principal+session）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();
    const server = await startServer(dbPath, client, logs);
    try {
      // 同一 messageId，两个不同用户（= 两个不同 principal/session）。
      const a = await server.handler(incoming('test-user', 'same-msg'));
      const b = await server.handler(incoming('other-user', 'same-msg'));

      expect(a).toContain('3 条');
      expect(b).toContain('3 条');
      expect(client.requests).toHaveLength(2); // 两条都真办了
      expect(countTasks(dbPath)).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('⑤ 回合成功但落定写失败：必须释放入站认领，同 messageId 重投不误报「请重发」', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();
    const server = await startServer(dbPath, client, logs);
    try {
      // 只拦底账 UPDATE（落定），不拦 INSERT（认领）与 DELETE（释放）——精确模拟
      // 「落定写失败、其余写正常」的真实形态（磁盘满 / 写锁类瞬时故障）。
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TRIGGER block_inbound_complete BEFORE UPDATE ON inbound_messages
        BEGIN SELECT RAISE(ABORT, 'simulated settle write failure'); END;
      `);

      const first = await server.handler(incoming('test-user', 'msg-settle-fail'));
      // 回合本身成功：回复照常返回（落定失败不翻转本次结果），失败进观测事件。
      expect(first).toContain('3 条');
      expect(logs.some((line) => line['event'] === 'inbound_message_settle_failed')).toBe(true);

      // 修复点：落定失败必须像失败分支一样删认领行——底账不留 processing 孤儿。
      const audit = openTaskStore(dbPath);
      const row = audit.getInboundMessage({
        messageId: 'msg-settle-fail',
        principalId: 'wecom:test-user',
        sessionId: 'wecom:test-user',
      });
      audit.close();
      expect(row).toBeUndefined();

      // 同 messageId 重投：不得被误报成「上一进程挂了，请重发」（那会把用户推向新
      // messageId 重发，必然重复执行写）——按新消息重办，回执仍是真回执。
      const second = await server.handler(incoming('test-user', 'msg-settle-fail'));
      expect(second).toBe(first);
      expect(second).not.toContain('没办完');
      expect(client.requests).toHaveLength(2); // 重投真重办了（两次执行）
      raw.close();
    } finally {
      await server.close();
    }
  });

  it('⑥ 在途表超限：不得驱逐仍在跑的 Promise（并发重投必须回放同一句，不误读底账）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const logs: Array<Record<string, unknown>> = [];
    const client = new CountingClient();
    // 闸门驱动：首回合停在驱动里，整个超限灌入期间所有在途条目保持 pending。
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const gatedDriver: TurnDriver = {
      async run(input) {
        await gate;
        const reply = `回复：${input.messages.length} 条历史`;
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      createDrivers: async () => ({ mainDriver: gatedDriver, workerDriver: gatedDriver }),
      createExecutionFace: async () => ({
        client,
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      logger: (line) => logs.push(line),
    });
    try {
      // 精确超限灌入（上限 +1 条），全部不 await：每个 messageId 同步认领 + 记在途。
      // 全部同会话 → 首回合占住会话链，其余排队；在途表条目全部 pending。
      const total = MESSAGE_REPLY_LIMIT + 1;
      const flood: Array<Promise<unknown>> = [];
      for (let i = 0; i < total; i += 1) {
        flood.push(server.handler(incoming('test-user', `msg-flood-${i}`)));
      }
      // 最旧键（msg-flood-0）在灌满时最容易被错误驱逐：此刻重投它，必须等在途 Promise
      // 拿到同一句真回执——而不是读到底账 processing 行、被误报「上一进程挂了，请重发」。
      const duplicate = server.handler(incoming('test-user', 'msg-flood-0'));
      openGate!();

      const replies = await Promise.all([...flood, duplicate]);
      const firstReply = replies[0]!;
      expect(firstReply).toContain('回复：');
      // 末位 = msg-flood-0 的重投：必须与首条同句（在途回放），且不是「没办完/请重发」兜底。
      expect(replies[replies.length - 1]).toBe(firstReply);
      expect(replies[replies.length - 1]).not.toContain('没办完');
      expect(replies[replies.length - 1]).not.toContain('请重发');
    } finally {
      await server.close();
    }
  });
});
