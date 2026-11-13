// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置（本文件按仓内 eval 夹具跑）：AGENT_CONFIG_PATH=scripts/eval/eval.agent.yaml +
// 脚本化驱动，不碰真平台。通用闭环只认 typecheck + unit + generic-mock，本文件证据不冒充通用证据。
/**
 * 离线全链 e2e：重复提问不得用历史答复收尾（RR1 窄门，2026-11-12 收窄）。
 *
 * 与 packages/agent/repeat-execution.test.ts 的分工：那边钉判据本体（纯数据 + runtime
 * 替身），这里钉**生产装配的接线 + 收窄语义**：
 *   R1 本会话存在一条**与本轮 requestKey 完全相同**的已执行请求 + 本轮零委派零执行 +
 *      回复带数字 → 确定性话术拦下（接线回归锁：handler → runtime 的 platformTasks
 *      注入若断，精确身份就拿不到，门会静默关闭）；
 *   R2 改写过的问句（身份不同）→ 原样通过（收窄的核心：普通聊天不被阻断）；
 *   R3 无在册任务的会话 → 原样通过。
 * 在册任务由 store 直接 seed（不经委派，不需要平台 operation），requestKey 由生产
 * 同一个 buildRequestKey 计算——两处不会出现两套身份口径。
 *
 * 平台调用计数走 fixtureCallCount()（夹具审计行数；2026-11-13 P2 修正）。原用
 * totalActualCalls() 读 EXECUTION_PLAN_STATE，夹具忽略 EXECUTION_* 状态路径 → 恒 0，
 * "零平台调用"是空跑断言。
 */
import { describe, expect, it } from 'vitest';
import { buildRequestKey } from '../../packages/agent/src/repeat-request';
import { boot, fixtureCallCount, gatedWorker, mainDriver } from './harness';

/** 单聊会话：conversationId 回落为userid（W1 后 sessionId = channel:conversationId）。 */
const SESSION_ID = 'wecom:e2e_user';

const REPEATED_MESSAGE = '把上次的应收余额再告诉我一遍';

describe('[L4 集成] 离线全链 e2e：重复提问门（RR1 窄门）', () => {
  it('R1 存在与本轮完全同身份的已执行请求 + 零工具调用 + 回复带数字 → 拦下，零平台调用', async () => {
    const before = fixtureCallCount();
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
      // 此前执行过的完全相同请求：身份键由生产同一函数计算
      requestKey: buildRequestKey(REPEATED_MESSAGE),
    });

    const reply = await send(REPEATED_MESSAGE);

    expect(reply).toContain('本会话此前执行过查询');
    expect(reply).not.toContain('61000');                           // 历史数字不外发
    expect(fixtureCallCount()).toBe(before);                        // 零平台调用（没有重新执行）
  });

  it('R2 改写过的问句（身份不同）→ 原样通过（收窄后普通聊天不被阻断）', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '上次查到的应收余额是 61000 元。' }]),
      worker: gatedWorker([]),
    });
    const platformTasks = assembly.store.platformTasks;
    if (!platformTasks) throw new Error('装配的 store 缺少 platformTasks（本用例的种子前提）');
    await platformTasks.upsert({
      taskId: 'task_existing_other',
      parentSessionId: SESSION_ID,
      principalId: 'wecom:e2e_user',
      workerMessages: [],
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
      requestKey: buildRequestKey('查一下幻东的应收账款余额'),   // 与本次问句不同身份
    });

    const reply = await send(REPEATED_MESSAGE);

    expect(reply).toContain('61000');
    expect(reply).not.toContain('本会话此前执行过查询');
  });

  it('R3 无在册任务的会话：同一文本原样通过（身份缺一不拦）', async () => {
    const { send } = await boot({
      main: mainDriver([{ kind: 'conversation', text: '上次查到的应收余额是 61000 元。' }]),
      worker: gatedWorker([]),
    });

    const reply = await send(REPEATED_MESSAGE);

    expect(reply).toContain('61000');
    expect(reply).not.toContain('本会话此前执行过查询');
  });
});
