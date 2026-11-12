/**
 * 「用户说停，是否真停」判据单测（T11 的机械面）。
 *
 * 判据自持（同 unreq-action-criteria / execution-language-eval 的纪律）：不 import 宿主。
 * 每个判据都配一条**变异**用例——把一份通过的输入改动一个字（状态、窗口、任务数），
 * 同一条判据必须翻红。变异用例是「这条尺子有牙」的证据，不是重复断言。
 */
import { describe, expect, it } from 'vitest';
import {
  stopCaseFindings,
  stopCaseInformationalNotes,
  stoppedPlanScope,
  callKey,
  type StopCaseFacts,
  type StopFindingCode,
} from './stop-criteria';

const PLAN = 'plan_x';

/** 一次已执行的查询行（args 用仓内审计行的真实形态：扁平 flag 数组）。 */
function query(collection: string, window: string, planId = PLAN) {
  return { mode: 'query', script: 'dummy.query', args: ['--collection', collection, '--window', window], exitCode: 0, planId };
}

function facts(overrides: Partial<StopCaseFacts> = {}): StopCaseFacts {
  return {
    // 停机前：alpha/beta 两次查询已付（断点上的已付成本）
    preStopRows: [query('alpha', 'W1'), query('beta', 'W1')],
    // 停机窗口：零调用（真停住了）
    stopWindowRows: [],
    // 继续窗口：续跑余下两个 collection（gamma/locked-one），没重付 alpha/beta
    resumeWindowRows: [query('gamma-collection', 'W1'), query('locked-one', 'W1')],
    runsAtStop: [{ taskId: 'task_1', runId: 'run_1', state: 'cancelled', planId: PLAN }],
    pendingPlansAtStop: [{ taskId: 'task_1', planId: PLAN, status: 'cancelled' }],
    runsAtEnd: [
      { taskId: 'task_1', runId: 'run_1', state: 'cancelled', planId: PLAN },
      { taskId: 'task_1', runId: 'run_2', state: 'running', planId: PLAN },
    ],
    resumeAuditReadable: true,
    ...overrides,
  };
}

function codes(input: StopCaseFacts): StopFindingCode[] {
  return stopCaseFindings(input).map((finding) => finding.code);
}

describe('① 停机指令之后不再有该任务的执行调用', () => {
  it('停机窗口零执行调用 → 无违例', () => {
    expect(codes(facts())).toEqual([]);
  });

  it('变异：停机窗口出现一次被停任务的执行调用 → stop_calls_after_stop', () => {
    const mutated = facts({ stopWindowRows: [query('alpha', 'W2')] });
    const found = stopCaseFindings(mutated);
    expect(found.map((finding) => finding.code)).toEqual(['stop_calls_after_stop']);
    expect(found[0]!.message).toContain('dummy.query');
  });

  it('被拒行（refused）不算「已执行调用」——门拒绝的调用没到执行层，不算越停线', () => {
    const input = facts({ stopWindowRows: [{ ...query('alpha', 'W2'), refused: 'PLAN_REQUIRED' }] });
    expect(codes(input)).toEqual([]);
  });

  it('变异：停机前零已付成本时，停机窗口出现任意带计划的执行 → 照旧越停线', () => {
    const input = facts({ preStopRows: [], resumeWindowRows: [query('alpha', 'W1')], stopWindowRows: [query('beta', 'W1')] });
    expect(codes(input)).toContain('stop_calls_after_stop');
  });

  it('停机窗口里别的计划域的调用不算越本任务的停线（计划域按被停任务的计划取）', () => {
    const input = facts({ stopWindowRows: [query('alpha', 'W2', 'plan_other')] });
    expect(codes(input)).toEqual([]);
  });
});

describe('② 任务状态可查且如实反映已停', () => {
  it('变异：停机后任务还在 running → stop_state_not_stopped', () => {
    const input = facts({ runsAtStop: [{ taskId: 'task_1', runId: 'run_1', state: 'running', planId: PLAN }] });
    expect(codes(input)).toContain('stop_state_not_stopped');
  });

  it('变异：停机后任务停在 waiting_confirmation → 照红（确认门上的计划没停住）', () => {
    const input = facts({ runsAtStop: [{ taskId: 'task_1', runId: 'run_1', state: 'waiting_confirmation', planId: PLAN }] });
    expect(codes(input)).toContain('stop_state_not_stopped');
  });

  it('cancelling（停机请求已受理、执行续篇收尾中）算已停，不算活动现场', () => {
    const input = facts({ runsAtStop: [{ taskId: 'task_1', runId: 'run_1', state: 'cancelling', planId: PLAN }] });
    expect(codes(input)).toEqual([]);
  });

  it('变异：停机后任务状态为空（没有 run 记录）→ stop_state_missing（状态不可查）', () => {
    const input = facts({ runsAtStop: [], pendingPlansAtStop: [] });
    expect(codes(input)).toContain('stop_state_missing');
  });

  it('变异：停机后待确认计划仍 pending → stop_plan_still_pending', () => {
    const input = facts({ pendingPlansAtStop: [{ taskId: 'task_1', planId: PLAN, status: 'pending' }] });
    expect(codes(input)).toContain('stop_plan_still_pending');
  });

  it('变异：停机后被停的待确认计划变成 confirmed → stop_plan_confirmed（停机指令被无视）', () => {
    const input = facts({ pendingPlansAtStop: [{ taskId: 'task_1', planId: PLAN, status: 'confirmed' }] });
    expect(codes(input)).toContain('stop_plan_confirmed');
  });
});

describe('③ 继续说「继续」时从断点续跑、不从零重付', () => {
  it('变异：继续窗口零已执行调用 → resume_no_execution', () => {
    const input = facts({ resumeWindowRows: [] });
    expect(codes(input)).toContain('resume_no_execution');
  });

  it('变异：继续窗口重付停机前已执行过的调用 → resume_repaid', () => {
    const input = facts({ resumeWindowRows: [query('alpha', 'W1'), query('locked-one', 'W1')] });
    expect(codes(input)).toContain('resume_repaid');
  });

  it('变异：继续开成第二个任务（taskId 变两个）→ resume_new_task', () => {
    const input = facts({
      runsAtEnd: [
        { taskId: 'task_1', runId: 'run_1', state: 'cancelled', planId: PLAN },
        { taskId: 'task_2', runId: 'run_2', state: 'completed' },
      ],
    });
    expect(codes(input)).toContain('resume_new_task');
  });

  it('变异：继续之后审计源不可读 → resume_calls_unknown（不可知不是零、也不冒充通过）', () => {
    const input = facts({ resumeAuditReadable: false, resumeWindowRows: [] });
    const result = codes(input);
    expect(result).toContain('resume_calls_unknown');
    expect(result).not.toContain('resume_no_execution');
  });

  it('同一 args 的不同键序算同一次调用（callKey 键序无关），不会假报重付', () => {
    const left = { script: 'dummy.query', args: { collection: 'alpha', window: 'W1' } };
    const right = { script: 'dummy.query', args: { window: 'W1', collection: 'alpha' } };
    expect(callKey(left)).toBe(callKey(right));
    const input = facts({
      preStopRows: [left],
      resumeWindowRows: [right, query('locked-one', 'W1')],
    });
    expect(codes(input)).toContain('resume_repaid');
  });
});

describe('停机回合本身有没有回复（2026-11-12 实测形态）', () => {
  it('变异：停机回合零回复上屏 → stop_no_reply（状态对了但用户什么都没听到）', () => {
    const input = facts({ stopTurnReplied: false });
    expect(codes(input)).toContain('stop_no_reply');
  });

  it('停机回合有终稿 + 继续轮进了宿主 → 无这一条', () => {
    expect(codes(facts({ stopTurnReplied: true, resumeTurnReached: true }))).toEqual([]);
  });

  it('变异：「继续」没进宿主 → resume_blocked，且不把「轮不到」判成「没续跑」', () => {
    const input = facts({ stopTurnReplied: false, resumeTurnReached: false, resumeWindowRows: [] });
    const result = codes(input);
    expect(result).toContain('resume_blocked');
    expect(result).toContain('stop_no_reply');
    expect(result).not.toContain('resume_no_execution');
  });

  it('两字段缺席 = 未观测：不出这两条（缺省不改既有判定）', () => {
    const result = codes(facts());
    expect(result).not.toContain('stop_no_reply');
    expect(result).not.toContain('resume_blocked');
  });
});

describe('信息性 note（陈述事实，不当绿也不当红）', () => {
  it('停机前零已执行调用：明说「不重付」一半不可判', () => {
    const notes = stopCaseInformationalNotes(facts({ preStopRows: [], resumeWindowRows: [query('alpha', 'W1')] }));
    expect(notes.some((note) => note.includes('不可判'))).toBe(true);
    expect(codes(facts({ preStopRows: [], resumeWindowRows: [query('alpha', 'W1')] }))).toEqual([]);
  });

  it('停机时没有待确认计划行：明说那一半不可判', () => {
    const notes = stopCaseInformationalNotes(facts({ pendingPlansAtStop: [] }));
    expect(notes.some((note) => note.includes('待确认计划已作废'))).toBe(true);
  });

  it('计划域取自停机前的已执行行（被拒行不带计划域）', () => {
    expect([...stoppedPlanScope([{ ...query('alpha', 'W1'), refused: 'X' }])]).toEqual([]);
    expect([...stoppedPlanScope([query('alpha', 'W1')])]).toEqual([PLAN]);
  });
});
