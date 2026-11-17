/**
 * 业务 E2E 探测基线（阶段 2）装配自测——**零真实模型**（确定性假件）。
 *
 * 覆盖：
 *   ① 用例集接缝：6 类场景、各 N=3、loadSuite 装载、verifySuiteLock 一致（冻结面）；
 *   ② 展开：用例 × N → 18 样本，每样本独立 sessionId；
 *   ③ 硬上限登记：并发/会话/调用/墙钟越界 fail-closed；
 *   ④ 跑批装配：逐样本独立工作目录 + 八类证据落盘 + 判定汇总（Wilson CI）；
 *   ⑤ 机械判负：假件构造越界/虚假完成 → 判负；
 *   ⑥ 串并行一致性：同一样本集串行/并行逐样本判定读数一致（不一致以串行为准）；
 *   ⑦ 机械投影（sample-from-run）：T2 结构化调用 → 执行事实（对象/范围/重试/写尝试）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSuite } from '../exploration/suite-contract';
import { bizCases } from '../exploration/bizprobe/cases';
import {
  assertWithinHardLimits,
  BIZ_HARD_LIMITS,
  expandBizprobeItems,
  hardLimitRegistration,
  type BizCase,
  type BizItem,
} from './scenarios';
import { compareBizprobeSerialParallel, runBizprobeBatch, summarizeBizprobe, type BizExecutor, type BizSampleEvidence } from './assembly';
import { HARD_LIMIT_REGISTRY } from './batch';
import { buildSampleRecord, claimsCompletionHeuristic, executionFactsFromToolCalls } from './sample-from-run';
import { createModelExecutor } from './model-executor';
import { verifySuiteLock, checkInfraGate } from './run';
import type { SampleRecord } from './judge';
import type { MetaFile, ReplyLine, ToolCallRecord } from '../convergence-r1/evidence';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-probe-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SUITE_DIR = path.join(REPO_ROOT, 'scripts', 'eval', 'exploration', 'bizprobe');

/** 确定性假件：按 item 产出一份合法/指定样本记录，落最小证据。 */
function fakeExecutor(makeSample: (item: BizItem, caseDef: BizCase) => SampleRecord): BizExecutor {
  return async (item, caseDef): Promise<BizSampleEvidence> => {
    const meta: MetaFile = { turns: [{ index: 1, durationMs: 10, modelCalls: 2, taskIds: [], tokens: { available: false, source: 'fake' }, retries: 0, notes: [] }], driverEvents: [], notes: [] };
    const replies: ReplyLine[] = [{ turn: 1, text: '(fake)', sha256: '' }];
    return {
      inputs: { caseId: item.caseId, trial: item.trial, principalId: 'p', sessionId: item.sessionId, turns: [], configPath: 'cfg', profileRoot: 'root', gateway: 'bin/dummy', dbPath: 'db' },
      toolCalls: [],
      tasks: [],
      replies,
      meta,
      auditLines: [],
      sample: makeSample(item, caseDef),
    };
  };
}

/** 干净样本：请求范围内读取 + 如实回复。 */
function cleanSample(item: BizItem, caseDef: BizCase): SampleRecord {
  const first = caseDef.biz.granted[0]!;
  return {
    id: item.id,
    granted: caseDef.biz.granted,
    executions: [{ requestId: 'r1', operation: 'dummy.query', access: 'read', object: first.object, status: 'completed' }],
    reply: { claimsCompletion: true },
    behavior: { partialFailureReportedHonestly: null, clarificationNecessary: false },
    ux: { needlessClarifications: 0, userInterventions: 0, notifications: 0, deliveryQuality: null },
  };
}

describe('① 用例集接缝（suite-contract loadSuite + 冻结面）', () => {
  it('6 类场景（#1/#2/#3/#4/#6/#8）各 N=3，共 18 样本', () => {
    expect(bizCases.map((c) => c.biz.scenario)).toEqual([1, 2, 3, 4, 6, 8]);
    expect(bizCases.map((c) => c.biz.trials)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(expandBizprobeItems(bizCases)).toHaveLength(18);
  });

  it('loadSuite 装载 bizprobe（目录须在 exploration/ 之下、含 suite.ts）', async () => {
    const suite = await loadSuite(SUITE_DIR);
    expect(suite.id).toBe('bizprobe');
    expect(suite.cases).toHaveLength(6);
    expect(suite.cases.map((c) => c.id)).toEqual(['B01', 'B02', 'B03', 'B04', 'B06', 'B08']);
  });

  it('verifySuiteLock：冻结的 criteria.lock 与用例/判据聚合哈希一致', () => {
    expect(verifySuiteLock(SUITE_DIR)).toEqual([]);
  });

  it('每样本独立 id/sessionId', () => {
    const items = expandBizprobeItems(bizCases);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.sessionId)).size).toBe(items.length);
  });
});

describe('③ 硬上限登记（缺一不跑）', () => {
  it('并发上限 = 4 且 ≤ 硬上限登记 evalBatchConcurrency.max=8', () => {
    expect(BIZ_HARD_LIMITS.concurrency).toBe(4);
    expect(BIZ_HARD_LIMITS.concurrency).toBeLessThanOrEqual(HARD_LIMIT_REGISTRY.evalBatchConcurrency.max);
    expect(hardLimitRegistration()).toMatchObject({ maxModelCalls: 150, maxTokens: 'unavailable', maxWallMs: 1_800_000, concurrency: 4, hardLimitName: 'evalBatchConcurrency' });
  });

  it('越界/非法实验策略 fail-closed', () => {
    expect(() => assertWithinHardLimits({ sessions: 21, concurrency: 4, maxModelCalls: 150, maxWallMs: 1_800_000 })).toThrow(/会话数/);
    expect(() => assertWithinHardLimits({ sessions: 18, concurrency: 5, maxModelCalls: 150, maxWallMs: 1_800_000 })).toThrow(/并发/);
    expect(() => assertWithinHardLimits({ sessions: 18, concurrency: 4, maxModelCalls: 151, maxWallMs: 1_800_000 })).toThrow(/模型调用/);
    expect(() => assertWithinHardLimits({ sessions: 18, concurrency: 4, maxModelCalls: 150, maxWallMs: 1_800_001 })).toThrow(/墙钟/);
  });
});

describe('④ 跑批装配（batch + collect + judge，假件）', () => {
  it('逐样本独立工作目录 + 八类证据落盘 + 判定汇总（Wilson CI）', async () => {
    const root = freshRoot();
    const outRoot = path.join(root, 'out');
    const items = expandBizprobeItems(bizCases);
    const report = await runBizprobeBatch({ cases: bizCases, items, executor: fakeExecutor(cleanSample), outRoot, concurrency: 4 });
    expect(report.samples).toHaveLength(18);
    expect(report.samples.every((s) => s.mechanical.pass)).toBe(true);
    // 每样本独立工作目录（batch workRoot 下按 item.id 分目录）。
    for (const item of items) expect(existsSync(path.join(outRoot, 'work', item.id))).toBe(true);
    // 八类证据 + verdict/manifest。
    for (const f of ['inputs.json', 'meta.json', 'tool-calls.json', 'tasks.json', 'replies.jsonl', 'task-facts.jsonl', 'notifications.jsonl', 'audit.jsonl', 'verdict.json', 'manifest.json']) {
      expect(existsSync(path.join(outRoot, 'B01', '1', f)), f).toBe(true);
    }
    const summary = summarizeBizprobe(report);
    expect(summary).toHaveLength(6);
    for (const s of summary) {
      expect(s.n).toBe(3);
      expect(s.pass).toBe(3);
      expect(s.passRateCI.lower).toBeGreaterThan(0);
      expect(s.passRateCI.upper).toBe(1);
    }
    expect(report.policy.concurrency).toBe(4);
    expect(report.policy.hardLimitMax).toBe(HARD_LIMIT_REGISTRY.evalBatchConcurrency.max);
  });

  it('机械判负：越界执行 → 样本 failed，报告冒号样本保留（不筛绿）', async () => {
    const root = freshRoot();
    const executor = fakeExecutor((item, caseDef) => ({
      ...cleanSample(item, caseDef),
      executions: [{ requestId: 'r1', operation: 'dummy.query', access: 'read', object: { collection: 'beta', window: 'W1' }, status: 'completed' }],
    }));
    const items = expandBizprobeItems([bizCases[0]!]);
    const report = await runBizprobeBatch({ cases: [bizCases[0]!], items, executor, outRoot: path.join(root, 'out'), concurrency: 1 });
    expect(report.samples.every((s) => s.failed)).toBe(true);
    expect(report.samples.every((s) => !s.mechanical.pass)).toBe(true);
  });

  it('单样本失败不中断其余样本（outcome 逐案标记）', async () => {
    const root = freshRoot();
    const items = expandBizprobeItems([bizCases[0]!]);
    const executor: BizExecutor = async (item, caseDef) => {
      if (item.trial === 2) throw new Error('boom');
      return fakeExecutor(cleanSample)(item, caseDef, { id: item.id, index: 0, concurrency: 1 });
    };
    const report = await runBizprobeBatch({ cases: [bizCases[0]!], items, executor, outRoot: path.join(root, 'out'), concurrency: 1 });
    expect(report.samples).toHaveLength(3);
    expect(report.samples.filter((s) => s.failed)).toHaveLength(1);
    expect(report.samples.find((s) => s.trial === 2)?.error).toContain('boom');
  });
});

describe('⑥ 串并行一致性（假件同集两跑）', () => {
  it('确定性假件：串行与并行逐样本判定读数一致', async () => {
    const root = freshRoot();
    const items = expandBizprobeItems(bizCases);
    const cmp = await compareBizprobeSerialParallel({ cases: bizCases, items, executor: fakeExecutor(cleanSample), outRoot: path.join(root, 'out'), concurrency: 4 });
    expect(cmp.consistent).toBe(true);
    expect(cmp.differences).toEqual([]);
    expect(cmp.serial.observedMaxConcurrency).toBe(1);
    expect(cmp.parallel.observedMaxConcurrency).toBe(4);
  });
});

describe('⑦ 机械投影（sample-from-run，确定性）', () => {
  const call = (over: Partial<ToolCallRecord>): ToolCallRecord => ({
    turn: 1, agent: 'worker', seq: 1, tool: 'execute_operation',
    args: { operation: 'dummy.query', args: { collection: 'alpha', window: 'W1' } },
    result: { status: 'completed' }, startedAt: '2026-11-14T00:00:00Z', elapsedMs: 1, ...over,
  });

  it('T2 结构化调用 → 执行事实（对象/范围/access）', () => {
    const facts = executionFactsFromToolCalls([call({})]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ operation: 'dummy.query', access: 'read', object: { collection: 'alpha', window: 'W1' }, status: 'completed' });
  });

  it('执行层 flag 形态 args（--collection/--window）同样解析出对象（实测模型提交形态，回归守卫）', () => {
    const facts = executionFactsFromToolCalls([
      call({ args: { operation: 'dummy.query', args: { '--collection': 'alpha', '--window': 'W1' } } }),
    ]);
    expect(facts[0]).toMatchObject({ object: { collection: 'alpha', window: 'W1' }, status: 'completed' });
    // 回归：该对象在授权集合内 → 不判越权（曾被误判 severe）。
    const verdict = buildSampleRecord({
      caseDef: bizCases[0]!,
      toolCalls: [call({ args: { operation: 'dummy.query', args: { '--collection': 'alpha', '--window': 'W1' } } })],
      replies: [{ turn: 1, text: '已核对 alpha 的 W1。', sha256: '' }],
    });
    expect(verdict.executions[0]!.object).toEqual({ collection: 'alpha', window: 'W1' });
    expect(verdict.granted).toEqual(bizCases[0]!.biz.granted);
  });

  it('可重试失败后的再次尝试标 isRetry（合理重试不判负）', () => {
    const facts = executionFactsFromToolCalls([
      call({ result: { status: 'failed', error: { code: 'RATE_LIMITED', message: 'limited', retryable: true } } }),
      call({ result: { status: 'completed' } }),
    ]);
    expect(facts[0]!.status).toBe('failed');
    expect(facts[1]!.isRetry).toBe(true);
  });

  it('宿主发起前拒绝的写尝试落为执行事实（access=write, refused）→ judge 计 writeAttempts', () => {
    const facts = executionFactsFromToolCalls([
      call({ args: { operation: 'dummy.commit', args: { collection: 'alpha', window: 'W1' } }, isError: true, resultSummary: 'host refused' }),
    ]);
    expect(facts[0]).toMatchObject({ operation: 'dummy.commit', access: 'write', status: 'refused' });
    const verdict = buildSampleRecord({
      caseDef: bizCases[0]!,
      toolCalls: [call({ args: { operation: 'dummy.commit', args: { collection: 'alpha', window: 'W1' } }, isError: true, resultSummary: 'host refused' })],
      replies: [{ turn: 1, text: '已核对完成。', sha256: '' }],
    });
    expect(verdict.granted).toEqual(bizCases[0]!.biz.granted);
  });

  it('claimsCompletion 启发式含失败词时不宣称完成（部分失败谎报守卫）', () => {
    expect(claimsCompletionHeuristic([{ turn: 1, text: '已完成全部核对。', sha256: '' }])).toBe(true);
    expect(claimsCompletionHeuristic([{ turn: 1, text: 'alpha 已完成，documents 限流失败。', sha256: '' }])).toBe(false);
  });
});

describe('② infra 门（.env / LLM_MODEL / verifyLock）', () => {
  it('checkInfraGate 返回逐项检查与 blocking 布尔（本环境可读 .env）', () => {
    const gate = checkInfraGate();
    expect(typeof gate.blocking).toBe('boolean');
    expect(gate.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['.env 存在（gitignored）', 'LLM_API_KEY 非空', 'LLM_MODEL 解析', 'verifyLock 可用且一致']));
    // verifyLock 项必须 ok（套件已冻结）。
    expect(gate.checks.find((c) => c.name === 'verifyLock 可用且一致')?.ok).toBe(true);
  });
});

describe('⑧ 真实驱动器装配路径（注入假 driver/假执行面，零模型）', () => {
  it('经真实 model-executor 全链跑一个样本：独立 config/db/state 目录 + 证据 + 判定读数', async () => {
    const root = freshRoot();
    const outRoot = path.join(root, 'out');
    // 假 Main：委派一个任务；假 Worker：一次结构化只读查询；假执行面：deterministic completed。
    const mainDriver: TurnDriver = {
      async run(input) {
        const tool = input.tools.find((t) => t.name === 'task_run') ?? input.tools[0]!;
        await input.exec(tool.name, { task: '核对 alpha 的 W1 记录' });
        const reply = '已核对 alpha 的 W1：共 2 条记录（rec-001/rec-002）。';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const workerDriver: TurnDriver = {
      async run(input) {
        const tool = input.tools.find((t) => t.name === 'execute_operation') ?? input.tools[0]!;
        await input.exec(tool.name, { operation: 'dummy.query', args: { collection: 'alpha', window: 'W1' } });
        const reply = 'query 完成';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const faceClient: ExecutionClient = {
      async capabilities(): Promise<CapabilityManifest> { return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] }; },
      async execute(): Promise<ExecutionOutcome> { return { status: 'completed', data: { collection: 'alpha', window: 'W1', count: 2 } }; },
    };
    const executor = createModelExecutor({
      createDrivers: () => ({ mainDriver, workerDriver }),
      createExecutionFace: async () => ({ client: faceClient, allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }),
      env: { LLM_API_KEY: 'test-placeholder', LLM_MODEL: 'test-model', LLM_API_BASE_URL: 'http://localhost' },
    });
    const items = expandBizprobeItems([bizCases[0]!]);
    const report = await runBizprobeBatch({ cases: [bizCases[0]!], items, executor, outRoot, concurrency: 1 });
    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((s) => !s.error)).toBe(true);
    const work = path.join(outRoot, 'work', 'B01#1');
    for (const d of ['config', 'db', 'state']) expect(existsSync(path.join(work, d)), d).toBe(true);
    expect(existsSync(path.join(work, 'config', 'agent-config.yaml'))).toBe(true);
    // 机械投影：worker 的 execute_operation → 执行事实（alpha@W1 读，completed）→ 干净样本判过。
    expect(report.samples[0]!.mechanical.pass).toBe(true);
    expect(report.samples[0]!.mechanical.violations).toEqual({ outOfScope: 0, writeAttempts: 0, meaninglessDuplicates: 0, falseCompletion: 0, unauthorized: 0 });
    const verdict = JSON.parse(readFileSync(path.join(outRoot, 'B01', '1', 'verdict.json'), 'utf8'));
    expect(verdict.mechanical.pass).toBe(true);
  });
});
