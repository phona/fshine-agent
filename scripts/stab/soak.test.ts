/**
 * R4 · 稳定性加固 · 浸泡套件（TDD 先在红：harness 缺失）。
 *
 * 预注册：`docs/product/r4-stability-prereg.md` §三（场景 S1/S2）与 §四（不变量 I1–I5）。
 * 本文件只断言预注册阈值；假件（假 executor / 假 sink / 假渠道 / 可注入时钟）由
 * `./soak-harness` 提供。**先红 = harness 文件尚未实现（collection 失败）**；
 * 不弱化任何断言、不删除任何场景。
 *
 * 红线：不改产品代码/冻结面/历史证据；发现的真实产品缺陷只登记（修复归后续 Run）；
 * 测试基建自身缺陷可在转绿阶段修复，修后重跑记新 run，旧证据保留（预注册 §五）。
 */
import { describe, expect, it } from 'vitest';
import { runSoakScenario, type SoakReport } from './soak-harness';

/**
 * §四 共同不变量 I1–I5（浸泡口径）。
 * 与 pressure/chaos 套件逐套件独立断言（不共享断言函数，避免一处放宽全线漂移）。
 */
function expectSoakInvariants(report: SoakReport): void {
  // I2 无挂死：有界收尾（harness 内部预算 45s）
  expect(report.hung).toBe(false);
  // I3 队列归零：无开放态残留；终态计数覆盖全部提交
  expect(report.openOnDrain).toBe(0);
  const terminal = Object.values(report.terminalCounts).reduce((sum: number, count: number) => sum + count, 0);
  expect(terminal).toBe(report.submitted);
  // I1 无重复副作用：每受理任务恰一次执行；通知无重复；同一通知成功投递 ≤1 次
  expect(Object.keys(report.executorCallsPerTask)).toHaveLength(report.accepted);
  for (const [taskId, calls] of Object.entries(report.executorCallsPerTask)) {
    expect(calls, `任务 ${taskId} 的 executor 调用次数`).toBe(1);
  }
  expect(report.duplicateSideEffectTasks).toEqual([]);
  expect(Object.values(report.sinkDeliveredPerNotification).every((count: number) => count <= 1)).toBe(true);
  // I4 通知未送达 = 0
  expect(report.undeliveredNotifications).toBe(0);
  // I5 RSS 增长 < 10%
  expect(report.rssGrowthRatio).toBeLessThan(0.1);
}

describe('R4-Stab 浸泡 S · 假 executor/sink/渠道/时钟', () => {
  it('S1 持续 10×50 交办：全部完成、无重复副作用、无挂死、队列归零、通知未送达=0、RSS<10%', async () => {
    const report = await runSoakScenario({
      cycles: 10,
      perCycle: 50,
      concurrency: 4,
      queueCapacity: 64,
    });
    expect(report.submitted).toBe(500);
    expect(report.accepted).toBe(500);
    expect(report.rejected).toBe(0);
    expect(report.terminalCounts['completed']).toBe(500);
    expectSoakInvariants(report);
  }, 60_000);

  it('S2 浸泡 × 通知间歇失败（每 3 次失败 1 次）：任务结果不变；恢复后未送达=0；无重复投递', async () => {
    const report = await runSoakScenario({
      cycles: 10,
      perCycle: 50,
      concurrency: 4,
      queueCapacity: 64,
      sinkFailureEvery: 3,
    });
    expect(report.submitted).toBe(500);
    // 投递失败不改变任务结果（P4 契约：通知事实与任务事实解耦）
    expect(report.terminalCounts['completed']).toBe(500);
    expectSoakInvariants(report);
  }, 60_000);
});
