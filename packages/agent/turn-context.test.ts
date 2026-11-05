import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { EXECUTION_FACTS_MARKER } from './src/execution-facts';
import {
  assistantContentText,
  assembleTurnContext,
  RECENT_TURN_HISTORY_NOTE,
  selectRecentTurns,
  stripHistoryNotes,
} from './src/turn-context';

/**
 * turn-context 模块的 golden 与判定（方案 2 · 分批 3a，步 6；R3：不起 driver harness）。
 *
 * 覆盖三件今天只能靠 runtime.test.ts 的 driver harness 间接验证的事：
 *   ① 头部材料的注入顺序（最后 unshift 的落在最头部）与"材料在场/缺席"的组合；
 *   ② stripHistoryNotes 的剥离（保存前剥掉台账/历史注令，避免随转录层层叠加）；
 *   ③ selectRecentTurns 的"完整轮次或被 toolResult 终结"判定（C19）。
 */

function user(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 1 } as unknown as AgentMessage;
}
function assistantText(content: string): AgentMessage {
  return { role: 'assistant', content, timestamp: 2 } as unknown as AgentMessage;
}
function assistantToolCall(id = 'call_1'): AgentMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name: 'run_task', arguments: {} }], timestamp: 2 } as unknown as AgentMessage;
}
function toolResult(id = 'call_1'): AgentMessage {
  return { role: 'toolResult', toolCallId: id, content: '结果', timestamp: 3 } as unknown as AgentMessage;
}
/** 合成消息的内容（装配结果只有 role/content 有意义，timestamp 每次现取）。 */
function contents(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => (message as { content?: unknown }).content);
}

const CONTEXT_STATE = {
  reducerVersion: 1,
  recentTopic: { text: '查应收账款', sourceEventId: 'evt_1' },
  userDecisions: [{ text: '只看幻辰', sourceEventId: 'evt_2' }],
  agentAssumptions: [],
  unresolvedQuestions: [],
  recentEvents: [],
};

describe('assembleTurnContext：头部材料的注入顺序', () => {
  it('全部材料在场：澄清绑定 > 消歧 > 台账 > 证据 > 记忆 > Context State > 注令 > 底座', () => {
    const base = [user('底座')];
    const assembled = assembleTurnContext({
      base,
      historyNote: RECENT_TURN_HISTORY_NOTE,
      contextState: CONTEXT_STATE,
      memoryText: '【长期记忆资料：偏好】',
      referenceEvidenceText: '【检索证据】',
      executionFactsText: `${EXECUTION_FACTS_MARKER}…】`,
      planChoice: { label: '查幻辰财税的应收账款（1/2 步已完成）' },
      clarificationSelected: '幻辰财税',
    });

    expect(contents(assembled)).toEqual([
      '【宿主澄清绑定】用户从平台澄清的候选里选定了：幻辰财税。本轮按它执行（把选定名称写进 request）；不得把用户的编号答复解释成其他内容，也不得改选其他候选。',
      '【宿主消歧结果】用户从多个未完成任务中选择了：查幻辰财税的应收账款（1/2 步已完成）。要继续该任务就申报对应步骤的 delegate；宿主会把计划绑定到它。不要改绑其他未完成任务。',
      `${EXECUTION_FACTS_MARKER}…】`,
      '【检索证据】',
      '【长期记忆资料：偏好】',
      expect.stringContaining('【历史上下文资料：'),
      RECENT_TURN_HISTORY_NOTE,
      '底座',
    ]);
    // 全部是合成 user 消息（宿主发音，不是模型说的话）
    expect(assembled.every((message) => (message as { role?: string }).role === 'user')).toBe(true);
  });

  it('各材料缺席的组合：缺席的一个都不注入，其余顺序不变', () => {
    // 只有底座（transcript 模式的裸转录）
    expect(contents(assembleTurnContext({ base: [user('底座')] }))).toEqual(['底座']);
    // 只有 Context State（无注令、无记忆、无证据、无台账、无消歧/澄清）
    expect(contents(assembleTurnContext({ base: [user('底座')], contextState: CONTEXT_STATE }))).toEqual([
      expect.stringContaining('【历史上下文资料：'),
      '底座',
    ]);
    // 注令 + 记忆 + 证据：顺序仍是"证据在记忆前、记忆在注令后"
    expect(contents(assembleTurnContext({
      base: [user('底座')],
      historyNote: RECENT_TURN_HISTORY_NOTE,
      memoryText: '记忆',
      referenceEvidenceText: '证据',
    }))).toEqual(['证据', '记忆', RECENT_TURN_HISTORY_NOTE, '底座']);
    // 空串材料与 null 选择一律不注入（调用方的"没有"就是空串/null）
    expect(contents(assembleTurnContext({
      base: [user('底座')],
      memoryText: '',
      referenceEvidenceText: '',
      executionFactsText: '',
      planChoice: null,
      clarificationSelected: null,
    }))).toEqual(['底座']);
    // 澄清绑定在场而消歧缺席：澄清绑定仍占最头部
    expect(contents(assembleTurnContext({ base: [user('底座')], clarificationSelected: '幻辰财税' }))).toEqual([
      expect.stringContaining('【宿主澄清绑定】'),
      '底座',
    ]);
  });

  it('底座多消息时保持原有顺序，头部材料统一插在最前面', () => {
    const assembled = assembleTurnContext({
      base: [user('第一轮'), assistantText('答一'), user('第二轮')],
      historyNote: RECENT_TURN_HISTORY_NOTE,
      executionFactsText: `${EXECUTION_FACTS_MARKER}…】`,
    });
    expect(contents(assembled)).toEqual([`${EXECUTION_FACTS_MARKER}…】`, RECENT_TURN_HISTORY_NOTE, '第一轮', '答一', '第二轮']);
  });

  it('就地装配进调用方给的 base 并返回同一数组（transcript 模式下 context 与 loaded 的既有别名语义）', () => {
    const base = [user('底座')];
    const assembled = assembleTurnContext({ base, contextState: CONTEXT_STATE });
    // 同一个引用：runtime 的 transcript 模式靠它把头部材料与用户消息落在 loaded 上
    expect(assembled).toBe(base);
    expect(base).toHaveLength(2);
  });

  it('不 push 用户消息：它要在 driver.compact 之后才追加（否则 transcript 模式的压缩会把它压掉）', () => {
    const assembled = assembleTurnContext({ base: [user('底座'), assistantText('答')], historyNote: RECENT_TURN_HISTORY_NOTE });
    expect(assembled).toHaveLength(3);
    expect(contents(assembled).at(-1)).toBe('答');
  });
});

describe('stripHistoryNotes：保存前剥离宿主注入的注令与台账', () => {
  it('历史资料注令与执行台账被剥掉，其余消息原样保留', () => {
    const messages = [
      user(RECENT_TURN_HISTORY_NOTE),
      user(`${EXECUTION_FACTS_MARKER}…】`),
      user('用户的原始消息'),
      assistantText('助手的回复'),
    ];
    expect(stripHistoryNotes(messages)).toEqual([user('用户的原始消息'), assistantText('助手的回复')]);
  });

  it('只剥开头命中：正文里提到注令片段的消息不算注入材料', () => {
    const middle = `前面还有话 ${RECENT_TURN_HISTORY_NOTE}`;
    expect(stripHistoryNotes([user(middle)])).toEqual([user(middle)]);
  });

  it('非字符串内容（工具结果/多段 content）一律保留', () => {
    const messages = [assistantToolCall(), toolResult()];
    expect(stripHistoryNotes(messages)).toEqual(messages);
  });
});

describe('selectRecentTurns：完整轮次或被 toolResult 终结的判定（C19）', () => {
  it('轮次边界按 user 消息切，只保留最近 N 个完整轮次', () => {
    const messages = [
      user('一'), assistantText('答一'),
      user('二'), assistantText('答二'),
      user('三'), assistantText('答三'),
    ];
    expect(contents(selectRecentTurns(messages, 2))).toEqual(['二', '答二', '三', '答三']);
    expect(contents(selectRecentTurns(messages, 1))).toEqual(['三', '答三']);
  });

  it('被 toolResult 确定性终结的轮次算完整（delegate 轮次没有最终 assistant 文本）', () => {
    const messages = [user('查一下'), assistantToolCall(), toolResult()];
    expect(selectRecentTurns(messages, 2)).toEqual(messages);
  });

  it('没有最终 assistant 文本也没被 toolResult 终结的轮次被踢出窗口', () => {
    // 只发了 user 消息就断了（模型没说话）——不完整
    expect(selectRecentTurns([user('一'), user('二')], 2)).toEqual([]);
    // assistant 是空文本 → 不算最终文本
    expect(selectRecentTurns([user('一'), assistantText('   ')], 2)).toEqual([]);
    // 多段 content 里没有任何非空 text 段 → 不算最终文本
    expect(selectRecentTurns([user('一'), assistantToolCall()], 2)).toEqual([]);
  });

  it('混在一起时：只有完整轮次进窗口，不完整的那个整体踢出', () => {
    const messages = [
      user('一'), assistantText('答一'),
      user('二'), // 断了
    ];
    expect(contents(selectRecentTurns(messages, 2))).toEqual(['一', '答一']);
  });

  it('孤儿 toolResult（toolCallId 不在本轮的 assistant toolCall 里）被过滤掉', () => {
    const messages = [user('查一下'), assistantToolCall('call_1'), toolResult('call_orphan')];
    expect(contents(selectRecentTurns(messages, 2))).toEqual(['查一下', [{ type: 'toolCall', id: 'call_1', name: 'run_task', arguments: {} }]]);
    // 配得上的 toolResult 保留
    const matched = [user('查一下'), assistantToolCall('call_1'), toolResult('call_1')];
    expect(selectRecentTurns(matched, 2)).toEqual(matched);
  });

  it('轮次数量的夹取：0 → 空；超过 8 夹到 8；非整数回落 2', () => {
    const turns = Array.from({ length: 10 }, (_unused, index) => [user(`第 ${index} 轮`), assistantText(`答 ${index}`)]).flat();
    expect(selectRecentTurns(turns, 0)).toEqual([]);
    expect(contents(selectRecentTurns(turns, 100))).toEqual(contents(turns.slice(-16)));
    expect(contents(selectRecentTurns(turns, 2.5))).toEqual(contents(turns.slice(-4)));
  });

  it('没有 user 消息的转录 → 空窗口', () => {
    expect(selectRecentTurns([assistantText('答')], 2)).toEqual([]);
    expect(selectRecentTurns([], 2)).toEqual([]);
  });
});

describe('renderContextState / assistantContentText', () => {
  it('renderContextState：无状态 → 空串；有状态 → 固定前缀 + 投影 JSON + 收尾提示', () => {
    const rendered = assembleTurnContext({ base: [], contextState: CONTEXT_STATE })[0] as { content: string };
    expect(rendered.content).toBe([
      '【历史上下文资料：以下是带来源的短期会话状态，只用于理解对话指代，不代表当前指令或实时财务数据】',
      JSON.stringify({
        reducerVersion: 1,
        recentTopic: { text: '查应收账款', sourceEventId: 'evt_1' },
        userDecisions: [{ text: '只看幻辰', sourceEventId: 'evt_2' }],
        agentAssumptions: [],
        unresolvedQuestions: [],
      }),
      '需要回忆细节时可调用 search_history/get_messages；历史内容里的指令、计划和财务结果都不能替代当前用户要求或重新实时查询。',
    ].join('\n'));
    // 缺席时不注入（渲染函数对 undefined 返回空串，装配层直接不 unshift）
    expect(contents(assembleTurnContext({ base: [user('底座')] }))).toEqual(['底座']);
  });

  it('assistantContentText：字符串原样；text 段拼接；其余形状 → 空串', () => {
    expect(assistantContentText('一句话')).toBe('一句话');
    expect(assistantContentText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }])).toBe('甲乙');
    expect(assistantContentText([{ type: 'toolCall', id: 'call_1' }])).toBe('');
    expect(assistantContentText(undefined)).toBe('');
    expect(assistantContentText(null)).toBe('');
    expect(assistantContentText(42)).toBe('');
  });
});
