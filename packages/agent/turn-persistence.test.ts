import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ConversationEventRecord, TrustedContext } from '@fshine/contracts';
import type { TurnInputContext } from '@fshine/contracts';
import { RUN_EXECUTION_TASK_TOOL } from './src/context';
import { createCurrentUserMessage } from './src/message-reference';
import { buildRequestKey } from './src/repeat-request';
import {
  appendClarificationIssued,
  appendClarificationResolved,
  appendUserEvent,
  ensureHistoryBackfill,
  extractDelegationToolResultEvents,
  persistAssistantAndContext,
  redactInternalIds,
  redactSensitiveText,
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
 *   · 历史转录一次性回填。
 *
 * 相位 1（T2）：Context State 增量更新、长期记忆投影与归并队列的用例随各自路径删除
 * （模块只留"会话历史本身的落账与一次性回填"）。
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

function event(eventId: string, kind: ConversationEventRecord['kind'], content: string): ConversationEventRecord {
  return { eventId, principalId: 'wecom:user_a', sessionId: 'sess_tp', kind, content, createdAt: '2026-10-12T00:00:00.000Z', requestId: 'req_tp' };
}

// ── extractDelegationToolResultEvents：委派工具结果的信封/纯文本两条路径 + 脱敏 + 截断 ──

describe('extractDelegationToolResultEvents：委派工具结果路径', () => {
  it('terminate 路径（委派工具信封）：取 text 字段并收回 taskId', () => {
    const { events, taskResults } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_1', JSON.stringify({ taskId: 'task_a1', text: '余额 42 元' })),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('余额 42 元');
    expect(events[0]?.kind).toBe('tool_result');
    expect(events[0]?.eventId).toBe('req_tp:tool:call_1');
    expect(events[0]?.requestId).toBe('req_tp');
    expect(taskResults).toEqual([{ taskId: 'task_a1', resultText: '余额 42 元' }]);
  });

  it('needs 路径（纠错环交还）：recorded=delegate 的信封同样只留 text', () => {
    const { events, taskResults } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_2', JSON.stringify({
        recorded: 'delegate',
        text: '子 Agent 本轮没有执行平台查询，还缺少信息：账套。',
        taskId: 'task_b2',
        needs: { missing: ['账套'], reason: '名称有歧义', suggestion: '给规范名' },
      })),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('子 Agent 本轮没有执行平台查询，还缺少信息：账套。');
    expect(taskResults).toEqual([{ taskId: 'task_b2', resultText: '子 Agent 本轮没有执行平台查询，还缺少信息：账套。' }]);
  });

  it('计划步路径（第N/M步交还）：信封里的 step/outcome 等协议字段不落库，只留 text', () => {
    const { events, taskResults } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_3', JSON.stringify({
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
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('第一步查完了');
    expect(events[0]?.content).not.toContain('step');
    expect(taskResults).toEqual([{ taskId: 'task_c3', resultText: '第一步查完了' }]);
  });

  it('非 JSON 的自然语言结果照常落库（不需要信封）', () => {
    const { events, taskResults } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_5', '一句普通文本结果'),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events[0]?.content).toBe('一句普通文本结果');
    expect(taskResults).toEqual([]);
  });

  it('content 段数组只取 type=text 的正文，其余段忽略', () => {
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_6', [
        { type: 'text', text: '第一段' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '第二段' },
      ]),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events[0]?.content).toBe('第一段\n第二段');
  });
});

describe('extractDelegationToolResultEvents：脱敏、截断与 id 组成', () => {
  it('内部 task_/plan_ id 换成占位符（内容里一个不留）', () => {
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_7', JSON.stringify({
        taskId: 'task_9f8e7d6c',
        text: '计划 plan_abc123 的第一步 task_9f8e7d6c 已开始',
      })),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events[0]?.content).toBe('计划 [PLAN_ID] 的第一步 [TASK_ID] 已开始');
    expect(events[0]?.content).not.toContain('plan_abc123');
    expect(events[0]?.content).not.toContain('task_9f8e7d6c');
    // taskId 只进 taskResults（存储侧串联），不进落库内容
    expect(JSON.stringify(events)).not.toContain('task_9f8e7d6c');
  });

  it('Bearer 令牌与 api_key 之类的键值被脱敏', () => {
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_8', 'Authorization: Bearer sk-live-abcdef\napi_key: "topsecret"'),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events[0]?.content).toContain('Bearer [REDACTED]');
    expect(events[0]?.content).not.toContain('sk-live-abcdef');
    expect(events[0]?.content).toContain('[REDACTED]');
    expect(events[0]?.content).not.toContain('topsecret');
  });

  it('内容截断到 20000 字符（截断在脱敏之后）', () => {
    const long = 'x'.repeat(20_050);
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_9', JSON.stringify({ taskId: 'task_t', text: long })),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events[0]?.content).toHaveLength(20_000);
  });

  it('toolCallId 缺失时 eventId 退回消息下标', () => {
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, undefined, '第一条'),
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_named', '第二条'),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events.map((entry) => entry.eventId)).toEqual(['req_tp:tool:0', 'req_tp:tool:call_named']);
  });

  it('createdAt 取消息自带的时间戳（数字），缺失时用当前时间', () => {
    const stamped = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_ts', '带时间戳', 1_700_000_000_000),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);
    expect(stamped.events[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());

    const before = Date.now();
    const unstamped = extractDelegationToolResultEvents([
      { role: 'toolResult', toolName: RUN_EXECUTION_TASK_TOOL, content: [{ type: 'text', text: '无时间戳' }] } as unknown as AgentMessage,
    ], ctx(), RUN_EXECUTION_TASK_TOOL);
    expect(Date.parse(unstamped.events[0]?.createdAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('脱敏后为空的工具结果不落事件', () => {
    const { events } = extractDelegationToolResultEvents([
      toolResult(RUN_EXECUTION_TASK_TOOL, 'call_empty', '   \n  '),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

    expect(events).toEqual([]);
  });

  it('非委派/非申报工具的结果与普通 assistant/user 消息都不落 tool_result', () => {
    const { events } = extractDelegationToolResultEvents([
      { role: 'user', content: '用户消息', timestamp: 1 } as unknown as AgentMessage,
      { role: 'assistant', content: '助手消息', timestamp: 2 } as unknown as AgentMessage,
      toolResult('some_other_tool', 'call_h', '其他工具结果'),
      toolResult('read', 'call_m', '文件内容'),
    ], ctx(), RUN_EXECUTION_TASK_TOOL);

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
  it('首次会话：把 Pi 转录逐条导入 Conversation Log（不再派生任何状态）', async () => {
    const log = new FakeLog();

    const ok = await ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [
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
  });

  it('backfill unwraps a host quote envelope and stores quote metadata separately', async () => {
    const log = new FakeLog();
    const reference = { kind: 'text' as const, text: '引用里说以后都这样做' };
    const currentUser = createCurrentUserMessage(
      '这是什么意思？',
      { messageReference: reference },
      buildRequestKey('这是什么意思？', { messageReference: reference }),
    );

    await ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [currentUser]);

    expect(log.appended[0]).toMatchObject({
      kind: 'user_message',
      content: '这是什么意思？',
      messageReference: reference,
    });
    expect(log.appended[0]?.content).not.toContain('引用里说以后都这样做');
  });

  it('Log 里已有事件：不导入转录', async () => {
    const log = new FakeLog();
    log.events.push(event('e_existing', 'user_message', '已经落过账的用户消息'));

    const ok = await ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [
      transcriptMessage('user', '这段转录不该被导入', 1),
    ]);

    expect(ok).toBe(true);
    expect(log.appended).toEqual([]);
  });

  it('没有 contextStates：照常导入并返回 true（相位 1 起 transcript 是唯一模式）', async () => {
    const log = new FakeLog();
    const ok = await ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [
      transcriptMessage('user', '第一轮提问', 1),
    ]);
    expect(ok).toBe(true);
    expect(log.appended.map((entry) => entry.kind)).toEqual(['user_message']);
  });

  it('没有 conversationLog：返回 true（不需要回填）', async () => {
    const ok = await ensureHistoryBackfill({}, ctx(), []);
    expect(ok).toBe(true);
  });

  it('存储抛错：降级返回 false，不向上抛', async () => {
    const log = new FakeLog();
    log.failAppend = true;

    await expect(ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [
      transcriptMessage('user', '导入即失败', 1),
    ])).resolves.toBe(false);
  });

  it('list 抛错：同样降级返回 false', async () => {
    const log = new FakeLog();
    log.failList = true;

    await expect(ensureHistoryBackfill({ conversationLog: log.repo }, ctx(), [])).resolves.toBe(false);
  });
});

// ── persistAssistantAndContext：落账顺序 + 存储抛错不阻塞 ──────────────────

describe('persistAssistantAndContext', () => {
  it('先落工具结果、再落 assistant 事件（顺序即召回台账的读取顺序）', async () => {
    const log = new FakeLog();
    const toolResults = [event('req_tp:tool:call_1', 'tool_result', '工具结果')];

    await persistAssistantAndContext({ conversationLog: log.repo }, ctx(), '本轮回复', toolResults);

    expect(log.appended.map((entry) => entry.kind)).toEqual(['tool_result', 'assistant_message']);
    expect(log.appended[1]?.eventId).toBe('req_tp:assistant');
    expect(log.appended[1]?.content).toBe('本轮回复');
    expect(log.appended[1]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('没有 conversationLog：整体空操作（不抛）', async () => {
    await expect(persistAssistantAndContext({}, ctx(), '回复')).resolves.toBeUndefined();
  });

  it('assistant 文本同样脱敏后才落库', async () => {
    const log = new FakeLog();
    await persistAssistantAndContext({ conversationLog: log.repo }, ctx(), 'Bearer sk-live-zzz');
    expect(log.appended[0]?.content).toBe('Bearer [REDACTED]');
  });

  it('存储抛错不阻塞回合：Promise 正常 resolve，日志由函数自己记', async () => {
    const log = new FakeLog();
    log.failAppend = true;

    await expect(persistAssistantAndContext({ conversationLog: log.repo }, ctx(), '回复')).resolves.toBeUndefined();
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
