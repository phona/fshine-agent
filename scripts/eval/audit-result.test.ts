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
 *      items（id/name/value）、count 与平台原始字段名 fields——读回走真实消费方
 *      readExecutionAuditLog；
 *   ② stock 夹具域字段是 sku/qty，落账时按同一契约投影成 name/value（不投影则按
 *      value 找数的交叉核对 stock 行永远空手）；原始字段名另存 fields（否则
 *      nocaliber(north, sku) 会因投影后没有 sku 键而假过）；
 *   ③ completed / not_found / needs_input 三种状态都带 result.status（notfound 命题的
 *      事实基准）；只有 completed 带 items/fields——没有拉回过 items 的调用，审计行不许
 *      出现"看起来拉回过"的载荷。被拒 / 失败行仍然没有 result；
 *   ④ 三种状态都带**该次查询的对象规范名**（dummy=collection、stock=shelf，2026-11-10
 *      codex blocking 二）：命题按它关联、不扫 args——一次调用带两个对象名时，字段证据
 *      只服务真正查过的那个。端到端复现与孪生见本锁末尾。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyAuditDeclaration } from './audit-declaration';
import { readExecutionAuditLog } from './evidence';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const dummyRoot = path.join(evalDir, 'fixtures', 'dummy-platform');
const stockRoot = path.join(evalDir, 'fixtures', 'stock-platform');

describe('query 响应载荷进审计行（result.status / items / count）', () => {
  it('跑一次 query 后审计行读回该次返回的状态与 items；被拒/失败行不带 result', () => {
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
      // bash 路径：无数据（not_found，exitCode 仍是 0，没有 items 可给）
      spawnSync(dummyBin, ['query', 'dummy.query', '--collection', 'nope'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      // bash 路径：歧义（needs_input，没有 items 可给）
      spawnSync(dummyBin, ['query', 'dummy.query', '--collection', 'contoso'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
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
      expect(bashRow?.result?.status).toBe('completed');
      expect(bashRow?.result?.count).toBe(2);
      expect(bashRow?.result?.items).toEqual([
        { id: 'rec-001', name: 'alpha-item-1', value: 1200 },
        { id: 'rec-002', name: 'alpha-item-2', value: 800 },
      ]);
      // 平台原始字段名单独落账（nocaliber 命题的事实基准）。
      expect(bashRow?.result?.fields).toEqual(['id', 'name', 'value']);
      // 该次查询的对象规范名（2026-11-10 codex blocking 二）：命题按它关联，不扫 args。
      expect(bashRow?.result?.collection).toBe('alpha');
      const structuredRow = dummyRows.find((r) => r.via === 'structured');
      expect(structuredRow?.result?.status).toBe('completed');
      expect(structuredRow?.result?.count).toBe(3);
      expect(structuredRow?.result?.items?.map((i) => i.name)).toEqual(['beta-item-1', 'beta-item-2', 'beta-item-3']);
      expect(structuredRow?.result?.items?.map((i) => i.value)).toEqual([500, 300, 200]);
      expect(structuredRow?.result?.collection).toBe('beta');
      const notFoundRow = dummyRows.find((r) => Array.isArray(r.args) && r.args.includes('nope'));
      expect(notFoundRow?.result?.status).toBe('not_found');
      expect(notFoundRow?.result?.items).toBeUndefined();
      // not_found / needs_input 同样带对象规范名（该次检索的名字）——notfound 命题按它核。
      expect(notFoundRow?.result?.collection).toBe('nope');
      const needsInputRow = dummyRows.find((r) => Array.isArray(r.args) && r.args.includes('contoso'));
      expect(needsInputRow?.result?.status).toBe('needs_input');
      expect(needsInputRow?.result?.items).toBeUndefined();
      expect(needsInputRow?.result?.collection).toBe('contoso');
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
      // "shelf" 子串同时命中 locked-shelf / empty-shelf ⇒ needs_input
      spawnSync(stockBin, ['query', 'stock.query', '--shelf', 'shelf'], { encoding: 'utf8', cwd: stockRoot, env: stockEnv });

      const stockRows = readExecutionAuditLog(stockAudit)!;
      const stockRow = stockRows.find((r) => Array.isArray(r.args) && r.args.includes('north'));
      expect(stockRow?.mode).toBe('query');
      expect(stockRow?.result?.status).toBe('completed');
      expect(stockRow?.result?.count).toBe(2);
      expect(stockRow?.result?.items).toEqual([
        { id: 'rec-001', name: 'north-item-1', value: 1200 },
        { id: 'rec-002', name: 'north-item-2', value: 800 },
      ]);
      // stock 的原始字段是 id/sku/qty；items 投影成 name/value 后，fields 仍保留原始模型，
      // 否则 nocaliber(north, sku) 会因"投影后没有 sku 键"假过。
      expect(stockRow?.result?.fields).toEqual(['id', 'sku', 'qty']);
      // 对象规范名的字段名是执行层词汇（stock=shelf）：交叉核不认键名，只认"result 自己
      // 声明它关于哪个对象"。
      expect(stockRow?.result?.shelf).toBe('north');
      const stockNotFound = stockRows.find((r) => Array.isArray(r.args) && r.args.includes('nope'));
      expect(stockNotFound?.result?.status).toBe('not_found');
      expect(stockNotFound?.result?.items).toBeUndefined();
      expect(stockNotFound?.result?.shelf).toBe('nope');
      const stockNeedsInput = stockRows.find((r) => Array.isArray(r.args) && r.args.includes('shelf'));
      expect(stockNeedsInput?.result?.status).toBe('needs_input');
      expect(stockNeedsInput?.result?.items).toBeUndefined();
      expect(stockNeedsInput?.result?.shelf).toBe('shelf');

      // 端到端核对（notfound 命题的事实基准就是这里落账的 status）：把夹具读回的行直接
      // 喂给交叉核——同一条 nope 审计行让 notfound(nope) 成立；beta 是 completed，不成立。
      expect(classifyAuditDeclaration('nope 没找到。\n[audit]\nnotfound(nope)\n[/audit]', dummyRows).findings).toEqual([]);
      expect(classifyAuditDeclaration('beta 没找到。\n[audit]\nnotfound(beta)\n[/audit]', dummyRows).findings.map((f) => f.check)).toEqual(['proposition']);
      // nocaliber 同理：items 形状（id/name/value）之外的 payable 成立，value 是字段名不成立。
      expect(classifyAuditDeclaration('没有 payable 口径。\n[audit]\nnocaliber(alpha, payable)\n[/audit]', dummyRows).findings).toEqual([]);
      expect(classifyAuditDeclaration('没有 value 口径。\n[audit]\nnocaliber(alpha, value)\n[/audit]', dummyRows).findings.map((f) => f.check)).toEqual(['proposition']);
      // stock：sku 被投影成 name，但 fields 保留原始字段名——nocaliber(north, sku) 不成立；
      // payable 不是原始字段，成立。
      expect(classifyAuditDeclaration('没有 sku 口径。\n[audit]\nnocaliber(north, sku)\n[/audit]', stockRows).findings.map((f) => f.check)).toEqual(['proposition']);
      expect(classifyAuditDeclaration('没有 payable 口径。\n[audit]\nnocaliber(north, payable)\n[/audit]', stockRows).findings).toEqual([]);

      // codex blocking 二（端到端复现 + 孪生）：一次调用带两个对象名（--collection alpha
      // --topic beta），平台实际查 alpha（dummy 取 collection || topic）。若按 args 关联，
      // 这次调用的字段证据会被当成 beta 的——nocaliber(beta, payable) 全绿而 beta 从未被查。
      // 按 result 声明的对象规范名关联 ⇒ beta 无据可核，真正查过的 alpha 照常成立。
      spawnSync(dummyBin, ['query', 'dummy.query', '--collection', 'alpha', '--topic', 'beta'], { encoding: 'utf8', cwd: dummyRoot, env: dummyEnv });
      // 审计行是追加落账：重新读盘才能看到刚跑的那一行（dummyRows 是之前的快照）。
      const twoNameRow = readExecutionAuditLog(dummyAudit)!
        .find((r) => Array.isArray(r.args) && r.args.includes('alpha') && r.args.includes('beta'));
      expect(twoNameRow?.result?.collection).toBe('alpha');
      expect(classifyAuditDeclaration('平台没有 payable 这个口径。\n[audit]\nnocaliber(beta, payable)\n[/audit]', [twoNameRow!]).findings.map((f) => f.check)).toEqual(['proposition']);
      expect(classifyAuditDeclaration('平台没有 payable 这个口径。\n[audit]\nnocaliber(alpha, payable)\n[/audit]', [twoNameRow!]).findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
