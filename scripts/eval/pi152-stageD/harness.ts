/**
 * 阶段 D 装配与观测（只读包装，不改产品语义）。
 *
 * 复用生产同源装配：`assembleSessionCore`（`scripts/ask-runtime.ts`）+ 真实 Pi 驱动
 * (`createPiTurnDriver`) + 仓内 dummy 执行层 + SQLite Task Registry + background TaskRunner。
 * 观测只在驱动/模型运行时外包一层记录器：不改提示词、不改工具面、不改压缩配置。
 *
 * 边界：不 deep-import Pi、不改 Pi 源码、不引第二套会话/压缩/任务机制。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime, createPiTurnDriver, piCompactionSettings } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput, TurnDriverResult } from '../../../packages/agent/src/driver-contract';
import type { TaskRegistry, TaskRecord, TaskScope } from '../../../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { assembleSessionCore, createBackgroundDispatch, resolveExecutionFace, type AssembledSession } from '../../ask-runtime';
import { createResourcePolicy } from '../../../packages/agent/src/resource-policy';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createStageDClient, type ExecCallLog, type StageDClient } from './client';
import type { GroupId, StageTurn } from './scenarios';
import { STAGE_D_CONFIG } from './scenarios';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  totalTokens: number;
  /** provider 返回的货币成本；未返回/为 0 = 不可得（不编造）。 */
  cost: number;
}

export interface ModelCallRecord {
  group: GroupId;
  key: string;
  turn: number;
  kind: 'stream' | 'complete';
  isSummary: boolean;
  startedAt: number;
  ms: number | null;
  stopReason: string | null;
  error: string | null;
  usage: Usage | null;
  requestedMaxTokens: number | null;
  /**
   * 线上实际输出上限（provider 请求体 `max_completion_tokens` / `max_tokens`，经 Pi `onPayload`
   * 观测）。`requestedMaxTokens` 是调用方传入值，经 `clampMaxTokensToContext` 后可能更小；
   * 本字段记录**真正发给 provider** 的值，未观测到 = null。
   */
  wireMaxCompletionTokens: number | null;
}

export interface ToolCallRecord {
  group: GroupId;
  key: string;
  turn: number;
  agent: 'main' | 'worker';
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  errorText?: string;
  startedAt: string;
  elapsedMs: number;
}

export interface CompactionRecord {
  key: string;
  file: string;
  index: number;
  timestamp: string | null;
  summary: string;
  summaryChars: number;
  summaryTrimChars: number;
  tokensBefore: number | null;
}

export interface ProbeReading {
  id: string;
  fact: string;
  expect: string;
  passed: boolean;
  replyExcerpt: string;
}

export interface TurnRecord {
  group: GroupId;
  key: string;
  turn: number;
  label: string | undefined;
  text: string;
  reply: string;
  durationMs: number;
  emptyReply: boolean;
  error: string | null;
  modelCallsDelta: number;
  tokensDelta: number;
  toolCallsDelta: number;
  taskIds: readonly string[];
  tasks: readonly TaskSummary[];
  compactionsDelta: number;
  probes: readonly ProbeReading[];
  afterRestart: boolean;
  transcriptChars: number;
}

export interface TaskSummary {
  taskId: string;
  taskNo: number | null;
  name: string;
  status: string;
  reason: string | null;
  request: string;
  resultText: string | null;
  replyText: string | null;
  failureReason: string | null;
  executions: Array<{ requestId: string; operation: string; status: string }>;
}

export interface RestartRecord {
  group: GroupId;
  key: string;
  beforeFile: string | null;
  afterFile: string | null;
  sameFile: boolean;
  transcriptBeforeChars: number;
  transcriptAfterChars: number;
  priorUserMarkerPresent: boolean;
  tasksBefore: number;
  /** 重开后、下一回合前登记的任务数（同一 registry，应等于 tasksBefore）。 */
  tasksAfterReopen: number;
  executionsBefore: number;
  executionsAfterReopen: number;
  reExecutedOnReopen: number;
  note: string;
}

export interface SessionSink {
  group: GroupId;
  key: string;
  principalId: string;
  sessionId: string;
  turn: number;
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  turns: TurnRecord[];
  compactions: CompactionRecord[];
  sessionFile: string | undefined;
  transcriptChars: number;
  execCalls: readonly ExecCallLog[];
  /** 转录（只读快照 JSON）中是否出现 alice 私事代号——跨用户扫描用。 */
  transcriptHasAliceSecret: boolean;
}

export interface BudgetMeter {
  maxModelCalls: number;
  maxTokens: number;
  wallMs: number;
  startedAt: number;
  modelCalls: number;
  tokens: number;
  tripped: string | null;
  addCall(): void;
  addTokens(tokens: number): void;
  checkWall(): void;
  reached(): string | null;
}

export function createBudgetMeter(input: { maxModelCalls: number; maxTokens: number; wallMs: number }): BudgetMeter {
  const meter: BudgetMeter = {
    maxModelCalls: input.maxModelCalls,
    maxTokens: input.maxTokens,
    wallMs: input.wallMs,
    startedAt: Date.now(),
    modelCalls: 0,
    tokens: 0,
    tripped: null,
    addCall() {
      if (meter.tripped !== null) throw new Error(`budget-hard-stop: ${meter.tripped}`);
      meter.modelCalls += 1;
      if (meter.modelCalls > meter.maxModelCalls) {
        meter.tripped = `modelCalls ${meter.modelCalls} > ${meter.maxModelCalls}`;
        throw new Error(`budget-hard-stop: ${meter.tripped}`);
      }
      meter.checkWall();
    },
    addTokens(tokens) {
      meter.tokens += tokens;
      if (meter.tokens > meter.maxTokens) {
        meter.tripped = `tokens ${meter.tokens} > ${meter.maxTokens}`;
        throw new Error(`budget-hard-stop: ${meter.tripped}`);
      }
    },
    checkWall() {
      if (meter.tripped !== null) throw new Error(`budget-hard-stop: ${meter.tripped}`);
      const elapsed = Date.now() - meter.startedAt;
      if (elapsed > meter.wallMs) {
        meter.tripped = `wall ${elapsed}ms > ${meter.wallMs}ms`;
        throw new Error(`budget-hard-stop: ${meter.tripped}`);
      }
    },
    reached() {
      return meter.tripped;
    },
  };
  return meter;
}

function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return String(value) as unknown as T;
  }
}

function usageOf(message: unknown): Usage | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const rec = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cost = rec['cost'] as { total?: unknown } | undefined;
  return {
    input: num(rec['input']),
    output: num(rec['output']),
    reasoning: num(rec['reasoning']),
    cacheRead: num(rec['cacheRead']),
    totalTokens: num(rec['totalTokens']),
    cost: num(cost?.total),
  };
}

function isSummaryContext(context: { systemPrompt?: string; messages?: unknown[] } | undefined): boolean {
  const sys = typeof context?.systemPrompt === 'string' ? context.systemPrompt : '';
  if (sys.includes('summar')) return true;
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (first?.role !== 'system') return false;
  const text = Array.isArray(first.content)
    ? first.content.filter((c: { type?: string }) => c?.type === 'text').map((c: { text?: string }) => c.text ?? '').join('')
    : typeof first.content === 'string' ? first.content : '';
  return text.includes('summar');
}

/** 在传输层包一层只读记录器；不改请求、不改响应。 */
function wrapRuntime(base: ModelRuntime, sink: SessionSink, meter: BudgetMeter | null): ModelRuntime {
  const record = (kind: 'stream' | 'complete', context: never, options: { maxTokens?: number } | undefined): ModelCallRecord => {
    meter?.addCall();
    const rec: ModelCallRecord = {
      group: sink.group,
      key: sink.key,
      turn: sink.turn,
      kind,
      isSummary: isSummaryContext(context as { systemPrompt?: string; messages?: unknown[] }),
      startedAt: Date.now(),
      ms: null,
      stopReason: null,
      error: null,
      usage: null,
      requestedMaxTokens: typeof options?.maxTokens === 'number' ? options.maxTokens : null,
      wireMaxCompletionTokens: null,
    };
    sink.modelCalls.push(rec);
    return rec;
  };
  const finish = (rec: ModelCallRecord, message: unknown): void => {
    rec.ms = Date.now() - rec.startedAt;
    const usage = usageOf(message);
    // `done` 事件与 `.result()` 可能都到达；usage 只累计一次，避免预算 meter 双计。
    if (usage !== undefined && rec.usage === null) {
      rec.usage = usage;
      meter?.addTokens(usage.totalTokens);
    }
    const stop = (message as { stopReason?: unknown } | undefined)?.stopReason;
    if (typeof stop === 'string') rec.stopReason = stop;
    const errorMessage = (message as { errorMessage?: unknown } | undefined)?.errorMessage;
    if (typeof errorMessage === 'string' && errorMessage !== '') rec.error = errorMessage.slice(0, 500);
  };
  const wrapStream = (stream: never, rec: ModelCallRecord): never => {
    return new Proxy(stream as object, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) {
          return () => {
            const iterator = (target as { [Symbol.asyncIterator]: () => AsyncIterator<{ type?: string; message?: unknown; reason?: string; error?: unknown }> })[Symbol.asyncIterator]();
            return {
              async next() {
                const next = await iterator.next();
                if (next.done) { rec.ms ??= Date.now() - rec.startedAt; }
                else if (next.value?.type === 'done') finish(rec, next.value.message);
                else if (next.value?.type === 'error') {
                  rec.stopReason = next.value.reason ?? 'error';
                  rec.error = JSON.stringify(next.value.error ?? {}).slice(0, 500);
                  rec.ms ??= Date.now() - rec.startedAt;
                }
                return next;
              },
              return: iterator.return === undefined ? undefined : iterator.return.bind(iterator),
              throw: iterator.throw === undefined ? undefined : iterator.throw.bind(iterator),
            };
          };
        }
        if (prop === 'result') {
          return async () => {
            const result = await (target as { result: () => Promise<unknown> }).result();
            finish(rec, result);
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as never;
  };
  /** 只读观测：把调用方 options 原样转发，仅串一个 `onPayload` 记录线上实际请求体；不改请求内容。 */
  const observePayload = (options: unknown, rec: ModelCallRecord): never => {
    const opts = (options ?? {}) as {
      onPayload?: (params: unknown, model: unknown) => unknown;
    };
    const previous = opts.onPayload;
    const patched = {
      ...opts,
      async onPayload(params: unknown, model: unknown) {
        const body = params as { max_completion_tokens?: unknown; max_tokens?: unknown } | undefined;
        const cap = body?.max_completion_tokens ?? body?.max_tokens;
        rec.wireMaxCompletionTokens = typeof cap === 'number' ? cap : null;
        return previous === undefined ? params : await previous(params, model);
      },
    };
    return patched as never;
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'streamSimple') {
        return (model: never, context: never, options: never) => {
          const rec = record('stream', context, options as { maxTokens?: number } | undefined);
          let stream: never;
          try {
            stream = (target.streamSimple as (...args: never[]) => never)(model, context, observePayload(options, rec));
          } catch (error) {
            // 请求创建阶段（含 provider 立即拒绝）抛错：保留为一条带错误文本的调用记录。
            rec.ms = Date.now() - rec.startedAt;
            rec.stopReason = 'error';
            rec.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            throw error;
          }
          return wrapStream(stream, rec);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ModelRuntime;
}

function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: SessionSink): TurnDriver {
  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      let seq = 0;
      const wrappedInput: TurnDriverInput = {
        ...input,
        exec: async (tool, args, signal) => {
          seq += 1;
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          try {
            const result = await input.exec(tool, args, signal);
            sink.toolCalls.push({
              group: sink.group, key: sink.key, turn: sink.turn, agent, seq, tool,
              args: jsonSafe(args), result: jsonSafe(result), isError: false, startedAt, elapsedMs: Date.now() - startedMs,
            });
            return result;
          } catch (error) {
            sink.toolCalls.push({
              group: sink.group, key: sink.key, turn: sink.turn, agent, seq, tool,
              args: jsonSafe(args), result: null, isError: true,
              errorText: error instanceof Error ? error.message : String(error),
              startedAt, elapsedMs: Date.now() - startedMs,
            });
            throw error;
          }
        },
      };
      const result = await inner.run(wrappedInput);
      return result;
    },
    ...(inner.transcript === undefined ? {} : { transcript: () => inner.transcript!() }),
    ...(inner.close === undefined ? {} : { close: () => inner.close!() }),
    ...(inner.sessionInfo === undefined ? {} : { sessionInfo: () => inner.sessionInfo!() }),
    ...(inner.synthesizeAssistant === undefined ? {} : { synthesizeAssistant: (text: string) => inner.synthesizeAssistant!(text) }),
  };
  return wrapped;
}

function taskSummary(task: TaskRecord): TaskSummary {
  return {
    taskId: task.taskId,
    taskNo: task.taskNo ?? null,
    name: task.name ?? '',
    status: task.status,
    reason: task.reason ?? null,
    request: task.request,
    resultText: task.resultText ?? null,
    replyText: task.replyText ?? null,
    failureReason: task.failureReason ?? null,
    executions: task.executions.map((execution) => ({
      requestId: execution.requestId,
      operation: execution.operation,
      status: execution.status,
    })),
  };
}

function readSessionCompactions(file: string | undefined): Array<Omit<CompactionRecord, 'key' | 'file' | 'index'>> {
  if (file === undefined) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Array<Omit<CompactionRecord, 'key' | 'file' | 'index'>> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry['type'] !== 'compaction') continue;
    const summary = typeof entry['summary'] === 'string' ? entry['summary'] : '';
    out.push({
      timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
      summary,
      summaryChars: summary.length,
      summaryTrimChars: summary.trim().length,
      tokensBefore: typeof entry['tokensBefore'] === 'number' ? entry['tokensBefore'] : null,
    });
  }
  return out;
}

function transcriptText(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

export interface StageDConfigPaths {
  configCopy: string;
  dbPath: string;
  profileRoot: string;
  gateway: string;
}

export interface PreparedGroup {
  group: GroupId;
  root: string;
  env: NodeJS.ProcessEnv;
  profile: AppConfig['contextProfiles'][string];
  config: AppConfig;
  registry: SqliteTaskRegistry;
  baseRuntime: ModelRuntime;
  meter: BudgetMeter;
}

/** 评测侧显式模型/压缩配置覆盖（只透传给 Pi；缺省沿用 STAGE_D_CONFIG.groups + 窗口派生）。 */
export interface StageDSettingsOverride {
  contextWindow: number;
  maxTokens: number;
  /** 显式绝对压缩配置；缺省 = `piCompactionSettings(contextWindow)`。 */
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

function resolveSettings(group: GroupId, override: StageDSettingsOverride | undefined): StageDSettingsOverride {
  const base = STAGE_D_CONFIG.groups[group];
  return override ?? base;
}

export async function prepareGroup(input: {
  group: GroupId;
  root: string;
  meter: BudgetMeter;
  envOverride?: NodeJS.ProcessEnv;
  settings?: StageDSettingsOverride;
}): Promise<PreparedGroup> {
  const dir = path.join(input.root, input.group);
  mkdirSync(dir, { recursive: true });
  const configCopy = path.join(dir, 'agent-config.yaml');
  const dbPath = path.join(dir, 'state.db');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const config = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, { ...process.env, ...(input.envOverride ?? {}) });
  if ((env['LLM_API_KEY'] ?? '').trim() === '') {
    throw new Error('未检测到 LLM_API_KEY——真实模型运行需要 .env（不 echo 密钥、不落跟踪文件）。');
  }
  const profileIds = Object.keys(config.contextProfiles);
  if (profileIds.length !== 1) throw new Error(`需要单一 contextProfile（当前 ${profileIds.length} 个）`);
  const profile = config.contextProfiles[profileIds[0]!]!;
  if (!profile.gateway) throw new Error('profile 缺少 gateway');
  const settings = resolveSettings(input.group, input.settings);
  const baseRuntime = await createPiModelRuntime(env, STAGE_D_CONFIG.model, {
    contextWindow: settings.contextWindow,
    maxTokens: settings.maxTokens,
  });
  const registry = createSqliteTaskRegistry(dbPath);
  return { group: input.group, root: dir, env, profile, config, registry, baseRuntime, meter: input.meter };
}

export interface SessionHandle {
  assembled: AssembledSession;
  sink: SessionSink;
  client: StageDClient;
  mainRaw: TurnDriver;
  workerRaw: TurnDriver;
  sessionFile(): string | undefined;
  close(): void;
}

export interface BuildSessionInput {
  group: GroupId;
  prepared: PreparedGroup;
  key: string;
  principalId: string;
  sessionId: string;
  scope: TaskScope;
  resumeFile?: string;
  faultWindow?: string;
  /** 自测注入：确定性假驱动（零模型）；resumeFile 用于重启自检。 */
  driverFactory?: (options: { resumeFile?: string }) => { mainDriver: TurnDriver; workerDriver: TurnDriver };
  /** 派发模式：B/C 用 inline+注入 runner（同回合 Main 回复归档）；D 用 background；A 不需要 runner。 */
  dispatchMode?: 'inline' | 'background';
  /** false = 不注入 runner（Main 只有 task_run；A 的纯对话面）。 */
  withRunner?: boolean;
  /** 评测侧显式模型/压缩配置（与 prepareGroup 保持一致；缺省沿用 STAGE_D_CONFIG）。 */
  settings?: StageDSettingsOverride;
}

export async function buildSession(input: BuildSessionInput): Promise<SessionHandle> {
  const { prepared } = input;
  const settings = resolveSettings(input.group, input.settings);
  const stateDir = path.join(prepared.root, 'state', input.key);
  const sessionDir = path.join(prepared.root, 'sessions', input.key);
  const cwd = path.join(prepared.root, 'cwd', input.key);
  for (const dir of [stateDir, sessionDir, cwd]) mkdirSync(dir, { recursive: true });

  const emptyOperationsMessage = '执行层没有声明任何 operation——拒绝以空允许集合运行';
  // 执行面经唯一装配点产出后注入；评测侧只包装观测/故障注入，不另组 dummy 客户端。
  const assemblyFace = await resolveExecutionFace({
    profile: prepared.profile,
    env: prepared.env,
    stateDir,
    emptyOperationsMessage,
  });
  const client = createStageDClient({
    base: assemblyFace.client,
    ...(input.faultWindow === undefined ? {} : { faultWindow: input.faultWindow }),
  });
  const manifest: CapabilityManifest = await client.capabilities();
  const allowedOperations = manifest.operations.map((operation) => operation.name);

  const sink: SessionSink = {
    group: input.group,
    key: input.key,
    principalId: input.principalId,
    sessionId: input.sessionId,
    turn: 0,
    modelCalls: [],
    toolCalls: [],
    turns: [],
    compactions: [],
    sessionFile: undefined,
    transcriptChars: 0,
    execCalls: client.calls(),
    transcriptHasAliceSecret: false,
  };

  let mainRaw: TurnDriver | undefined;
  let workerRaw: TurnDriver | undefined;
  const policy = createResourcePolicy();

  const makeDrivers = async (driverEnv: NodeJS.ProcessEnv) => {
    const fake = input.driverFactory;
    if (fake !== undefined) {
      const pair = fake({ ...(input.resumeFile === undefined ? {} : { resumeFile: input.resumeFile }) });
      mainRaw = pair.mainDriver;
      workerRaw = pair.workerDriver;
      return {
        mainDriver: recordingDriver(pair.mainDriver, 'main', sink),
        workerDriver: recordingDriver(pair.workerDriver, 'worker', sink),
      };
    }
    const runtime = wrapRuntime(prepared.baseRuntime, sink, prepared.meter);
    const main = createPiTurnDriver({
      env: driverEnv,
      modelId: STAGE_D_CONFIG.model,
      thinkingLevel: STAGE_D_CONFIG.thinkingLevel,
      modelRuntime: runtime,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      compactionSettings: settings.compaction ?? piCompactionSettings(settings.contextWindow),
      reuseConversation: true,
      sessionDir,
      workspaceDir: cwd,
      ...(input.resumeFile === undefined ? {} : { resumeSessionFile: input.resumeFile }),
    });
    const worker = createPiTurnDriver({
      env: driverEnv,
      modelId: STAGE_D_CONFIG.model,
      thinkingLevel: STAGE_D_CONFIG.thinkingLevel,
      modelRuntime: runtime,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      compactionSettings: settings.compaction ?? piCompactionSettings(settings.contextWindow),
      reuseConversation: false,
      workspaceDir: path.join(prepared.root, 'cwd', `${input.key}-worker`),
    });
    mainRaw = main;
    workerRaw = worker;
    return {
      mainDriver: recordingDriver(main, 'main', sink),
      workerDriver: recordingDriver(worker, 'worker', sink),
    };
  };

  const dispatchMode = input.dispatchMode ?? 'background';
  const withRunner = input.withRunner ?? true;
  let preDrivers: { mainDriver: TurnDriver; workerDriver: TurnDriver } | undefined;
  let runner: Awaited<ReturnType<typeof createBackgroundDispatch>>['runner'] | undefined;
  if (dispatchMode === 'inline' && withRunner) {
    preDrivers = await makeDrivers(prepared.env);
    runner = (await createBackgroundDispatch({
      env: prepared.env,
      profile: prepared.profile,
      stateDir,
      registry: prepared.registry,
      policy,
      emptyOperationsMessage,
      face: { client, allowedOperations, readOnlyOperations: assemblyFace.readOnlyOperations },
      workerDriver: preDrivers.workerDriver,
    })).runner;
  }

  const assembled = await assembleSessionCore({
    env: prepared.env,
    profile: prepared.profile,
    principalId: input.principalId,
    sessionId: input.sessionId,
    dbPath: path.join(prepared.root, 'state.db'),
    stateDir,
    setAuditPath: true,
    emptyOperationsMessage,
    taskRegistry: prepared.registry,
    policy,
    dispatchMode,
    ...(runner === undefined ? {} : { taskRunner: runner }),
    createExecutionFace: async () => ({ client, allowedOperations, readOnlyOperations: assemblyFace.readOnlyOperations }),
    createDrivers: async (driverEnv) => preDrivers ?? makeDrivers(driverEnv),
  });

  if (mainRaw === undefined || workerRaw === undefined) throw new Error('驱动未创建（装配失败）');
  return {
    assembled,
    sink,
    client,
    mainRaw,
    workerRaw,
    sessionFile: () => mainRaw!.sessionInfo?.()?.sessionFile ?? sink.sessionFile,
    close: () => {
      mainRaw!.close?.();
      workerRaw!.close?.();
      assembled.close();
    },
  };
}

export interface SendOutcome {
  record: TurnRecord;
  restart?: RestartRecord;
}

/** 发送一回合并记录事实；调用方负责重启/预算。 */
export async function sendTurn(handle: SessionHandle, turn: StageTurn, turnNo: number, options: { afterRestart: boolean }): Promise<TurnRecord> {
  handle.sink.turn = turnNo;
  const beforeCalls = handle.sink.modelCalls.length;
  const beforeTools = handle.sink.toolCalls.length;
  const beforeCompactions = handle.sink.compactions.length;
  const tokensBefore = handle.sink.modelCalls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0);
  const started = Date.now();
  let reply = '';
  let error: string | null = null;
  let taskIds: readonly string[] = [];
  try {
    const result = await handle.assembled.session.send(turn.text);
    reply = result.reply;
    taskIds = result.taskIds;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const durationMs = Date.now() - started;

  // 会话文件/压缩条目（只读）
  const file = handle.sessionFile();
  if (file !== undefined) handle.sink.sessionFile = file;
  const parsed = readSessionCompactions(file);
  if (parsed.length > handle.sink.compactions.length) {
    for (let index = handle.sink.compactions.length; index < parsed.length; index += 1) {
      handle.sink.compactions.push({ key: handle.sink.key, file: file ?? '', index, ...parsed[index]! });
    }
  }
  const newCompactions = handle.sink.compactions.length - beforeCompactions;
  const transcript = handle.assembled.session.transcript();
  handle.sink.transcriptChars = transcriptText(transcript).length;
  handle.sink.transcriptHasAliceSecret = transcriptText(transcript).includes('ALICE-SECRET-7788');

  const tasks = handle.assembled.session.tasks().map(taskSummary);
  const probes = (turn.probes ?? []).map((probe) => ({
    id: probe.id,
    fact: probe.fact,
    expect: probe.expect,
    passed: reply.includes(probe.expect),
    replyExcerpt: reply.slice(0, 300),
  }));
  const calls = handle.sink.modelCalls.slice(beforeCalls);
  const record: TurnRecord = {
    group: handle.sink.group,
    key: handle.sink.key,
    turn: turnNo,
    label: turn.label,
    text: turn.text,
    reply,
    durationMs,
    emptyReply: reply.trim() === '',
    error,
    modelCallsDelta: calls.length,
    tokensDelta: handle.sink.modelCalls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0) - tokensBefore,
    toolCallsDelta: handle.sink.toolCalls.length - beforeTools,
    taskIds,
    tasks,
    compactionsDelta: newCompactions,
    probes,
    afterRestart: options.afterRestart,
    transcriptChars: handle.sink.transcriptChars,
  };
  handle.sink.turns.push(record);
  return record;
}

/** 关闭并重开同一 Pi 会话（同一 sessionId/principal/registry）。 */
export async function restartSession(input: {
  handle: SessionHandle;
  build: () => Promise<SessionHandle>;
  priorMarker: string;
}): Promise<{ handle: SessionHandle; record: RestartRecord }> {
  const beforeFile = input.handle.sessionFile() ?? null;
  const beforeTranscriptChars = input.handle.sink.transcriptChars;
  const beforeTasks = input.handle.assembled.session.tasks().length;
  const beforeExecutions = input.handle.assembled.session.tasks().reduce((sum, task) => sum + task.executions.length, 0);
  input.handle.close();
  const handle = await input.build();
  const afterFile = handle.sessionFile() ?? null;
  const transcript = handle.assembled.session.transcript();
  const afterTranscriptChars = transcriptText(transcript).length;
  const afterTasks = handle.assembled.session.tasks().length;
  const afterExecutions = handle.assembled.session.tasks().reduce((sum, task) => sum + task.executions.length, 0);
  const record: RestartRecord = {
    group: input.handle.sink.group,
    key: input.handle.sink.key,
    beforeFile,
    afterFile,
    sameFile: beforeFile !== null && beforeFile === afterFile,
    transcriptBeforeChars: beforeTranscriptChars,
    transcriptAfterChars: afterTranscriptChars,
    priorUserMarkerPresent: transcriptText(transcript).includes(input.priorMarker),
    tasksBefore: beforeTasks,
    tasksAfterReopen: afterTasks,
    executionsBefore: beforeExecutions,
    executionsAfterReopen: afterExecutions,
    reExecutedOnReopen: afterExecutions - beforeExecutions,
    note: beforeFile === null ? '未落盘（sessionDir 未生效或尚未创建会话）' : '会话在重启后首回合才惰性打开；文件/转录判据由 finalizeRestart 在首回合后补齐',
  };
  return { handle, record };
}

/** 重启后的首回合结束：补齐文件/转录/任务判据（不改变前面已记录的事实）。 */
export function finalizeRestart(record: RestartRecord, handle: SessionHandle, priorMarker: string): RestartRecord {
  const file = handle.sessionFile() ?? null;
  const transcript = handle.assembled.session.transcript();
  const tasks = handle.assembled.session.tasks();
  record.afterFile = file;
  record.sameFile = record.beforeFile !== null && file !== null && record.beforeFile === file;
  record.transcriptAfterChars = transcriptText(transcript).length;
  record.priorUserMarkerPresent = transcriptText(transcript).includes(priorMarker);
  record.tasksAfterReopen = tasks.length;
  const executions = tasks.reduce((sum, task) => sum + task.executions.length, 0);
  record.executionsAfterReopen = executions;
  record.reExecutedOnReopen = executions - record.executionsBefore;
  return record;
}

export function seedCompletedTask(input: {
  registry: TaskRegistry;
  scope: TaskScope;
  request: string;
  resultText: string;
  taskId?: string;
}): TaskRecord {
  const taskId = input.taskId ?? `seed_${randomUUID()}`;
  input.registry.begin({
    taskId,
    principalId: input.scope.principalId,
    sessionId: input.scope.sessionId,
    request: input.request,
    status: 'running',
  });
  input.registry.noteExecution(taskId, { requestId: `seed_${randomUUID()}`, operation: 'dummy.query', status: 'completed' });
  input.registry.complete(taskId, input.resultText);
  return input.registry.get(taskId, input.scope);
}

export function seedWaitingTask(input: {
  registry: TaskRegistry;
  scope: TaskScope;
  request: string;
  missing: readonly string[];
  taskId?: string;
}): TaskRecord {
  const taskId = input.taskId ?? `seed_${randomUUID()}`;
  input.registry.begin({
    taskId,
    principalId: input.scope.principalId,
    sessionId: input.scope.sessionId,
    request: input.request,
    status: 'running',
  });
  input.registry.waitForUser(taskId, { missing: input.missing });
  return input.registry.get(taskId, input.scope);
}

/** 供 metrics 读取的一次运行证据。 */
export interface GroupEvidence {
  group: GroupId;
  keys: string[];
  sessions: SessionSink[];
  restarts: RestartRecord[];
  registryTasks?: TaskSummary[];
  usageWallMs: number;
  error?: string;
}
