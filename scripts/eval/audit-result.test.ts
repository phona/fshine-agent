/**
 * query 响应载荷落进行审计行（audited 申报模式交叉核的事实基准）——契约表征锁。
 *
 * 背景（docs/debt-ledger.md D-206 闭环判据）：audited 申报模式要由确定性交叉核判
 * "申报-事实一致性"，其事实基准是**夹具把 query 响应载荷写进审计行**。此前审计行只有
 * args 没有响应，"回复里的数平台确实拉回过"只能靠模型自述传递，无法独立核对。
 *
 * 本锁钉三件事（驱动方式与 generic-mock.test.ts / second-layer.test.ts 相同：
 * spawnSync 真跑夹具 CLI + 临时 state 目录，不新造 harness）：
 *   ① bash 与 structured 两条路径的 query completed 行都能读回**该次实际返回的**
 *      items（id/name/value）与 count——读回走真实消费方 readExecutionAuditLog；
 *   ② stock 夹具域字段是 sku/qty，落账时按同一契约投影成 name/value（不投影则按
 *      value 找数的交叉核对 stock 行永远空手）；
 *   ③ 被拒 / 失败 / 无数据（not_found）行不带 result——没有拉回过 items 的调用，
 *      审计行不许出现"看起来拉回过"的载荷。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readExecutionAuditLog } from './evidence';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const dummyRoot = path.join(evalDir, 'fixtures', 'dummy-platform');
const stockRoot = path.join(evalDir, 'fixtures', 'stock-platform');

describe('query 响应载荷进审计行（result.items / count）', () => {
  it('跑一次 query 后审计行读回该次返回的 items 与 count；被拒/失败/无数据行不带 result', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-result-'));
    try {
      const dummyAudit = path.join(dir, 'dummy-audit.jsonl');
      const dummyEnv = {
        ...process.env,
        DUMMY_STATE: path.join(dir, 'dummy-state.json'),
        DUMMY_PLAN_STATE: path.join(dir, 'dummy-plans.json'),
        DUMMY_PROPOSAL_STATE: path.join(dir, 'dummy-proposals.json'),
        EXECUTION_AUDIT_PATH: dummyAudit,
      };
      const dummyBin = path.join(dummyRoot, 'bin', 'dummy');
      // bash 路径：completed
      const bashOk = spawnSync(dummyBin, ['query', 'dummy.query', '--collection', 'alpha'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      expect(bashOk.status).toBe(0);
      // bash 路径：无数据（not_found，exitCode 仍是 0，但没有 items 可给）
      spawnSync(dummyBin, ['query', 'dummy.query', '--collection', 'nope'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      // bash 路径：门拒（query 模式不开 commit）
      spawnSync(dummyBin, ['query', 'dummy.commit', '--collection', 'alpha'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      // structured 路径：completed（arg 键带 --，与 generic-mock.ts 的 structured 用例同形）
      const callFile = path.join(dir, 'call.json');
      writeFileSync(callFile, JSON.stringify({ operation: 'dummy.query', args: { '--collection': 'beta' } }));
      const structured = spawnSync(dummyBin, ['call', '--file', callFile], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      expect(structured.status).toBe(0);

      const dummyRows = readExecutionAuditLog(dummyAudit)!;
      const bashRow = dummyRows.find((r) => r.script === 'dummy.query' && r.via === undefined);
      expect(bashRow?.mode).toBe('query');
      expect(bashRow?.result?.count).toBe(2);
      expect(bashRow?.result?.items).toEqual([
        { id: 'rec-001', name: 'alpha-item-1', value: 1200 },
        { id: 'rec-002', name: 'alpha-item-2', value: 800 },
      ]);
      const structuredRow = dummyRows.find((r) => r.via === 'structured');
      expect(structuredRow?.result?.count).toBe(3);
      expect(structuredRow?.result?.items?.map((i) => i.name)).toEqual(['beta-item-1', 'beta-item-2', 'beta-item-3']);
      expect(structuredRow?.result?.items?.map((i) => i.value)).toEqual([500, 300, 200]);
      const notFoundRow = dummyRows.find((r) => Array.isArray(r.args) && r.args.includes('nope'));
      expect(notFoundRow?.result).toBeUndefined();
      const refusedRow = dummyRows.find((r) => r.script === 'dummy.commit');
      expect(refusedRow?.refused).toBeTruthy();
      expect(refusedRow?.result).toBeUndefined();

      // stock：同一契约（域字段 sku/qty 投影成 name/value）
      const stockAudit = path.join(dir, 'stock-audit.jsonl');
      const stockEnv = {
        ...process.env,
        STOCK_STATE: path.join(dir, 'stock-state.json'),
        STOCK_PLAN_STATE: path.join(dir, 'stock-plans.json'),
        STOCK_PROPOSAL_STATE: path.join(dir, 'stock-proposals.json'),
        EXECUTION_AUDIT_PATH: stockAudit,
      };
      const stockBin = path.join(stockRoot, 'bin', 'stock');
      const stockOk = spawnSync(stockBin, ['query', 'stock.query', '--shelf', 'north', '--batch', 'B1'], { encoding: 'utf8', cwd: stockRoot, env: stockEnv });
      expect(stockOk.status).toBe(0);
      spawnSync(stockBin, ['query', 'stock.query', '--shelf', 'nope'], { encoding: 'utf8', cwd: stockRoot, env: stockEnv });

      const stockRows = readExecutionAuditLog(stockAudit)!;
      const stockRow = stockRows.find((r) => Array.isArray(r.args) && r.args.includes('north'));
      expect(stockRow?.mode).toBe('query');
      expect(stockRow?.result?.count).toBe(2);
      expect(stockRow?.result?.items).toEqual([
        { id: 'rec-001', name: 'north-item-1', value: 1200 },
        { id: 'rec-002', name: 'north-item-2', value: 800 },
      ]);
      const stockNotFound = stockRows.find((r) => Array.isArray(r.args) && r.args.includes('nope'));
      expect(stockNotFound?.result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
