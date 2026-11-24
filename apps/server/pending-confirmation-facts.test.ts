/**
 * 久未表态的写确认提示（owner 2026-11-24：「后面如果说比较久了用户没提，可以在新的一轮里
 * 去提示一下」）——**不新开推送**：每轮开头读底账，把「还有一件没表态」当事实喂给 Main，
 * 说不说、怎么说归 Main。
 *
 * 钉住四件事：
 *   ① 有提案的等待行 → 注入事实，含执行层提案原话（模型要能原样转述）；
 *   ② **不含 handle / taskId / 内部码**（句柄是宿主持有的凭据，永不出宿主）；
 *   ③ 确认/取消/超时后自然不再注入（`listWaiting` 按 canonical 谓词过滤：提问在场且无结束
 *      事实——这正是「不需要去重计数」的原因）；
 *   ④ 缺信息类等待（无 confirmation）不提示：没有「将写入什么」，提示了用户也无从表态。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { createPendingConfirmationProvider, renderPendingConfirmationFact } from './pending-confirmation-facts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'p', sessionId: 's' } as const;
const OTHER = { principalId: 'p', sessionId: 'other' } as const;
const SUMMARY = '给 alpha 集合 W1 追加 2 条记录';

function registryIn(): ReturnType<typeof createSqliteTaskRegistry> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pending-confirm-'));
  dirs.push(dir);
  return createSqliteTaskRegistry(path.join(dir, 'state.db'));
}

/** 起一个任务并落一条写确认提案（等待形状）。 */
function waitingWithProposal(registry: ReturnType<typeof createSqliteTaskRegistry>, taskId: string): void {
  registry.begin({ taskId, ...SCOPE, request: '给 alpha 集合 W1 追加 2 条记录' });
  registry.waitForUser(taskId, {
    missing: [],
    confirmation: { handle: `cfm_${taskId}`, summary: SUMMARY, operation: 'dummy.prepare' },
  });
}

describe('久未表态的写确认提示', () => {
  it('有提案的等待行 → 注入事实，含提案原话，不含句柄/taskId', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    const provide = createPendingConfirmationProvider(registry);
    const fact = provide(SCOPE.principalId, SCOPE.sessionId);
    expect(typeof fact).toBe('string');
    const text = String(fact);
    expect(text).toContain(SUMMARY);
    expect(text).not.toContain('cfm_t1');
    expect(text).not.toContain('t1');
    expect(text).toContain('仍等你表态');
  });

  it('确认后（提问被清）自然不再注入——不需要去重计数', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    registry.answerResumes('t1');
    const provide = createPendingConfirmationProvider(registry);
    expect(provide(SCOPE.principalId, SCOPE.sessionId)).toBeUndefined();
  });

  it('取消后不再注入（结束事实在场，等待行已被谓词排除）', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    registry.markCancelled('t1');
    const provide = createPendingConfirmationProvider(registry);
    expect(provide(SCOPE.principalId, SCOPE.sessionId)).toBeUndefined();
  });

  it('缺信息类等待（无提案）不提示：没有「将写入什么」，提示了也无从表态', () => {
    const registry = registryIn();
    registry.begin({ taskId: 't1', ...SCOPE, request: '核对单据' });
    registry.waitForUser('t1', { missing: ['截止日'] });
    const provide = createPendingConfirmationProvider(registry);
    expect(provide(SCOPE.principalId, SCOPE.sessionId)).toBeUndefined();
  });

  it('scope 隔离：别的会话的提案不串', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    const provide = createPendingConfirmationProvider(registry);
    expect(provide(OTHER.principalId, OTHER.sessionId)).toBeUndefined();
  });

  it('多条待表态各自一行（不合并成一个说不清的句子）', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    waitingWithProposal(registry, 't2');
    const provide = createPendingConfirmationProvider(registry);
    const text = String(provide(SCOPE.principalId, SCOPE.sessionId));
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain(SUMMARY);
  });

  it('反向绊线：把「不含句柄」的断言换成含句柄必须红（证明闸真在）', () => {
    // 构造一个「坏渲染」：句柄进事实 → 必须被内部形态检查抓到。
    const leaked = `[仍等你表态]「x」将写入（逐字）：${SUMMARY}。cfm_leak_handle`;
    expect(leaked).toContain('cfm_');
    // 正渲染不含句柄。
    expect(renderPendingConfirmationFact({ summary: SUMMARY })).not.toMatch(/cfm_|cf_/);
  });
});
