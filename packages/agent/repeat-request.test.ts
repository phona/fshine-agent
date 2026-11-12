import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_PATHS_MARKER,
  buildRequestKey,
  normalizeUserRequest,
} from './src/repeat-request';

/**
 * 请求归一化与身份键（requestKey）的表征锁（2026-11-12 申报层删除后收窄为活函数）。
 *
 * 原 findRepeatedDelegatedRequest / collectDelegatedRequestCounts 等转录分析函数随
 * 申报层整体删除（读者只有申报退回），其用例一并删除；判据由 RR1 窄门承接
 * （read：runtime.ts 的 exactRepeatIdentity；decision：turn-exit.ts 的 ①b）。
 */

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

describe('buildRequestKey', () => {
  it('引用 fingerprint 使用规范化 kind/text/truncated/sourceMessageId 字段', () => {
    const base = { kind: 'text' as const, text: '  幻东   202609 ', truncated: false, sourceMessageId: 'old-1' } as const;
    const equivalent = { kind: 'text' as const, text: '幻东 202609', truncated: false, sourceMessageId: 'old-1' } as const;
    expect(buildRequestKey(REQUEST, { messageReference: base })).toBe(buildRequestKey(REQUEST, { messageReference: equivalent }));
    expect(buildRequestKey(REQUEST, { messageReference: base })).not.toBe(
      buildRequestKey(REQUEST, { messageReference: { ...equivalent, sourceMessageId: 'old-2' } }),
    );
    expect(buildRequestKey(REQUEST, { messageReference: base })).not.toBe(
      buildRequestKey(REQUEST, { messageReference: { ...equivalent, truncated: true } }),
    );
    expect(buildRequestKey(REQUEST, { messageReference: base })).not.toBe(
      buildRequestKey(REQUEST, { messageReference: { ...equivalent, kind: 'mixed' } }),
    );
  });

  it('附件路径后缀不参与身份：同文不同附件数得到同一个 key（RR1 精确身份不被宿主注入干扰）', () => {
    expect(buildRequestKey(withAttachments(REQUEST, ['a.xlsx'])))
      .toBe(buildRequestKey(withAttachments(REQUEST, ['a.xlsx', 'b.xlsx', 'c.xlsx'])));
  });

  it('改写过的问句 = 不同身份（RR1 窄门不误伤普通聊天）', () => {
    expect(buildRequestKey('查一下幻东的应收账款余额')).not.toBe(buildRequestKey('刚才那个数是多少来着？'));
  });
});
