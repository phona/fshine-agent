/**
 * 后台任务完成 = **唤醒会话里的模型 → 宿主投递它说的话**（server 装配级，2026-11-19 唤醒切片）。
 *
 * 钉住的用户级行为（假渠道事实 + 真实 Pi 会话 + 脚本化模型；零网络、零真实平台）：
 *   ① 完成 → 投递文本 == 脚本模型唤醒回合产出的那句（宿主不再拼「「业务名」办完了：」模板）；
 *      转录里那句话在（宿主说的与模型上下文里的是同一句）；
 *   ② 模型把事实里的结果正文逐字说给用户 → 投递文本含原文（不截断、不改写）；
 *   ③ 唤醒失败（空回复）→ 用户收到宿主**如实报完成事实**那句（业务名 + 结果正文；
 *      2026-11-19 复核 F2：任务已成功，不得说「没弄好/再试一次」）+ 结构化事件；
 *   ③b 会话拿不到（驱动无唤醒能力）→ 同如实兜底，且事实留在「待注入」：下次用户开口随
 *      injections 进模型上下文（既有机制，不新建队列）；
 *   ④ 走岔路：唤醒回合只调工具、不产出正文 → 用户仍拿如实兜底那句；任务不被误判终态、
 *      执行层零新增调用、用户可见面无内部词；
 *   ⑤ 复核 F4：完成消息要让用户看出是哪件事——事实带业务名、模型复读 → 用户可见文本有名字；
 *   ⑥ 复核 F5：silent 部署不唤醒（零模型调用增量），只记事实（suppressed 记账照旧）。
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
import { internalTermIn } from '../../packages/agent/src/user-facing-failure';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { mainSessionOptions } from '../../scripts/ask-runtime';
import { createServer, type FileDeliveryPort, type Server } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };
const ASK = '帮我汇总';
const TASK_TEXT = '帮我把结果汇总成一份文件';
/** 任务业务名（底账 name 缺省 = deriveTaskName(request) 机械回落；短原文即原文）。 */
const TASK_NAME = TASK_TEXT;
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

function fakeDelivery(
  deliveryMode: 'live' | 'silent' = 'live',
  textBehavior: 'ok' | 'throw' = 'ok',
): { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort } {
  const sentTexts: Array<{ route: ChannelRoute; text: string }> = [];
  return {
    sentTexts,
    port: {
      deliveryMode,
      async sendToConversation(route: ChannelRoute): Promise<DeliveryReceipt> {
        return { route, parts: [] };
      },
      async sendText(route: ChannelRoute, text: string): Promise<DeliveryReceipt> {
        if (textBehavior === 'throw') throw new Error('渠道瞬时故障');
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

/**
 * 请求消息里完成事实出现的次数（**不等于**注入次数：唤醒回合那次已进会话历史，
 * 每次重放历史都会再出现一遍）。断言时按「历史 1 份 + 本轮注入」计数。
 */
function factMessageCount(messages: readonly unknown[]): number {
  let count = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (content === undefined) continue;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String((part as { text?: unknown }).text ?? '')).join('')
        : '';
    if (text.includes('[任务完成]')) count += 1;
  }
  return count;
}

type WakeMode = 'line' | 'echo' | 'named' | 'empty' | 'tool-only' | 'no-wake' | 'silent' | 'send-fail';

interface Fixture {
  server: Server;
  dbPath: string;
  delivery: { sentTexts: Array<{ route: ChannelRoute; text: string }>; port: FileDeliveryPort };
  logs: Array<Record<string, unknown>>;
  executor: GatedExecutor;
  face: CountingClient;
  /** 真实 Pi 驱动（no-wake 夹具为 undefined）。 */
  mainDriver?: TurnDriver;
  /** 脚本模型运行时（观察模型调用次数/请求；no-wake 夹具为 undefined）。 */
  scripted?: ScriptedModelRuntime;
  /** no-wake 夹具：假驱动的回合输入记录（injections 观察用）。 */
  recorded: TurnDriverInput[];
  close(): Promise<void>;
}

async function makeFixture(mode: WakeMode): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const delivery = fakeDelivery(mode === 'silent' ? 'silent' : 'live', mode === 'send-fail' ? 'throw' : 'ok');
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
      executor.settle({ kind: 'ended' });
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
          if (mode === 'named') {
            // 脚本模型从**事实**里取业务名，再复读给用户（钉住「事实里带名字」这条链）。
            const name = /「([^」]+)」/.exec(last)?.[1] ?? '';
            return textAssistant(`「${name}」办好了：${resultBodyOf(last)}`);
          }
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
    fixture.scripted = scripted;
  }

  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath,
    createDrivers: (env, mainSession) => {
      const workerDriver: TurnDriver = { async run(): Promise<never> { throw new Error('（测试）Worker 由 executor 替身接管'); } };
      if (mode === 'no-wake') {
        // 假驱动：能跑回合、但没有唤醒能力（旧会话对象/测试替身形状）——wake 走 unavailable。
        // 「空回复」/「驱动失败」两个输入让用例能钉住「本回合没有用户可见输出」的两种形状。
        let firstTurn = true;
        const driver: TurnDriver = {
          async run(input) {
            recorded.push(input);
            const lastUser = lastUserTextOf(input.messages);
            if (lastUser === '空回复') return { text: '', messages: [...input.messages] };
            if (lastUser === '驱动失败') throw new Error('（测试）驱动失败');
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
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
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
      fx.executor.settle({ kind: 'ended', report: LONG_RESULT });
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

  it('③ 唤醒失败（空回复）→ 用户收到宿主**如实报完成事实**那句（业务名 + 结果正文；不说「再试一次」），事件有记录', async () => {
    const fx = await makeFixture('empty');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      // 2026-11-19 复核 F2：任务**已经完成**——兜底不得说「我这边没弄好 / 再试一次」
      //（对写操作会诱导用户重复执行一次写）；如实报事实：业务名 + 结果正文。
      expect(text).toContain(`「${TASK_NAME}」`);
      expect(text).toContain('汇总完成，共 3 条。');
      expect(text).not.toContain('再试一次');
      expect(text).not.toContain('没弄好');
      expect(internalTermIn(text)).toBeUndefined();
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'failed' });
      // 兜底也是如实投递（live sent），不是 suppressed。
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('③b 会话拿不到（驱动无唤醒能力）→ 如实报完成事实 + 事实留待注入（下次用户开口随 injections 补说）', async () => {
    const fx = await makeFixture('no-wake');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain(TASK_NAME);
      expect(text).toContain('汇总完成，共 3 条。');
      expect(text).not.toContain('再试一次');
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'unavailable' });
      // 事实留在「待注入」（既有 injections 机制）：下一次用户开口时进模型上下文。
      await fx.server.handler(incoming('m-2', '然后呢'));
      const second = fx.recorded[1]!;
      expect(second.injections?.some((text) => text.startsWith('[任务完成]') && text.includes('汇总完成，共 3 条。'))).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('④ 走岔路：唤醒回合只调工具不产出正文 → 如实报完成事实；任务不被误判、执行层零新增调用、无内部词', async () => {
    const fx = await makeFixture('tool-only');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      const text = fx.delivery.sentTexts[0]!.text;
      expect(text).toContain(TASK_NAME);
      expect(text).toContain('汇总完成，共 3 条。');
      expect(text).not.toContain('再试一次');
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
      // 执行层零新增调用：唤醒回合没有工具声明（工具调用匹配不到工具，碰不到执行面）。
      expect(fx.face.calls).toBe(0);
      const ro = createSqliteTaskRegistry(fx.dbPath, { readOnly: true });
      try {
        // S1 事实模型：底账没有 status——汇报已存档即「办完」的账本事实（发给用户的完成消息）。
        expect(ro.get(taskId, SCOPE).replyText).toBe('汇总完成，共 3 条。');
      } finally {
        ro.close();
      }
    } finally {
      await fx.close();
    }
  });

  it('⑤ 完成消息要让用户看出是哪件事：脚本模型从**事实**里取业务名复读 → 用户可见文本里出现该业务名', async () => {
    // 2026-11-19 复核 F4：宿主身份行已删，投递文本 = 模型那句话——**没有任何测试断言用户能
    // 看出是哪件事**。本用例钉住那条链：① 喂进模型的事实里带业务名（缺了模型无从复读）；
    // ② 模型说出业务名 → 用户可见文本里出现它。
    const fx = await makeFixture('named');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      const text = fx.delivery.sentTexts[0]!.text;
      expect(text, '用户可见文本必须能看出是哪件事').toContain(TASK_NAME);
      expect(text).toContain('汇总完成，共 3 条。');
      // ① 的机械事实：唤醒回合（最后一条 user = 完成事实）里带着业务名——模型才能复读它。
      const wakeRequest = fx.scripted!.requests().at(-1)!;
      const fact = lastUserTextOf(wakeRequest.messages);
      expect(fact.startsWith('[任务完成]')).toBe(true);
      expect(fact).toContain(`「${TASK_NAME}」`);
    } finally {
      await fx.close();
    }
  });

  it('⑥ silent 部署不唤醒（不白花模型调用）：只记事实（suppressed 记账照旧、零投递、零 sent）', async () => {
    const fx = await makeFixture('silent');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      const callsAfterAsk = fx.scripted!.calls();
      expect(callsAfterAsk).toBeGreaterThan(0);
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      // 既有抑制记账照旧（deliveryMode: silent），只是唤醒不再发生。
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_suppressed' && line['deliveryMode'] === 'silent')).toBe(true);
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // 零模型调用增量：silent 下唤醒（一次真实模型请求）不再发起。
      expect(fx.scripted!.calls(), 'silent 部署不得为完成播报调用模型').toBe(callsAfterAsk);
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'suppressed' });
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      // 事实不丢：只记事实——下一次用户回合随 injections 补说（既有机制；注入在 prompt 之前）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      const second = fx.scripted!.requests().at(-1)!;
      const anyUserText = second.messages.some((message) => {
        const record = message as { role?: string; content?: unknown };
        if (record.role !== 'user') return false;
        if (typeof record.content === 'string') return record.content.includes('[任务完成]');
        if (Array.isArray(record.content)) {
          return record.content.some((part) => String((part as { text?: unknown }).text ?? '').includes('[任务完成]'));
        }
        return false;
      });
      expect(anyUserText, '事实不丢：下一次用户回合随 injections 补说').toBe(true);
    } finally {
      await fx.close();
    }
  });

  it('⑦ 唤醒成功但投递失败（渠道瞬时故障）→ 不假记 sent；事实退回待注入，下次开口补说', async () => {
    // 2026-11-19（投递真相切片）：唤醒产出了一句话、投递这一下失败——旧实现只记事件，
    // 那句话就此消失（任务已确认完成，用户却永远收不到）。后路 = 事实退回既有待注入队列，
    // 下一次用户开口由模型补说（同一条出口，不新建重试、不重投同一句话）。
    const fx = await makeFixture('send-fail');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => {
        expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_failed')).toBe(true);
      }, { timeout: 10_000 });

      // 投递没落地：绝不记 sent、用户可见面为空（不假报），失败可查；退回事实已留痕。
      expect(fx.delivery.sentTexts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_requeued')).toBe(true);
      expect(fx.logs.find((line) => line['event'] === 'task_completion_wake')).toMatchObject({ outcome: 'woken' });

      // 后路真的生效：下一次用户开口，完成事实随 injections 进模型上下文（既有机制补说）。
      await fx.server.handler(incoming('m-2', '然后呢'));
      const second = fx.scripted!.requests().at(-1)!;
      // 计数口径：唤醒回合那份已在会话历史里（1 份）；本轮**再注入**一份 = 2。只有 1 = 没补说。
      expect(factMessageCount(second.messages), '投递失败的事实必须能重来：下次开口由模型补说').toBe(2);
    } finally {
      await fx.close();
    }
  });

  it('⑧ 不许修过头：唤醒送达成功时不退回（下一次开口不重复注入同一件完成事实）', async () => {
    const fx = await makeFixture('line');
    try {
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });
      expect(fx.logs.some((line) => line['event'] === 'task_result_delivery_requeued')).toBe(false);

      await fx.server.handler(incoming('m-2', '然后呢'));
      const second = fx.scripted!.requests().at(-1)!;
      // 已送达（模型已说给用户）→ 不退回：历史里那 1 份之外**没有**第二份注入。
      expect(factMessageCount(second.messages), '已说过的完成事实不再注入第二遍').toBe(1);
    } finally {
      await fx.close();
    }
  });
});

describe('注入核销（机械判据）：本回合没有用户可见输出 → 事实不核销', () => {
  it('⑨ 待注入事实遇上空回复/驱动失败 → 事实留待注入，下一次开口再补说（取走 ≠ 已说）', async () => {
    // 2026-11-19（投递真相切片）：旧实现「take 即视为已说」——注入器出队的那条事实，只要
    // 本回合驱动失败/空回复就永久消失（用户永远看不到）。修法 = 核销判据改成机械事实：
    // 本回合产出的用户可见文本非空才核销；否则把事实退回队列，下一次开口再注入一次。
    const fx = await makeFixture('no-wake');
    try {
      // 完成 → 唤醒不可用（驱动无唤醒能力）→ 完成事实进「待注入」队列。
      await fx.server.handler(incoming('m-1', ASK));
      fx.executor.settle({ kind: 'ended', report: '汇总完成，共 3 条。' });
      await vi.waitFor(() => expect(fx.delivery.sentTexts).toHaveLength(1), { timeout: 10_000 });

      // 第二回合：事实已注入，但模型一个可见字都没产出（空回复）→ 回合失败，事实不核销。
      await expect(fx.server.handler(incoming('m-2', '空回复'))).rejects.toThrow();
      expect(fx.recorded[1]!.injections?.some((text) => text.startsWith('[任务完成]'))).toBe(true);

      // 第三回合：事实**仍在**待注入队列（旧实现这里就空了）——但本回合驱动抛错，同样不核销。
      await expect(fx.server.handler(incoming('m-3', '驱动失败'))).rejects.toThrow();
      expect(fx.recorded[2]!.injections?.some((text) => text.startsWith('[任务完成]'))).toBe(true);

      // 第四回合：终于有用户可见文本 → 核销；此后的回合不再重复注入。
      await fx.server.handler(incoming('m-4', '然后呢'));
      expect(fx.recorded[3]!.injections?.some((text) => text.startsWith('[任务完成]'))).toBe(true);
      await fx.server.handler(incoming('m-5', '还在吗'));
      expect((fx.recorded[4]!.injections ?? []).some((text) => text.includes('[任务完成]'))).toBe(false);
    } finally {
      await fx.close();
    }
  });
});
