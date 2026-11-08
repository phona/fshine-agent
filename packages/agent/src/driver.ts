/**
 * TurnDriver:一次回合的模型驱动抽象。
 * 生产实现走 pi-agent-core + pi-ai(pi-driver.ts);测试用 ScriptedTurnDriver(本文件)。
 * 上下文模型:转录即状态——messages 是包含工具调用与结果的完整转录,回合结束时
 * driver 返回更新后的转录,由 runtime 持久化。不做任何投影或裁剪。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import type { PlatformAuthFailure, SelectionClarification, TerminalFastPathFailure } from './platform-contract';
import type { PendingPlanConfirmation, PlanCall } from './plan-runtime';
import type { ProposalCreateCall } from './proposal-runtime';
import type { PlanEntitySources, TurnDeclaration } from './turn-contract';

/** 转录消息 = pi 原生 AgentMessage(JSON 可序列化,含工具调用与结果) */
export type DriverMessage = AgentMessage;

export interface TurnDriverInput {
  systemPrompt: string;
  /** host tools/list 发现的工具(含 inputSchema),driver 据此构造原生工具定义 */
  tools: readonly DiscoveredTool[];
  /** 完整转录:历史全部消息(不含本条新用户消息,由 runtime 在调用前 push) */
  messages: DriverMessage[];
  /** 阶段进度回调(埋点事实渲染 + 模型意图短语) */
  onStep: (text: string) => void;
  /** 执行工具:返回 data(原样进入转录);失败时抛出面向用户的安全话术 */
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** 回合绝对截止时间(Date.now() 基准),超时 driver 应中止并返回空文本 */
  deadline: number;
  /** Optional trusted cwd for a higher-level coding-agent driver. */
  cwd?: string;
  /** Optional skill roots mounted by the trusted context profile. */
  skillRoots?: readonly string[];
  /** Profile-declared gateway invocation (interface §1/§2); text recognition derives from it. */
  gateway?: string;
  /** Stable worker/session id used by a resumable driver. */
  sessionId?: string;
  /** 请求级关联 id（审计串查 fshine ↔ 平台门控日志用）。 */
  requestId?: string;
  /** Parent cancellation propagated into a delegated agent turn. */
  signal?: AbortSignal;
  /** Host-validated semantic scope for directly routed platform tasks. */
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>;
  /**
   * 领域无关的实体来源集合（架构 §2 第 9 条）：宿主注入，供驱动在校验提交的计划时
   * 做逐字包含判定。缺省表示宿主没有可注入的来源（如未经宿主演派的任务），
   * 驱动不做实体来源校验。
   */
  entitySources?: PlanEntitySources;
  /** 平台仓知识面规则（worker read/ls 白名单；缺省用 G1 内置）。 */
  knowledgePaths?: readonly string[];
  /** 平台仓敏感路径规则（worker 禁读；缺省用 G1 内置）。 */
  sensitivePaths?: readonly string[];
  /** Trusted host notice callback, awaited before any notify-required plan activates. */
  onNotice?: (text: string) => Promise<void>;
  /**
   * 本回合 worker 的工作区（相对 cwd，如 `tmp/task_<taskId>`）：write/edit 的机械边界与
   * 提案 payload / 计划产物路径豁免的判据输入。续跑同一任务共享同一工作区（变更项 ⑨）。
   */
  scratchDir?: string;
  /**
   * 提案创建网关路径（方案 1 · B 波 B3）的宿主出口：驱动在 `beforeToolCall` 认出"创建提案"
   * 的网关调用后，把 `{operation, payloadPath}` 交给它办调平台，并按返回的三态处理
   * （completed 终结本回合 / needs_input 交还 / failed 交还平台错误码）。
   *
   * 宿主经它办调平台，**不经 worker**：payload 路径由 worker 命令给出，但读文件、校验、
   * 落意图条目、发确认码全在服务端。（B 波那个"提案创建走不走网关"的开关退役后恒定注入，
   * 见 context.ts 的接线处。）
   */
  onCreateProposal?: (call: ProposalCreateCall) => Promise<ProposalCreationOutcome>;
}

/**
 * 计划调用的结构化事实（D-065，P2）：宿主从 worker 提交的计划命令**机械解析**出的调用
 * 与平台 args 规格声明名对应的取值。
 *
 * 为什么由驱动产出：只有驱动同时持有这两样确定性材料——worker 提交的计划命令（宿主
 * 自己解析的 calls）与平台 args 规格 / label 表（驱动侧派生）。**绝不从 worker 文本
 * 解析**：转录里"提过"不等于"执行过"。字段缺失（本回合没提计划 / 规格对不上）时整项
 * 缺省，消费方（platform_tasks 的结构化字段）据此降级，不猜不补。
 */
export interface PlanCallFacts {
  /** 本回合宿主解析出的计划调用（原样，未经任何加工）。 */
  calls: readonly PlanCall[];
  /** 平台 args 规格声明名为 accountSet 的取值（平台规范名/检索关键词）。 */
  accountSet?: string;
  /** 平台 args 规格声明名为 period 的取值（YYYYMM）。 */
  period?: string;
  /** 首个 operation 的中文标签（平台清单第 5 列）。 */
  label?: string;
}

/**
 * 子 Agent 执行不了时的结构化线索（架构 §3 纠错环，roadmap Phase 5）。 *
 * 两个来源，都必须是确定性的：
 *   1. 脚本化替身（离线 e2e）直接产出；
 *   2. 真实 worker 由驱动从「平台确定性拒绝原因」派生——RESULT 信封里的错误码、
 *      宿主计划拦截的原因原文。**禁止对 worker 自由文本做模糊匹配**：那是猜，不是事实。
 *
 * 宿主拿到它时不 terminate 整轮，而是把线索交还 Main Agent：能自己补的补（从 Log /
 * 检索证据 / 本轮平台响应取实体），不能补的转告用户，然后用 continueTaskId 重派原任务。
 */
export interface SubagentNeeds {
  /** 缺什么（领域无关的条目：来自平台错误码的主体词，或宿主拦截原因所指的对象）。 */
  missing: string[];
  /** 为什么做不了（确定性原因原文，不是自由文本猜测）。 */
  reason: string;
  /** 建议用户提供什么（可选）。 */
  suggestion?: string;
}

export interface TurnDriverResult {
  /** 最终给用户的回复文本;空字符串表示本次模型调用未产出可用回复 */
  text: string;
  /** 更新后的完整转录(含本回合全部消息),由 runtime 持久化 */
  messages: DriverMessage[];
  /** 执行面回执（worker 驱动专有）：本轮网关调用数/预算，供上层委派方感知重量 */
  footprint?: string;
  /** Platform plan pending for a host-side user confirmation flow. */
  pendingPlan?: PendingPlanConfirmation;
  /**
   * 子 Agent 执行不了时的结构化线索。有它表示这一轮缺信息、任务可续，
   * 宿主应把线索交还规划者而不是以失败收尾。
   */
  needs?: SubagentNeeds;
  /**
   * Host-verified proof that this turn really reached the platform: an activated plan plus at
   * least one executed call. Absent this, the host must not let the turn's text reach the user.
   */
  execution?: { planId: string; version: number; calls: number };
  /**
   * 本回合计划调用的结构化事实（D-065）：宿主机械解析的计划命令 + 平台 args 规格取值。
   * 与 execution 的分工：execution 证明"执行发生过"，planFacts 写清"执行的是什么"。
   */
  planFacts?: PlanCallFacts;
  /**
   * 方案已获批准（计划已激活）但本次没有执行任何平台调用（P1 收尾兜底）。
   * 与 execution 互斥：有 execution 就说明真执行过。宿主据此给出确定性收尾文案
   * （"批准了但没执行，回复继续重跑"），而不是让用户补充早就给过的查询范围。
   */
  activatedPlan?: { planId: string; version: number };
  /**
   * 结构化歧义/未找到（2026-09-27 Stage 3 事故根治包）：本回合的平台交互以"选择类"
   * 状态收尾（平台请用户选一个），信封事实由宿主持有。有它表示本轮回复是澄清问题而不是
   * 数据答案——宿主用模板+数据机械组装，模型不得翻译（脚本路径/错误码/门的规则由此绝迹）。
   *
   * 与 needs 的分工：needs 是"缺什么、任务可续"的纠错线索；clarification 是"平台给了候选、
   * 用户必须选一个"的澄清事实。两者可以同时缺省，也可以同时出现（宿主优先 clarification）。
   */
  clarification?: SelectionClarification;
  /**
   * 错误态快路径的终局事实（v2，2026-10-16 重做）：平台确定性终局码（PERIOD_NO_DATA /
   * ASSISTANT_* 两态，TERMINAL_FAST_PATH_CODES）以"整份答案"收尾时，驱动挂上信封事实。
   * `text` 是宿主模板渲染的话术（turn-relay 的 renderTerminalFailureReply），**不是
   * worker 文本**——第一版（2026-10-17 凌晨回退）早停后 text 是空串，宿主空文本检查
   * 先于一切分支抛"未返回可用结果"，用户拿到 executor 兜底话术；v2 皮带 + 背带：
   * 驱动合成非空 text + 宿主豁免带结构化收尾的结果，两条防线各自独立成立。
   * 挂了它 = 这一跳的结果就是整份答案（单调用计划 + 本跳执行过，判据在驱动侧——
   * 只有驱动看得见本跳全部 toolResults）；宿主侧不再用 planFacts.calls.length 复推
   * （第一版门与真实驱动的字段装配时序错位正是隐患之一），只保留多步计划的
   * `!stepLabel` 守卫。
   */
  terminalFailure?: TerminalFastPathFailure;
  /**
   * 平台健康信号（Lane 2）：本回合的平台交互以登录/凭据类失败收尾——驱动从平台错误
   * 信封**机械派生**（error.code ∈ PLATFORM_AUTH_ERROR_CODES，判据在 platform-contract，
   * 绝不嗅探 worker 文本）。与 execution 不互斥：失败的那次网关调用真发生过
   * （gateCalls > 0），"调用发生过"与"调用失败了"是两个事实。宿主据此做会话级连续
   * 失败记账与冷却（platform-health.ts）。
   */
  authFailure?: PlatformAuthFailure;
  /**
   * 提案已登记（方案 1 · B 波 B3 网关提案路径）：宿主拦下 worker 的提案创建网关调用、
   * 自己办调平台 create 成功，`text` 是**宿主持有的确定性文本**（平台 `summaryText` 原样
   * + 通用确认行），不是 worker 文本。宿主据此把这段文本作为本轮回复——与澄清问题同族：
   * 出口校验的零执行标注不得覆盖或误标其来源（提案这一步可能零网关执行，而"提案已登记、
   * 等用户确认"是真实状态，不是空转）。
   *
   * `proposalId` 是平台提案引用（取物单）：宿主持有的全部，指向执行层自己的提案状态库。
   */
  proposalCreated?: { proposalId: string };
  /**
   * 模型侧瞬时失败的透传事实（波次C，2026-11-01）：worker 的模型调用撞上传输/服务
   * 中断，驱动侧有界重试用尽（或判为不可重试）后仍失败——此时 `text` 为空串，本字段
   * 是那次失败的 errorMessage 原文。宿主据此把失败分类为 model_transient（与真实
   * executor 故障分开），而不是只看得到"空文本"再退化成 executor_error。超时/取消
   * 的回合**不**带它（那两条是宿主自己的收尾事实，先于模型侧表征判定）。
   */
  modelError?: string;
}

/**
 * 宿主办调平台创建提案的结局（`onCreateProposal` 的返回，方案 1 · B 波 B3）。
 *
 * 三态，全部由宿主从**平台 RESULT 信封**判定，没有一个字节从 worker 自由文本解析：
 *   · `completed`   平台 create 成功：`userText` 给用户（平台 summaryText 原样 + 通用确认行，
 *                    **不含任何宿主拼的业务摘要**），`workerText` 给 worker（确定性事实，
 *                    **绝不含确认码**——码只出现在给用户的文本里）；
 *   · `needs_input` 平台还要更多信息：按确定性线索交还 worker（needs 机制）；
 *   · `failed`      平台拒绝/失败：交还平台错误码。
 *
 * 2026-11-08 架构裁定后没有第四态"write_closed"：写能不能真落地归执行层，宿主不再在办调
 * 前判"这个部署允不允许写"，也不合成写关闭话术。执行层的拒绝 / warning / dryrun 提示由
 * 平台自己的信封给出，宿主经 `failed` 的 errorCode/workerText 如实转述。
 */
export type ProposalCreationOutcome =
  | { status: 'completed'; proposalId: string; userText: string; workerText: string }
  | { status: 'needs_input'; needs: SubagentNeeds; workerText: string }
  | { status: 'failed'; workerText: string; errorCode?: string };

export interface TurnDriver {
  run(input: TurnDriverInput): Promise<TurnDriverResult>;
  /** 上下文压缩(SDK compact)。超阈值时替换旧消息为摘要+保留最近尾巴;未超限原样返回。
   *  force:true 跳过阈值判断强制压缩(会话过期软着陆用);失败时实现方应原样返回,不阻塞回合。 */
  compact?(messages: DriverMessage[], opts?: { force?: boolean }): Promise<DriverMessage[]>;
  /**
   * 服务端确定性回复(确认码直执等)合成原生 assistant 消息:必须带完整内部形状
   * (api/provider/model/usage/stopReason),否则该转录进入下一模型回合时
   * pi-ai 结算会内部报错(stopReason='error' 被静默吞掉,2026-09-20 实测)。
   * 未实现时 runtime 回退为简化形状(仅测试驱动可接受)。
   */
  synthesizeAssistant?(text: string): DriverMessage;
}

// ── 真实 token 消耗的求和（纯加法遥测：性能测试与成本分析用，不算钱不计费）────────
//
// 数据源是 pi-ai 盖在每条 assistant 消息上的真实 provider Usage（message.usage，分项：
// input/output/cacheRead/cacheWrite/reasoning）。pi-agent-core 不做会话级聚合，聚合是
// 本文件的事。**禁止用 estimateTokens/estimateContextTokens 做账目**——那是压缩时机的
// 字符近似判断，不是 provider 计量。

/**
 * 分项合计的形状（cost 不进账：遥测不算钱不计费）。
 * 口径要点：`reasoning` 是 `output` 的**子集**（pi-ai 契约：output 已含 reasoning），
 * 任何合计都不得把 reasoning 再加一遍。
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** provider 回报了推理分项才有（⊆ output）；从未回报时缺席。 */
  reasoning?: number;
}

/**
 * 对转录里 assistant 消息的 usage 求和；一条 usage 证据都没有时返回 undefined。
 *
 * 缺失策略（全采集点统一，选了"缺席"而不是"全零"）：单条消息缺 usage 按 0 计入；
 * 整段转录没有任何 usage 证据时返回 undefined，调用方据此让埋点字段**缺席**——
 * 全零会把"网关没回传"洗成"真的消耗了 0 token"，账目上两者必须可区分。
 * 失败消息的 usage 是 pi-ai 的全零占位（EMPTY_USAGE，形状恒定），求和自然为 0：
 * 那是"provider 如实报 0"的事实，与"没回传"（undefined）正是靠这里区分的。
 */
export function sumUsage(messages: readonly DriverMessage[]): UsageTotals | undefined {
  let seen = false;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reasoning: number | undefined;
  let reasoningSeen = false;
  for (const message of messages) {
    if ((message as { role?: string }).role !== 'assistant') continue;
    const usage = (message as { usage?: Partial<Record<keyof UsageTotals, unknown>> }).usage;
    if (!usage || typeof usage !== 'object') continue;
    seen = true;
    totals.input += typeof usage.input === 'number' ? usage.input : 0;
    totals.output += typeof usage.output === 'number' ? usage.output : 0;
    totals.cacheRead += typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
    totals.cacheWrite += typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
    if (typeof usage.reasoning === 'number') {
      reasoning = (reasoning ?? 0) + usage.reasoning;
      reasoningSeen = true;
    }
  }
  if (!seen) return undefined;
  return reasoningSeen ? { ...totals, reasoning } : totals;
}

/** 两个分项合计相加（undefined = 没有证据，加法单位元）。 */
export function addUsageTotals(a: UsageTotals | undefined, b: UsageTotals | undefined): UsageTotals | undefined {
  if (!a) return b;
  if (!b) return a;
  const reasoning = a.reasoning === undefined && b.reasoning === undefined
    ? undefined
    : (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/**
 * 埋点字段投影（turn_span / delegation_span / aux_model_usage 共用同一份口径，注释即定义）：
 *   · tokensIn = input（本轮新付的上下文 token，不含缓存读写——缓存另列，成本分析各有其价）；
 *   · tokensOut = output（模型生成量，**已含 reasoning**，不再重复相加）；
 *   · cacheRead / cacheWrite = provider 缓存命中/写入分项；
 *   · reasoning = 推理分项（provider 未回报时字段缺席）；
 *   · tokens = input+output+cacheRead+cacheWrite（全口径总量。不取 provider 自报的
 *     totalTokens：各家口径不一，按分项自算账目才自洽）。
 */
export function usageSpanFields(totals: UsageTotals): Record<string, number> {
  const fields: Record<string, number> = {
    tokensIn: totals.input,
    tokensOut: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
  };
  if (totals.reasoning !== undefined) fields['reasoning'] = totals.reasoning;
  return fields;
}

/** 求和 + 投影一步到位：转录里没有任何 usage 证据时返回空对象（埋点字段缺席，不报全零）。 */
export function usageFieldsOf(messages: readonly DriverMessage[]): Record<string, number> {
  const totals = sumUsage(messages);
  return totals ? usageSpanFields(totals) : {};
}

/** 工具失败的确定性终结错误:message 是面向用户的安全话术,直接作为最终回复(driver 不得再喂给模型) */
export class ToolUserError extends Error {
  /**
   * route_current_turn 的终结是否发生在委派已经开始之后。
   *
   * 这是宿主内部的转录元数据，驱动会把它放进 toolResult.details；不进入用户可见文本。
   * 未标记的 ToolUserError 表示前置拦截或其他宿主错误。
   */
  delegationCompleted = false;
  /** Host receipt kind persisted into the tool result; background acceptance is not execution proof. */
  readonly routeReceipt?: 'delegate' | 'precondition' | 'background';
  /** 错误码（挂码修复：runtime.isAuthDelegationFailure 等码级判据依赖此字段）。 */
  code?: string;

  constructor(message: string, options?: {
    delegationCompleted?: boolean;
    routeReceipt?: 'delegate' | 'precondition' | 'background';
    code?: string;
  }) {
    super(message);
    this.name = 'ToolUserError';
    this.code = options?.code;
    this.routeReceipt = options?.routeReceipt
      ?? (options?.delegationCompleted === true ? 'delegate' : undefined);
    this.delegationCompleted = this.routeReceipt === 'delegate' || options?.delegationCompleted === true;
  }
}

export interface ScriptedTurnStep {
  /** 本次模型调用回放的原生工具调用(依次真实执行 exec) */
  toolCalls?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** 本次调用的回复文本(不回放工具调用时即最终答案) */
  text?: string;
}

/**
 * 脚本化驱动:消耗步骤直到某一步给出 text——中间步骤的 toolCalls 依次真实执行
 * (对齐生产中"模型连续调用工具"的行为);步骤耗尽仍未给出 text → 返回空。
 * exec 抛 ToolUserError 时,按生产语义将其 message 作为最终回复返回。
 */
export function ScriptedTurnDriver(steps: ScriptedTurnStep[]): TurnDriver {
  if (steps.length === 0) {
    throw new Error('ScriptedTurnDriver:步骤不能为空');
  }
  let cursor = 0;
  return {
    async run(input) {
      for (let guard = 0; guard <= steps.length; guard += 1) {
        const step = steps[Math.min(cursor, steps.length - 1)]!;
        cursor += 1;
        try {
          for (const call of step.toolCalls ?? []) {
            await input.exec(call.tool, call.args);
          }
        } catch (error) {
          if (error instanceof ToolUserError) {
            // 测试驱动产出的 assistant 消息为简化形状,转录由 runtime 原样透传,不做解释
            return {
              text: error.message,
              messages: [...input.messages, { role: 'assistant', content: error.message, timestamp: Date.now() } as unknown as DriverMessage],
            };
          }
          throw error;
        }
        if (step.text !== undefined) {
          return {
            text: step.text,
            messages: [...input.messages, { role: 'assistant', content: step.text, timestamp: Date.now() } as unknown as DriverMessage],
          };
        }
      }
      return { text: '', messages: [...input.messages] };
    },
  };
}
