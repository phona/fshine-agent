/**
 * 阶段 E · 失败如实转述（宿主三缺陷的确定性守卫；零真实模型、零网络）。
 *
 * 缺陷（证据：本会话重跑 `scripts/eval/pi152-stageB/injection.ts`，
 * `D-overflow-length` / `D-overflow-empty` 的 `finalText='历史答复 7。'`）：
 *   ① 溢出恢复后正文为空：宿主只写 `pi_driver_empty_reply` 日志，用户什么也没收到
 *      （守卫在 `apps/server/server.test.ts` 的渠道级用例：用户必须收到明确失败话术）。
 *   ② 溢出恢复失败（恢复摘要被 `length` 拒绝）时，Pi 丢弃失败回合的 assistant 项，
 *      驱动从转录尾部回扫，把**上一回合**答复当本回合回复返回——用户以为本回合答完了。
 *   ③ 失败回合的「旧回合答复」会被 `execution-runtime` 的回合归档写成任务行的最终回复，
 *      即失败以业务成功文本进入归档。
 *
 * 修复（宿主侧，不加机制、不加重试）：
 *   · `finalReplyText` 只认本回合 user 输入之后的 assistant/toolResult；本回合判失败或
 *     根本没把输入交给 Pi 时不取任何正文（`pi-driver.ts`）；
 *   · 渠道入口（`apps/server/server.ts`）把空回复转成回合失败，走既有失败话术通道。
 *
 * 反向绊线（把修复改回去必须变红，逐条实测见提交说明）：
 *   · 回合切点去掉 → 「回合切点」纯函数用例变红（返回「历史答复 7。」）；
 *   · 失败回合不取 toolResult 去掉 → 「工具结果不得冒充答复」与 ③ 变红；
 *   · 未把输入交给 Pi 的守卫去掉 → 「已中止」用例变红；
 *   · 渠道空回复守卫去掉 → `apps/server/server.test.ts` 的 ① 用例变红（用户零终帧）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createPiTurnDriver, finalReplyText } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';
import { createSession } from './src/execution-runtime';
import { createTaskRegistry } from './src/task-registry';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(prefix: string): { cwd: string; sessions: string } {
  const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  dirs.push(root);
  const cwd = path.join(root, 'cwd');
  const sessions = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  return { cwd, sessions };
}

/** 小窗 + 缩放后的压缩配置：足够切出尾段，溢出恢复会真的走「摘要 → 重发」。 */
const WINDOW = 32_768;
const COMPACTION = { enabled: true, reserveTokens: 4_096, keepRecentTokens: 2_048 };
const HISTORY_TURNS = 8;
const FINAL_PROMPT = '现在回答我：我之前让你记住的项目代号是什么？';
/** 上一回合的答复形状（缺陷证据里的冒充文本）。 */
const previousReply = (turn: number) => `历史答复 ${turn}。`;

function usage(total: number, output = 0) {
  return {
    input: Math.max(0, total - output), output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function asst(content: unknown[], stopReason = 'stop', errorMessage?: string, total = 5): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(total), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
  } as unknown as AgentMessage;
}
const textReply = (text: string) => asst([{ type: 'text', text }]);
const overThresholdReply = (text: string) => asst([{ type: 'text', text }], 'stop', undefined, WINDOW - COMPACTION.reserveTokens + 2_000);
const overflow = () => asst([], 'error', 'maximum context length exceeded: prompt is too long');
const lengthSummary = () => asst([{ type: 'text', text: '## Goal\n1. 记住' }], 'length');
const okSummary = () => asst([{ type: 'text', text: '摘要：用户要求记住项目代号「蓝鲸-42」。' }], 'stop');
const user = (text: string, ts = 1) => ({ role: 'user', content: text, timestamp: ts }) as unknown as AgentMessage;
const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  ...asst([{ type: 'toolCall', id, name, arguments: args }], 'toolUse'),
});

const filler = (n: number) => `背景 ${n}：` + '把这件事拆成可执行的小步，每步只解决一个问题，做完记录事实。'.repeat(60);
const historyPrompt = (i: number) => (i === 0 ? '项目代号是「蓝鲸-42」，请记住。' : `历史问题 ${i}：${filler(i)}`);

function isSummaryRequest(messages: readonly unknown[]): boolean {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
}

/** 驱动级夹具：8 个历史回合把窗口顶满，最后回合走溢出（摘要按 `summary` 给）。 */
async function runOverflowTurn(
  summary: () => AgentMessage,
  finalReply: (call: number) => AgentMessage,
  extra?: {
    tools?: readonly DiscoveredTool[];
    exec?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  },
) {
  const dir = workspace('fshine-stage-e-driver-');
  let mainCount = 0;
  const rt = await createScriptedModelRuntime({
    contextWindow: WINDOW,
    maxTokens: 2_048,
    script: (_index, ctx) => (isSummaryRequest(ctx.messages) ? summary() : finalReply(mainCount++)),
  });
  const driver = createPiTurnDriver({
    env: { LLM_MODEL: 'test-model' },
    modelRuntime: rt.runtime,
    compactionSettings: COMPACTION,
    reuseConversation: true,
    sessionDir: dir.sessions,
    workspaceDir: dir.cwd,
  });
  let messages: AgentMessage[] = [];
  const runTurn = async (text: string): Promise<{ text: string; messages: AgentMessage[] }> => {
    messages = [...messages, user(text, messages.length + 1)];
    const result = await driver.run({
      systemPrompt: '你是业务助手。',
      tools: extra?.tools ?? [],
      messages,
      onStep: () => {},
      exec: extra?.exec ?? (async () => ({})),
      deadline: Date.now() + 60_000,
    });
    messages = [...result.messages];
    return { text: result.text, messages: result.messages };
  };
  try {
    for (let i = 0; i < HISTORY_TURNS; i += 1) await runTurn(historyPrompt(i));
    const final = await runTurn(FINAL_PROMPT);
    return { final, transcript: driver.transcript?.() ?? [] };
  } finally {
    driver.close?.();
  }
}

describe('② 溢出恢复失败：不得返回上一回合答复', () => {
  it('回合切点：本回合 prompt 之后没有正文时不认上一回合 assistant（纯函数守卫）', () => {
    const history: AgentMessage[] = [
      user('旧问题。', 1),
      asst([{ type: 'text', text: previousReply(7) }]),
    ];
    // 本回合 prompt 已在转录末尾、但没有任何本回合产出 → 空（旧实现回扫到上一回合答复）。
    expect(finalReplyText([...history, user(FINAL_PROMPT, 2)], FINAL_PROMPT)).toBe('');
    // 正向对照：本回合有自己的正文 → 取本回合的，不取更早的。
    expect(finalReplyText([
      ...history,
      user(FINAL_PROMPT, 2),
      asst([{ type: 'text', text: '本回合答复。' }]),
    ], FINAL_PROMPT)).toBe('本回合答复。');
    // 无法归属（本回合没有 user 输入）→ 不冒充。
    expect(finalReplyText([user(FINAL_PROMPT, 2), asst([{ type: 'text', text: '答复。' }])], '   ')).toBe('');
    // 切点之前的 toolResult 也不算本回合答复（只有切点之后的 toolResult 才是终结话术）。
    expect(finalReplyText([
      user('旧问题。', 1),
      asst([{ type: 'text', text: previousReply(7) }]),
      { role: 'toolResult', content: [{ type: 'text', text: '工具结果。' }], timestamp: 2 } as unknown as AgentMessage,
      user(FINAL_PROMPT, 3),
    ], FINAL_PROMPT)).toBe('');
  });

  it('已中止的回合没有把输入交给 Pi：不返回上一回合答复（驱动级）', async () => {
    const dir = workspace('fshine-stage-e-abort-');
    const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textReply(previousReply(0)) });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
      sessionDir: dir.sessions,
      workspaceDir: dir.cwd,
    });
    let messages: AgentMessage[] = [user('第一问。', 1)];
    try {
      const first = await driver.run({
        systemPrompt: '你是业务助手。', tools: [], messages, onStep: () => {}, exec: async () => ({}),
        deadline: Date.now() + 60_000,
      });
      messages = [...first.messages, user('第二问。', 2)];
      const controller = new AbortController();
      controller.abort();
      const second = await driver.run({
        systemPrompt: '你是业务助手。', tools: [], messages, onStep: () => {}, exec: async () => ({}),
        deadline: Date.now() + 60_000,
        signal: controller.signal,
      });
      expect(second.text, '未把输入交给 Pi 的回合不得返回上一回合答复').toBe('');
    } finally {
      driver.close?.();
    }
  });

  it('恢复摘要被 length 拒 → 本回合 text 为空，而不是「历史答复 7。」', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { final, transcript } = await runOverflowTurn(lengthSummary, (call) => (call < HISTORY_TURNS ? textReply(previousReply(call)) : overflow()));
      // 缺陷形状复现：失败回合的 assistant 项被 Pi 丢弃，转录末条是上一回合答复。
      const lastAssistant = [...transcript].reverse().find((message) => (message as { role?: string }).role === 'assistant');
      expect(
        (lastAssistant as { content?: unknown } | undefined)?.content,
        '夹具前提：失败回合后转录里仍有上一回合答复（否则本用例没有覆盖到缺陷）',
      ).toEqual([{ type: 'text', text: previousReply(HISTORY_TURNS - 1) }]);
      // 修复：本回合没有产出任何正文 → 交回空文本（宿主按失败转述），不得回退旧回合答复。
      expect(final.text).toBe('');
      expect(final.text).not.toBe(previousReply(HISTORY_TURNS - 1));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('正向对照：溢出恢复成功（有效摘要）→ 交回本回合恢复后的正文', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { final } = await runOverflowTurn(okSummary, (call) => (call < HISTORY_TURNS
        ? textReply(previousReply(call))
        : call === HISTORY_TURNS ? overflow() : textReply('压缩后恢复的正文。')));
      expect(final.text).toBe('压缩后恢复的正文。');
      expect(final.text).not.toBe(previousReply(HISTORY_TURNS - 1));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('失败回合末尾的工具结果（run_task 回执 JSON）不得冒充答复', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { final } = await runOverflowTurn(lengthSummary, (call) => {
        if (call < HISTORY_TURNS) return textReply(previousReply(call));
        if (call === HISTORY_TURNS) return toolCall('run_task', { task: '查 documents W202611 并汇报' }, 'call_main_1');
        return overflow();
      }, {
        tools: [{
          name: 'run_task',
          description: '委派任务',
          inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
        }],
        exec: async () => ({ taskId: 'task_x', summary: 'documents W202611：3 条。' }),
      });
      // 失败回合的 assistant 项被 Pi 丢弃后，转录尾部是 run_task 的工具结果；
      // 它是工具事实、不是给用户的答复——不得作为本回合回复返回。
      expect(final.text).toBe('');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('③ 失败回合不得进入业务成功归档', () => {
  const MANIFEST: CapabilityManifest = {
    contractVersion: 1,
    operations: [{ name: 'dummy.query', label: 'query items', args: [] }],
  };
  class FakeClient implements ExecutionClient {
    readonly requests: ExecutionRequest[] = [];
    async capabilities(): Promise<CapabilityManifest> { return MANIFEST; }
    async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
      this.requests.push(request);
      return { status: 'completed', data: { count: 3 } };
    }
  }

  it('委派后溢出失败：本回合无答复，任务行不写旧回合答复（replyText 无存档）', async () => {
    const dir = workspace('fshine-stage-e-runtime-');
    const client = new FakeClient();
    const registry = createTaskRegistry();
    // Main：历史回合正常 → 失败回合先委派（产生任务事实）→ 同回合溢出且恢复摘要被拒。
    let mainCount = 0;
    const mainRt = await createScriptedModelRuntime({
      contextWindow: WINDOW,
      maxTokens: 2_048,
      script: (_index, ctx) => {
        if (isSummaryRequest(ctx.messages)) return lengthSummary();
        const call = mainCount;
        mainCount += 1;
        if (call < HISTORY_TURNS) return textReply(previousReply(call));
        if (call === HISTORY_TURNS) return toolCall('run_task', { task: '查 documents W202611 并汇报' }, 'call_main_1');
        return overflow();
      },
    });
    let workerCount = 0;
    const workerRt = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: () => (workerCount++ === 0
        ? toolCall('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'documents', '--window': 'W202611' },
        }, 'call_worker_1')
        : textReply('documents W202611：3 条。')),
    });
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_stage_e',
      client,
      allowedOperations: ['dummy.query'],
      mainDriver: createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: mainRt.runtime,
        compactionSettings: COMPACTION,
        reuseConversation: true,
        sessionDir: dir.sessions,
        workspaceDir: dir.cwd,
      }),
      workerDriver: createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: workerRt.runtime }),
      mainSystemPrompt: '你是测试主 Agent。',
      taskRegistry: registry,
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < HISTORY_TURNS; i += 1) {
        const turn = await session.send(historyPrompt(i));
        expect(turn.reply).toBe(previousReply(i));
      }
      // 本回合：任务确实执行了（执行事实存在），但 Main 的最终回复失败 → 本回合无答复
      // （空文本；渠道入口据它转成用户可见失败，见 apps/server/server.test.ts）。
      const failedTurn = await session.send(FINAL_PROMPT);
      expect(failedTurn.reply, '失败回合不得返回旧回合答复或工具回执').toBe('');
      expect(failedTurn.taskIds, '失败回合的委派仍留下任务事实').toHaveLength(1);
      const tasks = session.tasks();
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      // 任务自身的执行事实是成功的（这是任务层，不是回合层）。
      expect(task.status).toBe('completed');
      expect(task.resultText).toBe('documents W202611：3 条。');
      // 回合失败 → 不写最终回复存档；尤其不得写入上一回合答复/工具回执冒充本回合。
      expect(task.replyText).toBeUndefined();
      expect(JSON.stringify(task)).not.toContain(previousReply(HISTORY_TURNS - 1));
    } finally {
      console.warn = originalWarn;
    }
  });
});
