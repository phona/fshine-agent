/**
 * 阶段 A 验收：最小 AgentSession 接入（A1–A3，真实 fshine 工具契约 + 脚本化模型，零网络）。
 *
 * A1：公开 API `createAgentSession` 建 headless 会话，多轮 prompt、事件/转录取回复，
 *     dispose 后重开同一 Session，异常退出（SIGKILL）后恢复；
 * A2：customTools + 显式白名单只暴露业务工具，Pi 内置 read/bash/edit/write 不可调用；
 * A3：受控 ResourceLoader 接入 fshine 系统提示，不加载宿主项目文件/默认编码指令/扩展。
 *
 * 无私有 Pi Runtime 逻辑：本文件不建 agent loop、不做压缩、不复制转录。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import {
  READ_SKILL_TOOL_DESCRIPTION,
  READ_SKILL_TOOL_SCHEMA,
  TASK_RUN_TOOL,
  TASK_RUN_TOOL_DESCRIPTION,
  TASK_RUN_TOOL_SCHEMA,
  TASK_CANCEL_TOOL,
  TASK_CANCEL_TOOL_DESCRIPTION,
  TASK_CANCEL_TOOL_SCHEMA,
  TASK_RESULT_TOOL,
  TASK_RESULT_TOOL_DESCRIPTION,
  TASK_RESULT_TOOL_SCHEMA,
  TASK_RESUME_TOOL,
  TASK_RESUME_TOOL_DESCRIPTION,
  TASK_RESUME_TOOL_SCHEMA,
  TASK_STATUS_TOOL,
  TASK_STATUS_TOOL_DESCRIPTION,
  TASK_STATUS_TOOL_SCHEMA,
} from './src/execution-runtime';
import { READ_SKILL_TOOL } from './src/skills';
import { createPiTurnDriver } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.resolve(__dirname, 'fixtures', 'pi-session-crash.ts');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 真实 fshine 工具契约（描述/schema 取自 execution-runtime / skills 的同一常量）。 */
const BUSINESS_TOOLS: Record<string, DiscoveredTool> = {
  [TASK_RUN_TOOL]: { name: TASK_RUN_TOOL, description: TASK_RUN_TOOL_DESCRIPTION, inputSchema: TASK_RUN_TOOL_SCHEMA },
  [TASK_STATUS_TOOL]: { name: TASK_STATUS_TOOL, description: TASK_STATUS_TOOL_DESCRIPTION, inputSchema: TASK_STATUS_TOOL_SCHEMA },
  [TASK_RESULT_TOOL]: { name: TASK_RESULT_TOOL, description: TASK_RESULT_TOOL_DESCRIPTION, inputSchema: TASK_RESULT_TOOL_SCHEMA },
  [TASK_CANCEL_TOOL]: { name: TASK_CANCEL_TOOL, description: TASK_CANCEL_TOOL_DESCRIPTION, inputSchema: TASK_CANCEL_TOOL_SCHEMA },
  [TASK_RESUME_TOOL]: { name: TASK_RESUME_TOOL, description: TASK_RESUME_TOOL_DESCRIPTION, inputSchema: TASK_RESUME_TOOL_SCHEMA },
  [READ_SKILL_TOOL]: { name: READ_SKILL_TOOL, description: READ_SKILL_TOOL_DESCRIPTION, inputSchema: READ_SKILL_TOOL_SCHEMA },
};

function toolsOf(...names: string[]): DiscoveredTool[] {
  return names.map((name) => {
    const tool = BUSINESS_TOOLS[name];
    if (tool === undefined) throw new Error(`未知业务工具：${name}`);
    return tool;
  });
}

function asst(content: unknown[], stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}
const textReply = (text: string): AgentMessage => asst([{ type: 'text', text }]);
const toolCall = (id: string, name: string, args: Record<string, unknown>): AgentMessage =>
  asst([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
const user = (text: string, ts = 1): AgentMessage => ({ role: 'user', content: text, timestamp: ts } as unknown as AgentMessage);

function runInput(messages: AgentMessage[], tools: DiscoveredTool[], exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    systemPrompt: '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。',
    tools,
    messages,
    onStep: () => {},
    exec,
    deadline: Date.now() + 60_000,
  };
}

describe('A1 · 最小 AgentSession（多轮 / dispose 重开 / 异常退出恢复）', () => {
  it('>=2 轮业务对话 + 1 次 Dummy 工具委派（真实 fshine 工具契约）', async () => {
    const scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (index) => {
        if (index === 0) return toolCall('call_task_1', TASK_RUN_TOOL, { task: '查询 W1 账套', progress: '交办查询' });
        if (index === 1) return textReply('已交办 #1，后台执行中。');
        return textReply('W1 账套共 3 条记录。');
      },
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
    });
    const execCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const exec = async (tool: string, args: Record<string, unknown>) => {
      execCalls.push({ tool, args });
      return { taskId: 'task_1', taskNo: 1, accepted: true, notice: '已受理 #1' };
    };
    const tools = toolsOf(TASK_RUN_TOOL, TASK_STATUS_TOOL, TASK_RESULT_TOOL, TASK_CANCEL_TOOL, TASK_RESUME_TOOL, READ_SKILL_TOOL);

    const turn1 = await driver.run(runInput([user('帮我查 W1 账套')], tools, exec));
    expect(turn1.text).toContain('已交办');
    expect(execCalls, 'Dummy 工具委派必须真实经过 customTools 桥接').toEqual([
      { tool: TASK_RUN_TOOL, args: { task: '查询 W1 账套' } },
    ]);

    const turn2 = await driver.run(runInput([user('W1 有多少条？')], tools, exec));
    expect(turn2.text).toContain('3 条');

    // Pi 独占转录：两轮用户消息与工具结果都在同一会话里（宿主没有第二份历史）。
    const transcript = driver.transcript!();
    expect(transcript.filter((m) => (m as { role?: string }).role === 'user').length).toBeGreaterThanOrEqual(2);
    expect((transcript[transcript.length - 1] as { role?: string }).role).toBe('assistant');
    expect(JSON.stringify(transcript)).toContain('已受理 #1');

    const info = driver.sessionInfo!();
    expect([...(info?.activeToolNames ?? [])].sort()).toEqual(Object.keys(BUSINESS_TOOLS).sort());
    driver.close?.();
  });

  it('dispose 后重新打开并继续同一 Session（转录由 SessionManager 恢复）', async () => {
    const sessionDir = tempDir('pi-session-reopen');
    const first = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: () => textReply('第一轮回复：项目代号蓝鲸-42。'),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: first.runtime,
      reuseConversation: true,
      sessionDir,
    });
    await driver.run(runInput([user('记住项目代号：蓝鲸-42')], [], async () => undefined));
    const sessionFile = driver.sessionInfo!()?.sessionFile;
    expect(sessionFile, '显式 sessionDir 时必须落盘').toBeTruthy();
    driver.close?.();

    const second = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: () => textReply('继续：代号是蓝鲸-42。'),
    });
    const resumed = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: second.runtime,
      reuseConversation: true,
      sessionDir,
      resumeSessionFile: sessionFile,
    });
    const turn2 = await resumed.run(runInput([user('项目代号是什么？')], [], async () => undefined));

    expect(turn2.text).toBe('继续：代号是蓝鲸-42。');
    const resumedRequest = JSON.stringify(second.requests()[0]?.messages ?? []);
    expect(resumedRequest, '恢复后的请求必须带上一会话的用户消息').toContain('记住项目代号：蓝鲸-42');
    expect(JSON.stringify(resumed.transcript!())).toContain('第一轮回复：项目代号蓝鲸-42。');
    resumed.close?.();
  });

  it('异常退出（SIGKILL）后可恢复并继续同一 Session', async () => {
    const sessionDir = tempDir('pi-session-crash');
    const marker = path.join(sessionDir, 'marker.json');
    let killed = false;
    try {
      execFileSync(process.execPath, ['--import', 'tsx', FIXTURE, sessionDir, marker], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: process.env.TMPDIR || tmpdir() },
        stdio: 'pipe',
      });
    } catch (error) {
      killed = (error as { signal?: string }).signal === 'SIGKILL';
    }
    expect(killed, '子进程必须以 SIGKILL 退出（未 dispose 的异常退出）').toBe(true);
    const written = JSON.parse(readFileSync(marker, 'utf8')) as { sessionFile?: string; reply?: string };
    expect(written.reply).toContain('崩溃前的第一轮回复');
    expect(written.sessionFile).toBeTruthy();

    const resumedRuntime = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: () => textReply('恢复后的第二轮回复。'),
    });
    const resumed = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: resumedRuntime.runtime,
      reuseConversation: true,
      sessionDir,
      resumeSessionFile: written.sessionFile,
    });
    const result = await resumed.run(runInput([user('崩溃前我问了什么？')], [], async () => undefined));
    expect(result.text).toBe('恢复后的第二轮回复。');
    const request = JSON.stringify(resumedRuntime.requests()[0]?.messages ?? []);
    expect(request, '恢复请求必须带崩溃前已落盘的对话').toContain('崩溃前的第一轮问题');
    expect(request).toContain('崩溃前的第一轮回复。');
    resumed.close?.();
  });
});

describe('A2 · 业务工具桥接（customTools + 显式白名单）', () => {
  it('只激活显式白名单；Pi 内置 read/bash/edit/write 不可被模型调用', async () => {
    const scripted = await createScriptedModelRuntime({
      contextWindow: 40_000,
      script: (index) => (index === 0
        ? toolCall('call_bash', 'bash', { command: 'echo hi' })
        : textReply('内置工具不可用，改用业务工具。')),
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
    });
    const execCalls: string[] = [];
    const tools = toolsOf(TASK_RUN_TOOL, READ_SKILL_TOOL);
    const result = await driver.run(runInput([user('列出当前目录')], tools, async (tool) => {
      execCalls.push(tool);
      return { ok: true };
    }));

    const info = driver.sessionInfo!();
    expect(info?.activeToolNames, '激活集合 = 白名单本身').toEqual([TASK_RUN_TOOL, READ_SKILL_TOOL]);
    for (const builtin of ['read', 'bash', 'edit', 'write']) {
      expect(info?.activeToolNames, `内置工具 ${builtin} 不得激活`).not.toContain(builtin);
    }
    // 真实触发一次内置调用：Pi 返回工具不存在，exec 不被调用。
    const toolResults = result.messages.filter((m) => (m as { role?: string }).role === 'toolResult');
    expect(toolResults.length, '内置调用必须留下可归因的 toolResult').toBeGreaterThan(0);
    expect(JSON.stringify(toolResults)).toContain('Tool bash not found');
    expect(execCalls, '内置工具调用不得触达宿主 exec').toEqual([]);
    expect(result.text).toBe('内置工具不可用，改用业务工具。');
    driver.close?.();
  });

  it('工具出现服从原装配条件（task_run 恒有；task_* 需 runner；read_skill 需登记表）', async () => {
    const cases: Array<{ tools: string[]; expected: string[] }> = [
      { tools: [TASK_RUN_TOOL], expected: [TASK_RUN_TOOL] },
      { tools: [TASK_RUN_TOOL, TASK_STATUS_TOOL, TASK_RESULT_TOOL, TASK_CANCEL_TOOL, TASK_RESUME_TOOL], expected: [TASK_RUN_TOOL, TASK_STATUS_TOOL, TASK_RESULT_TOOL, TASK_CANCEL_TOOL, TASK_RESUME_TOOL] },
      { tools: [TASK_RUN_TOOL, READ_SKILL_TOOL], expected: [TASK_RUN_TOOL, READ_SKILL_TOOL] },
    ];
    for (const testCase of cases) {
      const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textReply('ok') });
      const driver = createPiTurnDriver({
        env: { LLM_MODEL: 'test-model' },
        modelRuntime: scripted.runtime,
        reuseConversation: true,
      });
      await driver.run(runInput([user('你好')], toolsOf(...testCase.tools), async () => undefined));
      expect(driver.sessionInfo!()?.activeToolNames, `工具面 = ${testCase.tools.join(',')}`).toEqual(testCase.expected);
      driver.close?.();
    }
  });
});

describe('A3 · 系统提示词与 Skills（受控 ResourceLoader）', () => {
  it('fshine 提示替换默认编码助手 preamble；不加载项目文件/扩展/技能读取段', async () => {
    const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textReply('好的。') });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
    });
    const fshinePrompt = '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。';
    await driver.run({
      systemPrompt: fshinePrompt,
      tools: toolsOf(TASK_RUN_TOOL),
      messages: [user('你好')],
      onStep: () => {},
      exec: async () => undefined,
      deadline: Date.now() + 60_000,
    });

    const systemPrompt = driver.sessionInfo!()?.systemPrompt ?? '';
    expect(systemPrompt.startsWith(fshinePrompt), 'fshine 提示必须是 preamble').toBe(true);
    for (const forbidden of [
      'coding assistant running inside pi',
      'Pi documentation',
      'AGENTS.md',
      'CLAUDE.md',
      '<skills>',
      'SKILL.md',
    ]) {
      expect(systemPrompt, `不得加载 ${forbidden}`).not.toContain(forbidden);
    }
    // cwd 段是 Pi 原生渲染，但必须是隔离空目录（不是仓库根/用户主目录）。
    const cwd = /<cwd>\s*\n?([^<\n]+)\n?<\/cwd>/.exec(systemPrompt)?.[1]?.trim();
    expect(cwd, 'Pi 应渲染隔离 cwd').toBeTruthy();
    expect(path.resolve(cwd!), 'cwd 不得是仓库根').not.toBe(REPO_ROOT);
    expect(path.resolve(cwd!), 'cwd 不得是用户主目录').not.toBe(path.resolve(process.env.HOME ?? '/home'));
    expect(readdirSync(cwd!).filter((name) => !name.startsWith('.pi-agent')), '工作目录必须是空目录').toEqual([]);

    // 工具声明走 Pi 的原生 tools（A2 的 activeToolNames 断言），自定义提示下不渲染工具清单段——
    // 这正说明没有宿主提示词补丁。
    driver.close?.();
  });
});
