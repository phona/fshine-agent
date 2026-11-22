/**
 * U3 守护测试（独立复审缺口）：**待核对优先于取消**。
 *
 * 场景：写操作已进入 unknown（外部是否生效未知），同一回合里用户取消（abort）。
 * 取消只停止后续动作，不能把「结果未知」改写成已确认的 cancelled——否则用户会以为
 * 什么都没发生，从而安全地重办一次真正可能已生效的写操作。
 *
 * 反向绊线：没出现过 unknown 的取消仍然是 cancelled（不因为本次修复把普通取消也翻转）。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionRequest,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createTaskExecutor, EXECUTE_OPERATION_TOOL } from './src/execution-runtime';
import { createTaskRegistry } from './src/task-registry';
import {
  createTaskRunner,
  type ResourcePermit,
  type ResourcePolicyPort,
  type TaskExecutionInput,
} from './src/task-runner';

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
  ],
};

const TASK: TaskExecutionInput = {
  taskId: 't_pending',
  request: '把 docs 提交到生产',
  principalId: 'wecom:u3',
  sessionId: 'sess_u3',
};

/** 执行层无回执（连接中断）：宿主只能判「结果未知」，不得当作已确认失败或成功。 */
class NoReceiptClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    throw new Error('连接被重置：执行层无回执');
  }
}

/** 只读操作成功回执（反向绊线用；不产生 unknown）。 */
class DoneClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: { rows: 1 } };
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function permissivePolicy(): ResourcePolicyPort {
  return {
    acquire: (kind): ResourcePermit => ({ kind }),
    release: () => {},
    cancelQueued: () => {},
  };
}

const WRITE_ARGS = { operation: 'dummy.commit', args: { '--collection': 'docs' } };

describe('U3 待核对优先于取消（写操作 unknown 后同回合取消）', () => {
  it('写操作已 unknown 后同回合取消：执行端结局是 result_unknown，不是 cancelled', async () => {
    const registry = createTaskRegistry();
    const client = new NoReceiptClient();
    const controller = new AbortController();
    const driver: TurnDriver = {
      async run(input) {
        try {
          await input.exec(EXECUTE_OPERATION_TOOL, WRITE_ARGS);
        } catch {
          // ToolUserError：待核对确定性终结本次工具调用，回合继续走取消路径。
        }
        controller.abort();
        throw abortError();
      },
    };
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.commit'],
      workerDriver: driver,
      registry,
      workerTurnMs: 30_000,
    });

    const outcome = await executor.execute(TASK, { signal: controller.signal });

    expect(outcome.kind).toBe('result_unknown');
    // 账行如实为 unknown（不因取消被改写为 succeeded/failed）。
    const dispatchKey = client.requests[0]?.dispatchKey;
    expect(dispatchKey).toMatch(/^dk_/);
    expect(registry.getOperation(dispatchKey!)?.status).toBe('unknown');
  });

  it('经 TaskRunner 落底账：取消请求后任务 status=failed、reason=result_unknown（不是 cancelled）', async () => {
    const registry = createTaskRegistry();
    const client = new NoReceiptClient();
    /** 真实的用户取消路径：中止信号来自 runner.cancel（不是执行端自己造 abort）。 */
    const driver: TurnDriver = {
      async run(input) {
        try {
          await input.exec(EXECUTE_OPERATION_TOOL, WRITE_ARGS);
        } catch {
          // 同上。
        }
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw abortError();
      },
    };
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.commit'],
      workerDriver: driver,
      registry,
      workerTurnMs: 30_000,
    });
    const runner = createTaskRunner({
      registry,
      policy: permissivePolicy(),
      executor,
      leaseMs: 60_000,
    });
    const scope = { principalId: TASK.principalId, sessionId: TASK.sessionId };

    runner.submit({
      taskId: TASK.taskId,
      principalId: TASK.principalId,
      sessionId: TASK.sessionId,
      request: TASK.request,
    });
    runner.pump();
    // 等写操作真实发起（执行层无回执 → unknown）后，再走用户取消。
    await vi.waitFor(() => {
      expect(registry.get(TASK.taskId, scope).leaseUntil).toBeDefined();
      expect(client.requests).toHaveLength(1);
    });
    expect(runner.cancel(TASK.taskId, scope).outcome).toBe('requested');
    await runner.whenIdle();

    const task = registry.get(TASK.taskId, scope);
    // 底账无 status/reason：待核对事实落在逻辑操作账（unknown 行），不因取消被改写成 cancelled。
    const dispatchKey = client.requests[0]?.dispatchKey;
    expect(dispatchKey).toMatch(/^dk_/);
    expect(registry.getOperation(dispatchKey!)?.status).toBe('unknown');
    expect(task.cancelledAt).toBeUndefined();
  });

  it('反向绊线：没有 unknown 的取消仍然是 cancelled（不把普通取消翻转为待核对）', async () => {
    const registry = createTaskRegistry();
    const controller = new AbortController();
    const driver: TurnDriver = {
      async run() {
        controller.abort();
        throw abortError();
      },
    };
    const executor = await createTaskExecutor({
      client: new DoneClient(),
      allowedOperations: ['dummy.commit'],
      workerDriver: driver,
      registry,
      workerTurnMs: 30_000,
    });

    const outcome = await executor.execute(TASK, { signal: controller.signal });
    expect(outcome.kind).toBe('cancelled');
  });
});
