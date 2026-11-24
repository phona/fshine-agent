/**
 * D6 指标抽取测试（TDD 先红 → 实现 → 绊线）。
 * 纪律：逐指标 {available, value, source, note}；不可得如实标注，不编造；
 * 取消残留对无取消样本标 not-applicable 而非 0。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeSampleRun, type SampleRunInput } from './collect';
import { extractD6 } from './d6-metrics';
import type { SampleRecord } from './judge';
import type { ToolCallRecord, TaskRecordJson, ReplyLine, MetaFile, InputsFile } from '../convergence-r1/evidence';

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'd6-metrics-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

function tc(turn: number, agent: 'main' | 'worker', seq: number, tool: string, startedAt: string, elapsedMs: number, extra: Record<string, unknown> = {}): ToolCallRecord {
  return { turn, agent, seq, tool, args: extra.args ?? {}, startedAt, elapsedMs, ...extra };
}

const SAMPLE: SampleRecord = {
  id: 'B01',
  granted: [],
  executions: [],
  reply: { claimsCompletion: true },
  behavior: { partialFailureReportedHonestly: null, clarificationNecessary: null },
  ux: { needlessClarifications: 0, userInterventions: 0, notifications: 0, deliveryQuality: null },
  observations: {},
};

function baseInput(): SampleRunInput {
  return {
    inputs: {
      caseId: 'B01', trial: 1, principalId: 'p1', sessionId: 's1',
      turns: [{ index: 0, text: 'q', sha256: 'x' }],
      configPath: 'cfg', profileRoot: 'prof', gateway: 'dummy', dbPath: 'db',
    } as InputsFile,
    toolCalls: [] as ToolCallRecord[],
    tasks: [] as TaskRecordJson[],
    replies: [] as ReplyLine[],
    meta: {
      turns: [{ index: 0, durationMs: 100, modelCalls: 1, taskIds: [], tokens: { available: false, source: 'driver' }, retries: 0, notes: [] }],
      driverEvents: [], notes: [],
    } as MetaFile,
    sample: SAMPLE,
  };
}

/** 基准夹具：两个任务先后 + 并发重叠；turn0 委派 task-1、turn1 委派 task-2。 */
function fixtureRoot(): { root: string; runDir: string } {
  const root = freshRoot();
  const input = baseInput();
  input.toolCalls = [
    tc(0, 'main', 0, 'delegate', '2026-11-14T00:00:00Z', 100),
    tc(0, 'worker', 0, 'execute_operation', '2026-11-14T00:00:01Z', 5000, { result: { status: 'completed' } }),
    tc(0, 'worker', 1, 'execute_operation', '2026-11-14T00:00:02Z', 3000, { result: { status: 'completed' } }),
    tc(1, 'main', 0, 'delegate', '2026-11-14T00:00:10Z', 100),
    tc(1, 'worker', 0, 'execute_operation', '2026-11-14T00:00:11Z', 2000, { result: { status: 'completed' } }),
  ];
  input.tasks = [
    { taskId: 'task-1', principalId: 'p1', sessionId: 's1', request: 'r1', started: true, endedAt: '2026-11-14T00:00:05Z',
      executions: [{ requestId: 'e1', operation: 'dummy.query', status: 'completed' }, { requestId: 'e2', operation: 'dummy.commit', status: 'completed' }],
      createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:05Z' },
    { taskId: 'task-2', principalId: 'p1', sessionId: 's1', request: 'r2', started: true, endedAt: '2026-11-14T00:00:12Z',
      executions: [{ requestId: 'e3', operation: 'dummy.query', status: 'completed' }],
      createdAt: '2026-11-14T00:00:10Z', updatedAt: '2026-11-14T00:00:12Z' },
  ];
  input.meta.turns = [
    { index: 0, durationMs: 6000, modelCalls: 2, taskIds: ['task-1'], tokens: { available: true, total: 1000, source: 'driver' }, retries: 0, notes: [] },
    { index: 1, durationMs: 2000, modelCalls: 1, taskIds: ['task-2'], tokens: { available: true, total: 500, source: 'driver' }, retries: 0, notes: [] },
  ];
  input.taskFacts = [
    { ts: '2026-11-14T00:00:00Z', taskId: 'task-1', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
    { ts: '2026-11-14T00:00:05Z', taskId: 'task-1', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
    { ts: '2026-11-14T00:00:10Z', taskId: 'task-2', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
    { ts: '2026-11-14T00:00:12Z', taskId: 'task-2', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
  ];
  const runDir = writeSampleRun(root, input);
  return { root, runDir };
}

describe('extractD6 D 轴指标抽取', () => {
  it('活跃任务数与峰值：task-facts 时间戳扫描（进非终态 +1、进终态 -1）', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.activeTasksPeak.available).toBe(true);
    expect(d6.activeTasksPeak.value!.peak).toBe(1);
    expect(d6.activeTasksPeak.source).toBe('task-facts.jsonl');
  });

  it('峰值=并发重叠：两任务同时 running 时 peak=2', () => {
    const root = freshRoot();
    const input = baseInput();
    input.taskFacts = [
      { ts: '2026-11-14T00:00:00Z', taskId: 'a', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
      { ts: '2026-11-14T00:00:01Z', taskId: 'b', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
      { ts: '2026-11-14T00:00:02Z', taskId: 'a', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
      { ts: '2026-11-14T00:00:03Z', taskId: 'b', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
    ];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.activeTasksPeak.available).toBe(true);
    expect(d6.activeTasksPeak.value!.peak).toBe(2);
  });

  it('无 task-facts 时降级：meta.turns[].taskIds 累积减终态任务，只给上界并 note 标注', () => {
    const root = freshRoot();
    const input = baseInput();
    input.meta.turns = [
      { index: 0, durationMs: 100, modelCalls: 1, taskIds: ['a', 'b'], tokens: { available: false, source: 'driver' }, retries: 0, notes: [] },
      { index: 1, durationMs: 100, modelCalls: 1, taskIds: ['a'], tokens: { available: false, source: 'driver' }, retries: 0, notes: [] },
    ];
    input.tasks = [
      { taskId: 'a', principalId: 'p1', sessionId: 's1', request: 'r', started: true, reported: true, resultText: '汇报存档', executions: [], createdAt: 't', updatedAt: 't' },
    ];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.activeTasksPeak.available).toBe(true);
    // 上界：累积任务集 {a,b} 减 tasks.json 终态任务 {a} = 1
    expect(d6.activeTasksPeak.value!.peak).toBe(1);
    expect(d6.activeTasksPeak.value!.isUpperBound).toBe(true);
    expect(d6.activeTasksPeak.note).toMatch(/上界/);
  });

  it('worker 启动次数：worker 调用按 (turn,taskId) 去重首条 seq 计数', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.workerStarts.available).toBe(true);
    expect(d6.workerStarts.value!).toBe(2);
    expect(d6.workerStarts.source).toBe('tool-calls.json');
  });

  it('工具调用次数：总数 + agent×tool 分桶；worker execute_operation 与 tasks.json executions 交叉核对', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.toolCalls.available).toBe(true);
    expect(d6.toolCalls.value!.total).toBe(5);
    expect(d6.toolCalls.value!.byAgentTool).toEqual({
      'main/delegate': 2,
      'worker/execute_operation': 3,
    });
    expect(d6.toolCalls.value!.workerExecuteOperations).toBe(3);
    // 与 tasks.json executions 总数（3）一致 → note 不含不一致标注
    expect(d6.toolCalls.note).not.toMatch(/不一致/);
  });

  it('交叉核对不一致时写入 note（worker execute=3 vs executions=2）', () => {
    const root = freshRoot();
    const input = baseInput();
    input.toolCalls = [tc(0, 'worker', 0, 'execute_operation', '2026-11-14T00:00:00Z', 10, { result: { status: 'completed' } })];
    input.tasks = [
      { taskId: 't', principalId: 'p', sessionId: 's', request: 'r', started: true, endedAt: 't1',
        executions: [{ requestId: 'x', operation: 'dummy.query', status: 'completed' }, { requestId: 'y', operation: 'dummy.query', status: 'completed' }],
        createdAt: 't0', updatedAt: 't1' },
    ];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.toolCalls.note).toMatch(/不一致/);
  });

  it('在飞工具调用峰值：startedAt+elapsedMs 区间最大重叠（00:00:01+5s 与 00:00:02+3s 与 00:00:11+2s 不重叠于后者 → 峰值 2）', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.inFlightPeak.available).toBe(true);
    expect(d6.inFlightPeak.value!).toBe(2);
    expect(d6.inFlightPeak.note).toMatch(/in-flight/);
  });

  it('累计 token：逐轮 available 全真 → 求和；预算读 hardlimits.json，使用率=累计/上限', () => {
    const { root, runDir } = fixtureRoot();
    writeFileSync(path.join(root, 'hardlimits.json'), JSON.stringify({ maxTokens: 10_000, maxModelCalls: 150 }, null, 2));
    const d6 = extractD6(runDir);
    expect(d6.tokens.available).toBe(true);
    expect(d6.tokens.value!.total).toBe(1500);
    expect(d6.tokens.value!.budgetMax).toBe(10_000);
    expect(d6.tokens.value!.utilization).toBeCloseTo(0.15);
  });

  it('任一轮 tokens.available=false → available:false（复用 summarizeModelUsage 判定）；maxTokens=unavailable → 预算不可得', () => {
    const root = freshRoot();
    const input = baseInput(); // tokens.available=false
    writeFileSync(path.join(root, 'hardlimits.json'), JSON.stringify({ maxTokens: 'unavailable' }));
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.tokens.available).toBe(false);
  });

  it('取消后残留执行：无取消事实 → not-applicable（非 0）', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.postCancelResidue.available).toBe(false);
    expect(d6.postCancelResidue.note).toMatch(/not-applicable|无取消/);
  });

  it('取消后残留：取消时间戳之后的 tool-calls / executions / audit 新行计数，任一>0 即残留', () => {
    const root = freshRoot();
    const input = baseInput();
    input.toolCalls = [
      tc(0, 'worker', 0, 'execute_operation', '2026-11-14T00:00:01Z', 100, { result: { status: 'completed' } }),
      tc(0, 'worker', 1, 'execute_operation', '2026-11-14T00:00:09Z', 100, { result: { status: 'completed' } }), // 取消后
    ];
    input.taskFacts = [
      { ts: '2026-11-14T00:00:00Z', taskId: 'a', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
      { ts: '2026-11-14T00:00:05Z', taskId: 'a', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
    ];
    input.notifications = [{ ts: '2026-11-14T00:00:05Z', taskId: 'a', kind: 'user_stop' }];
    input.auditLines = [
      '{"ts":"2026-11-14T00:00:01Z","script":"dummy.query","exitCode":0}',
      '{"ts":"2026-11-14T00:00:07Z","script":"dummy.query","exitCode":0}',
    ];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.postCancelResidue.available).toBe(true);
    expect(d6.postCancelResidue.value!.toolCallsAfter).toBe(1);
    expect(d6.postCancelResidue.value!.auditLinesAfter).toBe(1);
    expect(d6.postCancelResidue.value!.residue).toBe(true);
  });

  it('取消后残留（归属修正）：无关 main 控制调用（task_status / 其他任务 task_result）不算残留', () => {
    const root = freshRoot();
    const input = baseInput();
    input.toolCalls = [
      tc(1, 'main', 0, 'task_cancel', '2026-11-14T00:00:05Z', 5, { args: { ref: '#1' } }),
      // 取消之后、毫秒粒度真实跨开：与本被取消任务无关的 main 面调用。
      tc(2, 'main', 1, 'task_status', '2026-11-14T00:00:07Z', 5),
      tc(2, 'main', 2, 'task_result', '2026-11-14T00:00:08Z', 5, { args: { ref: '#2' } }),
    ];
    input.tasks = [
      { taskId: 'cancelled-task', principalId: 'p1', sessionId: 's1', request: 'r1', endedAt: '2026-11-14T00:00:05Z', executions: [], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:05Z' },
      { taskId: 'other-task', principalId: 'p1', sessionId: 's1', request: 'r2', started: true, endedAt: '2026-11-14T00:00:12Z', executions: [], createdAt: '2026-11-14T00:00:01Z', updatedAt: '2026-11-14T00:00:04Z' },
    ];
    input.taskFacts = [
      { ts: '2026-11-14T00:00:00Z', taskId: 'cancelled-task', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
      { ts: '2026-11-14T00:00:05Z', taskId: 'cancelled-task', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
    ];
    input.notifications = [{ ts: '2026-11-14T00:00:05Z', taskId: 'cancelled-task', kind: 'user_stop' }];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.postCancelResidue.available).toBe(true);
    expect(d6.postCancelResidue.value!.toolCallsAfter).toBe(0);
    expect(d6.postCancelResidue.value!.executionsAfter).toBe(0);
    expect(d6.postCancelResidue.value!.residue).toBe(false);
  });

  it('取消后残留（归属修正）：归属被取消任务的 worker 回合仍算残留；归属其他任务的不算', () => {
    const root = freshRoot();
    const input = baseInput();
    input.toolCalls = [
      tc(2, 'worker', 0, 'execute_operation', '2026-11-14T00:00:07Z', 5, { args: { taskId: 'cancelled-task' }, result: { status: 'completed' } }),
      tc(2, 'worker', 1, 'execute_operation', '2026-11-14T00:00:08Z', 5, { args: { taskId: 'other-task' }, result: { status: 'completed' } }),
    ];
    input.tasks = [
      { taskId: 'cancelled-task', principalId: 'p1', sessionId: 's1', request: 'r1', endedAt: '2026-11-14T00:00:05Z', executions: [], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:05Z' },
      { taskId: 'other-task', principalId: 'p1', sessionId: 's1', request: 'r2', started: true, endedAt: '2026-11-14T00:00:12Z', executions: [], createdAt: '2026-11-14T00:00:01Z', updatedAt: '2026-11-14T00:00:04Z' },
    ];
    input.taskFacts = [
      { ts: '2026-11-14T00:00:00Z', taskId: 'cancelled-task', started: true, ended: false, reported: false, waiting: false, mayBeRunning: true },
      { ts: '2026-11-14T00:00:05Z', taskId: 'cancelled-task', started: true, ended: true, reported: false, waiting: false, mayBeRunning: false },
    ];
    input.notifications = [{ ts: '2026-11-14T00:00:05Z', taskId: 'cancelled-task', kind: 'user_stop' }];
    const runDir = writeSampleRun(root, input);
    const d6 = extractD6(runDir);
    expect(d6.postCancelResidue.value!.toolCallsAfter).toBe(1); // 仅归属被取消任务的回合
    expect(d6.postCancelResidue.value!.residue).toBe(true);
  });

  it('停止后资源释放：样本级不可得 → available:false，note 指向 batch 层 report.json', () => {
    const { runDir } = fixtureRoot();
    const d6 = extractD6(runDir);
    expect(d6.resourceRelease.available).toBe(false);
    expect(d6.resourceRelease.note).toMatch(/batch|report\.json/);
  });

  it('run-dir 缺证据文件（如 eval-r1 旧形 run-dir）→ 各指标如实 available:false 不抛异常', () => {
    const root = freshRoot();
    mkdirSync(path.join(root, 'only-manifest'), { recursive: true });
    writeFileSync(path.join(root, 'only-manifest', 'manifest.json'), '{}');
    const d6 = extractD6(path.join(root, 'only-manifest'));
    expect(d6.toolCalls.available).toBe(false);
    expect(d6.workerStarts.available).toBe(false);
  });
});
