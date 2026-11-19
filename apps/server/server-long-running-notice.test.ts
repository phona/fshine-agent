/**
 * 主动提醒生产接线（预期契约 2026-11-18）：10 分钟「比预计久了」/30 分钟「卡住了」两档文案
 * 由 runner 生成；本套件只验证 **server 把投递端口接对了**：
 *   · 1:1 会话：任务跑过阈值且无事件 → 恰好一条主动消息（走既有 sendText 主动投递面）；
 *   · 群聊：一条都不发（跨 principal 泄漏面），且不落「已发」；
 *   · 非 live 部署：sendText 不被调用（不冒充 sent）；
 *   · 未知会话（无 inbound 事实的路由）：不发（fail-quiet，不猜路由）。
 *
 * 假件：假 driver（只交办）、挂起的假 executor（任务保持 running）、假渠道投递面。零网络。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { LONG_RUNNING_NOTICE_TEXT, type TaskExecutionInput, type TaskExecutionOutcome, type TaskExecutor } from '../../packages/agent/src/task-runner';
import { createLongRunningNoticePort, createServer, type FileDeliveryPort } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-notice-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(allowWriteOperations = false): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, role: 'operator' },
      'wecom:group:group-1': { enabled: true, role: 'viewer' },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 提醒阈值钉到 1ms（本套件测接线；两档语义由 packages/agent/long-running-notice.test.ts 覆盖）。
    runtime: {
      backgroundConcurrency: 1,
      taskRunWaitMs: 0,
      longRunningNoticeMs: 1,
      longRunningStuckNoticeMs: 0,
      ...(allowWriteOperations ? { allowWriteOperations: true } : {}),
    },
  };
}

function incoming(
  userId: string,
  conversationId: string,
  text: string,
  chatType: 'single' | 'group' = 'single',
): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    chatType,
    text,
    receivedAt: new Date().toISOString(),
  };
}

/** 假渠道投递面：记录 sendText（主动文字投递）。 */
class RecordingDelivery implements FileDeliveryPort {
  readonly texts: Array<{ route: ChannelRoute; text: string }> = [];
  constructor(readonly deliveryMode: 'live' | 'silent' = 'live') {}
  async sendToConversation(route: ChannelRoute): Promise<DeliveryReceipt> {
    return { route, parts: [] };
  }
  async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
    this.texts.push({ route, text });
    return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
  }
}

/** 假执行面（零平台）：只读查询即可（本套件不真的执行 operation）。 */
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

/** 只交办、不干活的 Main（零模型）。 */
function delegatingMain(): TurnDriver {
  return {
    async run(input) {
      await input.exec('task_run', { task: '跑一个很久的活' });
      const reply = '已受理，办完发你。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

/** 挂起的执行器：任务保持 running，直到测试收尾（触发「长时间无动静」扫描）。 */
function hangingExecutor(): { executor: TaskExecutor; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: TaskExecutor = {
    async execute(): Promise<TaskExecutionOutcome> {
      await gate;
      return { kind: 'completed', resultText: '（测试）完成' };
    },
  };
  return { executor, release };
}

/** 长任务执行器：首回合返回 accepted（释放租约与槽位），wait 完成后第二回合收尾。 */
function longTaskExecutor(): { executor: TaskExecutor; rounds: () => number } {
  let calls = 0;
  const executor: TaskExecutor = {
    async execute(): Promise<TaskExecutionOutcome> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: 'accepted',
          operationId: 'op-1',
          operation: 'dummy.longtask',
          dispatchKey: 'dk-long-1',
          pollAfterMs: 5,
        };
      }
      return { kind: 'completed', resultText: '（测试）导出完成' };
    },
  };
  return { executor, rounds: () => calls };
}

/** 长任务执行面：capabilities 声明 long_running + wait 端口（挂起到测试推进）。 */
class LongTaskFace implements ExecutionClient {
  readonly waits: string[] = [];
  private pending: ((outcome: ExecutionOutcome) => void) | undefined;
  async capabilities(): Promise<CapabilityManifest> {
    return {
      contractVersion: 4,
      operations: [{ name: 'dummy.longtask', label: 'long', args: [], long_running: true }],
    };
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'accepted', operationId: 'op-1', pollAfterMs: 5 };
  }
  wait(operationId: string): Promise<ExecutionOutcome> {
    this.waits.push(operationId);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
  finish(): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({ status: 'completed', data: { summary: '导出完成' } });
  }
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('预期契约·主动提醒的生产接线', () => {
  it('① 1:1 会话：任务超阈值无事件 → 恰一条主动提醒（走 sendText、带可做的动作）', async () => {
    const delivery = new RecordingDelivery();
    const { executor, release } = hangingExecutor();
    const dbPath = path.join(tempDir(), 'state.db');
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      createDrivers: () => ({ mainDriver: delegatingMain(), workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      fileDelivery: delivery,
      logger: () => {},
    });
    try {
      await server.handler(incoming('user-a', 'conv-a', '跑一个很久的活'));
      await waitFor(() => expect(delivery.texts).toHaveLength(1), 3_000);
      expect(delivery.texts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(delivery.texts[0]!.text).toBe(LONG_RUNNING_NOTICE_TEXT);
      // 只发一条（幂等：已发落库，不刷屏）。
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(delivery.texts).toHaveLength(1);
    } finally {
      release();
      // 让挂起回合收尾后再关库（否则定时器在已关闭的底账上跑，产生收尾噪声）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.close();
    }
  });

  it('② 群聊：同条件一条都不发（跨 principal 泄漏面）', async () => {
    const delivery = new RecordingDelivery();
    const { executor, release } = hangingExecutor();
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath: path.join(tempDir(), 'state.db'),
      createDrivers: () => ({ mainDriver: delegatingMain(), workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      fileDelivery: delivery,
      logger: () => {},
    });
    try {
      await server.handler(incoming('user-a', 'group-1', '跑一个很久的活', 'group'));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(delivery.texts).toHaveLength(0);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.close();
    }
  });
  it('③ 长任务（accepted 后租约被清）也要提醒：按 running_since 算，之后照常被 wait 唤醒收尾', async () => {
    // 2026-11-19 缺陷：长任务受理会清租约，而「跑了多久」原先只从租约反推 →
    // 最该主动汇报的长任务反而不在提醒扫描里。改用底账 running_since（单调写一次）。
    const delivery = new RecordingDelivery();
    const face = new LongTaskFace();
    let workerRounds = 0;
    const worker: TurnDriver = {
      async run(input) {
        workerRounds += 1;
        if (workerRounds === 1) {
          await input.exec('execute_operation', { operation: 'dummy.longtask', args: {} });
          const text = '已受理长任务，等结果。';
          return { text, messages: [{ role: 'assistant', content: text } as never] };
        }
        const text = '导出完成。';
        return { text, messages: [{ role: 'assistant', content: text } as never] };
      },
    };
    const dbPath = path.join(tempDir(), 'state.db');
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(true),
      dbPath,
      createDrivers: () => ({ mainDriver: delegatingMain(), workerDriver: worker }),
      createExecutionFace: async () => ({
        client: face,
        allowedOperations: ['dummy.longtask'],
        readOnlyOperations: [],
      }),
      fileDelivery: delivery,
      logger: () => {},
    });
    try {
      await server.handler(incoming('user-a', 'conv-long', '跑一个很久的导出'));
      // 受理：任务保持 running，但租约已释放（不该被 expireLeases 判 result_unknown）。
      await waitFor(() => expect(face.waits.length).toBe(1), 3_000);
      const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
      const taskId = registry.list({ principalId: 'wecom:user-a', sessionId: 'wecom:conv-long' })[0]!.taskId;
      const running = registry.get(taskId, { principalId: 'wecom:user-a', sessionId: 'wecom:conv-long' });
      registry.close();
      expect(running.status).toBe('running');
      expect(running.leaseUntil).toBeUndefined();
      expect(running.runningSince).toBeDefined();

      // 超过阈值仍然提醒（这就是本次修的那条）。
      await waitFor(() => expect(delivery.texts.some((entry) => entry.text.includes('比预计久了'))).toBe(true), 2_000);

      // 长任务自己照常被唤醒收尾。
      face.finish();
      await waitFor(() => expect(workerRounds).toBe(2), 3_000);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.close();
    }
  });
});

describe('主动提醒端口（纯函数）', () => {
  const route: ChannelRoute = { channel: 'wecom', conversationId: 'conv-a' };

  it('非 live 部署 / 无 sendText / 未知路由 / 投递抛错：一律不宣称送达', async () => {
    const silence = new RecordingDelivery('silent');
    const port = createLongRunningNoticePort({
      isDirectSession: () => true,
      routeOf: () => route,
      delivery: silence,
    });
    await expect(port.sendNotice({ taskId: 't', principalId: 'p', sessionId: 's', stage: 'overdue', minutes: 11, text: 'x' }))
      .resolves.toBe(false);
    expect(silence.texts).toHaveLength(0);

    const unknownRoute = createLongRunningNoticePort({
      isDirectSession: () => true,
      routeOf: () => undefined,
      delivery: new RecordingDelivery(),
    });
    await expect(unknownRoute.sendNotice({ taskId: 't', principalId: 'p', sessionId: 's', stage: 'stuck', minutes: 31, text: 'x' }))
      .resolves.toBe(false);

    const throwing = createLongRunningNoticePort({
      isDirectSession: () => true,
      routeOf: () => route,
      delivery: {
        deliveryMode: 'live',
        sendToConversation: async () => ({ route, parts: [] }),
        sendText: async () => {
          throw new Error('channel down');
        },
      },
    });
    await expect(throwing.sendNotice({ taskId: 't', principalId: 'p', sessionId: 's', stage: 'overdue', minutes: 11, text: 'x' }))
      .resolves.toBe(false);
    await expect(createLongRunningNoticePort({
      isDirectSession: () => true,
      routeOf: () => route,
      delivery: undefined,
    }).sendNotice({ taskId: 't', principalId: 'p', sessionId: 's', stage: 'overdue', minutes: 11, text: 'x' })).resolves.toBe(false);
  });

  it('live + 已知路由：真投递才返回 true', async () => {
    const delivery = new RecordingDelivery();
    const port = createLongRunningNoticePort({ isDirectSession: () => true, routeOf: () => route, delivery });
    await expect(port.sendNotice({ taskId: 't', principalId: 'p', sessionId: 's', stage: 'overdue', minutes: 11, text: '提醒' }))
      .resolves.toBe(true);
    expect(delivery.texts).toEqual([{ route, text: '提醒' }]);
  });
});
