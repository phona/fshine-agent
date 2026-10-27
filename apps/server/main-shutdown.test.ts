import { describe, expect, it } from 'vitest';
import { createShutdownGuard, DEFAULT_SHUTDOWN_DRAIN_MS, shutdownDrainMsOf } from './main-shutdown';

/**
 * main.ts 停机形状的表征测试（D-132 a/c）。
 *
 * 测试落点说明：main.ts 在模块顶层即执行 main()（建目录、装配、连渠道、起进程内
 * 服务），导入即起服务，无法在单测里直接实例化——停机行为因此抽到 main-shutdown.ts
 * （先例：assembly.ts 自 main.ts 抽出、生产与离线 e2e 共用同一份装配）。信号在飞闸
 * 与排干上限的判据本体都住那个模块，本文件钉住：
 *   a. 连按两次信号只在飞跑一遍停机体，第二次只打一行 shutdown_already_in_progress；
 *   c. 排干上限从 FSHINE_SHUTDOWN_DRAIN_MS 读取，缺省/非法值回退默认 30s。
 */

describe('createShutdownGuard（双信号并发停机在飞闸）', () => {
  it('停机体在飞时第二次信号不再入体，只打一行 shutdown_already_in_progress', async () => {
    const lines: string[] = [];
    const guard = createShutdownGuard((line) => { lines.push(line); });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let bodyRuns = 0;
    const first = guard.run('SIGINT', async () => { bodyRuns += 1; await firstGate; });
    const second = guard.run('SIGTERM', async () => { bodyRuns += 1; });

    expect(bodyRuns).toBe(1);
    await second;
    releaseFirst();
    await first;
    expect(bodyRuns).toBe(1);
    expect(lines).toEqual([JSON.stringify({ event: 'shutdown_already_in_progress', signal: 'SIGTERM' })]);
  });

  it('停机体完成后闸不复位：迟到信号同样只留痕（进程在停机末尾退出，不存在第二次停机）', async () => {
    const lines: string[] = [];
    const guard = createShutdownGuard((line) => { lines.push(line); });
    let bodyRuns = 0;
    await guard.run('SIGINT', async () => { bodyRuns += 1; });
    await guard.run('SIGTERM', async () => { bodyRuns += 1; });
    expect(bodyRuns).toBe(1);
    expect(lines).toEqual([JSON.stringify({ event: 'shutdown_already_in_progress', signal: 'SIGTERM' })]);
  });

  it('停机体抛错时向首个调用方原样传播（既有错误语义不因加闸改变）', async () => {
    const guard = createShutdownGuard();
    await expect(guard.run('SIGINT', async () => { throw new Error('停机体失败'); })).rejects.toThrow('停机体失败');
  });
});

describe('shutdownDrainMsOf（停机排干上限）', () => {
  it('缺省/空值/非法值/负数回退默认 30000', () => {
    expect(DEFAULT_SHUTDOWN_DRAIN_MS).toBe(30_000);
    expect(shutdownDrainMsOf({})).toBe(30_000);
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: undefined })).toBe(30_000);
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: '' })).toBe(30_000);
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: 'not-a-number' })).toBe(30_000);
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: '-1' })).toBe(30_000);
  });

  it('合法值直读：0 = 不等待，正数原样生效', () => {
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: '0' })).toBe(0);
    expect(shutdownDrainMsOf({ FSHINE_SHUTDOWN_DRAIN_MS: '2500' })).toBe(2_500);
  });
});
