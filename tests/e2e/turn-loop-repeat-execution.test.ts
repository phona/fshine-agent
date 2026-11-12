// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：重复提问不得用历史答复收尾（RR1 的宿主事实判据，2026-11-12 补齐）。
 *
 * 与 packages/agent/repeat-execution.test.ts 的分工：那边钉判据本体（纯数据 + runtime
 * 替身），这里钉**生产装配的接线**——handler → runtime 的 platformTasks 注入若断，
 * "本会话有在册任务"这个事实就拿不到，门会静默关闭；本文件的 R1 就是那条接线的
 * 回归锁（在册任务由 store 直接 seed，不经委派，不需要平台 operation）。
 *
 * 判据三要素（全宿主事实，不以文本异同为依据）：
 *   ① 本会话在册任务 ≥ 1；② 本回合零委派零执行；③ 回复带数字结论。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, mainDriver, totalActualCalls } from './harness';

/** 单聊会话：conversationId 回落为 userid（W1 后 sessionId = channel:conversationId）。 */
const SESSION_ID = 'wecom:e2e_user';

describe('[L4 集成] 离线全链 e2e：重复提问门（历史答复不得冒充实时）', () => {
  it('R1 本会话有在册任务 + 零工具调用 + 回复带数字 → 确定性话术拦下，零平台调用', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '上次查到的应收余额是 61000 元。' }]),
      worker: gatedWorker([]),
    });
    const platformTasks = assembly.store.platformTasks;
    if (!platformTasks) throw new Error('装配的 store 缺少 platformTasks（本用例的种子前提）');
    await platformTasks.upsert({
      taskId: 'task_existing_e2e',
      parentSessionId: SESSION_ID,
      principalId: 'wecom:e2e_user',
      workerMessages: [],
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
    });

    const reply = await send('把上次的应收余额再告诉我一遍');

    expect(reply).toContain('本会话此前执行过查询');
    expect(reply).not.toContain('61000');                           // 历史数字不外发
    expect(totalActualCalls()).toBe(before);                        // 零平台调用（没有重新执行）
  });

  it('R2 无在册任务的会话：同一文本原样通过（三要素缺一不拦）', async () => {
    const { send } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '上次查到的应收余额是 61000 元。' }]),
      worker: gatedWorker([]),
    });

    const reply = await send('把上次的应收余额再告诉我一遍');

    expect(reply).toContain('61000');
    expect(reply).not.toContain('本会话此前执行过查询');
  });
});
