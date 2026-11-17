/**
 * 并行跑批 harness 测试（业务 E2E 阶段 1，TDD 先红；owner 2026-11-14 增补硬要求）。
 *
 * 判据：
 *   · 显式可配置并发上限并行跑独立用例；禁止无上限并行（超硬上限 fail-closed）。
 *   · 每用例独立工作目录（独立 config/db/state/session 的落点）。
 *   · 报告记录实际并发度、吞吐与资源占用（RSS/CPU 粗读数）；并发上限进硬上限登记。
 *   · 串行与并行在确定性假件上给出**一致读数**；不一致以串行为准并登记差异。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareSerialParallel, HARD_LIMIT_REGISTRY, resolveBatchPolicy, runBatch } from './batch';

const HARD_MAX = HARD_LIMIT_REGISTRY.evalBatchConcurrency.max;

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-batch-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runBatch 有界并发', () => {
  it('并发上限硬约束：在飞数不超过配置并发，且实际达到配置并发（不是串行凑数）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}` }));
    const report = await runBatch(items, async (item, ctx) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await delay(15);
      inFlight -= 1;
      return { id: item.id, concurrency: ctx.concurrency };
    }, { concurrency: 2 });
    expect(maxInFlight).toBe(2);
    expect(report.observedMaxConcurrency).toBe(2);
    expect(report.policy.concurrency).toBe(2);
  });

  it('禁止无上限并行：超硬上限 / 非法并发值 fail-closed', () => {
    expect(() => resolveBatchPolicy({ concurrency: HARD_MAX + 1 })).toThrow();
    expect(() => resolveBatchPolicy({ concurrency: 0 })).toThrow();
    expect(() => resolveBatchPolicy({ concurrency: 1.5 })).toThrow();
    expect(() => resolveBatchPolicy({ concurrency: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => resolveBatchPolicy({ concurrency: HARD_MAX })).not.toThrow();
  });

  it('默认串行=1：不显式配置并发时按串行跑（observedMaxConcurrency=1，安全缺省）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}` }));
    const report = await runBatch(items, async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await delay(5);
      inFlight -= 1;
      return {};
    }, {});
    expect(resolveBatchPolicy({}).concurrency).toBe(1);
    expect(report.policy.concurrency).toBe(1);
    expect(report.observedMaxConcurrency).toBe(1);
    expect(maxInFlight).toBe(1);
  });

  it('每用例独立工作目录：workRoot 下按 id 分目录（独立 config/db/state/session 落点）', async () => {
    const root = freshRoot();
    const seen = new Map<string, string | undefined>();
    await runBatch([{ id: 'a' }, { id: 'b' }], async (item, ctx) => {
      seen.set(item.id, ctx.workDir);
      return {};
    }, { concurrency: 2, workRoot: root });
    expect(seen.get('a')).toBe(path.join(root, 'a'));
    expect(seen.get('b')).toBe(path.join(root, 'b'));
    expect(seen.get('a')).not.toBe(seen.get('b'));
    expect(existsSync(path.join(root, 'a'))).toBe(true);
    expect(existsSync(path.join(root, 'b'))).toBe(true);
  });

  it('单用例失败不中断其余用例（outcome 逐案标记，串行与并行都不丢案）', async () => {
    const items = [{ id: 'ok1' }, { id: 'boom' }, { id: 'ok2' }];
    const report = await runBatch(items, async (item) => {
      if (item.id === 'boom') throw new Error('case blew up');
      return { id: item.id };
    }, { concurrency: 3 });
    expect(report.outcomes.map((o) => o.id)).toEqual(['ok1', 'boom', 'ok2']);
    expect(report.outcomes.find((o) => o.id === 'boom')?.ok).toBe(false);
    expect(report.outcomes.find((o) => o.id === 'boom')?.error).toContain('case blew up');
    expect(report.outcomes.filter((o) => o.ok)).toHaveLength(2);
  });

  it('报告记录吞吐与资源占用（RSS/CPU 粗读数）与硬上限登记', async () => {
    const report = await runBatch([{ id: 'a' }, { id: 'b' }], async () => ({}), { concurrency: 1 });
    expect(report.policy.hardLimitName).toBe('evalBatchConcurrency');
    expect(report.policy.hardLimitMax).toBe(HARD_MAX);
    expect(report.caseCount).toBe(2);
    expect(report.throughputPerSec).toBeGreaterThan(0);
    expect(typeof report.resources.rssDeltaBytes).toBe('number');
    expect(typeof report.resources.cpuUserMs).toBe('number');
    expect(typeof report.resources.cpuSystemMs).toBe('number');
    expect(report.wallMs).toBeGreaterThanOrEqual(0);
  });
});

describe('compareSerialParallel 串并行一致性对照', () => {
  it('确定性假件：串行与并行结果逐案一致（一致读数）', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` }));
    const execute = async (item: { id: string }) => ({ id: item.id, len: item.id.length });
    const cmp = await compareSerialParallel(items, execute, { concurrency: 3 });
    expect(cmp.consistent).toBe(true);
    expect(cmp.differences).toEqual([]);
    expect(cmp.parallel.observedMaxConcurrency).toBe(3);
    expect(cmp.serial.observedMaxConcurrency).toBe(1);
  });

  it('不一致被检出并登记：串行读数为准（并行结果随并发度变的假件必须红）', async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}` }));
    // 故意构造并发相关的假件：并发>1 时输出被污染（模拟跨用例串台）。
    const execute = async (item: { id: string }, ctx: { concurrency: number }) => ({
      id: item.id,
      value: ctx.concurrency > 1 ? 'contaminated' : item.id,
    });
    const cmp = await compareSerialParallel(items, execute, { concurrency: 3 });
    expect(cmp.consistent).toBe(false);
    expect(cmp.differences.length).toBeGreaterThan(0);
    // 以串行读数为准：串行 outcome 是干净的。
    expect(cmp.serial.outcomes.every((o) => (o.output as { value: string }).value === o.id)).toBe(true);
  });

  it('一致性对照用同一样本集、各自独立工作目录，且合并并发上限登记', async () => {
    const root = freshRoot();
    const items = [{ id: 'a' }, { id: 'b' }];
    const execute = async (item: { id: string }, ctx: { workDir?: string }) => ({ id: item.id, dir: ctx.workDir });
    const cmp = await compareSerialParallel(items, execute, { concurrency: 2, workRoot: root });
    expect(cmp.consistent).toBe(true);
    expect(cmp.serial.policy.hardLimitName).toBe(cmp.parallel.policy.hardLimitName);
  });
});
