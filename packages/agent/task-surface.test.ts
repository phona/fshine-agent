/**
 * 缺口 1 · 对话面任务工具（task_status / task_result / task_cancel / task_resume）。
 *
 * 缺口本体：Main 工具面只有 run_task，用户在对话里问「那个任务怎么样了 / 取消它 / 接着办 /
 * 结果再发一遍」时模型无工具可查可动。本切片把既有 registry/runner 能力以**服务端身份授权**
 * 接到 Main 工具面——工具参数只收任务引用，scope 由宿主在 send() 闭包用运行时 principal/session
 * 构造、编号解析在 scope 内做（越权=找不到）；取消/接续如实转述。
 *
 * 判据（TDD：实现前红 → 接线后绿；全部假件，零网络/零模型）：
 *   · 工具面：有 runner 时暴露四工具；无 runner 时只 run_task（面收窄，ask 单发零变化）；
 *   · task_status：空 ref 列本会话任务；#编号 查单个；
 *   · 越权=找不到：跨会话同编号不可见（同一底账内按 scope 隔离，不泄露存在性）；
 *   · 身份注入绊线：参数里塞 principalId/sessionId 被忽略，scope 恒取宿主；
 *   · task_result：completed 返回逐字存档；非终态返回状态本身、不编造结果；
 *   · task_cancel：running → requested（cancelling≠cancelled）；queued → cancelled（机械确认）；
 *   · task_resume：waiting_user 带 answer → started；非 waiting_user → not_waiting（如实转述）；
 *   · 未传 runner：调用治理工具 → 「Main 工具面之外的调用」（fail-closed）。
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DiscoveredTool } from '@fshine/contracts';
import type { TurnDriver } from './src/driver-contract';
import { createSession, type Session } from './src/execution-runtime';
import { TaskOwnershipError, createTaskRegistry, type TaskRegistry, type TaskScope } from './src/task-registry';
import {
  createTaskRunner,
  type TaskExecutionOutcome,
  type TaskExecutor,
  type TaskRunner,
} from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';

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

function unreachableDriver(): TurnDriver {
  return {
    async run() {
      throw new Error('（测试）该 driver 不应被调用');
    },
  };
}

/** 假后台执行器：立即完成，零网络。 */
class CompletedExecutor implements TaskExecutor {
  async execute(): Promise<TaskExecutionOutcome> {
    return { kind: 'completed', resultText: '（测试执行结果）' };
  }
}

type ExecResult = { ok: true; value: unknown } | { ok: false; error: unknown };
interface ToolCall { tool: string; args: Record<string, unknown> }
interface RecordedTurn { tools: readonly DiscoveredTool[]; results: ExecResult[] }

/** 假 Main 驱动：按脚本逐一调用工具并记录每次 exec 的返回或抛错（零模型）。 */
function toolingMain(calls: readonly ToolCall[], turns: RecordedTurn[]): TurnDriver {
  return {
    async run(input) {
      const results: ExecResult[] = [];
      for (const call of calls) {
        try {
          results.push({ ok: true, value: await input.exec(call.tool, call.args) });
        } catch (error) {
          results.push({ ok: false, error });
        }
      }
      turns.push({ tools: input.tools, results });
      return { text: '（测试回合回复）', messages: [...input.messages] };
    },
  };
}

const SCOPE_A: TaskScope = { principalId: 'wecom:user-a', sessionId: 'conv-a' };
const SCOPE_B: TaskScope = { principalId: 'wecom:user-b', sessionId: 'conv-b' };

async function build(calls: readonly ToolCall[], options: {
  scope?: TaskScope;
  withRunner?: boolean;
  registry?: TaskRegistry;
} = {}): Promise<{ session: Session; registry: TaskRegistry; runner?: TaskRunner; turns: RecordedTurn[] }> {
  const scope = options.scope ?? SCOPE_A;
  const registry = options.registry ?? createTaskRegistry();
  const withRunner = options.withRunner ?? true;
  const runner = withRunner
    ? createTaskRunner({ registry, policy: createResourcePolicy(), executor: new CompletedExecutor() })
    : undefined;
  const turns: RecordedTurn[] = [];
  const session = await createSession({
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: toolingMain(calls, turns),
    workerDriver: unreachableDriver(),
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: registry,
    ...(runner === undefined ? {} : { taskRunner: runner }),
  });
  return { session, registry, runner, turns };
}

/** 直接落一条底账任务（不经模型），用于构造确定状态。 */
function seed(registry: TaskRegistry, scope: TaskScope, taskId: string, request: string, status?: 'queued' | 'running') {
  return registry.begin({ taskId, principalId: scope.principalId, sessionId: scope.sessionId, request, ...(status === undefined ? {} : { status }) });
}

function value<T = Record<string, unknown>>(result: ExecResult): T {
  if (!result.ok) throw result.error;
  return result.value as T;
}

describe('缺口 1 · 对话面任务工具', () => {
  it('工具面：有 runner 暴露 run_task + 四工具；无 runner 只 run_task（面收窄）', async () => {
    const withRunner = await build([], { withRunner: true });
    await withRunner.session.send('随便说一句');
    const names = withRunner.turns[0]!.tools.map((tool) => tool.name);
    expect(names).toEqual(['run_task', 'task_status', 'task_result', 'task_cancel', 'task_resume']);

    const withoutRunner = await build([], { withRunner: false });
    await withoutRunner.session.send('随便说一句');
    expect(withoutRunner.turns[0]!.tools.map((tool) => tool.name)).toEqual(['run_task']);
  });

  it('task_status：空 ref 列本会话任务；#编号 返回状态与 pendingQuestion', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 't1', '查 documents 窗口 W202611');
    registry.waitForUser('t1', { missing: ['窗口编号'] });
    seed(registry, SCOPE_A, 't2', '第二个任务');

    const { session, turns } = await build([{ tool: 'task_status', args: {} }], { registry });
    await session.send('我那两个任务怎么样了');
    const listed = value<{ tasks: Array<Record<string, unknown>> }>(turns[0]!.results[0]!);
    expect(listed.tasks.map((task) => task.taskNo)).toEqual([1, 2]);

    const one = await build([{ tool: 'task_status', args: { ref: '#1' } }], { registry });
    await one.session.send('第一个任务在等什么');
    const hit = value<Record<string, unknown>>(one.turns[0]!.results[0]!);
    expect(hit.status).toBe('waiting_user');
    expect(hit.pendingQuestion).toEqual({ missing: ['窗口编号'] });
    expect(hit.name).toBe('查 documents 窗口 W202611');
  });

  it('越权=找不到：同一底账内跨会话同编号不可见（不泄露存在性）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');          // A：#1
    seed(registry, SCOPE_B, 'task-b', 'B 的任务');          // B：#2

    const b = await build([{ tool: 'task_status', args: { ref: '#1' } }], { scope: SCOPE_B, registry });
    await b.session.send('查 #1');
    const result = b.turns[0]!.results[0]!;
    expect(result.ok, 'A 的 #1 对 B 必须表现为找不到').toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(TaskOwnershipError);
  });

  it('身份注入绊线：参数里塞 principalId/sessionId 被忽略，scope 恒取宿主', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');          // A：#1
    seed(registry, SCOPE_B, 'task-b', 'B 的任务');          // B：#2

    const b = await build(
      [{ tool: 'task_status', args: { ref: '#2', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId } }],
      { scope: SCOPE_B, registry },
    );
    await b.session.send('伪造身份试试');
    const hit = value<Record<string, unknown>>(b.turns[0]!.results[0]!);
    expect(hit.taskId, 'scope 必须取宿主会话，不接受参数里的身份').toBe('task-b');
    expect(hit.name).toBe('B 的任务');
  });

  it('任务工具的 schema 只收任务引用：无身份字段、additionalProperties=false', async () => {
    const { session, turns } = await build([]);
    await session.send('看看工具');
    const byName = new Map(turns[0]!.tools.map((tool) => [tool.name, tool.inputSchema as Record<string, unknown>]));
    for (const name of ['task_status', 'task_result', 'task_cancel', 'task_resume']) {
      const schema = byName.get(name);
      expect(schema, `${name} 必须暴露`).toBeDefined();
      expect(schema!.additionalProperties).toBe(false);
      const properties = schema!.properties as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain('principalId');
      expect(Object.keys(properties)).not.toContain('sessionId');
    }
  });

  it('task_result：completed 返回逐字存档；非终态返回状态本身不构造结果', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'done', '已完成任务');
    registry.noteExecution('done', { requestId: 'req_1', operation: 'dummy.query', status: 'completed' });
    registry.complete('done', 'W202611：documents 共 3 条。');
    seed(registry, SCOPE_A, 'live', '进行中任务');

    const { session, turns } = await build([
      { tool: 'task_result', args: { ref: '#1' } },
      { tool: 'task_result', args: { ref: '#2' } },
    ], { registry });
    await session.send('把结果再发我一遍');

    const done = value<Record<string, unknown>>(turns[0]!.results[0]!);
    expect(done.status).toBe('completed');
    expect(done.resultText).toBe('W202611：documents 共 3 条。');
    expect((done.executions as Array<Record<string, unknown>>)[0]!.operation).toBe('dummy.query');

    const live = value<Record<string, unknown>>(turns[0]!.results[1]!);
    expect(live.status).toBe('running');
    expect(live.resultText, '未完成任务不得编造结果').toBeNull();
  });

  it('task_cancel：running → requested（cancelling≠cancelled）；queued → cancelled（机械确认）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'run', '在飞任务', 'running');
    seed(registry, SCOPE_A, 'queued', '排队任务', 'queued');

    const { session, turns, runner } = await build([
      { tool: 'task_cancel', args: { ref: '#1' } },
      { tool: 'task_cancel', args: { ref: '#2' } },
    ], { registry });
    await session.send('取消这两个任务');
    await runner!.whenIdle();

    const requested = value<Record<string, unknown>>(turns[0]!.results[0]!);
    expect(requested.outcome, '在飞任务只发取消请求，不宣称已取消').toBe('requested');
    expect(registry.get('run', SCOPE_A).status, '取消请求后是 cancelling 而非 cancelled').toBe('cancelling');

    const confirmed = value<Record<string, unknown>>(turns[0]!.results[1]!);
    expect(confirmed.outcome, '未启动的排队任务可机械确认取消').toBe('cancelled');
    expect(registry.get('queued', SCOPE_A).status).toBe('cancelled');
  });

  it('task_resume：waiting_user 带 answer → started；非 waiting_user → not_waiting（如实转述）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'wait', '等待任务', 'running');
    registry.waitForUser('wait', { missing: ['窗口编号'] });
    seed(registry, SCOPE_A, 'finished', '已完成任务');
    registry.noteExecution('finished', { requestId: 'req_x', operation: 'dummy.query', status: 'completed' });
    registry.complete('finished', '结果');

    const { session, turns, runner } = await build([
      { tool: 'task_resume', args: { ref: '#1', answer: 'W202611' } },
      { tool: 'task_resume', args: { ref: '#2', answer: '随便答一句' } },
    ], { registry });
    await session.send('接着办');
    await runner!.whenIdle();

    const resumed = value<Record<string, unknown>>(turns[0]!.results[0]!);
    expect(resumed.outcome).toBe('started');

    const rejected = value<Record<string, unknown>>(turns[0]!.results[1]!);
    expect(rejected.outcome).toBe('not_waiting');
    expect(rejected.status).toBe('completed');
  });

  it('未传 runner：治理工具不上面，调用治理工具名 → Main 工具面之外的调用（fail-closed）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 't1', '任务');
    const { session, turns } = await build([{ tool: 'task_cancel', args: { ref: '#1' } }], { registry, withRunner: false });
    await session.send('取消');
    const result = turns[0]!.results[0]!;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String((result.error as Error).message)).toContain('Main 工具面之外的调用');
  });
});
