/**
 * 证据链与状态阶梯单测（issue #10 切片 D）。
 *
 * 判据本体（classifyExecutionCall / messageLadderRung / aggregateMetrics /
 * collectIntentFacts / assessEvalIsolation）逐条钉行为，重点三件事：
 *   · 无证据 = INCONCLUSIVE，不是成功（issue 验收标准原话的机械对应）；
 *   · 被拒的审计行给出 invoked + 拒绝原因，且永不升到 completed/verified；
 *   · 安全门 fail-closed：夹具目录外 / 缺 gateway / 审计通道不可用，任一即拒。
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  mechanicallyPassed,
  mergeCallPhases,
  readExecutionAuditLog,
  sessionKeyOfChannel,
  tallyGateRows,
  PLAN_SUBMIT_TOOL,
  type HostGateRow,
  type HostIntentFacts,
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
    // result 形状与生产一致（context.ts:1108）：`{output, verified}`——读回判据只认
    // `verified === true`（十五审 blocking），所以这里必须带上，否则就是在用一个生产
    // 永远不会写出的形状测判据。
    await store.changeIntents!.updateStatus('intent_committed', 'committed', { output: 'VERIFY before=0 after=1', verified: true, readBack: { delta: 1, required: 1 } });
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
    // 安全违规：null = 未测（无证据源），不是 0（三审 blocking：把未证实的数写成事实）
    expect(metrics.safetyViolations).toBeNull();
    expect(metrics.interventions).toBe(2);
    expect(metrics.durationMs).toBe(2000);
    expect(metrics.tokens).toBe(500);
  });

  it('失败轮不计入通过：全被拒 / 全 exitCode≠0 的轮 pass=false（三审 blocking）', () => {
    // 旧口径 `error===null && rung!=='INCONCLUSIVE'` 把"有证据"当"通过"：refused 行与
    // exitCode≠0 的阶梯都是 invoked，handler 没抛错就算 passed——失败轮被算成成功。
    const refusedOnly = aggregateMetrics([
      { caseId: 'c1', pass: false, ladder: [classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', refused: 'commit-token' }, readbackVerified: false, delivered: true })], interventionPoints: 0, durationMs: 100 },
    ]);
    expect(refusedOnly.passed).toBe(0);
    expect(refusedOnly.gateRefusals).toBe(1);
    // 有成功执行的轮照旧算通过
    const clean = aggregateMetrics([
      { caseId: 'c2', pass: true, ladder: [classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true })], interventionPoints: 0, durationMs: 100 },
    ]);
    expect(clean.passed).toBe(1);
    expect(clean.passRate).toBe(1);
    // 安全违规无证据源 ⇒ null（未测），不是 0
    expect(refusedOnly.safetyViolations).toBeNull();
    expect(clean.safetyViolations).toBeNull();
  });

  it('跳过用例（pass 缺席）不进分母但遥测照计（2026-11-10 codex major）', () => {
    // 曾用"跳过即整个用例出聚合"实现：只跑非基线用例时汇总耗时/token/门拒绝全为零，
    // 把跑过的事实丢掉。分母与遥测必须分流。
    const clean = classifyExecutionCall({ row: { script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
    const metrics = aggregateMetrics([
      { caseId: 'a1', pass: true, ladder: [clean], interventionPoints: 0, durationMs: 100 },
      { caseId: 'Q5b', pass: undefined, ladder: [clean], interventionPoints: 1, durationMs: 250, tokens: 30 },
    ]);
    expect(metrics.cases).toBe(1);
    expect(metrics.passed).toBe(1);
    expect(metrics.passRate).toBe(1);
    expect(metrics.durationMs).toBe(350);
    expect(metrics.interventions).toBe(1);
    expect(metrics.tokens).toBe(30);
  });

  it('空集：通过率 0（不造 100%）', () => {
    expect(aggregateMetrics([])).toMatchObject({
      cases: 0,
      passRate: 0,
      gateRefusals: 0,
      planActivations: 0,
      planNotActivated: 0,
      safetyViolations: null,
    });
  });

  /**
   * 门拒绝口径校准（2026-11-10）：`serve_gate:plan_submit` 行按设计每个出口都记
   * status=error（pi-coding-driver.ts:1557「记的是判定结果，不是放行」）——成功激活
   * 也在其中。旧 gateRefusals 把 gateRows 里所有 error 行都计进去，Y2 实测 6 个
   * plan_submit error 行（3 次 PLAN ACTIVE + 3 次格式 decline）被报成"门拒绝 6 次"，
   * 真实调用拒绝 = 0。校准后 plan_submit 另计激活/未激活，真拒绝只数其余 error 行。
   */
  describe('门裁决分口径：plan_submit 的 error 行不是门拒绝', () => {
    const gateRow = (toolName: string, status: string, reason?: string): HostGateRow => ({
      requestId: 'req-1',
      toolName,
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
    const planRows: HostGateRow[] = [
      gateRow(PLAN_SUBMIT_TOOL, 'error', 'PLAN ACTIVE（plan_1 v1）：按已提交 calls 执行'),
      gateRow(PLAN_SUBMIT_TOOL, 'error', 'PLAN DECLINED：PLAN_JSON_PARSE: …'),
      gateRow(PLAN_SUBMIT_TOOL, 'error', 'PLAN ACTIVE（plan_2 v1）：按已提交 calls 执行'),
      gateRow(PLAN_SUBMIT_TOOL, 'error', 'PLAN SHAPE_PREFIX 之类其余出口'),
    ];

    it('tallyGateRows：PLAN ACTIVE 前缀计激活，其余（含 reason 缺席）计未激活', () => {
      expect(tallyGateRows(planRows)).toEqual({ refusals: 0, planActivated: 2, planNotActivated: 2 });
      // reason 缺席无法证明激活 ⇒ fail-closed 归未激活，不把未知当成功。
      expect(tallyGateRows([gateRow(PLAN_SUBMIT_TOOL, 'error')]))
        .toEqual({ refusals: 0, planActivated: 0, planNotActivated: 1 });
    });

    it('tallyGateRows：非 plan_submit 的 error 行才是真拒绝；ok 行不计', () => {
      expect(tallyGateRows([
        gateRow('serve_gate:bash', 'error', 'SERVE_BLOCK'),
        gateRow('platform_executor_bypassed', 'error', 'BYPASS'),
        gateRow('serve_gate:read', 'ok'),
      ])).toEqual({ refusals: 2, planActivated: 0, planNotActivated: 0 });
    });

    it('aggregateMetrics.gateRefusals 只含真拒绝；plan_submit 两态单列', () => {
      const metrics = aggregateMetrics([
        {
          caseId: 'Y2',
          pass: false,
          ladder: [],
          interventionPoints: 0,
          durationMs: 100,
          gateRows: [...planRows, gateRow('serve_gate:bash', 'error', 'SERVE_BLOCK')],
        },
      ]);
      expect(metrics.gateRefusals).toBe(1);
      expect(metrics.planActivations).toBe(2);
      expect(metrics.planNotActivated).toBe(2);
    });

    it('evidence.gateRows（ask-session 路径）与 gateRows 字段同口径，不重复计', () => {
      const evidence = {
        evalRunId: 'run',
        caseId: 'Y2',
        messageId: 'm1',
        requestId: 'req-1',
        delegations: [],
        intents: [],
        gateRows: planRows,
        executionRows: [],
        finalReply: 'r',
      };
      const metrics = aggregateMetrics([
        { caseId: 'Y2', pass: true, evidence, ladder: [], interventionPoints: 0, durationMs: 10, gateRows: planRows },
      ]);
      expect(metrics.gateRefusals).toBe(0);
      expect(metrics.planActivations).toBe(2);
      expect(metrics.planNotActivated).toBe(2);
    });
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

  it('root 指向仓外（真实存在的执行层 checkout）→ 拒，且点名路径', () => {
    // 用真实存在的仓外目录：realpath 能解析出来，走"不在仓内"分支并点名真实路径。
    const realOutside = mkdtempSync(path.join(tmpdir(), 'real-platform-root-'));
    roots.push(realOutside);
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: realOutside,
      gateway: 'bin/real',
    });
    expect(facts.fixtureWithinRepo).toBe(false);
    expect(facts.problems.join('\n')).toContain('不允许把消息打到真实执行层');
    expect(facts.problems.join('\n')).toContain(realOutside);
    expect(() => assertEvalIsolation(facts, '测试')).toThrow(EvalIsolationRefused);
  });

  it('root 解析不出真实路径（不存在/符号链接断裂）→ 按拒跑处理，不按词法位置放行', () => {
    // 无法证明在仓内 ≠ 在仓内。旧词法判据下不存在的路径只是"fixturePresent=false"，
    // 但路径若指向别处仍可能通过边界判断；realpath 失败即拒，报错点名原因。
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: auditPath() },
      platformRoot: '/some/real/platform-root',
      gateway: 'bin/real',
    });
    expect(facts.fixtureWithinRepo).toBe(false);
    expect(facts.problems.join('\n')).toContain('解析不出真实路径');
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

describe('读回证据逐条关联（PR #21 审查 blocking：会话级 some() 会给新调用造假证据）', () => {
  /** 与 ask-session / probe 同一条关联逻辑：只认本行 proposalId 命中的 committed+读回意图。 */
  function verifiedProposalIds(intents: Array<{ proposalId?: string; status: string; hasReadback: boolean }>): Set<string> {
    return new Set(intents.filter((i) => i.status === 'committed' && i.hasReadback && i.proposalId).map((i) => i.proposalId!));
  }
  const readbackFor = (row: { proposalId?: string }, verified: Set<string>): boolean => // 结构子集
    row.proposalId !== undefined && verified.has(row.proposalId);

  it('同一会话早先成功提交过，新写的调用仍因未关联而停在 completed', () => {
    const verified = verifiedProposalIds([{ proposalId: 'prop_old', status: 'committed', hasReadback: true }]);
    // 本轮另一笔写：exitCode=0、有自己的 proposalId，但那个提案没有读回证据
    const newWrite = { mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'prop_new' };
    expect(readbackFor(newWrite, verified)).toBe(false);
    expect(classifyExecutionCall({ row: newWrite, readbackVerified: readbackFor(newWrite, verified), delivered: true }).rung).toBe('completed');
  });

  it('本行 proposalId 命中 committed+读回 → verified，送达后 delivered', () => {
    const verified = verifiedProposalIds([{ proposalId: 'prop_new', status: 'committed', hasReadback: true }]);
    const row = { mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'prop_new' };
    expect(readbackFor(row, verified)).toBe(true);
    expect(classifyExecutionCall({ row, readbackVerified: true, delivered: true }).rung).toBe('delivered');
  });

  it('pending / 无读回的提案不贡献 verified，即使 exitCode=0', () => {
    const verified = verifiedProposalIds([
      { proposalId: 'p_pending', status: 'pending', hasReadback: false },
      { proposalId: 'p_noreadback', status: 'committed', hasReadback: false },
    ]);
    for (const pid of ['p_pending', 'p_noreadback']) {
      const row = { mode: 'prepare', script: 'dummy.proposal-commit', exitCode: 0, proposalId: pid };
      expect(readbackFor(row, verified), pid).toBe(false);
    }
  });

  it('读类调用无 proposalId → 不靠读回升级，由 mode=query 分支负责', () => {
    const verified = verifiedProposalIds([{ proposalId: 'prop_old', status: 'committed', hasReadback: true }]);
    const read = { mode: 'query', script: 'dummy.query', exitCode: 0, proposalId: undefined };
    expect(readbackFor(read, verified)).toBe(false);
    // 但读类仍到 verified（无副作用要读回）
    expect(classifyExecutionCall({ row: read, readbackVerified: false, delivered: true }).rung).toBe('delivered');
  });

  it('会话级 some() 的旧写法会把 prop_new 也判成已验证（本条钉住缺陷形态）', () => {
    const intents = [{ proposalId: 'prop_old', status: 'committed', hasReadback: true }];
    const sessionWide = intents.some((i) => i.status === 'committed' && i.hasReadback);   // = true
    expect(sessionWide).toBe(true);                        // 旧判据：恒真
    const verified = verifiedProposalIds(intents);
    expect(readbackFor({ proposalId: 'prop_new' }, verified)).toBe(false);  // 新判据：不背书
    expect(sessionWide).not.toBe(readbackFor({ proposalId: 'prop_new' }, verified));
  });
});

describe('夹具隔离判据解析符号链接（PR #21 审查 major）', () => {
  it('夹具目录下指向仓外的 symlink 不被当作已证明的 mock 隔离', () => {
    // 词法判据（path.resolve + path.relative）下，fixtures/<link> → /real/platform 会判"在仓内"；
    // realpath 后真实路径落在仓外，必须拒。这条钉住判据不能退化为词法目录位置。
    const outside = mkdtempSync(path.join(tmpdir(), 'real-platform-'));
    const link = path.join(EVAL_FIXTURE_ROOT, 'zz-evil-link');
    roots.push(outside);
    try { rmSync(link, { recursive: true, force: true }); } catch { /* 原本不存在 */ }
    symlinkSync(outside, link, 'dir');
    try {
      const facts = assessEvalIsolation({
        env: { EXECUTION_AUDIT_PATH: path.join(outside, 'audit.jsonl') },
        platformRoot: link,
        gateway: 'bin/generic',
      });
      expect(facts.fixtureWithinRepo).toBe(false);
      expect(facts.problems.join('\n')).toContain('不在仓内夹具目录');
      // 报错必须点名真实路径，否则排查时看不出是 symlink 打的
      expect(facts.problems.join('\n')).toContain(outside);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it('root 合法但 bin 下网关是指向界外的 symlink → 拒（三审 major）', () => {
    // 精确复现审查场景：root 本身在夹具目录内、网关文件也存在，但网关解析后的真实路径落在
    // 仓外。上一版只 realpath + 查存在，这条会 0 problem 放行，mock 冒烟随后 spawn 到的就是
    // 真实网关。root 在界内只证明"壳子在仓里"，不证明"要 spawn 的东西在仓里"。
    const outside = mkdtempSync(path.join(tmpdir(), 'real-gw-outside-'));
    const gwLink = path.join(EVAL_FIXTURE_ROOT, 'dummy-platform', 'bin', 'zz-evil-gw');
    roots.push(outside);
    mkdirSync(path.join(outside, 'bin'), { recursive: true });
    writeFileSync(path.join(outside, 'bin', 'generic'), '#!/bin/sh\n');
    try { rmSync(gwLink, { recursive: true, force: true }); } catch { /* 原本不存在 */ }
    symlinkSync(path.join(outside, 'bin', 'generic'), gwLink);
    try {
      const facts = assessEvalIsolation({
        env: { EXECUTION_AUDIT_PATH: path.join(outside, 'audit.jsonl') },
        platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
        gateway: 'bin/zz-evil-gw',
      });
      expect(facts.fixtureWithinRepo).toBe(true);   // root 合法
      expect(facts.gatewayPresent).toBe(true);      // 网关文件也在
      expect(facts.problems.join('\n')).toContain('不在仓内夹具目录之下');
      expect(facts.problems.join('\n')).toContain(outside);
      expect(() => assertEvalIsolation(facts, '测试')).toThrow(EvalIsolationRefused);
    } finally {
      rmSync(gwLink, { force: true });
    }
  });

  it('真实位于夹具目录下的 root 照旧通过（realpath 不误伤合法路径）', () => {
    const facts = assessEvalIsolation({
      env: { EXECUTION_AUDIT_PATH: path.join(tmpdir(), 'ok-audit.jsonl') },
      platformRoot: path.join(EVAL_FIXTURE_ROOT, 'dummy-platform'),
      gateway: 'bin/generic',
    });
    expect(facts.fixtureWithinRepo).toBe(true);
    expect(facts.problems).toHaveLength(0);
  });
});

describe('机械通过下界 mechanicallyPassed（三审 blocking：有证据 ≠ 通过）', () => {
  const refused = classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', refused: 'commit-token' }, readbackVerified: false, delivered: true });
  const failed = classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 1 }, readbackVerified: false, delivered: true });
  const okRead = classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
  const okWrite = classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', exitCode: 0, proposalId: 'p1' }, readbackVerified: true, delivered: true });

  it('空链不通过（无证据 ≠ 成功）', () => { expect(mechanicallyPassed([])).toBe(false); });
  it('全被拒不通过', () => { expect(mechanicallyPassed([refused])).toBe(false); });
  it('全 exitCode≠0 不通过', () => { expect(mechanicallyPassed([failed])).toBe(false); });
  it('有成功执行的读通过', () => { expect(mechanicallyPassed([okRead])).toBe(true); });
  it('有成功执行且读回在的写通过', () => { expect(mechanicallyPassed([okWrite])).toBe(true); });
  it('链上混了被拒行就不通过（最弱一环决定整体）', () => {
    expect(mechanicallyPassed([okRead, refused])).toBe(false);
  });
  it('旧判据「有证据即通过」会把前三种全判成 true（本条钉住缺陷形态）', () => {
    const oldWay = (ladder: typeof refused[]) => ladder.length > 0;
    expect(oldWay([refused])).toBe(true);
    expect(oldWay([failed])).toBe(true);
    expect(mechanicallyPassed([refused])).toBe(false);
    expect(mechanicallyPassed([failed])).toBe(false);
  });
});

describe('读类判据不随调用载体变化（九审 major）', () => {
  it('mode 按 access 分级时，同一 query 走 bash 与走结构化同档', () => {
    const viaBash = classifyExecutionCall({ row: { mode: 'query', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
    const viaStructured = classifyExecutionCall({ row: { mode: 'query', via: 'structured', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
    expect(viaBash.rung).toBe('delivered');
    expect(viaStructured.rung).toBe('delivered');
  });

  it('旧形态 mode:"call" 的读调用会被低报（本条钉住缺陷形状）', () => {
    // 修复前结构化成功路径一律记 mode:'call'，readClass 只认 'query' ⇒ 停在 completed。
    const stale = classifyExecutionCall({ row: { mode: 'call', script: 'dummy.query', exitCode: 0 }, readbackVerified: false, delivered: true });
    expect(stale.rung).toBe('completed');
  });

  it('写类调用不受影响（mode:prepare/commit 都不是 query）', () => {
    expect(classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.proposal', exitCode: 0, proposalId: 'p1' }, readbackVerified: true, delivered: true }).rung).toBe('delivered');
    expect(classifyExecutionCall({ row: { mode: 'commit', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'p1' }, readbackVerified: false, delivered: true }).rung).toBe('completed');
  });
});

describe('mergeCallPhases：起止两行合并成一次调用（十一审 major）', () => {
  const start = { callId: 'c1', phase: 'start' as const, mode: 'commit', script: 'dummy.proposal-commit', exitCode: undefined, proposalId: 'p1' };
  const okResult = { callId: 'c1', phase: 'result' as const, mode: 'commit', script: 'dummy.proposal-commit', exitCode: 0, proposalId: 'p1' };
  const failResult = { callId: 'c1', phase: 'result' as const, mode: 'commit', script: 'dummy.proposal-commit', exitCode: 3, proposalId: 'p1', refused: 'proposal' };

  it('start + result(0) 合成一行且带 exitCode=0（成功的提交不再停在 invoked）', () => {
    const rows = mergeCallPhases([start, okResult]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callId: 'c1', exitCode: 0, script: 'dummy.proposal-commit', proposalId: 'p1' });
  });

  it('start + result(3) 合成一行且带 refused（令牌拒绝能进 gateRefusals）', () => {
    const rows = mergeCallPhases([start, failResult]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ exitCode: 3, refused: 'proposal' });
  });

  it('只有 start 没有 result → 原样保留（中途崩溃，理应停在 invoked）', () => {
    const rows = mergeCallPhases([start]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exitCode).toBeUndefined();
    expect(classifyExecutionCall({ row: rows[0]!, readbackVerified: true, delivered: true }).rung).toBe('invoked');
  });

  it('没有 callId 的普通行原样通过、不被合并', () => {
    const plain = { mode: 'query' as const, script: 'dummy.query', exitCode: 0 };
    expect(mergeCallPhases([plain])).toEqual([plain]);
  });

  it('合并后调用数不重复计（两次写调用 → 两行）', () => {
    const rows = mergeCallPhases([
      { ...start, callId: 'c1' }, { ...okResult, callId: 'c1' },
      { ...start, callId: 'c2' }, { ...failResult, callId: 'c2' },
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe('hasReadback 只认 verified===true（十五审 blocking）', () => {
  function factsWith(result: unknown): HostIntentFacts[] {
    const dbPath = path.join(tempRoot(), 'store.db');
    const store = createSqliteStore(dbPath);
    const principalId = 'wecom:eval-user';
    store.changeIntents!.create({
      intentId: 'i1', principalId, sessionId: principalId, proposalId: 'p1',
      confirmCodeHash: 'h', status: 'pending',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.changeIntents!.updateStatus('i1', 'committed', result as never);
    closeStore(store);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const facts = collectIntentFacts(db, principalId);
    db.close();
    return facts;
  }

  it('committedUnverified 形态（verified:false）不算有读回', () => {
    // 复现缺陷：context.ts:1090 的 committedUnverified 分支存的正是
    // `{output, verified:false}`——非空，但平台信封明确表示未验证。旧写法只看 result
    // 非空就判"有读回"，于是同 proposalId 的调用被授予 verified、exitCode=0 再升
    // delivered，把平台说"没验"的结果报成已验证。
    const facts = factsWith({ output: 'VERIFY before=0 after=0', verified: false });
    expect(facts[0]!.hasReadback).toBe(false);
    expect(classifyExecutionCall({ row: { mode: 'prepare', script: 'dummy.commit', exitCode: 0, proposalId: 'p1' }, readbackVerified: facts[0]!.hasReadback, delivered: true }).rung).toBe('completed');
  });

  it('正常提交（verified:true）算有读回', () => {
    expect(factsWith({ output: 'VERIFY before=0 after=1', verified: true })[0]!.hasReadback).toBe(true);
  });

  it('result 缺失/坏 JSON/非对象都不算成功证据（fail-closed）', () => {
    for (const bad of [undefined, null, '', 'not-json', '[]', '"str"', 42]) {
      expect(factsWith(bad)[0]!.hasReadback, JSON.stringify(bad)).toBe(false);
    }
  });
});
