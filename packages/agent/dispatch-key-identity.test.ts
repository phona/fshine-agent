/**
 * U3 稳定逻辑操作身份：宿主绑定与运行时行为（假驱动 + 假执行客户端；零网络、零真实模型）。
 *
 * 钉住的是「恢复后的新调用如何重新绑定到已有操作」：
 *   · 驱动转述 compaction willRetry → 宿主开重放窗口 → 被重试响应里同名操作读回同一行；
 *   · 无窗口 = 两笔合法（即使参数完全相同）→ 两行两 key、各执行一次；
 *   · 读操作（装配方声明的只读集合）在窗口内可安全重发，不被 key 逻辑误挡；
 *   · 外部结果未知 → 停止自动重试，任务落 failed + reason=result_unknown（不是成功、不是确认失败）；
 *   · 每次执行层请求都带非空 dispatchKey，且与账行一致（回放不产生新执行行）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, RuntimeTurnEvent, TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver-contract';
import { createSession, EXECUTE_OPERATION_TOOL, RUN_TASK_TOOL, type Session } from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
  ],
};

type Action =
  | { kind: 'event'; event: RuntimeTurnEvent }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string };

/** 按预设动作序列推进的假驱动：显式控制「响应结束 / 运行时恢复」与工具调用顺序。 */
class ScriptedDriver implements TurnDriver {
  runs = 0;
  constructor(private readonly actions: readonly Action[]) {}

  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    this.runs += 1;
    let text = '';
    for (const action of this.actions) {
      if (action.kind === 'event') {
        input.onRuntimeEvent?.(action.event);
        continue;
      }
      if (action.kind === 'tool') {
        try {
          await input.exec(action.tool, action.args);
        } catch {
          // 工具的确定性终结（ToolUserError 语义）：本回合到此结束，不产出回复。
          return { text, messages: [...input.messages] as DriverMessage[] };
        }
        continue;
      }
      text = action.text;
    }
    return { text, messages: [...input.messages] as DriverMessage[] };
  }
}

class RecordingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  constructor(private readonly outcome: () => ExecutionOutcome = () => ({ status: 'completed', data: { rows: 3 } })) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return this.outcome();
  }
}

interface SessionOptions {
  main: readonly Action[];
  worker?: readonly Action[];
  client: RecordingClient;
  registry: TaskRegistry;
  allowedOperations?: readonly string[];
  readOnlyOperations?: readonly string[];
}

async function sessionFor(options: SessionOptions): Promise<{ session: Session; worker: ScriptedDriver }> {
  const worker = new ScriptedDriver(options.worker ?? []);
  const session = await createSession({
    principalId: 'wecom:u3',
    sessionId: 'sess_u3',
    client: options.client,
    allowedOperations: options.allowedOperations ?? ['dummy.query'],
    ...(options.readOnlyOperations === undefined ? {} : { readOnlyOperations: options.readOnlyOperations }),
    mainDriver: new ScriptedDriver(options.main),
    workerDriver: worker,
    mainSystemPrompt: '主 Agent',
    taskRegistry: options.registry,
    mainTurnMs: 60_000,
    workerTurnMs: 30_000,
  });
  return { session, worker };
}

const END: Action = { kind: 'event', event: { kind: 'assistant_end' } };
const RETRY: Action = { kind: 'event', event: { kind: 'recovery', reason: 'compaction' } };

function queryTool(): Action {
  return { kind: 'tool', tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.query', args: { '--collection': 'docs' } } };
}

const afterEachCleanup: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of afterEachCleanup.splice(0)) cleanup();
});

describe('U3 宿主绑定（恢复后重绑定 / 同参数不合并 / 只读重试 / 待核对）', () => {
  it('恢复后的同名操作：回放已有结果，只调用执行层一次', async () => {
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const { session } = await sessionFor({
      // Worker：响应 1 的查询 → 溢出恢复（丢弃该尝试）→ 重试的响应 2 又发了同一查询。
      worker: [END, queryTool(), RETRY, END, queryTool(), { kind: 'text', text: '已查询 docs：3 条。' }],
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '查询 docs' } },
        { kind: 'text', text: 'docs 共 3 条。' },
      ],
      client,
      registry,
    });

    const result = await session.send('查 docs');
    expect(result.reply).toContain('3 条');
    expect(client.requests).toHaveLength(1);
    // 任务按真实执行事实判定（只有一行真实执行，回放不写执行行）。
    const task = session.tasks()[0]!;
    expect(task.status).toBe('completed');
    expect(task.executions).toHaveLength(1);
    expect(task.executions[0]!.operation).toBe('dummy.query');
  });

  it('无恢复事件：参数完全相同的两次调用各执行一次、两个不同的 dispatchKey', async () => {
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const { session } = await sessionFor({
      worker: [END, queryTool(), END, queryTool(), { kind: 'text', text: '查询完成。' }],
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '查两次 docs' } },
        { kind: 'text', text: '已查询。' },
      ],
      client,
      registry,
    });

    await session.send('查两次 docs');
    expect(client.requests).toHaveLength(2);
    const [first, second] = client.requests;
    expect(first!.dispatchKey).toBeTruthy();
    expect(second!.dispatchKey).toBeTruthy();
    expect(first!.dispatchKey).not.toBe(second!.dispatchKey);
    // 两行独立账（不按参数合并）。
    expect(registry.getOperation(first!.dispatchKey)?.operation).toBe('dummy.query');
    expect(registry.getOperation(second!.dispatchKey)?.operation).toBe('dummy.query');
    expect(registry.getOperation(first!.dispatchKey)?.status).toBe('completed');
    expect(registry.getOperation(second!.dispatchKey)?.status).toBe('completed');
  });

  it('只读操作在恢复窗口内可安全重试：同一身份重发、不被 key 逻辑误挡', async () => {
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const { session } = await sessionFor({
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
      worker: [END, queryTool(), RETRY, END, queryTool(), { kind: 'text', text: '已重新查询。' }],
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '查 docs' } },
        { kind: 'text', text: '已查询。' },
      ],
      client,
      registry,
    });

    const result = await session.send('查 docs');
    expect(client.requests).toHaveLength(2);
    // 同一逻辑读：身份不变（只重新认领），不是新铸一个 key。
    expect(client.requests[0]!.dispatchKey).toBe(client.requests[1]!.dispatchKey);
    const task = session.tasks()[0]!;
    expect(task.status).toBe('completed');
    expect(task.reason).toBeUndefined();
    expect(result.reply).not.toContain('待核对');
  });

  it('外部写入结果未知：停止自动重试，任务落 failed + result_unknown（不是成功、不是确认失败）', async () => {
    const client = new RecordingClient(() => ({
      status: 'failed',
      error: { code: 'result_unknown', message: '外部系统无回执', retryable: false },
    }));
    const registry = createTaskRegistry();
    const { session } = await sessionFor({
      allowedOperations: ['dummy.commit'],
      worker: [END, { kind: 'tool', tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.commit', args: { '--collection': 'docs' } } }],
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '提交 docs' } },
        { kind: 'text', text: '这次结果不确定，需要再确认。' },
      ],
      client,
      registry,
    });

    await session.send('提交 docs');
    // 只尝试一次：结果未知不自动重试。
    expect(client.requests).toHaveLength(1);
    const task = session.tasks()[0]!;
    expect(task.status).toBe('failed');
    expect(task.reason).toBe('result_unknown');
    expect(registry.getOperation(client.requests[0]!.dispatchKey)?.status).toBe('unknown');
    expect(registry.getOperation(client.requests[0]!.dispatchKey)?.reason).toBe('result_unknown');
  });

  it('Main 的 run_task 在恢复窗口内重复：只创建一个任务，回执回放（不重复委派）', async () => {
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const { session, worker } = await sessionFor({
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '查询 docs' } },
        RETRY,
        END,
        // 重试的响应措辞不同，但仍是同一次交办。
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '帮我查询 docs 的数据' } },
        { kind: 'text', text: 'docs 共 3 条。' },
      ],
      worker: [END, queryTool(), { kind: 'text', text: 'docs 共 3 条。' }],
      client,
      registry,
    });

    const result = await session.send('查 docs');
    expect(result.reply).toContain('3 条');
    expect(session.tasks()).toHaveLength(1);
    expect(worker.runs).toBe(1);
    expect(client.requests).toHaveLength(1);
    // 受理回执被回放：同一 taskId，且本回合只算一个任务。
    expect(result.taskIds).toHaveLength(1);
  });

  it('每次执行层请求都携带非空 dispatchKey，并与账行一致（契约面）', async () => {
    const client = new RecordingClient();
    const registry = createTaskRegistry();
    const { session } = await sessionFor({
      worker: [END, queryTool(), END, queryTool(), { kind: 'text', text: '完成。' }],
      main: [
        END,
        { kind: 'tool', tool: RUN_TASK_TOOL, args: { task: '查询' } },
        { kind: 'text', text: '完成。' },
      ],
      client,
      registry,
    });

    await session.send('查询');
    for (const request of client.requests) {
      expect(request.dispatchKey).toMatch(/^dk_/);
      const row = registry.getOperation(request.dispatchKey);
      expect(row).toBeDefined();
      expect(row?.operation).toBe(request.operation);
      expect(row?.status).toBe('completed');
    }
  });
});
