/**
 * 「同回合先失败、后成功的写」终局判定（2026-11-19 owner 修法；真模型写闭环实跑缺陷）。
 *
 * 缺陷（真模型实跑 5 次复现 2 次，非罕见形状）：确认回合里 Worker 先发一次参数不匹配的
 * commit（失败，如 INVALID_RECORDS），再发一次改对参数的 commit（成功、句柄被消耗、数据
 * 真的落库）——终局仍被判 failed，failure_reason 引用那次**失败的** commit，result_text=null；
 * 用户先看到模型说「已经办好了…4 条都在」，随后又收到「没办成…再试一次」→ 照做就重复写。
 *
 * 判据（owner 修法）：**终局以最后一次决定性结果为准**——
 *   · 写操作（后台路径知道只读集合）：以最后一条**非只读**执行为准。之前那次的失败逐条保留在
 *     executions 里（审计可查），但不作为终局 status/failure_reason；
 *   · 纯只读回合 / inline 判定（拿不到只读集合）：以最后一条执行为准；
 *   · 末条仍是失败（此后没有成功的写；后面紧接着一条成功的**只读**不算）→ 照旧 failed（不放宽）；
 *   · result_unknown 语义不动（不许被吞成永远成功）。
 *
 * 用例：① 主形状；② 反向（失败后只有成功的只读 → 仍 failed）；③ result_unknown 不被吞；
 * ④ inline 同形状（judgeReportedTask 与底账 complete 两条）；⑤ A2b 锁不挡「参数改对的合法重试」
 * （执行层显式 retryable:true），确定性失败（retryable:false）仍挡；⑥ 同回合「提案 + 之后成功写」
 * 不得停在等你确认。
 *
 * 反向绊线：把后台终局判定改回「取第一个非 completed」→ ① 必红（读数见本分支报告）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createTaskExecutor, EXECUTE_OPERATION_TOOL, type ExecutionEvent } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { createTaskRegistry, judgeReportedTask, type TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutor, type TaskRunner } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';
import { createNotificationOutbox } from './src/notifications';
import { renderNotification } from './src/notification-render';
import { attachNotificationOutbox } from '../../scripts/ask-runtime';

const SCOPE = { principalId: 'wecom:last-attempt', sessionId: 'conv-last-attempt' };
const TASK_ID = 't_last_attempt';

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.prepare', label: 'prepare', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }] },
  ],
};

const SUMMARY = '将向集合「empty-one」的 W1 窗口新增记录：共 4 条：item-1=100…';
const EXPIRES_AT = '2035-01-01T00:00:00.000Z';
const PREPARE_ARGS = { operation: 'dummy.prepare', args: { '--collection': 'empty-one' } };
/** 参数形态错的那次提交（--records 写成字符串；仓内 dummy 夹具实测同形）。 */
const COMMIT_BAD_ARGS = {
  operation: 'dummy.commit',
  args: { '--collection': 'empty-one', '--records': 'item-1=100,item-2=100' },
};
/** 改对参数的那次提交（结构化数组）。 */
const COMMIT_GOOD_ARGS = {
  operation: 'dummy.commit',
  args: { '--collection': 'empty-one', '--records': [{ name: 'item-1', value: 100 }] },
};
/** 末条 = 结果未知（执行层无法确认，不许当成功）。 */
const COMMIT_UNKNOWN_ARGS = {
  operation: 'dummy.commit',
  args: { '--collection': 'empty-one', '--unknown': true },
};
/** 确定性拒绝（retryable:false；A2b 锁的反向对照）。 */
const COMMIT_DENIED_ARGS = {
  operation: 'dummy.commit',
  args: { '--collection': 'empty-one', '--deny': true },
};
const QUERY_ARGS = { operation: 'dummy.query', args: { '--collection': 'empty-one' } };
/** 成功后同对象的重复提案（参数写错 → failed，retryable:true）。 */
const PREPARE_REPEAT_FAILED_ARGS = {
  operation: 'dummy.prepare',
  args: { '--collection': 'empty-one', '--records': 'item-1=100' },
};
/** 成功后只读核对查询失败（**打另一个对象**：这样只有「只读失败不翻转」这条判据能救它，
 *  「同对象＝重复尝试」不会替它掩盖；反向绊线据此对得准）。 */
const QUERY_FAILED_ARGS = {
  operation: 'dummy.query',
  args: { '--collection': 'gamma', '--fail': true },
};
/** 成功后另一个写：不同对象（beta）。 */
const COMMIT_OTHER_OBJECT_ARGS = {
  operation: 'dummy.commit',
  args: { '--collection': 'beta', '--records': [{ name: 'x', value: 1 }] },
};

const WORKER_COMPLETED_TEXT = '已经办好了：empty-one 的 W1 窗口里 4 条记录都在。';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'write-last-attempt-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

/**
 * 执行层语义镜像（仓内 dummy 夹具 `runtime/errors.cjs` 同形）：
 *   · prepare → needs_confirmation（句柄；宿主透传、一次性归执行层）；
 *   · prepare（--records 是字符串）→ failed INVALID_RECORDS retryable:true（重复提案/参数写错）；
 *   · commit（--records 是字符串）→ failed INVALID_RECORDS **retryable:true**——
 *     参数形态错不是「这个对象不可用」，执行层显式允许同回合改对再试一次（A2b 锁因此不挡）；
 *   · commit（--records 结构化数组）→ completed（真的写进去了）；
 *   · commit（--unknown）→ failed result_unknown（执行层无法确认）；
 *   · commit（--deny）→ refused GATE_REFUSE retryable:false（确定性拒绝，A2b 锁要挡）；
 *   · commit（--collection beta）→ failed COLLECTION_LOCKED retryable:false（另一个对象/另一个写）；
 *   · query → completed（只读）；query（--fail）→ failed READ_FAILED（只读失败）。
 */
class LastAttemptClient implements ExecutionClient {
  readonly requests: Array<{ operation: string; args: Record<string, unknown>; confirmation?: unknown }> = [];
  constructor(private readonly handle = 'cf_last_attempt') {}
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push({
      operation: request.operation,
      args: request.args,
      ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
    });
    if (request.operation === 'dummy.prepare') {
      if (typeof request.args['--records'] === 'string') {
        return {
          status: 'failed',
          error: {
            code: 'INVALID_RECORDS',
            message: '--records 必须是结构化数组（每项 {name, value}），不要传 JSON 字符串。',
            retryable: true,
          },
        };
      }
      return {
        status: 'needs_confirmation',
        confirmation: { handle: this.handle, summary: SUMMARY, expiresAt: EXPIRES_AT },
        data: { collection: 'empty-one' },
      };
    }
    if (request.operation === 'dummy.query') {
      return request.args['--fail'] === true
        ? { status: 'failed', error: { code: 'READ_FAILED', message: '核对查询失败。', retryable: false } }
        : { status: 'completed', data: { count: 4 } };
    }
    if (request.args['--unknown'] === true) {
      return {
        status: 'failed',
        error: { code: 'result_unknown', message: '结果待核对：无法确认这次操作是否已经发生。', retryable: false },
      };
    }
    if (request.args['--deny'] === true) {
      return { status: 'refused', error: { code: 'GATE_REFUSE', message: 'empty-one 集合被策略拒绝。', retryable: false } };
    }
    if (request.args['--collection'] === 'beta') {
      return { status: 'failed', error: { code: 'COLLECTION_LOCKED', message: 'beta 集合被锁定。', retryable: false } };
    }
    const records = request.args['--records'];
    if (typeof records === 'string') {
      return {
        status: 'failed',
        error: {
          code: 'INVALID_RECORDS',
          message: '--records 必须是结构化数组（每项 {name, value}），不要传 JSON 字符串。',
          retryable: true,
        },
      };
    }
    return { status: 'completed', data: { added: 4 } };
  }
}

interface WorkerCapture {
  /** 每次 exec 的返回值（被宿主挡下/抛错的位置 undefined）。 */
  results: unknown[];
  /** 每次 exec 的抛错原文（成功位置 undefined）。 */
  errors: Array<string | undefined>;
}

/** 多轮脚本化 Worker：每轮消费一组工具调用 + 一句汇报（工具错误被捕获后继续，回合不中断）。 */
function scriptedWorker(
  rounds: ReadonlyArray<{ calls: ReadonlyArray<Record<string, unknown>>; text: string }>,
  capture: WorkerCapture = { results: [], errors: [] },
): TurnDriver {
  const remaining = rounds.map((round) => ({ calls: [...round.calls], text: round.text }));
  return {
    async run(input) {
      const round = remaining.shift() ?? { calls: [], text: '（无更多脚本回合）' };
      for (const args of round.calls) {
        try {
          capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
          capture.errors.push(undefined);
        } catch (error) {
          capture.errors.push(error instanceof Error ? error.message : String(error));
          capture.results.push(undefined);
        }
      }
      return { text: round.text, messages: [] as unknown as DriverMessage[] };
    },
  };
}

function makeExecutor(input: {
  client: ExecutionClient;
  registry: TaskRegistry;
  worker: TurnDriver;
  onEvent?: (event: ExecutionEvent) => void;
}): Promise<TaskExecutor> {
  return createTaskExecutor({
    client: input.client,
    allowedOperations: ['dummy.prepare', 'dummy.commit', 'dummy.query'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: input.worker,
    registry: input.registry,
    workerTurnMs: 30_000,
    ...(input.onEvent === undefined ? {} : { onExecutionEvent: input.onEvent }),
  });
}

/** 受理 + 跑完一轮（后台任务不阻塞调用方；whenIdle 供测试收口）。 */
async function runBackground(
  registry: TaskRegistry,
  executor: TaskExecutor,
  taskId: string,
  request = '在 empty-one 集合的 W1 窗口新增 4 条记录（item-1..item-4，value 都是 100）。',
): Promise<TaskRunner> {
  const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
  runner.submit({ taskId, principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request });
  runner.pump();
  await runner.whenIdle();
  return runner;
}

/** 取某类事件（typed 窄化，避免在 union 上直接索引字段）。 */
function eventsNamed<K extends ExecutionEvent['event']>(
  events: readonly ExecutionEvent[],
  name: K,
): Array<Extract<ExecutionEvent, { event: K }>> {
  return events.filter((event) => event.event === name) as Array<Extract<ExecutionEvent, { event: K }>>;
}

describe('终局以最后一次决定性结果为准（先失败、后成功的写）', () => {
  it('① 主形状：确认回合 commit 失败（参数错）→ 改对成功 → 终局 completed、正文取成功那次、失败那次保留在 executions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-last-attempt-notify-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    const outbox = createNotificationOutbox({ dbPath, sink: { send: async () => ({ delivered: true }) } });
    attachNotificationOutbox(registry, outbox);
    const client = new LastAttemptClient('cf_last_1');
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptedWorker([
        { calls: [PREPARE_ARGS], text: '已生成待确认的写入方案，等你确认。' },
        { calls: [COMMIT_BAD_ARGS, COMMIT_GOOD_ARGS, QUERY_ARGS], text: WORKER_COMPLETED_TEXT },
      ]),
    });
    const runner = await runBackground(registry, executor, TASK_ID);
    expect(registry.get(TASK_ID, SCOPE).status).toBe('waiting_user');

    // 用户「确认」→ 确认回合：先失败、后成功的写。
    const confirmed = runner.confirm(TASK_ID, { userText: '确认', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    const task = registry.get(TASK_ID, SCOPE);
    // 终局 = completed；结果正文 = 成功那次的 Worker 汇报（逐字），没有失败原因。
    expect(task.status).toBe('completed');
    expect(task.replyText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason).toBeUndefined();
    // 两次 commit 都留在底账（失败那次不许被抹掉），顺序可查。
    const commits = task.executions.filter((execution) => execution.operation === 'dummy.commit');
    expect(commits.map((execution) => execution.status)).toEqual(['failed', 'completed']);
    expect(commits[0]!.error?.code).toBe('INVALID_RECORDS');
    // 用户可见面：没有「没办成」类失败通知（也没有引导重试的话术），有完成通知。
    // （waiting_user 那条的文案渲染不在本用例面内；它的 payload/summary 由
    //  background-write-confirmation.test.ts ⑤ 钉住。）
    const visible = outbox
      .listNotifications(TASK_ID)
      .filter((row) => row.kind !== 'waiting_user')
      .map((row) => renderNotification({ kind: row.kind, payload: row.payload }));
    expect(visible.some((text) => text.includes('没办成'))).toBe(false);
    expect(visible.some((text) => text.includes('再试'))).toBe(false);
    expect(visible.some((text) => text.includes('办完了'))).toBe(true);
  });

  it('② 反向：同回合 commit 失败后没有成功的写（后面只有一条成功的只读）→ 仍判 failed', async () => {
    const registry = makeRegistry();
    const client = new LastAttemptClient('cf_last_reverse');
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptedWorker([
        { calls: [PREPARE_ARGS], text: '已生成待确认的写入方案，等你确认。' },
        { calls: [COMMIT_BAD_ARGS, QUERY_ARGS], text: '这次没能写进去。' },
      ]),
    });
    const runner = await runBackground(registry, executor, TASK_ID);
    const confirmed = runner.confirm(TASK_ID, { userText: '确认', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    const task = registry.get(TASK_ID, SCOPE);
    // 末次决定性结果（最后一条非只读执行）= 那次失败的 commit → failed，原因引用它。
    expect(task.status).toBe('failed');
    expect(task.reason).toBe('failed_confirmed');
    expect(task.failureReason).toContain('dummy.commit');
    expect(task.failureReason).toContain('--records 必须是结构化数组');
    // 后面那条成功的只读不掩盖失败的写（不是「只要有一次成功就算成功」的万金油）。
    // 底账跨回合累积：末两条 = 确认回合的事实（前一条 prepare 是首回合的提案）。
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:failed',
      'dummy.query:completed',
    ]);
    expect(task.resultText).toBeUndefined();
  });

  it('③ 不被吞：末条是 result_unknown → 仍按结果未知处理（不许变成 completed）', async () => {
    const registry = makeRegistry();
    const client = new LastAttemptClient('cf_last_unknown');
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptedWorker([
        { calls: [COMMIT_GOOD_ARGS, COMMIT_UNKNOWN_ARGS], text: '最后一次提交的结果我不确定。' },
      ]),
    });
    await runBackground(registry, executor, TASK_ID);

    const task = registry.get(TASK_ID, SCOPE);
    // 前一条 commit 成功也不许把「结果未知」的末条吞成成功：任务仍是未确认的结局。
    expect(task.status).toBe('failed');
    expect(task.reason).toBe('result_unknown');
    expect(task.executions.map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:completed',
      'dummy.commit:failed',
    ]);
    expect(task.resultText).toBeUndefined();
  });

  it('④ inline 同形状：判定与底账 complete 都以末条执行事实为准（前序失败保留）', () => {
    const failedCommit = {
      operation: 'dummy.commit',
      status: 'failed' as const,
      error: { code: 'INVALID_RECORDS', message: '--records 必须是结构化数组。', retryable: true },
    };
    // 判定函数：末条 completed → completed（前序失败不改写终局）。
    expect(judgeReportedTask([failedCommit, { operation: 'dummy.commit', status: 'completed' }]))
      .toEqual({ status: 'completed' });
    // 末条仍是失败 → 照旧 failed，原因取末条原文。
    expect(judgeReportedTask([
      { operation: 'dummy.commit', status: 'completed' },
      { operation: 'dummy.commit', status: 'failed', error: { code: 'TIMEOUT', message: '第二次超时。' } },
    ]).failureReason).toContain('第二次超时');
    // 零执行与单条语义不变。
    expect(judgeReportedTask([]).status).toBe('unexecuted');

    // 底账 inline complete 走同一判定：终态 completed、结果正文存档、两次执行都在。
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't_inline', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '写入 empty-one' });
    registry.noteExecution('t_inline', { requestId: 'req_inline_1', ...failedCommit });
    registry.noteExecution('t_inline', { requestId: 'req_inline_2', operation: 'dummy.commit', status: 'completed' });
    registry.complete('t_inline', WORKER_COMPLETED_TEXT);
    const task = registry.get('t_inline', SCOPE);
    expect(task.status).toBe('completed');
    expect(task.resultText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason ?? undefined).toBeUndefined();
    expect(task.executions.map((execution) => execution.status)).toEqual(['failed', 'completed']);
  });

  it('⑤ A2b 锁：参数改对的合法重试不被挡（执行层显式 retryable:true）；确定性失败仍挡', async () => {
    // (a) 参数形态错（INVALID_RECORDS retryable:true）→ 改对的第二次真的打到执行层。
    //     锁的纪律是「执行层没有显式说可重试 → 不重撞」（deterministic-retry-lock.ts）；
    //     执行层显式声明 retryable:true 时放行并留 execution_retry_allowed 事实。
    const allowRegistry = makeRegistry();
    const allowEvents: ExecutionEvent[] = [];
    const allowClient = new LastAttemptClient('cf_lock_allow');
    const allowExecutor = await makeExecutor({
      client: allowClient,
      registry: allowRegistry,
      worker: scriptedWorker([{ calls: [COMMIT_BAD_ARGS, COMMIT_GOOD_ARGS], text: WORKER_COMPLETED_TEXT }]),
      onEvent: (event) => allowEvents.push(event),
    });
    await runBackground(allowRegistry, allowExecutor, 't_lock_allow');

    expect(allowClient.requests.filter((request) => request.operation === 'dummy.commit')).toHaveLength(2);
    expect(eventsNamed(allowEvents, 'execution_retry_blocked')).toEqual([]);
    expect(eventsNamed(allowEvents, 'execution_retry_allowed').map((event) => event.code)).toEqual(['INVALID_RECORDS']);
    expect(allowRegistry.get('t_lock_allow', SCOPE).status).toBe('completed');

    // (b) 反向对照：确定性拒绝（retryable:false）→ 同对象第二次在发起前被挡，不重撞执行层。
    const denyRegistry = makeRegistry();
    const denyEvents: ExecutionEvent[] = [];
    const denyClient = new LastAttemptClient('cf_lock_deny');
    const denyExecutor = await makeExecutor({
      client: denyClient,
      registry: denyRegistry,
      worker: scriptedWorker([{ calls: [COMMIT_DENIED_ARGS, COMMIT_GOOD_ARGS], text: '没办成。' }]),
      onEvent: (event) => denyEvents.push(event),
    });
    await runBackground(denyRegistry, denyExecutor, 't_lock_deny');

    expect(denyClient.requests.filter((request) => request.operation === 'dummy.commit')).toHaveLength(1);
    expect(eventsNamed(denyEvents, 'execution_retry_blocked').map((event) => event.code)).toEqual(['GATE_REFUSE']);
    expect(denyRegistry.get('t_lock_deny', SCOPE).status).toBe('failed');
  });

  it('⑥ 同回合「提案 + 之后成功写」：末次决定性结果是成功 → completed（不得停在等你确认）', async () => {
    const registry = makeRegistry();
    const client = new LastAttemptClient('cf_proposal_then_write');
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptedWorker([
        { calls: [PREPARE_ARGS], text: '已生成待确认的写入方案，等你确认。' },
        // 确认回合：Worker 又 prepare 了一次（带回执句柄），随后 commit 成功——写已经发生。
        { calls: [PREPARE_ARGS, COMMIT_GOOD_ARGS], text: WORKER_COMPLETED_TEXT },
      ]),
    });
    const runner = await runBackground(registry, executor, TASK_ID);
    const confirmed = runner.confirm(TASK_ID, { userText: '确认', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();

    const task = registry.get(TASK_ID, SCOPE);
    expect(task.status).toBe('completed');
    expect(task.replyText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason).toBeUndefined();
  });
});

/**
 * 成功后出现的失败：按**机械判据**归类（2026-11-19 owner 第二轮；证据 = 真跑 wl-after-34）。
 *   · 只读失败（核对用的查询）→ 不算失败；
 *   · **同对象**（A2b 对象抽取 --collection/--topic）的写失败 = 重复提案/重复提交被安全挡下 →
 *     不算失败（终局 completed，失败事实仍逐条留在 executions）；
 *   · 异对象 / 取不到对象（无法证明同一个）的写失败 = **另一个写没成** → 部分完成：终态仍是既有
 *     `failed`（不新增状态），failure_reason 逐项写「已完成什么、未成功什么」；
 *   · 成功之前有失败、之后再没成功 → 仍 failed（上一轮语义不回归）。
 * 每条用例的对应反向绊线读数见本分支报告（把对应判据改回「任何失败都翻转」→ ⑦/⑧ 必红；
 * 把「异对象写失败」也当重复 → ⑨ 必红）。
 */
describe('成功后出现的失败：只读 / 同对象重复 / 另一个写（部分完成）', () => {
  /** 确认流程：首回合提案 → 确认回合跑给定调用（返回终态任务行）。 */
  async function confirmRound(input: {
    client: ExecutionClient;
    calls: ReadonlyArray<Record<string, unknown>>;
    text?: string;
  }): Promise<ReturnType<TaskRegistry['get']>> {
    const registry = makeRegistry();
    const executor = await makeExecutor({
      client: input.client,
      registry,
      worker: scriptedWorker([
        { calls: [PREPARE_ARGS], text: '已生成待确认的写入方案，等你确认。' },
        { calls: [...input.calls], text: input.text ?? WORKER_COMPLETED_TEXT },
      ]),
    });
    const runner = await runBackground(registry, executor, TASK_ID);
    expect(registry.get(TASK_ID, SCOPE).status).toBe('waiting_user');
    const confirmed = runner.confirm(TASK_ID, { userText: '确认', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();
    return registry.get(TASK_ID, SCOPE);
  }

  it('⑦ 成功后同对象 prepare 失败（重复提案被挡）→ completed；失败那次仍留在 executions', async () => {
    const client = new LastAttemptClient('cf_after_same_object');
    const task = await confirmRound({ client, calls: [COMMIT_GOOD_ARGS, PREPARE_REPEAT_FAILED_ARGS] });

    expect(task.status).toBe('completed');
    expect(task.replyText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason).toBeUndefined();
    // 重复尝试真的发生过（不是宿主预先拦掉），且逐条留账。
    expect(client.requests.map((request) => request.operation)).toEqual([
      'dummy.prepare',
      'dummy.commit',
      'dummy.prepare',
    ]);
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:completed',
      'dummy.prepare:failed',
    ]);
  });

  it('⑧ 成功后只读核对查询失败 → completed（只读失败不翻转）', async () => {
    const client = new LastAttemptClient('cf_after_read_fail');
    const task = await confirmRound({ client, calls: [COMMIT_GOOD_ARGS, QUERY_FAILED_ARGS] });

    expect(task.status).toBe('completed');
    expect(task.replyText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason).toBeUndefined();
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:completed',
      'dummy.query:failed',
    ]);
  });

  it('⑨ 成功后另一个写失败（不同对象）→ 部分完成：终态 failed，reason 逐项写清哪件成、哪件没成', async () => {
    const client = new LastAttemptClient('cf_after_other_write');
    const task = await confirmRound({
      client,
      calls: [COMMIT_GOOD_ARGS, COMMIT_OTHER_OBJECT_ARGS],
      text: 'empty-one 那笔写好了，beta 那笔没成。',
    });

    // 不新增状态：部分完成的终态仍是既有 failed（原因文本承载逐项事实）。
    expect(task.status).toBe('failed');
    expect(task.reason).toBe('failed_confirmed');
    expect(task.failureReason).toContain('没有全部办成');
    expect(task.failureReason).toContain('已完成 dummy.commit（empty-one）');
    expect(task.failureReason).toContain('未成功 dummy.commit（beta） 返回 failed');
    expect(task.failureReason).toContain('beta 集合被锁定');
    // 逐项文本收尾干净（执行层原文的句末句号不重复叠加）。
    expect(task.failureReason?.endsWith('。')).toBe(true);
    expect(task.failureReason).not.toContain('。。');
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:completed',
      'dummy.commit:failed',
    ]);
    expect(task.resultText).toBeUndefined();
  });

  it('⑩ 先失败后成功（prepare 失败 → commit 成功）→ completed（上一轮修复不回归）', async () => {
    const client = new LastAttemptClient('cf_before_success');
    const task = await confirmRound({ client, calls: [PREPARE_REPEAT_FAILED_ARGS, COMMIT_GOOD_ARGS] });

    expect(task.status).toBe('completed');
    expect(task.replyText).toBe(WORKER_COMPLETED_TEXT);
    expect(task.failureReason).toBeUndefined();
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.prepare:failed',
      'dummy.commit:completed',
    ]);
  });

  it('⑪ 从没有成功的写：commit 失败 → 查询成功 → 仍 failed（末次决定性结果不回归）', async () => {
    const client = new LastAttemptClient('cf_no_success');
    const task = await confirmRound({
      client,
      calls: [COMMIT_BAD_ARGS, QUERY_ARGS],
      text: '这次没能写进去。',
    });

    expect(task.status).toBe('failed');
    expect(task.failureReason).toContain('dummy.commit');
    expect(task.failureReason).toContain('--records 必须是结构化数组');
    expect(task.executions.slice(-2).map((execution) => `${execution.operation}:${execution.status}`)).toEqual([
      'dummy.commit:failed',
      'dummy.query:completed',
    ]);
    expect(task.resultText).toBeUndefined();
  });
});
