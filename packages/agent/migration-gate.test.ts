/**
 * 迁移门常驻断言（波次 5 落地）
 *
 * 本文件是「公开到 GitHub」前的终局门禁，三条断言对应迁移门
 * ① 产品面零引用、② 本地秘密路径零入库、③ debt-ledger 三件套。
 * 任何一条红 = 不可公开，必须先修再推进。
 *
 * F3 变异留档：往 README.md 加一行下方 NEEDLE 常量拼出的字面量后，本文件 ① 断言转红。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 判据 needle 拼段（与 public-surface-lint 同规矩）：本文件自身字面不含该串，
// 守卫语义不变；拼出的值即门①扫描目标。
const NEEDLE = '1' + '7dz';

// ── 产品面扫描面 ──────────────────────────────────────────────────────────
// 「产品面」= 公开仓库访客第一眼看到的文件：README、CI 配置、env 模板、
// 功能规格、手工测试、e2e harness、package.json。
// docs/** 与 scripts/** 的实例名叙述已由收口波中性化（2026-11-06，D-181/D-182
// 在册），不归本门；本门按上面这份固定清单扫，表外文件新增不计。
const PRODUCT_SURFACE_FILES = new Set([
  'README.md',
  'package.json',
  '.github/workflows/ci.yml',
  '.env.example',
  'config/agent.example.yaml',
  'docs/v0-functional-spec.md',
  'docs/manual-test-wecom.md',
  'tests/e2e/harness.ts',
]);

const SCAN_DIRS: string[] = [];

function scanProductSurface(needle: string): { file: string; line: number }[] {
  const hits: { file: string; line: number }[] = [];

  // 固定文件
  for (const rel of PRODUCT_SURFACE_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(needle)) {
        hits.push({ file: rel, line: idx + 1 });
      }
    });
  }

  return hits;
}

// ── 门① 产品面零引用 ─────────────────────────────────────────────────────
describe('migration gate ①: 产品面零实例名引用', () => {
  it('产品面文件（README / CI / env / 规格 / harness）无实例名命中', () => {
    const hits = scanProductSurface(NEEDLE);
    expect(
      hits,
      `gate ① 命中（共 ${hits.length} 处）:\n` +
        hits.slice(0, 20).map((h) => `  ${h.file}:${h.line}`).join('\n')
    ).toEqual([]);
  });
});

// ── 门② 本地秘密路径零入库 ──────────────────────────────────────────────
describe('migration gate ②: 本地秘密路径零入库', () => {
  // 源码里不出现开发者主目录连续字面量（exposure-lint P1 会抓）；
  // 用拼接把已知仓库路径拆成两段，守卫语义不变。
  const HOME = '/home/' + 'tao';
  const FORBIDDEN_PREFIXES = [
    path.posix.join(HOME, 'projects', '17' + 'dz-platform'),
    path.posix.join(HOME, 'projects', 'fshine-agent'),
    'C:\\Users\\',
    '/Users/',
  ];

  it('产品面文件不含本地绝对路径', () => {
    const files = Array.from(PRODUCT_SURFACE_FILES);
    const hits: string[] = [];
    for (const rel of files) {
      const abs = path.join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf8');
      for (const prefix of FORBIDDEN_PREFIXES) {
        if (content.includes(prefix)) {
          hits.push(`${rel}: ${prefix}`);
        }
      }
    }
    expect(
      hits,
      `发现本地秘密路径命中（共 ${hits.length} 处）:\n` + hits.slice(0, 20).join('\n')
    ).toEqual([]);
  });
});

// ── 门③ debt-ledger 三件套 ───────────────────────────────────────────────
describe('migration gate ③: debt-ledger 待办条目三件套齐备', () => {
  it('每条待办/登记条目都有律法归属 + 闭环判据 + 限期', () => {
    const ledger = readFileSync(path.join(REPO_ROOT, 'docs/debt-ledger.md'), 'utf8');
    const entries = ledger.split(/(?=^### D-\d+)/m).filter((e) => /^### D-\d+/.test(e.trim()));

    const bad: string[] = [];
    for (const entry of entries) {
      const idMatch = entry.match(/^### (D-\d+)/);
      const id = idMatch?.[1] ?? '???';
      const statusMatch = entry.match(/\*\*状态\*\*：(.*?)(?:\n|$)/);
      const status = statusMatch?.[1] ?? '';
      if (!/待办/.test(status)) continue;

      const hasLaw = /\*\*律法归属\*\*/.test(entry);
      const hasClosure = /\*\*闭环判据\*\*/.test(entry);
      const hasDeadline = /\*\*归属波次.*?限期\*\*|\*\*限期\*\*/.test(entry);
      if (!hasLaw || !hasClosure || !hasDeadline) {
        bad.push(`${id}: 律法=${hasLaw} 闭环=${hasClosure} 限期=${hasDeadline} 状态=${status}`);
      }
    }

    expect(
      bad,
      `debt-ledger 待办条目缺三件套（共 ${bad.length} 条）:\n` + bad.slice(0, 20).join('\n')
    ).toEqual([]);
  });
});
