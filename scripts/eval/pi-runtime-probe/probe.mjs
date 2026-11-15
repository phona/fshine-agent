#!/usr/bin/env node
/**
 * Pi Runtime 复用实验探测（arch/pi-upgrade，pi-coding-agent 1.5.2）。
 *
 * 只用公开导出：
 *   - @earendil-works/pi-coding-agent root: createAgentSession / SessionManager
 *   - @earendil-works/pi-ai root: createAssistantMessageEventStream
 *
 * 验证：headless AgentSession 构建、customTools 桥接工具可调、多轮 + subscribe、
 * dispose 后经 SessionManager 恢复上下文、不同 sessionDir 隔离、RSS 粗测。
 *
 * 运行：TMPDIR=/home/tao/.tmp node scripts/eval/pi-runtime-probe/probe.mjs
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const RSS_START = process.memoryUsage().rss;
const BASE = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pi-runtime-probe-'));
const CWD = join(BASE, 'cwd');
const AGENT_DIR = join(BASE, 'agent');
const S1_DIR = join(BASE, 'sessions-a');
const S2_DIR = join(BASE, 'sessions-b');
for (const d of [CWD, AGENT_DIR, S1_DIR, S2_DIR]) mkdirSync(d, { recursive: true });

const MODEL = {
  id: 'probe-model',
  name: 'probe-model',
  api: 'openai-completions',
  provider: 'probe',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 1024,
};

const usage = () => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const textMessage = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: usage(),
  stopReason: 'stop',
  timestamp: Date.now(),
});

const toolCallMessage = (name, args, id) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: usage(),
  stopReason: 'toolUse',
  timestamp: Date.now(),
});

/**
 * 按脚本返回响应。每个 script(i, context) 返回 assistant message。
 * 记录收到的 context，供「恢复后模型能看到历史」的断言。
 */
function makeFakeRuntime(script) {
  const seenContexts = [];
  let calls = 0;
  return {
    seenContexts,
    get calls() { return calls; },
    // Models 面（AgentSession 在 prompt 校验 / 恢复时用到的同步方法）
    getModel: (provider, id) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
    getPhysicalModel: (provider, id) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: 'probe-key' }, env: {} }),
    getAvailableSnapshot: () => [MODEL],
    getModels: () => [MODEL],
    getProviders: () => [],
    getError: () => undefined,
    getCompatibilityRequestConfig: () => ({}),
    resolveModel: async () => ({ model: MODEL, thinkingLevel: 'off' }),
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerNativeProvider: () => {},
    registerVirtualModel: () => {},
    unregisterVirtualModel: () => {},
    // 唯一的模型入口：由脚本决定这一轮返回什么
    streamSimple: (model, context) => {
      const index = calls;
      calls += 1;
      seenContexts.push(context);
      const message = script(index, context);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  };
}

function makeBridgeTool(invocations) {
  return {
    name: 'bridge_exec',
    label: 'Bridge Exec',
    description: 'Execution Contract bridge: run one structured capability request.',
    parameters: {
      type: 'object',
      properties: { capability: { type: 'string' }, args: { type: 'object' } },
      required: ['capability'],
      additionalProperties: true,
    },
    execute: async (toolCallId, params) => {
      invocations.push({ toolCallId, params });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, capability: params.capability }) }],
        details: {},
      };
    },
  };
}

const listeners = [];
function record(session, bucket) {
  const unsubscribe = session.subscribe((event) => bucket.push(event));
  listeners.push(unsubscribe);
  return unsubscribe;
}

const results = {};

try {
  // ---------- ① 工具暴露：noTools:"all" / noTools:"builtin" / tools:[ours] ----------
  const exposure = {};
  for (const [label, opts] of [
    ['noTools=all', { noTools: 'all' }],
    ['noTools=builtin', { noTools: 'builtin' }],
    ['tools=[ours]', { tools: ['bridge_exec'] }],
  ]) {
    const dir = mkdtempSync(join(BASE, `expose-${label.replace(/[^a-z]/gi, '')}-`));
    const sessionManager = SessionManager.create(CWD, dir);
    const runtime = makeFakeRuntime(() => textMessage('never'));
    const invocations = [];
    const { session } = await createAgentSession({
      cwd: CWD,
      agentDir: AGENT_DIR,
      model: MODEL,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      sessionManager,
      customTools: [makeBridgeTool(invocations)],
      ...opts,
    });
    exposure[label] = session.getActiveToolNames();
    session.dispose();
  }
  results.exposure = exposure;

  // ---------- ② headless 多轮 + subscribe + 桥接工具可调用 ----------
  const events = [];
  const invocations = [];
  const runtime = makeFakeRuntime((index) => (
    index === 0
      ? toolCallMessage('bridge_exec', { capability: 'demo.read' }, 'call-1')
      : textMessage('final-answer')
  ));
  const sessionManager = SessionManager.create(CWD, S1_DIR);
  const created = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    model: MODEL,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    sessionManager,
    customTools: [makeBridgeTool(invocations)],
    tools: ['bridge_exec'],
  });
  const session = created.session;
  record(session, events);

  const activeBefore = session.getActiveToolNames();
  const systemPrompt = session.systemPrompt;
  await session.prompt('hello-one');
  await session.prompt('hello-two');

  const toolStarts = events.filter((e) => e.type === 'tool_execution_start').map((e) => e.toolName);
  const toolEnds = events.filter((e) => e.type === 'tool_execution_end').map((e) => ({
    name: e.toolName,
    content: e.result?.content,
  }));
  results.headless = {
    activeBefore,
    builtinsActive: ['read', 'bash', 'edit', 'write'].filter((n) => activeBefore.includes(n)),
    systemPromptMentionsBuiltinTools: /(^|\n)\s*[-*]?\s*(read|bash|edit|write)\b/.test(systemPrompt),
    systemPromptHasBridge: systemPrompt.includes('bridge_exec'),
    toolInvocations: invocations,
    toolStarts,
    toolEnds,
    assistantTexts: session.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')),
    eventTypes: [...new Set(events.map((e) => e.type))],
    streamCalls: runtime.calls,
    messages: session.messages.length,
    sessionFile: sessionManager.getSessionFile(),
  };

  // ---------- ③ dispose → SessionManager.open 恢复上下文 ----------
  const sessionFile = sessionManager.getSessionFile();
  session.dispose();
  const resumedManager = SessionManager.open(sessionFile, S1_DIR, CWD);
  const resumedRuntime = makeFakeRuntime(() => textMessage('resumed-reply'));
  const resumed = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    model: MODEL,
    modelRuntime: resumedRuntime,
    thinkingLevel: 'off',
    sessionManager: resumedManager,
    customTools: [makeBridgeTool([])],
    tools: ['bridge_exec'],
  });
  const restoredMessages = resumed.session.messages.map((m) => ({
    role: m.role,
    text: typeof m.content === 'string'
      ? m.content
      : m.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
  }));
  await resumed.session.prompt('hello-three');
  const resumedContextText = JSON.stringify(resumedRuntime.seenContexts[0]?.messages ?? []);
  results.persist = {
    sessionFile,
    fileExistsAfterDispose: (await import('node:fs')).existsSync(sessionFile),
    restoredMessageCount: restoredMessages.length,
    restoredConversation: restoredMessages,
    resumedPromptSawHistory: resumedContextText.includes('hello-one') && resumedContextText.includes('final-answer'),
    resumedMessages: resumed.session.messages.length,
    resumedReply: resumed.session.messages
      .filter((m) => m.role === 'assistant')
      .at(-1)?.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
  };
  resumed.session.dispose();

  // ---------- 不同 sessionDir 隔离 ----------
  const otherRuntime = makeFakeRuntime(() => textMessage('other-session'));
  const otherManager = SessionManager.create(CWD, S2_DIR);
  const other = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    model: MODEL,
    modelRuntime: otherRuntime,
    thinkingLevel: 'off',
    sessionManager: otherManager,
    customTools: [makeBridgeTool([])],
    tools: ['bridge_exec'],
  });
  const otherBefore = other.session.messages.length;
  await other.session.prompt('only-in-other');
  const otherMessages = other.session.messages.map((m) => (typeof m.content === 'string'
    ? m.content
    : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')));
  other.session.dispose();

  const listA = await SessionManager.list(CWD, S1_DIR);
  const listB = await SessionManager.list(CWD, S2_DIR);
  results.isolation = {
    dirA: S1_DIR,
    dirB: S2_DIR,
    fileA: sessionFile,
    fileB: otherManager.getSessionFile(),
    filesDiffer: sessionFile !== otherManager.getSessionFile(),
    otherSessionStartedEmpty: otherBefore === 0,
    otherMessages,
    listACount: listA.length,
    listBCount: listB.length,
    resumedSeesOtherSession: JSON.stringify(resumedManager.buildSessionContext().messages).includes('only-in-other'),
  };

  // ---------- ②b 不 duck-type：公开 ModelRuntime.create + registerProvider(streamSimple) ----------
  const publicRuntime = await ModelRuntime.create({
    authPath: join(BASE, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const publicSeen = [];
  publicRuntime.registerProvider('probe', {
    name: 'Probe',
    api: 'openai-completions',
    apiKey: 'probe-key',
    models: [{
      id: MODEL.id,
      name: MODEL.name,
      api: MODEL.api,
      baseUrl: MODEL.baseUrl,
      input: MODEL.input,
      cost: MODEL.cost,
      reasoning: MODEL.reasoning,
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
    }],
    streamSimple: (model, context) => {
      publicSeen.push(context);
      const message = textMessage('public-runtime-reply');
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
  const publicDir = join(BASE, 'sessions-public');
  mkdirSync(publicDir, { recursive: true });
  const publicSession = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    model: publicRuntime.getModel('probe', MODEL.id),
    modelRuntime: publicRuntime,
    thinkingLevel: 'off',
    sessionManager: SessionManager.create(CWD, publicDir),
    customTools: [makeBridgeTool([])],
    tools: ['bridge_exec'],
  });
  await publicSession.session.prompt('public-hello');
  results.publicModelRuntime = {
    used: publicSeen.length > 0,
    reply: publicSession.session.messages
      .filter((m) => m.role === 'assistant')
      .at(-1)?.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
    hasConfiguredAuth: publicRuntime.hasConfiguredAuth('probe'),
    activeTools: publicSession.session.getActiveToolNames(),
  };
  publicSession.session.dispose();

  // ---------- ④ RSS 粗测 ----------
  results.measure = {
    rssStartBytes: RSS_START,
    rssNowBytes: process.memoryUsage().rss,
    maxRssKb: process.resourceUsage().maxRSS,
    node: process.version,
  };
} catch (error) {
  results.error = { name: error?.name, message: error?.message, stack: error?.stack };
} finally {
  for (const unsubscribe of listeners) {
    try { unsubscribe(); } catch { /* 已 dispose 的会话取消订阅可能抛错，忽略 */ }
  }
  console.log(JSON.stringify(results, null, 2));
  rmSync(BASE, { recursive: true, force: true });
}

if (results.error) process.exitCode = 1;
