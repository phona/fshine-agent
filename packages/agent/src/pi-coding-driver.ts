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
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { createServeGate, type ServeGateEvent } from './serve-gate';
import { createPlanScopedWorkerEnv, evaluateAndActivatePlan, loadCurrentActivePlan, parsePlanCallsCommand, type PlanCliRunner, type PendingPlanConfirmation } from './plan-runtime';
import { validatePlanAgainstTurnDeclaration } from './turn-contract';

export interface PiCodingTurnDriverOptions {
  /** 知识面/敏感路径规则（由 context profile 传入 G1）。 */
  knowledgePaths?: readonly string[];
  sensitivePaths?: readonly string[];

  env: Record<string, string | undefined>;
  /** Keep SDK auth/session files outside the mounted platform workspace. */
  agentDir?: string;
  /** G1 工具门事件留痕（放行与拦截都上报，落 tool_calls 审计）。 */
  serveGateAudit?: (event: ServeGateEvent) => void;
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
  onNotice?: (text: string) => Promise<void>;
  planCliRunner?: PlanCliRunner;
  planActivationSecret?: string;
  onPendingPlan?: (plan: PendingPlanConfirmation) => void;
  turnDeclaration?: TurnDriverInput['turnDeclaration'];
}

export interface PiCodingWorkerSession {
  session: AgentSession;
  skills: readonly { name: string; description: string; filePath: string }[];
  /** Currently activated plan for this worker task, if any. */
  currentPlan: () => { planId: string; version: number } | null;
}

interface CodingModelConfig {
  runtime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Create a headless pi-coding-agent driver for trusted context workers. */
export function createPiCodingTurnDriver(options: PiCodingTurnDriverOptions): TurnDriver {
  let modelPromise: Promise<CodingModelConfig> | undefined;

  return {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      if (!input.cwd) throw new ToolUserError('Context Worker 缺少受信工作目录。');
      const { runtime, model, thinkingLevel } = await (modelPromise ??= createCodingModel(options));
      const agentDir = options.agentDir ?? process.env.FSHINE_PI_AGENT_DIR ?? `${process.cwd()}/data/pi-agent`;
      // 执行面回执：G1 事件计数（放行的 bash 才构成对平台的真实触达）
      let gateCalls = 0;
      let pendingPlan: PendingPlanConfirmation | undefined;
      const { session, currentPlan } = await createPiCodingWorkerSession({
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        serveGateAudit: (event) => {
          if (event.tool === 'bash' && event.allowed) gateCalls += 1;
          options.serveGateAudit?.({ ...event, requestId: input.requestId });
        },
        knowledgePaths: input.knowledgePaths,
        sensitivePaths: input.sensitivePaths,
        onNotice: input.onNotice,
        planCliRunner: options.planCliRunner,
        planActivationSecret: options.planActivationSecret ?? options.env.DZ_PLAN_ACTIVATION_SECRET,
        onPendingPlan: (plan) => { pendingPlan = plan; },
        turnDeclaration: input.turnDeclaration,
      });
      const footprint = (): string => `${gateCalls} 次 bin/17dz 调用`;
      // Host-verifiable proof that this delegated turn really executed against the platform:
      // an activated plan plus at least one allowed bin/17dz invocation.
      const execution = (): { planId: string; version: number; calls: number } | undefined => {
        const plan = currentPlan();
        return plan && gateCalls > 0 ? { planId: plan.planId, version: plan.version, calls: gateCalls } : undefined;
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
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          input.onStep(`worker_tool:${event.toolName}`);
        } else if (event.type === 'agent_start') {
          input.onStep('worker_agent_started');
        } else if (event.type === 'agent_end') {
          input.onStep('worker_agent_finished');
        }
      });
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
        return {
          text: lastAssistantText(session.agent.state.messages),
          messages: session.agent.state.messages,
          footprint: footprint(),
          ...(proof ? { execution: proof } : {}),
          ...(pendingPlan ? { pendingPlan } : {}),
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
        unsubscribe();
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
  const gate = createServeGate({
    onEvent: (event) => {
      options.serveGateAudit?.({ ...event, requestId: options.requestId });
    },
    platformRoot: options.cwd,
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
        if (options.turnDeclaration) {
          const scopeError = validatePlanAgainstTurnDeclaration(options.turnDeclaration, parsed.calls);
          if (scopeError) {
            activePlan = null;
            return { block: true, reason: `PLAN DECLINED：${scopeError} 请严格按本轮宿主申报的范围执行，或向用户澄清。` };
          }
        }
        const previousPlan = activePlan;
        activePlan = null;
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
  return { session, skills: loaded, currentPlan: () => activePlan };
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
