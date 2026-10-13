/**
 * Worker driver backed by the official pi-coding-agent SDK.
 *
 * The main Agent continues to use the small pi-agent-core driver.  This
 * driver is deliberately only for trusted context workers: the SDK owns the
 * cwd-bound read/bash/grep/find/ls tools and its headless AgentSession, while
 * fshine still owns task persistence and the parent session.
 */
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createBashToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai/compat';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type DriverMessage, type PlanCallFacts, type ProposalCreationOutcome, type SubagentNeeds, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { createServeGate, describePlanCalls, isInsideScratch, workspaceRelPath, AUDIT_DETAIL_MAX_CHARS, type GateInvocationKind, type ServeGateEvent, type ServeGateVerdict } from './serve-gate';
import { isWriteAccess, loadOperationArgSpecs, loadOperationArgStyles, loadOperationLabels, loadOperationProtocols, loadOperationSemantics, type AccessSemantics, type KeyArgStyles, type KeyArgStyle, type OperationArgsSpecs, type OperationLabels, type OperationProtocols, type OperationSemantics } from './operation-labels';
import { messageFor, messageTextFor } from './error-codes';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, loadCurrentActivePlan, parsePlanCallsCommand, planCallFacts, planWriteClosed, type PlanCall, type PlanCliRunner, type PendingPlanConfirmation } from './plan-runtime';
import { parseProposalCommand, type ProposalCreateCall } from './proposal-runtime';
import { proposalViaGateway } from './platform-mock';
import { GATEWAY_INVOCATION, parseEnvelope, platformAuthFailureFromResponses, selectionClarificationFromResponses, textFromContent, type PlatformAuthFailure, type SelectionClarification } from './platform-contract';
import { validatePlanEntities, type PlanArtifactBoundary } from './turn-contract';

/**
 * 同一子任务内计划被拒的收敛上限（Phase 6 验收补丁）。计划被拒是确定性信号
 * （实体越权 / 格式无效），反复重提只会空转模型预算——超过上限即 terminal block，
 * 让 worker 收手向用户说明缺什么。5 次宽容正常试错，合法流程不会触碰。
 */
const MAX_DECLINED_PLANS_PER_TASK = 5;

/**
 * 本轮 scratch 位置（`tmp/<requestId>`）：worker 唯一可写位置。
 *
 * 一处派生两处消费——提案 payload 边界检查（decideProposalCreation）与计划实体校验的
 * 产物路径豁免（validatePlanEntities 的第三个参数）。判据本身只有一份（serve-gate 的
 * workspaceRelPath + isInsideScratch），这里只负责"本轮是哪个位置"这一个事实。
 */
function scratchDirFor(requestId: string | undefined): string | null {
  return requestId ? `tmp/${requestId}` : null;
}

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
 */
export function serveGateStepText(event: Pick<ServeGateEvent, 'label' | 'keyArgs'>): string | null {
  return event.label ? operationStepText(event.label, event.keyArgs) : null;
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
   */
  onAllowedBash?: (kind: GateInvocationKind) => void;
}): (event: ServeGateEvent) => void {
  return (event) => {
    if (event.tool === 'bash' && event.allowed && event.invocation) sink.onAllowedBash?.(event.invocation);
    const step = serveGateStepText(event);
    if (step) sink.onStep(step);
    sink.audit?.({ ...event, requestId: sink.requestId });
  };
}

/**
 * 平台计划门以"计划里含非只读 operation"拒绝时，该给用户哪句话。
 *
 * 为什么必须分流：平台按"是不是只读"拒绝计划，而拒绝名单里混着两类完全不同的调用——
 *   ① 要用户确认的写类调用（平台语义表 confirm=true）：部署没开放写，用户该找管理员
 *      → WRITE_NOT_ENABLED；
 *   ② 根本不需要计划的调用（平台语义表 plan=false，如纯本地处理）：它不该被放进计划，
 *      直接调用即可 → PLAN_NOT_PLANNABLE。
 * ②曾被①的话术答复（"请联系管理员开通写入权限"），用户照着去要一个本来就不该要的权限
 * ——已实证的误导。判据因此是平台 access 语义表的 confirm 列（要不要用户确认），不是
 * 错误码名：宿主不按码名猜语义，也不镜像平台的 access 词表。
 *
 * 宁缺勿猜：拿不到语义表（平台还没下发 / 派生失败 / operation 未登记）时按②处理——
 * "不要放进计划"对任何调用都是安全的下一步，而"未开放写入权限"是一句可能错误的归因。
 */
export function planNotReadOnlyCode(
  calls: readonly PlanCall[],
  semantics: OperationSemantics | undefined,
): 'WRITE_NOT_ENABLED' | 'PLAN_NOT_PLANNABLE' {
  const needsConfirm = calls.some((call) => isWriteAccess(semantics?.get(call.operation)));
  return needsConfirm ? 'WRITE_NOT_ENABLED' : 'PLAN_NOT_PLANNABLE';
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
   * 提案创建网关路径开关（W2；测试替身注入点）。缺省经 options.env 读
   * `FSHINE_PROPOSAL_VIA_GATEWAY`（默认关 = 不拦截，走今天的文本路径）。
   */
  proposalViaGateway?: boolean;
  /**
   * A1：绕开平台执行器的告警出口（披露是增强不是门——与附件披露、计划通知同族）。
   * 判据见 platformExecutorBypassed；调用方只负责留痕（审计/日志），不得据此改回合结果。
   */
  onExecutorBypassed?: (event: PlatformExecutorBypassedEvent) => void;
}

export interface PiCodingWorkerSessionOptions {
  knowledgePaths?: readonly string[];
  sensitivePaths?: readonly string[];

  cwd: string;
  skillRoots: readonly string[];
  systemPrompt: string;
  sessionId?: string;
  requestId?: string;
  agentDir: string;
  modelConfig: CodingModelConfig;
  serveGateAudit?: (event: ServeGateEvent) => void;
  /** 用户可见进度帧出口（宿主 → 渠道）：平台操作帧与计划提交帧都走这里。 */
  onStep?: (text: string) => void;
  onNotice?: (text: string) => Promise<void>;
  planCliRunner?: PlanCliRunner;
  planActivationSecret?: string;
  onPendingPlan?: (plan: PendingPlanConfirmation) => void;
  turnDeclaration?: TurnDriverInput['turnDeclaration'];
  /** 领域无关的实体来源：宿主注入，供计划校验做逐字包含判定（架构 §2 第 9 条）。 */
  entitySources?: TurnDriverInput['entitySources'];
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
   * 当前委托主体的有效能力（宿主注入，TurnDriverInput.capabilities 的透传）。
   * 写关闭判据（D-075）的输入：计划含写类 operation 且能力不含 write 时，宿主在
   * 计划评估前拦截并合成写关闭话术。缺省视为只读。
   */
  capabilities?: readonly string[];
  /**
   * operation → 平台 access 语义表（平台 `operation list --json` 派生，测试替身注入点）；
   * 缺省本会话自派生一次（失败 = 空表 = 写类判定不生效，平台门禁照旧兜底）。
   */
  operationSemantics?: OperationSemantics;
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
   * 开关状态（W2，宿主注入）：false = 本会话完全不拦截提案命令（今天的文本路径）。
   * 缺省读进程 env 的 `FSHINE_PROPOSAL_VIA_GATEWAY`（默认关）。
   */
  proposalViaGateway?: boolean;
  /**
   * 提案创建拦截的结局出口（驱动侧 latch 用，与 onPendingPlan 同族）：completed /
   * write_closed 时调用，驱动据此在结果时刻用宿主持有的文本终结本回合。
   */
  onProposalOutcome?: (outcome: Extract<ProposalCreationOutcome, { status: 'completed' | 'write_closed' }>) => void;
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
  /**
   * 本回合是否发生过写关闭拦截（D-075）：worker 提交过含写类 operation 的计划而部署
   * 未开放 write 能力，宿主在计划评估前当场拦下。驱动据此在结果时刻用宿主合成的写关闭
   * 话术整体替换终稿——T7 事故形态（模型停在准备阶段、承诺"即可产出录入提案"却永不
   * 抵达提案步）下，worker 文本不能原样成为用户回复。
   */
  writeClosed: () => boolean;
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
    const loading = loadOperationLabels(root).catch(() => new Map<string, string>());
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
    const loading = loadOperationArgStyles(root).catch(() => new Map<string, KeyArgStyle>());
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
    const loading = loadOperationArgSpecs(root).catch(() => new Map<string, never>());
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
    const loading = loadOperationSemantics(root).catch(() => new Map<string, AccessSemantics>());
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
    const loading = loadOperationProtocols(root).catch(() => new Map<string, string>());
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
      let proposalOutcome: Extract<ProposalCreationOutcome, { status: 'completed' | 'write_closed' }> | undefined;
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
      const { session, currentPlan, needsClue, writeClosed } = await createPiCodingWorkerSession({
        onPlanSubmitted: (calls) => { plannedCalls = calls; },
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        operationLabels: await operationLabelsFor(input.cwd),
        operationArgStyles: await operationArgStylesFor(input.cwd),
        // access 语义表（D-075 写关闭前置判据与计划门拒绝分流的平台数据面）与能力声明
        // （宿主持有）一起进会话：beforeToolCall 里对提交的计划做写类扫描。
        operationSemantics: await operationSemanticsFor(input.cwd),
        // 协议角色表（提案创建拦截的机械来源）与开关状态、宿主出口一起进会话。
        operationProtocols: await operationProtocolsFor(input.cwd),
        proposalViaGateway: options.proposalViaGateway ?? proposalViaGateway(options.env),
        ...(input.onCreateProposal ? { onCreateProposal: input.onCreateProposal } : {}),
        capabilities: input.capabilities,
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
            options.serveGateAudit?.(event);
          },
          onAllowedBash: (kind) => {
            gateCalls += 1;
            if (kind === 'executor') executorCalls += 1;
            else if (kind === 'local') localCalls += 1;
            else auxiliaryCalls += 1;
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
        planActivationSecret: options.planActivationSecret ?? options.env.DZ_PLAN_ACTIVATION_SECRET,
        onPendingPlan: (plan) => { pendingPlan = plan; },
        onProposalOutcome: (outcome) => { proposalOutcome = outcome; },
        turnDeclaration: input.turnDeclaration,
        entitySources: input.entitySources,
      });
      const footprint = (): string => `${gateCalls} 次 ${GATEWAY_INVOCATION} 调用`;
      // 写关闭终稿（D-075）：本回合拦下过含写类 operation 的计划（部署未开放 write 能力）
      // 时，委派结果的文本由宿主合成的话术整体替换。为什么必须在结果时刻合成而不是只给
      // worker 一条 PLAN STOP：T7 事故形态——模型走了完整的"录入准备"流程（行为优秀），
      // 然后停在准备阶段、承诺"即可产出录入提案"，永不抵达提案步。若只把写关闭话术当作
      // 拦截理由交给 worker，终稿就是 worker 的准备过程与承诺——用户永远不知道写权限是
      // 关闭的。宿主在此直接把确定性话说清楚，措辞复用 error-codes.ts 的 WRITE_NOT_ENABLED
      // 唯一来源（与计划门拒绝、提案路径 capability 检查同一句），不新写第二份。
      // 等用户确认门（pendingPlan）不替换：那一轮的真实状态是"等宿主验证真实确认"，
      // 确认机制不被这层覆盖。结构化字段（planFacts/execution/activatedPlan…）原样保留
      // ——它们是宿主机械事实，与终稿文本的替换互不相干。
      const closureText = (): string | null =>
        writeClosed() && !pendingPlan ? messageTextFor('WRITE_NOT_ENABLED') : null;
      // 提案创建拦截的终稿（B 波 B3）：宿主办调平台 create 成功（或宿主写授权不成立）时，
      // 本回合以此终结，`text` 是宿主持有的确定性文本——平台 summaryText 原样 + 通用确认行
      // （completed）或写关闭话术（write_closed）。为什么必须整体替换而不是让 worker 接着说：
      // 用户这一刻需要的是"提案已登记 + 确认码"，worker 的后续叙述只会稀释它；而确认码**只**
      // 出现在这段文本里（给 worker 的拦截理由不含码），所以终稿必须来自这里而不是转录。
      // 结构化字段（planFacts/execution）照常带上：它们是宿主机械事实。
      // 优先于 closureText()：写关闭那一态的文本由宿主按具体原因合成（能力关闭 / 授权名单
      // 限制模式），不是一句通用 WRITE_NOT_ENABLED。
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
          ...(outcome.status === 'completed' ? { proposalCreated: { proposalId: outcome.proposalId } } : { writeClosed: true }),
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
        if (gateCalls <= 0) return undefined;
        const plan = executedPlan ?? currentPlan();
        return { planId: plan?.planId ?? '', version: plan?.version ?? 0, calls: gateCalls };
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
      // the SDK Agent rather than persisting a second session file in 17dz.
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
      // 平台健康信号（Lane 2）：本回合平台交互是否以登录/凭据类失败收尾。判据只有平台
      // 错误信封的码（platform-contract 唯一适配层，exit 非零 + 登录族信封码），与
      // clarification 同一边界（只看本回合新增消息）——上一回合遗留的失败信封不会越权
      // 替这一回合报警。真实形态：网关调用 exit 1 + NEEDS_LOGIN/AUTH_* 信封，worker
      // 诚实报告"登录凭据已过期"；宿主据此记账，连续失败即冷却，不再逐轮重试式重查。
      const authFailureResult = (): { authFailure: PlatformAuthFailure } | Record<string, never> => {
        const failure = platformAuthFailureFromResponses(session.agent.state.messages.slice(initialMessageCount));
        return failure ? { authFailure: failure } : {};
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
      // SDK 会话事件（tool_execution_start / agent_start / agent_end）是内部协议名，
      // 一律不当进度帧外发：用户可见的进度只由 G1 放行事件经 label 驱动产生。
      try {
        // The current ContextTaskRunner already appends the current user
        // message to input.messages. Calling the underlying Agent avoids
        // duplicating it through AgentSession.prompt().
        await session.agent.continue();
        // 提案创建拦截成功（B 波 B3）：本回合以此终结——先于超时/取消/补刀等一切收尾检查。
        // 提案登记是既成事实（平台侧已有提案、宿主已建意图条目），worker 之后说了什么、
        // 这一轮是否超时都不改变它；用户要的是确认码，不是后续叙述。
        const settled = await proposalReply();
        if (settled) return settled;
        if (timedOut || cancelled || session.agent.state.errorMessage) {
          const proof = execution();
          const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
          return { text: closureText() ?? '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...(closureText() ? { writeClosed: true } : {}), ...authFailureResult() };
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
            await session.agent.continue();
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
            return { text: closureText() ?? '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...(closureText() ? { writeClosed: true } : {}), ...authFailureResult() };
          }
        }
        const proof = execution();
        const clue = needs();
        const plan = currentPlan();
        const choice = clarification();
        const facts = planFactsOf(argSpecs, plannedCalls, await operationLabelsFor(input.cwd));
        const closed = closureText();
        // 补刀那一轮里拦截成功也要发声（提案可能在补刀轮才抵达）：与上面同一个理由——
        // 确认码只在这段文本里。恒为 null 时走原有收尾，行为一字不变。
        const settledAfterNudge = await proposalReply();
        return settledAfterNudge ?? {
          text: closed ?? lastAssistantText(session.agent.state.messages),
          ...(closed ? { writeClosed: true } : {}),
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
          // 平台健康信号（Lane 2）：登录/凭据类失败的回合照样可能有执行痕迹（那次失败
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
        // 而确认码只在这段文本里——丢了用户就永远拿不到码。
        const settledAfterError = await proposalReply();
        return settledAfterError ?? { text: closureText() ?? '', messages: session.agent.state.messages, footprint: footprint(), ...(facts ? { planFacts: facts } : {}), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}), ...(closureText() ? { writeClosed: true } : {}), ...authFailureResult() };
      } finally {
        clearTimeout(abortTimer);
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
  let activePlan: { planId: string; version: number } | null = null;
  /** 同任务内计划被拒次数：收敛保护，防 worker 反复重提被拒计划空转整回合。 */
  let declinedPlans = 0;
  /** 写关闭拦截标志（D-075）：本回合拦过含写类 operation 的计划即置位，驱动据此替换终稿。 */
  let writeClosed = false;
  if (options.sessionId) {
    try {
      activePlan = await loadCurrentActivePlan({
        platformRoot: options.cwd,
        taskId: options.sessionId,
        runCli: options.planCliRunner,
      });
    } catch {
      // Fail closed; resumed queries remain blocked until the worker obtains a host-approved plan.
      activePlan = null;
    }
  }
  const activePlanId = (): string | null => activePlan?.planId ?? null;
  // label 表（平台清单第 5 列）：驱动侧已缓存则直接传入，否则本会话派生一次。
  // 派生失败/平台还没给这一列 → 空表 → 零进度帧（安全缺省，不外泄脚本名）。
  const operationLabels = options.operationLabels ?? (await loadOperationLabels(options.cwd));
  // args 规格（flag → 样式）：放行的平台调用才有人类可读参数摘要，规格同样只在
  // 放行分支消费。派生失败/旧版平台 → 空表 → 零参数摘要（安全缺省，不外泄、不猜）。
  const operationArgStyles = options.operationArgStyles ?? (await loadOperationArgStyles(options.cwd));
  // access 语义表（平台 `operation list --json` 的 access 列 × 顶层 accessSemantics 表）：
  // 写关闭前置判定（D-075）与计划门拒绝分流的机械来源。派生失败/平台还没下发这张表 →
  // 空表 → 前置判定不生效（宁缺勿猜，平台计划门与提案路径的既有拒绝照旧兜底），
  // 绝不回退到宿主硬编码 operation 名单或 access 词表。
  const operationSemantics = options.operationSemantics ?? (await loadOperationSemantics(options.cwd));
  // 协议角色表（平台 `operation list --json` 的 protocol 列）：提案创建拦截的机械来源
  // （B 波 B3）。派生失败/平台还没下发这一列 → 空表 → 不拦截（fail-closed 到"这不是提案
  // 调用"），worker 的命令落回 serve 门，由门与平台继续裁决。
  const operationProtocols = options.operationProtocols ?? (await loadOperationProtocols(options.cwd));
  // 开关状态（W2）：关 = 本会话完全不拦提案命令，走今天的文本路径。缺省读进程 env。
  const proposalGateway = options.proposalViaGateway ?? proposalViaGateway();
  // 纠错环线索：宿主在本任务里确定性拒绝过的计划（实体不在三个来源里）。
  // 原因原文就是事实，交给 Main Agent 决定是向用户澄清还是重新派单；
  // 只在此处留痕，绝不扫描 worker 的自然语言回复。
  const needsClues: SubagentNeeds[] = [];
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
    // bin/17dz 网关调用，用不了 sed。于是只能整份重写那 11KB：33 秒模型生成。
    // 而"写 11KB 脚本一次就对"不现实，这类"改一行"的迭代必然反复发生，每次都付 33 秒、
    // 每次还可能引入新错。edit 是精确文本替换，一次替换即改完那一处。
    // 边界与 write 完全同一组（serve-gate 的 decideFileWrite 一份判据）：只准
    // tmp/<requestId>/、禁敏感路径、有体积上限——加工具不等于放写入面。
    tools: ['read', 'ls', 'bash', 'write', 'edit'],
    customTools: [createBashToolDefinition(options.cwd, {
      spawnHook: (context) => ({ ...context, env: createPlanScopedWorkerEnv(context.env, activePlanId()) }),
    }) as never],
  });
  // G1 工具门：首条 bash 须为网关 plan（方案定价+预算），bash 仅许网关调用，
  // read/ls 限知识面；放行与拦截都留痕。platformRoot 用于派生能力清单定价。
  // label 表（平台清单第 5 列）在此传入：放行的平台调用才有人类可读进度帧。
  // access 语义表同样在此传入：计划前置豁免的机械来源——"这个调用要不要过计划门"
  // 读平台语义表的 plan 列，与计划拒绝分流（planNotReadOnlyCode）同一份表、同一个
  // 来源，不存在第二份真相。表由本会话上方加载一次（失败/平台未下发 = 空表 = 一律
  // 照旧要求计划，fail-closed），门内部不再自己 spawn 平台 CLI。
  const gate = createServeGate({
    onEvent: (event) => {
      options.serveGateAudit?.({ ...event, requestId: options.requestId });
    },
    platformRoot: options.cwd,
    operationLabels,
    operationArgStyles,
    operationSemantics,
    knowledgePaths: options.knowledgePaths,
    sensitivePaths: options.sensitivePaths,
    planActive: () => activePlan !== null,
    // 本轮草稿目录：tmp/<requestId>。宿主已有随机源（requestId），不必让 worker 自己随机
    // （它也没有随机手段）。给了它，write 只放行这一个目录——共享 tmp/ 下多个会话同时写
    // tmp/contract.json 会互相覆盖，而覆盖后的产物看不出被谁污染过。
    ...(options.requestId ? { scratchDir: `tmp/${options.requestId}` } : {}),
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
      detail: event.detail ?? '',
    });
  }

  session.agent.beforeToolCall = async (ctx) => {
    const args = (typeof ctx.args === 'object' && ctx.args !== null
      ? ctx.args
      : ctx.toolCall.arguments) as Record<string, unknown>;
    if (ctx.toolCall.name === 'bash') {
      let parsed: ReturnType<typeof parsePlanCallsCommand>;
      try { parsed = parsePlanCallsCommand(String(args?.['command'] ?? '')); }
      catch (error) {
        // 形状不合法的提交也要留痕：这一跳同样是"worker 提交了方案"的事实，只是宿主
        // 解析不出来（2026-10-10 实证：真实运行里 worker 先拿带引号的 JSON 试了一次，
        // 那一次在 tool_calls 里没有任何痕迹）。detail 为空，见 reportPlanSubmission。
        const reason = `PLAN DECLINED：${error instanceof Error ? error.message : '计划格式无效'}`;
        reportPlanSubmission({ reason });
        return { block: true, reason };
      }
      if (parsed) {
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
          const planVerdict = await decidePlanSubmission(parsed);
          reason = planVerdict.reason ?? '';
          return planVerdict;
        } finally {
          // reason 为空只可能是 decidePlanSubmission 自己抛了（此时异常继续往外抛，
          // SDK 把它转成工具错误结果）：记一条占位判定，提交事实不因异常被抹掉。
          reportPlanSubmission({ reason: reason || '计划评估未返回判定', detail: describePlanCalls(parsed.calls) });
        }
      }
      // ── 提案创建拦截（方案 1 · B 波 B3）────────────────────────────────────────
      // 位置：计划解析之后、gate() 之前。为什么必须在 gate 之前：这条路径**提前 return**，
      // 若落进 gate，worker 的网关调用就真的打到平台——平台会创建提案，而宿主持有的意图
      // 条目、确认码、用户可见摘要全都不存在，用户拿不到确认码（A 波标定的缺口形状）。
      //
      // 开关关着时整支不出现（proposalGateway）：影子期两条路都在，关 = 回今天的文本路径。
      const proposalCall = proposalGateway
        ? parseProposalCommand(String(args?.['command'] ?? ''), operationProtocols)
        : null;
      if (proposalCall) return decideProposalCreation(proposalCall);
    }
    return gate({ name: ctx.toolCall.name, arguments: args });
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
    // 落在本轮 scratchDir（tmp/<requestId>）内。理由：payload 路径来自 worker 命令，不检查
    // 就等于让 worker 指使平台去读工作区里任意文件、再把错误信息带回来看——那是一道通用
    // 读取面，与提案业务无关。判据与 write 门同一把尺（workspaceRelPath + isInsideScratch），
    // 不存在第二份路径解析。
    const scratchDir = scratchDirFor(options.requestId);
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
    // completed / write_closed 两种结局交给驱动侧 latch：本回合以此终结，结果时刻的文本
    // 由宿主持有（平台 summaryText + 确认行 / 写关闭话术），不是 worker 文本。
    if (outcome.status === 'completed' || outcome.status === 'write_closed') {
      if (outcome.status === 'write_closed') writeClosed = true;
      options.onProposalOutcome?.(outcome);
    }
    // 给 worker 的确定性消息（**绝不含确认码**：码只出现在给用户的文本里，见 driver 侧
    // proposalReply 的 userText）。措辞是宿主协议前缀 + 平台错误码 / 平台状态，不解释业务。
    const reason = outcome.status === 'completed' ? `PROPOSAL CREATED：${outcome.workerText}`
      : outcome.status === 'write_closed' ? `PROPOSAL WRITE_CLOSED：${outcome.workerText}`
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
    // ── 写关闭前置拦截（D-075，计划扫描）────────────────────────────────────
    // 为什么拦在这里（而不是等平台计划门拒绝、或等模型走到提案步）：这是宿主已机械
    // 解析出 calls 的 operation 名、且尚未放模型执行的最早一点。真实平台 T7 事故——
    // 用户发起录入请求，模型走了完整的"录入准备"流程（逐一核实范围、日期与平衡关系），
    // 行为优秀，但停在准备阶段、承诺"即可产出录入提案"却永不抵达提案步。写关闭话术
    // （WRITE_NOT_ENABLED）原先只挂在提案路径的 capability 检查与平台计划门拒绝上，
    // 模型不走到那儿，用户就永远不知道写权限是关闭的。计划里出现写类 operation 而
    // 本部署能力不含 write 时，这份计划注定跑不完——宿主当场合成写关闭话术终结该轮，
    // 不依赖模型自觉披露。
    // 判据是机械的：calls（宿主解析）× 语义表（平台 access 声明，confirm 列）× capabilities
    // （宿主持有），三个输入没有一个字节从 worker 文本解析。拦截理由复用
    // error-codes.ts 的 WRITE_NOT_ENABLED 唯一来源（与平台门拒绝/提案路径同一句），
    // 不新写措辞；PLAN STOP 是协议前缀（worker 提示词认它 = 直接说明停止原因）。
    // 与实体门禁并列不合并：那个管"参数越权"（可自愈的诊断），这个管"部署没开放写"
    // （终局事实，无可自愈动作）。拦在 evaluate 之前：零平台调用、零写尝试。
    if (planWriteClosed(parsed.calls, operationSemantics, options.capabilities)) {
      writeClosed = true;
      console.info(JSON.stringify({
        event: 'plan_write_not_enabled',
        requestId: options.requestId,
        operations: parsed.calls.map((call) => call.operation).length,
      }));
      return { block: true, reason: `PLAN STOP\n${messageTextFor('WRITE_NOT_ENABLED')}` };
    }
    // 同任务内计划被连续拒绝的收敛保护：计划被拒是确定性信号（实体越权/格式无效），
    // 反复重提同一请求只会空转模型预算。超过上限就terminal block，让 worker 收手
    // 向用户说明，而不是把回合拖到 executor 超时（实测 D1 类请求空转 5 分钟后崩溃）。
    declinedPlans += 1;
    if (declinedPlans > MAX_DECLINED_PLANS_PER_TASK) {
      return {
        block: true,
        // 收敛原因收口在 error-codes.ts（三要素：码 + 期望/实际/正确形态）；
        // PLAN STOP 是协议前缀（worker 提示词认它），原因本体来自表。
        reason: `PLAN STOP：${messageFor('DECLINED_PLAN_LIMIT', `已被连续拒绝 ${declinedPlans} 次`)}`,
      };
    }
    if (options.entitySources) {
      // 领域无关的实体来源校验（架构 §2 第 9 条）：计划里的每个实体都必须能在
      // 「当前消息 / 检索证据 / 本任务迄今的平台响应 / 本会话用户亲自确立过的实体」
      // 里逐字找到。平台响应从当前会话已产生的 tool_result 里收集——执行层调目录
      // 查询拿到的唯一候选名就逐字住在这里面，宿主不需要懂业务就能放行"合法解析出来
      // 的实体"。第四来源（sessionEntities）由宿主在委派时注入，见 runtime.ts。
      //
      // 第三个参数（产物路径豁免，2026-10-13 实测假拒修复）：worker 把 payload 写进
      // 本轮 scratch 后按路径排进计划，该路径不是领域实体、不在任何来源里，逐字包含
      // 必然假拒，重试还会撞 DECLINED_PLAN_LIMIT 终局。判据与提案 payload 边界检查
      // 同一把尺（workspaceRelPath + isInsideScratch，见 turn-contract 的
      // PlanArtifactBoundary），只有本轮 scratch 内的路径免检。requestId 缺失（测试
      // 替身 / 老路径）时不传 = 豁免整支不出现，判定与从前一字不差。
      const scratchDir = scratchDirFor(options.requestId);
      const artifactBoundary: PlanArtifactBoundary | undefined = scratchDir
        ? { workspaceRoot: options.cwd, scratchDir }
        : undefined;
      const scopeError = validatePlanEntities(parsed.calls, {
        ...options.entitySources,
        platformResponses: [
          ...(options.entitySources.platformResponses ?? []),
          ...collectPlatformResponses(session.agent.state.messages),
        ],
      }, artifactBoundary);
      if (scopeError) {
        activePlan = null;
        needsClues.push({ missing: ['请求中未给出的对象'], reason: scopeError });
        // 实体越权原因收口在 error-codes.ts（三要素）；PLAN DECLINED 是协议前缀。
        return { block: true, reason: `PLAN DECLINED：${messageFor('ENTITY_OUT_OF_SCOPE', scopeError)}` };
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
      });
      if (plan.status === 'active') {
        activePlan = { planId: plan.planId, version: plan.version };
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
      // 同一张拒绝名单里混着两类调用——要用户确认的写类调用（部署没开放写 →
      // WRITE_NOT_ENABLED）与根本不需要计划的本地处理（曾经被用户看到"请联系管理员
      // 开通写入权限"，已实证的误导 → PLAN_NOT_PLANNABLE）。按码名猜语义就是按字符串
      // 判权限，那正是本次要拆掉的东西。既有活跃计划照常恢复：被拒的是新提交，
      // 不是已激活的范围。
      if (error instanceof Error && error.message.includes('PLAN_OPERATION_NOT_READ_ONLY')) {
        activePlan = previousPlan;
        return { block: true, reason: `PLAN STOP\n${messageTextFor(planNotReadOnlyCode(parsed.calls, operationSemantics))}` };
      }
      return { block: true, reason: `PLAN PAUSED：${error instanceof Error ? error.message : '计划评估失败'}；未执行平台操作。` };
    }
  }

  const loaded = loader.getSkills().skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
  }));
  return { session, skills: loaded, currentPlan: () => activePlan, needsClue: () => needsClues.at(-1) ?? null, writeClosed: () => writeClosed };
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
 * 本任务迄今的平台响应：会话转录里的 tool_result 正文。它们既是"上一轮查到了什么"的
 * 载体，也是计划实体来源校验的第三个来源——执行层调目录查询拿到的唯一候选名逐字来自
 * 这里，宿主因此不需要懂业务就能判"这是合法解析出来的"。
 */
function collectPlatformResponses(messages: readonly AgentMessage[]): string[] {
  const responses: string[] = [];
  for (const message of messages) {
    if ((message as { role?: string }).role !== 'toolResult') continue;
    const text = textFromContent((message as { content?: unknown }).content);
    if (text.trim()) responses.push(text);
  }
  return responses;
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
