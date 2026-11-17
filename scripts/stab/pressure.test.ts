/**
 * R4 · 稳定性加固 · 压力套件（TDD 先在红：harness 缺失）。
 *
 * 预注册：`docs/product/r4-stability-prereg.md` §三（场景 P1/P2/P3）与 §四（不变量 I1–I5）。
 * 假件（假 executor / 假 sink / 假渠道 / 可注入时钟）由 `./pressure-harness` 提供。
 * **先红 = harness 文件尚未实现（collection 失败）**；不弱化任何断言、不删除任何场景。
 *
 * 只读数（非门槛，预注册 §九）：`queueCapacity>0` 底账队列上界未强制为已登记 blocked，
 * 队列深度观察字段不参与判负。
 */
import { describe, expect, it } from 'vitest';
import { runPressureScenario, type PressureReport } from './pressure-harness';

/** §四 共同不变量 I1–I5（压力口径；逐套件独立断言）。 */
function expectPressureInvariants(report: PressureReport): void {
  // I2 无挂死：有界收尾（harness 内部预算 45s）
  expect(report.hung).toBe(false);
  // I3 队列归零：无开放态残留；终态计数覆盖全部提交
  expect(report.openOnDrain).toBe(0);
  const terminal = Object.values(report.terminalCounts).reduce((sum: number, count: number) => sum + count, 0);
  expect(terminal).toBe(report.submitted);
  // I1 无重复副作用：每受理任务恰一次执行（被拒绝任务零执行）；通知无重复；同一通知成功投递 ≤1 次
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

describe('R4-Stab 压力 P · 假 executor/sink/渠道/时钟', () => {
  it('P1 积压 500 受控排队：全部完成、排空归零、恰一次执行、通知未送达=0、RSS<10%', async () => {
    const report = await runPressureScenario({ backlog: 500, concurrency: 2, queueCapacity: 512 });
    expect([report.submitted, report.accepted, report.rejected]).toEqual([500, 500, 0]);
    expect(report.terminalCounts['completed']).toBe(500);
    // 只读数（非门槛）：队列深度观察必须存在且有限；深度大小不判负（§九 blocked）
    expect(Number.isFinite(report.queueObservations.policyQueueMax)).toBe(true);
    expect(Number.isFinite(report.queueObservations.ledgerQueuedMax)).toBe(true);
    expectPressureInvariants(report);
  }, 60_000);

  it('P2 池满持续（queueCapacity=0，500 交办）：499 确定性拒绝 resource_limited；无队列残留；运行中不受损；前台可用；通知未送达=0', async () => {
    const report = await runPressureScenario({
      backlog: 500,
      concurrency: 1,
      queueCapacity: 0,
      holdFirstTask: true,
    });
    expect(report.accepted).toBe(1);
    expect(report.rejected).toBe(499);
    // 拒绝路径落库：终态 failed + reason=resource_limited（P7b 拒绝落点口径）
    expect(report.terminalCounts['failed']).toBe(499);
    expect(report.terminalReasonCounts['resource_limited']).toBe(499);
    // 运行中任务不受损：放行后正常收尾
    expect(report.terminalCounts['completed']).toBe(1);
    // 前台配额独立：池满期间前台回合可用
    expect(report.foregroundRoundTrips).toBeGreaterThan(0);
    expectPressureInvariants(report);
  }, 60_000);

  it('P3 积压 500 × 通知间歇失败（每 5 次失败 1 次）：任务结果不变；恢复后未送达=0', async () => {
    const report = await runPressureScenario({
      backlog: 500,
      concurrency: 2,
      queueCapacity: 512,
      sinkFailureEvery: 5,
    });
    expect(report.rejected).toBe(0);
    expect(report.terminalCounts['completed']).toBe(500);
    expectPressureInvariants(report);
  }, 60_000);
});
