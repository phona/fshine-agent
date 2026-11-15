#!/usr/bin/env node
/**
 * 阶段 B · G2 确定性故障注入（零真实模型；仓内假 stream）。
 * 预注册：.runtime/pi152-stageB/prereg.md §2.2。
 *
 * 注入项：
 *   T-length   阈值压缩（已完成回合越阈）→ 摘要 stopReason=length
 *   T-empty    阈值压缩 → 摘要 stopReason=stop 且正文为空
 *   T-ws       阈值压缩 → 摘要 stopReason=stop 且正文全空白
 *   O-length   溢出恢复（error 回合）→ 摘要 stopReason=length
 *   O-empty    溢出恢复 → 摘要 stopReason=stop 且正文为空
 *   D-dup      溢出恢复后重试是否重复执行非幂等工具（产品驱动）
 *
 * 只用公开导出（createAgentSession / SessionManager / SettingsManager）与仓内夹具。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '../../../packages/contracts/src/runtime';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(REPO, '.runtime', 'pi152-stageB', 'injection');
const W = 32_768;
const RESERVE = 4_096;
const KEEP_RECENT = 2_048;
const COMPACTION = { enabled: true, reserveTokens: RESERVE, keepRecentTokens: KEEP_RECENT };
const FACT = '项目代号是「蓝鲸-42」';

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
const overThresholdReply = (text: string) => asst([{ type: 'text', text }], 'stop', undefined, W - RESERVE + 2_000);
const overflow = () => asst([], 'error', 'maximum context length exceeded: prompt is too long');
const lengthSummary = () => asst([{ type: 'text', text: '## Goal\n1. 记住' }], 'length');
const emptySummary = () => asst([{ type: 'text', text: '' }], 'stop');
const wsSummary = () => asst([{ type: 'text', text: '  \n\t ' }], 'stop');
const okSummary = () => asst([{ type: 'text', text: '摘要：用户要求记住项目代号「蓝鲸-42」。' }], 'stop');
const user = (text: string, ts = 1) => ({ role: 'user', content: text, timestamp: ts }) as unknown as AgentMessage;

const filler = (n: number) => `背景 ${n}：` + '把这件事拆成可执行的小步，每步只解决一个问题，做完记录事实。'.repeat(60);
const HISTORY_TURNS = 8;
const historyPrompt = (i: number) => (i === 0 ? `${FACT}，请记住。` : `历史问题 ${i}：${filler(i)}`);

const isSummaryRequest = (messages: readonly unknown[]): boolean => {
  const body = JSON.stringify(messages);
  return body.includes('<conversation>') || body.includes('# Conversation');
};

interface Entry { type?: string; summary?: string; message?: { role?: string; content?: unknown }; [k: string]: unknown }
function readEntries(file: string): Entry[] {
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: { type?: string; text?: string }) => b.type === 'text' ? b.text ?? '' : `<${b.type ?? '?'}>`).join('');
  }
  return '';
}

interface CaseReport {
  name: string;
  finalText: string;
  events: Array<Record<string, unknown>>;
  entryTypes: string[];
  compactionEntries: Array<{ summary: string; summaryChars: number }>;
  factInMainRequests: Array<{ call: number; hasFact: boolean }>;
  summaryRequests: number;
  execs: Array<{ tool: string; args: unknown }>;
  warnings: string[];
  entriesAfterFailure: { messages: number; contextEdits: number };
}

function collectEvents(events: Array<{ type?: string }>): Array<Record<string, unknown>> {
  return events
    .filter((e) => ['compaction_start', 'compaction_end', 'session_compact_failed', 'auto_retry_start',
      'auto_retry_end', 'summarization_retry_scheduled'].includes(e.type ?? ''))
    .map((e) => {
      const r = e as Record<string, unknown>;
      const result = r.result as { summary?: string } | undefined;
      return {
        type: r.type, reason: r.reason, willRetry: r.willRetry, aborted: r.aborted,
        errorMessage: r.errorMessage,
        summaryChars: result?.summary === undefined ? undefined : result.summary.length,
        summary: result?.summary,
      };
    });
}

interface Script {
  /** 第 n 个主请求（0-based，不含摘要）的响应；n<HISTORY_TURNS 为历史回合。 */
  main: (n: number) => AgentMessage;
  summary: () => AgentMessage;
}

async function rawCase(name: string, script: Script, finalPrompt: string): Promise<CaseReport> {
  const dir = path.join(OUT, `raw-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const mainRequests: Array<{ call: number; hasFact: boolean }> = [];
  let mainCount = 0;
  let summaryRequests = 0;
  const rt = await createScriptedModelRuntime({
    contextWindow: W, maxTokens: 2_048,
    script: (_i, ctx) => {
      if (isSummaryRequest(ctx.messages)) {
        summaryRequests += 1;
        return script.summary();
      }
      const call = mainCount;
      mainCount += 1;
      mainRequests.push({ call, hasFact: JSON.stringify(ctx.messages).includes(FACT) });
      return script.main(call);
    },
  });
  const events: Array<{ type?: string }> = [];
  const sessionManager = SessionManager.create(path.join(dir, 'cwd'), path.join(dir, 'sessions'));
  const { session } = await createAgentSession({
    cwd: path.join(dir, 'cwd'),
    agentDir: path.join(dir, 'agent'),
    model: rt.runtime.getModel('llm', rt.modelId)!,
    modelRuntime: rt.runtime,
    thinkingLevel: 'off',
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: COMPACTION }),
  });
  session.subscribe((e) => events.push(e as { type?: string }));
  for (let i = 0; i < HISTORY_TURNS; i += 1) {
    await session.prompt(historyPrompt(i), { expandPromptTemplates: false });
  }
  await session.prompt(finalPrompt, { expandPromptTemplates: false });
  await session.prompt('请继续：第二个问题是什么？', { expandPromptTemplates: false });
  const msgs = session.messages as readonly AgentMessage[];
  const finalAssistant = [...msgs].reverse().find((m) => (m as { role?: string }).role === 'assistant');
  const finalText = contentText((finalAssistant as { content?: unknown } | undefined)?.content);
  const file = session.sessionFile ?? '';
  session.dispose();
  const entries = readEntries(file);
  return {
    name,
    finalText,
    events: collectEvents(events),
    entryTypes: entries.map((e) => e.type ?? '?'),
    compactionEntries: entries.filter((e) => e.type === 'compaction')
      .map((e) => ({ summary: String(e.summary), summaryChars: String(e.summary).length })),
    factInMainRequests: mainRequests,
    summaryRequests,
    execs: [],
    warnings: [],
    entriesAfterFailure: {
      messages: entries.filter((e) => e.type === 'message').length,
      contextEdits: entries.filter((e) => e.type === 'context_edit').length,
    },
  };
}

async function driverCase(name: string, script: Script, finalPrompt: string, withTool: boolean): Promise<CaseReport> {
  const dir = path.join(OUT, `driver-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const mainRequests: Array<{ call: number; hasFact: boolean }> = [];
  let mainCount = 0;
  let summaryRequests = 0;
  const rt = await createScriptedModelRuntime({
    contextWindow: W, maxTokens: 2_048,
    script: (_i, ctx) => {
      if (isSummaryRequest(ctx.messages)) {
        summaryRequests += 1;
        return script.summary();
      }
      const call = mainCount;
      mainCount += 1;
      mainRequests.push({ call, hasFact: JSON.stringify(ctx.messages).includes(FACT) });
      return script.main(call);
    },
  });
  const driver = createPiTurnDriver({
    env: { LLM_MODEL: 'test-model' }, modelRuntime: rt.runtime,
    compactionSettings: COMPACTION, reuseConversation: true,
    sessionDir: path.join(dir, 'sessions'), workspaceDir: path.join(dir, 'cwd'),
  });
  const tool: DiscoveredTool = {
    name: 'bridge_exec', description: '执行层桥接',
    inputSchema: { type: 'object', properties: { operation: { type: 'string' }, args: { type: 'object' } } },
  };
  const execs: Array<{ tool: string; args: unknown }> = [];
  const exec: TurnDriverInput['exec'] = async (n, args) => {
    execs.push({ tool: n, args });
    return { ok: true, seq: execs.length };
  };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let messages: AgentMessage[] = [];
  let text = '';
  try {
    for (let i = 0; i < HISTORY_TURNS; i += 1) {
      messages = [...messages, user(historyPrompt(i), i + 1)];
      const r = await driver.run({
        systemPrompt: '你是业务助手。', tools: withTool ? [tool] : [],
        messages, onStep: () => {}, exec, deadline: Date.now() + 120_000,
      });
      messages = [...r.messages];
    }
    messages = [...messages, user(finalPrompt, 99)];
    let r = await driver.run({
      systemPrompt: '你是业务助手。', tools: withTool ? [tool] : [],
      messages, onStep: () => {}, exec, deadline: Date.now() + 120_000,
    });
    text = r.text;
    messages = [...r.messages, user('请继续：第二个问题是什么？', 100)];
    r = await driver.run({
      systemPrompt: '你是业务助手。', tools: withTool ? [tool] : [],
      messages, onStep: () => {}, exec, deadline: Date.now() + 120_000,
    });
    text = r.text;
  } finally {
    console.warn = origWarn;
  }
  const info = driver.sessionInfo?.();
  const entries = readEntries(info?.sessionFile ?? '');
  driver.close?.();
  return {
    name,
    finalText: text,
    events: [],
    entryTypes: entries.map((e) => e.type ?? '?'),
    compactionEntries: entries.filter((e) => e.type === 'compaction')
      .map((e) => ({ summary: String(e.summary), summaryChars: String(e.summary).length })),
    factInMainRequests: mainRequests,
    summaryRequests,
    execs,
    warnings: warnings.filter((w) => w.startsWith('{')),
    entriesAfterFailure: {
      messages: entries.filter((e) => e.type === 'message').length,
      contextEdits: entries.filter((e) => e.type === 'context_edit').length,
    },
  };
}

/** 历史回合一律正常短回复；阈值触发走「已完成回合越阈」（threshold）。 */
const threshold = (summary: () => AgentMessage): Script => ({
  main: (n) => (n < HISTORY_TURNS ? textReply(`历史答复 ${n}。`) : overThresholdReply('本轮答复。')),
  summary,
});
/** 溢出触发走「最后回合 error 越窗」（overflow + willRetry）。 */
const overflowScript = (summary: () => AgentMessage): Script => ({
  main: (n) => (n < HISTORY_TURNS ? textReply(`历史答复 ${n}。`) : overflow()),
  summary,
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  const cases: CaseReport[] = [];
  const finalPrompt = '现在回答我：我之前让你记住的项目代号是什么？';

  cases.push(await rawCase('T-length', threshold(lengthSummary), finalPrompt));
  cases.push(await rawCase('T-empty', threshold(emptySummary), finalPrompt));
  cases.push(await rawCase('T-ws', threshold(wsSummary), finalPrompt));
  cases.push(await rawCase('O-length', overflowScript(lengthSummary), finalPrompt));
  cases.push(await rawCase('O-empty', overflowScript(emptySummary), finalPrompt));

  // 产品驱动层：用户看到什么 + 非幂等工具是否重复执行
  const okThreshold: Script = {
    main: (n) => (n < HISTORY_TURNS ? textReply(`历史答复 ${n}。`) : textReply('本轮答复。')),
    summary: okSummary,
  };
  cases.push(await driverCase('D-ok', okThreshold, finalPrompt, false));
  cases.push(await driverCase('D-threshold-length', threshold(lengthSummary), finalPrompt, false));
  cases.push(await driverCase('D-overflow-length', overflowScript(lengthSummary), finalPrompt, false));
  cases.push(await driverCase('D-overflow-empty', overflowScript(emptySummary), finalPrompt, false));

  const dupScript: Script = {
    main: (n) => {
      if (n < HISTORY_TURNS) return textReply(`历史答复 ${n}。`);
      if (n === HISTORY_TURNS) return asst([{ type: 'toolCall', id: 'call_1', name: 'bridge_exec', arguments: { operation: 'create_record', args: { id: 'rec-X' } } }], 'toolUse');
      if (n === HISTORY_TURNS + 1) return overflow();
      if (n === HISTORY_TURNS + 2) return asst([{ type: 'toolCall', id: 'call_2', name: 'bridge_exec', arguments: { operation: 'create_record', args: { id: 'rec-X' } } }], 'toolUse');
      return textReply('已完成。');
    },
    summary: okSummary,
  };
  cases.push(await driverCase('D-duplicate', dupScript, '请创建一条记录 rec-X。', true));

  process.stdout.write(JSON.stringify(cases, null, 2));
}

await main();
