/**
 * T7 主驱动模型错误分流：上下文超限 vs 瞬时错误。
 *
 * 长窗臂的空回复不是"模型不想答"：供应商把请求按 `stopReason=error` 返回时，主驱动
 * 原先把 errorMessage 整段吞掉、只交回空文本，宿主兜底成「查询失败」。两类错误要分开：
 *   · 上下文超限（*overflow*）——重试同一条请求没有意义，必须先压缩再重发；
 *   · 瞬时错误（rate limit / 5xx / 网络）——可以按有界延迟原地重试。
 * 判据必须是供应商话术的机械识别，不能把限流/欠费误当溢出（那会白跑一次压缩）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { shouldNudgeFinalReply } from './src/pi-driver';

// 供应商溢出话术的宿主分类器（isContextOverflowError）已随「自研 Overflow Recovery」整体删除：
// 溢出判定与恢复归 Pi 原生（AgentHarness 的 compaction reason=overflow，见 A 口径）。

/**
 * 空回复的第二种形状（今天实测日志）：`stopReason=stop`、content 只有 thinking 块、
 * 没有 text 块。这不是供应商错误，也不是窗口爆了——是模型只输出了思考过程。
 * 判据必须只认这个形状：有正文不催、toolResult 终结不催、error/aborted 不催
 * （那两类不是"模型拒绝收尾"，催了只会白烧一次调用）。
 */
describe('T7 只输出思考没有正文时的收尾催问', () => {
  const assistant = (content: unknown[], stopReason = 'stop'): AgentMessage => ({
    role: 'assistant', content, stopReason, timestamp: 1,
  } as unknown as AgentMessage);

  it('thinking-only 的 stop 回复：需要催一次最终文本', () => {
    expect(shouldNudgeFinalReply([assistant([{ type: 'thinking', thinking: '再想想' }])], '')).toBe(true);
  });

  it('空 content 的 stop 回复：需要催', () => {
    expect(shouldNudgeFinalReply([assistant([])], '')).toBe(true);
  });

  it('已有正文：不催（正常回复不许被二次调用改写）', () => {
    expect(shouldNudgeFinalReply([assistant([{ type: 'text', text: '已查到 900' }])], '已查到 900')).toBe(false);
  });

  it('toolResult 终结 / 错误或中止的 assistant：不催（不是"只思考没正文"）', () => {
    expect(shouldNudgeFinalReply([{ role: 'toolResult', content: '终稿' } as unknown as AgentMessage], '')).toBe(false);
    expect(shouldNudgeFinalReply([assistant([{ type: 'thinking', thinking: 'x' }], 'error')], '')).toBe(false);
    expect(shouldNudgeFinalReply([assistant([{ type: 'thinking', thinking: 'x' }], 'aborted')], '')).toBe(false);
  });
});
