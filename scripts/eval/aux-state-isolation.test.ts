/**
 * 辅助组 ambient 击穿回归锁（issue #20，Codex major 修复，2026-11-10）。
 *
 * 事实链（以夹具读取点为准）：`stock.cjs` 的 `auxPaths()` 用
 * `env2('EXECUTION_MEMORY_STATE', 'STOCK_MEMORY_STATE', <状态根派生>)` 优先读 **ambient**
 * （breaker / cache 同款）。harness 若全量继承 shell env，`--state-dir` 只保住缺省路径：
 * ambient 里一个打开中的熔断账本会让 `stock.query` 得 BREAKER_OPEN，memory / cache 会
 * 跨用例共享或写到状态根外。本组断言：
 *   ① 删除集 == 夹具 `auxPaths()` 的实际 env2 配对（规范族 + `STOCK_*` 调试专名；
 *      dummy 不实现辅助组，零读取，故无 `DUMMY_*` 对应名）；
 *   ② 预置 ambient 打开态熔断 + 外部 memory/cache 后，用 `withoutFixtureAuxState`
 *      构造的 env 跑 TRUE fixture：query 不被 BREAKER_OPEN 拒，三个辅助文件实际读写
 *      只落 `--state-dir` 根，ambient 外部文件逐字节不变；
 *   ③ 三处直接运行的 harness 源码都接上了删除逻辑（generic-mock.ts / second-layer.ts /
 *      generic-model-eval.py；.py 无测试框架，机器对账由本 TS 文件承载）。
 * 变异口径（原始输出见 commit 正文）：抽掉 `withoutFixtureAuxState` 的删除循环 → ② 红；
 * 抽掉任一 harness 的接线 → ③ 红。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_AUX_STATE_ENV_KEYS, withoutFixtureAuxState } from './fixture-aux-state';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evalDir, 'fixtures', 'stock-platform');
const stockBin = path.join(fixtureRoot, 'bin', 'stock');
const stockPath = path.join(fixtureRoot, 'bin', 'stock.cjs');
const dummyPath = path.join(evalDir, 'fixtures', 'dummy-platform', 'bin', 'dummy.cjs');

/** 夹具 auxPaths() 的实际读取点：三个辅助组 × （规范名 + STOCK_* 调试专名）。 */
const AUX_KEYS = [
  'EXECUTION_MEMORY_STATE', 'EXECUTION_BREAKER_STATE', 'EXECUTION_CACHE_STATE',
  'STOCK_MEMORY_STATE', 'STOCK_BREAKER_STATE', 'STOCK_CACHE_STATE',
] as const;

function envelope(stdout: string) {
  const m = stdout.match(/^RESULT (\{.*\})\s*$/m);
  if (!m) return null;
  return JSON.parse(m[1]!) as {
    v: number; op: string; status: string;
    data: Record<string, unknown> | null;
    error: { code: string; message: string } | null;
  };
}

function savedOf(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreSaved(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('辅助组 ambient 击穿回归锁', () => {
  it('删除集 == 夹具 auxPaths() 的 env2 读取点；dummy 辅助组零读取', () => {
    const stockSource = readFileSync(stockPath, 'utf8');
    const start = stockSource.indexOf('function auxPaths()');
    const end = stockSource.indexOf('function loadAux', start);
    expect(start, 'stock.cjs 缺少 auxPaths()').toBeGreaterThan(-1);
    expect(end, 'stock.cjs 缺少 loadAux（auxPaths 块的结束标记）').toBeGreaterThan(start);
    const block = stockSource.slice(start, end);
    const pairs = [...block.matchAll(/env2\(\s*'([A-Z0-9_]+)'\s*,\s*'([A-Z0-9_]+)'/g)]
      .flatMap((match) => [match[1]!, match[2]!])
      .sort();
    expect(pairs, 'stock.cjs auxPaths() 的读取点变了：删除集必须同批更新').toEqual([...AUX_KEYS].sort());
    // 辅助组的单源删除集必须与夹具读取点逐字一致。
    expect([...FIXTURE_AUX_STATE_ENV_KEYS].sort()).toEqual([...AUX_KEYS].sort());
    // dummy.cjs 文件头明确不实现 memory/breaker/cache；猜一个不存在的 DUMMY_* 名会掩盖真实读取点。
    const dummySource = readFileSync(dummyPath, 'utf8');
    const dummyAux = dummySource.match(/(?:EXECUTION|DUMMY)_(?:MEMORY|BREAKER|CACHE)_STATE/g) ?? [];
    expect(dummyAux, 'dummy.cjs 出现辅助组状态读取点：删除集需要补 DUMMY_* 专名').toEqual([]);
  });

  it('ambient 打开态熔断/外部 memory/cache 不可见：query 成功，aux 只读写 --state-dir 根', () => {
    const caseDir = mkdtempSync(path.join(os.tmpdir(), 'aux-case-'));
    const ambientRoot = mkdtempSync(path.join(os.tmpdir(), 'aux-ambient-'));
    const ambientBreaker = path.join(ambientRoot, 'breaker.json');
    const ambientMemory = path.join(ambientRoot, 'memory.json');
    const ambientCache = path.join(ambientRoot, 'cache.json');
    const breakerBody = JSON.stringify({ state: 'open', failures: 9 }, null, 2) + '\n';
    const memoryBody = JSON.stringify({ entries: { leak: 'ambient-only' } }, null, 2) + '\n';
    const cacheBody = JSON.stringify({ entries: { leak: 'ambient-only' } }, null, 2) + '\n';
    writeFileSync(ambientBreaker, breakerBody);
    writeFileSync(ambientMemory, memoryBody);
    writeFileSync(ambientCache, cacheBody);

    const saved = savedOf(AUX_KEYS);
    try {
      // 规范名（flex breaker）与调试专名（memory/cache）各预置一侧，两个读取顺位都覆盖。
      Object.assign(process.env, {
        EXECUTION_BREAKER_STATE: ambientBreaker,
        STOCK_MEMORY_STATE: ambientMemory,
        STOCK_CACHE_STATE: ambientCache,
      });
      const env = withoutFixtureAuxState(process.env);
      for (const key of AUX_KEYS) expect(env[key], `${key} 仍泄漏进子进程 env`).toBeUndefined();

      const run = (args: string[]) => spawnSync(stockBin, ['--state-dir', caseDir, ...args], {
        encoding: 'utf8', cwd: fixtureRoot, env,
      });
      const runEnvelope = (args: string[]) => envelope(run(args).stdout);

      // ① 打开态 ambient 熔断不可见：query 必须 completed，而不是 failed/BREAKER_OPEN。
      const query = runEnvelope(['query', 'stock.query', '--shelf', 'north', '--batch', 'B1']);
      expect(query?.status, `ambient 熔断账本泄漏：${JSON.stringify(query?.error)}`).toBe('completed');
      expect(query?.data?.['count']).toBe(2);

      // ② breaker 读的是 per-case 缺省（closed），写也落 case 根。
      expect(runEnvelope(['breaker', 'status'])?.data?.['state']).toBe('closed');
      expect(runEnvelope(['breaker', 'trip'])?.data?.['state']).toBe('open');
      expect(runEnvelope(['breaker', 'reset'])?.data?.['state']).toBe('closed');
      expect(JSON.parse(readFileSync(path.join(caseDir, 'breaker.json'), 'utf8'))).toMatchObject({ state: 'closed' });

      // ③ memory 读不到 ambient 条目，写落 case 根。
      expect(runEnvelope(['memory', 'get', '--key', 'leak'])?.status).toBe('not_found');
      expect(runEnvelope(['memory', 'set', '--key', 'case-only', '--value', 'ok'])?.status).toBe('completed');
      const memory = JSON.parse(readFileSync(path.join(caseDir, 'memory.json'), 'utf8')) as { entries: Record<string, string> };
      expect(memory.entries['case-only']).toBe('ok');
      expect(memory.entries['leak'], 'memory 读到了 ambient 外部文件').toBeUndefined();
      expect(existsSync(path.join(caseDir, 'memory.json')), 'memory 未落 per-case 状态根').toBe(true);

      // ④ cache 同上。
      expect(runEnvelope(['cache', 'get', '--key', 'leak'])?.data).toMatchObject({ hit: false });
      expect(runEnvelope(['cache', 'put', '--key', 'k', '--value', 'v'])?.status).toBe('completed');
      const cache = JSON.parse(readFileSync(path.join(caseDir, 'cache.json'), 'utf8')) as { entries: Record<string, string> };
      expect(cache.entries['k']).toBe('v');
      expect(cache.entries['leak'], 'cache 读到了 ambient 外部文件').toBeUndefined();
      expect(existsSync(path.join(caseDir, 'cache.json')), 'cache 未落 per-case 状态根').toBe(true);

      // ⑤ ambient 外部文件逐字节不变：没有任何一次写入落到状态根外。
      expect(readFileSync(ambientBreaker, 'utf8'), 'ambient 熔断账本被夹具改写').toBe(breakerBody);
      expect(readFileSync(ambientMemory, 'utf8'), 'ambient memory 被夹具改写').toBe(memoryBody);
      expect(readFileSync(ambientCache, 'utf8'), 'ambient cache 被夹具改写').toBe(cacheBody);
    } finally {
      restoreSaved(saved);
      rmSync(caseDir, { recursive: true, force: true });
      rmSync(ambientRoot, { recursive: true, force: true });
    }
  });

  it('直接运行的 harness 都接上删除逻辑（generic-mock / second-layer / generic-model-eval.py）', () => {
    const genericMock = readFileSync(path.join(evalDir, 'generic-mock.ts'), 'utf8');
    const secondLayer = readFileSync(path.join(evalDir, 'second-layer.ts'), 'utf8');
    const python = readFileSync(path.join(evalDir, 'generic-model-eval.py'), 'utf8');

    expect(genericMock, 'generic-mock.ts 未用 withoutFixtureAuxState 构造子进程 env')
      .toMatch(/withoutFixtureAuxState\(process\.env\)/);
    expect(secondLayer, 'second-layer.ts 未用 withoutFixtureAuxState 构造子进程 env')
      .toMatch(/withoutFixtureAuxState\(process\.env\)/);

    const tuple = /AUX_STATE_ENV_KEYS = \(([\s\S]*?)\)/.exec(python)?.[1] ?? '';
    const pythonKeys = [...tuple.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!).sort();
    expect(pythonKeys, 'generic-model-eval.py 的辅助组删除集与夹具读取点不一致').toEqual([...AUX_KEYS].sort());
    expect(python, 'generic-model-eval.py 未从子进程 env 删除辅助组键')
      .toMatch(/for _key in AUX_STATE_ENV_KEYS:\s*\n\s*env\.pop\(_key, None\)/);
  });
});
