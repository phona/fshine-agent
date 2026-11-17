/**
 * 回合运行时：Main Pi Agent →（必要时）Worker Pi Agent → Execution Contract → 执行层。
 *
 * 边界（依赖方向）：本模块只依赖 TurnDriver 抽象、执行契约与最小任务底账；
 * 不 import 任何 CLI 适配器、不 import 旧 Runtime 治理模块（import 图由
 * import-boundary.test.ts 静态检查）。执行层客户端由装配方注入。
 *
 * 每回合链路：
 *   1) 用户文本进 Main 转录，mainDriver 跑一个回合；Main 工具面 = task_run（委派）+ 始终可见的
 *      task_status/task_result（只读查询，缺口 1）+（注入 runner 时）task_cancel/task_resume
 *      （取消/接续，缺口 1）+（注入 Main
 *      技能登记表时）read_skill（缺口 2 臂 B，按需读业务技能正文）+（注入 runJsExecutor 时）
 *      run_js（CAP-01 S1：受限代码执行，产物登记进文件区、回合末随 TurnResult.files 交投递面）；
 *   2) task_run 触发委派：宿主生成 taskId（绑定 principal/session）→ Worker 回合
 *      （workerDriver + execute_operation +（注入 runJsExecutor 时）run_js——任务作用域，
 *      CAP-01 S2：输入只解析当前任务的绑定行、产物绑定当前任务并随回合交付）；
 *   3) execute_operation：宿主生成 requestId → client.execute(结构化请求) → 结果回给 Worker；
 *      CAP-01 S2：注入文件桥时出站经桥替换声明的目录参数（物化任务文件），回程 data.files
 *      在 runtime 出口登记成新 file_id 并剥 path/base64（翻译在 assemble 持有的桥，登记在
 *      本出口——不在适配器）；任务收尾兜底扫任务 out/（unexecuted/failed 也在内）；
 *   4) Worker 汇报作为工具结果回到 Main，Main 生成给用户的最终回复；
 *   5) 宿主把本回合最终回复逐字写入本回合各任务行（P1/S1：同回合同值；空白/回合失败不落，
 *      缺省=无最终回复存档，显示层不用执行层汇报冒充）。
 *
 * CAP-01 S1 出口纪律（v8 §7）：用户可见回复在返回前经 stripServerPaths 剥服务器路径（ask/
 * server 同链、task_result 转述同汇，一道尺盖两种来源）；剥完为空且有产出文件时以宿主话术
 * 兜底（FILES_GENERATED_NOTICE）。交付走主动投递（B）：runtime 只在 TurnResult.files 上交
 * 中性文件事实（不 import 渠道类型），发不发、怎么发归宿主装配面。
 *
 * B 类不变量（最小可信边界，拒绝路径见测试）：
 *   · 读路径边界（本切片作用域）：execute_operation 只放行装配方声明的允许集合；
 *     集合外 operation 在**发起执行前**被确定性拒绝（不依赖模型遵守提示词）；
 *   · requestId 由宿主生成，模型不能提供可信身份；
 *   · 任务归属：任务底账绑定 principal/session，越权读取被拒（task-registry.ts）。
 *
 * 本切片不做（不预造接口）：计划门、预算梯子、确认裁决；写确认回环的宿主侧只做三件事——
 * 允许集按装配开关（`runtime.allowWriteOperations`）派生、会话级小表记执行层发放的确认提示、
 * 下一回合把句柄与本回合用户原话原样透传（是否确认由用户表态、执行层校验句柄）。
 * 取消/接续经 task_cancel/task_resume 复用 runner 既有生命周期（不在此新建治理）；
 * 上下文与压缩归 Pi 原生（mainDriver 自带）；这里不另建记忆、检索或投影。
 *
 * R4 集成（P5/P6）：注入 `policy` 时前台回合持许可、inline 委派派生后台许可（共享父预算、
 * 深度 +1、不占并发槽）；`dispatchMode='background'` 时委派改为提交注入的 TaskRunner
 * （受理即 queued，执行/恢复/取消归 runner）；缺省 'inline' = 上文现行为逐字不变。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DiscoveredTool } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, RuntimeTurnEvent, TurnDriver, TurnDriverResult } from './driver-contract';
import { ToolUserError } from './driver-contract';
import { FileRefUnavailableError, safeExtensionOf, type CopiedTaskInput, type TaskInputCopier } from './file-store';
export type { TaskInputCopier } from './file-store';
import type { RunJsExecutor, RunJsOutput } from './run-js-executor';
import type { RecalcXlsxExecutor, RecalcCostEvent } from './recalc-xlsx-executor';
export type {
  RecalcXlsxExecutor,
  RecalcXlsxResult,
  RecalcXlsxInput,
  RecalcErrorCode,
  RecalcCostEvent,
} from './recalc-xlsx-executor';
// 布局收窄的确定性失败面：零 import 模块（runtime 不触 spawn——import 图守卫钉住）。
import {
  RUN_JS_LAYOUT_UNSAFE_MESSAGE,
  RunJsLayoutUnsafeError,
  type RunJsLayoutUnsafeEvent,
} from './run-js-layout';
// 执行层文件桥（CAP-01 S2 ②③④）：装配层构造注入；runtime 只认端口形状（type-only），
// 不持平台路径——翻译/物化/登记/兜底的本体都在桥与 fileStore，runtime 只决定何时调用。
import type { TaskExecutionBridge, TaskExecutionBridgeFactory } from './task-file-bridge';
import { READ_SKILL_TOOL, type SkillRegistry } from './skills';
import { stripServerPaths } from './server-paths';
import { createTaskRegistry, deriveTaskName, DispatchConflictError, TaskTransitionError, TaskOwnershipError, type ExecutionRecord, type PendingQuestion, type TaskRecord, type TaskRegistry, type TaskScope } from './task-registry';
import {
  DEFAULT_RUNTIME_CONFIG,
  taskFailureReasonFor,
  type Permit,
  type RejectionReason,
  type ResourcePolicy,
} from './resource-policy';
import type { TaskExecutionOutcome, TaskExecutor, TaskRunner } from './task-runner';

/** Main 委派工具名（实例名可经部署声明替换的演进留在后续切片；当前用中性名）。 */
export const TASK_RUN_TOOL = 'task_run';
export const TASK_RUN_TOOL_DESCRIPTION =
  '把一项平台任务交给执行层 Worker 执行：在 task 里写清要办什么（对象、范围、口径）。'
  + '返回 Worker 的事实汇报与结构化的执行结果。涉及平台数据的请求一律经它办理。';
/**
 * CAP-01 修复轮（R2-S2，接口事实声明）：注入交办复制面时 task_run 的工具描述——
 * 写清 inputFiles 参数的用法与不带的后果（交办复制零发生 → Worker 无文件 → 任务
 * unexecuted）。只在 `withInputFiles` 的工具面使用；缺省装配（未注入复制面）仍用
 * `TASK_RUN_TOOL_DESCRIPTION` 逐字节不变。只声明参数事实，不写业务流程话术。
 */
export const TASK_RUN_TOOL_DESCRIPTION_WITH_INPUT_FILES =
  TASK_RUN_TOOL_DESCRIPTION
  + '要处理的本会话文件，把文件清单里的 fileId 放进 inputFiles；不带 inputFiles 则 Worker 拿不到任何文件。';
const TASK_RUN_TASK_PROPERTY = {
  type: 'string',
  description: '要交给执行层 Worker 的任务：写清对象、范围与要回答的问题；用自然语言，不要写命令。',
};
export const TASK_RUN_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: TASK_RUN_TASK_PROPERTY,
  },
  required: ['task'],
  additionalProperties: false,
};
/**
 * CAP-01 S2（v8 §4）：注入交办复制面（taskInputCopier）时的 task_run 工具 schema——
 * inputFiles 可选，只收 Main 作用域（文件清单里给出）的 fileId；宿主在交办时复制成
 * 任务私有副本（新 file_id，Worker 只解析当前任务的副本），原件不动。
 * 缺省装配（未注入复制面）不带该属性：工具面与既有逐字节相同（S1 的缺省零变化纪律）。
 */
export const TASK_RUN_TOOL_SCHEMA_WITH_INPUT_FILES: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: TASK_RUN_TASK_PROPERTY,
    inputFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '随任务交给执行层处理的输入文件 fileId 列表（来自文件清单；宿主复制为任务私有副本，原件不动）。',
    },
  },
  required: ['task'],
  additionalProperties: false,
};

/**
 * 对话面任务工具（缺口 1）：把既有 registry/runner 能力以服务端身份授权接到 Main 工具面。
 * 统一纪律：**参数量只收任务引用（`#编号` 或 taskId），绝不收 principalId/sessionId**——scope 由宿主
 * 在 send() 闭包用运行时 principal/session 构造，编号解析在 scope 内做（越权=找不到，不泄露存在性）。
 * 门控按能力拆开：**只读查询 task_status/task_result 只依赖 registry/scope，始终上 Main 工具面**
 * （无 runner 的 inline/ask 也能查已受理任务）；**task_cancel/task_resume 需要 runner 生命周期，
 * 只在注入 `options.taskRunner` 时上/下**（background 模式天然有 runner）。Worker 工具面不含这四个
 * 工具（Worker 不持有宿主任务治理面）。
 */
export const TASK_STATUS_TOOL = 'task_status';
export const TASK_STATUS_TOOL_DESCRIPTION =
  '查询本会话已有任务的状态：ref 给任务列表里的 #编号（如 "#3"）查单个任务，留空列本会话全部任务。'
  + '用户问「那个任务怎么样了 / 在等什么」时用它，不要为此新交办任务。';
export const TASK_STATUS_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '任务引用：任务列表里的 #编号（如 "#3"）；留空列本会话全部任务。' },
  },
  additionalProperties: false,
};

export const TASK_RESULT_TOOL = 'task_result';
export const TASK_RESULT_TOOL_DESCRIPTION =
  '取回本会话某个任务的结果：已完成任务返回其逐字存档结果与执行摘要；未完成任务如实返回当前状态，不编造结果。';
export const TASK_RESULT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '任务引用：任务列表里的 #编号（如 "#3"）。' },
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

/**
 * CAP-01 S1（v8 §2）：Main 的受限代码执行工具。**只在装配方注入 `runJsExecutor` 时上工具面**
 * （缺省零变化：ask/eval 的工具面逐字节不变）；spawn 归执行器，runtime 不 spawn
 * （import 图守卫钉住），scope/物化/产物登记全归宿主，模型只给 code 与 fileId 引用。
 * 没有 deliver 参数、没有 timeoutMs——产物写 out/ 即本回合末交付，超时/上限是宿主常量。
 */
export const RUN_JS_TOOL = 'run_js';
export const RUN_JS_TOOL_DESCRIPTION =
  '运行一段受限的 CommonJS 脚本处理文件：输入文件用文件清单里的 fileId 引用（宿主物化到本次运行目录的 in/，按返回的 materializedName 读取），'
  + '要交付的产物写到 out/ 目录（宿主登记后在本回合末作为附件发出），中间文件写 scratch/。'
  + '超时与资源上限由宿主决定，只能通过把请求调小来适配。'
  // CAP-01 修复轮（R2-S1，接口事实声明）：声明沙箱的模块面——模型此前首调 require("xlsx")
  // （未安装）失败后转去 task_run 兜底建 Task。只声明能力边界，不写业务流程话术。
  + '可用模块只有 exceljs（require("exceljs")，读写 xlsx）；没有 xlsx/xlsx-style/csv-parse 等包。'
  // CAP-01 修复轮（⑤，接口事实声明）：声明输入文件在脚本内的路径约定——清单每条已给出
  // 「脚本内路径」（in/<fileId><安全扩展名>，与宿主物化的 materializedName 同一公式）；
  // 模型此前先写 in/<fileId>（无扩展名）失败一次才改对。路径只由 fileId + 安全扩展名派生，
  // 不由原始文件名拼出（机械事实，不是业务流程话术）。
  + '输入文件在脚本内的路径固定为 in/<fileId><安全扩展名>（文件清单每条已给出「脚本内路径」，按它读取）；'
  + '路径只由 fileId 和安全扩展名派生，不由原始文件名拼出。';
export const RUN_JS_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'CommonJS 脚本原文（宿主原样执行；产物写 out/，中间文件写 scratch/）。' },
    inputs: {
      type: 'array',
      items: { type: 'string' },
      description: '输入文件的 fileId 列表（来自文件清单；宿主物化后按 materializedName 读取）。',
    },
  },
  required: ['code'],
  additionalProperties: false,
};

/**
 * recalc_xlsx（docs/decision-log.md §九十九；owner 裁定 R1–R7 / Q1–Q4）：Main 宿主面的
 * 表格重算读回工具，与 run_js 并列。**Worker 面不上**（裁定 ②/⑥，Q1②）。只在装配方注入
 * `recalcXlsxExecutor` 时上工具面（fail-closed，缺省零变化）；引擎不可用即不上工具面。
 * 描述只声明已实现的参数与后果，不写业务流程话术（tool-description-facts 纪律）。
 */
export const RECALC_XLSX_TOOL = 'recalc_xlsx';
export const RECALC_XLSX_TOOL_DESCRIPTION =
  '对文件清单里的 xlsx 用 LibreOffice 强制重算后读回，报告公式缓存值与计算值不一致（valueDiffs）和错误格（errorCells），'
  + '并可按 export=csv 导出纯数据 CSV。file 只接受本回合运行目录的规范相对路径 in/<fileId><安全扩展名>（文件清单每条已给出脚本内路径）；'
  + '绝对路径、..、多级路径与非规范形式一律拒绝。export=csv 时产物为 out/<name>.values.csv，实算报告在本回合运行目录根 .recalc-report.json（宿主独占，不写 out/）。'
  + '引擎需部署期安装的 LibreOffice 26.8.3（PATH 可见才提供本工具，缺失则本工具不可用）。';
export const RECALC_XLSX_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    file: { type: 'string', description: '本回合运行目录的规范相对路径 in/<fileId><安全扩展名>（来自文件清单的脚本内路径）。' },
    sheet: { type: 'string', description: '可选：只重算并导出指定工作表名；缺省处理全部工作表。' },
    export: { type: 'string', enum: ['csv', 'none'], description: 'csv=导出纯数据 CSV（公式格取计算值）；none=只报告不导出 CSV。' },
  },
  required: ['file', 'export'],
  additionalProperties: false,
};

/**
 * 内存墙话术（CAP-01 ④，owner 裁决）：run_js 子进程因内存退出时，**工具结果与用户可见
 * 话术用同一句**——模型与用户都拿到可执行的下一步（拆分/压缩），不是黑箱的 exit 134。
 * 机械事实（bytes / exitCode / exitSignal / stderrTail）只进结构化事件，不进话术。
 */
export const RUN_JS_MEMORY_EXIT_MESSAGE = '文件太大，处理时内存不足，请拆分或压缩后重试';
/** 事件里 stderr 尾窗的字符数：够看出死法（FATAL ERROR / Allocation failed），不灌满日志。 */
export const RUN_JS_MEMORY_STDERR_TAIL_CHARS = 400;
/** V8/分配器内存墙文案（大小写不敏感；Node 两种死法都覆盖）。 */
const RUN_JS_MEMORY_OOM_PATTERN = /heap out of memory|Allocation failed/i;

/** 内存墙出口的机械事实（结构化事件面；bytes = 输入总字节，见 RunJsAudit.inputBytes）。 */
export interface RunJsMemoryExitEvent {
  readonly runId: string;
  readonly side: 'main' | 'worker';
  /** Worker 面才有任务归属。 */
  readonly taskId?: string;
  readonly bytes: number;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly stderrTail: string;
}

/**
 * 内存墙判据（CAP-01 ④）：宿主主动杀（超时/中止 → killReason 非空）**不算**内存墙——
 * 那是宿主策略出口，话术必须走超时/取消而不是「内存不足」。其余情况按 owner 裁决的
 * 形状：`exitSignal` 非空（如 SIGABRT）或 stderr 含 `heap out of memory` / `Allocation failed`。
 */
export function runJsMemoryExitOf(output: RunJsOutput): Omit<RunJsMemoryExitEvent, 'runId' | 'side' | 'taskId'> | null {
  if (output.audit.killReason !== undefined) return null;
  if (output.exitSignal === null && !RUN_JS_MEMORY_OOM_PATTERN.test(output.stderr)) return null;
  return {
    bytes: output.audit.inputBytes,
    exitCode: output.exitCode,
    exitSignal: output.exitSignal,
    stderrTail: output.stderr.slice(-RUN_JS_MEMORY_STDERR_TAIL_CHARS),
  };
}

/**
 * 布局不安全的结构化事件（symlink 收窄；**只进日志**，不进用户话术）：runId + 哪一项 +
 * 实际类型（executor 机械事实）+ side/taskId（运行时定位）。用户话术统一为
 * RUN_JS_LAYOUT_UNSAFE_MESSAGE（确定性失败，零产物）。
 */
export interface RunJsLayoutUnsafeReport extends RunJsLayoutUnsafeEvent {
  readonly side: 'main' | 'worker';
  /** Worker 面才有任务归属。 */
  readonly taskId?: string;
}

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
  '- 涉及平台数据的请求，用 task_run 工具交给执行层 Worker；不得自行编造或猜测平台数据。',
  '- 收到 Worker 汇报后，用用户能懂的话给出结论与数据；平台没有给出的内容不要补全，也不要声称已验证。',
  '- task_run 返回「已受理/在后台办理中」时，如实告诉用户事情已在后台办理、完成后结果会自动发回来；'
    + '不要向用户提及工单编号（#数字）或内部任务 id——编号只在任务查询工具结果里，给用户说清办的是什么、办到哪一步即可。',
  '- 本轮执行面只开放查询（只读）操作；用户要求写入或变更时，如实说明该能力尚未开通。',
].join('\n');

/**
 * 写面开放时的工具协议义务（仅 `runtime.allowWriteOperations=true` 的装配使用；
 * 缺省仍用 MAIN_PROTOCOL_NOTE，逐字节不变）。只声明接口事实：写操作已上工具面；
 * 执行层返回待确认时把机械摘要转给用户。**不是**计划门或确认裁决——继续与否由用户
 * 表态、执行层校验句柄，宿主不判断用户是否在确认。
 */
export const MAIN_PROTOCOL_NOTE_WITH_WRITES = [
  '【本轮工具协议】',
  '- 涉及平台数据的请求，用 task_run 工具交给执行层 Worker；不得自行编造或猜测平台数据。',
  '- 收到 Worker 汇报后，用用户能懂的话给出结论与数据；平台没有给出的内容不要补全，也不要声称已验证。',
  '- task_run 返回「已受理/在后台办理中」时，如实告诉用户事情已在后台办理、完成后结果会自动发回来；'
    + '不要向用户提及工单编号（#数字）或内部任务 id——编号只在任务查询工具结果里，给用户说清办的是什么、办到哪一步即可。',
  '- 本轮执行面开放查询与写入操作。执行层返回待确认时，把执行层给出的确认摘要原样转给用户；'
    + '用户表态后的下一回合再继续，不要替用户假定已确认。',
  '- 写入是否生效以执行层返回的读回验证为准；执行层返回失败或读回不一致时，如实转述，不得说成成功。',
].join('\n');

/** 按装配的写面开关选工具协议文本（缺省 = 只读原文，零行为变化）。 */
export function mainProtocolNoteFor(allowWriteOperations: boolean): string {
  return allowWriteOperations ? MAIN_PROTOCOL_NOTE_WITH_WRITES : MAIN_PROTOCOL_NOTE;
}

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

/**
 * 任务 out/ 兜底扫描的逐项拒收（机械事实，只进日志）：收尾扫描登记产物时被拒的条目
 * 按机械 reason 汇总（symlink / size_limit / count_limit / outside_run_dir 等）——
 * 拒收原因与数量可查，不进用户话术。
 */
export interface TaskOutputSweepSkippedEvent {
  taskId: string;
  /** 拒收项总数（skipped 明细条数）。 */
  skipped: number;
  /** reason → 数量（同 reason 合并；reason 来自 file-store 的 SkippedOutput.reason）。 */
  reasons: Record<string, number>;
}

/**
 * B 切片（工单回执收敛）：task_run 短等待窗口的时钟端口。只有 now + sleep 两个原语——
 * 窗口轮询复用本端口，不引入定时器/调度框架。缺省 = 系统时钟；测试注入手动时钟保证确定性。
 */
export interface RuntimeClock {
  now(): number;
  /** 让出一次等待（窗口轮询步进）；缺省实现 = 真实 setTimeout。 */
  sleep(ms: number): Promise<void>;
}

/** 缺省时钟（真实系统时钟 + setTimeout 让出）。 */
const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 窗口轮询步长（机械轮询；25ms × 缺省 1500ms 窗口 ≤ 60 次 SQLite 读，开销可忽略）。 */
const TASK_RUN_WAIT_POLL_MS = 25;

export interface RuntimeOptions {
  /** 可信身份：来自装配/渠道事实，绝不来自模型输入。 */
  principalId: string;
  sessionId: string;
  /** 执行层客户端（依赖注入：通用运行时只认接口）。 */
  client: ExecutionClient;
  /**
   * 本轮允许发起的 operation 集合（装配方从执行层自述的声明派生：`access=read` 恒在；
   * `runtime.allowWriteOperations=true` 时追加 `access=write`）。必须非空且全部出现在
   * 能力快照里——否则构造即失败（fail-closed）。
   */
  allowedOperations: readonly string[];
  /** Main 与 Worker 的 Pi 回合驱动（真实实现或测试替身都由装配方注入）。 */
  mainDriver: TurnDriver;
  workerDriver: TurnDriver;
  /** Main 系统提示（角色文本 + 工具协议，由装配方组装；写面开关决定协议文本变体）。 */
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
   * B 切片（工单回执收敛）：task_run 受理后的短等待窗口（ms）。缺省取 runtime 配置解析值
   * （1500）；0 = 不等直接后台。窗口内执行端确认完成 → 结果同回合交给模型（与 inline 同
   * 形状）；超窗 → 机械事实受理回执（不含工单编号），任务留后台推进。
   */
  taskRunWaitMs?: number;
  /**
   * B 切片：窗口轮询时钟（测试确定性注入；缺省系统时钟）。只有 now + sleep 两个原语，
   * 不引入定时器/调度框架。注入实现的 sleep 必须推进时间（否则窗口永不超时——注入契约）。
   */
  taskRunClock?: RuntimeClock;
  /**
   * Main 技能登记表（catalog 非空时由装配层注入）：Main 工具面多一个 read_skill，按登记表内的
   * 技能名读正文（32KiB 上限由 registry 既有钳制）。缺省不注入 = 无该工具（工具面逐字节不变）。
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
   * 纯附件机械事实注入器（与 taskFactProvider 同一 injections 机制）：装配层在纯附件
   * 登记成功后按 (principal, session) 排队；回合开始时取走并以 Pi 原生 custom message
   * （display=false、不触发单独回合）注入主对话。注入器自身保证同 fileId 只出队一次。
   * 事实只含文件名/fileId/字节数/时间，不含路径与内容。缺省不注入 = 无附件事实。
   */
  attachmentFactProvider?: (principalId: string, sessionId: string) => string | undefined;
  /**
   * 宿主主动追问的系统注记注入器（同一 injections 机制）：追问真实送达后入队，下一次
   * 回合注入（模型可见/用户不可见/不触发回合），让模型能把用户的数字回复对应到选项。
   * 缺省不注入 = 无系统注记。
   */
  systemNoteProvider?: (principalId: string, sessionId: string) => string | undefined;
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
  /**
   * CAP-01 S1：run_js 执行器端口（装配层构造注入；runtime 不 spawn——import 图守卫钉住）。
   * 缺省不注入 = Main 工具面没有 run_js（工具面逐字节不变，ask/eval 零变化）。
   */
  runJsExecutor?: RunJsExecutor;
  /**
   * recalc_xlsx 执行器端口（装配层构造注入；缺省不注入 = Main 工具面没有 recalc_xlsx）。
   * 与 run_js 并列的宿主 agent 工具；**Worker 面永不注入**（裁定 R1–R7 / Q1②）。
   * 引擎不可用时执行器 available=false，装配方据此不上工具面（fail-closed）。
   */
  recalcXlsxExecutor?: RecalcXlsxExecutor;
  /**
   * recalc_xlsx 单次重算开销的结构化事件（**只进日志/资源账**，不进用户话术）。
   * engineMs = 引擎耗时；status = 结果状态。缺省静默（不影响回合）。
   */
  onRecalcCost?: (event: RecalcCostEvent & { principalId: string; sessionId: string }) => void;
  /**
   * CAP-01 ④：run_js 子进程撞内存墙的结构化事件（**只进日志**，不进用户话术）。
   * bytes = 输入总字节；exitCode/exitSignal/stderrTail = 退出形状；runId/side/taskId 定位
   * 「是哪次」。缺省静默（不影响回合；用户话术与工具结果仍按判据统一）。
   */
  onRunJsMemoryExit?: (event: RunJsMemoryExitEvent) => void;
  /**
   * CAP-01 symlink 收窄：run_js 运行目录布局不安全的结构化事件（**只进日志**，不进用户话术）。
   * 执行器检测到 runDir/in/out/scratch/home/tmp 任一存在但不是真目录（软链/普通文件等）
   * 即拒跑——脚本零执行、run.cjs 不写、零产物；用户话术统一为
   * RUN_JS_LAYOUT_UNSAFE_MESSAGE（本回合失败），由 ToolUserError 直接终结，不经模型改写。
   */
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
  /**
   * CAP-01 S1 清单注入（机械事实，与 taskFactProvider 同机制）：装配层提供本会话已激活
   * （activated_at IS NOT NULL，TTL 内）文件清单——字段只有 fileId/name/bytes（渲染见
   * renderFileManifest，清单不含内容/宿主路径/sha256；脚本内路径由渲染侧按 fileId 派生）。
   * 每回合开始时调用一次；非空时以普通
   * user-role 消息注入主对话。
   */
  fileManifestProvider?: (principalId: string, sessionId: string) => readonly TurnFileRef[];
  /**
   * CAP-01 S1：run_js 输入引用被拒（越权/不存在/pending/过期/字节缺失）时的机械 reason
   * 上报（**只进日志，不进用户话术**——v8 §4 防存在性 oracle；缺省静默，不影响回合）。
   * S2 起 task_run.inputFiles 的拒绝同走这一回调。
   */
  onFileRefUnavailable?: (reason: string) => void;
  /**
   * CAP-01 S2（v8 §4/§6）：交办复制端口（装配层注入 fileStore 本身——结构满足 Pick）。
   * 注入后 task_run 工具面带 inputFiles；交办时把 Main 作用域输入文件复制成绑定 taskId
   * 的新 file_id（Worker 只解析当前任务的副本，原件不动）。缺省不注入 = 工具面不带
   * inputFiles（逐字节不变），模型传了也 fail-closed 拒绝。
   */
  taskInputCopier?: TaskInputCopier;
  /**
   * CAP-01 S2 ②③④（v8 §6/§10-3）：执行层文件桥工厂（装配层构造，持有 platformRoot；
   * runtime 不持任何平台路径）。按任务构造三件事：出站装饰器替换执行层声明的目录参数并
   * 物化任务文件；回程 data.files 在 runtime 出口经 registerReturnedFiles 登记并剥
   * path/base64（不在适配器登记）；任务收尾经 sweepTaskOutputs 兜底扫任务 out/
   * （unexecuted/failed 也在内，产物不丢）。
   * 缺省不注入 = 现行为逐字节不变（data 原样透传、无目录翻译、无兜底扫描）。
   */
  taskExecutionBridge?: TaskExecutionBridgeFactory;
  /**
   * CAP-01 S2 ④：任务收尾兜底扫描的逐项拒收上报（**只进日志**，不进用户话术）。
   * 扫描成功但有条目被拒时发一次（taskId + 拒收总数 + reason 分布）；缺省静默。
   * 整轮扫描抛错仍走 taskExecutionBridge.onSkip('scan_failed:…')，两者不重复。
   */
  onTaskOutputSweepSkipped?: (event: TaskOutputSweepSkippedEvent) => void;
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

/**
 * 交付面文件引用（v8 §7）：**中性类型，不 import 渠道类型**——渠道形状归渠道适配。
 * 宿主投递面按 fileId 从文件区读字节发出；runtime 只持有机械事实三字段。
 */
export interface TurnFileRef {
  fileId: string;
  name: string;
  bytes: number;
}

/** 回合末只有文件、正文为空时的宿主话术（v8 §7 出口清理；空文本帧会让渠道一个终帧都不发）。 */
export const FILES_GENERATED_NOTICE = '文件已生成（见附件）';

/**
 * 清单行渲染（CAP-01 修复轮 ⑤，机械事实）：name/fileId/bytes 之外，每条给出**脚本内路径**
 * ——与 file-store 物化输入的 materializedName 同一公式（in/<fileId><安全扩展名>，见
 * file-store materializeInputs），只由 fileId + 安全扩展名派生，**不由原始文件名拼路径**。
 * 显示名做机械净化：name 里的路径分隔符与 `..` 序列不进清单文本（name 只用于识别文件；
 * 路径注入面在结构上封死——净化只影响显示，不碰 file_refs 原值）。
 */
function manifestLineOf(file: TurnFileRef): string {
  const displayName = file.name.replaceAll(/(\.\.[/\\]?|[/\\])/g, '_');
  return `- ${displayName}（fileId: ${file.fileId}，${file.bytes} 字节；脚本内路径：in/${file.fileId}${safeExtensionOf(file.name)}）`;
}

/**
 * 文件清单注入文本（CAP-01 S1，机械事实渲染）：每行 name/fileId/bytes + 脚本内路径
 * （in/<fileId><安全扩展名>，CAP-01 修复轮 ⑤）——**清单没有行数据**（不含文件内容、
 * 不含宿主路径、不含 sha256）仍是清单注入的硬边界（v8 §8 S1）。
 */
export function renderFileManifest(files: readonly TurnFileRef[]): string {
  return [
    '[本会话文件清单]（机械事实：以下文件已激活可用；处理文件时用 run_js 的 inputs 按 fileId 引用）',
    ...files.map((file) => manifestLineOf(file)),
  ].join('\n');
}

export interface TurnResult {
  reply: string;
  taskIds: readonly string[];
  executions: readonly ExecutionRecord[];
  /**
   * B 切片（可观测）：本回合经 execute_operation 发起的执行次数（A2 同源计数；后台任务的
   * 执行在后台回合计入任务底账，不计入本字段）。供 message_done 等观测面看「执行面扩散」。
   */
  operations: number;
  /**
   * B 切片（工单回执收敛）：本回合已把执行结果交给模型（模型将向用户转述）的任务。
   * 完成投递面据此抑制——同一份结果不重复发两遍；受理回执路径的任务不在列，
   * 完成后由宿主主动投递面送达原会话。
   */
  relayedTaskIds?: readonly string[];
  /** 进度帧（本回合 onStep 产出；当前只收集，不在此投递渠道）。 */
  progress: readonly string[];
  /**
   * CAP-01 S1（v8 §7）：本回合产出、已登记交付箱的文件（中性类型）。交付去留归宿主
   * 投递面（主动投递 B）；工具返回时不可知，回合末才有值。
   */
  files?: readonly TurnFileRef[];
  /** CAP-01 S1：本回合注入的文件清单字节数（观察项；undefined = 本回合无清单注入）。 */
  fileManifestBytes?: number;
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
/**
 * A2（2026-11-18）：单回合执行 operation 上限的执行侧缺省（与 resource-policy 缺省 5
 * 同值）。注入策略时读策略解析值（单一配置源：runtime 配置的缺省与解释归 resource-policy）；
 * 未注入策略的纯内存会话（测试/嵌入）用本缺省——上界照常生效，不依赖策略注入。
 */
const DEFAULT_MAX_OPERATIONS_PER_TURN = 5;
/** Worker 必须在 Main 截止前留出的收尾余量（Main 还要拿汇报生成用户回复）。 */
const WORKER_DEADLINE_MARGIN_MS = 30_000;

function userMessage(text: string): DriverMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as unknown as DriverMessage;
}

/**
 * Worker 任务文件清单注入文本（CAP-01 S2 ①，机械事实渲染）：每行 name/fileId/bytes +
 * 脚本内路径（in/<fileId><安全扩展名>，CAP-01 修复轮 ⑤，与 Main 清单同一公式）——
 * **清单没有行数据**（不含文件内容、不含宿主路径、不含 sha256，与 Main 清单同一硬
 * 边界，v8 §8）。Worker 只解析当前任务的绑定行（v8 §4），清单给出的是交办副本/任务文件
 * 面的引用面——Main 的源 fileId 不进 Worker 转录。
 */
export function renderWorkerFileManifest(files: readonly TurnFileRef[]): string {
  return [
    '[本任务文件清单]（机械事实：以下文件已随任务交付；处理文件时用 run_js 的 inputs 按 fileId 引用）',
    ...files.map((file) => manifestLineOf(file)),
  ].join('\n');
}

/**
 * 委派块：任务原文 + 能力快照（只含允许集合）+ 任务文件清单（可选）+ 领域技能正文；
 * `answer` = 用户对上一次待办问题的补答（waiting_user 续跑回合），原文交给 Worker——
 * 每个后台回合都是新 Worker（不带上一回合转录），补答不随委派交给执行端就等于丢失。
 */
/**
 * 能力快照标题下的中性事实（A1，2026-11-18）：让模型看见「执行的重量」——成本陈述，
 * **不是阈值规则**：宿主不设阈值、不裁决、不拦截；每个 operation 是否标注估时/重量
 * 由执行层自述（缺省不出现）。只陈述 N 次执行与 N 倍等待/失败面的机械关系。
 */
export const WORKER_SNAPSHOT_COST_NOTE =
  '每个 operation 标注单次估时与重量；一次任务发起 N 次执行，等待与失败面按 N 倍增长。';

/**
 * B 切片（工单回执收敛）：超窗受理回执话术（机械事实：已受理、在后台办理中）。
 * **不含工单编号**——编号只保留在 npm run tasks / 任务查询详情面；Main 协议文本同步
 * 写明不向用户提及编号（回执去编号，反向绊线：话术出现 `#`/编号数字即测试红）。
 */
export function backgroundTaskReceiptNotice(name: string): string {
  return `已受理「${name}」，在后台办理中；完成后结果会自动发给你。`;
}

/** 终态集合（窗口内落定判定）。waiting_user 不是终态——等待接续仍属后台推进。 */
const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'completed',
  'failed',
  'timed_out',
  'unexecuted',
]);

export function renderWorkerDelegation(input: {
  task: string;
  manifest: CapabilityManifest;
  skills?: readonly WorkerSkill[];
  files?: readonly TurnFileRef[];
  answer?: string;
}): string {
  const parts = [
    '## 本次任务（宿主委派）',
    input.task,
    '',
    '## 能力快照（本轮唯一可执行面：只能调用这里登记的 operation）',
    WORKER_SNAPSHOT_COST_NOTE,
    '```json',
    JSON.stringify(input.manifest, null, 2),
    '```',
  ];
  if (input.answer !== undefined && input.answer.trim() !== '') {
    parts.push('', '## 用户补充（对上一次待办问题的答复）', input.answer);
  }
  if (input.files !== undefined && input.files.length > 0) {
    parts.push('', renderWorkerFileManifest(input.files));
  }
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

/**
 * A2 同回合拒话术（2026-11-18）：存在本回合发放、尚未消费的待确认提案时，同一回合内
 * 再发起非只读 operation 一律在**发起前**拒绝。旧纪律只挡句柄透传（同回合 commit 仍会
 * 打到执行层的 CONFIRMATION_NOT_FOUND）；现在以工具错误如实告知模型等用户下一回合表态
 * ——不发起执行、不落执行事实，宿主不判断用户是否在确认。
 */
export const SAME_TURN_CONFIRMATION_PENDING_MESSAGE =
  '待确认提案已生成：需要用户在下一回合确认后才能提交；本回合不再发起新的执行。';

/**
 * A2 单回合 operation 上限话术：如实报数（已发起 N 次 / 上限 M），不是静默失败。
 * 这是资源边界，不是计划门：不判断业务，只数本回合已发起的执行次数。
 */
export function turnOperationLimitMessage(limit: number, used: number): string {
  return `本回合已发起 ${used} 次执行，达到单回合上限 ${limit}：本回合不再发起新的执行；如有需要，请等用户下一回合再继续。`;
}

/** 认领结果的机械处置（runtime 内部；不对外暴露身份键细节）。 */
interface OperationRunResult {
  outcome: ExecutionOutcome;
  /** 本次是否真的发起了执行（false = 回放已有结果）。 */
  executed: boolean;
  /** 必须是「待核对」：调用方不得当作成功，也不得自动重试。 */
  unresolved: boolean;
}

/** 宿主取消（abort）引起的调用终止：不是「结果未知」的另一种写法。 */
function abortError(): Error {
  const error = new Error('执行调用已被取消。');
  error.name = 'AbortError';
  return error;
}

/** 取消在飞调用时的机械结果（读路径可安全放弃；写路径仍走 result_unknown）。 */
function abortedOutcome(message: string): ExecutionOutcome {
  return { status: 'failed', error: { code: 'aborted', message, retryable: true } };
}

/** 取消信号是否已中止（helper 形式：避免 TS 把 await 前的未中止窄化带进 await 之后）。 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 把一次在飞调用与取消信号竞速：signal 中止即拒绝，调用方不必等执行层回执。
 * 被竞速的 promise 仍可能稍后落定——调用方须自行挂 catch（这里不改写它的结果）。
 */
async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * U3：认领 →（仅首次铸造）执行 → 落定。**先落库再调用**：调用执行层之前已有一行
 * claimed（进程死亡窗口里有记录）；重试/恢复后的调用只按窗口读回已持久化行。
 * 无法证明绑定（unresolved）时不发起执行，交还待核对。
 *
 * 取消面（signal）：本行是有副作用/读操作的唯一发起点。信号中止时不再等执行层回执；
 * 读路径落 `failed/aborted`（无副作用可核对），写路径仍落 `unknown`（结果未知优先于取消，
 * 不得把「可能已发生」改写成「已取消」）。迟到回执不会覆盖已落定行（settle 幂等）。
 */
async function claimAndRunOperation(input: {
  registry: TaskRegistry;
  readOnlyOperations: ReadonlySet<string>;
  scopeKey: string;
  window: RuntimeAttemptWindow;
  operation: string;
  taskId?: string;
  /** 宿主取消信号（任务取消/回合中止）；缺省 = 不参与取消（既有行为）。 */
  signal?: AbortSignal;
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
      // 预取消：信号在发起前已中止 → 本次调用不发起（已认领行如实关闭，零执行、零未知）。
      if (input.signal?.aborted === true) {
        const aborted = abortedOutcome('调用在发起前已被取消。');
        input.registry.settleOperation(
          claim.dispatchKey,
          aborted,
          input.taskId === undefined ? {} : { taskId: input.taskId },
        );
        return { outcome: aborted, executed: false, unresolved: false };
      }
      let started: Promise<ExecutionOutcome>;
      try {
        started = input.execute(claim.dispatchKey);
      } catch (error) {
        // 同步抛错的坏实现：与异步拒绝同路。
        started = Promise.reject(error);
      }
      // 竞速只取「谁先落定」；取消胜出后，迟到的回执不得变成未处理拒绝。
      void started.catch(() => undefined);
      let outcome: ExecutionOutcome;
      try {
        outcome = await raceWithAbort(started, input.signal);
      } catch (error) {
        if (isAborted(input.signal) && isAbortErrorLike(error)) {
          // 宿主取消在飞调用：不再等待回执。
          if (input.executeThrows === 'propagate') {
            input.registry.settleOperation(
              claim.dispatchKey,
              abortedOutcome('调用被宿主取消。'),
              input.taskId === undefined ? {} : { taskId: input.taskId },
            );
            throw error;
          }
          if (readOnly) {
            // 读路径没有副作用要核对：如实落 aborted（可安全重试），不污染成 unknown。
            const aborted = abortedOutcome('调用被宿主取消。');
            input.registry.settleOperation(
              claim.dispatchKey,
              aborted,
              input.taskId === undefined ? {} : { taskId: input.taskId },
            );
            return { outcome: aborted, executed: true, unresolved: false };
          }
          // 写路径：取消在飞写操作仍不能断言「没发生」——结果未知优先（U3）。
          input.registry.markOperationUnknown(claim.dispatchKey, 'cancelled_mid_flight');
          return {
            outcome: { status: 'failed', error: { code: 'result_unknown', message: RESULT_UNKNOWN_MESSAGE, retryable: false } },
            executed: true,
            unresolved: true,
          };
        }
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
  /** 本回合用户原话（`send(text)` 原文；只作确认请求的 userText 透传，宿主不改写）。 */
  let currentUserText = '';
  /**
   * 会话级待确认句柄（最小状态；不是语义层、不做历史检索）：
   *   · 收到 needs_confirmation 时记 { handle, summary, expiresAt, issuedTurn }；
   *   · **下一回合**的 execute_operation 才把句柄与本回合用户原话原样透传给执行层；
   *   · 执行层返回后清除（不判断回执是不是「接受」——那是执行层的语义）。
   * 键 = 会话自身身份 (principalId, sessionId)：一个 createSession 一张表，不跨会话共享。
   */
  let pendingConfirmation:
    | { handle: string; summary: string; expiresAt?: string; issuedTurn: number }
    | undefined;
  const mainTurnMs = options.mainTurnMs ?? DEFAULT_MAIN_TURN_MS;
  const workerTurnMs = options.workerTurnMs ?? DEFAULT_WORKER_TURN_MS;
  const policy = options.policy;
  /**
   * A2：单回合执行 operation 上限。注入策略时读策略解析值（缺省与解释归 resource-policy，
   * 不在运行时重读 runtime 配置）；未注入策略时用执行侧同值缺省——上界照常生效。
   */
  const maxOperationsPerTurn = policy !== undefined
    ? policy.snapshot().config.maxOperationsPerTurn
    : DEFAULT_MAX_OPERATIONS_PER_TURN;
  /** A2：本回合已发起的执行次数（send 时清零；跨本回合全部委派合计）。 */
  let operationsThisTurn = 0;
  const dispatchMode: 'inline' | 'background' = options.dispatchMode ?? 'inline';
  const taskRunner = options.taskRunner;
  if (dispatchMode === 'background' && taskRunner === undefined) {
    throw new Error('background 派发需要注入 TaskRunner（装配方构造 runner；此处 fail-closed）。');
  }
  // B 切片：task_run 短等待窗口（单一配置源 = runtime 解析值；未走配置解析的纯内存会话同值缺省）。
  const taskRunWaitMs = options.taskRunWaitMs ?? DEFAULT_RUNTIME_CONFIG.taskRunWaitMs;
  const taskRunClock = options.taskRunClock ?? SYSTEM_RUNTIME_CLOCK;

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
    if (ref === '') throw new Error('缺少任务引用 ref（任务列表里的 #编号）。');
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

  /**
   * 输入文件引用不可用的统一话术（run_js.inputs 与 task_run.inputFiles 同用）：
   * 越权/不存在/pending/过期/字节缺失同码同话术——v8 §4 防存在性 oracle。
   */
  const FILE_INPUT_UNAVAILABLE_MESSAGE =
    '输入文件不可用：引用的文件不存在、未激活或已过期；请只用文件清单里给出的 fileId 引用输入文件。';

  /** 文件工具的 scope（宿主持有的可信身份；模型参数里没有身份字段）。 */
  const fileScope = { principalId: options.principalId, sessionId: options.sessionId };

  /**
   * fileId 数组参数解析（run_js.inputs 与 task_run.inputFiles 同形状同纪律）：
   * 非数组 / 空 fileId 确定性拒绝；字符串逐个 trim（空串拒绝，不静默丢弃）。
   */
  function parseFileIdList(raw: unknown, tool: string, field: string): string[] {
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new Error(`${tool} 的 ${field} 必须是 fileId 数组。`);
    }
    return (raw ?? []).map((item) => {
      const fileId = typeof item === 'string' ? item.trim() : '';
      if (fileId === '') throw new Error(`${tool} 的 ${field} 含空 fileId（请用文件清单里给出的 fileId）。`);
      return fileId;
    });
  }

  /** run_js 的模型可见结果（v8 §2 形状；audit/runDir 等机械路径不进转录）。 */
  function runJsToolResult(output: RunJsOutput): Record<string, unknown> {
    const result = {
      exitCode: output.exitCode,
      exitSignal: output.exitSignal,
      stdout: output.stdout,
      stderr: output.stderr,
      stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated,
      inputs: output.audit.materializedInputs.map((item) => ({
        fileId: item.fileId,
        name: item.name,
        materializedName: item.materializedName,
      })),
      outputs: output.outputs,
    };
    // CAP-01 ④：内存墙时工具结果也带同一句话术——模型不必猜 exit 134 的含义，且不会把
    // 「处理完成」写进用户回复（用户可见层在 send() 出口同句覆盖，见 lastMemoryWall）。
    return runJsMemoryExitOf(output) === null ? result : { ...result, error: RUN_JS_MEMORY_EXIT_MESSAGE };
  }

  /** 内存墙结构化事件（真实运行一次报一次；memo 命中不重复上报）。 */
  function noteRunJsMemoryExit(output: RunJsOutput, side: 'main' | 'worker', taskId?: string): void {
    const exit = runJsMemoryExitOf(output);
    if (exit === null) return;
    options.onRunJsMemoryExit?.({
      runId: output.audit.runId,
      side,
      ...(taskId === undefined ? {} : { taskId }),
      ...exit,
    });
  }

  /**
   * CAP-01 S1 run_js 回合内执行（v8 §2/§5）：
   *   · 幂等（v8 §5）：进程内 Map（memo 由 send() 随回合创建、随回合丢弃），key = 本回合号
   *     + sha256(code) + 排序后的 inputs——**Pi 原生重试不产生新 send()**，重试同键命中不重跑；
   *     不用 attempt（每次 recovery +1 会换键重跑）；跨重启不保证（重启后渠道重投是新回合）。
   *   · 输入引用（照 resolveTaskId 的写法）：参数面只收 fileId 数组；权威校验（scope/激活/TTL/
   *     字节）归执行器侧 fileStore.materializeInputs——这里把「越权/不存在/pending/过期/字节
   *     缺失」收成**同一句**话术抛回（不泄露存在性），机械 reason 经 onFileRefUnavailable 只进日志。
   *   · 产物：executor 无论 exitCode 都扫 out/ 登记；登记事实收进 turnFiles（回合末 TurnResult.files，
   *     交付去留归宿主投递面——工具返回时不可知）。
   */
  async function runJsInTurn(
    args: Record<string, unknown>,
    memo: Map<string, RunJsOutput>,
    turnFiles: TurnFileRef[],
    setMemoryWall: (hit: boolean) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const executor = options.runJsExecutor;
    if (executor === undefined) throw new Error(`Main 工具面之外的调用：${RUN_JS_TOOL}`);
    const code = typeof args.code === 'string' ? args.code : '';
    if (code.trim() === '') throw new Error('run_js 缺少 code（CommonJS 脚本原文）。');
    const inputs = parseFileIdList(args.inputs, 'run_js', 'inputs');
    const memoKey = `${turnNo}:${createHash('sha256').update(code, 'utf8').digest('hex')}:${[...inputs].sort().join('|')}`;
    const hit = memo.get(memoKey);
    if (hit !== undefined) {
      // memo 命中：结果原样回放；用户可见话术取本回合最后一次 run_js 的出口事实。
      setMemoryWall(runJsMemoryExitOf(hit) !== null);
      return runJsToolResult(hit);
    }
    let output: RunJsOutput;
    try {
      output = await executor.runJs({
        code,
        ...(inputs.length > 0 ? { inputs } : {}),
        scope: fileScope,
        // 取消信号必须贯穿到执行器：否则任务取消/宿主中止后脚本仍跑到自然结束或 120s 超时。
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof FileRefUnavailableError) {
        // 机械 reason 只进日志；模型与用户只见统一话术（防存在性 oracle，v8 §4）。
        options.onFileRefUnavailable?.(error.reason);
        throw new Error(FILE_INPUT_UNAVAILABLE_MESSAGE);
      }
      if (error instanceof RunJsLayoutUnsafeError) {
        // 布局收窄（symlink）：机械事实（哪一项/类型/runId）进结构化事件；用户只见确定性
        // 失败话术——ToolUserError 由 driver 直接作为最终回复（本回合失败，零产物）。
        options.onRunJsLayoutUnsafe?.({ ...error.event, side: 'main' });
        throw new ToolUserError(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
      }
      throw error;
    }
    memo.set(memoKey, output);
    noteRunJsMemoryExit(output, 'main');
    setMemoryWall(runJsMemoryExitOf(output) !== null);
    turnFiles.push(...output.outputs.map((file) => ({ fileId: file.fileId, name: file.name, bytes: file.bytes })));
    return runJsToolResult(output);
  }

  /** 交付事实按 fileId 去重（回程登记 + 兜底扫描同池去重后，同一产物不重复进交付面）。 */
  function pushTurnFileOnce(list: TurnFileRef[], file: { fileId: string; name: string; bytes: number }): void {
    if (list.some((existing) => existing.fileId === file.fileId)) return;
    list.push({ fileId: file.fileId, name: file.name, bytes: file.bytes });
  }

  /**
   * 执行层返回里的 data.files 条目（CAP-01 S2 ③）：completed/needs_input 的 data 为
   * 普通对象且 files 是数组时才消费——data 对宿主不透明，其余形状一律不动。
   */
  function outcomeFileEntriesOf(outcome: ExecutionOutcome): readonly unknown[] | undefined {
    if (outcome.status !== 'completed' && outcome.status !== 'needs_input') return undefined;
    const data = outcome.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const files = (data as { files?: unknown }).files;
    return Array.isArray(files) ? files : undefined;
  }

  /**
   * CAP-01 S2 ③ 回程登记（v8 §6）：**runtime 出口**，不在适配器——执行层返回的
   * data.files[...] 经桥登记成新 file_id（任务产物池 sha256 去重），登记事实替换原条目
   * （path 与内联 base64 不进转录、不进底账落定）；登记事实并入任务交付收集。
   * 未注入桥时 outcome 原样（零变化缺省）。
   */
  async function registerOutcomeReturnedFiles(
    outcome: ExecutionOutcome,
    exchange: TaskExecutionBridge,
    taskFiles: TurnFileRef[],
  ): Promise<ExecutionOutcome> {
    const entries = outcomeFileEntriesOf(outcome);
    if (entries === undefined) return outcome;
    const registered = await exchange.registerReturnedFiles(entries);
    for (const file of registered.files) {
      pushTurnFileOnce(taskFiles, file);
    }
    // 登记事实替换 data.files（path/base64 从 data 里剥掉）；其余字段原样。
    if (outcome.status === 'completed') {
      return { status: 'completed', data: { ...(outcome.data as Record<string, unknown>), files: registered.entries } };
    }
    if (outcome.status !== 'needs_input') return outcome;
    return {
      status: 'needs_input',
      missing: outcome.missing,
      data: { ...((outcome.data as Record<string, unknown> | undefined) ?? {}), files: registered.entries },
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  /**
   * CAP-01 S2 ① Worker 的 run_js 回合内执行（v8 §2/§4/§5）：与 Main 的 runJsInTurn 同一
   * 形状，差异只在任务作用域——输入只解析当前任务的绑定行（{side:'worker', taskId}），
   * 产物登记绑定当前任务并并入本任务交付收集。幂等（v8 §5）用**委派级**进程内 Map
   * （随 delegate 创建、随 delegate 丢弃；不用 attempt，Pi 原生重试同键命中不重跑）。
   */
  async function runJsInWorkerTurn(
    taskId: string,
    args: Record<string, unknown>,
    memo: Map<string, RunJsOutput>,
    taskFiles: TurnFileRef[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const executor = options.runJsExecutor;
    if (executor === undefined) throw new Error(`Worker 工具面之外的调用：${RUN_JS_TOOL}`);
    const code = typeof args.code === 'string' ? args.code : '';
    if (code.trim() === '') throw new Error('run_js 缺少 code（CommonJS 脚本原文）。');
    const inputs = parseFileIdList(args.inputs, 'run_js', 'inputs');
    const memoKey = `${createHash('sha256').update(code, 'utf8').digest('hex')}:${[...inputs].sort().join('|')}`;
    const hit = memo.get(memoKey);
    if (hit !== undefined) return runJsToolResult(hit);
    let output: RunJsOutput;
    try {
      output = await executor.runJs({
        code,
        ...(inputs.length > 0 ? { inputs } : {}),
        scope: fileScope,
        taskId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof FileRefUnavailableError) {
        // 机械 reason 只进日志；模型与用户只见统一话术（防存在性 oracle，v8 §4）。
        options.onFileRefUnavailable?.(error.reason);
        throw new Error(FILE_INPUT_UNAVAILABLE_MESSAGE);
      }
      if (error instanceof RunJsLayoutUnsafeError) {
        // 布局收窄（symlink）：与 Main 同一确定性失败话术；Worker 面附任务归属进日志。
        options.onRunJsLayoutUnsafe?.({ ...error.event, side: 'worker', taskId });
        throw new ToolUserError(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
      }
      throw error;
    }
    memo.set(memoKey, output);
    // 执行事实入账（2026-11-17 修）：Worker 的 run_js 是**真实执行**，必须进底账——完成判定
    // （judgeReportedTask）只看执行事实，不进账会出现两种假象：①查询成功 + 脚本失败仍判
    // completed；②只靠脚本完成的任务被判 unexecuted。
    // 宿主超时杀进程组（killReason=timeout）同样是一次真实执行的失败结局（脚本没跑完）：
    // 超时只杀脚本、Worker 仍有预算并正常汇报，不写失败事实会让「查询成功 + 脚本超时」判
    // completed（假绿）。abort 不写——取消/宿主中止由取消路径定性，不能把取消说成失败。
    const killReason = output.audit.killReason;
    if (killReason !== 'abort') {
      const scriptOk = killReason === undefined && output.exitCode === 0;
      registry.noteExecution(taskId, {
        requestId: `runjs_${output.audit.runId}`,
        operation: RUN_JS_TOOL,
        status: scriptOk ? 'completed' : 'failed',
        dispatchKey: `runjs:${output.audit.runId}`,
        ...(scriptOk
          ? {}
          : {
              error: killReason === 'timeout'
                ? {
                    code: 'run_js_timeout',
                    message: 'run_js 脚本超时被终止',
                    retryable: false,
                  }
                : {
                    code: 'run_js_failed',
                    message: `run_js 脚本以非零退出码结束（exit=${String(output.exitCode)}）`,
                    retryable: false,
                  },
            }),
      });
    }
    // 内存墙事件：Worker 面没有用户可见回复（汇报经 Main 转述），但机械事实必须可查。
    noteRunJsMemoryExit(output, 'worker', taskId);
    for (const file of output.outputs) {
      pushTurnFileOnce(taskFiles, file);
    }
    return runJsToolResult(output);
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
    /** 宿主取消信号：中止在飞调用，不再等执行层回执。 */
    signal?: AbortSignal;
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

  /**
   * 本回合要透传的确认引用（宿主只做传递，不解释句柄、不判断用户是否在确认）：
   *   · 只在**下一回合**透传——同一回合 prepare 后立刻 commit 不算用户表态；
   *   · 只读 operation 不消耗用户的确认（执行层不会把确认用于读调用）；
   *   · userText = 本回合用户原话（原样，不改写）。
   */
  function confirmationForOperation(operation: string): { handle: string; userText: string } | undefined {
    if (pendingConfirmation === undefined) return undefined;
    if (pendingConfirmation.issuedTurn >= turnNo) return undefined;
    if (readOnlyOperations.has(operation)) return undefined;
    return { handle: pendingConfirmation.handle, userText: currentUserText };
  }

  /**
   * 模型可见的执行结果：needs_confirmation 只给机械摘要（summary/expiresAt）与 data——
   * 句柄是宿主持有的确认凭据，不进模型转录；模型无法伪造/转交句柄，透传只发生在
   * 下一回合的宿主请求里。其余状态原样交回模型。
   */
  function modelVisibleOutcome(outcome: ExecutionOutcome): Record<string, unknown> {
    if (outcome.status !== 'needs_confirmation') return outcome as unknown as Record<string, unknown>;
    return {
      status: 'needs_confirmation',
      summary: outcome.confirmation.summary,
      ...(outcome.confirmation.expiresAt === undefined ? {} : { expiresAt: outcome.confirmation.expiresAt }),
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
    };
  }

  async function executeOperation(
    taskId: string,
    args: Record<string, unknown>,
    window: RuntimeAttemptWindow,
    onUnresolved: () => void,
    exchange?: TaskExecutionBridge,
    taskFiles?: TurnFileRef[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const operation = typeof args.operation === 'string' ? args.operation : '';
    if (operation === '') throw new Error('execute_operation 缺少 operation。');
    if (!allowed.has(operation)) {
      // 允许集合边界：集合外的 operation 在发起执行前被拒——不依赖模型遵守提示词。
      throw new Error(`「${operation}」不在本轮允许集合内，未发起执行。`);
    }
    // A2 同回合拒（2026-11-18）：存在**本回合**发放、尚未消费的待确认提案时，同一回合内
    // 再发起非只读 operation 一律不执行——同回合 commit 不是用户表态（旧纪律只挡住了句柄
    // 透传，模型仍会反复 commit 打到执行层的 CONFIRMATION_NOT_FOUND）。以工具错误如实
    // 告知模型等用户下一回合表态；不发起执行、不落执行事实。只读 operation 不受影响。
    if (
      pendingConfirmation !== undefined
      && pendingConfirmation.issuedTurn >= turnNo
      && !readOnlyOperations.has(operation)
    ) {
      throw new Error(SAME_TURN_CONFIRMATION_PENDING_MESSAGE);
    }
    // A2 单回合上界（资源边界，不是计划门）：本回合已发起次数达到上限时，后续调用在
    // 发起前被拒并如实告知；不判断业务。计数在发起前同步推进（含随后的每次真实发起，
    // 被拒/回放的调用不计——它们没有走到这里）。
    if (operationsThisTurn >= maxOperationsPerTurn) {
      throw new Error(turnOperationLimitMessage(maxOperationsPerTurn, operationsThisTurn));
    }
    operationsThisTurn += 1;
    const rawArgs = args.args;
    const callArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
    // CAP-01 S2 ②：注入文件桥时出站走装饰器（声明目录参数替换 + 任务文件物化在桥内）；
    // 未注入时零变化（原客户端直连）。
    const client = exchange !== undefined ? exchange.client : options.client;
    const run = await runOperation({
      scopeKey: `task:${taskId}`,
      window,
      operation,
      taskId,
      ...(signal === undefined ? {} : { signal }),
      execute: async (dispatchKey) => {
        // requestId 由宿主生成、每次调用换号（只作追踪）；dispatchKey 是操作身份，不换。
        const requestId = `req_${randomUUID()}`;
        // 写确认回环：存在未消费的会话级句柄时，把它与本回合用户原话原样放进同一次 execute。
        const confirmation = confirmationForOperation(operation);
        let outcome = await client.execute(
          {
            requestId,
            dispatchKey,
            operation,
            args: callArgs,
            ...(confirmation === undefined ? {} : { confirmation }),
          },
          signal === undefined ? undefined : { signal },
        );
        // 执行层已返回：本次透传结束，宿主侧句柄清除（是否真的被接受由执行层回执说明；
        // 宿主不判断确认语义）。
        if (confirmation !== undefined) pendingConfirmation = undefined;
        // 取消后到达的回执不落执行事实：任务已按取消处置，迟到的成功不得冒充本回合结果。
        if (signal?.aborted === true) throw abortError();
        // CAP-01 S2 ③：回程登记在 runtime 出口（不在适配器）——登记 data.files、剥
        // path/base64 后，落定与转录只见登记事实。未注入桥时 outcome 原样（零变化）。
        if (exchange !== undefined && taskFiles !== undefined) {
          outcome = await registerOutcomeReturnedFiles(outcome, exchange, taskFiles);
        }
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
    // 取消胜出：不再把（可能迟到的）执行结果交回 Worker；让回合按 abort 收尾。
    if (signal?.aborted === true) throw abortError();
    // 执行层发来新的确认提示：记进会话级小表（替换旧句柄），模型只拿 summary。
    if (run.outcome.status === 'needs_confirmation') {
      pendingConfirmation = {
        handle: run.outcome.confirmation.handle,
        summary: run.outcome.confirmation.summary,
        ...(run.outcome.confirmation.expiresAt === undefined
          ? {}
          : { expiresAt: run.outcome.confirmation.expiresAt }),
        issuedTurn: turnNo,
      };
    }
    return modelVisibleOutcome(run.outcome);
  }

  /**
   * Worker exec 面（CAP-01 S2 ①）：execute_operation +（注入 runJsExecutor 时）run_js。
   * run_js 只在工具面开启时受理（fail-closed：未注入执行器的直调被拒）；文件桥与任务交付
   * 收集随 delegate 传入（缺省装配两者皆缺省——零变化）。
   */
  function workerExec(
    taskId: string,
    window: RuntimeAttemptWindow,
    onUnresolved: () => void,
    files?: { exchange?: TaskExecutionBridge; taskFiles?: TurnFileRef[]; runJsMemo?: Map<string, RunJsOutput> },
  ): (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> {
    return async (tool, args, signal) => {
      if (tool === RUN_JS_TOOL) {
        if (options.runJsExecutor === undefined || files?.runJsMemo === undefined || files.taskFiles === undefined) {
          throw new Error(`Worker 工具面之外的调用：${tool}`);
        }
        return runJsInWorkerTurn(taskId, args, files.runJsMemo, files.taskFiles, signal);
      }
      if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
      return executeOperation(taskId, args, window, onUnresolved, files?.exchange, files?.taskFiles, signal);
    };
  }

  /**
   * B 切片：短等待窗口内轮询任务终态（注入时钟让出；窗口内未落定返回 undefined）。
   * waiting_user 不是终态（等待接续仍属后台推进）——窗口内进入等待也按超窗回执处理，
   * 补问经既有通知事实注入与 task_resume 接续。轮询只读底账，不写任何状态。
   */
  async function waitForTaskSettled(taskId: string, waitMs: number): Promise<TaskRecord | undefined> {
    const deadline = taskRunClock.now() + waitMs;
    for (;;) {
      const task = registry.get(taskId, scope);
      if (SETTLED_TASK_STATUSES.has(task.status)) return task;
      if (taskRunClock.now() >= deadline) return undefined;
      await taskRunClock.sleep(TASK_RUN_WAIT_POLL_MS);
    }
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
    const name = rejected.name ?? deriveTaskName(request);
    return {
      taskId,
      name,
      status: 'failed',
      accepted: false,
      reason: 'resource_limited',
      // B 切片回执去编号：受理/拒绝话术不含工单编号（编号只在 npm run tasks / 任务查询详情面）。
      notice: `未受理「${name}」：${detail}`,
    };
  }

  async function delegate(
    taskText: string,
    rawInputFiles: unknown,
    foregroundPermit: Permit | undefined,
    turnFiles: TurnFileRef[],
  ): Promise<unknown> {
    const request = taskText.trim();
    if (request === '') throw new Error('task_run 缺少 task：请写清要办什么。');
    const taskId = `task_${randomUUID()}`;
    // CAP-01 S2（v8 §4/§6）：inputFiles 的解析与交办复制全部发生在建任务行/进 Worker 之前——
    // 任一 fileId 不可用 → 整次拒绝（不部分执行、不留任务行、零副本）。
    const inputFiles = parseFileIdList(rawInputFiles, 'task_run', 'inputFiles');
    // S2 边界（v8 §8）：交办复制只做 inline——background 派发不静默丢文件，确定性拒绝。
    if (inputFiles.length > 0 && dispatchMode === 'background') {
      throw new Error('task_run 的 inputFiles 暂不支持 background 派发（文件交办当前只做 inline）。');
    }
    let copiedInputs: CopiedTaskInput[] = [];
    if (inputFiles.length > 0) {
      const copier = options.taskInputCopier;
      // 与 run_js/read_skill 同一门控纪律：未注入复制面不受理，fail-closed。
      if (copier === undefined) throw new Error('task_run 的 inputFiles 未开通（当前装配没有文件复制面）。');
      try {
        copiedInputs = copier.copyInputsForTask({ scope: fileScope, fileIds: inputFiles, taskId });
      } catch (error) {
        if (error instanceof FileRefUnavailableError) {
          // 机械 reason 只进日志；模型与用户只见统一话术（防存在性 oracle，v8 §4）。
          options.onFileRefUnavailable?.(error.reason);
          throw new Error(FILE_INPUT_UNAVAILABLE_MESSAGE);
        }
        throw error;
      }
    }

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
        // 后台受理上界（复用 queueCapacity；行为与前台一致：满即拒绝，不阻塞排队）。
        // 探测为排队许可 = 并发位已满；此时底账 queued 行数必须 < queueCapacity 才受理，
        // 否则第 capacity+1 个等待者确定性拒绝，不产生新的 queued 积压。队列事实源仍是
        // 底账 queued 行（policy 等待位不充当第二套队列，探测许可立即释放）。
        const saturated = probe.state === 'queued';
        policy.release(probe);
        if (saturated) {
          const capacity = policy.snapshot().queueCapacity;
          const queued = registry.list().filter((task) => task.status === 'queued').length;
          if (queued >= capacity) {
            return rejectedBackgroundDelegation(taskId, request, `后台排队已满（容量 ${capacity}）`);
          }
        }
      }
      const accepted = taskRunner!.submit({
        taskId,
        principalId: options.principalId,
        sessionId: options.sessionId,
        request,
      });
      taskRunner!.pump();
      const name = accepted.name ?? deriveTaskName(request);
      // B 切片（工单回执收敛）：短等待窗口（runtime.taskRunWaitMs，缺省 1500ms；0 = 不等）。
      // 窗口内执行端确认 completed → 与 inline 同形状把结果交给模型（同回合、零受理回执、
      // 零主动投递——结果不重复发两遍）；超窗 → 机械事实受理回执（不含工单编号），任务留
      // 后台推进，完成后由宿主完成投递面把结果发回原会话。
      if (taskRunWaitMs > 0) {
        const settled = await waitForTaskSettled(taskId, taskRunWaitMs);
        if (settled !== undefined) {
          if (settled.status === 'completed') {
            return {
              taskId,
              taskNo: settled.taskNo ?? null,
              // 后台结果逐字存档在 replyText（runner settle 经 archiveReply 写）；inline 的
              // resultText 由 complete() 写——两处兼容读取，与 inline 同形状交给模型。
              summary: settled.replyText ?? settled.resultText ?? '',
              executions: settled.executions,
            };
          }
          // 窗口内落定的非完成终态：与 inline 失败同语义如实上抛（失败/取消不冒充进行中）。
          throw new Error(settled.failureReason ?? `后台任务已落定（${settled.status}）。`);
        }
      }
      const live = registry.get(taskId, scope);
      return {
        taskId,
        name,
        status: live.status,
        accepted: true,
        notice: backgroundTaskReceiptNotice(name),
      };
    }

    // CAP-01 S2 ①③④：任务作用域的 Worker 工具面（run_js）、执行层文件桥与本任务交付收集。
    // 全部随本委派创建、随本委派丢弃（未注入执行器/桥 = 零变化缺省）；background 派发
    // 不经过这里（S2 文件面只做 inline——后台 Worker 工具面与回程登记归后续切片）。
    const taskFiles: TurnFileRef[] = [];
    const taskExchange = options.taskExecutionBridge === undefined ? undefined : options.taskExecutionBridge(taskId);
    const workerRunJsMemo = new Map<string, RunJsOutput>();

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
        // CAP-01 S2 ①：Worker 工具面 = execute_operation +（注入执行器时）run_js（任务作用域）。
        tools: [executeOperationTool(), ...(options.runJsExecutor === undefined ? [] : [runJsTool()])],
        messages: [userMessage(renderWorkerDelegation({
          task: request,
          manifest: workerManifest,
          ...(options.workerSkills ? { skills: options.workerSkills } : {}),
          // CAP-01 S2 ①：交办副本的任务文件清单（机械事实 fileId/name/bytes）——Worker 只解析
          // 当前任务的绑定行，Main 的源 fileId 不进 Worker 转录（v8 §4）。
          ...(copiedInputs.length > 0
            ? { files: copiedInputs.map((copy) => ({ fileId: copy.fileId, name: copy.name, bytes: copy.bytes })) }
            : {}),
        }))],
        onStep: () => {},
        exec: workerExec(taskId, workerWindow, () => { taskUnresolved = true; }, {
          ...(taskExchange === undefined ? {} : { exchange: taskExchange }),
          taskFiles,
          runJsMemo: workerRunJsMemo,
        }),
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
      // CAP-01 S2 ④ 产物不丢（v8 §10-3）：任务收尾（completed/failed/unexecuted/待核对
      // 一律）兜底扫任务 out/ 登记剩余产物——执行层写了文件但 outcome 没带回 data.files
      // （失败/中止）时不丢；与回程登记同池去重。未注入桥 = 无兜底面（零变化缺省）。
      if (taskExchange !== undefined) {
        const swept = taskExchange.sweepTaskOutputs();
        // 拒收明细此前被丢弃（只有整轮扫描失败才经 onSkip 上报）：按 reason 汇总成
        // 结构化事件——数量与原因可查；只进日志，不进用户话术。
        if (swept.skipped.length > 0) {
          const reasons: Record<string, number> = {};
          for (const item of swept.skipped) {
            reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
          }
          options.onTaskOutputSweepSkipped?.({ taskId, skipped: swept.skipped.length, reasons });
        }
        for (const file of swept.files) {
          pushTurnFileOnce(taskFiles, file);
        }
      }
      // 本任务产物并入本回合交付事实（交付去留归宿主投递面，工具返回时不可知）。
      for (const file of taskFiles) {
        pushTurnFileOnce(turnFiles, file);
      }
      delegationPermit?.budget.consume({ calls: 1, ms: Date.now() - workerStartedAt });
      if (delegationPermit !== undefined && policy !== undefined) {
        policy.release(delegationPermit);
      }
    }
  }

  async function send(text: string): Promise<TurnResult> {
    const foregroundPermit = await acquireForegroundPermit();
    try {
      // 本回合用户原话：确认请求的 userText 原样取自这里（不改写、不解释）。
      currentUserText = text;
      const progress: string[] = [];
      const taskIds: string[] = [];
      // B 切片：本回合已把执行结果交给模型（模型将向用户转述）的任务——完成投递面据此抑制。
      const relayedTaskIds: string[] = [];
      // CAP-01 S1：本回合产出文件（run_js 交付箱登记事实；回合末进 TurnResult.files）。
      const turnFiles: TurnFileRef[] = [];
      // run_js 幂等（v8 §5）：局部 Map 随本回合创建、随本回合丢弃（进程内、跨重启不保证）。
      const runJsMemo = new Map<string, RunJsOutput>();
      // CAP-01 ④：本回合**最后一次** run_js 是否撞内存墙——是则用户可见回复在出口统一覆盖成
      // 内存墙话术（模型文本不得把 OOM 讲成「处理完成」；最后一次成功重试则按成功交付）。
      let lastMemoryWall = false;
      currentTurnDeadline = Date.now() + mainTurnMs;
      // U3：本回合的 turn 作用域（task_run 逻辑操作身份的作用域）与重放窗口。
      turnNo += 1;
      // A2：单回合执行计数随回合清零（上界按回合计，不跨回合累计）。
      operationsThisTurn = 0;
      const turnScopeKey = `turn:${options.sessionId}:${turnNo}`;
      const mainWindow = newAttemptWindow();
      // 宿主只交「本轮输入」：最后一条 user = 本轮文本；历史种子仅在驱动尚无会话时使用。
      const factsMessage = options.taskFactProvider?.(options.principalId, options.sessionId);
      // 纯附件机械事实（文件名/fileId/字节数/时间，不含路径）与主动追问的系统注记
      // （模型可见/用户不可见）走同一 injections 机制；take 即出队（同 fileId 只注入一次）。
      const attachmentFactsMessage = options.attachmentFactProvider?.(options.principalId, options.sessionId);
      const systemNoteMessage = options.systemNoteProvider?.(options.principalId, options.sessionId);
      // CAP-01 S1 清单注入（机械事实）：本会话已激活文件，字段只有 fileId/name/bytes；
      // 字节数作为观察项随 TurnResult 带出（fileManifestBytes）。
      const manifestFiles = options.fileManifestProvider?.(options.principalId, options.sessionId) ?? [];
      const manifestMessage = manifestFiles.length > 0 ? renderFileManifest(manifestFiles) : undefined;
      const manifestBytes = manifestMessage === undefined ? undefined : Buffer.byteLength(manifestMessage, 'utf8');
      // 历史：驱动已有 Pi 会话时直接读其转录（Pi 独占）；尚无会话（首回合）时回落到
      // 打开时从 B1 存储载入的投影，作为本回合的种子历史（驱动在无会话时才会导入）。
      const liveTranscript = mainTranscript();
      const history = liveTranscript.length > 0 ? liveTranscript : lastMainProjection;
      const turnMessages = [...history, userMessage(text)];
      const injections = [
        ...(factsMessage !== undefined && factsMessage.trim() !== '' ? [factsMessage] : []),
        ...(attachmentFactsMessage !== undefined && attachmentFactsMessage.trim() !== '' ? [attachmentFactsMessage] : []),
        ...(manifestMessage !== undefined ? [manifestMessage] : []),
        ...(systemNoteMessage !== undefined && systemNoteMessage.trim() !== '' ? [systemNoteMessage] : []),
      ];
      const mainResult = await options.mainDriver.run({
        systemPrompt: options.mainSystemPrompt,
        tools: [
          // CAP-01 S2：task_run 的 schema 是否带 inputFiles 取决于交办复制面注入（缺省零变化）。
          taskRunTool(options.taskInputCopier !== undefined),
          // 只读查询只依赖 registry/scope——始终可见（无 runner 的 inline/ask 也能查任务）。
          taskStatusTool(),
          taskResultTool(),
          // 取消/接续需要 runner 生命周期：无 runner 不上面（fail-closed）。
          ...(taskRunner === undefined ? [] : [taskCancelTool(), taskResumeTool()]),
          ...(options.mainSkillRegistry === undefined ? [] : [readSkillTool()]),
          // CAP-01 S1：run_js 只在装配方注入执行器时上工具面（缺省零变化，fail-closed）。
          ...(options.runJsExecutor === undefined ? [] : [runJsTool()]),
          // recalc_xlsx：仅 Main 宿主面、仅引擎可用时上工具面（Worker 面永不注入）。
          ...(options.recalcXlsxExecutor === undefined || !options.recalcXlsxExecutor.available
            ? []
            : [recalcXlsxTool()]),
        ],
        messages: turnMessages,
        ...(injections.length > 0 ? { injections } : {}),
        onStep: (step) => progress.push(step),
        exec: async (tool, args, signal) => {
          if (tool === TASK_RUN_TOOL) {
            const task = typeof args.task === 'string' ? args.task : '';
            // U3：task_run 在宿主侧也是一笔有副作用的逻辑操作——先认领落库再委派；
            // 重放窗口内重复的 task_run 返回已有受理回执，不创建第二个任务。
            const run = await runOperation({
              scopeKey: turnScopeKey,
              window: mainWindow,
              operation: TASK_RUN_TOOL,
              executeThrows: 'propagate',
              execute: async () => ({ status: 'completed', data: await delegate(task, args.inputFiles, foregroundPermit, turnFiles) }),
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
            if (typeof taskId === 'string' && !taskIds.includes(taskId)) {
              taskIds.push(taskId);
              // B 切片：带 summary = 结果已在本回合交给模型（模型将向用户转述）——完成投递面
              // 对这些任务抑制，同一份结果不重复发两遍；受理回执路径不在列（完成后主动投递）。
              if (answer !== null && typeof answer === 'object' && 'summary' in answer) {
                relayedTaskIds.push(taskId);
              }
            }
            return answer;
          }
          // 任务只读查询：不依赖 runner，始终受理（scope 仍取宿主闭包，越权=找不到）。
          if (tool === TASK_STATUS_TOOL) return taskStatus(args);
          if (tool === TASK_RESULT_TOOL) return taskResult(args);
          // 任务治理工具：与工具面同源门控（无 runner 时不暴露、也不受理），fail-closed。
          if (taskRunner !== undefined) {
            if (tool === TASK_CANCEL_TOOL) return taskCancel(args, taskRunner);
            if (tool === TASK_RESUME_TOOL) return taskResume(args, taskRunner);
          }
          // 缺口 2 臂 B：read_skill 与工具面同源门控（未注入登记表则不受理）。
          if (tool === READ_SKILL_TOOL && options.mainSkillRegistry !== undefined) {
            const name = typeof args.name === 'string' ? args.name : '';
            const skill = await options.mainSkillRegistry.read(name);
            return { name: skill.name, content: skill.content };
          }
          // CAP-01 S1：run_js 与工具面同源门控（未注入执行器则不受理），fail-closed。
          if (tool === RUN_JS_TOOL && options.runJsExecutor !== undefined) {
            return runJsInTurn(args, runJsMemo, turnFiles, (hit) => {
              lastMemoryWall = hit;
            }, signal);
          }
          // recalc_xlsx 与工具面同源门控（未注入或引擎不可用则不受理），fail-closed。
          if (tool === RECALC_XLSX_TOOL) {
            const executor = options.recalcXlsxExecutor;
            if (executor === undefined || !executor.available) {
              throw new Error(`Main 工具面之外的调用：${tool}`);
            }
            const file = typeof args.file === 'string' ? args.file : '';
            const sheet = typeof args.sheet === 'string' ? args.sheet : undefined;
            const exportMode = args.export === 'csv' ? 'csv' : args.export === 'none' ? 'none' : undefined;
            if (file === '' || exportMode === undefined) {
              throw new Error('recalc_xlsx 需要 file 与 export（csv|none）。');
            }
            // Codex R11-P2：调用前预检共享预算——foregroundPermit 只取一次，consume 不拒绝，
            // 不预检则同一回合可无限次重算、绕过 taskBudget。耗尽即拒跑（fail-closed）。
            const exhausted = foregroundPermit?.budget.exhausted();
            if (exhausted !== undefined && exhausted !== null) {
              throw new Error(`超出本次任务资源预算（${exhausted.reason}），recalc_xlsx 未执行。`);
            }
            // 结果原样交回模型（status/errorCells/valueDiffs/artifacts）；CSV 等产物由
            // 执行器登记进 fileStore 并随 result.outputs 交回（Codex P2-4，与 run_js 同一
            // 交付纪律）——handler 在此把产物收进 turnFiles，交付去留归宿主投递面。
            // R4 资源账（Gap1）：LO 重算耗时入前台预算 + 结构化事件，不静默消耗预算。
            const recalcStartedAt = Date.now();
            const result = await executor.recalc({
              file,
              ...(sheet === undefined ? {} : { sheet }),
              export: exportMode,
              scope: fileScope,
              ...(signal === undefined ? {} : { signal }),
            });
            const engineMs = result.durationMs ?? (Date.now() - recalcStartedAt);
            foregroundPermit?.budget.consume({ calls: 1, ms: engineMs });
            options.onRecalcCost?.({
              engineMs,
              status: result.status,
              principalId: options.principalId,
              sessionId: options.sessionId,
            });
            // P2-4：CSV 产物收口进本回合交付清单（与 run_js:turnFiles.push 同纪律）。
            if (result.outputs !== undefined) {
              turnFiles.push(...result.outputs.map((f) => ({ fileId: f.fileId, name: f.name, bytes: f.bytes })));
            }
            return result;
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
      // 出口清理（v8 §7）：用户可见回复在宿主出口剥服务器路径——ask/server 同走这一道链，
      // task_result 存档被 Main 转述后同样汇到这里，一道尺盖住两种来源（2026-10-19 事故形状）。
      // 剥完为空且有文件 → 宿主话术兜底（空文本帧会让渠道一个终帧都不发，用户什么都收不到）。
      const stripped = stripServerPaths(mainResult.text);
      let reply = stripped.text;
      // CAP-01 ④：内存墙是宿主可确定的失败事实——用户可见话术与工具返回同一句，不让模型
      // 的自由文本掩盖（其余出口清理与兜底逻辑不变）。
      if (lastMemoryWall) reply = RUN_JS_MEMORY_EXIT_MESSAGE;
      else if (reply.trim() === '' && turnFiles.length > 0) reply = FILES_GENERATED_NOTICE;
      // P1（S1）：本回合最终回复逐字存档——同回合各任务行同值；空白回复/回合失败不落
      // （缺省=无最终回复存档，显示层不用执行层汇报冒充）。存档用出口清理后的最终回复
      // （用户看到什么，task_result 就是什么）。
      // background：受理话术不落任务行（结果由 runner 在确认 completed 后经 archiveReply
      // 逐字存档，避免受理话术覆盖结果）。
      if (dispatchMode !== 'background' && taskIds.length > 0 && reply.trim() !== '') {
        registry.archiveReply(taskIds, reply);
      }
      const executions = taskIds.flatMap((taskId) => registry.get(taskId, scope).executions);
      return {
        reply,
        taskIds,
        executions,
        // B 切片（可观测）：本回合经 execute_operation 发起的执行次数（A2 同源计数）。
        operations: operationsThisTurn,
        ...(relayedTaskIds.length > 0 ? { relayedTaskIds } : {}),
        progress,
        ...(turnFiles.length > 0 ? { files: turnFiles } : {}),
        ...(manifestBytes === undefined ? {} : { fileManifestBytes: manifestBytes }),
      };
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

/** CAP-01 S2：inputFiles 属性只在注入交办复制面时出现（缺省工具面逐字节不变）。 */
function taskRunTool(withInputFiles: boolean): DiscoveredTool {
  return {
    name: TASK_RUN_TOOL,
    // CAP-01 修复轮（R2-S2）：描述与 schema 同步——inputFiles 上工具面时，描述才声明
    // inputFiles 的用法与后果；缺省面仍用原描述（逐字节不变，也不宣传不存在的参数）。
    description: withInputFiles ? TASK_RUN_TOOL_DESCRIPTION_WITH_INPUT_FILES : TASK_RUN_TOOL_DESCRIPTION,
    inputSchema: withInputFiles ? TASK_RUN_TOOL_SCHEMA_WITH_INPUT_FILES : TASK_RUN_TOOL_SCHEMA,
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

function runJsTool(): DiscoveredTool {
  return { name: RUN_JS_TOOL, description: RUN_JS_TOOL_DESCRIPTION, inputSchema: RUN_JS_TOOL_SCHEMA };
}

function recalcXlsxTool(): DiscoveredTool {
  return {
    name: RECALC_XLSX_TOOL,
    description: RECALC_XLSX_TOOL_DESCRIPTION,
    inputSchema: RECALC_XLSX_TOOL_SCHEMA,
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
 *
 * 写确认边界：needs_confirmation 的会话级句柄表与下一回合原话透传只接在**前台会话**
 * （createSession 的 send 回合）上——后台单回合执行器没有「下一回合」概念，也不持有
 * 用户原话。后台模式打开写面时，需要确认的写操作会确定性落 failed（不谎报 completed）；
 * 写确认的产品链路当前由 inline 派发承接（登记见本切片说明，不在此预造后台确认状态机）。
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
      const exec = async (
        tool: string,
        args: Record<string, unknown>,
        execSignal?: AbortSignal,
      ): Promise<unknown> => {
        // 取消信号：Pi 回合的 abort signal（父级取消 + 截止）优先；驱动未传时回落到任务信号。
        const signal = execSignal ?? context.signal;
        if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (operation === '') throw new Error('execute_operation 缺少 operation。');
        if (!allowed.has(operation)) {
          throw new Error(`「${operation}」不在本轮允许集合内，未发起执行。`);
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
          signal,
          execute: async (dispatchKey) => {
            // requestId 由宿主生成、每次调用换号（只作追踪）；dispatchKey 是操作身份，不换。
            const requestId = `req_${randomUUID()}`;
            const outcome = await options.client.execute(
              { requestId, dispatchKey, operation, args: callArgs },
              { signal },
            );
            // 取消后到达的回执不落执行事实：任务已按取消处置，迟到的成功不得冒充本回合结果。
            if (signal.aborted) throw abortError();
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
        // 取消胜出：不再把（可能迟到的）执行结果交回 Worker；让回合按 abort 收尾。
        if (signal.aborted) throw abortError();
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
            // waiting_user 续跑回合：用户补答必须随委派交给执行端（新 Worker 没有上一回合转录）。
            ...(task.answer === undefined ? {} : { answer: task.answer }),
          }))],
          onStep: () => {},
          exec,
          deadline,
          signal: context.signal,
          onRuntimeEvent: (event) => noteRuntimeEvent(workerWindow, event),
        });
      } catch (error) {
        // 待核对优先于取消/超时/失败确认：结果未知不是已确认的结局。写操作已进入 unknown 后
        // 同回合被取消，任务仍是「待核对」——取消只停止后续动作，不把未知改写成 cancelled。
        if (unresolved) return { kind: 'result_unknown', reason: RESULT_UNKNOWN_MESSAGE };
        if (context.signal.aborted) return { kind: 'cancelled' };
        if (isAbortErrorLike(error) && now() >= deadline) return { kind: 'timed_out' };
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      // 同上：正常返回路径也必须先判待核对，再判取消。
      if (unresolved) return { kind: 'result_unknown', reason: RESULT_UNKNOWN_MESSAGE };
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
