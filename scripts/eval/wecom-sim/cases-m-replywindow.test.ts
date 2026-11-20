/**
 * M 组·L1 通道语义：回复窗口过期（要求 C，2026-11-21 live 缺陷 B 的常跑化）· 自动用例。
 *
 * 场景（live 实测缺陷 B 的通道级复现）：慢回合的终稿到达时，原消息的回复上下文已被平台
 * 拒收（errcode 846608 一类）→ 适配器把终稿经 sendMessage 作为**新消息**发出。这条推送
 * 若不自含话题，客户端把它排到最新消息下面，读起来像答非所问（问报税收到「已停止」）。
 *
 * 机械判据（`replyFailureFrom: 2` = 第 2 次 replyStream 起假 SDK 拒收；第 1 条消息照常走
 * 流式回复作对照）：
 *   M-1① 终稿走主动推送：被拒终稿经 sendMessage 送达（proactiveTexts 恰 1 条，含终稿全文）；
 *   M-1② 推送文本自含原话片段（≥8 字）：形如 `回复「<原话>」：` + 空行 + 终稿（缺陷 B 修复形状）；
 *   M-1③ 每条用户消息最多一条回合回复（不重复）：第 1 条 = 1 条送达气泡、0 推送；
 *         第 2 条 = 1 条推送、0 送达气泡（被拒帧只是可观测的尝试，不算用户可见面）。
 * 既有组（A～L）断言零放宽：replyFailureFrom 缺省 undefined = 假 SDK 永不拒收，行为不变。
 */
import { describe, expect, it } from 'vitest';
import {
  mainRelayResponses,
  startWecomSim,
  workerQueryResponses,
} from './harness';

describe('M 组·L1 通道语义：回复窗口过期（终稿降级推送自含话题）', () => {
  it('M-1 第 2 次 reply 被拒：终稿走主动推送、文本自含原话片段、每条用户消息恰一条回合回复', async () => {
    const sim = await startWecomSim({ label: 'm1', replyFailureFrom: 2 });
    try {
      // 第 1 条消息（对照）：回复上下文仍有效 → 流式终帧照常送达。
      sim.book.mainTurn('帮我查一下 documents 集合 W202611 的数据', mainRelayResponses('查询 documents 集合 W202611 的记录'));
      sim.book.workerTask('查询 documents 集合 W202611 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      sim.sendText('帮我查一下 documents 集合 W202611 的数据');
      await sim.waitFor('第一回合终帧尝试', () => sim.sdk.bubbles.some((bubble) => bubble.finish && bubble.reqId === 'req-1'));
      // 入站帧按发送顺序编号 req-1 / req-2（harness 的 frameSeq），这里以机械事实定位。
      expect(sim.sdk.bubbles.filter((bubble) => bubble.finish && bubble.reqId === 'req-1' && bubble.rejected !== true))
        .toHaveLength(1);
      expect(sim.sdk.proactiveTexts).toHaveLength(0);

      // 第 2 条消息：终稿到达时回复上下文已被平台拒收（第 2 次 replyStream 起 reject）。
      sim.book.mainTurn('再查一下 alpha 集合 W1 的记录', mainRelayResponses('查询 alpha 集合 W1 的记录'));
      sim.book.workerTask('查询 alpha 集合 W1 的记录', workerQueryResponses('dummy.query', { '--collection': 'alpha', '--window': 'W1' }));
      const messageId = sim.sendText('再查一下 alpha 集合 W1 的记录');
      await sim.waitFor('降级主动推送到达', () => sim.sdk.proactiveTexts.length === 1);

      // ① 终稿走主动推送：恰一条推送，正文含被拒终稿的全文（终稿没丢、没改写）。
      const rejectedFinal = sim.sdk.bubbles.find((bubble) => bubble.finish && bubble.reqId === 'req-2');
      expect(rejectedFinal).toBeDefined();
      expect(rejectedFinal!.rejected).toBe(true);
      expect(sim.sdk.proactiveTexts).toHaveLength(1);
      // 单聊 conversationId = userid（适配器规则）：降级推送到同一会话。
      expect(sim.sdk.proactiveTexts[0]).toMatchObject({ kind: 'sendMessage', chatId: 'user-a' });
      const push = sim.sdk.proactiveTexts[0]!.content;
      expect(push).toContain(rejectedFinal!.content);

      // ② 推送文本自含原话片段（≥8 字）：引用行 + 空行 + 终稿，原话逐字未改写。
      const ORIGINAL = '再查一下 alpha 集合 W1 的记录';
      expect(push.startsWith(`回复「${ORIGINAL.slice(0, 10)}`)).toBe(true);
      expect(push).toBe(`回复「${ORIGINAL}」：\n\n${rejectedFinal!.content}`);

      // ③ 每条用户消息最多一条回合回复（不重复）：送达气泡恰好 1 条（第 1 条消息的）、
      //    主动推送恰好 1 条（第 2 条消息的）——被拒的终帧尝试不算用户可见面。
      const deliveredFinals = sim.sdk.bubbles.filter((bubble) => bubble.finish && bubble.rejected !== true);
      expect(deliveredFinals).toHaveLength(1);
      expect(deliveredFinals[0]!.reqId).toBe('req-1');
      // 第 2 条消息的回合真的跑过（降级不是替身绕过执行链）：真实执行事实在账。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(1);
      expect(done!.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
    } finally {
      await sim.close();
    }
  }, 90_000);
});
