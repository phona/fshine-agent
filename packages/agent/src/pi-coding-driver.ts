/**
 * Worker driver backed by the official pi-coding-agent SDK.
 *
 * The main Agent continues to use the small pi-agent-core driver.  This
 * driver is deliberately only for trusted context workers: the SDK owns the
 * cwd-bound native tools (read/ls/bash/write/edit — grep/find are deliberately
 * not granted so code scanning has no entry; the write face is fenced in
 * serve-gate's decideFileWrite) and its headless AgentSession, while fshine
 * still owns task persistence and the parent session.  The tool list is pinned
 * by WORKER_TOOLS and asserted in docs-reality.test.ts: the prose header had
 * drifted from the real list twice without being noticed (2026-10-16 文档对账
 * 实证), which is why the list is now a named constant.
 */
import {
  type AgentSession,
  type AgentToolResult,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  createBashToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage, BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Model } from '@earendil-works/pi-ai/compat';
import { A2A_PROTOCOL_VERSION, type DiscoveredTool, type StructuredCall } from '@fshine/contracts';
import Type from 'typebox';
import { ToolUserError, type DriverMessage, type PlanCallFacts, type ProposalCreationOutcome, type SubagentNeeds, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { hasServerPath } from './server-paths';
import { createServeGate, describePlanCalls, isInsideScratch, planDeclarationCovers, planDeclarationCoversStructured, planSemanticsEntryForReference, structuredPlanGateVerdict, tierOfEntry, workspaceRelPath, AUDIT_DETAIL_MAX_CHARS, MAX_WRITE_BYTES, type GateInvocationKind, type PlanGateTier, type ServeGateEvent, type ServeGateVerdict } from './serve-gate';
import { isWriteAccess, loadCapabilityManifest, loadOperationArgSpecs, loadOperationArgStyles, loadOperationLabels, loadOperationProtocols, loadOperationSemantics, serveModesOf, type AccessSemantics, type CapabilityManifest, type KeyArgStyles, type KeyArgStyle, type OperationArgsSpecs, type OperationLabels, type OperationProtocols, type OperationSemantics } from './operation-labels';
import { errorFor, messageFor, messageTextFor } from './error-codes';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, loadCurrentActivePlan, parsePlanCallsCommand, parsePlanCallsPayload, planCallFacts, type PlanCall, type PlanCliRunner, type PendingPlanConfirmation, type PlanSubmission } from './plan-runtime';
import { parseProposalCommand, type ProposalCreateCall } from './proposal-runtime';
import { parseEnvelope, gatewayExecPathForProfile, resolveGatewayText, platformAuthFailureFromResponses, selectionClarificationFromResponses, terminalFastPathOf, TERMINAL_FAST_PATH_CODES, textFromContent, type PlatformAuthFailure, type PlatformEnvelope, type SelectionClarification, type TerminalFastPathFailure, type TranscriptMessageLike } from './platform-contract';
import { renderTerminalFailureReply } from './turn-relay';
import { createTaskPlatformRecorder, mergeTaskPlatformSources, transcriptPlatformSources } from './platform-entities';
import { validatePlanEntities, type PlanArtifactBoundary } from './turn-contract';
import { createStepCapWindDown, parseStepCap } from './worker-step-cap';
import { emptyTaskBudgetLedger, ledgerUsage, withActivatedPlan } from './task-budget';

/**
 * 同一子任务内计划被拒的收敛上限（Phase 6 验收补丁）。计划被拒是确定性信号
 * （实体越权 / 格式无效），反复重提只会空转模型预算——超过上限即 terminal block，
 * 让 worker 收手向用户说明缺什么。5 次宽容正常试错，合法流程不会触碰。
 */
const MAX_DECLINED_PLANS_PER_TASK = 5;

/**
 * Worker 的原生工具面（双写断言的锚点，docs-reality.test.ts 钉住本清单）：
 * grep/find 刻意不授——代码扫描失去工具入口，知识面经 read 白名单可达；
 * write/edit 只准写本轮 scratchDir（机械边界在 serve-gate 的 decideFileWrite，
 * 与 edit 共用一份判据）。改工具面必须同时改这里与 docs-reality 的断言——
 * 本文件的头注释曾与真实清单两度漂移未跟（2026-10-16 文档对账实证），
 * 自这份常量起清单只有一个来源。
 */
export const WORKER_TOOLS = ['read', 'ls', 'bash', 'write', 'edit', 'structured_call'] as const;

/**
 * 本回合 worker 的工作区（`tmp/task_<taskId>`，宿主注入）：worker 唯一可写位置。
 *
 * 一处注入三处消费——write/edit 门的边界（serve-gate 的 scratchDir）、提案 payload 边界
 * 检查（decideProposalCreation）与计划实体校验的产物路径豁免（validatePlanEntities 的
 * 第三个参数）。判据本身只有一份（serve-gate 的 workspaceRelPath + isInsideScratch），
 * 注入方只负责"本回合是哪个位置"这一个事实：按任务派生（续跑同任务共享工作区），
 * 不再按请求派生（变更项 ⑨）。
 */

/**
 * 计划提交进度帧：宿主替 worker 调平台评估方案时发一帧。措辞与业务无关
 * （不出现任何领域词），用户在 60-180s 的单轮里由此知道"卡在哪一步"。
 */
export const PLAN_SUBMIT_STEP = '正在向平台提交执行方案…';

/**
 * 计划已激活却零执行的确定性补一刀（P1 收尾事实兜底，2026-09-26 真实平台实测）。
 * 实测形态：方案已批准、计划通知已送达用户，worker 却不再发起任何平台调用就结束回合
 * ——主 Agent 只能给出"本轮没有产生任何平台查询"的兜底，反过来要求用户补充早就给过的
 * 查询范围。宿主在此追问一次，把"批准了但没执行"这个真实状态推回执行面。
 * 措辞与业务无关（不出现任何领域词）：只陈述确定性事实与明确指令，不代平台说话。
 */
export const PLAN_ACTIVATED_NUDGE = '宿主已批准你的执行方案（计划已激活）。请立即按方案中的 calls 执行查询，不要再次提交方案。如确实无法执行，说明具体阻碍。';

/**
 * 墙钟收尾信号（"失败必达"路径 1 的前半段）：回合预算用到 90% 时经 SDK 的 steer 通道
 * 注入一条 user 消息，给 worker 剩余 10% 自行收尾——停止开新工作、交付已完成部分
 * （产物引用 + 下一步一句话）。worker 在窗口内收尾的，回合照常完成（文本就是它的交付）；
 * 无视信号的，到点照旧被 abort 截停，由宿主从执行事实合成终稿（resource-exhausted.ts）。
 *
 * 边界如实记：steer 在 SDK 的跳间投递（当前这跳的工具调用结束后、下一次模型调用前）。
 * worker 卡在单个超长工具调用里时，信号要等该调用返回才能被看到——那种形状由 abort +
 * 宿主合成终稿兜底，本信号覆盖的是"多跳推进、越干越远"的常态。
 * 措辞与业务无关，不碰 workerSystemPrompt（这是回合内的 user 消息，不是系统提示词）。
 */
export const WORKER_WIND_DOWN_NUDGE = '【宿主收尾指令】处理时间预算即将用尽。立即停止开始任何新工作：不要再发起新的查询、处理或探索。用一段话交付已完成的部分——说明做完了什么、剩余未完成什么；不要在回复里写文件路径（落盘的产物由宿主按工作区扫描回收，路径对用户没有可行动性）。现在就收尾。';

/** 收尾窗口占预算的比例：最后 10% 留给 worker 自行收尾（90% 处发信号）。 */
export const WIND_DOWN_FRACTION = 0.9;

/**
 * 读类网关调用单轮预算帽（2026-11-10 真模型探针 Y2）：模型把平台当猜测缓冲——
 * 一轮里七个调用是同一名称的拼写变体、十四个调用换着词试同一条口径，
 * 每次都在等平台的 not_found 教它下一个写法。帽值达到时经既有 steer 收尾通道注入
 * READ_PROBE_WIND_DOWN_NUDGE：停手，把已确认事实与待用户决定的问题交出去。
 *
 * 只提示、不拦截：计数不参与任何裁决，回合结果（execution / footprint / text）不变。
 * 缺省 5 次；与步数帽同族可配（option `readProbeCap`）。
 */
export const DEFAULT_READ_PROBE_CAP = 5;

/** 读类探测收尾信号（与墙钟/步数帽共用 session.agent.steer 通道，措辞针对换写法重试）。 */
export const READ_PROBE_WIND_DOWN_NUDGE = '停止变换写法重试；把已确认的事实和需要用户决定的问题交出去。';

/**
 * 模型瞬时失败的有界重试档位（波次C，2026-11-01）：数组长度 = 重试次数上限，
 * 逐项 = 每次重试前的等待毫秒。默认最多 2 次、间隔 1-2 秒（指数退避的最小档——
 * 实测事故形态是 ~260ms 的网抖，秒级间隔足以跨过它，又远小于回合预算的噪声级）。
 *
 * 为什么在驱动层重试而不是靠 SDK 会话级自动重试：fshine 为避免重复 user 消息
 * 直调 `session.agent.continue()`（见 run() 内注释），整条绕开了
 * AgentSession.prompt() 的 _handlePostAgentRun 重试链；请求级 maxRetries:0 又是
 * pi-ai openai-completions 的既有配置。三层全缺席的后果（2026-10-31 实测
 * task_144c9690）：260ms 网抖报废 90 秒工作 + 烧掉一次用户确认。这里补的是宿主
 * 自己那条腿；判据不自造——可重试性认定用 pi-ai 现成的 isRetryableAssistantError
 * （与 SDK 自动重试同一份判据，见下方 retryableModelError）。
 */
export const DEFAULT_MODEL_RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

/** 距截止还剩 remainingMs 时，收尾信号应当发出的时刻（毫秒延迟）。纯函数，测试直测。 */
export function windDownDelayMs(remainingMs: number): number {
  return Math.max(1, Math.floor(remainingMs * WIND_DOWN_FRACTION));
}

/**
 * A1：绕开平台执行器的披露判据（**告警，不是门**）。
 *
 * 实测形态（同一个任务两个样本）：平台把"算工资表"拆成两半——worker 吸收脏输入洗出契约
 * （该它做），再交给平台执行器渲染（该平台做）。第二个样本里 worker 自己包了一个 wrapper
 * 调平台脚本：整轮只有本地执行，平台审计里 validate / transform 一次没经网关，而执行足迹
 * 只写着"1 次网关调用"（本地执行也计数）——一次看起来成功的委派。用户的顾虑正是这条：
 * "副作用无法评估"。
 *
 * 判据三条件同时成立才告警：
 *   ① 本轮有本地执行（localCalls > 0）——真在跑自己的代码；
 *   ② 本轮零计划门放行的平台执行调用（executorCalls === 0）——平台的校验/渲染一步没经
 *      网关（元数据查询不算：它不执行任何东西，见 serve-gate 的 SERVE_METADATA_COMMANDS）；
 *   ③ 本轮落盘了产物（producedFiles 非空）——委派确实产出了东西，不是空转。
 * ③ 是降噪阀：只写草稿脚本、没产出办公文件的回合不告警（那是合法的上游吸收，D-083）。
 *
 * 为什么这条判据可靠：三个输入全是宿主自己的机械留痕——门的形态族分类（按命令词法，
 * 见 gateInvocationKind）与 write/edit 的放行留痕（detail 即落点路径）。没有一步从
 * worker 文本解析，也不读平台侧运行产物（跨仓读对方的 .runtime 既耦合又无法按请求归属）。
 *
 * 已知边界（如实记账，不伪装成完备检查）：本地子进程**自己**写盘的文件宿主看不见
 * （wrapper 里 subprocess 写出的成品不走 write 门），所以 producedFiles 是"宿主放行写入
 * 的文件"，不是"盘上多出来的全部文件"。告警因此是"足够触发人工看一眼"的信号，不是
 * "盘上差异的完备清单"。
 */
export function platformExecutorBypassed(signal: {
  localCalls: number;
  executorCalls: number;
  producedFiles: readonly string[];
}): boolean {
  return signal.localCalls > 0 && signal.executorCalls === 0 && signal.producedFiles.length > 0;
}

/** Allowed-bash partition counts by gate kind (see gateInvocationKind). */
export interface GateCallCounts {
  gateCalls: number;
  executorCalls: number;
  localCalls: number;
  auxiliaryCalls: number;
}

/**
 * Partition of allowed bash calls by gate kind. The three kinds are
 * mutually exclusive (see gateInvocationKind), so exactly one sub-count
 * grows per call and the partition sum always equals gateCalls.
 *
 * This is the production counting function the driver calls in
 * onAllowedBash. It is deliberately separate from the step-cap wind-down
 * tracker: counting is unconditional, wind-down is a side effect only.
 * Two earlier defects had distinct causes (see gate-call-counts.test.ts
 * header — do not merge them into one cause):
 *  - else binding: the old code counted executor calls separately, then
 *    counted every non-local call into auxiliaryCalls, so an executor
 *    call was counted in executorCalls and again in auxiliaryCalls;
 *  - wind-down gating: the old code skipped the sub-count when the
 *    wind-down tracker fired, so a wind-down local call was dropped
 *    from localCalls (suppressing the platformExecutorBypassed
 *    disclosure when that call was the round's only local call), while
 *    a wind-down executor call was kept because executorCalls was
 *    incremented before the gate.
 */
export function recordAllowedBashCall(
  counts: GateCallCounts,
  kind: GateInvocationKind,
): GateCallCounts {
  return {
    gateCalls: counts.gateCalls + 1,
    executorCalls: counts.executorCalls + (kind === 'executor' ? 1 : 0),
    localCalls: counts.localCalls + (kind === 'local' ? 1 : 0),
    auxiliaryCalls: counts.auxiliaryCalls + (kind === 'auxiliary' ? 1 : 0),
  };
}

/**
 * 读类 operation 判据（读类探测帽用，不是门）：平台 access 语义表声明 read 档——
 * 与 serve-gate 的 read 档**同一份数据、同一把查表梯子、同一个分级函数**：
 *   · 查表 = planSemanticsEntryForReference（域感知：脚本路径先按所属域解析到注册名，
 *     再退裸名归一；`src/<域>/scripts/<命令>-<描述>.js` 也在域内唯一匹配）；
 *   · 分级 = tierOfEntry（confirm:true 优先写，plan:false 为 scratch，其余 read）。
 * 宿主不解释 effects 词表、不按命令词猜"读/写"，也不在驱动侧另写一份查表或合取——
 * 任何一处另写都会像 2026-11-10 复审抓到的那样与计划门漂移。
 *
 * 语义表缺表 / 查不到该 operation → false（宁缺勿猜）：帽只做一次收尾提示，
 * 分类不成立时宁可少发，也不把写类调用误当成"换写法试探"。
 */
export function isDeclaredReadOperation(reference: string | null | undefined, semantics: OperationSemantics | undefined): boolean {
  if (!reference) return false;
  return tierOfEntry(planSemanticsEntryForReference(reference, semantics)).tier === 'read';
}

/**
 * 被放行的 bash 调用是否属于读类网关探测：先由门自己的形态族（executor）确认这是
 * 经计划门放行的平台执行调用，再看门**已解析的档位**是不是 read。
 * 非网关命令、local、元数据（auxiliary）一律不计——探测帽只数真正触达平台读接口的调用。
 *
 * 档位必须来自事件上的 operationTier（门裁决时解析的那一份），**不能**从 event.detail
 * 反解析：detail 是审计展示面，落事件前已截到 AUDIT_DETAIL_MAX_CHARS，长绝对脚本路径
 * 会让计数看到残缺引用（2026-11-10 复审 major：计划门放行、计数漏计，持续读取不触发
 * 收尾提示）。解析只此一次，计数与门裁决不可能分叉。
 */
export function isReadClassGatewayCall(
  kind: GateInvocationKind | null | undefined,
  tier: PlanGateTier | undefined,
): boolean {
  if (kind !== 'executor') return false;
  return tier === 'read';
}

/** 绕开平台执行器的告警事件（宿主侧结构化留痕，只披露、不改回合结果）。 */
export interface PlatformExecutorBypassedEvent {
  requestId: string;
  taskId: string;
  /** 本轮本地执行调用数。 */
  localCalls: number;
  /** 本轮经计划门放行的平台执行调用数（query / prepare / commit / operation run）。 */
  planGateCalls: number;
  /** 本轮辅助出口调用数（能力面/计划形状元数据、领域记忆：不执行业务操作）。 */
  auxiliaryCalls: number;
  /** 本轮宿主放行写入的文件清单。 */
  producedFiles: readonly string[];
}

/**
 * 参数摘要拼接：多个用 · 分隔，没有参数就是空串。
 * 渲染层唯一一条模板，按参数个数/内容零分支。
 */
export function keyArgsFragment(keyArgs: readonly string[] | undefined): string {
  return keyArgs && keyArgs.length > 0 ? keyArgs.join('·') : '';
}

/** 平台操作 → 用户可见进度帧：`正在${label}${参数摘要}…`（唯一模板）。 */
export function operationStepText(label: string, keyArgs?: readonly string[]): string {
  return `正在${label}${keyArgsFragment(keyArgs)}…`;
}

/**
 * G1 放行事件 → 进度帧。没有 label（平台清单没给这一列 / 查不到这个操作）→ null：
 * 安全缺省是静默不发帧，绝不回退显示脚本名或操作名——内部事件名同理永不出厂。
 *
 * 帧里带上服务器路径 → 同样 null（与"没有 label"同一族安全缺省，2026-10-20 实测）：
 * 参数摘要那一侧已经不放路径（describeKeyArgs），这里守住剩下的来源——label 是平台
 * 数据，未来的摘要来源也可能变。判据用宿主那把 `hasServerPath`，不另立形状；宁可少
 * 一帧，也不把 `tmp/task_<uuid>` 送到企微用户眼前。
 */
export function serveGateStepText(event: Pick<ServeGateEvent, 'label' | 'keyArgs'>): string | null {
  if (!event.label) return null;
  const frame = operationStepText(event.label, event.keyArgs);
  return hasServerPath(frame) ? null : frame;
}

/**
 * 驱动侧 G1 事件出口：审计留痕 + 用户可见进度帧，一处接线。
 * 抽成函数是为了让测试能用同一条生产接线驱动替身会话——帧的产生逻辑只有一份，
 * 不存在"测试里另写一套渲染"。
 */
export function createServeGateAuditSink(sink: {
  onStep: (text: string) => void;
  audit?: (event: ServeGateEvent) => void;
  requestId?: string;
  /**
   * 放行的平台调用计数（执行面回执用），参数是**形态族**（serve-gate 的
   * gateInvocationKind）：回执的 calls 仍数所有被放行的 bash（语义一字未动），族名只供
   * "整轮有没有真调平台执行器"这条披露判据分流——绕开平台执行器要可观测，缺它就只有总数，
   * 而总数里本地执行与平台执行完全同形（A1 实测：足迹写着 1 次网关调用，平台审计里
   * validate/transform 一次没经网关）。
   *
   * 第二参带整条事件（其中 operationTier = 门裁决时解析出的档位）：读类探测帽要在族名
   * 之外再看 operation 的平台语义——读的是这个已解析档位，不是给审计展示的 detail
   * （detail 已按 AUDIT_DETAIL_MAX_CHARS 截断，长引用会残缺）。
   */
  onAllowedBash?: (kind: GateInvocationKind, event: ServeGateEvent) => void;
}): (event: ServeGateEvent) => void {
  return (event) => {
    if (event.tool === 'bash' && event.allowed && event.invocation) sink.onAllowedBash?.(event.invocation, event);
    const step = serveGateStepText(event);
    if (step) sink.onStep(step);
    sink.audit?.({ ...event, requestId: sink.requestId });
  };
}

/**
 * 计划里"不该进计划"的 operation 名单（去重、保序）：平台 access 语义表的 **plan 列与
 * confirm 列合起来的真判据**。
 *
 * 平台的真判据是 `planAccessAllows = plan && !confirm`（平台仓 `src/execution/plan.js`）：
 * 任一为假就进不了计划。只读 `plan` 一列会**漏掉写类**——而写类恰恰是最常被 worker 排进计划
 * 的那一种。2026-10-14 实测：`voucher.proposal`（`write` ⇒ `plan:true, confirm:true`）被排进
 * 计划，平台以 `PLAN_OPERATION_NOT_READ_ONLY` 拒，宿主按 `plan` 列点名得到空名单，退回零名单
 * 措辞「该调用不需要计划」而不说是哪一个——worker 无法定位该删哪一条，正是 D-089 的死因形状。
 *
 * serve-gate 的计划前置豁免读同一列（`planExempt`），两侧共用一份数据、一个判据——宿主不
 * 另立一份 operation 名单（L2），也不按错误码名猜。
 *
 * 宁缺勿猜，且方向与 planExempt 一致：语义表缺失 / operation 未登记时**不进名单**——未知不
 * 等于免计划。名单为空时调用方退回零名单措辞（PLAN_NOT_PLANNABLE），绝不把整份计划的
 * operation 统统说成"不该进计划"：2026-10-13 事故里 worker 已经试过"删一个再提"（删错了
 * 合法调用，仍然被拒），点错名字比不点名更糟。
 */
export function nonPlannableOperations(
  calls: readonly PlanCall[],
  semantics: OperationSemantics | undefined,
): string[] {
  const named = calls
    .filter((call) => {
      const row = semantics?.get(call.operation);
      return row ? !(row.plan && !row.confirm) : false;
    })
    .map((call) => call.operation);
  return [...new Set(named)];
}

/**
 * 计划门"含非只读 operation"拒绝 → 交给 worker 的停止原因正文（PLAN STOP 之后那段）。
 *
 * 唯一判据 = nonPlannableOperations（平台 `plan && !confirm` 两列合取）。2026-10-13 真平台
 * 实测：worker 的计划里有 4 个调用，其中一个是不该进计划的本地处理类，宿主每次只回"该调用
 * 不需要计划"而不说是哪个，它无法定位该删哪一个，原样重提 5 次后撞
 * MAX_DECLINED_PLANS_PER_TASK terminal block，只能向用户承认"登记环节连续被拒后已关闭"。
 * 点名即自愈通道：删掉它、改为直接调用、重提剩余 calls。
 *
 * 措辞唯一出处是 error-codes.ts 的表：点名版 PLAN_NOT_PLANNABLE_OPERATIONS（带 {operations}
 * 数据），点不出名字时退回零名单版 PLAN_NOT_PLANNABLE——调用点只选码、不拼句。
 *
 * 2026-11-08 架构裁定后这里**不再有"未开放写入权限"那一支**：写能不能真落地是执行层的事，
 * 编排层不判"这个部署允不允许写"，也就不合成"权限未开放"的归因话术（D-096 记的正是这类
 * 假归因把用户指去找管理员要一个他已经有的权限）。写类调用被平台计划门拒绝时，宿主只如实
 * 点名该调用、让它移出计划改为直接调用——之后的放行/拒绝/warning 由执行层自己说。
 */
export function planNotReadOnlyReason(
  calls: readonly PlanCall[],
  semantics: OperationSemantics | undefined,
): string {
  const named = nonPlannableOperations(calls, semantics);
  return named.length > 0
    ? messageTextFor('PLAN_NOT_PLANNABLE_OPERATIONS', { operations: named.join('、') })
    : messageTextFor('PLAN_NOT_PLANNABLE');
}

export interface PiCodingTurnDriverOptions {
  /** 知识面/敏感路径规则（由 context profile 传入 G1）。 */
  knowledgePaths?: readonly string[];
  sensitivePaths?: readonly string[];

  env: Record<string, string | undefined>;
  /** 平台根路径：label 表经公共 CLI 在此派生一次（缺省用每回合 worker cwd）。 */
  platformRoot?: string;
  /** Keep SDK auth/session files outside the mounted platform workspace. */
  agentDir?: string;
  /** Profile-declared gateway invocation (interface §1/§2). */
  gateway?: string;
  /** G1 工具门事件留痕（放行与拦截都上报，落 tool_calls 审计）。 */
  serveGateAudit?: (event: ServeGateEvent) => void;
  /** script → label 查找表（测试替身注入点）；缺省经平台 CLI 派生。 */
  operationLabels?: OperationLabels;
  /** flag → 取值样式表（平台 args 规格，测试替身注入点）；缺省经平台 CLI 派生。 */
  operationArgStyles?: KeyArgStyles;
  /** 整份 args 规格（位置参数声明名 + flag 样式，结构化事实提取用，测试替身注入点）。 */
  operationArgSpecs?: OperationArgsSpecs;
  /**
   * operation → 平台 access 语义表（`operation list --json` 的 `access` 列 × 顶层
   * `accessSemantics` 表，测试替身注入点）。写关闭判据（D-075）与计划门拒绝分流的
   * 机械来源：宿主据此判定"这份计划含要用户确认的 operation"，不在自己仓里另立
   * operation 名单（L2）。缺省经平台 CLI 派生一次。
   */
  operationSemantics?: OperationSemantics;
  /** operation → args 规格（位置参数声明，计划覆盖判据用）。 */
  operationArgsSpecs?: OperationArgsSpecs;
  /**
   * operation → 平台协议角色表（`operation list --json` 的 `protocol` 列，A 波新增；测试
   * 替身注入点）。提案创建拦截的机械来源：宿主据此认出"这个 operation 在写流程里扮演
   * 创建提案的角色"，不认业务 operation 名、不认脚本路径。缺省经平台 CLI 派生一次
   * （失败 = 空表 = 不拦截，平台门禁照旧兜底）。
   */
  operationProtocols?: OperationProtocols;
  planCliRunner?: PlanCliRunner;
  planActivationSecret?: string;
  /**
   * A1：绕开平台执行器的告警出口（披露是增强不是门——与附件披露、计划通知同族）。
   * 判据见 platformExecutorBypassed；调用方只负责留痕（审计/日志），不得据此改回合结果。
   */
  onExecutorBypassed?: (event: PlatformExecutorBypassedEvent) => void;
  /**
   * 模型瞬时失败的有界重试间隔表（波次C）：逐项为每次重试前的等待毫秒，长度即重试
   * 次数上限。缺省 DEFAULT_MODEL_RETRY_DELAYS_MS（2 次 / 1-2 秒）。测试替身注入点
   * （与 operationLabels 同族）；生产语义由常量测试钉住。
   */
  modelRetryDelaysMs?: readonly number[];
  /**
   * Free-worker step cap (Phase 2): allowed gate calls per turn, default 50.
   * The (cap+1)th allowed bash triggers the same wind-down nudge as the
   * 90% wall-clock point (done + not-done, no new work). Counting reuses
   * gateCalls; this option only changes the threshold, never the counter.
   */
  stepCap?: number;
  /**
   * 读类网关调用单轮预算帽：本轮为回答用户而发的读类平台调用达到该值（缺省 5）时，
   * 经既有 steer 收尾通道注入一次 READ_PROBE_WIND_DOWN_NUDGE（不阻断、不重复）。
   * 只改阈值，不另立计数器。测试替身注入点。
   */
  readProbeCap?: number;
  /**
   * 能力清单注入点（与 operationLabels / operationSemantics 同族）：缺省由会话按平台 CLI
   * 派生。结构化调用通道的声明来源；测试要驱动 structured_call 时不必造一份平台 CLI。
   */
  capabilityManifest?: CapabilityManifest;
}

export interface PiCodingWorkerSessionOptions {
  knowledgePaths?: readonly string[];
  sensitivePaths?: readonly string[];

  cwd: string;
  /** Profile-declared gateway invocation (interface §1/§2). */
  gateway?: string;
  skillRoots: readonly string[];
  systemPrompt: string;
  sessionId?: string;
  requestId?: string;
  agentDir: string;
  modelConfig: CodingModelConfig;
  serveGateAudit?: (event: ServeGateEvent) => void;
  /** 继承环境变量（结构化调用等子进程的基境）。缺省退回到 process.env。 */
  env?: Record<string, string | undefined>;
  /** 用户可见进度帧出口（宿主 → 渠道）：平台操作帧与计划提交帧都走这里。 */
  onStep?: (text: string) => void;
  onNotice?: (text: string) => Promise<void>;
  planCliRunner?: PlanCliRunner;
  planActivationSecret?: string;
  onPendingPlan?: (plan: PendingPlanConfirmation) => void;
  turnDeclaration?: TurnDriverInput['turnDeclaration'];
  /** 领域无关的实体来源：宿主注入，供计划校验做逐字包含判定（架构 §2 第 9 条）。 */
  entitySources?: TurnDriverInput['entitySources'];
  /** 能力清单（执行层 `operation list --json` 的投影）；缺省本会话自派生一次。 */
  capabilityManifest?: CapabilityManifest;
  /** script → label 查找表（平台 CLI 派生，驱动侧缓存后传入）；缺省本会话自派生一次。 */
  operationLabels?: OperationLabels;
  /** flag → 取值样式表（平台 args 规格 CLI 派生）；缺省本会话自派生一次。 */
  operationArgStyles?: KeyArgStyles;
  /**
   * worker 每提交一次（被宿主解析的）计划方案时的回调（D-065 结构化事实源）。
   * calls 是宿主自己解析的命令参数，不是 worker 文本；最后一次提交即本回合实际执行的范围。
   */
  onPlanSubmitted?: (calls: readonly PlanCall[]) => void;
  /**
   * 一次**被放行**的读类平台调用发生时的回调（读类探测帽的计数源，行为见
   * isDeclaredReadOperation）。只在平台语义表声明 plan:true / confirm:false 时触发；
   * 回调不参与裁决，由驱动侧决定何时发收尾提示。
   */
  onReadProbe?: () => void;
  /**
   * 本回合 worker 的工作区（宿主注入，TurnDriverInput.scratchDir 的透传，如
   * `tmp/task_<taskId>`）：write/edit 门、提案 payload 边界与计划产物路径豁免共用的
   * 判据输入。缺省（未注入，测试替身 / 老路径）= 三支边界整支不出现，判定与从前一字不差。
   */
  scratchDir?: string;
  /**
   * operation → 平台 access 语义表（平台 `operation list --json` 派生，测试替身注入点）；
   * 缺省本会话自派生一次（失败 = 空表 = 写类判定不生效，平台门禁照旧兜底）。
   */
  operationSemantics?: OperationSemantics;
  /** operation → args 规格（位置参数声明，计划覆盖判据用；与工厂级同名同义）。 */
  operationArgSpecs?: OperationArgsSpecs;
  /**
   * operation → 平台协议角色表（`operation list --json` 的 `protocol` 列）：提案创建拦截
   * 的机械来源（B 波 B3）。缺省本会话自派生一次（失败 = 空表 = 不拦截，落回 serve 门）。
   */
  operationProtocols?: OperationProtocols;
  /**
   * 提案创建网关路径的宿主出口（B 波 B3）：宿主经它办调平台 create，驱动按返回的三态处理。
   * 缺省 = 不拦截（fail-closed 到"宿主不认这条路"，门与平台照旧裁决）。
   */
  onCreateProposal?: (call: ProposalCreateCall) => Promise<ProposalCreationOutcome>;
  /**
   * 提案创建拦截的结局出口（驱动侧 latch 用，与 onPendingPlan 同族）：completed 时调用，
   * 驱动据此在结果时刻用宿主持有的文本（平台 summaryText + 确认行）终结本回合。
   */
  onProposalOutcome?: (outcome: Extract<ProposalCreationOutcome, { status: 'completed' }>) => void;
}

export interface PiCodingWorkerSession {
  session: AgentSession;
  skills: readonly { name: string; description: string; filePath: string }[];
  /** Currently activated plan for this worker task, if any. */
  currentPlan: () => { planId: string; version: number } | null;
  /**
   * 本任务迄今累积的「确定性拒绝」线索（宿主计划拦截的原因原文），没有则 null。
   * 驱动用它派生"缺什么"交还规划者——只认确定性原因，不看 worker 的自由文本。
   */
  needsClue: () => SubagentNeeds | null;
}

interface CodingModelConfig {
  runtime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * 本回合的结构化事实（D-065）：没提过计划 → undefined（调用方不挂字段，任务降级渲染）。
 * 取值提取在 planCallFacts（平台 args 规格查表 + 平台 label，零 worker 文本解析）。
 */
function planFactsOf(
  specs: OperationArgsSpecs,
  calls: readonly PlanCall[],
  labels: OperationLabels,
): PlanCallFacts | undefined {
  if (calls.length === 0) return undefined;
  const { accountSet, period, label } = planCallFacts(calls, specs, labels);
  return {
    calls: calls.map((call) => ({ operation: call.operation, args: call.args })),
    ...(accountSet ? { accountSet } : {}),
    ...(period ? { period } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * 一批 tool_result 里的**收尾信封**（从后往前第一条带 RESULT 信封的）：与
 * selectionClarificationFromResponses / platformAuthFailureFromResponses 同一把尺——
 * 收尾那一条决定本跳的平台交互状态，早先的信封不越权。
 */
function closingEnvelopeOfToolResults(toolResults: readonly TranscriptMessageLike[]): PlatformEnvelope | null {
  for (let i = toolResults.length - 1; i >= 0; i -= 1) {
    const envelope = parseEnvelope(textFromContent(toolResults[i]?.content));
    if (envelope) return envelope;
  }
  return null;
}

/**
 * 一批 tool_result 里的平台信封**条数**（逐条解析，与 closingEnvelopeOfToolResults 同一把
 * 尺）：错误态快路径"跳内多信封"守卫的计数器——条数 >1 即"收尾信封 = 整份答案"的前提
 * 不成立（见 shouldStopAfterTurn 的门④）。
 */
function countEnvelopesOfToolResults(toolResults: readonly TranscriptMessageLike[]): number {
  let count = 0;
  for (const result of toolResults) {
    if (parseEnvelope(textFromContent(result.content))) count += 1;
  }
  return count;
}

/** Create a headless pi-coding-agent driver for trusted context workers. */
export function createPiCodingTurnDriver(options: PiCodingTurnDriverOptions): TurnDriver {
  let modelPromise: Promise<CodingModelConfig> | undefined;
  // label 表按平台根路径各派生一次并缓存：绝不每条命令 spawn 一次 CLI。
  const labelCache = new Map<string, Promise<OperationLabels>>();
  const operationLabelsFor = (workerCwd: string): Promise<OperationLabels> => {
    if (options.operationLabels) return Promise.resolve(options.operationLabels);
    const root = options.platformRoot ?? workerCwd;
    const cached = labelCache.get(root);
    if (cached) return cached;
    const loading = loadOperationLabels(root, options.gateway).catch(() => new Map<string, string>());
    labelCache.set(root, loading);
    return loading;
  };
  // args 规格（flag → 样式）同样按平台根路径缓存一次：与 label 表分开两次 spawn
  // 同一子命令（TSV 取 label、--json 取规格——平台刻意把规格只放机器消费面）。
  const argStyleCache = new Map<string, Promise<KeyArgStyles>>();
  const operationArgStylesFor = (workerCwd: string): Promise<KeyArgStyles> => {
    if (options.operationArgStyles) return Promise.resolve(options.operationArgStyles);
    const root = options.platformRoot ?? workerCwd;
    const cached = argStyleCache.get(root);
    if (cached) return cached;
    const loading = loadOperationArgStyles(root, options.gateway).catch(() => new Map<string, KeyArgStyle>());
    argStyleCache.set(root, loading);
    return loading;
  };
  // 整份规格（位置参数声明名 + flag 样式）：结构化事实（D-065）的取值依据，同样按根缓存。
  const argSpecCache = new Map<string, Promise<OperationArgsSpecs>>();
  const operationArgSpecsFor = (workerCwd: string): Promise<OperationArgsSpecs> => {
    if (options.operationArgSpecs) return Promise.resolve(options.operationArgSpecs);
    const root = options.platformRoot ?? workerCwd;
    const cached = argSpecCache.get(root);
    if (cached) return cached;
    const loading = loadOperationArgSpecs(root, options.gateway).catch(() => new Map<string, never>());
    argSpecCache.set(root, loading);
    return loading;
  };
  // access 语义表（写关闭前置判定 D-075 与计划门拒绝分流的机械来源）：同样按平台根路径
  // 缓存一次，绝不每条命令 spawn 一次 CLI。派生失败/平台还没下发 accessSemantics → 空表
  // → 前置判定不生效（宁缺勿猜，平台门禁兜底）。
  const semanticsCache = new Map<string, Promise<OperationSemantics>>();
  const operationSemanticsFor = (workerCwd: string): Promise<OperationSemantics> => {
    if (options.operationSemantics) return Promise.resolve(options.operationSemantics);
    const root = options.platformRoot ?? workerCwd;
    const cached = semanticsCache.get(root);
    if (cached) return cached;
    const loading = loadOperationSemantics(root, options.gateway).catch(() => new Map<string, AccessSemantics>());
    semanticsCache.set(root, loading);
    return loading;
  };
  // 协议角色表（提案创建拦截的机械来源，B 波 B3）：与 label/规格/语义三张表同一手法——按
  // 平台根路径缓存一次，绝不每条命令 spawn 一次 CLI。派生失败/平台还没下发 protocol 列
  // → 空表 → 不拦截（fail-closed 到"这不是提案调用"），门与平台照旧裁决。
  const protocolCache = new Map<string, Promise<OperationProtocols>>();
  const operationProtocolsFor = (workerCwd: string): Promise<OperationProtocols> => {
    if (options.operationProtocols) return Promise.resolve(options.operationProtocols);
    const root = options.platformRoot ?? workerCwd;
    const cached = protocolCache.get(root);
    if (cached) return cached;
    const loading = loadOperationProtocols(root, options.gateway).catch(() => new Map<string, string>());
    protocolCache.set(root, loading);
    return loading;
  };

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      if (!input.cwd) throw new ToolUserError('Context Worker 缺少受信工作目录。');
      const { runtime, model, thinkingLevel } = await (modelPromise ??= createCodingModel(options));
      const agentDir = options.agentDir ?? process.env.FSHINE_PI_AGENT_DIR ?? `${process.cwd()}/data/pi-agent`;
      // 执行面回执：G1 事件计数（放行的 bash 才构成对平台的真实触达）
      let gateCalls = 0;
      // 自由 worker 步数帽（Phase 2）：计数复用 gateCalls，阈值可配，缺省 50。
      // steer 持有者先占位、会话建成后再赋值——onAllowedBash 在会话建成后的
      // 工具执行时才被调用，届时持有者已指向 session.agent.steer，与
      // currentPlan 的 latch 哲学同一手法。
      const stepCap = parseStepCap(options.stepCap ?? options.env.FSHINE_WORKER_STEP_CAP);
      // 步数帽收尾（第 2 包）：跟踪器是 worker-step-cap.ts 的生产代码，
      // 驱动在每次放行后把自己的 gateCalls 计数喂给它；第 cap+1 次恰好
      // 送一次 wind-down，之后不再重复。steer 持有者先占位、会话建成后
      // 再赋值——onAllowedBash 在会话建成后的工具执行时才被调用，届时
      // 持有者已指向 session.agent.steer，与 currentPlan 的 latch 哲学同一手法。
      let stepCapSteer: ((content: string) => void) | null = null;
      // 步数帽收尾未成功送达的待补发标志（见下方 stepCapSteer 赋值处）：
      // 跟踪器先置 latch 再调 steer，steer 一抛错跟踪器此后不再重调，
      // 所以驱动自己记 pending，在下一次放行时补发——成功送达一次即清，
      // 失败则保持 pending 待再下一次放行。墙钟 wind-down 失败有 abort +
      // 宿主合成终稿兜底，步数帽没有同款兜底，故不能只记 warn 就丢信号。
      let stepCapWindDownPending = false;
      const fireStepCapWindDown = createStepCapWindDown(stepCap, () => stepCapSteer?.(WORKER_WIND_DOWN_NUDGE));
      // 读类探测单轮预算帽（2026-11-10 Y2）：与步数帽共用同一条 steer 收尾通道，但计数
      // 对象是**被放行的读类平台调用**——bash 的 executor 族里语义表声明 read 的调用，
      // 加上 structured_call 通道里同一判据的调用。达到帽值（缺省 5）只送一次，之后不再
      // 重复；计数不参与任何裁决，回合结果不变。steer 持有者同样在会话建成后赋值。
      const readProbeCap = parseStepCap(options.readProbeCap, DEFAULT_READ_PROBE_CAP);
      let readProbeCalls = 0;
      let readProbeWindDownSent = false;
      let readProbeSteer: ((content: string) => void) | null = null;
      const noteReadProbe = (): void => {
        if (readProbeWindDownSent) return;
        readProbeCalls += 1;
        if (readProbeCalls < readProbeCap) return;
        readProbeWindDownSent = true;
        // 持有者在会话建成后立即赋值；此前不可能有工具调用，故不会走到空持有者。
        readProbeSteer?.(READ_PROBE_WIND_DOWN_NUDGE);
      };
      let bashRuns = 0;
      // A1 形态族计数与产物清单（绕开平台执行器的披露判据，见 platformExecutorBypassed）：
      // gateCalls 仍是"所有被放行的 bash"（execution/footprint 的语义一字未动，回合结果
      // 因此不变）；这里只把它拆成三个族并记下本轮落盘的文件——拆分只服务于告警披露，
      // 不参与任何裁决。三个族由门按命令词法分类（gateInvocationKind），宿主不猜内容。
      let executorCalls = 0;
      let localCalls = 0;
      let auxiliaryCalls = 0;
      // 本轮宿主放行写入的文件（write/edit 放行时 detail 即落点路径）。本地子进程自己写盘
      // 的文件宿主看不见——边界如实记在 platformExecutorBypassed 的注释里。
      const producedFiles: string[] = [];
      // 第一个被放行的 bash 调用发生时的计划身份（latch，见 onAllowedBash）。
      // 为什么不在结果时刻读 currentPlan()：worker 常常在真实调用之后继续重提方案——
      // beforeToolCall 里 activePlan 先置空再 evaluateAndActivatePlan，后续提交可能 scope
      // 识别失败/被拒，最终 activePlan 停在上一次提交后的 null。那时调用真发生过
      // （gateCalls > 0）但 currentPlan() 已是 null。执行足迹要回答的是"本轮有没有真实
      // 触达平台、当时挂在哪份计划下"，与回合收尾时计划恰好是什么状态无关，所以身份在
      // 放行瞬间 latch 下来，而不是结果时刻现读。
      let executedPlan: { planId: string; version: number } | null = null;
      // 本回合宿主解析出的计划调用（D-065 结构化事实源）：worker 每提交一次方案就刷新——
      // 与 executedPlan 同一 latch 哲学，取"本回合最后提交的那份 calls"（范围扩大时重提
      // 完整 calls，最后一份就是本回合实际执行的范围）。
      let plannedCalls: readonly PlanCall[] = [];
      // 「计划已激活却零执行」的补一刀边界：**每回合一次**，不是整个 driver 生命周期一次。
      // 生产上一个服务进程只有一个 driver 实例管所有回合，"生命周期一次"会让第二次同样故障
      // （可能一小时后、另一个用户）永远不再追问，用户只能手动回复"继续" → 下一回合重新委派
      // → 重新计划通知 → 再坏 → 再说"继续"，一个把用户卷进去的重试循环；而补一刀多花的只
      // 是一个模型轮，比它替代的那条手动循环便宜得多。系统性故障的根由
      // activated_plan_not_executed 告警日志交给运维，不需要用"只补一次"当信号。
      // 回合内仍然只补一次（内联单次，见下方 if）：绝不在同一回合里反复推同一个模型。
      let activatedPlanNudged = false;
      let pendingPlan: PendingPlanConfirmation | undefined;
      // 提案创建拦截的结局（B 波 B3）：宿主办调平台成功后本回合以此终结，所以它必须
      // latch 在 run() 作用域里——beforeToolCall 在会话里跑，结果时刻才读它。
      let proposalOutcome: Extract<ProposalCreationOutcome, { status: 'completed' }> | undefined;
      // 错误态快路径的早停 latch（v2，2026-10-16 重做；第一版 2026-10-17 凌晨因真模型
      // 探针回归被整波回退）：平台确定性终局码（TERMINAL_FAST_PATH_CODES）以"整份答案"
      // 收尾时，宿主在此合成话术终结本跳，不再付每轮约 31s 的 worker 重规划循环——
      // 数据不能凭重试变出来，循环的结局早已确定。shouldStopAfterTurn 在 SDK 的
      // agent_end 之前裁决（see 下方的 hook 装配），latch 必须在 run() 作用域：hook 在
      // 会话里跑，结果时刻（含补刀/异常出口）才读它。
      //
      // 【第一版死因，写在这里防止后人再踩】第一版只早停、不合成文本：早停发生在工具
      // 跳之后，转录里没有后续 assistant 文本，result.text 是**空串**；而 context.ts 的
      // 空文本检查先于 needs/clarification/终局全部分支执行，空 text 直接抛"未返回可用
      // 结果"、进 catch、被分类 executor_error——真模型探针 4/4 全数触发，用户拿到
      // "执行失败请稍后再试"。v2 的皮带就是下面这个字段里的非空 text：话术在 latch
      // 时刻由宿主模板渲染好，无论宿主侧哪个分支失手，用户都不会看到"未返回可用结果"。
      let terminalStop: { text: string; failure: TerminalFastPathFailure } | null = null;
      // ── 进度帧 / 计划通知的连续重复压制（2026-09-26 真实平台战斗测试实测）──────────
      // worker 在真实调用之后常继续重提执行方案（beforeToolCall 里 activePlan 置空再
      // evaluateAndActivatePlan，后续提交可能 scope 识别失败被拒），每次重提都触发同一帧
      // PLAN_SUBMIT_STEP（"正在向平台提交执行方案…"）与同一条平台计划通知：实测单回合
      // 5-6 帧重复、两条一模一样的通知。生产企微侧 progress 有 4 帧硬顶，重复帧挤占真实
      // 进度帧的预算；重复通知则是直接的用户噪音——同一 worker 回合内用户无法做确认操作，
      // 连续相同文本的通知只可能是重提同一方案的 churn。
      //
      // 语义是**连续重复**（相邻相同即丢弃），不是永久去重：进度流里同一句话中间插过别的
      // 帧，说明 worker 又干了别的事，此时重复文本是合法的新动作（重新查询同一对象、再次
      // 提交同一方案都真实发生过），必须放行——只压"连发两次同一句话"，不压合法重复动作。
      //
      // 两个记忆都是 run() 局部的：每回合独立重置。通知尤其如此——跨回合（新 run）用户
      // 有机会做确认操作，计划门的通知必须在每个新回合重新送达，不能因上一个回合送达过
      // 同样文本就被吞掉。
      let lastStep: string | null = null;
      const stepOnce = (text: string): void => {
        if (text === lastStep) return;
        lastStep = text;
        input.onStep?.(text);
      };
      let lastNotice: string | null = null;
      // 宿主没配 onNotice 时保持 undefined：plan-runtime 里"未配置即暂停执行"的 fail-closed
      // 守卫原样生效——去重层不把"没有通知出口"伪装成"有出口但跳过"（那会让通知未经送达
      // 就放行激活，而通知送达本是激活授权的一部分）。
      const noticeOnce = input.onNotice
        ? async (text: string): Promise<void> => {
          if (text === lastNotice) return;
          lastNotice = text;
          await input.onNotice?.(text);
        }
        : undefined;
      const argSpecs = await operationArgSpecsFor(input.cwd);
      // access 语义表提到 create 调用之前：会话创建与 onAllowedBash 的读类探测计数
      // 要读同一份表（同一个来源，不是第二份派生）。
      const operationSemantics = await operationSemanticsFor(input.cwd);
      const { session, currentPlan, needsClue } = await createPiCodingWorkerSession({
        onPlanSubmitted: (calls) => { plannedCalls = calls; },
        onReadProbe: noteReadProbe,
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        env: options.env,
        operationLabels: await operationLabelsFor(input.cwd),
        operationArgStyles: await operationArgStylesFor(input.cwd),
        // args 规格（positionalNames）：计划覆盖判据要知道哪些位置参数是目标
        // （五审 blocking）。与 label/样式/语义/协议四张表同一手法——工厂已注入的直接用，
        // 没注入才按 cwd 现派生一次。
        ...(argSpecs && argSpecs.size > 0 ? { operationArgSpecs: argSpecs } : {}),
        // access 语义表（计划门拒绝分流的平台数据面）与能力声明（宿主持有）一起进会话：
        // beforeToolCall 里对提交的计划做"该不该进计划"的判读。
        operationSemantics,
        // 能力清单（驱动侧注入优先，缺省由会话派生）：structured_call 的声明来源。
        ...(options.capabilityManifest ? { capabilityManifest: options.capabilityManifest } : {}),
        // gateway（C7b fail-closed）：run 输入显式指定优先，工厂声明兜底——两处都来自
        // profile.gateway（runtime 按任务注入 / 装配按工厂注入）；都未声明时 session 内
        // servePatterns 即抛，宿主不回退任何遗留网关名。
        gateway: input.gateway ?? options.gateway,
        // 协议角色表（提案创建拦截的机械来源）与宿主出口一起进会话。
        operationProtocols: await operationProtocolsFor(input.cwd),
        ...(input.onCreateProposal ? { onCreateProposal: input.onCreateProposal } : {}),
        scratchDir: input.scratchDir,
        // G1 事件 → 审计 + 进度帧：同一条生产接线（createServeGateAuditSink）
        serveGateAudit: createServeGateAuditSink({
          onStep: stepOnce,
          requestId: input.requestId,
          audit: (event) => {
            // 本轮产物清单：write/edit 放行时 detail 即落点路径（门自己的留痕，不另解析）。
            // 与 A1 披露判据的第三个条件同源——"委派产出了文件"由宿主放行留痕说话。
            if (event.allowed && (event.tool === 'write' || event.tool === 'edit') && event.detail) {
              producedFiles.push(event.detail);
            }
            // 任何被放行执行的 bash 都构成执行痕迹（2026-10-18）：首词拦截退役后 worker
            // 会像交互式 Claude 一样直跑 python/cat——纯本地任务的执行全是非网关命令，
            // 不计数的话，回合出口的防伪造检查会把诚实的完成报告当成伪造顶掉（run6 实测）。
            if (event.allowed && event.tool === 'bash') bashRuns += 1;
            options.serveGateAudit?.(event);
          },
          onAllowedBash: (kind, event) => {
            // 分项计数无条件先行：每一次放行恰好计入一个族，分项和恒等于
            // gateCalls。步数帽 wind-down 只当副作用触发一次（第 cap+1 次
            // 送一次 90% 预算点同款 wind-down，后续放行不再重复打断，模型
            // 仍可收尾交已做 + 未做），它的返回值不再 gating 计数。旧逻辑
            // 是两处各错、根因不同：wind-down 门控使 wind-down 那次 local
            // 从 localCalls 丢失；else 分支把非 local 一律计 auxiliary，
            // 使 executor 在非 wind-down 时也被双计。现三分支互斥，两者皆消。
            const next = recordAllowedBashCall(
              { gateCalls, executorCalls, localCalls, auxiliaryCalls },
              kind,
            );
            gateCalls = next.gateCalls;
            executorCalls = next.executorCalls;
            localCalls = next.localCalls;
            auxiliaryCalls = next.auxiliaryCalls;
            // 步数帽失败补发：上一轮 steer 失败留下的 pending 在本次放行时
            // 先补发（不在同一轮内立即重发，避免一次放行连发两次信号/日志）。
            // 补发前先清 pending：成功则保持清除，失败时 stepCapSteer 的
            // catch 会重新置位，待下一次放行再补。跟踪器 latch 已置位，
            // 故补发直接调 steer，不再经跟踪器。
            const pendingSteer = stepCapSteer;
            if (stepCapWindDownPending && pendingSteer) {
              stepCapWindDownPending = false;
              pendingSteer(WORKER_WIND_DOWN_NUDGE);
            }
            fireStepCapWindDown(gateCalls);
            // 读类探测帽：看的是门自己的族名 + 门裁决时已解析的档位（operationTier），
            // 不从 detail 反解析——detail 是截断后的审计展示文本。写类/本地/元数据不计；
            // 被拦下的调用也到不了这里。
            if (isReadClassGatewayCall(kind, event.operationTier)) noteReadProbe();
            // latch 计划身份：只记第一个放行调用的那份。G1 门对 bash 的放行分支以
            // planActive() 为真为前提（serve-gate.ts：无活跃计划即 block），所以"门刚放过
            // 一个 bash"就保证当时有活跃计划，这里 currentPlan() 正常必非空。万一为空
            // （放行不变量被破坏的漏洞），不强行造身份、也不在此绕过——保持 executedPlan
            // 为空，execution() 会退回 currentPlan() 并把 calls 如实报成 gateCalls，
            // "执行发生过"这个事实不因身份空缺被抹掉。
            if (!executedPlan) {
              const active = currentPlan();
              if (active) executedPlan = active;
            }
          },
        }),
        onStep: stepOnce,
        knowledgePaths: input.knowledgePaths,
        sensitivePaths: input.sensitivePaths,
        onNotice: noticeOnce,
        planCliRunner: options.planCliRunner,
        planActivationSecret: options.planActivationSecret ?? options.env.EXECUTION_PLAN_ACTIVATION_SECRET,
        onPendingPlan: (plan) => { pendingPlan = plan; },
        onProposalOutcome: (outcome) => { proposalOutcome = outcome; },
        turnDeclaration: input.turnDeclaration,
        entitySources: input.entitySources,
      });
      // 步数帽 steer 持有者在此指向会话：onAllowedBash 在此之后才被调用。
      // 纪律与墙钟 wind-down 同款（try/catch + 结构化日志，失败不外溢，
      // 不让一次 steer 抛错打断 onAllowedBash / 回合），但失败语义不同：
      // 墙钟失败靠到点 abort + 宿主合成终稿兜底，步数帽失败置 pending，
      // 由 onAllowedBash 在下一次放行时补发（见上）。“只送一次”指成功
      // 送达一次：成功路径上跟踪器 + 本标志均不再重发；失败重试不计入
      // “已送”，直到某次 steer 成功才算送达。
      stepCapSteer = (content: string) => {
        try {
          session.agent.steer({ role: 'user', content, timestamp: Date.now() } as unknown as DriverMessage);
          console.info(JSON.stringify({ event: 'worker_step_cap_wind_down_signaled', requestId: input.requestId, taskId: input.sessionId }));
        } catch (error) {
          stepCapWindDownPending = true;
          console.warn(JSON.stringify({
            event: 'worker_step_cap_wind_down_failed',
            requestId: input.requestId,
            taskId: input.sessionId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }));
        }
      };
      // 读类探测帽的 steer 持有者：同一会话通道、同一条 try/catch 纪律。失败只记日志
      // （帽是一次提示，不是硬预算；不设 pending 补发，避免与步数帽的补发互相穿插）。
      readProbeSteer = (content: string) => {
        try {
          session.agent.steer({ role: 'user', content, timestamp: Date.now() } as unknown as DriverMessage);
          console.info(JSON.stringify({ event: 'worker_read_probe_cap_wind_down_signaled', requestId: input.requestId, taskId: input.sessionId }));
        } catch (error) {
          console.warn(JSON.stringify({
            event: 'worker_read_probe_cap_wind_down_failed',
            requestId: input.requestId,
            taskId: input.sessionId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }));
        }
      };
      const footprint = (): string => `${gateCalls} 次 ${resolveGatewayText(options.gateway)} 调用`;
      // 提案创建拦截的终稿（B 波 B3）：宿主办调平台 create 成功时，本回合以此终结，
      // `text` 是宿主持有的确定性文本——平台 summaryText 原样 + 通用确认行。为什么必须
      // 整体替换而不是让 worker 接着说：用户这一刻需要的是"提案已登记 + 确认码"，worker
      // 的后续叙述只会稀释它；而确认码**只**出现在这段文本里（给 worker 的拦截理由不含码），
      // 所以终稿必须来自这里而不是转录。结构化字段（planFacts/execution）照常带上：
      // 它们是宿主机械事实。
      const proposalReply = async (): Promise<TurnDriverResult | null> => {
        const outcome = proposalOutcome;
        if (!outcome) return null;
        // input.cwd 的窄化在闭包里不保留（上面已抛过空 cwd），这里取一次局部值。
        const workerCwd = input.cwd ?? '';
        const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(workerCwd));
        const proof = execution();
        return {
          text: outcome.userText,
          messages: session.agent.state.messages,
          footprint: footprint(),
          ...(facts ? { planFacts: facts } : {}),
          ...(proof ? { execution: proof } : {}),
          ...(outcome.status === 'completed' ? { proposalCreated: { proposalId: outcome.proposalId } } : {}),
        };
      };
      // 错误态快路径的结果时刻出口（与 proposalReply 同构）：早停 latch 在场时本回合以
      // 宿主合成的话术终结。text 是皮带合成的非空话术；terminalFailure 结构化事实随行
      // （宿主终局分支以它为准终结整轮——"整份答案"判定单一事实源在驱动侧）；execution /
      // planFacts 照常带上（那一次平台调用真发生过、范围是宿主解析的 calls），它们是
      // 宿主机械事实，与文本的来源互不相干。
      const terminalReply = async (): Promise<TurnDriverResult | null> => {
        if (!terminalStop) return null;
        // input.cwd 的窄化在闭包里不保留（进回合时已抛过空 cwd），这里取一次局部值。
        const workerCwd = input.cwd ?? '';
        const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(workerCwd));
        const proof = execution();
        return {
          text: terminalStop.text,
          messages: session.agent.state.messages,
          footprint: footprint(),
          ...(facts ? { planFacts: facts } : {}),
          ...(proof ? { execution: proof } : {}),
          terminalFailure: terminalStop.failure,
        };
      };
      // Host-verifiable proof that this delegated turn really executed against the platform.
      // 判据只有一条：至少一次被放行的网关调用（gateCalls > 0）。
      //
      // 为什么 gateCalls > 0 即充分、不再要求"结果时刻计划仍激活"：G1 门对 bash 的放行
      // 分支以 planActive() 为真为前提（serve-gate.ts：无活跃计划即 block），因此每一个
      // 被计数的调用都发生在"当时有活跃计划"的瞬间——放行本身就是计划活跃的证明。worker
      // 完全可能在真实调用之后继续重提方案并被拒（activePlan 停在上次提交后的 null），但
      // "调用发生过"是既成事实，与回合收尾时计划恰好是什么状态无关。旧实现
      // `plan && gateCalls > 0` 把结果时刻的计划状态当成执行与否的条件，真实调用过后计划
      // 被重置时就误判为空——2026-09-26 实测 A3/A4：search-account-sets / query-receivables
      // 真实 exit 0，回复却是"本轮没有产生任何平台查询"（C25 兜底误发）。
      //
      // 计划身份用放行瞬间 latch 的 executedPlan；latch 为空（门的放行不变量被破坏，理论
      // 不可达）时退回 currentPlan()，再为空则 planId 记 ''、version 记 0——calls 仍如实
      // 报 gateCalls，"执行发生过"这个事实绝不被计划身份的空缺抹掉。
      const execution = (): { planId: string; version: number; calls: number } | undefined => {
        // 任何被放行执行的 bash 都构成执行痕迹（2026-10-18）：首词拦截退役后 worker 会像
        // 交互式 Claude 一样直跑 python/cat——纯本地任务的执行全是非网关命令，只数网关
        // 调用的话，回合出口的防伪造检查会把诚实的完成报告当成伪造顶掉（run6 实测：
        // 106 人契约勾稽全对、真 Excel 已落盘，终稿却被换成"请告诉我要查询的对象"）。
        // 执行发生过就是执行过，与调用的形态无关。
        if (bashRuns <= 0) return undefined;
        const plan = executedPlan ?? currentPlan();
        return { planId: plan?.planId ?? '', version: plan?.version ?? 0, calls: bashRuns };
      };
      // 纠错环（架构 §3）：执行不了就回报"缺什么"。只在**没有执行痕迹**时派生——
      // execution() 为真（≥1 次被放行的调用）即认为执行面跑过，那类回合不缺信息，把已经
      // 取到的结果拖进无谓的追问只会打扰用户。这与"足迹以 gateCalls > 0 为准"是同一语义：
      // 调用发生过就是执行过，与收尾时计划状态无关。修复后真实执行过的回合（哪怕计划随后
      // 被重置）不再派生 needs 线索——执行面跑过的回合确实不缺信息。
      // 两个来源都是确定性的：宿主计划拦截的原因原文、平台 RESULT 信封的错误码。
      const needs = (): SubagentNeeds | undefined => {
        if (execution()) return undefined;
        return needsClue() ?? needsFromPlatformResponses(session.agent.state.messages) ?? undefined;
      };
      // TaskStore remains the source of truth.  Restore its transcript into
      // the SDK Agent rather than persisting a second session file platform-side.
      session.agent.state.messages = input.messages;
      // 本回合新增消息的起点（之后只增不减）：选择类状态只在本回合的平台交互里找——
      // 上一回合遗留的信封不能越权替这一回合提问（早先歧义、用户补全后重查成功的回合
      // 绝不能被旧信封劫持成澄清问句）。
      const initialMessageCount = session.agent.state.messages.length;
      // 结构化歧义/未找到（Stage 3 事故根治包）：本回合的平台交互以"选择类"状态收尾时，
      // 把信封事实挂上结果，由宿主机械组装澄清问题——模型是执行语言与用户语言之间唯一的
      // 翻译器，压力下翻译退化，脚本路径/错误码/门的规则就漏进最终回复（2026-09-27 实测：
      // 1201 字符技术报告）。发音权因此收归宿主：模型只为"数据答案"发声。
      //
      // 判据是**收尾状态**而不是"有没有调用"：目录搜索这类调用真的发生过（gateCalls > 0、
      // execution 为真），但它返回的是"请用户选一个"而不是数据答案。若按"无 execution"
      // 设闸门，实测事故形状（一次 search 调用拿到 ACCOUNT_SET_AMBIGUOUS / NOT_FOUND）
      // 会完全漏装，技术报告照样上屏——那就不是根治。反过来，收尾信封是 completed
      // （数据答案）或其他错误码时一律不挂：那类回合的模型文本是数据答案或既有失败路径，
      // 行为零变化。needs 的闸门保持不变（它产的是"缺什么"，不是"选哪个"）。
      const clarification = (): SelectionClarification | undefined =>
        selectionClarificationFromResponses(session.agent.state.messages.slice(initialMessageCount));
      // 平台登录/凭据类失败事实：本回合平台交互是否以登录/凭据类失败收尾。判据只有平台
      // 错误信封的码（platform-contract 唯一适配层，exit 非零 + 登录族信封码），与
      // clarification 同一边界（只看本回合新增消息）——上一回合遗留的失败信封不会越权
      // 替这一回合报警。真实形态：网关调用 exit 1 + NEEDS_LOGIN/AUTH_* 信封，worker
      // 诚实报告"登录凭据已过期"；宿主把该事实原样上交，不在编排层做冷却记账/逐轮拦截
      // （并发容忍与健康退避归执行层自己的限流/熔断）。
      const authFailureResult = (): { authFailure: PlatformAuthFailure } | Record<string, never> => {
        const failure = platformAuthFailureFromResponses(session.agent.state.messages.slice(initialMessageCount));
        return failure ? { authFailure: failure } : {};
      };
      // ── 错误态快路径：SDK shouldStopAfterTurn 早停装配（v2 皮带）────────────────
      // 手法沿用第一版（SDK 公开字段 + latch + agent_end）：hook 返回 true 时 SDK 在
      // agent_end 之前直接结束循环——worker 不再进入下一轮重规划。四个门全过才停：
      //   门① 整份答案候选：单调用计划（plannedCalls 是本回合宿主解析的 calls，最后
      //      一次提交即执行范围）**且**本跳执行过 ≥1 次放行调用。多调用计划（逐期扫描、
      //      先检索后查）一跳撞终局只是进行中的一步，照旧循环/交还，行为零变化。
      //   门② 收尾信封：本跳 toolResults 的收尾信封命中终局码（同一把"收尾那一条"的尺，
      //      与 clarification/authFailure 同边界）。
      //   门③ 信封完整性（platform-contract 的 terminalFastPathOf）：查询词/取数范围/非空
      //      可改查清单缺一不挂——话术缺了"下一步改查哪"就不是可行动的诚实答案，宁可
      //      回到既有重规划循环。码在集合内而信封不完整时 console.warn 留痕（fail-loud：
      //      契约漂移必须可发现，绝不静默）。
      //   门④ 跳内单信封：SDK 并行执行同一跳的全部 toolCall（agent-loop.js 一条 assistant
      //      消息的所有 toolCall 都执行、toolResults 一起交给本 hook），"整份答案"要求
      //      本跳**只有一条**平台信封——见守卫处的注释。
      // 命中即 latch 话术并返回 true；结果时刻（含补刀/超时/异常各出口）由 terminalReply
      // 统一取用。等确认门（pendingPlan）与提案拦截（proposalOutcome）在场的回合不快转：
      // 那两条已有自己的收尾管道。
      session.agent.shouldStopAfterTurn = (turn) => {
        if (terminalStop) return true;
        if (pendingPlan || proposalOutcome || gateCalls === 0 || plannedCalls.length !== 1) return false;
        const envelope = closingEnvelopeOfToolResults(turn.toolResults);
        if (!envelope) return false;
        const failure = terminalFastPathOf(envelope);
        if (!failure) {
          const code = envelope.error?.code ?? '';
          if (TERMINAL_FAST_PATH_CODES.has(code)) {
            console.warn(JSON.stringify({ event: 'terminal_fast_path_envelope_incomplete', code, status: envelope.status, requestId: input.requestId, taskId: input.sessionId }));
          }
          return false;
        }
        // 门④ 跳内多信封守卫（latch 前的最后一道）：本跳出现不止一条平台信封时，"收尾
        // 信封 = 整份答案"的前提不成立——worker 完全可以同一跳先拿到一条 completed 数据
        // 信封、收尾再撞一条终局信封（只数计划调用数抓不到这个形状），宿主若仍用收尾信封
        // 合成话术终结，同跳已取得的 completed 数据就被静默丢弃，任务记 done——那正是
        // 快路径要消灭的"单一信封冒充整份答案"事故类别。宿主也绝不自己把 completed 数据
        // 与终局话术拼成回答（那是数据结论，越 L3 线）：回落既有循环，由模型汇总后发声。
        const envelopeCount = countEnvelopesOfToolResults(turn.toolResults);
        if (envelopeCount > 1) {
          console.info(JSON.stringify({ event: 'terminal_fast_path_skip_multi_envelope', envelopes: envelopeCount, requestId: input.requestId, taskId: input.sessionId }));
          return false;
        }
        // 皮带：话术在 latch 时刻合成，text 永不为空（第一版死因见 terminalStop 声明处）。
        terminalStop = { text: renderTerminalFailureReply(failure), failure };
        console.info(JSON.stringify({ event: 'deterministic_fast_path_stop', code: failure.code, requestId: input.requestId, taskId: input.sessionId }));
        return true;
      };
      const remaining = input.deadline - Date.now();
      // A1 披露：离开本回合时判定一次"整轮只有本地执行却产出了文件"。
      // 为什么放在这里与下方 finally 两处（而不是每个 return 前）：run() 的出口有五六条
      // （超时/取消/补刀后收尾/异常/正常），漏挂任何一条都是静默不披露——那正是本次要
      // 消灭的事故形态。finally 覆盖 try 内的全部出口，这里只补 try 之前那条"进回合就没
      // 预算了"的早退；两个调用点都是"离开 run()"，判定本身只有一份。
      const reportExecutorBypass = (): void => {
        if (!platformExecutorBypassed({ localCalls, executorCalls, producedFiles })) return;
        try {
          options.onExecutorBypassed?.({
            requestId: input.requestId ?? '',
            taskId: input.sessionId ?? '',
            localCalls,
            planGateCalls: executorCalls,
            auxiliaryCalls,
            producedFiles: [...producedFiles],
          });
        } catch {
          // 告警出口故障不得影响回合结果（与 G1 门"审计故障不影响裁决"同纪律）：
          // 披露是增强不是门，出口挂了只是这一条没留下痕。
        }
      };
      if (remaining <= 0) {
        const messages = session.agent.state.messages;
        session.dispose();
        reportExecutorBypass();
        return { text: '', messages };
      }
      let timedOut = false;
      let cancelled = input.signal?.aborted === true;
      const cancel = () => {
        cancelled = true;
        void session.agent.abort();
      };
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (cancelled) cancel();
      const abortTimer = setTimeout(() => {
        timedOut = true;
        session.agent.abort();
      }, Math.max(1, remaining));
      // 墙钟收尾信号（"失败必达"路径 1 前半段）：预算 90% 处经 SDK steer 通道注入一条
      // user 消息（WORKER_WIND_DOWN_NUDGE），给 worker 剩余 10% 自行收尾。latch 一次；
      // 信号已发过就不再补发（绝不在同一回合反复推同一个模型，与补一刀同纪律）。
      let windDownSent = false;
      const windDownTimer = setTimeout(() => {
        windDownSent = true;
        try {
          session.agent.steer({
            role: 'user',
            content: WORKER_WIND_DOWN_NUDGE,
            timestamp: Date.now(),
          } as unknown as DriverMessage);
          console.info(JSON.stringify({ event: 'worker_wind_down_signaled', requestId: input.requestId, taskId: input.sessionId }));
        } catch (error) {
          // 信号失败不外溢：到点 abort 照旧兜底，宿主合成终稿的路径不受影响。
          console.warn(JSON.stringify({
            event: 'worker_wind_down_failed',
            requestId: input.requestId,
            taskId: input.sessionId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }));
        }
      }, windDownDelayMs(remaining));
      // SDK 会话事件（tool_execution_start / agent_start / agent_end）是内部协议名，
      // 一律不当进度帧外发：用户可见的进度只由 G1 放行事件经 label 驱动产生。
      // ── 模型瞬时失败：观测（C1）+ 有界重试（C2，波次C 2026-11-01）────────────────
      // 事故链：pi-agent-core 的 agent-loop 遇 stopReason=error 正常 return 不抛异常，
      // 只把 errorMessage 留在 agent.state——原先它在这里被 `timedOut || cancelled ||
      // state.errorMessage` 分支的空文本返回整段吞掉（零日志），宿主只见"空文本"。现在：
      //   · 每次命中发 worker_model_stream_error 结构化日志（真实错误全文进日志——
      //     DB 的 worker_messages 里它一直活着，宿主侧日志却一个字没有）；
      //   · 可重试（pi-ai 判据，见 retryableModelError）则原地重试：剥掉结尾的 error
      //     assistant 消息（SDK _prepareRetry 同款——不剥的话 continue() 会拒绝从
      //     assistant 消息续跑）→ 等待 → 再 continue()。模型调用无副作用，幂等安全；
      //   · 超时/取消**不重试**：那两条是宿主自己的收尾事实（abortTimer/用户 signal），
      //     此刻的模型错误只是 abort 的表征，重试等于跟自己的计时器作对。先后关系
      //     与既有分支一致（timedOut/cancelled 判定先于一切模型侧收尾）。
      // 重试的回合里 worker 可能执行新的工具调用（提案/终局 latch 照常由下方的
      // proposalReply/terminalReply 出口取用——它们在 continue() 返回后统一裁决）。
      const retryableModelError = (errorMessage: string): boolean =>
        isRetryableAssistantError({ stopReason: 'error', errorMessage } as Parameters<typeof isRetryableAssistantError>[0]);
      const runAgentTurn = async (): Promise<void> => {
        const delays = options.modelRetryDelaysMs ?? DEFAULT_MODEL_RETRY_DELAYS_MS;
        let retryStartedAt = 0;
        for (let attempt = 0; ; attempt += 1) {
          await session.agent.continue();
          if (timedOut || cancelled) return;
          const errorMessage = session.agent.state.errorMessage;
          if (!errorMessage) {
            if (attempt > 0) {
              console.info(JSON.stringify({
                event: 'worker_model_retry_recovered',
                requestId: input.requestId,
                taskId: input.sessionId,
                attempt,
                durationMs: Date.now() - retryStartedAt,
              }));
            }
            return;
          }
          if (attempt === 0) retryStartedAt = Date.now();
          console.error(JSON.stringify({
            event: 'worker_model_stream_error',
            requestId: input.requestId,
            taskId: input.sessionId,
            stopReason: 'error',
            errorMessage,
            attempt: attempt + 1,
          }));
          if (attempt >= delays.length || !retryableModelError(errorMessage)) return;
          // SDK _prepareRetry 同款剥除：结尾的 error assistant 消息出转录再续跑
          // （continue() 只认 user/toolResult 结尾）。
          const messages = session.agent.state.messages;
          const last = messages[messages.length - 1];
          if (messages.length > 0 && (last as { role?: string } | undefined)?.role === 'assistant') {
            session.agent.state.messages = messages.slice(0, -1);
          }
          await new Promise((resolve) => { setTimeout(resolve, delays[attempt]); });
          // 等待途中撞上超时/取消（abortTimer 仍在计时）：不再推模型，按收尾事实返回。
          if (timedOut || cancelled) return;
        }
      };
      try {
        // The current ContextTaskRunner already appends the current user
        // message to input.messages. Calling the underlying Agent avoids
        // duplicating it through AgentSession.prompt().
        await runAgentTurn();
        // 提案创建拦截成功（B 波 B3）：本回合以此终结——先于超时/取消/补刀等一切收尾检查。
        // 提案登记是既成事实（平台侧已有提案、宿主已建意图条目），worker 之后说了什么、
        // 这一轮是否超时都不改变它；用户要的是确认码，不是后续叙述。
        const settled = await proposalReply();
        if (settled) return settled;
        // 错误态快路径：早停 latch 在场即以宿主话术终结（先于超时/取消检查——终局信封
        // 是本跳的真实收尾，文本已在手，不因计时器竞态丢失）。
        const terminal = await terminalReply();
        if (terminal) return terminal;
        if (timedOut || cancelled || session.agent.state.errorMessage) {
          const proof = execution();
          const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
          // C1 透传：模型侧失败事实（非超时/取消——那两条是宿主自己的收尾事实，取消时
          // agent.state 里残留的 errorMessage 是中止的伴生物不是模型故障）随结果上交，
          // 宿主据此分类 model_transient，不再只看得到空文本。
          const modelError = timedOut || cancelled ? undefined : session.agent.state.errorMessage; // MUTATION-F
          return { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...(modelError ? { modelError } : {}), ...authFailureResult() };
        }
        // P1 收尾兜底：方案已批准、计划通知已送达，worker 却零平台调用就收手。每回合最多补
        // 一刀（activatedPlanNudged 是 run() 内的局部标志，边界理由见其声明处）——追问无效
        // 就如实上报 activatedPlan，由宿主把真实状态说给用户；绝不在同一回合里反复推同一个
        // 模型。等用户确认门（pendingPlan）不补：那一步本来就停在"等确认"，不是执行面断裂。
        if (!activatedPlanNudged && !pendingPlan && gateCalls === 0 && currentPlan() !== null) {
          activatedPlanNudged = true;
          // 消息形状与宿主注入本轮用户消息时完全一致（role / content / timestamp 三个键），
          // 转录里既有 user 消息就是这个形状，SDK 的消息转换因此走同一条路。
          session.agent.state.messages.push({
            role: 'user',
            content: PLAN_ACTIVATED_NUDGE,
            timestamp: Date.now(),
          } as unknown as DriverMessage);
          // 沿用现有 abortTimer/deadline：这一轮若超时/取消，按上面的 timedOut/cancelled 路径返回
          try {
            await runAgentTurn();
          } catch (error) {
            // 追问这一轮自己失败（网络/模型抖动）不吞掉事实：仍然走下面的结果计算，
            // 由 activatedPlan 把"批准了没执行"交还宿主——用户看到的不是笼统的失败话术。
            console.error(JSON.stringify({
              event: 'pi_coding_worker_error',
              stage: 'activated_plan_nudge',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }));
          }
          if (timedOut || cancelled || session.agent.state.errorMessage) {
            const proof = execution();
            const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
            // 补刀那一跳若撞上终局早停，话术已 latch——先于超时/取消检查交还（同上）。
            const terminalAfterNudge = await terminalReply();
            if (terminalAfterNudge) return terminalAfterNudge;
            // C1 透传（与上方非补刀出口同一把尺）：模型侧失败事实上交宿主分类；
            // 超时/取消同样不透传（取消伴生的 errorMessage 不是模型故障）。
            const modelError = timedOut || cancelled ? undefined : session.agent.state.errorMessage; // MUTATION-F
            return { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...(modelError ? { modelError } : {}), ...authFailureResult() };
          }
        }
        const proof = execution();
        const clue = needs();
        const plan = currentPlan();
        const choice = clarification();
        const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
        // 补刀后拦截成功也要发声（提案可能在补刀轮才抵达）：与上面同一个理由——
        // 确认码只在这段文本里。恒为 null 时走原有收尾，行为一字不变。
        const settledAfterNudge = await proposalReply();
        // 补刀那一跳撞上终局早停同理：宿主话术先于普通收尾（普通收尾的
        // lastAssistantText 在早停后必为空串——那正是第一版死因的形状）。
        const terminalAfterNudge = await terminalReply();
        return terminalAfterNudge ?? settledAfterNudge ?? {
          text: lastAssistantText(session.agent.state.messages),
          messages: session.agent.state.messages,
          footprint: footprint(),
          ...(facts ? { planFacts: facts } : {}),
          ...(proof ? { execution: proof } : {}),
          // 补刀后仍是"计划激活 + 零调用"：执行闭环断裂的事实，交给宿主说清状态。
          // 与 execution 互斥：proof 为真当且仅当 gateCalls > 0（见 execution()），此时
          // `!proof` 为假，本分支必然不进——真实执行过的回合（哪怕计划随后被重置、currentPlan()
          // 已为 null）带 execution 而不带 activatedPlan。activatedPlan 只在零调用且计划仍激活
          // 时出现，"批准了但没执行"这个事实因此不会被 execution 稀释或重复上报。
          ...(!proof && plan ? { activatedPlan: { planId: plan.planId, version: plan.version } } : {}),
          ...(pendingPlan ? { pendingPlan } : {}),
          ...(clue ? { needs: clue } : {}),
          ...(choice ? { clarification: choice } : {}),
          // 平台登录/凭据类失败事实：登录/凭据类失败的回合照样可能有执行痕迹（那次失败
          // 的网关调用真发生过），所以本字段与 execution 并列挂载，不互相替代。
          ...authFailureResult(),
        };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_coding_worker_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        const proof = execution();
        const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
        // 异常出口也要让拦截成功的提案发声：提案已登记是既成事实，会话随后抛什么不改变它，
        // 而确认码只在这段文本里——丢了用户就永远拿不到码。终局早停同理（防御性：stop
        // 之后循环正常返回，正常不进 catch，但 latch 一旦在场就是真实收尾）。
        const settledAfterError = await proposalReply() ?? await terminalReply();
        return settledAfterError ?? { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...authFailureResult() };
      } finally {
        clearTimeout(abortTimer);
        // 收尾信号计时器与 abort 计时器同命运：回合已收尾（含正常完成）就不再注入——
        // steer 队列残留会让下一回合凭空多出一条收尾指令。
        clearTimeout(windDownTimer);
        input.signal?.removeEventListener('abort', cancel);
        session.dispose();
        // A1 披露（只告警、不改回合结果）：上面每个 return 之前都不必记得调它——finally
        // 覆盖 try 内全部出口，超时/取消/异常/正常收尾一视同仁。
        reportExecutorBypass();
      }
    },
  };
}

/**
 * Public only for integration tests and future worker composition.  This is
 * the one place where pi-coding-agent is configured for a context worker.
 */
/**
 * bash 溢出快照归位（A2A 文件通道，P9）：SDK 把超限全量输出写到 /tmp/pi-bash-<id>.log
 * （工作区外，read 不可及——截断的"逃生通道"由此形同虚设，2026-10-18 run5 实测 worker
 * 的吸收脚本两度被拒后放弃）。这里在结果交还模型之前把它搬进本轮工作区的 .outputs/，
 * 并把 content/details 里的旧路径改写为新路径——模型与后续轮次看到的都是工作区内路径。
 *
 * 失败语义：搬移失败（权限/跨盘复制失败等）不阻断、不改写——快照留在原位，行为与
 * 改造前一致。工具名非 bash、无 scratchDir、结果无溢出路径时零操作。
 */
export function relocateBashSnapshotIntoWorkspace(
  toolName: string | undefined,
  result: { content?: unknown; details?: unknown } | undefined,
  scratchDir: string | undefined,
  cwd: string,
): { content?: unknown; details?: unknown } | null {
  if (toolName !== 'bash' || !scratchDir || !result) return null;
  const details = (result.details ?? null) as { fullOutputPath?: unknown } | null;
  const src = typeof details?.fullOutputPath === 'string' && path.isAbsolute(details.fullOutputPath)
    ? details.fullOutputPath
    : undefined;
  if (!src) return null;
  try {
    const outDir = path.join(cwd, scratchDir, '.outputs');
    mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, path.basename(src));
    try {
      renameSync(src, dest);
    } catch {
      // 跨文件系统 rename 会 EXDEV：退化为复制 + 删源
      copyFileSync(src, dest);
      rmSync(src, { force: true });
    }
    const rewriteText = (text: string): string => text.split(src).join(dest);
    const content = Array.isArray(result.content)
      ? result.content.map((block) => {
          const b = block as { type?: string; text?: string };
          return b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: rewriteText(b.text) } : block;
        })
      : result.content;
    const detailsOut = details && typeof details === 'object' ? { ...details, fullOutputPath: dest } : details;
    return { content, details: detailsOut };
  } catch {
    return null;
  }
}

export async function createPiCodingWorkerSession(options: PiCodingWorkerSessionOptions): Promise<PiCodingWorkerSession> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    // 只认显式 skillRoots（.agents/skills-serve）；关闭 cwd/.agents/skills 默认
    // 发现，建造技能对运行 agent 不可见——法域的知识面由挂载声明决定。
    noSkills: true,
    additionalSkillPaths: [...options.skillRoots],
    systemPrompt: options.systemPrompt,
    noExtensions: true,
    noContextFiles: true,
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(options.cwd, { id: options.sessionId });
  /**
   * 本会话的激活计划：身份 + **这份计划的 calls**（宿主自己从 worker 提交的那份解析出来，
   * 平台 evaluate 的 `delta.calls` 与之同源）。
   *
   * 为什么要带 calls：serve-gate 的计划前置对写类调用问的是"覆不覆盖"，而覆盖判据的
   * 唯一事实来源就是激活时提交的 calls（`planGateVerdict`）。旧形态只存 planId/version，
   * 门因此只能问"有没有计划"——计划里全是读、写照样调通，数据落地而用户从未确认
   * （2026-11-08 修的根因）。宿主不另去读平台的 plans.json：那份是执行层的状态，宿主
   * 已经持有同一份内容的解析结果，再读一遍就是第二份真相。
   *
   * 恢复的会话：`loadCurrentActivePlan` 只从平台拿回 planId/version（平台 `plan current`
   * 不下发 calls），于是 calls = 空数组 = **不知道这份计划覆盖什么**。写类调用在此状态
   * 下一律被门拒（fail-closed：宁多拦，不放松），直到本会话重新提交并激活一份计划。
   */
  let activePlan: { planId: string; version: number; calls: readonly PlanCall[] } | null = null;
  /**
   * **自上次计划成功激活以来**的提交次数（收敛保护，防 worker 反复重提空转整回合）。
   *
   * D-099：原注释写"同任务内计划被拒次数"，实现却对**每一跳通过形状解析与写关闭检查的
   * 提交**自增——`PLAN ACTIVE`（成功激活）与 `PLAN PAUSED`（CLI 失败）同样计数，且成功后
   * 不归零。于是它数的是提交次数，消息却说"已被连续拒绝 N 次"。2026-10-15 acceptance 8.1
   * 实证：终局落在第 6 次提交上，而前 5 次里 3 次是 active、1 次 paused、只有 1 次是真拒绝；
   * 第 6 次本身合法的方案（实体已由平台响应确立）没走到实体校验就被挡掉，worker 只能回头
   * 向用户要已经给过的信息。
   *
   * 现在两件事各自归位：① 只有 `PLAN ACTIVE` 那一支归零——熔断器只放松在确凿成功上，
   * 不放松到"没报错就算"；越权拒绝 / CLI 失败 / 平台拒绝照旧计数，那一维没有放松。
   * ② 消息如实陈述这个数的含义（见 error-codes.ts 的 DECLINED_PLAN_LIMIT），不把提交
   * 次数伪装成拒绝次数。
   *
   * 作用域（2026-10-23 Round 1 review 登记，行为不改只登记）：计数器声明在本工厂内，
   * 每个 worker 会话（每次委派）新建即重置——不是"每任务"。任务级上界 = 上限 × 委派
   * 轮次，轮次另由 turn-state 的 MAX_NEEDS_ROUNDS / MAX_PLAN_ZERO_EXEC_STEPS 兜底；
   * 常量名 MAX_DECLINED_PLANS_PER_TASK 的 PER_TASK 是历史口径，语义以本注释与调用点
   * 为准（同 error-codes.ts 对该码名"名字是历史"的声明）。
   */
  let declinedPlans = 0;
  if (options.sessionId) {
    try {
      const resumed = await loadCurrentActivePlan({
        platformRoot: options.cwd,
        taskId: options.sessionId,
        runCli: options.planCliRunner,
        // gateway 穿线（C7b 漏穿补课）：本会话的 gateway 与 serve-gate / plan 解析同一份
        // （input.gateway ?? 工厂声明），漏传则默认 runner spawn 前 fail-closed 抛错。
        ...(options.gateway ? { gateway: options.gateway } : {}),
      });
      // calls 留空：平台 plan current 只回身份，不回计划内容（见 activePlan 注释）——
      // 写类调用在恢复态下拿不到覆盖判据，由门 fail-closed 拒到本会话重新激活计划为止。
      activePlan = resumed ? { ...resumed, calls: [] } : null;
    } catch {
      // Fail closed; resumed queries remain blocked until the worker obtains a host-approved plan.
      activePlan = null;
    }
  }
  const activePlanId = (): string | null => activePlan?.planId ?? null;
  /**
   * T6 任务级预算账本（2026-11-11）：本会话（= 本任务的一次委派）里已被激活计划的 estimate
   * 累计，进 confirm / stop 档时在提交处兜住确认门（plan-runtime 的 taskBudgetUsage）。
   *
   * 为什么在会话里累计而不是另存一份跨回合账本：任务的跨回合累计账本是平台的（AGENTS.md：
   * 累计账本仍在执行层，迁移通用策略前不得先删平台门），宿主再造第二份就是第二份真相。
   * 本账本只覆盖"一次委派内被切片绕过"这一形态——今天 D2 两臂正是如此（3 call / 6 call
   * 两张计划各自都在确认线以下，任务总重量 18 call 却一路放行，确认门一次没到）。
   */
  let taskBudgetLedger = emptyTaskBudgetLedger();
  // label 表（平台清单第 5 列）：驱动侧已缓存则直接传入，否则本会话派生一次。
  // 派生失败/平台还没给这一列 → 空表 → 零进度帧（安全缺省，不外泄脚本名）。
  // gateway 穿线（C7b 收口补漏）：loader 对未声明 gateway 一律降级空表，声明来自
  // profile.gateway 注入，本层不持实例名缺省。
  const operationLabels = options.operationLabels ?? (await loadOperationLabels(options.cwd, options.gateway));
  // args 规格（flag → 样式）：放行的平台调用才有人类可读参数摘要，规格同样只在
  // 放行分支消费。派生失败/旧版平台 → 空表 → 零参数摘要（安全缺省，不外泄、不猜）。
  const operationArgStyles = options.operationArgStyles ?? (await loadOperationArgStyles(options.cwd, options.gateway));
  // access 语义表（平台 `operation list --json` 的 access 列 × 顶层 accessSemantics 表）：
  // 写关闭前置判定（D-075）与计划门拒绝分流的机械来源。派生失败/平台还没下发这张表 →
  // 空表 → 前置判定不生效（宁缺勿猜，平台计划门与提案路径的既有拒绝照旧兜底），
  // 绝不回退到宿主硬编码 operation 名单或 access 词表。
  const operationSemantics = options.operationSemantics ?? (await loadOperationSemantics(options.cwd, options.gateway));
  // args 规格（positionalNames / flagStyles）：计划覆盖判据据此知道哪些位置参数是目标
  // （2026-11-09 五审 blocking：只看 flag 会让以位置参数声明目标的执行层失去写授权范围
  // 保护）。派生失败/平台没下发 → 空表 → 计划步带位置参数时不判定覆盖（fail-closed）。
  const operationArgSpecs = options.operationArgSpecs ?? (await loadOperationArgSpecs(options.cwd, options.gateway));
  // 协议角色表（平台 `operation list --json` 的 protocol 列）：提案创建拦截的机械来源
  // （B 波 B3）。派生失败/平台还没下发这一列 → 空表 → 不拦截（fail-closed 到"这不是提案
  // 调用"），worker 的命令落回 serve 门，由门与平台继续裁决。
  const operationProtocols = options.operationProtocols ?? (await loadOperationProtocols(options.cwd, options.gateway));
  // 能力清单（执行层 `operation list --json` 的投影）：结构化调用通道的声明来源（C6）。
  // 派生失败/平台还没下发这张表 → 空表 → structured_call 一律 fail-closed（清单没有的
  // operation 视为不存在），绝不回退到宿主硬编码名单。
  const capabilityManifest = options.capabilityManifest ?? (await loadCapabilityManifest(options.cwd, options.gateway));
  /**
   * 执行模式词汇（平台 `operation list --json` 每行 serve 矩阵的并集，operation-labels
   * 的 serveModesOf 派生）：serve-gate 的 executor 形态识别与驱动层 T5 对账共用同一份
   * 词汇——宿主不另立第二份 mode 名单（②），平台加/改 mode 时两侧同时看得见。
   *
   * 清单拿不到 / 平台没声明任何 serve 键 → 空集 = 判据不成立：不注入，门退回契约兜底
   * 词汇（历史三个 mode 仍进计划门；词汇外形态一律 fail-closed，兜底不放宽任何调用）。
   */
  const serveModes = capabilityManifest ? [...serveModesOf(capabilityManifest)] : [];
  // 纠错环线索：宿主在本任务里确定性拒绝过的计划（实体不在三个来源里）。
  // 原因原文就是事实，交给 Main Agent 决定是向用户澄清还是重新派单；
  // 只在此处留痕，绝不扫描 worker 的自然语言回复。
  const needsClues: SubagentNeeds[] = [];
  /**
   * 本会话内被宿主拦下的 toolCallId（D-086）。SDK 把 `{block:true,reason}` 变成一条
   * `isError:true` 的 tool_result 原样落进转录，而那条正文是**宿主写的拒绝理由**、可能逐字
   * 带着 worker 刚提交的越权 token。把它收进 haystack，"先故意提一个越权实体、拿到拒绝理由、
   * 再原样提一次"就能过实体门（2026-10-14 实证：改前这一跳确实放行）。
   *
   * 按**身份**记，不按 `isError`（平台 CLI exit 3 的真错误信封同样是 isError:true，按它过滤
   * 会把真证据一起删掉、制造新假拒）、也不按文案前缀（那是从结果原文嗅探语义，且名单要跟着
   * 每个新裁决增长）。beforeToolCall 抛异常的那一跳同样记：SDK 把异常消息也转成 tool_result，
   * 正文一样可能带 token。
   */
  const blockedToolCallIds = new Set<string>();
  /**
   * 本任务的平台响应账本（D-085）：宿主在 afterToolCall 上记下每一条**执行完**的工具结果。
   *
   * 为什么不能只读转录：SDK 默认开自动压缩，阈值 = contextWindow − reserveTokens，一到就把
   * `agent.state.messages` 换成 `[压缩摘要] + [保留尾段]`，早期 tool_result 整条消失
   * （keepRecentTokens 只有约 80KB）。单请求 87 次 tool_call 的长任务必然触发，只读转录
   * 等于把"本任务迄今"偷偷换成"压缩后还剩多少"。
   *
   * 顺带第二道保证：SDK 不给被拦下的调用调 afterToolCall，所以这个通道结构上不可能含宿主
   * 拒绝文本（D-086 的兜底）。
   */
  const platformRecorder = createTaskPlatformRecorder();
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelConfig.runtime,
    model: options.modelConfig.model,
    ...(options.modelConfig.thinkingLevel ? { thinkingLevel: options.modelConfig.thinkingLevel } : {}),
    resourceLoader: loader,
    sessionManager,
    // Native SDK tools are intentionally owned by this Worker driver.
    // 无 grep/find：代码扫描失去工具入口（知识面经 read 白名单可达）。
    // ── worker 的工具面 ────────────────────────────────────────────────────────
    // 2026-10-07 加 'write'：worker 与 coding agent 的本质差别只是"审计更多、权限更窄"，
    // 不是"更笨"。此前只有 read/ls/bash 且 bash 禁重定向，于是 worker 产出的中间产物
    // （契约、mapping、适配某张表的抽取脚本）只能塞进回复文本、再由宿主持盘——那等于逼着
    // 宿主为每种产物写一条 protocol，而宿主本不该懂业务。
    // 放开的边界全在 serve-gate 的 write 分支里：只准写 <platformRoot>/tmp/、禁敏感路径、
    // 有体积上限。tmp/ 是 gitignore 的草稿空间，平台自己的执行器也往那儿写 fallback 产物
    // （transform.py 的 `tmp/整理好的…（自动）.xlsx`），所以这不是新开的先例。
    // 2026-10-08 加 'edit'：实测 worker 写了一个 11KB 的解析脚本，崩在 KeyError（上游
    // 缺某个键），它只想改一行——但没有 edit 工具（原话 "No edit tool"），而 bash 门只准
    // 网关 CLI 调用（bin/<gateway>），用不了 sed。于是只能整份重写那 11KB：33 秒模型生成。
    // 而"写 11KB 脚本一次就对"不现实，这类"改一行"的迭代必然反复发生，每次都付 33 秒、
    // 每次还可能引入新错。edit 是精确文本替换，一次替换即改完那一处。
    // 边界与 write 完全同一组（serve-gate 的 decideFileWrite 一份判据）：只准
    // tmp/<requestId>/、禁敏感路径、有体积上限——加工具不等于放写入面。
    tools: [...WORKER_TOOLS],
    customTools: [
      createBashToolDefinition(options.cwd, {
        spawnHook: (context) => ({ ...context, env: createPlanScopedWorkerEnv(context.env, activePlanId()) }),
      }) as never,
      {
        name: 'structured_call',
        label: 'Structured Call',
        description: 'Make a typed platform call (operation + structured args). The host validates the operation against the capability manifest before execution.',
        parameters: Type.Object({
          operation: Type.String({ description: 'Target operation registered name' }),
          args: Type.Record(Type.String(), Type.Any(), { description: 'Structured parameters (opaque to host; shape defined by execution layer schema)' }),
        }),
        execute: async (toolCallId: string, params: { operation: string; args: Record<string, unknown> }, signal: AbortSignal | undefined, onUpdate: ((details: unknown) => void) | undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> => {
          if (!options.gateway) {
            return {
              content: [{ type: 'text', text: 'STRUCTURED_CALL REFUSED：gateway not configured' } as TextContent],
              details: { error: 'gateway_not_configured' },
            };
          }
          const cli = gatewayExecPathForProfile(ctx.cwd, options);
          const call: StructuredCall = { operation: params.operation, args: params.args };
          const scratchDir = options.scratchDir ? path.join(ctx.cwd, options.scratchDir) : path.join(ctx.cwd, 'tmp');
          mkdirSync(scratchDir, { recursive: true });
          const tempFile = path.join(scratchDir, `structured_call_${toolCallId}.json`);
          writeFileSync(tempFile, JSON.stringify(call));
          const env = createPlanScopedWorkerEnv(options.env ?? process.env, activePlanId());
          const fallbackLogPath = path.join(ctx.cwd, '.runtime', 'a2a-cutover.jsonl');

          const spawnGateway = (args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> => {
            return new Promise((resolve) => {
              const child = spawn(cli, args, {
                cwd: ctx.cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              const timer = setTimeout(() => {
                child.kill('SIGTERM');
                resolve({ stdout: '', stderr: 'timeout', code: null });
              }, 30000);
              const stdout: Buffer[] = [];
              const stderr: Buffer[] = [];
              child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
              child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
              child.once('error', () => {
                clearTimeout(timer);
                resolve({ stdout: '', stderr: 'spawn_error', code: null });
              });
              child.once('close', (code: number | null) => {
                clearTimeout(timer);
                resolve({ stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim(), code });
              });
              signal?.addEventListener('abort', () => {
                child.kill('SIGTERM');
                resolve({ stdout: '', stderr: 'aborted', code: null });
              }, { once: true });
            });
          };

          const parseResult = (stdout: string): { text: string; envelope: PlatformEnvelope | null } => {
            const envelope = parseEnvelope(stdout);
            if (envelope) {
              return { text: ((envelope.data as Record<string, unknown> | null)?.summaryText ?? (envelope.data as Record<string, unknown> | null)?.result ?? stdout) as string, envelope };
            }
            return { text: stdout, envelope: null };
          };

          const logFallback = (): void => {
            try {
              mkdirSync(path.dirname(fallbackLogPath), { recursive: true });
              appendFileSync(fallbackLogPath, JSON.stringify({
                protocolVersion: A2A_PROTOCOL_VERSION,
                domain: params.operation,
                corpusVersion: capabilityManifest?.version ?? 'unknown',
                fallback: true,
                timestamp: new Date().toISOString(),
              }) + '\n');
            } catch {
              // best-effort
            }
          };

          return new Promise((resolve) => {
            let settled = false;
            const settle = (result: AgentToolResult<unknown>) => {
              if (settled) return;
              settled = true;
              resolve(result);
            };

            (async () => {
              const newResult = await spawnGateway(['call', '--file', tempFile]);
              if (newResult.code === 0 && newResult.stdout) {
                const { text, envelope } = parseResult(newResult.stdout);
                settle({ content: [{ type: 'text', text } as TextContent], details: { operation: call.operation, exitCode: newResult.code, envelope, fallback: false } });
                return;
              }

              const oldResult = await spawnGateway(['operation', 'run', params.operation, tempFile]);
              if (oldResult.code === 0 && oldResult.stdout) {
                const { text, envelope } = parseResult(oldResult.stdout);
                logFallback();
                settle({ content: [{ type: 'text', text } as TextContent], details: { operation: call.operation, exitCode: oldResult.code, envelope, fallback: true } });
                return;
              }

              settle({
                content: [{ type: 'text', text: `STRUCTURED_CALL FAILED：${call.operation}\n新路径（exit ${newResult.code}）：${newResult.stderr || newResult.stdout}\n旧路径（exit ${oldResult.code}）：${oldResult.stderr || oldResult.stdout}` } as TextContent],
                details: { error: 'call_failed', operation: call.operation, newPathCode: newResult.code, fallbackCode: oldResult.code },
              });
            })();
          });
        },
      } as never,
    ],
  });
  // G1 工具门：首条 bash 须为网关 plan（方案定价+预算），bash 仅许网关调用，
  // read/ls 限知识面；放行与拦截都留痕。platformRoot 用于派生能力清单定价。
  // label 表（平台清单第 5 列）在此传入：放行的平台调用才有人类可读进度帧。
  // access 语义表同样在此传入：计划前置三级判据的机械来源——"这个调用要不要过计划门、
  // 过了之后还要不要被计划覆盖"读平台语义表的 plan/confirm 两列，与计划拒绝分流
  // （nonPlannableOperations）同一份表、同一个来源，不存在第二份真相。表由本会话上方
  // 加载一次（失败/平台未下发 = 空表 = 一律照旧要求计划，fail-closed），门内部不再自己
  // spawn 平台 CLI。
  /**
   * T5 的拒收必须只留拒收记录：门在放行时**立即**上报 `allowed:true`，而执行前对账在门
   * 返回之后才判范围。若直接落账，一次被 T5 拒掉的调用会同时留下"放行"与"拒收"两行，
   * 审计读起来像执行过。缓冲区把门的这一跳事件扣到对账裁决之后：T5 放行才落账，T5 拒收
   * 只落拒收行（见 decideToolCall）。
   */
  let bufferedGateEvents: ServeGateEvent[] | null = null;
  const gate = createServeGate({
    onEvent: (event) => {
      const withRequest = { ...event, requestId: options.requestId };
      if (bufferedGateEvents) {
        bufferedGateEvents.push(withRequest);
        return;
      }
      options.serveGateAudit?.(withRequest);
    },
    platformRoot: options.cwd,
    operationLabels,
    operationArgStyles,
    operationSemantics,
    // 执行模式词汇（平台 serve 矩阵派生）：门据此认识 `<网关> <mode> <脚本>` 的形态；
    // 空集 = 平台没声明 → 不注入，门退回契约兜底词汇（见上一段注释）。
    ...(serveModes.length > 0 ? { serveModes } : {}),
    ...(operationArgSpecs && operationArgSpecs.size > 0 ? { operationArgsSpecs: operationArgSpecs } : {}),
    knowledgePaths: options.knowledgePaths,
    sensitivePaths: options.sensitivePaths,
    planActive: () => activePlan !== null,
    // 写类调用的覆盖判据：激活计划在本会话提交的那份 calls（宿主自己解析的那一份，
    // 见 activePlan 声明处）。恢复态 = 空数组 = 写类一律拒，直到重新激活一份计划。
    activePlanCalls: () => activePlan?.calls ?? null,
    ...(options.gateway ? { gateway: options.gateway } : {}),
    // 本回合工作区：宿主按任务注入（`tmp/task_<taskId>`，续跑同任务共享）。宿主有随机源
    // （taskId），不必让 worker 自己随机（它也没有随机手段）。给了它，write 只放行这一个
    // 目录——共享 tmp/ 下多个会话同时写同名产物会互相覆盖，而覆盖后的产物看不出被谁污染过。
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
  });
  /**
   * 计划提交审计上报：一次提交一行 tool_calls（与 G1 门同一口径、同一个出口）。
   *
   * tool 取 `plan_submit` 而不是 `bash`（assembly 据此落成
   * `tool_name = serve_gate:plan_submit`）：否则这一行与被门拦下的
   * bash 命令完全无法区分——同一个 tool_name、同一个
   * status/error_code，detail 还长得像一条命令（`payroll.validate
   * tmp/req_xxx ; payroll.transform ...`）。2026-10-10 实证：真实运行里计划提交
   * 早就落进了 tool_calls，但查 `safe_arguments like '%plan%'` 得 0 行——
   * 因为 detail 里永不出现 "plan" 这个词，人眼分不出哪行是计划提交。
   * 独立的 tool 名让"本轮有没有提交计划、提交了什么"成为一条 SQL就能回答的问题。
   *
   * 为什么单独一个函数：计划分支的出口有七八个（写关闭 / 拒次收敛 / 实体越权 / 激活 /
   * 待确认 / STOP / 平台拒绝 / 评估失败 / 形状不合法），漏挂任何一条都是**静默**不落账——
   * 没有报错、没有日志，只是排查时对不上。收成一个函数后，"要上报"只有一个地方可写，
   * 调用点只剩"什么时候调"。
   *
   * detail 只记 operation 名 + args 摘要（describePlanCalls，与 describeKeyArgs 同一套
   * 截断预算）：计划 JSON 可能很长，全文进审计会把 tool_calls 撑爆、重点反而埋掉。
   * 解析不出 calls 时（形状不合法）detail 为空——没有 calls 可摘要，硬塞命令原文就等于
   * 把计划 JSON 往审计里倒，那正是这里不要的东西；诊断信息在 reason 里（PLAN_JSON_PARSE
   * 这类码），足够定位。
   */
  function reportPlanSubmission(event: { reason: string; detail?: string }): void {
    options.serveGateAudit?.({
      tool: 'plan_submit',
      // 计划分支的每个出口都是 block（PLAN ACTIVE / NEEDS_USER_CONFIRM / STOP 的含义
      // 都是"这一跳不许真调平台"），所以 allowed 恒 false：记的是判定结果，不是放行。
      allowed: false,
      reason: event.reason,
      detail: (event.detail ?? '').slice(0, AUDIT_DETAIL_MAX_CHARS),
    });
  }

  /**
   * 结构化调用的宿主机械复核（C6）：按 CapabilityManifest 校验 requiresPlan / effects /
   * serve 矩阵 / args 结构。不解析业务参数值——那些是执行层的 schema 权威。
   */
  function validateStructuredCall(
    args: Record<string, unknown>,
    manifest: CapabilityManifest | null,
    activePlanId: () => string | null,
    activePlanCalls: () => readonly PlanCall[] | null,
  ): ServeGateVerdict | undefined {
    const operation = String(args.operation ?? '').trim();
    if (!operation) {
      return { block: true, reason: 'STRUCTURED_CALL DECLINED：operation 参数缺失' };
    }
    if (!manifest || manifest.operations.length === 0) {
      return { block: true, reason: 'STRUCTURED_CALL DECLINED：capability manifest 未加载或为空' };
    }
    const declaration = manifest.operations.find((op: { operation: string }) => op.operation === operation);
    if (!declaration) {
      return { block: true, reason: `STRUCTURED_CALL DECLINED：operation "${operation}" 未在能力清单中声明` };
    }
    if (declaration.requiresPlan && !activePlanId()) {
      return { block: true, reason: `STRUCTURED_CALL DECLINED：operation "${operation}" 需要激活的计划（requiresPlan=true）` };
    }
    // 计划覆盖判据（2026-11-09 四审 blocking）：与 bash 侧**同一份实现**
    // （serve-gate 的 planCoverageVerdict），不是这里另写一套。此前这条分支只查
    // requiresPlan 的存在性——于是一份纯读计划激活后，清单里已登记的写 operation 仍能经
    // structured_call 进网关，"计划里全是读、写照样调通"这个根因在这条路上原样存在。
    // 注意提案创建仍走宿主既有拦截路由（decideProposalCreation），不经过这里。
    // args 形状校验在下面；这里先安全取出对象（取不到 = 空关键参数表——写类若声明了关键
    // 参数，空表自然判"不覆盖"，不会因为形状非法就绕过计划门）。
    const rawArgs = args.args;
    const structuredArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
    const planVerdict = structuredPlanGateVerdict(operation, structuredArgs, {
      planActive: () => activePlanId() !== null,
      operationSemantics,
      activePlanCalls,
      ...(operationArgSpecs && operationArgSpecs.size > 0 ? { operationArgsSpecs: operationArgSpecs } : {}),
    });
    if (planVerdict) return planVerdict;
    const argsValue = args.args;
    if (typeof argsValue !== 'object' || argsValue === null || Array.isArray(argsValue)) {
      return { block: true, reason: 'STRUCTURED_CALL DECLINED：args 必须是对象' };
    }
    // 参数级 fail-closed：args 只许包含清单声明的参数名。
    if (declaration.argsSchema && declaration.argsSchema.length > 0) {
      const undeclared = Object.keys(argsValue).filter((key) => !declaration.argsSchema!.includes(key));
      if (undeclared.length > 0) {
        return { block: true, reason: `STRUCTURED_CALL DECLINED：operation "${operation}" 参数名未声明：${undeclared.join(', ')}` };
      }
    }
    // T5 执行前对账（2026-11-11）：结构化通道与 bash 同一道硬门——对不上当前已确认计划
    // 声明的调用第一跳即拒，并留拒收记录。位置在形状/参数名校验之后：先让 worker 拿到
    // 更具体的形状错误，再判范围。拿不到声明（恢复的会话只有 planId/version）→ 无法
    // 对账，不拒（如实留给 execution-scope.ts 的 unreconciledCalls）。
    const declarations = activePlanCalls();
    if (declarations && declarations.length > 0) {
      const classification = planDeclarationCoversStructured(operation, argsValue as Record<string, unknown>, declarations, {
        operationSemantics,
        ...(operationArgSpecs.size > 0 ? { operationArgsSpecs: operationArgSpecs } : {}),
      });
      if (classification === 'expansion') {
        const reason = `PLAN SCOPE：${messageTextFor('SERVE_PLAN_SCOPE_EXPANSION', undefined, options.gateway)}`;
        options.serveGateAudit?.({
          tool: 'plan_scope_expansion',
          allowed: false,
          reason,
          detail: `structured_call ${operation} ${JSON.stringify(argsValue)}`.slice(0, AUDIT_DETAIL_MAX_CHARS),
          requestId: options.requestId,
        });
        return { block: true, reason };
      }
    }
    // effects / serve 矩阵在此只做存在性投影，不解释业务含义（执行层自有词汇）。
    // 宿主不另立枚举、不硬编码白名单——平台加同族取值不静默改写判定。
    //
    // 读类探测计数：结构化调用已通过全部放行判据（与 bash 的 onAllowedBash 同一时机——
    // 只有真被放行的调用才计数）。判据与 bash 侧同一把尺子（isDeclaredReadOperation），
    // 不用 manifest 的 effects 词表猜读/写。
    if (options.onReadProbe && isDeclaredReadOperation(operation, operationSemantics)) options.onReadProbe();
    return undefined;
  }

  /**
   * 宿主对每一跳工具调用的裁决（原 beforeToolCall 函数体，一字未动地搬进来）。
   *
   * 为什么包一层而不是把"记下被拦身份"逐个 return 前补：这个函数有 8 个 return 点
   * （计划形状不合法 / 计划六种裁决 / 提案三态 / 落回 gate），漏挂任何一处就是静默的假放行。
   * 与 reportPlanSubmission 用 try/finally 是同一条理由——把"离开本块必记账"变成结构事实，
   * 新增裁决出口时不需要记得再补一次。
   */
  async function decideToolCall(ctx: BeforeToolCallContext): Promise<ServeGateVerdict | undefined> {
    const args = (typeof ctx.args === 'object' && ctx.args !== null
      ? ctx.args
      : ctx.toolCall.arguments) as Record<string, unknown>;
    if (ctx.toolCall.name === 'bash') {
      // 解析与（--file 时）读文件在同一个 try 里：形状、旗标、边界、读取、内容五类
      // 失败共用一条 PLAN DECLINED 交付与一次上报。分开放就会重演另一类缺口——文件
      // 通道的失败若绕过上报，"worker 指了个越界文件"在 tool_calls 里查不到。
      let submission: ResolvedPlanSubmission | null = null;
      try {
        const parsed = parsePlanCallsCommand(String(args?.['command'] ?? ''), options.gateway);
        if (parsed) submission = await resolvePlanSubmission(parsed);
      } catch (error) {
        // 形状不合法的提交也要留痕：这一跳同样是"worker 提交了方案"的事实，只是宿主
        // 解析不出来（2026-10-10 实证：真实运行里 worker 先拿带引号的 JSON 试了一次，
        // 那一次在 tool_calls 里没有任何痕迹）。detail 为空，见 reportPlanSubmission。
        //
        // C3：形状失败计入收敛计数。2026-10-23 实证的缺口——req_368b68b3 连撞
        // 11 次 PLAN_JSON_PARSE、空转 4 分 11 秒 / 657k tokens：解析抛出点在这条
        // catch 里提前返回，declinedPlans（只在 decidePlanSubmission 内自增）从不
        // 被碰，熔断器对形状失败整类失效。计数器语义不变（自上次成功激活以来未激活
        // 的提交数——形状失败是其中一类），归零点仍只有 ACTIVE 那一支；措辞照旧说
        // "提交未激活"而不是"被拒 N 次"（D-099 的诚实纪律：混合历史下它就是提交数）。
        declinedPlans += 1;
        const reason = declinedPlans > MAX_DECLINED_PLANS_PER_TASK
          ? `PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', `连续 ${declinedPlans} 次提交方案均未激活`, undefined, options.gateway)}`
          : `PLAN DECLINED：${error instanceof Error ? error.message : '计划格式无效'}`;
        reportPlanSubmission({ reason });
        return { block: true, reason };
      }
      if (submission) {
        const resolved = submission;
        // ── 计划提交审计（补 tool_calls 缺口）────────────────────────────────────
        // 为什么必须在这里上报：整条计划分支**提前 return，不经 gate()**，serve-gate 的
        // onEvent 一次都不触发——于是"worker 提交了什么方案"在 tool_calls 里查不到，
        // 排查时对不上（已实证的审计缺口）。calls 是宿主自己解析出的确定性事实，逐次上报
        // （与 G1 门同一口径：assembly 的 serveGateAudit 把它落进 tool_calls 审计）。
        //
        // 为什么用 try/finally 而不是"return 前调一次"：decidePlanSubmission 有多个
        // return（见函数体），任何一个出口漏挂就是静默不落账。finally 把"离开本块必上报"
        // 变成结构事实——新增一条裁决出口时不需要记得再补一次上报，漏不掉。
        let reason = '';
        try {
          const planVerdict = await decidePlanSubmission(resolved);
          reason = planVerdict.reason ?? '';
          return planVerdict;
        } finally {
          // reason 为空只可能是 decidePlanSubmission 自己抛了（此时异常继续往外抛，
          // SDK 把它转成工具错误结果）：记一条占位判定，提交事实不因异常被抹掉。
          reportPlanSubmission({ reason: reason || '计划评估未返回判定', detail: resolved.detail });
        }
      }
      // ── 提案创建拦截（方案 1 · B 波 B3）────────────────────────────────────────
      // 位置：计划解析之后、gate() 之前。为什么必须在 gate 之前：这条路径**提前 return**，
      // 若落进 gate，worker 的网关调用就真的打到平台——平台会创建提案，而宿主持有的意图
      // 条目、确认码、用户可见摘要全都不存在，用户拿不到确认码（A 波标定的缺口形状）。
      // B 波那个"提案创建走不走网关"的开关曾让整支可缺席（关 = 走遗留文本路径）；C 波删掉
      // 那条路后开关退役，拦截恒开。
      const proposalCall = parseProposalCommand(String(args?.['command'] ?? ''), operationProtocols, options.gateway);
      if (proposalCall) return decideProposalCreation(proposalCall);
    }
    if (ctx.toolCall.name === 'structured_call') {
      return validateStructuredCall(args, capabilityManifest, activePlanId, () => activePlan?.calls ?? null);
    }
    // 门的这一跳事件先扣住（见 bufferedGateEvents 注释）：T5 若拒收，这一跳不能留下
    // allowed:true 的假执行痕迹。非 bash 工具与门自己拦下的调用原样落账。
    bufferedGateEvents = [];
    let gateVerdict: ServeGateVerdict | undefined;
    try {
      gateVerdict = gate({ name: ctx.toolCall.name, arguments: args });
    } catch (error) {
      bufferedGateEvents = null;
      throw error;
    }
    const buffered = bufferedGateEvents;
    bufferedGateEvents = null;
    const isBash = ctx.toolCall.name === 'bash';
    // T5 执行前对账（2026-11-11）：门放行的网关调用还要过一道**与已确认计划声明对账**的
    // 硬门。位置在门之后：档位线（read 只要有计划）一字未动；对不上声明的调用第一跳即拒，
    // 不是警告、也没有额度（见 scopeExpansionVerdict）。
    const scopeVerdict = gateVerdict?.block || !isBash
      ? undefined
      : scopeExpansionVerdict(String(args?.['command'] ?? ''));
    if (!scopeVerdict) {
      for (const event of buffered) options.serveGateAudit?.(event);
    }
    return scopeVerdict ?? gateVerdict;
  }

  /**
   * T5 执行前对账（2026-11-11）：这次网关调用对不上**已确认计划声明**时，直接拒。
   *
   * 为什么需要（今天败状）：激活的计划只声明了 alpha，worker 转头把 9 个 collection 全查
   * 一遍（A2 范围渗入、C1 张冠李戴、D2 十八调大扇出）——读档的档位线只问"有没有激活计划"，
   * 执行前没有任何一道对账，用户没确认过的对象照样被查。A2 两臂与 C1 的实测已经证明
   * "警告/软额度"会被静默穿透，所以这里是**拒收**，不是告警，也不设探索额度。
   *
   * 拒收时必留一条审计记录（tool_calls 一行：tool=plan_scope_expansion、allowed=false、
   * detail=命令原文）——拒收必须可复盘。理由指向正路：把要查的对象补进计划重新提交；
   * 重计划因累积重量进确认档，由平台确认门停下并留下用户确认记录（T5 判据后半句）。
   *
   * 拿不到声明（恢复的会话只有 planId/version）→ 无法对账：不拒（如实留给对账层，
   * 见 execution-scope.ts 的 unreconciledCalls，不把"没有证据"当成"零超出"）。
   */
  function scopeExpansionVerdict(command: string): ServeGateVerdict | undefined {
    if (!command) return undefined;
    const declarations = activePlan?.calls ?? null;
    if (!declarations || declarations.length === 0) return undefined;
    const classification = planDeclarationCovers(command, declarations, {
      // 与 serve-gate 计划覆盖判据同一份 args 规格表（本会话派生的那张）：位置参数声明
      // 缺了会让"以位置参数定目标"的调用被误判成扩张（fail-closed 方向相反，多拒）。
      ...(operationArgSpecs.size > 0 ? { operationArgsSpecs: operationArgSpecs } : {}),
      // 与门同一份执行模式词汇（②）：平台声明的 mode 在这条对账路上同样认得出，
      // 否则"门放行的新 mode 调用"会落 not_plan_gated、绕过范围对账。
      ...(serveModes.length > 0 ? { serveModes } : {}),
    });
    if (classification !== 'expansion') return undefined;
    const reason = `PLAN SCOPE：${messageTextFor('SERVE_PLAN_SCOPE_EXPANSION', undefined, options.gateway)}`;
    options.serveGateAudit?.({
      tool: 'plan_scope_expansion',
      allowed: false,
      reason,
      detail: command.slice(0, AUDIT_DETAIL_MAX_CHARS),
      requestId: options.requestId,
    });
    return { block: true, reason };
  }

  session.agent.beforeToolCall = async (ctx) => {
    try {
      const verdict = await decideToolCall(ctx);
      // D-086：这一跳被宿主拦下 → SDK 会用我们的 reason 合成一条 isError tool_result 落进
      // 转录。记下身份，收集平台响应时按 id 整条排除。理由仍逐字到 worker 眼前（它本来就是
      // worker 的工具输出），这里只收回"把它当实体证据"这一项。
      if (verdict?.block) blockedToolCallIds.add(ctx.toolCall.id);
      return verdict;
    } catch (error) {
      // 抛异常的那一跳同样被 SDK 转成 tool_result（正文 = 异常消息，agent-loop.js），
      // 一样按身份排除——否则异常消息里的 token 会留在 haystack 里。
      blockedToolCallIds.add(ctx.toolCall.id);
      throw error;
    }
  };

  /**
   * 平台响应账本的记账点（D-085）：每一条**执行完**的工具结果都记一份。
   *
   * **包一层而不赋值**：AgentSession 在自己的构造函数里就装了一个 afterToolCall
   * （agent-session.js，做扩展 tool_result 钩子 + 图片归一化），直接赋值会踩掉它。
   * 先 await 原 hook，再记账，最后把原 hook 的返回值原样交还——返回 undefined 就是
   * "不覆盖"，行为零变化。（beforeToolCall 现在是赋值覆盖，那是 2026-10-07 起就存在的
   * 既有事实，不在本波范围内改。）
   *
   * 只记最终会落进转录的那份 content（扩展/归一化可能换过），所以账本与转录通道记的是
   * 同一批东西的同一份文本。
   */
  const sessionAfterToolCall = session.agent.afterToolCall;
  session.agent.afterToolCall = async (ctx) => {
    const overridden = await sessionAfterToolCall?.(ctx);
    // bash 溢出快照归位（A2A 文件通道）：/tmp 快照搬进本轮工作区，路径改写后交还模型
    const relocated = relocateBashSnapshotIntoWorkspace(ctx.toolCall?.name, overridden ?? ctx.result, options.scratchDir, options.cwd);
    const merged = relocated
      ? ({ ...(overridden ?? {}), ...relocated } as typeof overridden)
      : overridden;
    platformRecorder.record((merged?.content ?? ctx.result.content) as unknown);
    return merged;
  };

  /**
   * 提案创建网关调用的宿主裁决（B 波 B3）：文件边界检查 → 宿主办调平台 → 三态分流 → 审计。
   *
   * 为什么独立成函数（与 decidePlanSubmission 同一理由）：这条路径提前 return，不经 gate()，
   * 门的 onEvent 一次都不触发，审计必须由宿主自己上报。出口有四条（越界 / 缺回调 / 办调三态），
   * 漏挂任何一条都是静默不落账。
   */
  async function decideProposalCreation(call: ProposalCreateCall): Promise<ServeGateVerdict> {
    // payload 路径的通用文件边界检查（安全，非业务）：路径经 workspaceRelPath 解析后必须
    // 落在本回合工作区（tmp/task_<taskId>，宿主注入）内。理由：payload 路径来自 worker 命令，
    // 不检查就等于让 worker 指使平台去读工作区里任意文件、再把错误信息带回来看——那是一道
    // 通用读取面，与提案业务无关。判据与 write 门同一把尺（workspaceRelPath +
    // isInsideScratch），不存在第二份路径解析。
    const scratchDir = options.scratchDir ?? null;
    const rel = scratchDir ? workspaceRelPath(options.cwd, call.payloadPath) : null;
    if (!scratchDir || rel === null || !isInsideScratch(rel, scratchDir)) {
      const reason = `PROPOSAL REFUSED：payload 路径越界（只准本轮可写位置 ${scratchDir ?? '（未分配）'} 内），未调用平台。`;
      reportProposalInterception({ reason, detail: call.payloadPath });
      return { block: true, reason };
    }
    const create = options.onCreateProposal;
    // 没配宿主出口 = 配置故障，fail-closed：拦下而不放行。放行等于让平台建一个宿主持不
    // 住确认码的提案（用户永远拿不到码），那正是本支要关掉的缺口。
    if (!create) {
      const reason = 'PROPOSAL REFUSED：宿主未配置提案创建出口，已停止（未调用平台）。';
      reportProposalInterception({ reason, detail: `${call.operation} ${call.payloadPath}` });
      return { block: true, reason };
    }
    const outcome = await create(call);
    // completed 结局交给驱动侧 latch：本回合以此终结，结果时刻的文本由宿主持有
    // （平台 summaryText + 确认行），不是 worker 文本。
    if (outcome.status === 'completed') {
      options.onProposalOutcome?.(outcome);
    }
    // 给 worker 的确定性消息（**绝不含确认码**：码只出现在给用户的文本里，见 driver 侧
    // proposalReply 的 userText）。措辞是宿主协议前缀 + 平台错误码 / 平台状态，不解释业务。
    const reason = outcome.status === 'completed' ? `PROPOSAL CREATED：${outcome.workerText}`
      : outcome.status === 'needs_input' ? `PROPOSAL NEEDS_INPUT：${outcome.workerText}`
        : `PROPOSAL FAILED：${outcome.workerText}`;
    // needs_input 的线索进纠错环（与宿主计划拦截同一机制）：missing/reason 来自平台信封的
    // 结构化字段，**绝不**对 worker 自由文本做模糊匹配。
    if (outcome.status === 'needs_input') needsClues.push(outcome.needs);
    reportProposalInterception({ reason, detail: `${call.operation} ${call.payloadPath}` });
    return { block: true, reason };
  }

  /** 提案拦截审计（与 G1 门同一口径：一行 tool_calls，errorCode 由 assembly 落 GATE_BLOCKED）。 */
  function reportProposalInterception(event: { reason: string; detail: string }): void {
    options.serveGateAudit?.({
      tool: 'proposal_create',
      // 每个出口都是 block（越界 / 缺回调 / 三态交还的含义都是"这一跳不许真调平台"），
      // 所以 allowed 恒 false：记的是判定结果，不是放行。
      allowed: false,
      reason: event.reason,
      detail: event.detail.slice(0, AUDIT_DETAIL_MAX_CHARS),
    });
  }

  /** 解析后的计划提交：calls + 审计 detail（--file 通道带工作区相对路径）。 */
  interface ResolvedPlanSubmission {
    calls: PlanCall[];
    userConfirmed?: boolean;
    detail: string;
  }

  /**
   * 把一次计划提交解析成可交付裁决的 calls：inline 原样透传；--file 走文件通道。
   *
   * 文件通道三道闸，判据全部沿用现成的那一份（不建第二套路径解析）：
   *   ① 边界——workspaceRelPath + isInsideScratch，与提案 payload 边界检查、
   *      write 门同一把尺；缺 scratchDir = fail-closed。放行面就是 write 门的放行
   *      面：worker 只能指自己写得进去的文件（tmp/task_<taskId> 内）；
   *   ② 体积——write 门同口径 MAX_WRITE_BYTES。write 工具写的文件天然不超，但
   *      bash（python3 落盘）绕得过那侧上限，指个大文件会把宿主读爆；
   *   ③ 内容——parsePlanCallsPayload，与 inline 同一份校验（文件通道不宽松：
   *      宽容面 = 攻击面，与 ALLOWED_PLAN_PREFIX_RE 不 absorbing 同一条纪律）。
   *
   * detail 在成功路径带工作区相对路径（审计要能看出方案来自哪个文件）；失败路径
   * detail 留空——拒绝理由里已带 worker 指的路径（actual），不往审计倒第二次。
   */
  async function resolvePlanSubmission(parsed: PlanSubmission): Promise<ResolvedPlanSubmission> {
    if (parsed.kind === 'inline') {
      return {
        calls: parsed.calls,
        ...(parsed.userConfirmed !== undefined ? { userConfirmed: parsed.userConfirmed } : {}),
        detail: describePlanCalls(parsed.calls),
      };
    }
    const scratchDir = options.scratchDir ?? null;
    const rel = scratchDir ? workspaceRelPath(options.cwd, parsed.path) : null;
    if (!scratchDir || rel === null || !isInsideScratch(rel, scratchDir)) {
      throw errorFor('PLAN_FILE_OUT_OF_WORKSPACE', parsed.path, undefined, options.gateway);
    }
    const abs = path.resolve(options.cwd, rel);
    let content: string;
    try {
      const stats = statSync(abs);
      // 只收普通文件：目录/FIFO/设备文件过不了 size 这一关的语义——FIFO 的 size 为 0
      // 但 readFileSync 会无限期阻塞，而 beforeToolCall 没有超时（对照 defaultCliRunner
      // 的 30s SIGTERM），挂住的是宿主这一跳。worker 经 bash（mkfifo）可自造，虽非新
      // 提权面（非网关 bash 本就能自挂），但宿主自己的读路径要有界。
      if (!stats.isFile()) throw new Error('不是普通文件（目录/FIFO/设备），拒绝读取');
      if (stats.size > MAX_WRITE_BYTES) throw errorFor('PLAN_FILE_TOO_LARGE', `${rel}（${stats.size} 字节，上限 ${MAX_WRITE_BYTES}）`, undefined, options.gateway);
      content = readFileSync(abs, 'utf8');
      // 读后复核：stat 与 read 之间文件可能被撑大（TOCTOU，微秒级窗口且属自伤）——
      // 读后按字节数再校一次。上限只认 write 门那一个数字，不设第二本账。
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) throw errorFor('PLAN_FILE_TOO_LARGE', `${rel}（读取后 ${bytes} 字节，上限 ${MAX_WRITE_BYTES}）`, undefined, options.gateway);
    } catch (error) {
      // 表内码（体积越界）原样抛；文件系统错误包一层上下文——与 plan CLI 失败同一
      // 手法：真实原因逐字带出，worker 看得见是哪个文件怎么了（ENOENT = 忘了先写）。
      if (error instanceof Error && (error as { code?: string }).code?.startsWith('PLAN_')) throw error;
      throw new Error(`计划文件读取失败（${rel}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = parsePlanCallsPayload(content, options.gateway);
    return {
      calls: payload.calls,
      ...(payload.userConfirmed !== undefined ? { userConfirmed: payload.userConfirmed } : {}),
      detail: `${rel} ${describePlanCalls(payload.calls)}`,
    };
  }

  /**
   * 计划提交的宿主裁决：写关闭前置扫描 → 拒次收敛 → 实体来源校验 → 平台 evaluate。
   *
   * 抽成函数只为一个理由：这条路径**提前 return**（不经 serve-gate 的 gate()），门的
   * onEvent 不会触发，审计必须在返回前由宿主自己上报（见 beforeToolCall 的调用处）。
   * 裁决逻辑与顺序一字未动——函数化不改变任何判定，只让"上报一次"有地方挂。
   */
  async function decidePlanSubmission(parsed: { calls: PlanCall[]; userConfirmed?: boolean }): Promise<ServeGateVerdict> {
    // 结构化事实（D-065）：calls 是宿主自己解析的不是 worker 文本——上报给驱动侧
    // latch，结果时刻随 TurnDriverResult.planFacts 上交（规格声明名机械提取取值）。
    options.onPlanSubmitted?.(parsed.calls);
    // ── 写关闭前置拦截（2026-11-08 架构裁定后删除）────────────────────────────────
    // 原职责：宿主在 evaluate 之前用"计划含写类 operation × 平台写开放声明"判一次
    // "这个部署允不允许写"，不成立就合成 WRITE_NOT_ENABLED 终稿终结该轮（D-075 的
    // T7 事故修复）。裁定后这一层归执行层：写能不能真落地由平台自己的计划门 / 提案门 /
    // commit 门裁决并给出拒绝/warning，宿主只如实转述。宿主在此不再提前判权限，
    // 含写类 operation 的计划照常提交平台评估。
    // 计划提交的收敛保护（D-099 起语义修正）：计划被拒是确定性信号（实体越权/平台
    // 拒绝），CLI 失败同样说明这一跳没成——反复重提同一请求只会空转模型预算。超过上限就
    // terminal block，让 worker 收手向用户说明，而不是把回合拖到 executor 超时（实测 D1
    // 类请求空转 5 分钟后崩溃）。计数器是"自上次成功激活以来的提交次数"，不是拒绝次数：
    // 唯一归零点在下面 ACTIVE 那一支，消息也照这个意思说。
    declinedPlans += 1;
    if (declinedPlans > MAX_DECLINED_PLANS_PER_TASK) {
      return {
        block: true,
        // 收敛原因收口在 error-codes.ts（三要素：码 + 期望/实际/正确形态）；
        // PLAN STOP 是协议前缀（worker 提示词认它），原因本体来自表。
        // actual 如实陈述这个数是什么：自上次成功激活以来、一次都没激活成的连续提交次数
        // （D-099）。它**不是**"被拒绝次数"——越权拒绝、CLI 失败暂停、平台拒绝都计数。
        // 说成"已被连续拒绝 N 次"就是谎报：真实运行里 worker 撞上这条时，前几次常常是成功
        // 激活（2026-10-15 acceptance 8.1：3 active + 1 paused + 1 declined）。
        reason: `PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', `连续 ${declinedPlans} 次提交方案均未激活`, undefined, options.gateway)}`,
      };
    }
    if (options.entitySources) {
      // 领域无关的实体来源校验（架构 §2 第 9 条）：计划里的每个实体都必须能在
      // 「当前消息 / 检索证据 / 本任务迄今的平台响应 / 本会话用户亲自确立过的实体」
      // 里逐字找到。平台响应从当前会话已产生的 tool_result 里收集——执行层调目录
      // 查询拿到的唯一候选名就逐字住在这里面，宿主不需要懂业务就能放行"合法解析出来
      // 的实体"。第四来源（sessionEntities）由宿主在委派时注入，见 runtime.ts。
      //
      // **宿主自己拦下的那一跳不算平台响应**（D-086）：它的正文是宿主写的拒绝理由，逐字带
      // 着 worker 刚提交的越权 token。按 toolCallId 身份排除（见 platform-entities.ts）——
      // 不按 isError（平台 CLI exit 3 的真错误信封同形），也不按文案前缀（嗅探）。
      //
      // 第三个参数（产物路径豁免，2026-10-13 实测假拒修复）：worker 把 payload 写进
      // 本回合工作区后按路径排进计划，该路径不是领域实体、不在任何来源里，逐字包含
      // 必然假拒，重试还会撞 DECLINED_PLAN_LIMIT 终局。判据与提案 payload 边界检查
      // 同一把尺（workspaceRelPath + isInsideScratch，见 turn-contract 的
      // PlanArtifactBoundary），只有本回合工作区内的路径免检。scratchDir 缺失（测试
      // 替身 / 老路径）时不传 = 豁免整支不出现，判定与从前一字不差。
      const scratchDir = options.scratchDir ?? null;
      const artifactBoundary: PlanArtifactBoundary | undefined = scratchDir
        ? { workspaceRoot: options.cwd, scratchDir }
        : undefined;
      // 两个通道合并（D-085）：转录通道覆盖"现存的 + 上一回合恢复的"，账本通道覆盖"被自动
      // 压缩摘出转录的"。同一份响应两边都在时只判一次。
      const taskPlatform = mergeTaskPlatformSources(
        transcriptPlatformSources(session.agent.state.messages, blockedToolCallIds),
        platformRecorder.snapshot(),
      );
      const scopeError = validatePlanEntities(parsed.calls, {
        ...options.entitySources,
        platformResponses: [
          ...(options.entitySources.platformResponses ?? []),
          ...taskPlatform.responses,
        ],
        // ③′ 结构化叶值：与 ③ 同源的附加投影，只在非空时挂（空数组不占地）
        ...(taskPlatform.entities.length > 0 ? { platformEntities: taskPlatform.entities } : {}),
      }, artifactBoundary);
      if (scopeError) {
        activePlan = null;
        needsClues.push({ missing: ['请求中未给出的对象'], reason: scopeError });
        // 实体越权原因收口在 error-codes.ts（三要素）；PLAN DECLINED 是协议前缀。
        return { block: true, reason: `PLAN DECLINED：${messageFor('ENTITY_OUT_OF_SCOPE', scopeError, undefined, options.gateway)}` };
      }
    }
    const previousPlan = activePlan;
    activePlan = null;
    // 宿主替 worker 向平台提交方案：单轮里最长的等待之一，先给用户一帧。
    options.onStep?.(PLAN_SUBMIT_STEP);
    try {
      const plan = await evaluateAndActivatePlan({
        platformRoot: options.cwd,
        taskId: options.sessionId ?? 'task_unknown',
        requestId: options.requestId,
        calls: parsed.calls,
        onNotice: options.onNotice,
        userConfirmed: parsed.userConfirmed,
        runCli: options.planCliRunner,
        activationSecret: options.planActivationSecret,
        // T6 任务级确认门兜底：把本会话已授权花掉的预算交给叠加档，累计进 confirm 档即停。
        taskBudgetUsage: ledgerUsage(taskBudgetLedger),
        // gateway 穿线（C7b 漏穿补课）：EvaluateAndActivatePlanOptions.gateway 文档写明
        // "透传给默认 runner"，但调用点从未传——默认 runner 拿不到网关名，spawn 前
        // fail-closed 抛错，每次计划提交都以 PLAN DECLINED（网关未声明）收场，平台一次
        // 都没执行（实测 2026-11-07：探针 ledgerCalls 恒 0，模型只能诚实报阻塞）。
        ...(options.gateway ? { gateway: options.gateway } : {}),
      });
      if (plan.status === 'active') {
        // D-099：唯一的归零点。计划真的激活了（平台批准 + 本跳执行权已授予）才算一次确凿
        // 成功——"连续未激活"就此中断，计数从零开始。熔断器只在这里放松：不放松到"没报错
        // 就算"（PLAN PAUSED / PLAN STOP / 实体越权照旧计数，那一维没有放松）。
        declinedPlans = 0;
        // calls 存**宿主解析出的那一份**（parsed.calls）：它与平台 evaluate 收到的
        // `delta.calls` 同源（同一份 JSON 原样转发），而平台只在 evaluate 响应里回一份
        // 摘要。写类调用的覆盖判据读这里（serve-gate 的 activePlanCalls）。
        activePlan = { planId: plan.planId, version: plan.version, calls: parsed.calls };
        // T6：计划真的激活了才进账（按 planId 去重，重放/重新激活不重复计数）。
        taskBudgetLedger = withActivatedPlan(taskBudgetLedger, plan.planId, {
          calls: plan.evaluation.estimate.calls,
          seconds: plan.evaluation.estimate.seconds,
          weight: plan.evaluation.estimate.weight ?? 0,
        });
        return { block: true, reason: `PLAN ACTIVE（${plan.planId} v${plan.version}）：按已提交 calls 执行；平台会逐次校验本计划。` };
      }
      if (plan.status === 'confirm') {
        options.onPendingPlan?.(plan.pending);
        return { block: true, reason: `PLAN NEEDS_USER_CONFIRM\n${plan.message}\n已暂停执行，等待宿主验证用户确认。` };
      }
      activePlan = previousPlan;
      return { block: true, reason: `PLAN STOP\n${plan.message}` };
    } catch (error) {
      // 计划门对"计划里含非只读 operation"的确定性拒绝：平台 canonicalCall 在
      // evaluate 时抛 PLAN_OPERATION_NOT_READ_ONLY（CLI exit 3，stderr 原样带出）。
      // 这不是"等用户确认"的暂停（PLAN PAUSED 的语义）——协议前缀用 PLAN STOP
      // （worker 提示词认它 = 直接说明停止原因）。此前这里原样透传 CLI 失败串，worker
      // 只能汇报卡点，"未开放写入权限"到不了用户（2026-09-27 第三波实测）。
      //
      // 匹配这个码**只为定位失败点**（平台暂时还抛它），语义判断读平台语义表：
      // 拒绝名单里混着两类调用——要用户确认的写类调用与根本不需要计划的本地处理，
      // 但两者给 worker 的答复现在同形：点名该调用、让它移出计划改为直接调用
      // （planNotReadOnlyReason）。宿主不在这里判"这个部署允不允许写"，也不合成
      // "未开放写入权限"的归因（D-096 的假归因形态）。既有活跃计划照常恢复：被拒的是
      // 新提交，不是已激活的范围。
      //
      // ② 的理由带点名（planNotReadOnlyReason → PLAN_NOT_PLANNABLE_OPERATIONS）：不说
      // "该调用"而说"哪个调用"，worker 才删得动那一个、改为直接调用、重提剩余部分——
      // 2026-10-13 实测它就是在这一句上无从下手，原样重提 5 次后 terminal block。
      //
      // 2026-10-14 起这里就只有②一条路：不再有"未开放写入权限"那一支（宿主不判这个部署
      // 允不允许写，写类的放行/拒绝/warning 归执行层自己说）。写类被平台计划门拒绝时，
      // 宿主只如实点名该调用、让 worker 把它移出计划改为直接调用——D-096 记的假归因
      // （用户被指去找管理员要一个他已经有的权限）自此没有发生位。
      if (error instanceof Error && error.message.includes('PLAN_OPERATION_NOT_READ_ONLY')) {
        activePlan = previousPlan;
        return {
          block: true,
          reason: `PLAN STOP\n${planNotReadOnlyReason(parsed.calls, operationSemantics)}`,
        };
      }
      return { block: true, reason: `PLAN PAUSED：${error instanceof Error ? error.message : '计划评估失败'}；未执行平台操作。` };
    }
  }

  const loaded = loader.getSkills().skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
  }));
  return { session, skills: loaded, currentPlan: () => activePlan, needsClue: () => needsClues.at(-1) ?? null };
}

async function createCodingModel(options: PiCodingTurnDriverOptions): Promise<CodingModelConfig> {
  const baseUrl = (options.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = options.env.LLM_API_KEY;
  const modelId = options.env.LLM_MODEL ?? '';
  if (!baseUrl || !apiKey || !modelId) {
    const missing = [
      ['LLM_API_BASE_URL', baseUrl],
      ['LLM_API_KEY', apiKey],
      ['LLM_MODEL', modelId],
    ].filter(([, value]) => !value).map(([name]) => name);
    throw new Error(`缺少环境变量 ${missing.join('、')},无法初始化 pi-coding-agent Worker`);
  }
  const rawThinking = options.env.LLM_THINKING_LEVEL ?? '';
  const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  if (rawThinking && !allowed.has(rawThinking)) throw new Error(`环境变量 LLM_THINKING_LEVEL 无效:${rawThinking}`);
  const thinkingLevel = (rawThinking || undefined) as CodingModelConfig['thinkingLevel'];
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('llm', {
    name: 'LLM',
    api: 'openai-completions',
    baseUrl,
    apiKey,
    models: [{
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      baseUrl,
      reasoning: true,
      thinkingLevelMap: KIMI_THINKING_LEVEL_MAP,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    }],
  });
  const model = runtime.getModel('llm', modelId);
  if (!model) throw new Error(`pi-coding-agent Worker 模型注册失败:${modelId}`);
  return { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/**
 * 平台"输入不足"类确定性错误码：词元级精确匹配（INVALID_PERIOD / ACCOUNT_SET_NOT_FOUND /
 * ACCOUNT_SET_AMBIGUOUS / MISSING_* …），不做自由文本模糊匹配。
 * 计划门裁决码（PLAN_*）不算：那类停止原因不是"缺用户信息"，Main Agent 补不了，
 * 拿去问用户也得不到答案——它们仍按原路径由 worker 说明并停止。
 */
const INPUT_INSUFFICIENT_CODE_RE = /(?:^|_)(?:MISSING|INVALID|AMBIGUOUS|REQUIRED)(?:_|$)|NOT_FOUND/;
/** 错误码里的判定修饰词：剥掉之后剩下的才是"缺的那个东西"。 */
const CODE_MODIFIER_TOKENS = new Set(['INVALID', 'AMBIGUOUS', 'MISSING', 'REQUIRED', 'NOT', 'FOUND', 'ERROR', 'FAILED', 'UNKNOWN']);

/** 平台错误码是否表示"输入不足"（缺参数 / 参数不合法 / 多候选 / 查无此项）。 */
export function isInputInsufficientCode(code: string): boolean {
  return !code.startsWith('PLAN_') && INPUT_INSUFFICIENT_CODE_RE.test(code);
}

/**
 * 平台错误码 → 缺失项标签：机械切分，不含任何领域词表（编排层不懂业务，
 * 也不该为某个域维护一张"错误码 → 中文名"的表——那是执行层的知识）。
 */
export function missingLabelFromCode(code: string): string {
  const tokens = code.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const subject = tokens.filter((token) => !CODE_MODIFIER_TOKENS.has(token.toUpperCase()));
  return (subject.length ? subject : tokens).join(' ').toLowerCase() || code.toLowerCase();
}

/**
 * 从本任务迄今的平台响应派生"缺什么"：只认 RESULT 信封里的确定性错误码
 * （`platform-contract.ts` 是唯一契约适配层）。没有信封、没有错误码 → null，
 * 绝不退化成对 worker 自然语言的猜测。取最近一条命中。
 *
 * Public only for tests: the derivation is pure and its determinism is the whole point.
 */
export function needsFromPlatformResponses(messages: readonly AgentMessage[]): SubagentNeeds | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== 'toolResult') continue;
    const envelope = parseEnvelope(textFromContent(message.content));
    const error = envelope?.error;
    if (!error?.code || !isInputInsufficientCode(error.code)) continue;
    return {
      missing: [missingLabelFromCode(error.code)],
      reason: `${error.message || error.code}（平台返回 ${error.code}）`,
    };
  }
  return null;
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (message?.role !== 'assistant') continue;
    if (message.stopReason && message.stopReason !== 'stop') return '';
    return textFromContent(message.content);
  }
  return '';
}

// Keep the imported type visible in emitted declarations while documenting
// the worker's deliberate native-tool boundary.
export type PiCodingWorkerTool = DiscoveredTool;
