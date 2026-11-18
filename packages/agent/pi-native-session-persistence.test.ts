/**
 * P0 验收 · Main 直接用磁盘 Pi 会话（宿主搬运层退役）。
 *
 * 断言口径（owner 批准的 P0）：
 *   ① 摘要存活：会触发 Pi 压缩的长会话 → 磁盘上有 `compaction` entry；**重开会话对象**
 *      （同 principal/session、新驱动实例）后，第一回合发给模型的第一条消息就是压缩摘要，
 *      上下文明显小于全量历史；
 *   ② 重启不重放：重开后的首回合 messages 长度不随历史线性增长（不重放全部原始消息）；
 *   ③ principal 隔离：同 sessionId 两个 principal → 两份文件、互不串读（同 principal 同
 *      session 解析回同一份）；
 *   夹具 = 脚本化 `ModelRuntime`（零网络）+ 真实 Pi 驱动 + 真实文件系统。
 *
 * 反向绊线（故意破坏必红）：把 pi-driver 的 resume 分支改成「永远新建内存会话」
 * （忽略 sessionDir/resumeSessionFile），①② 必红——本文件即该行为的守卫。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import { createPiTurnDriver, type PiTurnDriverOptions } from './src/pi-driver';
import { SessionPersistence } from './src/session-persistence';
import type { TurnDriver, TurnDriverInput } from './src/driver-contract';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

const WINDOW = 40_000;
/**
 * 显式压缩配置（装配层本来就按窗口给绝对 reserve/keepRecent）：窗口 40k、阈值 32k tokens、
 * 只保留最近 ~800 tokens——让一次阈值压缩把长历史切掉大部分，判据有判别力。
 */
const COMPACTION = { enabled: true, reserveTokens: 8_000, keepRecentTokens: 800 };
const SUMMARY_MARKER = '【此前会话摘要】用户查过 W1 账套，当前游标 page_7。';

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pi-native-session-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function usage(totalTokens: number) {
  return {
    input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asst(content: unknown[], stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(5), stopReason, timestamp: Date.now(),
  } as unknown as AgentMessage;
}
const textReply = (text: string): AgentMessage => asst([{ type: 'text', text }]);
const user = (text: string, ts = 1): AgentMessage => ({ role: 'user', content: text, timestamp: ts } as unknown as AgentMessage);

/** 带显式 usage 的历史 assistant：Pi 用 usage 估算上下文（不是内容长度）。 */
function assistantWithUsage(totalTokens: number): AgentMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: '此前答复' }], api: 'openai-completions',
    provider: 'llm', model: 'test-model', usage: usage(totalTokens), stopReason: 'stop', timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 越阈的回复（Pi 在一次响应之后按 usage 判 threshold；阈值 = W − reserveTokens）。 */
function replyOverThreshold(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: WINDOW - COMPACTION.reserveTokens + 1_000, output: 10, cacheRead: 0, cacheWrite: 0,
      reasoning: 0, totalTokens: WINDOW - COMPACTION.reserveTokens + 1_010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 足够长、可被 Pi 切出尾段的历史（12 轮 × ~5k 字符 ≈ 15k tokens）。 */
function seedHistory(): AgentMessage[] {
  const pairs = 12;
  const perMessageChars = 5_000;
  const filler = '背景'.repeat(Math.ceil(perMessageChars / 2));
  const out: AgentMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push(user(`历史问题 ${i}：${filler}`, i * 2 + 1));
    out.push(assistantWithUsage(100));
  }
  return out;
}

/** Pi 的摘要请求形状（历史摘要 `<conversation>` / 回合前缀 `# Conversation`）。 */
function isSummaryRequest(messages: readonly { role?: string; content?: unknown }[]): boolean {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
}

const EMPTY_TOOLS: DiscoveredTool[] = [];
function runInput(messages: AgentMessage[], deadlineMs = 60_000): TurnDriverInput {
  return {
    systemPrompt: '你是测试主 Agent。',
    tools: EMPTY_TOOLS,
    messages,
    onStep: () => {},
    exec: async () => ({ ok: true }),
    deadline: Date.now() + deadlineMs,
  };
}

function driverOf(runtime: PiTurnDriverOptions['modelRuntime'], session: {
  sessionDir: string;
  piSessionId: string;
  resumeSessionFile?: string;
}): TurnDriver {
  return createPiTurnDriver({
    env: { LLM_MODEL: 'test-model' },
    modelRuntime: runtime,
    reuseConversation: true,
    compactionSettings: COMPACTION,
    sessionDir: session.sessionDir,
    sessionId: session.piSessionId,
    ...(session.resumeSessionFile === undefined ? {} : { resumeSessionFile: session.resumeSessionFile }),
  });
}

/** 请求里第一条**模型可见**消息（首条是 Pi 渲染的 system 提示）。 */
function firstModelMessage(
  request: readonly { role?: string; content?: unknown }[],
): { role?: string; content?: unknown } | undefined {
  return request.find((message) => message.role !== 'system');
}

const firstText = (message: { content?: unknown } | undefined): string => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content[0] as { text?: unknown } | undefined;
    return typeof block?.text === 'string' ? block.text : '';
  }
  return '';
};

interface CompactedRun {
  readonly resumedRequest: readonly { role?: string; content?: unknown }[];
  readonly seededHistoryLength: number;
  readonly fullHistoryChars: number;
  readonly sessionFile: string;
}

/**
 * 跑一个会触发 Pi 压缩的长会话，关闭会话对象，再用同一 (principal, session) 重开一回合，
 * 返回重开首回合发给模型的请求（夹具事实：压缩发生在首回合响应之后）。
 */
async function runCompactedSessionThenResume(): Promise<CompactedRun> {
  const root = tempRoot();
  const persistence = new SessionPersistence({ rootDir: root });
  const first = persistence.resolve('wecom:alice', 'conv-1');

  const firstRuntime = await createScriptedModelRuntime({
    contextWindow: WINDOW,
    maxTokens: 4_096,
    script: (_index, context) => (isSummaryRequest(context.messages)
      ? asst([{ type: 'text', text: SUMMARY_MARKER }])
      : replyOverThreshold('压缩后的答复。')),
  });
  const driver = driverOf(firstRuntime.runtime, first);
  const history = seedHistory();
  const turn = await driver.run(runInput([...history, user('继续翻页。', 200)]));
  expect(turn.text, '首回合必须有答复').toBe('压缩后的答复。');
  expect(JSON.stringify(turn.messages), '首回合必须由 Pi 压出摘要').toContain(SUMMARY_MARKER);
  driver.close?.();

  // 重启：同 (principal, session) 重新解析 → 必须落到同一份已落盘文件。
  const resumed = persistence.resolve('wecom:alice', 'conv-1');
  expect(resumed.resumeSessionFile, '压缩摘要必须已落盘（重开可 resume）').toBeTruthy();
  expect(resumed.piSessionId).toBe(first.piSessionId);
  expect(resumed.sessionDir).toBe(first.sessionDir);

  const raw = readFileSync(resumed.resumeSessionFile!, 'utf8');
  expect(raw, '落盘必须含 Pi 的 compaction entry').toContain('"type":"compaction"');
  // issue #67 后继守卫（取代旧断言「Pi 日志只增不减」）：死历史已移入 archive，活跃文件
  // 不再回放；原始字节仍在归档里逐字节可考，不是丢失。
  const archiveDir = path.join(path.dirname(resumed.resumeSessionFile!), 'archive');
  const archives = readdirSync(archiveDir).filter((name) => name.endsWith('.jsonl.gz'));
  expect(archives.length, '压缩后必须产生归档文件').toBeGreaterThan(0);
  const archivedText = archives
    .map((name) => gunzipSync(readFileSync(path.join(archiveDir, name))).toString('utf8'))
    .join('');
  expect(archivedText, '早期原始 message entry 已移入归档').toContain('历史问题 0');
  expect(raw, '活跃文件不再保留已归档的早期历史').not.toContain('历史问题 0');

  const resumedRuntime = await createScriptedModelRuntime({
    contextWindow: WINDOW,
    maxTokens: 4_096,
    script: (_index, context) => (isSummaryRequest(context.messages)
      ? asst([{ type: 'text', text: '二次摘要' }])
      : textReply('重启后的答复。')),
  });
  const resumedDriver = driverOf(resumedRuntime.runtime, resumed);
  // 宿主不再 seed 任何历史：本回合只交「本轮输入」。
  const resumedTurn = await resumedDriver.run(runInput([user('重启后第一个问题', 300)]));
  expect(resumedTurn.text).toBe('重启后的答复。');
  resumedDriver.close?.();

  const request = resumedRuntime.requests()[0]?.messages ?? [];
  return {
    resumedRequest: request,
    seededHistoryLength: history.length,
    fullHistoryChars: JSON.stringify([...history, user('继续翻页。', 200)]).length,
    sessionFile: resumed.resumeSessionFile!,
  };
}

describe('P0 · Main 直接用磁盘 Pi 会话', () => {
  it('① 摘要存活：重开后回放的第一条就是压缩摘要，上下文明显小于全量历史', async () => {
    const run = await runCompactedSessionThenResume();

    expect(run.resumedRequest.length, '重开后请求必须非空').toBeGreaterThan(0);
    const summary = firstText(firstModelMessage(run.resumedRequest));
    expect(summary, '重开首回合的第一条模型可见消息必须是压缩摘要').toContain(SUMMARY_MARKER);
    expect(summary, '摘要是 Pi 打包的原文（不是宿主拼的）').toContain('page_7');

    const requestChars = JSON.stringify(run.resumedRequest).length;
    expect(
      requestChars,
      `重开后的上下文必须明显小于全量历史（${requestChars} vs 全量 ${run.fullHistoryChars}）`,
    ).toBeLessThan(run.fullHistoryChars / 3);
    expect(JSON.stringify(run.resumedRequest), '被摘要覆盖的早期原始消息不得重放').not.toContain('历史问题 0');
  });

  it('② 重启不重放：重开首回合 messages 长度不随历史线性增长', async () => {
    const run = await runCompactedSessionThenResume();

    // 全量重放会带来 seededHistoryLength + 1 条；Pi 原生 resume + 压缩摘要必须显著更少。
    expect(run.seededHistoryLength, '夹具历史必须足够长（否则本用例无判别力）').toBeGreaterThanOrEqual(20);
    expect(
      run.resumedRequest.length,
      `重开后首回合消息数=${run.resumedRequest.length}，全量重放会是 ${run.seededHistoryLength + 2}`,
    ).toBeLessThan(run.seededHistoryLength / 3);
  });

  it('③ principal 隔离：同 sessionId 两个 principal → 两份文件、互不串读', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const aliceLocation = persistence.resolve('wecom:alice', 'shared-conv');
    const bobLocation = persistence.resolve('wecom:bob', 'shared-conv');
    expect(aliceLocation.sessionDir, '不同 principal 必须物理分目录').not.toBe(bobLocation.sessionDir);
    expect(aliceLocation.piSessionId, '同 sessionId 映射同一 Pi id（在各自子树内）').toBe(bobLocation.piSessionId);

    const aliceRuntime = await createScriptedModelRuntime({ contextWindow: WINDOW, script: () => textReply('记下A') });
    const aliceDriver = driverOf(aliceRuntime.runtime, aliceLocation);
    await aliceDriver.run(runInput([user('alice 的私事：项目代号蓝鲸', 1)]));
    aliceDriver.close?.();

    // alice 有了落盘文件；bob 同 sessionId 仍没有。
    const aliceResumed = persistence.resolve('wecom:alice', 'shared-conv');
    expect(aliceResumed.resumeSessionFile).toBeTruthy();
    expect(persistence.resolve('wecom:bob', 'shared-conv').resumeSessionFile, 'bob 不得读到 alice 的文件').toBeUndefined();

    // bob 开新会话发一轮：上下文里绝不能出现 alice 的内容。
    const bobRuntime = await createScriptedModelRuntime({ contextWindow: WINDOW, script: () => textReply('记下B') });
    const bobDriver = driverOf(bobRuntime.runtime, bobLocation);
    await bobDriver.run(runInput([user('bob 的问题', 2)]));
    bobDriver.close?.();
    const bobRequest = JSON.stringify(bobRuntime.requests()[0]?.messages ?? []);
    expect(bobRequest).not.toContain('alice 的私事');

    // alice 重开：历史在（同 principal 同 session 解析回同一份文件）。
    const aliceAgain = persistence.resolve('wecom:alice', 'shared-conv');
    expect(aliceAgain.resumeSessionFile).toBe(aliceResumed.resumeSessionFile);
    const aliceAgainRuntime = await createScriptedModelRuntime({ contextWindow: WINDOW, script: () => textReply('继续A') });
    const aliceAgainDriver = driverOf(aliceAgainRuntime.runtime, aliceAgain);
    await aliceAgainDriver.run(runInput([user('继续', 3)]));
    aliceAgainDriver.close?.();
    const aliceRequest = JSON.stringify(aliceAgainRuntime.requests()[0]?.messages ?? []);
    expect(aliceRequest).toContain('alice 的私事');
    expect(aliceRequest).not.toContain('bob 的问题');
  });
});
