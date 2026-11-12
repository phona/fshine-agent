/**
 * Thin adapter from the main Agent to a Pi subagent rooted in a trusted
 * platform workspace. The subagent returns natural language; the main Agent
 * decides whether to answer, ask the user, or resume the same session.
 *
 * 写开放（两步确认，方案 1 · C 波后只剩网关路径）：worker 的提案创建网关调用被驱动拦下
 * → 宿主办调平台 create → 平台回执取物单 proposalId 与渲染好的摘要 → 本层建 pending
 * intent（确认码哈希存储）→ 主代理转达。用户回复「确认 码」由 matchConfirmation 直接
 * 匹配执行（绕过模型）；「取消 码」作废；新提案使旧 pending 作废（superseded）。
 * 宿主持有的只有不透明 proposalId + 确认状态机：不解析 payload、不渲染业务摘要
 * （L4：宿主不该知道自己在提交什么业务）。
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import type { PendingPlanConfirmation } from './plan-runtime';
import type { PlanCliRunner } from './plan-runtime';
import { PLAN_NOTICE_PREFIX } from './plan-runtime';
import { stripForeignScratchPaths } from './server-paths';
import type { PlanEntitySources, TurnDeclaration } from './turn-contract';
import { ToolUserError, sumUsage, usageFieldsOf, usageSpanFields, type ProposalCreationOutcome, type SubagentNeeds, type TurnDriverResult, type UsageTotals } from './driver';
import { messageTextFor, toolUserErrorFor } from './error-codes';
import { isPlatformAuthError, type PlatformAuthFailure, type PlatformEnvelope, type SelectionClarification, type TerminalFastPathFailure } from './platform-contract';
import { gatewayExecPathForProfile, parseEnvelope } from './platform-contract';
import { renderTerminalFailureReply } from './turn-relay';
import { HANDOVER_VERSION, mergeExecutedCalls, readHandoverFileWithCode, writeHandoverFile, type HandoverExecutedCall, type HandoverReadCode, type HandoverReadResult, type TaskHandover } from './task-handover';
import { loadProposalSchema } from './operation-labels';
import { type ProposalReviewTurn, type ProposalReviewVerdict } from './proposal-review';
import { renderCommittedUnverifiedReply, type ReadBackCounts } from './committed-unverified';
import { reconcileResultContract, renderResultContractReply, type ResultContractDeclaration, type ResultContractReconciliation, type ResultObservation, type TaskResultPort, type TaskResultScope } from './result-contract';
import { renderStalledReply, startStallMonitor, type StallVerdict } from './task-stall';
import type { ProposalCreateCall } from './proposal-runtime';
import { materializeTaskInputs, requestWithFrozenInputs, type FrozenTaskInput } from './freeze-task-inputs';
import { classifyDelegationFailure } from './delegation-failure';
import { failureClassFor, deliverFailure } from './failure-delivery';
import type {
  ChangeIntentRecord,
  ChangeIntentRepo,
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  TrustedContext,
  DelegationBlock,
} from '@fshine/contracts';
import { A2A_PROTOCOL_VERSION, DEFAULT_WORKER_TIMEOUT_MS, resolveActiveProfileId } from '@fshine/contracts';
import {
  createPlatformExecutionGate,
  PlatformExecutionAbortedError,
  PlatformExecutionQueueFullError,
  type PlatformExecutionGate,
  type PlatformExecutionLease,
} from './platform-execution-gate';
import { DEFAULT_EXECUTOR_LABEL } from './agent-profile';

/**
 * 委派工具名的中性缺省（C3）。工具名是模型可见协议面：实例已发布的协议名由该实例的
 * profile 经 `toolName` 声明注入（createContextTaskRunner 解析 profile 后建 tool），
 * 宿主不把某个执行层的名字当作通用协议缺省。形状约束见 config 加载校验
 * （^[a-z][a-z0-9_]*$/，≤48）。
 */
export const RUN_EXECUTION_TASK_TOOL = 'run_task';

/**
 * 委派失败的用户话术（按 failureClass 分流，2026-09 审计 F7）。
 *
 * 原来四类失败（auth / timeout / executor_error / cancelled）只有日志里有分别，
 * 用户统一收到"执行失败，请稍后再试"——登录态过期这种**唯一需要用户动手**的
 * 类别因此被埋掉，用户只能盲目重试。这里按可行动性分流：
 *   · auth：必须重新登录，不说"稍后再试"（那是错指令，重试多少次都没用）；
 *   · timeout：平台侧慢，稍后重试是对的动作；
 *   · executor_error / cancelled：维持原话术。
 * 全部与业务无关（不出现任何领域词），只陈述状态与下一步动作。
 *
 * 措辞收口在 error-codes.ts（消息模板类：码 → 文本一一对应）；这里的常量是同一份
 * 表值的再导出，测试与调用方继续认常量。
 */
export const DELEGATION_AUTH_FAILURE = messageTextFor('DELEGATION_AUTH_FAILURE');
export const DELEGATION_TIMEOUT_FAILURE = messageTextFor('DELEGATION_TIMEOUT_FAILURE');
export const DELEGATION_EXECUTOR_FAILURE = messageTextFor('DELEGATION_EXECUTOR_FAILURE');
export const DELEGATION_CANCELLED = messageTextFor('DELEGATION_CANCELLED');
/**
 * 模型瞬时失败档（波次C，2026-11-01）：worker 模型调用瞬时中断、驱动侧有界重试用尽。
 * 与 executor 故障分开（见码表条目注释）；判据是 TurnDriverResult.modelError 在场
 * （驱动透传的模型侧失败事实，见 driver.ts 的字段注释）。
 */
export const DELEGATION_MODEL_TRANSIENT_FAILURE = messageTextFor('DELEGATION_MODEL_TRANSIENT_FAILURE');

/**
 * 委派工具描述（C4 称谓槽注入）：描述文本不携带实例名——「幻账平台/财税数据」等业务
 * 语义出宿主，只剩「执行层平台的实时数据」「受信的工作目录」两处通用表述；唯一可变槽
 * 是称谓（executorLabel，与系统提示词同一来源：profile 声明、缺省中性，不静默取实例名）。
 */
export function buildRunExecutionTaskDescription(executorLabel: string): string {
  return [
    `当用户的问题需要访问或处理执行层平台的实时数据时，将任务委托给 ${executorLabel}。`,
    `${executorLabel} 在受信的工作目录中加载平台 Skill，并返回自然语言结果。`,
    '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
    '涉及执行层实时数据时必须调用本工具，不得凭历史对话猜测平台标识或实时结果。',
    '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
  ].join('\n');
}

/** 委派工具参数 schema（C4 同槽：request 的 description 带称谓槽，taskId 中性）。 */
export function buildRunExecutionTaskSchema(executorLabel: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['request'],
    additionalProperties: false,
    properties: {
      request: { type: 'string', minLength: 1, description: `交给 ${executorLabel} 的完整任务或用户最新补充` },
      taskId: { type: 'string', description: '仅在继续此前子任务时使用返回的 taskId' },
    },
  };
}

/** 中性缺省形态（未声明称谓的部署与测试夹具拿到的文本）；实例称谓经 build* 注入。 */
export const RUN_EXECUTION_TASK_DESCRIPTION = buildRunExecutionTaskDescription(DEFAULT_EXECUTOR_LABEL);
export const RUN_EXECUTION_TASK_SCHEMA = buildRunExecutionTaskSchema(DEFAULT_EXECUTOR_LABEL);

/**
 * 委派任务的宿主侧参数（D-120：中性主名，别名已随 C3 退役）。字段全部是宿主持有的
 * 通用形态（请求文本、任务续跑句柄、计划步骤标签、申报块、实体来源）。
 */
export interface ContextTaskRunArgs {
  request: string;
  taskId?: string;
  /**
   * 计划模式（Phase 6）的步骤标签（「第 N/M 步」），由宿主从 request 的协议前缀解析出来。
   * 只用于给这一步委派过程中平台计划门产出的用户通知加前缀，让用户看到全局进度；
   * 不进 Main Agent 工具 schema，也不进 worker 提示词。
   */
  stepLabel?: string;
  /** Host-only semantic intent; this is never part of the Main Agent tool schema. */
  turnDeclaration?: TurnDeclaration;
  /**
   * 领域无关的实体来源（宿主注入）：计划里的每个实体必须能在「当前消息 / 检索证据 /
   * 本轮平台响应 / 本会话已确立实体」里逐字找到。同样不进入 Main Agent 工具 schema。
   *
   * 委派时写入任务条目快照（PlatformTaskRecord.entitySources）——inline 确认后恢复的
   * 来源由此读回；恢复调用也传它（快照原样回注），老任务无快照则拒绝恢复（G3）。
   */
  entitySources?: PlanEntitySources;
  /**
   * 本次委派对应的当前用户请求身份键（host-computed requestKey；见 repeat-request.ts）。
   * 只在新委派时由 runtime 传入、写进任务条目，供 RR1 窄门做"与此前已执行请求完全
   * 相同"的精确身份比对；续跑/恢复调用不传（保留原任务的身份，不被确认消息覆盖）。
   */
  requestKey?: string;
}

export interface SubagentTaskResult {
  taskId: string;
  text: string;
  /** Host confirmation result for an asynchronous host-owned operation; never an execution proof. */
  hostConfirmationOutcome?: ConfirmationOutcome;
  pendingPlan?: PendingPlanConfirmation;
  /** Host-verified proof that this delegated turn executed at least one platform call. */
  execution?: { planId: string; version: number; calls: number };
  /**
   * 方案已获批准（计划已激活）但本次零平台调用（P1 收尾兜底）。宿主据此说出真实状态
   * （批准了没执行、缺的是执行），而不是让用户补充早就给过的查询范围。
   */
  activatedPlan?: { planId: string; version: number };
  /**
   * 子 Agent 执行不了时的结构化线索（架构 §3 纠错环）。有它表示本轮缺信息、任务可续：
   * 宿主不把这一轮当失败，而是把线索交还 Main Agent 决定补齐还是问用户。
   */
  needs?: SubagentNeeds;
  /**
   * 结构化歧义/未找到（Stage 3 事故根治包）：平台请用户"选一个"的澄清事实。宿主据此
   * 用模板+信封数据机械组装澄清问题——模型是执行语言与用户语言之间唯一的翻译器，
   * 压力下翻译退化就会把脚本路径/错误码/门的规则漏进最终回复，所以状态转换的发音权
   * 收归宿主。与 execution 的出现不互斥（目录搜索这类调用真的发生过），但与 needs
   * 分工：一个是"缺什么"，一个是"选哪个"。
   */
  clarification?: SelectionClarification;
  /**
   * 错误态快路径的终局事实（驱动侧 terminalFailure 的透传）：平台确定性终局码以"整份
   * 答案"收尾，`text` 是宿主模板渲染的话术而非 worker 文本。判定单一事实源在驱动侧
   * （挂了就是整份答案），宿主只保留 !stepLabel 守卫——多步计划的一步带着本字段照旧
   * 交还链，不终结整轮。
   */
  terminalFailure?: TerminalFastPathFailure;
  /**
   * 平台登录/凭据类失败事实（驱动侧 authFailure 的透传）：本回合平台交互以登录/凭据类
   * 失败收尾（驱动从平台错误信封机械派生，判据在 platform-contract）。宿主当前不在
   * 编排层据此做冷却/退避判断（并发容忍与健康退避归执行层）；话术仍经既有失败链路
   * 如实上行。与 execution 不互斥——失败的那次调用真发生过。
   */
  authFailure?: PlatformAuthFailure;
  /**
   * 提案已登记（方案 1 · B 波 B3 网关提案路径，驱动侧 proposalCreated 的透传）：`text` 是
   * **宿主持有的确定性文本**（平台 `summaryText` 原样 + 通用确认行）。宿主据此把这段文本
   * 作为本轮回复——与澄清问题同一家族：出口校验的零执行标注不得覆盖它（提案这一步
   * 可能零网关执行，而"提案已登记、等用户确认"是真实状态）。
   */
  proposalCreated?: { proposalId: string };
  /**
   * worker 本回合的真实 token 消耗分项（纯加法遥测，口径见 driver.ts 的 sumUsage）：
   * 对 worker 转录里 assistant 消息的 provider Usage 求和，供 stepLabel 场景与测试断言。
   * 网关不回传 usage 时缺席——缺席（没证据）与全零（provider 如实报 0）必须可区分。
   */
  usage?: UsageTotals;
}

/**
 * Host-only file identity used to attribute workspace outputs to one Worker run.
 *
 * `sha256` 可选（D-116）：单文件超过快照上限时降级为只登记大小、不读内容不哈希
 * （条目标 `hashSkipped`）。降级条目因此不参与后续 diff 的内容比较（无哈希可比），
 * 大小变化仍然可见；skipped 计数经 `workspace_snapshot_limited` 日志事件留痕。
 */
export interface RunWorkspaceFile {
  path: string;
  relativePath: string;
  size: number;
  sha256?: string;
  hashSkipped?: true;
}

export interface PreparedContextTaskRunExecution {
  /** Independent manager-owned cancellation signal for background runs. */
  signal?: AbortSignal;
  /** Caller-owned shared platform lease; it is released only after execute settles. */
  lease: PlatformExecutionLease;
  startedAt: number;
  /** Absolute deadline computed after the shared platform gate grants a slot. */
  deadline: number;
  /** Background callbacks are independent of the original request frame. */
  background?: boolean;
  backgroundRunId?: string;
  onStep?: (text: string) => void;
  onNotice?: (text: string) => Promise<void>;
}

/** Validated, task-scoped execution snapshot. Preparation does not write worker task state. */
export interface PreparedContextTaskRun {
  readonly taskId: string;
  readonly request: string;
  readonly timeoutMs: number;
  readonly workspaceDir: string;
  /** Copies only the trusted input files after dispatch-key dedupe and before receipt. */
  materializeInputs?(runId: string): Promise<FrozenTaskInput[]>;
  snapshotWorkspace(): Promise<RunWorkspaceFile[]>;
  execute(options: PreparedContextTaskRunExecution): Promise<SubagentTaskResult>;
}

/**
 * Main 对交接读取的分级恢复结论（接口文档 §11，异常码即判据）：
 * - handover：交接可用，按交接续跑。
 * - transcript_only：交接从未写成（handover_missing），只凭转录续跑；新请求本身就是下一步。
 * - transcript_rebuilt：交接损坏族（解析失败 / 版本不符 / 形状非法），文件内容一律丢弃，
 *   只凭转录（workerMessages / 结果原文 / 已执行调用清单）重建；已确认意图与结果不依赖
 *   交接文件——意图住在 changeIntents 库、结果住在任务条目，转录在场时它们不受交接丢失影响。
 * - blocked：交接损坏且转录也无法重建（转录消息、结果原文、已执行调用清单全空），
 *   确实恢复不了、推进不了，才进入人工介入；这是人工介入的唯一条件，可恢复的损坏绝不推给人工。
 * - fresh：新任务，无续跑可言。
 */
export interface HandoverRecovery {
  code: HandoverReadCode | 'handover_fresh';
  level: 'handover' | 'transcript_only' | 'transcript_rebuilt' | 'blocked' | 'fresh';
  /** 损坏族文件内容是否已被丢弃（ok / missing / fresh 时为 false）。 */
  discarded: boolean;
  /** 续跑时已有的转录消息条数（重建依据的量，不是质量保证）。 */
  transcriptMessages: number;
  canProceed: boolean;
  blocked: boolean;
  /** blocked 时缺的东西（needs 的 missing 原样来源）；非 blocked 时为空。 */
  missing: string[];
}

export function resolveHandoverRecovery(input: {
  existing: PlatformTaskRecord | null;
  read: HandoverReadResult;
}): HandoverRecovery {
  const { existing, read } = input;
  if (!existing) {
    return { code: 'handover_fresh', level: 'fresh', discarded: false, transcriptMessages: 0, canProceed: true, blocked: false, missing: [] };
  }
  const transcriptMessages = existing.workerMessages.length;
  const transcriptAvailable = transcriptMessages > 0
    || Boolean(existing.resultText?.trim())
    || (existing.calls?.length ?? 0) > 0;
  if (read.code === 'handover_ok') {
    return { code: read.code, level: 'handover', discarded: false, transcriptMessages, canProceed: true, blocked: false, missing: [] };
  }
  if (read.code === 'handover_missing') {
    return { code: read.code, level: 'transcript_only', discarded: false, transcriptMessages, canProceed: true, blocked: false, missing: [] };
  }
  // 损坏族：文件内容一律丢弃；转录在场就重建，不在场才 blocked。
  if (transcriptAvailable) {
    return { code: read.code, level: 'transcript_rebuilt', discarded: true, transcriptMessages, canProceed: true, blocked: false, missing: [] };
  }
  const missing: string[] = [];
  if (transcriptMessages === 0) missing.push('转录消息');
  if (!existing.resultText?.trim()) missing.push('任务结果原文');
  if ((existing.calls?.length ?? 0) === 0) missing.push('已执行调用清单');
  missing.push('下一步的确定依据（交接文件已损坏且无转录可重建）');
  missing.push('待确认提案状态（交接丢失后无法确认本任务是否已有待确认提案）');
  return { code: read.code, level: 'blocked', discarded: true, transcriptMessages, canProceed: false, blocked: true, missing };
}

interface ContextTaskPreparationState {
  args: ContextTaskRunArgs;
  ctx: ContextTaskExecutionContext;
  profile: ResolvedContextProfile;
  existing: PlatformTaskRecord | null;
  taskId: string;
  scratchDir: string;
  workerRequest: string;
  messages: DriverMessage[];
  stepLabel: string;
  /** Host-written handover read on continue (null on a fresh task or a missing/corrupt file). */
  handover: TaskHandover | null;
  handoverRecovery: HandoverRecovery;
}

export type { SubagentNeeds };

/**
 * 新路径（提案归平台）的落账请求与结局（方案 1 · B 波 B4）。
 *
 * 只有一个不透明提案号——payload 全程住在执行层自己的状态库里，宿主连"这次提交的是什么
 * 业务"都不知道（L4：宿主不该知道）。用户可见文本因此只有两个来源：平台 `summaryText`
 * 原样 + 宿主通用状态行。
 */
export interface ProposalCommitRequest {
  /** 平台提案引用（取物单），创建时由平台 completed 信封给出。 */
  proposalId: string;
}
/** 落账前平台取问的三种"提案已不可用"形态——都不是执行失败（一次写入都没发生）。 */
export type ProposalUnavailableKind = 'expired' | 'not_pending' | 'unreadable';
export interface ProposalCommitResult {
  ok: boolean;
  /** 平台读回校验是否通过（信封 verified 列）。 */
  verified: boolean;
  /** 平台渲染的用户可见摘要（成败都由平台执笔）；宿主只原样转述，不拼不改。 */
  summaryText: string;
  /** 审计留痕（信封原文 + 读回计数行）：进 change_intents.result，不上屏。 */
  output: string;
  /** 运维侧原因（平台错误码/退出码）；上屏话术由宿主通用文案承担。 */
  error?: string;
  /** 提案在平台侧已不可用：给用户确定性解释，不落账、不谎称执行失败。 */
  unavailable?: ProposalUnavailableKind;
  /**
   * 已落账但读回不足（Phase 2）：平台已把提案标为 committed（不可二次提交），
   * 但落账后读回未达提案要求。宿主必须报独立终态，绝不报已完成，也绝不
   * 按普通失败处理（普通失败意味着一次写入都没发生，那是假话）。
   */
  committedUnverified?: boolean;
  /** 读回计数字段（平台信封原样搬运，仅用于终态报告的计数行）。 */
  readBack?: ReadBackCounts;
}

export interface ContextTaskRunnerOptions {
  profiles: Record<string, ContextProfileConfig>;
  tasks: PlatformTaskRepo;
  workerDriver: TurnDriver;
  /**
   * T10 结果对账（段1）：执行层声明 + 宿主独立读。缺省 = 不接线，本机制不启用
   * （现有行为零变化）；接线后只对"计划声称写/上传"的步骤生效。
   */
  taskResults?: TaskResultPort;
  /**
   * T10 停滞检测（段2）：只在 taskResults 同时接线时启用（判定输入必须是宿主独立读的
   * 执行层结果指标，缺端口就没有判据）。缺省 = 关闭。
   */
  stagnation?: TaskStagnationOptions;
  /** Shared with TaskManager and host-side platform commits; omitted test/legacy callers get a local gate. */
  executionGate?: PlatformExecutionGate;
  profileId?: string;
  /** 缺省 = 写流程整体禁用（提案按普通回答透传）。 */
  changeIntents?: ChangeIntentRepo;
  /** 意图有效期，默认 10 分钟。 */
  intentTtlMs?: number;
  /** 测试注入点。 */
  generateCode?: () => string;
  hashCode?: (code: string) => string;
  /**
   * 提案创建网关调用（方案 1 · B 波 B3）的执行注入点：宿主办调平台 `prepare <operation>
   * <payloadPath>`（cwd = platformRoot，serve 法域）。缺省用内置 spawn 实现；测试塞替身，
   * 因此不起平台也能钉住三态分流与 env 纪律。
   */
  proposalGatewayRunner?: PlanCliRunner;
  /**
   * 新路径的落账后端（B4）：确认码命中带 proposalId 的条目时，由服务端直调平台 commit
   * （cwd = platformRoot，serve 法域）。缺省 = 未接线；此时确认步只到达"确认收到但不写"
   * 的配置故障报告（host 侧如实说自己没做到，不承诺还没接上的事）。
   *
   * 2026-11-08 架构裁定后这里**没有**"这个部署允不允许落账"的开关位：写能不能真落地归
   * 执行层，宿主不再持有一个由部署 env 派生的 commit 授权布尔。宿主只如实描述"要提交
   * 什么"（平台 summaryText + 确认行），执行层的拒绝 / warning / dryrun 提示由平台自己的
   * commit 信封给出，宿主经既有失败链路上行转述。
   */
  proposalCommitRunner?: (req: ProposalCommitRequest) => Promise<ProposalCommitResult>;
  /**
   * 平台 plan 申请的命令形态（调用方从平台适配层取值注入，如 planDraftExample()）：
   * worker 系统提示词的许可段据此渲染，通用编排层不硬编码网关名（变更项 ②）。
   * 缺省 = 无平台能力，许可段整段不渲染。
   */
  planCommandForm?: string;
  /**
   * 写路径隔离复核回合（第 2 包已接线）：在提案创建成功、宿主发确认码
   * 之前运行。输入给平台下发的提案 schema（接口文档 §5，真实下发值，
   * 不再是 null）+ 域 dry-run 信封 + 平台渲染的 summaryText；输出只给
   * 一致/不一致 + 字段。不一致时不发确认码。生产装配必须注入
   * （`reviewProposalWithDriver(driver)`）；未注入时
   * fail-closed，直接失败并记 `proposal_review_required`，绝不记
   * skipped 日志就继续——`proposal_review_skipped` 事件已删除。
   */
  proposalReviewTurn?: ProposalReviewTurn;
  /**
   * 提案 schema 取问器（接口文档 §5）：按 profile 的 root 与 gateway
   * spawn `operation list --json`，取 proposal.create 行的
   * `proposalSchema`。缺省用 `loadProposalSchema`；测试可塞替身。
   * 返回 null / 非对象时提案创建直接失败（见下），不存在无 schema 路径。
   */
  proposalSchemaLoader?: (args: { platformRoot: string; gateway?: string }) => Promise<unknown | null>;
}

export interface ContextTaskExecutionContext {
  trusted: TrustedContext;
}

/**
 * T10 停滞检测的部署参数（毫秒）。生产取值由装配注入；测试用毫秒级替身。
 * 只描述"多久采样、指标连续不变多久判假死"，不携带任何业务指标选择——指标名由
 * 执行层声明（TaskResultPort），宿主不猜。
 */
export interface TaskStagnationOptions {
  sampleIntervalMs: number;
  unchangedForMs: number;
  /** 观测哪个指标；缺省 = 执行层每次返回的第一项。 */
  metric?: string;
}

export interface ContextTaskRunner {
  readonly tool: DiscoveredTool;
  prepare?(
    args: ContextTaskRunArgs,
    ctx: ContextTaskExecutionContext,
  ): Promise<PreparedContextTaskRun>;
  prepareConfirmation?(ctx: TrustedContext, message: string): Promise<PreparedContextTaskRun | null>;
  run(
    args: ContextTaskRunArgs,
    ctx: ContextTaskExecutionContext,
    signal?: AbortSignal,
  ): Promise<SubagentTaskResult>;
  /**
   * 确认码/取消码匹配：命中则由服务端直接执行或作废并返回回复（绕过模型）；
   * 未命中返回 null，消息按正常流程进入模型。
   *
   * 回复带结构化 outcome（2026-09 第二波）：turn_span 的日志分类从数据里取，
   * 不再嗅探自己刚生成的回复文本（旧实现拿回复 includes 一句"已作废"来分类，
   * 会把"取消一个已作废的码"误记成 confirm_cancelled——那一轮什么都没发生）。
   */
  matchConfirmation?(ctx: TrustedContext, message: string): Promise<ConfirmationReply | null>;
  /**
   * 把一次委派的**用户可见结果文本**回写任务条目（D-065 结构化事实的兜底渲染源）。
   *
   * 为什么由 runtime 调：这段文本与 Conversation Log 的 tool_result 事件同文（宿主组装
   * 的转达/交还材料），只有 runtime 知道最终形态；任务条目由此自含"这次委派用户看到了
   * 什么"，召回台账才能在结构化字段缺失时降级渲染它。存储失败只记日志——事实回写是
   * 增强，不回写不该让回合失败。
   */
  recordTaskResult?(taskId: string, facts: { resultText: string }): Promise<void>;
}

interface InternalContextTaskRunner extends ContextTaskRunner {
  run(
    args: ContextTaskRunArgs,
    ctx: ContextTaskExecutionContext,
    signal?: AbortSignal,
    preparedState?: ContextTaskPreparationState,
    execution?: PreparedContextTaskRunExecution,
  ): Promise<SubagentTaskResult>;
}

/**
 * 确认码匹配的结构化结局（替代回复文本嗅探）：
 *   · confirm_executed：确认码命中待确认提案且落账完成；
 *   · confirm_cancelled：取消码命中待确认提案且作废完成；
 *   · confirm_failed：确认/落账链路失败（执行器未配置或落账未完成，意图置 failed）；
 *   · confirm_committed_unverified：已落账但读回不足（Phase 2 独立终态，意图置
 *     committed 以防二次提交，任务结局置 failed 以留人工核对口，绝不报已完成）；
 *   · confirm_held：确认收到但落账执行未启用，提案保持待确认（无状态变化）；
 *   · confirm_stale：码已终结，给出确定性解释（无状态变化）。
 */
export type ConfirmationOutcome =
  | 'confirm_executed'
  | 'confirm_cancelled'
  | 'confirm_failed'
  | 'confirm_committed_unverified'
  | 'confirm_held'
  | 'confirm_stale';

export interface ConfirmationReply {
  text: string;
  outcome: ConfirmationOutcome;
}

/**
 * 意图条目的用户可读标签。业务字段不在宿主库往返（payload 归执行层自己的提案状态库），
 * 所以这里拿不到任何领域信息——统一降级成中性表述，绝不把 undefined 渲染给用户，
 * 也不为了"更具体"而去解析 worker 文本或平台信封（L4）。
 */
function intentLabel(): string {
  return '本次录入提案';
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CONFIRM_RE = /确认\s*([A-Z0-9]{6})/;
const CANCEL_RE = /取消\s*([A-Z0-9]{6})/;

/** 平台提案摘要进用户消息的长度上限：它是数据不是长文，超长按预算截断（不编辑含义）。 */
const SUMMARY_TEXT_MAX_CHARS = 500;

/**
 * 落账未完成的用户话术（协议文本，唯一来源）：只说事实与下一步，不猜平台内部状态。
 */
const COMMIT_FAILED_LINE = '执行失败：落账未完成，系统已停止并留痕。请联系管理员核对平台实际状态后，再重新发起录入。';

/**
 * 新路径落账成功的宿主通用状态行（协议文本，唯一来源）：只陈述确认码的结局，不重复平台
 * 摘要已经说过的内容（张数/合计由平台执笔，宿主拼一行就是第二份摘要）。
 */
const COMMIT_DONE_LINE = '确认码已核销，落账已完成。';

/**
 * 落账前平台取问说"提案已不可用"时的用户话术（按形态分流，都是确定性解释）。
 *
 * 为什么与"执行失败"分开：这三种形态下一次写入都没有发生，说"执行失败请联系管理员"是
 * 把"请重新发起"这条唯一可行动的路藏了起来；而平台读不到状态时也不能假装知道原因。
 */
const PROPOSAL_UNAVAILABLE_TEXT: Record<ProposalUnavailableKind, string> = {
  expired: '该确认码对应的提案已过期（超过有效期），请重新发起录入。',
  not_pending: '该确认码对应的提案已终结，无需重复确认；本次未写入任何数据。',
  unreadable: '该确认码对应的提案当前不可用（平台侧读不到有效状态），本次未写入任何数据；请重新发起录入。',
};

/**
 * 宿主直调平台网关的环境：**显式剥 `EXECUTION_REQUIRE_PLAN`**。不声明执行法域。
 *
 * 修 D-081：那个 mandate 是给 worker 的 bash 子进程的（每个 worker 命令都带它，见
 * createPlanScopedWorkerEnv），服务进程自己并不带。宿主直调是"服务端替 worker 办一件事"，
 * 不该被 worker 的计划门拦——否则同一份部署里服务端调得动、worker 调不动，或反过来，
 * 取决于进程 env 恰好有什么。剥显式表达"这里不过计划门"，不靠继承来的 env 碰巧为空。
 *
 * 2026-11-10：宿主声明面归零。法域判定归执行层；编排驱动的信号是随调用走的协议材料
 * （计划绑定与签名令牌），不在这份 env 里加域标记，也不改命令模板。
 *
 * 导出共认一份：宿主直调平台的两处（提案创建、提案落账，B 波 B3/B4）用同一把尺——
 *  env 纪律在两处各写一遍，就是给"某一处忘了剥"留门。
 */
export function hostGatewayEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.EXECUTION_REQUIRE_PLAN;
  return env;
}

/**
 * 宿主办调平台网关的 HMAC 密钥（进程内生成，C 波起与 hostGatewayEnv 同住一处：两者都是
 * "宿主持有的直调法域"这一族事实）。
 *
 * 为什么不进 env（W7）：进程级注入会让模型经 read/工具面拿到密钥自行铸令牌。它只以参数
 * 形式交到具体执行器（提案创建 / 提案落账各持一份引用），再由执行层经 env 传给**那一个**
 * 子进程——子进程 env 是边界，进程 env 不是。重启使未决令牌自然失效，这正是想要的性质。
 */
export function newGateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 宿主直调平台网关的缺省实现（`prepare <operation> <payloadPath>`，cwd = platformRoot）。
 *
 * 与 plan-runtime 的 defaultCliRunner 同一形状（spawn + 收 stdout/stderr + 30s 超时），
 * 因此测试可以塞同一个 PlanCliRunner 替身。超时/ spawn 失败按非零退出 + stderr 交还，
 * 由调用方走"平台拒绝"分支——宿主不猜平台内部状态。
 */
const defaultProposalGatewayRunner: PlanCliRunner = ({ platformRoot, args, env, gateway }) => new Promise((resolve, reject) => {
  // Profile 声明优先：调用方（createProposalViaGateway）把 resolve 出的
  // profile.gateway 传进来；C7b 起 fail-closed——未声明/非法即抛，宿主不回退
  // 任何遗留网关名（与 plan-runtime 的 defaultCliRunner 同法）。
  const child = spawn(gatewayExecPathForProfile(platformRoot, { gateway }), args, {
    cwd: platformRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
});

function defaultGenerateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function defaultHashCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

/**
 * 把驱动上报的结构化事实（D-065）合并进任务条目：calls/scopeValues/label 取本次
 * 委派的快照（替换式——任务的最新范围），resultText 追加（同一任务多次委派的结果 trail，
 * 上限见 RESULT_TEXT_MAX_CHARS），outcome 由委派结局定。全部字段可选——缺一个就不写一个，
 * 消费方据此降级，不猜不补。
 */
const RESULT_TEXT_MAX_CHARS = 2_000;

/**
 * Host-written turn-end handover (Phase 2). Fields come only from host
 * facts: execution proof (plan id/version), host-parsed plan calls, and
 * the result text already shown. Worker prose is never a handover source.
 * Merges with the previous handover's executed calls by exact key, so a
 * resumed turn never double-counts a call it already made. Best-effort:
 * a write failure only logs, it must not fail the turn (same discipline
 * as the D-065 result-text writeback).
 */
function writeTurnHandover(
  platformRoot: string,
  taskId: string,
  result: TurnDriverResult,
  previous: TaskHandover | null,
  kind: 'ok' | 'pending_plan' | 'needs_input' | 'proposal_created' | 'terminal',
): void {
  try {
    const calls: HandoverExecutedCall[] = (result.planFacts?.calls ?? []).map((call) => ({
      operation: call.operation,
      args: call.args.filter((a): a is string => typeof a === 'string'),
    }));
    const merged = mergeExecutedCalls(previous?.executedCalls ?? [], calls);
    const unfinished =
      kind === 'pending_plan' ? ['等待用户确认计划']
      : kind === 'needs_input' ? ['等待用户补充信息']
      : kind === 'proposal_created' ? ['等待用户确认提案']
      : [];
    const nextAction =
      kind === 'pending_plan' ? '用户确认计划后继续执行'
      : kind === 'needs_input' ? '用户补充信息后继续'
      : kind === 'proposal_created' ? '用户确认提案后继续'
      : '任务已完成，无后续动作';
    writeHandoverFile(platformRoot, taskId, {
      version: HANDOVER_VERSION,
      taskId,
      planId: result.execution?.planId ?? previous?.planId ?? null,
      planVersion: result.execution?.version ?? previous?.planVersion ?? null,
      completedSteps: merged.map((call) => `${call.operation} ${call.args.join(' ')}`.trim()),
      executedCalls: merged,
      unfinishedSteps: unfinished,
      nextAction,
      lastResultSummary: result.text.trim().slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'task_handover_write_failed', taskId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
}

function withExecutionFacts(
  running: PlatformTaskRecord,
  result: TurnDriverResult,
  outcome: PlatformTaskRecord['outcome'],
): PlatformTaskRecord {
  const facts = result.planFacts;
  const resultText = [running.resultText, result.text.trim()].filter(Boolean).join('\n').slice(-RESULT_TEXT_MAX_CHARS);
  return {
    ...running,
    outcome,
    ...(facts ? {
      calls: facts.calls.map((call) => ({ operation: call.operation, args: call.args })),
      ...(facts.scopeValues && facts.scopeValues.length > 0 ? { scopeValues: [...facts.scopeValues] } : {}),
      ...(facts.label ? { label: facts.label } : {}),
    } : {}),
    ...(resultText ? { resultText } : {}),
  };
}

async function hashWorkspaceFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 快照体积上限（D-116）：before/after 快照在共享平台槽位被持有的窗口内执行
 * （task-manager 在 lease 取得后、worker 启动前取 before 快照），无界 walk + 逐文件
 * 整读会把平台槽位耗在纯宿主开销上。量级对照 write 门（MAX_WRITE_BYTES=256KB，
 * 单次写即封顶）：worker 产物单个通常远低于 32MB；单文件 32MB / 总量 256MB / 条目
 * 2 万之后再多的内容对"输出归属判定"（before/after diff）已无增益，只剩成本。
 * 超限不是失败：超单文件上限 → 条目只登记大小并标 hashSkipped（不读不哈希）；
 * 超总量或总条数 → 停止遍历；两者都发 `workspace_snapshot_limited` 日志事件留痕。
 */
const SNAPSHOT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_MAX_FILE_COUNT = 20_000;

/**
 * Captures a safe, exact run workspace manifest; symlinks and paths escaping the task root are ignored.
 * `hashFile` is the hashing injection point (tests count reads without touching file contents).
 */
export async function snapshotWorkspaceFiles(
  platformRoot: string,
  workspaceDir: string,
  hashFile: (filePath: string) => Promise<string> = hashWorkspaceFile,
): Promise<RunWorkspaceFile[]> {
  const platformReal = await fs.realpath(platformRoot).catch(() => null);
  if (!platformReal) return [];
  const workspacePath = path.resolve(platformReal, workspaceDir);
  const workspaceReal = await fs.realpath(workspacePath).catch(() => null);
  if (!workspaceReal || !isInside(platformReal, workspaceReal)) return [];

  const files: RunWorkspaceFile[] = [];
  let totalBytes = 0;
  let oversizeSkipped = 0;
  let stoppedEarly = false;
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (stoppedEarly) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const realPath = await fs.realpath(fullPath).catch(() => null);
      if (!realPath || !isInside(workspaceReal, realPath)) continue;
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat?.isFile()) continue;
      const relativePath = path.relative(workspaceReal, realPath).split(path.sep).join('/');
      if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
        // D-116 降级：只登记大小，不读内容、不哈希——diff 的内容比较对它失效（无哈希
        // 可比），大小变化仍可见；skipped 计数进下方日志事件。
        oversizeSkipped += 1;
        files.push({ path: realPath, relativePath, size: stat.size, hashSkipped: true });
      } else {
        try {
          files.push({ path: realPath, relativePath, size: stat.size, sha256: await hashFile(realPath) });
        } catch {
          // A transiently changing or unreadable file is not a stable artifact candidate.
        }
      }
      totalBytes += stat.size;
      if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES || files.length >= SNAPSHOT_MAX_FILE_COUNT) stoppedEarly = true;
    }
  };
  await walk(workspaceReal);
  if (oversizeSkipped > 0 || stoppedEarly) {
    console.warn(JSON.stringify({
      event: 'workspace_snapshot_limited',
      workspaceDir,
      hashedFiles: files.length - oversizeSkipped,
      hashSkippedOversize: oversizeSkipped,
      totalBytes,
      stoppedEarly,
    }));
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function createContextTaskRunner(options: ContextTaskRunnerOptions): ContextTaskRunner {
  // Active profile 派生（C5）：显式指定优先；未指定且恰有一个 profile → 该键；
  // 0 个或多个 → undefined，消费方（resolveContextProfile）fail-closed。宿主不把
  // 任何执行层实例名当缺省。
  const profileId = options.profileId ?? resolveActiveProfileId(options.profiles);
  const intentTtlMs = options.intentTtlMs ?? 10 * 60_000;
  const generateCode = options.generateCode ?? defaultGenerateCode;
  const hashCode = options.hashCode ?? defaultHashCode;
  const platformQueueCapacity = Number.parseInt(process.env.FSHINE_PLATFORM_QUEUE_CAPACITY ?? '', 10);
  const executionGate = options.executionGate ?? createPlatformExecutionGate({
    maxQueue: Number.isFinite(platformQueueCapacity) && platformQueueCapacity >= 0 ? platformQueueCapacity : 100,
  });
  // Active profile 的声明面（C3/C4/C5）：profileId 派生失败（0/多个 profile 未显式指定）
  // 时为 undefined，工具面全部落到中性缺省；真实委派在 resolveContextProfile 处 fail-closed。
  const activeProfile = profileId === undefined ? undefined : options.profiles[profileId];
  // 工具描述的称谓与系统提示词同源（C4）：profile.executorLabel 声明，缺省中性。
  const effectiveExecutorLabel = activeProfile?.executorLabel ?? DEFAULT_EXECUTOR_LABEL;
  const tool: DiscoveredTool = {
    // 工具名 = profile.toolName 声明（C3），缺省中性（RUN_EXECUTION_TASK_TOOL）：
    // 实例已发布的工具协议名由该实例自己的 profile 声明保持连续，宿主不取实例名缺省。
    name: activeProfile?.toolName ?? RUN_EXECUTION_TASK_TOOL,
    description: buildRunExecutionTaskDescription(effectiveExecutorLabel),
    inputSchema: buildRunExecutionTaskSchema(effectiveExecutorLabel),
  };

  /**
   * 宿主通用确认行（协议文本，唯一来源）：确认码 + 取消码 + 有效期。
   *
   * 2026-11-08 架构裁定后只有一种形态：宿主如实描述"提交什么"（这条指令会让服务端把提案
   * 交回平台落账），不预先声明"会不会写入"——那是执行层的事，它的拒绝 / warning / dryrun
   * 提示由平台信封给出并在此后的失败链路上行。原来那句"当前落账执行未启用——确认不会写入
   * 任何数据"是宿主拿部署 env 派生出来的承诺，随派生位一起删除。
   */
  function confirmLineFor(code: string): string {
    const ttlMinutes = Math.round(intentTtlMs / 60_000);
    return `回复「确认 ${code}」执行录入；回复「取消 ${code}」作废。${ttlMinutes} 分钟内有效。`;
  }

  /**
   * 平台 `summaryText` 的取用卫生（进用户消息的数据）：剥控制字符、折叠空白、截断。
   *
   * 为什么不是"原样拼上"：它是进用户回复的**数据**，与平台 correctForm / 候选名同一族
   * （platform-contract 的 correctFormOf 同一套卫生）。截断是预算不是编辑——平台的提案
   * 摘要是一句话，正常形态远低于上限；控制字符则一律不该进用户消息。
   */
  function summaryTextOf(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_TEXT_MAX_CHARS);
  }

  /**
   * 平台 `needs_input` 信封 → 纠错环线索（确定性，零 worker 文本解析）。
   *
   * missing 只取平台结构化 `data.needs[].name`——那是平台自己说"还缺哪个对象"的字段；
   * reason 用信封的码与消息。信封两者都不给时降级成中性标签，绝不猜。
   */
  function proposalNeedsOf(envelope: PlatformEnvelope): SubagentNeeds {
    const data = envelope.data as { needs?: unknown } | null;
    const names = Array.isArray(data?.needs)
      ? data.needs
        .map((item) => (item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined))
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];
    const code = envelope.error?.code;
    const message = envelope.error?.message;
    const reason = [code, message].filter((part) => typeof part === 'string' && part).join('：');
    return {
      missing: names.length > 0 ? names : ['平台要求的补充信息'],
      reason: `${reason || '平台需要更多信息才能创建提案'}（平台返回 needs_input）`,
    };
  }

  /**
   * 网关提案路径（方案 1 · B 波 B3，C 波后唯一的提案路径）：worker 的提案创建网关调用
   * 被驱动拦下后，由宿主办调平台 create，把结局三态交还驱动。
   *
   * 宿主**不解析 payload**——payload 全程不进宿主，宿主持有的只剩平台返回的取物单
   * proposalId + 通用确认状态。用户可见文本因此只有两个来源：平台 `summaryText`
   * 原样 + 宿主通用确认行，不写任何业务摘要。
   *
   * 顺序即安全：办调平台 → 落意图条目 → 生成确认码。
   *
   * 2026-11-08 架构裁定后**没有**办调前的"写开放复核"：写能不能真落地是执行层的事，
   * 宿主不再持有一个"这个部署允不允许写"的布尔，也不在办调前拿它拒掉请求。执行层自己的
   * 拒绝 / warning / dryrun 提示由平台信封给出，宿主经 `failed` 分支的 errorCode /
   * workerText 如实转述给用户与 worker。
   * 实体授权不在此复核：宿主不解释业务实体（payload 不透明），读写语义归执行层。
   */
  async function createProposalViaGateway(
    call: ProposalCreateCall,
    ctx: ContextTaskExecutionContext,
    taskId: string,
    platformRoot: string,
    gateway?: string,
  ): Promise<ProposalCreationOutcome> {
    // 办调平台（serve 法域；env 显式剥 EXECUTION_REQUIRE_PLAN——修 D-081：宿主直调不该被
    // worker 的计划门拦，那个 mandate 是给 worker 子进程的）。operation 名来自驱动拦截时
    // 从命令里取到的目标 token（平台 protocol 列已声明它扮演创建提案角色），宿主不另持
    // 一份业务 operation 名单。
    const result = await (options.proposalGatewayRunner ?? defaultProposalGatewayRunner)({
      platformRoot,
      args: ['prepare', call.operation, call.payloadPath],
      env: hostGatewayEnv(),
      ...(gateway ? { gateway } : {}),
    });
    const envelope = parseEnvelope(result.stdout);
    if (!envelope) {
      return { status: 'failed', workerText: `平台未返回 RESULT 信封（exit ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 300)}` };
    }
    if (envelope.status === 'completed') {
      const data = envelope.data as { proposalId?: unknown; summaryText?: unknown } | null;
      const proposalId = typeof data?.proposalId === 'string' ? data.proposalId.trim() : '';
      const summaryText = summaryTextOf(data?.summaryText);
      // 平台说 completed 却不给取物单或摘要：不能建条目（没有 proposalId 就无法在确认后
      // 定位提案），也不能把一句空摘要发给用户。按失败处理，原因说清缺什么。
      if (!proposalId || !summaryText) {
        return { status: 'failed', workerText: `平台的 completed 信封缺少 proposalId/summaryText（proposalId=${proposalId || '空'}），未创建待确认任务。` };
      }
      // 写路径隔离复核（第 2 包）：在发确认码之前，独立回合比对
      // 平台下发的提案 schema + 域 dry-run 信封 + summaryText。
      // 缺复核驱动、缺 schema、schema 非法、不一致——一律不发确认码
      // （fail-closed），且不作废、不重试、不兜底放行、不降级为只比摘要。
      if (!options.proposalReviewTurn) {
        console.info(JSON.stringify({ event: 'proposal_review_required', requestId: ctx.trusted.requestId, taskId, proposalId }));
        return { status: 'failed', workerText: '提案隔离复核未接线，未发确认码，请重新发起录入。' };
      }
      const proposalSchemaLoader = options.proposalSchemaLoader ?? (async (args: { platformRoot: string; gateway?: string }) => loadProposalSchema(args.platformRoot, args.gateway));
      const proposalSchema = await proposalSchemaLoader({ platformRoot, gateway });
      if (!proposalSchema || typeof proposalSchema !== 'object' || Array.isArray(proposalSchema)) {
        console.info(JSON.stringify({ event: 'proposal_review_schema_missing', requestId: ctx.trusted.requestId, taskId, proposalId }));
        return { status: 'failed', workerText: '平台未下发提案 schema，未发确认码，请重新发起录入。' };
      }
      const verdict = await options.proposalReviewTurn({
        proposalSchema,
        dryRunEnvelope: envelope,
        summaryText,
      });
      console.info(JSON.stringify({
        event: 'proposal_review',
        requestId: ctx.trusted.requestId,
        taskId,
        proposalId,
        verdict: verdict.verdict,
        fields: verdict.fields,
        ...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
      }));
      if (verdict.verdict !== 'consistent') {
        const fields = verdict.fields.length ? `（不一致字段：${verdict.fields.join('、')}）` : '';
        return {
          status: 'failed',
          workerText: `提案隔离复核未通过${fields}，未发确认码，请重新发起录入。`,
        };
      }
      const ci = options.changeIntents;
      if (!ci) throw new ToolUserError(messageTextFor('PROPOSAL_FLOW_NOT_CONFIGURED'), { code: 'PROPOSAL_FLOW_NOT_CONFIGURED' });
      // 新提案作废**同任务**的旧 pending（D-117，2026-10-26 拍板 I2：一任务一码）。
      // 跨任务的 pending 并存——后台长任务跑到中途出的提案，不得作废用户前台正要
      // 确认的另一个任务的提案（I1 全会话单窗会让后台提案打断前台确认，与后台
      // "不打扰前台"的设计初衷冲突）。已接受的代价：同一用户可同时持多个任务的
      // 有效确认码，回错码=确认错任务，由确认码三元绑定（principal/session/task）
      // + TTL 兜底。
      const active = await ci.findPendingBySession(
        ctx.trusted.principalId,
        ctx.trusted.sessionId,
        taskId,
      );
      if (active) await ci.updateStatus(active.intentId, 'superseded');
      const code = generateCode();
      const now = new Date();
      // 新形状：零业务字段、零 payload——proposalId（取物单）+ taskId（关联执行事实）+
      // 确认状态机必需的通用字段。
      await ci.create({
        intentId: `intent_${randomUUID()}`,
        principalId: ctx.trusted.principalId,
        sessionId: ctx.trusted.sessionId,
        taskId,
        proposalId,
        confirmCodeHash: hashCode(code),
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + intentTtlMs).toISOString(),
      });
      console.info(JSON.stringify({
        event: 'proposal_created',
        requestId: ctx.trusted.requestId,
        taskId,
        gateway: 'on',
      }));
      return {
        status: 'completed',
        proposalId,
        // 用户可见文本 = 平台 summaryText 原样 + 通用确认行（宿主不拼任何业务摘要）。
        userText: [summaryText, confirmLineFor(code)].join('\n'),
        // 给 worker 的确定性消息：提案已登记 + 等用户确认，**不含确认码**。
        workerText: '提案已在平台登记，等待用户确认。本回合到此结束：不要再输出提案 JSON，也不要尝试提交或确认。',
      };
    }
    if (envelope.status === 'needs_input') {
      const needs = proposalNeedsOf(envelope);
      return { status: 'needs_input', needs, workerText: `平台还需要更多信息才能创建提案：${needs.reason}` };
    }
    const errorCode = envelope.error?.code;
    const errorMessage = envelope.error?.message;
    const detail = [errorCode, errorMessage].filter((part) => typeof part === 'string' && part).join('：');
    return {
      status: 'failed',
      workerText: `平台拒绝创建提案：${detail || `status=${envelope.status}`}（exit ${result.code}）`,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  /**
   * 发起提案的子任务结局回写（D-082）：committed 与 confirm_failed 两个分支都把 originating
   * `platform_tasks` 的 outcome 推到终态。
   *
   * 为什么必须有：落账是这一轮的终点，而任务条目是"这次委派发生了什么"的自含事实源
   * （D-065）。不回写时条目永远停在创建时的样子，召回台账与不变量检查器看到的是一个
   * 悬挂任务——"写成功了但任务没结局"于是只能靠例外清单放行（invariant-checker L1 的
   * expectedOpenTasks 即此形状，B 波后已撤）。
   *
   * 失败只记日志：回写是事实投影的补全，不该让已经结束的落账回合翻红。
   */
  async function writeBackTaskOutcome(taskId: string | undefined, outcome: PlatformTaskRecord['outcome']): Promise<void> {
    if (!taskId) return;
    try {
      const existing = await options.tasks.get(taskId);
      if (!existing) return;
      await options.tasks.upsert({ ...existing, outcome, updatedAt: new Date().toISOString() });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'platform_task_outcome_writeback_failed',
        taskId,
        outcome,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error),
      }));
    }
  }

  /**
   * 带 proposalId 的条目的确认落账（方案 1 · B 波 B4）：确认码命中后由服务端直调平台
   * commit，全程不经任何模型。
   *
   * 宿主**只持有一个取物单**——payload 在平台侧，宿主连"在提交什么业务"都不知道。用户
   * 可见文本因此只有两个来源：平台 `summaryText` 原样 + 宿主通用状态行。
   *
   * 2026-11-08 架构裁定后确认时点**不再有宿主侧的写开放复核**：宿主不持"这个部署允不允许
   * 落账"的布尔（原 proposalCommitEnabled 由部署 env 派生），也就不在调 commit 前拿它拒掉
   * 一次已经拿到确认码的确认。写能不能真落地由执行层的 commit 门裁决：它的拒绝 / warning /
   * dryrun 提示走下面既有的 `unavailable` / `!ok` 失败链路上行，用户看到的是平台自己说的
   * 话，不是宿主代判的"未开放写入权限"。
   * 两笔旧债的落点：
   *   · D-081 由 commit 后端的 env 纪律承担（hostGatewayEnv 剥 EXECUTION_REQUIRE_PLAN）；
   *   · D-082 由 writeBackTaskOutcome 承担（committed / confirm_failed 都回写终态）。
   */
  async function confirmProposalViaGateway(
    rec: ChangeIntentRecord,
    proposalId: string,
    execution: { leaseHeld?: boolean; signal?: AbortSignal } = {},
  ): Promise<ConfirmationReply> {
    const ci = options.changeIntents!;
    if (!execution.leaseHeld) {
      // 准入背压（2026-11-10 仲裁）：闸不再限制平台并发，也不再排队等待——确认回执不会被
      // 别会话的长 worker 挡在闸外。唯一还能拦下确认的是宿主待办深度已满（maxQueue），
      // 那按 confirm_held 返回：提案保持 pending，用户稍后重发同一确认码即可续办。
      try {
        return await executionGate.run(
          {
            requestId: rec.taskId ?? rec.intentId,
            ...(execution.signal ? { signal: execution.signal } : {}),
          },
          () => confirmProposalViaGateway(rec, proposalId, { leaseHeld: true, ...(execution.signal ? { signal: execution.signal } : {}) }),
        );
      } catch (error) {
        if (error instanceof PlatformExecutionQueueFullError) {
          return { text: '平台执行队列已满，请稍后重试；提案仍待确认。', outcome: 'confirm_held' };
        }
        if (execution.signal?.aborted || error instanceof PlatformExecutionAbortedError) {
          return { text: '确认已收到，但平台提交已取消；提案仍待确认。', outcome: 'confirm_held' };
        }
        throw error;
      }
    }
    // Recheck the exact host confirmation after admission. A stale/superseded/expired
    // confirmation must never reach the platform commit runner.
    const stillPending = await ci.findPendingByConfirm(rec.principalId, rec.sessionId, rec.confirmCodeHash, new Date());
    if (!stillPending || stillPending.intentId !== rec.intentId || stillPending.proposalId !== proposalId) {
      const latest = await ci.get(rec.intentId);
      const why: Record<ChangeIntentRecord['status'], string> = {
        pending: '仍在等待确认',
        committed: '已完成录入',
        expired: '已过期',
        cancelled: '已作废',
        superseded: '已被更新的提案取代',
        failed: '执行失败',
      };
      return { text: `该确认码对应的提案${latest ? why[latest.status] : '已不可用'}。`, outcome: 'confirm_stale' };
    }
    rec = stillPending;
    const commitRunner = options.proposalCommitRunner;
    if (!commitRunner) {
      // 后端没注入 = 配置故障。fail-closed：不猜一个执行器出来。这是"编排没做到自己说
      // 的话"（确认行承诺了执行录入）就如实说，不是对"这个部署允不允许写"的判断。
      console.error(JSON.stringify({ event: 'change_intent_commit_failed', intentId: rec.intentId, reason: 'proposal_commit_runner_missing' }));
      await ci.updateStatus(rec.intentId, 'failed', { error: 'proposal commit runner 未配置' });
      await writeBackTaskOutcome(rec.taskId, 'failed');
      return { text: '执行失败：落账执行器未配置，请联系管理员。', outcome: 'confirm_failed' };
    }
    const out = await commitRunner({ proposalId });
    // 平台摘要进用户消息前过同一把卫生尺（剥控制字符/折叠空白/截断）：它是数据不是长文。
    const summaryText = summaryTextOf(out.summaryText);
    // ③ 提案在平台侧已不可用：确定性解释 + 意图归档，一次写入都没发生（不是执行失败）。
    // 意图按"这个确认码已经不能再用"归档成 expired——平台侧 payload 的实际结局以平台
    // 状态库为准，用户话术不代平台宣布写入结果。
    if (out.unavailable) {
      console.warn(JSON.stringify({
        event: 'change_intent_confirm_declined',
        intentId: rec.intentId,
        reason: `proposal_${out.unavailable}`,
      }));
      await ci.updateStatus(rec.intentId, 'expired', { output: out.output.slice(0, 2000), ...(out.error ? { error: out.error } : {}) });
      return { text: PROPOSAL_UNAVAILABLE_TEXT[out.unavailable], outcome: 'confirm_stale' };
    }
    // 已落账但读回不足（Phase 2 独立终态）：必须在普通失败分支之前分流——
    // 普通失败意味着一次写入都没发生，在这里是假话；报已完成更是假话。
    // 意图置 committed（平台侧已终结，防二次提交），任务结局置 failed
    // （人工核对未完成，任务不能算 done），用户文本是独立终态报告 + 核对入口。
    if (out.committedUnverified) {
      console.warn(JSON.stringify({ event: 'change_intent_commit_unverified', intentId: rec.intentId, taskIdCorrelate: rec.sessionId }));
      await ci.updateStatus(rec.intentId, 'committed', {
        output: out.output.slice(0, 2000),
        verified: false,
        ...(out.error ? { error: out.error } : {}),
      });
      await writeBackTaskOutcome(rec.taskId, 'failed');
      return { text: renderCommittedUnverifiedReply(out.readBack), outcome: 'confirm_committed_unverified' };
    }
    if (!out.ok) {
      console.error(JSON.stringify({ event: 'change_intent_commit_failed', intentId: rec.intentId, taskIdCorrelate: rec.sessionId }));
      await ci.updateStatus(rec.intentId, 'failed', {
        output: out.output.slice(0, 2000),
        verified: out.verified,
        ...(out.error ? { error: out.error } : {}),
      });
      await writeBackTaskOutcome(rec.taskId, 'failed');
      return { text: summaryText ? [summaryText, COMMIT_FAILED_LINE].join('\n') : COMMIT_FAILED_LINE, outcome: 'confirm_failed' };
    }
    await ci.updateStatus(rec.intentId, 'committed', { output: out.output.slice(0, 2000), verified: out.verified });
    await writeBackTaskOutcome(rec.taskId, 'done');
    // 用户可见文本 = 平台 summaryText 原样 + 宿主通用状态行。平台没给摘要时只发状态行
    // （平台自己说 ok/verified，宿主据实陈述确认码结局，不替它补一句摘要）。
    return { text: summaryText ? [summaryText, COMMIT_DONE_LINE].join('\n') : COMMIT_DONE_LINE, outcome: 'confirm_executed' };
  }

  async function prepareConfirmation(ctx: TrustedContext, message: string): Promise<PreparedContextTaskRun | null> {
    const match = message.match(CONFIRM_RE);
    const ci = options.changeIntents;
    if (!match || !ci || !options.proposalCommitRunner) return null;
    const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hashCode(match[1]!), new Date());
    if (!rec?.proposalId) return null;
    const taskId = rec.taskId ?? `task_${randomUUID()}`;
    return {
      taskId,
      request: '用户确认了待处理操作。',
      timeoutMs: DEFAULT_WORKER_TIMEOUT_MS,
      workspaceDir: `tmp/${taskId}`,
      snapshotWorkspace: async () => [],
      execute: async (execution) => {
        if (execution.signal?.aborted) throw new PlatformExecutionAbortedError();
        const reply = await confirmProposalViaGateway(rec, rec.proposalId!, {
          leaseHeld: true,
          ...(execution.signal ? { signal: execution.signal } : {}),
        });
        return { taskId, text: reply.text, hostConfirmationOutcome: reply.outcome };
      },
    };
  }

  async function prepareContextTask(
    args: ContextTaskRunArgs,
    ctx: ContextTaskExecutionContext,
  ): Promise<ContextTaskPreparationState> {
    if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
      throw toolUserErrorFor('TASK_REQUEST_EMPTY');
    }
    if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.trim() === '')) {
      throw toolUserErrorFor('TASK_ID_INVALID');
    }

    const profile = await resolveContextProfile(options.profiles, profileId);
    // continueTaskId 查不到就抛 ToolUserError——不猜、不兜底；准备阶段只读，不提前改 worker transcript。
    const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
    if (args.taskId && !existing) throw toolUserErrorFor('TASK_NOT_FOUND');
    if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
      throw toolUserErrorFor('TASK_FORBIDDEN');
    }

    const stepLabel = typeof args.stepLabel === 'string' ? args.stepLabel.trim() : '';
    const taskId = existing?.taskId ?? `task_${randomUUID()}`;
    const scratchDir = `tmp/${taskId}`;
    // 委派块走 user message：申报范围在宿主验证后冻结；worker 工作区路径守卫仍按自身 taskId 执行。
    const guardedScope = args.turnDeclaration
      ? stripForeignScratchPaths(args.turnDeclaration.request, scratchDir)
      : null;
    // 主拷贝同一把尺（D-114）：args.request 是这段文本的第二份拷贝（任务正文），只剥
    // 「范围：」行时 tmp/task_<uuid> 事故形状对主拷贝依然成立。本任务自己的工作区路径
    // 与 tmp/attachments/ 不匹配剥离模式，安全。
    const guardedRequest = stripForeignScratchPaths(args.request, scratchDir);
    const strippedCount = (guardedScope?.stripped ?? 0) + guardedRequest.stripped;
    if (strippedCount > 0) {
      console.warn(JSON.stringify({
        event: 'delegation_scope_foreign_path_stripped',
        requestId: ctx.trusted.requestId,
        taskId,
        strippedCount,
      }));
    }
    // C5：委派块按 DelegationBlock 结构化落地（entities/inputs 进载荷；数据源
    // entitySources + materializeInputs 已存在，不改 ContextTaskRunArgs 签名）。
    // 小裁示 2 偏离登记（W5 尾程）：推荐取 PlanEntitySources 四来源全量并集（①②③④），
    // 实现只取结构化字段 platformEntities + sessionEntities（④′ + ⑤），文本来源
    // currentMessage / quotedEvidence / referenceEvidence / platformResponses 全部排除。
    // 理由：文本来源含用户正文与平台响应全文，体积大且含噪声；结构化实体值已足够 worker
    // 做范围判定，且取值卫生与 session-entities 同一把尺。若后续需要补文本来源，在此扩展。
    const entities = [
      ...(args.entitySources?.platformEntities ?? []),
      ...(args.entitySources?.sessionEntities ?? []),
    ];
    let frozenInputs: FrozenTaskInput[] = [];
    if (args.turnDeclaration && guardedScope) {
      frozenInputs = await materializeTaskInputs({
        platformRoot: profile.root,
        workspaceDir: scratchDir,
        runId: taskId,
        files: ctx.trusted.inputFiles ?? [],
      });
    }
    const delegationBlock: DelegationBlock | null = args.turnDeclaration && guardedScope
      ? {
          request: guardedScope.text,
          entities,
          workspace: scratchDir,
          inputs: frozenInputs.map(f => f.path),
          protocolVersion: A2A_PROTOCOL_VERSION,
        }
      : null;
    const workerRequest = delegationBlock
      ? `${JSON.stringify(delegationBlock)}\n\n${guardedRequest.text}`
      : guardedRequest.text;
    const previousMessages = structuredClone((existing?.workerMessages ?? []) as DriverMessage[]);
    const messages = [
      ...previousMessages,
      { role: 'user', content: workerRequest, timestamp: Date.now() } as unknown as DriverMessage,
    ];
    // 续跑时宿主先读交接文件再环境核对：交接是任务层事实，不是会话层
    // 触发式召回。Main 按异常码分级恢复（接口文档 §11，码即判据）：
    // ok → 按交接续跑；missing → 只凭转录续跑；损坏族 → 丢弃文件内容、
    // 只凭转录重建（转录在场就继续，不推给人工）；损坏且转录也无 →
    // blocked（人工介入的唯一条件）。损坏的调用一律不合并、不做部分解析。
    const read = existing ? readHandoverFileWithCode(profile.root, taskId) : { code: 'handover_missing' as const, handover: null };
    const handover = read.handover;
    const handoverRecovery = resolveHandoverRecovery({ existing, read });
    if (existing && handover) {
      console.info(JSON.stringify({
        event: 'task_handover_resumed',
        taskId,
        planId: handover.planId,
        planVersion: handover.planVersion,
        executedCalls: handover.executedCalls.length,
        unfinishedSteps: handover.unfinishedSteps.length,
      }));
    } else if (existing && handoverRecovery.level === 'blocked') {
      console.info(JSON.stringify({ event: 'task_handover_corrupt', taskId, code: handoverRecovery.code }));
      console.info(JSON.stringify({ event: 'task_handover_blocked', taskId, code: handoverRecovery.code, missing: handoverRecovery.missing }));
    } else if (existing && handoverRecovery.code !== 'handover_ok') {
      if (handoverRecovery.code === 'handover_missing') {
        console.info(JSON.stringify({ event: 'task_handover_missing', taskId }));
      } else {
        console.info(JSON.stringify({ event: 'task_handover_corrupt', taskId, code: handoverRecovery.code }));
      }
      console.info(JSON.stringify({
        event: 'task_handover_recovered',
        taskId,
        code: handoverRecovery.code,
        level: handoverRecovery.level,
        discarded: handoverRecovery.discarded,
        transcriptMessages: handoverRecovery.transcriptMessages,
      }));
    }
    return { args, ctx, profile, existing, taskId, scratchDir, workerRequest, messages, stepLabel, handover, handoverRecovery };
  }

  const runner: InternalContextTaskRunner = {
    tool,
    // D-065：结果原文回写。get→合并→upsert（保留结构化字段，只补 resultText）；
    // 失败只记日志——事实回写是增强，不该让回合失败。
    recordTaskResult: async (taskId, facts) => {
      try {
        const existing = await options.tasks.get(taskId);
        if (!existing) return;
        const appended = [existing.resultText, facts.resultText.trim()].filter(Boolean).join('\n').slice(-RESULT_TEXT_MAX_CHARS);
        await options.tasks.upsert({ ...existing, ...(appended ? { resultText: appended } : {}), updatedAt: new Date().toISOString() });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'platform_task_result_record_failed', taskId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
      }
    },
    matchConfirmation: async (ctx, message): Promise<ConfirmationReply | null> => {
      const ci = options.changeIntents;
      if (!ci) return null;
      const now = new Date();

      const cancelM = message.match(CANCEL_RE);
      if (cancelM) {
        const hash = hashCode(cancelM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          await ci.updateStatus(rec.intentId, 'cancelled');
          return { text: `已作废：${intentLabel()}未执行。`, outcome: 'confirm_cancelled' };
        }
        const stale = await ci.findByCodeHash(ctx.principalId, ctx.sessionId, hash);
        if (!stale) return null;
        const why: Record<ChangeIntentRecord['status'], string> = {
          pending: '仍在等待确认',
          committed: '已完成录入',
          expired: '已过期',
          cancelled: '已作废',
          superseded: '已被更新的提案取代',
          failed: '执行失败',
        };
        return { text: `该确认码对应的提案${why[stale.status]}，无需取消。`, outcome: 'confirm_stale' };
      }

      const confirmM = message.match(CONFIRM_RE);
      if (confirmM) {
        const hash = hashCode(confirmM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          // 判别只有一个：条目带不带 proposalId（取物单）。带 → 平台提案落账后端；
          // 不带 → 迁移前的旧行业（宿主持有 payload 的时代已随 C 波结束），一律按过期
          // 处理——拿不到冻结载荷就 commit 等于盲写（W5 同一条判据）。
          if (!rec.proposalId) {
            console.warn(JSON.stringify({ event: 'change_intent_commit_declined', intentId: rec.intentId, reason: 'no_frozen_payload' }));
            await ci.updateStatus(rec.intentId, 'expired');
            return { text: PROPOSAL_UNAVAILABLE_TEXT.expired, outcome: 'confirm_stale' };
          }
          return confirmProposalViaGateway(rec, rec.proposalId);
        }
        // 码存在但已终结 → 确定性答复（散漫用法高频：拿到预览后被别的事打断）；
        // 码完全未知 → 走模型（普通对话里出现"确认 XX"字样不算数）。
        const stale = await ci.findByCodeHash(ctx.principalId, ctx.sessionId, hash);
        if (!stale) return null;
        const why: Record<ChangeIntentRecord['status'], string> = {
          pending: '仍在等待确认',
          committed: '已完成录入',
          expired: '已过期（超过有效期），请重新发起录入',
          cancelled: '已作废',
          superseded: '已被更新的提案取代，确认最新的提案即可',
          failed: '执行失败，请联系管理员核对后重新发起',
        };
        return { text: `该确认码对应的提案${why[stale.status]}。`, outcome: 'confirm_stale' };
      }
      return null;
    },
    prepareConfirmation: (ctx, message) => prepareConfirmation(ctx, message),
    prepare: async (args, ctx): Promise<PreparedContextTaskRun> => {
      const state = await prepareContextTask(args, ctx);
      return {
        taskId: state.taskId,
        get request() { return state.workerRequest; },
        timeoutMs: state.profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
        workspaceDir: state.scratchDir,
        materializeInputs: async (runId) => {
          const files = await materializeTaskInputs({
            platformRoot: state.profile.root,
            workspaceDir: state.scratchDir,
            runId,
            files: state.ctx.trusted.inputFiles ?? [],
          });
          if (files.length > 0) {
            state.workerRequest = requestWithFrozenInputs(state.workerRequest, files);
            const last = state.messages.at(-1);
            if (last) state.messages[state.messages.length - 1] = { ...last, content: state.workerRequest } as DriverMessage;
          }
          return files;
        },
        snapshotWorkspace: () => snapshotWorkspaceFiles(state.profile.root, state.scratchDir),
        execute: (execution) => runner.run(args, ctx, execution.signal, state, execution),
      };
    },
    run: async (args, ctx, signal, preparedState, execution): Promise<SubagentTaskResult> => {
      if (!preparedState) {
        const prepared = await runner.prepare!(args, ctx);
        let ticket;
        try {
          ticket = executionGate.enqueue({ requestId: ctx.trusted.requestId, ...(signal ? { signal } : {}) });
        } catch (error) {
          if (error instanceof PlatformExecutionQueueFullError) throw new ToolUserError('平台执行队列已满，请稍后重试。', { code: 'PLATFORM_QUEUE_FULL' });
          throw error;
        }
        let lease: PlatformExecutionLease;
        try {
          lease = await ticket.acquired;
        } catch (error) {
          if (signal?.aborted || error instanceof PlatformExecutionAbortedError) throw new ToolUserError(DELEGATION_CANCELLED, { code: 'DELEGATION_CANCELLED' });
          throw error;
        }
        if (signal?.aborted) {
          ticket.cancel();
          throw new ToolUserError(DELEGATION_CANCELLED, { code: 'DELEGATION_CANCELLED' });
        }
        lease.start();
        const startedAt = Date.now();
        try {
          return await prepared.execute({ lease, startedAt, deadline: startedAt + prepared.timeoutMs, ...(signal ? { signal } : {}) });
        } finally {
          lease.release();
        }
      }

      args = preparedState.args;
      ctx = preparedState.ctx;
      if (execution?.backgroundRunId) {
        ctx = { trusted: { ...ctx.trusted, backgroundRunId: execution.backgroundRunId } };
      }
      const { profile, existing, taskId, scratchDir, messages, stepLabel, handover, handoverRecovery } = preparedState;
      const runSignal = execution?.signal ?? signal;
      const delegationStart = execution?.startedAt ?? Date.now();
      const deadline = execution?.deadline ?? delegationStart + (profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      if (runSignal?.aborted) throw new ToolUserError(DELEGATION_CANCELLED, { code: 'DELEGATION_CANCELLED' });
      // T10 结果面作用域（声明与独立读共用同一份任务身份；stepLabel 让执行层能定位到
      // 计划步骤）。声明由执行层计划状态给出，不从 worker 文本推导。
      const resultScope: TaskResultScope = {
        taskId,
        request: args.request,
        ...(stepLabel ? { stepLabel } : {}),
      };
      // T10 段2：停滞监视器。只采宿主独立读的结果指标；只读步（计划未声称写）不采样
      // ——没有结果指标可看的步骤不参与假死判定，避免把合法的长查询误判成停滞。
      const stallMonitor = options.stagnation && options.taskResults
        ? startStallMonitor({
            observe: async () => {
              const declaration = await options.taskResults!.declare(resultScope);
              if (!declaration?.claimsWrite) return null;
              return options.taskResults!.observe(resultScope);
            },
            ...(options.stagnation.metric ? { metric: options.stagnation.metric } : {}),
            sampleIntervalMs: options.stagnation.sampleIntervalMs,
            unchangedForMs: options.stagnation.unchangedForMs,
            deadline,
            ...(runSignal ? { signal: runSignal } : {}),
            onStall: (verdict) => {
              // 留痕不是失败记账：熔断器数失败、假死不产生失败，两条路互不冒充。
              console.info(JSON.stringify({
                event: 'task_stalled',
                requestId: ctx.trusted.requestId,
                taskId,
                metric: verdict.metric,
                lastValue: verdict.lastValue,
                unchangedForMs: Math.round(verdict.unchangedForMs),
                samples: verdict.samples,
                ...(stepLabel ? { step: stepLabel } : {}),
              }));
            },
          })
        : null;
      // 人工介入的唯一入口：交接损坏且转录也无法重建。此时不调 worker、
      // 不写新交接、不发确认码、不重复提交，只把缺什么交还 Main（needs），
      // 由 Main 决定是人工核对后重发、还是放弃本任务。任务条目原样不动，
      // 以便人工核对时仍能看到旧转录与旧状态。
      if (handoverRecovery.blocked) {
        const needs: SubagentNeeds = {
          missing: handoverRecovery.missing,
          reason: `交接文件损坏（${handoverRecovery.code}）且转录无法重建，Main 无法确定本任务的已做部分与下一步。`,
          suggestion: '请人工核对本任务是否已有待确认提案、以及希望的下一步，再决定是重新发请求还是放弃本任务；核对前不要重复提交。',
        };
        return {
          taskId,
          text: `本轮已停止委派：交接文件损坏（${handoverRecovery.code}），转录也无法重建，无法确定已做部分与下一步。缺：${handoverRecovery.missing.join('、')}。未调用 worker、未发确认码、未重复提交，需人工核对后再决定。`,
          needs,
        };
      }
      const running: PlatformTaskRecord = {
        taskId,
        parentSessionId: ctx.trusted.sessionId,
        principalId: ctx.trusted.principalId,
        workerMessages: existing?.workerMessages ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // G3：委派时的实体来源快照写进既有任务条目（单写入者 = 委派点）。恢复调用
        // （args 带快照回注）覆盖为同一份；续跑调用不带 entitySources 时保留 existing。
        ...(args.entitySources
          ? { entitySources: structuredClone(args.entitySources) }
          : existing?.entitySources
            ? { entitySources: existing.entitySources }
            : {}),
        // RR1 精确身份：新委派写 requestKey；续跑/恢复不传 → 保留原任务身份。
        ...(args.requestKey ?? existing?.requestKey
          ? { requestKey: args.requestKey ?? existing?.requestKey }
          : {}),
      };
      await options.tasks.upsert(running);
      const onStep = execution?.background
        ? execution.onStep ?? (() => {})
        : execution?.onStep ?? ctx.trusted.onStep ?? (() => {});
      const trustedNotice = execution?.background
        ? execution.onNotice
        : execution?.onNotice ?? ctx.trusted.onNotice;
      const onNotice = trustedNotice
        ? stepLabel
          ? async (text: string) => { await trustedNotice(withStepLabel(text, stepLabel)); }
          : trustedNotice
        : undefined;
      let result: TurnDriverResult | undefined;
      let stallVerdict: StallVerdict | null = null;
      try {
        try {
          result = await options.workerDriver.run({
            // 纯静态系统提示词（变更项 ②）：只含协议义务与机械边界，逐任务的范围随委派块
            // 走 user message，网关命令形态经 planCommandForm 注入（无平台能力时不渲染许可段）。
            systemPrompt: workerSystemPrompt(profile.root, scratchDir, options.planCommandForm),
            tools: [],
            messages,
            cwd: profile.root,
            skillRoots: profile.skillRoots,
            ...(profile.gateway ? { gateway: profile.gateway } : {}),
            sessionId: taskId,
            requestId: ctx.trusted.requestId,
            onStep,
            exec: async () => { throw new ToolUserError('子 Agent 只能使用其工作目录内配置的原生工具。', { code: 'SERVE_WRITE_OUTSIDE_WORKSPACE' }); },
            deadline,
            signal: runSignal,
            ...(args.turnDeclaration ? { turnDeclaration: args.turnDeclaration } : {}),
            ...(args.entitySources ? { entitySources: args.entitySources } : {}),
            ...(profile.knowledgePaths ? { knowledgePaths: profile.knowledgePaths } : {}),
            ...(profile.sensitivePaths ? { sensitivePaths: profile.sensitivePaths } : {}),
            ...(onNotice ? { onNotice } : {}),
            // worker 工作区（⑨）：write/edit 门、提案 payload 边界与计划产物路径豁免共用。
            scratchDir,
            // 提案创建网关路径（C 波后唯一的提案路径，B 波那个"提案创建走不走网关"的开关
            // 已退役）：配了 changeIntents 就恒定注入，驱动于是恒定拦下 worker 的提案创建
            // 命令。宿主持有办调权：读文件、校验、落意图条目、发确认码全在服务端，worker
            // 只提供 payload 路径。
            //
            // （原先这里还有一道开关门与一行 delegation_gateway_state 结构化日志
            // ——"这一回合走哪条路"的取证，随开关退役一并删除：只有一条路之后，那条布尔
            // 恒真、不再回答任何问题。仍要问的"这一回合有没有走到提案步"由更强的事实面
            // 回答：拦截处必有 tool_calls 一行（tool = proposal_create，含拒绝原因），
            // 建成时有 proposal_created 事件 + delegation_span 的 proposal_created 结局。）
            ...(options.changeIntents ? {
              onCreateProposal: (call) => createProposalViaGateway(call, ctx, taskId, profile.root, profile.gateway),
            } : {}),
          });
        } finally {
          // 监视器必须在 worker 返回时收口（无论成功/抛错）：到截止或已流式推进的
          // 判定不许泄漏到下一个任务。stop 幂等，返回最终判定。
          if (stallMonitor) stallVerdict = await stallMonitor.stop();
        }
        // T10 段2：假死冻结。worker 照常跑完（不杀进程、不重跑），但它的自述不再作为
        // 本轮成功结果——已发生的工作痕迹留下，任务保持可续（needs），后续步骤由
        // runtime 冻结（planFrozen）。停滞后不进入下面的成功分支。
        if (stallVerdict?.stalled) {
          await options.tasks.upsert({
            ...withExecutionFacts(running, result ?? { text: '', messages: [] }, 'needs'),
            ...(result?.messages?.length ? { workerMessages: result.messages as unknown[] } : {}),
            updatedAt: new Date().toISOString(),
          });
          console.info(JSON.stringify({
            event: 'delegation_span',
            requestId: ctx.trusted.requestId,
            taskId,
            durationMs: Date.now() - delegationStart,
            outcome: 'stalled',
            metric: stallVerdict.metric,
            lastValue: stallVerdict.lastValue,
            unchangedForMs: Math.round(stallVerdict.unchangedForMs),
            ...(result ? usageFieldsOf(result.messages) : {}),
          }));
          const stalledError = new ToolUserError(renderStalledReply(stallVerdict), { code: 'TASK_STALLED' });
          Object.assign(stalledError, { taskStalled: true });
          throw stalledError;
        }
        // worker 侧真实 token 消耗（纯加法遥测）：对 worker 转录里 assistant 消息的
        // provider Usage 分项求和（口径见 driver.ts 的 sumUsage），挂到下方每个
        // delegation_span 结局与 SubagentTaskResult 透传。网关不回传 usage 时埋点字段
        // 缺席（不是全零）——两类事实必须可区分，且缺失绝不报错。
        const workerTokens = sumUsage(result.messages);
        const workerUsage = workerTokens ? usageSpanFields(workerTokens) : {};
        // 空文本检查（错误态快路径 v2 改豁免判据，2026-10-16）：needs / clarification /
        // terminalFailure 本来就是空 text 合法的形状——结构化收尾的话术由宿主渲染出口
        // 组装，不由 worker 文本承担。第一版（2026-10-17 凌晨回退）死因正是这里：驱动
        // 早停后 result.text 是空串，本检查跑在下面所有分支**之前**，空 text 直接抛出、
        // 进 catch、被分类 executor_error，用户拿到兜底话术——宿主侧的终局门根本没机会
        // 执行。豁免只对带结构化收尾的结果生效：纯空 text 照旧失败关闭，基线一字不动。
        if (!result.text.trim() && !result.terminalFailure && !result.clarification && !result.needs) {
          throw new Error(signal?.aborted ? '子任务已取消。' : '子 Agent 未返回可用结果。');
        }
        // 终局分支（背带，紧跟空文本检查的原位置——第一版的宿主侧门就在这里，但当时
        // 空文本检查先行抛出，它从未执行过）：平台确定性终局码以"整份答案"收尾时，
        // 宿主用模板话术终结本轮（ToolUserError 语义 = 这段文本成为本轮回复，出口校验
        // 由 runtime 的委派 catch 放行）。"整份答案"的判定**单一事实源在驱动侧**（它
        // 看得见本跳全部 toolResults）：挂了 terminalFailure 就是整份答案，宿主不再用
        // planFacts.calls.length 复推——第一版那道门与真实驱动的字段装配时序错位正是
        // 隐患之一。宿主只保留 !stepLabel 守卫：多步计划的一步不终结整轮，照旧交还链
        // （terminalFailure 原样挂在结果上，话术由皮带保证非空，随交还材料走）。
        if (result.terminalFailure && !stepLabel) {
          await options.tasks.upsert({
            ...withExecutionFacts(running, result, 'done'),
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          writeTurnHandover(profile.root, taskId, result, handover, 'terminal');
          console.info(JSON.stringify({
            event: 'delegation_span',
            requestId: ctx.trusted.requestId,
            taskId,
            durationMs: Date.now() - delegationStart,
            outcome: 'terminal_fast_path',
            code: result.terminalFailure.code,
            ...workerUsage,
          }));
          throw new ToolUserError(renderTerminalFailureReply(result.terminalFailure), { code: result.terminalFailure.code });
        }
        if (result.pendingPlan) {
          const pendingPlan: PendingPlanConfirmation = {
            ...result.pendingPlan,
            taskId,
            principalId: ctx.trusted.principalId,
            sessionId: ctx.trusted.sessionId,
            requestId: ctx.trusted.requestId,
          };
          await options.tasks.upsert({
            ...running,
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          if (!ctx.trusted.onPlanPending) throw toolUserErrorFor('PLAN_PENDING_PERSIST_MISSING');
          await ctx.trusted.onPlanPending({
            planId: pendingPlan.planId,
            version: pendingPlan.version,
            taskId,
            principalId: ctx.trusted.principalId,
            sessionId: ctx.trusted.sessionId,
            requestId: ctx.trusted.requestId,
            userText: result.pendingPlan.userText,
          });
          writeTurnHandover(profile.root, taskId, result, handover, 'pending_plan');
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'plan_confirmation_pending', ...workerUsage }));
          return { taskId, text: result.text, pendingPlan, ...(result.execution ? { execution: result.execution } : {}), ...(workerTokens ? { usage: workerTokens } : {}) };
        }
        // 纠错环（架构 §3）：worker 执行不了，回报"缺什么/为什么/建议用户提供什么"。
        // 任务保持可续（taskId 已知会宿主侧，用户补充后经 continueTaskId 重派），
        // 线索原样上交，由 Main Agent 决定自己补齐还是转告用户。这一轮零执行，
        // 因此没有执行面注脚可拼（注脚只描述真实发生过的网关调用）。
        if (result.needs) {
          await options.tasks.upsert({
            ...withExecutionFacts(running, result, 'needs'),
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          writeTurnHandover(profile.root, taskId, result, handover, 'needs_input');
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'needs_input', ...workerUsage }));
          return { taskId, text: result.text, needs: result.needs, ...(workerTokens ? { usage: workerTokens } : {}) };
        }
        // 提案已登记（网关路径，B 波 B3）：宿主持有的确定性文本（平台 summaryText + 确认行）
        // 原样上交，任务条目照常落（这一轮的转录与执行事实要能续跑）。必须**先于**下面的
        // 文本路径判定：新路径下 worker 终稿里不该再有提案 JSON，若仍有（影子期旧形态），
        // 那是要留痕的不一致，不是要执行的提案。
        if (result.proposalCreated) {
          await options.tasks.upsert({
            ...withExecutionFacts(running, result, 'done'),
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          writeTurnHandover(profile.root, taskId, result, handover, 'proposal_created');
          console.info(JSON.stringify({
            event: 'delegation_span',
            requestId: ctx.trusted.requestId,
            taskId,
            durationMs: Date.now() - delegationStart,
            outcome: 'proposal_created',
            proposalGateway: true,
            ...workerUsage,
          }));
          return {
            taskId,
            text: result.text,
            proposalCreated: result.proposalCreated,
            ...(result.execution ? { execution: result.execution } : {}),
            ...(workerTokens ? { usage: workerTokens } : {}),
          };
        }
        // T10 段1：结果对账——声明 N（执行层计划状态）vs 宿主独立读回的实际数
        // （执行层状态）。这不是请求校验：门已经验过请求，这里验结果。只读步与没有
        // 声明的步骤不参与；声称写的步骤读不出指标按计划形状缺陷处置（fail-closed，
        // 绝不用 worker 文本凑一个"完成"）。
        if (options.taskResults) {
          let declaration: ResultContractDeclaration | null = null;
          let observations: readonly ResultObservation[] | null = null;
          let probeFailed = false;
          try {
            declaration = await options.taskResults.declare(resultScope);
            if (declaration?.claimsWrite) observations = await options.taskResults.observe(resultScope);
          } catch (error) {
            probeFailed = true;
            console.warn(JSON.stringify({
              event: 'result_contract_probe_failed',
              requestId: ctx.trusted.requestId,
              taskId,
              errorType: error instanceof Error ? error.name : 'UnknownError',
              error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
            }));
          }
          const reconciliation: ResultContractReconciliation = probeFailed
            ? { verdict: 'inconclusive', reason: 'probe_unavailable', claimsWrite: true, declarations: [], observations: [], shortfalls: [], unreadable: [] }
            : reconcileResultContract({ declaration, observations });
          if (reconciliation.verdict !== 'verified') {
            await options.tasks.upsert({
              ...withExecutionFacts(running, result, 'failed'),
              workerMessages: result.messages as unknown[],
              updatedAt: new Date().toISOString(),
            });
            console.info(JSON.stringify({
              event: 'result_contract_shortfall',
              requestId: ctx.trusted.requestId,
              taskId,
              verdict: reconciliation.verdict,
              reason: reconciliation.reason,
              claimsWrite: reconciliation.claimsWrite,
              declarations: reconciliation.declarations,
              observations: reconciliation.observations,
              shortfalls: reconciliation.shortfalls,
              ...(reconciliation.unreadable.length > 0 ? { unreadable: reconciliation.unreadable } : {}),
              ...(stepLabel ? { step: stepLabel } : {}),
            }));
            console.info(JSON.stringify({
              event: 'delegation_span',
              requestId: ctx.trusted.requestId,
              taskId,
              durationMs: Date.now() - delegationStart,
              outcome: 'result_shortfall',
              verdict: reconciliation.verdict,
              ...workerUsage,
            }));
            throw new ToolUserError(renderResultContractReply(reconciliation), { code: 'RESULT_CONTRACT_UNVERIFIED' });
          }
        }
        const final: SubagentTaskResult = {
          taskId,
          ...(result.execution ? { execution: result.execution } : {}),
          // 平台登录/凭据类失败事实：原样上交结构化事实；宿主不在编排层做冷却/退避记账
          // （并发容忍与健康退避归执行层），话术仍经既有失败链路如实上行。
          // 与 execution 不互斥（失败的那次调用真发生过），所以两条并列挂载。
          ...(result.authFailure ? { authFailure: result.authFailure } : {}),
          // 收尾兜底（P1）：批准了但零执行，原样上交——宿主需要这个事实才能说对状态
          ...(result.activatedPlan ? { activatedPlan: result.activatedPlan } : {}),
          // 结构化歧义/未找到：平台请用户"选一个"的澄清事实，原样上交——宿主据此机械
          // 组装澄清问题（与 needs 同一族的结构化上交，模型不参与翻译）。
          ...(result.clarification ? { clarification: result.clarification } : {}),
          // 错误态快路径的终局事实：只会在 stepLabel 场景走到这里（单步在上方终局分支
          // 已抛出终结）——多步计划的一步不终结整轮，事实与话术随交还链走。
          ...(result.terminalFailure ? { terminalFailure: result.terminalFailure } : {}),
          // 执行面回执：主 Agent 的重量反馈（系统元数据，提示词约定不转述给用户）。
          // 拼在提案分支之后：提案回合的文本是平台 summaryText + 通用确认行，注脚只属于
          // 普通结果（提案那一条路在 proposalCreated 分支就返回了，到不了这里）。
          text: result.footprint ? `${result.text}\n\n〔本轮执行面：${result.footprint}〕` : result.text,
          // worker token 分项透传（纯加法遥测，供 stepLabel 场景与测试断言；口径见上）。
          ...(workerTokens ? { usage: workerTokens } : {}),
        };
        await options.tasks.upsert({
          ...withExecutionFacts(running, result, result.execution ? 'done' : 'failed'),
          workerMessages: result.messages as unknown[],
          updatedAt: new Date().toISOString(),
        });
        writeTurnHandover(profile.root, taskId, result, handover, 'ok');
        console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'ok', ...workerUsage }));
        return final;
      } catch (error) {
        // 已经是面向用户的安全话术（ToolUserError 语义 = 这段文本成为本轮回复）时
        // 原样抛出：配置故障（如 onPlanPending 缺失）有自己精确的话术，再套一层
        // "执行失败请稍后再试"就是把部署漏配伪装成平台抖动——用户重试多少次都不会好
        // （③-3：宿主不猜但也没对齐用户的那类去向）。
        if (error instanceof ToolUserError) throw error;
        // 失败分类的判定顺序即优先级：取消（用户/上层主动中止）先于超时（时间到了），
        // 再看登录态。同一时刻可能多个条件成立，取最贴近用户动作的那个。
        // 登录态判定以**码**为准（isPlatformAuthError：信封/挂码/码前缀，见
        // platform-contract.ts 的 auth 码集合）。下面那条中文正则是**过渡**：平台
        // auth.js 的自动重登录失败消息（"平台登录已过期，自动登录失败——…"）是既有
        // 唯一不带码前缀的形态，平台侧尚未给它挂码；在平台收口之前先留正则兜底，
        // 否则那一条会退化成 executor_error——而"请稍后再试"对 auth 是错指令。
        // 平台侧该消息一带码（走 messageFor），这行即可删除。
        // 取消判据读 runSignal（本次执行实际持有的信号；形参 signal 在 prepared 路径下
        // 与之同值，但两者一旦分叉，分类与最终话术必须跟实际执行的那一个走）。
        // model_transient（波次C，2026-11-01）排在取消/超时之后、auth 之前：判据是驱动
        // 透传的 result.modelError（模型侧瞬时失败，重试用尽或不可重试）——它只在驱动
        // 正常返回时在场，届时 catch 里的 error 只能是下方空文本检查抛的那句普通 Error，
        // 与 auth 码族无交集；而取消/超时是宿主自己的收尾事实，永远先于模型侧表征。
        const failureClass = classifyDelegationFailure({
          aborted: runSignal?.aborted ?? false,
          deadlinePassed: Date.now() >= deadline,
          modelError: result?.modelError,
          isPlatformAuthError,
          error,
        });
        const classified = failureClassFor(failureClass);
        console.info(JSON.stringify({
          event: 'delegation_span',
          requestId: ctx.trusted.requestId,
          taskId,
          durationMs: Date.now() - delegationStart,
          outcome: 'failed',
          failureClass,
          protocolClass: classified.protocolClass,
          // 失败前已产生的部分转录同样计入（超时/取消前 worker 真实消耗过的 token）；
          // result 缺席（驱动没返回过）时字段缺席。
          ...(result ? usageFieldsOf(result.messages) : {}),
        }));
        console.error(JSON.stringify({
          event: 'subagent_task_failed',
          taskId,
          failureClass,
          protocolClass: classified.protocolClass,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          // 失败原因原文截断 160 字符（波次C；先例：platform_task_outcome_writeback_failed
          // 带 message）——errorType 只有 Error 这类名字时，原因一个字都不该再丢。
          error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
        }));
        // 超时/失败也持久化本轮已产生的中间转录：taskId 续跑从断点继续，
        // 而不是从零重付全部时间与浏览器占用（长任务业务稳定性的关键）。
        await options.tasks.upsert({
          ...withExecutionFacts(running, result ?? { text: '', messages: [] }, 'failed'),
          ...(result?.messages?.length ? { workerMessages: result.messages as unknown[] } : {}),
          updatedAt: new Date().toISOString(),
        });
        // 【C4 登记，刻意不实现（波次C，2026-11-01）】model_transient 失败后任务条目落
        // outcome='failed'，确认 lease 已消费——用户裸回「确认继续」会撞 TASK_NOT_FOUND
        // （其 correctForm 已指路重发，不误导）。后续可选项：给这类"宿主已自动重试用尽"
        // 的失败保留一个「待重试」终态（或确认条目侧的续用通道），让「继续」能原地重派
        // 而不必重发全文；本波不扩确认状态机，先把失败分类与观测修准。
        const delivery = deliverFailure({
          classification: classified,
          platformTasks: options.tasks,
          principalId: ctx.trusted.principalId,
          sessionId: ctx.trusted.sessionId,
          continueTaskId: taskId,
          requestId: ctx.trusted.requestId,
          doneSteps: [],
        });
        const failureError = new ToolUserError(delivery.userMessage);
        if (delivery.auditFields.code) Object.assign(failureError, { code: delivery.auditFields.code });
        throw failureError;
      }
    },
  };
  return runner;
}

/**
 * 给计划门通知加步骤前缀（计划模式）。固定标记保持在最前——渠道适配器与测试替身
 * 都按它识别"这是一条计划通知"；步骤标签紧跟其后，用户先看到"第几步"再看范围。
 */
export function withStepLabel(text: string, stepLabel: string): string {
  const tag = `【${stepLabel}】`;
  if (!stepLabel) return text;
  if (!text.startsWith(PLAN_NOTICE_PREFIX)) return `${tag}${text}`;
  return `${PLAN_NOTICE_PREFIX}${tag}${text.slice(PLAN_NOTICE_PREFIX.length)}`;
}

async function resolveContextProfile(profiles: Record<string, ContextProfileConfig>, id: string | undefined): Promise<ResolvedContextProfile> {
  // 消费方 fail-closed（C5）：0 个或多个 profile 且未显式指定 profileId → 拒绝执行，
  // 不静默挑 profile、不回退任何实例名（文案中性，指引部署补配置或显式指定）。
  if (id === undefined) throw new ToolUserError('未指定执行层 profile：contextProfiles 为空或有多个时，必须显式指定 profileId。', { code: 'CONTEXT_PROFILE_MISSING' });
  const configured = profiles[id];
  if (!configured) throw new ToolUserError(`未配置执行层上下文 profile:${id}`, { code: 'CONTEXT_PROFILE_NOT_CONFIGURED' });
  const root = await fs.realpath(configured.root).catch(() => { throw new ToolUserError(`执行层上下文目录不可用:${id}`, { code: 'CONTEXT_PROFILE_ROOT_UNAVAILABLE' }); });
  const skillRoots: string[] = [];
  for (const relative of configured.skillRoots) {
    if (path.isAbsolute(relative)) throw new ToolUserError('skillRoots 必须是相对 root 的路径。', { code: 'CONTEXT_SKILL_ROOTS_NOT_RELATIVE' });
    const resolved = await fs.realpath(path.join(root, relative)).catch(() => undefined);
    if (!resolved || !isInside(root, resolved)) throw new ToolUserError('skillRoots 未通过路径安全校验。', { code: 'CONTEXT_SKILL_ROOTS_PATH_SAFETY' });
    skillRoots.push(resolved);
  }
  return {
    root,
    skillRoots,
    workerTimeoutMs: configured.workerTimeoutMs,
    ...(configured.knowledgePaths ? { knowledgePaths: configured.knowledgePaths } : {}),
    ...(configured.sensitivePaths ? { sensitivePaths: configured.sensitivePaths } : {}),
    ...(configured.gateway ? { gateway: configured.gateway } : {}),
  };
}

interface ResolvedContextProfile {
  root: string;
  skillRoots: string[];
  workerTimeoutMs?: number;
  knowledgePaths?: string[];
  sensitivePaths?: string[];
  gateway?: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * worker 系统提示词——**纯静态**（A2A 协议生命周期第①阶段的设计约束，变更项 ②）：
 * 只含身份、判断类原则、机械边界与输出纪律，以及不随任务变化的静态协议义务。
 * 逐任务的范围不进提示词——它随委派块走 user message（见 run() 的 workerRequest）；
 * 网关命令形态不硬编码——经 planCommandForm 参数由调用方（assembly，从平台适配层取值）
 * 注入，无平台能力时许可段整段不渲染。
 *
 * 组织律法：**判断类**规则（怎么想）与**机械类**规则（边界在哪）分开放，输出类规则
 * （说什么形状的话）单独收口。每条防一类已发生的事故，注释只记事故不记叙事：
 *   · 优先复用     —— 治”自己写渲染器/自己洗数据”：平台有确定性子过程而 worker 重造，
 *                    重造那份与平台口径漂移，产出于是不可复核。
 *   · 交付前自检   —— 治”不过校验直接交付”：域提供的校验入口被跳过，错数据直达用户。
 *   · 范围         —— 治”自作主张扩大产出”：用户只要一件事，worker 顺手多做一件没人要的。
 *   · 拿不到就说缺 —— 治”换口径试探/猜参数/拿缓存值当真值”：一次查不到就换个写法蒙。
 *   · 经济性       —— 治”越挫越试”与”为次要产出阻塞主产出”（四轮实测：同一拒绝理由
 *                    连撞五次，预算烧光超时，主产出没回到用户手上）。
 *   · 内部语言不上屏 —— 治 Stage 3 事故：结构化歧义被写成技术报告，脚本路径/错误码/
 *                    门的规则引述全上屏。宿主已改为替 worker 组装结构化状态，这里只
 *                    钉”数据答案”的语域。
 *   · 委派块范围   —— 治”从会话历史补范围”：逐任务边界只随载荷走（A2A 协议 §①），
 *                    静态规则钉住”只认委派块”，防漂移不靠每回合往提示词里塞申报原文
 *                    （原 declarationNotice 已由这条静态规则承担）。
 * 律法 L2：协议事实平台拥有，宿主读数据（operation list --json）不抄写——所以这里
 * **不手抄**网关调用形状与 flag 纪律，只给”以平台清单为准”这一指针；命令形态经参数
 * 注入，是迁移期适配边界向通用层的唯一渗入点。
 *
 * 导出 = 纯测试缝（docs-reality.test.ts 渲染级机械锁直接调用本函数，锁「静态文本零
 * 执行层名」），零行为变化；内部调用点不变（context.ts 委派 runner 装配处）。
 */
export function workerSystemPrompt(
  root: string,
  scratchDir?: string,
  planCommandForm?: string,
): string {
  // 可写位置（机械边界，不是约定）＝委派块声明的工作区（⑨：按任务切，路径只随委派块
  // 下行，提示词保持纯静态——逐任务的路径进提示词会让跨任务缓存前缀在这里炸断）。
  // 同一条里带上 edit（2026-10-08 实测）：worker 写了 11KB 脚本崩在 KeyError，只想改
  // 一行却没有 edit 工具，bash 门又只准网关调用（用不了 sed），只能整份重写——33 秒
  // 模型生成，而写 11KB 不可能一次对，这类迭代必然反复。放在同一段而不新起一条：
  // 它是”怎么写”的细则，不是另一条边界（边界仍然只有工作区这一处）。
  const scratchNotice = scratchDir
    ? `写边界：文件只能写进委派块声明的工作区，其他路径不可写（机械边界）。**改自己写的脚本用 edit（精确文本替换，不要整份重写）**——重写一份 11KB 脚本要 30+ 秒生成，改一行只要一次替换。`
    : '';
  // 读不到上游内容时自写解析代码（D-083，用户明确批准）：read 只放行文本知识面，二进制
  // 附件读不进来；这一条把”自己写脚本”限定在上游吸收，并钉住路径必须落在本任务工作区内
  // （平台只放行 tmp/ 下的脚本），且子进程 env 被剥掉凭据类变量（不是沙箱：脚本仍能读盘，
  // 故不要读写与任务无关的文件）。刻意不提具体文件格式名——格式域不该进通用提示词。
  const absorbNotice = scratchDir
    ? `读不到上游内容时（如附件是二进制），可自写解析脚本放进委派块声明的工作区，经统一入口本地执行；脚本只落在这里，不读写无关文件。`
    : '';
  // 静态协议义务·许可与裁决（取代原 planNotice，变更项 ②）：是否需要许可以能力清单声明
  // 为准；命令形态经 planCommandForm 注入（通用层不出现网关名），无平台能力时整段不渲染。
  // 状态字是宿主协议的一部分（与驱动侧 PLAN ACTIVE / DECLINED / NEEDS_USER_CONFIRM /
  // PAUSED / STOP 前缀一一对应），逐条钉住回合义务。
  const permitNotice = planCommandForm
    ? [
      `许可：平台操作是否需要许可，以能力清单声明为准。标了需许可的 operation，执行前先提交申请——申请是单行原始命令：${planCommandForm}，calls 逐项列出 operation 与参数——获准后才能执行该操作；清单未标注的 operation 直接调用。`,
      '裁决义务：申请收到 NEEDS_USER_CONFIRM 或 PAUSED → 立即结束回合等宿主；DECLINED → 按原因修正后重提；STOP → 停止并说明原因；ACTIVE → 按单执行；范围变化时重提完整 calls。',
    ].join('\n')
    : '';
  // 静态协议义务·范围与能力（变更项 ②）：原 declarationNotice 的防漂移语义收进这两条
  // 静态规则——逐任务的范围声明随委派块走 user message，提示词只钉”只认委派块”。
  const scopeNotice = '范围义务：只执行用户消息中【委派】块声明的范围，不得扩大或从会话历史补范围。';
  const capabilityDuty = '能力义务：只承诺清单声明可用的操作；清单标记不可用的，如实向用户说明。';
  // 知识面（门禁）：只经 read 读固定知识面，”技能指向的程序文档”让 SOP 类文档合法可读
  // （此前被排除在知识面外，worker 于是从不读 SOP）。实现源码不可读——读源码会把它
  // 的中间状态当成协议事实，而那正是平台拥有、宿主与 worker 都不该镜像的那一半真相。
  const knowledgeNotice = '知识只经 read 工具读固定知识面（挂载技能、域文档、*.schema.json 及技能指向的程序文档）；实现源码不可读；先读知识面再调用平台能力，数据必须来自平台返回，不得编造。';

  return [
    '## 身份与职责',
    [
      '你是平台任务执行 Agent，在受信工作目录内完成一项具体任务。最终回复面向用户；你对两件事负责：结果正确，和不越界。',
      `工作目录：${root}`,
    ].join('\n'),
    '## 工作原则',
    [
      // ① 优先复用：平台已提供的确定性子过程（校验、渲染、格式转换）必须调用——治”自己
      //    写渲染器/自己洗数据”，重造那份与平台口径漂移，产出不可复核。自写代码只用于
      //    上游吸收：格式不稳定、需要判断的那一步（D-083 的解析脚本即此形态）。
      '1. 优先复用：平台已提供的确定性子过程（校验、渲染、格式转换）必须调用，不要自己实现；自写代码只用于上游吸收——格式不稳定、要判断的那一步。',
      // ② 交付前自检：该域提供校验入口就必须过一遍——治”不过校验直接交付”，错数据直达用户。
      '2. 交付前自检：该域提供校验入口的必须过一遍再交付；不过就停下报告，不改不跳过。',
      // ③ 范围：只做被要求的事——治”自作主张扩大产出”（用户只要一件事，顺手多做一件）。
      '3. 范围：只做被要求的事；发现范围外的产出或前置动作，报告，不要自作主张。',
      // ④ 拿不到就说缺什么：只做平台文档声明的操作——治”换口径试探、猜参数、拿缓存值
      //    当真值”（一次查不到就换个写法蒙，蒙出来的数无法复核）。
      '4. 拿不到就说缺什么：只做平台文档声明的操作；不换口径试探，不猜参数，不用缓存值代替真实查询。',
      // ⑤ 经济性：治四轮实测的两种失效形态——“越挫越试”（同一拒绝理由连撞五次，换姿势
      //    不算新尝试，预算烧光超时且主产出没回到用户手上）与”为次要产出阻塞主产出”。
      '5. 经济性：一次调用能拿到的不要写脚本绕；同一障碍最多撞两次——同类错误第二次出现时就停止重试（换写法、换路径、换参数形态再试不算新尝试），先交付已经确定的部分，不要为次要产出阻塞主产出。',
    ].join('\n'),
    '## 硬边界',
    [
      // 平台调用形状以清单为准（律法 L2）：这里刻意不手抄网关形状与 flag 纪律——手抄那份
      // 随平台演进过期，而模型会照着手抄那份去撞门。也不限定某一种模式：产出该走哪条
      // 路由由清单说明，worker 自己读。
      '平台调用走统一入口；形状与可用模式以平台清单（operation list --json）为准，不手抄。',
      knowledgeNotice,
      ...(permitNotice ? [permitNotice] : []),
      scopeNotice,
      capabilityDuty,
    ].join('\n'),
    // 任务工作区与自写解析（⑨：语义从”可写位置”改为”任务工作区/文件交互区”；仍是无标题
    // 块——语义上是硬边界的延伸，且落点在稳定段之后、输出纪律之前，缓存断点尽量靠后。
    // scratchDir 按任务派生，跨回合续跑同任务时不再变化，此处不再是每请求缓存断点）。
    ...(scratchNotice
      ? [[scratchNotice, ...(absorbNotice ? [absorbNotice] : [])].join('\n')]
      : []),
    '## 输出纪律',
    [
      // 回复面向用户 + 内部语言不上屏（Stage 3 事故根治包）：worker 的工作上下文全泡在
      // 执行语言里（协议命令 / 技能文档 / 信封错误码），它是执行语言与用户语言之间唯一
      // 的翻译器——压力下翻译退化，执行语言就越界进最终回复。宿主已改为替它组装结构化
      // 平台状态，这里只钉”数据答案”的发声形状。
      '回复面向用户：只说结论、数据和需要用户给什么。',
      '内部语言不上屏：脚本路径、错误码、JSON、协议状态、接口名、门的规则不进回复。',
      // 来源标注纪律（2026-09-27 第三波）：用户不需要知道接口标识符，”平台实时查询”已足够
      // 证明数据不是编的；写出 operation 名/接口名/脚本名只会把内部语言带上屏。
      '来源标注只说“平台实时查询”这类中性表述，不出现 operation 名、接口名或脚本名。',
      // 内部控制不上屏（同波）：计划额度、拒绝次数、熔断、计划门、重试上限是宿主/平台的
      // 内部控制状态，对用户”下一步做什么”没有任何帮助——实测里它被当成”说明”交出去，
      // 反而像在推卸。因内部限制停顿时只说事实与出路，不说机制。
      '内部控制不上屏：计划额度、拒绝次数、熔断、计划门、重试上限等内部控制状态；因内部限制停顿时只说事实与出路，不说机制。',
      // 不主动交代表能力边界（同波）：诚实不等于全说。用户没问到的口径，接口不支持就不是
      // 他需要知道的事——主动交代整段边界说明只是噪音；问到该口径时才如实说明。
      '不主动交代表能力边界：只回答用户问到的；边界仅在该口径被问到时才说明。',
      // 口径以平台声明为准（2026-11-10 Y2 实测）：平台没有该口径，模型把平台返回的几条
      // 数据加总后套上一个平台未声明的名称答出去——编排层越权发明执行层业务口径。三件事
      // 一起钉：不自造口径、缺口径先说明平台不提供再说什么能提供、确需计算必须标注推算
      // 并给出所依据的平台数据。措辞保持领域无关（零业务词守卫见 context.test.ts）。
      '口径以平台声明为准：平台未声明的口径，不得用平台数据自行定义后作答；用户问到的口径平台没有时，先说平台不提供该口径，再说明平台实际提供什么；确需计算时明确标注这是推算值并给出所依据的平台数据。',
      // 名称类请求仍须先经平台检索确认（D-072）：真实平台实测里用户给出需要解析的名称，
      // 模型未搜索也未澄清，直接用会话里已确立的实体出数——连续性修复让模型宁可信任
      // 上下文也不重新解析。会话实体只回答”用户只给参数的续问”，新名称一律重新检索。
      // 2026-10-17 补豁免边界（性能）：同一会话内**已检索确认过的同一名称**、同口径续查
      // （B1 形状）可直接复用规范名提交单调用计划——重复检索是纯冗余（实体门第四来源
      // 仍放行已确立实体），且 2 调用计划会错过终局快路径、坠入模型翻译慢路。新名称或
      // 名称有变不豁免，D-072 的保护原样保留。
      '名称类请求仍须先经平台检索确认规范名称——新名称即使用户本会话已用过某个对象也不例外；但同一会话内已检索确认过的同一名称，同口径续查可直接复用已确认的规范名，不再重复检索。',
      // 已取数据必须呈现（D-073）：实测”我们的客户有哪些”——模型花 295s/8 调用，本轮已查到
      // 的维度数据不出现在终稿里，反请用户补充范围重查：数据在手，球踢回给用户。
      // 2026-11-10 Y2 补边界：原句没有区分"为回答所问而取"与"探索试探"——查无此名的
      // 轮次里为找替代名称顺手取到的其他对象真实值被当成"补救"抖给用户。只有前者必须
      // 呈现；探索数据不必呈现，用户没问的不主动抖出。
      '本轮为回答用户所问而取到的执行结果必须呈现；为探索试探而取的数据不必呈现，用户没问的不主动抖出；确未取到的，明示缺席原因。',
      // 纠错环：执行不了时报”缺什么/为什么/建议用户提供什么”，与总结原则同一份表述。
      '缺信息或执行不了时，用自然语言说明缺什么、为什么、建议提供什么。',
      // 被阻塞时的报告形状（A2A §⑥ 报告义务；run5 实测：终稿曾以”流程验证通过 ✅”开头，
      // 把样本冒烟当成交付叙事）。未完成先声明，验证性成功不作报告开头。
      '被阻塞或未完成时，回复第一句陈述”未完成”与原因；管线自检、样本运行等验证性成功不得作为报告开头。',
      // 样本产物命名隔离（run5 实测：样本数据曾以真实交付物命名留在工作区，构成污染面）。
      '样本或冒烟数据落盘时，文件名加「样本-」前缀或统一收纳在 smoke/ 之下，不得使用真实交付物命名。',
    ].join('\n'),
  ].join('\n\n');
}
