/**
 * 主动提醒生产接线（预期契约 2026-11-18；2026-11-19 唤醒切片改形、只留一档）：
 * 「比预计久了」提醒由 runner 判时机、出**事实**与**兜底句**；本套件验证 **server 把唤醒
 * 出口接对了**：
 *   · 1:1 会话：任务跑过阈值且无事件 → 恰好一条主动消息（唤醒模型说；本夹具的假 driver
 *     没有唤醒能力 = 「模型回合挂了」那一支，如实投兜底句）；
 *   · 群聊也发（owner 2026-11-19 #9：群 = 独立主体）——但事实/话术**不带业务名**（隐私
 *     口径归端口，宿主身份约定）；「已发」照样落库；
 *   · 提醒端口：未接唤醒出口 = 如实返回 false（不冒充已送达）；接上 = 1:1 原样透传
 *     事实/兜底句（runner 拼），群主体由端口重建去名文本。
 *
 * 假件：假 driver（只交办、无 wake）、挂起的假 executor（任务保持 running）、假渠道投递面。
 * 零网络。「唤醒说话」正支（模型真说了一句）由 server-state-wake.test.ts 覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { taskLivenessOf } from '../../packages/agent/src/task-registry';
import { taskStatusOf } from '../../packages/agent/testing/task-fact-view';
import { LONG_RUNNING_NOTICE_FALLBACK_TEXT, longRunningNoticeFactText, type TaskExecutionInput, type TaskExecutionOutcome, type TaskExecutor } from '../../packages/agent/src/task-runner';
import { createLongRunningNoticePort, createServer, isGroupPrincipal, type FileDeliveryPort } from './server';

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
      return { kind: 'ended', report: '（测试）完成' };
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
      return { kind: 'ended', report: '（测试）导出完成' };
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
  it('① 1:1 会话：任务超阈值无事件 → 恰一条主动提醒（假 driver 无唤醒能力 = 模型挂了 → 兜底句，带可做的动作）', async () => {
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
      // 本夹具的假 driver 没有唤醒能力 → 走「模型回合挂掉」降级：如实投兜底句（不说进度、不诱导重试）。
      expect(delivery.texts[0]!.text).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
      expect(delivery.texts[0]!.text).toContain('停下来');
      expect(delivery.texts[0]!.text).toContain('继续等');
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

  it('② 群聊也发（owner 2026-11-19 #9 迁移）：群任务照常提醒，路由回到群会话、话术不带业务名', async () => {
    // 旧口径「群聊一律不发」按 owner 指令迁移：群 = 独立主体，群里的任务就是这个群的事。
    // 隐私口径保留在话术层：群主体的提醒不带业务名（中性主语）；1:1 照常带（见端口单测）。
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
      await waitFor(() => expect(delivery.texts).toHaveLength(1), 3_000);
      expect(delivery.texts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'group-1' });
      // 话术不带业务名（事实里已去掉名字；假 driver 无唤醒 → 投的兜底句本身也不含名字）。
      expect(delivery.texts[0]!.text).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
      expect(delivery.texts[0]!.text).not.toContain('跑一个很久的活');
      expect(delivery.texts[0]!.text).not.toContain('你交代的那件事');
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.close();
    }
  });

  it('②b 重启后判据（#10）：底账有 running 任务、进程内没有任何 inbound → 提醒照常发出', async () => {
    // 判据只看底账任务事实：进程刚起（没有 inbound 登记、没有进程内会话集合），
    // 长活的久无动静提醒也必须发得出去（旧实现用 inbound 登记的进程内集合 → 这里必然零投递）。
    const delivery = new RecordingDelivery();
    const dbPath = path.join(tempDir(), 'state.db');
    const seeded = createSqliteTaskRegistry(dbPath);
    try {
      // 受理为 queued（无 running_since）后写一条「已跑一阵」的租约：armLease 首次把 running_since
      // 落成 updatedAt（旧时刻）+ 租约不过期 → running 且已跑超过阈值（不会被回收成 died）。
      seeded.begin({ taskId: 'task_restart_notice', principalId: 'wecom:user-a', sessionId: 'wecom:conv-a', request: '重启前交办的长活', queued: true });
      seeded.store.armLease('task_restart_notice', {
        owner: 'previous-process',
        leaseUntil: new Date(Date.now() + 600_000).toISOString(),
        updatedAt: new Date(Date.now() - 600_000).toISOString(),
      });
    } finally {
      seeded.close();
    }
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig(),
      dbPath,
      createDrivers: () => ({ mainDriver: delegatingMain(), workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      fileDelivery: delivery,
      logger: () => {},
    });
    try {
      // 一条 inbound 都没发过（进程内集合为空）。
      await waitFor(() => expect(delivery.texts).toHaveLength(1), 3_000);
      expect(delivery.texts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      expect(delivery.texts[0]!.text).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
    } finally {
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
      // S1 事实模型：底账没有 status——长任务受理后租约已清；accepted 执行行 + 无汇报 = 仍在办。
      expect(taskStatusOf(running)).toBe('running');
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
  it('未接唤醒出口：如实返回 false（不冒充已送达、不静默猜）', async () => {
    const port = createLongRunningNoticePort({});
    await expect(port.sendNotice({
      taskId: 't',
      principalId: 'wecom:user-a',
      sessionId: 'wecom:conv-a',
      stage: 'overdue',
      factText: '占位（未接出口用不到）',
      fallbackText: '占位（未接出口用不到）',
      minutes: 11,
    })).resolves.toBe(false);
  });

  it('1:1 主体：事实带业务名（用户要知道是哪件事），兜底句 = 既有那句', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = createLongRunningNoticePort({
      wakeStateChange: async (notice) => {
        seen.push({ ...notice });
        return true;
      },
    });
    await expect(port.sendNotice({
      taskId: 't',
      principalId: 'wecom:user-a',
      sessionId: 'wecom:conv-a',
      stage: 'overdue',
      name: '查上季度报销',
      minutes: 11,
      // runner 交来的事实/兜底原文（1:1 端口原样转发；群主体才由端口重建去名文本）。
      factText: longRunningNoticeFactText({ name: '查上季度报销', minutes: 11 }),
      fallbackText: LONG_RUNNING_NOTICE_FALLBACK_TEXT,
    })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskId: 't',
      principalId: 'wecom:user-a',
      sessionId: 'wecom:conv-a',
      name: '查上季度报销',
      minutes: 11,
      fallbackText: LONG_RUNNING_NOTICE_FALLBACK_TEXT,
    });
    expect(String(seen[0]!['factText'])).toContain('「查上季度报销」');
    expect(String(seen[0]!['factText'])).toContain('11 分钟');
  });

  it('群主体：照样发，但事实**不带业务名**（隐私口径）；兜底句不变', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = createLongRunningNoticePort({
      wakeStateChange: async (notice) => {
        seen.push({ ...notice });
        return true;
      },
    });
    await expect(port.sendNotice({
      taskId: 't',
      principalId: 'wecom:group:group-w',
      sessionId: 'wecom:group-w',
      stage: 'overdue',
      name: '张三的工资明细导出',
      minutes: 11,
      // runner 交来的事实原文**带业务名**；群主体的去名重建是端口（宿主）的隐私口径。
      factText: longRunningNoticeFactText({ name: '张三的工资明细导出', minutes: 11 }),
      fallbackText: LONG_RUNNING_NOTICE_FALLBACK_TEXT,
    })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('name');
    const fact = String(seen[0]!['factText']);
    expect(fact).toContain('[久无动静]');
    expect(fact).not.toContain('张三');
    expect(fact).not.toContain('工资');
    expect(fact).toContain('11 分钟');
    expect(seen[0]!['fallbackText']).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
  });

  it('群主体识别是机械的（`<渠道>:group:<会话id>`）；1:1 / 三段以下的 id 一律当 1:1', () => {
    expect(isGroupPrincipal('wecom:group:group-w')).toBe(true);
    expect(isGroupPrincipal('wecom:user-a')).toBe(false);
    // 用户 id 恰好叫 group 也不能误判成群（段数不足）。
    expect(isGroupPrincipal('wecom:group')).toBe(false);
    expect(isGroupPrincipal('wecom:group:group-w:extra')).toBe(true);
  });

  it('唤醒出口交不出话（返回 false）如实向上返回（不冒充已送达）', async () => {
    const refusing = createLongRunningNoticePort({ wakeStateChange: async () => false });
    await expect(refusing.sendNotice({
      taskId: 't',
      principalId: 'wecom:user-a',
      sessionId: 'wecom:conv-a',
      stage: 'overdue',
      factText: '占位（出口拒答用不到）',
      fallbackText: '占位（出口拒答用不到）',
      minutes: 11,
    })).resolves.toBe(false);
  });
});
