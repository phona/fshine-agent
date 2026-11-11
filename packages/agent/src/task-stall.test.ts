/**
 * T10 段2：停滞检测（progress-based，今天零机制）。
 *
 * 判据（全部机械可判）：
 *   ① 输入只能是**宿主独立读**的结果指标（ResultObservation），不接收也不采信 worker
 *      自报的进度——worker 不可能知道自己在假死；
 *   ② 指标在 T 时间内不变、且没到截止 → 判 stalled；指标一变就重置窗口；
 *   ③ 到截止即停（"没到截止"是本检测的前提），读回不可用不算停滞（拿不到值不编造）；
 *   ④ 检测只产出判定与留痕字段，**不杀进程、不重跑**——冻结是调用方的事；
 *   ⑤ 熔断器数失败、假死不产生失败，两条路各走各的（本模块不产出 failure 分类）。
 */
import { describe, expect, it } from 'vitest';
import { evaluateStagnation, renderStalledReply, startStallMonitor, type StallVerdict } from './task-stall';
import type { ResultObservation } from './result-contract';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('T10-2 停滞判定（纯函数）', () => {
  it('同一值持续到 T：stalled，并给出不变时长与最后值', () => {
    const verdict = evaluateStagnation({
      samples: [{ at: 0, value: 3 }, { at: 10, value: 3 }, { at: 20, value: 3 }],
      now: 30,
      unchangedForMs: 20,
    });
    expect(verdict.stalled).toBe(true);
    expect(verdict.lastValue).toBe(3);
    expect(verdict.unchangedForMs).toBe(30);
    expect(verdict.samples).toBe(3);
  });

  it('窗口内变过一次：不 stalled（进度推进即视为活着）', () => {
    const verdict = evaluateStagnation({
      samples: [{ at: 0, value: 3 }, { at: 10, value: 3 }, { at: 20, value: 4 }],
      now: 30,
      unchangedForMs: 20,
    });
    expect(verdict.stalled).toBe(false);
  });

  it('只有一次采样：不下结论（没有"不变"可判）', () => {
    const verdict = evaluateStagnation({ samples: [{ at: 0, value: 3 }], now: 100, unchangedForMs: 20 });
    expect(verdict.stalled).toBe(false);
  });

  it('没有采样：不 stalled', () => {
    const verdict = evaluateStagnation({ samples: [], now: 100, unchangedForMs: 20 });
    expect(verdict.stalled).toBe(false);
    expect(verdict.lastValue).toBeNull();
  });

  it('不变时长恰达阈值：判 stalled（>= 语义，测试用毫秒级替身）', () => {
    const verdict = evaluateStagnation({
      samples: [{ at: 0, value: 1 }, { at: 10, value: 1 }],
      now: 20,
      unchangedForMs: 20,
    });
    expect(verdict.stalled).toBe(true);
  });
});

describe('T10-2 停滞监视器：只看宿主独立读的结果指标', () => {
  it('指标在窗口内不变 → stalled；onStall 只报一次；stop 返回判定', async () => {
    const observations: ResultObservation[] = [{ metric: 'objects', actual: 0 }];
    const stalls: StallVerdict[] = [];
    const monitor = startStallMonitor({
      observe: async () => observations,
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 25,
      onStall: (verdict) => { stalls.push(verdict); },
    });
    await sleep(150);
    const verdict = await monitor.stop();
    expect(verdict.stalled).toBe(true);
    expect(verdict.metric).toBe('objects');
    expect(verdict.lastValue).toBe(0);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.stalled).toBe(true);
  });

  it('指标一路推进 → 永不 stalled（worker 沉默也不算假死）', async () => {
    let value = 0;
    const monitor = startStallMonitor({
      observe: async () => [{ metric: 'objects', actual: (value += 1) }],
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 25,
    });
    await sleep(150);
    const verdict = await monitor.stop();
    expect(verdict.stalled).toBe(false);
  });

  it('worker 自报的进度不参与判定：onStep 帧照发、指标冻结 → 仍 stalled', async () => {
    // 监视器 API 里没有 worker 进度入口——这里显式把"worker 自报"当噪声喂给 observe
    // 之外的通道不存在，只能证明：指标冻结时无论 worker 喊了多少次进度，判定都是 stalled。
    const workerProgressFrames: string[] = [];
    const monitor = startStallMonitor({
      observe: async () => [{ metric: 'objects', actual: 0 }],
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 25,
    });
    for (let index = 0; index < 5; index += 1) {
      workerProgressFrames.push(`进度 ${index + 1}/5`);
      await sleep(10);
    }
    const verdict = await monitor.stop();
    expect(workerProgressFrames.length).toBeGreaterThan(0);
    expect(verdict.stalled).toBe(true);
  });

  it('读回不可用（null）不判假死：拿不到值不编造', async () => {
    const monitor = startStallMonitor({
      observe: async () => null,
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 25,
    });
    await sleep(120);
    const verdict = await monitor.stop();
    expect(verdict.stalled).toBe(false);
    expect(verdict.samples).toBe(0);
  });

  it('到截止即停：截止后不再采样，也不判假死（"没到截止"是前提）', async () => {
    const start = Date.now();
    const monitor = startStallMonitor({
      observe: async () => [{ metric: 'objects', actual: 0 }],
      metric: 'objects',
      sampleIntervalMs: 5,
      // 阈值显著长于截止：截止前不可能攒够"不变"窗口，最终结论只能来自到期停止
      unchangedForMs: 400,
      deadline: start + 30,
    });
    await sleep(150);
    const verdict = await monitor.stop();
    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toBe('deadline_reached');
  });

  it('中止（用户/上层取消）优先于停滞：aborted 后不再判假死', async () => {
    const controller = new AbortController();
    const monitor = startStallMonitor({
      observe: async () => [{ metric: 'objects', actual: 0 }],
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    await sleep(80);
    const verdict = await monitor.stop();
    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toBe('aborted');
  });

  it('observe 抛错只跳过采样，不把宿主读故障伪装成假死', async () => {
    let calls = 0;
    const monitor = startStallMonitor({
      observe: async () => { calls += 1; throw new Error('readback down'); },
      metric: 'objects',
      sampleIntervalMs: 5,
      unchangedForMs: 10,
    });
    await sleep(80);
    const verdict = await monitor.stop();
    expect(calls).toBeGreaterThan(0);
    expect(verdict.stalled).toBe(false);
  });
});

describe('T10-2 冻结的用户话术：说暂停与续跑，不说完成，不泄漏实现细节', () => {
  it('话术只陈述暂停与断点续跑，绝不宣称完成', () => {
    const verdict: StallVerdict = {
      stalled: true,
      metric: 'objects',
      lastValue: 0,
      unchangedForMs: 60_000,
      samples: 5,
      reason: 'stalled',
    };
    const reply = renderStalledReply(verdict);
    expect(reply).toContain('暂停');
    expect(reply).toContain('继续');
    expect(reply).not.toMatch(/已完成|成功/);
    expect(reply).not.toContain('.js');
    expect(reply).not.toContain('--');
  });
});
