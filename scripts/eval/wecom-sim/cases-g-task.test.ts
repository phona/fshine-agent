/**
 * G 组·任务面 / 异步（W-26～W-28）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 装配差异：任务派发 `taskDispatch: 'async'`（server 恒 async；受理即回执、后台 TaskRunner 执行、
 * 完成后宿主主动投递）+ `runtime.taskRunWaitMs`（B 切片短等待窗口）。
 *
 * 机械判据（用户可见结果；模型响应脚本化、执行层真实）：
 *   W-26  明显超窗的请求 → 受理回执**不含 `#`、不含编号数字**；任务在后台推进并最终 completed；
 *   W-27  完成后追问「刚才那个跑完了吗？」→ 纯查询（task_status），**不发起新的 execution**；
 *   W-28  快活（窗口内完成）→ 同回合直接给结果、**零受理回执**、零主动投递
 *         （回归钉子：防止 B 轨短等待窗口被破坏）。
 *
 * 时钟纪律：taskRunWaitMs 是产品侧真实短等待窗口（execution-runtime 的 waitForTaskSettled）；
 * 本组用「1ms 窗口 + 真子进程执行」确定性超窗、「1500ms 缺省窗口 + 真快查询」确定性落窗内，
 * 不写固定 sleep，也不注入第二套时钟。
 */
import { describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import {
  lastToolResultJsonOf,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  workerQueryResponses,
} from './harness';

/** 宿主任务 scope：单聊 conversationId 就是 userid（适配器口径），故会话键 = 用户键。 */
const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;

/** Main 转述受理回执（慢活）：话术逐字来自 task_run 的真实 notice。 */
const relayReceipt = (call: { messages: readonly unknown[] }) => {
  const result = lastToolResultJsonOf(call.messages);
  const notice = typeof result?.['notice'] === 'string' ? result['notice'] : '';
  if (notice === '') throw new Error('Main 脚本没有拿到 task_run 的受理回执（notice）。');
  return textAssistant(notice);
};

describe('G 组·任务面 / 异步（W-26～W-28）', () => {
  it('W-26 超窗请求：受理回执无编号，任务后台推进并最终完成；W-27 追问纯查询零执行', async () => {
    // 1ms 短等待窗口：真子进程执行必然超窗 → 走受理回执 + 后台推进路径。
    const sim = await startWecomSim({ label: 'w26', taskDispatch: 'async', taskRunWaitMs: 1 });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const taskText = '把销售明细按客户汇总，做成表，做完发我';
      sim.book.mainTurn('帮我把销售明细按客户汇总，做成表，做完发我', [
        toolCallAssistant('task_run', { task: taskText }),
        relayReceipt,
      ]);
      sim.book.workerTask(taskText, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      const w26 = sim.sendText('帮我把销售明细按客户汇总，做成表，做完发我');
      await sim.waitFor('W-26 受理回执终帧', () => sim.finalBubbles().length === 1);

      const receipt = sim.finalBubbles()[0]!.content;
      expect(receipt).toContain('已受理');
      expect(receipt).toContain('后台');
      // 受理回执去编号：不含 `#`，也不含任何编号数字（任务名本身无数字）。
      expect(receipt).not.toContain('#');
      expect(receipt).not.toMatch(/\d/);

      const done = sim.doneOf(w26)!;
      expect(done.taskIds).toHaveLength(1);
      const taskId = done.taskIds[0]!;
      // 任务在后台真实推进到 completed（读取宿主底账，不猜日志）。
      await sim.waitFor('任务后台 completed', () => registry.get(taskId, TASK_SCOPE).status === 'completed', 30_000);
      // 完成后宿主主动投递一次结果（用户可见）。
      await sim.waitFor('完成结果主动投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('documents W202611 共 3 条');

      // ── W-27：追问任务状态 = 纯查询，不发起新的 execution ─────────────────
      sim.book.mainTurn('刚才那个跑完了吗？', [
        toolCallAssistant('task_status', {}),
        (call) => {
          const listed = lastToolResultJsonOf(call.messages) as { tasks?: ReadonlyArray<{ status?: string }> } | undefined;
          const task = listed?.tasks?.[0];
          if (task?.status === undefined) throw new Error('task_status 没有返回任务状态。');
          return textAssistant(task.status === 'completed' ? '刚才那个任务已经完成了。' : `刚才那个任务的状态是 ${task.status}。`);
        },
      ]);
      const w27 = sim.sendText('刚才那个跑完了吗？');
      await sim.waitFor('W-27 终帧', () => sim.finalBubbles().length === 2);

      expect(sim.finalBubbles()[1]!.content).toContain('完成');
      // 纯查询：本回合零执行事实；也不再新增任务。
      const w27Done = sim.doneOf(w27)!;
      expect(w27Done.executions).toHaveLength(0);
      expect(w27Done.taskIds).toHaveLength(0);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);

  it('W-28 快活（缺省 1500ms 窗口内完成）：同回合给结果、零受理回执、零主动投递', async () => {
    const sim = await startWecomSim({ label: 'w28', taskDispatch: 'async', taskRunWaitMs: 1_500 });
    try {
      const taskText = '查一下 documents 集合 W202611 有多少条';
      sim.book.mainTurn('查一下 documents 集合 W202611 有多少条，直接告诉我', [
        toolCallAssistant('task_run', { task: taskText }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('快活没有同回合返回 summary（短等待窗口被破坏？）。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask(taskText, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      const messageId = sim.sendText('查一下 documents 集合 W202611 有多少条，直接告诉我');
      await sim.waitFor('W-28 结果终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // 同回合直接给结果（真实执行层数字）。
      expect(reply).toContain('documents W202611 共 3 条');
      expect(reply).toContain('1200');
      // 零受理回执：不出现「已受理/后台办理」这类受理话术。
      expect(reply).not.toContain('已受理');
      expect(reply).not.toContain('后台办理');
      // 零主动投递：结果已在本回合交给用户，完成回调不得重复发一遍。
      expect(sim.sdk.proactiveTexts).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);
      // 任务事实仍是一次受理（taskIds 有），但执行发生在后台任务里。
      expect(sim.doneOf(messageId)!.taskIds).toHaveLength(1);
    } finally {
      await sim.close();
    }
  }, 90_000);
});
