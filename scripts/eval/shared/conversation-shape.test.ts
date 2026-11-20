/**
 * 对话形态断言层的负例控制（四条规则逐条红 + 四合一 + 正常流零违规；2026-11-21 要求 D）。
 *
 * 纪律：负例是本模块的验收面——每条规则必须能被最小事件流打红，四条一起恰好 4 条违规，
 * 正常事件流零违规。改断言凑绿（放宽判据/删断言）在这里会直接被绊线抓住。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTurnPushStream,
  checkConversationShape,
  createDeliveryProvenanceAttributor,
  formatShapeViolations,
  type ConversationEvent,
  type DeliveryProvenanceTarget,
} from './conversation-shape';

const inbound = (messageId: string, text: string, at = 1000): ConversationEvent =>
  ({ kind: 'inbound', messageId, at, text });
const reply = (inReplyTo: string | undefined, text: string, at = 2000): ConversationEvent =>
  ({ kind: 'reply', inReplyTo, at, text });
const delivery = (text: string, at = 3000, provenance?: { taskId: string; factKind: 'completed' | 'failed' | 'cancelled' | 'waiting_user' | 'warning' }): ConversationEvent =>
  ({ kind: 'delivery', at, text, ...(provenance === undefined ? {} : { provenance}) });

describe('conversation-shape：逐条负例（每条规则必须能红）', () => {
  it('① inbound-reply-duplicate：同一条用户消息两条线程回复 → 恰此 code', () => {
    const violations = checkConversationShape({
      events: [
        inbound('m1', '帮我查一下销售明细 W1 的数据'),
        reply('m1', '查好了：共 3 条。'),
        reply('m1', '再说一遍：共 3 条。'),
      ],
    });
    expect(violations.map((violation) => violation.code)).toEqual(['inbound-reply-duplicate']);
    expect(violations[0]!.detail).toContain('m1');
    expect(violations[0]!.eventIndexes).toEqual([1, 2]);
  });

  it('② fact-delivered-twice：同一 (taskId, factKind) 两次投递 → 恰此 code', () => {
    const violations = checkConversationShape({
      events: [
        inbound('m1', '把 empty-one W1 里的记录删掉两条'),
        reply('m1', '已提交，稍后告诉你结果。'),
        delivery('「empty-one」办好了。', 3000, { taskId: 't1', factKind: 'completed' }),
        delivery('「empty-one」办好了。', 4000, { taskId: 't1', factKind: 'completed' }),
      ],
    });
    expect(violations.map((violation) => violation.code)).toEqual(['fact-delivered-twice']);
    expect(violations[0]!.detail).toContain('t1');
    expect(violations[0]!.detail).toContain('completed');
  });

  it('③ push-needs-subject：推送既无 ≥8 字原话片段也无任务名 → 恰此 code（线程回复不参与）', () => {
    const violations = checkConversationShape({
      events: [
        inbound('m1', '请帮我核对三季度的报销单'),
        reply('m1', '好的，这就去办。'),
        // 无锚点回复（主动推送）+ 无归属投递：都不自含话题 → 两条违规。
        reply(undefined, '有一件事要处理。', 5000),
        delivery('这个事情已经处理完了。', 6000),
      ],
    });
    expect(violations.map((violation) => violation.code)).toEqual(['push-needs-subject', 'push-needs-subject']);
    // 同一段原话出现在推送里 → 不再违规（≥8 字片段命中）。
    const withQuote = checkConversationShape({
      events: [
        inbound('m1', '请帮我核对三季度的报销单据和凭证'),
        delivery('关于「请帮我核对三季度的报销单」这件事：办完了。', 6000),
      ],
    });
    expect(withQuote).toEqual([]);
  });

  it('④ reply-misattached：挂到不存在的消息 / 时间倒挂 → 恰此 code（两个分支各一）', () => {
    const unknownTarget = checkConversationShape({
      events: [
        inbound('m1', '查一下 alpha 集合 W1'),
        reply('m-other', '这是别的消息的回复。'),
      ],
    });
    expect(unknownTarget.map((violation) => violation.code)).toEqual(['reply-misattached']);
    expect(unknownTarget[0]!.detail).toContain('m-other');

    const timeBackwards = checkConversationShape({
      events: [
        inbound('m1', '查一下 alpha 集合 W1', 5000),
        reply('m1', '查好了。', 4000),
      ],
    });
    expect(timeBackwards.map((violation) => violation.code)).toEqual(['reply-misattached']);
    expect(timeBackwards[0]!.detail).toContain('at=4000');
  });
});

describe('conversation-shape：组合与正常流', () => {
  it('四条负例一起进 → 恰好 4 条违规，四个 code 各一次', () => {
    const violations = checkConversationShape({
      events: [
        // ① 两条线程回复
        inbound('m1', '请帮我把 empty-one 集合 W1 窗口新增四条记录'),
        reply('m1', '收到，正在办理。', 1100),
        reply('m1', '再说一次：收到，正在办理。', 1200),
        // ③ 主动推送无话题（reply 无锚点）
        reply(undefined, '系统提示：请留意。', 1300),
        // ④ 挂到不存在的消息
        reply('m-ghost', '挂错的回复。', 1400),
        // ② 同一事实两次投递（正文自含原话片段，不另触 ③）
        delivery('empty-one 集合 W1 窗口办完了。', 1500, { taskId: 't9', factKind: 'completed' }),
        delivery('empty-one 集合 W1 窗口办完了。', 1600, { taskId: 't9', factKind: 'completed' }),
      ],
    });
    const codes = violations.map((violation) => violation.code);
    expect(codes).toHaveLength(4);
    expect(codes).toContain('inbound-reply-duplicate');
    expect(codes).toContain('fact-delivered-twice');
    expect(codes).toContain('push-needs-subject');
    expect(codes).toContain('reply-misattached');
  });

  it('正常事件流（线程回复 + 自含话题推送 + 单次投递）→ 零违规', () => {
    const violations = checkConversationShape({
      taskNames: ['empty-one 新增'],
      events: [
        inbound('m1', '请帮我把 empty-one 集合 W1 窗口新增四条记录', 1000),
        reply('m1', '好的，等提案来了我发你确认。', 1100),
        delivery('要写入：empty-one 新增 4 条记录。回「确认」我就提交。', 2000, { taskId: 't1', factKind: 'waiting_user' }),
        inbound('m2', '确认', 3000),
        reply('m2', '已提交，办完告诉你。', 3100),
        delivery('「empty-one 新增」办好了：4 条记录已写入。', 4000, { taskId: 't1', factKind: 'completed' }),
      ],
    });
    expect(violations).toEqual([]);
  });

  it('任务名判据：推送不含原话片段但含任务名 → 不违规；缺任务名 → 违规', () => {
    const events: ConversationEvent[] = [
      inbound('m1', '报告季度数据汇总情况'),
      delivery('季度数据汇总已生成，见附件。', 2000, { taskId: 't1', factKind: 'completed' }),
    ];
    expect(checkConversationShape({ events, taskNames: ['季度数据汇总'] })).toEqual([]);
    const violations = checkConversationShape({ events, taskNames: ['别的任务名'] });
    expect(violations.map((violation) => violation.code)).toEqual(['push-needs-subject']);
  });

  it('formatShapeViolations：逐条带 code 与上下文', () => {
    const text = formatShapeViolations(
      checkConversationShape({
        events: [inbound('m1', '查数据'), reply('m1', '好了'), reply('m1', '再说一次：好了')],
      }),
      '对话形态违规（用例 X）',
    );
    expect(text.startsWith('对话形态违规（用例 X）')).toBe(true);
    expect(text).toContain('[inbound-reply-duplicate]');
  });
});

describe('createDeliveryProvenanceAttributor：sent 行补填归属（② 的前提）', () => {
  const sentLine = (taskId: string, factKind: string): Record<string, unknown> =>
    ({ event: 'task_result_delivery_sent', taskId, factKind });

  it('sent 行补到最近一条未归属推送；failed/suppressed 不补；excluded 跳过', () => {
    const targets: Array<DeliveryProvenanceTarget & { text?: string }> = [
      { text: '推送1（文件占位）', excluded: true },
      { text: '推送2（更早的未归属推送）' },
      { text: '推送3（本次投递）' },
    ];
    const attribute = createDeliveryProvenanceAttributor(targets as Array<DeliveryProvenanceTarget>);
    attribute({ event: 'task_result_delivery_failed', taskId: 't1', factKind: 'failed' });
    expect(targets.every((target) => target.taskId === undefined)).toBe(true);
    attribute(sentLine('t1', 'completed'));
    expect(targets[1]!.taskId).toBeUndefined();
    expect(targets[2]).toMatchObject({ taskId: 't1', factKind: 'completed' });
    attribute(sentLine('t2', 'failed'));
    // 第二条 sent 补到更早那条未归属推送。
    expect(targets[1]).toMatchObject({ taskId: 't2', factKind: 'failed' });
    expect(targets[0]!.taskId).toBeUndefined();
  });

  it('缺 factKind 或缺 taskId 的 sent 行不补（不猜）', () => {
    const targets: Array<DeliveryProvenanceTarget> = [{}];
    const attribute = createDeliveryProvenanceAttributor(targets);
    attribute({ event: 'task_result_delivery_sent', taskId: 't1' });
    attribute({ event: 'task_result_delivery_sent', factKind: 'completed' });
    expect(targets[0]!.taskId).toBeUndefined();
    expect(targets[0]!.factKind).toBeUndefined();
  });
});

describe('buildTurnPushStream：回合面事件流构造', () => {
  it('回合 = inbound + 同锚点回复；推送 = delivery；按 at 排序', () => {
    const events = buildTurnPushStream(
      [
        { index: 1, userText: '请帮我核对三季度的报销单据', reply: '好的，正在核对。', atMs: 1000, durationMs: 100 },
        { index: 2, userText: '把结果发我邮箱一份', reply: '已发送。', atMs: 3000, durationMs: 50 },
      ],
      [
        { at: 2500, text: '三季度的报销单据里有两张待复核。' },
        { at: 4000, text: '三季度的报销单据已核对完。', taskId: 't1', factKind: 'completed' },
        { at: 4500, text: '文件占位', excluded: true },
      ],
    );
    expect(events.map((event) => event.kind)).toEqual([
      'inbound', 'reply', 'delivery', 'inbound', 'reply', 'delivery',
    ]);
    const inbound2 = events[3]!;
    const reply2 = events[4]!;
    expect(inbound2).toMatchObject({ kind: 'inbound', messageId: 'turn-2', at: 3000, text: '把结果发我邮箱一份' });
    expect(reply2).toMatchObject({ kind: 'reply', inReplyTo: 'turn-2', at: 3050 });
    expect(events[2]).toMatchObject({ kind: 'delivery', at: 2500, text: '三季度的报销单据里有两张待复核。' });
    expect(events[5]).toMatchObject({
      kind: 'delivery', at: 4000,
      provenance: { taskId: 't1', factKind: 'completed' },
    });
    // 构造出的流自身零违规（回复挂本回合、推送含原话）。
    expect(checkConversationShape({ events })).toEqual([]);
  });
});
