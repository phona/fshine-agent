import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver, type TurnDriverInput } from './src/driver';
import { createContextTaskRunner, type ContextTaskRunner } from './src/context';
import { createTaxAgentRuntime } from './src/runtime';
import { validatePlanEntities } from './src/turn-contract';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  /** 列举调用计数：合法 taskId 不该触发兜底列举。 */
  listCalls = 0;
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
  /**
   * 开放任务 = 该 principal/会话下的全部任务（与 SQLite 实现同语义：任务记录没有终态，
   * upsert 之后一直可续跑）。测试直接灌记录来构造"恰一个 / 零个 / 两个"三种局面。
   */
  async listOpenBySession(principalId: string, sessionId: string) {
    this.listCalls += 1;
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
      .map((record) => structuredClone(record));
  }
}

/** 会说谎的存储：列举返回与请求方无关的任务——用来证明兜底没有绕开归属校验。 */
class StrangerTasks extends MemoryTasks {
  constructor(private readonly forged: PlatformTaskRecord[]) { super(); }
  override async listOpenBySession(): Promise<PlatformTaskRecord[]> {
    return this.forged.map((record) => structuredClone(record));
  }
}

interface TaskFallbackLogEvent {
  event: string;
  requestId?: string;
  requestedTaskId?: string;
  boundTaskId?: string;
}

/** 侦测 C2 兜底留痕（写法同 tests/e2e 的 capturePlanLog）。 */
function captureTaskFallbackLog() {
  const events: TaskFallbackLogEvent[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as TaskFallbackLogEvent;
      if (parsed?.event === 'task_id_fallback_bound' || parsed.event === 'task_id_fallback_list_failed') events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
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

  it('计划模式的步骤标签透传给子 Agent 驱动，用户通知带「第 N/M 步」前缀', async () => {
    const root = await profileRoot();
    let observed: TurnDriverInput | undefined;
    const notices: string[] = [];
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        observed = input;
        // 复刻平台计划门的通知：固定标记在前，宿主在这一层加步骤前缀
        await input.onNotice?.('计划通知：本次需新增 3 次查询，预计约 1 分钟。通知送达后将继续执行。');
        return { text: '已完成。', messages: input.messages };
      },
    });
    const ctx = trusted();
    ctx.onNotice = async (text) => { notices.push(text); };

    await subagent.run({ request: '查某个对象 202609', stepLabel: '第 1/3 步' }, { trusted: ctx });

    // 前缀插在固定标记之后：渠道与测试替身仍能识别这是计划通知帧
    expect(notices).toEqual(['计划通知：【第 1/3 步】本次需新增 3 次查询，预计约 1 分钟。通知送达后将继续执行。']);
    // 步骤标签只走通知链路，不进 worker 驱动输入
    expect(observed?.onNotice).toBeTypeOf('function');
  });

  it('没有步骤标签（单步模式）时通知原样交付，不加前缀', async () => {
    const root = await profileRoot();
    const notices: string[] = [];
    const subagent = runner(root, new MemoryTasks(), {
      run: async (input) => {
        await input.onNotice?.('计划通知：本次需新增 3 次查询。');
        return { text: '已完成。', messages: input.messages };
      },
    });
    const ctx = trusted();
    ctx.onNotice = async (text) => { notices.push(text); };

    await subagent.run({ request: '查某个对象 202609' }, { trusted: ctx });

    expect(notices).toEqual(['计划通知：本次需新增 3 次查询。']);
  });

  it('worker 回报"缺什么"时结构化线索原样上交，任务记录保持可续', async () => {    const root = await profileRoot();
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

  // ── C2：continueTaskId 幻觉编号的"唯一开放任务"兜底 ──────────────────────
  // 真实平台战斗测试实测：模型会编一个不存在的任务编号填进 continueTaskId，原语义直接
  // 报错、流程断在这里。兜底只在"这个会话恰好有一个开放平台任务"时生效——编号是猜的，
  // 任务归属不能猜；零个和多个都维持原报错（多个正是多任务场景，交给用户消歧）。
  describe('continueTaskId 查不到时：会话恰一个开放任务才兜底绑定', () => {
    it('幻觉编号 + 会话恰一个开放任务：绑定该任务从断点续跑，不断流程', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const first = await runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请用户选择。' }]))
        .run({ request: '查询幻东余额' }, { trusted: trusted() });

      let resumedMessages: TurnDriverInput['messages'] = [];
      const log = captureTaskFallbackLog();
      try {
        const second = await runner(root, tasks, {
          run: async (input) => {
            resumedMessages = input.messages;
            return ScriptedTurnDriver([{ text: '已按用户选择查询完成。' }]).run(input);
          },
        }).run({ taskId: 'task_hallucinated_404', request: '用户选择幻州幻东机械有限公司' }, { trusted: trusted() });

        expect(second.text).toBe('已按用户选择查询完成。');
        // 绑定的是会话里那个开放任务：不新开 taskId，worker 拿到的也是它的转录
        expect(second.taskId).toBe(first.taskId);
        expect(resumedMessages).toHaveLength(3);
        expect(resumedMessages.at(-1)).toMatchObject({ role: 'user', content: '用户选择幻州幻东机械有限公司' });
        // 留痕三要素：requestId、原（幻觉）编号、绑定到的编号
        expect(log.events).toEqual([{
          event: 'task_id_fallback_bound',
          requestId: 'req-1',
          requestedTaskId: 'task_hallucinated_404',
          boundTaskId: first.taskId,
        }]);
      } finally {
        log.restore();
      }
    });

    it('幻觉编号 + 零个开放任务：维持原报错，且不静默按新任务放行', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      let called = false;
      const subagent = runner(root, tasks, { run: async () => { called = true; throw new Error('不应执行'); } });
      const log = captureTaskFallbackLog();
      try {
        await expect(subagent.run({ request: '继续', taskId: 'task_hallucinated_404' }, { trusted: trusted() }))
          .rejects.toThrow('未找到可继续');
        expect(called).toBe(false);
        expect(log.events).toEqual([]);
      } finally {
        log.restore();
      }
    });

    it('幻觉编号 + 两个开放任务：维持原报错（多任务歧义仍由用户消歧）', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const subagent = runner(root, tasks, ScriptedTurnDriver([{ text: '第一个任务。' }, { text: '第二个任务。' }]));
      await subagent.run({ request: '查 A' }, { trusted: trusted() });
      await subagent.run({ request: '查 B' }, { trusted: trusted() });
      expect(await tasks.listOpenBySession('wecom:user-1', 'session-1')).toHaveLength(2);

      const log = captureTaskFallbackLog();
      try {
        await expect(subagent.run({ request: '继续', taskId: 'task_hallucinated_404' }, { trusted: trusted() }))
          .rejects.toThrow('未找到可继续');
        // 两个候选一个都不绑：绑定日志一次都没有
        expect(log.events).toEqual([]);
      } finally {
        log.restore();
      }
    });

    it('合法 taskId 走原路径：不列举、不兜底', async () => {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const first = await runner(root, tasks, ScriptedTurnDriver([{ text: '找到两个客户，请用户选择。' }]))
        .run({ request: '查询幻东余额' }, { trusted: trusted() });
      // 同一个会话再开一个任务：此时有两个开放任务，合法编号仍必须精确命中
      await runner(root, tasks, ScriptedTurnDriver([{ text: '另一个任务。' }])).run({ request: '查 B' }, { trusted: trusted() });

      const log = captureTaskFallbackLog();
      try {
        const second = await runner(root, tasks, ScriptedTurnDriver([{ text: '已按用户选择查询完成。' }]))
          .run({ taskId: first.taskId, request: '用户选择幻州幻东机械有限公司' }, { trusted: trusted() });
        expect(second.taskId).toBe(first.taskId);
        expect(tasks.listCalls).toBe(0);
        expect(log.events).toEqual([]);
      } finally {
        log.restore();
      }
    });

    it('兜底绑定的任务仍过归属校验：列举返回别人的任务照样被拒', async () => {
      // 兜底列举本身就按 (principalId, sessionId) 过滤，与归属校验等价成立；这里用一个
      // "会说谎"的存储证明代码路径没有另开短路——绑定到的记录依旧要走同一道检查。
      const root = await profileRoot();
      const forged: PlatformTaskRecord = {
        taskId: 'task_stranger',
        parentSessionId: 'session-1',
        principalId: 'wecom:other',
        workerMessages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const subagent = runner(root, new StrangerTasks([forged]), ScriptedTurnDriver([{ text: '不应执行' }]));
      await expect(subagent.run({ request: '越权', taskId: 'task_hallucinated_404' }, { trusted: trusted() }))
        .rejects.toThrow('无权继续');
    });
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

describe('下游平台保护：委派并发闸', () => {
  /** 记录并发进出：driver 执行期间 Active 数 > 1 即说明闸门失效。 */
  function concurrencyProbe(delayMs: number) {
    let active = 0;
    let maxActive = 0;
    const driver: TurnDriver = {
      run: async (input: TurnDriverInput) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        active -= 1;
        return { text: '查完了', messages: input.messages };
      },
    };
    return { driver, peak: () => maxActive };
  }

  it('默认全局串行：两个委派不会同时进入下游平台', async () => {
    const root = await profileRoot();
    const probe = concurrencyProbe(80);
    const task = runner(root, new MemoryTasks(), probe.driver);
    const [a, b] = await Promise.all([
      task.run({ request: '查A' }, { trusted: trusted() }),
      task.run({ request: '查B' }, { trusted: trusted() }),
    ]);
    expect(a.text).toBe('查完了');
    expect(b.text).toBe('查完了');
    expect(probe.peak()).toBe(1);
  });

  it('FSHINE_PLATFORM_CONCURRENCY=2 时允许两个并行', async () => {
    const previous = process.env.FSHINE_PLATFORM_CONCURRENCY;
    process.env.FSHINE_PLATFORM_CONCURRENCY = '2';
    try {
      const root = await profileRoot();
      const probe = concurrencyProbe(80);
      const task = runner(root, new MemoryTasks(), probe.driver);
      await Promise.all([
        task.run({ request: '查A' }, { trusted: trusted() }),
        task.run({ request: '查B' }, { trusted: trusted() }),
      ]);
      expect(probe.peak()).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.FSHINE_PLATFORM_CONCURRENCY;
      else process.env.FSHINE_PLATFORM_CONCURRENCY = previous;
    }
  });

  it('worker 抛错也释放闸门：后续委派不被卡死', async () => {
    const root = await profileRoot();
    let calls = 0;
    const flaky: TurnDriver = {
      run: async (input: TurnDriverInput) => {
        calls += 1;
        if (calls === 1) throw new Error('平台侧抽风');
        return { text: '恢复后查完了', messages: input.messages };
      },
    };
    const task = runner(root, new MemoryTasks(), flaky);
    // worker 原始错误被 runner 转成面向用户的安全话术（既有行为）；关键是它reject了
    await expect(task.run({ request: '查A' }, { trusted: trusted() })).rejects.toThrow('17dz 子任务执行失败');
    // 闸门已释放：第二次委派照常进行，没有被第一次的异常卡死
    const second = await task.run({ request: '查B' }, { trusted: trusted() });
    expect(second.text).toBe('恢复后查完了');
  });
});
