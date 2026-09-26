/**
 * 泄漏预算 lint：平台实现细节不得出现在白名单之外的 fshine 源码中。
 * 白名单 = platform-contract.ts（唯一契约适配层）。
 * 平台侧契约演进（E1 操作名 / E2 信封 / E3 权重）落地后，白名单应持续收窄。
 *
 * 第二条预算：业务词不得进入编排层。进度帧里的业务措辞只能由平台清单第 5 列
 * 提供（见 operation-labels.ts），fshine 侧新增一个业务词就是一次泄漏——
 * 因此把当前命中集整体冻结，只减不增。
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

  it('编排层业务词预算：命中集冻结，只减不增', () => {
    const hits = businessWordHits(path.join(REPO_ROOT, 'packages/agent/src'));
    expect(hits, `新增了业务词（进度帧措辞只能来自平台清单第 5 列）：\n${hits.filter((hit) => !BUSINESS_WORD_BASELINE.includes(hit)).join('\n')}`)
      .toEqual(BUSINESS_WORD_BASELINE);
  });
});

/** 编排层业务词（中文领域词）：出现即说明 fshine 在替平台说话。 */
const BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录/g;

/** 当前命中集（file: 词）——冻结基线，新增任意一行即失败。 */
const BUSINESS_WORD_BASELINE: readonly string[] = [
  'packages/agent/src/context-extractor.ts: 期间',
  'packages/agent/src/context.ts: 期间',
  'packages/agent/src/context.ts: 目录',
  'packages/agent/src/context.ts: 目录',
  'packages/agent/src/context.ts: 目录',
  'packages/agent/src/context.ts: 目录',
  'packages/agent/src/context.ts: 目录',
  'packages/agent/src/context.ts: 账套',
  'packages/agent/src/context.ts: 账套,期间',
  'packages/agent/src/memory-candidate-extractor.ts: 应收',
  'packages/agent/src/memory-candidate-extractor.ts: 科目',
  'packages/agent/src/memory-candidate-extractor.ts: 账套',
  'packages/agent/src/pi-coding-driver.ts: 目录',
  'packages/agent/src/pi-coding-driver.ts: 目录',
  'packages/agent/src/pi-coding-driver.ts: 目录',
  'packages/agent/src/platform-mock.ts: 目录',
  'packages/agent/src/serve-gate.ts: 目录',
  'packages/agent/src/serve-gate.ts: 目录',
  'packages/agent/src/serve-gate.ts: 目录',
  'packages/agent/src/serve-gate.ts: 目录',
  'packages/agent/src/step-text.ts: 目录',
  'packages/agent/src/turn-contract.ts: 目录',
  'packages/agent/src/turn-contract.ts: 目录',
];

/** 逐行收集业务词命中（位置无关：只按文件与词记账，行号漂移不影响预算）。 */
function businessWordHits(dir: string): string[] {
  const hits: string[] = [];
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const words = [...line.matchAll(BUSINESS_WORD_RE)].map((match) => match[0]);
      if (words.length > 0) hits.push(`${path.relative(REPO_ROOT, file)}: ${[...new Set(words)].join(',')}`);
    }
  }
  return hits.sort();
}
