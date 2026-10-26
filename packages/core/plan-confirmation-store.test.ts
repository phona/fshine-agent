import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqlitePendingPlanConfirmationRepo } from './src/plan-confirmation-store';
import type { PendingPlanConfirmationRecord } from '../agent/src/plan-confirmation';

const nowMs = Date.parse('2026-09-24T02:00:00.000Z');
const pending = (overrides: Partial<PendingPlanConfirmationRecord> = {}): PendingPlanConfirmationRecord => ({
  planId: 'plan_1', version: 2, taskId: 'task_1', decision: 'confirm', userText: '扩大查询范围，预计约一分钟。',
  evaluation: {} as never, principalId: 'wecom:user_a', sessionId: 'chat_a', expiresAt: '2026-09-24T03:00:00.000Z',
  ...overrides,
});
const evidence = (overrides: Partial<{ messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }> = {}) => ({
  messageId: 'msg_1', principalId: 'wecom:user_a', sessionId: 'chat_a', text: '确认继续', receivedAt: '2026-09-24T02:00:00.000Z',
  ...overrides,
});

describe('SQLite pending plan confirmation repository', () => {
  let directory: string | undefined;
  let repos: Array<ReturnType<typeof createSqlitePendingPlanConfirmationRepo>> = [];
  const open = (options: { leaseMs?: number; beforeFinalize?: () => void } = {}) => {
    directory ??= mkdtempSync(path.join(tmpdir(), 'fshine-plan-confirm-'));
    const repo = createSqlitePendingPlanConfirmationRepo(path.join(directory, 'agent.db'), {
      now: () => new Date(nowMs), leaseMs: options.leaseMs ?? 1_000, beforeFinalize: options.beforeFinalize,
    });
    repos.push(repo);
    return repo;
  };
  afterEach(() => {
    for (const repo of repos) repo.close();
    repos = [];
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('persists pending scope and plan version across independent connections and close/reopen', async () => {
    const first = open();
    await first.savePending(pending());
    const second = open();
    await expect(second.listPending('wecom:user_a', 'chat_a')).resolves.toMatchObject([
      { planId: 'plan_1', version: 2, principalId: 'wecom:user_a', sessionId: 'chat_a', userText: '扩大查询范围，预计约一分钟。' },
    ]);
    second.close();
    repos = [first];
    first.close();
    repos = [];
    const reopened = open();
    await expect(reopened.listPending('wecom:user_a', 'chat_a')).resolves.toHaveLength(1);
  });

  it('claims once, records the raw message and prevents replay activation', async () => {
    const repo = open();
    await repo.savePending(pending());
    const action = vi.fn(async () => {});
    await expect(repo.resolvePending(pending(), evidence(), 'confirmed', action)).resolves.toBe(true);
    await expect(repo.resolvePending(pending(), evidence({ messageId: 'msg_replay' }), 'confirmed', action)).resolves.toBe(false);
    expect(action).toHaveBeenCalledOnce();
    await expect(repo.getResolution('msg_1')).resolves.toMatchObject({
      planId: 'plan_1', version: 2, principalId: 'wecom:user_a', sessionId: 'chat_a', text: '确认继续', resolution: 'confirmed',
    });
    await expect(repo.listPending('wecom:user_a', 'chat_a')).resolves.toEqual([]);
  });

  it('does not persist a resolution when the asynchronous activation fails, then permits retry', async () => {
    const repo = open();
    await repo.savePending(pending());
    const action = vi.fn().mockRejectedValueOnce(new Error('platform unavailable')).mockResolvedValueOnce(undefined);
    await expect(repo.resolvePending(pending(), evidence(), 'confirmed', action)).rejects.toThrow('platform unavailable');
    await expect(repo.getResolution('msg_1')).resolves.toBeNull();
    await expect(repo.listPending('wecom:user_a', 'chat_a')).resolves.toHaveLength(1);
    await expect(repo.resolvePending(pending(), evidence({ messageId: 'msg_2' }), 'confirmed', action)).resolves.toBe(true);
    await expect(repo.getResolution('msg_2')).resolves.toMatchObject({ version: 2, resolution: 'confirmed' });
  });

  it('expires abandoned claims for crash recovery and serializes concurrent activations', async () => {
    let clockMs = nowMs;
    directory ??= mkdtempSync(path.join(tmpdir(), 'fshine-plan-confirm-'));
    const repo = createSqlitePendingPlanConfirmationRepo(path.join(directory, 'agent.db'), { now: () => new Date(clockMs), leaseMs: 100 });
    repos.push(repo);
    await repo.savePending(pending());
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = repo.resolvePending(pending(), evidence(), 'confirmed', async () => wait);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(repo.resolvePending(pending(), evidence({ messageId: 'msg_2' }), 'confirmed', async () => {})).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);

    await repo.savePending(pending({ planId: 'plan_crashed', version: 1 }));
    const crashClaim = await repo.claimPending(pending({ planId: 'plan_crashed', version: 1 }), evidence({ messageId: 'msg_crash' }));
    expect(crashClaim).toBe(true);
    clockMs += 101;
    await expect(repo.resolvePending(pending({ planId: 'plan_crashed', version: 1 }), evidence({ messageId: 'msg_retry' }), 'confirmed', async () => {})).resolves.toBe(true);
  });

  it('uses planId/version CAS so stale plan versions cannot consume a replacement', async () => {
    const repo = open();
    await repo.savePending(pending({ version: 2 }));
    await repo.savePending(pending({ version: 3, userText: '新版本计划' }));
    const action = vi.fn(async () => {});
    await expect(repo.resolvePending(pending({ version: 2 }), evidence(), 'confirmed', action)).resolves.toBe(false);
    await expect(repo.resolvePending(pending({ version: 3 }), evidence({ messageId: 'msg_v3' }), 'confirmed', action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce();
    await expect(repo.getResolution('msg_v3')).resolves.toMatchObject({ version: 3 });
  });

  it('retries idempotently when platform activation succeeded but local finalize failed', async () => {
    let failCommit = true;
    directory ??= mkdtempSync(path.join(tmpdir(), 'fshine-plan-confirm-'));
    const dbPath = path.join(directory, 'agent.db');
    const repo = createSqlitePendingPlanConfirmationRepo(dbPath, {
      now: () => new Date(nowMs), leaseMs: 1_000,
      beforeFinalize: () => { if (failCommit) throw new Error('local commit failed'); },
    });
    repos.push(repo);
    await repo.savePending(pending());
    const platformActivePlans = new Set<string>();
    const activate = vi.fn(async (plan: PendingPlanConfirmationRecord) => { platformActivePlans.add(`${plan.planId}:${plan.version}`); });
    await expect(repo.resolvePending(pending(), evidence(), 'confirmed', () => activate(pending()))).rejects.toThrow('local commit failed');
    expect(platformActivePlans).toEqual(new Set(['plan_1:2']));
    await expect(repo.getResolution('msg_1')).resolves.toBeNull();

    failCommit = false;
    await expect(repo.resolvePending(pending(), evidence({ messageId: 'msg_retry' }), 'confirmed', () => activate(pending()))).resolves.toBe(true);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(platformActivePlans).toEqual(new Set(['plan_1:2']));
    await expect(repo.getResolution('msg_retry')).resolves.toMatchObject({ planId: 'plan_1', version: 2 });
  });

  it('stores cancellation as an audited resolution without requiring plan activation', async () => {
    const repo = open();
    await repo.savePending(pending());
    await expect(repo.resolvePending(pending(), evidence({ text: '取消' }), 'cancelled', async () => {})).resolves.toBe(true);
    await expect(repo.getResolution('msg_1')).resolves.toMatchObject({ resolution: 'cancelled', text: '取消', version: 2 });
  });

  it('task control invalidates only the selected task pending confirmation without forging consent', async () => {
    const repo = open();
    await repo.savePending(pending());
    await repo.savePending(pending({ planId: 'plan_other', taskId: 'task_other', version: 1 }));
    expect(await repo.cancelTask('wecom:wrong', 'chat_a', 'task_1')).toBe(0);
    expect(await repo.cancelTask('wecom:user_a', 'chat_a', 'task_1')).toBe(1);
    expect(await repo.cancelTask('wecom:user_a', 'chat_a', 'task_1')).toBe(0);
    expect(await repo.listPending('wecom:user_a', 'chat_a')).toMatchObject([{ taskId: 'task_other' }]);
    expect(await repo.resolvePending(pending(), evidence(), 'confirmed', async () => { throw new Error('must not activate cancelled task'); })).toBe(false);
    expect(await repo.getResolution('msg_1')).toBeNull();
  });

  // ── D-124（2026-10-25 登债）：busy 检查与 UPDATE 两步窗口里，另一实例 claim 后可被
  // 翻 cancelled——在途确认被静默丢弃而平台动作可能已执行。修法=UPDATE 自带租约条件
  // （有效租约的行不可被取消路径触及）；跨进程交错无法单进程确定性表征，此测试钉住
  // 对外可观察的租约语义两态。
  it('cancelTask 租约语义：有效租约抛 busy 不动行；租约过期后可取消（D-124）', async () => {
    directory ??= mkdtempSync(path.join(tmpdir(), 'fshine-plan-confirm-'));
    let clockMs = nowMs;
    const repo = createSqlitePendingPlanConfirmationRepo(path.join(directory, 'agent.db'), {
      now: () => new Date(clockMs), leaseMs: 1_000,
    });
    repos.push(repo);
    await repo.savePending(pending());
    await expect(repo.claimPending(pending(), evidence())).resolves.toBe(true);

    // 有效租约（nowMs+1000 > nowMs）：busy 抛错，行保持 processing——确认动作不被打断。
    await expect(repo.cancelTask('wecom:user_a', 'chat_a', 'task_1')).rejects.toThrow('正在执行');

    // 租约过期（时钟推进 2s）：取消成功——过期租约不构成在途保护（与改前
    // "processing 一律可取消"的 UPDATE 语义等价，只是不再有裸窗口）。
    clockMs = nowMs + 2_000;
    await expect(repo.cancelTask('wecom:user_a', 'chat_a', 'task_1')).resolves.toBe(1);
    await expect(repo.listPending('wecom:user_a', 'chat_a')).resolves.toHaveLength(0);
  });
});
