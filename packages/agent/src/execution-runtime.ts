/**
 * 回合运行时：Main Pi Agent →（必要时）Worker Pi Agent → Execution Contract → 执行层。
 *
 * 边界（依赖方向）：本模块只依赖 TurnDriver 抽象、执行契约与最小任务底账；
 * 不 import 任何 CLI 适配器、不 import 旧 Runtime 治理模块（import 图由
 * import-boundary.test.ts 静态检查）。执行层客户端由装配方注入。
 *
 * 每回合链路：
 *   1) 用户文本进 Main 转录，mainDriver 跑一个回合；Main 工具面 = run_task（委派）+（注入 runner
 *      时）task_status/task_result/task_cancel/task_resume（查询/取消/接续，缺口 1）+（注入 Main
 *      技能登记表时）read_skill（缺口 2 臂 B，按需读业务技能正文）；
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
 * 本切片不做（不预造接口）：写 / 确认 / 产物回收；计划门与预算梯子归执行层；
 * 取消/接续经 task_cancel/task_resume 复用 runner 既有生命周期（不在此新建治理）；
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
import type { DriverMessage, RuntimeTurnEvent, TurnDriver, TurnDriverResult } from './driver-contract';
import { ToolUserError } from './driver-contract';
import { READ_SKILL_TOOL, type SkillRegistry } from './skills';
import { createTaskRegistry, deriveTaskName, DispatchConflictError, TaskTransitionError, TaskOwnershipError, type ExecutionRecord, type PendingQuestion, type TaskRecord, type TaskRegistry, type TaskScope } from './task-registry';
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

/**
 * 对话面任务工具（缺口 1）：把既有 registry/runner 能力以服务端身份授权接到 Main 工具面。
 * 统一纪律：**参数量只收任务引用（`#编号` 或 taskId），绝不收 principalId/sessionId**——scope 由宿主
 * 在 send() 闭包用运行时 principal/session 构造，编号解析在 scope 内做（越权=找不到，不泄露存在性）。
 * 四个工具都随 `options.taskRunner` 一起上/下（background 模式天然有 runner；inline/ask 单发不上面，
 * 缺省零变化）；cancel/resume 复用 runner 既有生命周期，不在此新建治理。
 */
export const TASK_STATUS_TOOL = 'task_status';
export const TASK_STATUS_TOOL_DESCRIPTION =
  '查询本会话已有任务的状态：ref 给受理回执里的 #编号（如 "#3"）查单个任务，留空列本会话全部任务。'
  + '用户问「那个任务怎么样了 / 在等什么」时用它，不要为此新交办任务。';
export const TASK_STATUS_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '任务引用：受理回执里的 #编号（如 "#3"）；留空列本会话全部任务。' },
  },
  additionalProperties: false,
};

export const TASK_RESULT_TOOL = 'task_result';
export const TASK_RESULT_TOOL_DESCRIPTION =
  '取回本会话某个任务的结果：已完成任务返回其逐字存档结果与执行摘要；未完成任务如实返回当前状态，不编造结果。';
export const TASK_RESULT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '任务引用：受理回执里的 #编号（如 "#3"）。' },
  },
  required: ['ref'],
  additionalProperties: false,
};

export const TASK_CANCEL_TOOL = 'task_cancel';
export const TASK_CANCEL_TOOL_DESCRIPTION =
  '请求取消本会话某个任务。返回机械结果：requested=已发出取消请求、待执行端确认；cancelled=已确认取消。'
  + '确认前不得向用户宣称已取消，如实按返回结果转述。';
export const TASK_CANCEL_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '要取消的任务引用：#编号。' },
    reason: { type: 'string', description: '用户给出的取消原因，一句话（可选，原样回显）。' },
  },
  required: ['ref'],
  additionalProperties: false,
};

export const TASK_RESUME_TOOL = 'task_resume';
export const TASK_RESUME_TOOL_DESCRIPTION =
  '当已有任务在等待用户补齐信息时，用用户的答复把同一任务接续下去（编号不变）。非等待中的任务会被如实拒绝。';
export const TASK_RESUME_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '等待中的任务引用：#编号。' },
    answer: { type: 'string', description: '对任务待办问题的答复，用用户原话的意思写清。' },
  },
  required: ['ref', 'answer'],
  additionalProperties: false,
};

/**
 * 缺口 2 臂 B（实验面）：Main 按需读取业务技能正文。工具名复用 skills.ts 的 READ_SKILL_TOOL（不另起名）；
 * name 只在登记表内匹配，不做文件系统拼接（路径逃逸防护与 32KiB 上限都在 skills.ts 既有实现内）。
 */
export const READ_SKILL_TOOL_DESCRIPTION = '按技能清单里的名称读取该技能的完整正文（需要该技能的程序性知识时使用）。';
export const READ_SKILL_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '技能清单里的技能名。' },
  },
  required: ['name'],
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

/**
 * 渲染 Worker 系统提示：不传 workspaceRoot 时与 WORKER_SYSTEM_PROMPT 逐字节相同（缺省零变化）；
 * 传入可信绝对路径时追加工作目录约束块（纵深防御提醒，不是安全控制——执行环境的实际
 * 权限边界归执行层）。workspaceRoot 来源必须是装配层持有的可信路径（如 profile.root），
 * 不得取模型输出或用户消息。
 */
export function renderWorkerSystemPrompt(workspaceRoot?: string): string {
  if (workspaceRoot === undefined || workspaceRoot.trim() === '') return WORKER_SYSTEM_PROMPT;
  return [
    WORKER_SYSTEM_PROMPT,
    '',
    '【可信工作目录】',
    `你的可信工作目录是：${workspaceRoot}`,
    '不要主动访问该目录之外的文件；不要读取宿主配置、凭据、其他项目或用户主目录；该约束同样适用于你启动的任何子进程。',
    '（以上是纵深防御提醒，不构成操作系统级隔离；执行环境的实际权限边界由执行层负责。）',
  ].join('\n');
}

/** 装配方加载好的技能正文（Skill 优先：领域程序性知识放技能，不进宿主提示词补丁）。 */
export interface WorkerSkill {
  name: string;
  content: string;
}

/**
 * 会话转录端口（依赖注入；runtime 只认接口，**不** import 任何具体存储实现）。
 *
 * 装配层提供实现（如基于 Pi `SessionManager` 的 `session-persistence.ts`）。语义：
 *   · `readTranscript()`：打开会话时**现读**该 `(principalId, sessionId)` 的完整转录
 *     （每次调用都从存储读，宿主不留第二份可变副本——Pi entry-log 是唯一转录所有者）；
 *   · `append(message)`：回合结束后向存储**追加一条**本条新增的转录消息（Pi 原生 message 形状）。
 *
 * 与 `PersistedSession`（session-persistence.ts:57）结构化相容——装配层直接注入后者。
 */
export interface TranscriptStore {
  readTranscript(): Promise<readonly DriverMessage[]>;
  append(message: DriverMessage): Promise<void>;
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
  /**
   * 缺口 2 臂 B（实验面）：Main 技能登记表——注入后 Main 工具面多一个 read_skill，按登记表内的
   * 技能名读正文（32KiB 上限由 registry 既有钳制）。缺省不注入 = 无该工具（现行工具面逐字节不变）。
   * 摘要在系统提示里由装配层经 renderSkillCatalog 拼入，本选项只管工具面。
   */
  mainSkillRegistry?: SkillRegistry;
  /**
   * R5 B 通道（事实进上下文）：注入器由装配方提供（事实源在装配层，如通知 outbox 挂钩）。
   * 回合开始时调用一次；返回非空文本即以普通 user-role 消息注入主对话（不造 custom
   * message type、不改 Pi 消息流不变量）。注入器自身保证幂等与有界。
   */
  taskFactProvider?: (principalId: string, sessionId: string) => string | undefined;
  /**
   * Worker 可信工作目录（渲染进 Worker 系统提示的工作目录约束块）。
   * 来源必须是装配层持有的可信路径（如 profile.root）；不得取模型输出或用户消息。
   * 缺省不注入 = Worker 提示与现行常量逐字节相同。
   */
  workerWorkspaceRoot?: string;
  /**
   * B1 会话持久化端口（装配层注入具体实现；缺省 undefined = 逐字节现行为：转录仅内存、归 Pi 会话独占）。
   * 注入后：打开会话时从存储载入转录作为首回合种子、回合结束后把**本回合新增**消息增量持久化。
   * 写失败 fail-open（不回滚回合），读/写错误经 `onTranscriptError` 上报。
   */
  transcriptStore?: TranscriptStore;
  /** B1：转录读/写失败的上报回调（fail-open 日志；缺省静默吞掉，不影响回合）。 */
  onTranscriptError?: (error: unknown) => void;
  /**
   * U3：执行层声明为只读的 operation 集合（由装配方从执行层 `access=read` 显式派生，
   * **独立于** allowedOperations）。只有这些 operation 的重试可以安全重发；
   * 缺省 = 空集（保守：一律按可能有副作用处理，重试走回放/待核对，绝不第二次执行）。
   */
  readOnlyOperations?: readonly string[];
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

/**
 * 运行时回合号 / 重放窗口（U3）：只由驱动转述的原生事件推进（模型不可见、不可提供）。
 *
 * 生命周期（开 / 关 / 清空）：
 *   · 开：仅在 recovery（compaction willRetry / auto_retry_start / assistant message_end('error')）
 *     打开。窗口号 = 当前 attempt（被丢弃尝试所在的回合号）；同一次失败的多个原生事件
 *     （error message_end 后紧跟 auto_retry_start）只开一次，不重复推进回合号。
 *   · 关：被重试响应结束（phase=awaiting_retry_response 时收到 assistant_end）先只 disarm，
 *     窗口保留给它自己的工具调用；下一次 assistant_end（一轮新的响应边界）关闭窗口。
 *     若窗口已被消费（phase=retry_response_tools）后再次 recovery，先关旧窗再开新窗。
 *   · 清空：关闭 = 删除 window 与 phase，不留下可被后续响应使用的绑定；attempt 只增不复用。
 *     窗口状态随 send / 单次任务执行结束整体丢弃，不跨回合、不跨任务。
 */
interface RuntimeAttemptWindow {
  attempt: number;
  /** 打开窗口时被丢弃尝试的回合号（只读回同一行，不重铸身份）。 */
  window?: number;
  /**
   * 窗口相位（与 window 同生共死）：
   *   awaiting_retry_response —— recovery 已开窗，等待被重试的响应结束；
   *   retry_response_tools    —— 被重试的响应已结束，窗口对其工具调用有效。
   */
  phase?: 'awaiting_retry_response' | 'retry_response_tools';
}

function newAttemptWindow(): RuntimeAttemptWindow {
  return { attempt: 1 };
}

function closeWindow(state: RuntimeAttemptWindow): void {
  delete state.window;
  delete state.phase;
}

function noteRuntimeEvent(state: RuntimeAttemptWindow, event: RuntimeTurnEvent): void {
  if (event.kind === 'assistant_end') {
    if (state.phase === 'awaiting_retry_response') {
      // 被重试的响应结束：其工具调用在此事件之后执行，窗口须保留给它们。
      state.phase = 'retry_response_tools';
      state.attempt += 1;
      return;
    }
    // 一轮新的响应边界：关闭并清空旧窗口（不留给这一响应及之后），推进回合号。
    closeWindow(state);
    state.attempt += 1;
    return;
  }
  // recovery：同一次失败尚未等到重试响应结束时，重复的恢复事件不再开窗。
  if (state.phase === 'awaiting_retry_response') return;
  // 窗口已被上一轮重试响应消费后再失败：旧窗到此关闭，新窗指向当前回合。
  closeWindow(state);
  state.window = state.attempt;
  state.attempt += 1;
  state.phase = 'awaiting_retry_response';
}

/** 待核对固定话术：内部术语不进用户可见文本（通知/汇报另有黑名单）。 */
const RESULT_UNKNOWN_MESSAGE =
  '结果待核对：无法确认这次操作是否已经发生，已停止自动重试，需要人工核对后再决定是否重办。';
const OPERATION_IN_PROGRESS_MESSAGE =
  '这次操作正在执行中，本次没有重复发起；请以已有执行记录为准，不要并发重试。';

/** 认领结果的机械处置（runtime 内部；不对外暴露身份键细节）。 */
interface OperationRunResult {
  outcome: ExecutionOutcome;
  /** 本次是否真的发起了执行（false = 回放已有结果）。 */
  executed: boolean;
  /** 必须是「待核对」：调用方不得当作成功，也不得自动重试。 */
  unresolved: boolean;
}

/**
 * U3：认领 →（仅首次铸造）执行 → 落定。**先落库再调用**：调用执行层之前已有一行
 * claimed（进程死亡窗口里有记录）；重试/恢复后的调用只按窗口读回已持久化行。
 * 无法证明绑定（unresolved）时不发起执行，交还待核对。
 */
async function claimAndRunOperation(input: {
  registry: TaskRegistry;
  readOnlyOperations: ReadonlySet<string>;
  scopeKey: string;
  window: RuntimeAttemptWindow;
  operation: string;
  taskId?: string;
  /** 执行回调抛错时的机械处置：unknown = 外部是否生效未知（默认）；propagate = 已知失败，原样抛出。 */
  executeThrows?: 'unknown' | 'propagate';
  execute: (dispatchKey: string) => Promise<ExecutionOutcome>;
}): Promise<OperationRunResult> {
  const readOnly = input.readOnlyOperations.has(input.operation);
  const claim = input.registry.claimOperation({
    scopeKey: input.scopeKey,
    operation: input.operation,
    attempt: input.window.attempt,
    ...(input.window.window === undefined ? {} : { replayWindow: input.window.window }),
    ...(readOnly ? { readOnly: true } : {}),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
  switch (claim.kind) {
    case 'conflict':
      throw new DispatchConflictError(claim.dispatchKey);
    case 'replayed': {
      // 同 Key 同操作：返回已有结果，零调用、零新执行行。
      // 已落定的 result_unknown 不会以 replay 出现（账行状态是 unknown），这里仍保守判定。
      const replayedUnknown = claim.outcome.status === 'failed' && claim.outcome.error.code === 'result_unknown';
      return { outcome: claim.outcome, executed: false, unresolved: replayedUnknown };
    }
    case 'in_progress':
      return {
        outcome: { status: 'failed', error: { code: 'in_progress', message: OPERATION_IN_PROGRESS_MESSAGE, retryable: false } },
        executed: false,
        unresolved: true,
      };
    case 'unresolved':
      return {
        outcome: { status: 'failed', error: { code: 'result_unknown', message: RESULT_UNKNOWN_MESSAGE, retryable: false } },
        executed: false,
        unresolved: true,
      };
    case 'minted': {
      let outcome: ExecutionOutcome;
      try {
        outcome = await input.execute(claim.dispatchKey);
      } catch (error) {
        if (input.executeThrows === 'propagate') {
          // 已知失败（不是「结果未知」）：账行落 failed，原样抛给调用方（既有失败路径不变）。
          input.registry.settleOperation(claim.dispatchKey, {
            status: 'failed',
            error: { code: 'delegation_failed', message: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
        // 调用中断/无回执：外部是否生效未知 → 账行落 unknown，交还待核对（不自动重试）。
        input.registry.markOperationUnknown(claim.dispatchKey, 'call_interrupted');
        return {
          outcome: { status: 'failed', error: { code: 'result_unknown', message: RESULT_UNKNOWN_MESSAGE, retryable: false } },
          executed: true,
          unresolved: true,
        };
      }
      input.registry.settleOperation(
        claim.dispatchKey,
        outcome,
        input.taskId === undefined ? {} : { taskId: input.taskId },
      );
      return {
        outcome,
        executed: true,
        unresolved: outcome.status === 'failed' && outcome.error.code === 'result_unknown',
      };
    }
  }
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
  /** U3：只读 operation 集合（装配方声明；缺省保守为空 = 一律按可能有副作用处理）。 */
  const readOnlyOperations = new Set(options.readOnlyOperations ?? []);
  /** 本会话回合号（turn 作用域身份 = session + 序号；进程内单调）。 */
  let turnNo = 0;
  const mainTurnMs = options.mainTurnMs ?? DEFAULT_MAIN_TURN_MS;
  const workerTurnMs = options.workerTurnMs ?? DEFAULT_WORKER_TURN_MS;
  const policy = options.policy;
  const dispatchMode: 'inline' | 'background' = options.dispatchMode ?? 'inline';
  const taskRunner = options.taskRunner;
  if (dispatchMode === 'background' && taskRunner === undefined) {
    throw new Error('background 派发需要注入 TaskRunner（装配方构造 runner；此处 fail-closed）。');
  }

  /** 可信 scope：来自装配层渠道事实，绝不来自模型输入（工具参数里也不收身份字段）。 */
  const scope: TaskScope = { principalId: options.principalId, sessionId: options.sessionId };

  /**
   * 任务引用解析：只在**本会话 scope 化列表**内把 `#编号`/taskId 解析成 taskId——
   * 跨会话/跨 principal 的编号自然表现为「找不到」（与不存在同一 TaskOwnershipError，不泄露存在性）。
   */
  function resolveTaskId(ref: string): string {
    const wanted = ref.trim();
    const hit = registry.list(scope).find((task) => (task.taskNo !== undefined && (`#${task.taskNo}` === wanted || String(task.taskNo) === wanted)) || task.taskId === wanted);
    if (hit === undefined) throw new TaskOwnershipError();
    return hit.taskId;
  }

  function refFromArgs(args: Record<string, unknown>): string {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    if (ref === '') throw new Error('缺少任务引用 ref（受理回执里的 #编号）。');
    return ref;
  }

  /** 任务行只读投影：白名单字段，不含内部路径/租约/身份字段。 */
  function statusView(task: TaskRecord): Record<string, unknown> {
    return {
      taskId: task.taskId,
      taskNo: task.taskNo ?? null,
      name: task.name ?? deriveTaskName(task.request),
      status: task.status,
      ...(task.reason === undefined ? {} : { reason: task.reason }),
      ...(task.pendingQuestion === undefined ? {} : { pendingQuestion: task.pendingQuestion }),
      requestIds: task.executions.map((execution) => execution.requestId),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  function taskStatus(args: Record<string, unknown>): unknown {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    if (ref === '') return { tasks: registry.list(scope).map(statusView) };
    return statusView(registry.get(resolveTaskId(ref), scope));
  }

  function taskResult(args: Record<string, unknown>): unknown {
    const task = registry.get(resolveTaskId(refFromArgs(args)), scope);
    return {
      ...statusView(task),
      ...(task.failureReason === undefined ? {} : { failureReason: task.failureReason }),
      // 结果存档：completed 走 complete() 的 resultText；background 终态走 archiveReply 的 replyText。
      replyText: task.replyText ?? null,
      resultText: task.resultText ?? null,
      executions: task.executions.map((execution) => ({
        operation: execution.operation,
        status: execution.status,
        requestId: execution.requestId,
        ...(execution.error === undefined ? {} : { error: execution.error }),
      })),
    };
  }

  /** 取消：复用 runner.cancel，原样转述 CancelOutcome（requested≠cancelled），不宣称已取消。 */
  function taskCancel(args: Record<string, unknown>, runner: TaskRunner): unknown {
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const outcome = runner.cancel(resolveTaskId(refFromArgs(args)), scope);
    return { ...outcome, ...(reason === '' ? {} : { reason }) };
  }

  /** 接续：复用 runner.resume，原样转述 ResumeOutcome（非 waiting_user 由 registry 状态机拒绝）。 */
  function taskResume(args: Record<string, unknown>, runner: TaskRunner): unknown {
    const answer = typeof args.answer === 'string' ? args.answer : '';
    if (answer.trim() === '') throw new Error('task_resume 缺少 answer：请写清对任务待办问题的答复。');
    return runner.resume(resolveTaskId(refFromArgs(args)), { answer, scope });
  }

  const transcriptStore = options.transcriptStore;
  /**
   * 上一回合 Main 转录的**只读投影**（Pi 会话 → 宿主可读形状）。
   * 宿主不持有可变对话历史：当前转录由 `mainTranscript()` 直接向驱动索取
   * （`TurnDriver.transcript()`）；本变量只在驱动尚无会话（首回合）或测试替身没有
   * 该方法时作**种子/回落快照**，每回合整体覆盖、从不追加改写。
   */
  let lastMainProjection: readonly DriverMessage[] = [];
  const mainTranscript = (): readonly DriverMessage[] =>
    options.mainDriver.transcript?.() ?? lastMainProjection;
  let persistedCount = 0;
  // B1 打开→载入：注入存储时现读完整转录，作为**首回合种子历史**（驱动尚无 Pi 会话时导入；
  // 会话已存在时转录仍归 Pi 独占）。宿主不留第二份可变副本，Pi entry-log 是唯一所有者。
  // 读失败 fail-open：不阻塞会话打开（退化为空转录），错误经 onTranscriptError 上报。
  if (transcriptStore !== undefined) {
    try {
      lastMainProjection = await transcriptStore.readTranscript();
      persistedCount = lastMainProjection.length;
    } catch (error) {
      options.onTranscriptError?.(error);
    }
  }
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

  /**
   * U3：本会话的认领/落定入口（只读集合与底账来自装配层；语义见 claimAndRunOperation）。
   */
  async function runOperation(input: {
    scopeKey: string;
    window: RuntimeAttemptWindow;
    operation: string;
    taskId?: string;
    /** 执行回调抛错时的机械处置：unknown = 外部是否生效未知（默认）；propagate = 已知失败，原样抛出。 */
    executeThrows?: 'unknown' | 'propagate';
    execute: (dispatchKey: string) => Promise<ExecutionOutcome>;
  }): Promise<OperationRunResult> {
    return claimAndRunOperation({
      ...input,
      registry,
      readOnlyOperations,
    });
  }

  /** 待核对落任务：running→failed + reason=result_unknown（复用既有状态机，无新状态）。 */
  function markTaskResultUnknown(taskId: string): void {
    try {
      registry.markResultUnknown(taskId);
    } catch (error) {
      // 任务已处于终态：不覆盖既有事实（也不是本机制能改写的事实）。
      if (!(error instanceof TaskTransitionError)) throw error;
    }
  }

  async function executeOperation(
    taskId: string,
    args: Record<string, unknown>,
    window: RuntimeAttemptWindow,
    onUnresolved: () => void,
  ): Promise<ExecutionOutcome> {
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
    const run = await runOperation({
      scopeKey: `task:${taskId}`,
      window,
      operation,
      taskId,
      execute: async (dispatchKey) => {
        // requestId 由宿主生成、每次调用换号（只作追踪）；dispatchKey 是操作身份，不换。
        const requestId = `req_${randomUUID()}`;
        const outcome = await options.client.execute({ requestId, dispatchKey, operation, args: callArgs });
        const record: ExecutionRecord = {
          requestId,
          operation,
          status: outcome.status,
          dispatchKey,
          ...(outcome.status === 'failed' || outcome.status === 'refused' ? { error: outcome.error } : {}),
        };
        // 只有真实执行才写执行行（回放不写：一行 = 一次真实执行）。
        registry.noteExecution(taskId, record);
        return outcome;
      },
    });
    if (run.unresolved) {
      onUnresolved();
      // 确定性终结本回合：不把待核对当作可重试的普通失败，模型不得自动重办。
      throw new ToolUserError(
        run.outcome.status === 'failed' ? run.outcome.error.message : RESULT_UNKNOWN_MESSAGE,
      );
    }
    return run.outcome;
  }

  function workerExec(
    taskId: string,
    window: RuntimeAttemptWindow,
    onUnresolved: () => void,
  ): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
    return async (tool, args) => {
      if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
      return executeOperation(taskId, args, window, onUnresolved);
    };
  }

  /**
   * 受理侧确定性拒绝（背景满员/队列满）：任务经 P2 合法边落终态 failed + resource_limited
   * （running→failed，镜像 inline ⑮ 的拒绝形状），不进入执行、不产生 queued 积压；
   * 回执携带机械事实 accepted:false + reason=resource_limited（用户话术由 Main 层处理）。
   */
  function rejectedBackgroundDelegation(taskId: string, request: string, detail: string): Record<string, unknown> {
    registry.begin({
      taskId,
      principalId: options.principalId,
      sessionId: options.sessionId,
      request,
      status: 'running',
    });
    registry.transition(taskId, 'failed', { reason: 'resource_limited' });
    const rejected = registry.get(taskId, { principalId: options.principalId, sessionId: options.sessionId });
    const taskNo = rejected.taskNo ?? 0;
    const name = rejected.name ?? deriveTaskName(request);
    return {
      taskId,
      taskNo,
      name,
      status: 'failed',
      accepted: false,
      reason: 'resource_limited',
      notice: `未受理 #${taskNo} ${name}：${detail}`,
    };
  }

  async function delegate(taskText: string, foregroundPermit: Permit | undefined): Promise<unknown> {
    const request = taskText.trim();
    if (request === '') throw new Error('run_task 缺少 task：请写清要办什么。');
    const taskId = `task_${randomUUID()}`;

    // P6 background：受理即底账 queued（Main 不等待）；派发/执行/恢复/取消归 TaskRunner。
    if (dispatchMode === 'background') {
      // P7-T06 池满拒绝落点（P6 §七 登记缺口）：受理前按 policy 事实判定——满员且策略
      // 拒绝准入（无队列位）→ 确定性拒绝：任务按 P2 状态机落终态 failed + resource_limited
      // （镜像 inline ⑮ 的拒绝形状），不进入执行；有排队位时受理为 queued（队列 = 底账
      // queued 行，runner 不据 policy 排队许可直派发）。旋钮解释归 policy（单一配置源）。
      if (policy !== undefined) {
        // P0-C 审计修复：受理即以真实 taskId 探测准入（不再只在池满时探测）。除保留池满
        // 确定性拒绝外，这一步让 policy 在受理时建立该任务的共享预算（§2 budgets 以
        // acquire(taskId) 为建账入口）——否则 runner.pump 的匿名许可使 meterRound 的
        // budgetFor(taskId) 全部落「未知任务预算」而静默跳过，后台回合实际消耗不入账。
        const probe = policy.acquire('background', { taskId });
        if (probe.ok === false) {
          return rejectedBackgroundDelegation(taskId, request, probe.message);
        }
        policy.release(probe);
      }
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
    // U3：本交办内的重放窗口（只由 Worker 驱动的原生事件推进；跨交办不继承）。
    const workerWindow = newAttemptWindow();
    let taskUnresolved = false;
    /**
     * 待核对回执（U3）：不当作成功、也不当作已确认失败；任务落 failed + reason=result_unknown，
     * 回执只给机械事实，不自动重试。
     */
    const unresolvedReceipt = (): Record<string, unknown> => {
      markTaskResultUnknown(taskId);
      const task = registry.get(taskId, { principalId: options.principalId, sessionId: options.sessionId });
      return {
        taskId,
        taskNo: task.taskNo ?? null,
        name: task.name ?? deriveTaskName(task.request),
        summary: RESULT_UNKNOWN_MESSAGE,
        executions: task.executions,
        status: 'failed',
        reason: 'result_unknown',
        notice: '这次执行的结果待核对：已停止自动重试，请先核对是否已经发生，再决定是否重办。',
      };
    };
    // P5 运行时计量（owner 授权 3a）：每次 Worker 调用完成后按任务累计调用数与时长。
    // 调用前检查在许可边界：派生 acquire 查共享预算 exhausted → budget_exhausted →
    // 任务 reason=resource_limited（见上，未进入 Worker 即拒）；此处 finally 计量
    // 成功与失败回合（调用已发生、资源已消耗），被拒委派不计。子许可与前台回合许可
    // 共享同一 budget 对象（不复制/不放大），故每条调用只在此计一次；无 taskBudget
    // 时 limits=null → exhausted() 恒 null（零行为变化）；token 无可验证 Pi usage，不计量。
    const workerStartedAt = Date.now();
    try {
      const workerResult = await options.workerDriver.run({
        systemPrompt: renderWorkerSystemPrompt(options.workerWorkspaceRoot),
        tools: [executeOperationTool()],
        messages: [userMessage(renderWorkerDelegation({
          task: request,
          manifest: workerManifest,
          ...(options.workerSkills ? { skills: options.workerSkills } : {}),
        }))],
        onStep: () => {},
        exec: workerExec(taskId, workerWindow, () => { taskUnresolved = true; }),
        deadline: workerDeadline,
        onRuntimeEvent: (event) => noteRuntimeEvent(workerWindow, event),
      });
      // 出现过「无法证明绑定 / 结果未知」：不判成功、不判确认失败，交还待核对。
      if (taskUnresolved) return unresolvedReceipt();
      if (workerResult.text.trim() === '') {
        throw new Error('执行层 Worker 未产出有效汇报，本次任务未完成。');
      }
      registry.complete(taskId, workerResult.text);
      const task = registry.get(taskId, { principalId: options.principalId, sessionId: options.sessionId });
      return { taskId, taskNo: task.taskNo ?? null, summary: workerResult.text, executions: task.executions };
    } catch (error) {
      // 待核对不是确认失败：不覆盖 result_unknown 事实，也不再自动重试。
      if (taskUnresolved) return unresolvedReceipt();
      registry.fail(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      delegationPermit?.budget.consume({ calls: 1, ms: Date.now() - workerStartedAt });
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
      // U3：本回合的 turn 作用域（run_task 逻辑操作身份的作用域）与重放窗口。
      turnNo += 1;
      const turnScopeKey = `turn:${options.sessionId}:${turnNo}`;
      const mainWindow = newAttemptWindow();
      // 宿主只交「本轮输入」：最后一条 user = 本轮文本；历史种子仅在驱动尚无会话时使用。
      const factsMessage = options.taskFactProvider?.(options.principalId, options.sessionId);
      // 历史：驱动已有 Pi 会话时直接读其转录（Pi 独占）；尚无会话（首回合）时回落到
      // 打开时从 B1 存储载入的投影，作为本回合的种子历史（驱动在无会话时才会导入）。
      const liveTranscript = mainTranscript();
      const history = liveTranscript.length > 0 ? liveTranscript : lastMainProjection;
      const turnMessages = [...history, userMessage(text)];
      const mainResult = await options.mainDriver.run({
        systemPrompt: options.mainSystemPrompt,
        tools: [
          runTaskTool(),
          ...(taskRunner === undefined ? [] : [taskStatusTool(), taskResultTool(), taskCancelTool(), taskResumeTool()]),
          ...(options.mainSkillRegistry === undefined ? [] : [readSkillTool()]),
        ],
        messages: turnMessages,
        ...(factsMessage !== undefined && factsMessage.trim() !== '' ? { injections: [factsMessage] } : {}),
        onStep: (step) => progress.push(step),
        exec: async (tool, args) => {
          if (tool === RUN_TASK_TOOL) {
            const task = typeof args.task === 'string' ? args.task : '';
            // U3：run_task 在宿主侧也是一笔有副作用的逻辑操作——先认领落库再委派；
            // 重放窗口内重复的 run_task 返回已有受理回执，不创建第二个任务。
            const run = await runOperation({
              scopeKey: turnScopeKey,
              window: mainWindow,
              operation: RUN_TASK_TOOL,
              executeThrows: 'propagate',
              execute: async () => ({ status: 'completed', data: await delegate(task, foregroundPermit) }),
            });
            if (run.unresolved) {
              return {
                status: 'failed',
                reason: 'result_unknown',
                error: { code: 'result_unknown', message: RESULT_UNKNOWN_MESSAGE, retryable: false },
              };
            }
            const answer = run.outcome.status === 'completed' ? run.outcome.data : run.outcome;
            const taskId = (answer as { taskId?: unknown }).taskId;
            // 回放同一回执时任务只算一次（同一 taskId 不重复记账）。
            if (typeof taskId === 'string' && !taskIds.includes(taskId)) taskIds.push(taskId);
            return answer;
          }
          // 任务查询/治理工具：与工具面同源门控（无 runner 时不暴露、也不受理），fail-closed。
          if (taskRunner !== undefined) {
            if (tool === TASK_STATUS_TOOL) return taskStatus(args);
            if (tool === TASK_RESULT_TOOL) return taskResult(args);
            if (tool === TASK_CANCEL_TOOL) return taskCancel(args, taskRunner);
            if (tool === TASK_RESUME_TOOL) return taskResume(args, taskRunner);
          }
          // 缺口 2 臂 B：read_skill 与工具面同源门控（未注入登记表则不受理）。
          if (tool === READ_SKILL_TOOL && options.mainSkillRegistry !== undefined) {
            const name = typeof args.name === 'string' ? args.name : '';
            const skill = await options.mainSkillRegistry.read(name);
            return { name: skill.name, content: skill.content };
          }
          throw new Error(`Main 工具面之外的调用：${tool}`);
        },
        deadline: currentTurnDeadline,
        onRuntimeEvent: (event) => noteRuntimeEvent(mainWindow, event),
      });
      lastMainProjection = mainResult.messages;
      // 回合后→持久化：把本回合**新增**消息逐条增量追加到存储（Pi 单条 entry 追加 = 线性，
      // 不重写全文），每追加成功一条推进 persistedCount。写失败 fail-open：已成功的追加保留、
      // 剩余不再尝试、**不回滚本回合**（回复照常返回），错误经 onTranscriptError 上报。
      if (transcriptStore !== undefined) {
        while (persistedCount < mainResult.messages.length) {
          try {
            await transcriptStore.append(mainResult.messages[persistedCount]!);
          } catch (error) {
            options.onTranscriptError?.(error);
            break;
          }
          persistedCount += 1;
        }
      }
      // P1（S1）：本回合最终回复逐字存档——同回合各任务行同值；空白回复/回合失败不落
      // （缺省=无最终回复存档，显示层不用执行层汇报冒充）。
      // background：受理话术不落任务行（结果由 runner 在确认 completed 后经 archiveReply
      // 逐字存档，避免受理话术覆盖结果）。
      if (dispatchMode !== 'background' && taskIds.length > 0 && mainResult.text.trim() !== '') {
        registry.archiveReply(taskIds, mainResult.text);
      }
      const executions = taskIds.flatMap((taskId) => registry.get(taskId, scope).executions);
      return { reply: mainResult.text, taskIds, executions, progress };
    } finally {
      releaseForegroundPermit(foregroundPermit);
    }
  }

  return {
    principalId: options.principalId,
    sessionId: options.sessionId,
    transcript: () => mainTranscript(),
    send,
    tasks: () => registry.list(scope),
    getTask: (taskId) => registry.get(taskId, scope),
  };
}

function runTaskTool(): DiscoveredTool {
  return {
    name: RUN_TASK_TOOL,
    description: RUN_TASK_TOOL_DESCRIPTION,
    inputSchema: RUN_TASK_TOOL_SCHEMA,
  };
}

function taskStatusTool(): DiscoveredTool {
  return { name: TASK_STATUS_TOOL, description: TASK_STATUS_TOOL_DESCRIPTION, inputSchema: TASK_STATUS_TOOL_SCHEMA };
}

function taskResultTool(): DiscoveredTool {
  return { name: TASK_RESULT_TOOL, description: TASK_RESULT_TOOL_DESCRIPTION, inputSchema: TASK_RESULT_TOOL_SCHEMA };
}

function taskCancelTool(): DiscoveredTool {
  return { name: TASK_CANCEL_TOOL, description: TASK_CANCEL_TOOL_DESCRIPTION, inputSchema: TASK_CANCEL_TOOL_SCHEMA };
}

function taskResumeTool(): DiscoveredTool {
  return { name: TASK_RESUME_TOOL, description: TASK_RESUME_TOOL_DESCRIPTION, inputSchema: TASK_RESUME_TOOL_SCHEMA };
}

function readSkillTool(): DiscoveredTool {
  return { name: READ_SKILL_TOOL, description: READ_SKILL_TOOL_DESCRIPTION, inputSchema: READ_SKILL_TOOL_SCHEMA };
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
  /**
   * Worker 可信工作目录（渲染进 Worker 系统提示的工作目录约束块）。
   * 来源必须是装配层持有的可信路径（如 profile.root）；不得取模型输出或用户消息。
   * 缺省不注入 = Worker 提示与现行常量逐字节相同。
   */
  workerWorkspaceRoot?: string;
  /**
   * U3：执行层声明为只读的 operation 集合（`access=read` 显式派生；缺省 = 空集，保守）。
   * 只有只读 operation 的重试可以安全重发；写操作重试走回放/待核对。
   */
  readOnlyOperations?: readonly string[];
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
 *   · 转录隔离结构性满足：只持有本次任务投影（request/answer），不接触 Main 会话转录；
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
  const readOnlyOperations = new Set(options.readOnlyOperations ?? []);

  return {
    async execute(task, context): Promise<TaskExecutionOutcome> {
      const recorded: Array<{ operation: string; outcome: ExecutionOutcome }> = [];
      // U3：本交办内的重放窗口（只由 Worker 驱动的原生事件推进）。
      const workerWindow = newAttemptWindow();
      let unresolved = false;
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
        const run = await claimAndRunOperation({
          registry: options.registry,
          readOnlyOperations,
          scopeKey: `task:${task.taskId}`,
          window: workerWindow,
          operation,
          taskId: task.taskId,
          execute: async (dispatchKey) => {
            // requestId 由宿主生成、每次调用换号（只作追踪）；dispatchKey 是操作身份，不换。
            const requestId = `req_${randomUUID()}`;
            const outcome = await options.client.execute({ requestId, dispatchKey, operation, args: callArgs });
            options.registry.noteExecution(task.taskId, {
              requestId,
              operation,
              status: outcome.status,
              dispatchKey,
              ...(outcome.status === 'failed' || outcome.status === 'refused' ? { error: outcome.error } : {}),
            });
            return outcome;
          },
        });
        if (run.unresolved) {
          unresolved = true;
          // 确定性终结本回合：待核对不得被模型当作可重试的普通失败。
          throw new ToolUserError(
            run.outcome.status === 'failed' ? run.outcome.error.message : RESULT_UNKNOWN_MESSAGE,
          );
        }
        if (run.executed) recorded.push({ operation, outcome: run.outcome });
        return run.outcome;
      };

      const deadline = now() + workerTurnMs;
      let workerResult: TurnDriverResult;
      try {
        workerResult = await options.workerDriver.run({
          systemPrompt: renderWorkerSystemPrompt(options.workerWorkspaceRoot),
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
          onRuntimeEvent: (event) => noteRuntimeEvent(workerWindow, event),
        });
      } catch (error) {
        if (context.signal.aborted) return { kind: 'cancelled' };
        // 待核对优先于取消/超时/失败确认：结果未知不是已确认的结局。
        if (unresolved) return { kind: 'result_unknown', reason: RESULT_UNKNOWN_MESSAGE };
        if (isAbortErrorLike(error) && now() >= deadline) return { kind: 'timed_out' };
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      if (context.signal.aborted) return { kind: 'cancelled' };
      if (unresolved) return { kind: 'result_unknown', reason: RESULT_UNKNOWN_MESSAGE };
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
