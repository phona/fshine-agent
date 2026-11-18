/**
 * B 切片（工单回执收敛）· server 装配级（假执行器 + 假投递面 + 小窗口真实轮询）：
 *   a. 快活（窗口内完成）→ 同回合回复带结果（模型转述），零受理回执、零主动投递
 *      （sendText 零调用、零 sent 事件）；message_done 带 operations 计数；
 *   b. 慢活（超窗口）→ 受理话术不含 # 与编号数字；任务继续在后台并最终完成；
 *   c. 慢活完成 → 主动投递恰好一次（内容来自任务结果；live 记 sent）；silent 模式
 *      零投递、记 suppressed、不记 sent；
 *   e. 无渠道推送面 = 同步装配：message_done 的 operations 计数与实际执行次数一致。
 *
 * 零网络、零真实模型、零真实平台：假渠道事实直调 handler，假 driver / 假 executor / 假投递面。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, RuntimeConfig } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { EXECUTE_OPERATION_TOOL } from '../../packages/agent/src/execution-runtime';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-wait-window-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(runtime: RuntimeConfig): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface ServerDriverRecord {
  execResults: unknown[];
}

interface ServerPlan {
  delegates?: readonly string[];
  reply?: string;
}

/** 假 Main：按计划交办（task_run）并收下工具结果；零模型。 */
function plannedMain(plans: ReadonlyMap<string, ServerPlan>, records: ServerDriverRecord[]): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = plans.get(text);
      if (plan === undefined) throw new Error(`（测试）未配置计划的回合：${text}`);
      const execResults: unknown[] = [];
      for (const request of plan.delegates ?? []) {
        const tool = input.tools.find((candidate) => candidate.name === 'task_run');
        if (tool === undefined) throw new Error('（测试）Main 无 task_run 工具面');
        execResults.push(await input.exec(tool.name, { task: request }));
      }
      records.push({ execResults });
      const reply = plan.reply ?? `（测试回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

/** 假 inline Worker：每次回合发起 N 次执行层调用（计数测试用）。 */
function executingWorker(calls: number): TurnDriver {
  return {
    async run(input) {
      // 每次用不同窗口：同参数重复会被 A2b 守卫拒（资源边界），计数用例要的是真实 N 次执行。
      for (let index = 0; index < calls; index += 1) {
        await input.exec(EXECUTE_OPERATION_TOOL, {
          operation: 'dummy.query',
          args: { '--collection': 'documents', '--window': `W${index + 1}` },
        });
      }
      return { text: `查询完成（${calls} 次执行）`, messages: [...input.messages] };
    },
  };
}

class ImmediateExecutor implements TaskExecutor {
  constructor(private readonly resultText: string) {}
  readonly calls: Array<{ taskId: string }> = [];
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls.push({ taskId: input.taskId });
    return { kind: 'completed', resultText: this.resultText };
  }
}

class GatedExecutor implements TaskExecutor {
  readonly calls: Array<{ taskId: string }> = [];
  private gate?: { promise: Promise<TaskExecutionOutcome>; resolve: (value: TaskExecutionOutcome) => void };
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls.push({ taskId: input.taskId });
    if (this.gate === undefined) {
      this.gate = deferred<TaskExecutionOutcome>();
    }
    return await this.gate.promise;
  }
  settle(outcome?: TaskExecutionOutcome): void {
    if (this.gate === undefined || outcome === undefined) return;
    this.gate.resolve(outcome);
    this.gate = undefined;
  }
}

/** 假主动投递面：记录 sendText 调用（deliveryMode 决定抑制语义由 server 侧执行）。 */
class FakeTextDelivery {
  readonly sentTexts: Array<{ route: ChannelRoute; text: string }> = [];
  constructor(readonly deliveryMode: 'live' | 'silent') {}
  async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
    this.sentTexts.push({ route, text });
    return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
  }
  async sendToConversation(route: ChannelRoute): Promise<DeliveryReceipt> {
    return { route, parts: [] };
  }
}

describe('B 切片：task_run 短等待窗口（server 装配级）', () => {
  it('a. 快活：同回合回复带结果、零受理回执、零主动投递', async () => {
    const dir = tempDir();
    const delivery = new FakeTextDelivery('live');
    const logs: Array<Record<string, unknown>> = [];
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['办一件快事', { delegates: ['办一件快事'], reply: '办完了：汇总表已生成，共 12 单。' }],
    ]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig({ backgroundConcurrency: 1 }),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: plannedMain(plans, records), workerDriver: { async run() { throw new Error('（测试）不该调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: new ImmediateExecutor('汇总表结果：共 12 单，合计 3456 元。'),
      fileDelivery: delivery,
      logger: (line) => logs.push(line),
    });
    try {
      const reply = await server.handler(incoming('user-a', 'conv-a', 'msg-1', '办一件快事'));
      // 同回合拿到结果（模型转述）
      expect(reply).toBe('办完了：汇总表已生成，共 12 单。');
      // 零受理回执：task_run 结果是 summary，不是受理话术
      const answer = records[0]!.execResults[0] as Record<string, unknown>;
      expect(answer).toMatchObject({ summary: '汇总表结果：共 12 单，合计 3456 元。' });
      expect(answer).not.toHaveProperty('notice');
      expect(answer).not.toHaveProperty('accepted');
      // 零主动投递：sendText 零调用、零 sent 事件（结果已在同回合交给用户）
      expect(delivery.sentTexts).toHaveLength(0);
      expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      // message_done 带 operations 计数（快活：后台回合的执行不计入本回合 → 0）
      const done = logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
      expect(done).toBeDefined();
      expect(done!['operations']).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('b. 慢活：受理话术不含 # 与编号数字；任务继续在后台并最终完成', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['交办一件要跑一阵的事', { delegates: ['交办一件要跑一阵的事'], reply: '已交办，正在后台办，完成后发你。' }],
    ]);
    const executor = new GatedExecutor();
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig({ backgroundConcurrency: 1, taskRunWaitMs: 60 }),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: plannedMain(plans, records), workerDriver: { async run() { throw new Error('（测试）不该调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      fileDelivery: new FakeTextDelivery('live'),
      logger: (line) => logs.push(line),
    });
    const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'), { readOnly: true });
    try {
      const reply = await server.handler(incoming('user-a', 'conv-a', 'msg-1', '交办一件要跑一阵的事'));
      expect(reply).toBe('已交办，正在后台办，完成后发你。');
      // 受理回执：谁办 + 办完发你，话术去编号
      const receipt = records[0]!.execResults[0] as Record<string, unknown>;
      expect(receipt['accepted']).toBe(true);
      expect(receipt['status']).toBe('running');
      const notice = String(receipt['notice']);
      expect(notice).toContain('这个我来办');
      expect(notice).toContain('办完发你');
      expect(notice).not.toContain('#');
      expect(notice).not.toContain('1');
      expect(receipt).not.toHaveProperty('taskNo');
      // 任务继续在后台并最终完成
      executor.settle({ kind: 'completed', resultText: '长任务结果：核对完成，共 3 条。' });
      const taskId = String(receipt['taskId']);
      await vi.waitFor(() => {
        expect(registry.get(taskId, { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' }).status).toBe('completed');
      }, { timeout: 5000 });
    } finally {
      executor.settle({ kind: 'failed', reason: '（测试清理）' });
      registry.close();
      await server.close();
    }
  });

  it('c. 慢活完成（live）：主动投递恰好一次，内容来自任务结果', async () => {
    const dir = tempDir();
    const delivery = new FakeTextDelivery('live');
    const logs: Array<Record<string, unknown>> = [];
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['交办一件要跑一阵的事', { delegates: ['交办一件要跑一阵的事'], reply: '已交办，正在后台办，完成后发你。' }],
    ]);
    const executor = new GatedExecutor();
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig({ backgroundConcurrency: 1, taskRunWaitMs: 60 }),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: plannedMain(plans, records), workerDriver: { async run() { throw new Error('（测试）不该调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      fileDelivery: delivery,
      logger: (line) => logs.push(line),
    });
    try {
      await server.handler(incoming('user-a', 'conv-a', 'msg-1', '交办一件要跑一阵的事'));
      executor.settle({ kind: 'completed', resultText: '长任务结果：核对完成，共 3 条。' });
      await vi.waitFor(() => expect(delivery.sentTexts).toHaveLength(1), { timeout: 5000 });
      // 恰好一次（多等一拍仍是一次）
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivery.sentTexts).toHaveLength(1);
      // 内容来自任务结果；路由 = 原会话
      expect(delivery.sentTexts[0]!.text).toContain('长任务结果：核对完成，共 3 条。');
      expect(delivery.sentTexts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      // live 送达才记 sent
      const sent = logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
    } finally {
      executor.settle({ kind: 'failed', reason: '（测试清理）' });
      await server.close();
    }
  });

  it('c. 慢活完成（silent）：零投递、记 suppressed、不记 sent', async () => {
    const dir = tempDir();
    const delivery = new FakeTextDelivery('silent');
    const logs: Array<Record<string, unknown>> = [];
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['交办一件要跑一阵的事', { delegates: ['交办一件要跑一阵的事'], reply: '已交办，正在后台办，完成后发你。' }],
    ]);
    const executor = new GatedExecutor();
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig({ backgroundConcurrency: 1, taskRunWaitMs: 60 }),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: plannedMain(plans, records), workerDriver: { async run() { throw new Error('（测试）不该调用'); } } }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      taskExecutor: executor,
      fileDelivery: delivery,
      logger: (line) => logs.push(line),
    });
    try {
      await server.handler(incoming('user-a', 'conv-a', 'msg-1', '交办一件要跑一阵的事'));
      executor.settle({ kind: 'completed', resultText: '长任务结果：核对完成，共 3 条。' });
      // 零投递：silent 部署不发起真实投递，只记 suppressed（不记 sent）
      await vi.waitFor(() => {
        const suppressed = logs.filter((line) => line['event'] === 'task_result_delivery_suppressed');
        expect(suppressed.length).toBeGreaterThanOrEqual(1);
        expect(suppressed.some((line) => line['deliveryMode'] === 'silent')).toBe(true);
      }, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(delivery.sentTexts).toHaveLength(0);
      expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
    } finally {
      executor.settle({ kind: 'failed', reason: '（测试清理）' });
      await server.close();
    }
  });

  it('e. message_done 带 operations 计数且与实际执行次数一致（无推送面 = 同步装配，N 次 execute_operation）', async () => {
    const dir = tempDir();
    const logs: Array<Record<string, unknown>> = [];
    const records: ServerDriverRecord[] = [];
    const plans = new Map<string, ServerPlan>([
      ['查两笔数据', { delegates: ['查 documents'], reply: '两笔都查完了。' }],
    ]);
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: testConfig({}),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: plannedMain(plans, records), workerDriver: executingWorker(2) }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      logger: (line) => logs.push(line),
    });
    try {
      const reply = await server.handler(incoming('user-a', 'conv-a', 'msg-1', '查两笔数据'));
      expect(reply).toBe('两笔都查完了。');
      const done = logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
      expect(done).toBeDefined();
      // 无渠道推送面 → 同步等结果：2 次 execute_operation 都在本回合发生 → operations=2，executions 2 行
      expect(done!['operations']).toBe(2);
      expect(Array.isArray(done!['executions']) && (done!['executions'] as unknown[]).length === 2).toBe(true);
    } finally {
      await server.close();
    }
  });
});
