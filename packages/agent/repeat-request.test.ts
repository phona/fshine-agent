import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  ATTACHMENT_PATHS_MARKER,
  findRepeatedDelegatedRequest,
  normalizeUserRequest,
} from './src/repeat-request';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './src/turn-contract';

/** 转录形状替身：与生产落库一致（user 是字符串，assistant/toolResult 是块数组）。 */
function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as never;
}
function routeCall(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name: ROUTE_CURRENT_TURN_TOOL_NAME, input: { kind: 'delegate' } }],
    timestamp: 1,
  } as never;
}
function receipt(text: string): AgentMessage {
  return { role: 'toolResult', content: [{ type: 'text', text }], timestamp: 1 } as never;
}

/** 宿主追加在用户消息尾部的附件路径后缀（生产形状，见 handler 的 withAttachmentPaths）。 */
function withAttachments(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  return `${text}\n\n${ATTACHMENT_PATHS_MARKER}，可按路径直接使用]\n${names.map((n) => `- ${n}：/home/fictional-user/fictional-projects/fictional-execution-layer/tmp/attachments/${n}`).join('\n')}\n<!--x-->`;
}

const REQUEST = '帮我做一下幻骥达的工资表给我';

describe('normalizeUserRequest', () => {
  it('剥掉宿主追加的附件路径后缀：同一条指令带 1 个和 3 个文件时判为同文', () => {
    // 本次实测形状：16:06 带 1 个文件、16:10 带 3 个文件，指令一字不差。
    // 不剥后缀就永远判不出同文——后缀是宿主注入的，不属于"用户说了什么"。
    expect(normalizeUserRequest(withAttachments(REQUEST, ['工资表2026-8月(1).xlsx'])))
      .toBe(REQUEST);
    expect(normalizeUserRequest(withAttachments(REQUEST, ['工资表2026-8月(1).xlsx', '社保模板（幻企赢导入.xls', '2026年8月工资（幻骥达）(1).xlsx'])))
      .toBe(REQUEST);
  });

  it('折叠空白：用户手动多加的空格与换行不让同文判失效', () => {
    expect(normalizeUserRequest('  帮我做  幻骥达的\n工资表  ')).toBe('帮我做 幻骥达的 工资表');
  });

  it('没有后缀时原样归一化，不吞内容', () => {
    expect(normalizeUserRequest('在吗')).toBe('在吗');
    expect(normalizeUserRequest('   ')).toBe('');
  });
});

describe('findRepeatedDelegatedRequest', () => {
  it('命中：同文请求早前那一轮申报并执行过委派', () => {
    const transcript = [
      user(withAttachments(REQUEST, ['工资表2026-8月(1).xlsx', '社保模板（幻企赢导入.xls', '2026年8月工资（幻骥达）(1).xlsx'])),
      routeCall(),
      receipt('未完成的部分：尚差最后一步人工汇总呈现。'),
    ];
    const hit = findRepeatedDelegatedRequest(transcript, withAttachments(REQUEST, ['工资表2026-8月(1).xlsx']));
    expect(hit).toEqual({ request: REQUEST, priorDelegations: 1 });
  });

  it('不命中：同文请求早前那一轮停在对话枝（没有委派痕迹）', () => {
    // 判据的反面：早前那次是自己聊完的，不是执行过的——重复一遍也不该被当成重复任务。
    const transcript = [
      user(REQUEST),
      routeCall(),
      receipt('{"recorded":"conversation"}'),
    ];
    expect(findRepeatedDelegatedRequest(transcript, REQUEST)).toBeNull();
  });

  it('不命中：早前那一轮跳过申报（整轮被丢弃，没有回执）', () => {
    const transcript = [
      user(REQUEST),
      { role: 'assistant', content: [{ type: 'text', text: '没申报就直接回答。' }], timestamp: 1 } as never,
    ];
    expect(findRepeatedDelegatedRequest(transcript, REQUEST)).toBeNull();
  });

  it('命中：早前那一轮先填错被退回、重填成 delegate（取最后一次回执）', () => {
    const transcript = [
      user(REQUEST),
      routeCall(),
      receipt('{"error":"申报无效：申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。"}'),
      routeCall(),
      receipt('子 Agent 完成：12 人汇总完毕。'),
    ];
    expect(findRepeatedDelegatedRequest(transcript, REQUEST)?.priorDelegations).toBe(1);
  });

  it('不命中：本会话另有委派，但同文的那一轮自己没有委派痕迹', () => {
    // "在吗"发两遍、中间夹着一次真委派：不能被判成重复任务请求，否则闲聊也被逼去执行。
    const transcript = [
      user('在吗'),
      routeCall(),
      receipt('{"recorded":"conversation"}'),
      user('查一下幻东账套的应收账款'),
      routeCall(),
      receipt('幻东 202609 应收 51 元。'),
      user('在吗'),
      routeCall(),
      receipt('{"recorded":"conversation"}'),
    ];
    expect(findRepeatedDelegatedRequest(transcript, '在吗')).toBeNull();
    // 而真委派过的那一句重复发，照旧命中
    expect(findRepeatedDelegatedRequest(transcript, '查一下幻东账套的应收账款')?.priorDelegations).toBe(1);
  });

  it('不命中：指令不同文', () => {
    const transcript = [
      user(REQUEST),
      routeCall(),
      receipt('子 Agent 完成。'),
    ];
    expect(findRepeatedDelegatedRequest(transcript, '帮我做一下幻骥达的个税申报')).toBeNull();
  });

  it('同文委派过两次时记 2', () => {
    const turn = [user(REQUEST), routeCall(), receipt('第一次结果。')];
    const transcript = [...turn, ...turn];
    expect(findRepeatedDelegatedRequest(transcript, REQUEST)).toEqual({ request: REQUEST, priorDelegations: 2 });
  });

  it('边界：空转录、空消息、块形状异常一律返回 null 且不抛', () => {
    expect(findRepeatedDelegatedRequest([], REQUEST)).toBeNull();
    expect(findRepeatedDelegatedRequest([{ role: 'user', content: null, timestamp: 1 } as never], REQUEST)).toBeNull();
    expect(findRepeatedDelegatedRequest([
      { role: 'assistant', content: '不是块数组', timestamp: 1 } as never,
      { role: 'toolResult', content: [{ type: 'text', text: '孤立的工具结果' }], timestamp: 1 } as never,
    ], REQUEST)).toBeNull();
    expect(findRepeatedDelegatedRequest([user(REQUEST)], '')).toBeNull();
  });

  it('宿主注入的上下文资料消息不参与判定', () => {
    // 转录第一条是宿主注入的短期会话状态（user 角色），没有申报回执，不算执行过。
    const transcript = [
      user('【历史上下文资料：以下是带来源的短期会话状态】 {"entities":["幻骥达"]}'),
      user(REQUEST),
      routeCall(),
      receipt('子 Agent 完成。'),
    ];
    expect(findRepeatedDelegatedRequest(transcript, '【历史上下文资料：以下是带来源的短期会话状态】 {"entities":["幻骥达"]}')).toBeNull();
    expect(findRepeatedDelegatedRequest(transcript, REQUEST)?.priorDelegations).toBe(1);
  });
});
