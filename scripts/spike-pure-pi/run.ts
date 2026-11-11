/**
 * Pure-pi spike runner.
 *
 * 只做四件事：建平台快照、装配 pi Agent（原生工具 + 原生压缩）、逐轮喂用例、
 * 把每轮回复原文落成 JSON。不 import 任何 @fshine/*。
 *
 * 运行（示例，路径都由环境给出，提交进仓的代码里没有绝对路径）：
 *   TMPDIR=... LLM_API_KEY_FILE=... LLM_API_BASE_URL=... LLM_MODEL=... \
 *   PURE_PI_PLATFORM_SRC=... node --import tsx scripts/spike-pure-pi/run.ts --case=C1,C2,A2,D2
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  envApiKeyAuth,
  type Api,
  type Message,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { caseById, type CaseTurn, type SpikeCase } from './cases';
import { compactionSettingsFromEnv, NativeCompactor } from './compaction';
import { buildSystemPrompt } from './prompt';
import { checkGateway, preparePlatform, type PlatformHandle } from './platform';
import { createToolset, type Toolset } from './tools';

interface AssistantTextBlock {
  type: string;
  text?: string;
}

interface TurnRecord {
  index: number;
  user: string;
  reply: string;
  durationMs: number;
  timedOut?: boolean;
  assistantTexts: string[];
  toolCalls: Array<{ toolCallId?: string; name: string; command?: string; output: string; isError: boolean }>;
  compactions: number;
  plans: Array<{ planId: string; decision: string; status?: string }>;
  activations: Array<{ planId: string; evidence: string; ok: boolean; error?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

interface CaseRecord {
  caseId: string;
  title: string;
  startedAt: string;
  finishedAt?: string;
  model: { id: string; baseUrl: string; contextWindow: number };
  platform: { root: string; gateway: string; executor: string | null };
  compaction: { reserveTokens: number; keepRecentTokens: number; events: unknown[] };
  turns: TurnRecord[];
  error?: string;
}

interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  cases: CaseRecord[];
}

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function ensureApiKey(): void {
  if ((process.env['LLM_API_KEY'] ?? '').trim()) return;
  const file = (process.env['LLM_API_KEY_FILE'] ?? '').trim();
  if (!file) throw new Error('缺少 LLM_API_KEY 或 LLM_API_KEY_FILE');
  process.env['LLM_API_KEY'] = readFileSync(file, 'utf8').trim();
}

interface ModelRuntime {
  models: Models;
  model: Model<Api>;
}

function createModelRuntime(): ModelRuntime {
  const baseUrl = (process.env['LLM_API_BASE_URL'] ?? '').replace(/\/+$/, '');
  const modelId = process.env['LLM_MODEL'] ?? '';
  const apiKey = process.env['LLM_API_KEY'];
  if (!baseUrl || !modelId || !apiKey) {
    throw new Error('缺少 LLM_API_BASE_URL / LLM_MODEL / LLM_API_KEY');
  }
  const contextWindowRaw = Number(process.env['PURE_PI_CONTEXT_WINDOW'] ?? '32000');
  const contextWindow = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : 32_000;
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'llm',
    baseUrl,
    reasoning: true,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_000,
  };
  const provider = createProvider({
    id: 'llm',
    name: 'LLM',
    baseUrl,
    auth: { apiKey: envApiKeyAuth('LLM API key', ['LLM_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels({ authContext: defaultProviderAuthContext() });
  models.setProvider(provider);
  const registered = models.getModel('llm', modelId);
  if (!registered) throw new Error(`模型 ${modelId} 注册失败`);
  return { models, model: registered };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const typed = block as AssistantTextBlock;
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function lastAssistantText(messages: AgentMessage[]): { text: string; stopReason?: string; errorMessage?: string } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (message.role === 'assistant') {
      const text = message.stopReason === 'error' || message.stopReason === 'aborted' ? '' : textOfContent(message.content).trim();
      return {
        text,
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      };
    }
  }
  return { text: '' };
}

interface TurnHooks {
  current: TurnRecord | undefined;
  pendingTools: Map<string, TurnRecord['toolCalls'][number]>;
}

function subscribe(agent: Agent, hooks: TurnHooks): void {
  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = textOfContent((event.message as { content?: unknown }).content).trim();
      if (text && hooks.current) hooks.current.assistantTexts.push(text);
      return;
    }
    if (event.type === 'tool_execution_start' && hooks.current) {
      const args = (event.args ?? {}) as { command?: unknown };
      const entry: TurnRecord['toolCalls'][number] = {
        toolCallId: event.toolCallId,
        name: event.toolName,
        ...(typeof args.command === 'string' ? { command: args.command } : {}),
        output: '',
        isError: false,
      };
      hooks.current.toolCalls.push(entry);
      hooks.pendingTools.set(event.toolCallId, entry);
      return;
    }
    if (event.type === 'tool_execution_end') {
      const content = (event.result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      const output = content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text!)
        .join('\n');
      const entry = hooks.pendingTools.get(event.toolCallId);
      if (entry) {
        entry.output = output.slice(0, 2_000);
        entry.isError = event.isError;
        hooks.pendingTools.delete(event.toolCallId);
      } else if (hooks.current) {
        hooks.current.toolCalls.push({ toolCallId: event.toolCallId, name: event.toolName, output: output.slice(0, 2_000), isError: event.isError });
      }
    }
  });
}

async function runTurn(
  agent: Agent,
  turn: CaseTurn,
  index: number,
  timeoutMs: number,
  toolset: Toolset,
  compactor: NativeCompactor,
  hooks: TurnHooks,
): Promise<TurnRecord> {
  const record: TurnRecord = {
    index,
    user: turn.text,
    reply: '',
    durationMs: 0,
    assistantTexts: [],
    toolCalls: [],
    compactions: 0,
    plans: [],
    activations: [],
  };
  const started = Date.now();
  const observationsBefore = toolset.gate.observations.length;
  const activationsBefore = toolset.gate.activations.length;
  if (turn.confirmation) {
    // confirmByUser 自己把记录推进 gate.activations，本轮末尾按区间切片取回，这里不重复塞。
    toolset.gate.confirmByUser();
  }
  const compaction = await compactor.maybeCompact(agent);
  if (compaction) record.compactions += 1;
  hooks.current = record;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      agent.prompt(turn.text),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          agent.abort();
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    record.reply = `(prompt error: ${(error as Error).message})`;
  } finally {
    if (timer) clearTimeout(timer);
    hooks.current = undefined;
  }
  record.timedOut = timedOut;
  record.durationMs = Date.now() - started;
  const finalAssistant = lastAssistantText(agent.state.messages);
  record.stopReason = finalAssistant.stopReason;
  record.errorMessage = finalAssistant.errorMessage;
  record.reply = timedOut
    ? '(turn timeout)'
    : finalAssistant.text || `(empty assistant reply; stopReason=${finalAssistant.stopReason ?? 'none'})`;
  record.plans = toolset.gate.observations.slice(observationsBefore).map((item) => ({
    planId: item.planId,
    decision: item.decision,
    ...(item.status ? { status: item.status } : {}),
  }));
  record.activations = [...record.activations, ...toolset.gate.activations.slice(activationsBefore)];
  return record;
}

async function runCase(
  spikeCase: SpikeCase,
  runtime: ModelRuntime,
  workdir: string,
  options: {
    platformSrc?: string;
    timeoutMs: number;
    contextWindow: number;
    argv: string[];
    onCaseStart?: (record: CaseRecord) => void;
    onTurn?: (record: CaseRecord) => void;
  },
): Promise<CaseRecord> {
  const platform: PlatformHandle = preparePlatform({
    workdir,
    ...(options.platformSrc ? { platformSrc: options.platformSrc } : {}),
    argv: options.argv,
  });
  const record: CaseRecord = {
    caseId: spikeCase.id,
    title: spikeCase.title,
    startedAt: new Date().toISOString(),
    model: {
      id: runtime.model.id,
      baseUrl: runtime.model.baseUrl ?? '',
      contextWindow: options.contextWindow,
    },
    platform: { root: platform.root, gateway: platform.gateway, executor: 'mock' },
    compaction: {
      reserveTokens: compactionSettingsFromEnv(process.env).reserveTokens,
      keepRecentTokens: compactionSettingsFromEnv(process.env).keepRecentTokens,
      events: [],
    },
    turns: [],
  };
  options.onCaseStart?.(record);
  try {
    const listed = checkGateway(platform);
    console.log(JSON.stringify({ event: 'platform_ready', case: spikeCase.id, operations: listed.operations, root: platform.root }));
    const toolset = createToolset(platform, process.env['PURE_PI_PLAN_ACTIVATION_SECRET'] ?? 'pure-pi-spike');
    const compactor = new NativeCompactor(runtime.models, runtime.model, compactionSettingsFromEnv(process.env));
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt({ taskId: `task-${spikeCase.id.toLowerCase()}` }),
        model: runtime.model,
        tools: toolset.tools as AgentTool[],
        messages: [],
      },
      streamFn: runtime.models.streamSimple.bind(runtime.models),
      convertToLlm: (messages) => messages as Message[],
    });
    const hooks: TurnHooks = { current: undefined, pendingTools: new Map() };
    subscribe(agent, hooks);

    const turns = [...spikeCase.turns];
    let followUpUsed = false;
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i]!;
      const turnRecord = await runTurn(agent, turn, i, options.timeoutMs, toolset, compactor, hooks);
      record.turns.push(turnRecord);
      options.onTurn?.(record);
      console.log(JSON.stringify({
        event: 'turn_done',
        case: spikeCase.id,
        index: i,
        ms: turnRecord.durationMs,
        tools: turnRecord.toolCalls.length,
        replyChars: turnRecord.reply.length,
      }));
      // 只在脚本本体的最后一轮追加一次确认回复。确认之后的回复里常带「确认」二字，
      // 不能拿同一条正则再追加，否则会把「确认继续」无限喂回去。
      if (!followUpUsed && i === spikeCase.turns.length - 1 && spikeCase.followUpOnConfirm?.length) {
        const wantsConfirm = toolset.gate.pendingConfirm !== undefined
          || /确认继续|要不要继续|是否继续|请确认/.test(turnRecord.reply);
        if (wantsConfirm) {
          followUpUsed = true;
          turns.push(...spikeCase.followUpOnConfirm);
        }
      }
    }
    record.compaction.events = compactor.events;
  } catch (error) {
    record.error = (error as Error).message;
    console.error(JSON.stringify({ event: 'case_error', case: spikeCase.id, error: record.error }));
  } finally {
    record.finishedAt = new Date().toISOString();
    platform.dispose();
  }
  return record;
}

async function main(): Promise<void> {
  ensureApiKey();
  const argv = process.argv.slice(2);
  const caseIds = (argValue(argv, 'case') ?? 'SELF').split(',').map((id) => id.trim()).filter(Boolean);
  const platformSrc = (argValue(argv, 'platform-src') ?? (process.env['PURE_PI_PLATFORM_SRC'] ?? '').trim()) || undefined;
  const timeoutMs = Number(argValue(argv, 'turn-timeout-ms') ?? process.env['PURE_PI_TURN_TIMEOUT_MS'] ?? '180000');
  const runId = `purepi-${Date.now()}`;
  const workdir = (process.env['PURE_PI_WORKDIR'] ?? '').trim() || mkdtempSync(path.join(os.tmpdir(), 'pure-pi-run-'));
  mkdirSync(workdir, { recursive: true });
  const outPath = (argValue(argv, 'out') ?? '').trim() || path.join(workdir, `${runId}.json`);
  const runtime = createModelRuntime();
  const contextWindow = Number(process.env['PURE_PI_CONTEXT_WINDOW'] ?? '32000');
  console.log(JSON.stringify({
    event: 'run_start',
    runId,
    workdir,
    outPath,
    cases: caseIds,
    model: { id: runtime.model.id, baseUrl: runtime.model.baseUrl, contextWindow },
    platformSrc: platformSrc ? '(provided)' : '(from config)',
  }));

  const run: RunFile = { runId, startedAt: new Date().toISOString(), cases: [] };
  const persist = (): void => {
    writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  };
  for (const id of caseIds) {
    const spikeCase = caseById(id);
    await runCase(spikeCase, runtime, workdir, {
      ...(platformSrc ? { platformSrc } : {}),
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
      contextWindow,
      argv,
      onCaseStart: (record) => {
        run.cases.push(record);
        persist();
      },
      onTurn: persist,
    });
    persist();
  }
  run.finishedAt = new Date().toISOString();
  persist();
  console.log(JSON.stringify({ event: 'run_done', outPath, cases: run.cases.map((c) => ({ id: c.caseId, turns: c.turns.length, error: c.error ?? null })) }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', error: (error as Error).message }));
  process.exitCode = 1;
});
