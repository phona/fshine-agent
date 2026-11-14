/**
 * P5 资源许可与强制：契约矩阵测试（TDD：先红 → 最小实现转绿 → 反向绊线）。
 *
 * 冻结面：`docs/product/r4-joint-interfaces.md` §2（acquire/release/cancelQueued/
 * snapshot/budgetFor；拒绝 reason ∈ queue_full/quota_exceeded/budget_exhausted/depth_exceeded；
 * 前台与后台配额独立；子 Worker 共享父任务预算，不复制/不放大；token 仅可验证时启用）。
 *
 * 测试用假时钟（纯逻辑，无 IO）：时间、并发、队列、预算全部确定性可断言。
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  DEFAULT_RUNTIME_CONFIG,
  RESOURCE_LIMITED_REASON,
  createResourcePolicy,
  resolveRuntimeConfig,
  taskFailureReasonFor,
  type Permit,
  type Rejection,
  type ResourcePolicy,
} from './src/resource-policy';

let nowMs = 1_000_000;
const clock = (): number => nowMs;
/** 推进假时钟并返回当前时刻。 */
function advance(ms: number): number {
  nowMs += ms;
  return nowMs;
}

function makePolicy(config?: RuntimeConfig): ResourcePolicy {
  return createResourcePolicy(config, { now: clock });
}

function admit(result: Permit | Rejection): Permit {
  if (!result.ok) throw new Error(`预期许可，实际拒绝：${result.reason}（${result.message}）`);
  return result;
}

function refused(result: Permit | Rejection): Rejection {
  if (result.ok) throw new Error(`预期拒绝，实际发放许可：${result.taskId}`);
  return result;
}

describe('resolveRuntimeConfig：缺省 = 现行为，非法 fail-fast（不静默回落）', () => {
  it('缺省：单并发 / 无队列 / 无任务级预算 / 回合时限沿用执行侧现缺省', () => {
    expect(resolveRuntimeConfig()).toEqual({
      mainConcurrency: 1,
      backgroundConcurrency: 1,
      queueCapacity: 0,
      mainTurnMs: 300_000,
      workerTurnMs: 180_000,
      maxDelegationDepth: 1,
      taskBudget: null,
      waitUserTimeoutMs: 86_400_000,
    });
  });

  it('显式值覆盖对应字段，其余回落缺省', () => {
    const resolved = resolveRuntimeConfig({
      mainConcurrency: 2,
      queueCapacity: 3,
      taskBudget: { ms: 1_000, calls: 5 },
    });
    expect(resolved.mainConcurrency).toBe(2);
    expect(resolved.queueCapacity).toBe(3);
    expect(resolved.taskBudget).toEqual({ ms: 1_000, calls: 5 });
    expect(resolved.backgroundConcurrency).toBe(DEFAULT_RUNTIME_CONFIG.backgroundConcurrency);
    expect(resolved.mainTurnMs).toBe(DEFAULT_RUNTIME_CONFIG.mainTurnMs);
  });

  it('非法数值：fail-fast 并点名 runtime.<key>（静默回落 = 失效限额，必须拒绝）', () => {
    const illegal: ReadonlyArray<[keyof RuntimeConfig, unknown]> = [
      ['mainConcurrency', 0],
      ['mainConcurrency', -1],
      ['mainConcurrency', 1.5],
      ['backgroundConcurrency', -1],
      ['queueCapacity', -1],
      ['mainTurnMs', 0],
      ['workerTurnMs', 1.5],
      ['maxDelegationDepth', -1],
      ['waitUserTimeoutMs', 0],
    ];
    for (const [key, value] of illegal) {
      expect(
        () => resolveRuntimeConfig({ [key]: value } as unknown as RuntimeConfig),
        `${key}=${String(value)}`,
      ).toThrowError(new RegExp(`runtime\\.${key}`));
    }
  });

  it('taskBudget 非法子项 fail-fast（含缺 ms/calls、非正整数、未知键）', () => {
    const badBudget = (value: unknown): RuntimeConfig => ({ taskBudget: value as RuntimeConfig['taskBudget'] });
    expect(() => resolveRuntimeConfig(badBudget({ calls: 3 }))).toThrowError(/runtime\.taskBudget\.ms/);
    expect(() => resolveRuntimeConfig(badBudget({ ms: 100 }))).toThrowError(/runtime\.taskBudget\.calls/);
    expect(() => resolveRuntimeConfig(badBudget({ ms: 0, calls: 1 }))).toThrowError(/runtime\.taskBudget\.ms/);
    expect(() => resolveRuntimeConfig(badBudget({ ms: 1, calls: 1.5 }))).toThrowError(/runtime\.taskBudget\.calls/);
    expect(() => resolveRuntimeConfig(badBudget({ ms: 1, calls: 1, tokens: 0 }))).toThrowError(/runtime\.taskBudget\.tokens/);
    expect(() => resolveRuntimeConfig(badBudget({ ms: 1, calls: 1, tps: 9 }))).toThrowError(/runtime\.taskBudget\.tps/);
  });

  it('0 是合法显式值：backgroundConcurrency=0 关闭后台准入、queueCapacity=0 关闭排队、maxDelegationDepth=0 关闭委派', () => {
    const resolved = resolveRuntimeConfig({ backgroundConcurrency: 0, queueCapacity: 0, maxDelegationDepth: 0 });
    expect(resolved.backgroundConcurrency).toBe(0);
    expect(resolved.queueCapacity).toBe(0);
    expect(resolved.maxDelegationDepth).toBe(0);
  });
});

describe('许可/释放/拒绝矩阵', () => {
  it('前台单并发：第一个 active（深度 0、截止 = now + mainTurnMs），队列容量 0 时第二个 queue_full 确定性拒绝', () => {
    const policy = makePolicy();
    const first = admit(policy.acquire('foreground', { taskId: 'turn-1' }));
    expect(first.state).toBe('active');
    expect(first.kind).toBe('foreground');
    expect(first.depth).toBe(0);
    expect(first.acquiredAt).toBe(nowMs);
    expect(first.deadlineAt).toBe(nowMs + DEFAULT_RUNTIME_CONFIG.mainTurnMs);

    const second = refused(policy.acquire('foreground', { taskId: 'turn-2' }));
    expect(second.reason).toBe('queue_full');
    expect(second.kind).toBe('foreground');
    expect(second.taskId).toBe('turn-2');
    expect(second.message.length).toBeGreaterThan(0);

    const snap = policy.snapshot();
    expect(snap.foreground.active).toBe(1);
    expect(snap.foreground.queued).toBe(0);
    expect(snap.foreground.activeTaskIds).toEqual(['turn-1']);
  });

  it('release 释放槽位；重复 release 幂等；释放后可再次 acquire', () => {
    const policy = makePolicy();
    const first = admit(policy.acquire('foreground', { taskId: 'turn-1' }));
    policy.release(first);
    expect(first.state).toBe('released');
    expect(policy.snapshot().foreground.active).toBe(0);

    policy.release(first); // 幂等：不抛、不重复计数
    expect(policy.snapshot().foreground.active).toBe(0);

    const again = admit(policy.acquire('foreground', { taskId: 'turn-1' }));
    expect(again.state).toBe('active');
    policy.release(again);
  });

  it('并发上限 >1 时逐个占满，满后 queue_full（不进入执行）', () => {
    const policy = makePolicy({ mainConcurrency: 2 });
    const a = admit(policy.acquire('foreground', { taskId: 't-a' }));
    const b = admit(policy.acquire('foreground', { taskId: 't-b' }));
    expect(policy.snapshot().foreground.active).toBe(2);
    expect(refused(policy.acquire('foreground', { taskId: 't-c' })).reason).toBe('queue_full');
    policy.release(a);
    policy.release(b);
    expect(policy.snapshot().foreground.active).toBe(0);
  });

  it('backgroundConcurrency=0：后台准入关闭，确定性 quota_exceeded；前台独立不受影响', () => {
    const policy = makePolicy({ backgroundConcurrency: 0 });
    const refusedBg = refused(policy.acquire('background', { taskId: 'bg-1' }));
    expect(refusedBg.reason).toBe('quota_exceeded');
    const fg = admit(policy.acquire('foreground', { taskId: 'fg-1' }));
    expect(fg.state).toBe('active');
  });

  it('同一任务重复 acquire：确定性拒绝（已有活跃许可），不产生双份计数', () => {
    const policy = makePolicy({ mainConcurrency: 2 });
    admit(policy.acquire('foreground', { taskId: 'dup' }));
    const duplicate = refused(policy.acquire('foreground', { taskId: 'dup' }));
    expect(duplicate.reason).toBe('quota_exceeded');
    expect(policy.snapshot().foreground.active).toBe(1);
  });

  it('未给 taskId 时生成稳定前缀的许可 id（cancelQueued/budgetFor 仍可按 id 使用）', () => {
    const policy = makePolicy({ mainConcurrency: 2 });
    const a = admit(policy.acquire('foreground'));
    const b = admit(policy.acquire('foreground'));
    expect(a.taskId).toMatch(/^permit_/);
    expect(a.taskId).not.toBe(b.taskId);
    expect(policy.budgetFor(a.taskId).taskId).toBe(a.taskId);
  });
});

describe('前后台配额独立', () => {
  it('前台满载不占后台槽；后台满载不占前台槽', () => {
    const policy = makePolicy({ mainConcurrency: 1, backgroundConcurrency: 1, queueCapacity: 0 });
    const fg = admit(policy.acquire('foreground', { taskId: 'fg-1' }));
    const bg = admit(policy.acquire('background', { taskId: 'bg-1' }));
    expect(fg.state).toBe('active');
    expect(bg.state).toBe('active');
    expect(policy.snapshot().foreground.active).toBe(1);
    expect(policy.snapshot().background.active).toBe(1);

    // 各自满：前台新任务 queue_full，后台新任务 queue_full——两条独立队列互不代偿。
    expect(refused(policy.acquire('foreground', { taskId: 'fg-2' })).reason).toBe('queue_full');
    expect(refused(policy.acquire('background', { taskId: 'bg-2' })).reason).toBe('queue_full');
    policy.release(fg);
    policy.release(bg);
  });

  it('后台队列满载不阻塞前台：前台仍可准入（独立队列）', () => {
    const policy = makePolicy({ mainConcurrency: 1, backgroundConcurrency: 1, queueCapacity: 1 });
    admit(policy.acquire('background', { taskId: 'bg-1' })); // active
    admit(policy.acquire('background', { taskId: 'bg-2' })); // queued
    expect(refused(policy.acquire('background', { taskId: 'bg-3' })).reason).toBe('queue_full');

    const fg = admit(policy.acquire('foreground', { taskId: 'fg-1' }));
    expect(fg.state).toBe('active');
    expect(policy.snapshot().foreground.queued).toBe(0);
    expect(policy.snapshot().background.queued).toBe(1);
  });
});

describe('队列容量与 FIFO 晋升（有界等待）', () => {
  it('后台并发 1 + 队列 2：前两个排队，第四个 queue_full；snapshot 报告 limit/active/queued 与任务 id', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 2 });
    const active = admit(policy.acquire('background', { taskId: 'bg-1' }));
    const q1 = admit(policy.acquire('background', { taskId: 'bg-2' }));
    const q2 = admit(policy.acquire('background', { taskId: 'bg-3' }));
    expect(active.state).toBe('active');
    expect(q1.state).toBe('queued');
    expect(q1.deadlineAt).toBeNull();
    expect(q2.state).toBe('queued');
    expect(refused(policy.acquire('background', { taskId: 'bg-4' })).reason).toBe('queue_full');

    const snap = policy.snapshot();
    expect(snap.background).toMatchObject({ limit: 1, active: 1, queued: 2 });
    expect(snap.background.queuedTaskIds).toEqual(['bg-2', 'bg-3']);
  });

  it('release 触发 FIFO 晋升：队首批次 active 并取新截止（等待时间不计入回合时限）', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 2 });
    const active = admit(policy.acquire('background', { taskId: 'bg-1' }));
    const q1 = admit(policy.acquire('background', { taskId: 'bg-2' }));
    const q2 = admit(policy.acquire('background', { taskId: 'bg-3' }));
    const releasedAt = advance(5_000);
    policy.release(active);

    expect(q1.state).toBe('active');
    expect(q1.deadlineAt).toBe(releasedAt + DEFAULT_RUNTIME_CONFIG.workerTurnMs);
    expect(q2.state).toBe('queued');
    expect(policy.snapshot().background.active).toBe(1);
    expect(policy.snapshot().background.queued).toBe(1);
  });

  it('cancelQueued 取消排队许可、腾出队列位；活跃任务与未知任务返回 false', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 1 });
    const active = admit(policy.acquire('background', { taskId: 'bg-1' }));
    const queued = admit(policy.acquire('background', { taskId: 'bg-2' }));

    expect(policy.cancelQueued('bg-1')).toBe(false); // 活跃：取消走 P2/P6 中止 + release
    expect(policy.cancelQueued('bg-unknown')).toBe(false);
    expect(policy.cancelQueued('bg-2')).toBe(true);
    expect(queued.state).toBe('cancelled');
    expect(policy.snapshot().background.queued).toBe(0);

    // 队列位已腾出：新任务可以排队。
    const queuedNext = admit(policy.acquire('background', { taskId: 'bg-3' }));
    expect(queuedNext.state).toBe('queued');
    policy.release(active);
  });

  it('释放排队许可 = 放弃等待（出队，不占槽；不影响活跃）', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 1 });
    const active = admit(policy.acquire('background', { taskId: 'bg-1' }));
    const queued = admit(policy.acquire('background', { taskId: 'bg-2' }));
    policy.release(queued);
    expect(queued.state).toBe('released');
    expect(policy.snapshot().background).toMatchObject({ active: 1, queued: 0 });
    policy.release(active);
  });
});

describe('任务级共享预算（父 → 子派生不复制、不放大）', () => {
  it('budgetFor 返回该任务预算；consume 累计；exhausted 报原因、限额与用量', () => {
    const policy = makePolicy({ taskBudget: { ms: 2_000, calls: 3 } });
    const permit = admit(policy.acquire('background', { taskId: 'task-1' }));
    const budget = policy.budgetFor('task-1');
    expect(budget).toBe(permit.budget);
    expect(budget.limits).toEqual({ ms: 2_000, calls: 3 });
    expect(budget.exhausted()).toBeNull();

    budget.consume({ calls: 2, ms: 500 });
    expect(budget.used).toMatchObject({ calls: 2, ms: 500 });
    expect(budget.exhausted()).toBeNull();

    budget.consume({ calls: 1 });
    expect(budget.exhausted()).toEqual({ reason: 'calls', limit: 3, used: 3 });
  });

  it('父预算耗尽后：时间上限同样触发（reason=ms）', () => {
    const policy = makePolicy({ taskBudget: { ms: 1_000, calls: 100 } });
    const permit = admit(policy.acquire('background', { taskId: 'task-ms' }));
    permit.budget.consume({ ms: 400 });
    expect(permit.budget.exhausted()).toBeNull();
    permit.budget.consume({ ms: 600 });
    expect(permit.budget.exhausted()).toEqual({ reason: 'ms', limit: 1_000, used: 1_000 });
  });

  it('子 Worker 共享父预算：同一对象、子消费父可见；派生不放大', () => {
    const policy = makePolicy({ taskBudget: { ms: 10_000, calls: 4 } });
    const parent = admit(policy.acquire('foreground', { taskId: 'parent' }));
    const child = admit(policy.acquire('background', { taskId: 'child', parentPermit: parent }));
    expect(child.budget).toBe(parent.budget);
    expect(policy.budgetFor('child')).toBe(policy.budgetFor('parent'));
    expect(child.depth).toBe(1);

    child.budget.consume({ calls: 3, ms: 6_000 });
    expect(policy.budgetFor('parent').used).toMatchObject({ calls: 3, ms: 6_000 });
    expect(policy.budgetFor('parent').exhausted()).toBeNull();

    // 子再消费 1 次：父预算耗尽（共享，不是各 4 次）。
    child.budget.consume({ calls: 1 });
    expect(policy.budgetFor('parent').exhausted()).toEqual({ reason: 'calls', limit: 4, used: 4 });
  });

  it('父预算已耗尽：子委派确定性拒绝 budget_exhausted（不产生许可）', () => {
    const policy = makePolicy({ taskBudget: { ms: 1_000, calls: 1 } });
    const parent = admit(policy.acquire('foreground', { taskId: 'parent' }));
    parent.budget.consume({ calls: 1 });
    expect(parent.budget.exhausted()).not.toBeNull();

    const rejected = refused(policy.acquire('background', { taskId: 'child', parentPermit: parent }));
    expect(rejected.reason).toBe('budget_exhausted');
    expect(() => policy.budgetFor('child')).toThrowError(/未知任务预算/);
  });

  it('waiting_user 恢复：release 后同一预算对象继续用（用量不重置），耗尽则拒绝恢复', () => {
    const policy = makePolicy({ taskBudget: { ms: 1_000, calls: 2 } });
    const first = admit(policy.acquire('background', { taskId: 'task-wait' }));
    policy.budgetFor('task-wait').consume({ calls: 1 });
    policy.release(first);

    const resumed = admit(policy.acquire('background', { taskId: 'task-wait' }));
    expect(resumed.budget).toBe(first.budget);
    expect(policy.budgetFor('task-wait').used).toMatchObject({ calls: 1 });

    policy.budgetFor('task-wait').consume({ calls: 1 });
    policy.release(resumed);
    const refusedAfterExhaust = refused(policy.acquire('background', { taskId: 'task-wait' }));
    expect(refusedAfterExhaust.reason).toBe('budget_exhausted');
  });

  it('budgetFor 未知任务 fail-fast（不静默造预算）', () => {
    const policy = makePolicy();
    expect(() => policy.budgetFor('nobody')).toThrowError(/未知任务预算/);
  });

  it('未配置 taskBudget：无任务级限额（现行为），消费仍如实记录', () => {
    const policy = makePolicy();
    const permit = admit(policy.acquire('background', { taskId: 'task-free' }));
    expect(permit.budget.limits).toBeNull();
    permit.budget.consume({ calls: 99, ms: 10_000 });
    expect(permit.budget.exhausted()).toBeNull();
    expect(permit.budget.used).toMatchObject({ calls: 99, ms: 10_000 });
  });
});

describe('委派深度（确定性护栏，不产生半成品）', () => {
  it('一层委派允许（depth 1），二层确定性拒绝 depth_exceeded', () => {
    const policy = makePolicy({ maxDelegationDepth: 1 });
    const root = admit(policy.acquire('foreground', { taskId: 'main-turn' }));
    const child = admit(policy.acquire('background', { taskId: 'worker-1', parentPermit: root }));
    expect(child.depth).toBe(1);

    const rejected = refused(policy.acquire('background', { taskId: 'worker-2', parentPermit: child }));
    expect(rejected.reason).toBe('depth_exceeded');
    expect(() => policy.budgetFor('worker-2')).toThrowError(/未知任务预算/);
  });

  it('maxDelegationDepth=0：任何委派都拒绝（连一层都不产生）', () => {
    const policy = makePolicy({ maxDelegationDepth: 0 });
    const root = admit(policy.acquire('foreground', { taskId: 'main-turn' }));
    expect(refused(policy.acquire('background', { taskId: 'worker-1', parentPermit: root })).reason).toBe('depth_exceeded');
  });

  it('父许可非 active（已释放/排队中）时派生拒绝，不产生许可', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 1 });
    const active = admit(policy.acquire('background', { taskId: 'bg-1' }));
    const queued = admit(policy.acquire('background', { taskId: 'bg-2' }));
    const refusedFromQueued = refused(policy.acquire('background', { taskId: 'w-queued', parentPermit: queued }));
    expect(refusedFromQueued.reason).toBe('quota_exceeded');

    policy.release(active);
    const refusedFromReleased = refused(policy.acquire('background', { taskId: 'w-released', parentPermit: active }));
    expect(refusedFromReleased.reason).toBe('quota_exceeded');
  });

  it('派生许可不占新并发槽：父槽保持唯一占用，后台配额不被放大', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, maxDelegationDepth: 2 });
    const bg = admit(policy.acquire('background', { taskId: 'bg-task' }));
    const child = admit(policy.acquire('background', { taskId: 'bg-worker', parentPermit: bg }));
    expect(child.state).toBe('active');
    expect(policy.snapshot().background.active).toBe(1);
    expect(policy.snapshot().derived).toMatchObject({ active: 1, taskIds: ['bg-worker'] });

    // 后台并发槽仍被根许可占用：另一个根任务不能借子许可的存在偷跑。
    expect(refused(policy.acquire('background', { taskId: 'bg-other' })).reason).toBe('queue_full');

    policy.release(child);
    expect(policy.snapshot().derived.active).toBe(0);
    expect(policy.snapshot().background.active).toBe(1);
  });
});

describe('waiting_user 释放语义（释放执行资源，等待不占回合时限）', () => {
  it('进入等待：release 立即释放槽位；预算保留（历史与用量不丢）', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, taskBudget: { ms: 10_000, calls: 3 } });
    const permit = admit(policy.acquire('background', { taskId: 'task-wait' }));
    policy.budgetFor('task-wait').consume({ calls: 1 });
    policy.release(permit);

    expect(permit.state).toBe('released');
    expect(policy.snapshot().background.active).toBe(0);
    expect(policy.budgetFor('task-wait').used).toMatchObject({ calls: 1 });

    // 同任务可重新入场（等待期间不占并发），等待时长不计入回合时限。
    const resumedAt = advance(60_000);
    const resumed = admit(policy.acquire('background', { taskId: 'task-wait' }));
    expect(resumed.deadlineAt).toBe(resumedAt + DEFAULT_RUNTIME_CONFIG.workerTurnMs);
    expect(resumed.budget).toBe(permit.budget);
  });

  it('等待任务恢复无特权：槽位/队列先到先得，队列满即确定性拒绝', () => {
    const policy = makePolicy({ backgroundConcurrency: 1, queueCapacity: 1 });
    const waiting = admit(policy.acquire('background', { taskId: 'bg-wait' }));
    policy.release(waiting); // 进入 waiting_user：释放槽位、不保留排队位
    expect(policy.snapshot().background).toMatchObject({ active: 0, queued: 0 });

    const newcomer = admit(policy.acquire('background', { taskId: 'bg-new' }));
    expect(newcomer.state).toBe('active');
    const queued = admit(policy.acquire('background', { taskId: 'bg-q' }));
    expect(queued.state).toBe('queued');

    // 恢复请求到达时队列已满：确定性拒绝（不为等待任务预留槽/队列位）。
    expect(refused(policy.acquire('background', { taskId: 'bg-wait' })).reason).toBe('queue_full');

    policy.release(newcomer);
    expect(queued.state).toBe('active');
  });
});

describe('token 预算：仅在可验证时启用，不得伪造硬上限', () => {
  it('未配置 tokens：tokens=unavailable，消费任意 token 不触发耗尽（无假硬上限）', () => {
    const policy = makePolicy({ taskBudget: { ms: 1_000, calls: 10 } });
    const permit = admit(policy.acquire('background', { taskId: 't-no-token' }));
    expect(permit.budget.tokens).toBe('unavailable');
    permit.budget.consume({ tokens: 10_000_000, calls: 1 });
    expect(permit.budget.exhausted()).toBeNull();
    expect(permit.budget.used.tokens).toBe(10_000_000); // 观测如实记录，但不作为强制上限
  });

  it('配置 tokens：tokens=enforced，超限报 reason=tokens', () => {
    const policy = makePolicy({ taskBudget: { ms: 1_000, calls: 10, tokens: 100 } });
    const permit = admit(policy.acquire('background', { taskId: 't-token' }));
    expect(permit.budget.tokens).toBe('enforced');
    permit.budget.consume({ tokens: 60 });
    expect(permit.budget.exhausted()).toBeNull();
    permit.budget.consume({ tokens: 40 });
    expect(permit.budget.exhausted()).toEqual({ reason: 'tokens', limit: 100, used: 100 });
  });
});

describe('snapshot：资源快照（P8 ops / P6 调度读面）', () => {
  it('缺省快照：限额、计数、队列容量与解析后配置齐备', () => {
    const policy = makePolicy();
    const snap = policy.snapshot();
    expect(snap.queueCapacity).toBe(0);
    expect(snap.foreground).toMatchObject({ limit: 1, active: 0, queued: 0 });
    expect(snap.background).toMatchObject({ limit: 1, active: 0, queued: 0 });
    expect(snap.derived).toEqual({ active: 0, taskIds: [] });
    expect(snap.config).toEqual(DEFAULT_RUNTIME_CONFIG);
  });
});

describe('拒绝 reason → 任务原因映射（联合接口约定 §5：resource_limited）', () => {
  it('四类拒绝全部映射到 resource_limited（P5 不写任务状态；集成层据此落库原因）', () => {
    expect(RESOURCE_LIMITED_REASON).toBe('resource_limited');

    const quota = refused(makePolicy({ backgroundConcurrency: 0 }).acquire('background', { taskId: 'q' }));

    const depthPolicy = makePolicy({ maxDelegationDepth: 0 });
    const depthRoot = admit(depthPolicy.acquire('foreground', { taskId: 'depth-root' }));
    const depth = refused(depthPolicy.acquire('background', { taskId: 'd', parentPermit: depthRoot }));

    const budgetPolicy = makePolicy({ taskBudget: { ms: 10, calls: 1 } });
    const budgetRoot = admit(budgetPolicy.acquire('foreground', { taskId: 'budget-root' }));
    budgetPolicy.budgetFor('budget-root').consume({ calls: 1 });
    const budget = refused(budgetPolicy.acquire('background', { taskId: 'b', parentPermit: budgetRoot }));

    const queuePolicy = makePolicy();
    admit(queuePolicy.acquire('foreground', { taskId: 'queue-a' }));
    const queue = refused(queuePolicy.acquire('foreground', { taskId: 'queue-b' }));

    expect([quota.reason, depth.reason, budget.reason, queue.reason].sort())
      .toEqual(['budget_exhausted', 'depth_exceeded', 'queue_full', 'quota_exceeded']);
    for (const rejection of [quota, depth, budget, queue]) {
      expect(taskFailureReasonFor(rejection)).toBe(RESOURCE_LIMITED_REASON);
    }
  });
});
