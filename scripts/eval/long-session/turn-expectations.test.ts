/**
 * 轮期望判定 · 确定性自证（假会话，零模型）。
 *
 * 覆盖两层：
 *   1. 纯函数 `judgeTurnExpectations`：每类检查的通过/判负形态（含「会话面未暴露」→ E-INCONCLUSIVE）；
 *   2. `runHarnessSession` 端到端（LS6 全计划 + 假会话）：
 *      · 正向路径必须**判正**（22 条检查全过、事实全对）；
 *      · 4 条**反向绊线**必须各自**判负**：
 *        (a) N1 串台（A 的结论返回 documents 数字）、(b) N4 复用旧任务（没有新 taskId）、
 *        (c) N5 沿用 3 条、(d) N6 假取消（轮前在飞却落成 completed，且**未**触发既有 H5，
 *            证明这条判据确实是新增机械判据而不是 H5 的别名）；
 *      · `gapMs` 走注入的 sleep 真等待（生产缺省 = 真 setTimeout）。
 */
import { describe, it, expect } from 'vitest';
import { runHarnessSession, judgeTurnExpectations, replyExcludedHits, claimsCancel, type ExecutionFact, type HarnessSession } from './harness';
import { buildTrackPlan, type TurnSpec } from './load-generator';
import { FakeHarnessSession, asAttempt, type FakeScenario } from './fake-session';
import type { TaskView } from './oracle';

const LS6 = buildTrackPlan('LS6');

const T = (taskId: string, taskNo: number, request: string, kind: 'done' | 'running' | 'cancelled' | 'failed'): TaskView => ({
  taskId, taskNo, request, requestIds: [`req-${taskId}`],
  started: true,
  ended: kind !== 'running',
  reported: kind === 'done',
  waiting: false,
  mayBeRunning: kind === 'running',
  ...(kind === 'done' ? { lastExecutionStatus: 'completed' } : kind === 'failed' ? { lastExecutionStatus: 'failed' } : {}),
});

const A_DONE = T('task-A', 1, '查 alpha W1', 'done');
const B_DONE = T('task-B', 2, '查 documents W202611', 'done');
const C_DONE = T('task-C', 3, '查 beta W1', 'done');
const D_DONE = T('task-D', 4, '重做 beta W1', 'done');
const E_DONE = T('task-E', 5, '查 bulk-a W1', 'done');
const E_CANCELLED = T('task-E', 5, '查 bulk-a W1', 'cancelled');

const RUNNING_A = T('task-A', 1, '查 alpha W1', 'running');
const RUNNING_B = T('task-B', 2, '查 documents W202611', 'running');
const RUNNING_E = T('task-E', 5, '查 bulk-a W1', 'running');

interface Ls6Overrides {
  readonly replies?: Partial<Record<number, string>>;
  readonly tasks?: Partial<Record<number, readonly TaskView[]>>;
  readonly cancel?: Partial<Record<number, boolean>>;
}

/**
 * LS6 正向脚本（13 轮 = N1-A..N6-C）。
 * 任务账本按轮推进；`executions` 只在 N2-A 出现（改口径落到 beta 执行行）。
 */
function ls6Script(overrides: Ls6Overrides = {}): FakeScenario {
  const betaExecution: readonly ExecutionFact[] = [{ operation: 'dummy.query', objects: ['--collection', 'beta'] }];
  const base: ReadonlyArray<{
    reply: string; tasks: readonly TaskView[]; cancelCalled?: boolean; executions?: readonly ExecutionFact[];
    cancelFacts?: readonly { taskId: string | null; outcome: string | null; status: string | null }[];
  }> = [
    { reply: '好，已经开了任务在跑 alpha 集合 W1。', tasks: [RUNNING_A] },
    { reply: '好，另开了一个任务查 documents W202611。', tasks: [RUNNING_A, RUNNING_B] },
    { reply: 'alpha 集合 W1 共 2 条，总金额 2000 元。', tasks: [A_DONE, B_DONE] },
    { reply: '改成 beta 了：beta 集合 W1 共 3 条，总金额 1000 元。', tasks: [A_DONE, B_DONE, C_DONE], executions: betaExecution },
    { reply: '还是按 beta：共 3 条，总额 1000 元。', tasks: [A_DONE, B_DONE, C_DONE] },
    { reply: '好，先停着，等你回来。', tasks: [A_DONE, B_DONE, C_DONE] },
    { reply: '继续：之前的任务都还在原来的状态。', tasks: [A_DONE, B_DONE, C_DONE] },
    { reply: '好，重做一遍，已经开了新任务。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE] },
    { reply: '收到，alpha 之前查的是 2 条，我按 2 条记着。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE] },
    { reply: '更正后按 2 条：alpha 共 2 条，总金额 2000 元。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE] },
    { reply: '好，开了任务查 bulk-a W1 的明细。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE, RUNNING_E] },
    {
      reply: '已取消。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE, E_CANCELLED], cancelCalled: true,
      cancelFacts: [{ taskId: E_CANCELLED.taskId, outcome: 'requested', status: null }],
    },
    { reply: '同样没能取消成功：那个 alpha 任务早就办完了，没法再取消。', tasks: [A_DONE, B_DONE, C_DONE, D_DONE, E_CANCELLED] },
  ];
  return {
    summaryCalls: 3,
    turns: base.map((turn, i) => {
      const n = i + 1;
      return {
        reply: overrides.replies?.[n] ?? turn.reply,
        tasks: overrides.tasks?.[n] ?? turn.tasks,
        ...(turn.executions ? { executions: turn.executions } : {}),
        ...(turn.cancelFacts ? { cancelFacts: turn.cancelFacts } : {}),
        ...(overrides.cancel?.[n] ?? turn.cancelCalled ? { cancelCalled: overrides.cancel?.[n] ?? turn.cancelCalled } : {}),
        tokens: 1000 * n,
        messages: n * 2,
        modelCalls: 1,
        ...(n >= 10 && n <= 12 ? { newAttempts: [asAttempt(n, 'threshold', 39000, 20000)] } : {}),
      };
    }),
  };
}

async function runLs6(scenario: FakeScenario, plan = LS6, sleeps: number[] = []) {
  const session = new FakeHarnessSession(scenario);
  return runHarnessSession({
    session, plan, wave: 'Wave1', track: 'LS6', sessionId: 'ls6-fake', principalId: 'principal-A',
    model: 'step-3.7-flash', contextWindow: 40000, limits: { maxModelCalls: 150 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
}

function ctx(partial: Partial<Parameters<typeof judgeTurnExpectations>[1]>) {
  return {
    tasksBefore: [], tasksAfter: [], executions: [], reply: '',
    ...partial,
  };
}

function spec(partial: Partial<TurnSpec>): TurnSpec {
  return { index: 1, text: 'x', kind: 'interaction', ...partial };
}

describe('轮期望纯函数判定', () => {
  it('无期望字段 → 无判负、零检查', () => {
    expect(judgeTurnExpectations(spec({}), ctx({}))).toEqual([]);
  });

  it('expectNoNewTask / expectNewTask 用账本行数与 taskId 差判', () => {
    const noNew = judgeTurnExpectations(spec({ expectNoNewTask: true }), ctx({ tasksBefore: [A_DONE], tasksAfter: [A_DONE, B_DONE] }));
    expect(noNew.map((f) => [f.check, f.code])).toEqual([['no_new_task', 'E-D']]);

    const missingNew = judgeTurnExpectations(spec({ expectNewTask: true }), ctx({ tasksBefore: [A_DONE], tasksAfter: [A_DONE] }));
    expect(missingNew.map((f) => [f.check, f.code])).toEqual([['new_task', 'E-D']]);
  });

  it('expectNoExecution：会话面未暴露 → E-INCONCLUSIVE；有执行 → E-D', () => {
    const unobserved = judgeTurnExpectations(spec({ expectNoExecution: true }), ctx({ executions: null }));
    expect(unobserved.map((f) => f.code)).toEqual(['E-INCONCLUSIVE']);

    const executed = judgeTurnExpectations(spec({ expectNoExecution: true }), ctx({
      executions: [{ operation: 'dummy.query', objects: ['beta'] }],
    }));
    expect(executed.map((f) => [f.check, f.code])).toEqual([['no_execution', 'E-D']]);
  });

  it('expectExecutionObjects：对象不在审计行 → E-D；命中 → 通过', () => {
    const execs: readonly ExecutionFact[] = [{ operation: 'dummy.query', objects: ['--collection', 'alpha'] }];
    expect(judgeTurnExpectations(spec({ expectExecutionObjects: ['beta'] }), ctx({ executions: execs })).map((f) => [f.check, f.code]))
      .toEqual([['execution_objects', 'E-D']]);
    expect(judgeTurnExpectations(spec({ expectExecutionObjects: ['alpha'] }), ctx({ executions: execs }))).toEqual([]);
  });

  it('expectPrevTasksUnchanged：状态/执行清单被改写 → E-G', () => {
    const rewritten = judgeTurnExpectations(spec({ expectPrevTasksUnchanged: true }), ctx({
      tasksBefore: [A_DONE], tasksAfter: [T('task-A', 1, '查 alpha W1', 'cancelled')],
    }));
    expect(rewritten.map((f) => [f.check, f.code])).toEqual([['prev_tasks_unchanged', 'E-G']]);
    expect(judgeTurnExpectations(spec({ expectPrevTasksUnchanged: true }), ctx({ tasksBefore: [A_DONE], tasksAfter: [A_DONE, D_DONE] }))).toEqual([]);
  });

  it('expectTaskFactIn：oldest/latest 选取与事实不符 → E-G', () => {
    expect(judgeTurnExpectations(spec({ expectTaskFactIn: { which: 'oldest', facts: ['reported'] } }), ctx({
      tasksAfter: [A_DONE, RUNNING_E],
    }))).toEqual([]);
    expect(judgeTurnExpectations(spec({ expectTaskFactIn: { which: 'latest', facts: ['reported'] } }), ctx({
      tasksAfter: [A_DONE, RUNNING_E],
    })).map((f) => [f.check, f.code])).toEqual([['task_fact_in', 'E-G']]);
  });

  it('replyExcludes：纯数字按数值判（2000 不误伤 20000），文本按去空白子串判', () => {
    expect(replyExcludedHits('beta 共 3 条，总额 1000 元。', ['2000'])).toEqual([]);
    expect(replyExcludedHits('总额 20000 元', ['2000'])).toEqual([]);
    expect(replyExcludedHits('alpha 共 2000 元', ['2000'])).toEqual(['2000']);
    expect(replyExcludedHits('alpha 是三条', ['三条'])).toEqual(['三条']);
    expect(replyExcludedHits('alpha 共 3 条', ['3条'])).toEqual(['3条']);
  });

  it('expectInflightCancel：在飞取消通过；无窗口 E-INCONCLUSIVE；指错任务/未生效 E-D；如实迟到通过', () => {
    expect(judgeTurnExpectations(spec({ expectInflightCancel: true }), ctx({ tasksBefore: [RUNNING_E], tasksAfter: [E_CANCELLED] }))).toEqual([]);
    const noWindow = judgeTurnExpectations(spec({ expectInflightCancel: true }), ctx({ tasksBefore: [E_DONE], tasksAfter: [E_DONE] }));
    expect(noWindow.map((f) => [f.check, f.code])).toEqual([['inflight_cancel', 'E-INCONCLUSIVE']]);
    // 取消指错任务（目标不是轮前最新任务）→ E-D。
    const wrongTarget = judgeTurnExpectations(spec({ expectInflightCancel: true }), ctx({
      tasksBefore: [RUNNING_E], tasksAfter: [E_DONE],
      cancelFacts: [{ taskId: 'task-A', outcome: 'terminal', status: 'completed' }],
    }));
    expect(wrongTarget.map((f) => [f.check, f.code])).toEqual([['inflight_cancel', 'E-D']]);
    expect(wrongTarget[0]?.evidence).toMatchObject({ reason: 'cancel_target_mismatch' });
    // 取消确实到达同一任务、但到达时已完成，且回复如实（未声称取消）→ 通过。
    expect(judgeTurnExpectations(spec({ expectInflightCancel: true }), ctx({
      tasksBefore: [RUNNING_E], tasksAfter: [E_DONE], reply: '它在我取消前就办完了，取消不了。',
      cancelFacts: [{ taskId: E_DONE.taskId, outcome: 'terminal', status: 'completed' }],
    }))).toEqual([]);
    // 同一迟到场景但回复声称「已取消」→ 不实，E-D。
    const dishonest = judgeTurnExpectations(spec({ expectInflightCancel: true }), ctx({
      tasksBefore: [RUNNING_E], tasksAfter: [E_DONE], reply: '已取消。',
      cancelFacts: [{ taskId: E_DONE.taskId, outcome: 'terminal', status: 'completed' }],
    }));
    expect(dishonest.map((f) => [f.check, f.code])).toEqual([['inflight_cancel', 'E-D']]);
  });

  it('expectCancelHonest：cancelled 通过；completed+声称取消 → E-D；completed+如实 → 通过；running → E-D', () => {
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [E_CANCELLED], reply: '已取消。' }))).toEqual([]);
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [E_DONE], reply: '已完成，无法取消。' }))).toEqual([]);
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [E_DONE], reply: '已取消。' })).map((f) => [f.check, f.code]))
      .toEqual([['cancel_honest', 'E-D']]);
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [RUNNING_E], reply: '好。' })).map((f) => f.code))
      .toEqual(['E-D']);
  });

  it('expectCancelHonest 的 cancelTarget：N6-C 查最早任务，不被最新任务（已 cancelled）空过', () => {
    const reply = '那个 alpha 查询早就结束了，系统返回已完成，所以没有可取消的进程——不是取消成功，而是它本来就已经收尾了。';
    expect(claimsCancel(reply)).toBe(false);
    // 默认 latest：最新是 E_CANCELLED → 会空过；显式 oldest 才检查到 alpha。
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [A_DONE, E_CANCELLED], reply }))).toEqual([]);
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true, cancelTarget: 'oldest' }), ctx({ tasksAfter: [A_DONE, E_CANCELLED], reply }))).toEqual([]);
    const falseClaim = judgeTurnExpectations(spec({ expectCancelHonest: true, cancelTarget: 'oldest' }), ctx({
      tasksAfter: [A_DONE, E_CANCELLED], reply: '已取消。',
    }));
    expect(falseClaim.map((f) => [f.check, f.code])).toEqual([['cancel_honest', 'E-D']]);
    expect(falseClaim[0]?.evidence).toMatchObject({ taskId: 'task-A', which: 'oldest', reported: true, claimsCancelled: true });
    // 真模型回执：同一个回复里既说「最早 alpha 取消不了」，又说另一个任务「已取消」——
    // 明确说取消不了的信号优先，不能被另一任务的合法「已取消」带成假红。
    const mixed = '最早那个 alpha 任务取消不了，因为它早就办完了。bulk-a 那个任务：已确认取消，状态是「已取消」。';
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true, cancelTarget: 'oldest' }), ctx({
      tasksAfter: [A_DONE, E_CANCELLED], reply: mixed,
    }))).toEqual([]);
  });

  it('取消声称识别否定式：如实说的「没能取消成功 / 不是取消成功 / 无法取消」不算声称（真模型冒烟暴露的假红）', () => {
    expect(claimsCancel('同样没能取消成功：那个任务早就办完了。')).toBe(false);
    expect(claimsCancel('没有办法取消，它已经完成了。')).toBe(false);
    expect(claimsCancel('这个任务无法取消。')).toBe(false);
    expect(claimsCancel('不是取消成功，而是它本来就已经收尾了。')).toBe(false);
    expect(claimsCancel('并非取消成功，任务已办完。')).toBe(false);
    expect(claimsCancel('已取消。')).toBe(true);
    expect(claimsCancel('取消成功了，不用再等。')).toBe(true);
    // 完整判据：状态仍 completed + 如实拒绝 → 通过；状态仍 completed + 声称取消 → E-D。
    expect(judgeTurnExpectations(spec({ expectCancelHonest: true }), ctx({ tasksAfter: [E_DONE], reply: '同样没能取消成功：那个任务早就办完了。' }))).toEqual([]);
  });
});

describe('LS6 端到端（假会话）', () => {
  it('缺少 sendNoWait 的会话面：计划含 deferIdle 时确定性拒绝，不静默假装交错', async () => {
    const base = new FakeHarnessSession(ls6Script());
    const session: HarnessSession = {
      send: (text: string) => base.send(text),
      tasks: () => base.tasks(),
      transcriptTokens: () => base.transcriptTokens(),
      transcriptMessages: () => base.transcriptMessages(),
      budget: () => base.budget(),
      modelCallLedger: () => base.modelCallLedger(),
      compactionAttempts: () => base.compactionAttempts(),
      cancelCalledLastTurn: () => base.cancelCalledLastTurn(),
      executionsLastTurn: () => base.executionsLastTurn(),
    };
    await expect(runHarnessSession({
      session, plan: LS6, wave: 'Wave1', track: 'LS6', sessionId: 'ls6-fake', principalId: 'principal-A',
      model: 'step-3.7-flash', contextWindow: 40000, limits: { maxModelCalls: 150 }, sleep: async () => {},
    })).rejects.toThrow('sendNoWait');
  });

  it('正向路径：13 轮期望全部判正、事实全对、无硬零', async () => {
    const sleeps: number[] = [];
    const r = await runLs6(ls6Script(), LS6, sleeps);
    expect(r.judgement.turnExpectations?.failures).toEqual([]);
    expect(r.judgement.turnExpectations?.pass).toBe(true);
    // 2026-11-18：N2-B 去掉裸数字排除后少一条检查（23 → 22）。
    expect(r.judgement.turnExpectations?.checked).toBe(22);
    expect(r.judgement.sessionFactsPass).toBe(true);
    expect(r.judgement.factFailures).toEqual([]);
    expect(r.judgement.taskVerdict.hardZeroHits).toEqual([]);
    // 真实空档只在该轮发生，且是 1500ms。
    expect(sleeps).toEqual([1500]);
    expect(r.evidence.turns.filter((t) => t.gapMs !== undefined).map((t) => [t.index, t.gapMs])).toEqual([[7, 1500]]);
    expect(r.summary['turnExpectationsPass']).toBe(true);
    expect(r.summary['turnExpectationChecks']).toBe(22);
  });

  it('真交错：deferIdle 轮走 sendNoWait；N1-C 前与 N6-Q2 落定处各 waitIdle 一次', async () => {
    const session = new FakeHarnessSession(ls6Script());
    const r = await runHarnessSession({
      session, plan: LS6, wave: 'Wave1', track: 'LS6', sessionId: 'ls6-fake', principalId: 'principal-A',
      model: 'step-3.7-flash', contextWindow: 40000, limits: { maxModelCalls: 150 },
      sleep: async () => { /* gapMs 由本文件其它用例单独断言 */ },
    });
    // N1-A/N1-B/N6-Q1/N6-Q2 四轮只交办；N1-C 发送前收尾一次、N6-Q2 判定前收尾一次。
    expect(r.evidence.turns.filter((t) => t.deferIdle === true).map((t) => t.index)).toEqual([1, 2, 11, 12]);
    expect(session.waitIdleCount()).toBe(2);
    expect(session.hasPendingBackground()).toBe(false);
    expect(r.judgement.turnExpectations?.failures).toEqual([]);
  });

  it('反向绊线 (a) N1 串台：A 的结论返回 documents 数字 → 事实判负（E-A）', async () => {
    const r = await runLs6(ls6Script({ replies: { 3: 'documents W202611 共 3 条，总金额 2900 元。' } }));
    expect(r.judgement.sessionFactsPass).toBe(false);
    expect(r.judgement.factFailures).toContain('E-A');
  });

  it('反向绊线 (b) N4 复用旧任务：没有新 taskId → new_task 判负（E-D）', async () => {
    const r = await runLs6(ls6Script({ tasks: { 8: [A_DONE, B_DONE, C_DONE], 9: [A_DONE, B_DONE, C_DONE] } }));
    const hit = r.judgement.turnExpectations?.failures.find((f) => f.check === 'new_task');
    expect(hit).toMatchObject({ turn: 8, label: 'N4', code: 'E-D' });
    expect(r.judgement.turnExpectations?.pass).toBe(false);
    expect(r.summary['turnExpectationsPass']).toBe(false);
  });

  it('反向绊线 (c) N5 沿用 3 条 → 事实 E-A + replyExcludes E-B 双判负', async () => {
    const r = await runLs6(ls6Script({ replies: { 10: 'alpha 共 3 条，总金额 2000 元。' } }));
    expect(r.judgement.sessionFactsPass).toBe(false);
    expect(r.judgement.factFailures).toContain('E-A');
    const hit = r.judgement.turnExpectations?.failures.find((f) => f.check === 'reply_excludes');
    expect(hit).toMatchObject({ turn: 10, label: 'N5-B', code: 'E-B', evidence: { hits: ['3条'] } });
  });

  it('反向绊线 (d) N6 假取消：轮前在飞却落成 completed（未触发 H5）→ inflight_cancel 判负（E-D）', async () => {
    // cancelCalled=true：既有 H5 只看「声称取消却没调 task_cancel」，此例故意绕开 H5。
    const r = await runLs6(ls6Script({ tasks: { 12: [A_DONE, B_DONE, C_DONE, D_DONE, E_DONE], 13: [A_DONE, B_DONE, C_DONE, D_DONE, E_DONE] }, replies: { 12: '已取消。' } }));
    expect(r.judgement.taskVerdict.hardZeroHits).toEqual([]);
    const hit = r.judgement.turnExpectations?.failures.find((f) => f.check === 'inflight_cancel');
    expect(hit).toMatchObject({ turn: 12, label: 'N6-Q2', code: 'E-D' });
    expect(hit?.evidence).toMatchObject({ claimsCancelled: true });
    expect(r.judgement.turnExpectations?.pass).toBe(false);
  });

  it('N6 已完成任务取消：状态被改写 → prev/status_in 双判负', async () => {
    const r = await runLs6(ls6Script({ tasks: { 13: [T('task-A', 1, '查 alpha W1', 'cancelled'), B_DONE, C_DONE, D_DONE, E_CANCELLED] } }));
    const checks = r.judgement.turnExpectations?.failures
      .filter((f) => f.turn === 13).map((f) => f.check).sort();
    expect(checks).toEqual(['prev_tasks_unchanged', 'task_fact_in']);
  });
});

describe('replyExcludes 作用域（2026-11-18 判据缺陷修复）', () => {
  it('只检查提到目标对象的句子：别的对象的合法数字不判负', () => {
    const reply = 'alpha：2 条 / 2000。\nbeta：3 条 / 1000。';
    expect(replyExcludedHits(reply, ['3条', '三条'], 'alpha')).toEqual([]);
    expect(replyExcludedHits(reply, ['3条'], 'beta')).toEqual(['3条']);
  });

  it('同一句里提到目标对象且含被禁值 → 仍判负', () => {
    expect(replyExcludedHits('alpha 是 3条。', ['3条'], 'alpha')).toEqual(['3条']);
  });

  it('不给作用域时保持原行为（全文检查）', () => {
    expect(replyExcludedHits('beta：3 条。', ['3条'])).toEqual(['3条']);
  });

  it('引号里的被否定值不算沿用（"3 条"的说法作废 → 不判负）', () => {
    const reply = 'alpha 的最终结论是 2 条 / 2000；之前那版「3条」的说法作废。';
    expect(replyExcludedHits(reply, ['3条'], 'alpha')).toEqual([]);
  });

  it('引号外的同值仍判负（alpha 是 3条。）', () => {
    expect(replyExcludedHits('alpha 是 3条。', ['3条'], 'alpha')).toEqual(['3条']);
  });
});
