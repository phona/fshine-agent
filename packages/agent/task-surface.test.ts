/**
 * 缺口 1 · 对话面任务工具（task_status / task_result / task_cancel / task_resume）。
 *
 * 缺口本体：Main 工具面只有 task_run，用户在对话里问「那个任务怎么样了 / 取消它 / 接着办 /
 * 结果再发一遍」时模型无工具可查可动。本切片把既有 registry/runner 能力以**服务端身份授权**
 * 接到 Main 工具面——工具参数只收任务引用，scope 由宿主在 send() 闭包用运行时 principal/session
 * 构造、编号解析在 scope 内做（越权=找不到）；取消/接续如实转述。
 *
 * 判据（TDD：实现前红 → 接线后绿；全部假件，零网络/零模型）：
 *   · 工具面：有 runner 时暴露四工具；无 runner 时只读查询（task_status/task_result）仍暴露、
 *     治理工具（task_cancel/task_resume）不上面；Worker 工具面不含这四个工具；
 *   · task_status：空 ref 列本会话任务；#编号 查单个；无任务时返回空列表而非报错； *   · 越权=找不到：跨会话同编号不可见（同一底账内按 scope 隔离，不泄露存在性）；
 *     跨 principal 的列表查询返回空列表；
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
  it('工具面：有 runner 暴露 task_run + 四工具；无 runner 时只读查询仍注册、治理工具不注册', async () => {    const withRunner = await build([], { withRunner: true });
    await withRunner.session.send('随便说一句');
    const names = withRunner.turns[0]!.tools.map((tool) => tool.name);
    expect(names).toEqual(['task_run', 'task_status', 'task_result', 'task_cancel', 'task_resume', 'task_confirm']);

    const withoutRunner = await build([], { withRunner: false });
    await withoutRunner.session.send('随便说一句');
    expect(withoutRunner.turns[0]!.tools.map((tool) => tool.name))
      .toEqual(['task_run', 'task_status', 'task_result']);
  });

  it('无 runner 且无任务：task_status 空 ref 返回空列表而不是报错（只读查询不依赖 runner）', async () => {
    const { session, turns } = await build([{ tool: 'task_status', args: {} }], { withRunner: false });
    await session.send('现在有哪些任务');
    const listed = value<{ tasks: unknown[] }>(turns[0]!.results[0]!);
    expect(listed.tasks).toEqual([]);
  });

  it('跨 principal 查询隔离：无 runner 时 task_status 空 ref 对其它 principal 返回空列表', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');
    const b = await build([{ tool: 'task_status', args: {} }], { scope: SCOPE_B, registry, withRunner: false });
    await b.session.send('B 有哪些任务');
    const listed = value<{ tasks: unknown[] }>(b.turns[0]!.results[0]!);
    expect(listed.tasks).toEqual([]);  });

  it('task_status：空 ref 列本会话任务；taskId 返回状态与 pendingQuestion（投影不带任务编号）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 't1', '查 documents 窗口 W202611');
    registry.waitForUser('t1', { missing: ['窗口编号'] });
    seed(registry, SCOPE_A, 't2', '第二个任务');

    const { session, turns } = await build([{ tool: 'task_status', args: {} }], { registry });
    await session.send('我那两个任务怎么样了');
    const listed = value<{ tasks: Array<Record<string, unknown>> }>(turns[0]!.results[0]!);
    // 2026-11-20：任务编号不进模型投影——列表用不透明 taskId 指代（新→旧）。
    // 断言锚点从 taskNo 改成 taskId（原断言断的是"用户/模型可见面出现编号"，该行为已废）。
    expect(listed.tasks.map((task) => task.taskId)).toEqual(['t2', 't1']);
    for (const task of listed.tasks) expect(task).not.toHaveProperty('taskNo');

    const one = await build([{ tool: 'task_status', args: { ref: 't1' } }], { registry });
    await one.session.send('第一个任务在等什么');
    const hit = value<Record<string, unknown>>(one.turns[0]!.results[0]!);
    expect(hit.status).toBe('waiting_user');
    expect(hit.pendingQuestion).toEqual({ missing: ['窗口编号'] });
    expect(hit.name).toBe('查 documents 窗口 W202611');
    expect(hit).not.toHaveProperty('taskNo');
  });

  it('越权=找不到：同一底账内跨会话同编号不可见（不泄露存在性）', async () => {
    // 标题保留（docs/product/capability.md 锚点钉的是它）；2026-11-20 机制变化：数字/#编号
    // 引用整体退役，越权判据改由 taskId 承载。断言强度不放宽——A 的 taskId 对 B 仍是
    // TaskOwnershipError（同一个「找不到」形状）。
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');
    seed(registry, SCOPE_B, 'task-b', 'B 的任务');

    const b = await build([{ tool: 'task_status', args: { ref: 'task-a' } }], { scope: SCOPE_B, registry });
    await b.session.send('查 A 那个任务');
    const result = b.turns[0]!.results[0]!;
    expect(result.ok, 'A 的 taskId 对 B 必须表现为找不到').toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(TaskOwnershipError);
  });

  it('身份注入绊线：参数里塞 principalId/sessionId 被忽略，scope 恒取宿主', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');
    seed(registry, SCOPE_B, 'task-b', 'B 的任务');

    const b = await build(
      [{ tool: 'task_status', args: { ref: 'task-b', principalId: SCOPE_A.principalId, sessionId: SCOPE_A.sessionId } }],
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
    for (const name of ['task_status', 'task_result', 'task_cancel', 'task_resume', 'task_confirm']) {
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

    // 2026-11-20 机制变化：数字 ref 退役，按 taskId 引用（断言不变）。
    const { session, turns } = await build([
      { tool: 'task_result', args: { ref: 'done' } },
      { tool: 'task_result', args: { ref: 'live' } },
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

    // 2026-11-20 机制变化：数字 ref 退役，按 taskId 引用（断言不变）。
    const { session, turns, runner } = await build([
      { tool: 'task_cancel', args: { ref: 'run' } },
      { tool: 'task_cancel', args: { ref: 'queued' } },
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

    // 2026-11-20 机制变化：数字 ref 退役，按 taskId 引用（断言不变）。
    const { session, turns, runner } = await build([
      { tool: 'task_resume', args: { ref: 'wait', answer: 'W202611' } },
      { tool: 'task_resume', args: { ref: 'finished', answer: '随便答一句' } },
    ], { registry });
    await session.send('接着办');
    await runner!.whenIdle();

    const resumed = value<Record<string, unknown>>(turns[0]!.results[0]!);
    expect(resumed.outcome).toBe('started');

    const rejected = value<Record<string, unknown>>(turns[0]!.results[1]!);
    expect(rejected.outcome).toBe('not_waiting');
    expect(rejected.status).toBe('completed');
  });

  // 2026-11-20 live 缺陷 P1（机制变化）：数字 ref（#N / 裸数字）整体退役——编号不进模型
  // 可见面，模型只能凭空编数字 → 旧实现把它映射到「另一任务」，在 task_confirm/task_cancel
  // 上就是操作错对象。以下两例是**反向绊线**：数字引用必须被确定性拒绝并给可行动下一步，
  // 旧实现（数字命中任务）会让它们红。断言强度不放宽（拒绝面同样要求 taskId 才能命中）。
  it('数字 ref（#N / 裸数字）确定性拒绝并给可行动下一步，绝不映射到任何任务', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 't1', '查 documents 窗口 W202611');

    for (const ref of ['#1', '1', '999']) {
      const probe = await build([{ tool: 'task_status', args: { ref } }], { registry });
      await probe.session.send(`任务 ${ref} 怎么样了`);
      const result = probe.turns[0]!.results[0]!;
      expect(result.ok, `${ref} 必须被拒绝，不得映射到 t1`).toBe(false);
      if (!result.ok) {
        expect((result.error as Error).message).toContain('taskId');
      }
    }
    // 同一会话用真 taskId 仍能命中（拒绝只针对数字写法，不损害 taskId 通道）。
    const ok = await build([{ tool: 'task_status', args: { ref: 't1' } }], { registry });
    await ok.session.send('查 t1');
    expect(value<Record<string, unknown>>(ok.turns[0]!.results[0]!).taskId).toBe('t1');
  });

  it('写操作工具：数字 ref 被拒（零状态变更），不会误操作另一个任务', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'task-a', 'A 的任务');
    seed(registry, SCOPE_B, 'task-b', 'B 的任务');

    const b = await build([
      { tool: 'task_status', args: { ref: '1' } },
      { tool: 'task_cancel', args: { ref: '1' } },
      { tool: 'task_confirm', args: { ref: '1' } },
    ], { scope: SCOPE_B, registry });
    await b.session.send('用数字引用操作');
    for (const result of b.turns[0]!.results) {
      expect(result.ok, '数字引用一律拒绝').toBe(false);
      if (!result.ok) expect((result.error as Error).message).toContain('taskId');
    }
    // 两个任务都没被动过（尤其 B 的 task-b 没被误当作 #1 操作）。
    expect(registry.get('task-a', SCOPE_A).status).toBe('running');
    expect(registry.get('task-b', SCOPE_B).status).toBe('running');
  });

  it('P0-A：inline 受理回执含可引用 taskNo（与 background 回执格式一致）', async () => {
    // inline 模式（无 runner）下 task_run 直接走 delegate：回执必须带 taskNo，否则用户无编号可引用。
    const registry = createTaskRegistry();
    // 复用 toolingMain：调用 task_run，workerDriver 由宿主使用——用最简假件驱动 worker 汇报。
    // 这里只验证回执字段：让 workerDriver 返回一段非空文本即可（CompleteExecutor 不适用 inline）。
    const turns: RecordedTurn[] = [];
    const session = await createSession({
      principalId: SCOPE_A.principalId,
      sessionId: SCOPE_A.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: toolingMain([{ tool: 'task_run', args: { task: '查 documents 窗口 W202611' } }], turns),
      workerDriver: {
        async run() {
          return { text: '（测试 Worker 汇报）', messages: [] } as never;
        },
      },
      mainSystemPrompt: '（测试）',
      taskRegistry: registry,
      taskDispatch: 'sync',
      workerTurnMs: 60_000,
    });
    await session.send('帮我查一下');
    const receipt = value<Record<string, unknown>>(turns[0]!.results[0]!);
    // 2026-11-20：回执是模型可见投影，不带 taskNo；taskId 是唯一的无编号指代。
    expect(receipt).not.toHaveProperty('taskNo');
    expect(typeof receipt.taskId).toBe('string');
  });

  it('P0-A：取消后查询同一 taskId：状态如实为 cancelled（可查、不复活）', async () => {
    // 2026-11-20 机制变化：数字 ref 退役，按 taskId 取消与回查（断言不变）。
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 'q', '排队任务', 'queued');

    const { session, turns, runner } = await build([
      { tool: 'task_cancel', args: { ref: 'q' } },
      { tool: 'task_status', args: { ref: 'q' } },
    ], { registry });
    await session.send('取消然后查一下');
    await runner!.whenIdle();

    const cancelled = value<Record<string, unknown>>(turns[0]!.results[0]!);
    expect(cancelled.outcome).toBe('cancelled');
    const hit = value<Record<string, unknown>>(turns[0]!.results[1]!);
    expect(hit.status).toBe('cancelled');
  });

  it('未传 runner：task_cancel/task_resume/task_confirm 不上面，调用即 Main 工具面之外的调用（fail-closed）', async () => {
    const registry = createTaskRegistry();
    seed(registry, SCOPE_A, 't1', '任务');
    const { session, turns } = await build([
      { tool: 'task_cancel', args: { ref: 't1' } },
      { tool: 'task_resume', args: { ref: 't1', answer: '答复' } },
      { tool: 'task_confirm', args: { ref: 't1' } },
    ], { registry, withRunner: false });
    await session.send('取消并接续');

    // 工具面快照：治理工具（需要 runner）不注册；只读查询仍在。
    expect(turns[0]!.tools.map((tool) => tool.name)).toEqual(['task_run', 'task_status', 'task_result']);
    for (const [index, name] of ['task_cancel', 'task_resume', 'task_confirm'].entries()) {
      const result = turns[0]!.results[index]!;
      expect(result.ok, `${name} 无 runner 必须 fail-closed`).toBe(false);
      if (!result.ok) expect(String((result.error as Error).message)).toContain('Main 工具面之外的调用');
    }
  });

  it('Worker 工具面快照：每个 operation 一个 op_* 工具，不含 task_status/task_result/task_cancel/task_resume', async () => {
    const registry = createTaskRegistry();
    const turns: RecordedTurn[] = [];
    const workerTools: string[][] = [];
    const session = await createSession({
      principalId: SCOPE_A.principalId,
      sessionId: SCOPE_A.sessionId,
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: toolingMain([{ tool: 'task_run', args: { task: '查 documents 窗口 W202611' } }], turns),
      workerDriver: {
        async run(input) {
          workerTools.push(input.tools.map((tool) => tool.name));
          return { text: '（测试 Worker 汇报）', messages: [] } as never;
        },
      },
      mainSystemPrompt: '（测试）',
      taskRegistry: registry,
      taskDispatch: 'sync',
      workerTurnMs: 60_000,
    });
    await session.send('帮我查一下');

    // FaceClient 只声明 dummy.query 一个 operation → 恰好一个 op_* 工具，无通用 execute_operation。
    expect(workerTools).toEqual([['op_dummy_query']]);
    expect(workerTools.flat()).not.toContain('execute_operation');
    for (const name of ['task_status', 'task_result', 'task_cancel', 'task_resume']) {
      expect(workerTools.flat()).not.toContain(name);
    }
  });
});
