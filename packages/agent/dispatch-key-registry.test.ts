/**
 * U3 稳定逻辑操作身份：底账语义（内存 / SQLite 两实现逐项一致）。
 *
 * 这些用例只碰 registry（零网络、零模型），钉住：
 *   · 两笔参数完全相同的合法操作 = 两行两 key、各执行一次（禁止按内容合并）；
 *   · 重放窗口内恰一笔同名操作 → 读回同一行（不重铸身份）、返回已有结果；
 *   · 窗口内 ≥2 笔同名 / 单笔未定论 → 待核对（不猜绑定、不重放未知结果）；
 *   · 同 Key 同操作 → 回放；同 Key 不同操作 → dispatch_conflict；
 *   · 进行中的重复认领 → in_progress（不并发执行）；
 *   · 读操作（只读集合内）可安全重发，不被 key 逻辑误挡；
 *   · 崩溃窗口（claim 后未 settle）之后绝不二次执行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from './src/task-registry-sqlite';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COMPLETED: ExecutionOutcome = { status: 'completed', data: { rows: 3 } };

function sqliteRegistry(): SqliteTaskRegistry {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dispatch-key-'));
  tempDirs.push(dir);
  return createSqliteTaskRegistry(path.join(dir, 'state.db'));
}

const implementations: ReadonlyArray<readonly [string, () => TaskRegistry & { close?: () => void }]> = [
  ['memory', () => createTaskRegistry()],
  ['sqlite', sqliteRegistry],
];

for (const [name, make] of implementations) {
  describe(`逻辑操作账（${name}）`, () => {
    it('参数完全相同的两条合法操作：两行两 key、各自认领（不合并）', () => {
      const registry = make();
      const first = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 1 });
      const second = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 1 });

      expect(first.kind).toBe('minted');
      expect(second.kind).toBe('minted');
      if (first.kind !== 'minted' || second.kind !== 'minted') throw new Error('unreachable');
      expect(first.dispatchKey).not.toBe(second.dispatchKey);
      expect(first.opSeq).toBe(1);
      expect(second.opSeq).toBe(2);
      expect(registry.getOperation(first.dispatchKey)?.operation).toBe('dummy.commit');
      expect(registry.getOperation(second.dispatchKey)?.operation).toBe('dummy.commit');
      registry.close?.();
    });

    it('窗口内恰一笔同名操作：读回同一行并回放已有结果（不重铸身份、不第二次执行）', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(minted.dispatchKey, COMPLETED);

      // 恢复后的新调用：attempt=4，重放窗口=2（被运行时丢弃的那次尝试）。
      const replayed = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 4,
        replayWindow: 2,
      });
      expect(replayed.kind).toBe('replayed');
      if (replayed.kind !== 'replayed') throw new Error('unreachable');
      expect(replayed.dispatchKey).toBe(minted.dispatchKey);
      expect(replayed.outcome).toEqual(COMPLETED);
      registry.close?.();
    });

    it('窗口内两笔同名操作：无法证明映射 → 待核对（两行都落 unknown，不猜）', () => {
      const registry = make();
      const first = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      const second = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (first.kind !== 'minted' || second.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(first.dispatchKey, COMPLETED);

      const claim = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 4,
        replayWindow: 2,
      });
      expect(claim.kind).toBe('unresolved');
      if (claim.kind !== 'unresolved') throw new Error('unreachable');
      expect(claim.reason).toBe('ambiguous_replay');
      // 已落定的执行事实保留（不洗白/不篡改）；未定论的那笔落 unknown（待核对）。
      expect(registry.getOperation(first.dispatchKey)?.status).toBe('completed');
      expect(registry.getOperation(second.dispatchKey)?.status).toBe('unknown');
      // 第三笔无法证明绑定：不得铸造第三行（放弃执行而不是猜一个身份）。
      expect(registry.getOperation('dk_task:t1:3')).toBeUndefined();
      registry.close?.();
    });

    it('deliveredAt：只在落定时写入（= settledAt）；claimed/unknown 保持 NULL（不冒充已交付）', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      // 已认领未落定：结果还没交给 Pi 回合。
      expect(registry.getOperation(minted.dispatchKey)?.deliveredAt).toBeUndefined();

      registry.settleOperation(minted.dispatchKey, COMPLETED);
      const settled = registry.getOperation(minted.dispatchKey);
      expect(settled?.deliveredAt).toBeTruthy();
      expect(settled?.deliveredAt).toBe(settled?.settledAt);

      // 结果未知（无回执）不走 settle：deliveredAt 必须保持 NULL。
      const interrupted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 3 });
      if (interrupted.kind !== 'minted') throw new Error('unreachable');
      registry.markOperationUnknown(interrupted.dispatchKey, 'call_interrupted');
      const unknown = registry.getOperation(interrupted.dispatchKey);
      expect(unknown?.status).toBe('unknown');
      expect(unknown?.deliveredAt).toBeUndefined();
      registry.close?.();
    });

    it('窗口内单笔同名但仍在执行：返回 in_progress，绝不并发执行', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (minted.kind !== 'minted') throw new Error('unreachable');

      const again = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 3,
        replayWindow: 2,
      });
      expect(again.kind).toBe('in_progress');
      if (again.kind !== 'in_progress') throw new Error('unreachable');
      expect(again.dispatchKey).toBe(minted.dispatchKey);
      registry.close?.();
    });

    it('窗口内两笔不同名操作调换顺序：各自按名绑定，零新行', () => {
      const registry = make();
      const query = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.query', attempt: 2 });
      const commit = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (query.kind !== 'minted' || commit.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(query.dispatchKey, COMPLETED);
      registry.settleOperation(commit.dispatchKey, COMPLETED);

      // 重试把顺序调换了：commit 先、query 后。
      const commitAgain = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 3,
        replayWindow: 2,
      });
      const queryAgain = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.query',
        attempt: 3,
        replayWindow: 2,
      });
      expect(commitAgain.kind).toBe('replayed');
      expect(queryAgain.kind).toBe('replayed');
      if (commitAgain.kind !== 'replayed' || queryAgain.kind !== 'replayed') throw new Error('unreachable');
      expect(commitAgain.dispatchKey).toBe(commit.dispatchKey);
      expect(queryAgain.dispatchKey).toBe(query.dispatchKey);
      registry.close?.();
    });

    it('同 Key 同操作 → 回放；同 Key 不同操作 → dispatch_conflict（零写入）', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 1 });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(minted.dispatchKey, COMPLETED);

      const same = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 9,
        dispatchKey: minted.dispatchKey,
      });
      expect(same.kind).toBe('replayed');

      const conflict = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.query',
        attempt: 9,
        dispatchKey: minted.dispatchKey,
      });
      expect(conflict.kind).toBe('conflict');
      if (conflict.kind !== 'conflict') throw new Error('unreachable');
      expect(conflict.reason).toBe('operation_mismatch');
      expect(registry.getOperation(minted.dispatchKey)?.operation).toBe('dummy.commit');
      expect(registry.getOperation(minted.dispatchKey)?.status).toBe('completed');
      registry.close?.();
    });

    it('崩溃窗口（claim 后未落定）：行留 claimed；后续同名调用只得到待核对，绝不二次执行', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (minted.kind !== 'minted') throw new Error('unreachable');

      const retry = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 4,
        replayWindow: 2,
      });
      expect(retry.kind).toBe('in_progress');
      expect(registry.getOperation(minted.dispatchKey)?.status).toBe('claimed');
      registry.close?.();
    });

    it('外部结果未知：落 unknown 后同窗口重试 → 待核对（不重放未知结果、不自动重试）', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(minted.dispatchKey, {
        status: 'failed',
        error: { code: 'result_unknown', message: '外部无回执', retryable: false },
      });
      expect(registry.getOperation(minted.dispatchKey)?.status).toBe('unknown');

      const retry = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.commit',
        attempt: 4,
        replayWindow: 2,
      });
      expect(retry.kind).toBe('unresolved');
      if (retry.kind !== 'unresolved') throw new Error('unreachable');
      expect(retry.reason).toBe('prior_unknown');
      registry.close?.();
    });

    it('读操作（只读集合内）在窗口内可安全重发：同一 dispatchKey、不返回待核对', () => {
      const registry = make();
      const minted = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.query',
        attempt: 2,
        readOnly: true,
      });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      registry.settleOperation(minted.dispatchKey, COMPLETED);

      const retry = registry.claimOperation({
        scopeKey: 'task:t1',
        operation: 'dummy.query',
        attempt: 4,
        replayWindow: 2,
        readOnly: true,
      });
      // 同一逻辑读身份被重新认领（身份不变），调用方可以再执行一次，不被误挡。
      expect(retry.kind).toBe('minted');
      if (retry.kind !== 'minted') throw new Error('unreachable');
      expect(retry.reclaimed).toBe(true);
      expect(retry.dispatchKey).toBe(minted.dispatchKey);
      expect(registry.getOperation(minted.dispatchKey)?.status).toBe('claimed');
      registry.close?.();
    });

    it('并发/连续认领：作用域内序号严格递增不重号，跨作用域互不影响', () => {
      const registry = make();
      const keys = new Set<string>();
      for (let index = 0; index < 5; index += 1) {
        const claim = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 1 });
        if (claim.kind !== 'minted') throw new Error('unreachable');
        expect(claim.opSeq).toBe(index + 1);
        expect(keys.has(claim.dispatchKey)).toBe(false);
        keys.add(claim.dispatchKey);
      }
      const other = registry.claimOperation({ scopeKey: 'task:t2', operation: 'dummy.commit', attempt: 1 });
      if (other.kind !== 'minted') throw new Error('unreachable');
      expect(other.opSeq).toBe(1);
      expect(keys.has(other.dispatchKey)).toBe(false);
      registry.close?.();
    });

    it('身份键由持久化字段派生（dk_<scope>:<seq>），身份只在首次创建时铸造', () => {
      const registry = make();
      const minted = registry.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 1 });
      if (minted.kind !== 'minted') throw new Error('unreachable');
      expect(minted.dispatchKey).toBe(`dk_task:t1:${minted.opSeq}`);
      expect(registry.getOperation(minted.dispatchKey)?.dispatchKey).toBe(minted.dispatchKey);
      registry.close?.();
    });
  });
}

describe('逻辑操作账（sqlite）：关库重开后身份仍在', () => {
  it('同一 dispatchKey 跨进程/重开可读回；窗口重放仍命中同一行', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dispatch-key-reopen-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');

    const first = createSqliteTaskRegistry(dbPath);
    const minted = first.claimOperation({ scopeKey: 'task:t1', operation: 'dummy.commit', attempt: 2 });
    if (minted.kind !== 'minted') throw new Error('unreachable');
    first.settleOperation(minted.dispatchKey, COMPLETED);
    first.close();

    const reopened = createSqliteTaskRegistry(dbPath);
    expect(reopened.getOperation(minted.dispatchKey)?.status).toBe('completed');
    const replayed = reopened.claimOperation({
      scopeKey: 'task:t1',
      operation: 'dummy.commit',
      attempt: 3,
      replayWindow: 2,
    });
    expect(replayed.kind).toBe('replayed');
    if (replayed.kind !== 'replayed') throw new Error('unreachable');
    expect(replayed.dispatchKey).toBe(minted.dispatchKey);
    reopened.close();
  });
});
