/**
 * A2 单回合执行边界（2026-11-18 执行面可靠性）：同回合拒 + 单回合 operation 上界。
 *
 * 根因（live 实测）：prepare 返回 needs_confirmation 后，模型在同一回合反复 commit，
 * 10 次全部 CONFIRMATION_NOT_FOUND，单任务 15 次 operation，用户转 90 秒。旧纪律只挡
 * 「句柄同回合透传」，没挡「同回合继续发起」。
 *
 * 覆盖（确定性：假执行层 + 脚本化驱动，零网络零模型）：
 *   · 同回合拒：同回合 prepare → commit，commit 在**发起前**被宿主拒——0 次真实执行、
 *     0 条 commit 执行事实，工具错误如实告知「等用户下一回合」；下一回合 commit 照常
 *     透传句柄执行（拒只限同一回合）；
 *   · 单回合上界：同一回合第 6 次 operation 在发起前被拒且话术如实（不是静默失败）；
 *     下一回合计数归零，照常执行。这是资源边界，不是计划门——不判断业务。
 */
import { afterEach, describe, expect, it } from 'vitest';
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
  operations: [
    { name: 'dummy.query', args: [] },
    { name: 'dummy.prepare', args: [] },
    { name: 'dummy.commit', args: [] },
  ],
};

/** 假执行层：按 operation 返回预设结果；记录收到的每次请求（0 次真实执行的判据）。 */
class FakeExecutionClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  constructor(private readonly outcomeFor: (request: ExecutionRequest) => ExecutionOutcome) {}
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

/** 脚本化驱动：每次 run 消费一步；步内顺序执行工具调用，出错即停并记录错误话术。 */
class StepDriver implements TurnDriver {
  private readonly steps: DriverStep[] = [];
  readonly toolErrors: string[] = [];
  readonly toolResults: unknown[] = [];

  push(step: DriverStep): void {
    this.steps.push(step);
  }

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    const step = this.steps.shift();
    if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
    for (const call of step.calls ?? []) {
      try {
        const result = await input.exec(call.tool, call.args);
        this.toolResults.push(result);
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

async function sessionFor(client: ExecutionClient, options: {
  main: StepDriver;
  worker: StepDriver;
  allowedOperations?: readonly string[];
  readOnlyOperations?: readonly string[];
}): Promise<Session> {
  return createSession({
    principalId: 'wecom:test-user',
    sessionId: 'sess_boundary',
    client,
    allowedOperations: options.allowedOperations ?? ['dummy.query', 'dummy.prepare', 'dummy.commit'],
    ...(options.readOnlyOperations === undefined ? {} : { readOnlyOperations: options.readOnlyOperations }),
    mainDriver: options.main,
    workerDriver: options.worker,
    mainSystemPrompt: '你是测试主 Agent。',
  });
}

const tempDirs: string[] = [];
afterEach(() => {
  tempDirs.splice(0).forEach(() => undefined);
});

describe('A2 同回合拒：提案已生成，等用户下一回合', () => {
  it('同回合 prepare 后 commit：commit 不发起执行、不落执行事实，工具错误如实告知', async () => {
    const client = new FakeExecutionClient((request) => {
      // 执行层语义镜像：commit 无确认句柄 → 确定性拒绝（同回合宿主根本不该发起）。
      if (request.operation === 'dummy.commit' && request.confirmation === undefined) {
        return { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED', message: 'missing confirmation' } };
      }
      if (request.operation === 'dummy.prepare') {
        return {
          status: 'needs_confirmation',
          confirmation: { handle: 'cf_test_1', summary: 'alpha W1 2 条；不可撤销', expiresAt: '2026-11-18T12:00:00.000Z' },
        };
      }
      return { status: 'completed', data: { ok: true } };
    });
    const main = new StepDriver();
    const worker = new StepDriver();
    // 同一 Worker 回合里连续两次调用：prepare 拿到 needs_confirmation，紧接着 commit。
    worker.push({
      calls: [
        { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: {} } },
        { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.commit', args: {} } },
      ],
      text: '执行层要求确认：alpha W1 2 条；不可撤销。',
    });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 新增两条记录' } }], text: '等待你确认后我再继续。' });
    const session = await sessionFor(client, { main, worker });

    const turn = await session.send('帮我在 alpha 新增两条记录');
    // 0 次真实执行：commit 没有到达执行层（只有 prepare 一次请求）。
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.operation).toBe('dummy.prepare');
    expect(client.requests[0]!.confirmation).toBeUndefined();
    // commit 零执行事实：任务只有 prepare 一条执行行。
    const task = session.tasks()[0]!;
    expect(task.executions).toHaveLength(1);
    expect(task.executions[0]!.operation).toBe('dummy.prepare');
    expect(task.executions[0]!.status).toBe('needs_confirmation');
    // 工具错误如实告知模型：提案已生成，等用户下一回合。
    expect(worker.toolErrors).toHaveLength(1);
    expect(worker.toolErrors[0]).toContain('提案');
    expect(worker.toolErrors[0]).toContain('下一回合');
    // 用户的钱没白花：回合正常结束、有回复。
    expect(turn.reply.trim()).not.toBe('');
  });

  it('下一回合 commit 照常透传句柄执行：拒只限同一回合，不是永久封锁', async () => {
    const client = new FakeExecutionClient((request) => {
      if (request.operation === 'dummy.prepare') {
        return {
          status: 'needs_confirmation',
          confirmation: { handle: 'cf_test_2', summary: 'alpha W1 2 条；不可撤销' },
        };
      }
      // commit：带句柄 = 用户已在上一回合表态 → 完成；不带 = 执行层拒绝。
      if (request.operation === 'dummy.commit') {
        return request.confirmation === undefined
          ? { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED', message: 'missing confirmation' } }
          : { status: 'completed', data: { added: 2 } };
      }
      return { status: 'completed', data: {} };
    });
    const main = new StepDriver();
    const worker = new StepDriver();
    // 回合 1：prepare 出提案。
    worker.push({ calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.prepare', args: {} } }], text: '执行层要求确认。' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '在 alpha 新增两条记录' } }], text: '等待你确认。' });
    // 回合 2：用户确认后 commit，句柄应随请求透传。
    worker.push({ calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.commit', args: {} } }], text: '已写入 2 条。' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '用户已确认，提交提案' } }], text: '已写入 2 条。' });
    const session = await sessionFor(client, { main, worker });

    await session.send('帮我在 alpha 新增两条记录');
    const turn2 = await session.send('确认，写入这两条');
    expect(turn2.reply).toContain('已写入 2 条');
    const commitTask = session.tasks()[1]!;
    expect(commitTask.executions).toHaveLength(1);
    expect(commitTask.executions[0]!.status).toBe('completed');
    // 下一回合透传：句柄 + 用户原话随请求到达执行层。
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]!.operation).toBe('dummy.commit');
    expect(client.requests[1]!.confirmation).toEqual({ handle: 'cf_test_2', userText: '确认，写入这两条' });
  });
});

describe('A2 单回合 operation 上界（资源边界，不是计划门）', () => {
  it('同一回合连续发起第 6 次 operation → 发起前被拒，话术如实（不是静默失败）', async () => {
    const client = new FakeExecutionClient(() => ({ status: 'completed', data: { count: 1 } }));
    const main = new StepDriver();
    const worker = new StepDriver();
    const sixCalls = [1, 2, 3, 4, 5, 6].map((n) => ({
      tool: EXECUTE_OPERATION_TOOL,
      args: { operation: 'dummy.query', args: { n } },
    }));
    worker.push({ calls: sixCalls, text: '查询完成。' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '连查六次' } }], text: '查询完成。' });
    const session = await sessionFor(client, { main, worker, allowedOperations: ['dummy.query'] });

    await session.send('连查六次');
    // 缺省上界 5：只有前 5 次真实到达执行层，第 6 次在发起前被拒。
    expect(client.requests).toHaveLength(5);
    // 每次被拒都有如实话术：说清上限与「本回合不再发起」。
    expect(worker.toolErrors).toHaveLength(1);
    expect(worker.toolErrors[0]).toContain('上限');
    expect(worker.toolErrors[0]).toContain('本回合');
    // 被拒的调用零执行事实：任务只有 5 条执行行。
    const task = session.tasks()[0]!;
    expect(task.executions).toHaveLength(5);
  });

  it('上界只限单回合：下一回合计数归零，第 1 次调用照常执行', async () => {
    const client = new FakeExecutionClient(() => ({ status: 'completed', data: { count: 1 } }));
    const main = new StepDriver();
    const worker = new StepDriver();
    const fiveCalls = [1, 2, 3, 4, 5].map((n) => ({
      tool: EXECUTE_OPERATION_TOOL,
      args: { operation: 'dummy.query', args: { n } },
    }));
    // 回合 1：恰好 5 次（不超界）。
    worker.push({ calls: fiveCalls, text: '查询完成。' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '查五次' } }], text: '查询完成。' });
    // 回合 2：再来 1 次——新回合重新计数，应照常执行。
    worker.push({ calls: [{ tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.query', args: { n: 6 } } }], text: '查询完成。' });
    main.push({ calls: [{ tool: TASK_RUN_TOOL, args: { task: '再查一次' } }], text: '查询完成。' });
    const session = await sessionFor(client, { main, worker, allowedOperations: ['dummy.query'] });

    await session.send('查五次');
    await session.send('再查一次');
    expect(client.requests).toHaveLength(6);
    expect(worker.toolErrors).toHaveLength(0);
  });
});
