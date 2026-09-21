import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HARD_MAX_GATE_CALLS,
  PLAN_EXAMPLE,
  parseCatalogFromCli,
  PlanBudget,
  estimateWeight,
  loadOpCatalog,
  parsePlanCommand,
  validatePlan,
  type ExecutionPlan,
  type OpCatalog,
} from './src/execution-plan';

const catalog: OpCatalog = new Map([
  ['query-saved', { name: 'src/voucher/scripts/query-saved.js', effects: ['read'] }],
  ['subject-list', { name: 'src/voucher/scripts/subject-list.js', effects: ['read'] }],
  ['query-history', { name: 'src/voucher/scripts/query-history.js', effects: ['read'] }],
  ['parse-bills', { name: 'src/voucher/scripts/parse-bills.py', effects: ['local'] }],
]);

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    goal: '查询幻辰财税 202607 凭证',
    accountSets: ['幻辰财税'],
    periods: ['202607'],
    readOps: ['voucher.query-saved'],
    writeOps: [],
    maxGateCalls: 5,
    completion: ['list_reported'],
    ...overrides,
  };
}

describe('parsePlanCommand', () => {
  it('解析 bin/17dz plan + YAML 子集', () => {
    const command = [
      'bin/17dz plan',
      'goal: 查凭证',
      'resources:',
      '  account_sets: [幻辰财税, 幻晟]',
      '  periods: [202607]',
      'authority:',
      '  read:',
      '    - voucher.query-saved',
      '    - subject-list.js',
      '  write: []',
      'constraints:',
      '  max_gate_calls: 8',
      'completion:',
      '  - list_reported',
    ].join('\n');
    const p = parsePlanCommand(command);
    expect(p).not.toBeNull();
    expect(p!.goal).toBe('查凭证');
    expect(p!.accountSets).toEqual(['幻辰财税', '幻晟']);
    expect(p!.readOps).toEqual(['voucher.query-saved', 'subject-list.js']);
    expect(p!.writeOps).toEqual([]);
    expect(p!.maxGateCalls).toBe(8);
  });

  it('非 plan 命令返回 null；空方案体 goal 缺失', () => {
    expect(parsePlanCommand('bin/17dz query query-saved.js A 202607')).toBeNull();
    const empty = parsePlanCommand('bin/17dz plan');
    expect(empty?.goal).toBe('');
  });

  it('一行式 JSON 方案（首选协议形态）', () => {
    const p = parsePlanCommand(PLAN_EXAMPLE);
    expect(p).not.toBeNull();
    expect(p!.goal).toContain('幻辰财税');
    expect(p!.accountSets).toEqual(['幻辰财税']);
    expect(p!.readOps).toEqual(['query-saved']);
    expect(p!.maxGateCalls).toBe(6);
  });

  it('JSON 兼容嵌套 resources/authority/constraints 与 camelCase', () => {
    const p = parsePlanCommand([
      'bash bin/17dz plan',
      JSON.stringify({
        goal: 'x',
        resources: { accountSets: ['幻晟'], periods: ['202608'] },
        authority: { read: ['voucher.query-saved'], write: [] },
        constraints: { maxGateCalls: 4, justification: 'y' },
        completion: ['done'],
      }),
    ].join('\n'));
    expect(p).not.toBeNull();
    expect(p!.accountSets).toEqual(['幻晟']);
    expect(p!.readOps).toEqual(['voucher.query-saved']);
    expect(p!.maxGateCalls).toBe(4);
  });

  it('parseCatalogFromCli：解析公共 CLI 输出（键 = 归一化短名，est_seconds 带出）', () => {
    const catalog = parseCatalogFromCli(JSON.stringify([
      { name: 'voucher.query-saved', command: 'query-saved', access: 'read', effects: ['read'], est_seconds: 12 },
      { name: 'voucher.commit', command: 'commit', access: 'write-flag', effects: ['write'] },
    ]));
    expect(catalog.get('query-saved')).toEqual({ name: 'voucher.query-saved', effects: ['read'], estSeconds: 12 });
    expect(catalog.get('commit')?.effects).toEqual(['write']);
    expect(catalog.get('commit')?.estSeconds).toBeUndefined();
  });

  it('loadOpCatalog 经 bin/17dz 公共 CLI 获取清单；CLI 不可用降级空表', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fshine-catalog-'));
    try {
      mkdirSync(path.join(root, 'bin'), { recursive: true });
      const bin = path.join(root, 'bin', '17dz');
      writeFileSync(bin, 'console.log(JSON.stringify([{ name: "voucher.query-saved", effects: ["read"], est_seconds: 12 }]))');
      chmodSync(bin, 0o644); // 经 process.execPath 执行，无需可执行位
      const catalog = loadOpCatalog(root);
      expect(catalog.get('query-saved')?.estSeconds).toBe(12);
      // CLI 失败（非 JSON 输出）→ 降级空表
      writeFileSync(bin, 'console.error("boom"); process.exit(1)');
      expect(loadOpCatalog(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validatePlan', () => {
  it('合法方案通过并定价（browser read ≈10s × 账套×期间）', () => {
    const v = validatePlan(plan(), catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.limit).toBe(5);
    expect(v.estimate).toEqual({ calls: 1, seconds: 10 });
  });

  it('缺 goal / 空 read / 声明 write / 非法预算 → 各自给原因', () => {
    const noGoal = validatePlan(plan({ goal: '' }), catalog);
    expect(noGoal.ok).toBe(false);
    const noRead = validatePlan(plan({ readOps: [] }), catalog);
    expect(noRead.ok).toBe(false);
    const withWrite = validatePlan(plan({ writeOps: ['voucher.fill'] }), catalog);
    expect(withWrite.ok).toBe(false);
    if (!withWrite.ok) expect(withWrite.reasons.join()).toContain('write');
    const noBudget = validatePlan(plan({ maxGateCalls: 0 }), catalog);
    expect(noBudget.ok).toBe(false);
  });

  it('未登记脚本被拒（有清单时）', () => {
    const v = validatePlan(plan({ readOps: ['query-saved.js', 'query-magic.js'] }), catalog);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join()).toContain('query-magic.js');
  });

  it('清单不可用时降级放行（fail-open for availability）', () => {
    const v = validatePlan(plan({ readOps: ['query-saved.js'] }), new Map());
    expect(v.ok).toBe(true);
  });

  it('期数超限须 justification', () => {
    const sweep = plan({
      goal: '扫全年',
      periods: ['202601', '202602', '202603', '202604'],
      readOps: ['query-history.js'],
      maxGateCalls: 12,
    });
    expect(validatePlan(sweep, catalog).ok).toBe(false);
    const justified = validatePlan({ ...sweep, justification: '用户明确要求全年逐期' }, catalog);
    expect(justified.ok).toBe(true);
  });

  it('自报预算超硬上限被截断并提示', () => {
    const v = validatePlan(plan({ maxGateCalls: 999 }), catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.limit).toBe(HARD_MAX_GATE_CALLS);
    expect(v.notices.join()).toContain('硬上限');
  });

  it('预估超过确认阈值且未确认 → needsConfirm；用户确认后放行', () => {
    const heavy = plan({
      accountSets: ['幻辰财税'],
      periods: ['202601', '202602', '202603', '202604', '202605', '202606'],
      readOps: ['query-saved'],
      maxGateCalls: 30,
      justification: '用户要求全年逐月',
    });
    const v = validatePlan(heavy, catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.estimate.calls).toBe(6);
    expect(v.needsConfirm).toBe(false); // 6 ≤ 阈值 10
    const bigger = validatePlan({ ...heavy, periods: ['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609', '202610', '202611', '202612'] }, catalog);
    expect(bigger.ok).toBe(true);
    if (!bigger.ok) return;
    expect(bigger.estimate.calls).toBe(12);
    expect(bigger.needsConfirm).toBe(true); // 12 > 10
    const acked = validatePlan({ ...bigger.plan, userConfirmed: true }, catalog);
    expect(acked.ok).toBe(true);
    if (!acked.ok) return;
    expect(acked.needsConfirm).toBe(false);
  });
});

describe('estimateWeight / PlanBudget', () => {
  it('multiplicity = 账套 × 期间；local 脚本只按 1 次', () => {
    const w = estimateWeight(plan({
      accountSets: ['a', 'b'],
      periods: ['202606', '202607', '202608'],
      readOps: ['query-saved.js', 'parse-bills.py'],
    }), catalog);
    expect(w).toEqual({ calls: 7, seconds: 61 }); // 2×3 browser×10s + 1 local×1s
  });

  it('PlanBudget：脚本覆盖判定与消耗', () => {
    const v = validatePlan(plan(), catalog);
    if (!v.ok) throw new Error('expect ok');
    const budget = new PlanBudget(v);
    expect(budget.limit).toBe(5);
    expect(budget.coversScript('src/voucher/scripts/query-saved.js')).toBe(true);
    expect(budget.coversScript('subject-list.js')).toBe(false);
    budget.consume(); budget.consume();
    expect(budget.exhausted).toBe(false);
    budget.consume(); budget.consume(); budget.consume(); budget.consume();
    expect(budget.exhausted).toBe(true);
  });
});
