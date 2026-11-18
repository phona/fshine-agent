/**
 * 会话持久化接线 · server 级确定性验证（假渠道事实 + 假执行面 + 假模型/假 executor；零网络）。
 *
 * 会话落盘归 Pi：装配层只解析 `(principal, session)` 的唯一会话位置并交给驱动
 * （`mainSession` = sessionDir / piSessionId / resumeSessionFile）。本文件验证 server 侧的
 * 装配事实（同 dbPath 重建 server = 进程重启；临时目录，无跨用例串扰）：
 *   ① 进程重启恢复：发消息→close→重建→再发，第二回合上下文含首回合历史（含 assistant 回复）；
 *   ② 任务恢复不重放：任务侧仍走既有 runner，重启后启动 pump **不重放**已完成任务（executor 不再被调）；
 *   ③ 结果找回：重启后经 Task Registry 取回首回合任务的真实结果（逐字 archiveReply 存档）；
 *   ④ 用户隔离：异 principal / 异 session 落到不同会话文件，重启后新回合上下文不含他人内容。
 *
 * ①④ 的主驱动用「Pi 会话替身」：只用 Pi 公开 `SessionManager` 落盘/读回（零模型、零网络），
 * 这样断言的是真实链路「装配位置 → Pi 会话文件 → 重启恢复」，而不是宿主搬运转录。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import type { MainSessionLocation } from '../../packages/agent/src/session-persistence';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import type { TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-b1-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true },
      'wecom:user-b': { enabled: true },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // server 恒 async（派发方式不是配置键）；后台并发 1 保留为确定性资源读数。
    runtime: { backgroundConcurrency: 1 },
  };
}

function incoming(userId: string, conversationId: string, messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
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

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
};

function messageText(message: DriverMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content[0] as { text?: unknown } | undefined;
    if (first !== undefined && typeof first.text === 'string') return first.text;
  }
  return '';
}

interface Plan {
  delegates?: readonly string[];
  reply?: string;
}

/** 记录每回合输入转录的假主驱动：按最后一条 user 文本查计划，可委派（task_run）、给回复。 */
function plannedDriver(plans: ReadonlyMap<string, Plan>, records: DriverMessage[][]): TurnDriver {
  return {
    async run(input) {
      records.push([...input.messages]);
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = plans.get(text);
      if (plan === undefined) throw new Error(`（测试）未配置计划的回合：${text}`);
      for (const request of plan.delegates ?? []) {
        await input.exec(input.tools[0]!.name, { task: request });
      }
      const reply = plan.reply ?? `（默认回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

/**
 * Pi 会话替身主驱动：只用 Pi 公开 `SessionManager` 落盘/读回（零模型）。
 *
 * 与真实 Pi 驱动同一分工：**历史归会话文件**（本回合只把「本轮输入」交给会话），
 * 转录经 `transcript()` 交回宿主（不额外传 message 数组）。
 */
function piBackedDriver(
  location: MainSessionLocation,
  replyFor: (text: string) => string,
  records: DriverMessage[][],
  seenLocations: MainSessionLocation[],
): TurnDriver {
  let manager: SessionManager | undefined;
  seenLocations.push(location);
  const session = (): SessionManager => {
    manager ??= location.resumeSessionFile === undefined
      ? SessionManager.create(path.resolve(__dirname), location.sessionDir, { id: location.piSessionId })
      : SessionManager.open(location.resumeSessionFile, location.sessionDir, path.resolve(__dirname));
    return manager;
  };
  const projection = (): readonly DriverMessage[] => session()
    .getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: 'message' }> => entry.type === 'message')
    .map((entry) => entry.message as unknown as DriverMessage);
  const append = (role: 'user' | 'assistant', content: string): void => {
    session().appendMessage({
      role, content, timestamp: Date.now(),
    } as unknown as Parameters<SessionManager['appendMessage']>[0]);
  };
  return {
    async run(input) {
      records.push([...input.messages]);
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      append('user', text);
      const reply = replyFor(text);
      append('assistant', reply);
      return { text: reply, messages: [...projection()] };
    },
    transcript: () => projection(),
  };
}

class CountingExecutor implements TaskExecutor {
  calls = 0;
  private readonly handlers: Array<() => Promise<TaskExecutionOutcome>>;
  constructor(handlers: ReadonlyArray<() => Promise<TaskExecutionOutcome>> = []) {
    this.handlers = [...handlers];
  }
  async execute(): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    const handler = this.handlers.shift();
    if (handler === undefined) throw new Error('（测试）不得再执行任务（重启后不重放）');
    return await handler();
  }
}

describe('B1 server 级：进程重启恢复与隔离（四类确定性验证）', () => {
  it('① 重启恢复：同 dbPath 重建 server，第二回合上下文含首回合历史（Pi 会话文件）', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const sessionStoreDir = path.join(dir, 'sessions');

    const rec1: DriverMessage[][] = [];
    const locations1: MainSessionLocation[] = [];
    const server1 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: (_env, mainSession) => {
        expect(mainSession, '真实（或替身）驱动必须拿到会话位置').toBeTruthy();
        return {
          mainDriver: piBackedDriver(mainSession!, () => '回复一', rec1, locations1),
          workerDriver: workerNeverCalled,
        };
      },
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: () => {},
    });
    try {
      expect(await server1.handler(incoming('user-a', 'conv-a', 'm-1', '第一回合'))).toBe('回复一');
      expect(locations1[0]!.resumeSessionFile, '首回合之前没有会话文件').toBeUndefined();
    } finally {
      await server1.close();
    }

    const rec2: DriverMessage[][] = [];
    const locations2: MainSessionLocation[] = [];
    const server2 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: (_env, mainSession) => ({
        mainDriver: piBackedDriver(mainSession!, () => '回复二', rec2, locations2),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: () => {},
    });
    try {
      expect(await server2.handler(incoming('user-a', 'conv-a', 'm-2', '第二回合'))).toBe('回复二');
      // 重启后同 (principal, session) 解析回同一份 Pi 会话文件（Pi 原生 resume）。
      expect(locations2[0]!.piSessionId).toBe(locations1[0]!.piSessionId);
      expect(locations2[0]!.sessionDir).toBe(locations1[0]!.sessionDir);
      expect(locations2[0]!.resumeSessionFile, '重启后必须解析到首回合落盘的文件').toBeTruthy();
      const seen = rec2[0]!.map(messageText);
      expect(seen).toContain('第一回合'); // 首回合用户消息
      expect(seen).toContain('回复一'); // 首回合 assistant 回复
      expect(seen).toContain('第二回合');
    } finally {
      await server2.close();
    }
  });

  it('②③ 任务恢复不重放 + 结果找回：重启后 executor 不再被调，结果经 Task Registry 取回', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const sessionStoreDir = path.join(dir, 'sessions');
    const scope = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

    const rec1: DriverMessage[][] = [];
    const executor1 = new CountingExecutor([async () => ({ kind: 'completed', resultText: 'W202611：documents 共 3 条。' })]);
    const server1 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: () => ({
        mainDriver: plannedDriver(new Map([['查 documents W202611', { delegates: ['查 documents W202611'], reply: '已受理，稍后通知你。' }]]), rec1),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor1,
      // 有推送面 = async（派发方式不是配置键）：静默端口只作能力声明，不发起真实投递。
      fileDelivery: { deliveryMode: 'silent', async sendToConversation() { throw new Error('（测试）silent 不投递'); } },
      logger: () => {},
    });
    let taskId: string;
    try {
      expect(await server1.handler(incoming('user-a', 'conv-a', 'm-1', '查 documents W202611'))).toBe('已受理，稍后通知你。');
      expect(executor1.calls).toBe(1);
      const ro1 = createSqliteTaskRegistry(dbPath, { readOnly: true });
      try {
        await vi.waitFor(() => {
          const tasks = ro1.list(scope);
          expect(tasks).toHaveLength(1);
          expect(tasks[0]!.status).toBe('completed');
        });
        taskId = ro1.list(scope)[0]!.taskId;
        expect(ro1.list(scope)[0]!.replyText).toBe('W202611：documents 共 3 条。');
      } finally {
        ro1.close();
      }
    } finally {
      await server1.close();
    }

    // 重启：新 executor 一旦被调即抛（= 重放检测）；启动 pump 不得重放已完成任务。
    const replayExecutor = new CountingExecutor();
    const rec2: DriverMessage[][] = [];
    const server2 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: () => ({
        mainDriver: plannedDriver(new Map([['状态如何', { reply: '一切正常。' }]]), rec2),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: replayExecutor,
      fileDelivery: { deliveryMode: 'silent', async sendToConversation() { throw new Error('（测试）silent 不投递'); } },
      logger: () => {},
    });
    const ro2 = createSqliteTaskRegistry(dbPath, { readOnly: true });
    try {
      // 重启后仍走普通渠道回合；pump 未重放任何任务（executor 一次都没被调）。
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replayExecutor.calls).toBe(0);
      expect(await server2.handler(incoming('user-a', 'conv-a', 'm-2', '状态如何'))).toBe('一切正常。');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replayExecutor.calls).toBe(0);
      // 结果找回：重启后经 Task Registry 取回首回合真实结果（逐字 archiveReply 存档）。
      const task = ro2.get(taskId, scope);
      expect(task.status).toBe('completed');
      expect(task.replyText).toBe('W202611：documents 共 3 条。');
    } finally {
      ro2.close();
      await server2.close();
    }
  });

  it('④ 用户隔离：异 principal / 异 session 重启后互不串读', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const sessionStoreDir = path.join(dir, 'sessions');

    const rec1: DriverMessage[][] = [];
    const locations1: MainSessionLocation[] = [];
    const server1 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: (_env, mainSession) => ({
        mainDriver: piBackedDriver(mainSession!, (text) => {
          if (text.includes('会话A内容')) return '记下A';
          if (text.includes('会话B内容')) return '记下B';
          return '记下C';
        }, rec1, locations1),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: () => {},
    });
    try {
      await server1.handler(incoming('user-a', 'conv-a', 'm-1', '会话A内容'));
      await server1.handler(incoming('user-a', 'conv-b', 'm-2', '会话B内容'));
      await server1.handler(incoming('user-b', 'conv-a', 'm-3', '另一用户内容'));
      // 三个会话各自的 (目录, Pi 会话 id) 必须互不相同（principal 子树物理隔离 +
      // 同 principal 下不同 session 的 id 不同）。
      const pairs = locations1.map((location) => `${location.sessionDir}\u0000${location.piSessionId}`);
      expect(new Set(pairs).size, '异 principal/异 session 必须落到不同会话位置').toBe(3);
    } finally {
      await server1.close();
    }

    // 重启后 (user-a, conv-a) 的新回合上下文：只含本会话历史，不含他人/他会话内容。
    const rec2: DriverMessage[][] = [];
    const locations2: MainSessionLocation[] = [];
    const server2 = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      sessionStoreDir,
      createDrivers: (_env, mainSession) => ({
        mainDriver: piBackedDriver(mainSession!, () => '好的', rec2, locations2),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: () => {},
    });
    try {
      expect(await server2.handler(incoming('user-a', 'conv-a', 'm-4', '后续'))).toBe('好的');
      expect(locations2[0]!.resumeSessionFile, '重启后必须解析到本会话既有文件').toBeTruthy();
      const seen = rec2[0]!.map(messageText);
      expect(seen).toContain('会话A内容');
      expect(seen).not.toContain('会话B内容'); // 异 session 不串读
      expect(seen).not.toContain('另一用户内容'); // 异 principal 不串读
    } finally {
      await server2.close();
    }
  });
});
