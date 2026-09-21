/**
 * 泄漏预算 lint：平台实现细节不得出现在白名单之外的 fshine 源码中。
 * 白名单 = platform-contract.ts（唯一契约适配层）。
 * 平台侧契约演进（E1 操作名 / E2 信封 / E3 权重）落地后，白名单应持续收窄。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['packages', 'apps', 'scripts'];
// 白名单：platform-contract.ts 是唯一契约适配层（*.test.ts 豁免——夹具演示被拦形态）
const ALLOWLIST = new Set([
  path.join(REPO_ROOT, 'packages/agent/src/platform-contract.ts'),
]);

/** 平台实现细节指纹：出现即泄漏（公共契约——操作名/模式名/env 名——不在列） */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: '脚本文件名 fill.js', pattern: /fill\.js/ },
  { label: '脚本文件名 verify-saved.js', pattern: /verify-saved\.js/ },
  { label: '脚本文件名 query-saved.js / query-history.js / subject-list.js', pattern: /(query-saved|query-history|subject-list)\.js/ },
  { label: '平台脚本目录路径', pattern: /src\/(voucher|finance|payroll)\/scripts/ },
  { label: '平台内部清单文件', pattern: /operations\.json/ },
  { label: '已废弃入口 serve.sh', pattern: /serve\.sh/ },
  { label: '旧消费者命名（E4 后应全量 DZ_*）', pattern: /FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full;
  }
}

describe('平台泄漏预算 lint', () => {
  it('fshine 源码中平台实现细节仅允许存在于契约适配层', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        if (ALLOWLIST.has(file)) continue;
        const content = readFileSync(file, 'utf8');
        for (const { label, pattern } of FORBIDDEN) {
          if (pattern.test(content)) violations.push(`${path.relative(REPO_ROOT, file)}: ${label}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
