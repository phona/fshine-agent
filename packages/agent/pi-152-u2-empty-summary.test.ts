/**
 * U2 补丁守卫（随 `patches/@earendil-works+pi-coding-agent+1.5.2.patch` 一起删除）。
 *
 * 缺陷（原证据 `.runtime/pi152-stageB/injection/report4.json` 的 T-empty / T-ws）：
 * Pi 1.5.2 的 `getSummarizationFailure` 只拒 `stopReason=error|length`，不看正文。
 * 阈值压缩时摘要返回 `stopReason=stop` + 空正文（或全空白 `"  \n\t "`）仍算成功：
 * `compaction_end(completed)`、`summary:""` 落成 compaction 检查点、下一回合历史事实消失。
 *
 * 修复（三个边界，两处公共判定，不复制逻辑）：
 *   ① 普通摘要 `generateSummaryWithUsage`（compaction.js:533 调 `getSummarizationFailure`）；
 *   ② Turn Prefix Summary `generateTurnPrefixSummary`（compaction.js:737 同一判定）；
 *   ③ 最终 Compaction Entry 提交边界 `SessionManager.appendCompaction`
 *      （session-manager.js:892，会话库写入前拒绝空摘要——即使上游漏判也不落无效检查点）。
 *
 * 反向绊线：把任一处判空删掉，本文件的对应用例立即变红（实测记录见
 * `docs/product/pi-152-dependency-patches.md` U2 节）。
 * 全部确定性：脚本化 provider，零网络、零真实模型。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

const WINDOW = 32_768;
const RESERVE = 4_096;
const KEEP_RECENT = 2_048;
const COMPACTION = { enabled: true, reserveTokens: RESERVE, keepRecentTokens: KEEP_RECENT };
const FACT = '项目代号是「蓝鲸-42」';
const HISTORY_TURNS = 8;
const FOLLOW_UP = '请继续：第二个问题是什么？';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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
const overThresholdReply = (text: string) => asst([{ type: 'text', text }], 'stop', undefined, WINDOW - RESERVE + 2_000);
const emptySummary = () => asst([{ type: 'text', text: '' }], 'stop');
const whitespaceSummary = () => asst([{ type: 'text', text: '  \n\t ' }], 'stop');
const okSummary = () => asst([{ type: 'text', text: '摘要：用户要求记住项目代号「蓝鲸-42」。' }], 'stop');
const user = (text: string, ts = 1) => ({ role: 'user', content: text, timestamp: ts }) as unknown as AgentMessage;

const filler = (n: number) =>
  `背景 ${n}：` + '把这件事拆成可执行的小步，每步只解决一个问题，做完记录事实。'.repeat(60);
const historyPrompt = (i: number) => (i === 0 ? `${FACT}，请记住。` : `历史问题 ${i}：${filler(i)}`);

const isHistorySummaryRequest = (messages: readonly unknown[]): boolean =>
  JSON.stringify(messages).includes('<conversation>');
const isTurnPrefixSummaryRequest = (messages: readonly unknown[]): boolean =>
  JSON.stringify(messages).includes('# Conversation');

interface FileEntry { type?: string; summary?: string; [k: string]: unknown }
function readEntries(file: string): FileEntry[] {
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FileEntry);
  } catch { return []; }
}

interface TurnFlowResult {
  events: Array<Record<string, unknown>>;
  entries: FileEntry[];
  /** 每个主请求（不含摘要请求）是否携带历史事实。 */
  mainRequests: Array<{ hasFact: boolean }>;
  summaryRequests: number;
  turnPrefixRequests: number;
  sessionFile: string;
  sessionsDir: string;
  cwd: string;
}

/**
 * 阈值压缩流程：8 个短历史回合 → 第 9 回合越阈（`totalTokens = 窗口 − reserve + 2000`）
 * → 同回合内触发 `_checkCompaction` → 一次追加跟进提示，观察压缩后上下文是否还带事实。
 */
async function runThresholdFlow(options: {
  summary: AgentMessage;
  turnPrefixSummary?: AgentMessage;
  finalReply: AgentMessage;
}): Promise<TurnFlowResult> {
  const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'fshine-u2-'));
  roots.push(root);
  const cwd = path.join(root, 'cwd');
  const sessionsDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const mainRequests: Array<{ hasFact: boolean }> = [];
  let summaryRequests = 0;
  let turnPrefixRequests = 0;
  const rt = await createScriptedModelRuntime({
    contextWindow: WINDOW,
    maxTokens: 2_048,
    script: (_i, ctx) => {
      if (isTurnPrefixSummaryRequest(ctx.messages)) {
        turnPrefixRequests += 1;
        summaryRequests += 1;
        return options.turnPrefixSummary ?? options.summary;
      }
      if (isHistorySummaryRequest(ctx.messages)) {
        summaryRequests += 1;
        return options.summary;
      }
      mainRequests.push({ hasFact: JSON.stringify(ctx.messages).includes(FACT) });
      const call = mainRequests.length - 1;
      return call < HISTORY_TURNS ? textReply(`历史答复 ${call}。`) : options.finalReply;
    },
  });
  const events: Array<{ type?: string }> = [];
  const sessionManager = SessionManager.create(cwd, sessionsDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir: path.join(root, 'agent'),
    model: rt.runtime.getModel('llm', rt.modelId)!,
    modelRuntime: rt.runtime,
    thinkingLevel: 'off',
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: COMPACTION }),
  });
  session.subscribe((e) => events.push(e as { type?: string }));
  try {
    for (let i = 0; i < HISTORY_TURNS; i += 1) {
      await session.prompt(historyPrompt(i), { expandPromptTemplates: false });
    }
    await session.prompt('现在回答我：我之前让你记住的项目代号是什么？', { expandPromptTemplates: false });
    await session.prompt(FOLLOW_UP, { expandPromptTemplates: false });
  } finally {
    session.dispose();
  }
  const sessionFile = session.sessionFile ?? '';
  const entries = readEntries(sessionFile);
  return {
    events: events
      .filter((e) => e.type === 'compaction_start' || e.type === 'compaction_end')
      .map((e) => {
        const record = e as Record<string, unknown>;
        const result = record.result as { summary?: string } | undefined;
        return {
          type: record.type, reason: record.reason, aborted: record.aborted,
          errorMessage: record.errorMessage,
          summaryChars: result?.summary === undefined ? undefined : result.summary.length,
        };
      }),
    entries,
    mainRequests,
    summaryRequests,
    turnPrefixRequests,
    sessionFile,
    sessionsDir,
    cwd,
  };
}

const compactionEnds = (r: TurnFlowResult) =>
  r.events.filter((e) => e.type === 'compaction_end') as Array<Record<string, unknown>>;
const compactionEntries = (r: TurnFlowResult) => r.entries.filter((e) => e.type === 'compaction');

/** 会话文件重开：历史消息仍在、且没有落过 compaction 检查点。 */
function assertHistoryRecoverable(r: TurnFlowResult): void {
  const reopened = SessionManager.open(r.sessionFile, r.sessionsDir);
  const messages = reopened.buildSessionProjection().messages;
  expect(messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(messages)).toContain(FACT);
  expect(reopened.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
}

/** 「下次打开能继续」：从会话文件重开一个会话再发一轮，请求里仍带历史事实。
 *  重开会话关掉压缩，避免 prompt 前的阈值压缩用新摘要掩盖「文件里的原历史是否完好」。 */
async function assertSessionContinuesAfterReopen(r: TurnFlowResult): Promise<void> {
  const reopened = SessionManager.open(r.sessionFile, r.sessionsDir);
  let sawFact = false;
  const rt = await createScriptedModelRuntime({
    contextWindow: WINDOW,
    maxTokens: 2_048,
    script: (_i, ctx) => {
      sawFact = JSON.stringify(ctx.messages).includes(FACT);
      return textReply('继续作答。');
    },
  });
  const { session } = await createAgentSession({
    cwd: r.cwd,
    agentDir: path.join(path.dirname(r.cwd), 'agent'),
    model: rt.runtime.getModel('llm', rt.modelId)!,
    modelRuntime: rt.runtime,
    thinkingLevel: 'off',
    sessionManager: reopened,
    settingsManager: SettingsManager.inMemory({ compaction: { ...COMPACTION, enabled: false } }),
  });
  try {
    await session.prompt('我们继续：刚才的项目代号是什么？', { expandPromptTemplates: false });
  } finally {
    session.dispose();
  }
  expect(sawFact).toBe(true);
}

describe('pi-coding-agent 1.5.2 U2：空摘要不得成为压缩检查点', () => {
  it('边界①：阈值压缩摘要 stop+空正文 → 压缩失败、不落检查点、事实仍在上下文', async () => {
    const result = await runThresholdFlow({ summary: emptySummary(), finalReply: overThresholdReply('本轮答复。') });

    expect(result.summaryRequests).toBeGreaterThan(0);
    const failures = compactionEnds(result).filter((e) => typeof e.errorMessage === 'string');
    expect(failures.length).toBeGreaterThan(0);
    expect(String(failures[0]!.errorMessage)).toMatch(/summarization|summary/i);
    // 修复前：compaction_end 无 errorMessage 且 summaryChars=0；修复后：显式失败。
    expect(compactionEnds(result).some((e) => e.summaryChars === 0)).toBe(false);
    expect(compactionEntries(result)).toHaveLength(0);
    // 压缩失败后同一会话继续说话，历史事实仍随请求发出（修复前最后一次主请求 hasFact=false）。
    expect(result.mainRequests.at(-1)!.hasFact).toBe(true);
    assertHistoryRecoverable(result);
    await assertSessionContinuesAfterReopen(result);
  });

  it('边界①：摘要 stop+全空白 `"  \\n\\t "` 同样拒绝（判空按 trim 后长度）', async () => {
    const result = await runThresholdFlow({ summary: whitespaceSummary(), finalReply: overThresholdReply('本轮答复。') });

    const failures = compactionEnds(result).filter((e) => typeof e.errorMessage === 'string');
    expect(failures.length).toBeGreaterThan(0);
    expect(compactionEnds(result).some((e) => e.summaryChars === 5)).toBe(false);
    expect(compactionEntries(result)).toHaveLength(0);
    expect(result.mainRequests.at(-1)!.hasFact).toBe(true);
    assertHistoryRecoverable(result);
  });

  it('边界②：Turn Prefix Summary 空正文 → 整次压缩失败（历史摘要有效也不落点）', async () => {
    // 末回合答复足够长（> keepRecentTokens），切点落在 assistant 项 → isSplitTurn=true，
    // 摘要拆成「历史摘要 + 分段轮次摘要」两次请求。
    const longReply = overThresholdReply('本轮答复。' + '细节说明：把事实记录下来，方便下一回合继续。'.repeat(600));
    const result = await runThresholdFlow({
      summary: okSummary(), turnPrefixSummary: emptySummary(), finalReply: longReply,
    });

    expect(result.turnPrefixRequests).toBeGreaterThan(0);
    const failures = compactionEnds(result).filter((e) => typeof e.errorMessage === 'string');
    expect(failures.some((e) => /Turn prefix summarization/i.test(String(e.errorMessage)))).toBe(true);
    expect(compactionEntries(result)).toHaveLength(0);
    expect(result.mainRequests.at(-1)!.hasFact).toBe(true);
    assertHistoryRecoverable(result);
  });

  it('正向对照：同一分段轮次流程换成有效摘要 → 恰好落一条 compaction 检查点', async () => {
    const longReply = overThresholdReply('本轮答复。' + '细节说明：把事实记录下来，方便下一回合继续。'.repeat(600));
    const result = await runThresholdFlow({ summary: okSummary(), finalReply: longReply });

    expect(result.turnPrefixRequests).toBeGreaterThan(0);
    const entries = compactionEntries(result);
    expect(entries).toHaveLength(1);
    expect(String(entries[0]!.summary)).toContain('Turn Context (split turn)');
    expect(String(entries[0]!.summary).trim().length).toBeGreaterThan(0);
  });

  it('边界③：写库边界直接拒绝空/全空白摘要，原有历史仍可恢复', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'fshine-u2-write-'));
    roots.push(root);
    const manager = SessionManager.inMemory(root);
    manager.appendMessage(user(`${FACT}，请记住。`, 1) as never);
    const firstKeptEntryId = manager.getEntries()[0]!.id!;

    for (const blank of ['', '  \n\t ']) {
      expect(() => manager.appendCompaction(blank, firstKeptEntryId, 100, undefined, false, undefined))
        .toThrow(/empty summary/i);
    }
    expect(manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(0);
    // 原有历史未被替换：投影里仍能看到事实，会话可继续。
    expect(JSON.stringify(manager.buildSessionProjection().messages)).toContain(FACT);
    expect(() => manager.appendCompaction('有效摘要：蓝鲸-42。', firstKeptEntryId, 100, undefined, false, undefined))
      .not.toThrow();
    expect(manager.getEntries().filter((e) => e.type === 'compaction')).toHaveLength(1);
  });
});
