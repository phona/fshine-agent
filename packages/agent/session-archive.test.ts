/**
 * 会话归档（issue #67）· 确定性回归（零真实模型、零网络）。
 *
 * owner 口径（2026-11-18）：发生 compaction 之后，把 `firstKeptEntryId` 之前的
 * **死历史**移出活跃会话文件，按 gzip 归档到 `<sessionDir>/archive/<文件名>.<序号>.jsonl.gz`；
 * 归档后模型不再回放这些条目。
 *
 * P0 基线（2026-11-18 合入）：Main 的 agent loop 直接用磁盘 Pi 会话
 * （`pi-driver` 收 `sessionDir`/`sessionId`/`resumeSessionFile`），压缩条目真的落在会话文件里；
 * `session-persistence` 退化为「路径解析 + 坏文件校验」，不再搬运 message。
 *
 * 判据：
 *   ① 切分与字节：活跃文件变小 + archive 出现 .gz + gunzip 后的行与被移出的原始行逐字节相等；
 *   ② 重启恢复：归档后重新打开同一 session 继续一轮对话成功，压缩摘要仍在回放里；
 *   ③ 失败注入：归档写失败时原文件字节不变，事件为 session_archive_failed；
 *   ④ 连续压缩：归档序号递增，文件始终只留最新摘要 + 保留段；
 *   ⑤ P0 语义：归档后重启 resume，首回合回放 = 摘要 + 保留段（不是全量历史）。
 *   反向绊线（人工执行，见回报）：短路 pi-driver 的归档调用 → ①/④/⑤ 必红。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { TurnDriver, TurnDriverInput } from './src/driver-contract';
import { createPiTurnDriver, type PiTurnDriverOptions } from './src/pi-driver';
import { archiveCompactedSessionFile, SessionPersistence } from './src/session-persistence';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

const WINDOW = 40_000;
/** 显式压缩配置：阈值 32k tokens，只保留最近 ~800 tokens（一次压缩切掉大部分历史）。 */
const COMPACTION = { enabled: true, reserveTokens: 8_000, keepRecentTokens: 800 };
const SUMMARY_MARKER = '【此前会话摘要】';
const SUMMARY_TEXT = '摘要：用户查过 W1 账套，当前游标 page_7。';

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'session-archive-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function usage(input: number, output: number) {
  return {
    input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asst(content: unknown[], stopReason = 'stop', input = 10, output = 20): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: usage(input, output), stopReason, timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function user(text: string, timestamp = 1): AgentMessage {
  return { role: 'user', content: text, timestamp } as unknown as AgentMessage;
}

function replyOverThreshold(text: string): AgentMessage {
  return asst([{ type: 'text', text }], 'stop', WINDOW - COMPACTION.reserveTokens + 1_000, 10);
}

const textReply = (text: string): AgentMessage => asst([{ type: 'text', text }]);

function isSummaryRequest(messages: readonly unknown[]): boolean {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
}

const hasSummary = (messages: readonly AgentMessage[]): boolean =>
  messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' && content.includes(SUMMARY_MARKER);
  });

/** 足够长、可被 Pi 切出尾段的历史（12 轮 × ~5k 字符 ≈ 15k tokens，Pi 原生 session 夹具同口径）。 */
function seedHistory(): AgentMessage[] {
  const pairs = 12;
  const perMessageChars = 5_000;
  const filler = '背景'.repeat(Math.ceil(perMessageChars / 2));
  const out: AgentMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push(user(`历史问题 ${i}：${filler}`, i * 2 + 1));
    out.push(asst([{ type: 'text', text: '此前答复' }], 'stop', 100, 10));
  }
  return out;
}

function runInput(messages: AgentMessage[]): TurnDriverInput {
  return {
    systemPrompt: '你是助手。',
    tools: [],
    messages,
    onStep: () => {},
    exec: async () => undefined,
    deadline: Date.now() + 60_000,
  };
}

function driverOf(
  runtime: PiTurnDriverOptions['modelRuntime'],
  session: { sessionDir: string; piSessionId: string; resumeSessionFile?: string },
  options: { reuseConversation?: boolean } = {},
): TurnDriver {
  return createPiTurnDriver({
    env: { LLM_MODEL: 'test-model' },
    modelRuntime: runtime,
    compactionSettings: COMPACTION,
    sessionDir: session.sessionDir,
    sessionId: session.piSessionId,
    ...(options.reuseConversation === true ? { reuseConversation: true } : {}),
    ...(session.resumeSessionFile === undefined ? {} : { resumeSessionFile: session.resumeSessionFile }),
  });
}

/** 首条模型可见消息（首条通常是 Pi 渲染的 system 提示）。 */
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

const sessionMessage = (text: string, timestamp: number) =>
  ({ role: 'user', content: text, timestamp } as never);

/** 直接构造一个「压缩后」的会话文件：header + 6 条消息 + compaction（保留最后 3 条）。 */
function createCompactedSession(options: { keepFrom?: number; firstKept?: string | null } = {}): {
  filePath: string;
  sessionDir: string;
  ids: string[];
  firstKeptId: string;
} {
  const sessionDir = path.join(tempRoot(), 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create('/tmp/archive-cwd', sessionDir, { id: 'b1aabbcc' });
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    ids.push(manager.appendMessage(sessionMessage(`历史消息 ${index} ${'x'.repeat(120)}`, index + 1)));
  }
  const firstKeptId = options.firstKept === undefined
    ? (ids[options.keepFrom ?? 3] as string)
    : options.firstKept;
  const compactionId = manager.appendCompaction(SUMMARY_TEXT, firstKeptId, 4_000);
  const filePath = manager.getSessionFile();
  if (filePath === undefined) throw new Error('（测试）SessionManager 未落盘');
  return { filePath, sessionDir, ids, firstKeptId: firstKeptId ?? compactionId };
}

function readLines(filePath: string): Buffer[] {
  const raw = readFileSync(filePath);
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0a) {
      lines.push(raw.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  return lines;
}

function parsedLines(filePath: string): Array<Record<string, unknown>> {
  return readLines(filePath)
    .map((line) => line.toString('utf8').trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function archiveEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((event) => String(event['event'] ?? '').startsWith('session_archive_'));
}

/** 跑一回合会触发压缩的长会话（真实 Pi 驱动 + 磁盘会话），返回归档事件与文件路径。 */
async function runCompactedDriverTurn(options: {
  sessionDir: string;
  sessionId?: string;
  reuseConversation?: boolean;
}): Promise<{ text: string; messages: readonly AgentMessage[]; sessionFile: string; events: Array<Record<string, unknown>> }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const runtime = await createScriptedModelRuntime({
      contextWindow: WINDOW,
      maxTokens: 4_096,
      script: (_index, context) => (isSummaryRequest(context.messages)
        ? asst([{ type: 'text', text: SUMMARY_TEXT }])
        : replyOverThreshold('压缩后的答复。')),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: runtime.runtime,
      compactionSettings: COMPACTION,
      sessionDir: options.sessionDir,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.reuseConversation === true ? { reuseConversation: true } : {}),
    });
    const result = await driver.run(runInput([...seedHistory(), user('继续翻页。', 200)]));
    const files = readdirSync(options.sessionDir).filter((name) => name.endsWith('.jsonl'));
    expect(files.length, '必须恰好一个 Pi 会话文件').toBe(1);
    const sessionFile = path.join(options.sessionDir, files[0] as string);
    const events = archiveEvents(warn);
    driver.close?.();
    return { text: result.text, messages: result.messages, sessionFile, events };
  } finally {
    warn.mockRestore();
  }
}

// ─────────────────────────────────────────────────────── ① 切分 / 字节 / 触发
describe('① 压缩后归档：活跃文件变小、archive 出现 .gz、归档行与被移出原始行逐字节相等', () => {
  it('firstKeptEntryId 之前逐字节归档，活跃文件只留 header + 保留段 + 压缩条目', () => {
    const { filePath, sessionDir, ids, firstKeptId } = createCompactedSession();
    const originalRaw = readFileSync(filePath);
    const originalLines = readLines(filePath);
    const cutIndex = originalLines.findIndex(
      (line) => (JSON.parse(line.toString('utf8').trim()) as { id?: string }).id === firstKeptId,
    );
    expect(cutIndex, 'firstKeptEntryId 必须能在原文件里定位').toBeGreaterThan(1);
    const movedLines = originalLines.slice(1, cutIndex);

    const outcome = archiveCompactedSessionFile(filePath);
    expect(outcome.archived).toBe(true);
    if (!outcome.archived) return;

    const archiveDir = path.join(sessionDir, 'archive');
    const archives = readdirSync(archiveDir).filter((name) => name.endsWith('.jsonl.gz'));
    expect(archives).toEqual([`${path.basename(filePath)}.1.jsonl.gz`]);
    expect(outcome.archivePath).toBe(path.join(archiveDir, archives[0] as string));

    // 核心判据：gunzip 后的行 == 被移出的原始行（逐字节，不重排、不改写）。
    const archivedBytes = gunzipSync(readFileSync(outcome.archivePath));
    expect(archivedBytes.equals(Buffer.concat(movedLines))).toBe(true);
    expect(outcome.archivedEntries).toBe(movedLines.length);
    expect(outcome.archivedBytes).toBe(archivedBytes.length);

    const activeRaw = readFileSync(filePath);
    expect(outcome.activeBytesAfter).toBe(activeRaw.length);
    expect(activeRaw.length).toBeLessThan(originalRaw.length);
    const active = parsedLines(filePath);
    expect(active[0]?.['type']).toBe('session');
    expect(active[0]?.['id']).toBe('b1aabbcc');
    const activeIds = new Set(active.map((entry) => entry['id']));
    const archivedIds = movedLines.map(
      (line) => (JSON.parse(line.toString('utf8').trim()) as { id?: string }).id,
    );
    for (const id of archivedIds) {
      expect(activeIds.has(id), `被归档的条目 ${String(id)} 不应留在活跃文件`).toBe(false);
    }
    expect(activeIds.has(firstKeptId)).toBe(true);
    expect(active.at(-1)?.['type']).toBe('compaction');
    expect(active.at(-1)?.['summary']).toBe(SUMMARY_TEXT);
    expect(ids.slice(0, cutIndex - 1)).toEqual(archivedIds);
  });

  it('无保留段的压缩（firstKeptEntryId 为空）：压缩条目 parentId 置空且可加载', () => {
    const { filePath, sessionDir } = createCompactedSession({ firstKept: null });
    const outcome = archiveCompactedSessionFile(filePath);
    expect(outcome.archived).toBe(true);
    const active = parsedLines(filePath);
    expect(active).toHaveLength(2);
    expect(active[1]?.['parentId'], '指向已归档条目的 parentId 置 null').toBeNull();

    const reopened = SessionManager.open(filePath, sessionDir, '/tmp/archive-cwd');
    expect(reopened.buildContextEntries().map((entry) => entry.type)).toEqual(['compaction']);
    expect(reopened.appendMessage(sessionMessage('归档后新消息', 3)).length).toBeGreaterThan(0);
  });

  it('再次压缩：归档序号递增，不覆盖上一份归档', () => {
    const { filePath, sessionDir } = createCompactedSession();
    expect(archiveCompactedSessionFile(filePath).archived).toBe(true);

    const manager = SessionManager.open(filePath, sessionDir, '/tmp/archive-cwd');
    for (let index = 0; index < 4; index += 1) {
      manager.appendMessage(sessionMessage(`新增消息 ${index}`, 200 + index));
    }
    const newer = manager.appendMessage(sessionMessage('最新消息', 300));
    const compactionId = manager.appendCompaction('摘要：第二轮。', newer, 5_000);
    expect(compactionId.length).toBeGreaterThan(0);

    const second = archiveCompactedSessionFile(filePath);
    expect(second.archived).toBe(true);
    if (!second.archived) return;
    expect(second.archivePath.endsWith(`${path.basename(filePath)}.2.jsonl.gz`)).toBe(true);
    expect(existsSync(path.join(sessionDir, 'archive', `${path.basename(filePath)}.1.jsonl.gz`))).toBe(true);
  });

  it('驱动触发：Pi 阈值压缩结束后自动归档，事件带字节数/条目数/归档路径', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const location = persistence.resolve('wecom:alice', 'conv-1');
    const run = await runCompactedDriverTurn({ sessionDir: location.sessionDir, sessionId: location.piSessionId });

    expect(run.text).toBe('压缩后的答复。');
    expect(hasSummary(run.messages)).toBe(true);
    const written = run.events.find((event) => event['event'] === 'session_archive_written');
    expect(written, '归档成功必须落 session_archive_written 事件').toBeDefined();
    expect(written?.['archivedEntries']).toBeGreaterThan(0);
    expect(written?.['archivedBytes']).toBeGreaterThan(0);
    expect(written?.['activeBytesAfter'] as number).toBeLessThan(written?.['activeBytesBefore'] as number);
    const archivePath = String(written?.['archivePath'] ?? '');
    expect(archivePath).toContain(path.join('archive', ''));
    expect(existsSync(archivePath)).toBe(true);

    // 活跃文件只留压缩条目 + 保留段；早期历史已移入归档（P0 的「只增不减」被 issue #67 取代）。
    const entries = parsedLines(run.sessionFile);
    expect(entries[0]?.['type']).toBe('session');
    expect(entries.at(-1)?.['type']).toBe('compaction');
    expect(readFileSync(run.sessionFile, 'utf8')).not.toContain('历史问题 0');
    expect(gunzipSync(readFileSync(archivePath)).toString('utf8')).toContain('历史问题 0');

    // 路径解析仍认这份文件（归档是原地重写，不换文件名）。
    const again = persistence.resolve('wecom:alice', 'conv-1');
    expect(again.resumeSessionFile).toBe(run.sessionFile);
    expect(again.piSessionId).toBe(location.piSessionId);
  });
});

// ─────────────────────────────────────────────────────── ② 重启恢复并继续对话
describe('② 归档后重启恢复：SessionManager.open 可加载，压缩摘要在回放里，继续一轮对话成功', () => {
  it('重开的 manager 只回放压缩摘要 + 保留段，并能继续追加', () => {
    const { filePath, sessionDir, firstKeptId } = createCompactedSession();
    expect(archiveCompactedSessionFile(filePath).archived).toBe(true);

    const reopened = SessionManager.open(filePath, sessionDir, '/tmp/archive-cwd');
    expect(reopened.getSessionId()).toBe('b1aabbcc');
    const context = reopened.buildContextEntries();
    expect(context[0]?.type, '回放第一条是压缩摘要').toBe('compaction');
    expect((context[0] as { summary?: string } | undefined)?.summary).toBe(SUMMARY_TEXT);
    expect(context.map((entry) => entry.id)).toContain(firstKeptId);
    expect(context.filter((entry) => entry.type === 'compaction')).toHaveLength(1);

    const appendedId = reopened.appendMessage(sessionMessage('归档后新消息', 400));
    const reread = SessionManager.open(filePath, sessionDir, '/tmp/archive-cwd');
    const rereadContext = reread.buildContextEntries();
    expect((rereadContext[0] as { summary?: string } | undefined)?.summary).toBe(SUMMARY_TEXT);
    expect(rereadContext.map((entry) => entry.id)).toContain(appendedId);
  });

  it('驱动 resume：归档后同一文件继续一轮对话成功，摘要仍在转录里', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const first = persistence.resolve('wecom:alice', 'conv-2');
    const run = await runCompactedDriverTurn({ sessionDir: first.sessionDir, sessionId: first.piSessionId });

    const resumed = persistence.resolve('wecom:alice', 'conv-2');
    expect(resumed.resumeSessionFile).toBe(run.sessionFile);
    const runtime = await createScriptedModelRuntime({
      contextWindow: WINDOW,
      maxTokens: 4_096,
      script: (_index, context) => (isSummaryRequest(context.messages)
        ? asst([{ type: 'text', text: '二次摘要' }])
        : textReply('归档后继续成功。')),
    });
    const driver = driverOf(runtime.runtime, resumed, { reuseConversation: true });
    const result = await driver.run(runInput([user('归档后继续。', 500)]));
    driver.close?.();
    expect(result.text).toBe('归档后继续成功。');
    expect(hasSummary(result.messages), '重启后压缩摘要必须仍在回放里').toBe(true);

    const after = parsedLines(run.sessionFile);
    expect(after[0]?.['type']).toBe('session');
    expect(after.some((entry) => entry['type'] === 'compaction')).toBe(true);
    expect(after.some((entry) => entry['message'] !== undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────── ⑤ P0 语义：回放 = 摘要 + 保留段
describe('⑤ P0 语义：归档后重启 resume，首回合回放 = 摘要 + 保留段（不是全量历史）', () => {
  it('resume 首回合第一条模型可见消息是摘要，且早期历史不被重放', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const first = persistence.resolve('wecom:alice', 'conv-3');
    const run = await runCompactedDriverTurn({ sessionDir: first.sessionDir, sessionId: first.piSessionId });
    const resumed = persistence.resolve('wecom:alice', 'conv-3');
    expect(resumed.resumeSessionFile).toBe(run.sessionFile);

    const runtime = await createScriptedModelRuntime({
      contextWindow: WINDOW,
      maxTokens: 4_096,
      script: (_index, context) => (isSummaryRequest(context.messages)
        ? asst([{ type: 'text', text: '二次摘要' }])
        : textReply('重启后的答复。')),
    });
    const driver = driverOf(runtime.runtime, resumed, { reuseConversation: true });
    const turn = await driver.run(runInput([user('重启后第一个问题', 600)]));
    driver.close?.();
    expect(turn.text).toBe('重启后的答复。');

    const request = runtime.requests()[0]?.messages ?? [];
    const firstModel = firstText(firstModelMessage(request));
    expect(firstModel, '首条模型可见消息必须是 Pi 的压缩摘要').toContain('compacted into the following summary');
    expect(firstModel).toContain(SUMMARY_TEXT);
    expect(JSON.stringify(request), '被归档的早期历史不得重放').not.toContain('历史问题 0');
    expect(JSON.stringify(request)).not.toContain('历史问题 5');
  });
});

// ─────────────────────────────────────────────────────── ③ 失败注入：原文件不变
describe('③ 归档写失败：原文件字节不变、不产生半成品归档', () => {
  it('archive 目录被占位为普通文件 → 抛错且活跃文件逐字节不变', () => {
    const { filePath, sessionDir } = createCompactedSession();
    const before = readFileSync(filePath);
    writeFileSync(path.join(sessionDir, 'archive'), 'not-a-directory');

    expect(() => archiveCompactedSessionFile(filePath)).toThrow(/archive|EEXIST|ENOTDIR/i);
    expect(readFileSync(filePath).equals(before), '失败时原文件必须逐字节不变').toBe(true);
    expect(existsSync(path.join(sessionDir, 'archive', `${path.basename(filePath)}.1.jsonl.gz`))).toBe(false);
  });

  it('驱动内归档失败 → 事件为 session_archive_failed，会话文件仍可完整加载', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const location = persistence.resolve('wecom:alice', 'conv-fail');
    // 预占 archive 路径：压缩结束时的归档必然失败。
    writeFileSync(path.join(location.sessionDir, 'archive'), 'not-a-directory');
    const run = await runCompactedDriverTurn({ sessionDir: location.sessionDir, sessionId: location.piSessionId });

    expect(run.text).toBe('压缩后的答复。');
    const failed = run.events.find((event) => event['event'] === 'session_archive_failed');
    expect(failed, '归档失败必须落 session_archive_failed 事件').toBeDefined();
    expect(run.events.some((event) => event['event'] === 'session_archive_written')).toBe(false);

    // 原文件未被截断：种子历史仍在（失败不破坏、不丢会话）。
    const raw = readFileSync(run.sessionFile, 'utf8');
    expect(raw).toContain('历史问题 0');
    expect(raw).toContain('"type":"compaction"');
    const entries = parsedLines(run.sessionFile);
    expect(entries[0]?.['type']).toBe('session');
    expect(() => SessionManager.open(run.sessionFile, location.sessionDir, '/tmp/archive-cwd')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────── ④ 连续压缩
describe('④ 连续压缩：归档序号递增，活跃文件始终只保留当前压缩摘要 + 保留段', () => {
  it('连续多次压缩：≥2 次归档、文件里只有一个 compaction、可独立重开', async () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const location = persistence.resolve('wecom:alice', 'conv-4');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = await createScriptedModelRuntime({
        contextWindow: WINDOW,
        maxTokens: 4_096,
        script: (_index, context) => {
          if (isSummaryRequest(context.messages)) return asst([{ type: 'text', text: SUMMARY_TEXT }]);
          return replyOverThreshold('连续压缩答复。');
        },
      });
      const driver = createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: runtime.runtime,
        compactionSettings: COMPACTION,
        sessionDir: location.sessionDir,
        sessionId: location.piSessionId,
        reuseConversation: true,
      });
      let messages: AgentMessage[] = seedHistory();
      for (let turn = 0; turn < 3; turn += 1) {
        // 每轮输入足够大，保证压缩后下一轮再次越过阈值（连续压缩）。
        const prompt = `第 ${turn} 轮问题。${'x'.repeat(20_000)}`;
        const result = await driver.run(runInput([...messages, user(prompt, 600 + turn)]));
        expect(result.text).toBe('连续压缩答复。');
        expect(hasSummary(result.messages), `第 ${turn} 轮压缩摘要仍在`).toBe(true);
        messages = result.messages;
      }
      driver.close?.();

      const written = archiveEvents(warn).filter((event) => event['event'] === 'session_archive_written');
      expect(written.length).toBeGreaterThanOrEqual(2);
      const files = readdirSync(location.sessionDir).filter((name) => name.endsWith('.jsonl'));
      const filePath = path.join(location.sessionDir, files[0] as string);
      const entries = parsedLines(filePath);
      expect(entries[0]?.['type']).toBe('session');
      expect(entries.filter((entry) => entry['type'] === 'compaction')).toHaveLength(1);
      expect(entries.at(-1)?.['type']).toBe('compaction');
      expect(entries.length).toBeLessThan(seedHistory().length + 2);

      const reopened = SessionManager.open(filePath, location.sessionDir, '/tmp/archive-cwd');
      expect(reopened.buildContextEntries()[0]?.type).toBe('compaction');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SessionPersistence 路径解析兼容：归档后的文件仍可被 resolve 校验并 resume', () => {
  it('原地重写不换文件名、header id 不变，resolve 仍指向同一份文件', () => {
    const root = tempRoot();
    const persistence = new SessionPersistence({ rootDir: root });
    const before = persistence.resolve('alice', 'conv-archive');
    expect(before.resumeSessionFile).toBeUndefined();

    const manager = SessionManager.create('/tmp/archive-cwd', before.sessionDir, { id: before.piSessionId });
    for (let index = 0; index < 4; index += 1) {
      manager.appendMessage(sessionMessage(`归档前消息 ${index}`, index + 1));
    }
    const last = manager.getBranch().at(-1);
    if (last === undefined) throw new Error('（测试）缺少条目');
    manager.appendCompaction(SUMMARY_TEXT, last.id, 1_000);
    const filePath = manager.getSessionFile() as string;

    expect(archiveCompactedSessionFile(filePath).archived).toBe(true);
    const after = persistence.resolve('alice', 'conv-archive');
    expect(after.resumeSessionFile).toBe(filePath);
    expect(after.piSessionId).toBe(before.piSessionId);
    const context = SessionManager.open(filePath, after.sessionDir, '/tmp/archive-cwd').buildContextEntries();
    expect(context[0]?.type).toBe('compaction');
  });
});
