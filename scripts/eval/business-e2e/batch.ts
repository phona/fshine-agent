/**
 * 并行跑批 harness（业务 E2E 阶段 1；owner 2026-11-14 增补硬要求）。
 *
 * 只做**跑批基建**：以显式可配置并发上限并行跑独立用例，禁止无上限并行。
 * 不携带任何用例逻辑、不做判定、不改产品面——用例执行函数由调用方注入
 * （真实 runner 或确定性假件）。每用例独立工作目录，供独立 config/db/state/session。
 *
 * 纪律：
 *   · 并发上限必须 ≤ 硬上限登记（HARD_LIMIT_REGISTRY）；非法/超限 fail-closed。
 *   · 报告记录实际并发度、吞吐与资源占用（RSS/CPU 粗读数）。
 *   · 串行与并行必须给出一致读数：`compareSerialParallel` 在确定性假件上对照，
 *     不一致以串行读数为准并把差异登记为基建问题。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 硬上限登记：每项机制的不可逾越上限。每次实验的并发上限必须落在此登记之下。 */
export const HARD_LIMIT_REGISTRY = {
  evalBatchConcurrency: {
    max: 8,
    note: '本地跑批并发上限（进程内/子进程均按此登记；提高需 owner 批并改此登记）',
  },
} as const;

export type HardLimitName = keyof typeof HARD_LIMIT_REGISTRY;

export interface BatchPolicyInput {
  /** 本次实验的并发上限（可配置；整数 ≥1）。**缺省 = 1（串行）**，禁止无上限并行。 */
  concurrency?: number;
  /** 硬上限登记项名（缺省 evalBatchConcurrency）。 */
  hardLimitName?: HardLimitName;
  /** 每用例独立工作目录的根（缺省不建目录）。 */
  workRoot?: string;
}

export interface ResolvedBatchPolicy {
  concurrency: number;
  hardLimitName: HardLimitName;
  hardLimitMax: number;
  workRoot?: string;
}

export interface CaseContext {
  id: string;
  index: number;
  /** 本次跑批的并发上限（用例可据此区分串/并行；一致性对照用）。 */
  concurrency: number;
  /** 该用例独立工作目录（提供 workRoot 时）。 */
  workDir?: string;
}

export type CaseExecutor<T> = (item: T, ctx: CaseContext) => Promise<unknown>;

export interface CaseOutcome {
  id: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  workDir?: string;
  elapsedMs: number;
}

export interface BatchReport {
  policy: { concurrency: number; hardLimitName: HardLimitName; hardLimitMax: number };
  caseCount: number;
  observedMaxConcurrency: number;
  wallMs: number;
  throughputPerSec: number;
  resources: { rssDeltaBytes: number; cpuUserMs: number; cpuSystemMs: number };
  outcomes: CaseOutcome[];
}

export interface ConsistencyReport<T> {
  consistent: boolean;
  differences: string[];
  serial: BatchReport;
  parallel: BatchReport;
  /** 并行报告的用例结果（保留类型信息，便于调用方读取）。 */
  parallelOutcomes: CaseOutcome[];
  serialOutcomes: CaseOutcome[];
}

/** 校验并解析跑批策略；越界/非法即抛（禁止无上限并行）。 */
export function resolveBatchPolicy(input: BatchPolicyInput): ResolvedBatchPolicy {
  const name = input.hardLimitName ?? 'evalBatchConcurrency';
  const limit = HARD_LIMIT_REGISTRY[name];
  if (!limit) throw new Error(`未知硬上限登记项：${String(name)}`);
  const concurrency = input.concurrency ?? 1; // 缺省串行=1（安全缺省，禁止无上限并行）
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`并发上限必须是 ≥1 的整数（收到 ${String(input.concurrency)}）`);
  }
  if (concurrency > limit.max) {
    throw new Error(`并发上限 ${concurrency} 超过硬上限登记 ${name}.max=${limit.max}（禁止无上限并行）`);
  }
  return { concurrency, hardLimitName: name, hardLimitMax: limit.max, workRoot: input.workRoot };
}

interface RunInternals<T> {
  outcomes: CaseOutcome[];
  observedMaxConcurrency: number;
  wallMs: number;
  rssDeltaBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  policy: ResolvedBatchPolicy,
  execute: CaseExecutor<T>,
): Promise<RunInternals<T>> {
  const outcomes = new Array<CaseOutcome>(items.length);
  let next = 0;
  let inFlight = 0;
  let observedMaxConcurrency = 0;
  const rssStart = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  const tStart = Date.now();

  async function drain(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      const id = (item as { id?: string })?.id ?? String(index);
      let workDir: string | undefined;
      if (policy.workRoot) {
        workDir = path.join(policy.workRoot, id);
        mkdirSync(workDir, { recursive: true });
      }
      inFlight += 1;
      if (inFlight > observedMaxConcurrency) observedMaxConcurrency = inFlight;
      const caseStart = Date.now();
      try {
        const output = await execute(item, { id, index, concurrency: policy.concurrency, workDir });
        outcomes[index] = { id, ok: true, output, workDir, elapsedMs: Date.now() - caseStart };
      } catch (err) {
        outcomes[index] = {
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          workDir,
          elapsedMs: Date.now() - caseStart,
        };
      } finally {
        inFlight -= 1;
      }
    }
  }

  const runners = Array.from({ length: Math.min(policy.concurrency, items.length) }, () => drain());
  await Promise.all(runners);

  const wallMs = Date.now() - tStart;
  const cpu = process.cpuUsage(cpuStart);
  const rssEnd = process.memoryUsage().rss;
  return {
    outcomes,
    observedMaxConcurrency,
    wallMs,
    rssDeltaBytes: rssEnd - rssStart,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
  };
}

function toReport<T>(items: readonly T[], policy: ResolvedBatchPolicy, run: RunInternals<T>): BatchReport {
  const wallMs = Math.max(run.wallMs, 1);
  return {
    policy: { concurrency: policy.concurrency, hardLimitName: policy.hardLimitName, hardLimitMax: policy.hardLimitMax },
    caseCount: items.length,
    observedMaxConcurrency: run.observedMaxConcurrency,
    wallMs: run.wallMs,
    throughputPerSec: items.length / (wallMs / 1000),
    resources: { rssDeltaBytes: run.rssDeltaBytes, cpuUserMs: run.cpuUserMs, cpuSystemMs: run.cpuSystemMs },
    outcomes: run.outcomes,
  };
}

/** 以配置并发并行跑一批独立用例；返回带并发度/吞吐/资源读数的报告。 */
export async function runBatch<T>(
  items: readonly T[],
  execute: CaseExecutor<T>,
  policyInput: BatchPolicyInput,
): Promise<BatchReport> {
  const policy = resolveBatchPolicy(policyInput);
  const run = await runWithConcurrency(items, policy, execute);
  return toReport(items, policy, run);
}

function outputKey(outcome: CaseOutcome): string {
  if (!outcome.ok) return `ERROR:${outcome.error ?? ''}`;
  try {
    return `OK:${JSON.stringify(outcome.output)}`;
  } catch {
    return `OK:${String(outcome.output)}`;
  }
}

/**
 * 串行（concurrency=1）与并行各跑一遍同一样本集，逐案比对结果。
 * 不一致 → consistent=false、differences 列差异；**以串行读数为准**。
 */
export async function compareSerialParallel<T>(
  items: readonly T[],
  execute: CaseExecutor<T>,
  policyInput: BatchPolicyInput,
): Promise<ConsistencyReport<T>> {
  const serial = await runBatch(items, execute, { ...policyInput, concurrency: 1 });
  const parallel = await runBatch(items, execute, policyInput);
  const differences: string[] = [];
  const max = Math.max(serial.outcomes.length, parallel.outcomes.length);
  for (let i = 0; i < max; i += 1) {
    const s = serial.outcomes[i];
    const p = parallel.outcomes[i];
    if (!s || !p) { differences.push(`case[${i}]: 串并行用例数不一致`); continue; }
    if (s.id !== p.id) { differences.push(`case[${i}]: id 不一致 (${s.id} vs ${p.id})`); continue; }
    if (outputKey(s) !== outputKey(p)) differences.push(`case ${s.id}: 串行=${outputKey(s)} 并行=${outputKey(p)}`);
  }
  return {
    consistent: differences.length === 0,
    differences,
    serial,
    parallel,
    serialOutcomes: serial.outcomes,
    parallelOutcomes: parallel.outcomes,
  };
}
