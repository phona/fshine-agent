/**
 * 后台任务完成 = **唤醒会话里的模型 → 宿主投递它说的话**（server 装配级，2026-11-19 唤醒切片）。
 *
 * 钉住的用户级行为（假渠道事实 + 真实 Pi 会话 + 脚本化模型；零网络、零真实平台）：
 *   ① 完成 → 投递文本 == 脚本模型唤醒回合产出的那句（宿主不再拼「「业务名」办完了：」模板）；
 *      转录里那句话在（宿主说的与模型上下文里的是同一句）；
 *   ② 模型把事实里的结果正文逐字说给用户 → 投递文本含原文（不截断、不改写）；
 *   ③ 唤醒失败（空回复）→ 用户收到宿主兜底那一句（host_fault 模板，不新写文案）+ 结构化事件；
 *   ③b 会话拿不到（驱动无唤醒能力）→ 同兜底，且事实留在「待注入」：下次用户开口随 injections
 *      进模型上下文（既有机制，不新建队列）；
 *   ④ 走岔路：唤醒回合只调工具、不产出正文 → 用户仍拿兜底那一句；任务不被误判终态、执行层零
 *      新增调用、用户可见面无内部词。
 *
 * 记账字段（不许少）：task_result_delivery_sent 带 taskId/principalId/sessionId/deliveryMode。
 * 本文件不覆盖「会话忙」——server 的完成回调经会话链串行（链上空闲才唤醒），忙态在驱动侧
 * pi-driver-wake.test.ts 钉住。
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
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { internalTermIn, failureMessageFor } from '../../packages/agent/src/user-facing-failure';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { mainSessionOptions } from '../../scripts/ask-runtime';
import { createServer, type FileDeliveryPort, type Server } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
const ASK = '帮我汇总';
const TASK_TEXT = '帮我把结果汇总成一份文件';
/** 脚本模型在唤醒回合产出的那句（用户看到的话由模型写）。 */
const WOKE_LINE = '你交办的那件事办好了：汇总完成，共 3 条。';
const LONG_RESULT = '华远贸易 21000 元、明达物流 18000 元，合计 39000 元（共 12 行）。';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-completion-wake-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true } },
    contextProfiles: { dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] } },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 0 窗口 = 受理即返回，完成投递走后台完成回调（有推送面 → async 派发）。
    runtime: { taskRunWaitMs: 0 },
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

/** 受闸后台执行器：完成时机由用例控制（settle）。 */
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

/** 从完成事实里取逐字结果正文（模型侧同一个解析：说给用户的必须是原文）。 */
function resultBodyOf(fact: string): string {
  const marker = '结果正文（逐字）：';
  const start = fact.indexOf(marker);
  if (start === -1) throw new Error(`完成事实缺少结果正文段：${fact.slice(0, 120)}`);
  const rest = fact.slice(start + marker.length);
  const end = rest.lastIndexOf('。请把这件事告诉用户。');
  if (end === -1) throw new Error(`完成事实缺少收尾段：${fact.slice(-60)}`);
  return rest.slice(0, end);
}

type WakeMode = 'line' | 'echo' | 'empty' | 'tool-only' | 'no-wake';

interface Fixture {
  server: Server;
  dbPath: string;
  delivery: { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort };
  logs: Array<Record<string, unknown>>;
  executor: GatedExecutor;
  face: CountingClient;
  /** 真实 Pi 驱动（no-wake 夹具为 undefined）。 */
  mainDriver?: TurnDriver;
  /** no-wake 夹具：假驱动的回合输入记录（injections 观察用）。 */
  recorded: TurnDriverInput[];
  close(): Promise<void>;
}

async function makeFixture(mode: WakeMode): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const delivery = fakeDelivery();
  const logs: Array<Record<string, unknown>> = [];
  const executor = new GatedExecutor();
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
        if (last.startsWith('[任务完成]')) {
          wakeCalls += 1;
          if (mode === 'echo') return textAssistant(resultBodyOf(last));
          if (mode === 'empty') return textAssistant('');
          if (mode === 'tool-only') {
            // 走岔路：唤醒回合只调工具（拿不到执行面），工具错误回执后空收尾，不产出正文。
            return wakeCalls === 1 ? toolCallAssistant('task_run', { task: TASK_TEXT }) : textAssistant('');
          }
          return textAssistant(WOKE_LINE);
        }
        if (last === ASK) {
          const hasToolResult = context.messages.some(
            (message) => (message as { role?: string }).role === 'toolResult',
          );
          return hasToolResult
            ? textAssistant('好的，这件事我交给后台办，办完发你。')
            : toolCallAssistant('task_run', { task: TASK_TEXT });
        }
        return textAssistant('好的。');
      },
    });
  }

  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
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
    taskExecutor: executor,
    fileDelivery: delivery.port,
    logger: (line) => logs.push(line),
  });
  fixture.server = server;
  return fixture;
}

describe('完成唤醒（server 级）：宿主喂事实、模型说话、宿主投递它的话', () => {
  it('① 主路径：投递文本 == 脚本模型唤醒回合那句（不是宿主模板）；转录里有那句', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'completed', resultText: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      // 用户看到的就是模型写的那句（逐字节相等），不是宿主拼的完成文案。
      expect(text).toBe(WOKE_LINE);
      expect(text).not.toMatch(/「[^」]*」办完了：/);
      expect(fx.delivery.sentTexts[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });

      // 一致性：那句话在会话转录里（模型上下文与用户可见面同源，没有两套历史）。
      const transcript = fx.mainDriver!.transcript?.() ?? [];
      const transcriptTexts = transcript.map((message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content.map((block) => String((block as { text?: unknown }).text ?? '')).join('');
        }
        return '';
      });
      expect(transcriptTexts).toContain(WOKE_LINE);
      // 喂进去的是事实（不是话术），且事实不含内部标识：结果正文逐字在内。
      expect(transcriptTexts.some((entry) => entry.startsWith('[任务完成]') && entry.includes('汇总完成，共 3 条。'))).toBe(true);

      // 记账字段一个不少；live 送达才记 sent；无抑制。
      const sent = fx.logs.filter((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        principalId: 'wecom:user-a',
        sessionId: 'wecom:conv-a',
        taskId: expect.any(String),
        deliveryMode: 'live',
      });
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_suppressed')).toBe(false);
      const wake = fx.logs.find((line) => line['event'] === 'task_completion_wake');
      expect(wake).toMatchObject({ outcome: 'woken', taskId: sent[0]!['taskId'] });
    } finally {
      await fx.close();
    }
  });

  it('② 模型把结果正文逐字说给用户 → 投递文本含原文（不截断、不改写）', async () => {
    const fx = await makeFixture('echo');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'completed', resultText: LONG_RESULT });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(LONG_RESULT);
      expect(text).toContain('华远贸易 21000 元');
      expect(text).toContain('合计 39000 元');
      expect(text).toContain('（共 12 行）');
    } finally {
      await fx.close();
    }
  });

  it('③ 唤醒失败（空回复）→ 用户收到宿主兜底那一句，事件有记录', async () => {
    const fx = await makeFixture('empty');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'completed', resultText: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(failureMessageFor('host_fault').text);
      expect(internalTermIn(fx.delivery.sentTexts[0]!.text)).toBeUndefined();
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'failed' });
      // 兜底也是如实投递（live sent），不是 suppressed。
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('③b 会话拿不到（驱动无唤醒能力）→ 兜底 + 事实留待注入（下次用户开口随 injections 补说）', async () => {
    const fx = await makeFixture('no-wake');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'completed', resultText: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.delivery.sentTexts[0]!.text).toBe(failureMessageFor('host_fault').text);
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'unavailable' });
      // 事实留在「待注入」（既有 injections 机制）：下一次用户开口时进模型上下文。
      await fx.server.handler(incoming('m-2', '然后呢'));
      const second = fx.recorded[1]!;
      expect(second.injections?.some((text) => text.startsWith('[任务完成]') && text.includes('汇总完成，共 3 条。'))).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('④ 走岔路：唤醒回合只调工具不产出正文 → 兜底；任务不被误判、执行层零新增调用、无内部词', async () => {
    const fx = await makeFixture('tool-only');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'completed', resultText: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toBe(failureMessageFor('host_fault').text);
      // 用户可见面无内部词（工具名/执行层/错误形状都不进用户文本）。
      expect(internalTermIn(text)).toBeUndefined();
      expect(text).not.toContain('task_run');
      expect(text).not.toContain('执行层');
      expect(text).not.toContain('工具');

      const wake = fx.logs.find((line) => line['event'] === 'task_completion_wake');
      expect(wake).toMatchObject({ outcome: 'failed' });
      // 任务不被误判终态、不被重跑：completed 保持，执行器只被调用一次。
      const taskId = String(wake!['taskId']);
      expect(fx.executor.calls).toBe(1);
      // 执行层零新增调用：唤醒回合的工具调用在发起前被拒（碰不到执行面）。
      expect(fx.face.calls).toBe(0);
      const ro = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        expect(ro.get(taskId, SCOPE).status).toBe('completed');
      } finally {
        ro.close();
      }
    } finally {
      await fx.close();
    }
  });
});
