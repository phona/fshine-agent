/**
 * 回合运行时：Main Pi Agent →（必要时）Worker Pi Agent → Execution Contract → 执行层。
 *
 * 边界（依赖方向）：本模块只依赖 TurnDriver 抽象、执行契约与最小任务底账；
 * 不 import 任何 CLI 适配器、不 import 旧 Runtime 治理模块（import 图由
 * import-boundary.test.ts 静态检查）。执行层客户端由装配方注入。
 *
 * 每回合链路：
 *   1) 用户文本进 Main 转录，mainDriver 跑一个回合；Main 只有 run_task 一个工具；
 *   2) run_task 触发委派：宿主生成 taskId（绑定 principal/session）→ Worker 回合
 *      （workerDriver + execute_operation 一个工具）；
 *   3) execute_operation：宿主生成 requestId → client.execute(结构化请求) → 结果回给 Worker；
 *   4) Worker 汇报作为工具结果回到 Main，Main 生成给用户的最终回复；
 *   5) 宿主把本回合最终回复逐字写入本回合各任务行（P1/S1：同回合同值；空白/回合失败不落，
 *      缺省=无最终回复存档，显示层不用执行层汇报冒充）。
 *
 * B 类不变量（最小可信边界，拒绝路径见测试）：
 *   · 读路径边界（本切片作用域）：execute_operation 只放行装配方声明的允许集合；
 *     集合外 operation 在**发起执行前**被确定性拒绝（不依赖模型遵守提示词）；
 *   · requestId 由宿主生成，模型不能提供可信身份；
 *   · 任务归属：任务底账绑定 principal/session，越权读取被拒（task-registry.ts）。
 *
 * 本切片不做（不预造接口）：写 / 确认 / 取消 / 产物回收；计划门与预算梯子归执行层；
 * 上下文与压缩归 Pi 原生（mainDriver 自带）；这里不另建记忆、检索或投影。
 *
 * R4 集成（P5/P6）：注入 `policy` 时前台回合持许可、inline 委派派生后台许可（共享父预算、
 * 深度 +1、不占并发槽）；`dispatchMode='background'` 时委派改为提交注入的 TaskRunner
 * （受理即 queued，执行/恢复/取消归 runner）；缺省 'inline' = 上文现行为逐字不变。
 */
import { randomUUID } from 'node:crypto';
import type { DiscoveredTool } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './driver-contract';
import { createTaskRegistry, deriveTaskName, type ExecutionRecord, type PendingQuestion, type TaskRecord, type TaskRegistry } from './task-registry';
import {
  taskFailureReasonFor,
  type Permit,
  type RejectionReason,
  type ResourcePolicy,
} from './resource-policy';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor, TaskRunner } from './task-runner';

/** Main 委派工具名（实例名可经部署声明替换的演进留在后续切片；当前用中性名）。 */
export const RUN_TASK_TOOL = 'run_task';
export const RUN_TASK_TOOL_DESCRIPTION =
  '把一项平台任务交给执行层 Worker 执行：在 task 里写清要办什么（对象、范围、口径）。'
  + '返回 Worker 的事实汇报与结构化的执行结果。涉及平台数据的请求一律经它办理。';
export const RUN_TASK_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: '要交给执行层 Worker 的任务：写清对象、范围与要回答的问题；用自然语言，不要写命令。',
    },
  },
  required: ['task'],
  additionalProperties: false,
};

/** Worker 唯一工具名：结构化执行入口（宿主生成 requestId，模型只给 operation + args）。 */
export const EXECUTE_OPERATION_TOOL = 'execute_operation';
export const EXECUTE_OPERATION_TOOL_DESCRIPTION =
  '发起一次结构化执行。operation 必须是本轮能力快照里登记的 operation 名；'
  + 'args 按该 operation 声明的参数名填写（对宿主不透明，形状由执行层校验）。返回执行层的状态与数据。';
export const EXECUTE_OPERATION_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: { type: 'string', description: '本轮能力快照里登记的 operation 名。' },
    args: { type: 'object', description: '该 operation 声明的参数（参数名见快照的 args 声明）。' },
  },
  required: ['operation'],
  additionalProperties: false,
};

/**
 * Main 的静态协议义务（本切片的中性措辞；不含执行层实例名与业务字段）。
 * 装配方把它接在角色文本之后（agent.md 负责角色，这里只负责本轮工具协议）。
 */
export const MAIN_PROTOCOL_NOTE = [
  '【本轮工具协议】',
  '- 涉及平台数据的请求，用 run_task 工具交给执行层 Worker；不得自行编造或猜测平台数据。',
  '- 收到 Worker 汇报后，用用户能懂的话给出结论与数据；平台没有给出的内容不要补全，也不要声称已验证。',
  '- 本轮执行面只开放查询（只读）操作；用户要求写入或变更时，如实说明该能力尚未开通。',
].join('\n');

/** Worker 的静态系统提示：协议义务、机械边界与输出纪律；零执行层实例名。 */
export const WORKER_SYSTEM_PROMPT = [
  '你是 fshine 的执行层 Worker：宿主把一项平台任务委派给你，你在一个受信工作区里工作。',
  '',
  '执行纪律：',
  '- 只能通过 execute_operation 工具发起执行；operation 名与参数写法必须取自本轮能力快照。',
  '- 只能依据工具返回的 status/data/error 汇报事实，不得编造、不得补平台没给出的内容。',
  '- 平台说缺信息或没有匹配时，把平台给的事实与候选原样写进汇报，不要自行猜测补全。',
  '- 汇报用简体中文，一段话说清：执行了什么、返回了什么、还有什么平台没有给出。',
  '- 不要在汇报里写内部编号、文件路径、协议原文或工具名；给宿主一段可直接向用户转述的事实。',
].join('\n');

/** 装配方加载好的技能正文（Skill 优先：领域程序性知识放技能，不进宿主提示词补丁）。 */
export interface WorkerSkill {
  name: string;
  content: string;
}

export interface RuntimeOptions {
  /** 可信身份：来自装配/渠道事实，绝不来自模型输入。 */
  principalId: string;
  sessionId: string;
  /** 执行层客户端（依赖注入：通用运行时只认接口）。 */
  client: ExecutionClient;
  /**
   * 本切片允许发起的 operation 集合（读路径作用域，装配方从执行层自述的声明派生）。
   * 必须非空，且全部出现在能力快照里——否则构造即失败（fail-closed）。
   */
  allowedOperations: readonly string[];
  /** Main 与 Worker 的 Pi 回合驱动（真实实现或测试替身都由装配方注入）。 */
  mainDriver: TurnDriver;
  workerDriver: TurnDriver;
  /** Main 系统提示（角色文本 + MAIN_PROTOCOL_NOTE，由装配方组装）。 */
  mainSystemPrompt: string;
  /** Worker 需嵌入本轮提示的领域技能正文（可选）。 */
  workerSkills?: readonly WorkerSkill[];
  /**
   * 任务底账（B 类持久化）：装配方可注入 SQLite 实现使归属跨重启成立；
   * 缺省 = 进程内内存实现（测试与纯内存嵌入用）。
   */
  taskRegistry?: TaskRegistry;
  /** 单回合上限（Main）与单次委派上限（Worker）；缺省值见下。 */
  mainTurnMs?: number;
  workerTurnMs?: number;
  /**
   * P5：资源策略（装配方注入；缺省 = 不强制——直接 `createSession` 的测试/嵌入现行为）。
   * 注入后：`send` 回合持前台许可、委派派生后台许可（共享父预算、深度 +1、不占槽）。
   */
  policy?: ResourcePolicy;
  /**
   * P6：派发模式（缺省 'inline' = 现行为：委派同步执行、Main 等待）。
   * 'background' 需要同时注入 `taskRunner`（装配方构造，进程级共享）。
   */
  dispatchMode?: 'inline' | 'background';
  /** P6：后台任务运行器（background 模式必需；submit→pump，执行/恢复/取消由它承担）。 */
  taskRunner?: TaskRunner;
}

/** 前台回合被资源策略确定性拒绝（queued 排队等晋升后不适用；携带机械 reason）。 */
export class ForegroundRejectionError extends Error {
  readonly reason: RejectionReason;

  constructor(reason: RejectionReason, detail: string) {
    super(`前台回合被资源策略拒绝（${reason}）：${detail}`);
    this.name = 'ForegroundRejectionError';
    this.reason = reason;
  }
}

export interface TurnResult {
  reply: string;
  taskIds: readonly string[];
  executions: readonly ExecutionRecord[];
  /** 进度帧（本回合 onStep 产出；当前只收集，不在此投递渠道）。 */
  progress: readonly string[];
}

export interface Session {
  readonly principalId: string;
  readonly sessionId: string;
  /** 本回合后 Main 转录快照（Pi 原生转录即状态；当前只存内存）。 */
  transcript(): readonly DriverMessage[];
  send(text: string): Promise<TurnResult>;
  tasks(): readonly TaskRecord[];
  /** 按本会话 scope 取任务；越权抛 TaskOwnershipError。 */
  getTask(taskId: string): TaskRecord;
}

const DEFAULT_MAIN_TURN_MS = 300_000;
const DEFAULT_WORKER_TURN_MS = 180_000;
/** Worker 必须在 Main 截止前留出的收尾余量（Main 还要拿汇报生成用户回复）。 */
const WORKER_DEADLINE_MARGIN_MS = 30_000;

function userMessage(text: string): DriverMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as unknown as DriverMessage;
}

/** 委派块：任务原文 + 能力快照（只含允许集合）+ 领域技能正文。 */
export function renderWorkerDelegation(input: {
  task: string;
  manifest: CapabilityManifest;
  skills?: readonly WorkerSkill[];
}): string {
  const parts = [
    '## 本次任务（宿主委派）',
    input.task,
    '',
    '## 能力快照（本轮唯一可执行面：只能调用这里登记的 operation）',
    '```json',
    JSON.stringify(input.manifest, null, 2),
    '```',
  ];
  for (const skill of input.skills ?? []) {
    parts.push('', `## 域技能：${skill.name}`, '', skill.content);
  }
  return parts.join('\n');
}

export async function createSession(options: RuntimeOptions): Promise<Session> {
  if (options.principalId.trim() === '' || options.sessionId.trim() === '') {
    throw new Error('最小切片需要非空 principalId 与 sessionId（可信身份来自装配层）。');
  }
  if (options.allowedOperations.length === 0) {
    throw new Error('允许集合为空：最小切片只开放装配方声明的只读 operation。');
  }
  // 能力快照：每个会话取一次（ExecutionClient 契约的「单次快照」）。
  const manifest = await options.client.capabilities();
  const available = new Set(manifest.operations.map((operation) => operation.name));
  const missingAllowed = options.allowedOperations.filter((name) => !available.has(name));
  if (missingAllowed.length > 0) {
    throw new Error(`允许集合不在能力快照里（fail-closed）：${missingAllowed.join('、')}`);
  }
  const allowed = new Set(options.allowedOperations);
  const workerManifest: CapabilityManifest = {
    contractVersion: manifest.contractVersion,
    operations: manifest.operations.filter((operation) => allowed.has(operation.name)),
  };

  const registry = options.taskRegistry ?? createTaskRegistry();
  const mainTurnMs = options.mainTurnMs ?? DEFAULT_MAIN_TURN_MS;
  const workerTurnMs = options.workerTurnMs ?? DEFAULT_WORKER_TURN_MS;
  const policy = options.policy;
  const dispatchMode: 'inline' | 'background' = options.dispatchMode ?? 'inline';
  const taskRunner = options.taskRunner;
  if (dispatchMode === 'background' && taskRunner === undefined) {
    throw new Error('background 派发需要注入 TaskRunner（装配方构造 runner；此处 fail-closed）。');
  }

  let mainMessages: DriverMessage[] = [];
  /** 本回合 Main 的截止时刻：委派算出的 Worker 截止不能越过它（再留收尾余量）。 */
  let currentTurnDeadline = 0;

  /**
   * 前台回合许可（P5）：策略存在时回合开始 acquire、结束 release。
   *   · 拒绝 → 确定性 ForegroundRejectionError（错误面由入口归类；server 走既有 fallback）；
   *   · 排队（queueCapacity>0）→ 受控等待晋升（release 触发 FIFO），等待不空转（10ms 让出）。
   */
  async function acquireForegroundPermit(): Promise<Permit | undefined> {
    if (policy === undefined) return undefined;
    const acquired = policy.acquire('foreground', { taskId: `session:${options.principalId}:${options.sessionId}` });
    if (acquired.ok === false) {
      throw new ForegroundRejectionError(acquired.reason, acquired.message);
    }
    while (acquired.state === 'queued') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (acquired.state !== 'active') {
      throw new ForegroundRejectionError('queue_full', '前台许可在等待晋升中被取消');
    }
    return acquired;
  }

  function releaseForegroundPermit(permit: Permit | undefined): void {
    if (permit === undefined || policy === undefined) return;
    policy.release(permit);
  }

  async function executeOperation(taskId: string, args: Record<string, unknown>): Promise<ExecutionOutcome> {
    const operation = typeof args.operation === 'string' ? args.operation : '';
    if (operation === '') throw new Error('execute_operation 缺少 operation。');
    if (!allowed.has(operation)) {
      // 读路径边界：集合外的 operation 在发起执行前被拒——不依赖模型遵守提示词。
      throw new Error(`本轮只开放只读操作：「${operation}」不在允许集合内，未发起执行。`);
    }
    const rawArgs = args.args;
    const callArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
    // requestId 由宿主生成：模型不能提供调用身份。
    const requestId = `req_${randomUUID()}`;
    const outcome = await options.client.execute({ requestId, operation, args: callArgs });
    const record: ExecutionRecord = {
      requestId,
      operation,
      status: outcome.status,
      ...(outcome.status === 'failed' || outcome.status === 'refused' ? { error: outcome.error } : {}),
    };
    registry.noteExecution(taskId, record);
    return outcome;
  }

  function workerExec(taskId: string): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
    return async (tool, args) => {
      if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
      return executeOperation(taskId, args);
    };
  }

  async function delegate(taskText: string, foregroundPermit: Permit | undefined): Promise<unknown> {
    const request = taskText.trim();
    if (request === '') throw new Error('run_task 缺少 task：请写清要办什么。');
    const taskId = `task_${randomUUID()}`;

    // P6 background：受理即底账 queued（Main 不等待）；派发/执行/恢复/取消归 TaskRunner。
    if (dispatchMode === 'background') {
      const accepted = taskRunner!.submit({
        taskId,
        principalId: options.principalId,
        sessionId: options.sessionId,
        request,
      });
      taskRunner!.pump();
      const taskNo = accepted.taskNo ?? 0;
      const name = accepted.name ?? deriveTaskName(request);
      return {
        taskId,
        taskNo,
        name,
        status: 'queued',
        accepted: true,
        notice: `已受理 #${taskNo} ${name}，将在后台执行。`,
      };
    }

    registry.begin({ taskId, principalId: options.principalId, sessionId: options.sessionId, request });
    // P5：前台回合内的委派 = 派生后台许可（共享父预算、深度 +1、不占并发槽）；
    // 拒绝确定性落任务原因 resource_limited（§5），并向 Main 抛出（不进入执行）。
    let delegationPermit: Permit | undefined;
    if (policy !== undefined && foregroundPermit !== undefined) {
      const acquired = policy.acquire('background', { taskId, parentPermit: foregroundPermit });
      if (acquired.ok === false) {
        const reason = taskFailureReasonFor(acquired);
        registry.transition(taskId, 'failed', { reason });
        throw new Error(`委派被资源策略拒绝（${reason}）：${acquired.message}`);
      }
      delegationPermit = acquired;
    }
    const workerDeadline = Math.min(Date.now() + workerTurnMs, currentTurnDeadline - WORKER_DEADLINE_MARGIN_MS);
    try {
      const workerResult = await options.workerDriver.run({
        systemPrompt: WORKER_SYSTEM_PROMPT,
        tools: [executeOperationTool()],
        messages: [userMessage(renderWorkerDelegation({
          task: request,
          manifest: workerManifest,
          ...(options.workerSkills ? { skills: options.workerSkills } : {}),
        }))],
        onStep: () => {},
        exec: workerExec(taskId),
        deadline: workerDeadline,
      });
      if (workerResult.text.trim() === '') {
        throw new Error('执行层 Worker 未产出有效汇报，本次任务未完成。');
      }
      registry.complete(taskId, workerResult.text);
      const task = registry.get(taskId, { principalId: options.principalId, sessionId: options.sessionId });
      return { taskId, summary: workerResult.text, executions: task.executions };
    } catch (error) {
      registry.fail(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (delegationPermit !== undefined && policy !== undefined) {
        policy.release(delegationPermit);
      }
    }
  }

  async function send(text: string): Promise<TurnResult> {
    const foregroundPermit = await acquireForegroundPermit();
    try {
      const progress: string[] = [];
      const taskIds: string[] = [];
      currentTurnDeadline = Date.now() + mainTurnMs;
      mainMessages = [...mainMessages, userMessage(text)];
      const mainResult = await options.mainDriver.run({
        systemPrompt: options.mainSystemPrompt,
        tools: [runTaskTool()],
        messages: mainMessages,
        onStep: (step) => progress.push(step),
        exec: async (tool, args) => {
          if (tool !== RUN_TASK_TOOL) throw new Error(`Main 工具面之外的调用：${tool}`);
          const task = typeof args.task === 'string' ? args.task : '';
          const answer = await delegate(task, foregroundPermit);
          const taskId = (answer as { taskId?: unknown }).taskId;
          if (typeof taskId === 'string') taskIds.push(taskId);
          return answer;
        },
        deadline: currentTurnDeadline,
      });
      mainMessages = [...mainResult.messages];
      // P1（S1）：本回合最终回复逐字存档——同回合各任务行同值；空白回复/回合失败不落
      // （缺省=无最终回复存档，显示层不用执行层汇报冒充）。
      // background：受理话术不落任务行（结果由 runner 在确认 completed 后经 archiveReply
      // 逐字存档，避免受理话术覆盖结果）。
      if (dispatchMode !== 'background' && taskIds.length > 0 && mainResult.text.trim() !== '') {
        registry.archiveReply(taskIds, mainResult.text);
      }
      const scope = { principalId: options.principalId, sessionId: options.sessionId };
      const executions = taskIds.flatMap((taskId) => registry.get(taskId, scope).executions);
      return { reply: mainResult.text, taskIds, executions, progress };
    } finally {
      releaseForegroundPermit(foregroundPermit);
    }
  }

  return {
    principalId: options.principalId,
    sessionId: options.sessionId,
    transcript: () => [...mainMessages],
    send,
    tasks: () => registry.list({ principalId: options.principalId, sessionId: options.sessionId }),
    getTask: (taskId) => registry.get(taskId, { principalId: options.principalId, sessionId: options.sessionId }),
  };
}

function runTaskTool(): DiscoveredTool {
  return {
    name: RUN_TASK_TOOL,
    description: RUN_TASK_TOOL_DESCRIPTION,
    inputSchema: RUN_TASK_TOOL_SCHEMA,
  };
}

function executeOperationTool(): DiscoveredTool {
  return {
    name: EXECUTE_OPERATION_TOOL,
    description: EXECUTE_OPERATION_TOOL_DESCRIPTION,
    inputSchema: EXECUTE_OPERATION_TOOL_SCHEMA,
  };
}

export interface TaskExecutorOptions {
  /** 执行层客户端（后台执行面的专属实例；能力快照在本工厂内取一次）。 */
  client: ExecutionClient;
  /** 允许集合（必须全部出现在能力快照里；fail-closed）。 */
  allowedOperations: readonly string[];
  workerDriver: TurnDriver;
  workerSkills?: readonly WorkerSkill[];
  /** 执行事实的记录底账（noteExecution 单一写点）。 */
  registry: TaskRegistry;
  /** 单次后台回合上限（缺省 180s，与执行侧现行缺省一致）。 */
  workerTurnMs?: number;
  /** 注入时钟（测试确定性）；缺省系统时钟。 */
  now?: () => number;
}

function isAbortErrorLike(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

/** needs_input 的机械问题形状（missing 原文转述；不编造、不改写）。 */
function pendingQuestionFrom(outcome: Extract<ExecutionOutcome, { status: 'needs_input' }>): PendingQuestion | undefined {
  const missing = outcome.missing
    .map((item) => {
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      if (description !== '') return description;
      return typeof item.name === 'string' ? item.name.trim() : '';
    })
    .filter((item) => item !== '');
  return missing.length === 0 ? undefined : { missing };
}

/**
 * 后台单回合执行器（P6 TaskExecutor 的生产实现；每次派发新建 Worker 回合）：
 *   · 转录隔离结构性满足：只持有本次任务投影（request/answer），不接触 mainMessages；
 *   · 执行经 `execute_operation` 唯一工具 + 宿主生成 requestId，事实写 taskRegistry.noteExecution；
 *   · 逐回合机械判定（不替执行端做 task 级二次判定）：
 *       中止/abort → cancelled；截止未产出 → timed_out；空汇报 → failed；
 *       执行层 needs_input → needs_input（missing 原样转述）；
 *       零执行 → failed（不得报 completed）；任一非 completed → failed（原因机械合成）；
 *       全部 completed → completed{resultText}（结果存档由 runner settle 经 archiveReply 承接）。
 */
export async function createTaskExecutor(options: TaskExecutorOptions): Promise<TaskExecutor> {
  const manifest = await options.client.capabilities();
  const available = new Set(manifest.operations.map((operation) => operation.name));
  const missingAllowed = options.allowedOperations.filter((name) => !available.has(name));
  if (missingAllowed.length > 0) {
    throw new Error(`允许集合不在能力快照里（fail-closed）：${missingAllowed.join('、')}`);
  }
  const allowed = new Set(options.allowedOperations);
  const workerManifest: CapabilityManifest = {
    contractVersion: manifest.contractVersion,
    operations: manifest.operations.filter((operation) => allowed.has(operation.name)),
  };
  const workerTurnMs = options.workerTurnMs ?? DEFAULT_WORKER_TURN_MS;
  const now = options.now ?? Date.now;

  return {
    async execute(task, context): Promise<TaskExecutionOutcome> {
      const recorded: Array<{ operation: string; outcome: ExecutionOutcome }> = [];
      const exec = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (operation === '') throw new Error('execute_operation 缺少 operation。');
        if (!allowed.has(operation)) {
          throw new Error(`本轮只开放只读操作：「${operation}」不在允许集合内，未发起执行。`);
        }
        const rawArgs = args.args;
        const callArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
        // requestId 由宿主生成：模型不能提供可信身份。
        const requestId = `req_${randomUUID()}`;
        const outcome = await options.client.execute({ requestId, operation, args: callArgs });
        options.registry.noteExecution(task.taskId, {
          requestId,
          operation,
          status: outcome.status,
          ...(outcome.status === 'failed' || outcome.status === 'refused' ? { error: outcome.error } : {}),
        });
        recorded.push({ operation, outcome });
        return outcome;
      };

      const deadline = now() + workerTurnMs;
      let workerResult: TurnDriverResult;
      try {
        workerResult = await options.workerDriver.run({
          systemPrompt: WORKER_SYSTEM_PROMPT,
          tools: [executeOperationTool()],
          messages: [userMessage(renderWorkerDelegation({
            task: task.request,
            manifest: workerManifest,
            ...(options.workerSkills === undefined ? {} : { skills: options.workerSkills }),
          }))],
          onStep: () => {},
          exec,
          deadline,
          signal: context.signal,
        });
      } catch (error) {
        if (context.signal.aborted) return { kind: 'cancelled' };
        if (isAbortErrorLike(error) && now() >= deadline) return { kind: 'timed_out' };
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      if (context.signal.aborted) return { kind: 'cancelled' };
      if (workerResult.text.trim() === '') {
        return now() >= deadline
          ? { kind: 'timed_out' }
          : { kind: 'failed', reason: '执行层 Worker 未产出有效汇报，本次任务未完成。' };
      }
      const needsInput = recorded.find(
        (entry): entry is { operation: string; outcome: Extract<ExecutionOutcome, { status: 'needs_input' }> } =>
          entry.outcome.status === 'needs_input',
      );
      if (needsInput !== undefined) {
        const question = pendingQuestionFrom(needsInput.outcome);
        return question === undefined
          ? { kind: 'failed', reason: '执行层要求补充输入但未说明缺什么（missing 为空）。' }
          : { kind: 'needs_input', question };
      }
      if (recorded.length === 0) {
        return { kind: 'failed', reason: '未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。' };
      }
      const unsuccessful = recorded.find((entry) => entry.outcome.status !== 'completed');
      if (unsuccessful !== undefined) {
        const { operation, outcome } = unsuccessful;
        if (outcome.status === 'failed' || outcome.status === 'refused') {
          const message = outcome.error.message ?? '';
          return {
            kind: 'failed',
            reason: message === ''
              ? `执行层未成功：${operation} 返回 ${outcome.status}。`
              : `执行层未成功：${operation} 返回 ${outcome.status}：${message}`,
          };
        }
        return { kind: 'failed', reason: `执行层未成功：${operation} 返回 ${outcome.status}。` };
      }
      return { kind: 'completed', resultText: workerResult.text };
    },
  };
}
