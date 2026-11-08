/**
 * 证据链与状态阶梯单测（issue #10 切片 D）。
 *
 * 判据本体（classifyExecutionCall / messageLadderRung / aggregateMetrics /
 * collectIntentFacts / assessEvalIsolation）逐条钉行为，重点三件事：
 *   · 无证据 = INCONCLUSIVE，不是成功（issue 验收标准原话的机械对应）；
 *   · 被拒的审计行给出 invoked + 拒绝原因，且永不升到 completed/verified；
 *   · 安全门 fail-closed：夹具目录外 / 缺 gateway / 审计通道不可用，任一即拒。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStore, createSqliteStore } from '@fshine/core';
import type { AuditStore } from '@fshine/contracts';
import {
  aggregateMetrics,
  classifyExecutionCall,
  collectIntentFacts,
  messageLadderRung,
  collectHostFacts,
  readExecutionAuditLog,
  sessionKeyOfChannel,
} from './evidence';
import { assessEvalIsolation, EvalIsolationRefused, assertEvalIsolation, EVAL_FIXTURE_ROOT, REPO_ROOT } from './safety-gate';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-evidence-'));
  roots.push(root);
  return root;
}

describe('执行层审计日志读取', () => {
  it('路径未设 → null（证据缺席，不得当零调用）', () => {
    expect(readExecutionAuditLog(undefined)).toBeNull();
  });

  it('文件缺失 → 空数组；坏行跳过，被拒行原样保留', () => {
    const root = tempRoot();
    expect(readExecutionAuditLog(path.join(root, 'missing.jsonl'))).toEqual([]);
    const file = path.join(root, 'audit.jsonl');
    writeFileSync(file, [
      JSON.stringify({ mode: 'call', script: 'dummy.query', args: ['--collection', 'alpha'], exitCode: 0 }),
      'not-json-at-all',
      JSON.stringify({ mode: 'call', script: 'dummy.commit', args: [], refused: 'PLAN_REQUIRED' }),
      '',
    ].join('\n'));
    const rows = readExecutionAuditLog(file)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ script: 'dummy.query', exitCode: 0 });
    expect(rows[1]).toMatchObject({ script: 'dummy.commit', refused: 'PLAN_REQUIRED' });
  });
});

describe('状态阶梯（authorized / invoked / completed / verified / delivered / INCONCLUSIVE）', () => {
  it('被拒行：invoked + 拒绝原因，永不升档', () => {
    const entry = classifyExecutionCall({ row: { script: 'dummy.commit', refused: 'PLAN_REQUIRED' }, readbackVerified: true, delivered: true });
    expect(entry.rung).toBe('invoked');
    expect(entry.refusedReason).toBe('PLAN_REQUIRED');
    expect(entry.basis.join(' ')).toContain('refused=PLAN_REQUIRED');
  });

  it('已执行成功行：completed；宿主读回在 → verified；handler 回复在 → delivered', () => {
    // 写类调用（mode=prepare）
    const base = { row: { mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0 } as const, readbackVerified: false, delivered: false };
    expect(classifyExecutionCall(base).rung).toBe('completed');
    expect(classifyExecutionCall({ ...base, readbackVerified: true }).rung).toBe('verified');
    expect(classifyExecutionCall({ ...base, readbackVerified: true, delivered: true }).rung).toBe('delivered');
    // 只有 handler 回复、无读回：停在 completed。delivered 证明的是送达，不是读回——
    // 旧写法让它升到 delivered（排在 verified 之上），等于用户收到一句回复就补齐了
    // 缺失的读回链，把没验证的写呈现得比已验证的更高（PR #21 审查 blocking）。
    expect(classifyExecutionCall({ ...base, delivered: true }).rung).toBe('completed');
  });

  it('读类调用（mode=query）无副作用要读回：exitCode=0 即到 verified', () => {
    const base = { row: { mode: 'query', script: 'dummy.query', exitCode: 0 } as const, readbackVerified: false, delivered: false };
    expect(classifyExecutionCall(base).rung).toBe('verified');
    expect(classifyExecutionCall({ ...base, delivered: true }).rung).toBe('delivered');
    // 读类失败仍不升档：exitCode≠0 → invoked
    expect(classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 1 }, readbackVerified: false, delivered: true }).rung).toBe('invoked');
  });

  it('写类无读回时，送达不把它排到已验证的写之上', () => {
    const noReadback = classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', exitCode: 0 }, readbackVerified: false, delivered: true });
    const withReadback = classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', exitCode: 0 }, readbackVerified: true, delivered: false });
    expect(noReadback.rung).toBe('completed');
    expect(withReadback.rung).toBe('verified');
    // 阶梯序：completed < verified < delivered
    const order = ['invoked', 'authorized', 'completed', 'verified', 'delivered'];
    expect(order.indexOf(noReadback.rung)).toBeLessThan(order.indexOf(withReadback.rung));
  });

  it('exitCode 非零的已执行行：停在 invoked（调用了、没成功；送达的失败回复不升档）', () => {
    const entry = classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 1 }, readbackVerified: false, delivered: true });
    expect(entry.rung).toBe('invoked');
    expect(entry.basis.join(' ')).not.toContain('handler');
  });

  it('零证据 = INCONCLUSIVE（不标成功）', () => {
    expect(messageLadderRung([])).toBe('INCONCLUSIVE');
  });

  it('消息整体阶梯取链上最低档（一行被拒，整条消息到不了 completed）', () => {
    const rung = messageLadderRung([
      classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true }),
      classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', refused: 'commit-token' }, readbackVerified: false, delivered: true }),
    ]);
    expect(rung).toBe('invoked');
  });
});

describe('宿主意图事实（verified 档的写路径证据）', () => {
  it('只读同一条 change_intents 表：读回摘要在 = hasReadback', async () => {
    const dbPath = path.join(tempRoot(), 'store.db');
    const store = createSqliteStore(dbPath);
    const principalId = 'wecom:eval-user';
    await store.changeIntents!.create({
      intentId: 'intent_committed',
      principalId,
      sessionId: principalId,
      proposalId: 'prop_1',
      confirmCodeHash: 'hash-1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // commit 成功路径经 updateStatus 写读回摘要（repo 的 create 不写 result 列）。
    await store.changeIntents!.updateStatus('intent_committed', 'committed', { readBack: { delta: 1, required: 1 } });
    await store.changeIntents!.create({
      intentId: 'intent_pending',
      principalId,
      sessionId: principalId,
      confirmCodeHash: 'hash-2',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const facts = collectIntentFacts(await import('better-sqlite3').then((m) => new m.default(dbPath, { readonly: true })), principalId);
    expect(facts).toHaveLength(2);
    const committed = facts.find((fact) => fact.intentId === 'intent_committed')!;
    expect(committed).toMatchObject({ status: 'committed', proposalId: 'prop_1', hasReadback: true });
    expect(facts.find((fact) => fact.intentId === 'intent_pending')).toMatchObject({ status: 'pending', hasReadback: false });
    closeStore(store);
  });
});

describe('最小聚合指标（通过率 / 干预 / 安全违规 / 耗时 / Token）', () => {
  it('通过率按用例计，被拒行计门拒绝，干预按停点计，token 缺席不造零', () => {
    const refused = classifyExecutionCall({ row: { script: 'dummy.commit', refused: 'commit-token' }, readbackVerified: false, delivered: false });
    const clean = classifyExecutionCall({ row: { script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
    const metrics = aggregateMetrics([
      { caseId: 'c1', pass: true, ladder: [clean], interventionPoints: 0, durationMs: 1200, tokens: 500 },
      { caseId: 'c2', pass: false, ladder: [refused], interventionPoints: 2, durationMs: 800 },
    ]);
    expect(metrics.cases).toBe(2);
    expect(metrics.passed).toBe(1);
    expect(metrics.passRate).toBeCloseTo(0.5);
    expect(metrics.gateRefusals).toBe(1);
    expect(metrics.safetyViolations).toBe(0);
    expect(metrics.interventions).toBe(2);
    expect(metrics.durationMs).toBe(2000);
    expect(metrics.tokens).toBe(500);
  });

  it('空集：通过率 0（不造 100%）', () => {
    expect(aggregateMetrics([])).toMatchObject({ cases: 0, passRate: 0, gateRefusals: 0, safetyViolations: 0 });
  });
});

describe('评测安全门（fail-closed，不静默落真实平台）', () => {
  const auditPath = () => path.join(tempRoot(), 'audit.jsonl');

  it('仓内夹具 + gateway 在 + 审计通道可用 → 放行', () => {
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
      gateway: 'bin/dummy',
    });
    expect(facts.problems).toEqual([]);
    expect(() => assertEvalIsolation(facts, '测试')).not.toThrow();
  });

  it('root 指向仓外（真实执行层 checkout）→ 拒，且点名路径', () => {
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: '/some/real/platform-root',
      gateway: 'bin/real',
    });
    expect(facts.fixtureWithinRepo).toBe(false);
    expect(facts.problems.join('\n')).toContain('不允许把消息打到真实执行层');
    expect(() => assertEvalIsolation(facts, '测试')).toThrow(EvalIsolationRefused);
  });

  it('缺 gateway / 网关文件缺失 → 拒', () => {
    const withoutGateway = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
    });
    expect(withoutGateway.problems.join('\n')).toContain('gateway');
    expect(() => assertEvalIsolation(withoutGateway, '测试')).toThrow(EvalIsolationRefused);

    const withBadGateway = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
      gateway: 'bin/not-there',
    });
    expect(withBadGateway.problems.join('\n')).toContain('网关文件缺失');
  });

  it('EXECUTION_AUDIT_PATH 未设 → 拒（执行层状态无法验证）', () => {
    const facts = assessEvalIsolation({
      env: {},
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
      gateway: 'bin/dummy',
    });
    expect(facts.auditPathSet).toBe(false);
    expect(facts.problems.join('\n')).toContain('EXECUTION_AUDIT_PATH 未设');
    expect(() => assertEvalIsolation(facts, '测试')).toThrow(EvalIsolationRefused);
  });

  it('审计目录不可写（路径撞上已存在的普通文件）→ 探针失败即拒', () => {
    const root = tempRoot();
    const blocked = path.join(root, 'not-a-dir');
    writeFileSync(blocked, 'occupied');
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: path.join(blocked, 'audit.jsonl') },
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
      gateway: 'bin/dummy',
    });
    expect(facts.auditUsable).toBe(false);
    expect(() => assertEvalIsolation(facts, '测试')).toThrow(EvalIsolationRefused);
  });

  it('拒绝消息可行动：列出每一条缺什么（人读完知道怎么补）', () => {
    try {
      assertEvalIsolation(assessEvalIsolation({ env: {}, platformRoot: '/elsewhere', gateway: undefined }), '探针');
      expect.unreachable('必须抛 EvalIsolationRefused');
    } catch (error) {
      expect(error).toBeInstanceOf(EvalIsolationRefused);
      const message = (error as Error).message;
      expect(message).toContain('评测安全门拒绝跑危险用例');
      expect(message).toContain('探针');
      expect(message).toContain('EXECUTION_AUDIT_PATH 未设');
    }
  });

  it('夹具目录判据锚在仓内真实位置（防判据漂移成任意目录）', () => {
    expect(EVAL_FIXTURE_ROOT).toBe(path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures'));
    mkdirSync(path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'), { recursive: true }); // 已存在则无操作
  });
});

describe('主会话键（PR #21 审查 major：不许从 principalId 推导）', () => {
  it('sessionKeyOfChannel 拼 channel:conversationId', () => {
    expect(sessionKeyOfChannel('ask-session-fixed')).toBe('wecom:ask-session-fixed');
    expect(sessionKeyOfChannel('conv-x', 'lark')).toBe('lark:conv-x');
  });

  it('collectHostFacts 用调用方给的会话键查 taskRuns，不拿 principalId 顶替', async () => {
    // 假 store：只记 listBySession 收到的两个参数。principalId 与会话键刻意不同形，
    // 旧写法 sessionKeyOf(principalId) 会把会话键传成 principalId 本身。
    const seen: Array<{ principalId: string; sessionId: string }> = [];
    const fake = {
      requests: {
        findByWecomMessageId: async () => ({
          requestId: 'req_1',
          wecomMessageId: 'msg_1',
          principalId: 'wecom:user-alice',
          input: '{}',
          createdAt: new Date().toISOString(),
          outcome: 'completed',
        }),
      },
      toolCalls: { listByRequest: async () => [] },
      taskRuns: {
        listBySession: async (principalId: string, sessionId: string) => {
          seen.push({ principalId, sessionId });
          return [];
        },
      },
    } as unknown as AuditStore;
    const facts = await collectHostFacts(fake, 'msg_1', 'wecom:conv-room-7');
    expect(facts.request?.principalId).toBe('wecom:user-alice');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.principalId).toBe('wecom:user-alice');   // 主体键照传
    expect(seen[0]!.sessionId).toBe('wecom:conv-room-7');    // 会话键用调用方给的
    expect(seen[0]!.sessionId).not.toBe(seen[0]!.principalId);
  });
});
