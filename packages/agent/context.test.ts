import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver, type TurnDriverInput } from './src/driver';
import { createContextTaskRunner, type ContextTaskRunner } from './src/context';
import { createTaxAgentRuntime } from './src/runtime';
import { validatePlanEntities } from './src/turn-contract';

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
    // Phase 3 起宿主不再做领域判别：操作与任务类型的匹配归执行层 SKILL 与平台门禁
    // （17dz src/execution/plan.js 的 PLAN_CALL_MISMATCH + 17dz-query SKILL.md）。
    // 宿主只保留领域无关的实体来源校验——这里断言新语义：目录检索计划放行，
    // 且越权实体仍被拒。
    // 单次目录检索：实体来自当前消息 → 放行
    expect(validatePlanEntities(
      [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }],
      { currentMessage: '只查有没有胜利这个帐套' },
    )).toBeNull();
    // 混入本轮请求里没有的实体 → 仍然拒（实体来源校验不弱于原来）
    expect(validatePlanEntities(
      [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] },
        { operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      { currentMessage: '只查有没有胜利这个帐套' },
    )).toContain('未在当前请求、检索证据或平台响应中出现的参数');
  });

  it('将宿主核验后的申报契约与实体来源传给子 Agent', async () => {
    const root = await profileRoot();
    let prompt = '';
    let observed: TurnDriverInput | undefined;
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        prompt = input.systemPrompt;
        observed = input;
        return { text: '已按当前范围查询。', messages: input.messages };
      },
    });

    await subagent.run({
      request: '查幻辰财税账套里猫一杯的应收账款',
      turnDeclaration: { kind: 'delegate', request: '查幻辰财税账套里猫一杯的应收账款' },
      entitySources: { currentMessage: '查幻辰财税账套里猫一杯的应收账款', referenceEvidence: '【宿主主动回溯】幻东 202609 余额 51 元' },
    }, { trusted: trusted() });

    expect(prompt).toContain('宿主已核验本轮请求');
    // 加工后的 request 随申报一起进 worker 提示词（宿主不再做领域判别，只透传请求本身）
    expect(prompt).toContain('查幻辰财税账套里猫一杯的应收账款');
    // 领域无关的实体来源原样透传到 worker 驱动（宿主不懂业务，只做字符串包含）
    expect(observed?.entitySources).toEqual({
      currentMessage: '查幻辰财税账套里猫一杯的应收账款',
      referenceEvidence: '【宿主主动回溯】幻东 202609 余额 51 元',
    });
    // 申报契约三字段原样透传，宿主不加工不补字段
    expect(observed?.turnDeclaration).toEqual({ kind: 'delegate', request: '查幻辰财税账套里猫一杯的应收账款' });
    // 纠错环规程（Phase 5）：执行不了时报"缺什么/为什么/建议用户提供什么"，
    // 与既有总结原则同一份表述，不新增场景枚举
    expect(prompt).toContain('缺什么、为什么做不了、建议用户提供什么');
  });

  it('宿主未注入实体来源时不向 worker 驱动传该字段（老路径不做实体校验）', async () => {
    const root = await profileRoot();
    let observed: TurnDriverInput | undefined;
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        observed = input;
        return { text: '完成。', messages: input.messages };
      },
    });

    await subagent.run({ request: '查询余额' }, { trusted: trusted() });

    expect(observed?.entitySources).toBeUndefined();
    expect(observed?.turnDeclaration).toBeUndefined();
  });

  it('worker 回报"缺什么"时结构化线索原样上交，任务记录保持可续', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const subagent = runner(root, tasks, {
      run: async (input) => ({
        text: '平台要求必须显式给出期间。',
        messages: input.messages,
        needs: { missing: ['期间'], reason: '平台要求必须显式给出期间', suggestion: '请给出要查的期间' },
      }),
    });

    const result = await subagent.run({ request: '查余额' }, { trusted: trusted() });

    expect(result.needs).toEqual({ missing: ['期间'], reason: '平台要求必须显式给出期间', suggestion: '请给出要查的期间' });
    // 没有执行凭证（这一轮零执行），线索本身就是给宿主的信号
    expect(result.execution).toBeUndefined();
    // taskId 已知会宿主侧，且 worker 转录已落库：用户补充后经 continueTaskId 从断点续跑
    expect(result.taskId).toMatch(/^task_/);
    expect((await tasks.get(result.taskId))?.workerMessages).toHaveLength(1);
  });

  it('应收余额任务失败后禁止用历史凭证跨期间兜底', () => {
    // Phase 3 起宿主不再做领域判别（"只能调某个操作""不得带未申报期间"归执行层 SKILL
    // 与平台门禁）。保留的是实体来源校验：本轮请求里没有的实体一律拒——
    // 拿历史实体兜底在这里被挡下，与旧分支的越权判定等价。
    const sources = { currentMessage: '查一下幻辰财税账套本期的应收' };
    // 越权实体（历史里出现过、本轮请求里没有）→ 拒
    expect(validatePlanEntities(
      [{ operation: 'voucher.query-saved', args: ['幻辰财税', '202601'] }],
      sources,
    )).toContain('未在当前请求、检索证据或平台响应中出现的参数');
    // 平台自己返回的候选/期间 → 放行（search→query 场景，宿主不懂业务）
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] }],
      { ...sources, platformResponses: ['当前期间为 202601'] },
    )).toBeNull();
    // 本轮请求里逐字出现的实体 → 放行，不管 operation 是什么
    expect(validatePlanEntities(
      [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }],
      sources,
    )).toBeNull();
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
          await input.exec('route_current_turn', { kind: 'delegate', request: '查幻东的应收账款余额' });
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
