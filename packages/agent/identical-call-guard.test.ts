/**
 * A2b 同参数重复守卫（2026-11-18 执行面可靠性）。
 *
 * 根因（live 实测 E14）：同一参数被重复提交——同一集合连取两遍全表、同一窗口再撞一次，
 * 单回合 4 次执行里 2 次是纯重复。旧上界（单回合 5 次）拦不住这种"自证循环"里的无效重复。
 *
 * 纪律：这是**资源边界**，不是计划门——只挡「完全相同」的重复，换参数照常放行；
 * 被拒的调用不发起执行、不落执行事实，工具错误如实告知。
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
): Promise<{ client: FakeExecutionClient; worker: StepDriver }> {
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
  await session.send(sendText);
  return { client, worker };
}

describe('A2b 失败/拒绝后的同参数重试守卫', () => {
  const refused: (request: ExecutionRequest) => ExecutionOutcome = () => ({
    status: 'refused',
    error: { code: 'WHERE_INVALID', message: 'collection has no window dimension' },
  });

  it('同一参数被拒后再次提交：第二次不发起执行，并如实说明「已拒绝」', async () => {
    const { client, worker } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
    ], '查 2026-10', refused);
    expect(client.requests).toHaveLength(1);
    expect(worker.toolErrors.some((message) => message.includes('已拒绝'))).toBe(true);
  });

  it('同参数成功过两次 → 都放行（owner 裁定：同参数两笔合法操作各执行一次）', async () => {
    const { client } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
      { operation: 'dummy.query', args: { '--collection': 'alpha' } },
    ]);
    expect(client.requests).toHaveLength(2);
  });

  it('失败后换参数照常放行', async () => {
    const first = { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } };
    const second = { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--where': 'customer=华远贸易' } };
    const { client } = await runWorkerCalls([first, second], '查 2026-10', (request) => (
      (request.args as Record<string, string>)['--window'] === undefined
        ? { status: 'completed', data: { count: 4 } }
        : { status: 'refused', error: { code: 'WHERE_INVALID', message: 'no window dimension' } }
    ));
    expect(client.requests).toHaveLength(2);
  });

  it('键顺序不同但参数相同，在拒绝后同样被挡（规范化去重）', async () => {
    const { client } = await runWorkerCalls([
      { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } },
      { operation: 'dummy.query', args: { '--window': '2026-10', '--collection': 'finance-invoices' } },
    ], '查 2026-10', refused);
    expect(client.requests).toHaveLength(1);
  });
});
