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
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai/compat';
import type { DiscoveredTool } from '@fshine/contracts';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './driver';
import { KIMI_THINKING_LEVEL_MAP } from './pi-driver';
import { createServeGate, type ServeGateEvent } from './serve-gate';

export interface PiCodingTurnDriverOptions {
  env: Record<string, string | undefined>;
  /** Keep SDK auth/session files outside the mounted platform workspace. */
  agentDir?: string;
  /** G1 工具门事件留痕（放行与拦截都上报，落 tool_calls 审计）。 */
  serveGateAudit?: (event: ServeGateEvent) => void;
}

export interface PiCodingWorkerSessionOptions {
  cwd: string;
  skillRoots: readonly string[];
  systemPrompt: string;
  sessionId?: string;
  requestId?: string;
  agentDir: string;
  modelConfig: CodingModelConfig;
  serveGateAudit?: (event: ServeGateEvent) => void;
}

export interface PiCodingWorkerSession {
  session: AgentSession;
  skills: readonly { name: string; description: string; filePath: string }[];
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
      const { session } = await createPiCodingWorkerSession({
        cwd: input.cwd,
        skillRoots: input.skillRoots ?? [],
        systemPrompt: input.systemPrompt,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentDir,
        modelConfig: { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}) },
        serveGateAudit: options.serveGateAudit,
      });

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
          return { text: '', messages: session.agent.state.messages };
        }
        return {
          text: lastAssistantText(session.agent.state.messages),
          messages: session.agent.state.messages,
        };
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pi_coding_worker_error',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        return { text: '', messages: session.agent.state.messages };
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
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelConfig.runtime,
    model: options.modelConfig.model,
    ...(options.modelConfig.thinkingLevel ? { thinkingLevel: options.modelConfig.thinkingLevel } : {}),
    resourceLoader: loader,
    sessionManager,
    // Native SDK tools are intentionally owned by this Worker driver.
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
  });
  // G1 工具门：bash 仅许 serve.sh，read 类拒敏感路径；放行与拦截都留痕。
  const gate = createServeGate((event) => {
    options.serveGateAudit?.({ ...event, requestId: options.requestId });
  });
  session.agent.beforeToolCall = (ctx) =>
    Promise.resolve(gate({
      name: ctx.toolCall.name,
      arguments: (typeof ctx.args === 'object' && ctx.args !== null
        ? ctx.args
        : ctx.toolCall.arguments) as Record<string, unknown>,
    }));
  const loaded = loader.getSkills().skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
  }));
  return { session, skills: loaded };
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
