/**
 * taskBudget 运行时计量接线（R4 · owner 2026-11-14 授权 3a；TDD 先在红）。
 *
 * 判据（resource-policy「§2 冻结面」+ 联合接口约定 §5 映射）：
 *   · 计量点：execution-runtime 每次 Worker 调用完成后，按任务累计 calls（1/次）与 ms；
 *   · 调用前检查：许可派生 / 前台准入对已耗尽预算确定性拒绝 budget_exhausted，
 *     任务落 failed + reason=resource_limited（不进入执行、零调用、不静默继续）；
 *   · 子 Worker 共享父预算的**同一对象**（不复制、不放大：一次调用只计一次）；
 *   · 配置缺省（无 taskBudget）= 零行为变化：无任务级限额、不发生预算拒绝；
 *   · token：TurnDriverResult 不提供可验证的 Pi assistant.usage → 不计量、不伪造硬上限
 *     （未声明 tokens 恒 unavailable；声明但未观测到用量 → 用量不虚增）。
 *
 * 全部假件（假 Main/Worker driver、假执行面、假时钟），零网络、零真实模型、零真实平台。
 * 本文件只覆盖「计量接线」；policy 自身的语义矩阵在 resource-policy.test.ts（不重复）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createSession, ForegroundRejectionError } from './src/execution-runtime';
import { createResourcePolicy, type ResourcePolicy } from './src/resource-policy';

afterEach(() => {
  vi.useRealTimers();
});

const PRINCIPAL = 'wecom:budget-user';
const SESSION = 'budget-conv';
/** 前台回合任务 id（execution-runtime 的前台许可口径；委派子许可共享该任务预算）。 */
const SESSION_TASK = `session:${PRINCIPAL}:${SESSION}`;

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] }],
};

class FakeClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return { status: 'completed', data: { items: ['item-1'] } };
  }
}

interface MainPlan {
  readonly tasks?: readonly string[];
  readonly reply?: string;
}

interface MainTurnRecord {
  readonly text: string;
  readonly execErrors: readonly unknown[];
}

/** 假 Main driver：按用户文本取计划，逐条委派 run_task；委派错误记下后继续（回合不炸）。 */
function fakeMain(
  plans: ReadonlyMap<string, MainPlan>,
): { driver: TurnDriver; records: MainTurnRecord[] } {
  const records: MainTurnRecord[] = [];
  const driver: TurnDriver = {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = plans.get(text);
      if (plan === undefined) throw new Error(`（测试）未配置计划的回合：${text}`);
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('（测试）Main 无工具面');
      const execErrors: unknown[] = [];
      for (const request of plan.tasks ?? []) {
        try {
          await input.exec(tool.name, { task: request });
        } catch (error) {
          execErrors.push(error);
        }
      }
      records.push({ text, execErrors });
      const reply = plan.reply ?? `（测试回复：${text}）`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
  return { driver, records };
}

interface WorkerOptions {
  /** 汇报文本；'' = 未产出有效汇报（失败回合）。 */
  readonly text?: string;
  /** 是否发起一次执行层调用（缺省 true）。 */
  readonly exec?: boolean;
  /** 每次调用时执行（假时钟推进等）。 */
  readonly onRun?: () => void;
}

function fakeWorker(options: WorkerOptions = {}): { driver: TurnDriver; calls: () => number } {
  let calls = 0;
  const driver: TurnDriver = {
    async run(input) {
      calls += 1;
      options.onRun?.();
      if (options.exec !== false) {
        await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'items' } });
      }
      return { text: options.text ?? '（测试 Worker 汇报）', messages: [] };
    },
  };
  return { driver, calls: () => calls };
}

async function makeSession(input: {
  readonly policy?: ResourcePolicy;
  readonly mainDriver: TurnDriver;
  readonly workerDriver: TurnDriver;
  readonly client?: FakeClient;
}) {
  return createSession({
    principalId: PRINCIPAL,
    sessionId: SESSION,
    client: input.client ?? new FakeClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: input.mainDriver,
    workerDriver: input.workerDriver,
    mainSystemPrompt: '（测试主提示）',
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
}

describe('预算计量：每次 Worker 调用后 consume（calls/ms）', () => {
  it('两条委派 = 两次调用 / 两段时长，按任务累计到共享预算对象', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
    const client = new FakeClient();
    const worker = fakeWorker({ onRun: () => vi.setSystemTime(Date.now() + 120) });
    const main = fakeMain(new Map([
      ['查两件事', { tasks: ['查询 A', '查询 B'], reply: '两件都查完了' }],
    ]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 10 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver, client });

    const result = await session.send('查两件事');

    const budget = policy.budgetFor(SESSION_TASK);
    expect(result.taskIds).toHaveLength(2);
    expect(worker.calls()).toBe(2);
    expect(client.requests).toHaveLength(2);
    expect(budget.used.calls).toBe(2);
    expect(budget.used.ms).toBeGreaterThanOrEqual(240);
    expect(budget.exhausted()).toBeNull();
  });
});

describe('恰好耗尽 / 超出：调用前确定性拒绝且零调用', () => {
  it('时长恰好到达上限即耗尽（ms）；下一回合前台准入拒绝 budget_exhausted、零调用', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
    const client = new FakeClient();
    const worker = fakeWorker({ onRun: () => vi.setSystemTime(Date.now() + 100) });
    const main = fakeMain(new Map([
      ['第一单', { tasks: ['任务一'], reply: 'ok1' }],
      ['第二单', { tasks: ['任务二'], reply: 'ok2' }],
    ]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100, calls: 100 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver, client });

    await session.send('第一单');
    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.used.ms).toBeGreaterThanOrEqual(100);
    expect(budget.exhausted()?.reason).toBe('ms');

    const workerBefore = worker.calls();
    const execBefore = client.requests.length;
    const error = await session.send('第二单').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForegroundRejectionError);
    expect((error as ForegroundRejectionError).reason).toBe('budget_exhausted');
    expect(worker.calls()).toBe(workerBefore);
    expect(client.requests).toHaveLength(execBefore);
    expect(session.tasks()).toHaveLength(1);
  });

  it('调用数用尽后同一回合内的下一次委派拒绝：任务 resource_limited、零 Worker 调用', async () => {
    const client = new FakeClient();
    const worker = fakeWorker();
    const main = fakeMain(new Map([
      ['连办两单', { tasks: ['第一件', '第二件'], reply: '第一件完成' }],
    ]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 1 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver, client });

    await session.send('连办两单');

    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.used.calls).toBe(1);
    expect(budget.exhausted()).toEqual({ reason: 'calls', limit: 1, used: 1 });
    expect(worker.calls()).toBe(1);
    expect(client.requests).toHaveLength(1);
    expect(main.records).toHaveLength(1);
    expect(main.records[0]?.execErrors).toHaveLength(1);
    const tasks = session.tasks();
    expect(tasks.find((task) => task.request === '第一件')?.status).toBe('completed');
    const refused = tasks.find((task) => task.request === '第二件');
    expect(refused?.status).toBe('failed');
    expect(refused?.reason).toBe('resource_limited');
  });
});

describe('子 Worker 共享父预算：同一对象、不复制、不放大', () => {
  it('父（前台回合）与子（委派）同一预算对象：两次调用只计两次、子视角=父用量', async () => {
    const worker = fakeWorker();
    const main = fakeMain(new Map([
      ['连办两单', { tasks: ['第一件', '第二件'], reply: 'done' }],
    ]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 3 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver });

    await session.send('连办两单');

    const sessionBudget = policy.budgetFor(SESSION_TASK);
    expect(sessionBudget.used.calls).toBe(2);
    expect(sessionBudget.exhausted()).toBeNull();
    const tasks = session.tasks();
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      const childBudget = policy.budgetFor(task.taskId);
      expect(childBudget).toBe(sessionBudget);
      expect(childBudget.limits).toEqual({ ms: 100_000, calls: 3 });
      expect(childBudget.used.calls).toBe(2);
    }
  });
});

describe('配置缺省 = 零行为变化', () => {
  it('无 taskBudget：无任务级限额、连续回合零拒绝；用量照实记录但不构成上限', async () => {
    const worker = fakeWorker();
    const main = fakeMain(new Map([
      ['单1', { tasks: ['A'], reply: 'r1' }],
      ['单2', { tasks: ['B'], reply: 'r2' }],
      ['单3', { tasks: ['C'], reply: 'r3' }],
    ]));
    const policy = createResourcePolicy(); // 无 runtime 段 = 缺省
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver });

    for (const text of ['单1', '单2', '单3']) {
      const result = await session.send(text);
      expect(result.reply).toBeTruthy();
    }

    expect(worker.calls()).toBe(3);
    expect(session.tasks().every((task) => task.status === 'completed')).toBe(true);
    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.limits).toBeNull();
    expect(budget.exhausted()).toBeNull();
    expect(budget.tokens).toBe('unavailable');
    expect(budget.used.calls).toBe(3);
  });
});

describe('token 不伪造（无可验证 Pi assistant.usage）', () => {
  it('未声明 tokens：unavailable、用量无 tokens 字段、无 token 上限', async () => {
    const worker = fakeWorker();
    const main = fakeMain(new Map([['办一件', { tasks: ['任务一'], reply: 'done' }]]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 10 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver });

    await session.send('办一件');

    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.tokens).toBe('unavailable');
    expect(budget.limits).toEqual({ ms: 100_000, calls: 10 });
    expect(budget.used).toEqual({ ms: expect.any(Number), calls: 1 });
    expect(budget.exhausted()).toBeNull();
  });

  it('声明 tokens 但无可验证 usage：用量不虚增、不因伪造触发 tokens 耗尽', async () => {
    const worker = fakeWorker();
    const main = fakeMain(new Map([['办一件', { tasks: ['任务一'], reply: 'done' }]]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 10, tokens: 1 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver });

    await session.send('办一件');

    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.tokens).toBe('enforced');
    expect(budget.used.calls).toBe(1);
    expect((budget.used as { tokens?: number }).tokens ?? 0).toBe(0);
    expect(budget.exhausted()).toBeNull();
  });
});

describe('失败回合仍如实计量', () => {
  it('Worker 未产出汇报（调用已发生）仍计一次；该调用用尽额度后不再静默继续', async () => {
    const client = new FakeClient();
    const worker = fakeWorker({ text: '', exec: false });
    const main = fakeMain(new Map([['办一件', { tasks: ['任务一'], reply: '没成' }]]));
    const policy = createResourcePolicy({ taskBudget: { ms: 100_000, calls: 1 } });
    const session = await makeSession({ policy, mainDriver: main.driver, workerDriver: worker.driver, client });

    await session.send('办一件');

    expect(worker.calls()).toBe(1);
    const budget = policy.budgetFor(SESSION_TASK);
    expect(budget.used.calls).toBe(1);
    expect(budget.exhausted()).toEqual({ reason: 'calls', limit: 1, used: 1 });
    expect(session.tasks()[0]?.status).toBe('failed');
  });
});
