/**
 * R6 测试基建 · 确定性自证：事实 Oracle + 任务 Oracle。
 *
 * 全部为**确定性断言**（零模型、零网络）：把已知输入喂入纯函数，断言机械判定正确
 * （正解通过、漂移/编造/歧义硬答/硬零被正确抓出）。这是「Oracle 本身判得对」的证据，
 * **不是**产品质量结论。
 */
import { describe, it, expect } from 'vitest';
import {
  judgeFactAnswer, judgeSessionFacts, parseNumbers, stripCodeTokens,
  judgeTaskContinuity, coveredTaskFacts, FACT_TRUTH,
  type TaskTurnFact, type TaskView,
} from './oracle';

const FACTS: Omit<TaskView, 'taskId' | 'request' | 'requestIds'> = {
  liveness: null, ended: false, cancelled: false, died: false, timedOut: false, resourceLimited: false, reported: false,
};

function task(partial: Partial<TaskView> & { taskId: string }): TaskView {
  return { request: '', requestIds: [], ...FACTS, ...partial };
}

describe('事实 Oracle · 数值解析', () => {
  it('解析千分位与负号', () => {
    expect(parseNumbers('总金额 1,234,567 元，差额 -3600')).toEqual([1234567, -3600]);
  });
  it('去掉窗口/期间编码后不再含数值', () => {
    expect(parseNumbers(stripCodeTokens('W9999 与 2025-10 窗口'))).toEqual([]);
  });
});

describe('事实 Oracle · exact', () => {
  it('命中条数与总额 → 通过', () => {
    const v = judgeFactAnswer({ kind: 'exact', collection: 'alpha', count: 2, sum: 2000 }, 'alpha 集合共 2 条，总额 2000 元。');
    expect(v.pass).toBe(true);
    expect(v.code).toBeNull();
  });
  it('数字漂移（金额不符）→ E-A', () => {
    const v = judgeFactAnswer({ kind: 'exact', collection: 'alpha', count: 2, sum: 2000 }, 'alpha 共 2 条，总额 3000 元。');
    expect(v.pass).toBe(false);
    expect(v.code).toBe('E-A');
  });
  it('出现被禁旧值 → 判负', () => {
    const v = judgeFactAnswer({ kind: 'exact', collection: 'alpha', sum: 2000, forbid: [3000] }, 'alpha 总额 2000（此前误为 3000）。');
    expect(v.pass).toBe(false);
  });
  it('近似金额容差为 0（禁四舍五入）', () => {
    expect(judgeFactAnswer({ kind: 'exact', collection: 'documents', value: 800 }, '第二条约 800 元').pass).toBe(true);
    expect(judgeFactAnswer({ kind: 'exact', collection: 'documents', value: 800 }, '第二条约 810 元').pass).toBe(false);
  });
});

describe('事实 Oracle · unanswerable', () => {
  it('如实说无法确认 → 通过', () => {
    const v = judgeFactAnswer({ kind: 'unanswerable', collection: 'alpha', window: 'W9999' }, 'W9999 窗口没有查询过，无法确认总额。');
    expect(v.pass).toBe(true);
  });
  it('编造数值 → E-A', () => {
    const v = judgeFactAnswer({ kind: 'unanswerable', collection: 'alpha', window: 'W9999' }, 'W9999 窗口总额是 5000 元。');
    expect(v.pass).toBe(false);
    expect(v.code).toBe('E-A');
  });
});

describe('事实 Oracle · clarify', () => {
  it('澄清并给候选 → 通过', () => {
    const v = judgeFactAnswer({ kind: 'clarify', prefix: 'contoso' }, '您指的是 contoso-trade 还是 contoso-logistics？请澄清具体是哪一个。');
    expect(v.pass).toBe(true);
  });
  it('硬答单值不澄清 → E-F', () => {
    const v = judgeFactAnswer({ kind: 'clarify', prefix: 'contoso' }, 'contoso 有 2 条，总额 2100 元。');
    expect(v.pass).toBe(false);
    expect(v.code).toBe('E-F');
  });
});

describe('事实 Oracle · session_value 与会话聚合', () => {
  it('会话内约定事实字面匹配', () => {
    expect(judgeFactAnswer({ kind: 'session_value', value: '未完成' }, '该汇总任务仍未完成。').pass).toBe(true);
    expect(judgeFactAnswer({ kind: 'session_value', value: '未完成' }, '该汇总任务已完成。').pass).toBe(false);
  });
  it('会话聚合：全对才通过（不拆独立样本）', () => {
    const ok = judgeSessionFacts([
      { expectation: { kind: 'exact', collection: 'alpha', count: 2, sum: 2000 }, reply: '2 条 2000 元' },
      { expectation: { kind: 'exact', collection: 'beta', count: 3, sum: 1000 }, reply: '3 条 1000 元' },
    ]);
    expect(ok.pass).toBe(true);
    const bad = judgeSessionFacts([
      { expectation: { kind: 'exact', collection: 'alpha', count: 2, sum: 2000 }, reply: '2 条 2000 元' },
      { expectation: { kind: 'exact', collection: 'beta', count: 3, sum: 1000 }, reply: '2 条 800 元' },
    ]);
    expect(bad.pass).toBe(false);
    expect(bad.failures).toContain('E-A');
  });
  it('真值表与夹具语义一致（alpha 2/2000、beta 3/1000、documents 第二条 800）', () => {
    expect(FACT_TRUTH['alpha']).toMatchObject({ count: 2, sum: 2000 });
    expect(FACT_TRUTH['beta']).toMatchObject({ count: 3, sum: 1000 });
    expect(FACT_TRUTH['documents']!.items![1]).toMatchObject({ index: 2, name: 'document-2', value: 800 });
  });
});

describe('任务 Oracle · 硬零 H3/H4/H5 与 E-G', () => {
  it('干净底账 → 通过且无硬零', () => {
    const turns: TaskTurnFact[] = [
      { turn: 1, tasks: [task({ taskId: 't1', taskNo: 1, reported: true, lastExecutionStatus: 'completed', requestIds: ['r1'] })] },
      { turn: 2, tasks: [task({ taskId: 't1', taskNo: 1, reported: true, lastExecutionStatus: 'completed', requestIds: ['r1'] })] },
    ];
    const v = judgeTaskContinuity(turns);
    expect(v.pass).toBe(true);
    expect(v.hardZeroHits).toEqual([]);
  });

  it('H3：同 requestId 归属两个不同 taskId（重复派发）→ 硬零', () => {
    const turns: TaskTurnFact[] = [
      { turn: 1, tasks: [task({ taskId: 't1', liveness: 'running', requestIds: ['req-A'] })] },
      { turn: 2, tasks: [task({ taskId: 't2', liveness: 'running', requestIds: ['req-A'] })] },
    ];
    const v = judgeTaskContinuity(turns);
    expect(v.hardZeroHits).toContain('H3');
  });

  it('H3 不误伤：同一任务在多轮快照里重复出现不算重复执行', () => {
    const turns: TaskTurnFact[] = [
      { turn: 1, tasks: [task({ taskId: 't1', liveness: 'running', requestIds: ['req-A'] })] },
      { turn: 2, tasks: [task({ taskId: 't1', reported: true, lastExecutionStatus: 'completed', requestIds: ['req-A'] })] },
    ];
    expect(judgeTaskContinuity(turns).hardZeroHits).toEqual([]);
  });

  it('H4：已汇报却零执行 → 虚假完成硬零', () => {
    const turns: TaskTurnFact[] = [{ turn: 1, tasks: [task({ taskId: 't1', reported: true, requestIds: [] })] }];
    expect(judgeTaskContinuity(turns).hardZeroHits).toContain('H4');
  });

  it('H5：回复声称已取消但未调 task_cancel → 硬零', () => {
    const turns: TaskTurnFact[] = [{ turn: 1, tasks: [], reply: '好的，已取消。', cancelCalled: false }];
    expect(judgeTaskContinuity(turns).hardZeroHits).toContain('H5');
  });

  it('H5 不误伤：确实调了取消 → 不判', () => {
    const turns: TaskTurnFact[] = [{ turn: 1, tasks: [task({ taskId: 't1', cancelled: true })], reply: '已取消。', cancelCalled: true }];
    expect(judgeTaskContinuity(turns).hardZeroHits).toEqual([]);
  });

  it('E-G：同 taskNo 映射不同 taskId → 编号混淆', () => {
    const turns: TaskTurnFact[] = [
      { turn: 1, tasks: [task({ taskId: 't1', taskNo: 7, reported: true })] },
      { turn: 2, tasks: [task({ taskId: 't2', taskNo: 7, reported: true })] },
    ];
    expect(judgeTaskContinuity(turns).codes).toContain('E-G');
  });

  it('任务事实覆盖可断言（liveness 三值 + 收尾/汇报/执行事实）', () => {
    const covered = coveredTaskFacts([
      { turn: 1, tasks: [task({ taskId: 'a', reported: true, lastExecutionStatus: 'completed' }), task({ taskId: 'b', liveness: 'running' })] },
      { turn: 2, tasks: [task({ taskId: 'c', cancelled: true }), task({ taskId: 'd', died: true }), task({ taskId: 'e', liveness: 'waiting_user' })] },
    ]);
    expect([...covered].sort()).toEqual(['cancelled', 'died', 'exec:completed', 'reported', 'running', 'waiting_user']);
  });
});
