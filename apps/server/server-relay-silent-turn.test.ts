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
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig, ChannelRoute, DeliveryReceipt, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { createPiTurnDriver } from '../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../packages/agent/testing/scripted-model-runtime';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { internalTermIn } from '../../packages/agent/src/user-facing-failure';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { mainSessionOptions } from '../../scripts/ask-runtime';
import { createServer, type FileDeliveryPort, type Server } from './server';
import { taskCompletionFallbackText } from './task-completion-delivery';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
const ASK = '帮我汇总';
const TASK_TEXT = '帮我把结果汇总成一份文件';
const RESULT_TEXT = '汇总完成，共 3 条。';
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

function testConfig(taskRunWaitMs: number): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true } },
    contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 短等待窗口：窗口内落定 = 快活（relayed）；窗口外 = 受理（accepted）。
    runtime: { taskRunWaitMs },
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

/** 立即完成的执行器：任务在等待窗口内落定（快活路线）。 */
class ImmediateExecutor implements TaskExecutor {
  calls = 0;
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return { kind: 'completed', resultText: RESULT_TEXT };
  }
}

/** 逐次给结果的执行器（同回合多任务用例：分辨「哪个任务」的结果）。 */
class SequencedExecutor implements TaskExecutor {
  calls = 0;
  constructor(private readonly results: readonly string[]) {}
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    return { kind: 'completed', resultText: this.results[this.calls - 1] ?? `第 ${this.calls} 条结果。` };
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
      if (last.startsWith('[任务完成]')) {
        input.onWake?.();
        return textAssistant(input.wakeLine ?? WAKE_LINE);
      }
      const issued = countTaskRuns(context.messages as readonly { role?: string; content?: unknown }[]);
      if (issued < delegations) {
        return toolCallAssistant('task_run', { task: TASK_TEXT }, issued === 0 ? '' : `-${issued}`);
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
  face: CountingClient;
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
}): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const delivery = fakeDelivery();
  const logs: Array<Record<string, unknown>> = [];
  const executor = input.executor ?? new ImmediateExecutor();
  const face = new CountingClient();
  let wakeCalls = 0;
  const scripted = createScripted({
    ...(input.afterToolText === undefined ? {} : { afterToolText: input.afterToolText }),
    ...(input.wakeLine === undefined ? {} : { wakeLine: input.wakeLine }),
    ...(input.emptyOnly === undefined ? {} : { emptyOnly: input.emptyOnly }),
    ...(input.delegations === undefined ? {} : { delegations: input.delegations }),
    onWake: () => { wakeCalls += 1; },
  });
  const runtime = await scripted;
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(input.waitMs),
    dbPath,
    createDrivers: (env, mainSession) => {
      const workerDriver: TurnDriver = { async run(): Promise<never> { throw new Error('（测试）Worker 由 executor 替身接管'); } };
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
    taskExecutor: executor,
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
    wakeCalls: () => wakeCalls,
    close: async () => {
      if (executor instanceof GatedExecutor) executor.settle({ kind: 'failed', reason: '（测试清理）' });
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
        expect(ro.get(taskId, SCOPE).status).toBe('completed');
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
      executor.settle({ kind: 'completed', resultText: RESULT_TEXT });
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
