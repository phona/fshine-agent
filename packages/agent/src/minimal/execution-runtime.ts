/**
 * M1 最小切片运行时：Main Pi Agent →（必要时）Worker Pi Agent → Execution Contract → 执行层。
 *
 * 边界（依赖方向）：本模块只依赖 TurnDriver 抽象、执行契约与最小任务底账；
 * 不 import 任何 CLI 适配器、不 import 旧 Runtime 治理模块（import 图由
 * minimal-import-boundary.test.ts 静态检查）。执行层客户端由装配方注入。
 *
 * 每回合链路：
 *   1) 用户文本进 Main 转录，mainDriver 跑一个回合；Main 只有 run_task 一个工具；
 *   2) run_task 触发委派：宿主生成 taskId（绑定 principal/session）→ Worker 回合
 *      （workerDriver + execute_operation 一个工具）；
 *   3) execute_operation：宿主生成 requestId → client.execute(结构化请求) → 结果回给 Worker；
 *   4) Worker 汇报作为工具结果回到 Main，Main 生成给用户的最终回复。
 *
 * B 类不变量（最小可信边界，拒绝路径见测试）：
 *   · 读路径边界（本切片作用域）：execute_operation 只放行装配方声明的允许集合；
 *     集合外 operation 在**发起执行前**被确定性拒绝（不依赖模型遵守提示词）；
 *   · requestId 由宿主生成，模型不能提供可信身份；
 *   · 任务归属：任务底账绑定 principal/session，越权读取被拒（task-registry.ts）。
 *
 * 本切片不做（不预造接口）：写 / 确认 / 取消 / 产物回收；计划门与预算梯子归执行层；
 * 上下文与压缩归 Pi 原生（mainDriver 自带）；这里不另建记忆、检索或投影。
 */
import { randomUUID } from 'node:crypto';
import type { DiscoveredTool } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../driver-contract';
import { createTaskRegistry, type MinimalExecutionRecord, type MinimalTaskRecord, type MinimalTaskRegistry } from './task-registry';

/** Main 委派工具名（实例名可经部署声明替换的演进留在后续切片；M1 用中性名）。 */
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
export interface MinimalWorkerSkill {
  name: string;
  content: string;
}

export interface MinimalRuntimeOptions {
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
  workerSkills?: readonly MinimalWorkerSkill[];
  /**
   * 任务底账（B 类持久化）：装配方可注入 SQLite 实现使归属跨重启成立；
   * 缺省 = 进程内内存实现（测试与纯内存嵌入用）。
   */
  taskRegistry?: MinimalTaskRegistry;
  /** 单回合上限（Main）与单次委派上限（Worker）；缺省值见下。 */
  mainTurnMs?: number;
  workerTurnMs?: number;
}

export interface MinimalTurnResult {
  reply: string;
  taskIds: readonly string[];
  executions: readonly MinimalExecutionRecord[];
  /** 进度帧（本回合 onStep 产出；M1 只收集，不在此投递渠道）。 */
  progress: readonly string[];
}

export interface MinimalSession {
  readonly principalId: string;
  readonly sessionId: string;
  /** 本回合后 Main 转录快照（Pi 原生转录即状态；M1 只存内存）。 */
  transcript(): readonly DriverMessage[];
  send(text: string): Promise<MinimalTurnResult>;
  tasks(): readonly MinimalTaskRecord[];
  /** 按本会话 scope 取任务；越权抛 TaskOwnershipError。 */
  getTask(taskId: string): MinimalTaskRecord;
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
  skills?: readonly MinimalWorkerSkill[];
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

export async function createMinimalSession(options: MinimalRuntimeOptions): Promise<MinimalSession> {
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

  let mainMessages: DriverMessage[] = [];
  /** 本回合 Main 的截止时刻：委派算出的 Worker 截止不能越过它（再留收尾余量）。 */
  let currentTurnDeadline = 0;

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
    const record: MinimalExecutionRecord = {
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

  async function delegate(taskText: string): Promise<unknown> {
    const request = taskText.trim();
    if (request === '') throw new Error('run_task 缺少 task：请写清要办什么。');
    const taskId = `task_${randomUUID()}`;
    registry.begin({ taskId, principalId: options.principalId, sessionId: options.sessionId, request });
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
    }
  }

  async function send(text: string): Promise<MinimalTurnResult> {
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
        const answer = await delegate(task);
        const taskId = (answer as { taskId?: unknown }).taskId;
        if (typeof taskId === 'string') taskIds.push(taskId);
        return answer;
      },
      deadline: currentTurnDeadline,
    });
    mainMessages = [...mainResult.messages];
    const scope = { principalId: options.principalId, sessionId: options.sessionId };
    const executions = taskIds.flatMap((taskId) => registry.get(taskId, scope).executions);
    return { reply: mainResult.text, taskIds, executions, progress };
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
