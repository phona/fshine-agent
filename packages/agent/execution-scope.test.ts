/**
 * T5：执行集合 ⊆ 已确认计划（审计 ↔ 计划声明对账，2026-11-11）。
 *
 * 断言：审计里被实际执行的调用必须逐条落在已确认计划声明的范围内；任何超出都必须
 * 伴随一次新的用户确认记录（重计划 → 确认门），否则判红。**不设扩张额度**：今天
 * A2/C1 的败状就是"警告/额度"式的软约束被静默穿透。
 *
 * 执行前的拒收由驱动层同判据把关（plan-scope-expansion.test.ts）：对不上声明的调用
 * 第一跳即拒，并在审计里留拒收记录；本文件守的是审计侧的机械对账（逐条对参数）。
 */
import { describe, expect, it } from 'vitest';
import { reconcileAuditAgainstDeclarations, scopeReconciliationVerdict, type ScopeAuditRow } from './src/execution-scope';

const DECLARED = [{ planId: 'plan_a', calls: [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }] }];

const row = (over: Partial<ScopeAuditRow> = {}): ScopeAuditRow => ({
  ts: '2026-11-11T10:00:00.000Z',
  script: 'dummy.query',
  args: ['query', '--collection', 'alpha'],
  planId: 'plan_a',
  exitCode: 0,
  ...over,
});

describe('T5 审计 ↔ 计划声明对账', () => {
  it('执行集合全在声明内 → clean', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row(), row(), row({ ts: '2026-11-11T10:00:01.000Z' })],
      declarations: DECLARED,
    });
    expect(result.declaredCalls).toBe(3);
    expect(result.excess).toEqual([]);
    expect(scopeReconciliationVerdict(result)).toBe('clean');
  });

  it('被拒的行（refused）不算执行集合：从未执行，不参与对账', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ refused: 'plan-not-covering' }), row()],
      declarations: DECLARED,
    });
    expect(result.declaredCalls).toBe(1);
    expect(result.excess).toEqual([]);
  });

  it('计划没声明的对象被查了 → 计入 excess，并如实标出其后有没有用户确认', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [
        row({ ts: '2026-11-11T10:00:02.000Z', args: ['query', '--collection', 'beta'] }),
        row({ ts: '2026-11-11T10:00:03.000Z', args: ['query', '--collection', 'gamma'] }),
      ],
      declarations: DECLARED,
    });
    expect(result.excess.map((entry) => entry.args)).toEqual([
      JSON.stringify(['query', '--collection', 'beta']),
      JSON.stringify(['query', '--collection', 'gamma']),
    ]);
    expect(result.excess.every((entry) => entry.confirmationAt === undefined)).toBe(true);
  });

  it('第一次未声明调用就判红：没有"探索额度"这种软约束（A2/C1 的败状形状）', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ args: ['query', '--collection', 'beta'] })],
      declarations: DECLARED,
    });
    expect(result.excess).toHaveLength(1);
    expect(scopeReconciliationVerdict(result)).toBe('excess_unconfirmed');
  });

  it('多次未声明调用、其后没有任何用户确认记录 → 判红（今天 D2/A2 的败状形状）', () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      row({ ts: `2026-11-11T10:00:0${index}.000Z`, args: ['query', '--collection', `c${index}`] }));
    const result = reconcileAuditAgainstDeclarations({ rows, declarations: DECLARED });
    expect(scopeReconciliationVerdict(result)).toBe('excess_unconfirmed');
  });

  it('未声明调用之前有同一计划的用户确认记录（重计划 → 确认门）→ 不再判红', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ ts: '2026-11-11T10:00:05.000Z', planId: 'plan_b', args: ['query', '--collection', 'beta'] })],
      declarations: DECLARED,
      confirmations: [{ at: '2026-11-11T10:00:04.000Z', planId: 'plan_b' }],
    });
    // plan_b 是新计划：声明未随审计提供，但同一计划在调用之前已获用户确认 → 记为已确认扩张。
    expect(result.excess).toHaveLength(1);
    expect(result.excess[0]?.confirmationAt).toBe('2026-11-11T10:00:04.000Z');
    expect(scopeReconciliationVerdict(result)).toBe('excess_confirmed');
  });

  it('确认记录在未声明调用之后 → 判红（确认前零执行；后补的确认不能倒签）', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ ts: '2026-11-11T10:00:05.000Z', args: ['query', '--collection', 'beta'] })],
      declarations: DECLARED,
      confirmations: [{ at: '2026-11-11T10:00:06.000Z', planId: 'plan_a' }],
    });
    expect(scopeReconciliationVerdict(result)).toBe('excess_unconfirmed');
  });

  it('确认记录属于另一张计划 → 不能给这条未声明调用背书', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ ts: '2026-11-11T10:00:05.000Z', planId: 'plan_a', args: ['query', '--collection', 'beta'] })],
      declarations: DECLARED,
      confirmations: [{ at: '2026-11-11T10:00:04.000Z', planId: 'plan_other' }],
    });
    expect(scopeReconciliationVerdict(result)).toBe('excess_unconfirmed');
  });

  it('拿不到声明的调用（无 planId）不当作零超出：计入 unreconciled，结论 INCONCLUSIVE', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ planId: undefined })],
      declarations: DECLARED,
    });
    expect(result.unreconciledCalls).toBe(1);
    expect(result.declaredCalls).toBe(0);
    expect(scopeReconciliationVerdict(result)).toBe('inconclusive');
  });

  it('脚本路径写法与注册名同源（同一个 operation 的两种合法引用）', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ script: 'src/dummy/scripts/query.js' })],
      declarations: DECLARED,
    });
    expect(result.excess).toEqual([]);
    expect(result.declaredCalls).toBe(1);
  });
});
