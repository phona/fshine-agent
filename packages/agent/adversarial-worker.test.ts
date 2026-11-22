/**
 * 「模型走岔路」用例族（确定性；脚本模型**故意作恶**）。
 *
 * 背景（owner 2026-11-19）：「怎么要我自己测试才能测出来」——今天 live 上写不进，是因为模型
 * 自己**绕道**去了历史提案协议（`dummy.proposal` → `proposal-commit` 失败），把已经拿到的
 * 提案弄丢、任务判成 `failed`。现有 12 条后台写确认用例 + sim F 组的脚本模型都太听话
 * （永远 prepare→commit），从没覆盖「模型走岔路」。
 *
 * 本文件用**真装配**（`createTaskExecutor` + `createTaskRunner`；Main 工具面走 `createSession`）
 * 钉住「模型不按套路出牌」时用户应得的四条不变量：
 *   ① 用户拿到可执行下一步（waiting_user + pendingQuestion.confirmation，或失败话术带动作）；
 *   ② 任务不被误判终态（有提案却判 failed / 没提案却判 waiting_user 都是错）；
 *   ③ 执行层不被反复打（执行事实条数有明确上界）；
 *   ④ 用户可见面无内部词（`internalTermIn`）。
 *
 * 纪律：只加用例，不改产品代码。若某条在当前代码上红，即为真缺陷——如实保留并逐条报告，
 * 不为凑绿修改判据或产品。
 */
import { taskStatusOf, taskReasonOf, taskFailureReasonOf } from './testing/task-fact-view';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createSession, createTaskExecutor, EXECUTE_OPERATION_TOOL } from './src/execution-runtime';
import type { RunJsExecutor, RunJsOutput } from './src/run-js-executor';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { TaskRecord, TaskRegistry } from './src/task-registry';
import { createTaskRunner, type TaskExecutor, type TaskRunner } from './src/task-runner';
import { createResourcePolicy } from './src/resource-policy';
import {
  classifyFailure,
  failureMessageFor,
  internalTermIn,
  type UserFacingFailure,
} from './src/user-facing-failure';

const SCOPE = { principalId: 'wecom:adv', sessionId: 'conv-adv' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'dummy.query', label: 'query', args: [] },
    { name: 'dummy.prepare', label: 'prepare', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.proposal', label: 'proposal', args: [] },
    { name: 'dummy.proposal-commit', label: 'proposal-commit', args: [{ name: '--proposal-id', required: true }] },
    { name: 'dummy.denied', label: 'denied', args: [{ name: '--collection', required: true }] },
    { name: 'dummy.ask', label: 'ask', args: [] },
    {
      name: 'dummy.reconfirm',
      label: 'reconfirm',
      args: [
        { name: '--collection', required: true },
        { name: '--confirmation', required: false, type: 'code', hostOnly: true },
      ],
    },
  ],
};

const ALLOWED = [
  'dummy.query',
  'dummy.prepare',
  'dummy.commit',
  'dummy.proposal',
  'dummy.proposal-commit',
  'dummy.denied',
  'dummy.ask',
  'dummy.reconfirm',
];
const READ_ONLY = ['dummy.query'];

const EXPIRES_AT = '2026-11-30T12:00:00.000Z';

/** 一次 execute 调用的观察形状（含宿主是否透传了确认句柄）。 */
interface ClientCall {
  operation: string;
  args?: Record<string, unknown>;
  confirmation?: unknown;
}

/**
 * 故意作恶的执行层替身：语义尽量与真 dummy 同形。
 *   · query        → completed（只读）
 *   · prepare      → needs_confirmation（每次一个新句柄；摘要取集合名）
 *   · commit       → 无句柄 = refused CONFIRMATION_REQUIRED；带句柄 = completed
 *   · proposal     → completed（历史提案协议：拿到一个 proposalId）
 *   · proposal-commit → refused PROPOSAL_TOKEN_UNTRUSTED（历史协议在宿主侧根本走不通）
 *   · denied       → refused GATE_REFUSE（确定性拒绝，retryable:false）
 */
class AdversarialClient implements ExecutionClient {
  readonly calls: ClientCall[] = [];
  private prepareSeq = 0;
  private reconfirmSeq = 0;

  constructor(private readonly handleFor: (seq: number) => string = (seq) => `cf_${seq}`) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: { operation: string; args?: Record<string, unknown>; confirmation?: unknown }): Promise<ExecutionOutcome> {
    this.calls.push({
      operation: request.operation,
      ...(request.args === undefined ? {} : { args: request.args }),
      ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
    });
    const args = (request.args ?? {}) as Record<string, unknown>;
    switch (request.operation) {
      case 'dummy.query':
        return { status: 'completed', data: { rows: 2 } };
      case 'dummy.prepare': {
        this.prepareSeq += 1;
        const collection = typeof args['--collection'] === 'string' ? args['--collection'] : 'alpha';
        return {
          status: 'needs_confirmation',
          confirmation: {
            handle: this.handleFor(this.prepareSeq),
            summary: `「${collection}」将被覆盖，不可撤销`,
            expiresAt: EXPIRES_AT,
          },
          data: { collection },
        };
      }
      case 'dummy.commit':
        return request.confirmation === undefined
          ? { status: 'refused', error: { code: 'CONFIRMATION_REQUIRED', message: 'commit requires a confirmation handle', retryable: false } }
          : { status: 'completed', data: { added: 2 } };
      case 'dummy.ask':
        return { status: 'needs_input', missing: [{ name: '合同编号', description: '合同编号' }] };
      case 'dummy.reconfirm': {
        // ⑬：声明了 hostOnly `--confirmation` 的写操作在一次「确认回合」里再次返回待确认
        // （真实执行层的同类形状：句柄过期/绑定变化后重新冻结提案）。
        this.reconfirmSeq += 1;
        const collection = typeof args['--collection'] === 'string' ? args['--collection'] : 'alpha';
        return {
          status: 'needs_confirmation',
          confirmation: {
            handle: this.handleFor(this.reconfirmSeq),
            summary: `「${collection}」将被再次提交，不可撤销`,
            expiresAt: EXPIRES_AT,
          },
          data: { collection },
        };
      }
      case 'dummy.proposal':
        return { status: 'completed', data: { proposalId: 'prop_1', status: 'pending' } };
      case 'dummy.proposal-commit':
        return { status: 'refused', error: { code: 'PROPOSAL_TOKEN_UNTRUSTED', message: 'proposal token untrusted', retryable: false } };
      case 'dummy.denied':
        return { status: 'refused', error: { code: 'GATE_REFUSE', message: 'denied', retryable: false } };
      default:
        return { status: 'refused', error: { code: 'UNKNOWN_OPERATION', message: `unknown operation ${request.operation}`, retryable: false } };
    }
  }
}

const QUERY = { operation: 'dummy.query', args: {} };
const PREPARE = (collection = 'alpha'): Record<string, unknown> => ({ operation: 'dummy.prepare', args: { '--collection': collection } });
const COMMIT = (collection = 'alpha'): Record<string, unknown> => ({ operation: 'dummy.commit', args: { '--collection': collection } });
const PROPOSAL = { operation: 'dummy.proposal', args: {} };
const ASK = { operation: 'dummy.ask', args: {} };
const PROPOSAL_COMMIT = { operation: 'dummy.proposal-commit', args: { '--proposal-id': 'prop_1' } };
const DENIED = (collection = 'alpha'): Record<string, unknown> => ({ operation: 'dummy.denied', args: { '--collection': collection } });

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'adv-worker-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(join(dir, 'state.db'));
}

interface WorkerCapture {
  /** Worker 收到的工具结果原文（每次 exec 返回一份）。 */
  results: unknown[];
  /** ⑬：每次 Worker 回合收到的委派正文（断言模型可见面用）。 */
  delegations?: string[];
}

/** 多轮脚本化 Worker：每轮消费一组工具调用（脚本模型故意作恶的载体）。 */
function scriptWorker(
  rounds: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  capture: WorkerCapture,
): TurnDriver {
  const remaining = rounds.map((calls) => [...calls]);
  return {
    async run(input) {
      const calls = remaining.shift() ?? [];
      for (const args of calls) capture.results.push(await input.exec(EXECUTE_OPERATION_TOOL, args));
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

/** ⑨–⑫：一轮里混合调用 execute_operation 与 run_js 的脚本 Worker。 */
function scriptWorkerMixed(
  rounds: ReadonlyArray<ReadonlyArray<{ tool: string; args: Record<string, unknown> }>>,
  capture: WorkerCapture,
): TurnDriver {
  const remaining = rounds.map((calls) => [...calls]);
  return {
    async run(input) {
      if (capture.delegations !== undefined) {
        const last = input.messages.at(-1) as unknown as { content?: unknown } | undefined;
        capture.delegations.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''));
      }
      const calls = remaining.shift() ?? [];
      for (const call of calls) {
        try {
          capture.results.push(await input.exec(call.tool, call.args));
        } catch {
          // 工具错误不中断回合（与 scriptWorker 的 exec 同形；被拒的调用由执行事实定终局）。
        }
      }
      return { text: '已按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

/** 幂等替身 run_js 执行器：只有机械结局（成功/非零退出），不 spawn、不写盘。 */
function runJsStub(ok: boolean): RunJsExecutor {
  let seq = 0;
  return {
    async runJs(): Promise<RunJsOutput> {
      seq += 1;
      return {
        exitCode: ok ? 0 : 1,
        exitSignal: null,
        stdout: '',
        stderr: ok ? '' : 'boom',
        stdoutTruncated: false,
        stderrTruncated: false,
        outputs: [],
        audit: {
          runId: `run_adv_${seq}`,
          runDir: `test-run-${seq}`,
          scriptSha256: 'test',
          inputFileIds: [],
          materializedInputs: [],
          inputBytes: 0,
          outputs: [],
          skippedOutputs: [],
          exitCode: ok ? 0 : 1,
          exitSignal: null,
          durationMs: 1,
        },
      };
    },
  };
}

async function makeExecutor(input: {
  client: ExecutionClient;
  registry: TaskRegistry;
  worker: TurnDriver;
  onExecutionEvent?: (event: unknown) => void;
  runJs?: RunJsExecutor;
}): Promise<TaskExecutor> {
  return createTaskExecutor({
    client: input.client,
    allowedOperations: ALLOWED,
    readOnlyOperations: READ_ONLY,
    workerDriver: input.worker,
    registry: input.registry,
    workerTurnMs: 30_000,
    ...(input.onExecutionEvent === undefined ? {} : { onExecutionEvent: input.onExecutionEvent }),
    ...(input.runJs === undefined ? {} : { runJsExecutor: input.runJs }),
  });
}

function makeRunner(registry: TaskRegistry, executor: TaskExecutor): TaskRunner {
  return createTaskRunner({ registry, policy: createResourcePolicy(), executor, leaseMs: 60_000 });
}

/** 受理 + 跑完一轮（后台任务不阻塞调用方；whenIdle 供测试收口）。 */
async function runBackground(registry: TaskRegistry, executor: TaskExecutor, taskId: string): Promise<TaskRunner> {
  const runner = makeRunner(registry, executor);
  runner.submit({
    taskId,
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    request: '把 alpha 集合提交到生产',
  });
  runner.pump();
  await runner.whenIdle();
  return runner;
}

/** 只读执行层（Main 工具面用；Main 不该发起任何写）。 */
class ReadClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: { rows: 2 } };
  }
}

/** 生产 statusView 投影（Main 假驱动调一次 task_status）。 */
async function projectedStatusOf(registry: TaskRegistry, ref: string): Promise<Record<string, unknown>> {
  let captured: unknown;
  const mainDriver: TurnDriver = {
    async run(input) {
      captured = await input.exec('task_status', { ref });
      return { text: '（测试回合）', messages: [] as unknown as DriverMessage[] };
    },
  };
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new ReadClient(),
    allowedOperations: ['dummy.query'],
    mainDriver,
    workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: registry as never,
  });
  await session.send('看看那个任务');
  return captured as Record<string, unknown>;
}

/** 在 Main 工具面上调一次工具（生产 createSession 装配 + 假 Main 驱动）。 */
async function callMainTool(input: {
  registry: TaskRegistry;
  tool: string;
  args: Record<string, unknown>;
  runner?: TaskRunner;
}): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  let captured: { ok: boolean; value?: unknown; error?: string } | undefined;
  const mainDriver: TurnDriver = {
    async run(turnInput) {
      try {
        captured = { ok: true, value: await turnInput.exec(input.tool, input.args) };
      } catch (error) {
        captured = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { text: '（测试回合）', messages: [] as unknown as DriverMessage[] };
    },
  };
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new ReadClient(),
    allowedOperations: ['dummy.query'],
    mainDriver,
    workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: input.registry as never,
    ...(input.runner === undefined ? {} : { taskRunner: input.runner }),
  });
  await session.send('（测试）');
  return captured!;
}

/**
 * 生产失败分类输入：底账执行事实里**第一条** failed/refused 行的 error.code
 * （镜像 apps/server/server.ts#failureCodeOf；码只用于归类，不进用户文本）。
 */
function failureCodeOf(task: TaskRecord): string | undefined {
  const failed = task.executions.find(
    (execution) =>
      (execution.status === 'failed' || execution.status === 'refused')
      && typeof execution.error?.code === 'string'
      && execution.error.code !== '',
  );
  return failed?.error?.code;
}

/**
 * 生产失败话术（单一来源 + 我方故障改判）：镜像 apps/server/task-completion-delivery.ts#failureTextFor。
 * 任务终局 failed 时**没有**等待中的提案/句柄——归类落到 needs_confirmation/needs_input 会被改判
 * host_fault（否则「回确认/补一句」是假承诺）。本函数不新造话术，只用 user-facing-failure 的两个函数。
 */
function userFailureFor(task: TaskRecord): UserFacingFailure {
  const kind = classifyFailure({ code: failureCodeOf(task), status: 'failed' });
  const safeKind = kind === 'needs_confirmation' || kind === 'needs_input' ? 'host_fault' : kind;
  return failureMessageFor(safeKind);
}

/** 用户可见面（写确认提案卡）文案：唯一话术来源 = failureMessageFor('needs_confirmation', {summary})。 */
function proposalCardText(task: TaskRecord): string {
  const summary = task.pendingQuestion?.confirmation?.summary;
  return failureMessageFor('needs_confirmation', summary === undefined ? {} : { summary }).text;
}

/** 用户可见文本不得含内部词（凭据/令牌/句柄/参数/协议/路径/uuid…）。 */
function assertUserVisibleClean(text: string): void {
  const hit = internalTermIn(text);
  expect(hit, `用户可见文本含内部词「${hit}」：${text}`).toBeUndefined();
}

describe('模型走岔路（确定性脚本模型）', () => {
  it('① 绕道历史提案协议（live 真实序列）：prepare 拿到的提案不该被后面走岔路的失败弄丢', async () => {
    // 钉的用户感受：模型**已经问到确认**了，却又自己去撞历史提案协议（宿主根本走不通），
    // 用户不该因此什么都看不到——提案必须仍在，用户仍能回「确认」。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient(() => 'cf_live_handle');
    const executor = await makeExecutor({
      client,
      registry,
      // live 真实序列：prepare → proposal(completed) → proposal-commit(refused ×2) → query(completed)
      worker: scriptWorker([[PREPARE('alpha'), PROPOSAL, PROPOSAL_COMMIT, PROPOSAL_COMMIT, QUERY]], capture),
    });
    await runBackground(registry, executor, 't_detour');

    const task = registry.get('t_detour', SCOPE);
    // ② 任务不被误判终态：拿到过提案 → 必须 waiting_user（不是 failed）。
    expect(taskStatusOf(task)).toBe('waiting_user');
    // ① 用户拿到可执行下一步：底账提案句柄 + 摘要都在。
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_live_handle');
    expect(task.pendingQuestion?.confirmation?.summary).toBe('「alpha」将被覆盖，不可撤销');

    // ④ 用户可见面无内部词。
    assertUserVisibleClean(proposalCardText(task));
    // 2026-11-20：数字 ref 退役，按真实 taskId 投影（断言不变）。
    const projected = await projectedStatusOf(registry, 't_detour');
    expect(projected.liveness).toBe('waiting_user');
    expect(JSON.stringify(projected)).toContain('「alpha」将被覆盖，不可撤销');
    expect(JSON.stringify(projected)).not.toContain('cf_');
    expect(JSON.stringify(projected)).not.toContain('handle');

    // ③ 执行层不被反复打：本轮真实执行 = 5 次（prepare/proposal/proposal-commit×2/query），一条不多。
    expect(client.calls.map((call) => call.operation)).toEqual([
      'dummy.prepare',
      'dummy.proposal',
      'dummy.proposal-commit',
      'dummy.proposal-commit',
      'dummy.query',
    ]);
    expect(task.executions).toHaveLength(5);
  });

  it('② 无提案直接 commit：没有提案可等 → failed（不是 waiting_user），话术带动作且无内部词', async () => {
    // 钉的用户感受：模型空手 commit 被执行层拒（CONFIRMATION_REQUIRED）——这是「没办成」，
    // 不能说成「等你确认」（用户回「确认」什么都不会发生，是假承诺）。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({ client, registry, worker: scriptWorker([[COMMIT('alpha')]], capture) });
    await runBackground(registry, executor, 't_noprop');

    const task = registry.get('t_noprop', SCOPE);
    // ② 没有提案可等 → 不落 waiting_user。
    expect(taskStatusOf(task)).toBe('failed');
    expect(task.pendingQuestion).toBeUndefined();
    // 执行层确被真实调用 1 次（不是宿主预拦）。
    expect(client.calls.map((call) => call.operation)).toEqual(['dummy.commit']);

    // ① 失败话术带一个动作；④ 无内部词。
    const failure = userFailureFor(task);
    expect(failure.actions.length).toBeGreaterThan(0);
    expect(failure.kind).toBe('host_fault');
    assertUserVisibleClean(failure.text);
  });

  it('③ 同一提案连提两次：仍 waiting_user，底账只留最后一个提案（句柄是后者）', async () => {
    // 钉的用户感受：模型一轮里重复 prepare——用户只需看/回一个提案，句柄必须是最新那个。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient((seq) => `cf_dup_${seq}`);
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[PREPARE('alpha'), PREPARE('alpha')]], capture),
    });
    await runBackground(registry, executor, 't_dup');

    const task = registry.get('t_dup', SCOPE);
    expect(taskStatusOf(task)).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_dup_2');
    // ③ 执行事实 2 条、无第三条。
    expect(client.calls).toHaveLength(2);
    expect(task.executions).toHaveLength(2);
    // 旧句柄不再可见。（2026-11-20：数字 ref 退役，按真实 taskId 投影。）
    const projected = await projectedStatusOf(registry, 't_dup');
    expect(JSON.stringify(projected)).not.toContain('cf_');
    expect(JSON.stringify(projected)).not.toContain('handle');
  });

  it('④ 提案后换参数重 prepare：等待的是 B，旧句柄 cf_A 不出现在任何用户可见面', async () => {
    // 钉的用户感受：用户看到的应是「最新要写入的东西」，不是模型先前那份提案。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient((seq) => `cf_${seq}`);
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[PREPARE('alpha'), PREPARE('beta')]], capture),
    });
    await runBackground(registry, executor, 't_reprep');

    const task = registry.get('t_reprep', SCOPE);
    expect(taskStatusOf(task)).toBe('waiting_user');
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_2');
    expect(task.pendingQuestion?.confirmation?.summary).toBe('「beta」将被覆盖，不可撤销');
    // 旧句柄 cf_1 不再出现在用户可见文本与投影里；新摘要来自 B。
    assertUserVisibleClean(proposalCardText(task));
    expect(proposalCardText(task)).toContain('beta');
    // 2026-11-20：数字 ref 退役，按真实 taskId 投影（断言不变）。
    const projected = JSON.stringify(await projectedStatusOf(registry, 't_reprep'));
    expect(projected).toContain('beta');
    expect(projected).not.toContain('cf_1');
    expect(projected).not.toContain('cf_');
    expect(JSON.stringify(task)).not.toContain('cf_1');
  });

  it('⑤ 已有等待提案时 Main 误用 task_run：确定性拒绝 + 话术指向回确认，且不新开任务', async () => {
    // 钉的用户感受：用户回「确认」时模型误开新任务，新任务拿不到旧句柄 → 写入必失败；
    // 宿主必须在**交办前**挡下，并告诉模型「回确认」。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient(() => 'cf_guard');
    const executor = await makeExecutor({ client, registry, worker: scriptWorker([[PREPARE('alpha')]], capture) });
    await runBackground(registry, executor, 't_guard');
    expect(taskStatusOf(registry.get('t_guard', SCOPE))).toBe('waiting_user');
    const before = registry.list(SCOPE).length;

    const result = await callMainTool({ registry, tool: 'task_run', args: { task: '再把 alpha 提交一次' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('等你确认');
    expect(result.error).toContain('回「确认」');
    assertUserVisibleClean(result.error!);
    // ② 没有第二个任务被创建（不产生半截任务）。
    expect(registry.list(SCOPE)).toHaveLength(before);
  });

  it('⑥ 确定性拒绝后不重撞：同参数第二次在宿主侧被锁住（执行层只被调用 1 次）', async () => {
    // 钉的用户感受：模型对同一个确定性拒绝（GATE_REFUSE，retryable:false）换写法/同参数连撞，
    // 宿主必须在第二次发起前拦下（「宁可停下让人介入」），而不是把执行层打到不能用。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const events: unknown[] = [];
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[DENIED('alpha'), DENIED('alpha')]], capture),
      onExecutionEvent: (event) => events.push(event),
    });
    await runBackground(registry, executor, 't_norehit');

    const task = registry.get('t_norehit', SCOPE);
    // ② 任务落终态 failed 是**正确**判定（执行层确已确定性拒绝）。
    expect(taskStatusOf(task)).toBe('failed');
    // ③ 执行层只被真正调用 1 次。
    expect(client.calls.filter((call) => call.operation === 'dummy.denied')).toHaveLength(1);
    // 宿主侧留下可见的拦截事实（运维面 execution_retry_blocked）。
    const blocked = events.filter((event) => (event as { event?: string }).event === 'execution_retry_blocked');
    expect(blocked).toHaveLength(1);
    // ① 失败话术带动作；④ 无内部词。
    const failure = userFailureFor(task);
    expect(failure.actions.length).toBeGreaterThan(0);
    assertUserVisibleClean(failure.text);
  });

  it('⑦ 提案后用户答非确认（「改成 test-c」）：重新进入执行、允许新提案，但不复用旧句柄', async () => {
    // 钉的用户感受：用户没确认、而是改了主意——旧提案作废，模型不该拿着旧句柄继续当「已确认」用。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    let prepareSeq = 0;
    const client = new AdversarialClient(() => `cf_${++prepareSeq}`);
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[PREPARE('alpha')], [PREPARE('test-c')]], capture),
    });
    const runner = await runBackground(registry, executor, 't_nonconfirm');
    expect(registry.get('t_nonconfirm', SCOPE).pendingQuestion?.confirmation?.handle).toBe('cf_1');

    const resumed = runner.resume('t_nonconfirm', { answer: '改成 test-c', scope: SCOPE });
    expect(resumed.outcome).toBe('started');
    await runner.whenIdle();

    const task = registry.get('t_nonconfirm', SCOPE);
    expect(taskStatusOf(task)).toBe('waiting_user');
    // 新提案替换旧提案（句柄是新的）。
    expect(task.pendingQuestion?.confirmation?.handle).toBe('cf_2');
    // 旧句柄不得出现在新回合的 execute 调用里（不当「已确认」复用）。
    const newRoundCalls = client.calls.filter((call) => call.args?.['--collection'] === 'test-c');
    expect(newRoundCalls.length).toBeGreaterThan(0);
    for (const call of client.calls) {
      expect(JSON.stringify(call.confirmation ?? null)).not.toContain('cf_1');
    }
  });

  it('⑧ needs_input 之后又完成的写：终局按末次决定性结果收 completed，不再等补充', async () => {
    // 2026-11-21 Grok 审查 blocking：旧实现取「第一条 needs_input」提前返回，会把之后
    // 已落库的写收成 waiting_user（用户补答后续跑可能再写一次）。末次非只读执行为准。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[ASK, PROPOSAL]], capture),
    });
    await runBackground(registry, executor, 't_needsthenwrite');
    const task = registry.get('t_needsthenwrite', SCOPE);
    expect(taskStatusOf(task)).toBe('completed');
    expect(task.pendingQuestion).toBeUndefined();
  });

  it('⑧b 只停在 needs_input：仍然等待用户补充（不因为修 ⑧ 把补答出口吞掉）', async () => {
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorker([[ASK]], capture),
    });
    await runBackground(registry, executor, 't_needsinput');
    const task = registry.get('t_needsinput', SCOPE);
    expect(taskStatusOf(task)).toBe('waiting_user');
    expect(task.pendingQuestion?.missing).toEqual(['合同编号']);
  });

  it('⑨ 业务写被拒后脚本成功：终局仍是 failed，脚本成功不得把失败的写收成办成', async () => {
    // 2026-11-21 Grok 审查 blocking（方向一）：run_js 是宿主脚本执行，不是执行层业务写。
    // 旧实现在「末次非只读」里把它算进决定性结果：写失败 + 随后脚本成功 → 任务 completed，
    // 用户侧把没办成看成办成。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      runJs: runJsStub(true),
      worker: scriptWorkerMixed([
        [
          { tool: EXECUTE_OPERATION_TOOL, args: DENIED('alpha') },
          { tool: 'run_js', args: { code: 'console.log(1);' } },
        ],
      ], capture),
    });
    await runBackground(registry, executor, 't_failthenscript');
    const task = registry.get('t_failthenscript', SCOPE);
    expect(taskStatusOf(task)).toBe('failed');
    expect(taskFailureReasonOf(task) ?? '').toContain('dummy.denied');
    // 两条执行事实都保留（如实底账：拒绝在先、脚本成功在后）。
    expect(task.executions.map((execution) => [execution.operation, execution.status]))
      .toEqual([['dummy.denied', 'refused'], ['run_js', 'completed']]);
  });

  it('⑩ 业务要补充信息后脚本成功：仍然 waiting_user，脚本成功不得吞掉待补充问题', async () => {
    // 同一条 blocking 的 needs_input 面：旧实现把「脚本成功」当末次决定性结果 →
    // 任务 completed，待补充问题不再唤醒用户。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      runJs: runJsStub(true),
      worker: scriptWorkerMixed([
        [
          { tool: EXECUTE_OPERATION_TOOL, args: ASK },
          { tool: 'run_js', args: { code: 'console.log(1);' } },
        ],
      ], capture),
    });
    await runBackground(registry, executor, 't_askthenscript');
    const task = registry.get('t_askthenscript', SCOPE);
    expect(taskStatusOf(task)).toBe('waiting_user');
    expect(task.pendingQuestion?.missing).toEqual(['合同编号']);
  });

  it('⑪ 业务写已完成后脚本失败：终局仍是 completed，脚本失败不算「另一个写没成」', async () => {
    // 同一条 blocking 的方向二：写已经落库，随后的脚本失败被旧实现当 distinctWriteFailure
    // 收成 failed——用户按失败重试就有再写一次的风险。脚本失败行仍如实留在 executions 里。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      runJs: runJsStub(false),
      worker: scriptWorkerMixed([
        [
          { tool: EXECUTE_OPERATION_TOOL, args: PROPOSAL },
          { tool: 'run_js', args: { code: 'process.exit(3);' } },
        ],
      ], capture),
    });
    await runBackground(registry, executor, 't_writethenscript');
    const task = registry.get('t_writethenscript', SCOPE);
    expect(taskStatusOf(task)).toBe('completed');
    expect(taskFailureReasonOf(task)).toBeUndefined();
    // 审计保留：脚本失败是真实执行事实，只是不改写业务终局。
    expect(task.executions.map((execution) => [execution.operation, execution.status]))
      .toEqual([['dummy.proposal', 'completed'], ['run_js', 'failed']]);
  });

  it('⑫ 只读查询后脚本失败：仍判 failed（无业务写时脚本结局仍是本回合真实结局，不放宽假绿）', async () => {
    // 反向绊线：修复不得把「脚本失败」在无业务写的回合里也一并放过——
    // runtime-worker-run-js 的「查询成功但脚本失败 → failed（不再假绿）」同口径。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [] };
    const client = new AdversarialClient();
    const executor = await makeExecutor({
      client,
      registry,
      runJs: runJsStub(false),
      worker: scriptWorkerMixed([
        [
          { tool: EXECUTE_OPERATION_TOOL, args: QUERY },
          { tool: 'run_js', args: { code: 'process.exit(3);' } },
        ],
      ], capture),
    });
    await runBackground(registry, executor, 't_querythenscript');
    const task = registry.get('t_querythenscript', SCOPE);
    expect(taskStatusOf(task)).toBe('failed');
    expect(taskFailureReasonOf(task) ?? '').toContain('run_js');
  });

  it('⑬ 确认回合重提：宿主注入的确认句柄不得落进底账提案载荷，也不得进下一轮委派正文', async () => {
    // 2026-11-21 Grok 审查 blocking：确认回合同样走 op_* 面时，mapWorkerOperationArgs 把宿主
    // 注入的 `--confirmation` 写进 baseCallArgs；needs_confirmation 时整包存进 proposalArgs →
    // 底账提案 args → renderConfirmationResumeFact 原样进下一轮 Worker 委派正文（凭据进模型面，
    // 且可能被写进汇报）。句柄是宿主持有的凭据：调用方（模型）永远看不到它。
    const registry = makeRegistry();
    const capture: WorkerCapture = { results: [], delegations: [] };
    let seq = 0;
    const client = new AdversarialClient(() => `cf_leak_${++seq}`);
    const executor = await makeExecutor({
      client,
      registry,
      worker: scriptWorkerMixed([
        [{ tool: 'op_dummy_reconfirm', args: { collection: 'alpha' } }],
        [{ tool: 'op_dummy_reconfirm', args: { collection: 'alpha' } }],
        [{ tool: 'op_dummy_reconfirm', args: { collection: 'alpha' } }],
      ], capture),
    });
    const runner = await runBackground(registry, executor, 't_handle_leak');

    const first = registry.get('t_handle_leak', SCOPE);
    expect(taskStatusOf(first)).toBe('waiting_user');
    expect(first.pendingQuestion?.confirmation?.handle).toBe('cf_leak_1');
    // 首轮提案：宿主此时没有句柄可注入，载荷就是业务字段。
    expect(first.pendingQuestion?.confirmation?.args).toEqual({ '--collection': 'alpha' });

    // 用户确认 → 确认回合；Worker 重提（真模型 13/14 会重跑）拿到新提案。
    const confirmed = runner.confirm('t_handle_leak', { userText: '确认', scope: SCOPE });
    expect(confirmed.outcome).toBe('started');
    await runner.whenIdle();
    const second = registry.get('t_handle_leak', SCOPE);
    expect(taskStatusOf(second)).toBe('waiting_user');
    expect(second.pendingQuestion?.confirmation?.handle).toBe('cf_leak_2');
    // 本 blocking 的判据：确认回合的提案载荷不得含宿主注入的确认句柄（只留业务字段）。
    expect(second.pendingQuestion?.confirmation?.args).toEqual({ '--collection': 'alpha' });

    // 再确认一次：下一轮委派正文（renderConfirmationResumeFact 原样交回提案载荷）也不得出现任何句柄。
    const confirmedAgain = runner.confirm('t_handle_leak', { userText: '确认', scope: SCOPE });
    expect(confirmedAgain.outcome).toBe('started');
    await runner.whenIdle();
    expect((capture.delegations ?? []).join('\n')).not.toContain('cf_leak_');
  });
});
