import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextStateRecord, ConversationEventRecord, MemoryRecordRecord, TrustedContext } from '@fshine/contracts';
import type { TurnInputContext } from '@fshine/contracts';
import type { TurnDriver } from './src/driver';
import { RUN_EXECUTION_TASK_TOOL } from './src/context';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './src/turn-contract';
import { createCurrentUserMessage } from './src/message-reference';
import { buildRequestKey } from './src/repeat-request';
import {
  appendClarificationIssued,
  appendClarificationResolved,
  appendUserEvent,
  ensureHistoryBackfill,
  extract17dzToolResultEvents,
  isContextState,
  loadMemoryProjection,
  persistAssistantAndContext,
  redactInternalIds,
  redactSensitiveText,
  scheduleMemoryConsolidation,
  type TurnPersistenceDeps,
} from './src/turn-persistence';

/**
 * turn-persistence 模块的单测（方案 2 分批 3b · 步 7，见 docs/change-safety.md §3）。
 *
 * R3：**不起 driver harness**——只 import 被测模块 + 纯数据 + 内存假 repo，不出现
 * createTaxAgentRuntime。这些用例对应原先只能靠 runtime.test.ts 与 e2e 间接覆盖的行为
 * （要跑完整个回合才碰到一次落账）；抽出来后直测：
 *   · 事件落账形状（eventId 组成 / kind / 脱敏 / 截断 / createdAt 取数）；
 *   · 失败降级（存储抛错不阻塞回合，只记日志）；
 *   · Context State 的增量更新与历史转录回填。
 */

function ctx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_tp',
    principalId: 'wecom:user_a',
    sessionId: 'sess_tp',
    ...overrides,
  };
}

/** 内存假 ConversationLog：只实现本模块用到的 append / list，可注入抛错。 */
class FakeLog {
  readonly events: ConversationEventRecord[] = [];
  readonly appended: ConversationEventRecord[] = [];
  failAppend = false;
  failList = false;

  async append(record: ConversationEventRecord): Promise<void> {
    this.appended.push(record);
    if (this.failAppend) throw new Error('conversation log unavailable');
    this.events.push(record);
  }

  async list(): Promise<ConversationEventRecord[]> {
    if (this.failList) throw new Error('conversation log unavailable');
    return [...this.events];
  }

  get repo(): NonNullable<TurnPersistenceDeps['conversationLog']> {
    return { append: (record) => this.append(record), list: () => this.list() };
  }
}

/** 内存假 ContextStateRepo：记录 upsert 轨迹，可注入抛错。 */
class FakeContextStates {
  stored: ContextStateRecord | null = null;
  readonly upserted: ContextStateRecord[] = [];
  failGet = false;
  failUpsert = false;

  async get(principalId: string, sessionId: string): Promise<ContextStateRecord | null> {
    if (this.failGet) throw new Error('context state unavailable');
    return this.stored && this.stored.principalId === principalId && this.stored.sessionId === sessionId ? this.stored : null;
  }

  async upsert(record: ContextStateRecord): Promise<void> {
    this.upserted.push(record);
    if (this.failUpsert) throw new Error('context state unavailable');
    this.stored = record;
  }

  get repo(): NonNullable<TurnPersistenceDeps['contextStates']> {
    return { get: (p, s) => this.get(p, s), upsert: (record) => this.upsert(record) };
  }
}

/** 复刻生产驱动形状的工具结果消息（role=toolResult + content 段数组 + 数字 timestamp）。 */
function toolResult(toolName: string, toolCallId: string | undefined, text: unknown, timestamp = 10): AgentMessage {
  return {
    role: 'toolResult',
    toolName,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    content: typeof text === 'string' ? [{ type: 'text', text }] : text,
    timestamp,
  } as unknown as AgentMessage;
}

function transcriptMessage(role: string, content: string, timestamp: number): AgentMessage {
  return { role, content, timestamp } as unknown as AgentMessage;
}

function validState(overrides: Partial<ContextStateRecord['state']> = {}): ContextStateRecord {
  return {
    principalId: 'wecom:user_a',
    sessionId: 'sess_tp',
    updatedAt: '2026-10-12T00:00:00.000Z',
    throughEventId: 'e_old',
    reducerVersion: 1,
    state: {
      reducerVersion: 1,
      userDecisions: [],
      agentAssumptions: [],
      unresolvedQuestions: [],
      recentEvents: [],
      ...overrides,
    },
  };
}

function event(eventId: string, kind: ConversationEventRecord['kind'], content: string): ConversationEventRecord {
  return { eventId, principalId: 'wecom:user_a', sessionId: 'sess_tp', kind, content, createdAt: '2026-10-12T00:00:00.000Z', requestId: 'req_tp' };
}

// ── extract17dzToolResultEvents：三种工具结果路径 + 脱敏 + 截断 ──────────────

describe('extract17dzToolResultEvents：三种工具结果路径', () => {
  it('terminate 路径（run_17dz_task 的信封）：取 text 字段并收回 taskId', () => {
    const { events, taskResults } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_1', JSON.stringify({ taskId: 'task_a1', text: '余额 42 元' })),
    ], ctx());

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('余额 42 元');
    expect(events[0]?.kind).toBe('tool_result');
    expect(events[0]?.eventId).toBe('req_tp:tool:call_1');
    expect(events[0]?.requestId).toBe('req_tp');
    expect(taskResults).toEqual([{ taskId: 'task_a1', resultText: '余额 42 元' }]);
  });

  it('needs 路径（纠错环交还）：recorded=delegate 的信封同样只留 text', () => {
    const { events, taskResults } = extract17dzToolResultEvents([
      toolResult(ROUTE_CURRENT_TURN_TOOL_NAME, 'call_2', JSON.stringify({
        recorded: 'delegate',
        text: '子 Agent 本轮没有执行平台查询，还缺少信息：账套。',
        taskId: 'task_b2',
        needs: { missing: ['账套'], reason: '名称有歧义', suggestion: '给规范名' },
      })),
    ], ctx());

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('子 Agent 本轮没有执行平台查询，还缺少信息：账套。');
    expect(taskResults).toEqual([{ taskId: 'task_b2', resultText: '子 Agent 本轮没有执行平台查询，还缺少信息：账套。' }]);
  });

  it('计划步路径（第N/M步交还）：信封里的 step/outcome 等协议字段不落库，只留 text', () => {
    const { events, taskResults } = extract17dzToolResultEvents([
      toolResult(ROUTE_CURRENT_TURN_TOOL_NAME, 'call_3', JSON.stringify({
        recorded: 'delegate',
        step: '第 1/2 步',
        stepIndex: 1,
        totalSteps: 2,
        taskId: 'task_c3',
        executed: true,
        text: '第一步查完了',
        outcome: 'ok',
        next: '继续下一步',
      })),
    ], ctx());

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('第一步查完了');
    expect(events[0]?.content).not.toContain('step');
    expect(taskResults).toEqual([{ taskId: 'task_c3', resultText: '第一步查完了' }]);
  });

  it('conversation 申报没有可召回的结果：直接跳过，不落事件', () => {
    const { events, taskResults } = extract17dzToolResultEvents([
      toolResult(ROUTE_CURRENT_TURN_TOOL_NAME, 'call_4', JSON.stringify({ recorded: 'conversation' })),
    ], ctx());

    expect(events).toEqual([]);
    expect(taskResults).toEqual([]);
  });

  it('非 JSON 的自然语言结果照常落库（不需要信封）', () => {
    const { events, taskResults } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_5', '一句普通文本结果'),
    ], ctx());

    expect(events[0]?.content).toBe('一句普通文本结果');
    expect(taskResults).toEqual([]);
  });

  it('content 段数组只取 type=text 的正文，其余段忽略', () => {
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_6', [
        { type: 'text', text: '第一段' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '第二段' },
      ]),
    ], ctx());

    expect(events[0]?.content).toBe('第一段\n第二段');
  });
});

describe('extract17dzToolResultEvents：脱敏、截断与 id 组成', () => {
  it('内部 task_/plan_ id 换成占位符（内容里一个不留）', () => {
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_7', JSON.stringify({
        taskId: 'task_9f8e7d6c',
        text: '计划 plan_abc123 的第一步 task_9f8e7d6c 已开始',
      })),
    ], ctx());

    expect(events[0]?.content).toBe('计划 [PLAN_ID] 的第一步 [TASK_ID] 已开始');
    expect(events[0]?.content).not.toContain('plan_abc123');
    expect(events[0]?.content).not.toContain('task_9f8e7d6c');
    // taskId 只进 taskResults（存储侧串联），不进落库内容
    expect(JSON.stringify(events)).not.toContain('task_9f8e7d6c');
  });

  it('Bearer 令牌与 api_key 之类的键值被脱敏', () => {
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_8', 'Authorization: Bearer sk-live-abcdef\napi_key: "topsecret"'),
    ], ctx());

    expect(events[0]?.content).toContain('Bearer [REDACTED]');
    expect(events[0]?.content).not.toContain('sk-live-abcdef');
    expect(events[0]?.content).toContain('[REDACTED]');
    expect(events[0]?.content).not.toContain('topsecret');
  });

  it('内容截断到 20000 字符（截断在脱敏之后）', () => {
    const long = 'x'.repeat(20_050);
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_9', JSON.stringify({ taskId: 'task_t', text: long })),
    ], ctx());

    expect(events[0]?.content).toHaveLength(20_000);
  });

  it('toolCallId 缺失时 eventId 退回消息下标', () => {
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, undefined, '第一条'),
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_named', '第二条'),
    ], ctx());

    expect(events.map((entry) => entry.eventId)).toEqual(['req_tp:tool:0', 'req_tp:tool:call_named']);
  });

  it('createdAt 取消息自带的时间戳（数字），缺失时用当前时间', () => {
    const stamped = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_ts', '带时间戳', 1_700_000_000_000),
    ], ctx());
    expect(stamped.events[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());

    const before = Date.now();
    const unstamped = extract17dzToolResultEvents([
      { role: 'toolResult', toolName: RUN_EXECUTION_TASK_TOOL, content: [{ type: 'text', text: '无时间戳' }] } as unknown as AgentMessage,
    ], ctx());
    expect(Date.parse(unstamped.events[0]?.createdAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('脱敏后为空的工具结果不落事件', () => {
    const { events } = extract17dzToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_empty', '   \n  '),
    ], ctx());

    expect(events).toEqual([]);
  });

  it('宿主内部工具（history tools）与普通 assistant/user 消息都不落 tool_result', () => {
    const { events } = extract17dzToolResultEvents([
      { role: 'user', content: '用户消息', timestamp: 1 } as unknown as AgentMessage,
      { role: 'assistant', content: '助手消息', timestamp: 2 } as unknown as AgentMessage,
      toolResult('search_history', 'call_h', '历史检索结果'),
      toolResult('get_messages', 'call_m', '消息读取结果'),
    ], ctx());

    expect(events).toEqual([]);
  });
});

describe('redactInternalIds', () => {
  it('task_/plan_ 前缀的 id 换成占位符，其余文本一字不动', () => {
    expect(redactInternalIds('任务 task_abc-123 与计划 plan_xyz_9 进行中')).toBe('任务 [TASK_ID] 与计划 [PLAN_ID] 进行中');
    expect(redactInternalIds('没有内部 id 的普通文本')).toBe('没有内部 id 的普通文本');
    expect(redactInternalIds('tasklist 与 planet 不是 id')).toBe('tasklist 与 planet 不是 id');
  });
});

describe('redactSensitiveText', () => {
  it('Bearer 令牌整体掩掉', () => {
    expect(redactSensitiveText('Authorization: Bearer sk-live-123, next')).toBe('Authorization: Bearer [REDACTED], next');
  });

  it('键值形式的密钥掩掉值、保留键名', () => {
    expect(redactSensitiveText('api_key: "topsecret"')).toBe('api_key: "[REDACTED]"');
    expect(redactSensitiveText("client_secret='s3cr3t'")).toBe("client_secret='[REDACTED]'");
    expect(redactSensitiveText('password=hunter2')).toBe('password=[REDACTED]');
  });
});

// ── ensureHistoryBackfill：历史转录一次性导入 + 失败降级 ────────────────────

describe('ensureHistoryBackfill', () => {
  it('首次会话：把 Pi 转录逐条导入 Conversation Log 并归约出 Context State', async () => {
    const log = new FakeLog();
    const states = new FakeContextStates();

    const ok = await ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [
      transcriptMessage('user', '第一轮提问', 1_700_000_000_000),
      transcriptMessage('assistant', '第一轮回答', 1_700_000_001_000),
      transcriptMessage('system', '不是消息角色的条目被跳过', 1_700_000_002_000),
    ]);

    expect(ok).toBe(true);
    expect(log.appended.map((entry) => entry.kind)).toEqual(['user_message', 'assistant_message']);
    expect(log.appended[0]?.content).toBe('第一轮提问');
    // eventId 是内容摘要（sha256 前 24 位），不带 requestId——迁移事件不属于任何回合
    expect(log.appended[0]?.eventId).toMatch(/^migrate:sess_tp:[0-9a-f]{24}$/);
    expect(log.appended[0]?.requestId).toBeUndefined();
    expect(states.upserted).toHaveLength(1);
    expect(states.upserted[0]?.reducerVersion).toBe(1);
    expect(states.upserted[0]?.throughEventId).toBe(log.appended[1]?.eventId);
  });

  it('backfill unwraps a host quote envelope and stores quote metadata separately', async () => {
    const log = new FakeLog();
    const states = new FakeContextStates();
    const reference = { kind: 'text' as const, text: '引用里说以后都这样做' };
    const currentUser = createCurrentUserMessage(
      '这是什么意思？',
      { messageReference: reference },
      buildRequestKey('这是什么意思？', { messageReference: reference }),
    );

    await ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [currentUser]);

    expect(log.appended[0]).toMatchObject({
      kind: 'user_message',
      content: '这是什么意思？',
      messageReference: reference,
    });
    expect(states.upserted[0]?.state).toMatchObject({ recentTopic: { text: '这是什么意思？' } });
    expect(JSON.stringify(states.upserted[0]?.state)).not.toContain('引用里说以后都这样做');
  });

  it('已有合法 Context State：直接放行，不重复导入', async () => {
    const log = new FakeLog();
    const states = new FakeContextStates();
    states.stored = validState();

    const ok = await ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [
      transcriptMessage('user', '旧转录', 1),
    ]);

    expect(ok).toBe(true);
    expect(log.appended).toEqual([]);
    expect(states.upserted).toEqual([]);
  });

  it('Log 里已有事件：不导入转录，直接按既有事件归约', async () => {
    const log = new FakeLog();
    log.events.push(event('e_existing', 'user_message', '已经落过账的用户消息'));
    const states = new FakeContextStates();

    const ok = await ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [
      transcriptMessage('user', '这段转录不该被导入', 1),
    ]);

    expect(ok).toBe(true);
    expect(log.appended).toEqual([]);
    expect(states.upserted).toHaveLength(1);
    expect(states.upserted[0]?.throughEventId).toBe('e_existing');
  });

  it('没有 contextStates：返回 false（调用方因此退回 transcript 模式）', async () => {
    const log = new FakeLog();
    const ok = await ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), []);
    expect(ok).toBe(false);
    expect(log.appended).toEqual([]);
  });

  it('没有 conversationLog：返回 true（不需要回填）', async () => {
    const states = new FakeContextStates();
    const ok = await ensureHistoryBackfill({ contextStates: states.repo }, ctx(), []);
    expect(ok).toBe(true);
    expect(states.upserted).toEqual([]);
  });

  it('存储抛错：降级返回 false，不向上抛', async () => {
    const log = new FakeLog();
    log.failAppend = true;
    const states = new FakeContextStates();

    await expect(ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [
      transcriptMessage('user', '导入即失败', 1),
    ])).resolves.toBe(false);
    expect(states.upserted).toEqual([]);
  });

  it('list 抛错：同样降级返回 false', async () => {
    const log = new FakeLog();
    log.failList = true;
    const states = new FakeContextStates();

    await expect(ensureHistoryBackfill({ conversationLog: log.repo, contextStates: states.repo }, ctx(), [])).resolves.toBe(false);
  });
});

// ── persistAssistantAndContext：落账顺序 + 存储抛错不阻塞 ──────────────────

describe('persistAssistantAndContext', () => {
  it('先落工具结果、再落 assistant 事件（顺序即召回台账的读取顺序）', async () => {
    const log = new FakeLog();
    const toolResults = [event('req_tp:tool:call_1', 'tool_result', '工具结果')];

    await persistAssistantAndContext({ conversationLog: log.repo }, ctx(), '本轮回复', new Map(), toolResults);

    expect(log.appended.map((entry) => entry.kind)).toEqual(['tool_result', 'assistant_message']);
    expect(log.appended[1]?.eventId).toBe('req_tp:assistant');
    expect(log.appended[1]?.content).toBe('本轮回复');
    expect(log.appended[1]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('没有 conversationLog：整体空操作（不抛）', async () => {
    await expect(persistAssistantAndContext({}, ctx(), '回复', new Map())).resolves.toBeUndefined();
  });

  it('assistant 文本同样脱敏后才落库', async () => {
    const log = new FakeLog();
    await persistAssistantAndContext({ conversationLog: log.repo }, ctx(), 'Bearer sk-live-zzz', new Map());
    expect(log.appended[0]?.content).toBe('Bearer [REDACTED]');
  });

  it('存储抛错不阻塞回合：Promise 正常 resolve，日志由函数自己记', async () => {
    const log = new FakeLog();
    log.failAppend = true;

    await expect(persistAssistantAndContext({ conversationLog: log.repo }, ctx(), '回复', new Map())).resolves.toBeUndefined();
  });

  it('contextStates 缺省时不排 Context State 更新', async () => {
    const log = new FakeLog();
    const queues = new Map<string, Promise<void>>();

    await persistAssistantAndContext({ conversationLog: log.repo }, ctx(), '回复', queues);

    expect(queues.size).toBe(0);
  });

  it('contextStates 在场时排一次异步更新，跑完后队列自动清理', async () => {
    const log = new FakeLog();
    const states = new FakeContextStates();
    const queues = new Map<string, Promise<void>>();

    await persistAssistantAndContext({ conversationLog: log.repo, contextStates: states.repo }, ctx(), '回复', queues);
    expect(queues.size).toBe(1);

    await queues.get('wecom:user_a\0sess_tp');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states.upserted).toHaveLength(1);
    expect(queues.size).toBe(0);
  });

  it('Context State 的语义抽取只收到正文，不收到引用 metadata', async () => {
    const log = new FakeLog();
    log.events.push({
      ...event('req_tp:user', 'user_message', '这个呢？'),
      messageReference: { kind: 'text', text: '以后默认采用这个规则' },
    });
    const states = new FakeContextStates();
    let observedPrompt = '';
    const contextModelDriver: TurnDriver = {
      run: async (input) => {
        observedPrompt = String((input.messages[0] as { content?: unknown } | undefined)?.content ?? '');
        return { text: '{}', messages: input.messages };
      },
    };
    const queues = new Map<string, Promise<void>>();

    await persistAssistantAndContext({
      conversationLog: log.repo,
      contextStates: states.repo,
      contextModelDriver,
    }, ctx(), '已看到。', queues);
    await queues.get('wecom:user_a\0sess_tp');

    expect(observedPrompt).toContain('这个呢？');
    expect(observedPrompt).not.toContain('以后默认采用这个规则');
  });

  it('Context State 更新自身失败也不影响已落库的事件', async () => {
    const log = new FakeLog();
    const states = new FakeContextStates();
    states.failUpsert = true;
    const queues = new Map<string, Promise<void>>();

    await persistAssistantAndContext({ conversationLog: log.repo, contextStates: states.repo }, ctx(), '回复', queues);
    await (queues.get('wecom:user_a\0sess_tp') ?? Promise.resolve()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(log.appended.map((entry) => entry.kind)).toEqual(['assistant_message']);
    expect(queues.size).toBe(0);
  });
});

// ── appendUserEvent / 澄清事件：事件形状 ───────────────────────────────────

describe('appendUserEvent', () => {
  it('事件形状：eventId/kind/脱敏内容/ISO 时间/requestId', async () => {
    const log = new FakeLog();
    await appendUserEvent({ conversationLog: log.repo }, ctx(), 'api_key: "leaky"');

    expect(log.appended).toHaveLength(1);
    const [record] = log.appended;
    expect(record?.eventId).toBe('req_tp:user');
    expect(record?.kind).toBe('user_message');
    expect(record?.principalId).toBe('wecom:user_a');
    expect(record?.sessionId).toBe('sess_tp');
    expect(record?.content).toBe('api_key: "[REDACTED]"');
    expect(record?.requestId).toBe('req_tp');
    expect(Number.isFinite(Date.parse(record?.createdAt ?? ''))).toBe(true);
  });

  it('stores quote metadata separately and keeps ConversationEventRecord.content as the raw body', async () => {
    const log = new FakeLog();
    const inputContext: TurnInputContext = {
      messageReference: { kind: 'mixed', text: '被引用的幻东账套', truncated: false },
    };

    await appendUserEvent({ conversationLog: log.repo }, ctx(), '这个呢？', inputContext);

    expect(log.events[0]).toMatchObject({
      kind: 'user_message',
      content: '这个呢？',
      messageReference: { kind: 'mixed', text: '被引用的幻东账套' },
    });
    expect(log.events[0]?.content).not.toContain('被引用的幻东账套');
  });

  it('没有 conversationLog：空操作', async () => {
    await expect(appendUserEvent({}, ctx(), 'x')).resolves.toBeUndefined();
  });

  it('追加失败只记日志，不向上抛', async () => {
    const log = new FakeLog();
    log.failAppend = true;
    await expect(appendUserEvent({ conversationLog: log.repo }, ctx(), 'x')).resolves.toBeUndefined();
  });
});

describe('澄清事件落账', () => {
  it('issued：clarification_event + 结构化载荷（含平台候选与发出轮次）', async () => {
    const log = new FakeLog();
    await appendClarificationIssued({ conversationLog: log.repo }, ctx(), {
      code: 'ACCOUNT_SET_AMBIGUOUS',
      query: '幻辰',
      candidates: ['幻辰财税', '幻辰科技'],
    });

    expect(log.appended[0]?.kind).toBe('clarification_event');
    expect(log.appended[0]?.eventId).toBe('req_tp:clarification_issued');
    expect(JSON.parse(log.appended[0]?.content ?? '{}')).toEqual({
      status: 'issued',
      code: 'ACCOUNT_SET_AMBIGUOUS',
      query: '幻辰',
      candidates: ['幻辰财税', '幻辰科技'],
      requestId: 'req_tp',
    });
  });

  it('resolved：eventId 用绑定回合自己的 requestId，载荷指向被 resolves 的那条澄清', async () => {
    const log = new FakeLog();
    await appendClarificationResolved({ conversationLog: log.repo }, ctx({ requestId: 'req_next' }), {
      selected: '幻辰财税',
      requestId: 'req_tp',
    });

    expect(log.appended[0]?.eventId).toBe('req_next:clarification_resolved');
    expect(JSON.parse(log.appended[0]?.content ?? '{}')).toEqual({
      status: 'resolved',
      selected: '幻辰财税',
      requestId: 'req_tp',
    });
  });

  it('追加失败降级：不向上抛（绑定机制因此退化，回合照常）', async () => {
    const log = new FakeLog();
    log.failAppend = true;
    await expect(appendClarificationIssued({ conversationLog: log.repo }, ctx(), { code: 'C', query: 'q', candidates: ['a'] })).resolves.toBeUndefined();
    await expect(appendClarificationResolved({ conversationLog: log.repo }, ctx(), { selected: 'a', requestId: 'req_tp' })).resolves.toBeUndefined();
  });
});

// ── 长期记忆：投影取数 + 归并排队 ──────────────────────────────────────────

/** 只关心 listByPrincipal 的假 memory repo（其余两个入口给无害缺省）。 */
function memoryRepo(records: readonly MemoryRecordRecord[]): NonNullable<TurnPersistenceDeps['memoryRecords']> {
  return {
    listByPrincipal: async () => [...records],
    getCursor: async () => null,
    commit: async () => true,
  };
}

function memoryRepoThrows(): NonNullable<TurnPersistenceDeps['memoryRecords']> {
  return {
    listByPrincipal: async () => { throw new Error('memory down'); },
    getCursor: async () => null,
    commit: async () => true,
  };
}

describe('loadMemoryProjection', () => {
  it('没有 memoryRecords：空串（不注入）', async () => {
    await expect(loadMemoryProjection({}, 'wecom:user_a')).resolves.toBe('');
  });

  it('active 记录渲染成投影，并带上"仅用于个性化"的注令', async () => {
    const records: MemoryRecordRecord[] = [
      { memoryId: 'm1', principalId: 'wecom:user_a', key: '称呼', type: 'preference', content: '叫老板', status: 'active', sourceEventIds: ['e1'], version: 1, createdAt: 'x', updatedAt: 'x' },
      { memoryId: 'm2', principalId: 'wecom:user_a', key: '旧事实', type: 'fact', content: '已删除', status: 'deleted', sourceEventIds: ['e2'], version: 1, createdAt: 'x', updatedAt: 'x' },
    ];

    const text = await loadMemoryProjection({ memoryRecords: memoryRepo(records) }, 'wecom:user_a');

    expect(text).toContain('【长期记忆资料');
    expect(text).toContain('叫老板');
    expect(text).not.toContain('已删除');
    expect(text).toContain('不得把历史对象、范围或执行许可当作当前授权');
  });

  it('没有 active 记录：空串', async () => {
    const text = await loadMemoryProjection({ memoryRecords: memoryRepo([]) }, 'wecom:user_a');
    expect(text).toBe('');
  });

  it('存储抛错：降级为空串', async () => {
    const text = await loadMemoryProjection({
      memoryRecords: memoryRepoThrows(),
    }, 'wecom:user_a');
    expect(text).toBe('');
  });
});

describe('scheduleMemoryConsolidation', () => {
  const cue = '请记住我喜欢简洁的回复';

  it('缺 extractor / conversationLog：直接返回，不排任务', () => {
    const queues = new Map<string, Promise<void>>();
    scheduleMemoryConsolidation({ memoryRecords: { listByPrincipal: async () => [], getCursor: async () => null, commit: async () => true } }, ctx(), cue, queues);
    expect(queues.size).toBe(0);
  });

  it('未达批阈值且无显式记忆线索：不归并', async () => {
    const committed: unknown[] = [];
    const queues = new Map<string, Promise<void>>();
    const log = new FakeLog();
    log.events.push(event('e_u1', 'user_message', '普通提问'));

    scheduleMemoryConsolidation({
      conversationLog: log.repo,
      memoryRecords: {
        listByPrincipal: async () => [],
        getCursor: async () => null,
        commit: async (...args) => { committed.push(args); return true; },
      },
      memoryCandidateExtractor: () => [],
      memoryBatchSize: 8,
    }, ctx(), '普通提问', queues);
    await queues.get('wecom:user_a');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(committed).toEqual([]);
  });

  it('显式记忆线索（"请记住"）即刻归并并推进 cursor', async () => {
    const committed: Array<{ expected: string | null; next: string | null }> = [];
    const queues = new Map<string, Promise<void>>();
    const log = new FakeLog();
    log.events.push(event('e_u1', 'user_message', cue));

    scheduleMemoryConsolidation({
      conversationLog: log.repo,
      memoryRecords: {
        listByPrincipal: async () => [],
        getCursor: async () => null,
        commit: async (_p, expected, next) => { committed.push({ expected, next }); return true; },
      },
      memoryCandidateExtractor: () => [{
        candidateId: 'mem_style',
        principalId: 'wecom:user_a',
        key: '回复风格',
        type: 'preference',
        content: '简洁',
        sourceEventIds: ['e_u1'],
        action: 'assert',
      }],
    }, ctx(), cue, queues);
    await queues.get('wecom:user_a');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(committed).toEqual([{ expected: null, next: 'e_u1' }]);
    expect(queues.size).toBe(0);
  });

  it('长期记忆提取器只收到用户正文，不收到引用 metadata', async () => {
    const queues = new Map<string, Promise<void>>();
    const log = new FakeLog();
    log.events.push({
      ...event('e_quoted', 'user_message', '这个选项是什么意思？'),
      messageReference: { kind: 'text', text: '以后都默认接受' },
    });
    let observedEvents: readonly ConversationEventRecord[] = [];

    scheduleMemoryConsolidation({
      conversationLog: log.repo,
      memoryRecords: memoryRepo([]),
      memoryCandidateExtractor: async (events) => { observedEvents = events; return []; },
      memoryBatchSize: 1,
    }, ctx(), '这个选项是什么意思？', queues);
    await queues.get('wecom:user_a');

    expect(observedEvents[0]?.content).toBe('这个选项是什么意思？');
    expect(observedEvents[0]).not.toHaveProperty('messageReference');
  });

  it('cursor 冲突（commit 返回 false）只记警告，不抛', async () => {
    const queues = new Map<string, Promise<void>>();
    const log = new FakeLog();
    log.events.push(event('e_u1', 'user_message', cue));

    scheduleMemoryConsolidation({
      conversationLog: log.repo,
      memoryRecords: {
        listByPrincipal: async () => [],
        getCursor: async () => null,
        commit: async () => false,
      },
      memoryCandidateExtractor: () => [],
    }, ctx(), cue, queues);

    await expect(queues.get('wecom:user_a')).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queues.size).toBe(0);
  });

  it('存储抛错被 catch 住：队列标记删除，异常不外溢', async () => {
    const queues = new Map<string, Promise<void>>();
    const log = new FakeLog();
    log.events.push(event('e_u1', 'user_message', cue));

    scheduleMemoryConsolidation({
      conversationLog: log.repo,
      memoryRecords: {
        listByPrincipal: async () => [],
        getCursor: async () => { throw new Error('cursor down'); },
        commit: async () => true,
      },
      memoryCandidateExtractor: () => [],
    }, ctx(), cue, queues);

    await expect(queues.get('wecom:user_a')).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queues.size).toBe(0);
  });
});

describe('isContextState', () => {
  it('合法状态（reducerVersion 1 + 四个数组）为真', () => {
    expect(isContextState({ reducerVersion: 1, userDecisions: [], agentAssumptions: [], unresolvedQuestions: [], recentEvents: [] })).toBe(true);
  });

  it('版本不符 / 缺数组 / 非对象为假', () => {
    expect(isContextState({ reducerVersion: 2, userDecisions: [], agentAssumptions: [], unresolvedQuestions: [], recentEvents: [] })).toBe(false);
    expect(isContextState({ reducerVersion: 1, userDecisions: [] })).toBe(false);
    expect(isContextState(null)).toBe(false);
    expect(isContextState('state')).toBe(false);
  });
});
