/**
 * P2 业务端到端验收 · 装配胶水（eval 侧；零产品码改动、零真实模型、零真实平台）。
 *
 * 复用（不重建框架，预注册 §七）：
 *   · 生产同源装配：`apps/server/server.ts` 的 `createServer`（与 `npm start` 同一链）；
 *   · 真实 Pi 驱动 + **脚本化 provider**：`createPiTurnDriver` × `createScriptedModelRuntime`
 *     （`packages/agent/testing/scripted-model-runtime.ts`）——驱动链路真实，模型响应脚本化；
 *   · 仓内 dummy 执行层：`createDummyCliClient` / `readOnlyOperationNames`（与 server 缺省同源）；
 *   · 逐轮管线 + Oracle + 证据：`long-session/harness.ts` 的 `runHarnessSession`、`long-session/oracle.ts`、
 *     `long-session/compaction.ts`、`long-session/evidence.ts`、`long-session/accounting.ts`；
 *   · 工具调用记录：`business-e2e/shared-instance.ts` 的 `recordingDriver`（导出复用）；
 *   · 多用户/重启辅助：`long-session/multiuser/mu-support.ts`。
 *
 * 本模块只做三件事：**脚本表**（按用户原文/委派原文索引的模型响应）、**装配与观测**、
 * **证据落盘**。判定在 `./p2-oracle`，场景定义在 `./p2-scenarios`。
 *
 * 纪律：脚本里的回复文本由**执行层真实返回**派生（`formatQueryOutcome` / 存档原文），
 * 真值（`FACT_TRUTH`）只进 Oracle——目标与真值分离。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig, RuntimeConfig } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { NotificationSink } from '../../../packages/agent/src/notifications';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { MainSessionLocation } from '../../../packages/agent/src/session-persistence';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';
import { createServer, type Server } from '../../../apps/server/server';
import { resolveExecutionFace, type ExecutionFace } from '../../ask-runtime';
import { accountCalls, type AccountedUsage, type CallKind, type ModelCallRecord } from '../long-session/accounting';
import type { SessionEvidence, SessionJudgement } from '../long-session/evidence';
import { collectEvidence } from '../long-session/evidence';
import { runHarnessSession } from '../long-session/harness';
import type { FactExpectation, TaskTurnFact, TaskView } from '../long-session/oracle';
import { judgeFactAnswer, judgeTaskContinuity } from '../long-session/oracle';
import { analyzeCompaction, judgeCompactionLifecycle, type CompactionAttempt } from '../long-session/compaction';
import type { TrackPlan } from '../long-session/load-generator';
import {
  MU_FIXTURE_ROOT, deliver, incoming, readTasks,
  type MuDeliveryRecord,
} from '../long-session/multiuser/mu-support';
import {
  recordingDriver, textAssistant, toolCallAssistant,
  type DriverObservations,
} from '../business-e2e/shared-instance';
import type { P2ExecRecord, P2ModelCall, P2Observation, P2ScenarioId } from './p2-types';

// ─────────────────────────────────────────────────────────────────────────────
// 脚本化 provider：响应表 + 逐次记账分类
// ─────────────────────────────────────────────────────────────────────────────

/** 一次脚本化模型调用的上下文（供脚本按调用次序产出响应）。 */
export interface P2ScriptCall {
  readonly key: string;
  readonly driver: 'main' | 'worker';
  /** 该键内的第几次调用（0 起）。 */
  readonly callIndex: number;
  readonly messages: readonly unknown[];
  /** 最后一条 user 消息的文本（主回合 = 用户原文；Worker = 委派原文）。 */
  readonly text: string;
}

/** 一个响应槽：固定消息或按上下文惰性生成（生成函数可读执行层真实返回）。 */
export type P2Response = AgentMessage | ((call: P2ScriptCall) => AgentMessage);

interface P2Entry {
  readonly responses: readonly P2Response[];
}

/** 从模型请求的 messages 里取最后一条 user 文本（Pi 的 toolResult 会跟在其后）。 */
export function lastUserTextOf(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        })
        .join('\n');
    }
  }
  return '';
}

/**
 * 记账类别分类（主 / 摘要 / 重试 / 溢出恢复；预注册 §3.3 要求四类可分离）。
 * 判定顺序固定：
 *   1. 上一请求失败/中止 → `retry`（driver 重发）；
 *   2. 上一请求因长度截断 → `overflow_recovery`（溢出后重发）；
 *   3. 压缩摘要请求（无 user 消息或系统提示含摘要指令）→ `summary`；
 *   4. 其余 → `main`。
 * 纯函数（单测逐分支钉住）。
 */
export function classifyModelCall(input: { previousStopReason?: string; summaryRequest: boolean }): CallKind {
  if (input.previousStopReason === 'error' || input.previousStopReason === 'aborted') return 'retry';
  if (input.previousStopReason === 'length') return 'overflow_recovery';
  if (input.summaryRequest) return 'summary';
  return 'main';
}

/** 压缩摘要请求的机械识别（Pi 原生压缩请求没有用户轮次文本）。 */
export function looksLikeSummaryRequest(context: unknown): boolean {
  const record = context as { messages?: readonly { role?: unknown }[]; systemPrompt?: unknown } | undefined;
  const messages = record?.messages ?? [];
  const hasUser = messages.some((message) => message.role === 'user');
  const system = typeof record?.systemPrompt === 'string' ? record.systemPrompt : '';
  return !hasUser || /摘要|summar(y|ize)|compact/i.test(system);
}

interface CallUsage {
  readonly tokens: { input: number; output: number; total: number };
  readonly observed: boolean;
}

function usageOfMessage(message: AgentMessage): CallUsage {
  const usage = (message as unknown as { usage?: { input?: unknown; output?: unknown; totalTokens?: unknown } }).usage;
  const pick = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  if (usage === undefined || usage === null) {
    return { tokens: { input: 0, output: 0, total: 0 }, observed: false };
  }
  return {
    tokens: { input: pick(usage.input), output: pick(usage.output), total: pick(usage.totalTokens) },
    observed: typeof usage.totalTokens === 'number',
  };
}

/**
 * 响应表：Main 按「用户原文精确匹配」、Worker 按「委派原文包含任务原文」匹配。
 * 每个键的响应按调用次序消费；耗尽即抛（脚本编排不完整立即可见，不静默通过）。
 */
export class P2ScriptBook {
  private readonly main = new Map<string, P2Entry>();
  private readonly worker = new Map<string, P2Entry>();
  private readonly counters = new Map<string, number>();
  private readonly previousStop = new Map<string, string>();
  private readonly turnOfKey = new Map<string, number>();
  /** 逐次调用账本（四类可分离）。 */
  readonly calls: P2ModelCall[] = [];
  /** 工具调用观察汇（Main/Worker 共用，按回合切片）。 */
  readonly toolSink: DriverObservations = { toolCalls: [], modelCalls: [] };
  /** 每个键最后一次模型请求的完整 messages 文本（转录恢复/旧回合冒充的证据）。 */
  readonly requestTexts = new Map<string, string>();

  /** 登记一个 Main 回合脚本（key = 用户原文）。 */
  mainTurn(text: string, responses: readonly P2Response[], turnIndex: number): this {
    this.main.set(text, { responses });
    this.turnOfKey.set(text, turnIndex);
    return this;
  }

  /** 登记一个 Worker 任务脚本（key = 任务原文；委派文本包含它即匹配）。 */
  workerTask(taskFragment: string, responses: readonly P2Response[]): this {
    this.worker.set(taskFragment, { responses });
    return this;
  }

  turnIndex(key: string): number {
    return this.turnOfKey.get(key) ?? 0;
  }

  private resolve(driver: 'main' | 'worker', text: string): { key: string; entry: P2Entry } {
    if (driver === 'main') {
      const entry = this.main.get(text);
      if (entry === undefined) throw new Error(`P2 脚本缺失 Main 回合：${JSON.stringify(text.slice(0, 120))}`);
      return { key: text, entry };
    }
    let best: string | undefined;
    for (const key of this.worker.keys()) {
      if (text.includes(key) && (best === undefined || key.length > best.length)) best = key;
    }
    if (best === undefined) throw new Error(`P2 脚本缺失 Worker 任务：${JSON.stringify(text.slice(0, 160))}`);
    return { key: best, entry: this.worker.get(best)! };
  }

  /** 供 `createScriptedModelRuntime` 的 script 回调：产出响应并记账。 */
  response(driver: 'main' | 'worker', context: unknown): AgentMessage | undefined {
    const record = context as { messages?: readonly unknown[] };
    const messages = record.messages ?? [];
    const text = lastUserTextOf(messages);
    this.requestTexts.set(text, messagesText(messages));
    const { key, entry } = this.resolve(driver, text);
    const counterKey = `${driver}\u0000${key}`;
    const callIndex = this.counters.get(counterKey) ?? 0;
    this.counters.set(counterKey, callIndex + 1);
    const slot = entry.responses[callIndex];
    if (slot === undefined) {
      throw new Error(`P2 脚本响应耗尽（${driver} / ${JSON.stringify(key.slice(0, 80))} / 第 ${callIndex + 1} 次调用）`);
    }
    const call: P2ScriptCall = { key, driver, callIndex, messages, text };
    const message = typeof slot === 'function' ? slot(call) : slot;
    const stopReason = (message as unknown as { stopReason?: unknown }).stopReason;
    const kind = classifyModelCall({
      ...(this.previousStop.get(counterKey) === undefined ? {} : { previousStopReason: this.previousStop.get(counterKey)! }),
      summaryRequest: looksLikeSummaryRequest(context),
    });
    const usage = usageOfMessage(message);
    this.calls.push({
      seq: this.calls.length + 1,
      kind,
      sessionId: '',
      turn: this.turnIndex(key),
      tokens: usage.tokens,
      tokensObserved: usage.observed,
      durationMs: 0,
      key,
      driver,
    });
    if (typeof stopReason === 'string') this.previousStop.set(counterKey, stopReason);
    return message;
  }

  /** 某会话（= 该会话全部回合键）的逐次调用账本。 */
  ledgerFor(turnTexts: readonly string[]): P2ModelCall[] {
    const keys = new Set(turnTexts);
    return this.calls.filter((call) => call.driver === 'main' && keys.has(call.key));
  }

  /** 全批四条调用类别的全量记账（S7c 成本判据/证据用）。 */
  accounting(): AccountedUsage {
    return accountCalls(this.calls);
  }
}

function messagesText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            const record = part as { text?: unknown; name?: unknown };
            if (typeof record.text === 'string') return record.text;
            return typeof record.name === 'string' ? `[${record.name}]` : '';
          })
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行层：命中记录 + 三种确定性形态（dummy CLI / 假件 / 永不结算）
// ─────────────────────────────────────────────────────────────────────────────

/** 记录包装：先记请求，再记返回（四态 + 错误码 + 载荷），判定底座 = 执行层真实返回。 */
class RecordingP2Client implements ExecutionClient {
  readonly records: P2ExecRecord[] = [];
  constructor(private readonly inner: ExecutionClient) {}

  async capabilities(): Promise<CapabilityManifest> {
    return await this.inner.capabilities();
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const collection = typeof request.args['--collection'] === 'string' ? (request.args['--collection'] as string) : null;
    // 先落「已发起」事实，再等返回：执行面永不结算时（S7b），这次尝试也必须可见。
    const record: { -readonly [K in keyof P2ExecRecord]: P2ExecRecord[K] } = {
      requestId: request.requestId,
      operation: request.operation,
      args: request.args,
      collection,
      status: 'pending',
    };
    this.records.push(record);
    const outcome = await this.inner.execute(request);
    record.status = outcome.status;
    if (outcome.status === 'failed' || outcome.status === 'refused') record.errorCode = outcome.error.code;
    if (outcome.status === 'completed') record.data = outcome.data;
    return outcome;
  }
}

/** 仓内 dummy 执行层（与 server 缺省同源；faulty-one 等种子故障真实可达）。 */
export async function createDummyP2Client(input: { dir: string; env?: NodeJS.ProcessEnv }): Promise<{
  client: ExecutionClient;
  allowedOperations: readonly string[];
  readOnlyOperations: readonly string[];
}> {
  // 执行面解析走装配链的唯一入口（`scripts/ask-runtime.ts` 的 `resolveExecutionFace`）：
  // 与 server 缺省同一链（dummy CLI + 从执行层自述的 access 派生只读允许集），
  // 不在评测胶水里自建第二份装配（P0-T03 单一装配点守卫）。
  // 子进程 env 由 worker 白名单重建（PATH/HOME/TMPDIR 进、凭据族不进）；
  // 这里给全量进程 env 以保证网关能找到 node，白名单负责收口。
  const env = input.env ?? { ...process.env, LLM_MODEL: 'test-model' };
  const face = await resolveExecutionFace({
    profile: { root: MU_FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    env,
    stateDir: path.join(input.dir, 'state'),
    emptyOperationsMessage: '执行层没有声明任何只读 operation——P2 样本拒绝以空允许集合运行。',
  });
  return {
    client: face.client,
    allowedOperations: face.allowedOperations,
    readOnlyOperations: face.readOnlyOperations,
  };
}

/** 从不结算的执行客户端（S7b 执行面注入：deadline 必须由 Worker 驱动遵守）。 */
export function createHangingClient(): ExecutionClient {
  return {
    async capabilities(): Promise<CapabilityManifest> {
      return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query items', args: [{ name: '--collection', required: true }] }] };
    },
    execute(): Promise<ExecutionOutcome> {
      return new Promise<ExecutionOutcome>(() => { /* 永不结算：由 Worker 驱动的 deadline 契约中止 */ });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配：生产同源 createServer + 脚本化 provider
// ─────────────────────────────────────────────────────────────────────────────

export interface P2PrincipalSpec {
  readonly userId: string;
  readonly conversationId: string;
}

export interface P2ServerSpec {
  readonly dir: string;
  readonly principals: readonly P2PrincipalSpec[];
  readonly mode: 'inline' | 'background';
  readonly runtime?: RuntimeConfig;
  readonly book: P2ScriptBook;
  readonly client: ExecutionClient;
  readonly allowedOperations: readonly string[];
  /** U3：只读集合（执行层 access=read 派生）；独立于允许集合，写操作不得混入。 */
  readonly readOnlyOperations: readonly string[];
  readonly notificationSink?: NotificationSink;
  /** 注入 Worker 驱动（S7b 的 deadline-honoring 脚本化驱动；缺省 = 真实 Pi + 脚本 provider）。 */
  readonly workerDriverFactory?: () => import('../../../packages/agent/src/driver-contract').TurnDriver;
  /** 注入 Main 驱动（S5/S6 的 MU 计划驱动；缺省 = 真实 Pi + 脚本 provider）。 */
  readonly mainDriverFactory?: () => import('../../../packages/agent/src/driver-contract').TurnDriver;
}

export interface P2ServerHandle {
  readonly server: Server;
  readonly dir: string;
  readonly dbPath: string;
  readonly recorder: { readonly records: P2ExecRecord[] };
  /** 装配时交给 server 的只读集合（与执行面同一份真值；守护测试据此断言写操作不在其中）。 */
  readonly readOnlyOperations: readonly string[];
  readonly book: P2ScriptBook;
  readonly logs: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

function p2Config(spec: P2ServerSpec): AppConfig {
  const principals: AppConfig['principals'] = {};
  for (const principal of spec.principals) {
    principals[`wecom:${principal.userId}`] = { enabled: true, accountSetScope: 'all', capabilities: ['read'] };
  }
  return {
    principals,
    contextProfiles: {
      dummy: { root: MU_FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 派发方式不是配置键：server 恒 async；spec.mode 只留作评测样本的观测标签。
    runtime: spec.runtime ?? {},
  };
}

/** 启动一个 P2 server（生产同源装配；驱动 = 真实 Pi + 脚本 provider，可注入替换）。 */
export async function startP2Server(spec: P2ServerSpec): Promise<P2ServerHandle> {
  const env: NodeJS.ProcessEnv = { LLM_MODEL: 'test-model' };
  const recorder = new RecordingP2Client(spec.client);
  const logs: Array<Record<string, unknown>> = [];
  let calls = 0;

  const makeScripted = async (driver: 'main' | 'worker') => {
    const scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (_index, context) => spec.book.response(driver, context),
    });
    return scripted.runtime;
  };

  const createDrivers = async (_env: NodeJS.ProcessEnv, mainSession?: MainSessionLocation) => {
    const mainRuntime = spec.mainDriverFactory === undefined ? await makeScripted('main') : undefined;
    const workerRuntime = spec.workerDriverFactory === undefined ? await makeScripted('worker') : undefined;
    const main = spec.mainDriverFactory !== undefined
      ? spec.mainDriverFactory()
      // 主会话落盘归 Pi：装配层给的位置直接交给真实 Pi 驱动（sessionDir/sessionId/resumeSessionFile）。
      : createPiTurnDriver({
        env,
        modelRuntime: mainRuntime!,
        reuseConversation: true,
        ...(mainSession === undefined
          ? {}
          : {
            sessionDir: mainSession.sessionDir,
            sessionId: mainSession.piSessionId,
            ...(mainSession.resumeSessionFile === undefined ? {} : { resumeSessionFile: mainSession.resumeSessionFile }),
          }),
      });
    const worker = spec.workerDriverFactory !== undefined
      ? spec.workerDriverFactory()
      : createPiTurnDriver({ env, modelRuntime: workerRuntime! });
    return {
      mainDriver: recordingDriver(main, 'main', spec.book.toolSink),
      workerDriver: recordingDriver(worker, 'worker', spec.book.toolSink),
    };
  };

  // 单一装配入口给出的两套集合各走各的字段：只读集合不得用允许集合冒充（U3）。
  const face: ExecutionFace = {
    client: recorder,
    allowedOperations: spec.allowedOperations,
    readOnlyOperations: spec.readOnlyOperations,
  };
  const server = await createServer({
    env,
    config: p2Config(spec),
    dbPath: path.join(spec.dir, 'state.db'),
    stateDir: path.join(spec.dir, 'state'),
    createDrivers,
    createExecutionFace: async () => face,
    ...(spec.notificationSink === undefined ? {} : { notificationSink: spec.notificationSink }),
    // 原 background 装配由推送面显式声明（server 有推送面 = async）；inline 样本保持同步。
    ...(spec.mode === 'background'
      ? { fileDelivery: { deliveryMode: 'silent' as const, async sendToConversation() { throw new Error('（eval）silent 不投递'); } } }
      : {}),
    logger: (line) => logs.push(line),
  });
  return {
    server,
    dir: spec.dir,
    dbPath: path.join(spec.dir, 'state.db'),
    recorder,
    readOnlyOperations: face.readOnlyOperations,
    book: spec.book,
    logs,
    close: () => server.close(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐回合驱动（复用 long-session/harness 的 HarnessSession 接口与 runHarnessSession）
// ─────────────────────────────────────────────────────────────────────────────

interface P2HarnessSessionOptions {
  readonly handle: P2ServerHandle;
  readonly principalId: string;
  readonly sessionId: string;
  readonly book: P2ScriptBook;
  readonly sentTexts: string[];
  readonly replies: string[];
  readonly taskIdsPerTurn: string[][];
  readonly afterSend?: (turn: number, text: string, reply: string) => Promise<void>;
}

/**
 * 会话面适配：`send` 走**真实交互路径**（server.handler，与渠道同链），任务快照读
 * Task Registry 只读投影（`readTasks`），模型调用账本取脚本 provider 的逐次记录。
 */
class P2HarnessSession {
  private lastCancel = false;
  private messageSeq = 0;
  constructor(private readonly options: P2HarnessSessionOptions) {}

  private scopedTasks(): TaskView[] {
    return readTasks(this.options.handle.dbPath)
      .filter((task) => task.principalId === this.options.principalId && task.sessionId === this.options.sessionId)
      .map((task) => ({
        taskId: task.taskId,
        ...(task.taskNo === undefined ? {} : { taskNo: task.taskNo }),
        request: task.request,
        status: task.status,
        ...(task.reason === undefined ? {} : { reason: task.reason }),
        requestIds: task.requestIds,
      }));
  }

  async send(text: string): Promise<{ readonly reply: string; readonly taskIds: readonly string[] }> {
    this.messageSeq += 1;
    const messageId = `p2-${this.messageSeq}`;
    const principal = this.options.principalId.replace(/^wecom:/, '');
    const conversationId = this.options.sessionId.replace(/^wecom:/, '');
    const toolsBefore = this.options.book.toolSink.toolCalls.length;
    const reply = await deliver(this.options.handle.server.handler, incoming(
      principal as Parameters<typeof incoming>[0],
      conversationId,
      messageId,
      text,
    ));
    const calls = this.options.book.toolSink.toolCalls.slice(toolsBefore);
    this.lastCancel = calls.some((call) => call.tool === 'task_cancel');
    const done = [...this.options.handle.logs].reverse().find((line) => line['event'] === 'message_done' && line['messageId'] === messageId);
    const taskIds = (done?.['taskIds'] as string[] | undefined) ?? [];
    this.options.sentTexts.push(text);
    this.options.replies.push(reply);
    this.options.taskIdsPerTurn.push([...taskIds]);
    const turn = this.options.sentTexts.length;
    if (this.options.afterSend !== undefined) await this.options.afterSend(turn, text, reply);
    return { reply, taskIds };
  }

  tasks(): readonly TaskView[] { return this.scopedTasks(); }

  transcriptTokens(): number {
    const last = this.options.sentTexts[this.options.sentTexts.length - 1] ?? '';
    return Math.ceil(last.length / 4);
  }

  transcriptMessages(): number { return this.options.sentTexts.length * 2; }

  budget() {
    const ledger = this.options.book.ledgerFor(this.options.sentTexts);
    const observed = ledger.length > 0 && ledger.every((call) => call.tokensObserved);
    return {
      calls: ledger.length,
      tokens: ledger.reduce((sum, call) => sum + call.tokens.total, 0),
      tokensObserved: observed,
      ms: 0,
      summaryCalls: ledger.filter((call) => call.kind === 'summary').length,
    };
  }

  modelCallLedger(): readonly ModelCallRecord[] { return this.options.book.ledgerFor(this.options.sentTexts); }
  compactionAttempts(): readonly CompactionAttempt[] { return []; }
  cancelCalledLastTurn(): boolean { return this.lastCancel; }
}

export interface P2SampleRunInput {
  readonly caseId: string;
  readonly scenario: P2ScenarioId;
  readonly dir: string;
  readonly mode: 'inline' | 'background';
  readonly principal: P2PrincipalSpec;
  readonly texts: readonly string[];
  /** 真值事实（逐轮 1 起；只进 Oracle/证据，不进模型请求）。 */
  readonly facts: readonly { readonly turn: number; readonly expectation: FactExpectation }[];
  readonly book: P2ScriptBook;
  readonly client: ExecutionClient;
  readonly allowedOperations: readonly string[];
  /** U3：只读集合（与 allowedOperations 独立传递；从装配入口的真值一路带到 server）。 */
  readonly readOnlyOperations: readonly string[];
  readonly runtime?: RuntimeConfig;
  readonly notificationSink?: NotificationSink;
  readonly mainDriverFactory?: P2ServerSpec['mainDriverFactory'];
  readonly workerDriverFactory?: P2ServerSpec['workerDriverFactory'];
  /** 每回合产品返回后的钩子（S2 完成闸等）。 */
  readonly afterSend?: (turn: number, text: string, reply: string) => Promise<void>;
  /** 样本跑完的收尾（等后台完成 / 读最终快照）。 */
  readonly afterRun?: (handle: P2ServerHandle) => Promise<void>;
  /** server 启动后立刻回调（脚本闭包需要在回合内读执行事实/底账时用它拿 handle）。 */
  readonly onServerReady?: (handle: P2ServerHandle) => void;
  /** 额外手工事实（S2 闸计数、S5 重启读数等）。 */
  readonly extras?: (handle: P2ServerHandle) => Record<string, unknown>;
}

/** 跑一个单会话样本：真实交互路径逐轮 → R6 管线 → 观测（含执行事实/投递/账本）。 */
export async function runP2Sample(input: P2SampleRunInput): Promise<P2Observation> {
  const handle = await startP2Server({
    dir: input.dir,
    principals: [input.principal],
    mode: input.mode,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    book: input.book,
    client: input.client,
    allowedOperations: input.allowedOperations,
    readOnlyOperations: input.readOnlyOperations,
    ...(input.notificationSink === undefined ? {} : { notificationSink: input.notificationSink }),
    ...(input.mainDriverFactory === undefined ? {} : { mainDriverFactory: input.mainDriverFactory }),
    ...(input.workerDriverFactory === undefined ? {} : { workerDriverFactory: input.workerDriverFactory }),
  });
  input.onServerReady?.(handle);
  const principalId = `wecom:${input.principal.userId}`;
  const sessionId = `wecom:${input.principal.conversationId}`;
  const sentTexts: string[] = [];
  const replies: string[] = [];
  const taskIdsPerTurn: string[][] = [];
  const session = new P2HarnessSession({
    handle,
    principalId,
    sessionId,
    book: input.book,
    sentTexts,
    replies,
    taskIdsPerTurn,
    ...(input.afterSend === undefined ? {} : { afterSend: input.afterSend }),
  });
  const plan: TrackPlan = {
    track: 'LS1',
    turns: input.texts.map((text, index) => {
      const truth = input.facts.find((fact) => fact.turn === index + 1);
      return {
        index: index + 1,
        text,
        kind: 'task' as const,
        ...(truth === undefined ? {} : { fact: truth.expectation }),
      };
    }),
  };
  try {
    const run = await runHarnessSession({
      session,
      plan,
      wave: 'Wave1',
      track: 'P2',
      sessionId,
      principalId,
      model: 'scripted/test-model',
      contextWindow: 40_000,
      limits: {},
    });
    await input.afterRun?.(handle);
    // 收尾后重读终态（后台任务可能在本回合之后才落定）。
    const tasksFinal = readTasks(handle.dbPath)
      .filter((task) => task.principalId === principalId && task.sessionId === sessionId)
      .map((task) => ({
        taskId: task.taskId,
        ...(task.taskNo === undefined ? {} : { taskNo: task.taskNo }),
        request: task.request,
        status: task.status,
        ...(task.reason === undefined ? {} : { reason: task.reason }),
        requestIds: task.requestIds,
      }));
    const evidence: SessionEvidence = {
      ...run.evidence,
      tasksFinal,
      // 证据落盘也带执行轨迹（工具调用）：p2-evidence.json 有全量，这里给 R6 证据包同一投影。
      toolCalls: input.book.toolSink.toolCalls.map((call) => ({
        turn: 0,
        agent: call.driver,
        seq: call.seq,
        tool: call.tool,
        args: call.args,
        resultSummary: call.resultSummary,
        elapsedMs: call.elapsedMs,
      })),
    };
    return {
      caseId: input.caseId,
      scenario: input.scenario,
      principalId,
      sessionId,
      mode: input.mode,
      turns: sentTexts.map((text, index) => ({
        index: index + 1,
        text,
        reply: replies[index] ?? '',
        taskIds: taskIdsPerTurn[index] ?? [],
      })),
      taskTurns: evidence.taskTurns,
      tasksFinal,
      execRecords: [...handle.recorder.records],
      toolCalls: [...input.book.toolSink.toolCalls],
      deliveries: [...taskIdsPerTurn.flatMap((ids, index) => ids.map((taskId): MuDeliveryRecord => ({
        caseId: input.caseId,
        principalId,
        sessionId,
        taskId,
        request: sentTexts[index] ?? '',
        deliveredTo: sessionId,
        kind: 'reply',
      })))],
      modelCalls: [...input.book.ledgerFor(sentTexts)],
      compactionAttempts: [],
      transcriptTexts: sentTexts.map((text) => input.book.requestTexts.get(text) ?? ''),
      evidence,
      judgement: run.judgement,
      extras: {
        ...(input.extras?.(handle) ?? {}),
        // 全量记账（主 + Worker + 摘要 + 重试 + 溢出恢复；逐次 kind 可分离）：
        // R6 证据包的 callAccounting 是「本会话 Main 调用」口径，这里给样本全量账本，两者并列。
        callAccounting: input.book.accounting(),
        allModelCalls: [...input.book.calls],
      },
    };
  } finally {
    await handle.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据落盘（复用长会话 collectEvidence；P2 字段并列写入）
// ─────────────────────────────────────────────────────────────────────────────

/** 证据根（gitignored；collectEvidence 会在其下拼 `long-session/<wave>/<track>/<sessionId>`）。 */
export const P2_EVIDENCE_ROOT = path.resolve(process.cwd(), '.runtime');

/** 落盘：R6 证据包（collectEvidence）+ P2 判定/覆盖/执行事实（同目录）。 */
export function writeP2Evidence(input: {
  observation: P2Observation;
  verdict: Readonly<Record<string, unknown>>;
  root?: string;
}): { dir: string; summary: Record<string, unknown>; p2File: string } {
  const root = input.root ?? P2_EVIDENCE_ROOT;
  const written = collectEvidence(root, input.observation.evidence, input.observation.judgement);
  const p2Dir = path.join(written.dir, 'p2');
  mkdirSync(p2Dir, { recursive: true });
  const payload = {
    caseId: input.observation.caseId,
    scenario: input.observation.scenario,
    mode: input.observation.mode,
    principalId: input.observation.principalId,
    sessionId: input.observation.sessionId,
    verdict: input.verdict,
    execRecords: input.observation.execRecords,
    toolCalls: input.observation.toolCalls,
    deliveries: input.observation.deliveries,
    modelCalls: input.observation.modelCalls,
    extras: input.observation.extras,
    turns: input.observation.turns,
    tasksFinal: input.observation.tasksFinal,
    transcriptTexts: input.observation.transcriptTexts,
  };
  const p2File = path.join(p2Dir, 'p2-evidence.json');
  writeFileSync(p2File, `${JSON.stringify(payload, null, 2)}\n`);
  return { dir: written.dir, summary: written.summary, p2File };
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景辅助：deadline 契约驱动 / 证据与判定装配 / 等后台落定
// ─────────────────────────────────────────────────────────────────────────────

/** 从脚本化 assistant 消息里取第一个工具调用（deadline 驱动用）。 */
export function firstToolCallOf(message: AgentMessage): { name: string; arguments: Record<string, unknown> } {
  const content = (message as unknown as { content?: readonly unknown[] }).content ?? [];
  for (const part of content) {
    const record = part as { type?: unknown; name?: unknown; arguments?: unknown };
    if (record.type !== 'toolCall' || typeof record.name !== 'string') continue;
    const args = record.arguments !== null && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
    return { name: record.name, arguments: args };
  }
  throw new Error('deadline 驱动脚本第 1 次调用必须产出工具调用。');
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * **deadline/abort 契约遵守**的脚本化 Worker 驱动（预注册 §一 S7b 第 2 步写死）：
 *   · 第 1 次脚本响应 = 一次 `execute_operation` 工具调用；
 *   · 执行面可以永不结算 —— 本驱动在 `input.deadline` 处中止并抛 `AbortError`
 *     （`driver-contract.ts:31`「超时 driver 应中止并返回空文本」的同义实现）；
 *   · `createTaskExecutor` 据此落 `timed_out`（产品既有机制，不新增超时机制）。
 */
export function createDeadlineWorkerDriver(book: P2ScriptBook): import('../../../packages/agent/src/driver-contract').TurnDriver {
  return {
    async run(input) {
      const first = book.response('worker', { messages: input.messages });
      if (first === undefined) throw new Error('deadline 驱动缺脚本响应');
      const call = firstToolCallOf(first);
      const exec = input.exec(call.name, call.arguments, input.signal);
      const remaining = Math.max(1, input.deadline - Date.now() + 5);
      await Promise.race([
        exec,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(abortError()), remaining);
        }),
      ]);
      const reply = book.response('worker', { messages: [...input.messages, first] });
      const text = reply === undefined
        ? ''
        : (reply as unknown as { content?: readonly { type?: string; text?: string }[] }).content
            ?.filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('') ?? '';
      return { text, messages: [...input.messages, first, ...(reply === undefined ? [] : [reply])] };
    },
  };
}

/** 等任务快照直到 predicate（有界轮询；S2/S4/S7b 的后台落定用）。 */
export async function waitForTasks(
  dbPath: string,
  predicate: (tasks: ReturnType<typeof readTasks>) => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(readTasks(dbPath))) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate(readTasks(dbPath));
}

/** 手工装配（重启/并发等跨 server 场景）：SessionEvidence 的必填字段收敛在此。 */
export function sessionEvidenceOf(input: {
  readonly sessionId: string;
  readonly principalId: string;
  readonly turns: readonly { index: number; text: string; reply: string }[];
  readonly taskTurns: readonly TaskTurnFact[];
  readonly tasksFinal: readonly TaskView[];
  readonly modelCalls: readonly ModelCallRecord[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly infraSignals?: readonly string[];
  readonly productFaultSignals?: readonly string[];
  readonly toolCalls?: SessionEvidence['toolCalls'];
}): SessionEvidence {
  const usage = accountCalls(input.modelCalls);
  const startedAt = input.startedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const endedAt = input.endedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, input.turns.length)).toISOString();
  return {
    wave: 'Wave1',
    track: 'P2',
    sessionId: input.sessionId,
    principalId: input.principalId,
    model: 'scripted/test-model',
    contextWindow: 40_000,
    limits: {},
    budgetUsed: {
      calls: usage.calls,
      tokens: usage.tokens,
      tokensObserved: usage.tokensObserved,
      ms: 0,
      summaryCalls: usage.byKind.summary.calls,
    },
    budgetStopped: null,
    startedAt,
    endedAt,
    turns: input.turns.map((turn) => ({ index: turn.index, text: turn.text })),
    replies: input.turns.map((turn) => ({ index: turn.index, text: turn.reply, replyChars: turn.reply.length, durationMs: 0 })),
    compactionAttempts: [],
    tokenCurve: input.turns.map((turn, index) => ({
      turn: turn.index,
      transcriptTokens: Math.ceil(turn.text.length / 4),
      transcriptMessages: (index + 1) * 2,
      modelCalls: input.modelCalls.filter((call) => call.turn === turn.index).length,
      producedReply: turn.reply.trim().length > 0,
    })),
    modelCalls: input.modelCalls,
    callAccounting: usage,
    toolCalls: [...(input.toolCalls ?? [])],
    taskTurns: input.taskTurns,
    tasksFinal: input.tasksFinal,
    resourceSamples: [],
    infraSignals: input.infraSignals ?? [],
    productFaultSignals: input.productFaultSignals ?? [],
  };
}

/** 手工装配（重启/并发场景）：与 `runHarnessSession` 同一组 Oracle（事实/任务/压缩）。 */
export function judgementOf(input: {
  readonly facts: readonly { readonly expectation: FactExpectation; readonly reply: string }[];
  readonly taskTurns: readonly TaskTurnFact[];
  readonly compactionAttempts?: readonly CompactionAttempt[];
}): SessionJudgement {
  const verdicts = input.facts.map((entry) => judgeFactAnswer(entry.expectation, entry.reply));
  const failures = verdicts.flatMap((verdict) => (verdict.pass || verdict.code === null ? [] : [verdict.code]));
  return {
    factVerdicts: verdicts,
    sessionFactsPass: verdicts.every((verdict) => verdict.pass),
    factFailures: failures,
    taskVerdict: judgeTaskContinuity(input.taskTurns),
    compactionVerdict: judgeCompactionLifecycle(analyzeCompaction(input.compactionAttempts ?? [], [])),
  };
}
