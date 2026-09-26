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
import { ToolUserError, type SubagentNeeds, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { createServeGate, type ServeGateEvent } from './serve-gate';
import { loadOperationLabels, type OperationLabels } from './operation-labels';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, loadCurrentActivePlan, parsePlanCallsCommand, type PlanCliRunner, type PendingPlanConfirmation } from './plan-runtime';
import { parseEnvelope } from './platform-contract';
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

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      if (!input.cwd) throw new ToolUserError('Context Worker 缺少受信工作目录。');
      const { runtime, model, thinkingLevel } = await (modelPromise ??= createCodingModel(options));
      const agentDir = options.agentDir ?? process.env.FSHINE_PI_AGENT_DIR ?? `${process.cwd()}/data/pi-agent`;
      // 执行面回执：G1 事件计数（放行的 bash 才构成对平台的真实触达）
      let gateCalls = 0;
      let pendingPlan: PendingPlanConfirmation | undefined;
      const { session, currentPlan, needsClue } = await createPiCodingWorkerSession({
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        operationLabels: await operationLabelsFor(input.cwd),
        // G1 事件 → 审计 + 进度帧：同一条生产接线（createServeGateAuditSink）
        serveGateAudit: createServeGateAuditSink({
          onStep: input.onStep,
          requestId: input.requestId,
          audit: options.serveGateAudit,
          onAllowedBash: () => { gateCalls += 1; },
        }),
        onStep: input.onStep,
        knowledgePaths: input.knowledgePaths,
        sensitivePaths: input.sensitivePaths,
        onNotice: input.onNotice,
        planCliRunner: options.planCliRunner,
        planActivationSecret: options.planActivationSecret ?? options.env.DZ_PLAN_ACTIVATION_SECRET,
        onPendingPlan: (plan) => { pendingPlan = plan; },
        turnDeclaration: input.turnDeclaration,
        entitySources: input.entitySources,
      });
      const footprint = (): string => `${gateCalls} 次 bin/17dz 调用`;
      // Host-verifiable proof that this delegated turn really executed against the platform:
      // an activated plan plus at least one allowed bin/17dz invocation.
      const execution = (): { planId: string; version: number; calls: number } | undefined => {
        const plan = currentPlan();
        return plan && gateCalls > 0 ? { planId: plan.planId, version: plan.version, calls: gateCalls } : undefined;
      };
      // 纠错环（架构 §3）：执行不了就回报"缺什么"。只在**没有执行痕迹**时派生——
      // 真执行过的回合不缺信息，把成功的结果拖进无谓的追问只会打扰用户。
      // 两个来源都是确定性的：宿主计划拦截的原因原文、平台 RESULT 信封的错误码。
      const needs = (): SubagentNeeds | undefined => {
        if (execution()) return undefined;
        return needsClue() ?? needsFromPlatformResponses(session.agent.state.messages) ?? undefined;
      };

      // TaskStore remains the source of truth.  Restore its transcript into
      // the SDK Agent rather than persisting a second session file in 17dz.
      session.agent.state.messages = input.messages;
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
        const proof = execution();
        const clue = needs();
        return {
          text: lastAssistantText(session.agent.state.messages),
          messages: session.agent.state.messages,
          footprint: footprint(),
          ...(proof ? { execution: proof } : {}),
          ...(pendingPlan ? { pendingPlan } : {}),
          ...(clue ? { needs: clue } : {}),
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
  // G1 工具门：首条 bash 须为 bin/17dz plan（方案定价+预算），bash 仅许 bin/17dz，
  // read/ls 限知识面；放行与拦截都留痕。platformRoot 用于派生能力清单定价。
  // label 表（平台清单第 5 列）在此传入：放行的平台调用才有人类可读进度帧。
  const gate = createServeGate({
    onEvent: (event) => {
      options.serveGateAudit?.({ ...event, requestId: options.requestId });
    },
    platformRoot: options.cwd,
    operationLabels,
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
            reason: `PLAN STOP：本任务的执行计划已被连续拒绝 ${declinedPlans} 次（原因均为实体不在本轮请求/检索证据/平台响应内）。停止重新提交计划，直接用自然语言向用户说明缺什么、建议提供什么。`,
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
            return { block: true, reason: `PLAN DECLINED：${scopeError} 请严格按本轮请求的范围执行，或向用户澄清。` };
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

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item): item is { type: 'text'; text: string } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string'),
  ).map((item) => item.text).join('');
}

// Keep the imported type visible in emitted declarations while documenting
// the worker's deliberate native-tool boundary.
export type PiCodingWorkerTool = DiscoveredTool;
