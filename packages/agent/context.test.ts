import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, DiscoveredTool, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { ScriptedTurnDriver, ToolUserError } from './src/driver';
import { createContextTaskRunner, type ContextToolProvider } from './src/context';
import { createWorkspaceToolProvider } from './src/workspace-tools';
import { createTaxAgentRuntime } from './src/runtime';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
}

class MemorySessions {
  private readonly records = new Map<string, { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }>();
  async get(sessionId: string) { return this.records.get(sessionId) ?? null; }
  async upsert(record: { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }) { this.records.set(sessionIdKey(record), { ...record }); }
}

function sessionIdKey(record: { sessionId: string }): string { return record.sessionId; }

const tool: DiscoveredTool = {
  name: 'search_account_sets',
  description: '搜索账套',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

function trusted(sessionId = 'session-1'): TrustedContext {
  return { requestId: 'req-1', principalId: 'wecom:user-1', allowedAccountSetIds: [], sessionId };
}

function provider(calls: Array<Record<string, unknown>>): ContextToolProvider {
  return {
    tools: () => [tool],
    call: async (_name, args) => { calls.push(args); return { accountSets: [{ id: 'as_003', name: '幻辰' }] }; },
  };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-context-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills', '17dz'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', '17dz', 'SKILL.md'), '---\nname: 17dz\ndescription: 幻账平台工作规范\n---\n使用平台数据并返回可复核证据。\n');
  return root;
}

function runner(root: string, tasks: MemoryTasks, driver: ReturnType<typeof ScriptedTurnDriver>, capabilityProvider?: ContextToolProvider) {
  const profiles: Record<string, ContextProfileConfig> = {
    '17dz': { root, skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks, workerDriver: driver, provider: capabilityProvider });
}

describe('trusted context worker', () => {
  it('首次任务通过受信 profile 创建干净 worker 并返回 completed', async () => {
    const root = await profileRoot();
    const calls: Array<Record<string, unknown>> = [];
    const tasks = new MemoryTasks();
    const worker = runner(root, tasks, ScriptedTurnDriver([{
      toolCalls: [{ tool: 'search_account_sets', args: { query: '幻辰' } }],
      text: '已找到幻辰账套 as_003。',
    }]));

    const result = await worker.run({ request: '查找幻辰账套' }, { trusted: trusted(), provider: provider(calls) });
    expect(result.status).toBe('completed');
    expect(result.taskId).toMatch(/^task_/);
    expect(calls).toEqual([{ query: '幻辰' }]);
    expect((await tasks.get(result.taskId))?.status).toBe('completed');
  });

  it('needs_input 可通过 taskId 续接并持久化最终消息', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const calls: Array<Record<string, unknown>> = [];
    const worker = runner(root, tasks, ScriptedTurnDriver([
      { text: '找到两个客户，请选择幻州幻东机械有限公司。' },
      { text: '已查询完成，应收余额为 686985.49 元。' },
    ]));
    const first = await worker.run({ request: '幻东在幻辰还欠多少' }, { trusted: trusted(), provider: provider(calls) });
    expect(first.status).toBe('needs_input');
    expect(first.questions).toHaveLength(1);
    const second = await worker.run({ taskId: first.taskId, request: '继续', answer: '选择幻州幻东机械有限公司' }, { trusted: trusted(), provider: provider(calls) });
    expect(second.status).toBe('completed');
    expect((await tasks.get(first.taskId))?.workerMessages.length).toBeGreaterThan(1);
  });

  it('重新创建 runner 后可以从 SQLite 等价仓库恢复任务', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const firstRunner = runner(root, tasks, ScriptedTurnDriver([{ text: '请补充客户名称。' }]));
    const first = await firstRunner.run({ request: '查客户' }, { trusted: trusted(), provider: provider([]) });
    const secondRunner = runner(root, tasks, ScriptedTurnDriver([{ text: '恢复后已完成。' }]));
    const second = await secondRunner.run({ taskId: first.taskId, request: '继续', answer: '幻州幻东机械有限公司' }, { trusted: trusted(), provider: provider([]) });
    expect(second.status).toBe('completed');
    expect((await tasks.get(first.taskId))?.status).toBe('completed');
  });

  it('skillRoots 越出受信 root 时拒绝，模型不能传入任意路径', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const worker = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['../outside'] } },
      tasks,
      workerDriver: ScriptedTurnDriver([{ text: '不应执行' }]),
    });
    await expect(worker.run({ request: '读取任意路径', ...( { root: '/' } as unknown as Record<string, unknown>) }, { trusted: trusted(), provider: provider([]) })).rejects.toBeInstanceOf(ToolUserError);
    expect(tasks.records.size).toBe(0);
  });

  it('启用 context worker 后主 Agent 只看到 run_17dz_task，并能委托完成', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const platform = runner(root, tasks, ScriptedTurnDriver([{ text: '17dz 查询已完成，余额为 686985.49 元。' }]), provider([]));
    const observedToolNames: string[][] = [];
    const mainScript = ScriptedTurnDriver([{
      toolCalls: [{ tool: 'run_17dz_task', args: { request: '查询幻辰的应收账款' } }],
      text: '已完成平台查询。',
    }]);
    const mainDriver = {
      run: async (input: import('./src/driver').TurnDriverInput) => {
        observedToolNames.push(input.tools.map((entry) => entry.name));
        return mainScript.run(input);
      },
    };
    const runtime = createTaxAgentRuntime({
      driver: mainDriver,
      sessions: new MemorySessions(),
      platformTask: platform,
    });
    const reply = await runtime.handleTurn(trusted(), '查幻辰的应收账款');
    expect(reply.text).toBe('已完成平台查询。');
    expect(observedToolNames).toEqual([[ 'run_17dz_task' ]]);
    expect([...tasks.records.values()][0]?.status).toBe('completed');
  });

  it('Worker 优先使用 ContextToolProvider，不依赖 HostToolClient', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const calls: Array<Record<string, unknown>> = [];
    const provider: ContextToolProvider = {
      tools: () => [tool],
      call: async (_name, args) => { calls.push(args); return { accountSets: [{ id: 'as_003', name: '幻辰' }] }; },
    };
    const worker = runner(root, tasks, ScriptedTurnDriver([{
      toolCalls: [{ tool: 'search_account_sets', args: { query: '幻辰' } }],
      text: '已通过 ContextToolProvider 完成。',
    }]));
    const result = await worker.run(
      { request: '查找幻辰' },
      {
        trusted: trusted(),
        provider,
      },
    );
    expect(result.status).toBe('completed');
    expect(calls).toEqual([{ query: '幻辰' }]);
  });

  it('无显式 provider 时自动挂载 workspace tools，且固定 root', async () => {
    const root = await profileRoot();
    const marker = path.join(root, 'marker.txt');
    await writeFile(marker, 'workspace-ok\n');
    const tasks = new MemoryTasks();
    const worker = runner(root, tasks, ScriptedTurnDriver([{
      toolCalls: [
        { tool: 'read_file', args: { path: 'marker.txt' } },
        { tool: 'run_command', args: { command: 'pwd' } },
      ],
      text: '已读取工作目录并执行命令。',
    }]));
    const result = await worker.run({ request: '读取 marker 并确认工作目录' }, { trusted: trusted() });
    expect(result.status).toBe('completed');
  });

  it('workspace tools 拒绝越界路径并中止超时命令', async () => {
    const root = await profileRoot();
    const provider = createWorkspaceToolProvider(root, { commandTimeoutMs: 20 });
    await expect(provider.call('read_file', { path: '../outside' })).rejects.toThrow('路径不能越出');
    const result = await provider.call('run_command', { command: 'sleep 1' });
    expect(result).toMatchObject({ timedOut: true });
  });

  it('上下文没有通用执行能力时直接 blocked，不尝试 MCP/Host fallback', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const worker = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks,
      workerDriver: ScriptedTurnDriver([{ text: '不应执行' }]),
      genericWorkspaceTools: false,
    });
    const result = await worker.run({ request: '查找幻辰' }, { trusted: trusted() });
    expect(result.status).toBe('blocked');
    expect(result.error).toContain('CAPABILITY_UNAVAILABLE');
    expect((await tasks.get(result.taskId))?.status).toBe('blocked');
  });
});
