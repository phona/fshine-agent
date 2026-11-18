/**
 * 后台受理上界（复用 `runtime.queueCapacity`，不新增旋钮）。
 *
 * 缺口登记（原 decision-log P0-C；索引 docs/decisions/index.md）：前台等待队列有 `queueCapacity` 上界，后台
 * `task_run` 受理侧只按 policy 并发位探测——并发满时探测返回「排队许可」后立即释放，
 * 底账 queued 行因此没有上界，可持续堆积。本文件钉住与前台一致的行为：
 *   · 底账 queued 行数 < queueCapacity 才受理（队列唯事实源仍是底账 queued 行）；
 *   · 满即确定性拒绝：accepted:false + reason=resource_limited + 用户可见话术，
 *     并发出 failed/resource_limited 结构化事实；不改成阻塞排队；
 *   · 拒绝不留半截任务行（终态 failed 的拒绝记录，不是 queued 幽灵行）；
 *   · 并发提交（跨会话共享同一 runner/policy）不会越过上界。
 *
 * TDD：旧行为下第 capacity+1 个排队提交仍 accepted:true（底账 queued 行 > 容量）→ 先红；
 * 受理侧按「底账 queued 行 < queueCapacity」判定后转绿。
 */
import { describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createSession, type Session } from './src/execution-runtime';
import { createResourcePolicy, type ResourcePolicy } from './src/resource-policy';
import { createTaskRegistry, type TaskFact, type TaskRegistry } from './src/task-registry';
import {
  createTaskRunner,
  type TaskExecutionInput,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRunner,
} from './src/task-runner';

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FakeClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

/** 永不落定的后台执行回合：第一件任务占住唯一后台并发位，其余只能排队。 */
class HangingExecutor implements TaskExecutor {
  readonly started: string[] = [];
  execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.started.push(input.taskId);
    return new Promise<TaskExecutionOutcome>(() => {
      // 永不落定：后台保持满载，受理侧的上界判定是唯一出口。
    });
  }
}

const unreachableWorker: TurnDriver = {
  async run() {
    throw new Error('（测试）后台派发不应调用 workerDriver');
  },
};

interface Receipt {
  taskId: string;
  taskNo?: number;
  name?: string;
  status: string;
  accepted?: boolean;
  reason?: string;
  notice?: string;
}

function receiptOf(value: unknown): Receipt {
  return value as Receipt;
}

interface Stack {
  registry: TaskRegistry;
  policy: ResourcePolicy;
  executor: HangingExecutor;
  runner: TaskRunner;
  /** 每次底账 begin 之后观测到的 queued 行数（并发测试的峰值证据）。 */
  depths: number[];
}

/** 进程级装配：registry/policy/runner 跨会话共享（与 server 生产装配同构）。 */
function makeStack(options: { queueCapacity?: number; backgroundConcurrency?: number } = {}): Stack {
  const inner = createTaskRegistry();
  const depths: number[] = [];
  const registry: TaskRegistry = {
    ...inner,
    begin(input) {
      const row = inner.begin(input);
      depths.push(inner.list().filter((task) => task.status === 'queued').length);
      return row;
    },
  };
  const policy = createResourcePolicy({
    backgroundConcurrency: options.backgroundConcurrency ?? 1,
    ...(options.queueCapacity === undefined ? {} : { queueCapacity: options.queueCapacity }),
  });
  const executor = new HangingExecutor();
  const runner = createTaskRunner({ registry, policy, executor });
  return { registry, policy, executor, runner, depths };
}

/** 假 Main：按顺序（或并发）发起 task_run 委派，收下回执。 */
function delegatingDriver(requests: readonly string[], receipts: unknown[], concurrent: boolean): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools.find((candidate) => candidate.name === 'task_run');
      if (tool === undefined) throw new Error('（测试）Main 工具面缺少 task_run');
      const delegate = async (request: string): Promise<void> => {
        receipts.push(await input.exec(tool.name, { task: request }));
      };
      if (concurrent) {
        await Promise.all(requests.map((request) => delegate(request)));
      } else {
        for (const request of requests) await delegate(request);
      }
      return {
        text: '（测试）已处理',
        messages: [...input.messages, { role: 'assistant', content: '（测试）已处理' } as never],
      };
    },
  };
}

async function sessionFor(
  stack: Stack,
  requests: readonly string[],
  receipts: unknown[],
  options: { concurrent?: boolean; sessionId?: string } = {},
): Promise<Session> {
  return await createSession({
    principalId: 'wecom:test-user',
    sessionId: options.sessionId ?? 'sess_queue_bound',
    client: new FakeClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: delegatingDriver(requests, receipts, options.concurrent === true),
    workerDriver: unreachableWorker,
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: stack.registry,
    policy: stack.policy,
    dispatchMode: 'background',
    taskRunner: stack.runner,
    // B 切片：钉 0 窗口（本套件测受理上界/背压的机械读数；窗口行为由专测覆盖）。
    taskRunWaitMs: 0,
  });
}

function queuedRows(stack: Stack): number {
  return stack.registry.list().filter((task) => task.status === 'queued').length;
}

describe('后台受理上界（复用 queueCapacity；满即拒绝，不阻塞排队）', () => {
  it('① 上界内接受：1 个活跃 + queueCapacity 个排队全部受理，回执仍是异步 queued 语义', async () => {
    const stack = makeStack({ queueCapacity: 2 });
    const receipts: unknown[] = [];
    const session = await sessionFor(stack, ['一', '二', '三'], receipts);
    await session.send('交办三件');

    expect(receipts).toHaveLength(3);
    const rows = receipts.map(receiptOf);
    expect(rows.every((receipt) => receipt.accepted === true)).toBe(true);
    // B 切片：status = 受理后实时机械事实（首个已被认领 running，其余 2 个 queued 排队）；
    // 受理仍是异步语义（任务留后台），话术去编号（不含 #）。
    expect(rows.map((receipt) => receipt.status)).toEqual(['running', 'queued', 'queued']);
    expect(rows.every((receipt) => receipt.notice?.includes('已受理'))).toBe(true);
    expect(rows.every((receipt) => !(receipt.notice ?? '').includes('#'))).toBe(true);
    // 1 个进入执行（唯一并发位），其余 2 个 = queueCapacity 个排队位。
    expect(stack.executor.started).toHaveLength(1);
    expect(queuedRows(stack)).toBe(2);
    // 队列仍以底账 queued 行为唯一事实源（policy 等待位不充当第二套队列）。
    expect(stack.policy.snapshot().background.queued).toBe(0);
  });

  it('② 超界拒绝：accepted:false + resource_limited + 明确话术；拒绝不留半截任务行', async () => {
    const stack = makeStack({ queueCapacity: 2 });
    const facts: TaskFact[] = [];
    stack.registry.onTaskFact((fact) => facts.push(fact));
    const receipts: unknown[] = [];
    const session = await sessionFor(stack, ['一', '二', '三', '四', '五'], receipts);
    await session.send('交办五件');

    expect(receipts).toHaveLength(5);
    const rows = receipts.map(receiptOf);
    const accepted = rows.filter((receipt) => receipt.accepted === true);
    const rejected = rows.filter((receipt) => receipt.accepted === false);
    expect(accepted).toHaveLength(3); // 1 活跃 + 2 排队
    expect(rejected).toHaveLength(2);

    for (const receipt of rejected) {
      // 结构化回执：确定性拒绝 + 机械原因 + 用户可见话术（容量事实）。
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toBe('resource_limited');
      expect(receipt.notice).toContain('未受理');
      expect(receipt.notice).toContain('后台排队已满（容量 2）');
      // 拒绝不留半截任务行：终态 failed（reason=resource_limited），不是 queued 幽灵行。
      const row = session.getTask(receipt.taskId);
      expect(row.status).toBe('failed');
      expect(row.reason).toBe('resource_limited');
      // 结构化事件：failed/resource_limited 事实已发出（通知 outbox 的输入面）。
      expect(
        facts.some(
          (fact) => fact.taskId === receipt.taskId && fact.to === 'failed' && fact.reason === 'resource_limited',
        ),
      ).toBe(true);
    }

    // 上界生效：排队行恰为 queueCapacity，拒绝任务零执行。
    expect(queuedRows(stack)).toBe(2);
    expect(stack.executor.started).toHaveLength(1);
  });

  it('③ 并发提交（跨会话共享 runner/policy）不会超界：排队深度峰值 ≤ queueCapacity，超出全部拒绝', async () => {
    const stack = makeStack({ queueCapacity: 2 });
    const receiptsA: unknown[] = [];
    const receiptsB: unknown[] = [];
    const sessionA = await sessionFor(stack, ['甲一', '甲二', '甲三'], receiptsA, {
      concurrent: true,
      sessionId: 'sess_a',
    });
    const sessionB = await sessionFor(stack, ['乙一', '乙二', '乙三'], receiptsB, {
      concurrent: true,
      sessionId: 'sess_b',
    });
    await Promise.all([sessionA.send('并发交办甲'), sessionB.send('并发交办乙')]);

    const rows = [...receiptsA, ...receiptsB].map(receiptOf);
    expect(rows).toHaveLength(6);
    const accepted = rows.filter((receipt) => receipt.accepted === true);
    const rejected = rows.filter((receipt) => receipt.accepted === false);
    // 进程级上界（不按会话各算一份）：1 活跃 + 2 排队。
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((receipt) => receipt.reason === 'resource_limited')).toBe(true);
    expect(rejected.every((receipt) => receipt.notice?.includes('后台排队已满（容量 2）'))).toBe(true);
    // 并发提交过程中底账 queued 行从未越过上界。
    expect(Math.max(...stack.depths)).toBeLessThanOrEqual(2);
    expect(queuedRows(stack)).toBe(2);
    expect(stack.executor.started).toHaveLength(1);
  });

  it('④ 复用现有缺省 queueCapacity=16（不新增旋钮）：1 活跃 + 16 排队后，第 18 个提交被拒', async () => {
    const stack = makeStack(); // 不传 queueCapacity = 现有缺省
    expect(stack.policy.snapshot().queueCapacity).toBe(16);
    const requests = Array.from({ length: 18 }, (_, index) => `任务${index + 1}`);
    const receipts: unknown[] = [];
    const session = await sessionFor(stack, requests, receipts);
    await session.send('连续交办');

    const rows = receipts.map(receiptOf);
    expect(rows.filter((receipt) => receipt.accepted === true)).toHaveLength(17);
    const rejected = rows.filter((receipt) => receipt.accepted === false);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe('resource_limited');
    expect(rejected[0]!.notice).toContain('后台排队已满（容量 16）');
    expect(queuedRows(stack)).toBe(16);
    expect(stack.executor.started).toHaveLength(1);
  });
});
