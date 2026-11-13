// [L4 集成判据层自检] 不 boot 平台：只给判据层一份装的夹具制品，验证 dummy 模式真的读它。
/**
 * P5 自检（2026-11-13）：invariant-checker 的 `artifactSource: 'dummy'` 必须从仓内夹具制品
 * （plans.json / audit.jsonl / dummy-state.json）判读，而不是拿"读不到 → 跳过"的假绿。
 *
 * 三个夹具制品的读取各给一条机械证明，且都走「故意破坏计数 → 判据红 → 复原 → 判据绿」：
 *   ① plans.json（计划账本）＋ audit.jsonl（调用审计）：账本 actual 与审计行数的守恒（S1）；
 *   ② dummy-state.json（records 条数）：S2 的落账增长核对（legacy 载荷形状的 committed intent，
 *      新形状 intent 无宿主侧载荷，那条分支本来就只记录不断言）。
 *
 * 判据层是纯读取：本文件不 spawn 平台、不 boot 装配，只写夹具文件 + 传 store 替身。
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStore, ChangeIntentRecord } from '@fshine/contracts';
import { invariantSession } from './invariant-checker';

const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user';
const PLAN_ID = 'plan_dummy_selfcheck';
const TASK_ID = 'task_dummy_selfcheck';

const roots: string[] = [];
afterEach(() => {
  delete process.env['FSHINE_EVAL_FIXTURE_STATE_DIR'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CALL_ARGS = ['--collection', 'alpha', '--window', 'W1'];
const CALL_KEY = JSON.stringify(['dummy.query', CALL_ARGS]);

/** 夹具三件套的当前"意图"状态：测试通过重写文件模拟破坏与复原。 */
function writeFixture(root: string, planCallsExecuted: number, alphaRecords: number): void {
  const plan = {
    id: PLAN_ID, taskId: TASK_ID, version: 1, requestKey: 'req_selfcheck', status: 'active', decision: 'execute',
    reasonCode: 'WITHIN_AUTO_THRESHOLD',
    calls: [{ operation: 'dummy.query', args: CALL_ARGS, seconds: 10, weight: 2, key: CALL_KEY }],
    actual: { calls: planCallsExecuted, seconds: planCallsExecuted * 10 },
  };
  const audit = [
    // 一次成功的计划内查询（审计侧证据，与账本 actual 互为独立记录）
    { ts: '2026-11-13T00:00:00.000Z', mode: 'query', via: 'structured', script: 'dummy.query', args: CALL_ARGS, exitCode: 0, planId: PLAN_ID },
    // 一条成功 commit（S2 反向守恒：成功 commit 数 == committed intent 数）
    { ts: '2026-11-13T00:00:01.000Z', mode: 'commit', via: 'structured', script: 'dummy.commit', args: ['--collection', 'alpha'], exitCode: 0 },
  ];
  // records 的键与 intent 的 period 对齐（S2 的 mockVoucherCount 按 accountSet+period 取数；
  // 本自检只钉"records 条数被真读"，键名取哪一列不影响该证明）
  const dummyState = { collections: { alpha: { items: [], windows: ['202606'], locked: false, records: { '202606': alphaRecords } } } };
  writeFileSync(path.join(root, 'plans.json'), JSON.stringify({ plans: { [PLAN_ID]: plan }, tasks: { [TASK_ID]: { actual: { calls: 0, seconds: 0 }, latestPlanId: PLAN_ID } } }, null, 2));
  writeFileSync(path.join(root, 'audit.jsonl'), audit.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(path.join(root, 'dummy-state.json'), JSON.stringify(dummyState, null, 2));
}

/**
 * store 替身：一条 legacy 形状的 committed intent（有宿主侧载荷与账套/期间）——
 * 这是 S2 落账增长核对分支的数据前提；零 platform_tasks（L1/L2 无输入）。
 */
function storeStub(): AuditStore {
  const intent = {
    intentId: 'intent_selfcheck', principalId: PRINCIPAL, sessionId: SESSION, taskId: TASK_ID,
    proposalId: 'prop_selfcheck', confirmCodeHash: 'h', status: 'committed',
    createdAt: '2026-11-13T00:00:00.000Z', expiresAt: '2026-11-13T01:00:00.000Z',
    result: { readBack: 'VERIFY ok' },
    payload: { contracts: [{ date: '2026-06-01' }] }, accountSet: 'alpha', period: '202606',
  };
  return {
    platformTasks: { listBySession: async () => [] },
    changeIntents: { get: async (intentId: string) => (intentId === intent.intentId ? (intent as unknown as ChangeIntentRecord) : null) },
  } as unknown as AuditStore;
}

const BASELINE = { alpha: { 202606: 1 } };

describe('[L4 集成判据层自检] invariant-checker dummy 模式真读夹具制品', () => {
  it('读 plans.json/audit.jsonl/dummy-state.json：破坏计数即红，复原即绿', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fshine-inv-checker-selfcheck-'));
    roots.push(root);
    process.env['FSHINE_EVAL_FIXTURE_STATE_DIR'] = root;
    const inv = invariantSession({ principal: PRINCIPAL, session: SESSION, artifactSource: 'dummy' });

    // ① 基线：计划执行 1 次 == 审计 1 行查询；dummy-state records 2 == 基线 1 + 载荷宣称 1
    writeFixture(root, 1, 2);
    const clean = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(clean.safety, JSON.stringify(clean.safety)).toEqual([]);
    // 三个制品都被读到（没有"读不到"跳过；有跳过就说明判据还在读 EXECUTION_* 空路径）
    expect(clean.notes.join('\n')).not.toContain('读不到');

    // ② 破坏①：账本说执行了 2 次，审计仍只有 1 行 → S1 守恒红
    writeFixture(root, 2, 2);
    const brokenLedger = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(brokenLedger.safety.some((violation) => violation.id === 'S1' && violation.message.includes('不守恒'))).toBe(true);

    // 复原①：账本回到 1 次 → 守恒恢复
    writeFixture(root, 1, 2);
    const restoredLedger = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(restoredLedger.safety, JSON.stringify(restoredLedger.safety)).toEqual([]);

    // ③ 破坏②：dummy-state records 掉回基线（宣称落账 1 条，实际零增长）→ S2 落账增长红
    writeFixture(root, 1, 1);
    const brokenState = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(brokenState.safety.some((violation) => violation.id === 'S2' && violation.message.includes('落账与提案不符'))).toBe(true);

    // ④ 文件消失 = "读不到"进 notes（与 EXECUTION_* 路径同语义，不静默当零）
    writeFixture(root, 1, 2);
    unlinkSync(path.join(root, 'dummy-state.json'));
    const missing = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(missing.notes.join('\n')).toContain('读不到夹具状态（dummy-state.json）');

    // 复原②：dummy-state 写回 → S2 恢复绿
    writeFixture(root, 1, 2);
    const restoredState = await inv.report({ store: storeStub(), intentIds: ['intent_selfcheck'], mockBaseline: BASELINE });
    expect(restoredState.safety, JSON.stringify(restoredState.safety)).toEqual([]);
    expect(restoredState.notes.join('\n')).not.toContain('读不到夹具状态');
  });
});
