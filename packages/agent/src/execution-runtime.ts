/**
 * 回合运行时：Main Pi Agent →（必要时）Worker Pi Agent → Execution Contract → 执行层。
 *
 * 边界（依赖方向）：本模块只依赖 TurnDriver 抽象、执行契约与最小任务底账；
 * 不 import 任何 CLI 适配器、不 import 旧 Runtime 治理模块（import 图由
 * import-boundary.test.ts 静态检查）。执行层客户端由装配方注入。
 *
 * 每回合链路：
 *   1) 用户文本进 Main 转录，mainDriver 跑一个回合；Main 工具面 = task_run（委派）+ 始终可见的
 *      task_status/task_result（只读查询，缺口 1）+（注入 runner 时）task_cancel/task_resume/
 *      task_confirm（取消/接续/显式确认，缺口 1）+（注入 Main
 *      技能登记表时）read_skill（缺口 2 臂 B，按需读业务技能正文）+（注入 runJsExecutor 时）
 *      run_js（CAP-01 S1：受限代码执行；片 2 起 Main 面写 out/ **不登记、不产交付物**——
 *      交付物只从 Worker 出，需要交付文件请 task_run 交办）；
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
 * 中性文件事实（不 import 渠道类型），发不发、怎么发归宿主装配面。片 2 起 TurnResult.files
 * 的来源只有 Worker（inline 委派的任务产物；后台任务经 TaskExecutionOutcome.files 上交）。
 *
 * B 类不变量（最小可信边界，拒绝路径见测试）：
 *   · 读路径边界（本切片作用域）：execute_operation 只放行装配方声明的允许集合；
 *     集合外 operation 在**发起执行前**被确定性拒绝（不依赖模型遵守提示词）；
 *   · requestId 由宿主生成，模型不能提供可信身份；
 *   · 任务归属：任务底账绑定 principal/session，越权读取被拒（task-registry.ts）。
 *
 * 本切片不做（不预造接口）：计划门、预算梯子、确认裁决；写确认回环的宿主侧只做三件事——
 * 允许集按装配开关（`runtime.allowWriteOperations`）派生、记执行层发放的确认提示、
 * 把句柄与本回合用户原话原样透传（是否确认由用户表态、执行层校验句柄）。后台任务路径的
 * 透传**只发生在用户显式确认**（`task_confirm` → `runner.confirm()`）；`task_resume`
 *（补充/改口径）不带句柄（2026-11-19 显式确认切片）。
 * 取消/接续/确认经 task_cancel/task_resume/task_confirm 复用 runner 既有生命周期（不在此新建治理）；
 * 上下文与压缩归 Pi 原生（mainDriver 自带）；这里不另建记忆、检索或投影。
 *
 * R4 集成（P5/P6）：注入 `policy` 时前台回合持许可、同步委派派生后台许可（共享父预算、
 * 深度 +1、不占并发槽）；`taskDispatch='async'` 时委派改为提交注入的 TaskRunner
 * （受理即 queued，执行/恢复/取消归 runner）；缺省 'sync' = 上文现行为逐字不变。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DiscoveredTool } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionArgDeclaration,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, RuntimeTurnEvent, TurnDriver, TurnDriverResult, WakeResult } from './driver-contract';
import { ToolUserError } from './driver-contract';
import { FileRefUnavailableError, safeExtensionOf, type CopiedTaskInput, type TaskInputCopier } from './file-store';
export type { TaskInputCopier } from './file-store';
import { classifyFailure, confirmationExpiredMessage, failureMessageFor, type UserFacingFailureKind } from './user-facing-failure';
import {
  createDeterministicRetryLock,
  type RetryAllowed,
  type RetryBlock,
} from './deterministic-retry-lock';
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
import type { TaskExecutionOutcome, TaskExecutor, TaskRunner, ResumedOperation } from './task-runner';

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
 * （无 runner 的 inline/ask 也能查已受理任务）；**task_cancel/task_resume/task_confirm 需要 runner
 * 生命周期，只在注入 `options.taskRunner` 时上/下**（background 模式天然有 runner）。Worker 工具面
 * 不含这些工具（Worker 不持有宿主任务治理面）。
 */
export const TASK_STATUS_TOOL = 'task_status';
/** 任务列表默认条数上限（新→旧）。会话历史越长越容易让模型抓错对象，默认只给最近的。 */
const TASK_STATUS_LIST_LIMIT = 10;
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
  '当已有任务在等待用户补齐信息、改口径或说别的（不是确认提交）时，用用户的答复把同一任务接续下去（编号不变）。'
  + 'ref 可省略：本会话只有一个等待中的任务时直接接续它。'
  + '**它不会提交待确认的写入**——用户是在确认（「确认」「对，就这版」「提交吧」）时改用 task_confirm。'
  + '不确定用户是在确认还是在改口径时，先用一句话问清（给出版本摘要），不要自己选。';
export const TASK_RESUME_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '等待中的任务引用：#编号（可省略，本会话仅一个等待中的任务时）。' },
    answer: { type: 'string', description: '对任务待办问题的答复，用用户原话的意思写清。' },
  },
  required: ['answer'],
  additionalProperties: false,
};

/**
 * 显式确认工具（2026-11-19 owner 拍板）：确认是一个**显式动作**，不是「下一条消息的默认含义」。
 * 只有用户明确表示「按这版提交」时才用它——宿主从底账取该任务的待确认提案，把任务接续下去，
 * 并把确认凭据交给执行端。用户补充信息 / 改口径 / 说了别的用 task_resume（不带凭据）。
 * 拿不准用什么时先问用户，不要替用户选。
 */
export const TASK_CONFIRM_TOOL = 'task_confirm';
export const TASK_CONFIRM_TOOL_DESCRIPTION =
  '用户明确表示「按这版提交」时，确认并提交该任务上一轮给出的待确认提案（编号不变）。'
  + 'ref 可省略：本会话只有一个等待确认的提案时直接用它。'
  + '只在用户明确确认时用；用户补充信息 / 改口径 / 说了别的用 task_resume。'
  + '拿不准用户是在确认还是在改口径时，先用一句话问清（给出版本摘要），不要自己选。';
export const TASK_CONFIRM_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '等待确认的任务引用：#编号（可省略，本会话仅一个等待确认的提案时）。' },
  },
  additionalProperties: false,
};

/**
 * 「没有可确认/接续对象」时给模型的机械事实（owner 2026-11-19：宿主不再替模型说话）。
 * 只陈述事实，措辞归模型；不是给用户的成句话术，不进任何宿主替换路径。
 */
export const NO_WAITING_TARGET_FACT = '当前没有等待确认的任务。';
export const NO_WAITING_RESUME_TARGET_FACT = '当前没有等待接续的任务。';

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
 * 没有 deliver 参数、没有 timeoutMs——超时/上限是宿主常量。
 *
 * 片 2（owner 2026-11-18：交付物只从 Worker 出）：**Main 面的 out/ 不可写、不登记、不交付**——
 * 权限层收窄（执行器 `writableDirs:'scratch-only'`，写 out/ 得 ERR_ACCESS_DENIED）+ 结构性
 * 禁止登记（`registerOutputs:false`），不是提示词请求。要交付文件 = task_run 交办
 * 给 Worker；scratch/ 是 Main 的唯一可写工作区（中间文件，不产交付物）。
 * **Worker 面用另一份描述**（WORKER_RUN_JS_TOOL_DESCRIPTION）：Worker 的 out/ 就是交付箱。
 */
export const RUN_JS_TOOL = 'run_js';
export const RUN_JS_TOOL_DESCRIPTION =
  '运行一段受限的 CommonJS 脚本处理文件：输入文件用文件清单里的 fileId 引用（宿主物化到本次运行目录的 in/，按返回的 materializedName 读取）。'
  + 'scratch/ 是工作区（中间文件写这里），主会话只能写 scratch/——写 out/ 会被权限拒绝（不是静默丢弃）；需要交付文件请 task_run 交办。'
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
/**
 * Worker 面的 run_js 描述（片 2 拆出）：Worker 的 out/ 是本任务的交付箱（登记成任务文件、
 * 随任务完成投递）；**不提 task_run**（Worker 不能再交办——不做跨工具流程诱导）。
 */
export const WORKER_RUN_JS_TOOL_DESCRIPTION =
  '运行一段受限的 CommonJS 脚本处理文件：输入文件用文件清单里的 fileId 引用（宿主物化到本次运行目录的 in/，按返回的 materializedName 读取），'
  + '要交付的产物写到 out/ 目录（宿主登记后随本任务完成投递），中间文件写 scratch/。'
  + '超时与资源上限由宿主决定，只能通过把请求调小来适配。'
  + '可用模块只有 exceljs（require("exceljs")，读写 xlsx）；没有 xlsx/xlsx-style/csv-parse 等包。'
  + '输入文件在脚本内的路径固定为 in/<fileId><安全扩展名>（文件清单每条已给出「脚本内路径」，按它读取）；'
  + '路径只由 fileId 和安全扩展名派生，不由原始文件名拼出。';
export const RUN_JS_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'CommonJS 脚本原文（宿主原样执行；中间文件写 scratch/）。' },
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
 * recalc_xlsx（docs/decisions/index.md §九十九；owner 裁定 R1–R7 / Q1–Q4）：Main 宿主面的
 * 表格重算读回工具，与 run_js 并列。**Worker 面不上**（裁定 ②/⑥，Q1②）。只在装配方注入
 * `recalcXlsxExecutor` 时上工具面（fail-closed，缺省零变化）；引擎不可用即不上工具面。
 * 描述只声明已实现的参数与后果，不写业务流程话术（tool-description-facts 纪律）。
 */
export const RECALC_XLSX_TOOL = 'recalc_xlsx';
export const RECALC_XLSX_TOOL_DESCRIPTION =
  '对文件清单里的 xlsx 用 LibreOffice 强制重算后读回，报告公式缓存值与计算值不一致（valueDiffs）和错误格（errorCells），'
  + '并可按 export=csv 导出纯数据 CSV。file 只接受本回合运行目录的规范相对路径 in/<fileId><安全扩展名>（文件清单每条已给出脚本内路径）；'
  + '绝对路径、..、多级路径与非规范形式一律拒绝。export=csv 时产物为 out/<name>.values.csv（name 取自输入文件的用户可见名），'
  + 'CSV 是宿主内部诊断产物，不投递给用户；实算报告在本回合运行目录根 .recalc-report.json（宿主独占，不写 out/）。'
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

/**
 * 允许集合边界拒绝话术（宿主在**发起执行前**确定性拒绝，2026-11-19 RBAC 切片）。
 *
 * 不暴露内部 operation 名：用户不需要知道执行层的 operation 目录，只需知道「当前权限
 * 不支持」。拒绝仍由宿主允许集合在发起前一次性判定（零执行、零执行事实），不依赖模型
 * 遵守提示词；角色求交发生在装配层（allowedOperations 派生）。
 */
export const OPERATION_NOT_PERMITTED_MESSAGE = '当前权限不支持这个操作。';

/** Worker 唯一工具名：结构化执行入口（宿主生成 requestId，模型只给 operation + args）。 */
export const EXECUTE_OPERATION_TOOL = 'execute_operation';
export const EXECUTE_OPERATION_TOOL_DESCRIPTION =
  '发起一次结构化执行。operation 必须是本轮能力快照里登记的 operation 名；'
  + 'args 按该 operation 声明的参数名填写（对宿主不透明，形状由执行层校验）。返回执行层的状态与数据。';
export const EXECUTE_OPERATION_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: { type: 'string', description: '本轮能力快照里登记的 operation 名。' },
    args: {
      type: 'object',
      description: '该 operation 声明的参数（参数名见快照的 args 声明）。结构化参数（数组/对象）直接把值放进来，宿主负责序列化——不要手拼 JSON 字符串。',
    },
  },
  required: ['operation'],
  additionalProperties: false,
};

/**
 * Main 的静态协议义务（本切片的中性措辞；不含执行层实例名与业务字段）。
 * 装配方把它接在角色文本之后（agent.md 负责角色，这里只负责本轮工具协议）。
 */

/**
 * 载荷型参数装信封（宿主侧；owner 2026-11-19）：模型给结构化**值** → 桥 lint+落盘 → 用文件
 * 路径替换该参数，再提交执行层。未声明 payload 参数 = args 原样返回（零变化）。
 *
 * 失败处置（都在**发起执行之前**，零执行事实）：
 *   · lint 未过：抛业务话术（`failureMessageFor('invalid_input')`）交模型一轮改对，并落
 *     `payload_lint_rejected` 事件（missing/unknown 只进日志）；
 *   · 同一 (回合, operation) 连续失败超过上限：`ToolUserError` 确定性停下（给「先停下来看看」）。
 */
const PAYLOAD_LINT_MAX_FAILURES = 2;

const PAYLOAD_LINT_STOP_MESSAGE =
  '这件事连续几次都因为内容不对被拦下了。先停下来看看：要写入的对象、范围和内容再核对一下，或者先别做这项操作。';

/** 装配一个 operation 声明的载荷型参数清单（`payload` 声明）。 */
function payloadArgsOf(manifest: CapabilityManifest, operation: string): ExecutionArgDeclaration[] {
  const declaration = manifest.operations.find((entry) => entry.name === operation);
  return (declaration?.args ?? []).filter((arg) => arg.payload !== undefined);
}

/** args 里该声明参数的命中形态（声明名或裸名）；返回实际键与值。 */
function payloadArgOf(args: Record<string, unknown>, name: string): { key: string; value: unknown } | undefined {
  if (Object.prototype.hasOwnProperty.call(args, name)) return { key: name, value: args[name] };
  const bare = name.replace(/^--/, '');
  if (bare !== name && Object.prototype.hasOwnProperty.call(args, bare)) return { key: bare, value: args[bare] };
  return undefined;
}

function preparePayloadArgs(input: {
  operation: string;
  args: Record<string, unknown>;
  manifest: CapabilityManifest;
  taskId: string;
  bridge: TaskExecutionBridge | undefined;
  /** 同一回合的失败计数（键 = operation）；随回合丢弃。 */
  failures: Map<string, number>;
  onEvent: ((event: ExecutionEvent) => void) | undefined;
}): Record<string, unknown> {
  const payloadArgs = payloadArgsOf(input.manifest, input.operation);
  if (payloadArgs.length === 0) return input.args;
  let next = input.args;
  for (const declaration of payloadArgs) {
    const present = payloadArgOf(next, declaration.name);
    if (present === undefined) continue;
    const failed = input.failures.get(input.operation) ?? 0;
    if (failed >= PAYLOAD_LINT_MAX_FAILURES) {
      // 连续失败已达上限：不再 lint、不再发起执行——确定性停下并给「先停下来看看」。
      throw new ToolUserError(PAYLOAD_LINT_STOP_MESSAGE);
    }
    const result = input.bridge === undefined
      ? { ok: false as const, missing: [] as string[], unknown: [] as string[] }
      : input.bridge.materializePayload({
        param: declaration.name,
        value: present.value,
        ...(declaration.payload?.schema === undefined ? {} : { schema: declaration.payload.schema }),
      });
    if (!result.ok) {
      input.failures.set(input.operation, failed + 1);
      input.onEvent?.({
        event: 'payload_lint_rejected',
        taskId: input.taskId,
        operation: input.operation,
        missing: result.missing,
        unknown: result.unknown,
      });
      throw new Error(failureMessageFor('invalid_input').text);
    }
    if (next === input.args) next = { ...next };
    if (present.key !== declaration.name) delete next[present.key];
    next[declaration.name] = result.path;
  }
  return next;
}

/** 参数规范化（判定「完全相同」用）：对象键排序后递归序列化；数组保序。 */
function stableArgsKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableArgsKey(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableArgsKey(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const MAIN_PROTOCOL_NOTE = [
  '【本轮工具协议】',
  '- 涉及平台数据的请求，用 task_run 工具交给执行层 Worker；不得自行编造或猜测平台数据。',
  '- 收到 Worker 汇报后，用用户能懂的话给出结论与数据；平台没有给出的内容不要补全，也不要声称已验证。',
  '- 合计、计数、差值、占比这类运算一律交给代码：优先用执行层返回的聚合字段；'
    + '执行层没给聚合且本轮没有计算工具时，如实说明拿不到可靠合计，不要凭记忆心算。'
    + '给出聚合数时说明来源（执行层字段 / 脚本计算）。',
  '- 执行层的调用失败、且**没有说明可以重试**（`retryable` 为 false 或未声明）时：如实说明它接受'
    + '什么、不接受什么，并问用户要不要换口径；同一对象本回合不要再换参数重试，也不要自行按维度'
    + '取值批量查询——那是替用户扩大范围。',
  // owner 2026-11-19：交办后不再由宿主固定受理回执——模型的话原样投递，无过程话时用户静默到结果。
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
  '- 合计、计数、差值、占比这类运算一律交给代码：优先用执行层返回的聚合字段；'
    + '执行层没给聚合且本轮没有计算工具时，如实说明拿不到可靠合计，不要凭记忆心算。'
    + '给出聚合数时说明来源（执行层字段 / 脚本计算）。',
  '- 执行层的调用失败、且**没有说明可以重试**（`retryable` 为 false 或未声明）时：如实说明它接受'
    + '什么、不接受什么，并问用户要不要换口径；同一对象本回合不要再换参数重试，也不要自行按维度'
    + '取值批量查询——那是替用户扩大范围。',
  // owner 2026-11-19：交办后不再由宿主固定受理回执——模型的话原样投递。
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

/**
 * 长任务异步（契约 v4）的结构化事件（**只进日志**，不进用户话术）：
 *   · execution_accepted            —— 执行层受理一笔长任务（Worker 回合结束、槽位释放）；
 *   · execution_accepted_undeclared —— 协议违约：未声明 long_running 的 operation 返回了
 *     accepted（宿主已按 failed 落定）；
 *   · execution_wait_resumed        —— wait 返回终态、Worker 续跑（waitedMs = 等待时长）；
 *   · execution_wait_timeout        —— wait 窗口到期仍在执行（按 pollAfterMs 重排）；
 *   · execution_aborted             —— 用户取消：result=cancelled（执行层确认）/failed（停不下来）；
 *   · execution_wait_files_registered —— 长任务回程文件/大日志已登记为任务文件。
 */
export type ExecutionEvent =
  | { event: 'execution_accepted'; taskId: string; operationId: string; operation?: string }
  | { event: 'execution_accepted_undeclared'; taskId: string; operation: string; operationId: string }
  | { event: 'execution_wait_resumed'; operationId: string; waitedMs: number }
  | { event: 'execution_wait_timeout'; operationId: string }
  | { event: 'execution_aborted'; operationId: string; result: 'cancelled' | 'failed'; reason?: string }
  | { event: 'execution_wait_files_registered'; operationId: string; files: number; logsFileized: number }
  /**
   * 载荷型参数 lint 未过（2026-11-19）：宿主装信封失败——不发起执行，业务话术交回模型改。
   * missing/unknown 是结构化机械事实（只进日志，不进用户话术）。
   */
  | { event: 'payload_lint_rejected'; taskId: string; operation: string; missing: readonly string[]; unknown: readonly string[] }
  /**
   * 失败归类（模型可见面收口，2026-11-19）：执行层失败/拒绝**不再逐字进模型投影**，
   * 模型只见 kind + note（见 toModelVisibleOutcome）；原始 code 与原文只经这条事件进日志。
   */
  | { event: 'execution_failure_classified'; operation: string; code: string; status: 'failed' | 'refused'; kind: string }
  /**
   * A2b（2026-11-18；后台执行器）：同一 (operation, 对象) 本回合已被执行层判定确定性失败
   * （retryable !== true）时**再次发起**的调用，在发起前被宿主拦下——对象/操作/执行层码与
   * 它的 retryable 声明随本条进日志（与前台 `turn.retryBlocked` → server 的
   * `execution_retry_blocked` 同一形状）。放行（显式 retryable:true）记 `execution_retry_allowed`。
   */
  | { event: 'execution_retry_blocked'; taskId: string; operation: string; object: string; code: string; declaredRetryable: boolean | 'unset' }
  | { event: 'execution_retry_allowed'; taskId: string; operation: string; object: string; code: string };

/** 长任务结果渲染的日志内联上限（字节；超过走任务文件，不留绝对路径也不灌转录）。 */
export const LONG_TASK_LOG_INLINE_MAX_BYTES = 4 * 1024;

/**
 * 长任务同步的装配错误话术（确定性失败）：声明了长任务却没有等待端口 = 不能留下
 * 无人推进的进行中任务。
 */
export const LONG_TASK_UNSUPPORTED_MESSAGE =
  '长任务需要后台派发并注入等待端口（wait/abort）才能推进；本次装配不支持，已停止该任务。';

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
   * P6：任务派发装配参数（**只由装配方显式传入，不是配置键**；缺省 'sync' = 现行为：
   * 委派同步执行、Main 等待）。'async' 需要同时注入 `taskRunner`（装配方构造，进程级共享）。
   */
  taskDispatch?: 'sync' | 'async';
  /** P6：后台任务运行器（async 模式必需；submit→pump，执行/恢复/取消由它承担）。 */
  taskRunner?: TaskRunner;
  /**
   * B 切片（工单回执收敛）：task_run 受理后的短等待窗口（ms）。缺省取 runtime 配置解析值；
   * 0 = 不等直接后台。窗口内执行端确认完成 → 结果同回合交给模型（与 inline 同形状）；
   * 超窗 → 只回机械受理事实（taskId/name/status/accepted:true，**无给用户的回执话术**），
   * 任务留后台推进（交办不再固定回执；久到消耗耐心才由 10/30 分钟两档出声）。
   */
  taskRunWaitMs?: number;
  /**
   * B 切片：窗口轮询时钟（测试确定性注入；缺省系统时钟）。只有 now + sleep 两个原语，
   * 不引入定时器/调度框架。注入实现的 sleep 必须推进时间（否则窗口永不超时——注入契约）。
   */
  taskRunClock?: RuntimeClock;
  /**
   * 前台排队超时的结构化事件（`resource_queue_timeout`；只进日志，不进用户话术）。
   * 缺省静默（不影响回合的拒绝结果）。
   */
  onResourceQueueTimeout?: (event: ResourceQueueTimeoutEvent) => void;
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
  /**
   * 大响应文件化成功（2026-11-19；**只进日志**，不进用户话术）：Worker 的 completed 结果
   * 超过 `runtime.oversizeDataBytes` 时，完整 data 已落成任务作用域文件，模型只拿到摘要 +
   * fileId。缺省静默（不影响回合）。
   */
  onExecutionResultFileized?: (event: ExecutionResultFileizedEvent) => void;
  /**
   * 大响应未能文件化（2026-11-19；**只进日志**）：未注入任务文件桥，或登记被拒/抛错时，
   * 结果退化为原样返回（fail-open，不阻塞业务）。缺省静默。
   */
  onExecutionResultOversizeUnhandled?: (event: ExecutionResultOversizeUnhandledEvent) => void;
  /**
   * 长任务异步（契约 v4）的结构化事件出口（**只进日志**，不进用户话术）。
   * 缺省静默；装配层按条落 `execution_*` 事件。
   */
  onExecutionEvent?: (event: ExecutionEvent) => void;
}

/**
 * 前台回合排队超时的结构化事件（2026-11-18）：`resource_queue_timeout{kind, principalId,
 * waitedMs}`。只进日志/资源账，不进用户话术（用户见 ForegroundRejectionError 的统一说明）。
 */
export interface ResourceQueueTimeoutEvent {
  readonly kind: 'foreground';
  readonly principalId: string;
  readonly waitedMs: number;
}

/** 前台回合被资源策略确定性拒绝（queued 排队等晋升超时/取消后不适用；携带机械 reason）。 */
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
  /**
   * **登记/真收到时刻**（epoch ms；清单「收到」时间取它）。刻意不用 activatedAt：
   * 纯附件场景的激活时刻是后续**文字消息**到达时刻，可能比真正收到晚几天；登记时刻
   * 才是渠道真收到（与 apps/server/attachment-facts 的 receivedAt 同口径）。
   * 交付面（TurnResult.files）可缺省——渠道投递只用 fileId/name/bytes。
   */
  createdAt?: number;
  /**
   * 交付角色（方案 A）：false = 宿主内部诊断产物（如 recalc 的 .values.csv），不进交付面。
   * 缺省/undefined = 可交付（Worker run_js 产物、任务回程、out/ 扫描都是用户产物；Main 的
   * run_js 不产交付物，片 2）。投递面按它机械过滤，**不看文件名**。
   */
  deliverable?: boolean;
}

/** 清单里的收到时间格式（本地时区，`YYYY-MM-DD HH:mm`）：业务用户读得懂的机械事实。 */
function receivedAtTextOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 回合末只有文件、正文为空时的宿主话术（v8 §7 出口清理；空文本帧会让渠道一个终帧都不发）。 */
export const FILES_GENERATED_NOTICE = '文件已生成（见附件）';

/**
 * 清单行渲染（CAP-01 修复轮 ⑤，机械事实）：name/fileId/bytes 之外，每条给出**脚本内路径**
 * ——与 file-store 物化输入的 materializedName 同一公式（in/<fileId><安全扩展名>，见
 * file-store materializeInputs），只由 fileId + 安全扩展名派生，**不由原始文件名拼路径**。
 * 显示名做机械净化：name 里的路径分隔符与 `..` 序列不进清单文本（name 只用于识别文件；
 * 路径注入面在结构上封死——净化只影响显示，不碰 file_refs 原值）。
 * 2026-11-18 owner：每行追加「（YYYY-MM-DD HH:mm 收到）」——时间取**登记/真收到时刻**
 * （createdAt；不取 activatedAt：纯附件场景的激活时刻是文字消息到达时刻，可能晚几天），
 * 业务用户靠它判断新旧；字段顺序与 fileId 形态不变（模型引用规则不变）。
 */
function manifestLineOf(file: TurnFileRef): string {
  const displayName = file.name.replaceAll(/(\.\.[/\\]?|[/\\])/g, '_');
  // 收到时间追加在既有字段之后（字段顺序与 fileId 形态不变）；无时刻的交付面引用不渲染。
  const received = file.createdAt === undefined ? '' : `；${receivedAtTextOf(file.createdAt)} 收到`;
  return `- ${displayName}（fileId: ${file.fileId}，${file.bytes} 字节；脚本内路径：in/${file.fileId}${safeExtensionOf(file.name)}${received}）`;
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

/** A2b 放行/拦截事实（观测用）：类型单源于共享锁模块（前台与后台同一形状）。 */
export type TurnRetryAllowed = RetryAllowed;
export type TurnRetryBlock = RetryBlock;

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
  /**
   * 主动推送抑制（快活失败/等补充）：本回合已把失败原因或「还缺什么」交给模型的任务。
   * 后台通知推送据此不重复发一条；受理回执路径的任务不在列（它们的结局仍靠推送送达）。
   */
  pushSuppressedTaskIds?: readonly string[];
  /**
   * A2b 观测面：本回合**被拦下**的重试（执行层没有显式声明可重试 → * 该对象本回合不再发起）。
   * 只作运维可见（装配层按条记 `execution_retry_blocked` 事件），不改变回合结果、不进用户文本。
   */
  retryBlocked?: readonly TurnRetryBlock[];
  /** A2b 观测面：执行层声明可重试的失败（瞬时故障）——本回合放行继续尝试。 */
  retryAllowed?: readonly TurnRetryAllowed[];
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
  /**
   * 唤醒入口（会话状态变化 → 模型把话带给用户）：把一条宿主事实交给 Main 驱动——
   * 会话空闲时触发一个模型回合并取回它产出的正文；会话忙时事实入队、由当前回合负责。
   * 出口四态见 WakeResult；驱动不支持唤醒（测试替身/一次性驱动）= unavailable。
   * 本层只透传事实与回合截止（mainTurnMs），不解释事实内容、不投递。
   */
  wake(factText: string): Promise<WakeResult>;
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
 *
 * `hint` = 引用方式（inline Worker 走 run_js.inputs；background 另见后台执行器的文件面
 * 说明）。缺省保持 inline 原文逐字节不变。
 */
export function renderWorkerFileManifest(
  files: readonly TurnFileRef[],
  hint = '以下文件已随任务交付；处理文件时用 run_js 的 inputs 按 fileId 引用',
): string {
  return [
    `[本任务文件清单]（机械事实：${hint}）`,
    ...files.map((file) => manifestLineOf(file)),
  ].join('\n');
}

/**
 * 委派块：任务原文 + 能力快照（只含允许集合）+ 任务文件清单（可选）+ 领域技能正文；
 * `answer` = 用户对上一次待办问题的补答（waiting_user 续跑回合），原文交给 Worker——
 * 每个后台回合都是新 Worker（不带上一回合转录），补答不随委派交给执行端就等于丢失。
 */
/**
 * 能力快照标题下的事实（2026-11-19 模型可见面收口）：**不再承诺「每个 operation 标注
 * 估时与重量」**——重量/估时是内部度量（用户听不懂、模型拿它只会错误估计），已从委派
 * 清单里去掉；这里只陈述 N 次执行与 N 倍等待/失败面的机械关系（原 A1 语义保留）。
 */
export const WORKER_SNAPSHOT_COST_NOTE =
  '一次任务发起 N 次执行，等待与失败面按 N 倍增长；控制执行次数。';

/** 终态集合（窗口内落定判定）。waiting_user 不是终态——等待接续仍属后台推进。 */
const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'completed',
  'failed',
  'timed_out',
  'unexecuted',
]);

/**
 * 写确认续跑事实块（P0，2026-11-19）：存在待确认提案、用户已在上一回合表态时，宿主从
 * 底账提案组装这条**机械事实**（不是话术补丁），交给 renderWorkerDelegation 的
 * `confirmationFact`。只含可展示摘要与直接提交指令；**handle 与 operation 名不进委派文本**
 * （Worker 永远看不到凭据）。缺省（无提案/非续跑）由调用方不传字段 → 委派逐字节不变。
 */
export function renderConfirmationResumeFact(confirmation: {
  summary: string;
}): string {
  return `用户已确认上一轮提案（摘要：${confirmation.summary}）。直接提交，不要重新生成提案。`;
}

/**
 * 句柄过期的续跑事实块（2026-11-19 owner 口径修正）：用户确认时上一份提案已过期——**不判失败、
 * 不结束任务**，接续一个回合让 Worker 重新生成同一提案（内容没变就照原样再提一次，不要擅自
 * 改参数）。只含机械指令，不含句柄（Worker 永远看不到凭据）。
 */
export function renderConfirmationExpiredFact(): string {
  return '上一份提案已过期；请重新生成同一提案（内容没变就照原样再提一次，不要擅自改参数）。';
}

/**
 * 委派清单投影（模型可见面收口，2026-11-19）：Worker 只拿调用所需——operation 名、参数
 * 声明、label（展示）与 `long_running`（影响行为：可能返回 accepted）。**去掉 weight /
 * estimatedSeconds 等内部度量**（抽象泄露来源之一：模型拿「单次估时约半小时」向用户
 * 承诺时长）；read/write 标记不进清单——允许集合（allowedOperations）才是宿主的执行面
 * 边界，不靠清单文本冒充授权。字段按白名单逐项保留，未来契约新增字段不会自动漏进委派。
 */
export function workerDelegationManifest(manifest: CapabilityManifest): CapabilityManifest {
  return {
    contractVersion: manifest.contractVersion,
    operations: manifest.operations.map((operation) => ({
      name: operation.name,
      ...(operation.label === undefined ? {} : { label: operation.label }),
      args: operation.args,
      ...(operation.long_running === true ? { long_running: true } : {}),
    })),
  };
}

export function renderWorkerDelegation(input: {
  task: string;
  manifest: CapabilityManifest;
  skills?: readonly WorkerSkill[];
  files?: readonly TurnFileRef[];
  /** 文件引用方式（缺省 = inline run_js 原文；background 传执行层文件参数口径）。 */
  fileManifestHint?: string;
  answer?: string;
  /**
   * 长任务续跑（契约 v4）：把已受理 operation 的终态结果原样交给 Worker（形状只含
   * status/summary/files/logs；文件只有 fileId，没有路径）。
   */
  resumedOperation?: { operationId: string; operation: string; outcome: unknown };
  /**
   * 续跑注记（契约 v4；owner 2026-11-19）：显式告诉 Worker「这是续跑、之前发生了什么」，
   * 防止它重复发起同一个操作。缺省空串 = 拼接结果逐字节不变（普通首轮/接续）。
   */
  resumeNote?: string;
  /**
   * 写确认续跑的事实块（P0，2026-11-19）：存在待确认提案、且用户已在上一回合表态时，
   * 由宿主从底账提案组装这条**机械事实**（不是话术补丁）——新 Worker 没有上一回合转录，
   * 不知道「用户在等确认、已经确认了」，会重新走 prepare 再出一次提案。给这条即让
   * Worker 直接提交、不重新生成提案。只含可展示摘要与指令；句柄/操作名不进委派文本
   * （Worker 永远看不到 handle）。缺省 undefined = 拼接逐字节不变。
   */
  confirmationFact?: string;
  /**
   * 句柄过期的续跑事实块（2026-11-19 owner 口径修正）：上一份提案已过期，宿主接续一个回合
   * 让 Worker 重新生成同一提案（内容没变就照原样再提一次，不要擅自改参数）。只含机械指令，
   * 不含句柄。缺省 undefined = 拼接逐字节不变。
   */
  confirmationExpiredFact?: string;
}): string {
  const parts = [
    '## 本次任务（宿主委派）',
    input.task,
    '',
    '## 能力快照（本轮唯一可执行面：只能调用这里登记的 operation）',
    WORKER_SNAPSHOT_COST_NOTE,
    '```json',
    JSON.stringify(workerDelegationManifest(input.manifest), null, 2),
    '```',
  ];
  if (input.answer !== undefined && input.answer.trim() !== '') {
    parts.push('', '## 用户补充（对上一次待办问题的答复）', input.answer);
  }
  if (input.confirmationFact !== undefined && input.confirmationFact.trim() !== '') {
    parts.push('', '## 写确认续跑（宿主机械事实）', input.confirmationFact);
  }
  if (input.confirmationExpiredFact !== undefined && input.confirmationExpiredFact.trim() !== '') {
    parts.push('', '## 写确认续跑（宿主机械事实）', input.confirmationExpiredFact);
  }
  if (input.files !== undefined && input.files.length > 0) {
    parts.push('', input.fileManifestHint === undefined
      ? renderWorkerFileManifest(input.files)
      : renderWorkerFileManifest(input.files, input.fileManifestHint));
  }
  if (input.resumedOperation !== undefined) {
    if (input.resumeNote !== undefined && input.resumeNote !== '') {
      parts.push('', input.resumeNote);
    }
    parts.push(
      '',
      '## 长任务结果（宿主注入，原样事实）',
      '此前异步执行的 operation 已在执行层结束；结果如下。文件只给 fileId——用 run_js 的 inputs 按 fileId 读取，不要猜路径。',
      '```json',
      JSON.stringify(input.resumedOperation, null, 2),
      '```',
      '据此核对并汇报最终事实。',
    );
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

/** 写操作提案落底账时的机械 missing 条目（waiting_user 形状要求 missing 非空；不编造业务原因）。 */
const CONFIRMATION_PENDING_MISSING = '用户确认';

/**
 * 「不算真实失败」的失败码（owner 2026-11-19，判据兜底）：**同回合已存在提案（needs_confirmation）**
 * 时，这些 failed/refused 只说明「同回合没法自己确认」或「模型误用了历史协议」，不应把整个
 * 有提案的回合判死（那样用户既没拿到提案、也没法确认）：
 *   · CONFIRMATION_REQUIRED —— 同回合 commit 没有句柄（预期：句柄下一回合才透传）；
 *   · PROPOSAL_REFUSE / PROPOSAL_UNKNOWN_FIELD / PROPOSAL_TOKEN_UNTRUSTED —— 模型去用历史
 *     提案协议（自己造载荷文件、凭记忆拼提交 token）被执行层拒；
 *   · CALL_REFUSE —— 结构化调用形状被拒（同一「模型用错协议」面）。
 * 出现任何**其它** failed/refused（GATE_REFUSE / COLLECTION_NOT_FOUND / …）仍是真实失败。
 * 「仅当同回合已有提案」由调用点结构性保证（selfConfirmBlockedRoundOf 先找到提案才用本集合）。
 */
const SAME_TURN_TOLERATED_FAILURE_CODES: ReadonlySet<string> = new Set([
  'CONFIRMATION_REQUIRED',
  'PROPOSAL_REFUSE',
  'PROPOSAL_UNKNOWN_FIELD',
  'PROPOSAL_TOKEN_UNTRUSTED',
  'CALL_REFUSE',
]);

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
  /** 本次绑定的稳定逻辑操作身份（长任务 accepted 的账行键；其它路径不消费）。 */
  dispatchKey?: string;
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
        dispatchKey: claim.dispatchKey,
      };
    }
  }
}

/**
 * 输入文件引用不可用的统一话术（run_js.inputs 与 task_run.inputFiles 同用）：
 * 越权/不存在/pending/过期/字节缺失同码同话术——v8 §4 防存在性 oracle。
 */
const FILE_INPUT_UNAVAILABLE_MESSAGE =
  '输入文件不可用：引用的文件不存在、未激活或已过期；请只用文件清单里给出的 fileId 引用输入文件。';

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

/** 交付事实按 fileId 去重（回程登记 + 兜底扫描同池去重后，同一产物不重复进交付面）。 */
function pushTurnFileOnce(list: TurnFileRef[], file: { fileId: string; name: string; bytes: number; deliverable?: boolean }): void {
  if (list.some((existing) => existing.fileId === file.fileId)) return;
  list.push({
    fileId: file.fileId,
    name: file.name,
    bytes: file.bytes,
    // 内部角色（如长任务大日志）显式标 false；用户产物缺省 = 可交付（字段不出现）。
    ...(file.deliverable === false ? { deliverable: false } : {}),
  });
}

/** 内存墙结构化事件（真实运行一次报一次；memo 命中不重复上报）。 */
function noteRunJsMemoryExit(
  output: RunJsOutput,
  side: 'main' | 'worker',
  onEvent: ((event: RunJsMemoryExitEvent) => void) | undefined,
  taskId?: string,
): void {
  const exit = runJsMemoryExitOf(output);
  if (exit === null) return;
  onEvent?.({
    runId: output.audit.runId,
    side,
    ...(taskId === undefined ? {} : { taskId }),
    ...exit,
  });
}

/** Worker 面 run_js 处理的依赖（inline 委派与 background 执行器同源装配）。 */
export interface WorkerRunJsTurnDeps {
  /** 未注入 = 工具面之外的调用（fail-closed；调用方负责工具面门控）。 */
  executor?: RunJsExecutor;
  /** 宿主持有的可信身份（模型参数里没有身份字段）。 */
  scope: { principalId: string; sessionId: string };
  /** 执行事实底账（Worker 的 run_js 是真实执行，必须进账）。 */
  registry: Pick<TaskRegistry, 'noteExecution'>;
  onFileRefUnavailable?: (reason: string) => void;
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
  onRunJsMemoryExit?: (event: RunJsMemoryExitEvent) => void;
  /**
   * 一次真实脚本执行结局（成功/失败/超时；abort 不报——取消由取消路径定性）。后台执行器
   * 用它把 run_js 计入本回合执行事实（否则「只靠脚本完成」会被判未发起执行）。
   */
  onScriptOutcome?: (event: { runId: string; ok: boolean; timeout: boolean }) => void;
}

/**
 * Worker 的 run_js 回合内执行（CAP-01 S2 ①；v8 §2/§4/§5）——**同一份实现**给 inline 委派
 * （createSession）与后台单回合执行器（createTaskExecutor）共用：差异只在装配方传入的
 * 任务作用域，任务作用域本身由调用方作为 taskId 传入。
 *
 *   · 输入只解析当前任务的绑定行（{side:'worker', taskId}）：Main 的源 fileId 不可读
 *     （越权/不存在同码同话术，防存在性 oracle），Worker 只能读交办副本；
 *   · 产物登记绑定当前任务（执行器侧 taskId → task_id 行），登记事实并入本任务交付收集；
 *   · 幂等（v8 §5）用**委派级**进程内 Map（随委派创建、随委派丢弃；不用 attempt，
 *     Pi 原生重试同键命中不重跑）。
 */
export function createWorkerRunJsTurn(
  deps: WorkerRunJsTurnDeps,
): (
  taskId: string,
  args: Record<string, unknown>,
  memo: Map<string, RunJsOutput>,
  taskFiles: TurnFileRef[],
  signal?: AbortSignal,
) => Promise<Record<string, unknown>> {
  return async (taskId, args, memo, taskFiles, signal) => {
    const executor = deps.executor;
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
        scope: deps.scope,
        taskId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof FileRefUnavailableError) {
        // 机械 reason 只进日志；模型与用户只见统一话术（防存在性 oracle，v8 §4）。
        deps.onFileRefUnavailable?.(error.reason);
        throw new Error(FILE_INPUT_UNAVAILABLE_MESSAGE);
      }
      if (error instanceof RunJsLayoutUnsafeError) {
        // 布局收窄（symlink）：与 Main 同一确定性失败话术；Worker 面附任务归属进日志。
        deps.onRunJsLayoutUnsafe?.({ ...error.event, side: 'worker', taskId });
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
      deps.onScriptOutcome?.({ runId: output.audit.runId, ok: scriptOk, timeout: killReason === 'timeout' });
      deps.registry.noteExecution(taskId, {
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
    noteRunJsMemoryExit(output, 'worker', deps.onRunJsMemoryExit, taskId);
    for (const file of output.outputs) {
      pushTurnFileOnce(taskFiles, file);
    }
    return runJsToolResult(output);
  };
}

/**
 * 长任务续跑准备（契约 v4；owner 2026-11-19）：wait 返回的 completed 结果与普通 completed
 * 走**同一套回程登记**——
 *   · data.files（执行层产出的输出文件）→ 任务文件桥 registerReturnedFiles（任务作用域、
 *     去重、剥离 path/base64）；Worker 只见 fileId/name/bytes；
 *   · data.logs（可选）→ 小日志（≤4KB）内联进结果；大日志登记成**任务文件**
 *     （deliverable:false，内部可读），Worker 只见 fileId；{name,fileId} 形状原样保留；
 *   · 输出形状只保留 summary/files/logs —— 任何绝对路径/内联字节都不会进入 Worker 转录。
 * 未注入文件桥时文件只按 unavailable 标记（不给 path、不伪造 fileId）。
 * 事件 execution_wait_files_registered{operationId, files, logsFileized} 由本函数发。
 */
async function prepareResumedLongTask(
  resumed: ResumedOperation,
  bridge: TaskExecutionBridge | undefined,
  onEvent: ((event: ExecutionEvent) => void) | undefined,
  onSkip: ((reason: string) => void) | undefined,
  taskFiles: TurnFileRef[],
): Promise<ExecutionOutcome> {
  const raw = resumed.outcome;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // 适配器违约（wait 没有返回执行契约形状）：如实落失败，不猜内容。
    return {
      status: 'failed',
      error: { code: 'EXECUTION_BAD_RESULT', message: '执行层等待返回了非对象结果。' },
    };
  }
  const outcome = raw as ExecutionOutcome;
  if (outcome.status !== 'completed') return outcome;
  // 批量写逐条结果（若执行层在长任务回执里也给了）原样随结果保留——不因文件重排丢失。
  const items = outcome.items === undefined ? {} : { items: outcome.items };
  const data = outcome.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'completed', data: { files: [], logs: [] }, ...items };
  }
  const record = data as Record<string, unknown>;
  const fileEntries = Array.isArray(record.files) ? record.files : [];
  const logs = Array.isArray(record.logs) ? record.logs : [];

  const inlineLogs: Array<Record<string, unknown>> = [];
  const largeLogEntries: Array<{ name: string; content: string }> = [];
  const fileIdLogs: Array<Record<string, unknown>> = [];
  for (let index = 0; index < logs.length; index += 1) {
    const entry = logs[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const log = entry as { name?: unknown; text?: unknown; fileId?: unknown };
    const name = typeof log.name === 'string' && log.name.trim() !== '' ? log.name : `log-${index + 1}`;
    if (typeof log.fileId === 'string' && log.fileId !== '') {
      fileIdLogs.push({ name, fileId: log.fileId });
      continue;
    }
    if (typeof log.text !== 'string') continue;
    if (Buffer.byteLength(log.text, 'utf8') > LONG_TASK_LOG_INLINE_MAX_BYTES) {
      // 大日志：登记成任务文件（内部角色），Worker 只拿 fileId。
      largeLogEntries.push({
        name: `${name.replace(/[/\\]/g, '_')}.log`,
        content: Buffer.from(log.text, 'utf8').toString('base64'),
      });
    } else {
      inlineLogs.push({ name, text: log.text });
    }
  }

  let fileViews: unknown[];
  let largeLogViews: unknown[];
  if (bridge !== undefined && (fileEntries.length > 0 || largeLogEntries.length > 0)) {
    // 日志条目显式标 internal（deliverable:false）——登记面按角色打标，不靠文件名判断。
    const entries = [
      ...fileEntries,
      ...largeLogEntries.map((entry) => ({ ...entry, deliverable: false })),
    ];
    const registered = await bridge.registerReturnedFiles(entries);
    fileViews = registered.entries.slice(0, fileEntries.length).map(sanitizedFileRef);
    largeLogViews = registered.entries.slice(fileEntries.length).map(sanitizedFileRef);
    const filesRegistered = fileViews.filter((view) => isRegisteredView(view)).length;
    const logsFileized = largeLogViews.filter((view) => isRegisteredView(view)).length;
    for (const file of registered.files) {
      // 大日志是内部角色：交付面按 deliverable 过滤，不进用户附件。
      pushTurnFileOnce(taskFiles, file);
    }
    onEvent?.({
      event: 'execution_wait_files_registered',
      operationId: resumed.operationId,
      files: filesRegistered,
      logsFileized,
    });
  } else {
    // 没有文件桥：绝不把路径/字节交给 Worker（也绝不伪造 fileId）。
    if (fileEntries.length > 0 || largeLogEntries.length > 0) onSkip?.('long_task_no_file_bridge');
    fileViews = fileEntries.map(() => ({ unavailable: 'no_file_bridge' }));
    largeLogViews = largeLogEntries.map((entry) => ({ name: entry.name, unavailable: 'no_file_bridge' }));
  }

  return {
    status: 'completed',
    data: {
      ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
      files: fileViews,
      logs: [...inlineLogs, ...fileIdLogs, ...largeLogViews],
    },
    ...items,
  };
}

/**
 * 续跑注记（owner 2026-11-19）：三种机械情形分别说清——正常唤醒 / 宿主重启后唤醒 /
 * 失败唤醒。目的只有一个：让 Worker 知道「上一回合已经发起过这个操作」，不要重复发起。
 * 只陈述账本事实（operation/operationId/失败原因），不改写用户任务原文。
 */
export function longTaskResumeNote(resumed: ResumedOperation, outcome: ExecutionOutcome): string {
  const operation = resumed.operation;
  const operationId = resumed.operationId;
  if (outcome.status === 'failed' || outcome.status === 'refused') {
    const reason = outcome.error.message.trim() !== '' ? outcome.error.message.trim() : '执行层未给出原因';
    return `[续跑] 你发起的操作 ${operation}（id ${operationId}）失败了：${reason}。不要盲目重试；如实说明并向用户提出可选项。`;
  }
  if (resumed.restarted === true) {
    return `[续跑·宿主曾重启] 你在本任务上一回合发起了操作 ${operation}（id ${operationId}），其间宿主重启过，你的上一回合上下文不在了。下面只有账本事实与文件；以它们为准，不要重复发起同一操作。`;
  }
  return `[续跑] 你在本任务上一回合发起了操作 ${operation}（id ${operationId}），它现在已完成；结果见下/见文件。不要重复发起同一操作，先核对结果。`;
}

function isRegisteredView(view: unknown): boolean {  return view !== null && typeof view === 'object' && typeof (view as { fileId?: unknown }).fileId === 'string';
}

/** 文件/日志引用只保留宿主登记事实（fileId/name/bytes）；其余字段（path/base64…）一律剥掉。 */
function sanitizedFileRef(entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { unavailable: 'not_registered' };
  }
  const record = entry as { fileId?: unknown; name?: unknown; bytes?: unknown; unavailable?: unknown };
  const fileId = typeof record.fileId === 'string' && record.fileId !== '' ? record.fileId : undefined;
  return {
    ...(fileId === undefined ? {} : { fileId }),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}),
    ...(fileId !== undefined
      ? {}
      : { unavailable: typeof record.unavailable === 'string' ? record.unavailable : 'not_registered' }),
  };
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
  // 模型可见面收口（2026-11-19，B 类最小边界）：执行层声明 model_visible:false 的
  // operation（历史协议/内部替代路径）**不进模型可见面**——从允许集合里剔除：既不出现在
  // Worker 委派清单，模型凭记忆硬调它也在发起执行前被确定性拒绝（走 OPERATION_NOT_PERMITTED_MESSAGE，
  // 零执行事实、不提 operation 名）。只过滤清单不够：允许集合才是执行面边界。
  for (const operation of manifest.operations) {
    if (operation.model_visible === false) allowed.delete(operation.name);
  }
  const workerManifest: CapabilityManifest = {
    contractVersion: manifest.contractVersion,
    operations: manifest.operations.filter((operation) => allowed.has(operation.name)),
  };
  /** 契约 v4：只有声明 long_running 的 operation 可以返回 accepted（否则协议违约 fail-closed）。 */
  const longRunningOperations = new Set(
    workerManifest.operations.filter((operation) => operation.long_running === true).map((operation) => operation.name),
  );

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
  /**
   * 大响应文件化阈值（2026-11-19）：注入策略时读策略解析值（单一配置源 = resource-policy）；
   * 未注入策略的纯内存会话用执行侧同值缺省——阈值照常生效，不依赖策略注入。
   */
  const oversizeDataBytes = policy !== undefined
    ? policy.snapshot().config.oversizeDataBytes
    : DEFAULT_OVERSIZE_DATA_BYTES;
  /** A2：本回合已发起的执行次数（send 时清零；跨本回合全部委派合计）。 */
  let operationsThisTurn = 0;
  /**
   * A2b：本回合内，执行层**没有明确说可重试**的失败对象，后续换参数再试一律不发起
   * （E14 实测：同一集合窗口被拒后，模型换 `2026-10`/`W202610` 两种写法连撞、再换新任务
   * 继续撞）。键 = operation + 对象参数（--collection/--topic）。
   *
   * **判据按 fail-safe 缺省**（owner 2026-11-18）：只有执行层**显式** `retryable === true`
   * 才允许继续尝试；`false` 与**未声明**一律视为不可重试。理由是不确定场景下宁可停下来
   * 报错、让人介入，也不能继续往下撞——打爆执行层就彻底没得用了。
   * 宿主只执行执行层的声明，不判断业务——这不是计划门。
   * 实现单源：`deterministic-retry-lock.ts`（与后台执行器同一份「键 + 记录 + 判定」）。
   */
  let retryLock = createDeterministicRetryLock();
  /** 载荷型参数 lint 的本回合失败计数（键 = operation）；随回合清零（装信封失败不是执行事实）。 */
  let payloadLintFailuresThisTurn = new Map<string, number>();
  /** A2b 观测：本回合被拦下的重试（回合末随 TurnResult 交装配层落事件；不改回合结果）。 */
  let retryBlockedThisTurn: TurnRetryBlock[] = [];
  /** A2b 观测：本回合执行层声明可重试（瞬时故障）的失败。 */
  let retryAllowedThisTurn: TurnRetryAllowed[] = [];
  const taskDispatch: 'sync' | 'async' = options.taskDispatch ?? 'sync';
  const taskRunner = options.taskRunner;
  if (taskDispatch === 'async' && taskRunner === undefined) {
    throw new Error('async 派发需要注入 TaskRunner（装配方构造 runner；此处 fail-closed）。');
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
      ...(task.pendingQuestion === undefined ? {} : { pendingQuestion: pendingQuestionView(task.pendingQuestion) }),
      requestIds: task.executions.map((execution) => execution.requestId),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  function taskStatus(args: Record<string, unknown>): unknown {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    if (ref === '') {
      // 列表默认只给最近的 N 条（新→旧）：一个用了两天的会话会有几十条历史任务，全量倒给模型
      // 只会让它抓错对象（2026-11-19 live 实测：问 alpha 却去取 #20 的 documents 结果）。
      const all = [...registry.list(scope)].sort((left, right) => (
        left.createdAt === right.createdAt
          ? ((right.taskNo ?? 0) - (left.taskNo ?? 0))
          : (left.createdAt < right.createdAt ? 1 : -1)
      ));
      return {
        tasks: all.slice(0, TASK_STATUS_LIST_LIMIT).map(statusView),
        ...(all.length > TASK_STATUS_LIST_LIMIT
          ? { total: all.length, truncated: all.length - TASK_STATUS_LIST_LIMIT }
          : {}),
      };
    }
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
    const taskId = resolveTaskId(refFromArgs(args));
    // 回执带任务身份（2026-11-18，LS6 实测缺陷）：多任务并存时模型按编号引用错任务，
    // 旧的取消回执只有状态、看不出取消了谁，错误被掩盖。这里附上被取消任务的编号与请求原文
    // 片段——纯机械事实，供模型/用户当场核对；查不到就照常让 runner 拒绝。
    let identity: { taskNo?: number; taskName?: string; taskRequest?: string; taskCreatedAt?: string } = {};
    try {
      const row = registry.get(taskId, scope);
      identity = {
        ...(row.taskNo === undefined ? {} : { taskNo: row.taskNo }),
        ...(row.name === undefined ? {} : { taskName: row.name }),
        taskRequest: row.request.length > 120 ? `${row.request.slice(0, 120)}…` : row.request,
        taskCreatedAt: row.createdAt,
      };
    } catch {
      // 不存在/越权：保持原行为（由 runner 给出确定性拒绝）。
    }
    const outcome = runner.cancel(taskId, scope);
    // 给用户看的一句话（2026-11-18，owner 要求）：业务名 + 编号，按结果分三种说法。
    // 模型必须逐字引用——用户要能一眼确认"被停掉的是哪件事"，而不是读一个裸编号。
    const label = identity.taskName ?? identity.taskRequest ?? '该任务';
    const suffix = identity.taskNo === undefined ? '' : `（编号 ${identity.taskNo}）`;
    const userMessage = outcome.outcome === 'cancelled'
      ? `已停止：${label}${suffix}`
      : outcome.outcome === 'requested'
        ? `已请求停止：${label}${suffix}（执行端确认前还不算停掉）`
        : `没停成：${label}${suffix} 已经办完了（当前状态：${outcome.status}）`;
    return { ...outcome, ...identity, userMessage, ...(reason === '' ? {} : { reason }) };
  }

  /**
   * 「没有可确认/接续对象」时给模型的机械事实（措辞归模型）：kind 区分确认/接续，并附在跑
   * 任务数——只看机械状态，不猜业务，也不生成用户话术（宿主不再替换模型文本）。
   */
  function noWaitingTargetFacts(kind: 'confirm' | 'resume'): Record<string, unknown> {
    const runningTasks = registry.list(scope).filter(
      (task) => task.status === 'running' || task.status === 'queued',
    ).length;
    return {
      fact: kind === 'confirm' ? NO_WAITING_TARGET_FACT : NO_WAITING_RESUME_TARGET_FACT,
      runningTasks,
    };
  }

  /** 接续：复用 runner.resume，原样转述 ResumeOutcome（非 waiting_user 由 registry 状态机拒绝）。 */
  function taskResume(args: Record<string, unknown>, runner: TaskRunner): unknown {
    const answer = typeof args.answer === 'string' ? args.answer : '';
    if (answer.trim() === '') throw new Error('task_resume 缺少 answer：请写清对任务待办问题的答复。');
    const rawRef = typeof args.ref === 'string' ? args.ref.trim() : '';
    // 引用可省略：本会话恰好一个等待中的任务时直接接续它（用户说「确认」时不该要求记编号）。
    const waiting = registry.listWaiting(scope);
    if (rawRef === '' && waiting.length === 0) {
      // 没有可接续的对象：给模型机械事实，由它自己说（宿主不替换其文本）。
      return { outcome: 'no_waiting_task', ...noWaitingTargetFacts('resume') };
    }
    const ref = rawRef !== ''
      ? rawRef
      : waiting.length === 1 && waiting[0]!.taskNo !== undefined
        ? `#${waiting[0]!.taskNo}`
        : (() => {
          throw new Error(`本会话有 ${waiting.length} 个等待中的任务，请用 ref 指明要接续哪一个（#编号）。`);
        })();
    const outcome = runner.resume(resolveTaskId(ref), { answer, scope });
    // 指到了但不是等待中的任务：机械结局原样保留，另给同一份事实（措辞归模型）。
    if (outcome.outcome === 'not_waiting') {
      return { ...outcome, ...noWaitingTargetFacts('resume') };
    }
    return outcome;
  }

  /**
   * 显式确认（2026-11-19 owner 拍板）：用户明确表示「按这版提交」时用它——宿主从底账取该任务
   * 的待确认提案，把任务接续下去，并把确认凭据（句柄 + 用户原话）交给执行端。语义与「下一条
   * 消息默认就是确认」完全不同：拿不准就问，宿主不做意图推断。机械结局原样转述（调用方业务化）。
   */
  function taskConfirm(args: Record<string, unknown>, runner: TaskRunner): unknown {
    const rawRef = typeof args.ref === 'string' ? args.ref.trim() : '';
    // 引用可省略：本会话恰好一个「等待确认的提案」时直接用它（用户说「确认」时不该要求记编号）。
    // 只认带 confirmation 的等待行——等补充信息的任务不算「待确认提案」。
    const waitingProposals = registry.listWaiting(scope).filter(
      (task) => task.pendingQuestion?.confirmation !== undefined,
    );
    if (rawRef === '' && waitingProposals.length === 0) {
      // 没有可确认的对象：给模型机械事实，由它自己说（宿主不替换其文本）。
      return { outcome: 'no_waiting_task', ...noWaitingTargetFacts('confirm') };
    }
    const ref = rawRef !== ''
      ? rawRef
      : waitingProposals.length === 1 && waitingProposals[0]!.taskNo !== undefined
        ? `#${waitingProposals[0]!.taskNo}`
        : (() => {
          throw new Error(`本会话有 ${waitingProposals.length} 个等待确认的提案，请用 ref 指明要提交哪一个（#编号）。`);
        })();
    // userText = 本回合用户原话（原样，不改写）；只在确认路径交给执行端。
    const outcome = runner.confirm(resolveTaskId(ref), { userText: currentUserText, scope });
    // 过期不是失败：宿主已接续一个回合重新生成提案（任务仍回 waiting_user）；给模型一句业务化
    // 的机械事实（含新提案卡的下半句，见 confirmationExpiredMessage）。
    if (outcome.outcome === 'expired') {
      return { ...outcome, userMessage: confirmationExpiredMessage() };
    }
    // 指到了但不是在等确认（跑完了/在等补充）：机械结局原样保留，另给同一份事实。
    if (outcome.outcome === 'not_waiting' || outcome.outcome === 'no_confirmation') {
      return { ...outcome, ...noWaitingTargetFacts('confirm') };
    }
    return outcome;
  }

  /** 文件工具的 scope（宿主持有的可信身份；模型参数里没有身份字段）。 */
  const fileScope = { principalId: options.principalId, sessionId: options.sessionId };


  /**
   * CAP-01 S1 run_js 回合内执行（v8 §2/§5）：
   *   · 幂等（v8 §5）：进程内 Map（memo 由 send() 随回合创建、随回合丢弃），key = 本回合号
   *     + sha256(code) + 排序后的 inputs——**Pi 原生重试不产生新 send()**，重试同键命中不重跑；
   *     不用 attempt（每次 recovery +1 会换键重跑）；跨重启不保证（重启后渠道重投是新回合）。
   *   · 输入引用（照 resolveTaskId 的写法）：参数面只收 fileId 数组；权威校验（scope/激活/TTL/
   *     字节）归执行器侧 fileStore.materializeInputs——这里把「越权/不存在/pending/过期/字节
   *     缺失」收成**同一句**话术抛回（不泄露存在性），机械 reason 经 onFileRefUnavailable 只进日志。
   *   · 产物（片 2，owner 裁定「交付物只从 Worker 出」）：Main 面 out/ **不可写也不登记**——
   *     执行器按 `writableDirs:'scratch-only'` + `registerOutputs=false` 运行：写 out/ 的脚本
   *     由权限模型拒绝（ERR_ACCESS_DENIED，非零退出），写进 scratch/ 的文件不建行、不落
   *     workspace 副本、不进 TurnResult.files。要交付文件 = task_run 交办（Worker 的 out/
   *     才是交付箱）。
   */
  async function runJsInTurn(
    args: Record<string, unknown>,
    memo: Map<string, RunJsOutput>,
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
        // 片 2：Main 面不登记 out/（结构性禁止 Main 产交付物；不是提示词约束）。
        registerOutputs: false,
        // 2026-11-18 owner 裁定 A：Main 的 run_js 只写 scratch/——执行器收窄
        // --allow-fs-write（去掉 out/），写 out/ 由权限模型拒绝，不是「写了不登记」。
        writableDirs: 'scratch-only',
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
    noteRunJsMemoryExit(output, 'main', options.onRunJsMemoryExit);
    setMemoryWall(runJsMemoryExitOf(output) !== null);
    // 片 2：不往交付面推送（out/ 未登记，outputs 恒为空）。
    return runJsToolResult(output);
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
   * CAP-01 S2 ① Worker 的 run_js 回合内执行（v8 §2/§4/§5）：实现与**后台单回合执行器
   * 同源**（createWorkerRunJsTurn，顶层层级模块函数，不是两套实现）——差异只在调用方
   * 传入的 taskId（任务作用域）。幂等用**委派级**进程内 Map（随 delegate 创建、随
   * delegate 丢弃；不用 attempt，Pi 原生重试同键命中不重跑）。
   */
  const runJsInWorkerTurn = createWorkerRunJsTurn({
    ...(options.runJsExecutor === undefined ? {} : { executor: options.runJsExecutor }),
    scope: fileScope,
    registry,
    ...(options.onFileRefUnavailable === undefined ? {} : { onFileRefUnavailable: options.onFileRefUnavailable }),
    ...(options.onRunJsLayoutUnsafe === undefined ? {} : { onRunJsLayoutUnsafe: options.onRunJsLayoutUnsafe }),
    ...(options.onRunJsMemoryExit === undefined ? {} : { onRunJsMemoryExit: options.onRunJsMemoryExit }),
  });

  /**
   * 上一回合 Main 转录的**只读投影**（Pi 会话 → 宿主可读形状）。
   * 宿主不持有可变对话历史：当前转录由 `mainTranscript()` 直接向驱动索取
   * （`TurnDriver.transcript()`）；本变量只在测试替身没有该方法时作**回落快照**，
   * 每回合整体覆盖、从不追加改写。跨重启的历史归 Pi 会话文件（装配层给驱动
   * sessionDir/resumeSessionFile），宿主不读不写转录。
   */
  let lastMainProjection: readonly DriverMessage[] = [];
  const mainTranscript = (): readonly DriverMessage[] =>
    options.mainDriver.transcript?.() ?? lastMainProjection;
  /** 本回合 Main 的截止时刻：委派算出的 Worker 截止不能越过它（再留收尾余量）。 */
  let currentTurnDeadline = 0;

  /**
   * 前台回合许可（P5）：策略存在时回合开始 acquire、结束 release。
   *   · 拒绝 → 确定性 ForegroundRejectionError（错误面由入口归类；server 走既有 fallback）；
   *   · 排队（queueCapacity>0）→ 受控等待晋升（release 触发 FIFO），等待不空转（让出）；
   *   · 排队有上限（`runtime.queueWaitMs`，缺省 120s）：超时释放排队位（不留残留）后
   *     确定性拒绝（「当前系统忙，请稍后再说」），并记录 `resource_queue_timeout` 事件。
   */
  async function acquireForegroundPermit(): Promise<Permit | undefined> {
    if (policy === undefined) return undefined;
    const acquired = policy.acquire('foreground', { taskId: `session:${options.principalId}:${options.sessionId}` });
    if (acquired.ok === false) {
      throw new ForegroundRejectionError(acquired.reason, acquired.message);
    }
    if (acquired.state === 'queued') {
      const queueWaitMs = policy.snapshot().config.queueWaitMs;
      const deadline = acquired.acquiredAt + queueWaitMs;
      while (acquired.state === 'queued') {
        if (taskRunClock.now() >= deadline) {
          // 超时：先退队（队列唯一事实源里不留残留），再按既有拒绝形状确定性拒绝。
          policy.release(acquired);
          const waitedMs = Math.max(0, taskRunClock.now() - acquired.acquiredAt);
          options.onResourceQueueTimeout?.({
            kind: 'foreground',
            principalId: options.principalId,
            waitedMs,
          });
          throw new ForegroundRejectionError(
            'queue_full',
            `排队等待超过 ${Math.round(queueWaitMs / 1000)} 秒（当前系统忙，请稍后再说）`,
          );
        }
        await taskRunClock.sleep(TASK_RUN_WAIT_POLL_MS);
      }
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
      throw new Error(OPERATION_NOT_PERMITTED_MESSAGE);
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
    const rawArgs = args.args;
    const baseCallArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
    // 载荷型参数装信封（宿主侧；发起执行之前）：模型给结构化值 → 宿主 lint+落盘 → 路径替换。
    // 失败（lint 未过/超上限）在此抛出——不发起执行、不落执行事实。
    const callArgs = preparePayloadArgs({
      operation,
      args: baseCallArgs,
      manifest: workerManifest,
      taskId,
      bridge: exchange,
      failures: payloadLintFailuresThisTurn,
      onEvent: options.onExecutionEvent,
    });
    // A2b 同参数重复守卫（发起前拒；不发起执行、不落执行事实）。
    // 作用域 = (本回合, 该任务)：同一任务内的逐字重复才拒；两个不同任务各自查同一对象是合法的。
    // 键 + 判定来自共享锁（与后台执行器同一份语义，见 deterministic-retry-lock.ts）。
    const blockedRetry = retryLock.before(operation, callArgs);
    if (blockedRetry !== undefined) {
      retryBlockedThisTurn.push(blockedRetry.block);
      const codeNote = blockedRetry.block.code === 'unclassified_failure' ? '且没有说明可以重试' : `（${blockedRetry.block.code}）`;
      const original = blockedRetry.executorMessage === undefined ? '' : `执行层原话：${blockedRetry.executorMessage}`;
      throw new Error(
        `执行层这次调用「${blockedRetry.block.object}」失败了${codeNote}；本回合不要再换参数重试——`
        + `把执行层给出的说法如实转告用户${original === '' ? '' : `（${original}）`}，`
        + '需要换口径或换对象时先问用户。',
      );
    }
    if (operationsThisTurn >= maxOperationsPerTurn) {
      throw new Error(turnOperationLimitMessage(maxOperationsPerTurn, operationsThisTurn));
    }
    operationsThisTurn += 1;
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
        // 契约 v4：accepted 只允许出现在声明 long_running 的 operation 上。未声明却返回 =
        // 协议违约：落 failed（账行不落 accepted）并记事件，绝不把半截句柄交给宿主。
        if (outcome.status === 'accepted' && !longRunningOperations.has(operation)) {
          options.onExecutionEvent?.({
            event: 'execution_accepted_undeclared',
            taskId,
            operation,
            operationId: outcome.operationId,
          });
          outcome = {
            status: 'failed',
            error: {
              code: 'EXECUTION_PROTOCOL_VIOLATION',
              message: `执行层对未声明 long_running 的 operation「${operation}」返回了 accepted（协议违约）。`,
            },
          };
        }
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
    // 契约 v4：长任务受理——回合正常结束（不是失败），把受理事实交给模型；任务保持
    // running，等待端口由后台 runner 推进（inline 装配无 runner 时在 delegate 处 fail-closed）。
    if (run.outcome.status === 'accepted') {
      options.onExecutionEvent?.({
        event: 'execution_accepted',
        taskId,
        operationId: run.outcome.operationId,
        operation,
      });
      return toModelVisibleOutcome(run.outcome, {
        operation,
        onClassified: (classified) => options.onExecutionEvent?.({
          event: 'execution_failure_classified',
          operation,
          code: classified.code,
          status: run.outcome.status as 'failed' | 'refused',
          kind: classified.kind,
        }),
      });
    }
    // 未声明 long_running 却返回 accepted：已在 execute 回调里机械落 failed，这里确定性
    // 终结本回合（不许模型把它当可重试的普通失败继续撞）。
    if (run.outcome.status === 'failed' && run.outcome.error.code === 'EXECUTION_PROTOCOL_VIOLATION') {
      throw new ToolUserError(run.outcome.error.message);
    }
    // A2b：执行层**没有显式说可重试**（retryable !== true）时，本回合锁住该 (operation, 对象)。
    // fail-safe 缺省（owner 2026-11-18）：不确定就不往下撞——宁可停下报错让人介入，
    // 也不能把执行层打到不能用。只有显式 retryable:true（超时/网关不可用等瞬时故障）放行。
    // 记录/放行判定来自共享锁（键 + 判定与后台执行器同源）。
    const allowedRetry = retryLock.after(operation, callArgs, run.outcome);
    if (allowedRetry !== undefined) {
      // 瞬时故障：不锁，但要留下「为什么还在试」的可见事实（否则部署侧只看到停、看不到试）。
      retryAllowedThisTurn.push(allowedRetry);
    }
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
    // 大响应文件化（2026-11-19）：completed 且超过阈值 → 完整 data 落任务文件，只回摘要 +
    // fileId；needs_confirmation / needs_input 与未注入桥时保持既有投影（含脱敏）不变。
    return projectWorkerOutcome(run.outcome, {
      taskId,
      operation,
      thresholdBytes: oversizeDataBytes,
      ...(exchange === undefined ? {} : { bridge: exchange }),
      ...(options.onExecutionResultFileized === undefined
        ? {}
        : { onFileized: options.onExecutionResultFileized }),
      ...(options.onExecutionResultOversizeUnhandled === undefined
        ? {}
        : { onUnhandled: options.onExecutionResultOversizeUnhandled }),
      // 失败/拒绝归类只进日志（原始码与原文不进模型投影）。
      ...(options.onExecutionEvent === undefined
        ? {}
        : {
          onClassified: (classified) => options.onExecutionEvent?.({
            event: 'execution_failure_classified',
            operation,
            code: classified.code,
            status: run.outcome.status as 'failed' | 'refused',
            kind: classified.kind,
          }),
        }),
    });
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
    /** 主动推送抑制收集器（快活失败/等补充：失败原因本回合已交给模型）。 */
    pushSuppressedTaskIds: string[],
  ): Promise<unknown> {
    const request = taskText.trim();
    if (request === '') throw new Error('task_run 缺少 task：请写清要办什么。');
    // 已有等待用户确认的提案时不许再新建任务（2026-11-19 live 实测缺陷：用户回「确认」，
    // Main 新开了一个任务去提交 → 新任务拿不到上一任务的确认句柄 → 写入确定失败）。
    // 这里给确定性拒绝 + 可执行下一步，不依赖模型自己想起来用 task_resume。
    // 用 listWaiting(scope) 而不是 list(scope)：只取等待行且走 (principal, session, status)
    // 索引——每次交办都全量映射会话任务会在浸泡里把 RSS 顶上去（实测 +13%）。
    const pendingConfirmation = registry.listWaiting(scope).find(
      (task) => task.pendingQuestion?.confirmation !== undefined,
    );
    if (pendingConfirmation !== undefined) {
      const no = pendingConfirmation.taskNo === undefined ? '' : `（编号 #${pendingConfirmation.taskNo}）`;
      const summary = pendingConfirmation.pendingQuestion?.confirmation?.summary ?? '';
      throw new Error(
        `还有一件事等你确认${no}：${summary}。回「确认」我就提交，回「不」我就不动；`
        + '这件事确认或放弃之后再办新的。',
      );
    }
    const taskId = `task_${randomUUID()}`;
    // CAP-01 S2（v8 §4/§6）：inputFiles 的解析与交办复制全部发生在建任务行/进 Worker 之前——
    // 任一 fileId 不可用 → 整次拒绝（不部分执行、不留任务行、零副本）。public（inline）与
    // background 同一条前置路径：background 在 submit 之前就已完成复制，任务一受理即带副本
    // 绑定（file_refs.task_id），Worker 侧只从任务副本物化（见 createTaskExecutor 文件桥）。
    const inputFiles = parseFileIdList(rawInputFiles, 'task_run', 'inputFiles');
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

    // P6 async：受理即底账 queued（Main 不等待）；派发/执行/恢复/取消归 TaskRunner。
    if (taskDispatch === 'async') {
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
      // B 切片（工单回执收敛）：短等待窗口（runtime.taskRunWaitMs，缺省 8000ms；0 = 不等）。
      // 窗口内执行端确认 completed → 与 inline 同形状把结果交给模型（同回合、零主动投递——
      // 结果不重复发两遍）；超窗 → 只回机械受理事实（taskId/name/status/accepted:true，
      // **不带任何给用户看的回执话术**——owner 2026-11-19：交办不再给固定回执，模型怎么说
      // 由它自己决定并原样投递），任务留后台推进，完成后由宿主完成投递面把结果发回原会话。
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
          // 这次失败的原因本回合就交给了模型（模型会向用户说明）——主动推送不重复发一条。
          pushSuppressedTaskIds.push(taskId);
          throw new Error(settled.failureReason ?? `后台任务已落定（${settled.status}）。`);
        }
      }
      const live = registry.get(taskId, scope);
      return {
        taskId,
        name,
        status: live.status,
        accepted: true,
      };
    }

    // CAP-01 S2 ①③④：任务作用域的 Worker 工具面（run_js）、执行层文件桥与本任务交付收集。
    // 全部随本委派创建、随本委派丢弃（未注入执行器/桥 = 零变化缺省）；background 派发的
    // 文件面在 createTaskExecutor（后台单回合执行器）里按任务构造文件桥——本函数只负责
    // 在受理前完成交办复制。
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
        tools: [executeOperationTool(), ...(options.runJsExecutor === undefined ? [] : [runJsTool('worker')])],
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
      // 契约 v4：本回合以长任务受理结束——任务保持 running（不 complete、不判失败），
      // 由后台 runner 的等待端口推进；没有 runner 的后台推进能力 = 装配错误，如实失败。
      const acceptedExecution = registry.get(taskId, scope).executions.find((execution) => execution.status === 'accepted');
      if (acceptedExecution !== undefined) {
        if (taskRunner === undefined) {
          registry.fail(taskId, LONG_TASK_UNSUPPORTED_MESSAGE);
          throw new ToolUserError(LONG_TASK_UNSUPPORTED_MESSAGE);
        }
        const current = registry.get(taskId, scope);
        return {
          taskId,
          taskNo: current.taskNo ?? null,
          name: current.name ?? deriveTaskName(current.request),
          status: 'running',
          accepted: true,
        };
      }
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
      // 主动推送抑制（快活失败/等补充）：这些任务的失败原因本回合已交给模型，推送不重复发。
      const pushSuppressedTaskIds: string[] = [];
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
      retryLock = createDeterministicRetryLock();
      payloadLintFailuresThisTurn = new Map();
      retryBlockedThisTurn = [];
      retryAllowedThisTurn = [];
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
      // 历史：直接向驱动索取当前转录（Pi 会话是唯一所有者；重启恢复由驱动从会话文件
      // 自己读回，宿主不再 seed 任何东西）。
      const turnMessages = [...mainTranscript(), userMessage(text)];
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
          // 取消/接续/确认需要 runner 生命周期：无 runner 不上面（fail-closed）。
          ...(taskRunner === undefined ? [] : [taskCancelTool(), taskResumeTool(), taskConfirmTool()]),
          ...(options.mainSkillRegistry === undefined ? [] : [readSkillTool()]),
          // CAP-01 S1：run_js 只在装配方注入执行器时上工具面（缺省零变化，fail-closed）。
          ...(options.runJsExecutor === undefined ? [] : [runJsTool('main')]),
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
              execute: async () => ({ status: 'completed', data: await delegate(task, args.inputFiles, foregroundPermit, turnFiles, pushSuppressedTaskIds) }),
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
              // 快活失败/等补充：失败原因或「还缺什么」也在本回合交给了模型（模型会向用户
              // 如实说明）——主动推送据此抑制，同一件事不说两遍。受理回执（running）不在列：
              // 那些任务的结果/失败仍要靠主动推送送达。
              const inTurnStatus = (answer as { status?: unknown } | null)?.status;
              if (inTurnStatus === 'failed' || inTurnStatus === 'needs_input') {
                pushSuppressedTaskIds.push(taskId);
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
            if (tool === TASK_CONFIRM_TOOL) return taskConfirm(args, taskRunner);
          }
          // 缺口 2 臂 B：read_skill 与工具面同源门控（未注入登记表则不受理）。
          if (tool === READ_SKILL_TOOL && options.mainSkillRegistry !== undefined) {
            const name = typeof args.name === 'string' ? args.name : '';
            const skill = await options.mainSkillRegistry.read(name);
            return { name: skill.name, content: skill.content };
          }
          // CAP-01 S1：run_js 与工具面同源门控（未注入执行器则不受理），fail-closed。
          if (tool === RUN_JS_TOOL && options.runJsExecutor !== undefined) {
            return runJsInTurn(args, runJsMemo, (hit) => {
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
            // 方案 A：只收可交付项——recalc 的 .values.csv 是宿主内部诊断产物
            // （deliverable:false），不进交付面（投递口另有同一判据的最后一道闸）。
            if (result.outputs !== undefined) {
              turnFiles.push(
                ...result.outputs
                  .filter((f) => f.deliverable !== false)
                  .map((f) => ({ fileId: f.fileId, name: f.name, bytes: f.bytes })),
              );
            }
            return result;
          }
          throw new Error(`Main 工具面之外的调用：${tool}`);
        },
        deadline: currentTurnDeadline,
        onRuntimeEvent: (event) => noteRuntimeEvent(mainWindow, event),
      });
      lastMainProjection = mainResult.messages;
      // 转录落盘归 Pi 会话（驱动自己的 SessionManager）：宿主回合结束后**不搬运任何消息**。
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
      // async：受理话术不落任务行（结果由 runner 在确认 completed 后经 archiveReply
      // 逐字存档，避免受理话术覆盖结果）。
      if (taskDispatch !== 'async' && taskIds.length > 0 && reply.trim() !== '') {
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
        ...(pushSuppressedTaskIds.length > 0 ? { pushSuppressedTaskIds } : {}),
        ...(retryBlockedThisTurn.length > 0 ? { retryBlocked: retryBlockedThisTurn } : {}),
        ...(retryAllowedThisTurn.length > 0 ? { retryAllowed: retryAllowedThisTurn } : {}),
        progress,
        ...(turnFiles.length > 0 ? { files: turnFiles } : {}),
        ...(manifestBytes === undefined ? {} : { fileManifestBytes: manifestBytes }),
      };
    } finally {
      releaseForegroundPermit(foregroundPermit);
    }
  }

  /**
   * 唤醒（宿主事实 → 模型说）：只把事实与回合截止转给 Main 驱动；驱动缺省（测试替身）
   * = 没有可唤醒的会话，按 unavailable 出口（调用方兜底，不冒充已唤醒）。
   */
  async function wake(factText: string): Promise<WakeResult> {
    const driverWake = options.mainDriver.wake;
    if (driverWake === undefined) return { outcome: 'unavailable' };
    return await driverWake.call(options.mainDriver, factText, { deadline: Date.now() + mainTurnMs });
  }

  return {
    principalId: options.principalId,
    sessionId: options.sessionId,
    transcript: () => mainTranscript(),
    send,
    wake,
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

function taskConfirmTool(): DiscoveredTool {
  return { name: TASK_CONFIRM_TOOL, description: TASK_CONFIRM_TOOL_DESCRIPTION, inputSchema: TASK_CONFIRM_TOOL_SCHEMA };
}

function readSkillTool(): DiscoveredTool {
  return { name: READ_SKILL_TOOL, description: READ_SKILL_TOOL_DESCRIPTION, inputSchema: READ_SKILL_TOOL_SCHEMA };
}

/**
 * run_js 工具面（role 决定描述，schema 共用）：Main 面 out/ 不产交付物（片 2）；
 * Worker 面 out/ 是本任务交付箱。两面的机械纪律同源，差别只在「写进哪里算交付」。
 */
function runJsTool(role: 'main' | 'worker'): DiscoveredTool {
  return {
    name: RUN_JS_TOOL,
    description: role === 'main' ? RUN_JS_TOOL_DESCRIPTION : WORKER_RUN_JS_TOOL_DESCRIPTION,
    inputSchema: RUN_JS_TOOL_SCHEMA,
  };
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

/**
 * 后台 Worker 任务文件清单的引用方式（与 inline 的 run_js.inputs 同源，另加执行层的声明
 * 文件参数：后台 Worker 的 execute_operation 文件参数由宿主替换为任务目录内的物化路径）。
 */
const BACKGROUND_FILE_MANIFEST_HINT =
  '以下文件已随任务交付；处理文件时用 run_js 的 inputs 按 fileId 引用，或调用 execute_operation 时按能力快照声明的文件参数引用（宿主会替换为任务目录内的物化路径）';

/**
 * 后台任务文件桥工厂（按任务身份构造）：装配层注入 fileStore/platformRoot/内层客户端，
 * runtime 只认这个面。每回合按 (principalId, sessionId, taskId) 建桥——任务副本按
 * file_refs.task_id 解析（Worker 侧只物化当前任务的副本，从不读 Main 侧原文件）。
 */
export type BackgroundTaskBridgeFactory = (input: {
  principalId: string;
  sessionId: string;
  taskId: string;
}) => TaskExecutionBridge;

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
  /**
   * 片 1（owner 定：交付物只从 Worker 出）：run_js 执行器端口（装配层构造注入）。
   * 注入后后台 Worker 工具面 = execute_operation + run_js（任务作用域：输入只解析本任务
   * 副本、产物登记绑定本任务）；缺省不注入 = Worker 工具面与现行逐字节相同（零变化）。
   */
  runJsExecutor?: RunJsExecutor;
  /**
   * 后台任务文件桥（CAP-01 S2 后台面）：注入后本执行器的 Worker 委派带任务文件清单
   * （任务副本 fileId/name/bytes），execute_operation 经桥把任务副本物化到
   * `<platformRoot>/tmp/task_<id>/in` 并按执行层声明的文件参数替换值。
   * 未注入 = 零变化缺省（后台 Worker 无文件面）。
   */
  backgroundTaskBridge?: BackgroundTaskBridgeFactory;
  /** 文件引用被拒（桥物化失败）的机械 reason 观察点；只进日志，不进用户话术。 */
  onFileRefUnavailable?: (reason: string) => void;
  /**
   * 大响应文件化阈值（字节；装配层注入 `resolveRuntimeConfig` 的解析值，单一配置源 =
   * resource-policy）。缺省 65536（与策略缺省同值，纯内存嵌入/测试用）。
   */
  oversizeDataBytes?: number;
  /** 大响应已落盘（只进日志）；缺省静默。 */
  onExecutionResultFileized?: (event: ExecutionResultFileizedEvent) => void;
  /** 大响应未文件化（无桥/登记失败，已 fail-open 原样返回；只进日志）；缺省静默。 */
  onExecutionResultOversizeUnhandled?: (event: ExecutionResultOversizeUnhandledEvent) => void;
  /** 长任务异步（契约 v4）的结构化事件出口（只进日志；缺省静默）。 */
  onExecutionEvent?: (event: ExecutionEvent) => void;
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
 * 模型可见的执行结果（单一实现：前台会话 execute_operation 与后台 TaskExecutor 共用）：
 * needs_confirmation 只给机械摘要（summary/expiresAt）与 data——句柄是宿主持有的确认凭据，
 * 不进模型转录/工具结果，模型无法伪造或转交；completed / needs_input / accepted 原样
 * （逐字节不变）；**failed / refused 不再逐字透传**（2026-11-19 模型可见面收口）——执行层
 * 原文与原始码是内部形态（用户不需要、也不该看到「确认凭据/令牌/参数名/协议」这类词），
 * 模型只见 `{status, kind, note}`：kind 来自 classifyFailure（码表归类），note 来自
 * failureMessageFor（用户话术 + 动作）。原始 code/原文只进日志（调用方经 onExecutionEvent
 * 落 `execution_failure_classified`，见 projectWorkerOutcome）。
 */
function toModelVisibleOutcome(
  outcome: ExecutionOutcome,
  input: {
    operation: string;
    /** 失败/拒绝的归类观察点（只进日志）；缺省静默 = 与改动前一致的纯投影路径。 */
    onClassified?: (event: { code: string; kind: UserFacingFailureKind }) => void;
  },
): Record<string, unknown> {
  if (outcome.status !== 'needs_confirmation') {
    if (outcome.status !== 'failed' && outcome.status !== 'refused') {
      return outcome as unknown as Record<string, unknown>;
    }
    const kind = classifyFailure({ code: outcome.error.code, status: outcome.status });
    input.onClassified?.({ code: outcome.error.code, kind });
    return {
      status: outcome.status,
      kind,
      note: failureMessageFor(kind).text,
    };
  }
  return {
    status: 'needs_confirmation',
    summary: outcome.confirmation.summary,
    ...(outcome.confirmation.expiresAt === undefined ? {} : { expiresAt: outcome.confirmation.expiresAt }),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
  };
}

/** 执行结果内联上限的执行侧缺省（与 resource-policy 缺省同值；注入策略时读解析值）。 */
const DEFAULT_OVERSIZE_DATA_BYTES = 64 * 1024;

/** 大响应已落为任务文件（只进日志）：bytes = 触发阈值时的 outcome JSON 字节数。 */
export interface ExecutionResultFileizedEvent {
  readonly taskId: string;
  readonly operation: string;
  readonly bytes: number;
  readonly fileId: string;
}

/** 大响应未文件化（无桥/登记失败，已 fail-open）：bytes = 触发阈值时的 outcome JSON 字节数。 */
export interface ExecutionResultOversizeUnhandledEvent {
  readonly taskId: string;
  readonly operation: string;
  readonly bytes: number;
}

/** 任务文件名（机械可读、不含内部路径）：只保留安全字符，长度有界。 */
function oversizeDataFileNameOf(operation: string): string {
  const safe = operation.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `result-${safe === '' ? 'operation' : safe}.json`;
}

/**
 * Worker 结果投影（大响应文件化，2026-11-19）。
 *
 * 背景：执行层结果是 in-band 进模型上下文的（工具结果 = data 原样投影、无截断），一次查回
 * 几千行明细就把上下文打满。判据刻意窄：
 *   · 只对 `completed` 生效——needs_confirmation / needs_input 的既有语义与脱敏规则不变，
 *     这两个态**不落盘**（它们是用户/执行层的交互事实，不是可延迟读取的明细）；
 *   · 阈值 = `runtime.oversizeDataBytes`（单一配置源 = resource-policy 解析值）；
 *   · 超过阈值 → 完整 `data` 写成**任务作用域**文件（现有回程登记通道，不新增第二套文件
 *     通道），模型只拿 `{status, oversize, bytes, fileId, note}`；明细由 run_js 的 inputs
 *     按 fileId 读取；
 *   · 未注入文件桥 / 登记失败 → **fail-open**：原样返回并记 `oversize_unhandled`
 *     （不因为省上下文而阻塞业务）。
 *
 * bytes 口径 = `JSON.stringify(outcome)` 的 UTF-8 字节数（触发阈值的那次测量）。
 */
async function projectWorkerOutcome(
  outcome: ExecutionOutcome,
  input: {
    readonly taskId: string;
    readonly operation: string;
    readonly thresholdBytes: number;
    readonly bridge?: TaskExecutionBridge;
    readonly onFileized?: (event: ExecutionResultFileizedEvent) => void;
    readonly onUnhandled?: (event: ExecutionResultOversizeUnhandledEvent) => void;
    /** 失败/拒绝归类观察点（只进日志；缺省静默）。 */
    readonly onClassified?: (event: { code: string; kind: UserFacingFailureKind }) => void;
  },
): Promise<Record<string, unknown>> {
  if (outcome.status !== 'completed') return toModelVisibleOutcome(outcome, { operation: input.operation, onClassified: input.onClassified });
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(outcome), 'utf8');
  } catch {
    // 契约外的不可序列化 data：不引入新行为，交回既有投影（与原路径一致）。
    return toModelVisibleOutcome(outcome, { operation: input.operation, onClassified: input.onClassified });
  }
  if (bytes <= input.thresholdBytes) return toModelVisibleOutcome(outcome, { operation: input.operation, onClassified: input.onClassified });
  const unhandled = (): Record<string, unknown> => {
    input.onUnhandled?.({ taskId: input.taskId, operation: input.operation, bytes });
    return toModelVisibleOutcome(outcome, { operation: input.operation, onClassified: input.onClassified });
  };
  if (input.bridge === undefined) return unhandled();
  let dataJson: string | undefined;
  try {
    dataJson = JSON.stringify(outcome.data);
  } catch {
    return unhandled();
  }
  // completed 没有 data 时没有可落盘的明细（阈值只可能被其它字段推过）；不伪造空文件。
  if (typeof dataJson !== 'string') return unhandled();
  try {
    const name = oversizeDataFileNameOf(input.operation);
    const registration = await input.bridge.registerReturnedFiles([
      { name, content: Buffer.from(dataJson, 'utf8').toString('base64') },
    ]);
    const file = registration.files[0];
    if (file === undefined) return unhandled();
    input.onFileized?.({ taskId: input.taskId, operation: input.operation, bytes, fileId: file.fileId });
    return {
      status: 'completed',
      oversize: true,
      bytes,
      fileId: file.fileId,
      note: `结果较大，已落为任务文件 ${file.name}；需要明细请用 run_js 的 inputs 按 fileId 读取`,
    };
  } catch {
    // 登记被拒（size_limit 等）/桥抛错：不阻塞业务，退化为原样返回。
    return unhandled();
  }
}

/**
 * pendingQuestion 的对外投影（task_status / task_result）：写操作提案只暴露机械摘要与有效期，
 * **去掉 handle 与 operation**——句柄留底账（S3 透传用），不给模型/用户可见面。
 */
function pendingQuestionView(question: PendingQuestion): Record<string, unknown> {
  const { confirmation, ...rest } = question;
  if (confirmation === undefined) return rest;
  return {
    ...rest,
    confirmation: {
      summary: confirmation.summary,
      ...(confirmation.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
    },
  };
}

/**
 * 后台单回合执行器（P6 TaskExecutor 的生产实现；每次派发新建 Worker 回合）：
 *   · 转录隔离结构性满足：只持有本次任务投影（request/answer），不接触 Main 会话转录；
 *   · 执行经 `execute_operation` +（注入 runJsExecutor 时）`run_js`（任务作用域，片 1）；
 *     宿主生成 requestId，事实写 taskRegistry.noteExecution；
 *   · 逐回合机械判定（不替执行端做 task 级二次判定）：
 *       中止/abort → cancelled；截止未产出 → timed_out；空汇报 → failed；
 *       执行层 needs_input → needs_input（missing 原样转述）；
 *       本轮最后一条非只读执行 needs_confirmation → needs_confirmation（句柄随问题落底账）；
 *       同回合 prepare→commit 被挡（存在提案且所有 failed/refused 都是 CONFIRMATION_REQUIRED）
 *       → needs_confirmation（owner 2026-11-19：不是 failed——见 execute 内 selfConfirmBlockedRoundOf）；
 *       零执行 → failed（不得报 completed）；任一非 completed → failed（原因机械合成）；
 *       全部 completed → completed{resultText, files?}（结果存档由 runner settle 经 archiveReply
 *       承接；files = Worker 产出的任务作用域交付物，装配方按它投递）。
 *
 * 写确认边界（S1 起）：后台单回合执行器把 needs_confirmation 识别为 needs_confirmation 结局
 * （不是 failed），句柄/摘要随 runner 落 waiting_user 底账（复用既有等待形状，不新状态）；
 * 回给 Worker 的工具结果与前台同一套脱敏投影（toModelVisibleOutcome），Worker 永远看不到
 * 句柄。**句柄只经确认路径透传**（2026-11-19 显式确认切片）：只有 `runner.confirm()`（用户
 * 明确确认）会把底账提案注入本执行器；`runner.resume()`（改口径/补信息）不带句柄。
 */
export async function createTaskExecutor(options: TaskExecutorOptions): Promise<TaskExecutor> {
  const manifest = await options.client.capabilities();
  const available = new Set(manifest.operations.map((operation) => operation.name));
  const missingAllowed = options.allowedOperations.filter((name) => !available.has(name));
  if (missingAllowed.length > 0) {
    throw new Error(`允许集合不在能力快照里（fail-closed）：${missingAllowed.join('、')}`);
  }
  const allowed = new Set(options.allowedOperations);
  // 模型可见面收口（2026-11-19，B 类最小边界；与 createSession 同源）：执行层声明
  // model_visible:false 的 operation 从允许集合剔除——不进后台 Worker 委派清单，模型凭
  // 记忆硬调也在发起执行前被确定性拒绝（OPERATION_NOT_PERMITTED_MESSAGE，零执行事实）。
  for (const operation of manifest.operations) {
    if (operation.model_visible === false) allowed.delete(operation.name);
  }
  const workerManifest: CapabilityManifest = {
    contractVersion: manifest.contractVersion,
    operations: manifest.operations.filter((operation) => allowed.has(operation.name)),
  };
  const workerTurnMs = options.workerTurnMs ?? DEFAULT_WORKER_TURN_MS;
  // 大响应文件化阈值：装配层注入解析值；未注入（测试/嵌入）用执行侧同值缺省。
  const oversizeDataBytes = options.oversizeDataBytes ?? DEFAULT_OVERSIZE_DATA_BYTES;
  const now = options.now ?? Date.now;
  const readOnlyOperations = new Set(options.readOnlyOperations ?? []);
  /** 契约 v4：accepted 只允许出现在这些声明 long_running 的 operation 上。 */
  const longRunningOperations = new Set(
    workerManifest.operations.filter((operation) => operation.long_running === true).map((operation) => operation.name),
  );

  return {
    async execute(task, context): Promise<TaskExecutionOutcome> {
      const recorded: Array<{ operation: string; outcome: ExecutionOutcome; dispatchKey?: string }> = [];
      /**
       * 本回合被**宿主**在发起前拒绝的 operation（允许集合之外）。它不产生执行事实
       * （没有到达执行层），但会改变零执行时的失败话术：权限问题不能说成「模型没干活」。
       */
      const hostRefusedOperations: string[] = [];
      // U3：本交办内的重放窗口（只由 Worker 驱动的原生事件推进）。
      const workerWindow = newAttemptWindow();
      let unresolved = false;
      /** 载荷型参数 lint 的本回合失败计数（键 = operation）；随本次执行丢弃。 */
      const payloadLintFailures = new Map<string, number>();
      /**
       * A2b 同对象确定性失败锁（与前台 inline 会话**同一份实现**，见 deterministic-retry-lock.ts）：
       * 本回合（本次 execute）内，执行层没有显式说可重试的失败对象，后续换参数再试一律不发起。
       * 每个后台回合独立新建、回合结束即丢弃——不跨回合记忆。
       */
      const retryLock = createDeterministicRetryLock();
      // 片 1：本任务的交付收集（Worker run_js 产物登记事实）与委派级幂等 Map。
      // 全部随本次执行创建、随本次执行丢弃（未注入执行器 = 不参会、零变化）。
      const taskFiles: TurnFileRef[] = [];
      // CAP-01 S2 后台文件面：按任务身份建桥（任务副本按 file_refs.task_id 解析）；未注入
      // = 零变化（raw client、无文件清单）。清单可能在 waiting_user 续跑时含此前产物，
      // 与任务文件面语义一致——Worker 只解析当前任务的绑定行。
      const taskBridge = options.backgroundTaskBridge?.({
        principalId: task.principalId,
        sessionId: task.sessionId,
        taskId: task.taskId,
      });
      const executionClient = taskBridge?.client ?? options.client;
      // 契约 v4：续跑回合先把 wait 结果走同一套回程登记（任务作用域文件；大日志落文件），
      // 再取任务文件清单——登记出来的 fileId 因此出现在本次委派清单里，Worker 直接引用。
      const resumedOperation = task.resumedOperation;
      const resumedOutcome = resumedOperation === undefined
        ? undefined
        : await prepareResumedLongTask(
          resumedOperation,
          taskBridge,
          options.onExecutionEvent,
          options.onFileRefUnavailable,
          taskFiles,
        );
      if (resumedOperation !== undefined && resumedOutcome !== undefined) {
        // 续跑回合的「本回合执行事实」= 执行层 wait 返回的终态（零 exec 也算执行过，
        // 不判 unexecuted）；Worker 后续的 run_js/查询照常追加。
        recorded.push({
          operation: resumedOperation.operation,
          outcome: resumedOutcome,
          dispatchKey: resumedOperation.dispatchKey,
        });
      }
      const delegationFiles: TurnFileRef[] = (taskBridge?.taskFiles() ?? []).map((file) => ({
        fileId: file.fileId,
        name: file.name,
        bytes: file.bytes,
      }));
      const runJsMemo = new Map<string, RunJsOutput>();
      /**
       * 确认路径透传（写确认，2026-11-19 显式确认切片）：**只有 `runner.confirm()`** 会在
       * answerResumes 之前从底账取出提案并注入 task.pendingConfirmation——`runner.resume()`
       * （补充/改口径）永不带它。所以这里的 pendingConfirmation **只可能来自「用户明确确认」**：
       *   · 本回合新造的提案不在其中，所以「同回合 prepare 后立刻 commit」结构性不会拿到句柄；
       *   · resume（改口径）回合也不在其中——旧提案作废，Worker 重新提案是允许且期望的；
       *   · 只读调用不携带（读调用不会产生待确认写操作；执行层也不为读发放确认）；
       *   · 句柄随**每条非只读执行**原样交给执行层（去掉旧的「一轮只发一次」闸：
       *     Worker 第一句常是 prepare、真正 commit 在后面，句柄被 prepare 消耗会让 commit
       *     拿不到，必然 CONFIRMATION_REQUIRED）。**一次性/防重放由执行层自己保证**；
       *   · 宿主不解释句柄、不判断用户是否在确认——语义归执行层（它校验句柄与提案绑定）。
       */
      const pendingConfirmation = task.pendingConfirmation;
      // 确认路径·句柄已过期（owner 2026-11-19）：不判失败、不结束任务——接续一个回合让 Worker
      // 重新生成同一提案；不带旧句柄（与 pendingConfirmation 互斥）。
      const confirmationExpired = task.confirmationExpired === true;
      const workerRunJsTurn = createWorkerRunJsTurn({
        ...(options.runJsExecutor === undefined ? {} : { executor: options.runJsExecutor }),
        // 可信身份取自任务行（底账持有），不取模型参数。
        scope: { principalId: task.principalId, sessionId: task.sessionId },
        registry: options.registry,
        // 片 1：run_js 是真实执行——计入本回合执行事实（零执行判定/失败原因同源），
        // 否则「只靠脚本完成」的任务会被判未发起执行、「脚本失败 + 汇报成功」会假绿。
        onScriptOutcome: ({ ok, timeout }) => {
          recorded.push({
            operation: RUN_JS_TOOL,
            outcome: ok
              ? { status: 'completed', data: {} }
              : {
                status: 'failed',
                error: {
                  code: timeout ? 'run_js_timeout' : 'run_js_failed',
                  message: timeout ? 'run_js 脚本超时被终止' : 'run_js 脚本以非零退出码结束',
                  retryable: false,
                },
              },
          });
        },
      });
      const exec = async (
        tool: string,
        args: Record<string, unknown>,
        execSignal?: AbortSignal,
      ): Promise<unknown> => {
        // 取消信号：Pi 回合的 abort signal（父级取消 + 截止）优先；驱动未传时回落到任务信号。
        const signal = execSignal ?? context.signal;
        if (tool === RUN_JS_TOOL) {
          // 与工具面同源门控（未注入执行器 = fail-closed；不进底账、不产生文件）。
          if (options.runJsExecutor === undefined) throw new Error(`Worker 工具面之外的调用：${tool}`);
          return workerRunJsTurn(task.taskId, args, runJsMemo, taskFiles, signal);
        }
        if (tool !== EXECUTE_OPERATION_TOOL) throw new Error(`Worker 工具面之外的调用：${tool}`);
        const operation = typeof args.operation === 'string' ? args.operation : '';
        if (operation === '') throw new Error('execute_operation 缺少 operation。');
        if (!allowed.has(operation)) {
          // 发起前拒绝：零执行事实，但记下来——零执行时的失败话术要指向权限，不是「没干活」。
          hostRefusedOperations.push(operation);
          throw new Error(OPERATION_NOT_PERMITTED_MESSAGE);
        }
        const rawArgs = args.args;
        const baseCallArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
        // 载荷型参数装信封（宿主侧；发起执行之前）：模型给结构化值 → 宿主 lint+落盘 → 路径替换。
        // 失败（lint 未过/超上限）在此抛出——不发起执行、不落执行事实。
        const callArgs = preparePayloadArgs({
          operation,
          args: baseCallArgs,
          manifest: workerManifest,
          taskId: task.taskId,
          bridge: taskBridge,
          failures: payloadLintFailures,
          onEvent: options.onExecutionEvent,
        });
        // A2b 同对象确定性失败锁（发起前拒；不发起执行、不落执行事实）——键 + 判定与前台
        // inline 同一份（本次 execute 内该 (operation, 对象) 已被判确定性失败 → 不再打执行层）。
        const blockedRetry = retryLock.before(operation, callArgs);
        if (blockedRetry !== undefined) {
          options.onExecutionEvent?.({
            event: 'execution_retry_blocked',
            taskId: task.taskId,
            operation: blockedRetry.block.operation,
            object: blockedRetry.block.object,
            code: blockedRetry.block.code,
            declaredRetryable: blockedRetry.block.declaredRetryable ?? 'unset',
          });
          // 模型可见面：业务话术（复用 failureMessageFor 的唯一话术来源；内部原因/原始码不进
          // 模型文本），让 Worker 据此如实收尾，不再换参数撞执行层。宿主侧故障码归 host_fault，
          // 其余按 executor_failed（用户侧只允许「没办成 / 我这边没弄好」这类业务语言）。
          const classified = classifyFailure({ code: blockedRetry.block.code, status: 'failed' });
          const kind: UserFacingFailureKind = classified === 'host_fault' ? 'host_fault' : 'executor_failed';
          throw new Error(failureMessageFor(kind).text);
        }
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
            // 确认路径（只有 task_confirm 才会注入 pendingConfirmation）：句柄随本回合每条非只读
            // 执行透传（不再一轮只发一次——prepare 先消耗句柄会让后续 commit 拿不到；一次性/
            // 防重放归执行层自己保证）。resume（改口径）回合 pendingConfirmation 恒为 undefined。
            const confirmation = pendingConfirmation === undefined || readOnlyOperations.has(operation)
              ? undefined
              : { handle: pendingConfirmation.handle, userText: task.answer ?? '' };
            let outcome: ExecutionOutcome;
            try {
              outcome = await executionClient.execute(
                {
                  requestId,
                  dispatchKey,
                  operation,
                  args: callArgs,
                  ...(confirmation === undefined ? {} : { confirmation }),
                },
                { signal },
              );
            } catch (error) {
              // 桥物化失败（任务副本不可读）与 inline 同一话术：机械 reason 只进日志，
              // Worker 与用户不见存在性/状态差异（v8 §4）。
              if (error instanceof FileRefUnavailableError) {
                options.onFileRefUnavailable?.(error.reason);
                throw new Error(FILE_INPUT_UNAVAILABLE_MESSAGE);
              }
              throw error;
            }
            // 执行层已收到本次透传：句柄是否真的被接受由执行层回执说明（一次性/防重放
            // 归执行层，宿主不拦截复用）；宿主不判断确认语义。
            // 取消后到达的回执不落执行事实：任务已按取消处置，迟到的成功不得冒充本回合结果。
            if (signal.aborted) throw abortError();
            // 契约 v4：accepted 只允许出现在声明 long_running 的 operation 上。未声明却返回 =
            // 协议违约：落 failed（账行不落 accepted）并记事件，绝不把半截句柄交给宿主。
            if (outcome.status === 'accepted' && !longRunningOperations.has(operation)) {
              options.onExecutionEvent?.({
                event: 'execution_accepted_undeclared',
                taskId: task.taskId,
                operation,
                operationId: outcome.operationId,
              });
              outcome = {
                status: 'failed',
                error: {
                  code: 'EXECUTION_PROTOCOL_VIOLATION',
                  message: `执行层对未声明 long_running 的 operation「${operation}」返回了 accepted（协议违约）。`,
                },
              };
            }
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
        // A2b 记录（与前台 inline 同源）：执行层没有显式说可重试的失败 → 记入本回合锁；
        // 显式 retryable:true（瞬时故障）→ 放行并留「为什么还在试」的可见事实。
        const allowedRetry = retryLock.after(operation, callArgs, run.outcome);
        if (allowedRetry !== undefined) {
          options.onExecutionEvent?.({
            event: 'execution_retry_allowed',
            taskId: task.taskId,
            operation: allowedRetry.operation,
            object: allowedRetry.object,
            code: allowedRetry.code,
          });
        }
        if (run.unresolved) {
          unresolved = true;
          // 确定性终结本回合：待核对不得被模型当作可重试的普通失败。
          throw new ToolUserError(
            run.outcome.status === 'failed' ? run.outcome.error.message : RESULT_UNKNOWN_MESSAGE,
          );
        }
        // 取消胜出：不再把（可能迟到的）执行结果交回 Worker；让回合按 abort 收尾。
        if (signal.aborted) throw abortError();
        if (run.executed) recorded.push({ operation, outcome: run.outcome, dispatchKey: run.dispatchKey });
        // 与前台同一套脱敏投影：Worker 永远看不到 confirmation.handle（后台也曾直回原始
        // outcome，句柄会漏进模型上下文；S1 起两处共用 toModelVisibleOutcome）。
        // 大响应文件化（2026-11-19）同源：completed 超阈值 → 落任务文件、只回摘要 + fileId。
        return projectWorkerOutcome(run.outcome, {
          taskId: task.taskId,
          operation,
          thresholdBytes: oversizeDataBytes,
          ...(taskBridge === undefined ? {} : { bridge: taskBridge }),
          ...(options.onExecutionResultFileized === undefined
            ? {}
            : { onFileized: options.onExecutionResultFileized }),
          ...(options.onExecutionResultOversizeUnhandled === undefined
            ? {}
            : { onUnhandled: options.onExecutionResultOversizeUnhandled }),
          // 失败/拒绝归类只进日志（原始码与原文不进 Worker 可见投影）。
          ...(options.onExecutionEvent === undefined
            ? {}
            : {
              onClassified: (classified) => options.onExecutionEvent?.({
                event: 'execution_failure_classified',
                operation,
                code: classified.code,
                status: run.outcome.status as 'failed' | 'refused',
                kind: classified.kind,
              }),
            }),
        });
      };

      // 契约 v4：本轮以长任务受理收尾——正常结束回合（不是完成、不是失败）；runner 的
      // 等待端口随后驱动 wait。必须在「空汇报/未成功」判定之前，否则 accepted 会被误判失败。
      const acceptedRoundOf = (): TaskExecutionOutcome | undefined => {
        const entry = [...recorded].reverse().find((candidate) => candidate.outcome.status === 'accepted');
        if (entry === undefined) return undefined;
        const outcome = entry.outcome as Extract<ExecutionOutcome, { status: 'accepted' }>;
        options.onExecutionEvent?.({
          event: 'execution_accepted',
          taskId: task.taskId,
          operationId: outcome.operationId,
          operation: entry.operation,
        });
        return {
          kind: 'accepted',
          operationId: outcome.operationId,
          operation: entry.operation,
          // 账行键由 claimAndRunOperation 返回；兜底只为形状完整（正常路径恒有值）。
          dispatchKey: entry.dispatchKey ?? `task:${task.taskId}:accepted`,
          ...(outcome.pollAfterMs === undefined ? {} : { pollAfterMs: outcome.pollAfterMs }),
        };
      };

      const deadline = now() + workerTurnMs;
      let workerResult: TurnDriverResult;
      try {
        workerResult = await options.workerDriver.run({
          systemPrompt: renderWorkerSystemPrompt(options.workerWorkspaceRoot),
          // 片 1：Worker 工具面 = execute_operation +（注入执行器时）run_js（任务作用域）。
          // 未注入 = 数组与现行逐字节相同（只有 execute_operation）。
          tools: [executeOperationTool(), ...(options.runJsExecutor === undefined ? [] : [runJsTool('worker')])],
          messages: [userMessage(renderWorkerDelegation({
            task: task.request,
            manifest: workerManifest,
            ...(options.workerSkills === undefined ? {} : { skills: options.workerSkills }),
            // 后台文件面：清单只含当前任务的绑定行（交办副本/任务文件），Main 源 fileId 不进转录。
            ...(delegationFiles.length === 0
              ? {}
              : { files: delegationFiles, fileManifestHint: BACKGROUND_FILE_MANIFEST_HINT }),
            // waiting_user 续跑回合：用户补答必须随委派交给执行端（新 Worker 没有上一回合转录）。
            ...(task.answer === undefined ? {} : { answer: task.answer }),
            // 写确认续跑（显式确认切片）：**只有确认路径**才带 pendingConfirmation（见上）——
            // 用户明确确认 → 机械事实随委派交给 Worker，让它直接提交、不重新生成提案
            //（摘要可展示；handle 不进委派文本）。resume（改口径）不带该事实。
            ...(pendingConfirmation === undefined
              ? {}
              : { confirmationFact: renderConfirmationResumeFact(pendingConfirmation) }),
            // 句柄过期（owner 2026-11-19）：不带旧句柄，改为机械事实让 Worker 重新生成同一提案。
            ...(confirmationExpired ? { confirmationExpiredFact: renderConfirmationExpiredFact() } : {}),
            // 长任务续跑：wait 终态（已登记文件只有 fileId）原样注入本次委派。
            ...(resumedOperation === undefined || resumedOutcome === undefined
              ? {}
              : {
                resumedOperation: {
                  operationId: resumedOperation.operationId,
                  operation: resumedOperation.operation,
                  outcome: resumedOutcome,
                },
                resumeNote: longTaskResumeNote(resumedOperation, resumedOutcome),
              }),
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
        const accepted = acceptedRoundOf();
        if (accepted !== undefined) return accepted;
        if (isAbortErrorLike(error) && now() >= deadline) return { kind: 'timed_out' };
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      // 同上：正常返回路径也必须先判待核对，再判取消。
      if (unresolved) return { kind: 'result_unknown', reason: RESULT_UNKNOWN_MESSAGE };
      if (context.signal.aborted) return { kind: 'cancelled' };
      {
        const accepted = acceptedRoundOf();
        if (accepted !== undefined) return accepted;
      }
      if (workerResult.text.trim() === '') {
        return now() >= deadline
          ? { kind: 'timed_out' }
          : { kind: 'failed', reason: '执行层 Worker 未产出有效汇报，本次任务未完成。' };
      }
      // 写操作提案（S1）：本轮**最后一条非只读执行**是 needs_confirmation → 回合结局是
      // 待确认（不是 failed）——执行层已冻结一次待确认操作，用户还什么都没表态。只读调用
      // 不计（读调用不会产生待确认写操作）。提案句柄原样带走，由 runner 落底账待 S3 透传。
      const confirmationOutcomeOf = (entry: { operation: string; outcome: ExecutionOutcome }): Extract<TaskExecutionOutcome, { kind: 'needs_confirmation' }> => {
        const confirmation = (entry.outcome as Extract<ExecutionOutcome, { status: 'needs_confirmation' }>).confirmation;
        return {
          kind: 'needs_confirmation',
          question: { missing: [CONFIRMATION_PENDING_MISSING] },
          confirmation: {
            handle: confirmation.handle,
            summary: confirmation.summary,
            operation: entry.operation,
            ...(confirmation.expiresAt === undefined ? {} : { expiresAt: confirmation.expiresAt }),
          },
        };
      };
      const lastWritable = [...recorded].reverse().find((entry) => !readOnlyOperations.has(entry.operation));
      if (lastWritable !== undefined && lastWritable.outcome.status === 'needs_confirmation') {
        return confirmationOutcomeOf(lastWritable);
      }
      /**
       * 同回合自我确认被挡（owner 2026-11-19 live 实测，后台路径）：模型在**同一回合**里
       * prepare 出提案后紧接着 commit——同回合没有句柄，commit 被执行层以 CONFIRMATION_REQUIRED
       * 拒。结局不能落 failed：那样①用户从没被问到确认；②下游「有待确认提案就拒绝新建」的守卫
       * 不生效（任务不是 waiting_user）；③用户回「确认」时没有可接续的任务（owner live 三连症状）。
       *
       * 判据（结构化，不看文案）：本回合 recorded 里存在 needs_confirmation，且**所有** failed/refused
       * 条目的码都落在「不算真实失败」集合（CONFIRMATION_REQUIRED = 同回合没有句柄；PROPOSAL_*
       * / CALL_REFUSE = 模型误用了历史提案协议——见 SAME_TURN_TOLERATED_FAILURE_CODES）。满足则
       * 返回该提案的 needs_confirmation（句柄/摘要来自底账提案）；出现任何其它真实失败
       * （GATE_REFUSE / COLLECTION_NOT_FOUND / …）时返回 undefined，仍按现状判 failed。
       */
      const selfConfirmBlockedRoundOf = (): Extract<TaskExecutionOutcome, { kind: 'needs_confirmation' }> | undefined => {
        const proposal = [...recorded].reverse().find((entry) => entry.outcome.status === 'needs_confirmation');
        if (proposal === undefined) return undefined;
        // 「不算真实失败」的码见 SAME_TURN_TOLERATED_FAILURE_CODES：同回合被挡（CONFIRMATION_REQUIRED）
        // 与模型误用历史提案协议（PROPOSAL_* / CALL_REFUSE）都不算真失败；其余失败仍按 failed。
        const realFailure = recorded.find(
          (entry) =>
            (entry.outcome.status === 'failed' || entry.outcome.status === 'refused')
            && !SAME_TURN_TOLERATED_FAILURE_CODES.has(entry.outcome.error.code),
        );
        if (realFailure !== undefined) return undefined;
        return confirmationOutcomeOf(proposal);
      };
      const selfConfirmBlocked = selfConfirmBlockedRoundOf();
      if (selfConfirmBlocked !== undefined) return selfConfirmBlocked;
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
        // 发起前被宿主拒绝（权限/允许集合）时，用户该看到「没权限」，不是「模型没干活」：
        // 后者把权限问题说成模型问题，还会诱导用户让模型重试同一个动作。
        if (hostRefusedOperations.length > 0) {
          return { kind: 'failed', reason: OPERATION_NOT_PERMITTED_MESSAGE };
        }
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
      // CAP-01 S2 ④ 兜底扫描（与同步委派同一纪律）：任务 out/ 全量登记——执行层按
      // fileParams 写出的产物即使没走 run_js 也要回程；与回程登记同池去重。
      // 未注入桥 = 无兜底面（零变化缺省）。
      const swept = taskBridge?.sweepTaskOutputs();
      for (const file of swept?.files ?? []) pushTurnFileOnce(taskFiles, file);
      // 片 1 产物回程：Worker 的 run_js 产物已登记为**任务作用域**文件（task_id 绑定，
      // 登记时已 copy 进 workspace）。完成时随结局上交——后台面对 TurnResult.files 的
      // 同位面；装配方按它投递（投递去留与前台同一交付面/角色闸）。
      return {
        kind: 'completed',
        resultText: workerResult.text,
        ...(taskFiles.length === 0 ? {} : { files: taskFiles }),
      };
    },
  };
}
