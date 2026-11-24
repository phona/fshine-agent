/**
 * Task Registry 契约核心（S1 事实模型，2026-11-22）。
 *
 * 契约来源：docs/design/task-redefinition.md（2026-11-22）——task 没有 status：
 *   · 底账只记机械事实（归属 + 存活 + 等待 + 四个一次性时刻 + 汇报存档 + 逐笔执行行）；
 *   · 「做没做成」读执行行（claimed→resulted）与汇报，不在底账写结论；
 *   · 旧转换矩阵 / TaskTransitionError / TASK_STATUSES / requestCancel/confirmCancelled /
 *     complete/fail/timeout/markResultUnknown 已随 S1 删除，对应旧用例一并退役。
 *
 * 覆盖（保留的用户级行为与安全不变量）：
 *   · 受理：缺省 inline（写 running_since）与显式 queued（不写）的可辨机械事实；
 *   · 等待：pendingQuestion/waitingSince 持久化；答复续同一 Task（task_no 不变、executions
 *     追加、不新建任务）；SQLite 跨重启保真；
 *   · 归属：越权与不存在同一 TaskOwnershipError（不泄漏存在性）；
 *   · onTaskFact：单回调注入；每次机械事实一条；重复注入替换；
 *   · claimNextQueued：仅认领未启动任务；原子写 running_since + 租约；有效租约不被过期；
 *   · 租约过期 → died 一次性事实（结果未知，禁止自动重放、不被重新认领）。
 *
 * 判据对内存与 SQLite 两实现逐项一致地跑同一组（契约实现无关）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TaskOwnershipError,
  createTaskRegistry,
  type PendingQuestion,
  type TaskFact,
  type TaskRegistry,
} from './src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from './src/task-registry-sqlite';

const SCOPE = { principalId: 'wecom:fixture-user', sessionId: 'ask-r4-p2a' };

const dirs: string[] = [];
const closers: Array<() => void> = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-registry-contract-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryRegistry(): TaskRegistry {
  return createTaskRegistry();
}

function sqliteRegistry(dbPath: string = tempDbPath()): SqliteTaskRegistry {
  const registry = createSqliteTaskRegistry(dbPath);
  closers.push(() => registry.close());
  return registry;
}

/** 契约实现无关：同一组判据对内存与 SQLite 逐项跑。 */
const IMPLS: ReadonlyArray<{ name: string; make: () => TaskRegistry }> = [
  { name: '内存', make: memoryRegistry },
  { name: 'SQLite', make: () => sqliteRegistry() },
];

const QUESTION: PendingQuestion = {
  missing: ['时间范围'],
  candidates: ['本月', '上月'],
  raw: '执行层要求补充查询的时间范围。',
};

for (const impl of IMPLS) {
  describe(`Task Registry 契约核心（${impl.name}）`, () => {
    it('begin 缺省 inline（写 running_since）；可显式 queued（后台受理，不写 running_since）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'begin_default', ...SCOPE, request: '内联任务' });
      registry.begin({ taskId: 'begin_queued', ...SCOPE, request: '后台任务', queued: true });
      expect(registry.get('begin_default', SCOPE).runningSince).toBeTruthy();
      expect(registry.get('begin_queued', SCOPE).runningSince).toBeUndefined();
    });

    it('等待事实：pendingQuestion/waitingSince 持久化；答复续同一 Task（task_no/createdAt 不变、executions 追加、不新建任务）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'wait_task', ...SCOPE, request: '查 beta 账目' });
      registry.noteExecution('wait_task', {
        requestId: 'req_wait_1',
        operation: 'dummy.query',
        status: 'needs_input',
      });

      const waiting = registry.waitForUser('wait_task', QUESTION);
      expect(waiting.pendingQuestion).toEqual(QUESTION);
      expect(waiting.waitingSince).toBeTruthy();
      // 等待事实清租约（存活推导不再看租约）。
      expect(waiting.leaseUntil).toBeUndefined();
      const taskNoBefore = waiting.taskNo;
      const createdAtBefore = waiting.createdAt;

      const resumed = registry.answerResumes('wait_task');
      expect(resumed.pendingQuestion).toBeUndefined();
      expect(resumed.waitingSince).toBeUndefined();
      expect(resumed.runningSince).toBeTruthy();

      registry.noteExecution('wait_task', {
        requestId: 'req_wait_2',
        operation: 'dummy.query',
        status: 'completed',
      });
      const done = registry.get('wait_task', SCOPE);
      expect(done.taskNo).toBe(taskNoBefore);
      expect(done.createdAt).toBe(createdAtBefore);
      expect(done.executions.map((execution) => execution.requestId)).toEqual(['req_wait_1', 'req_wait_2']);
      expect(registry.list(SCOPE)).toHaveLength(1);
    });

    it('归属：越权与不存在同一 TaskOwnershipError（错误类型与消息逐字一致）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'own_task', ...SCOPE, request: '归属任务' });
      const wrongScope = { principalId: 'wecom:other', sessionId: SCOPE.sessionId };

      const cases: ReadonlyArray<{ name: string; wrong: () => unknown; absent: () => unknown }> = [
        { name: 'get', wrong: () => registry.get('own_task', wrongScope), absent: () => registry.get('own_absent', SCOPE) },
        {
          name: 'waitForUser',
          wrong: () => registry.waitForUser('own_task', QUESTION, { scope: wrongScope }),
          absent: () => registry.waitForUser('own_absent', QUESTION, { scope: SCOPE }),
        },
        {
          name: 'answerResumes',
          wrong: () => registry.answerResumes('own_task', { scope: wrongScope }),
          absent: () => registry.answerResumes('own_absent', { scope: SCOPE }),
        },
        {
          name: 'markCancelled',
          wrong: () => registry.markCancelled('own_task', { scope: wrongScope }),
          absent: () => registry.markCancelled('own_absent', { scope: SCOPE }),
        },
        {
          name: 'markTimedOut',
          wrong: () => registry.markTimedOut('own_task', 'execution', { scope: wrongScope }),
          absent: () => registry.markTimedOut('own_absent', 'execution', { scope: SCOPE }),
        },
        {
          name: 'markResourceLimited',
          wrong: () => registry.noteResourceRefused('own_task', { scope: wrongScope }),
          absent: () => registry.noteResourceRefused('own_absent', { scope: SCOPE }),
        },
      ];

      for (const testCase of cases) {
        const wrongError = capture(testCase.wrong);
        const absentError = capture(testCase.absent);
        expect(wrongError, `${testCase.name} 越权应拒绝`).toBeInstanceOf(TaskOwnershipError);
        expect(absentError, `${testCase.name} 不存在应拒绝`).toBeInstanceOf(TaskOwnershipError);
        expect((wrongError as Error).message, `${testCase.name} 越权/不存在同错`).toBe((absentError as Error).message);
      }

      // 拒绝不得改变事实。
      expect(registry.get('own_task', SCOPE).endedAt).toBeUndefined();
    });

    it('onTaskFact：单回调注入；每次机械事实一条；重复注入替换', () => {
      const registry = impl.make();
      const firstFacts: TaskFact[] = [];
      const secondFacts: TaskFact[] = [];
      registry.onTaskFact((fact) => firstFacts.push(fact));

      registry.begin({ taskId: 'fact_task', ...SCOPE, request: '事实钩子任务' });
      registry.waitForUser('fact_task', QUESTION);
      registry.answerResumes('fact_task');
      registry.markCancelled('fact_task');

      expect(firstFacts.map((fact) => fact.event)).toEqual([
        'started',
        'waiting_user',
        'resumed',
        'user_stop',
      ]);
      for (const fact of firstFacts) {
        expect(fact.taskId).toBe('fact_task');
        expect(typeof fact.taskNo).toBe('number');
        expect(fact.name).not.toBe('');
        expect(Number.isNaN(Date.parse(fact.at))).toBe(false);
        // 稳定去重版本缺省 = at（P4 outbox 唯一键用）。
        expect(fact.stateVersion).toBe(fact.at);
      }

      // 单回调：再次注入替换旧回调（旧回调不再收到事实）。
      registry.onTaskFact((fact) => secondFacts.push(fact));
      registry.begin({ taskId: 'fact_task_2', ...SCOPE, request: '替换后任务' });
      expect(firstFacts).toHaveLength(4);
      expect(secondFacts.map((fact) => fact.taskId)).toEqual(['fact_task_2']);
    });

    it('claimNextQueued：仅认领未启动任务；原子写 running_since + 租约；有效租约不被过期', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'claim_a', ...SCOPE, request: '排队 A', queued: true });
      registry.begin({ taskId: 'claim_b', ...SCOPE, request: '排队 B', queued: true });

      const first = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 });
      expect(first?.taskId).toBe('claim_a');
      expect(first?.leaseOwner).toBe('runner-1');
      expect(first?.runningSince).toBeTruthy();

      const second = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 });
      expect(second?.taskId).toBe('claim_b');
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 })).toBeUndefined();

      // 有效租约不被 expireLeases 判 died；已认领任务不再参与认领。
      expect(registry.expireLeases(new Date().toISOString())).toHaveLength(0);
      expect(registry.get('claim_a', SCOPE).endedAt).toBeUndefined();

      registry.begin({ taskId: 'claim_inline', ...SCOPE, request: '内联运行中' });
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 })).toBeUndefined();
    });

    it('租约过期 → died 一次性事实；不自动重放、不被重新认领；二次过期无变化', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'died_claimed', ...SCOPE, request: '可能有副作用的任务', queued: true });
      const claimed = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 0 });
      expect(claimed?.taskId).toBe('died_claimed');
      expect(claimed?.leaseUntil).toBeTruthy();

      const expired = registry.expireLeases(new Date(Date.now() + 1_000).toISOString());
      expect(expired.map((task) => task.taskId)).toContain('died_claimed');
      const died = registry.get('died_claimed', SCOPE);
      expect(died.endedAt).toBeTruthy();
      // 一次性事实：不翻案、不被重新认领。
      expect(registry.claimNextQueued({ owner: 'runner-2', leaseMs: 1_000 })).toBeUndefined();
      expect(registry.expireLeases(new Date(Date.now() + 2_000).toISOString())).toHaveLength(0);
    });

    it('已收尾的行不被过期扫描改写成 died（汇报存档 / round_failed 都是已知事实）', () => {
      const registry = impl.make();
      // 已汇报：租约残留且过期，但完成事实已存档——不是「结果未知」。
      registry.begin({ taskId: 'expired_reported', ...SCOPE, request: '已汇报的活', queued: true });
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 0 })?.taskId).toBe('expired_reported');
      registry.setResultText('expired_reported', '完成汇报。');
      // 回合失败收尾：租约不清（markRoundFailed 语义），过期扫描同样不得改写。
      registry.begin({ taskId: 'expired_round_failed', ...SCOPE, request: '失败的活', queued: true });
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 0 })?.taskId).toBe('expired_round_failed');
      registry.noteRoundEnded('expired_round_failed');

      const expired = registry.expireLeases(new Date(Date.now() + 1_000).toISOString());
      expect(expired.map((task) => task.taskId)).toEqual([]);
      expect(registry.get('expired_reported', SCOPE).endedAt).not.toBe('died');
      expect(registry.get('expired_round_failed', SCOPE).endedAt).not.toBe('died');

      // markDied 直调同样不翻案（不是只有扫描面挡住）。
      registry.markLeaseExpired('expired_reported');
      registry.markLeaseExpired('expired_round_failed');
      expect(registry.get('expired_reported', SCOPE).endedAt).not.toBe('died');
      expect(registry.get('expired_round_failed', SCOPE).endedAt).not.toBe('died');
    });

    it('写结束事实同时清等待形状：取消/超时/无汇报收尾后不再显示等待，也不能再答复', () => {
      const registry = impl.make();
      const startWaiting = (taskId: string): void => {
        registry.begin({ taskId, ...SCOPE, request: '等待中的活', queued: true });
        expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 })?.taskId).toBe(taskId);
        registry.waitForUser(taskId, QUESTION);
        expect(registry.get(taskId, SCOPE).pendingQuestion).toBeDefined();
      };

      startWaiting('wait_cancel');
      registry.markCancelled('wait_cancel');
      const cancelled = registry.get('wait_cancel', SCOPE);
      expect(cancelled.endedAt).toBeTruthy();
      expect(cancelled.pendingQuestion).toBeUndefined();
      expect(cancelled.waitingSince).toBeUndefined();

      startWaiting('wait_timeout');
      registry.markTimedOut('wait_timeout', 'waiting_user');
      const timedOut = registry.get('wait_timeout', SCOPE);
      expect(timedOut.endedAt).toBeTruthy();
      expect(timedOut.pendingQuestion).toBeUndefined();
      expect(timedOut.waitingSince).toBeUndefined();

      startWaiting('wait_round_end');
      registry.noteRoundEnded('wait_round_end');
      const ended = registry.get('wait_round_end', SCOPE);
      expect(ended.endedAt).toBeTruthy();
      expect(ended.pendingQuestion).toBeUndefined();

      // 结束事实不翻案：结束后的答复被拒绝（提问不会被写回来）。
      expect(() => registry.answerResumes('wait_cancel')).toThrow();
    });
  });
}

describe('Task Registry 契约核心（SQLite 持久化）', () => {
  it('等待事实跨重启保真：pending_question/waiting_since 原样读出，答复续同一 task_no', () => {
    const dbPath = tempDbPath();
    const first = sqliteRegistry(dbPath);
    first.begin({ taskId: 'persist_wait', ...SCOPE, request: '跨重启等待' });
    first.noteExecution('persist_wait', { requestId: 'req_persist_1', operation: 'dummy.query', status: 'needs_input' });
    const waiting = first.waitForUser('persist_wait', QUESTION);
    const taskNo = waiting.taskNo;
    const waitingSince = waiting.waitingSince;
    first.close();

    const second = sqliteRegistry(dbPath);
    const reloaded = second.get('persist_wait', SCOPE);
    expect(reloaded.pendingQuestion).toEqual(QUESTION);
    expect(reloaded.waitingSince).toBe(waitingSince);
    expect(reloaded.taskNo).toBe(taskNo);

    second.answerResumes('persist_wait');
    second.noteExecution('persist_wait', { requestId: 'req_persist_2', operation: 'dummy.query', status: 'completed' });
    const done = second.get('persist_wait', SCOPE);
    expect(done.taskNo).toBe(taskNo);
    expect(done.executions.map((execution) => execution.requestId)).toEqual(['req_persist_1', 'req_persist_2']);
    expect(second.list(SCOPE)).toHaveLength(1);
  });

  it('租约过期跨重启仍为 died 事实且不被重新认领', () => {
    const dbPath = tempDbPath();
    const first = sqliteRegistry(dbPath);
    first.begin({ taskId: 'persist_died', ...SCOPE, request: '重启恢复', queued: true });
    expect(first.claimNextQueued({ owner: 'runner-old', leaseMs: 0 })?.taskId).toBe('persist_died');
    first.close();

    const second = sqliteRegistry(dbPath);
    const expired = second.expireLeases(new Date(Date.now() + 1_000).toISOString());
    expect(expired.map((task) => task.taskId)).toEqual(['persist_died']);
    expect(second.get('persist_died', SCOPE).endedAt).toBeTruthy();
    expect(second.claimNextQueued({ owner: 'runner-new', leaseMs: 60_000 })).toBeUndefined();
  });
});

/** 捕获同步异常（用于断言错误形态相同）。 */
function capture(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return error;
  }
}
