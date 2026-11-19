/**
 * 状态变化 = **唤醒会话里的模型 → 宿主投递它说的话**（server 装配级，2026-11-19 唤醒切片
 * 的四条出口：失败 / 用户说停 / 久无动静 / 重启对账）。完成出口的形状在
 * `server-completion-wake.test.ts` 钉住，这里钉其余四条。
 *
 * 钉住的用户级行为（假渠道事实 + 真实 Pi 会话 + 脚本化模型；零网络、零真实平台）：
 *   ① 失败：投递文本 == 脚本模型唤醒回合产出的那句（宿主不再直接投失败话术）；喂给模型的是
 *      事实（业务名 + 归类后的业务种类 + 机械原因），转录里那句话在；
 *   ①b 走岔路：唤醒回合只调工具、不产出正文 → 用户仍拿到既有失败话术（降级兜底）；
 *   ①c 唤醒不可用（驱动无唤醒能力）→ 既有失败话术 + 事实留待注入（下次开口补说）；
 *   ② 用户说停：wake 出口说（渲染文案「已按你说的停了」降级为兜底，不再直发）；
 *   ②b 走岔路：模型说不出话 → 用户仍拿到渲染兜底那句，任务保持 cancelled；
 *   ③ 久无动静：唤醒模型说（事实带业务名与分钟数）；任务保持 running（不被误判终态）；
 *   ③b 走岔路：模型说不出话 → 用户仍拿到宿主兜底句（停下来 / 继续等）；
 *   ④ 重启对账：启动 pump 把「用户以为在办、租约已过期」的任务如实落 result_unknown → 唤醒
 *      原会话说清（此前没有任何东西告诉他）；任务不被重放（执行器零调用）；
 *   ④b 走岔路：模型说不出话 → 只记事件、零投递（宿主**没有**这一条的文案，不猜）。
 *
 * 记账字段（不许少）：task_result_delivery_sent 带 taskId/principalId/sessionId/deliveryMode；
 * 每条出口各有自己的唤醒事件（task_failure_wake / task_cancel_wake / task_long_running_wake /
 * task_restart_wake）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver, TurnDriverInput } from '../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime, type ScriptedModelRuntime } from '../../packages/agent/testing/scripted-model-runtime';
import type { Notification, NotificationSink } from '../../packages/agent/src/notifications';
import { deriveTaskName } from '../../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import {
  LONG_RUNNING_NOTICE_FALLBACK_TEXT,
  type TaskExecutionInput,
  type TaskExecutionOutcome,
  type TaskExecutor,
} from '../../packages/agent/src/task-runner';
import { failureMessageFor, internalTermIn } from '../../packages/agent/src/user-facing-failure';
import { mainSessionOptions } from '../../scripts/ask-runtime';
import { createServer, type FileDeliveryPort, type Server } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const PRINCIPAL = 'wecom:user-a';
const SESSION = 'wecom:conv-a';
const SCOPE = { principalId: PRINCIPAL, sessionId: SESSION };
const ASK = '帮我汇总';
const TASK_TEXT = '帮我把结果汇总成一份文件';
const TASK_NAME = deriveTaskName(TASK_TEXT);
const FAIL_REASON = '执行层拒绝';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-state-wake-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(overrides: Partial<NonNullable<AppConfig['runtime']>> = {}): AppConfig {
  return {
    principals: { [PRINCIPAL]: { enabled: true } },
    contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: { taskRunWaitMs: 0, ...overrides },
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

/** 计数执行面：唤醒回合的工具调用若碰到执行面，这条计数就不是 0。 */
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

/** 通知面替身（取消这类出口走 outbox → chat sink，需要 notificationSink 才接线）。 */
class NoopSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

/** 受闸执行器：结局由用例控制（settle）；`hanging` 模式永不落定（久无动静用例）。 */
class GatedExecutor implements TaskExecutor {
  calls = 0;
  private resolve?: (outcome: TaskExecutionOutcome) => void;
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return await new Promise<TaskExecutionOutcome>((resolve) => {
      this.resolve = resolve;
    });
  }
  settle(outcome: TaskExecutionOutcome): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(outcome);
  }
}

function fakeDelivery(deliveryMode: 'live' | 'silent' = 'live'): {
  sentTexts: Array<{ route: ChannelRoute; text: string }>;
  port: FileDeliveryPort;
} {
  const sentTexts: Array<{ route: ChannelRoute; text: string }> = [];
  return {
    sentTexts,
    port: {
      deliveryMode,
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

function toolCallAssistant(name: string, args: Record<string, unknown>): AgentMessage {
  return {
    ...textAssistant(''),
    content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
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

/** 唤醒回合：模型按**事实**说一句（业务名从事实里取——钉住「事实里带名字」这条链）。 */
function wakeLineFor(factText: string, mode: 'line' | 'silent' | 'tool-only', wakeCalls: number): AgentMessage {
  if (mode === 'silent') return textAssistant('');
  if (mode === 'tool-only') return wakeCalls === 1 ? toolCallAssistant('task_run', { task: TASK_TEXT }) : textAssistant('');
  const name = /「([^」]+)」/.exec(factText)?.[1];
  const subject = name === undefined ? '你交代的那件事' : `「${name}」`;
  if (factText.startsWith('[任务失败]')) return textAssistant(`${subject}这次没办成。要我再试一次，还是先放着？`);
  if (factText.startsWith('[已停止]')) return textAssistant(`${subject}已经停了。`);
  if (factText.startsWith('[久无动静]')) return textAssistant(`${subject}比预计久了。要我停下来，还是继续等？`);
  if (factText.startsWith('[重启对账]')) return textAssistant(`${subject}我这边重启过，状态说不清了；你说一声我就重来。`);
  throw new Error(`脚本没有这条事实的台词：${factText.slice(0, 80)}`);
}

type Mode = 'line' | 'silent' | 'tool-only' | 'no-wake';

interface Fixture {
  server: Server;
  dbPath: string;
  delivery: { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort };
  logs: Array<Record<string, unknown>>;
  executor: GatedExecutor;
  face: CountingClient;
  mainDriver?: TurnDriver;
  scripted?: ScriptedModelRuntime;
  recorded: TurnDriverInput[];
  close(): Promise<void>;
}

async function makeFixture(mode: Mode, options: {
  runtimeOverrides?: Partial<NonNullable<AppConfig['runtime']>>;
  /** 预置一条「上一进程死在回合里、租约已过期」的 running 行（重启对账用例）。 */
  seedInterrupted?: boolean;
  /** 预置一条「用户说了停、执行端没确认就断电」的 cancelling 行（取消孤儿；审计 #14）。 */
  seedCancelling?: boolean;
  /** 投递面模式（缺省 live；silent = 非 live 部署的抑制语义）。 */
  deliveryMode?: 'live' | 'silent';
  /** 执行器替身覆盖（缺省 = 受闸的 GatedExecutor；抛错回合用例用）。 */
  executorOverride?: TaskExecutor;
} = {}): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  if (options.seedInterrupted === true) {
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      registry.begin({ taskId: 'task_interrupted', ...SCOPE, request: TASK_TEXT });
      // 补一条**已经过期**的租约：形状 = 上一进程死在回合中（本进程重启后 pump 的
      // expireLeases 如实把它落 result_unknown，不重放）。
      registry.store.applyTaskState('task_interrupted', {
        expectedStatus: 'running',
        status: 'running',
        leaseOwner: 'dead-process',
        leaseUntil: new Date(Date.now() - 1_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    } finally {
      registry.close();
    }
  }
  if (options.seedCancelling === true) {
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      registry.begin({ taskId: 'task_cancelling_orphan', ...SCOPE, request: TASK_TEXT });
      registry.requestCancel('task_cancelling_orphan');
      // 取消请求时刻推到一个租约窗口之前：形状 = 断电遗留（不是本进程正在确认的取消）。
      registry.store.applyTaskState('task_cancelling_orphan', {
        expectedStatus: 'cancelling',
        status: 'cancelling',
        updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
    } finally {
      registry.close();
    }
  }
  const delivery = fakeDelivery(options.deliveryMode ?? 'live');
  const logs: Array<Record<string, unknown>> = [];
  const executor = new GatedExecutor();
  const effectiveExecutor = options.executorOverride ?? executor;
  const face = new CountingClient();
  const recorded: TurnDriverInput[] = [];
  const fixture: Fixture = {
    server: undefined as unknown as Server,
    dbPath,
    delivery,
    logs,
    executor,
    face,
    recorded,
    close: async () => {
      executor.settle({ kind: 'failed', reason: '（测试清理）' });
      // 让收尾回合链跑完再关库（否则挂起回合在已关的底账上收尾，吐噪声）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      await fixture.server.close();
    },
  };

  let scripted: ScriptedModelRuntime | undefined;
  let wakeCalls = 0;
  if (mode !== 'no-wake') {
    scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (_index, context) => {
        const last = lastUserTextOf(context.messages);
        if (last.startsWith('[任务完成]') || last.startsWith('[任务失败]') || last.startsWith('[已停止]')
          || last.startsWith('[久无动静]') || last.startsWith('[重启对账]')) {
          wakeCalls += 1;
          return wakeLineFor(last, mode, wakeCalls);
        }
        if (last === ASK) {
          const hasToolResult = context.messages.some((message) => (message as { role?: string }).role === 'toolResult');
          return hasToolResult
            ? textAssistant('好的，这件事我交给后台办，办完发你。')
            : toolCallAssistant('task_run', { task: TASK_TEXT });
        }
        // silent 模式对任何输入都不产出正文（含驱动的「催一句」）——测「模型说不出话」。
        return textAssistant(mode === 'silent' ? '' : '好的。');
      },
    });
    fixture.scripted = scripted;
  }

  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(options.runtimeOverrides),
    dbPath,
    createDrivers: (env, mainSession) => {
      const workerDriver: TurnDriver = { async run(): Promise<never> { throw new Error('（测试）Worker 由 executor 替身接管'); } };
      if (mode === 'no-wake') {
        // 假驱动：能跑回合、但没有唤醒能力（旧会话对象/测试替身形状）——wake 走 unavailable。
        let firstTurn = true;
        const driver: TurnDriver = {
          async run(input) {
            recorded.push(input);
            if (firstTurn) {
              firstTurn = false;
              await input.exec('task_run', { task: TASK_TEXT });
              return { text: '好的，交给后台办。', messages: [...input.messages] };
            }
            return { text: '收到。', messages: [...input.messages] };
          },
        };
        fixture.mainDriver = driver;
        return { mainDriver: driver, workerDriver };
      }
      const driver = createPiTurnDriver({
        env,
        modelRuntime: scripted!.runtime,
        reuseConversation: true,
        ...mainSessionOptions(mainSession),
      });
      fixture.mainDriver = driver;
      return { mainDriver: driver, workerDriver };
    },
    createExecutionFace: async () => ({
      client: face,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    taskExecutor: effectiveExecutor,
    fileDelivery: delivery.port,
    // 取消走 outbox → chat sink（有 notificationSink 才接线）；其余出口由各自的回调/启动
    // 对账直接触发，不依赖通知面。
    notificationSink: new NoopSink(),
    logger: (line) => logs.push(line),
  });
  fixture.server = server;
  return fixture;
}

function readTask(dbPath: string, taskId: string): { status: string; reason?: string } {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    const record = registry.get(taskId, SCOPE);
    return { status: record.status, ...(record.reason === undefined ? {} : { reason: record.reason }) };
  } finally {
    registry.close();
  }
}

function userTextOf(message: unknown): string {
  const record = message as { role?: unknown; content?: unknown } | undefined;
  if (record?.role !== 'user') return '';
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => String((part as { text?: unknown }).text ?? '')).join('');
  }
  return '';
}

/** 某一回合的模型请求里是否带了以 prefix 开头的一条 user 文本（fact 注入/注入器断言用）。 */
function requestHasUserText(requests: ReadonlyArray<{ messages: readonly unknown[] }>, prefix: string): boolean {
  return requests.some((request) => request.messages.some((message) => userTextOf(message).startsWith(prefix)));
}

function wakeEventOf(logs: Array<Record<string, unknown>>, event: string): Record<string, unknown> | undefined {
  return logs.find((line) => line['event'] === event);
}

describe('状态变化唤醒（server 级）：失败', () => {
  it('① 后台失败 → 投递文本 == 脚本模型唤醒回合那句；事实带业务名/分类/机械原因；任务不被误判', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'failed', reason: FAIL_REASON });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`「${TASK_NAME}」这次没办成。要我再试一次，还是先放着？`);
      // 不是宿主直接投的失败话术（那句只作模型挂掉时的兜底）。
      expect(text).not.toBe(failureMessageFor('executor_failed').text);
      expect(internalTermIn(text)).toBeUndefined();
      expect(text).not.toContain('task_run');

      // 事实链：喂给模型的事实带业务名 + 业务种类 + 机械原因；不含执行层原始码。
      const transcript = fx.mainDriver!.transcript?.() ?? [];
      const texts = transcript.map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((block) => String((block as { text?: unknown }).text ?? '')).join('');
        return '';
      });
      const fact = texts.find((entry) => entry.startsWith('[任务失败]'));
      expect(fact).toBeDefined();
      expect(fact).toContain(`「${TASK_NAME}」`);
      expect(fact).toContain('问题分类：没办成（业务原因不明）');
      expect(fact).toContain(FAIL_REASON);
      // 事实里带「给他一个能做的下一步」这条交代（语气与措辞归模型，可执行性不归它）。
      expect(fact).toContain('下一步');

      const wake = wakeEventOf(fx.logs, 'task_failure_wake');
      expect(wake).toMatchObject({ outcome: 'woken', principalId: PRINCIPAL, sessionId: SESSION });
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
      // 任务保持 failed（不被唤醒回合改判）、执行器只被调用一次。
      expect(readTask(fx.dbPath, String(wake!['taskId'])).status).toBe('failed');
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('①b 走岔路：唤醒回合只调工具、不产出正文 → 用户仍拿到既有失败话术；任务不被重跑、执行层零新增调用', async () => {
    const fx = await makeFixture('tool-only');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'failed', reason: FAIL_REASON });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(failureMessageFor('executor_failed').text);
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_failure_wake');
      expect(wake).toMatchObject({ outcome: 'failed' });
      expect(readTask(fx.dbPath, String(wake!['taskId'])).status).toBe('failed');
      expect(fx.executor.calls).toBe(1);
      expect(fx.face.calls).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it('①d 回合抛错（执行器/Worker 驱动故障）也是失败终局 → 同一条失败出口（唤醒说）', async () => {
    // 2026-11-19 唤醒切片：抛错回合此前不触发失败回调（用户只能等下次开口从 B 通道侧面
    // 知道）——现在按同一条失败出口如实上报（reason = 错误文本，只进事实/日志）。
    let calls = 0;
    const throwing: TaskExecutor = {
      async execute(): Promise<TaskExecutionOutcome> {
        calls += 1;
        throw new Error('worker driver exploded');
      },
    };
    const fx = await makeFixture('line', { executorOverride: throwing });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`「${TASK_NAME}」这次没办成。要我再试一次，还是先放着？`);
      // 原始错误文本不进用户文本（只进事实/日志）。
      expect(text).not.toContain('worker driver exploded');
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_failure_wake');
      expect(wake).toMatchObject({ outcome: 'woken' });
      expect(readTask(fx.dbPath, String(wake!['taskId']))).toMatchObject({ status: 'failed' });
      expect(calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('①e 唤醒已说 → 下一回合 B 通道不再注入同一条失败事实（同一件事不说两遍）', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'failed', reason: FAIL_REASON });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      await fx.server.handler(incoming('m-2', '然后呢'));
      const requests = fx.scripted!.requests();
      const texts = requests[requests.length - 1]!.messages.map(userTextOf);
      // B 通道的形状是 `[任务事实] …`（渲染器产出）；`[任务失败] …` 是唤醒事实（上一回合的
      // 转录历史里本来就该有它——模型已经看过、也已经说过，不算第二遍）。
      expect(texts.some((text) => text.startsWith('[任务事实]'))).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it('①c 唤醒不可用（驱动无唤醒能力）→ 既有失败话术 + 事实留待注入（下次开口补说）', async () => {
    const fx = await makeFixture('no-wake');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'failed', reason: FAIL_REASON });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(failureMessageFor('executor_failed').text);
      expect(wakeEventOf(fx.logs, 'task_failure_wake')).toMatchObject({ outcome: 'unavailable' });
      // 事实不丢：下一次用户开口随 injections 进模型上下文（既有机制）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      expect(fx.recorded[1]!.injections?.some((entry) => entry.startsWith('[任务失败]'))).toBe(true);
    } finally {
      await fx.close();
    }
  });
});

describe('状态变化唤醒（server 级）：用户说停', () => {
  it('② 取消 → 唤醒模型说（投递文本 == 模型那句）；渲染文案不再直发', async () => {
    const fx = await makeFixture('line', { runtimeOverrides: { taskRunWaitMs: 1_500 } });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'cancelled' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`「${TASK_NAME}」已经停了。`);
      expect(text).not.toContain('已按你说的停了');
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_cancel_wake');
      expect(wake).toMatchObject({ outcome: 'woken' });
      expect(readTask(fx.dbPath, String(wake!['taskId']))).toMatchObject({ status: 'cancelled', reason: 'cancelled_by_user' });
      // 唤醒已说 → 下一回合 B 通道不再注入同一条事实（同一件事不说两遍）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      const requests = fx.scripted!.requests();
      expect(requests[requests.length - 1]!.messages.map(userTextOf).some((text) => text.startsWith('[任务事实]'))).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it('②b 走岔路：模型说不出话 → 用户仍拿到「已按你说的停了」兜底那句；任务保持 cancelled、不重复执行', async () => {
    const fx = await makeFixture('silent', { runtimeOverrides: { taskRunWaitMs: 1_500 } });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'cancelled' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain('已按你说的停了');
      expect(text).toContain(TASK_NAME);
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_cancel_wake');
      expect(wake).toMatchObject({ outcome: 'failed' });
      expect(readTask(fx.dbPath, String(wake!['taskId'])).status).toBe('cancelled');
      // 恰一条（不双发、不刷屏）。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });
});

describe('状态变化唤醒（server 级）：久无动静', () => {
  it('③ 任务超阈值无事件 → 唤醒模型说（事实带业务名与分钟数）；任务保持 running（不被误判终态）', async () => {
    const fx = await makeFixture('line', { runtimeOverrides: { longRunningNoticeMs: 1 } });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`「${TASK_NAME}」比预计久了。要我停下来，还是继续等？`);
      expect(text).not.toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
      expect(internalTermIn(text)).toBeUndefined();
      // 事实链：带业务名与分钟数（不报进度、不编原因）。
      const transcript = fx.mainDriver!.transcript?.() ?? [];
      const texts = transcript.map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((block) => String((block as { text?: unknown }).text ?? '')).join('');
        return '';
      });
      const fact = texts.find((entry) => entry.startsWith('[久无动静]'));
      expect(fact).toBeDefined();
      expect(fact).toContain(`「${TASK_NAME}」`);
      expect(fact).toMatch(/已经跑了 \d+ 分钟/);
      expect(fact).not.toMatch(/operation|最近一步/);

      const wake = wakeEventOf(fx.logs, 'task_long_running_wake');
      expect(wake).toMatchObject({ outcome: 'woken' });
      const runnerNotice = wakeEventOf(fx.logs, 'task_long_running_notice');
      expect(runnerNotice).toMatchObject({ result: 'sent' });
      // 任务还在跑（提醒不改任务事实、不判终态）。
      const task = readTask(fx.dbPath, String(wake!['taskId']));
      expect(task.status).toBe('running');
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('③b 走岔路：模型说不出话 → 用户仍拿到宿主兜底句（停下来 / 继续等）；任务保持 running', async () => {
    const fx = await makeFixture('silent', { runtimeOverrides: { longRunningNoticeMs: 1 } });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(LONG_RUNNING_NOTICE_FALLBACK_TEXT);
      const wake = wakeEventOf(fx.logs, 'task_long_running_wake');
      expect(wake).toMatchObject({ outcome: 'failed' });
      expect(readTask(fx.dbPath, String(wake!['taskId'])).status).toBe('running');
      expect(fx.executor.calls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });
});

describe('状态变化唤醒（server 级）：重启对账', () => {
  it('④ 启动时租约已过期 → 唤醒原会话说清（此前没有任何东西告诉他）；任务不重放、执行器零调用', async () => {
    const fx = await makeFixture('line', { seedInterrupted: true });
    try {
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`「${TASK_NAME}」我这边重启过，状态说不清了；你说一声我就重来。`);
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_restart_wake');
      expect(wake).toMatchObject({ outcome: 'woken', taskId: 'task_interrupted' });
      // 事实带业务名（模型才知道说的是哪件事）；冷会话也要真跑到模型（零工具单回合）。
      expect(requestHasUserText(fx.scripted!.requests(), '[重启对账]')).toBe(true);
      expect(requestHasUserText(fx.scripted!.requests(), '[重启对账]')
        && fx.scripted!.requests().some((request) => userTextOf(request.messages[request.messages.length - 1]).startsWith('[重启对账]'))).toBe(true);
      // 不重放：如实落 result_unknown（任务终局 failed），执行器一次都没被叫。
      expect(readTask(fx.dbPath, 'task_interrupted')).toEqual({ status: 'failed', reason: 'result_unknown' });
      expect(fx.executor.calls).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it('④b 走岔路：模型说不出话 → 只记事件、零投递（宿主没有这一条的文案，不猜）', async () => {
    const fx = await makeFixture('silent', { seedInterrupted: true });
    try {
      await vi.waitFor(() => {
        expect(wakeEventOf(fx.logs, 'task_restart_wake')).toMatchObject({ outcome: 'failed' });
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(readTask(fx.dbPath, 'task_interrupted')).toEqual({ status: 'failed', reason: 'result_unknown' });
      expect(fx.executor.calls).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it('④d 取消孤儿（用户说了停、重启前没确认）→ 回收成 result_unknown 并如实说清「你要我停，没停完」', async () => {
    // 2026-11-19 只读审计 #14：cancelling 断电遗留此前没有任何出口（expireLeases 只收
    // running；再取消撞非法边）——用户永远等不到下文。恢复走既有合法边
    // cancelling→running→result_unknown，并唤醒原会话按「你要我停」如实说清 + 给动作。
    const fx = await makeFixture('line', { seedCancelling: true });
    try {
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(`「${TASK_NAME}」我这边重启过，状态说不清了；你说一声我就重来。`);
      const wake = wakeEventOf(fx.logs, 'task_restart_wake');
      expect(wake).toMatchObject({ outcome: 'woken', taskId: 'task_cancelling_orphan' });
      // 事实如实点明「你要我停、没停完」（别让用户以为停已生效）。
      expect(requestHasUserText(fx.scripted!.requests(), '[重启对账]')).toBe(true);
      const fact = fx.scripted!.requests()
        .flatMap((request) => request.messages.map((message) => userTextOf(message)))
        .find((text) => text.startsWith('[重启对账]'));
      expect(fact).toContain('你要我停');
      expect(fact).toContain('没停完');
      // 终态：result_unknown（不宣称已取消、不重放），执行器零调用。
      expect(readTask(fx.dbPath, 'task_cancelling_orphan')).toEqual({ status: 'failed', reason: 'result_unknown' });
      expect(fx.executor.calls).toBe(0);
      // 再取消不再撞非法边（状态机已回到终态；终态即「没有可取消的」）。
      const registry = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        expect(registry.get('task_cancelling_orphan', SCOPE).status).toBe('failed');
      } finally {
        registry.close();
      }
    } finally {
      await fx.close();
    }
  });

  it('④c 非 live 部署不唤醒（零模型调用、零投递），事实留待注入（下次开口由模型补说）', async () => {
    const fx = await makeFixture('line', { seedInterrupted: true, deliveryMode: 'silent' });
    try {
      await vi.waitFor(() => {
        expect(wakeEventOf(fx.logs, 'task_restart_wake')).toMatchObject({ outcome: 'suppressed' });
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      // 事实不丢：下一次用户开口随 injections 进模型上下文（既有机制）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      expect(requestHasUserText(fx.scripted!.requests(), '[重启对账]')).toBe(true);
      expect(readTask(fx.dbPath, 'task_interrupted')).toEqual({ status: 'failed', reason: 'result_unknown' });
    } finally {
      await fx.close();
    }
  });
});
