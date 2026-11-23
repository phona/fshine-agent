/**
 * 快活 + 模型全程不说话 = **静默终局**（server 装配级，2026-11-19 复核形状的出口）。
 *
 * 形状（独立复核实测）：本回合交办的任务在短等待窗口内落定（`relayedTaskIds` 非空，
 * 结果已交给模型转述）**且**模型最终正文为空（催问一次后仍空）→ 回合判据豁免（taskIds
 * 非空）不判失败；完成回调按 `relayed_in_turn` 抑制播报；handler 返回空串 = 渠道零终帧。
 * 用户零推送、系统记 `message_done` 成功——明令禁止的静默终局。
 *
 * 钉住的用户级行为（假渠道事实 + 真实 Pi 会话 + 脚本化模型；零网络、零真实平台）：
 *   ① 主形状：快活 + 模型空正文 → 用户**收到了**宿主如实报完成事实那句（业务名 + 结果
 *      正文逐字），不是静默、不是说「再试一次」；不判回合失败、不重跑任务、不重复播报；
 *   ② 受理未落定（accepted）+ 空正文 → 照旧不判失败、零投递（欠他一条；落定后由既有
 *      唤醒/完成投递面送达——本文件同时钉住「之后送达」）；
 *   ③ 一无所有（无正文/无文件/无交办）→ 仍判回合失败（既有判据不动）；
 *   ④ 快活 + 模型说了话 → 照旧投递模型的话（不替换成宿主兜底）；
 *   ⑤ 反向绊线由实现变更现场实测（把出口改掉 → ① 必红），不落在本文件。
 *
 * 记账户型（与完成投递同一套四必守）：live 送达记 `task_result_delivery_sent`
 * （taskId/principalId/sessionId/deliveryMode），绝不静默。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../packages/agent/testing/scripted-model-runtime';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import type { Notification, NotificationSink } from '../../packages/agent/src/notifications';
import { failureMessageFor, internalTermIn } from '../../packages/agent/src/user-facing-failure';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { archivedReportOf } from '../../packages/agent/testing/task-facts';
import { fileStoragePathOf } from '../../packages/agent/src/file-store';
import type { RecalcXlsxExecutor } from '../../packages/agent/src/recalc-xlsx-executor';
import { mainSessionOptions } from '../../scripts/ask-runtime';
import { createServer, workspaceRootOf, type FileDeliveryPort, type Server } from './server';
import { taskCompletionFallbackText } from './task-completion-delivery';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
const ASK = '帮我汇总';
const TASK_TEXT = '帮我把结果汇总成一份文件';
const RESULT_TEXT = '汇总完成，共 3 条。';
const FAIL_REASON = '执行层拒绝';
/** 模型在（非静默）回合里说的话：刻意不含结果正文——用来区分「模型的话」与「宿主兜底」。 */
const MODEL_LINE = '好，这件事我盯过了，你随时问我细节。';
/** 慢活落定后的唤醒回合台词（既有唤醒路径，不被本切片改动）。 */
const WAKE_LINE = '你交办的那件事办好了：汇总完成，共 3 条。';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-relay-silent-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(taskRunWaitMs: number, overrides: Partial<NonNullable<AppConfig['runtime']>> = {}): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true } },
    contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 短等待窗口：窗口内落定 = 快活（relayed）；窗口外 = 受理（accepted）。
    runtime: { taskRunWaitMs, ...overrides },
  };
}

function incoming(messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

class CountingClient implements ExecutionClient {
  calls = 0;
  async capabilities(): Promise<CapabilityManifest> {
    return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
  }
  async execute(): Promise<ExecutionOutcome> {
    this.calls += 1;
    return { status: 'completed', data: {} };
  }
}

/** 执行层对每次调用都确定性拒绝（真实 Worker 路径：执行事实带 error.code 进底账）。 */
class FailingFaceClient implements ExecutionClient {
  calls = 0;
  constructor(private readonly code: string, private readonly message: string) {}
  async capabilities(): Promise<CapabilityManifest> {
    return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
  }
  async execute(): Promise<ExecutionOutcome> {
    this.calls += 1;
    return { status: 'failed', error: { code: this.code, message: this.message, retryable: false } };
  }
}

/**
 * 真实后台 Worker 回合的替身（只做形状）：调一次 execute_operation、如实汇报。
 * 与真实 Worker 一样：工具失败由汇报文本承接，执行事实（含 error.code）经宿主落底账。
 */
function executingWorkerDriver(): TurnDriver {
  return {
    async run(input) {
      await input.exec('execute_operation', { operation: 'dummy.query', args: {} }).catch(() => undefined);
      return { text: '执行层拒绝了这次查询。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

/** 立即完成的执行器：任务在等待窗口内落定（快活路线）。 */
class ImmediateExecutor implements TaskExecutor {
  calls = 0;
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return { kind: 'ended', report: RESULT_TEXT };
  }
}

/** 逐次给结果的执行器（同回合多任务用例：分辨「哪个任务」的结果）。 */
class SequencedExecutor implements TaskExecutor {
  calls = 0;
  constructor(private readonly results: readonly string[]) {}
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return { kind: 'ended', report: this.results[this.calls - 1] ?? `第 ${this.calls} 条结果。` };
  }
}

/** 受闸执行器：完成时机由用例控制（accepted 路线：窗口内不落定）。 */
class GatedExecutor implements TaskExecutor {
  calls = 0;
  private resolve?: (outcome: TaskExecutionOutcome) => void;
  private gate?: Promise<TaskExecutionOutcome>;
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    if (this.gate === undefined) {
      this.gate = new Promise<TaskExecutionOutcome>((resolve) => {
        this.resolve = resolve;
      });
    }
    return await this.gate;
  }
  settle(outcome: TaskExecutionOutcome): void {
    this.resolve?.(outcome);
    this.gate = undefined;
    this.resolve = undefined;
  }
}

/** 立即失败的执行器：窗口内落定 = 快活失败（注入式无执行事实 → code 取不到 = executor_failed）。 */
class FailingExecutor implements TaskExecutor {
  calls = 0;
  constructor(private readonly make: () => TaskExecutionOutcome = () => ({ kind: 'ended' })) {}
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return this.make();
  }
}

/** 同回合第一次失败、第二次成功（一成一败用例）。 */
class MixedExecutor implements TaskExecutor {
  calls = 0;
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return this.calls === 1 ? { kind: 'ended' } : { kind: 'ended', report: RESULT_TEXT };
  }
}

/** 假 recalc 产物身份（字节由用例先落盘，交付面才读得到）。 */
const FAKE_RECALC_FILE = { fileId: 'file_00000000-0000-4000-8000-00000000000b', name: '汇总.xlsx' } as const;

/**
 * 假 recalc_xlsx 执行器（只读审计 #8 的形状）：不真跑 soffice，直接回报一个**可交付**
 * 产物——让本回合的 `turn.files` 非空（Main 面只有这一条路能产交付物：run_js 结构性不产）。
 */
function fakeRecalc(file: { fileId: string; name: string }): RecalcXlsxExecutor {
  return {
    available: true,
    engineFacts: null,
    async recalc() {
      return {
        status: 'pass',
        errorCells: [],
        valueDiffs: [],
        artifacts: { reportPath: null, csvPath: null } as never,
        outputs: [{ ...file, bytes: 8, deliverable: true }],
        durationMs: 1,
      };
    },
  };
}

/** 把假 recalc 产物的字节落到交付面要读的位置（与 fileStore 的路径公式同源）。 */
function materializeFakeRecalcFile(dbPath: string): void {
  const target = fileStoragePathOf(workspaceRootOf(dbPath), {
    principalId: 'wecom:user-a',
    sessionId: 'wecom:conv-a',
  }, FAKE_RECALC_FILE.fileId, FAKE_RECALC_FILE.name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from('pk-fake-xlsx'));
}

/** 通知 sink 替身（只收事实；聊天推送走同一个 fakeDelivery 文本端口，与生产装配同形）。 */
class NoopSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

function fakeDelivery(): { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort } {
  const sentTexts: Array<{ route: ChannelRoute; text: string }> = [];
  return {
    sentTexts,
    port: {
      deliveryMode: 'live',
      async sendToConversation(route: ChannelRoute): Promise<DeliveryReceipt> {
        return { route, parts: [] };
      },
      async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
        sentTexts.push({ route, text });
        return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
      },
    },
  };
}

function textAssistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
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

function toolCallAssistant(name: string, args: Record<string, unknown>, tag = ''): AgentMessage {
  return {
    ...textAssistant(''),
    content: [{ type: 'toolCall', id: `call-${name}${tag}`, name, arguments: args }],
    stopReason: 'toolUse',
  } as unknown as AgentMessage;
}

function lastUserTextOf(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => String((part as { text?: unknown }).text ?? '')).join('');
    }
  }
  return '';
}

/**
 * 模型脚本（与复核复现同形）：用户消息 → 交办 `delegations` 次（缺省 1 次，逐次计数）；
 * 交办完之后（含催问）→ 空正文。`afterToolText` 非空时换成「模型说了话」的分支
 * （不回归用例 ④）；`emptyOnly` = 全程不交办、不产出正文（一无所有用例 ③）。
 */
function createScripted(input: {
  afterToolText?: string;
  /** 唤醒回合的台词（accepted 用例：任务稍后落定，走既有唤醒路径）。 */
  wakeLine?: string;
  emptyOnly?: boolean;
  /** 本回合交办次数（缺省 1）：同回合多任务用例走 2。 */
  delegations?: number;
  /**
   * 交办完之后再调一次 recalc_xlsx（Main 面**唯一**能产出交付物的路：run_js 结构性不产
   * 交付物）——造「本回合有文件」的形状（只读审计 #8）。
   */
  recalcBeforeSilence?: boolean;
  onWake?: () => void;
}) {
  const delegations = input.delegations ?? 1;
  const countTaskRuns = (messages: readonly { role?: string; content?: unknown }[]): number =>
    messages.filter((message) => message.role === 'assistant' && Array.isArray(message.content)
      && (message.content as Array<{ type?: string; name?: string }>)
        .some((block) => block.type === 'toolCall' && block.name === 'task_run')).length;
  return createScriptedModelRuntime({
    contextWindow: 40_000,
    script: (_index, context) => {
      if (input.emptyOnly === true) return textAssistant('');
      const last = lastUserTextOf(context.messages);
      if (last.startsWith('[回合结束]')) {
        input.onWake?.();
        return textAssistant(input.wakeLine ?? WAKE_LINE);
      }
      const issued = countTaskRuns(context.messages as readonly { role?: string; content?: unknown }[]);
      if (issued < delegations) {
        return toolCallAssistant('task_run', { task: TASK_TEXT }, issued === 0 ? '' : `-${issued}`);
      }
      if (input.recalcBeforeSilence === true) {
        const counts = (name: string): number => context.messages.filter((message) =>
          (message as { role?: string }).role === 'assistant' && Array.isArray((message as { content?: unknown }).content)
          && ((message as { content: Array<{ type?: string; name?: string }> }).content)
            .some((block) => block.type === 'toolCall' && block.name === name)).length;
        if (counts('recalc_xlsx') === 0) {
          return toolCallAssistant(
            'recalc_xlsx',
            { file: 'file_00000000-0000-4000-8000-00000000000b', export: 'csv' },
            '-rc',
          );
        }
      }
      return textAssistant(input.afterToolText ?? '');
    },
  });
}

interface Fixture {
  server: Server;
  dbPath: string;
  delivery: { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort };
  logs: Array<Record<string, unknown>>;
  executor: TaskExecutor;
  face: CountingClient | FailingFaceClient;
  sink?: NoopSink;
  wakeCalls: () => number;
  close(): Promise<void>;
}

async function makeFixture(input: {
  waitMs: number;
  executor?: TaskExecutor;
  afterToolText?: string;
  wakeLine?: string;
  emptyOnly?: boolean;
  delegations?: number;
  /**
   * 真实 Worker 路径（不注入 taskExecutor）：Worker 替身调一次 execute_operation，
   * 执行层按给定码拒绝——执行事实（error.code）进底账，失败事实的来源可被逐字验证。
   */
  workerExecutionFailure?: { code: string; message: string };
  /** 注入通知 sink：生产装配（有 notificationSink）时 chatSink 与通知 outbox 才接线。 */
  notificationSink?: boolean;
  /** runtime 段覆盖（例：backgroundConcurrency/queueCapacity 造资源拒绝）。 */
  runtimeOverrides?: Partial<NonNullable<AppConfig['runtime']>>;
  /** 交办完之后再调一次 recalc_xlsx 并沉默（「本回合有文件」的失败回合；只读审计 #8）。 */
  recalcBeforeSilence?: boolean;
}): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const delivery = fakeDelivery();
  const logs: Array<Record<string, unknown>> = [];
  const realWorker = input.workerExecutionFailure !== undefined;
  const executor = input.executor ?? new ImmediateExecutor();
  const sink = input.notificationSink === true ? new NoopSink() : undefined;
  const face = input.workerExecutionFailure === undefined
    ? new CountingClient()
    : new FailingFaceClient(input.workerExecutionFailure.code, input.workerExecutionFailure.message);
  let wakeCalls = 0;
  const scripted = createScripted({
    ...(input.afterToolText === undefined ? {} : { afterToolText: input.afterToolText }),
    ...(input.wakeLine === undefined ? {} : { wakeLine: input.wakeLine }),
    ...(input.emptyOnly === undefined ? {} : { emptyOnly: input.emptyOnly }),
    ...(input.delegations === undefined ? {} : { delegations: input.delegations }),
    ...(input.recalcBeforeSilence === undefined ? {} : { recalcBeforeSilence: input.recalcBeforeSilence }),
    onWake: () => { wakeCalls += 1; },
  });
  const runtime = await scripted;
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(input.waitMs, input.runtimeOverrides ?? {}),
    dbPath,
    createDrivers: (env, mainSession) => {
      const workerDriver: TurnDriver = realWorker
        ? executingWorkerDriver()
        : { async run(): Promise<never> { throw new Error('（测试）Worker 由 executor 替身接管'); } };
      const mainDriver = createPiTurnDriver({
        env,
        modelRuntime: runtime.runtime,
        reuseConversation: true,
        ...mainSessionOptions(mainSession),
      });
      return { mainDriver, workerDriver };
    },
    createExecutionFace: async () => ({
      client: face,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    ...(realWorker ? {} : { taskExecutor: executor }),
    ...(input.recalcBeforeSilence === true ? { createRecalcXlsxExecutor: () => fakeRecalc(FAKE_RECALC_FILE) } : {}),
    ...(sink === undefined ? {} : { notificationSink: sink }),
    fileDelivery: delivery.port,
    logger: (line) => logs.push(line),
  });
  return {
    server,
    dbPath,
    delivery,
    logs,
    executor,
    face,
    ...(sink === undefined ? {} : { sink }),
    wakeCalls: () => wakeCalls,
    close: async () => {
      if (executor instanceof GatedExecutor) executor.settle({ kind: 'ended' });
      // 让 settle 的收尾与由此触发的再派发（pump 走 microtask）落地后再停机——否则停机后
      // 触发的 pump 会撞上已关闭的底账连接（vitest 记未处理错误）。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await server.close();
    },
  };
}

describe('快活 + 模型沉默（server 级）：不许静默终局', () => {
  it('① 主形状：窗口内完成 + 模型全程空正文 → 用户收到如实报完成事实（含结果正文），不判失败、不说重试、不重复播报', async () => {
    const executor = new ImmediateExecutor();
    const fx = await makeFixture({ waitMs: 1_500, executor });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));

      // 用户收到了：宿主如实报完成事实那一句（业务名 + 结果正文逐字）——唯一允许的宿主文案。
      expect(fx.delivery.sentTexts).toHaveLength(1);
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(taskCompletionFallbackText({ name: TASK_TEXT, resultText: RESULT_TEXT }));
      expect(text).toContain('「帮我把结果汇总成一份文件」');
      expect(text).toContain(RESULT_TEXT);
      // 不得导向重试、不得说没弄好（任务其实已成功；诱导重做写操作是硬禁止）。
      expect(text).not.toContain('再试一次');
      expect(text).not.toContain('没弄好');
      expect(internalTermIn(text)).toBeUndefined();
      expect(fx.delivery.sentTexts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });

      // 不是判回合失败：回合成功落定（message_done 记 taskIds），handler 回执为空串——
      // 宿主的话只走主动投递面，模型的话路（渠道终帧）不被宿主替换。
      expect(reply).toBe('');
      const done = fx.logs.find((line) => line['event'] === 'message_done');
      expect(done).toBeDefined();
      expect((done!['taskIds'] as string[]).length).toBe(1);

      // 记账四必守：live 送达记 sent（带 taskId/principalId/sessionId/deliveryMode），无 failed。
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        principalId: 'wecom:user-a',
        sessionId: 'wecom:conv-a',
        taskId: (done!['taskIds'] as string[])[0],
        deliveryMode: 'live',
      });
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_failed')).toBe(false);

      // 任务不被重跑、不被误判：执行器只调用一次、底账 completed；不白花唤醒模型调用。
      const taskId = (done!['taskIds'] as string[])[0]!;
      expect(executor.calls).toBe(1);
      expect(fx.wakeCalls()).toBe(0);
      const ro = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        // S1 事实模型：底账没有 status——后台汇报已存档即「办完」的账本事实。
        expect(ro.get(taskId, SCOPE).replyText).toBe(RESULT_TEXT);
      } finally {
        ro.close();
      }

      // 完成回调的 relayed 抑制照旧（事实已在上面送达，不重复播报）——等回调落定后仍是 1 条。
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toBe(true);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it('② 不回归：受理未落定（accepted）+ 空正文 → 不判失败、零投递（欠他一条，落定后由唤醒送达）', async () => {
    const executor = new GatedExecutor();
    // 窗口 50ms：窗口内不落定 → 受理回执（无 summary，不是 relayed）。
    const fx = await makeFixture({ waitMs: 50, executor });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      // 任务还欠着：此刻零投递（结果没出来，没什么可报）。
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => String(line['event']).startsWith('task_result_delivery_'))).toBe(false);

      // 落定后由既有唤醒/完成投递面送达（机制不变）——「欠他一条」不是「永远沉默」。
      executor.settle({ kind: 'ended', report: RESULT_TEXT });
      await vi.waitFor(() => {
        expect(fx.delivery.sentTexts).toHaveLength(1);
      }, { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(WAKE_LINE);
      expect(fx.wakeCalls()).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('③ 不回归：一无所有（无正文/无文件/无交办）→ 仍判回合失败', async () => {
    const fx = await makeFixture({ waitMs: 1_500, emptyOnly: true });
    try {
      // 脚本模型本轮不交办、不产出正文：空回复。handler 必须抛（回合失败），不得静默成功。
      await expect(fx.server.handler(incoming('m-1', ASK))).rejects.toThrow(/未产出可用回复/);
      expect(fx.logs.some((line) => line['event'] === 'message_done')).toBe(false);
      expect(fx.delivery.sentTexts).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });

  it('④ 不回归：快活 + 模型说了话 → 照旧投递模型的话（不替换成宿主兜底）', async () => {
    const fx = await makeFixture({ waitMs: 1_500, afterToolText: MODEL_LINE });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      // 用户看到的就是模型说的那句（渠道终帧 = 模型的话），不是宿主兜底、也不含结果正文。
      expect(reply).toBe(MODEL_LINE);
      expect(reply).not.toContain(RESULT_TEXT);
      // 模型说过话了：完成回调照旧抑制重复播报，宿主不另推一条兜底。
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toBe(true);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.wakeCalls()).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it('⑤ 同回合多个快活任务 + 模型沉默 → 逐条如实投递（保序、不重不漏、各归各的结果）', async () => {
    const executor = new SequencedExecutor(['第一条结果。', '第二条结果。']);
    const fx = await makeFixture({ waitMs: 1_500, executor, delegations: 2 });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      // 两条事实都在、顺序与交办顺序一致、各带各的结果正文（不合并、不串号）。
      expect(fx.delivery.sentTexts.map((entry) => entry.text)).toEqual([
        taskCompletionFallbackText({ name: TASK_TEXT, resultText: '第一条结果。' }),
        taskCompletionFallbackText({ name: TASK_TEXT, resultText: '第二条结果。' }),
      ]);
      expect(executor.calls).toBe(2);
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((line) => line['taskId'])).size).toBe(2);
      // 两个任务各自的完成回调都按 relayed 抑制——不重复播报（各一条、共两条）。
      await vi.waitFor(() => {
        expect(fx.logs.filter((line) => line['event'] === 'task_result_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toHaveLength(2);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(2);
      expect(fx.wakeCalls()).toBe(0);
    } finally {
      await fx.close();
    }
  });
});

/**
 * 相邻形状（2026-11-19 复核，同一病根的失败出口）：短等待窗口内**失败**的快活任务
 * （pushSuppressedTaskIds 非空）+ 模型沉默 → 失败回调按 claimPushSuppressedInTurn 抑制
 * → 用户同样什么都收不到。出口与成功侧同形同在：回合末 reply 空 + 无文件 + 有
 * pushSuppressedTaskIds → 逐条按**既有失败话术**如实送达（deliverTaskFailure；事实
 * 【执行事实的 error.code / result_unknown 状态】从底账取，与失败回调同源）。
 */
describe('快活失败 + 模型沉默（server 级）：失败也必须送达', () => {
  it('① 主形状：窗口内失败 + 模型全程空正文 → 用户收到既有失败话术那一句（不判失败、不重复）', async () => {
    const executor = new FailingExecutor();
    // 通知 sink 按生产装配注入：failed 不进推送种类（既有口径），宿主失败投递是唯一出口。
    const fx = await makeFixture({ waitMs: 1_500, executor, notificationSink: true });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));

      // 用户收到了：失败话术（逐字 = failureMessageFor(executor_failed)——注入式执行器无执行
      // 事实，码取不到时的既有归类）；不是成功兜底、不含结果正文当成功说。
      expect(fx.delivery.sentTexts).toHaveLength(1);
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(failureMessageFor('executor_failed').text);
      expect(text).toContain('没办成');
      expect(text).not.toContain('办好了');
      expect(text).not.toContain(RESULT_TEXT);
      expect(internalTermIn(text)).toBeUndefined();
      expect(fx.delivery.sentTexts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });

      // 不是判回合失败：回合成功落定（message_done 记 taskIds），任务终局 failed 不被重跑。
      expect(reply).toBe('');
      const done = fx.logs.find((line) => line['event'] === 'message_done');
      expect((done?.['taskIds'] as string[] | undefined)?.length).toBe(1);
      expect(executor.calls).toBe(1);
      const taskId = (done!['taskIds'] as string[])[0]!;
      const ro = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        // S1 事实模型：底账没有 status——已启动但无汇报 = 机械事实词「failed」。
        expect(archivedReportOf(ro.get(taskId, SCOPE))).toBeUndefined();
      } finally {
        ro.close();
      }

      // 记账四必守：live 送达记 sent（带任务身份），无 failed。
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        taskId,
        principalId: 'wecom:user-a',
        sessionId: 'wecom:conv-a',
        deliveryMode: 'live',
      });
      // 通知推送面不重复发（failed 不进推送种类；事实照常落 sink，只是不推）。
      expect(fx.sink!.sent.some((notification) => notification.kind === 'failed')).toBe(true);
      expect(fx.logs.some((line) => line['event'] === 'notification_push_sent')).toBe(false);
      // 失败回调的抑制照旧核销（本回合已送达，不重复发）——等回调落定后仍是 1 条。
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_failure_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toBe(true);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it('①b 失败事实从底账取：执行事实的 error.code 决定话术种类（真实 Worker 路径）', async () => {
    // Worker 替身在窗口内被执行层以 GATE_REFUSE 拒绝 → error.code 经 onTaskFailed 进 roundFailure →
    // 回合末沉默兜底把 code 喂 classifyFailure → 按既有归类（denied）投递话术。
    const fx = await makeFixture({
      waitMs: 1_500,
      workerExecutionFailure: { code: 'GATE_REFUSE', message: '执行层拒绝了这次查询' },
    });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      expect(fx.delivery.sentTexts).toHaveLength(1);
      expect(fx.delivery.sentTexts[0]!.text).toBe(failureMessageFor('denied').text);
      // 执行层原文/内部码不进用户文本。
      expect(fx.delivery.sentTexts[0]!.text).not.toContain('GATE_REFUSE');
      expect(fx.delivery.sentTexts[0]!.text).not.toContain('执行层');
      // 底账执行事实里确实带着那个码（证明文本不是凭空来的）。
      const done = fx.logs.find((line) => line['event'] === 'message_done');
      const taskId = (done!['taskIds'] as string[])[0]!;
      const ro = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        const record = ro.get(taskId, SCOPE);
        expect(record.executions.some((execution) => execution.status === 'failed')).toBe(true);
        expect(record.executions.some((execution) => execution.error?.code === 'GATE_REFUSE')).toBe(true);
      } finally {
        ro.close();
      }
    } finally {
      await fx.close();
    }
  });

  it('①c 结果未知（result_unknown）单独带状态：说「先别重复」，不说重试', async () => {
    const executor = new FailingExecutor(() => ({ kind: 'result_unknown', reason: '回执丢失' }));
    const fx = await makeFixture({ waitMs: 1_500, executor });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      expect(fx.delivery.sentTexts).toHaveLength(1);
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(failureMessageFor('unknown_result').text);
      expect(text).toContain('先别重复');
      expect(text).not.toContain('再试一次');
    } finally {
      await fx.close();
    }
  });

  it('①d 部分完成：执行事实带 partial → 模型沉默时兜底逐项说「已完成/未成功」，不笼统说全没办成', async () => {
    // D1：写已落库 + 另一个对象的写失败 → partial 事实（只给兜底话术，不是状态词）。
    // 用户该听到的是「哪件成了、哪件没成」，不是「没办成、再试一次」（后者会诱导重复写）。
    const executor = new FailingExecutor(() => ({
      kind: 'ended',
      report: 'alpha 那笔写好了，beta 那笔没成。',
      partial: { completed: ['alpha'], failed: ['beta'] },
    }));
    const fx = await makeFixture({ waitMs: 1_500, executor });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      expect(fx.delivery.sentTexts).toHaveLength(1);
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain('已完成 alpha');
      expect(text).toContain('未成功 beta');
      expect(text).not.toBe(failureMessageFor('executor_failed').text);
      expect(internalTermIn(text)).toBeUndefined();
    } finally {
      await fx.close();
    }
  });

  it('② 不回归：失败但模型说了话 → 宿主完全不介入（用户看到的话永远是模型说的）', async () => {
    const executor = new FailingExecutor();
    const fx = await makeFixture({ waitMs: 1_500, executor, afterToolText: MODEL_LINE });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe(MODEL_LINE);
      // 回合结束后给抑制记账一点时间：模型同回合已说明 → 宿主不另推一条失败话术。
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_failure_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toBe(true);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });

  it('③ 非失败终局（注入式取消）+ 沉默 → 交回既有终态推送面：一条取消通知，不冒充失败、不重复', async () => {
    // 取消/超时/未执行在窗口内不可达（要用户取消命令或 Worker 截止，二者都进不了 8s 窗口，
    // 只有注入式执行器能造）：不替它们说失败话——核销本回合抑制，既有终态推送面照常送达。
    // 通知 sink 按生产装配注入（有 notificationSink 时 chatSink 与 outbox 才接线）。
    const executor = new FailingExecutor(() => ({ kind: 'cancelled' }));
    const fx = await makeFixture({ waitMs: 1_500, executor, notificationSink: true });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain('已按你说的停了');
      expect(text).toContain(TASK_TEXT);
      expect(text).not.toBe(failureMessageFor('executor_failed').text);
      // 既有通知面确实收到事实（不是宿主新造的话术）。
      expect(fx.sink!.sent.some((notification) => notification.kind === 'cancelled')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it('③b 资源拒绝（failed 终局，通知面也认这一类）+ 沉默 → 恰一条（失败话术），不双发', async () => {
    // 窗口内被拒（后台满员 + 队列满）：底账 failed + reason=resource_limited。失败投递面与
    // 通知面（resource_limited 种类）都认这笔任务——核销只发生一次，用户只收到一条：
    // 本切片走失败投递（既有 failureMessageFor 话术），通知面按既有 relayed 抑制记账。
    const executor = new GatedExecutor();
    const fx = await makeFixture({
      waitMs: 100,
      executor,
      delegations: 2,
      notificationSink: true,
      // 唯一并发位被第一个任务占住 + 队列容量 0 → 第二个交办确定性拒绝（resource_limited）。
      runtimeOverrides: { backgroundConcurrency: 1, queueCapacity: 0 },
    });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      expect(fx.delivery.sentTexts).toHaveLength(1);
      // 2026-11-19 只读审计 #18：这件事的实话是「系统太忙，这个没接」，不是「执行端没办成」
      // ——底账 reason=resource_limited 单独成句（既有渲染文案 + 既有动作句）。
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain('系统太忙，这个没接');
      expect(text).toContain('先放着');
      expect(text).not.toBe(failureMessageFor('executor_failed').text);
      expect(text).not.toContain('没办成');
      // 通知面没有第二条（同一件事不双发——relayed 抑制照旧）。
      expect(fx.delivery.sentTexts.filter((entry) => entry.text.includes('系统太忙'))).toHaveLength(1);
      expect(fx.logs.some((line) => line['event'] === 'notification_push_suppressed'
        && line['reason'] === 'relayed_in_turn')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it('③c 快活失败 + 沉默 + **本回合有文件** → 失败话术照样送达（不再被 files 条件吞掉）', async () => {
    // 2026-11-19 只读审计 #8：兜底判据原先要求「正文空 **且** 无文件」，于是「交办失败
    // + 同时产出了文件」时用户只拿到文件、永远不知道失败了。判据改看**模型沉默**（与文件无关）。
    const executor = new FailingExecutor();
    const fx = await makeFixture({ waitMs: 1_500, executor, recalcBeforeSilence: true });
    try {
      materializeFakeRecalcFile(fx.dbPath);
      const reply = await fx.server.handler(incoming('m-1', ASK));
      // 正文：模型沉默 + 本回合有文件 → 渠道终帧是既有「文件已生成（见附件）」通知（不替换成兜底）。
      expect(reply).toBe('文件已生成（见附件）');
      console.log('EVENTS', JSON.stringify(fx.logs.map((line) => line['event'])));
      // 文件确实进了本回合交付面（不是「没文件所以走了兜底」冒充）。
      expect(fx.logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(true);
      // 失败话术依然送达（既有失败话术那一条；不因为本回合有文件就沉默——审计 #8 的核心）。
      expect(fx.delivery.sentTexts.map((entry) => entry.text)).toContain(failureMessageFor('executor_failed').text);
      const text = fx.delivery.sentTexts.find((entry) => entry.text === failureMessageFor('executor_failed').text)!;
      expect(internalTermIn(text.text)).toBeUndefined();
      // 失败回调按既有 relayed 抑制核销（同一条已在回合内送达，不重复发）。
      await vi.waitFor(() => {
        expect(fx.logs.filter((line) => line['event'] === 'task_failure_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toHaveLength(1);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts.filter((entry) => entry.text.includes('没办成'))).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it('④ 同回合一成一败 + 沉默 → 两条都在、各是各的话、无重复', async () => {
    const executor = new MixedExecutor();
    const fx = await makeFixture({ waitMs: 1_500, executor, delegations: 2, notificationSink: true });
    try {
      const reply = await fx.server.handler(incoming('m-1', ASK));
      expect(reply).toBe('');
      // 失败那条：既有失败话术；成功那条：既有完成兜底（业务名 + 结果正文）——互不冒充。
      expect(fx.delivery.sentTexts.map((entry) => entry.text)).toEqual([
        taskCompletionFallbackText({ name: TASK_TEXT, resultText: RESULT_TEXT }),
        failureMessageFor('executor_failed').text,
      ]);
      expect(executor.calls).toBe(2);
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((line) => line['taskId'])).size).toBe(2);
      // 完成回调与失败回调各自抑制核销：两条推送、零重复。
      await vi.waitFor(() => {
        expect(fx.logs.filter((line) => line['event'] === 'task_result_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toHaveLength(1);
        expect(fx.logs.filter((line) => line['event'] === 'task_failure_delivery_suppressed'
          && line['reason'] === 'relayed_in_turn')).toHaveLength(1);
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(2);
      expect(fx.wakeCalls()).toBe(0);
    } finally {
      await fx.close();
    }
  });
});
