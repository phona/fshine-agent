/**
 * T5：有界扩张门 + 审计 ↔ 计划声明对账（2026-11-11）。
 *
 * 断言：审计里被实际执行的调用必须能被已确认计划声明覆盖；超出的部分只能是有界的
 * 探索，且超出额度后必须伴随一次新的用户确认记录（重计划 → 确认门）。
 *
 * 为什么是"有界"而不是"超出即拒"：serve-gate.test.ts 的既有断言「② 激活计划只有读 →
 * 另一个读（不同 collection）放行：探索性查询不锁死」把"正当探索"钉成产品行为
 * （worker 查了 alpha 发现还要 beta，不能当场锁死）。今天 A2/C1 的伤害是**无界**扩张
 * 造成的，所以判据是给探索划界：额度 = 既有的读类探测帽缺省值（DEFAULT_READ_PROBE_CAP，
 * 5），不新造数字；超出即拒并留拒收记录，要求重新计划——重计划因累积重量进确认档，
 * 由平台确认门停下，于是留下用户确认记录（T5 判据的后半句）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_READ_PROBE_CAP } from './src/pi-coding-driver';
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
    expect(scopeReconciliationVerdict(result, { allowance: DEFAULT_READ_PROBE_CAP })).toBe('clean');
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

  it('额度内的扩张：有界探索，不判红（与既有"探索性查询不锁死"同一条线）', () => {
    const rows = Array.from({ length: DEFAULT_READ_PROBE_CAP }, (_, index) =>
      row({ ts: `2026-11-11T10:00:0${index}.000Z`, args: ['query', '--collection', `c${index}`] }));
    const result = reconcileAuditAgainstDeclarations({ rows, declarations: DECLARED });
    expect(scopeReconciliationVerdict(result, { allowance: DEFAULT_READ_PROBE_CAP })).toBe('excess_within_allowance');
  });

  it('超出额度且其后没有用户确认记录 → 判红（今天 D2/A2 的败状形状）', () => {
    const rows = Array.from({ length: DEFAULT_READ_PROBE_CAP + 1 }, (_, index) =>
      row({ ts: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`, args: ['query', '--collection', `c${index}`] }));
    const result = reconcileAuditAgainstDeclarations({ rows, declarations: DECLARED });
    expect(scopeReconciliationVerdict(result, { allowance: DEFAULT_READ_PROBE_CAP })).toBe('excess_unconfirmed');
  });

  it('超出额度但有一条在其后的用户确认记录（重计划走了确认门）→ 不再判红', () => {
    const rows = Array.from({ length: DEFAULT_READ_PROBE_CAP + 1 }, (_, index) =>
      row({ ts: `2026-11-11T10:00:${String(index).padStart(2, '0')}.000Z`, args: ['query', '--collection', `c${index}`] }));
    const result = reconcileAuditAgainstDeclarations({
      rows,
      declarations: DECLARED,
      confirmations: [{ at: '2026-11-11T10:00:06.000Z', planId: 'plan_b' }],
    });
    expect(scopeReconciliationVerdict(result, { allowance: DEFAULT_READ_PROBE_CAP })).toBe('excess_confirmed');
  });

  it('拿不到声明的调用（无 planId）不当作零超出：计入 unreconciled，结论 INCONCLUSIVE', () => {
    const result = reconcileAuditAgainstDeclarations({
      rows: [row({ planId: undefined })],
      declarations: DECLARED,
    });
    expect(result.unreconciledCalls).toBe(1);
    expect(result.declaredCalls).toBe(0);
    expect(scopeReconciliationVerdict(result, { allowance: DEFAULT_READ_PROBE_CAP })).toBe('inconclusive');
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
