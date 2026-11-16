/**
 * S3/S4/S5 · 数据集 eval-only 守卫（静态检查，常驻绊线）。
 *
 * 约束：`scripts/eval/finance/**` 只服务评测与 Oracle；**产品装配不得 import** 它。
 * 人工审查挡不住回潮（复制一行 import 就能把评测夹具带进产品路径），故定为测试：
 * 扫描 `packages/**`、`apps/**`、`scripts/**`（跳过 `scripts/eval/**`、`*.test.ts`、
 * node_modules 与 fixtures），命中 `eval/finance` 引用即红。
 *
 * 判据是字符串事实，不做 AST（引用形态 `from '…'` / `import('…')` / `require('…')`
 * 都含同一路径片段），扫描范围小且稳定。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 本文件位于 `scripts/eval/finance/`，上溯三级即仓库根。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN_ROOTS = ['packages', 'apps', 'scripts'] as const;
const SKIP_DIRS = new Set(['node_modules', '.runtime', '.git', 'dist', 'out', 'tmp', 'coverage', 'fixtures']);
/** eval 目录是数据集的合法消费者与拥有者，不在扫描范围。 */
const SKIP_PATHS = ['scripts/eval'] as const;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

describe('数据集 eval-only', () => {
  it('产品装配（packages/apps/scripts 非 eval）不 import scripts/eval/finance', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        const relative = path.relative(REPO_ROOT, file);
        if (SKIP_PATHS.some((skip) => relative.startsWith(skip))) continue;
        if (readFileSync(file, 'utf8').includes('eval/finance')) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});
