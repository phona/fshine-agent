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
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import type { PendingPlanConfirmation } from './plan-runtime';
import type { PlanCliRunner } from './plan-runtime';
import { PLAN_NOTICE_PREFIX } from './plan-runtime';
import type { PlanEntitySources, TurnDeclaration } from './turn-contract';
import { ToolUserError, sumUsage, usageFieldsOf, usageSpanFields, type ProposalCreationOutcome, type SubagentNeeds, type TurnDriverResult, type UsageTotals } from './driver';
import { messageTextFor, planDraftExample, toolUserErrorFor } from './error-codes';
import { isPlatformAuthError, type PlatformAuthFailure, type PlatformEnvelope, type SelectionClarification, type TerminalFastPathFailure } from './platform-contract';
import { gatewayExecPath, parseEnvelope } from './platform-contract';
import { renderTerminalFailureReply } from './turn-relay';
import type { ProposalCreateCall } from './proposal-runtime';
import type {
  ChangeIntentRecord,
  ChangeIntentRepo,
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  TrustedContext,
} from '@fshine/contracts';
import { DEFAULT_WORKER_TIMEOUT_MS } from '@fshine/contracts';

export const RUN_17DZ_TASK_TOOL = 'run_17dz_task';

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

export const RUN_17DZ_TASK_DESCRIPTION = [
  '当用户的问题需要访问或处理 幻账平台中的真实财税数据时，将任务委托给 17dz 子 Agent。',
  '子 Agent 在受信的 17dz-platform 工作目录中加载平台 Skill，并返回自然语言结果。',
  '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
  '涉及 17dz 实时数据时必须调用本工具，不得凭历史对话猜测平台标识或实时结果。',
  '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
].join('\n');

export interface Run17dzTaskArgs {
  request: string;
  taskId?: string;
  /**
   * 计划模式（Phase 6）的步骤标签（「第 N/M 步」），由宿主从 request 的协议前缀解析出来。
   * 只用于给这一步委派过程中平台计划门产出的用户通知加前缀，让用户看到全局进度；
   * 不进 Main Agent 工具 schema，也不进 worker 提示词。
   */
  stepLabel?: string;
  /** Host-only semantic intent; this is never part of the Main Agent tool schema. */
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>;
  /**
   * 领域无关的实体来源（宿主注入）：计划里的每个实体必须能在「当前消息 / 检索证据 /
   * 本轮平台响应 / 本会话已确立实体」里逐字找到。同样不进入 Main Agent 工具 schema。
   */
  entitySources?: PlanEntitySources;
}

export interface SubagentTaskResult {
  taskId: string;
  text: string;
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
   * 写关闭终稿标记（D-075，驱动侧 writeClosed 的透传）：本回合宿主拦下过含写类
   * operation 的计划（部署未开放 write），text 是宿主合成的写关闭话术而非 worker
   * 文本。宿主据此把这段确定性话术直接作为本轮回复——出口校验的零执行标注不得
   * 覆盖或误标其来源（与澄清问题同一家族：宿主持有并发音）。
   */
  writeClosed?: boolean;
  /**
   * 平台健康信号（Lane 2，驱动侧 authFailure 的透传）：本回合平台交互以登录/凭据类
   * 失败收尾（驱动从平台错误信封机械派生，判据在 platform-contract）。宿主据此做
   * 会话级连续失败记账与冷却；与 execution 不互斥——失败的那次调用真发生过。
   */
  authFailure?: PlatformAuthFailure;
  /**
   * 提案已登记（方案 1 · B 波 B3 网关提案路径，驱动侧 proposalCreated 的透传）：`text` 是
   * **宿主持有的确定性文本**（平台 `summaryText` 原样 + 通用确认行）。宿主据此把这段文本
   * 作为本轮回复——与 writeClosed 同一家族：出口校验的零执行标注不得覆盖它（提案这一步
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
}

export interface ContextTaskRunnerOptions {
  profiles: Record<string, ContextProfileConfig>;
  tasks: PlatformTaskRepo;
  workerDriver: TurnDriver;
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
   * 新路径的落账后端是否已接（B4 接线后由部署层置真）。派生规则由部署层经 isCommitEnabled()
   * 计算：mock 模式下写的是假状态，部署层应传 true 放开全链联调；真平台下须显式
   * FSHINE_REAL_COMMIT=1 才传 true。false 时给用户的确认行明说"确认不会写入任何数据"
   * ——不承诺还没接上的事：承诺了而确认步只会 fail-closed，是把用户往一句谎话上引。
   */
  proposalCommitEnabled?: boolean;
  /**
   * 新路径的落账后端（B4）：确认码命中带 proposalId 的条目时，由服务端直调平台 commit
   * （cwd = platformRoot，serve 法域）。缺省 = 未接线；此时 proposalCommitEnabled 也必须
   * 为假（接线与开关同进同退），确认步只到达"确认收到但不写"。
   */
  proposalCommitRunner?: (req: ProposalCommitRequest) => Promise<ProposalCommitResult>;
}

export interface ContextTaskExecutionContext {
  trusted: TrustedContext;
}

export interface ContextTaskRunner {
  readonly tool: DiscoveredTool;
  run(
    args: Run17dzTaskArgs,
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

/**
 * 确认码匹配的结构化结局（替代回复文本嗅探）：
 *   · confirm_executed：确认码命中待确认提案且落账完成；
 *   · confirm_cancelled：取消码命中待确认提案且作废完成；
 *   · confirm_failed：确认/落账链路失败（执行器未配置或落账未完成，意图置 failed）；
 *   · confirm_held：确认收到但落账执行未启用，提案保持待确认（无状态变化）；
 *   · confirm_stale：码已终结，给出确定性解释（无状态变化）。
 */
export type ConfirmationOutcome =
  | 'confirm_executed'
  | 'confirm_cancelled'
  | 'confirm_failed'
  | 'confirm_held'
  | 'confirm_stale';

export interface ConfirmationReply {
  text: string;
  outcome: ConfirmationOutcome;
}

export const RUN_17DZ_TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['request'],
  additionalProperties: false,
  properties: {
    request: { type: 'string', minLength: 1, description: '交给 17dz 子 Agent 的完整任务或用户最新补充' },
    taskId: { type: 'string', description: '仅在继续此前 17dz 子任务时使用返回的 taskId' },
  },
};

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
 * 宿主直调平台网关的环境（serve 法域）：**显式剥 `DZ_REQUIRE_PLAN`**、显式声明 `DZ_SERVE`。
 *
 * 修 D-081：那个 mandate 是给 worker 的 bash 子进程的（每个 worker 命令都带它，见
 * createPlanScopedWorkerEnv），服务进程自己并不带。宿主直调是"服务端替 worker 办一件事"，
 * 不该被 worker 的计划门拦——否则同一份部署里服务端调得动、worker 调不动，或反过来，
 * 取决于进程 env 恰好有什么。剥显式表达"这里不过计划门"，不靠继承来的 env 碰巧为空。
 *
 * 导出共认一份：宿主直调平台的两处（提案创建、提案落账，B 波 B3/B4）用同一把尺——
 *  env 纪律在两处各写一遍，就是给"某一处忘了剥"留门。
 */
export function hostGatewayEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DZ_REQUIRE_PLAN;
  env.DZ_SERVE = '1';
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
const defaultProposalGatewayRunner: PlanCliRunner = ({ platformRoot, args, env }) => new Promise((resolve, reject) => {
  const child = spawn(gatewayExecPath(platformRoot), args, {
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
 * 把驱动上报的结构化事实（D-065）合并进任务条目：calls/accountSet/period/label 取本次
 * 委派的快照（替换式——任务的最新范围），resultText 追加（同一任务多次委派的结果 trail，
 * 上限见 RESULT_TEXT_MAX_CHARS），outcome 由委派结局定。全部字段可选——缺一个就不写一个，
 * 消费方据此降级，不猜不补。
 */
const RESULT_TEXT_MAX_CHARS = 2_000;

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
      ...(facts.accountSet ? { accountSet: facts.accountSet } : {}),
      ...(facts.period ? { period: facts.period } : {}),
      ...(facts.label ? { label: facts.label } : {}),
    } : {}),
    ...(resultText ? { resultText } : {}),
  };
}

export function createContextTaskRunner(options: ContextTaskRunnerOptions): ContextTaskRunner {
  const profileId = options.profileId ?? '17dz';
  const intentTtlMs = options.intentTtlMs ?? 10 * 60_000;
  const generateCode = options.generateCode ?? defaultGenerateCode;
  const hashCode = options.hashCode ?? defaultHashCode;
  // ── 下游平台保护（并发闸）────────────────────────────────────────────
  // 真实平台的浏览器是共享登录态的持久 profile（launchPersistentContext）：
  // 并发委派会多开 Chrome 抢同一 profile——那正是"被平台感知"的典型方式
  // （会话互踢、登录态竞争、行为像自动化）。默认全局串行，可用
  // FSHINE_PLATFORM_CONCURRENCY 放宽。排队只增加等待，不影响正确性；
  // 速率另由平台侧 DZ_RATE_LIMIT 令牌桶控制（read/global/api 分类）。
  const platformLimit = Math.max(1, Number.parseInt(process.env.FSHINE_PLATFORM_CONCURRENCY ?? '', 10) || 1);
  let platformActive = 0;
  const platformWaiters: Array<() => void> = [];
  function releasePlatformSlot(): void {
    platformActive -= 1;
    const next = platformWaiters.shift();
    if (next) next();
  }
  async function acquirePlatformSlot(requestId: string, queuedSince: number): Promise<() => void> {
    if (platformActive < platformLimit) {
      platformActive += 1;
      return releasePlatformSlot;
    }
    await new Promise<void>((resolve) => platformWaiters.push(resolve));
    platformActive += 1; // 取走 releaser 刚释放的份额
    console.info(JSON.stringify({ event: 'platform_delegation_queued', requestId, waitedMs: Date.now() - queuedSince }));
    return releasePlatformSlot;
  }
  const tool: DiscoveredTool = {
    name: RUN_17DZ_TASK_TOOL,
    description: RUN_17DZ_TASK_DESCRIPTION,
    inputSchema: RUN_17DZ_TASK_SCHEMA,
  };

  /** 宿主通用确认行（协议文本，唯一来源）：确认码 + 取消码 + 有效期。 */
  function confirmLineFor(code: string, commitLive: boolean): string {
    const ttlMinutes = Math.round(intentTtlMs / 60_000);
    return commitLive
      ? `回复「确认 ${code}」执行录入；回复「取消 ${code}」作废。${ttlMinutes} 分钟内有效。`
      : `回复「确认 ${code}」完成确认流程（当前落账执行未启用——确认不会写入任何数据）；回复「取消 ${code}」作废。${ttlMinutes} 分钟内有效。`;
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
   * 顺序即安全：capability 复核（宿主持有的授权）→ 授权名单复核 → 办调平台 → 落意图条目
   * → 生成确认码。能力不成立时**零平台调用**（不办调），当场合成写关闭话术。
   */
  async function createProposalViaGateway(
    call: ProposalCreateCall,
    ctx: ContextTaskExecutionContext,
    taskId: string,
    platformRoot: string,
  ): Promise<ProposalCreationOutcome> {
    const capabilities = ctx.trusted.capabilities ?? [];
    // ① capability 复核（Generic，不依赖任何 operation 名）：A 波标定——创建提案的
    // operation 声明为 access: scratch，平台 `confirm` 列为假，所以 D-075 那道"计划里出现
    // 写类 operation 就前置合成"的机械兜底对提案步不触发；这一刀必须宿主自己下，而宿主
    // 确切知道"正在创建提案"这一刻。话术唯一来源在 error-codes.ts（WRITE_NOT_ENABLED），
    // 与计划门拒绝、旧提案路径同一句。
    if (!capabilities.includes('write')) {
      const text = messageTextFor('WRITE_NOT_ENABLED');
      return { status: 'write_closed', userText: text, workerText: text };
    }
    // ② 授权名单限制模式（host-held scope，与旧路径同判据）：名称到 id 的映射不在 fshine 侧，
    // V1 仅对 scope=all 的账号开放写。payload 不透明不等于这条可以丢——丢了就是把允许名单
    // 受限主体的写面放大。
    if (ctx.trusted.allowedAccountSetIds.length > 0) {
      const text = '当前账号为授权名单限制模式，写开放暂不支持该模式，已停止。';
      return { status: 'write_closed', userText: text, workerText: text };
    }
    // ③ 办调平台（serve 法域；env 显式剥 DZ_REQUIRE_PLAN——修 D-081：宿主直调不该被
    // worker 的计划门拦，那个 mandate 是给 worker 子进程的）。operation 名来自驱动拦截时
    // 从命令里取到的目标 token（平台 protocol 列已声明它扮演创建提案角色），宿主不另持
    // 一份业务 operation 名单。
    const result = await (options.proposalGatewayRunner ?? defaultProposalGatewayRunner)({
      platformRoot,
      args: ['prepare', call.operation, call.payloadPath],
      env: hostGatewayEnv(),
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
      const ci = options.changeIntents;
      if (!ci) throw new ToolUserError('写流程未启用（未配置 changeIntents 仓库）。');
      // 新提案使旧 pending 作废（与旧路径同一语义）：会话里同时只留一个待确认提案。
      const active = await ci.findPendingBySession(ctx.trusted.principalId, ctx.trusted.sessionId);
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
        userText: [summaryText, confirmLineFor(code, options.proposalCommitEnabled === true)].join('\n'),
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
   * 三笔债的落点：
   *   · D-080 第 ① 步：capability 按**确认时点**复核，不认提案时的快照（"提案成立后
   *     收回写权限"正是这个缺口的形状）；
   *   · D-081 由 commit 后端的 env 纪律承担（hostGatewayEnv 剥 DZ_REQUIRE_PLAN）；
   *   · D-082 由 writeBackTaskOutcome 承担（committed / confirm_failed 都回写终态）。
   */
  async function confirmProposalViaGateway(
    rec: ChangeIntentRecord,
    proposalId: string,
    ctx: TrustedContext,
  ): Promise<ConfirmationReply> {
    const ci = options.changeIntents!;
    // ① D-080：确认时点复核 capability。判据与提案时那一刀完全相同（宿主持有的授权，
    // Generic，不依赖任何 operation 名）——差别只在**时点**：授权可能在提案与确认之间被
    // 收回（运维关了写、principal 权限变更），那时这个码必须被拒。不通过 → 意图保持
    // pending：提案还在平台侧有效，用户修好权限或作废后仍可继续，不借"过期"说谎。
    if (!(ctx.capabilities ?? []).includes('write')) {
      console.warn(JSON.stringify({
        event: 'change_intent_confirm_declined',
        intentId: rec.intentId,
        reason: 'capability_revoked_at_confirm',
      }));
      return {
        text: `确认已收到，但${messageTextFor('WRITE_NOT_ENABLED')}本次未写入任何数据，提案保持待确认。`,
        outcome: 'confirm_held',
      };
    }
    // ② 落账后端未接（部署开关关着）：确认收到但不写。
    // 承诺必须与能力对齐：说了"确认即录入"而这一步只会 fail-closed，是把用户往谎话上引。
    if (options.proposalCommitEnabled !== true) {
      return {
        text: '确认已收到。当前落账执行未启用（对真实平台的写入需显式开启），本次未写入任何数据；提案保持待确认，如需作废请回复「取消 <确认码>」或等待其过期。',
        outcome: 'confirm_held',
      };
    }
    const commitRunner = options.proposalCommitRunner;
    if (!commitRunner) {
      // 开关说接了、后端却没注入 = 配置故障。fail-closed：不猜一个执行器出来。
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

  return {
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
          return confirmProposalViaGateway(rec, rec.proposalId, ctx);
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
    async run(args, ctx, signal) {
      if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
        throw toolUserErrorFor('TASK_REQUEST_EMPTY');
      }
      if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.trim() === '')) {
        throw toolUserErrorFor('TASK_ID_INVALID');
      }

      const profile = await resolveContextProfile(options.profiles, profileId);
      // continueTaskId 查不到就抛 ToolUserError——不猜、不兜底。宿主只保证两件事：
      // 错误永远诚实可行动、爆炸永远有界。"这个会话里有几个开放任务"宿主确实知道，
      // 但"模型想续的是哪一个"只有模型知道；替它猜（哪怕恰一个时猜对）就是把重试的
      // 职责从模型手里拿回来，猜错时用户的问题会被静默送进别的子任务。编号无效时说清
      // 编号无效、并给出下一步动作（措辞在 error-codes.ts 表里），模型下一轮自己改。
      const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
      if (args.taskId && !existing) throw toolUserErrorFor('TASK_NOT_FOUND');
      if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
        throw toolUserErrorFor('TASK_FORBIDDEN');
      }

      // 计划模式（Phase 6）：这一步的计划门通知带上「第 N/M 步」前缀交付用户——
      // 用户因此看到"现在在拆解的第几步"，而不是一条没有上下文的孤立通知。
      // 前缀插在固定标记之后，渠道与 e2e 替身仍按「计划通知：」识别这是通知帧。
      const stepLabel = typeof args.stepLabel === 'string' ? args.stepLabel.trim() : '';
      const trustedNotice = ctx.trusted.onNotice;
      const onNotice = trustedNotice
        ? stepLabel
          ? async (text: string) => { await trustedNotice(withStepLabel(text, stepLabel)); }
          : trustedNotice
        : undefined;
      const taskId = existing?.taskId ?? `task_${randomUUID()}`;
      const running: PlatformTaskRecord = {
        taskId,
        parentSessionId: ctx.trusted.sessionId,
        principalId: ctx.trusted.principalId,
        workerMessages: existing?.workerMessages ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await options.tasks.upsert(running);

      const messages = [
        ...((existing?.workerMessages ?? []) as DriverMessage[]),
        { role: 'user', content: args.request, timestamp: Date.now() } as unknown as DriverMessage,
      ];
      let result: TurnDriverResult | undefined;
      const delegationStart = Date.now();
      const deadline = delegationStart + (profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      try {
        // 并发闸：worker 会话期间独占下游平台（默认全局串行，见文件顶部说明）
        const release = await acquirePlatformSlot(ctx.trusted.requestId, delegationStart);
        try {
          result = await options.workerDriver.run({
            systemPrompt: workerSystemPrompt(profile.root, ctx.trusted.allowedAccountSetIds, args.turnDeclaration, ctx.trusted.capabilities, `tmp/${ctx.trusted.requestId}`),
            tools: [],
            messages,
            cwd: profile.root,
            skillRoots: profile.skillRoots,
            sessionId: taskId,
            requestId: ctx.trusted.requestId,
            onStep: ctx.trusted.onStep ?? (() => {}),
            exec: async () => { throw new ToolUserError('17dz 子 Agent 只能使用其工作目录内配置的原生工具。'); },
            deadline,
            signal,
            ...(args.turnDeclaration ? { turnDeclaration: args.turnDeclaration } : {}),
            ...(args.entitySources ? { entitySources: args.entitySources } : {}),
            ...(profile.knowledgePaths ? { knowledgePaths: profile.knowledgePaths } : {}),
            ...(profile.sensitivePaths ? { sensitivePaths: profile.sensitivePaths } : {}),
            ...(onNotice ? { onNotice } : {}),
            // 写关闭判据（D-075）的宿主持有输入：计划里出现写类 operation 而能力不含
            // write 时，worker 驱动在计划评估前就拦下并合成写关闭话术。缺省 = 只读。
            capabilities: ctx.trusted.capabilities,
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
              onCreateProposal: (call) => createProposalViaGateway(call, ctx, taskId, profile.root),
            } : {}),
          });
        } finally {
          release();
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
          throw new Error(signal?.aborted ? '17dz 子任务已取消。' : '17dz 子 Agent 未返回可用结果。');
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
          console.info(JSON.stringify({
            event: 'delegation_span',
            requestId: ctx.trusted.requestId,
            taskId,
            durationMs: Date.now() - delegationStart,
            outcome: 'terminal_fast_path',
            code: result.terminalFailure.code,
            ...workerUsage,
          }));
          throw new ToolUserError(renderTerminalFailureReply(result.terminalFailure));
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
        const final: SubagentTaskResult = {
          taskId,
          ...(result.execution ? { execution: result.execution } : {}),
          // 平台健康信号（Lane 2）：登录/凭据类失败的事实原样上交——宿主据此记账与冷却。
          // 与 execution 不互斥（失败的那次调用真发生过），所以两条并列挂载。
          ...(result.authFailure ? { authFailure: result.authFailure } : {}),
          // 写关闭终稿标记（D-075）：text 是宿主合成的确定性话术，原样上交——宿主据此
          // 直接终结本轮，不经模型翻译、不经出口校验标注。
          ...(result.writeClosed ? { writeClosed: true } : {}),
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
        // 唯一不带码前缀的形态，17dz 侧尚未给它挂码；在平台收口之前先留正则兜底，
        // 否则那一条会退化成 executor_error——而"请稍后再试"对 auth 是错指令。
        // 平台侧该消息一带码（走 messageFor），这行即可删除。
        const failureClass = signal?.aborted ? 'cancelled'
          : Date.now() >= deadline ? 'timeout'
          : isPlatformAuthError(error) ? 'auth'
          : /平台登录已过期/.test(error instanceof Error ? error.message : '') ? 'auth'
          : 'executor_error';
        console.info(JSON.stringify({
          event: 'delegation_span',
          requestId: ctx.trusted.requestId,
          taskId,
          durationMs: Date.now() - delegationStart,
          outcome: 'failed',
          failureClass,
          // 失败前已产生的部分转录同样计入（超时/取消前 worker 真实消耗过的 token）；
          // result 缺席（驱动没返回过）时字段缺席。
          ...(result ? usageFieldsOf(result.messages) : {}),
        }));
        console.error(JSON.stringify({
          event: 'subagent_task_failed',
          taskId,
          failureClass,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        // 超时/失败也持久化本轮已产生的中间转录：taskId 续跑从断点继续，
        // 而不是从零重付全部时间与浏览器占用（长任务业务稳定性的关键）。
        await options.tasks.upsert({
          ...withExecutionFacts(running, result ?? { text: '', messages: [] }, 'failed'),
          ...(result?.messages?.length ? { workerMessages: result.messages as unknown[] } : {}),
          updatedAt: new Date().toISOString(),
        });
        // auth 类经 toolUserErrorFor 挂码抛出（消息一字不改）：宿主侧的平台健康信号
        // （platform-health.ts 的连续失败记账）认这个码——码级判据，不嗅探回复文本。
        // 其余三类维持原样（没有第二类失败需要宿主跨回合记账）。
        if (failureClass === 'auth') throw toolUserErrorFor('DELEGATION_AUTH_FAILURE');
        throw new ToolUserError(signal?.aborted ? DELEGATION_CANCELLED
          : failureClass === 'timeout' ? DELEGATION_TIMEOUT_FAILURE
          : DELEGATION_EXECUTOR_FAILURE);
      }
    },
  };
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

async function resolveContextProfile(profiles: Record<string, ContextProfileConfig>, id: string): Promise<ResolvedContextProfile> {
  const configured = profiles[id];
  if (!configured) throw new ToolUserError(`未配置 17dz 上下文 profile:${id}`);
  const root = await fs.realpath(configured.root).catch(() => { throw new ToolUserError(`17dz 上下文目录不可用:${id}`); });
  const skillRoots: string[] = [];
  for (const relative of configured.skillRoots) {
    if (path.isAbsolute(relative)) throw new ToolUserError('17dz skillRoots 必须是相对 root 的路径。');
    const resolved = await fs.realpath(path.join(root, relative)).catch(() => undefined);
    if (!resolved || !isInside(root, resolved)) throw new ToolUserError('17dz skillRoots 未通过路径安全校验。');
    skillRoots.push(resolved);
  }
  return {
    root,
    skillRoots,
    workerTimeoutMs: configured.workerTimeoutMs,
    ...(configured.knowledgePaths ? { knowledgePaths: configured.knowledgePaths } : {}),
    ...(configured.sensitivePaths ? { sensitivePaths: configured.sensitivePaths } : {}),
  };
}

interface ResolvedContextProfile {
  root: string;
  skillRoots: string[];
  workerTimeoutMs?: number;
  knowledgePaths?: string[];
  sensitivePaths?: string[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * worker 系统提示词（四类：身份 / 原则 / 硬边界 / 输出纪律）。
 *
 * 组织律法：**判断类**规则（怎么想）与**机械类**规则（边界在哪）分开放，输出类规则
 * （说什么形状的话）单独收口。每条防一类已发生的事故，注释只记事故不记叙事：
 *   · 优先复用     —— 治"自己写渲染器/自己洗数据"：平台有确定性子过程而 worker 重造，
 *                    重造那份与平台口径漂移，产出于是不可复核。
 *   · 交付前自检   —— 治"不过校验直接交付"：域提供的校验入口被跳过，错数据直达用户。
 *   · 范围         —— 治"自作主张扩大产出"：用户只要一件事，worker 顺手多做一件没人要的。
 *   · 拿不到就说缺 —— 治"换口径试探/猜参数/拿缓存值当真值"：一次查不到就换个写法蒙。
 *   · 经济性       —— 治"越挫越试"与"为次要产出阻塞主产出"（四轮实测：同一拒绝理由
 *                    连撞五次，预算烧光超时，主产出没回到用户手上）。
 *   · 内部语言不上屏 —— 治 Stage 3 事故：结构化歧义被写成技术报告，脚本路径/错误码/
 *                    门的规则引述全上屏。宿主已改为替 worker 组装结构化状态，这里只
 *                    钉"数据答案"的语域。
 * 律法 L2：协议事实平台拥有，宿主读数据（operation list --json）不抄写——所以这里
 * **不手抄**网关调用形状与 flag 纪律，只给"以平台清单为准"这一指针。
 */
function workerSystemPrompt(
  root: string,
  allowedAccountSetIds: readonly string[],
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>,
  capabilities?: readonly string[],
  scratchDir?: string,
): string {
  const scope = allowedAccountSetIds.length > 0
    ? `授权名单：${allowedAccountSetIds.join(', ')}。不得查询或操作名单外对象。`
    : '授权名单：未提供；范围以平台领域脚本的权限校验为准。';
  // 能力信封（D-075 软层）：把本部署的能力声明作为框架事实告诉 worker——"写入/只读"
  // 是通用能力词，不是业务词（不触泄漏 lint 的业务词预算）。为什么需要这一层：第 1 层
  // （计划扫描）是机械兜底，但 T7 事故形态里模型的计划可能全程只含只读的"录入准备"
  // 调用——机械扫描无事可做，能否披露全靠 worker 自己知道写权限是关闭的。具备领域知识
  // 的 worker 在这一句的提示下能在准备阶段自行披露。**诚实报告：这层没有机械锁**，
  // 与 D-072 的技能条同性质——软提示，不保证模型一定说；保证用户一定知道的是第 1 层
  // （计划含写类 operation 时宿主直接合成 WRITE_NOT_ENABLED 终稿）。
  // 未开放时给 worker 的确切措辞插值自 error-codes.ts 的 WRITE_NOT_ENABLED（唯一来源），
  // 不在这里造第二份手抄本；开放时只陈述"写入由服务端在用户确认后执行"这一既有事实。
  const capabilityEnvelope = capabilities?.includes('write')
    ? '能力信封：本部署已开放写入能力；写入由服务端在用户确认后执行，你不得自行落库。'
    : `能力信封：本部署未开放写入能力（只读）。用户提出写入类请求时，必须在准备或执行前如实告知——${messageTextFor('WRITE_NOT_ENABLED')}不得承诺可以完成写入。`;
  // 可写位置（机械边界，不是约定）：write 工具只有这一个目录写得进去；不说，worker
  // 只能猜，猜错就被门拒并白跑一轮。按 requestId 派生子目录是因为 tmp/ 是共享草稿区，
  // 多个会话同时写同名产物会互相覆盖，而覆盖后的产物看不出被谁污染。
  // 同一条里带上 edit（2026-10-08 实测）：worker 写了 11KB 脚本崩在 KeyError，只想改
  // 一行却没有 edit 工具，bash 门又只准网关调用（用不了 sed），只能整份重写——33 秒
  // 模型生成，而写 11KB 不可能一次对，这类迭代必然反复。放在同一段而不新起一条：
  // 它是"怎么写"的细则，不是另一条边界（边界仍然只有 tmp/ 这一处）。
  const scratchNotice = scratchDir
    ? `可写位置：${scratchDir}，其他路径不可写（机械边界）。**改自己写的脚本用 edit（精确文本替换，不要整份重写）**——重写一份 11KB 脚本要 30+ 秒生成，改一行只要一次替换。`
    : '';
  // 读不到上游内容时自写解析代码（D-083，用户明确批准）：read 只放行文本知识面，二进制
  // 附件读不进来；这一条把"自己写脚本"限定在上游吸收，并钉住路径必须落在本轮可写位置内
  // （平台只放行 tmp/ 下的脚本），且子进程 env 被剥掉凭据类变量（不是沙箱：脚本仍能读盘，
  // 故不要读写与任务无关的文件）。刻意不提具体文件格式名——格式域不该进通用提示词。
  const absorbNotice = scratchDir
    ? `读不到上游内容时（如附件是二进制），可自写解析脚本放进可写位置，经统一入口本地执行；脚本只落在这里，不读写无关文件。`
    : '';
  // 计划门协议（宿主协议，保留状态字）：执行前先提交方案，按平台裁决状态行事。草案形状
  // 由 planDraftExample() 单一来源派生（L2：平台 schema 拥有形状，宿主不抄第二份），
  // 这里不另写一种形状；状态字是宿主协议的一部分，压到一行。
  const planNotice = `执行前先提交方案：第一条 bash 命令是单行 JSON——${planDraftExample()}，calls 逐项列出 operation 与参数。PLAN ACTIVE 后才能执行；PLAN DECLINED 按原因修正后重提；PLAN NEEDS_USER_CONFIRM / PLAN PAUSED 结束回合等宿主；PLAN STOP 说明停止原因。范围变化时重提完整 calls。`;
  // 知识面（门禁）：只经 read 读固定知识面，"技能指向的程序文档"让 SOP 类文档合法可读
  // （此前被排除在知识面外，worker 于是从不读 SOP）。实现源码不可读——读源码会把它
  // 的中间状态当成协议事实，而那正是平台拥有、宿主与 worker 都不该镜像的那一半真相。
  const knowledgeNotice = '知识只经 read 工具读固定知识面（挂载技能、域文档、*.schema.json 及技能指向的程序文档）；实现源码不可读；先读知识面再调用平台能力，数据必须来自平台返回，不得编造。';
  // turnDeclaration：宿主已核验本轮请求（含实体来源），worker 严格按此执行——宿主不做
  // 领域判别，这一句是它唯一能给出的范围承诺；缺了它，worker 会自行从历史内容补范围。
  const declarationNotice = turnDeclaration
    ? `宿主已核验本轮请求；严格按此执行，不得扩大范围或补历史范围：${turnDeclaration.request}`
    : '';

  return [
    '## 身份与职责',
    [
      '你是平台任务执行 Agent，在受信工作目录内完成一项具体任务。最终回复面向用户；你对两件事负责：结果正确，和不越界。',
      `工作目录：${root}`,
    ].join('\n'),
    '## 工作原则',
    [
      // ① 优先复用：平台已提供的确定性子过程（校验、渲染、格式转换）必须调用——治"自己
      //    写渲染器/自己洗数据"，重造那份与平台口径漂移，产出不可复核。自写代码只用于
      //    上游吸收：格式不稳定、需要判断的那一步（D-083 的解析脚本即此形态）。
      '1. 优先复用：平台已提供的确定性子过程（校验、渲染、格式转换）必须调用，不要自己实现；自写代码只用于上游吸收——格式不稳定、要判断的那一步。',
      // ② 交付前自检：该域提供校验入口就必须过一遍——治"不过校验直接交付"，错数据直达用户。
      '2. 交付前自检：该域提供校验入口的必须过一遍再交付；不过就停下报告，不改不跳过。',
      // ③ 范围：只做被要求的事——治"自作主张扩大产出"（用户只要一件事，顺手多做一件）。
      '3. 范围：只做被要求的事；发现范围外的产出或前置动作，报告，不要自作主张。',
      // ④ 拿不到就说缺什么：只做平台文档声明的操作——治"换口径试探、猜参数、拿缓存值
      //    当真值"（一次查不到就换个写法蒙，蒙出来的数无法复核）。
      '4. 拿不到就说缺什么：只做平台文档声明的操作；不换口径试探，不猜参数，不用缓存值代替真实查询。',
      // ⑤ 经济性：治四轮实测的两种失效形态——"越挫越试"（同一拒绝理由连撞五次，换姿势
      //    不算新尝试，预算烧光超时且主产出没回到用户手上）与"为次要产出阻塞主产出"。
      '5. 经济性：一次调用能拿到的不要写脚本绕；同一障碍最多撞两次——同类错误第二次出现时就停止重试（换写法、换路径、换参数形态再试不算新尝试），先交付已经确定的部分，不要为次要产出阻塞主产出。',
    ].join('\n'),
    '## 硬边界',
    [
      // 平台调用形状以清单为准（律法 L2）：这里刻意不手抄网关形状与 flag 纪律——手抄那份
      // 随平台演进过期，而模型会照着手抄那份去撞门。也不限定某一种模式：产出该走哪条
      // 路由由清单说明，worker 自己读。
      '平台调用走统一入口；形状与可用模式以平台清单（operation list --json）为准，不手抄。',
      planNotice,
      capabilityEnvelope,
      knowledgeNotice,
      scope,
    ].join('\n'),
    // 可写位置与自写解析（2026-10-17 从硬边界段首移到此处）：scratchNotice 内嵌
    // `tmp/${requestId}`，每请求都变——原先排在提示词 ~40% 处，跨回合续跑（requestId
    // 更新）时缓存从这一点炸断，其后全部提示词 + 复用的 workerMessages 历史按全价重付。
    // 移到稳定段（身份/原则/硬边界）之后、输出纪律（含每步变化的 declarationNotice）
    // 之前：变化频率排序 = 静态 → 每请求（本块）→ 每步（declaration 尾注），缓存断点
    // 尽量靠后。无标题块：语义上仍是硬边界的延伸（"机械边界"的怎么写细则），且落点
    // 恰在两个标题之间，C 系列的分区断言不受影响。
    ...(scratchNotice
      ? [[scratchNotice, ...(absorbNotice ? [absorbNotice] : [])].join('\n')]
      : []),
    '## 输出纪律',
    [
      // 回复面向用户 + 内部语言不上屏（Stage 3 事故根治包）：worker 的工作上下文全泡在
      // 执行语言里（协议命令 / 技能文档 / 信封错误码），它是执行语言与用户语言之间唯一
      // 的翻译器——压力下翻译退化，执行语言就越界进最终回复。宿主已改为替它组装结构化
      // 平台状态，这里只钉"数据答案"的发声形状。
      '回复面向用户：只说结论、数据和需要用户给什么。',
      '内部语言不上屏：脚本路径、错误码、JSON、协议状态、接口名、门的规则不进回复。',
      // 来源标注纪律（2026-09-27 第三波）：用户不需要知道接口标识符，"平台实时查询"已足够
      // 证明数据不是编的；写出 operation 名/接口名/脚本名只会把内部语言带上屏。
      '来源标注只说“平台实时查询”这类中性表述，不出现 operation 名、接口名或脚本名。',
      // 内部控制不上屏（同波）：计划额度、拒绝次数、熔断、计划门、重试上限是宿主/平台的
      // 内部控制状态，对用户"下一步做什么"没有任何帮助——实测里它被当成"说明"交出去，
      // 反而像在推卸。因内部限制停顿时只说事实与出路，不说机制。
      '内部控制不上屏：计划额度、拒绝次数、熔断、计划门、重试上限等内部控制状态；因内部限制停顿时只说事实与出路，不说机制。',
      // 不主动交代表能力边界（同波）：诚实不等于全说。用户没问到的口径，接口不支持就不是
      // 他需要知道的事——主动交代整段边界说明只是噪音；问到该口径时才如实说明。
      '不主动交代表能力边界：只回答用户问到的；边界仅在该口径被问到时才说明。',
      // 名称类请求仍须先经平台检索确认（D-072）：真实平台实测里用户给出需要解析的名称，
      // 模型未搜索也未澄清，直接用会话里已确立的实体出数——连续性修复让模型宁可信任
      // 上下文也不重新解析。会话实体只回答"用户只给参数的续问"，新名称一律重新检索。
      '名称类请求仍须先经平台检索确认规范名称，即使用户本会话已经用过某个对象。',
      // 已取数据必须呈现（D-073）：实测"我们的客户有哪些"——模型花 295s/8 调用，本轮已查到
      // 的维度数据不出现在终稿里，反请用户补充范围重查：数据在手，球踢回给用户。
      '本轮已经取到的执行结果必须呈现在终稿里；确未取到的，明示缺席原因。',
      // 纠错环：执行不了时报"缺什么/为什么/建议提供什么"，与总结原则同一份表述。
      '缺信息或执行不了时，用自然语言说明缺什么、为什么、建议提供什么。',
      ...(declarationNotice ? [declarationNotice] : []),
    ].join('\n'),
  ].join('\n\n');
}
