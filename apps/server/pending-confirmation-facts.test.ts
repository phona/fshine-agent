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

  it('执行行原话进事实（提案之后被拒过）——只给事实，不下结论', () => {
    // 2026-11-24 grok major：拒绝原因此前只活在一次性的 notice.report 里，不落底账，
    // 下一轮用户开口时 Main 只看到「将写入」。修法 = 把执行行原话带上（不新增状态）。
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    registry.noteExecution('t1', {
      requestId: 'req_refused',
      operation: 'dummy.commit',
      status: 'refused',
      error: { code: 'GATE_REFUSE', message: '当前权限不允许该写入' },
    });
    const fact = String(createPendingConfirmationProvider(registry)(SCOPE.principalId, SCOPE.sessionId));
    expect(fact).toContain(SUMMARY);
    expect(fact).toContain('refused');
    expect(fact).toContain('GATE_REFUSE');
    expect(fact).toContain('当前权限不允许该写入');
    // 不得把句柄带进事实（宿主持有）。
    expect(fact).not.toContain('cfm_t1');
  });

  it('默认写确认形状（提案 + 同回合 commit 被 CONFIRMATION_REQUIRED 拒）→ 不得被说成「已拒，别再确认」', () => {
    // 2026-11-24 grok blocking：这是**正常**的写确认流程（background-write-confirmation ⑬⑭
    // 已冻：prepare → needs_confirmation → 同回合 commit 被 CONFIRMATION_REQUIRED → 仍落
    // waiting_user、提案仍有效）。宿主若从执行行得出「这笔写已被拒绝，别再当确认问」，
    // Main 会把用户的「确认」带偏。判据：执行行原话在，但**不含任何结论词**。
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    registry.noteExecution('t1', {
      requestId: 'req_gate',
      operation: 'dummy.commit',
      status: 'refused',
      error: { code: 'CONFIRMATION_REQUIRED', message: '本回合没有确认句柄' },
    });
    const fact = String(createPendingConfirmationProvider(registry)(SCOPE.principalId, SCOPE.sessionId));
    expect(fact).toContain('CONFIRMATION_REQUIRED'); // 原话在
    for (const verdict of ['已经被执行层拒绝', '别再当', '不要再问', '已拒绝']) {
      expect(fact, `宿主下了结论：${verdict}`).not.toContain(verdict);
    }
    // 提案本身仍被表述为「还没得到你答复」——没被宿主改写成「已拒」。
    expect(fact).toContain('还没得到你答复');
  });

  it('提案没被拒过 → 事实只含提案，不制造不存在的失败', () => {
    const registry = registryIn();
    waitingWithProposal(registry, 't1');
    const fact = String(createPendingConfirmationProvider(registry)(SCOPE.principalId, SCOPE.sessionId));
    expect(fact).toContain(SUMMARY);
    expect(fact).toContain('还没得到你答复');
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
