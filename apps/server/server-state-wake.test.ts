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
import { deriveTaskName, taskLivenessOf } from '../../packages/agent/src/task-registry';
import { lastExecutionOf, taskReportedOf } from '../../packages/agent/testing/task-facts';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import {
  LONG_RUNNING_NOTICE_FALLBACK_TEXT,
  type TaskExecutionContext,
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
const FAIL_REASON = '对方拒绝';
/** ⑤d 用：用户对等待中的任务表态（脚本模型据此调 task_resume 接续）。 */
const RESUME_MESSAGE = '按这版提交';
/** 缺陷 A 用：用户说停（脚本模型据此调 task_cancel——回合内取消）。 */
const STOP_MESSAGE = '停';
/** 缺陷 A① 用：取消回合里模型收尾那句（用户可见文本只有它）。 */
const STOP_TURN_LINE = '好，那件事已经停了，不用再等它。';
/** 缺陷 A③ 用：取消没在窗口内落定时模型照实说的那句（不冒进）。 */
const REQUESTED_LINE = '先发出停止请求了，一有确认我马上告诉你。';

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
  /** 取消请求观察点：cancel() 会 abort 本回合的 controller——用例据此同步「取消已请求」。 */
  aborted = false;
  private resolve?: (outcome: TaskExecutionOutcome) => void;
  async execute(_input: TaskExecutionInput, context: TaskExecutionContext): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    context.signal.addEventListener('abort', () => {
      this.aborted = true;
    });
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

/** 转录尾部是不是 toolResult（工具已回执 → 本次模型请求该出正文了）。 */
function tailIsToolResult(messages: readonly unknown[]): boolean {
  const last = messages[messages.length - 1] as { role?: unknown } | undefined;
  return last?.role === 'toolResult';
}

/** 转录里最近一条 task_run 受理回执的 taskId（task_cancel 的 ref 取它——数字 ref 已退役）。 */
function lastTaskIdOf(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = (messages[index] as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as { text?: unknown }).text ?? '')).join('')
        : '';
    const hit = /"taskId":"(task_[0-9a-f][0-9a-f-]+)"/u.exec(text);
    if (hit !== null) return hit[1]!;
  }
  throw new Error('（测试）转录里没有 task_run 受理回执，无法构造 task_cancel 引用');
}

/** 唤醒回合：模型按**事实**说一句（业务名从事实里取——钉住「事实里带名字」这条链）。 */
function wakeLineFor(factText: string, mode: 'line' | 'silent' | 'tool-only', wakeCalls: number): AgentMessage {
  if (mode === 'silent') return textAssistant('');
  if (mode === 'tool-only') return wakeCalls === 1 ? toolCallAssistant('task_run', { task: TASK_TEXT }) : textAssistant('');
  const name = /「([^」]+)」/.exec(factText)?.[1];
  const subject = name === undefined ? '你交代的那件事' : `「${name}」`;
  if (factText.startsWith('[回合结束]')) {
    // 脚本模型按**原始事实**自己判（产品新模型：成败由 Main 判、话由 Main 说）：
    // 无汇报 / 机械原因 / 结果未知 / 资源拒绝 / 发起前被拒 / 账本零执行 → 说清没办成。
    const failedFact = factText.includes('worker 这一回合没有汇报原文')
      || factText.includes('机械原因')
      || factText.includes('看门狗观察到执行租约过期')
      || factText.includes('本次被资源策略拒绝')
      || factText.includes('发起前被宿主拒绝')
      || factText.includes('账本里没有执行事实');
    if (failedFact) return textAssistant(`${subject}这次没办成。要我再试一次，还是先放着？`);
    const report = /worker 汇报原文（语义，可能说错；做没做成以执行事实为准）：(.+)/u.exec(factText)?.[1]?.trim();
    return textAssistant(report === undefined ? `${subject}这次没办成。要我再试一次，还是先放着？` : `${subject}办好了：${report}`);
  }
  if (factText.startsWith('[已停止]')) return textAssistant(`${subject}已经停了。`);
  if (factText.startsWith('[久无动静]')) return textAssistant(`${subject}比预计久了。要我停下来，还是继续等？`);
  if (factText.startsWith('[重启对账]')) return textAssistant(`${subject}我这边重启过，状态说不清了；你说一声我就重来。`);
  if (factText.startsWith('[任务等待]')) {
    // 待确认：模型按事实把提案原文原样转述给用户（模拟「原样告诉用户并等表态」）。
    const summary = /将写入（逐字）：(.+?)（/u.exec(factText)?.[1];
    if (summary !== undefined) return textAssistant(`待确认内容（原样）：${summary}。请回复确认或说不确认。`);
    // 待补：把缺的条目原样报给用户。
    const missing = /还缺：(.+?)。/u.exec(factText)?.[1] ?? '';
    return textAssistant(`还差一点：${missing}。请补充一下。`);
  }
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
  /** 预置一条「用户说了停、执行端没确认就断电」的取消请求行（取消孤儿；请求持久事实）。 */
  seedCancelRequested?: boolean;
  /**
   * 预置一条 v5 迁移后的取消孤儿：cancel_requested_at 已落、仍在推进、**无租约**
   * （旧 status='cancelling' 迁移形状）——重启扫描必须按「取消请求 + 仍在推进」捞到它，
   * 不能因为没租约/没 round_failed 而永远够不着。
   */
  seedMigratedCancelOrphan?: boolean;
  /** 投递面模式（缺省 live；silent = 非 live 部署的抑制语义）。 */
  deliveryMode?: 'live' | 'silent';
  /** 执行器替身覆盖（缺省 = 受闸的 GatedExecutor；抛错回合用例用）。 */
  executorOverride?: TaskExecutor;
  /**
   * 缺陷 A（回合内取消）：给出后，用户消息「停」会让脚本模型调 task_cancel（ref 取
   * 上一回合受理回执的 taskId），收尾出本字段那句正文（'' = 模型沉默）。
   */
  stopTurn?: { reply: string };
} = {}): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  if (options.seedInterrupted === true) {
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      // 受理为 queued（无 running_since）后补一条**已经过期**的租约：形状 = 上一进程死在回合中
      //（本进程重启后 pump 的 expireLeases 如实把它落 died，不重放）。
      registry.begin({ taskId: 'task_interrupted', ...SCOPE, request: TASK_TEXT, queued: true });
      registry.store.armLease('task_interrupted', {
        owner: 'dead-process',
        leaseUntil: new Date(Date.now() - 1_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    } finally {
      registry.close();
    }
  }
  if (options.seedCancelRequested === true) {
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      // 用户说了停（落**持久**请求事实 cancel_requested_at），执行端没确认就断电：形状 = 取消
      // 孤儿。重启后 pump 的 expireLeases 把它落 died（结果未知），重启对账据请求事实如实说
      // 「你要我停、没停完」（此前请求只在本进程内存里，一重启就丢）。
      registry.begin({ taskId: 'task_cancelling_orphan', ...SCOPE, request: TASK_TEXT, queued: true });
      registry.markCancelRequested('task_cancelling_orphan');
      registry.store.armLease('task_cancelling_orphan', {
        owner: 'dead-process',
        leaseUntil: new Date(Date.now() - 1_000).toISOString(),
        updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
    } finally {
      registry.close();
    }
  }
  if (options.seedMigratedCancelOrphan === true) {
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      // v5 迁移形状：cancel_requested_at 已落、running_since 已回填、无租约、无 round_failed_at。
      // 旧实现把 cancelling 也写 round_failed_at → 过期租约扫描（要租约）与「仍在推进」扫描
      //（要 round_failed 为空）双双够不着，重启后永远收不到「你要我停、没停完」。
      registry.begin({ taskId: 'task_cancel_orphan', ...SCOPE, request: TASK_TEXT, queued: true });
      registry.markCancelRequested('task_cancel_orphan');
      registry.armLease('task_cancel_orphan', { owner: 'dead-process', leaseMs: 60_000 });
      // 清租约，只留 running_since（迁移行没有活租约）。
      registry.releaseTaskLease('task_cancel_orphan');
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
      executor.settle({ kind: 'ended' });
      // 让收尾回合链跑完再关库（否则挂起回合在已关的底账上收尾，吐噪声）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      await fixture.server.close();
    },
  };

  let scripted: ScriptedModelRuntime | undefined;
  let wakeCalls = 0;
  let resumeCalled = false;
  // 缺陷 A②：停止回合模型沉默后，驱动的「催一句」重试也保持沉默（与 silent 模式同形）。
  let stopSilence = false;
  if (mode !== 'no-wake') {
    scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (_index, context) => {
        const last = lastUserTextOf(context.messages);
        if (last.startsWith('[回合结束]') || last.startsWith('[已停止]')
          || last.startsWith('[久无动静]') || last.startsWith('[重启对账]') || last.startsWith('[任务等待]')) {
          wakeCalls += 1;
          return wakeLineFor(last, mode, wakeCalls);
        }
        if (last === ASK) {
          const hasToolResult = context.messages.some((message) => (message as { role?: string }).role === 'toolResult');
          return hasToolResult
            ? textAssistant('好的，这件事我交给后台办，办完发你。')
            : toolCallAssistant('task_run', { task: TASK_TEXT });
        }
        // ⑤d（回 running 再进）：用户对等待中的任务表态 → 模型调 task_resume 接续
        //（同一表态消息只在首个请求调工具，续回合收尾出正文）。
        if (last === RESUME_MESSAGE) {
          if (!resumeCalled) {
            resumeCalled = true;
            return toolCallAssistant('task_resume', { answer: RESUME_MESSAGE });
          }
          return textAssistant('好的，已按你的表态接续。');
        }
        // 缺陷 A（回合内取消）：用户说停 → 模型调 task_cancel；工具回执后收尾出正文
        //（正文由用例给：非空 = 事实已交出；'' = 模型沉默，后续「催一句」也沉默）。
        if (last === STOP_MESSAGE && options.stopTurn !== undefined) {
          if (tailIsToolResult(context.messages)) {
            if (options.stopTurn.reply.trim() === '') stopSilence = true;
            return textAssistant(options.stopTurn.reply);
          }
          return toolCallAssistant('task_cancel', { ref: lastTaskIdOf(context.messages) });
        }
        if (stopSilence) return textAssistant('');
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

/** 读一条任务的账本事实（S1：底账没有 status——liveness 三值 + 末条执行事实 + 一次性时刻）。 */
function readTask(dbPath: string, taskId: string): {
  liveness: string | null;
  lastExecutionStatus: string | undefined;
  reported: boolean;
  cancelled: boolean;
  died: boolean;
  pendingQuestion: boolean;
} {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    const task = registry.get(taskId, SCOPE);
    return {
      liveness: taskLivenessOf(task) ?? null,
      lastExecutionStatus: lastExecutionOf(task)?.status,
      reported: taskReportedOf(task),
      cancelled: task.cancelledAt !== undefined,
      died: task.diedAt !== undefined,
      pendingQuestion: task.pendingQuestion !== undefined,
    };
  } finally {
    registry.close();
  }
}

/** 交办回合留下的那条 running 任务（缺陷 A 用例：本会话恰有一个在跑的后台任务）。 */
function runningTaskIdOf(dbPath: string): string {
  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  try {
    const running = registry.list(SCOPE).find((task) => taskLivenessOf(task) === 'running');
    if (running === undefined) throw new Error('（测试）没有在跑的任务');
    return running.taskId;
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
      // 去 outcome（2026-11-23）：回合只记事实——无汇报 + 机械原因（执行层失败原文）；事实带上原因。
      fx.executor.settle({ kind: 'ended', failureReason: FAIL_REASON });
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
      const fact = texts.find((entry) => entry.startsWith('[回合结束]'));
      expect(fact).toBeDefined();
      expect(fact).toContain(`「${TASK_NAME}」`);
      expect(fact).toContain('worker 这一回合没有汇报原文');
      expect(fact).toContain(FAIL_REASON);
      // 事实里带「给他一个能做的下一步」这条交代（语气与措辞归模型，可执行性不归它）。
      expect(fact).toContain('下一步');

      const wake = wakeEventOf(fx.logs, 'task_failure_wake');
      expect(wake).toMatchObject({ outcome: 'woken', principalId: PRINCIPAL, sessionId: SESSION });
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
      // 任务保持 failed（不被唤醒回合改判）、执行器只被调用一次。
      expect(readTask(fx.dbPath, String(wake!['taskId'])).reported).toBe(false);
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('①b 走岔路：唤醒回合只调工具、不产出正文 → 用户仍拿到既有失败话术；任务不被重跑、执行层零新增调用', async () => {
    const fx = await makeFixture('tool-only');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(failureMessageFor('executor_failed').text);
      expect(internalTermIn(text)).toBeUndefined();
      const wake = wakeEventOf(fx.logs, 'task_failure_wake');
      expect(wake).toMatchObject({ outcome: 'failed' });
      expect(readTask(fx.dbPath, String(wake!['taskId'])).reported).toBe(false);
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
      expect(readTask(fx.dbPath, String(wake!['taskId']))).toMatchObject({ reported: false });
      expect(calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('①f 零执行失败（真实执行行 0 条、无结构化码）：事实带 账本里没有执行事实（办不了），不是 failed', async () => {
    // Grok 复审 2026-11-22：旧判据 ledgerFacts.length===0 永远到不了（零执行也推一条账本行），
    // 零执行被误判 outcome=failed。改看真实执行行数 → unsupported。
    const zeroExec: TaskExecutor = {
      async execute(): Promise<TaskExecutionOutcome> {
        return { kind: 'ended' };
      },
    };
    const fx = await makeFixture('line', { executorOverride: zeroExec });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const transcript = fx.mainDriver!.transcript?.() ?? [];
      const factText = transcript.map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((block) => String((block as { text?: unknown }).text ?? '')).join('');
        return '';
      }).find((entry) => entry.startsWith('[回合结束]'));
      expect(factText).toBeDefined();
      expect(factText).toContain('账本里没有执行事实');
      expect(factText).not.toContain('[outcome=failed]');
    } finally {
      await fx.close();
    }
  });

  it('①e 唤醒已说 → 下一回合 B 通道不再注入同一条失败事实（同一件事不说两遍）', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      await fx.server.handler(incoming('m-2', '然后呢'));
      const requests = fx.scripted!.requests();
      const texts = requests[requests.length - 1]!.messages.map(userTextOf);
      // B 通道的形状是 `[任务事实] …`（渲染器产出）；`[回合结束] …` 是唤醒事实（上一回合的
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
      fx.executor.settle({ kind: 'ended' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(failureMessageFor('executor_failed').text);
      expect(wakeEventOf(fx.logs, 'task_failure_wake')).toMatchObject({ outcome: 'unavailable' });
      // 事实不丢：下一次用户开口随 injections 进模型上下文（既有机制）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      expect(fx.recorded[1]!.injections?.some((entry) => entry.startsWith('[回合结束]'))).toBe(true);
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
      expect(readTask(fx.dbPath, String(wake!['taskId']))).toMatchObject({ cancelled: true });
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
      expect(readTask(fx.dbPath, String(wake!['taskId'])).cancelled).toBe(true);
      // 恰一条（不双发、不刷屏）。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fx.delivery.sentTexts).toHaveLength(1);
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 缺陷 A（2026-11-21 live，P0）：同一件事说两遍。用户说「停」→ 回合内 task_cancel 落定
// cancelled，模型已在回合里说了「已停」→ 0.5s 后「取消」状态变化唤醒又发一条「已停」。
// 机械判据：终态在**本回合等待窗口内**落定（TurnResult.terminalObservedInTurn，只有回合
// 自己观察到的才算）+ 该回合最终回复非空 → 该终态的状态变化唤醒不再发送，记
// `wake_suppressed_already_delivered`（taskId/kind）。三条守卫 + 回合外照常唤醒：
//   A① 回合内取消 + 回复非空 → 恰 0 次唤醒、用户可见文本只有模型那句；
//   A② 回合内取消 + 回复为空 → 唤醒照发（不静默）；
//   A③ 取消请求在回合内、终态在回合外落定（超窗）→ 唤醒照发、不抑制。
// 反向绊线（见提交说明）：去掉 wakeAndDeliverStateChange 的抑制核销 → A① 用户可见文本
// 变 2 条（模型回合那句 + 唤醒投递那句），必红。
// ---------------------------------------------------------------------------
describe('状态变化唤醒（server 级）：回合内终态不重复唤醒（缺陷 A）', () => {
  it('A① 回合内取消（等待窗口观察到落定）+ 回复非空 → 恰 0 次唤醒，用户可见文本只有模型那句', async () => {
    const fx = await makeFixture('line', {
      runtimeOverrides: { taskRunWaitMs: 1_500 },
      stopTurn: { reply: STOP_TURN_LINE },
    });
    try {
      // 上一回合交办 → 后台在跑（执行器挂起）。
      await fx.server.handler(incoming('m-1', ASK));
      const taskId = runningTaskIdOf(fx.dbPath);
      // 本回合取消：执行端确认落在 task_cancel 的等待窗口内（终态在回合内落定）。
      const stopTurn = fx.server.handler(incoming('m-2', STOP_MESSAGE));
      await vi.waitFor(() => expect(fx.executor.aborted).toBe(true), { timeout: 5_000 });
      fx.executor.settle({ kind: 'cancelled' });
      const reply = await stopTurn;
      // 稳定：稍等片刻也不蹦出第二条（同一事实 ≤ 1 次；反向绊线——去掉抑制核销——这里
      // 会变成第二条主动投递，用户可见文本成 2 条，本用例必红）。
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 用户可见文本只有模型那句（回合回复原样）；0 次主动投递、0 次 task_cancel_wake。
      expect(reply).toBe(STOP_TURN_LINE);
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'task_cancel_wake')).toBe(false);
      // 抑制被记账（机械事件带 taskId/kind）；任务落 cancelled（取消是真的）。
      const suppressed = fx.logs.filter((line) => line['event'] === 'wake_suppressed_already_delivered');
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0]).toMatchObject({
        taskId,
        kind: 'cancelled',
        principalId: PRINCIPAL,
        sessionId: SESSION,
      });
      expect(readTask(fx.dbPath, taskId)).toMatchObject({ cancelled: true });
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('A② 回合内取消 + 回复为空 → 唤醒照发（不静默）', async () => {
    const fx = await makeFixture('line', {
      runtimeOverrides: { taskRunWaitMs: 1_500 },
      stopTurn: { reply: '' },
    });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      const taskId = runningTaskIdOf(fx.dbPath);
      const stopTurn = fx.server.handler(incoming('m-2', STOP_MESSAGE));
      await vi.waitFor(() => expect(fx.executor.aborted).toBe(true), { timeout: 5_000 });
      fx.executor.settle({ kind: 'cancelled' });
      // 纯取消回合 + 模型沉默：无正文、无文件、无交办 → 回合按模型侧失败判（既有出口）。
      await expect(stopTurn).rejects.toThrow();
      // 但抑制不发生（回复为空 = 事实没说给用户）：唤醒照发，用户听到「已停」。
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(`「${TASK_NAME}」已经停了。`);
      expect(wakeEventOf(fx.logs, 'task_cancel_wake')).toMatchObject({ outcome: 'woken' });
      expect(fx.logs.some((line) => line['event'] === 'wake_suppressed_already_delivered')).toBe(false);
      expect(readTask(fx.dbPath, taskId).cancelled).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('A③ 取消请求在回合内、终态在回合外落定（超窗）→ 唤醒照发', async () => {
    const fx = await makeFixture('line', {
      runtimeOverrides: { taskRunWaitMs: 300 },
      stopTurn: { reply: REQUESTED_LINE },
    });
    try {
      await fx.server.handler(incoming('m-1', ASK));
      const taskId = runningTaskIdOf(fx.dbPath);
      // 等待窗口（300ms）内不落定：回执如实说「已请求停止」（不冒进），回合照常收尾。
      const reply = await fx.server.handler(incoming('m-2', STOP_MESSAGE));
      expect(reply).toBe(REQUESTED_LINE);
      expect(fx.delivery.sentTexts).toHaveLength(0);
      // 终态在回合外落定 → 唤醒照发（用户终会得到下文），不抑制。
      fx.executor.settle({ kind: 'cancelled' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(`「${TASK_NAME}」已经停了。`);
      expect(wakeEventOf(fx.logs, 'task_cancel_wake')).toMatchObject({ outcome: 'woken' });
      expect(fx.logs.some((line) => line['event'] === 'wake_suppressed_already_delivered')).toBe(false);
      expect(readTask(fx.dbPath, taskId).cancelled).toBe(true);
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
      expect(task.liveness).toBe('running');
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
      expect(readTask(fx.dbPath, String(wake!['taskId'])).liveness).toBe('running');
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
      expect(readTask(fx.dbPath, 'task_interrupted')).toMatchObject({ liveness: 'died' });
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
      expect(readTask(fx.dbPath, 'task_interrupted')).toMatchObject({ liveness: 'died' });
      expect(fx.executor.calls).toBe(0);
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
      expect(readTask(fx.dbPath, 'task_interrupted')).toMatchObject({ liveness: 'died' });
    } finally {
      await fx.close();
    }
  });

  it('④d 取消孤儿（用户说了停、重启前没确认）→ 回收成 result_unknown 并如实说清「你要我停，没停完」', async () => {
    // Grok 复审 2026-11-22：取消请求此前只进进程内 Set，无持久列——断电重启后底账看不出
    // 「你要我停、没停完」。请求落 cancel_requested_at 后，重启对账据此如实点明。
    const fx = await makeFixture('line', { seedCancelRequested: true });
    try {
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(`「${TASK_NAME}」我这边重启过，状态说不清了；你说一声我就重来。`);
      const wake = wakeEventOf(fx.logs, 'task_restart_wake');
      expect(wake).toMatchObject({ outcome: 'woken', taskId: 'task_cancelling_orphan' });
      // 事实如实点明「你要我停、没停完」（别让用户以为停已生效）。
      const fact = fx.scripted!.requests()
        .flatMap((request) => request.messages.map((message) => userTextOf(message)))
        .find((text) => text.startsWith('[重启对账]'));
      expect(fact).toContain('你要我停');
      expect(fact).toContain('没停完');
      // 终态：result_unknown（不宣称已取消、不重放），执行器零调用。
      expect(readTask(fx.dbPath, 'task_cancelling_orphan')).toMatchObject({ liveness: 'died' });
      expect(fx.executor.calls).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it('④e 迁移后的取消孤儿（无租约、cancel_requested 已落）→ 恢复扫描捞到，唤醒说清「你要我停、没停完」', async () => {
    // blocking 2：旧迁移把 cancelling 也写 round_failed_at——取消孤儿既无过期租约（过期扫描
    // 够不着）又因 round_failed 非空不算「仍在推进」（恢复扫描够不着），重启后永远收不到这条。
    // 迁移只落 cancel_requested_at 后，恢复扫描按「取消请求 + 仍在推进」把它并进 recovered。
    const fx = await makeFixture('line', { seedMigratedCancelOrphan: true });
    try {
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(`「${TASK_NAME}」我这边重启过，状态说不清了；你说一声我就重来。`);
      const wake = wakeEventOf(fx.logs, 'task_restart_wake');
      expect(wake).toMatchObject({ outcome: 'woken', taskId: 'task_cancel_orphan' });
      // pendingCancel 读得到：事实如实点明「你要我停、没停完」。
      const fact = fx.scripted!.requests()
        .flatMap((request) => request.messages.map((message) => userTextOf(message)))
        .find((text) => text.startsWith('[重启对账]'));
      expect(fact).toContain('你要我停');
      expect(fact).toContain('没停完');
      // 不重放、不宣称已取消：执行器零调用；任务没有 cancelled/died 事实（取消请求 ≠ 确认）。
      expect(fx.executor.calls).toBe(0);
      const record = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        const task = record.get('task_cancel_orphan', SCOPE);
        expect(task.cancelRequestedAt).toBeDefined();
        expect(task.cancelledAt).toBeUndefined();
        expect(task.diedAt).toBeUndefined();
      } finally {
        record.close();
      }
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 等待用户出口（2026-11-21 live P0）：任务由非等待态进入 waiting_user → **唤醒原会话的
// 模型把待确认/待补说给用户**。live 实测缺陷：进入等待只落在底账，模型不知道、用户只能
// 自己猜着发「按这版提交」才拿到确认摘要。本组钉住：
//   ⑤ 进入等待（needs_confirmation）→ 恰一次唤醒；事实 = missing 列表 + confirmation.summary
//      原文 + expiresAt，句柄（handle）永不进事实；投递文本 == 模型那句；任务保持 waiting_user；
//   ⑤b 走岔路：模型说不出话 → 投兜底 = summary 原文 + expiresAt（执行端原话，不编新话术），
//      事实留待注入（下次开口补说）；
//   ⑤c 同一等待不重复唤醒（之后的状态查询不再触发）；
//   ⑤d 回到 running 再进等待 → 第二次唤醒（按进入等待次数各唤醒一次）；
//   ⑤e 待补（needs_input，无提案）→ 事实 = missing 列表、无 summary；模型照说；
//   ⑤f 走岔路：待补且模型说不出话 → 无兜底（宿主没有这一条的文案，不猜）、零投递，事实留待注入。
// 去重语义 = 每次 waitForUser 提交恰好一次（runner 只在非等待态落等待时触发端口；状态机
// 禁止 waiting→waiting）。反向绊线：去掉唤醒接线 → ⑤/⑤c 必红（见提交说明）。
// ---------------------------------------------------------------------------
describe('状态变化唤醒（server 级）：等待用户', () => {
  const CONF_SUMMARY = '将向「应收账款」表追加 3 行汇总记录';
  const CONF_EXPIRES = '2026-11-21T16:00:00.000Z';
  const CONF_HANDLE = 'handle-internal-0001';

  function confirmationOutcome(summary: string, expiresAt: string, handle: string): TaskExecutionOutcome {
    return {
      kind: 'needs_confirmation',
      question: { missing: ['用户确认'] },
      confirmation: { handle, summary, expiresAt, operation: 'dummy.append_rows' },
    };
  }

  /** 转录里以 prefix 开头的**最后一条**事实文本（唤醒事实经 custom message 投影成 user）。 */
  function factTextOf(fx: Fixture, prefix: string): string {
    const transcript = fx.mainDriver!.transcript?.() ?? [];
    const matches = transcript.map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((block) => String((block as { text?: unknown }).text ?? '')).join('');
      return '';
    }).filter((text) => text.startsWith(prefix));
    return matches[matches.length - 1] ?? '';
  }

  it('⑤ 进入等待（needs_confirmation）→ 恰一次唤醒；事实含 missing+summary 原文+expiresAt、不含句柄；投递==模型那句', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle(confirmationOutcome(CONF_SUMMARY, CONF_EXPIRES, CONF_HANDLE));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      // 用户拿到的是模型说的话（原样转述提案原文），不是宿主文案；句柄不进用户文本。
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(`待确认内容（原样）：${CONF_SUMMARY}。请回复确认或说不确认。`);
      expect(text).not.toContain(CONF_HANDLE);

      // 事实链：missing 列表 + summary 原文 + expiresAt；句柄永不进事实（宿主持有）。
      const fact = factTextOf(fx, '[任务等待]');
      expect(fact).toContain('用户确认');
      expect(fact).toContain(CONF_SUMMARY);
      expect(fact).toContain(CONF_EXPIRES);
      expect(fact).not.toContain(CONF_HANDLE);
      expect(fact).toContain('请把待确认/待补内容原样告诉用户并等表态');

      // 恰一次唤醒 + 一次投递记账；任务保持 waiting_user（不被唤醒回合改判）。
      const wakes = fx.logs.filter((line) => line['event'] === 'task_waiting_user_wake');
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ outcome: 'woken', principalId: PRINCIPAL, sessionId: SESSION });
      expect(fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent')).toHaveLength(1);
      expect(readTask(fx.dbPath, String(wakes[0]!['taskId'])).liveness).toBe('waiting_user');
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('⑤b 走岔路：模型说不出话 → 投兜底（summary 原文+expiresAt，不编新话术）；事实留待注入', async () => {
    const fx = await makeFixture('silent');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle(confirmationOutcome(CONF_SUMMARY, CONF_EXPIRES, CONF_HANDLE));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      // 兜底 = 执行端原话（summary）+ 有效期，逐字；不含句柄、不含编出来的新话术。
      expect(fx.delivery.sentTexts[0]!.text).toBe(`${CONF_SUMMARY}（${CONF_EXPIRES} 前有效）`);
      expect(fx.delivery.sentTexts[0]!.text).not.toContain(CONF_HANDLE);
      const wake = wakeEventOf(fx.logs, 'task_waiting_user_wake');
      // 驱动口径：唤醒回合无正文 = failed（与重启对账 ④b 同一判定）——兜底由此投出。
      expect(wake).toMatchObject({ outcome: 'failed' });
      expect(readTask(fx.dbPath, String(wake!['taskId'])).liveness).toBe('waiting_user');

      // 事实不丢：下一次用户开口随 injections 进模型上下文（既有机制）。silent 模式连
      // 用户的下一回合也不出正文（回合按「模型侧失败」判）——注入先于回合判定，照常断言。
      await fx.server.handler(incoming('m-2', '然后呢')).catch(() => undefined);
      expect(requestHasUserText(fx.scripted!.requests(), '[任务等待]')).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('⑤c 同一等待不重复唤醒（状态查询不再触发第二次）', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle(confirmationOutcome(CONF_SUMMARY, CONF_EXPIRES, CONF_HANDLE));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      // 等待期间用户再开口查状态：不产生第二次唤醒、第二次投递。
      await fx.server.handler(incoming('m-2', '然后呢'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fx.logs.filter((line) => line['event'] === 'task_waiting_user_wake')).toHaveLength(1);
      expect(fx.delivery.sentTexts).toHaveLength(1);
      expect(fx.executor.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it('⑤d 回到 running 再进等待 → 第二次唤醒（按进入等待次数各一次）', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle(confirmationOutcome(CONF_SUMMARY, CONF_EXPIRES, CONF_HANDLE));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      // 用户表态 → 模型 task_resume → 任务回 running → 执行端再次提案（新摘要/新有效期）→
      // 再次落等待 → 第二次唤醒。
      await fx.server.handler(incoming('m-2', RESUME_MESSAGE));
      await vi.waitFor(() => expect(fx.executor.calls).toBe(2), { timeout: 10_000 });
      const summary2 = '将向「应付账款」表追加 5 行记录';
      const expires2 = '2026-11-21T17:00:00.000Z';
      fx.executor.settle(confirmationOutcome(summary2, expires2, 'handle-internal-0002'));
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(2), { timeout: 10_000 });

      const wakes = fx.logs.filter((line) => line['event'] === 'task_waiting_user_wake');
      expect(wakes).toHaveLength(2);
      const text2 = fx.delivery.sentTexts[1]!.text;
      expect(text2).toBe(`待确认内容（原样）：${summary2}。请回复确认或说不确认。`);
      const fact2 = factTextOf(fx, '[任务等待]');
      expect(fact2).toContain(summary2);
      expect(fact2).toContain(expires2);
      expect(readTask(fx.dbPath, String(wakes[1]!['taskId'])).liveness).toBe('waiting_user');
    } finally {
      await fx.close();
    }
  });

  it('⑤e 待补（needs_input，无提案）→ 事实 = missing 列表（无 summary）；模型照说', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'needs_input', question: { missing: ['账套名', '月份'] } });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const fact = factTextOf(fx, '[任务等待]');
      expect(fact).toContain('账套名');
      expect(fact).toContain('月份');
      expect(fact).not.toContain('将写入（逐字）');
      expect(fx.delivery.sentTexts[0]!.text).toBe('还差一点：账套名、月份。请补充一下。');
      const wakes = fx.logs.filter((line) => line['event'] === 'task_waiting_user_wake');
      expect(wakes).toHaveLength(1);
      expect(readTask(fx.dbPath, String(wakes[0]!['taskId'])).liveness).toBe('waiting_user');
    } finally {
      await fx.close();
    }
  });

  it('⑤f 走岔路：待补且模型说不出话 → 无兜底（宿主没有这一条的文案，不猜）、零投递；事实留待注入', async () => {
    const fx = await makeFixture('silent');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'needs_input', question: { missing: ['账套名'] } });
      await vi.waitFor(() => {
        // 驱动口径：唤醒回合无正文 = failed（与重启对账 ④b 同一判定）。
        expect(wakeEventOf(fx.logs, 'task_waiting_user_wake')).toMatchObject({ outcome: 'failed' });
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      // 无提案 → 无 summary → 无兜底文案：零投递（不编新话术），事实留待注入。
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      await fx.server.handler(incoming('m-2', '然后呢')).catch(() => undefined);
      expect(requestHasUserText(fx.scripted!.requests(), '[任务等待]')).toBe(true);
      expect(readTask(fx.dbPath, String(wakeEventOf(fx.logs, 'task_waiting_user_wake')!['taskId'])).liveness).toBe('waiting_user');
    } finally {
      await fx.close();
    }
  });
});
