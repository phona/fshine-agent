/**
 * 机制参数「碰不到」守卫（owner 2026-11-20）：op_* 工具面只收声明过的业务字段名，任何
 * 未声明字段（含 hostOnly 裸名/执行层原样名、任何 `--` 前缀键）都在发起执行前确定性拒绝，
 * 执行层零调用；schema 快照钉死 properties/required 里无机制参数名、无 `--`，且
 * additionalProperties === false。
 *
 * 反向绊线（本节 ://reverse）：把 `assertOpToolArgs` 临时改回「全都放行」/把 schema 的
 * additionalProperties 改回 true → ①②必红（读数见提交/报告）。
 */
import { describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import {
  assertOpToolArgs,
  createTaskExecutor,
  OP_TOOL_ARGS_REJECTED_MESSAGE,
  workerOperationTools,
  workerVisibleArgs,
  type ExecutionEvent,
} from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';

const SCOPE = { principalId: 'wecom:seal', sessionId: 'sess-seal' };

/** 一把真实形状的清单：业务字段 + hostOnly 机制参数（含 -- 前缀声明名）。 */
const MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    {
      name: 'dummy.prepare',
      label: 'prepare records',
      args: [
        { name: '--collection', required: true, type: 'name' },
        { name: '--window', required: false, type: 'code' },
        { name: '--count', required: false, type: 'code', hostOnly: true },
        { name: '--apply', required: false, type: 'code', hostOnly: true },
      ],
    },
    {
      name: 'dummy.longtask',
      label: 'long running task',
      args: [
        { name: '--seconds', required: true, type: 'code', hostOnly: true },
        { name: '--fail-after', required: false, type: 'code', hostOnly: true },
      ],
      long_running: true,
    },
  ],
};

const HOST_ONLY_NAMES = ['count', 'apply', 'seconds', 'fail-after'];

/** 计数执行客户端：任何 execute 调用都记账（守卫①要求执行层零调用）。 */
class CountingClient implements ExecutionClient {
  readonly calls: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.calls.push(request);
    return { status: 'completed', data: {} };
  }
}

/** Worker 假驱动：按脚本逐条发 tool 调用，记录抛错（不吞），最终给一句话收尾。 */
function scriptedWorker(calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>): {
  driver: TurnDriver;
  errors: unknown[];
} {
  const errors: unknown[] = [];
  return {
    errors,
    driver: {
      async run(input) {
        for (const call of calls) {
          try {
            await input.exec(call.tool, call.args);
          } catch (error) {
            errors.push(error);
          }
        }
        return { text: '（守卫测试）', messages: [] as unknown as DriverMessage[] };
      },
    },
  };
}

async function makeExecutor(input: {
  client: ExecutionClient;
  registry: TaskRegistry;
  worker: TurnDriver;
  onExecutionEvent?: (event: ExecutionEvent) => void;
}) {
  return createTaskExecutor({
    client: input.client,
    allowedOperations: ['dummy.prepare', 'dummy.longtask'],
    workerDriver: input.worker,
    registry: input.registry,
    workerTurnMs: 30_000,
    ...(input.onExecutionEvent === undefined ? {} : { onExecutionEvent: input.onExecutionEvent }),
  });
}

async function runTask(executor: Awaited<ReturnType<typeof makeExecutor>>, registry: TaskRegistry, taskId: string) {
  registry.begin({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '守卫测试' });
  await executor.execute(
    { taskId, request: '守卫测试', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId },
    { signal: new AbortController().signal },
  );
}

describe('机制参数碰不到：op_* 工具参数结构化拒绝', () => {
  it('① op_dummy_prepare 传 {"--apply":true} → 确定性拒绝，执行层零调用，落 op_tool_args_rejected 事件', async () => {
    const client = new CountingClient();
    const registry = createTaskRegistry();
    const events: ExecutionEvent[] = [];
    const { driver, errors } = scriptedWorker([
      { tool: 'op_dummy_prepare', args: { '--apply': true } },
    ]);
    const executor = await makeExecutor({ client, registry, worker: driver, onExecutionEvent: (e) => events.push(e) });
    await runTask(executor, registry, 'seal-1');

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(OP_TOOL_ARGS_REJECTED_MESSAGE);
    // 错误话术不含 hostOnly 名、不含任何 `--` 前缀、不含内部机制词。
    for (const term of ['--apply', 'apply', '--', 'hostOnly', '宿主', '执行层', '旋钮', 'flag']) {
      expect((errors[0] as Error).message, `拒绝话术不得含 ${term}`).not.toContain(term);
    }
    // 执行层零调用：拒绝发生在发起执行之前。
    expect(client.calls).toHaveLength(0);
    // 结构化事件只记字段名，供取证；字段名不进模型话术（上面已钉）。
    const rejected = events.filter((event) => event.event === 'op_tool_args_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ tool: 'op_dummy_prepare', keys: ['--apply'], dashedKeys: 1 });
  });

  it('② op_dummy_prepare 传未声明裸名 {"seconds":2} → 确定性拒绝，执行层零调用', async () => {
    // 注意：seconds 是 dummy.longtask 的 hostOnly；即便换成别的 operation 的裸名也不认。
    const client = new CountingClient();
    const registry = createTaskRegistry();
    const { driver, errors } = scriptedWorker([
      { tool: 'op_dummy_prepare', args: { seconds: 2 } },
    ]);
    const executor = await makeExecutor({ client, registry, worker: driver });
    await runTask(executor, registry, 'seal-2');

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(OP_TOOL_ARGS_REJECTED_MESSAGE);
    expect(client.calls).toHaveLength(0);
  });

  it('③ 合法业务字段正常放行（绊线校准：严格不等于全拒）', async () => {
    const client = new CountingClient();
    const registry = createTaskRegistry();
    const { driver, errors } = scriptedWorker([
      { tool: 'op_dummy_prepare', args: { collection: 'alpha', window: 'W1' } },
    ]);
    const executor = await makeExecutor({ client, registry, worker: driver });
    await runTask(executor, registry, 'seal-3');

    expect(errors).toHaveLength(0);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.args).toMatchObject({ '--collection': 'alpha', '--window': 'W1' });
    // hostOnly 的 count 未被模型值污染（这里也没给 records → 不填）。
    expect(client.calls[0]!.args!['--count']).toBeUndefined();
  });
});

describe('机制参数碰不到：schema 快照', () => {
  it('④ 每个 op_* 工具 properties/required 无 hostOnly 名、无 `--`，且 additionalProperties === false', () => {
    const tools = workerOperationTools(MANIFEST);
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties: unknown;
      };
      expect(schema.additionalProperties, `${tool.name} additionalProperties 必须为 false`).toBe(false);
      const fields = Object.keys(schema.properties);
      for (const field of fields) {
        expect(field, `${tool.name} 字段名不得含 --`).not.toContain('--');
        for (const hostOnly of HOST_ONLY_NAMES) {
          expect(field, `${tool.name} 字段名不得是 hostOnly ${hostOnly}`).not.toBe(hostOnly);
        }
      }
      for (const required of schema.required ?? []) {
        expect(required, `${tool.name} required 不得含 --`).not.toContain('--');
        for (const hostOnly of HOST_ONLY_NAMES) {
          expect(required, `${tool.name} required 不得是 hostOnly ${hostOnly}`).not.toBe(hostOnly);
        }
      }
    }
    // 明细：prepare 只露业务字段；longtask 全 hostOnly → 空 properties。
    const prepare = tools.find((tool) => tool.name === 'op_dummy_prepare')!;
    expect(Object.keys((prepare.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['collection', 'window']);
    const longtask = tools.find((tool) => tool.name === 'op_dummy_longtask')!;
    expect(Object.keys((longtask.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([]);
  });

  it('⑤ workerVisibleArgs 只含非 hostOnly 业务字段（映射层已无 hostOnly 透传）', () => {
    for (const operation of MANIFEST.operations) {
      for (const { field, declaration } of workerVisibleArgs(operation)) {
        expect(declaration.hostOnly).not.toBe(true);
        expect(field).not.toContain('--');
      }
    }
  });
});

describe('机制参数碰不到：纯函数校验面', () => {
  it('⑥ assertOpToolArgs 对未知键/`--` 键确定性拒绝；合法键放行', () => {
    const prepare = MANIFEST.operations.find((operation) => operation.name === 'dummy.prepare')!;
    const events: ExecutionEvent[] = [];
    expect(() => assertOpToolArgs({ tool: 'op_dummy_prepare', operation: prepare, args: { collection: 'alpha' } })).not.toThrow();
    expect(() => assertOpToolArgs({
      tool: 'op_dummy_prepare',
      operation: prepare,
      args: { '--apply': true },
      onEvent: (event) => events.push(event),
    })).toThrow(OP_TOOL_ARGS_REJECTED_MESSAGE);
    expect(() => assertOpToolArgs({ tool: 'op_dummy_prepare', operation: prepare, args: { count: 2 } }))
      .toThrow(OP_TOOL_ARGS_REJECTED_MESSAGE);
    expect(events).toHaveLength(1);
  });
});
