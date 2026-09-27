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
import { ToolUserError, type DriverMessage, type SubagentNeeds, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { createServeGate, type ServeGateEvent } from './serve-gate';
import { loadOperationArgStyles, loadOperationLabels, type KeyArgStyles, type KeyArgStyle, type OperationLabels } from './operation-labels';
import { messageFor } from './error-codes';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, loadCurrentActivePlan, parsePlanCallsCommand, type PlanCliRunner, type PendingPlanConfirmation } from './plan-runtime';
import { GATEWAY_INVOCATION, parseEnvelope, selectionClarificationFromResponses, textFromContent, type SelectionClarification } from './platform-contract';
import { validatePlanEntities } from './turn-contract';

/**
 * 同一子任务内计划被拒的收敛上限（Phase 6 验收补丁）。计划被拒是确定性信号
 * （实体越权 / 格式无效），反复重提只会空转模型预算——超过上限即 terminal block，
 * 让 worker 收手向用户说明缺什么。5 次宽容正常试错，合法流程不会触碰。
 */
const MAX_DECLINED_PLANS_PER_TASK = 5;

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
  /** 放行的平台调用计数（执行面回执用）。 */
  onAllowedBash?: () => void;
}): (event: ServeGateEvent) => void {
  return (event) => {
    if (event.tool === 'bash' && event.allowed) sink.onAllowedBash?.();
    const step = serveGateStepText(event);
    if (step) sink.onStep(step);
    sink.audit?.({ ...event, requestId: sink.requestId });
  };
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
  planCliRunner?: PlanCliRunner;
  planActivationSecret?: string;
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

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      if (!input.cwd) throw new ToolUserError('Context Worker 缺少受信工作目录。');
      const { runtime, model, thinkingLevel } = await (modelPromise ??= createCodingModel(options));
      const agentDir = options.agentDir ?? process.env.FSHINE_PI_AGENT_DIR ?? `${process.cwd()}/data/pi-agent`;
      // 执行面回执：G1 事件计数（放行的 bash 才构成对平台的真实触达）
      let gateCalls = 0;
      // 第一个被放行的 bash 调用发生时的计划身份（latch，见 onAllowedBash）。
      // 为什么不在结果时刻读 currentPlan()：worker 常常在真实调用之后继续重提方案——
      // beforeToolCall 里 activePlan 先置空再 evaluateAndActivatePlan，后续提交可能 scope
      // 识别失败/被拒，最终 activePlan 停在上一次提交后的 null。那时调用真发生过
      // （gateCalls > 0）但 currentPlan() 已是 null。执行足迹要回答的是"本轮有没有真实
      // 触达平台、当时挂在哪份计划下"，与回合收尾时计划恰好是什么状态无关，所以身份在
      // 放行瞬间 latch 下来，而不是结果时刻现读。
      let executedPlan: { planId: string; version: number } | null = null;
      // 「计划已激活却零执行」的补一刀边界：**每回合一次**，不是整个 driver 生命周期一次。
      // 生产上一个服务进程只有一个 driver 实例管所有回合，"生命周期一次"会让第二次同样故障
      // （可能一小时后、另一个用户）永远不再追问，用户只能手动回复"继续" → 下一回合重新委派
      // → 重新计划通知 → 再坏 → 再说"继续"，一个把用户卷进去的重试循环；而补一刀多花的只
      // 是一个模型轮，比它替代的那条手动循环便宜得多。系统性故障的根由
      // activated_plan_not_executed 告警日志交给运维，不需要用"只补一次"当信号。
      // 回合内仍然只补一次（内联单次，见下方 if）：绝不在同一回合里反复推同一个模型。
      let activatedPlanNudged = false;
      let pendingPlan: PendingPlanConfirmation | undefined;
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
      const { session, currentPlan, needsClue } = await createPiCodingWorkerSession({
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        operationLabels: await operationLabelsFor(input.cwd),
        operationArgStyles: await operationArgStylesFor(input.cwd),
        // G1 事件 → 审计 + 进度帧：同一条生产接线（createServeGateAuditSink）
        serveGateAudit: createServeGateAuditSink({
          onStep: stepOnce,
          requestId: input.requestId,
          audit: options.serveGateAudit,
          onAllowedBash: () => {
            gateCalls += 1;
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
        turnDeclaration: input.turnDeclaration,
        entitySources: input.entitySources,
      });
      const footprint = (): string => `${gateCalls} 次 ${GATEWAY_INVOCATION} 调用`;
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
      const remaining = input.deadline - Date.now();
      if (remaining <= 0) {
        const messages = session.agent.state.messages;
        session.dispose();
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
        if (timedOut || cancelled || session.agent.state.errorMessage) {
          const proof = execution();
          return { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}) };
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
            return { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}) };
          }
        }
        const proof = execution();
        const clue = needs();
        const plan = currentPlan();
        const choice = clarification();
        return {
          text: lastAssistantText(session.agent.state.messages),
          messages: session.agent.state.messages,
          footprint: footprint(),
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
        };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_coding_worker_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        const proof = execution();
        return { text: '', messages: session.agent.state.messages, footprint: footprint(), ...(proof ? { execution: proof } : {}), ...(pendingPlan ? { pendingPlan } : {}) };
      } finally {
        clearTimeout(abortTimer);
        input.signal?.removeEventListener('abort', cancel);
        session.dispose();
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
  // 纠错环线索：宿主在本任务里确定性拒绝过的计划（实体不在三个来源里）。
  // 原因原文就是事实，交给 Main Agent 决定是向用户澄清还是重新派单；
  // 只在此处记录，绝不扫描 worker 的自然语言回复。
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
    tools: ['read', 'ls', 'bash'],
    customTools: [createBashToolDefinition(options.cwd, {
      spawnHook: (context) => ({ ...context, env: createPlanScopedWorkerEnv(context.env, activePlanId()) }),
    }) as never],
  });
  // G1 工具门：首条 bash 须为网关 plan（方案定价+预算），bash 仅许网关调用，
  // read/ls 限知识面；放行与拦截都留痕。platformRoot 用于派生能力清单定价。
  // label 表（平台清单第 5 列）在此传入：放行的平台调用才有人类可读进度帧。
  const gate = createServeGate({
    onEvent: (event) => {
      options.serveGateAudit?.({ ...event, requestId: options.requestId });
    },
    platformRoot: options.cwd,
    operationLabels,
    operationArgStyles,
    knowledgePaths: options.knowledgePaths,
    sensitivePaths: options.sensitivePaths,
    planActive: () => activePlan !== null,
  });
  session.agent.beforeToolCall = async (ctx) => {
    const args = (typeof ctx.args === 'object' && ctx.args !== null
      ? ctx.args
      : ctx.toolCall.arguments) as Record<string, unknown>;
    if (ctx.toolCall.name === 'bash') {
      let parsed: ReturnType<typeof parsePlanCallsCommand>;
      try { parsed = parsePlanCallsCommand(String(args?.['command'] ?? '')); }
      catch (error) { return { block: true, reason: `PLAN DECLINED：${error instanceof Error ? error.message : '计划格式无效'}` }; }
      if (parsed) {
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
          // 「当前消息 / 检索证据 / 本任务迄今的平台响应」里逐字找到。平台响应从当前
          // 会话已产生的 tool_result 里收集——执行层调目录查询拿到的唯一候选名就
          // 逐字住在这里面，宿主不需要懂业务就能放行"合法解析出来的实体"。
          const scopeError = validatePlanEntities(parsed.calls, {
            ...options.entitySources,
            platformResponses: [
              ...(options.entitySources.platformResponses ?? []),
              ...collectPlatformResponses(session.agent.state.messages),
            ],
          });
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
          return { block: true, reason: `PLAN PAUSED：${error instanceof Error ? error.message : '计划评估失败'}；未执行平台操作。` };
        }
      }
    }
    return gate({ name: ctx.toolCall.name, arguments: args });
  };
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
