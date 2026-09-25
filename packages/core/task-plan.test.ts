import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditStore, TaskPlanStepFact } from '@fshine/contracts';
import { closeStore, createSqliteStore, newId } from './src/index';

const DB_MODES = [':memory:', 'file'] as const;
type DbMode = (typeof DB_MODES)[number];

const PRINCIPAL = 'wecom:user_a';
const SESSION = 'wecom:user_a:conv_1';

function makeStep(overrides: Partial<TaskPlanStepFact> = {}): TaskPlanStepFact {
  return {
    factId: newId('fact'),
    principalId: PRINCIPAL,
    sessionId: SESSION,
    planId: newId('plan'),
    stepIndex: 1,
    totalSteps: 3,
    request: '核对幻晟 202608 的科目余额',
    status: 'started',
    createdAt: '2026-09-25T08:00:00.000Z',
    ...overrides,
  };
}

/** 同一 plan 内自增 factId，保证 append 顺序稳定可推。 */
function stepSeq(planId: string, index: number, status: TaskPlanStepFact['status'], overrides: Partial<TaskPlanStepFact> = {}): TaskPlanStepFact {
  return makeStep({ planId, stepIndex: index, status, ...overrides });
}

describe.each(DB_MODES)('taskPlans(dbPath=%s)', (mode) => {
  let dir: string | undefined;
  let dbPath: string;
  let store: AuditStore;

  beforeEach(() => {
    if (mode === ':memory:') {
      dbPath = ':memory:';
    } else {
      dir = mkdtempSync(join(tmpdir(), 'fshine-core-task-plan-'));
      dbPath = join(dir, 'audit.db');
    }
    store = createSqliteStore(dbPath);
  });

  afterEach(() => {
    closeStore(store);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  describe('append', () => {
    it('同 factId 同内容重复追加是 no-op（不产生第二条事实）', async () => {
      const fact = makeStep({ status: 'started' });
      await store.taskPlans.append(fact);
      await store.taskPlans.append(fact);

      const projection = await store.taskPlans.project(PRINCIPAL, SESSION, fact.planId);
      expect(projection?.started).toBe(1);
      expect(projection?.steps).toHaveLength(1);
      expect(projection?.updatedAt).toBe(fact.createdAt);
    });

    it('同一 factId 不允许被不同内容覆盖', async () => {
      const fact = makeStep({ status: 'started' });
      await store.taskPlans.append(fact);

      await expect(store.taskPlans.append({ ...fact, status: 'done' })).rejects.toThrow(/factId/);
      await expect(store.taskPlans.append({ ...fact, summary: '被篡改' })).rejects.toThrow(/factId/);
      await expect(store.taskPlans.append({ ...fact, stepIndex: 2 })).rejects.toThrow(/factId/);

      const projection = await store.taskPlans.project(PRINCIPAL, SESSION, fact.planId);
      expect(projection?.started).toBe(1);
      expect(projection?.done).toBe(0);
      expect(projection?.steps).toEqual([{ stepIndex: 1, status: 'started' }]);
    });

    it('可选字段 taskId/summary 缺省与显式 null 都不落库', async () => {
      const bare = makeStep({ status: 'started' });
      await store.taskPlans.append(bare);
      expect(await store.taskPlans.project(PRINCIPAL, SESSION, bare.planId)).toEqual({
        planId: bare.planId,
        sessionId: SESSION,
        totalSteps: 3,
        started: 1,
        done: 0,
        failed: 0,
        needs: 0,
        steps: [{ stepIndex: 1, status: 'started' }],
        updatedAt: bare.createdAt,
      });
    });

    it('坏输入（缺字段）拒绝写入且不留半条事实', async () => {
      const missing: Array<[string, Partial<TaskPlanStepFact>]> = [
        ['factId', { factId: undefined }],
        ['principalId', { principalId: undefined }],
        ['sessionId', { sessionId: undefined }],
        ['planId', { planId: undefined }],
        ['stepIndex', { stepIndex: undefined }],
        ['totalSteps', { totalSteps: undefined }],
        ['request', { request: undefined }],
        ['status', { status: undefined }],
        ['createdAt', { createdAt: undefined }],
      ];
      for (const [field, patch] of missing) {
        const fact = makeStep({ ...patch });
        await expect(store.taskPlans.append(fact), field).rejects.toThrow();
        expect(await store.taskPlans.project(PRINCIPAL, SESSION, fact.planId), field).toBeNull();
      }
    });
  });

  describe('project', () => {
    it('没有事实返回 null；按 principal/session/plan 三维隔离', async () => {
      expect(await store.taskPlans.project(PRINCIPAL, SESSION, 'plan_missing')).toBeNull();

      const mine = makeStep({ status: 'started' });
      await store.taskPlans.append(mine);
      await store.taskPlans.append(makeStep({ planId: 'plan_other_session', sessionId: 'wecom:user_a:conv_2' }));
      await store.taskPlans.append(makeStep({ planId: 'plan_other_principal', principalId: 'wecom:user_b' }));

      expect(await store.taskPlans.project(PRINCIPAL, SESSION, mine.planId)).not.toBeNull();
      expect(await store.taskPlans.project(PRINCIPAL, SESSION, 'plan_other_session')).toBeNull();
      expect(await store.taskPlans.project('wecom:user_b', SESSION, mine.planId)).toBeNull();
    });

    it('多重试取每个 index 的最后一条事实；totalSteps 取最大；按 status 计数', async () => {
      const planId = 'plan_retry';
      await store.taskPlans.append(stepSeq(planId, 1, 'started', { totalSteps: 3, createdAt: '2026-09-25T08:00:00.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 2, 'started', { totalSteps: 0, createdAt: '2026-09-25T08:00:01.000Z' }));
      // 第 1 步失败后重派：同 index 追加新事实，taskId 由宿主回填
      await store.taskPlans.append(stepSeq(planId, 1, 'failed', { totalSteps: 3, createdAt: '2026-09-25T08:00:02.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 1, 'started', { totalSteps: 3, taskId: 'task_retry', createdAt: '2026-09-25T08:00:03.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 1, 'done', { totalSteps: 3, taskId: 'task_retry', summary: '幻晟 202608 余额已核对', createdAt: '2026-09-25T08:00:04.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 2, 'done', { totalSteps: 4, taskId: 'task_2', createdAt: '2026-09-25T08:00:05.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 3, 'started', { totalSteps: 4, createdAt: '2026-09-25T08:00:06.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 3, 'needs', { totalSteps: 4, taskId: 'task_3', summary: '缺期间，请补充 YYYYMM', createdAt: '2026-09-25T08:00:07.000Z' }));

      expect(await store.taskPlans.project(PRINCIPAL, SESSION, planId)).toEqual({
        planId,
        sessionId: SESSION,
        totalSteps: 4,
        started: 4,
        done: 2,
        failed: 1,
        needs: 1,
        steps: [
          { stepIndex: 1, status: 'done', taskId: 'task_retry', summary: '幻晟 202608 余额已核对' },
          { stepIndex: 2, status: 'done', taskId: 'task_2' },
          { stepIndex: 3, status: 'needs', taskId: 'task_3', summary: '缺期间，请补充 YYYYMM' },
        ],
        updatedAt: '2026-09-25T08:00:07.000Z',
      });
    });

    it('steps 按 stepIndex 升序，乱序 append 也确定', async () => {
      const planId = 'plan_out_of_order';
      await store.taskPlans.append(stepSeq(planId, 3, 'done', { totalSteps: 3 }));
      await store.taskPlans.append(stepSeq(planId, 1, 'done', { totalSteps: 3 }));
      await store.taskPlans.append(stepSeq(planId, 2, 'failed', { totalSteps: 3 }));

      const projection = await store.taskPlans.project(PRINCIPAL, SESSION, planId);
      expect(projection?.steps.map((step) => step.stepIndex)).toEqual([1, 2, 3]);
      expect(projection?.steps.map((step) => step.status)).toEqual(['done', 'failed', 'done']);
    });

    it('同一 index 的旧事实被新事实覆盖（含 taskId 回填与摘要变化）', async () => {
      const planId = 'plan_backfill';
      await store.taskPlans.append(stepSeq(planId, 1, 'started', { createdAt: '2026-09-25T09:00:00.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 1, 'started', { taskId: 'task_late', createdAt: '2026-09-25T09:00:01.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 1, 'done', { taskId: 'task_late', summary: '完成', createdAt: '2026-09-25T09:00:02.000Z' }));

      expect((await store.taskPlans.project(PRINCIPAL, SESSION, planId))?.steps).toEqual([
        { stepIndex: 1, status: 'done', taskId: 'task_late', summary: '完成' },
      ]);
    });
  });

  describe('latestOpenPlan', () => {
    it('空会话返回 null', async () => {
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
    });

    it('有悬挂步骤 → 该 planId', async () => {
      const planId = 'plan_open';
      await store.taskPlans.append(stepSeq(planId, 1, 'done'));
      await store.taskPlans.append(stepSeq(planId, 2, 'started'));

      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);
    });

    it('全终态（done/failed/needs）→ null', async () => {
      const planId = 'plan_closed';
      await store.taskPlans.append(stepSeq(planId, 1, 'started'));
      await store.taskPlans.append(stepSeq(planId, 1, 'done'));
      await store.taskPlans.append(stepSeq(planId, 2, 'started'));
      await store.taskPlans.append(stepSeq(planId, 2, 'failed'));
      await store.taskPlans.append(stepSeq(planId, 3, 'started'));
      await store.taskPlans.append(stepSeq(planId, 3, 'needs', { summary: '缺账套' }));

      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
    });

    it('只返回最近一个未完成计划，旧计划全终态不回溯', async () => {
      const older = 'plan_older_closed';
      const newer = 'plan_newer_open';
      await store.taskPlans.append(stepSeq(older, 1, 'started'));
      await store.taskPlans.append(stepSeq(older, 1, 'done'));
      await store.taskPlans.append(stepSeq(newer, 1, 'started'));
      await store.taskPlans.append(stepSeq(newer, 2, 'started'));

      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(newer);

      await store.taskPlans.append(stepSeq(newer, 1, 'done'));
      await store.taskPlans.append(stepSeq(newer, 2, 'needs', { summary: '缺期间' }));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
    });

    it('同 index 只要出现过终态事实即视为关闭（钉死语义：同 index 没有终态事实才算悬挂）', async () => {
      const planId = 'plan_terminal_wins';
      await store.taskPlans.append(stepSeq(planId, 1, 'started'));
      await store.taskPlans.append(stepSeq(planId, 1, 'done'));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();

      // 之后再 started 也不会重开：该 index 已有终态事实
      await store.taskPlans.append(stepSeq(planId, 1, 'started'));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();

      // 全新 index 的 started 才构成悬挂
      await store.taskPlans.append(stepSeq(planId, 2, 'started'));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);
    });

    it('只扫本 principal 本会话，他人会话不泄漏', async () => {
      const foreign = 'plan_foreign';
      await store.taskPlans.append(stepSeq(foreign, 1, 'started', { sessionId: 'wecom:user_a:conv_2' }));
      await store.taskPlans.append(stepSeq(foreign, 1, 'started', { principalId: 'wecom:user_b' }));
      await store.taskPlans.append(stepSeq('plan_mine', 1, 'done'));

      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
      expect(await store.taskPlans.latestOpenPlan('wecom:user_b', SESSION)).toBe(foreign);
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, 'wecom:user_a:conv_2')).toBe(foreign);
    });
  });

  describe('投影与 facts 的一致性', () => {
    it('乱序 status 写入后，重建结果确定且可重复', async () => {
      const planId = 'plan_scrambled';
      // 乱序：status 与 createdAt 都不按 index 走，唯一权威是 append 顺序
      const facts: TaskPlanStepFact[] = [
        stepSeq(planId, 2, 'started', { totalSteps: 2, createdAt: '2026-09-25T10:00:03.000Z' }),
        stepSeq(planId, 4, 'started', { totalSteps: 5, createdAt: '2026-09-25T10:00:01.000Z' }),
        stepSeq(planId, 2, 'failed', { totalSteps: 2, createdAt: '2026-09-25T10:00:05.000Z' }),
        stepSeq(planId, 2, 'started', { totalSteps: 2, taskId: 'task_2b', createdAt: '2026-09-25T10:00:02.000Z' }),
        stepSeq(planId, 4, 'done', { totalSteps: 5, taskId: 'task_4', summary: '完成', createdAt: '2026-09-25T10:00:06.000Z' }),
        stepSeq(planId, 1, 'started', { totalSteps: 2, createdAt: '2026-09-25T10:00:00.000Z' }),
        stepSeq(planId, 1, 'done', { totalSteps: 2, taskId: 'task_1', createdAt: '2026-09-25T10:00:04.000Z' }),
      ];
      for (const fact of facts) await store.taskPlans.append(fact);

      const expected = {
        planId,
        sessionId: SESSION,
        totalSteps: 5,
        started: 4,
        done: 2,
        failed: 1,
        needs: 0,
        steps: [
          { stepIndex: 1, status: 'done' as const, taskId: 'task_1' },
          { stepIndex: 2, status: 'started' as const, taskId: 'task_2b' },
          { stepIndex: 4, status: 'done' as const, taskId: 'task_4', summary: '完成' },
        ],
        updatedAt: '2026-09-25T10:00:04.000Z',
      };
      expect(await store.taskPlans.project(PRINCIPAL, SESSION, planId)).toEqual(expected);
      // 重复重建必须逐字节一致（投影是纯函数）
      expect(await store.taskPlans.project(PRINCIPAL, SESSION, planId)).toEqual(expected);
      // 三个 index 都出现过终态事实 → 无悬挂
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
      // 追加一个全新 index 的 started 才构成悬挂
      await store.taskPlans.append(stepSeq(planId, 5, 'started', { totalSteps: 5, createdAt: '2026-09-25T10:00:07.000Z' }));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);
    });

    it('跨回合续跑：同一 planId 继续追加事实，投影只增不减', async () => {
      const planId = 'plan_resume';
      await store.taskPlans.append(stepSeq(planId, 1, 'started', { totalSteps: 3 }));
      await store.taskPlans.append(stepSeq(planId, 2, 'started', { totalSteps: 3 }));
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);

      // 下一回合：宿主拿到同一 planId，补第 2 步与第 3 步
      await store.taskPlans.append(stepSeq(planId, 2, 'done', { totalSteps: 3, taskId: 'task_2', createdAt: '2026-09-25T11:00:00.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 3, 'started', { totalSteps: 3, createdAt: '2026-09-25T11:00:01.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 3, 'done', { totalSteps: 3, taskId: 'task_3', createdAt: '2026-09-25T11:00:02.000Z' }));
      await store.taskPlans.append(stepSeq(planId, 1, 'done', { totalSteps: 3, taskId: 'task_1', createdAt: '2026-09-25T11:00:03.000Z' }));

      const projection = await store.taskPlans.project(PRINCIPAL, SESSION, planId);
      expect(projection?.steps.map((step) => step.status)).toEqual(['done', 'done', 'done']);
      expect(projection?.updatedAt).toBe('2026-09-25T11:00:03.000Z');
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBeNull();
    });
  });
});

describe('taskPlans 文件库持久化', () => {
  it('关闭后重新打开，投影由 append-only 事实重建如初', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fshine-core-task-plan-file-'));
    const dbPath = join(dir, 'audit.db');
    const planId = 'plan_persisted';
    let store: AuditStore | undefined;
    try {
      store = createSqliteStore(dbPath);
      const first = makeStep({ planId, stepIndex: 1, status: 'started', createdAt: '2026-09-25T12:00:00.000Z' });
      const second = makeStep({ planId, stepIndex: 1, status: 'done', taskId: 'task_1', createdAt: '2026-09-25T12:00:01.000Z' });
      const third = makeStep({ planId, stepIndex: 2, status: 'started', createdAt: '2026-09-25T12:00:02.000Z' });
      await store.taskPlans.append(first);
      await store.taskPlans.append(second);
      await store.taskPlans.append(third);
      const before = await store.taskPlans.project(PRINCIPAL, SESSION, planId);
      expect(await store.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);
      closeStore(store);
      store = undefined;

      const reopened = createSqliteStore(dbPath);
      try {
        expect(await reopened.taskPlans.project(PRINCIPAL, SESSION, planId)).toEqual(before);
        expect(await reopened.taskPlans.latestOpenPlan(PRINCIPAL, SESSION)).toBe(planId);
        // 重开后 append-only 约束不变：同 factId 同内容仍 no-op，不同内容仍报错
        await reopened.taskPlans.append(second);
        expect((await reopened.taskPlans.project(PRINCIPAL, SESSION, planId))?.done).toBe(1);
        await expect(reopened.taskPlans.append({ ...second, status: 'failed' })).rejects.toThrow(/factId/);
      } finally {
        closeStore(reopened);
      }
    } finally {
      if (store) closeStore(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
