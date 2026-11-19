/**
 * 真模型写闭环小场景集验收脚本的绊线（`scripts/eval/real/write-loop-scenarios.ts`）。
 *
 * 三道锁（全部不跑模型、不触网）：
 *   ① 纯函数单测：参数解析、五个场景判据的正例全绿 + **逐条反向破坏必红**、机械读取
 *      （审计行/job 文件/args 扫描）；
 *   ② 证据形状：用户可见面、成功通道原文字符串判据按已知字符串工作（不是措辞判断）；
 *   ③ 子进程前置门：缺模型配置时**如实 exit 2 且不落回脚本模型**；--help 走帮助分支。
 *
 * 反向绊线（亲跑验证，见报告）：把任一场景判据的比较放宽（例如停后冻结改成 `<=`），
 * 下面「逐条反向破坏」用例立刻红。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { failureTextFor } from '../../../apps/server/task-completion-delivery';
import {
  CANCELLATION_FACT_MARKER,
  STILL_PROCESSING_NOTE,
  SUCCESS_CHANNEL_MARKERS,
  argsMention,
  evaluateFailureCriteria,
  evaluateIdempotencyCriteria,
  evaluateReconfirmCriteria,
  evaluateStopCriteria,
  evaluateTwoObjectsCriteria,
  parseScenarioArgs,
  readAuditFacts,
  readConfirmationLedger,
  readJobFacts,
  successMarkersIn,
  writeCallsOn,
  type FailureEvidence,
  type IdempotencyEvidence,
  type ReconfirmEvidence,
  type StopEvidence,
  type TwoObjectsEvidence,
} from './write-loop-scenarios';
import { EXPECTED_RECORDS, WRITE_COLLECTION, WRITE_WINDOW, type CriterionResult } from './write-loop';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = 'scripts/eval/real/write-loop-scenarios.ts';
const AT = '2026-11-19T10:00:00.000Z';

function statusOf(results: CriterionResult[], id: string): string | undefined {
  return results.find((result) => result.id === id)?.status;
}
function onlyFailed(results: CriterionResult[]): string[] {
  return results.filter((result) => result.status === 'fail').map((result) => result.id);
}

/** 全绿样例：五个场景各自一份；每个用例只改一处即对应一条判据红。 */
function greenStop(): StopEvidence {
  return {
    turns: [
      { index: 1, userText: '跑慢活', reply: '受理了，在跑了。', durationMs: 9_000 },
      { index: 2, userText: '停。', reply: '已经按你说的停了。', durationMs: 4_000 },
    ],
    pushes: [{ at: AT, source: 'push_text', text: `${CANCELLATION_FACT_MARKER}跑一件慢活。` }],
    toolCalls: [
      { seq: 1, agent: 'main', turn: 1, tool: 'task_run', args: '{"task":"慢活"}', ok: true, summary: 'running', elapsedMs: 8_000 },
      { seq: 2, agent: 'worker', turn: 1, tool: 'execute_operation', args: '{"operation":"dummy.longtask","args":{"--seconds":600}}', ok: true, summary: 'accepted', elapsedMs: 300 },
      { seq: 3, agent: 'main', turn: 2, tool: 'task_cancel', args: '{"ref":"#1"}', ok: true, summary: 'requested', elapsedMs: 90 },
    ],
    audit: [
      { mode: 'call', script: 'dummy.longtask', via: 'structured', exitCode: 0, longTask: 'accepted', operationId: 'op_1', args: { seconds: 600 } },
      { mode: 'abort', script: 'dummy.longtask', exitCode: 0, longTask: 'cancelled', operationId: 'op_1' },
    ],
    jobs: [{ operationId: 'op_1', status: 'cancelled', seconds: 600 }],
    tasks: [{
      taskId: 't-1', taskNo: 1, name: '慢活', status: 'cancelled',
      executions: [{ operation: 'dummy.longtask', status: 'accepted' }],
    }],
    statusSequence: ['queued', 'running', 'cancelling', 'cancelled'],
    visible: [
      { at: AT, source: 'turn', text: '受理了，在跑了。', turnIndex: 1 },
      { at: AT, source: 'turn', text: '已经按你说的停了。', turnIndex: 2 },
      { at: AT, source: 'push', text: `${CANCELLATION_FACT_MARKER}跑一件慢活。` },
    ],
    deliveryEvents: [],
    auditAtCancel: 2,
    auditAfterFreeze: 2,
    freezeWindowMs: 8_000,
    acceptedBeforeStop: true,
    cancelToolCall: { ok: true, summary: 'requested', args: '{"ref":"#1"}' },
  };
}

function greenFailure(): FailureEvidence {
  const template = failureTextFor('COLLECTION_LOCKED', 'failed');
  const prepareRow = {
    mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2,
    args: { '--collection': 'locked-one', '--window': 'W1' },
  };
  return {
    turns: [{ index: 1, userText: '写 locked-one', reply: '这件事没办成。', durationMs: 12_000 }],
    pushes: [{ at: AT, source: 'push_text', text: template }],
    toolCalls: [
      { seq: 1, agent: 'main', turn: 1, tool: 'task_run', args: '{"task":"写"}', ok: true, summary: 'failed', elapsedMs: 9_000 },
      { seq: 2, agent: 'worker', turn: 1, tool: 'execute_operation', args: '{"operation":"dummy.prepare","args":{"--collection":"locked-one"}}', ok: true, summary: 'failed', elapsedMs: 200 },
    ],
    audit: [prepareRow],
    jobs: [],
    tasks: [{
      taskId: 't-1', taskNo: 1, name: '写 locked-one', status: 'failed', reason: 'failed_confirmed',
      failureReason: '执行层未成功：dummy.prepare 返回 failed：Collection locked-one is locked',
      executions: [{ operation: 'dummy.prepare', status: 'failed', code: 'COLLECTION_LOCKED' }],
    }],
    statusSequence: ['queued', 'running', 'failed'],
    visible: [
      { at: AT, source: 'turn', text: '这件事没办成。', turnIndex: 1 },
      { at: AT, source: 'push', text: template },
    ],
    deliveryEvents: [{ event: 'task_result_delivery_sent', taskId: 't-1' }],
    readbackBefore: { status: 'completed', count: 1, items: [{ id: 'rec-301', name: 'locked-item-1', value: 900 }] },
    readbackAfter: { status: 'completed', count: 1, items: [{ id: 'rec-301', name: 'locked-item-1', value: 900 }] },
    writeCallsOnTarget: [prepareRow],
    failureCode: 'COLLECTION_LOCKED',
    pushTexts: [template],
    failureRelayedInTurn: false,
    retryAllowed: 0,
    retryBlocked: 0,
    attemptsOnTarget: 1,
  };
}

function greenIdempotency(): IdempotencyEvidence {
  const reply = '已受理：正在等确认。';
  return {
    turns: [{ index: 1, userText: '写入 4 条（重发一次）', reply, durationMs: 10_000 }],
    pushes: [{ at: AT, source: 'push_text', text: '要写入：…回「确认」我就提交。' }],
    toolCalls: [
      { seq: 1, agent: 'main', turn: 1, tool: 'task_run', args: '{"task":"新增4条"}', ok: true, summary: 'waiting_user', elapsedMs: 8_000 },
      { seq: 2, agent: 'worker', turn: 1, tool: 'execute_operation', args: '{"operation":"dummy.prepare"}', ok: true, summary: 'needs_confirmation', elapsedMs: 150 },
      { seq: 3, agent: 'main', turn: 2, tool: 'task_confirm', args: '{}', ok: true, summary: 'started', elapsedMs: 60 },
      { seq: 4, agent: 'worker', turn: 2, tool: 'execute_operation', args: '{"operation":"dummy.commit"}', ok: true, summary: 'completed', elapsedMs: 200 },
    ],
    audit: [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0 },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0 },
    ],
    jobs: [],
    tasks: [{
      taskId: 't-1', taskNo: 1, status: 'completed',
      executions: [{ operation: 'dummy.prepare', status: 'needs_confirmation' }, { operation: 'dummy.commit', status: 'completed' }],
    }],
    statusSequence: ['queued', 'running', 'waiting_user', 'running', 'completed'],
    visible: [
      { at: AT, source: 'turn', text: reply, turnIndex: 1 },
      { at: AT, source: 'push', text: '要写入：…回「确认」我就提交。' },
    ],
    deliveryEvents: [{ event: 'task_result_delivery_sent', taskId: 't-1' }],
    duplicate: {
      firstReply: reply, secondReply: reply, firstDurationMs: 10_000, secondDurationMs: 10_000,
      sameText: true, events: ['message_duplicate_replayed'],
    },
    readbackBefore: { status: 'completed', count: 0, items: [] },
    readbackAfter: {
      status: 'completed', collection: WRITE_COLLECTION, window: WRITE_WINDOW, count: 4, sum: 400,
      items: EXPECTED_RECORDS.map((record, index) => ({ id: `rec-${index}`, name: record.name, value: record.value })),
    },
    confirmations: { handles: 1, usedCount: 1, usedAt: AT },
    prepareSuccessCount: 1,
    commitSuccessCount: 1,
    taskRunCalls: 1,
  };
}

function greenReconfirm(): ReconfirmEvidence {
  return {
    turns: [
      { index: 1, userText: '写入 4 条', reply: '等你确认。', durationMs: 10_000 },
      { index: 2, userText: '确认', reply: '已提交。', durationMs: 4_000 },
      { index: 3, userText: '确认', reply: '这件事已经办完了，不用再确认。', durationMs: 3_000 },
    ],
    pushes: [{ at: AT, source: 'push_text', text: '你交代的那件事办好了：4 条已新增。' }],
    toolCalls: [
      { seq: 1, agent: 'main', turn: 1, tool: 'task_run', args: '{"task":"新增4条"}', ok: true, summary: 'waiting_user', elapsedMs: 8_000 },
      { seq: 2, agent: 'main', turn: 2, tool: 'task_confirm', args: '{}', ok: true, summary: 'started', elapsedMs: 60 },
      { seq: 3, agent: 'main', turn: 3, tool: 'task_confirm', args: '{}', ok: true, summary: 'no_waiting_task', elapsedMs: 40 },
    ],
    audit: [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0 },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0 },
    ],
    jobs: [],
    tasks: [{
      taskId: 't-1', taskNo: 1, status: 'completed', resultText: '4 条已新增（读回 4 条）',
      executions: [{ operation: 'dummy.prepare', status: 'needs_confirmation' }, { operation: 'dummy.commit', status: 'completed' }],
    }],
    statusSequence: ['queued', 'running', 'waiting_user', 'running', 'completed'],
    visible: [
      { at: '2026-11-19T09:00:00.000Z', source: 'push', text: '你交代的那件事办好了：4 条已新增。' },
      { at: '2026-11-19T10:00:01.000Z', source: 'turn', text: '这件事已经办完了，不用再确认。', turnIndex: 3 },
    ],
    deliveryEvents: [{ event: 'task_result_delivery_sent', taskId: 't-1' }],
    firstWriteLanded: true,
    confirmRounds: 1,
    commitSuccessCount: 1,
    commitCompletedFacts: 1,
    readbackAfter: {
      status: 'completed', collection: WRITE_COLLECTION, window: WRITE_WINDOW, count: 4, sum: 400,
      items: EXPECTED_RECORDS.map((record, index) => ({ id: `rec-${index}`, name: record.name, value: record.value })),
    },
    confirmations: { handles: 1, usedCount: 1, usedAt: AT },
    confirmationsAfterFirstWrite: { handles: 1, usedCount: 1, usedAt: AT },
    taskCountAfterFirstWrite: 1,
    taskCountAfterReconfirm: 1,
    thirdTurnStartedAt: '2026-11-19T10:00:00.000Z',
    textsAfterThirdTurn: [{ at: '2026-11-19T10:00:01.000Z', source: 'turn', text: '这件事已经办完了，不用再确认。', turnIndex: 3 }],
    auditCountAfterFirstWrite: 2,
    auditCountAfterReconfirm: 2,
    taskConfirmStartedCalls: [],
  };
}

function greenTwoObjects(): TwoObjectsEvidence {
  return {
    turns: [
      { index: 1, userText: '两件事', reply: '两件都交办了。', durationMs: 12_000 },
      { index: 2, userText: '确认', reply: '已提交第一件。', durationMs: 4_000 },
      { index: 3, userText: '确认', reply: '两件都提交完了。', durationMs: 4_000 },
    ],
    pushes: [{ at: AT, source: 'push_text', text: '你交代的那件事办好了：都写好了。' }],
    toolCalls: [],
    audit: [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0, args: { '--collection': WRITE_COLLECTION } },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0, args: { '--collection': WRITE_COLLECTION } },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0, args: { '--collection': 'alpha' } },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0, args: { '--collection': 'alpha' } },
    ],
    jobs: [],
    tasks: [{
      taskId: 't-1', taskNo: 1, status: 'completed',
      executions: [{ operation: 'dummy.prepare', status: 'completed' }, { operation: 'dummy.commit', status: 'completed' }],
    }, {
      taskId: 't-2', taskNo: 2, status: 'completed',
      executions: [{ operation: 'dummy.prepare', status: 'completed' }, { operation: 'dummy.commit', status: 'completed' }],
    }],
    statusSequence: ['queued', 'running', 'waiting_user', 'running', 'completed'],
    visible: [{ at: AT, source: 'turn', text: '两件都提交完了。', turnIndex: 3 }],
    deliveryEvents: [{ event: 'task_result_delivery_sent', taskId: 't-1' }],
    perCollection: [
      {
        collection: WRITE_COLLECTION, window: WRITE_WINDOW, expected: [{ name: 'pair-a', value: 7 }, { name: 'pair-b', value: 7 }],
        readbackBefore: { status: 'completed', count: 0, items: [] },
        readbackAfter: { status: 'completed', count: 2, items: [{ name: 'pair-a', value: 7 }, { name: 'pair-b', value: 7 }] },
        prepareSuccessCount: 1, commitSuccessCount: 1,
      },
      {
        collection: 'alpha', window: 'W1', expected: [{ name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 9 }],
        readbackBefore: { status: 'completed', count: 2, items: [{ name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 }] },
        readbackAfter: {
          status: 'completed', count: 5,
          items: [
            { name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 },
            { name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 9 },
          ],
        },
        prepareSuccessCount: 1, commitSuccessCount: 1,
      },
    ],
    commitCompletedFactsTotal: 2,
    confirmTurns: 2,
    completionDeliverySeen: true,
  };
}

describe('parseScenarioArgs', () => {
  it('缺省：全场景、默认超时', () => {
    expect(parseScenarioArgs([])).toEqual({
      scenarioIds: ['stop', 'failure', 'idempotency', 'reconfirm', 'two-objects'],
      turnTimeoutMs: 240_000,
      settleTimeoutMs: 240_000,
    });
  });

  it('解析 --scenario（重复/逗号）与超时旋钮', () => {
    expect(parseScenarioArgs(['--scenario', 'stop', '--scenario=failure,idempotency']))
      .toMatchObject({ scenarioIds: ['stop', 'failure', 'idempotency'] });
    expect(parseScenarioArgs(['--scenario=stop', '--turn-timeout-ms', '1000', '--settle-timeout-ms=2000']))
      .toMatchObject({ scenarioIds: ['stop'], turnTimeoutMs: 1000, settleTimeoutMs: 2000 });
    expect(parseScenarioArgs(['--scenario=stop', '--out-dir', '/tmp/x'])).toMatchObject({ outDir: '/tmp/x' });
  });

  it('拒绝未知场景/未知参数/畸形超时/缺值', () => {
    expect(parseScenarioArgs(['--scenario=nope'])).toHaveProperty('usageError');
    expect(parseScenarioArgs(['--scenario'])).toHaveProperty('usageError');
    expect(parseScenarioArgs(['--bogus'])).toHaveProperty('usageError');
    expect(parseScenarioArgs(['--turn-timeout-ms=abc'])).toHaveProperty('usageError');
    expect(parseScenarioArgs(['--turn-timeout-ms=0'])).toHaveProperty('usageError');
    expect(parseScenarioArgs(['--out-dir'])).toHaveProperty('usageError');
  });

  it('--help 走帮助分支', () => {
    expect(parseScenarioArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('机械读取与扫描', () => {
  it('readAuditFacts：保留 longTask/operationId/phase；坏行记 unparsable；缺文件空数组', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wloop2-audit-'));
    try {
      expect(readAuditFacts(dir)).toEqual([]);
      writeFileSync(path.join(dir, 'audit.jsonl'), [
        JSON.stringify({ mode: 'call', script: 'dummy.longtask', via: 'structured', exitCode: 0, longTask: 'accepted', operationId: 'op_1' }),
        'not-json',
        JSON.stringify({ mode: 'abort', script: 'dummy.longtask', exitCode: 0, longTask: 'cancelled', operationId: 'op_1' }),
        '',
      ].join('\n'));
      const rows = readAuditFacts(dir);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ script: 'dummy.longtask', longTask: 'accepted', operationId: 'op_1' });
      expect(rows[1]).toMatchObject({ mode: 'unparsable' });
      expect(rows[2]).toMatchObject({ mode: 'abort', longTask: 'cancelled' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readJobFacts：逐条投影 job 文件；坏文件记 unreadable', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wloop2-jobs-'));
    try {
      expect(readJobFacts(dir)).toEqual([]);
      const jobs = path.join(dir, 'jobs');
      mkdirSync(jobs, { recursive: true });
      writeFileSync(path.join(jobs, 'op_1.json'), JSON.stringify({ operationId: 'op_1', status: 'cancelled', seconds: 600 }));
      writeFileSync(path.join(jobs, 'bad.json'), 'not-json');
      const facts = readJobFacts(dir);
      expect(facts).toHaveLength(2);
      expect(facts.find((job) => job.operationId === 'op_1')).toMatchObject({ status: 'cancelled', seconds: 600 });
      expect(facts.find((job) => job.operationId === 'bad')).toMatchObject({ status: 'unreadable' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readConfirmationLedger：多句柄绑同一集合时逐条判定（不像只取首条那样漏已消耗）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wloop2-conf-'));
    try {
      expect(readConfirmationLedger(dir, 'empty-one')).toEqual({ handles: 0, usedCount: 0 });
      writeFileSync(path.join(dir, 'confirmations.json'), JSON.stringify({
        confirmations: {
          cf_a: { handle: 'cf_a', collection: 'empty-one', window: 'W1', count: 4, usedAt: '2026-11-19T11:00:00.000Z', usedBy: 'dummy.commit' },
          cf_b: { handle: 'cf_b', collection: 'empty-one', window: 'W1', count: 4, usedAt: null },
          cf_c: { handle: 'cf_c', collection: 'alpha', window: 'W1', count: 2, usedAt: null },
        },
      }));
      expect(readConfirmationLedger(dir, 'empty-one')).toEqual({ handles: 2, usedCount: 1, usedAt: '2026-11-19T11:00:00.000Z' });
      expect(readConfirmationLedger(dir, 'alpha')).toEqual({ handles: 1, usedCount: 0 });
      expect(readConfirmationLedger(dir, 'missing')).toEqual({ handles: 0, usedCount: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('argsMention/writeCallsOn：逐层扫字符串；读调用不计入写调用', () => {
    expect(argsMention({ '--collection': 'locked-one' }, 'locked-one')).toBe(true);
    expect(argsMention(['prepare', 'dummy.prepare', '--collection', 'locked-one'], 'locked-one')).toBe(true);
    expect(argsMention({ '--collection': 'other' }, 'locked-one')).toBe(false);
    const audit = [
      { mode: 'query', script: 'dummy.query', via: 'structured', exitCode: 0, args: { '--collection': 'locked-one' } },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0, args: { '--collection': 'empty-one' } },
    ];
    expect(writeCallsOn(audit, 'locked-one')).toHaveLength(1);
    expect(writeCallsOn(audit, 'empty-one')).toHaveLength(1);
  });

  it('successMarkersIn：命中宿主/执行层成功通道原文', () => {
    expect(successMarkersIn(['没办成。再试一次，还是先放着？'])).toEqual([]);
    expect(successMarkersIn(['「新增4条」办好了：4 条已新增。'])).toEqual(['办好了：']);
    expect(successMarkersIn(['Confirmed write applied: collection "empty-one"'])).toEqual(['Confirmed write applied']);
    for (const marker of SUCCESS_CHANNEL_MARKERS) {
      expect(successMarkersIn([`前缀 ${marker} 后缀`])).toContain(marker);
    }
  });
});

describe('stop：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例：六条判据全 pass', () => {
    const results = evaluateStopCriteria(greenStop());
    expect(results.map((result) => result.id)).toEqual(['S1-C1', 'S1-C2', 'S1-C3', 'S1-C4', 'S1-C5', 'S1-C6']);
    expect(onlyFailed(results)).toEqual([]);
  });

  it('S1-C1：没有 accepted 审计行 / 没有 job 文件 → 红', () => {
    const noAccept = greenStop();
    noAccept.audit = noAccept.audit.filter((row) => row.longTask !== 'accepted');
    expect(statusOf(evaluateStopCriteria(noAccept), 'S1-C1')).toBe('fail');
    const noJob = greenStop();
    noJob.jobs = [];
    expect(statusOf(evaluateStopCriteria(noJob), 'S1-C1')).toBe('fail');
  });

  it('S1-C2：没有 task_cancel / 任务没停 / 有非终局残留 → 红', () => {
    const noCall = greenStop();
    delete noCall.cancelToolCall;
    expect(statusOf(evaluateStopCriteria(noCall), 'S1-C2')).toBe('fail');
    const notStopped = greenStop();
    notStopped.tasks = [{ taskId: 't-1', taskNo: 1, status: 'running', executions: [] }];
    expect(statusOf(evaluateStopCriteria(notStopped), 'S1-C2')).toBe('fail');
    const leftover = greenStop();
    leftover.tasks = [...leftover.tasks, { taskId: 't-2', taskNo: 2, status: 'running', executions: [] }];
    expect(statusOf(evaluateStopCriteria(leftover), 'S1-C2')).toBe('fail');
  });

  it('S1-C3：job 文件还在 running（只有嘴上的停）→ 红', () => {
    const evidence = greenStop();
    evidence.jobs = [{ operationId: 'op_1', status: 'running', seconds: 600 }];
    expect(statusOf(evaluateStopCriteria(evidence), 'S1-C3')).toBe('fail');
  });

  it('S1-C4：停后审计行仍在增加 → 红', () => {
    const evidence = greenStop();
    evidence.auditAfterFreeze = evidence.auditAtCancel + 1;
    expect(statusOf(evaluateStopCriteria(evidence), 'S1-C4')).toBe('fail');
  });

  it('S1-C5：用户没收到任何话 / 出现成功通道原文 → 红', () => {
    const silent = greenStop();
    silent.visible = silent.visible.map((entry) => ({ ...entry, text: '' }));
    expect(statusOf(evaluateStopCriteria(silent), 'S1-C5')).toBe('fail');
    const fakeDone = greenStop();
    fakeDone.visible = [...fakeDone.visible, { at: AT, source: 'push', text: '你交代的那件事办好了：已停。' }];
    expect(statusOf(evaluateStopCriteria(fakeDone), 'S1-C5')).toBe('fail');
  });

  it('S1-C6：健康路径（模型说话，无宿主模板）与降级路径（宿主模板）都绿 —— 来源不限', () => {
    // 健康路径：唤醒设计下用户可见文本 = 模型的话，宿主「已按你说的停了：」模板不出现。
    const healthy = greenStop();
    healthy.visible = [
      { at: AT, source: 'turn', text: '受理了，在跑了。', turnIndex: 1 },
      { at: AT, source: 'push', text: '「慢活」已经停了。' }, // 模型/唤醒投递的话，无宿主模板
    ];
    healthy.pushes = [];
    expect(statusOf(evaluateStopCriteria(healthy), 'S1-C6')).toBe('pass');
    expect(healthy.visible.some((entry) => entry.text.includes(CANCELLATION_FACT_MARKER))).toBe(false);
    // 降级路径：唤醒说不出话，宿主模板兜底 —— 也绿。
    const degraded = greenStop();
    expect(statusOf(evaluateStopCriteria(degraded), 'S1-C6')).toBe('pass');
    expect(degraded.visible.some((entry) => entry.text.includes(CANCELLATION_FACT_MARKER))).toBe(true);
  });

  it('S1-C6：用户可见面无非空停止告知 / 底账未 cancelled / 停后审计未冻结 → 红', () => {
    const silent = greenStop();
    silent.visible = silent.visible.map((entry) => ({ ...entry, text: '' }));
    silent.pushes = [];
    expect(statusOf(evaluateStopCriteria(silent), 'S1-C6')).toBe('fail');
    const notCancelled = greenStop();
    notCancelled.tasks = [{ taskId: 't-1', taskNo: 1, status: 'running', executions: [] }];
    expect(statusOf(evaluateStopCriteria(notCancelled), 'S1-C6')).toBe('fail');
    const notFrozen = greenStop();
    notFrozen.auditAfterFreeze = notFrozen.auditAtCancel + 1;
    expect(statusOf(evaluateStopCriteria(notFrozen), 'S1-C6')).toBe('fail');
  });
});

describe('failure：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例：五条判据全 pass', () => {
    const results = evaluateFailureCriteria(greenFailure());
    expect(results.map((result) => result.id)).toEqual(['S2-C1', 'S2-C2', 'S2-C3', 'S2-C4', 'S2-C5']);
    expect(onlyFailed(results)).toEqual([]);
  });

  it('S2-C1：没有失败写调用 / 底账没有失败事实 → 红', () => {
    const noFailedCall = greenFailure();
    noFailedCall.writeCallsOnTarget = [{ mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0 }];
    expect(statusOf(evaluateFailureCriteria(noFailedCall), 'S2-C1')).toBe('fail');
    const noFacts = greenFailure();
    noFacts.tasks = [{ taskId: 't-1', taskNo: 1, status: 'completed', executions: [{ operation: 'dummy.prepare', status: 'completed' }] }];
    expect(statusOf(evaluateFailureCriteria(noFacts), 'S2-C1')).toBe('fail');
  });

  it('S2-C2：确定性失败后仍连撞（超出可重试预算 / 最后一次不是失败 / 零次）→ 红', () => {
    const twice = greenFailure();
    twice.writeCallsOnTarget = [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2 },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } },
    ];
    twice.attemptsOnTarget = 2;
    expect(statusOf(evaluateFailureCriteria(twice), 'S2-C2')).toBe('fail'); // 2 次失败但 0 次显式可重试放行
    const zero = greenFailure();
    zero.writeCallsOnTarget = [];
    expect(statusOf(evaluateFailureCriteria(zero), 'S2-C2')).toBe('fail');
    const successTail = greenFailure();
    successTail.writeCallsOnTarget = [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0, args: { '--collection': 'locked-one' } },
    ];
    expect(statusOf(evaluateFailureCriteria(successTail), 'S2-C2')).toBe('fail');
  });

  it('S2-C2：形状错误（显式可重试）重试 + 业务失败收尾（无需本地拦截也绿；A2b 预算语义）', () => {
    const shapeRetry = greenFailure();
    shapeRetry.writeCallsOnTarget = [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 1, args: { '--collection': 'locked-one', '--records': 'json-string' } },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } },
    ];
    shapeRetry.retryAllowed = 1;
    shapeRetry.attemptsOnTarget = 2;
    expect(statusOf(evaluateFailureCriteria(shapeRetry), 'S2-C2')).toBe('pass');
    // 两次形状错误（两次显式放行）+ 业务失败收尾 → 也在预算内（实测形状）
    const twoShapeRetries = greenFailure();
    twoShapeRetries.writeCallsOnTarget = [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 1, args: { '--collection': 'locked-one' } },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 1, args: { '--collection': 'locked-one' } },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } },
    ];
    twoShapeRetries.retryAllowed = 2;
    twoShapeRetries.attemptsOnTarget = 5;
    expect(statusOf(evaluateFailureCriteria(twoShapeRetries), 'S2-C2')).toBe('pass');
    // 再多一次到达执行层的失败（超出预算）→ 红
    const hammered = greenFailure();
    hammered.writeCallsOnTarget = [...twoShapeRetries.writeCallsOnTarget, { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 2, args: { '--collection': 'locked-one' } }];
    hammered.retryAllowed = 2;
    hammered.attemptsOnTarget = 6;
    expect(statusOf(evaluateFailureCriteria(hammered), 'S2-C2')).toBe('fail');
  });

  it('S2-C3：健康路径（模型说话，无宿主模板）与降级路径（宿主模板）都绿 —— 来源不限', () => {
    // 健康路径：唤醒设计下用户可见文本 = 模型/唤醒投递的话，宿主失败模板不出现。
    const healthy = greenFailure();
    const template = failureTextFor('COLLECTION_LOCKED', 'failed');
    healthy.visible = [{ at: AT, source: 'turn', text: '这件事没办成，我再看下。', turnIndex: 1 }];
    healthy.pushTexts = [];
    healthy.failureRelayedInTurn = false;
    expect(statusOf(evaluateFailureCriteria(healthy), 'S2-C3')).toBe('pass');
    expect(healthy.visible.some((entry) => entry.text.includes(template))).toBe(false);
    // 降级路径：唤醒说不出话，宿主失败话术模板兜底 —— 也绿。
    const degraded = greenFailure();
    expect(statusOf(evaluateFailureCriteria(degraded), 'S2-C3')).toBe('pass');
    expect(degraded.visible.some((entry) => entry.text.includes(template))).toBe(true);
  });

  it('S2-C3：无非空失败告知 / 有写入落地 / 有成功通道原文 → 红', () => {
    const noDelivery = greenFailure();
    noDelivery.visible = [{ at: AT, source: 'turn', text: '   ', turnIndex: 1 }];
    noDelivery.pushTexts = [];
    noDelivery.failureRelayedInTurn = false;
    expect(statusOf(evaluateFailureCriteria(noDelivery), 'S2-C3')).toBe('fail');
    // 零写入被破坏：读回数量变了。
    const landed = greenFailure();
    landed.readbackAfter = { status: 'completed', count: 2, items: [{ name: 'x', value: 1 }] };
    expect(statusOf(evaluateFailureCriteria(landed), 'S2-C3')).toBe('fail');
    // 成功通道原文被破坏：出现「办好了」这类假成功。
    const fake = greenFailure();
    fake.visible = [...fake.visible, { at: AT, source: 'push', text: '办好了：2 条已写入。' }];
    expect(statusOf(evaluateFailureCriteria(fake), 'S2-C3')).toBe('fail');
  });

  it('S2-C4：用户可见面出现「办好了」这类成功通道原文 → 红', () => {
    const fakeSuccess = greenFailure();
    fakeSuccess.visible = [...fakeSuccess.visible, { at: AT, source: 'push', text: '「写 locked-one」办好了：2 条已新增。' }];
    expect(statusOf(evaluateFailureCriteria(fakeSuccess), 'S2-C4')).toBe('fail');
  });

  it('S2-C5：锁定集合读回变了（写落地了）→ 红', () => {
    const landed = greenFailure();
    landed.readbackAfter = { status: 'completed', count: 3, items: [{ name: 'locked-item-1', value: 900 }, { name: 'lock-a', value: 10 }] };
    expect(statusOf(evaluateFailureCriteria(landed), 'S2-C5')).toBe('fail');
  });
});

describe('idempotency：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例：四条判据全 pass', () => {
    const results = evaluateIdempotencyCriteria(greenIdempotency());
    expect(results.map((result) => result.id)).toEqual(['S3-C1', 'S3-C2', 'S3-C3', 'S3-C4']);
    expect(onlyFailed(results)).toEqual([]);
  });

  it('S3-C1：新起了第二份工作 / 第二次委派 → 红', () => {
    const doubled = greenIdempotency();
    doubled.tasks = [...doubled.tasks, { taskId: 't-2', taskNo: 2, status: 'running', executions: [] }];
    expect(statusOf(evaluateIdempotencyCriteria(doubled), 'S3-C1')).toBe('fail');
    const twoRuns = greenIdempotency();
    twoRuns.taskRunCalls = 2;
    expect(statusOf(evaluateIdempotencyCriteria(twoRuns), 'S3-C1')).toBe('fail');
    const noPrepare = greenIdempotency();
    noPrepare.prepareSuccessCount = 0;
    expect(statusOf(evaluateIdempotencyCriteria(noPrepare), 'S3-C1')).toBe('fail');
  });

  it('S3-C2：第二次是新回执且没有幂等事件 → 红', () => {
    const newReply = greenIdempotency();
    newReply.duplicate = { ...newReply.duplicate, secondReply: '好的，我又新起了一份。', sameText: false, events: [] };
    expect(statusOf(evaluateIdempotencyCriteria(newReply), 'S3-C2')).toBe('fail');
    const stillOk = greenIdempotency();
    stillOk.duplicate = { ...stillOk.duplicate, secondReply: STILL_PROCESSING_NOTE, sameText: false, events: ['message_still_processing'] };
    expect(statusOf(evaluateIdempotencyCriteria(stillOk), 'S3-C2')).toBe('pass');
  });

  it('S3-C3：写入两次 / 读回 8 条 / 句柄未消耗 → 红', () => {
    const twice = greenIdempotency();
    twice.commitSuccessCount = 2;
    twice.readbackAfter = {
      status: 'completed', count: 8,
      items: [...EXPECTED_RECORDS, ...EXPECTED_RECORDS].map((record, index) => ({ id: `rec-${index}`, name: record.name, value: record.value })),
    };
    expect(statusOf(evaluateIdempotencyCriteria(twice), 'S3-C3')).toBe('fail');
    const unused = greenIdempotency();
    unused.confirmations = { handles: 1, usedCount: 0 };
    expect(statusOf(evaluateIdempotencyCriteria(unused), 'S3-C3')).toBe('fail');
    const usedTwice = greenIdempotency();
    usedTwice.confirmations = { handles: 1, usedCount: 2, usedAt: AT };
    expect(statusOf(evaluateIdempotencyCriteria(usedTwice), 'S3-C3')).toBe('fail');
  });

  it('S3-C4：第二次回执为空 → 红', () => {
    const empty = greenIdempotency();
    empty.duplicate = { ...empty.duplicate, secondReply: ' ', sameText: false };
    expect(statusOf(evaluateIdempotencyCriteria(empty), 'S3-C4')).toBe('fail');
  });
});

describe('reconfirm：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例：五条判据全 pass（含目标态 S4-P0）', () => {
    const results = evaluateReconfirmCriteria(greenReconfirm());
    expect(results.map((result) => result.id)).toEqual(['S4-P0', 'S4-C1', 'S4-C2', 'S4-C3', 'S4-C4']);
    expect(onlyFailed(results)).toEqual([]);
  });

  it('S4-P0：第一次写入没落地（句柄未消耗）→ 目标态未达红', () => {
    const notLanded = greenReconfirm();
    notLanded.firstWriteLanded = false;
    notLanded.confirmationsAfterFirstWrite = { handles: 1, usedCount: 0 };
    expect(statusOf(evaluateReconfirmCriteria(notLanded), 'S4-P0')).toBe('fail');
  });

  it('S4-C1：第二次写入发生 / 读回 8 条 / 句柄被再次消耗 → 红', () => {
    const twice = greenReconfirm();
    twice.commitSuccessCount = 2;
    twice.commitCompletedFacts = 2;
    twice.readbackAfter = {
      status: 'completed', count: 8,
      items: [...EXPECTED_RECORDS, ...EXPECTED_RECORDS].map((record, index) => ({ id: `rec-${index}`, name: record.name, value: record.value })),
    };
    expect(statusOf(evaluateReconfirmCriteria(twice), 'S4-C1')).toBe('fail');
    const reused = greenReconfirm();
    reused.confirmations = { ...reused.confirmations, usedAt: '2026-11-19T11:00:00.000Z' };
    expect(statusOf(evaluateReconfirmCriteria(reused), 'S4-C1')).toBe('fail');
    const reusedTwice = greenReconfirm();
    reusedTwice.confirmations = { handles: 2, usedCount: 2, usedAt: AT };
    expect(statusOf(evaluateReconfirmCriteria(reusedTwice), 'S4-C1')).toBe('fail');
  });

  it('S4-C2：新任务 / 未终局 / 接续 started → 红', () => {
    const newTask = greenReconfirm();
    newTask.taskCountAfterReconfirm = 2;
    newTask.tasks = [...newTask.tasks, { taskId: 't-2', taskNo: 2, status: 'completed', executions: [] }];
    expect(statusOf(evaluateReconfirmCriteria(newTask), 'S4-C2')).toBe('fail');
    const leftover = greenReconfirm();
    leftover.tasks = [...leftover.tasks, { taskId: 't-2', taskNo: 2, status: 'running', executions: [] }];
    expect(statusOf(evaluateReconfirmCriteria(leftover), 'S4-C2')).toBe('fail');
    const resumed = greenReconfirm();
    resumed.taskConfirmStartedCalls = [{
      seq: 9, agent: 'main', turn: 3, tool: 'task_confirm', args: '{}', ok: true, summary: 'started', elapsedMs: 50,
    }];
    expect(statusOf(evaluateReconfirmCriteria(resumed), 'S4-C2')).toBe('fail');
  });

  it('S4-C3：用户没有收到任何话 → 红', () => {
    const silent = greenReconfirm();
    silent.textsAfterThirdTurn = [];
    expect(statusOf(evaluateReconfirmCriteria(silent), 'S4-C3')).toBe('fail');
  });

  it('S4-C4：第三次之后出现成功通道原文 / 执行层又有调用 → 红', () => {
    const fakeSuccess = greenReconfirm();
    fakeSuccess.textsAfterThirdTurn = [...fakeSuccess.textsAfterThirdTurn, { at: '2026-11-19T10:00:02.000Z', source: 'turn', text: '「新增4条」办好了：4 条已新增。', turnIndex: 3 }];
    expect(statusOf(evaluateReconfirmCriteria(fakeSuccess), 'S4-C4')).toBe('fail');
    const extraCall = greenReconfirm();
    extraCall.auditCountAfterReconfirm = extraCall.auditCountAfterFirstWrite + 1;
    expect(statusOf(evaluateReconfirmCriteria(extraCall), 'S4-C4')).toBe('fail');
  });
});

describe('two-objects：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例：四条判据全 pass', () => {
    const results = evaluateTwoObjectsCriteria(greenTwoObjects());
    expect(results.map((result) => result.id)).toEqual(['S5-C1', 'S5-C2', 'S5-C3', 'S5-C4']);
    expect(onlyFailed(results)).toEqual([]);
  });

  it('S5-C1：某对象没提交 / 提交两次 / 总数与底账不符 → 红', () => {
    const missing = greenTwoObjects();
    missing.perCollection[1]!.commitSuccessCount = 0;
    missing.commitCompletedFactsTotal = 1;
    expect(statusOf(evaluateTwoObjectsCriteria(missing), 'S5-C1')).toBe('fail');
    const doubled = greenTwoObjects();
    doubled.perCollection[0]!.commitSuccessCount = 2;
    expect(statusOf(evaluateTwoObjectsCriteria(doubled), 'S5-C1')).toBe('fail');
    const ledgerMismatch = greenTwoObjects();
    ledgerMismatch.commitCompletedFactsTotal = 3;
    expect(statusOf(evaluateTwoObjectsCriteria(ledgerMismatch), 'S5-C1')).toBe('fail');
  });

  it('S5-C2：读回串线（增量/尾部名字/值不对）→ 红', () => {
    const crossed = greenTwoObjects();
    crossed.perCollection[0]!.readbackAfter = {
      status: 'completed', count: 3,
      items: [{ name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 9 }],
    };
    expect(statusOf(evaluateTwoObjectsCriteria(crossed), 'S5-C2')).toBe('fail');
    const wrongValue = greenTwoObjects();
    wrongValue.perCollection[1]!.readbackAfter = {
      status: 'completed', count: 5,
      items: [
        { name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 },
        { name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 8 },
      ],
    };
    expect(statusOf(evaluateTwoObjectsCriteria(wrongValue), 'S5-C2')).toBe('fail');
    const wrongDelta = greenTwoObjects();
    wrongDelta.perCollection[1]!.readbackAfter = {
      status: 'completed', count: 3,
      items: [
        { name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 },
        { name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 9 },
      ],
    };
    expect(statusOf(evaluateTwoObjectsCriteria(wrongDelta), 'S5-C2')).toBe('fail');
  });

  it('S5-C3：有一件事失败了 → 红', () => {
    const failed = greenTwoObjects();
    failed.tasks = [failed.tasks[0]!, { taskId: 't-2', taskNo: 2, status: 'failed', executions: [{ operation: 'dummy.commit', status: 'failed', code: 'X' }] }];
    expect(statusOf(evaluateTwoObjectsCriteria(failed), 'S5-C3')).toBe('fail');
  });

  it('S5-C4：没有完成交付路径 → 红', () => {
    const noDelivery = greenTwoObjects();
    noDelivery.completionDeliverySeen = false;
    expect(statusOf(evaluateTwoObjectsCriteria(noDelivery), 'S5-C4')).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// 子进程：前置门（不跑模型）
// ---------------------------------------------------------------------------

function runScript(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // 显式清空 LLM_*：前置门必须如实拒绝，不许落回任何脚本模型。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
  };
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('子进程前置门', () => {
  it('--help：exit 0 并打印用法与五个场景名', () => {
    const run = runScript(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stop');
    expect(run.stdout).toContain('two-objects');
    expect(run.stdout).toContain('退出码');
  });

  it('缺模型配置：exit 2、点名缺什么，且不写任何证据（不退回脚本模型）', () => {
    const run = runScript(['--scenario=stop']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('缺少真实模型配置');
    expect(run.stderr).toContain('LLM_API_KEY');
  });

  it('前置门拒绝不留自动运行目录（空目录即噪音；有证据的一律保留）', () => {
    const autoRoot = path.join(REPO_ROOT, '.runtime', 'real-write-loop-scenarios');
    const before = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    const run = runScript(['--scenario=stop']);
    expect(run.status).toBe(2);
    const after = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    expect(after).toEqual(before);
  });
});
