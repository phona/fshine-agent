import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver, type TurnDriverInput } from './src/driver';
import { createContextTaskRunner, type ContextTaskRunner } from './src/context';
import { createTaxAgentRuntime } from './src/runtime';
import { validatePlanAgainstTurnDeclaration, type TurnDeclaration } from './src/turn-contract';

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
  async upsert(record: { sessionId: string; principalId: string; channelConversationId: string; updatedAt: string; state?: unknown }) {
    this.records.set(record.sessionId, { ...record });
  }
}

function trusted(sessionId = 'session-1', principalId = 'wecom:user-1'): TrustedContext {
  return { requestId: 'req-1', principalId, allowedAccountSetIds: [], sessionId };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-subagent-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills', '17dz'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', '17dz', 'SKILL.md'), '---\nname: 17dz\ndescription: 幻账平台工作规范\n---\n使用领域脚本并返回可复核证据。\n');
  return root;
}

function runner(root: string, tasks: MemoryTasks, driver: TurnDriver) {
  const profiles: Record<string, ContextProfileConfig> = {
    '17dz': { root, skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks, workerDriver: driver });
}

describe('17dz Pi subagent adapter', () => {
  it('固定 cwd/skillRoots 并原样返回自然语言', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    let observed: TurnDriverInput | undefined;
    const scripted = ScriptedTurnDriver([{ text: '已查询完成。\n来源：17dz 领域脚本。' }]);
    const subagent = runner(root, tasks, {
      run: async (input) => {
        observed = input;
        return scripted.run(input);
      },
    });

    const result = await subagent.run({ request: '查询幻辰余额' }, { trusted: trusted() });

    expect(result.text).toBe('已查询完成。\n来源：17dz 领域脚本。');
    expect(result.taskId).toMatch(/^task_/);
    expect(observed?.cwd).toBe(root);
    expect(observed?.skillRoots).toEqual([path.join(root, '.agents', 'skills')]);
    expect(observed?.sessionId).toBe(result.taskId);
    expect((await tasks.get(result.taskId))?.workerMessages).toHaveLength(2);
  });

  it('账套存在性任务要求只用专用目录搜索 operation', async () => {
    // 规则落点已从提示词下沉到宿主代码断言（docs/rule-landing.md C6）：
    // account_search 的计划必须且只能是一次 finance.search-account-sets，
    // 不得改用余额/凭证/科目查询探测——worker 提示词里不再枚举该场景。
    const intent: TurnDeclaration = {
      kind: 'platform_query', taskType: 'account_search', accountResolution: 'explicit', searchQuery: '胜利',
    };
    expect(validatePlanAgainstTurnDeclaration(intent, [
      { operation: 'finance.search-account-sets', args: ['--query', '胜利'] },
    ])).toBeNull();
    expect(validatePlanAgainstTurnDeclaration(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '胜利'] },
    ])).toContain('finance.search-account-sets');
    expect(validatePlanAgainstTurnDeclaration(intent, [
      { operation: 'finance.search-account-sets', args: ['--query', '胜利'] },
      { operation: 'finance.query-receivables', args: ['--query', '胜利'] },
    ])).toContain('finance.search-account-sets');
  });

  it('将宿主验证的本轮意图范围传给子 Agent', async () => {
    const root = await profileRoot();
    let prompt = '';
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        return { text: '已按当前范围查询。', messages: input.messages };
      },
    });

    await subagent.run({
      request: '查幻辰财税账套里猫一杯的应收账款',
      turnDeclaration: { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
    }, { trusted: trusted() });

    expect(prompt).toContain('宿主已核验本轮申报范围');
    expect(prompt).toContain('"accountQueries":["幻辰财税"]');
  });

  it('应收余额任务失败后禁止用历史凭证跨期间兜底', () => {
    // 规则落点已从提示词下沉到宿主代码断言（docs/rule-landing.md C7/C8）：
    // 余额计划只能调 finance.query-receivables，且不得带未申报的期间——
    // "失败后停止并如实报告"的行为面在 17dz-query SKILL.md 查询边界（S2）。
    const intent: TurnDeclaration = {
      kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'],
    };
    expect(validatePlanAgainstTurnDeclaration(intent, [
      { operation: 'voucher.query-saved', args: ['幻辰财税', '202601'] },
    ])).toContain('不能代替余额表');
    expect(validatePlanAgainstTurnDeclaration(intent, [
      { operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] },
    ])).toContain('期间');
  });

  it.each([
    '找到两个客户，请选择一个。',
    '请确认是否继续执行。',
    '当前权限不足，无法继续。',
  ])('不分析子 Agent 文本状态：%s', async (text) => {
    const root = await profileRoot();
    const result = await runner(root, new MemoryTasks(), ScriptedTurnDriver([{ text }]))
      .run({ request: '执行任务' }, { trusted: trusted() });
    expect(result.text).toBe(text);
  });

  it('通过 taskId 恢复子 Agent 转录，最新补充作为普通用户消息追加', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const first = await runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请用户选择。' }]))
      .run({ request: '查询幻东余额' }, { trusted: trusted() });

    let resumedMessages: TurnDriverInput['messages'] = [];
    const second = await runner(root, tasks, {
      run: async (input) => {
        resumedMessages = input.messages;
        return ScriptedTurnDriver([{ text: '已按用户选择查询完成。' }]).run(input);
      },
    }).run({ taskId: first.taskId, request: '用户选择幻州幻东机械有限公司' }, { trusted: trusted() });

    expect(second.taskId).toBe(first.taskId);
    expect(second.text).toBe('已按用户选择查询完成。');
    expect(resumedMessages).toHaveLength(3);
    expect(resumedMessages.at(-1)).toMatchObject({ role: 'user', content: '用户选择幻州幻东机械有限公司' });
  });

  it('不同 principal 或主会话不能接管已有子 Agent session', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const subagent = runner(root, tasks, ScriptedTurnDriver([{ text: '第一次完成。' }]));
    const first = await subagent.run({ request: '第一次' }, { trusted: trusted() });

    await expect(subagent.run({ request: '越权', taskId: first.taskId }, { trusted: trusted('session-1', 'wecom:other') }))
      .rejects.toThrow('无权继续');
    await expect(subagent.run({ request: '跨会话', taskId: first.taskId }, { trusted: trusted('session-2') }))
      .rejects.toThrow('无权继续');
  });

  it('未知 taskId 和越界 skillRoots 在运行 Worker 前被拒绝', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    let called = false;
    const driver: TurnDriver = { run: async () => { called = true; throw new Error('不应执行'); } };
    const subagent = runner(root, tasks, driver);
    await expect(subagent.run({ request: '继续', taskId: 'missing' }, { trusted: trusted() })).rejects.toBeInstanceOf(ToolUserError);

    const invalid = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['../outside'] } },
      tasks,
      workerDriver: driver,
    });
    await expect(invalid.run({ request: '读取越界目录' }, { trusted: trusted() })).rejects.toThrow('路径安全校验');
    expect(called).toBe(false);
  });

  it('把外层 AbortSignal 和 profile deadline 传给子 Agent', async () => {
    const root = await profileRoot();
    const controller = new AbortController();
    let observed: TurnDriverInput | undefined;
    const started = Date.now();
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'], workerTimeoutMs: 1234 } },
      tasks: new MemoryTasks(),
      workerDriver: {
        run: async (input) => {
          observed = input;
          return { text: '完成。', messages: input.messages };
        },
      },
    });
    await subagent.run({ request: '测试预算' }, { trusted: trusted() }, controller.signal);
    expect(observed?.signal).toBe(controller.signal);
    expect((observed?.deadline ?? 0) - started).toBeGreaterThan(900);
    expect((observed?.deadline ?? 0) - started).toBeLessThan(3000);
  });

  it('将 confirm pending 绑定到可信 principal/session 并先持久化再返回', async () => {
    const root = await profileRoot();
    const pending = { planId: 'plan_1', version: 3, taskId: 'task_1', decision: 'confirm' as const, userText: '需要确认', evaluation: {} as never };
    let saved: unknown;
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks: new MemoryTasks(),
      workerDriver: { run: async (input) => ({ text: '需要确认', messages: input.messages, pendingPlan: pending }) },
    });
    const ctx = trusted();
    ctx.onPlanPending = async (record) => { saved = record; };
    const result = await subagent.run({ request: '执行较大查询' }, { trusted: ctx });
    expect(saved).toMatchObject({ planId: 'plan_1', taskId: result.taskId, principalId: 'wecom:user-1', sessionId: 'session-1', requestId: 'req-1' });
    expect(result.pendingPlan).toMatchObject({ planId: 'plan_1', taskId: result.taskId });
  });

  it('pending plan 持久化失败时不把确认请求当作正常完成结果返回', async () => {
    const root = await profileRoot();
    const subagent = createContextTaskRunner({
      profiles: { '17dz': { root, skillRoots: ['.agents/skills'] } },
      tasks: new MemoryTasks(),
      workerDriver: { run: async (input) => ({
        text: '需要确认', messages: input.messages,
        pendingPlan: { planId: 'plan_1', version: 3, taskId: 'task_1', decision: 'confirm', userText: '需要确认', evaluation: {} as never },
      }) },
    });
    const ctx = trusted();
    ctx.onPlanPending = async () => { throw new Error('pending store down'); };
    await expect(subagent.run({ request: '执行较大查询' }, { trusted: ctx })).rejects.toThrow('17dz 子任务执行失败');
  });

  it('子 Agent 内部错误不会透传路径或秘密', async () => {
    const root = await profileRoot();
    const subagent = runner(root, new MemoryTasks(), {
      run: async () => { throw new Error('secret=/private/credentials'); },
    });
    await expect(subagent.run({ request: '执行任务' }, { trusted: trusted() }))
      .rejects.toThrow('17dz 子任务执行失败，请稍后再试。');
  });

  it('Main Agent 只申报本轮动作，宿主据申报委派并采用子 Agent 自然语言结果', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const scripted = runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请让用户选择。' }]));
    // 脚本化 worker 不经计划门，所以由替身补上执行凭证——否则宿主按"零执行"失败关闭。
    const subagent: ContextTaskRunner = {
      tool: scripted.tool,
      run: async (args, ctx, signal) => ({
        ...(await scripted.run(args, ctx, signal)),
        execution: { planId: 'plan_test', version: 1, calls: 1 },
      }),
    };
    let exposed: string[] = [];
    const mainDriver: TurnDriver = {
      run: async (input) => {
        exposed = input.tools.map((tool) => tool.name);
        try {
          await input.exec('route_current_turn', { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻东'] });
        } catch (error) {
          if (error instanceof ToolUserError) return { text: error.message, messages: input.messages };
          throw error;
        }
        return {
          text: '这条文本不应外发',
          messages: [...input.messages, { role: 'assistant', content: '这条文本不应外发', timestamp: Date.now() } as never],
        };
      },
    };
    const runtime = createTaxAgentRuntime({ driver: mainDriver, sessions: new MemorySessions(), platformTask: subagent });
    const reply = await runtime.handleTurn(trusted(), '查幻东余额');

    expect(exposed).toEqual(['route_current_turn']);
    expect(reply.text).toBe('找到两个客户，请让用户选择。');
  });
});
