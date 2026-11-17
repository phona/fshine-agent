/**
 * R4 · 稳定性加固 · 混沌套件（TDD 先在红：harness 缺失）。
 *
 * 预注册：`docs/product/r4-stability-prereg.md` §三（场景 C1–C4）与 §四（不变量 I1–I5）。
 * 假件（假 executor / 假 sink / 假渠道[server.handler 同 messageId 重投] / 可注入时钟）
 * 由 `./chaos-harness` 提供。**先红 = harness 文件尚未实现（collection 失败）**。
 *
 * 已登记 blocked 的交互按预注册 §九处理：C2 的 messageId 查重只在单进程内评估（跨重启
 * 不保持为登记缺陷）；C4 的取消确认先于重启（绕开「cancelling 孤儿恢复」登记缺陷）。
 */
import { describe, expect, it } from 'vitest';
import { runChaosScenario, type ChaosReport } from './chaos-harness';

/** §四 共同不变量 I1–I5（混沌口径；逐套件独立断言）。 */
function expectChaosInvariants(report: ChaosReport): void {
  // I2 无挂死：有界收尾（harness 内部预算 45s）
  expect(report.hung).toBe(false);
  // I3 队列归零：无开放态残留
  expect(report.openOnDrain).toBe(0);
  // I1 无重复副作用：通知行无重复、同一通知成功投递 ≤1 次；任务级重复另由各场景字段断言
  expect(report.duplicateSideEffectTasks).toEqual([]);
  expect(report.duplicateNotificationRows).toBe(0);
  expect(Object.values(report.sinkDeliveredPerNotification).every((count: number) => count <= 1)).toBe(true);
  // I4 通知未送达 = 0（恢复投递后）
  expect(report.undeliveredNotifications).toBe(0);
  // I5 RSS 增长 < 10%
  expect(report.rssGrowthRatio).toBeLessThan(0.1);
}

describe('R4-Stab 混沌 C · 重启/通知失败/重复消息/取消 组合', () => {
  it('C1 重启 × 通知失败：不重放已完成与过期租约、通知恢复后未送达=0、队列归零', async () => {
    const report = await runChaosScenario({
      tasks: 20,
      combination: ['restart', 'notification_failure'],
      concurrency: 1,
      queueCapacity: 32,
    });
    expect(report.restartCount).toBe(1);
    expect(report.replayedCompletedTasks).toEqual([]);
    expect(report.leaseExpiredReplays).toBe(0);
    expectChaosInvariants(report);
  }, 60_000);

  it('C2 重启 × 重复消息：回执幂等重放、不新增任务/执行；重启不重放已完成', async () => {
    const report = await runChaosScenario({
      tasks: 20,
      combination: ['restart', 'duplicate_message'],
      concurrency: 1,
      queueCapacity: 32,
    });
    expect(report.receiptReplayIdentical).toBe(true);
    expect(report.tasksCreatedByDuplicate).toBe(0);
    expect(report.executionsByDuplicate).toBe(0);
    expect(report.replayedCompletedTasks).toEqual([]);
    expectChaosInvariants(report);
  }, 60_000);

  it('C3 取消 × 通知失败：确认取消（非请求滞留）、无二次执行、cancelled 通知恢复后送达', async () => {
    const report = await runChaosScenario({
      tasks: 20,
      combination: ['cancel', 'notification_failure'],
      concurrency: 1,
      queueCapacity: 32,
    });
    expect(report.cancelledConfirmed).toBe(true);
    expect(report.terminalCounts['cancelled']).toBeGreaterThan(0);
    expectChaosInvariants(report);
  }, 60_000);

  it('C4 全组合（重启×通知失败×重复×取消）：总不变量全守', async () => {
    const report = await runChaosScenario({
      tasks: 30,
      combination: ['restart', 'notification_failure', 'duplicate_message', 'cancel'],
      concurrency: 1,
      queueCapacity: 32,
    });
    expect(report.restartCount).toBe(1);
    expect(report.receiptReplayIdentical).toBe(true);
    expect(report.tasksCreatedByDuplicate).toBe(0);
    expect(report.executionsByDuplicate).toBe(0);
    expect(report.cancelledConfirmed).toBe(true);
    expect(report.replayedCompletedTasks).toEqual([]);
    expect(report.leaseExpiredReplays).toBe(0);
    expectChaosInvariants(report);
  }, 60_000);
});
