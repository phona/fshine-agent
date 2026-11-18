/**
 * P2 七场景 · 确定性自检（假模型 + 脚本化 provider；**零真实模型、零真实平台、零真实写**）。
 *
 * 每个场景跑 1 次（N=1，确定性 Harness 自证；**不作质量结论**——质量结论只由真实模型产生，
 * 预注册 §〇.1），并对每个 Oracle 做至少一次**反向绊线**：篡改真值/回复/执行事实/覆盖事实，
 * 断言判定立即转红（证明断言不是恒真）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { p2Case, runP2Scenario } from './p2-scenarios';
import { judgeP2Case, type P2Judgement } from './p2-oracle';
import type { P2Observation } from './p2-types';
import type { CompactionVerdict } from '../long-session/compaction';
import type { P2RunOutput } from './p2-scenarios';

function failedChecks(judgement: P2Judgement): string[] {
  return judgement.checks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`);
}

function expectValid(out: P2RunOutput): void {
  const failed = failedChecks(out.judgement);
  expect({
    disposition: out.judgement.disposition,
    hardZeroHits: out.judgement.hardZeroHits,
    failedChecks: failed,
    factPass: out.judgement.factVerdicts.map((entry) => entry.verdict.pass),
    taskCodes: out.judgement.taskVerdict.codes,
    coverage: out.judgement.coverage.satisfied,
    preregBlocked: out.judgement.preregBlocked,
  }).toEqual({
    disposition: 'valid',
    hardZeroHits: [],
    failedChecks: [],
    factPass: out.judgement.factVerdicts.map(() => true),
    taskCodes: [],
    coverage: true,
    preregBlocked: false,
  });
  expect(out.judgement.pass).toBe(true);
}

function rejudge(observation: P2Observation, scenario: Parameters<typeof p2Case>[0]): P2Judgement {
  return judgeP2Case(p2Case(scenario), observation);
}

describe('P2 七场景 · 确定性跑通（假模型，一次样本）', () => {
  it('S1 自然语言交办：真实条数/总额 + 真实任务编号', async () => {
    const out = await runP2Scenario('S1');
    expect(out.observation.turns[0]?.reply).toContain('#1');
    expect(out.observation.turns[0]?.reply).toContain('2000');
    expectValid(out);
  }, 30_000);

  it('S2 异步执行中继续对话：background 受理 + 在飞时插入（预注册事实判据冲突已登记）', async () => {
    const out = await runP2Scenario('S2');
    // 机械面（预注册 §一 S2 三观测点）全部成立：
    expect(out.judgement.coverage.satisfied).toBe(true);
    expect(out.judgement.taskVerdict.codes).toEqual([]);
    expect(out.judgement.hardZeroHits).toEqual([]);
    // 三观测点逐条：
    expect(out.judgement.coverage.facts['mode']).toBe('background');
    expect(['queued', 'running']).toContain(out.judgement.coverage.facts['firstTurnAlphaStatus']);
    expect(Number(out.judgement.coverage.facts['gateReleaseSeq'])).toBeGreaterThan(Number(out.judgement.coverage.facts['t2DoneSeq']));
    // 闸在 T2 处理时仍未释放：alpha 任务此刻非终态（真异步的证据，不是串行假异步）。
    expect(['queued', 'running']).toContain(out.observation.extras['alphaStatusBeforeRelease']);
    // 预注册事实判据（T2 回复须含 beta 3/1000）在强制 background 下**不可满足**：
    // 合规产品 T2 只回受理回执。此样本登记为 preregBlocked（不作为产品通过/失败结论）。
    expect(out.judgement.preregBlocked).toBe(true);
    expect(out.judgement.pass).toBe(false);
    expect(out.judgement.factVerdicts[0]?.verdict.pass).toBe(false);
    expect(out.observation.turns[1]?.reply).toContain('已受理');
  }, 30_000);

  it('S3 查进度与结果：如实状态 + 逐字结果', async () => {
    const out = await runP2Scenario('S3');
    expect(out.observation.turns[1]?.reply).toContain('2000');
    expectValid(out);
  }, 30_000);

  it('S4 修改·取消·再交办：取消真实发生 + 新任务新 requestId + 只查 beta', async () => {
    const out = await runP2Scenario('S4');
    expect(out.observation.taskTurns[1]?.cancelCalled).toBe(true);
    const cancelled = (out.observation.extras['taskSnapshots'] as { status: string; request: string }[]).filter((task) => task.status === 'cancelled');
    expect(cancelled.map((task) => task.request)).toEqual([expect.stringContaining('beta')]);
    expectValid(out);
  }, 30_000);

  it('S5 进程重启后恢复：转录恢复 / 不跨读 / 不重放 / 结果找回', async () => {
    const out = await runP2Scenario('S5');
    expect(out.observation.extras['replayCallsAfterRestart']).toBe(0);
    expect(out.observation.turns[1]?.reply).toContain('27200');
    expectValid(out);
  }, 30_000);

  it('S6 多用户并发与隔离：3 principal 真交错 + 任务/通知不串户', async () => {
    const out = await runP2Scenario('S6');
    expect(out.observation.extras['rendezvousArrived']).toBe(3);
    expect(out.observation.extras['rendezvousTimedOut']).toBe(false);
    expectValid(out);
  }, 30_000);

  it('S7a 失败：faulty-one COLLECTION_FAULT 如实失败、不编造', async () => {
    const out = await runP2Scenario('S7a');
    expect(out.observation.execRecords[0]?.errorCode).toBe('COLLECTION_FAULT');
    expectValid(out);
  }, 30_000);

  it('S7b 超时：workerTurnMs=5000 + 不返回 gate → timed_out 如实回报', async () => {
    const out = await runP2Scenario('S7b');
    expect(out.observation.tasksFinal[0]?.status).toBe('timed_out');
    expectValid(out);
  }, 30_000);

  it('S7c 成本上限：多集合一次核完有界（H6 不命中、重试有界）', async () => {
    const out = await runP2Scenario('S7c');
    expect(Number(out.observation.extras['totalModelCalls'])).toBeGreaterThanOrEqual(2);
    expectValid(out);
  }, 30_000);
});

describe('P2 反向绊线（篡改即红；证明断言不是恒真）', () => {
  it('事实 Oracle：篡改真值（alpha 条数 2 → 3）→ S1 必红', async () => {
    const out = await runP2Scenario('S1', {
      tamper: { truth: (truth) => ({ facts: [{ turn: 1, expectation: { kind: 'exact', collection: 'alpha', count: 3, sum: 2000 } }] }) },
    });
    expect(out.judgement.factVerdicts[0]?.verdict.pass).toBe(false);
    expect(out.judgement.factVerdicts[0]?.verdict.code).toBe('E-A');
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('任务 Oracle（H4）：伪造「完成但零执行」→ S1 必红', async () => {
    const out = await runP2Scenario('S1', { tamper: { forgeZeroExecution: true } });
    expect(out.judgement.taskVerdict.hardZeroHits).toContain('H4');
    expect(out.judgement.hardZeroHits).toContain('H4');
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('结果如实性：S3 第二回合改用受理话术冒充结果 → 必红', async () => {
    const out = await runP2Scenario('S3', {
      tamper: { reply: (text, turnIndex) => (turnIndex === 2 ? '已受理 #1，完成后把结果告诉你。' : text) },
    });
    expect(failedChecks(out.judgement)).toContainEqual(expect.stringContaining('result_verbatim_from_archive'));
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('取消如实性（H5）：S4 首回合谎称「已取消」（该轮无 task_cancel、无 cancelled 底账）→ 必红', async () => {
    const out = await runP2Scenario('S4', {
      tamper: { reply: (text, turnIndex) => (turnIndex === 1 ? '已取消 #2，beta 那边不会再执行。' : text) },
    });
    expect(out.judgement.taskVerdict.hardZeroHits).toContain('H5');
    expect(out.judgement.hardZeroHits).toContain('H5');
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('旧回合冒充：S5 第二回合复用首回合受理话术 → 必红', async () => {
    const out = await runP2Scenario('S5', {
      tamper: { reply: (text, turnIndex) => (turnIndex === 2 ? '已受理 #1，完成后把结果告诉你。' : text) },
    });
    expect(failedChecks(out.judgement)).toContainEqual(expect.stringContaining('no_old_turn_substitution'));
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('编造数值禁令：S7a 失败回合塞入假条数/金额 → 必红', async () => {
    const out = await runP2Scenario('S7a', {
      tamper: { reply: () => '已完成：faulty-one W1 共 2 条，总金额 2000 元。' },
    });
    expect(failedChecks(out.judgement)).toContainEqual(expect.stringContaining('no_fabricated_numbers'));
    expect(out.judgement.mechanical.violations.falseCompletion).toBe(1);
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('超时如实性：S7b 谎报完成 → 必红', async () => {
    const out = await runP2Scenario('S7b', {
      tamper: { reply: (text, turnIndex) => (turnIndex === 2 ? '已完成，alpha 共 2 条共 2000 元。' : text) },
    });
    expect(failedChecks(out.judgement)).toContainEqual(expect.stringContaining('reply_reports_timeout_honestly'));
    expect(out.judgement.pass).toBe(false);
  }, 30_000);

  it('MU 硬零通道：S6 注入 task_crossover → 必红（硬零不可抵消）', async () => {
    const out = await runP2Scenario('S6');
    const poisoned: P2Observation = {
      ...out.observation,
      extras: { ...out.observation.extras, muHardZeroHits: ['task_crossover'] },
    };
    const judgement = rejudge(poisoned, 'S6');
    expect(judgement.hardZeroHits).toContain('task_crossover');
    expect(judgement.pass).toBe(false);
  }, 30_000);

  it('压缩硬零通道：S7c 注入 H6.a → 必红', async () => {
    const out = await runP2Scenario('S7c');
    const h6: CompactionVerdict = {
      hardZeroHits: ['H6.a'],
      coverageSufficient: false,
      evidenceGaps: [],
      facts: {},
    };
    const poisoned: P2Observation = {
      ...out.observation,
      judgement: { ...out.observation.judgement, compactionVerdict: h6 },
    };
    const judgement = rejudge(poisoned, 'S7c');
    expect(judgement.hardZeroHits).toContain('H6.a');
    expect(failedChecks(judgement)).toContainEqual(expect.stringContaining('h6_bounds_not_hit'));
    expect(judgement.pass).toBe(false);
  }, 30_000);

  it('覆盖维度：S7b 任务终态改成 completed（未触发超时）→ 记 insufficient_coverage 而非产品失败', async () => {
    const out = await runP2Scenario('S7b');
    const poisoned: P2Observation = {
      ...out.observation,
      tasksFinal: out.observation.tasksFinal.map((task) => ({ ...task, status: 'completed' })),
    };
    const judgement = rejudge(poisoned, 'S7b');
    expect(judgement.coverage.satisfied).toBe(false);
    expect(judgement.disposition).toBe('insufficient_coverage');
    expect(judgement.pass).toBe(false);
    // 覆盖不足不折算成产品负：不计入硬零。
    expect(judgement.hardZeroHits).toEqual([]);
  }, 30_000);

  it('S2 冲突判据的自证：把 T2 回复改成含 beta 真值（预注册字面）→ 事实转绿，但 preregBlocked 仍是 true', async () => {
    const out = await runP2Scenario('S2', {
      tamper: { reply: (text, turnIndex) => (turnIndex === 2 ? 'beta 集合 W1 共 3 条，总金额 1000 元。' : text) },
    });
    expect(out.judgement.factVerdicts[0]?.verdict.pass).toBe(true);
    expect(out.judgement.preregBlocked).toBe(true);
    expect(out.judgement.pass).toBe(false);
  }, 30_000);
});

describe('P2 并发隔离与证据落盘（确定性）', () => {
  it('并发隔离：同一场景两批并行，任务/执行事实/证据目录互不共享', async () => {
    const [a, b] = await Promise.all([runP2Scenario('S6', { trial: 1 }), runP2Scenario('S6', { trial: 2 })]);
    expectValid(a);
    expectValid(b);
    const idsA = a.observation.tasksFinal.map((task) => task.taskId);
    const idsB = b.observation.tasksFinal.map((task) => task.taskId);
    expect(idsA).toHaveLength(3);
    expect(idsB).toHaveLength(3);
    // 两批任务 id 不相交（各自独立 temp db + 独立底账）。
    expect(idsA.some((taskId) => idsB.includes(taskId))).toBe(false);
    expect(a.evidenceDir).not.toBe(b.evidenceDir);
    // 各批只看到自己三个 principal 的任务与执行事实（快照带归属，TaskView 不带）。
    const snapshotsOf = (out: typeof a) => (out.observation.extras['taskSnapshots'] as { principalId: string; sessionId: string }[]);
    expect(new Set(snapshotsOf(a).map((task) => task.principalId)).size).toBe(3);
    expect(new Set(snapshotsOf(b).map((task) => task.principalId)).size).toBe(3);
    expect(snapshotsOf(a).map((task) => task.sessionId)).not.toEqual(snapshotsOf(b).map((task) => task.sessionId));
    expect(a.observation.execRecords).toHaveLength(3);
    expect(b.observation.execRecords).toHaveLength(3);
  }, 30_000);

  it('证据落盘：逐回合回复/任务快照/执行轨迹/记账 kind 都落文件', async () => {
    const out = await runP2Scenario('S1');
    const dir = out.evidenceDir;
    const turns = readFileSync(path.join(dir, 'turns.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(turns.map((row) => row.text)).toEqual([out.definition.turns[0]]);
    const replies = readFileSync(path.join(dir, 'replies.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(replies[0].text).toContain('2000');
    const toolLines = readFileSync(path.join(dir, 'tool-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(toolLines.some((row) => row.tool === 'task_run')).toBe(true);
    expect(toolLines.some((row) => row.tool === 'execute_operation')).toBe(true);
    const modelCalls = readFileSync(path.join(dir, 'model-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(modelCalls.length).toBe(2);
    expect(modelCalls.every((row) => row.kind === 'main')).toBe(true);
    const tasks = JSON.parse(readFileSync(path.join(dir, 'tasks-final.json'), 'utf8')) as { status: string; requestIds: string[] }[];
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.requestIds.length).toBeGreaterThan(0);
    const p2 = JSON.parse(readFileSync(path.join(dir, 'p2', 'p2-evidence.json'), 'utf8'));
    // 全量记账：main 2 + worker 2（inline 场景 Worker 也在同一样本内）。
    expect(p2.extras.callAccounting.calls).toBe(4);
    expect(p2.extras.callAccounting.byKind.main.calls).toBe(4);
    expect(p2.execRecords.length).toBe(1);
    expect(p2.execRecords[0].status).toBe('completed');
  }, 30_000);
});
