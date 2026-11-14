/**
 * R4 P2a Task Registry 契约核心（冻结判据；TDD 先红）。
 *
 * 契约来源：docs/product/r4-joint-interfaces.md §1（v1 冻结）+ r4-acceptance.md P2-T01–T05。
 * 覆盖：
 *   · 状态集：queued/running/waiting_user/cancelling/cancelled/completed/failed/timed_out，
 *     保留 unexecuted；
 *   · 合法/非法转换矩阵：仅冻结边可过；非法边确定性拒绝（TaskTransitionError），
 *     状态不变、零事实；
 *   · 取消语义：请求 ≠ 取消；确认才 cancelled；未确认回 running（不得宣称取消）；
 *   · waiting_user：pendingQuestion/waitingSince 持久化；答复续同一 Task（task_no 不变、
 *     executions 追加、不得新建任务）；SQLite 跨重启保真；
 *   · 超时：queued/running/waiting_user → timed_out + 机械原因 timeout；等待超时关闭
 *     活跃等待但保留 pendingQuestion/waitingSince 历史；
 *   · result_unknown：认领 → 租约过期 → 终态；不自动重放、不判成功；
 *   · 归属：越权与不存在同一 TaskOwnershipError（不泄漏存在性）；
 *   · onTaskFact：单回调注入；每次成功状态变化一条事实；拒绝的转换零事实；重复注入替换；
 *   · claimNextQueued：仅认领 queued；原子置 running + lease。
 *
 * 判据对内存与 SQLite 两实现逐项一致地跑同一矩阵（契约实现无关）。
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  TaskOwnershipError,
  TaskTransitionError,
  createTaskRegistry,
  type PendingQuestion,
  type TaskFact,
  type TaskRegistry,
  type TaskStatus,
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

const ALL_STATUSES = TASK_STATUSES;

/**
 * 冻结的合法转换（测试内独立书写，不从实现导入——防止「实现即判据」自证）。
 * 见 r4-joint-interfaces.md §1：queued→running；queued→cancelling→cancelled；
 * running→{completed|failed|waiting_user|cancelling|timed_out}；waiting_user→{running|cancelling}；
 * waiting_user 超时关闭活跃等待；cancelling→cancelled；cancelling→running（回滚）。
 * 另：unexecuted 为保留的内联终态（judgeReportedTask 零执行，现冻结语义）；
 * queued 等待超时（P2-T04「排队等待超时」）→ timed_out。
 */
const EXPECTED_LEGAL: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelling', 'timed_out'],
  running: ['completed', 'failed', 'waiting_user', 'cancelling', 'timed_out', 'unexecuted'],
  waiting_user: ['running', 'cancelling', 'timed_out'],
  cancelling: ['cancelled', 'running'],
  cancelled: [],
  completed: [],
  failed: [],
  timed_out: [],
  unexecuted: [],
};

const QUESTION: PendingQuestion = {
  missing: ['时间范围'],
  candidates: ['本月', '上月'],
  raw: '执行层要求补充查询的时间范围。',
};

/** 把新任务推进到给定状态（用合法方法与既有内联路径；不依赖被测矩阵本身）。 */
function seedAs(registry: TaskRegistry, state: TaskStatus, taskId: string): void {
  const base = { taskId, ...SCOPE, request: `种子任务（${state}）` } as const;
  switch (state) {
    case 'queued':
      registry.begin({ ...base, status: 'queued' });
      return;
    case 'running':
      registry.begin(base);
      return;
    case 'waiting_user':
      registry.begin(base);
      registry.waitForUser(taskId, QUESTION);
      return;
    case 'cancelling':
      registry.begin(base);
      registry.requestCancel(taskId);
      return;
    case 'cancelled':
      registry.begin(base);
      registry.requestCancel(taskId);
      registry.confirmCancelled(taskId);
      return;
    case 'completed':
      registry.begin(base);
      registry.noteExecution(taskId, { requestId: `req_${taskId}`, operation: 'dummy.query', status: 'completed' });
      registry.complete(taskId, '种子完成汇报。');
      return;
    case 'failed':
      registry.begin(base);
      registry.fail(taskId, '种子失败。');
      return;
    case 'timed_out':
      registry.begin(base);
      registry.timeout(taskId, 'execution');
      return;
    case 'unexecuted':
      registry.begin(base);
      registry.complete(taskId, '种子未发起调用。');
      return;
  }
}

for (const impl of IMPLS) {
  describe(`Task Registry 契约核心（${impl.name}）`, () => {
    it('冻结状态集：8 态 + 保留 unexecuted', () => {
      expect(ALL_STATUSES).toEqual([
        'queued',
        'running',
        'waiting_user',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
        'timed_out',
        'unexecuted',
      ]);
    });

    it('begin 缺省 running（内联语义保持）；可显式 queued（后台受理）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'begin_default', ...SCOPE, request: '内联任务' });
      registry.begin({ taskId: 'begin_queued', ...SCOPE, request: '后台任务', status: 'queued' });
      expect(registry.get('begin_default', SCOPE).status).toBe('running');
      expect(registry.get('begin_queued', SCOPE).status).toBe('queued');
    });

    it('合法/非法转换矩阵：仅冻结边可过，其余确定性拒绝、状态不变、零事实', () => {
      const registry = impl.make();
      const facts: TaskFact[] = [];
      registry.onTaskFact((fact) => facts.push(fact));

      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const taskId = `mx_${from}_to_${to}`;
          seedAs(registry, from, taskId);
          const factsBefore = facts.length;
          const legal = EXPECTED_LEGAL[from].includes(to);
          if (legal) {
            const record = registry.transition(taskId, to);
            expect(record.status, `${from}→${to} 应可过`).toBe(to);
            expect(facts.length, `${from}→${to} 应有事实`).toBe(factsBefore + 1);
            expect(facts[facts.length - 1]).toMatchObject({ taskId, from, to });
          } else {
            expect(() => registry.transition(taskId, to), `${from}→${to} 应拒绝`).toThrow(TaskTransitionError);
            expect(registry.get(taskId, SCOPE).status, `${from}→${to} 拒绝后状态不变`).toBe(from);
            expect(facts.length, `${from}→${to} 拒绝不留事实`).toBe(factsBefore);
          }
        }
      }
    });

    it('取消语义：请求 ≠ 取消；确认才 cancelled；未确认回 running（不得宣称取消）', () => {
      const registry = impl.make();

      // 运行中取消：请求 → cancelling（不是 cancelled）；未获确认 → 回 running，可正常完成。
      registry.begin({ taskId: 'cancel_rollback', ...SCOPE, request: '取消回滚路径' });
      const requested = registry.requestCancel('cancel_rollback');
      expect(requested.status).toBe('cancelling');
      expect(registry.get('cancel_rollback', SCOPE).status).not.toBe('cancelled');

      const rolledBack = registry.transition('cancel_rollback', 'running');
      expect(rolledBack.status).toBe('running');
      registry.noteExecution('cancel_rollback', {
        requestId: 'req_cancel_rollback',
        operation: 'dummy.query',
        status: 'completed',
      });
      registry.complete('cancel_rollback', '中止未获确认，按原任务完成。');
      expect(registry.get('cancel_rollback', SCOPE).status).toBe('completed');

      // 确认路径：请求 → cancelling →（确认）cancelled + 机械原因。
      registry.begin({ taskId: 'cancel_confirmed', ...SCOPE, request: '确认取消' });
      registry.requestCancel('cancel_confirmed');
      const cancelled = registry.confirmCancelled('cancel_confirmed');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.reason).toBe('cancelled_by_user');

      // 取消确认不重放：终态不可再取消；未请求不得直接确认。
      expect(() => registry.requestCancel('cancel_confirmed')).toThrow(TaskTransitionError);
      expect(() => registry.confirmCancelled('cancel_confirmed')).toThrow(TaskTransitionError);
      registry.begin({ taskId: 'cancel_unrequested', ...SCOPE, request: '未请求直接确认' });
      expect(() => registry.confirmCancelled('cancel_unrequested')).toThrow(TaskTransitionError);
      expect(registry.get('cancel_unrequested', SCOPE).status).toBe('running');

      // 排队中取消：queued → cancelling → cancelled。
      registry.begin({ taskId: 'cancel_queued', ...SCOPE, request: '排队取消', status: 'queued' });
      registry.requestCancel('cancel_queued');
      expect(registry.get('cancel_queued', SCOPE).status).toBe('cancelling');
      expect(registry.confirmCancelled('cancel_queued').status).toBe('cancelled');

      // 等待用户时取消：waiting_user → cancelling。
      registry.begin({ taskId: 'cancel_waiting', ...SCOPE, request: '等待中取消' });
      registry.waitForUser('cancel_waiting', QUESTION);
      expect(registry.requestCancel('cancel_waiting').status).toBe('cancelling');
      expect(registry.confirmCancelled('cancel_waiting').status).toBe('cancelled');
    });

    it('waiting_user：pendingQuestion/waitingSince 形状持久化；答复续同一 Task（task_no 不变、executions 追加、不新建任务）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'wait_task', ...SCOPE, request: '查 beta 账目' });
      registry.noteExecution('wait_task', {
        requestId: 'req_wait_1',
        operation: 'dummy.query',
        status: 'needs_input',
      });

      const waiting = registry.waitForUser('wait_task', QUESTION);
      expect(waiting.status).toBe('waiting_user');
      expect(waiting.pendingQuestion).toEqual(QUESTION);
      expect(waiting.waitingSince).toBeTruthy();
      const taskNoBefore = waiting.taskNo;
      const createdAtBefore = waiting.createdAt;

      // 等待中不得直接判失败/完成（必须经答复接续）。
      expect(() => registry.transition('wait_task', 'failed')).toThrow(TaskTransitionError);
      expect(() => registry.complete('wait_task', '等待中不得收尾。')).toThrow(TaskTransitionError);

      const resumed = registry.answerResumes('wait_task');
      expect(resumed.status).toBe('running');
      expect(resumed.pendingQuestion).toBeUndefined();
      expect(resumed.waitingSince).toBeUndefined();

      registry.noteExecution('wait_task', {
        requestId: 'req_wait_2',
        operation: 'dummy.query',
        status: 'completed',
      });
      // 后台路径由 runner 按执行层确认的结果落终态（不经过 inline judgeReportedTask：
      // 其「首个非 completed 判负」语义被表征测试冻结，waiting_user 仅后台任务使用）。
      const done = registry.transition('wait_task', 'completed');
      expect(done.status).toBe('completed');
      expect(done.taskNo).toBe(taskNoBefore);
      expect(done.createdAt).toBe(createdAtBefore);
      expect(done.executions.map((execution) => execution.requestId)).toEqual(['req_wait_1', 'req_wait_2']);
      expect(registry.list(SCOPE)).toHaveLength(1);
    });

    it('waiting_user 非法入边拒绝：queued 不得直接等待；重复等待拒绝', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'wait_bad_queued', ...SCOPE, request: '排队等待', status: 'queued' });
      expect(() => registry.waitForUser('wait_bad_queued', QUESTION)).toThrow(TaskTransitionError);

      registry.begin({ taskId: 'wait_double', ...SCOPE, request: '重复等待' });
      registry.waitForUser('wait_double', QUESTION);
      expect(() => registry.waitForUser('wait_double', QUESTION)).toThrow(TaskTransitionError);
      expect(registry.get('wait_double', SCOPE).status).toBe('waiting_user');
    });

    it('超时：queued/running/waiting_user → timed_out + 机械原因 timeout；等待超时保留历史', () => {
      const registry = impl.make();

      registry.begin({ taskId: 'timeout_queued', ...SCOPE, request: '排队等待超时', status: 'queued' });
      const queuedTimeout = registry.timeout('timeout_queued', 'queued');
      expect(queuedTimeout.status).toBe('timed_out');
      expect(queuedTimeout.reason).toBe('timeout');

      registry.begin({ taskId: 'timeout_running', ...SCOPE, request: '执行超时' });
      const runningTimeout = registry.timeout('timeout_running', 'execution');
      expect(runningTimeout.status).toBe('timed_out');
      expect(runningTimeout.reason).toBe('timeout');

      registry.begin({ taskId: 'timeout_waiting', ...SCOPE, request: '等待用户超时' });
      registry.waitForUser('timeout_waiting', QUESTION);
      const waitingTimeout = registry.timeout('timeout_waiting', 'waiting_user');
      expect(waitingTimeout.status).toBe('timed_out');
      expect(waitingTimeout.reason).toBe('timeout');
      // 关闭活跃等待但保留历史与原因。
      expect(waitingTimeout.pendingQuestion).toEqual(QUESTION);
      expect(waitingTimeout.waitingSince).toBeTruthy();

      // 超时后不可再接续/重放/二次超时。
      expect(() => registry.answerResumes('timeout_waiting')).toThrow(TaskTransitionError);
      expect(() => registry.timeout('timeout_waiting', 'waiting_user')).toThrow(TaskTransitionError);
      expect(() => registry.timeout('timeout_queued', 'queued')).toThrow(TaskTransitionError);

      // 种类与当前状态不匹配一律拒绝（防错配）。
      registry.begin({ taskId: 'timeout_mismatch', ...SCOPE, request: '错配超时', status: 'queued' });
      expect(() => registry.timeout('timeout_mismatch', 'execution')).toThrow(TaskTransitionError);
      expect(registry.get('timeout_mismatch', SCOPE).status).toBe('queued');
    });

    it('result_unknown 不自动重放：认领 → 租约过期 → 终态；不再被认领、不判成功', () => {
      const registry = impl.make();

      registry.begin({ taskId: 'unknown_claimed', ...SCOPE, request: '可能有副作用的任务', status: 'queued' });
      const claimed = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 0 });
      expect(claimed?.taskId).toBe('unknown_claimed');
      expect(claimed?.status).toBe('running');
      expect(claimed?.leaseOwner).toBe('runner-1');
      expect(claimed?.leaseUntil).toBeTruthy();

      const expired = registry.expireLeases(new Date(Date.now() + 1_000).toISOString());
      expect(expired.map((task) => task.taskId)).toContain('unknown_claimed');
      const unknown = registry.get('unknown_claimed', SCOPE);
      expect(unknown.status).toBe('failed');
      expect(unknown.status).not.toBe('completed');
      expect(unknown.reason).toBe('result_unknown');

      // 不自动重放：不会回到 queued、不会被再次认领；二次过期无变化。
      expect(registry.claimNextQueued({ owner: 'runner-2', leaseMs: 1_000 })).toBeUndefined();
      expect(registry.expireLeases(new Date(Date.now() + 2_000).toISOString())).toHaveLength(0);

      // 直达路径与认领过期同一终态。
      registry.begin({ taskId: 'unknown_marked', ...SCOPE, request: '重启不可确认' });
      const marked = registry.markResultUnknown('unknown_marked');
      expect(marked.status).toBe('failed');
      expect(marked.reason).toBe('result_unknown');
    });

    it('claimNextQueued：仅认领 queued；原子 running + lease；有效租约不被过期', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'claim_a', ...SCOPE, request: '排队 A', status: 'queued' });
      registry.begin({ taskId: 'claim_b', ...SCOPE, request: '排队 B', status: 'queued' });

      const first = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 });
      expect(first?.taskId).toBe('claim_a');
      expect(first?.status).toBe('running');
      expect(first?.leaseOwner).toBe('runner-1');

      const second = registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 });
      expect(second?.taskId).toBe('claim_b');
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 })).toBeUndefined();

      // running 任务（内联 / 已认领）不再参与认领；有效租约不被 expireLeases 判未知。
      const running = first!;
      expect(running.status).toBe('running');
      expect(registry.expireLeases(new Date().toISOString())).toHaveLength(0);
      expect(registry.get('claim_a', SCOPE).status).toBe('running');

      registry.begin({ taskId: 'claim_inline', ...SCOPE, request: '内联运行中' });
      expect(registry.claimNextQueued({ owner: 'runner-1', leaseMs: 60_000 })).toBeUndefined();
    });

    it('归属：越权与不存在同一 TaskOwnershipError（错误类型与消息逐字一致）', () => {
      const registry = impl.make();
      registry.begin({ taskId: 'own_task', ...SCOPE, request: '归属任务' });
      const wrongScope = { principalId: 'wecom:other', sessionId: SCOPE.sessionId };

      const cases: ReadonlyArray<{ name: string; wrong: () => unknown; absent: () => unknown }> = [
        { name: 'get', wrong: () => registry.get('own_task', wrongScope), absent: () => registry.get('own_absent', SCOPE) },
        {
          name: 'transition',
          wrong: () => registry.transition('own_task', 'completed', { scope: wrongScope }),
          absent: () => registry.transition('own_absent', 'completed', { scope: SCOPE }),
        },
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
          name: 'requestCancel',
          wrong: () => registry.requestCancel('own_task', { scope: wrongScope }),
          absent: () => registry.requestCancel('own_absent', { scope: SCOPE }),
        },
        {
          name: 'confirmCancelled',
          wrong: () => registry.confirmCancelled('own_task', { scope: wrongScope }),
          absent: () => registry.confirmCancelled('own_absent', { scope: SCOPE }),
        },
        {
          name: 'timeout',
          wrong: () => registry.timeout('own_task', 'execution', { scope: wrongScope }),
          absent: () => registry.timeout('own_absent', 'execution', { scope: SCOPE }),
        },
        {
          name: 'markResultUnknown',
          wrong: () => registry.markResultUnknown('own_task', { scope: wrongScope }),
          absent: () => registry.markResultUnknown('own_absent', { scope: SCOPE }),
        },
      ];

      for (const testCase of cases) {
        const wrongError = capture(testCase.wrong);
        const absentError = capture(testCase.absent);
        expect(wrongError, `${testCase.name} 越权应拒绝`).toBeInstanceOf(TaskOwnershipError);
        expect(absentError, `${testCase.name} 不存在应拒绝`).toBeInstanceOf(TaskOwnershipError);
        expect((wrongError as Error).message, `${testCase.name} 越权/不存在同错`).toBe((absentError as Error).message);
      }

      // 拒绝不得改变状态。
      expect(registry.get('own_task', SCOPE).status).toBe('running');
    });

    it('onTaskFact：单回调注入；每次成功状态变化一条事实；拒绝转换零事实；重复注入替换', () => {
      const registry = impl.make();
      const firstFacts: TaskFact[] = [];
      const secondFacts: TaskFact[] = [];
      registry.onTaskFact((fact) => firstFacts.push(fact));

      registry.begin({ taskId: 'fact_task', ...SCOPE, request: '事实钩子任务' });
      registry.waitForUser('fact_task', QUESTION);
      registry.answerResumes('fact_task');
      registry.requestCancel('fact_task');
      registry.confirmCancelled('fact_task');
      expect(() => registry.transition('fact_task', 'running')).toThrow(TaskTransitionError);

      expect(firstFacts.map((fact) => ({
        from: fact.from,
        to: fact.to,
        reason: fact.reason,
      }))).toEqual([
        { from: undefined, to: 'running', reason: undefined },
        { from: 'running', to: 'waiting_user', reason: undefined },
        { from: 'waiting_user', to: 'running', reason: undefined },
        { from: 'running', to: 'cancelling', reason: undefined },
        { from: 'cancelling', to: 'cancelled', reason: 'cancelled_by_user' },
      ]);
      for (const fact of firstFacts) {
        expect(fact.taskId).toBe('fact_task');
        expect(typeof fact.taskNo).toBe('number');
        expect(fact.name).not.toBe('');
        expect(Number.isNaN(Date.parse(fact.at))).toBe(false);
        // v1.1：稳定去重版本缺省 = at（P4 outbox 唯一键用）。
        expect(fact.stateVersion).toBe(fact.at);
      }

      // 单回调：再次注入替换旧回调（旧回调不再收到事实）。
      registry.onTaskFact((fact) => secondFacts.push(fact));
      registry.begin({ taskId: 'fact_task_2', ...SCOPE, request: '替换后任务' });
      expect(firstFacts).toHaveLength(5);
      expect(secondFacts.map((fact) => fact.taskId)).toEqual(['fact_task_2']);
    });

    it('TaskFact.stateVersion（v1.1）：每条成功状态变化的事实携带稳定去重版本（缺省=at）', () => {
      const registry = impl.make();
      const facts: TaskFact[] = [];
      registry.onTaskFact((fact) => facts.push(fact));
      registry.begin({ taskId: 'version_task', ...SCOPE, request: '版本任务', status: 'queued' });
      registry.claimNextQueued({ owner: 'runner-v', leaseMs: 1_000 });
      registry.requestCancel('version_task');
      expect(facts.map((fact) => fact.to)).toEqual(['queued', 'running', 'cancelling']);
      for (const fact of facts) {
        expect(fact.stateVersion, `${fact.to} 事实的 stateVersion`).toBe(fact.at);
      }
    });
  });
}

describe('Task Registry 契约核心（SQLite 持久化）', () => {
  it('waiting_user 跨重启保真：pending_question/waiting_since 原样读出，答复续同一 task_no', () => {
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
    expect(reloaded.status).toBe('waiting_user');
    expect(reloaded.pendingQuestion).toEqual(QUESTION);
    expect(reloaded.waitingSince).toBe(waitingSince);
    expect(reloaded.taskNo).toBe(taskNo);

    second.answerResumes('persist_wait');
    second.noteExecution('persist_wait', { requestId: 'req_persist_2', operation: 'dummy.query', status: 'completed' });
    second.transition('persist_wait', 'completed');
    const done = second.get('persist_wait', SCOPE);
    expect(done.status).toBe('completed');
    expect(done.taskNo).toBe(taskNo);
    expect(done.executions.map((execution) => execution.requestId)).toEqual(['req_persist_1', 'req_persist_2']);
    expect(second.list(SCOPE)).toHaveLength(1);
  });

  it('result_unknown 跨重启不自动重放：重开库后仍为终态且不被重新认领', () => {
    const dbPath = tempDbPath();
    const first = sqliteRegistry(dbPath);
    first.begin({ taskId: 'persist_unknown', ...SCOPE, request: '重启恢复', status: 'queued' });
    expect(first.claimNextQueued({ owner: 'runner-old', leaseMs: 0 })?.taskId).toBe('persist_unknown');
    first.close();

    const second = sqliteRegistry(dbPath);
    const expired = second.expireLeases(new Date(Date.now() + 1_000).toISOString());
    expect(expired.map((task) => task.taskId)).toEqual(['persist_unknown']);
    const unknown = second.get('persist_unknown', SCOPE);
    expect(unknown.status).toBe('failed');
    expect(unknown.reason).toBe('result_unknown');
    expect(second.claimNextQueued({ owner: 'runner-new', leaseMs: 60_000 })).toBeUndefined();
  });

  it('取消与超时跨重启保真：cancelling 回滚 / cancelled 终态 / timed_out 保留等待历史', () => {
    const dbPath = tempDbPath();
    const first = sqliteRegistry(dbPath);
    first.begin({ taskId: 'persist_cancelling', ...SCOPE, request: '回滚', status: 'queued' });
    first.requestCancel('persist_cancelling');
    first.begin({ taskId: 'persist_cancelled', ...SCOPE, request: '确认取消' });
    first.requestCancel('persist_cancelled');
    first.confirmCancelled('persist_cancelled');
    first.begin({ taskId: 'persist_timeout', ...SCOPE, request: '等待超时' });
    first.waitForUser('persist_timeout', QUESTION);
    first.timeout('persist_timeout', 'waiting_user');
    first.close();

    const second = sqliteRegistry(dbPath);
    expect(second.get('persist_cancelling', SCOPE).status).toBe('cancelling');
    expect(second.transition('persist_cancelling', 'running').status).toBe('running');
    const cancelled = second.get('persist_cancelled', SCOPE);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reason).toBe('cancelled_by_user');
    const timedOut = second.get('persist_timeout', SCOPE);
    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.reason).toBe('timeout');
    expect(timedOut.pendingQuestion).toEqual(QUESTION);
    expect(timedOut.waitingSince).toBeTruthy();
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
