/**
 * D7 共享实例夹具（纯测试基建；产品代码零改动——注入点全部是 server.ts 既有依赖注入）：
 *
 *   · **真共享**：`createServer(deps)` 只调用一次 = 唯一服务进程；两个 principal
 *     （wecom:alice / wecom:bob）在**同一个 conversationId** 里对同一个 handler 发消息，
 *     共享同一 SQLite 底账文件（<root>/shared.db 单文件）、同一个进程级 TaskRunner、
 *     同一份资源策略与通知面——不是多库并发，也不是多进程。
 *   · 身份来自渠道事实（server.ts:203-207：principal = <channel>:<wecomUserId>），
 *     消息级区分 principal，无需任何产品代码改动。
 *   · 确定性替身：假 Pi 回合驱动（共享响应队列，按回合顺序消费）+ 假执行客户端
 *     （只回能力清单、记录请求）+ 注入式确定性 taskExecutor（脚本化后台回合结局：
 *     completed / needs_input / 可取消挂起），因此可确定性地驱动取消 / 接续 / waiting_user。
 *   · 越权拒绝的可复核证据：每个动作归档一行 JSONL（<root>/evidence/<scenario>.jsonl），
 *     含 B 回合回复文本 + message_done 终态（taskIds/executions）；
 *     `assertRefusalEvidence` / `assertFoundEvidence` 是证据守卫（正反对照防「全拒绝也算绿」）。
 *
 * 真实模型交互接入点：`createDrivers` 不注入时 server 缺省走真实 Pi 驱动——
 * 本夹具的 `options.realDrivers = true` 即以真实驱动 + 其余确定性替身运行（后续切片接线）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig } from '@fshine/contracts';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { contextWindowFrom } from '../../ask-runtime';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';
import type {
  TaskExecutionInput,
  TaskExecutionContext,
  TaskExecutionOutcome,
  TaskExecutor,
} from '../../../packages/agent/src/task-runner';
import { createServer } from '../../../apps/server/server';

/** 夹具复用的仓内 dummy 执行层根（能力清单/技能目录都在仓内，不触网）。 */
const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dummy-platform');

/** 两个 principal 共用的会话窗口：同 conversationId —— 隔离只可能来自 principal 维度。 */
const SHARED_CONVERSATION_ID = 'shared-conv';

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query items', args: [{ name: '--collection', required: true }] }],
};

// ---------------------------------------------------------------------------
// 假模型消息构造（与 apps/server/server.test.ts 同款，供场景脚本编排回合）
// ---------------------------------------------------------------------------

export function toolCallAssistant(name: string, args: Record<string, unknown>, id?: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: id ?? `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

export function textAssistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function streamOf(message: AgentMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'done', reason: (message as { stopReason?: string }).stopReason, message };
    },
    result: async () => message,
  };
}

/** 假 Pi 驱动：按调用顺序消费共享响应队列（回合顺序 = 测试编排顺序，确定性）。 */
async function queueDriverFor(queue: AgentMessage[]): Promise<TurnDriver> {
  const scripted = await createScriptedModelRuntime({
    contextWindow: 40_000,
    script: () => {
      const response = queue.shift();
      if (response === undefined) throw new Error('共享实例夹具：假模型响应队列已空（脚本编排不完整）。');
      return response;
    },
  });
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime });
}

// ---------------------------------------------------------------------------
// 真实模型取证：透传式驱动包装器（只记录、不改语义；工具调用 + 逐次模型用量）
// ---------------------------------------------------------------------------

/** 一次模型工具调用的机械记录（host 侧实际解析结果；isError=true = 被宿主/执行层拒绝）。 */
export interface DriverToolCallRecord {
  driver: 'main' | 'worker';
  seq: number;
  tool: string;
  args: unknown;
  isError: boolean;
  resultSummary: string;
  at: string;
  elapsedMs: number;
}

/** 一条 assistant 消息的用量（modelCalls 的计数口径同 convergence runner：assistant.usage）。 */
export interface ModelCallRecord {
  driver: 'main' | 'worker';
  input?: number;
  output?: number;
  cacheRead?: number;
  total?: number;
}

/** 驱动观察汇（夹具内部持有；send() 按回合切面返回）。 */
export interface DriverObservations {
  toolCalls: DriverToolCallRecord[];
  modelCalls: ModelCallRecord[];
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function summarizeResult(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const record = value as { status?: unknown; error?: unknown };
    const status = typeof record.status === 'string' ? record.status : 'ok';
    const code = record.error !== null && typeof record.error === 'object' && typeof (record.error as { code?: unknown }).code === 'string'
      ? ` error=${(record.error as { code: string }).code}`
      : '';
    return `${status}${code}`;
  }
  return String(value).slice(0, 200);
}

function usageOf(message: unknown): Omit<ModelCallRecord, 'driver'> | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown };
  const pick = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const picked = { input: pick(record.input), output: pick(record.output), cacheRead: pick(record.cacheRead), total: pick(record.totalTokens) };
  return Object.values(picked).some((value) => value !== undefined) ? picked : undefined;
}

/** 记录包装器：透传 inner 的 run/compact/synthesize，只旁路捕获工具调用与助手用量。 */
function recordingDriver(inner: TurnDriver, driver: 'main' | 'worker', sink: DriverObservations): TurnDriver {
  let seq = 0;
  const wrapped: TurnDriver = {
    async run(input) {
      const wrappedInput = {
        ...input,
        exec: async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => {
          seq += 1;
          const startedMs = Date.now();
          try {
            const result = await input.exec(tool, args, signal);
            sink.toolCalls.push({ driver, seq, tool, args: safeJson(args), isError: false, resultSummary: summarizeResult(result), at: new Date().toISOString(), elapsedMs: Date.now() - startedMs });
            return result;
          } catch (error) {
            sink.toolCalls.push({ driver, seq, tool, args: safeJson(args), isError: true, resultSummary: error instanceof Error ? error.message : String(error), at: new Date().toISOString(), elapsedMs: Date.now() - startedMs });
            throw error;
          }
        },
      };
      const result = await inner.run(wrappedInput);
      for (const message of result.messages.slice(input.messages.length)) {
        if ((message as { role?: unknown }).role !== 'assistant') continue;
        const usage = usageOf(message);
        sink.modelCalls.push({ driver, ...(usage ?? {}) });
      }
      return result;
    },
    ...(inner.synthesizeAssistant ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// 假执行客户端：只回能力清单 + 记录请求（后台回合走注入的 taskExecutor，不经此面）
// ---------------------------------------------------------------------------

class RecordingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return { status: 'completed', data: { collection: 'documents', window: 'W202611', count: 3 } };
  }
}

// ---------------------------------------------------------------------------
// 脚本化后台执行器：确定性驱动 completed / needs_input / 可取消挂起 / 接续带 answer
// ---------------------------------------------------------------------------

export type RoundBehavior = (
  input: TaskExecutionInput,
  context: TaskExecutionContext,
) => Promise<TaskExecutionOutcome>;

export interface ScriptedExecutor extends TaskExecutor {
  /** FIFO 回合行为脚本；耗尽即抛错（fail-fast，不静默通过）。 */
  readonly behaviors: RoundBehavior[];
  /** 已发生的后台回合（含输入与回合 promise，供断言 taskNo/answer/落定）。 */
  readonly rounds: Array<{ input: TaskExecutionInput; promise: Promise<TaskExecutionOutcome> }>;
  /** 已落定的回合数（completed/failed/cancelled 等都算；挂起中的长任务不算）。 */
  settledCount(): number;
}

function createScriptedExecutor(defaultBehavior?: RoundBehavior): ScriptedExecutor {
  const behaviors: RoundBehavior[] = [];
  const rounds: ScriptedExecutor['rounds'] = [];
  let settled = 0;
  return {
    behaviors,
    rounds,
    settledCount: () => settled,
    execute(input, context) {
      // 脚本耗尽：给了 defaultBehavior（真实模型不定回合数时）用它兜底；否则 fail-fast。
      const behavior = behaviors.shift() ?? defaultBehavior;
      if (behavior === undefined) {
        return Promise.reject(new Error('共享实例夹具：后台回合行为脚本已空（编排不完整）。'));
      }
      const promise = behavior(input, context);
      void promise.catch(() => {}).then(() => {
        settled += 1;
      });
      rounds.push({ input, promise });
      return promise;
    },
  };
}

/** 立即落定的回合结局。 */
export function outcomeBehavior(outcome: TaskExecutionOutcome): RoundBehavior {
  return async () => outcome;
}

/** 挂起直到 abort 的长任务（取消场景：观察 signal → AbortError → runner 确认 cancelled）。 */
export function pendingCancelableBehavior(): RoundBehavior {
  return (_input, context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
}

// ---------------------------------------------------------------------------
// 证据面：逐动作 JSONL 归档 + 越权/正向证据守卫
// ---------------------------------------------------------------------------

export interface TurnEvidence {
  principal: string;
  text: string;
  reply: string;
  done: { event: string; taskIds: unknown[]; executions: unknown[] };
}

/** 回合证据 + 真实模型观察面（工具调用 / 模型用量）；假驱动下二者为空数组。 */
export interface ObservedTurn extends TurnEvidence {
  toolCalls: DriverToolCallRecord[];
  modelCalls: ModelCallRecord[];
}

/** 越权拒绝证据守卫：回复不得含他人任务详情；终态不得带出他人 taskIds/executions。 */
export function assertRefusalEvidence(entry: TurnEvidence, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (entry.reply.includes(secret)) {
      throw new Error(`越权回合回复泄露了他人任务详情（${entry.principal}：「${secret}」）`);
    }
  }
  if (entry.done.taskIds.length > 0 || entry.done.executions.length > 0) {
    throw new Error(`越权回合 message_done 带出 taskIds/executions（${entry.principal}，越权动作不得触碰他人任务）`);
  }
}

/** 正向对照证据守卫：自己的任务操作必须成功——拒绝话术出现即「全拒绝也算绿」的红旗。 */
export function assertFoundEvidence(entry: TurnEvidence): void {
  if (entry.reply.includes('不属于当前会话') || entry.reply.includes('没找到')) {
    throw new Error(`正向对照失败（${entry.principal}）：自己的任务操作被拒——全拒绝也算绿，隔离判定无效。`);
  }
}

/**
 * 守卫裁决（归档友好）：不抛错，把「判据是否满足」显式带回给运行器。
 * 运行器**必须**用这两个包装（而非内联等价判断）真正应用预注册守卫，并把 `passed=false` 如实归档——
 * 守卫抛错绝不静默吞（`message` 即原守卫异常语，用于偏差登记）。
 */
export interface GuardVerdict {
  passed: boolean;
  message?: string;
}

/** 应用越权拒绝守卫（`assertRefusalEvidence`）：越权回合回复不得含他人详情，且 `message_done.taskIds/executions` 必须为空。 */
export function applyRefusalGuard(entry: TurnEvidence, secrets: readonly string[]): GuardVerdict {
  try {
    assertRefusalEvidence(entry, secrets);
    return { passed: true };
  } catch (error) {
    return { passed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 应用正向对照守卫（`assertFoundEvidence`）：正向回合不得出现拒绝话术（否则「全拒绝也算绿」）。 */
export function applyForwardGuard(entry: TurnEvidence): GuardVerdict {
  try {
    assertFoundEvidence(entry);
    return { passed: true };
  } catch (error) {
    return { passed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 夹具本体
// ---------------------------------------------------------------------------

export interface SharedInstanceFixtureOptions {
  /** 证据归档名（<root>/evidence/<scenarioName>.jsonl）。 */
  scenarioName?: string;
  /** true = 注入真实 Pi 驱动（读 env）；缺省 = 假队列驱动（零网络）。 */
  realDrivers?: boolean;
  /** server 生效环境（realDrivers 时须带 LLM_API_BASE_URL/LLM_API_KEY/LLM_MODEL）；缺省 { LLM_MODEL: 'test-model' }。 */
  env?: NodeJS.ProcessEnv;
  /** 后台回合脚本耗尽时的兜底结局（真实模型回合数不定时用）；缺省 fail-fast。 */
  defaultBehavior?: RoundBehavior;
}

export interface SharedInstanceFixture {
  root: string;
  dbPath: string;
  /** 两个 principal 的可读名（wecom:alice / wecom:bob）。 */
  principals: { alice: 'wecom:alice'; bob: 'wecom:bob' };
  /** 假执行客户端记录的结构化请求（后台路径不经过它；留给后续真实驱动接入点）。 */
  executionRequests: readonly ExecutionRequest[];
  /** 脚本化后台执行器（behaviors FIFO；rounds 供断言）。 */
  executor: ScriptedExecutor;
  /** 服务进程日志行（含 message_done / message_refused）。 */
  logs: Array<Record<string, unknown>>;
  /** 预置下一批假模型响应（按回合消费顺序）。 */
  scriptMain(...messages: AgentMessage[]): void;
  /** 以某 principal 身份在共享会话窗口发一条消息，返回回合证据（回复 + message_done 终态 + 驱动观察）。 */
  send(principal: 'alice' | 'bob', text: string): Promise<ObservedTurn>;
  /** 等待后台回合落定：不给 expected = 等当前全部（挂起中的长任务不等待需要 expected）；
   *  给 expected = 轮询等待累计落定回合数达到该值（可取消挂起场景用）。 */
  settleRounds(expected?: number): Promise<void>;
  close(): void;
}

export function createSharedInstanceFixture(
  options: SharedInstanceFixtureOptions = {},
): SharedInstanceFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'd7-shared-'));
  const dbPath = path.join(root, 'shared.db');
  const evidenceDir = path.join(root, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${options.scenarioName ?? 'default'}.jsonl`);

  const config: AppConfig = {
    principals: {
      'wecom:alice': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
      'wecom:bob': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 真共享任务管理资源：background = 进程级 TaskRunner + 同一底账队列 + 同一资源策略。
    runtime: { dispatchMode: 'background' },
  };

  const queue: AgentMessage[] = [];
  const client = new RecordingClient();
  const observations: DriverObservations = { toolCalls: [], modelCalls: [] };
  const executor = createScriptedExecutor(options.defaultBehavior);
  const logs: Array<Record<string, unknown>> = [];
  let messageSeq = 0;
  let serverPromise: Promise<Awaited<ReturnType<typeof createServer>>> | undefined;

  const driverEnv = options.env ?? { LLM_MODEL: 'test-model' };
  // 驱动工厂：realDrivers = 真实 Pi 驱动 ×2（外包一层记录器，只记录不改语义）；缺省 = 假队列驱动。
  const buildDrivers = async (env: NodeJS.ProcessEnv) => (options.realDrivers === true
    ? {
        mainDriver: recordingDriver(createPiTurnDriver({ env, ...contextWindowFrom(env) }), 'main', observations),
        workerDriver: recordingDriver(createPiTurnDriver({ env, ...contextWindowFrom(env) }), 'worker', observations),
      }
    : { mainDriver: await queueDriverFor(queue), workerDriver: await queueDriverFor(queue) });

  // 唯一 createServer 调用（唯一服务进程）：身份取自渠道事实，多 principal = 消息级区分。
  const buildServer = () =>
    createServer({
      env: driverEnv,
      config,
      dbPath,
      stateDir: path.join(root, 'state'),
      createDrivers: buildDrivers,
      createExecutionFace: async () => ({ client, allowedOperations: ['dummy.query'] }),
      taskExecutor: executor,
      logger: (line) => logs.push(line),
    });

  async function send(principal: 'alice' | 'bob', text: string): Promise<ObservedTurn> {
    serverPromise ??= buildServer();
    const server = await serverPromise;
    messageSeq += 1;
    const messageId = `m-${messageSeq}`;
    const callsBefore = observations.toolCalls.length;
    const modelsBefore = observations.modelCalls.length;
    const reply = await server.handler({
      channel: 'wecom',
      wecomUserId: principal,
      conversationId: SHARED_CONVERSATION_ID,
      messageId,
      text,
      receivedAt: new Date().toISOString(),
    });
    const replyText = typeof reply === 'string' ? reply : JSON.stringify(reply);
    const done = [...logs].reverse().find((line) => line['event'] === 'message_done' && line['messageId'] === messageId);
    const entry: ObservedTurn = {
      principal: `wecom:${principal}`,
      text,
      reply: replyText,
      done: {
        event: 'message_done',
        taskIds: (done?.['taskIds'] as unknown[] | undefined) ?? [],
        executions: (done?.['executions'] as unknown[] | undefined) ?? [],
      },
      toolCalls: observations.toolCalls.slice(callsBefore),
      modelCalls: observations.modelCalls.slice(modelsBefore),
    };
    appendFileSync(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    return entry;
  }

  async function settleRounds(expected?: number): Promise<void> {
    if (expected === undefined) {
      await Promise.allSettled(executor.rounds.map((round) => round.promise));
      // 让 runner 落定链（底账写入 + 再派发微任务）跑完再返回。
      for (let i = 0; i < 2; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    // 轮询等待累计落定数达到 expected（挂起中的长任务不计；给 0 即只让出事件循环）。
    for (let guard = 0; executor.settledCount() < expected && guard < 10_000; guard += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (let i = 0; i < 2; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return {
    root,
    dbPath,
    principals: { alice: 'wecom:alice', bob: 'wecom:bob' },
    executionRequests: client.requests,
    executor,
    logs,
    scriptMain: (...messages) => {
      queue.push(...messages);
    },
    send,
    settleRounds,
    close() {
      void serverPromise?.then((server) => server.close()).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}
