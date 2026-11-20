/**
 * N 组·对话形态守卫的活体性（要求 D，2026-11-21）· 自动用例。
 *
 * 这一组不测产品行为，测**守卫本身**：wecom-sim 的每用例对话形态断言
 * （harness 的 afterEach → scripts/eval/shared/conversation-shape.ts）必须
 *   N-1  在真实装配链跑完一个含主动投递的用例后给出零违规（守卫不冤枉既有绿样本）；
 *   N-2  在人为制造「同一任务同一事实投递两次」后给出 fact-delivered-twice
 *        （守卫能红；负例控制，防守卫退化成摆设）。
 * N-2 注入后解除自动守卫（disarmShapeGuard）由用例自行断言违规存在——守卫对正常用例
 * 依然全量生效；「不解除 → 用例变红 → 恢复」的端到端演示记录在提交报告里。
 */
import { describe, expect, it } from 'vitest';
import { startWecomSim, mainRelayResponses, workerQueryResponses, toolCallAssistant, textAssistant, lastToolResultJsonOf } from './harness';

const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;

/** G 组同形的受理卡（交办回合照发模型的话）。 */
const dispatchCard = (call: { messages: readonly unknown[] }) => {
  const result = lastToolResultJsonOf(call.messages);
  if (result?.['accepted'] !== true) throw new Error('task_run 没有回受理事实（accepted:true）。');
  return textAssistant('好的，这件事我交给后台去办，办好就发给你。');
};

/** 跑一个完整的异步任务用例（交办 → 后台完成 → 一次主动投递），返回夹具。 */
async function runDeliveredCase(label: string) {
  const sim = await startWecomSim({ label, taskDispatch: 'async', taskRunWaitMs: 1 });
  const taskText = '帮我把销售明细按客户汇总，做完发我';
  sim.book.mainTurn(taskText, [toolCallAssistant('task_run', { task: taskText }), dispatchCard]);
  sim.book.workerTask(taskText, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
  const messageId = sim.sendText(taskText);
  await sim.waitFor('交办回合结束', () => sim.doneOf(messageId) !== undefined, 15_000);
  await sim.waitFor('完成结果主动投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
  return sim;
}

describe('N 组·对话形态守卫的活体性（要求 D）', () => {
  it('N-1 真实装配链 + 一次主动投递：每用例守卫零违规（不冤枉绿样本）', async () => {
    const sim = await runDeliveredCase('n1');
    try {
      const results = sim.shapeViolations();
      for (const result of results) {
        expect(result.violations, `会话 ${result.conversationId} 应零违规`).toEqual([]);
      }
      // 投递归属确实补上了（② 的前提在真实链路里成立）：sent 记账行带 taskId/factKind。
      const sent = sim.logs.find((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toBeDefined();
      expect(sent!['taskId']).toEqual(expect.any(String));
      expect(sent!['factKind']).toBe('completed');
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('N-2 人为制造同事实二次投递：守卫给出 fact-delivered-twice（负例控制）', async () => {
    const sim = await runDeliveredCase('n2');
    try {
      const sent = sim.logs.find((line) => line['event'] === 'task_result_delivery_sent');
      expect(sent).toBeDefined();
      // 注入：同任务同事实再投一条（与宿主重复投递在夹具里的可见状态同形）。
      sim.injectDelivery({
        text: sim.sdk.proactiveTexts[0]!.content,
        taskId: String(sent!['taskId']),
        factKind: 'completed',
      });
      const codes = sim.shapeViolations().flatMap((result) => result.violations.map((violation) => violation.code));
      expect(codes).toContain('fact-delivered-twice');
      // 负例控制用例自行消费违规读数，解除自动守卫（ afterEach 不再抛）。
      sim.disarmShapeGuard();
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('N-3 注入带 taskId 原文的推送：泄漏扫描给出命中（守卫活体性；负例控制）', async () => {
    // 2026-11-21 用户可见面泄漏守卫（与三批共用 shared/internal-terms 单一入口）的活体性：
    // 人为把 taskId 原文（稳定性批次实测泄漏形态：task_ + ≥8 位标识段）送进用户可见面，
    // leakHits 必须给出命中；解除自动守卫后由本用例自行消费读数（afterEach 不再抛）。
    const sim = await runDeliveredCase('n3');
    try {
      sim.injectDelivery({
        text: '已请求停止（任务号 task_db2b3ca3），任务不会继续跑。',
        taskId: 'task_db2b3ca3-0000-0000-0000-000000000000',
        factKind: 'cancelled',
      });
      const markers = sim.leakHits().map((hit) => hit.marker);
      expect(markers).toContain('task_db2b3ca3');
      // 注入后解除自动守卫（afterEach 不再抛）。
      sim.disarmShapeGuard();
    } finally {
      await sim.close();
    }
  }, 60_000);
});
