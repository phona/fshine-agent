/**
 * D-209 继任守卫（2026-11-13，Minimal M2 波次 1）：评测状态根桥的字面量引用闭集。
 *
 * 桥键 `FSHINE_EVAL_FIXTURE_STATE_DIR` 是 fshine 评测基础设施的测试专用槽（非两仓
 * 契约；身份与退役条件见 docs/debt-ledger.md D-209，登记条目见
 * platform-leak-lint 的 FSHINE_* 命名空间表）。原闭集守卫住已随旧探针/验收脚手架
 * 退役的 scripts/probe-real-agent.test.ts；本文件只承接「闭集」这一条判据——
 * 扫描**被跟踪源码**、比对显式 allowlist，不依赖任何已删探针/harness，也不 import
 * 旧 runtime。
 *
 * 扫描面：`git ls-files` 里 packages / apps / scripts / tests 下的可执行文本
 * （ts/tsx/js/cjs/mjs/py/sh，以及夹具 `bin/` 下无扩展名入口；符号链接跳过——避免
 * `bin/generic -> dummy` 这类链接把同一份内容重复计入）。docs 不在扫描面：
 * 它们解释桥，不是运行时引用。
 *
 * 闭集语义（双向，任一破口都红）：
 *   · 表外文件出现字面量 → unregistered；
 *   · 表内文件不再出现字面量 → stale（防登记腐烂）。
 * 变异验证见文件尾部两条用例：注入生产侧引用 / 抽掉一条真实命中，都必须让断言红。
 *
 * 为什么桥还可以有字面量：键名的唯一来源是 child-env.ts 的导出常量
 * WORKER_FIXTURE_STATE_DIR_KEY；其余消费方（demo、child-env-closure 测试等）经常量
 * 引用，不写字面量。allowlist 里剩下的字面量只有：键名定义、夹具 shell 入口、
 * 命名空间登记条目、本守卫自己。
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 扫描 needle。本文件因此在自身扫描面内——见 allowlist 第一条。 */
const BRIDGE = 'FSHINE_EVAL_FIXTURE_STATE_DIR';
const SCAN_ROOTS = ['packages', 'apps', 'scripts', 'tests'];
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.sh']);

/**
 * 显式 allowlist：每一条 = 桥键字面量的一个合法出现点 + 理由。
 * 新增条目 = 在 PR 里说清为什么这个点不能改经导出常量；删对象时同步删条目。
 */
const ALLOWLIST: ReadonlyArray<{ rel: string; reason: string }> = [
  {
    rel: 'packages/agent/bridge-key-closure.test.ts',
    reason: '本守卫自身：扫描需要 needle 字面量；文件只读文本，不把它用进任何运行路径。',
  },
  {
    rel: 'packages/agent/src/child-env.ts',
    reason: '唯一生产引用：导出常量 WORKER_FIXTURE_STATE_DIR_KEY 的键名定义（worker env 白名单经该常量放行，只放行键名、不读值）。',
  },
  {
    rel: 'packages/agent/platform-leak-lint.test.ts',
    reason: 'D-017 FSHINE_* 命名空间登记表条目：解释桥的身份、消费方与退役条件（警职执法标签）。',
  },
  {
    rel: 'scripts/eval/fixtures/dummy-platform/bin/dummy',
    reason: '仓内 dummy 夹具 shell 入口：把桥值翻成测试专用 --state-dir，per-case 状态根由它落地。',
  },
  {
    rel: 'scripts/eval/fixtures/stock-platform/bin/stock',
    reason: '仓内 stock 夹具 shell 入口：同上（第二执行层链）。',
  },
];

/**
 * 被跟踪源码里的桥字面量命中（排序，去重）。`extra` 供变异用例注入合成文本——
 * 与真实扫描走同一闭集判定，证明守卫对「多一处引用」有区分力。
 */
function trackedBridgeHits(extra: ReadonlyArray<{ rel: string; text: string }> = []): string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hits = new Set<string>();
  for (const rel of listed) {
    if (!SCAN_ROOTS.includes(rel.split('/')[0]!)) continue;
    const ext = path.extname(rel);
    const fixtureBin = rel.includes('/bin/') && ext === '';
    if (!CODE_EXT.has(ext) && !fixtureBin) continue;
    const abs = path.join(REPO_ROOT, rel);
    if (lstatSync(abs).isSymbolicLink()) continue;
    if (readFileSync(abs, 'utf8').includes(BRIDGE)) hits.add(rel);
  }
  for (const { rel, text } of extra) {
    if (text.includes(BRIDGE)) hits.add(rel);
  }
  return [...hits].sort();
}

/** 闭集判定：命中集合与登记集合双向比对。 */
function closureViolations(hits: readonly string[]): { unregistered: string[]; stale: string[] } {
  const registered = new Set(ALLOWLIST.map((entry) => entry.rel));
  const hitSet = new Set(hits);
  return {
    unregistered: hits.filter((rel) => !registered.has(rel)),
    stale: ALLOWLIST.map((entry) => entry.rel).filter((rel) => !hitSet.has(rel)),
  };
}

describe('D-209 继任守卫：状态根桥字面量引用闭集', () => {
  it('闭集：被跟踪源码里字面量只出现在登记站点，且每条例由在案', () => {
    const violations = closureViolations(trackedBridgeHits());
    expect(violations.unregistered, [
      '名单外出现 FSHINE_EVAL_FIXTURE_STATE_DIR 字面量（桥只许在登记站点出现）：',
      '新增合法站点 → 在 ALLOWLIST 登记并写明理由；不该出现的引用 → 改用 WORKER_FIXTURE_STATE_DIR_KEY 常量。',
    ].join('\n')).toEqual([]);
    expect(violations.stale, [
      '登记条目已无命中（桥不再在那里出现）→ 删除该登记；',
      '否则闭集守卫会为不存在的东西背书。',
    ].join('\n')).toEqual([]);
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.rel} 的登记理由为空`).toBeGreaterThan(0);
    }
  });

  it('生产面收敛：字面量只剩 child-env.ts 一处键名定义', () => {
    const productionHits = trackedBridgeHits().filter(
      (rel) => rel.startsWith('packages/agent/src/') || rel.startsWith('apps/'),
    );
    expect(productionHits).toEqual(['packages/agent/src/child-env.ts']);
  });

  it('形状：键名由导出常量定义，两个夹具壳入口把桥翻成 --state-dir', () => {
    expect(BRIDGE.startsWith('FSHINE_EVAL_')).toBe(true);
    const childEnv = readFileSync(path.join(REPO_ROOT, 'packages/agent/src/child-env.ts'), 'utf8');
    expect(childEnv).toContain(`export const WORKER_FIXTURE_STATE_DIR_KEY = '${BRIDGE}';`);
    for (const [rel, impl] of [
      ['scripts/eval/fixtures/dummy-platform/bin/dummy', 'dummy.cjs'],
      ['scripts/eval/fixtures/stock-platform/bin/stock', 'stock.cjs'],
    ] as const) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src).toContain('if [ -n "${' + BRIDGE + ':-}" ]; then');
      expect(src).toContain('exec node "$(dirname "$0")/' + impl + '" --state-dir "$' + BRIDGE + '" "$@"');
    }
  });

  it('变异①：名单外出现生产侧引用即红（注入文本走同一闭集判定）', () => {
    const injected = { rel: 'packages/agent/src/runtime.ts', text: `const leak = process.env.${BRIDGE};` };
    const violations = closureViolations(trackedBridgeHits([injected]));
    expect(violations.unregistered).toEqual(['packages/agent/src/runtime.ts']);
    expect(violations.stale).toEqual([]);
  });

  it('变异②：登记条目失去命中（陈旧登记）同样红', () => {
    const hits = trackedBridgeHits().filter((rel) => rel !== 'scripts/eval/fixtures/dummy-platform/bin/dummy');
    expect(closureViolations(hits).stale).toEqual(['scripts/eval/fixtures/dummy-platform/bin/dummy']);
  });
});
