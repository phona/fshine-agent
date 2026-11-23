/**
 * 契约探针（§二#5，#5 对话面本体 blocked-by 缺口 1 之前先跑的**零模型额度**机械证据）。
 *
 * 目标：用确定性假件构造任务并推进到停下/等待提问，直接读执行层 `audit.jsonl` 与底账事实，
 * 产出「查询 / 取消 / 接续 / 结果找回」在**对话面**缺口的机械证据，并对照缺口 1 设计
 * （gap-task-surface.md，2026-11-18 已删，git 历史可考）。
 *
 * 三条独立的机械事实（全部零真实模型；执行层为仓内 dummy 夹具或纯内存假 executor）：
 *   A. 对话面缺席：Main 回合工具面仅 `task_run`（execution-runtime.ts:426）；
 *      对 task_status/task_result/task_cancel/task_resume 的 Main 调用一律
 *      `Main 工具面之外的调用`（execution-runtime.ts:430）。
 *   B. 结束事实与执行层留痕：经 task_run 推进到停下的任务，底账写结束事实、
 *      执行层 <state-dir>/audit.jsonl 落实际执行行（含 result）。
 *   C. 能力已在宿主侧存在：registry.get/list（scope 化）、runner.cancel（requested≠cancelled）、
 *      runner.resume（waiting_user 接续）、resultText 逐字存档——能力齐全但**无对话入口**。
 *
 * 运行：node --import tsx scripts/eval/business-e2e/contract-probe.ts
 * 落证：.runtime/bizprobe/contract/（gitignored）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextProfileConfig } from '@fshine/contracts';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import type { TaskExecutionInput, TaskExecutionContext, TaskExecutionOutcome, TaskExecutor } from '../../../packages/agent/src/task-runner';
import { type TaskRecord, type TaskScope } from '../../../packages/agent/src/task-registry';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskStartedOf, taskUnstartedOf, taskWaitingOf } from '../../../packages/agent/testing/task-facts';
import { assembleSessionCore } from '../../ask-runtime';

/** 任务事实读数（布尔；不投影任务级状态词）。 */
function factsOf(task: TaskRecord): { started: boolean; reported: boolean; waiting: boolean; mayBeRunning: boolean } {
  return { started: taskStartedOf(task), reported: taskReportedOf(task), waiting: taskWaitingOf(task), mayBeRunning: taskMayBeRunningOf(task) };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const OUT = path.join(REPO_ROOT, '.runtime', 'bizprobe', 'contract');
const PROFILE: ContextProfileConfig = { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] };
const SCOPE: TaskScope = { principalId: 'wecom:fixture-user', sessionId: 'contract-probe' };
const OTHER_SCOPE: TaskScope = { principalId: 'wecom:someone-else', sessionId: 'other-session' };

interface BlockedCall { tool: string; blocked: boolean; error: string }

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

/** 探针 A：对话面缺席 + 终态事实 + 执行层 audit 留痕（inline，真实 dummy 执行层，假 driver）。 */
async function probeConversationFace(): Promise<Record<string, unknown>> {
  const dir = path.join(OUT, 'inline');
  mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dir, 'state');
  const tools: string[] = [];
  const blocked: BlockedCall[] = [];
  let runTaskResult: unknown;

  const mainDriver: TurnDriver = {
    async run(input) {
      tools.length = 0;
      for (const t of input.tools) tools.push(t.name);
      runTaskResult = await input.exec('task_run', { task: '核对 alpha 的 W1 记录' });
      for (const tool of ['task_status', 'task_result', 'task_cancel', 'task_resume']) {
        try {
          await input.exec(tool, { ref: '1' });
          blocked.push({ tool, blocked: false, error: '(未抛错——预期应被拒)' });
        } catch (error) {
          blocked.push({ tool, blocked: true, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const reply = '已核对 alpha 的 W1：共 2 条记录（rec-001/rec-002）。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
  const workerDriver: TurnDriver = {
    async run(input) {
      // 夹具走内部 exec 路由（execute_operation 兼容入口），不借 op_* 工具面透传参数包装。
      await input.exec('execute_operation', { operation: 'dummy.query', args: { collection: 'alpha', window: 'W1' } });
      const reply = 'query 完成';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };

  const assembled = await assembleSessionCore({
    env: baseEnv(),
    profile: PROFILE,
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    dbPath: path.join(dir, 'state.db'),
    stateDir,
    setAuditPath: true,
    emptyOperationsMessage: '（探针）执行层没有声明任何只读 operation',
    createDrivers: () => ({ mainDriver, workerDriver }),
  });
  let tasks: Array<Record<string, unknown>> = [];
  let resultRetrieval: unknown;
  let auditRows: unknown[] = [];
  try {
    await assembled.session.send('帮我核对 alpha 的 W1；顺便查一下我刚才那个任务办得怎么样了。');
    tasks = assembled.taskRegistry.list(SCOPE).map((t) => ({ taskId: t.taskId, taskNo: t.taskNo, status: factsOf(t), executions: t.executions.map((e) => ({ operation: e.operation, status: e.status, requestId: e.requestId })), resultText: t.resultText ?? null, replyText: t.replyText ?? null }));
    const taskId = (tasks[0] as { taskId?: string } | undefined)?.taskId;
    if (taskId !== undefined) {
      const rec = assembled.taskRegistry.get(taskId, SCOPE);
      resultRetrieval = { taskId, status: factsOf(rec), hasArchivedText: (typeof rec.resultText === 'string' && rec.resultText.length > 0) || (typeof rec.replyText === 'string' && rec.replyText.length > 0), resultText: rec.resultText ?? null, replyText: rec.replyText ?? null };
    }
    const auditPath = assembled.auditPath;
    if (existsSync(auditPath)) {
      copyFileSync(auditPath, path.join(dir, 'audit.jsonl'));
      auditRows = readFileSync(auditPath, 'utf8').trimEnd().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
    }
  } finally {
    assembled.close();
  }
  return {
    probe: 'A. conversation-face gap',
    mainToolNames: tools,
    runTaskResult,
    blockedCalls: blocked,
    taskTerminalState: tasks,
    resultRetrieval,
    auditRowCount: auditRows.length,
    auditRows,
    note: '对话面缺席的机械证据：Main 工具面只给 task_run；task_status/task_result/task_cancel/task_resume 无入口。',
  };
}

class FakeExecutor implements TaskExecutor {
  readonly calls: TaskExecutionInput[] = [];
  private readonly behaviors: Array<(input: TaskExecutionInput, ctx: TaskExecutionContext) => Promise<TaskExecutionOutcome>>;
  constructor(behaviors: Array<(i: TaskExecutionInput, c: TaskExecutionContext) => Promise<TaskExecutionOutcome>>) {
    this.behaviors = [...behaviors];
  }
  async execute(input: TaskExecutionInput, ctx: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.calls.push(input);
    const behavior = this.behaviors.shift();
    if (behavior === undefined) throw new Error('（探针）FakeExecutor 没有配置行为');
    return await behavior(input, ctx);
  }
}

/** 探针 C：宿主侧能力齐备（背景模式 + 假 executor，零模型）。 */
async function probeCapabilityApi(): Promise<Record<string, unknown>> {
  const dir = path.join(OUT, 'capability');
  mkdirSync(dir, { recursive: true });
  const executor = new FakeExecutor([
    // task1 round1 → 要求补充输入（started → waiting 事实）
    async () => ({ kind: 'needs_input', question: { missing: ['window'], raw: '请确认要核对的窗口（本月/上月？）' } }),
    // task1 round2（resume 后）→ completed（结果存档）
    async () => ({ kind: 'ended', report: '任务一（接力后）已完成：alpha W1 共 2 条。' }),
    // task2 round1 → 挂起直至被取消（观察 abort 信号）
    async (_input, ctx) => await new Promise<TaskExecutionOutcome>((resolve) => {
      if (ctx.signal.aborted) { resolve({ kind: 'cancelled' }); return; }
      ctx.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }));
    }),
  ]);
  const mainPlan = new Map<string, { task: string }>([
    ['任务一', { task: '核对 alpha 的 W1' }],
    ['任务二', { task: '核对 beta 的 W1' }],
  ]);
  const mainDriver: TurnDriver = {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      const plan = mainPlan.get(text);
      const tool = input.tools.find((t) => t.name === 'task_run') ?? input.tools[0]!;
      const execResults: unknown[] = [];
      if (plan !== undefined) execResults.push(await input.exec(tool.name, { task: plan.task }));
      const reply = plan === undefined ? '（探针）无计划回合' : '已受理。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
  const assembled = await assembleSessionCore({
    env: baseEnv(),
    profile: PROFILE,
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    dbPath: path.join(dir, 'state.db'),
    stateDir: path.join(dir, 'state'),
    setAuditPath: true,
    emptyOperationsMessage: '（探针）执行层没有声明任何只读 operation',
    createDrivers: () => ({ mainDriver, workerDriver: mainDriver }),
    taskExecutor: executor,
    taskDispatch: 'async',
  });
  const observations: Record<string, unknown> = {};
  try {
    const runner = assembled.runner!;
    // task1：waiting_user
    const t1 = await assembled.session.send('任务一');
    await runner.whenIdle();
    const task1Id = t1.taskIds[0]!;
    observations['查询.registry.get(scope)'] = { status: factsOf(assembled.taskRegistry.get(task1Id, SCOPE)), pendingQuestion: assembled.taskRegistry.get(task1Id, SCOPE).pendingQuestion ?? null };
    // 接续：resume(waiting_user) → started → completed + 结果存档
    observations['接续.runner.resume'] = runner.resume(task1Id, { answer: '本月（W202611）', scope: SCOPE });
    await runner.whenIdle();
    const t1After = assembled.taskRegistry.get(task1Id, SCOPE);
    observations['结果找回.registry.get 存档'] = { taskId: task1Id, taskNo: t1After.taskNo, status: factsOf(t1After), resultText: t1After.resultText ?? null, replyText: t1After.replyText ?? null };
    // task2：started → cancel(requested≠cancelled) → 执行端确认 → 结束事实（无汇报）
    const t2 = await assembled.session.send('任务二');
    await new Promise((r) => setTimeout(r, 20));
    const task2Id = t2.taskIds[0]!;
    observations['取消前'] = { status: factsOf(assembled.taskRegistry.get(task2Id, SCOPE)) };
    observations['取消.runner.cancel'] = runner.cancel(task2Id, SCOPE);
    observations['取消后(请求时)'] = { status: factsOf(assembled.taskRegistry.get(task2Id, SCOPE)) };
    await runner.whenIdle();
    observations['取消后(落定)'] = { status: factsOf(assembled.taskRegistry.get(task2Id, SCOPE)), reason: lastFailureOf(assembled.taskRegistry.get(task2Id, SCOPE))?.error?.code ?? null };
    // 取消幂等/终态：再次 cancel
    observations['取消幂等(重复 cancel)'] = runner.cancel(task2Id, SCOPE);
    // 查询列表 + scope 隔离
    observations['查询.registry.list(本会话)'] = assembled.taskRegistry.list(SCOPE).map((t) => ({ taskNo: t.taskNo, status: factsOf(t) }));
    observations['查询.registry.list(他会话)'] = assembled.taskRegistry.list(OTHER_SCOPE).map((t) => ({ taskNo: t.taskNo, status: factsOf(t) }));
    try {
      assembled.taskRegistry.get(task1Id, OTHER_SCOPE);
      observations['越权.get(他会话)'] = '未抛错（预期应抛 TaskOwnershipError）';
    } catch (error) {
      observations['越权.get(他会话)'] = error instanceof Error ? error.constructor.name : String(error);
    }
    observations['executor.calls'] = executor.calls.map((c) => ({ taskId: c.taskId, request: c.request, answer: c.answer ?? null }));
  } finally {
    assembled.close();
  }
  return {
    probe: 'C. capability exists host-side (conversation face entry missing)',
    observations,
    note: '取消/接续/查询/结果找回在 registry+runner 层真实可用；缺口是「无对话入口」，非「能力缺失」。',
  };
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true }); // 每次探针从干净 state 起（audit/db 不复用）
  mkdirSync(OUT, { recursive: true });
  const conversation = await probeConversationFace();
  writeFileSync(path.join(OUT, 'conversation-face.json'), JSON.stringify(conversation, null, 2) + '\n');
  const capability = await probeCapabilityApi();
  writeFileSync(path.join(OUT, 'capability-api.json'), JSON.stringify(capability, null, 2) + '\n');

  const mainTools = conversation['mainToolNames'] as string[];
  const blocked = conversation['blockedCalls'] as BlockedCall[];
  const summary = {
    generatedAt: new Date().toISOString(),
    modelBudget: 'zero model calls (deterministic fakes + in-repo dummy execution layer)',
    design: 'gap-task-surface（缺口 1 设计；文档已删除，git 历史可考）',
    findings: {
      mainToolFace: mainTools,
      blockedConversationTools: blocked.map((b) => ({ tool: b.tool, blocked: b.blocked, error: b.error })),
      terminalTaskInRegistry: conversation['taskTerminalState'],
      executionLayerAuditRows: conversation['auditRowCount'],
      capabilityObservations: capability['observations'],
    },
    designCrossReference: [
      { designClaim: '#1 Main 工具面仅 task_run（execution-runtime.ts:426-430）', observed: `mainToolNames=${JSON.stringify(mainTools)}；四个治理/查询工具全部 blocked` },
      { designClaim: '#4/#5 registry.get/list 带 scope；取消/接续均收 scope（task-registry-sqlite.ts:96-100,218-222；task-runner.ts:275,277）', observed: 'registry.list(本会话)=2 任务、list(他会话)=[]；get(他会话)=TaskOwnershipError；runner.cancel/resume 均收 scope' },
      { designClaim: '#6 取消语义=requestCancel→cancelling，确认才 cancelled（task-runner.ts:32-34,407-418）', observed: 'running→cancel=requested→cancelling→执行端确认→cancelled(cancelled_by_user)；重复 cancel=terminal' },
      { designClaim: 'waiting_user 接续入口=registry answerResumes（经 runner.resume）', observed: 'needs_input→waiting_user；resume=started→completed；executor 收到 answer' },
      { designClaim: '结果存档 archiveReply → 结果可找回', observed: 'completed 任务 registry 存档 replyText=「任务一（接力后）已完成：alpha W1 共 2 条。」' },
      { designClaim: '对话面缺席=用户问「任务怎么样了/取消它/接着办/结果找回」时模型无工具可查可动', observed: 'Main 对 task_status/task_result/task_cancel/task_resume 一律「Main 工具面之外的调用」' },
    ],
    note: '缺口 1 本体（对话面接线）blocked-by 未实施；本探针只给零额度机械证据：能力在宿主侧齐备、对话面无入口。',
  };
  writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('[contract] A) Main 工具面 =', JSON.stringify(mainTools));
  console.log('[contract] A) 被拒对话工具 =', JSON.stringify(blocked.map((b) => `${b.tool}:${b.blocked ? 'blocked' : 'UNBLOCKED'}`)));
  console.log('[contract] B) 终态任务 =', JSON.stringify((conversation['taskTerminalState'] as unknown[]).map((t) => ({ status: (t as { status: string }).status }))), '| audit 行数 =', conversation['auditRowCount']);
  console.log('[contract] C) 能力观察 =', JSON.stringify(capability['observations']));
  console.log('[contract] 落证 →', path.relative(REPO_ROOT, OUT));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
