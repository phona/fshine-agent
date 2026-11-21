/**
 * A2b 确定性失败后的「同对象」重试守卫（2026-11-18 执行面可靠性）。
 *
 * 根因（live 实测 E14，2026-11-18）：同一集合的窗口参数被执行层判定不可用后，模型换着写法
 * （`2026-10` / `W202610`）连撞两次，又换新任务继续撞——单回合最多撞到 5 次上限。
 *
 * 纪律（owner 2026-11-18 fail-safe）：判据是**执行层没有显式说可重试**——只有 `retryable: true`
 * （瞬时故障）放行；`false` 与**未声明**都按不可重试处理，本回合内该 (operation, 对象参数)
 * 的后续调用一律不发起，工具错误如实告知并指向替代路径。宁可停下报错让人介入，
 * 也不在不确定时继续撞。
 * 不判断业务、不拦成功过的重复（owner 2026-11-16 裁定：同参数两笔合法操作各执行一次）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type {
  DriverMessage,
  TurnDriver,
  TurnDriverInput,
  TurnDriverResult,
} from './src/driver-contract';
import {
  createSession,
  EXECUTE_OPERATION_TOOL,
  TASK_RUN_TOOL,
  type Session,
} from './src/execution-runtime';

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', args: [] }],
};

class FakeExecutionClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  constructor(private readonly outcomeFor: (request: ExecutionRequest) => ExecutionOutcome = () => ({ status: 'completed', data: { count: 2 } })) {}
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return this.outcomeFor(request);
  }
}

interface DriverStep {
  calls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

class StepDriver implements TurnDriver {
  private readonly steps: DriverStep[] = [];
  readonly toolErrors: string[] = [];
  push(step: DriverStep): void {
    this.steps.push(step);
  }
  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    const step = this.steps.shift();
    if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
    for (const call of step.calls ?? []) {
      try {
        await input.exec(call.tool, call.args);
      } catch (error) {
        this.toolErrors.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: step.text }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    return { text: step.text, messages: [...input.messages, message as unknown as DriverMessage] };
  }
}

/** 单次委派：Main 让 Worker 同一回合里连续调若干次 execute_operation。 */
async function runWorkerCalls(
  calls: ReadonlyArray<{ operation: string; args: Record<string, unknown> }>,
  sendText = '查一下',
  outcomeFor?: (request: ExecutionRequest) => ExecutionOutcome,
): Promise<{ client: FakeExecutionClient; worker: StepDriver; turn: Awaited<ReturnType<Session['send']>> }> {
  const client = outcomeFor === undefined ? new FakeExecutionClient() : new FakeExecutionClient(outcomeFor);
  const main = new StepDriver();
  const worker = new StepDriver();
  worker.push({
    calls: calls.map((call) => ({
      tool: EXECUTE_OPERATION_TOOL,
      args: { operation: call.operation, args: call.args },
    })),
    text: '查完了',
  });
  main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '查 alpha 与 beta' } }], text: '结果如下' });
  const session: Session = await createSession({
    principalId: 'wecom:test-user',
    sessionId: 'sess_identical_guard',
    client,
    allowedOperations: ['dummy.query'],
    readOnlyOperations: ['dummy.query'],
    mainDriver: main,
    workerDriver: worker,
    mainSystemPrompt: '你是测试主 Agent。',
  });
  const turn = await session.send(sendText);
  return { client, worker, turn };
}

describe('A2b 确定性失败后的同对象重试守卫', () => {
  const nonRetryable: (request: ExecutionRequest) => ExecutionOutcome = () => ({
    status: 'failed',
    error: { code: 'WHERE_INVALID', message: 'collection has no window dimension', retryable: false },
  });

  it('同一集合被判定确定性失败后，换个窗口写法再试也不发起执行', async () => {
    const { client, worker } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': 'W202610' } },
    ], '查 2026-10', nonRetryable);
    expect(client.requests).toHaveLength(1);
    expect(worker.toolErrors.some((message) => message.includes('不要再换参数重试'))).toBe(true);
    // 拦下时也必须把执行层原话带给模型（否则用户只听到"参数不合法"，不知道哪里不合法）
    expect(worker.toolErrors.some((message) => message.includes('collection has no window dimension'))).toBe(true);
  });

  it('同一集合用完全相同参数重试：同样被挡', async () => {
    const call = { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } };
    const { client } = await runWorkerCalls([call, call], '查两次', nonRetryable);
    expect(client.requests).toHaveLength(1);
  });

  it('观测面：被拦下的重试随回合交回（对象/操作/码/执行层的 retryable 声明）', async () => {
    const { client, turn } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': 'W202610' } },
    ], '查 2026-10', nonRetryable);
    expect(client.requests).toHaveLength(1);
    expect(turn.retryBlocked).toEqual([
      { operation: 'dummy.query', object: 'finance-invoices', code: 'WHERE_INVALID', declaredRetryable: false },
    ]);
  });

  it('观测面：显式 retryable:true 的失败记入 retryAllowed（放行，但留下「为什么还在试」）', async () => {
    const transient = (): ExecutionOutcome => ({ status: 'failed', error: { code: 'TRANSIENT', message: 'busy', retryable: true } });
    const { client, turn } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
    ], '查 alpha', transient);
    expect(client.requests).toHaveLength(2);
    expect(turn.retryBlocked).toBeUndefined();
    // 每次瞬时失败都记一条（「一直在试」的可见面就是这些条数）
    expect(turn.retryAllowed).toEqual([
      { operation: 'dummy.query', object: 'alpha', code: 'TRANSIENT' },
      { operation: 'dummy.query', object: 'alpha', code: 'TRANSIENT' },
    ]);
  });

  it('观测面：未声明 retryable 的失败，拦截记录里 declaredRetryable 缺省（不是编造 false）', async () => {
    const unclassified = (): ExecutionOutcome => ({ status: 'failed', error: { code: 'SOMETHING_ODD', message: 'unexpected' } });
    const { turn } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
    ], '查 alpha', unclassified);
    expect(turn.retryBlocked).toEqual([{ operation: 'dummy.query', object: 'alpha', code: 'SOMETHING_ODD' }]);
  });

  it('换集合照常放行（对象不同 = 不是同一请求）', async () => {
    const { client } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
      { operation: 'dummy.query', args: { '--collection': 'documents', '--window': 'W202611' } },
    ], '查两个集合', nonRetryable);
    expect(client.requests).toHaveLength(2);
  });

  it('显式 retryable:true（瞬时故障）不挡后续尝试', async () => {
    const retryable: (request: ExecutionRequest) => ExecutionOutcome = () => ({
      status: 'failed',
      error: { code: 'TRANSIENT', message: 'temporarily unavailable', retryable: true },
    });
    const { client } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
    ], '查 alpha', retryable);
    expect(client.requests).toHaveLength(2);
  });

  it('显式 retryable 放行有次数上界（E14 口径：同一件事一个回合内兜/重试 ≤2 次）：第 3 次发起前被拦', async () => {
    // 根因（真模型验收实跑）：执行层对参数形状错误声明 retryable:true 时宿主无条件放行，
    // Worker 一个回合里用 5 种错误写法连撞 5 次——放行没有次数上限。修法：放行次数用尽后，
    // 同一 (operation, 对象) 转入既有拦截路径（retryBlocked/事件），不新造计数通道。
    const retryableShapeError: (request: ExecutionRequest) => ExecutionOutcome = () => ({
      status: 'failed',
      error: {
        code: 'INVALID_RECORDS',
        message: '--records 必须是结构化数组（每项 {name, value}）',
        retryable: true,
      },
    });
    const { client, worker, turn } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha', '--records': 'bad-1' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha', '--records': 'bad-2' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha', '--records': 'bad-3' } },
    ], '查 alpha', retryableShapeError);
    // 前两次真实发起（放行），第三次在发起前被宿主拦下（执行层没被打第 3 次）。
    expect(client.requests).toHaveLength(2);
    expect(turn.retryAllowed).toEqual([
      { operation: 'dummy.query', object: 'alpha', code: 'INVALID_RECORDS' },
      { operation: 'dummy.query', object: 'alpha', code: 'INVALID_RECORDS' },
    ]);
    // 拦截事实带 declaredRetryable:true（执行层当时确实说可重试；拦的是次数，不是改写语义）。
    expect(turn.retryBlocked).toEqual([
      { operation: 'dummy.query', object: 'alpha', code: 'INVALID_RECORDS', declaredRetryable: true },
    ]);
    // 被拦时按既有话术如实告知模型停下（同一句「不要再换参数重试」）。
    expect(worker.toolErrors.some((message) => message.includes('不要再换参数重试'))).toBe(true);
  });

  it('失败但**未声明** retryable → 按不可重试处理（fail-safe 缺省）', async () => {
    // owner 2026-11-18：不确定就停下。执行层没写 retryable 不等于「可以重试」。
    const unclassified: (request: ExecutionRequest) => ExecutionOutcome = () => ({
      status: 'failed',
      error: { code: 'SOMETHING_ODD', message: 'unexpected' },
    });
    const { client, worker } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha', '--window': 'W1' } },
    ], '查 alpha', unclassified);
    expect(client.requests).toHaveLength(1);
    expect(worker.toolErrors.some((message) => message.includes('不要再换参数重试'))).toBe(true);
  });

  it('成功过的重复照常放行（同参数两笔合法操作各执行一次）', async () => {
    const { client } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
    ]);
    expect(client.requests).toHaveLength(2);
  });

  it('跨回合不累计：下一回合对同一集合仍可再试', async () => {
    const client = new FakeExecutionClient(nonRetryable);
    const main = new StepDriver();
    const worker = new StepDriver();
    const call = { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.query', args: { '--collection': 'finance-invoices' } } };
    worker.push({ calls: [call], text: '第一回合失败' });
    worker.push({ calls: [call], text: '第二回合再试' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '查一下' } }], text: '好' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '再查一下' } }], text: '好' });
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_deterministic_guard_turns',
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      mainDriver: main,
      workerDriver: worker,
      mainSystemPrompt: '你是测试主 Agent。',
    });
    await session.send('查一下');
    await session.send('再查一下');
    expect(client.requests).toHaveLength(2);
  });
});
